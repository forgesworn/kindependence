import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent, verifiedSymbol, type EventTemplate } from 'nostr-tools/pure'
import * as ds from './device-statements.js'

const idSk = generateSecretKey()
const idPk = getPublicKey(idSk)
const phonePk = getPublicKey(generateSecretKey())
const sign = (t: EventTemplate, sk = idSk) => finalizeEvent({ ...t, created_at: t.created_at ?? 1_700_000_000 }, sk)

describe('device statements', () => {
  it('round-trips a device statement', () => {
    const ev = sign(ds.deviceStatementTemplate(phonePk, 1_700_000_000))
    expect(ev.kind).toBe(30078)
    expect(ds.verifyDeviceStatement(ev)).toMatchObject({ identityPk: idPk, phonePk, scopes: [ds.CIRCLE_TRAFFIC_SCOPE] })
  })
  it('rejects a bad signature', () => {
    const ev = sign(ds.deviceStatementTemplate(phonePk, 1))
    const bad = { ...ev, sig: ev.sig.replace(/^./, c => c === 'a' ? 'b' : 'a') }
    expect(ds.verifyDeviceStatement(bad)).toBeNull()
  })
  it('rejects the wrong kind', () => {
    expect(ds.verifyDeviceStatement(sign({ ...ds.deviceStatementTemplate(phonePk, 1), kind: 1 }))).toBeNull()
  })
  it('rejects d and p that disagree', () => {
    const t = ds.deviceStatementTemplate(phonePk, 1)
    const other = getPublicKey(generateSecretKey())
    t.tags = t.tags.map(tag => tag[0] === 'p' ? ['p', other] : tag)
    expect(ds.verifyDeviceStatement(sign(t))).toBeNull()
  })
  it('rejects a statement without the circle-traffic scope', () => {
    const t = ds.deviceStatementTemplate(phonePk, 1)
    t.tags = t.tags.map(tag => tag[0] === 'scope' ? ['scope', 'kindependence:other'] : tag)
    expect(ds.verifyDeviceStatement(sign(t))).toBeNull()
  })
  it('does not accept a revocation as a statement, or the reverse', () => {
    expect(ds.verifyDeviceStatement(sign(ds.revocationTemplate(phonePk, 1)))).toBeNull()
    expect(ds.verifyRevocation(sign(ds.deviceStatementTemplate(phonePk, 1)))).toBeNull()
  })
  it('round-trips a revocation', () => {
    expect(ds.verifyRevocation(sign(ds.revocationTemplate(phonePk, 1)))).toMatchObject({ signerPk: idPk, phonePk })
  })
  it('rejects junk input without throwing', () => {
    for (const junk of [null, 1, 'x', {}, { kind: 30078, tags: 'no' }]) {
      expect(ds.verifyDeviceStatement(junk)).toBeNull()
      expect(ds.verifyRevocation(junk)).toBeNull()
    }
  })
  it('rejects a bad signature even with a spoofed verifiedSymbol cache (statement)', () => {
    const ev = sign(ds.deviceStatementTemplate(phonePk, 1))
    const spoofed: Record<PropertyKey, unknown> = { ...ev, sig: '00'.repeat(64) }
    spoofed[verifiedSymbol] = true
    expect(ds.verifyDeviceStatement(spoofed)).toBeNull()
  })
  it('rejects a bad signature even with a spoofed verifiedSymbol cache (revocation)', () => {
    const ev = sign(ds.revocationTemplate(phonePk, 1))
    const spoofed: Record<PropertyKey, unknown> = { ...ev, sig: '00'.repeat(64) }
    spoofed[verifiedSymbol] = true
    expect(ds.verifyRevocation(spoofed)).toBeNull()
  })
  it('rejects tampered content', () => {
    const ev = sign(ds.deviceStatementTemplate(phonePk, 1))
    expect(ds.verifyDeviceStatement({ ...ev, content: 'tampered' })).toBeNull()
  })
  it('rejects a tampered tag', () => {
    const ev = sign(ds.deviceStatementTemplate(phonePk, 1))
    const tags = ev.tags.map((tag) => (tag[0] === 'scope' ? ['scope', 'kindependence:other'] : tag))
    expect(ds.verifyDeviceStatement({ ...ev, tags })).toBeNull()
  })
})

describe('guardian-link statements', () => {
  const otherSk = generateSecretKey()
  const otherPk = getPublicKey(otherSk)

  it('round-trips a guardian-of statement', () => {
    const ev = sign(ds.guardianOfTemplate(otherPk, 1_700_000_000))
    expect(ev.content).toBe('I am a guardian of this person in Kindependence.')
    expect(ev.tags).toEqual([['d', `kindependence/dependant/${otherPk}`], ['p', otherPk]])
    expect(ds.verifyLinkStatement(ev)).toMatchObject({ kind: 'guardian-of', signerPk: idPk, otherPk, createdAt: 1_700_000_000 })
  })
  it('round-trips a dependant-of statement', () => {
    const ev = sign(ds.dependantOfTemplate(otherPk, 5))
    expect(ev.content).toBe('This person is my guardian in Kindependence.')
    expect(ev.tags).toEqual([['d', `kindependence/guardian/${otherPk}`], ['p', otherPk]])
    expect(ds.verifyLinkStatement(ev)).toMatchObject({ kind: 'dependant-of', signerPk: idPk, otherPk, createdAt: 5 })
  })
  it('round-trips an unlink', () => {
    const ev = sign(ds.unlinkTemplate(otherPk, 7))
    expect(ev.tags).toEqual([['d', `kindependence/unlink/${otherPk}`], ['p', otherPk]])
    const v = ds.verifyLinkStatement(ev)
    expect(v).toMatchObject({ kind: 'unlink', signerPk: idPk, otherPk, createdAt: 7 })
    expect(v?.event.id).toBe(ev.id)
  })
  it('rejects the wrong kind', () => {
    for (const t of [ds.guardianOfTemplate(otherPk, 1), ds.dependantOfTemplate(otherPk, 1), ds.unlinkTemplate(otherPk, 1)]) {
      expect(ds.verifyLinkStatement(sign({ ...t, kind: 1 }))).toBeNull()
    }
  })
  it('rejects d and p that disagree', () => {
    const third = getPublicKey(generateSecretKey())
    for (const t of [ds.guardianOfTemplate(otherPk, 1), ds.dependantOfTemplate(otherPk, 1), ds.unlinkTemplate(otherPk, 1)]) {
      t.tags = t.tags.map(tag => tag[0] === 'p' ? ['p', third] : tag)
      expect(ds.verifyLinkStatement(sign(t))).toBeNull()
    }
  })
  it('rejects a d naming a different pk than p', () => {
    const third = getPublicKey(generateSecretKey())
    const t = ds.guardianOfTemplate(otherPk, 1)
    t.tags = t.tags.map(tag => tag[0] === 'd' ? ['d', `kindependence/dependant/${third}`] : tag)
    expect(ds.verifyLinkStatement(sign(t))).toBeNull()
  })
  it('rejects an unknown d namespace, and device formats', () => {
    const t = ds.guardianOfTemplate(otherPk, 1)
    t.tags = t.tags.map(tag => tag[0] === 'd' ? ['d', `kindependence/other/${otherPk}`] : tag)
    expect(ds.verifyLinkStatement(sign(t))).toBeNull()
    expect(ds.verifyLinkStatement(sign(ds.deviceStatementTemplate(otherPk, 1)))).toBeNull()
    expect(ds.verifyLinkStatement(sign(ds.revocationTemplate(otherPk, 1)))).toBeNull()
    expect(ds.verifyDeviceStatement(sign(ds.guardianOfTemplate(otherPk, 1)))).toBeNull()
    expect(ds.verifyRevocation(sign(ds.unlinkTemplate(otherPk, 1)))).toBeNull()
  })
  it('rejects a p that is not lowercase hex64', () => {
    const up = otherPk.toUpperCase()
    const t = { kind: 30078, created_at: 1, content: '', tags: [['d', `kindependence/unlink/${up}`], ['p', up]] }
    expect(ds.verifyLinkStatement(sign(t))).toBeNull()
  })
  it('rejects a statement about the signer itself', () => {
    for (const t of [ds.guardianOfTemplate(idPk, 1), ds.dependantOfTemplate(idPk, 1), ds.unlinkTemplate(idPk, 1)]) {
      expect(ds.verifyLinkStatement(sign(t))).toBeNull()
    }
  })
  it('rejects a bad signature, tampered content, and a spoofed verifiedSymbol cache', () => {
    const ev = sign(ds.guardianOfTemplate(otherPk, 1))
    expect(ds.verifyLinkStatement({ ...ev, sig: ev.sig.replace(/^./, c => c === 'a' ? 'b' : 'a') })).toBeNull()
    expect(ds.verifyLinkStatement({ ...ev, content: 'tampered' })).toBeNull()
    expect(ds.verifyLinkStatement({ ...ev, created_at: 2 })).toBeNull()
    const spoofed: Record<PropertyKey, unknown> = { ...ev, sig: '00'.repeat(64) }
    spoofed[verifiedSymbol] = true
    expect(ds.verifyLinkStatement(spoofed)).toBeNull()
  })
  it('rejects junk input without throwing', () => {
    for (const junk of [null, 1, 'x', {}, { kind: 30078, tags: 'no' }, { kind: 30078, tags: [['d', 5]] }]) {
      expect(ds.verifyLinkStatement(junk)).toBeNull()
    }
  })
})

describe('signature verdict cache (Task 5 fix round 1)', () => {
  it('a cached event id never vouches for tampered content, pubkey or signature', () => {
    const ev = sign(ds.guardianOfTemplate(getPublicKey(generateSecretKey()), 1))
    expect(ds.verifySignedWire(ev)).not.toBeNull()
    expect(ds.verifySignedWire(ev)).not.toBeNull() // cached
    expect(ds.verifySignedWire({ ...ev, content: 'tampered' })).toBeNull()
    expect(ds.verifySignedWire({ ...ev, pubkey: phonePk })).toBeNull()
    expect(ds.verifySignedWire({ ...ev, sig: ev.sig.replace(/^./, c => c === 'a' ? 'b' : 'a') })).toBeNull()
  })
  it('stays bounded', () => {
    ds.setSigCacheCapForTests(3)
    try {
      for (let i = 0; i < 5; i++) ds.verifySignedWire(sign(ds.deviceStatementTemplate(phonePk, 1_700_000_000 + i)))
      expect(ds.sigCacheSizeForTests()).toBe(3)
    } finally {
      ds.setSigCacheCapForTests()
    }
  })
})
