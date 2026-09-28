// Automatic removal on explicit contact signals, vouch hand-over and the
// 72 h unvouched timeout (plan 2, Task 8; spec §4, §6). This module never
// itself decides who counts as usable or unvouched (contacts.ts, vouches.ts)
// or whether a removal is authorised (authority.ts, enforced inside
// circles.ts's `removeMemberFromCircle`/`leaveCircle`/`sendRekey` — every
// call this module makes to them is just as checked as a person tapping the
// same button) — this module only decides WHEN to call them:
//  - an explicit contact-tier drop or absence for a watched pk (my own
//    vouchee, or my own voucher) — removed/left automatically, or (a bulk
//    change, or a lone absence) raised as a `TrustPrompt` for Task 10's UI;
//  - an unvouched member (vouches.ts's `unvouchedSince`, set wherever a
//    voucher is removed — see circles.ts's own doc comments at its
//    config-apply and rekey-apply sites, both pointing here): handed over to
//    a usable contact of mine, then, past the 72 h grace, re-keyed out — the
//    designated re-keyer first, any other member 10 minutes later if the
//    seed still hasn't moved;
//  - a circle member who just left (`circles.onMemberLeft`) is re-keyed out
//    the same way — immediately if I'm the designated re-keyer, as a
//    10-minute fallback otherwise;
//  - a guardian link breaking (`guardian-links.onLinkChange`) that backed a
//    dependant's vouch is treated as the same explicit drop;
//  - Task 9 fix round 1: a guardian link BECOMING true (the same
//    `onLinkChange`), and once at `start()` (app start), re-judges any
//    revocation parked because its bound key's signer wasn't yet a linked
//    guardian (beacons.ts `applyParkedRevocations`) — a revocation and the
//    link pair backing it can arrive in either order.
//
// "Designated re-keyer" (controller ruling): the lowest identity pubkey
// among a circle's non-`child`-role members, excluding the pk being
// removed — stable and non-grindable, same reasoning as circles.ts's own
// `pickRekeyWinner` tie-break.
//
// The 10-minute fallback clocks are kept in memory only (reset on restart,
// accepted): the persisted `unvouchedSince`/roster state is what actually
// matters, and a restart just means this device re-judges from scratch —
// always safe, since `sendRekey` is a no-op against a roster that has
// already dropped the pk, and the rekey-window collection in circles.ts
// already resolves any duplicate re-keys more than one device sends.
//
// A dependant session never enqueues a hand-over vouch or a timeout/leave
// re-key (each would cost a guardian a tap for something meant to be
// automatic) — it still leaves when its OWN voucher is explicitly dropped
// (`leaveCircle` removes only the caller, always allowed).

import { bytesToHex } from '@noble/hashes/utils.js'
import type { Circle } from '@forgesworn/covey-kit'
import * as store from './store.js'
import * as circles from './circles.js'
import * as contacts from './contacts.js'
import type { ContactsSnapshot } from './contacts.js'
import * as activity from './activity.js'
import { onLinkChange, linkedWithMe } from './guardian-links.js'
import { applyParkedRevocations } from './beacons.js'
import { vouchedBy, voucherOf, unvouchedSince, vouchPayload, UNVOUCHED_GRACE_SEC } from './vouches.js'
import { mayVouch } from './authority.js'
import { enqueue, pending } from './structural-queue.js'
import { currentSession } from './session.js'
import type { SessionInfo } from './session.js'
import { seedHash } from './structural.js'

export interface TrustPrompt { id: string; kind: 'absent' | 'bulk'; pks: string[]; createdAt: number }

const TICK_MS = 10 * 60 * 1000
/** The 10-minute fallback grace: a non-designated member's own clock,
 *  restarted whenever the circle's seed changes before it fires (something
 *  else moved the circle on; re-judge from there). */
interface Fallback { circleId: string; pk: string; since: number; seed: string }
const leaveFallback = new Map<string, Fallback>()
const timeoutFallback = new Map<string, Fallback>()

function fbKey(circleId: string, pk: string): string {
  return `${circleId}\u0000${pk}`
}

function nowSec(): number {
  return Math.floor(Date.now() / 1000)
}

function randomId(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
}

/** The lowest identity pubkey among `circle`'s non-`child`-role members —
 *  null if there is none. Exclude the pk being removed by passing a
 *  `circle` whose `members` already leaves it out (a leave's roster already
 *  does; a still-on-roster unvouched pk needs the caller to filter it). */
export function designatedRekeyer(circle: Circle): string | null {
  const eligible = circle.members.filter((m) => m.role !== 'child').map((m) => m.pk).sort()
  return eligible[0] ?? null
}

/** The pks this identity watches in `circleId`: everyone I vouched for, plus
 *  my own voucher — but only while that voucher is still a CURRENT member of
 *  `circle` (spec §6 — the only pks whose contact-tier changes are ever
 *  acted on automatically). Final small-fixes round: `voucherOf` (final fix
 *  N1) always resolves to the ORIGINAL voucher, still a member or not — a
 *  voucher who has already left the circle and later drops out of my own
 *  contacts too must not make ME leave; that member is already being
 *  re-judged/handed-over through the unvouched-since/72h path, not this
 *  contact-tier watch. */
function watchedPks(circle: Circle, selfPk: string): string[] {
  const mine = vouchedBy(circle.id, selfPk)
  const voucher = voucherOf(circle.id, selfPk)
  const voucherIsCurrentMember = voucher !== null && circle.members.some((m) => m.pk === voucher)
  return voucherIsCurrentMember ? [...mine, voucher as string] : mine
}

/** `pk`'s display name in `circleId`'s member table, falling back to a
 *  truncated pubkey — same fallback `handOver`'s own label already uses. */
function memberName(circleId: string, pk: string): string {
  const c = store.load().circles.find((x) => x.id === circleId)
  return c?.members.find((m) => m.pk === pk)?.name ?? pk.slice(0, 8)
}

/** Records the one Activity notice an automatic removal/leave/timeout
 *  earns (Task 8 fix round 1, finding I3 — spec §6's "notice to me and to
 *  the circle"): reuses the existing `member-removed`/`member-left` kinds
 *  (`activity.ts`'s own `summarize` renders `params.reason` verbatim when
 *  set), with an id keyed on (circle, pk, kind, now) so a caller that only
 *  ever reaches this once per real event (never from `tick`'s own loop)
 *  can't double-log it either. */
function noticeDrop(kind: 'member-removed' | 'member-left', circleId: string, actorPk: string, reason: string, now: number): void {
  activity.recordActivity({ id: `local-trust-watch-${kind}-${circleId}-${actorPk}-${now}`, at: now, kind, circleId, actorPk, params: { reason } })
}

/** The tail of `applyDrop`'s two notice sentences — one shared reason word
 *  choice per explicit-drop cause, so a guardian-link break (final review B,
 *  finding 5) reads correctly instead of always saying "no longer in your
 *  contacts" (which used to be hard-coded even for an unlink). `removed`
 *  slots into "Removed X: …"; `left` slots into "Left Y: X …" (already
 *  followed by "is", so it reads as a full clause). */
interface DropReason { removed: string; left: string }
const CONTACT_DROP_REASON: DropReason = { removed: 'no longer in your contacts', left: 'is no longer in your contacts' }
const UNLINK_DROP_REASON: DropReason = { removed: 'guardian link removed', left: 'is no longer linked to you' }

/** Removes `pk` from `circleId` if I vouched for them, or leaves `circleId`
 *  if `pk` is my own voucher — the one dispatch every explicit-drop path
 *  (a contact-tier drop, a bulk-prompt answer, or a broken guardian link)
 *  shares. A no-op if neither holds (the caller misjudged, or another
 *  device already applied the change).
 *
 *  Final review B, finding 4: with `auto` true (every AUTOMATIC caller —
 *  `onContactsChanged`, `handleUnlink` — never an explicit tap), a
 *  dependant session never removes its own vouchee silently here: a
 *  removal is an identity signature, and the plan only lets a dependant
 *  produce one automatically to leave on its OWN voucher dropping (the
 *  `else` branch below, unaffected by `auto`/`dependant` either way — a
 *  dependant leaving itself is always allowed). It gets the same `absent`
 *  prompt an ordinary absence raises instead. `answerPrompt` passes
 *  `auto: false` — the tap answering that very prompt (or any other) IS
 *  the guardian-tap the plan asks for, so it removes for real regardless
 *  of `self.dependant`. */
function applyDrop(circleId: string, pk: string, self: SessionInfo, now: number, opts: { reason?: DropReason; auto?: boolean } = {}): void {
  const reason = opts.reason ?? CONTACT_DROP_REASON
  const auto = opts.auto ?? true
  if (vouchedBy(circleId, self.identityPk).includes(pk)) {
    if (self.dependant && auto) {
      addPrompt('absent', [pk], now)
      return
    }
    noticeDrop('member-removed', circleId, pk, `Removed ${memberName(circleId, pk)}: ${reason.removed}`, now)
    void circles.removeMemberFromCircle(circleId, pk)
  } else if (voucherOf(circleId, self.identityPk) === pk) {
    const circleName = store.load().circles.find((x) => x.id === circleId)?.name ?? 'the circle'
    noticeDrop('member-left', circleId, self.identityPk, `Left ${circleName}: ${memberName(circleId, pk)} ${reason.left}`, now)
    void circles.leaveCircle(circleId)
  }
}

// ---------------------------------------------------------------------------
// Trust prompts (Task 10 renders these; this module only produces them)
// ---------------------------------------------------------------------------

export function prompts(): TrustPrompt[] {
  return store.load().trustPrompts
}

/** The same pk set, order-independent — final review B, finding 6's own
 *  bulk-prompt dedupe key. */
function samePkSet(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const sa = [...a].sort()
  const sb = [...b].sort()
  return sa.every((pk, i) => pk === sb[i])
}

/** Raises an `absent` prompt for `pk` unless one is already open for it
 *  (deduped), or a `bulk` prompt listing every pk in `pks` — likewise
 *  deduped against an already-open bulk prompt for the exact same set
 *  (final review B, finding 6: two updates, or the duplicate watcher from
 *  finding C1, used to stack identical cards). */
function addPrompt(kind: 'absent' | 'bulk', pks: string[], now: number): void {
  store.update((p) => {
    if (kind === 'absent' && p.trustPrompts.some((pr) => pr.kind === 'absent' && pr.pks[0] === pks[0])) return
    if (kind === 'bulk' && p.trustPrompts.some((pr) => pr.kind === 'bulk' && samePkSet(pr.pks, pks))) return
    p.trustPrompts = [...p.trustPrompts, { id: randomId(), kind, pks: [...pks], createdAt: now }]
  })
}

/** Answers a prompt: it is dropped either way; `remove` also applies
 *  `applyDrop` for every pk it listed, across every circle where that pk is
 *  currently watched (a prompt carries no circle id of its own).
 *
 *  Final review B, finding 6: re-checked here, at answer time, not just
 *  when the prompt was raised — `contacts.usable` (which itself checks a
 *  guardian link first) covers both "became linked since" and "tier
 *  recovered since"; either means this pk is no longer anyone's business to
 *  drop just because a prompt was sitting around from when it was. */
export function answerPrompt(id: string, remove: boolean): void {
  const prompt = store.load().trustPrompts.find((pr) => pr.id === id)
  if (!prompt) return
  store.update((p) => { p.trustPrompts = p.trustPrompts.filter((pr) => pr.id !== id) })
  if (!remove) return
  const self = currentSession()
  if (!self) return
  const now = nowSec()
  const linked = linkedWithMe(self.identityPk)
  const snap = contacts.snapshot()
  for (const pk of prompt.pks) {
    if (contacts.usable(snap, pk, linked)) continue
    for (const c of store.load().circles) applyDrop(c.id, pk, self, now, { auto: false })
  }
}

// ---------------------------------------------------------------------------
// Contact-tier signals (spec §6)
// ---------------------------------------------------------------------------

/** Reacts to a contacts snapshot update: per circle, classifies what
 *  changed for the pks I watch there. `unknown` (not connected, truncated,
 *  emptied out) asks nothing and removes nothing — Task 10's banner is the
 *  only response. A linked pk (Task 8 fix round 1, finding C1) is filtered
 *  out of both `dropped` and `absent` before anything else runs: a link
 *  counts as usable regardless of contact tier, so only an unlink
 *  (`handleUnlink` below) ever drops one — `classifyUpdate` itself can't
 *  make that call (it takes no link check; see its own `noLink` — a plain
 *  contacts.ts concern). Every explicit drop across every circle is deduped
 *  by pk; more than one (or any single circle's own drops, post-filter)
 *  raises one `bulk` prompt instead of removing anything, so a batch always
 *  asks once rather than silently dropping several people. A lone drop is
 *  applied immediately; each `absent` pk always raises its own prompt, bulk
 *  or not. */
export function onContactsChanged(next: ContactsSnapshot, prev: ContactsSnapshot): void {
  const self = currentSession()
  if (!self) return
  const now = nowSec()
  const linked = linkedWithMe(self.identityPk)
  const perCircle: Array<{ circleId: string; dropped: string[] }> = []
  const allDropped: string[] = []
  let anyBulk = false
  for (const c of store.load().circles) {
    const watched = watchedPks(c, self.identityPk)
    if (!watched.length) continue
    const cls = contacts.classifyUpdate(prev, next, watched)
    if (cls.unknown) continue
    const absent = cls.absent.filter((pk) => !linked(pk))
    const dropped = cls.dropped.filter((pk) => !linked(pk))
    for (const pk of absent) addPrompt('absent', [pk], now)
    if (dropped.length) {
      perCircle.push({ circleId: c.id, dropped })
      allDropped.push(...dropped)
      if (dropped.length > 1) anyBulk = true
    }
  }
  const deduped = [...new Set(allDropped)]
  if (anyBulk || deduped.length > 1) {
    if (deduped.length) addPrompt('bulk', deduped, now)
    return
  }
  for (const { circleId, dropped } of perCircle) {
    for (const pk of dropped) applyDrop(circleId, pk, self, now)
  }
}

/** A guardian link breaking that backed a dependant's vouch (spec §6): the
 *  dependant's stored voucher in `circleId` IS the unlinked guardian — the
 *  same explicit-drop dispatch as a contact-tier drop, on every device that
 *  holds this circle's vouch record. Final review B, finding 5: this is a
 *  link breaking, not a contact-tier change, so it earns its own notice
 *  wording (`UNLINK_DROP_REASON`), not "no longer in your contacts". */
function handleUnlink(guardianPk: string, dependantPk: string): void {
  const self = currentSession()
  if (!self) return
  const now = nowSec()
  for (const c of store.load().circles) {
    if (voucherOf(c.id, dependantPk) === guardianPk) applyDrop(c.id, dependantPk, self, now, { reason: UNLINK_DROP_REASON })
  }
}

// ---------------------------------------------------------------------------
// Hand-over and the 72 h timeout
// ---------------------------------------------------------------------------

function unvouchedMembers(c: Circle): string[] {
  return c.members.map((m) => m.pk).filter((pk) => unvouchedSince(c.id, pk) !== null)
}

/** Whether a hand-over `vouch` for `pk` in `circleId` is already queued
 *  (waiting or rejected — either way, another one would just pile up). */
function alreadyQueuedVouch(circleId: string, pk: string, selfPk: string): boolean {
  const want = vouchPayload(pk)
  return pending().some((item) =>
    item.action === 'vouch' && item.circleId === circleId && item.payload === want && item.identityPk === selfPk)
}

/** Final review B, finding 7: remembers, per (circleId, pk), the
 *  `unvouchedSince` value in force the last time a hand-over vouch for it
 *  was seen queued (waiting or rejected). Once the user dismisses that
 *  queue item (the structural queue's own Dismiss/cancel — `waiting` or
 *  `rejected`, either can be dismissed), `alreadyQueuedVouch` goes back to
 *  false, and without this memory `handOver` would treat that as "never
 *  offered" and re-enqueue the very next tick — a hand-over the user just
 *  declined, prompting again every 10 minutes for up to 72 h. Kept until
 *  `unvouchedSince` itself changes (a fresh unvouched mark). In-memory
 *  only, same "reset on restart, harmless" convention as `leaveFallback`/
 *  `timeoutFallback` above — a restart re-offers once, nothing like the
 *  every-10-minutes repeat this fixes. */
const seenQueuedSince = new Map<string, number>()

/** Hands the vouch for an unvouched `pk` over to me, if I can usefully hold
 *  it: not a dependant session, not myself, a usable contact of mine (a
 *  guardian link or kin/kith tier), a vouch of mine would actually be
 *  authorised (Task 8 fix round 1, finding I1 — `mayVouch`, built from the
 *  same rule `authority.ts`'s `vouchValid` enforces on receipt, checked
 *  against `pk`'s CURRENT role — a dependant needs a link, a guardian needs
 *  a guardian voucher, exactly as `acceptVouch` will judge it once signed),
 *  and nothing of mine already queued or signed-not-yet-applied for them
 *  (`alreadyQueuedVouch` — every queued item, waiting or rejected, stays
 *  until the sender's `acceptVouch` call removes the unvouched mark, which
 *  happens synchronously once the send resolves, so there is no window
 *  where a pending send is invisible to this check), nor already declined
 *  for the same `unvouchedSince` (`seenQueuedSince`, finding 7). Without the
 *  `mayVouch` check, an invalid vouch would still get signed, rejected by
 *  every receiver, and (its queue item having succeeded from THIS device's
 *  point of view) enqueued again next tick — a fresh signer prompt every 10
 *  minutes for up to 72 h. The queued `vouch` is sent by circles.ts's own
 *  registered sender (`registerStructuralSenders`) as a normal identity-
 *  signed structural event. */
function handOver(c: Circle, pk: string, self: SessionInfo): void {
  if (self.dependant || pk === self.identityPk) return
  const since = unvouchedSince(c.id, pk)
  const k = fbKey(c.id, pk)
  if (alreadyQueuedVouch(c.id, pk, self.identityPk)) {
    if (since !== null) seenQueuedSince.set(k, since)
    return
  }
  if (since === null) {
    seenQueuedSince.delete(k)
    return
  }
  if (seenQueuedSince.get(k) === since) return // dismissed already; wait for `since` to change
  if (!contacts.usable(contacts.snapshot(), pk, linkedWithMe(self.identityPk))) return
  const role = c.members.find((m) => m.pk === pk)?.role
  if (!role || !mayVouch(circles.trustViewFor(c.id), self.identityPk, pk, role)) return
  const name = c.members.find((m) => m.pk === pk)?.name ?? pk.slice(0, 8)
  enqueue({ action: 'vouch', circleId: c.id, payload: vouchPayload(pk), label: `Vouch for ${name} in ${c.name}` })
  seenQueuedSince.set(k, since)
}

/** The 72 h unvouched timeout: past the grace, the designated re-keyer
 *  re-keys `pk` out at once; any other member only 10 minutes later, and
 *  only if the circle's seed hasn't moved in that time (someone else,
 *  probably the designated re-keyer, already handled it otherwise). Never
 *  run for a dependant session (a re-key costs a guardian's tap). Skips
 *  the re-key (and the notice below) once `circles.removalPending` already
 *  shows `pk`'s removal in flight (Task 8 fix round 1, finding I2) — without
 *  it, every tick before the re-key applies signs and sends another one. */
function timeoutTick(c: Circle, pk: string, self: SessionInfo, now: number): void {
  if (self.dependant) return
  const since = unvouchedSince(c.id, pk)
  const k = fbKey(c.id, pk)
  if (since === null || now - since < UNVOUCHED_GRACE_SEC) {
    timeoutFallback.delete(k)
    return
  }
  if (circles.removalPending(c.id, pk)) {
    timeoutFallback.delete(k)
    return
  }
  const withoutPk: Circle = { ...c, members: c.members.filter((m) => m.pk !== pk) }
  if (designatedRekeyer(withoutPk) === self.identityPk) {
    // Deferred minor, "fix before merge": `sendRekey` is a no-op synchronous
    // return (no `await` before it — see circles.ts's own doc comment) when
    // OUR OWN phone is revoked and nothing of ours survives to receive the
    // new seed either. Recording the notice regardless used to log a fresh
    // "Removed …" entry on every single tick for something that never
    // actually happened. `removalPending` reflects the real outcome
    // synchronously (`sendRekey` never awaits before setting it), so check
    // it AFTER calling, not before.
    void circles.sendRekey(c, [pk])
    if (circles.removalPending(c.id, pk)) {
      noticeDrop('member-removed', c.id, pk, `Removed ${memberName(c.id, pk)}: nobody vouched for them within 72 hours`, now)
      timeoutFallback.delete(k)
    }
    return
  }
  const curSeed = seedHash(c.seedHex)
  const rec = timeoutFallback.get(k)
  if (!rec || rec.seed !== curSeed) {
    timeoutFallback.set(k, { circleId: c.id, pk, since: now, seed: curSeed })
    return
  }
  if (now - rec.since >= 600) {
    void circles.sendRekey(c, [pk])
    if (circles.removalPending(c.id, pk)) {
      noticeDrop('member-removed', c.id, pk, `Removed ${memberName(c.id, pk)}: nobody vouched for them within 72 hours`, now)
      timeoutFallback.delete(k)
    }
    // Else: `sendRekey` returned early — leave the fallback record in place
    // (same `since`/seed) so this device keeps quietly retrying every 10
    // minutes rather than either giving up or logging a notice for nothing.
  }
}

/** A circle member who just left (`circles.onMemberLeft` — the roster
 *  already dropped them by the time this fires): re-keyed out by the same
 *  designated-re-keyer rule as the unvouched timeout, immediate for the
 *  designated re-keyer, a 10-minute fallback for anyone else. Never run for
 *  a dependant session. Skips the re-key once `circles.removalPending`
 *  already shows it in flight (Task 8 fix round 1, finding I2 — same
 *  reasoning as `timeoutTick`'s own check). */
function leaveTick(circleId: string, pk: string, self: SessionInfo, now: number): void {
  if (self.dependant) return
  const k = fbKey(circleId, pk)
  const c = store.load().circles.find((x) => x.id === circleId)
  if (!c || c.members.some((m) => m.pk === pk)) {
    leaveFallback.delete(k)
    return
  }
  if (circles.removalPending(circleId, pk)) {
    leaveFallback.delete(k)
    return
  }
  if (designatedRekeyer(c) === self.identityPk) {
    void circles.sendRekey(c, [pk])
    leaveFallback.delete(k)
    return
  }
  const curSeed = seedHash(c.seedHex)
  const rec = leaveFallback.get(k)
  if (!rec || rec.seed !== curSeed) {
    leaveFallback.set(k, { circleId, pk, since: now, seed: curSeed })
    return
  }
  if (now - rec.since >= 600) {
    void circles.sendRekey(c, [pk])
    leaveFallback.delete(k)
  }
}

/** Hand-over, the 72 h timeout and the leave fallback, for every circle —
 *  run every 10 minutes and on app resume (`start()`), and callable directly
 *  (e.g. from a test's fake clock). A no-op signed out. */
export function tick(now: number): void {
  const self = currentSession()
  if (!self) return
  for (const c of store.load().circles) {
    for (const pk of unvouchedMembers(c)) {
      handOver(c, pk, self)
      timeoutTick(c, pk, self, now)
    }
  }
  for (const rec of [...leaveFallback.values()]) leaveTick(rec.circleId, rec.pk, self, now)
}

/** Final review B, finding C1: `start()` used to call `tick()` inline,
 *  synchronously, before returning its own stop function — but `render()` is
 *  what calls `start()` in the first place (app.ts), and `tick()` can write
 *  to the store (`noticeDrop`/`enqueue`), which notifies subscribers,
 *  including `render()`, synchronously. `render()` re-entering while
 *  app.ts's own `stopTrustWatch = trustWatch.start()` assignment hadn't
 *  completed yet saw a still-null slot and called `start()` again — for a
 *  member already past the 72 h grace with this device as the designated
 *  re-keyer, `timeoutTick` recurses without end (unbounded recursion, the
 *  app crashes on every launch); for a hand-over, it merely runs `start()`
 *  twice, leaking a duplicate set of subscriptions/timers that both survive
 *  sign-out.
 *
 *  Fixed two ways, kept together deliberately (either alone would do, but
 *  both are cheap and each is a hard backstop for the other):
 *   - `startedStop` (module-level) makes `start()` itself idempotent — a
 *     second call, however it re-enters, returns the existing stop function
 *     without adding a second copy of anything. Set BEFORE any of `tick()`'s
 *     own possible store writes, so a synchronous re-entry mid-`start()`
 *     still finds it non-null.
 *   - The initial `tick()` is deferred (`queueMicrotask`, same idiom already
 *     used below for `applyParkedRevocations`) rather than run inline: by the
 *     time it (or anything else queued here) can write to the store, this
 *     synchronous call to `start()` has already returned and app.ts's own
 *     `stopTrustWatch` assignment has already landed. */
let startedStop: (() => void) | null = null

/** Subscribes to contacts updates, member-left and broken-link events, and
 *  arms `tick()` (every 10 minutes, and on app resume). Returns a stop
 *  function — sign-out (`store.clear()`) fires none of these subscriptions
 *  on its own, so the caller must call it then (app.ts, alongside every
 *  other module's own sign-out teardown). Idempotent: a second call before
 *  the first's stop function runs is a no-op that returns the same stop
 *  function (see the doc comment above). */
export function start(): () => void {
  if (startedStop) return startedStop
  const offContacts = contacts.onContactsUpdate(onContactsChanged)
  const offLeft = circles.onMemberLeft((circleId, pk, at) => {
    const self = currentSession()
    if (self) leaveTick(circleId, pk, self, at)
  })
  const offLink = onLinkChange((guardianPk, dependantPk, isLinked) => {
    if (!isLinked) handleUnlink(guardianPk, dependantPk)
    // Task 9 fix round 1: deferred to a microtask, never called in-line —
    // `promoteParkedRevocations`, when it actually promotes something, goes
    // through `store.update` (persist + notify), which can re-enter
    // app.ts's `render()` synchronously; `onLinkChange`'s own `fire()` is
    // itself already inside a `store.update` call (guardian-links.ts's
    // `acceptLinkPair`), so calling straight through here would nest a
    // second `store.update` inside the first one. Queuing it instead lets
    // the pair's own update finish and `render()` settle before this runs.
    else queueMicrotask(() => { void applyParkedRevocations() })
  })
  const onVisible = (): void => {
    if (document.visibilityState === 'visible') tick(nowSec())
  }
  if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
  const timer = setInterval(() => { tick(nowSec()) }, TICK_MS)
  const stop = (): void => {
    offContacts()
    offLeft()
    offLink()
    clearInterval(timer)
    if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
    leaveFallback.clear()
    timeoutFallback.clear()
    seenQueuedSince.clear()
    startedStop = null
  }
  // Claimed before anything below can possibly write to the store — see
  // this function's own doc comment.
  startedStop = stop
  // App resume/start: a parked revocation's link pair may have arrived
  // while this device was offline. Deferred (see the doc comment above) —
  // `start()` itself runs synchronously inside app.ts's `render()`, before
  // its own `stopTrustWatch = trustWatch.start()` assignment completes; an
  // in-line call whose promotion writes to the store would notify and
  // re-enter `render()` before that assignment lands.
  queueMicrotask(() => { void applyParkedRevocations() })
  // The initial tick, deferred for the same reason (finding C1).
  queueMicrotask(() => { tick(nowSec()) })
  return stop
}
