import { describe, it, expect } from 'vitest'
import {
  isPrecise,
  precisionTerm,
  locationModeLine,
  availabilityState,
  availabilityLabel,
  availabilityStateFull,
  availabilityLabelFull,
  resolveCircleSelection,
  circleSelectorLabel,
  toggleCircleSelection,
  geohashCellRing,
  circlePolygonRing,
  SELF_SHEET_TARGET,
  MUTE_DURATIONS,
  muteUntil,
  isMuted,
  muteRemainingLabel,
  fitSet,
  distanceMetres,
  clusterScreenPoints,
  bearingDeg,
  screenBearing,
  edgeAnchor,
  groupEdgeAnchors,
  formatDistance,
} from './mapinfo.js'
import type { Persisted } from './store.js'
import { haversineMetres } from '@forgesworn/flock/geofence'

describe('isPrecise', () => {
  it('is true at and above the precise threshold (9)', () => {
    expect(isPrecise(9)).toBe(true)
    expect(isPrecise(11)).toBe(true)
  })

  it('is false below the threshold', () => {
    expect(isPrecise(8)).toBe(false)
    expect(isPrecise(0)).toBe(false)
  })
})

describe('precisionTerm', () => {
  it('maps the task contract\'s scale: 9+ Precise, 7-8 Street, 6 Neighbourhood, 5 District, <=4 Town', () => {
    expect(precisionTerm(11)).toBe('Precise')
    expect(precisionTerm(9)).toBe('Precise')
    expect(precisionTerm(8)).toBe('Street')
    expect(precisionTerm(7)).toBe('Street')
    expect(precisionTerm(6)).toBe('Neighbourhood')
    expect(precisionTerm(5)).toBe('District')
    expect(precisionTerm(4)).toBe('Town')
    expect(precisionTerm(1)).toBe('Town')
  })

  it('reports nothing shared for precision 0 or below', () => {
    expect(precisionTerm(0)).toBe('Not sharing')
    expect(precisionTerm(-1)).toBe('Not sharing')
  })
})

describe('locationModeLine (Task 8, brief §12/§25 — the You-tab + self-sheet "what am I sharing" sentence)', () => {
  it('is a plain "Sharing <term> with <circle>." with no active/upcoming agreement raise', () => {
    expect(locationModeLine('Family', 'Neighbourhood')).toBe('Sharing Neighbourhood with Family.')
  })

  it('appends " · <raise term> from <time>" when a raise is supplied', () => {
    expect(locationModeLine('Family', 'Neighbourhood', { term: 'Precise', whenLabel: '17:45' }))
      .toBe('Sharing Neighbourhood with Family · Precise from 17:45.')
  })

  it('avoids "Sharing Not sharing with..." when there is no fix yet — a distinct, grammatical sentence instead', () => {
    expect(locationModeLine('Family', 'Not sharing')).toBe('Not sharing with Family yet.')
  })

  it('drops a raise clause too when there is nothing being disclosed at all', () => {
    expect(locationModeLine('Family', 'Not sharing', { term: 'Precise', whenLabel: '17:45' })).toBe('Not sharing with Family yet.')
  })

  it('appends " until <time>" when an active sharing-schedule rule is supplied and there is no raise (Phase 5 Task 2, §32.4)', () => {
    expect(locationModeLine('Family', 'Street', undefined, { untilLabel: '15:30' }))
      .toBe('Sharing Street with Family until 15:30.')
  })

  it('prefers an agreement raise over an active schedule rule when both are supplied', () => {
    expect(locationModeLine('Family', 'Street', { term: 'Precise', whenLabel: '17:45' }, { untilLabel: '15:30' }))
      .toBe('Sharing Street with Family · Precise from 17:45.')
  })

  it('drops the active-rule clause too when there is nothing being disclosed at all', () => {
    expect(locationModeLine('Family', 'Not sharing', undefined, { untilLabel: '15:30' })).toBe('Not sharing with Family yet.')
  })
})

describe('availabilityState', () => {
  const NOW = 1_700_000_000

  it('is hidden when there is no position at all', () => {
    expect(availabilityState(undefined, NOW)).toBe('hidden')
  })

  it('is hidden for a precision-0 position (nothing actually disclosed)', () => {
    expect(availabilityState({ precision: 0, at: NOW }, NOW)).toBe('hidden')
  })

  it('is live for a precise fix under 2 minutes old', () => {
    expect(availabilityState({ precision: 9, at: NOW - 60 }, NOW)).toBe('live')
  })

  it('is approximate-live for a coarse fix under 2 minutes old', () => {
    expect(availabilityState({ precision: 6, at: NOW - 60 }, NOW)).toBe('approximate-live')
  })

  it('is recent between 2 and 15 minutes old', () => {
    expect(availabilityState({ precision: 9, at: NOW - 300 }, NOW)).toBe('recent')
    expect(availabilityState({ precision: 6, at: NOW - 300 }, NOW)).toBe('approximate-recent')
  })

  it('is no-recent-update at 15 minutes or older', () => {
    expect(availabilityState({ precision: 9, at: NOW - 900 }, NOW)).toBe('no-recent-update')
    expect(availabilityState({ precision: 6, at: NOW - 1000 }, NOW)).toBe('approximate-no-recent-update')
  })

  it('treats the exact 2-minute and 15-minute boundaries as already elapsed', () => {
    expect(availabilityState({ precision: 9, at: NOW - 120 }, NOW)).toBe('recent')
    expect(availabilityState({ precision: 9, at: NOW - 900 }, NOW)).toBe('no-recent-update')
  })
})

describe('availabilityLabel', () => {
  it('renders neutral copy for every state', () => {
    expect(availabilityLabel('live')).toBe('Live')
    expect(availabilityLabel('approximate-live')).toContain('approximate')
    expect(availabilityLabel('recent')).toBe('Recent')
    expect(availabilityLabel('approximate-recent')).toContain('approximate')
    expect(availabilityLabel('no-recent-update')).toBe('No recent update')
    expect(availabilityLabel('approximate-no-recent-update')).toContain('approximate')
    expect(availabilityLabel('hidden')).toBe('Not sharing')
  })
})

describe('availabilityStateFull (Phase 4 Task 1, §10 — receiver-derived honest states)', () => {
  const NOW = 1_700_000_000
  const LIVE_POS = { precision: 9, at: NOW - 60 } // fresh, <2min
  const APPROX_LIVE_POS = { precision: 6, at: NOW - 60 }
  const RECENT_POS = { precision: 9, at: NOW - 300 } // fresh, <15min
  const APPROX_RECENT_POS = { precision: 6, at: NOW - 300 }
  const STALE_POS = { precision: 9, at: NOW - 1000 } // >=15min old
  const APPROX_STALE_POS = { precision: 6, at: NOW - 1000 }
  const HIDDEN_POS = { precision: 0, at: NOW }
  const FUTURE_RAISE = { term: 'Precise', atUnix: NOW + 600 }
  const PAST_RAISE = { term: 'Precise', atUnix: NOW - 600 }
  const LOW_BATTERY = { pct: 5, charging: false, at: NOW - 60 }

  it('a fresh (live) pos wins over everything else — future raise, low battery, never heard', () => {
    const state = availabilityStateFull(
      { pos: LIVE_POS, agreementRaise: FUTURE_RAISE, battery: LOW_BATTERY, everHeard: false },
      NOW,
    )
    expect(state).toBe('live')
  })

  it('a fresh (recent) pos also wins over a scheduled raise and low battery', () => {
    const state = availabilityStateFull(
      { pos: RECENT_POS, agreementRaise: FUTURE_RAISE, battery: LOW_BATTERY, everHeard: false },
      NOW,
    )
    expect(state).toBe('recent')
  })

  it('a future agreement raise beats a low-battery reading (scheduled beats battery-out)', () => {
    const state = availabilityStateFull(
      { pos: STALE_POS, agreementRaise: FUTURE_RAISE, battery: LOW_BATTERY, everHeard: true },
      NOW,
    )
    expect(state).toBe('sharing-scheduled')
  })

  it('is sharing-scheduled even with no pos at all, as long as the raise is in the future', () => {
    expect(availabilityStateFull({ pos: undefined, agreementRaise: FUTURE_RAISE, everHeard: true }, NOW)).toBe('sharing-scheduled')
  })

  it('a raise exactly AT now (not strictly future) does not count as scheduled', () => {
    const state = availabilityStateFull({ pos: STALE_POS, agreementRaise: { term: 'Precise', atUnix: NOW }, everHeard: true }, NOW)
    expect(state).not.toBe('sharing-scheduled')
  })

  it('a raise already in the past does not count as scheduled', () => {
    expect(availabilityStateFull({ pos: STALE_POS, agreementRaise: PAST_RAISE, everHeard: true }, NOW)).not.toBe('sharing-scheduled')
  })

  it('battery-may-be-out requires ALL three conditions: no fresh beacon, pct <= 5, not charging', () => {
    expect(availabilityStateFull({ pos: STALE_POS, battery: LOW_BATTERY, everHeard: true }, NOW)).toBe('battery-may-be-out')
    expect(availabilityStateFull({ pos: undefined, battery: LOW_BATTERY, everHeard: true }, NOW)).toBe('battery-may-be-out')
  })

  it('charging kills battery-may-be-out even at a critically low percentage', () => {
    const state = availabilityStateFull({ pos: STALE_POS, battery: { ...LOW_BATTERY, charging: true }, everHeard: true }, NOW)
    expect(state).not.toBe('battery-may-be-out')
  })

  it('6% does not qualify as battery-may-be-out (threshold is <= 5%)', () => {
    const state = availabilityStateFull({ pos: STALE_POS, battery: { pct: 6, charging: false, at: NOW }, everHeard: true }, NOW)
    expect(state).not.toBe('battery-may-be-out')
  })

  it('no battery reading at all does not trigger battery-may-be-out', () => {
    expect(availabilityStateFull({ pos: STALE_POS, everHeard: true }, NOW)).not.toBe('battery-may-be-out')
  })

  it('never-heard fires only when there is no position AND this device has never heard from them', () => {
    expect(availabilityStateFull({ pos: undefined, everHeard: false }, NOW)).toBe('never-heard')
  })

  it('never-heard does not fire when everHeard is true, even with no current pos (falls back to hidden)', () => {
    expect(availabilityStateFull({ pos: undefined, everHeard: true }, NOW)).toBe('hidden')
  })

  it('never-heard does not fire when a (stale) pos IS present, regardless of everHeard', () => {
    expect(availabilityStateFull({ pos: STALE_POS, everHeard: false }, NOW)).toBe('no-recent-update')
  })

  it('delegates to the existing tiers for every base AvailabilityState when nothing new applies', () => {
    expect(availabilityStateFull({ pos: LIVE_POS, everHeard: true }, NOW)).toBe('live')
    expect(availabilityStateFull({ pos: APPROX_LIVE_POS, everHeard: true }, NOW)).toBe('approximate-live')
    expect(availabilityStateFull({ pos: RECENT_POS, everHeard: true }, NOW)).toBe('recent')
    expect(availabilityStateFull({ pos: APPROX_RECENT_POS, everHeard: true }, NOW)).toBe('approximate-recent')
    expect(availabilityStateFull({ pos: STALE_POS, everHeard: true }, NOW)).toBe('no-recent-update')
    expect(availabilityStateFull({ pos: APPROX_STALE_POS, everHeard: true }, NOW)).toBe('approximate-no-recent-update')
    expect(availabilityStateFull({ pos: HIDDEN_POS, everHeard: true }, NOW)).toBe('hidden')
  })
})

describe('availabilityLabelFull', () => {
  it('renders the existing base labels unchanged (delegates to availabilityLabel)', () => {
    expect(availabilityLabelFull('live')).toBe('Live')
    expect(availabilityLabelFull('approximate-recent')).toContain('approximate')
    expect(availabilityLabelFull('hidden')).toBe('Not sharing')
  })

  it('renders "Precise from <time>" for a scheduled raise', () => {
    expect(availabilityLabelFull('sharing-scheduled', { raiseTime: '17:45' })).toBe('Precise from 17:45')
  })

  it('renders neutral battery-may-be-out copy', () => {
    expect(availabilityLabelFull('battery-may-be-out')).toBe('No recent update — battery may have run out')
  })

  it('renders neutral never-heard copy', () => {
    expect(availabilityLabelFull('never-heard')).toBe('No location shared')
  })
})

describe('resolveCircleSelection', () => {
  const ALL = ['a', 'b', 'c']

  it('resolves to every circle when the selection is unset', () => {
    expect(resolveCircleSelection(ALL, undefined)).toEqual(new Set(ALL))
  })

  it('resolves to every circle when the selection is an empty array', () => {
    expect(resolveCircleSelection(ALL, [])).toEqual(new Set(ALL))
  })

  it('resolves to just the selected subset', () => {
    expect(resolveCircleSelection(ALL, ['b'])).toEqual(new Set(['b']))
  })

  it('drops stale ids no longer in the known set', () => {
    expect(resolveCircleSelection(ALL, ['b', 'gone'])).toEqual(new Set(['b']))
  })

  it('falls back to every circle when every selected id is stale', () => {
    expect(resolveCircleSelection(ALL, ['gone-1', 'gone-2'])).toEqual(new Set(ALL))
  })
})

describe('circleSelectorLabel', () => {
  const CIRCLES = [{ id: 'a', name: 'Family' }, { id: 'b', name: 'Friends' }, { id: 'c', name: 'Book club' }]

  it('is "All" when the selection is unset', () => {
    expect(circleSelectorLabel(CIRCLES, undefined)).toBe('All')
  })

  it('is "All" when every circle is explicitly selected', () => {
    expect(circleSelectorLabel(CIRCLES, ['a', 'b', 'c'])).toBe('All')
  })

  it('is the circle\'s own name when exactly one is selected', () => {
    expect(circleSelectorLabel(CIRCLES, ['b'])).toBe('Friends')
  })

  it('is "N circles" when several (but not all) are selected', () => {
    expect(circleSelectorLabel(CIRCLES, ['a', 'b'])).toBe('2 circles')
  })
})

describe('toggleCircleSelection', () => {
  const ALL = ['a', 'b', 'c']

  it('starts from a full baseline when currently "All", so unchecking one leaves the rest selected', () => {
    expect(toggleCircleSelection(ALL, undefined, 'a')).toEqual(['b', 'c'])
  })

  it('adds a circle back into an existing explicit selection', () => {
    expect(toggleCircleSelection(ALL, ['b', 'c'], 'a')).toBeUndefined() // covers every circle -> canonical "All"
  })

  it('removes a circle from an existing explicit selection', () => {
    expect(toggleCircleSelection(ALL, ['a', 'b'], 'a')).toEqual(['b'])
  })

  it('collapses to undefined ("All") when the toggle empties the selection', () => {
    expect(toggleCircleSelection(ALL, ['a'], 'a')).toBeUndefined()
  })

  it('returns the result in allCircleIds order, regardless of the stored selection\'s own order', () => {
    const FOUR = ['a', 'b', 'c', 'd']
    expect(toggleCircleSelection(FOUR, ['c', 'a'], 'd')).toEqual(['a', 'c', 'd'])
  })
})

describe('geohashCellRing', () => {
  it('returns a closed 5-point ring in [lon, lat] order matching geohash-kit\'s own bounds', () => {
    const ring = geohashCellRing('gcpuuz')
    expect(ring).toHaveLength(5)
    expect(ring[0]).toEqual(ring[4]) // closed ring
    const lons = ring.map((p) => p[0])
    const lats = ring.map((p) => p[1])
    expect(Math.min(...lons)).toBeLessThan(Math.max(...lons))
    expect(Math.min(...lats)).toBeLessThan(Math.max(...lats))
  })
})

describe('circlePolygonRing', () => {
  const centre = { lat: 51.5074, lon: -0.1278 }

  it('returns a closed ring (first vertex repeated last)', () => {
    const ring = circlePolygonRing(centre, 200, 16)
    expect(ring).toHaveLength(17)
    expect(ring[0]).toEqual(ring[16])
  })

  it('every vertex sits ~radiusMetres from the centre', () => {
    const radiusMetres = 250
    const ring = circlePolygonRing(centre, radiusMetres, 32)
    for (const [lon, lat] of ring) {
      const d = haversineMetres(centre, { lat, lon })
      expect(d).toBeGreaterThan(radiusMetres * 0.99)
      expect(d).toBeLessThan(radiusMetres * 1.01)
    }
  })

  it('scales with radius', () => {
    const small = circlePolygonRing(centre, 100, 8)
    const large = circlePolygonRing(centre, 500, 8)
    const p0Small = small[0]
    const p0Large = large[0]
    if (!p0Small || !p0Large) throw new Error('expected vertices')
    expect(haversineMetres(centre, { lat: p0Small[1], lon: p0Small[0] })).toBeLessThan(
      haversineMetres(centre, { lat: p0Large[1], lon: p0Large[0] }),
    )
  })
})

describe('SELF_SHEET_TARGET', () => {
  it('is never a valid 64-hex pubkey (so it can never collide with a real one)', () => {
    expect(/^[0-9a-f]{64}$/.test(SELF_SHEET_TARGET)).toBe(false)
  })
})

describe('MUTE_DURATIONS (Phase 4 Task 2, brief §9 — verbatim durations)', () => {
  it('has exactly the five brief-specified label/sec pairs, in order', () => {
    expect(MUTE_DURATIONS).toEqual([
      { label: '10 min', sec: 600 },
      { label: '1 hour', sec: 3600 },
      { label: 'Until tomorrow', sec: 'tomorrow' },
      { label: '3 days', sec: 259200 },
      { label: 'Until I unmute', sec: -1 },
    ])
  })
})

describe('muteUntil (Phase 4 Task 2, brief §9)', () => {
  it('adds a fixed-second duration straight onto nowSecValue', () => {
    expect(muteUntil(600, 1000, new Date(2026, 6, 20, 12, 0, 0))).toBe(1600)
    expect(muteUntil(3600, 1000, new Date(2026, 6, 20, 12, 0, 0))).toBe(4600)
    expect(muteUntil(259200, 1000, new Date(2026, 6, 20, 12, 0, 0))).toBe(260200)
  })

  it('-1 ("Until I unmute") passes straight through as the until-restored sentinel, ignoring nowSecValue/localNow', () => {
    expect(muteUntil(-1, 1000, new Date(2026, 6, 20, 12, 0, 0))).toBe(-1)
    expect(muteUntil(-1, 999999, new Date(2099, 0, 1))).toBe(-1)
  })

  it('"tomorrow" before local 04:00 resolves to TODAY\'s 04:00 (the next occurrence of the clock time)', () => {
    const localNow = new Date(2026, 6, 20, 2, 0, 0) // 2026-07-20 02:00 local
    const nowSecValue = 1_000_000
    expect(muteUntil('tomorrow', nowSecValue, localNow)).toBe(nowSecValue + 2 * 3600) // 2h to 04:00
  })

  it('"tomorrow" after local 04:00 resolves to the NEXT day\'s 04:00', () => {
    const localNow = new Date(2026, 6, 20, 15, 0, 0) // 2026-07-20 15:00 local
    const nowSecValue = 1_000_000
    expect(muteUntil('tomorrow', nowSecValue, localNow)).toBe(nowSecValue + 13 * 3600) // 13h to next day 04:00
  })

  it('"tomorrow" exactly AT local 04:00 rolls to the NEXT day (not zero-duration)', () => {
    const localNow = new Date(2026, 6, 20, 4, 0, 0, 0)
    const nowSecValue = 1_000_000
    expect(muteUntil('tomorrow', nowSecValue, localNow)).toBe(nowSecValue + 24 * 3600)
  })

  it('"tomorrow" crosses midnight AND a month boundary correctly (cross-midnight case)', () => {
    // 2026-01-31 23:00 local -> next local 04:00 is 2026-02-01 04:00 (5h later),
    // exercising both the day-rollover AND the month-rollover Date arithmetic.
    const localNow = new Date(2026, 0, 31, 23, 0, 0)
    const nowSecValue = 2_000_000
    const result = muteUntil('tomorrow', nowSecValue, localNow)
    expect(result).toBe(nowSecValue + 5 * 3600)
    // Directly verify the resolved instant really is 2026-02-01 04:00 local.
    const resolvedDate = new Date(localNow.getTime() + (result - nowSecValue) * 1000)
    expect(resolvedDate.getFullYear()).toBe(2026)
    expect(resolvedDate.getMonth()).toBe(1) // February (0-indexed)
    expect(resolvedDate.getDate()).toBe(1)
    expect(resolvedDate.getHours()).toBe(4)
  })
})

describe('isMuted (Phase 4 Task 2, brief §9)', () => {
  const prefs: Persisted['viewPrefs'] = {
    none: {},
    pinnedOnly: { pinned: true },
    untilRestored: { mutedUntil: -1 },
    future: { mutedUntil: 2000 },
  }

  it('false when there is no entry at all', () => {
    expect(isMuted(prefs, 'nobody', 1000)).toBe(false)
  })

  it('false when the entry has no mutedUntil (pinned-only)', () => {
    expect(isMuted(prefs, 'pinnedOnly', 1000)).toBe(false)
  })

  it('-1 is always muted, regardless of nowSecValue', () => {
    expect(isMuted(prefs, 'untilRestored', 1000)).toBe(true)
    expect(isMuted(prefs, 'untilRestored', 99_999_999)).toBe(true)
  })

  it('muted while mutedUntil is strictly in the future', () => {
    expect(isMuted(prefs, 'future', 1000)).toBe(true)
    expect(isMuted(prefs, 'future', 1999)).toBe(true)
  })

  it('not muted once mutedUntil has been reached (exact boundary) or passed', () => {
    expect(isMuted(prefs, 'future', 2000)).toBe(false)
    expect(isMuted(prefs, 'future', 2001)).toBe(false)
  })
})

describe('muteRemainingLabel (Phase 4 Task 2)', () => {
  it('"until you unmute" for the -1 sentinel', () => {
    expect(muteRemainingLabel(-1, 1000)).toBe('until you unmute')
  })

  it('rounds up to whole minutes under an hour, floored at 1m', () => {
    expect(muteRemainingLabel(1090, 1000)).toBe('2m left') // 90s -> ceil(90/60)=2
    expect(muteRemainingLabel(1005, 1000)).toBe('1m left') // 5s -> floored at 1m, not 0m
  })

  it('rounds up to whole hours under a day', () => {
    expect(muteRemainingLabel(1000 + 7200, 1000)).toBe('2h left')
  })

  it('rounds up to whole days at/above a day', () => {
    expect(muteRemainingLabel(1000 + 2 * 86400, 1000)).toBe('2d left')
  })
})

describe('fitSet (Phase 4 Task 2, brief §6.5 — adaptive default view / "holiday abroad" rule)', () => {
  const self = { lat: 51.5, lon: -0.12 }
  const p1 = { pk: 'p1', lat: 51.501, lon: -0.121 } // ~150m from self
  const p2 = { pk: 'p2', lat: 51.499, lon: -0.119 } // ~150m from self
  const p3 = { pk: 'p3', lat: 51.502, lon: -0.118 } // ~300m from self
  const far = { pk: 'far', lat: -33.87, lon: 151.21 } // Sydney — ~17,000km away
  const now = 1000

  it('all-near case: nobody excluded (everyone within the 50km floor)', () => {
    const result = fitSet([p1, p2, p3], {}, self, now)
    expect(result).toEqual([
      self,
      { lat: p1.lat, lon: p1.lon },
      { lat: p2.lat, lon: p2.lon },
      { lat: p3.lat, lon: p3.lon },
    ])
  })

  it('holiday-abroad case: the lone far-away unpinned/unmuted person is excluded as an outlier', () => {
    const result = fitSet([p1, p2, p3, far], {}, self, now)
    expect(result).toEqual([
      self,
      { lat: p1.lat, lon: p1.lon },
      { lat: p2.lat, lon: p2.lon },
      { lat: p3.lat, lon: p3.lon },
    ])
  })

  it('pinned-far-away included: pinning the outlier bypasses the outlier exclusion', () => {
    const prefs: Persisted['viewPrefs'] = { far: { pinned: true } }
    const result = fitSet([p1, p2, p3, far], prefs, self, now)
    expect(result).toEqual([
      self,
      { lat: p1.lat, lon: p1.lon },
      { lat: p2.lat, lon: p2.lon },
      { lat: p3.lat, lon: p3.lon },
      { lat: far.lat, lon: far.lon },
    ])
  })

  it('muted excluded: a muted person never appears, regardless of distance', () => {
    const prefs: Persisted['viewPrefs'] = { p3: { mutedUntil: -1 } }
    const result = fitSet([p1, p2, p3], prefs, self, now)
    expect(result).toEqual([
      self,
      { lat: p1.lat, lon: p1.lon },
      { lat: p2.lat, lon: p2.lon },
    ])
  })

  it('an EXPIRED mute no longer excludes (isMuted delegation, not a separate rule)', () => {
    const prefs: Persisted['viewPrefs'] = { p3: { mutedUntil: 500 } } // already expired at now=1000
    const result = fitSet([p1, p2, p3], prefs, self, now)
    expect(result).toEqual([
      self,
      { lat: p1.lat, lon: p1.lon },
      { lat: p2.lat, lon: p2.lon },
      { lat: p3.lat, lon: p3.lon },
    ])
  })

  it('no self position: still works from just the other members', () => {
    const result = fitSet([p1, p2, p3], {}, null, now)
    expect(result).toEqual([
      { lat: p1.lat, lon: p1.lon },
      { lat: p2.lat, lon: p2.lon },
      { lat: p3.lat, lon: p3.lon },
    ])
  })

  it('empty input (no people, no self) returns an empty set', () => {
    expect(fitSet([], {}, null, now)).toEqual([])
  })
})

// Review-minor: `distanceMetres`'s own doc comment claims a cross-check
// against `@forgesworn/flock/geofence`'s `haversineMetres` — this is that
// assertion, same ±1% tolerance idiom `circlePolygonRing`'s tests above
// already use (both compute the same great-circle formula, but via
// independent implementations/constants, so exact floating-point equality
// isn't the promise being tested).
describe('distanceMetres (cross-checked against @forgesworn/flock/geofence)', () => {
  it('agrees with haversineMetres on a short, a medium, and a long-range pair', () => {
    const pairs: Array<[{ lat: number; lon: number }, { lat: number; lon: number }]> = [
      // Short range: two points a few hundred metres apart in London.
      [{ lat: 51.5074, lon: -0.1278 }, { lat: 51.5090, lon: -0.1278 }],
      // Medium range: London to Bristol (~170 km).
      [{ lat: 51.5074, lon: -0.1278 }, { lat: 51.4545, lon: -2.5879 }],
      // Long range: London to Sydney (~17,000 km).
      [{ lat: 51.5074, lon: -0.1278 }, { lat: -33.8688, lon: 151.2093 }],
    ]
    for (const [a, b] of pairs) {
      const mine = distanceMetres(a, b)
      const flock = haversineMetres(a, b)
      expect(mine).toBeGreaterThan(flock * 0.99)
      expect(mine).toBeLessThan(flock * 1.01)
    }
  })

  it('is symmetric and zero for a point against itself', () => {
    const a = { lat: 40.7128, lon: -74.006 }
    const b = { lat: 35.6762, lon: 139.6503 }
    expect(distanceMetres(a, a)).toBe(0)
    expect(distanceMetres(a, b)).toBeCloseTo(distanceMetres(b, a), 6)
  })
})

describe('clusterScreenPoints (Phase 4 Task 3, brief §7.4 — greedy grid-hash clustering)', () => {
  it('merges two points near each other into a single 2-member cluster (centroid = mean)', () => {
    const points = [
      { pk: 'a', x: 100, y: 100 },
      { pk: 'b', x: 110, y: 100 },
    ]
    expect(clusterScreenPoints(points, 44)).toEqual([
      { x: 105, y: 100, members: ['a', 'b'] },
    ])
  })

  it('chain-adjacent merge: three points where only consecutive pairs are within radius end up in ONE cluster', () => {
    // a-b = 40 (within 44), b-c = 40 (within 44), a-c = 80 (NOT within 44) —
    // still a single cluster, since b bridges a and c transitively.
    const points = [
      { pk: 'a', x: 0, y: 0 },
      { pk: 'b', x: 40, y: 0 },
      { pk: 'c', x: 80, y: 0 },
    ]
    expect(clusterScreenPoints(points, 44)).toEqual([
      { x: 40, y: 0, members: ['a', 'b', 'c'] },
    ])
  })

  it('far-apart points stay in separate singleton clusters', () => {
    const points = [
      { pk: 'a', x: 0, y: 0 },
      { pk: 'b', x: 500, y: 500 },
    ]
    expect(clusterScreenPoints(points, 44)).toEqual([
      { x: 0, y: 0, members: ['a'] },
      { x: 500, y: 500, members: ['b'] },
    ])
  })

  it('a single point comes back as its own 1-member cluster', () => {
    expect(clusterScreenPoints([{ pk: 'solo', x: 12, y: 34 }], 44)).toEqual([
      { x: 12, y: 34, members: ['solo'] },
    ])
  })

  it('is deterministic regardless of input array order (same point set, different orders -> identical output)', () => {
    const a = { pk: 'a', x: 0, y: 0 }
    const b = { pk: 'b', x: 40, y: 0 }
    const c = { pk: 'c', x: 80, y: 0 }
    const far = { pk: 'far', x: 1000, y: 1000 }
    const forward = [a, b, c, far]
    const shuffled = [far, c, a, b]
    const resultForward = clusterScreenPoints(forward, 44)
    const resultShuffled = clusterScreenPoints(shuffled, 44)
    expect(resultShuffled).toEqual(resultForward)
    expect(resultForward).toEqual([
      { x: 40, y: 0, members: ['a', 'b', 'c'] },
      { x: 1000, y: 1000, members: ['far'] },
    ])
  })

  it('radius boundary is inclusive: exactly 44px apart merges', () => {
    const points = [
      { pk: 'a', x: 0, y: 0 },
      { pk: 'b', x: 44, y: 0 },
    ]
    expect(clusterScreenPoints(points, 44)).toEqual([
      { x: 22, y: 0, members: ['a', 'b'] },
    ])
  })

  it('radius boundary is exclusive just beyond 44px: stays separate', () => {
    const points = [
      { pk: 'a', x: 0, y: 0 },
      { pk: 'b', x: 44.01, y: 0 },
    ]
    expect(clusterScreenPoints(points, 44)).toEqual([
      { x: 0, y: 0, members: ['a'] },
      { x: 44.01, y: 0, members: ['b'] },
    ])
  })

  it('defaults radiusPx to 44 when omitted', () => {
    const points = [
      { pk: 'a', x: 0, y: 0 },
      { pk: 'b', x: 44, y: 0 },
      { pk: 'c', x: 44.01, y: 200 },
    ]
    expect(clusterScreenPoints(points)).toEqual([
      { x: 22, y: 0, members: ['a', 'b'] },
      { x: 44.01, y: 200, members: ['c'] },
    ])
  })
})

describe('bearingDeg (Phase 4 Task 4, brief §7.5-7.6 — compass bearing, 0=N clockwise)', () => {
  const origin = { lat: 0, lon: 0 }

  it('due north is 0', () => {
    expect(bearingDeg(origin, { lat: 1, lon: 0 })).toBeCloseTo(0, 5)
  })

  it('due east is 90', () => {
    expect(bearingDeg(origin, { lat: 0, lon: 1 })).toBeCloseTo(90, 5)
  })

  it('due south is 180', () => {
    expect(bearingDeg(origin, { lat: -1, lon: 0 })).toBeCloseTo(180, 5)
  })

  it('due west is 270', () => {
    expect(bearingDeg(origin, { lat: 0, lon: -1 })).toBeCloseTo(270, 5)
  })

  it('is always normalized into [0, 360)', () => {
    const b = bearingDeg({ lat: 10, lon: 10 }, { lat: 5, lon: 5 })
    expect(b).toBeGreaterThanOrEqual(0)
    expect(b).toBeLessThan(360)
  })
})

describe('screenBearing (edge-chip rotation fix — true compass bearing -> screen-relative)', () => {
  it('is the identity when the map bearing is 0 (north-up, the common case)', () => {
    expect(screenBearing(0, 0)).toBeCloseTo(0, 5)
    expect(screenBearing(90, 0)).toBeCloseTo(90, 5)
    expect(screenBearing(270, 0)).toBeCloseTo(270, 5)
  })

  it('subtracts a positive map bearing (camera rotated clockwise)', () => {
    // Someone due east (true bearing 90) with the camera rotated 30° CW is
    // now only 60° clockwise from whatever's at the top of the screen.
    expect(screenBearing(90, 30)).toBeCloseTo(60, 5)
  })

  it('subtracts a negative map bearing (camera rotated counter-clockwise)', () => {
    // maplibre's own getBearing() can itself return a negative value
    // (counter-clockwise rotation) — screenBearing must accept that as
    // readily as a positive one.
    expect(screenBearing(90, -30)).toBeCloseTo(120, 5)
  })

  it('wraps below 0 back into [0, 360)', () => {
    // trueBearing (10) < mapBearingDeg (30) -> a naive `%` would return -20
    // in JS; screenBearing must normalize that into 340.
    expect(screenBearing(10, 30)).toBeCloseTo(340, 5)
  })

  it('wraps above 360 back into [0, 360)', () => {
    // A true bearing near 360 minus a negative (CCW) map bearing can
    // overshoot 360 before normalizing.
    expect(screenBearing(350, -20)).toBeCloseTo(10, 5)
  })

  it('a full 360° map bearing is equivalent to 0 (no rotation)', () => {
    expect(screenBearing(45, 360)).toBeCloseTo(45, 5)
  })

  it('is always normalized into [0, 360)', () => {
    for (const trueBearing of [0, 45, 179.9, 359.9]) {
      for (const mapBearingDeg of [-370, -180, -0.1, 0, 0.1, 180, 370]) {
        const b = screenBearing(trueBearing, mapBearingDeg)
        expect(b).toBeGreaterThanOrEqual(0)
        expect(b).toBeLessThan(360)
      }
    }
  })
})

describe('edgeAnchor (Phase 4 Task 4, brief §7.5-7.6 — bearing ray x inset rectangle)', () => {
  const width = 400
  const height = 300
  const inset = 28

  it('bearing 0 (N) anchors at top-centre of the inset rect', () => {
    const a = edgeAnchor(0, width, height, inset)
    expect(a.x).toBeCloseTo(width / 2, 5)
    expect(a.y).toBeCloseTo(inset, 5)
  })

  it('bearing 90 (E) anchors at right-centre of the inset rect', () => {
    const a = edgeAnchor(90, width, height, inset)
    expect(a.x).toBeCloseTo(width - inset, 5)
    expect(a.y).toBeCloseTo(height / 2, 5)
  })

  it('bearing 180 (S) anchors at bottom-centre of the inset rect', () => {
    const a = edgeAnchor(180, width, height, inset)
    expect(a.x).toBeCloseTo(width / 2, 5)
    expect(a.y).toBeCloseTo(height - inset, 5)
  })

  it('bearing 270 (W) anchors at left-centre of the inset rect', () => {
    const a = edgeAnchor(270, width, height, inset)
    expect(a.x).toBeCloseTo(inset, 5)
    expect(a.y).toBeCloseTo(height / 2, 5)
  })

  it('bearing 135 on a SQUARE canvas anchors exactly at the SE corner', () => {
    const size = 300
    const a = edgeAnchor(135, size, size, inset)
    expect(a.x).toBeCloseTo(size - inset, 5)
    expect(a.y).toBeCloseTo(size - inset, 5)
  })

  it('respects a custom inset', () => {
    const a = edgeAnchor(0, width, height, 60)
    expect(a.y).toBeCloseTo(60, 5)
  })

  it('defaults inset to 28 when omitted', () => {
    const a = edgeAnchor(0, width, height)
    expect(a.y).toBeCloseTo(28, 5)
  })
})

describe('groupEdgeAnchors (Phase 4 Task 4, brief §7.5-7.6 — same greedy idiom as clusterScreenPoints)', () => {
  it('merges two nearby anchors into one group; nearestM is the closer member\'s own distance', () => {
    const chips = [
      { pk: 'a', x: 100, y: 100, distanceM: 500 },
      { pk: 'b', x: 110, y: 100, distanceM: 300 },
    ]
    expect(groupEdgeAnchors(chips, 48)).toEqual([
      { x: 105, y: 100, members: ['a', 'b'], nearestM: 300 },
    ])
  })

  it('far-apart anchors stay separate singleton groups', () => {
    const chips = [
      { pk: 'a', x: 0, y: 0, distanceM: 100 },
      { pk: 'b', x: 500, y: 500, distanceM: 200 },
    ]
    expect(groupEdgeAnchors(chips, 48)).toEqual([
      { x: 0, y: 0, members: ['a'], nearestM: 100 },
      { x: 500, y: 500, members: ['b'], nearestM: 200 },
    ])
  })

  it('a single anchor comes back as its own 1-member group', () => {
    expect(groupEdgeAnchors([{ pk: 'solo', x: 12, y: 34, distanceM: 900 }], 48)).toEqual([
      { x: 12, y: 34, members: ['solo'], nearestM: 900 },
    ])
  })

  it('is deterministic regardless of input array order', () => {
    const a = { pk: 'a', x: 0, y: 0, distanceM: 10 }
    const b = { pk: 'b', x: 40, y: 0, distanceM: 20 }
    const c = { pk: 'c', x: 500, y: 500, distanceM: 30 }
    const forward = [a, b, c]
    const shuffled = [c, a, b]
    expect(groupEdgeAnchors(shuffled, 48)).toEqual(groupEdgeAnchors(forward, 48))
  })

  it('defaults minGapPx to 48 when omitted', () => {
    const chips = [
      { pk: 'a', x: 0, y: 0, distanceM: 5 },
      { pk: 'b', x: 48, y: 0, distanceM: 15 },
    ]
    expect(groupEdgeAnchors(chips)).toEqual([
      { x: 24, y: 0, members: ['a', 'b'], nearestM: 5 },
    ])
  })
})

describe('formatDistance (Phase 4 Task 4, brief §7.5-7.6 — chip distance label)', () => {
  it('formats sub-1000m distances as rounded whole metres', () => {
    expect(formatDistance(850)).toBe('850 m')
    expect(formatDistance(0)).toBe('0 m')
    expect(formatDistance(999)).toBe('999 m')
  })

  it('rounds sub-1000m to the nearest whole metre', () => {
    expect(formatDistance(849.6)).toBe('850 m')
    expect(formatDistance(849.4)).toBe('849 m')
  })

  it('formats 1000m and above as one-decimal km', () => {
    expect(formatDistance(1000)).toBe('1.0 km')
    expect(formatDistance(2260)).toBe('2.3 km')
    expect(formatDistance(15000)).toBe('15.0 km')
  })
})
