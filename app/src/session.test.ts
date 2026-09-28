import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as store from './store.js'
import * as session from './session.js'
import { secretStore, forgetPhoneKey } from './secure-key.js'
import { fakeBunker } from './test-support/fake-bunker.js'
import type { SessionInfo } from './session.js'

// Same in-memory localStorage stand-in as store.test.ts/beacons.test.ts —
// this is also what secure-key.ts's dev-only `webSecretStore()` writes
// through (a different key namespace, `kindependence.secret.*`, on the same
// global), so a single stub covers both the store blob and the phone/bunker
// secrets for these tests.
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

afterEach(async () => {
  session.setTransportFactoryForTests(null)
  await session.signOut()
})

function fakeSessionInfo(overrides: Partial<Omit<SessionInfo, 'phonePk' | 'statement'>> = {}): Omit<SessionInfo, 'phonePk' | 'statement'> {
  return {
    identityPk: 'a'.repeat(64),
    dependant: false,
    name: 'Alex',
    transport: { kind: 'nip55', packageName: 'app.example.signer' },
    ...overrides,
  }
}

describe('startSession', () => {
  it('creates a phone key and stores the session without secrets', async () => {
    const transport = fakeBunker({})
    const info = fakeSessionInfo({ identityPk: transport.pubkey })
    const full = await session.startSession(info, transport)

    expect(full.identityPk).toBe(info.identityPk)
    expect(full.phonePk).toMatch(/^[0-9a-f]{64}$/)
    expect(store.load().session).toEqual(full)

    const phoneSkHex = await secretStore().get('phone-key')
    expect(phoneSkHex).toMatch(/^[0-9a-f]{64}$/)

    const raw = localStorage.getItem('kindependence.v1')
    expect(raw).toBeTruthy()
    expect(raw).not.toContain(phoneSkHex as string)
  })

  // Review fix round 1, item 3.
  it('rejects if the transport pubkey does not match the identity pubkey, without touching any state', async () => {
    const bunker = fakeBunker({})
    const info = fakeSessionInfo({ identityPk: 'f'.repeat(64) }) // deliberately not bunker.pubkey
    await expect(session.startSession(info, bunker)).rejects.toThrow('transport pubkey does not match the identity pubkey')

    expect(session.currentSession()).toBeNull()
    expect(store.load().session).toBeUndefined()
  })

  it('closes an already-live transport from a prior session before starting a new one', async () => {
    const first = fakeBunker({})
    const closeSpy = vi.spyOn(first, 'close')
    await session.startSession(fakeSessionInfo({ identityPk: first.pubkey }), first)

    const second = fakeBunker({})
    await session.startSession(fakeSessionInfo({ identityPk: second.pubkey }), second)

    expect(closeSpy).toHaveBeenCalledTimes(1)
    expect(session.currentSession()?.identityPk).toBe(second.pubkey)
  })

  // Task 11 fix round 1, finding 2.
  it('persists a nip46 bunker uri with its secret param stripped, keeping the full uri only in SecretStore', async () => {
    const transport = fakeBunker({})
    const fullUri = `bunker://${transport.pubkey}?relay=wss://relay.example&secret=topsecret`
    const info = fakeSessionInfo({ identityPk: transport.pubkey, transport: { kind: 'nip46', bunkerUri: fullUri } })

    const full = await session.startSession(info, transport)

    const strippedUri = `bunker://${transport.pubkey}?relay=wss://relay.example`
    expect(full.transport).toEqual({ kind: 'nip46', bunkerUri: strippedUri })
    expect(store.load().session?.transport).toEqual({ kind: 'nip46', bunkerUri: strippedUri })

    const raw = localStorage.getItem('kindependence.v1') as string
    expect(raw).not.toContain('secret=')
    expect(await secretStore().get('bunker-uri')).toBe(fullUri)
  })

  // Review fix round 2.
  it('if the phone key read throws, leaves an existing session and its live transport untouched (error propagates)', async () => {
    const first = fakeBunker({})
    const firstInfo = fakeSessionInfo({ identityPk: first.pubkey })
    const firstFull = await session.startSession(firstInfo, first)
    const closeSpy = vi.spyOn(first, 'close')

    // Make the phone key's own SecretStore entry throw on read, same
    // technique as the `restore()` "unreadable" test — everything else in
    // localStorage (the store blob, any other secret) stays readable.
    const getItem = localStorage.getItem.bind(localStorage)
    const spy = vi.spyOn(localStorage, 'getItem').mockImplementation((k: string) => {
      if (k === 'kindependence.secret.phone-key') throw new Error('keystore unavailable')
      return getItem(k)
    })

    const second = fakeBunker({})
    const secondInfo = fakeSessionInfo({ identityPk: second.pubkey })
    await expect(session.startSession(secondInfo, second)).rejects.toThrow('phone key unreadable')

    // The old session's transport was never touched, and the old session is
    // still the current, usable one.
    expect(closeSpy).not.toHaveBeenCalled()
    expect(session.currentSession()).toEqual(firstFull)
    expect(session.phoneSigner().pubkey).toBe(firstFull.phonePk)

    spy.mockRestore()
  })
})

describe('restore', () => {
  it('returns null when no session is persisted', async () => {
    expect(await session.restore()).toBeNull()
  })

  it('returns the same session that was started', async () => {
    const transport = fakeBunker({})
    const info = fakeSessionInfo({ identityPk: transport.pubkey })
    const full = await session.startSession(info, transport)

    const restored = await session.restore()
    expect(restored).toEqual(full)
    expect(session.currentSession()).toEqual(full)
  })

  it('treats an unreadable phone key as signed out: clears the session and returns null', async () => {
    const transport = fakeBunker({})
    const info = fakeSessionInfo({ identityPk: transport.pubkey })
    await session.startSession(info, transport)
    expect(store.load().session).toBeDefined()

    // Make the phone key's own SecretStore entry throw on read — exactly
    // what secure-key.ts's `loadOrCreatePhoneKey` wraps into
    // `Error('phone key unreadable')` — while the store blob itself
    // (a different key namespace, see this file's `fakeLocalStorage` doc
    // comment) stays readable.
    const mem = new Map<string, string>([['kindependence.v1', localStorage.getItem('kindependence.v1') as string]])
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => {
        if (k.startsWith('kindependence.secret.')) throw new Error('keystore unavailable')
        return mem.get(k) ?? null
      },
      setItem: (k: string, v: string) => { mem.set(k, String(v)) },
      removeItem: (k: string) => { mem.delete(k) },
      clear: () => mem.clear(),
      key: () => null,
      get length() { return mem.size },
    } as unknown as Storage)

    const restored = await session.restore()
    expect(restored).toBeNull()
    expect(session.currentSession()).toBeNull()
    expect(store.load().session).toBeUndefined()
  })

  it('does not reconnect the identity transport eagerly — only a real signing call does', async () => {
    const bunker = fakeBunker({})
    const factory = vi.fn(async () => bunker)
    session.setTransportFactoryForTests(factory)

    const info = fakeSessionInfo({ identityPk: bunker.pubkey, transport: { kind: 'nip46', bunkerUri: 'bunker://irrelevant' } })
    await session.startSession(info, bunker)

    const restored = await session.restore()
    expect(restored).not.toBeNull()
    expect(factory).not.toHaveBeenCalled()

    const signed = await session.identitySigner().signEvent({ kind: 1, content: 'hi', tags: [], created_at: 1_700_000_000 })
    expect(signed.pubkey).toBe(bunker.pubkey)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  // Review fix round 1, item 1.
  it('treats a phone key that no longer matches the persisted session.phonePk as signed out (keystore entry lost, blob survived)', async () => {
    const transport = fakeBunker({})
    const info = fakeSessionInfo({ identityPk: transport.pubkey })
    const full = await session.startSession(info, transport)
    expect(store.load().session?.phonePk).toBe(full.phonePk)

    // Simulate the keystore entry behind the phone key being lost while the
    // store blob survives: the SecretStore's own `phone-key` entry is gone,
    // so the next `loadOrCreatePhoneKey()` mints a brand new (different) key.
    await forgetPhoneKey()

    const restored = await session.restore()
    expect(restored).toBeNull()
    expect(session.currentSession()).toBeNull()
    expect(store.load().session).toBeUndefined()

    // The freshly-minted key is real and kept for whatever session starts
    // next — restore() does not delete it, only refuses to bind it to the
    // stale session.
    expect(await secretStore().get('phone-key')).toMatch(/^[0-9a-f]{64}$/)
  })

  // Review fix round 1, item 2.
  it('does not cache a rejected connect: the next identitySigner call retries the factory', async () => {
    const bunker = fakeBunker({})
    let attempt = 0
    const factory = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) throw new Error('signer unreachable')
      return bunker
    })
    session.setTransportFactoryForTests(factory)

    const info = fakeSessionInfo({ identityPk: bunker.pubkey, transport: { kind: 'nip46', bunkerUri: 'bunker://irrelevant' } })
    await session.startSession(info, bunker)
    await session.restore()

    await expect(
      session.identitySigner().signEvent({ kind: 1, content: 'hi', tags: [], created_at: 1_700_000_000 }),
    ).rejects.toThrow()
    expect(factory).toHaveBeenCalledTimes(1)

    const signed = await session.identitySigner().signEvent({ kind: 1, content: 'hi', tags: [], created_at: 1_700_000_000 })
    expect(signed.pubkey).toBe(bunker.pubkey)
    expect(factory).toHaveBeenCalledTimes(2)
  })

  // Task 11 fix round 1, finding 2.
  it('reconnects a nip46 session with the FULL bunker uri (secret included), read from SecretStore rather than the stripped persisted copy', async () => {
    const bunker = fakeBunker({})
    const fullUri = `bunker://${bunker.pubkey}?relay=wss://relay.example&secret=topsecret`
    const info = fakeSessionInfo({ identityPk: bunker.pubkey, transport: { kind: 'nip46', bunkerUri: fullUri } })
    await session.startSession(info, bunker)
    // What's actually persisted has the secret stripped.
    expect(store.load().session?.transport).toEqual({ kind: 'nip46', bunkerUri: `bunker://${bunker.pubkey}?relay=wss://relay.example` })

    const factory = vi.fn(async (_info: SessionInfo) => bunker)
    session.setTransportFactoryForTests(factory)
    await session.restore()
    await session.identitySigner().signEvent({ kind: 1, content: 'hi', tags: [], created_at: 1_700_000_000 })

    expect(factory).toHaveBeenCalledTimes(1)
    expect(factory.mock.calls[0][0].transport).toEqual({ kind: 'nip46', bunkerUri: fullUri })
  })

  // Review fix round 1, item 4.
  it('closes the previous connected lazy transport when restore() runs again', async () => {
    const bunker = fakeBunker({})
    const factory = vi.fn(async () => bunker)
    session.setTransportFactoryForTests(factory)

    const info = fakeSessionInfo({ identityPk: bunker.pubkey, transport: { kind: 'nip46', bunkerUri: 'bunker://irrelevant' } })
    await session.startSession(info, bunker)
    await session.restore()
    await session.identitySigner().signEvent({ kind: 1, content: 'hi', tags: [], created_at: 1_700_000_000 })
    expect(factory).toHaveBeenCalledTimes(1)

    const closeSpy = vi.spyOn(bunker, 'close')
    await session.restore()
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })
})

describe('signOut', () => {
  it('clears the current session, the phone key, and the entire local store', async () => {
    const emptyDefaults = store.load()

    const bunker = fakeBunker({})
    const info = fakeSessionInfo({ identityPk: bunker.pubkey })
    await session.startSession(info, bunker)
    store.update((p) => { p.seenStructural.push('leftover-local-data') })

    await session.signOut()

    expect(session.currentSession()).toBeNull()
    expect(store.load()).toEqual(emptyDefaults)
    expect(await secretStore().get('phone-key')).toBeNull()
    expect(() => session.phoneSigner()).toThrow('not signed in')
    expect(() => session.identitySigner()).toThrow('not signed in')
  })

  // Review fix round 1, item 5.
  it('still clears local state (via finally), and still propagates the error, if forgetting a secret throws', async () => {
    const emptyDefaults = store.load()

    const bunker = fakeBunker({})
    const info = fakeSessionInfo({ identityPk: bunker.pubkey })
    await session.startSession(info, bunker)

    const removeItem = localStorage.removeItem.bind(localStorage)
    const spy = vi.spyOn(localStorage, 'removeItem').mockImplementation((k: string) => {
      if (k === 'kindependence.secret.phone-key') throw new Error('keystore remove failed')
      removeItem(k)
    })

    await expect(session.signOut()).rejects.toThrow('keystore remove failed')

    expect(session.currentSession()).toBeNull()
    expect(() => session.phoneSigner()).toThrow('not signed in')
    expect(store.load()).toEqual(emptyDefaults)

    spy.mockRestore()
  })

  it('removes the bunker client secret too, so a fresh sign-in mints a new one', async () => {
    const bunker = fakeBunker({})
    const info = fakeSessionInfo({ identityPk: bunker.pubkey })
    await session.startSession(info, bunker)

    // Seed it as if a real NIP-46 reconnect had already stored one.
    await secretStore().set('bunker-client-sk', 'a'.repeat(64))
    expect(await secretStore().get('bunker-client-sk')).not.toBeNull()

    await session.signOut()
    expect(await secretStore().get('bunker-client-sk')).toBeNull()
  })

  // Task 11 fix round 1, finding 2.
  it('removes the bunker uri secret too', async () => {
    const bunker = fakeBunker({})
    const fullUri = `bunker://${bunker.pubkey}?relay=wss://relay.example&secret=topsecret`
    const info = fakeSessionInfo({ identityPk: bunker.pubkey, transport: { kind: 'nip46', bunkerUri: fullUri } })
    await session.startSession(info, bunker)
    expect(await secretStore().get('bunker-uri')).toBe(fullUri)

    await session.signOut()
    expect(await secretStore().get('bunker-uri')).toBeNull()
  })
})

describe('final fix A6: restore() discards a dead session completely', () => {
  it('unreadable phone key → restore forgets it → a new sign-in succeeds with a new key', async () => {
    const first = fakeBunker({})
    const old = await session.startSession(fakeSessionInfo({ identityPk: first.pubkey }), first)
    const oldSk = await secretStore().get('phone-key')

    // Keystore alias lost, prefs intact: the stored value can't be decrypted.
    const getItem = localStorage.getItem.bind(localStorage)
    vi.spyOn(localStorage, 'getItem').mockImplementation((k: string) => {
      const v = getItem(k)
      if (k === 'kindependence.secret.phone-key' && v === oldSk) throw new Error('keystore unavailable')
      return v
    })

    expect(await session.restore()).toBeNull()
    const second = fakeBunker({})
    const fresh = await session.startSession(fakeSessionInfo({ identityPk: second.pubkey }), second)
    expect(fresh.phonePk).toMatch(/^[0-9a-f]{64}$/)
    expect(fresh.phonePk).not.toBe(old.phonePk)
  })

  it('a discarded session wipes the store and the bunker secrets: a different identity signing in sees no circles', async () => {
    const first = fakeBunker({})
    const uri = `bunker://${first.pubkey}?relay=wss://relay.example&secret=s`
    await session.startSession(fakeSessionInfo({ identityPk: first.pubkey, transport: { kind: 'nip46', bunkerUri: uri } }), first)
    await session.bunkerClientSk()
    store.update((p) => {
      p.circles = [{ id: 'c1', name: 'Old', seedHex: '1'.repeat(64), epoch: 0, members: [{ pk: first.pubkey, role: 'guardian' }], createdAt: 1, configUpdatedAt: 1, configBy: first.pubkey }]
    })
    await forgetPhoneKey() // keystore entry lost, blob survived → mismatch branch

    expect(await session.restore()).toBeNull()
    expect(store.load().circles).toEqual([])
    expect(await secretStore().get('bunker-uri')).toBeNull()
    expect(await secretStore().get('bunker-client-sk')).toBeNull()

    const second = fakeBunker({})
    await session.startSession(fakeSessionInfo({ identityPk: second.pubkey }), second)
    expect(store.load().circles).toEqual([])
  })
})

describe('phoneSigner', () => {
  it('throws when not signed in', () => {
    expect(() => session.phoneSigner()).toThrow('not signed in')
  })

  it('pubkey equals session.phonePk', async () => {
    const bunker = fakeBunker({})
    const info = fakeSessionInfo({ identityPk: bunker.pubkey })
    const full = await session.startSession(info, bunker)

    expect(session.phoneSigner().pubkey).toBe(full.phonePk)
  })
})

describe('identitySigner', () => {
  it('throws when not signed in', () => {
    expect(() => session.identitySigner()).toThrow('not signed in')
  })

  it('signs through the live transport handed to startSession, and verifies to the identity pubkey', async () => {
    const bunker = fakeBunker({})
    const info = fakeSessionInfo({ identityPk: bunker.pubkey })
    await session.startSession(info, bunker)

    const signed = await session.identitySigner().signEvent({ kind: 1, content: 'hi', tags: [], created_at: 1_700_000_000 })
    expect(signed.pubkey).toBe(bunker.pubkey)
  })
})
