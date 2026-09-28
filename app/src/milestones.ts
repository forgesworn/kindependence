// Independence milestones (Phase 6 Task 2, design spec §2, brief §2.3 "gradually
// granting greater freedom" / §2.4 / §35): guardian tooling to relax settings
// DELIBERATELY, with the app suggesting WHEN — nothing here ever auto-applies
// anything. Two independent pieces:
//
//  - Three labelled level presets (`LEVELS`) a guardian explicitly applies,
//    per child, per circle (`applyLevel`) — a SINGLE tap that writes every
//    knob a guardian actually controls (place grace/escalation via the
//    EXISTING `places.savePlaces`, family-policy verdicts via the EXISTING
//    `approvals.publishFamilyPolicy`) and RECOMMENDS the child-side baseline
//    as a proposal card on the child's own device — the child taps Accept
//    (§34.17's joint agreement), never something a guardian can force onto
//    another device directly (baseline precision is per-device
//    self-disclosure — see beacons.ts's own doc comment on
//    `circleBasePrecision`). Every applied change rides an EXISTING
//    mechanism, so existing transparency (the 'policy-changed' Activity a
//    publish already fires, notifications, etc.) fires completely unchanged
//    — this module adds exactly one NEW Activity kind of its own
//    ('independence-applied') for the guardian's own action, nothing more.
//
//  - A pure "has it been quiet a while" heuristic (`stepUpSuggestion`) a
//    guardian's You tab renders as a per-dependant suggestion card — apply
//    is just `applyLevel` again (one tap), dismiss re-arms only after
//    ANOTHER full quiet streak (`dismissStepUp`/`stepUpDismissedUntil`).
//    Evaluated weekly, piggybacked onto places.ts's already-running `tick()`
//    via `places.registerPeriodicHook` (a registration, not an import —
//    places.ts must not import this module back, same registration-not-
//    import discipline approvals.ts's own module doc comment documents for
//    circles.ts/beacons.ts) rather than a second `setInterval` of its own —
//    see `evaluateStepUpsIfDue`'s own doc comment for exactly what that
//    weekly pass does (housekeeping only; the heuristic itself is pure and
//    re-derives everything fresh from `p.activity` on every call,
//    independent of whether that housekeeping has run recently).
//
// The child-side half of the proposal — the 'suggest-baseline' structured DM
// chip itself (encode/decode, the card + Accept button, notify) — lives in
// messages.ts (see its own "Phase 6 Task 2" section): this module only ever
// calls `messages.sendSuggestBaseline`, never touches the wire directly.
//
// A third piece (Phase 6 Task 3, design spec §3, brief §2.4/§34.17-18):
// `AGE_BANDS`/`bundleSummary`, the age-based setup wizard's own interface —
// "bundles ARE levels" (task contract), so they live here rather than
// inventing a fourth mechanic in wizard.ts, which owns only the 3-step UI
// shell (age band -> summary card -> Apply/Skip) and calls `applyLevel`
// directly for Apply. Distinct from this module's own `view`/`handleAction`
// below (the You-tab "Independence" card, per-circle level buttons) — the
// wizard is a separate, guardian-initiated FIRST-RUN-STYLE flow, not this
// card's ongoing controls; both ultimately call the SAME `applyLevel`.
//
// §31 (language): every rendered string below is `[copy]`-flagged —
// independence language only, "earn"/"reward"/"points" are BANNED words
// (this is a settings change a guardian makes deliberately, never something
// a child unlocks by behaving well).
//
// `[maintainer-review]`: LEVELS' preset contents (grace minutes, recommended
// baseline, policy verdicts), `QUIET_STREAK_DAYS`, and every copy string
// below — see LEVELS' own doc comment for the specific policy-verdict
// mapping rationale.

import * as store from './store.js'
import type { SessionInfo } from './session.js'
import * as places from './places.js'
import * as approvals from './approvals.js'
import * as activity from './activity.js'
import * as messages from './messages.js'
import { currentSession } from './session.js'
import { precisionTerm } from './mapinfo.js'
import { isGuardian } from '@forgesworn/covey-kit'
import type { Circle, CircleMember } from '@forgesworn/covey-kit'
import type { PolicyAction, PolicyVerdict } from '@forgesworn/brood-kit'

const nowSec = (): number => Math.floor(Date.now() / 1000)

// ---------------------------------------------------------------------------
// Levels — the task's own interface, verbatim.
// ---------------------------------------------------------------------------

export interface LevelPreset {
  label: string
  graceMinutes: number
  escalation: 'grace'
  recommendedBaseline: 4 | 6 | 7
  policyVerdicts: Partial<Record<PolicyAction, PolicyVerdict>>
}

/** `[maintainer-review]`: the whole table — every number and every verdict
 *  below is a conservative starting point, not a researched default, and is
 *  meant to be tuned by editing this table alone (task contract: "mechanics
 *  built to be tuned by copy/threshold edits, not rework").
 *
 *  `policyVerdicts` maps REAL `PolicyAction` ids (`approvals.POLICY_ACTIONS`
 *  — brood-kit's own closed 4-value enum: `create-circle`/`add-member`/
 *  `join-circle`/`add-contact`; there is no 5th "leave-area" action here —
 *  that one is local-only, per-guardian-device, and stays whatever
 *  `Persisted.leaveAreaPolicy` already has, untouched by a level apply, see
 *  approvals.ts's own doc comment on why it can never ride this wire
 *  signal). Rationale, level by level:
 *   - 1 "Close": every action `prompt` — task contract "policy prompts on",
 *     the most conservative setting BROOD.md's four-action set offers (never
 *     `deny`, which would just break the feature outright rather than ask).
 *   - 2 "Growing": `join-circle`/`add-contact` move to `allow` ("some
 *     allows", task contract) — day-to-day social actions a growing child
 *     plausibly needs to self-serve; `create-circle`/`add-member` STAY
 *     `prompt` — the two actions with the broadest structural blast radius
 *     (a new circle, or a new person added to an EXISTING one) stay gated
 *     one notch longer than the rest.
 *   - 3 "Trusted": `add-member`/`join-circle`/`add-contact` all `allow`
 *     ("most actions Allow", task contract — three of four, not all four);
 *     `create-circle` alone stays `prompt` — spinning up an entirely new
 *     circle is the one action conservative enough to keep a guardian in
 *     the loop even at the top level, by design, not an oversight.
 *  `graceMinutes`/`escalation`/`recommendedBaseline` are the design spec's
 *  own numbers verbatim (§2: "1 Close (Street 7, grace 5); 2 Growing
 *  (Neighbourhood 6, grace 10); 3 Trusted (Town 4 baseline, grace 15)"). */
export const LEVELS: Record<1 | 2 | 3, LevelPreset> = {
  1: {
    label: 'Close', graceMinutes: 5, escalation: 'grace', recommendedBaseline: 7,
    policyVerdicts: { 'create-circle': 'prompt', 'add-member': 'prompt', 'join-circle': 'prompt', 'add-contact': 'prompt' },
  },
  2: {
    label: 'Growing', graceMinutes: 10, escalation: 'grace', recommendedBaseline: 6,
    policyVerdicts: { 'create-circle': 'prompt', 'add-member': 'prompt', 'join-circle': 'allow', 'add-contact': 'allow' },
  },
  3: {
    label: 'Trusted', graceMinutes: 15, escalation: 'grace', recommendedBaseline: 4,
    policyVerdicts: { 'create-circle': 'prompt', 'add-member': 'allow', 'join-circle': 'allow', 'add-contact': 'allow' },
  },
}

/** `Persisted.independenceLevel`/`stepUpDismissedUntil`'s shared key shape —
 *  one guardian device's own local record of one child within one circle. */
export function independenceKey(circleId: string, childPk: string): string {
  return `${circleId}:${childPk}`
}

/** Guardian action: applies `level` to `childPk` within `circleId` — the
 *  task's own five effects, in order, EVERY one of them riding an existing
 *  mechanism (no new wire type):
 *   (a) every EXISTING place in this circle gets the preset's
 *       `graceMinutes`/`escalation` via the existing `places.savePlaces`
 *       (a full-set republish — places.ts's own documented discipline,
 *       never a delta); a circle with no places yet has nothing to update.
 *   (b) the preset's policy verdicts publish via the existing
 *       `approvals.publishFamilyPolicy` — which ALREADY records its own
 *       'policy-changed' Activity entry and notifies, unchanged (§22.5
 *       transparency preserved, task contract).
 *   (c) `independenceLevel[circleId:childPk]` is stored, local to this
 *       guardian device.
 *   (d) an 'independence-applied' Activity entry records the guardian's OWN
 *       action (this module's one new Activity kind).
 *   (e) the child is sent a 'suggest-baseline' proposal chip (recommended
 *       precision + friendly term) — messages.ts's `sendSuggestBaseline`;
 *       the child must explicitly accept it (§34.17) for their OWN device's
 *       baseline to actually change; nothing here forces it.
 *  Silently no-ops for a non-guardian device or an unknown circle — same
 *  "circle-role check, not a policy gate" discipline as `places.savePlaces`/
 *  `approvals.publishFamilyPolicy` themselves (both already re-check this on
 *  their own, but this function checks first so steps (c)/(d)/(e) — which
 *  have no such gate of their own — never run for a non-guardian either). A
 *  `childPk` that isn't actually a child member of this circle is likewise a
 *  no-op — defensive; the only caller (this module's own `view`) never
 *  offers one. */
export async function applyLevel(circleId: string, childPk: string, level: 1 | 2 | 3): Promise<void> {
  const p = store.load()
  const selfPk = currentSession()?.identityPk
  const circle = p.circles.find((c) => c.id === circleId)
  if (!selfPk || !circle || !isGuardian(circle, selfPk)) return
  if (!circle.members.some((m) => m.pk === childPk && m.role === 'child')) return

  const preset = LEVELS[level]

  // (a) existing places' grace/escalation.
  const currentPlaces = p.places[circleId] ?? []
  if (currentPlaces.length) {
    await places.savePlaces(circleId, currentPlaces.map((pl) => ({ ...pl, graceMinutes: preset.graceMinutes, escalation: preset.escalation })))
  }

  // (b) family-policy verdicts (records its own 'policy-changed' Activity).
  await approvals.publishFamilyPolicy(circleId, preset.policyVerdicts)

  // (c) store the level, and (finding 6) this circle's new-place grace
  // default — so a place added AFTER this apply inherits the SAME grace
  // period every EXISTING place in the circle just got in step (a) above,
  // rather than resetting to places.ts's generic DEFAULT_GRACE_MINUTES.
  const key = independenceKey(circleId, childPk)
  store.update((sp) => {
    sp.independenceLevel = { ...sp.independenceLevel, [key]: level }
    sp.levelDefaults = { ...sp.levelDefaults, [circleId]: { graceMinutes: preset.graceMinutes } }
    // A fresh guardian action supersedes any earlier dismissal context (it
    // was about the PRIOR level's own step-up suggestion, now moot) —
    // cleared here rather than left to linger and wrongly suppress a
    // FUTURE suggestion targeting the new current level.
    if (key in sp.stepUpDismissedUntil) {
      const next = { ...sp.stepUpDismissedUntil }
      delete next[key]
      sp.stepUpDismissedUntil = next
    }
  })

  // (d) Activity — the guardian's own action, transparency (task contract).
  const at = nowSec()
  activity.recordActivity({
    id: `${activity.localActivityId('independence-applied', at, circleId)}-${childPk}`,
    at, kind: 'independence-applied', circleId, actorPk: selfPk,
    params: { level: String(level), label: preset.label },
  })

  // (e) the child's own baseline proposal — theirs to accept or not.
  await messages.sendSuggestBaseline(circleId, childPk, preset.recommendedBaseline)
}

// ---------------------------------------------------------------------------
// Age-based setup wizard (Phase 6 Task 3, design spec §3, brief §2.4/
// §34.17-18): `AGE_BANDS`/`bundleSummary` are the wizard's own interface,
// living HERE rather than in wizard.ts (task contract: "bundles ARE levels")
// — the wizard is a thin guardian UI over the SAME `LEVELS`/`applyLevel`
// this file already owns; age bands are just a friendlier front door onto
// the same three presets, never a fourth mechanic of their own.
// wizard.ts (this module's own sibling, not imported here — the dependency
// runs the other way) owns the 3-step flow shell and calls both exports
// below plus `applyLevel` itself directly.
// ---------------------------------------------------------------------------

/** Closed id set for `AGE_BANDS` — task's own three bands, verbatim. */
export type AgeBandId = 'under10' | '10to13' | '14plus'

export interface AgeBand {
  id: AgeBandId
  label: string
  level: 1 | 2 | 3
}

/** Task's own interface, verbatim — age band -> level mapping.
 *  `[maintainer-review]`: the age-band boundaries/labels themselves (design
 *  spec §3's own flag), same tuning discipline as `LEVELS` above. */
export const AGE_BANDS: readonly AgeBand[] = [
  { id: 'under10', label: 'Under 10', level: 1 },
  { id: '10to13', label: '10–13', level: 2 },
  { id: '14plus', label: '14 and up', level: 3 },
]

/** Task's own interface, verbatim: `bundleSummary(level, childName):
 *  string[]` — the plain-language summary card lines the wizard shows
 *  between the age-band question and the Apply/Skip buttons, design spec
 *  §3's own worked example verbatim (level 2, "Sam"/"neighbourhood"/"10
 *  minutes" — every other level derived from the SAME template against that
 *  level's own `LEVELS` numbers, never re-authored per level).
 *
 *  Two parameters only (task contract) — no circle name, so "Family" below
 *  is deliberately the wizard's own generic term for "the people this
 *  circle shares with," not the guardian's own custom circle name (a real
 *  circle's `name` is whatever the guardian typed at creation — see
 *  circles.ts's `newFamilyCircle`). `[maintainer-review]`: whether a future
 *  revision should parameterise this by the real circle name instead.
 *
 *  `childName` is interpolated RAW, never escaped here — every line is
 *  plain text, not HTML; the wizard's own render layer `esc()`s each line
 *  at render time, same discipline as this module's own `stepUpCardView`
 *  headline above. */
export function bundleSummary(level: 1 | 2 | 3, childName: string): string[] {
  const preset = LEVELS[level]
  const term = precisionTerm(preset.recommendedBaseline).toLowerCase()
  return [
    // [copy] design spec §3, verbatim template.
    `${childName} will share their ${term} with Family.`,
    // [copy] design spec §3, verbatim.
    `You'll be told when they arrive at places you both save.`,
    // [copy] design spec §3, verbatim template.
    `If they leave a safe area, they get ${preset.graceMinutes} minutes to head back first.`,
  ]
}

// ---------------------------------------------------------------------------
// Step-up suggestions — pure heuristic (`stepUpSuggestion`), plus the
// dismiss/re-arm marker it consults. `evaluateStepUpsIfDue`/
// `pruneExpiredStepUpDismissals` below are a SEPARATE, purely-housekeeping
// concern (see store.ts's own doc comment on `stepUpLastEvaluated`) — the
// suggestion heuristic itself never depends on that pass having run.
// ---------------------------------------------------------------------------

/** Task contract's own constant, verbatim. */
export const QUIET_STREAK_DAYS = 30

const SECONDS_PER_DAY = 24 * 60 * 60

/** Activity kinds that disqualify the quiet streak (task contract: "no
 *  escalation/window-missed/sos Activity involving that child") — the SAME
 *  three kinds friction.ts's own `isQuietDay` disqualifies a whole DAY on,
 *  just windowed over `QUIET_STREAK_DAYS` and scoped to one specific child
 *  (`actorPk` match) rather than every circle this device knows about. */
const STEP_UP_DISQUALIFYING_KINDS = new Set(['safe-area-escalation', 'window-missed', 'sos'])

/** Duplicated from approvals.ts's own (module-private) `ACTION_LABELS` —
 *  same "duplicated, not imported" idiom this codebase already uses for
 *  small closed-set literals shared across two modules without creating a
 *  new export just for it (see places.ts's `LEAVE_AREA_MARKER`/
 *  approvals.ts's `PARAMS_KIND_KEY` doc comments for the precedent). Kept in
 *  sync by inspection — `approvals.POLICY_ACTIONS` (imported, not
 *  duplicated) is what actually drives which of these four ever gets read. */
const ACTION_LABELS: Record<PolicyAction, string> = {
  'create-circle': 'Create a new circle',
  'add-member': 'Add a member to this circle',
  'join-circle': 'Join a circle',
  'add-contact': 'Add a contact',
}

/** Result of `levelDiff` below — `lines` is the rendered diff preview,
 *  `graceTightens` flags whether the ACTUAL grace change is a reduction (see
 *  `levelDiff`'s own doc comment) so the card view can pick honest copy
 *  instead of always framing the change as "a step toward more
 *  independence". */
interface LevelDiff {
  lines: string[]
  graceTightens: boolean
}

/** Human-readable diff lines between the circle's ACTUAL current settings
 *  and `toLevel`'s own preset — the design spec's own "concrete next-notch
 *  diff preview (grace 10→15 etc.)".
 *
 *  Phase 6 final-review finding 3: the grace-period line used to compare
 *  `LEVELS[fromLevel].graceMinutes` against `LEVELS[toLevel].graceMinutes`
 *  — an ASSUMPTION that the circle's real places still match whatever the
 *  "current" level's own preset says, which stops being true the moment a
 *  guardian edits a place's grace period directly (places.ts's own edit
 *  form) after applying a level. This now reads the circle's REAL current
 *  places (`p.places[circleId]`) instead:
 *   - every place agrees on `graceMinutes` → that shared ACTUAL value, not
 *     the preset's assumed one.
 *   - places disagree → `'varies'` (never a fabricated single number).
 *   - no places at all → NO grace/escalation line at all (`applyLevel`'s own
 *     step (a) is itself a no-op with zero places — nothing will actually
 *     change, so nothing is claimed here either).
 *  A separate line calls out any place whose escalation is currently
 *  `'immediate'` — `applyLevel` always sets `'grace'` (every `LEVELS` preset
 *  uses it), so an immediate→grace place is a categorical behaviour change
 *  the numeric grace line alone wouldn't capture (an immediate place's
 *  `graceMinutes` isn't currently governing anything).
 *  `graceTightens` (see `LevelDiff`) is true when the ACTUAL current value
 *  is numerically GREATER than `toLevel`'s preset — i.e. applying would
 *  actually SHORTEN the grace period for at least one place, the opposite
 *  of "more independence"; the diff LINE itself stays plain either way (no
 *  framing words, just the numbers) — it's the CALLER's job (`stepUpCardView`
 *  below) to pick honest headline copy off this flag, never this function's. */
function levelDiff(p: store.Persisted, circleId: string, fromLevel: 1 | 2, toLevel: 2 | 3): LevelDiff {
  const from = LEVELS[fromLevel]
  const to = LEVELS[toLevel]
  const lines: string[] = []
  let graceTightens = false

  const currentPlaces = p.places[circleId] ?? []
  if (currentPlaces.length) {
    const graceValues = currentPlaces.map((pl) => pl.graceMinutes)
    const uniform = graceValues.every((g) => g === graceValues[0])
    const fromLabel = uniform ? `${graceValues[0]} min` : 'varies'
    // [copy] plain — no framing words, even when this is a tightening (see
    // this function's own doc comment): the guardian reads the numbers.
    lines.push(`Grace period: ${fromLabel} → ${to.graceMinutes} min`)
    graceTightens = graceValues.some((g) => g > to.graceMinutes)

    if (currentPlaces.some((pl) => pl.escalation === 'immediate')) {
      // [copy]
      lines.push('Leaving a safe area: tells the circle right away → warns first, then tells the circle')
    }
  }

  if (from.recommendedBaseline !== to.recommendedBaseline) {
    // [copy]
    lines.push(`Suggested sharing level: ${precisionTerm(from.recommendedBaseline)} → ${precisionTerm(to.recommendedBaseline)}`)
  }
  for (const action of approvals.POLICY_ACTIONS) {
    const fv = from.policyVerdicts[action] ?? 'prompt'
    const tv = to.policyVerdicts[action] ?? 'prompt'
    // [copy]
    if (fv !== tv) lines.push(`${ACTION_LABELS[action]}: ${fv} → ${tv}`)
  }
  return { lines, graceTightens }
}

/** Task interface, verbatim: pure — no store MUTATION, no clock access
 *  (`nowSecValue` always caller-supplied) — so directly unit-testable
 *  without a live store, and safe to call fresh on every render (the You-tab
 *  card calls this directly; see `view` below).
 *
 *  `null` unless ALL of:
 *   - the current level (absent → treated as 1, the most conservative
 *     starting point — a guardian who has never explicitly applied
 *     anything can still be offered a first step toward 2) is < 3 (task
 *     contract — level 3 has no next notch).
 *   - not currently suppressed by an unexpired `stepUpDismissedUntil` entry
 *     (`dismissStepUp`'s own re-arm deadline — see its doc comment).
 *   - Phase 6 final-review finding 4 (streak OBSERVATION floor): a full
 *     `QUIET_STREAK_DAYS` has elapsed since `p.stepUpFirstObserved[key]` —
 *     stamped by `evaluateStepUpsIfDue`'s own housekeeping (see that
 *     function's doc comment) the first time this device ever evaluates this
 *     pair. Absent entirely (never observed — e.g. a device installed
 *     moments ago) is treated the SAME as "floor not yet reached": null
 *     either way. Without this, a freshly-installed device's trivially EMPTY
 *     Activity history would misread as "a clean streak" on day one — the
 *     streak has to have actually been WATCHED for a month, not merely
 *     "nothing bad happened yet because nothing has happened at all".
 *   - no `STEP_UP_DISQUALIFYING_KINDS` Activity entry with `actorPk ===
 *     childPk` at or after `nowSecValue - QUIET_STREAK_DAYS` days (task
 *     contract: "no ... Activity involving that child in the window"). */
export function stepUpSuggestion(p: store.Persisted, circleId: string, childPk: string, nowSecValue: number): { toLevel: 2 | 3; diff: string[]; tightensGrace: boolean } | null {
  const key = independenceKey(circleId, childPk)
  const currentLevel = p.independenceLevel[key] ?? 1
  if (currentLevel >= 3) return null

  const dismissedUntil = p.stepUpDismissedUntil[key]
  if (dismissedUntil !== undefined && nowSecValue < dismissedUntil) return null

  const firstObserved = p.stepUpFirstObserved[key]
  if (firstObserved === undefined || nowSecValue - firstObserved < QUIET_STREAK_DAYS * SECONDS_PER_DAY) return null

  const windowStart = nowSecValue - QUIET_STREAK_DAYS * SECONDS_PER_DAY
  const dirty = p.activity.some((e) => STEP_UP_DISQUALIFYING_KINDS.has(e.kind) && e.actorPk === childPk && e.at >= windowStart)
  if (dirty) return null

  const toLevel = (currentLevel + 1) as 2 | 3
  const { lines, graceTightens } = levelDiff(p, circleId, currentLevel as 1 | 2, toLevel)
  return { toLevel, diff: lines, tightensGrace: graceTightens }
}

/** Dismisses `circleId`:`childPk`'s current step-up suggestion — re-arms
 *  only once ANOTHER full `QUIET_STREAK_DAYS` streak has passed FROM THIS
 *  MOMENT (task contract: "dismiss ... re-arms after another streak"), not
 *  merely once the ordinary streak window happens to look clean again by
 *  coincidence: `stepUpSuggestion` treats `nowSecValue < dismissedUntil` as
 *  an unconditional suppression, independent of the Activity check, so a
 *  guardian who dismisses today genuinely won't see it again for a full
 *  `QUIET_STREAK_DAYS`, even if nothing else happens in the meantime. */
export function dismissStepUp(circleId: string, childPk: string, nowSecValue: number): void {
  const key = independenceKey(circleId, childPk)
  const until = nowSecValue + QUIET_STREAK_DAYS * SECONDS_PER_DAY
  store.update((p) => { p.stepUpDismissedUntil = { ...p.stepUpDismissedUntil, [key]: until } })
}

// ---------------------------------------------------------------------------
// Weekly evaluation (piggybacked on places.tick(), task contract) —
// housekeeping only: prunes `stepUpDismissedUntil` entries whose re-arm
// deadline has already passed. This is NOT a correctness dependency for
// `stepUpSuggestion` (which already treats an expired entry as inert on its
// own, via the plain `nowSecValue < dismissedUntil` check above) — purely
// forward hygiene, same "a missed prune is never a correctness bug, only
// unbounded (if slow) growth" spirit as places.ts's own
// `pruneExpiredLeaves`/`pruneOrphanedWindowMarks`. Gated behind a weekly
// cadence (not run on every ~30s `tick()`) since there is no benefit to
// running it any more often than that.
// ---------------------------------------------------------------------------

export const STEP_UP_EVAL_INTERVAL_SEC = 7 * SECONDS_PER_DAY

/** Pure: is a weekly evaluation pass due? `undefined` (never run) is always
 *  due. */
export function stepUpEvaluationDue(lastEvaluated: number | undefined, nowSecValue: number): boolean {
  return lastEvaluated === undefined || nowSecValue - lastEvaluated >= STEP_UP_EVAL_INTERVAL_SEC
}

/** Pure: drops every `stepUpDismissedUntil` entry whose re-arm deadline has
 *  already passed. Returns the SAME reference when nothing changes — same
 *  no-op-returns-same-reference idiom as `approvals.upsertFamilyPolicy`/
 *  `activity.applyRecordActivity`. */
export function pruneExpiredStepUpDismissals(dismissed: Record<string, number>, nowSecValue: number): Record<string, number> {
  const entries = Object.entries(dismissed)
  const kept = entries.filter(([, until]) => until > nowSecValue)
  if (kept.length === entries.length) return dismissed
  return Object.fromEntries(kept)
}

/** Phase 6 final-review finding 4 (streak observation floor): pure reducer —
 *  ensures `observed` has a `stepUpFirstObserved` entry for every
 *  `(circleId, childPk)` pair `fam` GUARDIANS a child in, stamping
 *  `nowSecValue` for any pair that doesn't have one yet. An EXISTING entry is
 *  NEVER touched — a later evaluation pass must never push the floor
 *  forward, or a device that's been running for months could still never
 *  clear it. Returns the SAME reference when nothing changes (same
 *  no-op-returns-same-reference idiom as `pruneExpiredStepUpDismissals`
 *  above). Scoped to circles `fam` actually guards — same "no bookkeeping
 *  for circles you don't guard" discipline `view` below already applies by
 *  only ever rendering guardian circles. `selfPk` is the signed-in
 *  identity's own pubkey (Signet identity plan — `currentSession()`, not a
 *  stored `identity` object; the only field this ever needed). */
export function nextStepUpFirstObserved(circles: readonly Circle[], selfPk: string | undefined, observed: Record<string, number>, nowSecValue: number): Record<string, number> {
  if (!selfPk) return observed
  let next: Record<string, number> | undefined
  for (const circle of circles) {
    if (!isGuardian(circle, selfPk)) continue
    for (const member of circle.members) {
      if (member.role !== 'child') continue
      const key = independenceKey(circle.id, member.pk)
      if (key in observed) continue
      if (!next) next = { ...observed }
      next[key] = nowSecValue
    }
  }
  return next ?? observed
}

/** The impure, weekly-gated wrapper `places.registerPeriodicHook` calls on
 *  every `tick()` (see `ensure` below) — a no-op unless
 *  `stepUpEvaluationDue`. Since `tick()` itself runs once immediately on app
 *  start (see places.ts's own `ensure`) and `stepUpEvaluationDue` treats
 *  "never run" as always due, this ALSO doubles as "first evaluation" for
 *  finding 4's `stepUpFirstObserved` floor — a freshly-installed device gets
 *  every guardian-circle child's observation stamp within moments of first
 *  launch, not on some indefinitely-deferred later pass. */
export function evaluateStepUpsIfDue(nowSecValue: number): void {
  const p = store.load()
  if (!stepUpEvaluationDue(p.stepUpLastEvaluated, nowSecValue)) return
  const pruned = pruneExpiredStepUpDismissals(p.stepUpDismissedUntil, nowSecValue)
  const observed = nextStepUpFirstObserved(p.circles, currentSession()?.identityPk, p.stepUpFirstObserved, nowSecValue)
  store.update((sp) => {
    sp.stepUpDismissedUntil = pruned
    sp.stepUpLastEvaluated = nowSecValue
    sp.stepUpFirstObserved = observed
  })
}

/** Registers this module's weekly housekeeping with places.ts's `tick()` —
 *  registration, not an import (places.ts must never import this module
 *  back; see the module doc comment). Idempotent, identity-independent, same
 *  "the one side-effecting entry point" convention as every other domain
 *  module here. */
let registered = false
export function ensure(): void {
  if (registered) return
  registered = true
  places.registerPeriodicHook(evaluateStepUpsIfDue)
}

// ---------------------------------------------------------------------------
// View — the You tab's per-circle, per-dependant levels + step-up section
// (guardian only). UI wiring only past this point — no unit tests
// (build-gated), same convention as every other domain module here.
// ---------------------------------------------------------------------------

function shortPk(pk: string): string {
  return `${pk.slice(0, 8)}…`
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

export function view(p: store.Persisted, fam: SessionInfo): string {
  if (fam.dependant) return ''
  const guardianCircles = p.circles.filter((c) => isGuardian(c, fam.identityPk) && c.members.some((m) => m.role === 'child'))
  if (!guardianCircles.length) return ''
  const sections = guardianCircles.map((c) => circleSectionView(p, c)).join('')
  return `<section class="contact-group"><h2>Independence</h2>${sections}</section>`
}

function circleSectionView(p: store.Persisted, circle: Circle): string {
  const children = circle.members.filter((m) => m.role === 'child')
  const cards = children.map((child) => childCardView(p, circle, child)).join('')
  return `<div class="milestones-circle"><h3>${esc(circle.name)}</h3>${cards}</div>`
}

/** Phase 6 final-review finding 2 (honesty treatment): every child sharing
 *  `circle` OTHER than `childPk` — `applyLevel`'s place-grace/escalation
 *  (step a) and family-policy (step b) effects are CIRCLE-WIDE, not scoped
 *  to the one child a guardian is nominally "applying a level to" (only step
 *  (e), the suggested-baseline proposal, is actually per-child) — so both
 *  this module's own card and wizard.ts's summary step need to disclose who
 *  else is affected before a guardian taps Apply, not bury it. Exported so
 *  wizard.ts's summary step (a different guardian-initiated entry point onto
 *  the SAME `applyLevel`) can render the identical disclosure. Names only —
 *  each call site `esc()`s them at its own render time (same "raw in, escape
 *  once at render" idiom as `bundleSummary`'s own doc comment), falling back
 *  to `shortPk` for an unnamed member. Real PER-CHILD scoping (so this
 *  disclosure would no longer be necessary) is an architecture change,
 *  deferred — see the phase-6 final-review ledger. */
export function otherChildNames(circle: Circle, childPk: string): string[] {
  return circle.members.filter((m) => m.role === 'child' && m.pk !== childPk).map((m) => m.name || shortPk(m.pk))
}

/** [copy] the circle-wide-effects disclosure line (finding 2), shared by
 *  `childCardView` below — wizard.ts's own summary step builds the identical
 *  line itself (see `otherChildNames`'s own doc comment for why it isn't
 *  shared as pre-built HTML: each module owns its own `esc()`). Empty string
 *  when there's no OTHER child in the circle to disclose anything about. */
function circleWideEffectsLine(circle: Circle, childPk: string): string {
  const names = otherChildNames(circle, childPk)
  if (!names.length) return ''
  return `<p>This also updates safe areas and permissions for ${esc(names.join(', '))}.</p>`
}

function childCardView(p: store.Persisted, circle: Circle, child: CircleMember): string {
  const key = independenceKey(circle.id, child.pk)
  const currentLevel = p.independenceLevel[key]
  const name = child.name || shortPk(child.pk)
  const levelButtons = ([1, 2, 3] as const)
    .map((level) => {
      const preset = LEVELS[level]
      const current = currentLevel === level ? ' aria-current="true"' : ''
      return `<button type="button"${current} data-action="milestone-apply" data-circle="${esc(circle.id)}" data-child="${esc(child.pk)}" data-level="${level}">${esc(preset.label)}</button>`
    })
    .join('')
  const suggestion = stepUpSuggestion(p, circle.id, child.pk, nowSec())
  return `
    <div class="milestone-card">
      <p>${esc(name)}${currentLevel ? ` — ${esc(LEVELS[currentLevel].label)}` : ''}</p>
      ${circleWideEffectsLine(circle, child.pk)}
      <div class="milestone-levels">${levelButtons}</div>
      ${suggestion ? stepUpCardView(circle.id, child, suggestion) : ''}
    </div>
  `
}

function stepUpCardView(circleId: string, child: CircleMember, suggestion: { toLevel: 2 | 3; diff: string[]; tightensGrace: boolean }): string {
  const preset = LEVELS[suggestion.toLevel]
  const name = child.name || shortPk(child.pk)
  // [copy] design spec §2, parameterised verbatim — independence language
  // only (§31: never "earn"/"reward"/"points"). Phase 6 final-review finding
  // 3: this framing is only honest when the actual change genuinely widens
  // things — a `tightensGrace` diff (see `levelDiff`'s own doc comment: the
  // circle's REAL current place settings occasionally sit looser than
  // `toLevel`'s own preset, so "the next notch" can actually be a REDUCTION)
  // must never be dressed up as "a step toward more independence"; plain,
  // unframed copy instead — the diff list below already states the actual
  // numbers plainly either way.
  const headline = suggestion.tightensGrace
    ? `Applying "${preset.label}" for ${name} would change these settings.`
    : `It's been a month of smooth sailing with ${name}. Consider a step toward more independence.`
  const diffLines = suggestion.diff.map((line) => `<li>${esc(line)}</li>`).join('')
  return `
    <div class="milestone-suggestion">
      <p>${esc(headline)}</p>
      <ul>${diffLines}</ul>
      <div class="actions">
        <button type="button" data-action="milestone-apply" data-circle="${esc(circleId)}" data-child="${esc(child.pk)}" data-level="${suggestion.toLevel}">Move to ${esc(preset.label)}</button>
        <button type="button" data-action="milestone-step-up-dismiss" data-circle="${esc(circleId)}" data-child="${esc(child.pk)}">Not now</button>
      </div>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Action dispatch — app.ts delegates every `milestone-*` data-action here.
// ---------------------------------------------------------------------------

export function handleAction(action: string, node: HTMLElement): void {
  const circleId = node.dataset.circle ?? ''
  const childPk = node.dataset.child ?? ''
  switch (action) {
    case 'milestone-apply': {
      const level = Number(node.dataset.level)
      if (circleId && childPk && (level === 1 || level === 2 || level === 3)) void applyLevel(circleId, childPk, level)
      break
    }
    case 'milestone-step-up-dismiss':
      if (circleId && childPk) dismissStepUp(circleId, childPk, nowSec())
      break
    default:
      break
  }
}
