// Identity-signed device statements and revocations (Signet identity plan,
// Task 1): a kindependence identity key authorises ("statement") or
// withdraws authorisation from ("revocation") a phone key to send circle
// traffic on its behalf. Kind 30078 (NIP-78 app-scoped), one shape per
// purpose (statement vs revocation). These events are never published to
// relays — they travel and are verified locally (device pairing, later
// tasks) — so the `d` tag here is purely for type separation (letting
// `checked()` below tell "a device statement" from "a revocation" apart by
// namespace prefix, and binding it to the `p` tag it names), not a bid for
// NIP-33/NIP-78 replaceable-event semantics on any relay.
//
// Verification is signature + shape only — this module has no opinion on
// WHO the identity pubkey belongs to or WHERE the caller stores an
// accepted statement; that's the caller's (later task's) job.

import type { EventTemplate, SignedEvent } from '@forgesworn/roost-kit'
import { getEventHash, verifiedSymbol, verifyEvent } from 'nostr-tools/pure'

export const STATEMENT_KIND = 30078
export const CIRCLE_TRAFFIC_SCOPE = 'kindependence:circle-traffic'
export const DEVICE_STATEMENT_CONTENT = 'Authorise this phone to send Kindependence circle messages for me.'

const HEX64 = /^[0-9a-f]{64}$/

export interface DeviceStatement {
  identityPk: string
  phonePk: string
  scopes: string[]
  event: SignedEvent
}

export interface Revocation {
  signerPk: string
  phonePk: string
  event: SignedEvent
}

export function deviceStatementTemplate(phonePk: string, nowSec: number): EventTemplate {
  return {
    kind: STATEMENT_KIND,
    created_at: nowSec,
    content: DEVICE_STATEMENT_CONTENT,
    tags: [
      ['d', `kindependence/device/${phonePk}`],
      ['p', phonePk],
      ['scope', CIRCLE_TRAFFIC_SCOPE],
    ],
  }
}

export function revocationTemplate(phonePk: string, nowSec: number): EventTemplate {
  return {
    kind: STATEMENT_KIND,
    created_at: nowSec,
    content: 'Remove this phone from Kindependence.',
    tags: [
      ['d', `kindependence/revoke/${phonePk}`],
      ['p', phonePk],
    ],
  }
}

/** Signatures already verified (Task 5 fix round 1), as `pubkey:id:sig`, so
 *  re-judging a parked config doesn't re-run every Schnorr check. Only the
 *  signature verdict is cached: the id is always re-hashed from the event,
 *  so a cached id can't vouch for other content. Bounded, oldest first. */
export const SIG_CACHE_CAP = 4096
const sigVerified = new Set<string>()
let sigCacheCap = SIG_CACHE_CAP

/** Test seams: how many verdicts the cache holds; a smaller cap (none: the
 *  default). */
export function sigCacheSizeForTests(): number {
  return sigVerified.size
}
export function setSigCacheCapForTests(cap?: number): void {
  sigCacheCap = cap ?? SIG_CACHE_CAP
}

/** Verifies `e`'s signature against a freshly-built plain object containing
 *  only the seven wire fields (`id, pubkey, created_at, kind, tags, content,
 *  sig`) — never the caller-supplied object itself, and returns THAT object
 *  (never `e`) so callers read every verified field off a value they know
 *  hasn't been touched since the check ran.
 *
 *  Why not verify `e` directly: nostr-tools' `verifyEvent` caches its
 *  verdict on a well-known symbol property (`verifiedSymbol`, exported from
 *  `nostr-tools/pure`) it writes onto the event object it's given. Every
 *  verify function in this module and in structural.ts takes `ev: unknown`
 *  — untrusted input — and that symbol survives an object spread (`{...e}`
 *  copies own enumerable symbol-keyed properties too), so a tampered copy
 *  of a genuinely-signed event (exactly the shape a forger would build)
 *  would inherit a cached `true` and skip real verification entirely; an
 *  attacker could also just import the same exported symbol and set it
 *  directly. Building a fresh, symbol-free object before every call closes
 *  both paths. Shared by device-statements.ts and structural.ts — the one
 *  place this defence lives, so it can't drift between the two callers.
 *
 *  Never throws: `verifyEvent` is wrapped, so anything malformed (wrong
 *  types, a threw-during-hash pubkey, etc.) short-circuits to null. */
export function verifySignedWire(e: unknown): SignedEvent | null {
  if (!e || typeof e !== 'object') return null
  const ev = e as SignedEvent
  const wire: SignedEvent = {
    id: ev.id,
    pubkey: ev.pubkey,
    created_at: ev.created_at,
    kind: ev.kind,
    tags: ev.tags,
    content: ev.content,
    sig: ev.sig,
  }
  try {
    const k = `${wire.pubkey}:${wire.id}:${wire.sig}`
    if (sigVerified.has(k)) {
      if (getEventHash(wire as never) !== wire.id) return null
      // What `verifyEvent` itself marks on the fresh object it verified.
      ;(wire as unknown as Record<symbol, boolean>)[verifiedSymbol] = true
      return wire
    }
    if (!verifyEvent(wire as never)) return null
    sigVerified.add(k)
    while (sigVerified.size > sigCacheCap) sigVerified.delete(sigVerified.values().next().value!)
  } catch {
    return null
  }
  return wire
}

/** Shared shape/signature check for both statement and revocation: right
 *  kind, a valid signature (via `verifySignedWire` above), well-formed
 *  tags, a `p` that's a lowercase-hex pubkey, and a `d` that agrees with
 *  `p` under the given namespace prefix. Every field read below comes from
 *  the verified wire object, not the caller-supplied one. */
function checked(ev: unknown, prefix: string): { ev: SignedEvent; p: string } | null {
  if (!ev || typeof ev !== 'object') return null
  const pre = ev as SignedEvent
  if (pre.kind !== STATEMENT_KIND || !Array.isArray(pre.tags)) return null
  const wire = verifySignedWire(pre)
  if (!wire || !Array.isArray(wire.tags)) return null
  const tag = (n: string): string | undefined => wire.tags.find((t) => Array.isArray(t) && t[0] === n)?.[1]
  const p = tag('p')
  const d = tag('d')
  if (typeof p !== 'string' || !HEX64.test(p) || d !== `${prefix}${p}`) return null
  return { ev: wire, p }
}

export function verifyDeviceStatement(ev: unknown): DeviceStatement | null {
  const c = checked(ev, 'kindependence/device/')
  if (!c) return null
  const scopes = c.ev.tags.filter((t) => t[0] === 'scope' && typeof t[1] === 'string').map((t) => t[1] as string)
  if (!scopes.includes(CIRCLE_TRAFFIC_SCOPE)) return null
  return { identityPk: c.ev.pubkey, phonePk: c.p, scopes, event: c.ev }
}

export function verifyRevocation(ev: unknown): Revocation | null {
  const c = checked(ev, 'kindependence/revoke/')
  if (!c) return null
  return { signerPk: c.ev.pubkey, phonePk: c.p, event: c.ev }
}

// Plan 2, Task 3: guardian-link statements (spec §7). A guardian link is two
// identity-signed statements, both required — the guardian's "I am a
// guardian of D" and the dependant's "G is my guardian"; one alone proves
// nothing (anyone could claim a dependant). Either side ends the link with
// an unlink. Same kind, same never-published rule and same `d`/`p` binding
// as the device formats above; which of the three it is comes from the `d`
// namespace. Pairing the two statements and weighing unlinks is
// guardian-links.ts's job — this only checks one statement's shape and
// signature.

export const GUARDIAN_OF_CONTENT = 'I am a guardian of this person in Kindependence.'
export const DEPENDANT_OF_CONTENT = 'This person is my guardian in Kindependence.'

export interface LinkStatement {
  kind: 'guardian-of' | 'dependant-of' | 'unlink'
  signerPk: string
  otherPk: string
  createdAt: number
  event: SignedEvent
}

const LINK_PREFIXES: Record<string, LinkStatement['kind']> = {
  'kindependence/dependant/': 'guardian-of',
  'kindependence/guardian/': 'dependant-of',
  'kindependence/unlink/': 'unlink',
}

function linkTemplate(prefix: string, otherPk: string, content: string, nowSec: number): EventTemplate {
  return {
    kind: STATEMENT_KIND,
    created_at: nowSec,
    content,
    tags: [
      ['d', `${prefix}${otherPk}`],
      ['p', otherPk],
    ],
  }
}

/** Signed by the guardian, naming the dependant. */
export function guardianOfTemplate(dependantPk: string, nowSec: number): EventTemplate {
  return linkTemplate('kindependence/dependant/', dependantPk, GUARDIAN_OF_CONTENT, nowSec)
}

/** Signed by the dependant, naming the guardian. */
export function dependantOfTemplate(guardianPk: string, nowSec: number): EventTemplate {
  return linkTemplate('kindependence/guardian/', guardianPk, DEPENDANT_OF_CONTENT, nowSec)
}

/** Signed by either side, naming the other. */
export function unlinkTemplate(otherPk: string, nowSec: number): EventTemplate {
  return linkTemplate('kindependence/unlink/', otherPk, 'End this guardian link in Kindependence.', nowSec)
}

/** A guardian-of, dependant-of or unlink statement, or null. The namespace
 *  is picked from the unverified `d` tag only to choose the prefix; `checked`
 *  then re-reads `d` off the verified wire and requires it to equal that
 *  prefix + `p`, so a mismatch still fails. Content is not checked (as with
 *  the device formats — it's covered by the signature, not by meaning). */
export function verifyLinkStatement(ev: unknown): LinkStatement | null {
  if (!ev || typeof ev !== 'object') return null
  const tags = (ev as { tags?: unknown }).tags
  if (!Array.isArray(tags)) return null
  const d = tags.find((t) => Array.isArray(t) && t[0] === 'd')?.[1]
  if (typeof d !== 'string') return null
  const match = Object.entries(LINK_PREFIXES).find(([pre]) => d.startsWith(pre))
  if (!match) return null
  const [prefix, kind] = match
  const c = checked(ev, prefix)
  if (!c) return null
  if (!HEX64.test(c.ev.pubkey) || c.ev.pubkey === c.p || !Number.isSafeInteger(c.ev.created_at)) return null
  return { kind, signerPk: c.ev.pubkey, otherPk: c.p, createdAt: c.ev.created_at, event: c.ev }
}
