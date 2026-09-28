// Local persistence: a single JSON blob in localStorage under `kindependence.v1`.
// This module only owns the envelope, the read/write, and the
// subscribe/notify plumbing. Render-on-state, same idiom as flock's
// app/src/store.ts. `circles` is typed properly: covey-kit's `Circle[]` —
// circle lifecycle, invites, and config sync live in circles.ts (Task 13).
//
// Signet identity plan, Task 11 fix round 1 (finding 7): the pre-Signet
// `contacts` (`unknown[]`, a hand-added local rolodex) and `rail`
// (`RailState` — the companion-rail consumer's device keys/pairing/synced
// contacts, rail.ts/rail-live.ts) fields are gone — contacts now come from
// My Signet (a later plan), and the rail pairing flow they backed was
// replaced by this task's own sign-in screens (signin.ts). rail.ts/
// rail-live.ts themselves are deleted with this change (their only
// consumer was this field).
//
// Signet identity plan (Task 5): there is no local family/child identity or
// recovery mnemonic in this blob any more — the identity key lives in My
// Signet, never on this device (see session.ts's `SessionInfo`, `session`
// below). `load()` clears the WHOLE blob outright if it finds the old
// pre-Task-5 shape (an `identity` object carrying its own `skHex`) rather
// than partially coercing it — that old format held a raw secret key in the
// clear, which this format must never do again, so a stale copy is worth
// losing over silently working with a shape this module no longer
// understands. This device's own "phone key" (the local transport key a
// device statement authorises) never lives here either — see
// secure-key.ts's `SecretStore`.

import type { MeetPoint } from './meet.js'
import type { PickupRecord } from './pickup.js'
import type { Pin } from './pins.js'
import type { Circle } from '@forgesworn/covey-kit'
import type { Agreement, ApprovalReq, FamilyPolicy, PolicyVerdict } from './brood/index.js'
import type { SignedEvent } from '@forgesworn/roost-kit'
import type { TravelMode } from './travel.js'
import type { SessionInfo } from './session.js'
import type { StructuralAction } from './structural.js'
import type { ContactsSnapshot, Contact, Tier } from './contacts.js'
import type { TrustPrompt } from './trust-watch.js'

const KEY = 'kindependence.v1'

/** A received (or self-sent, for the sender's own echo) safety signal —
 *  help/SOS, check-in, or a pickup request/answer — kept as a small local
 *  log so the Circles tab's alert banners survive a reload instead of only
 *  existing as a toast the moment they arrive. Owned by safety.ts; typed
 *  here per this file's own convention (`StoredCircle`/`Place` are the
 *  same split).
 *  Capped and deduped by `id` — see safety.ts's `appendSafetyEvent`. */
export interface SafetyEvent {
  /** The wire rumor's own event id for anything received; a synthesised
   *  `local-<kind>-<at>-<circleId>` for the sender's own self-echo. */
  id: string
  circleId: string
  /** 64-char hex pubkey of whoever the event is about (sender for help/
   *  check-in; the pickup-req's target child for a pickup entry). */
  from: string
  kind: 'help' | 'checkin' | 'pickup'
  at: number
  /** Present only when the event carried a location (check-in's optional
   *  share, or a pickup answer) — absent for a location-less help alert or
   *  a bare pickup request. */
  geohash?: string
  precision?: number
}

/** Local lifecycle status of a tracked `Agreement` — a superset of brood-
 *  kit's own `AgreementStatusKind` (`'en-route' | 'arrived' | 'late'`, the
 *  values that ride the wire in an `agreement-status` signal): `'proposed'`
 *  and `'acked'` are the two states BEFORE any status signal has been sent
 *  at all, reached instead via the `agreement`/`agreement-ack` signals — see
 *  BROOD.md §4's lifecycle diagram. Owned by agreements.ts. */
export type AgreementLifecycleStatus = 'proposed' | 'acked' | 'en-route' | 'arrived' | 'late'

/** One message in a person-to-person DM thread or a circle chat thread —
 *  owned by messages.ts (see its own module doc comment), typed here per
 *  this file's own convention (`SafetyEvent`/`AgreementRecord` above are the
 *  same split). `structured` is set only for an ACTIONABLE structured send
 *  (brief §23.4: "important actionable messages also appear in Activity;
 *  ordinary conversational messages need not") — its value names which
 *  quick-chip built it (messages.ts's `ChipKind`), used both to render a
 *  highlighted card and to label the matching Activity entry. Absent for a
 *  free-form message. */
export interface ChatMessage {
  /** The wire rumor's own event id for anything received; a synthesised id
   *  for a self-originated send — see messages.ts's `dmMessageId`. Same
   *  dedupe-by-id convention as `SafetyEvent.id`/`ActivityEvent.id`. */
  id: string
  from: string
  text: string
  at: number
  structured?: string
}

/** A guardian-defined named safe area for a circle (Task 7, brief §13,
 *  §16.1-16.2) — owned by places.ts (see its own module doc comment for the
 *  full wire/evaluation picture); typed here per this file's own convention
 *  (`SafetyEvent`/`ActivityEvent` above are the same split). Synced to every
 *  circle member as a full-set-replacement, latest-wins list (mirrors
 *  covey-kit's own `CircleConfig` roster discipline) — `id` is this place's
 *  stable handle across edits (arrival/departure/escalation state keys off
 *  it, not array position). `centre`/`radiusMetres` are ALSO what rides the
 *  real flock `fences` wire (geometry only, byte-identical); every other
 *  field here is kindependence's own richer metadata, carried by a companion
 *  signal a plain flock client simply ignores (see places.ts). */
export interface Place {
  id: string
  name: string
  type: 'home' | 'school' | 'park' | 'other'
  centre: { lat: number; lon: number }
  radiusMetres: number
  /** Emit an arrival buzz + Activity entry to the circle on entering. Default on. */
  arrivalNotify: boolean
  /** Emit a departure buzz + Activity entry to the circle on leaving. Default off. */
  departureNotify: boolean
  /** Child-first escalation policy for this place (brief §13.2): `'grace'`
   *  warns the child privately first, for `graceMinutes`, before signalling
   *  the guardian; `'immediate'` skips the grace. */
  escalation: 'grace' | 'immediate'
  graceMinutes: number
  /** Guardian-defined "expected by" rules for this place (Phase 3 Task 4) —
   *  see `ArrivalWindow` below. Optional/omitted for a place with none.
   *  Rides inside THIS place object on the existing `kindependence-places`
   *  companion signal (places.ts's `PlacesMetaSignal`) — no new wire type,
   *  and never crosses into the real flock `fences` geometry-only signal
   *  (`placeToGeofence` only ever reads `centre`/`radiusMetres`). Evaluating
   *  these rules (the tick/reminder/breach behaviour) is Task 5's job — this
   *  field only carries the shape, synced and editable from Task 4 on. */
  arrivalWindows?: ArrivalWindow[]
}

/** One guardian-defined expected-arrival rule for a place (Phase 3 Task 4) —
 *  "at School by 08:45, Mon–Fri, 10 min grace." Owned by places.ts (see its
 *  own module doc comment); typed here per this file's own convention
 *  (`SafetyEvent`/`ActivityEvent` above are the same split — the owning
 *  module imports this as a type, `Place` itself is the same pattern one
 *  level up). `id` is this window's stable handle across edits, same
 *  "unlinkability handle, not a secret" idiom as `Place.id`
 *  (places.ts's `newWindowId` mirrors `newPlaceId`). Evaluation state (Task
 *  5: was a given day's window met/reminded/fired) is NOT part of this
 *  shape — see `Persisted.arrivalWindowMarks` below for that. */
export interface ArrivalWindow {
  id: string
  /** JS `Date.getDay()` values, 0 (Sunday) – 6 (Saturday) — unique, 1-7
   *  entries. Display always renders Mon-first regardless of this array's
   *  order (places.ts's `formatDays`). */
  days: number[]
  /** 24-hour device-local `'HH:MM'` (places.ts's `parseHHMM`). */
  arriveBy: string
  /** Minutes of slack after `arriveBy` before Task 5 would treat the window
   *  as missed — 0-120, one of places.ts's `WINDOW_GRACE_OPTIONS_MIN`. */
  graceMin: number
  /** Whether this rule is currently active — a disabled window is kept
   *  (not deleted) so a guardian can pause it (e.g. school holidays)
   *  without losing its configuration. */
  enabled: boolean
}

/** One sharing-schedule rule (Phase 5 Task 2, brief §32.4) — "Street with
 *  Family, weekday afternoons 15:00-18:00." Same "unlinkability handle, not
 *  a secret" `id` idiom as `ArrivalWindow.id`/`Place.id`
 *  (beacons.ts's `newScheduleRuleId` mirrors `newWindowId`). Owned by
 *  beacons.ts (see its own module doc comment); typed here per this file's
 *  own convention (`ArrivalWindow`/`Place` above are the same split). `days`
 *  is the same JS `Date.getDay()` 0-6 convention as `ArrivalWindow.days`;
 *  `from`/`to` are 24-hour device-local `'HH:MM'` — UNLIKE `ArrivalWindow`
 *  (which rejects an arriveBy+grace combination that crosses midnight
 *  outright), a sharing-schedule window MAY cross midnight
 *  (beacons.ts's `scheduledPrecision` handles it directly, task contract).
 *  `precision` is one of beacons.ts's `BASELINE_PRECISION_OPTIONS` (Town 4 /
 *  Neighbourhood 6 / Street 7 / Precise 9). `label` is the guardian/child's
 *  own free-text name for the rule (≤30 chars, beacons.ts's
 *  `SCHEDULE_LABEL_MAX`) — display-only, never affects evaluation. */
export interface ScheduleRule {
  id: string
  days: number[]
  from: string
  to: string
  precision: 4 | 6 | 7 | 9
  label: string
}

/** An active "heading to X" journey for a circle (Phase 5 Task 3, brief
 *  §32.2) — owned by journey.ts (see its own module doc comment for the
 *  full picture); typed here per this file's own convention
 *  (`ScheduleRule`/`Place` above are the same split). `dest.id` is a place
 *  id (`dest.kind === 'place'`) or a meet-point id (`dest.kind === 'meet'`)
 *  — absent for a free-text `'label'` dest, which has no synced record of
 *  its own to reference. `dest.geohash` is populated for a `'meet'` dest
 *  (encoded from the point's own centre at journey-creation time) and,
 *  optionally, a `'label'` dest the picker attached a map point to — never
 *  for `'place'` (that dest's geometry is looked up fresh by `dest.id`
 *  instead, since a guardian could reposition/resize the place mid-journey
 *  and the fresh lookup should win). `floorPrecision` is always `7`
 *  (Street, task contract) — the ROUTINE emission floor beacons.ts raises
 *  this circle's disclosure to while the journey is active (never a cap,
 *  see beacons.ts's `applyJourneyFloor`). One active journey per circle:
 *  `journey.ts`'s own `startJourney` enforces this (cancel-then-replace),
 *  never this shape itself. */
export interface Journey {
  id: string
  circleId: string
  dest: { kind: 'place' | 'meet' | 'label'; id?: string; label: string; geohash?: string }
  expectedBy?: number
  startedAt: number
  floorPrecision: 7
}

/** One entry in the cross-circle Activity timeline — "things that
 *  happened," append-only, newest-first, capped, deduped by `id`. Owned by
 *  activity.ts (see its module doc comment); typed here per this file's own
 *  convention (`SafetyEvent`/`AgreementRecord`/`PendingApprovalRecord` above
 *  are the same split). `kind` is a plain `string`, not a closed union — a
 *  persisted blob written by a future build with a kind this build doesn't
 *  recognise must still round-trip (load/save) intact rather than being
 *  coerced away, and activity.ts's summary/filter functions are built to
 *  tolerate an unrecognised kind gracefully (forward compat).
 *
 *  `actorPk` is deliberately the ONLY identity carried — no display name.
 *  Names are resolved at RENDER time from the circle's current member list
 *  (or the rolodex), never stored, so a later rename is reflected
 *  retroactively instead of frozen at record time. `params` carries
 *  whatever per-kind detail a summary needs (e.g. a place label, an extend's
 *  minute count, an approval's action) — always plain strings, since this
 *  rides the same JSON-blob persistence as everything else in `Persisted`. */
export interface ActivityEvent {
  /** A wire rumor's own event id for anything received; a synthesised
   *  `local-<kind>-<at>-<circleId>` for a self-originated action — same
   *  dedupe-by-id convention as `SafetyEvent.id` above. */
  id: string
  at: number
  kind: string
  circleId?: string
  actorPk?: string
  params: Record<string, string>
}

/** A tracked party's outstanding `extend-req`, awaiting a guardian's
 *  `extend-resp` — kept on the record so a guardian's card can render
 *  approve/deny, and so `applyExtendResp` has something to dedupe a
 *  resp-replay against (see agreements.ts's doc comment on that function).
 *  Owned by agreements.ts. */
export interface PendingExtend {
  id: string
  extraMin: number
  by: string
  at: number
}

/** One agreement this device is tracking (as the child, as a guardian of
 *  its circle, or both) plus everything the local lifecycle reducer needs
 *  beyond the wire `Agreement` shape itself: `status` starts at `'proposed'`
 *  the moment either side sees the `agreement` signal, and only ever moves
 *  forward (never persisted as anything BEFORE `'proposed'` — see
 *  agreements.ts's reducers). `agreement.byUnix` is itself mutated in place
 *  by a granted extension (BROOD.md §4: "byUnix effectively pushed out by
 *  extraMin") rather than tracked as a separate offset, so every reader
 *  (the schedule/lateness checks, the beacon precision merge) only ever has
 *  to look at one deadline. Owned by agreements.ts; typed here per this
 *  file's own convention (see `SafetyEvent` above). */
export interface AgreementRecord {
  agreement: Agreement
  status: AgreementLifecycleStatus
  /** Set once, the first time an `agreement-status{status:'arrived'}` is
   *  applied — `isLate` (BROOD) reads this to know arrival already
   *  happened, so a late deadline check never fires after the fact. */
  arrivedAt?: number
  pendingExtend?: PendingExtend
}

/** A tracked `approval-req` — this device's own outstanding ask (its
 *  "waiting for a parent" pending state), or one a guardian device has seen
 *  and can act on — plus, once answered, the matching `approval-resp`.
 *  `circleId` is app-level bookkeeping: unlike `Agreement`, BROOD's own
 *  `ApprovalReq` carries no `circleId` field (BROOD.md §3 — it's routed
 *  implicitly by whichever circle inbox delivers/receives it, same as any
 *  guardian(s)-directed signal), so this is recorded at the point the
 *  request is sent or received, not decoded off the wire. Owned by
 *  approvals.ts. */
export interface PendingApprovalRecord {
  req: ApprovalReq
  circleId: string
  /** Final fix B2/I2: the PHONE that raised this request on THIS device,
   *  set only by `raiseApproval`'s own local write — never by the receive
   *  path (a copy of the same req arriving over the wire, including this
   *  identity's OTHER phone's copy, is a dedupe no-op that leaves it
   *  untouched). `req.from` alone (the requester's IDENTITY) isn't enough:
   *  with several phones per identity (spec §5), every phone holds the same
   *  `req.from`, so gating a re-run on that would redo the action on each
   *  of them. Absent for a request this device only ever RECEIVED (a
   *  guardian's own tracking copy, or another of this identity's phones
   *  that didn't raise it itself). */
  raisedByPhonePk?: string
  /** Present once a guardian has answered — `req.id` is the match key (see
   *  BROOD.md §6). Never re-set once present (see approvals.ts's
   *  `applyApprovalResp`) — a replayed/duplicate resp is a no-op. */
  resolved?: { ok: boolean; by: string; at: number }
}

/** covey-kit's `Circle` plus kindependence's own local fields (removal
 *  tombstones — circles.ts's re-key and config handling). Optional, so a
 *  plain covey `Circle` (what covey's pure transforms return) stays
 *  assignable; covey's transforms all spread `...c`, so the VALUES survive
 *  them either way. */
export interface StoredCircle extends Circle {
  /** Durable eviction tombstones (flock's `removed` parity): pubkeys this
   *  circle has removed. Carried in every re-key's cumulative removal set
   *  (Signet identity plan, Task 8 — removals only grow), and blocks
   *  `joined`-announce re-adds and stale config re-adds. */
  removedPks?: string[]
  /** Per removed pubkey: the inner `created_at` of the re-key that removed
   *  them, and the hash of the seed that re-key installed. A config chained
   *  to that seed or a later one was written by a device that had seen the
   *  removal, so a member it lists is a deliberate re-admission (the
   *  tombstone is lifted); an invite re-admits only if dated after `at`
   *  (Task 10). */
  removals?: Record<string, { at: number; hash: string }>
  /** When THIS device's current local epoch (seed) of this circle started:
   *  a fresh circle's creation time, an accepted invite's own signed
   *  `created_at`, or the most recently applied re-key's `created_at`
   *  (Task 10 fix round 3). An incoming invite for a seed hash not in our
   *  known chain is a genuine re-invite only if it's dated AFTER this — a
   *  replayed older invite (from before our current epoch even started)
   *  must not be mistaken for one just because our chain doesn't happen to
   *  go back that far (e.g. right after re-joining — `saveJoinedCircle`
   *  appends to the prior chain rather than resetting it, but a device that
   *  has always been a continuous single-epoch member has no earlier
   *  history to append). */
  epochStartedAt?: number
}

export interface Persisted {
  v: 1
  circles: StoredCircle[]
  /** `mapCircles` is the Map tab's circle multi-selector (Task 3, brief
   *  §6.3) — `undefined`/omitted means "no explicit filter" (every circle
   *  shown); see mapinfo.ts's `resolveCircleSelection` for the full
   *  normalization rules. Visibility only — this never gates what a beacon
   *  discloses, only which already-received positions this device draws.
   *  `circleBasePrecision` (Task 8, brief §11.1) is the per-circle "what I
   *  share" baseline this device's own ROUTINE beacon discloses at, keyed by
   *  circle id — one of `beacons.ts`'s `BASELINE_PRECISION_OPTIONS` (Town 4 /
   *  Neighbourhood 6 / Street 7 / Precise 9); a circle absent here uses
   *  `beacons.ts`'s `DEFAULT_BASELINE_PRECISION` (Neighbourhood). Local-only,
   *  same as `mapCircles` — this is a personal disclosure choice, never
   *  synced to the wire. It is strictly a FLOOR: an agreement's schedule (and,
   *  independently, any safety trigger — SOS/help/breach/pickup-answer, which
   *  never consult this setting at all, see `beacons.ts`'s `basePrecisionFor`
   *  doc comment) can only raise disclosure above it, never be capped by it. */
  /** `shareBattery` (Phase 3 Task 1) is battery.ts's per-circle "do I share
   *  MY battery level with this circle" choice, keyed by circle id — a
   *  circle absent here uses `battery.ts`'s `shareBatteryDefault` (child: on,
   *  guardian: off). `batteryAlertsOff` (Phase 3 Task 2) is a single global
   *  opt-out of low-battery alerts for circle members' batteries (not this
   *  device's own sharing choice above — that's `shareBattery`). Both
   *  local-only, same "personal disclosure/notification choice, never synced
   *  to the wire" convention as `circleBasePrecision`.
   *
   *  `routingUrl` (Phase 4 Task 5, brief §6.7) is this device's own opt-in
   *  self-hosted routing engine base URL (Valhalla, with an OSRM fallback at
   *  the same host — see travel.ts's own doc comment) — `undefined` (the
   *  default) means every travel-time estimate and fair-spot suggestion
   *  stays fully on-device (heuristic/centroid), never touching the network
   *  at all. `overpassUrl` (review-minor, own separate field — NOT reused
   *  from `routingUrl`) is this device's own opt-in self-hosted
   *  Overpass-compatible endpoint for the venue search step of a fair-spot
   *  suggestion; `meetVenues` (default OFF) additionally opts into that
   *  search — sent ONLY to `overpassUrl`, never a public default and never
   *  `routingUrl` (see travel.ts's `suggestMeetSpot`/`engineSuggestMeetSpot`
   *  doc comments), and reachable at all only when BOTH `overpassUrl` is set
   *  AND `meetVenues` is on (the venue gate). Routing and venue search are
   *  independent opt-ins — a self-hoster can run one without the other. All
   *  local-only, same convention as every other field here. */
  settings: {
    relayUrl?: string
    mapCircles?: string[]
    circleBasePrecision?: Record<string, number>
    shareBattery?: Record<string, boolean>
    batteryAlertsOff?: boolean
    routingUrl?: string
    overpassUrl?: string
    meetVenues?: boolean
    /** Phase 5 Task 1 (brief §32.5) — receiver-side local notification quiet
     *  window: `start`/`end` are device-local `'HH:MM'` (places.ts's
     *  `parseHHMM`, reused rather than duplicated — see notify.ts's
     *  `isQuietNow`), window may cross midnight. `undefined`/`enabled:
     *  false` is the default (off). Local-only, never synced — same
     *  convention as every other field here; rides the SAME blanket
     *  `settings` object coercion in `load()` below as its siblings (no
     *  per-field deep validation anywhere in this record — `isQuietNow`
     *  itself fails safe to "not quiet" on a malformed `start`/`end`, so a
     *  corrupt value can only ever under-hold, never accidentally hold
     *  every notification forever). Never touches the wire or Activity —
     *  see notify.ts's module doc comment for the receive-side filter this
     *  drives, gated inside `notify()`'s one gate point. */
    quietHours?: { enabled: boolean; start: string; end: string }
    /** Phase 5 Task 2 (brief §32.4) — per-circle time-windowed precision
     *  overrides, keyed by circle id: "Street with Family, weekday
     *  afternoons." At most `beacons.SCHEDULE_RULE_MAX` (6) rules per circle
     *  — enforced by the You-tab editor (`beacons.validateScheduleRuleDraft`),
     *  not re-checked here (same "no per-field deep validation" convention as
     *  every other settings field — a malformed/over-cap persisted blob just
     *  means `scheduledPrecision` walks a few extra harmless entries, never a
     *  crash). Local-only, same "personal disclosure choice, never synced to
     *  the wire" convention as `circleBasePrecision` — which this OVERRIDES
     *  while a rule's window is active (`beacons.ts`'s
     *  `circleBaselinePrecision`); outside every rule's window, the static
     *  `circleBasePrecision` applies exactly as before this task. An
     *  agreement's own schedule (BROOD) can still raise disclosure above
     *  whichever of the two applies — resolution order stays safety >
     *  agreement > schedule-or-static-baseline (see beacons.ts's
     *  `basePrecisionFor` doc comment for the full picture). */
    sharingSchedules?: Record<string, ScheduleRule[]>
    /** Phase 5 Task 4 (brief §24.6) — device-local Activity retention
     *  controls: `cap` is the max `Persisted.activity` length this device
     *  keeps (100/500/1000, default 500 when absent/not one of those three —
     *  see activity.ts's `ACTIVITY_RETENTION_CAP_OPTIONS`/
     *  `DEFAULT_ACTIVITY_RETENTION_CAP`); `dropRoutine` additionally prunes
     *  routine kinds (arrival/departure/precision-raised/message) older than
     *  7 days on every append. A handful of safety/permission kinds
     *  (activity.ts's `AUDIT_KINDS`) are NEVER auto-pruned by `dropRoutine`
     *  and are the LAST resort at the cap — §24.6's "some records
     *  permanently auditable" floor. View data only, never wire-synced —
     *  same "device-local, never touches Activity's own record of what
     *  happened elsewhere" convention as every other field here; rides the
     *  SAME blanket `settings` object coercion in `load()` below as its
     *  siblings (no per-field deep validation — activity.ts's
     *  `pruneActivity` falls back to the default cap on anything outside
     *  `ACTIVITY_RETENTION_CAP_OPTIONS`, so a corrupt value can only ever
     *  under/over-retain slightly, never crash). */
    activityRetention?: { cap?: number; dropRoutine?: boolean }
  }
  /** Recent help/check-in/pickup events, newest first — see `SafetyEvent`. */
  safetyEvents: SafetyEvent[]
  /** Agreements this device is tracking, across every circle — see
   *  `AgreementRecord`. */
  agreements: AgreementRecord[]
  /** Each circle's current `FamilyPolicy` (BROOD.md §5 — full-set,
   *  latest-wins), keyed by circle id. A circle absent here has never had a
   *  policy published; `evaluatePolicy(undefined, action)` falls through to
   *  `DEFAULT_VERDICT` ('prompt') for it, same as an absent action within a
   *  present policy's `rules`. Owned by approvals.ts. */
  familyPolicies: Record<string, FamilyPolicy>
  /** Approval requests this device has raised or seen — see
   *  `PendingApprovalRecord`. Owned by approvals.ts. */
  approvals: PendingApprovalRecord[]
  /** Cross-circle "what happened" timeline, newest first — see
   *  `ActivityEvent`. Owned by activity.ts. */
  activity: ActivityEvent[]
  /** Person-to-person DM threads, keyed by the OTHER party's pubkey —
   *  oldest-first (chat reading order), capped ~200/peer. Owned by
   *  messages.ts. */
  dmThreads: Record<string, ChatMessage[]>
  /** Per-peer "I've seen everything up to this timestamp" marker, used only
   *  to compute the unread badge (messages.ts's `unreadForPeer`) — a simple
   *  lastSeen, not a read-receipt broadcast to the peer. */
  dmLastSeen: Record<string, number>
  /** Circle chat threads, keyed by circle id — same shape/cap as
   *  `dmThreads`. Owned by messages.ts. */
  circleChats: Record<string, ChatMessage[]>
  /** Per-circle lastSeen marker, same idiom as `dmLastSeen`. */
  circleChatLastSeen: Record<string, number>
  /** Each circle's current safe-place set (Task 7) — full-set-replacement,
   *  keyed by circle id. Owned by places.ts. */
  places: Record<string, Place[]>
  /** Each circle's places latest-wins clock/author — mirrors flock's own
   *  `FenceSet.updatedAt`/`.by` (see `@forgesworn/flock/fences`'s
   *  `isNewerFenceSet`, reused directly by places.ts to decide whether an
   *  incoming set should replace this device's copy). Owned by places.ts. */
  placesMeta: Record<string, { updatedAt: number; by: string }>
  /** Task 7 follow-up fix: the MINIMAL snapshot of a circle's escalation
   *  phase (places.ts's `EscalationSubState`) needed to survive a reload
   *  mid-episode — without this, a child could force-close the app during a
   *  grace countdown to reset it indefinitely and never trigger the
   *  guardian signal. A circle absent here is `'safe'` (never itself
   *  persisted — see places.ts's `placeEvalToPersisted`). `graceEndsAt` is
   *  present only for `phase: 'grace'`. Owned by places.ts. */
  placeEval: Record<string, PersistedPlaceEval>
  /** Task 7 follow-up fix: per `${circleId}:${placeName}`, the unix-seconds
   *  timestamp a breach signal was last actually sent — an independent,
   *  time-based guard (defense-in-depth alongside `placeEval` above)
   *  against re-sending a duplicate breach purely because the app reloaded
   *  while still outside a safe place. Owned by places.ts. */
  placeLastEscalatedAt: Record<string, number>
  /** Phase 3 Task 4: per-window, per-day evaluation marks — Task 5's runtime
   *  state, but the SHAPE lands with this task (task contract). Keyed by
   *  `ArrivalWindow.id`; `day` is the LOCAL `'YYYY-MM-DD'` this mark is for
   *  (a window recurs weekly, so each occurrence needs its own mark, not one
   *  mark per window forever). `met`/`reminded`/`fired` are each `true` or
   *  absent (never `false`) — same "presence, not a boolean value" idiom as
   *  `ActivityEvent`'s sibling records elsewhere in this file; Task 5 alone
   *  defines what each means and when they're set. Owned by places.ts. */
  arrivalWindowMarks: Record<string, { day: string; met?: true; reminded?: true; fired?: true }>
  /** Per-person VIEWING preferences for the Map tab (Phase 4 Task 2, brief
   *  §9/§6.5) — keyed by pubkey. `mutedUntil` hides that person's marker
   *  (and any future edge-chip equivalent) and excludes them from the
   *  adaptive auto-fit (mapinfo.ts's `fitSet`) until it expires; `-1` is
   *  the sentinel for "until I manually unmute" (mapinfo.ts's
   *  `muteUntil`/`isMuted` own the resolution/expiry rules). `pinned:
   *  true` does the opposite for auto-fit — always included, exempt from
   *  the "holiday abroad" outlier exclusion — and nothing else.
   *
   *  HARD INVARIANT: this is a VIEWING preference only. Muting someone
   *  must NEVER suppress a safety signal (SOS/help, a place breach
   *  escalation, a pickup answer) or any notification for them, never
   *  changes what THIS device discloses to anyone, and never revokes or
   *  grants access. `notify.ts`, `safety.ts`, and `places.ts`'s
   *  escalation path never read this field (verified by inspection, Phase
   *  4 Task 2) and must stay that way — a muted guardian's child can still
   *  trigger an SOS that notifies and banners exactly as if never muted.
   *  Pinning likewise grants no new access — it only prioritises an
   *  already-visible position in the fit, same "renders only
   *  already-permitted info" discipline as every other display-only
   *  preference in this file (`mapCircles`/`circleBasePrecision` above).
   *  Local-only, never synced to the wire — same convention as those
   *  settings. Owned by mapinfo.ts (pure resolution helpers) + app.ts (the
   *  person sheet's Mute/Pin actions, and circles.ts's member-list
   *  "Muted · …" row — a muted person's only remaining path back to
   *  Unmute once their marker is gone).
   *  Deliberately left UNPRUNED (final-review fix 6, unlike `leaveFired`/
   *  `agreementTravelMode` below): keyed by member pubkey, not an agreement
   *  id — a member can leave and rejoin a circle, so a pref surviving in
   *  between is harmless leftover state, not a dead-forever key. */
  viewPrefs: Record<string, { mutedUntil?: number; pinned?: true }>
  /** Each circle's current temporary meeting-point set (Phase 4 Task 5,
   *  brief §6.6-6.7) — full-set-replacement, keyed by circle id, same
   *  discipline as `places`/`placesMeta` one level up (this is deliberately
   *  a SEPARATE record, not folded into `places`, since a meeting point is
   *  short-lived/self-expiring and has no geofence/escalation semantics at
   *  all — see meet.ts's own module doc comment). Owned by meet.ts. */
  meetPoints: Record<string, MeetPoint[]>
  /** Each circle's meeting-point set latest-wins clock/author — mirrors
   *  `placesMeta`'s own shape and reuses the SAME `isNewerFenceSet` clock
   *  check (meet.ts). Owned by meet.ts. */
  meetMeta: Record<string, { updatedAt: number; by: string }>
  /** Tracked pickups (request or offer direction) across every circle, newest-
   *  touched-first, capped at `pickup.MAX_PICKUP_RECORDS` (20) — see
   *  `pickup.ts`'s own module doc comment for the full lifecycle picture.
   *  Owned by pickup.ts. */
  pickups: PickupRecord[]
  /** Travel-aware leave reminders (Phase 4 Task 8, brief §15) — the child's
   *  own chosen travel mode per agreement, keyed by `Agreement.id`; an
   *  agreement absent here defaults to `'walk'` (agreements.ts's agreement-
   *  card mode picker writes here). Local-only device preference, never
   *  synced to the wire — same "personal choice, independent of the other
   *  side's own device" convention as `circleBasePrecision`/`shareBattery`
   *  above (a guardian device never reads or writes this at all: leave
   *  reminders are evaluated purely on the child's own device, see
   *  agreements.ts's module doc comment). Owned by agreements.ts. */
  agreementTravelMode: Record<string, TravelMode>
  /** Fired leave-reminder stage markers, keyed
   *  `${agreementId}:${byUnix}:${stage}` — presence means that stage has
   *  already been handled this schedule (either genuinely notified, or
   *  collapsed away by `dueLeaveStage`'s "return only the latest due stage"
   *  rule — see agreements.ts's own doc comment on why the caller still
   *  marks every currently-due stage, not just the one it notified for).
   *  Embedding `byUnix` in the key means a granted extension re-arms the
   *  whole schedule for free: none of the new byUnix's keys exist yet, no
   *  special-case "clear on extend" logic needed. Pruned
   *  (agreements.ts's `pruneOrphanedLeaveFired`) whenever a key's
   *  agreementId no longer appears in `p.agreements` — agreements are never
   *  deleted anywhere in this codebase today (verified by inspection), so
   *  this is forward hygiene mirroring places.ts's own
   *  `pruneOrphanedWindowMarks`, not a fix for an observed leak. Owned by
   *  agreements.ts. */
  leaveFired: Record<string, true>
  /** Each circle's active "heading to X" journey, if any (Phase 5 Task 3,
   *  brief §32.2) — keyed by circle id, absent means no active journey.
   *  Owned by journey.ts. */
  journeys: Record<string, Journey>
  /** Phase 5 Task 5 (brief §13.4): a circle's currently-approved boundary-
   *  exits — every entry means "being outside `placeId` doesn't count as an
   *  exit, until `until` (unix seconds)". Deliberately keyed by
   *  circleId+placeId ONLY, not by which member the leave was granted to
   *  (this is the task's own specified interface, verbatim) — in a
   *  MULTI-CHILD circle this means an approved leave for a place technically
   *  suppresses ANY child's exit from that place for the same window, not
   *  just the requester's. Accepted v1 scope: most families' "ask to go
   *  out" flow is one child at a time in practice, and `applyLeaveResolution`
   *  (places.ts) already REPLACES rather than accumulates an entry for the
   *  same placeId, so this never grows unbounded. Pruned of expired entries
   *  on every `places.tick()` (`places.pruneExpiredLeaves`) — this is the
   *  "prune-on-expiry" the task brief asks for; `places.isLeaveApproved`
   *  additionally treats a stale/expired entry as absent regardless, so a
   *  missed prune is never a correctness bug, only unbounded (if slow)
   *  growth. Owned by places.ts. */
  approvedLeaves: Record<string, Array<{ placeId: string; until: number }>>
  /** Phase 5 Task 5 (brief §13.4/§22.3-22.4): a guardian's per-circle
   *  Allow/Prompt/Deny verdict for boundary-exit ("leave-area") requests —
   *  same three-value `PolicyVerdict` BROOD's real `family-policy`
   *  wire signal uses for the other four `PolicyAction`s, but this field
   *  itself is LOCAL-ONLY and NEVER rides that wire signal: BROOD's
   *  `PolicyAction` is a closed 4-value enum, hard-enforced at PARSE time
   *  (verified empirically, see approvals.test.ts) — a `rules` map
   *  containing a 5th key doesn't just fail to add the key, it makes
   *  `parseBroodSignal` reject the ENTIRE `family-policy` signal, silently
   *  breaking sync of the other four real actions too. So unlike
   *  `familyPolicies` (guardian-authored, synced to every device),
   *  `leaveAreaPolicy` only ever reflects THIS device's own guardian
   *  settings screen — a family with co-guardians on separate devices sets
   *  it independently on each (documented in the You-tab copy, not solved
   *  here — same "local-only by design this phase" scope every other
   *  Phase 5 setting shares, brief §32's cross-cutting note). A circle
   *  absent here defaults to `'prompt'`, same `DEFAULT_VERDICT` fallback
   *  BROOD's own `evaluatePolicy` uses. Consulted only on RECEIPT of a
   *  leave-area request (approvals.ts's registered auto-resolver), never by
   *  the requester pre-emptively — the requester's device has no way to
   *  know this device's local setting in advance. Owned by approvals.ts. */
  leaveAreaPolicy: Record<string, PolicyVerdict>
  /** Phase 6 Task 1 (design spec §1, brief §2.3) — the map-check friction
   *  card's own private tap counter: `day` is the LOCAL `'YYYY-MM-DD'` the
   *  count is FOR (places.ts's own `localDay`, reused rather than
   *  duplicated — same "reuse, don't reinvent" convention as beacons.ts's
   *  `parseHHMM` reuse), `count` the number of Map-tab-activations/
   *  dependant-person-sheet-opens recorded so far today, `lastAt` the
   *  unix-seconds timestamp of the last COUNTED tap — a burst of taps
   *  inside `friction.FRICTION_MIN_GAP_SEC` of `lastAt` collapses to one
   *  check, so `lastAt` only ever moves on an actual increment (see
   *  friction.ts's `nextMapCheckState`). A `day` other than today's is
   *  treated as stale/empty by every reader, so this never needs an
   *  explicit "reset at midnight" step of its own — the next real tap on a
   *  new day just starts a fresh count of 1. Required (not optional,
   *  unlike `frictionDismissedDay` below) with a concrete empty-string/zero
   *  default (see `defaults()`) — every reader treats `day: ''` as "no day
   *  has ever matched," same as a genuinely absent counter. Guardian-device
   *  ONLY in practice (app.ts's two call sites both gate on
   *  `identity.role === 'parent'` before ever calling
   *  `friction.recordMapCheck` — see that module's own doc comment for the
   *  full "why guardian-only" picture). LOCAL ONLY: never rides the wire,
   *  never appears in Activity, never visible to a child device (this
   *  device's own local storage is never synced) — the hard rule this
   *  whole feature exists under. Owned by friction.ts. */
  mapChecks: { day: string; count: number; lastAt: number }
  /** Phase 6 Task 1 — the calendar day (LOCAL `'YYYY-MM-DD'`, same
   *  convention as `mapChecks.day`) the friction card was last dismissed
   *  on; `undefined` means "never dismissed" (or dismissed on some earlier
   *  day, which reads identically to never — see friction.ts's
   *  `shouldShowFrictionCard`: only an EXACT match against today's stamp
   *  suppresses the card, so the dismissal itself never needs pruning/
   *  expiry logic of its own — a stale value is simply never equal to
   *  "today" again). Same local-only, guardian-only, never-wired
   *  convention as `mapChecks` above. Owned by friction.ts. */
  frictionDismissedDay?: string
  /** Phase 6 Task 2 (design spec §2, brief §2.3/§2.4) — the guardian-set
   *  independence level for one child within one circle, keyed
   *  `${circleId}:${childPk}` (milestones.ts's `independenceKey`) — local to
   *  THIS guardian device only (design spec §2: "per child pk, per circle,
   *  local to the guardian device"; explicitly out of scope: "any
   *  cross-device sync of levels"). Absent means no level has ever been
   *  applied — milestones.ts's `stepUpSuggestion` treats that as level 1
   *  (the most conservative starting point) for step-up purposes. Written
   *  ONLY by `milestones.applyLevel`, an EXPLICIT guardian tap — nothing
   *  here ever auto-applies. Owned by milestones.ts. */
  independenceLevel: Record<string, 1 | 2 | 3>
  /** Phase 6 Task 2 — per `${circleId}:${childPk}`, the unix-seconds
   *  deadline a dismissed step-up suggestion re-arms at (set to
   *  `dismissedAt + QUIET_STREAK_DAYS` by milestones.ts's `dismissStepUp`) —
   *  "dismiss = re-arms after another full streak" (design spec §2).
   *  `milestones.stepUpSuggestion` treats an entry whose deadline hasn't
   *  passed yet as "still suppressed"; once it has, the ordinary quiet-
   *  streak check (scanning the last `QUIET_STREAK_DAYS` of Activity) takes
   *  back over unassisted — a fresh escalation/window-miss/SOS anywhere in
   *  that freshly-elapsed window still blocks the suggestion exactly as it
   *  would for a NEVER-dismissed one, so "another full streak" falls
   *  naturally out of the same check rather than needing separate
   *  bookkeeping. Pruned of expired entries by milestones.ts's own weekly
   *  tick-piggybacked pass (`evaluateStepUpsIfDue`) — housekeeping only (a
   *  stale entry is already inert regardless, same "a missed prune is never
   *  a correctness bug" discipline as places.ts's `approvedLeaves`). Owned
   *  by milestones.ts. */
  stepUpDismissedUntil: Record<string, number>
  /** Phase 6 Task 2 — unix-seconds timestamp of the last weekly step-up
   *  evaluation/housekeeping pass (milestones.ts's `evaluateStepUpsIfDue`,
   *  piggybacked on places.ts's existing `tick()` via
   *  `places.registerPeriodicHook` rather than a second timer) — `0` (never
   *  run) is always due. Purely a cadence gate for that housekeeping pass;
   *  the pure `stepUpSuggestion` heuristic itself never depends on this
   *  having run recently — it re-derives everything fresh from `p.activity`
   *  on every call. Owned by milestones.ts. */
  stepUpLastEvaluated: number
  /** Phase 6 final-review finding 4 (streak observation floor): per
   *  `${circleId}:${childPk}` (same key shape as `independenceLevel`), the
   *  unix-seconds moment THIS device first ever evaluated whether a step-up
   *  suggestion applies to this pair — stamped once, by
   *  `milestones.evaluateStepUpsIfDue`'s own housekeeping pass (piggybacked
   *  on `places.tick()`, which runs within moments of app start — see that
   *  function's own doc comment), for every child in every circle this
   *  device guards that doesn't have an entry yet; never reset by a LATER
   *  pass. `milestones.stepUpSuggestion` refuses to suggest anything at all
   *  until a full `QUIET_STREAK_DAYS` has elapsed since this stamp — without
   *  it, a device installed five minutes ago would misread its own
   *  trivially-empty Activity history as "a clean streak" and suggest a
   *  step-up immediately, which is exactly backwards (the streak has to have
   *  actually been WATCHED for a month, not merely "nothing bad happened
   *  yet because nothing has happened at all"). Owned by milestones.ts. */
  stepUpFirstObserved: Record<string, number>
  /** Phase 6 final-review finding 6: per circleId, the safe-area
   *  grace-minutes default a freshly-ADDED place should inherit — written by
   *  `milestones.applyLevel`'s own step (a) every time a level is applied
   *  (same moment it rewrites every EXISTING place's grace/escalation), so a
   *  place added the day AFTER a guardian deliberately loosened (or
   *  tightened) everything else starts at that same level's own grace period
   *  rather than silently reverting to the app's generic
   *  `places.DEFAULT_GRACE_MINUTES`. Read by `places.defaultGraceMinutesFor`
   *  (new-place creation only — an applied level already updates every
   *  EXISTING place directly via `savePlaces`, so this never needs to touch
   *  them). Absent circle → that generic default. Owned by milestones.ts
   *  (write side); places.ts only ever reads it. */
  levelDefaults: Record<string, { graceMinutes: number }>
  /** Phase 7 Task 4 (design spec §4): each circle's flock-interoperable
   *  dropped pins — keyed by circle id, a plain array of `Pin` (drops AND
   *  retained tombstones alike, per `pins.withPin`'s own replay-proofing —
   *  unlike `places`/`meetPoints`, this is NOT a full-set-replacement; each
   *  entry is merged in individually via `pins.applyPin`, latest-timestamp-
   *  wins per id). Capped at `pins.PIN_CAP` LIVE (non-removed) entries per
   *  circle — a kindependence-only storage bound, not part of flock's own wire
   *  (see pins.ts's own module doc comment). Owned by pins.ts. */
  pins: Record<string, Pin[]>
  /** Signet identity plan (Task 5): the signed-in session — this device's
   *  link to a My Signet identity plus its own local phone key. `undefined`
   *  means signed out. Never holds a secret key itself (the phone secret
   *  lives in `SecretStore`, the bunker client secret under
   *  `bunker-client-sk` in the same store) — see session.ts's own module
   *  doc comment. Owned by session.ts. */
  session?: SessionInfo
  /** Signet identity plan (Task 7): every phone key an identity has
   *  authorised, keyed by circle id then phone pubkey — `memberPk` is the
   *  identity pubkey that authorised it (device-statements.ts's
   *  `DeviceStatement.identityPk`), `statement` the signed authorising
   *  event itself, `lastSeen` a freshness marker. Owned by a later task. */
  phoneKeys: Record<string, Record<string, { memberPk: string; statement: SignedEvent; lastSeen: number }>>
  /** Signet identity plan (Task 7): phone keys an identity has explicitly
   *  withdrawn authorisation from (device-statements.ts's `Revocation`),
   *  keyed by phone pubkey. Owned by a later task. */
  revokedPhoneKeys: Record<string, SignedEvent>
  /** Final fix A4: revocations of phone keys not yet bound to any identity
   *  here, keyed by phone pubkey, oldest key first, capped (phone-keys.ts).
   *  Never treated as revoked: one is promoted into `revokedPhoneKeys` only
   *  when a statement for that key arrives from the revocation's own
   *  signer. Task 9 fix round 1: also holds a revocation of an ALREADY
   *  BOUND key whose signer isn't yet a linked guardian of its owner — same
   *  table, same caps, reused rather than duplicated; promoted instead when
   *  `guardian-links.ts`'s `onLinkChange` reports that link becoming true,
   *  or at app start (`phone-keys.ts`'s `promoteParkedRevocations`). Owned
   *  by phone-keys.ts. */
  pendingRevocations: Record<string, SignedEvent[]>
  /** Signet identity plan (Task 7): device statements from identities not
   *  (yet) on the roster of the circle they were posted on, each kept with
   *  that circle's id and re-checked only against that circle's roster.
   *  Owned by phone-keys.ts. */
  pendingStatements: Array<{ circleId: string; event: SignedEvent }>
  /** Signet identity plan (Task 6): the replay-protection chain of seed
   *  hashes (structural.ts's `seedHash`) a structural event has been
   *  written against, per circle — newest last. Owned by a later task. */
  seedHashes: Record<string, string[]>
  /** Signet identity plan (Task 6): identity-signed structural actions
   *  (structural.ts's `StructuralAction`) queued for the identity signer —
   *  `'waiting'` for a signature/send, `'rejected'` if the signer refused,
   *  `'paused'` if the person backed out of the signer's screen.
   *  See `QueuedAction` below. Owned by a later task. */
  structuralQueue: QueuedAction[]
  /** Signet identity plan (Task 10): ids of personal (gift-wrapped) events
   *  this device has already unwrapped, newest last, capped at 5000
   *  (oldest dropped) — a dedupe log, not a display record. Owned by a
   *  later task. */
  seenPersonalWraps: string[]
  /** Personal-inbox wraps the identity signer has definitely refused to
   *  decrypt (`SignerRejected`), with how many times, compactly as
   *  `<first 16 hex of the wrap id>:<n>` — oldest first, capped at
   *  `MAX_REFUSAL_RECORDS` (5000). A wrap refused `MAX_WRAP_REFUSALS` times
   *  (circles.ts) is dropped into `seenPersonalWraps`, so a junk wrap costs
   *  a bounded number of silent attempts. Owned by circles.ts. */
  personalWrapRefusals: string[]
  /** Signet identity plan (Task 8): per circle, the phone keys known to
   *  hold the CURRENT seed — the applied re-key's `to` plus the phones this
   *  device forwarded it to. Absent for a circle not yet re-keyed (then
   *  every phone ever bound in the circle is presumed to hold it). A
   *  revocation of a phone listed here triggers a re-key. Owned by
   *  circles.ts. */
  seedRecipients: Record<string, string[]>
  /** Signet identity plan (Task 8): the last re-key applied per circle —
   *  lets a lower-id competitor arriving after the collection window
   *  replace it (one level back). Owned by circles.ts. */
  lastRekey: Record<string, LastRekey>
  /** Signet identity plan (Task 8): removals THIS device has asked for
   *  (queued re-keys) that no applied re-key carries yet — re-enqueued on
   *  start so an app kill inside the collection window can't lose them.
   *  Owned by circles.ts. */
  pendingRemovals: Record<string, string[]>
  /** When each `pendingRemovals` entry was first asked for (its inner
   *  `created_at`, at request time — circles.ts's `nowSec()`), keyed the
   *  same way. Lets a resend (this file's own `pendingRemovals` doc comment,
   *  and `sendRekeyEvent`'s stale-resend branch) tell a removal that's
   *  genuinely still owed from one whose target has since been vouched back
   *  onto the roster (vouches.ts's `vouchFor`, newer than this) — dropped
   *  rather than resent. Owned by circles.ts. */
  pendingRemovalsAt: Record<string, Record<string, number>>
  /** Signet identity plan (Task 8): `<circleId>:<inner id>` of structural
   *  events already handled, newest last, capped at 2000. Owned by
   *  beacons.ts. */
  seenStructural: string[]
  /** Signet identity plan (Task 8): when this device last posted its own
   *  device statement into each circle (ms). Owned by beacons.ts. */
  statementPostedAt: Record<string, number>
  /** Plan 2, Task 2: this device's persisted signet-contacts v2 pairing
   *  (`PairingV2` from `@forgesworn/signet-contacts`) — plain JSON, no
   *  secret (the app key it was paired under lives in `SecretStore`, same
   *  "never a secret in this blob" convention as `session.transport`).
   *  `undefined` means never paired (or a disconnect forgot it, see
   *  contacts-grant.ts's `disconnectGrant`). Typed `unknown` here rather
   *  than importing the library's own type, so store.ts never depends on
   *  signet-contacts — contacts-grant.ts is the only reader/writer and
   *  re-validates it like any other stored value. Owned by
   *  contacts-grant.ts. */
  contactsPairing?: unknown
  /** Plan 2, Task 2: the latest contacts snapshot (contacts.ts's
   *  `ContactsSnapshot`) — persisted so it survives a restart before the
   *  first fetch completes (contacts-grant.ts's `startGrant`). `undefined`
   *  means no snapshot has ever been produced. Owned by contacts-grant.ts. */
  contactsSnapshot?: ContactsSnapshot
  /** Plan 2, Task 3: accepted guardian links, keyed
   *  `${guardianPk}:${dependantPk}` — the guardian's guardian-of statement
   *  (`g`) and the dependant's dependant-of statement (`d`), both verified on
   *  acceptance (device-statements.ts's `verifyLinkStatement`). The newest
   *  accepted pair is kept. A stored pair is a link only while both
   *  statements are newer than every unlink between the two (`unlinks`).
   *  Owned by guardian-links.ts. */
  guardianLinks: Record<string, { g: SignedEvent; d: SignedEvent }>
  /** Plan 2, Task 3: the newest verified unlink per `${signerPk}:${otherPk}`.
   *  Owned by guardian-links.ts. */
  unlinks: Record<string, SignedEvent>
  /** Plan 2, Task 4: the newest verified vouch per circle and vouchee —
   *  `vouches[circleId][voucheePk]` is an identity-signed `invite` or
   *  `vouch` structural event (vouches.ts's `verifyVouch`). Owned by
   *  vouches.ts, which re-verifies each one on read. */
  vouches: Record<string, Record<string, SignedEvent>>
  /** Plan 2, Task 4: each circle's creator identity pk, set once and never
   *  changed. Owned by vouches.ts. */
  circleCreators: Record<string, string>
  /** Plan 2, Task 4: `unvouchedSince[circleId][pk]` — unix seconds since a
   *  member lost their voucher with no new vouch yet. Owned by vouches.ts. */
  unvouchedSince: Record<string, Record<string, number>>
  /** Plan 2, Task 5 fix round 1: vouches for pks not (yet) on the roster,
   *  per circle, oldest stored first, at most one per (vouchee, voucher)
   *  and capped (vouches.ts `PENDING_VOUCH_CAP`). Never read as a member's
   *  vouch: a config adding the vouchee may rely on one. Owned by
   *  vouches.ts, which re-verifies each one on read. */
  pendingVouches: Record<string, SignedEvent[]>
  /** Plan 2, Task 6: the newest authorised config inner event (identity-
   *  signed, v2) this device holds per circle — sent or applied — carried
   *  in each invite bundle so a joiner can bootstrap the roster. Owned by
   *  circles.ts, which re-verifies it on read. */
  heldConfigs: Record<string, SignedEvent>
  /** Task 6 fix round 1: the verified re-key an accepted invite bundle
   *  carried, per circle — the one that installed the seed we joined on —
   *  so our own invites carry it on. Owned by circles.ts, which re-verifies
   *  it on read and sends it only while it installed the current seed. */
  heldRekeys: Record<string, SignedEvent>
  /** Plan 2, Task 7: this guardian phone's one-time pairing secrets (hex),
   *  each valid for 10 minutes and once only (link-pairing.ts). Entries
   *  older than a day are pruned whenever a new one is written. */
  linkSecrets: Record<string, { createdAt: number; used: boolean }>
  /** Plan 2, Task 8: open trust prompts (a contact dropped from My Signet
   *  went `absent`, or a batch of explicit drops needs one confirmation) —
   *  the UI's own removal cards are Task 10. Owned by trust-watch.ts. */
  trustPrompts: TrustPrompt[]
}

export interface LastRekey {
  prev: string
  id: string
  /** The applied re-key's signer (identity): a late re-key that removes it
   *  replaces it whatever its id (final fix round 2, R2). */
  signerPk: string
  removals: string[]
  /** The applied re-key's `to` plus the phones this device forwarded it to. */
  seedRecipients: string[]
  /** Whether our identity signed it, from any of its phones (its removals
   *  return to `pendingRemovals` if a late winner replaces it). */
  mine: boolean
  /** The applied re-key's own signed `created_at` (s): a late winner dated
   *  more than 600 s after it is refused (final fix A1). */
  createdAt: number
  /** When this device applied it (ms): a late winner arriving more than
   *  10 minutes later is refused (final fix A1). */
  appliedAt: number
  /** Plan 2, Task 6: the applied re-key inner event itself (identity-
   *  signed), carried in invite bundles so a joiner drops its removals.
   *  Absent on records from before Task 6. */
  event?: SignedEvent
  /** The circle as it was at `prev`, for judging and applying a late winner
   *  that replaces this re-key: the tombstones then, and the members and
   *  phone bindings this re-key removed. */
  before: {
    removedPks: string[]
    removals: Record<string, { at: number; hash: string }>
    members: Array<{ pk: string; role: 'guardian' | 'child' | 'peer'; name?: string }>
    phones: Record<string, { memberPk: string; statement: SignedEvent; lastSeen: number }>
    /** Final review A, I1: the vouches of the members this re-key removed
     *  (dropped from the vouch table), restored with them by a late winner.
     *  Absent on older records. */
    vouches?: Record<string, SignedEvent>
  }
}

/** One identity-signed structural action (structural.ts's
 *  `StructuralAction`) queued for signing/sending — Task 6's own shape,
 *  landed here per `Persisted.structuralQueue`'s "single envelope" owner
 *  convention (this file's own doc comment). Typed here so Task 5's store
 *  reset can type the field precisely without waiting on Task 6. */
export interface QueuedAction {
  id: string
  action: StructuralAction
  circleId: string
  payload: string
  label: string
  /** `'paused'` (final review, item 1): the person backed out of the
   *  signer's screen — kept, shown as waiting with a Retry, and never
   *  re-sent until they tap it. */
  status: 'waiting' | 'rejected' | 'paused'
  createdAt: number
  attempts: number
  /** The signed event, persisted BEFORE the sender is called (Task 6
   *  review round 1): a send that fails, or a restart between sign and
   *  send, resends this exact event rather than re-signing — the same
   *  inner event id reaches receivers, who dedup by it. */
  signed?: SignedEvent
  /** When the signer was last asked to sign this item (ms) — final fix A7:
   *  no fresh request within `STRUCTURAL_SIGN_TIMEOUT_MS` of it (My Signet
   *  keeps a request that long; a second one would stack a second prompt).
   *  Cleared when the signer answers or the request definitely failed. */
  requestedAt?: number
  /** Final fix A3: the secret a signed `rekey` commits to (`next`) — kept
   *  beside the item, never in `payload`, so it is never sent to the
   *  identity signer. */
  seed?: string
  /** Final fix A2: an `invite`'s recipient identity — wrap addressing only,
   *  never signed into the invite itself. */
  recipientPk?: string
  /** Final fix round 4: the signed-in identity that enqueued the item —
   *  a sender applies locally after its send only if the session is still
   *  that identity (`stillEnqueuingSession`). */
  identityPk?: string
}

/** See `Persisted.placeEval`'s own doc comment. Typed here per this file's
 *  own convention (`SafetyEvent`/`Place`/`ActivityEvent` above are the same
 *  split — the owning module, places.ts, imports this as a type). */
export interface PersistedPlaceEval {
  phase: 'grace' | 'escalated'
  placeName: string
  graceEndsAt?: number
  /** `phase: 'escalated'` only (final-review C1 fix) — whether this
   *  episode's breach signal has actually reached the wire yet. A cold
   *  launch can reach 'escalated' (via a hydrated, already-expired grace
   *  deadline) before any geolocation fix exists, in which case this stays
   *  false until a later tick's retry succeeds — see places.ts's
   *  `ensureBreachSent`/`tick`. Missing/old-format records coerce to false
   *  (places.ts's `hydratePlaceEvalState`) — the safe default: at worst one
   *  harmless extra retry, itself guarded by `placeLastEscalatedAt`'s own
   *  suppression window; never a dropped signal. */
  breachSent?: boolean
}

/** Shape-only: an object with a numeric `created_at`. */
function isEventLike(v: unknown): v is SignedEvent {
  return !!v && typeof v === 'object' && typeof (v as { created_at?: unknown }).created_at === 'number'
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

const CONTACT_TIERS: readonly Tier[] = ['kin', 'kith', 'ken', 'none']

/** Final review B, finding I2: a `Contact` entry, one record within a
 *  `contactsSnapshot.contacts` array — a malformed entry is dropped, not
 *  cause to reject the whole snapshot (see `isValidContactsSnapshot`). */
function isValidContact(v: unknown): v is Contact {
  if (!isRecord(v)) return false
  if (typeof v.contactId !== 'string' || typeof v.name !== 'string' || typeof v.blocked !== 'boolean') return false
  if (!Array.isArray(v.pks) || !v.pks.every((pk): pk is string => typeof pk === 'string')) return false
  if (v.tier !== undefined && !CONTACT_TIERS.includes(v.tier as Tier)) return false
  return true
}

/** Final review B, finding I2: unlike every other new plan-2 field, the
 *  persisted `contactsSnapshot` used to be accepted on an "is an object"
 *  check alone. A garbage or old-shape blob (`{}`, an array, a future
 *  renamed field) then reaches `ensureSource` and every reader downstream
 *  (`contactTier`, `youContactsView`, `candidates`, `classifyUpdate`,
 *  trust-watch's `handOver`) throws on it — and since `activateGrant`'s own
 *  `maybePushSnapshot` throws too, the grant never runs again with no way to
 *  recover in the UI. Required shape: `status` one of `none`/`connected`/
 *  `disconnected`, `contacts` an array (malformed entries dropped, per
 *  `isValidContact`), `fresh` a boolean, `at` a finite number. `truncated`,
 *  if present, must be a boolean. Anything else: drop the whole snapshot
 *  (`undefined`, same as never having one). */
function isValidContactsSnapshot(v: unknown): v is { status: string; contacts: unknown[]; fresh: boolean; at: number; truncated?: unknown } {
  if (!isRecord(v)) return false
  if (v.status !== 'none' && v.status !== 'connected' && v.status !== 'disconnected') return false
  if (!Array.isArray(v.contacts)) return false
  if (typeof v.fresh !== 'boolean') return false
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return false
  if (v.truncated !== undefined && typeof v.truncated !== 'boolean') return false
  return true
}

function coerceContactsSnapshot(v: unknown): ContactsSnapshot | undefined {
  if (!isValidContactsSnapshot(v)) return undefined
  const snap: ContactsSnapshot = {
    status: v.status as ContactsSnapshot['status'],
    contacts: v.contacts.filter(isValidContact),
    fresh: v.fresh,
    at: v.at,
  }
  if (typeof v.truncated === 'boolean') snap.truncated = v.truncated
  return snap
}

/** A two-level record (`outer -> inner -> T`), keeping only entries `ok` accepts. */
function nested<T>(v: unknown, ok: (x: unknown) => x is T): Record<string, Record<string, T>> {
  if (!isRecord(v)) return {}
  // fromEntries defines own properties, so a `__proto__` key stays data.
  return Object.fromEntries(Object.entries(v).filter((e) => isRecord(e[1])).map(([k, inner]) =>
    [k, Object.fromEntries(Object.entries(inner as Record<string, unknown>).filter((e): e is [string, T] => ok(e[1])))]))
}

function defaults(): Persisted {
  return {
    v: 1, circles: [], settings: {}, safetyEvents: [], agreements: [],
    familyPolicies: {}, approvals: [], activity: [],
    dmThreads: {}, dmLastSeen: {}, circleChats: {}, circleChatLastSeen: {},
    places: {}, placesMeta: {}, placeEval: {}, placeLastEscalatedAt: {}, arrivalWindowMarks: {},
    viewPrefs: {}, meetPoints: {}, meetMeta: {}, pickups: [],
    agreementTravelMode: {}, leaveFired: {}, journeys: {},
    approvedLeaves: {}, leaveAreaPolicy: {},
    mapChecks: { day: '', count: 0, lastAt: 0 },
    independenceLevel: {}, stepUpDismissedUntil: {}, stepUpLastEvaluated: 0,
    stepUpFirstObserved: {}, levelDefaults: {}, pins: {},
    phoneKeys: {}, revokedPhoneKeys: {}, pendingRevocations: {}, pendingStatements: [], seedHashes: {},
    structuralQueue: [], seenPersonalWraps: [], personalWrapRefusals: [],
    seedRecipients: {}, lastRekey: {}, pendingRemovals: {}, pendingRemovalsAt: {}, seenStructural: [], statementPostedAt: {},
    guardianLinks: {}, unlinks: {},
    vouches: {}, circleCreators: {}, unvouchedSince: {}, pendingVouches: {},
    heldConfigs: {},
    heldRekeys: {},
    linkSecrets: {},
    trustPrompts: [],
  }
}

/** Wipes the persisted blob back to defaults and notifies subscribers — a
 *  full local reset (session.ts's `signOut`), not just clearing `session`:
 *  signing out of the identity this device's local data was kept under
 *  drops everything kept under it, not only the session pointer. */
export function clear(): void {
  save(defaults())
  notify()
}

/** Reads the persisted blob, coercing anything malformed back to defaults.
 *  Never throws — a corrupt or foreign-shaped blob is treated as empty.
 *  Also treats the WHOLE blob as unreadable — clearing it, same as a
 *  corrupt blob — if it's the old pre-Task-5 shape (an `identity` object
 *  carrying its own `skHex`, a raw secret key kept in the clear): see this
 *  file's own module doc comment for why that's a hard clear, not a
 *  partial coercion. */
export function load(): Persisted {
  let raw: string | null
  try {
    raw = localStorage.getItem(KEY)
  } catch {
    return defaults()
  }
  if (!raw) return defaults()
  try {
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || (parsed as { v?: unknown }).v !== 1) return defaults()
    const rawIdentity = (parsed as { identity?: unknown }).identity
    if (rawIdentity && typeof rawIdentity === 'object' && typeof (rawIdentity as { skHex?: unknown }).skHex === 'string') {
      try { localStorage.removeItem(KEY) } catch { /* ignore */ }
      return defaults()
    }
    const p = parsed as Partial<Persisted>
    return {
      v: 1,
      circles: Array.isArray(p.circles) ? (p.circles as Circle[]) : [],
      settings: p.settings && typeof p.settings === 'object' ? p.settings : {},
      safetyEvents: Array.isArray(p.safetyEvents) ? (p.safetyEvents as SafetyEvent[]) : [],
      agreements: Array.isArray(p.agreements) ? (p.agreements as AgreementRecord[]) : [],
      familyPolicies: p.familyPolicies && typeof p.familyPolicies === 'object' ? (p.familyPolicies as Record<string, FamilyPolicy>) : {},
      approvals: Array.isArray(p.approvals) ? (p.approvals as PendingApprovalRecord[]) : [],
      activity: Array.isArray(p.activity) ? (p.activity as ActivityEvent[]) : [],
      dmThreads: p.dmThreads && typeof p.dmThreads === 'object' ? (p.dmThreads as Record<string, ChatMessage[]>) : {},
      dmLastSeen: p.dmLastSeen && typeof p.dmLastSeen === 'object' ? (p.dmLastSeen as Record<string, number>) : {},
      circleChats: p.circleChats && typeof p.circleChats === 'object' ? (p.circleChats as Record<string, ChatMessage[]>) : {},
      circleChatLastSeen: p.circleChatLastSeen && typeof p.circleChatLastSeen === 'object' ? (p.circleChatLastSeen as Record<string, number>) : {},
      places: p.places && typeof p.places === 'object' ? (p.places as Record<string, Place[]>) : {},
      placesMeta: p.placesMeta && typeof p.placesMeta === 'object' ? (p.placesMeta as Record<string, { updatedAt: number; by: string }>) : {},
      placeEval: p.placeEval && typeof p.placeEval === 'object' ? (p.placeEval as Record<string, PersistedPlaceEval>) : {},
      placeLastEscalatedAt: p.placeLastEscalatedAt && typeof p.placeLastEscalatedAt === 'object' ? (p.placeLastEscalatedAt as Record<string, number>) : {},
      arrivalWindowMarks: p.arrivalWindowMarks && typeof p.arrivalWindowMarks === 'object' ? (p.arrivalWindowMarks as Record<string, { day: string; met?: true; reminded?: true; fired?: true }>) : {},
      viewPrefs: p.viewPrefs && typeof p.viewPrefs === 'object' ? (p.viewPrefs as Record<string, { mutedUntil?: number; pinned?: true }>) : {},
      meetPoints: p.meetPoints && typeof p.meetPoints === 'object' ? (p.meetPoints as Record<string, MeetPoint[]>) : {},
      meetMeta: p.meetMeta && typeof p.meetMeta === 'object' ? (p.meetMeta as Record<string, { updatedAt: number; by: string }>) : {},
      pickups: Array.isArray(p.pickups) ? (p.pickups as PickupRecord[]) : [],
      agreementTravelMode: p.agreementTravelMode && typeof p.agreementTravelMode === 'object' ? (p.agreementTravelMode as Record<string, TravelMode>) : {},
      leaveFired: p.leaveFired && typeof p.leaveFired === 'object' ? (p.leaveFired as Record<string, true>) : {},
      journeys: p.journeys && typeof p.journeys === 'object' ? (p.journeys as Record<string, Journey>) : {},
      approvedLeaves: p.approvedLeaves && typeof p.approvedLeaves === 'object' ? (p.approvedLeaves as Record<string, Array<{ placeId: string; until: number }>>) : {},
      leaveAreaPolicy: p.leaveAreaPolicy && typeof p.leaveAreaPolicy === 'object' ? (p.leaveAreaPolicy as Record<string, PolicyVerdict>) : {},
      mapChecks: p.mapChecks && typeof p.mapChecks === 'object' ? (p.mapChecks as Persisted['mapChecks']) : { day: '', count: 0, lastAt: 0 },
      frictionDismissedDay: typeof p.frictionDismissedDay === 'string' ? p.frictionDismissedDay : undefined,
      independenceLevel: p.independenceLevel && typeof p.independenceLevel === 'object' ? (p.independenceLevel as Record<string, 1 | 2 | 3>) : {},
      stepUpDismissedUntil: p.stepUpDismissedUntil && typeof p.stepUpDismissedUntil === 'object' ? (p.stepUpDismissedUntil as Record<string, number>) : {},
      stepUpLastEvaluated: typeof p.stepUpLastEvaluated === 'number' ? p.stepUpLastEvaluated : 0,
      stepUpFirstObserved: p.stepUpFirstObserved && typeof p.stepUpFirstObserved === 'object' ? (p.stepUpFirstObserved as Record<string, number>) : {},
      levelDefaults: p.levelDefaults && typeof p.levelDefaults === 'object' ? (p.levelDefaults as Record<string, { graceMinutes: number }>) : {},
      pins: p.pins && typeof p.pins === 'object' ? (p.pins as Record<string, Pin[]>) : {},
      session: p.session && typeof p.session === 'object' ? (p.session as SessionInfo) : undefined,
      phoneKeys: p.phoneKeys && typeof p.phoneKeys === 'object'
        ? (p.phoneKeys as Record<string, Record<string, { memberPk: string; statement: SignedEvent; lastSeen: number }>>)
        : {},
      revokedPhoneKeys: p.revokedPhoneKeys && typeof p.revokedPhoneKeys === 'object' ? (p.revokedPhoneKeys as Record<string, SignedEvent>) : {},
      pendingRevocations: p.pendingRevocations && typeof p.pendingRevocations === 'object'
        ? Object.fromEntries(Object.entries(p.pendingRevocations as Record<string, unknown>).filter((e): e is [string, SignedEvent[]] => Array.isArray(e[1])))
        : {},
      // Entries of an older shape (bare events, no circleId) are dropped.
      pendingStatements: Array.isArray(p.pendingStatements)
        ? (p.pendingStatements as unknown[]).filter((e): e is { circleId: string; event: SignedEvent } =>
            !!e && typeof e === 'object' && typeof (e as { circleId?: unknown }).circleId === 'string'
            && !!(e as { event?: unknown }).event && typeof (e as { event?: unknown }).event === 'object')
        : [],
      seedHashes: p.seedHashes && typeof p.seedHashes === 'object' ? (p.seedHashes as Record<string, string[]>) : {},
      structuralQueue: Array.isArray(p.structuralQueue) ? (p.structuralQueue as QueuedAction[]) : [],
      seenPersonalWraps: Array.isArray(p.seenPersonalWraps) ? (p.seenPersonalWraps as string[]) : [],
      // Compact `key:n` strings; the older `{ id, n }` shape is converted.
      personalWrapRefusals: Array.isArray(p.personalWrapRefusals)
        ? (p.personalWrapRefusals as unknown[]).flatMap((e): string[] => {
            if (typeof e === 'string') return /^[^:]+:\d+$/.test(e) ? [e] : []
            if (!!e && typeof e === 'object' && typeof (e as { id?: unknown }).id === 'string' && typeof (e as { n?: unknown }).n === 'number') {
              return [`${(e as { id: string }).id.slice(0, 16)}:${(e as { n: number }).n}`]
            }
            return []
          })
        : [],
      seedRecipients: p.seedRecipients && typeof p.seedRecipients === 'object' ? (p.seedRecipients as Record<string, string[]>) : {},
      // Entries of an older shape (no `before`/`mine`/`createdAt`/
      // `appliedAt`/`signerPk`) are dropped: a late winner can't be judged
      // against them.
      lastRekey: p.lastRekey && typeof p.lastRekey === 'object'
        ? Object.fromEntries(Object.entries(p.lastRekey as Record<string, unknown>).filter((e): e is [string, LastRekey] => {
            const v = e[1] as Partial<LastRekey> | null
            return !!v && typeof v === 'object' && typeof v.prev === 'string' && typeof v.id === 'string' && typeof v.signerPk === 'string'
              && Array.isArray(v.removals) && Array.isArray(v.seedRecipients) && typeof v.mine === 'boolean'
              && typeof v.createdAt === 'number' && typeof v.appliedAt === 'number'
              && !!v.before && typeof v.before === 'object' && Array.isArray(v.before.removedPks)
              && Array.isArray(v.before.members) && !!v.before.phones && typeof v.before.phones === 'object'
              && !!v.before.removals && typeof v.before.removals === 'object'
          }))
        : {},
      pendingRemovals: p.pendingRemovals && typeof p.pendingRemovals === 'object' ? (p.pendingRemovals as Record<string, string[]>) : {},
      pendingRemovalsAt: p.pendingRemovalsAt && typeof p.pendingRemovalsAt === 'object'
        ? Object.fromEntries(Object.entries(p.pendingRemovalsAt as Record<string, unknown>).filter((e): e is [string, Record<string, number>] => {
            const v = e[1] as Record<string, unknown> | null
            return !!v && typeof v === 'object' && Object.values(v).every((n) => typeof n === 'number')
          }))
        : {},
      seenStructural: Array.isArray(p.seenStructural) ? (p.seenStructural as string[]) : [],
      statementPostedAt: p.statementPostedAt && typeof p.statementPostedAt === 'object' ? (p.statementPostedAt as Record<string, number>) : {},
      contactsPairing: p.contactsPairing,
      contactsSnapshot: coerceContactsSnapshot(p.contactsSnapshot),
      // Entries not shaped like events are dropped; guardian-links.ts re-reads
      // only `created_at` and never trusts these beyond what it verified.
      guardianLinks: p.guardianLinks && typeof p.guardianLinks === 'object'
        ? Object.fromEntries(Object.entries(p.guardianLinks as Record<string, unknown>).filter((e): e is [string, { g: SignedEvent; d: SignedEvent }] => {
            const v = e[1] as { g?: unknown; d?: unknown } | null
            return !!v && typeof v === 'object' && isEventLike(v.g) && isEventLike(v.d)
          }))
        : {},
      unlinks: p.unlinks && typeof p.unlinks === 'object' && !Array.isArray(p.unlinks)
        ? Object.fromEntries(Object.entries(p.unlinks as Record<string, unknown>).filter((e): e is [string, SignedEvent] => isEventLike(e[1])))
        : {},
      // Same rule: malformed entries are dropped, vouches.ts re-verifies the rest.
      vouches: nested(p.vouches, isEventLike),
      circleCreators: isRecord(p.circleCreators)
        ? Object.fromEntries(Object.entries(p.circleCreators).filter((e): e is [string, string] => typeof e[1] === 'string'))
        : {},
      unvouchedSince: nested(p.unvouchedSince, (v): v is number => typeof v === 'number' && Number.isFinite(v)),
      pendingVouches: isRecord(p.pendingVouches)
        ? Object.fromEntries(Object.entries(p.pendingVouches).filter((e) => Array.isArray(e[1]))
            .map(([k, list]) => [k, (list as unknown[]).filter(isEventLike)]))
        : {},
      heldConfigs: isRecord(p.heldConfigs)
        ? Object.fromEntries(Object.entries(p.heldConfigs).filter((e): e is [string, SignedEvent] => isEventLike(e[1])))
        : {},
      heldRekeys: isRecord(p.heldRekeys)
        ? Object.fromEntries(Object.entries(p.heldRekeys).filter((e): e is [string, SignedEvent] => isEventLike(e[1])))
        : {},
      linkSecrets: isRecord(p.linkSecrets)
        ? Object.fromEntries(Object.entries(p.linkSecrets).filter((e): e is [string, { createdAt: number; used: boolean }] =>
            isRecord(e[1]) && typeof e[1].createdAt === 'number' && Number.isFinite(e[1].createdAt) && typeof e[1].used === 'boolean'))
        : {},
      trustPrompts: Array.isArray(p.trustPrompts)
        ? (p.trustPrompts as unknown[]).filter((e): e is TrustPrompt =>
            !!e && typeof e === 'object' && typeof (e as TrustPrompt).id === 'string'
            && ((e as TrustPrompt).kind === 'absent' || (e as TrustPrompt).kind === 'bulk')
            && Array.isArray((e as TrustPrompt).pks) && (e as TrustPrompt).pks.every((pk) => typeof pk === 'string')
            && typeof (e as TrustPrompt).createdAt === 'number')
        : [],
    }
  } catch {
    return defaults()
  }
}

/** Writes the blob as-is. Swallows quota / private-mode storage errors — a
 *  failed persist should never crash the app; the in-memory state still won. */
export function save(p: Persisted): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(p))
  } catch {
    // ignore
  }
}

const listeners = new Set<() => void>()

/** Subscribes to `update()` calls. Returns an unsubscribe function. */
export function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/** Reads the current state, lets `fn` mutate it in place, persists the
 *  result, then notifies subscribers. */
export function update(fn: (p: Persisted) => void): void {
  const p = load()
  fn(p)
  save(p)
  notify()
}

/** Notifies subscribers without touching persisted state. For callers whose
 *  change lives in ephemeral, non-persisted module state (e.g. contacts.ts's
 *  in-flight pairing session) but still needs the render-on-state loop to
 *  pick it up. */
export function notify(): void {
  for (const l of listeners) l()
}
