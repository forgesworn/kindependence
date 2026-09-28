// Foreground geolocation — ported from flock's `app/src/services.ts`, the
// GEOLOCATION HALF only. roost-kit's `transport.ts` (the Nostr-transport half
// of that same file) deliberately left this out — see its own header
// comment: "flock's `services.ts` also held a foreground-geolocation half —
// a sensor helper unrelated to Nostr transport — which does NOT come along
// into this kit." This is that half, byte-faithful (function bodies and
// doc-comments unchanged) except: `toFix`/`geoErrorKind` are exported here
// (private in flock's original) so beacons.ts and this file's own tests can
// use them directly, and import-path-relative concerns don't apply (no
// imports at all in the original geo half).

export interface Fix { lat: number; lon: number; accuracy: number; at: number }

export const toFix = (pos: GeolocationPosition): Fix => ({
  lat: pos.coords.latitude,
  lon: pos.coords.longitude,
  accuracy: pos.coords.accuracy,
  at: Math.floor(pos.timestamp / 1000),
})

/** Why a location request failed — drives actionable guidance, not a raw toast.
 *  'denied' is the one that needs the user's hands (a settings change); the
 *  others are transient and the watch keeps trying. */
export type GeoErrorKind = 'denied' | 'unavailable' | 'timeout' | 'unsupported'

export function geoErrorKind(err: GeolocationPositionError): GeoErrorKind {
  return err.code === 1 ? 'denied' : err.code === 2 ? 'unavailable' : 'timeout'
}

/**
 * Watch foreground location. Returns a stop fn.
 *
 * `highAccuracy` picks the hardware tier: `true` (GPS) for family breach detection
 * and full disclosures, `false` (network/cell — far less battery, and coarser by
 * construction) for a night-out coarse share, where ±hundreds of metres is ample.
 * A low-power fix reports a larger `accuracy`, which the breach logic reads to stay
 * fail-safe. (Minimal-footprint north star — Phase H.)
 */
export function watchLocation(
  onFix: (f: Fix) => void,
  onError: (message: string, kind: GeoErrorKind) => void,
  opts: { highAccuracy?: boolean } = {},
): () => void {
  if (!('geolocation' in navigator)) {
    onError('Location is not available on this device.', 'unsupported')
    return () => { /* noop */ }
  }
  const highAccuracy = opts.highAccuracy ?? true
  const id = navigator.geolocation.watchPosition(
    (pos) => onFix(toFix(pos)),
    (err) => onError(err.message || 'Could not get your location.', geoErrorKind(err)),
    // A low-power watch may also lean on slightly staler cached fixes.
    { enableHighAccuracy: highAccuracy, maximumAge: highAccuracy ? 5000 : 15_000, timeout: 20_000 },
  )
  return () => navigator.geolocation.clearWatch(id)
}

/** After a transient failure (timeout / temporary no-fix) the self-scheduled poll
 *  retries at this cadence instead of stopping — a single error must never end
 *  location sharing silently (flock b5c0fe3 parity). Permanent errors
 *  (denied/unsupported) are torn down by the caller, so this only ever paces
 *  genuine retries. */
export const POLL_ERROR_RETRY_MS = 15_000

/**
 * Self-scheduled location poll (an alternative to the continuous watch) whose
 * interval the caller sets per fix via `nextDelayMs` — so a stationary night-out
 * share can back off and let the radio sleep between samples, tightening again the
 * moment it moves. One-shot GPS calls power down between polls, unlike a watch.
 * Returns a stop fn. (Family breach stays on the continuous `watchLocation`.)
 */
export function pollLocation(
  onFix: (f: Fix) => void,
  onError: (message: string, kind: GeoErrorKind) => void,
  opts: { highAccuracy?: boolean; nextDelayMs: (f: Fix) => number },
): () => void {
  if (!('geolocation' in navigator)) {
    onError('Location is not available on this device.', 'unsupported')
    return () => { /* noop */ }
  }
  let timer: ReturnType<typeof setTimeout> | undefined
  let stopped = false
  const schedule = (ms: number): void => { if (!stopped) timer = setTimeout(tick, ms) }
  function tick(): void {
    navigator.geolocation.getCurrentPosition(
      (pos) => { if (stopped) return; const f = toFix(pos); onFix(f); schedule(opts.nextDelayMs(f)) },
      (err) => {
        if (stopped) return
        onError(err.message || 'Could not get your location.', geoErrorKind(err))
        // Keep the self-scheduling loop alive across a transient failure: the
        // success path reschedules on each fix, and without an equivalent
        // reschedule here the FIRST error (indoors, cold GPS, a 20s timeout)
        // silently ended polling forever. A permanent denied/unsupported error
        // makes the caller stop this poll (its stop fn sets `stopped`), so
        // schedule() correctly no-ops for those.
        schedule(POLL_ERROR_RETRY_MS)
      },
      { enableHighAccuracy: opts.highAccuracy ?? false, maximumAge: 10_000, timeout: 20_000 },
    )
  }
  tick() // sample immediately, then self-schedule
  return () => { stopped = true; if (timer !== undefined) clearTimeout(timer) }
}

/**
 * One-shot foreground location — resolves to a Fix, or `null` if geolocation is
 * unavailable, denied, or times out. Never rejects, so callers can simply skip on
 * a null. Used for three things: centring the map (default, lenient), a **fresh fix
 * on an explicit SOS/pick-up** (short `timeoutMs`, so an alert is never delayed more
 * than a beat but carries the freshest location possible), and **escalating an
 * uncertain family fix** to a sharper GPS one (`maximumAge: 0`). Purely local —
 * nothing is broadcast.
 */
export function currentPosition(
  opts: { enableHighAccuracy?: boolean; maximumAge?: number; timeoutMs?: number } = {},
): Promise<Fix | null> {
  if (typeof navigator === 'undefined' || !('geolocation' in navigator)) return Promise.resolve(null)
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve(toFix(pos)),
      () => resolve(null),
      {
        enableHighAccuracy: opts.enableHighAccuracy ?? true,
        maximumAge: opts.maximumAge ?? 30_000,
        timeout: opts.timeoutMs ?? 20_000,
      },
    )
  })
}
