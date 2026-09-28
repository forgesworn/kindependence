import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import {
  shouldNotifyForEvent,
  shouldFireNotification,
  NOTIFY_FRESH_SEC,
  CONSOLIDATE_WINDOW_SEC,
  isQuietNow,
  QUIET_EXEMPT_KINDS,
  notify,
  type NotifyKind,
} from './notify.js'
import * as store from './store.js'

describe('shouldNotifyForEvent (moved from safety.ts\'s shouldNotifyForSafetyEvent — same freshness/insert gate)', () => {
  it('notifies when the event was genuinely inserted AND is fresh', () => {
    expect(shouldNotifyForEvent(true, 1000, 1000)).toBe(true)
    expect(shouldNotifyForEvent(true, 1000, 1000 + NOTIFY_FRESH_SEC - 1)).toBe(true)
  })

  it('never notifies for a deduped event (already seen), no matter how fresh', () => {
    expect(shouldNotifyForEvent(false, 1000, 1000)).toBe(false)
  })

  it('never notifies for a stale event (a stored-wrap replay), even if just inserted', () => {
    expect(shouldNotifyForEvent(true, 1000, 1000 + 16 * 24 * 3600)).toBe(false)
    expect(shouldNotifyForEvent(true, 1000, 1000 + NOTIFY_FRESH_SEC + 1)).toBe(false)
  })

  it('honours a custom freshSec override', () => {
    expect(shouldNotifyForEvent(true, 1000, 1060, 120)).toBe(true)
    expect(shouldNotifyForEvent(true, 1000, 1121, 120)).toBe(false)
  })
})

describe('shouldFireNotification (brief §29 consolidation: collapse repeats per (kind, actor) within 5 min)', () => {
  it('fires when there is no prior notification for this key', () => {
    expect(shouldFireNotification(undefined, 1000)).toBe(true)
  })

  it('collapses a repeat within the consolidation window', () => {
    expect(shouldFireNotification(1000, 1000)).toBe(false)
    expect(shouldFireNotification(1000, 1000 + CONSOLIDATE_WINDOW_SEC)).toBe(false)
  })

  it('fires again once the window has elapsed', () => {
    expect(shouldFireNotification(1000, 1000 + CONSOLIDATE_WINDOW_SEC + 1)).toBe(true)
  })

  it('honours a custom windowSec override', () => {
    expect(shouldFireNotification(1000, 1030, 60)).toBe(false)
    expect(shouldFireNotification(1000, 1061, 60)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Phase 5 Task 1 (brief §32.5): quiet hours — receiver-side local filter.
// isQuietNow is pure (localMinutes is caller-supplied, no Date access) so the
// full boundary matrix is directly assertable here; QUIET_EXEMPT_KINDS is a
// plain data set, checked for EXACT membership (neither missing an urgent
// kind nor accidentally exempting an ordinary one); the notify()-level tests
// below exercise the real, impure gate wired inside the one entry point.
// ---------------------------------------------------------------------------

describe('isQuietNow (brief §32.5 — pure, localMinutes is minutes-since-midnight, device-local)', () => {
  it('is never quiet when disabled', () => {
    expect(isQuietNow({ enabled: false, start: '22:00', end: '07:00' }, 0)).toBe(false)
    expect(isQuietNow({ enabled: false, start: '22:00', end: '07:00' }, 23 * 60)).toBe(false)
  })

  it('is never quiet when settings.quietHours is undefined (unset)', () => {
    expect(isQuietNow(undefined, 0)).toBe(false)
  })

  it('normal same-day window: inclusive start, exclusive end', () => {
    const qh = { enabled: true, start: '13:00', end: '14:00' } // 780..840 minutes
    expect(isQuietNow(qh, 779)).toBe(false) // just before start
    expect(isQuietNow(qh, 780)).toBe(true) // exactly start — inclusive
    expect(isQuietNow(qh, 810)).toBe(true) // mid-window
    expect(isQuietNow(qh, 839)).toBe(true) // just before end
    expect(isQuietNow(qh, 840)).toBe(false) // exactly end — exclusive
  })

  it('cross-midnight window (22:00-07:00): quiet from start, through midnight, up to end', () => {
    const qh = { enabled: true, start: '22:00', end: '07:00' } // 1320 / 420 minutes
    expect(isQuietNow(qh, 1319)).toBe(false) // 21:59, just before start
    expect(isQuietNow(qh, 1320)).toBe(true) // 22:00 exactly — inclusive start
    expect(isQuietNow(qh, 1439)).toBe(true) // 23:59
    expect(isQuietNow(qh, 0)).toBe(true) // midnight
    expect(isQuietNow(qh, 419)).toBe(true) // 06:59
    expect(isQuietNow(qh, 420)).toBe(false) // 07:00 exactly — exclusive end
    expect(isQuietNow(qh, 900)).toBe(false) // 15:00, well outside either side
  })

  it('start === end means the whole day is quiet while enabled', () => {
    const qh = { enabled: true, start: '09:00', end: '09:00' }
    expect(isQuietNow(qh, 0)).toBe(true)
    expect(isQuietNow(qh, 540)).toBe(true) // 09:00 itself
    expect(isQuietNow(qh, 1439)).toBe(true) // 23:59
  })

  it('fails safe (not quiet) on a malformed start/end rather than throwing or holding everything', () => {
    expect(isQuietNow({ enabled: true, start: 'nope', end: '07:00' }, 0)).toBe(false)
    expect(isQuietNow({ enabled: true, start: '22:00', end: '25:00' }, 0)).toBe(false)
    expect(isQuietNow({ enabled: true, start: '', end: '' }, 0)).toBe(false)
  })
})

describe('QUIET_EXEMPT_KINDS (brief §32.5 — the 7 urgent kinds, exactly, exempt from quiet hours)', () => {
  it('contains exactly the 7 urgent kinds named by the task contract', () => {
    const expected: NotifyKind[] = [
      'sos', 'emergency-access', 'safe-area-escalation', 'pickup-requested',
      'pickup-status', 'window-missed', 'leave-reminder',
    ]
    expect(QUIET_EXEMPT_KINDS.size).toBe(7)
    for (const k of expected) expect(QUIET_EXEMPT_KINDS.has(k)).toBe(true)
    expect([...QUIET_EXEMPT_KINDS].sort()).toEqual([...expected].sort())
  })

  it('does NOT exempt any of the ordinary (held) kinds — checkin, arrival, departure, message, request, battery-low, agreement-status, safe-area-warning, window-reminder, journey', () => {
    const ordinary: NotifyKind[] = [
      'checkin', 'arrival', 'departure', 'message', 'request', 'battery-low',
      'agreement-status', 'safe-area-warning', 'window-reminder',
      // Phase 5 Task 3 (brief §32.2): journey-start/journey-done buzzes are
      // ordinary, quiet-holdable — not a safety escalation.
      'journey',
    ]
    for (const k of ordinary) expect(QUIET_EXEMPT_KINDS.has(k)).toBe(false)
  })
})

describe('CATEGORY_FOR_KIND — journey routes to the "places" channel (Phase 5 Task 3, brief §32.2)', () => {
  it('a journey notification uses the places channel, same as arrival/departure', () => {
    // CATEGORY_FOR_KIND itself is private — exercised indirectly through
    // notify()'s native dispatch would require mocking @capacitor/local-
    // notifications; the channel assignment is instead verified structurally
    // (grep) here, mirroring the "verified by inspection" idiom this file's
    // own doc comments already use for cross-module invariants.
    const src = readFileSync(fileURLToPath(new URL('./notify.ts', import.meta.url)), 'utf8')
    expect(src).toMatch(/journey:\s*'places'/)
  })
})

describe('notify() unaffected by/never touches Activity (brief §32.5: "never touches the wire or Activity")', () => {
  it('notify.ts does not import activity.ts — recording only ever happens at each call site, independently of whether the OS notification itself ends up held', () => {
    const src = readFileSync(fileURLToPath(new URL('./notify.ts', import.meta.url)), 'utf8')
    expect(src).not.toMatch(/['"]\.\/activity\.js['"]/)
  })
})

describe('notify() — quiet-hours gate wired inside the one entry point (brief §32.5)', () => {
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

  let notificationCtor: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    notificationCtor = vi.fn()
    class MockNotification {
      static permission = 'granted'
      constructor(title: string, opts: unknown) {
        notificationCtor(title, opts)
      }
    }
    vi.stubGlobal('Notification', MockNotification)
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('holds an ORDINARY kind during quiet hours (no transport call) and does NOT stamp lastFiredAt — the very next occurrence, once quiet hours no longer apply, still fires rather than being collapsed by its own held predecessor', async () => {
    store.update((p) => { p.settings = { ...p.settings, quietHours: { enabled: true, start: '22:00', end: '07:00' } } })
    vi.setSystemTime(new Date(2024, 0, 1, 23, 0, 0)) // 23:00 — inside the quiet window

    await notify('checkin', 'actor-held', 'Title', 'Body')
    expect(notificationCtor).not.toHaveBeenCalled()

    // 5s later (well inside the 300s consolidation window) with quiet hours
    // now off — if the held call above HAD stamped lastFiredAt, this would
    // be wrongly collapsed as "just a repeat" and never reach the transport.
    vi.setSystemTime(new Date(2024, 0, 1, 23, 0, 5))
    store.update((p) => { p.settings = { ...p.settings, quietHours: { enabled: false, start: '22:00', end: '07:00' } } })
    await notify('checkin', 'actor-held', 'Title', 'Body')
    expect(notificationCtor).toHaveBeenCalledTimes(1)
  })

  it('control: a notification that genuinely fires DOES stamp lastFiredAt — an immediate repeat (same kind/actor, no quiet hours) is correctly collapsed', async () => {
    store.update((p) => { p.settings = { ...p.settings, quietHours: { enabled: false, start: '22:00', end: '07:00' } } })
    vi.setSystemTime(new Date(2024, 0, 1, 12, 0, 0))

    await notify('checkin', 'actor-fired', 'Title', 'Body')
    expect(notificationCtor).toHaveBeenCalledTimes(1)

    await notify('checkin', 'actor-fired', 'Title', 'Body') // same instant, same key
    expect(notificationCtor).toHaveBeenCalledTimes(1) // still 1 — genuinely collapsed, not held
  })

  it('the 7 urgent kinds always break through an active, whole-day quiet window', async () => {
    store.update((p) => { p.settings = { ...p.settings, quietHours: { enabled: true, start: '00:00', end: '00:00' } } })
    vi.setSystemTime(new Date(2024, 0, 1, 3, 0, 0))

    await notify('sos', 'actor-urgent', 'SOS', 'Body')
    expect(notificationCtor).toHaveBeenCalledTimes(1)
  })

  it('an ordinary kind fires normally when quiet hours are unset entirely', async () => {
    vi.setSystemTime(new Date(2024, 0, 1, 23, 0, 0))
    await notify('message', 'actor-unset', 'Title', 'Body')
    expect(notificationCtor).toHaveBeenCalledTimes(1)
  })
})
