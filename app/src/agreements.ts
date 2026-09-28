// Return agreements: a guardian proposes a scheduled pickup/meet ("Jamie
// picked up from school by 5:30"), the tracked child acknowledges and
// reports lifecycle progress against it, either side can ask to push the
// deadline out, and a device that sees the deadline pass with no arrival
// raises `late`. Implements BROOD.md §4 (agreement lifecycle) end to end:
// state reducers (this file's pure section, unit-tested in
// agreements.test.ts), the wire builders/decoders that carry each signal
// over the SAME circle-inbox gift-wrap path every other kindependence payload
// uses, and the Home-tab UI.
//
// Wire shape: brood-kit's `buildBroodInner`/`parseBroodSignal` — kind 20078
// (the same inner kind FLOCK's own signals use, discriminated by the same
// `['t', <type>]` tag convention), content a plain JSON encoding of the
// signal. Unlike FLOCK's own signals (canary-kit AES-GCM keyed off the
// circle seed), a brood signal carries NO second encryption layer — see
// BROOD.md §2: "brood-kit itself never touches the wire... the caller is
// responsible for gift-wrapping it." The outer NIP-59 gift-wrap (roost-kit's
// `giftWrap`, byte-identical to FLOCK's own wrap) is brood's only
// confidentiality layer, exactly the precedent safety.ts's own
// checkin/pickup-req signals already follow (see that file's module doc
// comment) — legitimate here for the same reason: canary-kit's extra layer
// buys no confidentiality against a circle's own members, whose gift-wrap
// inbox key already derives from the same shared `seedHex`.
//
// Reuses beacons.ts's plumbing rather than duplicating it: `appRelays` (via
// circles.ts), `selfFix` (arrival auto-detect, and the "use my current
// location" affordance on a new agreement's place), `publishOrEnqueue`, and
// — for receiving — beacons.ts's existing per-circle gift-wrap subscription,
// via `setSignalHandler` (appended alongside safety.ts's own handler, not a
// second subscription — see that function's doc comment in beacons.ts).
// `activeAgreementFor` (below) is registered back into beacons.ts via
// `setActiveAgreementProvider` rather than beacons.ts importing this module
// directly, which would be circular (this module already imports
// beacons.ts).
//
// Self-echo: the circle inbox is shared, so every publish this device makes
// is also delivered back to its own subscription. Every outgoing action
// below applies its own reducer to local state SYNCHRONOUSLY, before the
// network publish even starts (never waiting on the round trip) — so the
// receive path (`handleIncomingSignal`) unconditionally ignores anything
// whose resolved sender (`sender.signerPk`, Signet identity plan Task 9) is
// this device's own phone key, same discipline as safety.ts's
// `handleIncomingSignalAsync`. This is also what makes an approved extension
// deterministic on both sides "on seeing extend-resp ok" (task contract): the
// approving guardian applies `applyExtendResp` to its own resp the instant it
// builds it, never by processing its own wire echo.

import * as store from './store.js'
import { clearFields } from './form-state.js'
import * as beacons from './beacons.js'
import * as activity from './activity.js'
import * as mapinfo from './mapinfo.js'
import { appRelays } from './circles.js'
import { notify, shouldNotifyForEvent } from './notify.js'
import { currentSession, phoneSigner } from './session.js'
import type { SessionInfo } from './session.js'
import { enqueue, registerSender, stillEnqueuingSession, pending as queuePending } from './structural-queue.js'
import { deriveInbox, isGuardian, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftWrap } from '@forgesworn/roost-kit'
import type { Rumor, SignedEvent, Signer } from '@forgesworn/roost-kit'
import {
  buildAgreement,
  buildAgreementAck,
  buildAgreementStatus,
  buildExtendReq,
  buildExtendResp,
  buildBroodInner,
  parseBroodSignal,
  isLate,
  BROOD_SIGNAL_KIND,
} from '@forgesworn/brood-kit'
import type {
  Agreement,
  AgreementAck,
  AgreementStatus,
  AgreementStatusKind,
  ExtendReq,
  ExtendResp,
  PrecisionStep,
} from '@forgesworn/brood-kit'
import { encode as encodeGeohash, contains as geohashContains, decode as decodeGeohash } from 'geohash-kit'
import type { Fix } from './geo.js'
import * as travel from './travel.js'
import type { TravelMode } from './travel.js'

const nowSec = (): number => Math.floor(Date.now() / 1000)

// ---------------------------------------------------------------------------
// Constants — the task contract's defaults.
// ---------------------------------------------------------------------------

/** "Coarse until 15 min before, then precise" — the default (and, in v1,
 *  only pre-built) schedule preset, exactly as specced. */
export const DEFAULT_SCHEDULE: PrecisionStep[] = [{ fromOffsetMin: -15, precision: 9 }]

/** The other preset chip: precise disclosure for the whole tracked window,
 *  not just the last 15 minutes — a full day's lead-in comfortably covers
 *  same-day agreements without needing a real "always" sentinel. */
export const PRECISE_SCHEDULE: PrecisionStep[] = [{ fromOffsetMin: -24 * 60, precision: 9 }]

/** Geohash precision for a place's "use my current location" pin (~4.8m x
 *  4.8m at the equator) — fine enough for the arrival auto-detect's cell
 *  match, matching the default schedule's own "precise" tier (9). */
const PLACE_PRECISION = 9

/** How often the child-side timer re-checks arrival + lateness — the task
 *  contract's "60s timer" for the late check; arrival auto-detect rides the
 *  same tick rather than a second timer. */
const CHECK_INTERVAL_MS = 60_000

const EXTEND_CHIP_MINUTES = [15, 30] as const

/** Leave-reminder schedule offsets (Task 8, brief §15) — see `leaveSchedule`'s
 *  own doc comment for the arithmetic these feed into. */
const LEAVE_SOON_LEAD_SEC = 900 // 'soon' fires 15 min before leaveBy
const LEAVE_PAD_SEC_DEFAULT = 300 // default safety pad baked into leaveBy itself
const LEAVE_BEHIND_LAG_SEC = 300 // 'behind' fires 5 min after leaveBy

/** How long a cached `travelSec` result stays valid, per agreement (task
 *  contract: "recompute at most each 5 min"). */
const TRAVEL_CACHE_TTL_SEC = 300

// ---------------------------------------------------------------------------
// Pure reducers — the agreement lifecycle state machine. Unit-tested in
// isolation (agreements.test.ts): propose -> ack -> status transitions,
// extend application, and dedupe of repeated/replayed signals. No store or
// network access anywhere in this section.
// ---------------------------------------------------------------------------

/** Fresh local state for a just-seen `agreement` proposal — always
 *  `'proposed'`; nothing has acked or reported status yet. */
export function initialAgreementRecord(agreement: Agreement): store.AgreementRecord {
  return { agreement, status: 'proposed' }
}

/** Adds a newly-proposed agreement, unless this exact `id` is already
 *  tracked — a relay replay of the same `agreement` signal (or the
 *  proposer's own self-applied copy arriving again via its wire echo) must
 *  never reset an agreement that has already moved past `'proposed'` back to
 *  square one. */
export function upsertProposedAgreement(records: store.AgreementRecord[], agreement: Agreement): store.AgreementRecord[] {
  if (records.some((r) => r.agreement.id === agreement.id)) return records
  return [...records, initialAgreementRecord(agreement)]
}

/** Applies an `agreement-ack`: `'proposed'` -> `'acked'`. A duplicate ack
 *  (replay, or arriving after a later status signal already advanced things
 *  further) is a no-op — acking only ever moves a record OFF `'proposed'`,
 *  never re-applies once it's left that state. */
export function applyAgreementAck(records: store.AgreementRecord[], ack: AgreementAck): store.AgreementRecord[] {
  return records.map((r) => {
    if (r.agreement.id !== ack.id || r.status !== 'proposed') return r
    return { ...r, status: 'acked' }
  })
}

// Ranks the three tiers `agreement-status` signals move between: `acked`
// (nothing reported yet), `en-route`/`late` (a shared tier — a device can
// legitimately flip between the two as fresher reports arrive, in either
// order, right up until arrival), and `arrived` (terminal). Used only to stop
// a stale `en-route`/`late` from regressing a record that's already ahead of
// it (e.g. a late-arriving `en-route` after `arrived` has already landed).
const STATUS_RANK: Record<store.AgreementLifecycleStatus, number> = {
  proposed: 0,
  acked: 1,
  'en-route': 2,
  late: 2,
  arrived: 3,
}

/** Applies an `agreement-status` signal. `'arrived'` always wins (terminal —
 *  see BROOD.md §4) and is recorded exactly once (`arrivedAt` is set only on
 *  the transition INTO `'arrived'`, so a replay of the same `arrived` signal
 *  doesn't touch it again). Once a record IS `'arrived'`, every further
 *  status signal is ignored — dedupes both an exact replay and a stale
 *  `en-route`/`late` that was in flight before arrival landed. Otherwise, a
 *  same-or-higher-tier status (per `STATUS_RANK`) applies; a lower tier is
 *  dropped rather than regressing the record. */
export function applyAgreementStatus(records: store.AgreementRecord[], sig: AgreementStatus): store.AgreementRecord[] {
  return records.map((r) => {
    if (r.agreement.id !== sig.id || r.status === 'arrived') return r
    if (sig.status === 'arrived') return { ...r, status: 'arrived', arrivedAt: sig.at }
    if (STATUS_RANK[sig.status] < STATUS_RANK[r.status]) return r
    return { ...r, status: sig.status }
  })
}

/** Records an `extend-req` as the record's pending extension, awaiting a
 *  guardian's `extend-resp`. Applied by BOTH the requester (self-applied the
 *  moment it sends the request, same self-echo discipline as everywhere else
 *  in this file) and any guardian receiving it — each keeps its own copy so
 *  each side's card can render correctly. A second `extend-req` while one is
 *  already pending simply replaces it (the newest ask wins — there is no
 *  request queue in v1). */
export function applyExtendReq(records: store.AgreementRecord[], req: ExtendReq): store.AgreementRecord[] {
  return records.map((r) =>
    r.agreement.id === req.id
      ? { ...r, pendingExtend: { id: req.id, extraMin: req.extraMin, by: req.by, at: req.at } }
      : r,
  )
}

/** Applies an `extend-resp`. A grant (`ok: true`) pushes `byUnix` out by
 *  `extraMin` minutes (the resp's own `extraMin` if it counter-offered one,
 *  else the original request's) — deterministic on both sides because both
 *  run this exact function against the exact same resp (see the module doc
 *  comment's self-echo section). If the record was `'late'` against the OLD
 *  deadline, a grant also resets it to `'en-route'` — BROOD.md §4's
 *  "lifecycle resumes at en-route/arrived/late against the new deadline"; a
 *  record that was late relative to a deadline that no longer applies isn't
 *  meaningfully late anymore, and the next status/late-check tick re-derives
 *  the truth against the new `byUnix` regardless. A refusal leaves both
 *  `byUnix` and `status` untouched (BROOD.md §4: "leaves the original byUnix
 *  in force"). Either way, `pendingExtend` is cleared — which is also this
 *  function's dedupe: a replayed resp finds no `pendingExtend` left to act
 *  on (already cleared by the first application) and is silently a no-op. */
export function applyExtendResp(records: store.AgreementRecord[], resp: ExtendResp): store.AgreementRecord[] {
  return records.map((r) => {
    if (r.agreement.id !== resp.id || !r.pendingExtend) return r
    if (!resp.ok) return { ...r, pendingExtend: undefined }
    const extraMin = resp.extraMin ?? r.pendingExtend.extraMin
    return {
      ...r,
      agreement: { ...r.agreement, byUnix: r.agreement.byUnix + extraMin * 60 },
      status: r.status === 'late' ? 'en-route' : r.status,
      pendingExtend: undefined,
    }
  })
}

/** The circle's ACKED, un-arrived agreement tracking `selfPk` as its
 *  `child` — what `beacons.ts`'s `mergePrecision` should escalate disclosure
 *  against for THIS device. `'proposed'` (not yet acked) and `'arrived'`
 *  (fulfilled) are both excluded — precision has no reason to escalate for
 *  an agreement nobody's committed to yet, or one that's already done. */
export function selectActiveAgreement(records: store.AgreementRecord[], circleId: string, selfPk: string): Agreement | undefined {
  return records.find(
    (r) =>
      r.agreement.circleId === circleId &&
      r.agreement.child === selfPk &&
      (r.status === 'acked' || r.status === 'en-route' || r.status === 'late'),
  )?.agreement
}

/** Whether `fix` (this device's current location) falls in `place`'s
 *  geohash cell — the arrival auto-detect check. Compares at whichever of
 *  the two precisions is coarser (geohash-kit's `contains` is a bidirectional
 *  prefix check), so it still matches if the live fix happens to be encoded
 *  at a different precision than the place pin was recorded at. `false` for
 *  a label-only place (no geohash) or no current fix — arrival then falls
 *  back to the manual "I'm here" button entirely, never invented from
 *  nothing. */
export function hasArrivedAt(place: { label: string; geohash?: string } | undefined, fix: Fix | null): boolean {
  if (!place?.geohash || !fix) return false
  const fixHash = encodeGeohash(fix.lat, fix.lon, place.geohash.length)
  return geohashContains(fixHash, place.geohash)
}

// ---------------------------------------------------------------------------
// Schedule -> human text (Task 8, brief §11.3: "the child should be able to
// see the schedule in advance") + the "current or next raise" pick the
// location-mode line (mapinfo.ts's `locationModeLine`) needs. Both pure —
// `formatTime`/`nowSecValue` are always caller-supplied, never read from the
// clock here — and independent of whatever circle/device is asking, so
// app.ts's `circleModeLine` and the privacy overview's schedule row can
// share them without either duplicating the schedule-walking logic.
// ---------------------------------------------------------------------------

/** Child-readable prose for a full agreement schedule, e.g.
 *  "Neighbourhood until 17:15, then Street, Precise from 17:45." for a
 *  two-step schedule, or "Neighbourhood until 17:45, then Precise from
 *  17:45." for this app's single-step `DEFAULT_SCHEDULE`. `baselineTerm` is
 *  the per-circle baseline's own friendly term (`mapinfo.precisionTerm`) —
 *  the schedule only ever raises disclosure ABOVE it (brood-kit's
 *  `agreementPrecision`/`mergePrecision`), so it's always the sentence's
 *  starting state. Steps are walked earliest-first (sorted by
 *  `fromOffsetMin`, same ordering `agreementPrecision` itself uses); the
 *  first step after the baseline gets a "then" prefix, only the LAST step
 *  gets an open-ended "from <time>" (every step in between just names its
 *  term — its start is implicitly the previous step's end, and its own end
 *  is named by the step after it). An empty schedule (shouldn't happen — an
 *  `Agreement` always carries at least one step — but handled rather than
 *  assumed) falls back to just the baseline term. */
export function agreementScheduleText(
  baselineTerm: string,
  schedule: readonly PrecisionStep[],
  byUnix: number,
  formatTime: (unixSec: number) => string,
): string {
  if (!schedule.length) return `${baselineTerm}.`
  const sorted = [...schedule].sort((a, b) => a.fromOffsetMin - b.fromOffsetMin)
  const times = sorted.map((s) => byUnix + s.fromOffsetMin * 60)
  const parts = [`${baselineTerm} until ${formatTime(times[0] as number)}`]
  sorted.forEach((step, i) => {
    const isFirst = i === 0
    const isLast = i === sorted.length - 1
    const prefix = isFirst ? 'then ' : ''
    const suffix = isLast ? ` from ${formatTime(times[i] as number)}` : ''
    parts.push(`${prefix}${mapinfo.precisionTerm(step.precision)}${suffix}`)
  })
  return `${parts.join(', ')}.`
}

/** The schedule step CURRENTLY in force (if its precision is above
 *  `baselinePrecision`), else the next UPCOMING step that will raise above
 *  it, else `undefined` when nothing in the schedule ever rises above
 *  baseline relative to `nowSecValue`. Feeds the location-mode line's
 *  optional " · <term> from <time>" clause (mapinfo.ts's `locationModeLine`)
 *  — "current or next" is deliberate: before the first raise, the line
 *  should say when precision WILL rise; once it has, the line should keep
 *  naming that same raise (its own start time) rather than going silent
 *  until the NEXT step, so a viewer mid-episode still sees why disclosure is
 *  currently above baseline. */
export function nextOrCurrentRaise(
  baselinePrecision: number,
  schedule: readonly PrecisionStep[],
  byUnix: number,
  nowSecValue: number,
): { precision: number; atUnix: number } | undefined {
  const times = [...schedule]
    .sort((a, b) => a.fromOffsetMin - b.fromOffsetMin)
    .map((s) => ({ atUnix: byUnix + s.fromOffsetMin * 60, precision: s.precision }))
  let current: { atUnix: number; precision: number } | undefined
  for (const t of times) if (t.atUnix <= nowSecValue) current = t
  if (current && current.precision > baselinePrecision) return current
  return times.find((t) => t.atUnix > nowSecValue && t.precision > baselinePrecision)
}

// ---------------------------------------------------------------------------
// Leave reminders (Task 8, brief §15) — travel-aware, CHILD-SIDE-ONLY local
// notifications computed from the active agreement's own deadline minus an
// estimated travel time. No new wire signal: these are purely local to the
// child's device (the circle-visible "running late" side is already covered
// by the existing `agreement-status{status:'late'}` signal above) — a
// guardian device never computes or sees any of this. Evaluated on the SAME
// 60s child-side tick as the arrival/late check (`checkTick`, below) — the
// "least-new-plumbing" option: no new timer, no new registration with
// places.ts or beacons.ts, nothing new for `ensure()` to wire up.
//
// This section (schedule arithmetic + the collapse rule + cache-TTL check +
// copy) is pure and unit-tested in isolation (agreements.test.ts); the
// impure orchestration (travel.travelSec calls, the per-agreement cache, the
// store reads/writes, notify()/recordActivity()) lives in
// `evaluateLeaveReminder` further down, alongside `checkTick`.
// ---------------------------------------------------------------------------

/** One point in an agreement's leave-reminder schedule — see `leaveSchedule`. */
export interface LeaveStage { stage: 'soon' | 'now' | 'behind'; atUnix: number }

/** The three leave-reminder checkpoints for an agreement due at `byUnix`,
 *  given an estimated `travelSecValue` (from `travel.travelSec`) and a safety
 *  `padSec` (default 5 min — arriving exactly ON time still leaves no
 *  margin for the last few minutes' unpredictability). `leaveBy = byUnix -
 *  travelSecValue - padSec` is the moment travel needs to actually START;
 *  `'soon'` warns 15 min ahead of THAT, `'now'` is the moment itself, and
 *  `'behind'` follows 5 min later once departure is already overdue. Pure —
 *  `byUnix`/`travelSecValue` are always caller-supplied, never read from the
 *  clock or a live travel estimate here. */
export function leaveSchedule(byUnix: number, travelSecValue: number, padSec: number = LEAVE_PAD_SEC_DEFAULT): LeaveStage[] {
  const leaveBy = byUnix - travelSecValue - padSec
  return [
    { stage: 'soon', atUnix: leaveBy - LEAVE_SOON_LEAD_SEC },
    { stage: 'now', atUnix: leaveBy },
    { stage: 'behind', atUnix: leaveBy + LEAVE_BEHIND_LAG_SEC },
  ]
}

/** The LATEST due-and-unfired stage among `stages` at `nowSecValue`, or
 *  `null` if none is due yet or every due stage has already been handled —
 *  THE collapse rule (task contract): when `travelSecValue` exceeds the
 *  'soon' lead time (or evaluation simply starts late — e.g. the agreement
 *  was acked well after its own would-be 'soon' moment), MULTIPLE stages can
 *  be simultaneously due on a single check. Returning only the single most
 *  urgent one is what stops that from becoming a burst of up to three
 *  notifications at once. `fired` is keyed by bare `stage` name (`'soon'` /
 *  `'now'` / `'behind'`) — the CALLER (`evaluateLeaveReminder`) is
 *  responsible for narrowing the full, globally-keyed `Persisted.leaveFired`
 *  (`${agreementId}:${byUnix}:${stage}`) down to this agreement+byUnix's own
 *  subset before calling. That caller ALSO marks every OTHER currently-due
 *  stage fired alongside the one it acts on here (not just the winner) —
 *  otherwise a stage this call skipped over would simply resurface as
 *  "newly due" on the NEXT 60s tick, turning the burst into three
 *  notifications spread a minute apart instead of collapsed into one. */
export function dueLeaveStage(stages: LeaveStage[], fired: Record<string, true>, nowSecValue: number): LeaveStage | null {
  const due = stages.filter((s) => s.atUnix <= nowSecValue && !fired[s.stage])
  if (!due.length) return null
  return due.reduce((latest, s) => (s.atUnix > latest.atUnix ? s : latest))
}

/** Whether a travel-time estimate computed at `computedAt` is still usable at
 *  `nowSecValue` — task contract: "recompute at most each 5 min." Extracted
 *  pure so the TTL boundary itself is directly testable without exercising
 *  `travel.travelSec` or the store. */
export function travelCacheFresh(computedAt: number, nowSecValue: number, ttlSec: number = TRAVEL_CACHE_TTL_SEC): boolean {
  return nowSecValue - computedAt < ttlSec
}

/** `'HH:MM'`, 24-hour, zero-padded, device-local — the "by HH:MM" clause in
 *  `leaveNowCopy`. Mirrors places.ts's own `parseHHMM`-compatible convention
 *  one level up (formatting rather than parsing). */
export function formatHHMM(unixSec: number): string {
  const d = new Date(unixSec * 1000)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// Copy (brief §15, verbatim) — §31: 'late' never appears in rendered text
// (see `leaveBehindCopy`'s own phrasing, "running behind," not "late").
// Split into one small function per stage, same "each copy variant gets its
// own directly-testable function" idiom as places.ts's
// `graceWarningCopy`/`escalatedChildCopy`/`escalationPendingCopy`.

export function leaveSoonCopy(placeLabel: string, travelMin: number): string {
  return `You'll need to leave for ${placeLabel} soon (about ${travelMin} min away)`
}
export function leaveNowCopy(placeLabel: string, byHHMM: string): string {
  return `Leave now to make ${placeLabel} by ${byHHMM}`
}
export function leaveBehindCopy(placeLabel: string): string {
  return `Running behind for ${placeLabel} — ask for more time?`
}

/** Dispatches to the matching copy builder above for a fired `stage`. */
export function leaveStageCopy(stage: LeaveStage['stage'], placeLabel: string, travelSecValue: number, byUnix: number): string {
  switch (stage) {
    case 'soon': return leaveSoonCopy(placeLabel, Math.round(travelSecValue / 60))
    case 'now': return leaveNowCopy(placeLabel, formatHHMM(byUnix))
    case 'behind': return leaveBehindCopy(placeLabel)
  }
}

// ---------------------------------------------------------------------------
// Id + wire helpers
// ---------------------------------------------------------------------------

function randomHex(byteLen: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLen)))
}

/** A fresh agreement id — used as the `id` on every signal in its lifecycle
 *  (`agreement`, `agreement-ack`, `agreement-status`, `extend-req`,
 *  `extend-resp` all share it; see BROOD.md §3's signal table). Just an
 *  unlinkability handle, not a secret — same idiom as circles.ts's
 *  `newCircleId`. */
export function newAgreementId(): string {
  return randomHex(8)
}

/** Gift-wraps any brood signal to `circle`'s shared inbox — the one place
 *  every builder below funnels through. */
async function broodWrap(
  signer: Signer,
  circle: Circle,
  signal: Parameters<typeof buildBroodInner>[0],
  at: number,
): Promise<SignedEvent> {
  const inner = buildBroodInner(signal, at)
  const inbox = deriveInbox(circle.seedHex)
  return giftWrap(signer, inbox.pk, inner, inbox.pk)
}

// `buildAgreementWrap`/`buildExtendRespWrap` (the `agreement`/`extend-resp`
// pair) are GONE from here — Signet identity plan, Task 9 made both
// identity-signed structural actions (`proposeAgreement`/`respondExtend`
// below now go through `enqueue`, never a phone-key `giftWrap`), so nothing
// in this codebase still calls a wrap-builder for them; only
// agreements.test.ts's own wire-round-trip coverage still needs that shape,
// so it now builds it locally (Task 9 fix round 1, finding 7) rather than
// this module exporting dead production surface.
export async function buildAgreementAckWrap(signer: Signer, circle: Circle, ack: AgreementAck): Promise<SignedEvent> {
  return broodWrap(signer, circle, ack, ack.at)
}
export async function buildAgreementStatusWrap(signer: Signer, circle: Circle, sig: AgreementStatus): Promise<SignedEvent> {
  return broodWrap(signer, circle, sig, sig.at)
}
export async function buildExtendReqWrap(signer: Signer, circle: Circle, req: ExtendReq): Promise<SignedEvent> {
  return broodWrap(signer, circle, req, req.at)
}

/** Decode an already-unwrapped rumor as any brood signal, or null if it
 *  isn't one (wrong kind/`t`) or is malformed. Thin pass-through to brood-
 *  kit's own `parseBroodSignal` — kept here so callers (this file, its
 *  tests) don't need to reach into brood-kit's `BROOD_SIGNAL_KIND` shape
 *  themselves. */
/** See approvals.ts's identical `decodeBroodSignal` doc comment: a
 *  STRUCTURAL delivery (`agreement`/`extend-resp`, Signet identity plan,
 *  Task 9) carries the structural event's own kind, not brood-kit's
 *  `BROOD_SIGNAL_KIND` — only the kind needs correcting. */
export function decodeBroodSignal(rumor: Rumor, sender: beacons.Sender): ReturnType<typeof parseBroodSignal> {
  const kind = sender.structural ? BROOD_SIGNAL_KIND : rumor.kind
  return parseBroodSignal({ kind, tags: rumor.tags, content: rumor.content })
}

// ---------------------------------------------------------------------------
// Local persistence — thin wrapper over store.update() applying a reducer.
// ---------------------------------------------------------------------------

function updateAgreements(fn: (records: store.AgreementRecord[]) => store.AgreementRecord[]): void {
  store.update((p) => { p.agreements = fn(p.agreements) })
}

// ---------------------------------------------------------------------------
// beacons.ts wiring — see that file's `setActiveAgreementProvider` doc
// comment for why this is a registration rather than a direct import.
// ---------------------------------------------------------------------------

/** `beacons.ts`'s `activeAgreementFor(circleId)` delegate — reads current
 *  store state and applies `selectActiveAgreement`. */
export function activeAgreementFor(circleId: string, selfPk: string): Agreement | undefined {
  return selectActiveAgreement(store.load().agreements, circleId, selfPk)
}

// ---------------------------------------------------------------------------
// Outgoing actions — each phone-signed one applies its own reducer to local state
// synchronously (see the module doc comment's self-echo section), then
// publishes via beacons.ts's `publishOrEnqueue` (never throws — offline
// falls over to the shared outbox, flushed on the same schedule as every
// other kindependence payload).
//
// Final fix round 3, F2: `agreement` and `extend-resp` go through the
// STRUCTURAL queue (identity-signed), same as approvals.ts's
// `family-policy`/`approval-resp`, and like them do NOT change local state
// at enqueue: until the signed event has gone out they show only in the
// structural queue's "Pending" banner. The local apply (and its Activity
// entry) runs inside this module's registered sender, after
// `sendStructural`, from the item's own persisted payload — so a cancel or
// dismiss has nothing to undo.
// ---------------------------------------------------------------------------

/** Guardian-only: proposes a new agreement to `circle`. */
export async function proposeAgreement(
  circleId: string,
  opts: { child: string; place?: { label: string; geohash?: string }; byUnix: number; schedule: PrecisionStep[]; note?: string },
): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle || !isGuardian(circle, self.identityPk)) return
  const at = nowSec()
  const agreement = buildAgreement(
    {
      id: newAgreementId(),
      circleId,
      child: opts.child,
      byUnix: opts.byUnix,
      schedule: opts.schedule,
      from: self.identityPk,
      ...(opts.place ? { place: opts.place } : {}),
      ...(opts.note ? { note: opts.note } : {}),
    },
    at,
  )
  enqueue({ action: 'agreement', circleId, payload: JSON.stringify(agreement), label: `Propose an agreement in ${circle.name}` })
}

/** Final fix round 3, F2: applies our own sent proposal locally. Runs only
 *  after the signed event went out. */
function applySentAgreement(circleId: string, agreement: Agreement): void {
  updateAgreements((records) => upsertProposedAgreement(records, agreement))
  activity.recordActivity({ id: `local-agreement-created-${agreement.id}`, at: agreement.at, kind: 'agreement-created', circleId, actorPk: agreement.from, params: agreement.place?.label ? { place: agreement.place.label } : {} })
}

function findRecordAndCircle(agreementId: string): { self: SessionInfo; record: store.AgreementRecord; circle: Circle; p: store.Persisted } | null {
  const p = store.load()
  const self = currentSession()
  const record = p.agreements.find((r) => r.agreement.id === agreementId)
  if (!self || !record) return null
  const circle = p.circles.find((c) => c.id === record.agreement.circleId)
  if (!circle) return null
  return { self, record, circle, p }
}

/** Child-only: acknowledges an agreement proposed to them. */
export async function ackAgreement(agreementId: string): Promise<void> {
  const ctx = findRecordAndCircle(agreementId)
  if (!ctx) return
  const { self, circle, p } = ctx
  const at = nowSec()
  const ack = buildAgreementAck({ id: agreementId, by: self.identityPk }, at)
  updateAgreements((records) => applyAgreementAck(records, ack))
  activity.recordActivity({ id: `local-agreement-acked-${agreementId}`, at, kind: 'agreement-acked', circleId: circle.id, actorPk: self.identityPk, params: {} })
  const wrap = await buildAgreementAckWrap(phoneSigner(), circle, ack)
  await beacons.publishOrEnqueue(appRelays(p), wrap)
}

/** Reports lifecycle progress against an agreement — "On my way" (`en-
 *  route`), the manual "I'm here" button, and the arrival auto-detect and
 *  late-check timer below all funnel through this one function. Not
 *  guardian/child-restricted here (a guardian device never calls it — its
 *  view only ever wires child-role buttons), same trust model as the rest of
 *  the safety/agreement wire, which stops at "shaped like the right
 *  pubkey/id," not "is this the right role" (see BROOD.md §7.3). */
export async function sendAgreementStatus(agreementId: string, status: AgreementStatusKind): Promise<void> {
  const ctx = findRecordAndCircle(agreementId)
  if (!ctx) return
  const { self, circle, p } = ctx
  const at = nowSec()
  const sig = buildAgreementStatus({ id: agreementId, status, by: self.identityPk }, at)
  updateAgreements((records) => applyAgreementStatus(records, sig))
  clearLeaveBanner(agreementId, status)
  activity.recordActivity({ id: `local-agreement-status-${agreementId}-${status}`, at, kind: 'agreement-status', circleId: circle.id, actorPk: self.identityPk, params: { status } })
  const wrap = await buildAgreementStatusWrap(phoneSigner(), circle, sig)
  await beacons.publishOrEnqueue(appRelays(p), wrap)
}

/** Requests pushing an agreement's deadline out by `extraMin` minutes — the
 *  +15/+30 chips. */
export async function requestExtend(agreementId: string, extraMin: number): Promise<void> {
  const ctx = findRecordAndCircle(agreementId)
  if (!ctx) return
  const { self, circle, p } = ctx
  const at = nowSec()
  const req = buildExtendReq({ id: agreementId, extraMin, by: self.identityPk }, at)
  updateAgreements((records) => applyExtendReq(records, req))
  activity.recordActivity({ id: `local-agreement-extend-req-${agreementId}-${at}`, at, kind: 'agreement-extended', circleId: circle.id, actorPk: self.identityPk, params: { stage: 'requested', extraMin: String(extraMin) } })
  const wrap = await buildExtendReqWrap(phoneSigner(), circle, req)
  await beacons.publishOrEnqueue(appRelays(p), wrap)
}

/** Guardian-only: approves or denies a pending `extend-req`. Identity-signed
 *  structural (Signet identity plan, Task 9: `extend-resp` is one of the
 *  guardian-authority structural actions, queued for the identity signer). */
export async function respondExtend(agreementId: string, ok: boolean): Promise<void> {
  const ctx = findRecordAndCircle(agreementId)
  const pendingExtend = ctx?.record.pendingExtend
  if (!ctx || !pendingExtend) return
  const { self, circle } = ctx
  if (!isGuardian(circle, self.identityPk)) return
  // Already answered from this phone and waiting on My Signet: don't queue
  // a second answer.
  if (queuePending().some((q) => q.action === 'extend-resp' && queuedExtendRespId(q.payload) === agreementId)) return
  const at = nowSec()
  const resp = buildExtendResp(
    { id: agreementId, ok, by: self.identityPk, ...(ok ? { extraMin: pendingExtend.extraMin } : {}) },
    at,
  )
  enqueue({ action: 'extend-resp', circleId: circle.id, payload: JSON.stringify(resp), label: `Answer an extension request in ${circle.name}` })
}

function queuedExtendRespId(payload: string): string | undefined {
  try { return (JSON.parse(payload) as { id?: string }).id } catch { return undefined }
}

/** Final fix round 3, F2: applies our own sent extension answer locally.
 *  Runs only after the signed event went out; if the request was answered
 *  meanwhile (no `pendingExtend` left), that answer stands. */
function applySentExtendResp(circleId: string, resp: ExtendResp): void {
  const pendingExtend = store.load().agreements.find((r) => r.agreement.id === resp.id)?.pendingExtend
  if (!pendingExtend) return
  updateAgreements((records) => applyExtendResp(records, resp))
  activity.recordActivity({ id: `local-agreement-extend-resp-${resp.id}-${resp.at}`, at: resp.at, kind: 'agreement-extended', circleId, actorPk: resp.by, params: { stage: resp.ok ? 'approved' : 'denied', extraMin: String(pendingExtend.extraMin) } })
}

// ---------------------------------------------------------------------------
// Leave reminders — impure orchestration (Task 8, brief §15). See the pure
// section above for `LeaveStage`/`leaveSchedule`/`dueLeaveStage`/
// `travelCacheFresh`/copy. Driven off `checkTick`'s own 60s loop, below.
// ---------------------------------------------------------------------------

interface TravelCacheEntry { sec: number; mode: TravelMode; destGeohash: string; routingUrl: string | undefined; computedAt: number }

/** Per-agreement travel-time cache — module-level, in-memory only (a reload
 *  just means the next tick recomputes once; same "ephemeral bookkeeping, not
 *  a fix for an observed leak" trade-off as places.ts's own `banners` map).
 *  `mode`/`destGeohash`/`routingUrl` are all part of the cached entry (not
 *  just its key) so a mode change, a place edit, or switching routing engines
 *  (review fix: `routingUrl` was missing here — a self-hoster flipping engines
 *  kept serving the OLD engine's estimate for up to `TRAVEL_CACHE_TTL_SEC`)
 *  invalidates the cache immediately rather than serving a stale estimate. */
const travelCache = new Map<string, TravelCacheEntry>()

/** Guards against two overlapping evaluations of the SAME agreement — this
 *  function awaits `travel.travelSec` (up to its own 5s engine timeout),
 *  which under normal 60s-apart ticks never overlaps, but a slow engine call
 *  stacked against a manual re-render or a delayed tick could otherwise fire
 *  a second concurrent evaluation. Same in-flight-guard idiom the codebase
 *  already uses elsewhere for exactly this shape of risk. */
const leaveEvalInFlight = new Set<string>()

/** The last-fired leave-reminder copy per agreement — child-side-only,
 *  ephemeral (never persisted, never synced: purely a "so the agreement
 *  card can show what the last local reminder said, not just the OS
 *  notification" convenience), same idiom as places.ts's own escalation
 *  `banners` map. Cleared once the agreement is no longer active (arrived,
 *  or gone) so a stale reminder never lingers on a finished agreement's
 *  card. Keyed by agreementId; each entry also records the `byUnix` it was
 *  fired against (review fix) — `leaveBannerFor` (below) drops the entry
 *  rather than serving it once the agreement's CURRENT `byUnix` no longer
 *  matches, so an extension grant (which pushes `byUnix` out) can't leave a
 *  stale "Running behind" banner showing after the deadline that made it
 *  true no longer applies. */
const leaveBanners = new Map<string, { byUnix: number; text: string }>()

/** Phase 5 Task 1 follow-up (queued from the phase-4 final review), then
 *  CORRECTED by Phase 5 Task 2's own final review (this fix). The
 *  intermediate version generalized this clear to run on EVERY
 *  `AgreementStatusKind` ('en-route' | 'arrived' | 'late'), reasoning that a
 *  stale banner should never survive a status transition — true for
 *  'en-route'/'arrived', but wrong for 'late': `checkTick`'s own auto-late
 *  branch (`isLate()` -> `sendAgreementStatus(id, 'late')`, below) funnels
 *  through this same function, so the generalized version deleted the
 *  "Running behind — ask for more time?" banner — the app's ONLY nudge
 *  toward requesting an extension — at the EXACT moment the deadline passes
 *  and the nudge starts to matter most.
 *
 *  The banner clears on exactly two things: the child RESPONDING
 *  ('en-route' — "On my way") or ARRIVING ('arrived' — the terminal state;
 *  also covers the manual "I'm here" tap, which bypasses `checkTick`'s own
 *  auto-arrival-detect branch and its own explicit `leaveBanners.delete`),
 *  OR the deadline itself moving — an extension grant, which pushes
 *  `byUnix` out; already handled WITHOUT this function, via
 *  `leaveBannerFor`'s own byUnix-staleness check, since a banner fired
 *  against the OLD `byUnix` no longer matches the record's current one.
 *  'late' triggers neither: it's not a response, and it's not the deadline
 *  changing — it's the deadline being MISSED, precisely when a guardian
 *  should keep seeing the "ask for more time?" prompt, not have it vanish
 *  out from under them. So 'late' deliberately falls through this gate and
 *  the banner SURVIVES, showing alongside the late-status notification.
 *
 *  Called from BOTH transition paths — the LOCAL tap (`sendAgreementStatus`
 *  below — what the agreement card's "On my way"/"I'm here" buttons call,
 *  and also what `checkTick`'s auto-arrival/auto-late branches call) and an
 *  INCOMING `agreement-status` signal (`handleIncomingSignal`'s own case) —
 *  each passing the status being applied so this can gate on it.
 *  Idempotent — a no-op if there was nothing to clear, or if `status` isn't
 *  one of the two that should clear it. */
function clearLeaveBanner(agreementId: string, status: AgreementStatusKind): void {
  if (status !== 'en-route' && status !== 'arrived') return
  leaveBanners.delete(agreementId)
}

/** Drops any `Persisted.leaveFired` entry that no longer describes the
 *  agreement's CURRENT state: either its agreementId (the key's segment
 *  before its first `:`) no longer appears in `p.agreements` at all (mirrors
 *  places.ts's `pruneOrphanedWindowMarks` — forward hygiene: agreements are
 *  never deleted anywhere in this codebase today, so this guards a future
 *  removal path rather than an observed leak), OR the agreement is still
 *  live but this key's `byUnix` segment no longer matches the agreement's
 *  CURRENT `byUnix` (review fix: an extension grant supersedes the old
 *  schedule's fired-stage keys, but they were never pruned — left forever as
 *  dead weight, and would have silently suppressed a REFIRED stage had the
 *  same byUnix ever recurred). Agreement ids are plain hex (`newAgreementId`
 *  — `randomHex`), never containing `:`, so splitting on the first `:` to
 *  recover the id is unambiguous. Called once per `checkTick`, same "cheap,
 *  so just do it every tick" choice `pruneOrphanedWindowMarks` itself
 *  makes. */
export function pruneOrphanedLeaveFired(p: store.Persisted): void {
  const byUnixForId = new Map(p.agreements.map((r) => [r.agreement.id, r.agreement.byUnix]))
  const stale = Object.keys(p.leaveFired).filter((key) => {
    const [id, byUnixSeg] = key.split(':')
    const liveByUnix = byUnixForId.get(id ?? key)
    return liveByUnix === undefined || byUnixSeg !== String(liveByUnix)
  })
  if (!stale.length) return
  store.update((sp) => {
    const next = { ...sp.leaveFired }
    for (const key of stale) delete next[key]
    sp.leaveFired = next
  })
}

/** Prunes `Persisted.agreementTravelMode` entries whose agreementId (the
 *  bare key — unlike `leaveFired` there's no `:byUnix` segment to also
 *  check, since a travel-mode CHOICE doesn't depend on the deadline the way
 *  a fired-stage marker does) no longer appears in `p.agreements` — same
 *  forward-hygiene reasoning as `pruneOrphanedLeaveFired` right above
 *  (agreements are never deleted anywhere in this codebase today), called
 *  from the SAME `checkTick` pass, right alongside it (final-review fix 6).
 *  `Persisted.viewPrefs` gets NO equivalent prune — see that field's own
 *  doc comment in store.ts: a member can rejoin, and a stale viewing
 *  preference surviving in the meantime is harmless, unlike an agreement id
 *  that's gone for good once superseded. */
export function pruneOrphanedAgreementTravelMode(p: store.Persisted): void {
  const liveIds = new Set(p.agreements.map((r) => r.agreement.id))
  const stale = Object.keys(p.agreementTravelMode).filter((id) => !liveIds.has(id))
  if (!stale.length) return
  store.update((sp) => {
    const next = { ...sp.agreementTravelMode }
    for (const id of stale) delete next[id]
    sp.agreementTravelMode = next
  })
}

/** Child-only: sets this device's chosen travel mode for `agreementId` — the
 *  agreement card's mode picker's write side, applied immediately (same
 *  "click applies, no separate save step" idiom as
 *  `beacons.setCircleBaselinePrecision`/`battery.setShareBattery`). Local-
 *  only, never published to the wire (see `Persisted.agreementTravelMode`'s
 *  own doc comment). */
export function setAgreementTravelMode(agreementId: string, mode: TravelMode): void {
  store.update((p) => {
    p.agreementTravelMode = { ...p.agreementTravelMode, [agreementId]: mode }
  })
}

/** The leave-reminder banner text last shown for `agreementId`, if a stage
 *  has fired and the agreement is still active — read by the card view.
 *  `byUnix` is the agreement's CURRENT deadline (the caller's own
 *  `r.agreement.byUnix`, read fresh from the store on every render); a
 *  banner recorded against an OLDER `byUnix` is stale (the agreement was
 *  extended since) and is dropped here rather than served — see
 *  `leaveBanners`'s own doc comment (review fix). */
export function leaveBannerFor(agreementId: string, byUnix: number): string | undefined {
  const entry = leaveBanners.get(agreementId)
  if (!entry) return undefined
  if (entry.byUnix !== byUnix) {
    leaveBanners.delete(agreementId)
    return undefined
  }
  return entry.text
}

/** One agreement's leave-reminder evaluation for this tick — async because
 *  it may call `travel.travelSec` (network, up to its own 5s timeout);
 *  `checkTick` fires this with `void`, same non-blocking discipline as its
 *  neighbouring `sendAgreementStatus` calls. Never throws (mirrors
 *  `travel.travelSec`'s own contract): any failure here just means no
 *  reminder fires this tick, tried again next tick. */
export async function evaluateLeaveReminder(p: store.Persisted, selfPk: string, record: store.AgreementRecord, now: number): Promise<void> {
  const agreementId = record.agreement.id
  const place = record.agreement.place
  // Label-only place (no geohash) — no destination to route to at all.
  // Documented gap (task contract): a guardian who proposes a place by name
  // only, without ever using "use my current location," gets no leave
  // reminders for that agreement. Nothing to evaluate; not an error.
  if (!place?.geohash) return
  if (leaveEvalInFlight.has(agreementId)) return
  const fix = beacons.selfFix()
  if (!fix) return // nothing to route FROM yet
  leaveEvalInFlight.add(agreementId)
  try {
    const mode: TravelMode = p.agreementTravelMode[agreementId] ?? 'walk'
    const dest = decodeGeohash(place.geohash)
    const cached = travelCache.get(agreementId)
    let travelSecValue: number
    if (cached && cached.mode === mode && cached.destGeohash === place.geohash && cached.routingUrl === p.settings.routingUrl && travelCacheFresh(cached.computedAt, now)) {
      travelSecValue = cached.sec
    } else {
      const result = await travel.travelSec({ lat: fix.lat, lon: fix.lon }, { lat: dest.lat, lon: dest.lon }, mode, p.settings.routingUrl)
      travelSecValue = result.sec
      travelCache.set(agreementId, { sec: result.sec, mode, destGeohash: place.geohash, routingUrl: p.settings.routingUrl, computedAt: now })
    }

    // Re-check against FRESH state: this awaited a network call, so local
    // state may have moved on (arrived, extended, or — hypothetically —
    // the agreement gone) while it was in flight.
    //
    // Final-review fix 1 (§8): gate on 'acked' ONLY, not 'acked'||'en-route'.
    // Leave reminders exist to get the child MOVING — every stage ('soon',
    // 'now', AND 'behind') is a nag toward that one goal. Once the child has
    // reported 'en-route', they're already moving, so the whole schedule is
    // moot, not just 'behind' (the narrowest reading of "still not
    // en-route/arrived" would keep 'soon'/'now' live for an en-route child,
    // but "leave now" to someone already travelling is just as pointless a
    // nag as "you're running behind"). This also closes a race: if status
    // flips to 'en-route' while THIS call is awaiting travel.travelSec above
    // (or simply between the 'now' and 'behind' ticks), the re-read here
    // catches it and suppresses the still-pending 'behind' stage too.
    const fresh = store.load()
    const freshRecord = fresh.agreements.find((r) => r.agreement.id === agreementId)
    if (!freshRecord || freshRecord.status !== 'acked') {
      leaveBanners.delete(agreementId)
      return
    }
    const byUnix = freshRecord.agreement.byUnix
    const stages = leaveSchedule(byUnix, travelSecValue)
    const prefix = `${agreementId}:${byUnix}:`
    const localFired: Record<string, true> = {}
    for (const key of Object.keys(fresh.leaveFired)) {
      if (key.startsWith(prefix)) localFired[key.slice(prefix.length)] = true
    }
    const due = dueLeaveStage(stages, localFired, now)
    if (!due) return

    const placeLabel = freshRecord.agreement.place?.label || 'the meeting place'
    const body = leaveStageCopy(due.stage, placeLabel, travelSecValue, byUnix)

    // Mark every currently-due stage fired, not just the one this notifies
    // for — see `dueLeaveStage`'s own doc comment on why (otherwise a stage
    // collapsed away THIS tick would simply resurface as newly-due next
    // tick, turning the collapse into a delayed burst instead of a real one).
    const dueNow = stages.filter((s) => s.atUnix <= now)
    store.update((sp) => {
      const next = { ...sp.leaveFired }
      for (const s of dueNow) next[`${prefix}${s.stage}`] = true
      sp.leaveFired = next
    })
    activity.recordActivity({
      id: `local-leave-reminder-${agreementId}-${byUnix}-${due.stage}`,
      at: now,
      kind: 'leave-reminder',
      circleId: freshRecord.agreement.circleId,
      // Activity's actorPk is "who is this event about" (drives name
      // resolution — activity.ts's `resolveName`), unrelated to notify()'s
      // own actorPk semantics below — stays `selfPk` (this device/child).
      actorPk: selfPk,
      params: { place: placeLabel, stage: due.stage },
    })
    leaveBanners.set(agreementId, { byUnix, text: body })
    // notify()'s actorPk argument is ONLY a same-device consolidation key
    // (brief §29, `CONSOLIDATE_WINDOW_SEC` = 300s) — not a "who is this
    // about" field. Passing `fam.pkHex` here (review fix, was the bug) meant
    // EVERY leave-reminder this device ever fires — any stage, any
    // agreement — shared one consolidation slot: concurrent agreements
    // cross-suppressed each other, and 'behind' (which fires exactly
    // `LEAVE_BEHIND_LAG_SEC` = 300s after 'now', precisely
    // `CONSOLIDATE_WINDOW_SEC`) was starved outright, since
    // `shouldFireNotification`'s boundary is a strict `>` and an exact 300s
    // gap never clears it. A per-agreement-per-stage key gives each stage of
    // each agreement its own slot, so none of them can suppress another.
    void notify('leave-reminder', `${agreementId}:${due.stage}`, 'Leave reminder', body)
  } finally {
    leaveEvalInFlight.delete(agreementId)
  }
}

// ---------------------------------------------------------------------------
// Child-side timer — arrival auto-detect + the late check, both on the same
// 60s tick (task contract: "isLate check on a 60s timer"). Leave-reminder
// evaluation (Task 8) rides the SAME tick — see the section above.
// ---------------------------------------------------------------------------

// Exported for tests only (real-path coverage of the checkTick auto-late ->
// clearLeaveBanner interaction the review flagged) — every other caller is
// internal (`ensure`'s own initial call + its `setInterval`).
export function checkTick(): void {
  const p = store.load()
  const self = currentSession()
  if (!self) return
  const fix = beacons.selfFix()
  const now = nowSec()
  for (const record of p.agreements) {
    if (record.agreement.child !== self.identityPk) continue
    if (record.status !== 'acked' && record.status !== 'en-route' && record.status !== 'late') continue
    if (hasArrivedAt(record.agreement.place, fix)) {
      void sendAgreementStatus(record.agreement.id, 'arrived')
      leaveBanners.delete(record.agreement.id)
      continue
    }
    if (record.status !== 'late' && isLate(record.agreement, record.arrivedAt, now)) {
      void sendAgreementStatus(record.agreement.id, 'late')
    }
    // Leave reminders (brief §15): only while 'acked' — before the child has
    // reported moving at all AND before the agreement's own lateness has
    // kicked in. 'late' is excluded because the existing late-status
    // notification above already covers "tell someone." 'en-route' is
    // excluded too (final-review fix 1, §8, see `evaluateLeaveReminder`'s own
    // doc comment on the re-check below): reminders exist to get the child
    // moving, and 'en-route' means they already are — every stage would be a
    // moot nag, not just 'behind'.
    if (record.status === 'acked') {
      void evaluateLeaveReminder(p, self.identityPk, record, now)
    }
  }
  pruneOrphanedLeaveFired(p)
  pruneOrphanedAgreementTravelMode(p) // final-review fix 6 — same pass, same forward-hygiene reasoning
}

// ---------------------------------------------------------------------------
// Incoming — registered with beacons.ts as an ADDITIONAL handler for
// non-beacon circle-inbox signals (alongside safety.ts's own — see
// beacons.ts's `setSignalHandler` doc comment).
// ---------------------------------------------------------------------------

export function handleIncomingSignal(circle: Circle, rumor: Rumor, t: string, sender: beacons.Sender): void {
  const self = currentSession()
  // Self-echo: this device already applied its own reducer synchronously the
  // moment it sent the signal — see the module doc comment. Re-applying the
  // wire echo would be redundant at best (the reducers are idempotent-safe
  // for it) and at worst race a NEWER local change with a stale snapshot of
  // the signal it already knows about.
  if (self && sender.signerPk === self.phonePk) return
  const signal = decodeBroodSignal(rumor, sender)
  if (!signal) return
  // Receive side records the peer's action (task contract) — one id per
  // wire event (the rumor's own, or its synthetic fallback, same idiom as
  // safety.ts's own receive path), reused for whichever kind fires below.
  const rid = rumor.id ?? `${t}-${sender.memberPk}-${rumor.created_at}`
  switch (signal.t) {
    case 'agreement':
      // Review fix round 1: `agreement` is a STRUCTURAL action — a
      // phone-signed copy must never apply (beacons.ts's choke point
      // already drops a phone-signed structural `t`; this is the same
      // belt-and-braces re-check every other structural handler here makes).
      if (!sender.structural) return
      // Review fix round 1: bind authority to the circle this signal
      // actually arrived on — a guardian of circle A proposing a genuine
      // agreement for circle B must not have it applied just because this
      // device happened to receive it on A's inbox.
      if (signal.circleId !== circle.id) return
      // sender-auth: ffb48b9 class — BROOD.md §3: `from` names the
      // proposer (the resolved sender); it must equal it. `child` names a
      // THIRD PARTY (who's being picked up) and is never bound to the
      // sender.
      if (signal.from !== sender.memberPk) return
      updateAgreements((records) => upsertProposedAgreement(records, signal))
      activity.recordActivity({ id: rid, at: signal.at, kind: 'agreement-created', circleId: circle.id, actorPk: signal.from, params: signal.place?.label ? { place: signal.place.label } : {} })
      return
    case 'agreement-ack':
      // sender-auth: ffb48b9 class — BROOD.md §3: `by` names the
      // acknowledging recipient (the resolved sender).
      if (signal.by !== sender.memberPk) return
      updateAgreements((records) => applyAgreementAck(records, signal))
      activity.recordActivity({ id: rid, at: signal.at, kind: 'agreement-acked', circleId: circle.id, actorPk: signal.by, params: {} })
      return
    case 'agreement-status': {
      // sender-auth: ffb48b9 class — BROOD.md §3: `by` names the tracked
      // party reporting status (the resolved sender).
      if (signal.by !== sender.memberPk) return
      updateAgreements((records) => applyAgreementStatus(records, signal))
      clearLeaveBanner(signal.id, signal.status)
      const inserted = activity.recordActivity({ id: rid, at: signal.at, kind: 'agreement-status', circleId: circle.id, actorPk: signal.by, params: { status: signal.status } })
      // Task 9 (brief §12/§29): only 'late' is notification-worthy here —
      // 'en-route'/'arrived' are routine progress a guardian can check the
      // Circles tab for, but a guardian should learn "running late" even with
      // the app closed, same urgency tier as safety.ts/places.ts's own kinds.
      if (signal.status === 'late' && shouldNotifyForEvent(inserted, signal.at, nowSec())) {
        const name = circle.members.find((m) => m.pk === signal.by)?.name || shortPk(signal.by)
        // Language sweep (§31, review-minor): 'late' is a banned word in
        // rendered copy — same "hasn't arrived yet" phrasing places.ts's own
        // arrival-window copy uses. The wire status value stays `'late'`.
        void notify('agreement-status', signal.by, `${name} hasn't arrived yet`, circle.name)
      }
      return
    }
    case 'extend-req':
      // sender-auth: ffb48b9 class — BROOD.md §3: `by` names the tracked
      // party requesting the extension (the resolved sender).
      if (signal.by !== sender.memberPk) return
      updateAgreements((records) => applyExtendReq(records, signal))
      activity.recordActivity({ id: rid, at: signal.at, kind: 'agreement-extended', circleId: circle.id, actorPk: signal.by, params: { stage: 'requested', extraMin: String(signal.extraMin) } })
      return
    case 'extend-resp': {
      // Review fix round 1: `extend-resp` is a STRUCTURAL action — same
      // belt-and-braces re-check as `agreement` above.
      if (!sender.structural) return
      // Review fix round 1: `extend-resp` itself carries no `circleId`
      // (brood-kit's own shape — see `parseExtendResp`), so authority is
      // bound to the TRACKED AGREEMENT's own circle instead, checked before
      // any mutation — same "record's circle, not the arrival inbox alone"
      // discipline as approvals.ts's own `approval-resp` binding.
      const tracked = store.load().agreements.find((r) => r.agreement.id === signal.id)
      if (tracked && tracked.agreement.circleId !== circle.id) return
      // sender-auth: ffb48b9 class — BROOD.md §3: `by` names the guardian
      // granting/refusing the extension (the resolved sender).
      if (signal.by !== sender.memberPk) return
      updateAgreements((records) => applyExtendResp(records, signal))
      activity.recordActivity({ id: rid, at: signal.at, kind: 'agreement-extended', circleId: circle.id, actorPk: signal.by, params: { stage: signal.ok ? 'approved' : 'denied', extraMin: String(signal.extraMin ?? '') } })
      return
    }
    default:
      // family-policy / approval-req / approval-resp — approvals.ts's concern.
      return
  }
}

/** Registers the structural queue's senders this module owns
 *  (`agreement`/`extend-resp` — Signet identity plan, Task 9), same pattern
 *  as circles.ts's/approvals.ts's own `registerStructuralSenders`. */
export function registerStructuralSenders(): void {
  registerSender('agreement', async (signed, item) => {
    const c = store.load().circles.find((x) => x.id === item.circleId)
    if (!c) return
    await beacons.sendStructural(c, signed)
    if (!stillEnqueuingSession(item)) return // final fix round 4
    applySentAgreement(c.id, JSON.parse(item.payload) as Agreement)
  })
  registerSender('extend-resp', async (signed, item) => {
    const c = store.load().circles.find((x) => x.id === item.circleId)
    if (!c) return
    await beacons.sendStructural(c, signed)
    if (!stillEnqueuingSession(item)) return // final fix round 4
    applySentExtendResp(c.id, JSON.parse(item.payload) as ExtendResp)
  })
}

/** Registers this module's incoming-signal handler and active-agreement
 *  provider with beacons.ts, and starts the 60s arrival/late-check timer.
 *  Called from app.ts's render() alongside circles.ensure/beacons.ensure/
 *  safety.ensure — same idempotent "the one side-effecting entry point"
 *  idiom as all three. */
let registered = false
export function ensure(): void {
  if (registered) return
  registered = true
  registerStructuralSenders()
  beacons.setSignalHandler(handleIncomingSignal)
  beacons.setActiveAgreementProvider(activeAgreementFor)
  checkTick() // don't make a just-acked agreement wait out a stale up-to-60s-old tick
  setInterval(checkTick, CHECK_INTERVAL_MS)
}

// ---------------------------------------------------------------------------
// View — a Home-tab section: pending/active agreement cards, and a
// guardian's "new agreement" flow. UI wiring only past this point — no unit
// tests (build-gated), same convention as circles.ts/safety.ts.
// ---------------------------------------------------------------------------

// Language sweep (§31, review-minor): 'Late' is a banned word in rendered
// copy as of this phase's expanded §31 list — 'Not yet arrived' says the
// same thing neutrally, matching places.ts's own arrival-window vocabulary.
// The wire status value (`store.AgreementLifecycleStatus`) stays `'late'`.
const STATUS_LABELS: Record<store.AgreementLifecycleStatus, string> = {
  proposed: 'Waiting for ack',
  acked: 'Acknowledged',
  'en-route': 'On the way',
  arrived: 'Arrived',
  late: 'Not yet arrived',
}

const TRAVEL_MODE_LABELS: Record<TravelMode, string> = { walk: 'Walking', cycle: 'Cycling', drive: 'Driving' }
const TRAVEL_MODES: readonly TravelMode[] = ['walk', 'cycle', 'drive']

/** The child's travel-mode picker for one agreement (Task 8, brief §15) —
 *  three chips, current selection marked `aria-current`, applied immediately
 *  on click (`agreement-travel-mode-set`, same "click applies, no separate
 *  save step" idiom as `baselinePickerView`/`shareBattery`'s own toggle in
 *  app.ts/battery.ts). Only rendered when there's a geohash destination to
 *  actually route to — a picker for a label-only place would change
 *  nothing (see `evaluateLeaveReminder`'s own doc comment on that gap). */
function travelModePickerView(p: store.Persisted, agreementId: string): string {
  const current = p.agreementTravelMode[agreementId] ?? 'walk'
  const chips = TRAVEL_MODES.map((mode) => `
    <button type="button" class="precision-chip" data-action="agreement-travel-mode-set"
      data-id="${esc(agreementId)}" data-mode="${mode}" aria-current="${mode === current}">${TRAVEL_MODE_LABELS[mode]}</button>`).join('')
  return `<div class="precision-chips">${chips}</div>`
}

export function view(p: store.Persisted, fam: SessionInfo): string {
  const cards = p.agreements.map((r) => agreementCardView(p, fam, r)).filter((s) => s.length > 0)
  const cardsView = cards.length ? `<section class="contact-group"><h2>Agreements</h2>${cards.join('')}</section>` : ''
  return cardsView + guardianCreateView(p, fam)
}

function agreementCardView(p: store.Persisted, fam: SessionInfo, r: store.AgreementRecord): string {
  if (r.status === 'arrived') return ''
  const circle = p.circles.find((c) => c.id === r.agreement.circleId)
  if (!circle) return ''
  const isChild = r.agreement.child === fam.identityPk
  const isGuardianHere = isGuardian(circle, fam.identityPk)
  if (!isChild && !isGuardianHere) return ''

  const childName = circle.members.find((m) => m.pk === r.agreement.child)?.name || shortPk(r.agreement.child)
  const place = r.agreement.place?.label ? esc(r.agreement.place.label) : 'an unspecified place'
  const byTime = esc(new Date(r.agreement.byUnix * 1000).toLocaleString())
  // Language sweep (§31, review-minor): neutral phrasing, no "late".
  const late = r.status === 'late' ? `<p class="form-error">Hasn't arrived yet — was due ${byTime}.</p>` : ''
  // Task 8 (brief §15): the child's own travel-mode picker + the last-fired
  // local leave-reminder, if any — both child-only (leave reminders are
  // evaluated purely on the child's own device, see the module doc comment),
  // and only meaningful when there's a geohash destination to route to.
  const travelPicker = isChild && r.agreement.place?.geohash ? travelModePickerView(p, r.agreement.id) : ''
  const leaveBanner = isChild ? leaveBannerFor(r.agreement.id, r.agreement.byUnix) : undefined
  const leaveBannerHtml = leaveBanner ? `<p class="form-error">${esc(leaveBanner)}</p>` : ''

  const actions: string[] = []
  if (isChild) {
    if (r.status === 'proposed') {
      actions.push(`<button type="button" data-action="agreement-ack" data-id="${esc(r.agreement.id)}">Acknowledge</button>`)
    } else {
      if (r.status === 'acked') {
        actions.push(`<button type="button" data-action="agreement-en-route" data-id="${esc(r.agreement.id)}">On my way</button>`)
      }
      actions.push(`<button type="button" data-action="agreement-arrived" data-id="${esc(r.agreement.id)}">I'm here</button>`)
      if (r.pendingExtend) {
        actions.push(`<span class="badge">+${r.pendingExtend.extraMin}m requested</span>`)
      } else {
        for (const mins of EXTEND_CHIP_MINUTES) {
          actions.push(`<button type="button" data-action="agreement-extend-${mins}" data-id="${esc(r.agreement.id)}">+${mins} min</button>`)
        }
      }
    }
  }
  if (isGuardianHere && r.pendingExtend) {
    actions.push(`<span class="badge">${esc(childName)} asked for +${r.pendingExtend.extraMin}m</span>`)
    actions.push(`<button type="button" data-action="agreement-extend-approve" data-id="${esc(r.agreement.id)}">Approve</button>`)
    actions.push(`<button type="button" data-action="agreement-extend-deny" data-id="${esc(r.agreement.id)}">Deny</button>`)
  }

  return `
    <div class="agreement-card">
      <div><strong>${esc(childName)}</strong> — ${place} by ${byTime} <span class="badge">${STATUS_LABELS[r.status]}</span></div>
      ${late}
      ${leaveBannerHtml}
      ${travelPicker}
      <div class="actions">${actions.join('')}</div>
    </div>
  `
}

interface CreateState { circleId: string; error?: string; childPk?: string }
let createState: CreateState | null = null

/** Opens the guardian "new agreement" form for `circleId`, optionally
 *  pre-selecting `childPk` — messages.ts's "Be home by…" quick-chip (Task 5,
 *  brief §14.3) links here rather than duplicating the create flow: the
 *  chip's chat context already knows which child it's about (a DM peer) or
 *  leaves the choice to the existing `<select>` (a circle-chat context, no
 *  single child). Exported for that cross-module call — same "the domain
 *  module that owns a flow exposes one entry point for another module to
 *  trigger it" idiom as `requestPickup`/`triggerCheckin` in safety.ts. */
export function openCreateAgreementFor(circleId: string, childPk?: string): void {
  createState = { circleId, ...(childPk ? { childPk } : {}) }
  store.notify()
}

function guardianCreateView(p: store.Persisted, fam: SessionInfo): string {
  if (fam.dependant) return ''
  const guardianCircles = p.circles.filter((c) => isGuardian(c, fam.identityPk) && c.members.some((m) => m.role === 'child'))
  if (!guardianCircles.length) return ''

  if (createState) {
    const circle = p.circles.find((c) => c.id === createState?.circleId)
    if (circle) return createFormView(circle, createState)
    createState = null
  }

  const buttons = guardianCircles
    .map((c) => `<button type="button" data-action="agreement-new" data-circle="${esc(c.id)}">New agreement — ${esc(c.name)}</button>`)
    .join('')
  return `<section class="contact-group"><h2>New agreement</h2>${buttons}</section>`
}

function createFormView(circle: Circle, state: CreateState): string {
  const err = state.error ? `<p class="form-error">${esc(state.error)}</p>` : ''
  const childOptions = circle.members
    .filter((m) => m.role === 'child')
    .map((m) => `<option value="${esc(m.pk)}"${m.pk === state.childPk ? ' selected' : ''}>${esc(m.name || shortPk(m.pk))}</option>`)
    .join('')
  return `
    <section class="contact-group">
      <h2>New agreement — ${esc(circle.name)}</h2>
      <select id="agreement-child">${childOptions}</select>
      <input id="agreement-place-label" type="text" placeholder="Place (e.g. School gate)" />
      <label class="confirm-gate"><input type="checkbox" id="agreement-use-location" /> Use my current location</label>
      <input id="agreement-by-time" type="datetime-local" />
      <div class="schedule-chips">
        <label><input type="radio" name="agreement-schedule" value="default" checked /> Coarse until 15 min before, then precise</label>
        <label><input type="radio" name="agreement-schedule" value="precise" /> Precise the whole time</label>
      </div>
      <input id="agreement-note" type="text" placeholder="Note (optional)" />
      ${err}
      <button type="button" data-action="agreement-create-submit" data-circle="${esc(circle.id)}">Send agreement</button>
      <button type="button" data-action="agreement-new-cancel">Cancel</button>
    </section>
  `
}

function submitCreateAgreement(circleId: string): void {
  if (!createState || createState.circleId !== circleId) return
  const circle = store.load().circles.find((c) => c.id === circleId)
  if (!circle) { createState = null; store.notify(); return }

  const childPk = (document.getElementById('agreement-child') as HTMLSelectElement | null)?.value ?? ''
  const label = inputValue('agreement-place-label')
  const useLocation = (document.getElementById('agreement-use-location') as HTMLInputElement | null)?.checked ?? false
  const byRaw = (document.getElementById('agreement-by-time') as HTMLInputElement | null)?.value ?? ''
  const scheduleKind = (document.querySelector('input[name="agreement-schedule"]:checked') as HTMLInputElement | null)?.value
  const note = inputValue('agreement-note')

  if (!childPk) { createState = { circleId, error: 'Choose a child.' }; store.notify(); return }
  const byDate = byRaw ? new Date(byRaw) : null
  if (!byDate || Number.isNaN(byDate.getTime())) { createState = { circleId, error: 'Choose a valid time.' }; store.notify(); return }
  const byUnix = Math.floor(byDate.getTime() / 1000)

  const fix = useLocation ? beacons.selfFix() : null
  const place = label
    ? { label, ...(fix ? { geohash: encodeGeohash(fix.lat, fix.lon, PLACE_PRECISION) } : {}) }
    : undefined
  const schedule = scheduleKind === 'precise' ? PRECISE_SCHEDULE : DEFAULT_SCHEDULE

  // Submitted: the form starts afresh (form-state.ts's `clearField`).
  clearFields(['agreement-child', 'agreement-place-label', 'agreement-use-location', 'agreement-by-time', 'agreement-note'])
  createState = null
  void proposeAgreement(circleId, {
    child: childPk,
    byUnix,
    schedule,
    ...(place ? { place } : {}),
    ...(note ? { note } : {}),
  })
  store.notify()
}

function inputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? ''
}

function shortPk(pk: string): string {
  return `${pk.slice(0, 8)}…`
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

// ---------------------------------------------------------------------------
// Action dispatch — app.ts delegates every `agreement-*` data-action here.
// ---------------------------------------------------------------------------

export function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'agreement-new':
      createState = { circleId: node.dataset.circle ?? '' }
      store.notify()
      break
    case 'agreement-new-cancel':
      createState = null
      store.notify()
      break
    case 'agreement-create-submit':
      submitCreateAgreement(node.dataset.circle ?? '')
      break
    case 'agreement-ack':
      void ackAgreement(node.dataset.id ?? '')
      break
    case 'agreement-en-route':
      void sendAgreementStatus(node.dataset.id ?? '', 'en-route')
      break
    case 'agreement-arrived':
      void sendAgreementStatus(node.dataset.id ?? '', 'arrived')
      break
    case 'agreement-extend-15':
      void requestExtend(node.dataset.id ?? '', 15)
      break
    case 'agreement-extend-30':
      void requestExtend(node.dataset.id ?? '', 30)
      break
    case 'agreement-extend-approve':
      void respondExtend(node.dataset.id ?? '', true)
      break
    case 'agreement-extend-deny':
      void respondExtend(node.dataset.id ?? '', false)
      break
    case 'agreement-travel-mode-set': {
      // Task 8 (brief §15): the agreement card's travel-mode picker —
      // applies immediately, same idiom as 'privacy-baseline-set'/
      // 'battery-share-toggle' in app.ts/battery.ts.
      const id = node.dataset.id ?? ''
      const mode = node.dataset.mode
      if (id && (mode === 'walk' || mode === 'cycle' || mode === 'drive')) setAgreementTravelMode(id, mode)
      break
    }
    default:
      break
  }
}
