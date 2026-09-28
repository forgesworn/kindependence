// Family policy + approval requests: guardian Settings screen for setting
// each circle's per-action verdict (create-circle / add-member / join-circle
// / add-contact -> allow/prompt/deny), and the request/response flow a
// child's device runs when local policy evaluation says "ask" (BROOD.md §5
// "family policy", §6 "approval flow"). Implements the app-enforced v1 side
// of both: pure reducers (unit-tested in isolation, no store/network
// access), the wire builders/decoders riding the SAME circle-inbox gift-wrap
// path every other kindependence payload uses, and the Home/Settings UI.
//
// Wire shape: brood-kit's `buildBroodInner`/`parseBroodSignal` — kind 20078,
// content a plain JSON encoding of the signal, gift-wrapped to the circle's
// shared inbox exactly like agreements.ts's brood signals (no second
// encryption layer — see that file's module doc comment for why that's the
// documented precedent, not a shortcut).
//
// Reuses beacons.ts's plumbing rather than duplicating it: `publishOrEnqueue`,
// and — for receiving — beacons.ts's existing per-circle gift-wrap
// subscription, via `setSignalHandler` (appended alongside safety.ts's and
// agreements.ts's own handlers, not a second subscription — see beacons.ts's
// doc comment on that function). `appRelays` itself is NOT reused from
// circles.ts (unlike agreements.ts/safety.ts, which safely import it):
// circles.ts imports THIS module for policy gating, and beacons.ts already
// imports circles.ts (for `appRelays`) — importing `appRelays` here too
// would close a THREE-file cycle (circles.ts -> approvals.ts -> beacons.ts
// -> circles.ts). `relaysFor` below duplicates that one tiny computation
// instead. Note that importing beacons.ts here (for `publishOrEnqueue`/
// `setSignalHandler`) still leaves circles.ts -> approvals.ts -> beacons.ts
// -> circles.ts as a cycle at the MODULE level — this is safe (not a TDZ
// hazard) because every cross-module reference in all three files is made
// from inside a function body, never at module-top-level evaluation, so no
// module ever observes another's binding before it's initialized. Verified
// by both `vite build` and vitest's module graph, not just asserted.
//
// Safety path: this module is never imported by safety.ts, and never routes
// help/checkin/pickup — see global-constraints.md ("the safety path is never
// gated") and BROOD.md §7.1. There is nothing here that COULD gate them;
// this module only knows about the four `PolicyAction`s brood-kit defines
// (create-circle, add-member, join-circle, add-contact), a disjoint set from
// FLOCK's safety signal types.
//
// Re-running an approved action: a child device that gets `prompt` stashes
// enough of the action to redo it later as a plain `Record<string,string>`
// (the SAME shape `ApprovalReq.params` already carries on the wire — no
// separate local-only representation), rather than a closure — closures
// don't survive `JSON.stringify`, and the "pending" state must be persisted
// (task contract) so a reload mid-wait doesn't lose it. Which function
// actually redoes the action is registered by the caller (circles.ts, via
// `registerApprovalAction`) rather than imported directly here — approvals.ts
// must not import circles.ts, which already imports this module (for
// `verdictFor`/`raiseApproval`); the reverse would be circular, same
// registration-not-import idiom as beacons.ts's
// `setActiveAgreementProvider`.
//
// Boundary-exit requests (Phase 5 Task 5, brief §13.4): places.ts's
// leave-area feature rides this module's approval-req/resp wire (no new
// wire type — verified empirically that brood-kit's own `parseApprovalReq`
// HARD-REJECTS any `action` outside its closed 4-value `PolicyAction` enum,
// so a literal `'leave-area'` action can never reach a guardian's device at
// all; see `LEAVE_AREA_MARKER` below for the encoding this module actually
// supports). places.ts imports THIS module directly (`raiseApproval` plus
// the two registration hooks below) — same one-way-import discipline this
// file already keeps toward store.ts/identity.ts/beacons.ts/activity.ts.
// This module does NOT import places.ts back (same registration-not-import
// idiom as the circles.ts paragraph above): the two hooks
// (`registerApprovalAutoResolver`/`registerApprovalResolutionListener`) are
// places.ts's own entry points for the two things ONLY it knows how to do —
// evaluate its local, never-wire-synced leave-area policy, and apply its
// `Persisted.approvedLeaves` reducer identically on both a requester's and
// a resolver's device. This module also now imports notify.ts (new for
// this task — approval-req/resp never notified before this, verified by
// inspection), and notify.ts already imports places.ts (for `parseHHMM`),
// which now imports THIS module too, closing a THREE-file cycle
// (approvals.ts -> notify.ts -> places.ts -> approvals.ts). Safe by the
// exact same reasoning as the circles.ts/beacons.ts triangle above: every
// cross-module reference across all three files is made from inside a
// function body, never at module-top-level evaluation — verified by both
// `vite build` and vitest's module graph, not just asserted.

import * as store from './store.js'
import type { SessionInfo } from './session.js'
import * as beacons from './beacons.js'
import * as activity from './activity.js'
import { notify, shouldNotifyForEvent } from './notify.js'
import { currentSession, phoneSigner } from './session.js'
import { enqueue, registerSender, stillEnqueuingSession, pending as queuePending } from './structural-queue.js'
import { deriveInbox, isGuardian, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftWrap } from '@forgesworn/roost-kit'
import type { Rumor, SignedEvent, Signer } from '@forgesworn/roost-kit'
import {
  buildFamilyPolicy,
  buildApprovalReq,
  buildApprovalResp,
  buildBroodInner,
  parseBroodSignal,
  evaluatePolicy,
  latestPolicy,
  BROOD_SIGNAL_KIND,
} from '@forgesworn/brood-kit'
import type {
  ApprovalReq,
  ApprovalResp,
  BroodSignal,
  FamilyPolicy,
  PolicyAction,
  PolicyVerdict,
} from '@forgesworn/brood-kit'

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** Cap on `Persisted.approvals` — same discipline as safety.ts's
 *  `MAX_SAFETY_EVENTS`, so a long-lived circle's request history can't grow
 *  the persisted blob without bound. Unlike `safetyEvents` (a newest-first
 *  log, so a plain `slice(0, MAX)` always drops the oldest), pruning here
 *  favours keeping every UNRESOLVED request on the record — see
 *  `capApprovals` below. */
const MAX_APPROVALS = 100

// ---------------------------------------------------------------------------
// Relay boot helper — deliberately duplicated from circles.ts's own
// `appRelays` (see the module doc comment: importing it here would make
// circles.ts <-> approvals.ts circular). Same computation, same default.
// ---------------------------------------------------------------------------

const ENV_RELAY = typeof import.meta.env.VITE_DEFAULT_RELAY === 'string' ? import.meta.env.VITE_DEFAULT_RELAY.trim() : ''
const DEFAULT_RELAY = ENV_RELAY || 'wss://relay.trotters.cc'

function relaysFor(p: store.Persisted): string[] {
  return [p.settings.relayUrl || DEFAULT_RELAY]
}

/** The fixed set of administrative actions family policy can govern
 *  (BROOD.md §3) — used to render every row of the Settings screen and to
 *  build a FULL ruleset on every save (§5: never a delta). */
export const POLICY_ACTIONS: readonly PolicyAction[] = ['create-circle', 'add-member', 'join-circle', 'add-contact']
const POLICY_VERDICTS: readonly PolicyVerdict[] = ['allow', 'prompt', 'deny']

const ACTION_LABELS: Record<PolicyAction, string> = {
  'create-circle': 'Create a new circle',
  'add-member': 'Add a member to this circle',
  'join-circle': 'Join a circle',
  'add-contact': 'Add a contact',
}

// ---------------------------------------------------------------------------
// Boundary-exit requests (Phase 5 Task 5, brief §13.4) — the borrowed-
// envelope convention. See the module doc comment's new section above for
// why `action` itself can't just be `'leave-area'`.
// ---------------------------------------------------------------------------

/** Reserved `ApprovalReq.params` key: marks a request's `params` as NOT
 *  really describing its nominal `action` — a feature needing an
 *  approval-req/resp round trip for something outside brood-kit's closed
 *  `PolicyAction` enum borrows an existing action as a wire envelope and
 *  self-identifies via this key instead (`params.kind`, not `action`,
 *  since `params` is the one genuinely free-form `Record<string,string>`
 *  field the wire carries). `runApprovedAction` below checks this so an
 *  approved borrowed-envelope request never accidentally re-runs whatever
 *  real handler IS registered for the action it borrowed. */
export const PARAMS_KIND_KEY = 'kind'

/** The `PARAMS_KIND_KEY` value places.ts's leave-area feature uses —
 *  duplicated from places.ts's own `LEAVE_AREA_KIND` constant, not
 *  imported (this module must not import places.ts — see the module doc
 *  comment). Recognising it here needs only this one literal, never
 *  places.ts's full `LeaveAreaParams` type: every field this file reads
 *  off `params` below (`placeName`/`destination`/`withWho`/`durationMin`)
 *  is already a plain string, per `ApprovalReq.params`'s own
 *  `Record<string,string>` shape. Kept in sync with places.ts's copy by
 *  both files' own wire round-trip tests asserting the identical literal —
 *  same duplication idiom `relaysFor`'s own doc comment documents for
 *  circles.ts's `appRelays`. */
const LEAVE_AREA_MARKER = 'leave-area'

function isLeaveAreaParams(params: Record<string, string>): boolean {
  return params[PARAMS_KIND_KEY] === LEAVE_AREA_MARKER
}

/** §22.3's clear-explanation copy for a leave-area deny (task contract,
 *  verbatim, parameterised by place name). */
function leaveAreaDeniedCopy(placeName: string): string {
  return `Going out of ${placeName} isn't something that can be approved right now — talk to your guardian.`
}

/** The guardian-facing "a new leave-area request needs your review"
 *  notification body — only reached when the registered auto-resolver
 *  declined to answer (leave-area under 'prompt', or no resolver
 *  registered at all). Reads `params` fields directly (see
 *  `LEAVE_AREA_MARKER`'s own doc comment on why that needs no import). */
function leaveAreaRequestNotifyBody(params: Record<string, string>): string {
  const place = params.placeName || 'a safe area'
  const dest = params.destination
  return dest ? `Asking to leave ${place} — heading to ${dest}` : `Asking to leave ${place}`
}

/** A hook a domain module (places.ts) can register to auto-resolve a
 *  freshly-received approval-req on a GUARDIAN device, before it ever
 *  reaches the manual-review inbox. Needed because leave-area's
 *  family-policy verdict is necessarily LOCAL to the guardian's own device
 *  (`Persisted.leaveAreaPolicy` — see store.ts's own doc comment: brood-
 *  kit's `family-policy` wire signal can't carry a 5th action without
 *  corrupting the whole signal for every OTHER action too, verified
 *  empirically), so unlike the other four actions' send-side pre-check
 *  (`checkPolicy` in circles.ts, evaluated by the REQUESTER before ever
 *  sending anything), leave-area's Allow/Deny verdict can only be applied
 *  on RECEIPT, by whichever device actually holds the setting. Returns the
 *  verdict to auto-respond with (`true`/`false`), or `undefined` to leave
 *  the request for the normal manual-review path (the only path every
 *  OTHER action still takes — this hook is never consulted for them, see
 *  its one call site below). At most one resolver is registered at a time
 *  (last registration wins, same "one active provider" idiom as
 *  beacons.ts's `setActiveAgreementProvider`) — there's only ever one
 *  caller today (places.ts's `ensure()`). */
export type ApprovalAutoResolver = (circleId: string, req: ApprovalReq) => boolean | undefined
let autoResolver: ApprovalAutoResolver | null = null
export function registerApprovalAutoResolver(fn: ApprovalAutoResolver): void { autoResolver = fn }

/** A hook fired whenever ANY `approval-req` resolves (approved or denied) —
 *  on BOTH the device that raised it (via the received `approval-resp`,
 *  `handleIncomingSignal` below) and the device that answered it (via
 *  `respondApproval`'s own local apply) — with the SAME function reference
 *  both times, satisfying the task contract's "both devices converge...
 *  same reducer" requirement without this module needing to know what an
 *  "approved leave" even is. Fired for EVERY resolution regardless of
 *  action (a no-op for the other four — places.ts's own registered
 *  listener gates on `isLeaveAreaRequest` itself) and regardless of
 *  whether THIS device is the original requester (`Persisted.
 *  approvedLeaves` is scoped by circleId+placeId only, not by requester —
 *  see store.ts's own doc comment on that trade-off). Same "one active
 *  listener" idiom as `autoResolver` above. */
export interface ApprovalResolution { circleId: string; req: ApprovalReq; resp: ApprovalResp }
export type ApprovalResolutionListener = (resolution: ApprovalResolution) => void
let resolutionListener: ApprovalResolutionListener | null = null
export function registerApprovalResolutionListener(fn: ApprovalResolutionListener): void { resolutionListener = fn }

/** The Activity entry for a freshly-raised (`raiseApproval`) or freshly-
 *  received (`handleIncomingSignal`'s `'approval-req'` case) request —
 *  leave-area's own richer `'leave-requested'` kind/copy when `params`
 *  carries `LEAVE_AREA_MARKER`, else the existing generic
 *  `'approval-requested'`/`describeAction` line, unchanged for every other
 *  action. */
function requestActivityEvent(req: ApprovalReq, at: number, circleId: string, actorPk: string, id: string): activity.ActivityEvent {
  if (isLeaveAreaParams(req.params)) {
    return {
      id, at, kind: 'leave-requested', circleId, actorPk,
      params: { place: req.params.placeName ?? '', destination: req.params.destination ?? '', withWho: req.params.withWho ?? '' },
    }
  }
  return { id, at, kind: 'approval-requested', circleId, actorPk, params: { action: req.action } }
}

/** The Activity entry for a resolved request (`respondApproval` and
 *  `handleIncomingSignal`'s `'approval-resp'` case both call this) —
 *  leave-area's own `'leave-approved'`/`'leave-denied'` kinds when `req`
 *  carries the marker, else the existing generic `'approval-resolved'`,
 *  unchanged for every other action. `req.from` (the requester) rides
 *  alongside `place` in `params` — unlike the generic case, leave-area's
 *  copy (activity.ts's `summarize`) names BOTH who resolved it
 *  (`actorPk`/`resp.by`) and who asked (`params.from`). */
function resolutionActivityEvent(req: ApprovalReq, resp: ApprovalResp, circleId: string, id: string): activity.ActivityEvent {
  if (isLeaveAreaParams(req.params)) {
    return {
      id, at: resp.at, kind: resp.ok ? 'leave-approved' : 'leave-denied', circleId, actorPk: resp.by,
      params: { place: req.params.placeName ?? '', from: req.from },
    }
  }
  return { id, at: resp.at, kind: 'approval-resolved', circleId, actorPk: resp.by, params: { ok: String(resp.ok) } }
}

// ---------------------------------------------------------------------------
// Pure reducers — unit-tested in isolation (approvals.test.ts): family-policy
// latest-wins convergence, approval req/resp matching + dedupe. No store or
// network access anywhere in this section.
// ---------------------------------------------------------------------------

/** Merges an incoming `FamilyPolicy` into the per-circle map via brood-kit's
 *  own `latestPolicy` (BROOD.md §5's convergence rule: strictly-newer
 *  `updatedAt` wins; an exact-tie `updatedAt` falls to the lexicographically
 *  smaller `by`; an exact echo changes nothing). Returns the SAME map
 *  reference when the incoming policy doesn't win, so callers can skip a
 *  write (same idiom as agreements.ts's dedupe-by-identity checks). */
export function upsertFamilyPolicy(policies: Record<string, FamilyPolicy>, incoming: FamilyPolicy): Record<string, FamilyPolicy> {
  const current = policies[incoming.circleId]
  const winner = latestPolicy(current, incoming)
  if (winner === current) return policies
  return { ...policies, [incoming.circleId]: winner as FamilyPolicy }
}

/** The verdict for `action` under `circleId`'s current policy — a thin,
 *  pure wrapper over brood-kit's `evaluatePolicy` against the per-circle map
 *  (an absent circle policy, or an absent action within one, both fall
 *  through to `DEFAULT_VERDICT`, exactly as `evaluatePolicy` itself
 *  documents). */
export function policyVerdict(policies: Record<string, FamilyPolicy>, circleId: string, action: PolicyAction): PolicyVerdict {
  return evaluatePolicy(policies[circleId], action)
}

/** Caps `records` at `MAX_APPROVALS`, pruning RESOLVED entries oldest-first
 *  (by `req.at`) when over the limit — an outstanding, unresolved request
 *  ("waiting for a parent") is never silently dropped just because a lot of
 *  already-settled ones piled up first; only if unresolved requests alone
 *  somehow exceed the cap do the oldest of THOSE start falling off too, same
 *  fallback discipline as `safetyEvents`' plain oldest-first cap. A no-op
 *  (returns the same reference) when already within the cap. */
function capApprovals(records: store.PendingApprovalRecord[]): store.PendingApprovalRecord[] {
  if (records.length <= MAX_APPROVALS) return records
  const byAgeOldestFirst = (a: store.PendingApprovalRecord, b: store.PendingApprovalRecord) => a.req.at - b.req.at
  const resolved = records.filter((r) => r.resolved).sort(byAgeOldestFirst)
  const unresolved = records.filter((r) => !r.resolved).sort(byAgeOldestFirst)
  const dropOrder = [...resolved, ...unresolved] // resolved go first, so they're pruned before any unresolved request
  const toDrop = new Set(dropOrder.slice(0, records.length - MAX_APPROVALS).map((r) => r.req.id))
  return records.filter((r) => !toDrop.has(r.req.id))
}

/** Adds a newly-seen `approval-req`, unless this exact `id` is already
 *  tracked — a relay replay (or this device's own self-applied copy,
 *  arriving again via its wire echo) must never reset an already-answered
 *  request back to pending. Capped via `capApprovals` (see its doc comment).
 *
 *  Final fix B2/I2: `raisedByPhonePk`, when given, is stamped on the new
 *  record — `raiseApproval` below is the ONLY caller that passes it (this
 *  device's own phone key, the moment it raises the request). The receive
 *  path (`handleIncomingSignal`'s `approval-req` case) never passes it: a
 *  copy of the SAME req arriving over the wire — including on this
 *  identity's OTHER phone — must not claim to have raised it. Irrelevant
 *  once dedup above returns early, so a raiser's own wire echo can't
 *  overwrite what it already stamped locally either. */
export function upsertApprovalReq(
  records: store.PendingApprovalRecord[], req: ApprovalReq, circleId: string, raisedByPhonePk?: string,
): store.PendingApprovalRecord[] {
  if (records.some((r) => r.req.id === req.id)) return records
  return capApprovals([...records, { req, circleId, ...(raisedByPhonePk ? { raisedByPhonePk } : {}) }])
}

/** Applies an `approval-resp`, matching by `id` (BROOD.md §6). Only ever
 *  transitions a record OFF "unresolved" once — a duplicate/replayed resp
 *  finds nothing left to resolve and is a no-op, which is also this
 *  function's dedupe (same idiom as agreements.ts's `applyExtendResp`
 *  clearing `pendingExtend`). A resp naming an unknown request id is
 *  ignored. */
export function applyApprovalResp(records: store.PendingApprovalRecord[], resp: ApprovalResp): store.PendingApprovalRecord[] {
  return records.map((r) => {
    if (r.req.id !== resp.id || r.resolved) return r
    return { ...r, resolved: { ok: resp.ok, by: resp.by, at: resp.at } }
  })
}

// ---------------------------------------------------------------------------
// Id + wire helpers
// ---------------------------------------------------------------------------

function randomHex(byteLen: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLen)))
}

/** A fresh approval-request id — the match key an `approval-resp` answers
 *  by (BROOD.md §6). Just an unlinkability handle, not a secret — same idiom
 *  as agreements.ts's `newAgreementId`. */
export function newApprovalId(): string {
  return randomHex(8)
}

/** Gift-wraps any brood signal to `circle`'s shared inbox — the one place
 *  every builder below funnels through (same pattern as agreements.ts's
 *  `broodWrap`, duplicated rather than imported to keep the two sibling
 *  modules independent of each other). */
async function broodWrap(signer: Signer, circle: Circle, signal: BroodSignal, at: number): Promise<SignedEvent> {
  const inner = buildBroodInner(signal, at)
  const inbox = deriveInbox(circle.seedHex)
  return giftWrap(signer, inbox.pk, inner, inbox.pk)
}

/** Decode an already-unwrapped rumor as any brood signal, or null if it
 *  isn't one (wrong kind/`t`) or is malformed. Thin pass-through to
 *  brood-kit's own `parseBroodSignal` — except for a STRUCTURAL delivery
 *  (Signet identity plan, Task 9: `family-policy`/`approval-resp` now ride
 *  identity-signed structural events, beacons.ts's `receiveStructural`),
 *  whose synthesized inner rumor carries the STRUCTURAL event's own kind
 *  (`structural.ts`'s `STATEMENT_KIND`), not brood-kit's `BROOD_SIGNAL_KIND`
 *  — its `tags`/`content` are otherwise identical to a phone-key brood
 *  signal's (the queued payload IS the plain brood-signal JSON, same as
 *  every other structural sender's payload), so only the kind needs
 *  correcting for `parseBroodSignal`'s own kind check to pass. */
export function decodeBroodSignal(rumor: Rumor, sender: beacons.Sender): ReturnType<typeof parseBroodSignal> {
  const kind = sender.structural ? BROOD_SIGNAL_KIND : rumor.kind
  return parseBroodSignal({ kind, tags: rumor.tags, content: rumor.content })
}

// ---------------------------------------------------------------------------
// Local reads — thin wrappers over store state, used by circles.ts's gating
// call sites.
// ---------------------------------------------------------------------------

/** The verdict `circleId`'s current family policy gives `action`, reading
 *  live store state — circles.ts's gating call sites' one entry point into
 *  this module. */
export function verdictFor(circleId: string, action: PolicyAction): PolicyVerdict {
  return policyVerdict(store.load().familyPolicies, circleId, action)
}

// ---------------------------------------------------------------------------
// Re-run registration — see the module doc comment's "re-running an approved
// action" section.
// ---------------------------------------------------------------------------

export type ApprovalActionHandler = (params: Record<string, string>) => void | Promise<void>
const actionHandlers = new Map<PolicyAction, ApprovalActionHandler>()

/** Registers the function that redoes `action` once its approval-req is
 *  granted. Last registration for a given action wins (a plain `Map.set`) —
 *  circles.ts calls this once per action from its own `ensure()`, matching
 *  the idempotent-registration idiom `setSignalHandler`/
 *  `setActiveAgreementProvider` already establish elsewhere. */
export function registerApprovalAction(action: PolicyAction, fn: ApprovalActionHandler): void {
  actionHandlers.set(action, fn)
}

function runApprovedAction(req: ApprovalReq): void {
  // Borrowed-envelope request (see `PARAMS_KIND_KEY`) — the real handler
  // registered for `req.action` (its wire envelope, not its true meaning)
  // must never run for this.
  if (req.params[PARAMS_KIND_KEY]) return
  const fn = actionHandlers.get(req.action)
  if (fn) void fn(req.params)
}

// ---------------------------------------------------------------------------
// Outgoing — family policy publish (guardian), approval request (any
// requester whose local policy check came back `prompt`), approval response
// (guardian). A phone-signed one applies its own reducer to local state
// synchronously (see agreements.ts's module doc comment's self-echo section
// for why), then
// publishes via `beacons.publishOrEnqueue` (never throws — offline falls
// over to the shared outbox).
//
// Final fix round 3, F2: `family-policy` and `approval-resp` are the two
// actions here that go through the STRUCTURAL queue (identity-signed), not
// a direct phone-key publish — My Signet may be asleep for minutes, or say
// no. So they do NOT change local state at enqueue: until the signed event
// has gone out the action shows only in the structural queue's own
// "Pending" banner. The local apply (and its Activity entry, and for a
// response `resolutionListener`'s side effect — places.ts's leave-area
// `approvedLeaves`) runs inside this module's registered sender, after
// `sendStructural`, from the item's own persisted payload. A cancel or
// dismiss therefore has nothing to undo, and an app restart or sign-out
// loses nothing but the queue item itself.
// ---------------------------------------------------------------------------

/** Guardian-only: publishes `circleId`'s full policy ruleset (BROOD.md §5 —
 *  always the complete `rules` map, never a delta). It is applied locally
 *  once sent (`applySentFamilyPolicy`), not before. */
export async function publishFamilyPolicy(circleId: string, rules: Partial<Record<PolicyAction, PolicyVerdict>>): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle || !isGuardian(circle, self.identityPk)) return
  const at = nowSec()
  const policy = buildFamilyPolicy({ circleId, rules, updatedAt: at, by: self.identityPk })
  enqueue({ action: 'family-policy', circleId, payload: JSON.stringify(policy), label: `Update family policy for ${circle.name}` })
}

/** Final fix round 3, F2: applies our own sent policy locally — the same
 *  latest-wins merge a receiver would, so a co-guardian's newer ruleset
 *  that arrived meanwhile stands. Runs only after the signed event went
 *  out. */
function applySentFamilyPolicy(circleId: string, policy: FamilyPolicy): void {
  store.update((sp) => { sp.familyPolicies = upsertFamilyPolicy(sp.familyPolicies, policy) })
  activity.recordActivity({ id: `local-policy-changed-${circleId}-${policy.updatedAt}`, at: policy.updatedAt, kind: 'policy-changed', circleId, actorPk: policy.by, params: {} })
}

/** Raises an `approval-req` to `circleId`'s guardian(s) for `action`, with
 *  `params` describing what's being asked (BROOD.md §6.2) — this is also the
 *  serializable stash `registerApprovalAction`'s handler redoes the action
 *  from once granted. Returns the request's id (the requester's own
 *  "waiting for a parent" pending state is just this id's record in
 *  `p.approvals` with no `resolved` yet — nothing further to track). */
export async function raiseApproval(circleId: string, action: PolicyAction, params: Record<string, string>): Promise<string | null> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle) return null
  const at = nowSec()
  const req = buildApprovalReq({ id: newApprovalId(), action, params, from: self.identityPk }, at)
  // Final fix B2/I2: stamp the RAISING phone, not just the identity — see
  // `upsertApprovalReq`'s own doc comment.
  store.update((sp) => { sp.approvals = upsertApprovalReq(sp.approvals, req, circleId, self.phonePk) })
  activity.recordActivity(requestActivityEvent(req, at, circleId, self.identityPk, `local-approval-requested-${req.id}`))
  const wrap = await broodWrap(phoneSigner(), circle, req, at)
  await beacons.publishOrEnqueue(relaysFor(p), wrap)
  return req.id
}

/** Guardian-only: answers a pending `approval-req` by id. The answer is
 *  applied locally once sent (`applySentApprovalResp`), not before. */
export async function respondApproval(reqId: string, ok: boolean): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const record = p.approvals.find((r) => r.req.id === reqId)
  if (!self || !record || record.resolved) return
  const circle = p.circles.find((c) => c.id === record.circleId)
  if (!circle || !isGuardian(circle, self.identityPk)) return
  const at = nowSec()
  // Already answered from this phone and waiting on My Signet: don't queue
  // a second answer.
  if (queuePending().some((q) => q.action === 'approval-resp' && queuedRespId(q.payload) === reqId)) return
  const resp = buildApprovalResp({ id: reqId, ok, by: self.identityPk }, at)
  enqueue({ action: 'approval-resp', circleId: circle.id, payload: JSON.stringify(resp), label: `Answer a request in ${circle.name}` })
}

function queuedRespId(payload: string): string | undefined {
  try { return (JSON.parse(payload) as { id?: string }).id } catch { return undefined }
}

/** Final fix round 3, F2: applies our own sent answer locally — resolves
 *  the request, records it, and fires `resolutionListener` (places.ts's
 *  leave-area `approvedLeaves`). Runs only after the signed event went out;
 *  if another guardian's answer resolved the request meanwhile, that one
 *  stands and nothing more happens here. */
function applySentApprovalResp(circleId: string, resp: ApprovalResp): void {
  let resolved: ApprovalReq | null = null
  store.update((sp) => {
    const before = sp.approvals.find((r) => r.req.id === resp.id)
    if (!before || before.resolved || before.circleId !== circleId) return
    sp.approvals = applyApprovalResp(sp.approvals, resp)
    resolved = before.req
  })
  if (!resolved) return
  const req: ApprovalReq = resolved
  activity.recordActivity(resolutionActivityEvent(req, resp, circleId, `local-approval-resolved-${resp.id}`))
  resolutionListener?.({ circleId, req, resp })
}

/** Removes a resolved (approved/denied) request from local view — a purely
 *  local action (nothing broadcast); "clear this" for a denied card, or for
 *  an approved one after its action has already run. */
export function dismissApproval(reqId: string): void {
  store.update((p) => { p.approvals = p.approvals.filter((r) => r.req.id !== reqId) })
}

// ---------------------------------------------------------------------------
// Incoming — registered with beacons.ts as an ADDITIONAL handler for
// non-beacon circle-inbox signals (alongside safety.ts's and agreements.ts's
// own — see beacons.ts's `setSignalHandler` doc comment).
// ---------------------------------------------------------------------------

export function handleIncomingSignal(circle: Circle, rumor: Rumor, t: string, sender: beacons.Sender): void {
  const self = currentSession()
  // Self-echo: this device already applied its own reducer synchronously the
  // moment it sent the signal (see the module doc comment) — re-applying the
  // wire echo would be redundant at best and, for a resp, would re-trigger
  // `runApprovedAction` a second time at worst.
  if (self && sender.signerPk === self.phonePk) return
  const signal = decodeBroodSignal(rumor, sender)
  if (!signal) return
  // Receive side records the peer's action (task contract) — one id per
  // wire event, same idiom as agreements.ts's own receive path.
  const rid = rumor.id ?? `${t}-${sender.memberPk}-${rumor.created_at}`
  switch (signal.t) {
    case 'family-policy':
      // Review fix round 1: `family-policy` is a STRUCTURAL action — a
      // phone-signed copy must never apply, even if it otherwise decodes
      // (beacons.ts's choke point already drops a phone-signed structural
      // `t`, but this is the same belt-and-braces re-check every other
      // structural handler in this codebase makes at its own dispatch).
      if (!sender.structural) return
      // Review fix round 1: bind authority to the circle this signal
      // actually arrived on — a guardian of circle A signing a genuine
      // family-policy for circle B must not have it applied just because
      // this device happened to receive it on A's inbox.
      if (signal.circleId !== circle.id) return
      // sender-auth: ffb48b9 class — BROOD.md §3: `by` names the guardian
      // who wrote this ruleset (the resolved sender).
      if (signal.by !== sender.memberPk) return
      store.update((p) => { p.familyPolicies = upsertFamilyPolicy(p.familyPolicies, signal) })
      activity.recordActivity({ id: rid, at: signal.updatedAt, kind: 'policy-changed', circleId: signal.circleId, actorPk: signal.by, params: {} })
      return
    case 'approval-req': {
      // sender-auth: ffb48b9 class — BROOD.md §3: `from` names the
      // requester (the resolved sender). `params` may itself name a THIRD
      // party (e.g. places.ts's leave-area `child`/target fields riding
      // inside it) — those are never bound here, only `from` itself.
      if (signal.from !== sender.memberPk) return
      let inserted = false
      store.update((p) => {
        const next = upsertApprovalReq(p.approvals, signal, circle.id)
        if (next !== p.approvals) inserted = true
        p.approvals = next
      })
      activity.recordActivity(requestActivityEvent(signal, signal.at, circle.id, signal.from, rid))
      // Task 5 (§13.4): give a registered auto-resolver (places.ts's local
      // leave-area policy) first refusal at answering this — only when
      // THIS device actually guards the circle (a non-guardian device
      // seeing the request has nothing to auto-answer with, same gate
      // `respondApproval` itself already enforces one level down). A
      // `verdict === undefined` (every OTHER action, or leave-area under
      // 'prompt') falls straight through to the unchanged manual-review
      // inbox — this device gets a plain "needs your review" nudge instead.
      //
      // Both actions gate on `inserted` AND freshness (flock ff5eead parity):
      // the rumor-id dedup upstream is per-session, so after a relaunch a
      // captured req wrap replays as "new" — pre-gate, a stale leave-area
      // request could re-arm escalation suppression via the auto-resolver
      // (`respondApproval` stamps the grant `at: nowSec()`, opening a LIVE
      // window from a dead ask). `signal.at` is sealed by the sender. The
      // card upsert + Activity above stay ungated — state repopulates on
      // legitimate catch-up; only the actions gate. Fail-closed: a genuinely
      // delayed request simply gets manual review from the (still-rendered)
      // card instead of an automatic answer.
      if (self && isGuardian(circle, self.identityPk) && shouldNotifyForEvent(inserted, signal.at, nowSec())) {
        const verdict = autoResolver?.(circle.id, signal)
        if (verdict !== undefined) void respondApproval(signal.id, verdict)
        else if (isLeaveAreaParams(signal.params)) void notify('request', signal.from, 'Boundary-exit request', leaveAreaRequestNotifyBody(signal.params))
      }
      return
    }
    case 'approval-resp': {
      // Review fix round 1: `approval-resp` is a STRUCTURAL action — same
      // belt-and-braces re-check as `family-policy` above.
      if (!sender.structural) return
      // sender-auth: ffb48b9 class — BROOD.md §3: `by` names the guardian
      // answering (the sender).
      if (signal.by !== sender.memberPk) return
      // Review fix round 1: `approval-resp` itself carries no `circleId`
      // (brood-kit's own shape — see `parseApprovalResp`), so authority is
      // bound to the PENDING RECORD's own circle instead, checked BEFORE
      // any mutation: a guardian of circle A answering (genuinely, with
      // their own valid signature) must not have it applied to a same-id
      // request this device is tracking under circle B just because this
      // rumor arrived on A's inbox.
      const pending = store.load().approvals.find((r) => r.req.id === signal.id)
      if (pending && pending.circleId !== circle.id) return
      let toRerun: ApprovalReq | null = null
      let toResolve: ApprovalReq | null = null
      store.update((p) => {
        const before = p.approvals.find((r) => r.req.id === signal.id)
        p.approvals = applyApprovalResp(p.approvals, signal)
        // `applyApprovalResp`'s own dedupe (never re-resolves an
        // already-resolved record) makes `before && !before.resolved` this
        // block's one-shot guard against acting twice on a replayed resp.
        if (before && !before.resolved) {
          toResolve = before.req
          // Final fix B2/I2: only the PHONE that raised the request redoes
          // the stashed action, and only on a grant. `before.req.from` is
          // the requesting IDENTITY, not the phone — with several phones
          // per identity (spec §5), every one of that identity's phones
          // tracks the same `req.from`, so gating on it alone redoes the
          // action once PER PHONE (duplicate circles/invites). Gate on
          // `raisedByPhonePk` (stamped only by `raiseApproval`'s own local
          // write on the phone that actually asked) instead.
          if (signal.ok && self && before.raisedByPhonePk === self.phonePk) toRerun = before.req
        }
      })
      if (toResolve) {
        const resolvedReq: ApprovalReq = toResolve
        activity.recordActivity(resolutionActivityEvent(resolvedReq, signal, circle.id, rid))
        resolutionListener?.({ circleId: circle.id, req: resolvedReq, resp: signal })
        // Task 5 (§13.4): the outcome notification is for the REQUESTER's
        // own device alone — a co-guardian's or bystander's device also
        // receiving this same resp (see `ApprovalResolutionListener`'s own
        // doc comment on why the listener itself fires regardless) has
        // nothing of its own to be told.
        // Freshness-gated (flock ff5eead parity): the resolution itself
        // applies regardless (the leave window is computed from the
        // authentic `resp.at`, so a stale grant is already expired), but a
        // relaunch-replayed old resp must not pop a "was approved" push.
        if (self && resolvedReq.from === self.identityPk && isLeaveAreaParams(resolvedReq.params) && shouldNotifyForEvent(true, signal.at, nowSec())) {
          const placeName = resolvedReq.params.placeName ?? 'your safe area'
          const title = signal.ok ? 'Your request was approved' : "Your request wasn't approved"
          const body = signal.ok ? `You can go out — back within the time your circle agreed.` : leaveAreaDeniedCopy(placeName)
          void notify('request', signal.by, title, body)
        }
      }
      if (toRerun) runApprovedAction(toRerun)
      return
    }
    default:
      // agreement / agreement-ack / agreement-status / extend-req /
      // extend-resp — agreements.ts's concern.
      return
  }
}

/** Registers the structural queue's senders this module owns
 *  (`family-policy`/`approval-resp` — Signet identity plan, Task 9). Each
 *  simply hands the identity-signed event to beacons.ts's `sendStructural`
 *  once it's been signed, same pattern as circles.ts's own
 *  `registerStructuralSenders`. Idempotent (a re-registration replaces the
 *  same function). */
export function registerStructuralSenders(): void {
  registerSender('family-policy', async (signed, item) => {
    const c = store.load().circles.find((x) => x.id === item.circleId)
    if (!c) return
    await beacons.sendStructural(c, signed)
    if (!stillEnqueuingSession(item)) return // final fix round 4
    applySentFamilyPolicy(c.id, JSON.parse(item.payload) as FamilyPolicy)
  })
  registerSender('approval-resp', async (signed, item) => {
    const c = store.load().circles.find((x) => x.id === item.circleId)
    if (!c) return
    await beacons.sendStructural(c, signed)
    if (!stillEnqueuingSession(item)) return // final fix round 4
    applySentApprovalResp(c.id, JSON.parse(item.payload) as ApprovalResp)
  })
}

/** Registers this module's incoming-signal handler with beacons.ts. Called
 *  from app.ts's render() alongside circles.ensure/beacons.ensure/
 *  safety.ensure/agreements.ensure — same idempotent "the one side-effecting
 *  entry point" idiom as all four. */
let registered = false
export function ensure(): void {
  if (registered) return
  registered = true
  registerStructuralSenders()
  beacons.setSignalHandler(handleIncomingSignal)
}

// ---------------------------------------------------------------------------
// View — the You tab's per-circle family policy screen (guardian only), and
// a Circles-tab section for approval cards: a requester's own pending/denied
// asks, and (for a guardian) other members' pending requests to approve/
// deny. UI wiring only past this point — no unit tests (build-gated), same
// convention as circles.ts/safety.ts/agreements.ts.
// ---------------------------------------------------------------------------

let policyNotice: Record<string, string> = {}

/** You tab: one section per circle this device guards, four verdict
 *  pickers each (BROOD.md §3's fixed `PolicyAction` set), and a Save button
 *  that publishes the full ruleset. Nothing renders for a child device or a
 *  guardian of no circles. */
export function policyView(p: store.Persisted, fam: SessionInfo): string {
  const guardianCircles = p.circles.filter((c) => isGuardian(c, fam.identityPk))
  if (fam.dependant || !guardianCircles.length) return ''
  const sections = guardianCircles.map((c) => policySectionView(p, c)).join('')
  return `<section class="contact-group"><h2>Family policy</h2>${sections}</section>`
}

function policySectionView(p: store.Persisted, circle: Circle): string {
  const policy = p.familyPolicies[circle.id]
  const rows = POLICY_ACTIONS.map((action) => policyRowView(circle.id, action, evaluatePolicy(policy, action))).join('')
  const notice = policyNotice[circle.id] ? `<p class="muted">${esc(policyNotice[circle.id] as string)}</p>` : ''
  return `
    <div class="policy-circle">
      <h3>${esc(circle.name)}</h3>
      ${rows}
      ${notice}
      <button type="button" data-action="policy-save" data-circle="${esc(circle.id)}">Save family policy</button>
      ${leaveAreaPolicyRowView(p, circle.id)}
    </div>
  `
}

/** Task 5 (§13.4): boundary-exit requests' own local-only policy row —
 *  deliberately its own tiny select+button, NOT folded into `rows`/
 *  `submitPolicy` above, since `Persisted.leaveAreaPolicy` never rides the
 *  wire `family-policy` full-set broadcast the other four rows do (see
 *  store.ts's own doc comment for why) — applies immediately on Save,
 *  local only, no "Saving…"/publish round trip needed. */
function leaveAreaPolicyRowView(p: store.Persisted, circleId: string): string {
  const current = p.leaveAreaPolicy[circleId] ?? 'prompt'
  const options = POLICY_VERDICTS.map((v) => `<option value="${v}"${v === current ? ' selected' : ''}>${v}</option>`).join('')
  return `
    <div class="policy-row">
      <label for="leave-policy-${esc(circleId)}">Boundary-exit requests (this device only)</label>
      <select id="leave-policy-${esc(circleId)}">${options}</select>
      <button type="button" data-action="policy-leave-save" data-circle="${esc(circleId)}">Save</button>
    </div>
  `
}

function policyRowView(circleId: string, action: PolicyAction, current: PolicyVerdict): string {
  const options = POLICY_VERDICTS.map((v) => `<option value="${v}"${v === current ? ' selected' : ''}>${v}</option>`).join('')
  return `
    <div class="policy-row">
      <label for="policy-${esc(circleId)}-${action}">${esc(ACTION_LABELS[action])}</label>
      <select id="policy-${esc(circleId)}-${action}">${options}</select>
    </div>
  `
}

function submitPolicy(circleId: string): void {
  const rules: Partial<Record<PolicyAction, PolicyVerdict>> = {}
  for (const action of POLICY_ACTIONS) {
    const el = document.getElementById(`policy-${circleId}-${action}`) as HTMLSelectElement | null
    const value = el?.value
    if (value && (POLICY_VERDICTS as readonly string[]).includes(value)) rules[action] = value as PolicyVerdict
  }
  policyNotice = { ...policyNotice, [circleId]: 'Saving…' }
  store.notify()
  void publishFamilyPolicy(circleId, rules).then(() => {
    policyNotice = { ...policyNotice, [circleId]: 'Saved.' }
    store.notify()
  })
}

/** `leaveAreaPolicyRowView`'s Save button — writes `Persisted.
 *  leaveAreaPolicy[circleId]` directly (local only, applies immediately,
 *  no wire publish — see that field's own store.ts doc comment). */
function submitLeaveAreaPolicy(circleId: string): void {
  const el = document.getElementById(`leave-policy-${circleId}`) as HTMLSelectElement | null
  const value = el?.value
  if (!circleId || !value || !(POLICY_VERDICTS as readonly string[]).includes(value)) return
  store.update((p) => { p.leaveAreaPolicy = { ...p.leaveAreaPolicy, [circleId]: value as PolicyVerdict } })
}

/** Circles tab: this device's own outstanding/denied requests ("waiting for a
 *  parent" / explanatory denial), and — for a guardian — other members'
 *  pending requests with Approve/Deny. Approved-and-already-rerun requests
 *  are left out entirely (see the doc comment above `dismissApproval`) so
 *  this list only ever shows something still needing attention. */
export function requestsView(p: store.Persisted, fam: SessionInfo): string {
  const own = p.approvals.filter((r) => r.req.from === fam.identityPk && (!r.resolved || !r.resolved.ok))
  const toReview = p.approvals.filter((r) => {
    if (r.resolved || r.req.from === fam.identityPk) return false
    const circle = p.circles.find((c) => c.id === r.circleId)
    return !!circle && isGuardian(circle, fam.identityPk)
  })
  if (!own.length && !toReview.length) return ''
  const ownCards = own.map((r) => ownRequestCardView(p, r)).join('')
  const reviewCards = toReview.map((r) => reviewCardView(p, r)).join('')
  // `id` is activity.ts's `approval-requested`/`approval-resolved` deep-link
  // target (app.ts scrolls here after switching to the Circles tab).
  return `<section class="contact-group" id="approvals-card"><h2>Approvals</h2>${ownCards}${reviewCards}</section>`
}

function ownRequestCardView(p: store.Persisted, r: store.PendingApprovalRecord): string {
  const circle = p.circles.find((c) => c.id === r.circleId)
  const leaveParams = isLeaveAreaParams(r.req.params) ? r.req.params : undefined
  const label = leaveParams ? `Asked to leave ${esc(leaveParams.placeName || 'a safe area')}` : esc(ACTION_LABELS[r.req.action])
  if (!r.resolved) {
    return `<div class="contact-item">${label}${circle ? ` — ${esc(circle.name)}` : ''}<span class="badge">Waiting for a parent</span></div>`
  }
  // Task 5 (§13.4/§22.3): a leave-area deny renders the clear-explanation
  // copy inline instead of the generic "Denied" badge every other action
  // still uses.
  const explanation = leaveParams && !r.resolved.ok
    ? `<p class="muted small">${esc(leaveAreaDeniedCopy(leaveParams.placeName || 'a safe area'))}</p>`
    : ''
  return `
    <div class="contact-item">${label}${circle ? ` — ${esc(circle.name)}` : ''}<span class="badge">Denied</span>
      ${explanation}
      <button type="button" data-action="approval-dismiss" data-id="${esc(r.req.id)}">Dismiss</button>
    </div>
  `
}

function reviewCardView(p: store.Persisted, r: store.PendingApprovalRecord): string {
  const circle = p.circles.find((c) => c.id === r.circleId)
  const who = circle?.members.find((m) => m.pk === r.req.from)?.name || shortPk(r.req.from)
  const desc = describeRequest(r.req.action, r.req.params)
  return `
    <div class="contact-item">${esc(who)} — ${esc(desc)}${circle ? ` (${esc(circle.name)})` : ''}
      <div class="actions">
        <button type="button" data-action="approval-approve" data-id="${esc(r.req.id)}">Approve</button>
        <button type="button" data-action="approval-deny" data-id="${esc(r.req.id)}">Deny</button>
      </div>
    </div>
  `
}

function describeRequest(action: PolicyAction, params: Record<string, string>): string {
  // Task 5 (§13.4): the borrowed envelope's OWN description
  // (`describeAction`/`ACTION_LABELS` below) would read as actively wrong
  // here ("wants to add a new contact") — leave-area's marker takes
  // priority over `action` for every request this module renders.
  if (isLeaveAreaParams(params)) {
    const place = params.placeName || 'a safe area'
    const dest = params.destination ? ` — going to ${params.destination}` : ''
    const withWho = params.withWho ? ` with ${params.withWho}` : ''
    const duration = params.durationMin ? ` for ${params.durationMin} min` : ''
    return `wants to leave ${place}${dest}${withWho}${duration}`
  }
  switch (action) {
    case 'create-circle': return `wants to create a new circle${params.name ? ` called "${params.name}"` : ''}`
    case 'add-member': return 'wants to add a new member'
    case 'join-circle': return 'wants to join a circle'
    case 'add-contact': return 'wants to add a new contact'
  }
}

function shortPk(pk: string): string {
  return `${pk.slice(0, 8)}…`
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

// ---------------------------------------------------------------------------
// Action dispatch — app.ts delegates every `policy-*`/`approval-*`
// data-action here.
// ---------------------------------------------------------------------------

export function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'policy-save':
      submitPolicy(node.dataset.circle ?? '')
      break
    case 'policy-leave-save':
      submitLeaveAreaPolicy(node.dataset.circle ?? '')
      break
    case 'approval-approve':
      void respondApproval(node.dataset.id ?? '', true)
      break
    case 'approval-deny':
      void respondApproval(node.dataset.id ?? '', false)
      break
    case 'approval-dismiss':
      dismissApproval(node.dataset.id ?? '')
      break
    default:
      break
  }
}
