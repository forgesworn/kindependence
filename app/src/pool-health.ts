// Relay-pool staleness recovery (Phase 7 Task 2, design spec §2). The shared
// roost-kit relay pool — the module-singleton `SimplePool` inside roost-kit's
// transport.ts, which every `subscribeGiftWraps` holder in this app rides
// (beacons.ts's per-circle inbox subscriptions, circles.ts's personal-inbox
// subscription) — can go silently stale on mobile: sockets stay
// TCP-connected, but publishes stop landing and subscriptions stop
// delivering, and re-issuing REQs on the SAME pool never recovers it. Only
// tearing the pool down and reconnecting does (roost-kit's `resetPool`,
// 8364712).
//
// Adopted from flock's own fix for the identical bug (flock d36a004, "fix:
// restore chat delivery by rebuilding a stale relay pool") — the same
// two-condition gate (`shouldResetPool` below: never rebuild on staleness
// alone, always also respect a cooldown) and the same hard-won lesson their
// own doc comment states explicitly, preserved here: an EARLIER flock cut
// blindly rebuilt the pool on every timer tick regardless of whether it
// looked dead, which tore down HEALTHY sockets and made delivery WORSE, not
// better.
//
// Tuning DIVERGES from flock's own (final-review fix, Important #1): flock
// keeps its pool under roughly 90s of cover traffic even at rest, so flock's
// own `POOL_STALE_SEC`/`POOL_RESET_COOLDOWN_SEC` = 60 was already generous
// there. That tuning was adopted verbatim in an earlier pass, but kindependence's
// cadence isn't flock's — beacons.ts's own `STATIONARY_TICK_MS` stretches
// the ROUTINE gap between beacon emits to 300s once a circle goes quiet (an
// unremarkable quiet evening, not a problem), well past a 60s stale window.
// The old 60s tuning meant a perfectly healthy, quiet pool would read as
// "stale" roughly every 90-120s and get torn down on that false alarm alone
// — each false reset forcing every subscription owner's next `ensure()` pass
// into a full no-`since` stored-backlog resubscribe (see `buildSubKey`'s doc
// comment), busywork and needless relay load for a pool that was never
// actually dead. `POOL_STALE_SEC` is now 330 — just above the 300s maximum
// routine gap, with roughly one `POOL_CHECK_INTERVAL_MS` tick of margin above
// it. `POOL_RESET_COOLDOWN_SEC` stays 60: it was never the part of flock's
// tuning that didn't transfer — it isn't about telling healthy-quiet apart
// from dead, it's the "can't hammer reconnects" guard once a rebuild has
// genuinely started, and that reasoning is cadence-independent.
//
// Liveness evidence was ALSO widened in the same fix: `notePoolActivity`
// used to be fed only by inbound wrap delivery (an active circle's own
// beacons/DMs arriving). It is now ALSO called from beacons.ts's
// `publishOrEnqueue`, on every SUCCESSFUL publish — the one send seam every
// publishing module in this app routes through (beacons, circles, messages,
// pins, meet, places, journey, pickup, safety, agreements, approvals — see
// `publishOrEnqueue`'s own doc comment), not just beacons.ts's own emits. A
// pool that's being actively used to SEND now has far more chances to prove
// itself than inbound traffic alone gave it — closing exactly the gap a
// circle that's quiet on receive but still being used to send exposed under
// the old inbound-only scheme. Either kind of evidence — receiving
// something, or successfully sending something — is equally proof the pool
// is alive; `shouldResetPool` doesn't care which cleared the clock.
//
// Kindependence-specific scope note: unlike flock (one SimplePool for
// everything), kindependence has a SECOND, architecturally separate relay pool —
// rail-live.ts's own module-singleton `SimplePool`, used only for the
// companion-rail pairing/snapshot subscription (contacts.ts). roost-kit's
// `resetPool()` does not touch it, and a rail-live snapshot arriving proves
// nothing about whether beacons.ts/circles.ts's shared pool is delivering —
// wiring rail-live's traffic into THIS module's `lastWrapAt` clock would let
// healthy rail-live activity mask a dead circle/personal-inbox pool (the
// actual reported symptom: "chat just doesn't work"). So rail-live is
// deliberately left untouched BY THIS MODULE: `shouldResetPool`/`buildSubKey`
// above are reused, but rail-live.ts owns its own local staleness clock and
// its own `resetRailPool`/`recoverRailPoolIfStale`/`railGeneration` (review
// follow-up, same class of bug fixed here) — see that module's own doc
// comment for the full picture. The two pools' recovery state stays fully
// separate; only the pure gate and its tuning are shared — both pools use
// the SAME `POOL_STALE_SEC`/`POOL_RESET_COOLDOWN_SEC` (330s/60s, final-review
// fix) via `shouldResetPool`'s own default parameters, which rail-live.ts
// never overrides, even though rail's own traffic has no periodic cadence of
// its own to measure 330s against the way beacon traffic does — see
// rail-live.ts's own doc comment for why the same numbers were kept there
// anyway (a least-churn call, not a claim that 330s means anything
// cadence-wise for a paired rail).
//
// Wired from: app.ts's render() (`ensure()` below, identity-gated like
// beacons.ensure/circles.ensure — seeds the staleness clock right before
// those two modules start actually using the pool); app.ts's EXISTING
// `visibilitychange` listener (foreground hook — deliberately NOT a second
// `document.addEventListener` here; app.ts already owns the one listener
// from Phase 6's friction resume hook, and now also calls `recoverIfStale()`
// from it directly); and messages.ts's `setOpenThread` (opening a circle or
// DM thread is exactly the moment you're waiting on a reply — the
// "messages surface open" hook, calling `recoverIfStale()` directly).

import * as store from './store.js'
import { resetPool } from '@forgesworn/roost-kit'
import * as relayWatch from './relay-watch.js'
import * as nativeSocket from './native-socket.js'

// Ambient augmentation, NOT a real API gap: `resetPool` is a genuine runtime
// export of the patched roost-kit this app is pinned to (package.json;
// confirmed in app/node_modules/@forgesworn/roost-kit/dist/transport.js) —
// but `tsc` sees TWO physical `@forgesworn/roost-kit` installs that both
// self-report `"version": "0.1.0"` (covey-kit's own transitive dependency is
// still pinned at the pre-`resetPool` commit; see circles.ts's "DURABLE FIX
// flagged for maintainer" comment on this exact dual-pin — the P7T1 report's
// `overrides` attempt to collapse it to one copy didn't stick). TypeScript's
// same-"Package ID" module cache treats both installs as interchangeable and
// can resolve THIS import's `./transport.js` re-export against whichever
// copy it loaded first for that identity — sometimes the older one, which
// predates `resetPool` and so appears not to export it. This augmentation
// only patches the STATIC type view app-wide for this one addition; it
// changes no runtime behaviour (Node's real module resolution, used by both
// Vite and vitest, already finds the correct patched copy regardless — see
// this file's own successful `import { resetPool }` immediately below,
// which resolves and runs correctly at both build and test time). Remove
// this block once covey-kit's own dependency is repinned upstream.
declare module '@forgesworn/roost-kit' {
  export function resetPool(): void
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** No wrap delivered AND no successful publish for this long ⇒ suspect a
 *  dead pool. 330s (final-review fix, Important #1) — just above 300s, the
 *  longest ROUTINE gap kindependence's own cadence ever produces on a quiet
 *  circle (beacons.ts's `STATIONARY_TICK_MS`), with roughly one
 *  `POOL_CHECK_INTERVAL_MS` tick of margin. NOT flock d36a004's own 60s
 *  (that tuning assumed flock's ~90s cover-traffic cadence, which kindependence
 *  doesn't share — see the module doc comment's "Tuning DIVERGES" paragraph
 *  for the false-positive churn this fixes). */
export const POOL_STALE_SEC = 330

/** Rebuild the pool at most this often on the stale path — a cooldown so recovery can't hammer reconnects (flock d36a004's tuning, adopted verbatim). */
export const POOL_RESET_COOLDOWN_SEC = 60

/** Periodic failsafe check cadence (flock d36a004's tuning, adopted
 *  verbatim) — belt-and-braces for a long, continuously-foregrounded session
 *  where the foreground hook never fires because there's no actual
 *  background→foreground transition to trigger it. */
export const POOL_CHECK_INTERVAL_MS = 30_000

/**
 * Pure staleness gate: true iff no wrap has arrived for more than `staleSec`
 * AND the last reset was more than `cooldownSec` ago. Both conditions are
 * required — see the module doc comment's "never blind-rebuild" lesson:
 * without the first check, this would fire on a perfectly healthy pool the
 * moment the cooldown lapses, on every tick, forever; without the second, a
 * genuinely dead pool would be rebuilt on every 30s tick for as long as it
 * stayed dead, hammering reconnects instead of giving each rebuild attempt a
 * fair chance to land. `nowSecValue` is always caller-supplied (never read
 * from the clock here), same discipline as every other pure gate in this
 * codebase (e.g. friction.ts's `shouldCountResumeAsMapCheck`) — directly
 * unit-testable and deterministic.
 */
export function shouldResetPool(
  lastWrapAtSec: number,
  lastResetAtSec: number,
  nowSecValue: number,
  staleSec: number = POOL_STALE_SEC,
  cooldownSec: number = POOL_RESET_COOLDOWN_SEC,
): boolean {
  return nowSecValue - lastWrapAtSec > staleSec && nowSecValue - lastResetAtSec > cooldownSec
}

/**
 * Pure subscription-key builder: prefixes a module's own key (its usual
 * `pk@relay,relay`-style string) with the current pool generation. A bump
 * (`recoverIfStale`'s `gen += 1`) changes the key every "ensure a
 * subscription is live" comparison builds from it, so the next pass in
 * beacons.ts's `ensureReceive`/circles.ts's `ensure` sees its PREVIOUSLY
 * stored key as stale — even though nothing about the subscription's actual
 * inputs (inbox pubkey, relay list) changed — and tears down + rebuilds
 * cleanly. That's the piece `resetPool()` alone doesn't provide: destroying
 * the pool object doesn't itself invalidate the OLD `subscribeGiftWraps`
 * closures beacons.ts/circles.ts are still holding onto — without a key that
 * changes, they'd keep comparing "same key as before, nothing to do" and sit
 * silently inert against the torn-down pool forever. `gen` is always
 * caller-supplied (never read from module state here), so this is directly
 * unit-testable without touching `recoverIfStale`'s side effects.
 */
export function buildSubKey(gen: number, parts: string): string {
  return `gen:${gen}:${parts}`
}

let lastWrapAt = 0 // unix-sec of the last wrap delivered OR successful publish (0 = none yet) — see notePoolActivity
let lastResetAt = 0 // unix-sec of the last pool rebuild
let gen = 0 // bumped on every rebuild — see buildSubKey

/** Records proof the shared pool is alive — call from every tracked
 *  subscription's wrap-arrival hook (beacons.ts's `onCircleInboxWrap`,
 *  circles.ts's `onPersonalInboxWrap`) AND from beacons.ts's
 *  `publishOrEnqueue`, on every SUCCESSFUL publish (final-review fix,
 *  Important #1(b) — see the module doc comment's "Liveness evidence was
 *  ALSO widened" paragraph for why a send counts as evidence too, not just a
 *  receive). Even a duplicate or undecryptable wrap counts: the relay
 *  clearly delivered SOMETHING, which is all this is evidence of; likewise a
 *  successful publish only proves the relay ACKed a write, nothing about its
 *  content. `nowSecValue` defaults to the real clock; tests pass an explicit
 *  value instead. */
export function notePoolActivity(nowSecValue: number = nowSec()): void {
  lastWrapAt = nowSecValue
}

/** Current pool generation — feed into `buildSubKey` at each subscription
 *  owner's own "is my subscription still current" comparison point. */
export function generation(): number {
  return gen
}

/**
 * Rebuilds the pool iff `shouldResetPool` says it's actually warranted — the
 * ONE place `resetPool()` (roost-kit) is ever called from. Only ever invoked
 * from the three trigger contexts wired below (the periodic timer, app.ts's
 * foreground hook, messages.ts's surface-open hook) — never from inside a
 * publish/send call, so a reset always lands "between ticks," not mid-flight
 * of a safety alert or any other send (constraint: recovery must never
 * interrupt an in-flight send). Bumps the generation and notifies the store
 * so every subscription owner's next render→`ensure()` pass rebuilds its
 * subscription against the fresh pool (see `buildSubKey`'s doc comment for
 * why a reset alone doesn't already do this). Returns whether it actually
 * reset (test convenience — app call sites never inspect the result).
 */
export function recoverIfStale(nowSecValue: number = nowSec()): boolean {
  if (!shouldResetPool(lastWrapAt, lastResetAt, nowSecValue)) return false
  // With the native bridge a socket that says OPEN is open (OkHttp pings
  // notice a dead path within a minute), and frames that arrived while the
  // WebView was frozen are replayed on resume — so a pool whose inbox
  // subscriptions are open on OPEN sockets is quiet, not stale. Found on
  // the OnePlus (phase 3, check 1): this clock fired on resume before the
  // replay landed and tore down a healthy pool.
  if (nativeSocket.isActive() && poolLive()) return false
  resetPool()
  console.info(`pool-health: rebuilt pool cause=stale nativeBridge=${nativeSocket.isActive()}`)
  lastResetAt = nowSecValue
  gen += 1
  store.notify()
  return true
}

/** Inbox tags (`#p`) this app keeps a subscription open for, with a count
 *  (two owners may watch the same tag). circles.ts and beacons.ts register
 *  each `subscribeGiftWraps` they hold (`expectInbox`), so a resume can
 *  check that every one of them is actually open. */
const expectedInboxes = new Map<string, number>()

/** Registers inbox `tag` as one that should have an open subscription.
 *  Returns the release, to call with the unsubscribe. */
export function expectInbox(tag: string): () => void {
  expectedInboxes.set(tag, (expectedInboxes.get(tag) ?? 0) + 1)
  let released = false
  return () => {
    if (released) return
    released = true
    const n = (expectedInboxes.get(tag) ?? 1) - 1
    if (n <= 0) expectedInboxes.delete(tag)
    else expectedInboxes.set(tag, n)
  }
}

/** Whether the pool is actually delivering: every expected inbox has a
 *  subscription open on an open relay socket (relay-watch.ts). Unknown —
 *  sockets not watched — counts as dead, so a resume still rebuilds. */
export function poolLive(): boolean {
  if (!relayWatch.isInstalled()) return false
  const live = relayWatch.liveTags()
  for (const tag of expectedInboxes.keys()) if (!live.has(tag)) return false
  return true
}

/** How long a rebuild counts as "in progress" at most: until every expected
 *  inbox is open again, or this long, whichever is first. A resume during
 *  it joins the rebuild instead of starting another. */
export const REBUILD_SETTLE_MS = 10_000
const REBUILD_POLL_MS = 250

let rebuilding: Promise<boolean> | null = null

/** Final review, item 2: a relay that accepts the REQs and then closes the
 *  socket (rate-limiting the resubscribe burst, say) made every close
 *  rebuild at once — about a rebuild a second, for as long as it kept
 *  doing it. A rebuild triggered by a socket drop now opens a backoff
 *  window: 1 s after the first, then 2 s, 4 s … capped at 60 s. No rebuild,
 *  whatever triggered the check, happens inside the window; a dead pool
 *  found inside it is re-checked at the window's end. The backoff resets
 *  once the pool has gone 60 s without being found dead. */
export const DROP_BACKOFF_BASE_MS = 1_000
export const DROP_BACKOFF_MAX_MS = 60_000
export const DROP_BACKOFF_RESET_MS = 60_000

let dropBackoffMs = 0 // the last window's length (0 = no backoff)
let backoffUntilMs = 0 // no rebuild before this (ms epoch)
let lastDeadMs: number | null = null // when the pool was last found dead

/**
 * Review follow-up to 9aeaff2 (device check 2026-09-27, phase 2 step 6):
 * Android WebView freezes this page while Kindependence is in the background
 * (a NIP-55 round trip to My Signet, the screen going off) and closes every
 * WebSocket under it — console: "WebSocket connection to
 * 'wss://relay.example/' failed: Page entered Back-Forward Cache."
 * nostr-tools reads that first error as a failed connection
 * (`skipReconnection`), drops the relay and closes every subscription on it
 * for good. Publishes still work, each opening a fresh connection, and
 * `notePoolActivity` counts them — so `recoverIfStale` never fires.
 *
 * On every resume this checks the pool's ACTUAL liveness (`isLive`, by
 * default `poolLive`: are the relay sockets and the inbox subscriptions
 * open?) and rebuilds only when it is dead. The one dedupe is a rebuild
 * already in progress — a second resume joins it — never a time window: a
 * second freeze a few seconds after the first must still be recovered.
 * The rebuild does not touch `lastWrapAt` (a rebuild is no proof of
 * delivery). Resolves true when this call rebuilt (or joined a rebuild).
 *
 * `cause: 'drop'` (a socket went down) opens or lengthens the drop backoff
 * window (see `DROP_BACKOFF_BASE_MS`); any cause finding the pool dead
 * inside that window resolves false without rebuilding.
 */
export function recoverOnResume(
  isLive: () => boolean = poolLive,
  nowSecValue: number = nowSec(),
  cause: 'resume' | 'drop' = 'resume',
): Promise<boolean> {
  if (rebuilding) return rebuilding
  const nowMs = Date.now()
  if (isLive()) return Promise.resolve(false)
  // Found dead. Not having been found dead for DROP_BACKOFF_RESET_MS earns a
  // fresh start — timed from the last dead finding, not from a sighting of
  // the pool live, since a pool that came up after a timed-out settle is
  // never sampled. A relay flapping at the cap is found dead at every window
  // end, so it never qualifies.
  if (lastDeadMs !== null && nowMs - lastDeadMs > DROP_BACKOFF_RESET_MS) {
    dropBackoffMs = 0
    backoffUntilMs = 0
  }
  lastDeadMs = nowMs
  // Every cause respects an active backoff window; the caller
  // (wireFreezeRecovery) re-checks at its end.
  if (nowMs < backoffUntilMs) return Promise.resolve(false)
  if (cause === 'drop') {
    dropBackoffMs = dropBackoffMs === 0 ? DROP_BACKOFF_BASE_MS : Math.min(dropBackoffMs * 2, DROP_BACKOFF_MAX_MS)
    backoffUntilMs = nowMs + dropBackoffMs
  }
  resetPool()
  console.info(`pool-health: rebuilt pool cause=${cause} nativeBridge=${nativeSocket.isActive()}`)
  lastResetAt = nowSecValue
  gen += 1
  store.notify()
  const settled = new Promise<boolean>((resolve) => {
    const started = Date.now()
    const tick = (): void => {
      const up = isLive()
      if (up || Date.now() - started >= REBUILD_SETTLE_MS) {
        rebuilding = null
        resolve(true)
        return
      }
      setTimeout(tick, REBUILD_POLL_MS)
    }
    setTimeout(tick, REBUILD_POLL_MS)
  })
  rebuilding = settled
  return settled
}

/** Ms until an active drop backoff window ends (0 = none). */
export function rebuildBackoffRemainingMs(nowMs: number = Date.now()): number {
  return Math.max(0, backoffUntilMs - nowMs)
}

/** After a resume, liveness is checked again this long later (ms). After a
 *  freeze the sockets' error/close tasks are often delivered AFTER the
 *  page's `resume`/`visibilitychange`, so the check made at resume still
 *  sees readyState OPEN; these re-checks catch the pool dying just after. */
export const RESUME_RECHECK_MS: readonly number[] = [1_000, 5_000]

/** Wires `recoverOnResume` to the page coming back — `resume` on the
 *  document (Page Lifecycle), `pageshow` with `persisted` on the window
 *  (back-forward cache), and, as a backup, the document's
 *  `visibilitychange` to visible — and runs `after` (the caller's retry of
 *  anything that failed to send meanwhile: queue drain, outbox flush) on
 *  EVERY resume, once any rebuild has settled, rebuilt or not. The events
 *  of one unfreeze coalesce into one `after`.
 *
 *  Liveness is checked again `recheckMs` after each resume, and whenever a
 *  watched relay socket errors or closes while the page is visible
 *  (relay-watch.ts `onSocketDown`) — a close delivered after the resume
 *  event would otherwise leave the pool dead until the next freeze, and
 *  nostr-tools' `skipReconnection` means it never comes back by itself.
 *  Those checks rebuild only a dead pool, join a rebuild in progress, and
 *  run `after` only when they rebuilt. A socket drop's rebuild is backed
 *  off (`DROP_BACKOFF_BASE_MS`); resume checks run at once but respect the
 *  window for the rebuild itself.
 *  Targets are parameters so the wiring is testable without a DOM. */
export function wireFreezeRecovery(
  doc: EventTarget & { visibilityState?: string },
  win: EventTarget,
  after: () => void,
  isLive: () => boolean = poolLive,
  recheckMs: readonly number[] = RESUME_RECHECK_MS,
): void {
  const visible = (): boolean => doc.visibilityState === undefined || doc.visibilityState === 'visible'
  let afterPending = false
  const runAfter = (): void => {
    if (afterPending) return
    afterPending = true
    queueMicrotask(() => {
      afterPending = false
      after()
    })
  }
  // A dead pool found inside a drop backoff window is checked again once,
  // at the window's end (coalesced) — nostr-tools will not reconnect it.
  let deferred: ReturnType<typeof setTimeout> | null = null
  const deferPastBackoff = (): void => {
    const wait = rebuildBackoffRemainingMs()
    if (deferred || wait <= 0 || isLive()) return
    deferred = setTimeout(() => {
      deferred = null
      if (visible()) check(false, 'drop')
    }, wait)
  }
  const check = (always: boolean, cause: 'resume' | 'drop' = 'resume'): void => {
    const joining = rebuilding !== null
    void recoverOnResume(isLive, nowSec(), cause).then((rebuilt) => {
      if (joining) return // the rebuild's owner runs `after`
      if (!rebuilt) deferPastBackoff()
      if (rebuilt || always) runAfter()
    })
  }
  let rechecks: Array<ReturnType<typeof setTimeout>> = []
  const unfrozen = (): void => {
    check(true)
    for (const t of rechecks) clearTimeout(t)
    rechecks = recheckMs.map((ms) => setTimeout(() => { if (visible()) check(false) }, ms))
  }
  doc.addEventListener('resume', unfrozen)
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') unfrozen() })
  win.addEventListener('pageshow', (e) => { if ((e as Event & { persisted?: boolean }).persisted) unfrozen() })
  relayWatch.onSocketDown(() => { if (visible()) check(false, 'drop') })
}

/** Test seam: forgets any rebuild in progress, the drop backoff and every
 *  expected inbox. */
export function resetResumeStateForTests(): void {
  rebuilding = null
  dropBackoffMs = 0
  backoffUntilMs = 0
  lastDeadMs = null
  expectedInboxes.clear()
}

let started = false

/**
 * Starts the periodic failsafe check (idempotent — safe to call on every
 * render, same "registered" idiom as meet.ts/journey.ts/agreements.ts's own
 * `ensure()`s) and seeds `lastWrapAt` to now. Seeding matters: called from
 * app.ts's render() right before circles.ensure/beacons.ensure actually
 * start using the pool (their `subscribeGiftWraps` calls are what lazily
 * builds it, inside roost-kit) — without this, a freshly-built pool would
 * read as "stale" from `lastWrapAt`'s zero-value default and get needlessly
 * torn down again before its very first wrap has any chance to land (same
 * reasoning as flock d36a004's own seeding at `bootUnlocked()`).
 *
 * Does not register a `visibilitychange` listener for `recoverIfStale()` —
 * app.ts's own listener calls it directly. (`wireFreezeRecovery` does add
 * one, as a backup trigger for the liveness check on resume, which is a
 * different question: is the pool open at all, not has it gone quiet.) Same reasoning for the
 * messages-surface-open hook, wired directly from messages.ts.
 *
 * No stop/teardown counterpart (unlike rail-live.ts's own `stopRailPoolWatch`
 * for its separate 30s rail-pool watch, Phase 7 Task 5 review queue item 4):
 * this app has no sign-out action at all (an identity is live for as long as
 * anything renders — see wizard.ts's own doc comment on `wizardState` for the
 * same invariant relied on elsewhere), so there is no teardown call site for
 * this watch to be stopped from today. Revisit if a sign-out action is ever
 * added.
 */
export function ensure(): void {
  if (started) return
  started = true
  lastWrapAt = nowSec()
  setInterval(() => { recoverIfStale() }, POOL_CHECK_INTERVAL_MS)
}
