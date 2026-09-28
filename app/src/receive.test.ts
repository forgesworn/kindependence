// Receive choke point, identity-signed structural envelope and re-key
// (Signet identity plan, Task 8). Every wrap here is a real roost `giftWrap`
// sealed by a real covey local signer; only the relay publish is mocked.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@forgesworn/roost-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgesworn/roost-kit')>()
  return { ...actual, publishSigned: vi.fn(async () => ({})) }
})

import { giftWrap, giftUnwrap, publishSigned } from '@forgesworn/roost-kit'
import type { Signer, SignedEvent } from '@forgesworn/roost-kit'
import { makeLocalSigner, deriveInbox, personalInboxTag, buildDmWrap, toHex } from '@forgesworn/covey-kit'
import type { Circle, DirectMessage, Role } from '@forgesworn/covey-kit'
import { generateSecretKey, getEventHash, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { getConversationKey, encrypt as nip44encrypt, decrypt as nip44decrypt } from 'nostr-tools/nip44'
import * as store from './store.js'
import { onCircleInboxWrap, setSignalHandler, resetReceiveForTests, refreshStatements, STATEMENT_REFRESH_MS, vouchParkSizeForTests, vouchParkRejudgesForTests, VOUCH_PARK_CAP, LINK_HOLD_CAP, linkHoldSizeForTests, applyParkedRevocations, type Sender } from './beacons.js'
import {
  onPhoneInboxWrap, sendRekey, registerStructuralSenders, resetRekeyForTests, REKEY_WINDOW_MS, removeMemberFromCircle,
  handleIncomingSignal as circlesHandleIncomingSignal, lastOwnRekeyIdForTests, resumePendingRemovals,
  registerMemberAddedHandler, setPersonalDmHandler, inviteToCircle,
  resendInvite, inviteMyOtherPhone, onPersonalInboxWrap, handleAction as circlesHandleAction,
  onMemberLeft, leaveCircle, trustViewFor, saveJoinedCircle, acceptVouch,
} from './circles.js'
import { sessionForTests, currentSession, identitySigner } from './session.js'
import type { SignerTransport } from './remote-signer.js'
import { deviceStatementTemplate, revocationTemplate, guardianOfTemplate, dependantOfTemplate, unlinkTemplate } from './device-statements.js'
import { acceptLinkPair, acceptUnlink, linked } from './guardian-links.js'
import { storeVouch, verifyVouch, setCreator, creatorOf, voucherOf, vouchFor, pendingVouchesFor, unvouchedSince, markUnvouched, UNVOUCHED_GRACE_SEC } from './vouches.js'
import { structuralTemplate, seedHash, verifyStructural, type StructuralAction } from './structural.js'
import { mayRemove, structuralAuthorised } from './authority.js'
import { acceptStatement, memberForPhone } from './phone-keys.js'
import * as queue from './structural-queue.js'
import { setContactsSource } from './contacts.js'
import { fakeContacts } from './test-support/fake-contacts.js'

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

interface Key { sk: string; pk: string }
function key(): Key {
  const sk = generateSecretKey()
  return { sk: toHex(sk), pk: getPublicKey(sk) }
}
/** A fresh key whose identity pubkey satisfies `pred` — used to pin down
 *  the lowest-identity-pubkey mutual-removal tie-break (R2) deterministically
 *  against the other fixture identities' (random) pubkeys. */
function keyWhere(pred: (pk: string) => boolean): Key {
  for (let i = 0; i < 100_000; i++) {
    const k = key()
    if (pred(k.pk)) return k
  }
  throw new Error('no key satisfying predicate')
}
const nowSec = (): number => Math.floor(Date.now() / 1000)
const hex = (c: string): string => c.repeat(64)

// Identities (in My Signet) and phone keys (on each device).
const A = key() // this device's identity, guardian
const B = key() // guardian
const C = key() // dependant
// D's identity pubkey is pinned above both A's and B's: the R2 mutual-removal
// tests below rely on D never winning a tie against either, so the outcome
// is deterministic (roster order alone would no longer decide it).
const D = keyWhere((pk) => pk > A.pk && pk > B.pk) // guardian
const E = key() // dependant
const X = key() // outsider
const A1 = key() // this phone
const A2 = key() // A's other phone
const B1 = key()
const C1 = key()
const D1 = key()
const E1 = key()
const X1 = key()

/** Phones per identity in c1, as `device()` binds them. */
const PHONES: Array<[Key, Key]> = [[A, A1], [A, A2], [B, B1], [C, C1], [D, D1], [E, E1]]

const OLD_SEED = hex('1')
const SEED = hex('2')

function circleOf(id: string, members: Array<[Key, Role]>, seedHex = SEED): Circle {
  return {
    id, name: `Circle ${id}`, seedHex, epoch: 1,
    members: members.map(([k, role]) => ({ pk: k.pk, role })),
    createdAt: 100, configUpdatedAt: 100, configBy: A.pk,
  }
}

async function statement(identity: Key, phone: Key): Promise<SignedEvent> {
  return makeLocalSigner(identity.sk).signEvent(deviceStatementTemplate(phone.pk, nowSec()))
}

async function circleWrap(phone: Key, circle: Circle, t: string, content: string): Promise<SignedEvent> {
  const inbox = deriveInbox(circle.seedHex)
  return giftWrap(makeLocalSigner(phone.sk), inbox.pk, { kind: 20_078, tags: [['t', t]], content }, inbox.pk)
}

async function struct(identity: Key, action: StructuralAction, circleId: string, prev: string, payload: string, at: number = nowSec()): Promise<SignedEvent> {
  return makeLocalSigner(identity.sk).signEvent(structuralTemplate({ action, circleId, prevSeedHash: prev, payload, nowSec: at }))
}

/** Final fix A3: a re-key's signed payload commits to its seed (`next`);
 *  the seed itself rides beside it in the phone-sealed rumor. Every seed a
 *  test's `rekeyPayload` commits to is remembered here, by commitment. */
const seedByNext = new Map<string, string>()

/** Wraps a signed re-key to `to`'s phone inbox with its seed (looked up by
 *  its `next` commitment unless `seed` is given — a test may tamper). */
async function phoneWrap(from: Key, to: Key, signed: SignedEvent, seed?: string): Promise<SignedEvent> {
  const s = seed ?? seedByNext.get((JSON.parse(signed.content) as { next: string }).next)
  return giftWrap(makeLocalSigner(from.sk), to.pk, { kind: 20_078, tags: [['t', 'struct']], content: JSON.stringify({ struct: signed, seed: s }) }, personalInboxTag(to.pk))
}

/** Builds a NIP-59 gift wrap sealed under `attackerSigner`'s OWN real key —
 *  a completely legitimate NIP-44 encrypt/decrypt (ECDH doesn't block a
 *  sender encrypting to a real recipient with their own real key) — but
 *  whose DECRYPTED inner rumor claims `forgedPubkey` as its author instead
 *  of the attacker's own. roost-kit's real `giftWrap` can never produce this
 *  (it always sets `rumor.pubkey = signer.pubkey`), so this replicates its
 *  wire format by hand for exactly the one forged field. Copied from
 *  circles.test.ts's own helper of the same name (Task 10 fix round 1,
 *  finding 1) — this file exercises the phone-inbox receive path, not the
 *  personal-inbox one, so it needs its own copy rather than a cross-file
 *  import. */
async function forgeSealedWrap(
  attackerSigner: Signer,
  recipientPk: string,
  forgedPubkey: string,
  inner: { kind: number; content: string; tags: string[][] },
): Promise<SignedEvent> {
  const at = nowSec()
  const rumor = { pubkey: forgedPubkey, created_at: at, kind: inner.kind, tags: inner.tags, content: inner.content }
  const rumorWithId = { ...rumor, id: getEventHash(rumor) }
  const sealContent = await attackerSigner.nip44Encrypt(recipientPk, JSON.stringify(rumorWithId))
  const seal = await attackerSigner.signEvent({ kind: 13, content: sealContent, tags: [], created_at: at })
  const ephSk = generateSecretKey()
  const wrapContent = nip44encrypt(JSON.stringify(seal), getConversationKey(ephSk, recipientPk))
  return finalizeEvent({ kind: 1059, content: wrapContent, tags: [['p', recipientPk]], created_at: at }, ephSk) as SignedEvent
}

/** Content of every event the identity signer was asked to sign. */
const signedContents: string[] = []

function localTransport(k: Key): SignerTransport {
  const s = makeLocalSigner(k.sk)
  return {
    pubkey: s.pubkey,
    signEvent: (t) => { signedContents.push(t.content); return s.signEvent(t) },
    nip44Encrypt: (peer, pt) => s.nip44Encrypt(peer, pt),
    nip44Decrypt: (peer, ct) => s.nip44Decrypt(peer, ct),
    close: async () => {},
  }
}

function circle(id: string): store.StoredCircle {
  const c = store.load().circles.find((x) => x.id === id)
  if (!c) throw new Error(`no circle ${id}`)
  return c
}

setSignalHandler(circlesHandleIncomingSignal)
const received: Array<{ circleId: string; t: string; pubkey: string; content: string; id?: string; sender?: Sender }> = []
setSignalHandler((c, rumor, t, sender) => {
  received.push({ circleId: c.id, t, pubkey: rumor.pubkey, content: rumor.content, id: rumor.id, sender })
})

/** A signed `invite` naming `pk` — the adder's vouch (vouches.ts). */
async function vouchEvent(by: Key, pk: string, role: Role, circleId = 'c1', at: number = nowSec()): Promise<SignedEvent> {
  return struct(by, 'invite', circleId, seedHash(SEED), JSON.stringify({ id: circleId, name: `Circle ${circleId}`, mode: 'family', pk, role }), at)
}

/** A signed guardian-of / dependant-of pair linking `g` and `d`. */
async function linkPair(g: Key, d: Key, at: number = nowSec() - 60): Promise<{ g: SignedEvent; d: SignedEvent }> {
  return {
    g: await makeLocalSigner(g.sk).signEvent(guardianOfTemplate(d.pk, at)),
    d: await makeLocalSigner(d.sk).signEvent(dependantOfTemplate(g.pk, at)),
  }
}

/** Plan 2, Task 5 fixture trust state, signed once: guardian links A–C,
 *  A–E, B–C, D–C, D–E; A (the creator) vouched for everyone else in c1
 *  and for B in c2. */
let fixtureTrust: { links: Array<{ g: SignedEvent; d: SignedEvent }>; vouches: SignedEvent[] } | null = null
const ADDED_AT = Math.floor(Date.now() / 1000) - 86_400
async function trustFixture(): Promise<NonNullable<typeof fixtureTrust>> {
  fixtureTrust ??= {
    links: [await linkPair(A, C), await linkPair(A, E), await linkPair(B, C), await linkPair(D, C), await linkPair(D, E)],
    // Dated a day back: members were added well before anything a test
    // does (final fix N1: a hand-over counts only after the original vouch).
    vouches: [
      await vouchEvent(A, B.pk, 'guardian', 'c1', ADDED_AT), await vouchEvent(A, C.pk, 'child', 'c1', ADDED_AT), await vouchEvent(A, D.pk, 'guardian', 'c1', ADDED_AT),
      await vouchEvent(A, E.pk, 'child', 'c1', ADDED_AT), await vouchEvent(A, B.pk, 'guardian', 'c2', ADDED_AT),
    ],
  }
  return fixtureTrust
}

/** Accepts the fixture's guardian links into the current store (what Task
 *  6's invite bundle will carry). */
async function acceptFixtureLinks(): Promise<void> {
  for (const l of (await trustFixture()).links) expect(acceptLinkPair(l.g, l.d)).toBe(true)
}

/** Sets up one simulated device: its own store, and a session for
 *  `self`/`phone`. Circle c1 = A, B, D guardians + C, E dependants; c2 = A, B.
 *  Plan 2 trust state: see `trustFixture`. */
async function device(self: Key, phone: Key): Promise<void> {
  vi.stubGlobal('localStorage', fakeLocalStorage())
  resetReceiveForTests()
  resetRekeyForTests()
  queue.resetForTests()
  const c1 = circleOf('c1', [[A, 'guardian'], [B, 'guardian'], [C, 'child'], [D, 'guardian'], [E, 'child']])
  const c2 = circleOf('c2', [[A, 'guardian'], [B, 'guardian']], hex('3'))
  store.save({ ...store.load(), circles: [c1, c2], seedHashes: { c1: [seedHash(OLD_SEED), seedHash(SEED)], c2: [seedHash(hex('3'))] } })
  const now = nowSec()
  for (const [id, phoneK] of PHONES) {
    expect(acceptStatement(c1, await statement(id, phoneK), phoneK.pk, now)).toBe('added')
  }
  for (const [id, phoneK] of [[A, A1], [A, A2], [B, B1]] as const) {
    expect(acceptStatement(c2, await statement(id, phoneK), phoneK.pk, now)).toBe('added')
  }
  await acceptFixtureLinks()
  for (const ev of (await trustFixture()).vouches) expect(storeVouch(verifyVouch(ev)!)).toBe(true)
  setCreator('c1', A.pk)
  setCreator('c2', A.pk)
  sessionForTests({ identityPk: self.pk, phoneSkHex: phone.sk, statement: await statement(self, phone), transport: localTransport(self) })
  registerStructuralSenders()
  received.length = 0
  signedContents.length = 0
  vi.mocked(publishSigned).mockClear()
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await device(A, A1)
})

afterEach(() => {
  setContactsSource(null)
  queue.resetForTests()
  sessionForTests(null)
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

/** Plan 2, Task 6: this device's contacts grant reports `pks` as kin. */
function knowContacts(...pks: string[]): void {
  setContactsSource(fakeContacts({ status: 'connected', contacts: pks.map((pk, i) => ({ contactId: `k${i}`, pks: [pk], name: `Contact ${i}`, tier: 'kin' as const, blocked: false })) }))
}

async function deliver(wrap: SignedEvent, circleId = 'c1'): Promise<void> {
  await onCircleInboxWrap(circleId, deriveInbox(circle(circleId).seedHex).sk, wrap)
}

/** A re-key payload; `to` defaults to every phone of the members who stay. */
function rekeyPayload(seed: string, prev: string, removals: string[] = [], to?: string[]): string {
  const dest = to ?? PHONES.filter(([id]) => !removals.includes(id.pk)).map(([, ph]) => ph.pk)
  const next = seedHash(seed)
  seedByNext.set(next, seed)
  return JSON.stringify({ id: 'c1', next, prev, removals: [...removals].sort(), to: [...dest].sort() })
}

/** A signed rekey from `by` whose id satisfies `accept`: fresh seeds are
 *  tried by hashing the unsigned template (cheap), and only the match is
 *  signed — so even a very low target id is found without flaking. */
async function rekeyWhere(by: Key, prev: string, accept: (id: string) => boolean, removals: string[] = [], created: number = nowSec()): Promise<SignedEvent> {
  for (let i = 0; i < 2_000_000; i++) {
    const t = structuralTemplate({ action: 'rekey', circleId: 'c1', prevSeedHash: prev, payload: rekeyPayload(toHex(crypto.getRandomValues(new Uint8Array(32))), prev, removals), nowSec: created })
    if (!accept(getEventHash({ ...t, pubkey: by.pk }))) continue
    const ev = await makeLocalSigner(by.sk).signEvent(t)
    expect(accept(ev.id)).toBe(true)
    return ev
  }
  throw new Error('no rekey with the wanted id order')
}

describe('receive choke point — sender resolution', () => {
  it('resolves a known phone key to its member and dispatches with the sender', async () => {
    await deliver(await circleWrap(B1, circle('c1'), 'x-test', 'hi'))
    expect(received).toHaveLength(1)
    expect(received[0]?.sender).toEqual({ signerPk: B1.pk, memberPk: B.pk, structural: false })
  })

  it('drops traffic from an unknown phone key', async () => {
    await deliver(await circleWrap(X1, circle('c1'), 'x-test', 'hi'))
    expect(received).toHaveLength(0)
  })

  it('drops traffic from a revoked phone key', async () => {
    const rv = await makeLocalSigner(B.sk).signEvent(revocationTemplate(B1.pk, nowSec()))
    await deliver(await circleWrap(D1, circle('c1'), 'revoke', JSON.stringify(rv)))
    expect(memberForPhone('c1', B1.pk)).toBeNull()
    await deliver(await circleWrap(B1, circle('c1'), 'x-test', 'after revoke'))
    expect(received).toHaveLength(0)
  })

  it('drops a phone key sending a structural t directly', async () => {
    for (const t of ['approval-resp', 'family-policy', 'config', 'rekey', 'places']) {
      await deliver(await circleWrap(B1, circle('c1'), t, '{}'))
    }
    expect(received).toHaveLength(0)
  })

  it('accepts a device statement posted by the phone it names, then resolves that phone', async () => {
    const B2 = key()
    await deliver(await circleWrap(B2, circle('c1'), 'device', JSON.stringify(await statement(B, B2))))
    expect(memberForPhone('c1', B2.pk)).toBe(B.pk)
    await deliver(await circleWrap(B2, circle('c1'), 'x-test', 'from B2'))
    expect(received.map((r) => r.sender?.memberPk)).toEqual([B.pk])
  })

  it('own echo: a message from this identity\'s other phone is applied, one from this phone is skipped', async () => {
    await deliver(await circleWrap(A1, circle('c1'), 'x-test', 'from this phone'))
    expect(received).toHaveLength(0)
    await deliver(await circleWrap(A2, circle('c1'), 'x-test', 'from my other phone'))
    expect(received).toHaveLength(1)
    expect(received[0]?.sender).toEqual({ signerPk: A2.pk, memberPk: A.pk, structural: false })
  })
})

describe('receive choke point — identity-signed structural envelope', () => {
  const H = seedHash(SEED)

  it('dispatches an authorised structural event as the inner event, t = action', async () => {
    const inner = await struct(B, 'approval-resp', 'c1', H, '{"ok":true}')
    await deliver(await circleWrap(B1, circle('c1'), 'struct', JSON.stringify(inner)))
    expect(received).toHaveLength(1)
    expect(received[0]).toMatchObject({ t: 'approval-resp', pubkey: B.pk, content: '{"ok":true}', id: inner.id })
    expect(received[0]?.sender).toEqual({ signerPk: B1.pk, memberPk: B.pk, structural: true })
  })

  it('drops an inner event signed by a non-member, even sealed by a member phone', async () => {
    const inner = await struct(X, 'places', 'c1', H, '[]')
    await deliver(await circleWrap(B1, circle('c1'), 'struct', JSON.stringify(inner)))
    expect(received).toHaveLength(0)
  })

  it('drops a structural event sealed by an unknown phone key', async () => {
    const inner = await struct(B, 'places', 'c1', H, '[]')
    await deliver(await circleWrap(X1, circle('c1'), 'struct', JSON.stringify(inner)))
    expect(received).toHaveLength(0)
  })

  it('drops a dependant forging guardian approvals or policy', async () => {
    for (const action of ['approval-resp', 'family-policy', 'agreement', 'extend-resp', 'places'] as const) {
      const inner = await struct(C, action, 'c1', H, '{}')
      await deliver(await circleWrap(C1, circle('c1'), 'struct', JSON.stringify(inner)))
    }
    expect(received).toHaveLength(0)
  })

  it('drops a config that raises the signer\'s own role (config role escalation)', async () => {
    const c = circle('c1')
    const members = c.members.map((m) => (m.pk === C.pk ? { ...m, role: 'guardian' as Role } : m))
    const cfg = { v: 2, createdBy: A.pk, vouches: [] as SignedEvent[], id: 'c1', name: c.name, updatedAt: 999_999, by: C.pk, members }
    await deliver(await circleWrap(C1, c, 'struct', JSON.stringify(await struct(C, 'config', 'c1', H, JSON.stringify(cfg)))))
    expect(received).toHaveLength(0)
  })

  it('drops a dependant config that changes another member\'s role or removes a guardian', async () => {
    const c = circle('c1')
    const demoted = c.members.map((m) => (m.pk === B.pk ? { ...m, role: 'child' as Role } : m))
    const removed = c.members.filter((m) => m.pk !== B.pk)
    for (const members of [demoted, removed]) {
      const cfg = { v: 2, createdBy: A.pk, vouches: [] as SignedEvent[], id: 'c1', name: c.name, updatedAt: 999_999, by: C.pk, members }
      await deliver(await circleWrap(C1, c, 'struct', JSON.stringify(await struct(C, 'config', 'c1', H, JSON.stringify(cfg)))))
    }
    expect(received).toHaveLength(0)
  })

  // Plan 2, Task 5: renaming now needs a guardian, so the positive control
  // is a dependant's leave (a config removing only itself).
  it('accepts a dependant config that changes no roles and only removes itself (positive control)', async () => {
    const c = circle('c1')
    const cfg = { v: 2, createdBy: A.pk, vouches: [] as SignedEvent[], id: 'c1', name: c.name, updatedAt: 999_999, by: C.pk, members: c.members.filter((m) => m.pk !== C.pk) }
    await deliver(await circleWrap(C1, c, 'struct', JSON.stringify(await struct(C, 'config', 'c1', H, JSON.stringify(cfg)))))
    expect(received.map((r) => r.t)).toEqual(['config'])
  })

  // Review fix round 1: the removed `t:'joined'` announce is replaced by
  // `registerMemberAddedHandler`, fired from `applyConfig` once per
  // genuinely NEW member — only after the config's own authority (guardian
  // role, no self-escalation) has already been verified above this.
  it('fires registerMemberAddedHandler once for a genuinely new member added by an authorised config, and not for an already-known one', async () => {
    const F = key()
    const c = circle('c1')
    const added: Array<{ circleId: string; memberPk: string }> = []
    registerMemberAddedHandler((circ, pk) => { added.push({ circleId: circ.id, memberPk: pk }) })
    const withF = { v: 2, createdBy: A.pk, vouches: [await vouchEvent(D, F.pk, 'guardian')], id: 'c1', name: c.name, updatedAt: 999_999, by: D.pk, members: [...c.members, { pk: F.pk, role: 'guardian' as Role }] }
    await deliver(await circleWrap(D1, c, 'struct', JSON.stringify(await struct(D, 'config', 'c1', H, JSON.stringify(withF)))))
    expect(added).toEqual([{ circleId: 'c1', memberPk: F.pk }])

    // A later config with the SAME roster (no new member) never fires again.
    const c2 = circle('c1')
    const sameRoster = { v: 2, createdBy: A.pk, vouches: [] as SignedEvent[], id: 'c1', name: 'Renamed again', updatedAt: 1_000_000, by: D.pk, members: c2.members }
    await deliver(await circleWrap(D1, c2, 'struct', JSON.stringify(await struct(D, 'config', 'c1', seedHash(SEED), JSON.stringify(sameRoster)))))
    expect(added).toEqual([{ circleId: 'c1', memberPk: F.pk }])
  })

  it('drops a config whose `by` names someone other than its signer', async () => {
    const c = circle('c1')
    const cfg = { v: 2, createdBy: A.pk, vouches: [] as SignedEvent[], id: 'c1', name: 'Renamed', updatedAt: 999_999, by: D.pk, members: c.members }
    await deliver(await circleWrap(B1, c, 'struct', JSON.stringify(await struct(B, 'config', 'c1', H, JSON.stringify(cfg)))))
    expect(received).toHaveLength(0)
  })

  it('drops a structural event for circle A replayed into circle B', async () => {
    const inner = await struct(B, 'places', 'c1', H, '[]')
    await deliver(await circleWrap(B1, circle('c2'), 'struct', JSON.stringify(inner)), 'c2')
    expect(received).toHaveLength(0)
  })

  it('accepts a non-re-key event whose prev is an older known seed hash', async () => {
    const inner = await struct(B, 'places', 'c1', seedHash(OLD_SEED), '[]')
    await deliver(await circleWrap(B1, circle('c1'), 'struct', JSON.stringify(inner)))
    expect(received.map((r) => r.t)).toEqual(['places'])
  })

  it('drops a structural event whose prev was never this circle\'s seed hash', async () => {
    const inner = await struct(B, 'places', 'c1', seedHash(hex('9')), '[]')
    await deliver(await circleWrap(B1, circle('c1'), 'struct', JSON.stringify(inner)))
    expect(received).toHaveLength(0)
  })

  it('delivers a resent identical structural event once (dedup by inner id)', async () => {
    const inner = await struct(B, 'places', 'c1', H, '[]')
    await deliver(await circleWrap(B1, circle('c1'), 'struct', JSON.stringify(inner)))
    await deliver(await circleWrap(B1, circle('c1'), 'struct', JSON.stringify(inner))) // new wrap, new rumor id, same inner event
    expect(received).toHaveLength(1)
  })

  it('never accepts a re-key on the circle inbox (it would hand the new seed to removed members)', async () => {
    const inner = await struct(B, 'rekey', 'c1', H, rekeyPayload(hex('4'), H))
    await deliver(await circleWrap(B1, circle('c1'), 'struct', JSON.stringify(inner)))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(received).toHaveLength(0)
    expect(circle('c1').seedHex).toBe(SEED)
  })
})

describe('re-key to phone keys', () => {
  const H = seedHash(SEED)

  it('applies an authorised re-key after the collection window', async () => {
    const newSeed = hex('4')
    const ev = await struct(B, 'rekey', 'c1', H, rekeyPayload(newSeed, H))
    await onPhoneInboxWrap(await phoneWrap(B1, A1, ev))
    expect(circle('c1').seedHex).toBe(SEED) // still collecting
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(newSeed)
    expect(store.load().seedHashes.c1?.at(-1)).toBe(seedHash(newSeed))
  })

  it('re-posts this device\'s statement on the new inbox after a re-key', async () => {
    const newSeed = hex('4')
    await onPhoneInboxWrap(await phoneWrap(B1, A1, await struct(B, 'rekey', 'c1', H, rekeyPayload(newSeed, H))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    const newInbox = deriveInbox(newSeed).pk
    const tags = vi.mocked(publishSigned).mock.calls.map((c) => (c[1] as unknown as SignedEvent).tags.find((t) => t[0] === 'p')?.[1])
    expect(tags).toContain(newInbox)
  })

  // Plan 2, Task 5: any member may re-key; the removals it carries are
  // what is judged. A dependant may not re-key a guardian out.
  it('drops a dependant\'s re-key that removes a guardian', async () => {
    await onPhoneInboxWrap(await phoneWrap(C1, A1, await struct(C, 'rekey', 'c1', H, rekeyPayload(hex('4'), H, [B.pk]))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(SEED)
  })

  it('drops a re-key with a stale prev (an older known seed hash is not enough)', async () => {
    const stale = seedHash(OLD_SEED)
    await onPhoneInboxWrap(await phoneWrap(B1, A1, await struct(B, 'rekey', 'c1', stale, rekeyPayload(hex('4'), stale))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(SEED)
  })

  it('drops a re-key whose payload prev disagrees with its signed prev tag', async () => {
    await onPhoneInboxWrap(await phoneWrap(B1, A1, await struct(B, 'rekey', 'c1', H, rekeyPayload(hex('4'), seedHash(OLD_SEED)))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(SEED)
  })

  it('concurrent re-keys converge on the lowest inner event id on two simulated devices', async () => {
    const r1 = await struct(B, 'rekey', 'c1', H, rekeyPayload(hex('4'), H))
    const r2 = await struct(D, 'rekey', 'c1', H, rekeyPayload(hex('5'), H))
    const winnerSeed = r1.id < r2.id ? hex('4') : hex('5')

    // Device 1 (A on A1) sees r1 first.
    await onPhoneInboxWrap(await phoneWrap(B1, A1, r1))
    await onPhoneInboxWrap(await phoneWrap(D1, A1, r2))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(winnerSeed)

    // Device 2 (C on C1) sees r2 first.
    await device(C, C1)
    await onPhoneInboxWrap(await phoneWrap(D1, C1, r2))
    await onPhoneInboxWrap(await phoneWrap(B1, C1, r1))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(winnerSeed)
  })

  it('removed members stay removed after a later re-key, with their phone keys dropped', async () => {
    const s1 = hex('4')
    await onPhoneInboxWrap(await phoneWrap(B1, A1, await struct(B, 'rekey', 'c1', H, rekeyPayload(s1, H, [C.pk]))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(C.pk)
    expect(memberForPhone('c1', C1.pk)).toBeNull()

    const H1 = seedHash(s1)
    const s2 = hex('5')
    await onPhoneInboxWrap(await phoneWrap(D1, A1, await struct(D, 'rekey', 'c1', H1, rekeyPayload(s2, H1, []))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(s2)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(C.pk)
    expect(circle('c1').removedPks).toContain(C.pk)
  })

  it('a config written before a removal cannot re-admit the removed member', async () => {
    // Task 10 fix round 1, finding 2 (controller ruling): receiver-side
    // re-admission needs the config's own signed created_at strictly AFTER
    // the recorded removal's — not merely a `prev` that chains to a
    // later-looking epoch. `t0` pins the rekey's created_at (and so the
    // removal's `.at`) so the stale config below can be dated unambiguously
    // before it, independent of wall-clock timing.
    const s1 = hex('4')
    const t0 = nowSec()
    await onPhoneInboxWrap(await phoneWrap(B1, A1, await struct(B, 'rekey', 'c1', H, rekeyPayload(s1, H, [C.pk]), t0)))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    // D's device had not seen the re-key yet: its config still lists C, is
    // chained to the old seed (a known hash, so the envelope accepts it),
    // and — the part that actually matters now — is dated BEFORE the
    // removal it would re-admit against.
    const stale = { v: 2, createdBy: A.pk, vouches: [await vouchEvent(D, C.pk, 'child', 'c1', t0 + 5)] /* final review A, I1: a fresh invite */, id: 'c1', name: 'Circle c1', updatedAt: 999_999, by: D.pk, members: circleOf('c1', [[A, 'guardian'], [B, 'guardian'], [C, 'child'], [D, 'guardian'], [E, 'child']]).members }
    const ev = await struct(D, 'config', 'c1', H, JSON.stringify(stale), t0 - 10)
    await deliver(await circleWrap(D1, circle('c1'), 'struct', JSON.stringify(ev)))
    expect(received.map((r) => r.t)).toEqual(['config']) // authorised and dispatched…
    expect(circle('c1').configUpdatedAt).toBe(999_999) // …and merged…
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(C.pk)
  })

  it('a config dated after the removal re-admits the member (deliberate re-invite)', async () => {
    // Task 10 fix round 1, finding 2: the created_at counterpart to the
    // test above — same removal, same `prev`, but dated AFTER it.
    const s1 = hex('4')
    const t0 = nowSec()
    await onPhoneInboxWrap(await phoneWrap(B1, A1, await struct(B, 'rekey', 'c1', H, rekeyPayload(s1, H, [C.pk]), t0)))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    const members = [...circle('c1').members, { pk: C.pk, role: 'child' as Role }]
    const cfg = { v: 2, createdBy: A.pk, vouches: [await vouchEvent(D, C.pk, 'child', 'c1', t0 + 5)] /* final review A, I1: a fresh invite */, id: 'c1', name: 'Circle c1', updatedAt: 999_999, by: D.pk, members }
    const ev = await struct(D, 'config', 'c1', seedHash(s1), JSON.stringify(cfg), t0 + 10)
    await deliver(await circleWrap(D1, circle('c1'), 'struct', JSON.stringify(ev)))
    expect(circle('c1').members.map((m) => m.pk)).toContain(C.pk)
    expect(circle('c1').removedPks ?? []).not.toContain(C.pk)
  })

  it('a config dated after the removal but still chained to the OLD seed cannot re-admit the member (Task 10 fix round 2, finding 1)', async () => {
    // created_at alone is forgeable/spoofable by a writer who doesn't
    // actually know about the removal (they just signed something dated
    // later) — re-admission needs BOTH created_at after the removal AND a
    // `prev` chained on or after the removal re-key's own seed. Same
    // removal, same OLD `prev` as the "written before" test above, but now
    // dated AFTER it — created_at alone would (wrongly) re-admit.
    const s1 = hex('4')
    const t0 = nowSec()
    await onPhoneInboxWrap(await phoneWrap(B1, A1, await struct(B, 'rekey', 'c1', H, rekeyPayload(s1, H, [C.pk]), t0)))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    const stale = { v: 2, createdBy: A.pk, vouches: [await vouchEvent(D, C.pk, 'child', 'c1', t0 + 5)] /* final review A, I1: a fresh invite */, id: 'c1', name: 'Circle c1', updatedAt: 999_999, by: D.pk, members: circleOf('c1', [[A, 'guardian'], [B, 'guardian'], [C, 'child'], [D, 'guardian'], [E, 'child']]).members }
    const ev = await struct(D, 'config', 'c1', H, JSON.stringify(stale), t0 + 10)
    await deliver(await circleWrap(D1, circle('c1'), 'struct', JSON.stringify(ev)))
    expect(received.map((r) => r.t)).toEqual(['config']) // authorised and dispatched…
    expect(circle('c1').configUpdatedAt).toBe(999_999) // …and merged…
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(C.pk)
  })

  it('a bare placeholder drops a first config from a non-member, even one whose buffered statement binds the sealing phone (final fix round 2, R1b)', async () => {
    const joined: Circle = { ...circleOf('c3', [[A, 'guardian']], hex('6')), configBy: '', configUpdatedAt: 0 }
    store.update((p) => { p.circles = [...p.circles, joined] })
    expect(acceptStatement(joined, await statement(B, B1), B1.pk, nowSec())).toBe('buffered')
    const cfg = { v: 2, createdBy: A.pk, vouches: [] as SignedEvent[], id: 'c3', name: 'Joined', updatedAt: 500, by: B.pk, members: [{ pk: A.pk, role: 'guardian' }, { pk: B.pk, role: 'guardian' }] }
    const ev = await struct(B, 'config', 'c3', seedHash(hex('6')), JSON.stringify(cfg))
    await deliver(await circleWrap(B1, joined, 'struct', JSON.stringify(ev)), 'c3')
    expect(circle('c3').members.map((m) => m.pk)).toEqual([A.pk])
    expect(circle('c3').configBy).toBe('')
    expect(memberForPhone('c3', B1.pk)).toBeNull()
  })

  it('a bare placeholder drops a first config whose sealing phone no buffered statement binds', async () => {
    const joined: Circle = { ...circleOf('c3', [[A, 'guardian']], hex('6')), configBy: '', configUpdatedAt: 0 }
    store.update((p) => { p.circles = [...p.circles, joined] })
    const cfg = { v: 2, createdBy: A.pk, vouches: [] as SignedEvent[], id: 'c3', name: 'Joined', updatedAt: 500, by: X.pk, members: [{ pk: A.pk, role: 'guardian' }, { pk: X.pk, role: 'guardian' }] }
    const ev = await struct(X, 'config', 'c3', seedHash(hex('6')), JSON.stringify(cfg))
    await deliver(await circleWrap(X1, joined, 'struct', JSON.stringify(ev)), 'c3')
    expect(circle('c3').members.map((m) => m.pk)).toEqual([A.pk])
  })

  it('sendRekey wraps the new seed to every remaining member\'s phone keys, never a removed member\'s', async () => {
    void sendRekey(circle('c1'), [C.pk])
    await queue.drain()
    const tags = vi.mocked(publishSigned).mock.calls.map((c) => (c[1] as unknown as SignedEvent).tags.find((t) => t[0] === 'p')?.[1])
    for (const phone of [A2, B1, D1, E1]) expect(tags).toContain(personalInboxTag(phone.pk))
    expect(tags).not.toContain(personalInboxTag(C1.pk))
    expect(tags).toContain(personalInboxTag(A1.pk)) // this phone too: a restart inside the window still receives it
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).not.toBe(SEED)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(C.pk)
  })

  it('sendRekey carries the cumulative, sorted removal set (tombstones plus the new removals)', async () => {
    const earlier = key().pk
    store.update((p) => { p.circles = p.circles.map((c) => (c.id === 'c1' ? { ...c, removedPks: [earlier] } : c)) })
    void sendRekey(circle('c1'), [C.pk])
    const item = queue.pending().find((q) => q.action === 'rekey')
    expect(JSON.parse(item!.payload)).toMatchObject({ id: 'c1', prev: H, removals: [earlier, C.pk].sort() })
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').removedPks).toEqual([earlier, C.pk].sort())
  })

  it('removeMemberFromCircle re-keys without the member', async () => {
    await removeMemberFromCircle('c1', C.pk)
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(C.pk)
    expect(circle('c1').seedHex).not.toBe(SEED)
  })

  it('a device whose own re-key lost re-enqueues its removals on top of the winner', async () => {
    void sendRekey(circle('c1'), [C.pk])
    await queue.drain()
    const own = vi.mocked(publishSigned).mock.calls
      .map((c) => c[1] as unknown as SignedEvent)
      .find((w) => w.tags.some((t) => t[0] === 'p' && t[1] === personalInboxTag(B1.pk)))
    expect(own).toBeDefined()
    const ownId = lastOwnRekeyIdForTests('c1')!
    const theirs = await rekeyWhere(B, H, (id) => id < ownId)
    await onPhoneInboxWrap(await phoneWrap(B1, A1, theirs))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    const winnerSeed = seedOf(theirs)
    expect(circle('c1').seedHex).toBe(winnerSeed)
    expect(circle('c1').members.map((m) => m.pk)).toContain(C.pk) // the winner didn't remove C

    await queue.drain() // our removal, re-enqueued on top of the winner
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(C.pk)
    expect(store.load().seedHashes.c1).toContain(seedHash(winnerSeed))
  })

  it('a revocation for a phone in a circle where this device is guardian re-keys without that phone', async () => {
    const rv = await makeLocalSigner(B.sk).signEvent(revocationTemplate(B1.pk, nowSec()))
    await deliver(await circleWrap(D1, circle('c1'), 'revoke', JSON.stringify(rv)))
    await queue.drain()
    const tags = vi.mocked(publishSigned).mock.calls.map((c) => (c[1] as unknown as SignedEvent).tags.find((t) => t[0] === 'p')?.[1])
    expect(tags).toContain(personalInboxTag(D1.pk))
    expect(tags).not.toContain(personalInboxTag(B1.pk))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).not.toBe(SEED)
    // A replay of the same revocation does not re-key again.
    vi.mocked(publishSigned).mockClear()
    await deliver(await circleWrap(D1, circle('c1'), 'revoke', JSON.stringify(rv)))
    await queue.drain()
    expect(vi.mocked(publishSigned)).not.toHaveBeenCalled()
  })
})

/** Every wrap published so far, with its routing `p` tag. */
function published(): Array<{ wrap: SignedEvent; to: string | undefined }> {
  return vi.mocked(publishSigned).mock.calls.map((c) => {
    const wrap = c[1] as unknown as SignedEvent
    return { wrap, to: wrap.tags.find((t) => t[0] === 'p')?.[1] }
  })
}

function seedOf(ev: SignedEvent): string {
  return seedByNext.get((JSON.parse(ev.content) as { next: string }).next)!
}

describe('review fix round 1', () => {
  const H = seedHash(SEED)

  it('A: a member missing from `to` gets the new seed forwarded by a device that knows its phone', async () => {
    // D's device lacked C's statement: its re-key's `to` misses C1.
    const to = [A1, A2, B1, D1, E1].map((k) => k.pk)
    const rd = await struct(D, 'rekey', 'c1', H, rekeyPayload(hex('4'), H, [], to))
    await onPhoneInboxWrap(await phoneWrap(D1, A1, rd))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(hex('4'))
    const forwards = published().filter((w) => w.to === personalInboxTag(C1.pk))
    expect(forwards).toHaveLength(1) // once per phone
    expect(store.load().seedRecipients.c1).toContain(C1.pk)

    // C's device receives it only through that forward.
    await device(C, C1)
    await onPhoneInboxWrap(forwards[0]!.wrap)
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(hex('4'))
  })

  it('B: a revoked phone never keeps the live seed, even when a concurrent re-key that still lists it wins', async () => {
    const rv = await makeLocalSigner(B.sk).signEvent(revocationTemplate(B1.pk, nowSec()))
    const rvWrap = await circleWrap(D1, circle('c1'), 'revoke', JSON.stringify(rv))
    await deliver(rvWrap)
    await queue.drain() // our revocation re-key R_A goes out
    const ownId = lastOwnRekeyIdForTests('c1')!
    // D's concurrent removal re-key, sent before D learned of the revocation.
    const rd = await rekeyWhere(D, H, (id) => id < ownId, [C.pk])
    expect(JSON.parse(rd.content).to).toContain(B1.pk)
    await onPhoneInboxWrap(await phoneWrap(D1, A1, rd))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(seedOf(rd)) // R_D won…
    await queue.drain() // …and its `to` held a revoked phone: a follow-up re-key
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    const P = circle('c1').seedHex
    expect(P).not.toBe(seedOf(rd))
    expect(store.load().seedRecipients.c1).not.toContain(B1.pk)
    const wraps = published()
    expect(wraps.some((w) => w.to === personalInboxTag(B1.pk))).toBe(false) // this device never wrapped any seed to B1

    // Another remaining phone (E's) converges on P.
    const toE = wraps.filter((w) => w.to === personalInboxTag(E1.pk)).map((w) => w.wrap)
    await device(E, E1)
    await deliver(await circleWrap(D1, circle('c1'), 'revoke', JSON.stringify(rv)))
    await onPhoneInboxWrap(await phoneWrap(D1, E1, rd))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    for (const w of toE) await onPhoneInboxWrap(w)
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(P)
  })

  it('B: after a re-key, only phones holding the new seed trigger a re-key when revoked', async () => {
    const s1 = hex('4')
    await onPhoneInboxWrap(await phoneWrap(D1, A1, await struct(D, 'rekey', 'c1', H, rekeyPayload(s1, H, [C.pk]))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    await queue.drain()
    vi.mocked(publishSigned).mockClear()
    // C1 (removed member's phone) only ever held the old seed: no re-key.
    const rvC = await makeLocalSigner(C.sk).signEvent(revocationTemplate(C1.pk, nowSec()))
    await deliver(await circleWrap(D1, circle('c1'), 'revoke', JSON.stringify(rvC)))
    await queue.drain()
    expect(queue.pending()).toHaveLength(0)
    expect(published()).toHaveLength(0)
    // B2 posted its statement on the new inbox — it holds the new seed.
    const B2 = key()
    await deliver(await circleWrap(B2, circle('c1'), 'device', JSON.stringify(await statement(B, B2))))
    expect(store.load().seedRecipients.c1).toContain(B2.pk)
    const rvB2 = await makeLocalSigner(B.sk).signEvent(revocationTemplate(B2.pk, nowSec()))
    await deliver(await circleWrap(D1, circle('c1'), 'revoke', JSON.stringify(rvB2)))
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).not.toBe(s1)
    expect(published().some((w) => w.to === personalInboxTag(B2.pk))).toBe(false)
  })

  it('C: a lower-id re-key arriving after the window replaces the applied one; both devices end on the same seed', async () => {
    const r1 = await struct(B, 'rekey', 'c1', H, rekeyPayload(hex('4'), H))
    const r2 = await rekeyWhere(D, H, (id) => id < r1.id)
    // Device 1 gets r1, closes its window, then r2 arrives late.
    await onPhoneInboxWrap(await phoneWrap(B1, A1, r1))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(hex('4'))
    await onPhoneInboxWrap(await phoneWrap(D1, A1, r2))
    expect(circle('c1').seedHex).toBe(seedOf(r2))
    expect(store.load().seedHashes.c1?.at(-1)).toBe(seedHash(seedOf(r2)))
    expect(store.load().lastRekey.c1?.id).toBe(r2.id)
    // Device 2 gets them the other way round: the late higher id is ignored.
    await device(C, C1)
    await onPhoneInboxWrap(await phoneWrap(D1, C1, r2))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    await onPhoneInboxWrap(await phoneWrap(B1, C1, r1))
    expect(circle('c1').seedHex).toBe(seedOf(r2))
  })

  it('C: a late winner that lacks our own applied removal re-enqueues it', async () => {
    void sendRekey(circle('c1'), [C.pk])
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(C.pk)
    const ownId = lastOwnRekeyIdForTests('c1')!
    const late = await rekeyWhere(B, H, (id) => id < ownId)
    await onPhoneInboxWrap(await phoneWrap(B1, A1, late))
    expect(circle('c1').seedHex).toBe(seedOf(late))
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    const last = store.load().lastRekey.c1!
    expect(last.prev).toBe(seedHash(seedOf(late)))
    expect(last.removals).toContain(C.pk)
  })

  it('D(a): a structural event sealed by a phone not yet bound is parked, then handled once its statement arrives', async () => {
    const B2 = key()
    const inner = await struct(B, 'places', 'c1', H, '[]')
    const wrap = await circleWrap(B2, circle('c1'), 'struct', JSON.stringify(inner))
    await deliver(wrap)
    await deliver(wrap) // a relay re-delivery while parked
    expect(received).toHaveLength(0)
    await deliver(await circleWrap(B2, circle('c1'), 'device', JSON.stringify(await statement(B, B2))))
    expect(received.map((r) => r.t)).toEqual(['places'])
    expect(received[0]?.sender).toEqual({ signerPk: B2.pk, memberPk: B.pk, structural: true })
  })

  it('D(a): statement first, then the structural event (the other order) is handled directly', async () => {
    const B2 = key()
    await deliver(await circleWrap(B2, circle('c1'), 'device', JSON.stringify(await statement(B, B2))))
    await deliver(await circleWrap(B2, circle('c1'), 'struct', JSON.stringify(await struct(B, 'places', 'c1', H, '[]'))))
    expect(received.map((r) => r.t)).toEqual(['places'])
  })

  it('D(b): a re-key built on a re-key not yet seen is parked and applied after it', async () => {
    const s1 = hex('4')
    const s2 = hex('5')
    const r1 = await struct(B, 'rekey', 'c1', H, rekeyPayload(s1, H))
    const r2 = await struct(D, 'rekey', 'c1', seedHash(s1), rekeyPayload(s2, seedHash(s1)))
    await onPhoneInboxWrap(await phoneWrap(D1, A1, r2)) // out of order
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(SEED)
    await onPhoneInboxWrap(await phoneWrap(B1, A1, r1))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS) // r1 applied, r2 re-offered
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(s2)
  })

  it('D(b): in order, the same two re-keys apply one after the other', async () => {
    const s1 = hex('4')
    const s2 = hex('5')
    await onPhoneInboxWrap(await phoneWrap(B1, A1, await struct(B, 'rekey', 'c1', H, rekeyPayload(s1, H))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    await onPhoneInboxWrap(await phoneWrap(D1, A1, await struct(D, 'rekey', 'c1', seedHash(s1), rekeyPayload(s2, seedHash(s1)))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(s2)
  })

  it('E: own removals survive an app kill inside the collection window', async () => {
    void sendRekey(circle('c1'), [C.pk])
    await queue.drain() // sent; our window is open
    expect(store.load().pendingRemovals.c1).toEqual([C.pk])
    // App killed: every in-memory window, queue hook and seen set is gone.
    resetRekeyForTests()
    resetReceiveForTests()
    queue.resetForTests()
    registerStructuralSenders()
    expect(circle('c1').members.map((m) => m.pk)).toContain(C.pk)
    await resumePendingRemovals()
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(C.pk)
    expect(store.load().pendingRemovals.c1).toBeUndefined()
  })

  it('E2 (stale-removal fix): resumePendingRemovals does not resend a removal for a member re-invited before the app restart', async () => {
    void sendRekey(circle('c1'), [C.pk])
    await queue.drain() // sent; our window is open
    expect(store.load().pendingRemovals.c1).toEqual([C.pk])
    // C is invited back before this device restarts — a fresh invite/vouch
    // (vouches.ts's "newest wins" `storeVouch`), dated after the removal
    // above was asked for.
    const reinvite = await vouchEvent(A, C.pk, 'child', 'c1', nowSec() + 10)
    expect(storeVouch(verifyVouch(reinvite)!, { nowSec: nowSec() + 10 })).toBe(true)
    // App killed: every in-memory window, queue hook and seen set is gone.
    resetRekeyForTests()
    resetReceiveForTests()
    queue.resetForTests()
    registerStructuralSenders()
    await resumePendingRemovals()
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    // Not resent: C is still a member, and nothing is left pending/queued.
    expect(circle('c1').members.map((m) => m.pk)).toContain(C.pk)
    expect(store.load().pendingRemovals.c1).toBeUndefined()
    expect(queue.pending()).toHaveLength(0)
    const note = store.load().activity.find((a) => a.kind === 'member-removed' && a.actorPk === C.pk)
    expect(note?.params.reason).toContain("Didn't repeat an old removal of")
    expect(note?.params.reason).toContain('invited back')
  })

  it('E3 (stale-removal fix): sendRekeyEvent\'s own stale-resend path drops a member re-invited after the removal was signed', async () => {
    // A rekey already signed against H, removing C — built directly (rather
    // than raced through the real enqueue/auto-drain) so the seed move below
    // lands deterministically between "signed" and "sent".
    const removeEv = await struct(A, 'rekey', 'c1', H, rekeyPayload(hex('9'), H, [C.pk]))
    store.update((p) => {
      p.structuralQueue = [...p.structuralQueue, {
        id: 'test-stale-removal', action: 'rekey', circleId: 'c1', payload: removeEv.content,
        label: 'test', status: 'waiting', createdAt: Date.now(), attempts: 0, signed: removeEv, seed: hex('9'),
      }]
    })
    // The circle has since moved on to a different seed (some other,
    // unrelated re-key applied) — our signed rekey above is now stale.
    store.update((p) => {
      const c = p.circles.find((x) => x.id === 'c1')
      if (c) c.seedHex = hex('4')
    })
    // C is invited back before our stale removal is ever resent.
    const reinvite = await vouchEvent(A, C.pk, 'child', 'c1', removeEv.created_at + 5)
    expect(storeVouch(verifyVouch(reinvite)!, { nowSec: removeEv.created_at + 5 })).toBe(true)
    await queue.drain() // sendRekeyEvent's stale branch: nothing left to resend
    expect(queue.pending()).toHaveLength(0)
    expect(circle('c1').members.map((m) => m.pk)).toContain(C.pk)
    expect(store.load().pendingRemovals.c1).toBeUndefined()
    const note = store.load().activity.find((a) => a.kind === 'member-removed' && a.actorPk === C.pk)
    expect(note?.params.reason).toContain("Didn't repeat an old removal of")
  })

  describe('security fix: "invited back" requires the vouch\'s signer to have had removal authority', () => {
    /** Adds outsider X to c1 as an unvouched peer (Task 5's `mayVouch`
     *  would let any member, a dependant included, invite them — the hole
     *  this fix closes is that doing so must not also count as authority
     *  to have removed them). */
    function addX(): void {
      store.update((p) => { p.circles = p.circles.map((c) => (c.id === 'c1' ? { ...c, members: [...c.members, { pk: X.pk, role: 'peer' }] } : c)) })
    }

    it("a peer's (here, a dependant's) fresh invite of a removed member does not drop the pending removal: its signer had no authority to remove them", async () => {
      addX()
      void sendRekey(circle('c1'), [X.pk])
      await queue.drain() // sent; our window is open
      expect(store.load().pendingRemovals.c1).toEqual([X.pk])
      // C — a dependant, not a guardian, not X's voucher (X never had
      // one), and X was never marked unvouched — signs a fresh invite(X).
      // `mayVouch` lets this through (any member may vouch for a peer),
      // but `mayRemove` does not: C could never have removed X.
      const invite = await vouchEvent(C, X.pk, 'peer', 'c1', nowSec() + 10)
      await deliver(await circleWrap(C1, circle('c1'), 'vouch-post', JSON.stringify(invite)))
      expect(vouchFor('c1', X.pk)?.by).toBe(C.pk) // the invite is stored…
      // App killed: every in-memory window, queue hook and seen set is gone.
      resetRekeyForTests()
      resetReceiveForTests()
      queue.resetForTests()
      registerStructuralSenders()
      await resumePendingRemovals()
      await queue.drain()
      await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
      // …but the removal is still owed, and is resent and applied — an
      // ordinary removal Activity entry (no "reason"), never the
      // stale-removal-drop's "invited back" one.
      expect(circle('c1').members.map((m) => m.pk)).not.toContain(X.pk)
      expect(store.load().pendingRemovals.c1).toBeUndefined()
      const note = store.load().activity.find((a) => a.kind === 'member-removed' && a.actorPk === X.pk)
      expect(note?.params.reason).toBeUndefined()
    })

    it("a guardian's fresh invite of a removed member does drop the pending removal: its signer did have removal authority", async () => {
      addX()
      void sendRekey(circle('c1'), [X.pk])
      await queue.drain()
      expect(store.load().pendingRemovals.c1).toEqual([X.pk])
      // D is a guardian: `mayRemove` grants a guardian removal authority
      // over anyone, so D's fresh invite genuinely means "invited back".
      const reinvite = await vouchEvent(D, X.pk, 'peer', 'c1', nowSec() + 10)
      await deliver(await circleWrap(D1, circle('c1'), 'vouch-post', JSON.stringify(reinvite)))
      expect(vouchFor('c1', X.pk)?.by).toBe(D.pk)
      resetRekeyForTests()
      resetReceiveForTests()
      queue.resetForTests()
      registerStructuralSenders()
      await resumePendingRemovals()
      await queue.drain()
      await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
      expect(circle('c1').members.map((m) => m.pk)).toContain(X.pk)
      expect(store.load().pendingRemovals.c1).toBeUndefined()
      const note = store.load().activity.find((a) => a.kind === 'member-removed' && a.actorPk === X.pk)
      expect(note?.params.reason).toContain("Didn't repeat an old removal of")
      expect(note?.params.reason).toContain('invited back')
    })

    it("a removed member's own vouch for themself never drops the pending removal", async () => {
      addX()
      expect(acceptStatement(circle('c1'), await statement(X, X1), X1.pk, nowSec())).toBe('added')
      void sendRekey(circle('c1'), [X.pk])
      await queue.drain()
      expect(store.load().pendingRemovals.c1).toEqual([X.pk])
      // X signs a vouch naming themself — `mayVouch` forbids self-vouching
      // outright (voucherPk === pk), so this is never even stored.
      const selfVouch = await vouchEvent(X, X.pk, 'peer', 'c1', nowSec() + 10)
      await deliver(await circleWrap(X1, circle('c1'), 'vouch-post', JSON.stringify(selfVouch)))
      expect(vouchFor('c1', X.pk)).toBeNull()
      resetRekeyForTests()
      resetReceiveForTests()
      queue.resetForTests()
      registerStructuralSenders()
      await resumePendingRemovals()
      await queue.drain()
      await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
      expect(circle('c1').members.map((m) => m.pk)).not.toContain(X.pk)
      expect(store.load().pendingRemovals.c1).toBeUndefined()
      // Removed for real (an ordinary removal Activity entry, no "reason" —
      // never the stale-removal-drop's "invited back" note).
      const note = store.load().activity.find((a) => a.kind === 'member-removed' && a.actorPk === X.pk)
      expect(note?.params.reason).toBeUndefined()
    })
  })

  it('F: member-removed Activity is recorded when the removal re-key is applied, not when it is asked for', async () => {
    const removedEntries = (): number => store.load().activity.filter((a) => a.kind === 'member-removed' && a.actorPk === C.pk).length
    await removeMemberFromCircle('c1', C.pk)
    await queue.drain()
    expect(removedEntries()).toBe(0)
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(removedEntries()).toBe(1)
  })

  it('G: structural dedup is persisted — a replay after a restart is not dispatched again', async () => {
    const inner = await struct(B, 'places', 'c1', H, '[]')
    await deliver(await circleWrap(B1, circle('c1'), 'struct', JSON.stringify(inner)))
    resetReceiveForTests() // restart: the in-memory rumor FIFO is gone
    await deliver(await circleWrap(B1, circle('c1'), 'struct', JSON.stringify(inner)))
    expect(received).toHaveLength(1)
    expect(store.load().seenStructural).toContain(`c1:${inner.id}`)
  })

  it('H: app start re-posts our statement into each circle at most once per 24 h', async () => {
    const t0 = Date.now()
    const statementPosts = (): number => published().filter((w) => w.to === deriveInbox(SEED).pk || w.to === deriveInbox(hex('3')).pk).length
    await refreshStatements(t0)
    expect(statementPosts()).toBe(2) // c1 and c2
    await refreshStatements(t0 + 60 * 60 * 1000)
    expect(statementPosts()).toBe(2)
    await refreshStatements(Date.now() + STATEMENT_REFRESH_MS + 1000)
    expect(statementPosts()).toBe(4)
  })

  it('I: sessionForTests refuses to run outside the test runner', () => {
    vi.stubEnv('MODE', 'production')
    vi.stubEnv('VITEST', '')
    try {
      expect(() => sessionForTests(null)).toThrow(/only available under test/)
    } finally {
      vi.unstubAllEnvs()
    }
  })
})

describe('review fix round 2', () => {
  const H = seedHash(SEED)

  it('1: a revoked phone bound to a remaining member triggers the re-key even if this device never sent it the seed', async () => {
    // This device doesn't know B1 yet.
    store.update((p) => { const { [B1.pk]: _b1, ...rest } = p.phoneKeys.c1!; p.phoneKeys = { ...p.phoneKeys, c1: rest } })
    // D (who knew of the revocation) re-keys without B1; this device has no
    // B1 to forward to. Off this device, E (unaware) forwards it to B1.
    const s1 = hex('4')
    const to = [A1, A2, C1, D1, E1].map((k) => k.pk)
    await onPhoneInboxWrap(await phoneWrap(D1, A1, await struct(D, 'rekey', 'c1', H, rekeyPayload(s1, H, [], to))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(s1)
    // B1's statement, buffered, binds on the next roster rescan.
    const stB1 = await statement(B, B1)
    store.update((p) => { p.pendingStatements = [...p.pendingStatements, { circleId: 'c1', event: stB1 }] })
    const cfg = { v: 2, createdBy: A.pk, vouches: [] as SignedEvent[], id: 'c1', name: 'Circle c1', updatedAt: 999_999, by: D.pk, members: circle('c1').members }
    await deliver(await circleWrap(D1, circle('c1'), 'struct', JSON.stringify(await struct(D, 'config', 'c1', seedHash(s1), JSON.stringify(cfg)))))
    expect(memberForPhone('c1', B1.pk)).toBe(B.pk)
    expect(store.load().seedRecipients.c1).not.toContain(B1.pk)
    vi.mocked(publishSigned).mockClear()

    const rv = await makeLocalSigner(B.sk).signEvent(revocationTemplate(B1.pk, nowSec()))
    await deliver(await circleWrap(D1, circle('c1'), 'revoke', JSON.stringify(rv)))
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).not.toBe(s1)
    expect(published().some((w) => w.to === personalInboxTag(B1.pk))).toBe(false)
  })

  async function removeDThenLateWinner(reset: boolean): Promise<{ w: SignedEvent }> {
    void sendRekey(circle('c1'), [D.pk])
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(D.pk)
    expect(memberForPhone('c1', D1.pk)).toBeNull()
    const ownId = lastOwnRekeyIdForTests('c1')!
    // Final fix A1: D itself may no longer contest its removal — the late
    // winner is another guardian's (B's) concurrent re-key, unaware of it.
    const w = await rekeyWhere(B, H, (id) => id < ownId)
    if (reset) {
      // App killed between applying our re-key and the late winner.
      resetRekeyForTests()
      resetReceiveForTests()
      queue.resetForTests()
      registerStructuralSenders()
    }
    await onPhoneInboxWrap(await phoneWrap(B1, A1, w))
    return { w }
  }

  it('2: a late winner that lacks the replaced re-key\'s removal restores the member at prev, our removal is re-sent, and devices converge', async () => {
    const { w } = await removeDThenLateWinner(false)
    expect(circle('c1').seedHex).toBe(seedOf(w)) // replaced
    expect(circle('c1').members.map((m) => m.pk)).toContain(D.pk) // rolled back to the roster at prev
    expect(store.load().pendingRemovals.c1).toEqual([D.pk])
    await queue.drain() // our removal of D, re-enqueued on top of W
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    const P = circle('c1').seedHex
    expect(P).not.toBe(seedOf(w))
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(D.pk)
    const toC = published().filter((x) => x.to === personalInboxTag(C1.pk)).map((x) => x.wrap)

    // Device 2 (C) sees W in its window, then everything this device sent.
    await device(C, C1)
    await onPhoneInboxWrap(await phoneWrap(B1, C1, w))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    for (const x of toC) await onPhoneInboxWrap(x)
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(P)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(D.pk)
  })

  it('3: our replaced removals return to pendingRemovals and are re-sent, even across a restart', async () => {
    const { w } = await removeDThenLateWinner(true)
    expect(circle('c1').seedHex).toBe(seedOf(w))
    expect(store.load().pendingRemovals.c1).toEqual([D.pk])
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(D.pk)
    expect(store.load().pendingRemovals.c1).toBeUndefined()
  })

  it('4: a structural event from a non-member with an unbound sealing phone is dropped, not parked', async () => {
    const X2 = key()
    await deliver(await circleWrap(X2, circle('c1'), 'struct', JSON.stringify(await struct(X, 'places', 'c1', H, '[]'))))
    // X is then added and X2 bound: nothing parked comes back.
    const cfg = { v: 2, createdBy: A.pk, vouches: [await vouchEvent(B, X.pk, 'guardian')], id: 'c1', name: 'Circle c1', updatedAt: 999_999, by: B.pk, members: [...circle('c1').members, { pk: X.pk, role: 'guardian' as Role }] }
    await deliver(await circleWrap(B1, circle('c1'), 'struct', JSON.stringify(await struct(B, 'config', 'c1', H, JSON.stringify(cfg)))))
    await deliver(await circleWrap(X2, circle('c1'), 'device', JSON.stringify(await statement(X, X2))))
    expect(memberForPhone('c1', X2.pk)).toBe(X.pk)
    expect(received.filter((r) => r.t === 'places')).toHaveLength(0)
  })
})

describe('review fix round 3', () => {
  const H = seedHash(SEED)
  const removedEntries = (pk: string): number => store.load().activity.filter((a) => a.kind === 'member-removed' && a.actorPk === pk).length

  it('1: "ours" is durable — a re-key sent before a restart and applied after it still has its removals re-sent when a late winner replaces it', async () => {
    void sendRekey(circle('c1'), [D.pk])
    await queue.drain()
    const ownWrap = published().find((x) => x.to === personalInboxTag(A1.pk))!.wrap
    // App killed before R's window closed: nothing in memory knows R was ours.
    resetRekeyForTests()
    resetReceiveForTests()
    queue.resetForTests()
    registerStructuralSenders()
    await onPhoneInboxWrap(ownWrap) // the relay re-delivers R to this phone
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(D.pk)
    const rId = store.load().lastRekey.c1!.id
    expect(store.load().lastRekey.c1!.mine).toBe(true)
    const w = await rekeyWhere(B, H, (id) => id < rId)
    await onPhoneInboxWrap(await phoneWrap(B1, A1, w))
    expect(circle('c1').seedHex).toBe(seedOf(w))
    expect(queue.pending().some((q) => q.action === 'rekey' && JSON.parse(q.payload).removals.includes(D.pk))).toBe(true)
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(D.pk)
  })

  it('2: a late winner withdraws the replaced re-key\'s member-removed entry for a member it restores', async () => {
    void sendRekey(circle('c1'), [D.pk])
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(removedEntries(D.pk)).toBe(1)
    const w = await rekeyWhere(B, H, (id) => id < store.load().lastRekey.c1!.id)
    await onPhoneInboxWrap(await phoneWrap(B1, A1, w))
    expect(circle('c1').members.map((m) => m.pk)).toContain(D.pk)
    expect(removedEntries(D.pk)).toBe(0)
  })

  it('2: a member removed by both the replaced re-key and the late winner is logged once', async () => {
    void sendRekey(circle('c1'), [C.pk])
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    const w = await rekeyWhere(B, H, (id) => id < store.load().lastRekey.c1!.id, [C.pk])
    await onPhoneInboxWrap(await phoneWrap(B1, A1, w))
    expect(circle('c1').seedHex).toBe(seedOf(w))
    expect(removedEntries(C.pk)).toBe(1)
  })

  it('3: load() drops lastRekey entries of an older shape', () => {
    const good = { prev: H, id: hex('b'), signerPk: B.pk, removals: [], seedRecipients: [], mine: false, createdAt: 1, appliedAt: 2, before: { removedPks: [], removals: {}, members: [], phones: {} } }
    const { createdAt: _c, appliedAt: _a, ...noTimes } = good
    const { signerPk: _s, ...noSigner } = good
    localStorage.setItem('kindependence.v1', JSON.stringify({
      ...store.load(),
      lastRekey: { good, old: { prev: H, id: hex('a'), removals: [], seedRecipients: [] }, noTimes, noSigner },
    }))
    expect(store.load().lastRekey.old).toBeUndefined()
    expect(store.load().lastRekey.noTimes).toBeUndefined()
    expect(store.load().lastRekey.noSigner).toBeUndefined()
    expect(store.load().lastRekey.good).toEqual(good)
  })
})

// Task 9 fix round 1, finding 4: the DM receive path (`onPhoneInboxWrap`'s
// `t:'dm'` branch) resolves the sealing phone to a member via
// `memberForPhone`, drops an unbound phone, and skips this device's own
// phone as an echo — plus fanout: a recipient identity with two phones gets
// its own wrap per phone, and each phone's own device delivers its own copy.
describe('DM receive path (Task 9 fix round 1, finding 4)', () => {
  it('resolves the sealing phone to its member via memberForPhone and delivers to the registered handler', async () => {
    const seen: Array<{ from: string; circleId: string; text: string }> = []
    setPersonalDmHandler((dm) => { seen.push({ from: dm.from, circleId: dm.circleId, text: dm.text }) })
    const wrap = await buildDmWrap(makeLocalSigner(B1.sk), A1.pk, { circleId: 'c1', text: 'hi from B' })
    await onPhoneInboxWrap(wrap)
    setPersonalDmHandler(null)
    expect(seen).toEqual([{ from: B.pk, circleId: 'c1', text: 'hi from B' }])
  })

  it('drops a DM sealed by a phone key bound to no member (memberForPhone returns null)', async () => {
    const seen: string[] = []
    setPersonalDmHandler((dm) => { seen.push(dm.from) })
    const wrap = await buildDmWrap(makeLocalSigner(X1.sk), A1.pk, { circleId: 'c1', text: 'from a stranger' })
    await onPhoneInboxWrap(wrap)
    setPersonalDmHandler(null)
    expect(seen).toEqual([])
  })

  it('own echo: a DM sealed by this device\'s own phone key is skipped before reaching the handler', async () => {
    const seen: string[] = []
    setPersonalDmHandler((dm) => { seen.push(dm.from) })
    const wrap = await buildDmWrap(makeLocalSigner(A1.sk), A1.pk, { circleId: 'c1', text: 'to myself' })
    await onPhoneInboxWrap(wrap)
    setPersonalDmHandler(null)
    expect(seen).toEqual([])
  })

  it('multi-phone fanout: a wrap addressed to each of the recipient\'s two phones is delivered on that phone\'s own device', async () => {
    // This device (A / A1, the default `beforeEach` session): a wrap sealed
    // to A1 is delivered here.
    const seenA1: string[] = []
    setPersonalDmHandler((dm) => { seenA1.push(dm.from) })
    await onPhoneInboxWrap(await buildDmWrap(makeLocalSigner(B1.sk), A1.pk, { circleId: 'c1', text: 'fanout' }))
    setPersonalDmHandler(null)
    expect(seenA1).toEqual([B.pk])

    // A's OTHER phone (A2, same identity, a different physical device): the
    // wrap addressed to A1 above is undecryptable there, but the SEPARATE
    // wrap fanned out to A2 is delivered once that phone's own session is
    // live.
    await device(A, A2)
    const seenA2: string[] = []
    setPersonalDmHandler((dm) => { seenA2.push(dm.from) })
    await onPhoneInboxWrap(await buildDmWrap(makeLocalSigner(B1.sk), A2.pk, { circleId: 'c1', text: 'fanout' }))
    setPersonalDmHandler(null)
    expect(seenA2).toEqual([B.pk])
  })

  // Task 10 fix round 1, finding 1: Task 9's own seal-forgery regression
  // coverage for this exact path lived in messages.test.ts against
  // `circles.onPersonalInboxWrap` directly and was removed as dead code when
  // Task 10 finished moving DMs off the personal inbox — leaving the DM
  // receive path itself (`onPhoneInboxWrap`) with no forged-seal coverage of
  // its own. X1 (an unbound outsider phone) seals a rumor claiming to be B1
  // (a phone genuinely bound to guardian B) — a legitimate NIP-44
  // encrypt/decrypt under X1's own real key, since ECDH doesn't stop a
  // sender encrypting to a real recipient with their own real key. Without
  // the seal/rumor-pubkey binding check inside `giftUnwrap` (app-scope,
  // patched roost-kit), this would be trusted as a DM from B.
  it('drops a DM whose seal is a forged rumor.pubkey (X1 seals claiming to be B1)', async () => {
    const seen: string[] = []
    setPersonalDmHandler((dm) => { seen.push(dm.from) })
    const wrap = await forgeSealedWrap(makeLocalSigner(X1.sk), A1.pk, B1.pk, {
      kind: 14, content: JSON.stringify({ t: 'dm', c: 'c1', text: 'forged from X1' }), tags: [],
    })
    await onPhoneInboxWrap(wrap)
    setPersonalDmHandler(null)
    expect(seen).toEqual([])
  })
})

describe('Task 12 fix round 1, item 1 (security): a device revoked receives its own revocation', () => {
  it('B: a revocation of B1 (this device\'s own phone) signs out instead of re-keying — nothing enqueued, session gone, the whole local store wiped', async () => {
    await device(B, B1)
    const rv = await makeLocalSigner(B.sk).signEvent(revocationTemplate(B1.pk, nowSec()))
    await deliver(await circleWrap(D1, circle('c1'), 'revoke', JSON.stringify(rv)))

    // No re-key was enqueued or sent by this (now signed-out) device.
    expect(queue.pending()).toHaveLength(0)
    expect(published()).toHaveLength(0)
    // Signed out: the session is gone…
    expect(currentSession()).toBeNull()
    // …and so is every locally-held circle (and its seed) — `session.signOut()`
    // wipes the WHOLE local store, not just the session field.
    expect(store.load().circles).toEqual([])
  })

  it('sendRekey never lists a revoked phone key — including our own — in `to` (defence in depth)', async () => {
    // A different circle member (D) revokes A1 by hand here — direct store
    // mutation, not `applyRevocation` — precisely so THIS test exercises
    // `sendRekey`'s own guard in isolation, independent of the item-1 fix
    // above (which would otherwise skip calling `sendRekey` for this case
    // entirely).
    const rv = await makeLocalSigner(A.sk).signEvent(revocationTemplate(A1.pk, nowSec()))
    store.update((p) => { p.revokedPhoneKeys = { ...p.revokedPhoneKeys, [A1.pk]: rv } })

    // Not awaited on purpose: `sendRekey`'s own body (including the `to` it
    // enqueues) runs fully synchronously — checking `queue.pending()` right
    // after, still in the same synchronous turn, reads the payload before
    // structural-queue's own async drain has had any chance to touch it.
    void sendRekey(circle('c1'), [])
    const item = queue.pending().find((q) => q.action === 'rekey' && q.circleId === 'c1')
    expect(item).toBeDefined()
    const to = (JSON.parse(item!.payload) as { to: string[] }).to
    expect(to).not.toContain(A1.pk) // revoked — even though it's THIS device's own phone
    expect(to).toContain(A2.pk) // this identity's other, non-revoked phone is still included
  })
})

describe('Task 9 (spec §7): a linked guardian\'s revocation of a dependant\'s own phone also signs it out', () => {
  it('C: a revocation of C1 signed by C\'s linked guardian A signs C1 out, same as C\'s own signature would', async () => {
    await device(C, C1)
    const rv = await makeLocalSigner(A.sk).signEvent(revocationTemplate(C1.pk, nowSec()))
    await deliver(await circleWrap(D1, circle('c1'), 'revoke', JSON.stringify(rv)))

    expect(queue.pending()).toHaveLength(0)
    expect(published()).toHaveLength(0)
    expect(currentSession()).toBeNull()
    expect(store.load().circles).toEqual([])
  })

  it('C: a revocation of C1 signed by X (no guardian link at all) is rejected outright — no sign-out, nothing stored', async () => {
    await device(C, C1)
    const rv = await makeLocalSigner(X.sk).signEvent(revocationTemplate(C1.pk, nowSec()))
    await deliver(await circleWrap(D1, circle('c1'), 'revoke', JSON.stringify(rv)))

    expect(currentSession()).not.toBeNull()
    expect(store.load().revokedPhoneKeys[C1.pk]).toBeUndefined()
  })
})

describe('Task 9 fix round 1: a guardian revocation arriving before its link pair is known is parked, not dropped for good', () => {
  it('C: a revocation of C1 signed by A arrives before this device knows the A–C link → parked, C stays signed in; the link pair arriving later applies it and signs C1 out (same as an immediate acceptance)', async () => {
    await device(C, C1)
    // Simulate this device not yet having the A–C link pair (randomised
    // gift-wrap catch-up can deliver the revocation first).
    store.update((p) => {
      const { [`${A.pk}:${C.pk}`]: _drop, ...rest } = p.guardianLinks
      p.guardianLinks = rest
    })
    expect(linked(A.pk, C.pk)).toBe(false)

    const rv = await makeLocalSigner(A.sk).signEvent(revocationTemplate(C1.pk, nowSec()))
    await deliver(await circleWrap(D1, circle('c1'), 'revoke', JSON.stringify(rv)))

    // Parked, not applied: C is still signed in and nothing was enqueued.
    expect(store.load().revokedPhoneKeys[C1.pk]).toBeUndefined()
    expect(currentSession()).not.toBeNull()
    expect(queue.pending()).toHaveLength(0)

    // The A–C link pair arrives now.
    const acLink = (await trustFixture()).links[0]
    expect(acceptLinkPair(acLink.g, acLink.d)).toBe(true)
    await applyParkedRevocations()

    // Sign-out wipes the whole local store (session, phone key, seeds) —
    // same as an immediately-applied self-phone revocation would.
    expect(currentSession()).toBeNull()
    expect(store.load().circles).toEqual([])
  })

  it('C: a revocation of C1 signed by X (never a guardian) is parked; a link forming between two unrelated people never promotes it', async () => {
    await device(C, C1)
    const rv = await makeLocalSigner(X.sk).signEvent(revocationTemplate(C1.pk, nowSec()))
    await deliver(await circleWrap(D1, circle('c1'), 'revoke', JSON.stringify(rv)))

    expect(store.load().revokedPhoneKeys[C1.pk]).toBeUndefined()
    expect(currentSession()).not.toBeNull()

    const other1 = key(); const other2 = key()
    const unrelated = await linkPair(other1, other2, nowSec() - 10)
    expect(acceptLinkPair(unrelated.g, unrelated.d)).toBe(true)
    await applyParkedRevocations()

    expect(store.load().revokedPhoneKeys[C1.pk]).toBeUndefined()
    expect(currentSession()).not.toBeNull()
  })
})

describe('Task 12 fix round 2, finding 1 (security): another member can no longer force our (unbound) phone to sign out', () => {
  it('A signed in on a fresh, never-bound phone A3: B\'s revocation of A3 is rejected, no sign-out, nothing stored', async () => {
    const A3 = key()
    sessionForTests({ identityPk: A.pk, phoneSkHex: A3.sk, statement: await statement(A, A3), transport: localTransport(A) })
    expect(memberForPhone('c1', A3.pk)).toBeNull() // confirms A3 is unbound anywhere locally

    const rv = await makeLocalSigner(B.sk).signEvent(revocationTemplate(A3.pk, nowSec()))
    await deliver(await circleWrap(D1, circle('c1'), 'revoke', JSON.stringify(rv)))

    expect(store.load().revokedPhoneKeys[A3.pk]).toBeUndefined()
    expect(currentSession()).not.toBeNull() // not signed out
    expect(queue.pending()).toHaveLength(0) // no re-key enqueued either
  })

  it('same, once A3 has actually been bound into c1\'s table: still rejected', async () => {
    const A3 = key()
    sessionForTests({ identityPk: A.pk, phoneSkHex: A3.sk, statement: await statement(A, A3), transport: localTransport(A) })
    expect(acceptStatement(circle('c1'), await statement(A, A3), A3.pk, nowSec())).toBe('added')

    const rv = await makeLocalSigner(B.sk).signEvent(revocationTemplate(A3.pk, nowSec()))
    await deliver(await circleWrap(D1, circle('c1'), 'revoke', JSON.stringify(rv)))

    expect(store.load().revokedPhoneKeys[A3.pk]).toBeUndefined()
    expect(currentSession()).not.toBeNull()
    expect(memberForPhone('c1', A3.pk)).toBe(A.pk)
  })
})

describe('Task 12 fix round 2, finding 2 (minor): sendRekey sends nothing when we have no surviving phone of our own', () => {
  it('D: with D1 already revoked and no other phone of D\'s left in `to`, sendRekey enqueues nothing', async () => {
    await device(D, D1)
    const rv = await makeLocalSigner(A.sk).signEvent(revocationTemplate(D1.pk, nowSec()))
    store.update((p) => { p.revokedPhoneKeys = { ...p.revokedPhoneKeys, [D1.pk]: rv } })

    void sendRekey(circle('c1'), [])
    const item = queue.pending().find((q) => q.action === 'rekey' && q.circleId === 'c1')
    expect(item).toBeUndefined()
  })
})

describe('final fix A1 (critical): a removed guardian cannot undo its own removal through the late-winner path', () => {
  const H = seedHash(SEED)

  /** We (A) remove D; our re-key R1 is applied. Returns R1's id and seed. */
  async function removeD(): Promise<{ r1: string; seed: string }> {
    void sendRekey(circle('c1'), [D.pk])
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(D.pk)
    return { r1: store.load().lastRekey.c1!.id, seed: circle('c1').seedHex }
  }

  it('regression: removed guardian D grinds a lower id and removes the remover — the replace is refused, the circle stays on our seed', async () => {
    const { r1, seed } = await removeD()
    // D's counter re-key on the same prev: removes A, leaves A's phones out.
    const to = [B1, C1, D1, E1].map((k) => k.pk)
    const created = nowSec()
    let w: SignedEvent | undefined
    for (let i = 0; i < 2_000_000 && !w; i++) {
      const t = structuralTemplate({ action: 'rekey', circleId: 'c1', prevSeedHash: H, payload: rekeyPayload(toHex(crypto.getRandomValues(new Uint8Array(32))), H, [A.pk], to), nowSec: created })
      if (getEventHash({ ...t, pubkey: D.pk }) < r1) w = await makeLocalSigner(D.sk).signEvent(t)
    }
    expect(w!.id < r1).toBe(true)
    await onPhoneInboxWrap(await phoneWrap(D1, A1, w!))
    expect(circle('c1').seedHex).toBe(seed)
    expect(circle('c1').members.map((m) => m.pk)).toContain(A.pk)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(D.pk)
    expect(store.load().lastRekey.c1!.id).toBe(r1)

    // The same at a third member (C), who applied R1 too.
    const r1Wrap = published().find((x) => x.to === personalInboxTag(C1.pk))!.wrap
    await device(C, C1)
    await onPhoneInboxWrap(r1Wrap)
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(seed)
    await onPhoneInboxWrap(await phoneWrap(D1, C1, w!))
    expect(circle('c1').seedHex).toBe(seed)
    expect(circle('c1').members.map((m) => m.pk)).toContain(A.pk)
  })

  it('a late winner signed by another guardian but sealed by the removed member\'s phone is refused', async () => {
    const { r1, seed } = await removeD()
    const w = await rekeyWhere(B, H, (id) => id < r1)
    await onPhoneInboxWrap(await phoneWrap(D1, A1, w))
    expect(circle('c1').seedHex).toBe(seed)
  })

  it('a late winner arriving more than 10 minutes after the replaced re-key was applied is refused', async () => {
    const { r1, seed } = await removeD()
    store.update((p) => { p.lastRekey.c1!.appliedAt -= 10 * 60 * 1000 + 1000 })
    const w = await rekeyWhere(B, H, (id) => id < r1)
    await onPhoneInboxWrap(await phoneWrap(B1, A1, w))
    expect(circle('c1').seedHex).toBe(seed)
  })

  it('a late winner dated more than 600 s after the replaced re-key is refused', async () => {
    const { r1, seed } = await removeD()
    const createdAt = store.load().lastRekey.c1!.createdAt
    const w = await rekeyWhere(B, H, (id) => id < r1, [], createdAt + 601)
    await onPhoneInboxWrap(await phoneWrap(B1, A1, w))
    expect(circle('c1').seedHex).toBe(seed)
  })

  it('positive control: another guardian\'s late winner inside both bounds still replaces it', async () => {
    const { r1 } = await removeD()
    const createdAt = store.load().lastRekey.c1!.createdAt
    const w = await rekeyWhere(B, H, (id) => id < r1, [], createdAt + 600)
    await onPhoneInboxWrap(await phoneWrap(B1, A1, w))
    expect(circle('c1').seedHex).toBe(seedOf(w))
    expect(store.load().lastRekey.c1!.appliedAt).toBeGreaterThan(Date.now() - 5000)
  })
})

describe('final fix A9: traffic resolves only to members on the current roster', () => {
  const H = seedHash(SEED)

  it('a config that drops a member forgets its phone bindings, and its traffic is no longer dispatched', async () => {
    const cfg = { v: 2, createdBy: A.pk, vouches: [] as SignedEvent[], id: 'c1', name: 'Circle c1', updatedAt: 999_999, by: B.pk, members: circle('c1').members.filter((m) => m.pk !== E.pk) }
    await deliver(await circleWrap(B1, circle('c1'), 'struct', JSON.stringify(await struct(B, 'config', 'c1', H, JSON.stringify(cfg)))))
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(E.pk)
    expect(store.load().phoneKeys.c1?.[E1.pk]).toBeUndefined()
    expect(memberForPhone('c1', E1.pk)).toBeNull()
    received.length = 0
    await deliver(await circleWrap(E1, circle('c1'), 'x-test', 'hi'))
    expect(received).toHaveLength(0)
  })

  it('memberForPhone returns null for a binding whose member is not on the roster', async () => {
    store.update((p) => { p.circles = p.circles.map((c) => (c.id === 'c1' ? { ...c, members: c.members.filter((m) => m.pk !== E.pk) } : c)) })
    expect(store.load().phoneKeys.c1?.[E1.pk]?.memberPk).toBe(E.pk)
    expect(memberForPhone('c1', E1.pk)).toBeNull()
    expect(memberForPhone('c1', B1.pk)).toBe(B.pk)
  })
})

describe('final fix A3: circle seeds never go to the identity signer', () => {
  const H = seedHash(SEED)

  it('a re-key signs only a commitment to its new seed; the seed rides in the phone-sealed rumor', async () => {
    void sendRekey(circle('c1'), [C.pk])
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    const newSeed = circle('c1').seedHex
    expect(newSeed).not.toBe(SEED)
    expect(signedContents.length).toBeGreaterThan(0)
    for (const c of signedContents) expect(c).not.toContain(newSeed)
    expect(signedContents.some((c) => c.includes(seedHash(newSeed)))).toBe(true)
  })

  it('an invite signs no seed', async () => {
    knowContacts(X.pk)
    await inviteToCircle('c1', X.pk)
    await queue.drain()
    expect(published().some((w) => w.to === personalInboxTag(X.pk))).toBe(true)
    expect(signedContents.length).toBeGreaterThan(0)
    for (const c of signedContents) expect(c).not.toContain(SEED)
  })

  it('a re-key whose carried seed does not match its signed commitment is rejected', async () => {
    const ev = await struct(B, 'rekey', 'c1', H, rekeyPayload(hex('4'), H))
    await onPhoneInboxWrap(await phoneWrap(B1, A1, ev, hex('5')))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(SEED)
    // The honest copy still applies.
    await onPhoneInboxWrap(await phoneWrap(B1, A1, ev))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(hex('4'))
  })
})

describe('final fix A8: an invitee\'s placeholder treats its inviter as a peer until the signed config arrives', () => {
  // Plan 2, Task 5 (controller ruling R7): the first-config exception is
  // removed. Until Task 6 bootstraps the roster from the invite bundle, the
  // inviter stays a peer on the placeholder: it can't raise itself by
  // config, but may add a vouched member at its own level.
  it('the inviter stays a peer on the placeholder: guardian-only actions and a first config raising itself are dropped; a vouched addition is applied', async () => {
    const seed = hex('9')
    const H9 = seedHash(seed)
    const placeholder: store.StoredCircle = {
      id: 'c9', name: 'Joined', seedHex: seed, epoch: 0, createdAt: 1,
      members: [{ pk: A.pk, role: 'guardian' }, { pk: B.pk, role: 'peer' }], configUpdatedAt: 0, configBy: '',
    }
    store.update((p) => { p.circles = [...p.circles, placeholder]; p.seedHashes = { ...p.seedHashes, c9: [H9] } })
    expect(acceptStatement(placeholder, await statement(B, B1), B1.pk, nowSec())).toBe('added')

    await deliver(await circleWrap(B1, circle('c9'), 'struct', JSON.stringify(await struct(B, 'places', 'c9', H9, '[]'))), 'c9')
    expect(received.filter((r) => r.t === 'places')).toHaveLength(0)

    const vD = await vouchEvent(B, D.pk, 'peer', 'c9')
    const raised = { v: 2, createdBy: '', vouches: [vD], id: 'c9', name: 'Joined', updatedAt: nowSec(), by: B.pk, members: [{ pk: B.pk, role: 'guardian' }, { pk: A.pk, role: 'guardian' }, { pk: D.pk, role: 'peer' }] }
    await deliver(await circleWrap(B1, circle('c9'), 'struct', JSON.stringify(await struct(B, 'config', 'c9', H9, JSON.stringify(raised)))), 'c9')
    expect(circle('c9').members.find((m) => m.pk === B.pk)?.role).toBe('peer')
    expect(circle('c9').members.map((m) => m.pk)).not.toContain(D.pk)

    const added = { ...raised, members: [{ pk: B.pk, role: 'peer' }, { pk: A.pk, role: 'guardian' }, { pk: D.pk, role: 'peer' }] }
    await deliver(await circleWrap(B1, circle('c9'), 'struct', JSON.stringify(await struct(B, 'config', 'c9', H9, JSON.stringify(added)))), 'c9')
    expect(circle('c9').members.map((m) => m.pk)).toContain(D.pk)
    expect(voucherOf('c9', D.pk)).toBe(B.pk)

    await deliver(await circleWrap(B1, circle('c9'), 'struct', JSON.stringify(await struct(B, 'places', 'c9', H9, '[1]'))), 'c9')
    expect(received.filter((r) => r.t === 'places')).toHaveLength(0)
  })

  it('once configured, the placeholder exception is gone: a peer cannot raise its own role by config', async () => {
    const seed = hex('9')
    const H9 = seedHash(seed)
    const configured: store.StoredCircle = {
      id: 'c9', name: 'Joined', seedHex: seed, epoch: 0, createdAt: 1,
      members: [{ pk: A.pk, role: 'guardian' }, { pk: B.pk, role: 'peer' }], configUpdatedAt: 5, configBy: A.pk,
    }
    store.update((p) => { p.circles = [...p.circles, configured]; p.seedHashes = { ...p.seedHashes, c9: [H9] } })
    expect(acceptStatement(configured, await statement(B, B1), B1.pk, nowSec())).toBe('added')
    const cfg = { v: 2, createdBy: A.pk, vouches: [] as SignedEvent[], id: 'c9', name: 'Joined', updatedAt: nowSec(), by: B.pk, members: [{ pk: B.pk, role: 'guardian' }, { pk: A.pk, role: 'guardian' }] }
    await deliver(await circleWrap(B1, circle('c9'), 'struct', JSON.stringify(await struct(B, 'config', 'c9', H9, JSON.stringify(cfg)))), 'c9')
    expect(circle('c9').members.find((m) => m.pk === B.pk)?.role).toBe('peer')
  })
})

describe('final fix A5: re-inviting an identity already on the roster (another or new phone)', () => {
  it('A1 invites its own identity; a fresh A3 (same identity, no copy) accepts, posts its statement, and both phones bind at a third member', async () => {
    expect(resendInvite('c1', A.pk)).toBeNull()
    await queue.drain()
    const invite = published().find((w) => w.to === personalInboxTag(A.pk))?.wrap
    expect(invite).toBeDefined()
    // No roster or config change for a member already there.
    expect(queue.pending()).toEqual([])
    expect(circle('c1').members).toHaveLength(5)

    // A fresh phone A3 signed in as A: an empty store, no circles.
    const A3 = key()
    vi.stubGlobal('localStorage', fakeLocalStorage())
    resetReceiveForTests()
    resetRekeyForTests()
    queue.resetForTests()
    sessionForTests({ identityPk: A.pk, phoneSkHex: A3.sk, statement: await statement(A, A3), transport: localTransport(A) })
    registerStructuralSenders()
    vi.mocked(publishSigned).mockClear()
    await onPersonalInboxWrap(identitySigner(), invite!)
    circlesHandleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)
    expect(circle('c1').seedHex).toBe(SEED)
    expect(memberForPhone('c1', A1.pk)).toBe(A.pk)
    await vi.advanceTimersByTimeAsync(0)
    const posted = published().filter((w) => w.to === deriveInbox(SEED).pk).map((w) => w.wrap)
    expect(posted.length).toBeGreaterThan(0)

    // B, a third member, receives A3's statement on the circle inbox.
    await device(B, B1)
    for (const w of posted) await deliver(w)
    expect(memberForPhone('c1', A3.pk)).toBe(A.pk)
    expect(memberForPhone('c1', A1.pk)).toBe(A.pk)
  })

  it('refuses with a reason: a dependant member (viewer not their linked guardian), a non-member, a dependant session', async () => {
    await device(B, B1)
    expect(resendInvite('c1', E.pk)).toMatch(/parent/i) // B is not linked to E
    expect(resendInvite('c1', X.pk)).toMatch(/not a member/i)
    sessionForTests({ identityPk: C.pk, phoneSkHex: C1.sk, dependant: true, statement: await statement(C, C1), transport: localTransport(C) })
    expect(resendInvite('c1', C.pk)).toMatch(/parent/i)
    expect(inviteMyOtherPhone()).toMatch(/parent/i)
    expect(queue.pending()).toEqual([])
  })

  it('Task 6: a linked guardian re-sending a dependant member\'s invite queues a dependant (child) invite', async () => {
    expect(resendInvite('c1', C.pk)).toBeNull() // A is linked to C
    const items = queue.pending().filter((q) => q.action === 'invite')
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ circleId: 'c1', recipientPk: C.pk })
    expect(JSON.parse(items[0]!.payload)).toMatchObject({ pk: C.pk, role: 'child' })
  })

  it('inviteMyOtherPhone queues one invite to our own identity per circle, without roster changes', async () => {
    expect(inviteMyOtherPhone()).toBeNull()
    const items = queue.pending().filter((q) => q.action === 'invite')
    expect(items.map((q) => q.circleId).sort()).toEqual(['c1', 'c2'])
    expect(items.every((q) => q.recipientPk === A.pk)).toBe(true)
    await queue.drain()
    expect(queue.pending()).toEqual([])
    expect(published().filter((w) => w.to === personalInboxTag(A.pk))).toHaveLength(2)
  })
})

describe('final fix round 2, R1: a self re-invite cannot open a roster takeover on the new phone', () => {
  const H = seedHash(SEED)

  /** Switches to a fresh phone A3 (identity A, empty store) and accepts
   *  `invite` there. */
  async function freshPhoneAccepts(A3: Key, invite: SignedEvent): Promise<void> {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    resetReceiveForTests()
    resetRekeyForTests()
    queue.resetForTests()
    sessionForTests({ identityPk: A.pk, phoneSkHex: A3.sk, statement: await statement(A, A3), transport: localTransport(A) })
    registerStructuralSenders()
    vi.mocked(publishSigned).mockClear()
    await onPersonalInboxWrap(identitySigner(), invite)
    circlesHandleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)
    await vi.advanceTimersByTimeAsync(0)
    // Plan 2, Task 5: the links between members (Task 6 carries them in
    // the invite bundle) — a config adding a dependant needs one.
    await acceptFixtureLinks()
    received.length = 0
  }

  it('the new phone refuses another member\'s config naming itself writer, takes our identity\'s config, then hears the other members', async () => {
    expect(resendInvite('c1', A.pk)).toBeNull()
    await queue.drain()
    const invite = published().find((w) => w.to === personalInboxTag(A.pk))?.wrap
    // R1a: the inviting phone also sends our identity's config on the circle inbox.
    const configWraps = published().filter((w) => w.to === deriveInbox(SEED).pk).map((w) => w.wrap)
    expect(invite).toBeDefined()
    expect(configWraps).toHaveLength(1)
    expect(queue.pending()).toEqual([])
    expect(circle('c1').members).toHaveLength(5)

    const A3 = key()
    await freshPhoneAccepts(A3, invite!)
    expect(circle('c1').members.map((m) => m.pk)).toEqual([A.pk])

    // D (a real member, holds the seed) races a config onto A3 naming
    // itself the only guardian, far-future dated.
    await deliver(await circleWrap(D1, circle('c1'), 'device', JSON.stringify(await statement(D, D1))))
    const capture = { v: 2, createdBy: A.pk, vouches: [] as SignedEvent[], id: 'c1', name: 'Mine', updatedAt: nowSec() + 10_000_000, by: D.pk, members: [{ pk: D.pk, role: 'guardian' }, { pk: A.pk, role: 'peer' }] }
    await deliver(await circleWrap(D1, circle('c1'), 'struct', JSON.stringify(await struct(D, 'config', 'c1', H, JSON.stringify(capture)))))
    expect(circle('c1').members.map((m) => m.pk)).toEqual([A.pk])
    expect(circle('c1').configBy).toBe('')

    // Our identity's config (from A1) sets the roster.
    for (const w of configWraps) await deliver(w)
    expect(circle('c1').members.map((m) => m.pk).sort()).toEqual([A.pk, B.pk, C.pk, D.pk, E.pk].sort())
    expect(circle('c1').configBy).toBe(A.pk)
    expect(circle('c1').members.find((m) => m.pk === D.pk)?.role).toBe('guardian')
    expect(circle('c1').members.find((m) => m.pk === A.pk)?.role).toBe('guardian')

    // Afterwards A3 hears the other members: D's buffered statement bound,
    // B's statement and traffic accepted.
    expect(memberForPhone('c1', D1.pk)).toBe(D.pk)
    await deliver(await circleWrap(B1, circle('c1'), 'device', JSON.stringify(await statement(B, B1))))
    await deliver(await circleWrap(B1, circle('c1'), 'x-test', 'hello'))
    await deliver(await circleWrap(D1, circle('c1'), 'x-test', 'hi'))
    expect(received.filter((r) => r.t === 'x-test').map((r) => r.sender?.memberPk)).toEqual([B.pk, D.pk])
  })

  it('re-inviting another member also sends our identity\'s config, keeping the config clock', async () => {
    const before = circle('c1').configUpdatedAt
    expect(resendInvite('c1', B.pk)).toBeNull()
    await queue.drain()
    const cfgItems = published().filter((w) => w.to === deriveInbox(SEED).pk)
    expect(cfgItems).toHaveLength(1)
    const signedCfg = signedContents.map((c) => { try { return JSON.parse(c) as { by?: string; updatedAt?: number } } catch { return {} } })
      .filter((o) => typeof o.updatedAt === 'number')
    expect(signedCfg).toHaveLength(1)
    expect(signedCfg[0].by).toBe(A.pk)
    expect(signedCfg[0].updatedAt).toBe(before)
  })

  it('a config dated more than 600 s ahead is refused on receipt; one inside the bound is applied', async () => {
    const members = circle('c1').members
    const far = { v: 2, createdBy: A.pk, vouches: [] as SignedEvent[], id: 'c1', name: 'Circle c1', updatedAt: nowSec() + 700, by: B.pk, members: members.filter((m) => m.pk !== E.pk) }
    await deliver(await circleWrap(B1, circle('c1'), 'struct', JSON.stringify(await struct(B, 'config', 'c1', H, JSON.stringify(far)))))
    expect(circle('c1').members.map((m) => m.pk)).toContain(E.pk)
    const near = { ...far, updatedAt: nowSec() + 500 }
    await deliver(await circleWrap(B1, circle('c1'), 'struct', JSON.stringify(await struct(B, 'config', 'c1', H, JSON.stringify(near)))))
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(E.pk)
  })
})

describe('final fix round 2, R2: competing re-keys on one prev — a removed signer is disqualified, mutual removal goes to the lowest identity pubkey', () => {
  const H = seedHash(SEED)

  it('A removes D; D grinds a lower id and removes A inside the window — A\'s re-key wins on every device (A\'s identity pubkey is lower than D\'s)', async () => {
    void sendRekey(circle('c1'), [D.pk])
    await queue.drain()
    const rA = lastOwnRekeyIdForTests('c1')!
    const aSeedFor = (phone: Key) => published().find((x) => x.to === personalInboxTag(phone.pk))!.wrap
    const toB = aSeedFor(B1)
    const toC = aSeedFor(C1)
    const dRekey = await rekeyWhere(D, H, (id) => id < rA, [A.pk])

    // A (the remover): D's arrives inside our own window.
    await onPhoneInboxWrap(await phoneWrap(D1, A1, dRekey))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    const aSeed = circle('c1').seedHex
    expect(aSeed).not.toBe(seedOf(dRekey))
    expect(store.load().lastRekey.c1!.id).toBe(rA)
    expect(circle('c1').members.map((m) => m.pk)).toContain(A.pk)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(D.pk)

    // B: D's first, then A's, both inside the window.
    await device(B, B1)
    await onPhoneInboxWrap(await phoneWrap(D1, B1, dRekey))
    await onPhoneInboxWrap(toB)
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(aSeed)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(D.pk)

    // C: A's first, D's late (after the window) — still A's.
    await device(C, C1)
    await onPhoneInboxWrap(toC)
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    await onPhoneInboxWrap(await phoneWrap(D1, C1, dRekey))
    expect(circle('c1').seedHex).toBe(aSeed)
  })

  it('D alone with a lower id and no removal of A still loses to A\'s removal of D', async () => {
    void sendRekey(circle('c1'), [D.pk])
    await queue.drain()
    const rA = lastOwnRekeyIdForTests('c1')!
    const toB = published().find((x) => x.to === personalInboxTag(B1.pk))!.wrap
    const dRekey = await rekeyWhere(D, H, (id) => id < rA)

    await onPhoneInboxWrap(await phoneWrap(D1, A1, dRekey))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(store.load().lastRekey.c1!.id).toBe(rA)
    const aSeed = circle('c1').seedHex

    await device(B, B1)
    await onPhoneInboxWrap(await phoneWrap(D1, B1, dRekey))
    await onPhoneInboxWrap(toB)
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(aSeed)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(D.pk)
  })

  it('mutual removal between two non-creator guardians goes to the lower identity pubkey, whatever the event ids', async () => {
    // B's identity pubkey is lower than D's (pinned in fixture setup above).
    const rB = await rekeyWhere(B, H, (id) => id > '8', [D.pk])
    const rD = await rekeyWhere(D, H, (id) => id < rB.id, [B.pk])
    await onPhoneInboxWrap(await phoneWrap(D1, A1, rD))
    await onPhoneInboxWrap(await phoneWrap(B1, A1, rB))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(seedOf(rB))
  })

  it('roster order and identity-pubkey order disagree: the pubkey rule wins, not roster seniority', async () => {
    // G is added to the roster last (least senior), but its identity pubkey
    // is pinned below A's — the roster creator and most senior member.
    const G = keyWhere((pk) => pk < A.pk)
    const G1 = key()
    const c = circle('c1')
    const withG = { v: 2, createdBy: A.pk, vouches: [await vouchEvent(A, G.pk, 'guardian')], id: 'c1', name: c.name, updatedAt: 999_999, by: A.pk, members: [...c.members, { pk: G.pk, role: 'guardian' as Role }] }
    await deliver(await circleWrap(B1, c, 'struct', JSON.stringify(await struct(A, 'config', 'c1', H, JSON.stringify(withG)))))
    expect(acceptStatement(circle('c1'), await statement(G, G1), G1.pk, nowSec())).toBe('added')

    void sendRekey(circle('c1'), [G.pk]) // A (roster's most senior) removes G
    await queue.drain()
    const gRekey = await rekeyWhere(G, H, () => true, [A.pk]) // G removes A back — mutual removal
    await onPhoneInboxWrap(await phoneWrap(G1, A1, gRekey))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(seedOf(gRekey))
    expect(circle('c1').members.map((m) => m.pk)).toContain(G.pk)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(A.pk)
  })

  it('final fix round 4: a genuine mutual removal arriving within the grace (REKEY_WINDOW_MS of being applied) converges on the lower identity pubkey', async () => {
    // B's identity pubkey is lower than D's (pinned in fixture setup above).
    const rB = await rekeyWhere(B, H, () => true, [D.pk])
    const rD = await rekeyWhere(D, H, () => true, [B.pk])

    // A: both inside the window — B's.
    await onPhoneInboxWrap(await phoneWrap(D1, A1, rD))
    await onPhoneInboxWrap(await phoneWrap(B1, A1, rB))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(seedOf(rB))

    // C: D's applied first, B's late but within the grace — B's replaces it.
    await device(C, C1)
    await onPhoneInboxWrap(await phoneWrap(D1, C1, rD))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(seedOf(rD))
    store.update((p) => { p.lastRekey.c1!.appliedAt -= REKEY_WINDOW_MS - 2000 })
    await onPhoneInboxWrap(await phoneWrap(B1, C1, rB))
    expect(circle('c1').seedHex).toBe(seedOf(rB))
    expect(circle('c1').members.map((m) => m.pk)).toContain(B.pk)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(D.pk)

    // E: B's applied first, D's late — B's stands.
    await device(E, E1)
    await onPhoneInboxWrap(await phoneWrap(B1, E1, rB))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    await onPhoneInboxWrap(await phoneWrap(D1, E1, rD))
    expect(circle('c1').seedHex).toBe(seedOf(rB))
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(D.pk)
  })

  it('final fix round 4: a removed guardian with a lower pubkey cannot overturn its removal by retaliating after the grace — refused on every device', async () => {
    // D removes B (B was not removing D). B's identity pubkey is lower than
    // D's; B still holds the old seed and signs a re-key on the same prev
    // removing D, arriving after the grace. It must be refused everywhere.
    const rD = await rekeyWhere(D, H, () => true, [B.pk])
    const rB = await rekeyWhere(B, H, () => true, [D.pk])
    for (const [who, phone] of [[A, A1], [C, C1], [E, E1]] as const) {
      if (who !== A) await device(who, phone)
      await onPhoneInboxWrap(await phoneWrap(D1, phone, rD))
      await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
      expect(circle('c1').seedHex).toBe(seedOf(rD))
      store.update((p) => { p.lastRekey.c1!.appliedAt -= REKEY_WINDOW_MS + 1000 })
      await onPhoneInboxWrap(await phoneWrap(B1, phone, rB))
      await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
      expect(circle('c1').seedHex).toBe(seedOf(rD))
      expect(circle('c1').members.map((m) => m.pk)).not.toContain(B.pk)
      expect(circle('c1').members.map((m) => m.pk)).toContain(D.pk)
    }
  })

  it('final fix round 3, F1: a late mutual removal is still bound by A1\'s time limit', async () => {
    const rB = await rekeyWhere(B, H, () => true, [D.pk])
    const rD = await rekeyWhere(D, H, () => true, [B.pk])
    await onPhoneInboxWrap(await phoneWrap(D1, A1, rD))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(seedOf(rD))
    store.update((p) => { p.lastRekey.c1!.appliedAt -= 10 * 60 * 1000 + 1000 })
    await onPhoneInboxWrap(await phoneWrap(B1, A1, rB))
    expect(circle('c1').seedHex).toBe(seedOf(rD))
  })

  it('the late path uses the same rule: a higher-id re-key removing the applied one\'s signer replaces it', async () => {
    const rB = await rekeyWhere(B, H, (id) => id < '8')
    const rD = await rekeyWhere(D, H, (id) => id > rB.id, [B.pk])
    // In-window: D's wins (B is removed by it, D is not).
    await onPhoneInboxWrap(await phoneWrap(B1, A1, rB))
    await onPhoneInboxWrap(await phoneWrap(D1, A1, rD))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(seedOf(rD))

    // Late: B's applied first, D's after the window — converges on D's.
    await device(C, C1)
    await onPhoneInboxWrap(await phoneWrap(B1, C1, rB))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(seedOf(rB))
    await onPhoneInboxWrap(await phoneWrap(D1, C1, rD))
    expect(circle('c1').seedHex).toBe(seedOf(rD))
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(B.pk)
  })
})

describe('plan 2, Task 5: the authority table on the receive path', () => {
  const H = seedHash(SEED)
  const F = key()
  const P = key() // a peer
  const P1 = key()
  const Q = key() // a peer P vouched for
  const Q1 = key()

  function v2(by: Key, members: Array<{ pk: string; role: Role }>, extra: Record<string, unknown> = {}): string {
    return JSON.stringify({ v: 2, id: 'c1', name: 'Circle c1', createdBy: A.pk, updatedAt: nowSec(), by: by.pk, members, vouches: [], ...extra })
  }

  async function deliverStruct(from: Key, by: Key, action: StructuralAction, payload: string, prev = H): Promise<void> {
    await deliver(await circleWrap(from, circle('c1'), 'struct', JSON.stringify(await struct(by, action, 'c1', prev, payload))))
  }

  /** Adds peers P and Q (Q vouched by P) to c1 here, with their phones bound. */
  async function withPeers(): Promise<void> {
    store.update((p) => { p.circles = p.circles.map((c) => (c.id === 'c1' ? { ...c, members: [...c.members, { pk: P.pk, role: 'peer' }, { pk: Q.pk, role: 'peer' }] } : c)) })
    expect(storeVouch(verifyVouch(await vouchEvent(A, P.pk, 'peer'))!)).toBe(true)
    expect(storeVouch(verifyVouch(await vouchEvent(P, Q.pk, 'peer'))!)).toBe(true)
    expect(acceptStatement(circle('c1'), await statement(P, P1), P1.pk, nowSec())).toBe('added')
    expect(acceptStatement(circle('c1'), await statement(Q, Q1), Q1.pk, nowSec())).toBe('added')
  }

  it('Review Focus 1: a config arriving before its vouch is parked, then applied when the vouch arrives', async () => {
    const members = [...circle('c1').members, { pk: F.pk, role: 'peer' as Role }]
    await deliverStruct(B1, B, 'config', v2(B, members))
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(F.pk)
    await deliver(await circleWrap(D1, circle('c1'), 'vouch-post', JSON.stringify(await vouchEvent(D, F.pk, 'peer'))))
    expect(circle('c1').members.map((m) => m.pk)).toContain(F.pk)
    expect(voucherOf('c1', F.pk)).toBe(D.pk)
    expect(received.filter((r) => r.t === 'config')).toHaveLength(1)
  })

  it('a config listing a member with only a forged vouch is not applied', async () => {
    const members = [...circle('c1').members.filter((m) => m.pk !== E.pk), { pk: F.pk, role: 'peer' as Role }]
    await deliverStruct(B1, B, 'config', v2(B, members, { vouches: [await vouchEvent(X, F.pk, 'peer')] }))
    expect(circle('c1').members.map((m) => m.pk)).toContain(E.pk)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(F.pk)
  })

  it('config cannot overwrite a vouch: a carried vouch by someone else leaves voucherOf unchanged', async () => {
    expect(voucherOf('c1', C.pk)).toBe(A.pk)
    const members = circle('c1').members
    await deliverStruct(B1, B, 'config', v2(B, members, { vouches: [await vouchEvent(D, C.pk, 'child', 'c1', nowSec() + 5)] }))
    expect(circle('c1').configBy).toBe(B.pk) // applied…
    expect(voucherOf('c1', C.pk)).toBe(A.pk) // …but the vouch stands
  })

  it('a vouch posted for a non-member by a non-member is dropped; by a member it is stored as pending', async () => {
    await deliver(await circleWrap(D1, circle('c1'), 'vouch-post', JSON.stringify(await vouchEvent(X, F.pk, 'peer'))))
    expect(pendingVouchesFor('c1', F.pk)).toEqual([])
    await deliver(await circleWrap(D1, circle('c1'), 'vouch-post', JSON.stringify(await vouchEvent(D, F.pk, 'peer'))))
    expect(pendingVouchesFor('c1', F.pk).map((v) => v.by)).toEqual([D.pk])
    expect(vouchFor('c1', F.pk)).toBeNull()
  })

  it('an invite arriving as a structural event in the circle is stored as a (pending) vouch', async () => {
    await deliver(await circleWrap(B1, circle('c1'), 'struct', JSON.stringify(await vouchEvent(B, F.pk, 'guardian'))))
    expect(pendingVouchesFor('c1', F.pk).map((v) => v.by)).toEqual([B.pk])
  })

  it('a re-key removing someone the signer may not remove is dropped (a dependant removing another)', async () => {
    await onPhoneInboxWrap(await phoneWrap(C1, A1, await struct(C, 'rekey', 'c1', H, rekeyPayload(hex('4'), H, [E.pk]))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(SEED)
  })

  it('a dependant\'s re-key removing no one (revocation, recovery) is applied', async () => {
    await onPhoneInboxWrap(await phoneWrap(C1, A1, await struct(C, 'rekey', 'c1', H, rekeyPayload(hex('4'), H))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(hex('4'))
  })

  it('a peer voucher\'s re-key removing their vouchee is applied; a peer who is not their voucher is refused', async () => {
    await withPeers()
    const to = (removed: Key[]): string[] => [...PHONES.map(([, ph]) => ph), P1, Q1].filter((ph) => !removed.includes(ph)).map((k) => k.pk)
    // Q (not P's voucher) removing P: refused.
    await onPhoneInboxWrap(await phoneWrap(Q1, A1, await struct(Q, 'rekey', 'c1', H, rekeyPayload(hex('4'), H, [P.pk], to([P1])))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(SEED)
    // P (Q's voucher) removing Q: applied.
    await onPhoneInboxWrap(await phoneWrap(P1, A1, await struct(P, 'rekey', 'c1', H, rekeyPayload(hex('5'), H, [Q.pk], to([Q1])))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(hex('5'))
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(Q.pk)
  })

  it('removeMemberFromCircle: a peer may remove its vouchee, not another member', async () => {
    await withPeers()
    sessionForTests({ identityPk: P.pk, phoneSkHex: P1.sk, statement: await statement(P, P1), transport: localTransport(P) })
    await removeMemberFromCircle('c1', B.pk)
    expect(queue.pending().filter((q) => q.action === 'rekey')).toHaveLength(0)
    await removeMemberFromCircle('c1', Q.pk)
    const item = queue.pending().find((q) => q.action === 'rekey')
    expect(JSON.parse(item!.payload).removals).toEqual([Q.pk])
  })

  it('a leave config fires onMemberLeft and unvouches the leaver\'s vouchees; a hand-over vouch then keeps them vouched', async () => {
    const left: Array<[string, string]> = []
    const off = onMemberLeft((circleId, pk) => { left.push([circleId, pk]) })
    await deliver(await circleWrap(A2, circle('c1'), 'device', JSON.stringify(await statement(A, A2))))
    await device(B, B1)
    await deliverStruct(A2, A, 'config', v2(A, circle('c1').members.filter((m) => m.pk !== A.pk)))
    off()
    expect(left).toEqual([['c1', A.pk]])
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(A.pk)
    for (const pk of [C.pk, D.pk, E.pk]) expect(unvouchedSince('c1', pk)).not.toBeNull()
    expect(store.load().activity.some((a) => a.kind === 'member-left' && a.actorPk === A.pk)).toBe(true)
    // D hands over its vouch for C (D is linked to C).
    await deliverStruct(D1, D, 'vouch', JSON.stringify({ pk: C.pk }))
    // Final fix N1: the original voucher stays C's voucher.
    expect(voucherOf('c1', C.pk)).toBe(A.pk)
    expect(unvouchedSince('c1', C.pk)).toBeNull()
  })

  it('a hand-over vouch for a member whose voucher is still a member is ignored', async () => {
    await deliverStruct(D1, D, 'vouch', JSON.stringify({ pk: C.pk }))
    expect(voucherOf('c1', C.pk)).toBe(A.pk)
  })

  it('a re-key removing a voucher unvouches their vouchees who stay', async () => {
    await device(B, B1)
    await onPhoneInboxWrap(await phoneWrap(D1, B1, await struct(D, 'rekey', 'c1', H, rekeyPayload(hex('4'), H, [A.pk]))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(A.pk)
    expect(unvouchedSince('c1', B.pk)).not.toBeNull()
    expect(unvouchedSince('c1', C.pk)).not.toBeNull()
  })

  it('an unvouched member can be re-keyed out by anyone after 71 h, not before', async () => {
    await withPeers()
    markUnvouched('c1', B.pk, nowSec() - (UNVOUCHED_GRACE_SEC - 3600) + 60)
    await onPhoneInboxWrap(await phoneWrap(Q1, A1, await struct(Q, 'rekey', 'c1', H, rekeyPayload(hex('4'), H, [B.pk]))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(SEED)
    store.update((p) => { p.unvouchedSince = { c1: { [B.pk]: nowSec() - (UNVOUCHED_GRACE_SEC - 3600) } } })
    await onPhoneInboxWrap(await phoneWrap(Q1, A1, await struct(Q, 'rekey', 'c1', H, rekeyPayload(hex('5'), H, [B.pk]))))
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').seedHex).toBe(hex('5'))
  })

  it('leaveCircle sends a config removing only us, then deletes the circle here', async () => {
    await leaveCircle('c2')
    const sent = published().filter((w) => w.to === deriveInbox(hex('3')).pk)
    expect(sent).toHaveLength(1)
    const cfg = JSON.parse(signedContents.at(-1)!) as { v: number; by: string; members: Array<{ pk: string }> }
    expect(cfg).toMatchObject({ v: 2, by: A.pk, members: [{ pk: B.pk, role: 'guardian' }] })
    expect(store.load().circles.map((c) => c.id)).toEqual(['c1'])
    expect(store.load().seedHashes.c2).toBeUndefined()
    expect(store.load().phoneKeys.c2).toBeUndefined()
    expect(store.load().vouches.c2).toBeUndefined()
    expect(store.load().activity.some((a) => a.kind === 'member-left' && a.circleId === 'c2')).toBe(true)
    // B's device applies it.
    await device(B, B1)
    for (const w of sent) await deliver(w.wrap, 'c2')
    expect(circle('c2').members.map((m) => m.pk)).toEqual([B.pk])
  })

  it('the config this device writes is v2 with the creator and every vouch on the roster', async () => {
    await removeMemberFromCircle('c1', C.pk) // no config — a re-key
    knowContacts(F.pk)
    await inviteToCircle('c1', F.pk)
    await queue.drain()
    const cfg = signedContents.map((c) => { try { return JSON.parse(c) as { v?: number; createdBy?: string; vouches?: SignedEvent[] } } catch { return {} } }).find((o) => o.v === 2)
    expect(cfg?.createdBy).toBe(A.pk)
    // Task 6: the invite is F's vouch, stored on the local add.
    expect(cfg?.vouches?.map((ev) => verifyVouch(ev)?.pk).sort()).toEqual([B.pk, C.pk, D.pk, E.pk, F.pk].sort())
  })

  it('Task 6 ruling: a dependant\'s invite works end to end — members apply the add, the invitee accepts', async () => {
    await device(C, C1)
    sessionForTests({ identityPk: C.pk, phoneSkHex: C1.sk, dependant: true, statement: await statement(C, C1), transport: localTransport(C) })
    knowContacts(F.pk)
    await inviteToCircle('c1', F.pk)
    await queue.drain()
    expect(circle('c1').members.find((m) => m.pk === F.pk)?.role).toBe('peer')
    expect(voucherOf('c1', F.pk)).toBe(C.pk)
    const toF = published().find((w) => w.to === personalInboxTag(F.pk))?.wrap
    const onInbox = published().filter((w) => w.to === deriveInbox(SEED).pk).map((w) => w.wrap)
    expect(toF).toBeDefined()
    expect(onInbox).toHaveLength(2)

    // B applies the dependant's add-config.
    await device(B, B1)
    for (const w of onInbox) await deliver(w)
    expect(circle('c1').members.find((m) => m.pk === F.pk)?.role).toBe('peer')
    expect(voucherOf('c1', F.pk)).toBe(C.pk)

    // F, a fresh device that knows C, accepts.
    const F1 = key()
    vi.stubGlobal('localStorage', fakeLocalStorage())
    resetReceiveForTests()
    queue.resetForTests()
    sessionForTests({ identityPk: F.pk, phoneSkHex: F1.sk, statement: await statement(F, F1), transport: localTransport(F) })
    knowContacts(C.pk)
    await onPersonalInboxWrap(identitySigner(), toF!)
    circlesHandleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)
    expect(circle('c1').members.map((m) => m.pk)).toEqual(expect.arrayContaining([C.pk, F.pk]))
    expect(voucherOf('c1', F.pk)).toBe(C.pk)
  })

  it('Task 6 ruling 3: the invite bundle carries the latest applied re-key', async () => {
    void sendRekey(circle('c1'), [E.pk])
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    const applied = store.load().lastRekey.c1
    expect(applied?.event?.id).toBe(applied?.id)
    vi.mocked(publishSigned).mockClear()
    knowContacts(F.pk)
    await inviteToCircle('c1', F.pk)
    await queue.drain()
    const wrap = published().find((w) => w.to === personalInboxTag(F.pk))!.wrap
    const rumor = await giftUnwrap((pk, ct) => makeLocalSigner(F.sk).nip44Decrypt(pk, ct), wrap)
    const bundle = JSON.parse(rumor!.content) as { rekey: SignedEvent | null }
    expect(bundle.rekey?.id).toBe(applied!.id)
  })

  /** A fresh device for `who` (new storage, phone key and session) that
   *  knows `contact`, taking `wrap` from its personal inbox and accepting. */
  async function acceptOnFreshDevice(who: Key, contact: Key, wrap: SignedEvent): Promise<void> {
    const phone = key()
    vi.stubGlobal('localStorage', fakeLocalStorage())
    resetReceiveForTests()
    queue.resetForTests()
    sessionForTests({ identityPk: who.pk, phoneSkHex: phone.sk, statement: await statement(who, phone), transport: localTransport(who) })
    knowContacts(contact.pk)
    await onPersonalInboxWrap(identitySigner(), wrap)
    circlesHandleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)
  }

  it('Task 6 fix round 1 (I1): a re-admitted member\'s invite, with a re-key held from before the cut-off, is accepted', async () => {
    void sendRekey(circle('c1'), [E.pk])
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(store.load().lastRekey.c1?.event).toBeDefined()
    // Cut off from a later re-key, then re-admitted by invite on a newer seed.
    store.update((p) => { saveJoinedCircle(p, { ...circle('c1'), seedHex: hex('9') }) })
    vi.mocked(publishSigned).mockClear()
    knowContacts(F.pk)
    await inviteToCircle('c1', F.pk)
    await queue.drain()
    const toF = published().find((w) => w.to === personalInboxTag(F.pk))!.wrap
    await acceptOnFreshDevice(F, A, toF)
    expect(store.load().circles.find((c) => c.id === 'c1')?.seedHex).toBe(hex('9'))
  })

  it('Task 6 fix round 1 (I2): a member removed by re-key stays off a second-hop joiner\'s roster', async () => {
    // An earlier invite leaves A holding a config that lists B and D.
    const H = key()
    knowContacts(H.pk)
    await inviteToCircle('c1', H.pk)
    await queue.drain()
    void sendRekey(circle('c1'), [D.pk])
    await queue.drain()
    await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(D.pk)
    // A re-invites B (a new device of B's): the bundle's config predates
    // the removal, its re-key carries it.
    vi.mocked(publishSigned).mockClear()
    knowContacts(B.pk)
    expect(resendInvite('c1', B.pk)).toBeNull()
    await queue.drain()
    await vi.advanceTimersByTimeAsync(0)
    const toB = published().find((w) => w.to === personalInboxTag(B.pk))!.wrap
    const bundle = JSON.parse((await giftUnwrap((pk, ct) => makeLocalSigner(B.sk).nip44Decrypt(pk, ct), toB))!.content) as { config: SignedEvent | null; rekey: SignedEvent | null }
    expect(bundle.config?.content).toContain(D.pk)
    expect(bundle.rekey).not.toBeNull()

    // B joins: D is off its roster.
    await acceptOnFreshDevice(B, A, toB)
    expect(circle('c1').members.map((m) => m.pk)).not.toContain(D.pk)

    // B invites G: G's roster lacks D too.
    const G = key()
    vi.mocked(publishSigned).mockClear()
    knowContacts(G.pk)
    await inviteToCircle('c1', G.pk)
    await queue.drain()
    const toG = published().find((w) => w.to === personalInboxTag(G.pk))!.wrap
    await acceptOnFreshDevice(G, B, toG)
    const roster = circle('c1').members.map((m) => m.pk)
    expect(roster).toEqual(expect.arrayContaining([A.pk, B.pk, G.pk]))
    expect(roster).not.toContain(D.pk)
  })

  it('Task 6: an invite reaches the other members as a vouch-post, then the config adds the invitee with its voucher', async () => {
    knowContacts(F.pk)
    await inviteToCircle('c1', F.pk)
    await queue.drain()
    const onInbox = published().filter((w) => w.to === deriveInbox(SEED).pk).map((w) => w.wrap)
    expect(onInbox).toHaveLength(2) // the vouch-post, then the config
    await device(B, B1)
    await deliver(onInbox[0]!)
    expect(pendingVouchesFor('c1', F.pk).map((v) => v.by)).toEqual([A.pk])
    await deliver(onInbox[1]!)
    expect(circle('c1').members.find((m) => m.pk === F.pk)?.role).toBe('peer')
    expect(voucherOf('c1', F.pk)).toBe(A.pk)
  })

  it('trustViewFor reads the current roster, creator, vouches and links', () => {
    const view = trustViewFor('c1')
    expect(view.members.map((m) => m.pk)).toContain(C.pk)
    expect(view.creator).toBe(A.pk)
    expect(view.voucherOf(D.pk)).toBe(A.pk)
    expect(view.linked(B.pk, C.pk)).toBe(true)
  })

  describe('fix round 1', () => {
    const vouchPost = async (phone: Key, by: Key, pk: string, role: Role): Promise<void> =>
      deliver(await circleWrap(phone, circle('c1'), 'vouch-post', JSON.stringify(await vouchEvent(by, pk, role))))
    const roster = (): string[] => circle('c1').members.map((m) => m.pk)

    it('C1: a creator is never taken from a received config, so a peer cannot plant one and add it as guardian', async () => {
      await withPeers()
      store.update((p) => { p.circleCreators = {} })
      await deliverStruct(P1, P, 'config', v2(P, circle('c1').members, { createdBy: X.pk }))
      expect(creatorOf('c1')).toBeNull()
      await deliverStruct(P1, P, 'config', v2(P, [...circle('c1').members, { pk: X.pk, role: 'guardian' }], { createdBy: X.pk, updatedAt: nowSec() + 1 }))
      expect(roster()).not.toContain(X.pk)
      // Nor does an honest config naming the real creator set it.
      await deliverStruct(B1, B, 'config', v2(B, circle('c1').members, { updatedAt: nowSec() + 2 }))
      expect(creatorOf('c1')).toBeNull()
    })

    it('C1: a removed creator re-added by a peer without a vouch is not let back in', async () => {
      await withPeers()
      store.update((p) => { p.circles = p.circles.map((c) => (c.id === 'c1' ? { ...c, members: c.members.filter((m) => m.pk !== A.pk) } : c)) })
      expect(creatorOf('c1')).toBe(A.pk)
      await deliverStruct(P1, P, 'config', v2(P, [...circle('c1').members, { pk: A.pk, role: 'guardian' }]))
      expect(roster()).not.toContain(A.pk)
    })

    it('I4: a config with createdBy \'\' is accepted where a creator is held, a leave included', async () => {
      expect(creatorOf('c1')).toBe(A.pk)
      await deliverStruct(B1, B, 'config', v2(B, circle('c1').members, { createdBy: '', name: 'Renamed' }))
      expect(circle('c1').name).toBe('Renamed')
      await deliverStruct(B1, B, 'config', v2(B, circle('c1').members.filter((m) => m.pk !== B.pk), { createdBy: '', name: 'Renamed', updatedAt: nowSec() + 1 }))
      expect(roster()).not.toContain(B.pk)
      expect(creatorOf('c1')).toBe(A.pk)
    })

    it('I3: a bad pending vouch does not block a later valid one', async () => {
      await withPeers()
      // P, a peer, vouches F as a guardian: above its own role.
      await vouchPost(P1, P, F.pk, 'guardian')
      expect(vouchFor('c1', F.pk)).toBeNull() // non-members never go in the main table
      expect(pendingVouchesFor('c1', F.pk).map((v) => v.by)).toEqual([P.pk])
      const members = [...circle('c1').members, { pk: F.pk, role: 'guardian' as Role }]
      await deliverStruct(B1, B, 'config', v2(B, members, { vouches: [await vouchEvent(P, F.pk, 'guardian')] }))
      expect(roster()).not.toContain(F.pk)
      await vouchPost(D1, D, F.pk, 'guardian')
      expect(roster()).toContain(F.pk)
      expect(voucherOf('c1', F.pk)).toBe(D.pk)
      expect(pendingVouchesFor('c1', F.pk)).toEqual([])
    })

    it('I2: needs-vouch configs park separately, capped, and never evict an event waiting for a phone to bind', async () => {
      const B2 = key()
      await deliver(await circleWrap(B2, circle('c1'), 'struct', JSON.stringify(await struct(B, 'places', 'c1', H, '[]'))))
      const adds = Array.from({ length: 101 }, () => key())
      for (const n of adds) await deliverStruct(D1, D, 'config', v2(D, [...circle('c1').members, { pk: n.pk, role: 'peer' }]))
      expect(vouchParkSizeForTests('c1')).toBe(VOUCH_PARK_CAP)
      expect(VOUCH_PARK_CAP).toBe(20)
      await deliver(await circleWrap(B2, circle('c1'), 'device', JSON.stringify(await statement(B, B2))))
      expect(received.map((r) => r.t)).toContain('places')
      // The oldest were evicted; the newest are still waiting.
      await vouchPost(B1, B, adds[0]!.pk, 'peer')
      expect(roster()).not.toContain(adds[0]!.pk)
      await vouchPost(B1, B, adds[100]!.pk, 'peer')
      expect(roster()).toContain(adds[100]!.pk)
    }, 30_000)

    it('I2: a stored vouch re-judges only the parked configs that add its vouchee', async () => {
      const [F1, F2, F3, Y] = [key(), key(), key(), key()]
      for (const n of [F1, F2, F3]) await deliverStruct(D1, D, 'config', v2(D, [...circle('c1').members, { pk: n.pk, role: 'peer' }]))
      expect(vouchParkSizeForTests('c1')).toBe(3)
      const before = vouchParkRejudgesForTests()
      await vouchPost(B1, B, Y.pk, 'peer')
      expect(vouchParkRejudgesForTests()).toBe(before)
      await vouchPost(B1, B, F2.pk, 'peer')
      expect(vouchParkRejudgesForTests()).toBeGreaterThan(before)
      expect(roster()).toContain(F2.pk)
    })
  })

  describe('t:\'link\' posts', () => {
    let G: Key
    let K: Key
    let pair: { g: SignedEvent; d: SignedEvent }
    beforeEach(async () => {
      G = key()
      K = key()
      store.update((p) => { p.circles = p.circles.map((c) => (c.id === 'c1' ? { ...c, members: [...c.members, { pk: G.pk, role: 'guardian' }, { pk: K.pk, role: 'child' }] } : c)) })
      pair = await linkPair(G, K)
    })

    it('from an unbound phone: dropped', async () => {
      await deliver(await circleWrap(X1, circle('c1'), 'link', JSON.stringify(pair)))
      expect(linked(G.pk, K.pk)).toBe(false)
    })
    it('from a bound phone, both pks members: accepted; an unlink then breaks it', async () => {
      await deliver(await circleWrap(D1, circle('c1'), 'link', JSON.stringify(pair)))
      expect(linked(G.pk, K.pk)).toBe(true)
      const unlink = await makeLocalSigner(K.sk).signEvent(unlinkTemplate(G.pk, nowSec()))
      await deliver(await circleWrap(D1, circle('c1'), 'link', JSON.stringify({ unlink })))
      expect(linked(G.pk, K.pk)).toBe(false)
    })
    it('naming a non-member, or dated more than 600 s ahead: refused', async () => {
      const Y = key()
      await deliver(await circleWrap(D1, circle('c1'), 'link', JSON.stringify(await linkPair(G, Y))))
      expect(linked(G.pk, Y.pk)).toBe(false)
      await deliver(await circleWrap(D1, circle('c1'), 'link', JSON.stringify(await linkPair(G, K, nowSec() + 700))))
      expect(linked(G.pk, K.pk)).toBe(false)
    })
  })

  describe('final review A', () => {
    const roster = (): string[] => circle('c1').members.map((m) => m.pk)
    /** Applies, on this device (phone `to`), a re-key by `by` sealed by
     *  `phone` removing `removed`, signed at `at`. */
    async function rekeyOut(by: Key, phone: Key, to: Key, removed: Key[], seed: string, at = nowSec()): Promise<void> {
      const prev = seedHash(circle('c1').seedHex)
      await onPhoneInboxWrap(await phoneWrap(phone, to, await struct(by, 'rekey', 'c1', prev, rekeyPayload(seed, prev, removed.map((k) => k.pk)), at)))
      await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
    }

    it('review B minor 8: a second Remove before the re-key applies queues nothing more', async () => {
      await removeMemberFromCircle('c1', C.pk)
      await removeMemberFromCircle('c1', C.pk)
      expect(queue.pending().filter((q) => q.action === 'rekey')).toHaveLength(1)
    })

    it('review B minor 3: a NIP-55 package name that could inject intent extras is never put in the intent: URL', () => {
      const open = vi.fn()
      vi.stubGlobal('window', { open, addEventListener: () => {}, removeEventListener: () => {} })
      const session = currentSession()!
      const node = { dataset: { circle: 'c1' } } as unknown as HTMLElement
      ;(session as { transport: unknown }).transport = { kind: 'nip55', packageName: 'app.signer;S.browser_fallback_url=https://evil' }
      circlesHandleAction('circle-meet-in-person', node)
      expect(open).not.toHaveBeenCalled()
      ;(session as { transport: unknown }).transport = { kind: 'nip55', packageName: 'app.example.signer' }
      circlesHandleAction('circle-meet-in-person', node)
      expect(open).toHaveBeenCalledWith('intent:#Intent;package=app.example.signer;end', '_blank')
    })

    it('I1: a peer cannot re-admit a removed guardian with the vouch from before the removal', async () => {
      await withPeers()
      store.update((p) => { p.circles = p.circles.map((c) => (c.id === 'c1' ? { ...c, members: [...c.members, { pk: F.pk, role: 'guardian' }] } : c)) })
      expect(storeVouch(verifyVouch(await vouchEvent(B, F.pk, 'guardian', 'c1', nowSec() - 100))!)).toBe(true)
      await rekeyOut(B, B1, A1, [F], hex('4'), nowSec() - 10)
      expect(roster()).not.toContain(F.pk)
      expect(vouchFor('c1', F.pk)).toBeNull() // dropped with the member
      const H4 = seedHash(hex('4'))
      await deliverStruct(P1, P, 'config', v2(P, [...circle('c1').members, { pk: F.pk, role: 'guardian' }], { vouches: [await vouchEvent(B, F.pk, 'guardian', 'c1', nowSec() - 100)] }), H4)
      expect(roster()).not.toContain(F.pk)
      // A fresh invite dated after the removal does re-admit.
      await deliverStruct(P1, P, 'config', v2(P, [...circle('c1').members, { pk: F.pk, role: 'guardian' }], { updatedAt: nowSec() + 1, vouches: [await vouchEvent(B, F.pk, 'guardian', 'c1', nowSec())] }), H4)
      expect(roster()).toContain(F.pk)
    })

    it('I1: an addition needs an invite vouch — a hand-over vouch (no role) does not add anyone', async () => {
      const handOver = await struct(D, 'vouch', 'c1', H, JSON.stringify({ pk: F.pk }))
      await deliverStruct(B1, B, 'config', v2(B, [...circle('c1').members, { pk: F.pk, role: 'peer' }], { vouches: [handOver] }))
      expect(roster()).not.toContain(F.pk)
    })

    it('I2: a joiner tombstones the bundle re-key\'s removals, and its own re-key carries them on', async () => {
      const Hk = key()
      knowContacts(Hk.pk)
      await inviteToCircle('c1', Hk.pk) // leaves A holding a config that lists D
      await queue.drain()
      void sendRekey(circle('c1'), [D.pk])
      await queue.drain()
      await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
      const r1 = store.load().lastRekey.c1!
      vi.mocked(publishSigned).mockClear()
      knowContacts(B.pk)
      expect(resendInvite('c1', B.pk)).toBeNull()
      await queue.drain()
      await vi.advanceTimersByTimeAsync(0)
      const toB = published().find((w) => w.to === personalInboxTag(B.pk))!.wrap
      await acceptOnFreshDevice(B, A, toB)
      expect(circle('c1').removedPks).toContain(D.pk)
      expect(circle('c1').removals?.[D.pk]).toEqual({ at: r1.createdAt, hash: seedHash(circle('c1').seedHex) })
      // B's own empty (revocation) re-key still names D.
      await sendRekey(circle('c1'), [])
      const item = queue.pending().find((q) => q.action === 'rekey')!
      expect(JSON.parse(item.payload).removals).toContain(D.pk)
    })

    it('I2: sendRekey unions the held re-keys\' removals, minus anyone back on the roster', async () => {
      const held = await struct(B, 'rekey', 'c1', H, rekeyPayload(hex('7'), H, [F.pk, C.pk]))
      store.update((p) => { p.heldRekeys = { c1: held } })
      await sendRekey(circle('c1'), [E.pk])
      const item = queue.pending().find((q) => q.action === 'rekey')!
      expect(JSON.parse(item.payload).removals).toEqual([E.pk, F.pk].sort())
    })

    /** A's leave config (signed at `at`), and hand-overs for C signed at a given time. */
    async function leaveOfA(at: number): Promise<SignedEvent> {
      const payload = v2(A, circle('c1').members.filter((m) => m.pk !== A.pk))
      return circleWrap(A1, circle('c1'), 'struct', JSON.stringify(await struct(A, 'config', 'c1', H, payload, at)))
    }
    async function handOverOfC(by: Key, phone: Key, at: number): Promise<SignedEvent> {
      return circleWrap(phone, circle('c1'), 'struct', JSON.stringify(await struct(by, 'vouch', 'c1', H, JSON.stringify({ pk: C.pk }), at)))
    }

    it('I4/N1: whatever the hand-overs\' arrival order, the original vouch stays and the member is vouched', async () => {
      const t = nowSec() - 100
      for (const order of [['B', 'D'], ['D', 'B']]) {
        await device(E, E1)
        await deliver(await leaveOfA(t))
        expect(unvouchedSince('c1', C.pk)).toBe(t)
        const wraps: Record<string, SignedEvent> = { B: await handOverOfC(B, B1, t + 20), D: await handOverOfC(D, D1, t + 10) }
        for (const k of order) await deliver(wraps[k]!)
        expect(voucherOf('c1', C.pk)).toBe(A.pk)
        expect(unvouchedSince('c1', C.pk)).toBeNull()
      }
    })

    it('N1: a hand-over dated no later than the member\'s original vouch counts for nothing', async () => {
      const t = nowSec() - 100
      await device(E, E1)
      await deliver(await leaveOfA(t))
      await deliver(await handOverOfC(D, D1, vouchFor('c1', C.pk)!.createdAt))
      expect(voucherOf('c1', C.pk)).toBe(A.pk)
      expect(unvouchedSince('c1', C.pk)).toBe(t)
    })

    it('I4/N1: a hand-over arriving before the voucher\'s leave is kept, and keeps the member vouched when the leave arrives', async () => {
      const t = nowSec() - 100
      await device(E, E1)
      await deliver(await handOverOfC(D, D1, t + 10))
      expect(voucherOf('c1', C.pk)).toBe(A.pk)
      await deliver(await leaveOfA(t))
      expect(voucherOf('c1', C.pk)).toBe(A.pk)
      expect(unvouchedSince('c1', C.pk)).toBeNull()
    })

    describe('final fix N1: a hand-over never grants removal authority, and whether a member is vouched does not depend on arrival order', () => {
      // Peer Q's original voucher is peer P (`withPeers`); peers R and S,
      // both added by A, hand Q over once P leaves. Neither R nor S may
      // ever remove Q through their hand-over.
      const R = key()
      const R1 = key()
      const S = key()
      const S1 = key()

      /** c1 plus peers P, Q, R, S, each added (a day ago) by A — Q by P. */
      async function n1Device(self: Key, phone: Key): Promise<void> {
        await device(self, phone)
        const added = nowSec() - 86_400
        store.update((p) => { p.circles = p.circles.map((c) => (c.id === 'c1' ? { ...c, members: [...c.members, ...[P, Q, R, S].map((k) => ({ pk: k.pk, role: 'peer' as Role }))] } : c)) })
        for (const [k, ph, by] of [[P, P1, A], [Q, Q1, P], [R, R1, A], [S, S1, A]] as const) {
          expect(storeVouch(verifyVouch(await vouchEvent(by, k.pk, 'peer', 'c1', added))!)).toBe(true)
          expect(acceptStatement(circle('c1'), await statement(k, ph), ph.pk, nowSec())).toBe('added')
        }
      }
      /** `who`'s leave config, signed (and dated) at `at`, from the roster held now. */
      async function leaveOf(who: Key, phone: Key, at: number): Promise<SignedEvent> {
        const payload = v2(who, circle('c1').members.filter((m) => m.pk !== who.pk), { updatedAt: at })
        return circleWrap(phone, circle('c1'), 'struct', JSON.stringify(await struct(who, 'config', 'c1', H, payload, at)))
      }
      async function handOverOfQ(by: Key, at: number): Promise<SignedEvent> {
        return struct(by, 'vouch', 'c1', H, JSON.stringify({ pk: Q.pk }), at)
      }
      async function wrapped(by: Key, phone: Key, at: number): Promise<SignedEvent> {
        return circleWrap(phone, circle('c1'), 'struct', JSON.stringify(await handOverOfQ(by, at)))
      }
      /** What this device decides about Q. */
      function verdict(): { R: boolean; S: boolean; voucher: string | null; unvouched: number | null } {
        const view = trustViewFor('c1')
        return { R: mayRemove(view, R.pk, Q.pk, nowSec()), S: mayRemove(view, S.pk, Q.pk, nowSec()), voucher: voucherOf('c1', Q.pk), unvouched: unvouchedSince('c1', Q.pk) }
      }

      it('(a) repeated hand-overs from one voucher, before or after the leave, give every device the same verdict', async () => {
        const t = nowSec() - 100
        const out: Array<ReturnType<typeof verdict>> = []
        for (const first of ['hand-overs', 'leave']) {
          await n1Device(D, D1)
          const hs = [await wrapped(R, R1, t + 10), await wrapped(R, R1, t + 30), await wrapped(S, S1, t + 20)]
          const leave = await leaveOf(P, P1, t)
          const order = first === 'leave' ? [leave, ...hs] : [...hs, leave]
          for (const w of order) await deliver(w)
          expect(roster()).not.toContain(P.pk)
          out.push(verdict())
        }
        expect(out[0]).toEqual({ R: false, S: false, voucher: P.pk, unvouched: null })
        expect(out[1]).toEqual(out[0])
      })

      it('(b) a first-round hand-over arriving after a second-round leave still counts', async () => {
        const t = nowSec() - 200
        const out: Array<ReturnType<typeof verdict>> = []
        for (const late of [false, true]) {
          await n1Device(D, D1)
          await deliver(await leaveOf(P, P1, t))
          expect(unvouchedSince('c1', Q.pk)).toBe(t)
          const fromS = await wrapped(S, S1, t + 10)
          if (!late) await deliver(fromS)
          await deliver(await wrapped(R, R1, t + 20))
          await deliver(await leaveOf(R, R1, t + 50))
          expect(roster()).not.toContain(R.pk)
          if (late) await deliver(fromS)
          out.push(verdict())
        }
        expect(out[0]).toEqual({ R: false, S: false, voucher: P.pk, unvouched: null })
        expect(out[1]).toEqual(out[0])
      })

      it('(b) with no hand-over by a current member left, every device marks the member unvouched from the same signed time', async () => {
        const t = nowSec() - 200
        const out: Array<ReturnType<typeof verdict>> = []
        for (const first of ['hand-over', 'leave']) {
          await n1Device(D, D1)
          const fromR = await wrapped(R, R1, t + 20)
          if (first === 'hand-over') await deliver(fromR)
          await deliver(await leaveOf(P, P1, t))
          if (first === 'leave') await deliver(fromR)
          expect(unvouchedSince('c1', Q.pk)).toBeNull()
          await deliver(await leaveOf(R, R1, t + 50))
          out.push(verdict())
        }
        expect(out[0]).toEqual({ R: false, S: false, voucher: P.pk, unvouched: t + 50 })
        expect(out[1]).toEqual(out[0])
      })

      it('(c) a joiner and an older member reach the same verdict, whichever hand-over the inviter held', async () => {
        const t = nowSec() - 100
        // The inviter holds only S's hand-over when F joins; R's earlier
        // one reaches both afterwards.
        await n1Device(B, B1)
        await deliver(await leaveOf(P, P1, t))
        await deliver(await wrapped(S, S1, t + 20))
        vi.mocked(publishSigned).mockClear()
        knowContacts(F.pk)
        await inviteToCircle('c1', F.pk)
        await queue.drain()
        const toF = published().find((w) => w.to === personalInboxTag(F.pk))!.wrap
        await acceptOnFreshDevice(F, B, toF)
        expect(roster()).toEqual(expect.arrayContaining([Q.pk, R.pk, S.pk]))
        acceptVouch('c1', await handOverOfQ(R, t + 10), nowSec())
        const joiner = verdict()
        await n1Device(B, B1)
        await deliver(await leaveOf(P, P1, t))
        await deliver(await wrapped(S, S1, t + 20))
        acceptVouch('c1', await handOverOfQ(R, t + 10), nowSec())
        const older = verdict()
        expect(older).toEqual({ R: false, S: false, voucher: P.pk, unvouched: null })
        expect(joiner).toEqual(older)
      })

      it('a hand-over grants no removal on the re-key receive path either: R\'s re-key removing Q is refused', async () => {
        await n1Device(D, D1)
        await deliver(await leaveOf(P, P1, nowSec() - 100))
        await deliver(await wrapped(R, R1, nowSec() - 50))
        expect(unvouchedSince('c1', Q.pk)).toBeNull()
        const rk = await struct(R, 'rekey', 'c1', H, rekeyPayload(hex('4'), H, [Q.pk]))
        expect(structuralAuthorised(trustViewFor('c1'), verifyStructural(rk)!, nowSec())).toBe(false)
        await onPhoneInboxWrap(await phoneWrap(R1, D1, rk))
        await vi.advanceTimersByTimeAsync(REKEY_WINDOW_MS)
        expect(roster()).toContain(Q.pk)
      })
    })

    it('I5: after a voucher leaves, a joiner keeps the members handed over and the inviter\'s invite stands', async () => {
      await device(B, B1)
      const at = nowSec() - 50
      const c1Vouches = (await trustFixture()).vouches.filter((ev) => verifyVouch(ev)?.circleId === 'c1')
      const payload = v2(A, circle('c1').members.filter((m) => m.pk !== A.pk), { vouches: c1Vouches })
      await deliver(await circleWrap(A1, circle('c1'), 'struct', JSON.stringify(await struct(A, 'config', 'c1', H, payload, at))))
      expect(roster()).not.toContain(A.pk)
      for (const pk of [B.pk, C.pk, E.pk]) await deliverStruct(D1, D, 'vouch', JSON.stringify({ pk }))
      expect(acceptVouch('c1', await struct(B, 'vouch', 'c1', H, JSON.stringify({ pk: D.pk })), nowSec())).toBe(true)
      for (const pk of [B.pk, C.pk, D.pk, E.pk]) expect(unvouchedSince('c1', pk)).toBeNull()
      vi.mocked(publishSigned).mockClear()
      knowContacts(F.pk)
      await inviteToCircle('c1', F.pk)
      await queue.drain()
      const toF = published().find((w) => w.to === personalInboxTag(F.pk))!.wrap
      await acceptOnFreshDevice(F, B, toF)
      const joined = store.load().circles.find((c) => c.id === 'c1')
      expect(joined?.members.map((m) => m.pk).sort()).toEqual([B.pk, C.pk, D.pk, E.pk, F.pk].sort())
    })

    it('I6: an unlink reaches a later joiner, in the bundle and re-posted on the add, so a pre-unlink pair cannot revive the link', async () => {
      const unlink = await makeLocalSigner(C.sk).signEvent(unlinkTemplate(B.pk, nowSec()))
      expect(acceptUnlink(unlink)).toBe(true)
      expect(linked(B.pk, C.pk)).toBe(false)
      const Hk = key()
      knowContacts(Hk.pk)
      await inviteToCircle('c1', Hk.pk) // leaves A holding a config
      await queue.drain()
      // The add re-posted the held unlink into the circle.
      const inbox = deriveInbox(SEED)
      const posted = await Promise.all(published().filter((w) => w.to === inbox.pk).map((w) => giftUnwrap((pk, ct) => Promise.resolve(nip44decrypt(ct, getConversationKey(inbox.sk, pk))), w.wrap)))
      expect(posted.filter((r) => r?.tags.some((t) => t[0] === 't' && t[1] === 'link')).map((r) => JSON.parse(r!.content).unlink?.id)).toEqual([unlink.id])
      vi.mocked(publishSigned).mockClear()
      knowContacts(F.pk)
      await inviteToCircle('c1', F.pk)
      await queue.drain()
      const toF = published().find((w) => w.to === personalInboxTag(F.pk))!.wrap
      await acceptOnFreshDevice(F, A, toF)
      expect(roster()).toEqual(expect.arrayContaining([B.pk, C.pk]))
      expect(linked(B.pk, C.pk)).toBe(false)
      const oldPair = (await trustFixture()).links[2]! // B–C, from before the unlink
      await deliver(await circleWrap(A1, circle('c1'), 'link', JSON.stringify(oldPair)))
      expect(linked(B.pk, C.pk)).toBe(false)
    })

    it('I3: the unvouched mark is the signed time of the leave config, not the receipt time', async () => {
      await device(B, B1)
      const at = nowSec() - UNVOUCHED_GRACE_SEC
      const payload = v2(A, circle('c1').members.filter((m) => m.pk !== A.pk))
      await deliver(await circleWrap(A1, circle('c1'), 'struct', JSON.stringify(await struct(A, 'config', 'c1', H, payload, at))))
      expect(roster()).not.toContain(A.pk)
      expect(unvouchedSince('c1', C.pk)).toBe(at)
    })

    it('I3: the unvouched mark is the signed time of the re-key removing the voucher', async () => {
      await device(B, B1)
      const at = nowSec() - UNVOUCHED_GRACE_SEC
      await rekeyOut(D, D1, B1, [A], hex('4'), at)
      expect(roster()).not.toContain(A.pk)
      expect(unvouchedSince('c1', C.pk)).toBe(at)
    })
  })
})

describe('plan 2, Task 7: a newly paired dependant reaches the co-members', () => {
  const H = seedHash(SEED)
  const N = key() // B's newly paired dependant
  const roster = (): string[] => circle('c1').members.map((m) => m.pk)
  const configAdding = async (): Promise<SignedEvent> => circleWrap(B1, circle('c1'), 'struct', JSON.stringify(await struct(B, 'config', 'c1', H, JSON.stringify({
    v: 2, id: 'c1', name: 'Circle c1', createdBy: A.pk, updatedAt: nowSec(), by: B.pk,
    members: [...circle('c1').members, { pk: N.pk, role: 'child' }], vouches: [],
  }))))

  it('vouch-post, then the add-config (parked: the link is not known yet), then the link: N joins and the link holds', async () => {
    await deliver(await circleWrap(B1, circle('c1'), 'vouch-post', JSON.stringify(await vouchEvent(B, N.pk, 'child'))))
    await deliver(await configAdding())
    expect(roster()).not.toContain(N.pk)
    await deliver(await circleWrap(B1, circle('c1'), 'link', JSON.stringify(await linkPair(B, N))))
    expect(linked(B.pk, N.pk)).toBe(true)
    expect(roster()).toContain(N.pk)
    expect(circle('c1').members.find((m) => m.pk === N.pk)?.role).toBe('child')
  })

  it('fix round 1: the link before the vouch-post is held, and applied once the vouch arrives', async () => {
    await deliver(await circleWrap(B1, circle('c1'), 'link', JSON.stringify(await linkPair(B, N))))
    expect(linked(B.pk, N.pk)).toBe(false)
    await deliver(await configAdding())
    expect(roster()).not.toContain(N.pk)
    await deliver(await circleWrap(B1, circle('c1'), 'vouch-post', JSON.stringify(await vouchEvent(B, N.pk, 'child'))))
    expect(linked(B.pk, N.pk)).toBe(true)
    expect(circle('c1').members.find((m) => m.pk === N.pk)?.role).toBe('child')
  })

  it('fix round 1: the link hold is capped per circle', async () => {
    const pairs = await Promise.all(Array.from({ length: LINK_HOLD_CAP + 1 }, async () => { const k = key(); return { k, pair: await linkPair(B, k) } }))
    for (const { pair } of pairs) await deliver(await circleWrap(B1, circle('c1'), 'link', JSON.stringify(pair)))
    expect(linkHoldSizeForTests('c1')).toBe(LINK_HOLD_CAP)
    // The oldest was dropped: its vouch no longer brings the link in.
    await deliver(await circleWrap(B1, circle('c1'), 'vouch-post', JSON.stringify(await vouchEvent(B, pairs[0]!.k.pk, 'child'))))
    expect(linked(B.pk, pairs[0]!.k.pk)).toBe(false)
    await deliver(await circleWrap(B1, circle('c1'), 'vouch-post', JSON.stringify(await vouchEvent(B, pairs[1]!.k.pk, 'child'))))
    expect(linked(B.pk, pairs[1]!.k.pk)).toBe(true)
  })

  it('a link for a non-member with no pending child vouch from that guardian is still refused', async () => {
    await deliver(await circleWrap(B1, circle('c1'), 'link', JSON.stringify(await linkPair(B, N))))
    expect(linked(B.pk, N.pk)).toBe(false)
    // A pending vouch by someone else (D) does not let B's pair in.
    await deliver(await circleWrap(D1, circle('c1'), 'vouch-post', JSON.stringify(await vouchEvent(D, N.pk, 'child'))))
    await deliver(await circleWrap(B1, circle('c1'), 'link', JSON.stringify(await linkPair(B, N))))
    expect(linked(B.pk, N.pk)).toBe(false)
    // Nor does B's vouch for N as a peer.
    await deliver(await circleWrap(B1, circle('c1'), 'vouch-post', JSON.stringify(await vouchEvent(B, N.pk, 'peer'))))
    await deliver(await circleWrap(B1, circle('c1'), 'link', JSON.stringify(await linkPair(B, N))))
    expect(linked(B.pk, N.pk)).toBe(false)
  })
})
