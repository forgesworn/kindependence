import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  decideCadence,
  basePrecisionFor,
  circleBaselinePrecision,
  pickerSelectedPrecision,
  scheduledPrecision,
  validateScheduleRuleDraft,
  SCHEDULE_RULE_MAX,
  SCHEDULE_LABEL_MAX,
  type ScheduleRuleDraft,
  precisionRaiseTransition,
  DEFAULT_BASELINE_PRECISION,
  BASELINE_PRECISION_OPTIONS,
  activeAgreementFor,
  setActiveAgreementProvider,
  applyJourneyFloor,
  journeyFloorFor,
  setJourneyFloorProvider,
  buildBeaconWrap,
  decodeBeaconRumor,
  publishOrEnqueue,
  memberPositions,
  mergeMemberPositions,
  updateMovement,
  movementModeAt,
  type MovementState,
  STATIONARY_RADIUS_M,
  STATIONARY_AFTER_SEC,
  STATIONARY_TICK_MS,
  MAX_MOVEMENT_FIX_ACCURACY_M,
  upsertPosition,
  onCircleInboxWrap,
  setSignalHandler,
} from './beacons.js'
import { giftWrap } from '@forgesworn/roost-kit'
import type { Fix } from './geo.js'
import * as store from './store.js'
import { deviceStatementTemplate } from './device-statements.js'
import { acceptStatement } from './phone-keys.js'
import * as poolHealth from './pool-health.js'
import { sessionForTests } from './session.js'
import { makeLocalSigner, deriveInbox, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftUnwrap, rawNip44Decrypt } from '@forgesworn/roost-kit'
import type { Rumor } from '@forgesworn/roost-kit'
import type { Agreement } from './brood/index.js'
import { buildLocationSignal } from '@forgesworn/flock/signals'
import { haversineMetres } from '@forgesworn/flock/geofence'
import { encode as encodeGeohash } from 'geohash-kit'
import { generateSecretKey } from 'nostr-tools/pure'

// publishOrEnqueue's success path (final-review fix, Important #1(b)) calls
// through to roost-kit's real `publishSigned`, which would otherwise try to
// open a real WebSocket. Mocked here so a "successful publish" is
// deterministic and network-free — same idiom as messages.test.ts's own
// `publishSigned` mock; every OTHER test in this file only ever calls pure
// builders/decoders directly (never publishOrEnqueue), so this changes
// nothing for them.
vi.mock('@forgesworn/roost-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgesworn/roost-kit')>()
  return { ...actual, publishSigned: vi.fn(async () => ({})) }
})

const PK_A = 'a'.repeat(64)

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

function fakeCircle(overrides: Partial<Circle> = {}): Circle {
  return {
    id: 'circle-1', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
    members: [{ pk: PK_A, role: 'guardian' }], createdAt: 100, configUpdatedAt: 100, configBy: PK_A,
    ...overrides,
  }
}

function fakeAgreement(overrides: Partial<Agreement> = {}): Agreement {
  return {
    t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: PK_A,
    byUnix: 1000, schedule: [], from: PK_A, at: 1000,
    ...overrides,
  }
}

function fakeRule(overrides: Partial<store.ScheduleRule> = {}): store.ScheduleRule {
  return { id: 'rule-1', days: [1, 2, 3, 4, 5], from: '15:00', to: '18:00', precision: 7, label: 'After school', ...overrides }
}

describe('decideCadence', () => {
  it('uses the base precision and the coarse 60s tick when there is no agreement', () => {
    expect(decideCadence(6, undefined, 1000)).toEqual({ precision: 6, intervalMs: 60_000 })
  })

  it('lets an agreement schedule RAISE precision above the base', () => {
    const agreement = fakeAgreement({ schedule: [{ fromOffsetMin: 0, precision: 9 }] })
    expect(decideCadence(6, agreement, 1000)).toEqual({ precision: 9, intervalMs: 15_000 })
  })

  it('never lets an agreement schedule LOWER precision below the base (mergePrecision is max-only)', () => {
    const agreement = fakeAgreement({ schedule: [{ fromOffsetMin: 0, precision: 4 }] })
    expect(decideCadence(6, agreement, 1000)).toEqual({ precision: 6, intervalMs: 60_000 })
  })

  it('ticks fine (15s) exactly at the >=9 precision boundary', () => {
    expect(decideCadence(9, undefined, 1000)).toEqual({ precision: 9, intervalMs: 15_000 })
  })

  it('ticks coarse (60s) just below the boundary', () => {
    expect(decideCadence(8, undefined, 1000)).toEqual({ precision: 8, intervalMs: 60_000 })
  })

  it('ignores a schedule step that has not fired yet (future byUnix + offset)', () => {
    const agreement = fakeAgreement({ byUnix: 5000, schedule: [{ fromOffsetMin: 0, precision: 11 }] })
    expect(decideCadence(6, agreement, 1000)).toEqual({ precision: 6, intervalMs: 60_000 })
  })

  it('defaults to the moving 60s coarse tick when movementMode is passed explicitly as moving', () => {
    expect(decideCadence(6, undefined, 1000, 'moving')).toEqual({ precision: 6, intervalMs: 60_000 })
  })

  it('stretches the coarse tick to STATIONARY_TICK_MS (5 min) while stationary', () => {
    expect(decideCadence(6, undefined, 1000, 'stationary')).toEqual({ precision: 6, intervalMs: STATIONARY_TICK_MS })
  })

  it('never stretches the fine (>=9) tick even while stationary', () => {
    expect(decideCadence(9, undefined, 1000, 'stationary')).toEqual({ precision: 9, intervalMs: 15_000 })
  })
})

describe('updateMovement', () => {
  // London-ish anchor; NEARBY is ~5.5m away (well inside STATIONARY_RADIUS_M),
  // FAR is ~222m away (well outside it) — both comfortably clear of the 75m
  // boundary so the test isn't sensitive to the exact haversine constant.
  const ANCHOR = { lat: 51.5074, lon: -0.1278 }
  const NEARBY: Fix = { lat: 51.5074 + 0.00005, lon: -0.1278, accuracy: 10, at: 0 }
  const FAR: Fix = { lat: 51.5074 + 0.002, lon: -0.1278, accuracy: 10, at: 0 }

  function movingState(overrides: Partial<MovementState> = {}): MovementState {
    return { mode: 'moving', anchor: ANCHOR, since: 1000, ...overrides }
  }

  it('initialises as moving, anchored at the fix, when there is no prior state', () => {
    const fix: Fix = { lat: 51.5, lon: -0.12, accuracy: 10, at: 0 }
    expect(updateMovement(null, fix, 500)).toEqual({ mode: 'moving', anchor: { lat: 51.5, lon: -0.12 }, since: 500 })
  })

  it('a junk fix (accuracy > 100) with prior state is a no-op — returns prev unchanged', () => {
    const prev = movingState()
    const junk: Fix = { ...FAR, accuracy: MAX_MOVEMENT_FIX_ACCURACY_M + 1 }
    expect(updateMovement(prev, junk, 2000)).toBe(prev)
  })

  it('a junk fix (accuracy > 100) with NO prior state still initialises as moving', () => {
    const junk: Fix = { lat: 51.5, lon: -0.12, accuracy: MAX_MOVEMENT_FIX_ACCURACY_M + 1, at: 0 }
    expect(updateMovement(null, junk, 500)).toEqual({ mode: 'moving', anchor: { lat: 51.5, lon: -0.12 }, since: 500 })
  })

  it('treats accuracy exactly at the threshold (100) as a valid fix, not junk', () => {
    const prev = movingState()
    const fix: Fix = { ...FAR, accuracy: MAX_MOVEMENT_FIX_ACCURACY_M }
    expect(updateMovement(prev, fix, 2000)).toEqual({ mode: 'moving', anchor: { lat: FAR.lat, lon: FAR.lon }, since: 2000 })
  })

  it('re-anchors to moving when the fix is beyond STATIONARY_RADIUS_M from the anchor', () => {
    const prev = movingState({ since: 1000 })
    expect(updateMovement(prev, FAR, 1050)).toEqual({ mode: 'moving', anchor: { lat: FAR.lat, lon: FAR.lon }, since: 1050 })
  })

  it('stays moving (unchanged) inside the radius before STATIONARY_AFTER_SEC has elapsed', () => {
    const prev = movingState({ since: 1000 })
    const fix: Fix = { ...NEARBY, at: 0 }
    expect(updateMovement(prev, fix, 1000 + STATIONARY_AFTER_SEC - 1)).toBe(prev)
  })

  it('flips to stationary (anchor kept) exactly at STATIONARY_AFTER_SEC inside the radius', () => {
    const prev = movingState({ since: 1000 })
    const fix: Fix = { ...NEARBY, at: 0 }
    expect(updateMovement(prev, fix, 1000 + STATIONARY_AFTER_SEC)).toEqual({ mode: 'stationary', anchor: ANCHOR, since: 1000 })
  })

  it('stays stationary on later fixes still inside the radius (anchor + since kept)', () => {
    const prev: MovementState = { mode: 'stationary', anchor: ANCHOR, since: 1000 }
    const fix: Fix = { ...NEARBY, at: 0 }
    expect(updateMovement(prev, fix, 50_000)).toEqual({ mode: 'stationary', anchor: ANCHOR, since: 1000 })
  })

  it('wakes to moving and resets `since` the instant a stationary device leaves the radius', () => {
    const prev: MovementState = { mode: 'stationary', anchor: ANCHOR, since: 1000 }
    expect(updateMovement(prev, FAR, 99_999)).toEqual({ mode: 'moving', anchor: { lat: FAR.lat, lon: FAR.lon }, since: 99_999 })
  })

  it('STATIONARY_RADIUS_M is 75 and STATIONARY_AFTER_SEC is 300 (task contract)', () => {
    expect(STATIONARY_RADIUS_M).toBe(75)
    expect(STATIONARY_AFTER_SEC).toBe(300)
  })

  // Review-minor #1: `updateMovement`'s re-anchor check is `> STATIONARY_
  // RADIUS_M`, not `>=` — a fix exactly at the radius stays within it (never
  // re-anchors on its own), only a fix genuinely BEYOND it does. Real lat/lon
  // floating-point maths can't hit the boundary bit-for-bit, so this
  // binary-searches (via the SAME `haversineMetres` `updateMovement` itself
  // calls) for the two closest achievable due-north points straddling exactly
  // 75m — a single float64 ULP apart in the latitude offset — and confirms
  // each one's OWN measured distance is on the expected side of the `>`
  // check before asserting on `updateMovement`'s behaviour for it.
  it('pins the STATIONARY_RADIUS_M check as `>`, not `>=`: the closest achievable point still at-or-inside 75m does not re-anchor, one float ULP further out does', () => {
    let lo = 0
    let hi = 1 // degrees north of ANCHOR — generous upper bound for a 75m search
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2
      const d = haversineMetres(ANCHOR, { lat: ANCHOR.lat + mid, lon: ANCHOR.lon })
      if (d <= STATIONARY_RADIUS_M) lo = mid; else hi = mid
    }
    const within = { lat: ANCHOR.lat + lo, lon: ANCHOR.lon }
    const over = { lat: ANCHOR.lat + hi, lon: ANCHOR.lon }
    expect(haversineMetres(ANCHOR, within)).toBeLessThanOrEqual(STATIONARY_RADIUS_M)
    expect(haversineMetres(ANCHOR, over)).toBeGreaterThan(STATIONARY_RADIUS_M)

    const prev = movingState({ since: 1000 })
    // At-or-inside the radius (even by a hair) — same "stays moving,
    // unchanged" behaviour as any other pre-dwell-time fix inside the radius.
    expect(updateMovement(prev, { ...within, accuracy: 10, at: 0 }, 1050)).toBe(prev)
    // One ULP further out — re-anchors to moving immediately.
    expect(updateMovement(prev, { ...over, accuracy: 10, at: 0 }, 1050)).toEqual({ mode: 'moving', anchor: over, since: 1050 })
  })
})

describe('movementModeAt — quiescence-as-stationary (final review Important #1)', () => {
  const ANCHOR = { lat: 51.5074, lon: -0.1278 }

  it('a tracked-stationary movement is stationary regardless of fix recency', () => {
    const movement: MovementState = { mode: 'stationary', anchor: ANCHOR, since: 1000 }
    expect(movementModeAt(movement, 1990, 2000)).toBe('stationary') // fix 10s ago
  })

  it('a tracked-moving movement with a fresh fix is moving', () => {
    const movement: MovementState = { mode: 'moving', anchor: ANCHOR, since: 1000 }
    expect(movementModeAt(movement, 1995, 2000)).toBe('moving') // fix 5s ago
  })

  it('a tracked-moving movement goes stationary once fix silence reaches STATIONARY_AFTER_SEC (300s)', () => {
    const movement: MovementState = { mode: 'moving', anchor: ANCHOR, since: 1000 }
    expect(movementModeAt(movement, 1000, 1000 + STATIONARY_AFTER_SEC)).toBe('stationary')
  })

  it('a tracked-moving movement stays moving one second short of the silence threshold (299s)', () => {
    const movement: MovementState = { mode: 'moving', anchor: ANCHOR, since: 1000 }
    expect(movementModeAt(movement, 1000, 1000 + STATIONARY_AFTER_SEC - 1)).toBe('moving')
  })

  it('null movement is always moving, regardless of how long the silence looks', () => {
    expect(movementModeAt(null, 0, 1_000_000)).toBe('moving')
  })

  it('null lastFixAtSec (nothing to measure silence against) is moving even with tracked-moving state', () => {
    const movement: MovementState = { mode: 'moving', anchor: ANCHOR, since: 1000 }
    expect(movementModeAt(movement, null, 1_000_000)).toBe('moving')
  })
})

describe('basePrecisionFor', () => {
  it('resolves to 6 (FLOCK coarse night-out precision, the default baseline) when a fix is available', () => {
    const fix: Fix = { lat: 51.5, lon: -0.12, accuracy: 20, at: 1_700_000_000 }
    expect(basePrecisionFor(fix)).toBe(6)
  })

  it('resolves to 0 (nothing to disclose) when there is no fix yet', () => {
    expect(basePrecisionFor(null)).toBe(0)
  })

  it('resolves to whatever per-circle baseline is passed (Task 8, brief §11.1) — Town(4)/Street(7)/Precise(9)', () => {
    const fix: Fix = { lat: 51.5, lon: -0.12, accuracy: 20, at: 1_700_000_000 }
    for (const baseline of BASELINE_PRECISION_OPTIONS) {
      expect(basePrecisionFor(fix, baseline)).toBe(baseline)
    }
  })

  it('still withholds (0) with no fix regardless of baseline — a coarser/finer baseline never invents a disclosure', () => {
    expect(basePrecisionFor(null, 9)).toBe(0)
    expect(basePrecisionFor(null, 4)).toBe(0)
  })

  it('an agreement schedule can still raise disclosure above even the coarsest (Town, 4) per-circle baseline — the baseline never caps an escalation', () => {
    const fix: Fix = { lat: 51.5, lon: -0.12, accuracy: 20, at: 1_700_000_000 }
    const agreement = fakeAgreement({ schedule: [{ fromOffsetMin: 0, precision: 9 }] })
    const base = basePrecisionFor(fix, 4) // Town — the lowest picker option
    expect(base).toBe(4)
    expect(decideCadence(base, agreement, 1000)).toEqual({ precision: 9, intervalMs: 15_000 })
  })
})

describe('circleBaselinePrecision', () => {
  it('defaults to Neighbourhood (6) for a circle with no stored baseline', () => {
    expect(circleBaselinePrecision({}, 'circle-1')).toBe(DEFAULT_BASELINE_PRECISION)
  })

  it('reads the stored per-circle value when present', () => {
    expect(circleBaselinePrecision({ circleBasePrecision: { 'circle-1': 9, 'circle-2': 4 } }, 'circle-1')).toBe(9)
    expect(circleBaselinePrecision({ circleBasePrecision: { 'circle-1': 9, 'circle-2': 4 } }, 'circle-2')).toBe(4)
  })

  it('falls back to the default for a DIFFERENT circle than the one stored', () => {
    expect(circleBaselinePrecision({ circleBasePrecision: { 'circle-1': 9 } }, 'circle-2')).toBe(DEFAULT_BASELINE_PRECISION)
  })
})

// ---------------------------------------------------------------------------
// Phase 5 Task 2 (brief §32.4) — scheduled sharing profiles: per-circle
// time-windowed precision overrides. `scheduledPrecision` is the pure
// active-rule resolver; `circleBaselinePrecision`'s schedule consult
// (already exercised above via its 2-arg calls, which never see a schedule)
// gets its own integration coverage below, proving the schedule genuinely
// participates in — and never breaks — the resolution order.
// ---------------------------------------------------------------------------

describe('scheduledPrecision (Phase 5 Task 2, §32.4)', () => {
  it('is null for undefined or empty rules', () => {
    expect(scheduledPrecision(undefined, { dayOfWeek: 1, secOfDay: 0 })).toBeNull()
    expect(scheduledPrecision([], { dayOfWeek: 1, secOfDay: 0 })).toBeNull()
  })

  it('is active when the day-of-week and time both fall inside the rule window', () => {
    const rule = fakeRule({ days: [1], from: '15:00', to: '18:00', precision: 7 })
    expect(scheduledPrecision([rule], { dayOfWeek: 1, secOfDay: 16 * 3600 })).toEqual({ precision: 7, until: 18 * 3600 })
  })

  it('is inactive when the day-of-week is not in days, even at a matching time', () => {
    const rule = fakeRule({ days: [1], from: '15:00', to: '18:00' })
    expect(scheduledPrecision([rule], { dayOfWeek: 2, secOfDay: 16 * 3600 })).toBeNull()
  })

  it('window is inclusive of the start boundary and exclusive of the end boundary', () => {
    const rule = fakeRule({ days: [1], from: '15:00', to: '18:00' })
    expect(scheduledPrecision([rule], { dayOfWeek: 1, secOfDay: 15 * 3600 })).not.toBeNull() // exactly at start
    expect(scheduledPrecision([rule], { dayOfWeek: 1, secOfDay: 15 * 3600 - 1 })).toBeNull() // just before start
    expect(scheduledPrecision([rule], { dayOfWeek: 1, secOfDay: 18 * 3600 })).toBeNull() // exactly at end
    expect(scheduledPrecision([rule], { dayOfWeek: 1, secOfDay: 18 * 3600 - 1 })).not.toBeNull() // just before end
  })

  it('a rule with a malformed from/to never matches — fails safe', () => {
    const rule = fakeRule({ from: 'nope', to: '18:00' })
    expect(scheduledPrecision([rule], { dayOfWeek: 1, secOfDay: 16 * 3600 })).toBeNull()
  })

  describe('cross-midnight window (e.g. Friday 22:00 - Saturday 02:00)', () => {
    const rule = fakeRule({ days: [5], from: '22:00', to: '02:00', precision: 9, label: 'Late Friday' })

    it('is active late on the listed day', () => {
      expect(scheduledPrecision([rule], { dayOfWeek: 5, secOfDay: 23 * 3600 })).toEqual({ precision: 9, until: 2 * 3600 })
    })

    it('is active early on the day immediately AFTER the listed day', () => {
      expect(scheduledPrecision([rule], { dayOfWeek: 6, secOfDay: 1 * 3600 })).toEqual({ precision: 9, until: 2 * 3600 })
    })

    it('is inactive on the listed day before the start time', () => {
      expect(scheduledPrecision([rule], { dayOfWeek: 5, secOfDay: 10 * 3600 })).toBeNull()
    })

    it('is inactive on the day after, once past the (exclusive) end time', () => {
      expect(scheduledPrecision([rule], { dayOfWeek: 6, secOfDay: 2 * 3600 })).toBeNull()
      expect(scheduledPrecision([rule], { dayOfWeek: 6, secOfDay: 10 * 3600 })).toBeNull()
    })

    it('does NOT spill onto a day whose PREVIOUS day is not listed', () => {
      // Only Friday (5) is listed — Sunday (0) early morning is the day
      // after Saturday, not Friday, so it must stay inactive.
      expect(scheduledPrecision([rule], { dayOfWeek: 0, secOfDay: 1 * 3600 })).toBeNull()
    })
  })

  it('overlapping active rules resolve to the FINEST precision, regardless of array order (deterministic)', () => {
    const coarse = fakeRule({ id: 'coarse', days: [1], from: '08:00', to: '20:00', precision: 6 })
    const fine = fakeRule({ id: 'fine', days: [1], from: '15:00', to: '18:00', precision: 9 })
    const day = { dayOfWeek: 1, secOfDay: 16 * 3600 } // both active
    expect(scheduledPrecision([coarse, fine], day)).toEqual({ precision: 9, until: 18 * 3600 })
    expect(scheduledPrecision([fine, coarse], day)).toEqual({ precision: 9, until: 18 * 3600 })
  })

  it('a precision tie deterministically keeps whichever tied rule was listed first', () => {
    const a = fakeRule({ id: 'a', days: [1], from: '08:00', to: '12:00', precision: 9 })
    const b = fakeRule({ id: 'b', days: [1], from: '10:00', to: '14:00', precision: 9 })
    const day = { dayOfWeek: 1, secOfDay: 11 * 3600 } // both active
    expect(scheduledPrecision([a, b], day)).toEqual({ precision: 9, until: 12 * 3600 })
    expect(scheduledPrecision([b, a], day)).toEqual({ precision: 9, until: 14 * 3600 })
  })
})

describe('circleBaselinePrecision — schedule integration (Phase 5 Task 2, §32.4)', () => {
  it('returns the active rule\'s precision when a schedule rule covers localNow', () => {
    const settings = { circleBasePrecision: { 'circle-1': 6 }, sharingSchedules: { 'circle-1': [fakeRule({ from: '15:00', to: '18:00', precision: 9, days: [1] })] } }
    expect(circleBaselinePrecision(settings, 'circle-1', { dayOfWeek: 1, secOfDay: 16 * 3600 })).toBe(9)
  })

  it('falls back to the static per-circle baseline outside every rule\'s window', () => {
    const settings = { circleBasePrecision: { 'circle-1': 6 }, sharingSchedules: { 'circle-1': [fakeRule({ from: '15:00', to: '18:00', precision: 9, days: [1] })] } }
    expect(circleBaselinePrecision(settings, 'circle-1', { dayOfWeek: 1, secOfDay: 10 * 3600 })).toBe(6)
  })

  it('falls back to DEFAULT_BASELINE_PRECISION outside the window when no static baseline is stored either', () => {
    const settings = { sharingSchedules: { 'circle-1': [fakeRule({ from: '15:00', to: '18:00', precision: 9, days: [1] })] } }
    expect(circleBaselinePrecision(settings, 'circle-1', { dayOfWeek: 1, secOfDay: 10 * 3600 })).toBe(DEFAULT_BASELINE_PRECISION)
  })

  it('an existing 2-arg call site (no localNow) keeps working — no schedule configured, so it is a plain static-baseline read', () => {
    expect(circleBaselinePrecision({ circleBasePrecision: { 'circle-1': 9 } }, 'circle-1')).toBe(9)
  })

  it('an agreement still raises precision above an ACTIVE schedule rule — resolution order stays safety > agreement > schedule-or-baseline', () => {
    const settings = { sharingSchedules: { 'circle-1': [fakeRule({ from: '08:00', to: '20:00', precision: 7, days: [1] })] } }
    const localNow = { dayOfWeek: 1, secOfDay: 12 * 3600 }
    const baseline = circleBaselinePrecision(settings, 'circle-1', localNow)
    expect(baseline).toBe(7) // Street, from the active rule — NOT the (absent) static default of 6

    const fix: Fix = { lat: 51.5, lon: -0.12, accuracy: 20, at: 1_700_000_000 }
    const basePrecision = basePrecisionFor(fix, baseline)
    expect(basePrecision).toBe(7)

    const agreement = fakeAgreement({ schedule: [{ fromOffsetMin: 0, precision: 9 }] })
    expect(decideCadence(basePrecision, agreement, 1000)).toEqual({ precision: 9, intervalMs: 15_000 })
  })
})

// ---------------------------------------------------------------------------
// Phase 5 Task 2 final-review fix (§32.4/§11.1): the You-tab baseline
// picker used to highlight `circleBaselinePrecision` (the schedule-aware
// EFFECTIVE value), so tapping a chip during an active schedule-override
// window produced no visible feedback. `pickerSelectedPrecision` is the
// extracted static-only seam `app.ts`'s `baselinePickerView` now reads
// instead — these tests prove it stays static even in exactly the
// scenario (an active override) where `circleBaselinePrecision` diverges
// from it, using the SAME settings/localNow fixtures as the schedule-
// integration block just above so the divergence is directly comparable.
// ---------------------------------------------------------------------------

describe('pickerSelectedPrecision (Phase 5 Task 2 final-review fix, §32.4/§11.1)', () => {
  it('reads the stored per-circle static value, same as circleBaselinePrecision with no schedule configured', () => {
    expect(pickerSelectedPrecision({ circleBasePrecision: { 'circle-1': 9, 'circle-2': 4 } }, 'circle-1')).toBe(9)
    expect(pickerSelectedPrecision({ circleBasePrecision: { 'circle-1': 9, 'circle-2': 4 } }, 'circle-2')).toBe(4)
  })

  it('falls back to DEFAULT_BASELINE_PRECISION for a circle with no stored baseline', () => {
    expect(pickerSelectedPrecision({}, 'circle-1')).toBe(DEFAULT_BASELINE_PRECISION)
  })

  it('falls back to the default for a DIFFERENT circle than the one stored', () => {
    expect(pickerSelectedPrecision({ circleBasePrecision: { 'circle-1': 9 } }, 'circle-2')).toBe(DEFAULT_BASELINE_PRECISION)
  })

  it('static-vs-override: stays on the STATIC choice while an active schedule rule raises circleBaselinePrecision above it', () => {
    const settings = { circleBasePrecision: { 'circle-1': 6 }, sharingSchedules: { 'circle-1': [fakeRule({ from: '15:00', to: '18:00', precision: 9, days: [1] })] } }
    const localNow = { dayOfWeek: 1, secOfDay: 16 * 3600 } // inside the rule's window

    // The same settings+localNow circleBaselinePrecision resolves to 9 for
    // (schedule integration test above) — the picker must NOT follow it.
    expect(circleBaselinePrecision(settings, 'circle-1', localNow)).toBe(9)
    expect(pickerSelectedPrecision(settings, 'circle-1')).toBe(6)
  })

  it('static-vs-override: the two agree once the override window has passed', () => {
    const settings = { circleBasePrecision: { 'circle-1': 6 }, sharingSchedules: { 'circle-1': [fakeRule({ from: '15:00', to: '18:00', precision: 9, days: [1] })] } }
    const localNow = { dayOfWeek: 1, secOfDay: 10 * 3600 } // outside the rule's window

    expect(circleBaselinePrecision(settings, 'circle-1', localNow)).toBe(6)
    expect(pickerSelectedPrecision(settings, 'circle-1')).toBe(6)
  })

  it('takes no `localNow`/time argument at all — genuinely static, unlike circleBaselinePrecision', () => {
    // Sanity check on the seam's own shape: it's a 2-arg (settings, circleId)
    // function, so there is no way for a caller to accidentally thread a
    // schedule-aware value through it.
    expect(pickerSelectedPrecision).toHaveLength(2)
  })
})

describe('validateScheduleRuleDraft — the You-tab editor\'s pure validation (Phase 5 Task 2, §32.4)', () => {
  const validDraft: ScheduleRuleDraft = { days: [1], from: '15:00', to: '18:00', precision: 7, label: 'After school' }

  it('accepts a well-formed draft', () => {
    expect(validateScheduleRuleDraft(0, validDraft)).toBeNull()
  })

  it('rejects at SCHEDULE_RULE_MAX (6) existing rules, accepts one below it', () => {
    expect(validateScheduleRuleDraft(SCHEDULE_RULE_MAX, validDraft)).not.toBeNull()
    expect(validateScheduleRuleDraft(SCHEDULE_RULE_MAX - 1, validDraft)).toBeNull()
  })

  it('rejects an empty day selection', () => {
    expect(validateScheduleRuleDraft(0, { ...validDraft, days: [] })).not.toBeNull()
  })

  it('rejects a malformed from/to (parseHHMM-invalid: not zero-padded, out of range)', () => {
    expect(validateScheduleRuleDraft(0, { ...validDraft, from: '9:00' })).not.toBeNull()
    expect(validateScheduleRuleDraft(0, { ...validDraft, to: '25:00' })).not.toBeNull()
  })

  it('rejects an empty (or whitespace-only) label', () => {
    expect(validateScheduleRuleDraft(0, { ...validDraft, label: '' })).not.toBeNull()
    expect(validateScheduleRuleDraft(0, { ...validDraft, label: '   ' })).not.toBeNull()
  })

  it('rejects a label over SCHEDULE_LABEL_MAX (30) characters, accepts exactly the cap', () => {
    expect(validateScheduleRuleDraft(0, { ...validDraft, label: 'x'.repeat(SCHEDULE_LABEL_MAX) })).toBeNull()
    expect(validateScheduleRuleDraft(0, { ...validDraft, label: 'x'.repeat(SCHEDULE_LABEL_MAX + 1) })).not.toBeNull()
  })

  it('rejects a precision outside BASELINE_PRECISION_OPTIONS', () => {
    expect(validateScheduleRuleDraft(0, { ...validDraft, precision: 5 })).not.toBeNull()
  })
})

describe('precisionRaiseTransition (Task 8 deliverable 3: record once per upward transition)', () => {
  it('is not raised, and not a transition, when the merged precision equals the base', () => {
    expect(precisionRaiseTransition(6, 6, false)).toEqual({ raised: false, justRaised: false })
  })

  it('is a transition the first tick the agreement schedule raises precision above base', () => {
    expect(precisionRaiseTransition(6, 9, false)).toEqual({ raised: true, justRaised: true })
  })

  it('stays raised but is NOT a repeat transition on a later tick that is still raised', () => {
    expect(precisionRaiseTransition(6, 9, true)).toEqual({ raised: true, justRaised: false })
  })

  it('drops back to not-raised (schedule step ended / arrived) without itself being recorded as a transition', () => {
    expect(precisionRaiseTransition(6, 6, true)).toEqual({ raised: false, justRaised: false })
  })
})

describe('activeAgreementFor', () => {
  it('returns undefined when no provider is registered (the stub\'s original behaviour, before agreements.ts wires one up)', () => {
    setActiveAgreementProvider(null)
    expect(activeAgreementFor('any-circle')).toBeUndefined()
  })

  it('delegates to the registered provider with the signed-in identity\'s own pubkey', () => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    sessionForTests({ identityPk: PK_A, phoneSkHex: 'a'.repeat(64), dependant: true })
    const agreement = fakeAgreement()
    setActiveAgreementProvider((circleId, selfPk) => (circleId === 'circle-1' && selfPk === PK_A ? agreement : undefined))

    expect(activeAgreementFor('circle-1')).toBe(agreement)
    expect(activeAgreementFor('other-circle')).toBeUndefined()

    setActiveAgreementProvider(null)
    sessionForTests(null)
    vi.unstubAllGlobals()
  })

  it('returns undefined when there is a provider but no signed-in identity', () => {
    setActiveAgreementProvider(() => fakeAgreement())
    expect(activeAgreementFor('circle-1')).toBeUndefined()
    setActiveAgreementProvider(null)
  })
})

// Phase 5 Task 3 (brief §32.2): journey mode's ROUTINE emission floor.
// `applyJourneyFloor` is the pure merge (task contract: "floor raises coarse
// baseline; never lowers Precise agreement; safety untouched structurally");
// `journeyFloorFor`/`setJourneyFloorProvider` mirror
// `activeAgreementFor`/`setActiveAgreementProvider`'s own registration
// idiom exactly (journey.ts registers there — beacons.ts is imported BY
// journey.ts, so the reverse import would cycle).
describe('applyJourneyFloor', () => {
  it('raises a coarse baseline to the journey floor', () => {
    expect(applyJourneyFloor(4, 7)).toBe(7) // Town -> Street
  })

  it('never LOWERS a baseline already at or above the floor', () => {
    expect(applyJourneyFloor(9, 7)).toBe(9) // Precise stays Precise
    expect(applyJourneyFloor(7, 7)).toBe(7) // exactly at the floor — unchanged
  })

  it('leaves the baseline untouched when there is no active journey (floor undefined)', () => {
    expect(applyJourneyFloor(4, undefined)).toBe(4)
    expect(applyJourneyFloor(9, undefined)).toBe(9)
  })

  it('composed with decideCadence\'s own agreement merge: a journey floor never caps an agreement raise above it', () => {
    // baseline 4 (Town), journey floor 7 (Street) -> floored to 7; an
    // agreement's schedule raising to 9 (Precise) at this instant must still
    // win — the floor only ever applies BEFORE the agreement merge, and
    // that merge is itself max-only (mergePrecision), so the two compose
    // monotonically: max(max(4,7), 9) === 9, never capped back to 7.
    const floored = applyJourneyFloor(4, 7)
    const agreement = { t: 'agreement' as const, id: 'agr-1', circleId: 'c1', child: 'a'.repeat(64), byUnix: 1000, schedule: [{ fromOffsetMin: -15, precision: 9 }], from: 'a'.repeat(64), at: 0 }
    const now = 1000 - 10 * 60 // inside the -15min raise window
    const { precision } = decideCadence(floored, agreement, now)
    expect(precision).toBe(9)
  })

  it('composed with decideCadence: a journey floor still raises routine cadence above the static baseline with NO agreement active', () => {
    const floored = applyJourneyFloor(4, 7)
    const { precision } = decideCadence(floored, undefined, 1000)
    expect(precision).toBe(7)
  })

  // Phase 5 final-review fast-follow (§25 transparency): app.ts's
  // `circleModeLine` (the You-tab privacy row + self-marker sheet's "what
  // am I sharing" line) folds the journey floor in at this SAME point —
  // `applyJourneyFloor(scheduleBaseline, journeyFloorFor(circleId))` BEFORE
  // `basePrecisionFor` — exactly mirroring `emitTick`'s own order above, so
  // the two composed tests below are the display-side counterpart of the
  // `decideCadence` ones just above: same merge, fed into the function the
  // mode line actually derives its baseline TERM from instead of the wire's
  // actual emission decision.
  const fixAt = (at: number): Fix => ({ lat: 0, lon: 0, accuracy: 5, at })

  it('composed with basePrecisionFor: an active journey raises the mode line\'s baseline term (Town -> Street) even though the stored/scheduled baseline never changed', () => {
    const floored = applyJourneyFloor(4, 7) // Town static baseline, Street journey floor
    expect(basePrecisionFor(fixAt(1000), floored)).toBe(7)
  })

  it('composed with basePrecisionFor: no active journey (floor undefined) leaves the mode line\'s baseline term unchanged', () => {
    const floored = applyJourneyFloor(4, undefined)
    expect(basePrecisionFor(fixAt(1000), floored)).toBe(4)
  })
})

describe('journeyFloorFor / setJourneyFloorProvider', () => {
  afterEach(() => {
    setJourneyFloorProvider(null)
  })

  it('returns undefined when no provider is registered (the stub\'s original behaviour, before journey.ts\'s ensure() wires one up)', () => {
    expect(journeyFloorFor('any-circle')).toBeUndefined()
  })

  it('delegates to the registered provider', () => {
    setJourneyFloorProvider((circleId) => (circleId === 'circle-1' ? 7 : undefined))
    expect(journeyFloorFor('circle-1')).toBe(7)
    expect(journeyFloorFor('circle-2')).toBeUndefined()
  })

  it('returns undefined once unregistered', () => {
    setJourneyFloorProvider(() => 7)
    setJourneyFloorProvider(null)
    expect(journeyFloorFor('circle-1')).toBeUndefined()
  })
})

describe('buildBeaconWrap / decodeBeaconRumor — wire round trip', () => {
  it('round-trips geohash + precision through the full gift-wrap + canary-kit encryption', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const fix: Fix = { lat: 51.5074, lon: -0.1278, accuracy: 15, at: 1_700_000_000 }

    const wrap = await buildBeaconWrap(signer, circle, fix, 6)
    expect(wrap.kind).toBe(1059) // outer NIP-59 gift wrap, never the bare inner signal

    const inbox = deriveInbox(circle.seedHex)
    const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), wrap)
    expect(rumor).not.toBeNull()

    const pos = await decodeBeaconRumor(rumor as Rumor, circle.seedHex)
    expect(pos).not.toBeNull()
    expect(pos?.geohash).toBe(encodeGeohash(fix.lat, fix.lon, 6))
    expect(pos?.precision).toBe(6)
    // The seal's real pubkey survives the wrap/unwrap round trip — this is
    // the sender identity beacons.ts records positions against.
    expect((rumor as Rumor).pubkey).toBe(signer.pubkey)
  })

  it('returns null for a non-beacon t-tag (e.g. breach) even though it shares the same encoding', async () => {
    const circle = fakeCircle()
    const inner = await buildLocationSignal({
      groupId: circle.id, seedHex: circle.seedHex, signalType: 'breach', geohash: 'gcpuuz', precision: 9,
    })
    const rumor: Rumor = { pubkey: PK_A, created_at: inner.created_at, kind: inner.kind, tags: inner.tags, content: inner.content }
    expect(await decodeBeaconRumor(rumor, circle.seedHex)).toBeNull()
  })

  it('returns null when decrypted with the wrong circle seed (undecryptable)', async () => {
    const circle = fakeCircle()
    const wrongSeedHex = '2'.repeat(64)
    const inner = await buildLocationSignal({
      groupId: circle.id, seedHex: circle.seedHex, signalType: 'beacon', geohash: 'gcpuuz', precision: 6,
    })
    const rumor: Rumor = { pubkey: PK_A, created_at: inner.created_at, kind: inner.kind, tags: inner.tags, content: inner.content }
    expect(await decodeBeaconRumor(rumor, wrongSeedHex)).toBeNull()
  })

  it('returns null for the wrong inner event kind', async () => {
    const rumor: Rumor = { pubkey: PK_A, created_at: 1000, kind: 14, tags: [['t', 'beacon']], content: 'whatever' }
    expect(await decodeBeaconRumor(rumor, '1'.repeat(64))).toBeNull()
  })
})

describe('publishOrEnqueue — successful publish notes pool liveness (final-review fix, Important #1(b))', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    // Restores the `vi.spyOn(poolHealth, 'notePoolActivity')` each test below
    // creates fresh — without this, `vi.spyOn` on an ALREADY-spied property
    // (left in place by the previous test) reuses that SAME spy object
    // rather than creating a new one, so a later test's `spy.mock.calls`
    // would read as the CUMULATIVE count across both tests instead of just
    // its own.
    vi.restoreAllMocks()
  })

  async function fakeWrap(): Promise<Awaited<ReturnType<typeof buildBeaconWrap>>> {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const fix: Fix = { lat: 51.5074, lon: -0.1278, accuracy: 15, at: 1_700_000_000 }
    return buildBeaconWrap(signer, circle, fix, 6)
  }

  it('calls pool-health.ts\'s notePoolActivity once the publish actually succeeds — the shared seam every publishing module routes through', async () => {
    const { publishSigned } = await import('@forgesworn/roost-kit')
    vi.mocked(publishSigned).mockResolvedValueOnce({})
    const spy = vi.spyOn(poolHealth, 'notePoolActivity')

    await publishOrEnqueue(['wss://relay.example'], await fakeWrap())
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('does NOT note pool liveness when the publish fails and falls back to the outbox — a failure proves nothing about the pool being alive', async () => {
    const { publishSigned } = await import('@forgesworn/roost-kit')
    vi.mocked(publishSigned).mockRejectedValueOnce(new Error('all relays down'))
    const spy = vi.spyOn(poolHealth, 'notePoolActivity')

    await expect(publishOrEnqueue(['wss://relay.example'], await fakeWrap())).resolves.toBeUndefined() // never rejects — falls to the outbox
    expect(spy).not.toHaveBeenCalled()
  })
})

// Final review, item 3: after() can run twice per resume, and two
// concurrent roost-kit outbox flushes race (each snapshots the queue, and
// the second to finish writes back over an item enqueued meanwhile).
// flushOutbox serialises: one flush in flight; a request during it runs
// exactly one more flush afterwards.
describe('flushOutbox — serialised', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('overlapping flush requests never run concurrently, and an item enqueued mid-flush is sent', async () => {
    vi.resetModules()
    vi.stubGlobal('localStorage', fakeLocalStorage())
    const roost = await import('@forgesworn/roost-kit')
    const b = await import('./beacons.js')
    const signer = makeLocalSigner(toHex(generateSecretKey()))
    const fix: Fix = { lat: 51.5074, lon: -0.1278, accuracy: 15, at: 1_700_000_000 }
    const wrap = (): Promise<Awaited<ReturnType<typeof buildBeaconWrap>>> => b.buildBeaconWrap(signer, fakeCircle(), fix, 6)

    let mode: 'fail' | 'gate' = 'fail'
    let active = 0
    let maxActive = 0
    const sent: string[] = []
    const gates: Array<() => void> = []
    vi.mocked(roost.publishSigned).mockImplementation(async (_relays, ev) => {
      if (mode === 'fail') throw new Error('offline')
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise<void>((release) => gates.push(release))
      active--
      sent.push(ev.id)
      return {}
    })
    const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await Promise.resolve() }

    const first = await wrap()
    await b.publishOrEnqueue(['wss://relay.example'], first) // → the outbox

    mode = 'gate'
    const f1 = b.flushOutbox()
    const f2 = b.flushOutbox() // e.g. after() running twice on one resume
    await settle()
    expect(active).toBe(1)

    const late = await wrap()
    mode = 'fail'
    await b.publishOrEnqueue(['wss://relay.example'], late) // enqueued mid-flush
    mode = 'gate'

    let done = false
    void Promise.all([f1, f2]).then(() => { done = true })
    for (let i = 0; i < 10 && !done; i++) {
      gates.splice(0).forEach((release) => release())
      await settle()
    }
    expect(done).toBe(true)
    expect(maxActive).toBe(1)
    expect(sent).toContain(late.id)
    expect(sent).toContain(first.id)
    expect((await b.flushOutbox()).remaining).toBe(0)
  })
})

describe('memberPositions', () => {
  it('returns an empty map for a circle with no recorded positions', () => {
    expect(memberPositions('nonexistent-circle').size).toBe(0)
  })
})

describe('mergeMemberPositions', () => {
  const PK_B = 'b'.repeat(64)

  it('passes through a single circle\'s positions unchanged, one circleId each', () => {
    const positions = new Map([[PK_A, { geohash: 'gcpuuz', precision: 6, at: 100 }]])
    const merged = mergeMemberPositions([{ id: 'circle-1' }], (id) => (id === 'circle-1' ? positions : new Map()))
    expect(merged.size).toBe(1)
    expect(merged.get(PK_A)).toEqual({ pubkey: PK_A, pos: { geohash: 'gcpuuz', precision: 6, at: 100 }, circleIds: ['circle-1'] })
  })

  it('renders a member in two selected circles ONCE, at the higher of the two precisions', () => {
    const inFamily = new Map([[PK_A, { geohash: 'gcpuuzz', precision: 9, at: 100 }]])
    const inFriends = new Map([[PK_A, { geohash: 'gcpuuz', precision: 6, at: 200 }]])
    const byCircle: Record<string, typeof inFamily> = { family: inFamily, friends: inFriends }
    const merged = mergeMemberPositions([{ id: 'family' }, { id: 'friends' }], (id) => byCircle[id] ?? new Map())
    expect(merged.size).toBe(1)
    const entry = merged.get(PK_A)
    expect(entry?.pos.precision).toBe(9) // the family circle's finer disclosure wins
    expect(entry?.pos.geohash).toBe('gcpuuzz')
    expect(entry?.circleIds.sort()).toEqual(['family', 'friends'])
  })

  it('breaks an equal-precision tie by the more recent `at`', () => {
    const older = new Map([[PK_A, { geohash: 'gcpuuz', precision: 6, at: 100 }]])
    const newer = new Map([[PK_A, { geohash: 'gcpuuzx', precision: 6, at: 500 }]])
    const byCircle: Record<string, typeof older> = { a: older, b: newer }
    const merged = mergeMemberPositions([{ id: 'a' }, { id: 'b' }], (id) => byCircle[id] ?? new Map())
    expect(merged.get(PK_A)?.pos.at).toBe(500)
    expect(merged.get(PK_A)?.pos.geohash).toBe('gcpuuzx')
  })

  it('keeps different members separate, each with their own circle list', () => {
    const inA = new Map([[PK_A, { geohash: 'gcpuuz', precision: 6, at: 100 }]])
    const inB = new Map([[PK_B, { geohash: 'gcpuuz', precision: 9, at: 100 }]])
    const byCircle: Record<string, typeof inA> = { a: inA, b: inB }
    const merged = mergeMemberPositions([{ id: 'a' }, { id: 'b' }], (id) => byCircle[id] ?? new Map())
    expect(merged.size).toBe(2)
    expect(merged.get(PK_A)?.circleIds).toEqual(['a'])
    expect(merged.get(PK_B)?.circleIds).toEqual(['b'])
  })

  it('returns an empty map when no selected circle has any positions', () => {
    expect(mergeMemberPositions([{ id: 'empty' }], () => new Map()).size).toBe(0)
  })
})

// Flock ff5eead parity: an older / out-of-order beacon (a replay, or normal
// relay late delivery) must not regress a member's live position.
describe('upsertPosition — newest-wins against replayed/out-of-order positions', () => {
  it('ignores a strictly-older position for the same member', () => {
    upsertPosition('nw-circle-1', PK_A, { geohash: 'gcpuuzx', precision: 9, at: 500 })
    upsertPosition('nw-circle-1', PK_A, { geohash: 'gcpuuz', precision: 6, at: 400 })
    expect(memberPositions('nw-circle-1').get(PK_A)?.at).toBe(500)
    expect(memberPositions('nw-circle-1').get(PK_A)?.geohash).toBe('gcpuuzx')
  })

  it('applies an equal-timestamp position (the same beacon re-delivered — idempotent)', () => {
    upsertPosition('nw-circle-2', PK_A, { geohash: 'gcpuuzx', precision: 9, at: 500 })
    upsertPosition('nw-circle-2', PK_A, { geohash: 'gcpuuzx', precision: 9, at: 500 })
    expect(memberPositions('nw-circle-2').get(PK_A)?.at).toBe(500)
  })

  it('applies a newer position', () => {
    upsertPosition('nw-circle-3', PK_A, { geohash: 'gcpuuz', precision: 6, at: 400 })
    upsertPosition('nw-circle-3', PK_A, { geohash: 'gcpuuzx', precision: 9, at: 500 })
    expect(memberPositions('nw-circle-3').get(PK_A)?.at).toBe(500)
  })
})

// Flock 1021d99 parity: dedup on the CONTENT-BOUND rumor id (roost-kit now
// recomputes it on unwrap), not just the outer wrap id — a replay re-wrapped
// under a fresh ephemeral key carries a NEW wrap id but the SAME rumor id,
// so wrap-id dedup alone re-delivers a stale signal as current.
describe('onCircleInboxWrap — content-bound rumor-id dedup', () => {
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

  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('dispatches a given rumor to signal handlers exactly once across re-deliveries', async () => {
    const circle: Circle = {
      id: 'dedup-circle', name: 'D', seedHex: '3'.repeat(64), epoch: 0,
      members: [{ pk: PK_A, role: 'guardian' }], createdAt: 100, configUpdatedAt: 100, configBy: PK_A,
    }
    store.save({ ...store.load(), circles: [circle] })
    const inbox = deriveInbox(circle.seedHex)
    const signer = makeLocalSigner(toHex(generateSecretKey()))
    // The sender's phone key must be in the circle's phone-key table (Task 8
    // choke point): bind it with a statement from a roster member's identity.
    const identity = makeLocalSigner(toHex(generateSecretKey()))
    circle.members = [{ pk: identity.pubkey, role: 'guardian' }]
    store.save({ ...store.load(), circles: [circle] })
    const st = await identity.signEvent(deviceStatementTemplate(signer.pubkey, Math.floor(Date.now() / 1000)))
    expect(acceptStatement(circle, st, signer.pubkey, Math.floor(Date.now() / 1000))).toBe('added')
    const wrap = await giftWrap(signer, inbox.pk, { kind: 20_078, content: 'x', tags: [['t', 'x-dedup-test']] }, inbox.pk)

    const seen: string[] = []
    setSignalHandler((c, _rumor, t) => { if (t === 'x-dedup-test') seen.push(c.id) })

    await onCircleInboxWrap(circle.id, inbox.sk, wrap)
    await onCircleInboxWrap(circle.id, inbox.sk, wrap) // relay re-delivery after a pool reset — same rumor id
    expect(seen).toHaveLength(1)
  })
})
