import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import type { Circle } from '@forgesworn/covey-kit'
import { toHex } from '@forgesworn/covey-kit'
import * as store from './store.js'
import { deviceStatementTemplate, revocationTemplate, guardianOfTemplate, dependantOfTemplate, unlinkTemplate } from './device-statements.js'
import { acceptLinkPair, acceptUnlink } from './guardian-links.js'
import { sessionForTests, currentSession } from './session.js'
import {
  acceptStatement, acceptRevocation, memberForPhone, phonesOf, touch, rescanBuffered, forgetMember,
  promoteParkedRevocations, PENDING_REVOCATIONS_CAP, PENDING_REVOCATIONS_PER_KEY,
} from './phone-keys.js'

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

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage())
})

interface Key { sk: Uint8Array; pk: string }
function key(): Key {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}

function statement(identity: Key, phonePk: string, at = 1000) {
  return finalizeEvent(deviceStatementTemplate(phonePk, at), identity.sk)
}
function revocation(signer: Key, phonePk: string, at = 1000) {
  return finalizeEvent(revocationTemplate(phonePk, at), signer.sk)
}

/** A matching guardian-of (by `g`) / dependant-of (by `d`) pair at `at` —
 *  same helper shape as guardian-links.test.ts's own `pair()`. */
function linkPair(g: Key, d: Key, at: number, dAt = at) {
  return { g: finalizeEvent(guardianOfTemplate(d.pk, at), g.sk), d: finalizeEvent(dependantOfTemplate(g.pk, dAt), d.sk) }
}

/** Builds a circle and saves it as the store's current copy of that id
 *  (final fix A9: `memberForPhone` resolves only members on the stored
 *  roster, so the latest roster built for an id is the one in force). */
function circle(id: string, memberPks: string[]): Circle {
  const c: Circle = {
    id, name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
    members: memberPks.map((pk, i) => ({ pk, role: i === 0 ? 'guardian' : 'dependant', name: `M${i}` })) as Circle['members'],
    createdAt: 100, configUpdatedAt: 100, configBy: memberPks[0] ?? '',
  }
  store.update((p) => { p.circles = [...p.circles.filter((x) => x.id !== id), c] })
  return c
}

const NOW = 2000

// Deflake (Task 11): "caps the buffer at 200" and "parked revocations are
// capped per phone and overall" below each exercise a 200+-entry cap by
// feeding it 205 distinct, REALLY signed events — under full-suite CPU
// contention, generating and signing 205 fresh keypairs inside the timed
// test body (on top of the real signature verification `acceptStatement`/
// `acceptRevocation` already does per call) could run past the default 5 s
// test timeout, even though the same test finishes in well under a second
// alone. The 205 keypairs and their real signed events are generated once
// here, at module load (never counted against any test's own timeout), so
// each test's body only re-runs the real verification it actually tests.
const CAP_BUFFER_SAM = key()
const CAP_BUFFER_STATEMENTS = Array.from({ length: 205 }, (_, i) => {
  const phone = key()
  return { phonePk: phone.pk, event: statement(CAP_BUFFER_SAM, phone.pk, 1000 + i) }
})
const CAP_REVOCATIONS = Array.from({ length: 205 }, (_, i) => revocation(key(), key().pk, 1000 + i))

describe('acceptStatement', () => {
  it('adds a statement from a roster member', () => {
    const alex = key(); const phone = key()
    const c = circle('c1', [alex.pk])
    expect(acceptStatement(c, statement(alex, phone.pk), phone.pk, NOW)).toBe('added')
    expect(memberForPhone('c1', phone.pk)).toBe(alex.pk)
    const entry = store.load().phoneKeys.c1?.[phone.pk]
    expect(entry?.memberPk).toBe(alex.pk)
    expect(entry?.lastSeen).toBe(NOW)
    // table is per circle
    expect(memberForPhone('c2', phone.pk)).toBeNull()
  })

  it('rejects an invalid or tampered statement', () => {
    const alex = key(); const phone = key()
    const c = circle('c1', [alex.pk])
    const ev = statement(alex, phone.pk)
    expect(acceptStatement(c, { ...ev, content: "tampered" }, phone.pk, NOW)).toBe('rejected')
    expect(acceptStatement(c, null, phone.pk, NOW)).toBe('rejected')
    expect(acceptStatement(c, revocation(alex, phone.pk), phone.pk, NOW)).toBe('rejected')
    expect(memberForPhone('c1', phone.pk)).toBeNull()
    expect(store.load().pendingStatements).toEqual([])
  })

  it('buffers statements for unknown members, then adds them after rescanBuffered once on the roster', () => {
    const alex = key(); const sam = key(); const phone = key()
    const c = circle('c1', [alex.pk])
    const ev = statement(sam, phone.pk)
    expect(acceptStatement(c, ev, phone.pk, NOW)).toBe('buffered')
    expect(memberForPhone('c1', phone.pk)).toBeNull()
    expect(store.load().pendingStatements.map((e) => [e.circleId, e.event.id])).toEqual([['c1', ev.id]])

    // still not on roster: nothing changes
    rescanBuffered(c, NOW)
    expect(memberForPhone('c1', phone.pk)).toBeNull()
    expect(store.load().pendingStatements).toHaveLength(1)

    const c2 = circle('c1', [alex.pk, sam.pk])
    rescanBuffered(c2, NOW + 5)
    expect(memberForPhone('c1', phone.pk)).toBe(sam.pk)
    expect(store.load().phoneKeys.c1?.[phone.pk]?.lastSeen).toBe(NOW + 5)
    expect(store.load().pendingStatements).toEqual([])
  })

  it('rejects a statement relayed by a different phone key (proof of possession)', () => {
    const alex = key(); const sam = key(); const phone = key(); const other = key()
    const c = circle('c1', [alex.pk])
    expect(acceptStatement(c, statement(alex, phone.pk), other.pk, NOW)).toBe('rejected')
    // also not buffered when the identity is off the roster
    expect(acceptStatement(c, statement(sam, phone.pk), other.pk, NOW)).toBe('rejected')
    expect(memberForPhone('c1', phone.pk)).toBeNull()
    expect(store.load().pendingStatements).toEqual([])
  })

  it('rejects a binding hijack: member B posts a statement naming A\'s phone from B\'s phone', () => {
    const alex = key(); const bea = key(); const alexPhone = key(); const beaPhone = key()
    const c = circle('c1', [alex.pk, bea.pk])
    // B signs a statement claiming A's phone key and posts it sealed by B's own phone
    expect(acceptStatement(c, statement(bea, alexPhone.pk), beaPhone.pk, NOW)).toBe('rejected')
    expect(memberForPhone('c1', alexPhone.pk)).toBeNull()
    // A's genuine statement, posted from A's phone, still binds
    expect(acceptStatement(c, statement(alex, alexPhone.pk), alexPhone.pk, NOW)).toBe('added')
    expect(memberForPhone('c1', alexPhone.pk)).toBe(alex.pk)
    // and B relaying A's genuine statement from B's phone is rejected too
    expect(acceptStatement(c, statement(alex, alexPhone.pk, 1200), beaPhone.pk, NOW)).toBe('rejected')
  })

  it('dedups buffered statements by event id', () => {
    const alex = key(); const sam = key(); const phone = key()
    const c = circle('c1', [alex.pk])
    const ev = statement(sam, phone.pk)
    acceptStatement(c, ev, phone.pk, NOW)
    acceptStatement(c, ev, phone.pk, NOW)
    expect(store.load().pendingStatements).toHaveLength(1)
    // the same event posted on another circle is a separate entry
    acceptStatement(circle('c2', [alex.pk]), ev, phone.pk, NOW)
    expect(store.load().pendingStatements.map((e) => [e.circleId, e.event.id]))
      .toEqual([['c1', ev.id], ['c2', ev.id]])
  })

  it('does not refresh lastSeen when an already-bound statement is replayed', () => {
    const alex = key(); const phone = key()
    const c = circle('c1', [alex.pk])
    const ev = statement(alex, phone.pk)
    expect(acceptStatement(c, ev, phone.pk, NOW)).toBe('added')
    expect(acceptStatement(c, ev, phone.pk, NOW + 100)).toBe('added')
    expect(store.load().phoneKeys.c1?.[phone.pk]?.lastSeen).toBe(NOW)
    // a fresh statement (new id) does refresh it
    acceptStatement(c, statement(alex, phone.pk, 1500), phone.pk, NOW + 200)
    expect(store.load().phoneKeys.c1?.[phone.pk]?.lastSeen).toBe(NOW + 200)
  })

  it('caps the buffer at 200, dropping the oldest', () => {
    const alex = key()
    const c = circle('c1', [alex.pk])
    for (const { phonePk, event } of CAP_BUFFER_STATEMENTS) {
      expect(acceptStatement(c, event, phonePk, NOW)).toBe('buffered')
    }
    const pending = store.load().pendingStatements.map((e) => e.event.id)
    expect(pending).toHaveLength(200)
    expect(pending).toEqual(CAP_BUFFER_STATEMENTS.slice(5).map((s) => s.event.id))
  }, 20_000)

  it('rejects a statement for a phone key already bound to a different identity', () => {
    const alex = key(); const mallory = key(); const phone = key()
    const c1 = circle('c1', [alex.pk, mallory.pk])
    const c2 = circle('c2', [mallory.pk])
    expect(acceptStatement(c1, statement(alex, phone.pk), phone.pk, NOW)).toBe('added')
    expect(acceptStatement(c1, statement(mallory, phone.pk), phone.pk, NOW)).toBe('rejected')
    // binding is global across circles: a phone key belongs to one identity
    expect(acceptStatement(c2, statement(mallory, phone.pk), phone.pk, NOW)).toBe('rejected')
    expect(memberForPhone('c1', phone.pk)).toBe(alex.pk)
    expect(memberForPhone('c2', phone.pk)).toBeNull()
  })

  it('accepts the same identity re-stating the same phone key in another circle', () => {
    const alex = key(); const phone = key()
    expect(acceptStatement(circle('c1', [alex.pk]), statement(alex, phone.pk), phone.pk, NOW)).toBe('added')
    expect(acceptStatement(circle('c2', [alex.pk]), statement(alex, phone.pk, 1100), phone.pk, NOW)).toBe('added')
    expect(memberForPhone('c2', phone.pk)).toBe(alex.pk)
  })

  it('rejects a statement whose phone key is revoked even if the identity is on the roster', () => {
    const alex = key(); const phone = key()
    const c = circle('c1', [alex.pk])
    expect(acceptRevocation(revocation(alex, phone.pk), [c])).toBe('parked')
    expect(acceptStatement(c, statement(alex, phone.pk), phone.pk, NOW)).toBe('rejected')
    expect(memberForPhone('c1', phone.pk)).toBeNull()
    expect(store.load().phoneKeys.c1?.[phone.pk]).toBeUndefined()
  })
})

describe('acceptRevocation', () => {
  it('revoked key → memberForPhone null even though the table entry remains', () => {
    const alex = key(); const phone = key()
    const c = circle('c1', [alex.pk])
    acceptStatement(c, statement(alex, phone.pk), phone.pk, NOW)
    expect(acceptRevocation(revocation(alex, phone.pk), [c])).toBe('applied')
    expect(store.load().phoneKeys.c1?.[phone.pk]).toBeDefined()
    expect(memberForPhone('c1', phone.pk)).toBeNull()
    expect(store.load().revokedPhoneKeys[phone.pk]).toBeDefined()
  })


  it('parks (Task 9 fix round 1), rather than applies, a revocation signed by a different identity for a known key', () => {
    const alex = key(); const mallory = key(); const phone = key()
    const c = circle('c1', [alex.pk, mallory.pk])
    acceptStatement(c, statement(alex, phone.pk), phone.pk, NOW)
    expect(acceptRevocation(revocation(mallory, phone.pk), [c])).toBe('parked')
    expect(memberForPhone('c1', phone.pk)).toBe(alex.pk)
    expect(store.load().revokedPhoneKeys[phone.pk]).toBeUndefined()
    // mallory never becomes a linked guardian of alex, so it never promotes.
    expect(promoteParkedRevocations()).toEqual([])
  })

  it('checks ownership across every circle table (never applied; final review A, M1: not even parked, mallory is on no roster where the key is bound)', () => {
    const alex = key(); const mallory = key(); const phone = key()
    const c1 = circle('c1', [alex.pk])
    const c2 = circle('c2', [mallory.pk])
    acceptStatement(c1, statement(alex, phone.pk), phone.pk, NOW)
    expect(acceptRevocation(revocation(mallory, phone.pk), [c2])).toBe('rejected')
    expect(store.load().pendingRevocations[phone.pk]).toBeUndefined()
    expect(memberForPhone('c1', phone.pk)).toBe(alex.pk)
  })

  it('rejects an invalid or tampered revocation', () => {
    const alex = key(); const phone = key()
    const ev = revocation(alex, phone.pk)
    expect(acceptRevocation({ ...ev, created_at: 5 }, [])).toBe('rejected')
    expect(acceptRevocation(statement(alex, phone.pk), [])).toBe('rejected')
    expect(acceptRevocation('nope', [])).toBe('rejected')
    expect(store.load().revokedPhoneKeys).toEqual({})
  })
})

describe('phonesOf / touch / forgetMember', () => {
  it('phonesOf excludes revoked keys', () => {
    const alex = key(); const p1 = key(); const p2 = key(); const sam = key(); const p3 = key()
    const c = circle('c1', [alex.pk, sam.pk])
    acceptStatement(c, statement(alex, p1.pk), p1.pk, NOW)
    acceptStatement(c, statement(alex, p2.pk), p2.pk, NOW)
    acceptStatement(c, statement(sam, p3.pk), p3.pk, NOW)
    expect(phonesOf('c1', alex.pk).sort()).toEqual([p1.pk, p2.pk].sort())
    acceptRevocation(revocation(alex, p1.pk), [c])
    expect(phonesOf('c1', alex.pk)).toEqual([p2.pk])
    expect(phonesOf('c1', sam.pk)).toEqual([p3.pk])
    expect(phonesOf('nope', alex.pk)).toEqual([])
  })

  it('touch updates lastSeen for a known key only', () => {
    const alex = key(); const phone = key()
    const c = circle('c1', [alex.pk])
    acceptStatement(c, statement(alex, phone.pk), phone.pk, NOW)
    touch('c1', phone.pk, NOW + 50)
    expect(store.load().phoneKeys.c1?.[phone.pk]?.lastSeen).toBe(NOW + 50)
    touch('c1', key().pk, NOW + 60)
    touch('c2', phone.pk, NOW + 60)
    expect(Object.keys(store.load().phoneKeys.c1 ?? {})).toEqual([phone.pk])
    expect(store.load().phoneKeys.c2).toBeUndefined()
  })

  it('touch ignores revoked keys', () => {
    const alex = key(); const phone = key()
    const c = circle('c1', [alex.pk])
    acceptStatement(c, statement(alex, phone.pk), phone.pk, NOW)
    acceptRevocation(revocation(alex, phone.pk), [c])
    touch('c1', phone.pk, NOW + 50)
    expect(store.load().phoneKeys.c1?.[phone.pk]?.lastSeen).toBe(NOW)
  })

  it('forgetMember removes that member\'s keys from that circle only', () => {
    const alex = key(); const sam = key(); const pa = key(); const ps = key()
    const c1 = circle('c1', [alex.pk, sam.pk])
    const c2 = circle('c2', [alex.pk])
    acceptStatement(c1, statement(alex, pa.pk), pa.pk, NOW)
    acceptStatement(c1, statement(sam, ps.pk), ps.pk, NOW)
    acceptStatement(c2, statement(alex, pa.pk), pa.pk, NOW)
    forgetMember('c1', alex.pk)
    expect(memberForPhone('c1', pa.pk)).toBeNull()
    expect(memberForPhone('c1', ps.pk)).toBe(sam.pk)
    expect(memberForPhone('c2', pa.pk)).toBe(alex.pk)
  })
})

describe('Task 12 fix round 2, finding 1a (security): ownerOf treats our own phone as owned by us', () => {
  afterEach(() => {
    sessionForTests(null)
  })

  it('parks (Task 9 fix round 1), rather than applies, a revocation of our own phone signed by another identity while it is still unbound', () => {
    const self = key(); const mallory = key(); const ourPhone = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: toHex(ourPhone.sk) })
    const ourPhonePk = currentSession()!.phonePk
    expect(memberForPhone('c1', ourPhonePk)).toBeNull() // unbound: no table entry anywhere yet
    circle('c9', [mallory.pk]) // final review A, M1: only a member's revocation parks
    expect(acceptRevocation(revocation(mallory, ourPhonePk), [])).toBe('parked')
    expect(store.load().revokedPhoneKeys[ourPhonePk]).toBeUndefined()
    // mallory never becomes our linked guardian, so it never promotes.
    expect(promoteParkedRevocations()).toEqual([])
    expect(store.load().revokedPhoneKeys[ourPhonePk]).toBeUndefined()
  })

  it('still parks, not applies, a different identity\'s revocation of our own phone once it has been bound', () => {
    const self = key(); const mallory = key(); const ourPhone = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: toHex(ourPhone.sk) })
    const ourPhonePk = currentSession()!.phonePk
    const c = circle('c1', [self.pk, mallory.pk]) // final review A, M1: mallory a member, so it parks
    expect(acceptStatement(c, statement(self, ourPhonePk), ourPhonePk, NOW)).toBe('added')
    expect(acceptRevocation(revocation(mallory, ourPhonePk), [c])).toBe('parked')
    expect(store.load().revokedPhoneKeys[ourPhonePk]).toBeUndefined()
    expect(memberForPhone('c1', ourPhonePk)).toBe(self.pk)
  })

  it('accepts a revocation of our own phone signed by our own identity, even while unbound', () => {
    const self = key(); const ourPhone = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: toHex(ourPhone.sk) })
    const ourPhonePk = currentSession()!.phonePk
    expect(acceptRevocation(revocation(self, ourPhonePk), [])).toBe('applied')
    expect(store.load().revokedPhoneKeys[ourPhonePk]).toBeDefined()
  })
})

describe('rescanBuffered', () => {
  it('only considers entries buffered on that circle', () => {
    const alex = key(); const guardX = key(); const guardY = key(); const phone = key()
    const x = circle('X', [guardX.pk])
    // A's statement buffered in X (A not yet on X's roster)
    expect(acceptStatement(x, statement(alex, phone.pk), phone.pk, NOW)).toBe('buffered')
    // A is on Y's roster, but the statement was never posted on Y
    rescanBuffered(circle('Y', [guardY.pk, alex.pk]), NOW)
    expect(memberForPhone('Y', phone.pk)).toBeNull()
    expect(store.load().pendingStatements.map((e) => e.circleId)).toEqual(['X'])
    // X's roster now includes A → rescan of X binds it
    rescanBuffered(circle('X', [guardX.pk, alex.pk]), NOW)
    expect(memberForPhone('X', phone.pk)).toBe(alex.pk)
    expect(memberForPhone('Y', phone.pk)).toBeNull()
    expect(store.load().pendingStatements).toEqual([])
  })

  it('does not add buffered statements whose key has since been revoked, and drops them', () => {
    const alex = key(); const sam = key(); const phone = key()
    const c = circle('c1', [alex.pk])
    acceptStatement(c, statement(sam, phone.pk), phone.pk, NOW)
    circle('c0', [sam.pk]) // final review A, M1: only a member's revocation parks
    // key not in any table yet: parked, and sam's own buffered statement purged
    expect(acceptRevocation(revocation(sam, phone.pk), [c])).toBe('parked')
    rescanBuffered(circle('c1', [alex.pk, sam.pk]), NOW)
    expect(memberForPhone('c1', phone.pk)).toBeNull()
    expect(store.load().phoneKeys.c1?.[phone.pk]).toBeUndefined()
    expect(store.load().pendingStatements).toEqual([])
  })

  it('drops a buffered statement whose phone key is now bound to a different identity', () => {
    const alex = key(); const sam = key(); const phone = key()
    const c = circle('c1', [alex.pk])
    acceptStatement(c, statement(sam, phone.pk), phone.pk, NOW)
    expect(acceptStatement(c, statement(alex, phone.pk), phone.pk, NOW)).toBe('added')
    rescanBuffered(circle('c1', [alex.pk, sam.pk]), NOW)
    expect(memberForPhone('c1', phone.pk)).toBe(alex.pk)
    expect(store.load().pendingStatements).toEqual([])
  })
})

describe('final fix A4 (security): revocations of a not-yet-bound phone are parked, not stored', () => {
  it('a foreign revocation of an unbound phone is parked, and the owner\'s statement still binds later', () => {
    const alex = key(); const bea = key(); const phone = key()
    const c = circle('c1', [alex.pk, bea.pk])
    expect(acceptRevocation(revocation(bea, phone.pk), [c])).toBe('parked')
    expect(store.load().revokedPhoneKeys[phone.pk]).toBeUndefined()
    expect(store.load().pendingRevocations[phone.pk]).toHaveLength(1)
    expect(acceptStatement(c, statement(alex, phone.pk), phone.pk, NOW)).toBe('added')
    expect(memberForPhone('c1', phone.pk)).toBe(alex.pk)
    expect(store.load().pendingRevocations[phone.pk]).toBeUndefined()
  })

  it('the owning identity\'s own revocation before its statement blocks the statement, and is promoted', () => {
    const alex = key(); const phone = key()
    const c = circle('c1', [alex.pk])
    const rv = revocation(alex, phone.pk)
    expect(acceptRevocation(rv, [c])).toBe('parked')
    expect(acceptStatement(c, statement(alex, phone.pk), phone.pk, NOW)).toBe('rejected')
    expect(memberForPhone('c1', phone.pk)).toBeNull()
    expect(store.load().revokedPhoneKeys[phone.pk]?.id).toBe(rv.id)
    expect(store.load().pendingRevocations[phone.pk]).toBeUndefined()
  })

  it('a foreign revocation does not purge the owner\'s buffered statement; the owner\'s own does', () => {
    const alex = key(); const sam = key(); const mallory = key(); const phone = key()
    const c = circle('c1', [alex.pk])
    expect(acceptStatement(c, statement(sam, phone.pk), phone.pk, NOW)).toBe('buffered')
    circle('c0', [mallory.pk, sam.pk]) // final review A, M1: only members' revocations park
    expect(acceptRevocation(revocation(mallory, phone.pk), [c])).toBe('parked')
    expect(store.load().pendingStatements).toHaveLength(1)
    rescanBuffered(circle('c1', [alex.pk, sam.pk]), NOW)
    expect(memberForPhone('c1', phone.pk)).toBe(sam.pk)

    const phone2 = key()
    const c2 = circle('c2', [alex.pk])
    expect(acceptStatement(c2, statement(sam, phone2.pk), phone2.pk, NOW)).toBe('buffered')
    expect(acceptRevocation(revocation(sam, phone2.pk), [c2])).toBe('parked')
    expect(store.load().pendingStatements).toEqual([])
  })

  it('a buffered statement meeting its own identity\'s parked revocation on rescan is dropped and the revocation promoted', () => {
    const alex = key(); const sam = key(); const phone = key()
    const c = circle('c1', [alex.pk])
    circle('c0', [sam.pk]) // final review A, M1: only a member's revocation parks
    expect(acceptRevocation(revocation(sam, phone.pk), [c])).toBe('parked')
    expect(acceptStatement(c, statement(sam, phone.pk, 1200), phone.pk, NOW)).toBe('buffered')
    rescanBuffered(circle('c1', [alex.pk, sam.pk]), NOW)
    expect(memberForPhone('c1', phone.pk)).toBeNull()
    expect(store.load().revokedPhoneKeys[phone.pk]).toBeDefined()
    expect(store.load().pendingStatements).toEqual([])
  })

  it('parked revocations are capped per phone and overall', () => {
    const phone = key()
    const signers = Array.from({ length: PENDING_REVOCATIONS_PER_KEY + 3 }, () => key())
    // Final review A, M1: only members' revocations park.
    circle('cap', [...signers.map((k) => k.pk), ...CAP_REVOCATIONS.map((ev) => ev.pubkey)])
    for (const k of signers) acceptRevocation(revocation(k, phone.pk), [])
    expect(store.load().pendingRevocations[phone.pk]).toHaveLength(PENDING_REVOCATIONS_PER_KEY)
    for (const ev of CAP_REVOCATIONS) acceptRevocation(ev, [])
    expect(Object.keys(store.load().pendingRevocations)).toHaveLength(PENDING_REVOCATIONS_CAP)
    expect(store.load().pendingRevocations[phone.pk]).toBeUndefined() // oldest phone dropped first
  }, 20_000)
})

describe('final review A, M1: the revocation park holds members\' revocations only', () => {
  it('a guardian\'s parked revocation survives a flood of revocations from throwaway identities', () => {
    const dependant = key(); const guardian = key(); const phone = key()
    const c = circle('c1', [guardian.pk, dependant.pk])
    acceptStatement(c, statement(dependant, phone.pk), phone.pk, NOW)
    const ev = revocation(guardian, phone.pk)
    expect(acceptRevocation(ev, [c])).toBe('parked')
    for (let i = 0; i < PENDING_REVOCATIONS_PER_KEY + 1; i++) expect(acceptRevocation(revocation(key(), phone.pk), [c])).toBe('rejected')
    expect(store.load().pendingRevocations[phone.pk]?.map((e) => e.id)).toEqual([ev.id])
    const p = linkPair(guardian, dependant, 500)
    expect(acceptLinkPair(p.g, p.d)).toBe(true)
    expect(promoteParkedRevocations().map((x) => x.event.id)).toEqual([ev.id])
  })

  it('a member of another circle, where the key is not bound, cannot park one', () => {
    const dependant = key(); const other = key(); const phone = key()
    const c = circle('c1', [dependant.pk])
    circle('c2', [other.pk])
    acceptStatement(c, statement(dependant, phone.pk), phone.pk, NOW)
    expect(acceptRevocation(revocation(other, phone.pk), [c])).toBe('rejected')
  })

  it('one slot per signer: a member\'s repeats replace their own entry', () => {
    const dependant = key(); const member = key(); const guardian = key(); const phone = key()
    const c = circle('c1', [guardian.pk, dependant.pk, member.pk])
    acceptStatement(c, statement(dependant, phone.pk), phone.pk, NOW)
    const ev = revocation(guardian, phone.pk)
    expect(acceptRevocation(ev, [c])).toBe('parked')
    for (let i = 0; i < PENDING_REVOCATIONS_PER_KEY + 1; i++) acceptRevocation(revocation(member, phone.pk, 1000 + i), [c])
    expect(store.load().pendingRevocations[phone.pk]?.map((e) => e.pubkey).sort()).toEqual([guardian.pk, member.pk].sort())
  })
})

describe('Task 9: revocation by a linked guardian (spec §7)', () => {
  it('a linked guardian may revoke the dependant\'s phone', () => {
    const guardian = key(); const dependant = key(); const phone = key()
    const c = circle('c1', [guardian.pk, dependant.pk]) // final review A, M1: only a member's revocation parks
    acceptStatement(c, statement(dependant, phone.pk), phone.pk, NOW)
    const p = linkPair(guardian, dependant, 500)
    expect(acceptLinkPair(p.g, p.d)).toBe(true)
    expect(acceptRevocation(revocation(guardian, phone.pk), [c])).toBe('applied')
    expect(memberForPhone('c1', phone.pk)).toBeNull()
  })

  it('parks (Task 9 fix round 1), rather than applies, a revocation from an unlinked guardian', () => {
    const guardian = key(); const dependant = key(); const phone = key()
    const c = circle('c1', [guardian.pk, dependant.pk]) // final review A, M1: only a member's revocation parks
    acceptStatement(c, statement(dependant, phone.pk), phone.pk, NOW)
    expect(acceptRevocation(revocation(guardian, phone.pk), [c])).toBe('parked')
    expect(memberForPhone('c1', phone.pk)).toBe(dependant.pk)
  })

  it('parks, and never promotes, a revocation from a one-sided linked guardian (only the guardian half stored)', () => {
    const guardian = key(); const dependant = key(); const phone = key()
    const c = circle('c1', [guardian.pk, dependant.pk]) // final review A, M1: only a member's revocation parks
    acceptStatement(c, statement(dependant, phone.pk), phone.pk, NOW)
    const p = linkPair(guardian, dependant, 500)
    expect(acceptLinkPair(p.g, null)).toBe(false) // rejected: no dependant half held
    expect(acceptRevocation(revocation(guardian, phone.pk), [c])).toBe('parked')
    expect(memberForPhone('c1', phone.pk)).toBe(dependant.pk)
    expect(promoteParkedRevocations()).toEqual([]) // still not linked — nothing to promote
    expect(memberForPhone('c1', phone.pk)).toBe(dependant.pk)
  })

  it('parks, and never promotes, a revocation from the guardian after an unlink', () => {
    const guardian = key(); const dependant = key(); const phone = key()
    const c = circle('c1', [guardian.pk, dependant.pk]) // final review A, M1: only a member's revocation parks
    acceptStatement(c, statement(dependant, phone.pk), phone.pk, NOW)
    const p = linkPair(guardian, dependant, 500)
    expect(acceptLinkPair(p.g, p.d)).toBe(true)
    expect(acceptUnlink(finalizeEvent(unlinkTemplate(dependant.pk, 600), guardian.sk))).toBe(true)
    expect(acceptRevocation(revocation(guardian, phone.pk), [c])).toBe('parked')
    expect(memberForPhone('c1', phone.pk)).toBe(dependant.pk)
    // An unlink never promotes anything: re-judging right now still finds no link.
    expect(promoteParkedRevocations()).toEqual([])
    expect(memberForPhone('c1', phone.pk)).toBe(dependant.pk)
  })

  it('parks a revocation of a bound key from a not-yet-linked guardian; the link pair arriving later promotes it', () => {
    const guardian = key(); const dependant = key(); const phone = key()
    const c = circle('c1', [guardian.pk, dependant.pk]) // final review A, M1: only a member's revocation parks
    acceptStatement(c, statement(dependant, phone.pk), phone.pk, NOW)
    const ev = revocation(guardian, phone.pk)
    expect(acceptRevocation(ev, [c])).toBe('parked')
    expect(memberForPhone('c1', phone.pk)).toBe(dependant.pk) // not applied yet
    expect(store.load().revokedPhoneKeys[phone.pk]).toBeUndefined()

    // The guardian-link pair backing the revocation arrives after it —
    // randomised gift-wrap catch-up order can put either one first.
    const p = linkPair(guardian, dependant, 500)
    expect(acceptLinkPair(p.g, p.d)).toBe(true)
    const promoted = promoteParkedRevocations()
    expect(promoted).toHaveLength(1)
    expect(promoted[0]).toMatchObject({ phonePk: phone.pk })
    expect(promoted[0].event.id).toBe(ev.id)
    expect(memberForPhone('c1', phone.pk)).toBeNull()
    expect(store.load().revokedPhoneKeys[phone.pk]?.id).toBe(ev.id)
  })

  it('does not promote a bound-key parked revocation when the link that forms is between other people', () => {
    const guardian = key(); const dependant = key(); const other1 = key(); const other2 = key(); const phone = key()
    const c = circle('c1', [guardian.pk, dependant.pk]) // final review A, M1: only a member's revocation parks
    acceptStatement(c, statement(dependant, phone.pk), phone.pk, NOW)
    expect(acceptRevocation(revocation(guardian, phone.pk), [c])).toBe('parked')

    const unrelated = linkPair(other1, other2, 500)
    expect(acceptLinkPair(unrelated.g, unrelated.d)).toBe(true)
    expect(promoteParkedRevocations()).toEqual([])
    expect(memberForPhone('c1', phone.pk)).toBe(dependant.pk)
    expect(store.load().revokedPhoneKeys[phone.pk]).toBeUndefined()
  })

  it('Task 9 fix round 2: a statement re-post for the same phone (e.g. sign-in, a re-key, or the phone itself) does not clear a parked guardian revocation waiting for its link', () => {
    const guardian = key(); const dependant = key(); const phone = key()
    const c = circle('c1', [guardian.pk, dependant.pk]) // final review A, M1: only a member's revocation parks
    acceptStatement(c, statement(dependant, phone.pk), phone.pk, NOW)
    const ev = revocation(guardian, phone.pk)
    expect(acceptRevocation(ev, [c])).toBe('parked')

    // The dependant's phone re-posts its device statement (sign-in, a
    // re-key, or the phone itself doing it at will) before the link pair
    // backing the guardian's revocation arrives.
    expect(acceptStatement(c, statement(dependant, phone.pk, 1100), phone.pk, NOW + 1)).toBe('added')
    expect(store.load().pendingRevocations[phone.pk]).toHaveLength(1) // still parked, not wiped

    const p = linkPair(guardian, dependant, 500)
    expect(acceptLinkPair(p.g, p.d)).toBe(true)
    const promoted = promoteParkedRevocations()
    expect(promoted).toHaveLength(1)
    expect(promoted[0].event.id).toBe(ev.id)
    expect(memberForPhone('c1', phone.pk)).toBeNull()
    expect(store.load().revokedPhoneKeys[phone.pk]?.id).toBe(ev.id)
  })

  it('caps bound-key parked revocations the same as unbound ones (same table, same caps)', () => {
    const dependant = key(); const phone = key()
    const signers = Array.from({ length: PENDING_REVOCATIONS_PER_KEY + 3 }, () => key())
    const c = circle('c1', [dependant.pk, ...signers.map((k) => k.pk)]) // final review A, M1: only members' revocations park
    acceptStatement(c, statement(dependant, phone.pk), phone.pk, NOW)
    for (const k of signers) acceptRevocation(revocation(k, phone.pk), [c])
    expect(store.load().pendingRevocations[phone.pk]).toHaveLength(PENDING_REVOCATIONS_PER_KEY)
  })

  it('a parked revocation of an unknown key promotes when signed by a linked guardian', () => {
    const guardian = key(); const dependant = key(); const phone = key()
    const c = circle('c1', [guardian.pk, dependant.pk]) // final review A, M1: only a member's revocation parks
    const p = linkPair(guardian, dependant, 500)
    expect(acceptLinkPair(p.g, p.d)).toBe(true)
    expect(acceptRevocation(revocation(guardian, phone.pk), [c])).toBe('parked')
    expect(acceptStatement(c, statement(dependant, phone.pk, 1000), phone.pk, NOW)).toBe('rejected')
    expect(memberForPhone('c1', phone.pk)).toBeNull()
    expect(store.load().revokedPhoneKeys[phone.pk]).toBeDefined()
  })

  it('does not promote a parked revocation signed by an unlinked guardian', () => {
    const guardian = key(); const dependant = key(); const phone = key()
    const c = circle('c1', [guardian.pk, dependant.pk]) // final review A, M1: only a member's revocation parks
    expect(acceptRevocation(revocation(guardian, phone.pk), [c])).toBe('parked')
    expect(acceptStatement(c, statement(dependant, phone.pk, 1000), phone.pk, NOW)).toBe('added')
    expect(memberForPhone('c1', phone.pk)).toBe(dependant.pk)
    expect(store.load().revokedPhoneKeys[phone.pk]).toBeUndefined()
  })
})
