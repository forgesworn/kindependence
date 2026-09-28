// Brood signal types — see ../BROOD.md for the protocol spec.
//
// This file is the wire contract: every field here round-trips through
// `build.ts`/`parse.ts` byte-for-byte via `JSON.stringify`/`JSON.parse`.

export type BroodType =
  | 'agreement'
  | 'agreement-ack'
  | 'agreement-status'
  | 'extend-req'
  | 'extend-resp'
  | 'family-policy'
  | 'approval-req'
  | 'approval-resp'

/** Same inner kind as FLOCK signals; discriminated by `['t', type]` tag. */
export const BROOD_SIGNAL_KIND = 20078

/** A precision step in an agreement's disclosure schedule. `fromOffsetMin` is
 *  an offset in minutes relative to `byUnix` (negative = before). */
export interface PrecisionStep {
  fromOffsetMin: number
  precision: number
}

export interface Agreement {
  t: 'agreement'
  id: string
  circleId: string
  child: string
  place?: { label: string; geohash?: string }
  byUnix: number
  schedule: PrecisionStep[]
  note?: string
  from: string
  at: number
}

export interface AgreementAck {
  t: 'agreement-ack'
  id: string
  by: string
  at: number
}

export type AgreementStatusKind = 'en-route' | 'arrived' | 'late'

export interface AgreementStatus {
  t: 'agreement-status'
  id: string
  status: AgreementStatusKind
  by: string
  at: number
}

export interface ExtendReq {
  t: 'extend-req'
  id: string
  extraMin: number
  by: string
  at: number
}

export interface ExtendResp {
  t: 'extend-resp'
  id: string
  ok: boolean
  extraMin?: number
  by: string
  at: number
}

export type PolicyAction = 'create-circle' | 'add-member' | 'join-circle' | 'add-contact'

export type PolicyVerdict = 'allow' | 'prompt' | 'deny'

export interface FamilyPolicy {
  t: 'family-policy'
  circleId: string
  rules: Partial<Record<PolicyAction, PolicyVerdict>>
  updatedAt: number
  by: string
}

export interface ApprovalReq {
  t: 'approval-req'
  id: string
  action: PolicyAction
  params: Record<string, string>
  from: string
  at: number
}

export interface ApprovalResp {
  t: 'approval-resp'
  id: string
  ok: boolean
  by: string
  at: number
}

export type BroodSignal =
  | Agreement
  | AgreementAck
  | AgreementStatus
  | ExtendReq
  | ExtendResp
  | FamilyPolicy
  | ApprovalReq
  | ApprovalResp
