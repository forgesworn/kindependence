// Devices screen (Signet identity plan, Task 12, design spec §5): lists this
// identity's own phone keys across every circle it belongs to, and lets the
// signed-in identity remove one — an identity-signed revocation
// (device-statements.ts's `revocationTemplate`), posted `t:'revoke'` into
// every circle shared with this identity, applied locally through the exact
// same path a peer's copy arriving on the wire takes
// (`beacons.applyRevocation`), which re-keys every affected circle this
// device is a guardian in, without the removed phone (`beacons.ts`'s own
// doc comment on `applyRevocation`/`circles.ts`'s `phoneHoldsSeed`).
//
// The revocation is signed DIRECTLY with `identitySigner()` — never through
// structural-queue.ts's queue (that queue exists for events a slow/asleep
// signer should retry later; a phone removal is a one-shot confirmed action
// the person is waiting on right now, so a decline or a timeout is surfaced
// immediately instead of sitting in the queue for a retry). A declined
// (`SignerRejected`) or unavailable (`SignerUnavailable`) signature changes
// nothing locally or on the wire — no revocation is posted, no re-key is
// enqueued.
//
// Removing THIS device's own phone additionally signs out, once the
// revocation has been posted, via the SAME hardened routine
// (`signin.ts`'s `doSignOut`) beacons.ts's `applyRevocation` itself uses
// when a revocation of this device's own phone arrives over the wire
// instead (Task 12 fix round 1, item 1/2) — never a bare `session.signOut()`,
// which would skip signin.ts's own `resetForSignOut()` and let a Keystore
// error reject uncaught. The phone that would otherwise keep using
// kindependence is the one just deauthorised, so nothing here would let it
// carry on regardless.
//
// Same "own view()/handleAction(), called from app.ts" convention as every
// other domain module (milestones.ts, meet.ts, …); the two-tap
// same-button-relabels-itself confirm gate is activity.ts's own idiom
// (`clearRoutineConfirming`) — no confirm DIALOG idiom exists anywhere in
// this codebase (verified there, still true here).
//
// Plan 2 (Task 9, spec §7): also lists, under "Your dependants", the phones
// of every identity this session is a linked guardian of
// (guardian-links.ts's `dependantsOf`) — same phone-key-table source, keyed
// on the dependant's identity pk instead of this session's own. "Remove this
// phone" there signs the SAME revocation shape, but with THIS guardian's own
// identity as signer, never the dependant's; applied locally the same way,
// and (beacons.ts's `applyRevocation`) accepted by the dependant's own
// device as grounds to sign itself out, exactly as it would for its own
// signature.

import * as store from './store.js'
import { currentSession, identitySigner, type SessionInfo } from './session.js'
import { doSignOut } from './signin.js'
import { phonesOf } from './phone-keys.js'
import { revocationTemplate } from './device-statements.js'
import * as beacons from './beacons.js'
import { phoneHoldsSeed, inviteMyOtherPhone } from './circles.js'
import { dependantsOf } from './guardian-links.js'
import { contactTier, snapshot } from './contacts.js'
import { WAITING_FOR_SIGNET } from './structural-queue.js'
import { relativeTime } from './activity.js'
import { SignerRejected, SignerUnavailable } from './remote-signer.js'
import { isGuardian } from '@forgesworn/covey-kit'
import type { SignedEvent } from '@forgesworn/roost-kit'

const nowSec = (): number => Math.floor(Date.now() / 1000)

// ---------------------------------------------------------------------------
// Pure data — this identity's phone keys, deduplicated across circles.
// ---------------------------------------------------------------------------

export interface DeviceEntry {
  phonePk: string
  /** Whether this is the phone this code is currently running on. */
  own: boolean
  /** The device statement's `created_at` — when it was first authorised
   *  (the earliest, across every circle it's bound in). */
  addedAt: number
  /** The freshest `lastSeen` across every circle it's bound in. */
  lastSeen: number
  circleIds: string[]
}

/** This identity's phone keys across every circle `self` belongs to,
 *  deduplicated by phone pubkey (the same phone, once bound, carries the
 *  same statement into every circle it's posted to — see beacons.ts's
 *  `postStatement`). `own` first, then most-recently-seen first.
 *
 *  Only ever lists a phone bound (has a device statement accepted) into at
 *  least one of `self`'s circles — including THIS device's own: a phone
 *  with no circle yet (fresh sign-in, no circles joined) or whose statement
 *  hasn't landed anywhere yet doesn't appear at all, so "This phone" is
 *  absent from the list until it's actually bound somewhere, not shown as
 *  some placeholder/pending entry. */
export function deviceEntries(p: store.Persisted, self: SessionInfo): DeviceEntry[] {
  const byPhone = new Map<string, DeviceEntry>()
  for (const circle of p.circles) {
    for (const phonePk of phonesOf(circle.id, self.identityPk)) {
      const entry = p.phoneKeys[circle.id]?.[phonePk]
      if (!entry) continue
      const existing = byPhone.get(phonePk)
      if (existing) {
        existing.lastSeen = Math.max(existing.lastSeen, entry.lastSeen)
        existing.addedAt = Math.min(existing.addedAt, entry.statement.created_at)
        if (!existing.circleIds.includes(circle.id)) existing.circleIds.push(circle.id)
      } else {
        byPhone.set(phonePk, {
          phonePk, own: phonePk === self.phonePk,
          addedAt: entry.statement.created_at, lastSeen: entry.lastSeen,
          circleIds: [circle.id],
        })
      }
    }
  }
  return [...byPhone.values()].sort((a, b) => {
    if (a.own !== b.own) return a.own ? -1 : 1
    return b.lastSeen - a.lastSeen
  })
}

/** The task's controller-carried warning (brief: "Before enqueuing a re-key,
 *  if any remaining member has no known phone… show a warning line on the
 *  confirm dialog"): every guardian-role circle a removal of `phonePk`
 *  would actually re-key (`phoneHoldsSeed`, same set `applyRevocation`
 *  itself re-keys), checked for a member who — once `phonePk` no longer
 *  counts — has no other known phone left to receive the new seed. Pure
 *  read, never mutates; still allows proceeding (the caller only ever
 *  displays this, never blocks on it). */
export function membersWithoutPhoneAfterRemoval(
  p: store.Persisted, self: SessionInfo, phonePk: string,
): Array<{ memberName: string; circleName: string }> {
  const warnings: Array<{ memberName: string; circleName: string }> = []
  for (const circle of p.circles) {
    if (!isGuardian(circle, self.identityPk)) continue
    if (!phoneHoldsSeed(p, circle.id, phonePk)) continue
    for (const member of circle.members) {
      const remaining = phonesOf(circle.id, member.pk).filter((pk) => pk !== phonePk)
      if (remaining.length === 0) {
        warnings.push({ memberName: member.name || shortPk(member.pk), circleName: circle.name })
      }
    }
  }
  return warnings
}

function shortPk(pk: string): string {
  return `${pk.slice(0, 8)}…`
}

/** A display name for `pk`: the contacts grant's, else the name any held
 *  circle roster gives it, else a short id — same "best name we have"
 *  convention as circles.ts's/link-pairing.ts's own `nameOf`. */
function nameOf(p: store.Persisted, pk: string): string {
  const fromContacts = contactTier(snapshot(), pk).name
  if (fromContacts) return fromContacts
  for (const c of p.circles) {
    const n = c.members.find((m) => m.pk === pk)?.name
    if (n) return n
  }
  return shortPk(pk)
}

// ---------------------------------------------------------------------------
// "Your dependants" (Plan 2, Task 9, spec §7): this identity's linked
// dependants' phone keys, deduplicated the same way `deviceEntries` does for
// this identity's own — from the phone-key tables of every circle this
// device knows, this time keyed off each linked dependant's identity pk
// instead of `self`'s own.
// ---------------------------------------------------------------------------

export interface DependantDeviceEntry {
  dependantPk: string
  dependantName: string
  phonePk: string
  addedAt: number
  lastSeen: number
  circleIds: string[]
}

/** Every linked dependant's phones, across every circle `p` knows —
 *  `dependantsOf(self.identityPk)` (guardian-links.ts) decides who counts as
 *  a dependant; empty (no section shown) for a guardian with no links. */
export function dependantDeviceEntries(p: store.Persisted, self: SessionInfo): DependantDeviceEntry[] {
  const entries: DependantDeviceEntry[] = []
  for (const dependantPk of dependantsOf(self.identityPk)) {
    const byPhone = new Map<string, DependantDeviceEntry>()
    for (const circle of p.circles) {
      for (const phonePk of phonesOf(circle.id, dependantPk)) {
        const entry = p.phoneKeys[circle.id]?.[phonePk]
        if (!entry) continue
        const existing = byPhone.get(phonePk)
        if (existing) {
          existing.lastSeen = Math.max(existing.lastSeen, entry.lastSeen)
          existing.addedAt = Math.min(existing.addedAt, entry.statement.created_at)
          if (!existing.circleIds.includes(circle.id)) existing.circleIds.push(circle.id)
        } else {
          byPhone.set(phonePk, {
            dependantPk, dependantName: nameOf(p, dependantPk), phonePk,
            addedAt: entry.statement.created_at, lastSeen: entry.lastSeen, circleIds: [circle.id],
          })
        }
      }
    }
    entries.push(...[...byPhone.values()].sort((a, b) => b.lastSeen - a.lastSeen))
  }
  return entries
}

// ---------------------------------------------------------------------------
// Removal — signs the revocation directly (never the structural queue),
// posts it into every circle shared with this identity, and applies it
// locally through the exact re-key trigger the receive path uses.
// ---------------------------------------------------------------------------

export type RemovalResult = 'removed' | 'signed-out' | 'rejected' | 'unavailable'

/** Signs and posts a revocation for `phonePk`, then either applies it
 *  locally (the same re-key trigger a peer's copy of it takes — see this
 *  module's own doc comment) or, for THIS device's own phone, signs out via
 *  the hardened routine (`signin.ts`'s `doSignOut`). A declined
 *  (`SignerRejected`) or unavailable (`SignerUnavailable`) signature is
 *  reported back as `'rejected'`/`'unavailable'`, not raised, and changes
 *  nothing else — nothing is posted or applied. Anything else the signer or
 *  the crypto throws still propagates to the caller uncaught (there's
 *  nothing generic to say about it here); `confirmRemoval` below is what
 *  turns an unexpected throw into a user-facing notice, since this function
 *  itself has no UI state to update. */
export async function removePhone(phonePk: string): Promise<RemovalResult> {
  const self = currentSession()
  if (!self) return 'unavailable'
  let signed: SignedEvent
  try {
    signed = await identitySigner().signEvent(revocationTemplate(phonePk, nowSec()))
  } catch (e) {
    if (e instanceof SignerRejected) return 'rejected'
    if (e instanceof SignerUnavailable) return 'unavailable'
    throw e
  }
  const p = store.load()
  const shared = p.circles.filter((c) => c.members.some((m) => m.pk === self.identityPk))
  for (const circle of shared) {
    // giftWrap itself is the only thing here that can actually throw (a
    // crypto/signing hiccup) — publishOrEnqueue, which postRevocation calls
    // after it, never rejects on its own (network failure already falls
    // back to its outbox, retried on the next `online`/app start). Swallowed
    // per-circle so one circle's wrap failing doesn't stop posting to the
    // rest.
    await beacons.postRevocation(circle, signed).catch(() => { /* best-effort — see comment above */ })
  }
  if (phonePk === self.phonePk) {
    // Removing THIS device's own phone: the revocation is already posted
    // (above) for every other device and circle member to learn from, so
    // applying it locally first would be moot — the sign-out below wipes
    // the WHOLE local store (every phone-key table included) a moment
    // later regardless. No re-key is enqueued BY THIS DEVICE for any circle
    // it guards: `doSignOut` drops the session before one could be sent,
    // and — exactly like `beacons.ts`'s `applyRevocation` refuses to do for
    // the mirror case (a revocation of this phone ARRIVING over the wire,
    // item 1) — a fresh seed sent from a device that just revoked its own
    // key would have to list a now-untrusted recipient. Every affected
    // circle still gets re-keyed, just by another guardian device (this
    // identity's remaining phone, or a co-guardian's) once the SAME
    // revocation reaches it, not by this one.
    await doSignOut()
    return 'signed-out'
  }
  await beacons.applyRevocation(signed)
  return 'removed'
}

export type DependantRemovalResult = 'removed' | 'rejected' | 'unavailable'

/** Plan 2, Task 9 (spec §7 "for a dependant, the guardian revokes"): signs
 *  and posts a revocation for a linked dependant's phone (`phonePk`), signed
 *  by THIS guardian's own identity — never the dependant's — then applies it
 *  locally through the same trigger `removePhone` uses. Posted into every
 *  circle shared with the dependant (this identity is a member of, and so is
 *  the dependant), so any copy of that circle's phone-key table learns the
 *  key is dead. Never `'signed-out'`: this is always someone else's phone,
 *  so applying it locally never touches this device's own session — see
 *  beacons.ts's `applyRevocation`, which (Task 9) now also signs a
 *  dependant's OWN device out when a linked guardian's revocation of its own
 *  phone arrives there, the mirror of this action on the dependant's side. */
export async function removeDependantPhone(dependantPk: string, phonePk: string): Promise<DependantRemovalResult> {
  const self = currentSession()
  if (!self) return 'unavailable'
  let signed: SignedEvent
  try {
    signed = await identitySigner().signEvent(revocationTemplate(phonePk, nowSec()))
  } catch (e) {
    if (e instanceof SignerRejected) return 'rejected'
    if (e instanceof SignerUnavailable) return 'unavailable'
    throw e
  }
  const p = store.load()
  const shared = p.circles.filter((c) =>
    c.members.some((m) => m.pk === self.identityPk) && c.members.some((m) => m.pk === dependantPk))
  for (const circle of shared) {
    await beacons.postRevocation(circle, signed).catch(() => { /* best-effort — see removePhone's own comment */ })
  }
  await beacons.applyRevocation(signed)
  return 'removed'
}

// ---------------------------------------------------------------------------
// View — the You tab's "Devices" section (app.ts's `youView`).
// ---------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

/** Sign-out confirm gate (final fix B5/I5): a mistaken tap on "Sign out"
 *  used to wipe every circle seed on the device with no way back short of a
 *  fresh invite. Reuses this module's own two-tap confirm idiom (see
 *  `confirmingPhone` below), just with an explicit Cancel/Sign out pair
 *  instead of a same-button relabel, since the binding copy needs room for
 *  the warning sentence. */
let confirmingSignOut = false

/** Two-tap "Remove"/"Remove this phone" confirm gate, one phone armed at a
 *  time — same per-visit-only ephemeral module state as activity.ts's
 *  `clearRoutineConfirming`. */
let confirmingPhone: string | null = null
/** The busy phone (awaiting the identity signer) — shown as
 *  `WAITING_FOR_SIGNET`, the same copy structural-queue.ts's own waiting
 *  badge uses, even though this signs directly rather than through that
 *  queue. */
let busyPhone: string | null = null
/** The last removal attempt's own outcome copy, cleared on the next arm. */
let statusMessage: string | null = null

/** Final fix B7 (part A5 UI): the outcome copy of the last "Add my other
 *  phone" tap — either the accept-it-there instruction (queued) or
 *  `inviteMyOtherPhone()`'s own refusal reason. Cleared on the next tap. */
let addOtherPhoneStatus: string | null = null

/** Plan 2, Task 9: same two-tap "Remove this phone" confirm gate as
 *  `confirmingPhone`/`busyPhone` above, kept separate since a dependant's
 *  phone key is never this device's own (no sign-out branch, different
 *  reminder copy) and the row needs the dependant's pk alongside the phone's. */
let confirmingDependantPhone: string | null = null
let busyDependantPhone: string | null = null

export function view(p: store.Persisted): string {
  const self = currentSession()
  if (!self) return ''
  const entries = deviceEntries(p, self)
  const rows = entries.map((e) => deviceRowView(p, self, e)).join('')
  return `
    <section class="contact-group">
      <h2>Devices</h2>
      ${rows}
      ${statusMessage ? `<p class="muted small">${esc(statusMessage)}</p>` : ''}
      ${self.dependant ? '' : addOtherPhoneView()}
      ${signOutView()}
    </section>
    ${dependantsView(p, self)}
  `
}

/** Plan 2, Task 9 (spec §7): "Your dependants" — each linked dependant's
 *  phones, with a "Remove this phone" a linked guardian signs. Absent
 *  entirely (not just empty) for a guardian with no linked dependants. */
function dependantsView(p: store.Persisted, self: SessionInfo): string {
  const entries = dependantDeviceEntries(p, self)
  if (!entries.length) return ''
  const rows = entries.map((e) => dependantDeviceRowView(e)).join('')
  return `
    <section class="contact-group">
      <h2>Your dependants</h2>
      ${rows}
    </section>
  `
}

/** Final fix B7 (part A5 UI): invites this identity's own other phone into
 *  every circle it's on (`circles.inviteMyOtherPhone()`, final fix A5) —
 *  hidden for a dependant session, which can't invite in plan 1 (final fix
 *  A8). */
function addOtherPhoneView(): string {
  const status = addOtherPhoneStatus ? `<p class="muted small">${esc(addOtherPhoneStatus)}</p>` : ''
  return `
    <div class="contact-item">
      <button type="button" data-action="devices-add-other-phone">Add my other phone</button>
      ${status}
    </div>
  `
}

/** Final fix B5/I5: sign-out confirm step, same "armed inline block, own
 *  Cancel button" shape as `deviceRowView`'s remove-confirm below — the
 *  binding copy: "Sign out? This removes your circles from this phone. You
 *  can be invited back." */
function signOutView(): string {
  if (confirmingSignOut) {
    return `
      <div class="contact-item">
        <p>Sign out? This removes your circles from this phone. You can be invited back.</p>
        <div class="actions">
          <button type="button" data-action="devices-sign-out-cancel">Cancel</button>
          <button type="button" data-action="devices-sign-out-confirm">Sign out</button>
        </div>
      </div>
    `
  }
  return `<button type="button" data-action="devices-sign-out">Sign out</button>`
}

function deviceRowView(p: store.Persisted, self: SessionInfo, e: DeviceEntry): string {
  const label = e.own ? 'This phone' : `Phone added ${formatDate(e.addedAt)}, last seen ${relativeTime(e.lastSeen, nowSec())}`
  if (busyPhone === e.phonePk) {
    return `<div class="contact-item">${esc(label)}<span class="badge">${esc(WAITING_FOR_SIGNET)}</span></div>`
  }
  if (confirmingPhone === e.phonePk) {
    const warnings = membersWithoutPhoneAfterRemoval(p, self, e.phonePk)
      .map((w) => `<p class="muted small">${esc(w.memberName)} has no known phone in ${esc(w.circleName)}; they will need a new invite.</p>`)
      .join('')
    return `
      <div class="contact-item">
        ${esc(label)}
        ${warnings}
        <div class="actions">
          <button type="button" data-action="devices-remove-confirm" data-pk="${esc(e.phonePk)}">Tap again to confirm</button>
          <button type="button" data-action="devices-remove-cancel">Cancel</button>
        </div>
      </div>
    `
  }
  // Task 12 fix round 1, item 4 (minor): while ANY phone is mid-removal
  // (`busyPhone` set to some OTHER phone — this row would have hit the
  // first branch above if it were the busy one), every other row's own
  // Remove button is disabled — a second removal started concurrently
  // would race the first's post/apply/sign-out against this row's own.
  const disabled = busyPhone !== null ? ' disabled' : ''
  return `
    <div class="contact-item">
      ${esc(label)}
      <button type="button" data-action="devices-remove" data-pk="${esc(e.phonePk)}"${disabled}>${e.own ? 'Remove this phone' : 'Remove'}</button>
    </div>
  `
}

function formatDate(atSec: number): string {
  return new Date(atSec * 1000).toLocaleDateString()
}

/** Plan 2, Task 9: a linked dependant's phone row — same busy/confirm/plain
 *  three-state shape as `deviceRowView`, just keyed on `busyDependantPhone`/
 *  `confirmingDependantPhone` and always labelled "Remove this phone" (the
 *  brief's exact copy — never the bare "Remove" `deviceRowView` uses for a
 *  non-own phone in the guardian's OWN device list). */
function dependantDeviceRowView(e: DependantDeviceEntry): string {
  const label = `${esc(e.dependantName)} — phone added ${formatDate(e.addedAt)}, last seen ${relativeTime(e.lastSeen, nowSec())}`
  if (busyDependantPhone === e.phonePk) {
    return `<div class="contact-item">${label}<span class="badge">${esc(WAITING_FOR_SIGNET)}</span></div>`
  }
  if (confirmingDependantPhone === e.phonePk) {
    return `
      <div class="contact-item">
        ${label}
        <div class="actions">
          <button type="button" data-action="devices-remove-dependant-confirm" data-pk="${esc(e.phonePk)}" data-dependant="${esc(e.dependantPk)}">Tap again to confirm</button>
          <button type="button" data-action="devices-remove-dependant-cancel">Cancel</button>
        </div>
      </div>
    `
  }
  const disabled = busyDependantPhone !== null ? ' disabled' : ''
  return `
    <div class="contact-item">
      ${label}
      <button type="button" data-action="devices-remove-dependant" data-pk="${esc(e.phonePk)}" data-dependant="${esc(e.dependantPk)}"${disabled}>Remove this phone</button>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Action dispatch — app.ts delegates every `devices-*` data-action here.
// ---------------------------------------------------------------------------

export function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'devices-remove': {
      // Item 4: a disabled button shouldn't normally dispatch at all, but
      // `busyPhone` is checked here too — belt-and-braces against anything
      // that bypasses the HTML `disabled` attribute (a stale render, a
      // direct dispatch in a test).
      const pk = node.dataset.pk
      if (pk && busyPhone === null) { confirmingPhone = pk; statusMessage = null; store.notify() }
      break
    }
    case 'devices-remove-cancel':
      confirmingPhone = null
      store.notify()
      break
    case 'devices-remove-confirm': {
      const pk = node.dataset.pk
      if (pk) void confirmRemoval(pk)
      break
    }
    case 'devices-sign-out':
      confirmingSignOut = true
      store.notify()
      break
    case 'devices-sign-out-cancel':
      confirmingSignOut = false
      store.notify()
      break
    case 'devices-sign-out-confirm':
      void confirmSignOut()
      break
    case 'devices-add-other-phone': {
      const refused = inviteMyOtherPhone()
      addOtherPhoneStatus = refused ?? 'Open Kindependence on your other phone and accept the invites.'
      store.notify()
      break
    }
    case 'devices-remove-dependant': {
      const pk = node.dataset.pk
      if (pk && busyDependantPhone === null) { confirmingDependantPhone = pk; statusMessage = null; store.notify() }
      break
    }
    case 'devices-remove-dependant-cancel':
      confirmingDependantPhone = null
      store.notify()
      break
    case 'devices-remove-dependant-confirm': {
      const pk = node.dataset.pk
      const dependantPk = node.dataset.dependant
      if (pk && dependantPk) void confirmDependantRemoval(dependantPk, pk)
      break
    }
    default:
      break
  }
}

/** The confirmed second tap (final fix B5/I5): disarms the confirm step and
 *  runs the same hardened sign-out routine the old one-tap button called
 *  directly. Exported for direct testing, same convention as
 *  `confirmRemoval` above. */
export async function confirmSignOut(): Promise<void> {
  confirmingSignOut = false
  store.notify()
  await doSignOut()
}

/** The confirmed second tap: arms `busyPhone` for the `WAITING_FOR_SIGNET`
 *  badge, runs `removePhone`, and turns its result into the row's final
 *  status copy. Exported for direct testing (same "action handler's own
 *  async work is directly testable" convention as milestones.ts's
 *  `applyLevel`).
 *
 *  Task 12 fix round 1, item 2: wrapped in try/finally so `busyPhone`
 *  ALWAYS clears — a bare `await removePhone(...)` with no `finally` would
 *  leave the row stuck on `WAITING_FOR_SIGNET` forever if anything beyond
 *  the two signatures `removePhone` itself handles (`SignerRejected`/
 *  `SignerUnavailable`) throws (a network/crypto failure while posting,
 *  say — `removePhone`'s own doc comment). This is called via `void
 *  confirmRemoval(pk)` from `handleAction`, so nothing else is there to
 *  catch an unexpected throw either; it becomes a generic notice instead of
 *  an unhandled rejection. */
export async function confirmRemoval(phonePk: string): Promise<void> {
  confirmingPhone = null
  busyPhone = phonePk
  statusMessage = null
  store.notify()
  try {
    const result = await removePhone(phonePk)
    statusMessage = result === 'rejected' ? 'Not approved'
      : result === 'unavailable' ? "Waiting for My Signet — try again when it's open"
      : result === 'removed' ? 'Also cut this phone off in My Signet.'
      : null // 'signed-out' — doSignOut() already tore this screen down.
  } catch {
    statusMessage = "Couldn't remove the phone."
  } finally {
    busyPhone = null
    store.notify()
  }
}

/** Plan 2, Task 9: the dependant-row mirror of `confirmRemoval` above — same
 *  arm/busy/status shape, `removeDependantPhone` in place of `removePhone`,
 *  and the brief's exact reminder copy naming the dependant on success
 *  ("never 'signed-out'" — see `removeDependantPhone`'s own doc comment). */
export async function confirmDependantRemoval(dependantPk: string, phonePk: string): Promise<void> {
  confirmingDependantPhone = null
  busyDependantPhone = phonePk
  statusMessage = null
  store.notify()
  try {
    const result = await removeDependantPhone(dependantPk, phonePk)
    statusMessage = result === 'rejected' ? 'Not approved'
      : result === 'unavailable' ? "Waiting for My Signet — try again when it's open"
      : `Also remove the pairing for ${nameOf(store.load(), dependantPk)} in My Signet.`
  } catch {
    statusMessage = "Couldn't remove the phone."
  } finally {
    busyDependantPhone = null
    store.notify()
  }
}

/** Test seam: disarms every bit of this module's own ephemeral UI state —
 *  same "reset between tests" idiom every domain module's own test file
 *  needs for module-level view state. */
export function resetForTests(): void {
  confirmingPhone = null
  busyPhone = null
  statusMessage = null
  confirmingSignOut = false
  addOtherPhoneStatus = null
  confirmingDependantPhone = null
  busyDependantPhone = null
}
