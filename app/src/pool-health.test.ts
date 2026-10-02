import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  shouldResetPool,
  buildSubKey,
  POOL_STALE_SEC,
  POOL_RESET_COOLDOWN_SEC,
  POOL_CHECK_INTERVAL_MS,
} from './pool-health.js'

// ---------------------------------------------------------------------------
// Tuning contract (final-review fix, Important #1a): locks in the actual
// numeric values, not just their relative use in shouldResetPool's matrix
// below. POOL_STALE_SEC moved 60s -> 330s — just above 300s, the longest
// ROUTINE gap kindependence's own cadence produces (beacons.ts's
// STATIONARY_TICK_MS) — because the OLD 60s (adopted verbatim from flock,
// whose own cadence keeps a pool under ~90s of cover traffic even at rest)
// falsely flagged a perfectly healthy, quiet kindependence pool as stale roughly
// every 90-120s. POOL_RESET_COOLDOWN_SEC is UNCHANGED at 60s — it was never
// the part of flock's tuning that didn't transfer (see the module doc
// comment's "Tuning DIVERGES" paragraph for the full reasoning).
// ---------------------------------------------------------------------------

describe('tuning constants (final-review fix, Important #1a — threshold now 330s)', () => {
  it('POOL_STALE_SEC is 330s — just above kindependence\'s own 300s max routine gap, not flock\'s 60s', () => {
    expect(POOL_STALE_SEC).toBe(330)
  })

  it('POOL_RESET_COOLDOWN_SEC stays 60s — unaffected by the staleness retune', () => {
    expect(POOL_RESET_COOLDOWN_SEC).toBe(60)
  })
})

// ---------------------------------------------------------------------------
// shouldResetPool — pure gate matrix (fresh / stale / cooldown-blocked /
// seeded). Mirrors flock d36a004's own two-condition gate: staleness alone
// is never enough — the cooldown must also have lapsed — see the module doc
// comment's "never blind-rebuild" lesson.
// ---------------------------------------------------------------------------

describe('shouldResetPool (pure gate)', () => {
  it('is false on a fresh pool — a wrap just arrived, well within the stale window', () => {
    const now = 1_000_000
    expect(shouldResetPool(now - 1, 0, now)).toBe(false)
  })

  it('is false exactly AT the stale threshold — only ">" trips it, not ">="', () => {
    const now = 1_000_000
    expect(shouldResetPool(now - POOL_STALE_SEC, 0, now)).toBe(false)
  })

  it('is true once staleness exceeds the threshold and the cooldown has long lapsed', () => {
    const now = 1_000_000
    expect(shouldResetPool(now - POOL_STALE_SEC - 1, 0, now)).toBe(true)
  })

  it('cooldown-blocked: stale by wrap-arrival but a reset only just happened', () => {
    const now = 1_000_000
    // No wrap in ages, but lastResetAt is recent (e.g. the previous tick
    // just rebuilt the pool) — must not immediately rebuild again.
    expect(shouldResetPool(now - POOL_STALE_SEC - 100, now - 1, now)).toBe(false)
  })

  it('is false exactly AT the cooldown boundary too — only ">" trips it', () => {
    const now = 1_000_000
    expect(shouldResetPool(now - POOL_STALE_SEC - 1, now - POOL_RESET_COOLDOWN_SEC, now)).toBe(false)
  })

  it('recovers once BOTH staleness and cooldown have cleared', () => {
    const now = 1_000_000
    expect(shouldResetPool(now - POOL_STALE_SEC - 1, now - POOL_RESET_COOLDOWN_SEC - 1, now)).toBe(true)
  })

  it('seeded pool (lastResetAt = 0, i.e. never reset) still respects staleness alone', () => {
    const now = 1_000_000
    // A pool that has never been reset (lastResetAt=0) is always past the
    // cooldown — only the staleness half of the gate matters here.
    expect(shouldResetPool(now - 5, 0, now)).toBe(false)
    expect(shouldResetPool(now - POOL_STALE_SEC - 5, 0, now)).toBe(true)
  })

  it('honours custom staleSec/cooldownSec overrides', () => {
    const now = 1_000_000
    expect(shouldResetPool(now - 10, now - 10, now, 5, 5)).toBe(true)
    expect(shouldResetPool(now - 3, now - 10, now, 5, 5)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// buildSubKey — pure key-builder (generation staleness). A bump must change
// every key built from it so a subscription-key comparison sees "stale" and
// forces a clean unsubscribe/resubscribe.
// ---------------------------------------------------------------------------

describe('buildSubKey (pure key-builder)', () => {
  it('embeds the generation into the key', () => {
    expect(buildSubKey(0, 'inboxpk@wss://relay')).toBe('gen:0:inboxpk@wss://relay')
  })

  it('is stable for the same generation + parts (idempotent comparison)', () => {
    expect(buildSubKey(3, 'a@b,c')).toBe(buildSubKey(3, 'a@b,c'))
  })

  it('differs across generations for the IDENTICAL underlying parts', () => {
    const a = buildSubKey(0, 'a@b,c')
    const b = buildSubKey(1, 'a@b,c')
    expect(a).not.toBe(b)
  })

  it('differs across parts for the SAME generation (no accidental collision)', () => {
    const a = buildSubKey(2, 'x@relay')
    const b = buildSubKey(2, 'y@relay')
    expect(a).not.toBe(b)
  })
})

// ---------------------------------------------------------------------------
// Impure driver: notePoolActivity / recoverIfStale / ensure. Mocks roost-kit's
// resetPool (a real reconnect side effect we never want a test to trigger)
// and store.notify, so these exercise the actual staleness state machine
// wired on top of the pure gate above.
// ---------------------------------------------------------------------------

vi.mock('@forgesworn/roost-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgesworn/roost-kit')>()
  return { ...actual, resetPool: vi.fn() }
})

describe('notePoolActivity / recoverIfStale (impure driver)', () => {
  beforeEach(async () => {
    vi.resetModules()
    vi.useRealTimers()
  })

  it('recoverIfStale rebuilds, bumps generation, and notifies the store once genuinely stale', async () => {
    const { resetPool } = await import('@forgesworn/roost-kit')
    const store = await import('./store.js')
    const notifySpy = vi.spyOn(store, 'notify')
    const pool = await import('./pool-health.js')

    const genBefore = pool.generation()
    const start = 1_000_000
    pool.notePoolActivity(start)

    // Not yet stale.
    expect(pool.recoverIfStale(start + POOL_STALE_SEC)).toBe(false)
    expect(resetPool).not.toHaveBeenCalled()

    // Now genuinely stale.
    const didReset = pool.recoverIfStale(start + POOL_STALE_SEC + 1)
    expect(didReset).toBe(true)
    expect(resetPool).toHaveBeenCalledTimes(1)
    expect(pool.generation()).toBe(genBefore + 1)
    expect(notifySpy).toHaveBeenCalled()
  })

  it('defers to socket liveness while the native bridge is active: a quiet pool with open inboxes is not rebuilt', async () => {
    const { resetPool } = await import('@forgesworn/roost-kit')
    const pool = await import('./pool-health.js')
    const nativeSocket = await import('./native-socket.js')
    const relayWatch = await import('./relay-watch.js')
    vi.mocked(resetPool).mockClear()

    const start = 4_000_000
    pool.notePoolActivity(start)
    relayWatch.resetForTests({ installed: true })
    const ws = { url: 'wss://r/', readyState: 1, send: () => {}, addEventListener: () => {} }
    relayWatch.watch(ws)
    ws.send('["REQ","sub:1",{"#p":["inbox-a"]}]')
    const release = pool.expectInbox('inbox-a')
    nativeSocket.setActiveForTests(true)
    try {
      // Genuinely stale by the clock, but the inbox is open on an OPEN socket.
      expect(pool.recoverIfStale(start + POOL_STALE_SEC + 1)).toBe(false)
      expect(resetPool).not.toHaveBeenCalled()
      // Same clock, bridge not active: the old behaviour.
      nativeSocket.setActiveForTests(false)
      expect(pool.recoverIfStale(start + POOL_STALE_SEC + 1)).toBe(true)
    } finally {
      release()
      relayWatch.resetForTests()
      nativeSocket.resetForTests()
    }
  })

  it('is cooldown-blocked immediately after a reset — cannot hammer reconnects', async () => {
    const { resetPool } = await import('@forgesworn/roost-kit')
    const pool = await import('./pool-health.js')

    const start = 2_000_000
    pool.notePoolActivity(start)
    expect(pool.recoverIfStale(start + POOL_STALE_SEC + 1)).toBe(true)
    vi.mocked(resetPool).mockClear()

    // A wrap still hasn't arrived, but the cooldown hasn't lapsed yet.
    expect(pool.recoverIfStale(start + POOL_STALE_SEC + 1 + POOL_RESET_COOLDOWN_SEC)).toBe(false)
    expect(resetPool).not.toHaveBeenCalled()
  })

  it('notePoolActivity resets the staleness clock, keeping an active pool churn-free', async () => {
    const { resetPool } = await import('@forgesworn/roost-kit')
    const pool = await import('./pool-health.js')

    const start = 3_000_000
    pool.notePoolActivity(start)
    // A wrap keeps arriving well inside the stale window (e.g. routine
    // beacon traffic) — recovery must never fire on a live pool.
    pool.notePoolActivity(start + 30)
    expect(pool.recoverIfStale(start + 30 + POOL_STALE_SEC)).toBe(false)
    expect(resetPool).not.toHaveBeenCalled()
  })

  it('ensure() seeds lastWrapAt so a freshly-built pool gets a grace period, not instant staleness', async () => {
    const pool = await import('./pool-health.js')
    const seedAt = 4_000_000
    vi.spyOn(Date, 'now').mockReturnValue(seedAt * 1000)
    pool.ensure()
    vi.mocked(Date.now).mockRestore()

    // Immediately after ensure(), even though this is the pool's very first
    // moment, it must NOT read as stale (lastWrapAt was just seeded).
    expect(pool.recoverIfStale(seedAt + 1)).toBe(false)
  })

  it('ensure() is idempotent — a second call does not reseed or double-register the timer', async () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const pool = await import('./pool-health.js')

    pool.ensure()
    const callsAfterFirst = setIntervalSpy.mock.calls.length
    pool.ensure()
    expect(setIntervalSpy.mock.calls.length).toBe(callsAfterFirst)
    vi.useRealTimers()
  })
})

// ---------------------------------------------------------------------------
// Device check 2026-09-27 (phase 2 step 6): Android WebView freezes the page
// when Kindependence goes to the background (a signer round trip, screen
// off). Every relay socket is then closed under it — console: "WebSocket
// connection to 'wss://relay.example/' failed: Page entered
// Back-Forward Cache." — and nostr-tools treats that first error as a
// failed connection: `skipReconnection`, the relay dropped from the pool
// and every subscription on it closed for good. Beacon publishes (each on
// a fresh connection) kept `notePoolActivity` ticking, so `recoverIfStale`
// never fired and the inbox subscriptions stayed dead. The page's own
// `resume` event (document) / `pageshow` with `persisted` (window) is the
// exact signal its sockets were cut: rebuild the pool then, stale or not.
// ---------------------------------------------------------------------------

// Review follow-up: the first cut deduped resumes over a 5 s window and set
// `lastWrapAt = now` on rebuild, so a second freeze within 5 s stayed dead
// and `recoverIfStale` was silenced for 330 s. Now every resume checks the
// pool's actual liveness, and the only dedupe is a rebuild in progress.
describe('recoverOnResume / wireFreezeRecovery (page frozen → sockets gone)', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useRealTimers()
  })

  it('rebuilds a dead pool on resume even though the staleness clock says it is fresh — and leaves that clock alone', async () => {
    const { resetPool } = await import('@forgesworn/roost-kit')
    vi.mocked(resetPool).mockClear()
    const store = await import('./store.js')
    const notifySpy = vi.spyOn(store, 'notify')
    const pool = await import('./pool-health.js')
    vi.useFakeTimers()
    const now = 5_000_000
    pool.notePoolActivity(now - 100) // a beacon publish "succeeded" 100 s ago
    const genBefore = pool.generation()
    let live = false

    const p = pool.recoverOnResume(() => live, now)
    expect(resetPool).toHaveBeenCalledTimes(1)
    expect(pool.generation()).toBe(genBefore + 1)
    expect(notifySpy).toHaveBeenCalled()
    live = true
    await vi.advanceTimersByTimeAsync(pool.REBUILD_SETTLE_MS)
    await expect(p).resolves.toBe(true)
    // The rebuild is no proof of delivery: 331 s after the last real
    // activity (and past the cooldown) the periodic check may still act.
    expect(pool.recoverIfStale(now - 100 + pool.POOL_STALE_SEC + 1 + pool.POOL_RESET_COOLDOWN_SEC)).toBe(true)
  })

  it('a resume with a live pool causes no rebuild', async () => {
    const { resetPool } = await import('@forgesworn/roost-kit')
    vi.mocked(resetPool).mockClear()
    const pool = await import('./pool-health.js')
    await expect(pool.recoverOnResume(() => true)).resolves.toBe(false)
    expect(resetPool).not.toHaveBeenCalled()
  })

  it('two resumes a couple of seconds apart: the second finds the pool dead again and rebuilds', async () => {
    const { resetPool } = await import('@forgesworn/roost-kit')
    vi.mocked(resetPool).mockClear()
    const pool = await import('./pool-health.js')
    vi.useFakeTimers()
    let live = false
    const first = pool.recoverOnResume(() => live, 1_000)
    live = true // the rebuild's subscriptions opened
    await vi.advanceTimersByTimeAsync(500)
    await expect(first).resolves.toBe(true)
    live = false // frozen again, sockets cut
    const second = pool.recoverOnResume(() => live, 1_002)
    expect(resetPool).toHaveBeenCalledTimes(2)
    live = true
    await vi.advanceTimersByTimeAsync(500)
    await expect(second).resolves.toBe(true)
  })

  it('concurrent resumes (resume + pageshow + visibilitychange of one unfreeze) cause a single rebuild', async () => {
    const { resetPool } = await import('@forgesworn/roost-kit')
    vi.mocked(resetPool).mockClear()
    const pool = await import('./pool-health.js')
    vi.useFakeTimers()
    let live = false
    const a = pool.recoverOnResume(() => live)
    const b = pool.recoverOnResume(() => live)
    expect(b).toBe(a)
    expect(resetPool).toHaveBeenCalledTimes(1)
    // Still in progress (sockets connecting, nothing open yet): a third joins too.
    await vi.advanceTimersByTimeAsync(1_000)
    expect(pool.recoverOnResume(() => live)).toBe(a)
    expect(resetPool).toHaveBeenCalledTimes(1)
    live = true
    await vi.advanceTimersByTimeAsync(500)
    await expect(a).resolves.toBe(true)
  })

  it('a rebuild that never comes up stops counting as in progress after REBUILD_SETTLE_MS', async () => {
    const { resetPool } = await import('@forgesworn/roost-kit')
    vi.mocked(resetPool).mockClear()
    const pool = await import('./pool-health.js')
    vi.useFakeTimers()
    const a = pool.recoverOnResume(() => false)
    await vi.advanceTimersByTimeAsync(pool.REBUILD_SETTLE_MS + 500)
    await expect(a).resolves.toBe(true)
    void pool.recoverOnResume(() => false)
    expect(resetPool).toHaveBeenCalledTimes(2)
  })

  it('poolLive: every expected inbox must have a REQ open on an open socket', async () => {
    const pool = await import('./pool-health.js')
    const watch = await import('./relay-watch.js')
    watch.resetForTests({ installed: true })
    pool.resetResumeStateForTests()
    const release = pool.expectInbox('tag-a')
    expect(pool.poolLive()).toBe(false)

    const sock = fakeSocket('wss://r.example')
    watch.watch(sock)
    sock.send(JSON.stringify(['REQ', 'sub1', { kinds: [1059], '#p': ['tag-a'] }]))
    expect(pool.poolLive()).toBe(true)

    // A publish on a fresh connection proves nothing about the inbox.
    const fresh = fakeSocket('wss://r.example')
    watch.watch(fresh)
    sock.close()
    expect(pool.poolLive()).toBe(false)

    fresh.send(JSON.stringify(['REQ', 'sub2', { kinds: [1059], '#p': ['tag-a'] }]))
    expect(pool.poolLive()).toBe(true)
    fresh.receive(JSON.stringify(['CLOSED', 'sub2', 'error: shutting down']))
    expect(pool.poolLive()).toBe(false)

    release()
    expect(pool.poolLive()).toBe(true) // nothing expected
    watch.resetForTests({ installed: false })
    expect(pool.poolLive()).toBe(false) // not watching: unknown counts as dead
  })

  it('wireFreezeRecovery: resume, persisted pageshow and visible visibilitychange rebuild a dead pool once, then run the follow-up', async () => {
    const { resetPool } = await import('@forgesworn/roost-kit')
    vi.mocked(resetPool).mockClear()
    const pool = await import('./pool-health.js')
    vi.useFakeTimers()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    const win = new EventTarget()
    const after = vi.fn()
    let live = false
    pool.wireFreezeRecovery(doc, win, after, () => live)

    doc.dispatchEvent(new Event('resume'))
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: true }))
    expect(resetPool).toHaveBeenCalledTimes(1)
    live = true
    await vi.advanceTimersByTimeAsync(500)
    expect(after).toHaveBeenCalledTimes(1)

    // A plain (non-bfcache) pageshow is a normal load; a live pool needs no
    // rebuild — but the resume still runs the follow-up (queue drain, outbox).
    win.dispatchEvent(Object.assign(new Event('pageshow'), { persisted: false }))
    doc.dispatchEvent(new Event('resume'))
    await vi.advanceTimersByTimeAsync(500)
    expect(resetPool).toHaveBeenCalledTimes(1)
    expect(after).toHaveBeenCalledTimes(2)

    // Hidden → no check; visible again with a dead pool → rebuild.
    live = false
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(resetPool).toHaveBeenCalledTimes(1)
    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    expect(resetPool).toHaveBeenCalledTimes(2)
    live = true
    await vi.advanceTimersByTimeAsync(500)
    expect(after).toHaveBeenCalledTimes(3)
  })

  // Review follow-up to 01ec5a1: after a freeze the sockets' error/close
  // tasks can be delivered AFTER resume/visibilitychange, so the check at
  // resume still read OPEN and nothing rebuilt.
  it('a socket close delivered after the resume causes a rebuild (real liveness via relay-watch)', async () => {
    const { resetPool } = await import('@forgesworn/roost-kit')
    vi.mocked(resetPool).mockClear()
    const pool = await import('./pool-health.js')
    const watch = await import('./relay-watch.js')
    watch.resetForTests({ installed: true })
    pool.resetResumeStateForTests()
    vi.useFakeTimers()
    pool.expectInbox('tag-a')
    const sock = fakeSocket('wss://r.example')
    watch.watch(sock)
    sock.send(JSON.stringify(['REQ', 'sub1', { kinds: [1059], '#p': ['tag-a'] }]))
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    const after = vi.fn()
    pool.wireFreezeRecovery(doc, new EventTarget(), after)

    doc.dispatchEvent(new Event('resume'))
    await vi.advanceTimersByTimeAsync(0)
    expect(resetPool).not.toHaveBeenCalled() // still reads OPEN
    expect(after).toHaveBeenCalledTimes(1) // after() runs on a resume with a live pool

    sock.close() // the freeze's close task arrives late
    expect(resetPool).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(pool.REBUILD_SETTLE_MS + 500)
    expect(after).toHaveBeenCalledTimes(2)
    watch.resetForTests({ installed: false })
  })

  it('a watched socket closing or erroring while visible triggers the check; hidden it does not; in progress it joins', async () => {
    const { resetPool } = await import('@forgesworn/roost-kit')
    vi.mocked(resetPool).mockClear()
    const pool = await import('./pool-health.js')
    const watch = await import('./relay-watch.js')
    watch.resetForTests({ installed: true })
    pool.resetResumeStateForTests()
    vi.useFakeTimers()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'hidden' })
    let live = false
    pool.wireFreezeRecovery(doc, new EventTarget(), vi.fn(), () => live)

    const a = fakeSocket('wss://a.example')
    watch.watch(a)
    a.close()
    expect(resetPool).not.toHaveBeenCalled() // hidden: the resume handles it

    doc.visibilityState = 'visible'
    const b = fakeSocket('wss://b.example')
    const c = fakeSocket('wss://c.example')
    watch.watch(b)
    watch.watch(c)
    b.error()
    expect(resetPool).toHaveBeenCalledTimes(1)
    c.close() // during the rebuild: joins
    expect(resetPool).toHaveBeenCalledTimes(1)
    live = true
    await vi.advanceTimersByTimeAsync(500)
    const d = fakeSocket('wss://d.example')
    watch.watch(d)
    d.close() // pool live: nothing to do
    expect(resetPool).toHaveBeenCalledTimes(1)
    watch.resetForTests({ installed: false })
  })

  it('liveness is re-checked ~1 s and ~5 s after a resume', async () => {
    const { resetPool } = await import('@forgesworn/roost-kit')
    vi.mocked(resetPool).mockClear()
    const pool = await import('./pool-health.js')
    vi.useFakeTimers()
    expect(pool.RESUME_RECHECK_MS).toEqual([1_000, 5_000])
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    const after = vi.fn()
    let live = true
    pool.wireFreezeRecovery(doc, new EventTarget(), after, () => live)
    doc.dispatchEvent(new Event('resume'))
    await vi.advanceTimersByTimeAsync(500)
    expect(resetPool).not.toHaveBeenCalled()
    expect(after).toHaveBeenCalledTimes(1)
    live = false // died without an event reaching us
    await vi.advanceTimersByTimeAsync(600)
    expect(resetPool).toHaveBeenCalledTimes(1)
    live = true
    await vi.advanceTimersByTimeAsync(500)
    expect(after).toHaveBeenCalledTimes(2) // a rebuild runs the follow-up
    live = false
    await vi.advanceTimersByTimeAsync(4_000) // the 5 s re-check
    expect(resetPool).toHaveBeenCalledTimes(2)
  })
})

// Final review, item 2: a relay that accepts the REQs and then closes (say,
// rate-limiting the resubscribe burst) made every close rebuild at once —
// about one rebuild a second, forever. Rebuilds a socket drop triggers now
// back off 1 s, 2 s, 4 s … up to 60 s, and the backoff resets once the pool
// has stayed live for 60 s. Resume checks still check at once but wait out
// an active backoff window before rebuilding.
describe('socket-drop rebuild backoff', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useRealTimers()
  })

  async function flapping() {
    const { resetPool } = await import('@forgesworn/roost-kit')
    const pool = await import('./pool-health.js')
    const watch = await import('./relay-watch.js')
    watch.resetForTests({ installed: true })
    pool.resetResumeStateForTests()
    vi.useFakeTimers()
    const doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
    let live = true
    let flap = true
    const rebuildsAt: number[] = []
    // The relay: every rebuild comes up (REQs accepted) and, while flapping,
    // is closed again half a second later.
    const drop = (): void => {
      live = false
      const s = fakeSocket('wss://flappy.example')
      watch.watch(s)
      s.close()
    }
    vi.mocked(resetPool).mockReset()
    vi.mocked(resetPool).mockImplementation(() => {
      rebuildsAt.push(Date.now())
      setTimeout(() => { live = true }, 100)
      setTimeout(() => { if (flap) drop() }, 500)
    })
    const after = vi.fn()
    pool.wireFreezeRecovery(doc, new EventTarget(), after, () => live)
    return { pool, watch, doc, drop, rebuildsAt, after, setLive: (v: boolean) => { live = v }, stopFlapping: () => { flap = false } }
  }

  const gaps = (at: number[]): number[] => at.slice(1).map((t, i) => t - at[i]!)

  it('a flapping relay makes rebuild intervals grow 1 s, 2 s, 4 s … and cap at 60 s', async () => {
    const f = await flapping()
    f.drop()
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    const g = gaps(f.rebuildsAt)
    expect(g.slice(0, 7)).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000])
    expect(g.slice(7).every((x) => x === 60_000)).toBe(true)
    expect(g.length).toBeGreaterThan(7)
    f.watch.resetForTests({ installed: false })
  })

  it('the backoff resets once the pool has stayed live for 60 s', async () => {
    const f = await flapping()
    f.drop()
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 8_000 + 100)
    expect(gaps(f.rebuildsAt)).toEqual([1_000, 2_000, 4_000, 8_000])
    f.stopFlapping()
    await vi.advanceTimersByTimeAsync(16_000 + 1_000) // the pending deferred rebuild comes up and stays
    const settled = f.rebuildsAt.length

    await vi.advanceTimersByTimeAsync(60_000) // live for a minute
    const t0 = Date.now()
    f.drop()
    expect(f.rebuildsAt.length).toBe(settled + 1)
    expect(f.rebuildsAt.at(-1)).toBe(t0) // no wait: back to square one
    await vi.advanceTimersByTimeAsync(300)
    f.drop()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(f.rebuildsAt.at(-1)! - t0).toBe(1_000) // and the next gap is 1 s again
    f.watch.resetForTests({ installed: false })
  })

  it('the backoff resets even when a slow rebuild settled by timeout and was never seen live', async () => {
    const f = await flapping()
    f.drop()
    await vi.advanceTimersByTimeAsync(1_000 + 2_000 + 4_000 + 100)
    expect(gaps(f.rebuildsAt)).toEqual([1_000, 2_000, 4_000])
    f.stopFlapping()
    // The next rebuild's relay is slow: it comes up only after the settle
    // timeout, so no check ever sees it live.
    const { resetPool } = await import('@forgesworn/roost-kit')
    vi.mocked(resetPool).mockImplementation(() => {
      f.rebuildsAt.push(Date.now())
      setTimeout(() => f.setLive(true), 15_000)
    })
    await vi.advanceTimersByTimeAsync(8_000 + 20_000)
    await vi.advanceTimersByTimeAsync(60_000) // live, unobserved, for a minute
    const t0 = Date.now()
    f.drop()
    expect(f.rebuildsAt.at(-1)).toBe(t0) // no wait: back to square one
    f.watch.resetForTests({ installed: false })
  })

  it('a resume checks at once but waits out an active backoff window before rebuilding', async () => {
    const f = await flapping()
    f.stopFlapping()
    f.drop() // rebuild #1, window 1 s
    await vi.advanceTimersByTimeAsync(300)
    f.drop() // rebuild deferred to the window's end
    await vi.advanceTimersByTimeAsync(100)
    expect(f.rebuildsAt).toHaveLength(1)
    f.doc.dispatchEvent(new Event('resume'))
    await vi.advanceTimersByTimeAsync(0)
    expect(f.rebuildsAt).toHaveLength(1) // inside the window: no rebuild yet
    expect(f.after).toHaveBeenCalled() // but the resume's follow-up still runs
    await vi.advanceTimersByTimeAsync(700)
    expect(f.rebuildsAt).toHaveLength(2)
    expect(f.rebuildsAt[1]! - f.rebuildsAt[0]!).toBe(1_000)
    f.watch.resetForTests({ installed: false })
  })

  it('a resume with no backoff active rebuilds a dead pool at once, as before', async () => {
    const f = await flapping()
    f.stopFlapping()
    f.setLive(false)
    f.doc.dispatchEvent(new Event('resume'))
    expect(f.rebuildsAt).toHaveLength(1)
    f.watch.resetForTests({ installed: false })
  })
})

/** A socket stand-in for relay-watch.ts: records nothing itself; `receive`
 *  plays a relay message, `close` the socket closing. */
function fakeSocket(url: string) {
  const listeners: Record<string, Array<(ev: { data: unknown }) => void>> = {}
  const sock = {
    url,
    readyState: 1,
    send(_data: string): void {},
    addEventListener(type: string, fn: (ev: { data: unknown }) => void): void {
      (listeners[type] ??= []).push(fn)
    },
    receive(data: string): void { for (const fn of listeners.message ?? []) fn({ data }) },
    close(): void {
      sock.readyState = 3
      for (const fn of listeners.close ?? []) fn({ data: undefined })
    },
    error(): void {
      sock.readyState = 3
      for (const fn of listeners.error ?? []) fn({ data: undefined })
    },
  }
  return sock
}
