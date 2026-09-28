// Map-tab pure helpers — precision copy, availability state, the circle
// multi-selector's label/toggle logic, and the geohash-cell-to-GeoJSON-ring
// adapter. Deliberately factored OUT of map.ts: map.ts imports maplibre-gl
// at module scope and is only ever `import()`-ed lazily by app.ts once the
// Map tab first opens (see map.ts's own module doc comment) — if these pure
// functions lived there instead, app.ts would have to choose between
// importing maplibre-gl eagerly (defeating that lazy-load) just to build the
// circle-selector chip row / person sheet HTML strings on every render, or
// duplicating this logic. Living here, this module has zero DOM/maplibre
// dependencies (just geohash-kit, itself DOM-free) so both app.ts (eager,
// every render) and map.ts (lazy, for its own area-polygon rendering) import
// it freely, and it's directly unit-testable without touching either.
//
// Neutral language throughout (global-constraints.md §31) — precision terms
// and availability copy describe state, never accuse.

import { bounds as geohashBounds } from 'geohash-kit'
import type { Persisted } from './store.js'

// ---------------------------------------------------------------------------
// Precision — friendly terms, never the raw geohash character count (brief
// §7.2). Scale per the task contract: 9+ Precise, 7-8 Street, 6
// Neighbourhood, 5 District, <=4 Town; 0/absent means nothing shared yet.
// ---------------------------------------------------------------------------

/** Geohash precision at/above which a position renders as an exact marker
 *  rather than an approximate-area polygon (brief §7.2, task contract:
 *  "Precision >= 9 renders the existing marker"). Flock's own
 *  `DEFAULT_PRECISIONS.full` (see the `@forgesworn/flock` package's
 *  `policy.ts` — consumed from `flock-kit`, no longer vendored in-tree) is
 *  the same value
 *  — kept as an independent constant here rather than importing that one,
 *  since this threshold is a DISPLAY decision (what does the map draw?),
 *  not a disclosure decision (what does the beacon emit?); the two happen
 *  to agree today but are conceptually separate questions. */
const PRECISE_PRECISION = 9

/** Whether `precision` is fine enough to render as an exact marker (vs. an
 *  approximate-area polygon) — see `PRECISE_PRECISION`'s doc comment. */
export function isPrecise(precision: number): boolean {
  return precision >= PRECISE_PRECISION
}

/** The "nothing disclosed yet" precision term (precision <= 0 — no fix, or
 *  withheld) — exported so `locationModeLine` below can special-case it by
 *  value rather than a second hard-coded copy of the string. */
export const NOT_SHARING_TERM = 'Not sharing'

/** Friendly precision term for the map/person-sheet UI. */
export function precisionTerm(precision: number): string {
  if (precision <= 0) return NOT_SHARING_TERM
  if (precision >= PRECISE_PRECISION) return 'Precise'
  if (precision >= 7) return 'Street'
  if (precision === 6) return 'Neighbourhood'
  if (precision === 5) return 'District'
  return 'Town'
}

// ---------------------------------------------------------------------------
// Location-mode line (Task 8, brief §12/§25) — the one-sentence "what am I
// currently sharing" summary the You-tab privacy overview and the Map tab's
// self-marker sheet both render (replacing the pre-Task-8 self-sheet's
// single-global-baseline simplification — see app.ts's `circleModeLine`,
// which supplies `raise` from `agreements.ts`'s `nextOrCurrentRaise`
// converted to display strings). Pure string composition only — no
// knowledge of precision numbers, agreements, or the clock — so it stays
// trivially unit-testable and reusable by both call sites without either
// duplicating the sentence-building.
// ---------------------------------------------------------------------------

/** "Sharing Neighbourhood with Family." (no agreement, or one whose schedule
 *  hasn't raised disclosure yet or ever, and no active sharing-schedule rule
 *  either) / "Sharing Neighbourhood with Family · Precise from 17:45." (an
 *  agreement's schedule currently has, or is about to, raise disclosure
 *  above the baseline — `raise.whenLabel` is the caller's own pre-formatted
 *  clock time, e.g. "17:45") / "Sharing Street with Family until 15:30."
 *  (Phase 5 Task 2, brief §32.4 — a sharing-SCHEDULE rule, not an agreement,
 *  is currently the active baseline; `activeRule.untilLabel` is the caller's
 *  own pre-formatted clock time the rule's window ends) / "Not sharing with
 *  Family yet." (`baselineTerm` is `NOT_SHARING_TERM` — no fix at all yet,
 *  e.g. before the first GPS lock/permission grant — "Sharing Not sharing
 *  with Family" would otherwise read as broken English; a raise or active
 *  rule, if either is supplied, is dropped too, since nothing is actually
 *  being disclosed at all while there's no fix to disclose).
 *
 *  `raise` and `activeRule` are never both meaningfully rendered together —
 *  when both are supplied (an agreement raise happens to coincide with an
 *  active schedule rule), `raise` wins: it names a MORE specific, nearer-term
 *  commitment (this device's own `basePrecisionFor`/`circleBaselinePrecision`
 *  chain already folds the schedule rule INTO whatever baseline the raise is
 *  computed relative to — see beacons.ts's `basePrecisionFor` doc comment —
 *  so the schedule is never silently unaccounted for, just not named twice
 *  in one sentence). Callers (app.ts's `circleModeLine`) are expected to
 *  pass `activeRule` only when there is no `raise` in the first place, but
 *  this function stays defensive either way rather than trusting that. */
export function locationModeLine(
  circleName: string,
  baselineTerm: string,
  raise?: { term: string; whenLabel: string },
  activeRule?: { untilLabel: string },
): string {
  if (baselineTerm === NOT_SHARING_TERM) return `Not sharing with ${circleName} yet.`
  const base = `Sharing ${baselineTerm} with ${circleName}`
  if (raise) return `${base} · ${raise.term} from ${raise.whenLabel}.`
  if (activeRule) return `${base} until ${activeRule.untilLabel}.`
  return `${base}.`
}

// ---------------------------------------------------------------------------
// Availability state — brief §10's subset named by the task contract: live
// (<2min) / recent (<15min) / no recent update, each with an "approximate"
// variant when the position itself is coarser than precise, plus `hidden`
// for "there is no position to show at all" (never shared, or precision 0
// — §10's "location sharing intentionally hidden" / "access not granted",
// which look identical from this device's point of view: no beacon ever
// arrived). Pure — `nowSecValue` is passed in, never read from the clock.
// ---------------------------------------------------------------------------

export type AvailabilityState =
  | 'live' | 'approximate-live'
  | 'recent' | 'approximate-recent'
  | 'no-recent-update' | 'approximate-no-recent-update'
  | 'hidden'

const LIVE_WINDOW_SEC = 120
const RECENT_WINDOW_SEC = 900

export function availabilityState(pos: { precision: number; at: number } | undefined, nowSecValue: number): AvailabilityState {
  if (!pos || pos.precision <= 0) return 'hidden'
  const approx = !isPrecise(pos.precision)
  const age = nowSecValue - pos.at
  if (age < LIVE_WINDOW_SEC) return approx ? 'approximate-live' : 'live'
  if (age < RECENT_WINDOW_SEC) return approx ? 'approximate-recent' : 'recent'
  return approx ? 'approximate-no-recent-update' : 'no-recent-update'
}

/** Human copy for `availabilityState`'s result — neutral, no raw enum
 *  leaking into the UI. */
export function availabilityLabel(state: AvailabilityState): string {
  switch (state) {
    case 'live': return 'Live'
    case 'approximate-live': return 'Live · approximate area'
    case 'recent': return 'Recent'
    case 'approximate-recent': return 'Recent · approximate area'
    case 'no-recent-update': return 'No recent update'
    case 'approximate-no-recent-update': return 'No recent update · approximate area'
    case 'hidden': return 'Not sharing'
  }
}

// ---------------------------------------------------------------------------
// Honest availability states (Phase 4 Task 1, brief §10) — three additional
// RECEIVER-derived states layered on top of `AvailabilityState` above, each
// built ONLY from data this device already holds: beacons this device has
// already received (`beacons.memberPositions`), a battery reading a member
// has opted in to sharing (`battery.latestBatteryFor`), and this device's
// own held copy of an agreement's schedule (`agreements.nextOrCurrentRaise`).
// No new wire signal, no sender-side change — the hard constraint is
// "withhold is not a tell": a member who has battery-sharing turned off, or
// who has no active agreement, must render IDENTICALLY to one whose battery
// happens to be healthy or whose agreement happens to have no upcoming
// raise — there is nothing here that could let a viewer distinguish "chose
// not to share this" from "has nothing to share right now", and there must
// not be.
//
// `AvailabilityInputs` is plain data, not a live read — mapinfo.ts stays
// free of beacons.ts/battery.ts/agreements.ts imports (this file's own
// module doc comment: zero dependencies beyond geohash-kit), so callers
// (app.ts's person sheet, widget.ts's row builder) do the actual store
// reads and hand the results in as caller-shaped structs.
// ---------------------------------------------------------------------------

export type AvailabilityStateFull = AvailabilityState | 'sharing-scheduled' | 'battery-may-be-out' | 'never-heard'

export interface AvailabilityInputs {
  pos?: { precision: number; at: number }
  /** An opted-in battery reading — undefined whenever the member hasn't
   *  shared one at all, indistinguishable here from "shared one that's
   *  since gone stale" (staleness is the caller's own job to have already
   *  filtered out, same freshness gate as `battery.BATTERY_FRESH_SEC`
   *  elsewhere — this module never imports battery.ts to check it itself). */
  battery?: { pct: number; charging: boolean; at: number }
  /** The circle's active agreement's next-or-current schedule raise for
   *  this pk (`agreements.nextOrCurrentRaise`), if any. `term` is the
   *  friendly precision name (`precisionTerm`) of the step being raised
   *  TO — carried here as part of the input contract, though today's
   *  `availabilityLabelFull` copy names it directly ('Precise') rather
   *  than interpolating `term`, since every schedule this app currently
   *  builds (`DEFAULT_SCHEDULE`/`PRECISE_SCHEDULE`, agreements.ts) only
   *  ever raises to Precise. */
  agreementRaise?: { term: string; atUnix: number }
  /** Whether this device has EVER seen a position for this pk, this
   *  session — distinct from `pos` (the CURRENT one, possibly absent even
   *  for someone heard from earlier via a different circle than the one
   *  presently in view). See `availabilityStateFull`'s doc comment. */
  everHeard: boolean
}

/**
 * `AvailabilityState`'s receiver-derived superset. Precedence (task
 * contract, brief §10):
 *
 *  1. A fresh position — the existing 'live'/'approximate-live'/'recent'/
 *     'approximate-recent' tiers (`<15min` old) — always wins, unchanged:
 *     none of the new states ever override an actually-recent beacon.
 *  2. Else, a held agreement schedule promising a FUTURE precision raise
 *     (`agreementRaise.atUnix` strictly after `nowSecValue`) →
 *     'sharing-scheduled' — "they're not silent, a raise is due".
 *  3. Else, an opted-in battery reading at/below 5%, not charging →
 *     'battery-may-be-out' — the one state that ventures a GUESS at why
 *     the position feed has gone quiet, built only from a signal the
 *     member already chose to share.
 *  4. Else, no position at all AND this device has never once heard from
 *     this pk this session (`!everHeard`) → 'never-heard' — more honest
 *     copy than lumping a stranger in with "not sharing right now".
 *  5. Else, the existing no-recent-update/hidden logic
 *     (`availabilityState`) — a stale-but-real position, or a pk this
 *     device HAS heard from before but has no current position for.
 */
export function availabilityStateFull(inputs: AvailabilityInputs, nowSecValue: number): AvailabilityStateFull {
  const base = availabilityState(inputs.pos, nowSecValue)
  const fresh = base === 'live' || base === 'approximate-live' || base === 'recent' || base === 'approximate-recent'
  if (fresh) return base
  if (inputs.agreementRaise && inputs.agreementRaise.atUnix > nowSecValue) return 'sharing-scheduled'
  const b = inputs.battery
  if (b && b.pct <= 5 && !b.charging) return 'battery-may-be-out'
  if (!inputs.everHeard && !inputs.pos) return 'never-heard'
  return base
}

/** Human copy for `availabilityStateFull`'s three new states, delegating to
 *  `availabilityLabel` for everything already covered by the base
 *  `AvailabilityState`. Neutral throughout (global-constraints.md §31):
 *  'battery-may-be-out' and 'never-heard' both describe an absence of
 *  data, never assign blame or intent to the member on the other end.
 *  `extra.raiseTime` is the caller's own pre-formatted clock string (same
 *  "push formatting out to the caller" discipline as `locationModeLine`/
 *  `agreementScheduleText`) — REQUIRED (not just present-but-possibly-
 *  undefined) whenever the caller passes `extra` at all, since a
 *  'sharing-scheduled' state only ever comes from `availabilityStateFull`
 *  when `agreementRaise` was supplied, and both call sites (app.ts,
 *  widget.ts) only construct `extra` once they've already computed a real
 *  `raiseTime` string from that same raise — so there is no reachable case
 *  where 'sharing-scheduled' fires without one (review-minor: removed the
 *  unreachable 'Precise soon' fallback that used to paper over that). */
export function availabilityLabelFull(state: AvailabilityStateFull, extra?: { raiseTime: string }): string {
  if (state === 'sharing-scheduled') return `Precise from ${extra?.raiseTime}`
  if (state === 'battery-may-be-out') return 'No recent update — battery may have run out'
  if (state === 'never-heard') return 'No location shared'
  return availabilityLabel(state)
}

// ---------------------------------------------------------------------------
// Circle multi-selector — brief §6.3, simplified per the task contract to a
// chip row (All + one chip per circle) rather than a checkbox flyout.
// Persisted representation (store.ts's `Persisted.settings.mapCircles`):
// `undefined`/omitted means "no explicit filter" (every circle shown, the
// default); a real array is an explicit subset. Both an absent selection
// AND an explicit selection that happens to cover every known circle (or
// that's gone empty — see `toggleCircleSelection`) normalize to "show all"
// so a freshly joined circle appears under "All" without the stored
// selection needing to know about it, and unchecking every chip can't leave
// the map showing nobody.
// ---------------------------------------------------------------------------

/** The pubkey sentinel `map.ts`'s self-marker click and app.ts's person
 *  sheet both use for "this device's own position" — never a valid pubkey
 *  (those are 64 lowercase hex chars), so it can't collide with a real one.
 *  Shared here (not hard-coded independently in both places) so the two
 *  sides of the click -> sheet handoff can't drift apart. */
export const SELF_SHEET_TARGET = 'self'

/** The actual set of circle ids the map should render for, given the raw
 *  persisted selection. See the module-section doc comment above for the
 *  normalization rules. */
export function resolveCircleSelection(allCircleIds: readonly string[], selected: readonly string[] | undefined): Set<string> {
  if (!selected || selected.length === 0) return new Set(allCircleIds)
  const known = new Set(allCircleIds)
  const kept = selected.filter((id) => known.has(id))
  return kept.length ? new Set(kept) : new Set(allCircleIds)
}

/** Chip-row label for the current selection, per the plan's simplified
 *  §6.3 rule: All / the one circle's name / "N circles". */
export function circleSelectorLabel(circles: readonly { id: string; name: string }[], selected: readonly string[] | undefined): string {
  const effective = resolveCircleSelection(circles.map((c) => c.id), selected)
  if (effective.size === 0 || effective.size === circles.length) return 'All'
  if (effective.size === 1) {
    const [only] = effective
    return circles.find((c) => c.id === only)?.name ?? 'All'
  }
  return `${effective.size} circles`
}

/** Toggles `circleId`'s membership in the stored selection, returning the
 *  new value to persist. Toggling starts from a full baseline whenever the
 *  current selection is the default "All" (unset/empty) — so unchecking one
 *  chip out of "All" leaves every OTHER circle selected, matching brief
 *  §6.3's checkbox-list description ("all checked" is the starting state).
 *  Collapses back to `undefined` (canonical "All") whenever the result
 *  covers every circle OR ends up empty — see the module-section doc
 *  comment for why an empty selection isn't a distinct persisted state. */
export function toggleCircleSelection(allCircleIds: readonly string[], selected: readonly string[] | undefined, circleId: string): string[] | undefined {
  const baseline = selected && selected.length ? selected : allCircleIds
  const next = new Set(baseline)
  if (next.has(circleId)) next.delete(circleId)
  else next.add(circleId)
  const kept = allCircleIds.filter((id) => next.has(id)) // stable order, drops any stale/removed id
  return kept.length === allCircleIds.length || kept.length === 0 ? undefined : kept
}

// ---------------------------------------------------------------------------
// Geohash cell -> GeoJSON ring — the "approximate is an area, never a pin"
// rule (brief §7.2) needs the cell's bounding box as polygon coordinates.
// geohash-kit's own `bounds()` already does the actual bbox math; this is
// just the ring-shape adapter (closed, counter-clockwise exterior ring per
// RFC 7946) around it.
// ---------------------------------------------------------------------------

export function geohashCellRing(hash: string): Array<[number, number]> {
  const { minLat, maxLat, minLon, maxLon } = geohashBounds(hash)
  return [
    [minLon, minLat],
    [maxLon, minLat],
    [maxLon, maxLat],
    [minLon, maxLat],
    [minLon, minLat],
  ]
}

// ---------------------------------------------------------------------------
// Circle-geofence -> GeoJSON ring (Task 7, brief §13): a place is a centre +
// radius in metres, not a geohash cell — map.ts needs its boundary as an
// N-gon polygon for rendering (distinct style from the approximate-area
// cells above). geohash-kit has no destination-point helper, so this is the
// standard haversine "destination point given bearing + distance" formula,
// walked around a full circle. Pure — unit-tested against
// `@forgesworn/flock/geofence`'s own `haversineMetres` (every vertex should
// sit ~radiusMetres from the centre).
// ---------------------------------------------------------------------------

const EARTH_RADIUS_METRES = 6_371_000

function destinationPoint(lat: number, lon: number, bearingRad: number, distanceMetres: number): [number, number] {
  const angularDistance = distanceMetres / EARTH_RADIUS_METRES
  const phi1 = (lat * Math.PI) / 180
  const lambda1 = (lon * Math.PI) / 180
  const phi2 = Math.asin(
    Math.sin(phi1) * Math.cos(angularDistance) + Math.cos(phi1) * Math.sin(angularDistance) * Math.cos(bearingRad),
  )
  const lambda2 = lambda1 + Math.atan2(
    Math.sin(bearingRad) * Math.sin(angularDistance) * Math.cos(phi1),
    Math.cos(angularDistance) - Math.sin(phi1) * Math.sin(phi2),
  )
  const lonDeg = ((((lambda2 * 180) / Math.PI) + 540) % 360) - 180 // normalize to (-180, 180]
  return [lonDeg, (phi2 * 180) / Math.PI]
}

/** A closed GeoJSON ring (RFC 7946: first/last coordinate equal)
 *  approximating the circle of `radiusMetres` around `centre` as a
 *  `steps`-sided polygon, `[lon, lat]` order (matches `geohashCellRing`'s
 *  own convention). */
export function circlePolygonRing(centre: { lat: number; lon: number }, radiusMetres: number, steps = 32): Array<[number, number]> {
  const ring: Array<[number, number]> = []
  for (let i = 0; i < steps; i++) {
    const bearing = (i / steps) * 2 * Math.PI
    ring.push(destinationPoint(centre.lat, centre.lon, bearing, radiusMetres))
  }
  const first = ring[0]
  if (first) ring.push(first)
  return ring
}

// ---------------------------------------------------------------------------
// Mute/pin viewing preferences + adaptive default fit (Phase 4 Task 2, brief
// §9/§6.5). `store.ts`'s `Persisted.viewPrefs` is a VIEWING preference ONLY
// — see that field's own doc comment for the hard invariant this module
// upholds by construction: `notify.ts`, `safety.ts`, and `places.ts`'s
// escalation path never import anything from this section (verified by
// inspection), so a muted person's SOS/help/breach/pickup traffic notifies
// and banners exactly as if they were never muted. Pinning grants no new
// access — it only ever prioritises an ALREADY-permitted, already-visible
// position within `fitSet`'s own output; it never changes what's rendered
// or disclosed.
// ---------------------------------------------------------------------------

/** The five mute durations the person sheet's Mute submenu offers (brief
 *  §9, verbatim) — `sec` is either a fixed offset in seconds, the literal
 *  `'tomorrow'` (next local 04:00, see `muteUntil`), or `-1` (until
 *  manually restored). Order is display order. */
export const MUTE_DURATIONS = [
  { label: '10 min', sec: 600 },
  { label: '1 hour', sec: 3600 },
  { label: 'Until tomorrow', sec: 'tomorrow' },
  { label: '3 days', sec: 259200 },
  { label: 'Until I unmute', sec: -1 },
] as const

/** Resolves a `MUTE_DURATIONS` `sec` value (or any other duration in
 *  seconds) to the `mutedUntil` unix-seconds timestamp to persist. `-1`
 *  passes straight through as `store.ts`'s own "until manually restored"
 *  sentinel. `'tomorrow'` is the one duration that isn't a fixed offset —
 *  the NEXT local 04:00 from `localNow` (today's 04:00 if `localNow` is
 *  still strictly before it; tomorrow's otherwise, including when
 *  `localNow` IS exactly 04:00 — "next" means strictly future, never a
 *  zero-duration mute), converted back to a `nowSecValue`-relative offset
 *  so the result stays anchored to the same instant `nowSecValue`
 *  represents. `localNow` carries the timezone/wall-clock information bare
 *  epoch seconds can't — same "push the clock/timezone concern out to the
 *  caller" discipline as `formatClockTime`/`agreementScheduleText`
 *  elsewhere in this app. Pure — never reads the real clock itself. */
export function muteUntil(choice: number | 'tomorrow' | -1, nowSecValue: number, localNow: Date): number {
  if (choice === -1) return -1
  if (choice === 'tomorrow') {
    const next = new Date(localNow.getFullYear(), localNow.getMonth(), localNow.getDate(), 4, 0, 0, 0)
    if (next.getTime() <= localNow.getTime()) next.setDate(next.getDate() + 1) // JS Date normalizes month/year rollover
    return nowSecValue + Math.round((next.getTime() - localNow.getTime()) / 1000)
  }
  return nowSecValue + choice
}

/** Whether `pk` is currently muted — pure, `nowSecValue`-driven (never
 *  reads the clock itself, same discipline as `availabilityState`). `-1`
 *  (until-restored) is always muted; anything else is muted only while
 *  `mutedUntil` is still STRICTLY in the future — an exactly-expired or
 *  past `mutedUntil` (or no entry, or an entry with no `mutedUntil` at
 *  all, e.g. pinned-only) is not muted. */
export function isMuted(prefs: Persisted['viewPrefs'], pk: string, nowSecValue: number): boolean {
  const until = prefs[pk]?.mutedUntil
  if (until === undefined) return false
  if (until === -1) return true
  return until > nowSecValue
}

/** Human "time left" fragment for a muted person's status row (person
 *  sheet's Unmute button, circle member list's "Muted · …" row — both
 *  compose it behind their own "Muted · " prefix so the two call sites
 *  render identical copy). `-1` (until-restored) has no countdown;
 *  anything else rounds UP to the coarsest unit that keeps the number
 *  small ("2h left", not "119m left"), floored at "1m left" so a mute a
 *  few seconds from expiring never reads as "0m left". Caller's
 *  responsibility to only call this for an actually-muted entry — an
 *  already-expired `mutedUntil` would render a (harmless but meaningless)
 *  negative-clamped "1m left" here, same as `isMuted`'s own boundary. */
export function muteRemainingLabel(mutedUntil: number, nowSecValue: number): string {
  if (mutedUntil === -1) return 'until you unmute'
  const remain = Math.max(1, mutedUntil - nowSecValue)
  if (remain < 3600) return `${Math.max(1, Math.ceil(remain / 60))}m left`
  if (remain < 86400) return `${Math.ceil(remain / 3600)}h left`
  return `${Math.ceil(remain / 86400)}d left`
}

/** Great-circle distance in metres (haversine) — a local reverse-direction
 *  counterpart to `destinationPoint` above, sharing its
 *  `EARTH_RADIUS_METRES`. Kept local rather than importing
 *  `@forgesworn/flock/geofence`'s own `haversineMetres` (used elsewhere in
 *  this app, e.g. beacons.ts/places.ts) so THIS module's own documented
 *  promise — zero dependencies beyond geohash-kit (this file's own module
 *  doc comment) — holds for `fitSet` too; exported (rather than staying
 *  module-private) SOLELY so the test file can cross-check it directly
 *  against that same flock helper, same discipline `circlePolygonRing`'s
 *  own tests already use — see mapinfo.test.ts's `distanceMetres` describe
 *  block. */
export function distanceMetres(a: { lat: number; lon: number }, b: { lat: number; lon: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const dLat = toRad(b.lat - a.lat)
  const dLon = toRad(b.lon - a.lon)
  const lat1 = toRad(a.lat)
  const lat2 = toRad(b.lat)
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2
  return 2 * EARTH_RADIUS_METRES * Math.asin(Math.sqrt(h))
}

/** Standard median (average of the two middle values on an even-length
 *  input) — private, only ever called on non-empty arrays by `fitSet`
 *  below. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  const lower = sorted[mid - 1]
  const upper = sorted[mid]
  return sorted.length % 2 ? (upper as number) : ((lower as number) + (upper as number)) / 2
}

/** Outlier-exclusion floor (brief §6.5, verbatim: 50 km) — the minimum
 *  radius `fitSet` will always tolerate around the group's median centre,
 *  regardless of how tightly clustered everyone happens to be (so a family
 *  spread across one city never spuriously excludes its farthest member
 *  just because the median distance that day is tiny). */
const FIT_OUTLIER_FLOOR_M = 50_000

/** Outlier-exclusion multiplier (brief §6.5, verbatim: 5×) applied to the
 *  candidate group's own median distance from centre. */
const FIT_OUTLIER_MEDIAN_MULTIPLIER = 5

/** The adaptive default view's fit set (brief §6.5's "holiday abroad"
 *  rule, consumed by the Map tab's reset control and its initial view —
 *  app.ts/map.ts): self (if known) and every PINNED person are always
 *  included. An unmuted, unpinned person is included UNLESS their distance
 *  from the group's median centre exceeds `max(50 km, 5 × the group's own
 *  median distance from that centre)` — so a family gathered near home
 *  with one member on holiday abroad keeps the map fit to "near home"
 *  rather than zoomed out to fit a whole hemisphere. A MUTED person is
 *  excluded upfront (via `isMuted`) and never enters the candidate/stats
 *  set at all — same as the marker they don't get.
 *
 *  The "group" behind the median-centre/median-distance statistics is self
 *  (if known) + every unmuted person, pinned or not — self anchors the
 *  group the same way a pinned point does, so a lone traveller is
 *  correctly flagged relative to "where everyone else actually is" even
 *  when nobody happens to be pinned. Pure; never reads the clock (`nowSecValue`
 *  drives `isMuted`) or a live map. */
export function fitSet(
  people: Array<{ pk: string; lat: number; lon: number }>,
  prefs: Persisted['viewPrefs'],
  selfPos: { lat: number; lon: number } | null,
  nowSecValue: number,
): Array<{ lat: number; lon: number }> {
  const unmuted = people.filter((person) => !isMuted(prefs, person.pk, nowSecValue))

  const result: Array<{ lat: number; lon: number }> = []
  if (selfPos) result.push(selfPos)

  const statsPoints: Array<{ lat: number; lon: number }> = unmuted.map((person) => ({ lat: person.lat, lon: person.lon }))
  if (selfPos) statsPoints.push(selfPos)
  if (statsPoints.length === 0) return result

  const centre = { lat: median(statsPoints.map((pt) => pt.lat)), lon: median(statsPoints.map((pt) => pt.lon)) }
  const threshold = Math.max(
    FIT_OUTLIER_FLOOR_M,
    FIT_OUTLIER_MEDIAN_MULTIPLIER * median(statsPoints.map((pt) => distanceMetres(pt, centre))),
  )

  for (const person of unmuted) {
    const pinned = prefs[person.pk]?.pinned === true
    const point = { lat: person.lat, lon: person.lon }
    if (pinned || distanceMetres(point, centre) <= threshold) result.push(point)
  }
  return result
}

// ---------------------------------------------------------------------------
// Marker clustering (Phase 4 Task 3, brief §7.4) — nearby markers at the
// current zoom collapse into a single "N people" badge (brief §34.8's
// confirmed interaction: tap opens a member sheet directly, no zoom-first
// step). Clustering is a SCREEN-SPACE concern — map.ts projects each
// marker's lng/lat through the live maplibre camera (`map.project`) into
// CSS pixels before calling this, and unprojects the resulting cluster
// centroid back to a lng/lat for the badge marker (see that module's own
// `recluster` method) — this function itself is pure geometry over
// whatever points it's handed, no maplibre/DOM dependency, so it's directly
// unit-testable. A muted person never becomes a `ScreenPoint` in the first
// place (app.ts's `updateMapLayers` already excludes them, Task 2, brief
// §9) — this function has no mute-awareness of its own to keep it that way,
// same "pure geometry, caller does the filtering" split `fitSet` above
// already follows for its own muted-exclusion.
//
// Algorithm: a union-find over a grid-hash broad phase (cell size =
// `radiusPx`, so any two points within `radiusPx` of each other always fall
// in the same or an adjacent — 3x3-neighbourhood — cell: if
// `distance(p, q) <= radiusPx` then `|dx| <= radiusPx` and `|dy| <=
// radiusPx`, and for any reals `a`, `b` with `|a - b| <= R`,
// `|floor(a/R) - floor(b/R)| <= 1`; the neighbourhood check is therefore a
// SUPERSET of every true neighbour, narrowed by an exact Euclidean distance
// check before actually unioning two points). Chain-adjacency merges
// transitively — three points where only consecutive pairs are within
// `radiusPx` (the middle one bridging two ends that are themselves farther
// apart than `radiusPx`) still end up in ONE cluster, since union-find
// doesn't care which pair triggered the merge. `points` is sorted by `pk`
// FIRST, before any of the above — input order never changes which points
// end up grouped together (that's intrinsic to the `distance <= radiusPx`
// graph the points form, not to processing order), but it does fix the
// deterministic order `members` lists (and the clusters themselves) come
// back in, so two callers handed the same point set in a different array
// order get byte-identical output. The `radiusPx` boundary is inclusive
// (`distance <= radiusPx` merges, matching "within radiusPx" in the task
// brief) — a pair exactly at the boundary merges; a pair even fractionally
// beyond it doesn't.
// ---------------------------------------------------------------------------

/** One marker's already-projected screen position — `pk` is the member's
 *  pubkey for a precise marker, or (per the task brief) the pubkey of an
 *  approximate-area's cell-centre representative; either way just an opaque
 *  id to this function, carried straight through into the output
 *  `members` lists. */
export interface ScreenPoint { pk: string; x: number; y: number }

/** Greedy grid-hash clustering pass — see the module-section doc comment
 *  above for the algorithm and its guarantees. Every input point comes back
 *  in exactly one output cluster; a point with no neighbour within
 *  `radiusPx` comes back as its own 1-member cluster (map.ts renders that
 *  case as a normal marker, not a count badge — see its own doc comment).
 *  `x`/`y` on a returned cluster are the mean of its members' own `x`/`y`
 *  (the centroid) — for a 1-member cluster that's just the point itself. */
export function clusterScreenPoints(points: ScreenPoint[], radiusPx = 44): Array<{ x: number; y: number; members: string[] }> {
  const sorted = [...points].sort((a, b) => a.pk.localeCompare(b.pk))
  const n = sorted.length
  const parent = sorted.map((_, i) => i)
  const find = (start: number): number => {
    let cur = start
    while ((parent[cur] as number) !== cur) cur = parent[cur] as number
    return cur
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  // Broad phase: bucket every point by its `radiusPx`-sized grid cell.
  const cellKey = (p: ScreenPoint): string => `${Math.floor(p.x / radiusPx)},${Math.floor(p.y / radiusPx)}`
  const grid = new Map<string, number[]>()
  sorted.forEach((p, i) => {
    const key = cellKey(p)
    const bucket = grid.get(key)
    if (bucket) bucket.push(i)
    else grid.set(key, [i])
  })

  // Narrow phase: union every pair within `radiusPx`, checked once per
  // unordered pair (from the lower index's own 3x3 neighbourhood scan —
  // symmetric, since cell adjacency is a symmetric relation).
  for (let i = 0; i < n; i++) {
    const p = sorted[i] as ScreenPoint
    const cx = Math.floor(p.x / radiusPx)
    const cy = Math.floor(p.y / radiusPx)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`)
        if (!bucket) continue
        for (const j of bucket) {
          if (j <= i) continue
          const q = sorted[j] as ScreenPoint
          if (Math.hypot(p.x - q.x, p.y - q.y) <= radiusPx) union(i, j)
        }
      }
    }
  }

  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const bucket = groups.get(root)
    if (bucket) bucket.push(i)
    else groups.set(root, [i])
  }

  return [...groups.keys()].sort((a, b) => a - b).map((root) => {
    const idxs = groups.get(root) as number[]
    const members = idxs.map((i) => (sorted[i] as ScreenPoint).pk)
    const x = idxs.reduce((sum, i) => sum + (sorted[i] as ScreenPoint).x, 0) / idxs.length
    const y = idxs.reduce((sum, i) => sum + (sorted[i] as ScreenPoint).y, 0) / idxs.length
    return { x, y, members }
  })
}

// ---------------------------------------------------------------------------
// Off-screen edge indicators (Phase 4 Task 4, brief §7.5-7.6) — a person
// whose position is currently OUTSIDE the viewport still gets a small chip
// pinned to the edge of the screen, pointing in their direction, so "where
// is everyone" doesn't silently go blank the moment you pan or zoom away
// from them. Same pure/DOM-free split as `clusterScreenPoints` above:
// map.ts does the maplibre projection + DOM chip building, this module only
// ever sees plain numbers.
//
// Three different geometries are deliberately kept apart:
//  - `bearingDeg` is a REAL compass bearing (great-circle, 0=N clockwise)
//    between two lat/lon points — map.ts feeds it the viewport's own centre
//    (`map.getCenter()`) and an off-screen person's position, so the chip
//    points the right way regardless of how far off-screen they are (a
//    world away or just past the edge) without ever needing to project a
//    potentially-very-far-off-screen point through the live camera.
//  - `screenBearing` then converts that TRUE compass bearing into a
//    SCREEN-relative one: maplibre's two-finger rotate gesture is enabled
//    by default (map.ts's `MapView` constructor never disables it via
//    `dragRotate`/`touchZoomRotate`), so "up" on screen is only "true
//    north" when `map.getBearing()` happens to be 0. Subtracting the map's
//    own bearing re-expresses the compass direction as "clockwise from
//    whatever's currently at the top of the viewport" — the convention
//    `edgeAnchor` below actually needs.
//  - `edgeAnchor` is then PURE screen geometry: given a bearing already
//    expressed as "0 = up" IN SCREEN SPACE (i.e. `screenBearing`'s output,
//    never a raw `bearingDeg` unless the caller has separately confirmed
//    the map is unrotated) and the viewport's own pixel dimensions, where
//    does the ray from the viewport's centre exit the INSET rectangle?
//    That intersection point is the chip's anchor.
// ---------------------------------------------------------------------------

/** Great-circle compass bearing from `from` to `to`, in degrees, 0 = due
 *  north, clockwise (90 = east, 180 = south, 270 = west) — the standard
 *  spherical bearing formula, sharing no code with `destinationPoint`
 *  above (that one walks OUTWARD from a bearing; this one solves for the
 *  bearing between two already-known points) but normalizing into the same
 *  [0, 360) range. Pure geometry, no map/DOM dependency. */
export function bearingDeg(from: { lat: number; lon: number }, to: { lat: number; lon: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180
  const phi1 = toRad(from.lat)
  const phi2 = toRad(to.lat)
  const dLambda = toRad(to.lon - from.lon)
  const y = Math.sin(dLambda) * Math.cos(phi2)
  const x = Math.cos(phi1) * Math.sin(phi2) - Math.sin(phi1) * Math.cos(phi2) * Math.cos(dLambda)
  const theta = Math.atan2(y, x)
  return ((theta * 180) / Math.PI + 360) % 360
}

/** Re-expresses a TRUE compass bearing (`bearingDeg`'s output, 0=N
 *  clockwise) as a bearing relative to the viewport's own "up", given the
 *  map's current camera bearing (`map.getBearing()`, also 0=N clockwise —
 *  maplibre's own convention). Plain subtraction-then-normalize: when the
 *  map is unrotated (`mapBearingDeg` 0) this is the identity, which is why
 *  a rotation bug here can hide for a long time in manual testing (north-up
 *  is also the common case) — but the moment the camera itself is rotated
 *  N degrees clockwise, everything that was true-bearing B now SITS at
 *  screen angle B-N (the world has rotated N clockwise underneath a
 *  viewport whose own "up" hasn't moved), so `edgeAnchor` — which only ever
 *  understands "0 = up on screen" — needs that difference, not the raw
 *  compass bearing. `% 360` in JS can return a negative result for a
 *  negative dividend (e.g. a negative `mapBearingDeg`, or `trueBearing` <
 *  `mapBearingDeg`), hence the second `+ 360) % 360` pass, same
 *  double-modulo idiom `bearingDeg` above already relies on via `+ 360`
 *  before its own single pass (that one only ever needs one pass since
 *  `atan2`'s result is never more than 360 below zero; this one can be,
 *  since both inputs are already arbitrary [0,360) values whose difference
 *  ranges over (-360, 360)). Pure arithmetic, no map/DOM dependency — same
 *  "map.ts does the projection, this module only ever sees plain numbers"
 *  split as every other function in this section. */
export function screenBearing(trueBearing: number, mapBearingDeg: number): number {
  return (((trueBearing - mapBearingDeg) % 360) + 360) % 360
}

/** Default inset (CSS px) an edge chip sits IN from the true viewport edge
 *  — both `edgeAnchor`'s own default below and the off-screen test map.ts
 *  runs a candidate's projected point against (see that module's
 *  `updateEdgeChips`) share this same value, so a point exactly at the
 *  boundary is consistently treated as "still needs a chip" by both halves
 *  of the feature. */
const EDGE_INSET_DEFAULT_PX = 28

/** Where the ray from a `width` x `height` viewport's own centre, cast at
 *  `bearing` degrees (0 = up, clockwise — see the module-section doc
 *  comment above for why that's the right convention here), exits the
 *  rectangle inset by `inset` px on every side. Standard "ray vs.
 *  centred box" intersection: scale the unit direction vector by however
 *  far it can travel along EACH axis before crossing that axis's own inset
 *  bound, then take the smaller (whichever bound is hit first) — a bearing
 *  aimed exactly at a corner (e.g. 45 degrees on a square rect) hits both
 *  bounds at once and lands exactly on that corner, since both scale
 *  factors are then equal. Pure 2D geometry — `bearing` is just a number to
 *  this function, geographic or otherwise. */
export function edgeAnchor(bearing: number, width: number, height: number, inset = EDGE_INSET_DEFAULT_PX): { x: number; y: number } {
  const rad = (bearing * Math.PI) / 180
  const dx = Math.sin(rad)
  const dy = -Math.cos(rad) // screen y grows DOWNWARD; "up" (bearing 0) is -y
  const halfWidth = width / 2 - inset
  const halfHeight = height / 2 - inset
  const scaleX = dx === 0 ? Infinity : halfWidth / Math.abs(dx)
  const scaleY = dy === 0 ? Infinity : halfHeight / Math.abs(dy)
  const t = Math.min(scaleX, scaleY)
  return { x: width / 2 + dx * t, y: height / 2 + dy * t }
}

/** Greedy grouping of edge-chip anchors that have landed close together on
 *  the viewport's rim — same union-find-over-a-grid-hash idiom as
 *  `clusterScreenPoints` above (see that function's own doc comment for the
 *  algorithm/guarantees; `minGapPx` plays the exact role `radiusPx` does
 *  there, `chips` sorted by `pk` first for the same input-order-independent
 *  determinism). The one addition: each returned group's `nearestM` is the
 *  MINIMUM `distanceM` across its members — the group chip's own distance
 *  label shows however close the NEAREST absorbed person actually is,
 *  rather than an average that could understate how close someone is. A
 *  lone anchor comes back as its own 1-member group (map.ts renders that as
 *  a normal single chip, not a count badge — same "singleton passthrough"
 *  as `clusterScreenPoints`). */
export function groupEdgeAnchors(chips: Array<{ pk: string; x: number; y: number; distanceM: number }>, minGapPx = 48): Array<{ x: number; y: number; members: string[]; nearestM: number }> {
  const sorted = [...chips].sort((a, b) => a.pk.localeCompare(b.pk))
  const n = sorted.length
  const parent = sorted.map((_, i) => i)
  const find = (start: number): number => {
    let cur = start
    while ((parent[cur] as number) !== cur) cur = parent[cur] as number
    return cur
  }
  const union = (a: number, b: number): void => {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  const cellKey = (p: { x: number; y: number }): string => `${Math.floor(p.x / minGapPx)},${Math.floor(p.y / minGapPx)}`
  const grid = new Map<string, number[]>()
  sorted.forEach((p, i) => {
    const key = cellKey(p)
    const bucket = grid.get(key)
    if (bucket) bucket.push(i)
    else grid.set(key, [i])
  })

  for (let i = 0; i < n; i++) {
    const p = sorted[i] as { pk: string; x: number; y: number; distanceM: number }
    const cx = Math.floor(p.x / minGapPx)
    const cy = Math.floor(p.y / minGapPx)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const bucket = grid.get(`${cx + dx},${cy + dy}`)
        if (!bucket) continue
        for (const j of bucket) {
          if (j <= i) continue
          const q = sorted[j] as { pk: string; x: number; y: number; distanceM: number }
          if (Math.hypot(p.x - q.x, p.y - q.y) <= minGapPx) union(i, j)
        }
      }
    }
  }

  const groups = new Map<number, number[]>()
  for (let i = 0; i < n; i++) {
    const root = find(i)
    const bucket = groups.get(root)
    if (bucket) bucket.push(i)
    else groups.set(root, [i])
  }

  return [...groups.keys()].sort((a, b) => a - b).map((root) => {
    const idxs = groups.get(root) as number[]
    const members = idxs.map((i) => (sorted[i] as { pk: string }).pk)
    const x = idxs.reduce((sum, i) => sum + (sorted[i] as { x: number }).x, 0) / idxs.length
    const y = idxs.reduce((sum, i) => sum + (sorted[i] as { y: number }).y, 0) / idxs.length
    const nearestM = Math.min(...idxs.map((i) => (sorted[i] as { distanceM: number }).distanceM))
    return { x, y, members, nearestM }
  })
}

/** An edge chip's distance-from-self label — whole metres under 1km ('850
 *  m'), one-decimal km at/above it ('2.3 km'). Pure string formatting, no
 *  knowledge of WHERE the two points it was computed from came from (map.ts
 *  hands this a haversine result — see that module's own doc comment on why
 *  the distance itself is computed there, not here). */
export function formatDistance(distanceMetres: number): string {
  if (distanceMetres < 1000) return `${Math.round(distanceMetres)} m`
  return `${(distanceMetres / 1000).toFixed(1)} km`
}
