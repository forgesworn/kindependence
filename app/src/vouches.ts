// Identity-signed vouches (plan 2, Task 4; spec §4): every circle member is
// on the roster because another member vouched for them — "I vouch for pk
// in circle C", signed by the voucher's identity key. Config can carry
// vouches but can't forge or overwrite one: only a signature does that.
//
// Two event shapes count as a vouch, both structural inner events
// (structural.ts):
// - `invite` whose payload names its invitee (`pk`, `role`, optional
//   `memberName`) — the invite IS the adder's vouch. Plan-1 invites carry no
//   `pk` and are not vouches.
// - `vouch` with payload `{ pk }` — a hand-over, when a voucher leaves.
//
// Trust rules enforced here:
// - Signature, shape and `by !== pk` only. Whether the voucher may vouch
//   (roster, roles, links) is authority.ts's job (Task 5).
// - The `prev` seed chain is NOT checked: a joiner can't know old seeds.
//   Cross-circle replay is closed by the event's own signed `circle` tag
//   (and an invite's `payload.id` must equal it).
// - Stored by the event's own circle tag and signed vouchee, never by the
//   caller's labels, and re-verified on every read: a tampered or misfiled
//   store entry reads as absent.
// - Newest wins per (circle, vouchee): higher created_at, then lower event
//   id on a tie, so every device converges on the same vouch.
// - Final fix N1 (controller ruling): the member table holds only `invite`
//   vouches — a member's original vouch, the one that added them. Its
//   voucher alone gets the voucher clause of removal authority. Hand-overs
//   live in the pending table, any number per vouchee (one per voucher),
//   and only ever keep a member vouched; they never grant authority.

import type { Role } from '@forgesworn/covey-kit'
import type { SignedEvent } from '@forgesworn/roost-kit'
import * as store from './store.js'
import type { Persisted } from './store.js'
import { verifyStructural } from './structural.js'

const HEX64 = /^[0-9a-f]{64}$/
const ROLES: ReadonlySet<string> = new Set<Role>(['guardian', 'child', 'peer'])

/** Seconds an unvouched member keeps their place before any member may
 *  re-key them out (spec §4). */
export const UNVOUCHED_GRACE_SEC = 72 * 3600

/** The `invite` structural event's payload once it names its invitee (Task 6
 *  sends it). `id` must equal the event's own `circle` tag. */
export interface InvitePayload { id: string; name: string; mode: 'family'; expiresAt?: number; pk: string; role: Role; memberName?: string }

export interface Vouch { circleId: string; pk: string; by: string; role?: Role; memberName?: string; createdAt: number; event: SignedEvent }

function parseJson(s: string): Record<string, unknown> | null {
  let raw: unknown
  try { raw = JSON.parse(s) } catch { return null }
  return raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Record<string, unknown>) : null
}

function parseInvitePayload(s: string): InvitePayload | null {
  const r = parseJson(s)
  if (!r) return null
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.name !== 'string' || !r.name) return null
  if (r.mode !== 'family') return null
  if (r.expiresAt !== undefined && typeof r.expiresAt !== 'number') return null
  if (typeof r.pk !== 'string' || !HEX64.test(r.pk)) return null
  if (typeof r.role !== 'string' || !ROLES.has(r.role)) return null
  if (r.memberName !== undefined && typeof r.memberName !== 'string') return null
  return {
    id: r.id, name: r.name, mode: 'family', pk: r.pk, role: r.role as Role,
    ...(typeof r.expiresAt === 'number' ? { expiresAt: r.expiresAt } : {}),
    ...(typeof r.memberName === 'string' ? { memberName: r.memberName } : {}),
  }
}

/** A verified vouch, or null. Accepts an `invite` naming its invitee or a
 *  hand-over `vouch`; never throws. Does not check the `prev` chain. */
export function verifyVouch(ev: unknown): Vouch | null {
  const s = verifyStructural(ev)
  if (!s) return null
  const base = { circleId: s.circleId, by: s.signerPk, createdAt: s.event.created_at, event: s.event }
  let v: Vouch
  if (s.action === 'invite') {
    const p = parseInvitePayload(s.payload)
    if (!p || p.id !== s.circleId) return null
    v = { ...base, pk: p.pk, role: p.role, ...(p.memberName !== undefined ? { memberName: p.memberName } : {}) }
  } else if (s.action === 'vouch') {
    const p = parseJson(s.payload)
    if (!p || typeof p.pk !== 'string' || !HEX64.test(p.pk)) return null
    v = { ...base, pk: p.pk }
  } else {
    return null
  }
  if (v.by === v.pk) return null
  return v
}

/** The hand-over `vouch` payload for `pk`. */
export function vouchPayload(pk: string): string {
  return JSON.stringify({ pk })
}

// Circle ids come from signed but untrusted tags, so every keyed access is
// own-property only: a circle called `__proto__` or `constructor` must not
// reach Object.prototype.

function own<T>(rec: Record<string, T>, k: string): T | undefined {
  return Object.hasOwn(rec, k) ? rec[k] : undefined
}

function ownOrCreate<T>(rec: Record<string, Record<string, T>>, k: string): Record<string, T> {
  const cur = own(rec, k)
  if (cur) return cur
  const fresh: Record<string, T> = {}
  Object.defineProperty(rec, k, { value: fresh, enumerable: true, writable: true, configurable: true })
  return fresh
}

/** True when `a` replaces `b` (newest wins, lower id on a tie). */
function newer(a: SignedEvent, b: SignedEvent): boolean {
  if (a.created_at !== b.created_at) return a.created_at > b.created_at
  return a.id < b.id
}

/** How far ahead of this device's clock a vouch may be dated. Without a
 *  bound, a far-future vouch would out-date every later hand-over. */
export const VOUCH_MAX_SKEW_SEC = 600

/** Stores a member's original `invite` vouch; true if stored. The event is
 *  re-verified and filed by its own signed circle and vouchee — `v`'s other
 *  fields are ignored. A hand-over is refused (final fix N1: it never goes
 *  in the member table), and so is one dated more than `VOUCH_MAX_SKEW_SEC`
 *  past `opts.nowSec` (default: the wall clock). Keeps the newest per
 *  (circle, vouchee), unless `opts.supersede` — the caller has a config
 *  that added the vouchee on this vouch, so it replaces the held one
 *  whatever its date. When stored, clears that member's unvouched mark. */
export function storeVouch(v: Vouch, opts: { supersede?: boolean; nowSec?: number } = {}): boolean {
  const ok = verifyVouch(v.event)
  if (!ok || ok.role === undefined) return false
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000)
  if (ok.createdAt > now + VOUCH_MAX_SKEW_SEC) return false
  let stored = false
  store.update((p) => {
    const circle = ownOrCreate(p.vouches, ok.circleId)
    const held = own(circle, ok.pk)
    if (held && !opts.supersede && !newer(ok.event, held)) return
    circle[ok.pk] = ok.event
    stored = true
    const marks = own(p.unvouchedSince, ok.circleId)
    if (marks) {
      delete marks[ok.pk]
      if (Object.keys(marks).length === 0) delete p.unvouchedSince[ok.circleId]
    }
  })
  return stored
}

/** The stored event under (circleId, pk), re-verified and matching its key.
 *  Only an `invite` counts (final fix N1): a hand-over left in the member
 *  table by an older build reads as absent. */
function held(p: Persisted, circleId: string, pk: string): Vouch | null {
  const circle = own(p.vouches, circleId)
  const ev = circle && own(circle, pk)
  if (!ev) return null
  const v = verifyVouch(ev)
  return v && v.circleId === circleId && v.pk === pk && v.role !== undefined ? v : null
}

/** Final review A, I1: drops `pk`'s vouch from `circleId`'s member table
 *  (they were removed; a returning member needs a new invite). Returns the
 *  event dropped, or null. */
export function dropVouch(circleId: string, pk: string): SignedEvent | null {
  let dropped: SignedEvent | null = null
  store.update((p) => {
    const circle = own(p.vouches, circleId)
    const ev = circle && own(circle, pk)
    if (!circle || !ev) return
    dropped = ev
    delete circle[pk]
    if (Object.keys(circle).length === 0) delete p.vouches[circleId]
    const marks = own(p.unvouchedSince, circleId)
    if (marks) delete marks[pk]
  })
  return dropped
}

/** `pk`'s original vouch in `circleId` (the invite that added them). */
export function vouchFor(circleId: string, pk: string): Vouch | null {
  return held(store.load(), circleId, pk)
}

/** Who added `pk` to `circleId` — their original voucher, still a member
 *  or not. Never a hand-over voucher (final fix N1). */
export function voucherOf(circleId: string, pk: string): string | null {
  return vouchFor(circleId, pk)?.by ?? null
}

/** The vouchees `voucherPk` originally added to `circleId`. */
export function vouchedBy(circleId: string, voucherPk: string): string[] {
  const p = store.load()
  return Object.keys(own(p.vouches, circleId) ?? {}).filter((pk) => held(p, circleId, pk)?.by === voucherPk)
}

/** Every valid stored vouch event for `circleId` (for config v2 to carry). */
export function allVouches(circleId: string): SignedEvent[] {
  const p = store.load()
  const out: SignedEvent[] = []
  for (const pk of Object.keys(own(p.vouches, circleId) ?? {})) {
    const v = held(p, circleId, pk)
    if (v) out.push(v.event)
  }
  return out
}

export function creatorOf(circleId: string): string | null {
  const c = own(store.load().circleCreators, circleId)
  return typeof c === 'string' && HEX64.test(c) ? c : null
}

/** Records the circle's creator once. False if `pk` is malformed or a
 *  different creator is already held (the same one again is true). */
export function setCreator(circleId: string, pk: string): boolean {
  if (!HEX64.test(pk)) return false
  let ok = false
  store.update((p) => {
    const cur = own(p.circleCreators, circleId)
    if (cur !== undefined && cur !== pk) return
    Object.defineProperty(p.circleCreators, circleId, { value: pk, enumerable: true, writable: true, configurable: true })
    ok = true
  })
  return ok
}

/** Marks `pk` unvouched in `circleId` from `nowSec`, unless already marked. */
export function markUnvouched(circleId: string, pk: string, nowSec: number): void {
  store.update((p) => {
    if (!HEX64.test(pk)) return
    const marks = ownOrCreate(p.unvouchedSince, circleId)
    if (own(marks, pk) !== undefined) return
    marks[pk] = nowSec
  })
}

/** Final fix N1: clears `pk`'s unvouched mark in `circleId` (a hand-over
 *  now keeps them vouched). */
export function clearUnvouched(circleId: string, pk: string): void {
  store.update((p) => {
    const marks = own(p.unvouchedSince, circleId)
    if (!marks || own(marks, pk) === undefined) return
    delete marks[pk]
    if (Object.keys(marks).length === 0) delete p.unvouchedSince[circleId]
  })
}

export function unvouchedSince(circleId: string, pk: string): number | null {
  const marks = own(store.load().unvouchedSince, circleId)
  return (marks && own(marks, pk)) ?? null
}

/** Pending invite vouches kept per circle (Task 5 fix round 1). */
export const PENDING_VOUCH_CAP = 50
/** Hand-overs kept per circle (final fix N1), counted apart from the
 *  invites so a flood of invites for throwaway keys can't evict one. */
export const HAND_OVER_CAP = 256

/** The pending list for `circleId`, own-property only. */
function pendingList(p: Persisted, circleId: string): SignedEvent[] {
  return own(p.pendingVouches, circleId) ?? []
}

/** Stores an invite vouch for someone not on the roster (Task 5 fix round
 *  1), or a hand-over for a member (final fix N1): kept apart from the
 *  member vouch table, one per (circle, vouchee, voucher, kind) — the
 *  newest of that key replaces the held one — and at most
 *  `PENDING_VOUCH_CAP` invites and `HAND_OVER_CAP` hand-overs per circle,
 *  the oldest stored of that kind evicted first. The event is re-verified
 *  and filed by its own signed fields; dated more than `VOUCH_MAX_SKEW_SEC`
 *  ahead it is refused. Whether the voucher may vouch is judged when the
 *  vouch is relied on. True if stored. */
export function storePendingVouch(v: Vouch, opts: { nowSec?: number } = {}): boolean {
  const ok = verifyVouch(v.event)
  if (!ok) return false
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000)
  if (ok.createdAt > now + VOUCH_MAX_SKEW_SEC) return false
  let stored = false
  store.update((p) => {
    const handOver = ok.role === undefined
    const list = [...pendingList(p, ok.circleId)]
    const kinds = list.map((ev) => verifyVouch(ev))
    const at = kinds.findIndex((h) => !!h && h.pk === ok.pk && h.by === ok.by && (h.role === undefined) === handOver)
    if (at >= 0) {
      if (!newer(ok.event, list[at]!)) return
      list.splice(at, 1)
      kinds.splice(at, 1)
    }
    list.push(ok.event)
    kinds.push(ok)
    const cap = handOver ? HAND_OVER_CAP : PENDING_VOUCH_CAP
    const sameKind = (h: Vouch | null): boolean => !!h && (h.role === undefined) === handOver
    for (let n = kinds.filter(sameKind).length; n > cap; n--) {
      const i = kinds.findIndex(sameKind)
      list.splice(i, 1)
      kinds.splice(i, 1)
    }
    Object.defineProperty(p.pendingVouches, ok.circleId, { value: list, enumerable: true, writable: true, configurable: true })
    stored = true
  })
  return stored
}

/** The pending vouches for `pk` in `circleId`, re-verified and matching. */
export function pendingVouchesFor(circleId: string, pk: string): Vouch[] {
  return pendingList(store.load(), circleId)
    .map((ev) => verifyVouch(ev))
    .filter((v): v is Vouch => !!v && v.circleId === circleId && v.pk === pk)
}

/** Final fix N1: the hand-overs held for `pk` in `circleId`. */
export function handOversFor(circleId: string, pk: string): Vouch[] {
  return pendingVouchesFor(circleId, pk).filter((v) => v.role === undefined)
}

/** Final fix N1: every hand-over held for `circleId` (for an invite bundle
 *  to carry). */
export function allHandOvers(circleId: string): Vouch[] {
  return pendingList(store.load(), circleId)
    .map((ev) => verifyVouch(ev))
    .filter((v): v is Vouch => !!v && v.circleId === circleId && v.role === undefined)
}

/** Drops every pending vouch for `pk` in `circleId` (they joined, and the
 *  vouch that put them on the roster is now in the member table; a
 *  hand-over from before they joined counts for nothing). */
export function dropPendingVouches(circleId: string, pk: string): void {
  store.update((p) => {
    const list = own(p.pendingVouches, circleId)
    if (!list) return
    const rest = list.filter((ev) => verifyVouch(ev)?.pk !== pk)
    if (rest.length) Object.defineProperty(p.pendingVouches, circleId, { value: rest, enumerable: true, writable: true, configurable: true })
    else delete p.pendingVouches[circleId]
  })
}

/** Drops every vouch (pending ones too), the creator and every unvouched
 *  mark for `circleId` (leaving or deleting the circle). */
export function forgetCircleVouches(circleId: string): void {
  store.update((p) => {
    delete p.vouches[circleId]
    delete p.circleCreators[circleId]
    delete p.unvouchedSince[circleId]
    delete p.pendingVouches[circleId]
  })
}
