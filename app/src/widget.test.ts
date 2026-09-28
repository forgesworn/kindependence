import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { buildWidgetStatus, MAX_WIDGET_ROWS, shouldSkipInitialPush, type WidgetStatus } from './widget.js'
import * as store from './store.js'
import type { AgreementRecord } from './store.js'
import { sessionForTests } from './session.js'
import type { Circle } from '@forgesworn/covey-kit'
import type { MergedPersonPosition, MemberPosition } from './beacons.js'
import type { MemberBattery } from './battery.js'
import { BATTERY_FRESH_SEC } from './battery.js'
import { encode as encodeGeohash } from 'geohash-kit'

// Same fixed-formatter discipline as agreements.test.ts's own `fmt` — except
// widget.ts's `buildWidgetStatus` bakes the HH:MM string into `line2` itself
// (no formatter callback in its signature — the Java provider just renders
// row text, it can't format a clock), so this mirrors its INTERNAL formatter
// exactly (`toLocaleTimeString`) rather than replacing it — deterministic
// regardless of which TZ the test runner is in, since both sides compute the
// same way.
const hhmm = (unixSec: number): string =>
  new Date(unixSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })

const PK_SELF = 'a'.repeat(64)
const PK_CHILD = 'b'.repeat(64)
const PK_PEER = 'c'.repeat(64)
const PK_UNKNOWN = 'd'.repeat(64)

function fakeCircle(overrides: Partial<Circle> = {}): Circle {
  return {
    id: 'circle-1',
    name: 'Family',
    seedHex: '1'.repeat(64),
    epoch: 0,
    members: [
      { pk: PK_SELF, role: 'guardian', name: 'Self' },
      { pk: PK_CHILD, role: 'child', name: 'Bailey' },
    ],
    createdAt: 100,
    configUpdatedAt: 100,
    configBy: PK_SELF,
    ...overrides,
  }
}

function fakePersisted(overrides: Partial<store.Persisted> = {}): store.Persisted {
  return {
    v: 1,
    circles: [fakeCircle()],
    circleRoots: {},
    contacts: [],
    rolodex: [],
    settings: {},
    safetyEvents: [],
    agreements: [],
    familyPolicies: {},
    approvals: [],
    activity: [],
    dmThreads: {},
    dmLastSeen: {},
    circleChats: {},
    circleChatLastSeen: {},
    places: {},
    placesMeta: {},
    placeEval: {},
    placeLastEscalatedAt: {},
    arrivalWindowMarks: {},
    viewPrefs: {},
    ...overrides,
  }
}

function pos(overrides: Partial<MemberPosition> = {}): MemberPosition {
  return { geohash: encodeGeohash(51.5074, -0.1278, 6), precision: 6, at: 1_700_000_000, ...overrides }
}

function merged(entries: MergedPersonPosition[]): Map<string, MergedPersonPosition> {
  return new Map(entries.map((e) => [e.pubkey, e]))
}

const noBattery = (): MemberBattery | undefined => undefined

// Signet identity plan: `buildWidgetStatus`'s own `selfPk` now reads the
// signed-in session (`currentSession()`), not a stored `identity` — every
// test in this file implicitly expects PK_SELF signed in, matching the old
// `fakePersisted`'s default `identity` field it replaces.
beforeEach(() => {
  sessionForTests({ identityPk: PK_SELF, phoneSkHex: '2'.repeat(64) })
})
afterEach(() => {
  sessionForTests(null)
})

describe('buildWidgetStatus', () => {
  it('empty merged map -> rows: []', () => {
    const p = fakePersisted()
    const status: WidgetStatus = buildWidgetStatus(p, merged([]), noBattery, 1_700_000_100)
    expect(status.rows).toEqual([])
    expect(status.updatedAt).toBe(1_700_000_100)
  })

  it('excludes the self pubkey even if present in merged', () => {
    const p = fakePersisted()
    const m = merged([{ pubkey: PK_SELF, pos: pos(), circleIds: ['circle-1'] }])
    const status = buildWidgetStatus(p, m, noBattery, 1_700_000_100)
    expect(status.rows).toEqual([])
  })

  it('falls back to an 8-char pk prefix when the pk is not in any known circle member list', () => {
    const p = fakePersisted()
    const m = merged([{ pubkey: PK_UNKNOWN, pos: pos(), circleIds: ['circle-1'] }])
    const status = buildWidgetStatus(p, m, noBattery, 1_700_000_100)
    expect(status.rows).toHaveLength(1)
    expect(status.rows[0]?.name).toBe(`${PK_UNKNOWN.slice(0, 8)}…`)
  })

  it('resolves a known member name from the circle member list', () => {
    const p = fakePersisted()
    const m = merged([{ pubkey: PK_CHILD, pos: pos(), circleIds: ['circle-1'] }])
    const status = buildWidgetStatus(p, m, noBattery, 1_700_000_100)
    expect(status.rows[0]?.name).toBe('Bailey')
  })

  it('orders guardian-of-child rows first, ahead of a MORE RECENT non-dependant row', () => {
    const peerCircle = fakeCircle({
      id: 'circle-2',
      members: [
        { pk: PK_SELF, role: 'peer', name: 'Self' },
        { pk: PK_PEER, role: 'peer', name: 'Riley' },
      ],
    })
    const p = fakePersisted({ circles: [fakeCircle(), peerCircle] })
    const m = merged([
      // Older position, but self is guardian + this pk is a child in circle-1.
      { pubkey: PK_CHILD, pos: pos({ at: 1000 }), circleIds: ['circle-1'] },
      // Fresher position, but self is only a peer in circle-2 — never a guardian-of-child row.
      { pubkey: PK_PEER, pos: pos({ at: 2000 }), circleIds: ['circle-2'] },
    ])
    const status = buildWidgetStatus(p, m, noBattery, 1_700_000_100)
    expect(status.rows.map((r) => r.name)).toEqual(['Bailey', 'Riley'])
  })

  // Review-minor #5: the SAME pk can legitimately be a guardian-of-child in
  // one circle and a plain (non-dependant) member in another — `resolveName`
  // and `isGuardianOfChild` both iterate `entry.circleIds` in order, so this
  // pins that the FIRST circle in that list wins the name (deterministic,
  // not whichever circle's Map iteration happens to land last) and that a
  // guardian-of-child match in ANY of the pk's circles is enough to sort it
  // into the dependant-first group, even though the same pk is "just" a peer
  // in another one.
  it('a pk with conflicting name/role across circles resolves the FIRST circle\'s name and still sorts dependant-first', () => {
    const circleA = fakeCircle({
      id: 'circle-a',
      members: [
        { pk: PK_SELF, role: 'guardian', name: 'Self' },
        { pk: PK_CHILD, role: 'child', name: 'Bailey' },
      ],
    })
    const circleB = fakeCircle({
      id: 'circle-b',
      members: [
        { pk: PK_SELF, role: 'peer', name: 'Self' },
        { pk: PK_CHILD, role: 'peer', name: 'B-from-work' },
      ],
    })
    const peerOnly = fakeCircle({
      id: 'circle-c',
      members: [
        { pk: PK_SELF, role: 'peer', name: 'Self' },
        { pk: PK_PEER, role: 'peer', name: 'Riley' },
      ],
    })
    const p = fakePersisted({ circles: [circleA, circleB, peerOnly] })
    const m = merged([
      // circle-a listed first in circleIds -> name resolves to 'Bailey', and
      // guardian-of-child in circle-a alone is enough to sort first, even
      // with an OLDER position than the peer-only row below.
      { pubkey: PK_CHILD, pos: pos({ at: 1000 }), circleIds: ['circle-a', 'circle-b'] },
      { pubkey: PK_PEER, pos: pos({ at: 2000 }), circleIds: ['circle-c'] },
    ])
    const status = buildWidgetStatus(p, m, noBattery, 1_700_000_100)
    expect(status.rows.map((r) => r.name)).toEqual(['Bailey', 'Riley'])

    // circleIds reversed -> circle-b now resolves first -> the OTHER name,
    // and the row is no longer treated as a dependant despite the SAME pk
    // still being a guardian-of-child in circle-a somewhere in the list...
    // except isGuardianOfChild checks EVERY circleId (not just the first),
    // so it still sorts first — only the NAME is order-sensitive.
    const mReversed = merged([
      { pubkey: PK_CHILD, pos: pos({ at: 1000 }), circleIds: ['circle-b', 'circle-a'] },
      { pubkey: PK_PEER, pos: pos({ at: 2000 }), circleIds: ['circle-c'] },
    ])
    const reversedStatus = buildWidgetStatus(p, mReversed, noBattery, 1_700_000_100)
    expect(reversedStatus.rows.map((r) => r.name)).toEqual(['B-from-work', 'Riley'])
  })

  it('orders the non-dependant remainder by recency (most recent first)', () => {
    const peerCircle = fakeCircle({
      id: 'circle-2',
      members: [
        { pk: PK_SELF, role: 'peer', name: 'Self' },
        { pk: PK_PEER, role: 'peer', name: 'Riley' },
        { pk: PK_UNKNOWN, role: 'peer', name: 'Casey' },
      ],
    })
    const p = fakePersisted({ circles: [peerCircle] })
    const m = merged([
      { pubkey: PK_PEER, pos: pos({ at: 1000 }), circleIds: ['circle-2'] },
      { pubkey: PK_UNKNOWN, pos: pos({ at: 2000 }), circleIds: ['circle-2'] },
    ])
    const status = buildWidgetStatus(p, m, noBattery, 1_700_000_100)
    expect(status.rows.map((r) => r.name)).toEqual(['Casey', 'Riley'])
  })

  it('truncates 5 people down to MAX_WIDGET_ROWS (4)', () => {
    const members = [
      { pk: PK_SELF, role: 'guardian' as const, name: 'Self' },
      { pk: 'e'.repeat(64), role: 'child' as const, name: 'One' },
      { pk: 'f'.repeat(64), role: 'child' as const, name: 'Two' },
      { pk: '1' + '1'.repeat(63), role: 'child' as const, name: 'Three' },
      { pk: '2' + '2'.repeat(63), role: 'child' as const, name: 'Four' },
      { pk: '3' + '3'.repeat(63), role: 'child' as const, name: 'Five' },
    ]
    const p = fakePersisted({ circles: [fakeCircle({ members })] })
    const m = merged(
      members
        .filter((mem) => mem.pk !== PK_SELF)
        .map((mem, i) => ({ pubkey: mem.pk, pos: pos({ at: 1000 + i }), circleIds: ['circle-1'] })),
    )
    expect(MAX_WIDGET_ROWS).toBe(4)
    const status = buildWidgetStatus(p, m, noBattery, 1_700_000_100)
    expect(status.rows).toHaveLength(4)
  })

  it('line1 is the plain availability label when there is no place attachment', () => {
    const p = fakePersisted()
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: 1_700_000_090, precision: 9 }), circleIds: ['circle-1'] }])
    const status = buildWidgetStatus(p, m, noBattery, 1_700_000_100)
    expect(status.rows[0]?.line1).toBe('Live')
  })

  it('attaches " · at <place>" only when precision >= 7 AND the point is within the place radius', () => {
    const centreGeohash = encodeGeohash(51.5074, -0.1278, 9)
    const placeCentre = { lat: 51.5074, lon: -0.1278 }
    const p = fakePersisted({
      places: { 'circle-1': [{ id: 'p1', name: 'Home', type: 'home', centre: placeCentre, radiusMetres: 200, arrivalNotify: true, departureNotify: false, escalation: 'grace', graceMinutes: 10 }] },
    })

    // precision 9 (>=7), inside radius -> attaches.
    const insideFine = merged([{ pubkey: PK_CHILD, pos: pos({ geohash: centreGeohash, precision: 9, at: 1_700_000_090 }), circleIds: ['circle-1'] }])
    const insideStatus = buildWidgetStatus(p, insideFine, noBattery, 1_700_000_100)
    expect(insideStatus.rows[0]?.line1).toContain(' · at Home')

    // precision 6 (< 7), same location -> no place claim off a town-level cell.
    const coarseSamePlace = merged([{ pubkey: PK_CHILD, pos: pos({ geohash: encodeGeohash(51.5074, -0.1278, 6), precision: 6, at: 1_700_000_090 }), circleIds: ['circle-1'] }])
    const coarseStatus = buildWidgetStatus(p, coarseSamePlace, noBattery, 1_700_000_100)
    expect(coarseStatus.rows[0]?.line1).not.toContain(' · at ')

    // precision 9, far away (outside radius) -> no attachment.
    const farGeohash = encodeGeohash(52.5074, -1.1278, 9)
    const outsideFine = merged([{ pubkey: PK_CHILD, pos: pos({ geohash: farGeohash, precision: 9, at: 1_700_000_090 }), circleIds: ['circle-1'] }])
    const outsideStatus = buildWidgetStatus(p, outsideFine, noBattery, 1_700_000_100)
    expect(outsideStatus.rows[0]?.line1).not.toContain(' · at ')
  })

  it('active agreement -> "Home by HH:MM" (no place label)', () => {
    const rec: AgreementRecord = {
      agreement: { t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: PK_CHILD, byUnix: 1_700_003_600, schedule: [], from: PK_SELF, at: 1_700_000_000 },
      status: 'acked',
    }
    const p = fakePersisted({ agreements: [rec] })
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: 1_700_000_090 }), circleIds: ['circle-1'] }])
    const status = buildWidgetStatus(p, m, noBattery, 1_700_000_100)
    expect(status.rows[0]?.line2).toBe(`Home by ${hhmm(1_700_003_600)}`)
  })

  it('active agreement with a place label -> "<label> by HH:MM"', () => {
    const rec: AgreementRecord = {
      agreement: { t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: PK_CHILD, place: { label: 'Grandma’s' }, byUnix: 1_700_003_600, schedule: [], from: PK_SELF, at: 1_700_000_000 },
      status: 'en-route',
    }
    const p = fakePersisted({ agreements: [rec] })
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: 1_700_000_090 }), circleIds: ['circle-1'] }])
    const status = buildWidgetStatus(p, m, noBattery, 1_700_000_100)
    expect(status.rows[0]?.line2).toBe(`Grandma’s by ${hhmm(1_700_003_600)}`)
  })

  it('an inactive (proposed) agreement does not contribute a line2', () => {
    const rec: AgreementRecord = {
      agreement: { t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: PK_CHILD, byUnix: 1_700_003_600, schedule: [], from: PK_SELF, at: 1_700_000_000 },
      status: 'proposed',
    }
    const p = fakePersisted({ agreements: [rec] })
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: 1_700_000_090 }), circleIds: ['circle-1'] }])
    const status = buildWidgetStatus(p, m, noBattery, 1_700_000_100)
    expect(status.rows[0]?.line2).toBeUndefined()
  })

  it('a fresh battery reading -> "Battery NN%"', () => {
    const p = fakePersisted()
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: 1_700_000_090 }), circleIds: ['circle-1'] }])
    const now = 1_700_000_100
    const batteryOf = (): MemberBattery => ({ pct: 42, charging: false, at: now - 10 })
    const status = buildWidgetStatus(p, m, batteryOf, now)
    expect(status.rows[0]?.line2).toBe('Battery 42%')
  })

  it('a stale battery reading (older than BATTERY_FRESH_SEC) is omitted', () => {
    const p = fakePersisted()
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: 1_700_000_090 }), circleIds: ['circle-1'] }])
    const now = 1_700_000_100
    const batteryOf = (): MemberBattery => ({ pct: 42, charging: false, at: now - BATTERY_FRESH_SEC - 1 })
    const status = buildWidgetStatus(p, m, batteryOf, now)
    expect(status.rows[0]?.line2).toBeUndefined()
  })

  // Review-minor: widget rows must respect the Map tab's mute preference —
  // a muted person's marker is already hidden on the map (Task 2, §9), so
  // the widget (just another view onto the same data) shouldn't keep
  // surfacing a row for them either. Pinned is an explicit override.
  it('excludes a muted person entirely', () => {
    const now = 1_700_000_100
    const p = fakePersisted({ viewPrefs: { [PK_CHILD]: { mutedUntil: -1 } } })
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: now - 10 }), circleIds: ['circle-1'] }])
    const status = buildWidgetStatus(p, m, noBattery, now)
    expect(status.rows).toEqual([])
  })

  it('includes a muted-but-pinned person', () => {
    const now = 1_700_000_100
    const p = fakePersisted({ viewPrefs: { [PK_CHILD]: { mutedUntil: -1, pinned: true } } })
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: now - 10 }), circleIds: ['circle-1'] }])
    const status = buildWidgetStatus(p, m, noBattery, now)
    expect(status.rows).toHaveLength(1)
    expect(status.rows[0]?.name).toBe('Bailey')
  })

  it('includes a pinned-but-not-muted person (pin alone is not a mute)', () => {
    const now = 1_700_000_100
    const p = fakePersisted({ viewPrefs: { [PK_CHILD]: { pinned: true } } })
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: now - 10 }), circleIds: ['circle-1'] }])
    const status = buildWidgetStatus(p, m, noBattery, now)
    expect(status.rows).toHaveLength(1)
  })

  it('includes a person once an untimed mute has expired', () => {
    const now = 1_700_000_100
    const p = fakePersisted({ viewPrefs: { [PK_CHILD]: { mutedUntil: now - 1 } } })
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: now - 10 }), circleIds: ['circle-1'] }])
    const status = buildWidgetStatus(p, m, noBattery, now)
    expect(status.rows).toHaveLength(1)
  })

  it('joins an agreement line and a fresh battery line with " · "', () => {
    const rec: AgreementRecord = {
      agreement: { t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: PK_CHILD, byUnix: 1_700_003_600, schedule: [], from: PK_SELF, at: 1_700_000_000 },
      status: 'acked',
    }
    const now = 1_700_000_100
    const p = fakePersisted({ agreements: [rec] })
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: 1_700_000_090 }), circleIds: ['circle-1'] }])
    const batteryOf = (): MemberBattery => ({ pct: 77, charging: true, at: now - 5 })
    const status = buildWidgetStatus(p, m, batteryOf, now)
    expect(status.rows[0]?.line2).toBe(`Home by ${hhmm(1_700_003_600)} · Battery 77%`)
  })
})

describe('buildWidgetStatus honest availability wiring (Phase 4 Task 1, §10)', () => {
  it('a stale position + a future scheduled raise -> "Precise from HH:MM" line1 (beats plain "No recent update")', () => {
    const now = 1_700_010_000
    const byUnix = now + 3600
    const rec: AgreementRecord = {
      agreement: { t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: PK_CHILD, byUnix, schedule: [{ fromOffsetMin: -15, precision: 9 }], from: PK_SELF, at: now - 100 },
      status: 'acked',
    }
    const p = fakePersisted({ agreements: [rec] })
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: now - 1000, precision: 9 }), circleIds: ['circle-1'] }])
    const status = buildWidgetStatus(p, m, noBattery, now)
    const raiseAt = byUnix - 15 * 60
    expect(status.rows[0]?.line1).toBe(`Precise from ${hhmm(raiseAt)}`)
  })

  it('a stale position + a low, non-charging battery reading -> the battery-may-be-out copy (no scheduled raise)', () => {
    const now = 1_700_010_000
    const p = fakePersisted()
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: now - 1000, precision: 9 }), circleIds: ['circle-1'] }])
    const batteryOf = (): MemberBattery => ({ pct: 3, charging: false, at: now - 10 })
    const status = buildWidgetStatus(p, m, batteryOf, now)
    expect(status.rows[0]?.line1).toBe('No recent update — battery may have run out')
  })

  it('a future scheduled raise beats a low battery reading in line1 too (scheduled beats battery-out)', () => {
    const now = 1_700_010_000
    const byUnix = now + 3600
    const rec: AgreementRecord = {
      agreement: { t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: PK_CHILD, byUnix, schedule: [{ fromOffsetMin: -15, precision: 9 }], from: PK_SELF, at: now - 100 },
      status: 'acked',
    }
    const p = fakePersisted({ agreements: [rec] })
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: now - 1000, precision: 9 }), circleIds: ['circle-1'] }])
    const batteryOf = (): MemberBattery => ({ pct: 3, charging: false, at: now - 10 })
    const status = buildWidgetStatus(p, m, batteryOf, now)
    const raiseAt = byUnix - 15 * 60
    expect(status.rows[0]?.line1).toBe(`Precise from ${hhmm(raiseAt)}`)
  })

  it('a fresh position still wins over a future scheduled raise and low battery (fresh pos beats everything)', () => {
    const now = 1_700_010_000
    const byUnix = now + 3600
    const rec: AgreementRecord = {
      agreement: { t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: PK_CHILD, byUnix, schedule: [{ fromOffsetMin: -15, precision: 9 }], from: PK_SELF, at: now - 100 },
      status: 'acked',
    }
    const p = fakePersisted({ agreements: [rec] })
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: now - 30, precision: 9 }), circleIds: ['circle-1'] }])
    const batteryOf = (): MemberBattery => ({ pct: 3, charging: false, at: now - 10 })
    const status = buildWidgetStatus(p, m, batteryOf, now)
    expect(status.rows[0]?.line1).toBe('Live')
  })

  it('a proposed (not yet acked) agreement does not contribute a scheduled raise to line1', () => {
    const now = 1_700_010_000
    const byUnix = now + 3600
    const rec: AgreementRecord = {
      agreement: { t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: PK_CHILD, byUnix, schedule: [{ fromOffsetMin: -15, precision: 9 }], from: PK_SELF, at: now - 100 },
      status: 'proposed',
    }
    const p = fakePersisted({ agreements: [rec] })
    const m = merged([{ pubkey: PK_CHILD, pos: pos({ at: now - 1000, precision: 9 }), circleIds: ['circle-1'] }])
    const status = buildWidgetStatus(p, m, noBattery, now)
    expect(status.rows[0]?.line1).toBe('No recent update')
  })
})

describe('shouldSkipInitialPush (final review Minor #2: cold-launch wipe guard)', () => {
  it('skips the first push when there is nothing to show yet', () => {
    expect(shouldSkipInitialPush(true, 0)).toBe(true)
  })

  it('does NOT skip the first push when it already has rows', () => {
    expect(shouldSkipInitialPush(true, 3)).toBe(false)
  })

  it('does NOT skip a later empty push (e.g. a deliberate sign-out wipe) even with zero rows', () => {
    expect(shouldSkipInitialPush(false, 0)).toBe(false)
  })

  it('does NOT skip a later push with rows either', () => {
    expect(shouldSkipInitialPush(false, 4)).toBe(false)
  })
})
