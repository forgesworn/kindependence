// kindependence — vanilla TS UI shell. Render-on-state: every store change (or
// tab switch) re-renders the whole #app innerHTML from current state, then
// re-wires its `data-action` handlers. No framework, no virtual DOM — same
// idiom as flock's app/src/app.ts.
//
// Phase-2 nav (brief §5/§24.2): exactly four tabs — Map, Circles, Activity,
// You. Circles absorbs everything the old Home tab used to show (Signet
// identity plan, Task 11: signin.ts now owns sign-in — see `signin.
// shouldShow()`'s short-circuit in `render()` below — plus the safety/
// agreements/approvals/circle-list cards); You absorbs Settings + the
// signed-in identity line + a simple per-circle privacy summary (the old
// Contacts module — rail pairing + rolodex — is gone; plan 2's My Signet
// contacts grant renders via `contactsView.youContactsView()`, see
// `youView`'s own doc comment); Activity (Task 2) renders
// activity.ts's own timeline view — this
// file just owns the deep-link navigation side (see `handleActivityNav`
// below), the same "own the tab section" split every other domain module
// already follows. The SOS button (safety.ts) is kept globally reachable: it renders inline
// at the top of Circles (`safety.view`, unchanged) AND as an overlay on the
// Map tab (`safety.sosButtonView`, a new minimal export) — see `mapView`.

import * as store from './store.js'
import * as session from './session.js'
import type { SessionInfo } from './session.js'
import * as signin from './signin.js'
import * as linkPairing from './link-pairing.js'
import * as structuralQueue from './structural-queue.js'
import * as formState from './form-state.js'
import * as circles from './circles.js'
import * as beacons from './beacons.js'
import * as poolHealth from './pool-health.js'
import * as relayWatch from './relay-watch.js'
import * as safety from './safety.js'
import * as agreements from './agreements.js'
import * as approvals from './approvals.js'
import * as activity from './activity.js'
import * as messages from './messages.js'
import * as pickup from './pickup.js'
import * as places from './places.js'
import * as friction from './friction.js'
import * as milestones from './milestones.js'
import * as wizard from './wizard.js'
import * as meet from './meet.js'
import * as devices from './devices.js'
import * as contactsGrant from './contacts-grant.js'
import * as contactsView from './contacts-view.js'
import * as trustWatch from './trust-watch.js'
import * as pins from './pins.js'
import * as journey from './journey.js'
import * as battery from './battery.js'
import * as widget from './widget.js'
import * as mapinfo from './mapinfo.js'
import * as navexport from './navexport.js'
import * as nativeGeo from './native-geo.js'
import * as nativeSocket from './native-socket.js'
import { isNativePlatform } from './native.js'
import type { Circle } from '@forgesworn/covey-kit'
import type { MapView, MapPoint, MapArea, MapPlace, MapMeetPoint, MapDroppedPin, EdgeCandidate } from './map.js'
import { decode as decodeGeohash, encode as encodeGeohash } from 'geohash-kit'

export type Tab = 'map' | 'circles' | 'activity' | 'you'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'map', label: 'Map' },
  { id: 'circles', label: 'Circles' },
  { id: 'activity', label: 'Activity' },
  { id: 'you', label: 'You' },
]

let root: HTMLElement | null = null
// Map-first (brief §5/§24.2's stated nav priority) — was 'home' pre-phase-2.
let tab: Tab = 'map'

/** Plan 2, Task 8: trust-watch.ts's own stop function, once started — see
 *  `render()`'s own self-gating call below. Unlike every other domain
 *  module here, trust-watch.ts has no internal `ensure()` that tears its
 *  own subscriptions down on sign-out (contacts-updated/member-left/
 *  link-broken listeners are plain registries, not identity-gated) — so
 *  this file, the one place already doing "start on session, stop on
 *  none" for every other module, holds the stop function instead. */
let stopTrustWatch: (() => void) | null = null

/** Signet identity plan, Task 11: the app-start sequence (carried from Task
 *  9/10's own registrations) — structural senders registered BEFORE the
 *  queue drains (a drain before that must not burn a signer prompt on an
 *  event nobody can send yet, per structural-queue.ts's own doc comment),
 *  then the queue itself, then the two housekeeping passes that depend on a
 *  live session (removals this device asked for; this device's own device
 *  statement, freshly re-posted into every shared circle). Runs once after
 *  `session.restore()` on a cold start, and again right after a fresh
 *  sign-in (`signin.setOnSignedIn`, below) — the exact same sequence
 *  either way. */
async function bootAfterSignIn(): Promise<void> {
  circles.registerStructuralSenders()
  approvals.registerStructuralSenders()
  agreements.registerStructuralSenders()
  places.registerStructuralSenders()
  await structuralQueue.start()
  await circles.resumePendingRemovals()
  await beacons.refreshStatements()
}

/** Boots the shell into `el` and starts re-rendering on every store change. */
export async function mount(el: HTMLElement): Promise<void> {
  root = el
  // Native socket bridge plan: try the native transport first — on web, or
  // wherever the plugin never synced into the build, `install` resolves
  // false and `webSocketClass()` stays undefined, so `relayWatch.install`
  // falls back to its own default (the browser WebSocket), exactly as
  // before this bridge existed.
  const bridged = await nativeSocket.install(document)
  // Before anything subscribes or publishes: every relay pool built from
  // here on reports its sockets' subscriptions to relay-watch.ts, which is
  // how a resume tells a live pool from a dead one (pool-health.ts).
  relayWatch.install(bridged ? nativeSocket.webSocketClass() : undefined)
  // Signet identity plan, Task 11: a fresh sign-in (signin.ts) runs the
  // exact same post-sign-in sequence a cold-start restore does below.
  signin.setOnSignedIn(() => { void runBootAfterSignIn() })
  // Registration, not import (activity.ts has no reference to this module's
  // tab state / live MapView — see activity.ts's own doc comment on
  // `setNavigator`). Idempotent (plain assignment); called once here is
  // enough, but nothing breaks if it were called again.
  activity.setNavigator(handleActivityNav)
  // Registration, not import — see messages.ts's own doc comment on
  // `setOpenCirclesTab` (its "Be home by…" chip hands off to agreements.ts's
  // form, which only renders on the Circles tab).
  messages.setOpenCirclesTab(() => showTab('circles'))
  // Phase 6 Task 4 (final-review follow-up on Task 1): counts an app-resume
  // as a map-check too, not just a fresh Map-tab activation — a cold
  // relaunch (or backgrounding then switching straight back) onto an
  // ALREADY-active Map tab never re-triggers `showTab`'s own hook, so the
  // dominant compulsive close-reopen pattern was going uncounted. Kept as a
  // one-line dispatch to `friction.ts`'s own pure gate
  // (`shouldCountResumeAsMapCheck`) plus the SAME guardian-only gate every
  // other `recordMapCheck` call site already uses — no new mechanic, just a
  // third call site.
  document.addEventListener('visibilitychange', () => {
    if (friction.shouldCountResumeAsMapCheck(document.visibilityState, tab)) recordMapCheckIfGuardian()
    // Phase 7 Task 2 (design spec §2): the relay pool can go silently stale
    // while backgrounded, so a background→foreground transition is one of
    // pool-health.ts's recovery triggers — sharing this ALREADY-registered
    // listener rather than adding a second `visibilitychange` handler for
    // the same event (see pool-health.ts's `ensure()` doc comment).
    // `recoverIfStale()` is self-gated (staleness + cooldown), so this is a
    // no-op on a pool that's still healthy.
    if (document.visibilityState === 'visible') poolHealth.recoverIfStale()
    // Fix round 1, finding 2 (plan 2, Task 2): the contacts grant's own
    // live/poll refresh keeps it fresh in the background, but a resume is a
    // free extra chance to catch up right away rather than wait for the
    // next debounced live event or the 60s poll — same "recovery trigger on
    // resume" idiom as `poolHealth.recoverIfStale()` just above, sharing
    // this ALREADY-registered listener rather than adding a second one.
    // Self-gated (a no-op with no grant live), so harmless every resume.
    if (document.visibilityState === 'visible') contactsGrant.refreshOnResume()
    // Personal-inbox wraps deferred because My Signet couldn't answer
    // silently (locked, asleep) get another silent try now — never an
    // intent (circles.ts's `personalInboxSigner`).
    if (document.visibilityState === 'visible') void circles.retryDeferredPersonalWraps()
  })
  // Device check 2026-09-27 (phase 2 step 6): the WebView froze this page
  // while it was in the background and cut every relay socket. On every
  // resume (and visibilitychange to visible, as a backup) pool-health.ts's
  // `recoverOnResume` checks whether the inbox subscriptions are actually
  // open (relay-watch.ts) and rebuilds the pool only if they are not (and
  // checks again ~1 s and ~5 s later, and whenever a relay socket drops
  // while visible); then, on every resume, this retries whatever failed to
  // send meanwhile — structural events the queue still holds, beacons in the
  // outbox — rather than waiting for the queue's 30s tick.
  poolHealth.wireFreezeRecovery(document, window, () => {
    void structuralQueue.drain()
    void beacons.flushOutbox()
  })
  // Phase 6 final-review finding 7: a genuinely COLD relaunch — the process
  // starting fresh, `tab` still at its module-level default of 'map' — never
  // fires EITHER of the two hooks above: `showTab('map')` is never called
  // (the app just renders whatever `tab` already is), and there's no prior
  // `visibilitychange` to fire the resume hook either (the page was never
  // hidden-then-shown; it just started visible). That leaves the dominant
  // "force-close, reopen, land straight back on the map" pattern uncounted
  // on exactly the launch where it happens. Reuses the SAME guarded gate
  // every other call site does — no new mechanic, just a fourth call site,
  // gated on the same `tab === 'map'` check `showTab` itself uses.
  if (tab === 'map') recordMapCheckIfGuardian()
  store.subscribe(render)
  // Signet identity plan, Task 11 (carries #4): session.restore() before the
  // first render — `restore()` never reconnects the identity transport
  // eagerly (session.ts's own doc comment), so this resolves fast even
  // offline. Fix round 1, finding 3: render() runs right after that (same
  // step order otherwise), and `bootAfterSignIn()` is kicked off WITHOUT
  // being awaited — its own network calls (structuralQueue.start(),
  // resumePendingRemovals(), refreshStatements()) must never hold up the
  // first paint. Errors are caught and logged here rather than left to
  // reject an unawaited promise silently.
  const restored = await session.restore()
  render()
  if (restored) void runBootAfterSignIn()
  // Plan 2, Task 2: the contacts grant is a local, per-device pairing
  // (contacts-grant.ts's own doc comment) independent of the family
  // identity session above — reloaded here, unawaited, same "never hold up
  // the first paint" discipline as `runBootAfterSignIn`.
  void runStartGrant()
}

/** Runs `contactsGrant.startGrant()` without letting a failure escape as an
 *  unhandled rejection — same shape as `runBootAfterSignIn` above. */
async function runStartGrant(): Promise<void> {
  try {
    await contactsGrant.startGrant()
  } catch (e) {
    console.error('startGrant failed', e)
  }
}

/** Runs `bootAfterSignIn()` without letting a failure escape as an unhandled
 *  rejection — shared by `mount()`'s cold-start call and `signin.
 *  setOnSignedIn`'s fresh-sign-in call below, neither of which awaits it
 *  (Task 11 fix round 1, finding 3: the first paint, or the sign-in
 *  screen's own return to the app, must never wait on My Signet or the
 *  network). */
async function runBootAfterSignIn(): Promise<void> {
  try {
    await bootAfterSignIn()
  } catch (e) {
    console.error('bootAfterSignIn failed', e)
  }
}

/** Switches the active tab and re-renders. */
export function showTab(name: Tab): void {
  tab = name
  if (name === 'map') {
    // Phase 6 Task 1 hook 1/2 (design spec §1, brief §2.3): a Map-tab
    // activation counts as one map-check — guardian-only (see
    // `recordMapCheckIfGuardian`'s own doc comment for why). The 60s
    // collapse (`friction.FRICTION_MIN_GAP_SEC`) already absorbs the rare
    // case where this fires right alongside hook 2/2 (`setSheetTarget`
    // below) — e.g. `applyMapFocus`'s `showTab('map')`-then-`setSheetTarget`
    // cross-tab handoff — so there's nothing to special-case here.
    recordMapCheckIfGuardian()
  } else {
    // A person sheet is Map-tab-scoped UI state (see `sheetTarget`'s own
    // doc comment) — leaving the tab closes it, so navigating away and back
    // never resurfaces a stale one.
    setSheetTarget(null)
  }
  render()
}

/** Phase 6 Task 1: guardian-only gate shared by both of friction.ts's
 *  `recordMapCheck` call sites (this one, and `setSheetTarget`'s dependant-
 *  sheet-open hook below) — a child's own Map-tab visits or sheet opens
 *  must never feed this counter (§2.3's "private, guardian-side" scope;
 *  see store.ts's `Persisted.mapChecks` doc comment for the full picture).
 *  Reads a fresh `store.load()` rather than taking `p` as a parameter: both
 *  call sites are reached from contexts (a tab tap, a marker tap) that
 *  don't already have current state in scope. */
function recordMapCheckIfGuardian(): void {
  const self = session.currentSession()
  if (self && !self.dependant) friction.recordMapCheck(Math.floor(Date.now() / 1000))
}

/** Wires the generic click dispatcher onto every `[data-action]` node of
 *  freshly rendered markup. */
function wireActions(el: HTMLElement): void {
  el.querySelectorAll<HTMLElement>('[data-action]').forEach((node) => {
    node.addEventListener('click', () => handleAction(node))
  })
}

function render(): void {
  if (!root) return
  const p = store.load()
  // Pool-health seeds its staleness clock right before circles.ensure/
  // beacons.ensure below actually start using the shared relay pool (their
  // `subscribeGiftWraps` calls are what lazily builds it) and starts the
  // periodic staleness failsafe — identity-gated (nothing to recover for a
  // pool that isn't in use yet), idempotent like every ensure() here.
  if (session.currentSession()) poolHealth.ensure()
  // Plan 2, Task 8: automatic removal/hand-over/72h timeout — started once
  // per signed-in session, stopped on sign-out (store.clear() fires none of
  // its subscriptions on its own — see `stopTrustWatch`'s own doc comment).
  if (session.currentSession()) {
    if (!stopTrustWatch) {
      // Final review B, finding C1: claim the slot before calling.
      // trust-watch's own `start()` is now idempotent and defers its first
      // tick, but claiming this slot first is a second, cheap guard: were a
      // store write ever to re-enter `render()` synchronously from inside
      // `start()` again, it would already see a truthy `stopTrustWatch` and
      // not call `start()` a second time.
      stopTrustWatch = () => {}
      stopTrustWatch = trustWatch.start()
    }
  } else if (stopTrustWatch) {
    stopTrustWatch()
    stopTrustWatch = null
  }
  // Circles owns its personal-inbox gift-wrap subscription — kept live
  // whenever there's a signed-in identity, regardless of active tab, since
  // an invite/reseed/config sync can arrive while the user is elsewhere.
  // Unlike contacts.ensure() below, this never persists synchronously, so
  // there's nothing to bail the render pass for.
  //
  // Fix round 1, finding 4: called UNCONDITIONALLY, like nativeGeo.ensure
  // below — circles.ensure/beacons.ensure each self-gate on
  // `currentSession()` internally and tear their own subscriptions/timers
  // down when it's null (see their own `ensure()` doc comments). Gating the
  // CALL SITE on a session, as this used to do, meant that gate itself
  // never ran again once sign-out made the session null — so the very
  // render that should have torn everything down was the one render that
  // skipped calling ensure() at all, leaking the geo watch, emit timers and
  // inbox subscriptions past sign-out.
  circles.ensure(p)
  // Beacons owns the geo watch, per-circle emit timers, and per-circle inbox
  // subscriptions — same "always live regardless of tab" reasoning as
  // circles.ensure above: a beacon keeps ticking, and an inbound one keeps
  // updating the store, whichever screen is open. Also unconditional now,
  // same fix-round-1 finding-4 reasoning as circles.ensure just above.
  beacons.ensure(p)
  // Native background location (Task 9, brief §12/§29; review fix: watcher
  // lifecycle tied to sharing, not visibility): starts/stops the continuous
  // background watcher to match whether this device is currently "sharing"
  // (identity + at least one circle) — a no-op on web, and idempotent.
  // Deliberately NOT gated behind `if (session.currentSession())` here (unlike
  // circles.ensure/beacons.ensure above) — nativeGeo.ensure needs to see a
  // signed-out state too, so it actually stops the watcher rather than
  // leaving it running with nothing left to feed.
  nativeGeo.ensure(p)
  // Native socket bridge plan: starts/stops the foreground service (and the
  // sockets it keeps open) to match the same "sharing" gate as nativeGeo.ensure
  // just above — a no-op on web, and wherever the bridge never installed.
  nativeSocket.ensure(p)
  // Safety registers its incoming-signal handler with beacons.ts (routing
  // help/checkin/pickup traffic off the SAME circle-inbox subscription
  // beacons.ensure above just started, rather than opening a second one).
  // Idempotent and identity-independent — safe to call every render.
  safety.ensure()
  // Agreements registers its own incoming-signal handler alongside safety's
  // (beacons.ts's `setSignalHandler` appends rather than overwrites — see its
  // doc comment) and starts the 60s arrival/late-check timer. Also
  // idempotent and identity-independent.
  agreements.ensure()
  // Approvals registers its own incoming-signal handler the same way (family
  // policy sync + approval req/resp) — also idempotent and
  // identity-independent. circles.ts registers its own redo-on-approval
  // handlers from its own ensure() above, not here.
  approvals.ensure()
  // Messages registers its own incoming-signal/DM handlers the same way
  // (circle chat — a plain buzz signal, flock's real mechanism, see
  // messages.ts's own doc comment — plus person-to-person DMs via
  // circles.ts's personal inbox) — also idempotent and identity-independent.
  messages.ensure()
  // Plan 2, Task 7: in-person guardian-link pairing (the phone inbox's
  // `t:'link-pair'` handler and the link-posting hooks). Idempotent.
  linkPairing.ensure()
  // Pickup (Phase 4 Task 6) has no subscription of its own — its incoming
  // wire rides messages.ts's circle-chat buzz dispatch (registered just
  // above) — but DOES need one per-render nudge: the once-per-record
  // auto-'seen' send (task contract: "sent once when a device first renders
  // the card"). Cheap (filters `p.pickups`) and idempotent (persisted
  // `seenSent` guard), so safe to call on every pass, identity-gated since
  // there's nothing to send without one.
  pickup.ensureSeenSignals(p)
  // Milestones (Phase 6 Task 2) registers its own weekly step-up housekeeping
  // with places.ts's `tick()` (`places.registerPeriodicHook`) — called
  // BEFORE places.ensure() below so that registration is in place before
  // places.ensure()'s own immediate first `tick()` call runs. Idempotent and
  // identity-independent, same convention as every other domain module here.
  milestones.ensure()
  // Places registers its own incoming-signal handler the same way (fences +
  // this app's own places-metadata companion, plus breach receive) and
  // starts the child-side evaluation timer — also idempotent and
  // identity-independent.
  places.ensure()
  // Meet (Phase 4 Task 5, brief §6.6-6.7) registers its own incoming-signal
  // handler the same way (the `kindependence-meet` companion signal) and starts
  // a light countdown-refresh timer — also idempotent and
  // identity-independent.
  meet.ensure()
  // Pins (Phase 7 Task 4, design spec §4) registers its own incoming-signal
  // handler the same way (flock's `t:'pin'` companion signal) — also
  // idempotent and identity-independent, same convention as meet.ensure/
  // places.ensure above.
  pins.ensure()
  // Journey (Phase 5 Task 3, brief §32.2) registers beacons.ts's journey-
  // floor provider and starts its own light 30s auto-complete/expiry timer
  // — also idempotent and identity-independent, same convention as
  // places.ensure/meet.ensure above.
  journey.ensure()
  // Battery (Phase 3 Task 1) owns the 60s self-battery poll + per-circle emit
  // policy — identity-gated (mirrors beacons.ensure's own idiom, unlike the
  // identity-independent modules above), since there's nothing to poll/send
  // as without a signed-in identity.
  battery.ensure(p)
  // Widget (Phase 3 Task 6) owns the debounced push of the home-screen
  // widget's status payload to the WidgetBridge plugin — identity-independent
  // (an empty/self-only status is still worth pushing, e.g. right after
  // sign-out) and idempotent (subscribes to the store once, on its own).
  widget.ensure(p)
  // Signet identity plan, Task 11: no session yet (or the dependant
  // keep-running hint still showing, see its own doc comment) — checks for
  // an installed NIP-55 signer, then renders the sign-in screens in place
  // of the normal tab/nav shell entirely, same "short-circuit the whole
  // body" idiom as the chat overlay/wizard checks in `screenView`.
  // Device check 2026-09-27 + review follow-up: `renderInto` (form-state.ts)
  // skips the DOM write entirely when the markup is exactly what's already
  // there — the ~1s location re-render of a screen that doesn't show live
  // location no longer recreates a single node — and on a genuine re-render
  // keeps what the user typed.
  const keepUnfocused = actionEpoch.keepUnfocused()
  if (signin.shouldShow()) {
    signin.ensure()
    if (formState.renderInto(root, `<main class="screen">${signin.view(p)}</main>`, document.activeElement, keepUnfocused)) {
      wireActions(root)
    }
    signin.mountScanner()
    return
  }
  const replaced = formState.renderInto(root, `<main class="screen">${screenView(p)}</main>${navView(p)}`, document.activeElement, keepUnfocused)
  if (replaced) {
    wireActions(root)
    // The SOS button is long-press (pointerdown/up timing), not click — wired
    // separately from the generic dispatcher above (see safety.ts's `wireSos`
    // doc comment for why it isn't a `[data-action]` node at all). Called
    // unconditionally rather than gated to one tab: the button now renders on
    // BOTH Circles (inline, via safety.view) and Map (overlay, via
    // safety.sosButtonView) — wireSos just no-ops over whichever `[data-sos-hold]`
    // nodes (zero, one, or two) the active tab actually drew. Only on fresh
    // nodes: kept ones are already wired.
    safety.wireSos(root)
  }
  // The map lives inside #map-mount, a fresh element every render (root's
  // innerHTML was just replaced) — mountMap moves the SAME persistent
  // maplibre container node into it (rather than recreating MapView), so an
  // otherwise-expensive full map re-init doesn't happen on every beacon
  // update. See its own doc comment.
  if (tab === 'map') mountMap(p)
  if (tab === 'you') linkPairing.mountScanner()
}

// Phase 5 Task 4 review fix (§24.6): the You-tab "Clear routine history"
// two-tap confirm gate (activity.ts's own `clearRoutineConfirming`) must
// hold PER VISIT, not survive navigating away and back — arming it, then
// switching tabs (or doing literally anything else), must disarm it again.
// `handleAction` below is the single entry point every click in the app
// funnels through (see the delegated 'click' listener in `mount()`), so
// it's the one place that can see "some OTHER action just happened"
// regardless of which tab/module actually owns that action — resetting here
// for anything outside the gate's own three actions covers a plain tab
// switch (never itself routed to activity.ts's own `handleAction`) as well
// as any other button anywhere in the app.
const CLEAR_ROUTINE_CONFIRM_ACTIONS = new Set([
  'activity-clear-routine', 'activity-clear-routine-confirm', 'activity-clear-routine-cancel',
])

/** Noted on every user action; the next `render()` — whether or not it
 *  changes the DOM — starts unfocused fields afresh and consumes it
 *  (form-state.ts's `ActionEpoch`). */
const actionEpoch = new formState.ActionEpoch()

function handleAction(node: HTMLElement): void {
  actionEpoch.noteAction()
  const action = node.dataset.action
  if (action && !CLEAR_ROUTINE_CONFIRM_ACTIONS.has(action)) activity.resetClearRoutineConfirm()
  if (action === 'tab') {
    const next = node.dataset.tab as Tab | undefined
    // Task 2 (brief §6.5/§34.4): re-tapping the ALREADY-active Map tab is
    // the adaptive default view's reset control (no separate button) —
    // any other tap (a different tab, or Map from elsewhere) is a normal
    // switch; the one-time initial fit (`maybeInitialFit`) handles Map's
    // own first-arrival case on its own.
    if (next !== 'you') linkPairing.leave()
    if (next === 'map' && tab === 'map') resetMapView()
    else if (next) showTab(next)
  } else if (action && action.startsWith('signin-')) {
    signin.handleAction(action, node)
  } else if (action && action.startsWith('circle-')) {
    circles.handleAction(action, node)
  } else if (action && action.startsWith('contacts-')) {
    contactsView.handleAction(action, node)
  } else if (action && action.startsWith('link-')) {
    linkPairing.handleAction(action, node)
  } else if (action && action.startsWith('structural-queue-')) {
    structuralQueue.handleAction(action, node)
  } else if (action && action.startsWith('safety-')) {
    safety.handleAction(action, node)
  } else if (action && action.startsWith('friction-')) {
    friction.handleAction(action, node)
  } else if (action && action.startsWith('milestone-')) {
    milestones.handleAction(action, node)
  } else if (action && action.startsWith('wizard-')) {
    wizard.handleAction(action, node)
  } else if (action && action.startsWith('agreement-')) {
    agreements.handleAction(action, node)
  } else if (action && (action.startsWith('policy-') || action.startsWith('approval-'))) {
    approvals.handleAction(action, node)
  } else if (action && action.startsWith('activity-')) {
    activity.handleAction(action, node)
  } else if (action && action.startsWith('msg-')) {
    messages.handleAction(action, node)
  } else if (action && action.startsWith('pickup-')) {
    pickup.handleAction(action, node)
  } else if (action === 'map-circle-all') {
    store.update((p) => { p.settings = { ...p.settings, mapCircles: undefined } })
  } else if (action === 'map-circle-toggle') {
    const circleId = node.dataset.circle
    if (circleId) {
      store.update((p) => {
        const allIds = p.circles.map((c) => c.id)
        p.settings = { ...p.settings, mapCircles: mapinfo.toggleCircleSelection(allIds, p.settings.mapCircles, circleId) }
      })
    }
  } else if (action === 'map-sheet-close') {
    setSheetTarget(null)
    store.notify()
  } else if (action === 'cluster-sheet-close') {
    // Task 3 (brief §7.4): closes the cluster member sheet — same idiom as
    // `map-sheet-close` just above.
    setClusterSheet(null)
    store.notify()
  } else if (action === 'cluster-sheet-open-person') {
    // Task 3: tapping a row in the cluster sheet opens THAT member's own
    // person sheet (`setSheetTarget` closes the cluster sheet as a side
    // effect — see its own doc comment) — the brief's "tap cluster ->
    // member sheet -> tap person -> person details" chain.
    const pk = node.dataset.pk
    if (pk) { setSheetTarget(pk); store.notify() }
  } else if (action === 'map-sheet-navigate') {
    const pos = exportPositionFromDataset(node)
    if (pos) void doNavigate(navexport.buildExportTargets(pos))
  } else if (action === 'map-sheet-copy') {
    const pos = exportPositionFromDataset(node)
    if (pos) void doCopyLocation(navexport.buildExportTargets(pos))
  } else if (action === 'map-sheet-message') {
    // Task 5: wires the Task-3 stub — see `personSheetActions` below for why
    // this button only renders (non-disabled) when the sheet's target
    // shares at least one circle with this device.
    const pk = node.dataset.pk
    const circleId = node.dataset.circle
    if (pk && circleId) messages.openDmThread(pk, circleId)
  } else if (action === 'map-sheet-request-precise') {
    // Task 6: opens the reason picker (`preciseRequestFormView`) — see
    // `personSheetActions`'s own doc comment for why this button only
    // renders (non-disabled) when the sheet's target shares at least one
    // circle with this device, same gating as "Message".
    const pk = node.dataset.pk
    const circleId = node.dataset.circle
    if (pk && circleId) { preciseRequestState = { target: pk, circleId }; muteMenuTarget = null; store.notify() }
  } else if (action === 'map-sheet-request-precise-cancel') {
    preciseRequestState = null
    store.notify()
  } else if (action === 'map-sheet-request-precise-confirm') {
    void submitPreciseRequest()
  } else if (action === 'map-sheet-open') {
    // Task 2 (brief §9): the circle member list's own entry point into the
    // person sheet — a MUTED person's only remaining path back to Unmute
    // once their map marker is gone (mirrors `applyMapFocus`'s own
    // showTab-then-setSheetTarget sequencing for a cross-tab handoff).
    const pk = node.dataset.pk
    if (pk) { showTab('map'); setSheetTarget(pk); store.notify() }
  } else if (action === 'map-sheet-mute-open') {
    // Task 2: opens the Mute submenu (5 durations) inline in the sheet.
    const pk = node.dataset.pk
    if (pk) { muteMenuTarget = pk; preciseRequestState = null; store.notify() }
  } else if (action === 'map-sheet-mute-cancel') {
    muteMenuTarget = null
    store.notify()
  } else if (action === 'map-sheet-mute-set') {
    // Task 2: applies one of `mapinfo.MUTE_DURATIONS` — VIEWING preference
    // only, see `updateViewPref`'s own doc comment for the invariant this
    // upholds.
    const pk = node.dataset.pk
    const duration = mapinfo.MUTE_DURATIONS[Number(node.dataset.choice)]
    if (pk && duration) {
      const now = Math.floor(Date.now() / 1000)
      const until = mapinfo.muteUntil(duration.sec, now, new Date())
      updateViewPref(pk, (entry) => { entry.mutedUntil = until })
      muteMenuTarget = null
    }
  } else if (action === 'map-sheet-unmute') {
    const pk = node.dataset.pk
    if (pk) updateViewPref(pk, (entry) => { delete entry.mutedUntil })
  } else if (action === 'map-sheet-pin-toggle') {
    const pk = node.dataset.pk
    const currentlyOn = node.dataset.on === 'true'
    if (pk) updateViewPref(pk, (entry) => { if (currentlyOn) delete entry.pinned; else entry.pinned = true })
  } else if (action === 'privacy-baseline-set') {
    // Task 8: the You-tab per-circle baseline picker — applies immediately
    // (see `baselinePickerView`'s own doc comment), takes effect on that
    // circle's next emit tick.
    const circleId = node.dataset.circle
    const precision = Number(node.dataset.precision)
    if (circleId && (beacons.BASELINE_PRECISION_OPTIONS as readonly number[]).includes(precision)) {
      beacons.setCircleBaselinePrecision(circleId, precision)
    }
  } else if (action === 'battery-share-toggle') {
    // Phase 3 Task 1: the You-tab per-circle "share my battery" toggle —
    // applies immediately, same idiom as 'privacy-baseline-set' above.
    const circleId = node.dataset.circle
    const currentlyOn = node.dataset.on === 'true'
    if (circleId) battery.setShareBattery(circleId, !currentlyOn)
  } else if (action === 'battery-alerts-toggle') {
    // Phase 3 Task 2: the You-tab global "Low-battery alerts" toggle —
    // applies immediately, writing the INVERTED flag (see
    // `batteryAlertsToggleView`'s own doc comment).
    store.update((p) => {
      p.settings = { ...p.settings, batteryAlertsOff: !p.settings.batteryAlertsOff }
    })
  } else if (action === 'quiet-hours-toggle') {
    // Phase 5 Task 1 (brief §32.5): the You-tab "Quiet hours" enable
    // toggle — applies immediately, same idiom as 'battery-alerts-toggle'
    // just above, EXCEPT this flag is stored un-inverted (`aria-current` IS
    // `enabled`) and preserves whatever start/end window is already set (or
    // the same 22:00-07:00 pre-fill `quietHoursSectionView` displays) rather
    // than clobbering it.
    store.update((p) => {
      const qh = p.settings.quietHours ?? { enabled: false, start: QUIET_HOURS_DEFAULT_START, end: QUIET_HOURS_DEFAULT_END }
      p.settings = { ...p.settings, quietHours: { ...qh, enabled: !qh.enabled } }
    })
  } else if (action === 'quiet-hours-save') {
    submitQuietHoursForm()
  } else if (action === 'schedule-rule-add') {
    // Phase 5 Task 2 (brief §32.4): the You-tab per-circle sharing-schedule
    // editor's Add button — same "validate then write" split as
    // `submitQuietHoursForm`/places.ts's `submitWindowForm`.
    const circleId = node.dataset.circle
    if (circleId) submitScheduleRuleForm(circleId)
  } else if (action === 'schedule-rule-remove') {
    const circleId = node.dataset.circle
    const ruleId = node.dataset.rule
    if (circleId && ruleId) beacons.removeSharingScheduleRule(circleId, ruleId)
  } else if (action === 'places-add-here') {
    // Task 7: the "Add place here" button (see places.ts's own doc comment
    // for why this is a button reading the live MapView's centre, not a
    // long-press gesture) — only app.ts holds a reference to `liveMapView`,
    // so this one places-* action is handled inline rather than delegated.
    if (liveMapView) places.openPlaceForm(liveMapView.getCentre())
  } else if (action && action.startsWith('places-')) {
    places.handleAction(action, node)
  } else if (action === 'meet-add-here') {
    // Phase 4 Task 5: the "Add meeting point here" button — same
    // live-MapView-centre carve-out as `places-add-here` just above.
    if (liveMapView) meet.openMeetForm(liveMapView.getCentre())
  } else if (action && action.startsWith('meet-')) {
    meet.handleAction(action, node)
  } else if (action && action.startsWith('devices-')) {
    devices.handleAction(action, node)
  } else if (action === 'pins-add-here') {
    // Phase 7 Task 4: the "Drop a pin here" button — same live-MapView-
    // centre carve-out as `places-add-here`/`meet-add-here` just above.
    if (liveMapView) pins.openKindPicker(liveMapView.getCentre())
  } else if (action && action.startsWith('pins-')) {
    pins.handleAction(action, node)
  } else if (action === 'journey-form-open') {
    // Phase 5 Task 3: self sheet's "Start journey" — opens the dest picker
    // for this one circle (see `journeySectionView`'s own doc comment for
    // why journey-mode UI is inline in app.ts rather than delegated to
    // journey.ts's own view/handleAction, unlike places.ts/meet.ts: it needs
    // BOTH places.ts's and meet.ts's synced state at once for the picker).
    const circleId = node.dataset.circle
    if (circleId) openJourneyForm(circleId)
  } else if (action === 'journey-form-cancel') {
    closeJourneyForm()
  } else if (action === 'journey-form-submit') {
    const circleId = node.dataset.circle
    if (circleId) submitJourneyForm(circleId)
  } else if (action === 'journey-complete') {
    // "I'm there" — manual completion, per-dest buzz rules (see
    // journey.ts's `completeJourney` doc comment).
    const circleId = node.dataset.circle
    if (circleId) void journey.completeJourney(circleId)
  } else if (action === 'journey-cancel') {
    const circleId = node.dataset.circle
    if (circleId) journey.cancelJourney(circleId)
  }
}

/** Reads the `data-geohash`/`data-precision` pair `personSheetActions` bakes
 *  onto the Navigate/Copy location buttons at render time — see its own doc
 *  comment for why using the render-time snapshot (rather than re-deriving
 *  the merged position here) is both simpler and never stale: the whole
 *  sheet re-renders on every store change already (render-on-state), so
 *  these attributes are always current with whatever the sheet is showing
 *  right now. */
function exportPositionFromDataset(node: HTMLElement): navexport.ExportPosition | null {
  const geohash = node.dataset.geohash
  const precision = Number(node.dataset.precision)
  if (!geohash || !Number.isFinite(precision)) return null
  return { geohash, precision }
}

/** "Navigate" (Task 4, brief §18): hands off to the device's own maps app.
 *  Prefers `navigator.share` when available (the common mobile pattern —
 *  presents the native share sheet with every installed maps/messaging app,
 *  rather than forcing a specific one) with the first link-style target
 *  (`geo:` when offered — the precise branch only — else the approximate
 *  branch's plain Google Maps viewport link); falls back to `window.open`
 *  when `navigator.share` is unavailable/unsupported (most desktop
 *  browsers) or the user cancels/it rejects. */
async function doNavigate(t: navexport.ExportTargets): Promise<void> {
  const primary = t.targets.find((x) => x.id === 'geo') ?? t.targets.find((x) => x.id === 'google-maps')
  if (!primary?.url) return
  if (typeof navigator.share === 'function') {
    try {
      await navigator.share({ title: 'Location', text: primary.text, url: primary.url })
      return
    } catch {
      // User cancelled, or the platform rejected the share (e.g. no share
      // target installed) — window.open below is still a valid fallback.
    }
  }
  window.open(primary.url, '_blank', 'noopener')
}

/** "Copy location" (Task 4, brief §18): clipboard API when available;
 *  falls back to surfacing the copy-text itself as `navStatus` (rendered
 *  inline in the sheet, see `personSheetView`) so the user can select and
 *  copy it by hand when the Clipboard API is unavailable or denied (e.g. a
 *  non-secure context, or a permission prompt the user dismissed). Either
 *  way the text copied/shown is `navexport.ts`'s own `copy` target — never
 *  a link, never finer than the permitted precision (see that module's doc
 *  comment). */
async function doCopyLocation(t: navexport.ExportTargets): Promise<void> {
  const copy = t.targets.find((x) => x.id === 'copy')
  if (!copy) return
  try {
    if (!navigator.clipboard?.writeText) throw new Error('clipboard API unavailable')
    await navigator.clipboard.writeText(copy.text)
    navStatus = 'Copied to clipboard.'
  } catch {
    navStatus = `Couldn't copy automatically — select to copy: ${copy.text}`
  }
  store.notify()
}

function screenView(p: store.Persisted): string {
  // render() only calls this once `signin.shouldShow()` is false, i.e.
  // there IS a live session (Signet identity plan, Task 11) — still read
  // defensively rather than assert, so a future caller that forgets that
  // invariant degrades to the sign-in screen instead of throwing.
  const self = session.currentSession()
  if (!self) return signin.view(p)
  // The chat overlay (Task 5, brief §23.4) short-circuits whichever tab is
  // active — same "modal state wins over the normal tab body" idiom as
  // circles.ts's own `pendingInvite` — so it's reachable/closeable from
  // wherever it was opened (the Map tab's person sheet, or a Circles-tab
  // member/circle row) without a tab switch of its own.
  if (messages.isOpen()) return messages.view(p, self)
  // Phase 6 Task 3: the age-based setup wizard is a full-screen step flow,
  // same "modal state wins over the tab body" idiom as the chat overlay just
  // above — reachable from either of its two entry points (the onboarding
  // "set up each child's device" screen, or a Circles-tab child member row)
  // without a tab switch of its own.
  if (wizard.isOpen()) return wizard.view(p, self)
  switch (tab) {
    case 'map': return mapView(p)
    case 'circles': return circlesView(p)
    case 'activity': return activity.view(p)
    case 'you': return youView(p)
  }
}

// Circles tab (Task 12; Signet identity plan Task 11 dropped the local
// onboarding chooser that used to gate this tab — signin.ts's own screens,
// short-circuited from render() before screenView ever runs, are the ONLY
// sign-in flow now). Once signed in it's the safety controls + approvals +
// agreements + circle list, unchanged. The SOS button (top of `safety.view`)
// stays here per the task contract ("keep it on the Circles tab top") in
// addition to its Map-tab overlay.
function circlesView(p: store.Persisted): string {
  const self = session.currentSession()
  if (!self) return signin.view(p)
  return signedInCirclesView(p, self)
}

// Task 10 polish note: the pre-phase-2 "Home" screen carried the
// `<h1 class="wordmark">kindependence</h1>` masthead — Task 1's nav
// restructure dropped it here in favour of a plain `<h1>Circles</h1>`,
// same as the Map/Activity/You tabs' own bare `<h1>{Tab name}</h1>`.
// Deliberately NOT restored: the four tabs are peers now (brief §5/§24.2),
// and putting the wordmark back on just this one would break that parity
// (two stacked h1s here, one everywhere else) without a matching design
// pass across all four. Branding shows on signin.ts's own welcome screen
// and in the browser tab/manifest title instead.
function signedInCirclesView(p: store.Persisted, fam: SessionInfo): string {
  return `
    <h1>Circles</h1>
    ${contactsView.bannerView()}
    ${contactsView.promptsView()}
    ${safety.view(p, fam)}
    ${circles.inboxWaitingView()}
    ${structuralQueue.view()}
    ${approvals.requestsView(p, fam)}
    ${agreements.view(p, fam)}
    ${places.view(p, fam)}
    ${circles.view(p)}
  `
}

// ---------------------------------------------------------------------------

function inputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? ''
}

// ---------------------------------------------------------------------------
// Map tab (Task 14; multi-circle selector + approximate areas + person sheet
// added Task 3, brief §6.3/§7.1-7.2/§8)
//
// maplibre-gl is loaded lazily (see `ensureLiveMapView`'s dynamic import) and
// its container is a single persistent DOM node (`mapContainerEl`) re-parented
// into a fresh `#map-mount` on every render, rather than recreated — see the
// call site's doc comment in `render()`.
//
// Phase-2: the SOS button is kept globally reachable (brief §17.1) by also
// rendering here — `.map-top-overlay` is a sibling of `#map-mount` inside a
// `.map-wrap` positioning context, NOT a child of `.map-canvas` itself, so it
// falls outside the `.map-canvas > div { position: absolute; inset: 0 }` rule
// that fills the map container (styles.css) and doesn't need to fight it for
// placement. Shown whenever an identity exists, even before a circle does —
// same "harmless no-op with nothing to alert" reasoning safety.ts's
// `triggerSos` already documents for the Circles tab's copy of this button.
//
// Task 3's circle multi-selector (brief §6.3) is VISIBILITY only — it
// filters which already-received positions this device draws, never what a
// beacon discloses or who's permitted to see it (mapinfo.ts's
// `resolveCircleSelection` doc comment). Its selection is store-persisted
// (`Persisted.settings.mapCircles`); the person sheet's own open/closed
// state (`sheetTarget` below) deliberately is NOT — same "ephemeral UI
// state, not app data" reasoning as `onboarding`/`mapFocus`.
// ---------------------------------------------------------------------------

let liveMapView: MapView | null = null
let mapContainerEl: HTMLDivElement | null = null
let mapViewPromise: Promise<void> | null = null

/** The currently-open person sheet's target: a member pubkey,
 *  mapinfo.ts's `SELF_SHEET_TARGET` sentinel for the self marker, or `null`
 *  when closed. Set by a marker/area tap (the `onSelect` callback passed to
 *  `MapView` below) or by `applyMapFocus` when an Activity deep link
 *  resolves to a specific person; cleared by the sheet's own close button
 *  or by leaving the Map tab (`showTab`). Always go through `setSheetTarget`
 *  (never assign directly) so `navStatus` can't outlive the sheet it was
 *  shown on. */
let sheetTarget: string | null = null

/** The currently-open cluster member sheet's members (Task 3, brief §7.4),
 *  or `null` when closed — set by a cluster badge tap (the `onClusterSelect`
 *  callback passed to `MapView` below), cleared by the sheet's own close
 *  button, by leaving the Map tab (`showTab`, via `setSheetTarget`), or by
 *  tapping a member row (which opens THAT person's sheet instead — see
 *  `setClusterSheet`/`setSheetTarget`, mutually exclusive with each other
 *  the same way `preciseRequestState`/`muteMenuTarget` are ephemeral,
 *  cleared-on-target-change UI state, never persisted). */
let clusterSheetMembers: string[] | null = null

/** Result of the most recent "Copy location" tap on the currently-open
 *  person sheet (Task 4, brief §18) — "Copied to clipboard." on success, or
 *  the copy-text itself as a manual-copy fallback when the Clipboard API is
 *  unavailable/denied. Ephemeral UI state, same "not app data" reasoning as
 *  `sheetTarget` itself (store.ts doc comment) — never persisted, cleared
 *  whenever the sheet target changes so a stale status can't survive onto a
 *  different person's sheet. */
let navStatus: string | null = null

/** Whether the person sheet's Mute submenu (Task 2, brief §9 — 5 durations)
 *  is open, and for whom — `null` when closed. Same "ephemeral, cleared on
 *  target change" reasoning as `navStatus`/`preciseRequestState`. */
let muteMenuTarget: string | null = null

/** Clears the ephemeral per-sheet UI state shared by both the person sheet
 *  and the cluster sheet (`setSheetTarget`/`setClusterSheet` below) — split
 *  out so each setter can clear it WITHOUT also clobbering the very field
 *  the other setter is about to assign (a plain "clear everything" in both
 *  functions would otherwise race: `setClusterSheet` clearing
 *  `clusterSheetMembers` right after setting it, if it called
 *  `setSheetTarget(null)` for the shared cleanup instead of this). */
function clearMapSheetEphemeralState(): void {
  navStatus = null
  // A Task 6 reason-picker form open for a DIFFERENT (or no) target must not
  // survive onto whatever the sheet shows next — same "ephemeral, cleared on
  // target change" reasoning as `navStatus` above.
  preciseRequestState = null
  muteMenuTarget = null
}

function setSheetTarget(next: string | null): void {
  sheetTarget = next
  clusterSheetMembers = null // mutually exclusive with the cluster sheet — see its own doc comment
  meet.closeMeetSheet() // ...and with the meeting-point tap sheet (Phase 4 Task 5) — same reasoning
  pins.closePinSheet() // ...and with the dropped-pin tap sheet (Phase 7 Task 4) — same reasoning
  clearMapSheetEphemeralState()
  // Phase 6 Task 1 hook 2/2: opening a DEPENDANT's person sheet counts as a
  // map-check too (design spec §1) — a guardian tapping straight into
  // "where's Sam right now" is the exact compulsive-checking behaviour this
  // feature nudges against, even without a fresh Map-tab activation.
  // `mapinfo.SELF_SHEET_TARGET` (the self sheet) is deliberately excluded —
  // checking your OWN sharing state isn't "checking up on a dependant".
  if (next && next !== mapinfo.SELF_SHEET_TARGET) recordDependantMapCheck(next)
}

/** Phase 6 Task 1 hook 2/2's own gate: `targetPk` counts only when THIS
 *  device is a guardian AND `targetPk` is a child in some circle they
 *  share — "dependant = selfRole guardian && target role child" (task
 *  contract), reusing circles.ts's own `selfRole` rather than a new role
 *  check. Reads a fresh `store.load()` for the same reason
 *  `recordMapCheckIfGuardian` does: `setSheetTarget`'s callers (a marker
 *  tap, a cluster-sheet row tap, an Activity deep link) don't already have
 *  current state in scope. */
function recordDependantMapCheck(targetPk: string): void {
  const p = store.load()
  const fam = session.currentSession()
  if (!fam || fam.dependant) return
  const isDependant = p.circles.some((c) => circles.selfRole(c, fam.identityPk) === 'guardian' && circles.selfRole(c, targetPk) === 'child')
  if (isDependant) friction.recordMapCheck(Math.floor(Date.now() / 1000))
}

/** Opens (or, with `null`, closes) the cluster member sheet (Task 3, brief
 *  §7.4) — mutually exclusive with the person sheet, same as
 *  `setSheetTarget` closes this one. */
function setClusterSheet(members: string[] | null): void {
  clusterSheetMembers = members
  sheetTarget = null
  meet.closeMeetSheet() // mutually exclusive with the meeting-point tap sheet too
  pins.closePinSheet() // ...and with the dropped-pin tap sheet (Phase 7 Task 4) too
  clearMapSheetEphemeralState()
}

/** Mutates `p.viewPrefs[pk]` via `patch` (a "set/clear some fields"
 *  callback), then drops the whole per-pk entry once it's left with
 *  neither `mutedUntil` nor `pinned` set — same "presence, not a false-y
 *  value, means something happened" tidiness `store.ts`'s
 *  `arrivalWindowMarks` doc comment already documents elsewhere in this
 *  app. This is the ONLY write path for `Persisted.viewPrefs` (Task 2's
 *  Mute-set/Unmute/Pin-toggle handlers all funnel through it) — a VIEWING
 *  preference only, see `store.ts`'s own doc comment on that field for the
 *  hard invariant: nothing here touches `p.circles`, any signal/wire path,
 *  or any other field `notify.ts`/`safety.ts`/`places.ts`'s escalation
 *  path might read. */
function updateViewPref(pk: string, patch: (entry: { mutedUntil?: number; pinned?: true }) => void): void {
  store.update((p) => {
    const entry: { mutedUntil?: number; pinned?: true } = { ...p.viewPrefs[pk] }
    patch(entry)
    const next = { ...p.viewPrefs }
    if (entry.mutedUntil === undefined && !entry.pinned) delete next[pk]
    else next[pk] = entry
    p.viewPrefs = next
  })
}

function mapView(p: store.Persisted): string {
  const fam = session.currentSession()
  if (!fam) return `<h1>Map</h1><p class="muted">Sign in to see the map.</p>`
  if (!p.circles.length) {
    return `<h1>Map</h1><p class="muted">Create or join a circle to see everyone on the map.</p>${safety.sosButtonView()}`
  }
  const selectedIds = mapinfo.resolveCircleSelection(p.circles.map((c) => c.id), p.settings.mapCircles)
  const selectedCircles = p.circles.filter((c) => selectedIds.has(c.id))
  // Task 7 (brief §13): the private child-first escalation banner (never
  // shown on a guardian's device — see places.ts's own module doc comment)
  // and the guardian-only "Add place here" button both live in the map's
  // top overlay, alongside the existing circle selector/SOS button.
  const banner = places.escalationBannerView(p)
  // Phase 6 Task 1 (design spec §1): the map-check friction card is the
  // guardian-side mirror of the escalation banner above — private, and
  // gated to `!fam.dependant` here (defense-in-depth: `friction.
  // view`'s own gating already relies on `mapChecks` only ever having been
  // incremented on a guardian device — see this file's `recordMapCheckIf
  // Guardian`/`recordDependantMapCheck` — but a child device must NEVER
  // render this card even in principle, per the task's hard "invisible to
  // the child" rule).
  const frictionCard = !fam.dependant ? friction.view(p, Math.floor(Date.now() / 1000)) : ''
  const overlay = `
    <div class="map-top-overlay">
      ${circleSelectorView(p.circles, selectedIds)}
      ${banner ? `<div class="map-escalation-overlay">${banner}</div>` : ''}
      ${frictionCard}
      <div class="map-sos-overlay">${safety.sosButtonView()}${places.mapOverlayView(p, fam)}${meet.mapOverlayView(p)}${pins.mapOverlayView(p)}</div>
    </div>`
  const sheet = sheetTarget ? personSheetView(p, fam, selectedCircles, sheetTarget) : ''
  // Task 3 (brief §7.4): the cluster member sheet — mutually exclusive with
  // `sheet` above (`setSheetTarget`/`setClusterSheet` each clear the
  // other's state), so at most one of the two ever renders.
  const clusterSheet = clusterSheetMembers ? clusterSheetView(p, selectedCircles, clusterSheetMembers) : ''
  const placeForm = places.placeFormView(p, fam)
  // Phase 4 Task 5: the meeting-point create form and tap sheet — both
  // self-guard to `''` when closed (same idiom as `placeForm`), and are
  // mutually exclusive with `sheet`/`clusterSheet` (see `setSheetTarget`/
  // `setClusterSheet`'s own `meet.closeMeetSheet()` calls).
  const meetForm = meet.formView(p)
  const meetSheet = meet.sheetView(p)
  // Phase 7 Task 4: the pin kind-picker and tap sheet — same self-guarding-
  // to-`''`-when-closed idiom as `meetForm`/`meetSheet`, and mutually
  // exclusive with `sheet`/`clusterSheet`/the meet sheet (see
  // `setSheetTarget`'s/`setClusterSheet`'s own `pins.closePinSheet()` calls).
  const pinPicker = pins.kindPickerView(p)
  const pinSheet = pins.sheetView(p)
  return `<div class="map-wrap"><div id="map-mount" class="map-canvas"></div>${overlay}${sheet}${clusterSheet}${placeForm}${meetForm}${meetSheet}${pinPicker}${pinSheet}</div>`
}

/** The circle multi-selector chip row (brief §6.3, simplified per the task
 *  contract to "All" + one chip per circle rather than a checkbox flyout).
 *  `selected` is the already-resolved effective set (see `mapView`) —
 *  handing that straight to `circleSelectorLabel` is equally correct
 *  (mapinfo.ts's `resolveCircleSelection` is idempotent over its own
 *  output), so there's one selection computation per render, not two. */
function circleSelectorView(circles: Circle[], selected: ReadonlySet<string>): string {
  const label = mapinfo.circleSelectorLabel(circles, [...selected])
  const allActive = selected.size === circles.length
  const chips = circles
    .map((c) => `<button type="button" class="map-chip" data-action="map-circle-toggle" data-circle="${esc(c.id)}" aria-current="${selected.has(c.id)}">${esc(c.name)}</button>`)
    .join('')
  return `
    <div class="map-selector">
      <span class="map-selector-label">${esc(label)}</span>
      <div class="map-selector-chips">
        <button type="button" class="map-chip" data-action="map-circle-all" aria-current="${allActive}">All</button>
        ${chips}
      </div>
    </div>`
}

function mountMap(p: store.Persisted): void {
  if (!session.currentSession() || !p.circles.length) return
  const mount = document.getElementById('map-mount')
  if (!mount) return
  if (!mapContainerEl) {
    mapContainerEl = document.createElement('div')
    mapContainerEl.id = 'map'
  }
  if (mapContainerEl.parentElement !== mount) mount.appendChild(mapContainerEl)
  const selectedIds = mapinfo.resolveCircleSelection(p.circles.map((c) => c.id), p.settings.mapCircles)
  const selectedCircles = p.circles.filter((c) => selectedIds.has(c.id))
  void ensureLiveMapView(mapContainerEl, p, selectedCircles)
}

async function ensureLiveMapView(container: HTMLDivElement, p: store.Persisted, selectedCircles: Circle[]): Promise<void> {
  if (!liveMapView) {
    mapViewPromise ??= (async () => {
      const { MapView: MapViewCtor } = await import('./map.js') // lazy — keeps maplibre out of the main bundle
      const self = beacons.selfFix()
      liveMapView = new MapViewCtor(container, self ? { lat: self.lat, lon: self.lon } : undefined, (pubkey) => {
        setSheetTarget(pubkey)
        store.notify()
      }, (memberPks) => {
        // Task 3 (brief §7.4): a cluster badge tap — opens the member sheet
        // directly (brief §34.8's confirmed interaction), not a zoom-in.
        setClusterSheet(memberPks)
        store.notify()
      }, (id) => {
        // Phase 4 Task 5 (brief §6.6-6.7): a meeting-point flag tap — opens
        // meet.ts's own tap sheet, mutually exclusive with the person/
        // cluster sheets (`setSheetTarget(null)` already clears
        // `clusterSheetMembers` too — see its own doc comment).
        setSheetTarget(null)
        meet.openMeetSheet(id)
        store.notify()
      }, (id) => {
        // Phase 7 Task 4 (design spec §4): a dropped-pin glyph tap — opens
        // pins.ts's own tap sheet, same mutual-exclusivity idiom as the
        // meeting-point branch just above.
        setSheetTarget(null)
        pins.openPinSheet(id)
        store.notify()
      })
    })()
    await mapViewPromise
    requestAnimationFrame(() => liveMapView?.resize())
  }
  updateMapLayers(p, selectedCircles)
}

/** Splits every selected circle's merged member positions (beacons.ts's
 *  `mergeMemberPositions` — Task 3, brief §6.4's non-concern documented
 *  there) into precise markers vs. approximate areas (brief §7.2: precision
 *  >= 9 is a marker, anything coarser is an area, never a pin), redraws
 *  both, and hands the merged map + self fix to `applyMapFocus`. A MUTED
 *  person (Task 2, brief §9) gets neither a marker nor an area — `continue`
 *  skips them before either branch — but they're still IN `merged` for
 *  every other reader of it (nothing here touches sharing/permissions,
 *  only what this device chooses to draw). Also builds Task 4's off-screen
 *  edge-chip candidates (brief §7.5-7.6) from this SAME loop — a marker/area
 *  representative's `lat`/`lon` is decoded once and reused for whichever of
 *  `points`/`areas`/`edgeCandidates` it's eligible for, rather than
 *  re-decoding the same geohash three times. */
function updateMapLayers(p: store.Persisted, selectedCircles: Circle[]): void {
  if (!liveMapView) return
  const now = Math.floor(Date.now() / 1000)
  const merged = beacons.mergeMemberPositions(selectedCircles, beacons.memberPositions)
  // Final-review fix 3: a circle inbox is shared, so this device's own
  // beacon publish is delivered back to its own subscription — `merged` can
  // legitimately contain a self-echo entry. Dropped here, once, rather than
  // filtered per-consumer, because `merged` (this same Map reference) feeds
  // every downstream reader below: the points/areas/edge-candidate loop, and
  // `maybeInitialFit`/`applyMapFocus` further down. Left in, self would draw
  // its own duplicate marker, could get absorbed into a cluster badge, get
  // an edge chip pointing at itself, and double-count in `fitSet` (which
  // already adds `self` separately — see `computeFitSet`). Same self-filter
  // widget.ts already applies to this exact `mergeMemberPositions` output
  // (`entry.pubkey === selfPk`). This does NOT touch the dedicated self
  // person-sheet path: `applyMapFocus`'s own-pubkey branch and map.ts's
  // `setSelf` marker both key off `mapinfo.SELF_SHEET_TARGET`/`self` (the
  // live fix), never off `merged`.
  const selfForMerge = session.currentSession()
  if (selfForMerge) merged.delete(selfForMerge.identityPk)
  const points: MapPoint[] = []
  const areas: MapArea[] = []
  const edgeCandidates: EdgeCandidate[] = []
  for (const [pk, entry] of merged) {
    if (mapinfo.isMuted(p.viewPrefs, pk, now)) continue
    const name = memberNameIn(selectedCircles, pk)
    const { lat, lon } = decodeGeohash(entry.pos.geohash)
    if (mapinfo.isPrecise(entry.pos.precision)) {
      points.push({ pubkey: pk, lat, lon, label: `${name} · ${ageLabel(entry.pos.at, now)}` })
    } else {
      areas.push({ pubkey: pk, geohash: entry.pos.geohash, label: `${name} · ${mapinfo.precisionTerm(entry.pos.precision)}` })
    }
    // Task 4 (brief §7.5): only live/recent (or their approximate variants)
    // get an edge chip — §7.5 is about where people ARE right now, not a
    // stale/no-recent-update/hidden position that may no longer be true.
    const state = mapinfo.availabilityState({ precision: entry.pos.precision, at: entry.pos.at }, now)
    if (state === 'live' || state === 'approximate-live' || state === 'recent' || state === 'approximate-recent') {
      edgeCandidates.push({
        pubkey: pk,
        lat,
        lon,
        initial: (name.trim().charAt(0) || '?').toUpperCase(),
        pinned: p.viewPrefs[pk]?.pinned === true,
      })
    }
  }
  liveMapView.setMembers(points)
  liveMapView.setAreas(areas)
  // Task 7 (brief §13, deliverable 4): every selected circle's safe places,
  // drawn as labelled circles distinct from the position areas above.
  const mapPlaces: MapPlace[] = selectedCircles.flatMap((c) =>
    (p.places[c.id] ?? []).map((pl) => ({ id: pl.id, name: pl.name, centre: pl.centre, radiusMetres: pl.radiusMetres })),
  )
  liveMapView.setPlaces(mapPlaces)
  // Phase 4 Task 5 (brief §6.6-6.7): every selected circle's LIVE (not yet
  // expired) meeting points, drawn as flag markers distinct from both the
  // position areas and the safe-place circles above.
  const nowMeetSec = Math.floor(Date.now() / 1000)
  const mapMeetPoints: MapMeetPoint[] = selectedCircles.flatMap((c) =>
    meet.liveMeetPoints(p.meetPoints[c.id] ?? [], nowMeetSec).map((pt) => ({ id: pt.id, name: pt.name, centre: pt.centre })),
  )
  liveMapView.setMeetPoints(mapMeetPoints)
  // Phase 7 Task 4 (design spec §4): every selected circle's LIVE (not
  // removed) flock-interoperable dropped pins — glyph chips, distinct from
  // both the meeting-point flags and the safe-place circles above; the
  // glyph itself is resolved from pins.ts's own provider-fixed vocabulary
  // table (`PIN_KINDS`), never wire-derived free text.
  const mapDroppedPins: MapDroppedPin[] = selectedCircles.flatMap((c) =>
    (p.pins[c.id] ?? [])
      .filter((pin) => !pin.removed)
      .map((pin) => ({ id: pin.id, glyph: pins.PIN_KINDS[pin.kind].glyph, centre: decodeGeohash(pin.geohash) })),
  )
  liveMapView.setDroppedPins(mapDroppedPins)
  const self = beacons.selfFix()
  liveMapView.setSelf(self ? { lat: self.lat, lon: self.lon } : null)
  liveMapView.setEdgeCandidates(edgeCandidates)
  // Task 2 (brief §6.5): the ONE-TIME initial adaptive fit, only while a
  // deep-link focus isn't about to move the camera itself (`applyMapFocus`
  // right below takes priority whenever both happen to be pending on the
  // very same render).
  if (!mapFocus) maybeInitialFit(p, merged, self)
  applyMapFocus(merged, self)
}

/** Whether the Map tab's one-time adaptive initial fit (brief §6.5) has
 *  already happened this session — module-level, same "this session" scope
 *  as `map.ts`'s own `userMoved` (see its doc comment): reset only by a
 *  page reload, not by re-visiting the Map tab or a circle-selector change.
 *  Distinct from `userMoved` itself — this flag exists so the initial fit
 *  fires EXACTLY ONCE (the first render where at least one position is
 *  available), rather than re-fitting on every subsequent position update
 *  for as long as the user happens not to have panned yet. */
let initialFitDone = false

/** Performs the brief §6.5 initial fit exactly once — the first time this
 *  render has at least one point to fit to, provided the user hasn't
 *  already taken control of the viewport (`hasUserMoved`). No-op every
 *  time after (whether because it already ran, or because there's still
 *  nothing to fit to yet, e.g. before the first beacon arrives). */
function maybeInitialFit(p: store.Persisted, merged: ReadonlyMap<string, beacons.MergedPersonPosition>, self: ReturnType<typeof beacons.selfFix>): void {
  if (!liveMapView || initialFitDone || liveMapView.hasUserMoved()) return
  const set = computeFitSet(p, merged, self)
  if (set.length === 0) return
  liveMapView.fitToSet(set)
  initialFitDone = true
}

/** `mapinfo.fitSet`'s inputs, assembled from this device's own live reads
 *  (merged positions decoded to centre lat/lon — precise or approximate
 *  alike; unlike `applyMapFocus`'s single-target `fitToCell`, which fits to
 *  a cell's own full bounds, a bulk multi-person fit only needs a
 *  representative point per person, so the geohash centre is the pragmatic
 *  choice here) — shared by `maybeInitialFit` above and `resetMapView`
 *  below so the two triggers can never compute the fit set differently. */
function computeFitSet(p: store.Persisted, merged: ReadonlyMap<string, beacons.MergedPersonPosition>, self: ReturnType<typeof beacons.selfFix>): Array<{ lat: number; lon: number }> {
  const now = Math.floor(Date.now() / 1000)
  const people = [...merged].map(([pk, entry]) => {
    const { lat, lon } = decodeGeohash(entry.pos.geohash)
    return { pk, lat, lon }
  })
  const selfPos = self ? { lat: self.lat, lon: self.lon } : null
  return mapinfo.fitSet(people, p.viewPrefs, selfPos, now)
}

/** The Map tab's own reset control (brief §6.5/§34.4: re-tapping the
 *  ALREADY-active Map tab, not a separate button — see `handleAction`'s
 *  `'tab'` branch, the only call site) — re-fits the viewport to
 *  `mapinfo.fitSet`'s current result unconditionally, even after the user
 *  has panned away (that's the whole point of an explicit reset: it
 *  overrides whatever `map.ts`'s `userMoved` otherwise silently respects).
 *  No-op before the map has ever loaded, or with nothing to fit to yet. */
function resetMapView(): void {
  if (!liveMapView) return
  const p = store.load()
  const selectedIds = mapinfo.resolveCircleSelection(p.circles.map((c) => c.id), p.settings.mapCircles)
  const selectedCircles = p.circles.filter((c) => selectedIds.has(c.id))
  const merged = beacons.mergeMemberPositions(selectedCircles, beacons.memberPositions)
  const self = beacons.selfFix()
  const set = computeFitSet(p, merged, self)
  if (set.length) liveMapView.fitToSet(set)
}

/** `pk`'s display name from whichever of `circles` it's a member of, or a
 *  shortened pubkey — same fallback as activity.ts's `resolveName`, scoped
 *  to just the circles currently being rendered (unlike that function, this
 *  never touches the rolodex — a map pin only ever represents a circle
 *  member, never an arbitrary contact). */
function memberNameIn(circles: Circle[], pk: string): string {
  for (const c of circles) {
    const found = c.members.find((m) => m.pk === pk)?.name
    if (found) return found
  }
  return shortPk(pk)
}

/** Consumes a pending Activity deep-link focus (`mapFocus` below), one-shot:
 *  centres on the target's merged position if we have one — fitting to the
 *  cell's own bounds when it's approximate (brief §7.2; see `MapView.
 *  fitToCell`'s doc comment) or flying to the point when precise — or this
 *  device's own fix for a self-referencing link, else falls back to the
 *  event's own recorded geohash, else does nothing. Also opens the person
 *  sheet for whichever target it centred on: a deep link into "look at this
 *  person" naturally wants the same detail a tap would open, not just a
 *  re-centred map. Cleared either way — a target whose position never
 *  arrives isn't worth retrying forever against every subsequent position
 *  update. */
function applyMapFocus(merged: ReadonlyMap<string, beacons.MergedPersonPosition>, self: ReturnType<typeof beacons.selfFix>): void {
  if (!mapFocus || !liveMapView) return
  const focus = mapFocus
  mapFocus = null
  const fam = session.currentSession()
  if (focus.actorPk && fam && focus.actorPk === fam.identityPk && self) {
    liveMapView.flyTo({ lat: self.lat, lon: self.lon })
    setSheetTarget(mapinfo.SELF_SHEET_TARGET)
    store.notify()
    return
  }
  const entry = focus.actorPk ? merged.get(focus.actorPk) : undefined
  if (entry) {
    if (mapinfo.isPrecise(entry.pos.precision)) liveMapView.flyTo(decodeGeohash(entry.pos.geohash))
    else liveMapView.fitToCell(entry.pos.geohash)
    setSheetTarget(focus.actorPk ?? null)
    store.notify()
    return
  }
  if (focus.geohash) liveMapView.flyTo(decodeGeohash(focus.geohash))
}

/** The cluster member sheet (Task 3, brief §7.4) — opened by a cluster
 *  badge tap (`onClusterSelect`, `ensureLiveMapView`), listing every member
 *  the badge absorbed: avatar initial, name, and availability state (Task
 *  1's `availabilityLabelView` resolver, same one the person sheet itself
 *  uses just below — identical copy either way a member's state is
 *  surfaced). Tapping a row opens THAT member's person sheet
 *  (`cluster-sheet-open-person`, `handleAction`) — the brief's "tap cluster
 *  → member sheet → tap person → person details" chain (§34.8's confirmed
 *  "no zoom-first" interaction). `members` already excludes anyone muted
 *  (Task 2, brief §9) — `updateMapLayers` never builds a `ScreenPoint` for
 *  a muted person in the first place, so none can end up in a cluster's
 *  member list to begin with. */
function clusterSheetView(p: store.Persisted, selectedCircles: Circle[], members: string[]): string {
  const now = Math.floor(Date.now() / 1000)
  const merged = beacons.mergeMemberPositions(selectedCircles, beacons.memberPositions)
  const rows = members.map((pk) => {
    const name = memberNameIn(selectedCircles, pk)
    const memberCircles = p.circles.filter((c) => c.members.some((m) => m.pk === pk))
    const stateLabel = availabilityLabelView(p, pk, memberCircles, merged.get(pk)?.pos, now)
    const initial = (name.trim().charAt(0) || '?').toUpperCase()
    return `
      <li class="contact-item cluster-member" data-action="cluster-sheet-open-person" data-pk="${esc(pk)}">
        <span class="avatar-initial" aria-hidden="true">${esc(initial)}</span>
        <span class="cluster-member-info">
          <strong>${esc(name)}</strong>
          <span class="muted small">${esc(stateLabel)}</span>
        </span>
      </li>`
  }).join('')
  return `
    <div class="person-sheet cluster-sheet">
      <button type="button" class="sheet-close" data-action="cluster-sheet-close" aria-label="Close">✕</button>
      <h2>${esc(String(members.length))} people</h2>
      <ul class="contact-list">${rows}</ul>
    </div>`
}

/** The person sheet (brief §8): name, circle(s), precision term, last-update
 *  age, availability state, and action buttons — opened by a marker/area tap
 *  or an Activity deep link (`sheetTarget`, `applyMapFocus`), closed by its
 *  own close button or by leaving the Map tab. `target ===
 *  mapinfo.SELF_SHEET_TARGET` renders the self variant (own sharing state
 *  line, task contract) instead. */
function personSheetView(p: store.Persisted, fam: SessionInfo, selectedCircles: Circle[], target: string): string {
  if (target === mapinfo.SELF_SHEET_TARGET) return sheetWrap(selfSheetBody(p, fam))
  const now = Math.floor(Date.now() / 1000)
  const merged = beacons.mergeMemberPositions(selectedCircles, beacons.memberPositions)
  const entry = merged.get(target)
  // Circle names shown are every circle THIS DEVICE belongs to that the
  // target is also in — not just the currently-selected ones (the task
  // contract's "circle name(s)" is relationship context, independent of
  // the temporary visibility filter that happened to make this sheet
  // reachable right now).
  const memberCircles = p.circles.filter((c) => c.members.some((m) => m.pk === target))
  const name = memberCircles.map((c) => c.members.find((m) => m.pk === target)?.name).find((n): n is string => !!n) ?? shortPk(target)
  const circleNames = memberCircles.map((c) => c.name).join(', ') || 'No shared circle'
  const term = mapinfo.precisionTerm(entry?.pos.precision ?? 0)
  const age = entry ? ageLabel(entry.pos.at, now) : 'No recent update'
  const stateLabel = availabilityLabelView(p, target, memberCircles, entry?.pos, now)
  // Built once here (not inside personSheetActions) so the inline
  // approximate-area note and the Navigate/Copy buttons' own `data-geohash`/
  // `data-precision` attributes are guaranteed to agree — both come from
  // this SAME `entry.pos`, the render's own snapshot (Task 4, brief §18).
  const exportInfo = entry ? navexport.buildExportTargets(entry.pos) : undefined
  const approximateNote = exportInfo?.approximate
    ? `<p class="approximate-note">${esc(exportInfo.note ?? '')}</p>`
    : ''
  const status = navStatus ? `<p class="nav-status" role="status">${esc(navStatus)}</p>` : ''
  // Task 6: the reason picker replaces nothing — it renders BELOW the normal
  // action row, so Cancel simply leaves the sheet as it already looked.
  const preciseForm = preciseRequestState?.target === target ? preciseRequestFormView(name) : ''
  // Task 2 (brief §9): a muted target's status row — "still full sheet
  // access via member lists" (store.ts's `viewPrefs` doc comment) means
  // this same sheet is how a muted person gets Unmuted once their map
  // marker is gone; shown ABOVE the action row (mirrors the battery/
  // approximate-note ordering: state first, actions after).
  const mutedUntil = p.viewPrefs[target]?.mutedUntil
  const mutedRow = mapinfo.isMuted(p.viewPrefs, target, now)
    ? `<p class="muted small">Muted${mutedUntil === undefined ? '' : ` · ${esc(mapinfo.muteRemainingLabel(mutedUntil, now))}`}</p>`
    : ''
  // Pickup lifecycle cards (Phase 4 Task 6, brief §17.2-17.3, §30) — every
  // record where `target` is either party (child or collector), same
  // `fam.dependant -> 'child'|'guardian'` mapping `pickup.performAction`
  // itself uses.
  const pickupCards = pickup.sectionView(p, pickup.cardsForPerson(p, target), fam.identityPk, fam.dependant ? 'child' : 'guardian')
  return sheetWrap(`
    <h2>${esc(name)}</h2>
    <p class="muted">${esc(circleNames)}</p>
    <p>${esc(term)} · ${esc(stateLabel)}</p>
    <p class="muted small">Last update: ${esc(age)}</p>
    ${batteryLineView(target, memberCircles, now)}
    ${approximateNote}
    ${mutedRow}
    <div class="sheet-actions">${personSheetActions(p, fam, memberCircles, target, entry?.pos)}</div>
    ${pickupCards}
    ${preciseForm}
    ${status}
  `)
}

/** Person sheet's availability line (Phase 4 Task 1, brief §10 — honest
 *  availability states): extends the base live/recent/no-recent-update/
 *  hidden tiers with three RECEIVER-derived states, each built only from
 *  data this device already holds — no new wire signal, no sender-side
 *  change (the "withhold is not a tell" hard constraint). Assembles a
 *  `mapinfo.AvailabilityInputs` from:
 *   - `battery.latestBatteryFor` across every circle this device shares
 *     with `target` (same freshness-agnostic read `batteryLineView` uses
 *     below — `availabilityStateFull` itself checks the reading's own
 *     age isn't the point here, only its value, so no separate staleness
 *     filter is applied before handing it in);
 *   - the FIRST active (acked/en-route) tracked agreement with `target`
 *     as its child, wherever it's found in `p.agreements` (not scoped to
 *     `memberCircles` — same "just find the active one" idiom as
 *     widget.ts's own `activeAgreementRecordFor`), fed through
 *     `agreements.nextOrCurrentRaise` for its next-or-current schedule
 *     raise. Baseline is passed as 0 rather than `target`'s own chosen
 *     per-circle baseline — this device never knows another member's OWN
 *     baseline choice (a personal, local-only, never-synced-to-the-wire
 *     setting — store.ts's `Persisted.settings` doc comment); 0 treats
 *     any step the held schedule promises as worth surfacing, which is
 *     what 'sharing-scheduled' is actually claiming ("a raise IS
 *     coming"), not "a raise above whatever baseline we'd have to guess
 *     for them" — same reasoning as widget.ts's `agreementRaiseFor`;
 *   - `everHeard`: whether `beacons.memberPositions` has ever carried an
 *     entry for `target` in ANY circle this device shares with them (not
 *     just the currently-selected map filter, same "relationship
 *     context, not the temporary filter" reasoning as `memberCircles`
 *     itself, a few lines up in `personSheetView`) — brief's "keep
 *     simple: positions-presence only" instruction. */
function availabilityLabelView(p: store.Persisted, target: string, memberCircles: Circle[], pos: beacons.MemberPosition | undefined, now: number): string {
  const everHeard = memberCircles.some((c) => beacons.memberPositions(c.id).has(target))
  const battReading = battery.latestBatteryFor(target, memberCircles.map((c) => c.id))
  const active = p.agreements.find((r) => r.agreement.child === target && (r.status === 'acked' || r.status === 'en-route'))
  const raise = active ? agreements.nextOrCurrentRaise(0, active.agreement.schedule, active.agreement.byUnix, now) : undefined
  const inputs: mapinfo.AvailabilityInputs = {
    pos,
    battery: battReading ? { pct: battReading.pct, charging: battReading.charging, at: battReading.at } : undefined,
    agreementRaise: raise ? { term: mapinfo.precisionTerm(raise.precision), atUnix: raise.atUnix } : undefined,
    everHeard,
  }
  const state = mapinfo.availabilityStateFull(inputs, now)
  const raiseTime = raise ? formatClockTime(raise.atUnix) : undefined
  return mapinfo.availabilityLabelFull(state, raiseTime ? { raiseTime } : undefined)
}

/** Person sheet's "Battery 45%" / "Battery 45% · charging" line (Phase 3
 *  Task 2, task contract) — rendered only when `target`'s freshest reading
 *  across every circle this device shares with them (`battery.latestBatteryFor`)
 *  is within `battery.BATTERY_FRESH_SEC`; no row at all otherwise (stale or
 *  never heard). `pct` is wire-derived (another device's own reading) —
 *  esc()'d per global-constraints.md §house-rules even though
 *  `parseBatterySignal` already constrains it to an integer 0-100. */
function batteryLineView(target: string, memberCircles: Circle[], now: number): string {
  const reading = battery.latestBatteryFor(target, memberCircles.map((c) => c.id))
  if (!reading || now - reading.at > battery.BATTERY_FRESH_SEC) return ''
  const charging = reading.charging ? ' · charging' : ''
  return `<p class="muted small">Battery ${esc(String(reading.pct))}%${charging}</p>`
}

/** Action buttons: "Request pickup" wires the EXISTING guardian->child
 *  handler (safety.ts's `data-action="safety-pickup"`, unchanged — its own
 *  guardian/child re-check still applies) whenever `fam` is a guardian of
 *  `target` in at least one shared circle; "Navigate"/"Copy location"
 *  (Task 4, brief §18) dispatch through `handleAction`'s own `map-sheet-
 *  navigate`/`map-sheet-copy` branches — disabled when there's no live
 *  `pos` to export (nothing to navigate to); "Message" (Task 5) opens a DM
 *  thread with `target`, in the context of the FIRST circle this device
 *  shares with them (messages.ts's `openDmThread` — see its own doc comment
 *  for why the DM's wire `circleId` field only needs SOME shared circle, not
 *  a specific one) — disabled when there is none. "Request precise
 *  location" (Task 6, brief §11.4-11.5) opens the reason picker
 *  (`preciseRequestFormView` below) — BOTH roles see it (no guardian gate,
 *  unlike "Request pickup": §11.5's two-way access), disabled only when
 *  there's no shared circle to carry the findreq/reason DM on, same gating
 *  as "Message" and for the same reason. "Mute"/"Unmute" and "Pin" (Task 2,
 *  brief §9) are the two VIEWING-preference controls — see
 *  `muteControlView` and `store.ts`'s `viewPrefs` doc comment for the hard
 *  "never touches sharing/safety/access" invariant both uphold. */
function personSheetActions(p: store.Persisted, fam: SessionInfo, memberCircles: Circle[], target: string, pos: beacons.MemberPosition | undefined): string {
  const pickupCircle = memberCircles.find((c) => circles.selfRole(c, fam.identityPk) === 'guardian' && c.members.find((m) => m.pk === target)?.role === 'child')
  const pickup = pickupCircle
    ? `<button type="button" data-action="safety-pickup" data-circle="${esc(pickupCircle.id)}" data-pk="${esc(target)}">Request pickup</button>`
    : ''
  // `data-geohash`/`data-precision` carry the render-time position straight
  // through to `handleAction` — see `exportPositionFromDataset`'s own doc
  // comment for why that's never stale.
  const exportAttrs = pos ? ` data-geohash="${esc(pos.geohash)}" data-precision="${esc(String(pos.precision))}"` : ''
  const nav = `<button type="button" data-action="map-sheet-navigate" data-pk="${esc(target)}"${exportAttrs}${pos ? '' : ' disabled'}>Navigate${pos ? '' : '<span class="coming-soon">No recent location</span>'}</button>`
  const copy = `<button type="button" data-action="map-sheet-copy" data-pk="${esc(target)}"${exportAttrs}${pos ? '' : ' disabled'}>Copy location${pos ? '' : '<span class="coming-soon">No recent location</span>'}</button>`
  const dmCircleId = memberCircles[0]?.id
  const message = dmCircleId
    ? `<button type="button" data-action="map-sheet-message" data-pk="${esc(target)}" data-circle="${esc(dmCircleId)}">Message</button>`
    : `<button type="button" data-action="map-sheet-message" data-pk="${esc(target)}" disabled>Message<span class="coming-soon">No shared circle</span></button>`
  const requestPrecise = dmCircleId
    ? `<button type="button" data-action="map-sheet-request-precise" data-pk="${esc(target)}" data-circle="${esc(dmCircleId)}">Request precise location</button>`
    : `<button type="button" data-action="map-sheet-request-precise" data-pk="${esc(target)}" disabled>Request precise location<span class="coming-soon">No shared circle</span></button>`
  return `
    ${pickup}
    ${nav}
    ${copy}
    ${message}
    ${requestPrecise}
    ${muteControlView(p, target)}
    ${pinToggleView(p, target)}
  `
}

/** Task 2 (brief §9): "Mute" opens the 5-duration submenu (`MUTE_DURATIONS`
 *  — `muteMenuTarget` ephemeral state, same idiom as the Task 6 reason
 *  picker's `preciseRequestState`); already-muted renders "Unmute" instead
 *  (the status row above already showed "Muted · …"). Pure VIEWING-
 *  preference toggle — `handleAction`'s `map-sheet-mute-*` branches are the
 *  only thing that ever writes `Persisted.viewPrefs`, via `updateViewPref`. */
function muteControlView(p: store.Persisted, target: string): string {
  const now = Math.floor(Date.now() / 1000)
  if (mapinfo.isMuted(p.viewPrefs, target, now)) {
    return `<button type="button" data-action="map-sheet-unmute" data-pk="${esc(target)}">Unmute</button>`
  }
  if (muteMenuTarget === target) {
    const options = mapinfo.MUTE_DURATIONS
      .map((d, i) => `<button type="button" data-action="map-sheet-mute-set" data-pk="${esc(target)}" data-choice="${i}">${esc(d.label)}</button>`)
      .join('')
    return `
      <div class="sheet-actions mute-menu">
        ${options}
        <button type="button" data-action="map-sheet-mute-cancel">Cancel</button>
      </div>`
  }
  return `<button type="button" data-action="map-sheet-mute-open" data-pk="${esc(target)}">Mute</button>`
}

/** Task 2 (brief §9): "Pin" toggle — constant label, `aria-current`/
 *  `data-on` carry the current state (same idiom as `batteryShareToggleView`
 *  below: a toggle's label never swaps text, only its highlighted state
 *  does — house convention, see that function's own doc comment). Pinning
 *  grants no new access; it only prioritises an already-visible position in
 *  `mapinfo.fitSet`'s output. */
function pinToggleView(p: store.Persisted, target: string): string {
  const pinned = p.viewPrefs[target]?.pinned === true
  return `<button type="button" data-action="map-sheet-pin-toggle" data-pk="${esc(target)}" data-on="${pinned}" aria-current="${pinned}">Pin</button>`
}

// ---------------------------------------------------------------------------
// Task 6 (brief §11.4-11.5, §2.3): the person sheet's "Request precise
// location" reason picker — a small inline form, same "module-level
// ephemeral UI state" idiom as `onboarding`/agreements.ts's `createState`.
// The actual reason category the user picked and any free text are read
// straight off the DOM at Confirm time (`submitPreciseRequest`), same
// uncontrolled-input idiom as safety.ts's `checkin-share-location` checkbox
// or messages.ts's `msg-text` composer — there is no need to track them in
// this state and re-render on every keystroke/radio click.
// ---------------------------------------------------------------------------

type PreciseReasonKind = 'emergency' | 'meeting' | 'worried'
const PRECISE_REASON_LABELS: Record<PreciseReasonKind, string> = {
  emergency: 'Emergency', meeting: 'Meeting you', worried: 'Worried',
}

/** Whether the reason picker is open, and for whom — `null` when closed.
 *  Cleared by `setSheetTarget` (so switching/closing the sheet always closes
 *  any open form too), by Cancel, and by a successful Confirm. */
let preciseRequestState: { target: string; circleId: string } | null = null

/** Composes the final declared-reason string sent on the wire: the picked
 *  category's label, plus an optional " — <free text>" suffix (task
 *  contract: "≤140 chars" — enforced again here as a defensive belt-and-
 *  braces measure; messages.ts's own `requestPreciseLocation` re-caps it a
 *  second time before it ever reaches the wire). Never empty — one of the
 *  three radio options is always checked (browser-enforced radio-group
 *  default), so "declare a reason" (task contract) can't be bypassed by
 *  submitting with nothing picked. */
function composePreciseReason(kind: PreciseReasonKind, freeText: string): string {
  const label = PRECISE_REASON_LABELS[kind]
  const detail = freeText.trim().slice(0, 140)
  return detail ? `${label} — ${detail}` : label
}

/** The reason picker itself — three quick-reason options plus optional free
 *  text, and the task contract's explicit discouragement copy ("This is
 *  recorded for everyone in the circle's activity") so the social-visibility
 *  mechanism (brief §2.3/§11.4) is disclosed UP FRONT, not just discovered
 *  after the fact in the Activity tab. */
function preciseRequestFormView(name: string): string {
  const options: Array<[PreciseReasonKind, string]> = [['emergency', 'Emergency'], ['meeting', 'Meeting you'], ['worried', 'Worried']]
  const radios = options
    .map(([kind, label], i) => `
      <label class="confirm-gate">
        <input type="radio" name="precise-reason-kind" value="${kind}"${i === 0 ? ' checked' : ''} />
        ${esc(label)}
      </label>`)
    .join('')
  return `
    <div class="precise-request-form">
      <h3>Request precise location</h3>
      <p class="muted small">Requesting ${esc(name)}'s exact location. This is recorded for everyone in the circle's activity.</p>
      ${radios}
      <input id="precise-reason-text" type="text" maxlength="140" placeholder="Add detail (optional)" />
      <div class="sheet-actions">
        <button type="button" data-action="map-sheet-request-precise-confirm">Send request</button>
        <button type="button" data-action="map-sheet-request-precise-cancel">Cancel</button>
      </div>
    </div>`
}

/** Reads the checked reason radio + free-text input (see the section doc
 *  comment above for why these are read live rather than tracked in
 *  `preciseRequestState`), composes the final reason, closes the form
 *  immediately (so the sheet doesn't sit mid-request), then sends — the
 *  same "clear state, notify, await, notify again with a status line"
 *  sequencing as `doCopyLocation`. */
async function submitPreciseRequest(): Promise<void> {
  if (!preciseRequestState) return
  const { target, circleId } = preciseRequestState
  const kindInput = document.querySelector<HTMLInputElement>('input[name="precise-reason-kind"]:checked')
  const kind = (kindInput?.value as PreciseReasonKind | undefined) ?? 'emergency'
  const freeText = inputValue('precise-reason-text')
  const reason = composePreciseReason(kind, freeText)
  formState.clearField('precise-reason-text') // submitted: the form starts afresh
  preciseRequestState = null
  navStatus = null
  store.notify()
  const ok = await messages.requestPreciseLocation(circleId, target, reason)
  navStatus = ok ? 'Precise location request sent.' : "Couldn't send the request — try again."
  store.notify()
}

/** 24h "HH:MM" clock time for a schedule/mode-line time — the one non-pure
 *  piece `agreements.ts`'s `agreementScheduleText`/`nextOrCurrentRaise` and
 *  `mapinfo.ts`'s `locationModeLine` deliberately push out to their callers
 *  (see those functions' own doc comments) rather than calling
 *  `toLocaleTimeString` themselves, so they stay clock-free and unit-testable
 *  with a fixed formatter. */
function formatClockTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** `secOfDay` (0-86399, `beacons.ts`'s `scheduledPrecision().until`) → 24h
 *  zero-padded `'HH:MM'` — the mode line's "until HH:MM" clause. Sibling to
 *  `formatClockTime` just above (that one formats a unix timestamp; this one
 *  formats a bare seconds-of-day, since a sharing-schedule rule's `until` is
 *  never tied to a specific calendar date — see `scheduledPrecision`'s own
 *  doc comment). */
function formatSecOfDay(sec: number): string {
  const hours = Math.floor(sec / 3600) % 24
  const minutes = Math.floor((sec % 3600) / 60)
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

/** One circle's location-mode line (Task 8, brief §12/§25): "Sharing
 *  Neighbourhood with Family." or, once an active agreement's schedule has
 *  raised (or is about to raise) disclosure above this circle's own
 *  baseline, "Sharing Neighbourhood with Family · Precise from 17:45." —
 *  or, Phase 5 Task 2 (brief §32.4), once a sharing-SCHEDULE rule (not an
 *  agreement) is the one currently setting the baseline, "Sharing Street
 *  with Family until 15:30." Shared by the self-marker sheet
 *  (`selfSheetBody`, one line per circle) and the You-tab privacy overview
 *  (`privacySummaryView`, one per row) — the one place that composes
 *  `beacons.ts`'s per-circle baseline, `agreements.ts`'s schedule lookup,
 *  and `mapinfo.ts`'s pure copy builder. `localNow` is read ONCE and reused
 *  for both the baseline lookup and the active-rule lookup so they can never
 *  disagree at a window boundary a few milliseconds apart; `places.localDay`
 *  is reused here rather than duplicated (unlike beacons.ts's own private
 *  `liveLocalDay`, which can't import places.ts at all — see that function's
 *  doc comment) since app.ts already imports `places` freely. An active
 *  schedule rule is only surfaced when there's no agreement raise to show
 *  instead — `mapinfo.locationModeLine`'s own doc comment explains why the
 *  two are never rendered together.
 *
 *  Phase 5 final-review fast-follow (§25 transparency): folds in
 *  `beacons.journeyFloorFor`/`applyJourneyFloor` at the SAME merge point
 *  `emitTick` itself sits at (beacons.ts: `scheduleBaseline` then
 *  `applyJourneyFloor(scheduleBaseline, journeyFloorFor(circleId))` BEFORE
 *  `basePrecisionFor` — see that function's own doc comment for the full
 *  order) — reusing the exact same exported helpers rather than
 *  re-deriving the merge here, so the wire's actual emitted precision and
 *  this display line can never drift apart. Previously this only read the
 *  schedule-aware baseline, so an active journey's floor (e.g. Street) was
 *  invisible here even while `emitTick` was already disclosing at it — the
 *  floored `baseline` also feeds `nextOrCurrentRaise` (not just
 *  `basePrecisionFor`), so a schedule raise that's finer than the journey
 *  floor still shows as a raise, exactly as `decideCadence`'s own
 *  agreement merge (strictly AFTER the journey floor, itself max-only)
 *  would never let the floor cap it either. */
function circleModeLine(p: store.Persisted, circle: Circle): string {
  const now = Math.floor(Date.now() / 1000)
  const localNow = places.localDay(new Date())
  const scheduleBaseline = beacons.circleBaselinePrecision(p.settings, circle.id, localNow)
  const baseline = beacons.applyJourneyFloor(scheduleBaseline, beacons.journeyFloorFor(circle.id))
  const baselineTerm = mapinfo.precisionTerm(beacons.basePrecisionFor(beacons.selfFix(), baseline))
  const agreement = beacons.activeAgreementFor(circle.id)
  const raise = agreement ? agreements.nextOrCurrentRaise(baseline, agreement.schedule, agreement.byUnix, now) : undefined
  const raiseInfo = raise ? { term: mapinfo.precisionTerm(raise.precision), whenLabel: formatClockTime(raise.atUnix) } : undefined
  const activeRule = raiseInfo ? null : beacons.scheduledPrecision(p.settings.sharingSchedules?.[circle.id], localNow)
  const activeRuleInfo = activeRule ? { untilLabel: formatSecOfDay(activeRule.until) } : undefined
  return mapinfo.locationModeLine(circle.name, baselineTerm, raiseInfo, activeRuleInfo)
}

/** Self-marker sheet body (task contract: "shows own sharing state line") —
 *  one `circleModeLine` per circle (Task 8 replaces the pre-Task-8 single-
 *  global-baseline simplification this comment used to describe: baseline is
 *  now genuinely per-circle, so a single combined sentence could no longer
 *  be accurate whenever two circles' baselines differ). Phase 5 Task 3
 *  (brief §32.2) adds one journey section per circle, right below its mode
 *  line — "Start journey" / the active-journey card / the dest-picker form
 *  (`journeySectionView` below), same "one row per circle" shape. */
function selfSheetBody(p: store.Persisted, fam: SessionInfo): string {
  const now = Math.floor(Date.now() / 1000)
  const lines = p.circles.map((c) => `<p class="muted">${esc(circleModeLine(p, c))}</p>${journeySectionView(p, c, now)}`).join('')
  return `<h2>${esc(fam.name)} (You)</h2>${lines || '<p class="muted">Not sharing with any circle yet.</p>'}`
}

// ---------------------------------------------------------------------------
// Phase 5 Task 3 (brief §32.2): journey mode — "Start journey" (dest picker:
// circle places, live meet points, or a free label; optional expected-by
// time) and the active-journey card ("I'm there"/"Cancel"), both rendered
// per-circle inside the self sheet (`selfSheetBody` above — a journey is
// about where THIS device is heading, so it only ever makes sense on one's
// own sheet, not another member's). Module-level ephemeral UI state for the
// form, same "uncontrolled inputs read at submit time" idiom as
// meet.ts's/places.ts's own inline forms (`journeyFormOpenFor`/
// `journeyFormError` mirror `preciseRequestState`'s "which target, if any"
// shape one level up).
// ---------------------------------------------------------------------------

let journeyFormOpenFor: string | null = null
let journeyFormError: string | null = null

function openJourneyForm(circleId: string): void {
  journeyFormOpenFor = circleId
  journeyFormError = null
  store.notify()
}

function closeJourneyForm(): void {
  journeyFormOpenFor = null
  journeyFormError = null
  store.notify()
}

/** One circle's journey section: the active-journey card when a journey is
 *  running, else the dest-picker form when it's open for THIS circle, else
 *  a plain "Start journey" button. */
function journeySectionView(p: store.Persisted, circle: Circle, now: number): string {
  const active = journey.activeJourney(p, circle.id)
  if (active) return activeJourneyCardView(circle, active, now)
  if (journeyFormOpenFor === circle.id) return journeyFormView(p, circle)
  return `<div class="sheet-actions"><button type="button" data-action="journey-form-open" data-circle="${esc(circle.id)}">Start journey</button></div>`
}

/** Active-journey card (task contract: "dest, elapsed, I'm there/Cancel").
 *  `dest.label` is free text (guardian/child-authored, or a synced place/
 *  meet-point name) — esc()'d per global-constraints.md, same discipline as
 *  every other wire-derived string rendered in this file. */
function activeJourneyCardView(circle: Circle, j: journey.Journey, now: number): string {
  const expected = j.expectedBy !== undefined ? ` · expected by ${esc(journey.formatExpectedBy(j.expectedBy))}` : ''
  return `
    <div class="place-form">
      <p>Heading to ${esc(j.dest.label)}${expected}</p>
      <p class="muted small">Started ${esc(ageLabel(j.startedAt, now))}</p>
      <div class="sheet-actions">
        <button type="button" data-action="journey-complete" data-circle="${esc(circle.id)}">I'm there</button>
        <button type="button" data-action="journey-cancel" data-circle="${esc(circle.id)}">Cancel</button>
      </div>
    </div>`
}

/** The dest picker — circle places, live meet points (meet.ts's own
 *  `liveMeetPoints` expiry filter, same as its own map overlay/tap sheet),
 *  and a free "Somewhere else…" label option, plus an optional expected-by
 *  time (a plain `<input type="time">`, resolved against TODAY at submit
 *  time — `resolveExpectedBy` below). */
function journeyFormView(p: store.Persisted, circle: Circle): string {
  const now = Math.floor(Date.now() / 1000)
  const circlePlaces = p.places[circle.id] ?? []
  const livePoints = meet.liveMeetPoints(p.meetPoints[circle.id] ?? [], now)
  const placeOptions = circlePlaces.map((pl) => `<option value="place:${esc(pl.id)}">${esc(pl.name)}</option>`).join('')
  const meetOptions = livePoints.map((pt) => `<option value="meet:${esc(pt.id)}">${esc(pt.name)}</option>`).join('')
  const err = journeyFormError ? `<p class="form-error">${esc(journeyFormError)}</p>` : ''
  return `
    <div class="place-form">
      <h3>Start a journey</h3>
      <select id="journey-dest">
        ${placeOptions}
        ${meetOptions}
        <option value="label">Somewhere else…</option>
      </select>
      <input id="journey-label" type="text" maxlength="${journey.JOURNEY_LABEL_MAX}" placeholder="Where are you heading?" />
      <input id="journey-expected-by" type="time" aria-label="Expected by (optional)" />
      ${err}
      <div class="sheet-actions">
        <button type="button" data-action="journey-form-submit" data-circle="${esc(circle.id)}">Start journey</button>
        <button type="button" data-action="journey-form-cancel">Cancel</button>
      </div>
    </div>`
}

/** `'HH:MM'` (a `<input type="time">` read) → today's absolute unix-seconds
 *  deadline, or `undefined` for a malformed/empty value — reuses places.ts's
 *  own strict `parseHHMM` (not duplicated), same idiom as `circleModeLine`'s
 *  own reuse one screen up. */
function resolveExpectedBy(hhmm: string): number | undefined {
  const parsed = places.parseHHMM(hhmm)
  if (parsed === null) return undefined
  const d = new Date()
  d.setHours(Math.floor(parsed / 3600), Math.floor((parsed % 3600) / 60), 0, 0)
  return Math.floor(d.getTime() / 1000)
}

/** Reads the dest picker's selection + optional expected-by time, resolves
 *  it to a `journey.JourneyDest`, and starts the journey. A `'label'`
 *  selection with no typed text, or a stale `place:`/`meet:` id (deleted
 *  since the form opened), shows an inline error rather than silently
 *  no-opping — the ONE form in this journey-mode UI whose submit can
 *  meaningfully fail validation (mirrors meet.ts's own `submitMeetForm`
 *  idiom). */
function submitJourneyForm(circleId: string): void {
  const destValue = (document.getElementById('journey-dest') as HTMLSelectElement | null)?.value ?? ''
  const freeLabel = inputValue('journey-label')
  const expectedByRaw = (document.getElementById('journey-expected-by') as HTMLInputElement | null)?.value ?? ''
  const p = store.load()
  let dest: journey.JourneyDest | undefined
  if (destValue.startsWith('place:')) {
    const place = (p.places[circleId] ?? []).find((pl) => pl.id === destValue.slice('place:'.length))
    if (place) dest = { kind: 'place', id: place.id, label: place.name }
  } else if (destValue.startsWith('meet:')) {
    const point = (p.meetPoints[circleId] ?? []).find((pt) => pt.id === destValue.slice('meet:'.length))
    if (point) dest = { kind: 'meet', id: point.id, label: point.name, geohash: encodeGeohash(point.centre.lat, point.centre.lon, 9) }
  } else if (destValue === 'label' && freeLabel) {
    dest = { kind: 'label', label: freeLabel }
  }
  if (!dest) {
    journeyFormError = 'Choose a destination, or type one in.'
    store.notify()
    return
  }
  const expectedBy = expectedByRaw ? resolveExpectedBy(expectedByRaw) : undefined
  formState.clearFields(['journey-dest', 'journey-label', 'journey-expected-by']) // submitted: the form starts afresh
  closeJourneyForm()
  journey.startJourney(circleId, dest, expectedBy)
}

function sheetWrap(body: string): string {
  return `<div class="person-sheet"><button type="button" class="sheet-close" data-action="map-sheet-close" aria-label="Close">✕</button>${body}</div>`
}

/** Compact relative age for a fix's timestamp — "just now" / "2m ago" / "1h ago". */
function ageLabel(at: number, now: number): string {
  const seconds = Math.max(0, now - at)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

function shortPk(pk: string): string {
  return `${pk.slice(0, 8)}…`
}

// ---------------------------------------------------------------------------
// Activity tab (Task 2) — the timeline view itself lives in activity.ts
// (`activity.view`/`activity.handleAction`, wired into `screenView`/
// `handleAction` above, same "each domain module owns its own tab section"
// convention as safety.ts/circles.ts/agreements.ts/approvals.ts). This
// module's own concern is just the deep-link NAVIGATION side — tab
// switching and map centring are state only app.ts owns.
// ---------------------------------------------------------------------------

/** A pending "centre the map here" request from an Activity deep link —
 *  consumed once by `updateMapMarkers` (below) then cleared, same one-shot
 *  idiom as `onboarding`'s module-level UI state elsewhere in this file.
 *  Deliberately NOT keyed to a specific tick: the map may not have finished
 *  loading yet (see `ensureLiveMapView`'s lazy import), so this simply
 *  waits until the next marker update actually has a live `MapView` to act
 *  on. */
let mapFocus: { circleId?: string; actorPk?: string; geohash?: string } | null = null

/** activity.ts's registered navigator (see `mount()`) — translates a deep
 *  link into an actual tab switch / map centre / scroll, the concrete
 *  actions only app.ts (owner of `tab` and the live `MapView`) can take. */
function handleActivityNav(link: activity.ActivityDeepLink): void {
  if (link.kind === 'map') {
    mapFocus = { circleId: link.circleId, actorPk: link.actorPk, geohash: link.geohash }
    showTab('map')
  } else if (link.kind === 'circle') {
    showTab('circles')
  } else if (link.kind === 'approvals') {
    showTab('circles')
    requestAnimationFrame(() => document.getElementById('approvals-card')?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
  }
}

// ---------------------------------------------------------------------------
// You tab — formerly Settings, now also absorbing identity (the signed-in
// line, moved out of Circles above) and Sign out (`signin.ts`'s own
// `signin-sign-out` action). Contacts (Signet identity plan, Task 11: the
// old rail-pairing/rolodex `contacts.ts` is deleted; plan 2 replaces it with
// the My Signet contacts grant) render via `contactsView.youContactsView()`
// below. Adds the full "who can see what about me?" privacy
// overview (`privacySummaryView`, Task 8, brief §11.1/§25): per circle —
// role, member names who can see this device, a live baseline-precision
// picker (`BASELINE_PRECISION_OPTIONS`), the current location-mode line
// (`circleModeLine`, also shown on the Map tab's self-marker sheet — see
// `selfSheetBody`), the active agreement's full schedule rendered in advance
// (brief §11.3: "the child should be able to see the schedule in advance"),
// any active safe-area escalation (`places.ts`'s own per-circle state), and
// a read-only "expected arrivals" list (Phase 3 Task 4, `places.ts`'s
// `arrivalWindowsSummaryView`) — a child device's ONLY view of a circle's
// arrival-window rules, since editing them is guardian-gated.
// ---------------------------------------------------------------------------

function youView(p: store.Persisted): string {
  // render() only reaches screenView (and this) once `signin.shouldShow()`
  // is false, i.e. a session is live — see screenView's own doc comment.
  const fam = session.currentSession()
  if (!fam) return `<h1>You</h1>`
  return `
    <h1>You</h1>
    ${contactsView.bannerView()}
    ${identitySummaryView(fam)}
    ${contactsView.youContactsView()}
    ${linkPairing.view(p)}
    <p class="muted">Relay: ${esc(p.settings.relayUrl ?? 'default')}</p>
    ${privacySummaryView(p, fam)}
    ${batteryAlertsToggleView(p)}
    ${quietHoursSectionView(p)}
    ${activity.retentionSectionView(p)}
    ${approvals.policyView(p, fam)}
    ${milestones.view(p, fam)}
    ${nativeLocationNoticeView()}
    ${meet.settingsView(p)}
    ${devices.view(p)}
  `
}

/** Battery + permission-rationale copy (Task 9, brief §12/§31) — native only
 *  (the web build has no background watcher at all, so there is nothing to
 *  explain there). Neutral, trust-first language throughout, per §31: no
 *  "tracking"/"monitoring" framing — this describes what sharing already
 *  does, just naming that it keeps working while the app is closed. The
 *  background watcher itself (native-geo.ts) runs continuously for as long
 *  as this device has an identity and at least one circle, asking the OS for
 *  its own permissions the first time it starts — this card is purely
 *  informational, not a gate in front of it. */
function nativeLocationNoticeView(): string {
  if (!isNativePlatform()) return ''
  return `
    <section class="contact-group">
      <h2>Location while closed</h2>
      <p class="muted small">
        On this device, sharing keeps your circle updated even while kindependence
        is closed or your screen is off — the same sharing you've already set
        up, just uninterrupted. Android shows a small ongoing notification
        while this is active, so it's never invisible. This can use a little
        more battery than sharing only while the app is open; if your device
        offers a battery-optimisation exemption for kindependence, allowing it
        helps sharing stay reliable in the background.
      </p>
    </section>
  `
}

function identitySummaryView(fam: SessionInfo): string {
  // Signet identity plan, Task 11: no more local per-family children list —
  // every dependant signs in on their own device via signin.ts's own
  // screens now. This identity's OWN phones (not a guardian's dependants'
  // devices — plan 2) are listed by the Devices screen (design spec §5,
  // Task 12), `devices.view(p)`, rendered further down `youView`.
  return `<p class="muted">Signed in as ${esc(fam.name)}${fam.dependant ? ' (dependant)' : ''}.</p>`
}

/** The baseline-precision picker for one circle — four chips
 *  (`beacons.BASELINE_PRECISION_OPTIONS`), the current one marked
 *  `aria-current`, applied immediately on click (`privacy-baseline-set`,
 *  same "click applies, no separate save step" idiom as the Map tab's own
 *  circle-selector chips) — takes effect on the circle's next emit tick
 *  (`beacons.ts`'s `setCircleBaselinePrecision` doc comment).
 *
 *  `current` MUST be the STATIC stored choice (`beacons.pickerSelectedPrecision`
 *  — final-review fix, §32.4/§11.1), not the schedule-aware EFFECTIVE value
 *  (`beacons.circleBaselinePrecision`). The two diverge whenever a
 *  `ScheduleRule` is currently overriding the baseline: feeding the
 *  effective value in here used to mean tapping a chip during an active
 *  override window produced no visible feedback at all — the window's own
 *  precision, not the tap, decided which chip looked selected, and the chip
 *  the user just tapped could appear to silently "not take." Highlighting
 *  the static choice always reflects the tap immediately; the divergence
 *  itself is surfaced separately via `scheduleOverrideAnnotationView`
 *  (`privacySummaryView`'s call site, right below this picker). */
function baselinePickerView(circleId: string, current: number): string {
  const chips = beacons.BASELINE_PRECISION_OPTIONS.map((precision) => `
    <button type="button" class="precision-chip" data-action="privacy-baseline-set"
      data-circle="${esc(circleId)}" data-precision="${esc(String(precision))}" aria-current="${precision === current}">
      ${esc(mapinfo.precisionTerm(precision))}
    </button>`).join('')
  return `<div class="precision-chips">${chips}</div>`
}

/** The baseline picker's schedule-override annotation (final-review fix,
 *  §32.4/§11.1): when an active `ScheduleRule` is temporarily raising
 *  `circleId`'s baseline above whatever chip `baselinePickerView` just
 *  highlighted (the STATIC stored choice, which the picker deliberately no
 *  longer hides — see that function's own doc comment), this line makes the
 *  divergence visible rather than silent, e.g. "Schedule override: Street
 *  until 17:00." Empty (no row) whenever no rule is currently active — the
 *  common case. `activeRule` is `beacons.scheduledPrecision`'s own return
 *  shape, so `privacySummaryView` can pass through exactly what it already
 *  computed for `circleModeLine`'s sibling check, no second lookup. */
function scheduleOverrideAnnotationView(activeRule: { precision: number; until: number } | null): string {
  if (!activeRule) return ''
  const term = mapinfo.precisionTerm(activeRule.precision)
  const until = formatSecOfDay(activeRule.until)
  return `<p class="muted small">Schedule override: ${esc(term)} until ${esc(until)}</p>`
}

/** The baseline picker's active-journey annotation (Phase 5 final-review
 *  fast-follow, §25 transparency) — same idiom as
 *  `scheduleOverrideAnnotationView` just above, for the SAME underlying
 *  reason: an active journey's `beacons.journeyFloorFor` floor is folded
 *  into actual disclosure by `circleModeLine`/`emitTick` alike
 *  (`beacons.applyJourneyFloor`), but `baselinePickerView` still only
 *  highlights the STATIC stored choice, so without this row a journey's
 *  floor could silently raise disclosure with no visible explanation on
 *  this card. Empty (no row) whenever `circleId` has no active journey —
 *  the common case. `journeyFloor` is `beacons.journeyFloorFor`'s own
 *  return value; `privacySummaryView`'s call site looks it up directly
 *  (a second, cheap registered-provider read — `circleModeLine`'s own copy
 *  isn't threaded out here) rather than changing that function's return
 *  shape just to share one number. */
function journeyOverrideAnnotationView(journeyFloor: number | undefined): string {
  if (journeyFloor === undefined) return ''
  const term = mapinfo.precisionTerm(journeyFloor)
  return `<p class="muted small">Journey override: ${esc(term)} until you arrive</p>`
}

// ---------------------------------------------------------------------------
// Sharing schedules (Phase 5 Task 2, brief §32.4) — per-circle time-windowed
// precision overrides, sitting right below the static baseline picker above
// in the You-tab privacy card. Same "arrival-window editor" idiom as
// places.ts's `arrivalWindowsSectionView`/`windowAddFormView`/
// `submitWindowForm` (day chips + from/to time inputs + an explicit Add,
// existing rules listed with a Remove button) — but owned HERE in app.ts,
// not places.ts: `sharingSchedules` is a LOCAL-ONLY `settings` field
// (beacons.ts owns the model/validation/CRUD, same split as
// `circleBasePrecision`/`baselinePickerView` just above), never a
// wire-synced `Place` blob, so there's no "guardian-only, full-set publish"
// machinery to route through the way places.ts's own editor does.
// ---------------------------------------------------------------------------

/** Mon-first day-chip labels for the add-rule form — same ordering as
 *  places.ts's own (unexported) `DAY_LABELS_MON_FIRST`; duplicated rather
 *  than imported since that const isn't exported and this is a 7-entry
 *  literal, not worth widening places.ts's export surface for one caller. */
const SCHEDULE_DAY_LABELS: Array<{ day: number; label: string }> = [
  { day: 1, label: 'Mon' }, { day: 2, label: 'Tue' }, { day: 3, label: 'Wed' }, { day: 4, label: 'Thu' },
  { day: 5, label: 'Fri' }, { day: 6, label: 'Sat' }, { day: 0, label: 'Sun' },
]

/** Per-circle inline form-error state for the add-schedule-rule form — same
 *  Map-keyed-by-id idiom as places.ts's `windowFormErrors`. Cleared on a
 *  successful add; left stale otherwise so the message survives the
 *  re-render `store.notify()` triggers. */
const scheduleFormErrors = new Map<string, string>()

function scheduleRuleRowView(circleId: string, r: store.ScheduleRule): string {
  return `
    <li class="contact-item">
      ${esc(r.label)} — ${esc(places.formatDays(r.days))} · ${esc(r.from)}–${esc(r.to)} · ${esc(mapinfo.precisionTerm(r.precision))}
      <button type="button" data-action="schedule-rule-remove" data-circle="${esc(circleId)}" data-rule="${esc(r.id)}">Remove</button>
    </li>`
}

function scheduleRuleAddFormView(circleId: string): string {
  const dayChips = SCHEDULE_DAY_LABELS.map(({ day, label }) => `
    <label class="confirm-gate"><input type="checkbox" id="sched-day-${esc(circleId)}-${day}" /> ${label}</label>`).join('')
  const precisionOptions = beacons.BASELINE_PRECISION_OPTIONS
    .map((precision) => `<option value="${precision}"${precision === beacons.DEFAULT_BASELINE_PRECISION ? ' selected' : ''}>${esc(mapinfo.precisionTerm(precision))}</option>`)
    .join('')
  const err = scheduleFormErrors.get(circleId)
  const errHtml = err ? `<p class="form-error">${esc(err)}</p>` : ''
  return `
    <div class="window-form">
      <div class="schedule-chips">${dayChips}</div>
      <input type="time" id="sched-from-${esc(circleId)}" />
      <input type="time" id="sched-to-${esc(circleId)}" />
      <select id="sched-precision-${esc(circleId)}">${precisionOptions}</select>
      <input type="text" id="sched-label-${esc(circleId)}" maxlength="${beacons.SCHEDULE_LABEL_MAX}" placeholder="Label (e.g. After school)" />
      ${errHtml}
      <div class="sheet-actions">
        <button type="button" data-action="schedule-rule-add" data-circle="${esc(circleId)}">Add sharing schedule</button>
      </div>
    </div>`
}

/** The You-tab per-circle sharing-schedule section (task contract: "day
 *  chips, from/to time inputs, precision select from
 *  BASELINE_PRECISION_OPTIONS, label") — existing rules listed read-only
 *  with a Remove button, an add-form shown only while under
 *  `beacons.SCHEDULE_RULE_MAX` (mirrors places.ts's
 *  `arrivalWindowsSectionView` capacity gate). */
function sharingScheduleSectionView(p: store.Persisted, circleId: string): string {
  const rules = p.settings.sharingSchedules?.[circleId] ?? []
  const rows = rules.map((r) => scheduleRuleRowView(circleId, r)).join('')
  const list = rows ? `<ul class="contact-list">${rows}</ul>` : '<p class="muted small">No sharing schedules yet.</p>'
  const addForm = rules.length < beacons.SCHEDULE_RULE_MAX ? scheduleRuleAddFormView(circleId) : ''
  return `
    <div class="arrival-windows">
      <p class="muted small"><strong>Sharing schedule</strong></p>
      ${list}
      ${addForm}
    </div>`
}

function readScheduleDays(circleId: string): number[] {
  const days: number[] = []
  for (const { day } of SCHEDULE_DAY_LABELS) {
    const el = document.getElementById(`sched-day-${circleId}-${day}`) as HTMLInputElement | null
    if (el?.checked) days.push(day)
  }
  return days
}

/** The Add button's handler — validates via `beacons.validateScheduleRuleDraft`
 *  before writing (inline `.form-error` on failure, same idiom as
 *  `submitWindowForm`/`submitQuietHoursForm`), then hands the draft straight
 *  to `beacons.addSharingScheduleRule`. */
function submitScheduleRuleForm(circleId: string): void {
  const days = readScheduleDays(circleId)
  const from = (document.getElementById(`sched-from-${circleId}`) as HTMLInputElement | null)?.value ?? ''
  const to = (document.getElementById(`sched-to-${circleId}`) as HTMLInputElement | null)?.value ?? ''
  const precision = Number((document.getElementById(`sched-precision-${circleId}`) as HTMLSelectElement | null)?.value ?? beacons.DEFAULT_BASELINE_PRECISION)
  const label = (document.getElementById(`sched-label-${circleId}`) as HTMLInputElement | null)?.value ?? ''
  const draft: beacons.ScheduleRuleDraft = { days, from, to, precision, label }
  const existing = store.load().settings.sharingSchedules?.[circleId] ?? []
  const error = beacons.validateScheduleRuleDraft(existing.length, draft)
  if (error) { scheduleFormErrors.set(circleId, error); store.notify(); return }
  scheduleFormErrors.delete(circleId)
  // Added: the form (still on screen) starts afresh.
  formState.clearFields([
    ...SCHEDULE_DAY_LABELS.map(({ day }) => `sched-day-${circleId}-${day}`),
    `sched-from-${circleId}`, `sched-to-${circleId}`, `sched-precision-${circleId}`, `sched-label-${circleId}`,
  ])
  beacons.addSharingScheduleRule(circleId, draft)
}

/** The "share my battery with this circle" toggle (Phase 3 Task 1) — a
 *  single chip, same "click applies immediately, `aria-current` marks the
 *  active state" idiom as `baselinePickerView`/`map-circle-toggle` above,
 *  applied via `battery.ts`'s `setShareBattery`. `data-on` carries the
 *  CURRENT state so the handler knows which way to flip it. Label text is a
 *  CONSTANT (Task 1 review follow-up, Minor #3) — same symmetric idiom as
 *  those neighbouring chips (`map-circle-toggle`'s circle name never changes
 *  between selected/unselected, only `aria-current` does): the old version's
 *  two differently-worded strings ("Sharing battery" on / "Share battery
 *  with this circle" off) read as mismatched lengths/phrasing rather than
 *  one control toggling. */
const BATTERY_SHARE_LABEL = 'Share battery with this circle'
function batteryShareToggleView(circleId: string, on: boolean): string {
  return `
    <button type="button" class="precision-chip" data-action="battery-share-toggle"
      data-circle="${esc(circleId)}" data-on="${on}" aria-current="${on}">
      ${BATTERY_SHARE_LABEL}
    </button>`
}

/** The "Low-battery alerts" You-tab toggle (Phase 3 Task 2, task contract) —
 *  same constant-label/`aria-current` idiom as `batteryShareToggleView`
 *  above, global (not per-circle — `battery.ts`'s
 *  `settings.batteryAlertsOff` doc comment), default ON, writing the
 *  INVERTED flag: `aria-current` (on) is `!batteryAlertsOff`. */
const BATTERY_ALERTS_LABEL = 'Low-battery alerts'
function batteryAlertsToggleView(p: store.Persisted): string {
  const on = !p.settings.batteryAlertsOff
  return `
    <button type="button" class="precision-chip" data-action="battery-alerts-toggle" aria-current="${on}">
      ${BATTERY_ALERTS_LABEL}
    </button>`
}

/** Quiet hours (Phase 5 Task 1, brief §32.5) — the You-tab section joining
 *  the toggles/sections above: an enable toggle (immediate-apply, same
 *  `aria-current`/constant-label idiom as `batteryAlertsToggleView` right
 *  above) plus two `<input type="time">` fields committed via an explicit
 *  Save (mirrors places.ts's `windowAddFormView`/`submitWindowForm`
 *  time-input idiom — a partial keystroke mid-edit must never half-apply, so
 *  unlike the toggle there's no per-keystroke live-write). `22:00`/`07:00`
 *  are DISPLAY-only pre-fill for an unset `settings.quietHours` — nothing is
 *  written until Save is actually tapped, and the toggle itself preserves
 *  whatever start/end are already set (or that same pre-fill) rather than
 *  clobbering them. Copy is the task-contract-verbatim string. */
const QUIET_HOURS_LABEL = 'Quiet hours'
const QUIET_HOURS_DEFAULT_START = '22:00'
const QUIET_HOURS_DEFAULT_END = '07:00'

/** Review-minor idiom (mirrors places.ts's `windowFormErrors`): per-form
 *  inline error state for the quiet-hours time-input pair, since there's
 *  only ever one such form (unlike places.ts's per-place-keyed map). Cleared
 *  on a successful Save; left stale otherwise so the message survives the
 *  re-render `store.notify()` triggers. */
let quietHoursFormError: string | undefined

function quietHoursSectionView(p: store.Persisted): string {
  const qh = p.settings.quietHours
  const on = qh?.enabled === true
  const start = qh?.start ?? QUIET_HOURS_DEFAULT_START
  const end = qh?.end ?? QUIET_HOURS_DEFAULT_END
  const err = quietHoursFormError ? `<p class="form-error">${esc(quietHoursFormError)}</p>` : ''
  return `
    <section class="contact-group">
      <h2>${QUIET_HOURS_LABEL}</h2>
      <button type="button" class="precision-chip" data-action="quiet-hours-toggle" aria-current="${on}">
        ${QUIET_HOURS_LABEL}
      </button>
      <div class="window-form">
        <label>From <input type="time" id="quiet-hours-start" value="${esc(start)}" /></label>
        <label>Until <input type="time" id="quiet-hours-end" value="${esc(end)}" /></label>
        ${err}
        <div class="sheet-actions">
          <button type="button" data-action="quiet-hours-save">Save quiet hours</button>
        </div>
      </div>
      <p class="muted small">
        Alerts for urgent safety events always come through. Held alerts
        aren't re-sent later — Activity keeps the record.
      </p>
    </section>`
}

/** The Save button's handler — validates both times via places.ts's own
 *  `parseHHMM` (shared, not duplicated) before writing, same discipline as
 *  `submitWindowForm`. Preserves the CURRENT `enabled` state (or `false` if
 *  quiet hours were never configured at all) — Save only ever touches the
 *  window, never flips the toggle. */
function submitQuietHoursForm(): void {
  const start = (document.getElementById('quiet-hours-start') as HTMLInputElement | null)?.value ?? ''
  const end = (document.getElementById('quiet-hours-end') as HTMLInputElement | null)?.value ?? ''
  if (places.parseHHMM(start) === null || places.parseHHMM(end) === null) {
    quietHoursFormError = 'Choose a start and end time.'
    store.notify()
    return
  }
  quietHoursFormError = undefined
  store.update((p) => {
    const enabled = p.settings.quietHours?.enabled ?? false
    p.settings = { ...p.settings, quietHours: { enabled, start, end } }
  })
}

/** Every OTHER member's name, comma-joined — the row's "member names who can
 *  see me" (brief §25): every circle member receives this device's beacon
 *  (the shared circle inbox has no per-member visibility subset), so this is
 *  simply the circle's own roster minus self. Raw (NOT esc()'d) — same
 *  "name-lookup helpers return raw text, the render site esc()'s once"
 *  convention as safety.ts's own `memberName` — see `privacySummaryView`'s
 *  call site, the one place this gets escaped. */
function membersWhoSeeMe(circle: Circle, selfPk: string): string {
  const others = circle.members.filter((m) => m.pk !== selfPk).map((m) => m.name || shortPk(m.pk))
  return others.length ? others.join(', ') : 'No one else yet'
}

/** The active-agreement row (brief §11.3): only rendered when THIS device is
 *  the child an agreement in `circle` is currently tracking
 *  (`beacons.activeAgreementFor` — proposed/arrived agreements are excluded,
 *  same scope as the routine-cadence merge itself uses) — the schedule is
 *  rendered in full, in advance, via `agreements.agreementScheduleText`. */
function agreementScheduleRow(circle: Circle, baselineTerm: string): string {
  const agreement = beacons.activeAgreementFor(circle.id)
  if (!agreement) return ''
  const text = agreements.agreementScheduleText(baselineTerm, agreement.schedule, agreement.byUnix, formatClockTime)
  return `<p class="muted small">Return-time schedule: ${esc(text)}</p>`
}

/** The active safe-area escalation row (brief §25's "any active safety
 *  escalation") — reuses `places.ts`'s own child-facing copy
 *  (`graceWarningCopy`/`escalatedChildCopy`) rather than inventing a second
 *  phrasing for the same state; empty (no row) whenever this circle's
 *  escalation is `'safe'` — the common case, and always true for a circle
 *  this device is a guardian of (places.ts's supervisor only ever runs for a
 *  child role — see that module's `tick()`). `'leave-approved'` (Phase 5
 *  Task 5) is treated the same as `'safe'` here — it's the OPPOSITE of an
 *  active safety escalation (a guardian-granted permission, nothing
 *  outstanding to surface on this "what's currently escalated" row). */
function escalationRow(circleId: string): string {
  const state = places.currentEscalation(circleId)
  if (state.phase === 'safe' || state.phase === 'leave-approved') return ''
  const now = Math.floor(Date.now() / 1000)
  const text = state.phase === 'grace'
    ? places.graceWarningCopy(state.placeName, Math.max(1, Math.ceil((state.graceEndsAt - now) / 60)))
    // Review C1: mirror places.ts's own `escalationBannerView` exactly —
    // `state.breachSent` (not merely `phase === 'escalated'`) decides
    // whether the guardian has actually been told yet. Claiming "has been
    // told" before a breach signal genuinely went out (e.g. a cold launch
    // still waiting on its first geolocation fix) would be the same false
    // claim C1 fixed in the private banner, just on this second surface.
    // `escalatedChildCopy`'s `immediate` distinction isn't retained across a
    // reload (see `EscalationSubState`'s own doc comment) — `false` renders
    // the phrasing that's true either way, same as `escalationBannerView`.
    : (state.breachSent ? places.escalatedChildCopy(state.placeName, false) : places.escalationPendingCopy(state.placeName))
  return `<p class="muted small">${esc(text)}</p>`
}

/** "Who can see what about me?" (brief §11.1/§25) — one card per circle this
 *  device belongs to. */
function privacySummaryView(p: store.Persisted, fam: SessionInfo): string {
  if (!p.circles.length) return ''
  // Read once and reuse across every circle in this render pass — same
  // "no disagreement at a window boundary a few milliseconds apart" reason
  // `circleModeLine`'s own doc comment gives for its own single read.
  const localNow = places.localDay(new Date())
  const rows = p.circles.map((c) => {
    const role = circles.selfRole(c, fam.identityPk) ?? 'member'
    // Final-review fix (§32.4/§11.1): the picker highlights the STATIC
    // stored choice, not the schedule-aware EFFECTIVE one — see
    // `baselinePickerView`'s own doc comment. `baselineTerm` (below) stays
    // on the EFFECTIVE value for `agreementScheduleRow`'s sentence, which
    // still needs the schedule's actual current floor, and `circleModeLine`
    // (also EFFECTIVE) is unchanged.
    // Phase 6 Task 4 (P5 residual): also folds in `beacons.journeyFloorFor`,
    // same as `circleModeLine`'s own merge just below — previously this read
    // only the schedule-aware baseline, so `agreementScheduleRow`'s "Return-
    // time schedule: ..." sentence could name a coarser term than the mode
    // line right above it whenever an active journey's floor was finer (e.g.
    // mode line says "Street" from a journey floor, schedule row still said
    // "Neighbourhood") — the two must never be able to contradict each other.
    const staticBaseline = beacons.pickerSelectedPrecision(p.settings, c.id)
    const effectiveBaseline = beacons.applyJourneyFloor(beacons.circleBaselinePrecision(p.settings, c.id, localNow), beacons.journeyFloorFor(c.id))
    const baselineTerm = mapinfo.precisionTerm(effectiveBaseline)
    const activeRule = beacons.scheduledPrecision(p.settings.sharingSchedules?.[c.id], localNow)
    return `
      <div class="policy-circle">
        <div class="policy-row">
          <span>${esc(c.name)}<span class="badge">${esc(role)}</span></span>
        </div>
        <p class="muted small">Sees me: ${esc(membersWhoSeeMe(c, fam.identityPk))}</p>
        <p class="muted small">${esc(circleModeLine(p, c))}</p>
        ${baselinePickerView(c.id, staticBaseline)}
        ${scheduleOverrideAnnotationView(activeRule)}
        ${journeyOverrideAnnotationView(beacons.journeyFloorFor(c.id))}
        ${sharingScheduleSectionView(p, c.id)}
        ${batteryShareToggleView(c.id, battery.effectiveShareBattery(p.settings, c, fam.identityPk))}
        ${agreementScheduleRow(c, baselineTerm)}
        ${places.arrivalWindowsSummaryView(p, c.id)}
        ${escalationRow(c.id)}
      </div>`
  }).join('')
  return `<section class="contact-group"><h2>Who can see what about me?</h2>${rows}</section>`
}

function navView(p: store.Persisted): string {
  // Circles tab unread badge (Task 5, task contract: "unread badge counts on
  // Circles tab + person rows") — every DM/circle-chat thread reachable from
  // that tab, summed.
  const self = session.currentSession()
  const circlesUnread = self ? messages.totalUnread(p, self.identityPk) : 0
  const item = (t: { id: Tab; label: string }): string => {
    const badge = t.id === 'circles' ? messages.unreadBadgeHtml(circlesUnread) : ''
    return `<button data-action="tab" data-tab="${t.id}" aria-current="${tab === t.id}">${t.label}${badge}</button>`
  }
  return `<nav class="nav">${TABS.map(item).join('')}</nav>`
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
