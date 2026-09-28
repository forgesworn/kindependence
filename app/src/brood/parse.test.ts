import { describe, it, expect } from 'vitest'
import { BROOD_SIGNAL_KIND } from './types.js'
import type { BroodSignal } from './types.js'
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
import { parseBroodSignal } from './parse.js'

const PUBKEY_A = 'a'.repeat(64)
const PUBKEY_B = 'b'.repeat(64)

function roundTrip(signal: BroodSignal): void {
  const inner = buildBroodInner(signal, 1_799_990_100)
  expect(parseBroodSignal(inner)).toEqual(signal)
}

describe('builder -> parser round-trips', () => {
  it('agreement (minimal, no place/note)', () => {
    roundTrip(
      buildAgreement(
        { id: 'agr-1', circleId: 'circle-1', child: PUBKEY_A, byUnix: 1_800_000_000, schedule: [{ fromOffsetMin: -30, precision: 6 }], from: PUBKEY_B },
        1_799_990_000,
      ),
    )
  })

  it('agreement (with place and note)', () => {
    roundTrip(
      buildAgreement(
        {
          id: 'agr-1',
          circleId: 'circle-1',
          child: PUBKEY_A,
          place: { label: 'School gate', geohash: 'gcpuuz' },
          byUnix: 1_800_000_000,
          schedule: [
            { fromOffsetMin: -60, precision: 4 },
            { fromOffsetMin: -10, precision: 9 },
          ],
          note: 'use the side entrance',
          from: PUBKEY_B,
        },
        1_799_990_000,
      ),
    )
  })

  it('agreement (with place, label only, no geohash)', () => {
    roundTrip(
      buildAgreement(
        { id: 'agr-1', circleId: 'circle-1', child: PUBKEY_A, place: { label: 'Front door' }, byUnix: 1_800_000_000, schedule: [], from: PUBKEY_B },
        1_799_990_000,
      ),
    )
  })

  it('agreement-ack', () => {
    roundTrip(buildAgreementAck({ id: 'agr-1', by: PUBKEY_A }, 1_799_990_100))
  })

  it('agreement-status', () => {
    roundTrip(buildAgreementStatus({ id: 'agr-1', status: 'en-route', by: PUBKEY_A }, 1_799_990_100))
    roundTrip(buildAgreementStatus({ id: 'agr-1', status: 'arrived', by: PUBKEY_A }, 1_799_990_200))
    roundTrip(buildAgreementStatus({ id: 'agr-1', status: 'late', by: PUBKEY_A }, 1_799_990_300))
  })

  it('extend-req', () => {
    roundTrip(buildExtendReq({ id: 'agr-1', extraMin: 15, by: PUBKEY_A }, 1_799_990_100))
  })

  it('extend-resp (granted, with counter-offer extraMin)', () => {
    roundTrip(buildExtendResp({ id: 'agr-1', ok: true, extraMin: 10, by: PUBKEY_A }, 1_799_990_100))
  })

  it('extend-resp (refused, no extraMin)', () => {
    roundTrip(buildExtendResp({ id: 'agr-1', ok: false, by: PUBKEY_A }, 1_799_990_100))
  })

  it('family-policy', () => {
    roundTrip(
      buildFamilyPolicy({
        circleId: 'circle-1',
        rules: { 'create-circle': 'deny', 'add-member': 'prompt', 'join-circle': 'allow', 'add-contact': 'prompt' },
        updatedAt: 1_799_990_100,
        by: PUBKEY_A,
      }),
    )
  })

  it('family-policy (empty rules)', () => {
    roundTrip(buildFamilyPolicy({ circleId: 'circle-1', rules: {}, updatedAt: 1_799_990_100, by: PUBKEY_A }))
  })

  it('approval-req', () => {
    roundTrip(buildApprovalReq({ id: 'req-1', action: 'add-contact', params: { name: 'Alex', pubkey: PUBKEY_B }, from: PUBKEY_A }, 1_799_990_100))
  })

  it('approval-req (empty params)', () => {
    roundTrip(buildApprovalReq({ id: 'req-1', action: 'create-circle', params: {}, from: PUBKEY_A }, 1_799_990_100))
  })

  it('approval-resp', () => {
    roundTrip(buildApprovalResp({ id: 'req-1', ok: true, by: PUBKEY_A }, 1_799_990_100))
  })
})

describe('parseBroodSignal rejections', () => {
  const validAck = buildBroodInner(buildAgreementAck({ id: 'agr-1', by: PUBKEY_A }, 1), 1)

  it('rejects wrong kind', () => {
    expect(parseBroodSignal({ ...validAck, kind: 1 })).toBeNull()
    expect(parseBroodSignal({ ...validAck, kind: 20079 })).toBeNull()
  })

  it('rejects missing t tag', () => {
    expect(parseBroodSignal({ ...validAck, tags: [] })).toBeNull()
    expect(parseBroodSignal({ ...validAck, tags: [['d', 'something']] })).toBeNull()
  })

  it('rejects unknown t -> null (caller ignores, not an error)', () => {
    const inner = { kind: BROOD_SIGNAL_KIND, tags: [['t', 'beacon']], content: JSON.stringify({ t: 'beacon' }) }
    expect(parseBroodSignal(inner)).toBeNull()
  })

  it('rejects t-tag / content mismatch', () => {
    const content = JSON.stringify({ t: 'agreement-status', id: 'agr-1', status: 'en-route', by: PUBKEY_A, at: 1 })
    const inner = { kind: BROOD_SIGNAL_KIND, tags: [['t', 'agreement-ack']], content }
    expect(parseBroodSignal(inner)).toBeNull()
  })

  it('rejects malformed JSON content', () => {
    expect(parseBroodSignal({ ...validAck, content: '{not json' })).toBeNull()
  })

  it('rejects non-object JSON content', () => {
    expect(parseBroodSignal({ ...validAck, content: JSON.stringify('agreement-ack') })).toBeNull()
    expect(parseBroodSignal({ ...validAck, content: JSON.stringify([1, 2, 3]) })).toBeNull()
  })

  it('rejects bad pubkey (too short, uppercase, non-hex)', () => {
    const bad = (by: string) =>
      parseBroodSignal(buildBroodInner(buildAgreementAck({ id: 'agr-1', by }, 1), 1))
    expect(bad('short')).toBeNull()
    expect(bad('A'.repeat(64))).toBeNull()
    expect(bad('g'.repeat(64))).toBeNull()
    expect(bad('a'.repeat(63))).toBeNull()
    expect(bad('a'.repeat(65))).toBeNull()
  })

  it('rejects bad enum (agreement-status.status)', () => {
    const content = JSON.stringify({ t: 'agreement-status', id: 'agr-1', status: 'delayed', by: PUBKEY_A, at: 1 })
    const inner = { kind: BROOD_SIGNAL_KIND, tags: [['t', 'agreement-status']], content }
    expect(parseBroodSignal(inner)).toBeNull()
  })

  it('rejects bad enum (approval-req.action)', () => {
    const content = JSON.stringify({ t: 'approval-req', id: 'req-1', action: 'delete-circle', params: {}, from: PUBKEY_A, at: 1 })
    const inner = { kind: BROOD_SIGNAL_KIND, tags: [['t', 'approval-req']], content }
    expect(parseBroodSignal(inner)).toBeNull()
  })

  it('rejects bad enum (family-policy.rules verdict)', () => {
    const content = JSON.stringify({ t: 'family-policy', circleId: 'circle-1', rules: { 'add-contact': 'maybe' }, updatedAt: 1, by: PUBKEY_A })
    const inner = { kind: BROOD_SIGNAL_KIND, tags: [['t', 'family-policy']], content }
    expect(parseBroodSignal(inner)).toBeNull()
  })

  it('rejects unknown rules key (family-policy)', () => {
    const content = JSON.stringify({ t: 'family-policy', circleId: 'circle-1', rules: { 'delete-circle': 'allow' }, updatedAt: 1, by: PUBKEY_A })
    const inner = { kind: BROOD_SIGNAL_KIND, tags: [['t', 'family-policy']], content }
    expect(parseBroodSignal(inner)).toBeNull()
  })

  it('rejects non-finite number (byUnix, at, updatedAt, extraMin)', () => {
    const badAgreementContent = JSON.stringify({
      t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: PUBKEY_A, byUnix: NaN, schedule: [], from: PUBKEY_B, at: 1,
    })
    expect(parseBroodSignal({ kind: BROOD_SIGNAL_KIND, tags: [['t', 'agreement']], content: badAgreementContent })).toBeNull()

    const badAtContent = JSON.stringify({ t: 'agreement-ack', id: 'agr-1', by: PUBKEY_A, at: Infinity })
    expect(parseBroodSignal({ kind: BROOD_SIGNAL_KIND, tags: [['t', 'agreement-ack']], content: badAtContent })).toBeNull()

    const badUpdatedAtContent = JSON.stringify({ t: 'family-policy', circleId: 'circle-1', rules: {}, updatedAt: 'soon', by: PUBKEY_A })
    expect(parseBroodSignal({ kind: BROOD_SIGNAL_KIND, tags: [['t', 'family-policy']], content: badUpdatedAtContent })).toBeNull()

    const badExtraMinContent = JSON.stringify({ t: 'extend-req', id: 'agr-1', extraMin: NaN, by: PUBKEY_A, at: 1 })
    expect(parseBroodSignal({ kind: BROOD_SIGNAL_KIND, tags: [['t', 'extend-req']], content: badExtraMinContent })).toBeNull()
  })

  it('rejects schedule precision 0 or 13 (valid range is 1..12)', () => {
    const withPrecision = (precision: number) =>
      JSON.stringify({
        t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: PUBKEY_A, byUnix: 1, schedule: [{ fromOffsetMin: -10, precision }], from: PUBKEY_B, at: 1,
      })
    expect(parseBroodSignal({ kind: BROOD_SIGNAL_KIND, tags: [['t', 'agreement']], content: withPrecision(0) })).toBeNull()
    expect(parseBroodSignal({ kind: BROOD_SIGNAL_KIND, tags: [['t', 'agreement']], content: withPrecision(13) })).toBeNull()
    // boundaries are valid
    expect(parseBroodSignal({ kind: BROOD_SIGNAL_KIND, tags: [['t', 'agreement']], content: withPrecision(1) })).not.toBeNull()
    expect(parseBroodSignal({ kind: BROOD_SIGNAL_KIND, tags: [['t', 'agreement']], content: withPrecision(12) })).not.toBeNull()
  })

  it('rejects non-array schedule', () => {
    const content = JSON.stringify({
      t: 'agreement', id: 'agr-1', circleId: 'circle-1', child: PUBKEY_A, byUnix: 1, schedule: 'none', from: PUBKEY_B, at: 1,
    })
    expect(parseBroodSignal({ kind: BROOD_SIGNAL_KIND, tags: [['t', 'agreement']], content })).toBeNull()
  })

  it('rejects non-boolean ok (extend-resp, approval-resp)', () => {
    const content = JSON.stringify({ t: 'approval-resp', id: 'req-1', ok: 'yes', by: PUBKEY_A, at: 1 })
    expect(parseBroodSignal({ kind: BROOD_SIGNAL_KIND, tags: [['t', 'approval-resp']], content })).toBeNull()
  })

  it('rejects approval-req params with non-string values', () => {
    const content = JSON.stringify({ t: 'approval-req', id: 'req-1', action: 'add-contact', params: { count: 3 }, from: PUBKEY_A, at: 1 })
    expect(parseBroodSignal({ kind: BROOD_SIGNAL_KIND, tags: [['t', 'approval-req']], content })).toBeNull()
  })

  it('rejects missing required fields', () => {
    const content = JSON.stringify({ t: 'agreement-ack', by: PUBKEY_A, at: 1 })
    expect(parseBroodSignal({ kind: BROOD_SIGNAL_KIND, tags: [['t', 'agreement-ack']], content })).toBeNull()
  })
})
