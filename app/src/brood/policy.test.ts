import { describe, it, expect } from 'vitest'
import { evaluatePolicy, latestPolicy, agreementPrecision, isLate, mergePrecision } from './policy.js'
import type { Agreement, FamilyPolicy } from './types.js'

describe('evaluatePolicy', () => {
  it('returns default prompt when policy is undefined', () => {
    const verdict = evaluatePolicy(undefined, 'create-circle')
    expect(verdict).toBe('prompt')
  })

  it('returns default prompt when action not in rules', () => {
    const policy: FamilyPolicy = {
      t: 'family-policy',
      circleId: 'circle1',
      rules: { 'add-member': 'allow' },
      updatedAt: 1000,
      by: 'pk1',
    }
    const verdict = evaluatePolicy(policy, 'create-circle')
    expect(verdict).toBe('prompt')
  })

  it('returns explicit allow', () => {
    const policy: FamilyPolicy = {
      t: 'family-policy',
      circleId: 'circle1',
      rules: { 'create-circle': 'allow' },
      updatedAt: 1000,
      by: 'pk1',
    }
    const verdict = evaluatePolicy(policy, 'create-circle')
    expect(verdict).toBe('allow')
  })

  it('returns explicit deny', () => {
    const policy: FamilyPolicy = {
      t: 'family-policy',
      circleId: 'circle1',
      rules: { 'create-circle': 'deny' },
      updatedAt: 1000,
      by: 'pk1',
    }
    const verdict = evaluatePolicy(policy, 'create-circle')
    expect(verdict).toBe('deny')
  })
})

describe('latestPolicy', () => {
  it('returns b when a is undefined', () => {
    const b: FamilyPolicy = {
      t: 'family-policy',
      circleId: 'circle1',
      rules: { 'create-circle': 'allow' },
      updatedAt: 1000,
      by: 'pk1',
    }
    expect(latestPolicy(undefined, b)).toBe(b)
  })

  it('returns a when b is undefined', () => {
    const a: FamilyPolicy = {
      t: 'family-policy',
      circleId: 'circle1',
      rules: { 'create-circle': 'allow' },
      updatedAt: 1000,
      by: 'pk1',
    }
    expect(latestPolicy(a, undefined)).toBe(a)
  })

  it('returns undefined when both are undefined', () => {
    expect(latestPolicy(undefined, undefined)).toBeUndefined()
  })

  it('returns policy with newer updatedAt', () => {
    const a: FamilyPolicy = {
      t: 'family-policy',
      circleId: 'circle1',
      rules: { 'create-circle': 'allow' },
      updatedAt: 1000,
      by: 'pk1',
    }
    const b: FamilyPolicy = {
      t: 'family-policy',
      circleId: 'circle1',
      rules: { 'create-circle': 'deny' },
      updatedAt: 2000,
      by: 'pk2',
    }
    expect(latestPolicy(a, b)).toBe(b)
    expect(latestPolicy(b, a)).toBe(b)
  })

  it('tie-breaks to lexicographically smaller by (both directions)', () => {
    const a: FamilyPolicy = {
      t: 'family-policy',
      circleId: 'circle1',
      rules: { 'create-circle': 'allow' },
      updatedAt: 1000,
      by: 'zzzz',
    }
    const b: FamilyPolicy = {
      t: 'family-policy',
      circleId: 'circle1',
      rules: { 'create-circle': 'deny' },
      updatedAt: 1000,
      by: 'aaaa',
    }
    // both have same updatedAt, so smaller 'by' wins
    expect(latestPolicy(a, b)).toBe(b)
    expect(latestPolicy(b, a)).toBe(b)
  })
})

describe('agreementPrecision', () => {
  it('returns null when nowSec is before all steps', () => {
    const agreement: Agreement = {
      t: 'agreement',
      id: 'agree1',
      circleId: 'circle1',
      child: 'child1',
      byUnix: 1000,
      schedule: [
        { fromOffsetMin: 0, precision: 6 },
        { fromOffsetMin: 15, precision: 9 },
      ],
      from: 'parent1',
      at: 900,
    }
    // nowSec = 950, which is before byUnix + 0*60 = 1000
    const result = agreementPrecision(agreement, 950)
    expect(result).toBeNull()
  })

  it('returns earlier step value when between steps', () => {
    const agreement: Agreement = {
      t: 'agreement',
      id: 'agree1',
      circleId: 'circle1',
      child: 'child1',
      byUnix: 1000,
      schedule: [
        { fromOffsetMin: 0, precision: 6 },
        { fromOffsetMin: 15, precision: 9 },
      ],
      from: 'parent1',
      at: 900,
    }
    // nowSec = 1200, which is after byUnix + 0*60 = 1000, but before byUnix + 15*60 = 1900
    const result = agreementPrecision(agreement, 1200)
    expect(result).toBe(6)
  })

  it('returns last step value when after all steps', () => {
    const agreement: Agreement = {
      t: 'agreement',
      id: 'agree1',
      circleId: 'circle1',
      child: 'child1',
      byUnix: 1000,
      schedule: [
        { fromOffsetMin: 0, precision: 6 },
        { fromOffsetMin: 15, precision: 9 },
      ],
      from: 'parent1',
      at: 900,
    }
    // nowSec = 2000, which is after byUnix + 15*60 = 1900
    const result = agreementPrecision(agreement, 2000)
    expect(result).toBe(9)
  })

  it('handles unsorted input by sorting internally', () => {
    const agreement: Agreement = {
      t: 'agreement',
      id: 'agree1',
      circleId: 'circle1',
      child: 'child1',
      byUnix: 1000,
      schedule: [
        { fromOffsetMin: 15, precision: 9 },
        { fromOffsetMin: 0, precision: 6 },
      ],
      from: 'parent1',
      at: 900,
    }
    // nowSec = 1200, should use first step value (6) even though schedule is not sorted
    const result = agreementPrecision(agreement, 1200)
    expect(result).toBe(6)
  })

  it('supports negative fromOffsetMin (before deadline)', () => {
    const agreement: Agreement = {
      t: 'agreement',
      id: 'agree1',
      circleId: 'circle1',
      child: 'child1',
      byUnix: 1000,
      schedule: [
        { fromOffsetMin: -15, precision: 6 },
        { fromOffsetMin: 0, precision: 9 },
      ],
      from: 'parent1',
      at: 900,
    }
    // nowSec = 100 is before byUnix - 15*60 = 100 (actually at the boundary)
    const result1 = agreementPrecision(agreement, 99)
    expect(result1).toBeNull()

    // nowSec = 100 is at/after byUnix - 15*60 = 100
    const result2 = agreementPrecision(agreement, 100)
    expect(result2).toBe(6)

    // nowSec = 1000 is at/after both steps
    const result3 = agreementPrecision(agreement, 1000)
    expect(result3).toBe(9)
  })
})

describe('isLate', () => {
  it('returns false when nowSec is well before the deadline itself (not just within grace)', () => {
    const agreement: Agreement = {
      t: 'agreement',
      id: 'agree1',
      circleId: 'circle1',
      child: 'child1',
      byUnix: 1000,
      schedule: [],
      from: 'parent1',
      at: 900,
    }
    // nowSec = 500, well before byUnix = 1000 itself — not merely inside the
    // post-deadline grace window (the other "before deadline" case below).
    const result = isLate(agreement, undefined, 500)
    expect(result).toBe(false)
  })

  it('returns false when nowSec is before deadline', () => {
    const agreement: Agreement = {
      t: 'agreement',
      id: 'agree1',
      circleId: 'circle1',
      child: 'child1',
      byUnix: 1000,
      schedule: [],
      from: 'parent1',
      at: 900,
    }
    // nowSec = 1100, which is before byUnix + 5*60 = 1300
    const result = isLate(agreement, undefined, 1100)
    expect(result).toBe(false)
  })

  it('returns false when nowSec is within grace period', () => {
    const agreement: Agreement = {
      t: 'agreement',
      id: 'agree1',
      circleId: 'circle1',
      child: 'child1',
      byUnix: 1000,
      schedule: [],
      from: 'parent1',
      at: 900,
    }
    // nowSec = 1299, which is still within grace (before byUnix + 5*60 = 1300)
    const result = isLate(agreement, undefined, 1299)
    expect(result).toBe(false)
  })

  it('returns true when nowSec is past grace period and not arrived', () => {
    const agreement: Agreement = {
      t: 'agreement',
      id: 'agree1',
      circleId: 'circle1',
      child: 'child1',
      byUnix: 1000,
      schedule: [],
      from: 'parent1',
      at: 900,
    }
    // nowSec = 1301, which is past grace (byUnix + 5*60 = 1300)
    const result = isLate(agreement, undefined, 1301)
    expect(result).toBe(true)
  })

  it('returns false when arrivedAt is defined (not undefined)', () => {
    const agreement: Agreement = {
      t: 'agreement',
      id: 'agree1',
      circleId: 'circle1',
      child: 'child1',
      byUnix: 1000,
      schedule: [],
      from: 'parent1',
      at: 900,
    }
    // arrivedAt is 1500, so not late even though nowSec is way past grace
    const result = isLate(agreement, 1500, 2000)
    expect(result).toBe(false)
  })

  it('respects custom graceMin parameter', () => {
    const agreement: Agreement = {
      t: 'agreement',
      id: 'agree1',
      circleId: 'circle1',
      child: 'child1',
      byUnix: 1000,
      schedule: [],
      from: 'parent1',
      at: 900,
    }
    // with graceMin = 10, grace period ends at byUnix + 10*60 = 1600
    const result1 = isLate(agreement, undefined, 1599, 10)
    expect(result1).toBe(false)

    const result2 = isLate(agreement, undefined, 1601, 10)
    expect(result2).toBe(true)
  })
})

describe('mergePrecision', () => {
  it('passes through flockPrecision when no agreement', () => {
    const result = mergePrecision(6, undefined, 1000)
    expect(result).toBe(6)
  })

  it('raises precision from schedule when schedule > base', () => {
    const agreement: Agreement = {
      t: 'agreement',
      id: 'agree1',
      circleId: 'circle1',
      child: 'child1',
      byUnix: 1000,
      schedule: [{ fromOffsetMin: 0, precision: 9 }],
      from: 'parent1',
      at: 900,
    }
    // flockPrecision = 6, schedule = 9, nowSec is after step
    const result = mergePrecision(6, agreement, 1100)
    expect(result).toBe(9)
  })

  it('never lowers precision (schedule cannot lower emergency)', () => {
    const agreement: Agreement = {
      t: 'agreement',
      id: 'agree1',
      circleId: 'circle1',
      child: 'child1',
      byUnix: 1000,
      schedule: [{ fromOffsetMin: 0, precision: 6 }],
      from: 'parent1',
      at: 900,
    }
    // flockPrecision = 11 (emergency), schedule = 6, should keep 11
    const result = mergePrecision(11, agreement, 1100)
    expect(result).toBe(11)
  })

  it('never lowers precision — plan\'s literal example (schedule 11 -> 9 stays 11)', () => {
    const agreement: Agreement = {
      t: 'agreement',
      id: 'agree1',
      circleId: 'circle1',
      child: 'child1',
      byUnix: 1000,
      schedule: [{ fromOffsetMin: 0, precision: 9 }],
      from: 'parent1',
      at: 900,
    }
    // flockPrecision = 11 (emergency), schedule = 9, should keep 11 — the
    // plan's own worked example ("schedule never lowers 11->9 (returns 11)").
    const result = mergePrecision(11, agreement, 1100)
    expect(result).toBe(11)
  })

  it('returns flockPrecision when no applicable schedule step', () => {
    const agreement: Agreement = {
      t: 'agreement',
      id: 'agree1',
      circleId: 'circle1',
      child: 'child1',
      byUnix: 1000,
      schedule: [{ fromOffsetMin: 15, precision: 9 }],
      from: 'parent1',
      at: 900,
    }
    // nowSec = 1000, which is before byUnix + 15*60 = 1900, so no step applies
    const result = mergePrecision(6, agreement, 1000)
    expect(result).toBe(6)
  })
})
