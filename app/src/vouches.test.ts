import { describe, it, expect, beforeEach, vi } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import * as store from './store.js'
import { structuralTemplate, seedHash, type StructuralAction } from './structural.js'
import {
  verifyVouch, vouchPayload, storeVouch, vouchFor, voucherOf, vouchedBy, allVouches,
  creatorOf, setCreator, markUnvouched, unvouchedSince, forgetCircleVouches, UNVOUCHED_GRACE_SEC,
  storePendingVouch, pendingVouchesFor, dropPendingVouches, PENDING_VOUCH_CAP,
  HAND_OVER_CAP, handOversFor, allHandOvers, clearUnvouched,
  type Vouch,
} from './vouches.js'

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

const A = key()
const B = key()
const C = key()
const PREV = seedHash('a'.repeat(64))

function struct(by: Key, action: StructuralAction, circleId: string, payload: string, at = 1_700_000_000) {
  return finalizeEvent(structuralTemplate({ action, circleId, prevSeedHash: PREV, payload, nowSec: at }), by.sk)
}

function invite(by: Key, circleId: string, extra: Record<string, unknown> = {}, at?: number) {
  return struct(by, 'invite', circleId, JSON.stringify({ id: circleId, name: 'Family', mode: 'family', ...extra }), at)
}

function handOver(by: Key, circleId: string, pk: string, at?: number) {
  return struct(by, 'vouch', circleId, vouchPayload(pk), at)
}

/** An invite naming `pk` as a peer — a member's original vouch. */
function memberInvite(by: Key, circleId: string, pk: string, at?: number) {
  return invite(by, circleId, { pk, role: 'peer' }, at)
}

function must(ev: unknown): Vouch {
  const v = verifyVouch(ev)
  if (!v) throw new Error('expected a valid vouch')
  return v
}

describe('verifyVouch', () => {
  it('an invite naming its invitee is a vouch', () => {
    const ev = invite(A, 'c1', { pk: B.pk, role: 'peer', memberName: 'Bea' })
    expect(verifyVouch(ev)).toMatchObject({ circleId: 'c1', pk: B.pk, by: A.pk, role: 'peer', memberName: 'Bea', createdAt: 1_700_000_000 })
  })

  it('an invite without pk (plan-1 shape) is not a vouch', () => {
    expect(verifyVouch(invite(A, 'c1'))).toBeNull()
    expect(verifyVouch(invite(A, 'c1', { role: 'peer' }))).toBeNull()
  })

  it('an invite with a bad role, missing role, or bad memberName is not a vouch', () => {
    expect(verifyVouch(invite(A, 'c1', { pk: B.pk, role: 'admin' }))).toBeNull()
    expect(verifyVouch(invite(A, 'c1', { pk: B.pk }))).toBeNull()
    expect(verifyVouch(invite(A, 'c1', { pk: B.pk, role: 'peer', memberName: 7 }))).toBeNull()
  })

  it('an invite whose payload id differs from its circle tag is not a vouch', () => {
    const ev = struct(A, 'invite', 'c1', JSON.stringify({ id: 'c2', name: 'F', mode: 'family', pk: B.pk, role: 'peer' }))
    expect(verifyVouch(ev)).toBeNull()
  })

  it('a hand-over vouch verifies, with no role', () => {
    const v = verifyVouch(handOver(A, 'c1', B.pk))
    expect(v).toMatchObject({ circleId: 'c1', pk: B.pk, by: A.pk })
    expect(v?.role).toBeUndefined()
  })

  it('rejects a pk that is not 64 lowercase hex', () => {
    expect(verifyVouch(handOver(A, 'c1', 'nothex'))).toBeNull()
    expect(verifyVouch(handOver(A, 'c1', B.pk.toUpperCase()))).toBeNull()
  })

  it('rejects a self-vouch', () => {
    expect(verifyVouch(handOver(A, 'c1', A.pk))).toBeNull()
    expect(verifyVouch(invite(A, 'c1', { pk: A.pk, role: 'guardian' }))).toBeNull()
  })

  it('rejects a forged signature', () => {
    const ev = handOver(A, 'c1', B.pk)
    expect(verifyVouch({ ...ev, sig: ev.sig.replace(/^./, (c) => (c === 'a' ? 'b' : 'a')) })).toBeNull()
    // Re-attributed to another signer.
    expect(verifyVouch({ ...ev, pubkey: C.pk })).toBeNull()
  })

  it('rejects other structural actions', () => {
    expect(verifyVouch(struct(A, 'config', 'c1', vouchPayload(B.pk)))).toBeNull()
  })

  it('never throws on junk', () => {
    for (const j of [null, undefined, 1, 'x', {}, []]) expect(verifyVouch(j)).toBeNull()
    expect(verifyVouch(struct(A, 'vouch', 'c1', 'not json'))).toBeNull()
  })
})

describe('vouchPayload', () => {
  it('is JSON { pk }', () => {
    expect(JSON.parse(vouchPayload(B.pk))).toEqual({ pk: B.pk })
  })
})

describe('vouch table', () => {
  it('stores and reads a vouch', () => {
    const v = must(memberInvite(A, 'c1', B.pk))
    storeVouch(v)
    expect(vouchFor('c1', B.pk)).toMatchObject({ by: A.pk, pk: B.pk })
    expect(voucherOf('c1', B.pk)).toBe(A.pk)
    expect(vouchedBy('c1', A.pk)).toEqual([B.pk])
    expect(allVouches('c1')).toEqual([v.event])
  })

  it('a vouch for circle A does not count in circle B', () => {
    const v = must(memberInvite(A, 'cA', B.pk))
    // Even a caller mislabelling the circle can't file it under B.
    storeVouch({ ...v, circleId: 'cB' })
    expect(vouchFor('cB', B.pk)).toBeNull()
    expect(voucherOf('cB', B.pk)).toBeNull()
    expect(allVouches('cB')).toEqual([])
    expect(voucherOf('cA', B.pk)).toBe(A.pk)
  })

  it('storeVouch keys by the signed vouchee and voucher, not caller fields', () => {
    const v = must(memberInvite(A, 'c1', B.pk))
    storeVouch({ ...v, pk: C.pk, by: C.pk })
    expect(voucherOf('c1', C.pk)).toBeNull()
    expect(voucherOf('c1', B.pk)).toBe(A.pk)
  })

  it('storeVouch ignores an unverifiable event', () => {
    const v = must(memberInvite(A, 'c1', B.pk))
    storeVouch({ ...v, event: { ...v.event, sig: '0'.repeat(128) } })
    expect(vouchFor('c1', B.pk)).toBeNull()
  })

  it('newest wins per (circle, pk)', () => {
    const older = must(memberInvite(A, 'c1', B.pk, 100))
    const newer = must(memberInvite(C, 'c1', B.pk, 200))
    storeVouch(newer)
    storeVouch(older)
    expect(voucherOf('c1', B.pk)).toBe(C.pk)
    storeVouch(must(memberInvite(A, 'c1', B.pk, 300)))
    expect(voucherOf('c1', B.pk)).toBe(A.pk)
    expect(vouchedBy('c1', C.pk)).toEqual([])
  })

  it('returns whether it stored', () => {
    expect(storeVouch(must(memberInvite(A, 'c1', B.pk, 200)))).toBe(true)
    expect(storeVouch(must(memberInvite(C, 'c1', B.pk, 100)))).toBe(false)
    expect(storeVouch(must(memberInvite(C, 'c1', B.pk, 300)))).toBe(true)
  })

  it('refuses a vouch dated more than 600 s ahead of now', () => {
    const now = 1_700_000_000
    expect(storeVouch(must(memberInvite(A, 'c1', B.pk, now + 601)), { nowSec: now })).toBe(false)
    expect(vouchFor('c1', B.pk)).toBeNull()
    expect(storeVouch(must(memberInvite(A, 'c1', B.pk, now + 600)), { nowSec: now })).toBe(true)
    expect(voucherOf('c1', B.pk)).toBe(A.pk)
  })

  it('defaults to the wall clock for the future-date bound', () => {
    const far = Math.floor(Date.now() / 1000) + 3600
    expect(storeVouch(must(memberInvite(A, 'c1', B.pk, far)))).toBe(false)
    expect(vouchFor('c1', B.pk)).toBeNull()
  })

  it('supersede replaces a newer-dated held vouch; without it the held one stays', () => {
    const now = 1_700_000_000
    storeVouch(must(memberInvite(A, 'c1', B.pk, now + 500)), { nowSec: now })
    const later = must(memberInvite(C, 'c1', B.pk, now + 10))
    expect(storeVouch(later, { nowSec: now + 10 })).toBe(false)
    expect(voucherOf('c1', B.pk)).toBe(A.pk)
    markUnvouched('c1', B.pk, now + 10)
    expect(storeVouch(later, { nowSec: now + 10, supersede: true })).toBe(true)
    expect(voucherOf('c1', B.pk)).toBe(C.pk)
    expect(unvouchedSince('c1', B.pk)).toBeNull()
  })

  it('supersede does not bypass verification or the future-date bound', () => {
    const now = 1_700_000_000
    storeVouch(must(memberInvite(A, 'c1', B.pk, now)), { nowSec: now })
    const v = must(memberInvite(C, 'c1', B.pk, now))
    expect(storeVouch({ ...v, event: { ...v.event, sig: '0'.repeat(128) } }, { nowSec: now, supersede: true })).toBe(false)
    expect(storeVouch(must(memberInvite(C, 'c1', B.pk, now + 601)), { nowSec: now, supersede: true })).toBe(false)
    expect(voucherOf('c1', B.pk)).toBe(A.pk)
  })

  it('a tie on created_at resolves the same way whatever the arrival order', () => {
    const x = must(memberInvite(A, 'c1', B.pk, 100))
    const y = must(memberInvite(C, 'c1', B.pk, 100))
    storeVouch(x); storeVouch(y)
    const first = voucherOf('c1', B.pk)
    forgetCircleVouches('c1')
    storeVouch(y); storeVouch(x)
    expect(voucherOf('c1', B.pk)).toBe(first)
  })

  it('a tampered stored event is not returned', () => {
    storeVouch(must(memberInvite(A, 'c1', B.pk)))
    store.update((p) => { p.vouches.c1[B.pk] = { ...p.vouches.c1[B.pk], content: vouchPayload(C.pk) } })
    expect(vouchFor('c1', B.pk)).toBeNull()
    expect(voucherOf('c1', B.pk)).toBeNull()
    expect(allVouches('c1')).toEqual([])
  })

  it('a stored event filed under the wrong key is not returned', () => {
    const v = must(memberInvite(A, 'c1', B.pk))
    store.update((p) => { p.vouches.c2 = { [C.pk]: v.event } })
    expect(vouchFor('c2', C.pk)).toBeNull()
    expect(allVouches('c2')).toEqual([])
  })

  it('final fix N1: storeVouch refuses a hand-over — the member table holds original invites only', () => {
    expect(storeVouch(must(handOver(A, 'c1', B.pk)))).toBe(false)
    expect(vouchFor('c1', B.pk)).toBeNull()
  })

  it('final fix N1: a hand-over left in the member table by an older build grants nothing', () => {
    const h = must(handOver(A, 'c1', B.pk))
    store.update((p) => { p.vouches.c1 = { [B.pk]: h.event } })
    expect(vouchFor('c1', B.pk)).toBeNull()
    expect(voucherOf('c1', B.pk)).toBeNull()
    expect(vouchedBy('c1', A.pk)).toEqual([])
    expect(allVouches('c1')).toEqual([])
  })

  it('storeVouch clears unvouchedSince for that member', () => {
    markUnvouched('c1', B.pk, 500)
    expect(unvouchedSince('c1', B.pk)).toBe(500)
    storeVouch(must(memberInvite(A, 'c1', B.pk)))
    expect(unvouchedSince('c1', B.pk)).toBeNull()
  })

  it('forgetCircleVouches drops vouches, creator and unvouched marks for that circle only', () => {
    storeVouch(must(memberInvite(A, 'c1', B.pk)))
    storeVouch(must(memberInvite(A, 'c2', B.pk)))
    setCreator('c1', A.pk)
    markUnvouched('c1', C.pk, 1)
    forgetCircleVouches('c1')
    expect(vouchFor('c1', B.pk)).toBeNull()
    expect(creatorOf('c1')).toBeNull()
    expect(unvouchedSince('c1', C.pk)).toBeNull()
    expect(voucherOf('c2', B.pk)).toBe(A.pk)
  })
})

describe('hostile circle ids', () => {
  it('a circle called __proto__ or constructor is stored as its own entry, not on Object.prototype', () => {
    for (const id of ['__proto__', 'constructor']) {
      storeVouch(must(memberInvite(A, id, B.pk)))
      expect(voucherOf(id, B.pk)).toBe(A.pk)
      expect(setCreator(id, A.pk)).toBe(true)
      expect(creatorOf(id)).toBe(A.pk)
      markUnvouched(id, C.pk, 5)
      expect(unvouchedSince(id, C.pk)).toBe(5)
    }
    expect((Object.prototype as Record<string, unknown>)[B.pk]).toBeUndefined()
    expect(voucherOf('other', B.pk)).toBeNull()
    expect(creatorOf('other')).toBeNull()
  })
})

describe('creator', () => {
  it('is set once and immutable', () => {
    expect(creatorOf('c1')).toBeNull()
    expect(setCreator('c1', A.pk)).toBe(true)
    expect(setCreator('c1', A.pk)).toBe(true)
    expect(setCreator('c1', B.pk)).toBe(false)
    expect(creatorOf('c1')).toBe(A.pk)
  })

  it('rejects a pk that is not 64 hex', () => {
    expect(setCreator('c1', 'nope')).toBe(false)
    expect(creatorOf('c1')).toBeNull()
  })
})

describe('unvouched', () => {
  it('marks only once, keeping the first time', () => {
    markUnvouched('c1', B.pk, 100)
    markUnvouched('c1', B.pk, 200)
    expect(unvouchedSince('c1', B.pk)).toBe(100)
    expect(unvouchedSince('c1', C.pk)).toBeNull()
  })

  it('clearUnvouched clears one mark', () => {
    markUnvouched('c1', B.pk, 100)
    markUnvouched('c1', C.pk, 100)
    clearUnvouched('c1', B.pk)
    expect(unvouchedSince('c1', B.pk)).toBeNull()
    expect(unvouchedSince('c1', C.pk)).toBe(100)
  })

  it('grace is 72 hours', () => {
    expect(UNVOUCHED_GRACE_SEC).toBe(72 * 3600)
  })
})

describe('pending vouches (Task 5 fix round 1)', () => {
  it('keeps one per (vouchee, voucher), newest wins, apart from the main table', () => {
    expect(storePendingVouch(must(handOver(A, 'c1', C.pk, 10)))).toBe(true)
    expect(storePendingVouch(must(handOver(B, 'c1', C.pk, 10)))).toBe(true)
    expect(storePendingVouch(must(handOver(A, 'c1', C.pk, 5)))).toBe(false) // older, same key
    expect(storePendingVouch(must(handOver(A, 'c1', C.pk, 20)))).toBe(true)
    expect(pendingVouchesFor('c1', C.pk).map((v) => [v.by, v.createdAt])).toEqual([[B.pk, 10], [A.pk, 20]])
    expect(vouchFor('c1', C.pk)).toBeNull()
    expect(pendingVouchesFor('c2', C.pk)).toEqual([])
  })

  it('caps each circle at PENDING_VOUCH_CAP invites, evicting the oldest stored', () => {
    expect(PENDING_VOUCH_CAP).toBe(50)
    const pks = Array.from({ length: PENDING_VOUCH_CAP + 1 }, () => key().pk)
    for (const pk of pks) expect(storePendingVouch(must(memberInvite(A, 'c1', pk)))).toBe(true)
    expect(pendingVouchesFor('c1', pks[0]!)).toEqual([])
    expect(pendingVouchesFor('c1', pks[1]!)).toHaveLength(1)
    expect(pendingVouchesFor('c1', pks.at(-1)!)).toHaveLength(1)
  })

  it('final fix N1: a flood of invites never evicts a hand-over; hand-overs have their own cap', () => {
    storePendingVouch(must(handOver(B, 'c1', C.pk)))
    for (let i = 0; i < PENDING_VOUCH_CAP + 5; i++) storePendingVouch(must(memberInvite(A, 'c1', key().pk)))
    expect(handOversFor('c1', C.pk).map((v) => v.by)).toEqual([B.pk])
    expect(HAND_OVER_CAP).toBe(256)
    // Filled straight in (one store per hand-over re-reads the list each
    // time), then one more stored the normal way evicts the oldest.
    const filler = Array.from({ length: HAND_OVER_CAP - 1 }, () => handOver(A, 'c1', key().pk))
    store.update((p) => { p.pendingVouches.c1 = [...p.pendingVouches.c1!, ...filler] })
    expect(allHandOvers('c1')).toHaveLength(HAND_OVER_CAP)
    expect(storePendingVouch(must(handOver(A, 'c1', key().pk)))).toBe(true)
    expect(handOversFor('c1', C.pk)).toEqual([]) // the oldest hand-over went
    expect(allHandOvers('c1')).toHaveLength(HAND_OVER_CAP)
    expect(pendingVouchesFor('c1', C.pk)).toEqual([])
  }, 20_000)

  it('final fix N1: an invite and a hand-over by the same voucher for the same pk are kept apart', () => {
    expect(storePendingVouch(must(memberInvite(A, 'c1', C.pk, 10)))).toBe(true)
    expect(storePendingVouch(must(handOver(A, 'c1', C.pk, 5)))).toBe(true)
    expect(pendingVouchesFor('c1', C.pk)).toHaveLength(2)
    expect(handOversFor('c1', C.pk).map((v) => v.createdAt)).toEqual([5])
  })

  it('refuses a far-future vouch; drop and forget clear them', () => {
    expect(storePendingVouch(must(handOver(A, 'c1', C.pk, 2_000)), { nowSec: 1_000 })).toBe(false)
    storePendingVouch(must(handOver(A, 'c1', C.pk)))
    storePendingVouch(must(handOver(A, 'c1', B.pk)))
    dropPendingVouches('c1', C.pk)
    expect(pendingVouchesFor('c1', C.pk)).toEqual([])
    expect(pendingVouchesFor('c1', B.pk)).toHaveLength(1)
    forgetCircleVouches('c1')
    expect(pendingVouchesFor('c1', B.pk)).toEqual([])
  })
})
