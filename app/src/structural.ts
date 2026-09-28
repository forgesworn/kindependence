// Identity-signed "structural" inner events (Signet identity plan, Task 2):
// the circle-shaping signals (roster config, seed rotation, invites,
// family policy, approval responses, agreements, agreement deadline
// extensions, place definitions) move from phone-key circle traffic to
// identity-signed kind 30078 events, replay-protected by chaining each one
// to the circle epoch it was written against (`prev`, the hashed seed).
//
// `STRUCTURAL_ACTIONS` holds only the canonical action names below —
// senders emit these directly inside new structural events, so there's no
// legacy wire string to accept in parallel (that would just be two
// encodings of the same action). For Task 9's migrator, here's today's
// wire `t` -> new action mapping, found by reading each sending function:
//   config          circles.ts broadcastCreatedCircleConfig / handleJoinedRumor
//                   (no wire `t` today — CircleConfig is shape-discriminated
//                   over the personal inbox)
//   rekey           circles.ts removeMemberFromCircle, wire t: 'reseed'
//   invite          circles.ts doInvite, wire t: 'invite' (same string)
//   family-policy   approvals.ts publishFamilyPolicy, wire t: 'family-policy' (BROOD)
//   approval-resp   approvals.ts respondApproval, wire t: 'approval-resp' (BROOD)
//   agreement       agreements.ts proposeAgreement, wire t: 'agreement' (BROOD)
//   extend-resp     agreements.ts respondExtend, wire t: 'extend-resp' (BROOD)
//   places          places.ts savePlaces, wire t: 'places' (PLACES_SIGNAL_TYPE — Task 9
//                   moved this action's own migrator target VALUE from the
//                   legacy phone-signed 'kindependence-places' to 'places'; see
//                   places.ts's own doc comment on `PLACES_SIGNAL_TYPE`)
//   vouch           plan 2, Task 4: new, no legacy wire form — a member's
//                   hand-over vouch (vouches.ts; an `invite` naming its
//                   invitee is itself the adder's vouch)
// Not structural (decided): raiseApproval (a request, like agreement
// requests) and announceJoin (becomes the device-statement post, Task 7).

import type { EventTemplate, SignedEvent } from '@forgesworn/roost-kit'
import { sha256 } from '@noble/hashes/sha2.js'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { STATEMENT_KIND, verifySignedWire } from './device-statements.js'

const HEX64 = /^[0-9a-f]{64}$/

export type StructuralAction =
  | 'config'
  | 'rekey'
  | 'invite'
  | 'family-policy'
  | 'approval-resp'
  | 'agreement'
  | 'extend-resp'
  | 'places'
  | 'vouch'

const CANONICAL_ACTIONS: readonly StructuralAction[] = [
  'config',
  'rekey',
  'invite',
  'family-policy',
  'approval-resp',
  'agreement',
  'extend-resp',
  'places',
  'vouch',
]

export const STRUCTURAL_ACTIONS: ReadonlySet<string> = new Set<string>(CANONICAL_ACTIONS)

/** Hex sha256 of the seed bytes — the replay-protection chain link each
 *  structural event carries in its `prev` tag (the hash of the circle
 *  epoch's seed it was written against). */
export function seedHash(seedHex: string): string {
  return bytesToHex(sha256(hexToBytes(seedHex)))
}

export interface StructuralEvent {
  action: StructuralAction
  circleId: string
  prev: string
  payload: string
  signerPk: string
  event: SignedEvent
}

export function structuralTemplate(a: {
  action: StructuralAction
  circleId: string
  prevSeedHash: string
  payload: string
  nowSec: number
}): EventTemplate {
  return {
    kind: STATEMENT_KIND,
    created_at: a.nowSec,
    content: a.payload,
    tags: [
      ['d', `kindependence/struct/${a.action}`],
      ['circle', a.circleId],
      ['prev', a.prevSeedHash],
      ['t', a.action],
    ],
  }
}

export function verifyStructural(ev: unknown): StructuralEvent | null {
  if (!ev || typeof ev !== 'object') return null
  const pre = ev as SignedEvent
  if (pre.kind !== STATEMENT_KIND || !Array.isArray(pre.tags)) return null
  // Verify first (via the shared helper in device-statements.ts — see its
  // doc comment for why it's never `pre` itself), then read every field
  // below off the returned, verified wire object.
  const wire = verifySignedWire(pre)
  if (!wire || !Array.isArray(wire.tags)) return null
  const tag = (n: string): string | undefined => wire.tags.find((t) => Array.isArray(t) && t[0] === n)?.[1]
  const t = tag('t')
  const circleId = tag('circle')
  const prev = tag('prev')
  const d = tag('d')
  if (typeof t !== 'string' || !STRUCTURAL_ACTIONS.has(t)) return null
  if (typeof circleId !== 'string' || !circleId) return null
  if (typeof prev !== 'string' || !HEX64.test(prev)) return null
  if (d !== `kindependence/struct/${t}`) return null
  return { action: t as StructuralAction, circleId, prev, payload: wire.content, signerPk: wire.pubkey, event: wire }
}
