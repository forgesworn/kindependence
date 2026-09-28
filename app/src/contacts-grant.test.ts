import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { finalizeEvent, getPublicKey, generateSecretKey } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import {
  createSignetContactsClient,
  buildProjection,
  parseProjection,
  parsePairingRequestV2,
  sealVaultPayload,
  projectionEventTemplate,
  type ContactProjectionV2,
  type ProjectedContact,
  type SignedNostrEvent,
  type RelayIo,
  type StorageIo,
  type ContactsSigner,
  type SignetContactsClient,
  type PairingV2,
} from '@forgesworn/signet-contacts'
import { pairingCode, formatPairingCode } from '@forgesworn/signet-contacts/wire'
import * as store from './store.js'
import { sessionForTests } from './session.js'
import { snapshot, setContactsSource, onContactsUpdate, classifyUpdate, type ContactsSnapshot } from './contacts.js'
import {
  CONTACTS_CAPABILITIES,
  contactsAppKey,
  beginPairing,
  startGrant,
  disconnectGrant,
  projectionToSnapshot,
  setClientFactoryForTests,
  resetForTests,
  withLiveRefresh,
  refreshOnResume,
  setGrantTimingForTests,
  grantedCapabilities,
  type PendingPairing,
} from './contacts-grant.js'

// Same in-memory localStorage stand-in as store.test.ts/session.test.ts —
// backs both `store.ts`'s blob and secure-key.ts's dev-only `SecretStore`
// (a different key namespace on the same global), so one stub covers the
// persisted pairing/snapshot AND the contacts app key.
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

const GRANT_ID = 'f'.repeat(32)
const DEVICE_ID = '2'.repeat(32)
const PK_KIN = 'a'.repeat(64)
const PK_NO_TIER = 'b'.repeat(64)
const PK_BLOCKED = 'c'.repeat(64)
const CONTACT_KIN = 'c'.repeat(32)
const CONTACT_NO_TIER = 'd'.repeat(32)
const CONTACT_BLOCKED = 'e'.repeat(32)

function projectionFixture(over: Partial<ContactProjectionV2> = {}): ContactProjectionV2 {
  return {
    v: 2,
    grantId: GRANT_ID,
    scopes: [...CONTACTS_CAPABILITIES],
    frontier: { maxClock: 1, opCount: 1, publishedAt: 1_700_000_000, deviceId: DEVICE_ID },
    // Final review B, finding I1: `issuedAt`/`expiresAt` are pinned to real
    // wall-clock time (not the fixed 1_700_000_000 the rest of this fixture
    // uses for frontier ordering) so the client's own validation
    // (`expiresAt - issuedAt` must stay under `pairing.maxStalenessSeconds`)
    // and its freshness check (`isFresh`: `nowSec <= expiresAt`, always
    // against real `Date.now()`, not a fake clock — see `maybePushSnapshot`'s
    // own doc comment) both see a genuinely fresh, valid window regardless of
    // when the suite runs. Tests that DO want a stale/expired projection
    // override both fields together, keeping the same short window.
    issuedAt: Math.floor(Date.now() / 1000),
    expiresAt: Math.floor(Date.now() / 1000) + 3600,
    contacts: [
      { contactId: CONTACT_KIN, identities: [{ pubkey: PK_KIN }], displayName: 'Ann', effectiveTier: 'kin' },
      { contactId: CONTACT_NO_TIER, identities: [{ pubkey: PK_NO_TIER }], displayName: 'Bo' },
      { contactId: CONTACT_BLOCKED, identities: [{ pubkey: PK_BLOCKED }], displayName: 'Cy', effectiveTier: 'ken', blocked: true },
    ] as ProjectedContact[],
    ...over,
  }
}

/** Seals+signs a real wire projection event (buildProjection/sealVaultPayload/
 *  projectionEventTemplate, all library builders) — a fake `RelayIo` hands
 *  this back so `client.fetchProjection` exercises the SDK's own real
 *  parse/decrypt/frontier logic, not a hand-rolled stand-in. */
async function signedProjectionEvent(
  railSk: Uint8Array, appPk: string, projection: ContactProjectionV2,
): Promise<SignedNostrEvent> {
  const plaintext = buildProjection(projection)
  const backend = { async nip44Encrypt(peer: string, pt: string) { return encrypt(pt, getConversationKey(railSk, peer)) } }
  const content = await sealVaultPayload(plaintext, backend, appPk)
  if (content === null) throw new Error('test setup: seal failed')
  const template = projectionEventTemplate(getPublicKey(railSk), projection.grantId, projection.frontier.publishedAt, content)
  return finalizeEvent(template, railSk) as unknown as SignedNostrEvent
}

/** A fake `RelayIo` that always answers `fetchNewest` with whatever the test
 *  last assigned — no live `subscribe`, so `client.start()` falls back to its
 *  poll timer alone (never fired in these tests; they call `fetchProjection`
 *  themselves via `startGrant`/`beginPairing`). */
function fakeRelay(get: () => SignedNostrEvent | null): RelayIo {
  return {
    async fetchNewest() { return get() },
    async publish() { return true },
  }
}

/** A fake `RelayIo` that ALSO supports live delivery (`subscribe`), wrapped
 *  through the module's own `withLiveRefresh` — the same wrapping
 *  `defaultClientFactory` applies to the real relay pool in production — so
 *  `fireLiveEvent` exercises the exact debounce path a real relay socket
 *  delivering a fresh projection would (fix round 1, finding 2). `get()`
 *  backs both the initial/poll `fetchNewest` calls AND whatever the
 *  debounced re-fetch triggered by a live event picks up; `fetchNewestCalls`
 *  counts every one of those, so a test can assert exactly how many
 *  ADDITIONAL fetches a live event or a poll tick produced. */
function fakeLiveRelay(get: () => SignedNostrEvent | null): {
  relay: RelayIo
  fireLiveEvent: (e: SignedNostrEvent) => void
  fetchNewestCalls: () => number
} {
  let onEvent: ((e: SignedNostrEvent) => void) | null = null
  let fetchNewestCalls = 0
  const relay: RelayIo = {
    async fetchNewest() {
      fetchNewestCalls++
      return get()
    },
    async publish() {
      return true
    },
    subscribe(_filter, _relays, cb) {
      onEvent = cb
      return () => {
        onEvent = null
      }
    },
  }
  return {
    relay: withLiveRefresh(relay),
    fireLiveEvent(e) {
      onEvent?.(e)
    },
    fetchNewestCalls: () => fetchNewestCalls,
  }
}

/** Fix round 2: a `fakeLiveRelay`-shaped `RelayIo` whose `fetchNewest` can
 *  also be paused mid-call — `armPause()` makes the very next `fetchNewest`
 *  await until the test calls `resolvePending()`, landing a
 *  `disconnectGrant()`/sign-out exactly inside `refreshGrant`'s or
 *  `activateGrant`'s in-flight `client.fetchProjection`, the race the
 *  re-review flagged. Still supports live delivery (`fireLiveEvent`,
 *  wrapped through `withLiveRefresh`) so a test can also confirm a stale
 *  activation never armed `client.start()`. */
function controlledLiveRelay(get: () => SignedNostrEvent | null): {
  relay: RelayIo
  armPause: () => void
  resolvePending: () => void
  fireLiveEvent: (e: SignedNostrEvent) => void
  fetchNewestCalls: () => number
} {
  let onEvent: ((e: SignedNostrEvent) => void) | null = null
  let calls = 0
  let paused = false
  let pendingResolve: (() => void) | null = null
  const relay: RelayIo = {
    async fetchNewest() {
      calls++
      if (paused) {
        paused = false
        await new Promise<void>((resolve) => {
          pendingResolve = resolve
        })
      }
      return get()
    },
    async publish() {
      return true
    },
    subscribe(_filter, _relays, cb) {
      onEvent = cb
      return () => {
        onEvent = null
      }
    },
  }
  return {
    relay: withLiveRefresh(relay),
    armPause() {
      paused = true
    },
    resolvePending() {
      const r = pendingResolve
      pendingResolve = null
      r?.()
    },
    fireLiveEvent(e) {
      onEvent?.(e)
    },
    fetchNewestCalls: () => calls,
  }
}

function fakeStorage(): StorageIo {
  const map = new Map<string, string>()
  return {
    async get(key) { return map.get(key) ?? null },
    async set(key, value) { map.set(key, value) },
  }
}

function localSignerFor(sk: Uint8Array): ContactsSigner {
  const pk = getPublicKey(sk)
  return {
    pubkey: pk,
    async signEvent(t) { return finalizeEvent({ kind: t.kind, created_at: t.created_at, tags: t.tags, content: t.content }, sk) },
    async nip44Encrypt(peer, pt) { return encrypt(pt, getConversationKey(sk, peer)) },
    async nip44Decrypt(peer, ct) { return decrypt(ct, getConversationKey(sk, peer)) },
  }
}

const createdClients: SignetContactsClient[] = []

/** Builds a `clientFactory`-shaped function over `relay`/`storage` — shared
 *  by every `startGrant` and live/poll-update test below, whichever `RelayIo`
 *  (a plain `fakeRelay`, or a `fakeLiveRelay` wrapped through
 *  `withLiveRefresh`) it is handed. */
function clientFactoryOver(appSk: Uint8Array, relay: RelayIo, storage: StorageIo): () => Promise<SignetContactsClient> {
  return async () => {
    const client = createSignetContactsClient({ signer: localSignerFor(appSk), relay, storage })
    createdClients.push(client)
    return client
  }
}

function validPairing(railPk: string, relayUrl = 'wss://relay.example.com'): PairingV2 {
  return {
    grantId: GRANT_ID,
    railPubkey: railPk,
    projectionTag: 'proj-tag',
    proposalTag: 'prop-tag',
    relay: relayUrl,
    grantedCapabilities: [...CONTACTS_CAPABILITIES],
    maxStalenessSeconds: 999_999,
    pairedAt: 1_700_000_000,
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage())
  sessionForTests(null)
})

afterEach(() => {
  for (const c of createdClients.splice(0)) c.stop()
  resetForTests()
  setClientFactoryForTests(null)
  setContactsSource(null)
  sessionForTests(null)
})

describe('projectionToSnapshot', () => {
  // Fix round 1, Minor: split from one multi-assert test ("maps identities to
  // pks, effectiveTier to tier, and the passed blocked set to Contact.
  // blocked") into one focused case per mapping, so a future break in one
  // pinpoints exactly which mapping broke rather than failing all of them at
  // once under a single assertion.
  it('top-level fresh/at come from the passed values, status is connected', async () => {
    const projection = parseProjection(buildProjection(projectionFixture()))
    const snap = projectionToSnapshot(projection, new Set(), true, 5000)
    expect(snap.status).toBe('connected')
    expect(snap.fresh).toBe(true)
    expect(snap.at).toBe(5000)
  })

  it('maps identities to pks and effectiveTier to tier for a normal contact', async () => {
    const projection = parseProjection(buildProjection(projectionFixture()))
    const snap = projectionToSnapshot(projection, new Set(), true, 5000)
    expect(snap.contacts).toContainEqual({ contactId: CONTACT_KIN, pks: [PK_KIN], name: 'Ann', tier: 'kin', blocked: false })
  })

  it('a contact with no effectiveTier maps to tier undefined', async () => {
    const projection = parseProjection(buildProjection(projectionFixture()))
    const snap = projectionToSnapshot(projection, new Set(), true, 5000)
    expect(snap.contacts).toContainEqual({ contactId: CONTACT_NO_TIER, pks: [PK_NO_TIER], name: 'Bo', tier: undefined, blocked: false })
  })

  it('a contact whose pk is in the passed blocked set maps to blocked: true', async () => {
    const projection = parseProjection(buildProjection(projectionFixture()))
    const snap = projectionToSnapshot(projection, new Set([PK_BLOCKED]), true, 5000)
    expect(snap.contacts).toContainEqual({ contactId: CONTACT_BLOCKED, pks: [PK_BLOCKED], name: 'Cy', tier: 'ken', blocked: true })
  })

  it('truncation is flagged', async () => {
    const projection = parseProjection(buildProjection(projectionFixture({ truncated: true })))
    const snap = projectionToSnapshot(projection, new Set(), true, 1)
    expect(snap.truncated).toBe(true)
  })

  it('no projection yet is status none', () => {
    expect(projectionToSnapshot(null, new Set(), false, 1)).toEqual({ status: 'none', contacts: [], fresh: false, at: 1 })
  })

  it('a revoked projection is disconnected with no contacts', async () => {
    const revoked = parseProjection(buildProjection(projectionFixture({ contacts: [], revoked: true })))
    const snap = projectionToSnapshot(revoked, new Set([PK_BLOCKED]), false, 9)
    expect(snap).toEqual({ status: 'disconnected', contacts: [], fresh: false, at: 9 })
  })
})

describe('contactsAppKey', () => {
  it('is created once and reused', async () => {
    const first = await contactsAppKey()
    const second = await contactsAppKey()
    expect(second.pk).toBe(first.pk)
    expect(second.sk).toEqual(first.sk)
    expect(first.pk).toMatch(/^[0-9a-f]{64}$/)
  })
})

describe('beginPairing', () => {
  function fakeClient(appPk: string): SignetContactsClient {
    // Reuses `createSignetContactsClient` for `buildPairingUri` (a real
    // wire builder, `buildPairingUriV2`, under the hood) — only
    // `awaitPairingAck` is short-circuited, since a real relay round-trip
    // (up to the SDK's own 120s default timeout) has no place in a unit test.
    const real = createSignetContactsClient({
      signer: { pubkey: appPk, async signEvent(t) { return finalizeEvent(t as never, new Uint8Array(32)) }, async nip44Encrypt() { return '' }, async nip44Decrypt() { return '' } },
      relay: { async fetchNewest() { return null }, async publish() { return true } },
    })
    return { ...real, async awaitPairingAck() { return null } }
  }

  it('the URI parses with parsePairingRequestV2: appPubkey, capabilities and directory', async () => {
    const { pk } = await contactsAppKey()
    setClientFactoryForTests(() => Promise.resolve(fakeClient(pk)))
    sessionForTests({ identityPk: 'd'.repeat(64), phoneSkHex: '1'.repeat(64), dependant: false })

    const { uri, wait } = await beginPairing()
    const { request } = parsePairingRequestV2(uri)
    expect(request).not.toBeNull()
    expect(request!.appPubkey).toBe(pk)
    expect(request!.capabilities).toEqual([...CONTACTS_CAPABILITIES])
    expect(request!.directory).toBe('owner')
    expect(await wait).toBe(false)
  })

  it('directory is dependant for a dependant session', async () => {
    const { pk } = await contactsAppKey()
    setClientFactoryForTests(() => Promise.resolve(fakeClient(pk)))
    sessionForTests({ identityPk: 'd'.repeat(64), phoneSkHex: '1'.repeat(64), dependant: true })

    const { uri, wait } = await beginPairing()
    const { request } = parsePairingRequestV2(uri)
    expect(request!.directory).toBe('dependant')
    expect(await wait).toBe(false)
  })

  /** A `fakeClient`-shaped client whose `awaitPairingAck` never resolves on
   *  its own — `resolveAck` settles it manually, and `signalRef.current`
   *  captures the `AbortSignal` `beginPairing` passed in, so a test can
   *  assert it was aborted. */
  function controllablePairingClient(appPk: string): {
    client: SignetContactsClient
    resolveAck: (p: PairingV2 | null) => void
    signalRef: { current?: AbortSignal }
  } {
    const real = createSignetContactsClient({
      signer: { pubkey: appPk, async signEvent(t) { return finalizeEvent(t as never, new Uint8Array(32)) }, async nip44Encrypt() { return '' }, async nip44Decrypt() { return '' } },
      relay: { async fetchNewest() { return null }, async publish() { return true } },
    })
    const signalRef: { current?: AbortSignal } = {}
    let resolveFn: ((p: PairingV2 | null) => void) | null = null
    const pending = new Promise<PairingV2 | null>((resolve) => { resolveFn = resolve })
    const client: SignetContactsClient = {
      ...real,
      async awaitPairingAck(opts) {
        signalRef.current = opts.signal
        return pending
      },
    }
    return { client, resolveAck: (p) => resolveFn!(p), signalRef }
  }

  it('final review B, minor 1: the ack is aborted once a different identity is signed in, and never stored/activated', async () => {
    const { pk } = await contactsAppKey()
    const { client, resolveAck, signalRef } = controllablePairingClient(pk)
    setClientFactoryForTests(() => Promise.resolve(client))
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: '1'.repeat(64), dependant: false })

    const { wait } = await beginPairing()
    expect(signalRef.current).toBeDefined()
    expect(signalRef.current!.aborted).toBe(false)

    // A signs out, B signs in — any store-touching event after B's own
    // sign-in (in production, `session.startSession()`'s own persistence)
    // reaches this module's session watch.
    sessionForTests({ identityPk: 'b'.repeat(64), phoneSkHex: '2'.repeat(64), dependant: false })
    store.notify()

    expect(signalRef.current!.aborted).toBe(true)

    // Even if A's stale ack still "arrives" regardless (the SDK itself
    // resolves an aborted `awaitPairingAck` to null on its own — this
    // simulates the worst case, a stale ack the abort didn't stop in time):
    // this module's own re-check after the await is the last line of
    // defence.
    resolveAck(validPairing('c'.repeat(64)))
    expect(await wait).toBe(false)
    expect(store.load().contactsPairing).toBeUndefined()
  })

  // The SDK's default wait (600s) spans the link's 300s plus the stored
  // ack's 300s; passing our own shorter timeout would halve that window.
  it('leaves awaitPairingAck on the SDK default wait (no timeoutMs override)', async () => {
    const { pk } = await contactsAppKey()
    let seenTimeoutMs: number | undefined
    const real = createSignetContactsClient({
      signer: { pubkey: pk, async signEvent(t) { return finalizeEvent(t as never, new Uint8Array(32)) }, async nip44Encrypt() { return '' }, async nip44Decrypt() { return '' } },
      relay: { async fetchNewest() { return null }, async publish() { return true } },
    })
    const client: SignetContactsClient = {
      ...real,
      async awaitPairingAck(opts) {
        seenTimeoutMs = opts.timeoutMs
        return null
      },
    }
    setClientFactoryForTests(() => Promise.resolve(client))
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: '1'.repeat(64), dependant: false })

    const { wait } = await beginPairing()
    await wait
    expect(seenTimeoutMs).toBeUndefined()
  })

  // ---------------------------------------------------------------------
  // Pairing verification code (security MUST — signet-contacts docs/
  // WIRE.md §"Pairing verification code (B1, F1)"). My Signet re-pinned to
  // fd321b3 adding this: once `awaitPairingAck` resolves, the pairing must
  // not be persisted, fetched, or started until the person confirms the
  // code matches what My Signet shows.
  // ---------------------------------------------------------------------

  /** A `fakeClient`-shaped client whose `awaitPairingAck` resolves
   *  immediately with `pairing` — spies on `load`/`fetchProjection`/`start`
   *  so a test can assert none of them ran before `confirm()`. */
  function ackImmediatelyClient(appPk: string, pairing: PairingV2): SignetContactsClient {
    const real = createSignetContactsClient({
      signer: { pubkey: appPk, async signEvent(t) { return finalizeEvent(t as never, new Uint8Array(32)) }, async nip44Encrypt() { return '' }, async nip44Decrypt() { return '' } },
      relay: { async fetchNewest() { return null }, async publish() { return true } },
    })
    return { ...real, async awaitPairingAck() { return pairing } }
  }

  it('security MUST: the shown code matches the library\'s own pairingCode, and nothing is persisted/fetched/started before confirm()', async () => {
    const { pk: appPk } = await contactsAppKey()
    const railPk = getPublicKey(generateSecretKey())
    const pairing = validPairing(railPk)
    const client = ackImmediatelyClient(appPk, pairing)
    const loadSpy = vi.spyOn(client, 'load')
    const fetchSpy = vi.spyOn(client, 'fetchProjection')
    const startSpy = vi.spyOn(client, 'start')
    setClientFactoryForTests(() => Promise.resolve(client))
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: '1'.repeat(64), dependant: false })

    const { uri, wait } = await beginPairing()
    const { request } = parsePairingRequestV2(uri)
    const result = await wait
    expect(result).not.toBe(false)
    const pending = result as PendingPairing

    const expectedCode = formatPairingCode(
      pairingCode({ appPubkey: appPk, challenge: request!.challenge, grantId: pairing.grantId, railPubkey: pairing.railPubkey }),
    )
    expect(pending.code).toBe(expectedCode)

    // Not persisted, fetched, or started yet.
    expect(store.load().contactsPairing).toBeUndefined()
    expect(loadSpy).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(startSpy).not.toHaveBeenCalled()

    await pending.confirm()

    // "My Signet says it matches — Continue": now persisted and activated.
    expect(store.load().contactsPairing).toEqual(pairing)
    expect(loadSpy).toHaveBeenCalledWith(pairing.grantId)
    expect(fetchSpy).toHaveBeenCalled()
    expect(startSpy).toHaveBeenCalled()
  })

  it('a pairing code is shown for every ack, never skipped', async () => {
    const { pk: appPk } = await contactsAppKey()
    for (const railPk of [getPublicKey(generateSecretKey()), getPublicKey(generateSecretKey())]) {
      const pairing = validPairing(railPk)
      setClientFactoryForTests(() => Promise.resolve(ackImmediatelyClient(appPk, pairing)))
      sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: '1'.repeat(64), dependant: false })
      const { wait } = await beginPairing()
      const result = await wait
      expect(result).not.toBe(false)
      expect((result as PendingPairing).code).toMatch(/^\d{3} \d{3}$/)
    }
  })

  it("cancel discards without ever persisting; a fresh beginPairing mints a new challenge", async () => {
    const { pk: appPk } = await contactsAppKey()
    const railPk = getPublicKey(generateSecretKey())
    const pairing = validPairing(railPk)
    const client = ackImmediatelyClient(appPk, pairing)
    setClientFactoryForTests(() => Promise.resolve(client))
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: '1'.repeat(64), dependant: false })

    const first = await beginPairing()
    const firstChallenge = parsePairingRequestV2(first.uri).request!.challenge
    const firstResult = await first.wait
    expect(firstResult).not.toBe(false)
    ;(firstResult as PendingPairing).cancel()
    expect(store.load().contactsPairing).toBeUndefined()

    // Confirming after cancel is a no-op — the pairing was already discarded.
    await (firstResult as PendingPairing).confirm()
    expect(store.load().contactsPairing).toBeUndefined()

    const second = await beginPairing()
    const secondChallenge = parsePairingRequestV2(second.uri).request!.challenge
    expect(secondChallenge).not.toBe(firstChallenge)
  })

  it('sign-out while the code is showing discards it — confirm() becomes a no-op (reuses the session-watch/generation guards)', async () => {
    const { pk: appPk } = await contactsAppKey()
    const railPk = getPublicKey(generateSecretKey())
    const pairing = validPairing(railPk)
    const client = ackImmediatelyClient(appPk, pairing)
    setClientFactoryForTests(() => Promise.resolve(client))
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: '1'.repeat(64), dependant: false })

    const { wait } = await beginPairing()
    const result = await wait
    expect(result).not.toBe(false)

    // Sign-out (identity change) while the code is on screen, before Continue.
    sessionForTests(null)
    store.notify()

    await (result as PendingPairing).confirm()
    expect(store.load().contactsPairing).toBeUndefined()
  })
})

describe('grantedCapabilities', () => {
  it('is null when this device has never paired', () => {
    expect(grantedCapabilities()).toBeNull()
  })

  it("returns the stored pairing's granted capabilities — narrower than requested when My Signet left a box unticked", () => {
    const railPk = getPublicKey(generateSecretKey())
    const narrowed = { ...validPairing(railPk), grantedCapabilities: ['signet.contacts.read:directory'] }
    store.update((p) => { p.contactsPairing = narrowed })
    expect(grantedCapabilities()).toEqual(['signet.contacts.read:directory'])
  })
})

describe('startGrant', () => {
  it('a restart reloads store.contactsSnapshot before any fetch completes', async () => {
    const persisted = { status: 'connected' as const, contacts: [{ contactId: CONTACT_KIN, pks: [PK_KIN], name: 'Ann', tier: 'kin' as const, blocked: false }], fresh: false, at: 1234 }
    store.update((p) => { p.contactsSnapshot = persisted })
    // No pairing stored — startGrant installs the source and returns early,
    // but the source must already show the persisted snapshot synchronously.
    const done = startGrant()
    expect(snapshot()).toEqual(persisted)
    await done
    expect(snapshot()).toEqual(persisted)
  })

  it('fetches the projection and maps tiers/blocked through to the contacts snapshot', async () => {
    const railSk = generateSecretKey()
    const railPk = getPublicKey(railSk)
    const { sk: appSk, pk: appPk } = await contactsAppKey()

    let event: SignedNostrEvent | null = await signedProjectionEvent(railSk, appPk, projectionFixture())
    const sharedStorage = fakeStorage()
    setClientFactoryForTests(clientFactoryOver(appSk, fakeRelay(() => event), sharedStorage))

    store.update((p) => { p.contactsPairing = validPairing(railPk) })
    await startGrant()

    const snap = snapshot()
    expect(snap.status).toBe('connected')
    const byId = Object.fromEntries(snap.contacts.map((c) => [c.contactId, c]))
    expect(byId[CONTACT_KIN]).toMatchObject({ pks: [PK_KIN], tier: 'kin', blocked: false })
    expect(byId[CONTACT_BLOCKED]).toMatchObject({ pks: [PK_BLOCKED], tier: 'ken', blocked: true })
    expect(store.load().contactsSnapshot?.status).toBe('connected')
  })

  it('a revocation flips the snapshot to disconnected/empty while the client keeps the blocked set', async () => {
    const railSk = generateSecretKey()
    const railPk = getPublicKey(railSk)
    const { sk: appSk, pk: appPk } = await contactsAppKey()
    const sharedStorage = fakeStorage()

    let event: SignedNostrEvent | null = await signedProjectionEvent(railSk, appPk, projectionFixture())
    setClientFactoryForTests(clientFactoryOver(appSk, fakeRelay(() => event), sharedStorage))
    store.update((p) => { p.contactsPairing = validPairing(railPk) })

    // "Restart" 1: first fetch picks up the blocked contact.
    await startGrant()
    expect(snapshot().status).toBe('connected')
    expect(snapshot().contacts.some((c) => c.blocked)).toBe(true)

    // A newer, revoked projection arrives (frontier strictly newer).
    const revokedProjection = projectionFixture({
      contacts: [],
      revoked: true,
      frontier: { maxClock: 2, opCount: 2, publishedAt: 1_700_000_100, deviceId: DEVICE_ID },
    })
    event = await signedProjectionEvent(railSk, appPk, revokedProjection)

    // "Restart" 2: a brand new client instance, backed by the SAME shared
    // storage, reloads and fetches the revocation.
    await startGrant()

    expect(snapshot()).toMatchObject({ status: 'disconnected', contacts: [] })

    // The blocked set is the signet-contacts client's own sticky state
    // (survives the revocation) — verified on the client instance that
    // just handled it, per this module's own doc comment on `activateGrant`.
    const lastClient = createdClients[createdClients.length - 1]!
    expect(lastClient.getBlockedSet().has(PK_BLOCKED)).toBe(true)
  })

  it('final review B, I1: an expired (not fresh) grant is reported disconnected, but keeps its last contacts for display', async () => {
    const railSk = generateSecretKey()
    const railPk = getPublicKey(railSk)
    const { sk: appSk, pk: appPk } = await contactsAppKey()
    const sharedStorage = fakeStorage()

    // A short, valid window (well under `maxStalenessSeconds`) that has
    // already elapsed — expired 100s ago, not a window the client's own
    // validation would reject outright.
    const nowSec = Math.floor(Date.now() / 1000)
    const expired = projectionFixture({ issuedAt: nowSec - 200, expiresAt: nowSec - 100 })
    const event: SignedNostrEvent | null = await signedProjectionEvent(railSk, appPk, expired)
    setClientFactoryForTests(clientFactoryOver(appSk, fakeRelay(() => event), sharedStorage))
    store.update((p) => { p.contactsPairing = validPairing(railPk) })

    let seen: { next: ContactsSnapshot; prev: ContactsSnapshot } | null = null
    onContactsUpdate((next, prev) => { seen = { next, prev } })

    await startGrant()

    expect(snapshot().status).toBe('disconnected')
    // The last-known contacts are kept for display, not wiped — only the
    // reported status degrades.
    expect(snapshot().contacts.some((c) => c.contactId === CONTACT_KIN)).toBe(true)
    // Nobody is auto-removed over a staleness signal: `classifyUpdate`
    // treats a non-`'connected'` status as `unknown`.
    expect(seen).not.toBeNull()
    expect(classifyUpdate(seen!.prev, seen!.next, [PK_KIN]).unknown).toBe(true)
  })

  it('final review B, I1: an emptied grant (no revocation) after previously non-empty is also reported disconnected; nobody is auto-removed', async () => {
    const railSk = generateSecretKey()
    const railPk = getPublicKey(railSk)
    const { sk: appSk, pk: appPk } = await contactsAppKey()
    const sharedStorage = fakeStorage()

    let event: SignedNostrEvent | null = await signedProjectionEvent(railSk, appPk, projectionFixture())
    setClientFactoryForTests(clientFactoryOver(appSk, fakeRelay(() => event), sharedStorage))
    store.update((p) => { p.contactsPairing = validPairing(railPk) })

    await startGrant()
    expect(snapshot().status).toBe('connected')
    expect(snapshot().contacts.length).toBeGreaterThan(0)

    const emptied = projectionFixture({
      contacts: [],
      frontier: { maxClock: 2, opCount: 2, publishedAt: 1_700_000_100, deviceId: DEVICE_ID },
    })
    event = await signedProjectionEvent(railSk, appPk, emptied)

    let seen: { next: ContactsSnapshot; prev: ContactsSnapshot } | null = null
    onContactsUpdate((next, prev) => { seen = { next, prev } })

    // A "restart" (a fresh client instance over the same shared storage),
    // same pattern as the revocation test above — picks up the emptied
    // projection without ever seeing a `revoked: true` flag.
    await startGrant()

    expect(snapshot()).toMatchObject({ status: 'disconnected', contacts: [] })
    expect(seen).not.toBeNull()
    expect(classifyUpdate(seen!.prev, seen!.next, [PK_KIN]).unknown).toBe(true)
  })

  it('final small-fixes round: an emptied grant stays disconnected across a repeated, unchanged empty poll; a later non-empty poll reconnects', async () => {
    const railSk = generateSecretKey()
    const railPk = getPublicKey(railSk)
    const { sk: appSk, pk: appPk } = await contactsAppKey()
    const sharedStorage = fakeStorage()

    let event: SignedNostrEvent | null = await signedProjectionEvent(railSk, appPk, projectionFixture())
    setClientFactoryForTests(clientFactoryOver(appSk, fakeRelay(() => event), sharedStorage))
    store.update((p) => { p.contactsPairing = validPairing(railPk) })

    await startGrant()
    expect(snapshot().status).toBe('connected')
    expect(snapshot().contacts.length).toBeGreaterThan(0)

    // Poll 1: the grant empties out (no revocation) — reported disconnected,
    // same as the sibling test above.
    event = await signedProjectionEvent(railSk, appPk, projectionFixture({
      contacts: [],
      frontier: { maxClock: 2, opCount: 2, publishedAt: 1_700_000_100, deviceId: DEVICE_ID },
    }))
    await startGrant()
    expect(snapshot()).toMatchObject({ status: 'disconnected', contacts: [] })

    // Poll 2: the SAME (still empty) projection, just a newer frontier — the
    // bug this fix closes. The old `degradeIfStaleOrEmptied` compared the
    // freshly recomputed `raw` against `source.current()`, which by now is
    // poll 1's own already-degraded `{status:'disconnected', contacts:[]}` —
    // so `prev.contacts.length` read 0, `emptiedOut` came out false, and an
    // unrelated `raw.status` of `'connected'` (computed from the live,
    // non-revoked-but-empty projection) got pushed straight through: the
    // banner would disappear and the You tab would revert to "Connected — 0
    // contacts" after exactly one poll. Must still be disconnected here.
    event = await signedProjectionEvent(railSk, appPk, projectionFixture({
      contacts: [],
      frontier: { maxClock: 3, opCount: 3, publishedAt: 1_700_000_200, deviceId: DEVICE_ID },
    }))
    await startGrant()
    expect(snapshot()).toMatchObject({ status: 'disconnected', contacts: [] })

    // Poll 3: a real non-empty projection arrives — reconnects.
    event = await signedProjectionEvent(railSk, appPk, projectionFixture({
      frontier: { maxClock: 4, opCount: 4, publishedAt: 1_700_000_300, deviceId: DEVICE_ID },
    }))
    await startGrant()
    expect(snapshot().status).toBe('connected')
    expect(snapshot().contacts.length).toBeGreaterThan(0)
  })

  it('disconnectGrant forgets the pairing locally and drops the snapshot to none', async () => {
    const railSk = generateSecretKey()
    const railPk = getPublicKey(railSk)
    const { sk: appSk, pk: appPk } = await contactsAppKey()
    const event = await signedProjectionEvent(railSk, appPk, projectionFixture())
    setClientFactoryForTests(clientFactoryOver(appSk, fakeRelay(() => event), fakeStorage()))
    store.update((p) => { p.contactsPairing = validPairing(railPk) })

    await startGrant()
    expect(snapshot().status).toBe('connected')

    disconnectGrant()

    expect(snapshot()).toEqual({ status: 'none', contacts: [], fresh: false, at: 0 })
    expect(store.load().contactsPairing).toBeUndefined()
  })
})

// Fix round 1, finding 2: a live or polled non-revocation projection update
// used to update the client's own internal state silently, with contacts.ts's
// subscribers never told — see contacts-grant.ts's own module-header note on
// `withLiveRefresh`/`GRANT_POLL_MS`/`refreshOnResume`.
describe('live/poll updates reach subscribers (fix round 1, finding 2)', () => {
  // Real (shrunk) timings, not `vi.useFakeTimers()` — this module's re-fetch
  // chain (`fetchProjection` → the SDK's own `ingestQueue`-chained decrypt/
  // verify/persist steps) is deep enough that `vi.advanceTimersByTimeAsync`
  // does not reliably flush every microtask hop before returning (confirmed
  // empirically while writing these tests: intermittent failures under fake
  // timers that never reproduced under real ones, across dozens of runs).
  // Real timers shrunk to a few/tens of ms keep these both deterministic AND
  // fast; production always runs the real `LIVE_DEBOUNCE_MS`/`GRANT_POLL_MS`.
  //
  // Deflake (test(contacts): deflake grant timing tests): a real 20ms timer
  // is still a REAL wall-clock wait, and under a full-suite run (many other
  // test files' work competing for the CPU) it can take much longer than
  // 20ms of wall-clock time to actually fire — these tests used to follow
  // `fireLiveEvent`/`refreshOnResume` with a fixed `sleep(N)` and then assert
  // the fetch/notification had already happened, which is exactly the
  // pattern that goes intermittently flaky under load (passes alone, where
  // nothing else contends for the CPU). Fixed below by polling for the
  // actual awaited condition with `vi.waitFor` (generous timeout, short
  // interval) instead of guessing a sleep long enough to survive contention;
  // where the assertion is negative ("nothing happened") — which `vi.waitFor`
  // can't express — a positive proxy is polled first, then a widened (but
  // now much smaller, load-insensitive) fixed buffer covers the remaining
  // settle time.
  const DEBOUNCE_MS = 20
  const POLL_MS = 20
  // Each test sets ONLY the one of these two it actually exercises to a real
  // (small) value, leaving the other at this large a no-op — the debounce
  // and poll timers are independent, and a debounce-focused test's own short
  // sleep must not ALSO catch an unrelated poll tick (and vice versa).
  const DISABLED_MS = 10_000

  afterEach(() => {
    setGrantTimingForTests(null)
  })

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /** A newer, `CONTACT_KIN`-only projection at tier `kith` instead of `kin` —
   *  used by every test below to exercise "the tier subscribers see actually
   *  changed" without dragging the other two fixture contacts along. */
  function kithProjection(publishedAt: number): ContactProjectionV2 {
    return projectionFixture({
      contacts: [{ contactId: CONTACT_KIN, identities: [{ pubkey: PK_KIN }], displayName: 'Ann', effectiveTier: 'kith' }] as ProjectedContact[],
      frontier: { maxClock: 2, opCount: 2, publishedAt, deviceId: DEVICE_ID },
    })
  }

  it('a live event triggers exactly one debounced fetch; subscribers get (next, prev) with the new tier', async () => {
    setGrantTimingForTests({ debounceMs: DEBOUNCE_MS, pollMs: DISABLED_MS })
    const railSk = generateSecretKey()
    const railPk = getPublicKey(railSk)
    const { sk: appSk, pk: appPk } = await contactsAppKey()
    let event = await signedProjectionEvent(railSk, appPk, projectionFixture())
    const live = fakeLiveRelay(() => event)
    setClientFactoryForTests(clientFactoryOver(appSk, live.relay, fakeStorage()))
    store.update((p) => { p.contactsPairing = validPairing(railPk) })

    await startGrant()
    expect(snapshot().contacts.find((c) => c.contactId === CONTACT_KIN)?.tier).toBe('kin')
    const callsBefore = live.fetchNewestCalls()

    event = await signedProjectionEvent(railSk, appPk, kithProjection(1_700_000_100))
    const seen: Array<[ContactsSnapshot, ContactsSnapshot]> = []
    const unsub = onContactsUpdate((next, prev) => seen.push([next, prev]))

    live.fireLiveEvent(event)
    // Debounced — no fetch yet, no notification yet. Synchronous with the
    // line above (no `await` between them), so this is never a race against
    // the real debounce timer, however loaded the system is.
    expect(live.fetchNewestCalls()).toBe(callsBefore)
    expect(seen).toHaveLength(0)

    // Polled rather than a fixed sleep (fix: full-suite runs shrink the CPU
    // this test actually gets, so a fixed `sleep(DEBOUNCE_MS * 4)` sometimes
    // elapsed before the real (shrunk) debounce timer got scheduled at all —
    // `vi.waitFor` just keeps retrying until it's true, so a slow scheduler
    // costs time, not a spurious failure).
    await vi.waitFor(() => {
      expect(live.fetchNewestCalls()).toBe(callsBefore + 1)
      expect(seen).toHaveLength(1)
    }, { timeout: 2000, interval: 5 })

    const [next, prev] = seen[0]!
    expect(prev.contacts.find((c) => c.contactId === CONTACT_KIN)?.tier).toBe('kin')
    expect(next.contacts.find((c) => c.contactId === CONTACT_KIN)?.tier).toBe('kith')
    unsub()
  })

  it('an unchanged projection produces no subscriber notification', async () => {
    setGrantTimingForTests({ debounceMs: DEBOUNCE_MS, pollMs: DISABLED_MS })
    const railSk = generateSecretKey()
    const railPk = getPublicKey(railSk)
    const { sk: appSk, pk: appPk } = await contactsAppKey()
    let event = await signedProjectionEvent(railSk, appPk, projectionFixture())
    const live = fakeLiveRelay(() => event)
    setClientFactoryForTests(clientFactoryOver(appSk, live.relay, fakeStorage()))
    store.update((p) => { p.contactsPairing = validPairing(railPk) })

    await startGrant()
    const callsBefore = live.fetchNewestCalls()

    // Same content, only the frontier is newer — a real "nothing actually
    // changed" republish/heartbeat.
    event = await signedProjectionEvent(railSk, appPk, projectionFixture({
      frontier: { maxClock: 2, opCount: 2, publishedAt: 1_700_000_100, deviceId: DEVICE_ID },
    }))
    const seen: unknown[] = []
    const unsub = onContactsUpdate((next) => seen.push(next))

    live.fireLiveEvent(event)
    // The debounce timer firing (and the fetch starting) is the slow, load-
    // sensitive part — poll for it rather than racing a fixed sleep (see the
    // previous test's own comment). "No notification" itself can't be
    // polled for (there's nothing to poll toward), so once the fetch is
    // confirmed under way, a fixed settle buffer covers the rest of the
    // chain (decrypt/compare) — much shorter and less load-sensitive than
    // waiting on the debounce timer itself, and widened well past the old
    // combined sleep.
    await vi.waitFor(() => {
      expect(live.fetchNewestCalls()).toBe(callsBefore + 1) // the fetch DID happen...
    }, { timeout: 2000, interval: 5 })
    await sleep(DEBOUNCE_MS * 10)

    expect(seen).toHaveLength(0) // ...but nothing changed, so no notification.
    unsub()
  })

  it('the 60s poll delivers an update when no live event ever arrives', async () => {
    setGrantTimingForTests({ debounceMs: DISABLED_MS, pollMs: POLL_MS })
    const railSk = generateSecretKey()
    const railPk = getPublicKey(railSk)
    const { sk: appSk, pk: appPk } = await contactsAppKey()
    let event = await signedProjectionEvent(railSk, appPk, projectionFixture())
    // Plain fakeRelay — no `subscribe` at all, so ONLY the poll (this
    // module's own, and/or the SDK's internal fallback) can ever notice
    // this update.
    setClientFactoryForTests(clientFactoryOver(appSk, fakeRelay(() => event), fakeStorage()))
    store.update((p) => { p.contactsPairing = validPairing(railPk) })

    await startGrant()
    expect(snapshot().contacts.find((c) => c.contactId === CONTACT_KIN)?.tier).toBe('kin')

    event = await signedProjectionEvent(railSk, appPk, kithProjection(1_700_000_100))
    const seen: unknown[] = []
    const unsub = onContactsUpdate((next) => seen.push(next))

    await vi.waitFor(() => {
      expect(seen.length).toBeGreaterThanOrEqual(1)
      expect(snapshot().contacts.find((c) => c.contactId === CONTACT_KIN)?.tier).toBe('kith')
    }, { timeout: 3000, interval: 5 })
    unsub()
  })

  it('disconnectGrant stops the debounce and poll timers (and the live subscription)', async () => {
    setGrantTimingForTests({ debounceMs: DEBOUNCE_MS, pollMs: POLL_MS })
    const railSk = generateSecretKey()
    const railPk = getPublicKey(railSk)
    const { sk: appSk, pk: appPk } = await contactsAppKey()
    let event = await signedProjectionEvent(railSk, appPk, projectionFixture())
    const live = fakeLiveRelay(() => event)
    setClientFactoryForTests(clientFactoryOver(appSk, live.relay, fakeStorage()))
    store.update((p) => { p.contactsPairing = validPairing(railPk) })

    await startGrant()
    const callsBefore = live.fetchNewestCalls()

    disconnectGrant()
    expect(snapshot()).toEqual({ status: 'none', contacts: [], fresh: false, at: 0 })

    event = await signedProjectionEvent(railSk, appPk, kithProjection(1_700_000_100))
    live.fireLiveEvent(event) // the client's own stop() already tore the subscription down — this is a no-op
    await sleep(POLL_MS * 4) // several poll intervals, in case anything still fired

    expect(live.fetchNewestCalls()).toBe(callsBefore) // neither the debounce nor the poll fired again
    expect(snapshot()).toEqual({ status: 'none', contacts: [], fresh: false, at: 0 })
  })

  it('refreshOnResume re-fetches and delivers an update when a grant is live', async () => {
    const railSk = generateSecretKey()
    const railPk = getPublicKey(railSk)
    const { sk: appSk, pk: appPk } = await contactsAppKey()
    let event = await signedProjectionEvent(railSk, appPk, projectionFixture())
    setClientFactoryForTests(clientFactoryOver(appSk, fakeRelay(() => event), fakeStorage()))
    store.update((p) => { p.contactsPairing = validPairing(railPk) })

    await startGrant()
    event = await signedProjectionEvent(railSk, appPk, kithProjection(1_700_000_100))

    refreshOnResume()
    await vi.waitFor(() => {
      expect(snapshot().contacts.find((c) => c.contactId === CONTACT_KIN)?.tier).toBe('kith')
    }, { timeout: 2000, interval: 5 })
  })

  it('refreshOnResume is a no-op with no grant live', async () => {
    // No startGrant/beginPairing at all this test — nothing to refresh.
    expect(() => refreshOnResume()).not.toThrow()
    await sleep(DEBOUNCE_MS)
    expect(snapshot()).toEqual({ status: 'none', contacts: [], fresh: false, at: 0 })
  })
})

// Fix round 2: the re-review of fix round 1 found that `refreshGrant` and
// `activateGrant` each captured the live client/pairing before an `await`
// and pushed/armed unconditionally afterward — a `disconnectGrant()`/
// sign-out mid-await left the stale continuation free to resurrect the old
// snapshot and re-arm delivery on a runtime the app had just stopped. See
// contacts-grant.ts's own `runtimeGen` doc comment.
describe('stale in-flight refresh/activation dropped after disconnect or sign-out (fix round 2)', () => {
  const POLL_MS = 20

  afterEach(() => {
    setGrantTimingForTests(null)
  })

  function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  it('disconnect while a refresh fetch is pending leaves the empty snapshot in place, no subscriber sees the old contacts', async () => {
    const railSk = generateSecretKey()
    const railPk = getPublicKey(railSk)
    const { sk: appSk, pk: appPk } = await contactsAppKey()
    const event = await signedProjectionEvent(railSk, appPk, projectionFixture())
    const live = controlledLiveRelay(() => event)
    setClientFactoryForTests(clientFactoryOver(appSk, live.relay, fakeStorage()))
    store.update((p) => { p.contactsPairing = validPairing(railPk) })

    await startGrant() // the initial fetch is not paused
    expect(snapshot().status).toBe('connected')

    const seen: ContactsSnapshot[] = []
    const unsub = onContactsUpdate((next) => seen.push(next))

    live.armPause()
    refreshOnResume() // refreshGrant's client.fetchProjection is now paused mid-flight
    await sleep(0) // let the synchronous chain up to the pause reach it

    disconnectGrant()
    expect(snapshot()).toEqual({ status: 'none', contacts: [], fresh: false, at: 0 })
    expect(seen).toHaveLength(1)
    expect(seen[0]!.status).toBe('none')

    live.resolvePending() // the stale refresh's fetch finally "arrives"
    await sleep(0)

    // The stale continuation must not have overwritten the empty snapshot,
    // nor told any subscriber about the old (pre-disconnect) contacts.
    expect(snapshot()).toEqual({ status: 'none', contacts: [], fresh: false, at: 0 })
    expect(seen).toHaveLength(1)
    unsub()
  })

  it('sign-out while activation load/fetch is pending arms nothing afterwards: no stale push, no start(), no poll', async () => {
    setGrantTimingForTests({ debounceMs: POLL_MS, pollMs: POLL_MS })
    const railSk = generateSecretKey()
    const railPk = getPublicKey(railSk)
    const { sk: appSk, pk: appPk } = await contactsAppKey()
    const event = await signedProjectionEvent(railSk, appPk, projectionFixture())
    const live = controlledLiveRelay(() => event)
    setClientFactoryForTests(clientFactoryOver(appSk, live.relay, fakeStorage()))
    store.update((p) => { p.contactsPairing = validPairing(railPk) })

    live.armPause()
    const done = startGrant() // activateGrant's client.fetchProjection is now paused mid-flight
    await sleep(0) // let load() (storage) and the fetch call up to the pause settle

    // Sign-out: store.clear() wipes contactsPairing, firing ensureSource's
    // sign-out watch synchronously — `liveClient` is already set (activateGrant
    // sets it before its first await), so the watch's condition is met.
    store.clear()
    expect(snapshot()).toEqual({ status: 'none', contacts: [], fresh: false, at: 0 })

    live.resolvePending() // the stale activation's fetch finally "arrives"
    await done

    // No stale push, and nothing left running afterward: no live subscription
    // (client.start() never reached) and no poll timer (never armed either).
    expect(snapshot()).toEqual({ status: 'none', contacts: [], fresh: false, at: 0 })
    const callsAfterActivation = live.fetchNewestCalls()
    live.fireLiveEvent(await signedProjectionEvent(railSk, appPk, projectionFixture({
      frontier: { maxClock: 2, opCount: 2, publishedAt: 1_700_000_100, deviceId: DEVICE_ID },
    })))
    await sleep(POLL_MS * 4)
    expect(live.fetchNewestCalls()).toBe(callsAfterActivation)
    expect(snapshot()).toEqual({ status: 'none', contacts: [], fresh: false, at: 0 })
  })

  it('final review B, minor 2: a sign-out triggered synchronously by the activation push itself arms nothing afterwards on the stale client', async () => {
    const railSk = generateSecretKey()
    const railPk = getPublicKey(railSk)
    const { sk: appSk, pk: appPk } = await contactsAppKey()
    const event = await signedProjectionEvent(railSk, appPk, projectionFixture())

    // A custom factory (not `clientFactoryOver`) so this test can spy on
    // `start`/`onRevoked` the instant the client is built — before
    // `activateGrant` ever gets to call them.
    let spiedClient: SignetContactsClient | null = null
    setClientFactoryForTests(async () => {
      const client = createSignetContactsClient({ signer: localSignerFor(appSk), relay: fakeRelay(() => event), storage: fakeStorage() })
      createdClients.push(client)
      spiedClient = client
      vi.spyOn(client, 'start')
      vi.spyOn(client, 'onRevoked')
      return client
    })
    store.update((p) => { p.contactsPairing = validPairing(railPk) })

    // The fetch completes normally, so both EARLIER runtimeGen re-checks
    // (after `client.load`, after `client.fetchProjection`) pass clean. The
    // race is instead the THIRD window, right after `maybePushSnapshot`:
    // that push's own `store.update` notifies subscribers synchronously,
    // and the real sign-out watch (`ensureSource`'s) is one of them — a
    // `store.clear()` (an ordinary sign-out) landing exactly then, before
    // this activation ever reaches `client.onRevoked`/`client.start`/the
    // poll timer, is reproduced here by a subscriber that fires on the very
    // push this activation makes.
    let fired = false
    const unsub = store.subscribe(() => {
      if (!fired && store.load().contactsSnapshot?.status === 'connected') {
        fired = true
        store.clear()
      }
    })

    await startGrant()
    unsub()

    expect(snapshot()).toEqual({ status: 'none', contacts: [], fresh: false, at: 0 })
    expect(spiedClient).not.toBeNull()
    // Nothing left armed on the client the sign-out already stopped.
    expect(spiedClient!.start).not.toHaveBeenCalled()
    expect(spiedClient!.onRevoked).not.toHaveBeenCalled()
  })
})
