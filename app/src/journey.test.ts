import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  JOURNEY_EXPIRE_SEC,
  JOURNEY_ARRIVE_RADIUS_M,
  JOURNEY_FLOOR_PRECISION,
  JOURNEY_LABEL_MAX,
  newJourneyId,
  buildJourneyStartReason,
  detectJourneyStartReason,
  buildJourneyDoneReason,
  detectJourneyDoneReason,
  formatExpectedBy,
  hasArrived,
  shouldSendJourneyDoneBuzz,
  isExpired,
  activeJourney,
  startJourney,
  completeJourney,
  cancelJourney,
  recordIncomingJourneyEvent,
  tick,
  type JourneyDest,
} from './journey.js'
import * as places from './places.js'
import * as store from './store.js'
import type { Journey } from './store.js'
import * as beacons from './beacons.js'
import { notify } from './notify.js'
import type { Fix } from './geo.js'
import { sessionForTests } from './session.js'
import { deriveInbox, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftUnwrap, rawNip44Decrypt } from '@forgesworn/roost-kit'
import type { Rumor, SignedEvent } from '@forgesworn/roost-kit'
import { decodeLegacyBuzz } from './legacy-buzz.js'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { encode as encodeGeohash } from 'geohash-kit'

vi.mock('./beacons.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./beacons.js')>()
  return { ...actual, selfFix: vi.fn(() => null), publishOrEnqueue: vi.fn(async () => {}) }
})

vi.mock('./notify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notify.js')>()
  return { ...actual, notify: vi.fn(async () => {}) }
})

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

function realKeypair(): { skHex: string; pkHex: string } {
  const sk = generateSecretKey()
  return { skHex: toHex(sk), pkHex: getPublicKey(sk) }
}

/** Signs this device in for a test — `identityPk` is the signed-in identity,
 *  `phoneSkHex` this device's own phone key (Signet identity plan). */
function signIn(identityPk: string, phoneSkHex: string, dependant = false): void {
  sessionForTests({ identityPk, phoneSkHex, dependant })
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

function fakePlace(overrides: Partial<places.Place> = {}): places.Place {
  return {
    id: 'place-1', name: 'Home', type: 'home', centre: { lat: 51.5, lon: -0.1 }, radiusMetres: 100,
    arrivalNotify: true, departureNotify: false, escalation: 'grace', graceMinutes: 10,
    ...overrides,
  }
}

/** Unwraps a journey buzz (same NIP-59 gift-wrap every buzz in this codebase
 *  uses) back to its decrypted `Buzz` payload — same pattern as
 *  places.test.ts's own `unwrapBuzz`, duplicated locally since journey.ts
 *  doesn't export a wire-wrap builder of its own (it goes straight from
 *  `buildBuzzSignal` to `giftWrap`, no exported intermediate). */
async function unwrapBuzzReason(wrap: SignedEvent, circle: Circle): Promise<string> {
  const inbox = deriveInbox(circle.seedHex)
  const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), wrap)
  expect(rumor).not.toBeNull()
  const buzz = await decodeLegacyBuzz(circle.seedHex, (rumor as Rumor).content)
  return buzz.reason
}

/** Offsets `centre` north by roughly `metres` — small-distance approximation,
 *  same helper idiom as places.test.ts's own `northOf`. */
function northOf(centre: { lat: number; lon: number }, metres: number): { lat: number; lon: number } {
  return { lat: centre.lat + metres / 111_320, lon: centre.lon }
}

describe('newJourneyId', () => {
  it('is an 8-byte hex handle, distinct across calls', () => {
    expect(newJourneyId()).toMatch(/^[0-9a-f]{16}$/)
    expect(newJourneyId()).not.toBe(newJourneyId())
  })
})

describe('JOURNEY_EXPIRE_SEC / JOURNEY_ARRIVE_RADIUS_M / JOURNEY_FLOOR_PRECISION — task-contract defaults', () => {
  it('expires 6 hours after start', () => { expect(JOURNEY_EXPIRE_SEC).toBe(6 * 3600) })
  it('auto-completes within 150 m of a geohash dest', () => { expect(JOURNEY_ARRIVE_RADIUS_M).toBe(150) })
  it('floors ROUTINE emission at Street (7)', () => { expect(JOURNEY_FLOOR_PRECISION).toBe(7) })
})

describe('buildJourneyStartReason / detectJourneyStartReason — round trip', () => {
  it('round-trips a label with no expected-by time', () => {
    const reason = buildJourneyStartReason('School')
    expect(reason).toBe('Heading to School')
    expect(detectJourneyStartReason(reason)).toEqual({ label: 'School' })
  })

  it('round-trips a label WITH an expected-by time', () => {
    const reason = buildJourneyStartReason('School', '15:30')
    expect(reason).toBe('Heading to School (expected by 15:30)')
    expect(detectJourneyStartReason(reason)).toEqual({ label: 'School', expectedByHHMM: '15:30' })
  })

  it('round-trips an empty label (same "returned as \'\', not undefined" idiom as places.ts)', () => {
    expect(detectJourneyStartReason(buildJourneyStartReason(''))).toEqual({ label: '' })
  })

  it('does not match unrelated text or the empty string', () => {
    expect(detectJourneyStartReason('Come home now')).toBeUndefined()
    expect(detectJourneyStartReason('')).toBeUndefined()
  })

  it('does not confuse the fixed "Heading home" status chip with the dynamic "Heading to " prefix', () => {
    expect(detectJourneyStartReason('Heading home')).toBeUndefined()
  })
})

describe('buildJourneyDoneReason / detectJourneyDoneReason — round trip', () => {
  it('round-trips a label', () => {
    const reason = buildJourneyDoneReason('the park')
    expect(reason).toBe('Journey to the park complete')
    expect(detectJourneyDoneReason(reason)).toBe('the park')
  })

  it('round-trips an empty label', () => {
    expect(detectJourneyDoneReason(buildJourneyDoneReason(''))).toBe('')
  })

  it('does not match unrelated text', () => {
    expect(detectJourneyDoneReason('Journey to the park')).toBeUndefined() // missing suffix
    expect(detectJourneyDoneReason('the park complete')).toBeUndefined() // missing prefix
  })
})

describe('non-collision with places.ts\'s arrival/departure/not-yet prefixes (task contract: detectors are strict-prefix like arrival\'s)', () => {
  it('a journey-start reason is never mistaken for an arrival/departure/not-yet reason', () => {
    const reason = buildJourneyStartReason('School', '08:45')
    expect(places.detectArrivalReason(reason)).toBeUndefined()
    expect(places.detectDepartureReason(reason)).toBeUndefined()
    expect(places.detectNotYetReason(reason)).toBeUndefined()
  })

  it('a journey-done reason is never mistaken for an arrival/departure/not-yet reason', () => {
    const reason = buildJourneyDoneReason('the park')
    expect(places.detectArrivalReason(reason)).toBeUndefined()
    expect(places.detectDepartureReason(reason)).toBeUndefined()
    expect(places.detectNotYetReason(reason)).toBeUndefined()
  })

  it('an arrival/departure/not-yet reason is never mistaken for a journey reason', () => {
    expect(detectJourneyStartReason(places.buildArrivalReason('School'))).toBeUndefined()
    expect(detectJourneyStartReason(places.buildDepartureReason('Home'))).toBeUndefined()
    expect(detectJourneyStartReason(places.buildNotYetReason('School', '08:45'))).toBeUndefined()
    expect(detectJourneyDoneReason(places.buildArrivalReason('School'))).toBeUndefined()
    expect(detectJourneyDoneReason(places.buildDepartureReason('Home'))).toBeUndefined()
    expect(detectJourneyDoneReason(places.buildNotYetReason('School', '08:45'))).toBeUndefined()
  })
})

describe('formatExpectedBy', () => {
  it('formats a unix timestamp as zero-padded 24h HH:MM, device-local', () => {
    const d = new Date(2026, 0, 15, 8, 5, 0) // 15 Jan 2026, 08:05 local
    expect(formatExpectedBy(Math.floor(d.getTime() / 1000))).toBe('08:05')
  })

  it('zero-pads single-digit hours and minutes', () => {
    const d = new Date(2026, 0, 15, 0, 0, 0)
    expect(formatExpectedBy(Math.floor(d.getTime() / 1000))).toBe('00:00')
  })
})

describe('hasArrived — pure auto-complete decision (task contract: place geofence, or 150m haversine for a geohash dest)', () => {
  const place = fakePlace({ centre: { lat: 51.5, lon: -0.1 }, radiusMetres: 100 })
  const placeDest: JourneyDest = { kind: 'place', id: place.id, label: place.name }

  it('a place dest is arrived once the fix is inside the CURRENT place geofence', () => {
    expect(hasArrived(placeDest, place, place.centre)).toBe(true)
    expect(hasArrived(placeDest, place, northOf(place.centre, 500))).toBe(false)
  })

  it('a place dest never arrives when the place no longer resolves (deleted since the journey started)', () => {
    expect(hasArrived(placeDest, undefined, place.centre)).toBe(false)
  })

  it('a geohash dest (meet/label) arrives within JOURNEY_ARRIVE_RADIUS_M, not beyond it', () => {
    const centre = { lat: 51.5, lon: -0.1 }
    const geohash = encodeGeohash(centre.lat, centre.lon, 9)
    const dest: JourneyDest = { kind: 'meet', id: 'meet-1', label: 'Park gate', geohash }
    expect(hasArrived(dest, undefined, northOf(centre, 100))).toBe(true) // well within 150m
    expect(hasArrived(dest, undefined, northOf(centre, 400))).toBe(false) // well beyond 150m
  })

  it('a label dest with no geohash at all never auto-completes', () => {
    const dest: JourneyDest = { kind: 'label', label: 'somewhere vague' }
    expect(hasArrived(dest, undefined, place.centre)).toBe(false)
  })
})

describe('shouldSendJourneyDoneBuzz — completion-buzz decision (queue fix: §3(c) literal rule)', () => {
  const place = fakePlace({ arrivalNotify: true })
  const silentPlace = fakePlace({ arrivalNotify: false })

  it('a MEET dest always sends the buzz — nothing else would announce it', () => {
    const dest: JourneyDest = { kind: 'meet', id: 'meet-1', label: 'Park gate' }
    expect(shouldSendJourneyDoneBuzz(dest, undefined)).toBe(true)
  })

  it('a LABEL dest always sends the buzz', () => {
    const dest: JourneyDest = { kind: 'label', label: 'somewhere' }
    expect(shouldSendJourneyDoneBuzz(dest, undefined)).toBe(true)
  })

  it('a PLACE dest with arrivalNotify ON sends NO buzz — places.ts\'s own arrival buzz already covers it', () => {
    const dest: JourneyDest = { kind: 'place', id: place.id, label: place.name }
    expect(shouldSendJourneyDoneBuzz(dest, place)).toBe(false)
  })

  it('a PLACE dest with arrivalNotify OFF sends the buzz — otherwise the circle hears nothing at all', () => {
    const dest: JourneyDest = { kind: 'place', id: silentPlace.id, label: silentPlace.name }
    expect(shouldSendJourneyDoneBuzz(dest, silentPlace)).toBe(true)
  })

  it('a PLACE dest whose place has been deleted since the journey started sends the buzz (treated as label-like)', () => {
    const dest: JourneyDest = { kind: 'place', id: 'gone', label: 'Old place' }
    expect(shouldSendJourneyDoneBuzz(dest, undefined)).toBe(true)
  })
})

describe('isExpired — 6h auto-expire safety valve', () => {
  function fakeJourney(startedAt: number): Journey {
    return { id: 'j-1', circleId: 'circle-1', dest: { kind: 'label', label: 'x' }, startedAt, floorPrecision: 7 }
  }

  it('is not expired one second before the deadline', () => {
    expect(isExpired(fakeJourney(1000), 1000 + JOURNEY_EXPIRE_SEC - 1)).toBe(false)
  })

  it('is expired exactly at the deadline, and past it', () => {
    expect(isExpired(fakeJourney(1000), 1000 + JOURNEY_EXPIRE_SEC)).toBe(true)
    expect(isExpired(fakeJourney(1000), 1000 + JOURNEY_EXPIRE_SEC + 100)).toBe(true)
  })
})

describe('activeJourney', () => {
  it('returns undefined for a circle with no active journey', () => {
    expect(activeJourney({ journeys: {} } as unknown as store.Persisted, 'circle-1')).toBeUndefined()
  })

  it('returns the circle\'s active journey', () => {
    const j: Journey = { id: 'j-1', circleId: 'circle-1', dest: { kind: 'label', label: 'x' }, startedAt: 100, floorPrecision: 7 }
    expect(activeJourney({ journeys: { 'circle-1': j } } as unknown as store.Persisted, 'circle-1')).toBe(j)
  })
})

// ---------------------------------------------------------------------------
// Impure orchestration — real store, mocked beacons.js. Same idiom as
// places.test.ts's/meet.test.ts's own orchestration describe blocks.
// ---------------------------------------------------------------------------

describe('startJourney / completeJourney / cancelJourney — orchestration', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(beacons.selfFix).mockReset()
    vi.mocked(beacons.selfFix).mockReturnValue(null)
    vi.mocked(beacons.publishOrEnqueue).mockReset()
    vi.mocked(beacons.publishOrEnqueue).mockResolvedValue(undefined)
    vi.mocked(notify).mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function setup(): { circle: Circle; fam: { pkHex: string } } {
    const { pkHex, skHex } = realKeypair()
    signIn(pkHex, skHex, true)
    const circle = fakeCircle()
    store.update((p) => { p.circles = [circle] })
    return { circle, fam: { pkHex } }
  }

  it('starts a journey: persists it, records journey-start Activity, and broadcasts the "Heading to" buzz', async () => {
    const { circle, fam } = setup()
    const dest: JourneyDest = { kind: 'label', label: 'the library' }
    startJourney(circle.id, dest)
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1))

    const j = activeJourney(store.load(), circle.id)
    expect(j).toMatchObject({ circleId: circle.id, dest: { kind: 'label', label: 'the library' }, floorPrecision: 7 })

    const evt = store.load().activity.find((e) => e.kind === 'journey-start')
    expect(evt?.actorPk).toBe(fam.pkHex)
    expect(evt?.params).toEqual({ place: 'the library' })

    const wrap = vi.mocked(beacons.publishOrEnqueue).mock.calls[0]?.[1] as SignedEvent
    expect(await unwrapBuzzReason(wrap, circle)).toBe('Heading to the library')
  })

  it('includes the expected-by time in both the Activity params and the wire reason', async () => {
    const { circle } = setup()
    const dest: JourneyDest = { kind: 'label', label: 'the library' }
    const d = new Date(2026, 0, 15, 15, 30, 0)
    startJourney(circle.id, dest, Math.floor(d.getTime() / 1000))
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1))

    const evt = store.load().activity.find((e) => e.kind === 'journey-start')
    expect(evt?.params).toEqual({ place: 'the library', expectedBy: '15:30' })
    const wrap = vi.mocked(beacons.publishOrEnqueue).mock.calls[0]?.[1] as SignedEvent
    expect(await unwrapBuzzReason(wrap, circle)).toBe('Heading to the library (expected by 15:30)')
  })

  it('one active journey per circle: a second start replaces the first with cancel-first semantics (no buzz for the replaced one)', async () => {
    const { circle } = setup()
    startJourney(circle.id, { kind: 'label', label: 'first stop' })
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1))
    vi.mocked(beacons.publishOrEnqueue).mockClear()

    startJourney(circle.id, { kind: 'label', label: 'second stop' })
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1)) // only the NEW start buzzes

    const active = activeJourney(store.load(), circle.id)
    expect(active?.dest.label).toBe('second stop')

    const cancelled = store.load().activity.find((e) => e.kind === 'journey-done' && e.params.place === 'first stop')
    expect(cancelled?.params.cancelled).toBe('1')
    const starts = store.load().activity.filter((e) => e.kind === 'journey-start')
    expect(starts).toHaveLength(2)

    const wrap = vi.mocked(beacons.publishOrEnqueue).mock.calls[0]?.[1] as SignedEvent
    expect(await unwrapBuzzReason(wrap, circle)).toBe('Heading to second stop') // never "first stop"
  })

  it('completes a PLACE-dest journey with NO journey-done buzz (reuses the existing arrival flow)', async () => {
    const { circle, fam } = setup()
    const place = fakePlace()
    store.update((p) => { p.places = { [circle.id]: [place] } })
    startJourney(circle.id, { kind: 'place', id: place.id, label: place.name })
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1))
    vi.mocked(beacons.publishOrEnqueue).mockClear()

    await completeJourney(circle.id)

    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled() // no journey-done buzz for a place dest
    expect(activeJourney(store.load(), circle.id)).toBeUndefined()
    const evt = store.load().activity.find((e) => e.kind === 'journey-done')
    expect(evt?.actorPk).toBe(fam.pkHex)
    expect(evt?.params).toEqual({ place: place.name })
  })

  it('completes a PLACE-dest journey WITH the journey-done buzz when the place\'s arrivalNotify is off (queue fix: otherwise total silence)', async () => {
    const { circle } = setup()
    const place = fakePlace({ arrivalNotify: false })
    store.update((p) => { p.places = { [circle.id]: [place] } })
    startJourney(circle.id, { kind: 'place', id: place.id, label: place.name })
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1))
    vi.mocked(beacons.publishOrEnqueue).mockClear()

    await completeJourney(circle.id)

    expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1)
    const wrap = vi.mocked(beacons.publishOrEnqueue).mock.calls[0]?.[1] as SignedEvent
    expect(await unwrapBuzzReason(wrap, circle)).toBe(`Journey to ${place.name} complete`)
  })

  it('completes a PLACE-dest journey WITH the journey-done buzz when the place has since been deleted (treated as label-like)', async () => {
    const { circle } = setup()
    const place = fakePlace()
    store.update((p) => { p.places = { [circle.id]: [place] } })
    startJourney(circle.id, { kind: 'place', id: place.id, label: place.name })
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1))
    vi.mocked(beacons.publishOrEnqueue).mockClear()
    store.update((p) => { p.places = { [circle.id]: [] } }) // deleted since the journey started

    await completeJourney(circle.id)

    expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1)
    const wrap = vi.mocked(beacons.publishOrEnqueue).mock.calls[0]?.[1] as SignedEvent
    expect(await unwrapBuzzReason(wrap, circle)).toBe(`Journey to ${place.name} complete`)
  })

  it('completes a MEET/LABEL-dest journey WITH the "Journey to X complete" buzz', async () => {
    const { circle } = setup()
    startJourney(circle.id, { kind: 'label', label: 'the park' })
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1))
    vi.mocked(beacons.publishOrEnqueue).mockClear()

    await completeJourney(circle.id)

    expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1)
    expect(activeJourney(store.load(), circle.id)).toBeUndefined()
    const wrap = vi.mocked(beacons.publishOrEnqueue).mock.calls[0]?.[1] as SignedEvent
    expect(await unwrapBuzzReason(wrap, circle)).toBe('Journey to the park complete')
  })

  it('cancels a journey with NO buzz and Activity params.cancelled = "1"', async () => {
    const { circle, fam } = setup()
    startJourney(circle.id, { kind: 'label', label: 'the park' })
    await vi.waitFor(() => expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1))
    vi.mocked(beacons.publishOrEnqueue).mockClear()

    cancelJourney(circle.id)

    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled()
    expect(activeJourney(store.load(), circle.id)).toBeUndefined()
    const evt = store.load().activity.find((e) => e.kind === 'journey-done')
    expect(evt?.actorPk).toBe(fam.pkHex)
    expect(evt?.params).toEqual({ place: 'the park', cancelled: '1' })
  })

  it('completeJourney/cancelJourney silently no-op when there is no active journey for the circle', async () => {
    const { circle } = setup()
    await completeJourney(circle.id)
    cancelJourney(circle.id)
    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled()
    expect(store.load().activity).toHaveLength(0)
  })
})

describe('tick() — auto-complete + auto-expire orchestration', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(beacons.selfFix).mockReset()
    vi.mocked(beacons.selfFix).mockReturnValue(null)
    vi.mocked(beacons.publishOrEnqueue).mockReset()
    vi.mocked(beacons.publishOrEnqueue).mockResolvedValue(undefined)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('auto-completes a journey once the device is within radius of a geohash dest', async () => {
    const { pkHex, skHex } = realKeypair()
    signIn(pkHex, skHex, true)
    const circle = fakeCircle()
    const centre = { lat: 51.5, lon: -0.1 }
    const geohash = encodeGeohash(centre.lat, centre.lon, 9)
    const j: Journey = { id: 'j-1', circleId: circle.id, dest: { kind: 'meet', id: 'meet-1', label: 'Park gate', geohash }, startedAt: Math.floor(Date.now() / 1000), floorPrecision: 7 }
    store.update((p) => { p.circles = [circle]; p.journeys = { [circle.id]: j } })

    const fix: Fix = { lat: centre.lat, lon: centre.lon, accuracy: 5, at: Math.floor(Date.now() / 1000) }
    vi.mocked(beacons.selfFix).mockReturnValue(fix)

    tick()
    await vi.waitFor(() => expect(activeJourney(store.load(), circle.id)).toBeUndefined())
    expect(store.load().activity.some((e) => e.kind === 'journey-done' && !e.params.expired && !e.params.cancelled)).toBe(true)
  })

  it('does not auto-complete while still outside the arrival radius', () => {
    const { pkHex, skHex } = realKeypair()
    signIn(pkHex, skHex, true)
    const circle = fakeCircle()
    const centre = { lat: 51.5, lon: -0.1 }
    const geohash = encodeGeohash(centre.lat, centre.lon, 9)
    const j: Journey = { id: 'j-1', circleId: circle.id, dest: { kind: 'meet', id: 'meet-1', label: 'Park gate', geohash }, startedAt: Math.floor(Date.now() / 1000), floorPrecision: 7 }
    store.update((p) => { p.circles = [circle]; p.journeys = { [circle.id]: j } })

    vi.mocked(beacons.selfFix).mockReturnValue({ lat: northOf(centre, 500).lat, lon: northOf(centre, 500).lon, accuracy: 5, at: Math.floor(Date.now() / 1000) })
    tick()
    expect(activeJourney(store.load(), circle.id)).toEqual(j)
  })

  it('auto-expires silently (no buzz, Activity journey-done with params.expired="1") once JOURNEY_EXPIRE_SEC has elapsed, expiry checked even with no fix', () => {
    const { pkHex, skHex } = realKeypair()
    signIn(pkHex, skHex, true)
    const circle = fakeCircle()
    const staleStart = Math.floor(Date.now() / 1000) - JOURNEY_EXPIRE_SEC - 10
    const j: Journey = { id: 'j-1', circleId: circle.id, dest: { kind: 'label', label: 'somewhere' }, startedAt: staleStart, floorPrecision: 7 }
    store.update((p) => { p.circles = [circle]; p.journeys = { [circle.id]: j } })

    tick() // no fix at all — expiry must still fire

    expect(activeJourney(store.load(), circle.id)).toBeUndefined()
    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled()
    const evt = store.load().activity.find((e) => e.kind === 'journey-done')
    expect(evt?.params).toEqual({ place: 'somewhere', expired: '1' })
  })
})

describe('recordIncomingJourneyEvent — receive side', () => {
  const PK_CHILD = 'b'.repeat(64)

  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(notify).mockClear()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('records journey-start Activity with place/expectedBy params, keyed to the actor, and notifies (fresh)', () => {
    const circle = fakeCircle({ members: [{ pk: PK_GUARDIAN, role: 'guardian' }, { pk: PK_CHILD, role: 'child', name: 'Bailey' }] })
    const at = Math.floor(Date.now() / 1000)
    recordIncomingJourneyEvent('journey-start', circle, PK_CHILD, 'School', '08:45', at)
    const evt = store.load().activity.find((e) => e.kind === 'journey-start')
    expect(evt?.actorPk).toBe(PK_CHILD)
    expect(evt?.params).toEqual({ place: 'School', expectedBy: '08:45' })
    expect(notify).toHaveBeenCalledWith('journey', PK_CHILD, 'Bailey is heading out', 'Heading to School (expected by 08:45)')
  })

  it('records journey-done Activity and notifies', () => {
    const circle = fakeCircle({ members: [{ pk: PK_GUARDIAN, role: 'guardian' }, { pk: PK_CHILD, role: 'child', name: 'Bailey' }] })
    const at = Math.floor(Date.now() / 1000)
    recordIncomingJourneyEvent('journey-done', circle, PK_CHILD, 'the park', undefined, at)
    const evt = store.load().activity.find((e) => e.kind === 'journey-done')
    expect(evt?.params).toEqual({ place: 'the park' })
    expect(notify).toHaveBeenCalledWith('journey', PK_CHILD, "Bailey's journey is complete", 'Journey to the park complete')
  })

  it('does not notify for a stale (replayed) event', () => {
    const circle = fakeCircle({ members: [{ pk: PK_GUARDIAN, role: 'guardian' }, { pk: PK_CHILD, role: 'child' }] })
    const stale = Math.floor(Date.now() / 1000) - 20_000
    recordIncomingJourneyEvent('journey-start', circle, PK_CHILD, 'School', undefined, stale)
    expect(notify).not.toHaveBeenCalled()
  })

  it('dedupes a replayed event (same id) — never double-records or double-notifies', () => {
    const circle = fakeCircle({ members: [{ pk: PK_GUARDIAN, role: 'guardian' }, { pk: PK_CHILD, role: 'child' }] })
    const at = Math.floor(Date.now() / 1000)
    recordIncomingJourneyEvent('journey-start', circle, PK_CHILD, 'School', undefined, at)
    vi.mocked(notify).mockClear()
    recordIncomingJourneyEvent('journey-start', circle, PK_CHILD, 'School', undefined, at)
    expect(store.load().activity.filter((e) => e.kind === 'journey-start')).toHaveLength(1)
    expect(notify).not.toHaveBeenCalled()
  })
})
