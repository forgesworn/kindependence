// Activity timeline: a single append-only, capped, deduped log of "things
// that happened" across every circle this device belongs to — the record
// every other module's send/receive paths write to via the one entry point
// `recordActivity`, and the Activity tab renders from (brief §24). Neutral
// language only (global-constraints.md §31): summaries here describe what
// happened, never accuse ("left the safe area", not "violated the
// boundary" — see `summarize` below).
//
// Ownership split, same convention as safety.ts's `SafetyEvent`: the
// `ActivityEvent` shape and `Persisted.activity` field live in store.ts (per
// that file's own doc comment); everything else — the recorder, summaries,
// filters, deep links, and the Activity tab UI — lives here.
//
// Actor names are deliberately NOT stored on the event (`actorPk` only) —
// `resolveName` below looks them up from the circle's CURRENT member list
// (falling back to the rolodex) every time a summary is built, so a later
// name change is reflected retroactively rather than frozen at record time.
//
// recordActivity is the ONE entry point every other module's send/receive
// path calls — one line at the site where the event is already handled (see
// safety.ts/agreements.ts/approvals.ts/circles.ts call sites: "send side
// records own action; receive side records the peer's"). Dedupe is by `id`:
// a wire event supplies its own rumor id (receive side) or a synthesised
// `local-<kind>-<at>-<circleId>` id (send side — `localActivityId` below,
// same family as safety.ts's own `appendSafetyEvent` ids) so a relay replay
// or a device's own wire echo never double-logs the same event.
//
// Render-on-state / mid-render discipline: like every other store.update()
// caller in this codebase, recordActivity's notify() re-enters render()
// synchronously. Every call site wiring this module records from an event
// handler or a receive-path callback (matching the rest of the app's own
// discipline) — never from inside view()/summarize(), which run DURING a
// render pass and must stay pure.
//
// arrival/departure/safe-area-*/precision-raised (safe areas, Task 7 —
// places.ts; the precision-raise transition, beacons.ts) and
// `emergency-access` (transparent emergency access, Task 6, brief
// §11.4-11.5/§2.3) are all wired now — safety.ts records `emergency-access`
// both on the requester's send side and on every receiving circle member's
// device (correlated with a companion reason DM — see safety.ts's own
// module doc comment on `correlateIncomingFindreq`), and messages.ts
// records the requester's own send-side entry.

import * as store from './store.js'
import type { ActivityEvent } from './store.js'
import { currentSession } from './session.js'
export type { ActivityEvent } from './store.js'

/** Absolute backstop on `Persisted.activity` in the PURE reducer below —
 *  newest-first, oldest entries fall off once full. Same discipline as
 *  safety.ts's `MAX_SAFETY_EVENTS`/approvals.ts's `MAX_APPROVALS`, just a
 *  much bigger number: this is a real "what happened" history, not just a
 *  recent-alerts log.
 *
 *  Phase 5 Task 4 (brief §24.6): this is now a CEILING, not the user-facing
 *  cap — it equals the largest choice in `ACTIVITY_RETENTION_CAP_OPTIONS`
 *  below, so a configured cap of 1000 is never pre-truncated away here. The
 *  actual user-configured cap (100/500/1000, default 500 — the same default
 *  this constant used to enforce directly) is applied afterward by
 *  `pruneActivity`, in `recordActivity`'s wrapper below — same "pure reducer
 *  capped at a hard ceiling, impure wrapper composes the real policy on top"
 *  split as this module's own dedupe-then-prune pipeline. This ceiling still
 *  exists so a corrupt/out-of-range persisted `activityRetention.cap` can
 *  never let the list grow unbounded. */
const HARD_MAX_ACTIVITY = 1000

/** Every event kind the timeline understands today (brief §24.1's list).
 *  `ActivityEvent.kind` itself is typed as a plain `string` (see store.ts's
 *  doc comment) — this union is for call-site type safety when RECORDING an
 *  event; every reader below (`summarize`, `filterFor`, `deepLinkFor`) casts
 *  defensively and falls through to a sane default for any string outside
 *  it, so a persisted event from a future build with an unknown kind still
 *  renders instead of crashing (task contract: "unknown-kind tolerance for
 *  forward compat"). */
export type ActivityKind =
  | 'arrival' | 'departure'
  | 'safe-area-warning' | 'safe-area-escalation'
  | 'window-reminder' | 'window-missed' | 'window-met'
  | 'checkin'
  | 'pickup-requested' | 'pickup-accepted' | 'pickup-status'
  | 'sos'
  | 'agreement-created' | 'agreement-acked' | 'agreement-status' | 'agreement-extended'
  | 'leave-reminder'
  | 'policy-changed'
  | 'approval-requested' | 'approval-resolved'
  | 'member-joined' | 'member-removed' | 'member-left'
  | 'precision-raised'
  | 'emergency-access'
  | 'message'
  | 'battery-low'
  | 'meet-point'
  | 'journey-start' | 'journey-done'
  // Phase 5 Task 5 (brief §13.4): boundary-exit permission requests.
  // 'leave-requested'/'leave-approved'/'leave-denied' replace the generic
  // 'approval-requested'/'approval-resolved' kinds for THIS one borrowed-
  // envelope action (approvals.ts's `requestActivityEvent`/
  // `resolutionActivityEvent` pick between the two) — a plain "requested
  // approval to add a contact" line would be actively misleading here,
  // since 'add-contact' is only the wire envelope, never the real ask (see
  // approvals.ts's own doc comment on `LEAVE_AREA_MARKER`). 'leave-expired'
  // is places.ts's own — the escalation supervisor's episode transitioning
  // out of 'leave-approved' because `until` passed while still outside,
  // resuming the normal warning+grace flow (never itself an approval
  // request/response).
  | 'leave-requested' | 'leave-approved' | 'leave-denied' | 'leave-expired'
  // Phase 6 Task 2 (design spec §2, brief §2.3/§2.4): a guardian's explicit
  // "apply this independence level" action — milestones.ts's `applyLevel`.
  // Same "administrative, guardian-authored, permanently auditable" family
  // as 'policy-changed' just above (indeed `applyLevel` publishes a REAL
  // 'policy-changed' via the existing family-policy mechanism too — this is
  // the complementary record of the LOCAL knobs — grace/escalation/level —
  // that publish doesn't itself cover). `params.label` carries the level's
  // display label ('Close'/'Growing'/'Trusted'), never a raw level number
  // alone (a future preset relabel must not make old Activity entries read
  // as a mystery number).
  | 'independence-applied'
  // Phase 7 Task 4 (design spec §4): flock-interoperable dropped pins
  // (pins.ts). One kind covers create, one covers remove — same "params
  // discriminates the sub-case" idiom `meet-point`'s own `params.action`
  // uses one level up, just split into two kinds instead since drop/remove
  // are wire-distinct events (a tombstone, not an edit) rather than one
  // signal type with a flag. Ambient, not urgent: Activity records both
  // (this entry), but NEITHER ever triggers a system notification — see
  // pins.ts's own send/receive sites, which simply never call notify.ts's
  // `notify()` at all (`[maintainer-review]`: confirm this stays ambient-only
  // as the feature gets real-world use).
  | 'pin-dropped' | 'pin-removed'

/** Fresh `id` for a locally-originated event (a send-side action with no
 *  wire event id of its own to key off) — same `local-<kind>-<at>-<circleId>`
 *  shape safety.ts's own `appendSafetyEvent` callers already use, so the two
 *  logs' synthesised ids stay recognisably in the same family. */
export function localActivityId(kind: string, at: number, circleId: string | undefined): string {
  return `local-${kind}-${at}-${circleId ?? ''}`
}

// ---------------------------------------------------------------------------
// Recorder — the one entry point. `applyRecordActivity` is the pure reducer
// (unit-tested directly in activity.test.ts); `recordActivity` is the thin
// impure wrapper over store.update(), same split as safety.ts's
// `appendSafetyEvent`/`store.SafetyEvent`.
// ---------------------------------------------------------------------------

/** Pure reducer: inserts `evt` into `events` at its correct CHRONOLOGICAL
 *  position (newest-first, sorted by `at` descending) — NOT blindly at the
 *  front. A relay's offline catch-up replay, a gift-wrap's randomized outer
 *  timestamp, or simple multi-circle interleave all mean events can arrive
 *  out of `at` order; a late-arriving OLD event must land in its actual
 *  chronological slot, not jump the queue ahead of everything already
 *  newer. Skipped entirely (dedupe) when its `id` is already present — a
 *  relay replay or this device's own wire echo must never double-log the
 *  same event. Stable for equal `at`: the new event is inserted AFTER every
 *  existing entry with the same `at` (found via the first STRICTLY older
 *  entry), so a same-timestamp arrival never reorders/displaces entries
 *  already on the list — no visible churn. Capped at `HARD_MAX_ACTIVITY` AFTER
 *  insertion, dropping the OLDEST (the tail, since the list is kept sorted
 *  newest-first) — an old event that sorts past the cap boundary is simply
 *  never admitted, rather than evicting something newer. Returns the SAME
 *  array reference on a dedupe no-op, so callers can tell "nothing changed"
 *  without a second scan (mirrors approvals.ts's `upsertFamilyPolicy`
 *  return-same-reference idiom). */
export function applyRecordActivity(events: ActivityEvent[], evt: ActivityEvent): ActivityEvent[] {
  if (events.some((e) => e.id === evt.id)) return events
  const olderIdx = events.findIndex((e) => e.at < evt.at)
  const at = olderIdx === -1 ? events.length : olderIdx
  return [...events.slice(0, at), evt, ...events.slice(at)].slice(0, HARD_MAX_ACTIVITY)
}

/** Appends `evt` to `Persisted.activity`, deduped by id, capped, persisted.
 *  Returns whether it was actually inserted (false for a dedupe) — kept for
 *  symmetry with safety.ts's `appendSafetyEvent` (e.g. a future notification
 *  gate could use it the way `shouldNotifyForSafetyEvent` does); no current
 *  caller needs the distinction.
 *
 *  Phase 5 Task 4 (brief §24.6): after `applyRecordActivity`'s own
 *  insert/dedupe/hard-ceiling pass, `pruneActivity` (below) applies this
 *  device's actual retention policy — the user-configured cap and, if
 *  enabled, `dropRoutine`'s 7-day age pruning — on every single append, not
 *  just when settings change. `inserted` is reported from the FIRST pass
 *  only: a genuine insert that's then immediately evicted again by a very
 *  small configured cap still counts as "inserted" (it did land, if only
 *  briefly) — same "report what applyRecordActivity did" contract as
 *  before this task. */
export function recordActivity(evt: ActivityEvent): boolean {
  let inserted = false
  store.update((p) => {
    const next = applyRecordActivity(p.activity, evt)
    if (next !== p.activity) inserted = true
    p.activity = pruneActivity(next, p.settings.activityRetention, Math.floor(Date.now() / 1000))
  })
  return inserted
}

// ---------------------------------------------------------------------------
// Retention (Phase 5 Task 4, brief §24.6) — device-local Activity history
// controls: a configurable cap, an optional 7-day age-prune of routine
// kinds, and a permanent "audit floor" a handful of safety/permission kinds
// never fall below except as an absolute last resort at the hard cap. This
// is view data only — it never touches wire state, matching this module's
// own "Activity is a local record of what already happened" scope (brief:
// "guardian AND child alike — it's device-local view data; wire state
// unaffected"). Language note (§31): rendered copy below says "routine
// history", never "surveillance"/"log".
// ---------------------------------------------------------------------------

/** Kinds `dropRoutine`/"Clear routine history" act on — everyday "where/who"
 *  noise, never anything safety- or permission-adjacent. Verified against
 *  this file's own `ActivityKind` union + real `recordActivity` call sites
 *  (grepped across app/src, plus every `summarize` case above): 'arrival'/
 *  'departure' (places.ts, once wired — Task 7; already full `ActivityKind`
 *  members per this file's own top doc comment), 'precision-raised'
 *  (beacons.ts), 'message' (messages.ts — STRUCTURED quick-chip sends only,
 *  never ordinary chat, see `summarize`'s own 'message' case doc comment).
 *  All four exactly as brief §24.6 names them. */
const ROUTINE_KINDS: ReadonlySet<string> = new Set(['arrival', 'departure', 'precision-raised', 'message'])

/** Kinds that are NEVER auto-pruned by age (`dropRoutine`) and are the LAST
 *  resort at the hard cap — §24.6's "some records permanently auditable"
 *  floor. Verified against real recorded kinds the same way as
 *  `ROUTINE_KINDS` above: 'sos' (safety.ts), 'emergency-access' (safety.ts/
 *  messages.ts), 'safe-area-escalation' (places.ts, once wired — Task 7),
 *  'policy-changed', 'approval-requested', 'approval-resolved' (all three
 *  approvals.ts) — all six exactly as brief §24.6 names them; none differ
 *  from the brief's spelling.
 *
 *  Phase 5 Task 5 (brief §13.4): 'leave-requested'/'leave-approved'/
 *  'leave-denied' join the floor for the same reason 'approval-requested'/
 *  'approval-resolved' are already here — they're the SAME permission
 *  decision, just under leave-area's own richer kind names (see
 *  `ActivityKind`'s own doc comment). 'leave-expired' is deliberately left
 *  OUT — it's an informational marker that a granted window elapsed while
 *  still outside, not itself a permission grant/refusal record.
 *
 *  Phase 6 final-review finding 8: 'window-missed' joins the floor too — it
 *  wasn't here before, which meant it was just an ordinary (non-audit,
 *  non-routine) kind, evicted under cap pressure BEFORE audit-kind events
 *  once every routine-kind event was already gone. `friction.ts`'s
 *  `isQuietDay` and `milestones.ts`'s `stepUpSuggestion` both scan
 *  `p.activity` for 'window-missed' entries over a rolling window (a day, or
 *  `QUIET_STREAK_DAYS`) to decide whether things have genuinely been quiet —
 *  an evicted 'window-missed' record is indistinguishable from one that
 *  never happened, so losing it under cap pressure silently FABRICATES a
 *  clean streak/quiet day that never actually was. */
export const AUDIT_KINDS: ReadonlySet<string> = new Set([
  'sos', 'emergency-access', 'safe-area-escalation',
  'policy-changed', 'approval-requested', 'approval-resolved',
  'leave-requested', 'leave-approved', 'leave-denied',
  // Phase 6 Task 2: same "guardian permission/settings change, permanently
  // auditable" floor as 'policy-changed' just above — an independence-level
  // apply changes grace/escalation/policy for a child, exactly the kind of
  // record §24.6 means by "some records permanently auditable".
  'independence-applied',
  // Phase 6 final-review finding 8 — see this constant's own doc comment.
  'window-missed',
])

/** The You-tab cap picker's three choices, and the default applied whenever
 *  `activityRetention.cap` is absent or outside this set (a corrupt/foreign
 *  persisted value degrades to the default rather than being trusted). */
export const ACTIVITY_RETENTION_CAP_OPTIONS = [100, 500, 1000] as const
export const DEFAULT_ACTIVITY_RETENTION_CAP = 500

const ROUTINE_MAX_AGE_SEC = 7 * 24 * 60 * 60 // 7 days, brief §24.6

/** Same shape as `store.Persisted['settings']['activityRetention']` —
 *  structural, not imported: store.ts owns the persisted type (this file's
 *  own module doc comment's ownership split), this file only needs the
 *  shape, same "inline structural type" idiom notify.ts's `isQuietNow` uses
 *  for `quietHours`. */
export type ActivityRetention = { cap?: number; dropRoutine?: boolean }

function resolveRetentionCap(retention: ActivityRetention | undefined): number {
  const cap = retention?.cap
  return cap !== undefined && (ACTIVITY_RETENTION_CAP_OPTIONS as readonly number[]).includes(cap)
    ? cap
    : DEFAULT_ACTIVITY_RETENTION_CAP
}

/** Pure prune reducer — applied on every `recordActivity` append (above),
 *  after `applyRecordActivity`'s own insert + hard-ceiling pass. Two
 *  independent passes, in order:
 *
 *  1. `dropRoutine` (optional): removes `ROUTINE_KINDS` events STRICTLY
 *     older than 7 days (`nowSecValue - e.at > ROUTINE_MAX_AGE_SEC`) — an
 *     event exactly AT the 7-day boundary survives; only strictly-older is
 *     dropped. `AUDIT_KINDS` (and every other non-routine kind) are never
 *     touched by this pass, no matter their age.
 *
 *  2. Cap eviction (always applied — this pass runs even when `retention`
 *     is `undefined`/`dropRoutine` is off — using `retention.cap` when it's
 *     one of `ACTIVITY_RETENTION_CAP_OPTIONS`, else
 *     `DEFAULT_ACTIVITY_RETENTION_CAP`): evicts oldest-first, but in
 *     CLASS-PRIORITY order — every routine-kind event first, then every
 *     non-audit/non-routine event, and `AUDIT_KINDS` LAST. An audit-kind
 *     event is only ever evicted once every other class is fully exhausted
 *     and the buffer (now audit-only) is STILL over cap — §24.6's
 *     "permanently auditable... cap eviction still applies at the hard cap"
 *     floor, verbatim.
 *
 *  Returns the SAME array reference when neither pass removes anything —
 *  mirrors `applyRecordActivity`'s own no-op-returns-same-reference idiom,
 *  so a caller can tell "nothing changed" without a second scan. */
export function pruneActivity(events: ActivityEvent[], retention: ActivityRetention | undefined, nowSecValue: number): ActivityEvent[] {
  let result = events
  if (retention?.dropRoutine) {
    const cutoff = nowSecValue - ROUTINE_MAX_AGE_SEC
    const aged = result.filter((e) => !(ROUTINE_KINDS.has(e.kind) && e.at < cutoff))
    if (aged.length !== result.length) result = aged
  }
  const cap = resolveRetentionCap(retention)
  if (result.length <= cap) return result
  return evictToCap(result, cap)
}

/** `events` (newest-first) trimmed down to `cap`, evicting oldest-first
 *  (from the tail) within each priority class in turn — routine, then
 *  non-audit/non-routine, then audit — moving to the next class only once
 *  the current one is fully exhausted. See `pruneActivity`'s own doc
 *  comment for the full reasoning; this is its eviction half. */
function evictToCap(events: ActivityEvent[], cap: number): ActivityEvent[] {
  const list = events.slice()
  const classes: Array<(kind: string) => boolean> = [
    (k) => ROUTINE_KINDS.has(k),
    (k) => !ROUTINE_KINDS.has(k) && !AUDIT_KINDS.has(k),
    (k) => AUDIT_KINDS.has(k),
  ]
  for (const inClass of classes) {
    if (list.length <= cap) break
    for (let i = list.length - 1; i >= 0 && list.length > cap; i--) {
      const e = list[i]
      if (e && inClass(e.kind)) list.splice(i, 1)
    }
  }
  return list
}

/** Removes every `ROUTINE_KINDS` event immediately, regardless of age — the
 *  You-tab "Clear routine history" button's pure reducer. `AUDIT_KINDS` (and
 *  every other non-routine kind) are untouched — same floor `pruneActivity`'s
 *  own `dropRoutine` pass respects, just applied on demand instead of by
 *  age. */
export function clearRoutineEvents(events: ActivityEvent[]): ActivityEvent[] {
  return events.filter((e) => !ROUTINE_KINDS.has(e.kind))
}

/** Sets this device's retention cap (impure — reads/writes
 *  `Persisted.settings`), same "set one field, ignore an invalid choice"
 *  idiom as beacons.ts's `setCircleBaselinePrecision`. A `cap` outside
 *  `ACTIVITY_RETENTION_CAP_OPTIONS` is silently ignored (the You-tab picker
 *  only ever offers the three valid choices; this guard is defensive, same
 *  as `pruneActivity`'s own fallback) rather than persisting a corrupt
 *  choice. */
export function setActivityRetentionCap(cap: number): void {
  if (!(ACTIVITY_RETENTION_CAP_OPTIONS as readonly number[]).includes(cap)) return
  store.update((p) => {
    p.settings = { ...p.settings, activityRetention: { ...p.settings.activityRetention, cap } }
  })
}

/** Sets this device's `dropRoutine` flag — applies immediately, same idiom
 *  as app.ts's own 'quiet-hours-toggle'/'battery-alerts-toggle' handlers. */
export function setActivityRetentionDropRoutine(dropRoutine: boolean): void {
  store.update((p) => {
    p.settings = { ...p.settings, activityRetention: { ...p.settings.activityRetention, dropRoutine } }
  })
}

/** "Clear routine history" — device-local, immediate, no wire signal (brief:
 *  "guardian AND child alike — it's device-local view data; wire state
 *  unaffected"). Audit kinds stay — see `clearRoutineEvents`. */
export function clearRoutineHistory(): void {
  store.update((p) => {
    p.activity = clearRoutineEvents(p.activity)
  })
}

// ---------------------------------------------------------------------------
// Actor name resolution — render-time only (see module doc comment).
// ---------------------------------------------------------------------------

/** `pk`'s display name: `circleId`'s own member list first (the common
 *  case), then every OTHER circle this device belongs to (an actor can
 *  legitimately be outside the event's own circle — e.g. none in v1, but
 *  cheap insurance against a future cross-circle kind), finally a shortened
 *  pubkey. Never throws, never returns empty.
 *
 *  Signet identity plan, Task 11: the local rolodex fallback (contacts.ts)
 *  is gone — contacts come from My Signet, not tracked here yet (plan 2). */
function resolveName(p: store.Persisted, pk: string | undefined, circleId: string | undefined): string {
  if (!pk) return 'Someone'
  const own = circleId ? p.circles.find((c) => c.id === circleId) : undefined
  const inOwnCircle = own?.members.find((m) => m.pk === pk)?.name
  if (inOwnCircle) return inOwnCircle
  for (const c of p.circles) {
    const found = c.members.find((m) => m.pk === pk)?.name
    if (found) return found
  }
  return shortPk(pk)
}

function shortPk(pk: string): string {
  return `${pk.slice(0, 8)}…`
}

// ---------------------------------------------------------------------------
// Summaries — neutral language (global-constraints.md §31): never
// "tracking"/"violation"/"breach" in copy, even though the underlying wire
// type stays `breach` (see safe-area-escalation below).
// ---------------------------------------------------------------------------

// Review-minor (language sweep, §31): 'late' is a banned word in rendered
// copy as of this phase's expanded §31 list — same "hasn't arrived yet"
// phrasing places.ts's own arrival-window copy already uses, so the two
// features read consistently. The underlying `AgreementLifecycleStatus`
// wire value stays `'late'` (store.ts) — only this render-time label changes.
const STATUS_LABELS: Record<string, string> = {
  'en-route': 'is on the way', arrived: 'arrived', late: "hasn't arrived yet",
}

/** Human-readable summary for `evt` — pure given `p` (actor names resolve
 *  against its current circle/rolodex state), so directly unit-testable
 *  without a live store. Any kind outside `ActivityKind` (a future build's
 *  addition, read back from a persisted blob) falls through to a generic
 *  line instead of throwing. */
export function summarize(p: store.Persisted, evt: ActivityEvent): string {
  const who = resolveName(p, evt.actorPk, evt.circleId)
  const place = evt.params.place || 'a place'
  switch (evt.kind as ActivityKind) {
    case 'arrival': return `${who} arrived at ${place}`
    case 'departure': return `${who} left ${place}`
    case 'safe-area-warning': return `${who} may be leaving ${place}`
    case 'safe-area-escalation': return `${who} left ${place}`
    // Phase 3 Task 5 (arrival windows) — 'window-reminder'/'window-met' are
    // ONLY ever self-recorded (the child's own device, evaluating its own
    // windows — see places.ts's `evaluateArrivalWindows`), so both simply
    // resolve `who` like any other self-authored entry ('window-met' reads
    // exactly like 'arrival' for that reason). 'window-missed', in
    // contrast, is recorded on BOTH sides of the same wire signal — the
    // child's own device (the 'fire' branch) AND every receiving guardian's
    // device (`recordIncomingWindowEvent`) — so its copy must distinguish
    // "this is MY OWN not-yet-arrived event" (child-transparency: what the
    // circle was just told) from "someone ELSE hasn't arrived yet".
    case 'window-reminder': return `Expected at ${place} by ${evt.params.time || 'the expected time'}`
    case 'window-missed': {
      const time = evt.params.time || 'the expected time'
      return currentSession()?.identityPk === evt.actorPk ? `Circle told: not yet at ${place}` : `${who} hasn't arrived at ${place} yet (expected by ${time})`
    }
    case 'window-met': return `${who} arrived at ${place}`
    case 'checkin': return `${who} checked in`
    case 'pickup-requested': return `Pickup requested for ${resolveName(p, evt.params.targetPk, evt.circleId)}`
    // Brief §11.4: "show how long precise access lasted" — the child's
    // automatic answer to a findreq is a single plain beacon, not a
    // sustained elevation window (safety.ts's `buildPickupAnswerWrap`/
    // `autoAnswerPickup` send exactly ONE precision-9 fix and stop; there is
    // no ongoing "precise for N minutes" period to report), so this states
    // that plainly rather than fabricating a duration.
    case 'pickup-accepted': return `${who} shared their location — shared precisely once`
    // Phase 4 Task 6 (brief §17.2-17.3, §30): every pickup lifecycle phase
    // but 'requested' (which stays under the entry just above — see
    // pickup.ts's own module doc comment for why). `params.phase` is one of
    // pickup.ts's own `PickupPhase` values; `default` below tolerates a
    // future phase this build doesn't know about (forward compat, same
    // "unknown-kind tolerance" discipline as the rest of this switch).
    // Neutral §31 language throughout — "declined," never "refused."
    case 'pickup-status': {
      const child = resolveName(p, evt.params.targetPk, evt.circleId)
      switch (evt.params.phase) {
        case 'offered': return `${who} offered to pick up ${child}`
        case 'seen': return `${child} saw the pickup update`
        case 'accepted': return `${who} accepted the pickup`
        case 'on-way': return evt.params.etaMin ? `${who} is on the way — about ${evt.params.etaMin} min` : `${who} is on the way`
        case 'collected': return `${who} picked up ${child}`
        case 'declined': return `${who} declined the pickup`
        case 'suggested': return evt.params.suggestName ? `${who} suggested another spot: ${evt.params.suggestName}` : `${who} suggested another spot`
        default: return `${who} updated the pickup for ${child}`
      }
    }
    case 'sos': return `${who} needs help`
    case 'agreement-created': return `${who} proposed a return time${evt.params.place ? ` — ${evt.params.place}` : ''}`
    case 'agreement-acked': return `${who} acknowledged the agreement`
    case 'agreement-status': return `${who} ${STATUS_LABELS[evt.params.status ?? ''] ?? 'updated the agreement'}`
    case 'agreement-extended': return agreementExtendedSummary(who, evt.params)
    // Phase 4 Task 8 (brief §15): travel-aware leave reminders — child-side-
    // only local notifications, so `who` is always the viewing device's own
    // identity here (never a peer). `params.stage` is one of
    // agreements.ts's own `LeaveStage['stage']` values.
    case 'leave-reminder': return leaveReminderSummary(place, evt.params.stage)
    case 'policy-changed': return `${who} updated family policy`
    // [copy] Phase 6 Task 2 (design spec §2) — independence language only
    // (§31: never "earn"/"reward"/"points" — this is a settings change, not
    // an achievement).
    case 'independence-applied': return `${who} applied the ${evt.params.label || 'independence'} level`
    case 'approval-requested': return `${who} requested approval${evt.params.action ? ` to ${describeAction(evt.params.action)}` : ''}`
    case 'approval-resolved': return `${who} ${evt.params.ok === 'true' ? 'approved' : 'denied'} a request`
    case 'member-joined': return `${who} joined the circle`
    // `params.reason` (Task 8 fix round 1): trust-watch.ts's own automatic
    // removal/leave/timeout notices carry the full, already-worded copy
    // (it already names who and why — "Removed <name>: no longer in your
    // contacts", say), so it's rendered verbatim rather than composed with
    // `who` the way the plain (manually-triggered) case below is.
    case 'member-removed': return evt.params.reason || `${who} was removed from the circle`
    case 'member-left': return evt.params.reason || (evt.params.name ? `${who} left ${evt.params.name}` : `${who} left the circle`)
    case 'precision-raised': return `${who}'s location sharing increased to ${evt.params.term || 'precise'}`
    // Brief §11.4: "record who requested it", "record the stated reason
    // where appropriate" — `params.targetPk` (present on both the
    // requester's send-side entry and every receiving device's entry, see
    // safety.ts/messages.ts's `recordActivity` call sites) names WHOSE
    // location was asked for, when known; `params.reason` is always present
    // by the time this is called (either the requester's declared reason,
    // or the receive-side's 'not stated' fallback — see safety.ts's
    // `correlateIncomingFindreq`), but the `?` guards a hypothetical future
    // caller that omits it.
    case 'emergency-access': {
      const targetName = evt.params.targetPk ? resolveName(p, evt.params.targetPk, evt.circleId) : undefined
      const subject = targetName ? `${targetName}'s precise location` : 'precise location'
      return `${who} requested ${subject}${evt.params.reason ? ` — reason: ${evt.params.reason}` : ''}`
    }
    // Messaging (Task 5, brief §23.4) — only STRUCTURED sends ever reach
    // here (messages.ts never calls recordActivity for ordinary chat);
    // `params.label` is the exact quick-chip phrase the sender tapped (or
    // received), e.g. "Alex: Come home now" — see messages.ts's
    // `CHIP_LABELS`.
    case 'message': return `${who}: ${evt.params.label || 'sent a message'}`
    // Phase 3 Task 2's own send site (battery.ts's `handleIncomingSignal`)
    // has recorded this kind since that task landed; this case was a queued
    // follow-up (Task 2's review) — without it every entry fell through to
    // the generic default line below.
    case 'battery-low': return `${who}'s phone battery was low (${evt.params.pct}%)`
    // Phase 4 Task 5 (brief §6.6-6.7): meeting points — one kind covers both
    // create and delete (meet.ts's own send sites, `params.action`
    // discriminates), same "single kind, a params field distinguishes the
    // sub-case" idiom `agreement-extended`'s `params.stage` already uses one
    // level up. `params.name` (task contract, verbatim) — NOT `params.place`
    // (the shared `place` local above), since a meeting point isn't a Place.
    case 'meet-point': {
      const name = evt.params.name || 'a meeting point'
      return evt.params.action === 'deleted' ? `${who} removed the meeting point — ${name}` : `${who} suggested meeting at ${name}`
    }
    // Phase 7 Task 4 (design spec §4): flock-interoperable dropped pins.
    // `params.label` is the kind's rendered glyph+label (pins.ts's own
    // `pinLabel`, precomputed at the recording site — this module never
    // imports pins.ts's `PIN_KINDS` table, same "params carries whatever a
    // summary needs, pre-rendered" convention every other kind here follows).
    case 'pin-dropped': return `${who} dropped a pin — ${evt.params.label || 'a pin'}`
    case 'pin-removed': return `${who} removed a pin — ${evt.params.label || 'a pin'}`
    // Phase 5 Task 3 (brief §32.2): journey mode. `place` here is the
    // journey's destination label (own local, not the shared `place`
    // computed above — that one falls back to 'a place', this one to
    // 'their destination', a better fit for "heading to ___"). Neutral §31
    // language throughout: "timed out"/"cancelled", never "failed"/
    // "abandoned"/"missed".
    case 'journey-start': {
      const dest = evt.params.place || 'their destination'
      return evt.params.expectedBy ? `${who} is heading to ${dest} (expected by ${evt.params.expectedBy})` : `${who} is heading to ${dest}`
    }
    case 'journey-done': {
      const dest = evt.params.place || 'their destination'
      if (evt.params.expired === '1') return `${who}'s journey to ${dest} timed out`
      if (evt.params.cancelled === '1') return `${who} cancelled their journey to ${dest}`
      return `${who}'s journey to ${dest} is complete`
    }
    // Phase 5 Task 5 (brief §13.4): boundary-exit requests. `place` (the
    // shared local above) already falls back to 'a place'; `destination`
    // is the child's own free-text answer to "where are you going" —
    // esc()'d at every render site per global-constraints.md, same as
    // every other wire-carried free text in this app.
    case 'leave-requested': {
      const dest = evt.params.destination
      return dest ? `${who} asked to go out — ${place}, heading to ${dest}` : `${who} asked to leave ${place}`
    }
    // `who` here resolves `actorPk` — the RESOLVER (guardian), same "who did
    // the approving/denying" framing as the generic 'approval-resolved'
    // case above; `params.from` (the requester) is a separate field so both
    // names can be named, unlike 'approval-resolved' which never needed the
    // requester's name at all.
    case 'leave-approved': return `${who} allowed ${resolveName(p, evt.params.from, evt.circleId)} to leave ${place}`
    case 'leave-denied': return `${who} did not allow ${resolveName(p, evt.params.from, evt.circleId)} to leave ${place} right now`
    // Self-recorded only (places.ts's own tick(), same idiom as
    // 'safe-area-warning') — `who` is always the viewing device's own
    // identity here, never a peer.
    case 'leave-expired': return `${who}'s time away from ${place} ran out — still away`
    default: return `${who} — activity update`
  }
}

function agreementExtendedSummary(who: string, params: Record<string, string>): string {
  const extra = params.extraMin ? `${params.extraMin} min` : 'more time'
  switch (params.stage) {
    case 'approved': return `${who} approved ${extra} extra`
    case 'denied': return `${who} denied a request for ${extra} extra`
    default: return `${who} asked for ${extra} extra`
  }
}

// §31 language sweep: 'behind', never 'late' — mirrors
// agreements.ts's `leaveBehindCopy`'s own phrasing.
function leaveReminderSummary(place: string, stage: string | undefined): string {
  switch (stage) {
    case 'soon': return `Leave reminder — time to head to ${place} soon`
    case 'now': return `Leave reminder — leave now for ${place}`
    case 'behind': return `Leave reminder — running behind for ${place}`
    default: return `Leave reminder for ${place}`
  }
}

function describeAction(action: string): string {
  switch (action) {
    case 'create-circle': return 'create a new circle'
    case 'add-member': return 'add a member'
    case 'join-circle': return 'join a circle'
    case 'add-contact': return 'add a contact'
    default: return action
  }
}

// ---------------------------------------------------------------------------
// Filters (brief §24.4 subset: All / Safety / Requests / People / a circle).
// ---------------------------------------------------------------------------

export type ActivityFilter =
  | { kind: 'all' }
  | { kind: 'safety' }
  | { kind: 'requests' }
  | { kind: 'people' }
  | { kind: 'circle'; circleId: string }

const SAFETY_KINDS = new Set<string>([
  'arrival', 'departure', 'safe-area-warning', 'safe-area-escalation',
  // Arrival windows (Phase 3 Task 5) slot alongside arrival/departure/safe-
  // area-* above — same "where a member is relative to a place" family, just
  // a scheduled-expectation variant rather than a fence-boundary one.
  'window-reminder', 'window-missed', 'window-met',
  'checkin', 'pickup-requested', 'pickup-accepted', 'pickup-status', 'sos', 'precision-raised', 'emergency-access',
  // Battery (Phase 3 Task 2, review-minor #7): a low-battery reading is
  // safety-adjacent (a member who can't be reached is a safety concern), the
  // same reasoning that already puts precision-raised/emergency-access here
  // rather than under People/Requests.
  'battery-low',
  // Journey mode (Phase 5 Task 3, brief §32.2) — same "where a member is
  // relative to a place" family as arrival/departure/window-*.
  'journey-start', 'journey-done',
  // Phase 5 Task 5 (brief §13.4): 'leave-expired' is about where the child
  // now is relative to their safe place (the approved window ran out while
  // they were still away) — same family as safe-area-warning/escalation
  // just above, not a request/response.
  'leave-expired',
])
const REQUEST_KINDS = new Set<string>([
  'agreement-created', 'agreement-acked', 'agreement-status', 'agreement-extended', 'leave-reminder',
  'policy-changed', 'approval-requested', 'approval-resolved',
  'message',
  // Phase 5 Task 5: boundary-exit ask/approve/deny — same "administrative
  // approval" family as approval-requested/approval-resolved just above.
  'leave-requested', 'leave-approved', 'leave-denied',
  // Phase 6 Task 2: same "administrative, guardian-authored" family as
  // 'policy-changed' just above.
  'independence-applied',
])
const PEOPLE_KINDS = new Set<string>(['member-joined', 'member-removed', 'member-left'])

/** Whether `evt` matches `filter`. An unrecognised kind matches only `'all'`
 *  and its own circle filter (never safety/requests/people — task contract's
 *  "unknown-kind tolerance": it still SHOWS UP somewhere, never silently
 *  vanishes). */
export function matchesFilter(evt: ActivityEvent, filter: ActivityFilter): boolean {
  switch (filter.kind) {
    case 'all': return true
    case 'safety': return SAFETY_KINDS.has(evt.kind)
    case 'requests': return REQUEST_KINDS.has(evt.kind)
    case 'people': return PEOPLE_KINDS.has(evt.kind)
    case 'circle': return evt.circleId === filter.circleId
  }
}

// ---------------------------------------------------------------------------
// Deep links (brief §24.5): open map centred on a person, open the circle,
// or scroll to the approvals card. Pure — app.ts (the only module that owns
// tab state / the live MapView) translates the result into an actual
// navigation via `setNavigator` below.
// ---------------------------------------------------------------------------

export type ActivityDeepLink =
  | { kind: 'map'; circleId?: string; actorPk?: string; geohash?: string }
  | { kind: 'circle'; circleId: string }
  | { kind: 'approvals' }
  | { kind: 'none' }

const MAP_LINK_KINDS = new Set<string>([
  'arrival', 'departure', 'safe-area-warning', 'safe-area-escalation',
  // Same "arrival/departure sibling" reasoning as SAFETY_KINDS above — an
  // arrival-window event is about where `actorPk` is (or isn't) relative to
  // a place, exactly like arrival/departure/safe-area-*, so it deep-links
  // the same way (centred on the actor, even without a geohash — same as
  // arrival/departure/checkin already do).
  'window-reminder', 'window-missed', 'window-met',
  'checkin', 'pickup-accepted', 'sos', 'precision-raised', 'emergency-access',
  // battery-low (review-minor #7): centres the map on the low-battery
  // member, same "no geohash needed, actorPk is enough" idiom as
  // precision-raised just above.
  'battery-low',
  // Journey mode (Phase 5 Task 3): same "no geohash needed, actorPk is
  // enough" idiom — journeys carry a dest label, not a geohash param, on
  // their Activity entries.
  'journey-start', 'journey-done',
  // Phase 5 Task 5: 'leave-expired' is self-recorded (places.ts's tick()) —
  // same "no geohash, actorPk is enough" idiom, centres on the child.
  'leave-expired',
])
const CIRCLE_LINK_KINDS = new Set<string>([
  'agreement-created', 'agreement-acked', 'agreement-status', 'agreement-extended', 'leave-reminder',
  'member-joined', 'member-removed', 'member-left',
  // 'message' deep-links to the circle rather than straight into the chat
  // thread itself — Activity's deep-link vocabulary (`ActivityDeepLink`) has
  // no "open this chat" variant yet; opening the circle page (from which
  // both the circle chat and every member's DM are one tap away) is close
  // enough for this task's scope. A dedicated chat deep link is a
  // reasonable follow-up, not built here.
  'message',
])
// `policy-changed` deliberately isn't here — family policy renders on the
// You tab (approvals.ts's `policyView`), not the Circles tab's approvals
// card, so it falls through to the generic circleId link below instead
// (switches to Circles, same as an agreement/membership change) rather than
// pointing at a card it wouldn't actually be on. `independence-applied`
// (Phase 6 Task 2) is the same story — milestones.ts's own card also
// renders on the You tab, not Circles.
// Phase 5 Task 5: leave-area's own richer kinds deep-link the same place a
// generic approval-requested/approval-resolved entry would — the request
// (while still pending) is genuinely on the approvals card; once resolved,
// same "still points there, even though it's no longer shown" precedent
// `approval-resolved` above already accepts (see `requestsView`'s own doc
// comment for why a resolved-and-rerun request drops off that list).
const APPROVAL_LINK_KINDS = new Set<string>(['approval-requested', 'approval-resolved', 'leave-requested', 'leave-approved', 'leave-denied'])

/** Where tapping `evt` should take you. `pickup-requested` and
 *  `emergency-access` (when it carries a `targetPk` — see the `summarize`
 *  case above) are a special case of the map group: the person worth
 *  centring on is the TARGET (`params.targetPk`), not `actorPk` (whoever
 *  asked) — an `emergency-access` entry from a build before this field
 *  existed simply falls through to the generic actorPk-centred branch below,
 *  same forward/backward-compat tolerance as an unrecognised kind. Anything
 *  without a location or circle to anchor to (an unrecognised kind with no
 *  `circleId`) is `'none'` — rendered as plain, non-interactive text. */
export function deepLinkFor(evt: ActivityEvent): ActivityDeepLink {
  // 'pickup-status' (Phase 4 Task 6) joins 'pickup-requested'/'emergency-
  // access' here for the same reason: the person worth centring the map on
  // is the CHILD (`params.targetPk`), not whoever performed this particular
  // phase transition (`actorPk` — a guardian for most phases, the child for
  // 'seen'/'suggested').
  if (evt.kind === 'pickup-requested' || evt.kind === 'pickup-status' || (evt.kind === 'emergency-access' && evt.params.targetPk)) {
    return { kind: 'map', circleId: evt.circleId, actorPk: evt.params.targetPk, geohash: evt.params.geohash }
  }
  if (MAP_LINK_KINDS.has(evt.kind)) {
    return { kind: 'map', circleId: evt.circleId, actorPk: evt.actorPk, geohash: evt.params.geohash }
  }
  if (APPROVAL_LINK_KINDS.has(evt.kind)) return { kind: 'approvals' }
  if (CIRCLE_LINK_KINDS.has(evt.kind) && evt.circleId) return { kind: 'circle', circleId: evt.circleId }
  return evt.circleId ? { kind: 'circle', circleId: evt.circleId } : { kind: 'none' }
}

// ---------------------------------------------------------------------------
// Relative time — same "just now / Nm ago / Nh ago / Nd ago" idiom as
// safety.ts's/app.ts's own local `ageLabel` helpers, kept here so this
// module's list rendering doesn't depend on either.
// ---------------------------------------------------------------------------

export function relativeTime(at: number, now: number): string {
  const seconds = Math.max(0, now - at)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

// ---------------------------------------------------------------------------
// Navigation — registration, not import (same idiom as beacons.ts's
// `setActiveAgreementProvider`/approvals.ts's `registerApprovalAction`):
// this module has no reference to app.ts's tab state or live MapView, so
// app.ts registers a callback instead of activity.ts importing app.ts
// (which would invert the app's whole dependency direction — app.ts imports
// every domain module, never the reverse).
// ---------------------------------------------------------------------------

export type ActivityNavigator = (link: ActivityDeepLink) => void
let navigator: ActivityNavigator | null = null

/** Registers app.ts's "go do this deep link" callback. Last registration
 *  wins (plain assignment, always idempotent) — safe to call on every
 *  render, same discipline as the registration functions it mirrors. */
export function setNavigator(fn: ActivityNavigator | null): void {
  navigator = fn
}

// ---------------------------------------------------------------------------
// View — the Activity tab: filter chips, list, empty state per filter. UI
// wiring only past this point — no unit tests (build-gated), same convention
// as circles.ts/safety.ts/agreements.ts/approvals.ts.
// ---------------------------------------------------------------------------

let filter: ActivityFilter = { kind: 'all' }

export function view(p: store.Persisted): string {
  const now = Math.floor(Date.now() / 1000)
  const items = p.activity.filter((e) => matchesFilter(e, filter))
  return `
    <h1>Activity</h1>
    ${chipsView(p)}
    ${items.length ? listView(p, items, now) : emptyStateView(p)}
  `
}

function chip(label: string, active: boolean, filterAttr: string, circleId?: string): string {
  const circleAttr = circleId ? ` data-circle="${esc(circleId)}"` : ''
  return `<button type="button" class="activity-chip" data-action="activity-filter" data-filter="${filterAttr}"${circleAttr} aria-current="${active}">${esc(label)}</button>`
}

function chipsView(p: store.Persisted): string {
  const chips = [
    chip('All', filter.kind === 'all', 'all'),
    chip('Safety', filter.kind === 'safety', 'safety'),
    chip('Requests', filter.kind === 'requests', 'requests'),
    chip('People', filter.kind === 'people', 'people'),
    ...p.circles.map((c) => chip(c.name, filter.kind === 'circle' && filter.circleId === c.id, 'circle', c.id)),
  ]
  return `<div class="activity-chips">${chips.join('')}</div>`
}

function listView(p: store.Persisted, items: ActivityEvent[], now: number): string {
  return `<ul class="contact-list">${items.map((e) => itemView(p, e, now)).join('')}</ul>`
}

function itemView(p: store.Persisted, evt: ActivityEvent, now: number): string {
  const summary = esc(summarize(p, evt))
  const circleName = evt.circleId ? p.circles.find((c) => c.id === evt.circleId)?.name : undefined
  const meta = esc(`${circleName ? `${circleName} · ` : ''}${relativeTime(evt.at, now)}`)
  if (deepLinkFor(evt).kind === 'none') {
    return `<li class="contact-item"><span>${summary}</span><span class="badge">${meta}</span></li>`
  }
  return `
    <li class="contact-item">
      <button type="button" class="activity-item" data-action="activity-open" data-id="${esc(evt.id)}">
        <span>${summary}</span><span class="badge">${meta}</span>
      </button>
    </li>`
}

function emptyStateView(p: store.Persisted): string {
  switch (filter.kind) {
    case 'safety': return `<p class="muted">No safety activity yet.</p>`
    case 'requests': return `<p class="muted">No agreement or approval activity yet.</p>`
    case 'people': return `<p class="muted">No membership changes yet.</p>`
    case 'circle': {
      const circleId = filter.circleId // hoisted out of the closure below — narrowing doesn't survive into a nested arrow function
      const name = p.circles.find((c) => c.id === circleId)?.name ?? 'this circle'
      return `<p class="muted">No activity in ${esc(name)} yet.</p>`
    }
    default: return `<p class="muted">Nothing yet — you'll see updates here as they happen.</p>`
  }
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

// ---------------------------------------------------------------------------
// Retention view — the You-tab "Routine history" section (Phase 5 Task 4,
// brief §24.6): cap picker, `dropRoutine` toggle, "Clear routine history"
// with a two-tap confirm gate. Rendered by app.ts's `youView` (own reference
// to `store.Persisted`, same "owning module exports the section, app.ts
// calls it" idiom as meet.ts's `settingsView`), not the Activity tab itself
// — this is a device setting, not part of the timeline it governs. UI wiring
// only, no unit tests (build-gated), same convention as the rest of this
// module's own view section above.
// ---------------------------------------------------------------------------

const ROUTINE_HISTORY_LABEL = 'Routine history'
const DROP_ROUTINE_LABEL = 'Drop routine history after 7 days'

/** Two-tap "Clear routine history" confirm gate — module-level ephemeral UI
 *  state (not persisted), same "local mutable view state this module
 *  already owns" idiom as `filter` above. No confirm DIALOG idiom exists
 *  anywhere else in this codebase (verified) to mirror, so this is a
 *  same-button-relabels-itself two-tap: first tap arms it (button becomes
 *  "Tap again to confirm" + a Cancel button appears), a second tap on the
 *  SAME action actually clears.
 *
 *  Review fix: the gate must hold PER VISIT, not survive navigating away and
 *  back — a user who armed it, switched tabs, and returned later must NOT
 *  find a single tap away from a destructive action they may not even
 *  remember starting. Cancel, the confirming tap itself, AND
 *  `resetClearRoutineConfirm` below (called from app.ts's TOP-LEVEL
 *  `handleAction` — the single entry point every click in the app funnels
 *  through — for any action OTHER than this gate's own three) all disarm
 *  it. See `nextClearRoutineConfirmState`'s own doc comment for the full
 *  state machine. */
let clearRoutineConfirming = false

export type ClearRoutineConfirmTransition = 'arm' | 'disarm'

/** Pure transition for the confirm gate above — extracted from
 *  `handleAction`'s DOM-touching cases (and `resetClearRoutineConfirm`
 *  below) so the state machine itself is directly unit-testable without a
 *  DOM node. This is a flat arm/disarm gate, not real hysteresis — every
 *  transition's target is fixed regardless of the CURRENT state: 'arm' is
 *  the first "Clear routine history" tap; 'disarm' covers every other case
 *  (the confirming second tap, Cancel, and any unrelated action elsewhere in
 *  the app via `resetClearRoutineConfirm`). */
export function nextClearRoutineConfirmState(transition: ClearRoutineConfirmTransition): boolean {
  return transition === 'arm'
}

/** Disarms the confirm gate — see `clearRoutineConfirming`'s own doc
 *  comment for why and who calls this. A no-op (still a plain reassignment)
 *  when already disarmed. Deliberately does NOT call `store.notify()`:
 *  app.ts's top-level `handleAction` calls this before dispatching whatever
 *  the ACTUAL action is, and that action's own handling re-renders as
 *  normal — an extra notify here would be redundant, and for a genuine no-op
 *  action (unrecognised, nothing renders) the now-false value is simply
 *  picked up whenever the next real render happens. */
export function resetClearRoutineConfirm(): void {
  clearRoutineConfirming = nextClearRoutineConfirmState('disarm')
}

export function retentionSectionView(p: store.Persisted): string {
  const retention = p.settings.activityRetention
  const cap = resolveRetentionCap(retention)
  const dropRoutineOn = retention?.dropRoutine === true
  const capChips = ACTIVITY_RETENTION_CAP_OPTIONS.map((c) => `
    <button type="button" class="precision-chip" data-action="activity-retention-cap-set" data-cap="${c}" aria-current="${cap === c}">
      ${c}
    </button>`).join('')
  const clearButtons = clearRoutineConfirming
    ? `<button type="button" data-action="activity-clear-routine-confirm">Tap again to confirm</button>
       <button type="button" data-action="activity-clear-routine-cancel">Cancel</button>`
    : `<button type="button" data-action="activity-clear-routine">Clear routine history</button>`
  return `
    <section class="contact-group">
      <h2>${ROUTINE_HISTORY_LABEL}</h2>
      <p class="muted small">
        How many events this device keeps, and whether everyday routine
        activity — arrivals, departures, precision changes, and messages —
        is dropped automatically after 7 days. Safety and approval records
        are always kept.
      </p>
      <div class="precision-chips">${capChips}</div>
      <button type="button" class="precision-chip" data-action="activity-retention-drop-routine-toggle" aria-current="${dropRoutineOn}">
        ${DROP_ROUTINE_LABEL}
      </button>
      <div class="sheet-actions">${clearButtons}</div>
    </section>`
}

// ---------------------------------------------------------------------------
// Action dispatch — app.ts delegates every `activity-*` data-action here.
// ---------------------------------------------------------------------------

export function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'activity-filter': {
      const kind = node.dataset.filter
      const circleId = node.dataset.circle
      if (kind === 'circle' && circleId) filter = { kind: 'circle', circleId }
      else if (kind === 'all' || kind === 'safety' || kind === 'requests' || kind === 'people') filter = { kind }
      store.notify()
      break
    }
    case 'activity-open': {
      const id = node.dataset.id
      const evt = store.load().activity.find((e) => e.id === id)
      if (evt) navigator?.(deepLinkFor(evt))
      break
    }
    // Phase 5 Task 4 (brief §24.6) — the You-tab retention section's four
    // actions, all device-local/immediate (no confirm gate except the
    // clear-routine pair below).
    case 'activity-retention-cap-set': {
      const cap = Number(node.dataset.cap)
      if (Number.isFinite(cap)) setActivityRetentionCap(cap)
      break
    }
    case 'activity-retention-drop-routine-toggle': {
      setActivityRetentionDropRoutine(!(store.load().settings.activityRetention?.dropRoutine === true))
      break
    }
    case 'activity-clear-routine': {
      clearRoutineConfirming = nextClearRoutineConfirmState('arm')
      store.notify()
      break
    }
    case 'activity-clear-routine-confirm': {
      clearRoutineConfirming = nextClearRoutineConfirmState('disarm')
      clearRoutineHistory()
      break
    }
    case 'activity-clear-routine-cancel': {
      clearRoutineConfirming = nextClearRoutineConfirmState('disarm')
      store.notify()
      break
    }
    default:
      break
  }
}
