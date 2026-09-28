import { describe, it, expect } from 'vitest'
import { deriveGroupKey, encryptEnvelope } from 'canary-kit/sync'
import {
  KINDEPENDENCE_MSG_SIGNAL_TYPE,
  buildKindependenceMsgSignal,
  decodeLegacyBuzz,
} from './legacy-buzz.js'

const SEED = '0000000000000000000000000000000000000000000000000000000000000001'
const A = 'a'.repeat(64)
const B = 'b'.repeat(64)

/** Group-envelope encrypt an arbitrary payload — stands in for a REAL legacy
 *  flock buzz's content (identical envelope + old payload shape), so the
 *  compat-window decode can be exercised without the removed old kit. */
async function rawEnvelope(payload: Record<string, unknown>): Promise<string> {
  return encryptEnvelope(deriveGroupKey(SEED), JSON.stringify(payload))
}

describe('legacy-buzz codec — the t:"kindependence-msg" (old flock buzz) wire', () => {
  it('has the kindependence-owned signal type, distinct from flock buzz', () => {
    expect(KINDEPENDENCE_MSG_SIGNAL_TYPE).toBe('kindependence-msg')
  })

  it('round-trips an untargeted free-text message on t:"kindependence-msg"', async () => {
    const event = await buildKindependenceMsgSignal({ groupId: 'g', seedHex: SEED, from: A, reason: 'Dinner ready', timestamp: 1_700_000_000 })
    expect(event.kind).toBe(20_078)
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(KINDEPENDENCE_MSG_SIGNAL_TYPE)
    expect(await decodeLegacyBuzz(SEED, event.content)).toEqual({ from: A, reason: 'Dinner ready', timestamp: 1_700_000_000 })
  })

  it('round-trips a targeted message (carries target)', async () => {
    const event = await buildKindependenceMsgSignal({ groupId: 'g', seedHex: SEED, from: A, reason: 'Pick me up', target: B, timestamp: 42 })
    expect(await decodeLegacyBuzz(SEED, event.content)).toEqual({ from: A, reason: 'Pick me up', target: B, timestamp: 42 })
  })

  it('round-trips the optional location roll-call ask', async () => {
    const event = await buildKindependenceMsgSignal({ groupId: 'g', seedHex: SEED, from: A, reason: 'Check in', ask: 'location', timestamp: 7 })
    expect(await decodeLegacyBuzz(SEED, event.content)).toEqual({ from: A, reason: 'Check in', ask: 'location', timestamp: 7 })
  })

  it('rejects a malformed sender/target and an empty/over-long reason on build', async () => {
    await expect(buildKindependenceMsgSignal({ groupId: 'g', seedHex: SEED, from: 'nope', reason: 'hi' })).rejects.toThrow()
    await expect(buildKindependenceMsgSignal({ groupId: 'g', seedHex: SEED, from: A, reason: 'hi', target: 'nope' })).rejects.toThrow()
    await expect(buildKindependenceMsgSignal({ groupId: 'g', seedHex: SEED, from: A, reason: '   ' })).rejects.toThrow()
    await expect(buildKindependenceMsgSignal({ groupId: 'g', seedHex: SEED, from: A, reason: 'x'.repeat(281) })).rejects.toThrow()
  })

  it('decodes a REPLAYED legacy flock buzz payload (old {from,reason,target,timestamp} shape)', async () => {
    // A real pre-eb96ce0 flock buzz's content is the same group-envelope
    // encryption of the same payload shape — decodeLegacyBuzz reads it whether
    // it arrived on t:'kindependence-msg' or (compat) legacy t:'buzz'.
    const content = await rawEnvelope({ from: A, reason: 'Come home', target: B, timestamp: 99 })
    expect(await decodeLegacyBuzz(SEED, content)).toEqual({ from: A, reason: 'Come home', target: B, timestamp: 99 })
  })

  it('drops an unknown ask value rather than throwing (forward-compat)', async () => {
    const content = await rawEnvelope({ from: A, reason: 'hi', timestamp: 1, ask: 'sirens' })
    expect(await decodeLegacyBuzz(SEED, content)).toEqual({ from: A, reason: 'hi', timestamp: 1 })
  })

  it('throws on a malformed payload (bad from) and on the wrong seed', async () => {
    const badFrom = await rawEnvelope({ from: 'nope', reason: 'hi', timestamp: 1 })
    await expect(decodeLegacyBuzz(SEED, badFrom)).rejects.toThrow()
    const ok = await buildKindependenceMsgSignal({ groupId: 'g', seedHex: SEED, from: A, reason: 'hi', timestamp: 1 })
    await expect(decodeLegacyBuzz('2'.repeat(64), ok.content)).rejects.toThrow()
  })
})
