// Who may perform which structural action: the full authority table of
// internal design record: 2026-09-25-kindependence-contacts-circles-design.md
// §4 (plan 2, Task 5). Pure: every check reads only a `TrustView` (the
// circle's roster before the action, its creator, stored vouches, guardian
// links, unvouched marks) and the verified inner event, so the receive
// choke point (beacons.ts `receiveStructural`) and the phone-inbox re-key
// receiver (circles.ts `judgeRekeyRumor`, against the roster at `prev`)
// share one rule set.
//
// The table (the signer is always a roster member; nobody may raise their
// own role, in any row):
//  - `invite` (add + vouch): any member, the vouch valid (`vouchValid`) for
//    the role it names: a `peer` by anyone, a `guardian` by a guardian, a
//    `child` by a member linked to them as guardian.
//  - `vouch` (hand-over): any member other than the vouchee; the vouchee is
//    a member. A hand-over only keeps its vouchee vouched; it never makes
//    its signer their voucher for `mayRemove` (final fix N1).
//  - `config`: members removed → each passes `mayRemove`; members added →
//    each has a vouch (carried in the config, stored or pending) valid
//    against the roster before the change — the creator too, when re-added
//    (Task 5 fix round 1: every addition needs a vouch and the role cap).
//    An added member may rank above the signer when a voucher of that rank
//    vouched for them: the vouch carries the authority, not the signer.
//    Role changed → guardian signer, and a change to or from `child` needs
//    a guardian link signer→member; name changed → guardian signer;
//    `createdBy`, when not `''` (unknown to its writer), equals the held
//    creator when one is held. A received `createdBy` is never adopted.
//  - `rekey`: any member; every member it newly removes passes `mayRemove`.
//    One that removes no member (a revocation or recovery re-key) is allowed.
//  - `places`, `family-policy`, `approval-resp`, `agreement`, `extend-resp`:
//    a guardian-role signer who holds a linked dependant in this circle.

import type { CircleMember, Role } from '@forgesworn/covey-kit'
import type { SignedEvent } from '@forgesworn/roost-kit'
import type { StructuralEvent } from './structural.js'
import { verifyVouch, UNVOUCHED_GRACE_SEC, type Vouch } from './vouches.js'

const HEX64 = /^[0-9a-f]{64}$/
const ROLES: ReadonlySet<string> = new Set(['guardian', 'child', 'peer'])

/** Rank for "raising" a role: a dependant (`child`) < `peer` < `guardian`. */
function rank(role: Role): number {
  return role === 'guardian' ? 2 : role === 'peer' ? 1 : 0
}

export interface TrustView {
  members: CircleMember[]                         // roster before the action
  /** The circle's name before the action (a config renaming it needs a
   *  guardian signer). */
  name: string
  creator: string | null
  /** Who added `pk`: the signer of their original invite vouch, never a
   *  hand-over's (final fix N1 — so every device agrees on it). */
  voucherOf(pk: string): string | null
  /** The stored and pending vouches for `pk` (a config may rely on one
   *  instead of carrying it). Absent: none counts. */
  vouchFor?(pk: string): VouchCandidates
  linked(guardianPk: string, dependantPk: string): boolean
  unvouchedSince(pk: string): number | null
  /** Final review A, I1: when `pk` was removed (its tombstone's signed
   *  time), or null — a vouch for a removed pk counts only if dated after
   *  it. Absent: no removals known. */
  removedAt?(pk: string): number | null
}

/** The held vouches a config adding `pk` may rely on: the member table's
 *  and the pending ones (Task 5 fix round 1), or none. */
export type VouchCandidates = Vouch | readonly Vouch[] | null
function asList(c: VouchCandidates): readonly Vouch[] {
  return c === null ? [] : Array.isArray(c) ? c : [c as Vouch]
}

export interface ConfigMember { pk: string; role: Role; name?: string }
export interface ConfigV2 { v: 2; id: string; name: string; createdBy: string; updatedAt: number; by: string; members: ConfigMember[]; vouches: SignedEvent[] }

function roleIn(view: TrustView, pk: string): Role | undefined {
  return view.members.find((m) => m.pk === pk)?.role
}

/** Final review A, M4: most members, and most vouches, a config may list
 *  (each carried vouch costs a signature check on every judgement). */
export const CONFIG_MAX_ENTRIES = 256

/** Shape check for a config v2 payload. Null if bad. `createdBy` is `''`
 *  (the writer holds no creator) or a pubkey. Vouches are only
 *  shape-checked here; each is verified where it is used. */
export function parseConfigV2(json: string): ConfigV2 | null {
  let o: unknown
  try { o = JSON.parse(json) } catch { return null }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return null
  const r = o as Record<string, unknown>
  if (r.v !== 2 || typeof r.id !== 'string' || !r.id || typeof r.name !== 'string') return null
  if (typeof r.createdBy !== 'string' || (r.createdBy !== '' && !HEX64.test(r.createdBy))) return null
  if (typeof r.updatedAt !== 'number' || !Number.isFinite(r.updatedAt)) return null
  if (typeof r.by !== 'string' || !HEX64.test(r.by)) return null
  if (!Array.isArray(r.members) || !Array.isArray(r.vouches)) return null
  if (r.members.length > CONFIG_MAX_ENTRIES || r.vouches.length > CONFIG_MAX_ENTRIES) return null
  const seen = new Set<string>()
  const members: ConfigMember[] = []
  for (const m of r.members as unknown[]) {
    if (!m || typeof m !== 'object') return null
    const mm = m as Record<string, unknown>
    if (typeof mm.pk !== 'string' || !HEX64.test(mm.pk) || typeof mm.role !== 'string' || !ROLES.has(mm.role)) return null
    if (mm.name !== undefined && typeof mm.name !== 'string') return null
    if (seen.has(mm.pk)) return null
    seen.add(mm.pk)
    members.push({ pk: mm.pk, role: mm.role as Role, ...(typeof mm.name === 'string' ? { name: mm.name } : {}) })
  }
  for (const ev of r.vouches as unknown[]) {
    if (!ev || typeof ev !== 'object' || Array.isArray(ev)) return null
  }
  return {
    v: 2, id: r.id, name: r.name, createdBy: r.createdBy, updatedAt: r.updatedAt, by: r.by,
    members, vouches: r.vouches as SignedEvent[],
  }
}

/** Whether `signerPk` may take `pk` off the roster: leaving (themself), a
 *  guardian-role signer, the member's original voucher (`voucherOf` — a
 *  hand-over grants nothing here), or anyone once the member
 *  has been unvouched for 71 h (the 72 h grace less an hour of clock
 *  slack). */
export function mayRemove(view: TrustView, signerPk: string, pk: string, nowSec: number): boolean {
  if (pk === signerPk) return true
  const role = roleIn(view, signerPk)
  if (!role) return false
  if (role === 'guardian') return true
  if (view.voucherOf(pk) === signerPk) return true
  const since = view.unvouchedSince(pk)
  return since !== null && nowSec - since >= UNVOUCHED_GRACE_SEC - 3600
}

/** Whether `voucherPk` may vouch for `pk` at `addedRole` in `view`: a
 *  roster member other than `pk` themself, and, by role (Task 6 controller
 *  ruling — spec §3, any member may add people): any member, a dependant
 *  included, may vouch for a `peer`; a `guardian` needs a guardian-role
 *  voucher; a dependant (`child`) needs a guardian link voucher→vouchee.
 *  The role-rank check a real, carried `Vouch` also needs (its own
 *  claimed `role`, if any, capped at `addedRole`) is `vouchValid`'s alone —
 *  this is the part of the rule that holds with no signed vouch to check
 *  yet, so trust-watch.ts's hand-over can ask "would this be worth
 *  signing?" before it spends a signer prompt on one (Task 8 fix round
 *  1, finding I1). */
export function mayVouch(view: TrustView, voucherPk: string, pk: string, addedRole: Role): boolean {
  const byRole = roleIn(view, voucherPk)
  if (!byRole || voucherPk === pk) return false
  if (addedRole === 'guardian' && byRole !== 'guardian') return false
  if (addedRole === 'child' && !view.linked(voucherPk, pk)) return false
  return true
}

/** Whether vouch `v` can put its vouchee on the roster at `addedRole`: the
 *  voucher is a roster member other than the vouchee, and the role is no
 *  higher than the one an invite vouch names. Then, by role (Task 6
 *  controller ruling — spec §3, any member may add people): any member,
 *  a dependant included, may add a `peer`; a `guardian` needs a
 *  guardian-role voucher; a dependant (`child`) needs a guardian link
 *  voucher→vouchee. Config role changes keep their own rules. */
export function vouchValid(view: TrustView, v: Vouch, addedRole: Role): boolean {
  if (v.role !== undefined && rank(addedRole) > rank(v.role)) return false
  return mayVouch(view, v.by, v.pk, addedRole)
}

/** The carried vouches of `cfg` that verify, each checked once per config
 *  object (a hostile config's vouch list must not cost a signature check
 *  per added member). */
const carriedCache = new WeakMap<ConfigV2, Vouch[]>()
function carried(cfg: ConfigV2): Vouch[] {
  let out = carriedCache.get(cfg)
  if (!out) {
    out = cfg.vouches.map((ev) => verifyVouch(ev)).filter((v): v is Vouch => v !== null)
    carriedCache.set(cfg, out)
  }
  return out
}

/** Whether `v` may put `pk` on the roster (final review A, I1): only an
 *  `invite` vouch, which names a role (a hand-over `vouch` keeps a current
 *  member's place, never adds one), and for a removed pk only one dated
 *  after the removal (spec §5: back only through a new invite). */
function addsMember(view: TrustView, v: Vouch, pk: string): boolean {
  if (v.role === undefined) return false
  const at = view.removedAt?.(pk) ?? null
  return at === null || v.createdAt > at
}

/** The vouch that puts `pk` on the roster at `role` for this config: the
 *  first carried one that verifies, belongs to `circleId`, may add
 *  (`addsMember`) and is valid, else the first held (stored or pending)
 *  one that is. Null if none — an invalid vouch never blocks a valid one. */
export function configVouchFor(view: TrustView, circleId: string, cfg: ConfigV2, pk: string, role: Role, vouchFor: (pk: string) => VouchCandidates): Vouch | null {
  for (const v of carried(cfg)) {
    if (v.circleId === circleId && v.pk === pk && addsMember(view, v, pk) && vouchValid(view, v, role)) return v
  }
  for (const held of asList(vouchFor(pk))) {
    if (held.circleId === circleId && held.pk === pk && addsMember(view, held, pk) && vouchValid(view, held, role)) return held
  }
  return null
}

/** A config's verdict: `'ok'`, `'refused'`, or `'needs-vouch'` — refused
 *  only because an added member has no valid vouch yet (carried, stored or
 *  pending), which the receiver parks until one arrives. */
export type ConfigVerdict = 'ok' | 'refused' | 'needs-vouch'

export function configVerdict(view: TrustView, circleId: string, signerPk: string, cfg: ConfigV2, vouchFor: (pk: string) => VouchCandidates, nowSec: number): ConfigVerdict {
  if (cfg.id !== circleId || cfg.by !== signerPk) return 'refused'
  const signerRole = roleIn(view, signerPk)
  if (!signerRole) return 'refused'
  // '' is a writer that holds no creator: unknown, not a claim.
  if (cfg.createdBy !== '' && view.creator !== null && cfg.createdBy !== view.creator) return 'refused'
  const guardian = signerRole === 'guardian'
  if (cfg.name !== view.name && !guardian) return 'refused'
  const next = new Map(cfg.members.map((m) => [m.pk, m.role]))
  // Nobody raises their own role — a guardian can't go higher either.
  const ownNext = next.get(signerPk)
  if (ownNext !== undefined && rank(ownNext) > rank(signerRole)) return 'refused'
  for (const m of view.members) {
    const role = next.get(m.pk)
    if (role === undefined) {
      if (!mayRemove(view, signerPk, m.pk, nowSec)) return 'refused'
    } else if (role !== m.role) {
      if (!guardian) return 'refused'
      if ((role === 'child' || m.role === 'child') && !view.linked(signerPk, m.pk)) return 'refused'
    }
  }
  // Every addition — the creator re-added included — needs a valid vouch
  // (Task 5 fix round 1). One may still arrive, so a config lacking one
  // waits rather than being dropped.
  for (const m of cfg.members) {
    if (view.members.some((x) => x.pk === m.pk)) continue
    if (!configVouchFor(view, circleId, cfg, m.pk, m.role, vouchFor)) return 'needs-vouch'
  }
  return 'ok'
}

export function configAuthorised(view: TrustView, circleId: string, signerPk: string, cfg: ConfigV2, vouchFor: (pk: string) => VouchCandidates, nowSec: number = Math.floor(Date.now() / 1000)): boolean {
  return configVerdict(view, circleId, signerPk, cfg, vouchFor, nowSec) === 'ok'
}

/** Whether `guardianPk` holds a linked dependant (a `child`-role member) in
 *  this circle. */
export function holdsLinkedDependant(view: TrustView, guardianPk: string): boolean {
  return view.members.some((m) => m.role === 'child' && view.linked(guardianPk, m.pk))
}

/** The removal set of a re-key payload, or null if malformed. */
function rekeyRemovals(json: string): string[] | null {
  let o: unknown
  try { o = JSON.parse(json) } catch { return null }
  if (!o || typeof o !== 'object') return null
  const r = (o as { removals?: unknown }).removals
  return Array.isArray(r) && r.every((x) => typeof x === 'string') ? (r as string[]) : null
}

/** The authority check for a verified structural event against `view`.
 *  Roster membership of the signer is part of every rule. */
export function structuralAuthorised(view: TrustView, ev: StructuralEvent, nowSec: number): boolean {
  const role = roleIn(view, ev.signerPk)
  if (!role) return false
  switch (ev.action) {
    case 'config': {
      const cfg = parseConfigV2(ev.payload)
      return !!cfg && configAuthorised(view, ev.circleId, ev.signerPk, cfg, (pk) => view.vouchFor?.(pk) ?? null, nowSec)
    }
    case 'invite': {
      const v = verifyVouch(ev.event)
      return !!v && v.circleId === ev.circleId && v.role !== undefined && vouchValid(view, v, v.role)
    }
    case 'vouch': {
      const v = verifyVouch(ev.event)
      const vouchee = v ? roleIn(view, v.pk) : undefined
      return !!v && v.circleId === ev.circleId && !!vouchee && vouchValid(view, v, vouchee)
    }
    case 'rekey': {
      const removals = rekeyRemovals(ev.payload)
      if (!removals) return false
      // Only members are newly removed: a pk off the roster is already out.
      return removals.filter((pk) => roleIn(view, pk)).every((pk) => mayRemove(view, ev.signerPk, pk, nowSec))
    }
    case 'family-policy':
    case 'approval-resp':
    case 'agreement':
    case 'extend-resp':
    case 'places':
      return role === 'guardian' && holdsLinkedDependant(view, ev.signerPk)
  }
}
