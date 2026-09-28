// Age-based setup wizard (Phase 6 Task 3, design spec §3, brief §2.4/
// §34.17-18): a thin guardian-only UI that turns milestones.ts's `LEVELS`/
// `applyLevel` (already shipped, Task 2) into a friendly first-run flow —
// "how old is your child, roughly?" -> a plain-language summary of exactly
// what that age band's level bundle does -> Apply (= `milestones.applyLevel`,
// UNCHANGED) or "Skip for now". This module owns NO new mechanics of its
// own: `AGE_BANDS`'s age->level mapping and `bundleSummary`'s copy live in
// milestones.ts (task contract: "bundles ARE levels" — see that module's own
// doc comment on why they live there instead of here). This module is
// purely the 3-step UI shell + its own pure `wizardNext` step reducer.
//
// Two entry points (task contract), neither of which imports this module —
// both just render a button carrying `data-action="wizard-open"` +
// `data-circle`/`data-child`/`data-child-name`, dispatched centrally by
// app.ts's `handleAction` (same "render the button, never import the
// module" idiom as every `msg-*`/`milestone-*` button elsewhere in this
// codebase):
//  - app.ts's onboarding "set up each child's device" screen
//    (`onboardingStartDoneView`), right after a NEW child is added to the
//    family circle — the "just added this child" moment.
//  - circles.ts's own circle member row, guardian viewing a CHILD member
//    (`memberItemView`'s "Set up sharing together" button) — re-runnable any
//    time, not just once at onboarding (design spec §3: "re-runnable from
//    the You tab per circle" — this app's member row is the equivalent
//    reachable-any-time entry point).
//
// Child-side acknowledgement: Task 2's already-shipped 'suggest-baseline' DM
// chip/card (messages.ts) — Apply below calls `milestones.applyLevel`
// UNCHANGED, which already sends it as step (e) of its own five effects
// (see milestones.ts's own doc comment); this module never touches the wire
// or the child device directly, and never invents a second acknowledgement
// mechanism of its own.
//
// §31 (language): declining — Skip, or simply closing the tab without
// tapping Apply — leaves current settings and tells no one, same discipline
// as the child-side card's own Accept-only design (messages.ts's
// `messageItemView` doc comment). Every rendered string below is
// `[copy]`-flagged.

import * as store from './store.js'
import type { SessionInfo } from './session.js'
import { AGE_BANDS, bundleSummary, applyLevel, otherChildNames, type AgeBandId } from './milestones.js'

// ---------------------------------------------------------------------------
// Pure step reducer — the task's own interface, verbatim: `wizardNext(state,
// action)`. Three steps (task contract): age band -> summary card ->
// Apply/Skip. Apply/Skip are both TERMINAL (return `null`: the wizard
// closes) — the actual `applyLevel` side effect for Apply is the CALLER's
// job (`handleAction` below), never this function's (pure, no store access,
// directly unit-testable without a live store — same discipline as
// milestones.ts's own `stepUpSuggestion`).
// ---------------------------------------------------------------------------

export interface WizardState {
  readonly step: 'age-band' | 'summary'
  readonly circleId: string
  readonly childPk: string
  readonly childName: string
  /** Set once a band is chosen (present for the whole 'summary' step,
   *  cleared again on `back`). */
  readonly bandId?: AgeBandId
}

export type WizardAction =
  | { type: 'select-band'; bandId: AgeBandId }
  | { type: 'back' }
  | { type: 'apply' }
  | { type: 'skip' }

/** Pure: `state` plus one action -> the next state, or `null` to close the
 *  wizard (task contract: Apply and Skip both close it). An action that
 *  doesn't apply to the CURRENT step is a no-op — returns `state` back
 *  UNCHANGED (same object reference, so a caller can tell "nothing to do"
 *  cheaply, same idiom as friction.ts's `nextMapCheckState`'s collapsed-tap
 *  branch) — e.g. `select-band` while already on the summary step, or
 *  `back` while still on the age-band step (there is nowhere "back" of
 *  that). */
export function wizardNext(state: WizardState, action: WizardAction): WizardState | null {
  switch (action.type) {
    case 'select-band':
      if (state.step !== 'age-band') return state
      return { ...state, step: 'summary', bandId: action.bandId }
    case 'back':
      if (state.step !== 'summary') return state
      return { ...state, step: 'age-band', bandId: undefined }
    case 'apply':
    case 'skip':
      return null
  }
}

// ---------------------------------------------------------------------------
// Module state — ephemeral UI state, not app data (same "no wizard resumes
// across a reload" idiom as messages.ts's `openThread`/circles.ts's
// `uiView`): a fresh load never resumes mid-wizard.
// ---------------------------------------------------------------------------

// Phase 6 Task 4: `wizardState` snapshots `circleId`/`childPk` on open and
// never re-validates them against `store.load()` while the wizard stays
// open — safe today only because this app has no sign-out action (an
// identity is live for as long as anything renders) and no whole-circle
// delete/disband action a guardian can trigger themselves (the roster can
// only shrink via `circle-remove-member`, and `milestones.applyLevel`
// already treats an unknown `childPk` as a defensive no-op on Apply — see
// its own doc comment); revisit this comment if either ever gets added.
let wizardState: WizardState | null = null

/** app.ts's `screenView` short-circuits to this module's `view` whenever
 *  `isOpen()`, same "modal state wins over the tab body" idiom as
 *  `messages.isOpen()`. */
export function isOpen(): boolean {
  return wizardState !== null
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function view(p: store.Persisted, _fam: SessionInfo): string {
  if (!wizardState) return ''
  const body = wizardState.step === 'age-band' ? ageBandStepView(wizardState) : summaryStepView(p, wizardState)
  // `.wizard-screen` (Phase 6 Task 4 CSS pass) — a plain full-screen wrapper,
  // same "one wrapping class per full-screen modal flow" idiom as messages.ts's
  // own `.chat-overlay` (`screenView`'s doc comment: both short-circuit
  // whichever tab is active).
  return `<div class="wizard-screen">${body}</div>`
}

function ageBandStepView(state: WizardState): string {
  const name = esc(state.childName)
  const bandButtons = AGE_BANDS
    .map((band) => `<button type="button" data-action="wizard-band-select" data-band="${esc(band.id)}">${esc(band.label)}</button>`)
    .join('')
  return `
    <h1>Set up sharing together</h1>
    <p class="muted">How old is ${name}, roughly? This just picks a starting point — you can change any of it later.</p>
    <div class="wizard-age-bands">${bandButtons}</div>
    <button type="button" data-action="wizard-skip">Skip for now</button>
  `
}

function summaryStepView(p: store.Persisted, state: WizardState): string {
  const band = AGE_BANDS.find((b) => b.id === state.bandId)
  if (!band) return ''
  const name = esc(state.childName)
  const lines = bundleSummary(band.level, state.childName).map((line) => `<p>${esc(line)}</p>`).join('')
  // Phase 6 final-review finding 2 (honesty treatment): `applyLevel`'s
  // place-grace/escalation and family-policy effects are circle-wide, not
  // scoped to just `state.childPk` — see `milestones.otherChildNames`'s own
  // doc comment. This wizard's `bundleSummary` above only ever talks about
  // ONE child (its own task-contract interface — two parameters, no circle
  // context), so this disclosure has to be appended here instead.
  const circle = p.circles.find((c) => c.id === state.circleId)
  const otherNames = circle ? otherChildNames(circle, state.childPk) : []
  // [copy]
  const otherEffectsLine = otherNames.length ? `<p>This also updates safe areas and permissions for ${esc(otherNames.join(', '))}.</p>` : ''
  return `
    <h1>Here's what ${name} would share</h1>
    ${lines}
    ${otherEffectsLine}
    <div class="wizard-summary-actions">
      <button type="button" data-action="wizard-apply" data-circle="${esc(state.circleId)}" data-child="${esc(state.childPk)}" data-level="${band.level}">Apply</button>
      <button type="button" data-action="wizard-back">Back</button>
      <button type="button" data-action="wizard-skip">Skip for now</button>
    </div>
  `
}

// ---------------------------------------------------------------------------
// Action dispatch — app.ts delegates every `wizard-*` data-action here.
// ---------------------------------------------------------------------------

export function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'wizard-open': {
      const circleId = node.dataset.circle
      const childPk = node.dataset.child
      if (circleId && childPk) {
        wizardState = { step: 'age-band', circleId, childPk, childName: node.dataset.childName ?? '' }
        store.notify()
      }
      break
    }
    case 'wizard-band-select': {
      if (!wizardState) break
      const bandId = node.dataset.band as AgeBandId | undefined
      if (bandId && AGE_BANDS.some((b) => b.id === bandId)) {
        wizardState = wizardNext(wizardState, { type: 'select-band', bandId })
        store.notify()
      }
      break
    }
    case 'wizard-back':
      if (wizardState) {
        wizardState = wizardNext(wizardState, { type: 'back' })
        store.notify()
      }
      break
    case 'wizard-apply': {
      if (!wizardState) break
      // Phase 6 final-review finding 10: `wizardState` (this module's own
      // already-open, already-validated snapshot — see its own doc comment
      // on why it's safe to trust for as long as the wizard stays open) is
      // the SOURCE OF TRUTH for circleId/childPk/level; the button's own
      // `data-*` attributes (still rendered by `summaryStepView`, unchanged)
      // are consulted only as a FALLBACK, never the primary input — a
      // crafted/mismatched DOM node can no longer steer `applyLevel` at a
      // different circle/child/level than the one this module itself is
      // actually showing. Behaviour is unchanged from before this fix: the
      // dataset always agreed with `wizardState` anyway (`summaryStepView`
      // is the only thing that ever sets them, from this exact state).
      const state = wizardState
      const band = AGE_BANDS.find((b) => b.id === state.bandId)
      const circleId = state.circleId || node.dataset.circle
      const childPk = state.childPk || node.dataset.child
      const level = band?.level ?? (Number(node.dataset.level) as 1 | 2 | 3)
      if (circleId && childPk && (level === 1 || level === 2 || level === 3)) void applyLevel(circleId, childPk, level)
      wizardState = wizardNext(wizardState, { type: 'apply' })
      store.notify()
      break
    }
    case 'wizard-skip':
      if (wizardState) {
        wizardState = wizardNext(wizardState, { type: 'skip' })
        store.notify()
      }
      break
    default:
      break
  }
}
