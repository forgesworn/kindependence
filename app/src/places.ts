// Safe areas: guardian-defined named places per circle, child-first
// escalation, and arrival/departure notifications (Task 7, brief §13,
// §16.1-16.2, §2.5). Same render-on-state/registration idioms as every other
// domain module here: `ensure()` is the one side-effecting entry point
// (registers with beacons.ts's circle-inbox dispatch, starts the child-side
// evaluation timer); `view()`/`handleAction()` own this module's UI; the pure
// section below (escalation state machine, membership diffing, wire
// encode/decode) is unit-tested in isolation (places.test.ts).
//
// Wire shape — TWO signals travel together whenever a guardian saves a
// circle's place set, both gift-wrapped to the circle's shared inbox exactly
// like every other kindependence payload:
//
//   1. `t:'fences'` — the REAL flock fence-sync signal
//      (`@forgesworn/flock/fences`'s `buildFencesSignal`/`decryptFences`),
//      carrying ONLY geometry (`{kind:'circle', centre, radiusMetres}` per
//      place) — full-set-replacement, latest-wins, byte-identical to real
//      flock. This is the "wire-identical so flock clients see the same
//      fences" half of the task contract: a plain flock device in the same
//      circle sees matching safe zones and can run its OWN breach detection
//      against them, even though it has no idea what kindependence calls them.
//      `decryptFences` STRICTLY reconstructs each fence from only
//      `kind`/`centre|vertices`/`radiusMetres` (see its own `parseFence`) —
//      it silently drops any extra property, so a place's name/type/notify
//      toggles/escalation mode genuinely cannot ride inside this signal.
//   2. `t:'kindependence-places'` — THIS module's own companion signal, same
//      full-set/latest-wins discipline (reusing flock's own
//      `isNewerFenceSet` clock check directly — it only needs
//      `{updatedAt, by}`, so it's generic enough to reuse unmodified),
//      carrying the FULL `Place[]` (including geometry redundantly) as
//      plain JSON on an UNENCRYPTED-BUT-GIFT-WRAPPED kind-20078 rumor —
//      exactly BROOD's own `buildBroodInner` pattern (see
//      agreements.ts's module doc comment for why a second encryption layer
//      buys nothing against a circle's own members: the outer NIP-59
//      gift-wrap, keyed off the same shared `seedHex`-derived inbox, is
//      already the only confidentiality that matters here). A real flock
//      client sees an unrecognised `t` and drops it, same as any other
//      app-specific signal (brood's own agreement/policy signals already
//      establish this "extend flock's `t` vocabulary, gift-wrapped the same
//      way" precedent). kindependence devices treat THIS signal as the
//      authoritative source for their own places list/UI/evaluation.
//
// Known v1 gap (documented, not solved here — same "scoped down,
// follow-up" discipline as circles.ts's word-code doc comment): a place set
// is only pushed on EDIT, never re-broadcast on request, so a freshly
// joined circle member can miss the current set until the next edit. No
// "roster healing" equivalent is built for places in this task.
//
// Child-side escalation (brief §2.5/§13.2 — BINDING): a child device
// evaluates its own fixes against ITS circle's places locally (never sends
// raw coordinates for this). Leaving the UNION of a circle's places starts a
// PRIVATE, LOCAL grace countdown (default 10 min, per-place-configurable) —
// nothing reaches the guardian yet. Returning within grace cancels silently.
// Grace expiry (or an `'immediate'`-mode place) emits flock's real `breach`
// signal (`@forgesworn/flock/signals`, wire-identical, precision 9) — ONLY
// at that point does the guardian learn anything. The pure state machine
// (`evaluatePlaces`/`checkGraceExpiry`) never itself performs I/O; the
// impure `tick()` orchestrator below drives it off `beacons.selfFix()` on a
// periodic timer (not solely on fresh fixes — grace must still expire while
// the child is stationary and no new fix arrives; see `tick`'s own doc
// comment).
//
// Reload safety (follow-up fix, post-review): the escalation phase itself
// is minimally PERSISTED (`Persisted.placeEval`, store.ts) — without this, a
// child could force-close the app during a grace countdown to reset it back
// to 'safe' indefinitely and never trigger the guardian signal at all.
// `stateFor` hydrates from the persisted snapshot the first time a circle is
// read each session (`hydratePlaceEvalState`); a grace countdown RESUMES
// with its ORIGINAL deadline (never restarts the full duration), and if that
// deadline already passed while the app was closed, `checkGraceExpiry`
// escalates on the very next tick. A genuine re-entry clears the persisted
// snapshot (`clearPersistedEscalation`). A SEPARATE, independent guard
// (`shouldSuppressEscalation`, keyed by `${circleId}:${placeName}` in
// `Persisted.placeLastEscalatedAt`) additionally suppresses re-sending an
// actual breach signal within 30 minutes of the last one for the SAME
// circle+place — defense in depth alongside the phase hydration, so an
// immediate-mode place (which escalates the instant it's left, no grace
// window to hydrate into) can't fire a duplicate guardian-facing breach
// purely from repeated reloads while continuously outside. `evalState`
// itself stays module-level/in-memory — only this MINIMAL snapshot is
// persisted, not the full `PlaceEvalState`.
//
// Final-review fixes (C1 + I1), both in the same orchestration layer:
//
//   C1 — `EscalationSubState`'s `'escalated'` variant now carries its own
//   `breachSent` bit (mirrored in `Persisted.placeEval` via
//   `placeEvalToPersisted`/`hydratePlaceEvalState`). Reaching 'escalated' —
//   the state machine's own decision — is correct and immediate on the very
//   tick a grace deadline expires, EVEN with no fix available yet (a cold
//   launch runs its first `tick()` before geolocation can possibly have
//   reported in). What used to go wrong: the old code treated "reached
//   'escalated'" and "guardian was told" as the same moment, unconditionally
//   stamping the suppression window and telling the child "your circle has
//   been told" even when `sendBreachSignal` silently no-op'd for lack of a
//   fix — and since the phase never re-transitions while continuously
//   outside, that send was never retried. Now `tick()` calls
//   `ensureBreachSent` for every circle whose FINAL state this tick is
//   `'escalated'` with `breachSent` still false — regardless of whether that
//   phase was just reached this tick or resumed from a prior session — and
//   only stamps/claims/suppresses once a send has actually gone out (or was
//   correctly recognised as an already-recent repeat). The child-facing
//   banner mirrors this honestly: `escalationPendingCopy` ("will be told")
//   until `ensureBreachSent` flips it to `escalatedChildCopy` ("has been
//   told").
//
//   I1 — `insidePlaceIds` still isn't persisted (unchanged trade-off: a
//   post-reload fresh EXIT still falls back to `evaluatePlaces`'s own "treat
//   every configured place as relevant" case, already an accepted,
//   documented behaviour there). What changed is the ENTRY side: `tick()`
//   now tracks, per circle, whether this session has evaluated a live fix
//   against it yet (`seededCircles`, module-level/in-memory, same idiom as
//   `evalState`/`banners`) and passes `evaluatePlaces` a `seedOnly` flag on
//   that first look — updating `insidePlaceIds` for future diffing without
//   emitting `entered`/`exited` for whatever the fix happens to already be
//   inside/outside at that moment. Without this, EVERY place a member is
//   currently inside re-fired a real "Arrived at X" buzz to the whole circle
//   on every relaunch (and, symmetrically, could fire a spurious departure
//   too) — see `evaluatePlaces`'s own doc comment for the parameter.
//
// Guardian receive of a breach signal: the wire payload is (by flock's own
// design) just a precision-9 geohash — no place name. Rather than adding a
// correlation-buffer mechanism (Task 6's findreq/reason-DM pattern), this
// module uses a documented, deliberately simple heuristic: pick whichever of
// the RECEIVING device's own synced places is nearest to the disclosed
// point (`nearestPlace`) for the "Y left X" copy. This can be wrong if the
// child has moved on by the time grace expires — acceptable for descriptive
// Activity copy, not an enforcement decision, and avoids a second stateful
// correlation buffer for what's fundamentally a "best guess" label.
//
// Arrival/departure notifications (brief §16.1-16.2) run for EVERY member's
// own device (not just children) — entering/leaving a place with the
// matching toggle on sends an untargeted circle-chat buzz (flock's real
// mechanism, same as messages.ts's own structured sends) whose `reason` is
// `"Arrived at <name>"`/`"Left <name>"`, plus a local Activity entry. The
// place name is wire-controlled (guardian-authored, free text) — esc()'d at
// every render site, never trusted raw into innerHTML.

import * as store from './store.js'
import { clearFields } from './form-state.js'
import type { Place, ArrivalWindow } from './store.js'
export type { Place, ArrivalWindow } from './store.js'
import type { SessionInfo } from './session.js'
import * as beacons from './beacons.js'
import * as activity from './activity.js'
import { appRelays, selfRole } from './circles.js'
import { shouldNotifyForSafetyEvent } from './safety.js'
import { notify } from './notify.js'
// Phase 5 Task 5 (brief §13.4): boundary-exit requests ride approvals.ts's
// approval-req/resp wire. This is a plain one-way import (places.ts calls
// `approvals.raiseApproval`/the two registration hooks) — approvals.ts does
// NOT import this module back (registration, not import, same discipline
// its own module doc comment documents for circles.ts). See approvals.ts's
// module doc comment for the full reasoning on the resulting three-file
// cycle through notify.ts (this module already imports `notify` above, and
// now also gets imported BY approvals.ts) — verified safe the same way that
// doc comment verifies its own circles.ts/beacons.ts triangle.
import * as approvals from './approvals.js'
import { precisionTerm as mapinfoPrecisionTerm } from './mapinfo.js'
import { currentSession, phoneSigner } from './session.js'
import { enqueue, registerSender, stillEnqueuingSession } from './structural-queue.js'
import { deriveInbox, isGuardian, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftWrap } from '@forgesworn/roost-kit'
import type { Rumor, Signer, SignedEvent } from '@forgesworn/roost-kit'
import { buildFencesSignal, isNewerFenceSet, type FenceSet } from '@forgesworn/flock/fences'
import { isInside, classifyContainment, haversineMetres, type LatLng, type CircleGeofence } from '@forgesworn/flock/geofence'
import { buildLocationSignal, SIGNAL_TYPES } from '@forgesworn/flock/signals'
import { buildKindependenceMsgSignal } from './legacy-buzz.js'
import { encode as encodeGeohash, decode as decodeGeohash } from 'geohash-kit'
import { deriveBeaconKey, decryptBeacon } from 'canary-kit'
import type { PolicyAction } from './brood/index.js'

const nowSec = (): number => Math.floor(Date.now() / 1000)

// ---------------------------------------------------------------------------
// Constants — task-contract defaults.
// ---------------------------------------------------------------------------

export const PLACE_TYPES = ['home', 'school', 'park', 'other'] as const
export type PlaceType = (typeof PLACE_TYPES)[number]
export type EscalationMode = 'grace' | 'immediate'

/** The map long-press/"add here" form's radius chip options, metres. */
export const RADIUS_CHIPS_METRES = [100, 250, 500] as const

/** Default grace period (task contract), minutes. */
export const DEFAULT_GRACE_MINUTES = 10

/** Upper bound on places per circle — well under flock's own `MAX_FENCES`
 *  (50), which the fences signal also enforces on the wire. A UI-level cap,
 *  not a wire-format one. */
export const MAX_PLACES = 20

export const MAX_PLACE_NAME_LEN = 40

/** Phase 3 Task 4 (arrival windows) — task-contract defaults/caps. */
export const MAX_WINDOWS_PER_PLACE = 4
export const DEFAULT_WINDOW_GRACE_MIN = 10

/** The window-add form's grace `<select>` options, minutes. */
export const WINDOW_GRACE_OPTIONS_MIN = [5, 10, 15, 30] as const

/** flock's own `full`/precise disclosure precision — the breach signal
 *  always discloses at this precision (task contract: "wire-identical,
 *  precision 9"), independent of whatever routine cadence beacons.ts is
 *  currently using. */
const BREACH_PRECISION = 9

function placeTypeLabel(t: PlaceType): string {
  switch (t) {
    case 'home': return 'Home'
    case 'school': return 'School'
    case 'park': return 'Park'
    case 'other': return 'Other'
  }
}

// ---------------------------------------------------------------------------
// Pure geometry/id helpers
// ---------------------------------------------------------------------------

function randomHex(byteLen: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLen)))
}

/** A fresh place id — an unlinkability handle, not a secret, same idiom as
 *  circles.ts's `newCircleId`/agreements.ts's `newAgreementId`. */
export function newPlaceId(): string {
  return randomHex(8)
}

/** A fresh arrival-window id (Phase 3 Task 4) — mirrors `newPlaceId` exactly,
 *  same "unlinkability handle, not a secret" idiom. */
export function newWindowId(): string {
  return randomHex(8)
}

/** Strict `'HH:MM'` (24-hour, device-local, zero-padded) → seconds-of-day, or
 *  `null` for anything else — no `HH:MM:SS`, no single-digit hours/minutes,
 *  no out-of-range values. Deliberately strict (not `Date`-parsed, which
 *  would silently accept all sorts of locale-dependent junk) since this is
 *  the one gate between a guardian's `<input type="time">` (or a malformed
 *  wire payload) and an `ArrivalWindow.arriveBy` that Task 5 will compare
 *  against a clock. */
export function parseHHMM(s: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(s)
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return hours * 3600 + minutes * 60
}

/** Windows are day-scoped by design (review-minor #6, "document, don't
 *  redesign" — see the README's windows section for the user-facing note):
 *  `windowAction`'s `'fire'` check compares `day.secOfDay` (which never
 *  reaches 86400 — `localDay` derives it from the SAME calendar day as
 *  `dayStamp`) against `deadline + graceMin*60`. An `arriveBy`+`graceMin`
 *  combination whose deadline+grace lands AT OR PAST midnight can therefore
 *  never satisfy that check on the day the window is actually scheduled for
 *  — it would silently never fire. Rather than teaching the evaluator to
 *  reach into the next day (a real redesign, out of scope here), the add-
 *  window editor rejects such a combination up front (see
 *  `submitWindowForm`'s own `.form-error` guard) so a guardian never
 *  configures a rule that can't work. `arriveBy` is assumed already
 *  `parseHHMM`-valid; a malformed one returns `false` (the editor's own
 *  arriveBy check runs first and rejects it before this ever matters). */
export function windowCrossesMidnight(arriveBy: string, graceMin: number): boolean {
  const deadline = parseHHMM(arriveBy)
  if (deadline === null) return false
  return deadline + graceMin * 60 >= 24 * 3600
}

/** JS `Date.getDay()` order (0 = Sunday) but walked Mon-first for display —
 *  every day-range formatting/rendering site in this module (`formatDays`,
 *  the add-window form's day chips) shares this single ordering so they can
 *  never drift apart. */
const MON_FIRST_ORDER: number[] = [1, 2, 3, 4, 5, 6, 0]
const DAY_NAMES: string[] = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] // indexed by getDay()
const DAY_LABELS_MON_FIRST = MON_FIRST_ORDER.map((day) => ({ day, label: DAY_NAMES[day] }))

/** Friendly day-range summary for an `ArrivalWindow.days` array — Mon-first
 *  ordering regardless of input order/duplicates (a `Set` dedupes first).
 *  Contiguous runs (in MON-FIRST order — Sat/Sun IS contiguous, Sun/Mon is
 *  NOT, since Sunday sits at the end of the display order, not before
 *  Monday) collapse to `"Mon–Fri"`; a lone day in a run renders plainly
 *  (`"Wed"`, no dash); every day present collapses to `"Every day"`
 *  (task contract: `"Sat–Sun" → "Weekends"` is explicitly NOT required);
 *  otherwise runs are comma-joined (`"Mon, Wed, Fri"`). */
export function formatDays(days: number[]): string {
  const set = new Set(days)
  const ordered = MON_FIRST_ORDER.filter((d) => set.has(d))
  if (ordered.length === 7) return 'Every day'
  if (!ordered.length) return ''
  const runs: number[][] = []
  let lastDay: number | undefined
  for (const d of ordered) {
    const idx = MON_FIRST_ORDER.indexOf(d)
    const lastIdx = lastDay === undefined ? -1 : MON_FIRST_ORDER.indexOf(lastDay)
    const current = runs[runs.length - 1]
    if (current && idx === lastIdx + 1) {
      current.push(d)
    } else {
      runs.push([d])
    }
    lastDay = d
  }
  return runs
    .map((run) => {
      // Every `run` was built by pushing at least one day (either a fresh
      // `runs.push([d])` or an append onto an already-nonempty array) — safe
      // by construction, `noUncheckedIndexedAccess` just can't see that.
      const first = run[0] as number
      const last = run[run.length - 1] as number
      return run.length > 1 ? `${DAY_NAMES[first]}–${DAY_NAMES[last]}` : DAY_NAMES[first]
    })
    .join(', ')
}

/** A place's geometry as the flock `Geofence` shape the fences wire and the
 *  geofence-evaluation module both understand. */
export function placeToGeofence(place: Place): CircleGeofence {
  return { kind: 'circle', centre: place.centre, radiusMetres: place.radiusMetres }
}

/** Whichever of `places` is geographically closest to `point` — the
 *  guardian receive path's "which safe area did they leave" heuristic (see
 *  the module doc comment). `undefined` for an empty list. */
export function nearestPlace(places: readonly Place[], point: LatLng): Place | undefined {
  let best: Place | undefined
  let bestDist = Infinity
  for (const pl of places) {
    const d = haversineMetres(point, pl.centre)
    if (d < bestDist) { bestDist = d; best = pl }
  }
  return best
}

// ---------------------------------------------------------------------------
// Arrival/departure reason text — dynamic (place names are guardian-chosen
// free text), so unlike messages.ts's fixed `BUZZ_CHIP_REASONS` vocabulary
// this is a PREFIX match, not exact equality. Exported so messages.ts's own
// `classifyIncomingBuzz` can recognise these without duplicating the prefix
// strings (see that file's own doc comment for why an "Arrived at X" buzz
// must not be silently swallowed as unstructured chat).
// ---------------------------------------------------------------------------

const ARRIVAL_PREFIX = 'Arrived at '
const DEPARTURE_PREFIX = 'Left '

export function buildArrivalReason(placeName: string): string {
  return `${ARRIVAL_PREFIX}${placeName}`
}
export function buildDepartureReason(placeName: string): string {
  return `${DEPARTURE_PREFIX}${placeName}`
}
/** The place name from an "Arrived at X" buzz reason, or undefined if
 *  `reason` doesn't carry this prefix at all. An empty name (a place
 *  genuinely called "") is returned as `''`, not undefined — callers fall
 *  back to a generic label at render/record time, same as `nearestPlace`'s
 *  own "no match" handling. */
export function detectArrivalReason(reason: string): string | undefined {
  return reason.startsWith(ARRIVAL_PREFIX) ? reason.slice(ARRIVAL_PREFIX.length) : undefined
}
export function detectDepartureReason(reason: string): string | undefined {
  return reason.startsWith(DEPARTURE_PREFIX) ? reason.slice(DEPARTURE_PREFIX.length) : undefined
}

// ---------------------------------------------------------------------------
// Arrival-window "not yet" reason text (Phase 3 Task 5) — same dynamic-
// place-name, PREFIX-recognised idiom as `buildArrivalReason`/
// `buildDepartureReason` above, just with a SECOND dynamic field (the
// window's `arriveBy`) sitting in the middle, so `detectNotYetReason` needs
// a prefix+infix+suffix parse rather than a bare prefix strip. Rides the
// SAME untargeted circle-chat buzz mechanism (`sendPlaceBuzz`) — a flock
// client renders it as ordinary chat text, exactly like an arrival/
// departure buzz.
// ---------------------------------------------------------------------------

const NOT_YET_PREFIX = "Hasn't arrived at "
const NOT_YET_INFIX = ' yet (expected by '
const NOT_YET_SUFFIX = ')'

export function buildNotYetReason(placeName: string, hhmm: string): string {
  return `${NOT_YET_PREFIX}${placeName}${NOT_YET_INFIX}${hhmm}${NOT_YET_SUFFIX}`
}

/** The inverse of `buildNotYetReason` — strict prefix/suffix parse (mirrors
 *  `detectArrivalReason`'s "PREFIX match, not exact equality" discipline one
 *  level up): `undefined` unless `reason` both starts with the fixed prefix
 *  AND ends with the fixed suffix, with the fixed infix present somewhere in
 *  between. Uses the FIRST infix match — a place name that itself happens to
 *  contain the literal infix text is a corner case this simple parse doesn't
 *  disambiguate, same acceptable-tradeoff spirit as `nearestPlace`'s own
 *  "best guess, not a correlation buffer" doc comment. */
export function detectNotYetReason(reason: string): { place: string; time: string } | undefined {
  if (!reason.startsWith(NOT_YET_PREFIX) || !reason.endsWith(NOT_YET_SUFFIX)) return undefined
  const body = reason.slice(NOT_YET_PREFIX.length, reason.length - NOT_YET_SUFFIX.length)
  const infixIdx = body.indexOf(NOT_YET_INFIX)
  if (infixIdx === -1) return undefined
  return { place: body.slice(0, infixIdx), time: body.slice(infixIdx + NOT_YET_INFIX.length) }
}

// ---------------------------------------------------------------------------
// Child-first escalation copy — supportive, no accusation (global
// constraints §31 / task contract). Pure, exported for direct assertion in
// tests as well as reuse by the banner view below.
// ---------------------------------------------------------------------------

export function graceWarningCopy(placeName: string, graceMinutes: number): string {
  return `Looks like you've left ${placeName} — heading back? Your circle will be told in ${graceMinutes} min otherwise.`
}

export function escalatedChildCopy(placeName: string, immediate: boolean): string {
  return immediate
    ? `You've left ${placeName}. Your circle has been told.`
    : `Your circle has been told that you left ${placeName}.`
}

/** Child-facing copy for the window between "the state machine has decided
 *  this is an escalation" and "the breach signal actually reached the
 *  guardian" (review C1) — e.g. a cold launch with an already-expired grace
 *  deadline but no geolocation fix yet. Deliberately distinct from
 *  `escalatedChildCopy`'s past-tense "has been told" claim, which must only
 *  ever be shown once a send has genuinely gone out (`ensureBreachSent`
 *  below flips the banner from this copy to that one). */
export function escalationPendingCopy(placeName: string): string {
  return `You've left ${placeName}. Your circle will be told as soon as your location is available.`
}

// ---------------------------------------------------------------------------
// PURE escalation state machine — the module's core deliverable. No store,
// network, or clock access anywhere in this section; `nowSecValue` is always
// caller-supplied. Unit-tested exhaustively in places.test.ts: enter, leave
// (grace), cancel (re-entry within grace), expire (grace timeout), immediate
// mode, multiple places with overlapping unions, and the accuracy-aware
// `'uncertain'` fail-safe.
// ---------------------------------------------------------------------------

/** Per-circle escalation phase: `'safe'` (inside the union, or nothing
 *  configured), `'grace'` (outside, private countdown running), or
 *  `'escalated'` (grace expired, or an immediate-mode place — the state
 *  machine has DECIDED the guardian should be told). `breachSent` (review
 *  C1) tracks whether that telling has actually happened yet — `false`
 *  immediately on reaching this phase (a fix may not exist yet to disclose),
 *  flipped to `true` only once `ensureBreachSent` (below) has genuinely sent
 *  the breach signal or recognised it as an already-recent repeat. Never
 *  conflate "phase is escalated" with "guardian was told" — that conflation
 *  was exactly the bug.
 *
 *  `'leave-approved'` (Task 5, brief §13.4): the circle currently has an
 *  active, guardian-granted boundary-exit approval covering `placeId` —
 *  being outside it is treated as safe (no warning, no grace, no breach)
 *  until `until` (unix seconds) passes. Deliberately its OWN phase, not
 *  folded into `'safe'`: unlike genuine 'safe' (inside the union, or
 *  nothing configured), a stationary child sitting outside during an
 *  approved leave must still have `until`'s expiry checked every tick
 *  (`checkLeaveExpiry`, mirroring `checkGraceExpiry`'s own "independent of
 *  a fresh fix" discipline) so the NORMAL warning+grace flow resumes fresh
 *  the instant it passes — never an instant breach (task contract). Not
 *  itself persisted (see `placeEvalToPersisted`'s own doc comment) —
 *  `Persisted.approvedLeaves` is the actual source of truth this phase is
 *  re-derived from on every cold read. */
export type EscalationSubState =
  | { phase: 'safe' }
  | { phase: 'grace'; placeName: string; graceEndsAt: number }
  | { phase: 'escalated'; placeName: string; breachSent: boolean }
  | { phase: 'leave-approved'; placeId: string; placeName: string; until: number }

/** Per-circle evaluation state — module-level, held in-memory in full for
 *  the running session (`insidePlaceIds` in particular is NOT persisted;
 *  same "a reload loses only the in-flight bookkeeping, not anything a
 *  device can't recover" trade-off as safety.ts's own findreq/reason
 *  correlation buffers). `escalation` alone is minimally snapshotted to
 *  `Persisted.placeEval` on every change (see the module doc comment's
 *  "Reload safety" section) and hydrated back on a cold read — a reload
 *  loses the arrival/departure edge-detector memory, never an in-progress
 *  grace/escalated episode. `insidePlaceIds` is the last known set of
 *  places the fix was confidently within — doubles as the arrival/
 *  departure edge detector's memory AND the escalation supervisor's "what
 *  did I just leave" memory for naming purposes. */
export interface PlaceEvalState {
  insidePlaceIds: string[]
  escalation: EscalationSubState
}

export const INITIAL_PLACE_EVAL_STATE: PlaceEvalState = { insidePlaceIds: [], escalation: { phase: 'safe' } }

export type EscalationEffect =
  | { kind: 'warn'; placeName: string; graceMinutes: number }
  | { kind: 'cancel' }
  | { kind: 'escalate'; placeName: string; immediate: boolean }

export interface PlaceEvalResult {
  state: PlaceEvalState
  /** Place ids newly inside this tick (raw geometry, independent of the
   *  accuracy-aware escalation supervisor) — the caller filters by each
   *  place's own `arrivalNotify` before acting. */
  entered: string[]
  /** Place ids newly outside this tick — filtered by `departureNotify` by
   *  the caller. */
  exited: string[]
  escalationEffect?: EscalationEffect
}

/**
 * One evaluation tick against a fresh fix. `escalationEnabled` gates ONLY
 * the union escalation supervisor (brief §13.2: "for circles where a
 * safe-area policy applies to me AS CHILD" — the caller passes `false` for
 * a circle this device is a guardian of); `entered`/`exited` (arrival/
 * departure) are always computed regardless of role.
 *
 * `seedOnly` (review I1 fix, default `false`): when true, `insidePlaceIds`
 * in the returned state is still updated from this fix (so ordinary diffing
 * resumes correctly on the NEXT call), but `entered`/`exited` are forced
 * empty — this fix is establishing a baseline, not observing a real
 * transition. The caller (`tick()`) passes `true` for the first fix each
 * session evaluates against a given circle: without it, a reload's `state`
 * always hydrates with an empty `insidePlaceIds` (see the module doc
 * comment), so EVERY place the member happens to currently be inside would
 * otherwise look like a fresh arrival (and, symmetrically, a currently-
 * outside place like a fresh departure) purely from the reload itself.
 * Escalation is untouched by this flag — it already only ever reacts to
 * `classifyContainment`'s verdict on `point`, independent of `entered`/
 * `exited`, so a cold start that's genuinely outside every place still
 * starts grace/immediate exactly as before (the "no prior inside recorded"
 * fallback below).
 *
 * `leaveApprovedUntilFor` (Task 5, brief §13.4, default "nothing approved"):
 * caller-supplied lookup from placeId to an active approval's `until` unix-
 * seconds deadline, or `undefined` if none — kept as a plain function
 * parameter (not a `leaves`+`circleId`+`nowSecValue` triple) so this stays
 * a pure function of its OTHER arguments alone, same "caller closes over
 * whatever impure lookup it needs" idiom `tick()` already uses for its own
 * `beacons.selfFix()` read. Consulted ONLY on a fresh exit from `'safe'`
 * (see that branch below) — an escalation already mid-episode is untouched
 * here (re-checked every tick by `checkLeaveExpiry` instead, exactly
 * mirroring how `checkGraceExpiry` already handles grace's own time-based
 * expiry independently of this function).
 */
export function evaluatePlaces(
  places: readonly Place[],
  point: LatLng,
  accuracyMetres: number,
  nowSecValue: number,
  state: PlaceEvalState,
  escalationEnabled: boolean,
  seedOnly: boolean = false,
  leaveApprovedUntilFor: (placeId: string) => number | undefined = () => undefined,
): PlaceEvalResult {
  const nowInside = places.filter((pl) => isInside(point, placeToGeofence(pl))).map((pl) => pl.id)
  const nowSet = new Set(nowInside)
  const entered = seedOnly ? [] : nowInside.filter((id) => !state.insidePlaceIds.includes(id))
  const exited = seedOnly ? [] : state.insidePlaceIds.filter((id) => !nowSet.has(id))

  if (!escalationEnabled || !places.length) {
    return { state: { insidePlaceIds: nowInside, escalation: state.escalation }, entered, exited }
  }

  const containment = classifyContainment(point, accuracyMetres, places.map(placeToGeofence))

  if (containment === 'uncertain') {
    // Fail-safe (mirrors classifyContainment's own doc comment): the
    // escalation supervisor holds its CURRENT phase — an ambiguous fix near
    // a fence edge must never cry wolf, nor silently cancel a real episode.
    return { state: { insidePlaceIds: nowInside, escalation: state.escalation }, entered, exited }
  }

  if (containment === 'inside') {
    const wasGrace = state.escalation.phase === 'grace'
    return {
      state: { insidePlaceIds: nowInside, escalation: { phase: 'safe' } },
      entered,
      exited,
      ...(wasGrace ? { escalationEffect: { kind: 'cancel' as const } } : {}),
    }
  }

  // containment === 'outside'
  if (state.escalation.phase !== 'safe') {
    // Already mid-episode (grace or escalated) — expiry is time-based, not
    // re-decided on every subsequent still-outside fix (see
    // `checkGraceExpiry` below).
    return { state: { insidePlaceIds: nowInside, escalation: state.escalation }, entered, exited }
  }

  // Fresh exit from 'safe'. Decide grace vs. immediate from whichever
  // place(s) the PREVIOUS tick had us inside — the place(s) just left. If
  // none were recorded (e.g. the app started already outside every place),
  // fall back to treating every configured place as relevant: the device
  // genuinely doesn't know which one this fix left, and defaulting to "act
  // as if leaving all of them" is the conservative, safety-favouring choice.
  const exitedFrom = places.filter((pl) => state.insidePlaceIds.includes(pl.id))
  const relevant = exitedFrom.length ? exitedFrom : places
  const placeName = relevant[0]?.name ?? 'your safe area'

  // Task 5 (brief §13.4): an active approved leave for the place just left
  // suppresses this exit entirely — no warning, no grace, no breach. v1
  // scope (documented, not a redesign — same spirit as this function's own
  // "fall back to treating every configured place as relevant" choice just
  // above): keyed off `relevant[0]` alone, the SAME single representative
  // place this branch already privileges for `placeName`/`immediate` below
  // — a circle with several simultaneously-relevant places and an approval
  // for only one of them suppresses (or doesn't) as a GROUP, not per-place;
  // acceptable for the single-"home base" case this feature targets.
  const primaryPlaceId = relevant[0]?.id
  const leaveUntil = primaryPlaceId === undefined ? undefined : leaveApprovedUntilFor(primaryPlaceId)
  if (primaryPlaceId !== undefined && leaveUntil !== undefined) {
    return {
      state: { insidePlaceIds: nowInside, escalation: { phase: 'leave-approved', placeId: primaryPlaceId, placeName, until: leaveUntil } },
      entered,
      exited,
    }
  }

  const immediate = relevant.every((pl) => pl.escalation === 'immediate')

  if (immediate) {
    return {
      state: { insidePlaceIds: nowInside, escalation: { phase: 'escalated', placeName, breachSent: false } },
      entered,
      exited,
      escalationEffect: { kind: 'escalate', placeName, immediate: true },
    }
  }
  const graceCandidates = relevant.filter((pl) => pl.escalation === 'grace').map((pl) => pl.graceMinutes)
  const graceMinutes = graceCandidates.length ? Math.max(...graceCandidates) : DEFAULT_GRACE_MINUTES
  const graceEndsAt = nowSecValue + graceMinutes * 60
  return {
    state: { insidePlaceIds: nowInside, escalation: { phase: 'grace', placeName, graceEndsAt } },
    entered,
    exited,
    escalationEffect: { kind: 'warn', placeName, graceMinutes },
  }
}

/** Time-based grace expiry — independent of whether a fresh fix arrived
 *  this tick (a stationary child with no new fix must still have their
 *  grace period expire). No-op unless `state.escalation.phase === 'grace'`
 *  AND `nowSecValue` has reached `graceEndsAt`. */
export function checkGraceExpiry(state: PlaceEvalState, nowSecValue: number): { state: PlaceEvalState; effect?: EscalationEffect } {
  if (state.escalation.phase !== 'grace') return { state }
  if (nowSecValue < state.escalation.graceEndsAt) return { state }
  const placeName = state.escalation.placeName
  return {
    state: { ...state, escalation: { phase: 'escalated', placeName, breachSent: false } },
    effect: { kind: 'escalate', placeName, immediate: false },
  }
}

/** Time-based expiry for an active `'leave-approved'` episode (Task 5,
 *  brief §13.4) — mirrors `checkGraceExpiry`'s own "independent of whether
 *  a fresh fix arrived this tick" discipline exactly: a child sitting
 *  still, still outside, past `until`, must still get the normal warning
 *  even with no new GPS fix. No-op unless `state.escalation.phase ===
 *  'leave-approved'` AND `nowSecValue` has reached `until`. On expiry,
 *  resumes the NORMAL flow from the CURRENT position — task contract:
 *  "never an instant breach" — deciding fresh grace-vs-immediate from the
 *  approved place's OWN CURRENT escalation config (looked up fresh in
 *  `places`, not remembered from whenever the leave was granted — a
 *  guardian could in principle have edited the place's settings meanwhile).
 *  A place no longer present in `places` (deleted since the leave was
 *  granted) falls back to `DEFAULT_GRACE_MINUTES`/`'grace'`, same fail-safe
 *  default `hydratePlaceEvalState` uses for a malformed persisted record. */
export function checkLeaveExpiry(state: PlaceEvalState, places: readonly Place[], nowSecValue: number): { state: PlaceEvalState; effect?: EscalationEffect } {
  if (state.escalation.phase !== 'leave-approved') return { state }
  if (nowSecValue < state.escalation.until) return { state }
  const placeName = state.escalation.placeName
  const placeId = state.escalation.placeId
  const place = places.find((pl) => pl.id === placeId)
  if (place?.escalation === 'immediate') {
    return {
      state: { ...state, escalation: { phase: 'escalated', placeName, breachSent: false } },
      effect: { kind: 'escalate', placeName, immediate: true },
    }
  }
  const graceMinutes = place?.graceMinutes ?? DEFAULT_GRACE_MINUTES
  const graceEndsAt = nowSecValue + graceMinutes * 60
  return {
    state: { ...state, escalation: { phase: 'grace', placeName, graceEndsAt } },
    effect: { kind: 'warn', placeName, graceMinutes },
  }
}

// ---------------------------------------------------------------------------
// Reload safety (Task 7 follow-up fix) — `evalState` (below) is module-
// level, in-memory only, so without this a child could force-close the app
// during a grace countdown to reset it indefinitely and never trigger the
// guardian signal. `hydratePlaceEvalState`/`placeEvalToPersisted` are the
// pure mapping between `PlaceEvalState` (this module's own richer shape)
// and `store.PersistedPlaceEval` (store.ts's minimal persisted snapshot —
// just enough to RESUME a grace countdown with its ORIGINAL deadline, or
// know an episode is already `'escalated'`, across a reload). `'safe'` is
// never itself persisted: absence of a circleId entry in
// `Persisted.placeEval` IS 'safe' — `tick()` (below) deletes the entry the
// moment a circle returns to safe, which is also this mechanism's "genuine
// re-entry resets it" half.
//
// `shouldSuppressEscalation` is a SEPARATE, independent guard — defense in
// depth alongside the phase hydration above, not a replacement for it: even
// if hydration somehow failed to restore 'grace'/'escalated' correctly, this
// still stops a duplicate breach signal (and duplicate guardian-facing
// Activity entry/notification) from firing purely because the app reloaded
// while continuously outside — see `ensureBreachSent` below, the only
// caller.
// ---------------------------------------------------------------------------

/** `undefined`/`'safe'` → nothing to resume, start fresh. A malformed
 *  persisted record (e.g. a 'grace' entry missing `graceEndsAt` — should
 *  never happen from this module's own writes, but `store.load()`'s own
 *  coercion doesn't deep-validate) fails safe to `INITIAL_PLACE_EVAL_STATE`
 *  rather than crashing or resuming a nonsensical countdown. An 'escalated'
 *  record's `breachSent` (review C1) coerces any non-`true` value (missing —
 *  an old-format record from before this fix — or malformed) to `false`: the
 *  safe default, since it can only cause `ensureBreachSent` to re-attempt a
 *  send already guarded by `shouldSuppressEscalation`, never suppress a real
 *  one. */
export function hydratePlaceEvalState(persisted: store.PersistedPlaceEval | undefined): PlaceEvalState {
  if (!persisted || typeof persisted.placeName !== 'string') return INITIAL_PLACE_EVAL_STATE
  if (persisted.phase === 'grace') {
    if (typeof persisted.graceEndsAt !== 'number' || !Number.isFinite(persisted.graceEndsAt)) return INITIAL_PLACE_EVAL_STATE
    return { insidePlaceIds: [], escalation: { phase: 'grace', placeName: persisted.placeName, graceEndsAt: persisted.graceEndsAt } }
  }
  if (persisted.phase === 'escalated') {
    return { insidePlaceIds: [], escalation: { phase: 'escalated', placeName: persisted.placeName, breachSent: persisted.breachSent === true } }
  }
  return INITIAL_PLACE_EVAL_STATE
}

/** The inverse mapping — what `Persisted.placeEval[circleId]` should become
 *  given the CURRENT `PlaceEvalState`. `undefined` means "clear the entry"
 *  (phase is `'safe'`) — `tick()` (below) is the one caller, and treats
 *  `undefined` as a delete. */
export function placeEvalToPersisted(state: PlaceEvalState): store.PersistedPlaceEval | undefined {
  const esc = state.escalation
  // 'leave-approved' (Task 5) is deliberately treated the same as 'safe'
  // here — nothing to snapshot: `Persisted.approvedLeaves` is ALREADY the
  // correctly-persisted source of truth this phase is re-derived from (see
  // `evaluatePlaces`'s own leave-approved branch), so a reload's hydration
  // resuming 'safe' and then re-entering 'leave-approved' on the very next
  // fresh-exit evaluation (with the SAME `until`, read fresh from
  // `Persisted.approvedLeaves`) is exactly as correct as snapshotting it
  // here would be, with no separate persisted shape to keep in sync.
  if (esc.phase === 'safe' || esc.phase === 'leave-approved') return undefined
  if (esc.phase === 'grace') return { phase: 'grace', placeName: esc.placeName, graceEndsAt: esc.graceEndsAt }
  return { phase: 'escalated', placeName: esc.placeName, breachSent: esc.breachSent }
}

/** How long a circle+place's breach signal, once actually sent, suppresses
 *  a repeat send — task contract: "say, 30 min". Exported as a named
 *  constant (not inlined) so the test suite and this doc comment agree on
 *  what "the suppression window" means. */
export const ESCALATION_SUPPRESS_SEC = 30 * 60

/** Pure predicate: given the last time THIS circle+place's breach signal was
 *  actually sent (`undefined` if never), should a fresh 'escalate' at `at`
 *  be suppressed? `undefined` (never sent, or cleared by a genuine
 *  re-entry — see the section doc comment) is never suppressed. */
export function shouldSuppressEscalation(lastEscalatedAt: number | undefined, at: number, windowSec: number = ESCALATION_SUPPRESS_SEC): boolean {
  return lastEscalatedAt !== undefined && at - lastEscalatedAt < windowSec
}

// ---------------------------------------------------------------------------
// Boundary-exit requests (Phase 5 Task 5, brief §13.4) — rides approvals.ts's
// EXISTING approval-req/resp wire (no new wire type). `LeaveAreaParams` is
// the free-form ask; `LEAVE_AREA_ENVELOPE_ACTION` is the borrowed
// `PolicyAction` `ApprovalReq.action` actually carries on the wire; the
// params-encoding choice, WHY a borrowed envelope is needed at all, and the
// wire-compat reasoning behind picking `'add-contact'` specifically all
// live on `LEAVE_AREA_ENVELOPE_ACTION`'s own doc comment and on
// approvals.ts's `LEAVE_AREA_MARKER`/`PARAMS_KIND_KEY`. This section is the
// PURE half: encode/decode, `isLeaveApproved`/`leaveApprovedUntil`, the
// "same reducer both devices apply" convergence function
// (`applyLeaveResolution`), and `pruneExpiredLeaves` — unit-tested directly
// in places.test.ts, no store/network access anywhere here. The impure
// orchestration (escalation-suppression wiring, the "Ask to go out" UI, the
// two approvals.ts registrations) follows further down, alongside `tick()`/
// `ensure()`.
// ---------------------------------------------------------------------------

/** The `ApprovalReq.params` marker this feature's requests carry (see
 *  approvals.ts's `LEAVE_AREA_MARKER` — duplicated there, not imported, so
 *  approvals.ts need not import this module; kept in sync by both files'
 *  wire round-trip tests). */
export const LEAVE_AREA_KIND = 'leave-area'

/** The wire envelope this feature's approval-req/resp actually rides.
 *  `ApprovalReq.action` is BROOD's own closed `PolicyAction` enum —
 *  verified EMPIRICALLY (not merely by reading the `.d.ts`) that its real
 *  parser, `parseApprovalReq`, hard-rejects any `action` outside
 *  `{create-circle, add-member, join-circle, add-contact}`: a literal
 *  `action: 'leave-area'` builds fine locally (BROOD's builders do no
 *  validation) but a receiving device's `parseBroodSignal` returns `null`
 *  for it — the request would silently never reach a guardian's inbox at
 *  all. So the actual encoding choice here has TWO parts: (1) `action`
 *  borrows an existing, real `PolicyAction` value as an opaque envelope;
 *  (2) `params` (the one genuinely free-form `Record<string,string>` field
 *  `ApprovalReq` carries) holds BOTH `LEAVE_AREA_KIND` as a self-
 *  identifying marker AND every `LeaveAreaParams` field, all as plain
 *  strings — `parseParams` (BROOD) only requires every VALUE to be a
 *  string, never restricts KEYS, so this round-trips through the real wire
 *  parser untouched (verified in approvals.test.ts/places.test.ts).
 *
 *  `'add-contact'` specifically: NOT `'create-circle'`/`'add-member'` —
 *  circles.ts registers a real `registerApprovalAction` handler for both of
 *  those (`createCircleNow`/`reRunAddMember`), and an approved
 *  borrowed-envelope request naming either would risk that handler running
 *  with leave-area's own params on the requester's device the moment it's
 *  granted (approvals.ts's `runApprovedAction` now guards against this
 *  generically via `PARAMS_KIND_KEY`, but choosing an envelope nothing
 *  ELSE is wired to is the least-hacky starting point regardless).
 *  `'join-circle'`/`'add-contact'` both have no registered handler today
 *  (verified by inspection); `'add-contact'` is picked over `'join-circle'`
 *  arbitrarily between the two equally-safe options.
 *
 *  Wire-compat with an OLD client (a kindependence build from before this task,
 *  or any other BROOD-speaking client): it decodes the request
 *  perfectly fine as a real, structurally-valid `'add-contact'`
 *  `approval-req` — it just has no idea what the extra `params` fields
 *  mean, and renders it as an ordinary (if oddly-labelled) "wants to add a
 *  new contact" approval card. That's the accepted, documented trade-off
 *  (task contract: "old clients render it as an opaque approval —
 *  acceptable") — no crash, no dropped signal, just a less legible card on
 *  a build that hasn't been taught the marker yet. */
export const LEAVE_AREA_ENVELOPE_ACTION: PolicyAction = 'add-contact'

/** Task-contract duration choices (minutes) — 30 min / 1 h / 2 h. */
export const LEAVE_AREA_DURATIONS_MIN = [30, 60, 120] as const
export type LeaveAreaDurationMin = (typeof LEAVE_AREA_DURATIONS_MIN)[number]

/** The task's own interface, verbatim. `precisionTerm` is the disclosure
 *  precision the child is proposing to keep sharing at while away (task
 *  contract: "the location precision they agree to share") — COMPUTED from
 *  the circle's current effective baseline at ask-time (`submitLeaveForm`
 *  below), not a separate user choice; brief §13.4's UI list names
 *  destination/who/duration as the form fields, not a precision picker. */
export interface LeaveAreaParams {
  placeName: string
  placeId: string
  destination: string
  withWho: string
  durationMin: LeaveAreaDurationMin
  precisionTerm: string
}

/** Whether `params` (an `ApprovalReq.params`, from either side of the wire)
 *  is a leave-area request — the ONE check every leave-area-aware call
 *  site (this module's own escalation/UI code, and approvals.ts's
 *  duplicated `LEAVE_AREA_MARKER` check) gates on. */
export function isLeaveAreaRequest(params: Record<string, string>): boolean {
  return params.kind === LEAVE_AREA_KIND
}

/** `LeaveAreaParams` -> the wire `params` shape (`raiseApproval`'s own
 *  `Record<string,string>` contract) — every field a plain string,
 *  `durationMin` stringified. */
export function encodeLeaveAreaParams(p: LeaveAreaParams): Record<string, string> {
  return {
    kind: LEAVE_AREA_KIND,
    placeName: p.placeName,
    placeId: p.placeId,
    destination: p.destination,
    withWho: p.withWho,
    durationMin: String(p.durationMin),
    precisionTerm: p.precisionTerm,
  }
}

/** The inverse of `encodeLeaveAreaParams` — strict validation (same "reject
 *  the whole thing on any malformed field" discipline as `parsePlace`
 *  elsewhere in this file): `null` unless `isLeaveAreaRequest`, every
 *  string field is present, and `durationMin` is one of
 *  `LEAVE_AREA_DURATIONS_MIN`. */
export function decodeLeaveAreaParams(params: Record<string, string>): LeaveAreaParams | null {
  if (!isLeaveAreaRequest(params)) return null
  if (typeof params.placeName !== 'string' || !params.placeName) return null
  if (typeof params.placeId !== 'string' || !params.placeId) return null
  if (typeof params.destination !== 'string') return null
  if (typeof params.withWho !== 'string') return null
  if (typeof params.precisionTerm !== 'string') return null
  const durationMin = Number(params.durationMin)
  if (!(LEAVE_AREA_DURATIONS_MIN as readonly number[]).includes(durationMin)) return null
  return {
    placeName: params.placeName, placeId: params.placeId, destination: params.destination, withWho: params.withWho,
    durationMin: durationMin as LeaveAreaDurationMin, precisionTerm: params.precisionTerm,
  }
}

type ApprovedLeaves = Record<string, Array<{ placeId: string; until: number }>>

/** `circleId`+`placeId`'s active approval's `until` (unix seconds), or
 *  `undefined` if none is currently active — `isLeaveApproved` below is a
 *  thin boolean wrapper over this; `evaluatePlaces`'s own suppression check
 *  needs the actual deadline, not just a yes/no, hence the two-function
 *  split. If more than one entry somehow names the same `placeId` (should
 *  never happen given `applyLeaveResolution`'s own replace-not-append rule,
 *  but a malformed/foreign persisted blob could in principle carry one),
 *  the LATEST still-active `until` wins — the most generous reading, same
 *  "fail toward not punishing an already-granted leave" spirit as the rest
 *  of this feature. */
export function leaveApprovedUntil(leaves: ApprovedLeaves, circleId: string, placeId: string, nowSecValue: number): number | undefined {
  const entries = leaves[circleId]
  if (!entries) return undefined
  let best: number | undefined
  for (const e of entries) {
    if (e.placeId === placeId && e.until > nowSecValue && (best === undefined || e.until > best)) best = e.until
  }
  return best
}

/** Task interface, verbatim: whether `placeId` currently has an active,
 *  unexpired approved leave under `circleId`. */
export function isLeaveApproved(leaves: ApprovedLeaves, circleId: string, placeId: string, nowSecValue: number): boolean {
  return leaveApprovedUntil(leaves, circleId, placeId, nowSecValue) !== undefined
}

/** The "same reducer, both devices" convergence function (task contract) —
 *  approvals.ts's registered resolution listener calls this identically on
 *  the answering guardian's device (from its own resp send) and on every
 *  device that receives the resp over the wire (including, but not
 *  restricted to, the original requester — see store.ts's own doc comment
 *  on `Persisted.approvedLeaves`'s circleId+placeId-only scoping). A no-op
 *  (returns `leaves` unchanged) on a denial — nothing to record. `until =
 *  resp.at + durationMin*60` — the APPROVAL time starts the clock, never
 *  `req.at` (the ask time): the window a family agreed to is measured from
 *  when they actually said yes, not from whenever the child happened to
 *  tap "Ask" (which could be minutes or hours before an answer arrives).
 *  REPLACES (not appends to) any existing entry for the same placeId — a
 *  fresh approval for a place already covered simply extends/resets the
 *  window, rather than accumulating stale duplicate entries. */
export function applyLeaveResolution(leaves: ApprovedLeaves, circleId: string, params: LeaveAreaParams, resp: { ok: boolean; at: number }): ApprovedLeaves {
  if (!resp.ok) return leaves
  const until = resp.at + params.durationMin * 60
  const existing = leaves[circleId] ?? []
  const next = [...existing.filter((e) => e.placeId !== params.placeId), { placeId: params.placeId, until }]
  return { ...leaves, [circleId]: next }
}

/** Task contract's "prune-on-expiry" — drops every entry whose `until` has
 *  already passed, and drops a circle's key entirely once it has none left
 *  (matches `Persisted.approvedLeaves`'s "absent circleId means nothing
 *  approved" convention `leaveApprovedUntil`/`isLeaveApproved` already
 *  assume). Returns the SAME reference when nothing changes — same
 *  no-op-returns-same-reference idiom as `upsertFamilyPolicy`/
 *  `applyRecordActivity` elsewhere in this codebase. Purely a housekeeping
 *  pass, not a correctness requirement: `leaveApprovedUntil` already treats
 *  a stale entry as absent regardless (`e.until > nowSecValue`), so a
 *  missed prune only means slower-than-ideal cleanup, never a wrong
 *  suppression decision. */
export function pruneExpiredLeaves(leaves: ApprovedLeaves, nowSecValue: number): ApprovedLeaves {
  let changed = false
  const next: ApprovedLeaves = {}
  for (const [circleId, entries] of Object.entries(leaves)) {
    const kept = entries.filter((e) => e.until > nowSecValue)
    if (kept.length !== entries.length) changed = true
    if (kept.length) next[circleId] = kept
  }
  return changed ? next : leaves
}

// ---------------------------------------------------------------------------
// Arrival windows — pure evaluation (Phase 3 Task 5). `windowAction` is THE
// decision function for one window on one day: given whether the child is
// currently inside the window's place (`insideNow`, from `tick()`'s own
// `state.insidePlaceIds` — see that function's own doc comment on why a
// no-fix tick evaluates against the PRIOR inside-state rather than inventing
// a fresh one) and today's mark (if any), it decides the one thing that's
// due. All impurity this section needs flows through `localDay` alone —
// `windowAction` itself never touches `Date`/the clock/the store, so the
// full decision matrix is directly unit-testable against a fixed `LocalDay`
// fixture (places.test.ts).
// ---------------------------------------------------------------------------

/** How far ahead of `arriveBy` a `'remind'` fires — 15 minutes. */
export const WINDOW_REMINDER_LEAD_SEC = 900

/** How far BEFORE `arriveBy` an inside-fix still counts as "arrived for
 *  today's window" (`'mark-met'`, or a fired-then-arrived `'late-arrival'`)
 *  — 60 minutes. Guards against an early same-day fix (e.g. a school drop-
 *  off hours before the actual expected-by time) being credited to a window
 *  it isn't really answering yet. */
export const WINDOW_MET_LOOKBACK_SEC = 3600

/** One evaluation instant, device-LOCAL (matches `ArrivalWindow.arriveBy`'s
 *  own device-local `'HH:MM'` convention, and `Persisted.arrivalWindowMarks`'s
 *  `'YYYY-MM-DD'` day key) — the ONE impure-adjacent seam this whole section
 *  flows through. `localDay(new Date())` is `tick()`'s only clock read for
 *  window evaluation; everything downstream (`windowAction`) takes the
 *  result, never `Date` itself. */
export interface LocalDay { dayStamp: string; secOfDay: number; dayOfWeek: number }

export function localDay(d: Date): LocalDay {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return {
    dayStamp: `${y}-${m}-${day}`,
    secOfDay: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds(),
    dayOfWeek: d.getDay(),
  }
}

export type WindowAction = 'none' | 'mark-met' | 'remind' | 'fire' | 'late-arrival'

/** The shape of one `Persisted.arrivalWindowMarks` entry, aliased here so
 *  `windowAction`'s signature doesn't repeat store.ts's own literal (the
 *  mark shape has no name of its own there — see that file's doc comment on
 *  `Persisted.arrivalWindowMarks`). */
type WindowMark = store.Persisted['arrivalWindowMarks'][string]

/**
 * THE decision function (task contract) — pure, day-scoped: a `mark` from
 * any day OTHER than `day.dayStamp` (yesterday's leftover for a recurring
 * weekly window, or simply absent) counts as empty, exactly as if no mark
 * existed yet today.
 *
 * Precedence, exactly as specified:
 *  1. Disabled, or today's weekday isn't in `w.days` → `'none'`.
 *  2. Already marked met today → `'none'` (nothing left to decide).
 *  3. Inside now: `'mark-met'` once `secOfDay` reaches `arriveBy -
 *     WINDOW_MET_LOOKBACK_SEC` (too early inside a fix stays `'none'` — see
 *     that constant's own doc comment) — or `'late-arrival'` INSTEAD when
 *     today's mark already has `fired` set (the fired-then-arrived closure:
 *     the guardian was already told "not yet", so this is a DIFFERENT wire
 *     signal — a real arrival buzz — not a second `'mark-met'`).
 *  4. Not inside: `'remind'` once within `WINDOW_REMINDER_LEAD_SEC` of the
 *     deadline and not yet reminded today; `'fire'` once `graceMin` past the
 *     deadline and not yet fired today; otherwise `'none'` (including the
 *     quiet gap between the deadline itself and `deadline + graceMin`, and
 *     the whole period before the reminder lead — task contract, not an
 *     oversight).
 */
export function windowAction(w: ArrivalWindow, insideNow: boolean, mark: WindowMark | undefined, day: LocalDay): WindowAction {
  if (!w.enabled || !w.days.includes(day.dayOfWeek)) return 'none'
  const deadline = parseHHMM(w.arriveBy)
  if (deadline === null) return 'none' // malformed arriveBy can't reach here given parsePlace's strict upstream validation — fails safe rather than throwing
  const today = mark && mark.day === day.dayStamp ? mark : undefined
  if (today?.met) return 'none'

  if (insideNow) {
    if (day.secOfDay < deadline - WINDOW_MET_LOOKBACK_SEC) return 'none'
    return today?.fired ? 'late-arrival' : 'mark-met'
  }

  if (day.secOfDay >= deadline - WINDOW_REMINDER_LEAD_SEC && day.secOfDay < deadline && !today?.reminded) return 'remind'
  const grace = w.graceMin * 60
  if (day.secOfDay >= deadline + grace && !today?.fired) return 'fire'
  return 'none'
}

// ---------------------------------------------------------------------------
// Wire — fences (flock-interop, geometry only) + this module's own
// "kindependence-places" metadata companion. Both round-trip tested in
// places.test.ts against the PACKAGE's own parser (`decryptFences`) for the
// fences half, and against `parsePlacesMetaSignal` for the metadata half.
// ---------------------------------------------------------------------------

/** The metadata companion payload's own `t` field — a kindependence-only
 *  extension of flock's `t` vocabulary (same "discriminated by a new `t`"
 *  pattern BROOD's own signals already establish — see agreements.ts's
 *  module doc comment). Signet identity plan, Task 9: this module's places
 *  metadata is now an identity-signed STRUCTURAL action (`'places'`,
 *  structural.ts's `StructuralAction`), queued for the identity signer
 *  (structural-queue.ts) rather than gift-wrapped directly by a phone key —
 *  the payload's own `t` stays as a belt-and-braces shape check (mirrors
 *  every other structural payload's `d`/`t` self-description), but the wire
 *  DISPATCH tag a phone-signed legacy `'kindependence-places'` used to ride
 *  is gone: beacons.ts's receive choke point drops any phone-sealed rumor
 *  tagged with a structural action outright (`STRUCTURAL_ACTIONS.has(t)`),
 *  so there is no longer a phone-signed places-metadata wire form to accept
 *  at all.
 *
 *  DELIBERATE wire-breaking change (Task 9 fix round 1, finding 7): this
 *  constant's own VALUE changed from `'kindependence-places'` to `'places'`
 *  — the exported NAME `PLACES_SIGNAL_TYPE` is unchanged (so every existing
 *  test reference still compiles), but a device still running the pre-Task-9
 *  build would neither recognise nor accept this wire form. Accepted without
 *  a compat shim because there is no installed base of this app yet — same
 *  "no back-compat owed" premise the whole Signet identity plan migration
 *  runs on (see the plan's own migration notes). */
export const PLACES_SIGNAL_TYPE = 'places'

interface PlacesMetaSignal {
  t: typeof PLACES_SIGNAL_TYPE
  circleId: string
  places: Place[]
  updatedAt: number
  by: string
}

/** The plain JSON payload for the `'places'` structural action — no
 *  signing/wrapping of its own (structural-queue.ts signs it as the
 *  identity, beacons.ts's `sendStructural` gift-wraps the signed event to
 *  the circle inbox, phone-key sealed). */
export function buildPlacesMetaPayload(circleId: string, places: readonly Place[], updatedAt: number, by: string): string {
  const signal: PlacesMetaSignal = { t: PLACES_SIGNAL_TYPE, circleId, places: [...places], updatedAt, by }
  return JSON.stringify(signal)
}

/** Builds the real flock `fences` signal (geometry only) for a circle's
 *  complete place set, gift-wrapped and phone-key sealed — real flock-
 *  interop traffic, unaffected by the Signet identity plan (a plain flock
 *  client has no concept of an identity-signed structural envelope, so this
 *  half must stay ordinary circle traffic for interop to keep working).
 *  Pure apart from the crypto/wrap calls, so directly round-trip testable
 *  without a relay. */
export async function buildPlacesFencesWrap(
  signer: Signer,
  circle: Circle,
  places: readonly Place[],
  updatedAt: number,
  by: string,
): Promise<SignedEvent> {
  const set: FenceSet = { fences: places.map(placeToGeofence), updatedAt, by }
  const fencesInner = await buildFencesSignal({ groupId: circle.id, seedHex: circle.seedHex, set })
  const inbox = deriveInbox(circle.seedHex)
  return giftWrap(signer, inbox.pk, fencesInner, inbox.pk)
}

const PLACE_TYPES_SET = new Set<string>(PLACE_TYPES)
const ESCALATION_MODES = new Set<EscalationMode>(['grace', 'immediate'])

/** Strict single-window validation (Phase 3 Task 4) — mirrors `parsePlace`'s
 *  own field-by-field discipline one level down. `days`: 1-7 entries, each
 *  an integer 0-6, no duplicates (a `Set` catches both the range check's
 *  complement and the dupe check in one pass). `null` on anything malformed;
 *  the caller (`parsePlace`) rejects the WHOLE place set on a single bad
 *  window, same "never partially apply" discipline as every other field
 *  here. */
function parseArrivalWindow(o: unknown): ArrivalWindow | null {
  if (typeof o !== 'object' || o === null) return null
  const r = o as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (!Array.isArray(r.days) || r.days.length < 1 || r.days.length > 7) return null
  const seen = new Set<number>()
  for (const d of r.days) {
    if (typeof d !== 'number' || !Number.isInteger(d) || d < 0 || d > 6 || seen.has(d)) return null
    seen.add(d)
  }
  if (typeof r.arriveBy !== 'string' || parseHHMM(r.arriveBy) === null) return null
  if (typeof r.graceMin !== 'number' || !Number.isFinite(r.graceMin) || r.graceMin < 0 || r.graceMin > 120) return null
  if (typeof r.enabled !== 'boolean') return null
  return { id: r.id, days: r.days as number[], arriveBy: r.arriveBy, graceMin: r.graceMin, enabled: r.enabled }
}

function parsePlace(o: unknown): Place | null {
  if (typeof o !== 'object' || o === null) return null
  const r = o as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.name !== 'string') return null
  if (typeof r.type !== 'string' || !PLACE_TYPES_SET.has(r.type)) return null
  const centre = r.centre as { lat?: unknown; lon?: unknown } | undefined
  if (!centre || typeof centre.lat !== 'number' || typeof centre.lon !== 'number' || !Number.isFinite(centre.lat) || !Number.isFinite(centre.lon)) return null
  if (typeof r.radiusMetres !== 'number' || !Number.isFinite(r.radiusMetres) || r.radiusMetres <= 0) return null
  if (typeof r.arrivalNotify !== 'boolean' || typeof r.departureNotify !== 'boolean') return null
  if (typeof r.escalation !== 'string' || !ESCALATION_MODES.has(r.escalation as EscalationMode)) return null
  if (typeof r.graceMinutes !== 'number' || !Number.isFinite(r.graceMinutes) || r.graceMinutes < 0) return null
  // Phase 3 Task 4: `arrivalWindows` is OPTIONAL — absent is fine (an older
  // place, or one with no expected-arrival rules yet). Present means a
  // strictly-validated array, capped at MAX_WINDOWS_PER_PLACE, every entry
  // valid — one malformed window rejects the WHOLE place set, same
  // discipline as `parsePlacesMetaSignal`'s own "one bad place rejects the
  // whole set" rule one level up.
  let arrivalWindows: ArrivalWindow[] | undefined
  if (r.arrivalWindows !== undefined) {
    if (!Array.isArray(r.arrivalWindows) || r.arrivalWindows.length > MAX_WINDOWS_PER_PLACE) return null
    const windows: ArrivalWindow[] = []
    for (const raw of r.arrivalWindows) {
      const w = parseArrivalWindow(raw)
      if (!w) return null
      windows.push(w)
    }
    arrivalWindows = windows
  }
  return {
    id: r.id,
    name: r.name.slice(0, MAX_PLACE_NAME_LEN),
    type: r.type as PlaceType,
    centre: { lat: centre.lat, lon: centre.lon },
    radiusMetres: r.radiusMetres,
    arrivalNotify: r.arrivalNotify,
    departureNotify: r.departureNotify,
    escalation: r.escalation as EscalationMode,
    graceMinutes: r.graceMinutes,
    ...(arrivalWindows !== undefined ? { arrivalWindows } : {}),
  }
}

/** Decode + strictly validate a `kindependence-places` rumor's content —
 *  mirrors `decryptFences`'s own discipline (reject the WHOLE set on any
 *  malformed entry, never partially apply — a malformed set must never
 *  silently disable arrival/departure/escalation for the rest). Returns
 *  null for anything malformed, wrong-circle, or oversized; never throws. */
export function parsePlacesMetaSignal(content: string, expectedCircleId: string): { places: Place[]; updatedAt: number; by: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const r = parsed as Record<string, unknown>
  if (r.t !== PLACES_SIGNAL_TYPE) return null
  if (r.circleId !== expectedCircleId) return null
  if (typeof r.updatedAt !== 'number' || typeof r.by !== 'string') return null
  if (!Array.isArray(r.places) || r.places.length > MAX_PLACES) return null
  const places: Place[] = []
  for (const raw of r.places) {
    const pl = parsePlace(raw)
    if (!pl) return null
    places.push(pl)
  }
  return { places, updatedAt: r.updatedAt, by: r.by }
}

// ---------------------------------------------------------------------------
// Guardian outbound — create/edit/delete a circle's place set.
// ---------------------------------------------------------------------------

export type NewPlaceDraft = Omit<Place, 'id'>

/** New-place grace-minutes default (Phase 6 final-review finding 6): the
 *  circle's own independence-level default — `store.Persisted.levelDefaults`,
 *  written by `milestones.applyLevel`'s own step (a) every time a level is
 *  applied, owned by that module — when one exists, else this file's own
 *  generic `DEFAULT_GRACE_MINUTES`. Exported + pure (a plain `p` snapshot in,
 *  a number out) so it's directly testable without the DOM `submitPlaceForm`
 *  below wraps it in (build-gated, same convention as the rest of this
 *  file's UI layer); milestones.test.ts's own `applyLevel` test exercises the
 *  end-to-end "a level apply changes what a NEW place defaults to" behaviour
 *  this exists for. */
export function defaultGraceMinutesFor(p: store.Persisted, circleId: string): number {
  return p.levelDefaults[circleId]?.graceMinutes ?? DEFAULT_GRACE_MINUTES
}

// ---------------------------------------------------------------------------
// Final fix round 3, F2: `places` goes through the STRUCTURAL queue
// (identity-signed), same as approvals.ts's `family-policy`/`approval-resp`
// and agreements.ts's `agreement`/`extend-resp`, and like them does NOT
// change local state at enqueue: until the signed update has gone out it
// shows only in the structural queue's "Pending" banner. The 'places'
// sender below applies it locally (latest-wins, as a receiver would) and
// only then sends the phone-signed flock `fences` geometry wrap (final fix
// B1/I1) — a flock-interop client never sees fences the circle didn't
// authorise, and a cancel or dismiss has nothing to undo.
// ---------------------------------------------------------------------------

/** Guardian-only: queues the identity-signed update making `places`
 *  circleId's new complete set (full replacement, task contract); it is
 *  applied locally once sent, not before (final fix round 3, F2).
 *  Silently no-ops for a non-guardian or unknown circle/identity — same
 *  "circle-role check, not a policy gate" discipline as safety.ts's
 *  `requestPickup`. The phone-signed flock `fences` wrap (final fix B1/I1)
 *  is sent from the 'places' structural sender below, AFTER the
 *  identity-signed update has actually gone out — not from here. */
export async function savePlaces(circleId: string, places: Place[]): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle || !isGuardian(circle, self.identityPk)) return
  const at = nowSec()
  enqueue({ action: 'places', circleId, payload: buildPlacesMetaPayload(circleId, places, at, self.identityPk), label: `Update places for ${circle.name}` })
}

export async function addPlace(circleId: string, draft: NewPlaceDraft): Promise<void> {
  const current = store.load().places[circleId] ?? []
  if (current.length >= MAX_PLACES) return
  await savePlaces(circleId, [...current, { id: newPlaceId(), ...draft }])
}

export async function deletePlace(circleId: string, placeId: string): Promise<void> {
  const current = store.load().places[circleId] ?? []
  await savePlaces(circleId, current.filter((pl) => pl.id !== placeId))
}

function memberName(circle: Circle, pk: string): string {
  return circle.members.find((m) => m.pk === pk)?.name || `${pk.slice(0, 8)}…`
}

// ---------------------------------------------------------------------------
// Child-side private escalation banner — module-level, ephemeral (never
// persisted, never synced: this is the PRIVATE half of child-first
// escalation, brief §2.5). Keyed by circleId.
// ---------------------------------------------------------------------------

interface EscalationBanner { placeName: string; graceEndsAt?: number; escalated?: boolean; sent?: boolean }
const banners = new Map<string, EscalationBanner>()

function setBanner(circleId: string, b: EscalationBanner): void {
  banners.set(circleId, b)
}
function clearBanner(circleId: string): void {
  banners.delete(circleId)
}

// ---------------------------------------------------------------------------
// Outbound arrival/departure send — Phase 7 Task 3 moved this off flock's
// `t:'buzz'` (which now rejects free text) onto kindependence's own
// `t:'kindependence-msg'` via the shared codec (`buildKindependenceMsgSignal`), same
// "each module owns its own near-identical wrap builder" convention as
// messages.ts's `buildKindependenceMsgWrap`, untargeted (whole circle).
// ---------------------------------------------------------------------------

async function sendPlaceBuzz(selfPk: string, circle: Circle, reason: string, at: number): Promise<void> {
  const inner = await buildKindependenceMsgSignal({ groupId: circle.id, seedHex: circle.seedHex, from: selfPk, reason, timestamp: at })
  const inbox = deriveInbox(circle.seedHex)
  const wrap = await giftWrap(phoneSigner(), inbox.pk, inner, inbox.pk)
  await beacons.publishOrEnqueue(appRelays(store.load()), wrap)
}

function recordLocalPlaceActivity(kind: 'arrival' | 'departure', circleId: string, actorPk: string, placeName: string, at: number): void {
  activity.recordActivity({ id: activity.localActivityId(kind, at, circleId), at, kind, circleId, actorPk, params: { place: placeName } })
}

/** Returns whether a fix existed to disclose (and so the signal genuinely
 *  went out) — review C1: the caller (`ensureBreachSent`) must know this to
 *  decide whether the episode's guardian-notification obligation is
 *  actually satisfied, rather than assuming it is the instant this is
 *  called. */
async function sendBreachSignal(circle: Circle): Promise<boolean> {
  const fix = beacons.selfFix()
  if (!fix) return false // nothing to disclose yet — caller retries next tick
  const geohash = encodeGeohash(fix.lat, fix.lon, BREACH_PRECISION)
  const inner = await buildLocationSignal({ groupId: circle.id, seedHex: circle.seedHex, signalType: SIGNAL_TYPES.breach, geohash, precision: BREACH_PRECISION })
  const inbox = deriveInbox(circle.seedHex)
  const wrap = await giftWrap(phoneSigner(), inbox.pk, inner, inbox.pk)
  await beacons.publishOrEnqueue(appRelays(store.load()), wrap)
  return true
}

function applyEscalationEffect(circle: Circle, selfPk: string, effect: EscalationEffect, at: number): void {
  if (effect.kind === 'cancel') {
    clearBanner(circle.id)
    store.notify()
    return
  }
  if (effect.kind === 'warn') {
    setBanner(circle.id, { placeName: effect.placeName, graceEndsAt: at + effect.graceMinutes * 60 })
    // PRIVATE — recorded only on this (the child's) own device; never sent.
    activity.recordActivity({ id: activity.localActivityId('safe-area-warning', at, circle.id), at, kind: 'safe-area-warning', circleId: circle.id, actorPk: selfPk, params: { place: effect.placeName } })
    void notify('safe-area-warning', selfPk, 'Heading back?', graceWarningCopy(effect.placeName, effect.graceMinutes))
    store.notify()
    return
  }
  // escalate — grace expired, or an immediate-mode place. The state
  // machine's own decision is correct and immediate: the child's private
  // banner reflects "escalated" right away, `sent: false`. Whether the
  // GUARDIAN has actually been told is a SEPARATE question — `tick()`'s
  // `ensureBreachSent` (the only place that stamps `placeLastEscalatedAt`,
  // records the guardian-facing Activity entry, fires the "has been told"
  // notify, and flips this banner to `sent: true`) decides that, and ONLY
  // once a send has genuinely gone out (review C1 — this used to happen
  // right here, unconditionally, even with no fix yet to disclose).
  setBanner(circle.id, { placeName: effect.placeName, escalated: true, sent: false })
  store.notify()
}

/** Circles with an `ensureBreachSent` attempt currently in flight (re-review
 *  Minor: "no in-flight guard on `ensureBreachSent`" — a breach publish
 *  hanging past `TICK_INTERVAL_MS` with `breachSent` still false would let
 *  an overlapping tick re-enter this function for the same circle before the
 *  first attempt has settled, producing a second, duplicate wire send and a
 *  second guardian-facing Activity entry for the same episode). Module-level
 *  in-memory set, same idiom as `evalState`/`seededCircles` — cleared in a
 *  `finally` in `ensureBreachSent` so the NEXT tick can always retry once
 *  this attempt settles, success or not. */
const breachSendInFlight = new Set<string>()

/** Satisfies circleId's outstanding breach-send obligation for its current
 *  'escalated' episode (review C1 fix). Called from `tick()` for EVERY
 *  circle whose FINAL state this tick is `'escalated'` with `breachSent`
 *  still false — regardless of whether that's because the phase JUST
 *  transitioned this tick (the common case: a fix already exists, since
 *  `evaluatePlaces` only runs against a fresh fix) or because a cold launch
 *  resumed an already-escalated episode from a PRIOR session that never got
 *  to send (the bug case: `checkGraceExpiry` can escalate on a no-fix tick).
 *  Only marks the episode satisfied — `markBreachSent`, which stamps the
 *  persisted snapshot AND flips the banner to its "has been told" copy —
 *  once a send has genuinely gone out, or once `shouldSuppressEscalation`
 *  correctly recognises an already-recent repeat; never before. Guarded by
 *  `breachSendInFlight` (re-review Minor, above) — an overlapping call for
 *  the SAME circle while one is already outstanding returns immediately
 *  without sending again; the in-flight attempt is the one that will
 *  eventually mark the episode satisfied. */
async function ensureBreachSent(circle: Circle, selfPk: string, placeName: string, at: number): Promise<void> {
  if (breachSendInFlight.has(circle.id)) return // an overlapping tick's attempt is already outstanding — let it settle rather than double-send
  breachSendInFlight.add(circle.id)
  try {
    const key = `${circle.id}:${placeName}`
    const lastEscalatedAt = store.load().placeLastEscalatedAt[key]
    if (shouldSuppressEscalation(lastEscalatedAt, at)) {
      // Defense-in-depth: the guardian was already told within the
      // suppression window (almost certainly this SAME episode re-observed
      // purely because the app reloaded/re-ticked while still outside) — the
      // obligation is satisfied without sending again.
      markBreachSent(circle.id)
      return
    }
    const sent = await sendBreachSignal(circle)
    if (!sent) return // still no fix — leave breachSent false, tick() retries
    activity.recordActivity({ id: activity.localActivityId('safe-area-escalation', at, circle.id), at, kind: 'safe-area-escalation', circleId: circle.id, actorPk: selfPk, params: { place: placeName } })
    void notify('safe-area-escalation', selfPk, 'Your circle has been told', escalatedChildCopy(placeName, false))
    store.update((p) => { p.placeLastEscalatedAt = { ...p.placeLastEscalatedAt, [key]: at } })
    markBreachSent(circle.id)
  } finally {
    breachSendInFlight.delete(circle.id)
  }
}

/** Flips circleId's in-memory (and, via `syncPersistedEscalation`,
 *  persisted) escalation state to `breachSent: true`, and upgrades the
 *  private banner from its pending copy to the "has been told" one. A no-op
 *  if the circle isn't currently 'escalated' or is already marked sent (a
 *  genuine re-entry — or an already-completed send — racing ahead of a
 *  slow-resolving `ensureBreachSent` call). */
function markBreachSent(circleId: string): void {
  const state = evalState.get(circleId)
  if (!state || state.escalation.phase !== 'escalated' || state.escalation.breachSent) return
  const next: PlaceEvalState = { ...state, escalation: { ...state.escalation, breachSent: true } }
  evalState.set(circleId, next)
  syncPersistedEscalation(circleId, next)
  const banner = banners.get(circleId)
  if (banner) setBanner(circleId, { ...banner, sent: true })
  store.notify()
}

/** Task 5 (§13.4): an approval landing WHILE a circle is already privately
 *  mid-grace for the SAME place cancels that grace countdown and enters
 *  `'leave-approved'` instead, rather than leaving a stale countdown
 *  ticking toward a warning/breach the guardian just explicitly permitted.
 *  This is the COMMON path, not an edge case — the "Ask to go out" button
 *  sits right on the warning banner (brief §13.4), so asking typically
 *  happens AFTER grace has already started, not before. Matched by PLACE
 *  NAME (best-effort — the 'grace' phase carries no `placeId` of its own,
 *  same "no correlation buffer, best guess" trade-off `nearestPlace`'s own
 *  doc comment already accepts elsewhere in this file — two DIFFERENT
 *  places sharing an identical name could in principle mismatch;
 *  acceptable v1 edge case). Deliberately does NOT touch an already-
 *  'escalated' episode — the guardian may already have been told at that
 *  point (or is about to be, via `ensureBreachSent`'s own retry), and
 *  retroactively un-telling them isn't obviously correct; the approval
 *  still gets RECORDED (`Persisted.approvedLeaves`, by the caller) so the
 *  NEXT exit, whenever it happens, is suppressed. The 'safe' case needs no
 *  help from this function at all — `evaluatePlaces`'s own fresh-exit
 *  branch already checks `Persisted.approvedLeaves` on its own the moment a
 *  fresh fix reports the child outside. Called only from `ensure()`'s
 *  registered `approvals.ApprovalResolutionListener`, never from `tick()`
 *  itself — this reacts to an approval EVENT, not a geolocation tick. */
function applyLeaveApprovalToEscalation(circleId: string, placeId: string, placeName: string, until: number): void {
  const state = stateFor(circleId)
  if (state.escalation.phase !== 'grace' || state.escalation.placeName !== placeName) return
  const next: PlaceEvalState = { insidePlaceIds: state.insidePlaceIds, escalation: { phase: 'leave-approved', placeId, placeName, until } }
  evalState.set(circleId, next)
  // No `syncPersistedEscalation` call — 'leave-approved' is never itself
  // persisted (`placeEvalToPersisted`'s own doc comment) — but the STALE
  // 'grace' snapshot this circle already has on disk must be cleared right
  // now, not left to the next `tick()` (up to `TICK_INTERVAL_MS` away): a
  // force-close in that narrow window would otherwise resume the OLD grace
  // countdown on reload instead of correctly re-deriving 'leave-approved'
  // from `Persisted.approvedLeaves`.
  clearPersistedEscalation(circleId)
  clearBanner(circleId)
  store.notify()
}

// ---------------------------------------------------------------------------
// Arrival windows — child-side orchestration (Phase 3 Task 5). `windowAction`
// above is the pure decision; `evaluateArrivalWindows` (called from `tick()`
// below, once per child-role circle) is the impure loop that applies its
// verdict per window: persists the mark, sends whatever wire signal is due
// (fire-and-forget, same discipline as `tick()`'s own arrival/departure
// buzzes — see that loop's own `void sendPlaceBuzz(...)` calls: window
// signals are best-effort too, never on the awaited safety-critical breach-
// send path), and records the local Activity entry.
// ---------------------------------------------------------------------------

/** Merges `patch` onto window `windowId`'s CURRENT-DAY mark — a stale
 *  (yesterday-or-older) entry is DROPPED, not merged into (task contract:
 *  "when writing a mark for today, the old-day entry for that window id is
 *  overwritten"), so `patch`'s sibling flags (e.g. `'mark-met'` keeping a
 *  same-day `reminded`) only ever carry forward within the SAME day. One
 *  `store.update` call — the only write a changed window makes this tick. */
function mergeWindowMark(windowId: string, dayStamp: string, patch: { met?: true; reminded?: true; fired?: true }): void {
  store.update((p) => {
    const existing = p.arrivalWindowMarks[windowId]
    const today = existing && existing.day === dayStamp ? existing : undefined
    p.arrivalWindowMarks = { ...p.arrivalWindowMarks, [windowId]: { ...today, day: dayStamp, ...patch } }
  })
}

/** Drops any `Persisted.arrivalWindowMarks` entry whose window id no longer
 *  belongs to ANY place in ANY circle (task contract: "prune ids no longer
 *  present in any place's windows") — the window (or its place) was removed
 *  in the guardian's editor since this mark was written. Read-then-write-
 *  only-if-needed, same discipline as `syncPersistedEscalation`/
 *  `clearPersistedEscalation` above. Called once per `tick()`, not per
 *  circle — window ids are unique across the whole app (`newWindowId`'s
 *  "unlinkability handle" idiom), so a single global pass is enough. */
function pruneOrphanedWindowMarks(p: store.Persisted): void {
  const validIds = new Set<string>()
  for (const placesForCircle of Object.values(p.places)) {
    for (const place of placesForCircle) {
      for (const w of place.arrivalWindows ?? []) validIds.add(w.id)
    }
  }
  const stale = Object.keys(p.arrivalWindowMarks).filter((id) => !validIds.has(id))
  if (!stale.length) return
  store.update((sp) => {
    const next = { ...sp.arrivalWindowMarks }
    for (const id of stale) delete next[id]
    sp.arrivalWindowMarks = next
  })
}

/** Runs `windowAction` for every window across `places` and applies its
 *  verdict — `tick()`'s own per-circle call, only for `escalationEnabled`
 *  (child-role) circles. `insidePlaceIds` is THIS tick's already-resolved
 *  inside-state (the prior tick's, unchanged, on a no-fix tick — `tick()`
 *  never invents a fresh fix for this, same discipline as its own grace-
 *  expiry check just below). `enteredPlaceIds` is THIS tick's
 *  `result.entered` (review fix) — the `'late-arrival'` case below needs it
 *  to avoid sending a second arrival buzz for a place the entered-loop
 *  above already buzzed this same tick. */
function evaluateArrivalWindows(circle: Circle, selfPk: string, places: readonly Place[], insidePlaceIds: readonly string[], enteredPlaceIds: readonly string[], at: number): void {
  const day = localDay(new Date())
  const marks = store.load().arrivalWindowMarks
  for (const place of places) {
    for (const w of place.arrivalWindows ?? []) {
      const insideNow = insidePlaceIds.includes(place.id)
      const action = windowAction(w, insideNow, marks[w.id], day)
      switch (action) {
        case 'none':
          break
        case 'mark-met':
          mergeWindowMark(w.id, day.dayStamp, { met: true })
          break
        case 'remind':
          mergeWindowMark(w.id, day.dayStamp, { reminded: true })
          activity.recordActivity({ id: activity.localActivityId('window-reminder', at, circle.id) + `-${w.id}`, at, kind: 'window-reminder', circleId: circle.id, actorPk: selfPk, params: { place: place.name, time: w.arriveBy } })
          void notify('window-reminder', null, `Expected at ${place.name} by ${w.arriveBy}`, circle.name)
          break
        case 'fire':
          mergeWindowMark(w.id, day.dayStamp, { fired: true })
          void sendPlaceBuzz(selfPk, circle, buildNotYetReason(place.name, w.arriveBy), at)
          activity.recordActivity({ id: activity.localActivityId('window-missed', at, circle.id) + `-${w.id}`, at, kind: 'window-missed', circleId: circle.id, actorPk: selfPk, params: { place: place.name, time: w.arriveBy } })
          void notify('window-missed', null, `Your circle was told you're not at ${place.name} yet`, circle.name)
          break
        case 'late-arrival': {
          // Task contract: an arrival buzz EVEN IF `place.arrivalNotify` is
          // false — the guardian was already told "not yet", so the closing
          // "arrived" signal must reach them regardless of the place's
          // ordinary arrival-notification toggle. Review fix: but not a
          // SECOND arrival buzz when `place.arrivalNotify` is true AND this
          // place was freshly entered THIS tick — the entered-loop above
          // already sent one, and a second here would double the child's
          // Activity feed (the guardian's own receive-side already dedupes,
          // but the child-local copy doesn't go through that path).
          mergeWindowMark(w.id, day.dayStamp, { met: true })
          const alreadyBuzzedThisTick = place.arrivalNotify && enteredPlaceIds.includes(place.id)
          if (!alreadyBuzzedThisTick) void sendPlaceBuzz(selfPk, circle, buildArrivalReason(place.name), at)
          activity.recordActivity({ id: activity.localActivityId('window-met', at, circle.id) + `-${w.id}`, at, kind: 'window-met', circleId: circle.id, actorPk: selfPk, params: { place: place.name } })
          break
        }
      }
    }
  }
}

// ---------------------------------------------------------------------------
// tick() — the child-side evaluation loop, off `beacons.selfFix()` (task
// contract: "runs on the CHILD device off its own fix stream"). A periodic
// timer, not a per-fix push callback (same idiom as agreements.ts's own
// arrival/late-check `checkTick`) — deliberately: grace expiry is TIME-
// based and must fire even while the device is stationary and no new fix
// arrives (`watchLocation` has no obligation to re-fire on an unmoving
// device). Every tick re-reads the latest known fix (possibly stale) and
// checks expiry regardless of whether a fresh one is available.
//
// Exported (unlike this module's other orchestration internals) so
// places.test.ts can drive it directly for the review-mandated orchestration
// tests (cold-launch escalation retry — C1; relaunch-inside-a-place — I1)
// without waiting out `ensure()`'s real setInterval. `tick()` awaits its own
// `ensureBreachSent` call per circle (see below) specifically so a caller
// awaiting `tick()` observes the fully-settled outcome — every OTHER wire
// send in this loop (arrival/departure buzzes) stays fire-and-forget, same
// as before.
// ---------------------------------------------------------------------------

const TICK_INTERVAL_MS = 30_000

/** A hook another domain module can register to piggyback its own
 *  infrequent housekeeping onto this module's already-running `tick()` loop
 *  rather than starting a second `setInterval` of its own — same
 *  registration-not-import idiom as `registerApprovalAutoResolver`/
 *  `registerApprovalResolutionListener` above (this module is the one being
 *  extended here, so it's the one exporting the registration point; the
 *  caller — e.g. milestones.ts's weekly step-up evaluation, Phase 6 Task 2 —
 *  registers into it without places.ts ever importing it back). Called once
 *  per `tick()`, given that tick's `nowSecValue`; any cadence gating (e.g.
 *  "only actually do work once a week") is entirely the registered
 *  function's own job — this module has no opinion on it. Multiple hooks
 *  may register (unlike `autoResolver`/`resolutionListener`'s "one active
 *  provider" — there's no reason a second future housekeeping task
 *  couldn't also piggyback here). */
export type PeriodicHook = (nowSecValue: number) => void
const periodicHooks: PeriodicHook[] = []
export function registerPeriodicHook(fn: PeriodicHook): void { periodicHooks.push(fn) }

const evalState = new Map<string, PlaceEvalState>()

/** Review I1 fix: which circles have had a LIVE fix evaluated against them
 *  yet this session — module-level/in-memory, same idiom as `evalState`/
 *  `banners` (a fresh session, e.g. after a reload, starts this empty
 *  again). `tick()` passes `evaluatePlaces` `seedOnly: true` on a circle's
 *  first live evaluation this session, so `insidePlaceIds` seeds from
 *  reality without emitting `entered`/`exited` for whatever it already
 *  happens to be inside/outside at that moment — see `evaluatePlaces`'s own
 *  doc comment. */
const seededCircles = new Set<string>()

/** `evalState`'s accessor — hydrates from `Persisted.placeEval` (via
 *  `hydratePlaceEvalState`) the FIRST time a circle is read this session
 *  (cold: no in-memory entry yet, e.g. right after a reload), then caches
 *  the result so every subsequent read/write this session goes through the
 *  in-memory map as before. See the "Reload safety" section above for why
 *  this matters — without it, a reload mid-grace would silently restart the
 *  countdown from `INITIAL_PLACE_EVAL_STATE` every time. */
function stateFor(circleId: string): PlaceEvalState {
  const cached = evalState.get(circleId)
  if (cached) return cached
  const hydrated = hydratePlaceEvalState(store.load().placeEval[circleId])
  evalState.set(circleId, hydrated)
  return hydrated
}

/** `circleId`'s current escalation phase — `'safe'` for a circle this device
 *  is a guardian of (the supervisor never runs for a non-child role, see
 *  `tick`'s own `escalationEnabled` below) or simply hasn't evaluated a fix
 *  against yet. Exported for the You-tab privacy overview (Task 8, brief
 *  §25's "any active safety escalation" row) — a thin read accessor over
 *  this module's own ephemeral state, not a new computation. */
export function currentEscalation(circleId: string): EscalationSubState {
  return stateFor(circleId).escalation
}

/** Writes `Persisted.placeEval[circleId]` from `state`, but ONLY when it
 *  actually differs from what's already persisted — a plain read-then-
 *  compare (not a `store.update()` on every tick), so a steady-state grace
 *  countdown (unchanged `graceEndsAt` tick after tick) doesn't force a
 *  redundant write + re-render every `TICK_INTERVAL_MS`. Never called with
 *  a 'safe' state — see `clearPersistedEscalation` for that case. The
 *  comparison includes `breachSent` (review C1) — without it, `at`
 *  reaching 'escalated' and `at` actually sending would look identical
 *  (same phase/placeName/graceEndsAt), so `markBreachSent`'s own call here
 *  would be silently skipped and the true `breachSent: true` would never
 *  reach storage. */
function syncPersistedEscalation(circleId: string, state: PlaceEvalState): void {
  const persisted = placeEvalToPersisted(state)
  if (!persisted) return
  const current = store.load().placeEval[circleId]
  if (current && current.phase === persisted.phase && current.placeName === persisted.placeName && current.graceEndsAt === persisted.graceEndsAt && current.breachSent === persisted.breachSent) return
  store.update((p) => { p.placeEval = { ...p.placeEval, [circleId]: persisted } })
}

/** Clears `circleId`'s persisted phase snapshot AND every
 *  `placeLastEscalatedAt` entry for this circle — called the moment a
 *  circle returns to 'safe', which is both halves of "a genuine new exit
 *  after re-entry resets it" (task contract): the phase snapshot no longer
 *  applies, and the NEXT escalation (a genuinely new episode) must not be
 *  suppressed by a stale timestamp from the one that just ended. Same
 *  read-then-write-only-if-needed discipline as `syncPersistedEscalation`. */
function clearPersistedEscalation(circleId: string): void {
  const p = store.load()
  const hasEval = circleId in p.placeEval
  const prefix = `${circleId}:`
  const lastKeys = Object.keys(p.placeLastEscalatedAt).filter((k) => k.startsWith(prefix))
  if (!hasEval && !lastKeys.length) return
  store.update((sp) => {
    if (hasEval) {
      const next = { ...sp.placeEval }
      delete next[circleId]
      sp.placeEval = next
    }
    if (lastKeys.length) {
      const next = { ...sp.placeLastEscalatedAt }
      for (const k of lastKeys) delete next[k]
      sp.placeLastEscalatedAt = next
    }
  })
}

export async function tick(): Promise<void> {
  const p = store.load()
  const self = currentSession()
  if (!self) return
  const fix = beacons.selfFix()
  const at = nowSec()
  let anyGraceActive = false

  // Phase 3 Task 5: self-pruning happens once per tick, not per circle — see
  // `pruneOrphanedWindowMarks`'s own doc comment.
  pruneOrphanedWindowMarks(p)

  // Task 5 (§13.4): same "once per tick, not per circle" self-pruning idiom
  // as `pruneOrphanedWindowMarks` just above — housekeeping only, never a
  // correctness dependency (see `pruneExpiredLeaves`'s own doc comment).
  const prunedLeaves = pruneExpiredLeaves(p.approvedLeaves, at)
  if (prunedLeaves !== p.approvedLeaves) store.update((sp) => { sp.approvedLeaves = prunedLeaves })
  const leaveApprovedUntilFor = (circleId: string) => (placeId: string) => leaveApprovedUntil(prunedLeaves, circleId, placeId, at)

  for (const circle of p.circles) {
    const places = p.places[circle.id] ?? []
    if (!places.length) continue
    const escalationEnabled = selfRole(circle, self.identityPk) === 'child'
    const prior = stateFor(circle.id)

    const result = fix
      ? evaluatePlaces(places, { lat: fix.lat, lon: fix.lon }, fix.accuracy, at, prior, escalationEnabled, !seededCircles.has(circle.id), leaveApprovedUntilFor(circle.id))
      : { state: prior, entered: [] as string[], exited: [] as string[] }
    if (fix) seededCircles.add(circle.id)
    let state = result.state
    evalState.set(circle.id, state)

    for (const id of result.entered) {
      const place = places.find((pl) => pl.id === id)
      if (place?.arrivalNotify) {
        void sendPlaceBuzz(self.identityPk, circle, buildArrivalReason(place.name), at)
        recordLocalPlaceActivity('arrival', circle.id, self.identityPk, place.name, at)
      }
    }
    for (const id of result.exited) {
      const place = places.find((pl) => pl.id === id)
      if (place?.departureNotify) {
        void sendPlaceBuzz(self.identityPk, circle, buildDepartureReason(place.name), at)
        recordLocalPlaceActivity('departure', circle.id, self.identityPk, place.name, at)
      }
    }

    // Phase 3 Task 5: expected-arrival windows — child-role circles only
    // (same `escalationEnabled` gate as the escalation supervisor below),
    // evaluated against THIS tick's `state.insidePlaceIds` (the prior
    // tick's value, unchanged, when there's no fresh fix — see
    // `evaluateArrivalWindows`'s own doc comment).
    if (escalationEnabled) {
      evaluateArrivalWindows(circle, self.identityPk, places, state.insidePlaceIds, result.entered, at)
    }

    if (state.escalation.phase === 'safe') clearBanner(circle.id)
    if (result.escalationEffect) applyEscalationEffect(circle, self.identityPk, result.escalationEffect, at)

    // Grace expiry is time-based, independent of whether `evaluatePlaces` ran
    // this tick (see `checkGraceExpiry`'s own doc comment) — always checked
    // for a circle this device is a child of, even on a tick with no fix.
    if (escalationEnabled) {
      const expiry = checkGraceExpiry(state, at)
      if (expiry.state !== state) { state = expiry.state; evalState.set(circle.id, state) }
      if (expiry.effect) applyEscalationEffect(circle, self.identityPk, expiry.effect, at)

      // Task 5 (§13.4): a `'leave-approved'` episode's own time-based
      // expiry — mirrors `checkGraceExpiry` just above exactly (independent
      // of whether a fresh fix arrived this tick). Records 'leave-expired'
      // Activity on the transition ITSELF (once, not every subsequent
      // tick — `leaveExpiry.state !== state` is only true the ONE tick this
      // actually fires) — the normal warning/grace flow that follows
      // (`applyEscalationEffect` below) records its own 'safe-area-warning'
      // Activity entry as usual, same as any other fresh exit.
      const wasLeaveApproved = state.escalation.phase === 'leave-approved' ? state.escalation.placeName : undefined
      const leaveExpiry = checkLeaveExpiry(state, places, at)
      if (leaveExpiry.state !== state) {
        activity.recordActivity({ id: activity.localActivityId('leave-expired', at, circle.id), at, kind: 'leave-expired', circleId: circle.id, actorPk: self.identityPk, params: { place: wasLeaveApproved ?? '' } })
        state = leaveExpiry.state
        evalState.set(circle.id, state)
      }
      if (leaveExpiry.effect) applyEscalationEffect(circle, self.identityPk, leaveExpiry.effect, at)
    }

    // Review C1 fix: satisfy an outstanding breach-send obligation for
    // EVERY circle whose state this tick is 'escalated' with `breachSent`
    // still false — whether that's a fresh transition (above) or a resumed
    // (cold-launch) episode from a prior session that never got to send.
    // Awaited (not fire-and-forget) so the persisted/in-memory state below
    // reflects the outcome before this tick finishes. Re-reads `state` from
    // `evalState` afterwards, since `markBreachSent` may have replaced it.
    if (state.escalation.phase === 'escalated' && !state.escalation.breachSent) {
      await ensureBreachSent(circle, self.identityPk, state.escalation.placeName, at)
      state = evalState.get(circle.id) ?? state
    }

    // Reload safety (Task 7 follow-up fix): persist the FINAL phase for this
    // tick, using the pure `placeEvalToPersisted` mapping — 'safe' clears
    // both the persisted phase snapshot AND the suppression guard (a
    // genuine re-entry resets it, task contract); anything else stays
    // synced so `stateFor`'s hydration resumes correctly next session.
    // 'leave-approved' (Task 5) is treated the same as 'safe' here — see
    // `placeEvalToPersisted`'s own doc comment for why it's never itself
    // snapshotted (`Persisted.approvedLeaves` is the real source of truth).
    if (state.escalation.phase === 'safe' || state.escalation.phase === 'leave-approved') {
      clearPersistedEscalation(circle.id)
    } else {
      syncPersistedEscalation(circle.id, state)
    }

    if (state.escalation.phase === 'grace') anyGraceActive = true
  }

  // Piggybacked housekeeping (see `registerPeriodicHook`'s own doc comment)
  // — once per tick, not per circle, same idiom as `pruneOrphanedWindowMarks`/
  // `pruneExpiredLeaves` above.
  for (const hook of periodicHooks) hook(at)

  // Re-render so an active grace banner's remaining-minutes countdown
  // visibly ticks down even without any other store change this cycle.
  if (anyGraceActive) store.notify()
}

// ---------------------------------------------------------------------------
// Incoming — registered with beacons.ts as an additional handler for
// non-beacon circle-inbox signals (see beacons.ts's `setSignalHandler` doc
// comment).
// ---------------------------------------------------------------------------

function applyIncomingPlaces(circleId: string, places: Place[], updatedAt: number, by: string): void {
  store.update((p) => {
    const current = p.placesMeta[circleId]
    const newer = isNewerFenceSet({ updatedAt, by }, current ? { fencesUpdatedAt: current.updatedAt, fencesBy: current.by } : undefined)
    if (!newer) return
    p.places = { ...p.places, [circleId]: places }
    p.placesMeta = { ...p.placesMeta, [circleId]: { updatedAt, by } }
  })
}

async function handleIncomingBreach(circle: Circle, rumor: Rumor, senderMemberPk: string): Promise<void> {
  try {
    const payload = await decryptBeacon(deriveBeaconKey(circle.seedHex), rumor.content)
    const p = store.load()
    const places = p.places[circle.id] ?? []
    const point = decodeGeohash(payload.geohash)
    const nearest = places.length ? nearestPlace(places, point) : undefined
    const placeName = nearest?.name || 'a safe area'
    const id = rumor.id ?? `breach-${senderMemberPk}-${payload.timestamp}`
    const inserted = activity.recordActivity({ id, at: payload.timestamp, kind: 'safe-area-escalation', circleId: circle.id, actorPk: senderMemberPk, params: { place: placeName, geohash: payload.geohash } })
    if (shouldNotifyForSafetyEvent(inserted, payload.timestamp, nowSec())) {
      void notify('safe-area-escalation', senderMemberPk, `${memberName(circle, senderMemberPk)} left ${placeName}`, circle.name)
    }
  } catch {
    // undecryptable / malformed — silently drop, same discipline as beacons.ts
  }
}

/** Registered with beacons.ts's circle-inbox dispatch. Ignores its own
 *  echo, same discipline as every other handler in this codebase. */
export function handleIncomingSignal(circle: Circle, rumor: Rumor, t: string, sender: beacons.Sender): void {
  const self = currentSession()
  if (self && sender.signerPk === self.phonePk) return
  if (t === PLACES_SIGNAL_TYPE) {
    // Signet identity plan, Task 9: `'places'` is a STRUCTURAL action —
    // beacons.ts's receive choke point never dispatches it phone-signed
    // (`STRUCTURAL_ACTIONS.has(t)` drops it outright before any handler
    // sees it), but the check is repeated here too, belt-and-braces, same
    // discipline as every other structural handler in this codebase.
    if (!sender.structural) return
    const parsed = parsePlacesMetaSignal(rumor.content, circle.id)
    if (!parsed) return
    // sender-auth: ffb48b9 class — `by` claims who last saved this circle's
    // place set (the clock-tiebreak actor); it must equal the
    // now-authenticated resolved sender, else the update is dropped
    // wholesale.
    if (parsed.by !== sender.memberPk) return
    applyIncomingPlaces(circle.id, parsed.places, parsed.updatedAt, parsed.by)
    return
  }
  if (t === SIGNAL_TYPES.breach) {
    void handleIncomingBreach(circle, rumor, sender.memberPk)
    return
  }
  // Anything else (a bare `t:'fences'` from a real flock client, arrival/
  // departure buzzes — messages.ts's own concern) isn't handled here — see
  // the module doc comment's "known v1 gap" note for the former.
}

// ---------------------------------------------------------------------------
// Guardian receive — arrival/departure buzz Activity + Notification, called
// directly by messages.ts's `handleIncomingBuzz` (that module already owns
// ALL untargeted-buzz dispatch/classification — see its own doc comment on
// `classifyIncomingBuzz` for why arrival/departure detection lives there,
// not a second buzz subscription here).
// ---------------------------------------------------------------------------

/** Records an incoming arrival/departure buzz to Activity (proper kind +
 *  place param, not a generic 'message') and fires a Notification —
 *  messages.ts calls this directly once it has classified an untargeted
 *  buzz's `reason` as carrying the arrival/departure prefix (same "direct
 *  export, not a registration" idiom safety.ts's own
 *  `recordEmergencyAccessReason` uses for messages.ts's Task 6 call site:
 *  there is exactly one caller and no reverse import risk — this module
 *  never imports messages.ts). */
export function recordIncomingPlaceEvent(kind: 'arrival' | 'departure', circle: Circle, actorPk: string, placeName: string, at: number): void {
  const id = activity.localActivityId(`${kind}-recv`, at, circle.id) + `-${actorPk}`
  const inserted = activity.recordActivity({ id, at, kind, circleId: circle.id, actorPk, params: { place: placeName || 'a place' } })
  if (shouldNotifyForSafetyEvent(inserted, at, nowSec())) {
    const title = kind === 'arrival' ? `${memberName(circle, actorPk)} arrived` : `${memberName(circle, actorPk)} left`
    void notify(kind, actorPk, title, placeName ? `${kind === 'arrival' ? 'Arrived at' : 'Left'} ${placeName}` : circle.name)
  }
}

/** Records an incoming "not yet arrived" buzz (Phase 3 Task 5) — the
 *  guardian-receive half of `evaluateArrivalWindows`'s child-side `'fire'`
 *  branch below. Same freshness-gated Activity-then-notify shape as
 *  `recordIncomingPlaceEvent` immediately above; messages.ts's
 *  `handleIncomingBuzz` calls this directly once `classifyIncomingBuzz` has
 *  recognised the buzz's `reason` via `detectNotYetReason` (same "direct
 *  export, not a registration" idiom that function's own doc comment
 *  explains — this module never imports messages.ts back). */
export function recordIncomingWindowEvent(circle: Circle, actorPk: string, place: string, time: string, at: number): void {
  // place is part of the id (review fix, same "T6 minor" idiom as
  // safety.ts's `recordEmergencyAccess` appending targetPk): without it, two
  // windows at DIFFERENT places with identical arriveBy+graceMin fire in the
  // same child tick, producing equal timestamps, and the second place's
  // insert would collide with the first and be silently dropped as a
  // dedupe.
  const id = activity.localActivityId('window-missed-recv', at, circle.id) + `-${actorPk}-${place}`
  const inserted = activity.recordActivity({ id, at, kind: 'window-missed', circleId: circle.id, actorPk, params: { place: place || 'a place', time } })
  if (shouldNotifyForSafetyEvent(inserted, at, nowSec())) {
    void notify('window-missed', actorPk, `${memberName(circle, actorPk)} hasn't arrived at ${place} yet`, `Expected by ${time} · ${circle.name}`)
  }
}

// ---------------------------------------------------------------------------
// ensure() — the one side-effecting entry point, called from app.ts's
// render() (idempotent, identity-independent — same convention as
// safety.ts/agreements.ts/approvals.ts/messages.ts).
// ---------------------------------------------------------------------------

/** Registers the structural queue's sender this module owns (`'places'` —
 *  Signet identity plan, Task 9), same pattern as circles.ts's/
 *  approvals.ts's/agreements.ts's own `registerStructuralSenders`.
 *
 *  Final fix B1/I1 and round 3, F2: the local apply (latest-wins) and then
 *  the phone-signed flock `fences` geometry wrap happen HERE, after the
 *  identity-signed update has actually been sent — not from `savePlaces`
 *  before it was even queued. Both are re-derived from the SAME
 *  signed payload (`parsePlacesMetaSignal`), not live local state, so it
 *  exactly matches what was actually approved even if local state has
 *  since moved on. A circle gone or a payload that fails to parse means
 *  nothing is published — same "best-effort, no error UI" discipline as
 *  every other wire send in this codebase. */
export function registerStructuralSenders(): void {
  registerSender('places', async (signed, item) => {
    const c = store.load().circles.find((x) => x.id === item.circleId)
    if (!c) return
    await beacons.sendStructural(c, signed)
    // Final fix round 4: signed out (or someone else signed in) meanwhile —
    // no apply into the next session's store, no fences wrap.
    if (!stillEnqueuingSession(item)) return
    const meta = parsePlacesMetaSignal(item.payload, item.circleId)
    if (!meta) return
    // Final fix round 3, F2: the local apply, only now that it has gone out.
    applyIncomingPlaces(c.id, meta.places, meta.updatedAt, meta.by)
    const fencesWrap = await buildPlacesFencesWrap(phoneSigner(), c, meta.places, meta.updatedAt, meta.by)
    await beacons.publishOrEnqueue(appRelays(store.load()), fencesWrap)
  })
}

let registered = false
export function ensure(): void {
  if (registered) return
  registered = true
  registerStructuralSenders()
  beacons.setSignalHandler(handleIncomingSignal)
  // Task 5 (§13.4): the two approvals.ts hooks this feature needs —
  // registration, not a reverse import (see this module's own import-time
  // doc comment). `registerApprovalAutoResolver`'s callback is consulted
  // ONLY for a freshly-received leave-area request, on a GUARDIAN device,
  // before it reaches the manual-review inbox — `undefined` for every
  // other (non-leave-area) request falls straight through to that
  // unchanged path. `registerApprovalResolutionListener`'s callback is the
  // "same reducer, both devices" convergence point — fired for EVERY
  // resolved request, gated here by `decodeLeaveAreaParams` returning
  // non-null (a no-op otherwise).
  approvals.registerApprovalAutoResolver((circleId, req) => {
    if (!isLeaveAreaRequest(req.params)) return undefined
    const verdict = store.load().leaveAreaPolicy[circleId] ?? 'prompt'
    if (verdict === 'allow') return true
    if (verdict === 'deny') return false
    return undefined
  })
  approvals.registerApprovalResolutionListener((resolution) => {
    const params = decodeLeaveAreaParams(resolution.req.params)
    if (!params) return
    const { circleId, resp } = resolution
    store.update((p) => { p.approvedLeaves = applyLeaveResolution(p.approvedLeaves, circleId, params, resp) })
    if (resp.ok) applyLeaveApprovalToEscalation(circleId, params.placeId, params.placeName, resp.at + params.durationMin * 60)
  })
  void tick() // don't make a just-added place wait out a stale up-to-30s-old tick
  setInterval(() => { void tick() }, TICK_INTERVAL_MS)
}

// ---------------------------------------------------------------------------
// View — the Map tab's "Add place here" button + inline creation form, the
// Circles tab's "Safe places" list, and the private escalation banner. UI
// wiring only past this point — no unit tests (build-gated), same
// convention as every other domain module here. esc() on every wire-
// derived string (place names) per global-constraints.md.
// ---------------------------------------------------------------------------

interface PlaceFormState { circleId?: string; lat: number; lon: number; error?: string }
let formState: PlaceFormState | null = null

/** Opens the "add a place" form centred on `centre` (the map's current
 *  centre — see the module doc comment on the long-press-vs-button choice).
 *  Called from app.ts's `places-add-here` action (which alone knows the
 *  live MapView's centre). */
export function openPlaceForm(centre: { lat: number; lon: number }): void {
  formState = { lat: centre.lat, lon: centre.lon }
  store.notify()
}
function closePlaceForm(): void {
  formState = null
  store.notify()
}

/** The Map tab's "Add place here" button — guardian-of-at-least-one-circle
 *  gated, since only a guardian may define places. */
export function mapOverlayView(p: store.Persisted, fam: SessionInfo): string {
  const canManage = p.circles.some((c) => isGuardian(c, fam.identityPk))
  if (!canManage) return ''
  return `<button type="button" class="map-chip place-add" data-action="places-add-here">Add place here</button>`
}

/** The MAP TAB'S CHOICE (task contract: "map long-press... or an 'Add place
 *  here' button using current centre — pick whichever integrates cleanly,
 *  document the choice"): this app uses the button, not long-press.
 *  maplibre-gl has no native long-press gesture, and layering custom
 *  pointer-timing logic onto the map canvas (à la safety.ts's `wireSos`)
 *  risks interfering with the EXISTING drag-pan/pinch-zoom/marker-tap
 *  gestures the map already relies on for Task 3's person sheet — a
 *  regression risk not worth taking for an equally-capable, much
 *  lower-risk alternative: the guardian pans/zooms to the desired spot
 *  (ordinary map interaction, unaffected) and taps a plain button that
 *  reads `MapView.getCentre()` at that moment. */
export function placeFormView(p: store.Persisted, fam: SessionInfo): string {
  if (!formState) return ''
  const state = formState
  const guardianCircles = p.circles.filter((c) => isGuardian(c, fam.identityPk))
  if (!guardianCircles.length) return ''
  const circleOptions = guardianCircles.map((c) => `<option value="${esc(c.id)}"${c.id === state.circleId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')
  const typeRadios = PLACE_TYPES.map((t, i) => `
    <label class="confirm-gate"><input type="radio" name="place-type" value="${t}"${i === 0 ? ' checked' : ''} /> ${esc(placeTypeLabel(t))}</label>`).join('')
  const radiusChips = RADIUS_CHIPS_METRES.map((m, i) => `
    <label class="confirm-gate"><input type="radio" name="place-radius" value="${m}"${i === 0 ? ' checked' : ''} /> ${m}m</label>`).join('')
  const err = state.error ? `<p class="form-error">${esc(state.error)}</p>` : ''
  // Label mirrors what submitPlaceForm actually saves (levelDefaults-aware,
  // P6 final-review residual): the value for the form's currently-selected
  // circle, not the static DEFAULT_GRACE_MINUTES.
  const graceDefault = defaultGraceMinutesFor(p, state.circleId || guardianCircles[0]?.id || '')
  return `
    <div class="place-form">
      <h3>Add a safe place</h3>
      <select id="place-circle">${circleOptions}</select>
      <input id="place-name" type="text" maxlength="${MAX_PLACE_NAME_LEN}" placeholder="Name (e.g. Home)" />
      <div class="schedule-chips">${typeRadios}</div>
      <div class="schedule-chips">${radiusChips}</div>
      <label class="confirm-gate"><input type="checkbox" id="place-arrival-notify" checked /> Notify the circle on arrival</label>
      <label class="confirm-gate"><input type="checkbox" id="place-departure-notify" /> Notify the circle on departure</label>
      <div class="schedule-chips">
        <label><input type="radio" name="place-escalation" value="grace" checked /> Warn first, then tell the circle (${graceDefault} min)</label>
        <label><input type="radio" name="place-escalation" value="immediate" /> Tell the circle right away</label>
      </div>
      ${err}
      <div class="sheet-actions">
        <button type="button" data-action="places-form-submit">Save place</button>
        <button type="button" data-action="places-form-cancel">Cancel</button>
      </div>
    </div>`
}

function inputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? ''
}

function submitPlaceForm(): void {
  if (!formState) return
  const circleId = (document.getElementById('place-circle') as HTMLSelectElement | null)?.value ?? ''
  const name = inputValue('place-name')
  const typeRaw = (document.querySelector('input[name="place-type"]:checked') as HTMLInputElement | null)?.value
  const type = PLACE_TYPES_SET.has(typeRaw ?? '') ? (typeRaw as PlaceType) : undefined
  const radius = Number((document.querySelector('input[name="place-radius"]:checked') as HTMLInputElement | null)?.value)
  const arrivalNotify = (document.getElementById('place-arrival-notify') as HTMLInputElement | null)?.checked ?? false
  const departureNotify = (document.getElementById('place-departure-notify') as HTMLInputElement | null)?.checked ?? false
  const escalationRaw = (document.querySelector('input[name="place-escalation"]:checked') as HTMLInputElement | null)?.value
  const escalation: EscalationMode = escalationRaw === 'immediate' ? 'immediate' : 'grace'

  if (!circleId) { formState = { ...formState, error: 'Choose a circle.' }; store.notify(); return }
  if (!name) { formState = { ...formState, error: 'Enter a name for this place.' }; store.notify(); return }
  if (!type || !Number.isFinite(radius) || radius <= 0) { formState = { ...formState, error: 'Choose a type and radius.' }; store.notify(); return }

  const draft: NewPlaceDraft = {
    name, type, centre: { lat: formState.lat, lon: formState.lon }, radiusMetres: radius,
    // Phase 6 final-review finding 6: a fresh place inherits this circle's
    // own independence-level grace default (if a level's ever been applied
    // here), not the app's generic DEFAULT_GRACE_MINUTES unconditionally.
    arrivalNotify, departureNotify, escalation, graceMinutes: defaultGraceMinutesFor(store.load(), circleId),
  }
  clearFields(['place-circle', 'place-name', 'place-arrival-notify', 'place-departure-notify']) // submitted: the form starts afresh
  formState = null
  store.notify()
  void addPlace(circleId, draft)
}

// ---------------------------------------------------------------------------
// "Ask to go out" (Phase 5 Task 5, brief §13.4) — the child-side form: a
// destination (free text), who-with (free text), and a duration chip
// (30/60/120 min), triggered from either the escalation banner (already
// mid-warning) or a place row in the Circles-tab list (proactively, before
// leaving). One module-level form state, same idiom as `formState`/
// `windowFormErrors` above — at most one open at a time.
// ---------------------------------------------------------------------------

interface LeaveFormState { circleId: string; placeId: string; placeName: string; error?: string }
let leaveFormState: LeaveFormState | null = null

export function openLeaveForm(circleId: string, placeId: string, placeName: string): void {
  leaveFormState = { circleId, placeId, placeName }
  store.notify()
}
function closeLeaveForm(): void {
  leaveFormState = null
  store.notify()
}

function leaveFormView(circleId: string, placeId: string): string {
  if (!leaveFormState || leaveFormState.circleId !== circleId || leaveFormState.placeId !== placeId) return ''
  const s = leaveFormState
  const durationChips = LEAVE_AREA_DURATIONS_MIN.map((m, i) => `
    <label class="confirm-gate"><input type="radio" name="leave-duration" value="${m}"${i === 0 ? ' checked' : ''} /> ${m} min</label>`).join('')
  const err = s.error ? `<p class="form-error">${esc(s.error)}</p>` : ''
  return `
    <div class="leave-form">
      <h3>Ask to go out — ${esc(s.placeName)}</h3>
      <input id="leave-destination" type="text" maxlength="60" placeholder="Where are you going?" />
      <input id="leave-with-who" type="text" maxlength="60" placeholder="Who with?" />
      <div class="schedule-chips">${durationChips}</div>
      ${err}
      <div class="sheet-actions">
        <button type="button" data-action="places-leave-submit">Ask</button>
        <button type="button" data-action="places-leave-cancel">Cancel</button>
      </div>
    </div>`
}

function submitLeaveForm(): void {
  if (!leaveFormState) return
  const s = leaveFormState
  const destination = inputValue('leave-destination')
  const withWho = inputValue('leave-with-who')
  const durationRaw = Number((document.querySelector('input[name="leave-duration"]:checked') as HTMLInputElement | null)?.value)
  const durationOk = (LEAVE_AREA_DURATIONS_MIN as readonly number[]).includes(durationRaw)
  if (!destination) { leaveFormState = { ...s, error: "Say where you're going." }; store.notify(); return }
  if (!durationOk) { leaveFormState = { ...s, error: 'Choose how long.' }; store.notify(); return }
  const durationMin = durationRaw as LeaveAreaDurationMin
  const p = store.load()
  const precisionTerm = mapinfoPrecisionTerm(beacons.circleBaselinePrecision(p.settings, s.circleId))
  const params = encodeLeaveAreaParams({ placeName: s.placeName, placeId: s.placeId, destination, withWho, durationMin, precisionTerm })
  clearFields(['leave-destination', 'leave-with-who']) // submitted: the form starts afresh
  leaveFormState = null
  store.notify()
  void approvals.raiseApproval(s.circleId, LEAVE_AREA_ENVELOPE_ACTION, params)
}

/** The private escalation banner (task deliverable 2) — rendered on the
 *  Map tab (see app.ts's `mapView`), never anywhere a guardian's device
 *  would show it, since it only ever reflects THIS device's own module-
 *  level `banners` map (never persisted, never synced). */
export function escalationBannerView(p: store.Persisted): string {
  if (!banners.size) return ''
  const now = nowSec()
  const items = [...banners.entries()].map(([circleId, b]) => {
    const circleName = p.circles.find((c) => c.id === circleId)?.name ?? 'a circle'
    const copy = b.escalated
      ? (b.sent ? escalatedChildCopy(b.placeName, false) : escalationPendingCopy(b.placeName))
      : graceWarningCopy(b.placeName, Math.max(0, Math.ceil(((b.graceEndsAt ?? now) - now) / 60)))
    // Task 5 (§13.4): "Ask to go out" sits right on the warning banner —
    // the place's own id (needed to open the form) isn't carried by
    // `EscalationBanner` itself (it only ever knows the NAME — see that
    // interface's own doc comment), so this is a best-effort by-name
    // lookup against the circle's currently-synced places, same trade-off
    // `applyLeaveApprovalToEscalation`'s own doc comment already accepts.
    // Escalated-but-already-sent episodes still offer it — asking after
    // the fact still records the approval for the NEXT time (task scope:
    // this doesn't retroactively un-tell the guardian).
    const place = (p.places[circleId] ?? []).find((pl) => pl.name === b.placeName)
    const askButton = place
      ? `<button type="button" class="map-chip" data-action="places-leave-open" data-circle="${esc(circleId)}" data-place="${esc(place.id)}">Ask to go out</button>${leaveFormView(circleId, place.id)}`
      : ''
    return `<p class="escalation-banner${b.escalated ? ' escalated' : ''}">${esc(copy)} <span class="muted small">(${esc(circleName)})</span></p>${askButton}`
  }).join('')
  return items
}

/** The Circles tab's "Safe places" section — per-circle list, guardian
 *  delete affordance. Creation only happens from the Map tab (see
 *  `mapOverlayView`/`placeFormView` above). */
export function view(p: store.Persisted, fam: SessionInfo): string {
  if (!p.circles.length) return ''
  const sections = p.circles.map((c) => circlePlacesView(p, c, fam)).filter((s) => s.length > 0).join('')
  if (!sections) return ''
  return `<section class="contact-group"><h2>Safe places</h2>${sections}</section>`
}

function circlePlacesView(p: store.Persisted, c: Circle, fam: SessionInfo): string {
  const places = p.places[c.id] ?? []
  const canManage = isGuardian(c, fam.identityPk)
  if (!places.length) return ''
  const rows = places.map((pl) => placeRowView(c.id, pl, canManage)).join('')
  return `<div><strong>${esc(c.name)}</strong><ul class="contact-list">${rows}</ul></div>`
}

function placeRowView(circleId: string, pl: Place, canManage: boolean): string {
  const notify = [pl.arrivalNotify ? 'arrival' : '', pl.departureNotify ? 'departure' : ''].filter(Boolean).join(', ') || 'no notifications'
  const escalationLabel = pl.escalation === 'immediate' ? 'tells the circle right away' : `warns first (${pl.graceMinutes} min)`
  const removeBtn = canManage
    ? `<button type="button" data-action="places-delete" data-circle="${esc(circleId)}" data-id="${esc(pl.id)}">Remove</button>`
    : ''
  // Task 5 (§13.4): the "place sheet" entry point — asking proactively,
  // before any warning banner exists. Only a non-guardian (a child, in
  // practice — see `tick()`'s own `escalationEnabled` gate) ever needs to
  // ask permission to leave a place they don't manage themselves.
  const askButton = !canManage
    ? `<button type="button" data-action="places-leave-open" data-circle="${esc(circleId)}" data-place="${esc(pl.id)}">Ask to go out</button>${leaveFormView(circleId, pl.id)}`
    : ''
  return `
    <li class="contact-item">
      ${esc(pl.name)}<span class="badge">${esc(placeTypeLabel(pl.type))} · ${pl.radiusMetres}m</span>
      <p class="muted small">${esc(notify)} · ${esc(escalationLabel)}</p>
      ${removeBtn}
      ${askButton}
      ${canManage ? arrivalWindowsSectionView(circleId, pl) : ''}
    </li>`
}

// ---------------------------------------------------------------------------
// Expected arrivals (Phase 3 Task 4) — guardian-only editor nested inside
// each place row above (same gate as the "Remove" button — `canManage`,
// `isGuardian(c, fam.identityPk)`). Every edit (add/toggle/remove) routes through
// the existing `savePlaces` full-set publish — no new wire type, matching
// the wire-compat note (`arrivalWindows` rides inside the existing
// `kindependence-places` payload as a field already on `Place`). Evaluating
// these rules is Task 5's job; this is model + sync + editor UI only, same
// "no unit tests (build-gated)" convention as the rest of this view section.
// ---------------------------------------------------------------------------

async function updatePlaceWindows(circleId: string, placeId: string, fn: (windows: ArrivalWindow[]) => ArrivalWindow[]): Promise<void> {
  const current = store.load().places[circleId] ?? []
  const next = current.map((pl) => (pl.id === placeId ? { ...pl, arrivalWindows: fn(pl.arrivalWindows ?? []) } : pl))
  await savePlaces(circleId, next)
}

async function addArrivalWindow(circleId: string, placeId: string, draft: { days: number[]; arriveBy: string; graceMin: number }): Promise<void> {
  await updatePlaceWindows(circleId, placeId, (windows) => {
    if (windows.length >= MAX_WINDOWS_PER_PLACE) return windows
    const w: ArrivalWindow = { id: newWindowId(), days: [...new Set(draft.days)], arriveBy: draft.arriveBy, graceMin: draft.graceMin, enabled: true }
    return [...windows, w]
  })
}

async function toggleArrivalWindow(circleId: string, placeId: string, windowId: string): Promise<void> {
  await updatePlaceWindows(circleId, placeId, (windows) => windows.map((w) => (w.id === windowId ? { ...w, enabled: !w.enabled } : w)))
}

async function removeArrivalWindow(circleId: string, placeId: string, windowId: string): Promise<void> {
  await updatePlaceWindows(circleId, placeId, (windows) => windows.filter((w) => w.id !== windowId))
}

/** Review-minor #2: constant-label + `aria-current` idiom (matches app.ts's
 *  `batteryShareToggleView`/`batteryAlertsToggleView` — see that file's own
 *  doc comment on why the OLD two-differently-worded-strings pattern reads
 *  as mismatched phrasing rather than one control toggling). The label
 *  describes what the chip IS ("Active"), never changes; `aria-current`
 *  alone carries whether it currently is. */
const WINDOW_TOGGLE_LABEL = 'Active'

function windowRowView(circleId: string, placeId: string, w: ArrivalWindow): string {
  return `
    <li class="contact-item${w.enabled ? '' : ' muted'}">
      ${esc(formatDays(w.days))} · by ${esc(w.arriveBy)} · ${w.graceMin} min grace
      <button type="button" class="precision-chip" data-action="places-window-toggle"
        data-circle="${esc(circleId)}" data-place="${esc(placeId)}" data-window="${esc(w.id)}" aria-current="${w.enabled}">
        ${WINDOW_TOGGLE_LABEL}
      </button>
      <button type="button" data-action="places-window-remove"
        data-circle="${esc(circleId)}" data-place="${esc(placeId)}" data-window="${esc(w.id)}">Remove</button>
    </li>`
}

/** Review-minor #3: per-place form-error state for the add-window form —
 *  same `.form-error` idiom `placeFormView`'s `err` uses, just keyed by
 *  `placeId` since (unlike the single top-level place form) every place row
 *  with spare window capacity renders its OWN inline add-form
 *  simultaneously. Cleared on a successful submit; left stale otherwise so
 *  the message survives the re-render `store.notify()` triggers. */
const windowFormErrors = new Map<string, string>()

function windowFormErrorView(placeId: string): string {
  const msg = windowFormErrors.get(placeId)
  return msg ? `<p class="form-error">${esc(msg)}</p>` : ''
}

function windowAddFormView(circleId: string, placeId: string): string {
  const dayChips = DAY_LABELS_MON_FIRST.map(({ day, label }) => `
    <label class="confirm-gate"><input type="checkbox" id="win-day-${esc(placeId)}-${day}" /> ${label}</label>`).join('')
  const graceOptions = WINDOW_GRACE_OPTIONS_MIN.map((m) => `<option value="${m}"${m === DEFAULT_WINDOW_GRACE_MIN ? ' selected' : ''}>${m} min grace</option>`).join('')
  return `
    <div class="window-form">
      <div class="schedule-chips">${dayChips}</div>
      <input type="time" id="win-time-${esc(placeId)}" />
      <select id="win-grace-${esc(placeId)}">${graceOptions}</select>
      ${windowFormErrorView(placeId)}
      <div class="sheet-actions">
        <button type="button" data-action="places-window-add" data-circle="${esc(circleId)}" data-place="${esc(placeId)}">Add expected arrival</button>
      </div>
    </div>`
}

function arrivalWindowsSectionView(circleId: string, pl: Place): string {
  const windows = pl.arrivalWindows ?? []
  const rows = windows.map((w) => windowRowView(circleId, pl.id, w)).join('')
  const list = rows ? `<ul class="contact-list">${rows}</ul>` : '<p class="muted small">No expected-arrival rules yet.</p>'
  const addForm = windows.length < MAX_WINDOWS_PER_PLACE ? windowAddFormView(circleId, pl.id) : ''
  return `
    <div class="arrival-windows">
      <p class="muted small"><strong>Expected arrivals</strong></p>
      ${list}
      ${addForm}
    </div>`
}

function readWindowDays(placeId: string): number[] {
  const days: number[] = []
  for (const { day } of DAY_LABELS_MON_FIRST) {
    const el = document.getElementById(`win-day-${placeId}-${day}`) as HTMLInputElement | null
    if (el?.checked) days.push(day)
  }
  return days
}

/** Review-minor #3 (sets/clears `windowFormErrors`, same idiom as
 *  `submitPlaceForm`'s sibling form) + #6 (rejects an arriveBy+grace
 *  combination that crosses midnight, per `windowCrossesMidnight`'s own doc
 *  comment) — every early-return now leaves an actionable message behind
 *  instead of silently no-oping. */
function submitWindowForm(circleId: string, placeId: string): void {
  const days = readWindowDays(placeId)
  const arriveBy = (document.getElementById(`win-time-${placeId}`) as HTMLInputElement | null)?.value ?? ''
  const graceMin = Number((document.getElementById(`win-grace-${placeId}`) as HTMLSelectElement | null)?.value ?? DEFAULT_WINDOW_GRACE_MIN)
  if (!days.length) { windowFormErrors.set(placeId, 'Choose at least one day.'); store.notify(); return }
  if (parseHHMM(arriveBy) === null) { windowFormErrors.set(placeId, 'Choose an arrival time.'); store.notify(); return }
  if (!Number.isFinite(graceMin)) { windowFormErrors.set(placeId, 'Choose a grace period.'); store.notify(); return }
  if (windowCrossesMidnight(arriveBy, graceMin)) {
    windowFormErrors.set(placeId, 'Choose an earlier time or shorter grace period — this combination would cross midnight.')
    store.notify()
    return
  }
  windowFormErrors.delete(placeId)
  // Added: the form (still on screen) starts afresh — the window lands
  // asynchronously, after the render that consumed this tap.
  clearFields([...DAY_LABELS_MON_FIRST.map(({ day }) => `win-day-${placeId}-${day}`), `win-time-${placeId}`, `win-grace-${placeId}`])
  void addArrivalWindow(circleId, placeId, { days, arriveBy, graceMin })
}

/** The You-tab privacy overview's read-only "expected arrivals" list for one
 *  circle (Phase 3 Task 4, brief: `"School — expected by 08:45, Mon–Fri"`) —
 *  every ENABLED window across the circle's places. Every circle member
 *  (not only children — this device's own You tab is role-agnostic) sees
 *  the same rules a guardian has configured; a child device has no OTHER
 *  way to see them at all, since the editor above is guardian-gated. Called
 *  directly from app.ts's `privacySummaryView`, same "thin read accessor,
 *  no new computation, single caller" idiom as `currentEscalation`. */
export function arrivalWindowsSummaryView(p: store.Persisted, circleId: string): string {
  const places = p.places[circleId] ?? []
  const lines: string[] = []
  for (const pl of places) {
    for (const w of pl.arrivalWindows ?? []) {
      if (!w.enabled) continue
      lines.push(`${pl.name} — expected by ${w.arriveBy}, ${formatDays(w.days)}`)
    }
  }
  return lines.map((line) => `<p class="muted small">${esc(line)}</p>`).join('')
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

// ---------------------------------------------------------------------------
// Action dispatch — app.ts delegates every `places-*` data-action here,
// EXCEPT `places-add-here` (needs the live MapView's centre, which only
// app.ts holds — see `mapOverlayView`'s doc comment).
// ---------------------------------------------------------------------------

export function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'places-form-submit':
      submitPlaceForm()
      break
    case 'places-form-cancel':
      closePlaceForm()
      break
    case 'places-delete':
      void deletePlace(node.dataset.circle ?? '', node.dataset.id ?? '')
      break
    case 'places-window-add':
      submitWindowForm(node.dataset.circle ?? '', node.dataset.place ?? '')
      break
    case 'places-window-toggle':
      void toggleArrivalWindow(node.dataset.circle ?? '', node.dataset.place ?? '', node.dataset.window ?? '')
      break
    case 'places-window-remove':
      void removeArrivalWindow(node.dataset.circle ?? '', node.dataset.place ?? '', node.dataset.window ?? '')
      break
    case 'places-leave-open': {
      const circleId = node.dataset.circle ?? ''
      const placeId = node.dataset.place ?? ''
      const place = (store.load().places[circleId] ?? []).find((pl) => pl.id === placeId)
      if (circleId && placeId && place) openLeaveForm(circleId, placeId, place.name)
      break
    }
    case 'places-leave-cancel':
      closeLeaveForm()
      break
    case 'places-leave-submit':
      submitLeaveForm()
      break
    default:
      break
  }
}
