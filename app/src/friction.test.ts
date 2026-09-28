import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  FRICTION_THRESHOLD,
  FRICTION_MIN_GAP_SEC,
  nextMapCheckState,
  isQuietDay,
  shouldShowFrictionCard,
  dismissFrictionCard,
  recordMapCheck,
  shouldCountResumeAsMapCheck,
} from './friction.js'
import * as store from './store.js'
import type { Circle } from '@forgesworn/covey-kit'
import type { AgreementRecord, Place, ActivityEvent, SafetyEvent } from './store.js'
import type { PickupRecord } from './pickup.js'

// Minimal in-memory localStorage stand-in — same idiom as store.test.ts.
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

// Two fixed device-local days, straddling a boundary — 2026-07-20 10:00:00
// local and 2026-07-21 10:00:00 local. Using `new Date(...)` (device-local
// constructor, not UTC) matches places.ts's own `localDay`, which this
// module reuses rather than duplicating.
const DAY1_NOON = Math.floor(new Date(2026, 6, 20, 12, 0, 0).getTime() / 1000)
const DAY1_STAMP = '2026-07-20'
const DAY2_NOON = Math.floor(new Date(2026, 6, 21, 12, 0, 0).getTime() / 1000)
const DAY2_STAMP = '2026-07-21'

describe('friction — nextMapCheckState (pure reducer)', () => {
  it('starts a fresh count of 1 when there is no prior state', () => {
    expect(nextMapCheckState(undefined, DAY1_NOON, DAY1_STAMP)).toEqual({ day: DAY1_STAMP, count: 1, lastAt: DAY1_NOON })
  })

  it('increments once a full FRICTION_MIN_GAP_SEC has passed since the last counted check', () => {
    const first = nextMapCheckState(undefined, DAY1_NOON, DAY1_STAMP)
    const second = nextMapCheckState(first, DAY1_NOON + FRICTION_MIN_GAP_SEC, DAY1_STAMP)
    expect(second).toEqual({ day: DAY1_STAMP, count: 2, lastAt: DAY1_NOON + FRICTION_MIN_GAP_SEC })
  })

  it('collapses a burst of taps inside the 60s gap into a single check (same object back)', () => {
    const first = nextMapCheckState(undefined, DAY1_NOON, DAY1_STAMP)
    const second = nextMapCheckState(first, DAY1_NOON + 1, DAY1_STAMP)
    const third = nextMapCheckState(second, DAY1_NOON + 59, DAY1_STAMP)
    expect(second).toBe(first) // unchanged reference — nothing to persist
    expect(third).toBe(first)
    expect(third).toEqual({ day: DAY1_STAMP, count: 1, lastAt: DAY1_NOON })
  })

  it('resets to a fresh count of 1 on a new day, even with a high leftover count', () => {
    const yesterday = { day: DAY1_STAMP, count: 41, lastAt: DAY1_NOON }
    expect(nextMapCheckState(yesterday, DAY2_NOON, DAY2_STAMP)).toEqual({ day: DAY2_STAMP, count: 1, lastAt: DAY2_NOON })
  })

  it('day-reset is not subject to the 60s gap rule (a fresh day always counts)', () => {
    const yesterday = { day: DAY1_STAMP, count: 3, lastAt: DAY2_NOON - 1 } // 1s before "today" started, by wall clock
    expect(nextMapCheckState(yesterday, DAY2_NOON, DAY2_STAMP)).toEqual({ day: DAY2_STAMP, count: 1, lastAt: DAY2_NOON })
  })
})

describe('friction — recordMapCheck (thin store wrapper)', () => {
  it('writes the reducer result into Persisted.mapChecks', () => {
    recordMapCheck(DAY1_NOON)
    expect(store.load().mapChecks).toEqual({ day: DAY1_STAMP, count: 1, lastAt: DAY1_NOON })
  })

  it('collapses a second call inside the 60s gap (count stays 1)', () => {
    recordMapCheck(DAY1_NOON)
    recordMapCheck(DAY1_NOON + 10)
    expect(store.load().mapChecks).toEqual({ day: DAY1_STAMP, count: 1, lastAt: DAY1_NOON })
  })

  it('increments after the 60s gap has passed', () => {
    recordMapCheck(DAY1_NOON)
    recordMapCheck(DAY1_NOON + FRICTION_MIN_GAP_SEC)
    expect(store.load().mapChecks).toEqual({ day: DAY1_STAMP, count: 2, lastAt: DAY1_NOON + FRICTION_MIN_GAP_SEC })
  })
})

// ---------------------------------------------------------------------------
// isQuietDay — a matrix of fixtures, each one disqualifier flipped in turn
// against an otherwise-empty (quiet) Persisted state.
// ---------------------------------------------------------------------------

const CIRCLE: Circle = {
  id: 'circle-1', name: 'Family', seedHex: '1'.repeat(64), epoch: 0,
  members: [{ pk: 'guardian-pk'.padEnd(64, '0'), role: 'guardian' }, { pk: 'child-pk'.padEnd(64, '0'), role: 'child' }],
  createdAt: 100, configUpdatedAt: 100, configBy: 'guardian-pk'.padEnd(64, '0'),
}

function basePersisted(): store.Persisted {
  const p = store.load()
  p.circles = [CIRCLE]
  return p
}

describe('friction — isQuietDay (matrix)', () => {
  it('is quiet on an otherwise-empty day', () => {
    expect(isQuietDay(basePersisted(), DAY1_NOON)).toBe(true)
  })

  it('is NOT quiet with a help/SOS safetyEvent today', () => {
    const p = basePersisted()
    const evt: SafetyEvent = { id: 'evt-1', circleId: 'circle-1', from: 'child-pk'.padEnd(64, '0'), kind: 'help', at: DAY1_NOON }
    p.safetyEvents = [evt]
    expect(isQuietDay(p, DAY1_NOON)).toBe(false)
  })

  it('IS quiet when the help/SOS safetyEvent happened on a different day', () => {
    const p = basePersisted()
    const evt: SafetyEvent = { id: 'evt-1', circleId: 'circle-1', from: 'child-pk'.padEnd(64, '0'), kind: 'help', at: DAY1_NOON }
    p.safetyEvents = [evt]
    expect(isQuietDay(p, DAY2_NOON)).toBe(true)
  })

  it('a checkin/pickup safetyEvent does not disqualify (only "help" does)', () => {
    const p = basePersisted()
    const evt: SafetyEvent = { id: 'evt-1', circleId: 'circle-1', from: 'child-pk'.padEnd(64, '0'), kind: 'checkin', at: DAY1_NOON }
    p.safetyEvents = [evt]
    expect(isQuietDay(p, DAY1_NOON)).toBe(true)
  })

  it.each(['safe-area-escalation', 'window-missed', 'sos'] as const)('is NOT quiet with a %s Activity entry today', (kind) => {
    const p = basePersisted()
    const evt: ActivityEvent = { id: 'act-1', at: DAY1_NOON, kind, circleId: 'circle-1', actorPk: 'child-pk'.padEnd(64, '0'), params: {} }
    p.activity = [evt]
    expect(isQuietDay(p, DAY1_NOON)).toBe(false)
  })

  it('IS quiet when the disqualifying Activity entry happened on a different day', () => {
    const p = basePersisted()
    const evt: ActivityEvent = { id: 'act-1', at: DAY1_NOON, kind: 'safe-area-escalation', circleId: 'circle-1', actorPk: 'child-pk'.padEnd(64, '0'), params: {} }
    p.activity = [evt]
    expect(isQuietDay(p, DAY2_NOON)).toBe(true)
  })

  it('an unrelated Activity kind (e.g. arrival) does not disqualify', () => {
    const p = basePersisted()
    const evt: ActivityEvent = { id: 'act-1', at: DAY1_NOON, kind: 'arrival', circleId: 'circle-1', actorPk: 'child-pk'.padEnd(64, '0'), params: {} }
    p.activity = [evt]
    expect(isQuietDay(p, DAY1_NOON)).toBe(true)
  })

  it.each(['requested', 'offered', 'seen', 'accepted', 'on-way', 'suggested'] as const)('is NOT quiet with a pickup record in the non-terminal phase %s', (phase) => {
    const p = basePersisted()
    const rec: PickupRecord = { id: 'pickup-1', circleId: 'circle-1', childPk: 'child-pk'.padEnd(64, '0'), phase, at: DAY1_NOON, direction: 'request' }
    p.pickups = [rec]
    expect(isQuietDay(p, DAY1_NOON)).toBe(false)
  })

  it.each(['collected', 'declined'] as const)('IS quiet with a pickup record already in the terminal phase %s', (phase) => {
    const p = basePersisted()
    const rec: PickupRecord = { id: 'pickup-1', circleId: 'circle-1', childPk: 'child-pk'.padEnd(64, '0'), phase, at: DAY1_NOON, direction: 'request' }
    p.pickups = [rec]
    expect(isQuietDay(p, DAY1_NOON)).toBe(true)
  })

  it('a non-terminal pickup from an earlier day still disqualifies (not day-scoped)', () => {
    const p = basePersisted()
    const rec: PickupRecord = { id: 'pickup-1', circleId: 'circle-1', childPk: 'child-pk'.padEnd(64, '0'), phase: 'on-way', at: DAY1_NOON, direction: 'request' }
    p.pickups = [rec]
    expect(isQuietDay(p, DAY2_NOON)).toBe(false)
  })

  it('is NOT quiet with a tracked agreement past byUnix, not yet arrived', () => {
    const p = basePersisted()
    const rec: AgreementRecord = {
      agreement: { t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: 'child-pk'.padEnd(64, '0'), byUnix: DAY1_NOON - 60, schedule: [], from: 'guardian-pk'.padEnd(64, '0'), at: DAY1_NOON - 3600 },
      status: 'en-route',
    }
    p.agreements = [rec]
    expect(isQuietDay(p, DAY1_NOON)).toBe(false)
  })

  it('IS quiet with a tracked agreement past byUnix that has already arrived', () => {
    const p = basePersisted()
    const rec: AgreementRecord = {
      agreement: { t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: 'child-pk'.padEnd(64, '0'), byUnix: DAY1_NOON - 60, schedule: [], from: 'guardian-pk'.padEnd(64, '0'), at: DAY1_NOON - 3600 },
      status: 'arrived', arrivedAt: DAY1_NOON - 30,
    }
    p.agreements = [rec]
    expect(isQuietDay(p, DAY1_NOON)).toBe(true)
  })

  it('IS quiet with a tracked agreement whose byUnix has not passed yet', () => {
    const p = basePersisted()
    const rec: AgreementRecord = {
      agreement: { t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: 'child-pk'.padEnd(64, '0'), byUnix: DAY1_NOON + 3600, schedule: [], from: 'guardian-pk'.padEnd(64, '0'), at: DAY1_NOON },
      status: 'en-route',
    }
    p.agreements = [rec]
    expect(isQuietDay(p, DAY1_NOON)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// shouldShowFrictionCard — threshold edge, dismissed-today, non-quiet
// suppress.
// ---------------------------------------------------------------------------

describe('friction — shouldShowFrictionCard', () => {
  it('does not show below FRICTION_THRESHOLD', () => {
    const state = { day: DAY1_STAMP, count: FRICTION_THRESHOLD - 1, lastAt: DAY1_NOON }
    expect(shouldShowFrictionCard(state, undefined, true, DAY1_STAMP)).toBe(false)
  })

  it('shows exactly AT FRICTION_THRESHOLD (the crossing edge)', () => {
    const state = { day: DAY1_STAMP, count: FRICTION_THRESHOLD, lastAt: DAY1_NOON }
    expect(shouldShowFrictionCard(state, undefined, true, DAY1_STAMP)).toBe(true)
  })

  it('shows above FRICTION_THRESHOLD too', () => {
    const state = { day: DAY1_STAMP, count: FRICTION_THRESHOLD + 5, lastAt: DAY1_NOON }
    expect(shouldShowFrictionCard(state, undefined, true, DAY1_STAMP)).toBe(true)
  })

  it('never shows on a non-quiet day, no matter how high the count', () => {
    const state = { day: DAY1_STAMP, count: FRICTION_THRESHOLD + 20, lastAt: DAY1_NOON }
    expect(shouldShowFrictionCard(state, undefined, false, DAY1_STAMP)).toBe(false)
  })

  it('does not show once dismissed for today', () => {
    const state = { day: DAY1_STAMP, count: FRICTION_THRESHOLD + 1, lastAt: DAY1_NOON }
    expect(shouldShowFrictionCard(state, DAY1_STAMP, true, DAY1_STAMP)).toBe(false)
  })

  it('shows again on a new day even if dismissed yesterday', () => {
    const state = { day: DAY2_STAMP, count: FRICTION_THRESHOLD, lastAt: DAY2_NOON }
    expect(shouldShowFrictionCard(state, DAY1_STAMP, true, DAY2_STAMP)).toBe(true)
  })

  it('does not show a stale leftover count from a day that never rolled over', () => {
    // state.day is yesterday's — the counter simply hasn't seen a tap yet
    // today, so today's real count is zero regardless of the leftover number.
    const state = { day: DAY1_STAMP, count: FRICTION_THRESHOLD + 10, lastAt: DAY1_NOON }
    expect(shouldShowFrictionCard(state, undefined, true, DAY2_STAMP)).toBe(false)
  })

  it('does not show with no counter state at all', () => {
    expect(shouldShowFrictionCard(undefined, undefined, true, DAY1_STAMP)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// shouldCountResumeAsMapCheck (Phase 6 Task 4) — the app-resume hook's own
// pure gate: a resume only counts as a map-check when the tab that just
// became visible again is the Map tab itself.
// ---------------------------------------------------------------------------

describe('friction — shouldCountResumeAsMapCheck', () => {
  it('counts a resume onto the Map tab', () => {
    expect(shouldCountResumeAsMapCheck('visible', 'map')).toBe(true)
  })

  it('does not count a resume onto a different tab', () => {
    expect(shouldCountResumeAsMapCheck('visible', 'circles')).toBe(false)
    expect(shouldCountResumeAsMapCheck('visible', 'activity')).toBe(false)
    expect(shouldCountResumeAsMapCheck('visible', 'you')).toBe(false)
  })

  it('does not count the app going TO hidden (backgrounding), even on the Map tab', () => {
    expect(shouldCountResumeAsMapCheck('hidden', 'map')).toBe(false)
  })

  it('does not count any other visibilityState value', () => {
    expect(shouldCountResumeAsMapCheck('prerender', 'map')).toBe(false)
    expect(shouldCountResumeAsMapCheck('', 'map')).toBe(false)
  })
})

describe('friction — dismissFrictionCard', () => {
  it('records today\'s stamp as the dismissed day', () => {
    dismissFrictionCard(DAY1_STAMP)
    expect(store.load().frictionDismissedDay).toBe(DAY1_STAMP)
  })

  it('a card at/above threshold on a quiet day is suppressed after dismissal, same day', () => {
    recordMapCheck(DAY1_NOON)
    for (let i = 1; i < FRICTION_THRESHOLD; i++) recordMapCheck(DAY1_NOON + i * FRICTION_MIN_GAP_SEC)
    const before = store.load()
    expect(shouldShowFrictionCard(before.mapChecks, before.frictionDismissedDay, true, DAY1_STAMP)).toBe(true)
    dismissFrictionCard(DAY1_STAMP)
    const after = store.load()
    expect(shouldShowFrictionCard(after.mapChecks, after.frictionDismissedDay, true, DAY1_STAMP)).toBe(false)
  })
})
