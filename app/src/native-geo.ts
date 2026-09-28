// Native background location (Task 9, brief §12/§29) — mirrors
// forgesworn/flock's native/background.ts bridge pattern:
// @capacitor-community/background-geolocation drives the platform's raw
// LocationManager plus a foreground service (no Google Play Services
// dependency — GrapheneOS-safe, same as flock's own choice; see that
// plugin's own README).
//
// Permissions, corrected (review, Task 9): the plugin's own Java source
// (node_modules/@capacitor-community/background-geolocation/android/src/
// main/java/.../BackgroundGeolocation.java) only ever requests
// ACCESS_COARSE_LOCATION/ACCESS_FINE_LOCATION when `requestPermissions: true`
// triggers its runtime prompt — it does NOT request
// ACCESS_BACKGROUND_LOCATION or any notification permission. The manifest
// (android/app/src/main/AndroidManifest.xml) declares
// ACCESS_BACKGROUND_LOCATION separately, but Android grants a running
// FOREGROUND_SERVICE with a `location` foregroundServiceType "while-in-use"
// location access for as long as that service runs, regardless of whether
// the background permission was ever granted — that's what actually keeps
// fixes flowing while the app is closed here, not a plugin-driven background-
// permission request. POST_NOTIFICATIONS (Android 13+, for the foreground
// service's persistent notification) is requested at runtime by notify.ts
// (its own `LocalNotifications.requestPermissions()` call), entirely
// unrelated to this plugin.
//
// Lifecycle (review, Task 9 — corrected from an earlier visibilitychange-
// gated version): the watcher is CONTINUOUS, tied to kindependence's own sharing
// lifecycle — exactly flock's own pattern (app.ts's `startBgWatch`/
// `stopBgWatch`, called from `startSharing`/`stopSharing`, never from a
// foreground/background transition). Kindependence has no separate manual
// sharing toggle: an identity with at least one circle already IS "sharing"
// (the same signal beacons.ts's own `ensureGeoWatch`/`teardown` seam keys
// off), so that's the seam this module's `ensure()` uses too — called from
// app.ts's render() on every state change, same as beacons.ensure. The
// watcher runs in the foreground AND the background for the whole session
// (with `backgroundMessage` set, the plugin delivers fixes either way, per
// its own docs) rather than starting only once the app is hidden — a single
// missed hidden-transition can no longer mean the watcher never starts, and
// there's no separate foreground/background state for it to fall out of
// sync with. Double-sampling while foregrounded (this watcher plus beacons.ts's
// own `watchLocation`) is harmless: both feed the same `feedFix`/`applyFix`
// seam (beacons.ts), which is idempotent latest-wins.
//
// Fixes flow into beacons.ts's OWN pipeline via `beacons.feedFix` — the exact
// same `currentFix`/emit-timer/precision logic as every foreground fix, so
// the precision slider, per-circle baseline and agreement-schedule escalation
// all apply identically whether the app is open or closed (same discipline
// flock's own background.ts documents for itself).

import { isNativePlatform } from './native.js'
import { feedFix } from './beacons.js'
import { currentSession } from './session.js'
import type { Fix } from './geo.js'
import type { Persisted } from './store.js'

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

async function startWatcher(): Promise<void> {
  if (watcherId || starting || !isNativePlatform()) return
  starting = true
  try {
    const { registerPlugin } = await import('@capacitor/core')
    const BackgroundGeolocation = registerPlugin<BackgroundGeolocationPlugin>('BackgroundGeolocation')
    watcherId = await BackgroundGeolocation.addWatcher(
      {
        backgroundTitle: 'kindependence is sharing with your circle',
        backgroundMessage: 'Sharing your location with your circle while the app is closed.',
        requestPermissions: true,
        stale: false,
        // metres — routine circle sharing (beacons.ts's own foreground watch
        // also runs at `highAccuracy: false`), so this stays battery-friendly
        // rather than GPS-tier precise; the app being backgrounded doesn't
        // change what precision the circle is owed.
        distanceFilter: 25,
      },
      (location, error) => {
        if (error || !location) return // NOT_AUTHORIZED (permission revoked) or a transient miss — best-effort, same as beacons.ts's own foreground onError
        const fix: Fix = { lat: location.latitude, lon: location.longitude, accuracy: location.accuracy, at: Math.floor(location.time / 1000) }
        feedFix(fix)
      },
    )
  } catch {
    // plugin unavailable (web, or a dev build without `cap sync`) — the
    // foreground-only path still works.
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
  if (shouldWatcherRun(isNativePlatform(), !!currentSession(), p.circles.length > 0)) void startWatcher()
  else void stopWatcher()
}
