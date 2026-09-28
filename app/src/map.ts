// Map view — maplibre-gl with OSM raster tiles. Loaded lazily: app.ts only
// ever `import()`s this module the first time the Map tab is opened, so
// maplibre-gl never lands in the main bundle otherwise — the same idiom as
// flock's `app/src/map.ts` (its own `await import('./map') // lazy — keeps
// maplibre out of the main bundle` comment). Modelled, not ported wholesale:
// flock's MapView also renders geofences, no-report zones, breadcrumb
// trails, meeting-point contributor pins, and an offline PMTiles basemap —
// none of which exist in kindependence yet, so this is a much thinner class:
// member pins (name + fix age, from app.ts) and a self pin.
//
// Tiles: same-origin-overridable raster source. flock proxies OSM
// same-origin by default for privacy (the tile host never sees the viewer's
// viewport); kindependence doesn't have that proxy set up yet, so this defaults
// straight to OSM's public tile server — self-hosters/deployers override via
// VITE_TILE_URL exactly as flock's own VITE_TILE_URL escape hatch works.

import * as maplibregl from 'maplibre-gl'
import 'maplibre-gl/dist/maplibre-gl.css'
import { decode as decodeGeohash } from 'geohash-kit'
import {
  geohashCellRing,
  circlePolygonRing,
  SELF_SHEET_TARGET,
  clusterScreenPoints,
  type ScreenPoint,
  bearingDeg,
  screenBearing,
  edgeAnchor,
  groupEdgeAnchors,
  formatDistance,
} from './mapinfo.js'
// Off-screen edge chips (Task 4, brief §7.5-7.6) need a self-to-person
// distance, same haversine helper beacons.ts/places.ts already import for
// their own geofence/stationary-radius maths — mapinfo.ts's OWN
// `distanceMetres` is a private, unexported helper (its module doc comment's
// "zero dependencies beyond geohash-kit" promise is deliberately narrower
// than this file's), so this follows the SAME beacons.ts precedent rather
// than widening that module's export surface for one caller.
import { haversineMetres } from '@forgesworn/flock/geofence'
// `geojson`'s own `.d.ts` is a real ES module (`export as namespace
// GeoJSON`) — importing its types explicitly here avoids depending on that
// global namespace ambient-merging into scope, which needs the package
// listed in tsconfig's `types` array (app/tsconfig.json's is scoped to just
// `vite/client`, deliberately not "every @types/* package in node_modules").
import type { FeatureCollection } from 'geojson'

// Same defensive `typeof … === 'string'` read as circles.ts's VITE_DEFAULT_RELAY
// (Vite's ImportMetaEnv types env vars `any`, so this narrows before use).
const ENV_TILE_URL = typeof import.meta.env.VITE_TILE_URL === 'string' ? import.meta.env.VITE_TILE_URL.trim() : ''
const TILE_URL = ENV_TILE_URL || 'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
const ENV_TILE_ATTRIBUTION = typeof import.meta.env.VITE_TILE_ATTRIBUTION === 'string' ? import.meta.env.VITE_TILE_ATTRIBUTION.trim() : ''
const TILE_ATTRIBUTION = ENV_TILE_ATTRIBUTION || '© OpenStreetMap contributors'

const STYLE: maplibregl.StyleSpecification = {
  version: 8,
  sources: {
    osm: { type: 'raster', tiles: [TILE_URL], tileSize: 256, attribution: TILE_ATTRIBUTION },
  },
  layers: [{ id: 'osm', type: 'raster', source: 'osm' }],
}

/** One circle member's pin — rendered only for a precise (brief §7.2,
 *  precision >= 9) position; a coarser one is a `MapArea` instead, never a
 *  pin (see that interface's doc comment). `label` is caller-formatted
 *  (app.ts combines name + fix age) so this module stays free of
 *  clock/store concerns. */
export interface MapPoint {
  pubkey: string
  lat: number
  lon: number
  label: string
}

/** One member's approximate-location cell (brief §7.2: precision < 9 renders
 *  as the geohash cell polygon, teal fill + outline, NO marker). `label` is
 *  caller-formatted the same way `MapPoint.label` is — app.ts already
 *  combines the person's name with the friendly precision term
 *  (mapinfo.ts's `precisionTerm`) before handing it here. */
export interface MapArea {
  pubkey: string
  geohash: string
  label: string
}

/** A guardian-defined safe place (Task 7, brief §13) — rendered as a
 *  labelled circle, styled distinctly from a `MapArea` (position
 *  uncertainty) even though both are filled polygons: a place is a fixed,
 *  guardian-chosen safe zone, not a rendering of anyone's CURRENT position. */
export interface MapPlace {
  id: string
  name: string
  centre: { lat: number; lon: number }
  radiusMetres: number
}

/** A temporary meeting point (Phase 4 Task 5, brief §6.6-6.7) — a flag
 *  marker + a small FIXED dashed ring (`MEET_RING_METRES`, not a
 *  per-point radius like `MapPlace.radiusMetres` — a meeting point is a
 *  precise spot, not a configurable safe zone), styled distinctly from
 *  both `MapArea` and `MapPlace`. Unlike a place, a meeting point IS
 *  tappable (`onMeetSelect` below) — it opens meet.ts's own tap sheet. */
export interface MapMeetPoint {
  id: string
  name: string
  centre: { lat: number; lon: number }
}

/** A flock-interoperable dropped pin (Phase 7 Task 4, design spec §4) — a
 *  plain glyph-chip marker, NO polygon (unlike `MapMeetPoint`'s fixed-radius
 *  ring): a pin is an exact spot a member marked, not an area of
 *  rendezvous. `glyph` is pins.ts's own provider-fixed vocabulary glyph
 *  (`PIN_KINDS[kind].glyph`) — caller-resolved, same "this module stays
 *  free of domain-table lookups" convention as `MapPoint.label`/
 *  `MapMeetPoint.name`. Tappable — opens pins.ts's own tap sheet
 *  (`onPinSelect` below). */
export interface MapDroppedPin {
  id: string
  glyph: string
  centre: { lat: number; lon: number }
}

/** One person eligible for an off-screen edge chip (Task 4, brief §7.5-7.6)
 *  — app.ts's `updateMapLayers` builds this from the SAME merged/filtered
 *  set `setMembers`/`setAreas` receive (a precise marker OR an approximate
 *  area's cell-centre representative, either way just a lat/lon to this
 *  class), pre-filtered to already exclude muted people and anyone whose
 *  availability state isn't live/recent (`mapinfo.availabilityState`'s
 *  '(approximate-)live'/'(approximate-)recent' tiers only — see
 *  `setEdgeCandidates`'s own doc comment). `initial` is the SAME
 *  avatar-initial `clusterSheetView`'s member rows already compute (first
 *  letter of the display name, app.ts's job — this class stays free of name
 *  logic). `pinned` drives the chip's ★ prefix (brief, verbatim). */
export interface EdgeCandidate {
  pubkey: string
  lat: number
  lon: number
  initial: string
  pinned: boolean
}

const AREA_SOURCE = 'kindependence-areas'
const AREA_FILL_LAYER = 'kindependence-areas-fill'
const AREA_LINE_LAYER = 'kindependence-areas-line'

const PLACE_SOURCE = 'kindependence-places'
const PLACE_FILL_LAYER = 'kindependence-places-fill'
const PLACE_LINE_LAYER = 'kindependence-places-line'

const MEET_SOURCE = 'kindependence-meet'
const MEET_FILL_LAYER = 'kindependence-meet-fill'
const MEET_LINE_LAYER = 'kindependence-meet-line'

/** The meeting-point ring's FIXED radius (task contract) — unlike a place's
 *  guardian-configurable `radiusMetres`, every meeting point draws the same
 *  small dashed circle regardless of how it was suggested/named. */
export const MEET_RING_METRES = 60

function emptyFeatureCollection(): FeatureCollection {
  return { type: 'FeatureCollection', features: [] }
}

// Off-screen edge chips (Task 4, brief §7.5-7.6) — an inset px value shared
// with `mapinfo.ts`'s `edgeAnchor` default (kept as its own local constant
// rather than importing that default, since the off-screen check in
// `updateEdgeChips` below needs the exact same number as a plain comparison
// operand, not a function default argument) and a min-gap px value shared
// with `groupEdgeAnchors`'s own default, for the same "the two halves of
// this feature must agree on the number" reason.
const EDGE_INSET_PX = 28
const EDGE_GROUP_MIN_GAP_PX = 48

/** Trailing-edge throttle: coalesces a burst of calls (maplibre's `move`
 *  fires on every animation frame of a drag/zoom gesture) into at most one
 *  `fn()` invocation per `ms`. Deliberately trailing-only (no leading-edge
 *  call) and deliberately NOT a snapshot-and-replay debounce — `fn` itself
 *  reads the LIVE camera state when it finally runs (`updateEdgeChips`
 *  below calls `map.project`/`map.getCenter` fresh each time), so the one
 *  call that fires after the window closes reflects wherever the camera
 *  actually is at that moment, not wherever it was when the burst started.
 *
 *  Returns the throttled trigger function itself with a `.cancel()`
 *  attached (rather than a separate `{ trigger, cancel }` object) so the
 *  constructor below can still hand `this.map.on('move', …)` a single
 *  function value directly, exactly as before this fix — only `destroy()`
 *  needs the extra handle, via the SAME reference the constructor already
 *  holds in its own local. Cancelling matters because `setTimeout` doesn't
 *  know the map it was scheduled against might be gone by the time it
 *  fires: without this, a move/drag right before `destroy()` can leave a
 *  trailing tick armed that then calls `updateEdgeChips` — which reads
 *  `this.map.getContainer()`/`.project()`/`.getCenter()` — against a map
 *  `destroy()` already called `.remove()` on. */
function throttleTrailing(fn: () => void, ms: number): { (): void; cancel: () => void } {
  let timer: ReturnType<typeof setTimeout> | null = null
  const trigger = () => {
    if (timer) return // a trailing call is already scheduled this window
    timer = setTimeout(() => {
      timer = null
      fn()
    }, ms)
  }
  trigger.cancel = () => {
    if (timer) clearTimeout(timer)
    timer = null
  }
  return trigger
}

/** Whether the user has manually panned/zoomed the map THIS SESSION (Phase
 *  4 Task 2, brief §6.5's adaptive default view) — module-level rather than
 *  an instance field, since maplibre's map instance is itself created once
 *  per app session (app.ts's `ensureLiveMapView` singleton) and this flag
 *  needs to persist for exactly that lifetime: once a user has taken
 *  control of the viewport, no ambient position update should silently
 *  re-centre it out from under them (only the Map tab's own explicit reset
 *  control — re-tapping the active tab — ever moves the camera again).
 *  Distinguishes user-initiated from programmatic moves via maplibre's
 *  `originalEvent` presence: it's only set on a real DOM interaction
 *  (drag, scroll, pinch, the +/- buttons), never on `flyTo`/`fitBounds`/
 *  `jumpTo`/`fitToSet`. Read via the `MapView.hasUserMoved()` INSTANCE
 *  method below (not exported standalone) — app.ts only ever holds a
 *  `MapView` instance, never a static import of this module (map.ts is
 *  loaded lazily, see the module doc comment at the top of this file), so
 *  a plain module-level export wouldn't be reachable from there anyway. */
let userMoved = false

/** One id'd marker element already on the map — tracked alongside its own
 *  maplibre `Marker` instance (rather than a bare `maplibregl.Marker[]`, the
 *  pre-Task-3 shape) so `recluster` below can project its CURRENT `lngLat`
 *  back to screen space and know which pubkey it belongs to when deciding
 *  whether to hide it behind a cluster badge. */
interface IdMarker { pubkey: string; marker: maplibregl.Marker }

export class MapView {
  readonly map: maplibregl.Map
  private markers: IdMarker[] = []
  private areaLabels: IdMarker[] = []
  private clusterMarkers: maplibregl.Marker[] = []
  private selfMarker: maplibregl.Marker | null = null
  private readonly onSelect: (pubkey: string) => void
  private readonly onClusterSelect: (memberPks: string[]) => void
  private readonly onMeetSelect: (id: string) => void
  private readonly onPinSelect: (id: string) => void
  private styleLoaded = false
  private pendingAreas: MapArea[] = []
  private placeLabels: maplibregl.Marker[] = []
  private pendingPlaces: MapPlace[] = []
  private meetLabels: maplibregl.Marker[] = []
  private pendingMeetPoints: MapMeetPoint[] = []
  private droppedPinMarkers: maplibregl.Marker[] = []
  // Off-screen edge chips (Task 4, brief §7.5-7.6): `edgeCandidates` is the
  // full eligible set (`setEdgeCandidates`, below); `selfPos` mirrors
  // `setSelf`'s own point ONLY for the distance-label haversine (the actual
  // self MARKER is `selfMarker` above — kept separate since that one's a
  // maplibre `Marker`, not a plain lat/lon, and re-deriving a point from
  // `selfMarker.getLngLat()` on every edge-chip recompute would just be
  // this same data read back out through an extra layer); `edgeChipsEl` is
  // the one absolutely-positioned overlay div every chip is a child of (see
  // the constructor for why it's a sibling of maplibre's own canvas rather
  // than a maplibre `Marker` — unlike every OTHER marker in this class, an
  // edge chip's position is the intersection of a bearing ray with the
  // viewport rect, not a `lngLat` maplibre itself can project).
  private edgeCandidates: EdgeCandidate[] = []
  private selfPos: { lat: number; lon: number } | null = null
  private readonly edgeChipsEl: HTMLDivElement
  // The `move`-throttled edge-chip recompute (constructor) — kept as its own
  // field ONLY so `destroy()` can call its `.cancel()` and stop a pending
  // trailing tick from firing `updateEdgeChips` against a map `destroy()`
  // just called `.remove()` on (see `throttleTrailing`'s own doc comment).
  private readonly throttledEdgeRecompute: { (): void; cancel: () => void }

  /** `onSelect` fires with a member's pubkey (or mapinfo.ts's
   *  `SELF_SHEET_TARGET` sentinel for the self marker) whenever a marker,
   *  an area's label chip, or an area's polygon fill is tapped — app.ts's
   *  person sheet (Task 3, brief §8) is the one thing that does anything
   *  with it; this class only reports the tap. `onClusterSelect` (Task 3,
   *  brief §7.4) fires with every member pk absorbed into a cluster badge
   *  when THAT'S tapped instead — a separate callback rather than
   *  overloading `onSelect` with a comma-joined string, since the two taps
   *  are genuinely different shapes (one person vs. several) and this
   *  codebase prefers a typed seam over a stringly-encoded one.
   *  `onMeetSelect` (Phase 4 Task 5) fires with a meeting point's own `id`
   *  when its flag marker is tapped — a third, separate callback for the
   *  same reason: a meeting point is neither a person nor a cluster of
   *  them. `onPinSelect` (Phase 7 Task 4) is the same idiom again for a
   *  flock-interoperable dropped pin's own `id`. */
  constructor(
    container: HTMLElement,
    centre: { lat: number; lon: number } | undefined,
    onSelect: (pubkey: string) => void,
    onClusterSelect: (memberPks: string[]) => void,
    onMeetSelect: (id: string) => void,
    onPinSelect: (id: string) => void,
  ) {
    this.onSelect = onSelect
    this.onClusterSelect = onClusterSelect
    this.onMeetSelect = onMeetSelect
    this.onPinSelect = onPinSelect
    this.map = new maplibregl.Map({
      container,
      style: STYLE,
      center: centre ? [centre.lon, centre.lat] : [-0.1278, 51.5074],
      zoom: 13,
      attributionControl: { compact: true },
    })
    this.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'top-right')
    // Task 2 (brief §6.5): flip `userMoved` on the first REAL user drag/zoom
    // — see its own doc comment for why `originalEvent` is the signal
    // (present only for a genuine DOM interaction, absent for any
    // programmatic camera move this class itself makes).
    this.map.on('dragend', (e) => { if (e.originalEvent) userMoved = true })
    // Task 3 (brief §7.4): re-cluster on every zoom end, user-driven or
    // programmatic alike (`flyTo`/`fitBounds`/`jumpTo` all fire `zoomend`
    // too) — a zoom changes the screen-space distance between every pair of
    // markers, so the clustering pass must re-run; a PURE pan doesn't (see
    // the module doc comment on `recluster` below), so `dragend` is
    // deliberately not wired to it.
    this.map.on('zoomend', (e) => {
      if (e.originalEvent) userMoved = true
      this.recluster()
    })
    // Task 4 (brief §7.5-7.6): the off-screen edge-chip overlay — a plain
    // absolutely-positioned div, NOT a maplibre `Marker` (unlike every other
    // visual this class draws), since a chip's position is the intersection
    // of a bearing ray with the viewport rectangle, not a `lngLat` maplibre
    // itself knows how to project — appended as a SIBLING of maplibre's own
    // internal canvas/control elements inside the same `container`, so it
    // paints on top (later DOM sibling) without needing to fight maplibre
    // for a child slot inside its own tree. `pointer-events: none` on the
    // layer itself (styles.css) keeps it click-through everywhere except
    // each individual chip, which opts back in (brief: "pointer-events per
    // chip") so it doesn't swallow map drag/pan gestures passing under it.
    this.edgeChipsEl = document.createElement('div')
    this.edgeChipsEl.className = 'map-edge-chips'
    container.appendChild(this.edgeChipsEl)
    // Recompute on EVERY camera change, not just `zoomend` like `recluster`
    // above — the key difference from clustering: a pure PAN changes which
    // people are off-screen (the viewport itself just moved), whereas it
    // never changes any pairwise on-screen DISTANCE between markers (the
    // one thing clustering cares about). maplibre's `move` fires on every
    // animation frame of a drag/zoom/programmatic camera change alike, so
    // it's throttled (trailing, ~100ms — `throttleTrailing` above) rather
    // than recomputing dozens of times per gesture; `moveend` is wired
    // separately, unthrottled, so the FINAL resting position is always
    // exactly reflected even if it lands mid-throttle-window.
    this.throttledEdgeRecompute = throttleTrailing(() => this.updateEdgeChips(), 100)
    this.map.on('move', this.throttledEdgeRecompute)
    this.map.on('moveend', () => this.updateEdgeChips())
    // Approximate-area fill/outline (brief §7.2) needs its own source +
    // layers, which maplibre only allows adding once the style has finished
    // loading. `setAreas` may be called before that finishes (a position
    // update racing the initial tile style load), so its data is buffered in
    // `pendingAreas` and applied here once the style is ready.
    this.map.on('load', () => {
      this.map.addSource(AREA_SOURCE, { type: 'geojson', data: emptyFeatureCollection() })
      this.map.addLayer({ id: AREA_FILL_LAYER, type: 'fill', source: AREA_SOURCE, paint: { 'fill-color': '#2fb8a0', 'fill-opacity': 0.2 } })
      this.map.addLayer({ id: AREA_LINE_LAYER, type: 'line', source: AREA_SOURCE, paint: { 'line-color': '#2fb8a0', 'line-width': 1 } })
      this.map.on('click', AREA_FILL_LAYER, (e) => {
        const pk = e.features?.[0]?.properties?.pubkey
        if (typeof pk === 'string') this.onSelect(pk)
      })
      this.map.on('mouseenter', AREA_FILL_LAYER, () => { this.map.getCanvas().style.cursor = 'pointer' })
      this.map.on('mouseleave', AREA_FILL_LAYER, () => { this.map.getCanvas().style.cursor = '' })
      // Safe-place fill/outline (Task 7, brief §13) — same buffered-until-
      // style-loaded pattern as the area layers above, styled distinctly
      // (amber, dashed) so a safe place is never visually confused with a
      // position's uncertainty area. Display-only (no click handler): unlike
      // an area/marker, a place isn't "a person" the person sheet has
      // anything to show for — management lives in the Circles tab's own
      // "Safe places" list (places.ts's `view`).
      this.map.addSource(PLACE_SOURCE, { type: 'geojson', data: emptyFeatureCollection() })
      this.map.addLayer({ id: PLACE_FILL_LAYER, type: 'fill', source: PLACE_SOURCE, paint: { 'fill-color': '#e0a83c', 'fill-opacity': 0.12 } })
      this.map.addLayer({ id: PLACE_LINE_LAYER, type: 'line', source: PLACE_SOURCE, paint: { 'line-color': '#e0a83c', 'line-width': 1.5, 'line-dasharray': [2, 1.5] } })
      // Meeting-point fill/outline (Phase 4 Task 5, brief §6.6-6.7) — same
      // buffered-until-style-loaded pattern, a distinct magenta/pink so a
      // meeting point never reads as a safe place (amber) or a position
      // area (teal). Unlike a place, this one IS clickable (see the marker
      // click handler in `applyMeetPoints` below) — a meeting point's tap
      // sheet lives in meet.ts, not this class.
      this.map.addSource(MEET_SOURCE, { type: 'geojson', data: emptyFeatureCollection() })
      this.map.addLayer({ id: MEET_FILL_LAYER, type: 'fill', source: MEET_SOURCE, paint: { 'fill-color': '#d6538c', 'fill-opacity': 0.12 } })
      this.map.addLayer({ id: MEET_LINE_LAYER, type: 'line', source: MEET_SOURCE, paint: { 'line-color': '#d6538c', 'line-width': 1.5, 'line-dasharray': [2, 1.5] } })
      this.map.on('click', MEET_FILL_LAYER, (e) => {
        const id = e.features?.[0]?.properties?.id
        if (typeof id === 'string') this.onMeetSelect(id)
      })
      this.map.on('mouseenter', MEET_FILL_LAYER, () => { this.map.getCanvas().style.cursor = 'pointer' })
      this.map.on('mouseleave', MEET_FILL_LAYER, () => { this.map.getCanvas().style.cursor = '' })
      this.styleLoaded = true
      this.applyAreas(this.pendingAreas)
      this.applyPlaces(this.pendingPlaces)
      this.applyMeetPoints(this.pendingMeetPoints)
    })
  }

  /** Re-fit the WebGL canvas after its container's size settles (e.g. right
   *  after first mount, before layout has necessarily finished). */
  resize(): void {
    this.map.resize()
  }

  /** Whether the user has manually panned/zoomed the map this session — see
   *  the module-level `userMoved`'s own doc comment. */
  hasUserMoved(): boolean {
    return userMoved
  }

  /** This device's own current map centre — the "Add place here" button's
   *  (app.ts, Task 7) source of truth for where a new safe place gets
   *  planted, per the module's own doc comment on that choice over
   *  long-press. */
  getCentre(): { lat: number; lon: number } {
    const c = this.map.getCenter()
    return { lat: c.lat, lon: c.lng }
  }

  flyTo(c: { lat: number; lon: number }, opts: { instant?: boolean } = {}): void {
    const camera = { center: [c.lon, c.lat] as [number, number], zoom: 15 }
    if (opts.instant) this.map.jumpTo(camera)
    else this.map.flyTo(camera)
  }

  /** Fit the view to a geohash cell's own bounding box rather than a fixed
   *  point-zoom (`flyTo`) — an approximate area's whole point is the
   *  ambiguity it represents (brief §7.2), so centring on it at
   *  marker-level zoom would quietly contradict that by implying a precise
   *  spot. Used by the Activity deep-link focus (app.ts's `applyMapFocus`)
   *  when the target's merged position is coarser than precise. */
  fitToCell(hash: string): void {
    const ring = geohashCellRing(hash)
    const lons = ring.map((p) => p[0])
    const lats = ring.map((p) => p[1])
    this.map.fitBounds(
      [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: 60, maxZoom: 15, duration: 800 },
    )
  }

  /** Fit the view to encompass every point in `points` (Task 2, brief §6.5
   *  — `points` is already `mapinfo.ts`'s own `fitSet` result: self +
   *  pinned + non-outlier unmuted others). Used both by the Map tab's
   *  explicit reset control (re-tapping the active tab) and its one-time
   *  initial fit (app.ts). No-op for an empty set — nothing to fit to,
   *  e.g. before any position has arrived yet. */
  fitToSet(points: Array<{ lat: number; lon: number }>): void {
    if (points.length === 0) return
    const lons = points.map((p) => p.lon)
    const lats = points.map((p) => p.lat)
    this.map.fitBounds(
      [[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]],
      { padding: 60, maxZoom: 15, duration: 800 },
    )
  }

  /** Replace every precise-position pin. Cheap to call on every position
   *  update — a handful of markers, not a tile refetch.
   *
   *  Clustering (§7.4) and off-screen edge chips (§7.5-7.6) are BOTH
   *  triggered off this same positions/state change — see `recluster` below
   *  (called at the end of this method) and `setEdgeCandidates` (called
   *  separately by app.ts's `updateMapLayers`, from the same merged/filtered
   *  set `points` here is built from — neither is deferred any longer). */
  setMembers(points: MapPoint[]): void {
    this.markers.forEach((m) => m.marker.remove())
    this.markers = points.map((p) => {
      const el = document.createElement('div')
      el.className = 'map-pin'
      // textContent, not innerHTML: the label carries a member-chosen name
      // (untrusted), same discipline as flock's own map markers.
      el.innerHTML = '<span class="tag"></span><span class="dot"></span>'
      ;(el.querySelector('.tag') as HTMLElement).textContent = p.label
      el.addEventListener('click', () => this.onSelect(p.pubkey))
      const marker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([p.lon, p.lat]).addTo(this.map)
      return { pubkey: p.pubkey, marker }
    })
    this.recluster()
  }

  /** Replace every approximate-area polygon + its name/term label chip. No
   *  pin — brief §7.2's hard rule ("approximate is an area, never a pin").
   *  Buffers into `pendingAreas` until the style's `load` event has added
   *  the polygon source/layers (see the constructor's doc comment). */
  setAreas(areas: MapArea[]): void {
    this.pendingAreas = areas
    if (this.styleLoaded) this.applyAreas(areas)
  }

  private applyAreas(areas: MapArea[]): void {
    const source = this.map.getSource(AREA_SOURCE) as maplibregl.GeoJSONSource | undefined
    source?.setData({
      type: 'FeatureCollection',
      features: areas.map((a) => ({
        type: 'Feature',
        properties: { pubkey: a.pubkey },
        geometry: { type: 'Polygon', coordinates: [geohashCellRing(a.geohash)] },
      })),
    })
    this.areaLabels.forEach((m) => m.marker.remove())
    this.areaLabels = areas.map((a) => {
      const { lat, lon } = decodeGeohash(a.geohash)
      const el = document.createElement('div')
      el.className = 'map-pin area'
      // textContent — see `setMembers`'s own doc comment on why (the label
      // carries a member-chosen name).
      el.innerHTML = '<span class="tag"></span>'
      ;(el.querySelector('.tag') as HTMLElement).textContent = a.label
      el.addEventListener('click', () => this.onSelect(a.pubkey))
      const marker = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lon, lat]).addTo(this.map)
      return { pubkey: a.pubkey, marker }
    })
    this.recluster()
  }

  /** Marker clustering (Task 3, brief §7.4) — projects every current
   *  member pin + approximate-area label's `lngLat` through the LIVE camera
   *  (`map.project`, CSS-pixel screen space) and hands the result to
   *  `mapinfo.ts`'s pure `clusterScreenPoints`. A precise marker and an
   *  approximate-area's cell-centre representative are both eligible
   *  cluster members — combined into one input array here — so if the two
   *  land within `clusterScreenPoints`' radius of each other the resulting
   *  cluster's member list is their union, exactly as the brief specifies.
   *
   *  Called at the end of `setMembers`/`applyAreas` (a positions/state
   *  change) AND on every `zoomend` (constructor) — deliberately NOT on
   *  `dragend`/every frame during a drag: screen-space projection is
   *  viewport-RELATIVE, so a pure pan shifts every marker's `x`/`y` by the
   *  same delta and never changes any pairwise distance between them —
   *  re-clustering mid-pan would recompute the exact same groupings at the
   *  cost of doing so on every frame, for no behavioural difference. A zoom
   *  change, unlike a pan, DOES change every pairwise on-screen distance
   *  (the same lng/lat separation covers more or fewer pixels), which is
   *  why that's the one camera change this re-runs on.
   *
   *  Every pass fully rebuilds `clusterMarkers` and re-applies visibility
   *  (`display: none` for any marker/label absorbed into a cluster this
   *  pass, `display: ''` otherwise) rather than diffing against the last
   *  pass — simplest-correct, and cheap at this app's scale (a circle's
   *  member count, not thousands of points). */
  private recluster(): void {
    this.clusterMarkers.forEach((m) => m.remove())
    this.clusterMarkers = []

    const idMarkers: IdMarker[] = [...this.markers, ...this.areaLabels]
    const screenPoints: ScreenPoint[] = idMarkers.map(({ pubkey, marker }) => {
      const { x, y } = this.map.project(marker.getLngLat())
      return { pk: pubkey, x, y }
    })
    const clusters = clusterScreenPoints(screenPoints)

    const clusteredPks = new Set<string>()
    for (const cluster of clusters) {
      if (cluster.members.length < 2) continue // singleton -> caller's normal marker/label renders it, see doc comment above
      cluster.members.forEach((pk) => clusteredPks.add(pk))
      const { lng, lat } = this.map.unproject([cluster.x, cluster.y])
      const el = document.createElement('div')
      el.className = 'map-pin cluster'
      el.textContent = String(cluster.members.length) // a plain count — no esc() needed, never untrusted text
      // Data attributes only (documentation/consistency with the app's
      // `[data-action]` convention) — the click below is wired directly,
      // same as every other marker in this class, since these elements
      // live in the persistent map container that app.ts's generic
      // `[data-action]` re-scan (app.ts's `render()`) never reaches (it
      // runs BEFORE `mountMap` re-parents that container into the fresh
      // DOM each render — see app.ts's own comments on that ordering).
      el.dataset.action = 'cluster-sheet'
      el.dataset.members = cluster.members.join(',')
      const members = cluster.members
      el.addEventListener('click', () => this.onClusterSelect(members))
      const badge = new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([lng, lat]).addTo(this.map)
      this.clusterMarkers.push(badge)
    }

    for (const { pubkey, marker } of idMarkers) {
      marker.getElement().style.display = clusteredPks.has(pubkey) ? 'none' : ''
    }
  }

  /** Replace every safe-place polygon + name label (Task 7, brief §13's
   *  deliverable 4: "places drawn as labelled circles, distinct style from
   *  position areas"). Same buffer-until-style-loaded pattern as
   *  `setAreas`. */
  setPlaces(places: MapPlace[]): void {
    this.pendingPlaces = places
    if (this.styleLoaded) this.applyPlaces(places)
  }

  private applyPlaces(places: MapPlace[]): void {
    const source = this.map.getSource(PLACE_SOURCE) as maplibregl.GeoJSONSource | undefined
    source?.setData({
      type: 'FeatureCollection',
      features: places.map((pl) => ({
        type: 'Feature',
        properties: { id: pl.id },
        geometry: { type: 'Polygon', coordinates: [circlePolygonRing(pl.centre, pl.radiusMetres)] },
      })),
    })
    this.placeLabels.forEach((m) => m.remove())
    this.placeLabels = places.map((pl) => {
      const el = document.createElement('div')
      el.className = 'map-pin place'
      // textContent — the label carries a guardian-chosen name (wire-
      // controlled, untrusted), same discipline as `setMembers`/`setAreas`.
      el.innerHTML = '<span class="tag"></span>'
      ;(el.querySelector('.tag') as HTMLElement).textContent = pl.name
      return new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([pl.centre.lon, pl.centre.lat]).addTo(this.map)
    })
  }

  /** Replace every meeting-point flag marker + its fixed-radius dashed ring
   *  (Phase 4 Task 5, brief §6.6-6.7's deliverable: "flag marker + dashed
   *  ring, `circlePolygonRing` reuse, fixed 60m"). Same
   *  buffer-until-style-loaded pattern as `setPlaces`. */
  setMeetPoints(points: MapMeetPoint[]): void {
    this.pendingMeetPoints = points
    if (this.styleLoaded) this.applyMeetPoints(points)
  }

  private applyMeetPoints(points: MapMeetPoint[]): void {
    const source = this.map.getSource(MEET_SOURCE) as maplibregl.GeoJSONSource | undefined
    source?.setData({
      type: 'FeatureCollection',
      features: points.map((pt) => ({
        type: 'Feature',
        properties: { id: pt.id },
        geometry: { type: 'Polygon', coordinates: [circlePolygonRing(pt.centre, MEET_RING_METRES)] },
      })),
    })
    this.meetLabels.forEach((m) => m.remove())
    this.meetLabels = points.map((pt) => {
      const el = document.createElement('div')
      el.className = 'map-pin meet'
      el.innerHTML = '<span class="tag"></span>'
      // textContent, with a literal (never wire-derived) flag glyph prefix
      // (task contract: "flag marker") — the label itself carries a
      // member-chosen name (wire-controlled, untrusted), same discipline as
      // `applyPlaces`/`setMembers`: the whole string is set via
      // `textContent`, so the name can never be interpreted as markup.
      ;(el.querySelector('.tag') as HTMLElement).textContent = `🚩 ${pt.name}`
      el.addEventListener('click', () => this.onMeetSelect(pt.id))
      return new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([pt.centre.lon, pt.centre.lat]).addTo(this.map)
    })
  }

  /** Replace every dropped-pin glyph chip (Phase 7 Task 4, design spec §4)
   *  — a plain marker, no polygon (unlike a meeting point's fixed-radius
   *  ring, `setMeetPoints`/`applyMeetPoints` above): a pin is an exact spot,
   *  not an area of rendezvous, so there's no GeoJSON source/layer to wait
   *  on — cheap enough to redraw fully on every call, same unbuffered idiom
   *  as `setMembers`. Tapping opens pins.ts's own tap sheet (`onPinSelect`),
   *  mirroring `onMeetSelect`. */
  setDroppedPins(pins: MapDroppedPin[]): void {
    this.droppedPinMarkers.forEach((m) => m.remove())
    this.droppedPinMarkers = pins.map((pt) => {
      const el = document.createElement('div')
      el.className = 'map-pin drop'
      el.innerHTML = '<span class="tag"></span>'
      // textContent — a literal, provider-fixed glyph (never wire-derived
      // free text), same discipline as every other marker in this class.
      ;(el.querySelector('.tag') as HTMLElement).textContent = pt.glyph
      el.addEventListener('click', () => this.onPinSelect(pt.id))
      return new maplibregl.Marker({ element: el, anchor: 'center' }).setLngLat([pt.centre.lon, pt.centre.lat]).addTo(this.map)
    })
  }

  /** Show (or clear) this device's own position, from the geo watch — never
   *  broadcast, purely a local "you are here" pin. Always exact (this
   *  device knows its own fix precisely; sharing precision only governs
   *  what's SENT to others), so — unlike a member's position — this is
   *  always a marker, never an area. */
  setSelf(point: { lat: number; lon: number } | null): void {
    this.selfMarker?.remove()
    this.selfMarker = null
    this.selfPos = point // edge chips' distance label (Task 4) — see field doc comment
    if (!point) {
      this.updateEdgeChips() // self just went away -> every chip's distance label must drop too
      return
    }
    const el = document.createElement('div')
    el.className = 'map-pin self'
    el.innerHTML = '<span class="tag">You</span><span class="dot"></span>'
    el.addEventListener('click', () => this.onSelect(SELF_SHEET_TARGET))
    this.selfMarker = new maplibregl.Marker({ element: el, anchor: 'bottom' }).setLngLat([point.lon, point.lat]).addTo(this.map)
    this.updateEdgeChips()
  }

  /** Replace the full off-screen-edge-chip candidate set (Task 4, brief
   *  §7.5-7.6) — app.ts's `updateMapLayers` calls this with the SAME
   *  merged/filtered people `setMembers`/`setAreas` just received, further
   *  narrowed to only live/recent (or their approximate variants)
   *  availability states (`mapinfo.availabilityState`): brief §7.5 is about
   *  where people ARE right now, so a stale/no-recent-update/hidden person
   *  gets no directional chip pointing at a position that may no longer be
   *  true. Muted people are ALREADY excluded before this is ever called —
   *  `updateMapLayers`'s existing `continue` for a muted pk, same as it
   *  already does for `points`/`areas` — so this method has no mute
   *  awareness of its own, matching `recluster`'s "pure geometry, caller
   *  filters" split. Triggers an immediate recompute (a data change, same
   *  as `setMembers`/`applyAreas` triggering `recluster`) rather than
   *  waiting for the next `move`/`moveend`. */
  setEdgeCandidates(candidates: EdgeCandidate[]): void {
    this.edgeCandidates = candidates
    this.updateEdgeChips()
  }

  /** Recomputes every off-screen edge chip against the map's CURRENT
   *  viewport — see the constructor's own doc comment on why this runs on
   *  `move`/`moveend` (a pan changes who's off-screen, unlike `recluster`'s
   *  zoomend-only trigger) in addition to every `setEdgeCandidates`/`setSelf`
   *  data change. For each candidate: project its lat/lon through the live
   *  camera (`map.project`, CSS-pixel screen space, same coordinate frame
   *  `recluster` already uses); it's off-screen when that point falls
   *  outside the viewport rect inset by `EDGE_INSET_PX` on every side (brief
   *  §7.5, verbatim: 28px) — a point technically still inside the raw
   *  canvas but within that inset margin still counts as needing a chip, the
   *  same margin `edgeAnchor` itself keeps every chip clear of the true
   *  edge. On-screen candidates are simply skipped (their own marker already
   *  shows them — no chip needed). Bearing is computed from the viewport's
   *  OWN centre (`map.getCenter()`), not self's position — see the
   *  module-section doc comment on `bearingDeg`/`edgeAnchor` in mapinfo.ts
   *  for why compass bearing (rather than re-using the possibly-far-off
   *  projected pixel offset) is the right primitive here — and then run
   *  through `screenBearing` against the map's OWN current camera bearing
   *  (`map.getBearing()`) before ever reaching `edgeAnchor`: maplibre's
   *  two-finger rotate gesture is on by default (this class never disables
   *  it), so `bearingDeg`'s true compass bearing and "clockwise from the
   *  top of the viewport" only coincide while the camera happens to be
   *  north-up. Recomputed on the SAME `move`/`moveend` wiring the
   *  constructor already sets up — confirmed against maplibre-gl 5.24.0's
   *  own `handler_manager.ts` (`isMoving = (p) => p.zoom || p.drag ||
   *  p.roll || p.pitch || p.rotate`) that a pure two-finger rotate gesture
   *  (no accompanying pan/zoom) IS one of the states that makes
   *  `isMoving()` true, so it fires `move` (throttled here) and `moveend`
   *  (unthrottled) exactly like drag/zoom do — no separate `rotate`/
   *  `rotateend` listener is needed alongside them. */
  private updateEdgeChips(): void {
    const container = this.map.getContainer()
    const width = container.clientWidth
    const height = container.clientHeight
    const centre = this.map.getCenter()
    const centreLatLon = { lat: centre.lat, lon: centre.lng }

    const offscreen: Array<{ candidate: EdgeCandidate; x: number; y: number; distanceM: number }> = []
    for (const candidate of this.edgeCandidates) {
      const { x, y } = this.map.project([candidate.lon, candidate.lat])
      const isOffscreen = x < EDGE_INSET_PX || x > width - EDGE_INSET_PX || y < EDGE_INSET_PX || y > height - EDGE_INSET_PX
      if (!isOffscreen) continue
      const trueBearing = bearingDeg(centreLatLon, { lat: candidate.lat, lon: candidate.lon })
      const bearing = screenBearing(trueBearing, this.map.getBearing())
      const anchor = edgeAnchor(bearing, width, height, EDGE_INSET_PX)
      // `groupEdgeAnchors` requires a `distanceM` per chip even when this
      // device has no self fix to measure FROM (brief: "no self position ->
      // no distance label") — rather than making the field optional
      // (pushing an extra null-check into that function's own `nearestM`
      // reduction), an unmeasurable distance uses `Infinity` as a sentinel:
      // it never wins a `Math.min` against a real distance, and
      // `renderEdgeChips` below only ever formats a group's `nearestM` when
      // it's finite, so the sentinel never actually reaches the UI.
      const distanceM = this.selfPos ? haversineMetres(this.selfPos, { lat: candidate.lat, lon: candidate.lon }) : Infinity
      offscreen.push({ candidate, x: anchor.x, y: anchor.y, distanceM })
    }

    const groups = groupEdgeAnchors(
      offscreen.map(({ candidate, x, y, distanceM }) => ({ pk: candidate.pubkey, x, y, distanceM })),
      EDGE_GROUP_MIN_GAP_PX,
    )
    const byPk = new Map(offscreen.map((o) => [o.candidate.pubkey, o.candidate]))
    this.renderEdgeChips(groups, byPk)
  }

  /** Rebuilds every chip DOM element from `updateEdgeChips`'s grouped
   *  output — same "fully rebuild rather than diff" simplest-correct choice
   *  `recluster` already makes, at the same small-N scale. A 1-member group
   *  renders a SINGLE chip: pinned ★ prefix (brief, verbatim) + initial +
   *  distance label (only when `nearestM` is finite — see
   *  `updateEdgeChips`'s own doc comment on the `Infinity` sentinel), tap ->
   *  `map.easeTo` centred on that person at the CURRENT zoom (brief,
   *  verbatim: "keep zoom" — `easeTo` without an explicit `zoom` leaves it
   *  unchanged). A 2+-member group renders a count chip, tap -> the SAME
   *  `onClusterSelect` callback Task 3's cluster badge uses (brief: "group
   *  chip -> T3's member sheet" — one member-sheet code path for both kinds
   *  of "several people, one tap" marker). Built with `createElement`/
   *  `textContent` throughout (never `innerHTML` with interpolated text) —
   *  same discipline as every other marker in this class, since a chip's
   *  initial/name-derived text is member-chosen, untrusted content. */
  private renderEdgeChips(groups: Array<{ x: number; y: number; members: string[]; nearestM: number }>, byPk: Map<string, EdgeCandidate>): void {
    this.edgeChipsEl.innerHTML = ''
    for (const group of groups) {
      const el = document.createElement('div')
      el.className = 'map-edge-chip'
      el.style.left = `${group.x}px`
      el.style.top = `${group.y}px`
      if (group.members.length > 1) {
        el.classList.add('group')
        el.textContent = String(group.members.length) // a plain count — no esc() needed, never untrusted text
        const members = group.members
        el.addEventListener('click', () => this.onClusterSelect(members))
        this.edgeChipsEl.appendChild(el)
        continue
      }
      const pk = group.members[0] as string // group has exactly 1 member on this branch
      const candidate = byPk.get(pk)
      if (!candidate) continue // shouldn't happen — every grouped pk came from `byPk` itself
      if (candidate.pinned) {
        const star = document.createElement('span')
        star.textContent = '★ '
        el.appendChild(star)
      }
      const initial = document.createElement('span')
      initial.textContent = candidate.initial
      el.appendChild(initial)
      if (Number.isFinite(group.nearestM)) {
        const distance = document.createElement('span')
        distance.className = 'map-edge-chip-distance'
        distance.textContent = ` · ${formatDistance(group.nearestM)}`
        el.appendChild(distance)
      }
      el.addEventListener('click', () => this.map.easeTo({ center: [candidate.lon, candidate.lat] }))
      this.edgeChipsEl.appendChild(el)
    }
  }

  destroy(): void {
    // Cancel any trailing edge-chip recompute FIRST, before `this.map.remove()`
    // below — a move/drag right before `destroy()` can leave a tick armed
    // that would otherwise fire `updateEdgeChips` (reading `this.map`'s
    // container/project/getCenter) against an already-removed map. No call
    // site exists for `destroy()` today, so this is defence-in-depth rather
    // than something exercised by a current test — see `throttleTrailing`'s
    // own doc comment for the full reasoning.
    this.throttledEdgeRecompute.cancel()
    this.markers.forEach((m) => m.marker.remove())
    this.markers = []
    this.areaLabels.forEach((m) => m.marker.remove())
    this.areaLabels = []
    this.clusterMarkers.forEach((m) => m.remove())
    this.clusterMarkers = []
    this.placeLabels.forEach((m) => m.remove())
    this.placeLabels = []
    this.meetLabels.forEach((m) => m.remove())
    this.meetLabels = []
    this.droppedPinMarkers.forEach((m) => m.remove())
    this.droppedPinMarkers = []
    this.selfMarker?.remove()
    this.selfMarker = null
    this.edgeChipsEl.innerHTML = ''
    this.edgeChipsEl.remove()
    this.edgeCandidates = []
    this.map.remove()
  }
}
