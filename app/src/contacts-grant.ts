// My Signet contacts v2 grant (plan 2, Task 2) — the ONLY module that talks
// to @forgesworn/signet-contacts. Everything else (contacts.ts, and whatever
// consumes it later) reads the pure snapshot/usable rules, fed from here via
// `setContactsSource`.
//
// Design decision 1 (plan 2): the grant's `appPubkey` is a fresh, LOCAL,
// per-device key (`SecretStore` name 'contacts-app-sk') — never the signed-in
// identity's own pubkey (session.ts's `currentSession().identityPk`, which
// lives in My Signet) and never this device's phone key (secure-key.ts). A
// projection is NIP-44-wrapped to this key, so decrypting it never needs a
// bunker round-trip: once paired, the grant is entirely local, which is why
// the client's own signer below is a plain local nostr-tools signer, not a
// `RemoteSigner`.
//
// Wire notes for whoever next touches the pin (see `docs/INTEGRATION.md` and
// `src/wire/types.ts` in the signet-contacts repo):
//  - `client.getBlockedSet()` is keyed by IDENTITY PUBKEY, not `contactId` —
//    `wire/state.ts`'s `blockedPubkeysOf` collects every `identities[].pubkey`
//    (and any legacy `linkedPubkeys`) off a projected contact whose own
//    `blocked` is true. `projectionToSnapshot` below therefore marks a
//    `Contact` blocked when ANY of its `pks` is in the passed-in set, never
//    by matching `contactId`.
//  - A contact's identity pubkeys live at `ProjectedContact.identities[].pubkey`
//    (an array — one real person can hold more than one identity key);
//    `contactId` itself is a grant-scoped opaque id, never a pubkey.

import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import { SimplePool } from 'nostr-tools/pool'
import { bytesToHex, hexToBytes } from '@noble/hashes/utils.js'
import {
  createSignetContactsClient,
  type ContactsSigner,
  type StorageIo,
  type PairingV2,
  type SignetContactsClient,
  type RelayIo,
} from '@forgesworn/signet-contacts'
import { createSimplePoolRelayIo } from '@forgesworn/signet-contacts/adapters/nostr-tools'
import { pairingCode, formatPairingCode } from '@forgesworn/signet-contacts/wire'
import { secretStore } from './secure-key.js'
import { currentSession } from './session.js'
import { appRelays } from './circles.js'
import * as store from './store.js'
import { setContactsSource, type Contact, type ContactsSnapshot, type ContactsSource, type Tier } from './contacts.js'

export const CONTACTS_CAPABILITIES = [
  'signet.contacts.read:directory',
  'signet.contacts.read:tier',
  'signet.contacts.blocks.read',
] as const

const APP_KEY_NAME = 'contacts-app-sk'
const APP_NAME = 'Kindependence'
const EMPTY_SNAPSHOT: ContactsSnapshot = { status: 'none', contacts: [], fresh: false, at: 0 }

// Fix round 1, finding 2: `client.start(pairing)` keeps its OWN internal
// state fresh from a live-delivered or polled projection (see this module's
// module-header wire notes and the SDK's own `client.d.ts` doc comment on
// `start`), but the only callback it ever surfaces to us is `onRevoked` — a
// live or polled non-revocation update updated the client's internal state
// silently, with `contacts.snapshot()`'s subscribers never told. Fixed by:
//  (1) `withLiveRefresh` wraps the `RelayIo` handed to the client so a live
//      delivery (its own `subscribe` callback) ALSO schedules a debounced
//      re-fetch on this module's side (below), instead of relying on the
//      client to tell us anything happened;
//  (2) a 60s poll of our own (`GRANT_POLL_MS`), independent of whatever
//      internal poll fallback `client.start()` runs, so a transport with no
//      `subscribe` at all (or a live delivery this module's wrapper somehow
//      missed) still gets noticed within a minute;
//  (3) a refresh on app resume (`refreshOnResume`, wired from app.ts's
//      existing `visibilitychange` resume hook).
// Every one of those three re-fetches (and the initial fetch, and
// `onRevoked`) funnels through `maybePushSnapshot`, which recomputes `fresh`
// every time (fixing the Minor: it used to be frozen at whatever the very
// first push computed) and only actually notifies subscribers/persists when
// the snapshot's CONTENT (status/truncated/contacts) actually changed —
// re-fetching the same unchanged projection on a timer must not spam
// subscribers or dirty `store.contactsSnapshot` for nothing.
const LIVE_DEBOUNCE_MS = 1_000
const GRANT_POLL_MS = 60_000


// Test seam: real (tiny) timings instead of fake ones. A real-vs-fake-timer
// mismatch is a known source of flake here — the re-fetch chain
// (`fetchProjection` → the SDK's own `ingestQueue`-chained decrypt/verify/
// persist steps) is deep enough that `vi.advanceTimersByTimeAsync` does not
// reliably flush every microtask hop before returning (confirmed empirically
// while writing `contacts-grant.test.ts`'s live/poll tests: identical
// scenarios settle every time under real timers, only sometimes under fake
// ones). Real timers with these shrunk to a few/tens of ms keep the tests
// both deterministic and fast — production always uses the real constants.
let liveDebounceMs: number = LIVE_DEBOUNCE_MS
let grantPollMs: number = GRANT_POLL_MS

export function setGrantTimingForTests(overrides: { debounceMs?: number; pollMs?: number } | null): void {
  liveDebounceMs = overrides?.debounceMs ?? LIVE_DEBOUNCE_MS
  grantPollMs = overrides?.pollMs ?? GRANT_POLL_MS
}

let appKeyInFlight: Promise<{ sk: Uint8Array; pk: string }> | null = null

/** This device's own local signing key for the contacts grant — created once
 *  (SecretStore's 'contacts-app-sk') and reused across restarts, same
 *  "in-flight promise so concurrent callers share one create" discipline as
 *  secure-key.ts's `loadOrCreatePhoneKey`. See this module's own doc comment
 *  for why this is its own key, not the identity or phone key. */
export function contactsAppKey(): Promise<{ sk: Uint8Array; pk: string }> {
  if (appKeyInFlight) return appKeyInFlight
  appKeyInFlight = (async () => {
    try {
      const secrets = secretStore()
      let skHex = await secrets.get(APP_KEY_NAME)
      if (!skHex) {
        skHex = bytesToHex(generateSecretKey())
        await secrets.set(APP_KEY_NAME, skHex)
      }
      const sk = hexToBytes(skHex)
      return { sk, pk: getPublicKey(sk) }
    } finally {
      appKeyInFlight = null
    }
  })()
  return appKeyInFlight
}

/** A plain local `ContactsSigner` over the contacts app key — NIP-44 via a
 *  fresh conversation key per peer, signing via `finalizeEvent`. No bunker,
 *  no My Signet round-trip (design decision 1). */
function localSigner(sk: Uint8Array, pk: string): ContactsSigner {
  return {
    pubkey: pk,
    async signEvent(t) {
      return finalizeEvent({ kind: t.kind, created_at: t.created_at, tags: t.tags, content: t.content }, sk)
    },
    async nip44Encrypt(peer, plaintext) {
      return encrypt(plaintext, getConversationKey(sk, peer))
    },
    async nip44Decrypt(peer, ciphertext) {
      return decrypt(ciphertext, getConversationKey(sk, peer))
    },
  }
}

/** `localStorage`-backed `StorageIo`, wrapped in try/catch as the library
 *  allows (README: "storage is a convenience, never a correctness input" on
 *  the write side — but a `getItem` in a locked-down browser can throw too,
 *  so both legs are guarded here rather than relying on the client's own
 *  internal guard alone). */
function contactsStorage(): StorageIo {
  return {
    async get(key) {
      try {
        return localStorage.getItem(key)
      } catch {
        return null
      }
    },
    async set(key, value) {
      try {
        localStorage.setItem(key, value)
      } catch {
        // Storage is a convenience, not a correctness requirement.
      }
    },
  }
}

let pool: SimplePool | null = null
function relayPool(): SimplePool {
  if (!pool) pool = new SimplePool()
  return pool
}

/** Wraps a `RelayIo` so a live-delivered event (whatever `client.start()`
 *  passes as its own `onEvent` to `relay.subscribe`) ALSO schedules this
 *  module's own debounced re-fetch (`scheduleLiveRefresh`) — see the const
 *  block above for why. The client's own `onEvent` still runs first, exactly
 *  as before; this only adds a side effect alongside it, never changes what
 *  the client itself does with the event. A no-op wrapper (returns `relay`
 *  itself) when the transport has no `subscribe` at all — nothing to hook.
 *  Exported (production AND test use — `contacts-grant.test.ts` composes it
 *  over a fake relay the same way `defaultClientFactory` does over the real
 *  one, so the live-update tests exercise this exact wrapping, not a
 *  hand-rolled stand-in of it). */
export function withLiveRefresh(relay: RelayIo): RelayIo {
  if (!relay.subscribe) return relay
  return {
    ...relay,
    subscribe(filter, relays, onEvent) {
      return relay.subscribe!(filter, relays, (event) => {
        onEvent(event)
        scheduleLiveRefresh()
      })
    },
  }
}

/** Builds a real client over the real relay pool and localStorage. Replaced
 *  in tests (`setClientFactoryForTests`) with one over a fake `RelayIo`/
 *  `StorageIo` so a test never touches the network or the browser's real
 *  storage. Not part of this module's documented "Produces" interface — a
 *  test-only seam, same pattern as session.ts's `setTransportFactoryForTests`. */
async function defaultClientFactory(): Promise<SignetContactsClient> {
  const { sk, pk } = await contactsAppKey()
  return createSignetContactsClient({
    signer: localSigner(sk, pk),
    relay: withLiveRefresh(createSimplePoolRelayIo(relayPool())),
    storage: contactsStorage(),
  })
}

let clientFactory: () => Promise<SignetContactsClient> = defaultClientFactory

/** Test seam: replaces the factory `beginPairing`/`startGrant` use to build
 *  a `SignetContactsClient`. `null` restores the real, network-backed
 *  default. */
export function setClientFactoryForTests(f: (() => Promise<SignetContactsClient>) | null): void {
  clientFactory = f ?? defaultClientFactory
}

// ---------------------------------------------------------------------------
// The live ContactsSource: holds the latest snapshot, persists it to
// `store.contactsSnapshot` on every change (so a restart has something to
// show before its own first fetch completes), and notifies contacts.ts's
// subscribers.
// ---------------------------------------------------------------------------

interface GrantSource extends ContactsSource {
  push(next: ContactsSnapshot): void
}

function makeGrantSource(initial: ContactsSnapshot): GrantSource {
  let snap = initial
  const subs = new Set<(s: ContactsSnapshot) => void>()
  return {
    current() {
      return snap
    },
    onUpdate(cb) {
      subs.add(cb)
      return () => subs.delete(cb)
    },
    push(next) {
      snap = next
      store.update((p) => {
        p.contactsSnapshot = next
      })
      for (const cb of subs) cb(snap)
    },
  }
}

let liveSource: GrantSource | null = null

/** Fix round 1, finding 2: stops watching for a sign-out once installed
 *  (`resetForTests`) — see `ensureSource`'s own doc comment for why this
 *  watch exists at all. */
let unsubscribeSignOutWatch: (() => void) | null = null

/** Installs (once) the module's own `ContactsSource`, seeded from whatever
 *  `store.contactsSnapshot` already holds — so a caller reading
 *  `contacts.snapshot()` right after `startGrant()`/`beginPairing()` is
 *  called (before either has awaited anything) already sees the persisted
 *  snapshot, not the bare "never paired" default. Also installs a one-time
 *  watch for `store.contactsPairing` disappearing out from under a LIVE
 *  runtime WITHOUT going through `disconnectGrant` — the only way that
 *  happens is `session.signOut()`'s `store.clear()`, which wipes the whole
 *  persisted blob (including this device's own local grant pairing) rather
 *  than going through this module. Design decision 1 (task-1-report.md)
 *  says the grant is otherwise independent of the family identity session —
 *  this watch is not "contacts follows sign-in/out", only "don't keep
 *  polling/subscribing for a pairing the store no longer has any record
 *  of". A `disconnectGrant()`-triggered store update is a no-op here: it
 *  already stopped the runtime itself before touching the store, so
 *  `liveClient`/`livePairing` are already null by the time this fires. */
function ensureSource(): GrantSource {
  if (!liveSource) {
    const persisted = store.load().contactsSnapshot
    liveSource = makeGrantSource(persisted ?? EMPTY_SNAPSHOT)
    setContactsSource(liveSource)
    unsubscribeSignOutWatch = store.subscribe(() => {
      if (liveClient && !parseStoredPairing(store.load().contactsPairing)) {
        stopGrantRuntime()
        sawNonEmptyGrant = false
        liveSource?.push(EMPTY_SNAPSHOT)
      }
    })
  }
  return liveSource
}

let liveClient: SignetContactsClient | null = null
/** The pairing the currently-live client is running against — `null`
 *  whenever `liveClient` is. Kept alongside it (rather than threading it
 *  through every timer callback) so `refreshGrant`/`refreshOnResume` can
 *  re-fetch without either needing their own copy. */
let livePairing: PairingV2 | null = null
let liveDebounceTimer: ReturnType<typeof setTimeout> | null = null
let livePollTimer: ReturnType<typeof setInterval> | null = null

/** Fix round 2: a generation counter, bumped by `stopGrantRuntime` (every
 *  call — `disconnectGrant`, the sign-out watch, and the top of
 *  `activateGrant`) and again by `activateGrant` itself once it takes over.
 *  `refreshGrant`/`activateGrant` each capture the generation in force when
 *  they start, before their first `await`; the re-review's finding was that
 *  neither re-checked anything was still current once that await resolved,
 *  so a `disconnectGrant()`/sign-out that ran mid-await left the stale
 *  continuation free to push the old snapshot back and (in `activateGrant`'s
 *  case) re-arm `onRevoked`/`start`/the poll timer on a client the app had
 *  already stopped. Every continuation after an await now checks its
 *  captured generation against the current one (and, in `refreshGrant`,
 *  that `liveClient` is still the same client) before touching anything —
 *  a mismatch means some `stopGrantRuntime()` ran in the meantime, and the
 *  stale call has nothing left to do but, for `activateGrant`, stop the
 *  client it started. */
let runtimeGen = 0

/** Stops whatever is live: the client's own subscription/poll (`client.
 *  stop()`, which also tears down its `RelayIo.subscribe` handle — see the
 *  SDK's own `stopLive()`), this module's live-debounce timer, and this
 *  module's own 60s poll. Idempotent — safe whether or not anything was
 *  actually running. Called before activating a (possibly different) grant,
 *  from `disconnectGrant`, and from `ensureSource`'s sign-out watch. Also
 *  bumps `runtimeGen` (fix round 2) — every call here means whatever was
 *  previously live is no longer authoritative, so any refresh/activation
 *  already in flight for it must find out once its own await resolves. */
function stopGrantRuntime(): void {
  runtimeGen++
  if (liveDebounceTimer !== null) {
    clearTimeout(liveDebounceTimer)
    liveDebounceTimer = null
  }
  if (livePollTimer !== null) {
    clearInterval(livePollTimer)
    livePollTimer = null
  }
  liveClient?.stop()
  liveClient = null
  livePairing = null
}

/** `withLiveRefresh`'s hook: a live-delivered event schedules ONE re-fetch
 *  `LIVE_DEBOUNCE_MS` after the LAST live event (not the first) — a burst of
 *  several events lands one re-fetch, not one per event. Restarts the timer
 *  on every call, same debounce idiom used elsewhere in this app. */
function scheduleLiveRefresh(): void {
  if (liveDebounceTimer !== null) clearTimeout(liveDebounceTimer)
  liveDebounceTimer = setTimeout(() => {
    liveDebounceTimer = null
    void refreshGrant()
  }, liveDebounceMs)
}

/** Re-fetches the live client's projection and pushes whatever changed —
 *  shared by the live-debounce timer, the 60s poll, and `refreshOnResume`.
 *  A no-op if nothing is live (a timer that fired just as `disconnectGrant`/
 *  the sign-out watch tore the runtime down). `client.fetchProjection`
 *  itself never throws (it swallows a hostile/malformed/unreachable relay
 *  into a `null` return — see the SDK's own doc comment), so there is
 *  nothing here to catch.
 *
 *  Fix round 2: captures `runtimeGen` before the `await` and re-checks it
 *  (plus that `liveClient` is still this same `client`) once the fetch
 *  resolves — a `disconnectGrant()`/sign-out mid-fetch bumps the generation
 *  (and nulls `liveClient`) before this resolves, so the stale fetch's
 *  result is dropped instead of overwriting the empty snapshot those calls
 *  already pushed. */
async function refreshGrant(): Promise<void> {
  const client = liveClient
  const pairing = livePairing
  const gen = runtimeGen
  if (!client || !pairing) return
  await client.fetchProjection(pairing)
  if (runtimeGen !== gen || liveClient !== client) return
  maybePushSnapshot(client, ensureSource())
}

/** `client.load` → `fetchProjection` → push the resulting snapshot → watch
 *  for a revocation → `client.start` for live delivery (wrapped, see
 *  `withLiveRefresh`) → this module's own 60s poll. Shared by `beginPairing`'s
 *  successful ack and `startGrant`'s reload of a stored pairing, so the two
 *  can never drift on what "activate a grant" means. Stops whatever was
 *  previously live first (`stopGrantRuntime`) — activating a second grant (a
 *  reconnect after `disconnectGrant`, or a second call this process never
 *  made in practice but a test might) must not leak the previous client's
 *  live subscription/poll/debounce timer.
 *
 *  Fix round 2: `stopGrantRuntime()` bumps `runtimeGen` for whatever it just
 *  tore down; this activation then bumps it again to claim a generation
 *  number of its own (`myGen`) before its first `await`. If a
 *  `disconnectGrant()`/sign-out runs while `client.load`/`fetchProjection` is
 *  in flight, `runtimeGen` moves again out from under `myGen` — the stale
 *  continuation stops the client IT started (never touching whatever
 *  `liveClient` now points at, which may already be a newer activation's)
 *  and returns before pushing a snapshot or arming `onRevoked`/`start`/the
 *  poll timer, so a stopped runtime stays stopped. */
async function activateGrant(client: SignetContactsClient, pairing: PairingV2, source: GrantSource): Promise<void> {
  stopGrantRuntime()
  const myGen = ++runtimeGen
  liveClient = client
  livePairing = pairing
  await client.load(pairing.grantId)
  if (runtimeGen !== myGen) {
    client.stop()
    return
  }
  await client.fetchProjection(pairing)
  if (runtimeGen !== myGen) {
    client.stop()
    return
  }
  maybePushSnapshot(client, source)
  // Final review B, minor 2: `maybePushSnapshot` notifies subscribers
  // synchronously, and the sign-out watch (`ensureSource`'s own
  // `store.subscribe`) is one of them — if the pairing this device just
  // paired against was ALREADY gone from the store by the time this push
  // lands (a sign-out that raced this same synchronous call), that watch's
  // `stopGrantRuntime()` runs right here, nulling `liveClient`/`livePairing`
  // and bumping `runtimeGen` again. Without re-checking, the lines below
  // would still arm `onRevoked`/`client.start()`/the poll timer on a client
  // the app just stopped.
  if (runtimeGen !== myGen) {
    client.stop()
    return
  }
  client.onRevoked(() => {
    if (runtimeGen === myGen) maybePushSnapshot(client, source)
  })
  client.start(pairing)
  livePollTimer = setInterval(() => { void refreshGrant() }, grantPollMs)
}

/** Two `ContactsSnapshot`s are the same CONTENT (fix round 1, finding 2:
 *  "compare contacts + status + truncated") — `fresh`/`at` deliberately
 *  excluded: they change on every fetch regardless of whether anything a
 *  subscriber cares about did, and pushing on every tick would defeat the
 *  point of the comparison. */
function snapshotContentEqual(a: ContactsSnapshot, b: ContactsSnapshot): boolean {
  if (a.status !== b.status) return false
  if (!!a.truncated !== !!b.truncated) return false
  if (a.contacts.length !== b.contacts.length) return false
  return a.contacts.every((c, i) => contactEqual(c, b.contacts[i]!))
}

function contactEqual(a: Contact, b: Contact): boolean {
  if (a.contactId !== b.contactId || a.name !== b.name || a.tier !== b.tier || a.blocked !== b.blocked) return false
  if (a.pks.length !== b.pks.length) return false
  return a.pks.every((pk, i) => pk === b.pks[i])
}

/** Converts the client's CURRENT state and recomputes `fresh` (fix round 1:
 *  previously frozen at whatever the first push computed — see the module
 *  doc comment above) — then only actually pushes (notifies subscribers,
 *  persists to `store.contactsSnapshot`) when the content differs from what
 *  is already there, per `snapshotContentEqual`. Every re-fetch path (the
 *  initial fetch, a revocation, the live debounce, the 60s poll, an app
 *  resume) funnels through this one function so none of them can drift on
 *  what "did anything actually change" means. */
/** Final review B, finding I1: the disconnected banner must also cover a
 *  grant that has gone stale (My Signet stops publishing — `client.isFresh`
 *  flips false) or one that comes back empty after previously holding
 *  contacts (a My Signet reset) — `classifyUpdate` already treats both as
 *  `unknown` (nothing is auto-removed), but with no banner the user is never
 *  told removals/hand-overs have silently stopped working. Contacts/tiers
 *  are left exactly as `projectionToSnapshot` computed them — `usable`/
 *  `candidates` keep reading the last-known data; only the reported
 *  `status` degrades to `'disconnected'`. Folding this into `status` (rather
 *  than a separate flag) is also what makes the poll notice a freshness
 *  flip on its own: `snapshotContentEqual` already compares `status`, so a
 *  projection whose CONTENT never changed still triggers a push once it
 *  goes stale. */
/** Final small-fixes round: whether this grant has EVER reported a non-empty
 *  contact list since the last disconnect/sign-out/new pairing. Comparing
 *  against `prev.contacts.length` (`prev` being `source.current()`, i.e.
 *  whatever was last PUSHED) broke once the emptied-grant degrade itself
 *  pushed a `{status:'disconnected', contacts:[]}` snapshot: the very next
 *  poll's `prev` was already that empty, degraded value, so an unchanged
 *  empty projection no longer looked "emptied out" and the freshly
 *  recomputed `raw` (always `'connected'` for a live, non-revoked
 *  projection regardless of how many contacts it holds) went straight
 *  through — the banner would disappear and the You tab would revert to
 *  "Connected — 0 contacts" one poll after correctly showing it. Tracking
 *  this separately from whatever gets pushed/displayed avoids that: once
 *  a real non-empty projection has been seen, every subsequent empty one
 *  stays degraded no matter how many unchanged polls come in between.
 *  Module state only (not persisted to `store`) — deliberately reset only
 *  where a fresh grant identity begins or ends (`disconnectGrant`, the
 *  sign-out watch in `ensureSource`, and the top of `beginPairing` for a
 *  NEW pairing), never by `stopGrantRuntime`/`activateGrant` on their own,
 *  since those also run for an ordinary reload of the SAME existing
 *  pairing (`startGrant`, an app restart) — that must keep remembering the
 *  grant was non-empty before. */
let sawNonEmptyGrant = false

function degradeIfStaleOrEmptied(raw: ContactsSnapshot): ContactsSnapshot {
  if (raw.status !== 'connected') return raw
  const wentStale = !raw.fresh
  const emptiedOut = raw.contacts.length === 0 && sawNonEmptyGrant
  if (raw.contacts.length > 0) sawNonEmptyGrant = true
  return wentStale || emptiedOut ? { ...raw, status: 'disconnected' } : raw
}

function maybePushSnapshot(client: SignetContactsClient, source: GrantSource): void {
  const nowSec = Math.floor(Date.now() / 1000)
  const state = client.getState()
  const prev = source.current()
  const raw = projectionToSnapshot(state.projection, client.getBlockedSet(), client.isFresh(nowSec), nowSec)
  const next = degradeIfStaleOrEmptied(raw)
  if (!snapshotContentEqual(prev, next)) source.push(next)
}

/** Wired from app.ts's existing `visibilitychange` resume hook (the same one
 *  `poolHealth.recoverIfStale()` already uses) — a no-op when no grant is
 *  live. Cheap and safe to call on every resume regardless: `refreshGrant`
 *  itself no-ops without a live client/pairing, and `maybePushSnapshot`
 *  inside it only pushes on an actual content change. */
export function refreshOnResume(): void {
  void refreshGrant()
}

/** Shape check for whatever `store.contactsPairing` holds — plain JSON, no
 *  secret, re-validated like any other stored value (store.ts never
 *  validates it itself; see store.ts's own doc comment on the field). */
function parseStoredPairing(raw: unknown): PairingV2 | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  if (typeof o.grantId !== 'string' || typeof o.railPubkey !== 'string') return null
  if (typeof o.projectionTag !== 'string' || typeof o.proposalTag !== 'string') return null
  if (typeof o.relay !== 'string' || typeof o.maxStalenessSeconds !== 'number') return null
  if (!Array.isArray(o.grantedCapabilities) || typeof o.pairedAt !== 'number') return null
  return o as unknown as PairingV2
}

function randomChallenge(): string {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
}

/** A pairing whose ack has landed but is not yet trusted — the security MUST
 *  from signet-contacts' `docs/WIRE.md` §"Pairing verification code (B1,
 *  F1)": a photographed QR carries no author pin, so a forged ack can win
 *  the race before the owner's real one lands. `code` is built from
 *  `grantId`/`railPubkey`, values that exist only inside a REAL ack, never
 *  on the QR itself — showing it and waiting for the person to confirm My
 *  Signet reported a match is what forces an attacker to commit to a forged
 *  ack before anything about the owner's code exists to copy. Until
 *  `confirm()` is called, the pairing is NOT persisted, NOT fetched, and NOT
 *  started — `beginPairing`'s caller must not do any of those three things
 *  itself either. */
export interface PendingPairing {
  /** Formatted 6-digit code (e.g. `"042 917"`) — show verbatim and ask the
   *  person to type it into My Signet. Always shown, for every ack, never
   *  skipped based on anything the ack itself claims. */
  code: string
  /** My Signet confirmed the typed code matches. Only now does this
   *  persist the pairing and activate the grant (fetch + live start). A
   *  no-op if the pairing was already discarded — a sign-out or a
   *  different identity signing in while the code was on screen. */
  confirm(): Promise<void>
  /** The code didn't match, or the person cancelled. Discards the pairing
   *  outright — nothing was ever persisted, fetched, or started, so there
   *  is nothing to undo. A fresh `beginPairing()` call mints a new
   *  challenge for the next attempt. */
  cancel(): void
}

/** Starts a new pairing: builds the `signet-grant:` URI (for the caller to
 *  show as a QR — `beginPairing` UI is Task 10, not this module) and starts
 *  waiting for the owner's ack. `directory` is `'dependant'` for a signed-in
 *  dependant (spec §2: "a dependant gets its own directory") — `'owner'`
 *  otherwise. `wait` resolves `false` on a timeout, a declined pairing, or a
 *  sign-out/identity-change racing the ack — or a `PendingPairing` once the
 *  ack lands, which the caller must show (the pairing verification code)
 *  and wait on before doing anything else with the pairing (see
 *  `PendingPairing`'s own doc comment). */
export async function beginPairing(): Promise<{ uri: string; wait: Promise<PendingPairing | false> }> {
  // Final small-fixes round: a brand new pairing means a (possibly
  // different) producer/grant — the "have we ever seen a non-empty
  // projection" memory belongs to whatever grant was live before, not this
  // one. See `sawNonEmptyGrant`'s own doc comment for why this is NOT also
  // reset inside `activateGrant`/`stopGrantRuntime` (those run for an
  // ordinary reload of the SAME pairing too).
  sawNonEmptyGrant = false
  const client = await clientFactory()
  const session = currentSession()
  const relays = appRelays(store.load())
  const relay = relays[0]
  if (!relay) throw new Error('no relay configured')
  const challenge = randomChallenge()
  const { pk: appPubkey } = await contactsAppKey()
  const uri = client.buildPairingUri({
    appName: APP_NAME,
    capabilities: CONTACTS_CAPABILITIES,
    directory: session?.dependant ? 'dependant' : 'owner',
    relay,
    nowSec: Math.floor(Date.now() / 1000),
    challenge,
  })
  // Final review B, finding 1: an in-flight pairing (waiting on the owner's
  // ack, or awaiting the person's confirmation of the pairing code below)
  // must not survive a sign-out, or a sign-in as someone else, or another
  // activation/disconnect racing the same session — the ack, arriving
  // later, would otherwise write THIS pairing into whoever/whatever is
  // current by then (a later signed-in session reading an earlier
  // session's contacts). `session`/`myGen` are captured now, before any
  // await; a store change (sign-out and sign-in both go through it, same
  // idiom as `ensureSource`'s own watch) aborts the still-pending ack
  // outright, and (security MUST) also discards a pairing already awaiting
  // the person's code confirmation, instead of leaving either to resolve
  // into a stale write.
  const myGen = runtimeGen
  const controller = new AbortController()
  let discarded = false
  const unsubscribeSessionWatch = store.subscribe(() => {
    if (currentSession()?.identityPk !== session?.identityPk) {
      discarded = true
      controller.abort()
    }
  })
  const wait: Promise<PendingPairing | false> = (async () => {
    // `keepWatch` — the session watch stays armed once a `PendingPairing`
    // is handed back (the code is on screen, awaiting `confirm`/`cancel`),
    // so a sign-out/identity-change THEN still discards it; it is only torn
    // down here, in `finally`, for every path that returns `false` without
    // ever showing anything.
    let keepWatch = false
    try {
      // No timeoutMs: the SDK's default (600s) covers the link's own 300s
      // plus the stored ack's 300s, so a backgrounded app still finds it.
      const pairing = await client.awaitPairingAck({
        challenge,
        relays,
        requestedCapabilities: CONTACTS_CAPABILITIES,
        signal: controller.signal,
      })
      if (!pairing) return false
      // Belt and braces: re-checked here too, not just via the abort above
      // (a session/generation change landing in the same tick the ack
      // itself arrived, after `awaitPairingAck`'s own `signal.aborted`
      // checks already passed, must still not surface the pairing at all).
      if (discarded || currentSession()?.identityPk !== session?.identityPk || runtimeGen !== myGen) return false

      // Security MUST (signet-contacts docs/WIRE.md §"Pairing verification
      // code"): NOTHING below persists, fetches, or starts this pairing.
      // `grantId`/`railPubkey` exist only inside this real ack, never on
      // the photographed QR — the code the person types into My Signet is
      // what proves this ack is the owner's, not an attacker's.
      const code = formatPairingCode(
        pairingCode({ appPubkey, challenge, grantId: pairing.grantId, railPubkey: pairing.railPubkey }),
      )
      let settled = false
      keepWatch = true
      return {
        code,
        async confirm() {
          if (settled || discarded || runtimeGen !== myGen) return
          settled = true
          unsubscribeSessionWatch()
          store.update((p) => {
            p.contactsPairing = pairing
          })
          await activateGrant(client, pairing, ensureSource())
        },
        cancel() {
          if (settled) return
          settled = true
          unsubscribeSessionWatch()
        },
      }
    } finally {
      if (!keepWatch) unsubscribeSessionWatch()
    }
  })()
  return { uri, wait }
}

/** The current device's stored pairing's granted capabilities, or `null` if
 *  it has never paired. My Signet's own grant screen leaves the "Kin, Kith
 *  and Ken labels" and "who you have blocked" boxes unticked by default —
 *  `grantedCapabilities` may therefore be narrower than what was requested
 *  (`CONTACTS_CAPABILITIES`), and a consumer must read it back rather than
 *  assume every capability was granted. contacts-view.ts reads this to show
 *  a narrowed-grant notice. */
export function grantedCapabilities(): readonly string[] | null {
  const pairing = parseStoredPairing(store.load().contactsPairing)
  return pairing ? pairing.grantedCapabilities : null
}

/** Called once at app start, after the session restores (app.ts, alongside
 *  the other module starts): installs the contacts source (so a restart
 *  shows the last known snapshot immediately — see `ensureSource`), then, if
 *  this device has ever paired, reloads the signet-contacts client's own
 *  state and fetches whatever's newer. A no-op beyond installing the source
 *  if this device has never paired. */
export async function startGrant(): Promise<void> {
  const source = ensureSource()
  const pairing = parseStoredPairing(store.load().contactsPairing)
  if (!pairing) return
  const client = await clientFactory()
  await activateGrant(client, pairing, source)
}

/** Test seam: resets this module's own singletons (the live client/pairing,
 *  its timers, the sign-out watch, and the installed contacts source) so
 *  each test starts clean. Production code never needs this —
 *  `startGrant`/`beginPairing` each run at most once per process — but a
 *  test file that calls them repeatedly, and also resets `contacts.ts`'s own
 *  source between tests (`setContactsSource(null)`), would otherwise find
 *  `ensureSource()`'s "only install once" guard skips re-installing after
 *  that external reset (and, pre-fix-round-1, would leak a previous test's
 *  poll/debounce timer and sign-out watch into the next). */
export function resetForTests(): void {
  stopGrantRuntime()
  unsubscribeSignOutWatch?.()
  unsubscribeSignOutWatch = null
  liveSource = null
  sawNonEmptyGrant = false
}

/** Forgets the pairing locally (never tells the producer — there is nothing
 *  to tell; disconnecting is purely this device choosing to stop reading).
 *  Status goes to `'none'`, same as never having paired. Stops the live
 *  client's own subscription plus this module's debounce/poll timers first
 *  (fix round 1, finding 2) — nothing should keep re-fetching a pairing this
 *  device just forgot. */
export function disconnectGrant(): void {
  stopGrantRuntime()
  sawNonEmptyGrant = false
  const source = ensureSource()
  store.update((p) => {
    delete p.contactsPairing
  })
  source.push(EMPTY_SNAPSHOT)
}

/** Maps a signet-contacts v2 projection into `contacts.ts`'s
 *  `ContactsSnapshot` — see this module's own doc comment for the two wire
 *  facts this leans on (blocked is keyed by pubkey; identities carry the
 *  pubkeys). `projection` is typed `unknown` because it is whatever
 *  `client.getState().projection` currently holds — `null` before any fetch,
 *  or a wire object this function re-validates field by field rather than
 *  trusting the caller's cast. A `revoked` projection (the tombstone
 *  `applyProjection` keeps, `contacts` already zeroed by the SDK) maps to
 *  `status: 'disconnected'` with an empty contact list — the sticky Blocked
 *  set is NOT re-derived from it; the caller already read the current one
 *  off `client.getBlockedSet()` before this ever zeroed out. */
export function projectionToSnapshot(
  projection: unknown,
  blocked: ReadonlySet<string>,
  fresh: boolean,
  nowSec: number,
): ContactsSnapshot {
  if (!projection || typeof projection !== 'object') {
    return { status: 'none', contacts: [], fresh, at: nowSec }
  }
  const proj = projection as Record<string, unknown>
  if (proj.revoked === true) {
    return { status: 'disconnected', contacts: [], fresh: false, at: nowSec }
  }
  const rawContacts = Array.isArray(proj.contacts) ? proj.contacts : []
  const contacts: Contact[] = []
  for (const raw of rawContacts) {
    if (!raw || typeof raw !== 'object') continue
    const c = raw as Record<string, unknown>
    if (typeof c.contactId !== 'string') continue
    const rawIdentities = Array.isArray(c.identities) ? c.identities : []
    const pks: string[] = []
    for (const identity of rawIdentities) {
      if (identity && typeof identity === 'object' && typeof (identity as Record<string, unknown>).pubkey === 'string') {
        pks.push((identity as Record<string, unknown>).pubkey as string)
      }
    }
    const rawTier = c.effectiveTier
    const tier: Tier | undefined =
      rawTier === 'kin' || rawTier === 'kith' || rawTier === 'ken' || rawTier === 'none' ? rawTier : undefined
    contacts.push({
      contactId: c.contactId,
      pks,
      name: typeof c.displayName === 'string' ? c.displayName : '',
      tier,
      blocked: pks.some((pk) => blocked.has(pk)),
    })
  }
  return {
    status: 'connected',
    contacts,
    fresh,
    at: nowSec,
    ...(proj.truncated === true ? { truncated: true as const } : {}),
  }
}
