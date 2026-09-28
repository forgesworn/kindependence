import type { CapacitorConfig } from '@capacitor/cli'

// Capacitor wraps the built PWA (dist) as a native Android app shell — the
// map/beacons UI needs real device geolocation permissions, which only a
// native install can prompt for the way this app's users expect. See
// forgesworn/flock's capacitor.config.ts for the sibling convention this
// mirrors (same reverse-domain namespace, cc.trotters.*).
const config: CapacitorConfig = {
  appId: 'cc.trotters.kindependence',
  appName: 'Kindependence',
  webDir: 'dist',
  // Matches the app's own dark theme (styles.css / manifest.webmanifest
  // background_color — the Kindred "room" tone) so there's no colour flash
  // before the WebView paints. The icon/splash generator uses the mark's own
  // warm-ink ground (#241b12) separately — a brand color for the mark.
  backgroundColor: '#17110b',
  // Local-notification small icon (final review follow-up, item 6/M-triage):
  // `ic_stat_kindependence` (android/app/src/main/res/drawable) — a monochrome
  // silhouette derived from the app's own mark (the campfire), not the
  // launcher fallback Android otherwise substitutes. `iconColor` matches the
  // flame gold from public/icon.svg — same "set the default here, repeat
  // per-call as belt-and-suspenders" pattern as signet-app's own
  // capacitor.config.ts.
  plugins: {
    LocalNotifications: {
      smallIcon: 'ic_stat_kindependence',
      iconColor: '#e0a458',
    },
  },
}

export default config
