// Per-circle phone-key table (Signet identity plan, Task 7). Each member's
// phone signs circle traffic with a local "phone key"; a receiver maps a
// phone key to a member ONLY through an identity-signed device statement
// (device-statements.ts), and honours identity-signed revocations.
//
// Trust rules enforced here:
// - A phone key belongs to exactly one identity. Once any circle's table
//   binds it to identity A, a statement from identity B for the same key is
//   rejected, in every circle.
// - A revoked phone key is dead everywhere: `memberForPhone` returns null
//   for it even when a table entry remains, `phonesOf` omits it, and any
//   later statement for it (including a buffered one) is rejected.
// - A revocation is accepted if it's signed by the identity that owns the
//   key in any circle's table. Final fix A4 (supersedes "an unknown key may
//   be revoked by anyone" — in a safety app blocking a phone IS the harm):
//   a revocation of a key not yet bound anywhere is PARKED in
//   `pendingRevocations`, not stored as revoked. When a statement for that
//   key would bind, it is rejected and the revocation promoted only if a
//   parked revocation's signer is the statement's own identity (the
//   overtake case: the owner revoked it before its statement reached us);
//   otherwise the statement binds and the parked ones are dropped. Only
//   buffered statements of the revocation's own signer are purged.
//   Plan 2 (Task 9): also accepted when signed by a linked guardian of the
//   key's owner (guardian-links.ts `linked`) — a linked guardian may revoke
//   their dependant's phone key, same as the dependant's own identity could.
//   This is the global guardian-link relationship, not a circle's role, so
//   it holds regardless of which circles the revocation names.
//   Task 9 fix round 1: a revocation of a BOUND key whose signer is neither
//   the owner nor currently a linked guardian of the owner is ALSO parked
//   in `pendingRevocations` (same table, same caps — reused, not a second
//   one), rather than dropped for good. Randomised gift-wrap timing means a
//   guardian's revocation can reach a device before the link pair backing
//   it (or while a link pair is still held in `holdLink` awaiting a vouch),
//   and dropping it outright would let a revoked phone stay live wherever
//   that happened. `promoteParkedRevocations` re-judges every such entry
//   against current link state — called (beacons.ts) when a guardian link
//   becomes true and once at app start — and promotes it exactly like an
//   immediate acceptance if `linked(signer, owner)` now holds. An unlink
//   never promotes anything (it isn't a link becoming true, so nothing
//   calls in for it); a revocation from someone who never becomes a linked
//   guardian just sits parked until its cap-slot is reclaimed.
//   Final review A, M1: only a revocation whose signer is on the roster of
//   a circle where the key is bound (any held circle, for an unbound key)
//   is parked, one slot per signer; any other is rejected, so throwaway
//   identities can't evict a guardian's parked revocation.
// - Proof of possession: a statement is only accepted from the phone it
//   names (`sealPk === statement.phonePk`), so no one can bind or relay a
//   statement for a phone key they don't hold.
// - A statement from an identity not (yet) on the circle's roster is
//   buffered in `pendingStatements` together with the id of the circle it
//   was posted on (dedup by circle id + event id, capped at 200 overall,
//   oldest dropped) and re-checked by `rescanBuffered` against THAT circle's
//   roster only — never bound into a circle it wasn't posted on.
//
// Wire (posting/receiving is Task 8's job, not this module's): a device
// posts `t: 'device'` (rumor content = statement JSON) on the circle inbox,
// phone-key sealed, when it joins a circle, after sign-in, and after every
// re-key. Revocations travel as `t: 'revoke'` (content = revocation JSON),
// posted by any member's device.

import type { Circle } from '@forgesworn/covey-kit'
import type { SignedEvent } from '@forgesworn/roost-kit'
import * as store from './store.js'
import type { Persisted } from './store.js'
import { verifyDeviceStatement, verifyRevocation, type DeviceStatement } from './device-statements.js'
import { currentSession } from './session.js'
import { linked } from './guardian-links.js'

export const PENDING_STATEMENTS_CAP = 200
/** Final fix A4: parked revocations kept per phone key, and phone keys
 *  with parked revocations overall (oldest dropped). Task 9 fix round 1:
 *  the same caps also bound a bound-key revocation parked for want of a
 *  known link — one table, one set of caps, for both parking reasons. */
export const PENDING_REVOCATIONS_PER_KEY = 4
export const PENDING_REVOCATIONS_CAP = 200

type PendingStatement = Persisted['pendingStatements'][number]

/** Whether `ev`'s `p` tag names `phonePk`. Unverified — shape only. */
function namesPhone(ev: SignedEvent, phonePk: string): boolean {
  return Array.isArray(ev?.tags) && ev.tags.some((t) => Array.isArray(t) && t[0] === 'p' && t[1] === phonePk)
}

/** The identity a phone key is bound to in any circle's table, or null.
 *  Task 12 fix round 2, finding 1a (security): THIS device's own phone key
 *  is always treated as owned by this device's own signed-in identity,
 *  even before any circle's table has actually bound it (a just-created
 *  circle, or before this device's own statement has synced anywhere).
 *  Without this, an unbound own phone read as "unknown" here, and the
 *  (since superseded, final fix A4) rule "an unknown key may be revoked by
 *  anyone" let ANY other circle member revoke it and force this device to
 *  sign itself out (beacons.ts `applyRevocation`) — see that function's
 *  own doc comment. */
function ownerOf(p: Persisted, phonePk: string): string | null {
  const self = currentSession()
  if (self && self.phonePk === phonePk) return self.identityPk
  for (const table of Object.values(p.phoneKeys)) {
    const entry = table[phonePk]
    if (entry) return entry.memberPk
  }
  return null
}

function onRoster(circle: Circle, pk: string): boolean {
  return circle.members.some((m) => m.pk === pk)
}

/** Final fix A4: settles the revocations parked for `st.phonePk` now that
 *  a statement for it would bind. If one was signed by the statement's own
 *  identity it is promoted into `revokedPhoneKeys` and this returns true
 *  (the statement must be rejected); otherwise the parked ones (signed by
 *  someone who never owned the key) are dropped. Mutates `p`.
 *
 *  Task 9 fix round 2: `addToTable` calls this ONLY while the key is still
 *  unbound (`owner === null`) — this function unconditionally clears
 *  `pendingRevocations[st.phonePk]` whether or not it finds one to
 *  promote, which is correct for an unbound key (nothing else is ever
 *  going to look at that entry again) but would silently wipe a Task 9
 *  bound-key park — a guardian's revocation waiting for its link — on the
 *  very next statement for that phone. Device statements re-post
 *  routinely (circle join, sign-in, every re-key), and a stolen phone can
 *  re-post its own statement at will, so that park must survive a
 *  statement; only `promoteParkedRevocations` (the link/app-start re-judge
 *  path) or the owner's own revocation may settle it. */
function settleParkedRevocations(p: Persisted, st: DeviceStatement): boolean {
  const parked = p.pendingRevocations[st.phonePk]
  if (!parked) return false
  const own = parked.find((ev) => {
    const signerPk = verifyRevocation(ev)?.signerPk
    return signerPk === st.identityPk || (!!signerPk && linked(signerPk, st.identityPk))
  })
  const { [st.phonePk]: _settled, ...rest } = p.pendingRevocations
  p.pendingRevocations = rest
  if (!own) return false
  p.revokedPhoneKeys[st.phonePk] ??= own
  purgeBuffered(p, st.phonePk, st.identityPk)
  return true
}

/** Task 9 fix round 1: re-judges every parked revocation of a BOUND key
 *  (an owner already known via `ownerOf`) against current guardian-link
 *  state, promoting into `revokedPhoneKeys` any whose signer is now the
 *  owner or `linked(signer, owner)` — exactly the check `acceptRevocation`
 *  applies on first arrival, just re-run later. An unbound key (owner
 *  still null) is left alone here; that one is only ever settled by
 *  `settleParkedRevocations`, when a statement for it finally arrives.
 *  Call this when a guardian link becomes true (guardian-links.ts
 *  `onLinkChange`) and once at app start, since a revocation and the link
 *  pair backing it can arrive in either order. Returns each phone key
 *  newly revoked with its accepted revocation event, so the caller
 *  (beacons.ts) can re-key affected circles / sign this device out exactly
 *  as an immediately-applied revocation would.
 *
 *  Read-only when there's nothing to promote (the overwhelmingly common
 *  case — most calls, e.g. every app start, find no parked revocation at
 *  all): scans a loaded snapshot first, and only opens a `store.update`
 *  (which unconditionally persists + notifies, like every `store.update`
 *  call) when there's actually something to write. This call site is
 *  reached synchronously from `trust-watch.ts`'s `start()`, itself called
 *  from app.ts's `render()` — an unconditional notify on every single call
 *  would re-enter `render()` on every render for no reason, and, before
 *  `render()`'s own `stopTrustWatch = trustWatch.start()` assignment has
 *  even completed, recurse back into a fresh `start()`. */
export function promoteParkedRevocations(): Array<{ phonePk: string; event: SignedEvent }> {
  const before = store.load()
  const toPromote: Array<{ phonePk: string; event: SignedEvent }> = []
  for (const phonePk of Object.keys(before.pendingRevocations)) {
    const owner = ownerOf(before, phonePk)
    if (owner === null) continue
    const list = before.pendingRevocations[phonePk] ?? []
    const accepted = list.find((ev) => {
      const signerPk = verifyRevocation(ev)?.signerPk
      return !!signerPk && (signerPk === owner || linked(signerPk, owner))
    })
    if (accepted) toPromote.push({ phonePk, event: accepted })
  }
  if (toPromote.length === 0) return []
  store.update((p) => {
    for (const { phonePk, event } of toPromote) {
      p.revokedPhoneKeys[phonePk] ??= event
      const { [phonePk]: _settled, ...rest } = p.pendingRevocations
      p.pendingRevocations = rest
    }
  })
  return toPromote
}

/** Drops buffered statements naming `phonePk` from `identityPk` only.
 *  Mutates `p`. */
function purgeBuffered(p: Persisted, phonePk: string, identityPk: string): void {
  p.pendingStatements = p.pendingStatements.filter((e) => !(namesPhone(e.event, phonePk) && e.event.pubkey === identityPk))
}

/** Final review A, M1: whether a revocation may be parked at all — its
 *  signer must be on the roster of a circle where the key is bound (any
 *  held circle, for a key not bound anywhere yet). Otherwise anyone
 *  holding a seed, the stolen phone itself included, could fill the park
 *  with throwaway identities and evict a guardian's revocation. */
function mayPark(p: Persisted, rv: { phonePk: string; signerPk: string }): boolean {
  const bound = new Set(Object.entries(p.phoneKeys).filter(([, t]) => Object.hasOwn(t, rv.phonePk)).map(([id]) => id))
  return p.circles.some((c) => (bound.size === 0 || bound.has(c.id)) && onRoster(c, rv.signerPk))
}

/** Parks `rv.event` for `rv.phonePk` in `pendingRevocations`: one slot per
 *  signer (final review A, M1: a later one from the same signer replaces
 *  theirs), per-key and overall caps (oldest key dropped first), a
 *  duplicate event id a no-op. Shared by both parking reasons (final fix
 *  A4's unbound key, Task 9 fix round 1's bound-but-not-yet-linked signer)
 *  — one table, one cap. Mutates `p`. */
function parkRevocation(p: Persisted, rv: { phonePk: string; signerPk: string; event: SignedEvent }): void {
  const held = p.pendingRevocations[rv.phonePk] ?? []
  if (held.some((e) => e.id === rv.event.id)) return
  const list = held.filter((e) => e.pubkey !== rv.signerPk)
  const { [rv.phonePk]: _old, ...rest } = p.pendingRevocations
  // Re-inserted last, so the overall cap drops the stalest key first.
  const entries = [...Object.entries(rest), [rv.phonePk, [...list, rv.event].slice(-PENDING_REVOCATIONS_PER_KEY)] as [string, SignedEvent[]]]
  p.pendingRevocations = Object.fromEntries(entries.slice(-PENDING_REVOCATIONS_CAP))
}

/** Adds a verified statement to the circle's table if allowed. Mutates `p`.
 *  Caller has already checked the identity is on the roster. */
function addToTable(p: Persisted, circleId: string, st: DeviceStatement, nowSec: number): boolean {
  if (p.revokedPhoneKeys[st.phonePk]) return false
  const owner = ownerOf(p, st.phonePk)
  if (owner !== null && owner !== st.identityPk) return false
  // Task 9 fix round 2: only settle (promote-or-drop) parked revocations
  // while the key is still unbound. Once it's bound, any park there is a
  // guardian's revocation awaiting its link (acceptRevocation's `parked`
  // branch) — a statement re-post must never clear it; only the link
  // re-judge path (promoteParkedRevocations) or the owner's own revocation
  // (acceptRevocation's `held`/owner branches) may.
  if (owner === null && settleParkedRevocations(p, st)) return false
  const table = (p.phoneKeys[circleId] ??= {})
  const prev = table[st.phonePk]
  // A replay of the statement already bound is a no-op: it must not refresh
  // lastSeen (anyone holding a copy could otherwise keep a dead phone fresh).
  if (prev && prev.statement.id === st.event.id && prev.memberPk === st.identityPk) return true
  // Keep the newest statement; never move lastSeen backwards.
  const statement = prev && prev.statement.created_at > st.event.created_at ? prev.statement : st.event
  table[st.phonePk] = { memberPk: st.identityPk, statement, lastSeen: Math.max(prev?.lastSeen ?? 0, nowSec) }
  return true
}

/** `sealPk` is the phone key that sealed the `t: 'device'` rumor carrying
 *  `ev` (the authenticated sender of the wrap). It must equal the phone key
 *  the statement names: proof that the poster holds that phone key, so a
 *  member can't bind (or relay) a statement for someone else's phone. Checked
 *  before anything is stored, so buffered statements have already passed it. */
export function acceptStatement(circle: Circle, ev: unknown, sealPk: string, nowSec: number): 'added' | 'buffered' | 'rejected' {
  const st = verifyDeviceStatement(ev)
  if (!st) return 'rejected'
  if (sealPk !== st.phonePk) return 'rejected'
  let result: 'added' | 'buffered' | 'rejected' = 'rejected'
  store.update((p) => {
    if (p.revokedPhoneKeys[st.phonePk]) return
    if (onRoster(circle, st.identityPk)) {
      if (addToTable(p, circle.id, st, nowSec)) {
        result = 'added'
        p.pendingStatements = p.pendingStatements.filter((e) => !(e.circleId === circle.id && e.event.id === st.event.id))
      }
      return
    }
    const owner = ownerOf(p, st.phonePk)
    if (owner !== null && owner !== st.identityPk) return
    if (!p.pendingStatements.some((e) => e.circleId === circle.id && e.event.id === st.event.id)) {
      p.pendingStatements.push({ circleId: circle.id, event: st.event })
      if (p.pendingStatements.length > PENDING_STATEMENTS_CAP) {
        p.pendingStatements = p.pendingStatements.slice(-PENDING_STATEMENTS_CAP)
      }
    }
    result = 'buffered'
  })
  return result
}

/** `'applied'`: signed by the key's owner (or, Plan 2, a linked guardian of
 *  the owner), now revoked. `'parked'`: either the key isn't bound to
 *  anyone here yet — held in `pendingRevocations` until a statement for it
 *  shows whose it is (final fix A4) — or it IS bound, but the signer is
 *  neither the owner nor (yet) a linked guardian of the owner (Task 9 fix
 *  round 1) — held in the same table until `promoteParkedRevocations` sees
 *  `linked(signer, owner)` become true. `'rejected'`: invalid. */
export function acceptRevocation(ev: unknown, circles: Circle[]): 'applied' | 'parked' | 'rejected' {
  // `circles` is unused: ownership is checked against every table in the
  // store (a superset of these circles), so a binding in a circle not passed
  // here still protects the key. Plan 2's guardian signer (see this module's
  // own header comment) is likewise checked globally via guardian-links.ts's
  // `linked`, never scoped to a circle's own role.
  void circles
  const rv = verifyRevocation(ev)
  if (!rv) return 'rejected'
  let result: 'applied' | 'parked' | 'rejected' = 'rejected'
  store.update((p) => {
    const held = p.revokedPhoneKeys[rv.phonePk]
    if (held) {
      // A repeat is idempotent (the first stored revocation is kept).
      const owner = ownerOf(p, rv.phonePk)
      const acceptedSigner = owner ?? verifyRevocation(held)?.signerPk
      if (acceptedSigner === rv.signerPk || (!!owner && linked(rv.signerPk, owner))) result = 'applied'
      return
    }
    const owner = ownerOf(p, rv.phonePk)
    // Purge buffered statements naming this key from the revocation's own
    // signer only (reads the `p` tag and author without re-verifying: this
    // only ever removes entries, and every survivor is re-verified when
    // rescanBuffered uses it).
    purgeBuffered(p, rv.phonePk, rv.signerPk)
    if (owner === null) {
      if (!mayPark(p, rv)) return
      parkRevocation(p, rv)
      result = 'parked'
      return
    }
    if (owner !== rv.signerPk && !linked(rv.signerPk, owner)) {
      // Task 9 fix round 1: not (yet) a linked guardian of the owner — park
      // it rather than drop it for good. The link pair backing a guardian's
      // revocation can arrive after the revocation itself (randomised
      // gift-wrap catch-up order), so this may just be early, not wrong.
      if (!mayPark(p, rv)) return
      parkRevocation(p, rv)
      result = 'parked'
      return
    }
    p.revokedPhoneKeys[rv.phonePk] = rv.event
    result = 'applied'
  })
  return result
}

/** The roster member `phonePk` is bound to in `circleId`, or null — also
 *  null when that member is no longer on the circle's current roster
 *  (final fix A9: a stale binding left by a roster change never resolves). */
export function memberForPhone(circleId: string, phonePk: string): string | null {
  const p = store.load()
  if (p.revokedPhoneKeys[phonePk]) return null
  const memberPk = p.phoneKeys[circleId]?.[phonePk]?.memberPk
  if (!memberPk) return null
  const circle = p.circles.find((c) => c.id === circleId)
  return circle && onRoster(circle, memberPk) ? memberPk : null
}

export function phonesOf(circleId: string, memberPk: string): string[] {
  const p = store.load()
  const table = p.phoneKeys[circleId] ?? {}
  return Object.entries(table)
    .filter(([phonePk, e]) => e.memberPk === memberPk && !p.revokedPhoneKeys[phonePk])
    .map(([phonePk]) => phonePk)
}

export function touch(circleId: string, phonePk: string, nowSec: number): void {
  store.update((p) => {
    const entry = p.phoneKeys[circleId]?.[phonePk]
    if (entry && !p.revokedPhoneKeys[phonePk] && nowSec > entry.lastSeen) entry.lastSeen = nowSec
  })
}

/** Re-checks the statements buffered on `circle` against its roster; call
 *  after any roster change. Entries buffered on other circles are left
 *  untouched. Of this circle's entries, those whose key is revoked or bound
 *  to another identity (or that no longer verify) are dropped; those whose
 *  identity is now on the roster are added and removed from the buffer. */
export function rescanBuffered(circle: Circle, nowSec: number): void {
  store.update((p) => {
    const keep: PendingStatement[] = []
    for (const entry of p.pendingStatements) {
      if (entry.circleId !== circle.id) { keep.push(entry); continue }
      const st = verifyDeviceStatement(entry.event)
      if (!st || p.revokedPhoneKeys[st.phonePk]) continue
      // Intentionally duplicates addToTable's revoked/owner checks: here a
      // failed check must DROP the entry (it can never succeed), whereas an
      // identity merely off the roster must be KEPT — addToTable's boolean
      // can't tell those apart.
      const owner = ownerOf(p, st.phonePk)
      if (owner !== null && owner !== st.identityPk) continue
      if (onRoster(circle, st.identityPk) && addToTable(p, circle.id, st, nowSec)) continue
      if (p.revokedPhoneKeys[st.phonePk]) continue // its own parked revocation was just promoted
      keep.push(entry)
    }
    p.pendingStatements = keep
  })
}

export function forgetMember(circleId: string, memberPk: string): void {
  store.update((p) => {
    const table = p.phoneKeys[circleId]
    if (!table) return
    for (const [phonePk, e] of Object.entries(table)) {
      if (e.memberPk === memberPk) delete table[phonePk]
    }
  })
}
