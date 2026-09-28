import { describe, it, expect, vi, beforeEach, beforeAll, afterEach } from 'vitest'
import {
  RADIUS_CHIPS_METRES,
  DEFAULT_GRACE_MINUTES,
  defaultGraceMinutesFor,
  MAX_PLACES,
  MAX_WINDOWS_PER_PLACE,
  DEFAULT_WINDOW_GRACE_MIN,
  newPlaceId,
  newWindowId,
  parseHHMM,
  formatDays,
  placeToGeofence,
  nearestPlace,
  buildArrivalReason,
  detectArrivalReason,
  buildDepartureReason,
  detectDepartureReason,
  graceWarningCopy,
  escalatedChildCopy,
  escalationPendingCopy,
  INITIAL_PLACE_EVAL_STATE,
  evaluatePlaces,
  checkGraceExpiry,
  checkLeaveExpiry,
  currentEscalation,
  hydratePlaceEvalState,
  placeEvalToPersisted,
  shouldSuppressEscalation,
  ESCALATION_SUPPRESS_SEC,
  type PlaceEvalState,
  buildPlacesFencesWrap,
  buildPlacesMetaPayload,
  savePlaces,
  parsePlacesMetaSignal,
  PLACES_SIGNAL_TYPE,
  handleIncomingSignal,
  registerStructuralSenders,
  tick,
  ensure,
  escalationBannerView,
  WINDOW_REMINDER_LEAD_SEC,
  WINDOW_MET_LOOKBACK_SEC,
  localDay,
  windowAction,
  windowCrossesMidnight,
  buildNotYetReason,
  detectNotYetReason,
  recordIncomingWindowEvent,
  type LocalDay,
  LEAVE_AREA_KIND,
  LEAVE_AREA_ENVELOPE_ACTION,
  LEAVE_AREA_DURATIONS_MIN,
  type LeaveAreaDurationMin,
  type LeaveAreaParams,
  isLeaveAreaRequest,
  encodeLeaveAreaParams,
  decodeLeaveAreaParams,
  leaveApprovedUntil,
  isLeaveApproved,
  applyLeaveResolution,
  pruneExpiredLeaves,
} from './places.js'
import type { Place, PersistedPlaceEval, ArrivalWindow } from './store.js'
import * as store from './store.js'
import * as beacons from './beacons.js'
import * as approvals from './approvals.js'
import { notify } from './notify.js'
import type { Fix } from './geo.js'
import { sessionForTests, currentSession } from './session.js'
import type { SignerTransport } from './remote-signer.js'
import * as queue from './structural-queue.js'
import type { Sender } from './beacons.js'
import { makeLocalSigner, deriveInbox, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftUnwrap, rawNip44Decrypt } from '@forgesworn/roost-kit'
import type { Rumor, SignedEvent } from '@forgesworn/roost-kit'
import { decryptFences } from '@forgesworn/flock/fences'
import { decodeLegacyBuzz } from './legacy-buzz.js'
import { buildApprovalReq, buildApprovalResp, parseBroodSignal } from '@forgesworn/brood-kit'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'

// tick()'s escalation retry (review C1) and arrival-buzz seeding (review I1)
// both go through beacons.ts's shared self-fix/publish surface — mocked here
// (same idiom as approvals.test.ts's `vi.mock('@forgesworn/roost-kit', ...)`)
// so the two new orchestration tests below can control exactly when a fix
// "arrives" and assert on whether/how often the wire actually got a signal,
// without touching real geolocation or a network.
vi.mock('./beacons.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./beacons.js')>()
  return { ...actual, selfFix: vi.fn(() => null), publishOrEnqueue: vi.fn(async () => {}) }
})

// Phase 3 Task 5: mocked so the window-evaluation tick() tests below (and
// `recordIncomingWindowEvent`'s freshness-gate test) can assert precisely on
// whether/how a notification fired, without depending on the test
// environment's `Notification`/native-platform behaviour (same idiom as the
// `./beacons.js` mock above).
vi.mock('./notify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notify.js')>()
  return { ...actual, notify: vi.fn(async () => {}) }
})

/** Minimal in-memory localStorage stand-in (mirrors store.test.ts's). */
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

/** A real, valid secp256k1 keypair (hex) — `tick()`'s send paths build a real
 *  `LocalSigner` from `skHex`, which needs an actual valid scalar. */
function realKeypair(): { skHex: string; pkHex: string } {
  const sk = generateSecretKey()
  return { skHex: toHex(sk), pkHex: getPublicKey(sk) }
}

// Test-only fixture shape (Signet identity plan, Task 11: identity.ts is
// gone) — every `fakeIdentity(...)` result below only ever feeds `signIn`
// in this file, never a real `SessionInfo`-typed view function, so this
// stays a plain local bag rather than reaching for session.ts's own type
// (same idiom as agreements.test.ts's own `FakeFam`).
interface FakeFam { role: 'parent' | 'child'; name: string; skHex: string; pkHex: string }

function fakeIdentity(role: 'parent' | 'child', pkHex: string, skHex: string, name = 'Kid'): FakeFam {
  return { role, name, skHex, pkHex }
}

/** A `SignerTransport` backed by a real local signer — the test-only stand-in
 *  for a My Signet remote signer, so `identitySigner()` can actually sign in
 *  a test without a live bunker/NIP-55 transport (mirrors receive.test.ts's
 *  own `localTransport`). */
function localTransport(skHex: string): SignerTransport {
  const s = makeLocalSigner(skHex)
  return {
    pubkey: s.pubkey,
    signEvent: (t) => s.signEvent(t),
    nip44Encrypt: (peer, pt) => s.nip44Encrypt(peer, pt),
    nip44Decrypt: (peer, ct) => s.nip44Decrypt(peer, ct),
    close: async () => {},
  }
}

/** Signs this device in for a test (Signet identity plan): `identityPk` is
 *  the signed-in identity, `phoneSkHex` this device's own phone key.
 *  `identitySkHex`, when given, wires a real local-signer transport behind
 *  `identitySigner()` — only tests exercising the `'places'` structural send
 *  end to end need it. */
function signIn(identityPk: string, phoneSkHex: string, dependant = false, identitySkHex?: string): void {
  sessionForTests({
    identityPk, phoneSkHex, dependant,
    ...(identitySkHex ? { transport: localTransport(identitySkHex) } : {}),
  })
}

/** A resolved sender for a circle signal — `phonePk` the sealing phone key
 *  (or, for a structural delivery, the phone that relayed it), `memberPk`
 *  the identity it resolves to, `structural` whether it's an identity-signed
 *  structural event (`'places'`) rather than phone-key traffic (arrival/
 *  departure buzzes, breach). */
function fakeSender(phonePk: string, memberPk: string = phonePk, structural = false): Sender {
  return { signerPk: phonePk, memberPk, structural }
}

const PK_GUARDIAN = 'a'.repeat(64)

function fakeCircle(overrides: Partial<Circle> = {}): Circle {
  return {
    id: 'circle-1', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
    members: [{ pk: PK_GUARDIAN, role: 'guardian' }],
    createdAt: 100, configUpdatedAt: 100, configBy: PK_GUARDIAN,
    ...overrides,
  }
}

function fakePlace(overrides: Partial<Place> = {}): Place {
  return {
    id: 'place-1', name: 'Home', type: 'home', centre: { lat: 51.5, lon: -0.1 }, radiusMetres: 100,
    arrivalNotify: true, departureNotify: false, escalation: 'grace', graceMinutes: DEFAULT_GRACE_MINUTES,
    ...overrides,
  }
}

function fakeWindow(overrides: Partial<ArrivalWindow> = {}): ArrivalWindow {
  return { id: 'win-1', days: [1, 2, 3, 4, 5], arriveBy: '08:45', graceMin: 10, enabled: true, ...overrides }
}

/** Unwraps a `sendPlaceBuzz` wire send (same NIP-59 gift-wrap every buzz in
 *  this module uses) back to its inner signal event — same pattern as
 *  messages.test.ts's own `unwrapBuzz`, duplicated locally rather than
 *  imported since messages.ts doesn't export it (it's that file's own
 *  private wire-round-trip test helper). */
async function unwrapBuzz(wrap: SignedEvent, circle: Circle): Promise<Rumor> {
  const inbox = deriveInbox(circle.seedHex)
  const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), wrap)
  expect(rumor).not.toBeNull()
  return rumor as Rumor
}

/** Offsets `centre` north by roughly `metres` (small-distance approximation
 *  — plenty precise for constructing clearly-inside/clearly-outside test
 *  fixtures against radii of a few hundred metres). */
function northOf(centre: { lat: number; lon: number }, metres: number): { lat: number; lon: number } {
  return { lat: centre.lat + metres / 111_320, lon: centre.lon }
}

describe('newPlaceId', () => {
  it('returns a non-empty hex-ish id, distinct across calls', () => {
    const a = newPlaceId()
    const b = newPlaceId()
    expect(a).toMatch(/^[0-9a-f]+$/)
    expect(a).not.toBe(b)
  })
})

describe('placeToGeofence', () => {
  it('maps a place to a flock CircleGeofence', () => {
    const place = fakePlace()
    expect(placeToGeofence(place)).toEqual({ kind: 'circle', centre: place.centre, radiusMetres: 100 })
  })
})

describe('nearestPlace', () => {
  it('returns undefined for an empty list', () => {
    expect(nearestPlace([], { lat: 0, lon: 0 })).toBeUndefined()
  })

  it('picks the geographically closest place', () => {
    const near = fakePlace({ id: 'near', centre: { lat: 51.5, lon: -0.1 } })
    const far = fakePlace({ id: 'far', centre: { lat: 52.0, lon: -0.1 } })
    const point = northOf(near.centre, 50)
    expect(nearestPlace([far, near], point)?.id).toBe('near')
  })
})

describe('arrival/departure reason prefixes', () => {
  it('round-trips an arrival reason', () => {
    expect(detectArrivalReason(buildArrivalReason('School'))).toBe('School')
  })

  it('round-trips a departure reason', () => {
    expect(detectDepartureReason(buildDepartureReason('Home'))).toBe('Home')
  })

  it('does not match unrelated text', () => {
    expect(detectArrivalReason('Left Home')).toBeUndefined()
    expect(detectDepartureReason('Arrived at School')).toBeUndefined()
    expect(detectArrivalReason('Come home now')).toBeUndefined()
  })

  it('does not confuse the fixed "Arrived"/"Leaving now" buzz-chip reasons with the dynamic prefixes', () => {
    expect(detectArrivalReason('Arrived')).toBeUndefined() // no trailing " at "
    expect(detectDepartureReason('Leaving now')).toBeUndefined() // does not start with "Left "
  })
})

describe('child-first escalation copy (global constraints §31: supportive, no accusation)', () => {
  it('the grace warning names the place and the minutes, with no accusatory language', () => {
    const copy = graceWarningCopy('School', 10)
    expect(copy).toContain('School')
    expect(copy).toContain('10 min')
    expect(copy.toLowerCase()).not.toMatch(/violat|breach|tracking/)
  })

  it('the escalated copy is informative, not accusatory', () => {
    expect(escalatedChildCopy('Home', true)).toContain('Home')
    expect(escalatedChildCopy('Home', false)).toContain('Home')
    expect(escalatedChildCopy('Home', true).toLowerCase()).not.toMatch(/violat|breach|tracking/)
  })

  // Review C1: the pending copy must never claim the guardian was told —
  // only that they WILL be — since it's shown precisely while that's still
  // unconfirmed (no fix yet to disclose).
  it('the pending copy (shown before a breach signal has actually sent) never claims "has been told", and stays non-accusatory', () => {
    const copy = escalationPendingCopy('Home')
    expect(copy).toContain('Home')
    expect(copy.toLowerCase()).not.toMatch(/has been told/)
    expect(copy.toLowerCase()).not.toMatch(/violat|breach|tracking/)
  })
})

describe('evaluatePlaces — pure escalation state machine', () => {
  it('with no places configured, always stays safe with no entered/exited/effect', () => {
    const result = evaluatePlaces([], { lat: 0, lon: 0 }, 10, 1000, INITIAL_PLACE_EVAL_STATE, true)
    expect(result).toEqual({ state: { insidePlaceIds: [], escalation: { phase: 'safe' } }, entered: [], exited: [] })
  })

  it('entering a place records it in `entered`, stays safe', () => {
    const place = fakePlace()
    const result = evaluatePlaces([place], place.centre, 5, 1000, INITIAL_PLACE_EVAL_STATE, true)
    expect(result.entered).toEqual(['place-1'])
    expect(result.exited).toEqual([])
    expect(result.state.escalation).toEqual({ phase: 'safe' })
    expect(result.escalationEffect).toBeUndefined()
  })

  it('staying inside on a later tick produces no entered/exited churn', () => {
    const place = fakePlace()
    const first = evaluatePlaces([place], place.centre, 5, 1000, INITIAL_PLACE_EVAL_STATE, true)
    const second = evaluatePlaces([place], place.centre, 5, 1030, first.state, true)
    expect(second.entered).toEqual([])
    expect(second.exited).toEqual([])
  })

  it('leaving (grace mode) starts a warn effect with a grace deadline', () => {
    const place = fakePlace({ escalation: 'grace', graceMinutes: 10 })
    const inside: PlaceEvalState = { insidePlaceIds: [place.id], escalation: { phase: 'safe' } }
    const outside = northOf(place.centre, 500) // well outside a 100m fence
    const result = evaluatePlaces([place], outside, 5, 1000, inside, true)
    expect(result.exited).toEqual(['place-1'])
    expect(result.escalationEffect).toEqual({ kind: 'warn', placeName: 'Home', graceMinutes: 10 })
    expect(result.state.escalation).toEqual({ phase: 'grace', placeName: 'Home', graceEndsAt: 1000 + 10 * 60 })
  })

  it('immediate mode skips the grace entirely, escalating on the same tick', () => {
    const place = fakePlace({ escalation: 'immediate' })
    const inside: PlaceEvalState = { insidePlaceIds: [place.id], escalation: { phase: 'safe' } }
    const outside = northOf(place.centre, 500)
    const result = evaluatePlaces([place], outside, 5, 1000, inside, true)
    expect(result.escalationEffect).toEqual({ kind: 'escalate', placeName: 'Home', immediate: true })
    expect(result.state.escalation).toEqual({ phase: 'escalated', placeName: 'Home', breachSent: false })
  })

  it('re-entering while in grace cancels silently', () => {
    const place = fakePlace()
    const grace: PlaceEvalState = { insidePlaceIds: [], escalation: { phase: 'grace', placeName: 'Home', graceEndsAt: 1600 } }
    const result = evaluatePlaces([place], place.centre, 5, 1200, grace, true)
    expect(result.escalationEffect).toEqual({ kind: 'cancel' })
    expect(result.state.escalation).toEqual({ phase: 'safe' })
  })

  it('escalationEnabled=false (a guardian\'s own device) never produces an escalation effect, even leaving a place', () => {
    const place = fakePlace({ escalation: 'immediate' })
    const inside: PlaceEvalState = { insidePlaceIds: [place.id], escalation: { phase: 'safe' } }
    const outside = northOf(place.centre, 500)
    const result = evaluatePlaces([place], outside, 5, 1000, inside, false)
    expect(result.exited).toEqual(['place-1'])
    expect(result.escalationEffect).toBeUndefined()
    expect(result.state.escalation).toEqual({ phase: 'safe' })
  })

  it('already mid-episode (grace) does not re-decide on a subsequent still-outside fix', () => {
    const place = fakePlace()
    const grace: PlaceEvalState = { insidePlaceIds: [], escalation: { phase: 'grace', placeName: 'Home', graceEndsAt: 1600 } }
    const outside = northOf(place.centre, 500)
    const result = evaluatePlaces([place], outside, 5, 1200, grace, true)
    expect(result.escalationEffect).toBeUndefined()
    expect(result.state.escalation).toEqual(grace.escalation)
  })

  it('multiple places, overlapping unions: leaving the SMALLER of two concentric places while still inside the LARGER stays safe', () => {
    const centre = { lat: 51.5, lon: -0.1 }
    const inner = fakePlace({ id: 'inner', name: 'Yard', centre, radiusMetres: 100 })
    const outer = fakePlace({ id: 'outer', name: 'Block', centre, radiusMetres: 500 })
    const prior: PlaceEvalState = { insidePlaceIds: ['inner', 'outer'], escalation: { phase: 'safe' } }
    const stillInOuterOnly = northOf(centre, 200) // outside the 100m fence, inside the 500m one
    const result = evaluatePlaces([inner, outer], stillInOuterOnly, 5, 1000, prior, true)
    expect(result.exited).toEqual(['inner'])
    expect(result.entered).toEqual([])
    expect(result.escalationEffect).toBeUndefined()
    expect(result.state.escalation).toEqual({ phase: 'safe' })
  })

  it('leaving the union entirely (both places) starts grace, using the larger configured grace of the just-exited places', () => {
    const centre = { lat: 51.5, lon: -0.1 }
    const a = fakePlace({ id: 'a', name: 'A', centre, radiusMetres: 100, escalation: 'grace', graceMinutes: 5 })
    const b = fakePlace({ id: 'b', name: 'B', centre, radiusMetres: 200, escalation: 'grace', graceMinutes: 15 })
    const prior: PlaceEvalState = { insidePlaceIds: ['a', 'b'], escalation: { phase: 'safe' } }
    const farAway = northOf(centre, 1000)
    const result = evaluatePlaces([a, b], farAway, 5, 1000, prior, true)
    expect(result.escalationEffect).toEqual({ kind: 'warn', placeName: 'A', graceMinutes: 15 })
  })

  it('a confidently-uncertain fix (accuracy straddling the fence edge) holds the current phase, but still updates raw entered/exited', () => {
    const place = fakePlace({ radiusMetres: 100 })
    // Exactly at the centre, but with an accuracy disc (200m) wider than the
    // fence itself — classifyContainment can assert neither "wholly inside"
    // nor "wholly outside" (see geofence.ts's own doc comment).
    const result = evaluatePlaces([place], place.centre, 200, 1000, INITIAL_PLACE_EVAL_STATE, true)
    expect(result.state.escalation).toEqual({ phase: 'safe' }) // unchanged, not advanced
    expect(result.entered).toEqual(['place-1']) // raw geometry is accuracy-independent
  })

  it('with no prior "inside" recorded (e.g. app cold-starts already outside), a fresh exit falls back to treating every configured place as relevant', () => {
    const place = fakePlace({ escalation: 'immediate' })
    const outside = northOf(place.centre, 500)
    const result = evaluatePlaces([place], outside, 5, 1000, INITIAL_PLACE_EVAL_STATE, true)
    expect(result.escalationEffect).toEqual({ kind: 'escalate', placeName: 'Home', immediate: true })
  })

  // Review I1 fix: a reload always hydrates `insidePlaceIds: []`, so without
  // seeding, the FIRST evaluated fix each session would diff against an
  // empty memory and treat "currently inside" as "just arrived" (and,
  // symmetrically, "currently outside" as "just departed").
  describe('seedOnly (review I1 fix) — baseline-seeds insidePlaceIds without emitting entered/exited', () => {
    it('suppresses entered even though currently inside, but still records insidePlaceIds for future diffing', () => {
      const place = fakePlace()
      const result = evaluatePlaces([place], place.centre, 5, 1000, INITIAL_PLACE_EVAL_STATE, true, true)
      expect(result.entered).toEqual([])
      expect(result.exited).toEqual([])
      expect(result.state.insidePlaceIds).toEqual(['place-1'])
      expect(result.escalationEffect).toBeUndefined() // escalation itself is untouched by seeding
    })

    it('suppresses exited even though currently outside (the symmetric spurious-departure case)', () => {
      const place = fakePlace()
      const outside = northOf(place.centre, 500)
      const inside: PlaceEvalState = { insidePlaceIds: [place.id], escalation: { phase: 'safe' } }
      const result = evaluatePlaces([place], outside, 5, 1000, inside, true, true)
      expect(result.exited).toEqual([])
      expect(result.state.insidePlaceIds).toEqual([])
    })

    it('does not suppress a SUBSEQUENT (non-seed) tick\'s real entered/exited', () => {
      const place = fakePlace()
      const seeded = evaluatePlaces([place], place.centre, 5, 1000, INITIAL_PLACE_EVAL_STATE, true, true)
      const outside = northOf(place.centre, 500)
      const result = evaluatePlaces([place], outside, 5, 1030, seeded.state, true, false)
      expect(result.exited).toEqual(['place-1'])
    })

    it('defaults to false (existing call sites are unaffected) when the parameter is omitted', () => {
      const place = fakePlace()
      const result = evaluatePlaces([place], place.centre, 5, 1000, INITIAL_PLACE_EVAL_STATE, true)
      expect(result.entered).toEqual(['place-1'])
    })
  })
})

describe('checkGraceExpiry', () => {
  const grace: PlaceEvalState = { insidePlaceIds: [], escalation: { phase: 'grace', placeName: 'Home', graceEndsAt: 1000 } }

  it('no-ops before the deadline', () => {
    const result = checkGraceExpiry(grace, 999)
    expect(result.state).toBe(grace)
    expect(result.effect).toBeUndefined()
  })

  it('no-ops when not in grace at all', () => {
    const safe: PlaceEvalState = { insidePlaceIds: [], escalation: { phase: 'safe' } }
    expect(checkGraceExpiry(safe, 5000)).toEqual({ state: safe })
  })

  it('escalates exactly at (and past) the deadline, with breachSent starting false (review C1: reaching escalated is not the same as having sent)', () => {
    const at = checkGraceExpiry(grace, 1000)
    expect(at.effect).toEqual({ kind: 'escalate', placeName: 'Home', immediate: false })
    expect(at.state.escalation).toEqual({ phase: 'escalated', placeName: 'Home', breachSent: false })

    const past = checkGraceExpiry(grace, 1500)
    expect(past.effect).toEqual({ kind: 'escalate', placeName: 'Home', immediate: false })
  })
})

describe('currentEscalation (Task 8, brief §25\'s "any active safety escalation" privacy-overview row)', () => {
  it('is "safe" for a circle whose child-side evaluation has never run (module-level default)', () => {
    expect(currentEscalation('never-seen-circle-id')).toEqual({ phase: 'safe' })
  })
})

// Reload safety (Task 7 follow-up fix, post-review): without persisting the
// escalation phase, a child could force-close the app during a grace
// countdown to reset it indefinitely and never trigger the guardian signal.
describe('hydratePlaceEvalState — reload-mid-grace resumes, not restarts', () => {
  it('resumes an in-progress grace countdown with its ORIGINAL deadline (not a freshly-started one)', () => {
    const persisted: PersistedPlaceEval = { phase: 'grace', placeName: 'Home', graceEndsAt: 5000 }
    expect(hydratePlaceEvalState(persisted)).toEqual({
      insidePlaceIds: [],
      escalation: { phase: 'grace', placeName: 'Home', graceEndsAt: 5000 },
    })
  })

  it('a still-future graceEndsAt survives a checkGraceExpiry check unchanged (still counting down, not escalated early)', () => {
    const persisted: PersistedPlaceEval = { phase: 'grace', placeName: 'Home', graceEndsAt: 5000 }
    const resumed = hydratePlaceEvalState(persisted)
    const result = checkGraceExpiry(resumed, 4000) // well before the deadline
    expect(result.effect).toBeUndefined()
    expect(result.state).toEqual(resumed)
  })

  it('reload-after-grace-expiry: a graceEndsAt already in the past escalates on the very next check', () => {
    const persisted: PersistedPlaceEval = { phase: 'grace', placeName: 'School', graceEndsAt: 1000 }
    const resumed = hydratePlaceEvalState(persisted)
    const result = checkGraceExpiry(resumed, 9000) // the app was closed well past the deadline
    expect(result.effect).toEqual({ kind: 'escalate', placeName: 'School', immediate: false })
    expect(result.state.escalation).toEqual({ phase: 'escalated', placeName: 'School', breachSent: false })
  })

  it('resumes an already-escalated episode (immediate mode, or grace that already expired last session) so it is never re-decided as a fresh exit', () => {
    const persisted: PersistedPlaceEval = { phase: 'escalated', placeName: 'Home' }
    expect(hydratePlaceEvalState(persisted)).toEqual({
      insidePlaceIds: [],
      escalation: { phase: 'escalated', placeName: 'Home', breachSent: false },
    })
  })

  it('an undefined record (never left, or already cleared by re-entry) hydrates to the fresh "safe" default', () => {
    expect(hydratePlaceEvalState(undefined)).toBe(INITIAL_PLACE_EVAL_STATE)
  })

  it('fails safe to the fresh default on a malformed grace record (missing graceEndsAt) rather than resuming nonsense', () => {
    const malformed = { phase: 'grace', placeName: 'Home' } as unknown as PersistedPlaceEval
    expect(hydratePlaceEvalState(malformed)).toBe(INITIAL_PLACE_EVAL_STATE)
  })

  // Review C1 fix: `breachSent` tracks whether the guardian-facing breach
  // signal has actually gone out for an 'escalated' episode — distinct from
  // merely having REACHED that phase.
  it('an escalated record with breachSent: true resumes as already-satisfied (no retry needed)', () => {
    const persisted: PersistedPlaceEval = { phase: 'escalated', placeName: 'Home', breachSent: true }
    expect(hydratePlaceEvalState(persisted)).toEqual({
      insidePlaceIds: [],
      escalation: { phase: 'escalated', placeName: 'Home', breachSent: true },
    })
  })

  it('an escalated record from an OLD, pre-fix format (breachSent absent entirely) coerces to false — the safe default, not a crash', () => {
    const oldFormat = { phase: 'escalated', placeName: 'Home' } as PersistedPlaceEval
    expect(hydratePlaceEvalState(oldFormat).escalation).toEqual({ phase: 'escalated', placeName: 'Home', breachSent: false })
  })
})

describe('placeEvalToPersisted — re-entry clears persisted state', () => {
  it('a "safe" state maps to undefined (the caller deletes the persisted entry)', () => {
    const safe: PlaceEvalState = { insidePlaceIds: [], escalation: { phase: 'safe' } }
    expect(placeEvalToPersisted(safe)).toBeUndefined()
  })

  it('a "grace" state persists its placeName + exact graceEndsAt', () => {
    const grace: PlaceEvalState = { insidePlaceIds: [], escalation: { phase: 'grace', placeName: 'Park', graceEndsAt: 4200 } }
    expect(placeEvalToPersisted(grace)).toEqual({ phase: 'grace', placeName: 'Park', graceEndsAt: 4200 })
  })

  it('an "escalated" state persists its placeName, no graceEndsAt, and its breachSent bit (review C1)', () => {
    const pending: PlaceEvalState = { insidePlaceIds: [], escalation: { phase: 'escalated', placeName: 'Park', breachSent: false } }
    expect(placeEvalToPersisted(pending)).toEqual({ phase: 'escalated', placeName: 'Park', breachSent: false })
    const sent: PlaceEvalState = { insidePlaceIds: [], escalation: { phase: 'escalated', placeName: 'Park', breachSent: true } }
    expect(placeEvalToPersisted(sent)).toEqual({ phase: 'escalated', placeName: 'Park', breachSent: true })
  })

  it('round-trips through hydratePlaceEvalState for both non-safe phases', () => {
    const grace: PersistedPlaceEval = { phase: 'grace', placeName: 'Home', graceEndsAt: 999 }
    expect(placeEvalToPersisted(hydratePlaceEvalState(grace))).toEqual(grace)
    const escalated: PersistedPlaceEval = { phase: 'escalated', placeName: 'Home', breachSent: true }
    expect(placeEvalToPersisted(hydratePlaceEvalState(escalated))).toEqual(escalated)
  })

  it('a genuine re-entry (evaluatePlaces observing "inside" after a hydrated grace) maps back to undefined — the full "resume then clear" flow', () => {
    const place = fakePlace({ name: 'Home' })
    const persisted: PersistedPlaceEval = { phase: 'grace', placeName: 'Home', graceEndsAt: 5000 }
    const resumed = hydratePlaceEvalState(persisted)
    const backInside = evaluatePlaces([place], place.centre, 5, 4000, resumed, true)
    expect(backInside.state.escalation).toEqual({ phase: 'safe' })
    expect(backInside.escalationEffect).toEqual({ kind: 'cancel' })
    expect(placeEvalToPersisted(backInside.state)).toBeUndefined()
  })
})

describe('shouldSuppressEscalation — immediate-mode reload does not duplicate a breach within the suppression window', () => {
  it('never suppresses when there is no prior escalation at all', () => {
    expect(shouldSuppressEscalation(undefined, 10_000)).toBe(false)
  })

  it('suppresses a repeat within the window (task contract: "say, 30 min")', () => {
    expect(ESCALATION_SUPPRESS_SEC).toBe(30 * 60)
    expect(shouldSuppressEscalation(1000, 1000 + ESCALATION_SUPPRESS_SEC - 1)).toBe(true)
  })

  it('does not suppress once the window has fully elapsed', () => {
    expect(shouldSuppressEscalation(1000, 1000 + ESCALATION_SUPPRESS_SEC)).toBe(false)
    expect(shouldSuppressEscalation(1000, 1000 + ESCALATION_SUPPRESS_SEC + 1)).toBe(false)
  })

  it('respects a custom window', () => {
    expect(shouldSuppressEscalation(1000, 1500, 1000)).toBe(true) // 500s later, 1000s window
    expect(shouldSuppressEscalation(1000, 2500, 1000)).toBe(false) // 1500s later, 1000s window
  })
})

describe('RADIUS_CHIPS_METRES / DEFAULT_GRACE_MINUTES / MAX_PLACES — task-contract defaults', () => {
  it('offers exactly the three specified radius chips', () => {
    expect(RADIUS_CHIPS_METRES).toEqual([100, 250, 500])
  })

  it('defaults the grace period to 10 minutes', () => {
    expect(DEFAULT_GRACE_MINUTES).toBe(10)
  })

  // Phase 6 final-review finding 6: a new place's grace default should
  // follow the circle's own independence-level default (`levelDefaults`,
  // written by milestones.ts's `applyLevel`) when one exists, else fall back
  // to this file's own generic default — see `defaultGraceMinutesFor`'s own
  // doc comment. milestones.test.ts's own `applyLevel` test exercises the
  // end-to-end "a level apply changes what a NEW place defaults to" case;
  // this is the pure function in isolation.
  it('defaultGraceMinutesFor falls back to DEFAULT_GRACE_MINUTES when the circle has no levelDefaults entry', () => {
    const p = { levelDefaults: {} } as unknown as Parameters<typeof defaultGraceMinutesFor>[0]
    expect(defaultGraceMinutesFor(p, 'circle-1')).toBe(DEFAULT_GRACE_MINUTES)
  })

  it('defaultGraceMinutesFor uses the circle\'s own levelDefaults entry when one exists', () => {
    const p = { levelDefaults: { 'circle-1': { graceMinutes: 5 } } } as unknown as Parameters<typeof defaultGraceMinutesFor>[0]
    expect(defaultGraceMinutesFor(p, 'circle-1')).toBe(5)
  })

  it('caps well under flock\'s own MAX_FENCES (50)', () => {
    expect(MAX_PLACES).toBeLessThanOrEqual(50)
  })
})

describe('wire round trip — fences (flock-interop) and this module\'s own places-metadata companion', () => {
  it('the fences signal round-trips through gift-wrap + FLOCK\'S OWN decryptFences parser, geometry-only', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const places: Place[] = [
      fakePlace({ id: 'p1', name: 'Home', centre: { lat: 51.5, lon: -0.1 }, radiusMetres: 100 }),
      fakePlace({ id: 'p2', name: 'School', centre: { lat: 51.51, lon: -0.11 }, radiusMetres: 250 }),
    ]
    const fences = await buildPlacesFencesWrap(signer, circle, places, 5000, PK_GUARDIAN)
    expect(fences.kind).toBe(1059) // outer NIP-59 gift wrap

    const inbox = deriveInbox(circle.seedHex)
    const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), fences)
    expect(rumor).not.toBeNull()

    const set = await decryptFences(circle.seedHex, (rumor as Rumor).content)
    expect(set.updatedAt).toBe(5000)
    expect(set.by).toBe(PK_GUARDIAN)
    expect(set.fences).toEqual([
      { kind: 'circle', centre: { lat: 51.5, lon: -0.1 }, radiusMetres: 100 },
      { kind: 'circle', centre: { lat: 51.51, lon: -0.11 }, radiusMetres: 250 },
    ])
  })

  it('the places-metadata companion round-trips the FULL place set (name/toggles/escalation included) — now a plain structural payload, no gift-wrap of its own (Signet identity plan, Task 9)', () => {
    const circle = fakeCircle()
    const places: Place[] = [fakePlace({ id: 'p1', name: 'Home', arrivalNotify: true, departureNotify: true, escalation: 'immediate' })]
    const payload = buildPlacesMetaPayload(circle.id, places, 5000, PK_GUARDIAN)
    const decoded = parsePlacesMetaSignal(payload, circle.id)
    expect(decoded).toEqual({ places, updatedAt: 5000, by: PK_GUARDIAN })
  })
})

describe('parsePlacesMetaSignal — strict validation, malformed rejected wholesale', () => {
  const good = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [fakePlace()], updatedAt: 100, by: PK_GUARDIAN })

  it('accepts a well-formed signal', () => {
    expect(parsePlacesMetaSignal(good, 'circle-1')).not.toBeNull()
  })

  it('rejects invalid JSON', () => {
    expect(parsePlacesMetaSignal('{not json', 'circle-1')).toBeNull()
  })

  it('rejects the wrong `t`', () => {
    const bad = JSON.stringify({ t: 'fences', circleId: 'circle-1', places: [], updatedAt: 100, by: PK_GUARDIAN })
    expect(parsePlacesMetaSignal(bad, 'circle-1')).toBeNull()
  })

  it('rejects a mismatched circleId', () => {
    expect(parsePlacesMetaSignal(good, 'circle-other')).toBeNull()
  })

  it('rejects the whole set when ONE place entry is malformed (never partially applies)', () => {
    const bad = JSON.stringify({
      t: PLACES_SIGNAL_TYPE, circleId: 'circle-1',
      places: [fakePlace({ id: 'ok' }), { id: 'bad' /* missing everything else */ }],
      updatedAt: 100, by: PK_GUARDIAN,
    })
    expect(parsePlacesMetaSignal(bad, 'circle-1')).toBeNull()
  })

  it('rejects an oversized place array', () => {
    const many = Array.from({ length: MAX_PLACES + 1 }, (_, i) => fakePlace({ id: `p${i}` }))
    const bad = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: many, updatedAt: 100, by: PK_GUARDIAN })
    expect(parsePlacesMetaSignal(bad, 'circle-1')).toBeNull()
  })

  it('rejects an unknown place type / escalation mode', () => {
    const badType = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [{ ...fakePlace(), type: 'castle' }], updatedAt: 100, by: PK_GUARDIAN })
    expect(parsePlacesMetaSignal(badType, 'circle-1')).toBeNull()
    const badEscalation = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [{ ...fakePlace(), escalation: 'panic' }], updatedAt: 100, by: PK_GUARDIAN })
    expect(parsePlacesMetaSignal(badEscalation, 'circle-1')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Phase 3 Task 4: arrival windows — model, parse, and formatting. Pure,
// unit-tested directly (formatDays/parseHHMM/newWindowId) or through the
// existing `parsePlacesMetaSignal` harness (arrivalWindows validation),
// exactly the same "reject the whole set on any malformed entry" discipline
// `parsePlacesMetaSignal`'s own describe block above already establishes for
// a malformed PLACE — this extends it one level down, to a malformed WINDOW
// inside an otherwise-good place.
// ---------------------------------------------------------------------------

describe('newWindowId', () => {
  it('returns a non-empty hex-ish id, distinct across calls', () => {
    const a = newWindowId()
    const b = newWindowId()
    expect(a).toMatch(/^[0-9a-f]+$/)
    expect(a).not.toBe(b)
  })
})

describe('MAX_WINDOWS_PER_PLACE / DEFAULT_WINDOW_GRACE_MIN — task-contract defaults', () => {
  it('caps at 4 windows per place', () => {
    expect(MAX_WINDOWS_PER_PLACE).toBe(4)
  })

  it('defaults window grace to 10 minutes', () => {
    expect(DEFAULT_WINDOW_GRACE_MIN).toBe(10)
  })
})

describe('parseHHMM', () => {
  it('parses a valid HH:MM into seconds-of-day', () => {
    expect(parseHHMM('00:00')).toBe(0)
    expect(parseHHMM('08:45')).toBe(8 * 3600 + 45 * 60)
    expect(parseHHMM('23:59')).toBe(23 * 3600 + 59 * 60)
  })

  it('rejects malformed strings', () => {
    expect(parseHHMM('8:45')).toBeNull() // not zero-padded
    expect(parseHHMM('08:5')).toBeNull()
    expect(parseHHMM('08:45:00')).toBeNull()
    expect(parseHHMM('0845')).toBeNull()
    expect(parseHHMM('')).toBeNull()
    expect(parseHHMM('ab:cd')).toBeNull()
  })

  it('rejects out-of-range hours/minutes', () => {
    expect(parseHHMM('24:00')).toBeNull()
    expect(parseHHMM('12:60')).toBeNull()
    expect(parseHHMM('-1:00')).toBeNull()
  })
})

describe('formatDays — Mon-first friendly day-range formatter', () => {
  it('collapses a contiguous weekday run', () => {
    expect(formatDays([1, 2, 3, 4, 5])).toBe('Mon–Fri')
  })

  it('collapses a contiguous weekend run', () => {
    expect(formatDays([6, 0])).toBe('Sat–Sun')
  })

  it('renders a single day plainly (no dash)', () => {
    expect(formatDays([3])).toBe('Wed')
  })

  it('renders all seven days as "Every day"', () => {
    expect(formatDays([0, 1, 2, 3, 4, 5, 6])).toBe('Every day')
  })

  it('joins non-contiguous days with commas, Mon-first regardless of input order', () => {
    expect(formatDays([5, 1, 3])).toBe('Mon, Wed, Fri')
  })
})

// Review-minor #6: windows are day-scoped by design (see windowCrossesMidnight's
// own doc comment) — an arriveBy+grace combination that would push the fire
// deadline at or past midnight can never actually fire on the day it's
// scheduled for, so the add-window editor rejects it up front rather than
// silently accepting a rule that can't work.
describe('windowCrossesMidnight — day-scoped windows, editor guard (Phase 3 Task 7 follow-up)', () => {
  it('does not cross for an ordinary daytime deadline+grace', () => {
    expect(windowCrossesMidnight('08:45', 10)).toBe(false)
    expect(windowCrossesMidnight('17:00', 30)).toBe(false)
  })

  it('crosses when the deadline+grace lands exactly at midnight', () => {
    expect(windowCrossesMidnight('23:30', 30)).toBe(true) // 23:30 + 30min = 24:00 exactly
  })

  it('does not cross one minute before that boundary', () => {
    expect(windowCrossesMidnight('23:29', 30)).toBe(false) // 23:59 + 0s slack under 24:00
  })

  it('crosses when the deadline+grace lands well past midnight', () => {
    expect(windowCrossesMidnight('23:59', 30)).toBe(true)
  })

  it('a deadline already at 23:59 with zero grace does not cross (never reaches 24:00)', () => {
    expect(windowCrossesMidnight('23:59', 0)).toBe(false)
  })

  it('a malformed arriveBy fails safe to false (the editor\'s own arriveBy check runs first)', () => {
    expect(windowCrossesMidnight('8:45', 10)).toBe(false)
    expect(windowCrossesMidnight('', 10)).toBe(false)
  })
})

describe('parsePlacesMetaSignal — arrivalWindows validation (Phase 3 Task 4)', () => {
  it('round-trips a place carrying windows', () => {
    const windows = [fakeWindow(), fakeWindow({ id: 'win-2', days: [0, 6], arriveBy: '18:00', graceMin: 15, enabled: false })]
    const good = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [fakePlace({ arrivalWindows: windows })], updatedAt: 100, by: PK_GUARDIAN })
    const decoded = parsePlacesMetaSignal(good, 'circle-1')
    expect(decoded?.places[0]?.arrivalWindows).toEqual(windows)
  })

  it('accepts a place with arrivalWindows entirely absent', () => {
    const good = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [fakePlace()], updatedAt: 100, by: PK_GUARDIAN })
    const decoded = parsePlacesMetaSignal(good, 'circle-1')
    expect(decoded?.places[0]?.arrivalWindows).toBeUndefined()
  })

  it('rejects the whole set when a window has an out-of-range day (7)', () => {
    const bad = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [fakePlace({ arrivalWindows: [fakeWindow({ days: [7] })] })], updatedAt: 100, by: PK_GUARDIAN })
    expect(parsePlacesMetaSignal(bad, 'circle-1')).toBeNull()
  })

  it('rejects the whole set when a window has a negative day (-1)', () => {
    const bad = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [fakePlace({ arrivalWindows: [fakeWindow({ days: [-1] })] })], updatedAt: 100, by: PK_GUARDIAN })
    expect(parsePlacesMetaSignal(bad, 'circle-1')).toBeNull()
  })

  it('rejects the whole set when a window has duplicate days', () => {
    const bad = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [fakePlace({ arrivalWindows: [fakeWindow({ days: [1, 1] })] })], updatedAt: 100, by: PK_GUARDIAN })
    expect(parsePlacesMetaSignal(bad, 'circle-1')).toBeNull()
  })

  it('rejects the whole set when a window has zero days', () => {
    const bad = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [fakePlace({ arrivalWindows: [fakeWindow({ days: [] })] })], updatedAt: 100, by: PK_GUARDIAN })
    expect(parsePlacesMetaSignal(bad, 'circle-1')).toBeNull()
  })

  it('rejects the whole set when a window has a malformed time', () => {
    const bad = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [fakePlace({ arrivalWindows: [fakeWindow({ arriveBy: '8:45' })] })], updatedAt: 100, by: PK_GUARDIAN })
    expect(parsePlacesMetaSignal(bad, 'circle-1')).toBeNull()
  })

  it('rejects a place with more than MAX_WINDOWS_PER_PLACE windows', () => {
    const many = Array.from({ length: MAX_WINDOWS_PER_PLACE + 1 }, (_, i) => fakeWindow({ id: `win-${i}` }))
    const bad = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [fakePlace({ arrivalWindows: many })], updatedAt: 100, by: PK_GUARDIAN })
    expect(parsePlacesMetaSignal(bad, 'circle-1')).toBeNull()
  })

  // Review-minor #4: the boundary case one BELOW the reject threshold above
  // — exactly MAX_WINDOWS_PER_PLACE windows on one place must round-trip,
  // not just "fewer than the reject count" in general.
  it('accepts a place with exactly MAX_WINDOWS_PER_PLACE windows', () => {
    const exactly = Array.from({ length: MAX_WINDOWS_PER_PLACE }, (_, i) => fakeWindow({ id: `win-${i}` }))
    const good = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [fakePlace({ arrivalWindows: exactly })], updatedAt: 100, by: PK_GUARDIAN })
    const decoded = parsePlacesMetaSignal(good, 'circle-1')
    expect(decoded?.places[0]?.arrivalWindows).toHaveLength(MAX_WINDOWS_PER_PLACE)
  })

  it('rejects a window with a non-boolean enabled', () => {
    const bad = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [{ ...fakePlace(), arrivalWindows: [{ ...fakeWindow(), enabled: 'yes' }] }], updatedAt: 100, by: PK_GUARDIAN })
    expect(parsePlacesMetaSignal(bad, 'circle-1')).toBeNull()
  })

  it('rejects a window with an out-of-range graceMin (upper bound: 121)', () => {
    const bad = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [fakePlace({ arrivalWindows: [fakeWindow({ graceMin: 121 })] })], updatedAt: 100, by: PK_GUARDIAN })
    expect(parsePlacesMetaSignal(bad, 'circle-1')).toBeNull()
  })

  // Review-minor #4: the lower-bound companion to the 121 case above —
  // `parseArrivalWindow`'s `r.graceMin < 0` check has no test pinning the
  // negative side at all before this.
  it('rejects a window with a negative graceMin (-1)', () => {
    const bad = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [fakePlace({ arrivalWindows: [fakeWindow({ graceMin: -1 })] })], updatedAt: 100, by: PK_GUARDIAN })
    expect(parsePlacesMetaSignal(bad, 'circle-1')).toBeNull()
  })

  it('accepts a window with graceMin exactly 0 (the lower bound itself is valid)', () => {
    const good = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places: [fakePlace({ arrivalWindows: [fakeWindow({ graceMin: 0 })] })], updatedAt: 100, by: PK_GUARDIAN })
    expect(parsePlacesMetaSignal(good, 'circle-1')).not.toBeNull()
  })

  it('rejects one malformed window among otherwise-good places (never partially applies)', () => {
    const bad = JSON.stringify({
      t: PLACES_SIGNAL_TYPE, circleId: 'circle-1',
      places: [fakePlace({ id: 'ok', arrivalWindows: [fakeWindow()] }), fakePlace({ id: 'p2', arrivalWindows: [fakeWindow({ days: [7] })] })],
      updatedAt: 100, by: PK_GUARDIAN,
    })
    expect(parsePlacesMetaSignal(bad, 'circle-1')).toBeNull()
  })
})

describe('handleIncomingSignal — meta `by` sender-auth binding (ffb48b9 class)', () => {
  const PK_OTHER = 'b'.repeat(64)

  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function placesRumor(pubkey: string, places: Place[], updatedAt: number, by: string): Rumor {
    return {
      id: `rumor-${updatedAt}-${by}`,
      pubkey,
      kind: 20078,
      content: JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', places, updatedAt, by }),
      tags: [['t', PLACES_SIGNAL_TYPE]],
      created_at: updatedAt,
    } as unknown as Rumor
  }

  it('applies a genuine update (`by` === rumor.pubkey)', () => {
    const circle = fakeCircle()
    const places = [fakePlace()]
    handleIncomingSignal(circle, placesRumor(PK_OTHER, places, 5000, PK_OTHER), PLACES_SIGNAL_TYPE, fakeSender(PK_OTHER, PK_OTHER, true))
    const p = store.load()
    expect(p.places[circle.id]).toEqual(places)
    expect(p.placesMeta[circle.id]).toEqual({ updatedAt: 5000, by: PK_OTHER })
  })

  it('drops a forged update (`by` names someone other than the actual sender) — nothing applied', () => {
    // Validly "wrapped" (rumor.pubkey === PK_OTHER, the real sender) but the
    // content's own `by` field dishonestly claims PK_GUARDIAN authored it —
    // e.g. to win a future clock-tie tiebreak as the guardian, or simply to
    // misattribute the change.
    const circle = fakeCircle()
    const places = [fakePlace()]
    handleIncomingSignal(circle, placesRumor(PK_OTHER, places, 5000, PK_GUARDIAN), PLACES_SIGNAL_TYPE, fakeSender(PK_OTHER, PK_OTHER, true))
    const p = store.load()
    expect(p.places[circle.id]).toBeUndefined()
    expect(p.placesMeta[circle.id]).toBeUndefined()
  })

  // Task 9 fix round 1, finding 7: `'places'` is a STRUCTURAL action —
  // beacons.ts's receive choke point already drops a phone-signed structural
  // `t` before any handler sees it, but this handler repeats the check
  // itself, belt-and-braces (same discipline as every other structural
  // handler in this codebase) — proves it, even with an otherwise-genuine
  // `by` match.
  it('ignores a places update delivered non-structurally (sender.structural: false), even with a genuine by match', () => {
    const circle = fakeCircle()
    const places = [fakePlace()]
    handleIncomingSignal(circle, placesRumor(PK_OTHER, places, 5000, PK_OTHER), PLACES_SIGNAL_TYPE, fakeSender(PK_OTHER, PK_OTHER, false))
    const p = store.load()
    expect(p.places[circle.id]).toBeUndefined()
    expect(p.placesMeta[circle.id]).toBeUndefined()
  })
})

// Task 9 fix round 1, finding 7: `savePlaces` publishes TWO wire signals —
// the phone-key `fences` wrap (mocked via this file's own
// `vi.mock('./beacons.js', ...)`, `publishOrEnqueue`) and, since the Signet
// identity plan's Task 9, the identity-signed structural `'places'` action,
// via `structural-queue.ts`'s `enqueue` — not `beacons.publishOrEnqueue`, so
// asserting on the mock alone would miss it. Enqueue-only (no drain): a full
// sign-and-publish round trip needs a real identity transport and a mocked
// relay, out of scope for this minor coverage gap.
describe('savePlaces — structural enqueue (Task 9 fix round 1, finding 7)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    queue.resetForTests()
    sessionForTests(null)
    vi.mocked(beacons.publishOrEnqueue).mockClear()
  })

  it('final fix round 3, F2: enqueues the new place set as a structural \'places\' action and changes nothing locally until it is sent', async () => {
    const circle = fakeCircle()
    signIn(PK_GUARDIAN, toHex(generateSecretKey()), false)
    store.save({ ...store.load(), circles: [circle] })

    const places = [fakePlace()]
    await savePlaces(circle.id, places)

    expect(store.load().places[circle.id]).toBeUndefined()
    expect(store.load().placesMeta[circle.id]).toBeUndefined()

    const queued = queue.pending().find((q) => q.action === 'places')
    expect(queued?.circleId).toBe(circle.id)
    expect(JSON.parse(queued?.payload ?? 'null')).toMatchObject({ t: PLACES_SIGNAL_TYPE, circleId: circle.id, by: PK_GUARDIAN })
  })

  it('no-ops for a non-guardian device — nothing persisted, nothing enqueued', async () => {
    const other = 'c'.repeat(64)
    const circle = fakeCircle() // `other` is not a member at all
    signIn(other, toHex(generateSecretKey()), false)
    store.save({ ...store.load(), circles: [circle] })

    await savePlaces(circle.id, [fakePlace()])

    expect(store.load().places[circle.id]).toBeUndefined()
    expect(queue.pending().find((q) => q.action === 'places')).toBeUndefined()
  })

  it('final fix B1/I1: does not publish the flock fences wrap synchronously from savePlaces itself — nothing goes out before the identity-signed update is even queued/signed', async () => {
    const circle = fakeCircle()
    signIn(PK_GUARDIAN, toHex(generateSecretKey()), false) // no identitySkHex -> can never actually sign
    store.save({ ...store.load(), circles: [circle] })
    registerStructuralSenders()

    await savePlaces(circle.id, [fakePlace()])

    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled()
  })

  it('final fix B1/I1: on a successful drain, the \'places\' sender sends the identity-signed update THEN the flock fences wrap, carrying the same places/updatedAt/by that were actually signed', async () => {
    const circle = fakeCircle()
    signIn(PK_GUARDIAN, toHex(generateSecretKey()), false, toHex(generateSecretKey()))
    store.save({ ...store.load(), circles: [circle] })
    registerStructuralSenders()

    // sendStructural's own internal publish call bypasses the `./beacons.js`
    // mock above (a same-module reference, not this test's import) — spied
    // rather than asserted on via the mock, just to prove ordering: it must
    // run BEFORE the fences wrap goes out (the actual fix), not merely that
    // it runs at all.
    const order: string[] = []
    const realSendStructural = beacons.sendStructural
    vi.spyOn(beacons, 'sendStructural').mockImplementation(async (c, signed) => {
      order.push('struct')
      return realSendStructural(c, signed)
    })
    vi.mocked(beacons.publishOrEnqueue).mockImplementation(async () => {
      // Final fix round 3, F2: applied locally after the send, before the fences.
      order.push(store.load().places[circle.id] ? 'fences (applied)' : 'fences (not applied)')
    })

    const places = [fakePlace()]
    await savePlaces(circle.id, places)
    await queue.drain()

    expect(order).toEqual(['struct', 'fences (applied)'])
    expect(store.load().places[circle.id]).toEqual(places)
    expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1)
    const fencesWrapCall = vi.mocked(beacons.publishOrEnqueue).mock.calls[0]
    const fencesWrap = fencesWrapCall?.[1] as SignedEvent
    const inbox = deriveInbox(circle.seedHex)
    const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), fencesWrap)
    expect(rumor).not.toBeNull()
    const set = await decryptFences(circle.seedHex, (rumor as Rumor).content)
    expect(set.fences).toEqual([placeToGeofence(places[0] as Place)])
    expect(set.by).toBe(PK_GUARDIAN)
  })

  it('final fix round 4: sign-out while the places send is in flight — the next session\'s store gets nothing and no fences wrap goes out', async () => {
    const circle = fakeCircle()
    signIn(PK_GUARDIAN, toHex(generateSecretKey()), false, toHex(generateSecretKey()))
    store.save({ ...store.load(), circles: [circle] })
    registerStructuralSenders()
    let release!: () => void
    let started!: () => void
    const inFlight = new Promise<void>((r) => { started = r })
    vi.spyOn(beacons, 'sendStructural').mockImplementationOnce(async () => { started(); await new Promise<void>((r) => { release = r }) })

    await savePlaces(circle.id, [fakePlace()])
    const drained = queue.drain()
    await inFlight
    store.clear()
    sessionForTests(null)
    signIn('e'.repeat(64), toHex(generateSecretKey()), false)
    store.save({ ...store.load(), circles: [fakeCircle()] })
    release()
    await drained

    expect(store.load().places[circle.id]).toBeUndefined()
    expect(store.load().placesMeta[circle.id]).toBeUndefined()
    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled()
  })

  it('final fix round 3, F2: a cancelled places update has nothing to undo and never publishes the fences wrap — a co-guardian\'s newer places that arrived meanwhile stand', async () => {
    const PK_CO = 'b'.repeat(64)
    const circle = fakeCircle({ members: [{ pk: PK_GUARDIAN, role: 'guardian' }, { pk: PK_CO, role: 'guardian' }] })
    const existingPlaces = [fakePlace({ id: 'existing-place' })]
    signIn(PK_GUARDIAN, toHex(generateSecretKey()), false) // no transport -> never signs
    store.save({ ...store.load(), circles: [circle], places: { [circle.id]: existingPlaces }, placesMeta: { [circle.id]: { updatedAt: 50, by: PK_GUARDIAN } } })
    registerStructuralSenders()

    await savePlaces(circle.id, [fakePlace({ id: 'new-place' })])
    expect(store.load().places[circle.id]).toEqual(existingPlaces)

    const theirs = [fakePlace({ id: 'co-guardian-place' })]
    const newerAt = Math.floor(Date.now() / 1000) + 5
    const rumor: Rumor = { id: 'rumor-co', pubkey: PK_CO, kind: 20078, content: JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: circle.id, places: theirs, updatedAt: newerAt, by: PK_CO }), tags: [['t', PLACES_SIGNAL_TYPE]], created_at: newerAt }
    handleIncomingSignal(circle, rumor, PLACES_SIGNAL_TYPE, fakeSender(PK_CO, PK_CO, true))
    expect(store.load().places[circle.id]).toEqual(theirs)

    queue.cancel(queue.pending().find((q) => q.action === 'places')!.id) // the UI's Cancel on "Waiting for My Signet"

    expect(store.load().places[circle.id]).toEqual(theirs)
    expect(store.load().placesMeta[circle.id]).toEqual({ updatedAt: newerAt, by: PK_CO })
    // The identity-signed update never went out, so neither did the fences
    // geometry (a flock-interop client never sees unauthorised fences).
    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// localDay / windowAction / buildNotYetReason / detectNotYetReason —
// Phase 3 Task 5's pure evaluation core. No store/beacons/localStorage
// needed for any of these — see each function's own doc comment for why.
// ---------------------------------------------------------------------------

describe('localDay — the one impure-adjacent seam', () => {
  it('derives dayStamp/secOfDay/dayOfWeek from a fixed local Date', () => {
    // 2024-03-14 is a Thursday (dayOfWeek 4).
    const d = new Date(2024, 2, 14, 8, 45, 30)
    expect(localDay(d)).toEqual({ dayStamp: '2024-03-14', secOfDay: 8 * 3600 + 45 * 60 + 30, dayOfWeek: 4 })
  })

  it('zero-pads a single-digit month and day in dayStamp', () => {
    const d = new Date(2024, 0, 5, 0, 0, 0) // 2024-01-05
    expect(localDay(d).dayStamp).toBe('2024-01-05')
  })

  it('midnight is secOfDay 0', () => {
    expect(localDay(new Date(2024, 5, 1, 0, 0, 0)).secOfDay).toBe(0)
  })
})

describe('windowAction — pure decision matrix (Phase 3 Task 5)', () => {
  const w = fakeWindow() // Mon–Fri, arriveBy 08:45, 10 min grace
  const deadline = 8 * 3600 + 45 * 60 // 08:45 in seconds-of-day
  const graceSec = w.graceMin * 60

  function dayAt(secOfDay: number, dayOfWeek = 1, dayStamp = '2024-01-01'): LocalDay {
    return { dayStamp, secOfDay, dayOfWeek }
  }

  it('a day-of-week outside w.days is always none, whatever the time or inside state', () => {
    const sunday = dayAt(deadline, 0)
    expect(windowAction(w, false, undefined, sunday)).toBe('none')
    expect(windowAction(w, true, undefined, sunday)).toBe('none')
  })

  it('a disabled window is always none, even well past its deadline+grace', () => {
    const disabled = fakeWindow({ enabled: false })
    expect(windowAction(disabled, false, undefined, dayAt(deadline + 10_000))).toBe('none')
  })

  it('a mark already met today short-circuits to none, whatever insideNow says', () => {
    const met = { day: '2024-01-01', met: true as const }
    expect(windowAction(w, false, met, dayAt(deadline + 10_000))).toBe('none')
    expect(windowAction(w, true, met, dayAt(deadline))).toBe('none')
  })

  it('inside, before the met-lookback window opens, is none', () => {
    expect(windowAction(w, true, undefined, dayAt(deadline - WINDOW_MET_LOOKBACK_SEC - 1))).toBe('none')
  })

  it('inside, once the met-lookback window opens, marks met', () => {
    expect(windowAction(w, true, undefined, dayAt(deadline - WINDOW_MET_LOOKBACK_SEC))).toBe('mark-met')
  })

  it('remind window edges: 901s before the deadline is none, 900s before is remind', () => {
    expect(windowAction(w, false, undefined, dayAt(deadline - WINDOW_REMINDER_LEAD_SEC - 1))).toBe('none')
    expect(windowAction(w, false, undefined, dayAt(deadline - WINDOW_REMINDER_LEAD_SEC))).toBe('remind')
  })

  it('already reminded today does not remind again', () => {
    const reminded = { day: '2024-01-01', reminded: true as const }
    expect(windowAction(w, false, reminded, dayAt(deadline - WINDOW_REMINDER_LEAD_SEC))).toBe('none')
  })

  it('past the deadline but before grace elapses is the quiet gap — none', () => {
    expect(windowAction(w, false, undefined, dayAt(deadline + 1))).toBe('none')
    expect(windowAction(w, false, undefined, dayAt(deadline + graceSec - 1))).toBe('none')
  })

  it('fires exactly at deadline+grace, not a second before', () => {
    expect(windowAction(w, false, undefined, dayAt(deadline + graceSec))).toBe('fire')
  })

  it('already fired today does not fire again', () => {
    const fired = { day: '2024-01-01', fired: true as const }
    expect(windowAction(w, false, fired, dayAt(deadline + graceSec + 500))).toBe('none')
  })

  it('fired-then-inside (within the met-lookback) closes as late-arrival, not a second mark-met', () => {
    const fired = { day: '2024-01-01', fired: true as const }
    expect(windowAction(w, true, fired, dayAt(deadline - WINDOW_MET_LOOKBACK_SEC))).toBe('late-arrival')
  })

  it('a stale (yesterday) mark counts as absent — met/fired from a prior day never suppress today', () => {
    const staleMet = { day: '2023-12-31', met: true as const }
    expect(windowAction(w, true, staleMet, dayAt(deadline - WINDOW_MET_LOOKBACK_SEC))).toBe('mark-met')
    const staleFired = { day: '2023-12-31', fired: true as const }
    expect(windowAction(w, false, staleFired, dayAt(deadline + graceSec))).toBe('fire')
    expect(windowAction(w, true, staleFired, dayAt(deadline - WINDOW_MET_LOOKBACK_SEC))).toBe('mark-met') // NOT late-arrival — yesterday's fired doesn't carry over
  })
})

describe('buildNotYetReason / detectNotYetReason — round trip (Phase 3 Task 5)', () => {
  it('round-trips a place name and an arrival time', () => {
    const reason = buildNotYetReason('School', '08:45')
    expect(reason).toBe("Hasn't arrived at School yet (expected by 08:45)")
    expect(detectNotYetReason(reason)).toEqual({ place: 'School', time: '08:45' })
  })

  it('round-trips an empty place name (same "returned as \'\', not undefined" idiom as detectArrivalReason)', () => {
    const reason = buildNotYetReason('', '18:00')
    expect(detectNotYetReason(reason)).toEqual({ place: '', time: '18:00' })
  })

  it('does not match arrival/departure reasons or unrelated text', () => {
    expect(detectNotYetReason('Arrived at School')).toBeUndefined()
    expect(detectNotYetReason('Left Home')).toBeUndefined()
    expect(detectNotYetReason('Come home now')).toBeUndefined()
    expect(detectNotYetReason('')).toBeUndefined()
  })

  it('rejects a reason missing the "(expected by ...)" suffix, even with the right prefix', () => {
    expect(detectNotYetReason("Hasn't arrived at School yet")).toBeUndefined()
  })
})

describe('recordIncomingWindowEvent — guardian receive (Phase 3 Task 5)', () => {
  const PK_CHILD = 'b'.repeat(64)

  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(notify).mockClear()
  })

  it('records Activity kind window-missed with place/time params, keyed to the actor', () => {
    const circle = fakeCircle({ members: [{ pk: PK_GUARDIAN, role: 'guardian', name: 'Alex' }, { pk: PK_CHILD, role: 'child', name: 'Bailey' }] })
    const at = Math.floor(Date.now() / 1000)
    recordIncomingWindowEvent(circle, PK_CHILD, 'School', '08:45', at)
    const evt = store.load().activity.find((e) => e.kind === 'window-missed')
    expect(evt?.actorPk).toBe(PK_CHILD)
    expect(evt?.params).toEqual({ place: 'School', time: '08:45' })
  })

  it('notifies with the member name and expected time, freshness-gated (fresh fires, stale does not)', () => {
    const circle = fakeCircle({ members: [{ pk: PK_GUARDIAN, role: 'guardian' }, { pk: PK_CHILD, role: 'child', name: 'Bailey' }] })
    const fresh = Math.floor(Date.now() / 1000)
    recordIncomingWindowEvent(circle, PK_CHILD, 'School', '08:45', fresh)
    expect(notify).toHaveBeenCalledWith('window-missed', PK_CHILD, "Bailey hasn't arrived at School yet", 'Expected by 08:45 · Test circle')

    vi.mocked(notify).mockClear()
    const stale = fresh - 20_000 // well past NOTIFY_FRESH_SEC
    recordIncomingWindowEvent(circle, PK_CHILD, 'School', '08:45', stale)
    expect(notify).not.toHaveBeenCalled()
  })

  it('dedupes a replayed event (same id) — never double-records or double-notifies', () => {
    const circle = fakeCircle({ members: [{ pk: PK_GUARDIAN, role: 'guardian' }, { pk: PK_CHILD, role: 'child', name: 'Bailey' }] })
    const at = Math.floor(Date.now() / 1000)
    recordIncomingWindowEvent(circle, PK_CHILD, 'School', '08:45', at)
    vi.mocked(notify).mockClear()
    recordIncomingWindowEvent(circle, PK_CHILD, 'School', '08:45', at)
    expect(store.load().activity.filter((e) => e.kind === 'window-missed')).toHaveLength(1)
    expect(notify).not.toHaveBeenCalled()
  })

  it('review fix: two windows at DIFFERENT places, same circle/actor/timestamp, both insert — place is part of the id', () => {
    const circle = fakeCircle({ members: [{ pk: PK_GUARDIAN, role: 'guardian' }, { pk: PK_CHILD, role: 'child', name: 'Bailey' }] })
    const at = Math.floor(Date.now() / 1000)
    recordIncomingWindowEvent(circle, PK_CHILD, 'School', '08:45', at)
    recordIncomingWindowEvent(circle, PK_CHILD, 'Home', '08:45', at)
    const evts = store.load().activity.filter((e) => e.kind === 'window-missed')
    expect(evts).toHaveLength(2)
    expect(evts.map((e) => e.params.place).sort()).toEqual(['Home', 'School'])
  })
})

// ---------------------------------------------------------------------------
// tick() orchestration — final-review C1 + I1 fixes. Unlike everything
// above, these drive the IMPURE orchestrator directly (real store, mocked
// beacons.js) — the pure state-machine tests already prove the escalation
// DECISION is correct; these prove the wire-send/claim/persistence
// bookkeeping around it is too, which is exactly where both findings lived.
// Scoped under one outer `describe` so the localStorage/beacons-mock reset
// below only applies to these orchestration tests, not the pure ones above.
// ---------------------------------------------------------------------------

describe('tick() orchestration (final review C1 + I1)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(beacons.selfFix).mockReset()
    vi.mocked(beacons.selfFix).mockReturnValue(null)
    vi.mocked(beacons.publishOrEnqueue).mockReset()
    vi.mocked(beacons.publishOrEnqueue).mockResolvedValue(undefined)
    vi.mocked(notify).mockClear()
  })

describe('tick() — review C1 fix: cold-launch escalation retries the breach send until a fix exists', () => {
  it('does not send/stamp/claim with no fix yet, then sends exactly once a fix arrives, and never again', async () => {
    const circleId = 'circle-cold-launch'
    const child = realKeypair()
    const fam = fakeIdentity('child', child.pkHex, child.skHex)
    const circle = fakeCircle({ id: circleId, members: [{ pk: child.pkHex, role: 'child' }] })
    const place = fakePlace({ id: 'home' })
    const key = `${circleId}:${place.name}`
    const pastDeadline = Math.floor(Date.now() / 1000) - 5

    // Simulates the exact C1 scenario: the grace deadline already expired
    // while the app was closed (T7's own hydration/resume behaviour,
    // verified separately above) — the persisted phase is 'grace', not yet
    // 'escalated', because that transition only happens once `checkGraceExpiry`
    // runs on the first post-launch tick.
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.places = { [circleId]: [place] }
      p.placeEval = { [circleId]: { phase: 'grace', placeName: place.name, graceEndsAt: pastDeadline } }
    })

    // First tick after "launch" — no geolocation fix has reported in yet.
    await tick()

    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled()
    expect(store.load().placeLastEscalatedAt[key]).toBeUndefined()
    expect(currentEscalation(circleId)).toEqual({ phase: 'escalated', placeName: place.name, breachSent: false })
    expect(store.load().activity.some((e) => e.kind === 'safe-area-escalation')).toBe(false)
    const bannerBefore = escalationBannerView(store.load())
    expect(bannerBefore).toContain('Home')
    expect(bannerBefore.toLowerCase()).not.toMatch(/has been told/) // UI claim must be honest pre-send

    // A fix finally arrives — still outside (the child hasn't returned).
    const outside = northOf(place.centre, 500)
    const fix: Fix = { lat: outside.lat, lon: outside.lon, accuracy: 5, at: Math.floor(Date.now() / 1000) }
    vi.mocked(beacons.selfFix).mockReturnValue(fix)
    await tick()

    expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1)
    expect(store.load().placeLastEscalatedAt[key]).toBeDefined()
    expect(currentEscalation(circleId)).toEqual({ phase: 'escalated', placeName: place.name, breachSent: true })
    expect(store.load().activity.some((e) => e.kind === 'safe-area-escalation')).toBe(true)
    const bannerAfter = escalationBannerView(store.load())
    expect(bannerAfter.toLowerCase()).toMatch(/has been told/) // UI claim is truthful post-send

    // A further tick (still outside, fix still available) must not re-send.
    await tick()
    expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1)
  })
})

describe('tick() — review I1 fix: relaunch inside an arrivalNotify place does not re-broadcast a stale arrival', () => {
  it('a fresh session\'s first (already-inside) fix seeds silently; a genuine later exit+return still buzzes exactly once', async () => {
    const circleId = 'circle-relaunch-inside'
    const child = realKeypair()
    const fam = fakeIdentity('child', child.pkHex, child.skHex)
    const circle = fakeCircle({ id: circleId, members: [{ pk: child.pkHex, role: 'child' }] })
    const place = fakePlace({ id: 'home', arrivalNotify: true, departureNotify: true })

    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.places = { [circleId]: [place] }
    })

    const inside: Fix = { lat: place.centre.lat, lon: place.centre.lon, accuracy: 5, at: Math.floor(Date.now() / 1000) }
    vi.mocked(beacons.selfFix).mockReturnValue(inside)

    // Relaunch while already inside — the exact I1 scenario. Must NOT
    // re-broadcast "Arrived at Home".
    await tick()
    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled()
    expect(store.load().activity.filter((e) => e.kind === 'arrival')).toHaveLength(0)

    // Steady state (still inside, second tick) — unchanged.
    await tick()
    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled()

    // A genuine departure — must still buzz (the seeding fix must not
    // suppress REAL edges going forward). Arrival/departure buzzes are
    // fire-and-forget (`void sendPlaceBuzz(...)`, unlike the C1 fix's
    // awaited `ensureBreachSent`) — `recordLocalPlaceActivity` runs
    // synchronously within `tick()` either way, but `publishOrEnqueue`'s own
    // call needs `vi.waitFor` to observe reliably.
    const outside = northOf(place.centre, 500)
    vi.mocked(beacons.selfFix).mockReturnValue({ lat: outside.lat, lon: outside.lon, accuracy: 5, at: Math.floor(Date.now() / 1000) })
    await tick()
    expect(store.load().activity.filter((e) => e.kind === 'departure')).toHaveLength(1)
    expect(store.load().activity.filter((e) => e.kind === 'arrival')).toHaveLength(0)
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1))

    // A genuine return — this IS a real arrival and must buzz.
    vi.mocked(beacons.selfFix).mockReturnValue(inside)
    await tick()
    expect(store.load().activity.filter((e) => e.kind === 'arrival')).toHaveLength(1)
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(2))
  })
})

describe('ensureBreachSent in-flight guard (re-review Minor: "no in-flight guard on ensureBreachSent")', () => {
  it('a hanging breach publish + an overlapping second tick still sends exactly once', async () => {
    const circleId = 'circle-hang'
    const child = realKeypair()
    const fam = fakeIdentity('child', child.pkHex, child.skHex)
    const circle = fakeCircle({ id: circleId, members: [{ pk: child.pkHex, role: 'child' }] })
    const place = fakePlace({ id: 'home' })
    const pastDeadline = Math.floor(Date.now() / 1000) - 5

    // Same C1 cold-launch-style setup: grace already expired, so the very
    // first tick escalates and immediately attempts the breach send.
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.places = { [circleId]: [place] }
      p.placeEval = { [circleId]: { phase: 'grace', placeName: place.name, graceEndsAt: pastDeadline } }
    })

    const outside = northOf(place.centre, 500)
    const fix: Fix = { lat: outside.lat, lon: outside.lon, accuracy: 5, at: Math.floor(Date.now() / 1000) }
    vi.mocked(beacons.selfFix).mockReturnValue(fix)

    // publishOrEnqueue hangs (simulates review's "publish takes >30s"
    // scenario) — collects every resolver rather than just the latest, so
    // that if the guard regressed and a second send genuinely went out, this
    // test still resolves (and fails on the call-count assertion) instead of
    // hanging forever on an unresolved first promise.
    const resolvers: Array<() => void> = []
    vi.mocked(beacons.publishOrEnqueue).mockImplementation(() => new Promise((resolve) => { resolvers.push(resolve) }))

    // First tick: escalates this tick (grace deadline already past) and
    // starts sending the breach signal — which hangs inside publishOrEnqueue.
    const firstTick = tick()
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1))
    expect(currentEscalation(circleId)).toEqual({ phase: 'escalated', placeName: place.name, breachSent: false })

    // A second, OVERLAPPING tick while the first send is still outstanding —
    // the exact race the guard defends against. Without it, this would
    // re-enter ensureBreachSent and call publishOrEnqueue a second time
    // before the first has resolved.
    const secondTick = tick()
    await secondTick

    // Let every hanging publish resolve, then let the first tick finish.
    resolvers.forEach((resolve) => resolve())
    await firstTick

    expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1)
    expect(currentEscalation(circleId)).toEqual({ phase: 'escalated', placeName: place.name, breachSent: true })
    expect(store.load().activity.filter((e) => e.kind === 'safe-area-escalation')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// tick() — arrival window evaluation (Phase 3 Task 5). Same real-store/
// mocked-beacons/mocked-notify harness as the C1/I1 tests just above, PLUS
// fake timers (`vi.setSystemTime`) — `windowAction`'s decision depends on
// device-local day/time, which only `localDay(new Date())` inside
// `evaluateArrivalWindows` can supply, so these tests pin the clock rather
// than threading a fixture through. 2024-01-01 is a Monday (matches
// `fakeWindow`'s default Mon–Fri `days`).
// ---------------------------------------------------------------------------

describe('tick() — arrival window evaluation (Phase 3 Task 5)', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('remind: child-local notify + Activity only, no wire signal, marks reminded', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2024, 0, 1, 8, 45, 0)) // 900s before a 09:00 deadline
    const circleId = 'circle-window-remind'
    const child = realKeypair()
    const fam = fakeIdentity('child', child.pkHex, child.skHex)
    const w = fakeWindow({ id: 'w-remind', arriveBy: '09:00' })
    const place = fakePlace({ id: 'place-remind', arrivalWindows: [w] })
    const circle = fakeCircle({ id: circleId, members: [{ pk: child.pkHex, role: 'child' }] })
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.places = { [circleId]: [place] }
    })

    await tick()

    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled()
    expect(notify).toHaveBeenCalledWith('window-reminder', null, 'Expected at Home by 09:00', circle.name)
    const evt = store.load().activity.find((e) => e.kind === 'window-reminder')
    expect(evt?.params).toEqual({ place: 'Home', time: '09:00' })
    expect(evt?.actorPk).toBe(child.pkHex)
    expect(store.load().arrivalWindowMarks['w-remind']).toEqual({ day: '2024-01-01', reminded: true })

    // Same instant, a second tick — already reminded today, must not repeat.
    vi.mocked(notify).mockClear()
    await tick()
    expect(notify).not.toHaveBeenCalled()
  })

  it('fire: sends the not-yet buzz (wire-identical reason) + self Activity + child notify, marks fired', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2024, 0, 1, 9, 10, 0)) // 09:00 deadline + 10 min grace, exactly
    const circleId = 'circle-window-fire'
    const child = realKeypair()
    const fam = fakeIdentity('child', child.pkHex, child.skHex)
    const w = fakeWindow({ id: 'w-fire', arriveBy: '09:00', graceMin: 10 })
    const place = fakePlace({ id: 'place-fire', name: 'School', arrivalWindows: [w] })
    const circle = fakeCircle({ id: circleId, members: [{ pk: child.pkHex, role: 'child' }] })
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.places = { [circleId]: [place] }
    })

    await tick()
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1))

    const wrap = vi.mocked(beacons.publishOrEnqueue).mock.calls[0]?.[1] as SignedEvent
    const rumor = await unwrapBuzz(wrap, circle)
    const buzz = await decodeLegacyBuzz(circle.seedHex, rumor.content)
    expect(buzz.reason).toBe(buildNotYetReason('School', '09:00')) // wire-identical to what a flock client would render as chat
    expect(buzz.target).toBeUndefined() // untargeted — the whole circle sees it, same as an arrival/departure buzz

    const evt = store.load().activity.find((e) => e.kind === 'window-missed' && e.actorPk === child.pkHex)
    expect(evt?.params).toEqual({ place: 'School', time: '09:00' })
    expect(notify).toHaveBeenCalledWith('window-missed', null, "Your circle was told you're not at School yet", circle.name)
    expect(store.load().arrivalWindowMarks['w-fire']).toEqual({ day: '2024-01-01', fired: true })

    // Same instant, a second tick — already fired today, must not repeat.
    vi.mocked(beacons.publishOrEnqueue).mockClear()
    vi.mocked(notify).mockClear()
    await tick()
    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('late-arrival: a fired window that\'s then arrived at buzzes a real arrival EVEN with arrivalNotify off, and records window-met', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2024, 0, 1, 9, 10, 0))
    const circleId = 'circle-window-late-arrival'
    const child = realKeypair()
    const fam = fakeIdentity('child', child.pkHex, child.skHex)
    const w = fakeWindow({ id: 'w-late', arriveBy: '09:00', graceMin: 10 })
    const place = fakePlace({ id: 'place-late', name: 'School', arrivalNotify: false, arrivalWindows: [w] })
    const circle = fakeCircle({ id: circleId, members: [{ pk: child.pkHex, role: 'child' }] })
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.places = { [circleId]: [place] }
    })

    // First tick (no fix yet) fires the "not yet" buzz — the fired-then-
    // arrived setup.
    await tick()
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1))
    expect(store.load().arrivalWindowMarks['w-late']).toEqual({ day: '2024-01-01', fired: true })

    // A fix finally arrives — inside the place, still within the same day's
    // met-lookback window. `place.arrivalNotify` is OFF, yet the task
    // contract requires the closing arrival buzz to go out regardless.
    vi.mocked(beacons.publishOrEnqueue).mockClear()
    vi.mocked(beacons.selfFix).mockReturnValue({ lat: place.centre.lat, lon: place.centre.lon, accuracy: 5, at: Math.floor(Date.now() / 1000) })
    await tick()
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1)) // exactly one — not also a duplicate from the plain entered-loop

    const wrap = vi.mocked(beacons.publishOrEnqueue).mock.calls[0]?.[1] as SignedEvent
    const rumor = await unwrapBuzz(wrap, circle)
    const buzz = await decodeLegacyBuzz(circle.seedHex, rumor.content)
    expect(buzz.reason).toBe(buildArrivalReason('School')) // the REAL arrival buzz, not a second "not yet"

    expect(store.load().activity.find((e) => e.kind === 'window-met')?.params).toEqual({ place: 'School' })
    expect(store.load().activity.some((e) => e.kind === 'arrival')).toBe(false) // arrivalNotify:false suppressed the ORDINARY arrival path — this buzz came from the window closure alone
    expect(store.load().arrivalWindowMarks['w-late']).toEqual({ day: '2024-01-01', fired: true, met: true })
  })

  it('review fix: late-arrival + arrivalNotify:true + a fresh entry sends exactly ONE arrival buzz (not a duplicate from the entered-loop), still records window-met', async () => {
    vi.useFakeTimers()
    const circleId = 'circle-window-late-arrival-notify'
    const child = realKeypair()
    const fam = fakeIdentity('child', child.pkHex, child.skHex)
    const w = fakeWindow({ id: 'w-late-notify', arriveBy: '09:00', graceMin: 10 })
    const place = fakePlace({ id: 'place-late-notify', name: 'School', arrivalNotify: true, arrivalWindows: [w] })
    const circle = fakeCircle({ id: circleId, members: [{ pk: child.pkHex, role: 'child' }] })
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.places = { [circleId]: [place] }
    })

    // Seed tick, past the deadline but before deadline+grace, WITH a real
    // (outside) fix — this circle's first-ever live fix is `seedOnly` (see
    // `seededCircles`'s own doc comment), so `insidePlaceIds` baselines to
    // "outside" here without emitting an `entered`. Without this seed tick,
    // the "inside" fix below would ALSO land as this circle's first-ever fix
    // and its transition would be suppressed the very same way — masking the
    // bug this test exists to catch. Deliberately only 5 minutes ahead of the
    // fire tick below (not e.g. an hour) — `fakePlace`'s own escalation
    // policy ('grace', `DEFAULT_GRACE_MINUTES` = 10) starts counting down the
    // moment this seed tick sees "outside", and it must NOT expire into a
    // real breach signal before the fire tick: that would add an unrelated
    // `publishOrEnqueue` call and contaminate the exactly-one-buzz assertion
    // below, which is this test's whole point.
    vi.setSystemTime(new Date(2024, 0, 1, 9, 5, 0))
    const outside = northOf(place.centre, 500)
    vi.mocked(beacons.selfFix).mockReturnValue({ lat: outside.lat, lon: outside.lon, accuracy: 5, at: Math.floor(Date.now() / 1000) })
    await tick()
    expect(store.load().arrivalWindowMarks['w-late-notify']).toBeUndefined()

    // Deadline + grace, still outside — fires the "not yet" buzz.
    vi.setSystemTime(new Date(2024, 0, 1, 9, 10, 0))
    await tick()
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1))
    expect(store.load().arrivalWindowMarks['w-late-notify']).toEqual({ day: '2024-01-01', fired: true })

    // A fix arrives inside the place — a genuine FRESH entry this time (the
    // circle is already seeded), with `arrivalNotify` ON, in the SAME tick
    // the window closes as late-arrival. Both the entered-loop and the
    // late-arrival branch would send an arrival buzz absent the review fix
    // — assert only one wire send happens.
    vi.mocked(beacons.publishOrEnqueue).mockClear()
    vi.mocked(beacons.selfFix).mockReturnValue({ lat: place.centre.lat, lon: place.centre.lon, accuracy: 5, at: Math.floor(Date.now() / 1000) })
    await tick()
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1))

    // Give any wrongly-fired second send a chance to land before asserting
    // the count stays at exactly one.
    await Promise.resolve()
    expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1)

    const wrap = vi.mocked(beacons.publishOrEnqueue).mock.calls[0]?.[1] as SignedEvent
    const rumor = await unwrapBuzz(wrap, circle)
    const buzz = await decodeLegacyBuzz(circle.seedHex, rumor.content)
    expect(buzz.reason).toBe(buildArrivalReason('School'))

    expect(store.load().activity.find((e) => e.kind === 'window-met')?.params).toEqual({ place: 'School' })
    expect(store.load().arrivalWindowMarks['w-late-notify']).toEqual({ day: '2024-01-01', fired: true, met: true })
  })

  it('mark-met: arriving inside the met-lookback window silently marks the day met — no wire signal, no extra notify', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2024, 0, 1, 8, 30, 0)) // 30 min before a 09:00 deadline — inside the 60 min lookback
    const circleId = 'circle-window-mark-met'
    const child = realKeypair()
    const fam = fakeIdentity('child', child.pkHex, child.skHex)
    const w = fakeWindow({ id: 'w-met', arriveBy: '09:00' })
    const place = fakePlace({ id: 'place-met', arrivalNotify: false, arrivalWindows: [w] })
    const circle = fakeCircle({ id: circleId, members: [{ pk: child.pkHex, role: 'child' }] })
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.places = { [circleId]: [place] }
    })
    vi.mocked(beacons.selfFix).mockReturnValue({ lat: place.centre.lat, lon: place.centre.lon, accuracy: 5, at: Math.floor(Date.now() / 1000) })

    await tick()

    expect(store.load().arrivalWindowMarks['w-met']).toEqual({ day: '2024-01-01', met: true })
    expect(store.load().activity.some((e) => ['window-met', 'window-reminder', 'window-missed'].includes(e.kind))).toBe(false)
    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('self-pruning: writing a fresh mark for today overwrites a stale (prior-day) entry for the same window id', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2024, 0, 1, 8, 45, 0)) // remind window for a 09:00 deadline
    const circleId = 'circle-window-stale-mark'
    const child = realKeypair()
    const fam = fakeIdentity('child', child.pkHex, child.skHex)
    const w = fakeWindow({ id: 'w-stale', arriveBy: '09:00' })
    const place = fakePlace({ id: 'place-stale', arrivalWindows: [w] })
    const circle = fakeCircle({ id: circleId, members: [{ pk: child.pkHex, role: 'child' }] })
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.places = { [circleId]: [place] }
      p.arrivalWindowMarks = { 'w-stale': { day: '2023-12-25', met: true, fired: true } } // an old, fully-resolved occurrence
    })

    await tick()

    // Today's occurrence starts fresh — the stale met/fired don't suppress a
    // brand new reminder for TODAY.
    expect(store.load().arrivalWindowMarks['w-stale']).toEqual({ day: '2024-01-01', reminded: true })
  })

  it('orphan pruning: a mark for a window that no longer exists anywhere is dropped', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2024, 0, 1, 8, 45, 0))
    const circleId = 'circle-window-orphan'
    const child = realKeypair()
    const fam = fakeIdentity('child', child.pkHex, child.skHex)
    const circle = fakeCircle({ id: circleId, members: [{ pk: child.pkHex, role: 'child' }] })
    const place = fakePlace({ id: 'place-orphan' }) // no arrivalWindows at all any more
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.places = { [circleId]: [place] }
      p.arrivalWindowMarks = { 'ghost-window': { day: '2024-01-01', met: true } }
    })

    await tick()

    expect(store.load().arrivalWindowMarks['ghost-window']).toBeUndefined()
  })

  it('guardian devices (escalationEnabled false) never evaluate windows, even if a place happens to carry one', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2024, 0, 1, 9, 10, 0)) // would fire, if evaluated
    const circleId = 'circle-window-guardian'
    const guardian = realKeypair()
    const fam = fakeIdentity('parent', guardian.pkHex, guardian.skHex)
    const w = fakeWindow({ id: 'w-guardian', arriveBy: '09:00', graceMin: 10 })
    const place = fakePlace({ id: 'place-guardian', arrivalWindows: [w] })
    const circle = fakeCircle({ id: circleId, members: [{ pk: guardian.pkHex, role: 'guardian' }] })
    signIn(fam.pkHex, fam.skHex, fam.role === 'child')
    store.update((p) => {
      p.circles = [circle]
      p.places = { [circleId]: [place] }
    })

    await tick()

    expect(store.load().arrivalWindowMarks['w-guardian']).toBeUndefined()
    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })
})
})

// ===========================================================================
// Phase 5 Task 5 (brief §13.4) — boundary-exit permission requests.
// ===========================================================================

function fakeLeaveParams(overrides: Partial<LeaveAreaParams> = {}): LeaveAreaParams {
  return { placeName: 'Home', placeId: 'place-1', destination: 'The park', withWho: 'Sam', durationMin: 30, precisionTerm: 'Street', ...overrides }
}

describe('LeaveAreaParams — encode/decode round trip through the REAL ApprovalReq wire (params-encoding choice)', () => {
  it('encodeLeaveAreaParams/decodeLeaveAreaParams round-trip exactly', () => {
    const params = fakeLeaveParams()
    expect(decodeLeaveAreaParams(encodeLeaveAreaParams(params))).toEqual(params)
  })

  it('isLeaveAreaRequest is true only for params carrying the marker', () => {
    expect(isLeaveAreaRequest(encodeLeaveAreaParams(fakeLeaveParams()))).toBe(true)
    expect(isLeaveAreaRequest({ name: 'X' })).toBe(false)
    expect(isLeaveAreaRequest({})).toBe(false)
  })

  it('decodeLeaveAreaParams rejects a malformed durationMin (not one of 30/60/120)', () => {
    const wire = { ...encodeLeaveAreaParams(fakeLeaveParams()), durationMin: '45' }
    expect(decodeLeaveAreaParams(wire)).toBeNull()
  })

  it('decodeLeaveAreaParams rejects a missing required field (whole-set rejection, same discipline as parsePlace)', () => {
    const wire = encodeLeaveAreaParams(fakeLeaveParams())
    delete (wire as Record<string, string | undefined>).placeId
    expect(decodeLeaveAreaParams(wire)).toBeNull()
  })

  it('LEAVE_AREA_ENVELOPE_ACTION + encoded params survive the REAL brood-kit buildApprovalReq -> parseBroodSignal round trip', () => {
    const params = fakeLeaveParams()
    const req = buildApprovalReq({ id: 'r1', action: LEAVE_AREA_ENVELOPE_ACTION, params: encodeLeaveAreaParams(params), from: 'a'.repeat(64) }, 100)
    const inner = { kind: 20_078, tags: [['t', 'approval-req']], content: JSON.stringify(req) }
    const parsed = parseBroodSignal(inner)
    expect(parsed).not.toBeNull()
    expect(parsed).toEqual(req)
    if (parsed && parsed.t === 'approval-req') {
      expect(decodeLeaveAreaParams(parsed.params)).toEqual(params)
    }
  })

  it('a literal action of "leave-area" (the naive, non-borrowed encoding) is REJECTED by the real parser — proves the borrowed-envelope choice is necessary, not merely stylistic', () => {
    const req = buildApprovalReq({ id: 'r1', action: 'leave-area' as never, params: encodeLeaveAreaParams(fakeLeaveParams()), from: 'a'.repeat(64) }, 100)
    const inner = { kind: 20_078, tags: [['t', 'approval-req']], content: JSON.stringify(req) }
    expect(parseBroodSignal(inner)).toBeNull()
  })
})

describe('leaveApprovedUntil / isLeaveApproved (task interface, verbatim)', () => {
  it('undefined/false for an absent circle', () => {
    expect(leaveApprovedUntil({}, 'c1', 'p1', 1000)).toBeUndefined()
    expect(isLeaveApproved({}, 'c1', 'p1', 1000)).toBe(false)
  })

  it('undefined/false for a different placeId in the same circle', () => {
    const leaves = { c1: [{ placeId: 'p1', until: 2000 }] }
    expect(isLeaveApproved(leaves, 'c1', 'p2', 1000)).toBe(false)
  })

  it('true strictly before until', () => {
    const leaves = { c1: [{ placeId: 'p1', until: 2000 }] }
    expect(isLeaveApproved(leaves, 'c1', 'p1', 1999)).toBe(true)
    expect(leaveApprovedUntil(leaves, 'c1', 'p1', 1999)).toBe(2000)
  })

  it('false AT and after until (exclusive upper bound)', () => {
    const leaves = { c1: [{ placeId: 'p1', until: 2000 }] }
    expect(isLeaveApproved(leaves, 'c1', 'p1', 2000)).toBe(false)
    expect(isLeaveApproved(leaves, 'c1', 'p1', 2001)).toBe(false)
  })

  it('the LATEST still-active entry wins when more than one names the same placeId', () => {
    const leaves = { c1: [{ placeId: 'p1', until: 1500 }, { placeId: 'p1', until: 2000 }] }
    expect(leaveApprovedUntil(leaves, 'c1', 'p1', 1600)).toBe(2000)
  })
})

describe('applyLeaveResolution — "same reducer, both devices" convergence function', () => {
  it('a grant records until = resp.at + durationMin*60 — the APPROVAL time starts the clock, NOT the request time', () => {
    const params = fakeLeaveParams({ placeId: 'p1', durationMin: 30 })
    // req.at (not used by this function at all) is deliberately far earlier
    // than resp.at, to prove the clock starts at resp.at.
    const next = applyLeaveResolution({}, 'c1', params, { ok: true, at: 5000 })
    expect(next).toEqual({ c1: [{ placeId: 'p1', until: 5000 + 30 * 60 }] })
  })

  it('a denial is a no-op — returns the input unchanged', () => {
    const params = fakeLeaveParams()
    const leaves = { c1: [{ placeId: 'other', until: 999 }] }
    expect(applyLeaveResolution(leaves, 'c1', params, { ok: false, at: 5000 })).toBe(leaves)
  })

  it('REPLACES (not appends) an existing entry for the same placeId', () => {
    const params = fakeLeaveParams({ placeId: 'p1', durationMin: 60 })
    const leaves = { c1: [{ placeId: 'p1', until: 1000 }] }
    const next = applyLeaveResolution(leaves, 'c1', params, { ok: true, at: 5000 })
    expect(next.c1).toEqual([{ placeId: 'p1', until: 5000 + 60 * 60 }])
  })

  it('does not touch other circles', () => {
    const params = fakeLeaveParams({ placeId: 'p1' })
    const leaves = { other: [{ placeId: 'x', until: 999 }] }
    const next = applyLeaveResolution(leaves, 'c1', params, { ok: true, at: 100 })
    expect(next.other).toEqual([{ placeId: 'x', until: 999 }])
  })
})

describe('pruneExpiredLeaves', () => {
  it('drops an expired entry and the circle key once it has none left', () => {
    const leaves = { c1: [{ placeId: 'p1', until: 1000 }] }
    expect(pruneExpiredLeaves(leaves, 1000)).toEqual({})
  })

  it('keeps a still-active entry', () => {
    const leaves = { c1: [{ placeId: 'p1', until: 1001 }] }
    expect(pruneExpiredLeaves(leaves, 1000)).toEqual(leaves)
  })

  it('keeps the circle key when at least one entry survives', () => {
    const leaves = { c1: [{ placeId: 'p1', until: 500 }, { placeId: 'p2', until: 2000 }] }
    expect(pruneExpiredLeaves(leaves, 1000)).toEqual({ c1: [{ placeId: 'p2', until: 2000 }] })
  })

  it('returns the SAME reference when nothing is pruned', () => {
    const leaves = { c1: [{ placeId: 'p1', until: 2000 }] }
    expect(pruneExpiredLeaves(leaves, 1000)).toBe(leaves)
  })
})

describe('evaluatePlaces — leave-area suppression on a fresh exit (Task 5)', () => {
  it('leaving an approved place enters phase "leave-approved", no warning/grace/breach effect', () => {
    const place = fakePlace({ id: 'place-1', name: 'Home', escalation: 'grace', graceMinutes: 10 })
    const inside: PlaceEvalState = { insidePlaceIds: [place.id], escalation: { phase: 'safe' } }
    const outside = northOf(place.centre, 500)
    const result = evaluatePlaces([place], outside, 5, 1000, inside, true, false, () => 5000)
    expect(result.escalationEffect).toBeUndefined()
    expect(result.state.escalation).toEqual({ phase: 'leave-approved', placeId: 'place-1', placeName: 'Home', until: 5000 })
  })

  it('a place with NO active approval behaves exactly as before (regression: default predicate returns undefined)', () => {
    const place = fakePlace({ id: 'place-1', escalation: 'grace', graceMinutes: 10 })
    const inside: PlaceEvalState = { insidePlaceIds: [place.id], escalation: { phase: 'safe' } }
    const outside = northOf(place.centre, 500)
    const withPredicate = evaluatePlaces([place], outside, 5, 1000, inside, true, false, () => undefined)
    const withoutPredicate = evaluatePlaces([place], outside, 5, 1000, inside, true)
    expect(withPredicate).toEqual(withoutPredicate)
    expect(withPredicate.escalationEffect).toEqual({ kind: 'warn', placeName: 'Home', graceMinutes: 10 })
  })

  it('an already-mid-episode circle (grace) is untouched by the predicate — suppression only applies on a FRESH exit from safe', () => {
    const place = fakePlace({ id: 'place-1' })
    const grace: PlaceEvalState = { insidePlaceIds: [], escalation: { phase: 'grace', placeName: 'Home', graceEndsAt: 1600 } }
    const outside = northOf(place.centre, 500)
    const result = evaluatePlaces([place], outside, 5, 1200, grace, true, false, () => 5000)
    expect(result.state.escalation).toEqual(grace.escalation)
  })
})

describe('checkLeaveExpiry (Task 5) — mirrors checkGraceExpiry\'s own time-based, no-fix-needed discipline', () => {
  const leaveApproved: PlaceEvalState = { insidePlaceIds: [], escalation: { phase: 'leave-approved', placeId: 'place-1', placeName: 'Home', until: 2000 } }

  it('no-op before until', () => {
    expect(checkLeaveExpiry(leaveApproved, [fakePlace({ id: 'place-1' })], 1999)).toEqual({ state: leaveApproved })
  })

  it('no-op for any other phase', () => {
    expect(checkLeaveExpiry({ insidePlaceIds: [], escalation: { phase: 'safe' } }, [], 9999)).toEqual({ state: { insidePlaceIds: [], escalation: { phase: 'safe' } } })
  })

  it('at/after until, resumes NORMAL grace flow (never an instant breach) using the place\'s OWN CURRENT escalation config', () => {
    const place = fakePlace({ id: 'place-1', name: 'Home', escalation: 'grace', graceMinutes: 15 })
    const result = checkLeaveExpiry(leaveApproved, [place], 2000)
    expect(result.effect).toEqual({ kind: 'warn', placeName: 'Home', graceMinutes: 15 })
    expect(result.state.escalation).toEqual({ phase: 'grace', placeName: 'Home', graceEndsAt: 2000 + 15 * 60 })
  })

  it('an immediate-mode place escalates immediately on expiry (still not a "retroactive" breach — it is the NEW exit, decided fresh)', () => {
    const place = fakePlace({ id: 'place-1', name: 'Home', escalation: 'immediate' })
    const result = checkLeaveExpiry(leaveApproved, [place], 2500)
    expect(result.effect).toEqual({ kind: 'escalate', placeName: 'Home', immediate: true })
    expect(result.state.escalation).toEqual({ phase: 'escalated', placeName: 'Home', breachSent: false })
  })

  it('a place deleted since the leave was granted falls back to DEFAULT_GRACE_MINUTES/grace, never throws', () => {
    const result = checkLeaveExpiry(leaveApproved, [], 2000)
    expect(result.effect).toEqual({ kind: 'warn', placeName: 'Home', graceMinutes: DEFAULT_GRACE_MINUTES })
  })
})

describe('Boundary-exit escalation suppression sequence (Task 5) — approved -> outside -> no warning; expiry mid-absence -> warning+grace FRESH, never an instant breach; re-entry clears', () => {
  it('walks the full sequence', () => {
    const place = fakePlace({ id: 'place-1', name: 'Home', escalation: 'grace', graceMinutes: 10 })
    const outside = northOf(place.centre, 500)
    let leaves: Record<string, Array<{ placeId: string; until: number }>> = {}

    // t=1000: inside, safe.
    let state: PlaceEvalState = { insidePlaceIds: [place.id], escalation: { phase: 'safe' } }

    // A leave gets approved (resp.at = 1000), 30 min — until = 2800.
    leaves = applyLeaveResolution(leaves, 'circle-1', { placeName: 'Home', placeId: 'place-1', destination: 'Park', withWho: 'Sam', durationMin: 30, precisionTerm: 'Street' }, { ok: true, at: 1000 })
    expect(isLeaveApproved(leaves, 'circle-1', 'place-1', 1000)).toBe(true)

    // t=1100: walks outside — SUPPRESSED. No warning, no grace, no breach.
    const lookup = (t: number) => (placeId: string) => leaveApprovedUntil(leaves, 'circle-1', placeId, t)
    let result = evaluatePlaces([place], outside, 5, 1100, state, true, false, lookup(1100))
    expect(result.escalationEffect).toBeUndefined()
    expect(result.state.escalation.phase).toBe('leave-approved')
    state = result.state

    // t=2000: still outside, still within the approved window — checkLeaveExpiry no-ops, evaluatePlaces (already mid-episode) leaves it unchanged.
    const stillApproved = checkLeaveExpiry(state, [place], 2000)
    expect(stillApproved.effect).toBeUndefined()
    expect(stillApproved.state).toBe(state)
    result = evaluatePlaces([place], outside, 5, 2000, state, true, false, lookup(2000))
    expect(result.escalationEffect).toBeUndefined()
    expect(result.state.escalation.phase).toBe('leave-approved')

    // t=2900: PAST until (2800) — still outside. Expiry resumes the NORMAL
    // flow fresh: a private warning + grace countdown, NEVER an instant
    // breach/escalation.
    const expiry = checkLeaveExpiry(state, [place], 2900)
    expect(expiry.effect).toEqual({ kind: 'warn', placeName: 'Home', graceMinutes: 10 })
    expect(expiry.state.escalation).toEqual({ phase: 'grace', placeName: 'Home', graceEndsAt: 2900 + 10 * 60 })
    expect(expiry.state.escalation.phase).not.toBe('escalated') // never an instant breach
    state = expiry.state

    // Re-entry (before grace itself expires) clears back to safe, cancel effect.
    result = evaluatePlaces([place], place.centre, 5, 3000, state, true, false, lookup(3000))
    expect(result.escalationEffect).toEqual({ kind: 'cancel' })
    expect(result.state.escalation).toEqual({ phase: 'safe' })
  })
})

// ---------------------------------------------------------------------------
// places.ensure() integration (Task 5) — drives the TWO approvals.ts
// registration hooks for real: `registerApprovalAutoResolver` (local
// leaveAreaPolicy, evaluated on RECEIPT) and `registerApprovalResolutionListener`
// ("same reducer, both devices" convergence into `Persisted.approvedLeaves`
// + escalation cancel-mid-grace). `ensure()` is called ONCE (idempotent) via
// `beforeAll` — each test below uses its OWN circleId (same discipline the
// existing "tick() orchestration" describe above already follows) so
// places.ts's module-level in-memory maps (`evalState`, `banners`, …) from
// one test never bleed into another.
// ---------------------------------------------------------------------------

describe('places.ensure() integration (Task 5) — local policy allow/prompt/deny + both-devices convergence + mid-grace cancel', () => {
  beforeAll(() => {
    ensure()
  })

  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(beacons.selfFix).mockReset()
    vi.mocked(beacons.selfFix).mockReturnValue(null)
    vi.mocked(beacons.publishOrEnqueue).mockReset()
    vi.mocked(beacons.publishOrEnqueue).mockResolvedValue(undefined)
    vi.mocked(notify).mockClear()
  })

  it('policy "allow": a freshly-received leave-area request is auto-approved on receipt, recording approvedLeaves and leave-approved Activity', async () => {
    const circleId = 'circle-leave-allow'
    const guardian = realKeypair()
    const circle = fakeCircle({ id: circleId, members: [{ pk: guardian.pkHex, role: 'guardian' }] })
    signIn(guardian.pkHex, guardian.skHex, false, guardian.skHex)
    approvals.registerStructuralSenders()
    store.update((p) => {
      p.circles = [circle]
      p.leaveAreaPolicy = { [circleId]: 'allow' }
    })

    const params = fakeLeaveParams({ placeId: 'place-allow' })
    // Fresh sealed timestamp — approvals.ts's action paths now freshness-gate
    // (flock ff5eead parity), and "freshly-received" is this test's own premise.
    const reqAt = Math.floor(Date.now() / 1000) - 10
    const req = buildApprovalReq({ id: 'req-allow', action: LEAVE_AREA_ENVELOPE_ACTION, params: encodeLeaveAreaParams(params), from: 'c'.repeat(64) }, reqAt)
    const rumor: Rumor = { pubkey: 'c'.repeat(64), created_at: reqAt, kind: 20_078, tags: [['t', 'approval-req']], content: JSON.stringify(req) }
    approvals.handleIncomingSignal(circle, rumor, 'approval-req', fakeSender('c'.repeat(64)))
    // respondApproval's own publish is fire-and-forget from inside
    // handleIncomingSignal — flush microtasks so its `store.update` lands.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await queue.drain() // final fix round 3, F2: applied once the answer is sent

    const resolved = store.load().approvals.find((r) => r.req.id === 'req-allow')?.resolved
    expect(resolved?.ok).toBe(true)
    const leaveEntries = store.load().approvedLeaves[circleId]
    expect(leaveEntries).toEqual([{ placeId: 'place-allow', until: (resolved?.at ?? 0) + 30 * 60 }])
    expect(store.load().activity.some((e) => e.kind === 'leave-approved' && e.circleId === circleId)).toBe(true)
  })

  it('policy "deny": a freshly-received leave-area request is auto-denied on receipt, recording NO approvedLeaves entry', async () => {
    const circleId = 'circle-leave-deny'
    const guardian = realKeypair()
    const circle = fakeCircle({ id: circleId, members: [{ pk: guardian.pkHex, role: 'guardian' }] })
    signIn(guardian.pkHex, guardian.skHex, false, guardian.skHex)
    approvals.registerStructuralSenders()
    store.update((p) => {
      p.circles = [circle]
      p.leaveAreaPolicy = { [circleId]: 'deny' }
    })

    const params = fakeLeaveParams({ placeId: 'place-deny' })
    // Fresh sealed timestamp — approvals.ts's action paths now freshness-gate
    // (flock ff5eead parity), and "freshly-received" is this test's own premise.
    const reqAt = Math.floor(Date.now() / 1000) - 10
    const req = buildApprovalReq({ id: 'req-deny', action: LEAVE_AREA_ENVELOPE_ACTION, params: encodeLeaveAreaParams(params), from: 'c'.repeat(64) }, reqAt)
    const rumor: Rumor = { pubkey: 'c'.repeat(64), created_at: reqAt, kind: 20_078, tags: [['t', 'approval-req']], content: JSON.stringify(req) }
    approvals.handleIncomingSignal(circle, rumor, 'approval-req', fakeSender('c'.repeat(64)))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    await queue.drain()

    expect(store.load().approvals.find((r) => r.req.id === 'req-deny')?.resolved?.ok).toBe(false)
    expect(store.load().approvedLeaves[circleId]).toBeUndefined()
  })

  it('policy "prompt" (the default, no policy set): stays unresolved for manual review — no auto-response is ever published', () => {
    const circleId = 'circle-leave-prompt'
    const guardian = realKeypair()
    const circle = fakeCircle({ id: circleId, members: [{ pk: guardian.pkHex, role: 'guardian' }] })
    signIn(guardian.pkHex, guardian.skHex, false)
    store.update((p) => {
      p.circles = [circle]
      // No `leaveAreaPolicy` entry at all — defaults to 'prompt'.
    })

    const params = fakeLeaveParams({ placeId: 'place-prompt' })
    const req = buildApprovalReq({ id: 'req-prompt', action: LEAVE_AREA_ENVELOPE_ACTION, params: encodeLeaveAreaParams(params), from: 'c'.repeat(64) }, 1000)
    const rumor: Rumor = { pubkey: 'c'.repeat(64), created_at: 1000, kind: 20_078, tags: [['t', 'approval-req']], content: JSON.stringify(req) }
    approvals.handleIncomingSignal(circle, rumor, 'approval-req', fakeSender('c'.repeat(64)))

    expect(store.load().approvals.find((r) => r.req.id === 'req-prompt')?.resolved).toBeUndefined()
    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled()
  })

  it('final fix round 3, F2: a leave-area approval records approvedLeaves only once the answer is sent — never for a cancelled one', async () => {
    const circleId = 'circle-leave-pending'
    const guardian = realKeypair()
    const child = realKeypair()
    const circle = fakeCircle({ id: circleId, members: [{ pk: guardian.pkHex, role: 'guardian' }, { pk: child.pkHex, role: 'child' }] })
    const params = fakeLeaveParams({ placeId: 'place-pending' })
    const req = buildApprovalReq({ id: 'req-pending', action: LEAVE_AREA_ENVELOPE_ACTION, params: encodeLeaveAreaParams(params), from: child.pkHex }, 1000)
    const req2 = buildApprovalReq({ id: 'req-pending-2', action: LEAVE_AREA_ENVELOPE_ACTION, params: encodeLeaveAreaParams(params), from: child.pkHex }, 1001)
    signIn(guardian.pkHex, guardian.skHex, false) // My Signet asleep
    approvals.registerStructuralSenders()
    store.save({ ...store.load(), circles: [circle], approvals: [{ req, circleId }, { req: req2, circleId }], approvedLeaves: {} })

    // Cancelled before it was ever sent: nothing recorded, now or later.
    await approvals.respondApproval('req-pending', true)
    await queue.drain()
    expect(store.load().approvedLeaves[circleId]).toBeUndefined()
    queue.cancel(queue.pending().find((q) => q.action === 'approval-resp')!.id)
    expect(store.load().approvedLeaves[circleId]).toBeUndefined()
    expect(store.load().approvals.find((r) => r.req.id === 'req-pending')?.resolved).toBeUndefined()

    // Answered and sent: recorded only after the send.
    await approvals.respondApproval('req-pending-2', true)
    await queue.drain()
    expect(store.load().approvedLeaves[circleId]).toBeUndefined()
    signIn(guardian.pkHex, guardian.skHex, false, guardian.skHex) // My Signet is back
    await queue.drain()
    expect(store.load().approvedLeaves[circleId]?.[0]?.placeId).toBe('place-pending')
  })

  it('both devices converge on the SAME approvedLeaves entry — guardian from its own respondApproval send, child from the received resp', async () => {
    const circleId = 'circle-leave-converge'
    const guardian = realKeypair()
    const child = realKeypair()
    const circle = fakeCircle({ id: circleId, members: [{ pk: guardian.pkHex, role: 'guardian' }, { pk: child.pkHex, role: 'child' }] })
    const params = fakeLeaveParams({ placeId: 'place-converge' })
    const req = buildApprovalReq({ id: 'req-converge', action: LEAVE_AREA_ENVELOPE_ACTION, params: encodeLeaveAreaParams(params), from: child.pkHex }, 1000)

    // Guardian's own device: answers manually via respondApproval.
    signIn(guardian.pkHex, guardian.skHex, false, guardian.skHex)
    approvals.registerStructuralSenders()
    store.save({ ...store.load(), circles: [circle], approvals: [{ req, circleId }] })
    await approvals.respondApproval('req-converge', true)
    await queue.drain()
    const guardianSideLeaves = store.load().approvedLeaves[circleId]
    expect(guardianSideLeaves?.[0]?.placeId).toBe('place-converge')
    const until = guardianSideLeaves?.[0]?.until

    // Child's device: a FRESH store (simulating a different device), receiving
    // the guardian's resp over the wire.
    signIn(child.pkHex, child.skHex, true)
    store.save({ ...store.load(), circles: [circle], approvals: [{ req, circleId }], approvedLeaves: {} })
    const resp = buildApprovalResp({ id: 'req-converge', ok: true, by: guardian.pkHex }, until !== undefined ? until - 30 * 60 : 1000)
    const rumor: Rumor = { pubkey: guardian.pkHex, created_at: resp.at, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(resp) }
    approvals.handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(guardian.pkHex, guardian.pkHex, true))

    expect(store.load().approvedLeaves[circleId]).toEqual(guardianSideLeaves)
  })

  it('an approval landing WHILE already privately mid-grace for the SAME place cancels the grace and enters leave-approved', async () => {
    const circleId = 'circle-leave-midgrace'
    const child = realKeypair()
    const place = fakePlace({ id: 'place-midgrace', name: 'Home', escalation: 'grace', graceMinutes: 10 })
    const circle = fakeCircle({ id: circleId, members: [{ pk: child.pkHex, role: 'child' }] })
    signIn(child.pkHex, child.skHex, true)
    store.update((p) => {
      p.circles = [circle]
      p.places = { [circleId]: [place] }
    })

    // First tick, inside — seeds insidePlaceIds.
    vi.mocked(beacons.selfFix).mockReturnValue({ lat: place.centre.lat, lon: place.centre.lon, accuracy: 5, at: 1000 })
    await tick()
    // Second tick, outside — starts a real, private grace countdown.
    const outside = northOf(place.centre, 500)
    vi.mocked(beacons.selfFix).mockReturnValue({ lat: outside.lat, lon: outside.lon, accuracy: 5, at: 1010 })
    await tick()
    expect(currentEscalation(circleId)).toMatchObject({ phase: 'grace', placeName: 'Home' })

    // The child taps "Ask to go out" right from that warning banner; the
    // guardian (a co-guardian device, not modelled here) approves.
    const params = fakeLeaveParams({ placeName: 'Home', placeId: 'place-midgrace' })
    const req = buildApprovalReq({ id: 'req-midgrace', action: LEAVE_AREA_ENVELOPE_ACTION, params: encodeLeaveAreaParams(params), from: child.pkHex }, 1015)
    store.update((p) => { p.approvals = [...p.approvals, { req, circleId }] })
    const resp = buildApprovalResp({ id: 'req-midgrace', ok: true, by: PK_GUARDIAN }, 1020)
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 1020, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(resp) }
    approvals.handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(PK_GUARDIAN, PK_GUARDIAN, true))

    expect(currentEscalation(circleId)).toEqual({ phase: 'leave-approved', placeId: 'place-midgrace', placeName: 'Home', until: 1020 + 30 * 60 })
    // The stale persisted 'grace' snapshot must be cleared immediately, not
    // left for the next tick (reload safety — see applyLeaveApprovalToEscalation's doc comment).
    expect(store.load().placeEval[circleId]).toBeUndefined()
  })

  it('tick() end-to-end: an expired leave-approved episode resumes NORMAL grace (never an instant breach) and records leave-expired Activity — the exact sequence the task brief asks to be tested hardest', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2024, 0, 1, 12, 0, 0))
      const circleId = 'circle-leave-expiry-tick'
      const child = realKeypair()
      const place = fakePlace({ id: 'place-expiry', name: 'Home', escalation: 'grace', graceMinutes: 10 })
      const circle = fakeCircle({ id: circleId, members: [{ pk: child.pkHex, role: 'child' }] })
      const t0 = Math.floor(Date.now() / 1000)
      // A 30-min approval granted just now (until = t0 + 1800) — the child
      // is already outside, right from the first tick.
      signIn(child.pkHex, child.skHex, true)
      store.update((p) => {
        p.circles = [circle]
        p.places = { [circleId]: [place] }
        p.approvedLeaves = { [circleId]: [{ placeId: 'place-expiry', until: t0 + 1800 }] }
      })

      const outside = northOf(place.centre, 500)
      vi.mocked(beacons.selfFix).mockReturnValue({ lat: outside.lat, lon: outside.lon, accuracy: 5, at: t0 })
      await tick()
      expect(currentEscalation(circleId)).toEqual({ phase: 'leave-approved', placeId: 'place-expiry', placeName: 'Home', until: t0 + 1800 })
      expect(store.load().activity.some((e) => e.kind === 'leave-expired')).toBe(false) // not yet — still within the window

      // Time passes — still outside, no fresh fix needed (mirrors
      // checkGraceExpiry's own "stationary child" discipline) — the
      // window elapses.
      vi.setSystemTime(new Date(2024, 0, 1, 12, 31, 0))
      vi.mocked(beacons.selfFix).mockReturnValue(null)
      await tick()

      // Resumes the normal flow FRESH — a private warning + grace, never
      // an instant escalation/breach.
      const state = currentEscalation(circleId)
      expect(state.phase).toBe('grace')
      if (state.phase === 'grace') {
        expect(state.placeName).toBe('Home')
        expect(state.graceEndsAt).toBeGreaterThan(Math.floor(Date.now() / 1000))
      }
      expect(beacons.publishOrEnqueue).not.toHaveBeenCalled() // no breach signal sent — only a private countdown started
      expect(store.load().activity.some((e) => e.kind === 'leave-expired' && e.circleId === circleId)).toBe(true)
      expect(store.load().activity.some((e) => e.kind === 'safe-area-warning' && e.circleId === circleId)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
})
