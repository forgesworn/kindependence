// Sign in with My Signet (Signet identity plan, Task 11): the screens app.ts
// shows in place of a tab whenever `session.currentSession()` is null — the
// old local family identity (identity.ts, deleted this task) is gone, so
// there is no more "start our family" / "I have a setup code" onboarding.
// Every identity now lives in My Signet; this module only ever CONNECTS to
// it, over one of three transports (spec §6/§7):
//  - NIP-55, a signer app installed on this same Android phone
//    (`nip55.ts`/`remote-signer.ts`'s `transportFromNip55`);
//  - NIP-46 via an app-initiated `nostrconnect://` QR (signet-login's
//    `createBunkerSignerFromNostrConnect`);
//  - NIP-46 via a pasted or scanned `bunker://` link (signet-login's
//    `createBunkerSigner`) — the SAME screen a dependant's phone uses to
//    scan the `bunker://…?dependant=` QR the guardian's My Signet shows
//    (design spec §7): the only difference is that URI's own `dependant`
//    query parameter, which `parseBunkerLink` below reads.
//
// `session.startSession()` is deliberately NOT called until AFTER the
// device statement (device-statements.ts) is signed and verified —
// `attemptSignIn` below signs it through a bare `RemoteSigner` over the
// just-connected transport, never `session.identitySigner()` — so a
// declined statement leaves no session at all (the task's own test
// contract), and a transient SignerUnavailable can retry the SAME
// already-connected transport without redoing the connect step. Only once
// the statement verifies does this module call `session.startSession()`
// then `session.recordStatement()`, atomically turning "connected" into
// "signed in".

import * as store from './store.js'
import * as nip55 from './nip55.js'
import { isNativePlatform } from './native.js'
import * as session from './session.js'
import type { SessionInfo } from './session.js'
import {
  RemoteSigner,
  GUARDIAN_APPROVAL_TIMEOUT_MS,
  SignerRejected,
  SignerUnavailable,
  transportFromNip55,
  transportFromSignetSigner,
  type SignerTransport,
} from './remote-signer.js'
import { deviceStatementTemplate, verifyDeviceStatement } from './device-statements.js'
import { loadOrCreatePhoneKey } from './secure-key.js'
import { qrImgTag } from './qr.js'
import {
  buildNostrConnectUri,
  createBunkerSignerFromNostrConnect,
  createBunkerSigner,
  isBunkerUri,
} from 'signet-login'
import { getPublicKey } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import { bytesToHex } from '@noble/hashes/utils.js'
import { startQrScan, stopQrScan, mountQrScanner } from './qr-scan.js'
import * as contactsView from './contacts-view.js'
import * as linkPairing from './link-pairing.js'
import { relaysFromSettings } from './relay-defaults.js'

// Same computation as circles.ts's `appRelays`, via the shared relay-defaults.ts.
function relaysFor(p: store.Persisted): string[] {
  return relaysFromSettings(p.settings)
}

const NOSTRCONNECT_PERMS = ['sign_event:30078', 'nip44_encrypt', 'nip44_decrypt']

/** A live, connected transport plus the descriptor `session.startSession`
 *  needs, still short of a signed-in session — held between "connected" and
 *  "statement signed" (the explain screen, and a rejected/unavailable retry
 *  screen). */
interface PendingSignIn {
  transport: SignerTransport
  identityPk: string
  dependant: boolean
  transportDescriptor: SessionInfo['transport']
}

type Screen =
  | { kind: 'welcome'; error?: string }
  | { kind: 'qr'; uri: string }
  | { kind: 'link'; mode: 'bunker' | 'dependant'; value: string; error?: string; scanning: boolean }
  | { kind: 'explain'; pending: PendingSignIn; signing?: boolean }
  | { kind: 'rejected'; pending: PendingSignIn }
  | { kind: 'invalid'; pending: PendingSignIn }
  | { kind: 'unavailable'; pending: PendingSignIn }
  // Plan 2 (Task 10): "Connect your contacts", skippable — shown right
  // after the device statement verifies, for BOTH an adult and a
  // dependant, before the dependant-only keep-running hint (see
  // `attemptSignIn`'s/`doSign`'s own doc comments on why this is set in two
  // places). `dependant` is carried here (not read back off `pending`,
  // which is out of scope once this screen shows) so the skip/continue
  // handler below knows what to move on to.
  | { kind: 'contacts'; dependant: boolean }
  | { kind: 'keep-running-hint' }

let screen: Screen = { kind: 'welcome' }
let qrAbort: AbortController | null = null
// Fix round 1, finding 7b: bumped on every `connectQr` call, so a QR
// attempt's own catch handler can tell whether it's still the CURRENT
// attempt before touching `screen` — a stale attempt (its own transport
// already aborted by a cancel, or superseded by a fresh "Connect with a QR
// code" tap before its rejection lands) must not clobber whatever the
// newer attempt has put on screen. `screen.kind === 'qr'` alone isn't
// enough: a newer attempt also leaves the screen on 'qr' (its own, fresh
// uri), which the OLD guard couldn't tell apart from its own.
let qrAttemptId = 0
let onSignedIn: (() => void) | null = null

/** app.ts registers its own post-sign-in boot sequence here (same
 *  "registration, not import" idiom as activity.ts's `setNavigator`) —
 *  called once, right after a device statement verifies and the session is
 *  established, whether or not a keep-running hint screen follows it. */
export function setOnSignedIn(cb: () => void): void {
  onSignedIn = cb
}

/** Whether app.ts should render this module's `view()` instead of the
 *  normal signed-in app: no session yet, OR the dependant-only
 *  keep-running-mode hint, or the Task 10 "Connect your contacts" step,
 *  that's still shown for one extra beat AFTER a session already exists
 *  (see `attemptSignIn`'s success path). */
export function shouldShow(): boolean {
  return !session.currentSession() || screen.kind === 'keep-running-hint' || screen.kind === 'contacts'
}

/** Resets this module's own screen state on sign-out (You tab's "Sign out")
 *  — a stale 'rejected'/'unavailable'/'explain' screen would otherwise hold
 *  a `pending.transport` for a session that no longer exists. */
export function resetForSignOut(): void {
  qrAbort?.abort()
  qrAbort = null
  stopScan()
  screen = { kind: 'welcome' }
}

// ---------------------------------------------------------------------------
// NIP-55 availability (Android only) — checked once, asynchronously, so
// `view()` can stay a synchronous pure string builder like every other
// domain module's. Same "ensure() is the one side-effecting entry point"
// idiom as contacts.ts used to document.
// ---------------------------------------------------------------------------

let installedNip55: nip55.InstalledSigner[] | null = null
let checkingNip55 = false

/** Called from app.ts's render() whenever `shouldShow()` — idempotent. */
export function ensure(): void {
  if (installedNip55 !== null || checkingNip55 || !isNativePlatform()) return
  checkingNip55 = true
  nip55.installedSigners().then((signers) => {
    installedNip55 = signers
    checkingNip55 = false
    store.notify()
  }).catch(() => {
    installedNip55 = []
    checkingNip55 = false
  })
}

// ---------------------------------------------------------------------------
// Pure helpers — unit-tested directly.
// ---------------------------------------------------------------------------

/** Parses a pasted or scanned `bunker://` link: valid-shape check (never
 *  throws — a garbage paste just fails the `isBunkerUri` prefix check) plus
 *  whether its query string carries a `dependant` parameter (design spec
 *  §7: the guardian's My Signet stamps this onto a dependant-pairing QR). */
export function parseBunkerLink(raw: string): { ok: true; uri: string; dependant: boolean } | { ok: false } {
  const trimmed = raw.trim()
  if (!trimmed || !isBunkerUri(trimmed)) return { ok: false }
  const qIndex = trimmed.indexOf('?')
  const query = qIndex >= 0 ? trimmed.slice(qIndex + 1) : ''
  return { ok: true, uri: trimmed, dependant: new URLSearchParams(query).has('dependant') }
}

/** `fam.name`'s fallback, shown on the You tab as "Signed in as …" (device
 *  check 2026-09-26, fix 5) — never the raw hex pubkey the old `shortPk`
 *  showed. My Signet's contacts grant deliberately never carries the
 *  signed-in identity's OWN pubkey or name (signet-contacts docs/WIRE.md
 *  §0, R-31: `scopedContactId` exists so two paired apps can't join on the
 *  owner's pubkey, which a self-entry in the projection would hand
 *  straight over), and nothing else in this app holds a real display name
 *  for "myself" yet — so this is what `name` ends up as for now. It's kept
 *  as a fallback rather than the only path so a future display-name
 *  source has somewhere to slot in ahead of it. */
const shortNpub = (pk: string): string => {
  try {
    const n = npubEncode(pk)
    return `${n.slice(0, 9)}…${n.slice(-4)}`
  } catch {
    return 'My Signet identity'
  }
}

/** Signs the device statement through a BARE `RemoteSigner` over
 *  `pending.transport` — never `session.identitySigner()` — then, only on
 *  success, calls `session.startSession()`/`session.recordStatement()` so a
 *  declined or timed-out attempt leaves no session at all (this module's
 *  own doc comment). Exported for direct testing with a fake
 *  `SignerTransport` (mirrors session.test.ts's own `fakeBunker` idiom) —
 *  `pending.transport` never needs a real My Signet/relay. */
export async function attemptSignIn(pending: PendingSignIn): Promise<
  { ok: true; session: SessionInfo } | { ok: false; reason: 'rejected' | 'invalid' | 'unavailable' }
> {
  const phone = await loadOrCreatePhoneKey()
  const signer = new RemoteSigner(pending.transport, pending.dependant ? { timeoutMs: GUARDIAN_APPROVAL_TIMEOUT_MS } : {})
  const now = Math.floor(Date.now() / 1000)
  let signed
  try {
    signed = await signer.signEvent(deviceStatementTemplate(phone.pkHex, now))
  } catch (e) {
    if (e instanceof SignerRejected) return { ok: false, reason: 'rejected' }
    if (e instanceof SignerUnavailable) return { ok: false, reason: 'unavailable' }
    return { ok: false, reason: 'unavailable' }
  }
  const verified = verifyDeviceStatement(signed)
  if (!verified || verified.identityPk !== pending.identityPk || verified.phonePk !== phone.pkHex) {
    // Fix round 1, finding 7c: distinguished from a `SignerRejected` explicit
    // "no" above — My Signet signed SOMETHING and handed it back, but it
    // doesn't check out (wrong identity/phone pubkey, or malformed). That's
    // never going to fix itself by tapping the same "Try again" a second
    // time against the same signer, unlike a genuine "Not approved", so the
    // UI shows different copy for it (see `invalidView`).
    return { ok: false, reason: 'invalid' }
  }
  // Fix round 1, finding 7a: flip the screen away from 'explain' BEFORE
  // calling session.startSession() below — that call's own store.update()
  // fires a synchronous notify() that re-renders the WHOLE app immediately,
  // and app.ts's signin.shouldShow() only stays true past that point if
  // `screen` already says so. Setting it after startSession (as doSign used
  // to, on this call's return) left a window where shouldShow() briefly
  // went false — session already exists, screen still 'explain' —
  // flashing the full signed-in app for a frame before doSign's own screen
  // update flipped back onward. Plan 2 (Task 10): the contacts step comes
  // first for everyone. Task 10 fix round 1 (review): this used to be
  // `if (pending.dependant)`, so an adult's sign-in still flashed the full
  // app for a frame — startSession's synchronous notify fires either way,
  // not just for a dependant. Unconditional now, matching doSign's own
  // success branch below.
  screen = { kind: 'contacts', dependant: pending.dependant }
  // Final review B, finding 10: `session.startSession()` can throw (its own
  // doc comment: a Keystore/transport error still propagates), and by this
  // point `screen` was ALREADY flipped forward to 'contacts' (finding 7a,
  // above) so `shouldShow()`'s own check stays true across that call's
  // synchronous notify. An uncaught throw here left `screen` stuck there —
  // no session ever created, but the signed-out view showed "Connect your
  // contacts" with Skip instead of an error, forever (`doSign`'s own
  // rejected/invalid/unavailable handling never ran, since the rejection
  // propagated past it instead of `attemptSignIn` returning normally).
  // Caught and reported the same way `attemptSignIn` already reports every
  // other failure — a normal `{ ok: false }` return, not a throw — and the
  // screen restored to 'explain' so a caller that (unlike `doSign`) does
  // nothing further with the result still isn't left on the contacts step
  // with no session.
  let full: Awaited<ReturnType<typeof session.startSession>>
  try {
    full = await session.startSession(
      {
        identityPk: pending.identityPk,
        dependant: pending.dependant,
        name: shortNpub(pending.identityPk),
        transport: pending.transportDescriptor,
      },
      pending.transport,
    )
  } catch {
    screen = { kind: 'explain', pending, signing: false }
    return { ok: false, reason: 'unavailable' }
  }
  session.recordStatement(signed)
  return { ok: true, session: { ...full, statement: signed } }
}

// ---------------------------------------------------------------------------
// Connect flows — each builds a `PendingSignIn` and moves to the explain
// screen, or reports an error back on the welcome/link screen it came from.
// ---------------------------------------------------------------------------

async function connectNip55(): Promise<void> {
  try {
    const { pubkey, packageName } = await nip55.getPublicKey()
    const transport = transportFromNip55(pubkey, packageName)
    screen = {
      kind: 'explain',
      pending: { transport, identityPk: pubkey, dependant: false, transportDescriptor: { kind: 'nip55', packageName } },
    }
  } catch {
    screen = { kind: 'welcome', error: "Couldn't connect to My Signet. Make sure it's installed and try again." }
  }
  store.notify()
}

async function connectQr(p: store.Persisted): Promise<void> {
  // Fix round 1, finding 7b: this attempt's own id — see `qrAttemptId`'s
  // own doc comment for why the catch block below checks it, not just
  // `screen.kind`.
  const attemptId = ++qrAttemptId
  const clientSk = await session.bunkerClientSk()
  const clientPubkeyHex = getPublicKey(clientSk)
  const secret = bytesToHex(crypto.getRandomValues(new Uint8Array(16)))
  const uri = buildNostrConnectUri({
    clientPubkeyHex,
    relayUrls: relaysFor(p),
    secret,
    appName: 'Kindependence',
    perms: NOSTRCONNECT_PERMS,
  })
  const controller = new AbortController()
  qrAbort = controller
  screen = { kind: 'qr', uri }
  store.notify()
  try {
    const signer = await createBunkerSignerFromNostrConnect({ uri, clientSecretKey: clientSk, abortSignal: controller.signal, requestTimeoutMs: GUARDIAN_APPROVAL_TIMEOUT_MS })
    const transport = transportFromSignetSigner(signer)
    screen = {
      kind: 'explain',
      pending: { transport, identityPk: signer.pubkey, dependant: false, transportDescriptor: { kind: 'nip46', bunkerUri: signer.bunkerUri } },
    }
  } catch {
    // Only override the screen if this is still the CURRENT attempt (fix
    // round 1, finding 7b) and the user hasn't already navigated away to a
    // non-'qr' screen of their own (`signin-cancel-qr` already put it back
    // to 'welcome' itself in that case).
    if (attemptId === qrAttemptId && screen.kind === 'qr') {
      screen = { kind: 'welcome', error: 'Connecting to My Signet timed out. Try again.' }
    }
  }
  if (qrAbort === controller) qrAbort = null
  store.notify()
}

function cancelQr(): void {
  qrAbort?.abort()
  qrAbort = null
  screen = { kind: 'welcome' }
  store.notify()
}

// Exported for direct testing (fix round 1, finding 6) — same "directly
// testable, signet-login mocked at its own boundary" idiom as
// `attemptSignIn`'s own export doc comment, but this one goes through the
// REAL signet-login entry point (`createBunkerSigner`) rather than a fake
// `SignerTransport`, so a test can assert what THAT call actually receives
// (the persisted client key, the raw uri) rather than only this module's
// own post-connect state.
export async function connectBunkerLink(raw: string, mode: 'bunker' | 'dependant'): Promise<void> {
  const parsed = parseBunkerLink(raw)
  if (!parsed.ok) {
    screen = { kind: 'link', mode, value: raw, scanning: false, error: "That doesn't look like a bunker link. Check it and try again." }
    store.notify()
    return
  }
  try {
    const clientSk = await session.bunkerClientSk()
    const signer = await createBunkerSigner({ uri: parsed.uri, clientSecretKey: clientSk, appName: 'Kindependence', requestTimeoutMs: GUARDIAN_APPROVAL_TIMEOUT_MS })
    const transport = transportFromSignetSigner(signer)
    screen = {
      kind: 'explain',
      pending: {
        transport,
        identityPk: signer.pubkey,
        dependant: parsed.dependant,
        transportDescriptor: { kind: 'nip46', bunkerUri: signer.bunkerUri },
      },
    }
  } catch {
    screen = { kind: 'link', mode, value: raw, scanning: false, error: "Couldn't connect with that link. Check it and try again." }
  }
  store.notify()
}

/** Closes an already-connected `pending.transport` that's about to be
 *  abandoned — the explain screen's cancel button, and "Start over" from a
 *  rejected/unavailable screen — so backing out doesn't leak the
 *  connection. Best-effort: nothing downstream reads a close failure. */
function abandonPending(pending: PendingSignIn): void {
  void pending.transport.close().catch(() => {})
}

/** The explain screen's "Continue" button, and the rejected/unavailable
 *  screens' "Try again" — same underlying attempt, reusing `pending`'s
 *  already-connected transport every time (no reconnect needed on retry). */
async function doSign(pending: PendingSignIn): Promise<void> {
  screen = { kind: 'explain', pending, signing: true }
  store.notify()
  const result = await attemptSignIn(pending)
  if (result.ok) {
    onSignedIn?.()
    // Plan 2 (Task 10): the "Connect your contacts" step, for everyone.
    // attemptSignIn already set this for a dependant (finding 7a) — this
    // assignment is then a no-op re-confirmation for that case, and the
    // only meaningful one for a non-dependant success.
    screen = { kind: 'contacts', dependant: pending.dependant }
  } else if (result.reason === 'rejected') {
    screen = { kind: 'rejected', pending }
  } else if (result.reason === 'invalid') {
    screen = { kind: 'invalid', pending }
  } else {
    screen = { kind: 'unavailable', pending }
  }
  store.notify()
}

// ---------------------------------------------------------------------------
// Camera scanning — the dependant screen's primary path and the bunker-link
// screen's fallback. The camera itself lives in qr-scan.ts (shared with
// guardian-link pairing, plan 2 Task 7); this only wires it to the screen.
// ---------------------------------------------------------------------------

function stopScan(): void {
  stopQrScan()
}

function startScan(mode: 'bunker' | 'dependant', value: string): Promise<void> {
  return startQrScan((text) => {
    stopQrScan()
    void connectBunkerLink(text, mode)
    return true
  }, {
    // Fix round 1, finding 5: the screen may have moved on (Back, Stop
    // scanning, a fresh scan started for the OTHER mode) while getUserMedia
    // was awaiting the camera permission prompt/hardware — wiring this
    // stream up now would leak a live camera onto whatever screen is
    // showing instead.
    stillWanted: () => screen.kind === 'link' && screen.scanning,
    onCameraError: () => {
      screen = { kind: 'link', mode, value, scanning: false, error: "Couldn't open the camera — paste the link instead." }
      store.notify()
    },
  })
}

/** Moves the persistent `<video>` element into the current render's scan
 *  mount point, if the active screen wants scanning. Called from app.ts's
 *  render(), same idiom as its own `mountMap`. */
export function mountScanner(): void {
  if (screen.kind !== 'link' || !screen.scanning) return
  mountQrScanner()
}

// ---------------------------------------------------------------------------
// Actions — dispatched from app.ts's handleAction for every `signin-*`
// action, same delegation idiom as every other domain module.
// ---------------------------------------------------------------------------

export function handleAction(action: string, _node: HTMLElement): void {
  if (action === 'signin-nip55') {
    void connectNip55()
  } else if (action === 'signin-go-qr') {
    void connectQr(store.load())
  } else if (action === 'signin-go-link') {
    screen = { kind: 'link', mode: 'bunker', value: '', scanning: false }
    store.notify()
  } else if (action === 'signin-go-dependant') {
    screen = { kind: 'link', mode: 'dependant', value: '', scanning: true }
    store.notify()
    void startScan('dependant', '')
  } else if (action === 'signin-cancel-qr') {
    cancelQr()
  } else if (action === 'signin-link-submit') {
    if (screen.kind === 'link') void connectBunkerLink(inputValue('signin-bunker-link') || screen.value, screen.mode)
  } else if (action === 'signin-link-scan-start') {
    if (screen.kind === 'link') {
      const mode = screen.mode
      screen = { ...screen, scanning: true, error: undefined }
      store.notify()
      void startScan(mode, screen.value)
    }
  } else if (action === 'signin-link-scan-stop') {
    stopScan()
    if (screen.kind === 'link') screen = { ...screen, scanning: false }
    store.notify()
  } else if (action === 'signin-back') {
    stopScan()
    screen = { kind: 'welcome' }
    store.notify()
  } else if (action === 'signin-sign') {
    if (screen.kind === 'explain') void doSign(screen.pending)
  } else if (action === 'signin-retry') {
    if (screen.kind === 'rejected' || screen.kind === 'invalid' || screen.kind === 'unavailable') void doSign(screen.pending)
  } else if (action === 'signin-retry-from-scratch' || action === 'signin-cancel-explain') {
    if (screen.kind === 'rejected' || screen.kind === 'invalid' || screen.kind === 'unavailable' || screen.kind === 'explain') abandonPending(screen.pending)
    screen = { kind: 'welcome' }
    store.notify()
  } else if (action === 'signin-hint-continue') {
    screen = { kind: 'welcome' }
    store.notify()
  } else if (action === 'signin-contacts-continue') {
    // Plan 2 (Task 10): "Skip for now" / "Continue" — same handler either
    // way (skipping never blocks anything downstream; the connect flow, if
    // one is mid-way, just keeps running in the background via
    // contacts-view.ts's own module-level state). `screen.dependant` (not
    // `pending`, out of scope here) says what to move on to.
    if (screen.kind === 'contacts') screen = screen.dependant ? { kind: 'keep-running-hint' } : { kind: 'welcome' }
    store.notify()
  } else if (action === 'signin-sign-out') {
    void doSignOut()
  }
}

/** Fix round 1, finding 7e: `session.signOut()` can throw (its own doc
 *  comment: a Keystore error still propagates after its OWN cleanup runs)
 *  — this module's cleanup must not be skipped because of that. Errors are
 *  caught and logged rather than left to reject an unhandled promise (this
 *  is called via `void doSignOut()` above, so nothing else is there to
 *  catch it), and `resetForSignOut()`/`store.notify()` always run, in a
 *  `finally`.
 *
 *  Task 12 fix round 1: exported as the ONE hardened sign-out routine every
 *  caller outside this module's own "Sign out" button should use too — a
 *  bare `session.signOut()` would skip `resetForSignOut()` (leaving a stale
 *  `screen` behind) and let a Keystore error reject uncaught. Devices.ts
 *  calls this both for "remove THIS phone" and (via beacons.ts's
 *  `applyRevocation`) for a revocation of this phone arriving from another
 *  of this identity's own devices. Never throws. */
export async function doSignOut(): Promise<void> {
  try {
    await session.signOut()
  } catch (e) {
    console.error('Sign out failed', e)
  } finally {
    resetForSignOut()
    // Final review B, finding 1 and finding 9: the shared contacts-connect
    // screen and this module's own Family-section state must not carry over
    // to whoever signs in next either — same reasoning as this module's own
    // `resetForSignOut()` above.
    contactsView.resetForSignOut()
    linkPairing.resetForSignOut()
    store.notify()
  }
}

function inputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? ''
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

// `p` isn't read by any screen today (nothing here shows per-store data) —
// kept as a parameter so app.ts's call site stays `signin.view(p)`, the
// same shape every other domain module's `view()` takes.
export function view(_p: store.Persisted): string {
  switch (screen.kind) {
    case 'welcome': return welcomeView(screen)
    case 'qr': return qrView(screen)
    case 'link': return linkView(screen)
    case 'explain': return explainView(screen)
    case 'rejected': return rejectedView()
    case 'invalid': return invalidView()
    case 'unavailable': return unavailableView()
    case 'contacts': return contactsStepView()
    case 'keep-running-hint': return keepRunningHintView()
  }
}

function welcomeView(s: Extract<Screen, { kind: 'welcome' }>): string {
  const err = s.error ? `<p class="form-error">${esc(s.error)}</p>` : ''
  const nip55Btn = isNativePlatform() && installedNip55 && installedNip55.length > 0
    ? `<button type="button" data-action="signin-nip55">Use My Signet on this phone</button>`
    : ''
  return `
    <h1 class="wordmark">Sign in with My Signet</h1>
    ${err}
    <div class="onboarding-choices">
      ${nip55Btn}
      <button type="button" data-action="signin-go-qr">Connect with a QR code</button>
      <button type="button" data-action="signin-go-link">I have a bunker link</button>
      <button type="button" data-action="signin-go-dependant">Set up a dependant's phone</button>
    </div>
  `
}

function qrView(s: Extract<Screen, { kind: 'qr' }>): string {
  return `
    <h1>Connect with a QR code</h1>
    <p class="muted">Open My Signet on your phone, scan this code, and approve Kindependence's access.</p>
    ${qrImgTag(s.uri, 'My Signet connection QR code')}
    <p class="muted">Waiting for approval…</p>
    <button type="button" data-action="signin-cancel-qr">Cancel</button>
  `
}

function linkView(s: Extract<Screen, { kind: 'link' }>): string {
  const heading = s.mode === 'dependant' ? "Set up a dependant's phone" : 'I have a bunker link'
  const intro = s.mode === 'dependant'
    ? "Scan the code My Signet shows for pairing a dependant's phone."
    : 'Paste the bunker link from My Signet, or scan its QR code.'
  const err = s.error ? `<p class="form-error">${esc(s.error)}</p>` : ''
  const scanBlock = s.scanning
    ? `<div id="signin-scan-mount" class="qr-scan-mount"></div><button type="button" data-action="signin-link-scan-stop">Stop scanning</button>`
    : `<button type="button" data-action="signin-link-scan-start">Scan a QR code</button>`
  return `
    <h1>${esc(heading)}</h1>
    <p class="muted">${esc(intro)}</p>
    ${scanBlock}
    <input id="signin-bunker-link" type="text" placeholder="bunker://…" value="${esc(s.value)}" />
    ${err}
    <button type="button" data-action="signin-link-submit">Connect</button>
    <button type="button" data-action="signin-back">Back</button>
  `
}

function explainView(s: Extract<Screen, { kind: 'explain' }>): string {
  const parentLine = s.pending.dependant ? '<p class="muted">Your parent will be asked on their phone.</p>' : ''
  return `
    <h1>Almost there</h1>
    <p class="muted">My Signet will ask you to sign 'app state'. This lets this phone send circle messages for you without asking each time. You can remove the phone later in Devices.</p>
    ${parentLine}
    <button type="button" data-action="signin-sign"${s.signing ? ' disabled' : ''}>${s.signing ? 'Signing in…' : 'Continue'}</button>
    <button type="button" data-action="signin-cancel-explain"${s.signing ? ' disabled' : ''}>Cancel</button>
  `
}

function rejectedView(): string {
  return `
    <h1>Not approved</h1>
    <p class="muted">My Signet didn't approve this device. You can try again, or start over.</p>
    <button type="button" data-action="signin-retry">Try again</button>
    <button type="button" data-action="signin-retry-from-scratch">Start over</button>
  `
}

// Fix round 1, finding 7c: distinct copy from `rejectedView` — this is a
// statement that came back signed but didn't verify, not an explicit "no"
// from the signer (see `attemptSignIn`'s own doc comment on the
// distinction).
function invalidView(): string {
  return `
    <h1>Something didn't check out</h1>
    <p class="muted">My Signet signed the statement, but it didn't verify. You can try again, or start over.</p>
    <button type="button" data-action="signin-retry">Try again</button>
    <button type="button" data-action="signin-retry-from-scratch">Start over</button>
  `
}

function unavailableView(): string {
  return `
    <h1>Open My Signet and try again</h1>
    <p class="muted">My Signet didn't answer in time. Make sure it's open, then try again.</p>
    <button type="button" data-action="signin-retry">Try again</button>
    <button type="button" data-action="signin-retry-from-scratch">Start over</button>
  `
}

/** Plan 2 (Task 10): the "Connect your contacts" step, skippable — the
 *  actual connect UI (explanation, the NIP-55/QR path, the waiting/Connected
 *  states) is contacts-view.ts's own `connectScreenView`, shared with the
 *  You tab and the disconnected banner's inline reconnect; this just wraps
 *  it with the step's heading and its own Skip/Continue. */
function contactsStepView(): string {
  const self = session.currentSession()
  const label = contactsView.isConnected() ? 'Continue' : 'Skip for now'
  return `
    <h1>Connect your contacts</h1>
    ${self ? contactsView.connectScreenView(self) : ''}
    <button type="button" data-action="signin-contacts-continue">${esc(label)}</button>
  `
}

function keepRunningHintView(): string {
  return `
    <h1>One more thing</h1>
    <p class="muted">Ask your parent to turn on My Signet's keep-running mode, so approvals reach them.</p>
    <button type="button" data-action="signin-hint-continue">Continue</button>
  `
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

/** Test seam: resets every bit of this module's own state back to its
 *  cold-start default — the screen, any in-flight QR wait, and the
 *  NIP-55-availability cache — so each test starts from 'welcome' regardless
 *  of what an earlier test in the same file left behind. */
export function resetForTests(): void {
  qrAbort?.abort()
  qrAbort = null
  stopScan()
  screen = { kind: 'welcome' }
  onSignedIn = null
  installedNip55 = null
  checkingNip55 = false
}
