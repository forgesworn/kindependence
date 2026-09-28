import { describe, it, expect } from 'vitest'
import { buildExportTargets, decimalsForSpan, zoomForBbox } from './navexport.js'

// Fixture geohashes, all encoding roughly the same real-world point (central
// London) at different precisions — computed once via geohash-kit's own
// `encode`/`bounds`/`decode` so the expected numbers below are independently
// verifiable, not just "the implementation agrees with itself":
//   encode(51.5074, -0.1278, 9)  === 'gcpvj0duq'
//   encode(51.5074, -0.1278, 6)  === 'gcpvj0'
//   encode(51.5074, -0.1278, 4)  === 'gcpv'
//   encode(51.5074, -0.1278, 8)  === 'gcpvj0du'
const PRECISE_HASH = 'gcpvj0duq' // precision 9 — decode(): lat 51.50740385055542, lon -0.12778043746948242
const NEIGHBOURHOOD_HASH = 'gcpvj0' // precision 6 — bounds: minLat 51.50390625, maxLat 51.5093994140625, minLon -0.1318359375, maxLon -0.120849609375; centre lat 51.50665283203125, lon -0.1263427734375
const TOWN_HASH = 'gcpv' // precision 4 — bounds: minLat 51.50390625, maxLat 51.6796875, minLon -0.3515625, maxLon 0; centre lat ~51.591796875, lon ~-0.17578125
const STREET_HASH = 'gcpvj0du' // precision 8 — bounds span ~0.000172 x 0.000343 degrees

describe('buildExportTargets — precise (precision >= 9)', () => {
  const result = buildExportTargets({ geohash: PRECISE_HASH, precision: 9 })

  it('is not approximate and carries no note', () => {
    expect(result.approximate).toBe(false)
    expect(result.note).toBeUndefined()
  })

  it('decodes to lat/lon rounded to 6 decimal places, exactly, for every target', () => {
    const geo = result.targets.find((t) => t.id === 'geo')
    const gmaps = result.targets.find((t) => t.id === 'google-maps')
    const copy = result.targets.find((t) => t.id === 'copy')
    expect(geo?.url).toBe('geo:51.507404,-0.12778?q=51.507404,-0.12778')
    expect(gmaps?.url).toBe('https://www.google.com/maps/dir/?api=1&destination=51.507404,-0.12778')
    expect(copy?.text).toBe('51.507404,-0.12778')
    expect(copy?.url).toBeUndefined()
  })

  it('exposes exactly the three documented targets (no OpenStreetMap target — dead code dropped, Task 10 polish)', () => {
    expect(result.targets.map((t) => t.id)).toEqual(['geo', 'google-maps', 'copy'])
  })

  it('a higher precision than 9 still decodes directly (no additional clamping)', () => {
    const finer = buildExportTargets({ geohash: PRECISE_HASH, precision: 11 })
    expect(finer.approximate).toBe(false)
    expect(finer.targets.find((t) => t.id === 'copy')?.text).toBe('51.507404,-0.12778')
  })
})

describe('buildExportTargets — approximate (precision < 9)', () => {
  const result = buildExportTargets({ geohash: NEIGHBOURHOOD_HASH, precision: 6 })

  it('is approximate and carries the "destination is approximate" note', () => {
    expect(result.approximate).toBe(true)
    expect(result.note).toMatch(/approximate/i)
  })

  it('never offers a geo: URI (no target implies a device-app pin for an area)', () => {
    expect(result.targets.map((t) => t.id)).toEqual(['google-maps', 'copy'])
  })

  it('the Google Maps target is a plain viewport link (no destination/pin param), centred + rounded to the cell-derived decimal count, zoom clamped to the cell', () => {
    const gmaps = result.targets.find((t) => t.id === 'google-maps')
    expect(gmaps?.url).toBe('https://www.google.com/maps/@51.5,-0.1,14z')
    expect(gmaps?.url).not.toContain('destination')
  })

  it('the copy text names the friendly term, a rounded near-coordinate, and a ± half-diagonal radius — never a bare-looking precise coordinate', () => {
    const copy = result.targets.find((t) => t.id === 'copy')
    expect(copy?.text).toBe('approximate area: Neighbourhood near 51.5,-0.1 (±0.5km)')
    expect(copy?.text).toContain('approximate area')
    expect(copy?.text).toMatch(/±\d+(\.\d+)?km/)
  })

  it('no target embeds a centre coordinate finer than the cell-derived decimal count (1 decimal place here)', () => {
    for (const t of result.targets) {
      const text = `${t.url ?? ''} ${t.text}`
      // Only the synthesized-centre numbers (51.5 / -0.1) should appear, never
      // the full-precision centre (51.50665283203125 / -0.1263427734375) or
      // any intermediate decimal count.
      expect(text).not.toMatch(/51\.5066|51\.507|-0\.126|-0\.1263/)
    }
  })

  it('a coarser (Town-level) cell rounds its centre to 0 decimal places and clamps zoom lower', () => {
    const town = buildExportTargets({ geohash: TOWN_HASH, precision: 4 })
    expect(town.approximate).toBe(true)
    const gmaps = town.targets.find((t) => t.id === 'google-maps')
    expect(gmaps?.url).toBe('https://www.google.com/maps/@52,0,9z')
    const copy = town.targets.find((t) => t.id === 'copy')
    expect(copy?.text).toBe('approximate area: Town near 52,0 (±15.6km)')
  })

  it('a near-boundary (Street-level, precision 8) cell is still approximate, with more decimals and zoom clamped at the max', () => {
    const street = buildExportTargets({ geohash: STREET_HASH, precision: 8 })
    expect(street.approximate).toBe(true)
    const gmaps = street.targets.find((t) => t.id === 'google-maps')
    expect(gmaps?.url).toContain(',16z') // clamped to MAX_ZOOM even though the raw fit-to-bbox zoom would be higher
  })
})

describe('the approximate/precise boundary', () => {
  it('flips exactly at precision 9', () => {
    expect(buildExportTargets({ geohash: STREET_HASH, precision: 8 }).approximate).toBe(true)
    expect(buildExportTargets({ geohash: PRECISE_HASH, precision: 9 }).approximate).toBe(false)
  })
})

describe('decimalsForSpan', () => {
  it('derives fewer decimals for a larger (coarser) cell span', () => {
    expect(decimalsForSpan(0.3515625)).toBe(0) // Town-level span
    expect(decimalsForSpan(0.010986328125)).toBe(1) // Neighbourhood-level span
    expect(decimalsForSpan(0.00034332275390625)).toBe(3) // Street-level span
  })

  it('never exceeds 6 decimal places, even for a vanishingly small span', () => {
    expect(decimalsForSpan(0.0000001)).toBe(6)
    expect(decimalsForSpan(1e-12)).toBe(6)
  })

  it('falls back to the coarsest (0) decimals for degenerate input', () => {
    expect(decimalsForSpan(0)).toBe(0)
    expect(decimalsForSpan(-5)).toBe(0)
    expect(decimalsForSpan(NaN)).toBe(0)
  })
})

describe('zoomForBbox — clamp math', () => {
  it('clamps to the maximum for a vanishingly small bbox (never implies a tighter-than-area zoom)', () => {
    const zoom = zoomForBbox({ minLat: 51, maxLat: 51.0001, minLon: -0.1, maxLon: -0.0999 })
    expect(zoom).toBe(16)
  })

  it('clamps to the minimum for a world-spanning bbox', () => {
    const zoom = zoomForBbox({ minLat: -85, maxLat: 85, minLon: -180, maxLon: 180 })
    expect(zoom).toBe(3)
  })

  it('is dominated by whichever axis needs the LOWER zoom, so the whole bbox fits on screen', () => {
    // Wide longitude span (needs a low zoom to fit) but a tiny latitude span
    // (would tolerate a high zoom on its own) — the whole-bbox-fits
    // constraint means the wide axis wins.
    const zoom = zoomForBbox({ minLat: 51, maxLat: 51.0001, minLon: -90, maxLon: 90 })
    expect(zoom).toBe(3)
  })

  it('matches the Neighbourhood-cell fixture\'s own worked zoom (14)', () => {
    const zoom = zoomForBbox({ minLat: 51.50390625, maxLat: 51.5093994140625, minLon: -0.1318359375, maxLon: -0.120849609375 })
    expect(zoom).toBe(14)
  })
})
