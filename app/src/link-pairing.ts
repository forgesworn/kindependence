// In-person guardian-link pairing, family circles and dependant rejoin
// (plan 2, Task 7; spec §7). The Family section of the You tab.
//
// Protocol:
// 1. Guardian: "Add a dependant" shows a QR of `linkUri(identityPk, phonePk,
//    secret)` — a fresh one-time secret (`newLinkSecret`, 10 minutes).
// 2. The dependant's phone scans it (`dependantScanned`): it signs
//    `dependantOfTemplate(g)` directly with the identity signer (one
//    guardian tap in My Signet; not a circle structural action, so not the
//    queue) and gift-wraps, sealed by its phone key, a `t:'link-pair'`
//    rumor `{ s, d, statement }` to the guardian's phone inbox.
// 3. The guardian's phone (`onLinkPair`, routed from circles.ts's phone
//    inbox) checks the secret (known, unused, younger than 10 minutes —
//    marked used before any await), `d` (a dependant-of naming us), and
//    `statement` (the sealing phone's own device statement, of `d`'s
//    signer — proof of possession), then signs `guardianOfTemplate(D)` and
//    stores the pair (`acceptLinkPair`).
// 4. The guardian adds the dependant to a family circle (an existing one,
//    or one created on the spot through `createCircleNow`) with
//    `inviteDependantToCircle`. The dependant's statement goes into that
//    circle's phone-key table (`acceptStatement`: buffered until they're on
//    the roster), so the invite can be wrapped to their phone. A dependant
//    already on circles we share (a new phone, or re-pairing) is re-invited
//    everywhere (`reinviteDependantEverywhere`, decision 11), their new
//    phone bound in each.
// 5. The pair is posted as `t:'link'` into every circle holding both of us
//    — once the dependant is on the other members' rosters (the receive
//    rule needs both pks to be members): after we post a config for that
//    circle, or when a config adds them.
// Either side unlinks from the Family section: an identity-signed unlink,
// posted into every shared circle.

import * as store from './store.js'
import * as circles from './circles.js'
import * as beacons from './beacons.js'
import { currentSession, identitySigner, phoneSigner } from './session.js'
import { STRUCTURAL_SIGN_TIMEOUT_MS, waitingCopy } from './structural-queue.js'
import { SignerUnavailable } from './remote-signer.js'
import { dependantOfTemplate, guardianOfTemplate, unlinkTemplate, verifyDeviceStatement, verifyLinkStatement } from './device-statements.js'
import { acceptLinkPair, acceptUnlink, linked, linkEvents, dependantsOf, guardiansOf } from './guardian-links.js'
import { acceptStatement } from './phone-keys.js'
import { snapshot, contactTier } from './contacts.js'
import { startQrScan, stopQrScan, mountQrScanner } from './qr-scan.js'
import { qrImgTag } from './qr.js'
import { KINDS } from 'canary-kit/nostr'
import { personalInboxTag } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftWrap, publishSigned } from '@forgesworn/roost-kit'
import type { Rumor, SignedEvent } from '@forgesworn/roost-kit'
import { npubEncode } from 'nostr-tools/nip19'

export const LINK_URI_PREFIX = 'kindependence-link:'
/** How long a pairing secret is accepted. */
export const LINK_SECRET_LIFE_SEC = 600
/** Secrets older than this are pruned whenever a new one is written. */
const LINK_SECRET_PRUNE_SEC = 86_400

const HEX64 = /^[0-9a-f]{64}$/
const nowSec = (): number => Math.floor(Date.now() / 1000)

export function linkUri(guardianPk: string, guardianPhonePk: string, secret: string): string {
  return `${LINK_URI_PREFIX}?g=${guardianPk}&p=${guardianPhonePk}&s=${secret}`
}

/** The guardian pk, guardian phone pk and secret from a scanned pairing QR,
 *  or null unless all three are present as lowercase 64-hex. */
export function parseLinkUri(text: string): { g: string; p: string; s: string } | null {
  if (typeof text !== 'string') return null
  const t = text.trim()
  if (!t.startsWith(`${LINK_URI_PREFIX}?`)) return null
  const q = new URLSearchParams(t.slice(LINK_URI_PREFIX.length + 1))
  const g = q.get('g')
  const p = q.get('p')
  const s = q.get('s')
  if (!g || !p || !s || !HEX64.test(g) || !HEX64.test(p) || !HEX64.test(s)) return null
  return { g, p, s }
}

/** A fresh one-time pairing secret (32 bytes, hex), stored in `linkSecrets`
 *  as unused; secrets older than a day are pruned. */
export function newLinkSecret(nowSecArg: number): string {
  const secret = Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, '0')).join('')
  store.update((p) => {
    const kept = Object.entries(p.linkSecrets).filter(([, e]) => e.createdAt > nowSecArg - LINK_SECRET_PRUNE_SEC)
    p.linkSecrets = Object.fromEntries([...kept, [secret, { createdAt: nowSecArg, used: false }]])
  })
  return secret
}

// ---------------------------------------------------------------------------
// Screen state (render-on-state, like circles.ts's `uiView`)
// ---------------------------------------------------------------------------

type Screen =
  | { kind: 'idle'; notice?: string }
  | { kind: 'qr'; secret: string }
  | { kind: 'scan'; error?: string }
  | { kind: 'sending' }
  | { kind: 'sent' }
  | { kind: 'retry-send'; text: string; notice: string }
  | { kind: 'signing'; dependantPk: string }
  | { kind: 'retry-sign'; dependantPk: string; notice: string }
  | { kind: 'choose'; dependantPk: string; notice?: string }
  | { kind: 'confirm-unlink'; pk: string }

let screen: Screen = { kind: 'idle' }

/** A verified pairing request waiting for our own guardian-of signature
 *  (kept for "Try again" when My Signet doesn't answer). */
interface Verified { d: SignedEvent; statement: SignedEvent; sealPk: string; dependantPk: string }
let awaitingSign: Verified | null = null
/** The dependant just linked, and their phone's statement, while we choose
 *  a family circle for them. */
let paired: Verified | null = null

function show(next: Screen): void {
  screen = next
  store.notify()
}

// ---------------------------------------------------------------------------
// Dependant side
// ---------------------------------------------------------------------------

/** The dependant phone's step 2. Throws `SignerUnavailable` /
 *  `SignerRejected` from the identity signer (the screen offers "Try
 *  again"). */
export async function dependantScanned(text: string): Promise<'sent' | 'invalid' | 'not-dependant'> {
  const self = currentSession()
  if (!self?.dependant) return 'not-dependant'
  const link = parseLinkUri(text)
  if (!link || link.g === self.identityPk || link.p === self.phonePk || !self.statement) return 'invalid'
  const d = await identitySigner({ timeoutMs: STRUCTURAL_SIGN_TIMEOUT_MS }).signEvent(dependantOfTemplate(link.g, nowSec()))
  const v = verifyLinkStatement(d)
  if (!v || v.kind !== 'dependant-of' || v.signerPk !== self.identityPk || v.otherPk !== link.g) return 'invalid'
  const rumor = {
    kind: KINDS.signal,
    tags: [['t', circles.LINK_PAIR_SIGNAL_TYPE]],
    content: JSON.stringify({ s: link.s, d: v.event, statement: self.statement }),
  }
  const wrap = await giftWrap(phoneSigner(), link.p, rumor, personalInboxTag(link.p))
  await publishSigned(circles.appRelays(store.load()), wrap as unknown as { id: string; sig: string; [k: string]: unknown })
  return 'sent'
}

async function runDependantScanned(text: string): Promise<void> {
  show({ kind: 'sending' })
  try {
    const r = await dependantScanned(text)
    if (r === 'sent') show({ kind: 'sent' })
    else show({ kind: 'scan', error: r === 'invalid' ? "That isn't a Kindependence pairing code." : 'Only a dependant phone links this way.' })
  } catch (e) {
    const notice = e instanceof SignerUnavailable
      ? "My Signet didn't answer — ask your parent to approve, then try again."
      : "Your parent didn't approve linking."
    show({ kind: 'retry-send', text, notice })
  }
}

// ---------------------------------------------------------------------------
// Guardian side
// ---------------------------------------------------------------------------

/** The guardian phone's step 3. See the module doc comment. */
export async function onLinkPair(rumor: Rumor, sealPk: string): Promise<'linked' | 'rejected'> {
  const self = currentSession()
  if (!self || self.dependant) return 'rejected'
  if (rumor.kind !== KINDS.signal || rumor.tags.find((t) => t[0] === 't')?.[1] !== circles.LINK_PAIR_SIGNAL_TYPE) return 'rejected'
  let raw: unknown
  try { raw = JSON.parse(rumor.content) } catch { return 'rejected' }
  if (!raw || typeof raw !== 'object') return 'rejected'
  const { s, d, statement } = raw as { s?: unknown; d?: unknown; statement?: unknown }
  if (typeof s !== 'string' || !HEX64.test(s)) return 'rejected'
  const now = nowSec()
  // The secret is spent on first use, before any await: a replay, or a
  // second message racing this one, finds it used.
  let secretAt = null as number | null
  store.update((p) => {
    const entry = Object.hasOwn(p.linkSecrets, s) ? p.linkSecrets[s] : undefined
    if (!entry || entry.used || now - entry.createdAt >= LINK_SECRET_LIFE_SEC || entry.createdAt > now) return
    entry.used = true
    secretAt = entry.createdAt
  })
  if (secretAt === null) return 'rejected'
  const vd = verifyLinkStatement(d)
  if (!vd || vd.kind !== 'dependant-of' || vd.otherPk !== self.identityPk) return 'rejected'
  // Signed for this pairing: not before the secret existed, not far ahead.
  if (vd.createdAt < secretAt - beacons.LINK_MAX_SKEW_SEC || vd.createdAt > now + beacons.LINK_MAX_SKEW_SEC) return 'rejected'
  const st = verifyDeviceStatement(statement)
  if (!st || st.phonePk !== sealPk || st.identityPk !== vd.signerPk) return 'rejected'
  if (store.load().revokedPhoneKeys[sealPk]) return 'rejected'
  return signAndLink({ d: vd.event, statement: st.event, sealPk, dependantPk: vd.signerPk })
}

/** Signs our guardian-of for a verified request and stores the pair; then
 *  re-adds a dependant already on circles we share and offers a family
 *  circle. */
async function signAndLink(v: Verified): Promise<'linked' | 'rejected'> {
  const self = currentSession()
  if (!self) return 'rejected'
  awaitingSign = v
  show({ kind: 'signing', dependantPk: v.dependantPk })
  let g: SignedEvent
  try {
    g = await identitySigner({ timeoutMs: STRUCTURAL_SIGN_TIMEOUT_MS }).signEvent(guardianOfTemplate(v.dependantPk, nowSec()))
  } catch (e) {
    if (e instanceof SignerUnavailable) {
      show({ kind: 'retry-sign', dependantPk: v.dependantPk, notice: "My Signet didn't answer. Open it, then try again." })
    } else {
      awaitingSign = null
      show({ kind: 'idle', notice: 'Linking was declined in My Signet.' })
    }
    return 'rejected'
  }
  awaitingSign = null
  if (!acceptLinkPair(g, v.d) || !linked(self.identityPk, v.dependantPk)) {
    show({ kind: 'idle', notice: "Couldn't link — start again." })
    return 'rejected'
  }
  paired = v
  // Rejoin (decision 11): their (new) phone is bound in every circle we
  // share, and they are re-invited to each.
  const shared = sharedCircles(self.identityPk, v.dependantPk)
  for (const c of shared) acceptStatement(c, v.statement, v.sealPk, nowSec())
  const n = shared.length ? circles.reinviteDependantEverywhere(v.dependantPk) : 0
  for (const c of shared) postLinksInto(c)
  show({ kind: 'choose', dependantPk: v.dependantPk, notice: n ? `Re-adding ${nameOf(v.dependantPk)} to ${n} circle${n === 1 ? '' : 's'} — ${waitingCopy()}.` : undefined })
  return 'linked'
}

/** Circles both `a` and `b` are members of. */
function sharedCircles(a: string, b: string): Circle[] {
  return store.load().circles.filter((c) => c.members.some((m) => m.pk === a) && c.members.some((m) => m.pk === b))
}

/** Final review B, finding 9: a double tap on "New family circle" (creates
 *  two circles) or "Add to X" (sends two invites) before the first call's
 *  own `await` settles — both buttons funnel through this one function, so
 *  one guard covers both. */
let addingToCircle = false

/** Step 4: adds the dependant just paired to `circleId`, or to a new
 *  family circle when null. */
async function addToFamilyCircle(circleId: string | null): Promise<void> {
  const self = currentSession()
  const v = paired
  if (!self || !v || addingToCircle) return
  addingToCircle = true
  try {
    const id = circleId ?? circles.createCircleNow(`${self.name}'s family`)
    const c = id ? store.load().circles.find((x) => x.id === id) : undefined
    if (!c) return
    acceptStatement(c, v.statement, v.sealPk, nowSec())
    show({ kind: 'choose', dependantPk: v.dependantPk, notice: `Adding ${nameOf(v.dependantPk)} to ${c.name} — ${waitingCopy()}.` })
    await circles.inviteDependantToCircle(c.id, v.dependantPk)
  } finally {
    addingToCircle = false
  }
}

/** Step 5: `${circleId}:${g.id}:${d.id}` of each pair posted this run. */
const posted = new Set<string>()

/** Posts each of our guardian links whose dependant is on `circle` (and so
 *  are we) — once per pair and circle per run. */
function postLinksInto(circle: Circle): void {
  const self = currentSession()
  if (!self || self.dependant || !circle.members.some((m) => m.pk === self.identityPk)) return
  for (const dep of dependantsOf(self.identityPk)) {
    if (!circle.members.some((m) => m.pk === dep)) continue
    const pair = linkEvents(self.identityPk, dep)
    if (!pair) continue
    const key = `${circle.id}:${pair.g.id}:${pair.d.id}`
    if (posted.has(key)) continue
    posted.add(key)
    void beacons.postLink(circle, { g: pair.g, d: pair.d }).catch(() => { posted.delete(key) })
  }
}

// ---------------------------------------------------------------------------
// Unlink (either side)
// ---------------------------------------------------------------------------

/** Signs an unlink naming `otherPk`, applies it and posts it into every
 *  circle we share with them. False when not linked or not signed. */
export async function unlink(otherPk: string): Promise<boolean> {
  const self = currentSession()
  if (!self || !(linked(self.identityPk, otherPk) || linked(otherPk, self.identityPk))) return false
  let ev: SignedEvent
  try {
    ev = await identitySigner({ timeoutMs: STRUCTURAL_SIGN_TIMEOUT_MS }).signEvent(unlinkTemplate(otherPk, nowSec()))
  } catch {
    return false
  }
  if (!acceptUnlink(ev)) return false
  for (const c of sharedCircles(self.identityPk, otherPk)) await beacons.postLink(c, { unlink: ev })
  return true
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

let registered = false
/** Registers the phone-inbox `t:'link-pair'` handler and the link-posting
 *  hooks. Idempotent. */
export function ensure(): void {
  if (registered) return
  registered = true
  circles.setLinkPairHandler(onLinkPair)
  circles.registerConfigSentHandler(postLinksInto)
  circles.registerMemberAddedHandler((c) => postLinksInto(c))
}

/** Final review B, finding 9: forgets this module's own state on sign-out —
 *  without it, the next signed-in identity could see the previous
 *  guardian's "choose a family circle" screen (`paired`/`awaitingSign`
 *  carrying over), and a scan left running on the You tab (`screen: 'scan'`)
 *  would keep the camera open past sign-out. Called from signin.ts's
 *  `doSignOut()`, the app's one hardened sign-out routine. */
export function resetForSignOut(): void {
  screen = { kind: 'idle' }
  awaitingSign = null
  paired = null
  posted.clear()
  addingToCircle = false
  stopQrScan()
}

/** Test seam: same reset, under the name every other module's tests use. */
export function resetForTests(): void {
  resetForSignOut()
}

/** Stops a scan left running when the You tab is left (app.ts). */
export function leave(): void {
  if (screen.kind !== 'scan') return
  stopQrScan()
  screen = { kind: 'idle' }
}

/** Moves the camera into the scan screen's mount (app.ts's render()). */
export function mountScanner(): void {
  if (screen.kind === 'scan') mountQrScanner()
}

function startScan(): void {
  show({ kind: 'scan' })
  void startQrScan((text) => {
    if (screen.kind !== 'scan') return true
    if (!parseLinkUri(text)) return false // keep looking
    void runDependantScanned(text)
    return true
  }, {
    stillWanted: () => screen.kind === 'scan',
    onCameraError: () => { if (screen.kind === 'scan') show({ kind: 'scan', error: "Couldn't open the camera." }) },
  })
}

export function handleAction(action: string, node: HTMLElement): void {
  const self = currentSession()
  if (!self) return
  if (action !== 'link-scan') stopQrScan()
  if (action === 'link-add-dependant') {
    if (self.dependant) return
    show({ kind: 'qr', secret: newLinkSecret(nowSec()) })
  } else if (action === 'link-scan') {
    if (self.dependant) startScan()
  } else if (action === 'link-retry-send') {
    if (screen.kind === 'retry-send') void runDependantScanned(screen.text)
  } else if (action === 'link-retry-sign') {
    if (awaitingSign) void signAndLink(awaitingSign)
  } else if (action === 'link-add-to-circle') {
    const id = node.dataset.circle
    if (id) void addToFamilyCircle(id)
  } else if (action === 'link-new-family-circle') {
    void addToFamilyCircle(null)
  } else if (action === 'link-unlink') {
    const pk = node.dataset.pk
    if (pk) show({ kind: 'confirm-unlink', pk })
  } else if (action === 'link-unlink-confirm') {
    if (screen.kind !== 'confirm-unlink') return
    const pk = screen.pk
    show({ kind: 'idle', notice: 'Approve the unlink in My Signet.' })
    void unlink(pk).then((ok) => show({ kind: 'idle', notice: ok ? `Unlinked from ${nameOf(pk)}.` : "Couldn't unlink — try again." }))
  } else if (action === 'link-done' || action === 'link-cancel') {
    paired = null
    awaitingSign = null
    show({ kind: 'idle' })
  }
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

function nameOf(pk: string): string {
  const fromContacts = contactTier(snapshot(), pk).name
  if (fromContacts) return fromContacts
  for (const c of store.load().circles) {
    const n = c.members.find((m) => m.pk === pk)?.name
    if (n) return n
  }
  try {
    const n = npubEncode(pk)
    return `${n.slice(0, 12)}…${n.slice(-6)}`
  } catch {
    return pk.slice(0, 12)
  }
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

function linksList(selfPk: string, dependant: boolean): string {
  const others = dependant ? guardiansOf(selfPk) : dependantsOf(selfPk)
  if (!others.length) return `<p class="muted">${dependant ? 'Not linked with a parent yet.' : 'No dependants linked yet.'}</p>`
  return `<ul>${others.map((pk) => `
    <li>${esc(nameOf(pk))}${dependant ? ' (your parent)' : ' (your dependant)'}
      <button type="button" data-action="link-unlink" data-pk="${esc(pk)}">Unlink</button></li>`).join('')}</ul>`
}

function chooseView(p: store.Persisted, selfPk: string, dependantPk: string, notice?: string): string {
  const name = esc(nameOf(dependantPk))
  const options = p.circles
    .filter((c) => c.members.some((m) => m.pk === selfPk) && !c.members.some((m) => m.pk === dependantPk))
    .map((c) => `<button type="button" data-action="link-add-to-circle" data-circle="${esc(c.id)}">Add to ${esc(c.name)}</button>`)
    .join('')
  return `
    <p>${name} is linked as your dependant.</p>
    ${notice ? `<p class="muted">${esc(notice)}</p>` : ''}
    <p class="muted">Add them to a family circle:</p>
    ${options}
    <button type="button" data-action="link-new-family-circle">New family circle</button>
    <button type="button" data-action="link-done">Done</button>
  `
}

export function view(p: store.Persisted): string {
  const self = currentSession()
  if (!self) return ''
  let body: string
  switch (screen.kind) {
    case 'qr':
      body = `
        ${qrImgTag(linkUri(self.identityPk, self.phonePk, screen.secret), 'Pairing code for a dependant\'s phone')}
        <p class="muted">On your dependant's phone, open Kindependence → You → Family → "Link with your parent" and scan this. It works once, for 10 minutes.</p>
        <button type="button" data-action="link-cancel">Cancel</button>`
      break
    case 'scan':
      body = `
        ${screen.error ? `<p class="form-error">${esc(screen.error)}</p>` : ''}
        <p class="muted">Scan the code on your parent's phone.</p>
        <div class="qr-scan-mount"></div>
        <button type="button" data-action="link-cancel">Stop scanning</button>`
      break
    case 'sending':
      body = `<p class="muted">Approve linking in My Signet — ${esc(waitingCopy())}.</p>`
      break
    case 'sent':
      body = `<p>Sent. Your parent's phone will add you to your family circle.</p><button type="button" data-action="link-done">Done</button>`
      break
    case 'retry-send':
      body = `<p class="form-error">${esc(screen.notice)}</p>
        <button type="button" data-action="link-retry-send">Try again</button>
        <button type="button" data-action="link-cancel">Cancel</button>`
      break
    case 'signing':
      body = `<p class="muted">Linking ${esc(nameOf(screen.dependantPk))} — approve in My Signet.</p>`
      break
    case 'retry-sign':
      body = `<p class="form-error">${esc(screen.notice)}</p>
        <button type="button" data-action="link-retry-sign">Try again</button>
        <button type="button" data-action="link-cancel">Cancel</button>`
      break
    case 'choose':
      body = chooseView(p, self.identityPk, screen.dependantPk, screen.notice)
      break
    case 'confirm-unlink':
      body = `<p>Unlink ${esc(nameOf(screen.pk))}? Linking again needs you both together in person.</p>
        <button type="button" data-action="link-unlink-confirm">Unlink</button>
        <button type="button" data-action="link-cancel">Cancel</button>`
      break
    default:
      body = `
        ${screen.notice ? `<p class="muted">${esc(screen.notice)}</p>` : ''}
        ${linksList(self.identityPk, self.dependant)}
        ${self.dependant
          ? '<button type="button" data-action="link-scan">Link with your parent</button>'
          : '<button type="button" data-action="link-add-dependant">Add a dependant</button>'}`
  }
  return `<section class="contact-group" id="family-card"><h2>Family</h2>${body}</section>`
}
