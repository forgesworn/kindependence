// Native location samples feed the same precision pipeline as foreground
// samples. This plugin version uses Google Play location services and high
// accuracy sampling. Its distance filter limits callbacks, not sampling.
// The renderer owns sending and geofence evaluation; a foreground service
// notification does not establish that JavaScript is running.

import { isNativePlatform } from './native.js'
import { feedFix } from './beacons.js'
import { currentSession } from './session.js'
import type { Fix } from './geo.js'
import type { Persisted } from './store.js'
import * as store from './store.js'

interface BgLocation { latitude: number; longitude: number; accuracy: number; time: number }
interface BgError { code?: string; message?: string }

interface BackgroundGeolocationPlugin {
  addWatcher(
    options: {
      backgroundTitle?: string
      backgroundMessage?: string
      requestPermissions?: boolean
      stale?: boolean
      distanceFilter?: number
    },
    callback: (location?: BgLocation, error?: BgError) => void,
  ): Promise<string>
  removeWatcher(options: { id: string }): Promise<void>
}

let watcherId: string | null = null
let starting = false
let desiredRun = false
let locationError = ''
let retryBlocked = false
let resumeWired = false
function setLocationError(message: string): void { if (locationError !== message) { locationError = message; store.notify() } }
export function sharingError(): string { return locationError }

async function startWatcher(): Promise<void> {
  if (watcherId || starting || !isNativePlatform()) return
  starting = true
  let failed = false
  try {
    const { registerPlugin } = await import('@capacitor/core')
    const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation')
    watcherId = await BackgroundGeolocation.addWatcher(
      {
        backgroundTitle: 'Kindependence location sampling',
        backgroundMessage: 'Open Kindependence to check sharing. Android may pause background updates.',
        requestPermissions: true,
        stale: false,
        // Metres between callbacks; does not change native sampling.
        distanceFilter: 25,
      },
      (location, error) => {
        if (!desiredRun) return
        if (error || !location) {
          failed = true
          retryBlocked = true
          setLocationError(error?.code === 'NOT_AUTHORIZED' ? 'Location permission is blocked. Open Android settings to allow sharing.' : 'Location is unavailable. Open Android location settings and check sharing.')
          if (watcherId) void stopWatcher()
          return
        }
        setLocationError('')
        const fix: Fix = { lat: location.latitude, lon: location.longitude, accuracy: location.accuracy, at: Math.floor(location.time / 1000) }
        feedFix(fix)
      },
    )
    if (!desiredRun || failed) await stopWatcher()
  } catch {
    retryBlocked = true
    setLocationError('This phone could not start location sharing. Reopen the app to retry.')
  } finally {
    starting = false
  }
}

async function stopWatcher(): Promise<void> {
  const id = watcherId
  watcherId = null
  if (!id) return
  try {
    const { registerPlugin } = await import('@capacitor/core')
    const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation')
    await BackgroundGeolocation.removeWatcher({ id })
  } catch {
    // already gone
  }
}

/**
 * Pure decision: should the continuous native background watcher be running
 * right now? `native` is `isNativePlatform()`; `hasIdentity`/`hasCircles` are
 * kindependence's own stand-in for flock's `sharing` flag — there's no separate
 * manual toggle here, so an identity with at least one circle already IS
 * "sharing" (see the module doc comment above). Mirrors flock's own
 * `startBgWatch` guard (`!persisted.identity || !persisted.circles.length`)
 * almost exactly. Pure and deterministic — no plugin/Capacitor access — so
 * it's directly unit-testable without mocking any native API.
 */
export function shouldWatcherRun(native: boolean, hasIdentity: boolean, hasCircles: boolean): boolean {
  return native && hasIdentity && hasCircles
}

/**
 * Starts or stops the continuous background watcher to match the current
 * sharing-lifecycle state — called from app.ts's render() on every state
 * change (same "idempotent, safe every render" idiom as beacons.ensure and
 * every other domain module's `ensure()`), NOT gated behind `if (currentSession())`
 * at the call site, so a sign-out (or a circle list dropping to empty) is
 * seen here too and stops the watcher rather than leaving it running
 * indefinitely. A no-op in both directions on web (`shouldWatcherRun` is
 * `false` either way once `native` is false, and `stopWatcher` itself is a
 * no-op when nothing is running).
 */
export function ensure(p: Persisted): void {
  desiredRun = shouldWatcherRun(isNativePlatform(), !!currentSession(), p.circles.length > 0)
  if (!resumeWired && isNativePlatform() && typeof document !== 'undefined') {
    resumeWired = true
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && desiredRun) { retryBlocked = false; void startWatcher() }
    })
  }
  if (desiredRun && !retryBlocked) void startWatcher()
  else if (!desiredRun) { retryBlocked = false; locationError = ''; void stopWatcher() }
}
