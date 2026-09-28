import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  upsertFamilyPolicy,
  policyVerdict,
  upsertApprovalReq,
  applyApprovalResp,
  newApprovalId,
  decodeBroodSignal,
  raiseApproval,
  respondApproval,
  publishFamilyPolicy,
  registerApprovalAction,
  registerApprovalAutoResolver,
  registerApprovalResolutionListener,
  registerStructuralSenders,
  handleIncomingSignal,
  PARAMS_KIND_KEY,
  type ApprovalResolution,
} from './approvals.js'
import { LEAVE_AREA_ENVELOPE_ACTION, encodeLeaveAreaParams, decodeLeaveAreaParams, type LeaveAreaParams } from './places.js'
import { notify } from './notify.js'
import * as store from './store.js'
import { sessionForTests, currentSession } from './session.js'
import type { SignerTransport } from './remote-signer.js'
import * as queue from './structural-queue.js'
import { verifyStructural } from './structural.js'
import type { Sender } from './beacons.js'
import { makeLocalSigner, deriveInbox, toHex } from '@forgesworn/covey-kit'
import type { Circle, CircleMember } from '@forgesworn/covey-kit'
import { giftUnwrap, rawNip44Decrypt, publishSigned } from '@forgesworn/roost-kit'
import type { Rumor, SignedEvent } from '@forgesworn/roost-kit'
import { buildApprovalReq, buildApprovalResp, parseBroodSignal } from './brood/index.js'
import type { ApprovalReq, FamilyPolicy } from './brood/index.js'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'

// `raiseApproval`/`respondApproval`/`publishFamilyPolicy` do real (non-network)
// crypto via LocalSigner — only the relay publish actually leaves the
// process. Mocking just `publishSigned` (same idiom as circles.test.ts)
// exercises the real gift-wrap round trip without touching a network.
vi.mock('@forgesworn/roost-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgesworn/roost-kit')>()
  return { ...actual, publishSigned: vi.fn(async () => ({})) }
})

// Partial-mock notify (same idiom as places.test.ts/journey.test.ts) so the
// freshness-gate block below can assert which incoming signals actually
// raise a system notification. `shouldNotifyForEvent` stays real.
vi.mock('./notify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notify.js')>()
  return { ...actual, notify: vi.fn(async () => {}) }
})

const PK_CHILD = 'a'.repeat(64)
const PK_GUARDIAN = 'b'.repeat(64)

function fakeCircle(overrides: Partial<Circle> = {}): Circle {
  return {
    id: 'circle-1', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
    members: [{ pk: PK_GUARDIAN, role: 'guardian' }, { pk: PK_CHILD, role: 'child' }],
    createdAt: 100, configUpdatedAt: 100, configBy: PK_GUARDIAN,
    ...overrides,
  }
}

function fakePersisted(overrides: Partial<store.Persisted> = {}): store.Persisted {
  return {
    v: 1, circles: [], contacts: [], settings: {}, safetyEvents: [], agreements: [],
    familyPolicies: {}, approvals: [], activity: [], dmThreads: {}, dmLastSeen: {}, circleChats: {}, circleChatLastSeen: {},
    ...overrides,
  } as store.Persisted
}

/** A `SignerTransport` backed by a real local signer — the test-only stand-in
 *  for a My Signet remote signer, so `identitySigner()` (structural-queue.ts's
 *  `sign()`) can actually sign in a test without a live bunker/NIP-55
 *  transport. Mirrors receive.test.ts's own `localTransport`. */
function localTransport(skHex: string): SignerTransport {
  const s = makeLocalSigner(skHex)
  return {
    pubkey: s.pubkey,
    signEvent: (t) => s.signEvent(t),
    nip44Encrypt: (peer, pt) => s.nip44Encrypt(peer, pt),
    nip44Decrypt: (peer, ct) => s.nip44Decrypt(peer, ct),
    close: async () => {},
  }
}

/** Signs this device in for a test (Signet identity plan): `identityPk` is
 *  the signed-in identity, `phoneSkHex` this device's own phone key.
 *  `identitySkHex`, when given, wires a real local-signer transport behind
 *  `identitySigner()` — only the three structural (family-policy/
 *  approval-resp) wire-round-trip tests below need it; every other test only
 *  exercises `phoneSigner()`/local reducers. */
function signIn(identityPk: string, phoneSkHex: string, dependant = false, identitySkHex?: string): void {
  sessionForTests({
    identityPk, phoneSkHex, dependant,
    ...(identitySkHex ? { transport: localTransport(identitySkHex) } : {}),
  })
}

/** A resolved sender for a circle signal — `phonePk` the sealing phone key
 *  (or, for a structural delivery, the phone that relayed it), `memberPk`
 *  the identity it resolves to, `structural` whether it's an identity-signed
 *  structural event (family-policy/approval-resp) rather than phone-key
 *  traffic (approval-req). */
function fakeSender(phonePk: string, memberPk: string = phonePk, structural = false): Sender {
  return { signerPk: phonePk, memberPk, structural }
}

/** A real, valid secp256k1 keypair (hex) — `raiseApproval`/`respondApproval`/
 *  `publishFamilyPolicy` build a real `LocalSigner` from `skHex`, which needs
 *  an actual valid scalar, not just any 64 hex chars. */
function realKeypair(): { skHex: string; pkHex: string } {
  const sk = generateSecretKey()
  return { skHex: toHex(sk), pkHex: getPublicKey(sk) }
}

/** Minimal in-memory localStorage stand-in (mirrors circles.test.ts's). */
function fakeLocalStorage(): Storage {
  const mem = new Map<string, string>()
  return {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
    removeItem: (k: string) => { mem.delete(k) },
    clear: () => mem.clear(),
    key: () => null,
    get length() { return mem.size },
  } as unknown as Storage
}

afterEach(() => {
  sessionForTests(null)
  queue.resetForTests()
})

// ---------------------------------------------------------------------------
// Pure reducers
// ---------------------------------------------------------------------------

describe('upsertFamilyPolicy', () => {
  const base: FamilyPolicy = { t: 'family-policy', circleId: 'c1', rules: { 'add-member': 'allow' }, updatedAt: 1000, by: 'p1' }

  it('stores a policy for a circle with none yet', () => {
    expect(upsertFamilyPolicy({}, base)).toEqual({ c1: base })
  })

  it('replaces with a strictly newer policy for the same circle', () => {
    const newer: FamilyPolicy = { ...base, rules: { 'add-member': 'deny' }, updatedAt: 2000 }
    expect(upsertFamilyPolicy({ c1: base }, newer)).toEqual({ c1: newer })
  })

  it('ignores a strictly older policy, returning the SAME map reference (no write)', () => {
    const older: FamilyPolicy = { ...base, updatedAt: 500 }
    const policies = { c1: base }
    expect(upsertFamilyPolicy(policies, older)).toBe(policies)
  })

  it('an exact echo (same updatedAt, same by) changes nothing', () => {
    const policies = { c1: base }
    expect(upsertFamilyPolicy(policies, { ...base })).toBe(policies)
  })

  it('tie-breaks an equal updatedAt to the lexicographically smaller by', () => {
    const a: FamilyPolicy = { ...base, by: 'zzzz' }
    const b: FamilyPolicy = { ...base, by: 'aaaa', rules: { 'add-member': 'deny' } }
    expect(upsertFamilyPolicy({ c1: a }, b)).toEqual({ c1: b })
  })

  it('does not touch other circles\' policies', () => {
    const other: FamilyPolicy = { ...base, circleId: 'c2' }
    expect(upsertFamilyPolicy({ c2: other }, base)).toEqual({ c1: base, c2: other })
  })
})

describe('policyVerdict', () => {
  it('defaults to prompt for a circle with no policy at all', () => {
    expect(policyVerdict({}, 'c1', 'create-circle')).toBe('prompt')
  })

  it('defaults to prompt for an action absent from an otherwise-present policy', () => {
    const policy: FamilyPolicy = { t: 'family-policy', circleId: 'c1', rules: { 'add-member': 'allow' }, updatedAt: 100, by: 'p1' }
    expect(policyVerdict({ c1: policy }, 'c1', 'create-circle')).toBe('prompt')
  })

  it('returns an explicit allow/deny', () => {
    const policy: FamilyPolicy = { t: 'family-policy', circleId: 'c1', rules: { 'create-circle': 'allow', 'add-member': 'deny' }, updatedAt: 100, by: 'p1' }
    expect(policyVerdict({ c1: policy }, 'c1', 'create-circle')).toBe('allow')
    expect(policyVerdict({ c1: policy }, 'c1', 'add-member')).toBe('deny')
  })
})

describe('upsertApprovalReq', () => {
  it('adds a new request', () => {
    const req = buildApprovalReq({ id: 'r1', action: 'create-circle', params: { name: 'X' }, from: PK_CHILD }, 100)
    expect(upsertApprovalReq([], req, 'circle-1')).toEqual([{ req, circleId: 'circle-1' }])
  })

  it('final fix B2/I2: stamps raisedByPhonePk on the new record only when given (raiseApproval passes it; the receive path does not)', () => {
    const req = buildApprovalReq({ id: 'r1', action: 'create-circle', params: { name: 'X' }, from: PK_CHILD }, 100)
    expect(upsertApprovalReq([], req, 'circle-1', 'phone-1')).toEqual([{ req, circleId: 'circle-1', raisedByPhonePk: 'phone-1' }])
    expect(upsertApprovalReq([], req, 'circle-1')).toEqual([{ req, circleId: 'circle-1' }])
  })

  it('final fix B2/I2: a dedupe (already-tracked id) leaves the existing raisedByPhonePk untouched, even if called again without one', () => {
    const req = buildApprovalReq({ id: 'r1', action: 'create-circle', params: { name: 'X' }, from: PK_CHILD }, 100)
    const records = [{ req, circleId: 'circle-1', raisedByPhonePk: 'phone-1' }]
    expect(upsertApprovalReq(records, req, 'circle-1')).toBe(records)
  })

  it('is a no-op (dedupe) when the same request id is replayed, even after it has been resolved', () => {
    const req = buildApprovalReq({ id: 'r1', action: 'create-circle', params: { name: 'X' }, from: PK_CHILD }, 100)
    const records = [{ req, circleId: 'circle-1', resolved: { ok: true, by: PK_GUARDIAN, at: 200 } }]
    expect(upsertApprovalReq(records, req, 'circle-1')).toBe(records)
  })

  it('caps at 100 records, pruning the OLDEST RESOLVED entry first once over the cap', () => {
    // 100 already-resolved records, oldest (id r0, at 0) to newest (id r99, at 99).
    let records: store.PendingApprovalRecord[] = []
    for (let i = 0; i < 100; i++) {
      const req = buildApprovalReq({ id: `r${i}`, action: 'add-member', params: {}, from: PK_CHILD }, i)
      records.push({ req, circleId: 'circle-1', resolved: { ok: true, by: PK_GUARDIAN, at: i } })
    }
    const fresh = buildApprovalReq({ id: 'r-new', action: 'add-member', params: {}, from: PK_CHILD }, 1000)
    const result = upsertApprovalReq(records, fresh, 'circle-1')

    expect(result.length).toBe(100)
    expect(result.some((r) => r.req.id === 'r0')).toBe(false) // oldest resolved, pruned
    expect(result.some((r) => r.req.id === 'r1')).toBe(true) // next-oldest resolved, kept
    expect(result.some((r) => r.req.id === 'r-new')).toBe(true) // the new addition
  })

  it('never drops an UNRESOLVED request to make room while a resolved one could be pruned instead', () => {
    const pendingReq = buildApprovalReq({ id: 'pending', action: 'add-member', params: {}, from: PK_CHILD }, 0)
    const records: store.PendingApprovalRecord[] = [{ req: pendingReq, circleId: 'circle-1' }] // unresolved, oldest of all
    for (let i = 0; i < 99; i++) {
      const req = buildApprovalReq({ id: `r${i}`, action: 'add-member', params: {}, from: PK_CHILD }, i + 1)
      records.push({ req, circleId: 'circle-1', resolved: { ok: true, by: PK_GUARDIAN, at: i + 1 } })
    }
    const fresh = buildApprovalReq({ id: 'r-new', action: 'add-member', params: {}, from: PK_CHILD }, 1000)
    const result = upsertApprovalReq(records, fresh, 'circle-1')

    expect(result.length).toBe(100)
    expect(result.some((r) => r.req.id === 'pending')).toBe(true) // unresolved survives even though it's the oldest record overall
    expect(result.some((r) => r.req.id === 'r0')).toBe(false) // oldest RESOLVED gets pruned instead
  })

  it('leaves an already-within-cap array untouched (same reference)', () => {
    const req = buildApprovalReq({ id: 'r1', action: 'add-member', params: {}, from: PK_CHILD }, 0)
    const records = [{ req, circleId: 'circle-1' }]
    const fresh = buildApprovalReq({ id: 'r2', action: 'add-member', params: {}, from: PK_CHILD }, 1)
    const result = upsertApprovalReq(records, fresh, 'circle-1')
    expect(result.length).toBe(2)
  })
})

describe('applyApprovalResp', () => {
  it('resolves a matching unresolved request', () => {
    const req = buildApprovalReq({ id: 'r1', action: 'add-member', params: {}, from: PK_CHILD }, 100)
    const records = [{ req, circleId: 'circle-1' }]
    const resp = buildApprovalResp({ id: 'r1', ok: true, by: PK_GUARDIAN }, 200)
    expect(applyApprovalResp(records, resp)).toEqual([{ req, circleId: 'circle-1', resolved: { ok: true, by: PK_GUARDIAN, at: 200 } }])
  })

  it('records a denial the same way', () => {
    const req = buildApprovalReq({ id: 'r1', action: 'add-member', params: {}, from: PK_CHILD }, 100)
    const records = [{ req, circleId: 'circle-1' }]
    const resp = buildApprovalResp({ id: 'r1', ok: false, by: PK_GUARDIAN }, 200)
    expect(applyApprovalResp(records, resp)[0]?.resolved).toEqual({ ok: false, by: PK_GUARDIAN, at: 200 })
  })

  it('is a no-op replaying a resp once already resolved (idempotent/dedupe)', () => {
    const req = buildApprovalReq({ id: 'r1', action: 'add-member', params: {}, from: PK_CHILD }, 100)
    const records = [{ req, circleId: 'circle-1', resolved: { ok: true, by: PK_GUARDIAN, at: 200 } }]
    const resp = buildApprovalResp({ id: 'r1', ok: false, by: 'someone-else' }, 999)
    expect(applyApprovalResp(records, resp)).toEqual(records)
  })

  it('is a no-op for a resp naming an unknown request id', () => {
    const req = buildApprovalReq({ id: 'r1', action: 'add-member', params: {}, from: PK_CHILD }, 100)
    const records = [{ req, circleId: 'circle-1' }]
    const resp = buildApprovalResp({ id: 'nonexistent', ok: true, by: PK_GUARDIAN }, 200)
    expect(applyApprovalResp(records, resp)).toEqual(records)
  })
})

describe('newApprovalId', () => {
  it('produces distinct ids', () => {
    expect(newApprovalId()).not.toBe(newApprovalId())
  })
})

describe('decodeBroodSignal', () => {
  it('returns null for a rumor that is not a brood signal (e.g. a plain beacon)', () => {
    const rumor: Rumor = { pubkey: PK_CHILD, created_at: 1000, kind: 20_078, tags: [['t', 'beacon']], content: '{}' }
    expect(decodeBroodSignal(rumor, fakeSender(PK_CHILD))).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// handleIncomingSignal — matching, dedupe, and the redo-on-approval trigger.
// No localStorage/network needed for most of these: `handleIncomingSignal`
// takes an already-decoded `Rumor`, same precedent as agreements.test.ts's
// self-echo coverage.
// ---------------------------------------------------------------------------

describe('handleIncomingSignal', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })

  it('ignores a signal whose pubkey is this device\'s own (self-echo)', () => {
    signIn(PK_CHILD, 'c'.repeat(64), true)
    const myPhonePk = currentSession()!.phonePk
    store.save(fakePersisted({}))
    const circle = fakeCircle()
    const rumor: Rumor = { pubkey: myPhonePk, created_at: 1000, kind: 20_078, tags: [['t', 'approval-req']], content: 'not json' }
    expect(() => handleIncomingSignal(circle, rumor, 'approval-req', fakeSender(myPhonePk, PK_CHILD, false))).not.toThrow()
    expect(store.load().approvals).toEqual([])
  })

  it('two phones, one identity: a structural approval-resp from this identity\'s OTHER phone is applied; one from THIS phone is self-echo and skipped', () => {
    signIn(PK_GUARDIAN, toHex(generateSecretKey()), false)
    const myPhonePk = currentSession()!.phonePk
    // Review fix round 1: the OTHER phone belongs to the SAME identity as
    // the signed-in session (PK_GUARDIAN) — own-echo turns on the SEALING
    // PHONE (`sender.signerPk`), never on the resolved identity, so a
    // structural signal genuinely signed by this identity but sealed by a
    // phone that isn't THIS device's own must still be applied.
    const otherPhonePk = makeLocalSigner(toHex(generateSecretKey())).pubkey
    const circle = fakeCircle({ id: 'circle-two-phones' })
    const req: ApprovalReq = buildApprovalReq({ id: 'r-two-phones', action: 'add-member', params: { pk: 'x'.repeat(64) }, from: PK_CHILD }, 100)
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id }] }))

    const resp = buildApprovalResp({ id: 'r-two-phones', ok: true, by: PK_GUARDIAN }, 200)
    const rumor: Rumor = { pubkey: otherPhonePk, created_at: 200, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(resp) }

    // Sealed by this SAME identity's OTHER phone (resolves to PK_GUARDIAN,
    // same as the signed-in session) — not this device's own phone key, so
    // it isn't self-echo and the structural resp is applied.
    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(otherPhonePk, PK_GUARDIAN, true))
    expect(store.load().approvals.find((r) => r.req.id === 'r-two-phones')?.resolved).toEqual({ ok: true, by: PK_GUARDIAN, at: 200 })

    // The identical content, sealed by THIS device's own phone key instead —
    // dropped as self-echo before ever reaching the reducer.
    store.update((p) => { p.approvals = [{ req, circleId: circle.id }] }) // reset to unresolved
    const echoRumor: Rumor = { ...rumor, pubkey: myPhonePk }
    handleIncomingSignal(circle, echoRumor, 'approval-resp', fakeSender(myPhonePk, PK_GUARDIAN, true))
    expect(store.load().approvals.find((r) => r.req.id === 'r-two-phones')?.resolved).toBeUndefined()
  })

  it('records an incoming approval-req, stamping it with the circle it arrived on', () => {
    signIn(PK_GUARDIAN, toHex(generateSecretKey()), false)
    store.save(fakePersisted({}))
    const circle = fakeCircle({ id: 'circle-9' })
    const req: ApprovalReq = buildApprovalReq({ id: 'r1', action: 'add-member', params: { pk: 'x'.repeat(64) }, from: PK_CHILD }, 100)
    const rumor: Rumor = { pubkey: PK_CHILD, created_at: 100, kind: 20_078, tags: [['t', 'approval-req']], content: JSON.stringify(req) }
    handleIncomingSignal(circle, rumor, 'approval-req', fakeSender(rumor.pubkey, rumor.pubkey, false))
    expect(store.load().approvals).toEqual([{ req, circleId: 'circle-9' }])
  })

  it('merges an incoming family-policy via latest-wins', () => {
    signIn(PK_CHILD, 'c'.repeat(64), true)
    store.save(fakePersisted({}))
    const circle = fakeCircle()
    const policy: FamilyPolicy = { t: 'family-policy', circleId: circle.id, rules: { 'add-member': 'allow' }, updatedAt: 1000, by: PK_GUARDIAN }
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 1000, kind: 20_078, tags: [['t', 'family-policy']], content: JSON.stringify(policy) }
    handleIncomingSignal(circle, rumor, 'family-policy', fakeSender(rumor.pubkey, rumor.pubkey, true))
    expect(store.load().familyPolicies).toEqual({ [circle.id]: policy })
  })

  // Review fix round 1: family-policy is a STRUCTURAL action — even a
  // well-formed, correctly-`by`-bound copy must never apply if it arrived
  // phone-signed (beacons.ts's choke point already drops this in
  // production; this proves the handler's own belt-and-braces re-check).
  it('ignores a family-policy delivered non-structurally (sender.structural: false), even with a genuine by match', () => {
    signIn(PK_CHILD, 'c'.repeat(64), true)
    store.save(fakePersisted({}))
    const circle = fakeCircle()
    const policy: FamilyPolicy = { t: 'family-policy', circleId: circle.id, rules: { 'add-member': 'allow' }, updatedAt: 1000, by: PK_GUARDIAN }
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 1000, kind: 20_078, tags: [['t', 'family-policy']], content: JSON.stringify(policy) }
    handleIncomingSignal(circle, rumor, 'family-policy', fakeSender(rumor.pubkey, rumor.pubkey, false))
    expect(store.load().familyPolicies).toEqual({})
  })

  // Review fix round 1: authority is bound to the circle the signal actually
  // arrived on — a guardian of circle A genuinely signing a family-policy
  // FOR circle B must not have it applied just because this device received
  // it while subscribed to A's inbox.
  it('drops a family-policy whose own circleId does not match the circle it arrived on (cross-circle)', () => {
    signIn(PK_CHILD, 'c'.repeat(64), true)
    store.save(fakePersisted({}))
    const circleA = fakeCircle({ id: 'circle-a' })
    const policyForB: FamilyPolicy = { t: 'family-policy', circleId: 'circle-b', rules: { 'add-member': 'allow' }, updatedAt: 1000, by: PK_GUARDIAN }
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 1000, kind: 20_078, tags: [['t', 'family-policy']], content: JSON.stringify(policyForB) }
    handleIncomingSignal(circleA, rumor, 'family-policy', fakeSender(rumor.pubkey, rumor.pubkey, true))
    expect(store.load().familyPolicies).toEqual({})
  })

  it('resolves a matching pending request and calls the registered redo handler with the original params — exactly once, even if the resp is replayed', () => {
    const circle = fakeCircle()
    const req = buildApprovalReq({ id: 'r1', action: 'create-circle', params: { name: 'Cousins' }, from: PK_CHILD }, 100)
    signIn(PK_CHILD, 'c'.repeat(64), true)
    // Final fix B2/I2: raisedByPhonePk must match THIS device's own phone
    // for the redo to fire — this fixture is standing in for "this is the
    // phone that raised it".
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id, raisedByPhonePk: makeLocalSigner('c'.repeat(64)).pubkey }] }))

    const handler = vi.fn()
    registerApprovalAction('create-circle', handler)

    const resp = buildApprovalResp({ id: 'r1', ok: true, by: PK_GUARDIAN }, 200)
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 200, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(resp) }

    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(rumor.pubkey, rumor.pubkey, true))
    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ name: 'Cousins' })
    expect(store.load().approvals[0]?.resolved).toEqual({ ok: true, by: PK_GUARDIAN, at: 200 })

    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(rumor.pubkey, rumor.pubkey, true)) // replay
    expect(handler).toHaveBeenCalledTimes(1)
  })

  it('final fix B2/I2: only the phone that RAISED the request redoes it — a second phone of the SAME identity that merely received the req over the wire does not (spec §5, two phones per identity)', () => {
    const circle = fakeCircle()
    const req = buildApprovalReq({ id: 'r-two-phones', action: 'create-circle', params: { name: 'Cousins' }, from: PK_CHILD }, 100)
    const resp = buildApprovalResp({ id: 'r-two-phones', ok: true, by: PK_GUARDIAN }, 200)
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 200, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(resp) }

    const handler = vi.fn()
    registerApprovalAction('create-circle', handler)

    // Phone 1 raised the request itself — raiseApproval's own local write
    // (simulated here) stamps its own phone key.
    const phone1SkHex = 'c'.repeat(64)
    signIn(PK_CHILD, phone1SkHex, true)
    store.save(fakePersisted({
      circles: [circle],
      approvals: [{ req, circleId: circle.id, raisedByPhonePk: makeLocalSigner(phone1SkHex).pubkey }],
    }))
    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(rumor.pubkey, rumor.pubkey, true))
    expect(handler).toHaveBeenCalledTimes(1) // one circle created

    // Phone 2 of the SAME identity only ever RECEIVED the same req as
    // ordinary wire traffic (the receive path's 3-arg upsertApprovalReq
    // call never stamps raisedByPhonePk) — its own local record has none.
    const phone2SkHex = toHex(generateSecretKey())
    signIn(PK_CHILD, phone2SkHex, true)
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id }] }))
    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(rumor.pubkey, rumor.pubkey, true))
    expect(handler).toHaveBeenCalledTimes(1) // still just once — phone 2 did not redo it
  })

  // Review fix round 1: approval-resp is a STRUCTURAL action — a
  // phone-signed copy (sender.structural: false) must never resolve a
  // pending request, even with a genuine by match.
  it('ignores an approval-resp delivered non-structurally (sender.structural: false), even with a genuine by match', () => {
    const circle = fakeCircle()
    const req = buildApprovalReq({ id: 'r-nonstruct', action: 'create-circle', params: { name: 'Cousins' }, from: PK_CHILD }, 100)
    signIn(PK_CHILD, 'c'.repeat(64), true)
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id }] }))

    const resp = buildApprovalResp({ id: 'r-nonstruct', ok: true, by: PK_GUARDIAN }, 200)
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 200, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(resp) }
    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(rumor.pubkey, rumor.pubkey, false))
    expect(store.load().approvals.find((r) => r.req.id === 'r-nonstruct')?.resolved).toBeUndefined()
  })

  // Review fix round 1: authority is bound to the PENDING RECORD's own
  // circle (approval-resp itself carries no circleId) — a genuine
  // guardian-signed resp for a request this device tracks under circle B
  // must not resolve it just because the resp arrived on circle A's inbox.
  it('drops an approval-resp whose pending record is tracked under a DIFFERENT circle than the one it arrived on (cross-circle)', () => {
    const circleA = fakeCircle({ id: 'circle-a' })
    const req = buildApprovalReq({ id: 'r-cross', action: 'create-circle', params: { name: 'Cousins' }, from: PK_CHILD }, 100)
    signIn(PK_CHILD, 'c'.repeat(64), true)
    store.save(fakePersisted({ circles: [circleA], approvals: [{ req, circleId: 'circle-b' }] }))

    const resp = buildApprovalResp({ id: 'r-cross', ok: true, by: PK_GUARDIAN }, 200)
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 200, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(resp) }
    handleIncomingSignal(circleA, rumor, 'approval-resp', fakeSender(rumor.pubkey, rumor.pubkey, true))
    expect(store.load().approvals.find((r) => r.req.id === 'r-cross')?.resolved).toBeUndefined()
  })

  it('does not call the redo handler on a denial', () => {
    const circle = fakeCircle()
    const req = buildApprovalReq({ id: 'r2', action: 'create-circle', params: { name: 'Cousins' }, from: PK_CHILD }, 100)
    signIn(PK_CHILD, 'c'.repeat(64), true)
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id }] }))

    const handler = vi.fn()
    registerApprovalAction('create-circle', handler)

    const resp = buildApprovalResp({ id: 'r2', ok: false, by: PK_GUARDIAN }, 200)
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 200, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(resp) }
    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(rumor.pubkey, rumor.pubkey, true))

    expect(handler).not.toHaveBeenCalled()
    expect(store.load().approvals[0]?.resolved).toEqual({ ok: false, by: PK_GUARDIAN, at: 200 })
  })

  it('resolves the request but does NOT call the redo handler on a device that is not the requester (e.g. a co-guardian who did not ask)', () => {
    const circle = fakeCircle()
    const req = buildApprovalReq({ id: 'r3', action: 'create-circle', params: { name: 'Cousins' }, from: PK_CHILD }, 100)
    const observer = 'd'.repeat(64)
    signIn(observer, 'e'.repeat(64), false)
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id }] }))

    const handler = vi.fn()
    registerApprovalAction('create-circle', handler)

    const resp = buildApprovalResp({ id: 'r3', ok: true, by: PK_GUARDIAN }, 200)
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 200, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(resp) }
    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(rumor.pubkey, rumor.pubkey, true))

    expect(handler).not.toHaveBeenCalled()
    expect(store.load().approvals[0]?.resolved).toEqual({ ok: true, by: PK_GUARDIAN, at: 200 })
  })
})

describe('handleIncomingSignal — sender-auth binding (ffb48b9 class) — forgery rejection', () => {
  // Each case: validly "wrapped" (a plausible rumor.pubkey — the real,
  // authenticated sender post roost-kit 504cff8) but the content's own
  // actor field (BROOD.md §3's `by`/`from`) dishonestly names someone else.
  // Dropped wholesale — nothing recorded/applied.
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })

  const attacker = 'd'.repeat(64)

  it('drops an approval-req whose `from` names someone other than the actual sender', () => {
    signIn(PK_GUARDIAN, toHex(generateSecretKey()), false)
    store.save(fakePersisted({}))
    const circle = fakeCircle({ id: 'circle-9' })
    const req: ApprovalReq = buildApprovalReq({ id: 'r1', action: 'add-member', params: { pk: 'x'.repeat(64) }, from: PK_CHILD }, 100)
    const rumor: Rumor = { pubkey: attacker, created_at: 100, kind: 20_078, tags: [['t', 'approval-req']], content: JSON.stringify(req) }
    handleIncomingSignal(circle, rumor, 'approval-req', fakeSender(rumor.pubkey, rumor.pubkey, false))
    expect(store.load().approvals).toEqual([])
  })

  it('drops a family-policy whose `by` names someone other than the actual sender', () => {
    signIn(PK_CHILD, 'c'.repeat(64), true)
    store.save(fakePersisted({}))
    const circle = fakeCircle()
    const policy: FamilyPolicy = { t: 'family-policy', circleId: circle.id, rules: { 'add-member': 'allow' }, updatedAt: 1000, by: PK_GUARDIAN }
    const rumor: Rumor = { pubkey: attacker, created_at: 1000, kind: 20_078, tags: [['t', 'family-policy']], content: JSON.stringify(policy) }
    handleIncomingSignal(circle, rumor, 'family-policy', fakeSender(rumor.pubkey, rumor.pubkey, true))
    expect(store.load().familyPolicies).toEqual({})
  })

  it('drops an approval-resp whose `by` names someone other than the actual sender — request stays unresolved', () => {
    const circle = fakeCircle()
    const req = buildApprovalReq({ id: 'r1', action: 'create-circle', params: { name: 'Cousins' }, from: PK_CHILD }, 100)
    signIn(PK_CHILD, 'c'.repeat(64), true)
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id }] }))

    const handler = vi.fn()
    registerApprovalAction('create-circle', handler)

    const resp = buildApprovalResp({ id: 'r1', ok: true, by: PK_GUARDIAN }, 200)
    const rumor: Rumor = { pubkey: attacker, created_at: 200, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(resp) }
    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(rumor.pubkey, rumor.pubkey, true))

    expect(handler).not.toHaveBeenCalled()
    expect(store.load().approvals[0]?.resolved).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Outgoing actions — real (non-network) crypto, mocked publish. Proves the
// wire round trip end to end (build -> gift-wrap -> publish payload ->
// unwrap -> decode), not just the reducers in isolation.
// ---------------------------------------------------------------------------

describe('raiseApproval / respondApproval / publishFamilyPolicy — wire round trip', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(publishSigned).mockClear()
    vi.mocked(publishSigned).mockResolvedValue({} as never)
  })

  it('raiseApproval persists a pending record and publishes a decryptable approval-req to the circle inbox', async () => {
    const child = realKeypair()
    const guardian = realKeypair()
    const members: CircleMember[] = [{ pk: guardian.pkHex, role: 'guardian' }, { pk: child.pkHex, role: 'child' }]
    const circle = fakeCircle({ members })
    signIn(child.pkHex, child.skHex, true)
    store.save(fakePersisted({ circles: [circle] }))

    const reqId = await raiseApproval(circle.id, 'add-member', { circleId: circle.id, pk: 'x'.repeat(64), method: 'npub' })
    expect(reqId).toBeTruthy()

    const pending = store.load().approvals.find((r) => r.req.id === reqId)
    expect(pending?.resolved).toBeUndefined()
    expect(pending?.req.from).toBe(child.pkHex)

    expect(publishSigned).toHaveBeenCalledTimes(1)
    const call = vi.mocked(publishSigned).mock.calls[0]
    const signed = call?.[1] as SignedEvent
    const inbox = deriveInbox(circle.seedHex)
    const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), signed)
    expect(rumor).not.toBeNull()
    expect(decodeBroodSignal(rumor as Rumor, fakeSender((rumor as Rumor).pubkey))).toEqual(pending?.req)
  })

  it('respondApproval (guardian) resolves locally and publishes a decryptable approval-resp', async () => {
    const child = realKeypair()
    const guardian = realKeypair()
    const members: CircleMember[] = [{ pk: guardian.pkHex, role: 'guardian' }, { pk: child.pkHex, role: 'child' }]
    const circle = fakeCircle({ members })
    const req = buildApprovalReq({ id: 'r1', action: 'add-member', params: { circleId: circle.id, pk: 'x'.repeat(64), method: 'npub' }, from: child.pkHex }, 100)
    // approval-resp is now identity-signed structural (Signet identity plan,
    // Task 9) — the transport is the guardian's own key, so the structural
    // queue can actually sign and drain it in this test.
    signIn(guardian.pkHex, guardian.skHex, false, guardian.skHex)
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id }] }))
    registerStructuralSenders()

    await respondApproval('r1', true)
    await queue.drain()

    const resolved = store.load().approvals.find((r) => r.req.id === 'r1')?.resolved
    expect(resolved).toEqual({ ok: true, by: guardian.pkHex, at: expect.any(Number) })

    expect(publishSigned).toHaveBeenCalledTimes(1)
    const call = vi.mocked(publishSigned).mock.calls[0]
    const outerSigned = call?.[1] as SignedEvent
    const inbox = deriveInbox(circle.seedHex)
    const outerRumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), outerSigned)
    expect(outerRumor).not.toBeNull()
    const structSigned = JSON.parse((outerRumor as Rumor).content) as SignedEvent
    const ev = verifyStructural(structSigned)
    expect(ev?.action).toBe('approval-resp')
    expect(ev?.signerPk).toBe(guardian.pkHex)
    expect(JSON.parse(ev?.payload ?? 'null')).toEqual({ t: 'approval-resp', id: 'r1', ok: true, by: guardian.pkHex, at: resolved?.at })
  })

  it('respondApproval no-ops for a non-guardian device (cannot answer requests in a circle it does not guard)', async () => {
    const child = realKeypair()
    const other = realKeypair()
    const circle = fakeCircle({ members: [{ pk: child.pkHex, role: 'child' }] })
    const req = buildApprovalReq({ id: 'r1', action: 'add-member', params: {}, from: child.pkHex }, 100)
    signIn(other.pkHex, other.skHex, false)
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id }] }))

    await respondApproval('r1', true)

    expect(publishSigned).not.toHaveBeenCalled()
    expect(store.load().approvals[0]?.resolved).toBeUndefined()
  })

  it('publishFamilyPolicy (guardian) applies the full ruleset locally and publishes a decryptable family-policy', async () => {
    const guardian = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian' }] })
    // family-policy is now identity-signed structural (Signet identity plan,
    // Task 9) — the transport is the guardian's own key.
    signIn(guardian.pkHex, guardian.skHex, false, guardian.skHex)
    store.save(fakePersisted({ circles: [circle] }))
    registerStructuralSenders()

    await publishFamilyPolicy(circle.id, { 'create-circle': 'deny', 'add-member': 'prompt', 'join-circle': 'allow', 'add-contact': 'allow' })
    await queue.drain()

    const policy = store.load().familyPolicies[circle.id]
    expect(policy?.rules).toEqual({ 'create-circle': 'deny', 'add-member': 'prompt', 'join-circle': 'allow', 'add-contact': 'allow' })
    expect(policy?.by).toBe(guardian.pkHex)

    expect(publishSigned).toHaveBeenCalledTimes(1)
    const call = vi.mocked(publishSigned).mock.calls[0]
    const outerSigned = call?.[1] as SignedEvent
    const inbox = deriveInbox(circle.seedHex)
    const outerRumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), outerSigned)
    const structSigned = JSON.parse((outerRumor as Rumor).content) as SignedEvent
    const ev = verifyStructural(structSigned)
    expect(ev?.action).toBe('family-policy')
    expect(ev?.signerPk).toBe(guardian.pkHex)
    expect(JSON.parse(ev?.payload ?? 'null')).toEqual(policy)
  })

  it('final fix round 3, F2: publishFamilyPolicy changes nothing locally at enqueue — the item only waits in the queue', async () => {
    const guardian = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian' }] })
    const existingPolicy: FamilyPolicy = { t: 'family-policy', circleId: circle.id, rules: { 'add-member': 'allow' }, updatedAt: 50, by: guardian.pkHex }
    // No identity transport: the queue can never sign this, like an asleep My Signet.
    signIn(guardian.pkHex, guardian.skHex, false)
    store.save(fakePersisted({ circles: [circle], familyPolicies: { [circle.id]: existingPolicy } }))
    registerStructuralSenders()

    await publishFamilyPolicy(circle.id, { 'create-circle': 'deny' })
    await queue.drain()

    expect(store.load().familyPolicies[circle.id]).toEqual(existingPolicy)
    expect(store.load().activity).toEqual([])
    expect(queue.pending().map((q) => [q.action, q.status])).toEqual([['family-policy', 'waiting']])
  })

  it('final fix round 3, F2: a cancelled publishFamilyPolicy has nothing to undo — a co-guardian\'s newer policy that arrived meanwhile is never overwritten', async () => {
    const guardian = realKeypair()
    const coGuardian = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian' }, { pk: coGuardian.pkHex, role: 'guardian' }] })
    const existingPolicy: FamilyPolicy = { t: 'family-policy', circleId: circle.id, rules: { 'add-member': 'allow' }, updatedAt: 50, by: guardian.pkHex }
    signIn(guardian.pkHex, guardian.skHex, false)
    store.save(fakePersisted({ circles: [circle], familyPolicies: { [circle.id]: existingPolicy } }))
    registerStructuralSenders()

    await publishFamilyPolicy(circle.id, { 'create-circle': 'deny' })
    const newer: FamilyPolicy = { t: 'family-policy', circleId: circle.id, rules: { 'create-circle': 'allow' }, updatedAt: Math.floor(Date.now() / 1000) + 5, by: coGuardian.pkHex }
    const rumor: Rumor = { pubkey: coGuardian.pkHex, created_at: newer.updatedAt, kind: 20_078, tags: [['t', 'family-policy']], content: JSON.stringify(newer) }
    handleIncomingSignal(circle, rumor, 'family-policy', fakeSender(coGuardian.pkHex, coGuardian.pkHex, true))
    expect(store.load().familyPolicies[circle.id]).toEqual(newer)

    queue.cancel(queue.pending().find((q) => q.action === 'family-policy')!.id)
    expect(store.load().familyPolicies[circle.id]).toEqual(newer)
  })

  it('final fix round 3, F2: once sent, our policy is applied latest-wins — it never overwrites a newer co-guardian policy', async () => {
    const guardian = realKeypair()
    const coGuardian = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian' }, { pk: coGuardian.pkHex, role: 'guardian' }] })
    signIn(guardian.pkHex, guardian.skHex, false)
    store.save(fakePersisted({ circles: [circle] }))
    registerStructuralSenders()

    await publishFamilyPolicy(circle.id, { 'create-circle': 'deny' })
    await queue.drain()
    const newer: FamilyPolicy = { t: 'family-policy', circleId: circle.id, rules: { 'create-circle': 'allow' }, updatedAt: Math.floor(Date.now() / 1000) + 5, by: coGuardian.pkHex }
    store.update((p) => { p.familyPolicies = { [circle.id]: newer } })

    signIn(guardian.pkHex, guardian.skHex, false, guardian.skHex) // My Signet is back
    await queue.drain()
    expect(queue.pending()).toEqual([])
    expect(publishSigned).toHaveBeenCalledTimes(1)
    expect(store.load().familyPolicies[circle.id]).toEqual(newer)
  })

  it('final fix round 3, F2: sign-out with a pending policy — nothing leaks into the next session', async () => {
    const guardian = realKeypair()
    const next = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian' }] })
    signIn(guardian.pkHex, guardian.skHex, false)
    store.save(fakePersisted({ circles: [circle] }))
    registerStructuralSenders()
    await publishFamilyPolicy(circle.id, { 'create-circle': 'deny' })
    await queue.drain()

    // Sign out (signin.ts's doSignOut clears the store), then someone else
    // signs in on the same circle id with My Signet available.
    store.clear()
    sessionForTests(null)
    signIn(next.pkHex, next.skHex, false, next.skHex)
    const nextCircle = fakeCircle({ members: [{ pk: next.pkHex, role: 'guardian' }] })
    store.save(fakePersisted({ circles: [nextCircle] }))
    await publishFamilyPolicy(nextCircle.id, { 'add-member': 'allow' })
    await queue.drain()

    expect(queue.pending()).toEqual([])
    expect(publishSigned).toHaveBeenCalledTimes(1)
    expect(store.load().familyPolicies[nextCircle.id]?.by).toBe(next.pkHex)
    expect(store.load().familyPolicies[nextCircle.id]?.rules).toEqual({ 'add-member': 'allow' })
  })

  it('final fix round 4: sign-out while the policy send is in flight — the next session\'s store gets nothing', async () => {
    const guardian = realKeypair()
    const next = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian' }] })
    signIn(guardian.pkHex, guardian.skHex, false, guardian.skHex)
    store.save(fakePersisted({ circles: [circle] }))
    registerStructuralSenders()
    let release!: () => void
    let started!: () => void
    const inFlight = new Promise<void>((r) => { started = r })
    vi.mocked(publishSigned).mockImplementationOnce(async () => { started(); await new Promise<void>((r) => { release = r }); return {} as never })

    await publishFamilyPolicy(circle.id, { 'create-circle': 'deny' })
    const drained = queue.drain()
    await inFlight
    // Sign out (doSignOut clears the store), then the next person signs in
    // on the same circle id.
    store.clear()
    sessionForTests(null)
    signIn(next.pkHex, next.skHex, false)
    store.save(fakePersisted({ circles: [fakeCircle({ members: [{ pk: next.pkHex, role: 'guardian' }] })] }))
    release()
    await drained

    expect(store.load().familyPolicies[circle.id]).toBeUndefined()
  })

  it('final fix round 3, F2: respondApproval leaves the request waiting until the answer is sent, then resolves it and fires the listener once', async () => {
    const child = realKeypair()
    const guardian = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian' }, { pk: child.pkHex, role: 'child' }] })
    const req = buildApprovalReq({ id: 'r1', action: 'add-member', params: {}, from: child.pkHex }, 100)
    signIn(guardian.pkHex, guardian.skHex, false)
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id }] }))
    registerStructuralSenders()
    const listener = vi.fn()
    registerApprovalResolutionListener(listener)

    await respondApproval('r1', true)
    await respondApproval('r1', true) // a second tap while waiting on My Signet
    await queue.drain()
    expect(store.load().approvals.find((r) => r.req.id === 'r1')?.resolved).toBeUndefined()
    expect(listener).not.toHaveBeenCalled()
    expect(store.load().activity).toEqual([])
    expect(queue.pending().filter((q) => q.action === 'approval-resp')).toHaveLength(1)

    signIn(guardian.pkHex, guardian.skHex, false, guardian.skHex) // My Signet is back
    await queue.drain()
    expect(store.load().approvals.find((r) => r.req.id === 'r1')?.resolved).toEqual({ ok: true, by: guardian.pkHex, at: expect.any(Number) })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('final fix round 3, F2: a cancelled respondApproval has nothing to undo — and another guardian\'s answer that arrived meanwhile stands', async () => {
    const child = realKeypair()
    const guardian = realKeypair()
    const coGuardian = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian' }, { pk: coGuardian.pkHex, role: 'guardian' }, { pk: child.pkHex, role: 'child' }] })
    const req = buildApprovalReq({ id: 'r1', action: 'add-member', params: {}, from: child.pkHex }, 100)
    signIn(guardian.pkHex, guardian.skHex, false)
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id }] }))
    registerStructuralSenders()
    const listener = vi.fn()
    registerApprovalResolutionListener(listener)

    await respondApproval('r1', true)
    const theirs = buildApprovalResp({ id: 'r1', ok: false, by: coGuardian.pkHex }, 200)
    const rumor: Rumor = { pubkey: coGuardian.pkHex, created_at: 200, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(theirs) }
    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(coGuardian.pkHex, coGuardian.pkHex, true))
    expect(listener).toHaveBeenCalledTimes(1)

    queue.cancel(queue.pending().find((q) => q.action === 'approval-resp')!.id)
    expect(store.load().approvals.find((r) => r.req.id === 'r1')?.resolved).toEqual({ ok: false, by: coGuardian.pkHex, at: 200 })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

// ---------------------------------------------------------------------------
// Phase 5 Task 5 (brief §13.4) — boundary-exit requests. Verifies the params-
// encoding choice against the REAL BROOD wire (not a mock of it), the
// `PARAMS_KIND_KEY` defense-in-depth guard, and the two registration hooks
// places.ts relies on for local policy auto-resolution and cross-device
// convergence.
// ---------------------------------------------------------------------------

function fakeLeaveParams(overrides: Partial<LeaveAreaParams> = {}): LeaveAreaParams {
  return { placeName: 'Home', placeId: 'place-1', destination: 'The park', withWho: 'Sam', durationMin: 30, precisionTerm: 'Street', ...overrides }
}

describe('boundary-exit requests (Phase 5 Task 5, §13.4) — action/params encoding, verified against the REAL BROOD wire', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(publishSigned).mockClear()
    vi.mocked(publishSigned).mockResolvedValue({} as never)
  })

  it('a literal action of "leave-area" is REJECTED by the real parseBroodSignal (proves a borrowed envelope is required, not optional)', () => {
    const req = buildApprovalReq({ id: 'r1', action: 'leave-area' as never, params: encodeLeaveAreaParams(fakeLeaveParams()), from: 'a'.repeat(64) }, 100)
    const inner = { kind: 20_078, tags: [['t', 'approval-req']], content: JSON.stringify(req) }
    expect(parseBroodSignal(inner)).toBeNull()
  })

  it('the borrowed-envelope action + encoded params round-trip through the REAL parseBroodSignal untouched', () => {
    const params = fakeLeaveParams()
    const wireParams = encodeLeaveAreaParams(params)
    const req = buildApprovalReq({ id: 'r1', action: LEAVE_AREA_ENVELOPE_ACTION, params: wireParams, from: 'a'.repeat(64) }, 100)
    const inner = { kind: 20_078, tags: [['t', 'approval-req']], content: JSON.stringify(req) }
    const parsed = parseBroodSignal(inner)
    expect(parsed).not.toBeNull()
    expect(parsed).toEqual(req)
    expect(decodeLeaveAreaParams((parsed as ApprovalReq).params)).toEqual(params)
  })

  it('raiseApproval publishes a decryptable, REAL-parser-valid leave-area approval-req over the actual gift-wrap round trip', async () => {
    const child = realKeypair()
    const guardian = realKeypair()
    const members: CircleMember[] = [{ pk: guardian.pkHex, role: 'guardian' }, { pk: child.pkHex, role: 'child' }]
    const circle = fakeCircle({ members })
    signIn(child.pkHex, child.skHex, true)
    store.save(fakePersisted({ circles: [circle] }))

    const params = fakeLeaveParams()
    const reqId = await raiseApproval(circle.id, LEAVE_AREA_ENVELOPE_ACTION, encodeLeaveAreaParams(params))
    expect(reqId).toBeTruthy()

    expect(publishSigned).toHaveBeenCalledTimes(1)
    const call = vi.mocked(publishSigned).mock.calls[0]
    const signed = call?.[1] as SignedEvent
    const inbox = deriveInbox(circle.seedHex)
    const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), signed)
    expect(rumor).not.toBeNull()
    const decoded = decodeBroodSignal(rumor as Rumor, fakeSender((rumor as Rumor).pubkey)) as ApprovalReq
    expect(decoded.action).toBe(LEAVE_AREA_ENVELOPE_ACTION)
    expect(decodeLeaveAreaParams(decoded.params)).toEqual(params)

    // Activity gets leave-area's OWN richer kind, not the generic
    // 'approval-requested'/"wants to add a new contact" line.
    const activityEntry = store.load().activity.find((e) => e.circleId === circle.id)
    expect(activityEntry?.kind).toBe('leave-requested')
  })

  it('respondApproval publishes a decryptable, REAL-parser-valid approval-resp, and records the leave-approved Activity kind', async () => {
    const child = realKeypair()
    const guardian = realKeypair()
    const members: CircleMember[] = [{ pk: guardian.pkHex, role: 'guardian' }, { pk: child.pkHex, role: 'child' }]
    const circle = fakeCircle({ members })
    const req = buildApprovalReq({ id: 'r1', action: LEAVE_AREA_ENVELOPE_ACTION, params: encodeLeaveAreaParams(fakeLeaveParams()), from: child.pkHex }, 100)
    signIn(guardian.pkHex, guardian.skHex, false, guardian.skHex)
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id }] }))
    registerStructuralSenders()

    await respondApproval('r1', true)
    await queue.drain()

    expect(publishSigned).toHaveBeenCalledTimes(1)
    const call = vi.mocked(publishSigned).mock.calls[0]
    const outerSigned = call?.[1] as SignedEvent
    const inbox = deriveInbox(circle.seedHex)
    const outerRumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), outerSigned)
    const structSigned = JSON.parse((outerRumor as Rumor).content) as SignedEvent
    const ev = verifyStructural(structSigned)
    expect(ev?.action).toBe('approval-resp')
    const decoded = JSON.parse(ev?.payload ?? 'null')
    expect(decoded).toMatchObject({ t: 'approval-resp', id: 'r1', ok: true })

    const activityEntry = store.load().activity.find((e) => e.circleId === circle.id)
    expect(activityEntry?.kind).toBe('leave-approved')
  })
})

describe('PARAMS_KIND_KEY — runApprovedAction never re-runs a borrowed envelope\'s real handler', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })

  it('an approved leave-area request (borrowed action LEAVE_AREA_ENVELOPE_ACTION) does NOT invoke a handler registered for that same action', () => {
    const circle = fakeCircle()
    const params = encodeLeaveAreaParams(fakeLeaveParams())
    const req = buildApprovalReq({ id: 'r1', action: LEAVE_AREA_ENVELOPE_ACTION, params, from: PK_CHILD }, 100)
    signIn(PK_CHILD, 'c'.repeat(64), true)
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id }] }))

    const handler = vi.fn()
    registerApprovalAction(LEAVE_AREA_ENVELOPE_ACTION, handler)

    const resp = buildApprovalResp({ id: 'r1', ok: true, by: PK_GUARDIAN }, 200)
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 200, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(resp) }
    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(rumor.pubkey, rumor.pubkey, true))

    expect(handler).not.toHaveBeenCalled()
    expect(store.load().approvals[0]?.resolved).toEqual({ ok: true, by: PK_GUARDIAN, at: 200 })
  })

  it('sanity check: a REAL (non-borrowed) approval for that same action still DOES invoke its registered handler', () => {
    const circle = fakeCircle()
    const req = buildApprovalReq({ id: 'r2', action: LEAVE_AREA_ENVELOPE_ACTION, params: { name: 'Grandma' }, from: PK_CHILD }, 100)
    signIn(PK_CHILD, 'c'.repeat(64), true)
    // Final fix B2/I2: see the identical comment on the first test in this file.
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id, raisedByPhonePk: makeLocalSigner('c'.repeat(64)).pubkey }] }))

    const handler = vi.fn()
    registerApprovalAction(LEAVE_AREA_ENVELOPE_ACTION, handler)

    const resp = buildApprovalResp({ id: 'r2', ok: true, by: PK_GUARDIAN }, 200)
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 200, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(resp) }
    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(rumor.pubkey, rumor.pubkey, true))

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith({ name: 'Grandma' })
  })
})

describe('registerApprovalAutoResolver — leave-area\'s local, receipt-time policy check', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(publishSigned).mockClear()
    vi.mocked(publishSigned).mockResolvedValue({} as never)
  })

  it('a resolver returning true auto-approves a freshly-received request on the GUARDIAN device, publishing a resp', async () => {
    const guardian = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian' }] })
    signIn(guardian.pkHex, guardian.skHex, false, guardian.skHex)
    store.save(fakePersisted({ circles: [circle] }))
    registerStructuralSenders()
    registerApprovalAutoResolver((_circleId, req) => (req.params[PARAMS_KIND_KEY] === 'leave-area' ? true : undefined))

    // Fresh sealed timestamp — the action paths now freshness-gate (flock
    // ff5eead parity), and this test is about the resolver verdict, not the gate.
    const at = Math.floor(Date.now() / 1000) - 10
    const req = buildApprovalReq({ id: 'r1', action: LEAVE_AREA_ENVELOPE_ACTION, params: encodeLeaveAreaParams(fakeLeaveParams()), from: 'a'.repeat(64) }, at)
    const rumor: Rumor = { pubkey: 'a'.repeat(64), created_at: at, kind: 20_078, tags: [['t', 'approval-req']], content: JSON.stringify(req) }
    handleIncomingSignal(circle, rumor, 'approval-req', fakeSender(rumor.pubkey, rumor.pubkey, false))
    // respondApproval's own publish is awaited internally by handleIncomingSignal's
    // fire-and-forget `void respondApproval(...)` — flush microtasks.
    await Promise.resolve()
    await Promise.resolve()
    // Final fix round 3, F2: applied once the signed answer has gone out.
    await queue.drain()

    expect(store.load().approvals.find((r) => r.req.id === 'r1')?.resolved).toEqual({ ok: true, by: guardian.pkHex, at: expect.any(Number) })
  })

  it('a resolver returning false auto-denies', async () => {
    const guardian = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian' }] })
    signIn(guardian.pkHex, guardian.skHex, false, guardian.skHex)
    store.save(fakePersisted({ circles: [circle] }))
    registerStructuralSenders()
    registerApprovalAutoResolver((_circleId, req) => (req.params[PARAMS_KIND_KEY] === 'leave-area' ? false : undefined))

    const at = Math.floor(Date.now() / 1000) - 10
    const req = buildApprovalReq({ id: 'r2', action: LEAVE_AREA_ENVELOPE_ACTION, params: encodeLeaveAreaParams(fakeLeaveParams()), from: 'a'.repeat(64) }, at)
    const rumor: Rumor = { pubkey: 'a'.repeat(64), created_at: at, kind: 20_078, tags: [['t', 'approval-req']], content: JSON.stringify(req) }
    handleIncomingSignal(circle, rumor, 'approval-req', fakeSender(rumor.pubkey, rumor.pubkey, false))
    await Promise.resolve()
    await Promise.resolve()
    await queue.drain()

    expect(store.load().approvals.find((r) => r.req.id === 'r2')?.resolved).toEqual({ ok: false, by: guardian.pkHex, at: expect.any(Number) })
  })

  it('a resolver returning undefined ("prompt") leaves the request unresolved for manual review', () => {
    const guardian = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian' }] })
    signIn(guardian.pkHex, guardian.skHex, false)
    store.save(fakePersisted({ circles: [circle] }))
    registerApprovalAutoResolver(() => undefined)

    const req = buildApprovalReq({ id: 'r3', action: LEAVE_AREA_ENVELOPE_ACTION, params: encodeLeaveAreaParams(fakeLeaveParams()), from: 'a'.repeat(64) }, 100)
    const rumor: Rumor = { pubkey: 'a'.repeat(64), created_at: 100, kind: 20_078, tags: [['t', 'approval-req']], content: JSON.stringify(req) }
    handleIncomingSignal(circle, rumor, 'approval-req', fakeSender(rumor.pubkey, rumor.pubkey, false))

    expect(store.load().approvals.find((r) => r.req.id === 'r3')?.resolved).toBeUndefined()
    expect(publishSigned).not.toHaveBeenCalled()
  })

  it('the auto-resolver is never consulted on a NON-guardian device (nothing to auto-answer with)', () => {
    const observer = realKeypair()
    const circle = fakeCircle({ members: [{ pk: observer.pkHex, role: 'child' }] })
    signIn(observer.pkHex, observer.skHex, true)
    store.save(fakePersisted({ circles: [circle] }))
    const resolver = vi.fn(() => true)
    registerApprovalAutoResolver(resolver)

    const req = buildApprovalReq({ id: 'r4', action: LEAVE_AREA_ENVELOPE_ACTION, params: encodeLeaveAreaParams(fakeLeaveParams()), from: 'a'.repeat(64) }, 100)
    const rumor: Rumor = { pubkey: 'a'.repeat(64), created_at: 100, kind: 20_078, tags: [['t', 'approval-req']], content: JSON.stringify(req) }
    handleIncomingSignal(circle, rumor, 'approval-req', fakeSender(rumor.pubkey, rumor.pubkey, false))

    expect(resolver).not.toHaveBeenCalled()
  })
})

describe('registerApprovalResolutionListener — "both devices converge, same reducer" (task contract)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(publishSigned).mockClear()
    vi.mocked(publishSigned).mockResolvedValue({} as never)
  })

  it('fires from respondApproval (the resolver\'s OWN device) with the resolved req+resp', async () => {
    const guardian = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian' }] })
    const req = buildApprovalReq({ id: 'r1', action: LEAVE_AREA_ENVELOPE_ACTION, params: encodeLeaveAreaParams(fakeLeaveParams()), from: 'a'.repeat(64) }, 100)
    signIn(guardian.pkHex, guardian.skHex, false, guardian.skHex)
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id }] }))
    registerStructuralSenders()

    const listener = vi.fn()
    registerApprovalResolutionListener(listener)

    await respondApproval('r1', true)
    await queue.drain() // final fix round 3, F2: fires once the answer is sent

    expect(listener).toHaveBeenCalledTimes(1)
    const resolution = listener.mock.calls[0]?.[0] as ApprovalResolution
    expect(resolution.circleId).toBe(circle.id)
    expect(resolution.req).toEqual(req)
    expect(resolution.resp).toMatchObject({ id: 'r1', ok: true, by: guardian.pkHex })
  })

  it('fires from handleIncomingSignal\'s approval-resp branch (the REQUESTER\'s or any other member\'s device) exactly once, even on a replayed resp', () => {
    const circle = fakeCircle()
    const req = buildApprovalReq({ id: 'r2', action: LEAVE_AREA_ENVELOPE_ACTION, params: encodeLeaveAreaParams(fakeLeaveParams()), from: PK_CHILD }, 100)
    signIn(PK_CHILD, 'c'.repeat(64), true)
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id }] }))

    const listener = vi.fn()
    registerApprovalResolutionListener(listener)

    const resp = buildApprovalResp({ id: 'r2', ok: false, by: PK_GUARDIAN }, 200)
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 200, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(resp) }
    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(rumor.pubkey, rumor.pubkey, true))
    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(rumor.pubkey, rumor.pubkey, true)) // replay

    expect(listener).toHaveBeenCalledTimes(1)
    const resolution = listener.mock.calls[0]?.[0] as ApprovalResolution
    expect(resolution.req).toEqual(req)
    expect(resolution.resp).toEqual(resp)
  })
})

// ---------------------------------------------------------------------------
// Flock ff5eead parity — freshness-gate the ACTIONABLE approval paths. The
// rumor-id dedup upstream is per-session; after a relaunch a captured
// approval-req wrap replays as "new" and pre-gate: re-raised a card, fired an
// ungated notification, and — worst — a leave-area auto-resolver re-granted
// a FRESH leave window (escalation suppression re-armed from a stale ask).
// State (the card record, the Activity trail) stays ungated: it repopulates
// on legitimate catch-up; only the actions gate.
// ---------------------------------------------------------------------------

describe('handleIncomingSignal — approval-req action freshness gate', () => {
  const LEAVE_PARAMS = { [PARAMS_KIND_KEY]: 'leave-area', placeName: 'Home', durationMin: '30' }

  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(notify).mockClear()
  })
  afterEach(() => {
    registerApprovalAutoResolver(() => undefined) // detach the test resolver
  })

  function guardianSetup(): Circle {
    const circle = fakeCircle()
    signIn(PK_GUARDIAN, toHex(generateSecretKey()), false)
    store.save(fakePersisted({ circles: [circle] }))
    return circle
  }

  function leaveReq(id: string, at: number): { rumor: Rumor; req: ReturnType<typeof buildApprovalReq> } {
    const req = buildApprovalReq({ id, action: LEAVE_AREA_ENVELOPE_ACTION, params: LEAVE_PARAMS, from: PK_CHILD }, at)
    const rumor: Rumor = { id: `rumor-${id}-${at}`, pubkey: PK_CHILD, created_at: at, kind: 20_078, tags: [['t', 'approval-req']], content: JSON.stringify(req) }
    return { rumor, req }
  }

  it('a FRESH leave-area request reaches the auto-resolver and (with no verdict) notifies (positive control)', () => {
    const circle = guardianSetup()
    const resolver = vi.fn(() => undefined)
    registerApprovalAutoResolver(resolver)
    const { rumor } = leaveReq('fresh-1', Math.floor(Date.now() / 1000) - 10)
    handleIncomingSignal(circle, rumor, 'approval-req', fakeSender(rumor.pubkey, rumor.pubkey, false))
    expect(resolver).toHaveBeenCalledTimes(1)
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('a STALE replayed request still records the card but never reaches the auto-resolver or notifies', () => {
    const circle = guardianSetup()
    const resolver = vi.fn(() => undefined)
    registerApprovalAutoResolver(resolver)
    const { rumor } = leaveReq('stale-1', Math.floor(Date.now() / 1000) - 700)
    handleIncomingSignal(circle, rumor, 'approval-req', fakeSender(rumor.pubkey, rumor.pubkey, false))
    expect(store.load().approvals.some((r) => r.req.id === 'stale-1')).toBe(true) // state repopulates
    expect(resolver).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
  })

  it('a re-delivered request (same req id, new rumor id) does not re-invoke the auto-resolver', () => {
    const circle = guardianSetup()
    const resolver = vi.fn(() => undefined)
    registerApprovalAutoResolver(resolver)
    const at = Math.floor(Date.now() / 1000) - 10
    const first = leaveReq('dup-1', at)
    handleIncomingSignal(circle, first.rumor, 'approval-req', fakeSender(first.rumor.pubkey, first.rumor.pubkey, false))
    const replay: Rumor = { ...first.rumor, id: 'rumor-dup-1-rewrapped' }
    handleIncomingSignal(circle, replay, 'approval-req', fakeSender(replay.pubkey, replay.pubkey, false))
    expect(resolver).toHaveBeenCalledTimes(1)
  })
})

describe('handleIncomingSignal — approval-resp requester-notify freshness gate', () => {
  const LEAVE_PARAMS = { [PARAMS_KIND_KEY]: 'leave-area', placeName: 'Home', durationMin: '30' }

  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(notify).mockClear()
  })

  function requesterSetup(reqId: string): Circle {
    const circle = fakeCircle()
    const req = buildApprovalReq({ id: reqId, action: LEAVE_AREA_ENVELOPE_ACTION, params: LEAVE_PARAMS, from: PK_CHILD }, 100)
    signIn(PK_CHILD, 'c'.repeat(64), true)
    store.save(fakePersisted({ circles: [circle], approvals: [{ req, circleId: circle.id }] }))
    return circle
  }

  it('a FRESH grant notifies the requester (positive control)', () => {
    const circle = requesterSetup('resp-fresh')
    const at = Math.floor(Date.now() / 1000) - 10
    const resp = buildApprovalResp({ id: 'resp-fresh', ok: true, by: PK_GUARDIAN }, at)
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: at, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(resp) }
    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(rumor.pubkey, rumor.pubkey, true))
    expect(notify).toHaveBeenCalledTimes(1)
  })

  it('a STALE replayed grant still resolves the record but does not notify', () => {
    const circle = requesterSetup('resp-stale')
    const at = Math.floor(Date.now() / 1000) - 700
    const resp = buildApprovalResp({ id: 'resp-stale', ok: true, by: PK_GUARDIAN }, at)
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: at, kind: 20_078, tags: [['t', 'approval-resp']], content: JSON.stringify(resp) }
    handleIncomingSignal(circle, rumor, 'approval-resp', fakeSender(rumor.pubkey, rumor.pubkey, true))
    expect(store.load().approvals[0]?.resolved).toEqual({ ok: true, by: PK_GUARDIAN, at })
    expect(notify).not.toHaveBeenCalled()
  })
})
