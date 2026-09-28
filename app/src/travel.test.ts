import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  HEURISTIC_SPEED_KMH,
  WINDING_FACTOR,
  heuristicTravelSec,
  travelSec,
  suggestMeetSpot,
  type MeetParticipant,
} from './travel.js'
import { haversineMetres } from '@forgesworn/flock/geofence'

const LONDON = { lat: 51.5074, lon: -0.1278 }
const NEARBY = { lat: 51.51, lon: -0.1278 } // ~284m north of LONDON

describe('heuristicTravelSec — known-value, no network', () => {
  it('matches distance/speed with the winding factor applied', () => {
    const metres = haversineMetres(LONDON, NEARBY)
    const metresPerSec = (HEURISTIC_SPEED_KMH.walk * 1000) / 3600
    const expected = Math.round((metres * WINDING_FACTOR) / metresPerSec)
    expect(heuristicTravelSec(LONDON, NEARBY, 'walk')).toBe(expected)
  })

  it('is zero for identical points', () => {
    expect(heuristicTravelSec(LONDON, LONDON, 'walk')).toBe(0)
  })

  it('is faster driving than walking over the same distance', () => {
    const walk = heuristicTravelSec(LONDON, NEARBY, 'walk')
    const drive = heuristicTravelSec(LONDON, NEARBY, 'drive')
    expect(drive).toBeLessThan(walk)
  })

  it('HEURISTIC_SPEED_KMH covers exactly the three travel modes', () => {
    expect(Object.keys(HEURISTIC_SPEED_KMH).sort()).toEqual(['cycle', 'drive', 'walk'])
  })
})

describe('travelSec — engine-or-heuristic, never throws', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses the heuristic when no routingUrl is configured', async () => {
    const result = await travelSec(LONDON, NEARBY, 'walk', undefined)
    expect(result).toEqual({ sec: heuristicTravelSec(LONDON, NEARBY, 'walk'), source: 'heuristic' })
  })

  it('falls back to the heuristic when the engine is unreachable (mocked fetch rejection)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const result = await travelSec(LONDON, NEARBY, 'walk', 'http://localhost:8002')
    expect(result).toEqual({ sec: heuristicTravelSec(LONDON, NEARBY, 'walk'), source: 'heuristic' })
  })

  it('falls back to the heuristic when the engine responds with an error status', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('boom', { status: 500 })))
    const result = await travelSec(LONDON, NEARBY, 'cycle', 'http://localhost:8002')
    expect(result).toEqual({ sec: heuristicTravelSec(LONDON, NEARBY, 'cycle'), source: 'heuristic' })
  })
})

describe('suggestMeetSpot — centroid fallback, never throws', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const participants: MeetParticipant[] = [
    { lat: 0, lon: 0, label: 'Alice' },
    { lat: 2, lon: 0, label: 'Bob' },
  ]

  it('returns the arithmetic-mean centroid when no routingUrl is configured', async () => {
    const result = await suggestMeetSpot(participants, undefined, undefined, false)
    expect(result).toEqual({ centre: { lat: 1, lon: 0 }, label: 'Middle of everyone', source: 'centroid' })
  })

  it('falls back to the centroid when the engine errors (mocked fetch rejection)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down') }))
    const result = await suggestMeetSpot(participants, 'http://localhost:8002', 'http://localhost:9002', true)
    expect(result.source).toBe('centroid')
    expect(result.centre).toEqual({ lat: 1, lon: 0 })
  })

  it('falls back to the centroid for fewer than 2 participants even with a routingUrl configured', async () => {
    const solo: MeetParticipant[] = [{ lat: 5, lon: 10, label: 'Solo' }]
    const result = await suggestMeetSpot(solo, 'http://localhost:8002', undefined, false)
    expect(result).toEqual({ centre: { lat: 5, lon: 10 }, label: 'Middle of everyone', source: 'centroid' })
  })

  it('degenerate empty-participant input never throws', async () => {
    const result = await suggestMeetSpot([], undefined, undefined, false)
    expect(result).toEqual({ centre: { lat: 0, lon: 0 }, label: 'Middle of everyone', source: 'centroid' })
  })
})

// Review-minor: the venue search now has its own `overpassUrl` setting,
// independent of `routingUrl` — the venue gate is `venuesOn && overpassUrl`
// (previously just `venuesOn`, reusing `routingUrl` as the Overpass target).
// These mock the engine layer directly (ValhallaEngine's isochrone call,
// rendezvous-kit/venues' searchVenues) so the real `rendezvous-kit/geo`
// intersection/centroid math still runs for real over the faked polygons —
// only the two network-touching calls are stubbed.
describe('suggestMeetSpot — venue gate (overpassUrl set AND venuesOn)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.doUnmock('rendezvous-kit/engines/valhalla')
    vi.doUnmock('rendezvous-kit/venues')
    vi.resetModules()
  })

  const participants: MeetParticipant[] = [
    { lat: 0, lon: 0, label: 'Alice' },
    { lat: 0.01, lon: 0, label: 'Bob' },
  ]

  // A big square around `origin` — generous enough that both participants'
  // isochrones always overlap, so the engine path always reaches the
  // venue-gate check regardless of participants' exact positions.
  function squareIsochrone(origin: { lat: number; lon: number }) {
    const d = 5
    return {
      origin: { lat: origin.lat, lon: origin.lon },
      mode: 'walk' as const,
      timeMinutes: 60,
      polygon: {
        type: 'Polygon' as const,
        coordinates: [[
          [origin.lon - d, origin.lat - d],
          [origin.lon + d, origin.lat - d],
          [origin.lon + d, origin.lat + d],
          [origin.lon - d, origin.lat + d],
          [origin.lon - d, origin.lat - d],
        ]],
      },
    }
  }

  async function loadMockedSuggestMeetSpot(searchVenuesMock: ReturnType<typeof vi.fn>) {
    vi.doMock('rendezvous-kit/engines/valhalla', () => ({
      ValhallaEngine: class {
        computeIsochrone(origin: { lat: number; lon: number }) {
          return Promise.resolve(squareIsochrone(origin))
        }
      },
    }))
    vi.doMock('rendezvous-kit/venues', () => ({ searchVenues: searchVenuesMock }))
    vi.resetModules()
    const mod = await import('./travel.js')
    return mod.suggestMeetSpot
  }

  it('calls searchVenues with overpassUrl (never routingUrl) when both overpassUrl and venuesOn are set', async () => {
    const searchVenues = vi.fn(async () => [])
    const suggest = await loadMockedSuggestMeetSpot(searchVenues)
    const result = await suggest(participants, 'http://routing.example', 'http://overpass.example', true)
    expect(searchVenues).toHaveBeenCalledTimes(1)
    expect(searchVenues.mock.calls[0]?.[2]).toBe('http://overpass.example')
    expect(result.source).toBe('rendezvous')
  })

  it('does NOT call searchVenues when venuesOn is true but overpassUrl is unset', async () => {
    const searchVenues = vi.fn(async () => [])
    const suggest = await loadMockedSuggestMeetSpot(searchVenues)
    const result = await suggest(participants, 'http://routing.example', undefined, true)
    expect(searchVenues).not.toHaveBeenCalled()
    // Still an engine-derived answer (the fair area is real) — just unnamed.
    expect(result.source).toBe('rendezvous')
  })

  it('does NOT call searchVenues when overpassUrl is set but venuesOn is false', async () => {
    const searchVenues = vi.fn(async () => [])
    const suggest = await loadMockedSuggestMeetSpot(searchVenues)
    await suggest(participants, 'http://routing.example', 'http://overpass.example', false)
    expect(searchVenues).not.toHaveBeenCalled()
  })
})
