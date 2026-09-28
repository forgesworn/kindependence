// Brood signal builders — see ../BROOD.md §2 (transport) and §3 (signal table).
//
// `buildBroodInner` wraps any `BroodSignal` into the plain, unwrapped
// flock-inner-event shape: kind 20078, a single `['t', signal.t]` tag (the
// same discriminator flock's own kind-20078 builders use, so an unwrapped
// brood signal is flock-parser-safe — a flock client dispatching on `t`
// finds no handler and drops it, same as its own `cover` decoy traffic),
// and `content` as the signal's own JSON encoding. Gift-wrapping (NIP-59)
// happens elsewhere (roost-kit) — brood-kit is a pure payload library and
// never touches the wire itself.
//
// Each signal type also gets a small typed convenience builder that fills
// in `t` (and, where the type carries one, `at`) so callers don't have to
// spell the discriminator or thread a timestamp field name by hand. Per the
// workspace's kit-purity rule, no builder reaches for a clock itself —
// `at`/`updatedAt` are always caller-supplied.

import type {
  Agreement,
  AgreementAck,
  AgreementStatus,
  ApprovalReq,
  ApprovalResp,
  BroodSignal,
  ExtendReq,
  ExtendResp,
  FamilyPolicy,
} from './types.js'
import { BROOD_SIGNAL_KIND } from './types.js'

/** The plain, unwrapped inner-event shape a brood signal becomes on the
 *  wire — before gift-wrapping, which is the caller's job (roost-kit). */
export interface BroodInnerEvent {
  kind: number
  content: string
  tags: string[][]
  created_at: number
}

/** Wrap a {@link BroodSignal} into its flock-inner-event shape: kind
 *  `BROOD_SIGNAL_KIND`, a single `['t', signal.t]` tag, and `content` as
 *  the signal's JSON encoding. */
export function buildBroodInner(signal: BroodSignal, nowSec: number): BroodInnerEvent {
  return {
    kind: BROOD_SIGNAL_KIND,
    content: JSON.stringify(signal),
    tags: [['t', signal.t]],
    created_at: nowSec,
  }
}

export function buildAgreement(opts: Omit<Agreement, 't' | 'at'>, at: number): Agreement {
  return { ...opts, t: 'agreement', at }
}

export function buildAgreementAck(opts: Omit<AgreementAck, 't' | 'at'>, at: number): AgreementAck {
  return { ...opts, t: 'agreement-ack', at }
}

export function buildAgreementStatus(opts: Omit<AgreementStatus, 't' | 'at'>, at: number): AgreementStatus {
  return { ...opts, t: 'agreement-status', at }
}

export function buildExtendReq(opts: Omit<ExtendReq, 't' | 'at'>, at: number): ExtendReq {
  return { ...opts, t: 'extend-req', at }
}

export function buildExtendResp(opts: Omit<ExtendResp, 't' | 'at'>, at: number): ExtendResp {
  return { ...opts, t: 'extend-resp', at }
}

/** `FamilyPolicy` carries its own clock (`updatedAt`, the latest-wins field
 *  — see BROOD.md §5), so unlike the other builders there is no separate
 *  `at` parameter to fill; the caller supplies `updatedAt` in `opts`. */
export function buildFamilyPolicy(opts: Omit<FamilyPolicy, 't'>): FamilyPolicy {
  return { ...opts, t: 'family-policy' }
}

export function buildApprovalReq(opts: Omit<ApprovalReq, 't' | 'at'>, at: number): ApprovalReq {
  return { ...opts, t: 'approval-req', at }
}

export function buildApprovalResp(opts: Omit<ApprovalResp, 't' | 'at'>, at: number): ApprovalResp {
  return { ...opts, t: 'approval-resp', at }
}
