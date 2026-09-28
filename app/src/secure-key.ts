// Secure key storage and the device's own transport key (Signet identity
// plan, Task 3): the "phone key" is a fresh nostr keypair generated once per
// install and held ONLY on this device — never derived from, or shared
// with, the family identity (identity.ts's persona keys) or the rail's
// throwaway pairing key (rail.ts's `newRailKeys`). It's the key a device
// statement (device-statements.ts) authorises to send circle traffic on
// behalf of an identity.
//
// Storage is behind the `SecretStore` seam so callers (and this module's own
// tests) never talk to a platform directly:
//  - native (Android): `SecureKeyPlugin.java`, an app-local Capacitor plugin
//    (same "not an npm package, hand-registered in MainActivity" discipline
//    as WidgetBridgePlugin) that keeps a non-exportable AES-256-GCM key in
//    the Android Keystore and uses it to encrypt/decrypt values it stores in
//    its own SharedPreferences — the phone key's hex material is never
//    written to disk in the clear.
//  - web/dev builds: a plain `localStorage`-backed store. There is no
//    Keystore-equivalent in a browser; this fallback exists only so the dev
//    build (`npm run dev`, tests) has somewhere to put the key, and is NOT a
//    secure store — deliberately dev-only, matching this module's own
//    `secretStore()` doc comment below.

import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import { isNativePlatform } from './native.js'

export interface SecretStore {
  get(name: string): Promise<string | null>
  set(name: string, value: string): Promise<void>
  remove(name: string): Promise<void>
}

/** Wire shape shared with `SecureKeyPlugin.get`'s `{ value }` return. */
interface SecureKeyNativePlugin {
  get(o: { name: string }): Promise<{ value: string | null }>
  set(o: { name: string; value: string }): Promise<void>
  remove(o: { name: string }): Promise<void>
}

/** Dynamically imports and resolves the native plugin — same "no
 *  module-scope `@capacitor/core` import" discipline as widget.ts/
 *  native-geo.ts, so a plain web bundle never pulls it in just to learn
 *  it isn't there. Called fresh from each `SecretStore` method rather than
 *  cached, matching every other call site in this codebase. */
// A Capacitor plugin proxy answers every property, `then` included, so a
// promise resolved with it calls the missing native `then()` and rejects.
// The proxy is therefore handed back boxed.
async function nativePlugin(): Promise<{ p: SecureKeyNativePlugin }> {
  const { registerPlugin } = await import('@capacitor/core')
  return { p: registerPlugin<SecureKeyNativePlugin>('SecureKey') }
}

function nativeSecretStore(): SecretStore {
  return {
    async get(name) {
      const { p: plugin } = await nativePlugin()
      const { value } = await plugin.get({ name })
      // Review fix round 1: normalise a native result that's missing the
      // `value` key entirely to null — belt-and-braces alongside the Java
      // side's own fix (SecureKeyPlugin now puts `JSONObject.NULL`, not a
      // Java `null`, which org.json's `put` would otherwise silently drop
      // the key for) so this stays `string | null`, never `undefined`,
      // regardless of what shape crosses the bridge.
      return value ?? null
    },
    async set(name, value) {
      const { p: plugin } = await nativePlugin()
      await plugin.set({ name, value })
    },
    async remove(name) {
      const { p: plugin } = await nativePlugin()
      await plugin.remove({ name })
    },
  }
}

/** localStorage-backed `SecretStore` — DEV BUILD ONLY. Values are stored in
 *  the clear (no Android Keystore equivalent in a browser); never used when
 *  `Capacitor.isNativePlatform()` is true (`secretStore()`, below, picks the
 *  native store in that case). */
function webSecretStore(): SecretStore {
  const key = (name: string): string => `kindependence.secret.${name}`
  return {
    async get(name) {
      return localStorage.getItem(key(name))
    },
    async set(name, value) {
      localStorage.setItem(key(name), value)
    },
    async remove(name) {
      localStorage.removeItem(key(name))
    },
  }
}

/** The `SecretStore` for this platform: the native Android Keystore-backed
 *  plugin when running inside the Capacitor shell, else the dev-only
 *  localStorage fallback above. */
export function secretStore(): SecretStore {
  return isNativePlatform() ? nativeSecretStore() : webSecretStore()
}

const PHONE_KEY_NAME = 'phone-key'

// Review fix round 1 (concurrency, Minor): two callers racing
// `loadOrCreatePhoneKey` on an empty store could previously each read
// `null`, each generate a DIFFERENT fresh key, and each `set()` their own —
// whichever write lands last silently wins, so the two callers' returned
// keys could disagree. A single module-level in-flight promise makes every
// call that arrives while one is already running share that same result
// instead of racing its own read/generate/write. Deliberately NOT `async`:
// the "is one already running" check and the assignment that starts one
// both need to happen synchronously, before any `await`, so that two calls
// made back-to-back in the same tick (e.g. `Promise.all([...])`) see it.
let inFlight: Promise<{ skHex: string; pkHex: string }> | null = null

/** Loads this device's phone key from `store` (defaulting to
 *  `secretStore()`), generating and persisting a fresh one on first call.
 *  Idempotent across calls (and across app restarts, since the underlying
 *  store persists) — the same key comes back every time until
 *  `forgetPhoneKey` runs. Concurrent calls share one in-flight read/create
 *  (see `inFlight` above) rather than racing. A store read that fails (e.g.
 *  a corrupted/undecryptable stored value) throws a clear `Error('phone key
 *  unreadable')` rather than silently regenerating a key out from under a
 *  caller that might still be relying on the old one — recovery from that
 *  case is a later task's call (Task 5), not this module's. */
export function loadOrCreatePhoneKey(store: SecretStore = secretStore()): Promise<{ skHex: string; pkHex: string }> {
  if (inFlight) return inFlight
  inFlight = (async () => {
    try {
      let existing: string | null
      try {
        existing = await store.get(PHONE_KEY_NAME)
      } catch (cause) {
        throw new Error('phone key unreadable', { cause })
      }
      if (existing) return { skHex: existing, pkHex: getPublicKey(hexToBytes(existing)) }
      const sk = generateSecretKey()
      const skHex = bytesToHex(sk)
      await store.set(PHONE_KEY_NAME, skHex)
      return { skHex, pkHex: getPublicKey(sk) }
    } finally {
      inFlight = null
    }
  })()
  return inFlight
}

/** Deletes this device's phone key from `store` (defaulting to
 *  `secretStore()`) — the next `loadOrCreatePhoneKey` call generates a new
 *  one. Used when a dependant (or this device) is removed from the family
 *  and its old device statement should no longer be usable. */
export async function forgetPhoneKey(store: SecretStore = secretStore()): Promise<void> {
  await store.remove(PHONE_KEY_NAME)
}
