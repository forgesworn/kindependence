// Map-check friction (Phase 6 Task 1, design spec §1 / brief §2.3): a
// PRIVATE, guardian-side, nudge-only card that discourages compulsive
// map-checking on a day where nothing is actually happening. This is the
// product's soul feature — HARD RULES (task contract, none of them
// negotiable):
//  - never delays, blocks, or throttles anything — it's a card, nothing more
//  - never fires on a non-quiet day (checking during an actual situation is
//    what the map is FOR)
//  - no wire type, no Activity entry, invisible to the child — this stays
//    entirely on the guardian's own local device (see store.ts's own doc
//    comment on `mapChecks`/`frictionDismissedDay` for the full picture)
//  - dismissed → gone for the rest of that calendar day, nothing more
//
// Two independent pieces meet in `view` below:
//  - A day-scoped, once-per-minute-collapsed tap counter (`mapChecks`) —
//    incremented from app.ts's three hook points: a Map-tab activation,
//    opening a DEPENDANT's person sheet, or (Phase 6 Task 4) the app
//    resuming — becoming visible again — while the Map tab is already
//    active, the dominant compulsive close-reopen pattern a plain "activate
//    the Map tab" hook alone never sees (all three guardian-only gated in
//    app.ts itself — see its own call sites for `recordMapCheck`, and this
//    module's own `shouldCountResumeAsMapCheck` for the resume hook's pure
//    gate).
//  - A pure "is today actually quiet" predicate (`isQuietDay`) read
//    straight off state other modules already own (safetyEvents/activity/
//    pickups/agreements) — no bookkeeping of its own, so it can never drift
//    from what those modules already know happened.
// `shouldShowFrictionCard` combines the two (plus today's dismissal) into
// one render decision; a tap on the card's Dismiss button
// (`dismissFrictionCard`) records today's date so it stays gone until
// tomorrow rolls the day stamp over.

import * as store from './store.js'
import { localDay } from './places.js'

/** Checks before this many on a quiet day earn the nudge —
 *  [maintainer-review]: tune freely, see the design spec's §1. */
export const FRICTION_THRESHOLD = 8

/** A burst of taps inside this many seconds of the last COUNTED check is
 *  one check, not several (task contract: "once per minute max"). */
export const FRICTION_MIN_GAP_SEC = 60

export type MapCheckState = store.Persisted['mapChecks']

/** Pure reducer: `state` (possibly from an earlier day) plus one fresh tap
 *  at `nowSec` -> the next counter state.
 *
 *  A day change (`state.day !== dayStamp`, including "no state yet" —
 *  `state.day` defaults to `''`, which never equals a real stamp) always
 *  resets to a fresh count of 1, UNCONDITIONALLY — a new day's first check
 *  is never collapsed against yesterday's `lastAt`, no matter how recent.
 *  Within the same day, a tap inside `FRICTION_MIN_GAP_SEC` of the last
 *  COUNTED tap returns `state` back UNCHANGED (same object reference, so a
 *  caller — `recordMapCheck` below — can tell "nothing to persist" cheaply);
 *  `lastAt` therefore only ever advances on an accepted increment, never on
 *  a collapsed one. */
export function nextMapCheckState(state: MapCheckState | undefined, nowSec: number, dayStamp: string): MapCheckState {
  if (!state || state.day !== dayStamp) return { day: dayStamp, count: 1, lastAt: nowSec }
  if (nowSec - state.lastAt < FRICTION_MIN_GAP_SEC) return state
  return { day: dayStamp, count: state.count + 1, lastAt: nowSec }
}

/** Thin store wrapper (task contract) — app.ts's three hook points (Map-tab
 *  activation, opening a dependant's person sheet, and Phase 6 Task 4's
 *  resume hook just below) all just call this; every day-stamp/collapse
 *  mechanic lives entirely in the pure reducer above. */
export function recordMapCheck(nowSec: number): void {
  const dayStamp = localDay(new Date(nowSec * 1000)).dayStamp
  store.update((p) => {
    p.mapChecks = nextMapCheckState(p.mapChecks, nowSec, dayStamp)
  })
}

/** Phase 6 Task 4 (final-review follow-up on Task 1: "feed recordMapCheck
 *  from an app-resume/visibilitychange hook — cold-relaunch is the dominant
 *  compulsive pattern and currently uncounted"): does THIS resume — the app
 *  becoming visible again — count as a map-check? Pure so app.ts's own
 *  `document.visibilitychange` listener (the only caller) is directly
 *  unit-testable without a DOM; it passes `document.visibilityState` and its
 *  own current tab through unchanged, same "app.ts owns the DOM/lifecycle
 *  wiring, the module owns the decision" split as `recordMapCheckIfGuardian`
 *  itself (app.ts's own guardian-role gate, kept in app.ts since it reads
 *  `store.load().identity` — no reason to duplicate that read here).
 *
 *  `true` only when the tab that just became visible again is the Map tab
 *  itself — resuming onto Circles/Activity/You is not "checking the map".
 *  `visibilityState` is read as a plain string (not the DOM lib's own
 *  `DocumentVisibilityState` type) so this stays a pure function over two
 *  primitives, no `lib.dom` dependency for a five-line predicate. */
export function shouldCountResumeAsMapCheck(visibilityState: string, activeTab: string): boolean {
  return visibilityState === 'visible' && activeTab === 'map'
}

// ---------------------------------------------------------------------------
// Quiet-day predicate — pure, reads only ALREADY-EXISTING state, adds no
// bookkeeping of its own. "The guardian's circles are ALL-QUIET" (design
// spec §1): every disqualifier below is a plain read of state another
// module already records for its own reasons, across every circle this
// device knows about (no circle/child scoping — a compulsive checker isn't
// soothed by "only ONE of your circles is having a moment").
// ---------------------------------------------------------------------------

/** The three Activity kinds that disqualify TODAY specifically (task
 *  contract) — 'sos' is the Activity-side record of the same event
 *  `isQuietDay`'s `safetyEvents` check below also sees as a 'help' entry
 *  (safety.ts records both, belt-and-suspenders); 'safe-area-escalation'/
 *  'window-missed' are places.ts's own escalation/expected-arrival misses. */
const DAY_SCOPED_ACTIVITY_KINDS = new Set(['safe-area-escalation', 'window-missed', 'sos'])

/** Whether `at` (unix seconds) falls on the SAME device-local calendar day
 *  as `nowSec` — reuses places.ts's own `localDay` rather than duplicating
 *  its `'YYYY-MM-DD'` formatting (same "reuse, don't reinvent" convention
 *  as beacons.ts's `parseHHMM` reuse). */
function isToday(at: number, nowSec: number): boolean {
  return localDay(new Date(at * 1000)).dayStamp === localDay(new Date(nowSec * 1000)).dayStamp
}

/** Pure predicate (task contract): is today, so far, free of anything that
 *  would make "you don't need to watch the map" false? Every disqualifier
 *  below is a plain read of state another module already owns:
 *   - a `'help'` (SOS) `safetyEvents` entry today (safety.ts)
 *   - a `'safe-area-escalation'`, `'window-missed'`, or `'sos'` Activity
 *     entry today (places.ts/safety.ts, via activity.ts)
 *   - ANY pickup record still in a non-terminal phase — deliberately NOT
 *     day-scoped: an in-progress pickup arranged yesterday and still
 *     unresolved is exactly the kind of "something's actually happening"
 *     the map is for (pickup.ts's `'collected'`/`'declined'` are the only
 *     terminal phases — every other phase means the pickup is still live)
 *   - ANY tracked agreement past its `byUnix` deadline that hasn't reached
 *     `'arrived'` — also not day-scoped, same reasoning: a still-overdue
 *     agreement from yesterday hasn't resolved itself just because the
 *     calendar rolled over.
 *  HARD RULE (task contract): this must never say "quiet" on a day where
 *  any of the above is true — a false positive here is the one way this
 *  feature could discourage checking the map during an actual situation,
 *  which the design spec explicitly forbids. */
export function isQuietDay(p: store.Persisted, nowSec: number): boolean {
  if (p.safetyEvents.some((e) => e.kind === 'help' && isToday(e.at, nowSec))) return false
  if (p.activity.some((e) => DAY_SCOPED_ACTIVITY_KINDS.has(e.kind) && isToday(e.at, nowSec))) return false
  if (p.pickups.some((r) => r.phase !== 'collected' && r.phase !== 'declined')) return false
  if (p.agreements.some((r) => r.status !== 'arrived' && nowSec > r.agreement.byUnix)) return false
  return true
}

// ---------------------------------------------------------------------------
// Card gating + dismiss — a pure decision plus a one-line store write.
// ---------------------------------------------------------------------------

/** Pure: should the Map tab render the nudge card THIS render? All four
 *  conditions must hold:
 *   - `quiet` (the day, per `isQuietDay` above)
 *   - not already dismissed today (`dismissedDay !== todayStamp`)
 *   - `state` is actually TODAY's counter (`state.day === todayStamp` — a
 *     stale leftover from a day the counter hasn't rolled over from yet
 *     reads as "no checks today," not as its old count)
 *   - `state.count` has reached `FRICTION_THRESHOLD`. */
export function shouldShowFrictionCard(state: MapCheckState | undefined, dismissedDay: string | undefined, quiet: boolean, todayStamp: string): boolean {
  if (!quiet) return false
  if (dismissedDay === todayStamp) return false
  if (!state || state.day !== todayStamp) return false
  return state.count >= FRICTION_THRESHOLD
}

/** Records today's dismissal — "gone for the day" (task contract): the
 *  card won't render again until `todayStamp` no longer matches
 *  `Persisted.frictionDismissedDay`, i.e. the next calendar day. */
export function dismissFrictionCard(todayStamp: string): void {
  store.update((p) => { p.frictionDismissedDay = todayStamp })
}

// ---------------------------------------------------------------------------
// Card — rendered on the Map tab (app.ts's `mapView`), self-contained same
// as places.ts's own `escalationBannerView`: `view` alone decides whether
// to render anything at all, app.ts just splices in whatever comes back.
// §31: this must never read as scolding — the body copy below is the
// design spec's own wording, verbatim, flagged for maintainer's pass.
// ---------------------------------------------------------------------------

/** Whether any circle's saved place has `arrivalNotify` off — gates the
 *  card's "Review arrival notifications" shortcut (task contract: only
 *  offer it when there's actually something to go review). */
function anyArrivalNotifyOff(p: store.Persisted): boolean {
  return Object.values(p.places).some((list) => list.some((pl) => !pl.arrivalNotify))
}

export function view(p: store.Persisted, nowSec: number): string {
  const todayStamp = localDay(new Date(nowSec * 1000)).dayStamp
  if (!shouldShowFrictionCard(p.mapChecks, p.frictionDismissedDay, isQuietDay(p, nowSec), todayStamp)) return ''
  // [copy] design spec §1, verbatim — the whole point of this feature is a
  // gentle, private nudge; must never read as scolding (§31).
  const body = "Everything's been quiet today. Arrival notifications will tell you if plans change — you don't need to watch the map."
  const reviewButton = anyArrivalNotifyOff(p)
    // [copy] shortcut label, design spec §1 verbatim — jumps to the Circles
    // tab's Safe places list (places.ts's own arrivalNotify per-place state
    // is shown there; there is no separate screen for it).
    ? `<button type="button" class="map-chip" data-action="tab" data-tab="circles">Review arrival notifications</button>`
    : ''
  // [copy] plain dismiss label, this module's own (not spec text) — flagged
  // for maintainer's review same as the two spec-verbatim strings above.
  const dismissLabel = 'Dismiss'
  return `
    <div class="friction-card">
      <p>${body}</p>
      <div class="friction-card-actions">
        ${reviewButton}
        <button type="button" data-action="friction-dismiss">${dismissLabel}</button>
      </div>
    </div>`
}

/** app.ts delegates every `friction-*` data-action here, same pattern as
 *  every other domain module's `handleAction`. */
export function handleAction(action: string, _node: HTMLElement): void {
  if (action === 'friction-dismiss') dismissFrictionCard(localDay(new Date()).dayStamp)
}
