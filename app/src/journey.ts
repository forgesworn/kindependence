// Journey mode (Phase 5 Task 3, brief §32.2): a lightweight "I'm heading to
// X" a circle member (child OR guardian — any member) can start for a
// place, a live meeting point, or a free-text destination. Same
// render-on-state/registration idioms as every other domain module here:
// `ensure()` is the one side-effecting entry point (registers beacons.ts's
// journey-floor provider, starts a light 30s auto-complete/expiry timer);
// `startJourney`/`completeJourney`/`cancelJourney` are the impure write
// paths; the pure section below (`hasArrived`/`isExpired`/the reason
// builders+detectors) is unit-tested in isolation (journey.test.ts).
//
// One active journey per circle (task contract): `startJourney` replaces
// whatever was already active for that circle with EXPLICIT cancel
// semantics — it calls `cancelJourney` on the old one first (Activity
// records the replacement, `params.cancelled: '1'`, no buzz — see
// `cancelJourney`'s own doc comment for why a cancellation is never itself
// a circle-facing wire event) before writing the new one.
//
// Two structured reasons ride the untargeted circle-chat wire — Phase 7 Task 3
// moved this off flock's `t:'buzz'` (which now rejects free text) onto
// kindependence's own `t:'kindependence-msg'` via the shared codec
// (`buildKindependenceMsgSignal`), same transport every other structured send in
// this codebase now uses (see messages.ts's own module doc comment):
// `buildJourneyStartReason` ("Heading to X" / "Heading to X
// (expected by HH:MM)") always fires on start; `buildJourneyDoneReason`
// ("Journey to X complete") is the ARRIVAL-COLLISION RESOLUTION (task
// contract, verbatim): a naive "Arrived at X" journey-done buzz would
// collide with places.ts's OWN `buildArrivalReason` — both semantically (two
// different modules independently telling the circle "arrived") and, for a
// PLACE destination specifically, redundantly (places.ts's own `tick()`
// already sends exactly that buzz the moment the device's fix lands inside
// the place's geofence, if `arrivalNotify` is on). So: a journey whose dest
// is a PLACE, AND whose place still has `arrivalNotify` on, sends NO
// journey-done buzz at all on completion — it reuses the EXISTING arrival
// flow (places.ts's own geofence-triggered buzz, whether or not that already
// fired, is the circle's one and only "arrived" signal for that place). Every
// other case sends `buildJourneyDoneReason`: a MEET point or free LABEL dest
// (neither of which places.ts has any opinion about, so nothing else would
// ever tell the circle the journey ended); a PLACE dest whose place has
// `arrivalNotify` OFF (spec §3(c)'s literal rule, queue fix — otherwise
// places.ts sends nothing on entry either, and the journey goes completely
// silent after the initial "Heading to" buzz); or a PLACE dest whose place
// has been deleted since the journey started (no arrival flow left to reuse,
// so treated the same as a label — see `shouldSendJourneyDoneBuzz`). This
// applies identically whether completion is automatic (`tick()`'s own
// arrival/radius check) or manual ("I'm there" — same dest-based rule, task
// contract: "completes with buzz per dest rules").
//
// Auto-complete (least-plumbing choice, documented per the task brief):
// journey.ts runs its OWN 30s interval (`ensure()`, mirroring meet.ts's own
// light refresh timer) rather than piggybacking on places.tick's existing
// 30s cadence via a registered callback — the two evaluate genuinely
// different things (places.tick's geofence/window/escalation state machine
// vs. this module's arrival-or-expiry check over however many circles have
// an active journey, typically zero), and a registered-callback seam into
// places.ts would only buy sharing a single setInterval at the cost of a new
// cross-module contract for a plumbing saving of one timer. `hasArrived`
// (below) reuses places.ts's own `placeToGeofence`/flock's `isInside` for a
// PLACE dest — the SAME geometry the child's escalation supervisor and
// arrival/departure detection already evaluate against, just looked up
// fresh each tick by place id (not places.ts's own private
// `insidePlaceIds` state, which isn't exported) — and flock's
// `haversineMetres` against `JOURNEY_ARRIVE_RADIUS_M` (150 m) for any OTHER
// dest that carries a `geohash` (a meet point; a free label typed with no
// location never carries one and so can only ever end by "I'm there" or the
// 6h expiry — task contract: "lightweight", no location promised for that
// case).
//
// The ROUTINE emission floor (task contract: Street, 7, while a journey is
// active) is folded into beacons.ts at the SAME merge point
// `circleBaselinePrecision`'s own schedule override sits at — see
// beacons.ts's `applyJourneyFloor` doc comment for the full resolution
// order. This module never imports beacons.ts's emit internals directly;
// `ensure()` below registers a provider (`beacons.setJourneyFloorProvider`),
// same "registration, not import" idiom as beacons.ts's own
// `setActiveAgreementProvider` (agreements.ts registers there for the exact
// same reason: beacons.ts is imported BY this module, so the reverse import
// would cycle).
//
// Auto-expire (task contract: 6h, `JOURNEY_EXPIRE_SEC`) is a silent safety
// valve, not a circle-facing event: no buzz, Activity `'journey-done'` with
// `params.expired: '1'` — a stale "arrived" would mislead the circle into
// thinking the trip is over when really it's just gone unanswered long
// enough that this module gave up floor-raising for it. Manual cancel is the
// same "no buzz" shape (`params.cancelled: '1'`) for the opposite reason
// (global constraints §31: cancelling isn't itself an event the circle needs
// framed — it's simply the member saying "never mind").

import * as store from './store.js'
import type { Journey } from './store.js'
export type { Journey } from './store.js'
import * as beacons from './beacons.js'
import * as activity from './activity.js'
import { placeToGeofence, type Place } from './places.js'
import { appRelays } from './circles.js'
import { notify, shouldNotifyForEvent } from './notify.js'
import { currentSession, phoneSigner } from './session.js'
import { deriveInbox, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftWrap } from '@forgesworn/roost-kit'
import type { SignedEvent } from '@forgesworn/roost-kit'
import { buildKindependenceMsgSignal } from './legacy-buzz.js'
import { isInside, haversineMetres, type LatLng } from '@forgesworn/flock/geofence'
import { decode as decodeGeohash } from 'geohash-kit'

const nowSec = (): number => Math.floor(Date.now() / 1000)

// ---------------------------------------------------------------------------
// Constants + shape — task-contract verbatim (`Journey`/`JOURNEY_EXPIRE_SEC`
// per the brief; `Journey` itself is typed in store.ts, this module's own
// convention — see that file's own doc comment on the `ScheduleRule`/`Place`
// split — everything that WRITES or EVALUATES a journey lives here).
// ---------------------------------------------------------------------------

export interface JourneyDest {
  kind: 'place' | 'meet' | 'label'
  id?: string
  label: string
  geohash?: string
}

/** Auto-expire safety valve (task contract), seconds — 6 hours. */
export const JOURNEY_EXPIRE_SEC = 21600

/** Auto-complete radius for a geohash-carrying dest (a meet point, or a
 *  free label the picker attached a map point to — task contract: "within
 *  150 m of a geohash dest"), metres. */
export const JOURNEY_ARRIVE_RADIUS_M = 150

/** The ROUTINE emission floor a journey imposes while active (task
 *  contract: Street) — `Journey.floorPrecision`'s only legal value, so this
 *  is the one place that literal `7` is spelled out. */
export const JOURNEY_FLOOR_PRECISION = 7

/** Defensive cap on a free-text ('label' dest) destination name — mirrors
 *  places.ts's `MAX_PLACE_NAME_LEN`/meet.ts's `MAX_MEET_NAME_LEN` idiom.
 *  `'place'`/`'meet'` dests inherit an already-capped name from their own
 *  module, so this only ever actually trims a hand-typed label. */
export const JOURNEY_LABEL_MAX = 40

function randomHex(byteLen: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLen)))
}

/** A fresh journey id — unlinkability handle, not a secret, same idiom as
 *  places.ts's `newPlaceId`/meet.ts's `newMeetId`. */
export function newJourneyId(): string {
  return randomHex(8)
}

// ---------------------------------------------------------------------------
// Reason text — dynamic (destination labels are free text/guardian-chosen
// place names), PREFIX-recognised same as places.ts's own arrival/departure/
// not-yet reasons (see that file's own doc comment on why this is a prefix
// match, not exact equality). Pure, unit-tested directly for round-trip +
// non-collision with places.ts's own prefixes.
// ---------------------------------------------------------------------------

const JOURNEY_START_PREFIX = 'Heading to '
const JOURNEY_START_INFIX = ' (expected by '
const JOURNEY_START_SUFFIX = ')'

/** `"Heading to X"`, or `"Heading to X (expected by HH:MM)"` when
 *  `expectedByHHMM` is given (task contract, verbatim). */
export function buildJourneyStartReason(label: string, expectedByHHMM?: string): string {
  return expectedByHHMM ? `${JOURNEY_START_PREFIX}${label}${JOURNEY_START_INFIX}${expectedByHHMM}${JOURNEY_START_SUFFIX}` : `${JOURNEY_START_PREFIX}${label}`
}

/** Inverse of `buildJourneyStartReason` — `undefined` unless `reason` starts
 *  with the fixed prefix. When the optional expected-by suffix is ALSO
 *  present (infix found, string ends with the fixed suffix), both fields are
 *  returned; otherwise `expectedByHHMM` is omitted and `label` is everything
 *  after the prefix. Same "first infix match, best guess" tolerance as
 *  places.ts's `detectNotYetReason` for a label that happens to contain the
 *  literal infix text. */
export function detectJourneyStartReason(reason: string): { label: string; expectedByHHMM?: string } | undefined {
  if (!reason.startsWith(JOURNEY_START_PREFIX)) return undefined
  const body = reason.slice(JOURNEY_START_PREFIX.length)
  if (body.endsWith(JOURNEY_START_SUFFIX)) {
    const infixIdx = body.indexOf(JOURNEY_START_INFIX)
    if (infixIdx !== -1) {
      return { label: body.slice(0, infixIdx), expectedByHHMM: body.slice(infixIdx + JOURNEY_START_INFIX.length, body.length - JOURNEY_START_SUFFIX.length) }
    }
  }
  return { label: body }
}

const JOURNEY_DONE_PREFIX = 'Journey to '
const JOURNEY_DONE_SUFFIX = ' complete'

/** `"Journey to X complete"` — the ARRIVAL-COLLISION RESOLUTION (module doc
 *  comment): callers only ever send this for a MEET/LABEL dest; a PLACE
 *  dest's completion sends no buzz of its own at all (reuses places.ts's
 *  existing arrival flow instead — see `completeJourney`). */
export function buildJourneyDoneReason(label: string): string {
  return `${JOURNEY_DONE_PREFIX}${label}${JOURNEY_DONE_SUFFIX}`
}

/** Inverse of `buildJourneyDoneReason` — strict prefix+suffix parse (mirrors
 *  places.ts's `detectNotYetReason`'s own discipline), `undefined` unless
 *  both the fixed prefix and suffix are present. */
export function detectJourneyDoneReason(reason: string): string | undefined {
  if (!reason.startsWith(JOURNEY_DONE_PREFIX) || !reason.endsWith(JOURNEY_DONE_SUFFIX)) return undefined
  return reason.slice(JOURNEY_DONE_PREFIX.length, reason.length - JOURNEY_DONE_SUFFIX.length)
}

/** Unix seconds → zero-padded 24h `'HH:MM'`, device-local — the wire text's
 *  own clock format (task contract: "expected by HH:MM"). Deterministic
 *  given `unixSec` (no live-clock read), unlike app.ts's own
 *  `formatClockTime` (which goes through `toLocaleTimeString` for display
 *  formatting) — this is the value that rides the WIRE, so it needs to be
 *  exactly reproducible across locales/environments, not just human-legible
 *  in one. */
export function formatExpectedBy(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ---------------------------------------------------------------------------
// Auto-complete / expiry — pure decision functions, unit-tested directly.
// ---------------------------------------------------------------------------

/** Has the device arrived at `dest`? Two paths (task contract): a `'place'`
 *  dest checks the LIVE place geofence (`place` is the CURRENT lookup by
 *  `dest.id` — `undefined` when that place no longer resolves, e.g. deleted
 *  since the journey started, which fails safe to "not arrived" rather than
 *  guessing); any OTHER dest carrying a `geohash` (a `'meet'` point, or a
 *  `'label'` the picker attached a map point to) uses straight-line
 *  haversine distance against `JOURNEY_ARRIVE_RADIUS_M`. A `'label'` dest
 *  with no `geohash` at all (typed free-hand, no location) never
 *  auto-completes this way — see the module doc comment. */
export function hasArrived(dest: JourneyDest, place: Place | undefined, fix: LatLng): boolean {
  if (dest.kind === 'place') return place ? isInside(fix, placeToGeofence(place)) : false
  if (dest.geohash) return haversineMetres(fix, decodeGeohash(dest.geohash)) <= JOURNEY_ARRIVE_RADIUS_M
  return false
}

/** Auto-expire safety valve (task contract: 6h) — pure given `nowSecValue`. */
export function isExpired(journey: Journey, nowSecValue: number): boolean {
  return nowSecValue - journey.startedAt >= JOURNEY_EXPIRE_SEC
}

/** Whether `completeJourney` should send the `buildJourneyDoneReason` buzz
 *  (queue fix, spec §3(c) literal rule). A MEET/LABEL dest always sends it —
 *  nothing else would ever tell the circle the journey ended (unchanged from
 *  the module doc comment's original rule). A PLACE dest is the refinement:
 *  when the place's OWN `arrivalNotify` is on, places.ts's `tick()` already
 *  sends an arrival buzz the moment the fix lands inside the geofence (see
 *  that file's `place?.arrivalNotify` gate), so this stays silent to avoid a
 *  redundant "arrived" announcement. But when `arrivalNotify` is off,
 *  places.ts sends NOTHING on entry — so without this buzz, a journey to
 *  that place would go completely silent after the initial "Heading to"
 *  buzz. A deleted place (`place` undefined — removed from the circle since
 *  the journey started) is treated the same as "notify off": there is no
 *  possible arrival flow left to reuse, so the buzz fires. */
export function shouldSendJourneyDoneBuzz(dest: JourneyDest, place: Place | undefined): boolean {
  if (dest.kind !== 'place') return true
  return !place || !place.arrivalNotify
}

// ---------------------------------------------------------------------------
// One active journey per circle — read accessor.
// ---------------------------------------------------------------------------

/** `circleId`'s currently active journey, or `undefined` — pure accessor
 *  over `Persisted.journeys` (task contract: `activeJourney(p, circleId)`). */
export function activeJourney(p: store.Persisted, circleId: string): Journey | undefined {
  return p.journeys[circleId]
}

function clearJourneyRecord(circleId: string): void {
  store.update((sp) => {
    if (!(circleId in sp.journeys)) return
    const next = { ...sp.journeys }
    delete next[circleId]
    sp.journeys = next
  })
}

/** `journeyId` appended to the synthesised id (same "T6 minor" idiom as
 *  `startJourney`'s own journey-start record, just above) — two DIFFERENT
 *  journeys ending for the SAME circle within the same wall-clock second
 *  (e.g. a completion immediately followed by a fresh start immediately
 *  cancelled) would otherwise collide on id and the second insert would be
 *  silently dropped as a dedupe. */
function recordJourneyDoneActivity(circleId: string, journeyId: string, actorPk: string, label: string, at: number, extra: Record<string, string> = {}): void {
  activity.recordActivity({
    id: `${activity.localActivityId('journey-done', at, circleId)}-${journeyId}`, at, kind: 'journey-done', circleId, actorPk,
    params: { place: label, ...extra },
  })
}

async function sendJourneyBuzz(fromPk: string, circle: Circle, reason: string, at: number): Promise<void> {
  const inner = await buildKindependenceMsgSignal({ groupId: circle.id, seedHex: circle.seedHex, from: fromPk, reason, timestamp: at })
  const inbox = deriveInbox(circle.seedHex)
  const wrap: SignedEvent = await giftWrap(phoneSigner(), inbox.pk, inner, inbox.pk)
  await beacons.publishOrEnqueue(appRelays(store.load()), wrap)
}

// ---------------------------------------------------------------------------
// Outbound — start/complete/cancel. Any circle member may call these (task
// contract: "child AND adult usable, any member") — no guardian-only gate,
// unlike places.ts's `savePlaces`.
// ---------------------------------------------------------------------------

/** Starts a journey for `circleId` — cancels whatever was already active for
 *  it first (module doc comment: explicit cancel semantics, Activity
 *  records the replacement, no buzz for the replaced one), then writes and
 *  broadcasts the new one. Silently no-ops without a signed-in identity or a
 *  known circle. `expectedBy`, when given, is an absolute unix-seconds
 *  deadline — formatted to `'HH:MM'` (`formatExpectedBy`) for both the wire
 *  reason and the local Activity entry's `params.expectedBy`. */
export function startJourney(circleId: string, dest: JourneyDest, expectedBy?: number): void {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle) return
  if (p.journeys[circleId]) cancelJourney(circleId)
  const at = nowSec()
  const label = dest.label.slice(0, JOURNEY_LABEL_MAX)
  const boundDest: JourneyDest = { ...dest, label }
  const journey: Journey = {
    id: newJourneyId(), circleId, dest: boundDest, startedAt: at, floorPrecision: JOURNEY_FLOOR_PRECISION,
    ...(expectedBy !== undefined ? { expectedBy } : {}),
  }
  store.update((sp) => { sp.journeys = { ...sp.journeys, [circleId]: journey } })
  const hhmm = expectedBy !== undefined ? formatExpectedBy(expectedBy) : undefined
  activity.recordActivity({
    // journey.id appended (same "T6 minor" idiom as messages.ts's own
    // `messageActivityId`/places.ts's `recordIncomingWindowEvent`): two
    // journeys started for the SAME circle within the same wall-clock
    // second (e.g. this very `cancel-then-replace` flow, immediately
    // followed by a second replace) would otherwise collide on id and the
    // second insert would be silently dropped as a dedupe.
    id: `${activity.localActivityId('journey-start', at, circleId)}-${journey.id}`, at, kind: 'journey-start', circleId, actorPk: self.identityPk,
    params: { place: label, ...(hhmm ? { expectedBy: hhmm } : {}) },
  })
  void sendJourneyBuzz(self.identityPk, circle, buildJourneyStartReason(label, hhmm), at)
}

/** Completes `circleId`'s active journey — manual "I'm there", or `tick()`'s
 *  own auto-complete check. Same "per dest rules" buzz behaviour either way
 *  (task contract, refined by the queue fix — see `shouldSendJourneyDoneBuzz`
 *  for the full decision): a PLACE dest whose place still notifies on
 *  arrival sends NO journey-done buzz (reuses places.ts's existing arrival
 *  flow); every other case (MEET/LABEL dest, or a PLACE dest whose place has
 *  `arrivalNotify` off or has been deleted) sends `buildJourneyDoneReason`.
 *  Silently no-ops without a signed-in identity/known circle, or no active
 *  journey for `circleId`. */
export async function completeJourney(circleId: string): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  const journey = p.journeys[circleId]
  if (!self || !circle || !journey) return
  const at = nowSec()
  const place = journey.dest.kind === 'place' ? (p.places[circleId] ?? []).find((pl) => pl.id === journey.dest.id) : undefined
  clearJourneyRecord(circleId)
  recordJourneyDoneActivity(circleId, journey.id, self.identityPk, journey.dest.label, at)
  if (shouldSendJourneyDoneBuzz(journey.dest, place)) {
    await sendJourneyBuzz(self.identityPk, circle, buildJourneyDoneReason(journey.dest.label), at)
  }
}

/** Cancels `circleId`'s active journey — the "Cancel" button, or
 *  `startJourney`'s own replace-the-old-one step. NO buzz (global
 *  constraints §31: cancelling isn't an event the circle needs framed —
 *  it's the member simply saying "never mind"), Activity `'journey-done'`
 *  with `params.cancelled: '1'`. Silently no-ops without a signed-in
 *  identity or no active journey for `circleId`. */
export function cancelJourney(circleId: string): void {
  const p = store.load()
  const self = currentSession()
  const journey = p.journeys[circleId]
  if (!self || !journey) return
  const at = nowSec()
  clearJourneyRecord(circleId)
  recordJourneyDoneActivity(circleId, journey.id, self.identityPk, journey.dest.label, at, { cancelled: '1' })
}

function expireJourney(circleId: string, journey: Journey, identityPk: string, at: number): void {
  clearJourneyRecord(circleId)
  recordJourneyDoneActivity(circleId, journey.id, identityPk, journey.dest.label, at, { expired: '1' })
}

// ---------------------------------------------------------------------------
// Incoming — direct export, not a registration (same idiom as places.ts's
// `recordIncomingPlaceEvent`/`recordIncomingWindowEvent`: messages.ts's
// `handleIncomingBuzz` calls this directly once `classifyIncomingBuzz` has
// recognised the buzz's `reason` via `detectJourneyStartReason`/
// `detectJourneyDoneReason` — this module never imports messages.ts back).
// ---------------------------------------------------------------------------

function memberName(circle: Circle, pk: string): string {
  return circle.members.find((m) => m.pk === pk)?.name || `${pk.slice(0, 8)}…`
}

/** Records an incoming journey-start/journey-done buzz to Activity + fires a
 *  `'journey'`-kind Notification, freshness-gated same as
 *  places.ts's own `recordIncomingPlaceEvent`. `label`/`expectedByHHMM` are
 *  whatever `detectJourneyStartReason`/`detectJourneyDoneReason` parsed off
 *  the wire reason. */
export function recordIncomingJourneyEvent(kind: 'journey-start' | 'journey-done', circle: Circle, actorPk: string, label: string, expectedByHHMM: string | undefined, at: number): void {
  const id = activity.localActivityId(`${kind}-recv`, at, circle.id) + `-${actorPk}`
  const place = label || 'their destination'
  const params: Record<string, string> = { place, ...(expectedByHHMM ? { expectedBy: expectedByHHMM } : {}) }
  const inserted = activity.recordActivity({ id, at, kind, circleId: circle.id, actorPk, params })
  if (shouldNotifyForEvent(inserted, at, nowSec())) {
    const name = memberName(circle, actorPk)
    if (kind === 'journey-start') {
      const body = expectedByHHMM ? `Heading to ${place} (expected by ${expectedByHHMM})` : `Heading to ${place}`
      void notify('journey', actorPk, `${name} is heading out`, body)
    } else {
      void notify('journey', actorPk, `${name}'s journey is complete`, `Journey to ${place} complete`)
    }
  }
}

// ---------------------------------------------------------------------------
// tick()/ensure() — the impure orchestrator. Exported for direct unit
// testing (same convention as meet.ts's own `tick`), otherwise only ever
// invoked by `ensure()`'s own `setInterval`.
// ---------------------------------------------------------------------------

const TICK_INTERVAL_MS = 30_000

export function tick(): void {
  const p = store.load()
  const self = currentSession()
  if (!self) return
  const now = nowSec()
  const fix = beacons.selfFix()
  for (const [circleId, journey] of Object.entries(p.journeys)) {
    if (isExpired(journey, now)) {
      expireJourney(circleId, journey, self.identityPk, now)
      continue
    }
    if (!fix) continue
    const place = journey.dest.kind === 'place' ? (p.places[circleId] ?? []).find((pl) => pl.id === journey.dest.id) : undefined
    if (hasArrived(journey.dest, place, { lat: fix.lat, lon: fix.lon })) {
      void completeJourney(circleId)
    }
  }
}

let registered = false
export function ensure(): void {
  if (registered) return
  registered = true
  beacons.setJourneyFloorProvider((circleId) => activeJourney(store.load(), circleId)?.floorPrecision)
  tick() // don't make a just-started journey wait out a stale up-to-30s-old tick
  setInterval(tick, TICK_INTERVAL_MS)
}
