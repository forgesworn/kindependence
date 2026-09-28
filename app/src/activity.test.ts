import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as store from './store.js'
import type { ActivityEvent } from './store.js'
import { sessionForTests } from './session.js'
import {
  applyRecordActivity,
  recordActivity,
  summarize,
  matchesFilter,
  deepLinkFor,
  relativeTime,
  localActivityId,
  pruneActivity,
  clearRoutineEvents,
  setActivityRetentionCap,
  setActivityRetentionDropRoutine,
  clearRoutineHistory,
  nextClearRoutineConfirmState,
  AUDIT_KINDS,
  ACTIVITY_RETENTION_CAP_OPTIONS,
  DEFAULT_ACTIVITY_RETENTION_CAP,
} from './activity.js'
import type { Circle } from '@forgesworn/covey-kit'

// Same minimal in-memory localStorage stand-in as store.test.ts — recordActivity
// (the impure wrapper) round-trips through the real store.
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

afterEach(() => {
  sessionForTests(null)
})

const PK_A = 'a'.repeat(64) // guardian, "Alex"
const PK_B = 'b'.repeat(64) // child, "Bailey"

function fakeCircle(overrides: Partial<Circle> = {}): Circle {
  return {
    id: 'circle-1', name: "Alex's family", seedHex: '1'.repeat(64), epoch: 0,
    members: [
      { pk: PK_A, role: 'guardian', name: 'Alex' },
      { pk: PK_B, role: 'child', name: 'Bailey' },
    ],
    createdAt: 100, configUpdatedAt: 100, configBy: PK_A,
    ...overrides,
  }
}

function fakePersisted(overrides: Partial<store.Persisted> = {}): store.Persisted {
  return {
    v: 1, circles: [fakeCircle()], circleRoots: {}, contacts: [], settings: {},
    safetyEvents: [], agreements: [], familyPolicies: {}, approvals: [], activity: [],
    dmThreads: {}, dmLastSeen: {}, circleChats: {}, circleChatLastSeen: {},
    ...overrides,
  }
}

function evt(overrides: Partial<ActivityEvent> = {}): ActivityEvent {
  return { id: 'evt-1', at: 1_700_000_000, kind: 'checkin', circleId: 'circle-1', actorPk: PK_A, params: {}, ...overrides }
}

describe('applyRecordActivity — pure reducer', () => {
  it('inserts a new event at the front (newest-first)', () => {
    const first = evt({ id: 'a', at: 100 })
    const second = evt({ id: 'b', at: 200 })
    expect(applyRecordActivity([first], second)).toEqual([second, first])
  })

  it('dedupes by id — returns the SAME array reference, the original entry untouched', () => {
    const existing = [evt({ id: 'a', kind: 'checkin' })]
    const result = applyRecordActivity(existing, evt({ id: 'a', kind: 'sos' }))
    expect(result).toBe(existing)
    expect(result[0]?.kind).toBe('checkin')
  })

  // Phase 5 Task 4 (brief §24.6): the pure reducer's own hard ceiling moved
  // from 500 to 1000 (`ACTIVITY_RETENTION_CAP_OPTIONS`'s largest choice) so
  // a configured retention cap of 1000 is never pre-truncated away here —
  // the actual user-facing cap (100/500/1000, default 500, same default this
  // ceiling used to enforce directly) is applied afterward by
  // `pruneActivity`, exercised in its own describe block below.
  it('caps at 1000 (the hard ceiling), dropping the OLDEST (the tail of a newest-first list)', () => {
    let list: ActivityEvent[] = []
    for (let i = 0; i < 1000; i++) list = applyRecordActivity(list, evt({ id: `e${i}`, at: i }))
    expect(list).toHaveLength(1000)
    expect(list.some((e) => e.id === 'e0')).toBe(true) // still present — exactly at the cap, nothing dropped yet

    const fresh = evt({ id: 'newest', at: 2000 })
    const capped = applyRecordActivity(list, fresh)
    expect(capped).toHaveLength(1000)
    expect(capped[0]).toEqual(fresh)
    expect(capped.some((e) => e.id === 'e0')).toBe(false) // the earliest-inserted (now the tail) fell off
    expect(capped.some((e) => e.id === 'e999')).toBe(true) // everything else survives
  })

  it('tolerates an unrecognised kind — inserts it like any other event', () => {
    const result = applyRecordActivity([], evt({ id: 'a', kind: 'some-future-kind' }))
    expect(result).toEqual([evt({ id: 'a', kind: 'some-future-kind' })])
  })

  // Regression: a late-arriving OLD wire event (offline catch-up replay, a
  // gift-wrap's randomized outer timestamp, or simple multi-circle
  // interleave) must land in its actual chronological slot, not jump the
  // queue just because it was RECEIVED after something newer — a blind
  // `[evt, ...events]` prepend breaks the newest-first contract.
  it('inserts a late-arriving OLDER event into its chronological slot, not at the front', () => {
    const newer = evt({ id: 'newer', at: 2000 })
    const older = evt({ id: 'older', at: 500 })
    let list: ActivityEvent[] = []
    list = applyRecordActivity(list, newer) // received first
    list = applyRecordActivity(list, older) // arrives late, but chronologically older
    expect(list.map((e) => e.id)).toEqual(['newer', 'older'])
  })

  it('is stable across equal `at` values — a same-timestamp arrival goes AFTER already-recorded equals, never displacing them (no list churn)', () => {
    let list: ActivityEvent[] = []
    list = applyRecordActivity(list, evt({ id: 'a', at: 1000 }))
    list = applyRecordActivity(list, evt({ id: 'b', at: 1000 }))
    list = applyRecordActivity(list, evt({ id: 'c', at: 1000 }))
    expect(list.map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })

  it('drops an old event that sorts past the cap boundary rather than evicting a newer one', () => {
    let list: ActivityEvent[] = []
    for (let i = 0; i < 1000; i++) list = applyRecordActivity(list, evt({ id: `e${i}`, at: 10_000 + i }))
    expect(list).toHaveLength(1000)

    const ancient = evt({ id: 'ancient', at: 1 }) // older than every entry already on the list
    const result = applyRecordActivity(list, ancient)
    expect(result).toHaveLength(1000)
    expect(result.some((e) => e.id === 'ancient')).toBe(false) // never admitted — it sorts past the cap
    expect(result.some((e) => e.id === 'e0')).toBe(true) // nothing already-in was evicted for it
    expect(result.some((e) => e.id === 'e999')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// pruneActivity / clearRoutineEvents (Phase 5 Task 4, brief §24.6) — pure
// reducers, tested directly. `pruneActivity` assumes `events` is already
// newest-first sorted (same invariant `applyRecordActivity` maintains for
// `Persisted.activity` in real usage) — its cap eviction removes from the
// TAIL of the array as "oldest within class", by position, not by
// re-sorting on `at`.
// ---------------------------------------------------------------------------

describe('pruneActivity — retention policy', () => {
  const SEVEN_DAYS = 7 * 24 * 60 * 60
  const NOW = 2_000_000

  describe('dropRoutine — 7-day age pruning of routine kinds only', () => {
    it('drops a routine event STRICTLY older than 7 days', () => {
      const old = evt({ id: 'old', kind: 'arrival', at: NOW - SEVEN_DAYS - 1 })
      expect(pruneActivity([old], { dropRoutine: true }, NOW)).toEqual([])
    })

    it('keeps a routine event exactly AT the 7-day boundary — only strictly-older is dropped', () => {
      const boundary = evt({ id: 'boundary', kind: 'arrival', at: NOW - SEVEN_DAYS })
      expect(pruneActivity([boundary], { dropRoutine: true }, NOW)).toEqual([boundary])
    })

    it('keeps a routine event younger than 7 days', () => {
      const fresh = evt({ id: 'fresh', kind: 'departure', at: NOW - 100 })
      expect(pruneActivity([fresh], { dropRoutine: true }, NOW)).toEqual([fresh])
    })

    it('all four routine kinds are pruned by age: arrival, departure, precision-raised, message', () => {
      const olds = ['arrival', 'departure', 'precision-raised', 'message']
        .map((kind, i) => evt({ id: `r${i}`, kind, at: NOW - SEVEN_DAYS - 1 }))
      expect(pruneActivity(olds, { dropRoutine: true }, NOW)).toEqual([])
    })

    it('is a no-op (same reference) when dropRoutine is off/absent, however old routine events are', () => {
      const list = [evt({ id: 'old', kind: 'message', at: NOW - SEVEN_DAYS * 10 })]
      expect(pruneActivity(list, { dropRoutine: false }, NOW)).toBe(list)
      expect(pruneActivity(list, undefined, NOW)).toBe(list)
    })

    it('audit exemption: AUDIT_KINDS are never dropped by age, no matter how old, even with dropRoutine on', () => {
      const ancientSos = evt({ id: 'sos-old', kind: 'sos', at: NOW - SEVEN_DAYS * 100 })
      expect(pruneActivity([ancientSos], { dropRoutine: true }, NOW)).toEqual([ancientSos])
    })

    // Phase 6 final-review finding 8: 'window-missed' feeds friction.ts's/
    // milestones.ts's own quiet-day/quiet-streak heuristics — losing it to
    // age-based pruning (or, per the cap-eviction describe block below,
    // being evicted ahead of AUDIT_KINDS) would fabricate a clean streak
    // that never actually happened.
    it('audit exemption: a "window-missed" entry is never dropped by age either, now that finding 8 added it to AUDIT_KINDS', () => {
      const ancientWindowMissed = evt({ id: 'window-missed-old', kind: 'window-missed', at: NOW - SEVEN_DAYS * 100 })
      expect(pruneActivity([ancientWindowMissed], { dropRoutine: true }, NOW)).toEqual([ancientWindowMissed])
    })

    it('non-audit, non-routine kinds are also exempt from dropRoutine (it only targets routine kinds)', () => {
      const ancientCheckin = evt({ id: 'checkin-old', kind: 'checkin', at: NOW - SEVEN_DAYS * 100 })
      expect(pruneActivity([ancientCheckin], { dropRoutine: true }, NOW)).toEqual([ancientCheckin])
    })
  })

  describe('cap — default and explicit values', () => {
    function newestFirst(n: number, kind = 'checkin'): ActivityEvent[] {
      return Array.from({ length: n }, (_, i) => evt({ id: `e${i}`, kind, at: 1000 - i }))
    }

    it('defaults to 500 when retention is undefined', () => {
      const result = pruneActivity(newestFirst(600), undefined, NOW)
      expect(result).toHaveLength(DEFAULT_ACTIVITY_RETENTION_CAP)
      expect(result[0]?.id).toBe('e0') // newest survives
    })

    it.each(ACTIVITY_RETENTION_CAP_OPTIONS)('honours an explicit valid cap of %d', (cap) => {
      const result = pruneActivity(newestFirst(cap + 50), { cap }, NOW)
      expect(result).toHaveLength(cap)
    })

    it('falls back to the default cap for an invalid/out-of-range value', () => {
      const list = newestFirst(600)
      expect(pruneActivity(list, { cap: 999 }, NOW)).toHaveLength(DEFAULT_ACTIVITY_RETENTION_CAP)
      expect(pruneActivity(list, { cap: -1 }, NOW)).toHaveLength(DEFAULT_ACTIVITY_RETENTION_CAP)
      expect(pruneActivity(list, { cap: 0 }, NOW)).toHaveLength(DEFAULT_ACTIVITY_RETENTION_CAP)
    })

    it('is a no-op (same reference) when already at or under cap', () => {
      const list = newestFirst(10)
      expect(pruneActivity(list, { cap: 100 }, NOW)).toBe(list)
    })
  })

  // These use the SMALLEST real cap option (100 — `ACTIVITY_RETENTION_CAP_OPTIONS`
  // only allows 100/500/1000, `resolveRetentionCap` falls back to the default
  // for anything else) so fixtures are sized proportionally: a handful of
  // "interesting" boundary events plus enough same-class filler to actually
  // cross the cap.
  describe('cap eviction order — routine, then non-audit/non-routine, then audit LAST', () => {
    function fillerBlock(n: number, kind: string, prefix: string): ActivityEvent[] {
      // Newest-first within the block (prefix0 is newest, prefixN-1 oldest).
      return Array.from({ length: n }, (_, i) => evt({ id: `${prefix}${i}`, kind, at: 1000 - i }))
    }

    it('evicts routine kinds first, oldest-within-class, before touching non-audit or audit kinds', () => {
      const audit = fillerBlock(50, 'sos', 'audit')
      const nonAudit = fillerBlock(49, 'checkin', 'nonaudit')
      const routine = fillerBlock(3, 'arrival', 'routine') // 3 routine events — only 2 need evicting to hit cap
      const result = pruneActivity([...audit, ...nonAudit, ...routine], { cap: 100 }, NOW)
      expect(result).toHaveLength(100)
      expect(result.filter((e) => e.kind === 'sos')).toHaveLength(50) // audit fully untouched
      expect(result.filter((e) => e.kind === 'checkin')).toHaveLength(49) // non-audit fully untouched
      // Only the OLDEST routine events were evicted — the newest routine event survives.
      expect(result.filter((e) => e.kind === 'arrival').map((e) => e.id)).toEqual(['routine0'])
    })

    it('once routine is exhausted, evicts non-audit/non-routine next (oldest-within-class); audit stays untouched', () => {
      const audit = fillerBlock(50, 'sos', 'audit')
      const nonAudit = fillerBlock(51, 'checkin', 'nonaudit') // one must be evicted after routine's single item
      const routine = fillerBlock(1, 'arrival', 'routine')
      const result = pruneActivity([...audit, ...nonAudit, ...routine], { cap: 100 }, NOW)
      expect(result).toHaveLength(100)
      expect(result.some((e) => e.kind === 'arrival')).toBe(false) // the one routine event: evicted
      expect(result.filter((e) => e.kind === 'sos')).toHaveLength(50) // audit fully untouched
      expect(result.filter((e) => e.kind === 'checkin')).toHaveLength(50) // exactly one non-audit event evicted
      expect(result.some((e) => e.id === 'nonaudit50')).toBe(false) // the OLDEST non-audit event — evicted
      expect(result.some((e) => e.id === 'nonaudit0')).toBe(true) // the newest — survives
    })

    it('audit kinds are evicted LAST, only once the buffer is audit-only and still over cap', () => {
      const audit = fillerBlock(101, 'sos', 'audit') // over cap on its own — the last resort
      const nonAudit = fillerBlock(1, 'checkin', 'nonaudit')
      const routine = fillerBlock(1, 'arrival', 'routine')
      const result = pruneActivity([...audit, ...nonAudit, ...routine], { cap: 100 }, NOW)
      expect(result).toHaveLength(100)
      expect(result.some((e) => e.kind === 'arrival')).toBe(false) // routine gone first
      expect(result.some((e) => e.kind === 'checkin')).toBe(false) // non-audit gone next
      // Audit-only buffer, still one over cap — the OLDEST audit event is the last resort.
      expect(result.filter((e) => e.kind === 'sos')).toHaveLength(100)
      expect(result.some((e) => e.id === 'audit100')).toBe(false) // oldest audit event — evicted
      expect(result.some((e) => e.id === 'audit0')).toBe(true) // newest audit event — survives
    })

    it('leaves an audit-only buffer alone when it is already at or under cap (never evicted pre-emptively)', () => {
      const auditA = evt({ id: 'a', kind: 'sos', at: 300 })
      const auditB = evt({ id: 'b', kind: 'approval-requested', at: 200 })
      expect(pruneActivity([auditA, auditB], { cap: 100 }, NOW)).toEqual([auditA, auditB])
    })
  })

  describe('dropRoutine and cap compose', () => {
    it('applies the age prune first, then caps whatever remains', () => {
      const oldRoutine = evt({ id: 'old-routine', kind: 'arrival', at: NOW - SEVEN_DAYS - 1 })
      const freshEvents = Array.from({ length: 150 }, (_, i) => evt({ id: `f${i}`, kind: 'checkin', at: 1000 - i }))
      const result = pruneActivity([...freshEvents, oldRoutine], { dropRoutine: true, cap: 100 }, NOW)
      expect(result.some((e) => e.id === 'old-routine')).toBe(false) // aged out first
      expect(result).toHaveLength(100) // then capped
      expect(result.some((e) => e.id === 'f0')).toBe(true) // newest survives
      expect(result.some((e) => e.id === 'f149')).toBe(false) // oldest evicted by the cap
    })
  })
})

describe('clearRoutineEvents — "Clear routine history" pure reducer', () => {
  it('removes every routine kind regardless of age', () => {
    const events = [
      evt({ id: 'a', kind: 'arrival' }),
      evt({ id: 'b', kind: 'departure' }),
      evt({ id: 'c', kind: 'precision-raised' }),
      evt({ id: 'd', kind: 'message' }),
    ]
    expect(clearRoutineEvents(events)).toEqual([])
  })

  it('leaves audit and every other non-routine kind untouched', () => {
    const sos = evt({ id: 'sos', kind: 'sos' })
    const checkin = evt({ id: 'checkin', kind: 'checkin' })
    const routine = evt({ id: 'r', kind: 'arrival' })
    expect(clearRoutineEvents([sos, checkin, routine])).toEqual([sos, checkin])
  })

  it('is a no-op when there is nothing routine to remove', () => {
    const events = [evt({ id: 'a', kind: 'sos' })]
    expect(clearRoutineEvents(events)).toEqual(events)
  })
})

describe('AUDIT_KINDS — verified against the real recorded kind ids (brief §24.6)', () => {
  it('is exactly the six kinds the brief names, plus Phase 5 Task 5\'s leave-area trio, Phase 6 Task 2\'s independence-applied, and Phase 6 final-review finding 8\'s window-missed', () => {
    expect([...AUDIT_KINDS].sort()).toEqual(
      [
        'approval-requested', 'approval-resolved', 'emergency-access', 'policy-changed', 'safe-area-escalation', 'sos',
        'leave-requested', 'leave-approved', 'leave-denied',
        'independence-applied',
        'window-missed',
      ].sort(),
    )
  })
})

// Review fix: the "Clear routine history" two-tap confirm gate must hold
// PER VISIT, not survive navigating away and back — `nextClearRoutineConfirmState`
// is the pure seam extracted from `handleAction`'s DOM-touching cases (and
// `resetClearRoutineConfirm`, called from app.ts's top-level dispatcher on
// any OTHER action) so this state machine is directly testable without a
// DOM node or a live store. The rendered view itself stays build-gated, same
// convention as the rest of this module's own UI section.
describe('nextClearRoutineConfirmState — the "Clear routine history" confirm gate', () => {
  it('"arm" always yields armed (true)', () => {
    expect(nextClearRoutineConfirmState('arm')).toBe(true)
  })

  it('"disarm" always yields disarmed (false) — covers the confirming tap, Cancel, and any other action', () => {
    expect(nextClearRoutineConfirmState('disarm')).toBe(false)
  })
})

describe('retention setters and clearRoutineHistory — store integration', () => {
  it('setActivityRetentionCap writes a valid cap, ignores an invalid one', () => {
    setActivityRetentionCap(100)
    expect(store.load().settings.activityRetention?.cap).toBe(100)
    setActivityRetentionCap(999) // invalid — ignored, prior value untouched
    expect(store.load().settings.activityRetention?.cap).toBe(100)
  })

  it('setActivityRetentionDropRoutine writes the flag, preserving the existing cap', () => {
    setActivityRetentionCap(1000)
    setActivityRetentionDropRoutine(true)
    expect(store.load().settings.activityRetention).toEqual({ cap: 1000, dropRoutine: true })
  })

  it('clearRoutineHistory removes routine events from the store, leaves everything else', () => {
    store.update((p) => {
      p.activity = [evt({ id: 'r', kind: 'arrival' }), evt({ id: 's', kind: 'sos' })]
    })
    clearRoutineHistory()
    expect(store.load().activity.map((e) => e.id)).toEqual(['s'])
  })

  it("recordActivity applies this device's configured retention cap on every append", () => {
    store.update((p) => { p.settings = { ...p.settings, activityRetention: { cap: 100 } } })
    for (let i = 0; i < 105; i++) recordActivity(evt({ id: `e${i}`, kind: 'checkin', at: i }))
    const ids = store.load().activity.map((e) => e.id)
    expect(ids).toHaveLength(100)
    expect(ids).toContain('e104') // newest survives
    expect(ids).not.toContain('e0') // oldest evicted
  })
})

describe('localActivityId', () => {
  it('is stable for the same inputs and distinct across kind/at/circleId', () => {
    expect(localActivityId('sos', 100, 'circle-1')).toBe('local-sos-100-circle-1')
    expect(localActivityId('sos', 100, 'circle-1')).toBe(localActivityId('sos', 100, 'circle-1'))
    expect(localActivityId('sos', 100, 'circle-2')).not.toBe(localActivityId('sos', 100, 'circle-1'))
    expect(localActivityId('checkin', 100, 'circle-1')).not.toBe(localActivityId('sos', 100, 'circle-1'))
  })
})

describe('recordActivity — store integration', () => {
  it('persists through store.update, dedupes, and reports whether it actually inserted', () => {
    expect(recordActivity(evt({ id: 'x' }))).toBe(true)
    expect(store.load().activity).toHaveLength(1)

    expect(recordActivity(evt({ id: 'x', kind: 'sos' }))).toBe(false) // replay of the same id — a no-op
    expect(store.load().activity).toHaveLength(1)
    expect(store.load().activity[0]?.kind).toBe('checkin') // the original wins, not the dupe's payload
  })

  it('notifies subscribers on a genuine insert', () => {
    const fn = vi.fn()
    const unsubscribe = store.subscribe(fn)
    recordActivity(evt({ id: 'y' }))
    expect(fn).toHaveBeenCalledTimes(1)
    unsubscribe()
  })
})

describe('summarize — neutral, human-readable per kind', () => {
  it('resolves the actor name from the event circle members', () => {
    expect(summarize(fakePersisted(), evt({ kind: 'checkin', actorPk: PK_A }))).toBe('Alex checked in')
  })

  it('falls back to a shortened pubkey for an unknown actor', () => {
    const unknownPk = 'c'.repeat(64)
    expect(summarize(fakePersisted(), evt({ actorPk: unknownPk }))).toContain(unknownPk.slice(0, 8))
  })

  // Signet identity plan, Task 11: the local rolodex fallback (contacts.ts)
  // is gone — an actor outside every circle now falls straight to the
  // shortened-pubkey case, same as any other unknown actor.
  it('falls back to a shortened pubkey when the actor is outside every circle', () => {
    const outsidePk = 'd'.repeat(64)
    expect(summarize(fakePersisted(), evt({ actorPk: outsidePk }))).toContain(outsidePk.slice(0, 8))
  })

  it('falls back to "Someone" when there is no actor at all', () => {
    expect(summarize(fakePersisted(), evt({ actorPk: undefined }))).toBe('Someone checked in')
  })

  it('sos / arrival / departure / safe-area', () => {
    const p = fakePersisted()
    expect(summarize(p, evt({ kind: 'sos', actorPk: PK_A }))).toBe('Alex needs help')
    expect(summarize(p, evt({ kind: 'arrival', actorPk: PK_B, params: { place: 'School' } }))).toBe('Bailey arrived at School')
    expect(summarize(p, evt({ kind: 'departure', actorPk: PK_B, params: { place: 'Home' } }))).toBe('Bailey left Home')
    expect(summarize(p, evt({ kind: 'safe-area-warning', actorPk: PK_B, params: { place: 'School' } }))).toBe('Bailey may be leaving School')
    // Neutral language (global-constraints.md §31) — "left", never "violated"/"breached".
    expect(summarize(p, evt({ kind: 'safe-area-escalation', actorPk: PK_B, params: { place: 'Home' } }))).toBe('Bailey left Home')
  })

  it('checkin / pickup-requested (named for the TARGET, not the requester) / pickup-accepted', () => {
    const p = fakePersisted()
    expect(summarize(p, evt({ kind: 'pickup-requested', actorPk: PK_A, params: { targetPk: PK_B } }))).toBe('Pickup requested for Bailey')
    // Brief §11.4 "show how long precise access lasted" — the answer is a
    // single one-shot beacon (safety.ts's `autoAnswerPickup`), not a
    // sustained window, so the summary says so plainly.
    expect(summarize(p, evt({ kind: 'pickup-accepted', actorPk: PK_B }))).toBe('Bailey shared their location — shared precisely once')
  })

  it('agreement-created / acked / status / extended', () => {
    const p = fakePersisted()
    expect(summarize(p, evt({ kind: 'agreement-created', actorPk: PK_A, params: { place: 'School gate' } }))).toBe('Alex proposed a return time — School gate')
    expect(summarize(p, evt({ kind: 'agreement-acked', actorPk: PK_B }))).toBe('Bailey acknowledged the agreement')
    expect(summarize(p, evt({ kind: 'agreement-status', actorPk: PK_B, params: { status: 'en-route' } }))).toBe('Bailey is on the way')
    expect(summarize(p, evt({ kind: 'agreement-status', actorPk: PK_B, params: { status: 'arrived' } }))).toBe('Bailey arrived')
    expect(summarize(p, evt({ kind: 'agreement-status', actorPk: PK_B, params: { status: 'late' } }))).toBe("Bailey hasn't arrived yet")
    expect(summarize(p, evt({ kind: 'agreement-extended', actorPk: PK_B, params: { stage: 'requested', extraMin: '15' } }))).toBe('Bailey asked for 15 min extra')
    expect(summarize(p, evt({ kind: 'agreement-extended', actorPk: PK_A, params: { stage: 'approved', extraMin: '15' } }))).toBe('Alex approved 15 min extra')
    expect(summarize(p, evt({ kind: 'agreement-extended', actorPk: PK_A, params: { stage: 'denied', extraMin: '15' } }))).toBe('Alex denied a request for 15 min extra')
  })

  it('policy-changed / approval-requested / approval-resolved', () => {
    const p = fakePersisted()
    expect(summarize(p, evt({ kind: 'policy-changed', actorPk: PK_A }))).toBe('Alex updated family policy')
    expect(summarize(p, evt({ kind: 'approval-requested', actorPk: PK_B, params: { action: 'add-member' } }))).toBe('Bailey requested approval to add a member')
    expect(summarize(p, evt({ kind: 'approval-resolved', actorPk: PK_A, params: { ok: 'true' } }))).toBe('Alex approved a request')
    expect(summarize(p, evt({ kind: 'approval-resolved', actorPk: PK_A, params: { ok: 'false' } }))).toBe('Alex denied a request')
  })

  it('independence-applied (Phase 6 Task 2, design spec §2) — neutral, non-gamified language', () => {
    const p = fakePersisted()
    expect(summarize(p, evt({ kind: 'independence-applied', actorPk: PK_A, params: { level: '2', label: 'Growing' } }))).toBe('Alex applied the Growing level')
    // A missing label (should never happen from milestones.ts's own writes) falls back gracefully rather than rendering "undefined".
    expect(summarize(p, evt({ kind: 'independence-applied', actorPk: PK_A, params: {} }))).toBe('Alex applied the independence level')
  })

  it('member-joined / member-removed', () => {
    const p = fakePersisted()
    expect(summarize(p, evt({ kind: 'member-joined', actorPk: PK_B }))).toBe('Bailey joined the circle')
    expect(summarize(p, evt({ kind: 'member-removed', actorPk: PK_B }))).toBe('Bailey was removed from the circle')
  })

  it('precision-raised / emergency-access (Task 6, brief §11.4-11.5/§2.3)', () => {
    const p = fakePersisted()
    expect(summarize(p, evt({ kind: 'precision-raised', actorPk: PK_B, params: { term: 'Precise' } }))).toBe("Bailey's location sharing increased to Precise")
    // No targetPk (a hypothetical caller that omits it) — falls back to the generic "precise location" phrasing.
    expect(summarize(p, evt({ kind: 'emergency-access', actorPk: PK_A, params: { reason: 'Meeting you' } }))).toBe('Alex requested precise location — reason: Meeting you')
    // With targetPk (the normal case — both safety.ts and messages.ts always set it) — names WHOSE location was requested.
    expect(summarize(p, evt({ kind: 'emergency-access', actorPk: PK_A, params: { targetPk: PK_B, reason: 'Meeting you' } })))
      .toBe("Alex requested Bailey's precise location — reason: Meeting you")
    // The receive-side 'not stated' fallback (no reason DM arrived within the correlation window).
    expect(summarize(p, evt({ kind: 'emergency-access', actorPk: PK_A, params: { targetPk: PK_B, reason: 'not stated' } })))
      .toBe("Alex requested Bailey's precise location — reason: not stated")
  })

  it('window-reminder / window-met / window-missed (Phase 3 Task 5, arrival windows)', () => {
    const p = fakePersisted()
    expect(summarize(p, evt({ kind: 'window-reminder', actorPk: PK_B, params: { place: 'School', time: '08:45' } })))
      .toBe('Expected at School by 08:45')
    // 'window-met' is only ever self-recorded (the child's own device closing
    // a fired-then-arrived window) — reads exactly like a plain arrival.
    expect(summarize(p, evt({ kind: 'window-met', actorPk: PK_B, params: { place: 'School' } })))
      .toBe('Bailey arrived at School')
  })

  it('window-missed distinguishes MY OWN not-yet-arrived event from someone ELSE\'s (Phase 3 Task 5)', () => {
    // Someone else's device — recordIncomingWindowEvent's receive-side entry.
    // `summarize` reads the signed-in identity via `currentSession()` (Signet
    // identity plan), not a stored `p.identity`.
    sessionForTests({ identityPk: PK_A, phoneSkHex: '1'.repeat(64) })
    const p = fakePersisted()
    expect(summarize(p, evt({ kind: 'window-missed', actorPk: PK_B, params: { place: 'School', time: '08:45' } })))
      .toBe("Bailey hasn't arrived at School yet (expected by 08:45)")
    // This device's OWN not-yet-arrived event (the 'fire' branch's self
    // Activity entry) — child-transparency copy, not third-person about self.
    sessionForTests({ identityPk: PK_B, phoneSkHex: '2'.repeat(64) })
    expect(summarize(p, evt({ kind: 'window-missed', actorPk: PK_B, params: { place: 'School', time: '08:45' } })))
      .toBe('Circle told: not yet at School')
  })

  it('battery-low (Phase 3 Task 2 — queued follow-up: this case was missing, falling through to the generic default)', () => {
    const p = fakePersisted()
    expect(summarize(p, evt({ kind: 'battery-low', actorPk: PK_B, params: { pct: '15' } })))
      .toBe("Bailey's phone battery was low (15%)")
  })

  it('meet-point distinguishes create from delete via params.action (Phase 4 Task 5)', () => {
    const p = fakePersisted()
    expect(summarize(p, evt({ kind: 'meet-point', actorPk: PK_B, params: { name: 'Park gate', action: 'created' } })))
      .toBe('Bailey suggested meeting at Park gate')
    expect(summarize(p, evt({ kind: 'meet-point', actorPk: PK_B, params: { name: 'Park gate', action: 'deleted' } })))
      .toBe('Bailey removed the meeting point — Park gate')
  })

  it('pin-dropped / pin-removed render the pre-rendered kind label (Phase 7 Task 4)', () => {
    const p = fakePersisted()
    expect(summarize(p, evt({ kind: 'pin-dropped', actorPk: PK_B, params: { kind: 'car', label: '🚗 Car' } })))
      .toBe('Bailey dropped a pin — 🚗 Car')
    expect(summarize(p, evt({ kind: 'pin-removed', actorPk: PK_B, params: { kind: 'car', label: '🚗 Car' } })))
      .toBe('Bailey removed a pin — 🚗 Car')
  })

  describe('journey-start / journey-done (Phase 5 Task 3, brief §32.2)', () => {
    it('journey-start states the destination, with or without an expected-by time', () => {
      const p = fakePersisted()
      expect(summarize(p, evt({ kind: 'journey-start', actorPk: PK_B, params: { place: 'the library' } })))
        .toBe('Bailey is heading to the library')
      expect(summarize(p, evt({ kind: 'journey-start', actorPk: PK_B, params: { place: 'the library', expectedBy: '15:30' } })))
        .toBe('Bailey is heading to the library (expected by 15:30)')
    })

    it('journey-done: genuine completion (no flags)', () => {
      const p = fakePersisted()
      expect(summarize(p, evt({ kind: 'journey-done', actorPk: PK_B, params: { place: 'the park' } })))
        .toBe("Bailey's journey to the park is complete")
    })

    it('journey-done: cancelled (params.cancelled = "1") — neutral language, no accusation (§31)', () => {
      const p = fakePersisted()
      const summary = summarize(p, evt({ kind: 'journey-done', actorPk: PK_B, params: { place: 'the park', cancelled: '1' } }))
      expect(summary).toBe('Bailey cancelled their journey to the park')
      expect(summary.toLowerCase()).not.toMatch(/fail|abandon|missed|overdue/)
    })

    it('journey-done: auto-expired (params.expired = "1") — neutral language, no accusation (§31)', () => {
      const p = fakePersisted()
      const summary = summarize(p, evt({ kind: 'journey-done', actorPk: PK_B, params: { place: 'the park', expired: '1' } }))
      expect(summary).toBe("Bailey's journey to the park timed out")
      expect(summary.toLowerCase()).not.toMatch(/fail|abandon|missed|overdue|late/)
    })
  })

  it('tolerates an unrecognised kind (forward compat) — a generic line, never a throw', () => {
    const p = fakePersisted()
    expect(() => summarize(p, evt({ kind: 'some-future-kind', actorPk: PK_A }))).not.toThrow()
    expect(summarize(p, evt({ kind: 'some-future-kind', actorPk: PK_A }))).toContain('Alex')
  })

  it('pickup-status — human phrasing per phase (Phase 4 Task 6, brief §17.2-17.3, §30)', () => {
    const p = fakePersisted()
    expect(summarize(p, evt({ kind: 'pickup-status', actorPk: PK_A, params: { phase: 'offered', targetPk: PK_B } })))
      .toBe('Alex offered to pick up Bailey')
    expect(summarize(p, evt({ kind: 'pickup-status', actorPk: PK_B, params: { phase: 'seen', targetPk: PK_B } })))
      .toBe('Bailey saw the pickup update')
    expect(summarize(p, evt({ kind: 'pickup-status', actorPk: PK_A, params: { phase: 'accepted', targetPk: PK_B } })))
      .toBe('Alex accepted the pickup')
    // Task contract's exact required phrase: "on the way".
    expect(summarize(p, evt({ kind: 'pickup-status', actorPk: PK_A, params: { phase: 'on-way', targetPk: PK_B } })))
      .toBe('Alex is on the way')
    expect(summarize(p, evt({ kind: 'pickup-status', actorPk: PK_A, params: { phase: 'on-way', targetPk: PK_B, etaMin: '9' } })))
      .toBe('Alex is on the way — about 9 min')
    // Task contract's exact required phrase: "picked up".
    expect(summarize(p, evt({ kind: 'pickup-status', actorPk: PK_A, params: { phase: 'collected', targetPk: PK_B } })))
      .toBe('Alex picked up Bailey')
    // Task contract's exact required phrase: "declined" — §31 neutral, never "refused".
    expect(summarize(p, evt({ kind: 'pickup-status', actorPk: PK_B, params: { phase: 'declined', targetPk: PK_B } })))
      .toBe('Bailey declined the pickup')
    // Task contract's exact required phrase: "suggested another spot".
    expect(summarize(p, evt({ kind: 'pickup-status', actorPk: PK_B, params: { phase: 'suggested', targetPk: PK_B } })))
      .toBe('Bailey suggested another spot')
    expect(summarize(p, evt({ kind: 'pickup-status', actorPk: PK_B, params: { phase: 'suggested', targetPk: PK_B, suggestName: 'Library' } })))
      .toBe('Bailey suggested another spot: Library')
  })

  it('pickup-status tolerates an unrecognised phase (forward compat)', () => {
    const p = fakePersisted()
    expect(() => summarize(p, evt({ kind: 'pickup-status', actorPk: PK_A, params: { phase: 'some-future-phase', targetPk: PK_B } }))).not.toThrow()
    expect(summarize(p, evt({ kind: 'pickup-status', actorPk: PK_A, params: { phase: 'some-future-phase', targetPk: PK_B } })))
      .toBe('Alex updated the pickup for Bailey')
  })
})

describe('matchesFilter', () => {
  it('"all" matches every kind, known or not', () => {
    expect(matchesFilter(evt({ kind: 'sos' }), { kind: 'all' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'totally-unknown' }), { kind: 'all' })).toBe(true)
  })

  it('"safety" matches only safety-ish kinds', () => {
    expect(matchesFilter(evt({ kind: 'sos' }), { kind: 'safety' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'checkin' }), { kind: 'safety' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'pickup-requested' }), { kind: 'safety' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'pickup-status' }), { kind: 'safety' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'agreement-created' }), { kind: 'safety' })).toBe(false)
  })

  it('"requests" matches agreement/approval/policy kinds', () => {
    expect(matchesFilter(evt({ kind: 'agreement-created' }), { kind: 'requests' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'approval-requested' }), { kind: 'requests' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'policy-changed' }), { kind: 'requests' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'independence-applied' }), { kind: 'requests' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'sos' }), { kind: 'requests' })).toBe(false)
  })

  it('"people" matches only membership kinds', () => {
    expect(matchesFilter(evt({ kind: 'member-joined' }), { kind: 'people' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'member-removed' }), { kind: 'people' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'checkin' }), { kind: 'people' })).toBe(false)
  })

  // Review-minor #7: arrival-window kinds and battery-low must slot into the
  // SAME filter buckets arrival/departure/safe-area-* already occupy, not
  // fall through to "only shows in All/its own circle" like a genuinely
  // unrecognised kind would.
  it('"safety" also matches arrival-window kinds (same family as arrival/departure/safe-area-*) and battery-low', () => {
    expect(matchesFilter(evt({ kind: 'window-reminder' }), { kind: 'safety' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'window-missed' }), { kind: 'safety' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'window-met' }), { kind: 'safety' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'battery-low' }), { kind: 'safety' })).toBe(true)
  })

  it('"safety" also matches journey-start/journey-done (Phase 5 Task 3 — same "where a member is" family)', () => {
    expect(matchesFilter(evt({ kind: 'journey-start' }), { kind: 'safety' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'journey-done' }), { kind: 'safety' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'journey-start' }), { kind: 'requests' })).toBe(false)
    expect(matchesFilter(evt({ kind: 'journey-start' }), { kind: 'people' })).toBe(false)
  })

  it('a circle filter matches by circleId regardless of kind', () => {
    expect(matchesFilter(evt({ kind: 'sos', circleId: 'circle-1' }), { kind: 'circle', circleId: 'circle-1' })).toBe(true)
    expect(matchesFilter(evt({ kind: 'sos', circleId: 'circle-2' }), { kind: 'circle', circleId: 'circle-1' })).toBe(false)
  })

  it('an unrecognised kind never matches safety/requests/people, but still shows in "all" and its own circle', () => {
    const unknown = evt({ kind: 'totally-unknown', circleId: 'circle-1' })
    expect(matchesFilter(unknown, { kind: 'safety' })).toBe(false)
    expect(matchesFilter(unknown, { kind: 'requests' })).toBe(false)
    expect(matchesFilter(unknown, { kind: 'people' })).toBe(false)
    expect(matchesFilter(unknown, { kind: 'circle', circleId: 'circle-1' })).toBe(true)
    expect(matchesFilter(unknown, { kind: 'all' })).toBe(true)
  })
})

describe('deepLinkFor', () => {
  it('routes safety-ish kinds to the map, centred on the actor', () => {
    expect(deepLinkFor(evt({ kind: 'sos', circleId: 'circle-1', actorPk: PK_A, params: { geohash: 'u10' } })))
      .toEqual({ kind: 'map', circleId: 'circle-1', actorPk: PK_A, geohash: 'u10' })
  })

  it('routes pickup-requested to the map centred on the TARGET child, not the requesting guardian', () => {
    expect(deepLinkFor(evt({ kind: 'pickup-requested', circleId: 'circle-1', actorPk: PK_A, params: { targetPk: PK_B, geohash: 'u11' } })))
      .toEqual({ kind: 'map', circleId: 'circle-1', actorPk: PK_B, geohash: 'u11' })
  })

  it('routes emergency-access to the map centred on the TARGET (whose location was requested), when known', () => {
    expect(deepLinkFor(evt({ kind: 'emergency-access', circleId: 'circle-1', actorPk: PK_A, params: { targetPk: PK_B, reason: 'Meeting you' } })))
      .toEqual({ kind: 'map', circleId: 'circle-1', actorPk: PK_B, geohash: undefined })
  })

  it('emergency-access without a targetPk falls back to the generic actor-centred map branch (forward compat)', () => {
    expect(deepLinkFor(evt({ kind: 'emergency-access', circleId: 'circle-1', actorPk: PK_A, params: { reason: 'Meeting you' } })))
      .toEqual({ kind: 'map', circleId: 'circle-1', actorPk: PK_A, geohash: undefined })
  })

  it('routes pickup-status to the map centred on the TARGET child, not whoever performed this phase transition (Phase 4 Task 6)', () => {
    expect(deepLinkFor(evt({ kind: 'pickup-status', circleId: 'circle-1', actorPk: PK_A, params: { phase: 'on-way', targetPk: PK_B } })))
      .toEqual({ kind: 'map', circleId: 'circle-1', actorPk: PK_B, geohash: undefined })
    // 'seen' is actorPk=child, still centred on the child (targetPk === actorPk here) — same branch either way.
    expect(deepLinkFor(evt({ kind: 'pickup-status', circleId: 'circle-1', actorPk: PK_B, params: { phase: 'seen', targetPk: PK_B } })))
      .toEqual({ kind: 'map', circleId: 'circle-1', actorPk: PK_B, geohash: undefined })
  })

  it('routes approval-requested/resolved to the approvals card', () => {
    expect(deepLinkFor(evt({ kind: 'approval-requested' }))).toEqual({ kind: 'approvals' })
    expect(deepLinkFor(evt({ kind: 'approval-resolved' }))).toEqual({ kind: 'approvals' })
  })

  it('routes agreement and membership kinds to the circle', () => {
    expect(deepLinkFor(evt({ kind: 'agreement-created', circleId: 'circle-1' }))).toEqual({ kind: 'circle', circleId: 'circle-1' })
    expect(deepLinkFor(evt({ kind: 'agreement-extended', circleId: 'circle-1' }))).toEqual({ kind: 'circle', circleId: 'circle-1' })
    expect(deepLinkFor(evt({ kind: 'member-joined', circleId: 'circle-1' }))).toEqual({ kind: 'circle', circleId: 'circle-1' })
    expect(deepLinkFor(evt({ kind: 'member-removed', circleId: 'circle-1' }))).toEqual({ kind: 'circle', circleId: 'circle-1' })
  })

  it('routes policy-changed to the circle, not the approvals card — family policy lives on the You tab', () => {
    expect(deepLinkFor(evt({ kind: 'policy-changed', circleId: 'circle-1' }))).toEqual({ kind: 'circle', circleId: 'circle-1' })
  })

  it('routes independence-applied to the circle too (Phase 6 Task 2 — milestones.ts also renders on the You tab)', () => {
    expect(deepLinkFor(evt({ kind: 'independence-applied', circleId: 'circle-1' }))).toEqual({ kind: 'circle', circleId: 'circle-1' })
  })

  // Review-minor #7: arrival-window kinds and battery-low route to the map,
  // centred on the actor — same bucket as arrival/departure/safe-area-*/
  // precision-raised, none of which carry a geohash either.
  it('routes arrival-window kinds and battery-low to the map, centred on the actor', () => {
    expect(deepLinkFor(evt({ kind: 'window-reminder', circleId: 'circle-1', actorPk: PK_A })))
      .toEqual({ kind: 'map', circleId: 'circle-1', actorPk: PK_A, geohash: undefined })
    expect(deepLinkFor(evt({ kind: 'window-missed', circleId: 'circle-1', actorPk: PK_A })))
      .toEqual({ kind: 'map', circleId: 'circle-1', actorPk: PK_A, geohash: undefined })
    expect(deepLinkFor(evt({ kind: 'window-met', circleId: 'circle-1', actorPk: PK_A })))
      .toEqual({ kind: 'map', circleId: 'circle-1', actorPk: PK_A, geohash: undefined })
    expect(deepLinkFor(evt({ kind: 'battery-low', circleId: 'circle-1', actorPk: PK_A })))
      .toEqual({ kind: 'map', circleId: 'circle-1', actorPk: PK_A, geohash: undefined })
  })

  it('routes journey-start/journey-done to the map, centred on the actor (Phase 5 Task 3)', () => {
    expect(deepLinkFor(evt({ kind: 'journey-start', circleId: 'circle-1', actorPk: PK_A })))
      .toEqual({ kind: 'map', circleId: 'circle-1', actorPk: PK_A, geohash: undefined })
    expect(deepLinkFor(evt({ kind: 'journey-done', circleId: 'circle-1', actorPk: PK_A })))
      .toEqual({ kind: 'map', circleId: 'circle-1', actorPk: PK_A, geohash: undefined })
  })

  it('falls back to the circle for an unrecognised kind that has one, else "none"', () => {
    expect(deepLinkFor(evt({ kind: 'totally-unknown', circleId: 'circle-1' }))).toEqual({ kind: 'circle', circleId: 'circle-1' })
    expect(deepLinkFor(evt({ kind: 'totally-unknown', circleId: undefined }))).toEqual({ kind: 'none' })
  })
})

describe('relativeTime', () => {
  it('formats just now / minutes / hours / days', () => {
    expect(relativeTime(1000, 1000)).toBe('just now')
    expect(relativeTime(1000, 1000 + 59)).toBe('just now')
    expect(relativeTime(1000, 1000 + 120)).toBe('2m ago')
    expect(relativeTime(1000, 1000 + 2 * 3600)).toBe('2h ago')
    expect(relativeTime(1000, 1000 + 3 * 86_400)).toBe('3d ago')
  })

  it('never goes negative for an event timestamped slightly in the future (clock skew)', () => {
    expect(relativeTime(1000, 900)).toBe('just now')
  })
})
