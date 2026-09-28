// Messaging: person-to-person DMs, circle chat, and a set of structured
// quick-chips that reuse EXISTING wire (brief §23, §16.4, §14.3). Same
// render-on-state idiom as every other domain module here: `ensure()`
// registers this module's receive-side handlers with beacons.ts/circles.ts
// (idempotent, called from app.ts's render()); `view()`/`handleAction()` own
// the chat overlay's UI; the pure reducer/builder section below is
// unit-tested in isolation.
//
// SUPERSEDED BELOW (interop honesty pass, Phase 7 Task 5 review queue item
// 5): the two-wire-path picture immediately below — "no new wire types...
// circle chat is flock's REAL buzz mechanism" — describes the PRE-Phase-7-
// Task-3 world and is no longer accurate for circle chat/quick-chips; kept
// as-is for its still-correct DM-path description and self-echo/actionable-
// vs-ordinary reasoning, NOT for the circle-chat wire claim. The current,
// accurate picture (kindependence's own `t:'kindependence-msg'` type, plus which two
// chips DO still ride a real flock coordination action) is documented at the
// "Circle chat — Phase 7 Task 3 migration" block below (search for that
// heading) and at `handleIncomingSignal`'s own doc comment.
//
// Two DISTINCT wire paths — genuinely different mechanisms, not just
// different addressing of the same one (see the FOLLOW-UP FIX note below
// for why an earlier version of this file got that wrong for circle chat):
//   - Person-to-person DM: covey-kit's OWN `buildDmWrap`/`readDmWrap`
//     (`{t:'dm', c, text}`, inner kind 14) over the PERSONAL inbox
//     (`sendToPersonalInbox` — gift-wrapped to the recipient's real key,
//     filed under `personalInboxTag`). This IS genuinely wire-identical to
//     flock — flock's own personal-inbox DM uses the exact same covey-kit
//     shape. Received via circles.ts's existing personal-inbox subscription
//     — this module registers a handler there (`circles.setPersonalDmHandler`)
//     rather than opening a second subscription, same "one inbound stream,
//     many registered handlers" discipline beacons.ts's `setSignalHandler`
//     already established.
//   - Circle chat: flock's REAL circle-chat mechanism (verified against
//     flock's own source) is an UNTARGETED `t:'buzz'` signal (kind 20078)
//     whose `reason` field IS the message text — the same buzz builder
//     (`@forgesworn/flock/buzz`'s `buildBuzzSignal`) safety.ts's own check-in
//     already uses, just with no `target`. Flock's own app.ts threads every
//     buzz it receives into its chat feed (`appendChat`) regardless of
//     `reason` — buzz.ts's own doc comment: "the friendly counterpart to
//     help... a parent buzzes a child 'come home', or any member nudges the
//     group" is describing a CHAT message, not a notification-only ping.
//     Received via beacons.ts's existing circle-inbox subscription, riding
//     the SAME `signalHandlers` dispatch every other buzz/help/findreq
//     handler already uses — no special-cased dispatch branch needed (see
//     `classifyIncomingBuzz` below for the receive-side precedence rules).
//
// FOLLOW-UP FIX (post-review, corrects the original Task 5 landing): the
// first version of circle chat here sent a bare kind-14 rumor (covey-kit's
// personal-inbox DM shape) addressed to the CIRCLE's shared inbox instead of
// a member's personal one, and claimed that was "wire-identical" to flock.
// It was not, and the "wire-identical" framing was simply wrong: a bare
// kind-14 rumor carries no `t` tag, and every real flock client's
// circle-inbox dispatcher switches on the `t` tag to decide what a signal
// even is (see beacons.ts's own `signalHandlers` doc comment) — a `t`-less
// rumor falls through unrecognised and is silently dropped by any real
// flock device. It was internally consistent (this app's own sender and
// receiver agreed with each other) but never actually interoperable with
// flock, which is the entire point of vendoring flock's wire in the first
// place. `buildCircleDmWrap`/`decodeCircleDmRumor` and beacons.ts's
// `CIRCLE_DM_RUMOR_KIND`/`setDmHandler` plumbing that carried it are GONE —
// replaced by the untargeted-buzz mechanism described above, which really
// is what a real flock client sends and understands.
//
// Self-echo: a circle inbox is shared, so this device's own circle-chat send
// is delivered back to its own subscription — every send below applies its
// own reducer to local state SYNCHRONOUSLY before the network publish (never
// waiting on the round trip), and the receive path unconditionally ignores
// anything whose resolved sender (`sender.signerPk`, Signet identity plan
// Task 9) is this device's own phone key — same discipline as
// agreements.ts/safety.ts's own receive paths. A personal-inbox DM has NO
// self-echo (addressed to the recipient's real key only, never our own), so
// its local insert at send time is the thread's only copy on this device.
//
// Structured quick-chips (§23.2) reuse three DIFFERENT existing wire
// mechanisms depending on which one already fits the ask:
//   - A literal circle-chat send (free text, or a short recognisable phrase
//     — "Come home now", "Dinner ready", "Pick me up" — `detectStructuredDm`
//     below) rides the untargeted-buzz mechanism above and always becomes a
//     chat bubble, on every device that receives it (this one included, via
//     its own local insert at send time).
//   - "Can you check in?" and the self-report reasons ("I'm okay"/
//     "Arrived"/"Leaving now"/"Heading home") are ALSO flock buzz signals,
//     but sent TARGETED when the composer is a 1:1 DM (buzz.ts's own
//     semantics: `target` just makes that one peer's phone "buzz hardest" —
//     it does NOT make the buzz private, the whole circle still decrypts and
//     sees it either way) — and UNTARGETED when sent from circle chat. Per
//     `classifyIncomingBuzz`'s precedence rules below, a TARGETED send never
//     becomes a chat bubble (fire-and-forget, inline confirmation text only
//     — `composerStatus`), matching this app's original DM-composer
//     behaviour for these five; an UNTARGETED one (sent from circle chat)
//     DOES become a bubble, same as any other circle-chat send. Either way
//     it's recorded to Activity.
//   - "Request pickup" (guardian asking a specific child) links straight to
//     safety.ts's EXISTING `data-action="safety-pickup"` button — literally
//     the same findreq flow the person sheet already offers, just also
//     reachable from the chat composer. Fire-and-forget, no bubble, no code
//     here at all (app.ts's dispatcher already routes any `safety-*` action
//     to safety.ts).
// "Be home by…" is a fourth case, not really a "message" at all: it opens
// agreements.ts's existing proposal flow prefilled with the chat's child,
// and neither sends a chat bubble nor a wire event of its own — agreements.ts's
// own `proposeAgreement` records its own 'agreement-created' Activity entry
// once the guardian actually submits it.
//
// Actionable vs. ordinary (brief §23.4): only a STRUCTURED send/receive
// (`ChatMessage.structured` set — a recognised chip reason, structured DM
// phrase, or Task 6's `!precise-request:` prefix) calls
// `activity.recordActivity`; plain free-form chat text never does, whether
// it was typed by hand or happens to be flock's own preset buzz reasons
// (`DEFAULT_BUZZ_REASONS` — "Come home", "Where are you?", "Call me", "On my
// way" — none of which this app recognises as structured) or safety.ts's own
// `'Check in'` self-report (recorded to Activity independently, by safety.ts's
// own registered handler — see `classifyIncomingBuzz`'s doc comment).

import * as store from './store.js'
import type { ChatMessage } from './store.js'
import type { SessionInfo } from './session.js'
import * as beacons from './beacons.js'
import * as poolHealth from './pool-health.js'
import * as activity from './activity.js'
import * as agreements from './agreements.js'
import * as safety from './safety.js'
import * as places from './places.js'
import * as journey from './journey.js'
import * as pickup from './pickup.js'
import { appRelays, setPersonalDmHandler, selfRole } from './circles.js'
import { notify, shouldNotifyForEvent } from './notify.js'
import { precisionTerm } from './mapinfo.js'
import { currentSession, phoneSigner } from './session.js'
import { phonesOf } from './phone-keys.js'
import { deriveInbox, buildDmWrap } from '@forgesworn/covey-kit'
import type { Circle, DirectMessage } from '@forgesworn/covey-kit'
import { giftWrap } from '@forgesworn/roost-kit'
import type { Rumor, Signer, SignedEvent } from '@forgesworn/roost-kit'
import { buildBuzzSignal, decryptBuzz, BUZZ_SIGNAL_TYPE, RING_LOST_PHONE_ACTION, type Buzz } from '@forgesworn/flock/buzz'
import { KINDEPENDENCE_MSG_SIGNAL_TYPE, buildKindependenceMsgSignal, decodeLegacyBuzz, type LegacyBuzz } from './legacy-buzz.js'
import * as formState from './form-state.js'

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** Cap on each DM/circle-chat thread — task contract ("~200/peer"). */
export const MAX_THREAD = 200

// ---------------------------------------------------------------------------
// Pure reducers/builders — unit-tested in messages.test.ts. No store/network
// access anywhere in this section.
// ---------------------------------------------------------------------------

/** Deterministic id for a self-originated message — same
 *  `local-<kind>-<at>-…`-family synthetic-id convention as
 *  activity.ts's/safety.ts's own send-side ids, just keyed on (sender, time,
 *  text) instead of (kind, time, circle) since a thread has no separate
 *  "kind" of its own. Two IDENTICAL messages (same sender, same text) sent
 *  within the same wall-clock second collide and dedupe to one — same
 *  second-granularity trade-off every other synthetic id in this codebase
 *  already accepts. Never needs to match what the OTHER device computes on
 *  receipt (a personal DM has no self-echo to compare against; a circle-chat
 *  echo is filtered out by pubkey before dedupe-by-id is ever consulted —
 *  see the module doc comment) — only used within one device's own thread. */
export function dmMessageId(from: string, at: number, text: string): string {
  return `dm-${from}-${at}-${text}`
}

/** Inserts `msg` into `thread` at its chronological slot (oldest-first —
 *  chat reading order, the OPPOSITE of activity.ts's newest-first feed),
 *  deduped by id, capped at `cap` by dropping the OLDEST when over (a chat
 *  thread's tail is its past, unlike Activity's — see store.ts's
 *  `ChatMessage` doc comment). Stable for equal `at`: a same-timestamp
 *  arrival lands AFTER every existing entry with that `at`, never
 *  displacing them. Returns the SAME array reference on a dedupe no-op. */
export function appendMessage(thread: readonly ChatMessage[], msg: ChatMessage, cap: number = MAX_THREAD): ChatMessage[] {
  if (thread.some((m) => m.id === msg.id)) return thread as ChatMessage[]
  const newerIdx = thread.findIndex((m) => m.at > msg.at)
  const at = newerIdx === -1 ? thread.length : newerIdx
  const next = [...thread.slice(0, at), msg, ...thread.slice(at)]
  return next.length > cap ? next.slice(next.length - cap) : next
}

/** Count of messages in `thread` from someone OTHER than `selfPk`, newer
 *  than `lastSeenAt` — the unread badge's whole computation (task contract:
 *  "simple lastSeen-per-thread"). A self-sent message never counts as
 *  unread. */
export function unreadCount(thread: readonly ChatMessage[], lastSeenAt: number, selfPk: string): number {
  return thread.filter((m) => m.from !== selfPk && m.at > lastSeenAt).length
}

/** Every quick-chip this module knows how to build — see the module doc
 *  comment for which of the three underlying wire mechanisms each one
 *  reuses. `'request-pickup'` is the one kind the VIEW renders as a plain
 *  `safety-pickup` button rather than dispatching through `handleChip`
 *  (see `chipsForThread`'s doc comment). */
export type ChipKind =
  | 'checkin-request' | 'status-okay' | 'status-arrived' | 'status-leaving' | 'status-heading-home'
  | 'come-home-now' | 'dinner-ready' | 'be-home-by' | 'pickup' | 'request-pickup'

/** Display label for every chip — the single source of truth the composer
 *  button text, the buzz `reason` fallback, and the matching Activity
 *  entry's `params.label` all draw from, so the three can never drift apart. */
export const CHIP_LABELS: Record<ChipKind, string> = {
  'checkin-request': 'Can you check in?',
  'status-okay': "I'm okay",
  'status-arrived': 'Arrived',
  'status-leaving': 'Leaving now',
  'status-heading-home': 'Heading home',
  'come-home-now': 'Come home now',
  'dinner-ready': 'Dinner ready',
  'be-home-by': 'Be home by…',
  pickup: 'Pick me up',
  'request-pickup': 'Request pickup',
}

/** Kinds sent as a flock buzz signal (brief §16.3/§16.4). Deliberately DIFFERENT
 *  wire `reason` strings from `CHIP_LABELS`'s display text — most importantly
 *  `'checkin-request'`'s `'Please check in'`, which must NOT equal safety.ts's
 *  own exact-match `'Check in'` (its `decodeCheckin` treats any buzz whose
 *  `reason === 'Check in'` as a self-report "I'm OK" SafetyEvent — see that
 *  file's own doc comment). A REQUEST-to-check-in is not a report that the
 *  sender themselves is OK, so it must be wire-distinguishable from one, or a
 *  guardian ASKING "can you check in?" would misfile as the CHILD having just
 *  announced they're fine — and, since the follow-up fix, would ALSO make
 *  `classifyIncomingBuzz` below double-record it (safety.ts's own 'checkin'
 *  Activity entry AND a conflicting 'message' one from this file). */
export type BuzzChipKind = 'checkin-request' | 'status-okay' | 'status-arrived' | 'status-leaving' | 'status-heading-home'
export const BUZZ_CHIP_REASONS: Record<BuzzChipKind, string> = {
  'checkin-request': 'Please check in',
  'status-okay': "I'm okay",
  'status-arrived': 'Arrived',
  'status-leaving': 'Leaving now',
  'status-heading-home': 'Heading home',
}
const REASON_TO_BUZZ_CHIP: Record<string, BuzzChipKind> = Object.fromEntries(
  (Object.entries(BUZZ_CHIP_REASONS) as Array<[BuzzChipKind, string]>).map(([kind, reason]) => [reason, kind]),
)

/** Pure payload for a buzz-based chip: `reason` (see `BUZZ_CHIP_REASONS`)
 *  plus `target` when sent from within a 1:1 DM (so that peer's phone
 *  "buzzes hardest" — buzz.ts's own semantics; still visible to the rest of
 *  the circle either way, since a buzz has no private-audience concept). */
export interface ChipBuzzPayload { reason: string; target?: string }
export function buzzChipPayload(kind: BuzzChipKind, target?: string): ChipBuzzPayload {
  return { reason: BUZZ_CHIP_REASONS[kind], ...(target ? { target } : {}) }
}

/** Kinds sent as a literal circle-chat (or personal-DM) text send (brief
 *  §14.3) — always a real chat bubble on both ends (see the module doc
 *  comment). */
export type StructuredDmKind = 'come-home-now' | 'dinner-ready' | 'pickup'
const STRUCTURED_DM_TEXT: Record<StructuredDmKind, string> = {
  'come-home-now': 'Come home now',
  'dinner-ready': 'Dinner ready',
  pickup: 'Pick me up',
}
export function structuredDmText(kind: StructuredDmKind): string {
  return STRUCTURED_DM_TEXT[kind]
}

/** Reverse lookup: does `text` (after trimming) match one of the structured
 *  DM phrases above? Used on BOTH send (labelling the sender's own local
 *  copy) and receive (labelling an incoming personal DM, or an incoming
 *  circle-chat buzz's `reason` — see `classifyIncomingBuzz`) — the wire
 *  carries no separate "this is structured" field (task contract: "reuses
 *  EXISTING wire, no new types"), so a plain flock client sees ordinary
 *  readable text either way; only THIS app additionally recognises the exact
 *  phrase and renders/records it as structured. A coincidental free-text
 *  match (someone typing "Dinner ready" by hand) is harmless — same
 *  content, same (correct) treatment. */
export function detectStructuredDm(text: string): StructuredDmKind | undefined {
  const trimmed = text.trim()
  for (const kind of Object.keys(STRUCTURED_DM_TEXT) as StructuredDmKind[]) {
    if (STRUCTURED_DM_TEXT[kind] === trimmed) return kind
  }
  return undefined
}

export interface ChatChip { kind: ChipKind; label: string }

/** Which chips are visible for a thread, purely from role/relationship —
 *  the task contract's "chips adapt to role (guardian vs child) and
 *  relationship". `peerPk` is the OTHER party in a 1:1 DM, or `undefined`
 *  for a circle-chat thread (no single peer — guardian-facing chips there
 *  gate on "is a guardian of ANY child in this circle" instead of one
 *  specific relationship). `'request-pickup'` is included in the returned
 *  list like any other chip (so its VISIBILITY rule lives in this one pure,
 *  testable function) but the view renders it as a plain `safety-pickup`
 *  button rather than routing it through `handleChip` — see the module doc
 *  comment for why that one chip is a direct link, not a new send. It's
 *  DM-only (a circle-wide "request pickup" has no single target child to
 *  ask). */
export function chipsForThread(circle: Circle, selfPk: string, peerPk: string | undefined): ChatChip[] {
  const selfMemberRole = circle.members.find((m) => m.pk === selfPk)?.role
  const peerMemberRole = peerPk ? circle.members.find((m) => m.pk === peerPk)?.role : undefined
  const hasChild = circle.members.some((m) => m.role === 'child')
  const hasGuardian = circle.members.some((m) => m.role === 'guardian')

  const chip = (kind: ChipKind): ChatChip => ({ kind, label: CHIP_LABELS[kind] })
  const chips: ChatChip[] = [
    chip('checkin-request'), chip('status-okay'), chip('status-arrived'), chip('status-leaving'), chip('status-heading-home'),
  ]

  const guardianForChild = peerPk ? selfMemberRole === 'guardian' && peerMemberRole === 'child' : selfMemberRole === 'guardian' && hasChild
  if (guardianForChild) {
    chips.push(chip('come-home-now'), chip('dinner-ready'), chip('be-home-by'))
    if (peerPk) chips.push(chip('request-pickup'))
  }

  const childForGuardian = peerPk ? selfMemberRole === 'child' && peerMemberRole === 'guardian' : selfMemberRole === 'child' && hasGuardian
  if (childForGuardian) chips.push(chip('pickup'))

  return chips
}

// ---------------------------------------------------------------------------
// Circle chat — Phase 7 Task 3 migration: kindependence's rich free-text/prefixed
// vocabulary no longer rides flock's `t:'buzz'` (upstream eb96ce0 made buzz a
// fixed coordination-action vocabulary whose `decryptBuzz` REJECTS free text —
// a new flock client would silently drop every circle-chat/place/journey/
// pickup/precise-request message we send). It rides kindependence's OWN inner type
// `t:'kindependence-msg'` instead, whose payload is byte-identical to the old buzz
// `{from, reason, target?, timestamp}` and is group-envelope encrypted with the
// exact same canary-kit primitives (see legacy-buzz.ts for the vendored codec).
// `buildKindependenceMsgWrap` is the pure-ish wire builder (impure only in the two
// crypto calls), directly round-trip testable against `decodeLegacyBuzz` — same
// "build → giftWrap → giftUnwrap → decode, without a relay" pattern safety.ts's
// own `buildCheckinWrap`/`decodeCheckin` pair uses. The classify/dispatch
// pipeline below is REUSED unchanged — only this transport seam moved.
// ---------------------------------------------------------------------------

/** Old flock buzz `MAX_REASON` cap (mirrored in legacy-buzz.ts) — circle chat
 *  rides a message's `reason` field, not covey's DM `text` (500 chars, the
 *  personal-DM branch's own cap, enforced inside `buildDmWrap` itself) — so
 *  free text typed into the circle-chat composer needs a TIGHTER cap.
 *  `buildKindependenceMsgSignal` itself throws past this length; capping here means
 *  a long paste is silently trimmed instead of the send failing outright. */
export const MAX_CIRCLE_CHAT_LEN = 280

/** Trims and caps free text (or a structured phrase) down to what a buzz
 *  `reason` can actually carry. Exported for the composer's `maxlength`
 *  hint and for direct testing. */
export function capCircleChatText(text: string): string {
  return text.trim().slice(0, MAX_CIRCLE_CHAT_LEN)
}

/** Builds the gift-wrapped `t:'kindependence-msg'` send for one circle — untargeted
 *  for an ordinary circle-chat send (free text, a `StructuredDmKind` phrase, or
 *  Task 6's `!precise-request:` reason), or targeted when a `BuzzChipKind` chip
 *  is sent from within a 1:1 DM (see the module doc comment). `at` is the
 *  caller's own timestamp (not read from the clock again in here) so it can't
 *  drift from whatever the caller stamps its own local bookkeeping with. */
export async function buildKindependenceMsgWrap(signer: Signer, circle: Circle, fromPk: string, reason: string, target: string | undefined, at: number): Promise<SignedEvent> {
  const inner = await buildKindependenceMsgSignal({ groupId: circle.id, seedHex: circle.seedHex, from: fromPk, reason, timestamp: at, ...(target ? { target } : {}) })
  const inbox = deriveInbox(circle.seedHex)
  return giftWrap(signer, inbox.pk, inner, inbox.pk)
}

/** How an incoming (already-decrypted) buzz should be handled — pure,
 *  unit-tested directly, and the one place the receive-side precedence rules
 *  live. Mirrors flock's own dual handling: EVERY untargeted buzz is
 *  chat-visible content in real flock (see the module doc comment), not
 *  just this app's own recognised reasons — so `chatLine` is `true` for any
 *  untargeted buzz regardless of what `reason` says, INCLUDING safety.ts's
 *  own `'Check in'` self-report and flock's own preset reasons
 *  (`DEFAULT_BUZZ_REASONS` — "Come home", "Where are you?", "Call me", "On
 *  my way") — none of which this function itself needs to know about to do
 *  its own job correctly; they simply fall through to the last, unstructured
 *  case (`structured: undefined`). `structured`, in contrast, is set
 *  whenever `reason` matches a vocabulary THIS module (or Task 6's reason
 *  prefix) owns — independent of `chatLine`: a TARGETED buzz can still be
 *  structured for Activity-recording purposes even though it never becomes
 *  a bubble (a `BuzzChipKind` sent from a 1:1 DM has always recorded
 *  Activity regardless of the bubble question — see `sendBuzzChip`). A
 *  targeted `'Check in'` (safety.ts's own kind, which this app never sends
 *  targeted but a real flock client theoretically could) is likewise just
 *  `{chatLine: false}` from THIS function's point of view — safety.ts's own
 *  registered handler records it independently either way.
 *
 *  Task 7 addition (brief §16.1-16.2): places.ts's arrival/departure buzzes
 *  ("Arrived at X"/"Left X") carry a dynamic, guardian-chosen place name, so
 *  they can't ride the fixed-phrase `REASON_TO_BUZZ_CHIP`/`detectStructuredDm`
 *  exact-match vocabularies below — they're recognised by PREFIX instead
 *  (`places.detectArrivalReason`/`detectDepartureReason`), checked here
 *  alongside the other prefix-based case (Task 6's `precise-request`) so an
 *  arrival/departure buzz is never silently swallowed as unstructured chat
 *  (structured: undefined) the way an unrecognised reason would be — see
 *  `handleIncomingBuzz`'s own dispatch for why this must record Activity
 *  kind `'arrival'`/`'departure'` (with the real place name), not a generic
 *  `'message'` label.
 *
 *  Task 5 addition (arrival windows): places.ts's "not yet arrived" buzz
 *  (`buildNotYetReason`/`detectNotYetReason`) is the SAME prefix-recognised
 *  idiom, checked right after arrival/departure — `structured: 'window-missed'`
 *  routes `handleIncomingBuzz`'s dispatch to `places.recordIncomingWindowEvent`
 *  exactly where arrival/departure route today, and (like them) is excluded
 *  from `shouldNotifyForIncomingChat`'s generic notification purely by being
 *  `structured` at all — no separate case needed there.
 *
 *  Phase 5 Task 3 addition (journey mode, brief §32.2): journey.ts's
 *  "Heading to X"/"Journey to X complete" buzzes (`buildJourneyStartReason`/
 *  `buildJourneyDoneReason`) slot in right after window-missed — same
 *  prefix-recognised idiom, distinct prefixes ("Heading to "/"Journey to "),
 *  so ordering relative to arrival/departure/window-missed never matters for
 *  correctness, only for keeping this function's "where do NEW structured
 *  kinds go" convention documented/tested (messages.test.ts's own "classify
 *  ordering" coverage) rather than incidental. */
export interface BuzzClassification {
  chatLine: boolean
  structured?: string
}
export function classifyIncomingBuzz(reason: string, target: string | undefined): BuzzClassification {
  const chatLine = target === undefined
  // Phase 4 Task 6 (brief §17.2-17.3, §30): pickup.ts's `!pickup:<phase>`
  // prefix is checked FIRST, before precise-request/arrival/departure/
  // window-missed — its own prefix (`!pickup:`) can never collide with any
  // of theirs, but checking it first keeps this function's precedence order
  // documented/tested rather than incidental (see messages.test.ts's own
  // "classify ordering" coverage). Always targeted (pickup.ts never sends
  // one untargeted), so `chatLine` is false in practice either way — never a
  // chat bubble, matching every other structured-and-targeted kind here.
  if (pickup.parsePickupReason(reason) !== null) return { chatLine, structured: 'pickup-status' }
  const preciseReason = detectPreciseRequestReason(reason)
  if (preciseReason !== undefined) return { chatLine, structured: 'precise-request' }
  if (places.detectArrivalReason(reason) !== undefined) return { chatLine, structured: 'arrival' }
  if (places.detectDepartureReason(reason) !== undefined) return { chatLine, structured: 'departure' }
  if (places.detectNotYetReason(reason) !== undefined) return { chatLine, structured: 'window-missed' }
  if (journey.detectJourneyStartReason(reason) !== undefined) return { chatLine, structured: 'journey-start' }
  if (journey.detectJourneyDoneReason(reason) !== undefined) return { chatLine, structured: 'journey-done' }
  const chip = REASON_TO_BUZZ_CHIP[reason]
  if (chip) return { chatLine, structured: chip }
  const structuredDm = detectStructuredDm(reason)
  if (structuredDm) return { chatLine, structured: structuredDm }
  return { chatLine }
}

/** safety.ts's OWN self-report reason (`decodeCheckin`: `buzz.reason ===
 *  'Check in'` is its only match, wire-distinct from this module's own
 *  `'Please check in'` request — see `BUZZ_CHIP_REASONS`'s doc comment).
 *  `classifyIncomingBuzz` deliberately does NOT tag it `structured` (it's
 *  real chat-visible content, same as any other untargeted buzz — see that
 *  function's own doc comment), so `shouldNotifyForIncomingChat` below needs
 *  its own check for the literal string to avoid double-firing alongside
 *  safety.ts's own receive-side `notify('checkin', ...)` for the identical
 *  rumor (both this module's and safety.ts's `handleIncomingSignal` are
 *  registered against the SAME beacons.ts dispatch — see beacons.ts's
 *  `signalHandlers` doc comment). */
const SAFETY_CHECKIN_REASON = 'Check in'

/** Final review triage #7's "classify-first-then-notify" design (item 4):
 *  should an incoming circle-chat buzz fire a `'message'` notification?
 *  Pure, and the one place this decision lives — unit-tested directly
 *  (messages.test.ts) without touching notify.ts/store.ts. Only genuine,
 *  untargeted, unstructured chat text from someone else qualifies:
 *   - `fromPk === selfPk`: never notify for your own send (the local insert/
 *     chat bubble is already the sender's own confirmation) — belt-and-
 *     suspenders here, since `handleIncomingSignal` already drops self-echo
 *     before this is ever reached at runtime, but the pure contract holds
 *     independently either way.
 *   - `!classification.chatLine` (a TARGETED buzz — a `BuzzChipKind` chip
 *     sent from a 1:1 DM): never a circle-chat bubble in the first place,
 *     so never circle-chat notification-worthy here.
 *   - `classification.structured !== undefined`: Task 6's precise-request
 *     and Task 7's arrival/departure already fire their OWN dedicated
 *     notification from safety.ts/places.ts (`emergency-access`/`arrival`/
 *     `departure`) — a second, generic one here would double-fire the same
 *     event. This module's own quick-chip/structured-DM vocabulary
 *     (`checkin-request`, `status-*`, `come-home-now`, `dinner-ready`,
 *     `pickup`) is excluded from THIS follow-up too — still Activity-
 *     recorded and shown as a highlighted card either way, just without a
 *     system notification (a real product question for a future task, not
 *     a regression: this fixes "silent group chat" for PLAIN text, per the
 *     triage note's own scoping).
 *   - `reason === SAFETY_CHECKIN_REASON`: see that constant's own doc
 *     comment — the one case NOT captured by `classification.structured`
 *     that still needs excluding. */
export function shouldNotifyForIncomingChat(classification: BuzzClassification, reason: string, fromPk: string, selfPk: string): boolean {
  if (fromPk === selfPk) return false
  if (!classification.chatLine) return false
  if (classification.structured !== undefined) return false
  if (reason === SAFETY_CHECKIN_REASON) return false
  return true
}

/** Task 7 (brief: actionable quick-chip notifications): which `structured`
 *  values (a DM's `detectStructuredDm` result, or a buzz's
 *  `classifyIncomingBuzz(...).structured`) are actionable ENOUGH to fire
 *  their own `'request'` notification (notify.ts) on the receiving device —
 *  a deliberately small, explicit whitelist, not "everything structured":
 *   - `'come-home-now'`/`'dinner-ready'`/`'pickup'` (the three
 *     `StructuredDmKind` phrases) and `'checkin-request'` (the one
 *     `BuzzChipKind` this applies to) are genuine asks that want the
 *     recipient's attention NOW, wherever this device's screen currently is
 *     — maintainer's approved scope for this task.
 *   - The other four `BuzzChipKind`s (`'status-okay'`/`'status-arrived'`/
 *     `'status-leaving'`/`'status-heading-home'`) are passive self-reports,
 *     not requests — they stay silent here (still Activity-recorded and
 *     chat-visible, just no system notification).
 *   - `'suggest-baseline'` (Phase 6 Task 2, design spec §2) joins the
 *     genuine-ask group above — a guardian's "suggested sharing level"
 *     proposal, personal-DM-only (never rides circle-chat buzz — see
 *     `sendSuggestBaseline`'s own doc comment), task brief: "notify via
 *     existing 'request' kind".
 *   - `'pickup-status'`/`'precise-request'`/`'arrival'`/`'departure'`/
 *     `'window-missed'`/`'journey-start'`/`'journey-done'` already fire
 *     their OWN dedicated notification from pickup.ts/safety.ts/places.ts/
 *     journey.ts the moment `handleIncomingBuzz` dispatches on them (see
 *     that function's own `else if` chain below) — a second, generic one
 *     here would double-fire the same event, exactly the reasoning
 *     `shouldNotifyForIncomingChat` above already applies to `'message'`.
 *   - `undefined` (plain, unstructured chat) is `'message'`/
 *     `shouldNotifyForIncomingChat`'s province, a DIFFERENT notification
 *     entirely — never routed through here.
 *  Pure — the one gate both receive paths below consult, unit-tested
 *  directly against every value `classifyIncomingBuzz`/`detectStructuredDm`
 *  can actually produce (messages.test.ts's own matrix), including the
 *  'pickup' chip vs. safety.ts's/pickup.ts's UNRELATED findreq-based
 *  'pickup-requested' lifecycle — see messages.test.ts's own doc comment for
 *  why the two never collide (this chip's send path, `handleChip`'s `case
 *  'pickup'`, only ever calls `sendText`, never safety.ts/pickup.ts, so
 *  there is no second notify anywhere for it to double up with). A narrow
 *  whitelist rather than an exclusion list on purpose: anything not
 *  explicitly named here — including a future kind added to
 *  `BuzzClassification.structured` that forgets to update this list —
 *  defaults to `null`. Silence is the safe default, not a notification. */
export function chipNotifyKind(structured: string | undefined): 'request' | null {
  switch (structured) {
    case 'come-home-now':
    case 'dinner-ready':
    case 'pickup':
    case 'checkin-request':
      return 'request'
    // Phase 6 Task 2 (design spec §2, brief §2.3/§2.4): a guardian's
    // "suggested sharing level" proposal is a genuine ask (wants the
    // child's attention, same "actionable, not a passive self-report"
    // reasoning as the four above) — task brief: "notify via existing
    // 'request' kind".
    case 'suggest-baseline':
      return 'request'
    default:
      return null
  }
}

// ---------------------------------------------------------------------------
// Task 6 (brief §11.4/§11.5, §2.3): "Request precise location" — a NEW
// structured-prefix reason, deliberately separate from `StructuredDmKind`
// above (that vocabulary is a closed set of fixed short phrases matched by
// EXACT equality — `detectStructuredDm` — which doesn't fit a free-form,
// up-to-140-char declared reason). Rides the SAME circle-chat buzz mechanism
// every other structured send in this module uses — UNTARGETED, same as an
// ordinary circle-chat send, and for the same reason: the findreq itself
// (safety.ts) is circle-inbox traffic too, seen by every member, and only a
// circle-wide reason broadcast lets every member (not just the requester and
// the target) correlate the two and see an accurate reason (see safety.ts's
// own module-doc-comment section on `correlateIncomingFindreq` for the full
// reasoning) — matching brief §2.3's "make casual misuse socially and
// visibly accountable" for everyone, not just the specific target. The
// follow-up fix (switching this from a kind-14 DM to a real buzz) makes that
// declared reason ALSO literally visible as plain text in a real flock
// client's own UI, not just this app's — strengthening exactly that
// accountability story.
// ---------------------------------------------------------------------------

const PRECISE_REQUEST_DM_PREFIX = '!precise-request:'

/** Cap on the declared-reason free text (task contract: "≤140 chars") —
 *  independent of `MAX_CIRCLE_CHAT_LEN` (280, the underlying buzz `reason`
 *  field's own cap): 17 (the prefix's own length) + 140 is comfortably under
 *  280, so this cap alone is always enough — no separate truncation of the
 *  combined `!precise-request:<reason>` string is needed at send time. */
export const MAX_PRECISE_REASON_LEN = 140

/** Builds the wire text for a Task 6 declared-reason broadcast. Exported
 *  (alongside its inverse below) so app.ts/messages.test.ts can round-trip
 *  it without reaching into the private prefix constant. */
export function buildPreciseRequestReasonText(reason: string): string {
  return `${PRECISE_REQUEST_DM_PREFIX}${reason.trim().slice(0, MAX_PRECISE_REASON_LEN)}`
}

/** Inverse of `buildPreciseRequestReasonText` — the declared reason (never
 *  empty: falls back to 'not stated', same fallback `correlateIncomingFindreq`'s
 *  timeout uses, so a reason broadcast that somehow carried an empty string
 *  doesn't read any differently from one that never arrived), or undefined
 *  if `text` doesn't carry the prefix at all (ordinary chat text, or one of
 *  the fixed `StructuredDmKind` phrases). */
export function detectPreciseRequestReason(text: string): string | undefined {
  if (!text.startsWith(PRECISE_REQUEST_DM_PREFIX)) return undefined
  const reason = text.slice(PRECISE_REQUEST_DM_PREFIX.length).trim()
  return reason || 'not stated'
}

/** Task 6's full "Request precise location" send (app.ts's person-sheet
 *  reason picker, both directions — §11.5): sends the findreq half via
 *  safety.ts's role-unrestricted `sendPreciseLocationFindreq`, records the
 *  requester's OWN send-side 'emergency-access' Activity entry immediately
 *  (brief §2.3's accountability record — independent of whether the reason
 *  broadcast itself successfully reaches anyone; a lost/delayed send still
 *  means the requester's own action is on record), then broadcasts the
 *  reason (untargeted, see the section doc comment above) and appends it to
 *  the local circle-chat thread as an outgoing highlighted card, same as any
 *  other structured send. Returns false if there's no signed-in identity or
 *  `circleId` doesn't resolve (nothing to send). */
export async function requestPreciseLocation(circleId: string, targetPk: string, reason: string): Promise<boolean> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle) return false
  const trimmedReason = reason.trim().slice(0, MAX_PRECISE_REASON_LEN) || 'not stated'
  const at = await safety.sendPreciseLocationFindreq(circleId, targetPk)
  if (at === null) return false
  // targetPk appended (Task 10 polish, T6 minor — same reasoning as
  // safety.ts's receive-side `recordEmergencyAccess`): without it, two
  // precise-location requests to different targets in the same circle at
  // the same timestamp would collide on id and the second would be dropped
  // as a dedupe.
  activity.recordActivity({
    id: `${activity.localActivityId('emergency-access', at, circleId)}-${targetPk}`, at, kind: 'emergency-access', circleId,
    actorPk: self.identityPk, params: { targetPk, reason: trimmedReason },
  })
  const text = buildPreciseRequestReasonText(trimmedReason)
  insertLocalCircleChatLine(circleId, self.identityPk, text, at, 'precise-request')
  await publishCircleBuzz(self.identityPk, circle, text, undefined, at)
  return true
}

// ---------------------------------------------------------------------------
// Phase 6 Task 2 (design spec §2, brief §2.3/§2.4): "Suggested sharing
// level" — milestones.ts's `applyLevel` sends this DIRECTLY to one specific
// child (there is no open composer thread when a guardian taps "Apply" on
// the You tab — this is a standalone send, not routed through
// `handleChip`/`openThread` like every chip above). It CARRIES A PAYLOAD
// (the recommended precision) — unlike every other structured kind above,
// which are all fixed, payload-less phrases — so it can't ride
// `StructuredDmKind`'s exact-match vocabulary. Mirrors Task 6's own
// `!precise-request:<reason>` prefix-encoding exactly (same "the one
// genuinely free-form field this wire shape carries is a prefix + payload"
// idiom): `!suggest-baseline:<precision>:<circleId>`, `<precision>` one of
// beacons.ts's `BASELINE_PRECISION_OPTIONS`, stringified. Rides a genuine
// PERSONAL DM (covey-kit's own wire, targeted at the child's real key) —
// NOT a circle-wide buzz like precise-request: this ask is specific to ONE
// child's own sharing choice, not a circle-wide accountability broadcast,
// so it never needs the whole circle to see it. Consequently it never
// appears in `classifyIncomingBuzz` at all (that function is buzz-only).
//
// Phase 6 final-review finding 5 (circle binding): the wire text gained a
// THIRD field — the carried `circleId` — after review found the original
// 2-part form let Accept apply to whatever circle the DM thread HAPPENED to
// be open against at the moment of tapping, not necessarily the circle the
// proposal was actually about (a peer shared across multiple circles makes
// that a real, not hypothetical, mismatch). `detectSuggestBaselineReason`
// still tolerates the OLD 2-part form (`circleId: undefined`) for backward
// compat with any already-sent, not-yet-accepted proposal from before this
// fix — every caller falls back to the open thread's own circleId in that
// case, exactly the old (pre-fix) behaviour, never a hard failure.
// ---------------------------------------------------------------------------

const SUGGEST_BASELINE_PREFIX = '!suggest-baseline:'

/** Phase 6 final-review finding 1 (crafted-DM hardening, belt #2): the set
 *  of precisions milestones.ts's `LEVELS` table can EVER actually recommend
 *  (`LevelPreset.recommendedBaseline`'s own type: `4 | 6 | 7`) — a strict
 *  SUBSET of beacons.ts's `BASELINE_PRECISION_OPTIONS` ([4, 6, 7, 9]: no
 *  preset here ever proposes 9/"Precise", the most revealing option). Accept
 *  must clamp to THIS narrower, preset-legitimate set, not the wire-format's
 *  own wider one — a value outside `LEVELS` could still be a well-formed,
 *  positive, in-BASELINE_PRECISION_OPTIONS number (9) that no genuine
 *  guardian-device proposal could ever have sent. Duplicated from
 *  milestones.ts's own preset shape rather than imported — same
 *  "duplicated, not imported" idiom this file's own `ACTION_LABELS`-style
 *  precedents use elsewhere in this codebase, needed here specifically
 *  because milestones.ts already imports THIS module (`messages.sendSuggestBaseline`),
 *  so the reverse import would be circular. Kept in sync by inspection —
 *  verified against `LevelPreset.recommendedBaseline`'s own type union. */
export const SUGGEST_BASELINE_PRESET_OPTIONS = [4, 6, 7] as const

/** Builds the wire text for a suggest-baseline proposal — `circleId` is the
 *  circle this proposal is actually scoped to (finding 5), carried alongside
 *  the precision so Accept can never be misapplied to whatever circle the DM
 *  thread happens to be open against. Exported (alongside its inverse below)
 *  so milestones.ts's tests and app.ts's rendering can round-trip it without
 *  reaching into the private prefix constant. */
export function buildSuggestBaselineText(precision: number, circleId: string): string {
  return `${SUGGEST_BASELINE_PREFIX}${precision}:${circleId}`
}

/** The decoded payload of a suggest-baseline proposal. `circleId` is
 *  `undefined` only for the OLD 2-part wire form (pre-finding-5) — see the
 *  section doc comment above for the backward-compat story. */
export interface SuggestBaselinePayload {
  precision: number
  circleId: string | undefined
}

/** Inverse of `buildSuggestBaselineText` — the recommended precision plus
 *  its carried circleId, or undefined if `text` doesn't carry the prefix at
 *  all (ordinary chat text, or one of the fixed `StructuredDmKind`/
 *  precise-request vocabularies), or carries a malformed/non-positive
 *  precision (defensive — a future build's payload shape must never crash
 *  an older one reading it back). Tolerates both the current 3-part form
 *  (`<precision>:<circleId>`) and the old 2-part one (`<precision>` alone,
 *  `circleId: undefined`) — split on the FIRST colon only, so a circleId
 *  that itself happened to contain a colon would still round-trip whole. */
export function detectSuggestBaselineReason(text: string): SuggestBaselinePayload | undefined {
  if (!text.startsWith(SUGGEST_BASELINE_PREFIX)) return undefined
  const rest = text.slice(SUGGEST_BASELINE_PREFIX.length)
  const sep = rest.indexOf(':')
  const precisionPart = sep === -1 ? rest : rest.slice(0, sep)
  const circleId = sep === -1 ? undefined : rest.slice(sep + 1)
  const precision = Number(precisionPart)
  if (!Number.isFinite(precision) || precision <= 0) return undefined
  return { precision, circleId }
}

/** `structured === 'suggest-baseline'`'s display label — task brief's own
 *  example, verbatim: `"Suggested sharing level: Neighbourhood"`. A plain
 *  function rather than a `CHIP_LABELS` entry (that table is keyed by the
 *  fixed, payload-less `ChipKind` union — this kind's label depends on the
 *  payload actually carried in `text`, so it can't be a static lookup). Used
 *  for the SENDER's own bubble and for an ineligible-receiver's (see
 *  `messageItemView` below) — never invites a tap either way. */
function suggestBaselineLabel(text: string): string {
  const parsed = detectSuggestBaselineReason(text)
  // [copy] task brief's own example wording, verbatim.
  return `Suggested sharing level: ${parsed !== undefined ? precisionTerm(parsed.precision) : 'a new level'}`
}

/** Phase 6 final-review finding 5(b): the full acknowledgement-card body for
 *  an ELIGIBLE recipient (validated sender + circle + precision — see
 *  `messageItemView`'s own gate) — design spec §3's own wording, verbatim.
 *  Raw string composition; the caller `esc()`s the whole composed body once
 *  at render time (same "interpolate raw, escape once at the end" idiom as
 *  every other rendered string in this file's view section), so `circleName`
 *  is passed through UN-escaped here on purpose. [copy] flagged (§31). */
function suggestBaselineEligibleBody(circleName: string, precision: number): string {
  const term = precisionTerm(precision)
  // [copy] design spec §3 / final-review finding 5(b), verbatim.
  return `Your family set up sharing for ${circleName}: share your ${term} as a baseline. Safety alerts and agreements can still share more precisely when needed.`
}

/** milestones.ts's `applyLevel` step (e): sends `childPk` a "suggested
 *  sharing level" proposal — a direct guardian action from the You tab, not
 *  a chat-composer send, so (unlike every function in the "Outgoing" section
 *  above) this never reads `openThread` at all. Applies its own local
 *  reducer synchronously before the network publish (self-echo discipline,
 *  see the module doc comment), same as every other send here. Returns
 *  false if there's no signed-in identity or `circleId` doesn't resolve
 *  (nothing to send) — same contract as `requestPreciseLocation`. */
export async function sendSuggestBaseline(circleId: string, childPk: string, precision: number): Promise<boolean> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle) return false
  const at = nowSec()
  const text = buildSuggestBaselineText(precision, circleId)
  const msg: store.ChatMessage = { id: dmMessageId(self.identityPk, at, text), from: self.identityPk, text, at, structured: 'suggest-baseline' }
  store.update((sp) => {
    sp.dmThreads = { ...sp.dmThreads, [childPk]: appendMessage(sp.dmThreads[childPk] ?? [], msg, MAX_THREAD) }
    sp.dmLastSeen = { ...sp.dmLastSeen, [childPk]: at }
  })
  await sendDmToMember(circleId, childPk, { circleId, text })
  return true
}

// ---------------------------------------------------------------------------
// UI state — module-level, deliberately NOT persisted (same "ephemeral UI
// state, not app data" idiom as app.ts's `sheetTarget`/circles.ts's
// `uiView`): a fresh load never resumes with a chat open.
// ---------------------------------------------------------------------------

export type OpenThread =
  | { kind: 'dm'; peerPk: string; circleId: string }
  | { kind: 'circle'; circleId: string }

let openThread: OpenThread | null = null

/** Fire-and-forget confirmation text for a TARGETED buzz-based chip (sent
 *  from a 1:1 DM — task contract/`classifyIncomingBuzz`: these don't produce
 *  a chat bubble, only an untargeted circle-chat send does) — cleared
 *  whenever the open thread changes, same "can't survive onto a different
 *  thread" reasoning as app.ts's `navStatus`. */
let composerStatus: string | null = null

function setOpenThread(next: OpenThread | null): void {
  openThread = next
  composerStatus = null
  // Phase 7 Task 2 (design spec §2): opening a thread — DM or circle — is
  // exactly the moment you're waiting on a reply, so it's one of
  // pool-health.ts's recovery triggers ("messages surface open"). Only on
  // OPEN, not on `closeThread()`'s `next: null` — nothing to recover for on
  // the way out. `recoverIfStale()` is self-gated (staleness + cooldown), so
  // this is a no-op every time the pool is already healthy.
  if (next) poolHealth.recoverIfStale()
}

export function isOpen(): boolean {
  return openThread !== null
}

function markDmSeen(peerPk: string, at: number): void {
  store.update((p) => { p.dmLastSeen = { ...p.dmLastSeen, [peerPk]: at } })
}

function markCircleSeen(circleId: string, at: number): void {
  store.update((p) => { p.circleChatLastSeen = { ...p.circleChatLastSeen, [circleId]: at } })
}

/** Opens (or refocuses) a 1:1 DM thread with `peerPk`, in the context of
 *  `circleId` — the shared circle used both for the DM's required wire
 *  `circleId` field and for role-adaptive chip rendering. Marks the thread
 *  seen (clears its unread badge) — task contract's "simple
 *  lastSeen-per-thread". Entry points: the map person sheet (app.ts) and a
 *  circle member row (circles.ts). */
export function openDmThread(peerPk: string, circleId: string): void {
  setOpenThread({ kind: 'dm', peerPk, circleId })
  markDmSeen(peerPk, nowSec())
}

/** Opens (or refocuses) `circleId`'s circle chat. Entry point: the circle
 *  page (circles.ts). */
export function openCircleThread(circleId: string): void {
  setOpenThread({ kind: 'circle', circleId })
  markCircleSeen(circleId, nowSec())
}

export function closeThread(): void {
  setOpenThread(null)
  store.notify()
}

/** app.ts's "switch to the Circles tab" callback — registration, not import
 *  (this module has no reference to app.ts's tab state; see activity.ts's
 *  `setNavigator` for the same idiom, and the module doc comment's "Be home
 *  by…" case for why it's needed: that chip hands off to agreements.ts's
 *  form, which only renders on the Circles tab). */
let openCirclesTab: (() => void) | null = null
export function setOpenCirclesTab(fn: (() => void) | null): void {
  openCirclesTab = fn
}

// ---------------------------------------------------------------------------
// Unread badges (task contract: "Circles tab + person rows").
// ---------------------------------------------------------------------------

export function unreadForPeer(p: store.Persisted, peerPk: string, selfPk: string): number {
  return unreadCount(p.dmThreads[peerPk] ?? [], p.dmLastSeen[peerPk] ?? 0, selfPk)
}

export function unreadForCircle(p: store.Persisted, circleId: string, selfPk: string): number {
  return unreadCount(p.circleChats[circleId] ?? [], p.circleChatLastSeen[circleId] ?? 0, selfPk)
}

export function totalUnread(p: store.Persisted, selfPk: string): number {
  const dm = Object.keys(p.dmThreads).reduce((sum, pk) => sum + unreadForPeer(p, pk, selfPk), 0)
  const circleTotal = p.circles.reduce((sum, c) => sum + unreadForCircle(p, c.id, selfPk), 0)
  return dm + circleTotal
}

/** Small numeric badge, or '' when there's nothing unread — `n` is always a
 *  locally-computed count, never wire-derived text, so this doesn't need
 *  `esc()` (unlike every rendered message body/name below). */
export function unreadBadgeHtml(n: number): string {
  return n > 0 ? `<span class="badge unread">${n > 99 ? '99+' : n}</span>` : ''
}

// ---------------------------------------------------------------------------
// Outgoing — free-form and structured DM/circle-chat sends.
// ---------------------------------------------------------------------------

/** Inserts a self-originated (or, via `requestPreciseLocation`, self-
 *  triggered) message into `circleId`'s local chat thread and bumps its
 *  lastSeen — the local half of every circle-chat send in this module,
 *  shared by `sendText`'s circle branch, `sendBuzzChip`'s untargeted branch,
 *  and `requestPreciseLocation`. */
function insertLocalCircleChatLine(circleId: string, from: string, text: string, at: number, structured?: string): void {
  const msg: store.ChatMessage = { id: dmMessageId(from, at, text), from, text, at, ...(structured ? { structured } : {}) }
  store.update((sp) => {
    sp.circleChats = { ...sp.circleChats, [circleId]: appendMessage(sp.circleChats[circleId] ?? [], msg, MAX_THREAD) }
    sp.circleChatLastSeen = { ...sp.circleChatLastSeen, [circleId]: at }
  })
}

/** Sends a person-to-person DM to `memberPk` — Signet identity plan, Task 9:
 *  a member has no direct nostr keypair of its own any more, only phone
 *  keys, so the DM is gift-wrapped once per phone key bound to `memberPk` in
 *  `circleId` (`phonesOf`), each sealed by THIS device's own phone key. The
 *  receiving side is each recipient phone's own inbox (circles.ts's
 *  `onPhoneInboxWrap`), which resolves the sender back to an identity via
 *  `memberForPhone` before handing the decoded DM to this module's
 *  registered handler. A member with no bound phone yet (e.g. mid-onboarding)
 *  silently receives nothing — same "best-effort, no error UI" discipline as
 *  every other wire send in this codebase. */
async function sendDmToMember(circleId: string, memberPk: string, payload: { circleId: string; text: string }): Promise<void> {
  const relays = appRelays(store.load())
  const phones = phonesOf(circleId, memberPk)
  await Promise.all(phones.map(async (phonePk) => {
    const wrap = await buildDmWrap(phoneSigner(), phonePk, payload)
    await beacons.publishOrEnqueue(relays, wrap)
  }))
}

/** Publishes a circle-chat `t:'kindependence-msg'` (untargeted, or targeted for a
 *  `BuzzChipKind` sent from a 1:1 DM) — the impure publish-with-outbox-fallback
 *  wrapper around `buildKindependenceMsgWrap`, mirroring beacons.ts's own
 *  `publishOrEnqueue` contract (never throws; offline falls over to the
 *  shared outbox). */
async function publishCircleBuzz(selfPk: string, circle: Circle, reason: string, target: string | undefined, at: number): Promise<void> {
  const wrap = await buildKindependenceMsgWrap(phoneSigner(), circle, selfPk, reason, target, at)
  await beacons.publishOrEnqueue(appRelays(store.load()), wrap)
}

/** Sends `text` in the currently open thread. `structured` set means this IS
 *  an actionable structured send (task contract §23.4) — records Activity
 *  and renders as a highlighted card; omitted for a plain `msg-send`
 *  (ordinary chat, never hits Activity). Applies the local reducer
 *  SYNCHRONOUSLY before the network publish — see the module doc comment's
 *  self-echo section. */
async function sendText(text: string, structured?: StructuredDmKind): Promise<void> {
  const thread = openThread
  if (!thread) return
  const trimmed = text.trim()
  if (!trimmed) return
  const p = store.load()
  const self = currentSession()
  if (!self) return
  const circle = p.circles.find((c) => c.id === thread.circleId)
  if (!circle) return
  const at = nowSec()

  if (thread.kind === 'dm') {
    const peerPk = thread.peerPk
    // Final fix B6/I7: a personal DM only ever reaches a phone key bound to
    // the recipient (`phonesOf` — `sendDmToMember`'s own doc comment). With
    // none yet (before the member's own device statement has landed, or
    // after its 16-day expiry), the old code still inserted the local
    // "sent" bubble — nothing was actually delivered, but it LOOKED sent.
    // Checked before the local echo (not after the send attempt) so a
    // no-phone member never gets a bubble at all, structured chip or plain
    // text alike (covers the "Come home now"/"Pickup" chips and any other
    // structured send routed through here).
    if (phonesOf(thread.circleId, peerPk).length === 0) {
      const name = circle.members.find((m) => m.pk === peerPk)?.name || shortPk(peerPk)
      composerStatus = `${name} has no phone connected yet — not sent.`
      store.notify()
      return
    }
    const msg: store.ChatMessage = { id: dmMessageId(self.identityPk, at, trimmed), from: self.identityPk, text: trimmed, at, ...(structured ? { structured } : {}) }
    store.update((sp) => {
      sp.dmThreads = { ...sp.dmThreads, [peerPk]: appendMessage(sp.dmThreads[peerPk] ?? [], msg, MAX_THREAD) }
      sp.dmLastSeen = { ...sp.dmLastSeen, [peerPk]: at }
    })
    if (structured) recordStructuredActivity(at, thread.circleId, self.identityPk, structured)
    await sendDmToMember(thread.circleId, peerPk, { circleId: thread.circleId, text: trimmed })
  } else {
    // Circle chat rides kindependence's OWN `t:'kindependence-msg'` wire (Phase 7
    // Task 3 migration — see the module doc comment; this comment used to
    // say "flock's REAL mechanism", true only pre-migration, back when
    // circle chat rode flock's own untargeted buzz directly) — an untargeted
    // send whose `reason` IS the message text, still capped tighter than the
    // personal-DM branch above (the same 280-char limit the old buzz-based
    // wire used, not covey's 500-char DM cap).
    const reason = capCircleChatText(trimmed)
    insertLocalCircleChatLine(thread.circleId, self.identityPk, reason, at, structured)
    if (structured) recordStructuredActivity(at, thread.circleId, self.identityPk, structured)
    await publishCircleBuzz(self.identityPk, circle, reason, undefined, at)
  }
}

/** Deterministic Activity id for a structured message send/receive
 *  (final review M4 / minor-triage #2, T10's `emergency-access` precedent —
 *  `requestPreciseLocation` above already does the analogous thing with
 *  `targetPk`): `actorPk` appended so two structured sends in the same
 *  circle within the same wall-clock second — e.g. an incoming structured
 *  buzz and this device's own send, or two different senders — don't
 *  collide on id and silently dedupe to one entry. Ids are opaque dedupe
 *  keys ONLY: activity.ts's `applyRecordActivity` compares by strict
 *  equality and nothing else there (`summarize`/`matchesFilter`/
 *  `deepLinkFor`) ever parses one — verified by reading every consumer — so
 *  this is purely additive, no migration concern. */
export function messageActivityId(at: number, circleId: string, actorPk: string): string {
  return `${activity.localActivityId('message', at, circleId)}-${actorPk}`
}

/** Returns whether this was a genuinely NEW Activity entry (false for a
 *  dedupe of an id already recorded — e.g. a relay replay) — Task 7 reuses
 *  this as the "is this fresh, not a replay" freshness gate for a TARGETED
 *  structured chip's `'request'` notify (see `handleIncomingBuzz` below),
 *  the same role `appendSafetyEvent`'s/`applyPickupSignal`'s own
 *  insertion-boolean already plays for safety.ts's/pickup.ts's own receive
 *  paths — no separate bookkeeping needed here since Activity's own dedupe
 *  (by id) already IS that signal. */
function recordStructuredActivity(at: number, circleId: string, actorPk: string, kind: ChipKind): boolean {
  return activity.recordActivity({ id: messageActivityId(at, circleId, actorPk), at, kind: 'message', circleId, actorPk, params: { label: CHIP_LABELS[kind] } })
}

/** Sends a buzz-based chip in the current thread's circle — targeted at the
 *  DM peer (fire-and-forget: inline confirmation only, no bubble — see
 *  `classifyIncomingBuzz`'s doc comment), or untargeted from a circle-chat
 *  thread (becomes a real chat bubble on THIS device immediately, same as
 *  any other circle-chat send — self-echo is ignored on receive). Either way
 *  it's recorded to Activity. */
async function sendBuzzChip(kind: BuzzChipKind): Promise<void> {
  const thread = openThread
  if (!thread) return
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === thread.circleId)
  if (!self || !circle) return
  const target = thread.kind === 'dm' ? thread.peerPk : undefined
  const { reason, target: t } = buzzChipPayload(kind, target)
  const at = nowSec()
  if (t) {
    composerStatus = `Sent: ${CHIP_LABELS[kind]}`
  } else {
    insertLocalCircleChatLine(circle.id, self.identityPk, reason, at, kind)
  }
  recordStructuredActivity(at, circle.id, self.identityPk, kind)
  store.notify()
  // Coordination-action interop (Phase 7 Task 3): the "Heading home" status
  // chip, sent UNTARGETED (from circle chat), goes out as flock's REAL
  // `on_my_way` fixed action so an updated flock client sharing the circle sees
  // it as a first-class coordination signal (our local bubble and a kindependence
  // receiver's both still read 'Heading home' — see `handleActionBuzz`). Every
  // other chip — and a TARGETED "Heading home" (flock's group actions can't
  // target one member) — rides `t:'kindependence-msg'` as kindependence's own
  // vocabulary. checkin-request stays on kindependence-msg too: upstream forces
  // `ask:'location'` onto every `check_in`, so a request could not be told
  // apart from safety.ts's `check_in` self-report on the wire (see the
  // coordination-action note), which would collapse the request-vs-self-report
  // distinction kindependence↔kindependence.
  if (kind === 'status-heading-home' && !t) {
    await publishOnMyWay(self.identityPk, circle, at)
  } else {
    await publishCircleBuzz(self.identityPk, circle, reason, t, at)
  }
}

/** Publishes the "Heading home" status chip as flock's real `on_my_way` fixed
 *  coordination action (untargeted `t:'buzz'`) — the impure
 *  publish-with-outbox-fallback wrapper, mirroring `publishCircleBuzz`. */
async function publishOnMyWay(selfPk: string, circle: Circle, at: number): Promise<void> {
  const inner = await buildBuzzSignal({ groupId: circle.id, seedHex: circle.seedHex, from: selfPk, action: 'on_my_way', timestamp: at })
  const inbox = deriveInbox(circle.seedHex)
  const wrap = await giftWrap(phoneSigner(), inbox.pk, inner, inbox.pk)
  await beacons.publishOrEnqueue(appRelays(store.load()), wrap)
}

/** Opens agreements.ts's "new agreement" form, prefilled with the current
 *  thread's child when it's a 1:1 DM, and switches to the Circles tab (where
 *  that form renders) — see the module doc comment's "Be home by…" case. */
function openBeHomeBy(): void {
  const thread = openThread
  if (!thread) return
  const childPk = thread.kind === 'dm' ? thread.peerPk : undefined
  agreements.openCreateAgreementFor(thread.circleId, childPk)
  closeThread()
  openCirclesTab?.()
}

async function handleChip(kind: string | undefined): Promise<void> {
  switch (kind as ChipKind | undefined) {
    case 'checkin-request': case 'status-okay': case 'status-arrived': case 'status-leaving': case 'status-heading-home':
      await sendBuzzChip(kind as BuzzChipKind)
      return
    case 'come-home-now': await sendText(structuredDmText('come-home-now'), 'come-home-now'); return
    case 'dinner-ready': await sendText(structuredDmText('dinner-ready'), 'dinner-ready'); return
    case 'pickup': await sendText(structuredDmText('pickup'), 'pickup'); return
    case 'be-home-by': openBeHomeBy(); return
    default: return
  }
}

// ---------------------------------------------------------------------------
// Incoming — registered with beacons.ts (every circle-chat buzz, including
// this module's own chip reasons and Task 6's reason broadcast) and
// circles.ts (person-to-person DM) from `ensure()` below.
// ---------------------------------------------------------------------------

function handleIncomingPersonalDm(dm: DirectMessage & { from: string }): void {
  const self = currentSession()
  if (!self || dm.from === self.identityPk) return
  // Phase 6 Task 2: a suggest-baseline proposal doesn't match
  // `detectStructuredDm`'s exact-phrase vocabulary (it carries a payload) —
  // checked as a fallback, same "distinct, non-colliding prefix" idiom as
  // Task 6's own `detectPreciseRequestReason`.
  const structured: StructuredDmKind | 'suggest-baseline' | undefined =
    detectStructuredDm(dm.text) ?? (detectSuggestBaselineReason(dm.text) !== undefined ? 'suggest-baseline' : undefined)
  const msg: store.ChatMessage = { id: dmMessageId(dm.from, dm.at, dm.text), from: dm.from, text: dm.text, at: dm.at, ...(structured ? { structured } : {}) }
  const stillOpen = openThread?.kind === 'dm' && openThread.peerPk === dm.from
  const inserted = !(store.load().dmThreads[dm.from] ?? []).some((m) => m.id === msg.id)
  store.update((p) => {
    p.dmThreads = { ...p.dmThreads, [dm.from]: appendMessage(p.dmThreads[dm.from] ?? [], msg, MAX_THREAD) }
    if (stillOpen) p.dmLastSeen = { ...p.dmLastSeen, [dm.from]: dm.at }
  })
  // suggest-baseline is deliberately NOT Activity-recorded here (unlike
  // every other structured DM kind) — milestones.ts's `applyLevel` already
  // records the guardian's own 'independence-applied' entry at send time
  // (design spec §2's transparency requirement), and the CHILD's own
  // accept/decline is silent by design (task contract) — a second 'message'
  // Activity entry for the proposal itself would be redundant noise, not
  // additional transparency.
  if (structured && structured !== 'suggest-baseline') recordStructuredActivity(dm.at, dm.circleId, dm.from, structured)
  // Task 9 (brief §12/§29): a notification for a personal DM that arrived
  // while this exact thread ISN'T open (the chat bubble is enough while it
  // is — same "in-app is primary, notification is an additional nudge"
  // discipline as safety.ts/places.ts) and is fresh/genuinely new (not a
  // relay replay of an already-seen message). `handleIncomingBuzz` below
  // mirrors this EXACT gating for circle chat (final review item 4/triage
  // #7) — see `shouldNotifyForIncomingChat`'s own doc comment for why that
  // one additionally classifies first: an incoming circle-chat buzz can
  // ALSO be safety.ts's own 'Check in' self-report or places.ts's
  // arrival/departure (indistinguishable from plain chat text from THIS
  // module's point of view — see `classifyIncomingBuzz`'s doc comment),
  // each of which already fires its OWN dedicated notification, so a second,
  // generic one for the same event must be excluded there — a distinction a
  // personal DM never needs to make (a DM's `text` is never one of those
  // wire mechanisms).
  if (!stillOpen && shouldNotifyForEvent(inserted, dm.at, nowSec())) {
    const circle = store.load().circles.find((c) => c.id === dm.circleId)
    const name = circle ? senderName(circle, dm.from, self.identityPk) : shortPk(dm.from)
    // Task 7: an actionable structured DM chip ('come-home-now'/
    // 'dinner-ready'/'pickup') fires its own 'request' kind INSTEAD of the
    // generic 'message' — never both (see `chipNotifyKind`'s own doc
    // comment). Body carries the circle name (review-minor: was `''`) —
    // same as the circle-chat 'request' paths below (`handleIncomingBuzz`'s
    // two `notify(requestKind, ..., circle.name)` calls) — a 1:1 DM still
    // has a `circleId` (the relationship the two of you share) worth
    // surfacing, same as any other 'request', particularly for someone in
    // more than one circle together. `circle` is already in scope, a few
    // lines up. Falls back to `''` on the (should-be-unreachable) case
    // where `circle` itself is undefined, same as `name`'s own fallback.
    const requestKind = chipNotifyKind(structured)
    if (requestKind) {
      const label = structured === 'suggest-baseline' ? suggestBaselineLabel(dm.text) : CHIP_LABELS[structured as ChipKind]
      void notify(requestKind, dm.from, `${name}: ${label}`, circle?.name ?? '')
    } else {
      void notify('message', dm.from, name, dm.text)
    }
  }
}

/** beacons.ts's registered `CircleSignalHandler` — routes each non-beacon
 *  signal by its `t` tag (beacons.ts hands every non-beacon `t` to every
 *  registered handler; safety.ts's own handler runs alongside this one). Two
 *  types land here:
 *   - `t:'kindependence-msg'` — kindependence's own rich vocabulary (Phase 7 Task 3),
 *     decoded via the kindependence-owned codec (`handleIncomingKindependenceMsg`).
 *   - `t:'buzz'` — flock's coordination-action wire: a NEW fixed-action buzz
 *     or (compat window) a legacy free-text one (`handleIncomingBuzz`).
 *  Self-echo (our own send delivered back on the shared inbox) is dropped for
 *  both, exactly as before — see the module doc comment.
 *
 *  Exported (final-review fix, Minor #4) — mirrors pins.ts's/meet.ts's/
 *  safety.ts's own `handleIncomingSignal`, each exported specifically so
 *  tests can drive a circle-inbox signal directly without beacons.ts's own
 *  `onCircleInboxWrap`/`signalHandlers` registration plumbing in the way
 *  (same reasoning circles.ts's `onPersonalInboxWrap` doc comment gives for
 *  the personal-inbox path). Needed here to cover the legacy-buzz
 *  sender-binding fix below with a real regression test. */
export function handleIncomingSignal(circle: Circle, rumor: Rumor, t: string, sender: beacons.Sender): void {
  const self = currentSession()
  if (self && sender.signerPk === self.phonePk) return // self-echo — see module doc comment
  if (t === KINDEPENDENCE_MSG_SIGNAL_TYPE) { void handleIncomingKindependenceMsg(circle, rumor, sender); return }
  if (t === BUZZ_SIGNAL_TYPE) { void handleIncomingBuzz(circle, rumor, sender); return }
}

/** `t:'kindependence-msg'` receive — kindependence's own free-text/prefixed vocabulary
 *  (circle chat, arrival/departure/not-yet, journey, pickup lifecycle,
 *  precise-request, quick-chips). Decodes the old-buzz-shaped payload with the
 *  kindependence-owned codec, then runs the SAME `dispatchDecodedBuzz` pipeline
 *  every reason rode before the migration — only the transport seam changed. */
async function handleIncomingKindependenceMsg(circle: Circle, rumor: Rumor, sender: beacons.Sender): Promise<void> {
  let msg: LegacyBuzz
  try {
    msg = await decodeLegacyBuzz(circle.seedHex, rumor.content)
  } catch {
    return
  }
  // Sender-auth (ffb48b9 / roost-kit 504cff8 class): the content-embedded
  // `from` names the sender; it must equal the now-authenticated resolved
  // sender, else the content is lying about who sent it — drop it wholesale
  // (the same binding safety.ts applies to findping.from).
  if (msg.from !== sender.memberPk) return
  await dispatchDecodedBuzz(circle, rumor, msg.reason, msg.target, msg.timestamp, sender)
}

/** `t:'buzz'` receive — flock's coordination-action wire. Try the NEW
 *  fixed-action kit first; on success it's a real coordination action
 *  (`handleActionBuzz` maps it onto our chip vocabulary). `decryptBuzz` THROWS
 *  on legacy free-text, so a throw THERE falls through to the kindependence-owned
 *  legacy decode (the receive compat window — 16-day relay replay + phased
 *  device upgrades). Unparseable both ways → silent drop.
 *
 *  Review queue item 1 (Phase 7 Task 5): the try/catch guards ONLY
 *  `decryptBuzz` — deliberately NOT `handleActionBuzz` — so a bug or thrown
 *  error while acting on an already-successfully-decrypted NEW buzz can never
 *  be swallowed and misinterpreted as "not a new buzz, try legacy decode".
 *  Before this fix, a throw anywhere inside `handleActionBuzz` (Activity
 *  recording, notify, or the nested `dispatchDecodedBuzz` call for
 *  `on_my_way`/`check_in`) would have been caught by the same `catch` as a
 *  genuine `decryptBuzz` rejection, silently re-running `decodeLegacyBuzz` on
 *  content that `decryptBuzz` had ALREADY proven decodes as a real new-style
 *  action — a legacy-chat resurrection of a message that must never render as
 *  free-text chat. No test seam existed for this directly at the time:
 *  `handleIncomingBuzz`/`handleActionBuzz` are still module-private, and were
 *  reachable in production only via beacons.ts's private `onCircleInboxWrap`.
 *  Fixed by structure instead: the two decode attempts are strictly
 *  sequential try/catches with the actioning step moved outside both.
 *  (Final-review fix, Minor #4: `handleIncomingSignal` above — this
 *  function's own caller — is now exported for an unrelated legacy-binding
 *  fix just below, which incidentally also makes `handleIncomingBuzz`
 *  reachable from a test for the first time; that export exists for the
 *  binding fix's own regression test, not as a retroactive fix for this
 *  item's still-indirect coverage of the try/catch narrowing specifically.) */
async function handleIncomingBuzz(circle: Circle, rumor: Rumor, sender: beacons.Sender): Promise<void> {
  let action: Buzz | undefined
  try {
    action = await decryptBuzz(circle.seedHex, rumor.content)
  } catch {
    // Not a NEW fixed-action buzz — fall through to the legacy compat window.
  }
  if (action) {
    await handleActionBuzz(circle, rumor, action, sender)
    return
  }
  let legacy: LegacyBuzz
  try {
    legacy = await decodeLegacyBuzz(circle.seedHex, rumor.content)
  } catch {
    return
  }
  // Final-review fix, Minor #4 (legacy-path binding consistency): the
  // content-embedded `from` was decoded but never checked against the wrap's
  // authenticated seal signer — silently discarded rather than validated, the
  // one path in this codebase that skipped the sender-auth binding every
  // other decode applies (see `handleIncomingKindependenceMsg`'s own identical
  // check just above, on the SAME `LegacyBuzz` shape). Drop wholesale on
  // mismatch, same as every other path, so no future consumer of this
  // decoded value can end up trusting an unbound field.
  if (legacy.from !== sender.memberPk) return
  await dispatchDecodedBuzz(circle, rumor, legacy.reason, legacy.target, legacy.timestamp, sender)
}

/** Maps a NEW flock fixed-action coordination buzz onto kindependence's existing
 *  chip vocabulary — routed by ACTION, never by the compat `reason` label
 *  (that label is a display-only fallback). See the coordination-action send
 *  section below for why the brief's original ask-based request/self-report
 *  split is unimplementable: upstream `buildBuzzSignal`/`decryptBuzz` FORCE
 *  `ask:'location'` onto every `check_in` (there is no ask-less form to
 *  receive), so `ask` distinguishes nothing here.
 *   - `check_in` → safety's "I'm OK" self-report path. safety.ts's OWN
 *     registered `t:'buzz'` handler records the SafetyEvent + fires the
 *     'checkin' notify; here we only reproduce the chat-visible bubble the
 *     free-text 'Check in' produced before the migration (feeding the compat
 *     reason through the unchanged pipeline — `classifyIncomingBuzz('Check in')`
 *     is unstructured chat, excluded from a second notify by
 *     `SAFETY_CHECKIN_REASON`). NB: the forced `ask:'location'` is flock's
 *     ROLL-CALL semantics — "please report where you are" — NOT an automatic
 *     disclosure; nothing here (or in safety.ts) auto-answers with location.
 *   - `on_my_way` → the existing `status-heading-home` status chip class. Its
 *     compat label maps straight onto that chip's own wire reason ('Heading
 *     home'), so the unchanged pipeline classifies it as `status-heading-home`
 *     — identical to a kindependence→kindependence send — with a bubble matching the
 *     sender's own local one.
 *   - `ring_lost_phone` → no kindependence equivalent; surfaced minimally as a
 *     'message' Activity entry + notify. */
async function handleActionBuzz(circle: Circle, rumor: Rumor, buzz: Buzz, sender: beacons.Sender): Promise<void> {
  if (buzz.action === RING_LOST_PHONE_ACTION) {
    const self = currentSession()
    if (!self) return
    const inserted = activity.recordActivity({
      id: messageActivityId(buzz.timestamp, circle.id, sender.memberPk), at: buzz.timestamp, kind: 'message',
      circleId: circle.id, actorPk: sender.memberPk, params: { label: buzz.reason },
    })
    if (shouldNotifyForEvent(inserted, buzz.timestamp, nowSec())) {
      void notify('message', sender.memberPk, senderName(circle, sender.memberPk, self.identityPk), buzz.reason)
    }
    return
  }
  // `on_my_way` maps onto the 'Heading home' status chip's own wire reason so
  // it flows through the unchanged classify pipeline as `status-heading-home`;
  // `check_in` maps onto safety's compat 'Check in' reason (unstructured chat,
  // no second notify — safety.ts owns the SafetyEvent). A group action is never
  // targeted (the kit forbids it), so `target` is always undefined here.
  const reason = buzz.action === 'on_my_way' ? BUZZ_CHIP_REASONS['status-heading-home'] : SAFETY_CHECKIN_REASON
  await dispatchDecodedBuzz(circle, rumor, reason, undefined, buzz.timestamp, sender)
}

/** The receive-side classify/dispatch pipeline, shared by every decoded
 *  message regardless of which transport (`t:'kindependence-msg'`, a NEW action
 *  buzz mapped by `handleActionBuzz`, or a legacy `t:'buzz'`) carried it —
 *  REUSED verbatim across the Phase 7 migration; its inputs are now passed in
 *  rather than read off a single decoded object. */
async function dispatchDecodedBuzz(circle: Circle, rumor: Rumor, reason: string, target: string | undefined, timestamp: number, sender: beacons.Sender): Promise<void> {
  const classification = classifyIncomingBuzz(reason, target)
  if (classification.chatLine) {
    const msg: store.ChatMessage = {
      id: rumor.id ?? `buzz-${sender.memberPk}-${timestamp}`, from: sender.memberPk, text: reason, at: timestamp,
      ...(classification.structured ? { structured: classification.structured } : {}),
    }
    const stillOpen = openThread?.kind === 'circle' && openThread.circleId === circle.id
    const inserted = !(store.load().circleChats[circle.id] ?? []).some((m) => m.id === msg.id)
    store.update((p) => {
      p.circleChats = { ...p.circleChats, [circle.id]: appendMessage(p.circleChats[circle.id] ?? [], msg, MAX_THREAD) }
      if (stillOpen) p.circleChatLastSeen = { ...p.circleChatLastSeen, [circle.id]: timestamp }
    })
    // Final review item 4 (triage #7): notify for genuine circle-chat content
    // only — see `shouldNotifyForIncomingChat`'s own doc comment for the
    // classify-first exclusions. Gating mirrors `handleIncomingPersonalDm`
    // EXACTLY: skip while this exact thread is open (the bubble is enough),
    // and only for a fresh/newly-inserted event (never a relay replay).
    const self = currentSession()
    if (self && !stillOpen && shouldNotifyForEvent(inserted, timestamp, nowSec())) {
      const name = senderName(circle, sender.memberPk, self.identityPk)
      // Task 7: an actionable structured chip sent UNTARGETED (from circle
      // chat) fires its own 'request' kind INSTEAD of the generic 'message'
      // — never both. Every other structured buzz (arrival/departure/
      // window-missed/precise-request/pickup-status, plus this module's own
      // passive status chips) is excluded from BOTH branches here —
      // `chipNotifyKind` returns null and `shouldNotifyForIncomingChat`
      // already excludes anything `structured` — each already has (or, for
      // the passive status chips, deliberately lacks) its own notification.
      const requestKind = chipNotifyKind(classification.structured)
      if (requestKind) {
        void notify(requestKind, sender.memberPk, `${name}: ${CHIP_LABELS[classification.structured as ChipKind]}`, circle.name)
      } else if (shouldNotifyForIncomingChat(classification, reason, sender.memberPk, self.identityPk)) {
        void notify('message', sender.memberPk, name, reason)
      }
    }
  }
  if (classification.structured === 'pickup-status') {
    // Phase 4 Task 6: pickup.ts owns its own record lookup/creation +
    // Activity + notify — see `handleIncomingPickupSignal`'s own doc
    // comment. Re-parses (classifyIncomingBuzz only needed to know WHETHER
    // it matched), same "re-parse on dispatch" idiom as arrival/departure/
    // window-missed below.
    const parsed = pickup.parsePickupReason(reason)
    if (parsed) pickup.handleIncomingPickupSignal(circle, sender.memberPk, target, parsed, timestamp)
  } else if (classification.structured === 'precise-request') {
    safety.recordEmergencyAccessReason(circle.id, sender.memberPk, timestamp, detectPreciseRequestReason(reason) ?? 'not stated')
  } else if (classification.structured === 'arrival' || classification.structured === 'departure') {
    // Task 7 (brief §16.1-16.2): record the proper Activity kind + place
    // name, not a generic 'message' label — see `classifyIncomingBuzz`'s
    // own doc comment for why this is a direct call into places.ts (which
    // never imports this module back) rather than a registration.
    const placeName = classification.structured === 'arrival'
      ? places.detectArrivalReason(reason)
      : places.detectDepartureReason(reason)
    places.recordIncomingPlaceEvent(classification.structured, circle, sender.memberPk, placeName ?? '', timestamp)
  } else if (classification.structured === 'window-missed') {
    // Task 5: same direct-call idiom as arrival/departure just above — the
    // dynamic place name AND expected time both live in the reason itself,
    // re-parsed here (classifyIncomingBuzz only needed to know WHETHER it
    // matched, not what it parsed to).
    const parsed = places.detectNotYetReason(reason)
    places.recordIncomingWindowEvent(circle, sender.memberPk, parsed?.place ?? '', parsed?.time ?? '', timestamp)
  } else if (classification.structured === 'journey-start' || classification.structured === 'journey-done') {
    // Phase 5 Task 3 (brief §32.2): same direct-call idiom as arrival/
    // departure/window-missed just above — re-parsed here for the same
    // reason (classifyIncomingBuzz only needed to know WHETHER it matched).
    if (classification.structured === 'journey-start') {
      const parsed = journey.detectJourneyStartReason(reason)
      journey.recordIncomingJourneyEvent('journey-start', circle, sender.memberPk, parsed?.label ?? '', parsed?.expectedByHHMM, timestamp)
    } else {
      const label = journey.detectJourneyDoneReason(reason)
      journey.recordIncomingJourneyEvent('journey-done', circle, sender.memberPk, label ?? '', undefined, timestamp)
    }
  } else if (classification.structured) {
    const chip = classification.structured as ChipKind
    const activityInserted = recordStructuredActivity(timestamp, circle.id, sender.memberPk, chip)
    // Task 7: a TARGETED actionable chip (today, only 'checkin-request' sent
    // from a 1:1 DM composer — see `buzzChipPayload`'s `target`) never runs
    // the `classification.chatLine` branch above at all (never a bubble —
    // `classifyIncomingBuzz`'s own doc comment), so it would otherwise have
    // NO notification whatsoever on the receiving device, unlike every other
    // structured kind here which either gets one above or has its own
    // dedicated one elsewhere (pickup-status/precise-request/arrival/
    // departure/window-missed). No "thread open" suppression applies here —
    // there is no bubble standing in for it, so the recipient has literally
    // nothing else telling them this arrived. Gated on `activityInserted`
    // (this function's own return value) as the freshness/replay-dedupe
    // check, same role `inserted` plays in the chatLine branch above.
    if (!classification.chatLine) {
      const requestKind = chipNotifyKind(chip)
      if (requestKind && shouldNotifyForEvent(activityInserted, timestamp, nowSec())) {
        const self = currentSession()
        if (self) {
          const name = senderName(circle, sender.memberPk, self.identityPk)
          void notify(requestKind, sender.memberPk, `${name}: ${CHIP_LABELS[chip]}`, circle.name)
        }
      }
    }
  }
}

/** Registers this module's incoming-signal handlers. Called from app.ts's
 *  render() alongside circles.ensure/beacons.ensure/safety.ensure/
 *  agreements.ensure — same idempotent "the one side-effecting entry point"
 *  idiom as all four. */
let registered = false
export function ensure(): void {
  if (registered) return
  registered = true
  beacons.setSignalHandler(handleIncomingSignal)
  setPersonalDmHandler(handleIncomingPersonalDm)
}

// ---------------------------------------------------------------------------
// View — the chat overlay. Replaces the whole tab body while open (app.ts's
// `screenView` checks `isOpen()` first, same "short-circuits everything"
// idiom as circles.ts's own `pendingInvite`), nav bar unaffected. UI wiring
// only past this point — no unit tests (build-gated), same convention as
// every other domain module here. esc() on every wire-derived string (names,
// message text) per global-constraints.md.
// ---------------------------------------------------------------------------

/** covey-kit's own private DM `text` cap (`inbox.ts`'s `MAX_DM_LEN`, not
 *  exported) — mirrored here only for the personal-DM composer's `maxlength`
 *  hint (`buildDmWrap` itself already enforces the real cap server-side
 *  regardless of what the input allows through). */
const MAX_DM_LEN = 500

export function view(p: store.Persisted, fam: SessionInfo): string {
  if (!openThread) return ''
  const thread = openThread
  const circle = p.circles.find((c) => c.id === thread.circleId)
  if (!circle) return chatWrap('Chat', '<li class="muted">That circle is gone.</li>', '')

  if (thread.kind === 'dm') {
    const name = circle.members.find((m) => m.pk === thread.peerPk)?.name || shortPk(thread.peerPk)
    const msgs = p.dmThreads[thread.peerPk] ?? []
    return chatWrap(name, messageListView(p, circle, fam.identityPk, msgs), composerView(circle, fam, thread))
  }
  const msgs = p.circleChats[thread.circleId] ?? []
  return chatWrap(circle.name, messageListView(p, circle, fam.identityPk, msgs), composerView(circle, fam, thread))
}

function chatWrap(title: string, list: string, composer: string): string {
  return `
    <div class="chat-overlay">
      <div class="chat-header">
        <h1>${esc(title)}</h1>
        <button type="button" class="sheet-close" data-action="msg-close" aria-label="Close">✕</button>
      </div>
      <ul class="chat-list">${list}</ul>
      ${composer}
    </div>`
}

function senderName(circle: Circle, pk: string, selfPk: string): string {
  if (pk === selfPk) return 'You'
  return circle.members.find((m) => m.pk === pk)?.name || shortPk(pk)
}

function messageListView(p: store.Persisted, circle: Circle, selfPk: string, msgs: readonly ChatMessage[]): string {
  if (!msgs.length) return '<li class="muted">No messages yet.</li>'
  return msgs.map((m) => messageItemView(p, circle, selfPk, m)).join('')
}

function messageItemView(p: store.Persisted, circle: Circle, selfPk: string, m: ChatMessage): string {
  const mine = m.from === selfPk
  const cls = `chat-bubble${mine ? ' mine' : ''}${m.structured ? ' structured' : ''}`
  // Phase 6 Task 2 (design spec §2): suggest-baseline's own card — "summary
  // + Accept" on the RECEIVING (child) device, task contract; the sender's
  // (guardian's) own copy just shows the label, same as every other
  // structured send's bubble text. Declining is silent BY CONSTRUCTION —
  // there is no decline button at all (design spec §3's own wording for the
  // sibling wizard card: "declining leaves current settings... tells no
  // one"); simply not tapping Accept is the whole of "decline".
  if (m.structured === 'suggest-baseline') {
    const parsed = detectSuggestBaselineReason(m.text)
    if (parsed) {
      const label = suggestBaselineLabel(m.text)
      // Phase 6 final-review finding 5(a): Accept must apply to the CARRIED
      // circleId (the proposal's own payload — see the section doc comment
      // above), falling back to the open THREAD's circle only for the OLD
      // 2-part wire form (backward compat) — never trust the thread's
      // circleId when the message itself names one, since the same peer can
      // be shared across multiple circles.
      const targetCircleId = parsed.circleId ?? circle.id
      const targetCircle = p.circles.find((c) => c.id === targetCircleId)
      // Phase 6 final-review findings 1+5: Accept is only ever offered when
      // ALL of the following hold —
      //  - `parsed.precision` is one of the actually-proposable presets
      //    (`SUGGEST_BASELINE_PRESET_OPTIONS`, {4,6,7} — NOT the wider
      //    `BASELINE_PRECISION_OPTIONS`, which also contains 9/"Precise",
      //    something no LEVELS preset ever recommends);
      //  - the CARRIED circle actually resolves on this device;
      //  - the SENDER genuinely holds the guardian role in THAT circle
      //    (`selfRole`, finding 1 — never the open thread's circle, which a
      //    crafted/replayed DM could point elsewhere);
      //  - this device is actually a member of that circle at all (finding
      //    5a's "self is a member" check).
      // The `msg-accept-baseline` handler below re-derives and re-checks
      // every one of these independently (belt AND suspenders — a DOM node
      // never has to have come from a button this module itself rendered).
      const eligible = targetCircle !== undefined
        && (SUGGEST_BASELINE_PRESET_OPTIONS as readonly number[]).includes(parsed.precision)
        && selfRole(targetCircle, m.from) === 'guardian'
        && targetCircle.members.some((mem) => mem.pk === selfPk)
      // [copy] child-facing card body (design spec §3 / final-review finding
      // 5(b)) for an ELIGIBLE recipient; the sender's own sent copy, and an
      // INELIGIBLE recipient's, both just show the short label — never
      // invites a tap that would be silently ignored (or, worse, misapplied
      // to the wrong circle).
      const body = mine || !eligible || !targetCircle ? label : suggestBaselineEligibleBody(targetCircle.name, parsed.precision)
      const accept = !mine && eligible
        ? `<button type="button" data-action="msg-accept-baseline" data-circle="${esc(targetCircleId)}" data-from="${esc(m.from)}" data-precision="${parsed.precision}">Accept</button>`
        : ''
      return `<li class="${cls}"><span class="chat-sender">${esc(senderName(circle, m.from, selfPk))}</span><p>${esc(body)}</p>${accept}</li>`
    }
  }
  // A Task 6 reason card's wire text is the raw `!precise-request:<reason>`
  // prefix (not human-readable on its own, unlike every OTHER
  // `StructuredDmKind` phrase, which already IS its own display text) — this
  // is the one place it gets translated for display.
  const preciseReason = detectPreciseRequestReason(m.text)
  const body = preciseReason !== undefined ? `Requested precise location — reason: ${preciseReason}` : m.text
  return `<li class="${cls}"><span class="chat-sender">${esc(senderName(circle, m.from, selfPk))}</span><p>${esc(body)}</p></li>`
}

/** The chat box's form scope (form-state.ts): `#msg-text` is one id shared
 *  by every thread, so a half-typed message is kept only within the thread
 *  it was typed in — it never carries into another. */
export function threadScope(thread: OpenThread): string {
  return thread.kind === 'dm' ? `dm:${thread.circleId}:${thread.peerPk}` : `circle:${thread.circleId}`
}

function composerView(circle: Circle, fam: SessionInfo, thread: OpenThread): string {
  const peerPk = thread.kind === 'dm' ? thread.peerPk : undefined
  const chips = chipsForThread(circle, fam.identityPk, peerPk)
  const chipButtons = chips.map((c) => chipButtonView(circle, c, peerPk)).join('')
  const status = composerStatus ? `<p class="muted small" role="status">${esc(composerStatus)}</p>` : ''
  // Length hint only — the real cap is enforced at send time either way
  // (`capCircleChatText`/`buildDmWrap`'s own internal cap), so a paste that
  // exceeds `maxlength` (which browsers apply on typed input, not
  // programmatic paste in every case) still can't produce a longer wire send.
  const maxLength = thread.kind === 'circle' ? MAX_CIRCLE_CHAT_LEN : MAX_DM_LEN
  return `
    <div class="chat-chips">${chipButtons}</div>
    ${status}
    <div class="chat-composer">
      <input id="msg-text" type="text" placeholder="Message" maxlength="${maxLength}" data-form-scope="${esc(threadScope(thread))}" />
      <button type="button" data-action="msg-send">Send</button>
    </div>`
}

function chipButtonView(circle: Circle, c: ChatChip, peerPk: string | undefined): string {
  // "Request pickup" links straight to safety.ts's EXISTING findreq action
  // (data-action="safety-pickup") rather than routing through this module's
  // own `msg-chip` dispatch — see the module doc comment. `peerPk` is always
  // set here (chipsForThread only returns this kind for a DM thread).
  if (c.kind === 'request-pickup' && peerPk) {
    return `<button type="button" class="chat-chip" data-action="safety-pickup" data-circle="${esc(circle.id)}" data-pk="${esc(peerPk)}">${esc(c.label)}</button>`
  }
  return `<button type="button" class="chat-chip" data-action="msg-chip" data-chip="${esc(c.kind)}">${esc(c.label)}</button>`
}

function shortPk(pk: string): string {
  return `${pk.slice(0, 8)}…`
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

function inputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? ''
}

// ---------------------------------------------------------------------------
// Action dispatch — app.ts delegates every `msg-*` data-action here.
// ---------------------------------------------------------------------------

export function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'msg-open-dm': {
      const pk = node.dataset.pk
      const circleId = node.dataset.circle
      if (pk && circleId) openDmThread(pk, circleId)
      break
    }
    case 'msg-open-circle': {
      const circleId = node.dataset.circle
      if (circleId) openCircleThread(circleId)
      break
    }
    case 'msg-close':
      closeThread()
      break
    case 'msg-send': {
      const text = inputValue('msg-text')
      if (!text) break
      // Sent: the box empties now, though it keeps focus (form-state.ts).
      formState.clearField('msg-text')
      void sendText(text)
      break
    }
    case 'msg-chip':
      void handleChip(node.dataset.chip)
      break
    // Phase 6 Task 2: the suggest-baseline card's Accept button — applies
    // the recommended precision via the SAME existing local-only setting the
    // You-tab picker itself writes (`beacons.setCircleBaselinePrecision`,
    // never synced to the wire — see that function's own doc comment), so
    // "accept" produces no wire signal of its own beyond what routine
    // location emission always does at the new precision going forward.
    // Phase 6 final-review findings 1+5 (crafted-DM hardening, belt AND
    // suspenders alongside `messageItemView`'s own render-side gate above —
    // a `node.dataset.*` value never has to have come from a button this
    // module itself rendered):
    //  - clamped to `SUGGEST_BASELINE_PRESET_OPTIONS` ({4,6,7}), the
    //    narrower preset-legitimate set, not the wider
    //    `BASELINE_PRECISION_OPTIONS` (which also contains 9 — no LEVELS
    //    preset ever proposes that);
    //  - `circleId` is the CARRIED circle (`data-circle`, set by
    //    `messageItemView` to `parsed.circleId ?? thread.circleId` — see
    //    that function's own doc comment on finding 5) — applied to THAT
    //    circle, never whatever thread happens to be open;
    //  - this device is actually a MEMBER of that circle;
    //  - the SENDER (`data-from`) genuinely holds the guardian role in THAT
    //    SAME circle (`selfRole`, finding 1).
    case 'msg-accept-baseline': {
      const circleId = node.dataset.circle
      const fromPk = node.dataset.from
      const precision = Number(node.dataset.precision)
      if (!circleId || !fromPk) break
      if (!(SUGGEST_BASELINE_PRESET_OPTIONS as readonly number[]).includes(precision)) break
      const p = store.load()
      const self = currentSession()
      if (!self) break
      const circle = p.circles.find((c) => c.id === circleId)
      if (!circle) break
      if (!circle.members.some((m) => m.pk === self.identityPk)) break
      if (selfRole(circle, fromPk) !== 'guardian') break
      beacons.setCircleBaselinePrecision(circleId, precision)
      break
    }
    default:
      break
  }
}
