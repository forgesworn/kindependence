import type { Agreement, FamilyPolicy, PolicyAction, PolicyVerdict, PrecisionStep } from './types.js'

export const DEFAULT_VERDICT: PolicyVerdict = 'prompt'

export function evaluatePolicy(policy: FamilyPolicy | undefined, action: PolicyAction): PolicyVerdict {
  return policy?.rules[action] ?? DEFAULT_VERDICT
}

export function latestPolicy(a: FamilyPolicy | undefined, b: FamilyPolicy | undefined): FamilyPolicy | undefined {
  if (!a) return b
  if (!b) return a
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt ? a : b
  return a.by <= b.by ? a : b          // fences idiom: tie → lexicographically smaller `by`
}

/** Precision the agreement schedule demands now, or null when no step applies.
 *  Steps fire at byUnix + fromOffsetMin*60; the latest fired step wins. */
export function agreementPrecision(agreement: Agreement, nowSec: number): number | null {
  let current: number | null = null
  const sorted = [...agreement.schedule].sort((x, y) => x.fromOffsetMin - y.fromOffsetMin)
  for (const step of sorted) {
    if (nowSec >= agreement.byUnix + step.fromOffsetMin * 60) current = step.precision
  }
  return current
}

export function isLate(agreement: Agreement, arrivedAt: number | undefined, nowSec: number, graceMin = 5): boolean {
  return arrivedAt === undefined && nowSec > agreement.byUnix + graceMin * 60
}

/** Merge FLOCK's disclosure decision with the agreement schedule.
 *  FLOCK emergency/pickup/breach precision always wins upward; the schedule can only
 *  RAISE precision above the base, never lower an emergency. */
export function mergePrecision(flockPrecision: number, agreement: Agreement | undefined, nowSec: number): number {
  if (!agreement) return flockPrecision
  const sched = agreementPrecision(agreement, nowSec)
  return sched === null ? flockPrecision : Math.max(flockPrecision, sched)
}
