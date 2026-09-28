// Ported from flock's `app/src/services.test.ts` — only the `currentPosition`
// block (the geolocation half; `deliveredCount`/`RELAY_TIMEOUT` are transport
// concerns already covered by roost-kit's own transport.test.ts).
import { describe, it, expect, vi, afterEach } from 'vitest'
import { currentPosition, geoErrorKind, toFix, pollLocation, POLL_ERROR_RETRY_MS, type Fix } from './geo.js'

describe('currentPosition', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('resolves a Fix from the browser geolocation (seconds, not millis)', async () => {
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (success: PositionCallback) =>
          success({ coords: { latitude: 51.5, longitude: -0.12, accuracy: 12 }, timestamp: 1_700_000_000_000 } as GeolocationPosition),
      },
    })
    expect(await currentPosition()).toEqual({ lat: 51.5, lon: -0.12, accuracy: 12, at: 1_700_000_000 })
  })

  it('resolves null (never rejects) when permission is denied', async () => {
    vi.stubGlobal('navigator', {
      geolocation: { getCurrentPosition: (_: PositionCallback, error: PositionErrorCallback) => error({ code: 1, message: 'denied' } as GeolocationPositionError) },
    })
    expect(await currentPosition()).toBeNull()
  })

  it('resolves null when geolocation is unavailable', async () => {
    vi.stubGlobal('navigator', {})
    expect(await currentPosition()).toBeNull()
  })
})

describe('geoErrorKind', () => {
  it('maps code 1 to denied', () => {
    expect(geoErrorKind({ code: 1 } as GeolocationPositionError)).toBe('denied')
  })
  it('maps code 2 to unavailable', () => {
    expect(geoErrorKind({ code: 2 } as GeolocationPositionError)).toBe('unavailable')
  })
  it('maps any other code to timeout', () => {
    expect(geoErrorKind({ code: 3 } as GeolocationPositionError)).toBe('timeout')
  })
})

describe('toFix', () => {
  it('converts a GeolocationPosition to a Fix, timestamp in seconds', () => {
    const pos = { coords: { latitude: 1.5, longitude: 2.5, accuracy: 9 }, timestamp: 5_000 } as GeolocationPosition
    expect(toFix(pos)).toEqual({ lat: 1.5, lon: 2.5, accuracy: 9, at: 5 })
  })
})

// Ported from flock's b5c0fe3 regression coverage: pollLocation's success
// callback rescheduled the next sample but the error callback did not, so a
// single transient getCurrentPosition failure (indoors, cold GPS, a 20s
// timeout) permanently ended the self-scheduling loop.
describe('pollLocation — a transient error must not end the loop', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function geoFailingOnce(): { calls: () => number } {
    let calls = 0
    vi.stubGlobal('navigator', {
      geolocation: {
        getCurrentPosition: (success: PositionCallback, error: PositionErrorCallback) => {
          calls += 1
          if (calls === 1) error({ code: 3, message: 'timeout' } as GeolocationPositionError)
          else success({ coords: { latitude: 1, longitude: 2, accuracy: 3 }, timestamp: 4_000_000 } as GeolocationPosition)
        },
      },
    })
    return { calls: () => calls }
  }

  it('retries after a transient error and delivers the next successful fix', () => {
    vi.useFakeTimers()
    geoFailingOnce()
    const fixes: Fix[] = []
    const errors: string[] = []
    const stop = pollLocation((f) => fixes.push(f), (m) => errors.push(m), { nextDelayMs: () => 60_000 })

    expect(errors).toHaveLength(1)
    expect(fixes).toHaveLength(0)

    vi.advanceTimersByTime(POLL_ERROR_RETRY_MS)
    expect(fixes).toHaveLength(1)
    expect(fixes[0]).toEqual({ lat: 1, lon: 2, accuracy: 3, at: 4_000 })
    stop()
  })

  it('stop() during the error backoff prevents any further sampling', () => {
    vi.useFakeTimers()
    const geo = geoFailingOnce()
    const stop = pollLocation(() => {}, () => {}, { nextDelayMs: () => 60_000 })
    stop()
    vi.advanceTimersByTime(POLL_ERROR_RETRY_MS * 10)
    expect(geo.calls()).toBe(1) // the initial failing sample only — no zombie retries
  })
})
