import { describe, it, expect } from 'vitest'
import { wizardNext, type WizardState } from './wizard.js'

function state(overrides: Partial<WizardState> = {}): WizardState {
  return { step: 'age-band', circleId: 'circle-1', childPk: 'b'.repeat(64), childName: 'Sam', ...overrides }
}

// ---------------------------------------------------------------------------
// wizardNext — the task's own interface, verbatim: a pure `(state, action)`
// reducer for the wizard's 3-step flow (age band -> summary card -> Apply/
// Skip). Apply and Skip are both terminal — the caller's job is to run the
// `applyLevel` side effect (Apply only), this reducer only ever decides the
// NEXT UI STATE (or `null` to close).
// ---------------------------------------------------------------------------

describe('wizardNext', () => {
  it('select-band on the age-band step advances to summary, carrying the chosen band', () => {
    const next = wizardNext(state(), { type: 'select-band', bandId: '10to13' })
    expect(next).toEqual({ ...state(), step: 'summary', bandId: '10to13' })
  })

  it('select-band on the summary step is a no-op (returns the exact same state)', () => {
    const s = state({ step: 'summary', bandId: 'under10' })
    expect(wizardNext(s, { type: 'select-band', bandId: '14plus' })).toBe(s)
  })

  it('back on the summary step returns to age-band, clearing the chosen band', () => {
    const s = state({ step: 'summary', bandId: '10to13' })
    expect(wizardNext(s, { type: 'back' })).toEqual({ ...s, step: 'age-band', bandId: undefined })
  })

  it('back on the age-band step is a no-op (returns the exact same state)', () => {
    const s = state()
    expect(wizardNext(s, { type: 'back' })).toBe(s)
  })

  it('apply closes the wizard (null) from either step', () => {
    expect(wizardNext(state(), { type: 'apply' })).toBeNull()
    expect(wizardNext(state({ step: 'summary', bandId: '14plus' }), { type: 'apply' })).toBeNull()
  })

  it('skip closes the wizard (null) from either step', () => {
    expect(wizardNext(state(), { type: 'skip' })).toBeNull()
    expect(wizardNext(state({ step: 'summary', bandId: 'under10' }), { type: 'skip' })).toBeNull()
  })

  it('preserves circleId/childPk/childName untouched across every transition', () => {
    const s = state()
    const summary = wizardNext(s, { type: 'select-band', bandId: 'under10' }) as WizardState
    expect(summary.circleId).toBe(s.circleId)
    expect(summary.childPk).toBe(s.childPk)
    expect(summary.childName).toBe(s.childName)
  })
})
