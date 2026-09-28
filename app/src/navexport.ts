// Navigation/location export at permitted precision (brief §18). Pure
// link/copy-text builder — no DOM, no store, no clock — for the person
// sheet's "Navigate" and "Copy location" actions (app.ts wires the actual
// window.open/navigator.share/clipboard side effects; this module only
// decides WHAT to open/copy).
//
// The binding invariant (brief §18, global-constraints.md "Exports/nav
// never exceed permitted precision"): an export must never be more precise
// than what the map itself is already showing for this position. Two
// distinct disclosure rules follow from that:
//
//   - precision >= 9 (mapinfo.isPrecise — the map draws an exact marker):
//     the position is decoded to its own lat/lon and every target may use
//     it directly. This IS the permitted precision; nothing to clamp.
//
//   - precision < 9 (the map draws the geohash cell as a polygon, never a
//     pin — mapinfo.ts's own §7.2 rule): navigation must open the AREA, not
//     a synthesized "exact" point. Concretely: the cell's bounding-box edges
//     (`geohashBounds`) ARE the disclosed precision — they're the same
//     numbers already rendered on the map as the cell polygon
//     (mapinfo.geohashCellRing) — used at full float precision for the
//     zoom-clamp/±radius maths below, never for a synthesized finer point.
//     The cell's CENTRE, by contrast, is a synthetic point — nothing
//     actually disclosed it, decoding the geohash just picks the middle of
//     the cell — so anywhere a centre point is surfaced (the Google Maps
//     viewport link, the copy text) it's rounded down to a decimal-place
//     count derived from the cell's own size (`decimalsForSpan`), and the
//     copy text spells out "approximate area" + a friendly term + a ±
//     radius rather than a bare-looking coordinate pair. No target in the
//     approximate branch drops a pin/marker/destination at the centre —
//     Google Maps gets a plain viewport link (`/maps/@lat,lon,zoomz`, no
//     marker), never a directions/destination link, and the zoom is clamped
//     so the whole cell is visible rather than zoomed in tight enough to
//     look like a precise spot (brief §18: "the map may navigate to the
//     region boundary or displayed area rather than falsely presenting its
//     centre as the person's actual position").
//
// No OpenStreetMap target: an earlier revision offered one (a `bbox` link),
// but nothing in app.ts's `doNavigate`/`doCopyLocation` ever wired it into
// the UI (both only ever look for `geo`/`google-maps`/`copy`) — dead code
// carried since Task 4's review. Dropped rather than wired up, per Task 10's
// polish scope ("keep the diff minimal"); Google Maps + the plain-text copy
// target already cover both branches' "open somewhere" and "copy this"
// needs.

import { decode as decodeGeohash, bounds as geohashBounds, distanceFromCoords, type GeohashBounds } from 'geohash-kit'
import { isPrecise, precisionTerm } from './mapinfo.js'

export interface ExportPosition {
  geohash: string
  precision: number
}

export type ExportTargetId = 'geo' | 'google-maps' | 'copy'

export interface ExportTarget {
  id: ExportTargetId
  /** `geo:`/https URL for link-style targets (window.open/navigator.share's
   *  `url` field). Absent for the plain-text `copy` target, which has
   *  nothing to open. */
  url?: string
  /** Clipboard/`navigator.share` text — every target carries one (even the
   *  link-style ones) so a share sheet always has readable text to attach
   *  alongside the url, and so "copy" can never be reaching for a target
   *  that has nothing to copy. */
  text: string
}

export interface ExportTargets {
  /** True when `position.precision` is coarser than the map's own
   *  precise-marker threshold (mapinfo.isPrecise) — the UI shows the
   *  "destination is approximate" note whenever this is true (task
   *  contract; the copy-text wording itself also carries this, per §18). */
  approximate: boolean
  /** Present only when `approximate` — neutral, non-accusatory copy for the
   *  inline note the person sheet shows alongside the Navigate/Copy
   *  buttons. */
  note?: string
  targets: ExportTarget[]
}

const APPROXIMATE_NOTE = 'Destination is approximate — this opens an area, not a precise position.'

export function buildExportTargets(position: ExportPosition): ExportTargets {
  const { geohash, precision } = position
  if (isPrecise(precision)) return buildPreciseTargets(geohash)
  return buildApproximateTargets(geohash, precision)
}

function buildPreciseTargets(geohash: string): ExportTargets {
  const { lat, lon } = decodeGeohash(geohash)
  // Six decimal places (~11cm resolution) is a conventional "full
  // coordinate" display precision — not a further clamp (precision >= 9
  // IS the permitted precision here), just formatting: `decode()`'s raw
  // float carries more noise digits than any real geohash cell resolves.
  const rLat = round(lat, 6)
  const rLon = round(lon, 6)
  const coords = `${rLat},${rLon}`
  return {
    approximate: false,
    targets: [
      { id: 'geo', url: `geo:${coords}?q=${coords}`, text: coords },
      { id: 'google-maps', url: `https://www.google.com/maps/dir/?api=1&destination=${coords}`, text: coords },
      { id: 'copy', text: coords },
    ],
  }
}

function buildApproximateTargets(geohash: string, precision: number): ExportTargets {
  const b = geohashBounds(geohash)
  const centre = decodeGeohash(geohash) // cell centre — synthetic, see module doc comment
  const latSpan = b.maxLat - b.minLat
  const lonSpan = b.maxLon - b.minLon
  // The LARGER of the two spans is used deliberately: fewer decimals is the
  // conservative (safer) direction (a coarser rounding grid than the cell
  // can only under-state precision, never over-state it), so anchoring on
  // whichever axis is bigger never lets the other, finer axis push the
  // decimal count up past what's safe for both.
  const decimals = decimalsForSpan(Math.max(latSpan, lonSpan))
  const rLat = round(centre.lat, decimals)
  const rLon = round(centre.lon, decimals)
  const halfDiagKm = distanceFromCoords(b.minLat, b.minLon, b.maxLat, b.maxLon) / 2 / 1000
  const term = precisionTerm(precision)
  const zoom = zoomForBbox(b)
  const copyText = `approximate area: ${term} near ${rLat},${rLon} (±${halfDiagKm.toFixed(1)}km)`
  return {
    approximate: true,
    note: APPROXIMATE_NOTE,
    targets: [
      // A plain viewport link (no `destination`/pin parameter) — Google
      // Maps just pans/zooms there, it never drops a marker, so it can't
      // read as "this exact dot is the person."
      { id: 'google-maps', url: `https://www.google.com/maps/@${rLat},${rLon},${zoom}z`, text: copyText },
      { id: 'copy', text: copyText },
    ],
  }
}

/** Decimal-place count for displaying a synthesized centre point derived
 *  from a cell of size `spanDeg` (degrees) — never finer than the cell
 *  itself resolves, and never finer than the precise branch's own 6-decimal
 *  display (the cap here ties the two branches together: even an
 *  arbitrarily tiny approximate cell can't out-resolve "Precise" itself).
 *  Exported for direct unit testing (task contract: "round to a sane
 *  decimal count derived from cell dimensions"). */
export function decimalsForSpan(spanDeg: number): number {
  if (!Number.isFinite(spanDeg) || spanDeg <= 0) return 0 // degenerate input — coarsest, safest fallback
  return Math.max(0, Math.min(6, Math.floor(-Math.log10(spanDeg))))
}

const MIN_ZOOM = 3
const MAX_ZOOM = 16 // stops short of street-level zoom (~18-20) — an approximate area link should never look pin-tight

/** Web-Mercator-style zoom level that fits `b`'s whole span on screen —
 *  the "zoom clamped to the cell size" the task contract asks for. Takes
 *  the min across both axes (so the WHOLE bbox fits, not just one
 *  dimension) and clamps to [`MIN_ZOOM`, `MAX_ZOOM`]. Exported for direct
 *  unit testing (task contract: "zoom clamp math"). */
export function zoomForBbox(b: GeohashBounds): number {
  const lonZoom = zoomForSpan(b.maxLon - b.minLon, 360)
  const latZoom = zoomForSpan(b.maxLat - b.minLat, 170) // ~-85..85 — avoids Mercator's polar blowup, plenty for any real fix
  return Math.min(lonZoom, latZoom)
}

function zoomForSpan(spanDeg: number, worldSpanDeg: number): number {
  if (!Number.isFinite(spanDeg) || spanDeg <= 0) return MAX_ZOOM
  const z = Math.floor(Math.log2(worldSpanDeg / spanDeg))
  return Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, z))
}

function round(n: number, decimals: number): number {
  const factor = 10 ** decimals
  return Math.round(n * factor) / factor
}
