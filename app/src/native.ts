// Native (Capacitor) platform detection — the ONE place notify.ts and
// native-geo.ts ask "are we inside the Android shell right now?". Deliberately
// reads the global the Capacitor WebView runtime injects (`window.Capacitor`)
// rather than importing `@capacitor/core` at module scope, so a plain web/PWA
// visitor's bundle never has to load it just to learn the answer is "no" —
// same pattern as forgesworn/signet-app's `lib/native.ts`
// (`isNativeApp`) and forgesworn/flock's `app/src/native.ts` (`isNativeShell`).
export function isNativePlatform(): boolean {
  if (typeof window === 'undefined') return false
  const cap = (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor
  return cap?.isNativePlatform?.() === true
}
