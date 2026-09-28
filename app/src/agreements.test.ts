import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  DEFAULT_SCHEDULE,
  initialAgreementRecord,
  upsertProposedAgreement,
  applyAgreementAck,
  applyAgreementStatus,
  applyExtendReq,
  applyExtendResp,
  selectActiveAgreement,
  hasArrivedAt,
  agreementScheduleText,
  nextOrCurrentRaise,
  newAgreementId,
  buildAgreementAckWrap,
  buildAgreementStatusWrap,
  buildExtendReqWrap,
  decodeBroodSignal,
  handleIncomingSignal,
  leaveSchedule,
  dueLeaveStage,
  travelCacheFresh,
  formatHHMM,
  leaveSoonCopy,
  leaveNowCopy,
  leaveBehindCopy,
  leaveStageCopy,
  evaluateLeaveReminder,
  pruneOrphanedLeaveFired,
  pruneOrphanedAgreementTravelMode,
  leaveBannerFor,
  sendAgreementStatus,
  proposeAgreement,
  respondExtend,
  checkTick,
  registerStructuralSenders,
  type LeaveStage,
} from './agreements.js'
import * as store from './store.js'
import type { AgreementRecord } from './store.js'
import * as beacons from './beacons.js'
import type { Sender } from './beacons.js'
import * as travel from './travel.js'
import { notify } from './notify.js'
import { sessionForTests, currentSession } from './session.js'

// Test-only fixture shape (Signet identity plan, Task 11: the old local
// identity.ts is gone) — `fakeFam`/the inline `fam` literals below only ever
// feed `signIn`/`evaluateLeaveReminder` in this file, never a real
// `SessionInfo`-typed view function, so this stays a plain local bag rather
// than reaching for session.ts's own type.
interface FakeFam { role: 'parent' | 'child'; name: string; skHex: string; pkHex: string }
import * as queue from './structural-queue.js'
import type { SignerTransport } from './remote-signer.js'
import { makeLocalSigner, deriveInbox, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftWrap, giftUnwrap, rawNip44Decrypt } from '@forgesworn/roost-kit'
import type { Rumor, Signer, SignedEvent } from '@forgesworn/roost-kit'
import {
  buildAgreementAck,
  buildAgreementStatus,
  buildExtendReq,
  buildExtendResp,
  buildBroodInner,
} from '@forgesworn/brood-kit'
import type { Agreement, ExtendResp } from '@forgesworn/brood-kit'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { encode as encodeGeohash } from 'geohash-kit'
import type { Fix } from './geo.js'

// Mocked so the orchestration tests below (leave-reminder review fixes 1-3)
// can control exactly what "here" and "travel time" are, and assert on
// notify() calls, without touching real geolocation or a network — same
// idiom as places.test.ts's own `vi.mock('./beacons.js', ...)` /
// `vi.mock('./notify.js', ...)`.
vi.mock('./beacons.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./beacons.js')>()
  return { ...actual, selfFix: vi.fn(() => null), publishOrEnqueue: vi.fn(async () => {}), sendStructural: vi.fn(async () => {}) }
})
vi.mock('./notify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notify.js')>()
  return { ...actual, notify: vi.fn(async () => {}) }
})
// Kept fully mocked (not wrapping the real implementation) rather than just
// spied-on: a real call with a `routingUrl` set (Fix 3's test) would attempt
// an actual network fetch via rendezvous-kit's Valhalla engine — this way
// `travelSec` is deterministic and network-free regardless of what
// `routingUrl` is passed, so only its CALL COUNT (cache hit vs miss) is what
// each test observes.
vi.mock('./travel.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./travel.js')>()
  return { ...actual, travelSec: vi.fn(async () => ({ sec: 0, source: 'heuristic' as const })) }
})

/** Minimal in-memory localStorage stand-in (mirrors store.test.ts's /
 *  places.test.ts's own). */
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

const PK_CHILD = 'a'.repeat(64)
const PK_GUARDIAN = 'b'.repeat(64)

/** Signs this device in for a test (Signet identity plan): `identityPk` is
 *  the signed-in identity, `phoneSkHex` this device's own phone key. */
function signIn(identityPk: string, phoneSkHex: string, dependant = false): void {
  sessionForTests({ identityPk, phoneSkHex, dependant })
}

/** As `signIn`, with a local-signer transport behind `identitySigner()` so
 *  the structural queue can sign and drain (a stand-in for My Signet). */
function signInWithSigner(identityPk: string): void {
  const s = makeLocalSigner(toHex(generateSecretKey()))
  const transport: SignerTransport = {
    pubkey: s.pubkey,
    signEvent: (t) => s.signEvent(t),
    nip44Encrypt: (peer, pt) => s.nip44Encrypt(peer, pt),
    nip44Decrypt: (peer, ct) => s.nip44Decrypt(peer, ct),
    close: async () => {},
  }
  sessionForTests({ identityPk, phoneSkHex: toHex(generateSecretKey()), dependant: false, transport })
}

/** A resolved sender for a circle signal — `phonePk` the sealing phone key,
 *  `memberPk` the identity it resolves to, `structural` whether it's an
 *  identity-signed structural event (`agreement`/`extend-resp`) rather than
 *  phone-key traffic (`agreement-ack`/`agreement-status`/`extend-req`). */
function fakeSender(phonePk: string, memberPk: string = phonePk, structural = false): Sender {
  return { signerPk: phonePk, memberPk, structural }
}

function fakeCircle(overrides: Partial<Circle> = {}): Circle {
  return {
    id: 'circle-1', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
    members: [{ pk: PK_GUARDIAN, role: 'guardian' }, { pk: PK_CHILD, role: 'child' }],
    createdAt: 100, configUpdatedAt: 100, configBy: PK_GUARDIAN,
    ...overrides,
  }
}

function fakeAgreement(overrides: Partial<Agreement> = {}): Agreement {
  return {
    t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: PK_CHILD,
    byUnix: 1000, schedule: DEFAULT_SCHEDULE, from: PK_GUARDIAN, at: 900,
    ...overrides,
  }
}

function fakeRecord(overrides: Partial<AgreementRecord> = {}): AgreementRecord {
  return { agreement: fakeAgreement(), status: 'proposed', ...overrides }
}

/** Test-only wrap builders for the `agreement`/`extend-resp` brood signals —
 *  Task 9 fix round 1, finding 7: both became identity-signed structural
 *  actions (Signet identity plan, Task 9 — `proposeAgreement`/`respondExtend`
 *  now go through `enqueue`, never a phone-key `giftWrap`), so agreements.ts
 *  no longer exports a production wrap-builder for either; only the "wire
 *  round trips" coverage below still needs this exact wire shape (a real
 *  `giftWrap`-sealed brood signal, decodable by `decodeBroodSignal`), so it's
 *  built locally rather than kept as agreements.ts's own dead export. Mirrors
 *  that module's own (still-exported) `buildAgreementAckWrap`/etc. exactly. */
async function buildAgreementWrap(signer: Signer, circle: Circle, agreement: Agreement): Promise<SignedEvent> {
  const inner = buildBroodInner(agreement, agreement.at)
  const inbox = deriveInbox(circle.seedHex)
  return giftWrap(signer, inbox.pk, inner, inbox.pk)
}
async function buildExtendRespWrap(signer: Signer, circle: Circle, resp: ExtendResp): Promise<SignedEvent> {
  const inner = buildBroodInner(resp, resp.at)
  const inbox = deriveInbox(circle.seedHex)
  return giftWrap(signer, inbox.pk, inner, inbox.pk)
}

async function unwrap(wrap: Awaited<ReturnType<typeof buildAgreementWrap>>, circle: Circle): Promise<Rumor> {
  const inbox = deriveInbox(circle.seedHex)
  const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), wrap)
  expect(rumor).not.toBeNull()
  return rumor as Rumor
}

afterEach(() => {
  sessionForTests(null)
  queue.resetForTests()
})

describe('newAgreementId', () => {
  it('produces distinct ids', () => {
    expect(newAgreementId()).not.toBe(newAgreementId())
  })
})

describe('initialAgreementRecord / upsertProposedAgreement', () => {
  it('starts a fresh proposal at status "proposed"', () => {
    const agreement = fakeAgreement()
    expect(initialAgreementRecord(agreement)).toEqual({ agreement, status: 'proposed' })
  })

  it('adds a new agreement to an empty list', () => {
    const agreement = fakeAgreement()
    expect(upsertProposedAgreement([], agreement)).toEqual([{ agreement, status: 'proposed' }])
  })

  it('is a no-op (dedupe) when the same agreement id is replayed, even after it has moved past "proposed"', () => {
    const agreement = fakeAgreement()
    const records = [fakeRecord({ agreement, status: 'acked' })]
    expect(upsertProposedAgreement(records, agreement)).toBe(records)
  })
})

describe('applyAgreementAck', () => {
  it('moves a proposed agreement to acked', () => {
    const agreement = fakeAgreement()
    const records = [fakeRecord({ agreement, status: 'proposed' })]
    const ack = buildAgreementAck({ id: agreement.id, by: PK_CHILD }, 950)
    expect(applyAgreementAck(records, ack)).toEqual([{ agreement, status: 'acked' }])
  })

  it('is a no-op replaying an ack once already acked (idempotent/dedupe)', () => {
    const agreement = fakeAgreement()
    const records = [fakeRecord({ agreement, status: 'acked' })]
    const ack = buildAgreementAck({ id: agreement.id, by: PK_CHILD }, 950)
    expect(applyAgreementAck(records, ack)).toEqual(records)
  })

  it('is a no-op for an ack naming an unknown agreement id', () => {
    const records = [fakeRecord()]
    const ack = buildAgreementAck({ id: 'nonexistent', by: PK_CHILD }, 950)
    expect(applyAgreementAck(records, ack)).toEqual(records)
  })
})

describe('applyAgreementStatus', () => {
  it('advances acked -> en-route', () => {
    const agreement = fakeAgreement()
    const records = [fakeRecord({ agreement, status: 'acked' })]
    const sig = buildAgreementStatus({ id: agreement.id, status: 'en-route', by: PK_CHILD }, 1000)
    expect(applyAgreementStatus(records, sig)).toEqual([{ agreement, status: 'en-route' }])
  })

  it('advances en-route -> arrived and records arrivedAt', () => {
    const agreement = fakeAgreement()
    const records = [fakeRecord({ agreement, status: 'en-route' })]
    const sig = buildAgreementStatus({ id: agreement.id, status: 'arrived', by: PK_CHILD }, 1200)
    expect(applyAgreementStatus(records, sig)).toEqual([{ agreement, status: 'arrived', arrivedAt: 1200 }])
  })

  it('allows acked -> late directly (deadline elapsed before any en-route was seen)', () => {
    const agreement = fakeAgreement()
    const records = [fakeRecord({ agreement, status: 'acked' })]
    const sig = buildAgreementStatus({ id: agreement.id, status: 'late', by: PK_CHILD }, 1400)
    expect(applyAgreementStatus(records, sig)).toEqual([{ agreement, status: 'late' }])
  })

  it('allows flipping between en-route and late in either direction (same tier)', () => {
    const agreement = fakeAgreement()
    const late = [fakeRecord({ agreement, status: 'late' })]
    const backToEnRoute = buildAgreementStatus({ id: agreement.id, status: 'en-route', by: PK_CHILD }, 1500)
    expect(applyAgreementStatus(late, backToEnRoute)).toEqual([{ agreement, status: 'en-route' }])
  })

  it('is idempotent replaying the exact same status twice', () => {
    const agreement = fakeAgreement()
    const records = [fakeRecord({ agreement, status: 'en-route' })]
    const sig = buildAgreementStatus({ id: agreement.id, status: 'en-route', by: PK_CHILD }, 1000)
    expect(applyAgreementStatus(records, sig)).toEqual(records)
  })

  it('never regresses out of arrived — a stale/replayed en-route or late after arrival is a no-op', () => {
    const agreement = fakeAgreement()
    const records = [fakeRecord({ agreement, status: 'arrived', arrivedAt: 1200 })]
    const staleEnRoute = buildAgreementStatus({ id: agreement.id, status: 'en-route', by: PK_CHILD }, 1100)
    expect(applyAgreementStatus(records, staleEnRoute)).toEqual(records)
    const replayedArrived = buildAgreementStatus({ id: agreement.id, status: 'arrived', by: PK_CHILD }, 1250)
    expect(applyAgreementStatus(records, replayedArrived)).toEqual(records) // arrivedAt stays at the FIRST arrival
  })

  it('is a no-op for a status naming an unknown agreement id', () => {
    const records = [fakeRecord()]
    const sig = buildAgreementStatus({ id: 'nonexistent', status: 'en-route', by: PK_CHILD }, 1000)
    expect(applyAgreementStatus(records, sig)).toEqual(records)
  })
})

describe('applyExtendReq / applyExtendResp', () => {
  it('records a pending extend request', () => {
    const agreement = fakeAgreement()
    const records = [fakeRecord({ agreement, status: 'late' })]
    const req = buildExtendReq({ id: agreement.id, extraMin: 15, by: PK_CHILD }, 1400)
    expect(applyExtendReq(records, req)).toEqual([
      { agreement, status: 'late', pendingExtend: { id: agreement.id, extraMin: 15, by: PK_CHILD, at: 1400 } },
    ])
  })

  it('approving pushes byUnix out by extraMin*60, resets a late status to en-route, and clears pendingExtend — deterministic, same result on both sides applying the identical resp', () => {
    const agreement = fakeAgreement({ byUnix: 1000 })
    const records = [fakeRecord({ agreement, status: 'late', pendingExtend: { id: agreement.id, extraMin: 15, by: PK_CHILD, at: 1400 } })]
    const resp = buildExtendResp({ id: agreement.id, ok: true, extraMin: 15, by: PK_GUARDIAN }, 1410)

    const guardianSide = applyExtendResp(records, resp)
    const childSide = applyExtendResp(records, resp)
    expect(guardianSide).toEqual(childSide)
    expect(guardianSide[0]?.agreement.byUnix).toBe(1000 + 15 * 60)
    expect(guardianSide[0]?.status).toBe('en-route') // BROOD.md §4: "lifecycle resumes at en-route" against the new deadline
    expect(guardianSide[0]?.pendingExtend).toBeUndefined()
  })

  it('approving from a non-late status (e.g. en-route asking for more lead time) leaves status unchanged', () => {
    const agreement = fakeAgreement({ byUnix: 1000 })
    const records = [fakeRecord({ agreement, status: 'en-route', pendingExtend: { id: agreement.id, extraMin: 15, by: PK_CHILD, at: 1400 } })]
    const resp = buildExtendResp({ id: agreement.id, ok: true, extraMin: 15, by: PK_GUARDIAN }, 1410)
    expect(applyExtendResp(records, resp)[0]?.status).toBe('en-route')
  })

  it('a counter-offered extraMin on the resp overrides the request\'s own extraMin', () => {
    const agreement = fakeAgreement({ byUnix: 1000 })
    const records = [fakeRecord({ agreement, status: 'late', pendingExtend: { id: agreement.id, extraMin: 30, by: PK_CHILD, at: 1400 } })]
    const resp = buildExtendResp({ id: agreement.id, ok: true, extraMin: 10, by: PK_GUARDIAN }, 1410)
    expect(applyExtendResp(records, resp)[0]?.agreement.byUnix).toBe(1000 + 10 * 60)
  })

  it('denying leaves byUnix and status unchanged but clears pendingExtend', () => {
    const agreement = fakeAgreement({ byUnix: 1000 })
    const records = [fakeRecord({ agreement, status: 'late', pendingExtend: { id: agreement.id, extraMin: 15, by: PK_CHILD, at: 1400 } })]
    const resp = buildExtendResp({ id: agreement.id, ok: false, by: PK_GUARDIAN }, 1410)
    expect(applyExtendResp(records, resp)).toEqual([{ agreement, status: 'late', pendingExtend: undefined }])
  })

  it('dedupes a replayed resp — a second application after pendingExtend has already been cleared is a no-op', () => {
    const agreement = fakeAgreement({ byUnix: 1000 })
    const records = [fakeRecord({ agreement, status: 'late', pendingExtend: { id: agreement.id, extraMin: 15, by: PK_CHILD, at: 1400 } })]
    const resp = buildExtendResp({ id: agreement.id, ok: true, extraMin: 15, by: PK_GUARDIAN }, 1410)
    const once = applyExtendResp(records, resp)
    const twice = applyExtendResp(once, resp)
    expect(twice).toEqual(once) // byUnix extended only once, not twice
  })

  it('is a no-op applying a resp when there is no matching pending request', () => {
    const agreement = fakeAgreement({ byUnix: 1000 })
    const records = [fakeRecord({ agreement, status: 'acked' })]
    const resp = buildExtendResp({ id: agreement.id, ok: true, extraMin: 15, by: PK_GUARDIAN }, 1410)
    expect(applyExtendResp(records, resp)).toEqual(records)
  })
})

describe('selectActiveAgreement', () => {
  it('returns the circle\'s acked-and-untracked agreement for the given child pubkey', () => {
    const agreement = fakeAgreement({ circleId: 'circle-1', child: PK_CHILD })
    const records = [fakeRecord({ agreement, status: 'acked' })]
    expect(selectActiveAgreement(records, 'circle-1', PK_CHILD)).toEqual(agreement)
  })

  it('includes en-route and late (not just freshly acked)', () => {
    const agreement = fakeAgreement({ circleId: 'circle-1', child: PK_CHILD })
    expect(selectActiveAgreement([fakeRecord({ agreement, status: 'en-route' })], 'circle-1', PK_CHILD)).toEqual(agreement)
    expect(selectActiveAgreement([fakeRecord({ agreement, status: 'late' })], 'circle-1', PK_CHILD)).toEqual(agreement)
  })

  it('excludes a proposed (not-yet-acked) agreement', () => {
    const agreement = fakeAgreement({ circleId: 'circle-1', child: PK_CHILD })
    expect(selectActiveAgreement([fakeRecord({ agreement, status: 'proposed' })], 'circle-1', PK_CHILD)).toBeUndefined()
  })

  it('excludes an arrived (fulfilled) agreement', () => {
    const agreement = fakeAgreement({ circleId: 'circle-1', child: PK_CHILD })
    expect(selectActiveAgreement([fakeRecord({ agreement, status: 'arrived', arrivedAt: 1200 })], 'circle-1', PK_CHILD)).toBeUndefined()
  })

  it('excludes agreements for a different circle or a different child', () => {
    const agreement = fakeAgreement({ circleId: 'circle-1', child: PK_CHILD })
    const records = [fakeRecord({ agreement, status: 'acked' })]
    expect(selectActiveAgreement(records, 'circle-2', PK_CHILD)).toBeUndefined()
    expect(selectActiveAgreement(records, 'circle-1', PK_GUARDIAN)).toBeUndefined()
  })
})

describe('hasArrivedAt', () => {
  const place = { label: 'School gate', geohash: encodeGeohash(51.5074, -0.1278, 9) }

  it('true when the current fix falls in the place\'s geohash cell', () => {
    const fix: Fix = { lat: 51.5074, lon: -0.1278, accuracy: 5, at: 1000 }
    expect(hasArrivedAt(place, fix)).toBe(true)
  })

  it('false when the current fix is elsewhere', () => {
    const fix: Fix = { lat: 40.7128, lon: -74.006, accuracy: 5, at: 1000 } // New York
    expect(hasArrivedAt(place, fix)).toBe(false)
  })

  it('false for a label-only place (no geohash)', () => {
    const fix: Fix = { lat: 51.5074, lon: -0.1278, accuracy: 5, at: 1000 }
    expect(hasArrivedAt({ label: 'Somewhere' }, fix)).toBe(false)
  })

  it('false when there is no current fix', () => {
    expect(hasArrivedAt(place, null)).toBe(false)
  })
})

// Fixed formatter (not toLocaleTimeString/locale/timezone-dependent) so
// these tests are deterministic — matches `agreementScheduleText`'s/
// `nextOrCurrentRaise`'s own doc comment on why the real clock formatting is
// pushed out to the caller (app.ts's `formatClockTime`).
const fmt = (unixSec: number): string => `${unixSec}`

describe('agreementScheduleText (Task 8, brief §11.3: "the child should be able to see the schedule in advance")', () => {
  it('falls back to just the baseline term for an empty schedule', () => {
    expect(agreementScheduleText('Neighbourhood', [], 2000, fmt)).toBe('Neighbourhood.')
  })

  it('renders a single-step schedule (this app\'s own DEFAULT_SCHEDULE shape) as "baseline until T, then term from T"', () => {
    const schedule = [{ fromOffsetMin: -15, precision: 9 }]
    expect(agreementScheduleText('Neighbourhood', schedule, 2000, fmt)).toBe('Neighbourhood until 1100, then Precise from 1100.')
  })

  it('renders a multi-step schedule with the middle step unadorned and only the LAST step getting "from"', () => {
    const schedule = [{ fromOffsetMin: -30, precision: 7 }, { fromOffsetMin: -15, precision: 9 }]
    // byUnix 2000: -30min -> 200, -15min -> 1100
    expect(agreementScheduleText('Neighbourhood', schedule, 2000, fmt)).toBe('Neighbourhood until 200, then Street, Precise from 1100.')
  })

  it('sorts out-of-order schedule steps by fromOffsetMin before rendering', () => {
    const schedule = [{ fromOffsetMin: -15, precision: 9 }, { fromOffsetMin: -30, precision: 7 }]
    expect(agreementScheduleText('Neighbourhood', schedule, 2000, fmt)).toBe('Neighbourhood until 200, then Street, Precise from 1100.')
  })
})

describe('nextOrCurrentRaise', () => {
  const schedule = [{ fromOffsetMin: -30, precision: 7 }, { fromOffsetMin: -15, precision: 9 }] // at byUnix=2000: 200 (Street), 1100 (Precise)

  it('returns the first UPCOMING step that beats the baseline, before any step has fired yet', () => {
    expect(nextOrCurrentRaise(6, schedule, 2000, 0)).toEqual({ precision: 7, atUnix: 200 })
  })

  it('returns undefined when every step is at or below the baseline (nothing to raise)', () => {
    expect(nextOrCurrentRaise(9, schedule, 2000, 0)).toBeUndefined()
  })

  it('returns the CURRENTLY active step when now is within its window', () => {
    expect(nextOrCurrentRaise(6, schedule, 2000, 500)).toEqual({ precision: 7, atUnix: 200 })
  })

  it('returns the LATER step once now has passed its own fire time, not the earlier one', () => {
    expect(nextOrCurrentRaise(6, schedule, 2000, 1200)).toEqual({ precision: 9, atUnix: 1100 })
  })

  it('keeps naming the currently-active raise rather than going silent once its own moment has passed (current, not just upcoming)', () => {
    // now=1200 is after BOTH steps fired; the later (Precise) one is current.
    expect(nextOrCurrentRaise(6, schedule, 2000, 1200)?.precision).toBe(9)
  })

  it('never returns a step whose precision does not exceed the baseline, even if it has fired', () => {
    expect(nextOrCurrentRaise(9, schedule, 2000, 1200)).toBeUndefined()
  })

  // Phase 5 final-review fast-follow (§25 transparency): app.ts's
  // `circleModeLine` feeds the SAME journey-floored baseline into this
  // function that it feeds `basePrecisionFor` (`beacons.applyJourneyFloor`,
  // beacons.test.ts's own composed tests cover the `basePrecisionFor` half)
  // — these two cover the `nextOrCurrentRaise` half, so a schedule raise
  // finer than the journey floor still surfaces as "· <term> from <time>"
  // rather than the floor silently absorbing it, matching how
  // `decideCadence`'s own agreement merge (strictly AFTER the journey
  // floor, itself max-only) can never be capped by it either
  // (beacons.test.ts's "never caps an agreement raise above it").
  it('composed with beacons.applyJourneyFloor: a journey floor never hides a finer agreement raise', () => {
    const floored = beacons.applyJourneyFloor(4, 7) // Town static baseline, Street journey floor -> 7
    const fineSchedule = [{ fromOffsetMin: -30, precision: 9 }] // Precise, finer than the floor
    expect(nextOrCurrentRaise(floored, fineSchedule, 2000, 500)).toEqual({ precision: 9, atUnix: 200 })
  })

  it('composed with beacons.applyJourneyFloor: no raise surfaced once the journey floor already covers the schedule\'s own step', () => {
    const floored = beacons.applyJourneyFloor(4, 7)
    const sameAsFloor = [{ fromOffsetMin: -30, precision: 7 }] // no finer than the floor already in effect
    expect(nextOrCurrentRaise(floored, sameAsFloor, 2000, 500)).toBeUndefined()
  })
})

describe('wire round trips — build*Wrap / decodeBroodSignal', () => {
  it('round-trips an agreement proposal', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const agreement = fakeAgreement()

    const wrap = await buildAgreementWrap(signer, circle, agreement)
    expect(wrap.kind).toBe(1059) // outer NIP-59 gift wrap, never the bare inner signal
    const rumor = await unwrap(wrap, circle)
    expect(decodeBroodSignal(rumor, fakeSender(signer.pubkey, signer.pubkey, true))).toEqual(agreement)
  })

  it('round-trips an ack', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const ack = buildAgreementAck({ id: 'agr-1', by: PK_CHILD }, 950)

    const wrap = await buildAgreementAckWrap(signer, circle, ack)
    const rumor = await unwrap(wrap, circle)
    expect(decodeBroodSignal(rumor, fakeSender(signer.pubkey))).toEqual(ack)
  })

  it('round-trips a status signal', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const sig = buildAgreementStatus({ id: 'agr-1', status: 'en-route', by: PK_CHILD }, 1000)

    const wrap = await buildAgreementStatusWrap(signer, circle, sig)
    const rumor = await unwrap(wrap, circle)
    expect(decodeBroodSignal(rumor, fakeSender(signer.pubkey))).toEqual(sig)
  })

  it('round-trips an extend request and response', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const req = buildExtendReq({ id: 'agr-1', extraMin: 15, by: PK_CHILD }, 1400)
    const resp = buildExtendResp({ id: 'agr-1', ok: true, extraMin: 15, by: PK_GUARDIAN }, 1410)

    const reqRumor = await unwrap(await buildExtendReqWrap(signer, circle, req), circle)
    expect(decodeBroodSignal(reqRumor, fakeSender(signer.pubkey))).toEqual(req)

    const respRumor = await unwrap(await buildExtendRespWrap(signer, circle, resp), circle)
    expect(decodeBroodSignal(respRumor, fakeSender(signer.pubkey, signer.pubkey, true))).toEqual(resp)
  })

  it('decodeBroodSignal returns null for a rumor that is not a brood signal (e.g. a plain beacon)', async () => {
    const rumor: Rumor = { pubkey: PK_CHILD, created_at: 1000, kind: 20_078, tags: [['t', 'beacon']], content: '{}' }
    expect(decodeBroodSignal(rumor, fakeSender(PK_CHILD))).toBeNull()
  })
})

// Task 9 fix round 1, finding 7: `agreement`/`extend-resp` are identity-signed
// structural actions (Signet identity plan, Task 9) — sent via
// `structural-queue.ts`'s `enqueue`, not a direct phone-key publish (unlike
// `ack`/`status`/`extend-req` above, already covered by the "wire round
// trips" tests via their own `build*Wrap` helpers). These prove the two
// queue the right action/circleId/payload and (final fix round 3, F2)
// change local state only once their sender has sent the signed event —
// `beacons.sendStructural` is mocked, and a local-signer transport stands in
// for My Signet.
describe('proposeAgreement / respondExtend — structural enqueue (Task 9 fix round 1, finding 7)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(beacons.sendStructural).mockClear()
  })

  it('final fix round 3, F2: proposeAgreement changes nothing locally at enqueue — it only queues the structural \'agreement\' action', async () => {
    const circle = fakeCircle()
    signIn(PK_GUARDIAN, toHex(generateSecretKey()), false)
    const p = store.load()
    p.circles = [circle]
    store.save(p)

    await proposeAgreement(circle.id, { child: PK_CHILD, byUnix: 2000, schedule: DEFAULT_SCHEDULE })

    expect(store.load().agreements).toEqual([])
    expect(store.load().activity).toEqual([])
    const queued = queue.pending().find((q) => q.action === 'agreement')
    expect(queued?.circleId).toBe(circle.id)
    expect(JSON.parse(queued?.payload ?? 'null')).toMatchObject({ t: 'agreement', child: PK_CHILD, from: PK_GUARDIAN })
  })

  it('final fix round 3, F2: proposeAgreement is applied locally once the signed event has been sent', async () => {
    const circle = fakeCircle()
    signInWithSigner(PK_GUARDIAN)
    const p = store.load()
    p.circles = [circle]
    store.save(p)
    registerStructuralSenders()

    await proposeAgreement(circle.id, { child: PK_CHILD, byUnix: 2000, schedule: DEFAULT_SCHEDULE })
    await queue.drain()

    expect(beacons.sendStructural).toHaveBeenCalledTimes(1)
    expect(queue.pending()).toEqual([])
    const record = store.load().agreements.find((r) => r.agreement.child === PK_CHILD)
    expect(record?.status).toBe('proposed')
    expect(store.load().activity.map((e) => e.kind)).toEqual(['agreement-created'])
  })

  it('final fix round 4: sign-out while the agreement send is in flight — the next session\'s store gets nothing', async () => {
    const circle = fakeCircle()
    signInWithSigner(PK_GUARDIAN)
    store.save({ ...store.load(), circles: [circle] })
    registerStructuralSenders()
    let release!: () => void
    let started!: () => void
    const inFlight = new Promise<void>((r) => { started = r })
    vi.mocked(beacons.sendStructural).mockImplementationOnce(async () => { started(); await new Promise<void>((r) => { release = r }) })

    await proposeAgreement(circle.id, { child: PK_CHILD, byUnix: 2000, schedule: DEFAULT_SCHEDULE })
    const drained = queue.drain()
    await inFlight
    store.clear()
    sessionForTests(null)
    signInWithSigner('e'.repeat(64))
    store.save({ ...store.load(), circles: [fakeCircle()] })
    release()
    await drained

    expect(store.load().agreements).toEqual([])
    expect(store.load().activity).toEqual([])
  })

  it('final fix round 3, F2: a cancelled proposeAgreement has nothing to undo', async () => {
    const circle = fakeCircle()
    signIn(PK_GUARDIAN, toHex(generateSecretKey()), false)
    const p = store.load()
    p.circles = [circle]
    store.save(p)
    registerStructuralSenders()

    await proposeAgreement(circle.id, { child: PK_CHILD, byUnix: 2000, schedule: DEFAULT_SCHEDULE })
    const before = store.load()
    queue.cancel(queue.pending().find((q) => q.action === 'agreement')!.id)

    expect(store.load().agreements).toEqual(before.agreements)
    expect(store.load().agreements).toEqual([])
    expect(store.load().activity).toEqual([])
  })

  it('final fix round 3, F2: respondExtend changes nothing locally at enqueue, is applied once sent, and is not queued twice', async () => {
    const circle = fakeCircle()
    signIn(PK_GUARDIAN, toHex(generateSecretKey()), false)
    const record = fakeRecord({ status: 'late', pendingExtend: { id: 'agr-1', extraMin: 15, by: PK_CHILD, at: 1400 } })
    const p = store.load()
    p.circles = [circle]
    p.agreements = [record]
    store.save(p)
    registerStructuralSenders()

    await respondExtend('agr-1', true)
    await respondExtend('agr-1', true) // a second tap while waiting on My Signet
    await queue.drain() // no signer yet: it stays waiting
    expect(store.load().agreements[0]).toEqual(record)
    expect(queue.pending().filter((q) => q.action === 'extend-resp')).toHaveLength(1)
    const queued = queue.pending().find((q) => q.action === 'extend-resp')
    expect(queued?.circleId).toBe(circle.id)
    expect(JSON.parse(queued?.payload ?? 'null')).toMatchObject({ t: 'extend-resp', id: 'agr-1', ok: true, by: PK_GUARDIAN })

    // My Signet comes back: the signed answer goes out, then applies here.
    signInWithSigner(PK_GUARDIAN)
    await queue.drain()
    expect(beacons.sendStructural).toHaveBeenCalledTimes(1)
    expect(store.load().agreements[0]?.pendingExtend).toBeUndefined()
    expect(store.load().agreements[0]?.status).toBe('en-route')
    expect(store.load().agreements[0]?.agreement.byUnix).toBe(record.agreement.byUnix + 15 * 60)
  })

  it('final fix round 3, F2: a cancelled respondExtend leaves the record exactly as it was', async () => {
    const circle = fakeCircle()
    signIn(PK_GUARDIAN, toHex(generateSecretKey()), false)
    const record = fakeRecord({ status: 'late', pendingExtend: { id: 'agr-1', extraMin: 15, by: PK_CHILD, at: 1400 } })
    const p = store.load()
    p.circles = [circle]
    p.agreements = [record]
    store.save(p)
    registerStructuralSenders()

    await respondExtend('agr-1', true)
    queue.cancel(queue.pending().find((q) => q.action === 'extend-resp')!.id)

    expect(store.load().agreements[0]).toEqual(record)
    // Nothing pending any more: the guardian can answer again.
    await respondExtend('agr-1', false)
    expect(queue.pending().filter((q) => q.action === 'extend-resp')).toHaveLength(1)
  })
})

describe('handleIncomingSignal', () => {
  it('ignores a signal whose pubkey is this device\'s own (self-echo — already applied synchronously when sent)', () => {
    // No store identity is set up in this test (no localStorage stub), so
    // `store.load().identity` is undefined and the self-echo guard's `fam &&`
    // short-circuits — this proves the function doesn't throw and simply has
    // nothing to do without a signed-in identity, the same no-op path a
    // self-echo takes when identity IS present and matches rumor.pubkey.
    const circle = fakeCircle()
    const rumor: Rumor = { pubkey: PK_CHILD, created_at: 1000, kind: 20_078, tags: [['t', 'agreement']], content: 'not json' }
    expect(() => handleIncomingSignal(circle, rumor, 'agreement', fakeSender(PK_CHILD, PK_CHILD, true))).not.toThrow()
  })

  it('two phones, one identity: an `agreement` from this identity\'s OTHER phone is applied; one from THIS phone is self-echo and skipped', () => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    signIn(PK_GUARDIAN, toHex(generateSecretKey()), false)
    const myPhonePk = currentSession()!.phonePk
    const otherPhonePk = makeLocalSigner(toHex(generateSecretKey())).pubkey
    const circle = fakeCircle({ id: 'circle-two-phones' })
    const agreement = fakeAgreement({ from: PK_GUARDIAN, at: 900, circleId: circle.id })
    const rumor: Rumor = { pubkey: otherPhonePk, created_at: 900, kind: 20_078, tags: [['t', 'agreement']], content: JSON.stringify(agreement) }

    // Sealed by this SAME identity's OTHER phone — not this device's own
    // phone key, so it isn't self-echo and is applied normally.
    handleIncomingSignal(circle, rumor, 'agreement', fakeSender(otherPhonePk, PK_GUARDIAN, true))
    expect(store.load().agreements.find((r) => r.agreement.id === agreement.id)).toBeDefined()

    // The identical content, sealed by THIS device's own phone key instead —
    // dropped as self-echo before ever reaching the reducer.
    store.update((p) => { p.agreements = [] })
    const echoRumor: Rumor = { ...rumor, pubkey: myPhonePk }
    handleIncomingSignal(circle, echoRumor, 'agreement', fakeSender(myPhonePk, PK_GUARDIAN, true))
    expect(store.load().agreements).toEqual([])

    vi.unstubAllGlobals()
  })

  // sender-auth (ffb48b9 class): every brood signal this file's switch
  // handles carries a content-embedded actor field (BROOD.md §3's
  // `from`/`by`) naming the SENDER. roost-kit 504cff8 authenticates
  // rumor.pubkey, but nothing stops the CONTENT from lying about who wrote
  // it — a real circle member's own genuinely-signed wrap can still claim
  // another member's pubkey inside the JSON payload. Each case: validly
  // "wrapped" (a plausible rumor.pubkey) but the content's actor field names
  // someone else — dropped wholesale, nothing recorded/applied.
  describe('sender-auth binding (ffb48b9 class) — forgery rejection', () => {
    beforeEach(() => {
      vi.stubGlobal('localStorage', fakeLocalStorage())
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    const circle = fakeCircle()
    const attacker = 'c'.repeat(64) // the real, authenticated wrap sender
    const victim = PK_GUARDIAN // whoever the content dishonestly claims acted

    function rumorFor(t: string, content: object, at: number): Rumor {
      return { pubkey: attacker, created_at: at, kind: 20_078, tags: [['t', t]], content: JSON.stringify(content) } as unknown as Rumor
    }

    it('drops an `agreement` proposal whose `from` names someone other than the actual sender', () => {
      const forged = fakeAgreement({ from: victim, at: 900 })
      handleIncomingSignal(circle, rumorFor('agreement', forged, 900), 'agreement', fakeSender(attacker, attacker, true))
      expect(store.load().agreements.find((r) => r.agreement.id === forged.id)).toBeUndefined()
      expect(store.load().activity.some((e) => e.kind === 'agreement-created')).toBe(false)
    })

    it('drops an `agreement-ack` whose `by` names someone other than the actual sender', () => {
      store.update((p) => { p.agreements = [fakeRecord()] })
      const forged = buildAgreementAck({ id: 'agr-1', by: victim }, 950)
      handleIncomingSignal(circle, rumorFor('agreement-ack', forged, 950), 'agreement-ack', fakeSender(attacker))
      expect(store.load().agreements[0]?.status).toBe('proposed') // unchanged — never advanced to 'acked'
      expect(store.load().activity.some((e) => e.kind === 'agreement-acked')).toBe(false)
    })

    it('drops an `agreement-status` whose `by` names someone other than the actual sender', () => {
      store.update((p) => { p.agreements = [fakeRecord({ status: 'acked' })] })
      const forged = buildAgreementStatus({ id: 'agr-1', status: 'en-route', by: victim }, 1000)
      handleIncomingSignal(circle, rumorFor('agreement-status', forged, 1000), 'agreement-status', fakeSender(attacker))
      expect(store.load().agreements[0]?.status).toBe('acked') // unchanged
      expect(store.load().activity.some((e) => e.kind === 'agreement-status')).toBe(false)
    })

    it('drops an `extend-req` whose `by` names someone other than the actual sender', () => {
      store.update((p) => { p.agreements = [fakeRecord({ status: 'en-route' })] })
      const forged = buildExtendReq({ id: 'agr-1', extraMin: 15, by: victim }, 1400)
      handleIncomingSignal(circle, rumorFor('extend-req', forged, 1400), 'extend-req', fakeSender(attacker))
      expect(store.load().agreements[0]?.pendingExtend).toBeUndefined()
      expect(store.load().activity.some((e) => e.kind === 'agreement-extended')).toBe(false)
    })

    it('drops an `extend-resp` whose `by` names someone other than the actual sender', () => {
      store.update((p) => {
        p.agreements = [fakeRecord({ status: 'late', pendingExtend: { id: 'agr-1', extraMin: 15, by: PK_CHILD, at: 1400 } })]
      })
      const forged = buildExtendResp({ id: 'agr-1', ok: true, extraMin: 15, by: victim }, 1410)
      handleIncomingSignal(circle, rumorFor('extend-resp', forged, 1410), 'extend-resp', fakeSender(attacker, attacker, true))
      expect(store.load().agreements[0]?.pendingExtend).toBeDefined() // unchanged — still pending
      expect(store.load().activity.some((e) => e.kind === 'agreement-extended')).toBe(false)
    })
  })

  // Review fix round 1: `agreement`/`extend-resp` are STRUCTURAL actions —
  // even a well-formed, correctly-bound copy must never apply if it arrived
  // phone-signed (beacons.ts's choke point already drops this in
  // production; this proves the handler's own belt-and-braces re-check),
  // and authority is bound to the circle the signal actually arrived on.
  describe('structural-only + circle-bound authority (review fix round 1)', () => {
    beforeEach(() => {
      vi.stubGlobal('localStorage', fakeLocalStorage())
    })
    afterEach(() => {
      vi.unstubAllGlobals()
    })

    it('ignores an `agreement` delivered non-structurally (sender.structural: false), even with a genuine from match', () => {
      const circle = fakeCircle()
      const agreement = fakeAgreement({ from: PK_GUARDIAN, at: 900, circleId: circle.id })
      const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 900, kind: 20_078, tags: [['t', 'agreement']], content: JSON.stringify(agreement) }
      handleIncomingSignal(circle, rumor, 'agreement', fakeSender(PK_GUARDIAN, PK_GUARDIAN, false))
      expect(store.load().agreements.find((r) => r.agreement.id === agreement.id)).toBeUndefined()
    })

    it('drops an `agreement` whose own circleId does not match the circle it arrived on (cross-circle)', () => {
      const circleA = fakeCircle({ id: 'circle-a' })
      const agreementForB = fakeAgreement({ from: PK_GUARDIAN, at: 900, circleId: 'circle-b' })
      const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 900, kind: 20_078, tags: [['t', 'agreement']], content: JSON.stringify(agreementForB) }
      handleIncomingSignal(circleA, rumor, 'agreement', fakeSender(PK_GUARDIAN, PK_GUARDIAN, true))
      expect(store.load().agreements.find((r) => r.agreement.id === agreementForB.id)).toBeUndefined()
    })

    it('ignores an `extend-resp` delivered non-structurally (sender.structural: false), even with a genuine by match', () => {
      const circle = fakeCircle()
      store.update((p) => {
        p.agreements = [fakeRecord({ status: 'late', pendingExtend: { id: 'agr-1', extraMin: 15, by: PK_CHILD, at: 1400 } })]
      })
      const resp = buildExtendResp({ id: 'agr-1', ok: true, extraMin: 15, by: PK_GUARDIAN }, 1410)
      const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 1410, kind: 20_078, tags: [['t', 'extend-resp']], content: JSON.stringify(resp) }
      handleIncomingSignal(circle, rumor, 'extend-resp', fakeSender(PK_GUARDIAN, PK_GUARDIAN, false))
      expect(store.load().agreements[0]?.pendingExtend).toBeDefined() // unchanged — still pending
    })

    it('drops an `extend-resp` whose tracked agreement is under a DIFFERENT circle than the one it arrived on (cross-circle)', () => {
      const circleA = fakeCircle({ id: 'circle-a' })
      store.update((p) => {
        p.agreements = [fakeRecord({
          agreement: fakeAgreement({ circleId: 'circle-b' }),
          status: 'late',
          pendingExtend: { id: 'agr-1', extraMin: 15, by: PK_CHILD, at: 1400 },
        })]
      })
      const resp = buildExtendResp({ id: 'agr-1', ok: true, extraMin: 15, by: PK_GUARDIAN }, 1410)
      const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 1410, kind: 20_078, tags: [['t', 'extend-resp']], content: JSON.stringify(resp) }
      handleIncomingSignal(circleA, rumor, 'extend-resp', fakeSender(PK_GUARDIAN, PK_GUARDIAN, true))
      expect(store.load().agreements[0]?.pendingExtend).toBeDefined() // unchanged — still pending
    })
  })
})

// ---------------------------------------------------------------------------
// Task 8 (brief §15): travel-aware leave reminders — pure schedule/collapse/
// cache-TTL/copy logic. No store/network access in any of these.
// ---------------------------------------------------------------------------

describe('leaveSchedule (Task 8, brief §15)', () => {
  it('computes leaveBy = byUnix - travelSecValue - padSec (default 300), and stages at leaveBy-900/leaveBy/leaveBy+300', () => {
    const byUnix = 100_000
    const travelSecValue = 600 // 10 min
    const leaveBy = byUnix - travelSecValue - 300
    expect(leaveSchedule(byUnix, travelSecValue)).toEqual([
      { stage: 'soon', atUnix: leaveBy - 900 },
      { stage: 'now', atUnix: leaveBy },
      { stage: 'behind', atUnix: leaveBy + 300 },
    ])
  })

  it('honours a custom padSec', () => {
    const byUnix = 100_000
    const leaveBy = byUnix - 60 // travelSecValue 0, padSec 60
    expect(leaveSchedule(byUnix, 0, 60)).toEqual([
      { stage: 'soon', atUnix: leaveBy - 900 },
      { stage: 'now', atUnix: leaveBy },
      { stage: 'behind', atUnix: leaveBy + 300 },
    ])
  })

  it('stages walk in ascending atUnix order regardless of inputs (soon < now < behind)', () => {
    const stages = leaveSchedule(50_000, 1200)
    expect(stages[0]!.atUnix).toBeLessThan(stages[1]!.atUnix)
    expect(stages[1]!.atUnix).toBeLessThan(stages[2]!.atUnix)
  })
})

describe('dueLeaveStage (Task 8, brief §15 — collapse rule)', () => {
  const byUnix = 100_000
  const stages = leaveSchedule(byUnix, 600) // 10 min travel, well under the 15 min lead — stages spread out normally

  it('returns null when nothing is due yet', () => {
    expect(dueLeaveStage(stages, {}, stages[0]!.atUnix - 1)).toBeNull()
  })

  it('returns the single due-unfired stage once its time has come', () => {
    expect(dueLeaveStage(stages, {}, stages[0]!.atUnix)).toEqual(stages[0])
  })

  it('skips an already-fired stage and returns the next due-unfired one', () => {
    expect(dueLeaveStage(stages, { soon: true }, stages[1]!.atUnix)).toEqual(stages[1])
  })

  it('returns null once every due stage has fired', () => {
    expect(dueLeaveStage(stages, { soon: true, now: true, behind: true }, stages[2]!.atUnix)).toBeNull()
  })

  it('collapse rule: travel time longer than the lead time makes multiple stages simultaneously due — only the LATEST unfired one is returned, never a burst of three', () => {
    const longStages = leaveSchedule(byUnix, 20 * 60) // 20 min travel > 15 min 'soon' lead
    const now = longStages[2]!.atUnix + 60 // evaluated just after every stage is already due
    // Sanity: all three really are simultaneously due at `now`.
    expect(longStages.every((s) => s.atUnix <= now)).toBe(true)
    expect(dueLeaveStage(longStages, {}, now)).toEqual(longStages[2])
  })

  it('re-arms naturally on an extension: a byUnix change means none of the OLD schedule\'s fired keys apply to the NEW one (modelled here as a fresh, empty fired record)', () => {
    const extended = leaveSchedule(byUnix + 15 * 60, 600) // +15 min extension grant
    expect(dueLeaveStage(extended, {}, extended[0]!.atUnix)).toEqual(extended[0])
  })
})

describe('travelCacheFresh (Task 8, brief §15 — recompute at most every 5 min)', () => {
  it('true strictly within the TTL window', () => {
    expect(travelCacheFresh(1000, 1000 + 299)).toBe(true)
  })

  it('false once the TTL has elapsed (boundary is exclusive)', () => {
    expect(travelCacheFresh(1000, 1000 + 300)).toBe(false)
  })

  it('true at the instant it was computed', () => {
    expect(travelCacheFresh(1000, 1000)).toBe(true)
  })

  it('honours a custom ttlSec', () => {
    expect(travelCacheFresh(1000, 1050, 40)).toBe(false)
    expect(travelCacheFresh(1000, 1050, 100)).toBe(true)
  })
})

describe('leave-reminder copy (Task 8, brief §15/§31 — verbatim)', () => {
  it('formatHHMM zero-pads hours and minutes from a unix timestamp, device-local', () => {
    const d = new Date(0)
    d.setHours(9, 5, 0, 0)
    expect(formatHHMM(Math.floor(d.getTime() / 1000))).toBe('09:05')
  })

  it('leaveSoonCopy: "You\'ll need to leave for X soon (about N min away)"', () => {
    expect(leaveSoonCopy('School gate', 12)).toBe("You'll need to leave for School gate soon (about 12 min away)")
  })

  it('leaveNowCopy: "Leave now to make X by HH:MM"', () => {
    expect(leaveNowCopy('School gate', '17:30')).toBe('Leave now to make School gate by 17:30')
  })

  it('leaveBehindCopy: "Running behind for X — ask for more time?" — never the word "late" (§31)', () => {
    const copy = leaveBehindCopy('School gate')
    expect(copy).toBe('Running behind for School gate — ask for more time?')
    expect(copy.toLowerCase()).not.toContain('late')
  })

  it('leaveStageCopy dispatches soon/now/behind to the matching copy builder', () => {
    const d = new Date(0)
    d.setHours(17, 30, 0, 0)
    const byUnix = Math.floor(d.getTime() / 1000)
    const stage: LeaveStage['stage'] = 'soon'
    expect(leaveStageCopy(stage, 'School gate', 720, byUnix)).toBe(leaveSoonCopy('School gate', 12))
    expect(leaveStageCopy('now', 'School gate', 720, byUnix)).toBe(leaveNowCopy('School gate', formatHHMM(byUnix)))
    expect(leaveStageCopy('behind', 'School gate', 720, byUnix)).toBe(leaveBehindCopy('School gate'))
  })
})

// ---------------------------------------------------------------------------
// evaluateLeaveReminder / pruneOrphanedLeaveFired orchestration — review
// fixes 1-4 (fix wave on top of Task 8). Unlike the pure section above,
// these drive the IMPURE orchestrator directly (real store, mocked
// beacons.js/notify.js/travel.js — see the module-level `vi.mock` calls up
// top), same idiom as places.test.ts's own `tick()` orchestration tests.
// ---------------------------------------------------------------------------

const PLACE_GEOHASH = encodeGeohash(51.5074, -0.1278, 9)
const HERE_FIX: Fix = { lat: 0, lon: 0, accuracy: 5, at: 1000 } // travel.js is fully mocked — coordinates are inert

function fakeFam(pkHex: string = PK_CHILD): FakeFam {
  return { role: 'child', name: 'Kid', skHex: '1'.repeat(64), pkHex }
}

/** A real, valid secp256k1 keypair (hex) — for the handful of tests below
 *  that exercise a genuine local send (`sendAgreementStatus`, which builds a
 *  real `LocalSigner` from `fam.skHex`), unlike `fakeFam`'s placeholder
 *  all-zero `skHex` (fine for tests that never sign anything). Mirrors
 *  places.test.ts's own `realKeypair`. */
function realKeypair(): { skHex: string; pkHex: string } {
  const sk = generateSecretKey()
  return { skHex: toHex(sk), pkHex: getPublicKey(sk) }
}

/** An acked agreement with a routable (geohash) place, own fresh id per call
 *  (`newAgreementId`) — `evaluateLeaveReminder`'s per-agreement module-level
 *  caches (`travelCache`/`leaveEvalInFlight`/`leaveBanners`) are keyed by
 *  agreementId, so reusing a literal id across tests in this file would
 *  leak state between them. */
function leaveReminderRecord(overrides: Partial<Agreement> = {}): AgreementRecord {
  const agreement = fakeAgreement({
    id: newAgreementId(),
    place: { label: 'School gate', geohash: PLACE_GEOHASH },
    byUnix: 10_000,
    ...overrides,
  })
  return fakeRecord({ agreement, status: 'acked' })
}

describe('evaluateLeaveReminder — notify() consolidation key (review Fix 1: \'behind\' push systematically suppressed)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(beacons.selfFix).mockReset()
    vi.mocked(beacons.selfFix).mockReturnValue(HERE_FIX)
    vi.mocked(notify).mockClear()
    vi.mocked(travel.travelSec).mockClear()
  })

  it('fires TWO distinct notify() calls for \'now\' then \'behind\' exactly 300s later — the exact LEAVE_BEHIND_LAG_SEC === CONSOLIDATE_WINDOW_SEC boundary that used to suppress \'behind\' outright', async () => {
    const record = leaveReminderRecord({ byUnix: 10_000 })
    store.update((p) => { p.agreements = [record] })
    const fam = fakeFam()

    // padSec defaults to 300 and travel.travelSec is mocked to 0s, so
    // leaveBy = byUnix - 0 - 300 = 9700; stages: soon=8800, now=9700,
    // behind=10000 (exactly 300s after 'now' — LEAVE_BEHIND_LAG_SEC).
    await evaluateLeaveReminder(store.load(), fam.pkHex, record, 9700) // 'soon' + 'now' both due; 'now' wins (collapse rule)
    await evaluateLeaveReminder(store.load(), fam.pkHex, record, 10_000) // 'behind' due, 300s later

    expect(vi.mocked(notify).mock.calls).toHaveLength(2)
    const [firstCall, secondCall] = vi.mocked(notify).mock.calls
    expect(firstCall?.[0]).toBe('leave-reminder')
    expect(firstCall?.[1]).toBe(`${record.agreement.id}:now`)
    expect(secondCall?.[0]).toBe('leave-reminder')
    expect(secondCall?.[1]).toBe(`${record.agreement.id}:behind`)
    // The bug: both calls used to pass `fam.pkHex` as the actorPk/consolidation
    // key — IDENTICAL for both stages — which 300s apart hits
    // `shouldFireNotification`'s strict `>` boundary and suppresses the
    // second (see notify.test.ts's own "collapses a repeat...at the window
    // boundary" case). Distinct per-stage keys mean the two calls never even
    // share a consolidation slot, regardless of timing.
    expect(firstCall?.[1]).not.toBe(secondCall?.[1])
  })

  it('gives two concurrent agreements for the same child distinct keys at the same stage (no cross-agreement suppression)', async () => {
    const recordA = leaveReminderRecord({ byUnix: 10_000 })
    const recordB = leaveReminderRecord({ byUnix: 10_000 })
    store.update((p) => { p.agreements = [recordA, recordB] })
    const fam = fakeFam()

    await evaluateLeaveReminder(store.load(), fam.pkHex, recordA, 9700)
    await evaluateLeaveReminder(store.load(), fam.pkHex, recordB, 9700)

    expect(vi.mocked(notify).mock.calls).toHaveLength(2)
    const [callA, callB] = vi.mocked(notify).mock.calls
    expect(callA?.[1]).toBe(`${recordA.agreement.id}:now`)
    expect(callB?.[1]).toBe(`${recordB.agreement.id}:now`)
    expect(callA?.[1]).not.toBe(callB?.[1]) // old code: both `fam.pkHex` — identical, would have collapsed
  })
})

describe('evaluateLeaveReminder — en-route suppresses ALL leave stages (final-review fix 1, §8)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(beacons.selfFix).mockReset()
    vi.mocked(beacons.selfFix).mockReturnValue(HERE_FIX)
    vi.mocked(notify).mockClear()
    vi.mocked(travel.travelSec).mockClear()
  })

  it('never notifies at behind-time once the child has reported en-route', async () => {
    const record = { ...leaveReminderRecord({ byUnix: 10_000 }), status: 'en-route' as const }
    store.update((p) => { p.agreements = [record] })
    const fam = fakeFam()

    // leaveBy=9700 (travel mocked to 0s, padSec=300), so 'behind' is due at
    // byUnix=10_000 — same timing as the acked control case below.
    await evaluateLeaveReminder(store.load(), fam.pkHex, record, 10_000)

    expect(notify).not.toHaveBeenCalled()
  })

  it('control: still notifies at behind-time while status is acked (never reported en-route)', async () => {
    const record = leaveReminderRecord({ byUnix: 10_000 }) // status: 'acked'
    store.update((p) => { p.agreements = [record] })
    const fam = fakeFam()

    await evaluateLeaveReminder(store.load(), fam.pkHex, record, 10_000)

    expect(vi.mocked(notify).mock.calls).toHaveLength(1)
    expect(vi.mocked(notify).mock.calls[0]?.[1]).toBe(`${record.agreement.id}:behind`)
  })

  it('suppresses \'behind\' when en-route is reported between the \'now\' and \'behind\' checks', async () => {
    const record = leaveReminderRecord({ byUnix: 10_000 }) // status: 'acked'
    store.update((p) => { p.agreements = [record] })
    const fam = fakeFam()

    // 'now' fires normally while still acked.
    await evaluateLeaveReminder(store.load(), fam.pkHex, record, 9700)
    expect(vi.mocked(notify).mock.calls).toHaveLength(1)
    expect(vi.mocked(notify).mock.calls[0]?.[1]).toBe(`${record.agreement.id}:now`)

    // Child taps "On my way" between the 'now' and 'behind' checks.
    store.update((p) => {
      p.agreements = p.agreements.map((r) => (r.agreement.id === record.agreement.id ? { ...r, status: 'en-route' } : r))
    })

    // checkTick's own gate would already skip a non-'acked' record before
    // ever calling this — but this calls evaluateLeaveReminder directly with
    // the STALE (still-'acked') record snapshot to exercise the function's
    // own fresh-state re-check (the same guard that also covers the in-
    // flight-travel-call race documented on that check), independent of
    // checkTick's own filtering.
    await evaluateLeaveReminder(store.load(), fam.pkHex, record, 10_000)

    expect(vi.mocked(notify).mock.calls).toHaveLength(1) // still just the one 'now' call — no 'behind'
  })
})

describe('leaveBannerFor — byUnix staleness (review Fix 2: stale \'Running behind\' banner survives extension grant)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(beacons.selfFix).mockReset()
    vi.mocked(beacons.selfFix).mockReturnValue(HERE_FIX)
    vi.mocked(notify).mockClear()
    vi.mocked(travel.travelSec).mockClear()
  })

  it('drops a banner once the agreement\'s byUnix has moved (extension granted) instead of showing stale text', async () => {
    const byUnix = 10_000
    const record = leaveReminderRecord({ byUnix })
    store.update((p) => { p.agreements = [record] })
    const fam = fakeFam()

    // leaveBy=9700, so 'behind' (leaveBy+300) is due exactly at byUnix=10_000.
    await evaluateLeaveReminder(store.load(), fam.pkHex, record, byUnix)
    expect(leaveBannerFor(record.agreement.id, byUnix)).toBe(leaveBehindCopy('School gate'))

    // Extension grant (`applyExtendResp`, ok:true) pushes byUnix out by 15
    // min — the card now renders against the NEW byUnix; the banner fired
    // against the OLD one must not survive.
    const newByUnix = byUnix + 15 * 60
    expect(leaveBannerFor(record.agreement.id, newByUnix)).toBeUndefined()
    // Actually gone, not just masked for the new byUnix — a lookup against
    // the OLD byUnix doesn't resurrect it either.
    expect(leaveBannerFor(record.agreement.id, byUnix)).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Phase 5 Task 1 follow-up (queued one-liner from the phase-4 final review):
// a "Running behind" banner must not survive a manual "I'm here" tap
// (`sendAgreementStatus(id, 'arrived')`) or an "On my way" tap/signal
// (`'en-route'`) — the child having RESPONDED. Phase 5 Task 2's own review
// queue briefly GENERALIZED this to clear on 'late' too, reasoning that any
// status transition should sweep it — but that generalization was WRONG and
// is reverted here by this task's own final review: `checkTick`'s auto-late
// branch (`isLate()` -> `sendAgreementStatus(id, 'late')`, below) funnels
// through this exact same clear, so the generalized version deleted the
// banner — the app's ONLY nudge toward requesting an extension — at the
// precise moment the deadline passes and the nudge starts to matter most.
// The banner now clears on 'en-route'/'arrived' ONLY: the child responded
// or arrived. 'late' deliberately falls through and the banner SURVIVES,
// shown alongside the late-status block. (An extension grant's `byUnix`
// change is handled separately — via `leaveBannerFor`'s own byUnix-
// staleness check, see that describe block above — not by this clear.)
// Covers all three call sites: the LOCAL tap (`sendAgreementStatus`, what
// the agreement card's "On my way"/"I'm here" buttons call, AND what
// `checkTick`'s own auto-arrival/auto-late branches call), an INCOMING
// `agreement-status` signal (`handleIncomingSignal`), and the REAL
// `checkTick` path end to end (the case the review flagged as untested — a
// direct call to `sendAgreementStatus`/`handleIncomingSignal` alone doesn't
// prove `checkTick`'s OWN `isLate()`-triggered call goes through this same
// gate).
// ---------------------------------------------------------------------------

describe('leaveBanners: cleared on en-route/arrived (child responded), KEPT through late (Phase 5 Task 1 follow-up; "late clears too" reverted by Task 2\'s own review)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(beacons.selfFix).mockReset()
    vi.mocked(beacons.selfFix).mockReturnValue(HERE_FIX)
    vi.mocked(beacons.publishOrEnqueue).mockClear()
    vi.mocked(notify).mockClear()
    vi.mocked(travel.travelSec).mockClear()
  })

  afterEach(() => {
    vi.useRealTimers() // only the checkTick real-path test below uses fake timers; harmless no-op otherwise
  })

  it('local tap: sendAgreementStatus(id, \'en-route\') clears an already-fired banner immediately, not on the next tick', async () => {
    const byUnix = 10_000
    const child = realKeypair() // sendAgreementStatus signs for real — needs a valid scalar, unlike fakeFam's placeholder skHex
    const record = leaveReminderRecord({ byUnix, child: child.pkHex })
    const circle = fakeCircle({ members: [{ pk: PK_GUARDIAN, role: 'guardian' }, { pk: child.pkHex, role: 'child' }] })
    const fam: FakeFam = { role: 'child', name: 'Kid', skHex: child.skHex, pkHex: child.pkHex }
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.agreements = [record]
    })

    // leaveBy=9700, so 'behind' (leaveBy+300) is due exactly at byUnix=10_000.
    await evaluateLeaveReminder(store.load(), fam.pkHex, record, byUnix)
    expect(leaveBannerFor(record.agreement.id, byUnix)).toBe(leaveBehindCopy('School gate'))

    await sendAgreementStatus(record.agreement.id, 'en-route')

    expect(leaveBannerFor(record.agreement.id, byUnix)).toBeUndefined()
  })

  it('incoming: an agreement-status{status:\'en-route\'} signal off the wire also clears the banner (same fix, the other call site)', async () => {
    const byUnix = 10_000
    const record = leaveReminderRecord({ byUnix })
    const circle = fakeCircle()
    const fam = fakeFam()
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.agreements = [record]
    })

    await evaluateLeaveReminder(store.load(), fam.pkHex, record, byUnix)
    expect(leaveBannerFor(record.agreement.id, byUnix)).toBe(leaveBehindCopy('School gate'))

    const sig = buildAgreementStatus({ id: record.agreement.id, status: 'en-route', by: PK_GUARDIAN }, byUnix)
    const rumor: Rumor = {
      pubkey: PK_GUARDIAN, // NOT this device's own pkHex (PK_CHILD) — a real signal, not a self-echo
      created_at: byUnix,
      kind: 20_078,
      tags: [['t', 'agreement-status']],
      content: JSON.stringify(sig),
    }

    handleIncomingSignal(circle, rumor, 'agreement-status', fakeSender(PK_GUARDIAN))

    expect(leaveBannerFor(record.agreement.id, byUnix)).toBeUndefined()
  })

  it('incoming: an agreement-status{status:\'arrived\'} signal off the wire also clears the banner (same fix, the other call site — was untested)', async () => {
    const byUnix = 10_000
    const record = leaveReminderRecord({ byUnix })
    const circle = fakeCircle()
    const fam = fakeFam()
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.agreements = [record]
    })

    await evaluateLeaveReminder(store.load(), fam.pkHex, record, byUnix)
    expect(leaveBannerFor(record.agreement.id, byUnix)).toBe(leaveBehindCopy('School gate'))

    const sig = buildAgreementStatus({ id: record.agreement.id, status: 'arrived', by: PK_GUARDIAN }, byUnix)
    const rumor: Rumor = {
      pubkey: PK_GUARDIAN, // NOT this device's own pkHex (PK_CHILD) — a real signal, not a self-echo
      created_at: byUnix,
      kind: 20_078,
      tags: [['t', 'agreement-status']],
      content: JSON.stringify(sig),
    }

    handleIncomingSignal(circle, rumor, 'agreement-status', fakeSender(PK_GUARDIAN))

    expect(leaveBannerFor(record.agreement.id, byUnix)).toBeUndefined()
  })

  it('local tap: sendAgreementStatus(id, \'arrived\') also clears an already-fired banner — the manual "I\'m here" tap that motivated the original fix', async () => {
    const byUnix = 10_000
    const child = realKeypair() // sendAgreementStatus signs for real — needs a valid scalar
    const record = leaveReminderRecord({ byUnix, child: child.pkHex })
    const circle = fakeCircle({ members: [{ pk: PK_GUARDIAN, role: 'guardian' }, { pk: child.pkHex, role: 'child' }] })
    const fam: FakeFam = { role: 'child', name: 'Kid', skHex: child.skHex, pkHex: child.pkHex }
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.agreements = [record]
    })

    await evaluateLeaveReminder(store.load(), fam.pkHex, record, byUnix)
    expect(leaveBannerFor(record.agreement.id, byUnix)).toBe(leaveBehindCopy('School gate'))

    await sendAgreementStatus(record.agreement.id, 'arrived')

    expect(leaveBannerFor(record.agreement.id, byUnix)).toBeUndefined()
  })

  it('local tap: sendAgreementStatus(id, \'late\') KEEPS an already-fired banner (Fix 1: \'late\' is precisely when the extend-request nudge matters)', async () => {
    const byUnix = 10_000
    const child = realKeypair() // sendAgreementStatus signs for real — needs a valid scalar
    const record = leaveReminderRecord({ byUnix, child: child.pkHex })
    const circle = fakeCircle({ members: [{ pk: PK_GUARDIAN, role: 'guardian' }, { pk: child.pkHex, role: 'child' }] })
    const fam: FakeFam = { role: 'child', name: 'Kid', skHex: child.skHex, pkHex: child.pkHex }
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.agreements = [record]
    })

    await evaluateLeaveReminder(store.load(), fam.pkHex, record, byUnix)
    expect(leaveBannerFor(record.agreement.id, byUnix)).toBe(leaveBehindCopy('School gate'))

    await sendAgreementStatus(record.agreement.id, 'late')

    // The bug (regression covered here): a prior generalized version of
    // `clearLeaveBanner` swept 'late' along with 'en-route'/'arrived' and
    // deleted the banner right as it became most relevant. It must survive.
    expect(leaveBannerFor(record.agreement.id, byUnix)).toBe(leaveBehindCopy('School gate'))
  })

  it('incoming: an agreement-status{status:\'late\'} signal off the wire also KEEPS the banner (same fix, the other call site)', async () => {
    const byUnix = 10_000
    const record = leaveReminderRecord({ byUnix })
    const circle = fakeCircle()
    const fam = fakeFam()
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.agreements = [record]
    })

    await evaluateLeaveReminder(store.load(), fam.pkHex, record, byUnix)
    expect(leaveBannerFor(record.agreement.id, byUnix)).toBe(leaveBehindCopy('School gate'))

    const sig = buildAgreementStatus({ id: record.agreement.id, status: 'late', by: PK_GUARDIAN }, byUnix)
    const rumor: Rumor = {
      pubkey: PK_GUARDIAN, // NOT this device's own pkHex (PK_CHILD) — a real signal, not a self-echo
      created_at: byUnix,
      kind: 20_078,
      tags: [['t', 'agreement-status']],
      content: JSON.stringify(sig),
    }

    handleIncomingSignal(circle, rumor, 'agreement-status', fakeSender(PK_GUARDIAN))

    expect(leaveBannerFor(record.agreement.id, byUnix)).toBe(leaveBehindCopy('School gate'))
  })

  it('REAL checkTick path: its own isLate() -> sendAgreementStatus(id, \'late\') auto-transition does NOT clear a fired \'behind\' banner (the exact bug the review traced — prior tests above only exercised sendAgreementStatus/handleIncomingSignal directly, never checkTick itself)', async () => {
    const byUnix = 10_000
    const child = realKeypair() // checkTick's internal sendAgreementStatus signs for real
    const record = leaveReminderRecord({ byUnix, child: child.pkHex }) // status: 'acked', place has a geohash HERE_FIX doesn't match (see hasArrivedAt describe block above)
    const circle = fakeCircle({ members: [{ pk: PK_GUARDIAN, role: 'guardian' }, { pk: child.pkHex, role: 'child' }] })
    const fam: FakeFam = { role: 'child', name: 'Kid', skHex: child.skHex, pkHex: child.pkHex }
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.agreements = [record]
    })

    // Fire the 'behind' banner first, same as every other test in this block.
    await evaluateLeaveReminder(store.load(), fam.pkHex, record, byUnix)
    expect(leaveBannerFor(record.agreement.id, byUnix)).toBe(leaveBehindCopy('School gate'))

    // Advance the real clock checkTick reads via nowSec()/Date.now() to
    // byUnix + 5min (isLate's default graceMin) + 1min — past the boundary,
    // so checkTick's own isLate() check fires true on this tick.
    vi.useFakeTimers()
    vi.setSystemTime(new Date((byUnix + 6 * 60) * 1000))

    checkTick()

    // The record actually went through the auto-late transition...
    expect(store.load().agreements.find((r) => r.agreement.id === record.agreement.id)?.status).toBe('late')
    // ...and the banner survived it — checkTick's auto-late funnels through
    // the same clearLeaveBanner gate as the local-tap/incoming-signal paths
    // tested above, and that gate excludes 'late'.
    expect(leaveBannerFor(record.agreement.id, byUnix)).toBe(leaveBehindCopy('School gate'))
  })
})

describe('evaluateLeaveReminder — travel cache identity (review Fix 3: routingUrl change not invalidating cache)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(beacons.selfFix).mockReset()
    vi.mocked(beacons.selfFix).mockReturnValue(HERE_FIX)
    vi.mocked(notify).mockClear()
    vi.mocked(travel.travelSec).mockClear()
  })

  it('recomputes travelSec when routingUrl changes, even within the 5-min cache TTL', async () => {
    const record = leaveReminderRecord({ byUnix: 10_000 })
    store.update((p) => { p.agreements = [record]; p.settings = {} }) // routingUrl unset
    const fam = fakeFam()

    // now=1000 is well before any stage is due (soon fires at 8800) — no
    // notify()/leaveFired write happens, but the cache is populated
    // unconditionally before that check.
    await evaluateLeaveReminder(store.load(), fam.pkHex, record, 1000)
    expect(vi.mocked(travel.travelSec)).toHaveBeenCalledTimes(1)

    // Same routingUrl (still unset), 1s later — well within the TTL: cache
    // hit, no second call.
    await evaluateLeaveReminder(store.load(), fam.pkHex, record, 1001)
    expect(vi.mocked(travel.travelSec)).toHaveBeenCalledTimes(1)

    // Switch engines — routingUrl now set. mode/destGeohash are unchanged
    // and we're still well within the TTL, but this MUST recompute: serving
    // the old (unset-routingUrl) estimate under a newly-configured engine is
    // exactly the bug.
    store.update((p) => { p.settings = { routingUrl: 'https://valhalla.example' } })
    await evaluateLeaveReminder(store.load(), fam.pkHex, record, 1002)
    expect(vi.mocked(travel.travelSec)).toHaveBeenCalledTimes(2)

    // And switching BACK also recomputes, rather than hitting a stale cache
    // entry left over from the very first (unset-routingUrl) call.
    store.update((p) => { p.settings = {} })
    await evaluateLeaveReminder(store.load(), fam.pkHex, record, 1003)
    expect(vi.mocked(travel.travelSec)).toHaveBeenCalledTimes(3)
  })
})

describe('pruneOrphanedLeaveFired — byUnix hygiene (review Fix 4: superseded-byUnix leaveFired entries never pruned)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })

  it('drops leaveFired entries for a live agreement\'s OLD (pre-extension) byUnix, keeps entries matching its CURRENT byUnix, and still drops entries for an agreement that no longer exists at all', () => {
    const record = leaveReminderRecord({ byUnix: 10_000 })
    const id = record.agreement.id
    store.update((p) => {
      p.agreements = [record]
      p.leaveFired = {
        [`${id}:9000:behind`]: true, // stale: a PRE-extension byUnix — must be pruned
        [`${id}:10000:soon`]: true, // current byUnix — keep
        [`${id}:10000:now`]: true, // current byUnix — keep
        'deadbeef00000000:10000:now': true, // agreement doesn't exist at all — existing prune reason, still applies
      }
    })

    pruneOrphanedLeaveFired(store.load())

    expect(store.load().leaveFired).toEqual({
      [`${id}:10000:soon`]: true,
      [`${id}:10000:now`]: true,
    })
  })

  it('leaves a fully up-to-date leaveFired map untouched (no spurious writes)', () => {
    const record = leaveReminderRecord({ byUnix: 5000 })
    const id = record.agreement.id
    store.update((p) => {
      p.agreements = [record]
      p.leaveFired = { [`${id}:5000:now`]: true }
    })

    pruneOrphanedLeaveFired(store.load())

    expect(store.load().leaveFired).toEqual({ [`${id}:5000:now`]: true })
  })
})

describe('pruneOrphanedAgreementTravelMode — final-review fix 6 (same forward hygiene as pruneOrphanedLeaveFired)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })

  it('drops entries for agreement ids that no longer exist, keeps entries for live ones', () => {
    const agreement = fakeAgreement({ id: 'agr-live' })
    store.update((p) => {
      p.agreements = [fakeRecord({ agreement, status: 'acked' })]
      p.agreementTravelMode = { 'agr-live': 'cycle', 'agr-gone': 'walk' }
    })

    pruneOrphanedAgreementTravelMode(store.load())

    expect(store.load().agreementTravelMode).toEqual({ 'agr-live': 'cycle' })
  })

  it('leaves a fully up-to-date map untouched (no spurious writes)', () => {
    const agreement = fakeAgreement({ id: 'agr-live' })
    store.update((p) => {
      p.agreements = [fakeRecord({ agreement, status: 'acked' })]
      p.agreementTravelMode = { 'agr-live': 'drive' }
    })

    pruneOrphanedAgreementTravelMode(store.load())

    expect(store.load().agreementTravelMode).toEqual({ 'agr-live': 'drive' })
  })

  it('is a no-op when agreementTravelMode is already empty', () => {
    store.update((p) => { p.agreements = []; p.agreementTravelMode = {} })
    pruneOrphanedAgreementTravelMode(store.load())
    expect(store.load().agreementTravelMode).toEqual({})
  })
})
