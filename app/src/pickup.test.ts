import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PICKUP_PREFIX,
  MAX_PICKUP_RECORDS,
  buildPickupReason,
  parsePickupReason,
  pickupRecordId,
  applyPickupSignal,
  openPickupRecord,
  actionsFor,
  shouldSendSeen,
  buildPickupWrap,
  phaseActivityId,
  handleIncomingPickupSignal,
  type PickupRecord,
  type PickupSignal,
  type PickupPhase,
} from './pickup.js'
import { buildPreciseRequestReasonText } from './messages.js'
import * as store from './store.js'
import { sessionForTests } from './session.js'
import { makeLocalSigner, deriveInbox, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftUnwrap, rawNip44Decrypt } from '@forgesworn/roost-kit'
import type { Rumor } from '@forgesworn/roost-kit'
import { decodeLegacyBuzz, KINDEPENDENCE_MSG_SIGNAL_TYPE } from './legacy-buzz.js'
import { notify } from './notify.js'
import { generateSecretKey } from 'nostr-tools/pure'

// Partial-mock notify (same idiom as places.test.ts/journey.test.ts) so the
// freshness-gate block below can assert which incoming phases actually raise
// a system notification. `shouldNotifyForEvent` stays real.
vi.mock('./notify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notify.js')>()
  return { ...actual, notify: vi.fn(async () => {}) }
})

/** Minimal in-memory localStorage stand-in (mirrors meet.test.ts's/
 *  places.test.ts's own — needed only by the `handleIncomingPickupSignal`
 *  describe block below, which reads/writes `store` state). */
function fakeLocalStorage(): Storage {
  const mem = new Map<string, string>()
  return {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
    removeItem: (k: string) => { mem.delete(k) },
    clear: () => mem.clear(),
    key: () => null,
    get length() { return mem.size },
  } as unknown as Storage
}

/** Signs this device in for a test, using a fresh real phone key (Signet
 *  identity plan) — `identityPk` is the signed-in identity. */
function signIn(identityPk: string, dependant = false): void {
  sessionForTests({ identityPk, phoneSkHex: toHex(generateSecretKey()), dependant })
}

const PK_GUARDIAN = 'a'.repeat(64)
const PK_CHILD = 'b'.repeat(64)
const PK_OTHER = 'c'.repeat(64)
const CIRCLE_ID = 'circle-1'

function fakeCircle(overrides: Partial<Circle> = {}): Circle {
  return {
    id: CIRCLE_ID, name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
    members: [
      { pk: PK_GUARDIAN, role: 'guardian', name: 'Alex' },
      { pk: PK_CHILD, role: 'child', name: 'Bailey' },
    ],
    createdAt: 100, configUpdatedAt: 100, configBy: PK_GUARDIAN,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// buildPickupReason / parsePickupReason
// ---------------------------------------------------------------------------

describe('PICKUP_PREFIX', () => {
  it('is the documented wire prefix', () => {
    expect(PICKUP_PREFIX).toBe('!pickup:')
  })
})

describe('buildPickupReason / parsePickupReason — round trip', () => {
  it('round-trips a phase with no extra', () => {
    const text = buildPickupReason('accepted')
    expect(text).toBe('!pickup:accepted')
    expect(parsePickupReason(text)).toEqual({ phase: 'accepted' })
  })

  it('round-trips a phase with an extra object', () => {
    const text = buildPickupReason('on-way', { id: 'pickup-request-1000-circle-1', etaMin: 12 })
    expect(parsePickupReason(text)).toEqual({ phase: 'on-way', extra: { id: 'pickup-request-1000-circle-1', etaMin: 12 } })
  })

  it('round-trips a suggestion payload', () => {
    const text = buildPickupReason('suggested', { id: 'r1', suggest: { name: 'Library', lat: 51.5, lon: -0.1 } })
    expect(parsePickupReason(text)).toEqual({ phase: 'suggested', extra: { id: 'r1', suggest: { name: 'Library', lat: 51.5, lon: -0.1 } } })
  })

  it('round-trips a name-only suggestion payload (final-review fix 4a: coords are optional, this app never sends them)', () => {
    const text = buildPickupReason('suggested', { id: 'r1', suggest: { name: 'Library' } })
    expect(parsePickupReason(text)).toEqual({ phase: 'suggested', extra: { id: 'r1', suggest: { name: 'Library' } } })
  })

  it('every declared PickupPhase round-trips', () => {
    const phases: PickupPhase[] = ['requested', 'offered', 'seen', 'accepted', 'on-way', 'collected', 'declined', 'suggested']
    for (const phase of phases) {
      expect(parsePickupReason(buildPickupReason(phase, { id: 'r1' }))).toEqual({ phase, extra: { id: 'r1' } })
    }
  })
})

describe('parsePickupReason — malformed input never throws, returns null', () => {
  it('rejects text without the prefix', () => {
    expect(parsePickupReason('accepted')).toBeNull()
    expect(parsePickupReason('Dinner ready')).toBeNull()
  })

  it('rejects an unrecognised phase word', () => {
    expect(parsePickupReason('!pickup:bogus-phase')).toBeNull()
    expect(parsePickupReason('!pickup:')).toBeNull()
  })

  it('rejects a broken JSON tail', () => {
    expect(() => parsePickupReason('!pickup:accepted:{not json')).not.toThrow()
    expect(parsePickupReason('!pickup:accepted:{not json')).toBeNull()
  })

  it('rejects a JSON tail that is not a plain object (strict JSON tail)', () => {
    expect(parsePickupReason('!pickup:accepted:"a string"')).toBeNull()
    expect(parsePickupReason('!pickup:accepted:42')).toBeNull()
    expect(parsePickupReason('!pickup:accepted:[1,2,3]')).toBeNull()
    expect(parsePickupReason('!pickup:accepted:null')).toBeNull()
  })

  it('is distinguishable from messages.ts\'s "!precise-request:" prefix — never collides', () => {
    const preciseText = buildPreciseRequestReasonText('Meeting you')
    expect(parsePickupReason(preciseText)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// pickupRecordId
// ---------------------------------------------------------------------------

describe('pickupRecordId', () => {
  it('is deterministic and independently derivable from (direction, at, circleId) alone', () => {
    expect(pickupRecordId('request', 1000, CIRCLE_ID)).toBe(pickupRecordId('request', 1000, CIRCLE_ID))
  })

  it('distinguishes direction, at, and circleId', () => {
    const base = pickupRecordId('request', 1000, CIRCLE_ID)
    expect(pickupRecordId('offer', 1000, CIRCLE_ID)).not.toBe(base)
    expect(pickupRecordId('request', 2000, CIRCLE_ID)).not.toBe(base)
    expect(pickupRecordId('request', 1000, 'circle-2')).not.toBe(base)
  })
})

// ---------------------------------------------------------------------------
// applyPickupSignal — exhaustive forward-only state machine matrix
// ---------------------------------------------------------------------------

function sig(overrides: Partial<PickupSignal> & Pick<PickupSignal, 'id' | 'phase' | 'direction'>): PickupSignal {
  return { circleId: CIRCLE_ID, childPk: PK_CHILD, collectorPk: PK_GUARDIAN, at: 1000, ...overrides }
}

/** Walks the canonical path from creation to exactly `phase`, applying only
 *  legal, adjacent, forward transitions — the test's own independent way of
 *  reaching a given starting state without depending on `applyPickupSignal`
 *  accepting a skip (kept separate from the "skips are legal" assertions
 *  below, which test that behaviour directly instead). */
function seedAt(direction: 'request' | 'offer', phase: PickupPhase, id = 'r1'): PickupRecord[] {
  const mainOrder: PickupPhase[] = direction === 'request'
    ? ['requested', 'seen', 'accepted', 'on-way', 'collected']
    : ['offered', 'seen', 'accepted', 'on-way', 'collected']
  let records: PickupRecord[] = []
  if (phase === 'declined' || phase === 'suggested') {
    records = seedAt(direction, 'accepted', id) // any pre-collected main phase works; 'accepted' is representative
    return applyPickupSignal(records, sig({ id, direction, phase, at: 2000 }))
  }
  const upTo = mainOrder.indexOf(phase)
  for (let i = 0; i <= upTo; i++) {
    records = applyPickupSignal(records, sig({ id, direction, phase: mainOrder[i] as PickupPhase, at: 1000 + i }))
  }
  return records
}

const ALL_PHASES: PickupPhase[] = ['requested', 'offered', 'seen', 'accepted', 'on-way', 'collected', 'declined', 'suggested']

describe('applyPickupSignal — creation', () => {
  it('creates a fresh record at direction\'s own initial phase', () => {
    const records = applyPickupSignal([], sig({ id: 'r1', direction: 'request', phase: 'requested' }))
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({ id: 'r1', phase: 'requested', direction: 'request', childPk: PK_CHILD, collectorPk: PK_GUARDIAN })
  })

  it('creates a fresh offer-direction record at "offered"', () => {
    const records = applyPickupSignal([], sig({ id: 'r1', direction: 'offer', phase: 'offered' }))
    expect(records[0]?.phase).toBe('offered')
  })

  it('does NOT create a record for a non-initial phase with nothing existing (no-op, same reference)', () => {
    const empty: PickupRecord[] = []
    for (const phase of ALL_PHASES) {
      if (phase === 'requested') continue // this IS the initial phase for 'request'
      expect(applyPickupSignal(empty, sig({ id: 'r1', direction: 'request', phase }))).toBe(empty)
    }
  })

  it('does not create an "offered" record under the "request" direction, or vice versa', () => {
    const empty: PickupRecord[] = []
    expect(applyPickupSignal(empty, sig({ id: 'r1', direction: 'request', phase: 'offered' }))).toBe(empty)
    expect(applyPickupSignal(empty, sig({ id: 'r1', direction: 'offer', phase: 'requested' }))).toBe(empty)
  })
})

describe('applyPickupSignal — forward-only transition matrix (both directions, every phase pair)', () => {
  // Independent oracle, restated from the task contract rather than mirrored
  // from the implementation: for each STARTING phase, which of the 8 phases
  // is a legal next step. 'INITIAL' below stands in for whichever of
  // 'requested'/'offered' this direction's own creation phase is.
  const LEGAL_FROM: Record<string, Set<PickupPhase | 'INITIAL'>> = {
    INITIAL: new Set(['seen', 'accepted', 'on-way', 'collected', 'declined', 'suggested']),
    seen: new Set(['accepted', 'on-way', 'collected', 'declined', 'suggested']),
    accepted: new Set(['on-way', 'collected', 'declined', 'suggested']),
    'on-way': new Set(['collected', 'declined', 'suggested']),
    collected: new Set([]), // terminal
    declined: new Set([]), // terminal
    suggested: new Set(['accepted', 'declined', 'suggested']),
  }

  const directions: Array<'request' | 'offer'> = ['request', 'offer']
  for (const direction of directions) {
    const initial: PickupPhase = direction === 'request' ? 'requested' : 'offered'
    const otherInitial: PickupPhase = direction === 'request' ? 'offered' : 'requested'
    const startPhases: PickupPhase[] = [initial, 'seen', 'accepted', 'on-way', 'collected', 'declined', 'suggested']

    for (const start of startPhases) {
      const legalSet = LEGAL_FROM[start === initial ? 'INITIAL' : start] as Set<PickupPhase>
      describe(`direction=${direction}, current phase="${start}"`, () => {
        for (const next of ALL_PHASES) {
          // `legalSet` never contains the literal 'requested'/'offered' string
          // for either direction, so a backward move to either initial phase
          // (this direction's own, or the other direction's) is always
          // excluded — `otherInitial` is asserted anyway for documentation.
          const expectedLegal = next !== otherInitial && legalSet.has(next)
          it(`${next === start ? '(duplicate) ' : ''}-> "${next}" is ${expectedLegal ? 'LEGAL' : 'a no-op'}`, () => {
            const seeded = seedAt(direction, start, 'r1')
            const result = applyPickupSignal(seeded, sig({ id: 'r1', direction, phase: next, at: 9999 }))
            if (expectedLegal) {
              expect(result).not.toBe(seeded)
              expect(result[0]?.phase).toBe(next)
              expect(result[0]?.at).toBe(9999)
            } else {
              expect(result).toBe(seeded) // same reference — the no-op contract
            }
          })
        }
      })
    }
  }
})

describe('applyPickupSignal — field carry-over and eta/suggest scoping', () => {
  it('carries collectorPk forward once set, even when a later signal omits it', () => {
    let records = applyPickupSignal([], sig({ id: 'r1', direction: 'request', phase: 'requested', collectorPk: PK_GUARDIAN }))
    records = applyPickupSignal(records, sig({ id: 'r1', direction: 'request', phase: 'seen', collectorPk: undefined, at: 1001 }))
    expect(records[0]?.collectorPk).toBe(PK_GUARDIAN)
  })

  it('sets etaMin only on the "on-way" signal, and keeps the last-known value on later phases', () => {
    let records = seedAt('request', 'accepted', 'r1')
    records = applyPickupSignal(records, sig({ id: 'r1', direction: 'request', phase: 'on-way', etaMin: 14, at: 2001 }))
    expect(records[0]?.etaMin).toBe(14)
    records = applyPickupSignal(records, sig({ id: 'r1', direction: 'request', phase: 'collected', at: 2002 }))
    expect(records[0]?.etaMin).toBe(14) // kept, not cleared
  })

  it('ignores an etaMin carried on a non-"on-way" signal', () => {
    const records = applyPickupSignal([], sig({ id: 'r1', direction: 'request', phase: 'requested', etaMin: 99 }))
    expect(records[0]?.etaMin).toBeUndefined()
  })

  it('sets suggest only on the "suggested" signal, and keeps it across a subsequent re-accept', () => {
    let records = seedAt('offer', 'offered', 'r1')
    records = applyPickupSignal(records, sig({ id: 'r1', direction: 'offer', phase: 'suggested', suggest: { name: 'Park gate', lat: 1, lon: 2 }, at: 2001 }))
    expect(records[0]?.suggest).toEqual({ name: 'Park gate', lat: 1, lon: 2 })
    records = applyPickupSignal(records, sig({ id: 'r1', direction: 'offer', phase: 'accepted', at: 2002 }))
    expect(records[0]?.suggest).toEqual({ name: 'Park gate', lat: 1, lon: 2 })
  })

  it('carries a name-only suggest (final-review fix 4a: this app never attaches coords)', () => {
    let records = seedAt('offer', 'offered', 'r1')
    records = applyPickupSignal(records, sig({ id: 'r1', direction: 'offer', phase: 'suggested', suggest: { name: 'Park gate' }, at: 2001 }))
    expect(records[0]?.suggest).toEqual({ name: 'Park gate' })
  })

  it('a direction mismatch against an existing record of the same id is a no-op (defensive)', () => {
    const records = seedAt('request', 'requested', 'r1')
    const result = applyPickupSignal(records, sig({ id: 'r1', direction: 'offer', phase: 'seen', at: 2000 }))
    expect(result).toBe(records)
  })

  it('preserves seenSent across an unrelated transition', () => {
    let records = seedAt('request', 'requested', 'r1')
    records = records.map((r) => ({ ...r, seenSent: true }))
    records = applyPickupSignal(records, sig({ id: 'r1', direction: 'request', phase: 'seen', at: 2000 }))
    expect(records[0]?.seenSent).toBe(true)
  })
})

describe('applyPickupSignal — cap at MAX_PICKUP_RECORDS (20)', () => {
  it('drops the oldest-untouched record once over the cap', () => {
    let records: PickupRecord[] = []
    for (let i = 0; i < 25; i++) {
      records = applyPickupSignal(records, sig({ id: `r${i}`, direction: 'request', phase: 'requested', circleId: `c${i}`, at: i }))
    }
    expect(records).toHaveLength(MAX_PICKUP_RECORDS)
    expect(records.some((r) => r.id === 'r0')).toBe(false)
    expect(records.some((r) => r.id === 'r24')).toBe(true)
  })
})

describe('openPickupRecord', () => {
  it('is equivalent to applyPickupSignal at the direction\'s own initial phase', () => {
    const viaOpen = openPickupRecord([], { id: 'r1', circleId: CIRCLE_ID, childPk: PK_CHILD, collectorPk: PK_GUARDIAN, direction: 'request', at: 1000 })
    const viaApply = applyPickupSignal([], sig({ id: 'r1', direction: 'request', phase: 'requested' }))
    expect(viaOpen).toEqual(viaApply)
  })

  it('is a no-op if a record with that id already exists (idempotent re-open)', () => {
    const opened = openPickupRecord([], { id: 'r1', circleId: CIRCLE_ID, childPk: PK_CHILD, collectorPk: PK_GUARDIAN, direction: 'offer', at: 1000 })
    const reopened = openPickupRecord(opened, { id: 'r1', circleId: CIRCLE_ID, childPk: PK_CHILD, collectorPk: PK_GUARDIAN, direction: 'offer', at: 5000 })
    expect(reopened).toBe(opened)
  })
})

// ---------------------------------------------------------------------------
// actionsFor — per (direction, phase, role) matrix
// ---------------------------------------------------------------------------

function record(overrides: Partial<PickupRecord> = {}): PickupRecord {
  return { id: 'r1', circleId: CIRCLE_ID, childPk: PK_CHILD, collectorPk: PK_GUARDIAN, phase: 'requested', at: 1000, direction: 'request', ...overrides }
}

describe('actionsFor — request direction (guardian = collector, drives the lifecycle)', () => {
  const collectablePhases: PickupPhase[] = ['requested', 'seen', 'suggested']
  for (const phase of collectablePhases) {
    it(`collector sees accept+decline at phase "${phase}"`, () => {
      expect(actionsFor(record({ phase }), PK_GUARDIAN, 'guardian')).toEqual(['accept', 'decline'])
    })
  }
  it('collector sees on-way+decline once accepted', () => {
    expect(actionsFor(record({ phase: 'accepted' }), PK_GUARDIAN, 'guardian')).toEqual(['on-way', 'decline'])
  })
  it('collector sees collected+decline once on-way', () => {
    expect(actionsFor(record({ phase: 'on-way' }), PK_GUARDIAN, 'guardian')).toEqual(['collected', 'decline'])
  })
  it('collector has no actions once collected or declined', () => {
    expect(actionsFor(record({ phase: 'collected' }), PK_GUARDIAN, 'guardian')).toEqual([])
    expect(actionsFor(record({ phase: 'declined' }), PK_GUARDIAN, 'guardian')).toEqual([])
  })

  const everyNonTerminal: PickupPhase[] = ['requested', 'seen', 'accepted', 'on-way', 'suggested']
  for (const phase of everyNonTerminal) {
    it(`child (requester) may only decline (cancel) at phase "${phase}"`, () => {
      expect(actionsFor(record({ phase }), PK_CHILD, 'child')).toEqual(['decline'])
    })
  }
  it('child has no actions once collected or declined', () => {
    expect(actionsFor(record({ phase: 'collected' }), PK_CHILD, 'child')).toEqual([])
    expect(actionsFor(record({ phase: 'declined' }), PK_CHILD, 'child')).toEqual([])
  })

  it('a bystander (neither party) has no actions at any phase', () => {
    for (const phase of ALL_PHASES) {
      if (phase === 'offered') continue
      expect(actionsFor(record({ phase }), PK_OTHER, 'guardian')).toEqual([])
      expect(actionsFor(record({ phase }), PK_OTHER, 'child')).toEqual([])
    }
  })

  it('a role mismatch against a pk match is treated as a bystander (defensive cross-check)', () => {
    // childPk === selfPk but tagged 'guardian' — never grants the collector's
    // action set just because the pk happens to match.
    expect(actionsFor(record({ phase: 'requested' }), PK_CHILD, 'guardian')).toEqual([])
    // collectorPk === selfPk but tagged 'child'.
    expect(actionsFor(record({ phase: 'requested' }), PK_GUARDIAN, 'child')).toEqual([])
  })
})

describe('actionsFor — offer direction (guardian = offerer/collector; child accepts/declines/suggests)', () => {
  const offerRecord = (overrides: Partial<PickupRecord> = {}) => record({ direction: 'offer', phase: 'offered', ...overrides })

  it('child sees accept+decline+suggest while offered/seen, awaiting a response', () => {
    expect(actionsFor(offerRecord({ phase: 'offered' }), PK_CHILD, 'child')).toEqual(['accept', 'decline', 'suggest'])
    expect(actionsFor(offerRecord({ phase: 'seen' }), PK_CHILD, 'child')).toEqual(['accept', 'decline', 'suggest'])
  })
  it('child may only decline once suggested/accepted/on-way (already made their move)', () => {
    expect(actionsFor(offerRecord({ phase: 'suggested' }), PK_CHILD, 'child')).toEqual(['decline'])
    expect(actionsFor(offerRecord({ phase: 'accepted' }), PK_CHILD, 'child')).toEqual(['decline'])
    expect(actionsFor(offerRecord({ phase: 'on-way' }), PK_CHILD, 'child')).toEqual(['decline'])
  })
  it('child has no actions once collected/declined', () => {
    expect(actionsFor(offerRecord({ phase: 'collected' }), PK_CHILD, 'child')).toEqual([])
    expect(actionsFor(offerRecord({ phase: 'declined' }), PK_CHILD, 'child')).toEqual([])
  })

  it('collector/offerer may only decline (withdraw) while waiting on the child', () => {
    expect(actionsFor(offerRecord({ phase: 'offered' }), PK_GUARDIAN, 'guardian')).toEqual(['decline'])
    expect(actionsFor(offerRecord({ phase: 'seen' }), PK_GUARDIAN, 'guardian')).toEqual(['decline'])
  })
  it('collector may re-accept a suggestion (task contract: "suggested -> collector may re-accept")', () => {
    expect(actionsFor(offerRecord({ phase: 'suggested' }), PK_GUARDIAN, 'guardian')).toEqual(['accept', 'decline'])
  })
  it('collector drives on-way/collected once accepted', () => {
    expect(actionsFor(offerRecord({ phase: 'accepted' }), PK_GUARDIAN, 'guardian')).toEqual(['on-way', 'decline'])
    expect(actionsFor(offerRecord({ phase: 'on-way' }), PK_GUARDIAN, 'guardian')).toEqual(['collected', 'decline'])
  })
})

// ---------------------------------------------------------------------------
// shouldSendSeen
// ---------------------------------------------------------------------------

describe('shouldSendSeen — the once-per-record auto-"seen" guard', () => {
  it('is true for the child, at the creation phase, when not yet sent', () => {
    expect(shouldSendSeen(record({ phase: 'requested' }), PK_CHILD)).toBe(true)
    expect(shouldSendSeen(record({ direction: 'offer', phase: 'offered' }), PK_CHILD)).toBe(true)
  })

  it('is false once already sent (persisted guard)', () => {
    expect(shouldSendSeen(record({ phase: 'requested', seenSent: true }), PK_CHILD)).toBe(false)
  })

  it('is false for the collector — only the child (recipient) auto-sends "seen"', () => {
    expect(shouldSendSeen(record({ phase: 'requested' }), PK_GUARDIAN)).toBe(false)
  })

  it('is false once the record has moved past requested/offered', () => {
    expect(shouldSendSeen(record({ phase: 'seen' }), PK_CHILD)).toBe(false)
    expect(shouldSendSeen(record({ phase: 'accepted' }), PK_CHILD)).toBe(false)
  })

  it('is false for a bystander (pk matches neither party)', () => {
    expect(shouldSendSeen(record({ phase: 'requested' }), PK_OTHER)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildPickupWrap — wire round trip (same "build -> giftWrap -> giftUnwrap ->
// decode, without a relay" pattern as safety.ts/messages.ts's own pairs)
// ---------------------------------------------------------------------------

async function unwrapPickup(wrap: Awaited<ReturnType<typeof buildPickupWrap>>, circle: Circle): Promise<Rumor> {
  const inbox = deriveInbox(circle.seedHex)
  const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), wrap)
  expect(rumor).not.toBeNull()
  return rumor as Rumor
}

describe('buildPickupWrap — wire round trip', () => {
  it('round-trips a targeted pickup-status buzz, parseable back to the same phase/extra', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const reason = buildPickupReason('on-way', { id: 'pickup-request-1000-circle-1', etaMin: 9 })

    const wrap = await buildPickupWrap(signer, circle, reason, PK_CHILD, 1_700_000_000)
    expect(wrap.kind).toBe(1059) // outer NIP-59 gift wrap

    const rumor = await unwrapPickup(wrap, circle)
    expect(rumor.tags.find((t) => t[0] === 't')?.[1]).toBe(KINDEPENDENCE_MSG_SIGNAL_TYPE) // Phase 7 Task 3: rides kindependence's own type, not flock's fixed-action buzz

    const buzz = await decodeLegacyBuzz(circle.seedHex, rumor.content)
    expect(buzz.from).toBe(signer.pubkey)
    expect(buzz.target).toBe(PK_CHILD)
    expect(buzz.timestamp).toBe(1_700_000_000)
    expect(parsePickupReason(buzz.reason)).toEqual({ phase: 'on-way', extra: { id: 'pickup-request-1000-circle-1', etaMin: 9 } })
  })

  it('undecryptable with a different circle\'s seed', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const wrap = await buildPickupWrap(signer, circle, buildPickupReason('accepted', { id: 'r1' }), PK_CHILD, 1000)
    const rumor = await unwrapPickup(wrap, circle)
    await expect(decodeLegacyBuzz('2'.repeat(64), rumor.content)).rejects.toThrow()
  })
})

// ---------------------------------------------------------------------------
// phaseActivityId — final-review fix 4c: `activity.recordActivity` dedupes
// by EXACT id, so a revised suggestion must NOT reuse the first one's id.
// ---------------------------------------------------------------------------

describe('phaseActivityId', () => {
  it('gives a "suggested" revision at a later `at` a DIFFERENT id than the first suggestion, so it is never deduped away', () => {
    const first = phaseActivityId('r1', 'suggested', 1000)
    const revised = phaseActivityId('r1', 'suggested', 1050)
    expect(first).not.toBe(revised)
  })

  it('every other phase keeps a stable id regardless of `at` (still fires at most once per record)', () => {
    expect(phaseActivityId('r1', 'accepted', 1000)).toBe(phaseActivityId('r1', 'accepted', 2000))
    expect(phaseActivityId('r1', 'on-way', 1000)).toBe('r1-on-way')
    expect(phaseActivityId('r1', 'collected', 1000)).toBe('r1-collected')
  })
})

// ---------------------------------------------------------------------------
// handleIncomingPickupSignal — sender-auth binding (ffb48b9 class). `senderPk`
// here is already the caller's (messages.ts's) authenticated rumor.pubkey —
// this module's own gap was never verifying it against the record's actual
// two parties before applying a phase transition.
// ---------------------------------------------------------------------------

describe('handleIncomingPickupSignal', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function setup(existing?: PickupRecord): Circle {
    const circle = fakeCircle()
    signIn(PK_GUARDIAN)
    store.update((p) => {
      p.circles = [circle]
      if (existing) p.pickups = [existing]
    })
    return circle
  }

  it('creates a fresh record from a genuine "requested" announcement (sender becomes collectorPk — no forgery vector here)', () => {
    const circle = setup()
    handleIncomingPickupSignal(circle, PK_GUARDIAN, PK_CHILD, { phase: 'requested', extra: { id: 'pickup-1' } }, 1000)
    const record = store.load().pickups.find((r) => r.id === 'pickup-1')
    expect(record).toMatchObject({ childPk: PK_CHILD, collectorPk: PK_GUARDIAN, phase: 'requested', direction: 'request' })
  })

  it('applies a transition sent by the record\'s own collector', () => {
    const existing: PickupRecord = { id: 'pickup-1', circleId: CIRCLE_ID, childPk: PK_CHILD, collectorPk: PK_GUARDIAN, phase: 'requested', at: 1000, direction: 'request' }
    const circle = setup(existing)
    handleIncomingPickupSignal(circle, PK_GUARDIAN, undefined, { phase: 'accepted', extra: { id: 'pickup-1' } }, 1100)
    expect(store.load().pickups.find((r) => r.id === 'pickup-1')?.phase).toBe('accepted')
  })

  it('applies a transition sent by the record\'s own child (e.g. declining their own request)', () => {
    const existing: PickupRecord = { id: 'pickup-1', circleId: CIRCLE_ID, childPk: PK_CHILD, collectorPk: PK_GUARDIAN, phase: 'requested', at: 1000, direction: 'request' }
    const circle = setup(existing)
    handleIncomingPickupSignal(circle, PK_CHILD, undefined, { phase: 'declined', extra: { id: 'pickup-1' } }, 1100)
    expect(store.load().pickups.find((r) => r.id === 'pickup-1')?.phase).toBe('declined')
  })

  it('drops a transition forged by a third circle member who is neither the child nor the collector — record and Activity untouched', () => {
    const existing: PickupRecord = { id: 'pickup-1', circleId: CIRCLE_ID, childPk: PK_CHILD, collectorPk: PK_GUARDIAN, phase: 'requested', at: 1000, direction: 'request' }
    const circle = setup(existing)
    handleIncomingPickupSignal(circle, PK_OTHER, undefined, { phase: 'collected', extra: { id: 'pickup-1' } }, 1100)
    expect(store.load().pickups.find((r) => r.id === 'pickup-1')?.phase).toBe('requested') // unchanged
    expect(store.load().activity.some((e) => e.kind === 'pickup-status')).toBe(false)
  })
})


// Flock ff5eead parity: the pickup notify path had no freshness gate — a
// relaunch-replayed old "offered" buzz (its record id long since evicted)
// re-created a card AND pushed "X offered a pickup" as if it were live. The
// record/Activity stay ungated (state repopulates on legitimate catch-up);
// only the notification gates on the sealed timestamp.
describe('handleIncomingPickupSignal — notification freshness gate', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(notify).mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function childSetup(): Circle {
    const circle = fakeCircle()
    signIn(PK_CHILD, true)
    store.update((p) => {
      p.circles = [circle]
    })
    return circle
  }

  it('a FRESH offer addressed to this child notifies (positive control)', () => {
    const circle = childSetup()
    const at = Math.floor(Date.now() / 1000) - 10
    handleIncomingPickupSignal(circle, PK_GUARDIAN, PK_CHILD, { phase: 'offered', extra: { id: 'offer-fresh' } }, at)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('a STALE replayed offer still creates the record but does not notify', () => {
    const circle = childSetup()
    const at = Math.floor(Date.now() / 1000) - 700
    handleIncomingPickupSignal(circle, PK_GUARDIAN, PK_CHILD, { phase: 'offered', extra: { id: 'offer-stale' } }, at)
    expect(store.load().pickups.some((r) => r.id === 'offer-stale')).toBe(true)
    expect(notify).not.toHaveBeenCalled()
  })
})
