// Pickup lifecycle + offered pickups (Phase 4 Task 6, brief §17.2-17.3, §30).
//
// The EXISTING pickup wire (safety.ts's guardian findreq ask -> child
// precise-beacon answer) is untouched — this module adds a LIFECYCLE on top
// of it (seen/accepted/on-way/collected/declined/suggested), signalled via a
// structured buzz-reason prefix `!pickup:<phase>[:<json>]`, same "reuse the
// existing circle-chat buzz mechanism, no new wire TYPE" idiom as
// messages.ts's own `!precise-request:` (see that module's doc comment).
//
// Why 'requested' ALSO rides a companion buzz (a deliberate, documented
// deviation from a more literal "hook record-opening straight off findreq
// receipt"): safety.ts's `sendFindreq` is SHARED by two independent
// call sites — `requestPickup` (guardian's genuine "come get this child")
// AND Task 5's `sendPreciseLocationFindreq` (either party's role-unrestricted
// "show me your precise location right now," which is often NOT about a
// pickup at all — e.g. a guardian just checking in). The two send the
// wire-identical `t:'findreq'` event with no field distinguishing which
// flow sent it (Task 5's own module doc comment: "the findreq itself
// carries no reason" is a deliberate wire-compat constraint). Opening a
// PickupRecord straight off findreq RECEIPT would therefore open one for
// EVERY precise-location request, pickup-related or not — a confusing,
// wrong "Pickup for X" lifecycle card with Accept/Decline/On-the-way
// buttons appearing whenever anyone just asks where someone is. Instead,
// `requestPickup` sends the EXISTING findreq unchanged (still drives the
// unaffected auto-location-answer — the safety-critical part) and
// ADDITIONALLY sends a `!pickup:requested:{id}` targeted buzz, exactly
// mirroring how `offerPickup` announces an offer. Only a genuine
// "Request pickup" ever sends that buzz, so only a genuine pickup ever
// gets a lifecycle record — the two findreq call sites stay wire-identical
// and mutually indistinguishable, exactly as they already are; this module
// simply doesn't try to divine intent from the ambiguous signal. If the
// companion buzz is lost, the underlying pickup (findreq + auto-answer)
// still works — only the nice-to-have lifecycle card degrades, never the
// safety-critical location disclosure.
//
// Every phase after creation (seen/accepted/on-way/collected/declined/
// suggested) rides a TARGETED buzz — `target` is always "the other party" —
// so it reaches the person the way messages.ts's own targeted BuzzChipKind
// sends already do; like every buzz, the whole circle still decrypts and
// sees it (buzz.ts has no private-audience concept), so EVERY circle
// member's device applies the same pure reducer to its own local copy of
// `p.pickups` (circle-wide visibility/accountability — the same "make
// casual misuse socially and visibly accountable" precedent safety.ts's
// existing 'pickup-requested' SafetyEvent/Activity entry already
// established, see its own module doc comment). `actionsFor` below is what
// actually keeps this safe: a bystander's copy of the record renders
// read-only (no action buttons), never wrong controls.
//
// Role model (this app's whole pickup design, both directions): the
// COLLECTOR — the one driving over, tapping on-way/collected — is always a
// guardian; the CHILD is always the one being collected. What differs
// between directions is who's in the driver's seat of the CONVERSATION:
// - direction 'request' (guardian asks): guardian = collector, drives the
//   whole lifecycle (accept/on-way/collected/decline); the child's only
//   agency is to decline (cancel) their own request.
// - direction 'offer' (guardian offers): guardian = collector/offerer,
//   waits; the child accepts/declines/suggests an alternative, and the
//   guardian may re-accept a suggestion.
//
// Pure state machine (`applyPickupSignal`) + wire builders/parsers live
// here; the impure send/receive orchestration (store.update, network,
// notify) follows in a second section, same file-shape as safety.ts/
// messages.ts.

import * as store from './store.js'
import { clearFields } from './form-state.js'
import * as activity from './activity.js'
import * as beacons from './beacons.js'
import * as travel from './travel.js'
import { appRelays } from './circles.js'
import { notify, shouldNotifyForEvent, type NotifyKind } from './notify.js'
import { currentSession, phoneSigner } from './session.js'
import { deriveInbox } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftWrap } from '@forgesworn/roost-kit'
import type { Signer, SignedEvent } from '@forgesworn/roost-kit'
import { buildKindependenceMsgSignal } from './legacy-buzz.js'
import { decode as decodeGeohash } from 'geohash-kit'

const nowSec = (): number => Math.floor(Date.now() / 1000)

// ---------------------------------------------------------------------------
// Wire prefix + reason build/parse — pure, unit-tested directly.
// ---------------------------------------------------------------------------

export const PICKUP_PREFIX = '!pickup:'

/** Cap on `Persisted.pickups` — same "rolling recent log, not an audit
 *  trail" discipline as safety.ts's `MAX_SAFETY_EVENTS` (the full history
 *  already lives in Activity, which every phase but 'requested' also
 *  records — see `recordPhaseActivity` below). */
export const MAX_PICKUP_RECORDS = 20

export type PickupPhase =
  | 'requested' | 'offered' | 'seen' | 'accepted' | 'on-way' | 'collected' | 'declined' | 'suggested'

const PICKUP_PHASES: readonly PickupPhase[] = [
  'requested', 'offered', 'seen', 'accepted', 'on-way', 'collected', 'declined', 'suggested',
]
function isPickupPhase(s: string): s is PickupPhase {
  return (PICKUP_PHASES as readonly string[]).includes(s)
}

/** A child's "suggest another spot" — just a name in practice (final-review
 *  fix 4a): the suggest form has no location picker, so the ONLY coordinates
 *  this module ever had to attach were `beacons.selfFix()` — the child's own
 *  CURRENT position, not any point they actually chose. Presenting "where I
 *  am right now" as if it were the suggested meeting spot's coordinates was
 *  misleading (the two aren't the same thing), so this module no longer
 *  sends them at all — `lat`/`lon` stay purely for backward/forward wire
 *  tolerance (an older build's suggestion, or a future one that adds a real
 *  picker, may still carry them; `parsePickupReason`'s strict-JSON parse
 *  accepts either shape). */
export interface PickupSuggestion { name: string; lat?: number; lon?: number }

/** Builds the reason text for a pickup buzz — `phase` alone, or
 *  `phase:<strict JSON>` when `extra` is given (always at least `{id}` for
 *  every phase but the record's own creation, which IS the id — see
 *  `sendPickupRequestSignal`/`sendPickupOffer`). Never throws:
 *  `JSON.stringify` on a plain object literal built entirely from this
 *  module's own known-safe shapes never fails. */
export function buildPickupReason(phase: PickupPhase, extra?: object): string {
  return extra === undefined ? `${PICKUP_PREFIX}${phase}` : `${PICKUP_PREFIX}${phase}:${JSON.stringify(extra)}`
}

export interface ParsedPickupReason {
  phase: PickupPhase
  extra?: Record<string, unknown>
}

/** Inverse of `buildPickupReason` — `null` for anything that isn't a
 *  well-formed pickup reason: no prefix, an unrecognised phase word, or a
 *  JSON tail that fails to parse or doesn't decode to a plain object (a
 *  bare string/number/array/null is rejected — "strict JSON tail," task
 *  contract). Never throws — every failure path returns `null` instead of
 *  propagating `JSON.parse`'s exception. */
export function parsePickupReason(reason: string): ParsedPickupReason | null {
  if (!reason.startsWith(PICKUP_PREFIX)) return null
  const rest = reason.slice(PICKUP_PREFIX.length)
  const sep = rest.indexOf(':')
  const phaseStr = sep === -1 ? rest : rest.slice(0, sep)
  if (!isPickupPhase(phaseStr)) return null
  if (sep === -1) return { phase: phaseStr }
  let parsed: unknown
  try {
    parsed = JSON.parse(rest.slice(sep + 1))
  } catch {
    return null
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null
  return { phase: phaseStr, extra: parsed as Record<string, unknown> }
}

/** `lat`/`lon` are optional (final-review fix 4a — see `PickupSuggestion`'s
 *  own doc comment): a name-only suggestion (this module's own current
 *  sends) is valid, and so is an older/hypothetical one that still carries
 *  coordinates — but if EITHER is present, it must be a real number, never
 *  a malformed partial coordinate. */
function isPickupSuggestion(v: unknown): v is PickupSuggestion {
  if (!v || typeof v !== 'object') return false
  const s = v as Record<string, unknown>
  if (typeof s.name !== 'string') return false
  if (s.lat !== undefined && typeof s.lat !== 'number') return false
  if (s.lon !== undefined && typeof s.lon !== 'number') return false
  return true
}

// ---------------------------------------------------------------------------
// Record shape + pure state machine — unit-tested exhaustively.
// ---------------------------------------------------------------------------

/** One tracked pickup — request (guardian asks) or offer (guardian offers) —
 *  and its lifecycle so far. `id` is the originating findreq/offer's own
 *  activity-style id (`pickupRecordId` below), independently derivable by
 *  every device that sees the SAME creation signal (same `direction`/`at`/
 *  `circleId`), so no separate "which record is this" handshake is needed.
 *  `collectorPk` is always a guardian (see the module doc comment's role
 *  model) — optional at the type level only for defensive tolerance of a
 *  malformed/older persisted blob, always populated by every creation path
 *  in this module. `seenSent` is persisted (not just module-level) so the
 *  once-per-record auto-'seen' guard survives a reload. */
export interface PickupRecord {
  id: string
  circleId: string
  childPk: string
  collectorPk?: string
  phase: PickupPhase
  at: number
  etaMin?: number
  suggest?: PickupSuggestion
  direction: 'request' | 'offer'
  seenSent?: boolean
}

/** Deterministic, independently-derivable-by-both-devices id for a fresh
 *  pickup — same family as activity.ts's `local-<kind>-<at>-<circleId>`
 *  ids, just its own prefix (never confused with an ActivityEvent id, a
 *  separate namespace). */
export function pickupRecordId(direction: 'request' | 'offer', at: number, circleId: string): string {
  return `pickup-${direction}-${at}-${circleId}`
}

function initialPhase(direction: 'request' | 'offer'): PickupPhase {
  return direction === 'request' ? 'requested' : 'offered'
}

const REQUEST_ORDER: readonly PickupPhase[] = ['requested', 'seen', 'accepted', 'on-way', 'collected']
const OFFER_ORDER: readonly PickupPhase[] = ['offered', 'seen', 'accepted', 'on-way', 'collected']

function orderFor(direction: 'request' | 'offer'): readonly PickupPhase[] {
  return direction === 'request' ? REQUEST_ORDER : OFFER_ORDER
}

/** The one rule `applyPickupSignal` consults: is moving from `current` to
 *  `next` (within `direction`'s own main sequence) a legal FORWARD step?
 *  `current: undefined` means "no record yet" — only `direction`'s own
 *  initial phase may create one. `'collected'`/`'declined'` are terminal —
 *  nothing moves on from either, including a duplicate of itself.
 *  `'suggested'` is a side-branch off the main sequence: from it, only
 *  `'accepted'` (the collector/guardian re-accepting — task contract),
 *  `'declined'`, or another `'suggested'` (revising) are legal. From any
 *  OTHER pre-collected main-sequence phase, `'declined'`/`'suggested'` are
 *  always legal (task contract: "declined terminal from any pre-collected
 *  phase"), and a main-sequence phase is legal only STRICTLY forward (a
 *  skip ahead — e.g. requested -> accepted, if 'seen' never arrived — is
 *  allowed; a repeat or anything backward is not). */
function isLegalTransition(direction: 'request' | 'offer', current: PickupPhase | undefined, next: PickupPhase): boolean {
  if (current === undefined) return next === initialPhase(direction)
  if (current === 'collected' || current === 'declined') return false
  if (current === 'suggested') return next === 'accepted' || next === 'declined' || next === 'suggested'
  const order = orderFor(direction)
  const currentIdx = order.indexOf(current)
  if (currentIdx === -1) return false // defensive: `current` isn't this direction's own main sequence at all
  if (next === 'declined' || next === 'suggested') return true
  return order.indexOf(next) > currentIdx
}

/** The signal `applyPickupSignal` applies — either a fresh creation
 *  (`direction`'s own initial phase, no prior record) or a phase update to
 *  an existing one. `collectorPk` is included so a receive-side handler that
 *  just learned of a brand-new record (an incoming 'offered') can supply it;
 *  once a record exists, later signals may omit it (kept from the existing
 *  record — see `applyPickupSignal`). */
export interface PickupSignal {
  id: string
  circleId: string
  childPk: string
  collectorPk?: string
  phase: PickupPhase
  at: number
  etaMin?: number
  suggest?: PickupSuggestion
  direction: 'request' | 'offer'
}

/** Pure forward-only state machine (task contract, exhaustively tested):
 *  inserts/updates `incoming.id`'s record in `records`, or no-ops (returns
 *  the SAME array reference — `appendMessage`/`applyRecordActivity`'s own
 *  "callers can tell nothing changed without a second scan" idiom) for a
 *  stale/duplicate/backward/otherwise-illegal transition (`isLegalTransition`
 *  above) or a direction mismatch against an existing record of the same id
 *  (defensive — never happens via this module's own callers, since `id`
 *  encodes `direction`). The updated/created record always moves to the
 *  front; capped at `MAX_PICKUP_RECORDS`, dropping the oldest-untouched
 *  entry once over. `etaMin`/`suggest` are set only by their own phase
 *  (`'on-way'`/`'suggested'`) and otherwise carried over from the existing
 *  record (a later phase doesn't erase a still-relevant last-known ETA or
 *  suggestion). */
export function applyPickupSignal(records: readonly PickupRecord[], incoming: PickupSignal): PickupRecord[] {
  const idx = records.findIndex((r) => r.id === incoming.id)
  const existing = idx === -1 ? undefined : records[idx]
  if (existing && existing.direction !== incoming.direction) return records as PickupRecord[]
  if (!isLegalTransition(incoming.direction, existing?.phase, incoming.phase)) return records as PickupRecord[]
  const updated: PickupRecord = {
    id: incoming.id,
    circleId: incoming.circleId,
    childPk: incoming.childPk,
    collectorPk: incoming.collectorPk ?? existing?.collectorPk,
    phase: incoming.phase,
    at: incoming.at,
    etaMin: incoming.phase === 'on-way' ? incoming.etaMin : existing?.etaMin,
    suggest: incoming.phase === 'suggested' ? incoming.suggest : existing?.suggest,
    direction: incoming.direction,
    seenSent: existing?.seenSent,
  }
  const rest = idx === -1 ? records : [...records.slice(0, idx), ...records.slice(idx + 1)]
  return [updated, ...rest].slice(0, MAX_PICKUP_RECORDS) as PickupRecord[]
}

/** Pure convenience wrapper: opens a brand-new record via `applyPickupSignal`
 *  itself (no separate creation path to keep in sync) — `direction`'s own
 *  initial phase, computed here so every caller doesn't have to know
 *  `initialPhase`'s mapping. */
export function openPickupRecord(
  records: readonly PickupRecord[],
  params: { id: string; circleId: string; childPk: string; collectorPk: string; direction: 'request' | 'offer'; at: number },
): PickupRecord[] {
  return applyPickupSignal(records, { ...params, phase: initialPhase(params.direction) })
}

// ---------------------------------------------------------------------------
// Role-gated actions — one pure function, tested per (direction, phase,
// role) combination.
// ---------------------------------------------------------------------------

export type PickupAction = 'accept' | 'decline' | 'suggest' | 'on-way' | 'collected'

/** Which actions `selfPk` (holding `selfRole`) may take on `record` right
 *  now — task contract's role rules, phase-aware. Terminal phases
 *  (`'collected'`/`'declined'`) always return `[]`. `selfRole` doubles as a
 *  defensive cross-check alongside the pk match (the module doc comment's
 *  role model: a collector is always a guardian, the child always a child)
 *  — cheap insurance against a stale/mistagged local membership row, not a
 *  behaviour change for well-formed data. */
export function actionsFor(record: PickupRecord, selfPk: string, selfRole: 'guardian' | 'child'): PickupAction[] {
  if (record.phase === 'collected' || record.phase === 'declined') return []
  const isChild = selfRole === 'child' && record.childPk === selfPk
  const isCollector = selfRole === 'guardian' && record.collectorPk === selfPk

  if (record.direction === 'request') {
    // Guardian = collector, drives the lifecycle; the child (requester of
    // THIS pickup, task contract) may only cancel their own request.
    if (isChild) return ['decline']
    if (isCollector) {
      switch (record.phase) {
        case 'requested': case 'seen': case 'suggested': return ['accept', 'decline']
        case 'accepted': return ['on-way', 'decline']
        case 'on-way': return ['collected', 'decline']
        default: return []
      }
    }
    return []
  }

  // direction === 'offer': guardian = offerer/collector; child accepts,
  // declines, or suggests an alternative (task contract).
  if (isChild) {
    switch (record.phase) {
      case 'offered': case 'seen': return ['accept', 'decline', 'suggest']
      case 'suggested': case 'accepted': case 'on-way': return ['decline']
      default: return []
    }
  }
  if (isCollector) {
    switch (record.phase) {
      case 'offered': case 'seen': return ['decline'] // waiting on the child; may still withdraw
      case 'suggested': return ['accept', 'decline'] // re-accept the child's suggestion (task contract)
      case 'accepted': return ['on-way', 'decline']
      case 'on-way': return ['collected', 'decline']
      default: return []
    }
  }
  return []
}

/** Whether THIS device should auto-send its once-per-record 'seen' —
 *  task contract: "sent once when a device first renders the card for a
 *  record in 'requested'/'offered'," and only by the child (the recipient
 *  of the initiating request/offer in both directions — see the module doc
 *  comment's role model; the collector already knows they sent it). Pure —
 *  the guard itself (`seenSent`) lives on the record, so this needs no
 *  separate module-level bookkeeping to stay correct across a reload. */
export function shouldSendSeen(record: PickupRecord, selfPk: string): boolean {
  return !record.seenSent && (record.phase === 'requested' || record.phase === 'offered') && record.childPk === selfPk
}

// ---------------------------------------------------------------------------
// Wire wrap — this module's own giftWrap-a-targeted-message builder. Phase 7
// Task 3 moved the inner send off flock's `t:'buzz'` (which now rejects free
// text) onto kindependence's own `t:'kindependence-msg'` via the shared codec
// (`buildKindependenceMsgSignal`); each module still owns its own giftWrap wrapper,
// same "each domain module builds its own" convention as safety.ts/messages.ts.
// ---------------------------------------------------------------------------

export async function buildPickupWrap(signer: Signer, circle: Circle, reason: string, target: string, at: number): Promise<SignedEvent> {
  const inner = await buildKindependenceMsgSignal({ groupId: circle.id, seedHex: circle.seedHex, from: signer.pubkey, reason, timestamp: at, target })
  const inbox = deriveInbox(circle.seedHex)
  return giftWrap(signer, inbox.pk, inner, inbox.pk)
}

// ---------------------------------------------------------------------------
// Activity + notify — every phase but 'requested' (which stays under the
// EXISTING 'pickup-requested' Activity entry safety.ts's `sendFindreq`
// already records — see the module doc comment) gets a `'pickup-status'`
// entry, always. Notification is narrower: requested/offered reuse the
// existing `'pickup-requested'` NotifyKind; every other non-'seen' phase
// uses the new `'pickup-status'` kind; 'seen' never notifies (a low-value
// ack, not worth an interruption) — and only ever for the two actual
// parties, never a bystander (same "notify the person accessed, not every
// bystander" reasoning as safety.ts's `recordEmergencyAccess`).
// ---------------------------------------------------------------------------

/** `activity.recordActivity` dedupes by EXACT id (`applyRecordActivity`
 *  drops the incoming event outright on a collision, never replaces) — fine
 *  for every phase but 'suggested', which (task contract, `isLegalTransition`)
 *  the child may revise more than once (`'suggested' -> 'suggested'` is a
 *  legal transition). A bare `${recordId}-suggested` would collide with the
 *  FIRST suggestion's own id and silently swallow every revision from
 *  Activity (final-review fix 4c). Suffixing with `at` keeps every OTHER
 *  phase's id unchanged (each fires at most once per record) while giving
 *  each 'suggested' revision — which always carries a distinct `at` — its
 *  own slot. Exported for direct unit testing (pure), same "expose the
 *  pure helper rather than only exercising it through the impure
 *  send/receive orchestration" idiom as agreements.ts's `dueLeaveStage`. */
export function phaseActivityId(recordId: string, phase: PickupPhase, at: number): string {
  return phase === 'suggested' ? `${recordId}-${phase}-${at}` : `${recordId}-${phase}`
}

function recordPhaseActivity(
  recordId: string, circleId: string, childPk: string, actorPk: string, phase: PickupPhase, at: number,
  extra?: { etaMin?: number; suggest?: PickupSuggestion },
): void {
  if (phase === 'requested') return
  const params: Record<string, string> = { phase, targetPk: childPk }
  if (extra?.etaMin !== undefined) params.etaMin = String(extra.etaMin)
  if (extra?.suggest) params.suggestName = extra.suggest.name
  activity.recordActivity({ id: phaseActivityId(recordId, phase, at), at, kind: 'pickup-status', circleId, actorPk, params })
}

function memberName(circle: Circle | undefined, pk: string): string {
  return circle?.members.find((m) => m.pk === pk)?.name || `${pk.slice(0, 8)}…`
}

function notifyTitle(phase: PickupPhase, who: string): string {
  switch (phase) {
    case 'offered': return `${who} offered a pickup`
    case 'accepted': return `${who} accepted the pickup`
    case 'on-way': return `${who} is on the way`
    case 'collected': return `${who} picked up`
    case 'declined': return `${who} declined the pickup`
    case 'suggested': return `${who} suggested another spot`
    default: return `${who} updated the pickup`
  }
}

/** Receive-side only (never called for a self-originated send — see the
 *  module doc comment's "sender never notifies itself" convention, shared
 *  by every domain module here). Scoped to the two actual parties. */
function notifyForPhase(circle: Circle, record: { childPk: string; collectorPk?: string }, actorPk: string, phase: PickupPhase, selfPk: string): void {
  if (phase === 'seen' || phase === 'requested') return
  if (selfPk !== record.childPk && selfPk !== record.collectorPk) return
  const kind: NotifyKind = phase === 'offered' ? 'pickup-requested' : 'pickup-status'
  void notify(kind, actorPk, notifyTitle(phase, memberName(circle, actorPk)), circle.name)
}

// ---------------------------------------------------------------------------
// Outgoing — record creation (request/offer) and every later phase
// transition. Each applies the SAME `applyPickupSignal` to THIS device's own
// local copy SYNCHRONOUSLY before the network publish (self-echo discipline,
// same as messages.ts's own circle-chat sends) and never calls `notify()`
// for its own action (see above).
// ---------------------------------------------------------------------------

/** Called by safety.ts's `requestPickup`, using the SAME `at` its own
 *  `sendFindreq` just used — see the module doc comment for why this is a
 *  SEPARATE, additional buzz rather than hooking straight off findreq
 *  receipt. No-op if there's no signed-in identity or the circle is gone
 *  (nothing to send — mirrors `sendFindreq`'s own guard). */
export async function sendPickupRequestSignal(circleId: string, childPk: string, at: number): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle) return
  const id = pickupRecordId('request', at, circleId)
  store.update((sp) => { sp.pickups = openPickupRecord(sp.pickups, { id, circleId, childPk, collectorPk: self.identityPk, direction: 'request', at }) })
  const wrap = await buildPickupWrap(phoneSigner(), circle, buildPickupReason('requested', { id }), childPk, at)
  await beacons.publishOrEnqueue(appRelays(p), wrap)
}

/** A guardian's "offer a pickup" (new, task contract) — announces
 *  `!pickup:offered:{id}` to `childPk`, opening this device's own record
 *  immediately. Guardian-gating is safety.ts's job (`offerPickup`), same
 *  split as `requestPickup`/`sendFindreq`. */
export async function sendPickupOffer(circleId: string, childPk: string): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle) return
  const at = nowSec()
  const id = pickupRecordId('offer', at, circleId)
  store.update((sp) => { sp.pickups = openPickupRecord(sp.pickups, { id, circleId, childPk, collectorPk: self.identityPk, direction: 'offer', at }) })
  recordPhaseActivity(id, circleId, childPk, self.identityPk, 'offered', at)
  const wrap = await buildPickupWrap(phoneSigner(), circle, buildPickupReason('offered', { id }), childPk, at)
  await beacons.publishOrEnqueue(appRelays(p), wrap)
}

/** Every phase transition AFTER creation (seen/accepted/on-way/collected/
 *  declined/suggested) — applies the local reducer, records Activity, then
 *  broadcasts to "the other party" (whichever of childPk/collectorPk isn't
 *  self). No-ops if the circle is gone or there's no "other party" known yet
 *  (defensive — every creation path always sets `collectorPk`), or if the
 *  LOCAL transition itself was rejected as stale/duplicate/illegal
 *  (`applyPickupSignal` returning the same reference) — a caller racing
 *  itself (e.g. `ensureSeenSignals` re-entering mid-flight — `store.update`
 *  always notifies subscribers, including app.ts's own render loop, even for
 *  an unrelated change) must never re-broadcast a phase the record has
 *  already moved past, or moved past by the time this runs. */
async function sendPhaseTransition(
  selfPk: string, record: PickupRecord, phase: PickupPhase, at: number,
  extra?: { etaMin?: number; suggest?: PickupSuggestion },
): Promise<void> {
  const p = store.load()
  const circle = p.circles.find((c) => c.id === record.circleId)
  if (!circle) return
  const target = selfPk === record.childPk ? record.collectorPk : record.childPk
  if (!target) return
  const signal: PickupSignal = {
    id: record.id, circleId: record.circleId, childPk: record.childPk, collectorPk: record.collectorPk,
    phase, at, direction: record.direction, etaMin: extra?.etaMin, suggest: extra?.suggest,
  }
  let changed = false
  store.update((sp) => {
    const next = applyPickupSignal(sp.pickups, signal)
    if (next === sp.pickups) return
    changed = true
    sp.pickups = phase === 'seen' ? next.map((r) => (r.id === record.id ? { ...r, seenSent: true } : r)) : next
  })
  if (!changed) return
  recordPhaseActivity(record.id, record.circleId, record.childPk, selfPk, phase, at, extra)
  const wireExtra: Record<string, unknown> = { id: record.id }
  if (extra?.etaMin !== undefined) wireExtra.etaMin = extra.etaMin
  if (extra?.suggest) wireExtra.suggest = extra.suggest
  const wrap = await buildPickupWrap(phoneSigner(), circle, buildPickupReason(phase, wireExtra), target, at)
  await beacons.publishOrEnqueue(appRelays(p), wrap)
}

/** Called from app.ts's render() on every pass (cheap: filters `p.pickups`,
 *  only ever does real work once per record — task contract's "guard set
 *  per id... persisted `seenSent` boolean"). Equivalent to "the first time
 *  this device would render the card" without coupling to a specific view
 *  call site: a qualifying record stays due on every render until the send
 *  actually completes and flips `seenSent`. */
export function ensureSeenSignals(p: store.Persisted): void {
  const self = currentSession()
  if (!self) return
  const due = p.pickups.filter((r) => shouldSendSeen(r, self.identityPk))
  if (!due.length) return
  const at = nowSec()
  for (const record of due) void sendPhaseTransition(self.identityPk, record, 'seen', at)
}

/** ETA (whole minutes), computed on the COLLECTOR's device only, from this
 *  device's own live fix to the child's last permitted position — reuses
 *  beacons.ts's `memberPositions` (the same live-position store the map
 *  draws from) and travel.ts's `travelSec` (drive mode, never throws: any
 *  failure — no fix, no live child position, an unreachable routing engine —
 *  falls back to `undefined`, which callers treat as "no ETA to report,"
 *  never a blocked send). */
async function computeEtaMin(circleId: string, childPk: string, routingUrl: string | undefined): Promise<number | undefined> {
  const fix = beacons.selfFix()
  const pos = beacons.memberPositions(circleId).get(childPk)
  if (!fix || !pos) return undefined
  try {
    const { lat, lon } = decodeGeohash(pos.geohash)
    const { sec } = await travel.travelSec({ lat: fix.lat, lon: fix.lon }, { lat, lon }, 'drive', routingUrl)
    return Math.max(0, Math.round(sec / 60))
  } catch {
    return undefined
  }
}

/** The card's action buttons dispatch here (`handleAction` below). Re-checks
 *  `actionsFor` itself (never trusts the rendered button alone — same "role
 *  check re-checked at the action site" discipline as safety.ts's
 *  `requestPickup`). */
export async function performAction(recordId: string, action: PickupAction, suggestion?: PickupSuggestion): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const record = p.pickups.find((r) => r.id === recordId)
  if (!self || !record) return
  const role: 'guardian' | 'child' = self.dependant ? 'child' : 'guardian'
  if (!actionsFor(record, self.identityPk, role).includes(action)) return
  const at = nowSec()
  switch (action) {
    case 'accept': await sendPhaseTransition(self.identityPk, record, 'accepted', at); return
    case 'decline': await sendPhaseTransition(self.identityPk, record, 'declined', at); return
    case 'collected': await sendPhaseTransition(self.identityPk, record, 'collected', at); return
    case 'on-way': {
      const etaMin = await computeEtaMin(record.circleId, record.childPk, p.settings.routingUrl)
      await sendPhaseTransition(self.identityPk, record, 'on-way', at, etaMin !== undefined ? { etaMin } : undefined)
      return
    }
    case 'suggest':
      if (suggestion) await sendPhaseTransition(self.identityPk, record, 'suggested', at, { suggest: suggestion })
      return
  }
}

// ---------------------------------------------------------------------------
// Incoming — messages.ts's `classifyIncomingBuzz` checks `parsePickupReason`
// FIRST (before precise-request/arrival/window), and routes a match here.
// ---------------------------------------------------------------------------

/** `circle`/`senderPk`/`targetPk`/`at` come from the already-decrypted buzz
 *  (messages.ts's `handleIncomingBuzz`); `parsed` from `parsePickupReason`.
 *  A record already present is looked up by `parsed.extra.id` and updated in
 *  place (its own childPk/collectorPk/direction are authoritative, NOT
 *  re-derived from the wire); an absent record is created ONLY for a fresh
 *  'requested'/'offered' announcement addressed to someone (`targetPk` —
 *  the module doc comment's companion-buzz design means this is the ONLY
 *  path a request-direction record is ever created on a receiving device;
 *  offer-direction mirrors it identically). Anything else with no known
 *  record — a stale/evicted id, or a phase that isn't a valid creation
 *  point — silently no-ops, same "no id to correlate against" tolerance as
 *  safety.ts's own `correlateIncomingFindreq` buffers. */
export function handleIncomingPickupSignal(circle: Circle, senderPk: string, targetPk: string | undefined, parsed: ParsedPickupReason, at: number): void {
  const p = store.load()
  const self = currentSession()
  if (!self) return
  const recordId = typeof parsed.extra?.id === 'string' ? (parsed.extra.id as string) : undefined
  if (!recordId) return
  const existing = p.pickups.find((r) => r.id === recordId)
  let childPk: string
  let collectorPk: string
  let direction: 'request' | 'offer'
  if (existing) {
    // sender-auth: ffb48b9 class — a phase transition on an EXISTING record
    // may only come from one of its two actual parties (senderPk here is
    // already the authenticated, resolved sender — `sender.memberPk`, see
    // messages.ts's own call site). Every legitimate transition is sent by
    // the child or the collector (module doc comment's role model); a third
    // circle member forging one (e.g. `{phase:'collected', id:<someone
    // else's record>}`) is dropped wholesale rather than silently advancing
    // someone else's pickup.
    if (senderPk !== existing.childPk && senderPk !== existing.collectorPk) return
    childPk = existing.childPk
    collectorPk = existing.collectorPk ?? senderPk
    direction = existing.direction
  } else if (targetPk && (parsed.phase === 'requested' || parsed.phase === 'offered')) {
    childPk = targetPk
    collectorPk = senderPk
    direction = parsed.phase === 'requested' ? 'request' : 'offer'
  } else {
    return
  }
  const etaMin = typeof parsed.extra?.etaMin === 'number' ? (parsed.extra.etaMin as number) : undefined
  const suggest = isPickupSuggestion(parsed.extra?.suggest) ? (parsed.extra.suggest as PickupSuggestion) : undefined
  const signal: PickupSignal = { id: recordId, circleId: circle.id, childPk, collectorPk, phase: parsed.phase, at, direction, etaMin, suggest }
  let changed = false
  store.update((sp) => {
    const next = applyPickupSignal(sp.pickups, signal)
    if (next !== sp.pickups) changed = true
    sp.pickups = next
  })
  if (!changed) return
  recordPhaseActivity(recordId, circle.id, childPk, senderPk, parsed.phase, at, { etaMin, suggest })
  // Freshness-gated (flock ff5eead parity): a relaunch-replayed old phase
  // buzz still lands the record/Activity above (state repopulates on
  // legitimate catch-up), but must not push "X offered a pickup" as if it
  // were live. `at` is the sealed payload timestamp — a replayer can't
  // advance it.
  if (shouldNotifyForEvent(true, at, nowSec())) notifyForPhase(circle, { childPk, collectorPk }, senderPk, parsed.phase, self.identityPk)
}

// ---------------------------------------------------------------------------
// View — circle screen + person sheet cards. UI wiring only past this point
// (no unit tests, build-gated, same convention as safety.ts/messages.ts).
// esc() on every wire-derived string per global-constraints.md.
// ---------------------------------------------------------------------------

/** How long a TERMINAL (collected/declined) record still renders a card for
 *  — after that, the Activity tab is where its history lives, same "recent
 *  log, not a permanent record" reasoning as `MAX_PICKUP_RECORDS`. A
 *  non-terminal record always renders, however old (it's still open). */
const CARD_FRESH_SEC = 3600

function isCardWorthy(r: PickupRecord, now: number): boolean {
  if (r.phase === 'collected' || r.phase === 'declined') return now - r.at <= CARD_FRESH_SEC
  return true
}

export function cardsForCircle(p: store.Persisted, circleId: string, now: number = nowSec()): PickupRecord[] {
  return p.pickups.filter((r) => r.circleId === circleId && isCardWorthy(r, now))
}

export function cardsForPerson(p: store.Persisted, targetPk: string, now: number = nowSec()): PickupRecord[] {
  return p.pickups.filter((r) => (r.childPk === targetPk || r.collectorPk === targetPk) && isCardWorthy(r, now))
}

const PHASE_LABEL: Record<PickupPhase, string> = {
  requested: 'Requested', offered: 'Offered', seen: 'Seen', accepted: 'Accepted',
  'on-way': 'On the way', collected: 'Picked up', declined: 'Declined', suggested: 'Suggested another spot',
}

/** §31-safe human phrasing per phase — "on the way", "picked up", "declined",
 *  "suggested another spot" appear verbatim (task contract); never an
 *  internal id. Callers esc() the result (it interpolates wire-derived
 *  names). */
function statusText(record: PickupRecord, childName: string, collectorName: string): string {
  switch (record.phase) {
    case 'requested': return `Pickup requested for ${childName}`
    case 'offered': return `${collectorName} offered to pick up ${childName}`
    case 'seen': return `${childName} saw the pickup update`
    case 'accepted': return `${collectorName} accepted the pickup`
    case 'on-way': return record.etaMin !== undefined ? `${collectorName} is on the way — about ${record.etaMin} min` : `${collectorName} is on the way`
    case 'collected': return `${collectorName} picked up ${childName}`
    case 'declined': return 'The pickup was declined'
    case 'suggested': return record.suggest ? `Suggested another spot: ${record.suggest.name}` : 'Suggested another spot'
  }
}

function dotsView(record: PickupRecord): string {
  if (record.phase === 'declined') return `<p class="pickup-dots muted small">Declined</p>`
  const steps = orderFor(record.direction)
  const activeIdx = record.phase === 'suggested' ? -1 : steps.indexOf(record.phase)
  // Review-minor: `done` (reached, incl. the current step) vs. `current`
  // (the current step ALONE, layered on top of `done` for a highlight) are
  // separate classes — styles.css draws every reached dot filled, then rings
  // the current one so "where we are right now" reads at a glance too, not
  // just "how far we've gotten".
  const dots = steps.map((s, i) => {
    const cls = ['pickup-dot', i <= activeIdx ? 'done' : '', i === activeIdx ? 'current' : ''].filter(Boolean).join(' ')
    return `<span class="${cls}" title="${esc(PHASE_LABEL[s])}"></span>`
  }).join('')
  return `<p class="pickup-dots" aria-hidden="true">${dots}</p>`
}

const ACTION_LABEL: Record<PickupAction, string> = {
  accept: 'Accept', decline: 'Decline', suggest: 'Suggest another spot', 'on-way': "I'm on the way", collected: 'Picked up',
}

function actionButtonView(recordId: string, action: PickupAction): string {
  const dataAction = action === 'suggest' ? 'pickup-suggest-open' : `pickup-${action}`
  return `<button type="button" data-action="${esc(dataAction)}" data-record="${esc(recordId)}">${esc(ACTION_LABEL[action])}</button>`
}

/** The open suggest-form's target record, plus a submit-time validation
 *  error (final-review fix 4b): with 4a dropping the fix/coordinate
 *  requirement, a name-only suggestion always sends — the only way `submit`
 *  can fail now is an empty name, and that failure gets a visible
 *  `.form-error` rather than the old silent no-op (a bare `store.notify()`
 *  with nothing on screen explaining why nothing happened). Same
 *  "error lives alongside the open-form state" shape as agreements.ts's own
 *  `CreateState`. */
interface SuggestFormState { recordId: string; error?: string }
let suggestFormState: SuggestFormState | null = null

function suggestFormView(recordId: string, error?: string): string {
  const err = error ? `<p class="form-error">${esc(error)}</p>` : ''
  return `
    <div class="pickup-suggest-form">
      <input id="pickup-suggest-name" type="text" placeholder="Suggested spot" />
      ${err}
      <button type="button" data-action="pickup-suggest-submit" data-record="${esc(recordId)}">Send</button>
      <button type="button" data-action="pickup-suggest-cancel">Cancel</button>
    </div>`
}

/** One record's §30 chain card — dots timeline, status line, role-appropriate
 *  action buttons. `selfRole` mirrors `performAction`'s own
 *  `fam.role === 'parent' ? 'guardian' : 'child'` mapping. */
export function cardView(p: store.Persisted, record: PickupRecord, selfPk: string, selfRole: 'guardian' | 'child'): string {
  const circle = p.circles.find((c) => c.id === record.circleId)
  const childName = memberName(circle, record.childPk)
  const collectorName = record.collectorPk ? memberName(circle, record.collectorPk) : 'a guardian'
  const buttons = actionsFor(record, selfPk, selfRole).map((a) => actionButtonView(record.id, a)).join('')
  const suggestForm = suggestFormState?.recordId === record.id ? suggestFormView(record.id, suggestFormState.error) : ''
  return `
    <div class="pickup-card">
      <p class="pickup-title"><strong>Pickup for ${esc(childName)}</strong></p>
      ${dotsView(record)}
      <p class="muted small">${esc(statusText(record, childName, collectorName))}</p>
      ${buttons ? `<div class="pickup-actions">${buttons}</div>` : ''}
      ${suggestForm}
    </div>`
}

/** Renders every card in `records` (already selected via `cardsForCircle`/
 *  `cardsForPerson`) — `''` when there's nothing to show, so callers can
 *  splice this straight into a larger template without an extra `if`. */
export function sectionView(p: store.Persisted, records: readonly PickupRecord[], selfPk: string, selfRole: 'guardian' | 'child'): string {
  if (!records.length) return ''
  return records.map((r) => cardView(p, r, selfPk, selfRole)).join('')
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

function inputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? ''
}

// ---------------------------------------------------------------------------
// Action dispatch — app.ts delegates every `pickup-*` data-action here.
// ---------------------------------------------------------------------------

export function handleAction(action: string, node: HTMLElement): void {
  const recordId = node.dataset.record ?? ''
  switch (action) {
    case 'pickup-accept': void performAction(recordId, 'accept'); break
    case 'pickup-decline': void performAction(recordId, 'decline'); break
    case 'pickup-on-way': void performAction(recordId, 'on-way'); break
    case 'pickup-collected': void performAction(recordId, 'collected'); break
    case 'pickup-suggest-open':
      suggestFormState = { recordId }
      store.notify()
      break
    case 'pickup-suggest-cancel':
      suggestFormState = null
      store.notify()
      break
    case 'pickup-suggest-submit': {
      // Final-review fix 4a/4b: name-only (no fix/coordinate dependency —
      // see `PickupSuggestion`'s own doc comment), so the only submit
      // failure left is an empty name — surfaced as a visible form error
      // (kept open) rather than the old silent no-op.
      const name = inputValue('pickup-suggest-name')
      if (!name) {
        suggestFormState = { recordId, error: 'Enter a name for the spot.' }
        store.notify()
        break
      }
      clearFields(['pickup-suggest-name']) // submitted: the form starts afresh
      suggestFormState = null
      void performAction(recordId, 'suggest', { name: name.slice(0, 60) })
      break
    }
    default:
      break
  }
}
