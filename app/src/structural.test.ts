import { describe, it, expect } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent, verifiedSymbol, type EventTemplate } from 'nostr-tools/pure'
import * as ds from './device-statements.js'
import * as st from './structural.js'

const sk = generateSecretKey()
const pk = getPublicKey(sk)
const otherSk = generateSecretKey()
const circleId = 'circle-1'
const prevSeedHash = st.seedHash('a'.repeat(64))

const sign = (t: EventTemplate, k = sk) => finalizeEvent({ ...t, created_at: t.created_at ?? 1_700_000_000 }, k)

function baseArgs(overrides: Partial<Parameters<typeof st.structuralTemplate>[0]> = {}) {
  return {
    action: 'config' as st.StructuralAction,
    circleId,
    prevSeedHash,
    payload: JSON.stringify({ hello: 'world' }),
    nowSec: 1_700_000_000,
    ...overrides,
  }
}

describe('structural inner events', () => {
  it('round-trips a structural event', () => {
    const ev = sign(st.structuralTemplate(baseArgs()))
    expect(ev.kind).toBe(30078)
    expect(st.verifyStructural(ev)).toMatchObject({
      action: 'config',
      circleId,
      prev: prevSeedHash,
      payload: JSON.stringify({ hello: 'world' }),
      signerPk: pk,
    })
  })

  it('rejects a bad signature', () => {
    const ev = sign(st.structuralTemplate(baseArgs()))
    const bad = { ...ev, sig: ev.sig.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) }
    expect(st.verifyStructural(bad)).toBeNull()
  })

  it('rejects a missing circle tag', () => {
    const t = st.structuralTemplate(baseArgs())
    t.tags = t.tags.filter((tag) => tag[0] !== 'circle')
    expect(st.verifyStructural(sign(t))).toBeNull()
  })

  it('rejects a missing prev tag', () => {
    const t = st.structuralTemplate(baseArgs())
    t.tags = t.tags.filter((tag) => tag[0] !== 'prev')
    expect(st.verifyStructural(sign(t))).toBeNull()
  })

  it('rejects a prev tag that is not 64 hex chars', () => {
    const t = st.structuralTemplate(baseArgs({ prevSeedHash: 'not-a-hash' }))
    expect(st.verifyStructural(sign(t))).toBeNull()
  })

  it('rejects an action not in STRUCTURAL_ACTIONS', () => {
    const t = st.structuralTemplate(baseArgs())
    t.tags = t.tags.map((tag) => (tag[0] === 't' ? ['t', 'not-a-real-action'] : tag))
    t.tags = t.tags.map((tag) => (tag[0] === 'd' ? ['d', 'kindependence/struct/not-a-real-action'] : tag))
    expect(st.verifyStructural(sign(t))).toBeNull()
  })

  it('rejects the wrong kind', () => {
    expect(st.verifyStructural(sign({ ...st.structuralTemplate(baseArgs()), kind: 1 }))).toBeNull()
  })

  it('does not accept a device statement as structural', () => {
    const phonePk = getPublicKey(generateSecretKey())
    expect(st.verifyStructural(sign(ds.deviceStatementTemplate(phonePk, 1_700_000_000)))).toBeNull()
  })

  it('signerPk reflects whoever actually signed', () => {
    const otherPk = getPublicKey(otherSk)
    const ev = sign(st.structuralTemplate(baseArgs()), otherSk)
    expect(st.verifyStructural(ev)).toMatchObject({ signerPk: otherPk })
  })

  it('seedHash is deterministic, 64 hex chars, and differs for different seeds', () => {
    const seedA = 'a'.repeat(64)
    const seedB = 'b'.repeat(64)
    const hashA1 = st.seedHash(seedA)
    const hashA2 = st.seedHash(seedA)
    const hashB = st.seedHash(seedB)
    expect(hashA1).toBe(hashA2)
    expect(hashA1).toMatch(/^[0-9a-f]{64}$/)
    expect(hashA1).not.toBe(hashB)
  })

  it('rejects junk input without throwing', () => {
    for (const junk of [null, 1, 'x', {}, { kind: 30078, tags: 'no' }]) {
      expect(st.verifyStructural(junk)).toBeNull()
    }
  })

  it('rejects a bad signature even with a spoofed verifiedSymbol cache', () => {
    const ev = sign(st.structuralTemplate(baseArgs()))
    const spoofed: Record<PropertyKey, unknown> = { ...ev, sig: '00'.repeat(64) }
    spoofed[verifiedSymbol] = true
    expect(st.verifyStructural(spoofed)).toBeNull()
  })

  it('rejects a t/d mismatch (t: rekey, d: kindependence/struct/config)', () => {
    const t = st.structuralTemplate(baseArgs({ action: 'rekey' }))
    t.tags = t.tags.map((tag) => (tag[0] === 'd' ? ['d', 'kindependence/struct/config'] : tag))
    expect(st.verifyStructural(sign(t))).toBeNull()
  })

  it('rejects tampered content', () => {
    const ev = sign(st.structuralTemplate(baseArgs()))
    expect(st.verifyStructural({ ...ev, content: JSON.stringify({ hacked: true }) })).toBeNull()
  })

  it('rejects a tampered tag', () => {
    const ev = sign(st.structuralTemplate(baseArgs()))
    const tags = ev.tags.map((tag) => (tag[0] === 'circle' ? ['circle', 'some-other-circle'] : tag))
    expect(st.verifyStructural({ ...ev, tags })).toBeNull()
  })
})
