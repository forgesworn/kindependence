// Guardian-link table (plan 2, Task 3; spec §7). A guardian link between
// guardian G and dependant D exists only when BOTH identity-signed
// statements are held — G's guardian-of naming D and D's dependant-of naming
// G (device-statements.ts). One alone proves nothing: anyone can claim a
// dependant.
//
// Trust rules enforced here:
// - Roles come from the statements, never from the caller: `g` must be a
//   guardian-of signed by G, `d` a dependant-of signed by D, and each must
//   name the other's signer.
// - Either side ends the link with an unlink naming the other. The newest
//   unlink per signer→other is kept. G and D are linked only while both
//   statements of the stored pair are strictly newer (created_at) than
//   every unlink between them, in either direction — an unlink dated the
//   same second as a statement wins (conservative). So an unlink holds
//   until a new pair is made after it (spec: "permanent until a new pair
//   is made in person"), and a replayed pre-unlink pair can't revive it.
// - A pair older than the stored one is ignored, so a replay can't swap a
//   newer link for an older one that a later-arriving unlink would break.
//
// Wire (posting/receiving `t: 'link'` rumors is Tasks 5 and 7, not this
// module): this only accepts statements it's handed and answers `linked`.

import type { SignedEvent } from '@forgesworn/roost-kit'
import * as store from './store.js'
import type { Persisted } from './store.js'
import { verifyLinkStatement } from './device-statements.js'
import type { LinkCheck } from './contacts.js'

type LinkListener = (guardianPk: string, dependantPk: string, linked: boolean) => void
const listeners = new Set<LinkListener>()

/** Subscribes to link flips: `linked(g, d)` becoming true (a new accepted
 *  pair) or false (an accepted unlink that breaks a link). Returns an
 *  unsubscribe function. A throwing listener is isolated from the others. */
export function onLinkChange(cb: LinkListener): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

function fire(guardianPk: string, dependantPk: string, isLinked: boolean): void {
  for (const l of [...listeners]) {
    try { l(guardianPk, dependantPk, isLinked) } catch { /* isolated */ }
  }
}

/** The created_at of the newest unlink between `a` and `b` (either signer),
 *  or -Infinity if none. */
function lastUnlinkAt(p: Persisted, a: string, b: string): number {
  let at = -Infinity
  for (const k of [`${a}:${b}`, `${b}:${a}`]) {
    const u = p.unlinks[k]
    if (u && u.created_at > at) at = u.created_at
  }
  return at
}

function isLinked(p: Persisted, guardianPk: string, dependantPk: string): boolean {
  const pair = p.guardianLinks[`${guardianPk}:${dependantPk}`]
  if (!pair) return false
  const cutoff = lastUnlinkAt(p, guardianPk, dependantPk)
  return pair.g.created_at > cutoff && pair.d.created_at > cutoff
}

/** Accepts a guardian-of (`g`) / dependant-of (`d`) pair. True when both
 *  verify, name each other, are newer than any unlink between the two, and
 *  are not older than an already-stored pair (then stored). */
export function acceptLinkPair(g: unknown, d: unknown): boolean {
  const vg = verifyLinkStatement(g)
  const vd = verifyLinkStatement(d)
  if (!vg || vg.kind !== 'guardian-of' || !vd || vd.kind !== 'dependant-of') return false
  if (vg.signerPk !== vd.otherPk || vd.signerPk !== vg.otherPk) return false
  const G = vg.signerPk
  const D = vd.signerPk
  let accepted = false
  let flipped = false
  store.update((p) => {
    const cutoff = lastUnlinkAt(p, G, D)
    if (vg.createdAt <= cutoff || vd.createdAt <= cutoff) return
    const key = `${G}:${D}`
    const held = p.guardianLinks[key]
    if (held && Math.min(vg.createdAt, vd.createdAt) < Math.min(held.g.created_at, held.d.created_at)) return
    const before = isLinked(p, G, D)
    p.guardianLinks[key] = { g: vg.event, d: vd.event }
    accepted = true
    flipped = !before
  })
  if (flipped) fire(G, D, true)
  return accepted
}

/** Accepts an unlink; keeps the newest per signer→other. True when valid
 *  (even if an equal-or-newer one was already held). */
export function acceptUnlink(ev: unknown): boolean {
  const v = verifyLinkStatement(ev)
  if (!v || v.kind !== 'unlink') return false
  const a = v.signerPk
  const b = v.otherPk
  const broken: Array<[string, string]> = []
  store.update((p) => {
    const key = `${a}:${b}`
    const held = p.unlinks[key]
    if (held && held.created_at >= v.createdAt) return
    const was: Array<[string, string]> = ([[a, b], [b, a]] as Array<[string, string]>).filter(([g, d]) => isLinked(p, g, d))
    p.unlinks[key] = v.event
    for (const [g, d] of was) if (!isLinked(p, g, d)) broken.push([g, d])
  })
  for (const [g, d] of broken) fire(g, d, false)
  return true
}

export function linked(guardianPk: string, dependantPk: string): boolean {
  return isLinked(store.load(), guardianPk, dependantPk)
}

export function dependantsOf(guardianPk: string): string[] {
  const p = store.load()
  const prefix = `${guardianPk}:`
  return Object.keys(p.guardianLinks)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length))
    .filter((d) => isLinked(p, guardianPk, d))
}

export function guardiansOf(dependantPk: string): string[] {
  const p = store.load()
  const suffix = `:${dependantPk}`
  return Object.keys(p.guardianLinks)
    .filter((k) => k.endsWith(suffix))
    .map((k) => k.slice(0, -suffix.length))
    .filter((g) => isLinked(p, g, dependantPk))
}

/** Final review A, I6: the held unlinks whose signer and other are both in
 *  `pks`, re-verified, newest first, at most `cap` — carried in invite
 *  bundles and re-posted when a member is added, so a later joiner holds
 *  the cut-off and a pre-unlink pair can't revive the link there. */
export function unlinksBetween(pks: ReadonlySet<string>, cap: number): SignedEvent[] {
  const out: Array<{ ev: SignedEvent; at: number }> = []
  for (const ev of Object.values(store.load().unlinks)) {
    const v = verifyLinkStatement(ev)
    if (v && v.kind === 'unlink' && pks.has(v.signerPk) && pks.has(v.otherPk)) out.push({ ev: v.event, at: v.createdAt })
  }
  return out.sort((a, b) => b.at - a.at).slice(0, cap).map((x) => x.ev)
}

/** The stored statement pair proving the link, or null when not linked. */
export function linkEvents(guardianPk: string, dependantPk: string): { g: SignedEvent; d: SignedEvent } | null {
  const p = store.load()
  return isLinked(p, guardianPk, dependantPk) ? p.guardianLinks[`${guardianPk}:${dependantPk}`] ?? null : null
}

/** A contacts.ts `LinkCheck`: linked with `selfPk` in either role. */
export function linkedWithMe(selfPk: string): LinkCheck {
  return (pk) => linked(selfPk, pk) || linked(pk, selfPk)
}
