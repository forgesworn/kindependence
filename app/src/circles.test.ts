import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  roleFor,
  selfRole,
  addLocalMember,
  removeLocalMember,
  newCircleId,
  newCircle,
  saveNewCircle,
  saveJoinedCircle,
  createCircleNow,
  appRelays,
  inviteToCircle,
  removeMemberFromCircle,
  onPersonalInboxWrap,
  handleAction,
  view,
  ensure,
  decodePubkeyInput,
  inviteDependantToCircle,
  reinviteDependantEverywhere,
  onPhoneInboxWrap,
  personalInboxSigner,
  retryDeferredPersonalWraps,
  deferredPersonalWrapIdsForTests,
  resetDeferredPersonalWrapsForTests,
  setMinPassGapForTests,
  MIN_PASS_GAP_MS,
  MAX_WRAP_REFUSALS,
  DECRYPTS_PER_PASS,
  MAX_REFUSAL_RECORDS,
  inboxWaitingView,
  checkDeferredNow,
  CHECK_NOW_CAP,
} from './circles.js'
import * as beacons from './beacons.js'
import { acceptLinkPair, linked } from './guardian-links.js'
import { guardianOfTemplate, dependantOfTemplate } from './device-statements.js'
import * as store from './store.js'
import { seedHash, structuralTemplate } from './structural.js'
import { deviceStatementTemplate } from './device-statements.js'
import { sessionForTests, identitySigner, currentSession } from './session.js'
import { SignerUnavailable, SignerRejected, type SignerTransport, type SignerCallOpts } from './remote-signer.js'
import { fakeBunker } from './test-support/fake-bunker.js'
import { memberForPhone, acceptStatement } from './phone-keys.js'
import { creatorOf, vouchFor, verifyVouch, storeVouch, vouchPayload, setCreator } from './vouches.js'
import { hexToBytes } from '@noble/hashes/utils.js'
import * as structuralQueue from './structural-queue.js'
import { setContactsSource } from './contacts.js'
import { fakeContacts } from './test-support/fake-contacts.js'
import { makeLocalSigner, personalInboxTag, toHex } from '@forgesworn/covey-kit'
import type { Circle, CircleMember } from '@forgesworn/covey-kit'
import { publishSigned, subscribeGiftWraps, giftWrap } from '@forgesworn/roost-kit'
import type { Signer, SignedEvent } from '@forgesworn/roost-kit'
import { getConversationKey, encrypt as nip44encrypt, decrypt as nip44decrypt } from 'nostr-tools/nip44'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure'
import { npubEncode, nsecEncode } from 'nostr-tools/nip19'

// Moved from the now-deleted contacts.test.ts (Signet identity plan, Task
// 11) alongside decodePubkeyInput itself — see circles.ts's own doc comment
// on that function.
describe('decodePubkeyInput', () => {
  const dpiSk = generateSecretKey()
  const dpiPkHex = getPublicKey(dpiSk)

  it('accepts a raw 64-hex pubkey', () => {
    expect(decodePubkeyInput(dpiPkHex)).toBe(dpiPkHex)
  })

  it('accepts a raw 64-hex pubkey with surrounding whitespace', () => {
    expect(decodePubkeyInput(`  ${dpiPkHex}  `)).toBe(dpiPkHex)
  })

  it('lowercases an uppercase hex pubkey', () => {
    expect(decodePubkeyInput(dpiPkHex.toUpperCase())).toBe(dpiPkHex)
  })

  it('accepts a valid npub and decodes to the same hex', () => {
    const npub = npubEncode(dpiPkHex)
    expect(decodePubkeyInput(npub)).toBe(dpiPkHex)
  })

  it('accepts a pasted npub with surrounding whitespace', () => {
    const npub = npubEncode(dpiPkHex)
    expect(decodePubkeyInput(`  ${npub}  `)).toBe(dpiPkHex)
  })

  it('rejects an nsec (wrong NIP-19 type)', () => {
    const nsec = nsecEncode(dpiSk)
    expect(decodePubkeyInput(nsec)).toBeNull()
  })

  it('rejects garbage text', () => {
    expect(decodePubkeyInput('not a key')).toBeNull()
  })

  it('rejects short hex', () => {
    expect(decodePubkeyInput('abc123')).toBeNull()
  })

  it('rejects a malformed npub-looking string', () => {
    expect(decodePubkeyInput('npub1notarealkeyatall')).toBeNull()
  })

  it('rejects empty input', () => {
    expect(decodePubkeyInput('')).toBeNull()
  })
})

// `inviteToCircle`/`removeMemberFromCircle` do real (non-network) crypto via
// LocalSigner — only the relay publish actually leaves the process. Mocking
// just `publishSigned` exercises the real await-yielding shape of both
// functions (needed to reproduce/guard the concurrency bug below) without
// touching a network. `subscribeGiftWraps` is spied (not mocked away) so
// `ensure()`'s dependant-gating tests can assert on which tags it was called
// with, without actually opening a subscription against a real pool.
vi.mock('@forgesworn/roost-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgesworn/roost-kit')>()
  return { ...actual, publishSigned: vi.fn(async () => ({})), subscribeGiftWraps: vi.fn(actual.subscribeGiftWraps) }
})

// Every test signs out and drops any registered structural-queue senders at
// the end — both are module-level state (`sessionForTests`, `ensure()`'s
// `registerStructuralSenders`) that would otherwise leak into a later
// test/describe (e.g. a queued `config` broadcast picking up a sender
// registered by an earlier `ensure()` call and burning an unexpected
// remote sign).
afterEach(() => {
  sessionForTests(null)
  structuralQueue.resetForTests()
})

const PK_A = 'a'.repeat(64)
const PK_B = 'b'.repeat(64)
const PK_C = 'c'.repeat(64)

function fakePersisted(overrides: Partial<store.Persisted> = {}): store.Persisted {
  return {
    v: 1, circles: [], contacts: [], settings: {}, safetyEvents: [], agreements: [],
    familyPolicies: {}, approvals: [], activity: [], dmThreads: {}, dmLastSeen: {}, circleChats: {}, circleChatLastSeen: {},
    ...overrides,
  }
}

function fakeCircle(overrides: Partial<Circle> = {}): Circle {
  const creator: CircleMember = { pk: PK_A, role: 'guardian', name: 'Alex' }
  return {
    id: 'circle-1', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
    members: [creator], createdAt: 100, configUpdatedAt: 100, configBy: PK_A,
    ...overrides,
  }
}

/** A real, valid secp256k1 keypair (hex) — `inviteToCircle`/
 *  `removeMemberFromCircle`/`onPersonalInboxWrap` build real `LocalSigner`s
 *  from `skHex`, which need an actual valid scalar, not just any 64 hex
 *  chars. */
function realKeypair(): { skHex: string; pkHex: string } {
  const sk = generateSecretKey()
  return { skHex: toHex(sk), pkHex: getPublicKey(sk) }
}

/** Minimal in-memory localStorage stand-in (mirrors store.test.ts's). */
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

/** Builds a NIP-59 gift wrap sealed under `attackerSigner`'s OWN real key —
 *  a completely legitimate NIP-44 encrypt/decrypt (ECDH doesn't block a
 *  sender encrypting to a real recipient with their own real key) — but
 *  whose DECRYPTED inner rumor claims `forgedPubkey` as its author instead
 *  of the attacker's own. roost-kit's real `giftWrap` can never produce this
 *  (it always sets `rumor.pubkey = signer.pubkey`), so this replicates its
 *  wire format by hand for exactly the one forged field — reproducing the
 *  reviewer's confirmed attack shape (Phase 7 Task 1 fix wave, Fix 1). */
async function forgeSealedWrap(
  attackerSigner: Signer,
  recipientPk: string,
  forgedPubkey: string,
  inner: { kind: number; content: string; tags: string[][] },
): Promise<SignedEvent> {
  const at = Math.floor(Date.now() / 1000)
  const rumor = { pubkey: forgedPubkey, created_at: at, kind: inner.kind, tags: inner.tags, content: inner.content }
  const rumorWithId = { ...rumor, id: getEventHash(rumor) }
  const sealContent = await attackerSigner.nip44Encrypt(recipientPk, JSON.stringify(rumorWithId))
  const seal = await attackerSigner.signEvent({ kind: 13, content: sealContent, tags: [], created_at: at })
  const ephSk = generateSecretKey()
  const wrapContent = nip44encrypt(JSON.stringify(seal), getConversationKey(ephSk, recipientPk))
  return finalizeEvent({ kind: 1059, content: wrapContent, tags: [['p', recipientPk]], created_at: at }, ephSk) as SignedEvent
}

/** Builds a real, correctly-signed identity-signed `invite` structural event
 *  (structural.ts) plus the inviter's own device statement — the way
 *  `doInvite` produces them — by `finalizeEvent`-ing directly against a real
 *  keypair rather than going through a fake bunker, for tests that exercise
 *  the RECEIVE side only. Plan 2 (Task 6): the payload names its invitee
 *  (`to`) and role, and the inviter is made one of the receiver's usable
 *  contacts unless `stranger` is set. */
function buildInvite(opts: {
  to: string
  circleId: string
  seedHex: string
  name: string
  inviterSk: Uint8Array
  inviterPhonePk: string
  at?: number
  role?: 'guardian' | 'peer' | 'child'
  stranger?: boolean
}): { invite: SignedEvent; statement: SignedEvent } {
  const at = opts.at ?? Math.floor(Date.now() / 1000)
  const inner = { id: opts.circleId, name: opts.name, mode: 'family', pk: opts.to, role: opts.role ?? 'peer' }
  const template = structuralTemplate({
    action: 'invite', circleId: opts.circleId, prevSeedHash: seedHash(opts.seedHex), payload: JSON.stringify(inner), nowSec: at,
  })
  const invite = finalizeEvent(template, opts.inviterSk) as SignedEvent
  const statement = finalizeEvent(deviceStatementTemplate(opts.inviterPhonePk, at), opts.inviterSk) as SignedEvent
  seedByInvite.set(invite.id, opts.seedHex)
  if (!opts.stranger) knowContacts(getPublicKey(opts.inviterSk))
  return { invite, statement }
}

/** Final fix A3: the seed an invite built by `buildInvite` carries — it
 *  rides in the rumor beside the signed invite, never inside it. */
const seedByInvite = new Map<string, string>()

/** Gift-wraps an invite bundle to `recipientPk`'s personal inbox, sealed by
 *  `sealSkHex` — the inviter's PHONE key, never their identity key (see
 *  circles.ts's own `doInvite` doc comment). Plan 2 (Task 6): `extra`
 *  carries the bundle's `config` and `links`. */
async function wrapInvite(recipientPk: string, invite: SignedEvent, statement: SignedEvent, sealSkHex: string, seed?: string, extra: { config?: SignedEvent | null; links?: Array<{ g: SignedEvent; d: SignedEvent }>; rekey?: SignedEvent | null } = {}, tag?: string): Promise<SignedEvent> {
  const s = seed ?? seedByInvite.get(invite.id)
  return giftWrap(makeLocalSigner(sealSkHex), recipientPk, { kind: 14, content: JSON.stringify({ invite, statement, seed: s, config: extra.config ?? null, links: extra.links ?? [], rekey: extra.rekey ?? null }), tags: [] }, tag ?? personalInboxTag(recipientPk))
}

/** Plan 2 (Task 6): the contacts this device's grant reports — every pk
 *  given so far in the test is a `kin` contact. Reset before each test. */
const knownPks = new Set<string>()
function knowContacts(...pks: string[]): void {
  for (const pk of pks) knownPks.add(pk)
  setContactsSource(fakeContacts({
    status: 'connected',
    contacts: [...knownPks].map((pk, i) => ({ contactId: `k${i}`, pks: [pk], name: `Contact ${pk.slice(0, 4)}`, tier: 'kin' as const, blocked: false })),
  }))
}
beforeEach(() => {
  knownPks.clear()
  setContactsSource(null)
})

describe('roleFor', () => {
  it('maps a parent to guardian', () => {
    expect(roleFor('parent')).toBe('guardian')
  })
  it('maps a child to child', () => {
    expect(roleFor('child')).toBe('child')
  })
})

describe('selfRole', () => {
  it('finds the role of a known member', () => {
    const c = fakeCircle({ members: [{ pk: PK_A, role: 'guardian' }, { pk: PK_B, role: 'child' }] })
    expect(selfRole(c, PK_B)).toBe('child')
  })
  it('returns undefined for a pubkey not (yet) in the roster', () => {
    const c = fakeCircle()
    expect(selfRole(c, PK_C)).toBeUndefined()
  })
})

describe('addLocalMember', () => {
  it('adds the member via upsertMember and bumps configUpdatedAt/configBy', () => {
    const c = fakeCircle({ configUpdatedAt: 100, configBy: PK_A })
    const updated = addLocalMember(c, { pk: PK_B, role: 'guardian' }, PK_A, 999)
    expect(updated.members.some((m) => m.pk === PK_B)).toBe(true)
    expect(updated.configUpdatedAt).toBe(999)
    expect(updated.configBy).toBe(PK_A)
  })

  it('replaces an existing member with the same pk (upsert, not duplicate)', () => {
    const c = fakeCircle({ members: [{ pk: PK_A, role: 'guardian' }, { pk: PK_B, role: 'child' }] })
    const updated = addLocalMember(c, { pk: PK_B, role: 'guardian', name: 'Promoted' }, PK_A, 999)
    expect(updated.members).toHaveLength(2)
    expect(updated.members.find((m) => m.pk === PK_B)).toEqual({ pk: PK_B, role: 'guardian', name: 'Promoted' })
  })
})

describe('removeLocalMember', () => {
  it('removes the member via removeMember and bumps configUpdatedAt/configBy', () => {
    const c = fakeCircle({ members: [{ pk: PK_A, role: 'guardian' }, { pk: PK_B, role: 'child' }], configUpdatedAt: 100, configBy: PK_A })
    const updated = removeLocalMember(c, PK_B, PK_A, 999)
    expect(updated.members.some((m) => m.pk === PK_B)).toBe(false)
    expect(updated.configUpdatedAt).toBe(999)
    expect(updated.configBy).toBe(PK_A)
  })
})

describe('newCircleId', () => {
  it('generates a 16-hex-char circle id', () => {
    expect(newCircleId()).toMatch(/^[0-9a-f]{16}$/)
  })
  it('generates distinct values across calls', () => {
    expect(newCircleId()).not.toBe(newCircleId())
  })
})

describe('newCircle / saveNewCircle / saveJoinedCircle', () => {
  it('creates a circle at epoch 0 with a fresh random seed and only the creator as a member', () => {
    const { circle } = newCircle('My circle', { pk: PK_A, role: 'guardian', name: 'Alex' }, 500)
    expect(circle.name).toBe('My circle')
    expect(circle.epoch).toBe(0)
    expect(circle.members).toEqual([{ pk: PK_A, role: 'guardian', name: 'Alex' }])
    expect(circle.configUpdatedAt).toBe(500)
    expect(circle.configBy).toBe(PK_A)
    expect(circle.seedHex).toMatch(/^[0-9a-f]{64}$/)
    expect(newCircle('Other', { pk: PK_A, role: 'guardian' }, 500).circle.seedHex).not.toBe(circle.seedHex)
  })

  it('saveNewCircle appends the circle and starts its seed-hash chain, without touching other circles', () => {
    const existing = fakeCircle({ id: 'existing' })
    const p = fakePersisted({ circles: [existing], seedHashes: { existing: ['e'.repeat(64)] } })
    const { circle } = newCircle('New circle', { pk: PK_A, role: 'guardian' }, 500)
    saveNewCircle(p, circle)
    expect(p.circles).toEqual([existing, circle])
    expect(p.seedHashes.existing).toEqual(['e'.repeat(64)])
    expect(p.seedHashes[circle.id]).toEqual([seedHash(circle.seedHex)])
  })

  it('saveJoinedCircle starts the joined circle\'s seed-hash chain at its initial seed', () => {
    const p = fakePersisted()
    const joined = fakeCircle({ id: 'joined', seedHex: '7'.repeat(64) })
    saveJoinedCircle(p, joined)
    expect(p.circles).toEqual([joined])
    expect(p.seedHashes.joined).toEqual([seedHash('7'.repeat(64))])
  })
})

describe('createCircleNow — Task 12 fix round 2, finding 1c (security, root cause): binds our own phone immediately', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => {
    sessionForTests(null)
  })

  it('binds this device\'s own phone into the new circle\'s phone-key table synchronously, before any network post', async () => {
    const bunker = fakeBunker({})
    const selfPhone = realKeypair()
    const now = Math.floor(Date.now() / 1000)
    const statement = await bunker.signEvent(deviceStatementTemplate(selfPhone.pkHex, now))
    sessionForTests({ identityPk: bunker.pubkey, phoneSkHex: selfPhone.skHex, dependant: false, statement, transport: bunker })
    store.save(fakePersisted({ circles: [] }))

    createCircleNow('My new circle')

    const created = store.load().circles[0]
    expect(created).toBeDefined()
    expect(memberForPhone(created!.id, selfPhone.pkHex)).toBe(bunker.pubkey)
  })

  it('records this identity as the new circle\'s creator (plan 2, Task 5: config v2 carries it)', async () => {
    const bunker = fakeBunker({})
    const selfPhone = realKeypair()
    sessionForTests({ identityPk: bunker.pubkey, phoneSkHex: selfPhone.skHex, dependant: false, transport: bunker })
    store.save(fakePersisted({ circles: [] }))
    createCircleNow('Mine')
    expect(creatorOf(store.load().circles[0]!.id)).toBe(bunker.pubkey)
  })
})

describe('appRelays', () => {
  it('falls back to the three public default relays when settings has none', () => {
    expect(appRelays(fakePersisted())).toEqual([
      'wss://relay.damus.io',
      'wss://nos.lol',
      'wss://relay.primal.net',
    ])
  })

  it('returns a fresh array each call, so callers cannot mutate the defaults', () => {
    appRelays(fakePersisted()).push('wss://mutated.example')
    expect(appRelays(fakePersisted())).toHaveLength(3)
  })

  it('uses only the saved relay when set', () => {
    expect(appRelays(fakePersisted({ settings: { relayUrl: 'wss://example.relay' } }))).toEqual(['wss://example.relay'])
  })
})

describe('inviteToCircle — concurrent invites', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(publishSigned).mockClear()
    vi.mocked(publishSigned).mockResolvedValue({} as never)
  })

  it('two overlapping invites to different recipients BOTH land in the final roster', async () => {
    // Regression for a lost-update race: inviteToCircle snapshots `circle`
    // before its awaits (identitySigner().signEvent, giftWrap, publish). If
    // the member mutation is later computed from that stale snapshot and
    // blindly written back, two invites racing on the same circle silently
    // drop one another — the second store.update overwrites the first
    // invitee right out of the roster. The fix computes the mutation
    // against FRESH state read inside store.update()'s own callback, so
    // whichever commits last still builds on top of the other.
    const bunker = fakeBunker({})
    const selfPhone = realKeypair()
    const memberB = realKeypair()
    const memberC = realKeypair()
    const now = Math.floor(Date.now() / 1000)
    const statement = await bunker.signEvent(deviceStatementTemplate(selfPhone.pkHex, now))
    sessionForTests({ identityPk: bunker.pubkey, phoneSkHex: selfPhone.skHex, dependant: false, statement, transport: bunker })

    const circle = fakeCircle({
      id: 'race-circle',
      members: [{ pk: bunker.pubkey, role: 'guardian', name: 'Self' }],
    })
    store.save(fakePersisted({ circles: [circle] }))

    // Fire both invites WITHOUT awaiting the first — each runs its
    // synchronous prefix (store.load + checks) before either commits,
    // exactly the interleaving the bug depended on.
    knowContacts(memberB.pkHex, memberC.pkHex)
    const p1 = inviteToCircle('race-circle', memberB.pkHex)
    const p2 = inviteToCircle('race-circle', memberC.pkHex)
    await Promise.all([p1, p2])

    const finalCircle = store.load().circles.find((c) => c.id === 'race-circle')
    expect(finalCircle?.members.map((m) => m.pk).sort()).toEqual(
      [bunker.pubkey, memberB.pkHex, memberC.pkHex].sort(),
    )
  })
})

describe('onPersonalInboxWrap — seal-forgery and statement-binding rejection', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })

  describe('invite', () => {
    it('drops an invite sealed by an attacker whose rumor.pubkey is forged', async () => {
      const self = realKeypair()
      const attacker = realKeypair()
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
      store.save(fakePersisted({}))

      const attackerSigner = makeLocalSigner(attacker.skHex)
      const inviterSk = generateSecretKey()
      const inviterPhone = realKeypair()
      const { invite, statement } = buildInvite({ to: self.pkHex,
        circleId: 'forged-circle', seedHex: '2'.repeat(64), name: 'Evil Circle', inviterSk, inviterPhonePk: inviterPhone.pkHex,
      })
      const forgedWrap = await forgeSealedWrap(attackerSigner, self.pkHex, PK_B, {
        kind: 14, content: JSON.stringify({ invite, statement, seed: '2'.repeat(64) }), tags: [],
      })

      const recipientSigner = makeLocalSigner(self.skHex)
      await onPersonalInboxWrap(recipientSigner, forgedWrap)

      // No accept card — the forged wrap never even produced a rumor.
      expect(view(store.load())).not.toContain('Circle invite')
      expect(store.load().circles.some((c) => c.id === 'forged-circle')).toBe(false)
    })

    it('positive control: an honestly-sealed, identity-signed invite still surfaces the accept card', async () => {
      const self = realKeypair()
      const inviterSk = generateSecretKey()
      const inviterPhone = realKeypair()
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
      store.save(fakePersisted({}))

      const { invite, statement } = buildInvite({ to: self.pkHex,
        circleId: 'honest-circle', seedHex: '3'.repeat(64), name: 'Real Circle', inviterSk, inviterPhonePk: inviterPhone.pkHex,
      })
      const honestWrap = await wrapInvite(self.pkHex, invite, statement, inviterPhone.skHex)

      const recipientSigner = makeLocalSigner(self.skHex)
      await onPersonalInboxWrap(recipientSigner, honestWrap)

      expect(view(store.load())).toContain('Real Circle')

      // Clean up module-level pendingInvite so it doesn't leak into other tests.
      handleAction('circle-decline', { dataset: {} } as unknown as HTMLElement)
    })

    it('drops an invite whose seal signer is not the phone key the attached statement names', async () => {
      const self = realKeypair()
      const inviterSk = generateSecretKey()
      const inviterPhone = realKeypair()
      const wrongPhone = realKeypair() // seals the wrap, but isn't who the statement names
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
      store.save(fakePersisted({}))

      const { invite, statement } = buildInvite({ to: self.pkHex,
        circleId: 'mismatch-circle', seedHex: '6'.repeat(64), name: 'Mismatch Circle', inviterSk, inviterPhonePk: inviterPhone.pkHex,
      })
      const wrap = await wrapInvite(self.pkHex, invite, statement, wrongPhone.skHex)

      await onPersonalInboxWrap(makeLocalSigner(self.skHex), wrap)

      expect(view(store.load())).not.toContain('Mismatch Circle')
      expect(store.load().circles.some((c) => c.id === 'mismatch-circle')).toBe(false)
    })

    it('drops an invite whose attached statement claims a different identity than the one that signed the invite (Task 10 fix round 1, finding 3)', async () => {
      const self = realKeypair()
      const inviterSk = generateSecretKey() // the identity that actually signs the invite
      const attackerSk = generateSecretKey() // claims to be a DIFFERENT identity in the statement
      const inviterPhone = realKeypair()
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
      store.save(fakePersisted({}))

      const at = Math.floor(Date.now() / 1000)
      const inner = { id: 'impersonation-circle', name: 'Impersonation Circle', mode: 'family' }
      const template = structuralTemplate({
        action: 'invite', circleId: 'impersonation-circle', prevSeedHash: seedHash('9'.repeat(64)), payload: JSON.stringify(inner), nowSec: at,
      })
      const invite = finalizeEvent(template, inviterSk) as SignedEvent
      // Sealed by the real inviter's phone (so the seal-signer/statement.p
      // check alone would pass) but the statement itself is signed by a
      // DIFFERENT identity — only the identity binding catches this.
      const statement = finalizeEvent(deviceStatementTemplate(inviterPhone.pkHex, at), attackerSk) as SignedEvent
      const wrap = await wrapInvite(self.pkHex, invite, statement, inviterPhone.skHex, '9'.repeat(64))

      await onPersonalInboxWrap(makeLocalSigner(self.skHex), wrap)

      expect(view(store.load())).not.toContain('Impersonation Circle')
      expect(store.load().circles.some((c) => c.id === 'impersonation-circle')).toBe(false)
    })

    it('drops an invite whose signed prev does not match the hash of the seed it carries (Task 10 fix round 1, finding 4; final fix A3: a tampered seed)', async () => {
      const self = realKeypair()
      const inviterSk = generateSecretKey()
      const inviterPhone = realKeypair()
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
      store.save(fakePersisted({}))

      const at = Math.floor(Date.now() / 1000)
      const inner = { id: 'mismatch-prev-circle', name: 'Mismatch Prev Circle', mode: 'family' }
      // Signed against seed 'b''s hash, but the rumor carries seed 'a'.
      const template = structuralTemplate({
        action: 'invite', circleId: 'mismatch-prev-circle', prevSeedHash: seedHash('b'.repeat(64)), payload: JSON.stringify(inner), nowSec: at,
      })
      const invite = finalizeEvent(template, inviterSk) as SignedEvent
      const statement = finalizeEvent(deviceStatementTemplate(inviterPhone.pkHex, at), inviterSk) as SignedEvent
      const wrap = await wrapInvite(self.pkHex, invite, statement, inviterPhone.skHex, 'a'.repeat(64))

      await onPersonalInboxWrap(makeLocalSigner(self.skHex), wrap)

      expect(view(store.load())).not.toContain('Mismatch Prev Circle')
      expect(store.load().circles.some((c) => c.id === 'mismatch-prev-circle')).toBe(false)
    })

    it('a SignerUnavailable while decrypting does not mark the wrap seen (retried on the next resubscribe)', async () => {
      const self = realKeypair()
      const sender = realKeypair()
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
      store.save(fakePersisted({}))

      const wrap = await giftWrap(makeLocalSigner(sender.skHex), self.pkHex, { kind: 14, content: JSON.stringify({ invite: {}, statement: {} }), tags: [] })
      const flakySigner: Signer = {
        pubkey: self.pkHex,
        signEvent: async () => { throw new Error('unused in this test') },
        nip44Encrypt: async () => { throw new Error('unused in this test') },
        nip44Decrypt: async () => { throw new SignerUnavailable('the remote signer did not answer') },
      }

      await onPersonalInboxWrap(flakySigner, wrap)

      expect(store.load().seenPersonalWraps).not.toContain(wrap.id)
    })

    // Device check 2026-09-27 (phase 2 step 6): Blake's invite wrap was
    // marked seen with no invite shown. The decrypt had gone to My Signet
    // by intent (locked, PIN asked) with a percent-encoded ciphertext, came
    // back "My Signet declined." — a SignerRejected — and the wrap was
    // burned for good. A refusal from the signer says nothing about the
    // wrap itself (locked, cancelled, timed out in the signer, a transport
    // bug): only a wrap that genuinely can't be ours may be marked seen.
    it('a SignerRejected while decrypting does not mark the wrap seen either — the invite is retried, not lost', async () => {
      const self = realKeypair()
      const sender = realKeypair()
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
      store.save(fakePersisted({}))

      const wrap = await giftWrap(makeLocalSigner(sender.skHex), self.pkHex, { kind: 14, content: JSON.stringify({ invite: {}, statement: {} }), tags: [] })
      const refusingSigner: Signer = {
        pubkey: self.pkHex,
        signEvent: async () => { throw new Error('unused in this test') },
        nip44Encrypt: async () => { throw new Error('unused in this test') },
        nip44Decrypt: async () => { throw new SignerRejected('My Signet declined.') },
      }

      await onPersonalInboxWrap(refusingSigner, wrap)
      expect(store.load().seenPersonalWraps).not.toContain(wrap.id)

      // The next delivery, with the signer answering, is handled and only
      // then marked seen.
      await onPersonalInboxWrap(makeLocalSigner(self.skHex), wrap)
      expect(store.load().seenPersonalWraps).toContain(wrap.id)
    })
  })

  // Review follow-up to 36c939d: a stranger-triggerable loop. Anyone can
  // drop a junk wrap in this inbox; My Signet answers "rejected" for any
  // backend error (a NIP-44 MAC failure included); every resubscribe
  // replays the backlog. A refusal left the wrap unmarked forever, and the
  // decrypt fell back to a NIP-55 intent — My Signet to the front, again
  // and again. Background unwraps are silent-only, and refusals are counted.
  describe('background unwraps: silent only, deferred, bounded', () => {
    /** A transport over `skHex` that records every call's options and
     *  answers as `mode.now` says: refuse, can't-answer-silently (locked),
     *  or decrypt for real. */
    function scripted(skHex: string, mode: { now: 'refuse' | 'locked' | 'ok' }) {
      const calls: Array<{ method: string; opts: SignerCallOpts | undefined }> = []
      const sk = hexToBytes(skHex)
      const transport: SignerTransport = {
        pubkey: getPublicKey(sk),
        async signEvent(t, opts) {
          calls.push({ method: 'sign_event', opts })
          if (mode.now === 'locked') throw new SignerUnavailable('The signer app could not answer in the background.')
          return finalizeEvent({ ...t, created_at: t.created_at ?? Math.floor(Date.now() / 1000) }, sk) as SignedEvent
        },
        async nip44Encrypt() { throw new Error('unused') },
        async nip44Decrypt(peer, ct, opts) {
          calls.push({ method: 'nip44_decrypt', opts })
          if (mode.now === 'refuse') throw new Error('My Signet declined.')
          if (mode.now === 'locked') throw new Error('The signer app could not answer in the background.')
          return nip44decrypt(ct, getConversationKey(sk, peer))
        },
        async close() {},
      }
      return { transport, calls }
    }

    beforeEach(() => {
      resetDeferredPersonalWrapsForTests()
      // Pass spacing has its own test below; the rest run passes back to back.
      setMinPassGapForTests(0)
    })
    afterEach(() => {
      setMinPassGapForTests(MIN_PASS_GAP_MS)
      vi.useRealTimers()
    })

    // Final review, item 4: every answered decrypt asks for another pass,
    // each with a fresh budget, so passes ran back to back and the per-pass
    // cap did not bound the rate. Pass starts are now at least
    // MIN_PASS_GAP_MS apart; a request inside the window runs once at its end.
    it('deferred-retry passes start at least 5 s apart; requests inside the window coalesce into one pass at its end', async () => {
      setMinPassGapForTests(MIN_PASS_GAP_MS)
      expect(MIN_PASS_GAP_MS).toBe(5_000)
      const self = realKeypair()
      const sender = realKeypair()
      const passAt: number[] = []
      const transport: SignerTransport = {
        pubkey: self.pkHex,
        async signEvent() { throw new Error('unused') },
        async nip44Encrypt() { throw new Error('unused') },
        async nip44Decrypt() {
          passAt.push(Date.now()) // locked: every pass stops at its first wrap
          throw new SignerUnavailable('The signer app could not answer in the background.')
        },
        async close() {},
      }
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport })
      store.save(fakePersisted({}))
      const w1 = await giftWrap(makeLocalSigner(sender.skHex), self.pkHex, { kind: 14, content: 'one', tags: [] })
      await onPersonalInboxWrap(personalInboxSigner(), w1)
      expect(deferredPersonalWrapIdsForTests()).toEqual([w1.id])
      passAt.length = 0

      vi.useFakeTimers()
      const t0 = Date.now()
      void retryDeferredPersonalWraps()
      await vi.advanceTimersByTimeAsync(0)
      expect(passAt).toEqual([t0]) // the first pass runs at once

      await vi.advanceTimersByTimeAsync(1_000)
      void retryDeferredPersonalWraps()
      void retryDeferredPersonalWraps()
      await vi.advanceTimersByTimeAsync(2_000)
      void retryDeferredPersonalWraps()
      await vi.advanceTimersByTimeAsync(1_900)
      expect(passAt).toHaveLength(1) // still inside the window
      await vi.advanceTimersByTimeAsync(200)
      expect(passAt).toEqual([t0, t0 + 5_000]) // one pass, at the window's end

      await vi.advanceTimersByTimeAsync(30_000)
      expect(passAt).toHaveLength(2) // nothing more was asked for

      void retryDeferredPersonalWraps() // outside the window: at once
      await vi.advanceTimersByTimeAsync(0)
      expect(passAt).toHaveLength(3)
      expect(passAt[2]! - passAt[1]!).toBeGreaterThanOrEqual(5_000)
    })

    it('a junk wrap replayed many times costs at most MAX_WRAP_REFUSALS silent decrypts, then is dropped', async () => {
      const self = realKeypair()
      const stranger = realKeypair()
      const { transport, calls } = scripted(self.skHex, { now: 'refuse' })
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport })
      store.save(fakePersisted({}))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const junk = await giftWrap(makeLocalSigner(stranger.skHex), self.pkHex, { kind: 14, content: 'junk', tags: [] })

      for (let i = 0; i < 8; i++) await onPersonalInboxWrap(personalInboxSigner(), junk)

      expect(MAX_WRAP_REFUSALS).toBe(3)
      expect(calls.filter((c) => c.method === 'nip44_decrypt')).toHaveLength(3)
      // Never an interactive request: no NIP-55 intent fallback, ever.
      expect(calls.every((c) => c.opts?.interactive === false)).toBe(true)
      expect(store.load().seenPersonalWraps).toContain(junk.id)
      expect(store.load().personalWrapRefusals).toEqual([])
      expect(deferredPersonalWrapIdsForTests()).toEqual([])
      expect(warn).toHaveBeenCalledTimes(1)
      warn.mockRestore()
    })

    it('the refusal count survives a restart (persisted in the store)', async () => {
      const self = realKeypair()
      const stranger = realKeypair()
      const { transport, calls } = scripted(self.skHex, { now: 'refuse' })
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport })
      store.save(fakePersisted({}))
      const junk = await giftWrap(makeLocalSigner(stranger.skHex), self.pkHex, { kind: 14, content: 'junk', tags: [] })
      await onPersonalInboxWrap(personalInboxSigner(), junk)
      await onPersonalInboxWrap(personalInboxSigner(), junk)
      expect(store.load().personalWrapRefusals).toEqual([`${junk.id.slice(0, 16)}:2`])
      expect(store.load().seenPersonalWraps).not.toContain(junk.id)
      await onPersonalInboxWrap(personalInboxSigner(), junk)
      expect(store.load().seenPersonalWraps).toContain(junk.id)
      expect(calls).toHaveLength(3)
    })

    it('a locked signer defers a genuine invite; it is delivered when the signer is next available (app resume)', async () => {
      const self = realKeypair()
      const inviterSk = generateSecretKey()
      const inviterPhone = realKeypair()
      const mode: { now: 'refuse' | 'locked' | 'ok' } = { now: 'locked' }
      const { transport, calls } = scripted(self.skHex, mode)
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport })
      store.save(fakePersisted({}))
      const { invite, statement } = buildInvite({ to: self.pkHex,
        circleId: 'deferred-circle', seedHex: '6'.repeat(64), name: 'Deferred Circle', inviterSk, inviterPhonePk: inviterPhone.pkHex,
      })
      const wrap = await wrapInvite(self.pkHex, invite, statement, inviterPhone.skHex)

      await onPersonalInboxWrap(personalInboxSigner(), wrap)
      expect(store.load().seenPersonalWraps).not.toContain(wrap.id)
      expect(deferredPersonalWrapIdsForTests()).toEqual([wrap.id])
      // Deferral is not a refusal: nothing counted against the wrap.
      expect(store.load().personalWrapRefusals).toEqual([])

      // Still locked: a retry defers again, once, and asks nothing else.
      await retryDeferredPersonalWraps()
      expect(deferredPersonalWrapIdsForTests()).toEqual([wrap.id])

      mode.now = 'ok'
      await retryDeferredPersonalWraps()
      expect(view(store.load())).toContain('Deferred Circle')
      expect(store.load().seenPersonalWraps).toContain(wrap.id)
      expect(deferredPersonalWrapIdsForTests()).toEqual([])
      expect(calls.every((c) => c.opts?.interactive === false)).toBe(true)
      handleAction('circle-decline', { dataset: {} } as unknown as HTMLElement)
    })

    it('any signer call that gets an answer retries the deferred wraps', async () => {
      const self = realKeypair()
      const inviterSk = generateSecretKey()
      const inviterPhone = realKeypair()
      const mode: { now: 'refuse' | 'locked' | 'ok' } = { now: 'locked' }
      const { transport } = scripted(self.skHex, mode)
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport })
      store.save(fakePersisted({}))
      const { invite, statement } = buildInvite({ to: self.pkHex,
        circleId: 'answered-circle', seedHex: '7'.repeat(64), name: 'Answered Circle', inviterSk, inviterPhonePk: inviterPhone.pkHex,
      })
      const wrap = await wrapInvite(self.pkHex, invite, statement, inviterPhone.skHex)
      await onPersonalInboxWrap(personalInboxSigner(), wrap)
      expect(deferredPersonalWrapIdsForTests()).toEqual([wrap.id])

      // e.g. the structural queue's "Waiting for My Signet" sign finally lands.
      mode.now = 'ok'
      await identitySigner().signEvent({ kind: 1, content: 'x', tags: [], created_at: Math.floor(Date.now() / 1000) })
      await vi.waitFor(() => { expect(deferredPersonalWrapIdsForTests()).toEqual([]) })
      await vi.waitFor(() => { expect(view(store.load())).toContain('Answered Circle') })
      handleAction('circle-decline', { dataset: {} } as unknown as HTMLElement)
    })

    /** A wrap-shaped junk event: a refusing signer never reads its content. */
    function junkWrap(i: number) {
      return { id: i.toString(16).padStart(8, '0').repeat(8), pubkey: realKeypair().pkHex, content: 'junk', tags: [] as string[][] }
    }

    // Review follow-up to 60c8176: the refusal log kept only 500 entries and
    // the REQ has no since/limit, so with more than 500 junk wraps none ever
    // reached MAX_WRAP_REFUSALS — silent decrypts, full-store writes and
    // re-renders on every resubscribe, forever.
    it('600 junk wraps replayed repeatedly: decrypts per pass are capped, writes batched, and all are eventually dropped', async () => {
      const self = realKeypair()
      const { transport, calls } = scripted(self.skHex, { now: 'refuse' })
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport })
      store.save(fakePersisted({}))
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      expect(DECRYPTS_PER_PASS).toBe(50)
      expect(MAX_REFUSAL_RECORDS).toBeGreaterThanOrEqual(5000)
      const junk = Array.from({ length: 600 }, (_, i) => junkWrap(i + 1))
      vi.mocked(subscribeGiftWraps).mockClear()
      vi.mocked(subscribeGiftWraps).mockImplementation(() => () => {})
      const updates = vi.spyOn(store, 'update')

      const decrypts = (): number => calls.filter((c) => c.method === 'nip44_decrypt').length
      let replays = 0
      while (store.load().seenPersonalWraps.length < 600 && replays < 60) {
        replays++
        // A resubscribe (the relay list changed → new subscription key)
        // replays the whole backlog, as the relay has no since/limit.
        store.update((p) => { p.settings.relayUrl = `wss://r${replays}.example` })
        ensure(store.load())
        const sub = vi.mocked(subscribeGiftWraps).mock.calls.at(-1)!
        expect(sub[1]).toBe(personalInboxTag(self.pkHex))
        updates.mockClear()
        const before = decrypts()
        await Promise.all(junk.map((w) => onPersonalInboxWrap(personalInboxSigner(), w as never)))
        expect(decrypts() - before).toBeLessThanOrEqual(DECRYPTS_PER_PASS)
        expect(updates.mock.calls.length).toBeLessThanOrEqual(1) // one batched write for the pass
        // An availability tick works through the deferred rest, capped too.
        updates.mockClear()
        const beforeTick = decrypts()
        await retryDeferredPersonalWraps()
        expect(decrypts() - beforeTick).toBeLessThanOrEqual(DECRYPTS_PER_PASS)
        expect(updates.mock.calls.length).toBeLessThanOrEqual(1)
      }
      const seen = new Set(store.load().seenPersonalWraps)
      expect(junk.every((w) => seen.has(w.id))).toBe(true)
      expect(decrypts()).toBe(600 * MAX_WRAP_REFUSALS)
      expect(store.load().personalWrapRefusals).toEqual([])
      expect(calls.every((c) => c.opts?.interactive === false)).toBe(true)
      updates.mockRestore()
      warn.mockRestore()
      vi.mocked(subscribeGiftWraps).mockReset()
    }, 60_000)

    it('an older-shaped refusal log ({ id, n }) is read compactly', () => {
      const id = 'ab'.repeat(32)
      localStorage.setItem('kindependence.v1', JSON.stringify({ ...fakePersisted({}), personalWrapRefusals: [{ id, n: 2 }, { bad: 1 }] }))
      expect(store.load().personalWrapRefusals).toEqual([`${id.slice(0, 16)}:2`])
    })

    it('sign-out and identity change forget deferred wraps and (on a change of identity) refusal counts', async () => {
      const a = realKeypair()
      const lockedA = scripted(a.skHex, { now: 'locked' })
      sessionForTests({ identityPk: a.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport: lockedA.transport })
      store.save(fakePersisted({}))
      vi.mocked(subscribeGiftWraps).mockImplementation(() => () => {})
      ensure(store.load())
      await onPersonalInboxWrap(personalInboxSigner(), junkWrap(1) as never)
      expect(deferredPersonalWrapIdsForTests()).toEqual([junkWrap(1).id])

      // Signed out: nothing of A's inbox may linger in memory.
      sessionForTests(null)
      ensure(store.load())
      expect(deferredPersonalWrapIdsForTests()).toEqual([])

      // A again, a refusal counted and a wrap deferred; then B signs in.
      const refusingA = scripted(a.skHex, { now: 'refuse' })
      sessionForTests({ identityPk: a.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport: refusingA.transport })
      ensure(store.load())
      await onPersonalInboxWrap(personalInboxSigner(), junkWrap(2) as never)
      expect(store.load().personalWrapRefusals).toHaveLength(1)
      sessionForTests({ identityPk: a.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport: lockedA.transport })
      await onPersonalInboxWrap(personalInboxSigner(), junkWrap(3) as never)
      expect(deferredPersonalWrapIdsForTests()).toEqual([junkWrap(3).id])

      const b = realKeypair()
      sessionForTests({ identityPk: b.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport: scripted(b.skHex, { now: 'locked' }).transport })
      ensure(store.load())
      expect(deferredPersonalWrapIdsForTests()).toEqual([])
      await vi.waitFor(() => { expect(store.load().personalWrapRefusals).toEqual([]) })
      vi.mocked(subscribeGiftWraps).mockReset()
    })

    it('a signer answer that arrives while a retry pass is running runs one more pass', async () => {
      const self = realKeypair()
      const sender = realKeypair()
      const sk = hexToBytes(self.skHex)
      let locked = true
      let calls = 0
      let gate: Promise<void> = Promise.resolve()
      let openGate: () => void = () => {}
      const transport: SignerTransport = {
        pubkey: self.pkHex,
        async signEvent() { throw new Error('unused') },
        async nip44Encrypt() { throw new Error('unused') },
        async nip44Decrypt(peer, ct) {
          calls++
          if (locked) throw new SignerUnavailable('The signer app could not answer in the background.')
          // The pass's third call (w3's first) is slow, then still locked.
          if (calls === 3) { await gate; throw new SignerUnavailable('The signer app could not answer in the background.') }
          return nip44decrypt(ct, getConversationKey(sk, peer))
        },
        async close() {},
      }
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport })
      store.save(fakePersisted({}))
      const w1 = await giftWrap(makeLocalSigner(sender.skHex), self.pkHex, { kind: 14, content: 'one', tags: [] })
      const w3 = await giftWrap(makeLocalSigner(sender.skHex), self.pkHex, { kind: 14, content: 'three', tags: [] })
      await onPersonalInboxWrap(personalInboxSigner(), w1)
      await onPersonalInboxWrap(personalInboxSigner(), w3)
      expect(deferredPersonalWrapIdsForTests()).toEqual([w1.id, w3.id])

      locked = false
      calls = 0
      gate = new Promise<void>((r) => { openGate = r })
      const pass = retryDeferredPersonalWraps()
      // w1 unwraps; its answers reach the signer-answered hook (a retry
      // request) while the pass is still waiting on w3.
      await new Promise((r) => setTimeout(r, 20))
      expect(store.load().seenPersonalWraps).toContain(w1.id)
      openGate()
      await pass
      // The pass stopped at w3 (still locked then); the answer that came in
      // meanwhile was not dropped: one more pass delivers it.
      await vi.waitFor(() => { expect(store.load().seenPersonalWraps).toContain(w3.id) }, { timeout: 500 })
      expect(deferredPersonalWrapIdsForTests()).toEqual([])
    })

    it('the inbox subscription unwraps with the background signer (never interactive)', async () => {
      const self = realKeypair()
      const sender = realKeypair()
      const { transport, calls } = scripted(self.skHex, { now: 'ok' })
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport })
      store.save(fakePersisted({}))
      vi.mocked(subscribeGiftWraps).mockClear()
      vi.mocked(subscribeGiftWraps).mockImplementation(() => () => {})
      ensure(store.load())
      const call = vi.mocked(subscribeGiftWraps).mock.calls.find((c) => c[1] === personalInboxTag(self.pkHex))
      expect(call).toBeDefined()
      const wrap = await giftWrap(makeLocalSigner(sender.skHex), self.pkHex, { kind: 14, content: 'hello', tags: [] })
      call![2](wrap as never)
      await vi.waitFor(() => { expect(store.load().seenPersonalWraps).toContain(wrap.id) })
      expect(calls.length).toBeGreaterThan(0)
      expect(calls.every((c) => c.opts?.interactive === false)).toBe(true)
      vi.mocked(subscribeGiftWraps).mockReset()
    })
  })

  it('ignores a config write on the personal inbox (config is a structural circle-inbox event since Task 8)', async () => {
    const self = realKeypair()
    const member = realKeypair()
    const circle = fakeCircle({
      id: 'config-circle',
      members: [{ pk: self.pkHex, role: 'guardian', name: 'Self' }, { pk: member.pkHex, role: 'guardian', name: 'M' }],
      configUpdatedAt: 100, configBy: self.pkHex,
    })
    store.save(fakePersisted({ circles: [circle] }))
    const cfg = { v: 1, id: 'config-circle', name: 'Renamed', updatedAt: 200, by: member.pkHex, members: circle.members }
    const wrap = await giftWrap(makeLocalSigner(member.skHex), self.pkHex, { kind: 14, content: JSON.stringify(cfg), tags: [] })
    await onPersonalInboxWrap(makeLocalSigner(self.skHex), wrap)
    const after = store.load().circles.find((c) => c.id === 'config-circle')
    expect(after?.name).toBe('Test circle')
    expect(after?.configUpdatedAt).toBe(100)
  })
})

describe('eviction tombstones', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(publishSigned).mockClear()
    vi.mocked(publishSigned).mockImplementation(async () => ({}))
  })

  it('a re-invite lifts the local eviction tombstone (removedPks AND the removals record)', async () => {
    const bunker = fakeBunker({})
    const selfPhone = realKeypair()
    const evicted = realKeypair()
    const now = Math.floor(Date.now() / 1000)
    const statement = await bunker.signEvent(deviceStatementTemplate(selfPhone.pkHex, now))
    sessionForTests({ identityPk: bunker.pubkey, phoneSkHex: selfPhone.skHex, dependant: false, statement, transport: bunker })

    const circle: store.StoredCircle = {
      ...fakeCircle({
        id: 'reinvite-circle',
        members: [{ pk: bunker.pubkey, role: 'guardian', name: 'Self' }],
      }),
      removedPks: [evicted.pkHex],
      // A removal recorded well BEFORE this re-invite — the re-invite is
      // dated after it, so it's a valid re-admission.
      removals: { [evicted.pkHex]: { at: now - 1000, hash: 'e'.repeat(64) } },
    }
    store.save(fakePersisted({ circles: [circle] }))

    knowContacts(evicted.pkHex)
    await inviteToCircle('reinvite-circle', evicted.pkHex)

    const after = store.load().circles.find((c) => c.id === 'reinvite-circle')
    expect(after?.members.some((m) => m.pk === evicted.pkHex)).toBe(true)
    expect(after?.removedPks ?? []).not.toContain(evicted.pkHex)
    expect(after?.removals?.[evicted.pkHex]).toBeUndefined()
  })

  it('does not re-admit locally when the invite is not dated after the recorded removal (stale re-admission)', async () => {
    // Controller ruling: a removed pk is re-admitted only by an invite whose
    // inner created_at is after its recorded removal. Engineered here by
    // recording the removal far in the future relative to "now" — the
    // re-invite (signed with the real current time) can't be after it.
    const bunker = fakeBunker({})
    const selfPhone = realKeypair()
    const evicted = realKeypair()
    const now = Math.floor(Date.now() / 1000)
    const statement = await bunker.signEvent(deviceStatementTemplate(selfPhone.pkHex, now))
    sessionForTests({ identityPk: bunker.pubkey, phoneSkHex: selfPhone.skHex, dependant: false, statement, transport: bunker })

    const circle: store.StoredCircle = {
      ...fakeCircle({
        id: 'stale-reinvite-circle',
        members: [{ pk: bunker.pubkey, role: 'guardian', name: 'Self' }],
      }),
      removedPks: [evicted.pkHex],
      removals: { [evicted.pkHex]: { at: now + 1_000_000, hash: 'f'.repeat(64) } },
    }
    store.save(fakePersisted({ circles: [circle] }))

    handleAction('circle-invite-open', { dataset: { circle: 'stale-reinvite-circle' } } as unknown as HTMLElement)
    knowContacts(evicted.pkHex)
    await inviteToCircle('stale-reinvite-circle', evicted.pkHex)

    const after = store.load().circles.find((c) => c.id === 'stale-reinvite-circle')
    expect(after?.members.some((m) => m.pk === evicted.pkHex)).toBe(false)
    expect(after?.removedPks ?? []).toContain(evicted.pkHex)
    // Task 10 fix round 1, finding 5: a refused local re-admission must not
    // put a wire invite on the relay at all — checked BEFORE any signing or
    // sending, not just skipped afterwards for the local roster update.
    expect(vi.mocked(publishSigned)).not.toHaveBeenCalled()
    expect(view(store.load())).toContain("Can't re-invite right now")
  })

  it('refuses to send (and never signs) when this device has no device statement yet, with an accurate notice (Task 10 fix round 1, finding 5)', async () => {
    const bunker = fakeBunker({})
    const selfPhone = realKeypair()
    const recipient = realKeypair()
    // No `statement` passed — this device hasn't finished sign-in (Task 11
    // wires `session.statement`).
    sessionForTests({ identityPk: bunker.pubkey, phoneSkHex: selfPhone.skHex, dependant: false, transport: bunker })

    const circle = fakeCircle({ id: 'no-statement-circle', members: [{ pk: bunker.pubkey, role: 'guardian', name: 'Self' }] })
    store.save(fakePersisted({ circles: [circle] }))
    handleAction('circle-invite-open', { dataset: { circle: 'no-statement-circle' } } as unknown as HTMLElement)

    knowContacts(recipient.pkHex)
    await inviteToCircle('no-statement-circle', recipient.pkHex)

    expect(view(store.load())).toContain('Finish signing in first')
    expect(vi.mocked(publishSigned)).not.toHaveBeenCalled()
    expect(bunker.requests.filter((r) => r.method === 'sign_event')).toHaveLength(0)
  })
})

// Task 10 fix round 1, finding 2 (second clause of the controller ruling):
// the receiver-side mirror of applyConfig's re-admission check, but for a
// joiner accepting an invite into a circle it still holds a stale,
// pre-removal local copy of (self no longer among its members).
describe('handleIncomingInvite — receiver-side re-admission after local removal', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })

  it('a stale re-invite (not dated after our own recorded removal) does not resurrect the stale local copy', async () => {
    const self = realKeypair()
    const inviterSk = generateSecretKey()
    const inviterPhone = realKeypair()
    const otherMember = realKeypair()
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })

    const now = Math.floor(Date.now() / 1000)
    const stale: store.StoredCircle = {
      ...fakeCircle({ id: 'was-removed-circle', name: 'Stale Copy', members: [{ pk: otherMember.pkHex, role: 'guardian' }] }),
      removedPks: [self.pkHex],
      removals: { [self.pkHex]: { at: now + 1_000_000, hash: 'e'.repeat(64) } },
    }
    store.save(fakePersisted({ circles: [stale] }))

    const { invite, statement } = buildInvite({ to: self.pkHex,
      circleId: 'was-removed-circle', seedHex: 'd'.repeat(64), name: 'Fresh Re-invite', inviterSk, inviterPhonePk: inviterPhone.pkHex, at: now,
    })
    const wrap = await wrapInvite(self.pkHex, invite, statement, inviterPhone.skHex)

    await onPersonalInboxWrap(makeLocalSigner(self.skHex), wrap)

    expect(view(store.load())).not.toContain('Fresh Re-invite')
    expect(store.load().circles).toEqual([stale])
  })

  it('a fresh re-invite (dated after our own recorded removal) resurrects it, replacing (not duplicating) the stale copy', async () => {
    const self = realKeypair()
    const inviterSk = generateSecretKey()
    const inviterPhone = realKeypair()
    const otherMember = realKeypair()
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })

    const now = Math.floor(Date.now() / 1000)
    const stale: store.StoredCircle = {
      ...fakeCircle({ id: 'was-removed-circle-2', name: 'Stale Copy', members: [{ pk: otherMember.pkHex, role: 'guardian' }] }),
      removedPks: [self.pkHex],
      removals: { [self.pkHex]: { at: now - 1_000_000, hash: 'e'.repeat(64) } },
    }
    store.save(fakePersisted({ circles: [stale] }))

    const { invite, statement } = buildInvite({ to: self.pkHex,
      circleId: 'was-removed-circle-2', seedHex: 'd'.repeat(64), name: 'Fresh Re-invite', inviterSk, inviterPhonePk: inviterPhone.pkHex, at: now,
    })
    const wrap = await wrapInvite(self.pkHex, invite, statement, inviterPhone.skHex)

    await onPersonalInboxWrap(makeLocalSigner(self.skHex), wrap)
    expect(view(store.load())).toContain('Fresh Re-invite')

    handleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)

    const circles = store.load().circles.filter((c) => c.id === 'was-removed-circle-2')
    expect(circles).toHaveLength(1) // replaced, not duplicated
    expect(circles[0]?.name).toBe('Fresh Re-invite')
    expect(circles[0]?.removedPks ?? []).not.toContain(self.pkHex)
  })

  // Task 10 fix round 2, finding 4 (controller ruling): a device excluded
  // from a removing re-key's `to` never learns it was removed at all (Task
  // 8's own re-key reach design) — it keeps listing itself as a current
  // member, on the pre-removal seed, with no `removals[self]` entry.
  // Self-membership alone can't tell this "cut-off" device from a genuinely
  // live one; the seed-hash chain can.
  it('a device cut off from a removing re-key (still listing itself, on the stale seed) shows and accepts a fresh re-invite', async () => {
    const self = realKeypair()
    const inviterSk = generateSecretKey()
    const inviterPhone = realKeypair()
    const otherMember = realKeypair()
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })

    const cutOff: store.StoredCircle = fakeCircle({
      id: 'cut-off-circle', name: 'Stale Copy', seedHex: 'f'.repeat(64),
      members: [{ pk: self.pkHex, role: 'guardian' }, { pk: otherMember.pkHex, role: 'guardian' }],
    })
    store.save(fakePersisted({ circles: [cutOff] }))

    const { invite, statement } = buildInvite({ to: self.pkHex,
      circleId: 'cut-off-circle', seedHex: 'd'.repeat(64), name: 'Fresh Re-invite', inviterSk, inviterPhonePk: inviterPhone.pkHex,
    })
    const wrap = await wrapInvite(self.pkHex, invite, statement, inviterPhone.skHex)

    await onPersonalInboxWrap(makeLocalSigner(self.skHex), wrap)
    expect(view(store.load())).toContain('Fresh Re-invite')

    handleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)

    const circles = store.load().circles.filter((c) => c.id === 'cut-off-circle')
    expect(circles).toHaveLength(1) // replaced, not duplicated
    expect(circles[0]?.name).toBe('Fresh Re-invite')
  })

  it('a duplicate invite for a seed hash we already hold is ignored, even though we still list ourselves as a member', async () => {
    const self = realKeypair()
    const inviterSk = generateSecretKey()
    const inviterPhone = realKeypair()
    const otherMember = realKeypair()
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })

    const currentSeed = 'f'.repeat(64)
    const current: store.StoredCircle = fakeCircle({
      id: 'live-circle', name: 'Live Circle', seedHex: currentSeed,
      members: [{ pk: self.pkHex, role: 'guardian' }, { pk: otherMember.pkHex, role: 'guardian' }],
    })
    store.save(fakePersisted({ circles: [current] }))

    const { invite, statement } = buildInvite({ to: self.pkHex,
      circleId: 'live-circle', seedHex: currentSeed, name: 'Duplicate Old Invite', inviterSk, inviterPhonePk: inviterPhone.pkHex,
    })
    const wrap = await wrapInvite(self.pkHex, invite, statement, inviterPhone.skHex)

    await onPersonalInboxWrap(makeLocalSigner(self.skHex), wrap)

    expect(view(store.load())).not.toContain('Duplicate Old Invite')
    expect(store.load().circles).toEqual([current])
  })

  // Task 10 fix round 2, finding 3: acceptPendingInvite re-runs the same
  // gate at accept time, against fresh state, not just at receive time.
  it('acceptPendingInvite re-runs the gate at accept time: a current copy arriving after the invite was shown refuses the accept, leaving it untouched', async () => {
    const self = realKeypair()
    const inviterSk = generateSecretKey()
    const inviterPhone = realKeypair()
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
    store.save(fakePersisted({})) // no local copy of the circle yet

    const { invite, statement } = buildInvite({ to: self.pkHex,
      circleId: 'race-circle', seedHex: 'd'.repeat(64), name: 'Race Invite', inviterSk, inviterPhonePk: inviterPhone.pkHex,
    })
    const wrap = await wrapInvite(self.pkHex, invite, statement, inviterPhone.skHex)

    await onPersonalInboxWrap(makeLocalSigner(self.skHex), wrap)
    expect(view(store.load())).toContain('Race Invite')

    // A current copy arrives in the gap before the user taps Accept — this
    // device already has the circle via another route, on the SAME seed
    // the pending invite carries.
    const currentCopy: store.StoredCircle = fakeCircle({
      id: 'race-circle', name: 'Already Live', seedHex: 'd'.repeat(64), members: [{ pk: self.pkHex, role: 'guardian' }],
    })
    store.update((p) => { p.circles = [currentCopy] })

    handleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)

    expect(store.load().circles).toEqual([currentCopy]) // untouched — accept was refused
    // Task 10 fix round 3, finding 2: a short, accurate notice on refusal.
    expect(view(store.load())).toContain('This invite is out of date.')
  })

  // Task 10 fix round 3, finding 1(a) (controller ruling): an "unknown
  // seed" alone isn't enough to treat an invite as a genuine re-invite — it
  // must also be dated after our CURRENT epoch started. Without this, a
  // replayed invite from before our chain happens to reach back to (e.g.
  // right after joining, before round 3's chain-carryover existed at all)
  // could resurrect/downgrade a perfectly live, never-removed circle.
  it('a live member (never removed) receives a replayed invite for an earlier, pre-epoch seed — ignored, circle untouched', async () => {
    const self = realKeypair()
    const inviterSk = generateSecretKey()
    const inviterPhone = realKeypair()
    const otherMember = realKeypair()
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })

    const epochStart = Math.floor(Date.now() / 1000)
    const live: store.StoredCircle = {
      ...fakeCircle({
        id: 'live-epoch-circle', name: 'Live Circle', seedHex: 'f'.repeat(64),
        members: [{ pk: self.pkHex, role: 'guardian' }, { pk: otherMember.pkHex, role: 'guardian' }],
      }),
      epochStartedAt: epochStart,
    }
    store.save(fakePersisted({ circles: [live] })) // no chain entry reaching back to any earlier epoch

    const { invite, statement } = buildInvite({ to: self.pkHex,
      circleId: 'live-epoch-circle', seedHex: 'b'.repeat(64), name: 'Replayed Old Invite', inviterSk, inviterPhonePk: inviterPhone.pkHex,
      at: epochStart - 1_000, // dated BEFORE our current epoch started
    })
    const wrap = await wrapInvite(self.pkHex, invite, statement, inviterPhone.skHex)

    await onPersonalInboxWrap(makeLocalSigner(self.skHex), wrap)

    expect(view(store.load())).not.toContain('Replayed Old Invite')
    expect(store.load().circles).toEqual([live])
  })

  // Task 10 fix round 3, finding 1(b): saveJoinedCircle carries the prior
  // seed-hash chain forward (appends, doesn't reset) across a re-join, so
  // an even-older, pre-removal invite stays recognisable as "a seed epoch
  // we already held" afterwards.
  it('after a legitimate re-invite is accepted, an even older pre-removal invite is still ignored', async () => {
    const self = realKeypair()
    const inviterSk = generateSecretKey()
    const inviterPhone = realKeypair()
    const otherMember = realKeypair()
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })

    const oldSeed = '1'.repeat(64) // the epoch we held before being removed
    const removedAt = Math.floor(Date.now() / 1000) - 1_000
    const stale: store.StoredCircle = {
      ...fakeCircle({
        id: 'reinvited-circle', name: 'Stale Copy', seedHex: oldSeed,
        members: [{ pk: otherMember.pkHex, role: 'guardian' }],
      }),
      removedPks: [self.pkHex],
      removals: { [self.pkHex]: { at: removedAt, hash: 'e'.repeat(64) } },
    }
    store.save(fakePersisted({ circles: [stale], seedHashes: { 'reinvited-circle': [seedHash(oldSeed)] } }))

    // A fresh, legitimate re-invite: dated after the removal, seed hash not
    // in our chain — shown and accepted, same as the "cut off" test above.
    const { invite, statement } = buildInvite({ to: self.pkHex,
      circleId: 'reinvited-circle', seedHex: '2'.repeat(64), name: 'Fresh Re-invite', inviterSk, inviterPhonePk: inviterPhone.pkHex,
    })
    const wrap = await wrapInvite(self.pkHex, invite, statement, inviterPhone.skHex)
    await onPersonalInboxWrap(makeLocalSigner(self.skHex), wrap)
    expect(view(store.load())).toContain('Fresh Re-invite')
    handleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)
    expect(store.load().circles.find((c) => c.id === 'reinvited-circle')?.seedHex).toBe('2'.repeat(64))

    // An even OLDER invite, for the pre-removal seed we used to hold,
    // arrives now. Its seed hash must still read as "known" (the chain was
    // carried over at re-join, not reset), so it's ignored — not shown as
    // yet another "cut off" re-invite opportunity. Dated LATER than the
    // fresh invite's own createdAt so it passes the epochStartedAt date gate
    // (invitePasses) and is rejected only by the carried-over seed-hash
    // chain in saveJoinedCircle, not by the date gate — proving the chain
    // carry-over itself, not a date-gate coincidence, is what stops it.
    const inviterSk2 = generateSecretKey()
    const inviterPhone2 = realKeypair()
    const { invite: oldInvite, statement: oldStatement } = buildInvite({ to: self.pkHex,
      circleId: 'reinvited-circle', seedHex: oldSeed, name: 'Even Older Invite', inviterSk: inviterSk2, inviterPhonePk: inviterPhone2.pkHex,
      at: invite.created_at + 10,
    })
    const oldWrap = await wrapInvite(self.pkHex, oldInvite, oldStatement, inviterPhone2.skHex)
    await onPersonalInboxWrap(makeLocalSigner(self.skHex), oldWrap)

    expect(view(store.load())).not.toContain('Even Older Invite')
  })

  // Task 10 fix round 4: a future-dated invite (clock skew, or a hostile
  // inviter backdating their own signature into the future) must not push
  // the freshly-joined circle's `epochStartedAt` ahead of our own clock —
  // that would let a later, legitimately-dated re-invite for the SAME
  // epoch get rejected by `invitePasses`'s date gate as if it predated an
  // epoch that, from our own clock, hasn't started yet.
  it('accepting a future-dated invite clamps epochStartedAt to now, not the invite\'s own (future) createdAt', async () => {
    const self = realKeypair()
    const inviterSk = generateSecretKey()
    const inviterPhone = realKeypair()
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
    store.save(fakePersisted({}))

    const now = Math.floor(Date.now() / 1000)
    const { invite, statement } = buildInvite({ to: self.pkHex,
      circleId: 'future-circle', seedHex: '3'.repeat(64), name: 'Future Invite', inviterSk, inviterPhonePk: inviterPhone.pkHex,
      at: now + 3_600, // an hour in the future
    })
    const wrap = await wrapInvite(self.pkHex, invite, statement, inviterPhone.skHex)
    await onPersonalInboxWrap(makeLocalSigner(self.skHex), wrap)
    expect(view(store.load())).toContain('Future Invite')
    handleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)

    const joined = store.load().circles.find((c) => c.id === 'future-circle')
    expect(joined?.epochStartedAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000))
  })
})

describe('join-time trust anchors', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(publishSigned).mockClear()
    vi.mocked(publishSigned).mockImplementation(async () => ({}))
  })

  it('accepting an invite seeds the inviter into the placeholder roster as a peer (final fix A8), and binds their statement', async () => {
    const self = realKeypair()
    const inviterSk = generateSecretKey()
    const inviterPk = getPublicKey(inviterSk)
    const inviterPhone = realKeypair()
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
    store.save(fakePersisted({}))

    const { invite, statement } = buildInvite({ to: self.pkHex,
      circleId: 'anchored-circle', seedHex: '4'.repeat(64), name: 'Anchored', inviterSk, inviterPhonePk: inviterPhone.pkHex,
    })
    const wrap = await wrapInvite(self.pkHex, invite, statement, inviterPhone.skHex)
    await onPersonalInboxWrap(makeLocalSigner(self.skHex), wrap)
    handleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)

    const circle = store.load().circles.find((c) => c.id === 'anchored-circle')
    // Final fix A8: least privilege — a peer until the signed config arrives.
    expect(circle?.members.some((m) => m.pk === inviterPk && m.role === 'peer')).toBe(true)
    // Still a silent placeholder — it must lose to the first real broadcast.
    expect(circle?.configUpdatedAt).toBe(0)
    expect(circle?.configBy).toBe('')
    // The inviter's device statement (carried alongside the invite) is bound
    // into the new circle's phone-key table.
    expect(memberForPhone('anchored-circle', inviterPhone.pkHex)).toBe(inviterPk)
  })
})

// Signet identity plan, Task 10: persistent, wrap-id dedup — checked before
// any decrypt (not the old content-bound rumor-id dedup, which required
// decrypting first). `seenPersonalWraps` is store-persisted, so it survives
// a restart, unlike the old in-memory set it replaces.
describe('onPersonalInboxWrap — persistent wrap-id dedup', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })

  it('a wrap already recorded in seenPersonalWraps (as it would be after a restart) is skipped before any decrypt', async () => {
    const self = realKeypair()
    const sender = realKeypair()
    const wrap = await giftWrap(makeLocalSigner(sender.skHex), self.pkHex, { kind: 14, content: JSON.stringify({ invite: {}, statement: {} }), tags: [] })
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
    store.save(fakePersisted({ seenPersonalWraps: [wrap.id] }))

    let decryptCalls = 0
    const countingSigner: Signer = {
      pubkey: self.pkHex,
      signEvent: async () => { throw new Error('unused in this test') },
      nip44Encrypt: async () => { throw new Error('unused in this test') },
      nip44Decrypt: async (pk, ct) => { decryptCalls++; return makeLocalSigner(self.skHex).nip44Decrypt(pk, ct) },
    }

    await onPersonalInboxWrap(countingSigner, wrap)

    expect(decryptCalls).toBe(0)
  })

  it('a fresh wrap costs exactly two remote decrypts (wrap layer, then seal); a re-delivery after a restart costs none', async () => {
    const bunker = fakeBunker({})
    const selfPhone = realKeypair()
    sessionForTests({ identityPk: bunker.pubkey, phoneSkHex: selfPhone.skHex, dependant: false, transport: bunker })
    store.save(fakePersisted({}))

    const inviterSk = generateSecretKey()
    const inviterPhone = realKeypair()
    const { invite, statement } = buildInvite({ to: bunker.pubkey,
      circleId: 'dedup-circle', seedHex: '8'.repeat(64), name: 'Dedup Circle', inviterSk, inviterPhonePk: inviterPhone.pkHex,
    })
    const wrap = await wrapInvite(bunker.pubkey, invite, statement, inviterPhone.skHex)

    await onPersonalInboxWrap(identitySigner(), wrap)
    expect(bunker.requests.filter((r) => r.method === 'nip44_decrypt')).toHaveLength(2)
    expect(store.load().seenPersonalWraps).toContain(wrap.id)

    // "Restart": `seenPersonalWraps` is store-persisted (backed by the fake
    // localStorage), so redelivering the identical wrap must not pay
    // another decrypt, restart or not.
    await onPersonalInboxWrap(identitySigner(), wrap)
    expect(bunker.requests.filter((r) => r.method === 'nip44_decrypt')).toHaveLength(2)

    // Clean up module-level pendingInvite so it doesn't leak into other tests.
    handleAction('circle-decline', { dataset: {} } as unknown as HTMLElement)
  })

  it('two concurrent deliveries of the same wrap decrypt it only once (in-flight dedup, Task 10 fix round 1 finding 6)', async () => {
    const bunker = fakeBunker({})
    const selfPhone = realKeypair()
    sessionForTests({ identityPk: bunker.pubkey, phoneSkHex: selfPhone.skHex, dependant: false, transport: bunker })
    store.save(fakePersisted({}))

    const inviterSk = generateSecretKey()
    const inviterPhone = realKeypair()
    const { invite, statement } = buildInvite({ to: bunker.pubkey,
      circleId: 'inflight-circle', seedHex: 'c'.repeat(64), name: 'Inflight Circle', inviterSk, inviterPhonePk: inviterPhone.pkHex,
    })
    const wrap = await wrapInvite(bunker.pubkey, invite, statement, inviterPhone.skHex)

    // Fire both WITHOUT awaiting the first — each runs its synchronous
    // prefix (the seen/in-flight checks) before either commits, same
    // interleaving as the `inviteToCircle` concurrency regression above.
    const p1 = onPersonalInboxWrap(identitySigner(), wrap)
    const p2 = onPersonalInboxWrap(identitySigner(), wrap)
    await Promise.all([p1, p2])

    // Two remote decrypts total (wrap layer, then seal) — not four.
    expect(bunker.requests.filter((r) => r.method === 'nip44_decrypt')).toHaveLength(2)
    expect(store.load().seenPersonalWraps).toContain(wrap.id)

    handleAction('circle-decline', { dataset: {} } as unknown as HTMLElement)
  })
})

describe('ensure — the personal inbox is adults-only', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(subscribeGiftWraps).mockClear()
  })

  it('a dependant session never subscribes the personal inbox', () => {
    const identityPk = realKeypair().pkHex
    sessionForTests({ identityPk, phoneSkHex: realKeypair().skHex, dependant: true, transport: fakeBunker({}) })
    store.save(fakePersisted({}))

    ensure(store.load())

    const tags = vi.mocked(subscribeGiftWraps).mock.calls.map((c) => c[1])
    expect(tags).not.toContain(personalInboxTag(identityPk))
  })

  it('a non-dependant (adult) session subscribes the personal inbox', () => {
    const identityPk = realKeypair().pkHex
    sessionForTests({ identityPk, phoneSkHex: realKeypair().skHex, dependant: false, transport: fakeBunker({}) })
    store.save(fakePersisted({}))

    ensure(store.load())

    const tags = vi.mocked(subscribeGiftWraps).mock.calls.map((c) => c[1])
    expect(tags).toContain(personalInboxTag(identityPk))
  })
})

describe('invite round trip — identity-signed personal inbox invite', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(publishSigned).mockClear()
    vi.mocked(publishSigned).mockResolvedValue({} as never)
  })

  it('an adult inviter sends an identity-signed invite; the adult invitee decrypts it via identitySigner() and can accept', async () => {
    const inviterBunker = fakeBunker({})
    const inviterPhone = realKeypair()
    const inviteeBunker = fakeBunker({})
    const inviteePhone = realKeypair()
    const now = Math.floor(Date.now() / 1000)

    const circle = fakeCircle({ id: 'round-trip-circle', members: [{ pk: inviterBunker.pubkey, role: 'guardian', name: 'Inviter' }] })
    store.save(fakePersisted({ circles: [circle] }))

    // Inviter's own device statement — normally issued at sign-in (Task 11);
    // fabricated here as an already-established precondition, the way
    // doInvite expects to find it on `currentSession().statement`.
    const inviterStatement = await inviterBunker.signEvent(deviceStatementTemplate(inviterPhone.pkHex, now))
    sessionForTests({
      identityPk: inviterBunker.pubkey, phoneSkHex: inviterPhone.skHex, dependant: false,
      statement: inviterStatement, transport: inviterBunker,
    })
    const signsBeforeInvite = inviterBunker.requests.filter((r) => r.method === 'sign_event').length

    // One process stands in for both devices, so one grant knows both.
    knowContacts(inviteeBunker.pubkey, inviterBunker.pubkey)
    await inviteToCircle('round-trip-circle', inviteeBunker.pubkey)

    // One remote sign_event for the invite itself, then one for the roster
    // config it queues (final fix A2: both go through the structural queue,
    // whose senders the invite path registers). The invite wrap is the
    // first publish.
    expect(inviterBunker.requests.filter((r) => r.method === 'sign_event').length - signsBeforeInvite).toBe(2)
    const [, wrap] = vi.mocked(publishSigned).mock.calls[0] as [string[], { id: string; pubkey: string; content: string; tags: string[][] }]

    // Switch to the invitee's own session AND device — a fresh, empty local
    // store, since this is a separate device from the inviter's; the shared
    // `store` module here stands in for two different devices, one at a
    // time, not one shared store between them.
    store.save(fakePersisted({}))
    sessionForTests({ identityPk: inviteeBunker.pubkey, phoneSkHex: inviteePhone.skHex, dependant: false, transport: inviteeBunker })
    await onPersonalInboxWrap(identitySigner(), wrap)

    expect(inviteeBunker.requests.filter((r) => r.method === 'nip44_decrypt')).toHaveLength(2)
    expect(view(store.load())).toContain('Test circle')

    handleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)

    const joined = store.load().circles.find((c) => c.id === 'round-trip-circle')
    expect(joined?.members.some((m) => m.pk === inviteeBunker.pubkey)).toBe(true)
    expect(joined?.members.some((m) => m.pk === inviterBunker.pubkey && m.role === 'peer')).toBe(true)
    expect(memberForPhone('round-trip-circle', inviterPhone.pkHex)).toBe(inviterBunker.pubkey)
  })
})

describe('final fix A2: invites go through the structural queue', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(publishSigned).mockClear()
    vi.mocked(publishSigned).mockResolvedValue({} as never)
    structuralQueue.resetForTests()
  })
  afterEach(() => {
    structuralQueue.resetForTests()
    sessionForTests(null)
    vi.useRealTimers()
  })

  it('an invite enqueued while the bunker is asleep (longer than the old 60 s deadline) is sent after it wakes', async () => {
    vi.useFakeTimers()
    let asleep = true
    const bunker = fakeBunker({ asleep: () => asleep })
    const selfPhone = realKeypair()
    const invitee = realKeypair()
    const statement = finalizeEvent(deviceStatementTemplate(selfPhone.pkHex, Math.floor(Date.now() / 1000)), generateSecretKey()) as SignedEvent
    sessionForTests({ identityPk: bunker.pubkey, phoneSkHex: selfPhone.skHex, dependant: false, statement, transport: bunker })
    store.save(fakePersisted({ circles: [fakeCircle({ id: 'asleep-circle', members: [{ pk: bunker.pubkey, role: 'guardian' }] })] }))
    const sentTo = (): Array<string | undefined> => vi.mocked(publishSigned).mock.calls.map((c) => (c[1] as unknown as SignedEvent).tags.find((t) => t[0] === 'p')?.[1])

    knowContacts(invitee.pkHex)
    void inviteToCircle('asleep-circle', invitee.pkHex)
    await vi.advanceTimersByTimeAsync(90_000)
    expect(structuralQueue.pending()).toMatchObject([{ action: 'invite', status: 'waiting', recipientPk: invitee.pkHex }])
    expect(sentTo()).not.toContain(personalInboxTag(invitee.pkHex))
    expect(store.load().circles[0]?.members.map((m) => m.pk)).not.toContain(invitee.pkHex)

    asleep = false
    await vi.advanceTimersByTimeAsync(2_000)
    expect(sentTo()).toContain(personalInboxTag(invitee.pkHex))
    expect(store.load().circles[0]?.members.map((m) => m.pk)).toContain(invitee.pkHex)
    expect(structuralQueue.pending().some((q) => q.action === 'invite')).toBe(false)
  })
})

describe('final fix round 2, R3: an invite the sender drops is not reported as sent', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(publishSigned).mockClear()
    vi.mocked(publishSigned).mockResolvedValue({} as never)
    structuralQueue.resetForTests()
  })
  afterEach(() => {
    structuralQueue.resetForTests()
    sessionForTests(null)
    vi.useRealTimers()
  })

  it('a tombstone landing while the invite waits for the signer drops it with the refusal notice, not "Invite sent."', async () => {
    vi.useFakeTimers()
    let asleep = true
    const bunker = fakeBunker({ asleep: () => asleep })
    const selfPhone = realKeypair()
    const invitee = realKeypair()
    const statement = finalizeEvent(deviceStatementTemplate(selfPhone.pkHex, Math.floor(Date.now() / 1000)), generateSecretKey()) as SignedEvent
    sessionForTests({ identityPk: bunker.pubkey, phoneSkHex: selfPhone.skHex, dependant: false, statement, transport: bunker })
    store.save(fakePersisted({ circles: [fakeCircle({ id: 'tomb-circle', members: [{ pk: bunker.pubkey, role: 'guardian' }] })] }))
    handleAction('circle-invite-open', { dataset: { circle: 'tomb-circle' } } as unknown as HTMLElement)

    knowContacts(invitee.pkHex)
    const done = inviteToCircle('tomb-circle', invitee.pkHex)
    await vi.advanceTimersByTimeAsync(1_000)
    store.update((p) => {
      const c = p.circles[0]!
      p.circles[0] = { ...c, removedPks: [invitee.pkHex], removals: { [invitee.pkHex]: { at: Math.floor(Date.now() / 1000) + 1_000_000, hash: 'f'.repeat(64) } } }
    })
    asleep = false
    await vi.advanceTimersByTimeAsync(2_000)
    await done
    expect(structuralQueue.pending()).toEqual([])
    expect(view(store.load())).not.toContain('Invite sent.')
    expect(view(store.load())).toContain("Can't re-invite right now")
    handleAction('circle-invite-done', { dataset: {} } as unknown as HTMLElement)
  })
})

// Plan 2, Task 6: invites from contacts, vouched invite bundles, and
// dependant invites through a linked guardian.
describe('plan 2, Task 6: contacts-only invites and vouched bundles', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(publishSigned).mockClear()
    vi.mocked(publishSigned).mockResolvedValue({} as never)
    structuralQueue.resetForTests()
  })
  afterEach(() => {
    handleAction('circle-decline', { dataset: {} } as unknown as HTMLElement)
    handleAction('circle-invite-done', { dataset: {} } as unknown as HTMLElement)
    structuralQueue.resetForTests()
    sessionForTests(null)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  const nowS = (): number => Math.floor(Date.now() / 1000)

  /** A signed `invite` vouch by `bySk` for `pk` at `role` in `circleId`. */
  function vouchBy(bySk: Uint8Array, circleId: string, seedHex: string, pk: string, role: 'guardian' | 'peer' | 'child'): SignedEvent {
    const payload = JSON.stringify({ id: circleId, name: 'Bundled', mode: 'family', pk, role })
    return finalizeEvent(structuralTemplate({ action: 'invite', circleId, prevSeedHash: seedHash(seedHex), payload, nowSec: nowS() - 30 }), bySk) as SignedEvent
  }

  /** A signed config v2 by `bySk`. */
  function configBy(bySk: Uint8Array, circleId: string, seedHex: string, cfg: { createdBy: string; members: Array<{ pk: string; role: string; name?: string }>; vouches: SignedEvent[]; updatedAt?: number; at?: number }): SignedEvent {
    const by = getPublicKey(bySk)
    const at = cfg.at ?? nowS() - 20
    const payload = JSON.stringify({ v: 2, id: circleId, name: 'Bundled', createdBy: cfg.createdBy, updatedAt: cfg.updatedAt ?? at, by, members: cfg.members, vouches: cfg.vouches })
    return finalizeEvent(structuralTemplate({ action: 'config', circleId, prevSeedHash: seedHash(seedHex), payload, nowSec: at }), bySk) as SignedEvent
  }

  /** A signed guardian-of / dependant-of pair. */
  function linkPairOf(gSk: Uint8Array, dSk: Uint8Array): { g: SignedEvent; d: SignedEvent } {
    const at = nowS() - 60
    return {
      g: finalizeEvent(guardianOfTemplate(getPublicKey(dSk), at), gSk) as SignedEvent,
      d: finalizeEvent(dependantOfTemplate(getPublicKey(gSk), at), dSk) as SignedEvent,
    }
  }

  describe('receiving (adult, personal inbox)', () => {
    it('an invite from a usable contact is shown; one from a stranger is dropped silently', async () => {
      const self = realKeypair()
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
      store.save(fakePersisted({}))
      const friendSk = generateSecretKey()
      const friendPhone = realKeypair()
      const ok = buildInvite({ to: self.pkHex, circleId: 'friend-circle', seedHex: '3'.repeat(64), name: 'Friend Circle', inviterSk: friendSk, inviterPhonePk: friendPhone.pkHex })
      await onPersonalInboxWrap(makeLocalSigner(self.skHex), await wrapInvite(self.pkHex, ok.invite, ok.statement, friendPhone.skHex))
      expect(view(store.load())).toContain('Friend Circle')
      handleAction('circle-decline', { dataset: {} } as unknown as HTMLElement)

      const strangerSk = generateSecretKey()
      const strangerPhone = realKeypair()
      const bad = buildInvite({ to: self.pkHex, circleId: 'stranger-circle', seedHex: '4'.repeat(64), name: 'Stranger Circle', inviterSk: strangerSk, inviterPhonePk: strangerPhone.pkHex, stranger: true })
      await onPersonalInboxWrap(makeLocalSigner(self.skHex), await wrapInvite(self.pkHex, bad.invite, bad.statement, strangerPhone.skHex))
      const html = view(store.load())
      expect(html).not.toContain('Circle invite')
      expect(html).not.toContain('Stranger Circle')
      expect(store.load().circles).toEqual([])
    })

    it('an invite is dropped while the contacts grant is not known, even from a linked pk', async () => {
      const self = realKeypair()
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
      store.save(fakePersisted({}))
      const inviterSk = generateSecretKey()
      const inviterPhone = realKeypair()
      const inv = buildInvite({ to: self.pkHex, circleId: 'unknown-grant', seedHex: '5'.repeat(64), name: 'Unknown Grant', inviterSk, inviterPhonePk: inviterPhone.pkHex, stranger: true })
      setContactsSource(fakeContacts({ status: 'none', contacts: [] }))
      await onPersonalInboxWrap(makeLocalSigner(self.skHex), await wrapInvite(self.pkHex, inv.invite, inv.statement, inviterPhone.skHex))
      expect(view(store.load())).not.toContain('Unknown Grant')
    })

    it('an invite naming someone else (payload pk) is dropped', async () => {
      const self = realKeypair()
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
      store.save(fakePersisted({}))
      const inviterSk = generateSecretKey()
      const inviterPhone = realKeypair()
      const inv = buildInvite({ to: realKeypair().pkHex, circleId: 'other-pk', seedHex: '6'.repeat(64), name: 'Someone Else', inviterSk, inviterPhonePk: inviterPhone.pkHex })
      await onPersonalInboxWrap(makeLocalSigner(self.skHex), await wrapInvite(self.pkHex, inv.invite, inv.statement, inviterPhone.skHex))
      expect(view(store.load())).not.toContain('Someone Else')
    })

    it('the joiner bootstraps its roster from the bundle config: a member with a forged or outside vouch is left out; creator, vouches and clock are stored', async () => {
      const self = realKeypair()
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
      store.save(fakePersisted({}))
      const seed = '7'.repeat(64)
      const gSk = generateSecretKey()
      const G = getPublicKey(gSk)
      const gPhone = realKeypair()
      const m1 = realKeypair()
      const m2 = realKeypair()
      const m3 = realKeypair()
      const outsiderSk = generateSecretKey()
      const tampered = { ...vouchBy(gSk, 'boot-circle', seed, m3.pkHex, 'peer') }
      tampered.sig = tampered.sig.replace(/^./, (c) => (c === '0' ? '1' : '0'))
      const cfgEv = configBy(gSk, 'boot-circle', seed, {
        createdBy: G,
        members: [{ pk: G, role: 'guardian', name: 'Gwen' }, { pk: m1.pkHex, role: 'peer' }, { pk: m2.pkHex, role: 'peer' }, { pk: m3.pkHex, role: 'peer' }],
        vouches: [vouchBy(gSk, 'boot-circle', seed, m1.pkHex, 'peer'), vouchBy(outsiderSk, 'boot-circle', seed, m2.pkHex, 'peer'), tampered],
      })
      const inv = buildInvite({ to: self.pkHex, circleId: 'boot-circle', seedHex: seed, name: 'Boot Circle', inviterSk: gSk, inviterPhonePk: gPhone.pkHex })
      await onPersonalInboxWrap(makeLocalSigner(self.skHex), await wrapInvite(self.pkHex, inv.invite, inv.statement, gPhone.skHex, undefined, { config: cfgEv }))
      expect(view(store.load())).toContain('Boot Circle')
      handleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)

      const joined = store.load().circles.find((c) => c.id === 'boot-circle')!
      expect(joined.members.map((m) => m.pk).sort()).toEqual([G, m1.pkHex, self.pkHex].sort())
      expect(joined.members.find((m) => m.pk === G)?.role).toBe('guardian')
      expect(joined.members.find((m) => m.pk === self.pkHex)?.role).toBe('peer')
      expect(creatorOf('boot-circle')).toBe(G)
      expect(vouchFor('boot-circle', m1.pkHex)?.by).toBe(G)
      expect(vouchFor('boot-circle', self.pkHex)?.by).toBe(G)
      expect(joined.configBy).toBe(G)
      expect(memberForPhone('boot-circle', gPhone.pkHex)).toBe(G)
    })

    it('the bundle re-key\'s removals leave the joiner\'s roster; a config that re-admitted after it keeps the member (pre-review ruling 3)', async () => {
      const self = realKeypair()
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
      store.save(fakePersisted({}))
      const oldSeed = 'a'.repeat(64)
      const seed = 'b'.repeat(64)
      const gSk = generateSecretKey()
      const G = getPublicKey(gSk)
      const gPhone = realKeypair()
      const x = realKeypair()
      const members = [{ pk: G, role: 'guardian' }, { pk: x.pkHex, role: 'peer' }]
      const vouches = [vouchBy(gSk, 'rk-circle', oldSeed, x.pkHex, 'peer')]
      const rekeyPayload = JSON.stringify({ id: 'rk-circle', next: seedHash(seed), prev: seedHash(oldSeed), removals: [x.pkHex], to: [] })
      const rekey = finalizeEvent(structuralTemplate({ action: 'rekey', circleId: 'rk-circle', prevSeedHash: seedHash(oldSeed), payload: rekeyPayload, nowSec: nowS() - 50 }), gSk) as SignedEvent

      // The held config predates the re-key: X is dropped.
      const stale = configBy(gSk, 'rk-circle', oldSeed, { createdBy: G, members, vouches, at: nowS() - 100 })
      const inv = buildInvite({ to: self.pkHex, circleId: 'rk-circle', seedHex: seed, name: 'Rekeyed', inviterSk: gSk, inviterPhonePk: gPhone.pkHex })
      await onPersonalInboxWrap(makeLocalSigner(self.skHex), await wrapInvite(self.pkHex, inv.invite, inv.statement, gPhone.skHex, undefined, { config: stale, rekey }))
      handleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)
      expect(store.load().circles.find((c) => c.id === 'rk-circle')?.members.map((m) => m.pk).sort()).toEqual([G, self.pkHex].sort())

      // A config dated after the re-key, on its seed, re-admitted X.
      store.save(fakePersisted({}))
      const readmit = configBy(gSk, 'rk-circle', seed, { createdBy: G, members, vouches, at: nowS() - 10 })
      const inv2 = buildInvite({ to: self.pkHex, circleId: 'rk-circle', seedHex: seed, name: 'Readmitted', inviterSk: gSk, inviterPhonePk: gPhone.pkHex })
      await onPersonalInboxWrap(makeLocalSigner(self.skHex), await wrapInvite(self.pkHex, inv2.invite, inv2.statement, gPhone.skHex, undefined, { config: readmit, rekey }))
      handleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)
      expect(store.load().circles.find((c) => c.id === 'rk-circle')?.members.map((m) => m.pk)).toContain(x.pkHex)
    })

    it('a bundle re-key that does not verify, or not by a roster member, drops the invite', async () => {
      const self = realKeypair()
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
      store.save(fakePersisted({}))
      const seed = 'c'.repeat(64)
      const gSk = generateSecretKey()
      const gPhone = realKeypair()
      const cfgEv = configBy(gSk, 'rk-bad', seed, { createdBy: getPublicKey(gSk), members: [{ pk: getPublicKey(gSk), role: 'guardian' }], vouches: [] })
      const outsider = generateSecretKey()
      const payload = JSON.stringify({ id: 'rk-bad', next: seedHash(seed), prev: seedHash('d'.repeat(64)), removals: [], to: [] })
      const rekey = finalizeEvent(structuralTemplate({ action: 'rekey', circleId: 'rk-bad', prevSeedHash: seedHash('d'.repeat(64)), payload, nowSec: nowS() - 5 }), outsider) as SignedEvent
      const inv = buildInvite({ to: self.pkHex, circleId: 'rk-bad', seedHex: seed, name: 'Outsider Rekey', inviterSk: gSk, inviterPhonePk: gPhone.pkHex })
      await onPersonalInboxWrap(makeLocalSigner(self.skHex), await wrapInvite(self.pkHex, inv.invite, inv.statement, gPhone.skHex, undefined, { config: cfgEv, rekey }))
      expect(view(store.load())).not.toContain('Outsider Rekey')
    })

    it('a bundle config whose signature does not verify drops the invite', async () => {
      const self = realKeypair()
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false })
      store.save(fakePersisted({}))
      const seed = '8'.repeat(64)
      const gSk = generateSecretKey()
      const gPhone = realKeypair()
      const cfgEv = { ...configBy(gSk, 'bad-cfg', seed, { createdBy: getPublicKey(gSk), members: [{ pk: getPublicKey(gSk), role: 'guardian' }], vouches: [] }), content: '{"v":2}' }
      const inv = buildInvite({ to: self.pkHex, circleId: 'bad-cfg', seedHex: seed, name: 'Bad Config', inviterSk: gSk, inviterPhonePk: gPhone.pkHex })
      await onPersonalInboxWrap(makeLocalSigner(self.skHex), await wrapInvite(self.pkHex, inv.invite, inv.statement, gPhone.skHex, undefined, { config: cfgEv }))
      expect(view(store.load())).not.toContain('Bad Config')
    })
  })

  describe('receiving (dependant, phone inbox)', () => {
    /** A dependant session; the invite is wrapped to its phone inbox. */
    async function dependantReceives(opts: { role?: 'child' | 'peer'; links?: (gSk: Uint8Array, depSk: Uint8Array) => Array<{ g: SignedEvent; d: SignedEvent }>; config?: (gSk: Uint8Array, seed: string, depPk: string) => SignedEvent }): Promise<{ depPk: string; G: string; circleId: string }> {
      const depSk = generateSecretKey()
      const depPk = getPublicKey(depSk)
      const depPhone = realKeypair()
      sessionForTests({ identityPk: depPk, phoneSkHex: depPhone.skHex, dependant: true })
      store.save(fakePersisted({}))
      const gSk = generateSecretKey()
      const gPhone = realKeypair()
      const seed = '9'.repeat(64)
      const inv = buildInvite({ to: depPk, role: opts.role ?? 'child', circleId: 'family', seedHex: seed, name: 'Family', inviterSk: gSk, inviterPhonePk: gPhone.pkHex, stranger: true })
      const wrap = await wrapInvite(depPhone.pkHex, inv.invite, inv.statement, gPhone.skHex, undefined, {
        config: opts.config ? opts.config(gSk, seed, depPk) : null,
        links: opts.links ? opts.links(gSk, depSk) : [],
      }, personalInboxTag(depPhone.pkHex))
      await onPhoneInboxWrap(wrap)
      return { depPk, G: getPublicKey(gSk), circleId: 'family' }
    }

    it('accepts a child invite from a linked guardian (the bundle carries the pair)', async () => {
      const { depPk, G } = await dependantReceives({ links: (g, d) => [linkPairOf(g, d)] })
      expect(view(store.load())).toContain('Family')
      handleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)
      const joined = store.load().circles.find((c) => c.id === 'family')!
      expect(joined.members.find((m) => m.pk === depPk)?.role).toBe('child')
      expect(joined.members.some((m) => m.pk === G)).toBe(true)
      expect(linked(G, depPk)).toBe(true)
      expect(vouchFor('family', depPk)?.by).toBe(G)
    })

    it('refuses an invite from an unlinked adult', async () => {
      await dependantReceives({})
      expect(view(store.load())).not.toContain('Circle invite')
      expect(store.load().circles).toEqual([])
    })

    it('refuses an invite whose link is one-sided', async () => {
      const { G, depPk } = await dependantReceives({
        links: (g, d) => {
          const pair = linkPairOf(g, d)
          // The dependant's side names someone else: only the guardian's claim stands.
          const other = finalizeEvent(dependantOfTemplate(realKeypair().pkHex, nowS() - 60), d) as SignedEvent
          return [{ g: pair.g, d: other }]
        },
      })
      expect(view(store.load())).not.toContain('Circle invite')
      expect(linked(G, depPk)).toBe(false)
    })

    it('refuses a linked guardian\'s invite with role peer', async () => {
      await dependantReceives({ role: 'peer', links: (g, d) => [linkPairOf(g, d)] })
      expect(view(store.load())).not.toContain('Circle invite')
    })

    it('keeps a member who is not in the dependant\'s contacts', async () => {
      const stranger = realKeypair()
      await dependantReceives({
        links: (g, d) => [linkPairOf(g, d)],
        config: (gSk, seed) => configBy(gSk, 'family', seed, {
          createdBy: getPublicKey(gSk),
          members: [{ pk: getPublicKey(gSk), role: 'guardian' }, { pk: stranger.pkHex, role: 'peer' }],
          vouches: [vouchBy(gSk, 'family', seed, stranger.pkHex, 'peer')],
        }),
      })
      handleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)
      expect(store.load().circles.find((c) => c.id === 'family')?.members.map((m) => m.pk)).toContain(stranger.pkHex)
    })
  })

  describe('sending', () => {
    async function adultSession(): Promise<{ bunker: ReturnType<typeof fakeBunker>; phone: { skHex: string; pkHex: string } }> {
      const bunker = fakeBunker({})
      const phone = realKeypair()
      const statement = await bunker.signEvent(deviceStatementTemplate(phone.pkHex, nowS()))
      sessionForTests({ identityPk: bunker.pubkey, phoneSkHex: phone.skHex, dependant: false, statement, transport: bunker })
      return { bunker, phone }
    }

    it('a dependant session can queue an invite for a usable contact (the queue label shows)', async () => {
      vi.useFakeTimers()
      const bunker = fakeBunker({ dependant: true, asleep: () => true })
      const selfPhone = realKeypair()
      const statement = finalizeEvent(deviceStatementTemplate(selfPhone.pkHex, nowS()), generateSecretKey()) as SignedEvent
      sessionForTests({ identityPk: bunker.pubkey, phoneSkHex: selfPhone.skHex, dependant: true, statement, transport: bunker })
      store.save(fakePersisted({ circles: [fakeCircle({ id: 'dep-circle', members: [{ pk: PK_A, role: 'guardian' }, { pk: bunker.pubkey, role: 'child' }] })] }))
      const friend = realKeypair()
      knowContacts(friend.pkHex)
      void inviteToCircle('dep-circle', friend.pkHex)
      await vi.advanceTimersByTimeAsync(1_000)
      const items = structuralQueue.pending().filter((q) => q.action === 'invite')
      expect(items).toMatchObject([{ status: 'waiting', recipientPk: friend.pkHex }])
      expect(JSON.parse(items[0]!.payload)).toMatchObject({ pk: friend.pkHex, role: 'peer' })
      expect(structuralQueue.view()).toContain(`Invite Contact ${friend.pkHex.slice(0, 4)} to Test circle`)
      expect(structuralQueue.view()).toContain('Waiting for your parent')
    })

    it('a pasted key that is not a usable contact is refused with the exact copy', async () => {
      await adultSession()
      const self = currentSession()!
      store.save(fakePersisted({ circles: [fakeCircle({ id: 'paste-circle', members: [{ pk: self.identityPk, role: 'guardian' }] })] }))
      handleAction('circle-invite-open', { dataset: { circle: 'paste-circle' } } as unknown as HTMLElement)
      await inviteToCircle('paste-circle', realKeypair().pkHex)
      expect(view(store.load())).toContain('Only people you have met can be added.')
      expect(structuralQueue.pending()).toEqual([])
      expect(vi.mocked(publishSigned)).not.toHaveBeenCalled()
    })

    it('sendInvite posts the signed invite into the circle (t:vouch-post) before it enqueues the config', async () => {
      await adultSession()
      const self = currentSession()!
      store.save(fakePersisted({ circles: [fakeCircle({ id: 'order-circle', members: [{ pk: self.identityPk, role: 'guardian' }] })] }))
      const friend = realKeypair()
      knowContacts(friend.pkHex)
      const postSpy = vi.spyOn(beacons, 'postVouch')
      const enqueueSpy = vi.spyOn(structuralQueue, 'enqueue')
      await inviteToCircle('order-circle', friend.pkHex)
      expect(postSpy).toHaveBeenCalledTimes(1)
      const posted = postSpy.mock.calls[0]![1]
      expect(JSON.parse(posted.content)).toMatchObject({ pk: friend.pkHex, role: 'peer' })
      const configCall = enqueueSpy.mock.calls.findIndex((c) => c[0].action === 'config')
      expect(configCall).toBeGreaterThanOrEqual(0)
      expect(postSpy.mock.invocationCallOrder[0]!).toBeLessThan(enqueueSpy.mock.invocationCallOrder[configCall]!)
      // The invitee is added at the role the invite names, with its vouch.
      const after = store.load().circles.find((c) => c.id === 'order-circle')!
      expect(after.members.find((m) => m.pk === friend.pkHex)?.role).toBe('peer')
      expect(vouchFor('order-circle', friend.pkHex)?.by).toBe(self.identityPk)
    })

    it('inviteDependantToCircle wraps the bundle to the dependant\'s phone inbox; the dependant accepts it', async () => {
      await adultSession()
      const G = currentSession()!.identityPk
      const depSk = generateSecretKey()
      const depPk = getPublicKey(depSk)
      const depPhone = realKeypair()
      const home = fakeCircle({ id: 'home', members: [{ pk: G, role: 'guardian' }, { pk: depPk, role: 'child', name: 'Kid' }] })
      store.save(fakePersisted({ circles: [home] }))
      // A circle created here: its first config is signed at creation and
      // held, so the bundle carries it.
      createCircleNow('Club')
      await structuralQueue.drain()
      const clubId = store.load().circles.find((c) => c.name === 'Club')!.id
      expect(acceptStatement(home, finalizeEvent(deviceStatementTemplate(depPhone.pkHex, nowS()), depSk) as SignedEvent, depPhone.pkHex, nowS())).toBe('added')
      // G's side of the link is signed by G's bunker identity.
      const bunkerSigner = identitySigner()
      const at = nowS() - 60
      const g = await bunkerSigner.signEvent(guardianOfTemplate(depPk, at))
      const d = finalizeEvent(dependantOfTemplate(G, at), depSk) as SignedEvent
      expect(acceptLinkPair(g, d)).toBe(true)

      await inviteDependantToCircle(clubId, depPk)
      const wraps = vi.mocked(publishSigned).mock.calls.map((c) => c[1] as unknown as SignedEvent)
      const tagOf = (w: SignedEvent): string | undefined => w.tags.find((t) => t[0] === 'p')?.[1]
      const toPhone = wraps.filter((w) => tagOf(w) === personalInboxTag(depPhone.pkHex))
      expect(toPhone).toHaveLength(1)
      expect(wraps.some((w) => tagOf(w) === personalInboxTag(depPk))).toBe(false)
      expect(store.load().circles.find((c) => c.id === clubId)?.members.find((m) => m.pk === depPk)?.role).toBe('child')

      // The dependant's own device.
      store.save(fakePersisted({}))
      sessionForTests({ identityPk: depPk, phoneSkHex: depPhone.skHex, dependant: true })
      await onPhoneInboxWrap(toPhone[0]!)
      expect(view(store.load())).toContain('Club')
      handleAction('circle-accept', { dataset: {} } as unknown as HTMLElement)
      const joined = store.load().circles.find((c) => c.id === clubId)!
      expect(joined.members.find((m) => m.pk === depPk)?.role).toBe('child')
      expect(joined.members.find((m) => m.pk === G)?.role).toBe('guardian')
      expect(creatorOf(clubId)).toBe(G)
    })

    it('reinviteDependantEverywhere queues one invite per shared circle and none where the guardian is not a member', async () => {
      vi.useFakeTimers()
      const bunker = fakeBunker({ asleep: () => true })
      const phone = realKeypair()
      const statement = finalizeEvent(deviceStatementTemplate(phone.pkHex, nowS()), generateSecretKey()) as SignedEvent
      sessionForTests({ identityPk: bunker.pubkey, phoneSkHex: phone.skHex, dependant: false, statement, transport: bunker })
      const G = bunker.pubkey
      const depSk = generateSecretKey()
      const depPk = getPublicKey(depSk)
      const other = realKeypair()
      store.save(fakePersisted({
        circles: [
          fakeCircle({ id: 's1', members: [{ pk: G, role: 'guardian' }, { pk: depPk, role: 'child' }] }),
          fakeCircle({ id: 's2', members: [{ pk: G, role: 'guardian' }, { pk: depPk, role: 'child' }] }),
          fakeCircle({ id: 'mine-only', members: [{ pk: G, role: 'guardian' }] }),
          fakeCircle({ id: 'not-mine', members: [{ pk: other.pkHex, role: 'guardian' }, { pk: depPk, role: 'child' }] }),
        ],
      }))
      // Unlinked: nothing is queued.
      expect(reinviteDependantEverywhere(depPk)).toBe(0)
      // The link table (guardian-links.ts reads only created_at once stored);
      // G's bunker is asleep, so the pair is planted directly.
      const at = nowS() - 60
      store.update((p) => { p.guardianLinks[`${G}:${depPk}`] = { g: { id: 'x', pubkey: G, created_at: at, kind: 30078, tags: [], content: '', sig: '' }, d: { id: 'y', pubkey: depPk, created_at: at, kind: 30078, tags: [], content: '', sig: '' } } })
      expect(linked(G, depPk)).toBe(true)
      expect(reinviteDependantEverywhere(depPk)).toBe(2)
      const items = structuralQueue.pending().filter((q) => q.action === 'invite')
      expect(items.map((q) => q.circleId).sort()).toEqual(['s1', 's2'])
      expect(items.every((q) => q.recipientPk === depPk && JSON.parse(q.payload).role === 'child')).toBe(true)
    })
  })

  describe('invite screen', () => {
    it('shows "Invite members" to every member, lists usable contacts, greys kens with one "Meet in person to add" button, and offers a guardian its linked dependants', async () => {
      const self = realKeypair()
      const phone = realKeypair()
      const statement = finalizeEvent(deviceStatementTemplate(phone.pkHex, nowS()), generateSecretKey()) as SignedEvent
      sessionForTests({ identityPk: self.pkHex, phoneSkHex: phone.skHex, dependant: false, statement })
      const depPk = realKeypair().pkHex
      const kin = realKeypair().pkHex
      const ken = realKeypair().pkHex
      store.save(fakePersisted({
        circles: [
          fakeCircle({ id: 'peer-circle', name: 'Peers', members: [{ pk: PK_A, role: 'guardian' }, { pk: self.pkHex, role: 'peer' }] }),
          fakeCircle({ id: 'home', name: 'Home', members: [{ pk: self.pkHex, role: 'guardian' }, { pk: depPk, role: 'child', name: 'Robin' }] }),
        ],
      }))
      store.update((p) => { p.guardianLinks[`${self.pkHex}:${depPk}`] = { g: { id: 'x', pubkey: self.pkHex, created_at: 1, kind: 30078, tags: [], content: '', sig: '' }, d: { id: 'y', pubkey: depPk, created_at: 1, kind: 30078, tags: [], content: '', sig: '' } } })
      setContactsSource(fakeContacts({
        status: 'connected',
        contacts: [
          { contactId: 'k1', pks: [kin], name: 'Kim', tier: 'kin', blocked: false },
          { contactId: 'k2', pks: [ken], name: 'Kenny', tier: 'ken', blocked: false },
        ],
      }))
      const list = view(store.load())
      expect(list).toContain('data-action="circle-invite-open" data-circle="peer-circle"')

      handleAction('circle-invite-open', { dataset: { circle: 'peer-circle' } } as unknown as HTMLElement)
      const html = view(store.load())
      expect(html).toContain(`data-action="circle-invite-contact" data-circle="peer-circle" data-pk="${kin}"`)
      expect(html).toContain('Kenny')
      expect(html).not.toContain(`data-pk="${ken}"`)
      expect(html.match(/Meet in person to add/g)?.length).toBeGreaterThanOrEqual(1)
      expect(html.match(/data-action="circle-meet-in-person"/g)).toHaveLength(1)
      expect(html).toContain('Add Robin (your dependant)')
      expect(html).toContain(`data-action="circle-invite-dependant" data-circle="peer-circle" data-pk="${depPk}"`)
    })
  })
})

describe('final fix B7 (part A5 UI): "Re-send invite" member row button', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(publishSigned).mockClear()
    structuralQueue.resetForTests()
  })
  afterEach(() => {
    structuralQueue.resetForTests()
    sessionForTests(null)
  })

  it('shows "Re-send invite" for a member with no known phone; tapping it queues an invite (circles.resendInvite)', () => {
    const circle = fakeCircle({
      id: 'resend-circle',
      members: [{ pk: PK_A, role: 'guardian', name: 'Alex' }, { pk: PK_B, role: 'guardian', name: 'Bea' }],
    })
    store.save(fakePersisted({ circles: [circle] }))
    const selfPhone = realKeypair()
    const statement = finalizeEvent(deviceStatementTemplate(selfPhone.pkHex, Math.floor(Date.now() / 1000)), generateSecretKey()) as SignedEvent
    sessionForTests({ identityPk: PK_A, phoneSkHex: selfPhone.skHex, dependant: false, statement })

    const html = view(store.load())
    expect(html).toContain(`data-action="circle-resend-invite" data-circle="resend-circle" data-pk="${PK_B}"`)

    handleAction('circle-resend-invite', { dataset: { circle: 'resend-circle', pk: PK_B } } as unknown as HTMLElement)
    expect(structuralQueue.pending()).toMatchObject([{ action: 'invite', status: 'waiting', recipientPk: PK_B }])
  })

  it('does not show "Re-send invite" for a member who already has a known phone', () => {
    const beaSk = generateSecretKey()
    const beaPk = getPublicKey(beaSk)
    const beaPhone = realKeypair()
    const circle = fakeCircle({
      id: 'bound-circle',
      members: [{ pk: PK_A, role: 'guardian', name: 'Alex' }, { pk: beaPk, role: 'guardian', name: 'Bea' }],
    })
    store.save(fakePersisted({ circles: [circle] }))
    const beaStatement = finalizeEvent(deviceStatementTemplate(beaPhone.pkHex, 1000), beaSk) as SignedEvent
    expect(acceptStatement(circle, beaStatement, beaPhone.pkHex, 1000)).toBe('added')

    const selfPhone = realKeypair()
    const statement = finalizeEvent(deviceStatementTemplate(selfPhone.pkHex, Math.floor(Date.now() / 1000)), generateSecretKey()) as SignedEvent
    sessionForTests({ identityPk: PK_A, phoneSkHex: selfPhone.skHex, dependant: false, statement })

    const html = view(store.load())
    expect(html).toContain('Bea') // sanity: the row itself renders
    expect(html).not.toContain('circle-resend-invite')
  })

  it('shows the refusal reason inline when circles.resendInvite() refuses (e.g. a dependant member)', () => {
    const circle = fakeCircle({
      id: 'refuse-circle',
      members: [{ pk: PK_A, role: 'guardian', name: 'Alex' }, { pk: PK_B, role: 'child', name: 'Kid' }],
    })
    store.save(fakePersisted({ circles: [circle] }))
    const selfPhone = realKeypair()
    const statement = finalizeEvent(deviceStatementTemplate(selfPhone.pkHex, Math.floor(Date.now() / 1000)), generateSecretKey()) as SignedEvent
    sessionForTests({ identityPk: PK_A, phoneSkHex: selfPhone.skHex, dependant: false, statement })

    handleAction('circle-resend-invite', { dataset: { circle: 'refuse-circle', pk: PK_B } } as unknown as HTMLElement)
    expect(view(store.load())).toContain('A dependant rejoins through their parent — pair their phone again in person.')
    expect(structuralQueue.pending()).toEqual([])
  })
})

describe('plan 2, Task 10: member row — "added by", "started this circle", mayRemove-gated Remove, Leave', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => {
    handleAction('circle-cancel', { dataset: {} } as unknown as HTMLElement)
    setContactsSource(null)
  })

  function plantVouch(circleId: string, seedHex: string, voucherSk: Uint8Array, pk: string, at: number): void {
    const ev = finalizeEvent(
      // An invite (final fix N1: only an original invite vouch is a member's voucher).
      structuralTemplate({ action: 'invite', circleId, prevSeedHash: seedHash(seedHex), payload: JSON.stringify({ id: circleId, name: 'F', mode: 'family', pk, role: 'peer' }), nowSec: at }),
      voucherSk,
    ) as SignedEvent
    const v = verifyVouch(ev)
    if (!v) throw new Error('bad test vouch')
    expect(storeVouch(v, { nowSec: at })).toBe(true)
  }

  it('creator\'s own row shows "started this circle" and a Leave button, never Remove', () => {
    const g = realKeypair()
    const m = realKeypair()
    const at = Math.floor(Date.now() / 1000)
    const circle = fakeCircle({
      id: 'c1', seedHex: '1'.repeat(64),
      members: [{ pk: g.pkHex, role: 'guardian', name: 'Guardian' }, { pk: m.pkHex, role: 'peer', name: 'Mira' }],
    })
    store.save(fakePersisted({ circles: [circle] }))
    setCreator('c1', g.pkHex)
    plantVouch('c1', circle.seedHex, hexToBytes(g.skHex), m.pkHex, at)
    sessionForTests({ identityPk: g.pkHex, phoneSkHex: realKeypair().skHex })

    const html = view(store.load())
    expect(html).toContain('started this circle')
    expect(html).toContain(`data-action="circle-leave" data-circle="c1"`)
    expect(html).not.toContain(`data-action="circle-remove-member" data-circle="c1" data-pk="${g.pkHex}"`)
    // Mira's row: vouched by the guardian, so "Remove" is offered (a
    // guardian may always remove), and "added by Guardian".
    expect(html).toContain('added by Guardian')
    expect(html).toContain(`data-action="circle-remove-member" data-circle="c1" data-pk="${m.pkHex}"`)
  })

  it('a non-guardian voucher sees Remove on their own vouchee, but not on an unrelated peer', () => {
    const g = realKeypair()
    const v = realKeypair()
    const m = realKeypair()
    const n = realKeypair()
    const at = Math.floor(Date.now() / 1000)
    const circle = fakeCircle({
      id: 'c1', seedHex: '1'.repeat(64),
      members: [
        { pk: g.pkHex, role: 'guardian', name: 'Guardian' },
        { pk: v.pkHex, role: 'peer', name: 'Voucher' },
        { pk: m.pkHex, role: 'peer', name: 'Mira' },
        { pk: n.pkHex, role: 'peer', name: 'Nadia' },
      ],
    })
    store.save(fakePersisted({ circles: [circle] }))
    setCreator('c1', g.pkHex)
    plantVouch('c1', circle.seedHex, hexToBytes(g.skHex), v.pkHex, at)
    plantVouch('c1', circle.seedHex, hexToBytes(v.skHex), m.pkHex, at)
    plantVouch('c1', circle.seedHex, hexToBytes(g.skHex), n.pkHex, at)
    sessionForTests({ identityPk: v.pkHex, phoneSkHex: realKeypair().skHex })

    const html = view(store.load())
    expect(html).toContain(`data-action="circle-remove-member" data-circle="c1" data-pk="${m.pkHex}"`)
    expect(html).not.toContain(`data-action="circle-remove-member" data-circle="c1" data-pk="${n.pkHex}"`)
    expect(html).toContain(`data-action="circle-leave" data-circle="c1"`)
  })

  it('a dependant viewing a member outside its own contacts, vouched by its linked guardian, sees "added by your guardian"', () => {
    const g = realKeypair()
    const d = realKeypair()
    const m = realKeypair()
    const at = Math.floor(Date.now() / 1000)
    const circle = fakeCircle({
      id: 'c1', seedHex: '1'.repeat(64),
      members: [
        { pk: g.pkHex, role: 'guardian', name: 'Guardian' },
        { pk: d.pkHex, role: 'child', name: 'Dep' },
        { pk: m.pkHex, role: 'peer', name: 'Mira' },
      ],
    })
    store.save(fakePersisted({ circles: [circle] }))
    setCreator('c1', g.pkHex)
    plantVouch('c1', circle.seedHex, hexToBytes(g.skHex), m.pkHex, at)
    store.update((p) => {
      p.guardianLinks[`${g.pkHex}:${d.pkHex}`] = {
        g: { id: 'x', pubkey: g.pkHex, created_at: at, kind: 30078, tags: [], content: '', sig: '' },
        d: { id: 'y', pubkey: d.pkHex, created_at: at, kind: 30078, tags: [], content: '', sig: '' },
      }
    })
    expect(linked(g.pkHex, d.pkHex)).toBe(true)
    // Mira is not one of the dependant's own contacts.
    setContactsSource(fakeContacts({ status: 'none' }))
    sessionForTests({ identityPk: d.pkHex, phoneSkHex: realKeypair().skHex, dependant: true })

    const html = view(store.load())
    expect(html).toContain('added by your guardian')
    expect(html).not.toContain('added by Guardian')
  })
})

describe('confirm before removing a member (a mis-tap removed someone during testing)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => {
    handleAction('circle-remove-member-cancel', { dataset: {} } as unknown as HTMLElement)
    sessionForTests(null)
  })

  function setUp(): { g: { skHex: string; pkHex: string }; m: { skHex: string; pkHex: string } } {
    const g = realKeypair()
    const m = realKeypair()
    const circle = fakeCircle({
      id: 'confirm-circle', name: 'Weekend crew',
      members: [{ pk: g.pkHex, role: 'guardian', name: 'Guardian' }, { pk: m.pkHex, role: 'peer', name: 'Mira' }],
    })
    store.save(fakePersisted({ circles: [circle] }))
    sessionForTests({ identityPk: g.pkHex, phoneSkHex: realKeypair().skHex })
    return { g, m }
  }

  it('the first tap arms an inline confirm and removes nobody', () => {
    const { m } = setUp()
    handleAction('circle-remove-member', { dataset: { circle: 'confirm-circle', pk: m.pkHex } } as unknown as HTMLElement)

    const html = view(store.load())
    expect(html).toContain("Remove Mira from Weekend crew? They'll lose access to the circle.")
    expect(html).toContain(`data-action="circle-remove-member-confirm" data-circle="confirm-circle" data-pk="${m.pkHex}"`)
    expect(html).toContain('data-action="circle-remove-member-cancel"')
    // Nobody removed: no rekey queued, no pending removal recorded.
    expect(structuralQueue.pending()).toEqual([])
    expect(store.load().pendingRemovals['confirm-circle']).toBeUndefined()
  })

  it('never shows the raw pubkey in the confirm copy', () => {
    const { m } = setUp()
    handleAction('circle-remove-member', { dataset: { circle: 'confirm-circle', pk: m.pkHex } } as unknown as HTMLElement)
    const confirmParagraph = /<p>Remove [^<]*<\/p>/.exec(view(store.load()))?.[0] ?? ''
    expect(confirmParagraph).not.toContain(m.pkHex)
    expect(confirmParagraph).toContain('Mira')
  })

  it('tapping Remove on the armed confirm proceeds with the removal', () => {
    const { m } = setUp()
    handleAction('circle-remove-member', { dataset: { circle: 'confirm-circle', pk: m.pkHex } } as unknown as HTMLElement)
    handleAction('circle-remove-member-confirm', { dataset: { circle: 'confirm-circle', pk: m.pkHex } } as unknown as HTMLElement)

    expect(store.load().pendingRemovals['confirm-circle']).toEqual([m.pkHex])
    // The confirm block is gone once actioned.
    expect(view(store.load())).not.toContain("They'll lose access to the circle.")
  })

  it('Cancel backs out without removing anyone', () => {
    const { m } = setUp()
    handleAction('circle-remove-member', { dataset: { circle: 'confirm-circle', pk: m.pkHex } } as unknown as HTMLElement)
    handleAction('circle-remove-member-cancel', { dataset: {} } as unknown as HTMLElement)

    const html = view(store.load())
    expect(html).not.toContain("They'll lose access to the circle.")
    expect(html).toContain(`data-action="circle-remove-member" data-circle="confirm-circle" data-pk="${m.pkHex}"`)
    expect(structuralQueue.pending()).toEqual([])
    expect(store.load().pendingRemovals['confirm-circle']).toBeUndefined()
  })

  it('navigating away (re-rendering the list view) without tapping Remove removes nobody', () => {
    const { m } = setUp()
    handleAction('circle-remove-member', { dataset: { circle: 'confirm-circle', pk: m.pkHex } } as unknown as HTMLElement)
    // "Navigating away": some other action runs, the confirm is never answered.
    handleAction('circle-invite-done', { dataset: {} } as unknown as HTMLElement)

    expect(structuralQueue.pending()).toEqual([])
    expect(store.load().pendingRemovals['confirm-circle']).toBeUndefined()
  })
})

// Regression from 60c8176 (device test): background unwraps are silent-only,
// but My Signet's content provider can't decrypt while My Signet is in the
// background — a genuine invite sat in the deferred set forever and nothing
// said so. A calm notice now says something is waiting, and its "Check now"
// (the person's own tap) runs ONE capped pass with interactive signing
// allowed. Background passes stay silent-only.
describe('deferred personal-inbox wraps: the "waiting" notice and Check now', () => {
  /** A transport that can never answer in the background (My Signet not in
   *  front) and answers an interactive call as `mode.interactive` says. */
  function backgroundBlind(skHex: string, mode: { interactive: 'ok' | 'refuse' | 'aborted' }) {
    const calls: Array<SignerCallOpts | undefined> = []
    const sk = hexToBytes(skHex)
    const transport: SignerTransport = {
      pubkey: getPublicKey(sk),
      async signEvent() { throw new Error('unused') },
      async nip44Encrypt() { throw new Error('unused') },
      async nip44Decrypt(peer, ct, opts) {
        calls.push(opts)
        if (opts?.interactive === false) throw new SignerUnavailable('The signer app could not answer in the background.')
        if (mode.interactive === 'refuse') throw new SignerRejected('My Signet declined.')
        if (mode.interactive === 'aborted') throw new SignerUnavailable('The person backed out.')
        return nip44decrypt(ct, getConversationKey(sk, peer))
      },
      async close() {},
    }
    return { transport, calls }
  }
  function junk(i: number) {
    return { id: (0x1000 + i).toString(16).padStart(8, '0').repeat(8), pubkey: realKeypair().pkHex, content: 'junk', tags: [] as string[][] }
  }

  beforeEach(() => {
    resetDeferredPersonalWrapsForTests()
    setMinPassGapForTests(0)
  })
  afterEach(() => {
    setMinPassGapForTests(MIN_PASS_GAP_MS)
    handleAction('circle-decline', { dataset: {} } as unknown as HTMLElement)
  })

  it('shows nothing while no wrap is deferred', () => {
    const self = realKeypair()
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport: backgroundBlind(self.skHex, { interactive: 'ok' }).transport })
    store.save(fakePersisted({}))
    expect(inboxWaitingView()).toBe('')
  })

  it('a deferred invite shows the notice; background passes never go interactive; Check now delivers it and the notice clears', async () => {
    const self = realKeypair()
    const inviterSk = generateSecretKey()
    const inviterPhone = realKeypair()
    const { transport, calls } = backgroundBlind(self.skHex, { interactive: 'ok' })
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport })
    store.save(fakePersisted({}))
    const { invite, statement } = buildInvite({ to: self.pkHex,
      circleId: 'waiting-circle', seedHex: '8'.repeat(64), name: 'Waiting Circle', inviterSk, inviterPhonePk: inviterPhone.pkHex,
    })
    const wrap = await wrapInvite(self.pkHex, invite, statement, inviterPhone.skHex)
    const notified = vi.fn()
    const unsub = store.subscribe(notified)

    await onPersonalInboxWrap(personalInboxSigner(), wrap)
    expect(deferredPersonalWrapIdsForTests()).toEqual([wrap.id])
    expect(notified).toHaveBeenCalled() // the notice appears without another state change
    const html = inboxWaitingView()
    expect(html).toContain('An invite or message is waiting. Open My Signet to read it.')
    expect(html).toContain('data-action="circle-check-inbox"')
    expect(html).toContain('Check now')
    expect(html).not.toMatch(/[0-9a-f]{16}/) // no hex

    // Background passes (resume, availability ticks) stay silent-only.
    await retryDeferredPersonalWraps()
    await retryDeferredPersonalWraps()
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((o) => o?.interactive === false)).toBe(true)
    expect(deferredPersonalWrapIdsForTests()).toEqual([wrap.id])

    // The person taps Check now: one interactive pass.
    calls.length = 0
    notified.mockClear()
    await checkDeferredNow()
    expect(calls.length).toBeGreaterThan(0)
    expect(calls.every((o) => o?.interactive !== false)).toBe(true)
    expect(deferredPersonalWrapIdsForTests()).toEqual([])
    expect(store.load().seenPersonalWraps).toContain(wrap.id)
    expect(view(store.load())).toContain('Waiting Circle')
    expect(inboxWaitingView()).toBe('')
    expect(notified).toHaveBeenCalled()
    unsub()
  })

  it('the Check now button runs the pass through handleAction', async () => {
    const self = realKeypair()
    const { transport, calls } = backgroundBlind(self.skHex, { interactive: 'refuse' })
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport })
    store.save(fakePersisted({}))
    await onPersonalInboxWrap(personalInboxSigner(), junk(1) as never)
    calls.length = 0
    handleAction('circle-check-inbox', { dataset: {} } as unknown as HTMLElement)
    await vi.waitFor(() => { expect(calls.some((o) => o?.interactive !== false)).toBe(true) })
  })

  it('Check now is capped at CHECK_NOW_CAP wraps per tap, then stops; nothing else becomes interactive', async () => {
    const self = realKeypair()
    const { transport, calls } = backgroundBlind(self.skHex, { interactive: 'refuse' })
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport })
    store.save(fakePersisted({}))
    expect(CHECK_NOW_CAP).toBe(10)
    for (let i = 0; i < 13; i++) await onPersonalInboxWrap(personalInboxSigner(), junk(i) as never)
    expect(deferredPersonalWrapIdsForTests()).toHaveLength(13)

    calls.length = 0
    await checkDeferredNow()
    const interactive = calls.filter((o) => o?.interactive !== false)
    expect(interactive).toHaveLength(CHECK_NOW_CAP) // one refused decrypt per wrap
    expect(deferredPersonalWrapIdsForTests()).toHaveLength(3)
    expect(inboxWaitingView()).toContain('Check now') // still some waiting

    // Afterwards, background passes are silent again.
    calls.length = 0
    await retryDeferredPersonalWraps()
    expect(calls.every((o) => o?.interactive === false)).toBe(true)
  })

  it('interactive refusals count towards MAX_WRAP_REFUSALS: junk is dropped after 3', async () => {
    const self = realKeypair()
    const { transport } = backgroundBlind(self.skHex, { interactive: 'refuse' })
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport })
    store.save(fakePersisted({}))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = junk(99)
    for (let n = 1; n <= MAX_WRAP_REFUSALS; n++) {
      await onPersonalInboxWrap(personalInboxSigner(), w as never) // a replay defers it again
      expect(deferredPersonalWrapIdsForTests()).toEqual([w.id])
      await checkDeferredNow()
      expect(deferredPersonalWrapIdsForTests()).toEqual([])
    }
    expect(store.load().seenPersonalWraps).toContain(w.id)
    expect(store.load().personalWrapRefusals).toEqual([])
    await onPersonalInboxWrap(personalInboxSigner(), w as never)
    expect(deferredPersonalWrapIdsForTests()).toEqual([]) // seen: never deferred again
    warn.mockRestore()
  })

  it('backing out of My Signet leaves the wrap waiting (not dropped, not counted) and ends the pass', async () => {
    const self = realKeypair()
    const { transport, calls } = backgroundBlind(self.skHex, { interactive: 'aborted' })
    sessionForTests({ identityPk: self.pkHex, phoneSkHex: realKeypair().skHex, dependant: false, transport })
    store.save(fakePersisted({}))
    for (let i = 0; i < 3; i++) await onPersonalInboxWrap(personalInboxSigner(), junk(i) as never)
    calls.length = 0
    await checkDeferredNow()
    expect(calls.filter((o) => o?.interactive !== false)).toHaveLength(1)
    expect(deferredPersonalWrapIdsForTests()).toHaveLength(3)
    expect(store.load().personalWrapRefusals).toEqual([])
    expect(inboxWaitingView()).toContain('Check now')
  })
})
