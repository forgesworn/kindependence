// Travel-time estimation — engine-or-heuristic, consumed by meet.ts's
// meeting-point sheet today and (task contract) by pickup ETA/leave
// reminders later, so this module's contract is load-bearing: every export
// here is deliberately small and stable. `travelSec`/`suggestMeetSpot`
// NEVER throw — a malformed input, an unreachable engine, or any network
// failure at all falls back to the plain heuristic/centroid branch, never an
// exception the caller would have to guard against.
//
// PRIVACY (binding, brief/task contract): the ONLY network calls this module
// ever makes are to two independently opted-into, self-hosted-only hosts —
// `routingUrl` (`settings.routingUrl`, unset by default) for Valhalla/OSRM
// routing + isochrones, and `overpassUrl` (`settings.overpassUrl`, its own
// separate field, ALSO unset by default — review-minor: previously this
// module reused `routingUrl` for the venue search too, which assumed a
// self-hoster fronts both routing and an Overpass-compatible endpoint behind
// the SAME url; that assumption doesn't hold in general, so the two are now
// independent settings) for the Overpass venue search. No public third-party
// endpoint is ever contacted, and rendezvous-kit's own engine classes need no
// API key for that reason (Valhalla/OSRM are self-hosted-only adapters — see
// their own doc comments).
//
// Deliberate deviation from a literal `findRendezvous(engine, options)` call
// (rendezvous-kit's own top-level pipeline function) for `suggestMeetSpot`:
// `findRendezvous` ALWAYS calls the package's `searchVenues` internally
// *without* forwarding an `overpassUrl` override — which means it falls back
// to `searchVenues`'s own hard-coded PUBLIC Overpass endpoints
// (overpass-api.de / overpass.kumi.systems) on every call, `venueTypes`
// non-empty or not, `settings.meetVenues` on or off. Calling it directly
// would silently violate the "no network calls except a configured self-host"
// constraint the moment an engine is configured at all. So `suggestMeetSpot`
// hand-rolls the same isochrone-intersect-centroid shape `findRendezvous`
// itself uses (`rendezvous-kit/geo`'s pure `intersectPolygonsAll`/`centroid`/
// `polygonArea`, exported separately from the engine/venue code specifically
// so this is possible) and calls `searchVenues` itself ONLY when
// `venuesOn && overpassUrl` (the venue gate — both must hold), ALWAYS passing
// `overpassUrl`, never `routingUrl`, as the `overpassUrl` argument — so a
// venue search, when it happens at all, only ever reaches the host the user
// explicitly configured FOR venue search, independent of whatever routing
// engine (if any) `routingUrl` points at (the search simply finds nothing,
// same as today, if that host isn't actually Overpass-compatible; this
// module's own centroid fallback below takes over — never a crash, never a
// stray request elsewhere).
//
// Bundle-size discipline (task contract: "keep the main bundle lean; vite
// code-splits dynamic imports"): `ValhallaEngine`/`OsrmEngine` are dynamic
// `import()`s, reached ONLY from the engine path below. The pure geometry
// helpers (`intersectPolygonsAll`, `centroid`, `polygonArea`) are imported
// from rendezvous-kit's own dedicated `/geo` subpath, which never touches
// the engine files. `SPEED_KMH` has no subpath of its own (only the root
// barrel re-exports it) — the package declares `"sideEffects": false`, so a
// production bundler can still tree-shake the unused engine classes out of
// this chunk since nothing here ever references them outside a dynamic
// import(); the engines are the only genuinely heavy/fetch-bearing pieces of
// this package, and those stay dynamic regardless.

import { haversineMetres, type LatLng } from '@forgesworn/flock/geofence'
import { SPEED_KMH } from 'rendezvous-kit'
import { intersectPolygonsAll, centroid, polygonArea } from 'rendezvous-kit/geo'
import type { LatLon, VenueType, GeoJSONPolygon } from 'rendezvous-kit'

export type TravelMode = 'walk' | 'cycle' | 'drive'

/** Subset of rendezvous-kit's own `SPEED_KMH` (which also carries
 *  `public_transit`, a mode this app doesn't offer) — see the module doc
 *  comment on why this is imported from the barrel (its only export path)
 *  and why that's still bundle-safe. */
export const HEURISTIC_SPEED_KMH: Record<TravelMode, number> = {
  walk: SPEED_KMH.walk,
  cycle: SPEED_KMH.cycle,
  drive: SPEED_KMH.drive,
}

/** A straight-line haversine distance understates any real route — actual
 *  streets/paths wind. 1.3 is a conventional rule-of-thumb multiplier
 *  (task contract) that keeps the heuristic branch's estimate in the right
 *  ballpark without needing a real router. */
export const WINDING_FACTOR = 1.3

/** On-device, no-network travel-time estimate: haversine distance, widened
 *  by `WINDING_FACTOR`, at `mode`'s flat `HEURISTIC_SPEED_KMH`. Pure —
 *  always available, always instant, the fallback every other export in
 *  this module reduces to on any failure. Whole seconds (`Math.round`) —
 *  fractional seconds aren't meaningful at this precision. */
export function heuristicTravelSec(from: LatLng, to: LatLng, mode: TravelMode): number {
  const metres = haversineMetres(from, to) * WINDING_FACTOR
  const metresPerSec = (HEURISTIC_SPEED_KMH[mode] * 1000) / 3600
  return Math.round(metres / metresPerSec)
}

/** How long any single engine attempt (or an engine call chain — see
 *  `travelSec`'s valhalla-then-osrm fallback) is allowed to run before this
 *  module gives up on it and falls back to the heuristic/centroid branch —
 *  task contract: 5s. Passed to each engine instance's own `timeoutMs`
 *  (which rendezvous-kit's Valhalla/OSRM adapters honour via
 *  `AbortSignal.timeout` internally — a real `AbortController` under the
 *  hood, per the WHATWG spec) AND used as the outer `raceTimeout` bound
 *  below, so the TOTAL wall-clock time this module ever waits on the
 *  network is capped at this figure, not just each individual HTTP call. */
const ENGINE_TIMEOUT_MS = 5_000

/** Races `promise` against a plain timer, rejecting if `ms` elapses first —
 *  the outer bound described in `ENGINE_TIMEOUT_MS`'s own doc comment.
 *  Doesn't cancel `promise` itself (rendezvous-kit's engines already bound
 *  their own underlying `fetch` via `AbortSignal.timeout`, so the in-flight
 *  request unwinds on its own); this just stops THIS module's caller from
 *  waiting on it past the deadline. */
function raceTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
  })
}

async function engineTravelSec(from: LatLng, to: LatLng, mode: TravelMode, routingUrl: string): Promise<number> {
  const origin: LatLon = { lat: from.lat, lon: from.lon }
  const dest: LatLon = { lat: to.lat, lon: to.lon }
  try {
    const { ValhallaEngine } = await import('rendezvous-kit/engines/valhalla')
    const engine = new ValhallaEngine({ baseUrl: routingUrl, timeoutMs: ENGINE_TIMEOUT_MS })
    const route = await engine.computeRoute(origin, dest, mode)
    return Math.round(route.durationMinutes * 60)
  } catch {
    // Valhalla unreachable/erroring — OSRM (matrix-only, task contract's
    // named second engine) is the one fallback attempted before this
    // function's own caller (`travelSec`) gives up on the engine entirely
    // and reaches for the heuristic.
    const { OsrmEngine } = await import('rendezvous-kit/engines/osrm')
    const engine = new OsrmEngine({ baseUrl: routingUrl, timeoutMs: ENGINE_TIMEOUT_MS })
    const matrix = await engine.computeRouteMatrix([origin], [dest], mode)
    const entry = matrix.entries.find((e) => e.originIndex === 0 && e.destinationIndex === 0)
    if (!entry) throw new Error('travel: OSRM matrix returned no entry')
    return Math.round(entry.durationMinutes * 60)
  }
}

/** Travel time from `from` to `to` at `mode` — tries the user's own
 *  self-hosted engine (`routingUrl`) when configured, valhalla first then
 *  osrm (see `engineTravelSec`), and ALWAYS falls back to the on-device
 *  `heuristicTravelSec` on any failure (no `routingUrl`, an unreachable
 *  host, a malformed response, a timeout — anything at all). Never throws —
 *  this is the one hard contract every caller (this task's meeting-point
 *  sheet, and later pickup ETA / leave reminders) relies on. */
export async function travelSec(
  from: LatLng,
  to: LatLng,
  mode: TravelMode,
  routingUrl: string | undefined,
): Promise<{ sec: number; source: 'engine' | 'heuristic' }> {
  if (routingUrl) {
    try {
      const sec = await raceTimeout(engineTravelSec(from, to, mode, routingUrl), ENGINE_TIMEOUT_MS, 'travelSec')
      return { sec, source: 'engine' }
    } catch {
      // Fall through — heuristic below.
    }
  }
  return { sec: heuristicTravelSec(from, to, mode), source: 'heuristic' }
}

// ---------------------------------------------------------------------------
// Fair-spot suggestion (§6.7) — engine-or-centroid, same never-throws
// discipline as `travelSec` above. See the module doc comment for why this
// hand-rolls the isochrone-intersect step instead of calling rendezvous-kit's
// own `findRendezvous`.
// ---------------------------------------------------------------------------

export interface MeetParticipant {
  lat: number
  lon: number
  label: string
}

export interface MeetSuggestion {
  centre: { lat: number; lon: number }
  label: string
  source: 'rendezvous' | 'centroid'
  venues?: Array<{ name: string; lat: number; lon: number }>
}

/** How far (minutes, walking) each participant's isochrone reaches before
 *  intersecting — generous enough that most same-town participants overlap,
 *  task contract: mode fixed to `'walk'` for this suggestion regardless of
 *  how anyone actually plans to get there (this picks a fair AREA, not a
 *  travel plan). */
const SUGGEST_ISOCHRONE_MIN = 60

/** A short, family-friendly default venue-type list for the Overpass
 *  search — deliberately small (task contract doesn't specify one), biased
 *  toward places worth waiting at rather than e.g. `service_station`. */
const DEFAULT_VENUE_TYPES: VenueType[] = ['cafe', 'park', 'library', 'community_centre']

const CENTROID_LABEL = 'Middle of everyone'
const RENDEZVOUS_LABEL = 'A fair spot for everyone'

function arithmeticCentroid(participants: readonly MeetParticipant[]): { lat: number; lon: number } {
  if (!participants.length) return { lat: 0, lon: 0 }
  const lat = participants.reduce((sum, p) => sum + p.lat, 0) / participants.length
  const lon = participants.reduce((sum, p) => sum + p.lon, 0) / participants.length
  return { lat, lon }
}

function centroidFallback(participants: readonly MeetParticipant[]): MeetSuggestion {
  return { centre: arithmeticCentroid(participants), label: CENTROID_LABEL, source: 'centroid' }
}

/** The engine attempt: intersect every participant's walking isochrone, then
 *  (only when the venue gate is open — `venuesOn && overpassUrl`, review-
 *  minor: previously just `venuesOn`) search for a real venue inside the
 *  overlap — ALWAYS passing `overpassUrl` (never `routingUrl`) as
 *  `searchVenues`'s own `overpassUrl` argument (see the module doc comment
 *  on why the two are independent settings now). `null` (not a throw) when
 *  the engine has nothing usable to offer — e.g. no isochrone overlap at all
 *  within `SUGGEST_ISOCHRONE_MIN` — so the caller's centroid fallback takes
 *  over exactly as it would for a genuine error. */
async function engineSuggestMeetSpot(
  participants: readonly MeetParticipant[],
  routingUrl: string,
  overpassUrl: string | undefined,
  venuesOn: boolean,
): Promise<MeetSuggestion | null> {
  const { ValhallaEngine } = await import('rendezvous-kit/engines/valhalla')
  const engine = new ValhallaEngine({ baseUrl: routingUrl, timeoutMs: ENGINE_TIMEOUT_MS })
  const points: LatLon[] = participants.map((p) => ({ lat: p.lat, lon: p.lon, label: p.label }))
  const isochrones = await Promise.all(points.map((p) => engine.computeIsochrone(p, 'walk', SUGGEST_ISOCHRONE_MIN)))
  const components = intersectPolygonsAll(isochrones.map((iso) => iso.polygon))
  if (!components.length) return null // no common reachable area — let the caller fall back to the centroid

  const zone: GeoJSONPolygon = components.reduce((biggest, c) => (polygonArea(c) > polygonArea(biggest) ? c : biggest))

  if (venuesOn && overpassUrl) {
    const { searchVenues } = await import('rendezvous-kit/venues')
    const venues = await searchVenues(zone, DEFAULT_VENUE_TYPES, overpassUrl)
    if (venues.length) {
      const top = venues.slice(0, 5)
      const best = top[0] as (typeof top)[number]
      return {
        centre: { lat: best.lat, lon: best.lon },
        label: best.name,
        source: 'rendezvous',
        venues: top.map((v) => ({ name: v.name, lat: v.lat, lon: v.lon })),
      }
    }
    // Found the zone but no venue inside it — still an engine-derived
    // answer (the fair AREA is real), just no specific venue to name.
  }

  const c = centroid(zone)
  return { centre: c, label: RENDEZVOUS_LABEL, source: 'rendezvous' }
}

/** A fair meeting spot for `participants` — the engine path (isochrone
 *  intersection, optionally narrowed to a real venue) when `routingUrl` is
 *  configured and at least 2 participants are given, else the plain
 *  arithmetic-mean centroid. `overpassUrl` is a SEPARATE opt-in
 *  (`settings.overpassUrl`) gating the venue-search step alone — routing
 *  works with just `routingUrl` configured; a venue name only ever appears
 *  when `overpassUrl` is ALSO set and `venuesOn` is true (see
 *  `engineSuggestMeetSpot`'s own doc comment for the venue gate). NEVER
 *  throws: any engine failure (unreachable host, timeout, malformed
 *  response, no isochrone overlap at all) falls back to the centroid
 *  exactly as if no `routingUrl` had been configured. */
export async function suggestMeetSpot(
  participants: readonly MeetParticipant[],
  routingUrl: string | undefined,
  overpassUrl: string | undefined,
  venuesOn: boolean,
): Promise<MeetSuggestion> {
  if (routingUrl && participants.length >= 2) {
    try {
      const suggestion = await raceTimeout(
        engineSuggestMeetSpot(participants, routingUrl, overpassUrl, venuesOn),
        ENGINE_TIMEOUT_MS,
        'suggestMeetSpot',
      )
      if (suggestion) return suggestion
    } catch {
      // Fall through — centroid below.
    }
  }
  return centroidFallback(participants)
}
