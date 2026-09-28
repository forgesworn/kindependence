// The full authority table (plan 2, Task 5; spec §4): every row allowed and
// refused, against hand-built TrustViews and real signed inner events.

import { describe, it, expect } from 'vitest'
import { makeLocalSigner, toHex } from '@forgesworn/covey-kit'
import type { CircleMember, Role } from '@forgesworn/covey-kit'
import type { SignedEvent } from '@forgesworn/roost-kit'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import {
  mayRemove, vouchValid, configAuthorised, configVerdict, structuralAuthorised, holdsLinkedDependant, parseConfigV2, CONFIG_MAX_ENTRIES,
  type TrustView, type ConfigV2,
} from './authority.js'
import { structuralTemplate, verifyStructural, type StructuralAction } from './structural.js'
import { verifyVouch, vouchPayload, UNVOUCHED_GRACE_SEC, type Vouch } from './vouches.js'

interface Key { sk: string; pk: string }
function key(): Key {
  const sk = generateSecretKey()
  return { sk: toHex(sk), pk: getPublicKey(sk) }
}

const G = key() // guardian
const G2 = key() // guardian, linked to no dependant here
const P = key() // peer
const P2 = key() // peer
const K = key() // dependant (child), linked to G
const X = key() // outsider
const N = key() // someone being added
const CID = 'c1'
const PREV = 'a'.repeat(64)
const NOW = 1_000_000

async function signed(by: Key, action: StructuralAction, payload: string, circleId = CID): Promise<SignedEvent> {
  return makeLocalSigner(by.sk).signEvent(structuralTemplate({ action, circleId, prevSeedHash: PREV, payload, nowSec: NOW }))
}

async function inviteEv(by: Key, pk: string, role: Role, circleId = CID): Promise<SignedEvent> {
  return signed(by, 'invite', JSON.stringify({ id: circleId, name: 'Circle', mode: 'family', pk, role }), circleId)
}

async function vouchOf(by: Key, pk: string, role: Role = 'peer'): Promise<Vouch> {
  return verifyVouch(await inviteEv(by, pk, role))!
}

async function structOf(by: Key, action: StructuralAction, payload: string) {
  return verifyStructural(await signed(by, action, payload))!
}

const ROSTER: CircleMember[] = [
  { pk: G.pk, role: 'guardian' }, { pk: G2.pk, role: 'guardian' },
  { pk: P.pk, role: 'peer' }, { pk: P2.pk, role: 'peer' }, { pk: K.pk, role: 'child' },
]

function view(o: Partial<TrustView> & { vouchers?: Record<string, string>; unvouched?: Record<string, number>; links?: Array<[string, string]>; stored?: Record<string, Vouch> } = {}): TrustView {
  const links = o.links ?? [[G.pk, K.pk]]
  return {
    members: o.members ?? ROSTER,
    name: o.name ?? 'Circle',
    creator: o.creator === undefined ? G.pk : o.creator,
    voucherOf: (pk) => o.vouchers?.[pk] ?? null,
    vouchFor: (pk) => o.stored?.[pk] ?? null,
    linked: (g, d) => links.some(([a, b]) => a === g && b === d),
    unvouchedSince: (pk) => o.unvouched?.[pk] ?? null,
  }
}

function cfg(by: Key, members: CircleMember[], extra: Partial<ConfigV2> = {}): ConfigV2 {
  return { v: 2, id: CID, name: 'Circle', createdBy: G.pk, updatedAt: NOW, by: by.pk, members, vouches: [], ...extra }
}

const noStored = (): Vouch | null => null

describe('parseConfigV2', () => {
  it('accepts a v2 config and refuses v1, a bad createdBy and duplicate members', () => {
    const ok = cfg(G, ROSTER)
    expect(parseConfigV2(JSON.stringify(ok))?.members).toHaveLength(5)
    expect(parseConfigV2(JSON.stringify({ ...ok, v: 1 }))).toBeNull()
    expect(parseConfigV2(JSON.stringify({ ...ok, createdBy: 'nope' }))).toBeNull()
    expect(parseConfigV2(JSON.stringify({ ...ok, members: [...ROSTER, ROSTER[0]] }))).toBeNull()
    expect(parseConfigV2(JSON.stringify({ ...ok, vouches: undefined }))).toBeNull()
  })
  it('final review A, M4: refuses more than CONFIG_MAX_ENTRIES members or vouches', () => {
    const ok = cfg(G, ROSTER)
    const many = Array.from({ length: CONFIG_MAX_ENTRIES + 1 }, (_, i) => ({ pk: i.toString(16).padStart(64, '0'), role: 'peer' }))
    expect(parseConfigV2(JSON.stringify({ ...ok, members: many }))).toBeNull()
    expect(parseConfigV2(JSON.stringify({ ...ok, members: many.slice(0, CONFIG_MAX_ENTRIES) }))).not.toBeNull()
    expect(parseConfigV2(JSON.stringify({ ...ok, vouches: Array.from({ length: CONFIG_MAX_ENTRIES + 1 }, () => ({})) }))).toBeNull()
  })
})

describe('invite (add + vouch)', () => {
  it('allowed: a peer vouches a new peer', async () => {
    expect(structuralAuthorised(view(), await structOf(P, 'invite', JSON.stringify({ id: CID, name: 'Circle', mode: 'family', pk: N.pk, role: 'peer' })), NOW)).toBe(true)
  })
  it('refused: a forged vouch signed by a non-member', async () => {
    const v = await vouchOf(X, N.pk)
    expect(vouchValid(view(), v, 'peer')).toBe(false)
    expect(structuralAuthorised(view(), verifyStructural(v.event)!, NOW)).toBe(false)
  })
  it('refused: a peer vouching a guardian (above its own role)', async () => {
    expect(vouchValid(view(), await vouchOf(P, N.pk, 'guardian'), 'guardian')).toBe(false)
  })
  it('a dependant needs a link voucher→vouchee: refused without, allowed with', async () => {
    const v = await vouchOf(G2, N.pk, 'child')
    expect(vouchValid(view(), v, 'child')).toBe(false)
    expect(vouchValid(view({ links: [[G2.pk, N.pk]] }), v, 'child')).toBe(true)
  })
  it('allowed: a dependant vouches a new peer (Task 6 ruling: any member adds a peer)', async () => {
    expect(vouchValid(view(), await vouchOf(K, N.pk, 'peer'), 'peer')).toBe(true)
  })
  it('refused: a guardian vouching a dependant without a link', async () => {
    expect(vouchValid(view(), await vouchOf(G, N.pk, 'child'), 'child')).toBe(false)
  })
  it('refused: a role above the one the invite vouch names', async () => {
    expect(vouchValid(view(), await vouchOf(G, N.pk, 'peer'), 'guardian')).toBe(false)
  })
})

describe('vouch (hand-over)', () => {
  it('allowed: any member vouches another member', async () => {
    expect(structuralAuthorised(view(), await structOf(P2, 'vouch', vouchPayload(P.pk)), NOW)).toBe(true)
  })
  it('refused: the vouchee is not a member', async () => {
    expect(structuralAuthorised(view(), await structOf(P2, 'vouch', vouchPayload(N.pk)), NOW)).toBe(false)
  })
  it('refused: a non-member signer', async () => {
    expect(structuralAuthorised(view(), await structOf(X, 'vouch', vouchPayload(P.pk)), NOW)).toBe(false)
  })
})

describe('mayRemove / config: members removed', () => {
  const without = (pk: string): CircleMember[] => ROSTER.filter((m) => m.pk !== pk)

  it('a voucher removing their vouchee is allowed; a non-voucher peer is refused', () => {
    const v = view({ vouchers: { [P2.pk]: P.pk } })
    expect(mayRemove(v, P.pk, P2.pk, NOW)).toBe(true)
    expect(configAuthorised(v, CID, P.pk, cfg(P, without(P2.pk)), noStored, NOW)).toBe(true)
    expect(mayRemove(view(), P.pk, P2.pk, NOW)).toBe(false)
    expect(configAuthorised(view(), CID, P.pk, cfg(P, without(P2.pk)), noStored, NOW)).toBe(false)
  })
  it('a guardian removes anyone', () => {
    expect(configAuthorised(view(), CID, G.pk, cfg(G, without(P.pk)), noStored, NOW)).toBe(true)
  })
  it('leave: any member removes themself, a dependant too', () => {
    expect(mayRemove(view(), K.pk, K.pk, NOW)).toBe(true)
    expect(configAuthorised(view(), CID, K.pk, cfg(K, without(K.pk)), noStored, NOW)).toBe(true)
  })
  it('unvouched for ≥ 71 h: anyone may remove; under 71 h: refused', () => {
    const at = (h: number): TrustView => view({ unvouched: { [P2.pk]: NOW - h * 3600 } })
    expect(mayRemove(at(71), K.pk, P2.pk, NOW)).toBe(true)
    expect(UNVOUCHED_GRACE_SEC).toBe(72 * 3600)
    expect(mayRemove(at(70.9), K.pk, P2.pk, NOW)).toBe(false)
  })
  it('refused: a dependant removing a guardian', () => {
    expect(configAuthorised(view(), CID, K.pk, cfg(K, without(G.pk)), noStored, NOW)).toBe(false)
  })
})

describe('config: members added', () => {
  it('allowed with a carried vouch valid against the roster before the change', async () => {
    const v = await vouchOf(P, N.pk)
    expect(configAuthorised(view(), CID, P.pk, cfg(P, [...ROSTER, { pk: N.pk, role: 'peer' }], { vouches: [v.event] }), noStored, NOW)).toBe(true)
  })
  it('allowed with a stored vouch', async () => {
    const v = await vouchOf(G, N.pk)
    expect(configAuthorised(view(), CID, P.pk, cfg(P, [...ROSTER, { pk: N.pk, role: 'peer' }]), (pk) => (pk === N.pk ? v : null), NOW)).toBe(true)
  })
  it('no vouch at all: refused as needing a vouch (parked, not dropped)', () => {
    expect(configVerdict(view(), CID, P.pk, cfg(P, [...ROSTER, { pk: N.pk, role: 'peer' }]), noStored, NOW)).toBe('needs-vouch')
  })
  it('a carried forged vouch (by a non-member) does not authorise; a valid one may still arrive (parked)', async () => {
    const v = await vouchOf(X, N.pk)
    expect(configVerdict(view(), CID, P.pk, cfg(P, [...ROSTER, { pk: N.pk, role: 'peer' }], { vouches: [v.event] }), noStored, NOW)).toBe('needs-vouch')
  })
  it('fix round 1 (I3): any one valid vouch among carried and pending ones authorises; bad ones do not block', async () => {
    const bad = await vouchOf(P, N.pk, 'guardian') // a peer can't vouch a guardian
    const good = await vouchOf(G2, N.pk, 'guardian')
    const members = [...ROSTER, { pk: N.pk, role: 'guardian' as Role }]
    expect(configVerdict(view(), CID, G.pk, cfg(G, members, { vouches: [bad.event] }), () => [bad], NOW)).toBe('needs-vouch')
    expect(configVerdict(view(), CID, G.pk, cfg(G, members, { vouches: [bad.event] }), () => [bad, good], NOW)).toBe('ok')
    expect(configVerdict(view(), CID, G.pk, cfg(G, members, { vouches: [bad.event, good.event] }), () => [], NOW)).toBe('ok')
  })
  it('refused: the voucher is only added by the same config (judged against the roster before)', async () => {
    const vx = await vouchOf(G, X.pk)
    const vn = await vouchOf(X, N.pk)
    const members = [...ROSTER, { pk: X.pk, role: 'peer' as Role }, { pk: N.pk, role: 'peer' as Role }]
    expect(configAuthorised(view(), CID, G.pk, cfg(G, members, { vouches: [vx.event, vn.event] }), noStored, NOW)).toBe(false)
  })
  it('fix round 1 (C1): re-adding the held creator needs a vouch and the role cap like anyone', async () => {
    const members = ROSTER.filter((m) => m.pk !== G.pk)
    const v = view({ members })
    const readd = [...members, { pk: G.pk, role: 'guardian' as Role }]
    expect(configVerdict(v, CID, P.pk, cfg(P, readd), noStored, NOW)).toBe('needs-vouch')
    // A peer's vouch can't put the creator back as a guardian…
    const byPeer = await vouchOf(P, G.pk, 'guardian')
    expect(configAuthorised(v, CID, P.pk, cfg(P, readd, { vouches: [byPeer.event] }), noStored, NOW)).toBe(false)
    // …a guardian's can.
    const byGuardian = await vouchOf(G2, G.pk, 'guardian')
    expect(configAuthorised(v, CID, P.pk, cfg(P, readd, { vouches: [byGuardian.event] }), noStored, NOW)).toBe(true)
  })
})

describe('config: role changed, name, createdBy', () => {
  const withRole = (pk: string, role: Role): CircleMember[] => ROSTER.map((m) => (m.pk === pk ? { ...m, role } : m))

  it('a guardian changes a peer\'s role; a peer is refused', () => {
    expect(configAuthorised(view(), CID, G.pk, cfg(G, withRole(P2.pk, 'guardian')), noStored, NOW)).toBe(true)
    expect(configAuthorised(view(), CID, P.pk, cfg(P, withRole(P2.pk, 'guardian')), noStored, NOW)).toBe(false)
  })
  it('a change to or from child needs a link signer→member', () => {
    expect(configAuthorised(view(), CID, G2.pk, cfg(G2, withRole(K.pk, 'peer')), noStored, NOW)).toBe(false)
    expect(configAuthorised(view(), CID, G.pk, cfg(G, withRole(K.pk, 'peer')), noStored, NOW)).toBe(true)
    expect(configAuthorised(view(), CID, G.pk, cfg(G, withRole(P.pk, 'child')), noStored, NOW)).toBe(false)
  })
  it('nobody raises their own role', () => {
    expect(configAuthorised(view(), CID, P.pk, cfg(P, withRole(P.pk, 'guardian')), noStored, NOW)).toBe(false)
    expect(configAuthorised(view(), CID, K.pk, cfg(K, withRole(K.pk, 'peer')), noStored, NOW)).toBe(false)
  })
  it('a guardian renames; a peer is refused', () => {
    expect(configAuthorised(view(), CID, G.pk, cfg(G, ROSTER, { name: 'New' }), noStored, NOW)).toBe(true)
    expect(configAuthorised(view(), CID, P.pk, cfg(P, ROSTER, { name: 'New' }), noStored, NOW)).toBe(false)
  })
  it('createdBy must equal the held creator; \'\' (unknown) is accepted; any when none is held', () => {
    expect(configAuthorised(view(), CID, G.pk, cfg(G, ROSTER, { createdBy: P.pk }), noStored, NOW)).toBe(false)
    expect(configAuthorised(view(), CID, G.pk, cfg(G, ROSTER), noStored, NOW)).toBe(true)
    expect(configAuthorised(view(), CID, G.pk, cfg(G, ROSTER, { createdBy: '' }), noStored, NOW)).toBe(true)
    // A leave from a writer that holds no creator.
    expect(configAuthorised(view(), CID, P.pk, cfg(P, ROSTER.filter((m) => m.pk !== P.pk), { createdBy: '' }), noStored, NOW)).toBe(true)
    expect(configAuthorised(view({ creator: null }), CID, G.pk, cfg(G, ROSTER, { createdBy: P.pk }), noStored, NOW)).toBe(true)
  })
  it('refused: `by` names someone else, or the signer is not a member', () => {
    expect(configAuthorised(view(), CID, G.pk, cfg(P, ROSTER), noStored, NOW)).toBe(false)
    expect(configAuthorised(view(), CID, X.pk, cfg(X, ROSTER), noStored, NOW)).toBe(false)
  })
})

describe('rekey', () => {
  const rk = (removals: string[]): string => JSON.stringify({ id: CID, next: 'b'.repeat(64), prev: PREV, removals, to: [] })

  it('a peer voucher re-keying out their vouchee is allowed; a non-voucher peer is refused', async () => {
    expect(structuralAuthorised(view({ vouchers: { [P2.pk]: P.pk } }), await structOf(P, 'rekey', rk([P2.pk])), NOW)).toBe(true)
    expect(structuralAuthorised(view(), await structOf(P, 'rekey', rk([P2.pk])), NOW)).toBe(false)
  })
  it('a guardian re-keys anyone out', async () => {
    expect(structuralAuthorised(view(), await structOf(G2, 'rekey', rk([G.pk])), NOW)).toBe(true)
  })
  it('a re-key removing no member (revocation, recovery) is allowed for any member, a dependant too', async () => {
    expect(structuralAuthorised(view(), await structOf(K, 'rekey', rk([])), NOW)).toBe(true)
    expect(structuralAuthorised(view(), await structOf(K, 'rekey', rk([X.pk])), NOW)).toBe(true) // X already out
  })
  it('refused: a dependant re-keying a guardian out, and an outsider', async () => {
    expect(structuralAuthorised(view(), await structOf(K, 'rekey', rk([G.pk])), NOW)).toBe(false)
    expect(structuralAuthorised(view(), await structOf(X, 'rekey', rk([])), NOW)).toBe(false)
  })
})

describe('places, family-policy, approval-resp, agreement, extend-resp', () => {
  const actions: StructuralAction[] = ['places', 'family-policy', 'approval-resp', 'agreement', 'extend-resp']

  it('allowed: a guardian holding a linked dependant in this circle', async () => {
    expect(holdsLinkedDependant(view(), G.pk)).toBe(true)
    for (const a of actions) expect(structuralAuthorised(view(), await structOf(G, a, '{}'), NOW)).toBe(true)
  })
  it('refused: a dependant signing places or policy', async () => {
    for (const a of actions) expect(structuralAuthorised(view(), await structOf(K, a, '{}'), NOW)).toBe(false)
  })
  it('refused: a guardian who holds no linked dependant in this circle', async () => {
    expect(holdsLinkedDependant(view(), G2.pk)).toBe(false)
    for (const a of actions) expect(structuralAuthorised(view(), await structOf(G2, a, '{}'), NOW)).toBe(false)
  })
  it('refused: a peer, even one linked to a dependant', async () => {
    const v = view({ links: [[P.pk, K.pk]] })
    for (const a of actions) expect(structuralAuthorised(v, await structOf(P, a, '{}'), NOW)).toBe(false)
  })
})
