// Beacons: this device's periodic coarse location, broadcast to every circle
// it belongs to, plus the receive side that turns other members' beacons into
// live positions for the Map tab. Same render-on-state idiom as circles.ts:
// `ensure()` is the one side-effecting entry point (geo watch, per-circle
// emit timers, per-circle inbox subscriptions), called from app.ts's render()
// whenever there's a signed-in identity, regardless of active tab — a beacon
// keeps ticking, and an inbound one keeps arriving, whichever screen is open.
//
// Safety-path discipline (global-constraints.md: "the safety path is never
// gated"): emission depends only on there being a fix and a circle to send
// to — never on approvals, family policy, or connectivity. Offline publishes
// fail over to the outbox instead of being dropped, flushed on the next
// `online` event and once at app start.
//
// Wire shape (gift-wrap-everything, global-constraints.md): the vendored
// flock `signals.ts` builder + canary-kit produce the INNER kind-20078 signal
// event — its own AES-GCM layer, keyed off the circle's seed, byte-identical
// to flock's beacon wire format. roost-kit's `giftWrap` then wraps THAT as
// the OUTER kind-1059 event addressed to the circle's shared inbox
// (`deriveInbox(circle.seedHex)`) — a routine beacon gets the same
// metadata-hiding envelope as every other kindependence payload. Flock itself
// gift-wraps its kind-20078 signals exactly the same way (its own NIP-59
// layer around the same inner shape) — this isn't kindependence doing anything
// flock doesn't; it's the same envelope discipline on both sides of the
// wire, which is what keeps the two interoperable.

import * as store from './store.js'
import type { ScheduleRule } from './store.js'
import { appRelays, knownSeedHashes, sendRekey, phoneHoldsSeed, notePhoneHoldsSeed, rerunParkedRekeys, trustViewFor, judgeConfig, acceptVouch, rememberConfig } from './circles.js'
import { currentSession, phoneSigner } from './session.js'
import { doSignOut } from './signin.js'
import { acceptStatement, acceptRevocation, memberForPhone, touch, promoteParkedRevocations } from './phone-keys.js'
import { verifyRevocation, verifyLinkStatement } from './device-statements.js'
import { acceptLinkPair, acceptUnlink, linked } from './guardian-links.js'
import { pendingVouchesFor } from './vouches.js'
import { verifyStructural, STRUCTURAL_ACTIONS, type StructuralEvent } from './structural.js'
import { structuralAuthorised, parseConfigV2 } from './authority.js'
import * as activity from './activity.js'
import * as mapinfo from './mapinfo.js'
import * as poolHealth from './pool-health.js'
import { watchLocation, type Fix } from './geo.js'
import { deriveInbox, toHex, isGuardian } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import {
  giftWrap,
  giftUnwrap,
  rawNip44Decrypt,
  publishSigned,
  subscribeGiftWraps,
  createOutbox,
} from '@forgesworn/roost-kit'
import type { OutboxItem, OutboxStore, Rumor, SignedEvent, Signer } from '@forgesworn/roost-kit'
import { mergePrecision } from './brood/index.js'
import type { Agreement } from './brood/index.js'
import { decideEmission } from '@forgesworn/flock/policy'
import { buildLocationSignal, SIGNAL_TYPES } from '@forgesworn/flock/signals'
import { haversineMetres } from '@forgesworn/flock/geofence'
import { encode as encodeGeohash } from 'geohash-kit'
import { deriveBeaconKey, decryptBeacon } from 'canary-kit'
import { KINDS } from 'canary-kit/nostr'

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** `publishSigned`'s signed-event param carries an index signature (so it
 *  works with any nostr-tools event shape) that roost-kit's own `SignedEvent`
 *  structurally lacks — same gap circles.ts's `publish()` bridges. */
function publish(relays: readonly string[], signed: SignedEvent): Promise<unknown> {
  return publishSigned(relays, signed as unknown as { id: string; sig: string; [k: string]: unknown })
}

// ---------------------------------------------------------------------------
// Pure helpers — cadence/precision decision. Unit-tested in isolation
// (beacons.test.ts): given an agreement + now + base, what precision does
// this tick disclose at, and how long until the next one.
// ---------------------------------------------------------------------------

// "15s when effective precision ≥9" (task contract) — a check-in/pickup
// window an agreement has raised to near-exact deserves fresher updates than
// routine coarse sharing; below that, 60s is plenty for "still nearby".
const COARSE_TICK_MS = 60_000
const FINE_TICK_MS = 15_000
const FINE_PRECISION_THRESHOLD = 9

// ---------------------------------------------------------------------------
// Movement — stationary vs moving, purely a function of recent fixes
// (`updateMovement`, below). Drives adaptive cadence in `decideCadence`: a
// routine COARSE beacon stretches its tick while the device hasn't moved,
// and snaps back the instant it does. Scoped entirely to the routine tick —
// fine (precision >= FINE_PRECISION_THRESHOLD) and every safety path
// (SOS/help/breach/pickup) build their own precision independently of
// `decideCadence` (see its doc comment) and never see movement mode at all.
// ---------------------------------------------------------------------------

/** Anchor radius, metres (task contract). A fix more than this far from the
 *  anchor set when the device last went stationary (or was first seen)
 *  re-anchors and flips back to 'moving' immediately — no dwell time is
 *  required to LEAVE stationary, only to ENTER it (`STATIONARY_AFTER_SEC`). */
export const STATIONARY_RADIUS_M = 75

/** Dwell time, seconds (task contract). Inside `STATIONARY_RADIUS_M` of the
 *  anchor for at least this long before the device counts as stationary —
 *  a device merely paused at a light shouldn't stretch its beacon cadence
 *  within seconds of slowing down. */
export const STATIONARY_AFTER_SEC = 300

/** The stretched routine tick once stationary (task contract): 5 minutes,
 *  vs. `COARSE_TICK_MS`'s 60s while moving. Never applies to the fine tick —
 *  `decideCadence` checks precision before movement mode. */
export const STATIONARY_TICK_MS = 300_000

/** A fix this imprecise (metres) can't tell moving from stationary apart.
 *  `updateMovement` treats it as junk and leaves movement state untouched in
 *  EITHER direction — never flips mode, never re-anchors, never advances or
 *  resets the dwell clock — rather than risk a bad accuracy reading
 *  stretching cadence prematurely or dropping a dwell period that was
 *  legitimately progressing. */
export const MAX_MOVEMENT_FIX_ACCURACY_M = 100

/** Movement-tracking state — an anchor point plus how long it's held.
 *  `since` means different things per mode: while 'moving', the moment the
 *  anchor was (re-)set; while 'stationary', the moment the dwell period that
 *  earned stationary status started — kept, not advanced, for as long as the
 *  device stays within the radius. */
export interface MovementState {
  mode: 'moving' | 'stationary'
  anchor: { lat: number; lon: number }
  since: number
}

/**
 * Pure movement-state transition, one fix at a time. `nowSecValue` is passed
 * in (never read from the clock here) — same discipline as `decideCadence`,
 * so this is directly unit-testable and deterministic.
 *
 * - No prior state (`prev === null`): initialise 'moving', anchored at this
 *   fix, `since: nowSecValue` — there's nothing better to anchor to on the
 *   very first fix, even a junk-accuracy one.
 * - A junk fix (`accuracy > MAX_MOVEMENT_FIX_ACCURACY_M`) WITH prior state:
 *   return `prev` unchanged.
 * - More than `STATIONARY_RADIUS_M` from `prev.anchor`: 'moving', re-anchored
 *   at this fix, `since: nowSecValue` — leaving the radius resumes movement
 *   instantly regardless of whether `prev` was 'moving' or 'stationary', and
 *   restarts the dwell clock so the next stationary period counts from here.
 * - Within the radius: 'stationary' (anchor and `since` both KEPT from
 *   `prev`, not reset to now) once `nowSecValue - prev.since >=
 *   STATIONARY_AFTER_SEC`, whether `prev` was already stationary or only
 *   just qualifying; otherwise `prev` unchanged.
 */
export function updateMovement(prev: MovementState | null, fix: Fix, nowSecValue: number): MovementState {
  if (fix.accuracy > MAX_MOVEMENT_FIX_ACCURACY_M) {
    return prev ?? { mode: 'moving', anchor: { lat: fix.lat, lon: fix.lon }, since: nowSecValue }
  }
  if (!prev) {
    return { mode: 'moving', anchor: { lat: fix.lat, lon: fix.lon }, since: nowSecValue }
  }
  if (haversineMetres(prev.anchor, { lat: fix.lat, lon: fix.lon }) > STATIONARY_RADIUS_M) {
    return { mode: 'moving', anchor: { lat: fix.lat, lon: fix.lon }, since: nowSecValue }
  }
  if (nowSecValue - prev.since >= STATIONARY_AFTER_SEC) {
    return { mode: 'stationary', anchor: prev.anchor, since: prev.since }
  }
  return prev
}

/**
 * Quiescence-as-stationary: the mode `emitTick` should actually cadence off
 * of RIGHT NOW, which is `updateMovement`'s tracked `movement.mode` UNLESS
 * fixes have simply stopped arriving. `updateMovement` only ever runs when a
 * fix lands — the background watcher (native-geo.ts, 25m `distanceFilter`)
 * goes quiet the instant the device stops, so a dwell that would otherwise
 * flip to 'stationary' is never observed and a routine beacon keeps firing
 * at the moving 60s cadence with an increasingly stale fix, all day, if
 * nothing here accounts for silence itself.
 *
 * Returns 'stationary' when `movement` is already tracked-stationary, OR
 * when `movement` exists and it has been at least `STATIONARY_AFTER_SEC`
 * since `lastFixAtSec` — fix silence this long after a movement-gated
 * watcher means the device stopped (or lost GPS, in which case slowing a
 * STALE re-broadcast to match is more honest anyway, not less). Otherwise
 * 'moving' — including when `movement` is `null` (no fix yet at all) or
 * `lastFixAtSec` is `null` (nothing to measure silence against).
 *
 * Any fresh fix resumes 'moving' immediately via `updateMovement`'s existing
 * re-anchor logic (`applyFix` kicks the emit timers forward on that
 * transition too — see its own doc comment) — the 25m `distanceFilter`
 * guarantees a fix fires on real movement, so quiescence never has to be
 * un-decided once a new fix lands. The fine (>= `FINE_PRECISION_THRESHOLD`)
 * tick is decided by `decideCadence` BEFORE movement mode is even consulted
 * and is never affected by this function either way.
 */
export function movementModeAt(movement: MovementState | null, lastFixAtSec: number | null, nowSecValue: number): 'moving' | 'stationary' {
  if (movement?.mode === 'stationary') return 'stationary'
  if (movement && lastFixAtSec !== null && nowSecValue - lastFixAtSec >= STATIONARY_AFTER_SEC) return 'stationary'
  return 'moving'
}

export interface CadenceDecision {
  /** Geohash precision (1-11), or 0 when there's nothing to disclose. */
  precision: number
  /** Delay in milliseconds before the next tick should fire. */
  intervalMs: number
}

/**
 * Decide this tick's disclosure precision and the delay before the next one.
 * `basePrecision` is FLOCK's own routine-sharing decision (see
 * `basePrecisionFor` below — 6 in the steady state); `agreement` is the
 * pickup-time agreement active for this circle, if any — its schedule can
 * only RAISE precision above the base, never lower it below what FLOCK's own
 * policy already decided (BROOD's `mergePrecision`). Pure and
 * deterministic — `nowSecValue` is passed in, never read from the clock here.
 *
 * `movementMode` (default `'moving'`, so every pre-Task-3 call site/test
 * keeps its original 60s-coarse behaviour unchanged) only ever WIDENS the
 * ROUTINE tick — `'stationary'` stretches it from `COARSE_TICK_MS` to
 * `STATIONARY_TICK_MS`. The fine tick (precision >= FINE_PRECISION_THRESHOLD,
 * e.g. an agreement's pickup window) is decided first and unconditionally
 * overrides movement mode either way — a check-in window never gets slower
 * just because the device hasn't moved.
 */
export function decideCadence(
  basePrecision: number,
  agreement: Agreement | undefined,
  nowSecValue: number,
  movementMode: 'moving' | 'stationary' = 'moving',
): CadenceDecision {
  const precision = mergePrecision(basePrecision, agreement, nowSecValue)
  const routineTickMs = movementMode === 'stationary' ? STATIONARY_TICK_MS : COARSE_TICK_MS
  return { precision, intervalMs: precision >= FINE_PRECISION_THRESHOLD ? FINE_TICK_MS : routineTickMs }
}

/** Neighbourhood — the picker's default, and FLOCK's own
 *  `DEFAULT_PRECISIONS.coarse` (matches the pre-Task-8 hard-coded global). */
export const DEFAULT_BASELINE_PRECISION = 6

/** The You-tab per-circle baseline picker's four choices (task contract):
 *  Town / Neighbourhood (default) / Street / Precise — `mapinfo.precisionTerm`
 *  already has friendly labels for exactly these four values. */
export const BASELINE_PRECISION_OPTIONS = [4, 6, 7, 9] as const

/**
 * FLOCK's own disclosure decision for routine beacon sharing, via the
 * vendored policy engine — 'nightout' mode (symmetric peer sharing, which is
 * what an unconditional circle beacon is), no explicit trigger, not
 * off-grid: the steady state, which `decideEmission` resolves to whatever
 * `baselinePrecision` is passed as its `coarse` override (Task 8, brief
 * §11.1's per-circle baseline — `DEFAULT_BASELINE_PRECISION` when the caller
 * has none), or 0 (nothing to disclose) when there's no fix. Kept as a real
 * call into the policy engine — not a hard-coded constant — so this stays
 * the single source of truth for "is there anything to disclose at all,"
 * while `baselinePrecision` alone decides WHAT level.
 *
 * Deliberately never consulted by SOS/help (`safety.ts`'s
 * `helpLocationFrom`, FLOCK's own `DEFAULT_PRECISIONS.help`), breach
 * (`places.ts`'s `BREACH_PRECISION`), or a pickup answer (`safety.ts`'s
 * `buildPickupAnswerWrap`, FLOCK's own `DEFAULT_PRECISIONS.full`) — every one
 * of those builds its wire event directly at its own fixed precision,
 * entirely independent of this function and of `baselinePrecision`. That is
 * the resolution order's real enforcement mechanism (brief §11.1/§25's
 * "the baseline never caps a safety/agreement escalation"): a per-circle
 * baseline this coarse or this fine can only ever affect ROUTINE cadence
 * (this function, `decideCadence` below, and the agreement-schedule merge
 * `decideCadence` performs) — there is no code path from here to any safety
 * signal's precision for a baseline to cap in the first place.
 *
 * Phase 5 Task 2 (brief §32.4, "scheduled sharing profiles") sits at exactly
 * this same layer, not a new one: a per-circle sharing SCHEDULE
 * (`circleBaselinePrecision`'s own consult of `scheduledPrecision`, below)
 * only ever decides WHAT `baselinePrecision` value gets handed in here in
 * the first place — while one of its rules is active, it stands in for the
 * static per-circle choice; outside every rule's window, the static choice
 * applies exactly as before this task. Either way, the result still only
 * ever reaches this function as a single `baselinePrecision` number, so the
 * full resolution order is unchanged and stays exactly as this comment
 * already describes: safety (never touches any of this) > agreement
 * (`decideCadence`'s `mergePrecision`, which can raise ABOVE whatever this
 * function returns, schedule-adjusted or not, but never lower it) >
 * schedule-or-static-baseline (this function, fed by `circleBaselinePrecision`).
 * A sharing schedule can raise or lower the ROUTINE baseline relative to the
 * static default; it can never cap an agreement's own raise, and — like the
 * static baseline it stands in for — is never consulted by any safety
 * trigger at all.
 */
export function basePrecisionFor(fix: Fix | null, baselinePrecision: number = DEFAULT_BASELINE_PRECISION): number {
  const plan = decideEmission({ mode: 'nightout', position: fix ? { lat: fix.lat, lon: fix.lon } : null }, { coarse: baselinePrecision })
  return plan.action === 'withhold' ? 0 : plan.precision
}

// ---------------------------------------------------------------------------
// Scheduled sharing profiles (Phase 5 Task 2, brief §32.4) — per-circle
// time-windowed precision overrides: "Street with Family, weekday afternoons
// 15:00-18:00." `ScheduleRule` itself is typed in store.ts (this module's
// own convention — see that file's doc comment on the type); everything that
// EVALUATES or EDITS a circle's rule set lives here, alongside the static
// baseline it overrides. `hhmmToSec` below duplicates (rather than imports)
// places.ts's own `parseHHMM` — same strict 24-hour/zero-padded rules, same
// fail-safe-to-null on anything else — purely because places.ts already
// imports THIS module (for `selfFix`/`publishOrEnqueue`/`setSignalHandler`),
// so the reverse import would cycle; same layering constraint that already
// has app.ts duplicate `formatClockTime` rather than share it with widget.ts.
// ---------------------------------------------------------------------------

/** The subset of places.ts's `LocalDay` this module needs — day-of-week +
 *  seconds-of-day. Structurally compatible (not identical: `LocalDay` also
 *  carries a `dayStamp`) so a real `places.localDay(new Date())` can be
 *  passed straight through wherever a `LocalDayLike` is expected without a
 *  cast — this module simply never imports places.ts itself to construct one
 *  (see the section doc comment above on why). */
export interface LocalDayLike { dayOfWeek: number; secOfDay: number }

/** `'HH:MM'` → seconds-of-day, or `null` for anything else — see the section
 *  doc comment above on why this duplicates places.ts's `parseHHMM` rather
 *  than importing it. */
function hhmmToSec(s: string): number | null {
  const m = /^(\d{2}):(\d{2})$/.exec(s)
  if (!m) return null
  const hours = Number(m[1])
  const minutes = Number(m[2])
  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) return null
  return hours * 3600 + minutes * 60
}

/** Whether `rule` is active at `day` — days-of-week plus a `from`/`to`
 *  window, cross-midnight-aware (task contract: UNLIKE places.ts's
 *  `ArrivalWindow`, which rejects a crossing arriveBy+grace combination
 *  outright, a sharing-schedule window like "22:00-02:00" is an entirely
 *  ordinary case here, not a data error to reject).
 *
 *  `from < to` (same-day window): active on a listed weekday, `[from, to)`
 *  — inclusive start, exclusive end.
 *
 *  `from >= to` (crosses midnight): active either LATE on a listed day
 *  (`secOfDay >= from`) or EARLY on the day immediately AFTER a listed day
 *  (`secOfDay < to`, checking YESTERDAY's weekday against `days` — the
 *  window that started the evening before is still open). A day whose
 *  PREVIOUS day isn't listed never matches the early branch, so the window
 *  never spills past the one night it actually covers.
 *
 *  A malformed `from`/`to` (fails `hhmmToSec`), or a zero-width window
 *  (`from === to`), never matches — fails safe, same discipline as
 *  places.ts's `windowAction` on a malformed `arriveBy`. */
function ruleActiveAt(rule: ScheduleRule, day: LocalDayLike): { to: number } | null {
  const from = hhmmToSec(rule.from)
  const to = hhmmToSec(rule.to)
  if (from === null || to === null || from === to) return null
  if (from < to) {
    return rule.days.includes(day.dayOfWeek) && day.secOfDay >= from && day.secOfDay < to ? { to } : null
  }
  const yesterday = (day.dayOfWeek + 6) % 7
  const lateOnListedDay = rule.days.includes(day.dayOfWeek) && day.secOfDay >= from
  const earlyAfterListedDay = rule.days.includes(yesterday) && day.secOfDay < to
  return lateOnListedDay || earlyAfterListedDay ? { to } : null
}

/**
 * The sharing-schedule rule active for a circle right now, or `null` when
 * none of `rules` covers `day` — see `ruleActiveAt` for one rule's own
 * active/inactive matrix. When more than one rule is simultaneously active
 * (overlapping windows), the FINEST (highest) `precision` wins, deterministic
 * (task contract) — a tie keeps whichever tied rule was found FIRST walking
 * `rules` in order (only a strict `>` ever replaces the running winner, so
 * array order alone breaks ties, not e.g. `id` or `until`). `until` is the
 * winning rule's own `to`, in raw seconds-of-day — NOT a countdown — for the
 * mode line's "until HH:MM" clause (app.ts's `circleModeLine` formats it).
 * `undefined`/empty `rules` is always `null`, so a circle with no configured
 * schedules behaves exactly as before this task. Pure — `day` is always
 * caller-supplied, never read from the clock here (same discipline as
 * places.ts's `windowAction`).
 */
export function scheduledPrecision(rules: ScheduleRule[] | undefined, day: LocalDayLike): { precision: number; until: number } | null {
  if (!rules?.length) return null
  let winner: { precision: number; until: number } | null = null
  for (const rule of rules) {
    const active = ruleActiveAt(rule, day)
    if (!active) continue
    if (!winner || rule.precision > winner.precision) winner = { precision: rule.precision, until: active.to }
  }
  return winner
}

/** `new Date()`'s day-of-week + seconds-of-day as a `LocalDayLike` — the ONE
 *  impure default `circleBaselinePrecision`'s optional `localNow` falls back
 *  to when a caller omits it (every pre-Task-2 2-arg call site: `emitTick`
 *  passes it explicitly instead — see below — but app.ts's
 *  `privacySummaryView` still calls with 2 args and gets live-clock schedule
 *  awareness for free). A caller that DOES pass `localNow` explicitly (every
 *  test in this file, `emitTick`, `app.ts`'s `circleModeLine`) gets the fully
 *  pure/deterministic core instead — this function is the only clock read
 *  anywhere in this section. */
function liveLocalDay(): LocalDayLike {
  const d = new Date()
  return { dayOfWeek: d.getDay(), secOfDay: d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds() }
}

/** `circleId`'s persisted STATIC baseline choice (Task 8, brief §11.1 —
 *  Town/Neighbourhood/Street/Precise) as stored in settings, with NO
 *  schedule-rule override applied — `DEFAULT_BASELINE_PRECISION` when this
 *  circle has never had one set. Pure, no clock involved at all (unlike
 *  `circleBaselinePrecision` below, which layers a schedule check on top of
 *  exactly this value).
 *
 *  Extracted as its own seam (Phase 5 Task 2 final-review fix) so the
 *  You-tab baseline PICKER (`app.ts`'s `baselinePickerView`) can highlight
 *  what the user actually chose, even while a `ScheduleRule` is temporarily
 *  overriding it for every OTHER consumer of the baseline (the mode line,
 *  the agreement-schedule sentence, actual beacon emission). Before this
 *  fix, the picker read `circleBaselinePrecision` (the schedule-aware
 *  value) directly, so tapping a chip during an active override window
 *  produced no visible feedback — the newly-active window's precision, not
 *  the tap, decided which chip looked selected. `app.ts` pairs this with a
 *  "Schedule override: <Term> until HH:MM" annotation (via
 *  `scheduledPrecision`, below) whenever the two diverge, rather than
 *  silently hiding the override. */
export function pickerSelectedPrecision(settings: store.Persisted['settings'], circleId: string): number {
  return settings.circleBasePrecision?.[circleId] ?? DEFAULT_BASELINE_PRECISION
}

/** `circleId`'s effective baseline right now: the active sharing-schedule
 *  rule's precision (`scheduledPrecision` above) when one covers `localNow`,
 *  else the persisted STATIC per-circle choice (`pickerSelectedPrecision`,
 *  just above). Pure given `settings`+`localNow` (no store/clock access when
 *  `localNow` is supplied) — see `liveLocalDay`'s own doc comment for the
 *  one impure default that keeps every EXISTING 2-arg call site compiling
 *  and behaving schedule-aware for free. A schedule rule is strictly a
 *  floor-OVERRIDE, not an extra escalation layer — see `basePrecisionFor`'s
 *  doc comment for the full resolution order this sits inside (an agreement
 *  can still raise ABOVE whatever this returns; nothing here ever touches a
 *  safety precision). */
export function circleBaselinePrecision(
  settings: store.Persisted['settings'],
  circleId: string,
  localNow: LocalDayLike = liveLocalDay(),
): number {
  const staticBaseline = pickerSelectedPrecision(settings, circleId)
  const active = scheduledPrecision(settings.sharingSchedules?.[circleId], localNow)
  return active ? active.precision : staticBaseline
}

/** Sets `circleId`'s baseline precision (one of `BASELINE_PRECISION_OPTIONS`)
 *  — the You-tab picker's write side. Takes effect on the NEXT emit tick
 *  (`emitTick` re-reads `store.load()` fresh every tick, same as every other
 *  per-tick setting here), not retroactively. */
export function setCircleBaselinePrecision(circleId: string, precision: number): void {
  store.update((p) => {
    p.settings = { ...p.settings, circleBasePrecision: { ...(p.settings.circleBasePrecision ?? {}), [circleId]: precision } }
  })
}

/** Max sharing-schedule rules per circle (task contract) — mirrors places.ts's
 *  `MAX_WINDOWS_PER_PLACE` idiom. */
export const SCHEDULE_RULE_MAX = 6

/** Max `ScheduleRule.label` length (task contract). */
export const SCHEDULE_LABEL_MAX = 30

/** A fresh schedule-rule id — same "unlinkability handle, not a secret"
 *  idiom as places.ts's `newWindowId`/circles.ts's `newCircleId`. */
export function newScheduleRuleId(): string {
  return toHex(crypto.getRandomValues(new Uint8Array(8)))
}

/** A draft rule as read straight off the You-tab editor's form fields, before
 *  it has an `id` — `validateScheduleRuleDraft`'s and
 *  `addSharingScheduleRule`'s shared input shape. `precision` is a plain
 *  `number` here (an unvalidated `<select>` read), narrowed to
 *  `ScheduleRule`'s `4|6|7|9` union only once validation has passed. */
export interface ScheduleRuleDraft { days: number[]; from: string; to: string; precision: number; label: string }

/**
 * Validates a draft rule before it's added to a circle's schedule — pure, so
 * the You-tab editor's submit handler (app.ts, mirroring places.ts's
 * `submitWindowForm`) can call it directly and unit tests can exercise every
 * rejection path without touching the DOM. `existingCount` is the circle's
 * CURRENT rule count (before this add), checked against `SCHEDULE_RULE_MAX`.
 * Returns a user-facing error string, or `null` when the draft is valid.
 */
export function validateScheduleRuleDraft(existingCount: number, draft: ScheduleRuleDraft): string | null {
  if (existingCount >= SCHEDULE_RULE_MAX) return `Up to ${SCHEDULE_RULE_MAX} sharing schedules per circle.`
  if (!draft.days.length) return 'Choose at least one day.'
  if (hhmmToSec(draft.from) === null || hhmmToSec(draft.to) === null) return 'Choose a start and end time.'
  if (!draft.label.trim()) return 'Give this schedule a label.'
  if (draft.label.trim().length > SCHEDULE_LABEL_MAX) return `Label must be ${SCHEDULE_LABEL_MAX} characters or fewer.`
  if (!(BASELINE_PRECISION_OPTIONS as readonly number[]).includes(draft.precision)) return 'Choose a precision.'
  return null
}

/** Adds a validated rule to `circleId`'s schedule — trusts the caller already
 *  ran `validateScheduleRuleDraft` (same "editor validates, write trusts"
 *  split as this module's own `setCircleBaselinePrecision`), but still
 *  defensively caps at `SCHEDULE_RULE_MAX` (belt-and-braces, mirrors
 *  places.ts's `addArrivalWindow`) rather than trusting that alone. Takes
 *  effect on the circle's NEXT emit tick, same as every other setting here. */
export function addSharingScheduleRule(circleId: string, draft: ScheduleRuleDraft): void {
  store.update((p) => {
    const existing = p.settings.sharingSchedules?.[circleId] ?? []
    if (existing.length >= SCHEDULE_RULE_MAX) return
    const rule: ScheduleRule = {
      id: newScheduleRuleId(),
      days: [...new Set(draft.days)],
      from: draft.from,
      to: draft.to,
      precision: draft.precision as 4 | 6 | 7 | 9,
      label: draft.label.trim(),
    }
    p.settings = { ...p.settings, sharingSchedules: { ...(p.settings.sharingSchedules ?? {}), [circleId]: [...existing, rule] } }
  })
}

/** Removes one rule from `circleId`'s schedule — the You-tab editor's Remove
 *  button. A no-op if `ruleId` doesn't match anything current (already
 *  removed / stale render). */
export function removeSharingScheduleRule(circleId: string, ruleId: string): void {
  store.update((p) => {
    const existing = p.settings.sharingSchedules?.[circleId] ?? []
    p.settings = { ...p.settings, sharingSchedules: { ...(p.settings.sharingSchedules ?? {}), [circleId]: existing.filter((r) => r.id !== ruleId) } }
  })
}

/**
 * Pure transition detector for the `precision-raised` Activity kind (Task 8
 * deliverable 3): given this tick's baseline and merged (post-agreement-
 * schedule) precision, plus whether the PREVIOUS tick was already raised
 * above baseline, decides both the new `raised` state (for the caller to
 * remember for next tick) and whether THIS tick is the transition worth
 * recording — `justRaised` is true only on the false -> true edge, so a
 * multi-minute stretch of an agreement's schedule holding precision above
 * baseline records exactly once, not once per beacon tick. Dropping back to
 * baseline (or below — never happens, `mergePrecision` is max-only) updates
 * `raised` back to false but is never itself recorded (task contract:
 * "record once per upward transition").
 */
export function precisionRaiseTransition(
  basePrecision: number,
  mergedPrecision: number,
  previouslyRaised: boolean,
): { raised: boolean; justRaised: boolean } {
  const raised = mergedPrecision > basePrecision
  return { raised, justRaised: raised && !previouslyRaised }
}

/**
 * The pickup-time agreement active for a circle right now, or undefined when
 * there isn't one. Wired against real synced state via
 * `setActiveAgreementProvider` (below) — until agreements.ts's `ensure()`
 * registers one, this always returns undefined, exactly the stub's
 * original behaviour, so any caller (or test) that never wires agreements
 * still degrades gracefully.
 */
export function activeAgreementFor(circleId: string): Agreement | undefined {
  if (!activeAgreementProvider) return undefined
  const self = currentSession()
  if (!self) return undefined
  return activeAgreementProvider(circleId, self.identityPk)
}

/** `(circleId, selfPk) -> Agreement | undefined` — agreements.ts's real
 *  lookup: the circle's ACKED, un-arrived agreement tracking `selfPk` as its
 *  `child` (see agreements.ts's own `activeAgreementFor` doc comment). */
export type ActiveAgreementProvider = (circleId: string, selfPk: string) => Agreement | undefined
let activeAgreementProvider: ActiveAgreementProvider | null = null

/** Registers the provider `activeAgreementFor` (above) delegates to.
 *  beacons.ts deliberately does NOT import agreements.ts to get this
 *  directly — agreements.ts already imports beacons.ts (for `selfFix`,
 *  `publishOrEnqueue`, `setSignalHandler`), so the reverse import would be
 *  circular. Same registration-not-import idiom as `setSignalHandler`
 *  below. Pass `null` to unregister (test cleanup only — app code never
 *  needs to). */
export function setActiveAgreementProvider(fn: ActiveAgreementProvider | null): void {
  activeAgreementProvider = fn
}

// ---------------------------------------------------------------------------
// Journey mode (Phase 5 Task 3, brief §32.2) — while a circle has an active
// journey, its ROUTINE emission is floored at `journey.ts`'s
// `JOURNEY_FLOOR_PRECISION` (Street, 7). `journeyFloorProvider` is
// registered, not imported, for the SAME reason `activeAgreementProvider`
// is just above: journey.ts already imports THIS module (for `selfFix`/
// `publishOrEnqueue`/`setJourneyFloorProvider` itself), so the reverse
// import would cycle.
// ---------------------------------------------------------------------------

/** `(circleId) -> floorPrecision | undefined` — journey.ts's real lookup:
 *  `undefined` when `circleId` has no active journey right now. */
export type JourneyFloorProvider = (circleId: string) => number | undefined
let journeyFloorProvider: JourneyFloorProvider | null = null

/** Registers the provider `emitTick` consults for a circle's journey floor.
 *  Pass `null` to unregister (test cleanup only — app code never needs to). */
export function setJourneyFloorProvider(fn: JourneyFloorProvider | null): void {
  journeyFloorProvider = fn
}

/** `circleId`'s current journey floor, delegating to the registered
 *  provider — `undefined` when no provider is registered (the stub's
 *  original behaviour, before journey.ts's `ensure()` wires one up) or the
 *  provider itself reports no active journey. Exported for direct unit
 *  testing, same "registration is directly testable" convention as
 *  `activeAgreementFor` just above. */
export function journeyFloorFor(circleId: string): number | undefined {
  return journeyFloorProvider ? journeyFloorProvider(circleId) : undefined
}

/**
 * Folds an active journey's ROUTINE emission floor into `baseline` — the
 * SAME merge point `circleBaselinePrecision` itself sits at (see that
 * function's own doc comment for the full resolution order this is one more
 * layer of): max-only, exactly like a sharing-schedule rule overriding the
 * static baseline, never a cap. `journeyFloor` is `undefined` when no
 * journey is active for this circle (`journeyFloorFor` above). Order,
 * documented per the task contract: `max(static-or-schedule, journey
 * floor)`, THEN `decideCadence`'s own `mergePrecision` (an active
 * agreement raising above whatever this returns) — so a journey floor can
 * raise a coarse baseline but can never lower an agreement's own Precise
 * raise (that merge happens strictly AFTER this one, and is itself
 * max-only). Structurally never reaches any safety trigger (SOS/help/
 * breach/pickup answer) — every one of those builds its own precision
 * directly, entirely independent of `circleBaselinePrecision`/this
 * function/`basePrecisionFor`, exactly as `basePrecisionFor`'s own doc
 * comment already documents for the schedule-or-static baseline this floors.
 */
export function applyJourneyFloor(baseline: number, journeyFloor: number | undefined): number {
  return journeyFloor !== undefined && journeyFloor > baseline ? journeyFloor : baseline
}

// ---------------------------------------------------------------------------
// Member positions — ephemeral (not persisted; a stale fix is worse than no
// fix, so there's nothing worth surviving a reload for). Same idiom as
// circles.ts's `pendingInvite`: module-level state, `store.notify()` to
// trigger a re-render.
// ---------------------------------------------------------------------------

export interface MemberPosition { geohash: string; precision: number; at: number }

const positions = new Map<string, Map<string, MemberPosition>>() // circleId -> pubkey -> position

/** Live positions for every member of `circleId` we've heard a beacon from
 *  (never includes ourselves — we don't send beacons to our own inbox). */
export function memberPositions(circleId: string): ReadonlyMap<string, MemberPosition> {
  return positions.get(circleId) ?? new Map()
}

/** One member's position, merged across every circle passed to
 *  `mergeMemberPositions` that they have a live beacon in — see that
 *  function's doc comment. */
export interface MergedPersonPosition {
  pubkey: string
  pos: MemberPosition
  /** Every circle (of the ones passed in) this pubkey has a live position
   *  in — not necessarily every circle they're a member of (a circle they
   *  belong to but haven't beaconed into recently just isn't in here). */
  circleIds: string[]
}

/**
 * Merge a member's position across every one of `circles` they have a live
 * beacon in into ONE rendered position — the map's circle multi-selector
 * (brief §6.3) can have several circles visible at once, and the SAME
 * person can be a member of more than one of them; without this, they'd be
 * drawn twice (once per circle, possibly at two different precisions).
 * Picks the HIGHEST-precision beacon among those circles, ties broken by
 * the more recent `at`.
 *
 * Reasoning, per the task contract — brief §6.4's ceiling concern ("must
 * not expose more information than the viewing user is entitled to")
 * DOESN'T apply here, deliberately: §6.4 is about a viewer seeing several
 * circles at once each with a DIFFERENT permitted precision for the SAME
 * person, and warns against leaking the finer one to a circle only
 * entitled to the coarser view. That's not what selecting multiple circles
 * on your OWN map does — `circles` here is never "every circle in the
 * app," it's only ever the circles THIS viewer selected from their OWN
 * membership list (see app.ts's `mapView`), so the viewer already sees
 * every one of these circles' own beacon independently today (just as
 * separate markers). Each position being merged is a disclosure the other
 * device's `basePrecisionFor`/agreement merge already decided, per circle,
 * at SEND time — nothing here asks for or reveals a precision beyond what
 * was already handed to one of the viewer's own circles. Taking the max
 * across circles the viewer is legitimately in just avoids drawing the same
 * person twice on their own map; it never crosses a circle boundary the
 * viewer doesn't already have.
 */
export function mergeMemberPositions(
  circles: readonly { id: string }[],
  positionsFor: (circleId: string) => ReadonlyMap<string, MemberPosition>,
): Map<string, MergedPersonPosition> {
  const merged = new Map<string, MergedPersonPosition>()
  for (const circle of circles) {
    for (const [pk, pos] of positionsFor(circle.id)) {
      const existing = merged.get(pk)
      if (!existing) {
        merged.set(pk, { pubkey: pk, pos, circleIds: [circle.id] })
        continue
      }
      if (!existing.circleIds.includes(circle.id)) existing.circleIds.push(circle.id)
      if (pos.precision > existing.pos.precision || (pos.precision === existing.pos.precision && pos.at > existing.pos.at)) {
        existing.pos = pos
      }
    }
  }
  return merged
}

/** Records/overwrites a member's live position and triggers a re-render.
 *  Exported so safety.ts can feed it a pickup-answer's precise fix (t:
 *  'pickup' shares this module's beacon key/shape but isn't decoded by
 *  `decodeBeaconRumor` — see the receive-dispatch doc comment below) without
 *  duplicating this module's position store.
 *
 *  Newest-wins (flock ff5eead parity): an older / out-of-order position — a
 *  replay, or normal relay late delivery — must not regress a member's live
 *  position on the map. A strictly-older one is dropped; an equal-timestamp
 *  one is the same beacon again (idempotent), so it lands harmlessly. The
 *  timestamps compared are the sealed payload's own (`MemberPosition.at`),
 *  which a replayer can't advance. */
export function upsertPosition(circleId: string, pubkey: string, pos: MemberPosition): void {
  let byMember = positions.get(circleId)
  if (!byMember) { byMember = new Map(); positions.set(circleId, byMember) }
  const held = byMember.get(pubkey)
  if (held && pos.at < held.at) return
  byMember.set(pubkey, pos)
  store.notify()
}

// ---------------------------------------------------------------------------
// Self fix — the ONE geo watch, shared by the emit loop and the map's self
// marker (avoids duplicate permission prompts / redundant GPS polling).
// Coarse (`highAccuracy: false`): a circle beacon is night-out-style routine
// sharing, which never needs GPS-tier accuracy (see geo.ts's `watchLocation`
// doc comment) — Task 15's SOS/pickup triggers get their own fresh
// `currentPosition({ enableHighAccuracy: true })` call at the moment they fire.
// ---------------------------------------------------------------------------

let currentFix: Fix | null = null
let watchStop: (() => void) | null = null

/** This device's own movement state (`updateMovement`, above) — updated by
 *  every fix through `applyFix`, read by `emitTick` to pick routine cadence.
 *  `null` before the first fix, same lifecycle as `currentFix`. */
let movement: MovementState | null = null

/** The last known self fix, or null before the first one arrives / if
 *  geolocation is unavailable. Read by app.ts for the map's self marker. */
export function selfFix(): Fix | null {
  return currentFix
}

/** The shared "a fresh fix arrived" handler — used both by the foreground
 *  watch below and by `feedFix` (Task 9), the seam native-geo.ts's background
 *  watcher feeds into while the app is backgrounded. Same effect either way:
 *  update `currentFix`, re-render, and (only on the very first fix after a
 *  gap) bring every live circle's emit timer forward to now rather than
 *  waiting out whatever cadence tick was already scheduled. */
function applyFix(fix: Fix): void {
  const hadFix = currentFix !== null
  const now = nowSec()
  // Quiescence-aware "as of right now" mode, read BEFORE this fix touches
  // `currentFix`/`movement` — a fresh fix arriving after a long silent gap
  // must trigger the same immediate-emit kick as a TRACKED stationary ->
  // moving transition below, even though `movement.mode` itself was never
  // advanced while no fixes arrived to run `updateMovement` on (see
  // `movementModeAt`'s doc comment). Ordering matters: both reads have to
  // happen against the PREVIOUS fix's `at` and the PREVIOUS movement state.
  const prevMode = movementModeAt(movement, currentFix?.at ?? null, now)
  currentFix = fix
  movement = updateMovement(movement, fix, now)
  const newMode = movement.mode
  store.notify()
  if (!hadFix) {
    for (const id of [...emitTimers.keys()]) scheduleEmit(id, 0)
  } else if (prevMode === 'stationary' && newMode === 'moving') {
    // The stationary -> moving transition, and ONLY that one (the `!hadFix`
    // branch above already covers the very first fix): whatever
    // STATIONARY_TICK_MS-long timer is already scheduled could be minutes
    // away, so bring every live circle's next emit forward to now instead of
    // waiting it out — movement must be visible within seconds. `prevMode`
    // is quiescence-aware, so this also fires resuming from silence alone.
    for (const id of [...emitTimers.keys()]) scheduleEmit(id, 0)
  }
}

function ensureGeoWatch(): void {
  if (watchStop) return
  watchStop = watchLocation(
    applyFix,
    () => { /* best-effort — a denied/unavailable fix just means no beacon goes out this tick */ },
    { highAccuracy: false },
  )
}

/**
 * Feeds a fix from the NATIVE background watcher (native-geo.ts,
 * @capacitor-community/background-geolocation) into the EXACT same pipeline
 * the foreground watch above uses — same `currentFix` update, same
 * `store.notify()`, same "first fix after a gap kicks every circle's emit
 * timer forward" behaviour (Task 9, brief §12/§29). native-geo.ts's watcher
 * is CONTINUOUS (final review M1 correction: the app-visibility-gated
 * version this comment originally described was replaced — see that file's
 * own doc comment) — tied to kindependence's sharing lifecycle, not to
 * foreground/background transitions, so it runs ALONGSIDE the foreground
 * path above whenever both are active. Double-sampling is therefore
 * EXPECTED, not a bug: `applyFix` is idempotent latest-wins regardless of
 * which of the two callers fed it. A no-op on web (nothing calls this there
 * — native-geo.ts itself gates on `isNativePlatform()`).
 */
export function feedFix(fix: Fix): void {
  applyFix(fix)
}

// ---------------------------------------------------------------------------
// Outbox — localStorage-backed queue for beacons whose publish failed
// (offline, all relays unreachable). Flushed on `online` + once at app start.
// ---------------------------------------------------------------------------

const OUTBOX_KEY = 'kindependence.beacons.outbox.v1'

function localStorageOutboxStore(key: string): OutboxStore {
  return {
    load(): OutboxItem[] {
      try {
        const raw = localStorage.getItem(key)
        if (!raw) return []
        const parsed: unknown = JSON.parse(raw)
        return Array.isArray(parsed) ? (parsed as OutboxItem[]) : []
      } catch {
        return []
      }
    },
    save(items: OutboxItem[]): void {
      try { localStorage.setItem(key, JSON.stringify(items)) } catch { /* quota / private-mode — drop silently */ }
    },
  }
}

let outbox: ReturnType<typeof createOutbox> | null = null
let onlineFlushWired = false

function ensureOutbox(): ReturnType<typeof createOutbox> {
  outbox ??= createOutbox(localStorageOutboxStore(OUTBOX_KEY))
  return outbox
}

type FlushResult = { sent: number; dropped: number; remaining: number }

let flushing: Promise<FlushResult> | null = null
let flushAgain = false

/** Retry every queued beacon; drops any that expired first. Safe to call any
 *  time (empty queue is a no-op).
 *
 *  Final review, item 3: serialised. Two roost-kit `flush`es running at
 *  once each snapshot the queue and write it back when done, so the later
 *  one can drop an item enqueued meanwhile (and both send the same items).
 *  One flush is in flight at a time; a request while it runs makes it run
 *  exactly once more afterwards, and every caller gets the last run's
 *  result. */
export function flushOutbox(): Promise<FlushResult> {
  if (flushing) {
    flushAgain = true
    return flushing
  }
  flushAgain = false
  const run = (async (): Promise<FlushResult> => {
    await null // `flushing` is assigned before the `finally` can clear it
    try {
      for (;;) {
        const result = await ensureOutbox().flush((relays, event) => publish(relays, event), nowSec())
        if (!flushAgain) return result
        flushAgain = false
      }
    } finally {
      flushing = null
    }
  })()
  flushing = run
  return run
}

function ensureOutboxFlush(): void {
  ensureOutbox()
  if (onlineFlushWired) return
  onlineFlushWired = true
  if (typeof window !== 'undefined') window.addEventListener('online', () => { void flushOutbox() })
  void flushOutbox() // app start
}

// ---------------------------------------------------------------------------
// Emit — build + send a beacon for one circle, self-rescheduling per the
// cadence decision above (same "sample, then self-schedule" idiom as geo.ts's
// pollLocation).
// ---------------------------------------------------------------------------

/** Build the gift-wrapped beacon event for one circle at a given fix +
 *  precision. Pure apart from the two crypto calls (canary-kit's AES-GCM via
 *  the vendored signals builder, then roost's NIP-59 wrap) — no store/network
 *  access — so it's directly unit-testable against `decodeBeaconRumor`,
 *  proving the round trip end to end without a relay. */
export async function buildBeaconWrap(signer: Signer, circle: Circle, fix: Fix, precision: number): Promise<SignedEvent> {
  const geohash = encodeGeohash(fix.lat, fix.lon, precision)
  const inner = await buildLocationSignal({
    groupId: circle.id,
    seedHex: circle.seedHex,
    signalType: SIGNAL_TYPES.beacon,
    geohash,
    precision,
  })
  const inbox = deriveInbox(circle.seedHex)
  return giftWrap(signer, inbox.pk, inner, inbox.pk)
}

/** Publish a signed, gift-wrapped event, falling back to the shared outbox on
 *  any failure — the one "never drop a safety-path event" primitive EVERY
 *  publishing module in this app goes through (this module's own beacons,
 *  and agreements/approvals/battery/journey/meet/messages/pickup/pins/
 *  places/safety's sends), so ALL of it retries from the same queue on the
 *  next `online` event or app start. Never rejects: a caller can
 *  fire-and-forget this without its own try/catch.
 *
 *  Final-review fix, Important #1(b): a SUCCESSFUL publish also notes
 *  pool-health.ts's shared liveness clock (`notePoolActivity`) — this being
 *  the one seam every publishing module shares is exactly why it's the right
 *  place for this, rather than repeating the call at each of those call
 *  sites. A failed publish (falls to the outbox below) proves nothing about
 *  the pool being alive, so it deliberately does NOT note activity. */
export async function publishOrEnqueue(relays: readonly string[], signed: SignedEvent): Promise<void> {
  try {
    await publish(relays, signed)
    poolHealth.notePoolActivity()
  } catch {
    ensureOutbox().enqueue(signed, relays, nowSec())
  }
}

async function emitBeacon(relays: string[], signer: Signer, circle: Circle, fix: Fix, precision: number): Promise<void> {
  const wrap = await buildBeaconWrap(signer, circle, fix, precision)
  await publishOrEnqueue(relays, wrap)
}

const emitTimers = new Map<string, ReturnType<typeof setTimeout>>()

/** Per-circle "was the last tick's disclosure raised above baseline"
 *  memory for the `precision-raised` Activity kind (Task 8 deliverable 3) —
 *  see `precisionRaiseTransition`'s doc comment. Ephemeral like every other
 *  map in this section: a reload just means the next tick re-derives it
 *  (worst case, one skipped/duplicate transition record around a reload,
 *  same trade-off `emitTimers`/`positions` already accept). */
const raisedPrecisionState = new Map<string, boolean>()

function clearEmitTimer(circleId: string): void {
  const t = emitTimers.get(circleId)
  if (t !== undefined) { clearTimeout(t); emitTimers.delete(circleId) }
  raisedPrecisionState.delete(circleId)
}

function scheduleEmit(circleId: string, delayMs: number): void {
  clearEmitTimer(circleId)
  emitTimers.set(circleId, setTimeout(() => { void emitTick(circleId) }, delayMs))
}

async function emitTick(circleId: string): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle) { emitTimers.delete(circleId); raisedPrecisionState.delete(circleId); return } // signed out / circle gone — ensure() restarts this if it reappears

  const now = nowSec()
  const scheduleBaseline = circleBaselinePrecision(p.settings, circleId, liveLocalDay())
  const baseline = applyJourneyFloor(scheduleBaseline, journeyFloorFor(circleId))
  const basePrecision = basePrecisionFor(currentFix, baseline)
  const agreement = activeAgreementFor(circleId)
  const { precision, intervalMs } = decideCadence(basePrecision, agreement, now, movementModeAt(movement, currentFix?.at ?? null, now))

  // Task 8 deliverable 3: record once per upward transition (per circle)
  // when the agreement schedule raises emitted precision above this
  // circle's baseline — not on every tick it stays raised, and not for the
  // (structurally separate) safety triggers, which never reach this
  // function at all (see `basePrecisionFor`'s doc comment).
  const { raised, justRaised } = precisionRaiseTransition(basePrecision, precision, raisedPrecisionState.get(circleId) ?? false)
  raisedPrecisionState.set(circleId, raised)
  if (justRaised) {
    activity.recordActivity({
      id: activity.localActivityId('precision-raised', now, circleId),
      at: now, kind: 'precision-raised', circleId, actorPk: self.identityPk,
      params: { term: mapinfo.precisionTerm(precision) },
    })
  }

  if (currentFix && precision > 0) {
    void emitBeacon(appRelays(p), phoneSigner(), circle, currentFix, precision)
  }
  scheduleEmit(circleId, intervalMs)
}

// ---------------------------------------------------------------------------
// Receive — subscribe to each circle's shared inbox, unwrap, decrypt, and
// record the sender's position.
// ---------------------------------------------------------------------------

const inboxUnsubscribes = new Map<string, () => void>()
const inboxKeys = new Map<string, string>() // circleId -> `gen:${gen}:${inboxPk}@${relays.join(',')}` (re-subscribe on reseed/relay change OR a pool-health generation bump — see ensureReceive)

/**
 * Decode an already-unwrapped rumor into a member position, or null if it
 * isn't a routine beacon, or fails to decrypt/validate. Only `t: 'beacon'` is
 * this task's concern: breach/pickup (Task 15) share the shape but a
 * different `t`, help uses an entirely different key (duress, not beacon),
 * and `cover` is meaningless filler flock itself drops unconditionally — all
 * silently ignored here, forward-compatible with later tasks adding their
 * own handlers for the rest.
 *
 * Pure apart from the `decryptBeacon` call — no store/network access — so
 * it's directly unit-testable against a real `buildBeaconWrap` + `giftUnwrap`
 * round trip.
 */
export async function decodeBeaconRumor(rumor: Rumor, circleSeedHex: string): Promise<MemberPosition | null> {
  if (rumor.kind !== KINDS.signal) return null
  const t = rumor.tags.find((tag) => tag[0] === 't')?.[1]
  if (t !== SIGNAL_TYPES.beacon) return null
  try {
    const payload = await decryptBeacon(deriveBeaconKey(circleSeedHex), rumor.content)
    return { geohash: payload.geohash, precision: payload.precision, at: payload.timestamp }
  } catch {
    // undecryptable / malformed — silently drop, same discipline as the emit
    // side's best-effort outbox fallback: a bad payload must never crash the
    // receive loop for every other member's beacon.
    return null
  }
}

/**
 * Circle-inbox traffic this module doesn't itself decode — anything but a
 * plain `t:'beacon'` (help/checkin/pickup/pickup-req, brood's
 * agreement/agreement-ack/agreement-status/extend-req/extend-resp, and any
 * future type). safety.ts (Task 15) and agreements.ts (Task 16) each
 * register their own handler here (from their own `ensure()`, mirroring this
 * module's `ensure()` idiom) rather than opening a second gift-wrap
 * subscription on the same circle inbox — there's exactly one inbound stream
 * per circle, and this is its single dispatch point. Every registered
 * handler runs for every non-beacon signal; each is expected to check `t`
 * against its own vocabulary and no-op otherwise — safety.ts's wire types
 * (`t:'help'` from `@forgesworn/flock/signals`'s `SIGNAL_TYPES`, `t:'buzz'`
 * from `@forgesworn/flock/buzz`'s `BUZZ_SIGNAL_TYPE`, `t:'findreq'` from
 * `@forgesworn/flock/findping`'s `FIND_PING_SIGNAL_TYPE`) and BROOD's
 * `BroodType` are disjoint namespaces (see BROOD.md §2), so there is no
 * dispatch ambiguity between them. Left empty, unknown traffic is silently
 * ignored (same discipline as an unrecognised `t` at any other layer here).
 *
 * Signet identity plan (Task 8): every handler also gets the resolved
 * `sender` — `signerPk` the phone key that sealed the wrap, `memberPk` the
 * identity it speaks for (from the phone-key table, or the inner event's
 * signer for a structural event), `structural` whether the rumor handed over
 * is an identity-signed inner event (then `t` is its action and
 * `rumor.pubkey`/`content`/`tags`/`id` are the inner event's).
 */
export interface Sender { signerPk: string; memberPk: string; structural: boolean }
export type CircleSignalHandler = (circle: Circle, rumor: Rumor, t: string, sender: Sender) => void
const signalHandlers: CircleSignalHandler[] = []

/** Registers a handler for non-beacon circle-inbox signals — appended, not
 *  overwritten (see the doc comment above). Idempotent per function
 *  reference: registering the same handler twice is a no-op, so a module's
 *  `ensure()` can call this on every invocation without accumulating
 *  duplicate handlers. */
export function setSignalHandler(fn: CircleSignalHandler): void {
  if (!signalHandlers.includes(fn)) signalHandlers.push(fn)
}

// Follow-up fix (Task 5 review): an earlier version of this module routed
// circle chat as a bare kind-14 rumor (covey-kit's personal-inbox DM shape)
// addressed to the circle's shared inbox instead of a member's personal one,
// with its own `CIRCLE_DM_RUMOR_KIND`/`setDmHandler` dispatch branch here.
// That was NOT real flock interop, despite the doc comment's claim at the
// time — a bare kind-14 rumor carries no `t` tag at all, and every real
// flock client's circle-inbox dispatcher switches on the `t` tag (see the
// `signalHandlers` doc comment above); a `t`-less rumor simply falls through
// unrecognised and is dropped, silently, by any real flock device. Circle
// chat now rides flock's ACTUAL mechanism instead — an UNTARGETED
// `t:'buzz'` signal whose `reason` IS the message text (messages.ts's own
// module doc comment has the full picture) — which already flows through
// the `signalHandlers` branch below like any other buzz. Nothing circle-
// chat-specific belongs in this file anymore.

// Dedup on the CONTENT-BOUND rumor id (flock 1021d99 parity — roost-kit's
// giftUnwrap now recomputes it from the decrypted content, so it's
// trustworthy): a replay re-wrapped under a fresh ephemeral key carries a
// NEW wrap id but the SAME rumor id, so the pool's wrap-id dedup alone would
// re-deliver a stale signal as current. Per-session by design — after a
// relaunch the relay backfill legitimately repopulates state, and the
// action-bearing paths gate on freshness separately (safety.ts's findreq
// gate, notify.ts's shouldNotifyForEvent, upsertPosition's newest-wins).
const seenRumorIds = new Set<string>()
function markRumorSeen(id: string): void {
  if (seenRumorIds.has(id)) return
  seenRumorIds.add(id)
  if (seenRumorIds.size > 1000) seenRumorIds.delete(seenRumorIds.values().next().value as string)
}

/** Structural events are deduplicated by `<circleId>:<inner id>` in their
 *  own persisted log (`Persisted.seenStructural`): the structural queue
 *  resends the identical signed event inside a fresh rumor, and a replay
 *  after a restart must not re-apply it. */
const SEEN_STRUCTURAL_CAP = 2000
function structuralSeen(key: string): boolean {
  return store.load().seenStructural.includes(key)
}
function markStructuralSeen(key: string): void {
  store.update((p) => {
    if (p.seenStructural.includes(key)) return
    p.seenStructural = [...p.seenStructural, key].slice(-SEEN_STRUCTURAL_CAP)
  })
}

/** Structural rumors whose sealing phone isn't bound in the circle yet (the
 *  statement or the roster change that binds it may still be on its way),
 *  per circle, oldest first, capped. Re-run by `onPhonesBound`. In memory:
 *  after a restart the relay replay re-delivers them. */
const PARK_CAP = 100
const parkedStructural = new Map<string, Rumor[]>()

function parkStructural(circleId: string, rumor: Rumor): void {
  const list = parkedStructural.get(circleId) ?? []
  if (rumor.id && list.some((r) => r.id === rumor.id)) return
  list.push(rumor)
  if (list.length > PARK_CAP) list.shift()
  parkedStructural.set(circleId, list)
}

/** Configs refused only for want of an added member's vouch (Task 5 fix
 *  round 1), per circle, oldest first — a park of their own, so a member
 *  can't flood out events waiting for a phone to bind. Each entry keeps
 *  the pks its config lists, so a stored vouch re-judges only the configs
 *  that add its vouchee (`onVouchStored`); a roster change re-runs them
 *  all (`onPhonesBound`: a pending vouch's voucher may just have joined).
 *  In memory, like the phone park. */
export const VOUCH_PARK_CAP = 20
const vouchParked = new Map<string, Array<{ rumor: Rumor; pks: ReadonlySet<string> }>>()
let vouchParkRejudges = 0

function parkNeedsVouch(circleId: string, rumor: Rumor, payload: string): void {
  const list = vouchParked.get(circleId) ?? []
  if (rumor.id && list.some((e) => e.rumor.id === rumor.id)) return
  const cfg = parseConfigV2(payload)
  list.push({ rumor, pks: new Set(cfg?.members.map((m) => m.pk) ?? []) })
  if (list.length > VOUCH_PARK_CAP) list.shift()
  vouchParked.set(circleId, list)
}

/** Re-judges the vouch-parked configs of `circleId` that `pick` selects. */
function rerunVouchParked(circleId: string, pick: (pks: ReadonlySet<string>) => boolean): void {
  const list = vouchParked.get(circleId)
  if (!list?.length) return
  const now = list.filter((e) => pick(e.pks))
  if (!now.length) return
  vouchParked.set(circleId, list.filter((e) => !pick(e.pks)))
  for (const { rumor } of now) {
    const circle = store.load().circles.find((c) => c.id === circleId)
    if (!circle) break
    vouchParkRejudges++
    if (receiveStructural(circle, rumor, nowSec()) !== 'parked' && rumor.id) markRumorSeen(`${circleId}:${rumor.id}`)
  }
}

/** Called when a vouch for `voucheePk` is stored in `circleId`: re-tries
 *  the link pairs held for that vouchee (fix round 1), then re-judges only
 *  the parked configs that list them. */
export function onVouchStored(circleId: string, voucheePk: string): void {
  rerunHeldLinks(circleId, (dep) => dep === voucheePk)
  rerunVouchParked(circleId, (pks) => pks.has(voucheePk))
}

/** Test seams: the vouch park's size, and how many re-judgements it has run. */
export function vouchParkSizeForTests(circleId: string): number {
  return vouchParked.get(circleId)?.length ?? 0
}
export function vouchParkRejudgesForTests(): number {
  return vouchParkRejudges
}

/** Test seam: forgets every rumor this module has seen or parked (the
 *  persisted structural log lives in the store). */
export function resetReceiveForTests(): void {
  seenRumorIds.clear()
  parkedStructural.clear()
  vouchParked.clear()
  linkHeld.clear()
}

/** Rumor `t` values of the identity layer (Signet identity plan, Tasks 7-8). */
export const DEVICE_SIGNAL_TYPE = 'device'
export const REVOKE_SIGNAL_TYPE = 'revoke'
export const STRUCT_SIGNAL_TYPE = 'struct'
/** Plan 2, Task 5: a signed vouch (an `invite` naming its invitee, or a
 *  hand-over `vouch`) posted into the circle by a bound phone. Not `'vouch'`:
 *  that is a structural action, which a phone key may never send. */
export const VOUCH_POST_SIGNAL_TYPE = 'vouch-post'
/** Plan 2, Task 5: guardian-link statements (`{ g, d }`) or an unlink
 *  (`{ unlink }`) posted into the circle by a bound phone. */
export const LINK_SIGNAL_TYPE = 'link'
/** How far ahead of our clock a posted link statement may be dated. */
export const LINK_MAX_SKEW_SEC = 600

function parseJson(s: string): unknown {
  try { return JSON.parse(s) } catch { return null }
}

type Outcome = 'done' | 'parked'

/**
 * The receive choke point for circle-inbox traffic (Signet identity plan,
 * Task 8; spec §4). After unwrap and dedup:
 *  1. `t:'device'` → a device statement for the phone that sealed it
 *     (phone-keys.ts `acceptStatement`, proof of possession: the sealer
 *     must be the phone the statement names). `t:'revoke'` → a revocation;
 *     newly applied to a phone that holds a circle's current seed, it
 *     re-keys that circle (guardian-role devices only).
 *  2. Traffic sealed by THIS phone is our own echo and is skipped (traffic
 *     from this identity's other phones still applies).
 *  3. `t:'struct'` → an identity-signed inner event (structural.ts), checked
 *     by `receiveStructural` below and dispatched as the inner event.
 *  4. Anything else must be sealed by a phone key the circle's table maps to
 *     a member, and must not be a structural action sent phone-signed.
 * A rumor id is marked seen only once the rumor is handled or definitively
 * rejected — a parked one must stay deliverable. Exported for direct unit
 * testing; production callers reach it only through `ensureReceive`.
 */
export async function onCircleInboxWrap(
  circleId: string,
  inboxSk: Uint8Array,
  e: { pubkey: string; content: string; tags: string[][] },
): Promise<void> {
  poolHealth.notePoolActivity() // the relay just delivered something → the shared pool is alive (even a dup/undecryptable wrap counts — see pool-health.ts)
  const rumor = await giftUnwrap(rawNip44Decrypt(inboxSk), e)
  if (!rumor) return
  const key = rumor.id ? `${circleId}:${rumor.id}` : null
  if (key && seenRumorIds.has(key)) return
  const outcome = await handleCircleRumor(circleId, rumor)
  if (key && outcome !== 'parked') markRumorSeen(key)
}

async function handleCircleRumor(circleId: string, rumor: Rumor): Promise<Outcome> {
  const p = store.load()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!circle || rumor.kind !== KINDS.signal) return 'done'
  const t = rumor.tags.find((tag) => tag[0] === 't')?.[1]
  if (!t) return 'done'
  const now = nowSec()
  // `rumor.pubkey` is the seal signer: roost's giftUnwrap has verified the
  // seal and bound the rumor author to it.
  if (t === DEVICE_SIGNAL_TYPE) {
    if (acceptStatement(circle, parseJson(rumor.content), rumor.pubkey, now) === 'added') {
      // Posting on this inbox proves the phone holds the current seed.
      notePhoneHoldsSeed(circle.id, rumor.pubkey)
      onPhonesBound(circle.id)
    }
    return 'done'
  }
  if (t === REVOKE_SIGNAL_TYPE) {
    // Awaited (Task 12 fix round 1): `handleCircleRumor` is already async
    // and already awaited by its own caller (`onCircleInboxWrap`, right
    // below) before it marks this rumor seen — a revocation of THIS
    // device's own phone key now runs the hardened sign-out routine
    // in-line (`applyRevocation`'s own doc comment, item 1), and that
    // should finish before this rumor is considered handled, same as every
    // other branch here that has real work to do.
    await applyRevocation(parseJson(rumor.content))
    return 'done'
  }
  const self = currentSession()
  if (self && rumor.pubkey === self.phonePk) return 'done'
  if (t === STRUCT_SIGNAL_TYPE) return receiveStructural(circle, rumor, now)
  const memberPk = memberForPhone(circle.id, rumor.pubkey)
  if (!memberPk) return 'done'
  if (STRUCTURAL_ACTIONS.has(t)) return 'done' // a phone key may never perform a structural action
  touch(circle.id, rumor.pubkey, now)
  if (t === VOUCH_POST_SIGNAL_TYPE) {
    acceptVouch(circle.id, parseJson(rumor.content), now)
    return 'done'
  }
  if (t === LINK_SIGNAL_TYPE) {
    receiveLink(circle, parseJson(rumor.content), now)
    return 'done'
  }
  if (t === SIGNAL_TYPES.beacon) {
    const pos = await decodeBeaconRumor(rumor, circle.seedHex)
    if (pos) upsertPosition(circleId, memberPk, pos)
    return 'done'
  }
  const sender: Sender = { signerPk: rumor.pubkey, memberPk, structural: false }
  for (const handler of signalHandlers) handler(circle, rumor, t, sender)
  return 'done'
}

/** Called whenever a phone may have become bound in `circleId` (a statement
 *  accepted, a roster change rescanned, a re-key applied): re-runs the
 *  structural events and re-keys parked for that circle. */
export function onPhonesBound(circleId: string): void {
  const list = parkedStructural.get(circleId)
  if (list?.length) {
    parkedStructural.delete(circleId)
    for (const rumor of list) {
      const circle = store.load().circles.find((c) => c.id === circleId)
      if (!circle) break
      if (receiveStructural(circle, rumor, nowSec()) !== 'parked' && rumor.id) markRumorSeen(`${circleId}:${rumor.id}`)
    }
  }
  rerunHeldLinks(circleId, () => true)
  rerunVouchParked(circleId, () => true)
  rerunParkedRekeys(circleId)
}

/** A `t:'link'` post (controller ruling R5): a guardian-of/dependant-of
 *  pair or an unlink, accepted (guardian-links.ts) only when both of its
 *  pks are members of this circle and it is dated no more than
 *  `LINK_MAX_SKEW_SEC` ahead of our clock. The caller has checked the
 *  sealing phone is bound.
 *
 *  Plan 2, Task 7: a newly paired dependant isn't a member yet — the config
 *  adding them as `child` waits (`needs-vouch`) until the link is known
 *  here, so a pair whose dependant is not a member is also accepted when
 *  this circle holds a pending `child` vouch for them signed by that pair's
 *  guardian (a member); then the configs parked for them are re-judged.
 *  Fix round 1: such a pair arriving before that vouch is held
 *  (`holdLink`) and re-tried when a vouch for the dependant is stored or
 *  the roster changes. */
function receiveLink(circle: Circle, raw: unknown, now: number): void {
  if (!raw || typeof raw !== 'object') return
  const r = raw as { g?: unknown; d?: unknown; unlink?: unknown }
  if (r.unlink !== undefined) {
    const member = (pk: string): boolean => circle.members.some((m) => m.pk === pk)
    const v = verifyLinkStatement(r.unlink)
    if (v && member(v.signerPk) && member(v.otherPk) && v.createdAt <= now + LINK_MAX_SKEW_SEC) acceptUnlink(r.unlink)
    return
  }
  if (tryLinkPair(circle, r.g, r.d, now) === 'hold') holdLink(circle.id, r.g as SignedEvent, r.d as SignedEvent)
}

/** Judges a `{ g, d }` pair for `circle`: 'done' when accepted or never
 *  acceptable, 'hold' when it is a verified pair whose guardian is a member
 *  and whose dependant is not (yet) placeable — its vouch may be on its
 *  way. */
function tryLinkPair(circle: Circle, g: unknown, d: unknown, now: number): 'done' | 'hold' {
  const member = (pk: string): boolean => circle.members.some((m) => m.pk === pk)
  const vg = verifyLinkStatement(g)
  const vd = verifyLinkStatement(d)
  if (!vg || vg.kind !== 'guardian-of' || !vd || vd.kind !== 'dependant-of') return 'done'
  if (vg.signerPk !== vd.otherPk || vd.signerPk !== vg.otherPk) return 'done'
  if (vg.createdAt > now + LINK_MAX_SKEW_SEC || vd.createdAt > now + LINK_MAX_SKEW_SEC) return 'done'
  const G = vg.signerPk
  const dep = vg.otherPk
  if (!member(G)) return 'done'
  if (member(dep)) { acceptLinkPair(g, d); return 'done' }
  if (!pendingVouchesFor(circle.id, dep).some((v) => v.by === G && v.role === 'child')) return 'hold'
  if (acceptLinkPair(g, d)) rerunVouchParked(circle.id, (pks) => pks.has(dep))
  return 'done'
}

/** Fix round 1: verified link pairs waiting for their dependant's pending
 *  `child` vouch, per circle, oldest first (in memory, like the parks). */
export const LINK_HOLD_CAP = 20
const linkHeld = new Map<string, Array<{ g: SignedEvent; d: SignedEvent; dep: string }>>()

function holdLink(circleId: string, g: SignedEvent, d: SignedEvent): void {
  const list = linkHeld.get(circleId) ?? []
  if (list.some((e) => e.g.id === g.id && e.d.id === d.id)) return
  const dep = verifyLinkStatement(g)?.otherPk
  if (!dep) return
  list.push({ g, d, dep })
  if (list.length > LINK_HOLD_CAP) list.shift()
  linkHeld.set(circleId, list)
}

/** Re-tries the held link pairs of `circleId` whose dependant `pick`
 *  selects; those still not placeable stay held. */
function rerunHeldLinks(circleId: string, pick: (dep: string) => boolean): void {
  const list = linkHeld.get(circleId)
  if (!list?.length) return
  const now = list.filter((e) => pick(e.dep))
  if (!now.length) return
  linkHeld.set(circleId, list.filter((e) => !pick(e.dep)))
  for (const e of now) {
    const circle = store.load().circles.find((c) => c.id === circleId)
    if (!circle) break
    if (tryLinkPair(circle, e.g, e.d, nowSec()) === 'hold') holdLink(circleId, e.g, e.d)
  }
}

/** Test seam: how many link pairs are held for `circleId`. */
export function linkHoldSizeForTests(circleId: string): number {
  return linkHeld.get(circleId)?.length ?? 0
}

/** Rule 3 of the choke point: an identity-signed inner event inside a
 *  phone-sealed rumor. Dropped unless it names this circle, chains to a seed
 *  this circle has had, is signed by a roster member authorised for the
 *  action (authority.ts, against the current roster), and was sealed by a
 *  phone the table maps to some member. A roster member's event whose
 *  sealing phone isn't bound yet is parked (see `onPhonesBound`); a
 *  non-member's is dropped — always, even a config on a bare placeholder
 *  (final fix round 2, R1b; plan 2, Task 5 removed the last first-config
 *  exception — a joiner's roster comes from its invite). A config refused
 *  only for want of an added member's vouch is parked too, and re-run when
 *  a vouch for one of its members is stored (its own capped park,
 *  `parkNeedsVouch`; circles.ts `acceptVouch`). An `invite` arriving here
 *  is a vouch (`acceptVouch`); an authorised hand-over `vouch` is stored
 *  the same way. Re-keys never travel on the circle inbox — every removed
 *  member still holds its key — so one seen here is dropped. */
function receiveStructural(circle: Circle, rumor: Rumor, now: number): Outcome {
  const ev = verifyStructural(parseJson(rumor.content))
  if (!ev || ev.circleId !== circle.id || ev.action === 'rekey') return 'done'
  const dedupKey = `${circle.id}:${ev.event.id}`
  if (structuralSeen(dedupKey)) return 'done'
  if (!knownSeedHashes(circle).includes(ev.prev)) return 'done'
  const sealerBound = !!memberForPhone(circle.id, rumor.pubkey)
  // Only a roster member's event is ever parked, so outsiders can't flood
  // the park.
  if (!circle.members.some((m) => m.pk === ev.signerPk)) return 'done'
  if (!sealerBound) { parkStructural(circle.id, rumor); return 'parked' }
  if (ev.action === 'invite') {
    acceptVouch(circle.id, ev.event, now)
    touch(circle.id, rumor.pubkey, now)
    markStructuralSeen(dedupKey)
    return 'done'
  }
  if (ev.action === 'config') {
    const verdict = judgeConfig(circle.id, ev.signerPk, ev.payload, now)
    if (verdict === 'needs-vouch') { parkNeedsVouch(circle.id, rumor, ev.payload); return 'parked' }
    if (verdict !== 'ok') return 'done'
  } else if (!structuralAuthorised(trustViewFor(circle.id), ev, now)) {
    return 'done'
  }
  touch(circle.id, rumor.pubkey, now)
  markStructuralSeen(dedupKey)
  if (ev.action === 'vouch') acceptVouch(circle.id, ev.event, now)
  const inner: Rumor = {
    pubkey: ev.signerPk,
    created_at: ev.event.created_at,
    kind: ev.event.kind,
    tags: ev.event.tags,
    content: ev.payload,
    id: ev.event.id,
  }
  const sender: Sender = { signerPk: rumor.pubkey, memberPk: ev.signerPk, structural: true }
  for (const handler of signalHandlers) handler(circle, inner, ev.action, sender)
  // Plan 2, Task 6: an authorised config is kept for our own invite bundles.
  if (ev.action === 'config') rememberConfig(circle.id, ev.event)
  return 'done'
}

/** A `t:'revoke'` post, OR a revocation this device itself just signed and
 *  posted (devices.ts's phone-removal flow, Signet identity plan, Task 12 —
 *  the SAME code path a peer's copy arriving on the wire runs, so a local
 *  removal triggers the identical re-key logic rather than a second copy of
 *  it). Applied once (a replay of a revocation already held changes
 *  nothing). On first application, every circle where that phone holds the
 *  CURRENT seed (circles.ts `phoneHoldsSeed`) is re-keyed without it — by
 *  guardian-role devices (plan 1: only guardians re-key). Exported for
 *  devices.ts to call directly.
 *
 *  Task 12 fix round 1, item 1 (security, binding): a revocation of THIS
 *  device's own phone key (`rv.phonePk === self.phonePk`) is the one
 *  exception — it never enqueues a re-key from here. Doing so would ask
 *  this now-untrusted device to hand itself (or forward to others) a fresh
 *  seed it's no longer authorised to hold; `circles.ts`'s `sendRekey` also
 *  guards against listing a revoked key in `to` as a second layer, but the
 *  right response to your OWN phone being cut off is to stop using it, not
 *  to keep it working one more re-key cycle. Signs out instead, via the
 *  hardened routine (`signin.ts`'s `doSignOut`, which never throws) —
 *  wiping the session, this phone's key, and every locally-held seed. This
 *  device's own re-key enqueue is simply never raised, not lost: another
 *  guardian device (this identity's own remaining phone, or a co-guardian's)
 *  re-keys the circle without this phone once the SAME revocation reaches
 *  IT — every affected circle still gets re-keyed, just not by the device
 *  that was just cut off. */
export async function applyRevocation(raw: unknown): Promise<void> {
  const rv = verifyRevocation(raw)
  if (!rv) return
  const before = store.load()
  if (before.revokedPhoneKeys[rv.phonePk]) return
  const affected = before.circles.filter((c) => phoneHoldsSeed(before, c.id, rv.phonePk))
  if (acceptRevocation(raw, before.circles) !== 'applied') return
  const self = currentSession()
  if (!self) return
  if (rv.phonePk === self.phonePk) {
    // Task 12 fix round 2, finding 1b (security, defence in depth): only
    // sign out for a revocation actually signed by OUR OWN identity, or
    // (Plan 2, Task 9) a linked guardian of ours — spec §7's "for a
    // dependant, the guardian revokes" means a dependant's phone must sign
    // itself out on the guardian's say-so exactly as it would on its own.
    // `acceptRevocation`'s own owner/linked check (phone-keys.ts `ownerOf`/
    // `linked`, fix round 2 finding 1a, Task 9) already rejects any other
    // signer's revocation of this phone before it's ever "applied" — this
    // is a second, redundant layer against the same exploit, not the
    // primary defence.
    if (rv.signerPk !== self.identityPk && !linked(rv.signerPk, self.identityPk)) return
    await doSignOut()
    return
  }
  for (const c of affected) {
    if (isGuardian(c, self.identityPk)) void sendRekey(c, [])
  }
}

/** Task 9 fix round 1: re-judges every revocation parked because its BOUND
 *  key's signer wasn't yet a linked guardian of the owner (phone-keys.ts's
 *  `acceptRevocation`), promoting any now covered by
 *  `guardian-links.linked(signer, owner)` (`promoteParkedRevocations`) and
 *  applying each exactly like `applyRevocation` above: the own-phone
 *  sign-out path when it's this device's own key, otherwise a re-key of
 *  every circle where that phone held the current seed (guardian-role
 *  devices only). Called from trust-watch.ts's `start()` when a guardian
 *  link becomes true, and once at app start — a revocation and the link
 *  pair backing it can arrive in either order under randomised gift-wrap
 *  catch-up. An unlink never reaches here (it isn't a link becoming true),
 *  so it never promotes anything. */
export async function applyParkedRevocations(): Promise<void> {
  const p = store.load()
  const promoted = promoteParkedRevocations()
  for (const { phonePk, event } of promoted) {
    const self = currentSession()
    if (!self) return
    if (phonePk === self.phonePk) {
      // Same defence-in-depth as applyRevocation above: only sign out for a
      // revocation actually signed by our own identity or a linked guardian
      // of ours — already guaranteed by `promoteParkedRevocations`'s own
      // promotion check, checked again here regardless.
      const rv = verifyRevocation(event)
      if (rv && (rv.signerPk === self.identityPk || linked(rv.signerPk, self.identityPk))) await doSignOut()
      return
    }
    const affected = p.circles.filter((c) => phoneHoldsSeed(p, c.id, phonePk))
    for (const c of affected) {
      if (isGuardian(c, self.identityPk)) void sendRekey(c, [])
    }
  }
}

/** Sends an identity-signed structural event (structural.ts) into `circle`:
 *  gift-wrapped to the circle inbox, sealed by this phone's key, rumor
 *  `t:'struct'` with the signed event as content. Uses the circle's CURRENT
 *  seed (a re-key since signing is fine: receivers accept any seed hash the
 *  circle has had, except for re-keys, which never travel here). */
export async function sendStructural(circle: Circle, signed: SignedEvent): Promise<void> {
  const p = store.load()
  const current = p.circles.find((c) => c.id === circle.id) ?? circle
  const inbox = deriveInbox(current.seedHex)
  const wrap = await giftWrap(phoneSigner(), inbox.pk, { kind: KINDS.signal, tags: [['t', STRUCT_SIGNAL_TYPE]], content: JSON.stringify(signed) }, inbox.pk)
  await publishOrEnqueue(appRelays(p), wrap)
}

/** Plan 2, Task 6: posts a signed vouch (the `invite` naming its invitee)
 *  into `circle` as a phone-sealed `t:'vouch-post'` rumor, so members hold
 *  it before the config adding the invitee arrives. */
export async function postVouch(circle: Circle, signed: SignedEvent): Promise<void> {
  const p = store.load()
  const current = p.circles.find((c) => c.id === circle.id) ?? circle
  const inbox = deriveInbox(current.seedHex)
  const wrap = await giftWrap(phoneSigner(), inbox.pk, { kind: KINDS.signal, tags: [['t', VOUCH_POST_SIGNAL_TYPE]], content: JSON.stringify(signed) }, inbox.pk)
  await publishOrEnqueue(appRelays(p), wrap)
}

/** Plan 2, Task 7: posts guardian-link statements into `circle` as a
 *  phone-sealed `t:'link'` rumor — a `{ g, d }` pair or an `{ unlink }` —
 *  so members learn the link (`receiveLink`). */
export async function postLink(circle: Circle, content: { g: SignedEvent; d: SignedEvent } | { unlink: SignedEvent }): Promise<void> {
  const p = store.load()
  const current = p.circles.find((c) => c.id === circle.id) ?? circle
  const inbox = deriveInbox(current.seedHex)
  const wrap = await giftWrap(phoneSigner(), inbox.pk, { kind: KINDS.signal, tags: [['t', LINK_SIGNAL_TYPE]], content: JSON.stringify(content) }, inbox.pk)
  await publishOrEnqueue(appRelays(p), wrap)
}

/** Posts this device's own device statement into `circle` (on join, after
 *  sign-in, after every re-key — spec §5), binds it in this device's own
 *  table, and records when (`statementPostedAt`). A no-op until the session
 *  holds a signed statement. */
export async function postStatement(circle: Circle): Promise<void> {
  const self = currentSession()
  if (!self?.statement) return
  const p = store.load()
  const current = p.circles.find((c) => c.id === circle.id) ?? circle
  acceptStatement(current, self.statement, self.phonePk, nowSec())
  store.update((sp) => { sp.statementPostedAt = { ...sp.statementPostedAt, [current.id]: Date.now() } })
  const inbox = deriveInbox(current.seedHex)
  const wrap = await giftWrap(phoneSigner(), inbox.pk, { kind: KINDS.signal, tags: [['t', DEVICE_SIGNAL_TYPE]], content: JSON.stringify(self.statement) }, inbox.pk)
  await publishOrEnqueue(appRelays(p), wrap)
}

/** Posts a signed, identity-authorised revocation (device-statements.ts's
 *  `revocationTemplate`) into `circle`'s inbox as a phone-sealed `t:'revoke'`
 *  rumor — same wrap shape as `postStatement` just above, but for a
 *  revocation devices.ts's phone-removal flow (Signet identity plan, Task
 *  12) signs directly with the identity signer, not this device's own
 *  stored device statement. Sending only: applying it locally (so this
 *  device's own tables and the re-key trigger see it too, exactly like a
 *  peer's copy arriving on the wire) is `applyRevocation`'s job, called
 *  separately by the caller once, not once per circle. */
export async function postRevocation(circle: Circle, signed: SignedEvent): Promise<void> {
  const p = store.load()
  const current = p.circles.find((c) => c.id === circle.id) ?? circle
  const inbox = deriveInbox(current.seedHex)
  const wrap = await giftWrap(phoneSigner(), inbox.pk, { kind: KINDS.signal, tags: [['t', REVOKE_SIGNAL_TYPE]], content: JSON.stringify(signed) }, inbox.pk)
  await publishOrEnqueue(appRelays(p), wrap)
}

/** How often app start re-posts this device's statement into each circle:
 *  circle-inbox wraps expire (~16 days), so a member joining later would
 *  otherwise never learn this phone. */
export const STATEMENT_REFRESH_MS = 24 * 60 * 60 * 1000

/** App start (Task 11 wires it, after `restore()`): re-posts this device's
 *  statement into every circle it hasn't posted to in the last 24 h. */
export async function refreshStatements(nowMs: number = Date.now()): Promise<void> {
  const p = store.load()
  for (const c of p.circles) {
    const last = p.statementPostedAt[c.id] ?? 0
    if (nowMs - last < STATEMENT_REFRESH_MS) continue
    await postStatement(c).catch(() => { /* offline — the outbox retries */ })
  }
}

function ensureReceive(p: store.Persisted, circle: Circle): void {
  const relays = appRelays(p)
  const inbox = deriveInbox(circle.seedHex)
  // gen: prefix (pool-health.ts): a pool-staleness recovery bump changes
  // this key even though the inbox/relays themselves didn't, so the compare
  // below sees it as stale and rebuilds the subscription on the fresh pool
  // instead of sitting inert against the torn-down one — see pool-health.ts's
  // `buildSubKey` doc comment.
  const key = poolHealth.buildSubKey(poolHealth.generation(), `${inbox.pk}@${relays.join(',')}`)
  if (inboxKeys.get(circle.id) === key) return
  inboxUnsubscribes.get(circle.id)?.()
  inboxKeys.set(circle.id, key)
  const unsub = subscribeGiftWraps(relays, inbox.pk, (e) => { void onCircleInboxWrap(circle.id, inbox.sk, e) })
  const release = poolHealth.expectInbox(inbox.pk) // a resume checks it is really open (pool-health.ts's recoverOnResume)
  inboxUnsubscribes.set(circle.id, () => { release(); unsub() })
}

// ---------------------------------------------------------------------------
// ensure() — the one side-effecting entry point, called from app.ts's
// render() whenever there's a signed-in identity (same idiom as
// circles.ensure). Idempotent: starts the geo watch + outbox-flush wiring
// once, keeps one emit loop and one receive subscription running per circle,
// and tears down any circle no longer in `p.circles` (removed / reseeded away).
// ---------------------------------------------------------------------------

export function ensure(p: store.Persisted): void {
  if (!currentSession()) {
    teardown()
    return
  }
  ensureGeoWatch()
  ensureOutboxFlush()

  const liveIds = new Set(p.circles.map((c) => c.id))
  for (const id of [...emitTimers.keys()]) if (!liveIds.has(id)) clearEmitTimer(id)
  for (const [id, unsub] of [...inboxUnsubscribes]) {
    if (!liveIds.has(id)) { unsub(); inboxUnsubscribes.delete(id); inboxKeys.delete(id) }
  }
  for (const circle of p.circles) {
    ensureReceive(p, circle)
    if (!emitTimers.has(circle.id)) scheduleEmit(circle.id, 0) // kick off now; first tick sends immediately if a fix is already in hand
  }
}

function teardown(): void {
  watchStop?.()
  watchStop = null
  currentFix = null
  movement = null
  for (const id of [...emitTimers.keys()]) clearEmitTimer(id)
  for (const unsub of inboxUnsubscribes.values()) unsub()
  inboxUnsubscribes.clear()
  inboxKeys.clear()
  positions.clear()
}
