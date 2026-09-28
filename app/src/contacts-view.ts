// Contacts UI (plan 2, Task 10): the connect screen (sign-in step, You-tab
// entry point, and the disconnected banner's own inline reconnect — all
// three share the SAME screen state below, since only one grant can ever be
// pending at a time), the top-of-tab banner, and the trust-prompt cards
// (trust-watch.ts's own `TrustPrompt`s — this module only renders them and
// routes an answer back to `answerPrompt`; it never decides who counts as
// usable or removes anyone itself). Same render-on-state / data-action
// idiom as every other domain module (see places.ts/devices.ts).
//
// "added by <name>" / "started this circle" / the Remove-vs-Leave gating on
// a circle's own member row are circles.ts's own job (it already holds
// `voucherOf`/`creatorOf`/`mayRemove`) — not duplicated here.

import * as store from './store.js'
import { snapshot, contactTier } from './contacts.js'
import { beginPairing, grantedCapabilities, type PendingPairing } from './contacts-grant.js'
import { prompts, answerPrompt, type TrustPrompt } from './trust-watch.js'
import { currentSession } from './session.js'
import type { SessionInfo } from './session.js'
import { qrImgTag } from './qr.js'
import * as nip55 from './nip55.js'
import { npubEncode } from 'nostr-tools/nip19'

export const BANNER_TEXT = 'Contacts disconnected — reconnect My Signet'
export const CONNECT_CONTACTS_LABEL = 'Connect contacts'
export const OPEN_MY_SIGNET_LABEL = 'Open My Signet'
export const DEPENDANT_SCAN_HINT = 'Ask your guardian to scan this in My Signet.'
export const CONNECTED_LABEL = 'Connected'
export const RECONNECT_LABEL = 'Reconnect'
export const WAITING_CANCEL_LABEL = 'Cancel'
export const EXPLAIN_TEXT = "Kindependence only shows you the people you've met in My Signet."
export const BULK_PROMPT_HEADER = 'Several people changed in My Signet:'
export const CODE_COPY_PREFIX = 'Type this code into My Signet: '
export const CODE_CONFIRM_LABEL = 'My Signet says it matches — Continue'
export const CODE_CANCEL_LABEL = "It didn't match / Cancel"
export const NARROWED_TIER_NOTICE =
  "Kindependence needs the Kin, Kith and Ken labels to know who you've met. Reconnect and tick them in My Signet."
export const NARROWED_BLOCKS_NOTICE =
  "Blocked people can't be hidden until you tick 'who you have blocked' in My Signet."
export const NEEDED_CAPS_HINT =
  "In My Signet, tick all three: contact names, Kin, Kith and Ken labels, and people you've blocked. Kindependence needs all three to work."
const CONNECT_FAILED_NOTICE = "Couldn't connect — try again."

// ---------------------------------------------------------------------------
// Screen state — one inline connect flow shared by every entry point (the
// sign-in step, the You-tab "Connect contacts" button, and the disconnected
// banner's own reconnect tap). Ephemeral, in memory only, same convention as
// signin.ts's/link-pairing.ts's own `screen`.
// ---------------------------------------------------------------------------

type Screen =
  | { kind: 'idle' }
  | { kind: 'waiting'; uri: string }
  | { kind: 'confirming'; code: string; confirm: PendingPairing['confirm']; cancel: PendingPairing['cancel'] }
  | { kind: 'connected' }
  | { kind: 'failed'; notice: string }

let screen: Screen = { kind: 'idle' }

/** Whether the connect flow just finished (used by signin.ts to swap its
 *  own step's "Skip for now" for "Continue" once there's something to
 *  continue past). */
export function isConnected(): boolean {
  return screen.kind === 'connected'
}

/** Device check 2026-09-26, fix 6: a plain `window.open(uri, '_blank')` on
 *  the `signet-grant:` scheme makes Android show an "Open with" chooser as
 *  soon as more than one app answers it (My Signet's release build
 *  alongside its own acceptance build, say) — targets the session's own
 *  signer package directly instead, via `Nip55Plugin.openUri`'s
 *  `ACTION_VIEW` + `setPackage`. Falls back to the plain `window.open` (the
 *  one case that DOES let Android choose) when no package is known, or the
 *  native plugin call itself fails — web/dev, where the plugin isn't
 *  registered at all, lands here too. */
async function openSignerUri(uri: string, packageName: string | undefined): Promise<void> {
  if (packageName) {
    try {
      await nip55.openUri({ uri, packageName })
      return
    } catch {
      // Fall through — better a chooser than nothing opening at all.
    }
  }
  if (typeof window !== 'undefined' && typeof window.open === 'function') window.open(uri, '_blank')
}

async function startConnect(): Promise<void> {
  // Device check 2026-09-26, fix 2: `mine` is THIS attempt's own "waiting"
  // screen object — Cancel (`handleAction`, below) moves `screen` away from
  // it immediately (back to idle). The `await wait` below can still resolve
  // afterwards (a late ack, or the SDK's own timeout) — `screen !== mine`
  // then means someone has already moved on (a cancel, or a newer connect
  // attempt), so that result is dropped rather than resurfacing as a code
  // screen or clobbering whatever is current now.
  let mine: Screen | null = null
  try {
    const { uri, wait } = await beginPairing()
    mine = { kind: 'waiting', uri }
    screen = mine
    store.notify()
    const self = currentSession()
    if (self?.transport.kind === 'nip55') {
      // Decision 9's Android launch, reused here: the grant URI itself IS
      // the target (unlike the "Meet in person" ken button, which has
      // nothing to point at) — My Signet registers the `signet-grant:`
      // scheme, so this is a direct navigation, no `intent:` wrapping
      // needed.
      await openSignerUri(uri, self.transport.packageName)
    }
    const result = await wait
    if (screen !== mine) return
    screen =
      result === false
        ? { kind: 'failed', notice: CONNECT_FAILED_NOTICE }
        : { kind: 'confirming', code: result.code, confirm: result.confirm, cancel: result.cancel }
  } catch {
    if (mine && screen !== mine) return
    screen = { kind: 'failed', notice: CONNECT_FAILED_NOTICE }
  }
  store.notify()
}

// ---------------------------------------------------------------------------
// Connect screen — reused by signin.ts's own step, the You tab, and the
// banner's inline reconnect.
// ---------------------------------------------------------------------------

export function connectScreenView(self: SessionInfo): string {
  const explain = `<p class="muted">${esc(EXPLAIN_TEXT)}</p>`
  if (screen.kind === 'connected') {
    const notice = narrowedGrantNoticeHtml()
    // Device check 2026-09-26, fix 1: the narrowed-grant notice had no way
    // to act on it — "Reconnect and tick them in My Signet" pointed at
    // nothing. Same `contacts-connect` action as the idle screen's own
    // Connect button, so a fresh pairing starts exactly the same way (see
    // `handleAction`) — no separate code path to keep in sync.
    const reconnect = notice ? `<button type="button" data-action="contacts-connect">${esc(RECONNECT_LABEL)}</button>` : ''
    return `${explain}<p>${esc(CONNECTED_LABEL)}</p>${notice}${reconnect}<button type="button" data-action="contacts-connect-done">Done</button>`
  }
  if (screen.kind === 'confirming') {
    // Security MUST (signet-contacts docs/WIRE.md §"Pairing verification
    // code"): always shown, for every ack — never skipped or hidden based
    // on anything the ack itself claims. Nothing has been persisted,
    // fetched, or started yet; `confirm`/`cancel` (routed via handleAction)
    // are the only two ways out of this screen.
    return `${explain}
      <p>${esc(CODE_COPY_PREFIX)}<strong>${esc(screen.code)}</strong></p>
      <button type="button" data-action="contacts-code-confirm">${esc(CODE_CONFIRM_LABEL)}</button>
      <button type="button" data-action="contacts-code-cancel">${esc(CODE_CANCEL_LABEL)}</button>`
  }
  if (screen.kind === 'waiting') {
    // Device check 2026-09-26, fix 2: this screen used to have no way out —
    // Cancel returns to idle, whose own Connect/Open My Signet button
    // already serves as "Try again".
    const cancelBtn = `<button type="button" data-action="contacts-connect-cancel">${esc(WAITING_CANCEL_LABEL)}</button>`
    if (self.transport.kind === 'nip55') {
      return `${explain}<p class="muted">Waiting for My Signet…</p>${cancelBtn}`
    }
    return `${explain}
      ${qrImgTag(screen.uri, 'My Signet contacts pairing code')}
      <p class="muted">${esc(NEEDED_CAPS_HINT)}</p>
      <p class="muted">${self.dependant ? esc(DEPENDANT_SCAN_HINT) : 'Scan this with My Signet.'}</p>
      <p class="muted">Waiting for My Signet…</p>${cancelBtn}`
  }
  // idle or failed
  const notice = screen.kind === 'failed' ? `<p class="form-error">${esc(screen.notice)}</p>` : ''
  const label = self.transport.kind === 'nip55' ? OPEN_MY_SIGNET_LABEL : CONNECT_CONTACTS_LABEL
  return `${explain}${notice}<p class="muted">${esc(NEEDED_CAPS_HINT)}</p><button type="button" data-action="contacts-connect">${esc(label)}</button>`
}

/** My Signet's own grant screen leaves "Kin, Kith and Ken labels" and "who
 *  you have blocked" unticked by default — `awaitPairingAck` accepts a
 *  narrowed grant rather than rejecting it (contacts without tiers are
 *  simply not usable, as today). Shown alongside the connected state on
 *  both the connect screen and the You tab. */
function narrowedGrantNoticeHtml(): string {
  const caps = grantedCapabilities()
  if (!caps) return ''
  const notices: string[] = []
  if (!caps.includes('signet.contacts.read:tier')) notices.push(NARROWED_TIER_NOTICE)
  if (!caps.includes('signet.contacts.blocks.read')) notices.push(NARROWED_BLOCKS_NOTICE)
  return notices.map((n) => `<p class="muted">${esc(n)}</p>`).join('')
}

// ---------------------------------------------------------------------------
// Banner — top of the Circles and You tabs (app.ts), disconnected only.
// ---------------------------------------------------------------------------

export function bannerView(): string {
  if (snapshot().status !== 'disconnected') return ''
  if (screen.kind === 'idle' || screen.kind === 'failed') {
    const notice = screen.kind === 'failed' ? `<p class="form-error">${esc(screen.notice)}</p>` : ''
    return `<section class="contact-group banner">${notice}<button type="button" data-action="contacts-connect">${esc(BANNER_TEXT)}</button></section>`
  }
  const self = currentSession()
  return self ? `<section class="contact-group banner">${connectScreenView(self)}</section>` : ''
}

// ---------------------------------------------------------------------------
// You tab — replaces app.ts's old `contactsPlaceholderView`.
// ---------------------------------------------------------------------------

export function youContactsView(): string {
  const self = currentSession()
  if (!self) return ''
  const s = snapshot()
  // The banner (top of tab) already covers a disconnected grant — no second
  // "reconnect" affordance down here too.
  if (s.status === 'disconnected') return ''
  if (s.status === 'connected' && screen.kind === 'idle') {
    const count = s.contacts.length
    return `<section class="contact-group"><h2>Contacts</h2><p class="muted">${esc(CONNECTED_LABEL)} — ${count} contact${count === 1 ? '' : 's'}.</p>${narrowedGrantNoticeHtml()}</section>`
  }
  return `<section class="contact-group"><h2>Contacts</h2>${connectScreenView(self)}</section>`
}

// ---------------------------------------------------------------------------
// Trust prompts (trust-watch.ts produces these; this module only renders
// and routes them).
// ---------------------------------------------------------------------------

function shortNpub(pk: string): string {
  try {
    const n = npubEncode(pk)
    return `${n.slice(0, 12)}…${n.slice(-6)}`
  } catch {
    return pk.slice(0, 12)
  }
}

/** `pk`'s display name: the contacts grant's, else any held roster's, else
 *  a short npub — same fallback order as circles.ts's own `nameOf`
 *  (duplicated rather than imported, to keep this module from depending on
 *  circles.ts at all — see the module doc comment). */
function displayName(pk: string): string {
  const fromContacts = contactTier(snapshot(), pk).name
  if (fromContacts) return fromContacts
  for (const c of store.load().circles) {
    const n = c.members.find((m) => m.pk === pk)?.name
    if (n) return n
  }
  return shortNpub(pk)
}

function promptCardView(pr: TrustPrompt): string {
  if (pr.kind === 'absent') {
    const name = esc(displayName(pr.pks[0] ?? ''))
    return `<section class="contact-group trust-prompt">
      <p>${name} is no longer in your contacts. Remove from circles?</p>
      <button type="button" data-action="contacts-prompt-remove" data-prompt="${esc(pr.id)}">Remove</button>
      <button type="button" data-action="contacts-prompt-keep" data-prompt="${esc(pr.id)}">Keep</button>
    </section>`
  }
  const items = pr.pks.map((pk) => `<li>${esc(displayName(pk))}</li>`).join('')
  return `<section class="contact-group trust-prompt">
    <p>${esc(BULK_PROMPT_HEADER)}</p>
    <ul>${items}</ul>
    <button type="button" data-action="contacts-prompt-remove" data-prompt="${esc(pr.id)}">Remove all</button>
    <button type="button" data-action="contacts-prompt-keep" data-prompt="${esc(pr.id)}">Keep all</button>
  </section>`
}

export function promptsView(): string {
  return prompts().map(promptCardView).join('')
}

// ---------------------------------------------------------------------------
// Actions — app.ts delegates every `contacts-*` data-action here.
// ---------------------------------------------------------------------------

export function handleAction(action: string, node: HTMLElement): void {
  if (action === 'contacts-connect') {
    void startConnect()
  } else if (action === 'contacts-connect-done') {
    screen = { kind: 'idle' }
    store.notify()
  } else if (action === 'contacts-connect-cancel') {
    // Device check 2026-09-26, fix 2: just moving `screen` off 'waiting' is
    // enough — `startConnect`'s own `screen !== mine` check (above) drops
    // whatever this attempt's `wait` later resolves with, ack or timeout
    // alike, instead of resurfacing it as a code screen.
    if (screen.kind === 'waiting') screen = { kind: 'idle' }
    store.notify()
  } else if (action === 'contacts-code-confirm') {
    if (screen.kind === 'confirming') {
      const pending = screen
      void (async () => {
        await pending.confirm()
        // A sign-out/identity-change raced this confirmation: `confirm()`
        // is then a no-op (contacts-grant.ts's own guard), and this screen
        // has already been reset elsewhere (`resetForSignOut`) — only move
        // to "connected" if this is still the SAME confirming screen (not
        // reset, and not a newer connect attempt) that was just confirmed.
        if (screen === pending) screen = { kind: 'connected' }
        store.notify()
      })()
    }
  } else if (action === 'contacts-code-cancel') {
    if (screen.kind === 'confirming') {
      screen.cancel()
      screen = { kind: 'idle' }
      store.notify()
    }
  } else if (action === 'contacts-prompt-remove') {
    const id = node.dataset.prompt
    if (id) answerPrompt(id, true)
  } else if (action === 'contacts-prompt-keep') {
    const id = node.dataset.prompt
    if (id) answerPrompt(id, false)
  }
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

/** Final review B, finding 1: resets the shared connect-flow screen on
 *  sign-out — an in-flight "waiting for My Signet" or a just-finished
 *  "Connected" must not carry over to whoever signs in next (this screen
 *  state is shared across every entry point — see the module doc comment
 *  above). Called from signin.ts's `doSignOut()`, the app's one hardened
 *  sign-out routine. */
export function resetForSignOut(): void {
  // Security MUST: a pairing code on screen at sign-out must be discarded,
  // never left to be confirmed into whoever signs in next. `cancel()` is
  // also a no-op-safe defence in depth alongside contacts-grant.ts's own
  // session watch, which independently discards the same pairing.
  if (screen.kind === 'confirming') screen.cancel()
  screen = { kind: 'idle' }
}

/** Test seam: same reset, under the name every other module's tests use. */
export function resetForTests(): void {
  resetForSignOut()
}
