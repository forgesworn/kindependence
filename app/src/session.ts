// Signed-in session (Signet identity plan, Task 5): the device's link to a
// My Signet identity — the identity pubkey (the family/guardian's own key,
// living in My Signet, never on this device) plus this device's own local
// "phone key" (secure-key.ts), which an identity-signed device statement
// (device-statements.ts) authorises to send circle traffic on its behalf.
//
// Two signers this module hands out:
//  - `phoneSigner()` — the phone key, for phone-key circle traffic this
//    device's own device statement covers.
//  - `identitySigner()` — a `RemoteSigner` (remote-signer.ts) over the
//    identity's own live transport (NIP-46 via a My Signet bunker, or
//    NIP-55 for a signer app on this phone), for identity-signed structural
//    events (structural.ts) and the device statement itself. The transport
//    reconnects LAZILY: `restore()` on app start never reconnects eagerly —
//    only the first call that actually needs to sign pays that cost (see
//    `lazyTransport` below).
//
// Nothing this module persists via store.ts ever carries a secret: the
// phone key lives in `SecretStore` (secure-key.ts), and the NIP-46 bunker
// client secret — the client keypair reused on every reconnect, so a bunker
// that auto-approves one bound client pubkey per slot doesn't see a
// stranger each time — lives in the SAME `SecretStore`, under the name
// `bunker-client-sk`. `Persisted.session` (store.ts) holds only public
// material: the identity pubkey, the transport's own public descriptor
// (a bunker URI or a NIP-55 package name — neither is a secret), the phone
// pubkey, and this device's own signed device statement once one exists.

import { generateSecretKey } from 'nostr-tools/pure'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import type { Signer, SignedEvent } from '@forgesworn/roost-kit'
import { makeLocalSigner } from '@forgesworn/covey-kit'
import { createBunkerSigner } from 'signet-login'
import * as store from './store.js'
import { secretStore, loadOrCreatePhoneKey, forgetPhoneKey } from './secure-key.js'
import {
  RemoteSigner,
  GUARDIAN_APPROVAL_TIMEOUT_MS,
  transportFromSignetSigner,
  transportFromNip55,
  type SignerTransport,
} from './remote-signer.js'

export interface SessionInfo {
  identityPk: string
  dependant: boolean
  name: string
  transport: { kind: 'nip46'; bunkerUri: string } | { kind: 'nip55'; packageName: string }
  phonePk: string
  /** This device's own signed device statement, once one exists — absent
   *  until the identity signer has authorised this phone key. */
  statement?: SignedEvent
}

const BUNKER_CLIENT_SK_NAME = 'bunker-client-sk'
/** Task 11 fix round 1, finding 2: `Persisted.session.transport.bunkerUri`
 *  is written to `store.ts`'s plain-JSON localStorage blob — a NIP-46
 *  bunker URI's `secret` query param must never land there. The FULL URI
 *  (secret included) lives ONLY here, in `SecretStore`, under this name —
 *  My Signet's dependant app routes still check it on reconnect (a
 *  controller ruling, not a guess: signet-app's `useBunkerServer.ts`
 *  ~616-640), so it can't simply be dropped, only kept out of the plain
 *  store. `startSession` writes it (and the STRIPPED uri that's safe to
 *  persist) together; `reconnectInfo` below reads it back for a lazy
 *  reconnect; `signOut` removes it alongside `BUNKER_CLIENT_SK_NAME`. */
const BUNKER_URI_NAME = 'bunker-uri'

/** Strips a NIP-46 bunker URI's `secret` query param — see
 *  `BUNKER_URI_NAME`'s own doc comment for why. A URI with no query string
 *  (e.g. a test fixture's bare `bunker://test`) passes through unchanged.
 *  Rebuilt by filtering the raw `key=value` segments, rather than round-
 *  tripped through `URLSearchParams` — the latter re-percent-encodes every
 *  value (e.g. a `relay=wss://...` becomes `relay=wss%3A%2F%2F...`), which
 *  parses back to the same URI but needlessly changes what's stored. */
function stripBunkerSecret(uri: string): string {
  const qIndex = uri.indexOf('?')
  if (qIndex < 0) return uri
  const rest = uri.slice(qIndex + 1)
    .split('&')
    .filter((seg) => seg !== 'secret' && !seg.startsWith('secret='))
    .join('&')
  return rest ? `${uri.slice(0, qIndex)}?${rest}` : uri.slice(0, qIndex)
}

let session: SessionInfo | null = null
let phoneSkHex: string | null = null
let identityTransport: SignerTransport | null = null

/** Closes whatever identity transport is currently live, if any — a no-op
 *  `SignerTransport` that never actually connected (a `lazyTransport` no
 *  call has reached yet) closes for free, per its own `close()`. Shared by
 *  every place that's about to replace or drop `identityTransport`
 *  (`startSession`, `restore`'s replace path, `discardSession`,
 *  `signOut`) so none of them can leak the previous connection. */
async function closeLiveTransport(): Promise<void> {
  if (identityTransport) {
    await identityTransport.close().catch(() => {})
  }
}

/** Loads (or creates and persists) this device's persistent NIP-46 client
 *  key — the SAME key `defaultTransportFactory` below reuses on every
 *  reconnect (see this module's own doc comment). Exported so signin.ts's
 *  FIRST connect (`nostrconnect://` QR, or a pasted `bunker://` link) can
 *  present the identical client pubkey `restore()`'s own reconnect will use
 *  later, rather than each minting its own separate key. */
export async function bunkerClientSk(): Promise<Uint8Array> {
  const secrets = secretStore()
  let clientSkHex = await secrets.get(BUNKER_CLIENT_SK_NAME)
  if (!clientSkHex) {
    clientSkHex = bytesToHex(generateSecretKey())
    await secrets.set(BUNKER_CLIENT_SK_NAME, clientSkHex)
  }
  return hexToBytes(clientSkHex)
}

/** Builds the live transport for a session's own `transport` descriptor:
 *  reconnects a NIP-46 bunker with the SAME client keypair every time
 *  (generating and persisting one via `SecretStore` on first use — see this
 *  module's own doc comment), or builds a fresh NIP-55 transport (nothing
 *  to reconnect: each call is its own Android intent). Overridable for
 *  tests via `setTransportFactoryForTests`. */
async function defaultTransportFactory(info: SessionInfo): Promise<SignerTransport> {
  if (info.transport.kind === 'nip55') {
    return transportFromNip55(info.identityPk, info.transport.packageName)
  }
  const clientSk = await bunkerClientSk()
  const signer = await createBunkerSigner({
    uri: info.transport.bunkerUri,
    clientSecretKey: clientSk,
    appName: 'Kindependence',
    requestTimeoutMs: GUARDIAN_APPROVAL_TIMEOUT_MS,
  })
  return transportFromSignetSigner(signer)
}

let transportFactory = defaultTransportFactory

/** Test seam: replaces the factory `restore()`'s lazy reconnect (and any
 *  `identitySigner()` built off it) uses to turn a `SessionInfo` into a
 *  live transport. `null` restores the real, signet-login-backed default. */
export function setTransportFactoryForTests(
  f: ((info: SessionInfo) => Promise<SignerTransport>) | null,
): void {
  transportFactory = f ?? defaultTransportFactory
}

/** Resolves the `SessionInfo` a reconnect should actually use: for a NIP-46
 *  session, `info.transport.bunkerUri` is the STRIPPED uri (what's safe to
 *  have come back out of the persisted store — see `BUNKER_URI_NAME`'s own
 *  doc comment); the full uri a reconnect needs lives only in `SecretStore`,
 *  written alongside the session by `startSession`. Falls back to the
 *  stripped uri if that entry is somehow gone (defensive only — the two are
 *  always written together, so a reconnect degrades rather than throwing).
 *  NIP-55 has no bunker uri at all — passed through unchanged. */
async function reconnectInfo(info: SessionInfo): Promise<SessionInfo> {
  if (info.transport.kind !== 'nip46') return info
  const full = await secretStore().get(BUNKER_URI_NAME)
  if (!full) return info
  return { ...info, transport: { kind: 'nip46', bunkerUri: full } }
}

/** A `SignerTransport` that defers connecting until its first real call —
 *  `restore()` builds one of these rather than reconnecting eagerly on app
 *  start. Every call after the first shares the same in-flight/settled
 *  connect, so a burst of calls right after restore only connects once. */
function lazyTransport(info: SessionInfo): SignerTransport {
  let live: Promise<SignerTransport> | null = null
  const connect = (): Promise<SignerTransport> => {
    if (!live) {
      // Review fix round 1: a rejected connect must not be cached — a
      // signer that's briefly unreachable (asleep, relay hiccup) would
      // otherwise poison every later call with the same stale rejection
      // forever. Reset `live` back to null on rejection so the NEXT call
      // starts a fresh connect attempt; a settled (resolved) connect still
      // stays shared, per this function's own doc comment.
      live = reconnectInfo(info).then((full) => transportFactory(full)).catch((e: unknown) => {
        live = null
        throw e
      })
    }
    return live
  }
  return {
    pubkey: info.identityPk,
    async signEvent(t, o) {
      return (await connect()).signEvent(t, o)
    },
    async nip44Encrypt(peer, pt, o) {
      return (await connect()).nip44Encrypt(peer, pt, o)
    },
    async nip44Decrypt(peer, ct, o) {
      return (await connect()).nip44Decrypt(peer, ct, o)
    },
    async close() {
      if (!live) return
      const t = await live
      live = null
      await t.close()
    },
  }
}

/** The current session, or `null` if signed out. */
export function currentSession(): SessionInfo | null {
  return session
}

/** This device's own phone-key signer. Throws if not signed in. */
export function phoneSigner(): Signer {
  if (!session || !phoneSkHex) throw new Error('not signed in')
  return makeLocalSigner(phoneSkHex)
}

/** A `RemoteSigner` over the identity's live transport — reconnects lazily
 *  after `restore()` (see `lazyTransport` above). Throws if not signed in.
 *  `opts.timeoutMs` overrides the signer deadline (final fix A7: the
 *  structural queue waits as long as My Signet keeps a request).
 *  `opts.interactive: false` is for work no one tapped for (unwrapping what
 *  a relay delivered): the signer is asked silently only, never brought to
 *  the front — see remote-signer.ts's `SignerCallOpts`. */
export function identitySigner(opts: { timeoutMs?: number; interactive?: boolean } = {}): Signer {
  if (!session || !identityTransport) throw new Error('not signed in')
  return new RemoteSigner(identityTransport, opts)
}

/** Starts a new session: creates (or loads) this device's phone key,
 *  persists the session — never a secret, see this module's own doc
 *  comment — and keeps `transport` (already connected by the caller's own
 *  sign-in flow) as the live identity transport for the rest of this run.
 *  For a NIP-46 `info`, the full bunker uri goes to `SecretStore` under
 *  `BUNKER_URI_NAME`; what's persisted on the session itself has its
 *  `secret` param stripped (fix round 1, finding 2 — see that constant's
 *  own doc comment).
 *
 *  Rejects (before touching any state) if `transport.pubkey` doesn't match
 *  `info.identityPk` — the caller connected to the wrong identity, and
 *  starting a session that claims one pubkey while signing through
 *  another's transport would silently misattribute every signature.
 *
 *  Order matters here (review fix round 2): `loadOrCreatePhoneKey()` runs
 *  BEFORE closing any already-live transport from a PRIOR session, not
 *  after. If it throws (e.g. `Error('phone key unreadable')`), a still-
 *  signed-in caller must be left exactly as it was — its old session and
 *  live transport both still usable — rather than having its transport
 *  closed out from under it while this call fails and the old session's
 *  module state is left pointing at a now-dead connection. Only once the
 *  phone key is safely in hand does this close the prior transport
 *  (review fix round 1 — replacing one live session with another must not
 *  leak the old connection) and swap in the new state. */
export async function startSession(
  info: Omit<SessionInfo, 'phonePk' | 'statement'>,
  transport: SignerTransport,
): Promise<SessionInfo> {
  if (transport.pubkey !== info.identityPk) {
    throw new Error('transport pubkey does not match the identity pubkey')
  }
  const phone = await loadOrCreatePhoneKey()
  await closeLiveTransport()
  // Fix round 1, finding 2: the full bunker uri (secret included) goes ONLY
  // to SecretStore; what's kept on `info`/persisted below has it stripped.
  let stored = info
  if (info.transport.kind === 'nip46') {
    await secretStore().set(BUNKER_URI_NAME, info.transport.bunkerUri)
    stored = { ...info, transport: { kind: 'nip46', bunkerUri: stripBunkerSecret(info.transport.bunkerUri) } }
  }
  const full: SessionInfo = { ...stored, phonePk: phone.pkHex }
  session = full
  phoneSkHex = phone.skHex
  identityTransport = transport
  store.update((p) => {
    p.session = full
  })
  return full
}

/** Records this device's own signed device statement once the identity
 *  signer has authorised it — called right after `startSession()` by
 *  signin.ts's `attemptSignIn`, once its own bare `RemoteSigner` over the
 *  just-connected transport has signed and verified
 *  `deviceStatementTemplate(...)` (see signin.ts's own module doc comment
 *  for why that's a bare `RemoteSigner`, not `identitySigner()`, during
 *  sign-in itself). `doInvite`/`beacons.postStatement` are no-ops until
 *  it's here (see this module's own doc comment). Updates both the
 *  in-memory session `currentSession()` returns and the persisted copy,
 *  same "both at once" discipline as `startSession`. Throws if not signed
 *  in. */
export function recordStatement(statement: SignedEvent): void {
  if (!session) throw new Error('not signed in')
  session = { ...session, statement }
  const full = session
  store.update((p) => {
    p.session = full
  })
}

/** Closes the live identity transport (if any — a no-op `SignerTransport`
 *  never connected, per `lazyTransport`'s own `close()`), clears every bit
 *  of "this session is live" state in memory, and — final fix A6 — wipes
 *  the WHOLE local store and the bunker secrets (`bunker-uri`,
 *  `bunker-client-sk`), same as `signOut()`: an orphaned identity's
 *  circles and seeds must never be inherited by whoever signs in next.
 *  Never throws — a secret that can't be removed must not stop `restore()`
 *  from reporting signed out. Shared tail of `restore()`'s two "this
 *  session can no longer be trusted" branches. */
async function discardSession(): Promise<void> {
  await closeLiveTransport()
  session = null
  phoneSkHex = null
  identityTransport = null
  store.clear()
  await secretStore().remove(BUNKER_CLIENT_SK_NAME).catch(() => {})
  await secretStore().remove(BUNKER_URI_NAME).catch(() => {})
}

/** Restores a session from the store on app start. Returns `null` if the
 *  persisted store holds no session.
 *
 *  Two ways this device's phone key can no longer back the persisted
 *  session — both ruled as signed out (review fix round 1 adds the
 *  second): the session is discarded and this returns `null` — the whole
 *  local store and the bunker secrets are wiped (final fix A6, see
 *  `discardSession`).
 *   - Unreadable (secure-key.ts's `loadOrCreatePhoneKey` throwing
 *     `Error('phone key unreadable')`): this device can't read its phone
 *     key. Final fix A6 (ruling 32): the undecryptable value is forgotten,
 *     so signing in again creates a new key.
 *   - Readable, but its `pkHex` doesn't match the persisted
 *     `session.phonePk`: the keystore entry behind the old session was
 *     lost (cleared, reinstalled, …) while the store blob survived, so
 *     `loadOrCreatePhoneKey` silently minted a FRESH key that has never
 *     been authorised by anything. Signing into the old session with it
 *     would send phone-key traffic under a device statement that was
 *     issued for a different key entirely — so this is signed out too,
 *     but the fresh key is real and kept (not forgotten) for whatever
 *     session starts next.
 *
 *  The identity transport itself is NOT reconnected here — see
 *  `lazyTransport`; only the first actual sign/encrypt call pays that
 *  cost. Closes any transport left live from an EARLIER `restore()` (or
 *  `startSession()`) call first (review fix round 1) — restoring twice
 *  must not leak a connection the first restore already made. */
export async function restore(): Promise<SessionInfo | null> {
  const p = store.load()
  if (!p.session) return null
  let phone: { skHex: string; pkHex: string }
  try {
    phone = await loadOrCreatePhoneKey()
  } catch (e) {
    if (e instanceof Error && e.message === 'phone key unreadable') {
      // Final fix A6 (ruling 32): the undecryptable value is forgotten, so
      // the next sign-in mints a new phone key instead of hitting this
      // same error forever.
      await forgetPhoneKey().catch(() => {})
      await discardSession()
      return null
    }
    throw e
  }
  if (phone.pkHex !== p.session.phonePk) {
    await discardSession()
    return null
  }
  await closeLiveTransport()
  session = p.session
  phoneSkHex = phone.skHex
  identityTransport = lazyTransport(p.session)
  return session
}

/** Signs out: closes the live identity transport, forgets this device's
 *  phone key AND its bunker client secret (review fix round 1 — a fresh
 *  sign-in mints its own new client keypair; keeping the old one around
 *  serves no purpose once its session is gone, and NIP-46 bunkers that
 *  bind approval to a client pubkey should see a clean slate), and clears
 *  the ENTIRE local store back to defaults — not just the session field
 *  (store.ts's `clear()`). Signing out of the identity drops every
 *  locally-cached family/circle record this device held under it; a later
 *  task re-syncs whatever's needed after a fresh sign-in.
 *
 *  `store.clear()` and the in-memory reset always run, in a `finally`
 *  (review fix round 1) — even if forgetting either secret throws (a
 *  native Keystore error, say), this device must still end up signed out
 *  locally rather than half-cleared. The throw (if any) still propagates
 *  after that cleanup, so a caller can surface "sign-out partially
 *  failed" rather than the failure being silently swallowed. */
export async function signOut(): Promise<void> {
  await closeLiveTransport()
  try {
    await forgetPhoneKey()
    await secretStore().remove(BUNKER_CLIENT_SK_NAME)
    await secretStore().remove(BUNKER_URI_NAME)
  } finally {
    store.clear()
    session = null
    phoneSkHex = null
    identityTransport = null
  }
}

/** Whether this code is running under the test runner (vitest sets both). */
function underTest(): boolean {
  if (import.meta.env?.MODE === 'test') return true
  const proc = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return !!proc?.env?.VITEST
}

/** Test seam: installs a live session in memory only (the store is left
 *  alone) — `phoneSkHex` becomes this device's phone key and `transport`
 *  (if given) the identity transport behind `identitySigner()`. `null`
 *  clears it. Throws outside the test runner: it would let any caller
 *  install a phone key and signer without signing in. */
export function sessionForTests(
  s: { identityPk: string; phoneSkHex: string; dependant?: boolean; statement?: SignedEvent; transport?: SignerTransport } | null,
): void {
  if (!underTest()) throw new Error('sessionForTests is only available under test')
  if (!s) {
    session = null
    phoneSkHex = null
    identityTransport = null
    return
  }
  const phonePk = makeLocalSigner(s.phoneSkHex).pubkey
  session = {
    identityPk: s.identityPk,
    dependant: s.dependant ?? false,
    name: 'Test',
    transport: { kind: 'nip46', bunkerUri: 'bunker://test' },
    phonePk,
    ...(s.statement ? { statement: s.statement } : {}),
  }
  phoneSkHex = s.phoneSkHex
  identityTransport = s.transport ?? null
}
