import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { getPublicKey } from 'nostr-tools/pure'
import { hexToBytes } from '@noble/hashes/utils.js'
import type { SecretStore } from './secure-key.js'
import { loadOrCreatePhoneKey, forgetPhoneKey, secretStore } from './secure-key.js'

// Fake native plugin behind `@capacitor/core`'s `registerPlugin` — lets the
// "native get() normalises a missing `value`" test below drive the exact
// wire shape a real (or stale) native side could hand back, without a real
// Android bridge. Declared via `vi.hoisted` so it's initialised before the
// `vi.mock` factory (hoisted to the top of the file by Vitest) runs.
const fakeNativePlugin = vi.hoisted(() => ({
  get: vi.fn(async (_o: { name: string }): Promise<{ value?: string | null }> => ({ value: null })),
  set: vi.fn(async (_o: { name: string; value: string }) => {}),
  remove: vi.fn(async (_o: { name: string }) => {}),
}))

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => fakeNativePlugin,
}))

/** Fake `SecretStore` backed by a Map — Step 1's fake store, per the brief. */
function fakeStore(): SecretStore {
  const map = new Map<string, string>()
  return {
    async get(name) {
      return map.get(name) ?? null
    },
    async set(name, value) {
      map.set(name, value)
    },
    async remove(name) {
      map.delete(name)
    },
  }
}

describe('loadOrCreatePhoneKey', () => {
  it('creates a 64-hex key and returns the same key on the next call', async () => {
    const store = fakeStore()
    const first = await loadOrCreatePhoneKey(store)
    expect(first.skHex).toMatch(/^[0-9a-f]{64}$/)

    const second = await loadOrCreatePhoneKey(store)
    expect(second.skHex).toBe(first.skHex)
    expect(second.pkHex).toBe(first.pkHex)
  })

  it('pkHex equals getPublicKey(skHex)', async () => {
    const store = fakeStore()
    const { skHex, pkHex } = await loadOrCreatePhoneKey(store)
    expect(pkHex).toBe(getPublicKey(hexToBytes(skHex)))
  })
})

describe('forgetPhoneKey', () => {
  it('makes the next call create a new key', async () => {
    const store = fakeStore()
    const first = await loadOrCreatePhoneKey(store)
    await forgetPhoneKey(store)
    const second = await loadOrCreatePhoneKey(store)
    expect(second.skHex).not.toBe(first.skHex)
    expect(second.pkHex).not.toBe(first.pkHex)
  })
})

// Review fix round 1 (Important): two concurrent calls on an empty store
// previously could each read `null`, generate DIFFERENT keys, and each
// `set()` their own. The shared in-flight promise makes the second caller
// wait on the first's result instead.
describe('loadOrCreatePhoneKey — concurrent calls', () => {
  it('two concurrent calls on an empty store return the same key via a single set() call', async () => {
    const store = fakeStore()
    const setSpy = vi.spyOn(store, 'set')
    const [a, b] = await Promise.all([loadOrCreatePhoneKey(store), loadOrCreatePhoneKey(store)])
    expect(a).toEqual(b)
    expect(setSpy).toHaveBeenCalledTimes(1)
  })
})

// Review fix round 1 (Minor, spec'd): a store read that fails (e.g. the
// native side's decrypt failing on a corrupted stored value) throws a clear
// message rather than silently generating a replacement key underneath a
// caller that might still be relying on the old one. Recovery from this
// case is Task 5's call, not this module's.
describe('loadOrCreatePhoneKey — unreadable store', () => {
  it('throws a clear error when the store read fails, rather than regenerating', async () => {
    const store: SecretStore = {
      async get() {
        throw new Error('AEADBadTagException: mac check failed')
      },
      async set() {},
      async remove() {},
    }
    await expect(loadOrCreatePhoneKey(store)).rejects.toThrow('phone key unreadable')
  })
})

describe('secretStore', () => {
  // Minimal in-memory localStorage stand-in, same idiom as store.test.ts —
  // vitest's environment is 'node', so there's no global localStorage/window
  // without stubbing them.
  function fakeLocalStorage(): Storage {
    const mem = new Map<string, string>()
    return {
      getItem: (k: string) => mem.get(k) ?? null,
      setItem: (k: string, v: string) => { mem.set(k, String(v)) },
      removeItem: (k: string) => { mem.delete(k) },
      clear: () => mem.clear(),
      key: () => null,
      get length() { return mem.size },
    } as unknown as Storage
  }

  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })

  it('falls back to a localStorage-backed store off the native platform', async () => {
    const store = secretStore()
    expect(await store.get('phone-key')).toBeNull()
    await store.set('phone-key', 'deadbeef')
    expect(await store.get('phone-key')).toBe('deadbeef')
    expect(localStorage.getItem('kindependence.secret.phone-key')).toBe('deadbeef')
    await store.remove('phone-key')
    expect(await store.get('phone-key')).toBeNull()
  })
})

// Review fix round 1 (Important): org.json's `put` drops a key given a Java
// `null`, so a native `get()` on an absent value previously bridged over as
// `{}`, not `{ value: null }` — destructuring `{ value }` off that gives
// `undefined`, breaking the `string | null` contract. The Java side is
// fixed to put `JSONObject.NULL` (SecureKeyPlugin.java), and this covers the
// TS-side normalisation directly against exactly that "missing `value`"
// wire shape, independent of whether the native fix is actually in place.
describe('secretStore — native get() normalises a missing `value`', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    fakeNativePlugin.get.mockReset()
  })

  it('resolves null when the native result has no `value` key', async () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    fakeNativePlugin.get.mockResolvedValueOnce({})
    const store = secretStore()
    expect(await store.get('phone-key')).toBeNull()
  })
})
