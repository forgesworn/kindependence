import { describe, it, expect } from 'vitest'
import { BROOD_SIGNAL_KIND } from './types.js'
import {
  buildBroodInner,
  buildAgreement,
  buildAgreementAck,
  buildAgreementStatus,
  buildExtendReq,
  buildExtendResp,
  buildFamilyPolicy,
  buildApprovalReq,
  buildApprovalResp,
} from './build.js'

const PUBKEY_A = 'a'.repeat(64)
const PUBKEY_B = 'b'.repeat(64)

describe('buildBroodInner', () => {
  it('wraps a signal into the flock-compatible inner-event shape', () => {
    const agreement = buildAgreement(
      { id: 'agr-1', circleId: 'circle-1', child: PUBKEY_A, byUnix: 1_800_000_000, schedule: [], from: PUBKEY_B },
      1_799_990_000,
    )
    const inner = buildBroodInner(agreement, 1_799_990_100)

    expect(inner.kind).toBe(BROOD_SIGNAL_KIND)
    expect(inner.kind).toBe(20078)
    expect(inner.tags).toEqual([['t', 'agreement']])
    expect(inner.created_at).toBe(1_799_990_100)
    expect(JSON.parse(inner.content)).toEqual(agreement)
  })

  it('tags every signal type with only a single [t, <type>] pair — no d-tag, no extras', () => {
    const ack = buildAgreementAck({ id: 'agr-1', by: PUBKEY_A }, 100)
    const inner = buildBroodInner(ack, 100)
    expect(inner.tags).toEqual([['t', 'agreement-ack']])
  })
})

describe('convenience builders', () => {
  it('buildAgreement fills t and at, preserves the rest, and omits place/note when absent', () => {
    const a = buildAgreement(
      { id: 'agr-1', circleId: 'circle-1', child: PUBKEY_A, byUnix: 1_800_000_000, schedule: [{ fromOffsetMin: -30, precision: 6 }], from: PUBKEY_B },
      1_799_990_000,
    )
    expect(a).toEqual({
      t: 'agreement',
      id: 'agr-1',
      circleId: 'circle-1',
      child: PUBKEY_A,
      byUnix: 1_800_000_000,
      schedule: [{ fromOffsetMin: -30, precision: 6 }],
      from: PUBKEY_B,
      at: 1_799_990_000,
    })
  })

  it('buildAgreement carries place and note through when supplied', () => {
    const a = buildAgreement(
      {
        id: 'agr-1',
        circleId: 'circle-1',
        child: PUBKEY_A,
        place: { label: 'School gate', geohash: 'gcpuuz' },
        byUnix: 1_800_000_000,
        schedule: [],
        note: 'use the side entrance',
        from: PUBKEY_B,
      },
      1_799_990_000,
    )
    expect(a.place).toEqual({ label: 'School gate', geohash: 'gcpuuz' })
    expect(a.note).toBe('use the side entrance')
  })

  it('buildAgreementAck fills t and at', () => {
    const ack = buildAgreementAck({ id: 'agr-1', by: PUBKEY_A }, 42)
    expect(ack).toEqual({ t: 'agreement-ack', id: 'agr-1', by: PUBKEY_A, at: 42 })
  })

  it('buildAgreementStatus fills t and at', () => {
    const s = buildAgreementStatus({ id: 'agr-1', status: 'en-route', by: PUBKEY_A }, 42)
    expect(s).toEqual({ t: 'agreement-status', id: 'agr-1', status: 'en-route', by: PUBKEY_A, at: 42 })
  })

  it('buildExtendReq fills t and at', () => {
    const r = buildExtendReq({ id: 'agr-1', extraMin: 15, by: PUBKEY_A }, 42)
    expect(r).toEqual({ t: 'extend-req', id: 'agr-1', extraMin: 15, by: PUBKEY_A, at: 42 })
  })

  it('buildExtendResp fills t and at', () => {
    const r = buildExtendResp({ id: 'agr-1', ok: true, extraMin: 10, by: PUBKEY_A }, 42)
    expect(r).toEqual({ t: 'extend-resp', id: 'agr-1', ok: true, extraMin: 10, by: PUBKEY_A, at: 42 })
  })

  it('buildFamilyPolicy fills t only (updatedAt is caller-supplied, not auto-filled)', () => {
    const p = buildFamilyPolicy({ circleId: 'circle-1', rules: { 'add-contact': 'deny' }, updatedAt: 42, by: PUBKEY_A })
    expect(p).toEqual({ t: 'family-policy', circleId: 'circle-1', rules: { 'add-contact': 'deny' }, updatedAt: 42, by: PUBKEY_A })
  })

  it('buildApprovalReq fills t and at', () => {
    const r = buildApprovalReq({ id: 'req-1', action: 'add-contact', params: { name: 'Alex' }, from: PUBKEY_A }, 42)
    expect(r).toEqual({ t: 'approval-req', id: 'req-1', action: 'add-contact', params: { name: 'Alex' }, from: PUBKEY_A, at: 42 })
  })

  it('buildApprovalResp fills t and at', () => {
    const r = buildApprovalResp({ id: 'req-1', ok: false, by: PUBKEY_A }, 42)
    expect(r).toEqual({ t: 'approval-resp', id: 'req-1', ok: false, by: PUBKEY_A, at: 42 })
  })
})
