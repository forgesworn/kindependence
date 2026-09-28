import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import { bytesToHex } from '@noble/hashes/utils.js'
import type { Circle, CircleMember } from '@forgesworn/covey-kit'
import * as store from './store.js'
import * as circles from './circles.js'
import * as structuralQueue from './structural-queue.js'
import { sessionForTests } from './session.js'
import { setContactsSource } from './contacts.js'
import type { ContactsSnapshot, Tier } from './contacts.js'
import { structuralTemplate, seedHash, type StructuralAction } from './structural.js'
import { verifyVouch, vouchPayload, storeVouch, markUnvouched, unvouchedSince } from './vouches.js'
import { guardianOfTemplate, dependantOfTemplate, unlinkTemplate } from './device-statements.js'
import { acceptLinkPair, acceptUnlink } from './guardian-links.js'
import { designatedRekeyer, onContactsChanged, tick, start, prompts, answerPrompt } from './trust-watch.js'

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

interface Key { sk: Uint8Array; pk: string }
function key(): Key {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}
function skHex(): string {
  return bytesToHex(generateSecretKey())
}

const PREV = seedHash('a'.repeat(64))

function struct(by: Key, action: StructuralAction, circleId: string, payload: string, at: number) {
  return finalizeEvent(structuralTemplate({ action, circleId, prevSeedHash: PREV, payload, nowSec: at }), by.sk)
}
function handOverEv(by: Key, circleId: string, pk: string, at: number) {
  return struct(by, 'vouch', circleId, vouchPayload(pk), at)
}
function inviteEv(by: Key, circleId: string, pk: string, role: 'guardian' | 'peer' | 'child', at: number) {
  return struct(by, 'invite', circleId, JSON.stringify({ id: circleId, name: 'F', mode: 'family', pk, role }), at)
}
function must(ev: unknown) {
  const v = verifyVouch(ev)
  if (!v) throw new Error('expected a valid vouch')
  return v
}

function makeCircle(overrides: Partial<Circle> & { id: string; members: CircleMember[] }): store.StoredCircle {
  return {
    name: 'Family', seedHex: '1'.repeat(64), epoch: 0,
    createdAt: 100, configUpdatedAt: 100, configBy: overrides.members[0]!.pk,
    ...overrides,
  }
}

function contact(pk: string, tier: Tier | undefined, blocked = false): ContactsSnapshot['contacts'][number] {
  return { contactId: `c-${pk}`, pks: [pk], name: 'Contact', tier, blocked }
}
function snapOf(contactsList: ContactsSnapshot['contacts']): ContactsSnapshot {
  return { status: 'connected', contacts: contactsList, fresh: true, at: 0 }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage())
})

afterEach(() => {
  sessionForTests(null)
  structuralQueue.resetForTests()
  setContactsSource(null)
  vi.restoreAllMocks()
})

describe('designatedRekeyer', () => {
  it('the lowest pk among non-child-role members', () => {
    const [a, b, c] = [key(), key(), key()].sort((x, y) => (x.pk < y.pk ? -1 : 1))
    const circle = makeCircle({
      id: 'c1',
      members: [
        { pk: b.pk, role: 'guardian' },
        { pk: a.pk, role: 'peer' },
        { pk: c.pk, role: 'child' },
      ],
    })
    expect(designatedRekeyer(circle)).toBe(a.pk)
  })

  it('null with no eligible (non-child) member', () => {
    const d = key()
    const circle = makeCircle({ id: 'c1', members: [{ pk: d.pk, role: 'child' }] })
    expect(designatedRekeyer(circle)).toBeNull()
  })
})

describe('onContactsChanged — explicit drops and prompts', () => {
  it('an explicit ken drop of my vouchee removes them once', () => {
    const self = key()
    const vouchee = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    const circle = makeCircle({ id: 'c1', members: [{ pk: self.pk, role: 'guardian' }, { pk: vouchee.pk, role: 'peer' }] })
    store.update((p) => { p.circles = [circle] })
    storeVouch(must(inviteEv(self, 'c1', vouchee.pk, 'peer', 50)))
    const removeSpy = vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)
    const leaveSpy = vi.spyOn(circles, 'leaveCircle').mockResolvedValue(undefined)

    const prev = snapOf([contact(vouchee.pk, 'kin')])
    const next = snapOf([contact(vouchee.pk, 'ken')])
    onContactsChanged(next, prev)

    expect(removeSpy).toHaveBeenCalledTimes(1)
    expect(removeSpy).toHaveBeenCalledWith('c1', vouchee.pk)
    expect(leaveSpy).not.toHaveBeenCalled()
    expect(prompts()).toEqual([])
  })

  it('a blocked contact is removed the same way', () => {
    const self = key()
    const vouchee = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: self.pk, role: 'guardian' }, { pk: vouchee.pk, role: 'peer' }] })] })
    storeVouch(must(inviteEv(self, 'c1', vouchee.pk, 'peer', 50)))
    const removeSpy = vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)

    const prev = snapOf([contact(vouchee.pk, 'kin')])
    const next = snapOf([contact(vouchee.pk, 'kin', true)])
    onContactsChanged(next, prev)

    expect(removeSpy).toHaveBeenCalledTimes(1)
    expect(removeSpy).toHaveBeenCalledWith('c1', vouchee.pk)
  })

  it('my own voucher dropping leaves the circle', () => {
    const self = key()
    const voucher = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: voucher.pk, role: 'guardian' }, { pk: self.pk, role: 'peer' }] })] })
    storeVouch(must(inviteEv(voucher, 'c1', self.pk, 'peer', 50)))
    const removeSpy = vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)
    const leaveSpy = vi.spyOn(circles, 'leaveCircle').mockResolvedValue(undefined)

    const prev = snapOf([contact(voucher.pk, 'kin')])
    const next = snapOf([contact(voucher.pk, 'ken')])
    onContactsChanged(next, prev)

    expect(leaveSpy).toHaveBeenCalledTimes(1)
    expect(leaveSpy).toHaveBeenCalledWith('c1')
    expect(removeSpy).not.toHaveBeenCalled()
  })

  it('final small-fixes round: a voucher who has since left the circle is not watched — their drop from my contacts does not leave the circle', () => {
    const self = key()
    const voucher = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    // `voucherOf` (final fix N1) always resolves to the ORIGINAL voucher,
    // still a member or not — the voucher here has already left: the
    // circle's current roster no longer includes them.
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: self.pk, role: 'peer' }] })] })
    storeVouch(must(inviteEv(voucher, 'c1', self.pk, 'peer', 50)))
    const removeSpy = vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)
    const leaveSpy = vi.spyOn(circles, 'leaveCircle').mockResolvedValue(undefined)

    // The departed voucher also drops out of my contacts entirely.
    const other = key()
    const prev = snapOf([contact(voucher.pk, 'kin'), contact(other.pk, 'kin')])
    const next = snapOf([contact(other.pk, 'kin')])
    onContactsChanged(next, prev)

    expect(leaveSpy).not.toHaveBeenCalled()
    expect(removeSpy).not.toHaveBeenCalled()
    expect(prompts()).toEqual([])
  })

  it('an absent vouchee raises one prompt and removes nothing; answering yes removes them', () => {
    const self = key()
    const vouchee = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: self.pk, role: 'guardian' }, { pk: vouchee.pk, role: 'peer' }] })] })
    storeVouch(must(inviteEv(self, 'c1', vouchee.pk, 'peer', 50)))
    const removeSpy = vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)

    // Emptying the WHOLE grant to zero is `unknown` (contacts.ts's own
    // "an emptied-out grant looks like a connection loss" rule) — a lone
    // absence needs another contact still present in `next`.
    const other = key()
    const prev = snapOf([contact(vouchee.pk, 'kin'), contact(other.pk, 'kin')])
    const next = snapOf([contact(other.pk, 'kin')]) // vouchee no longer present at all
    onContactsChanged(next, prev)

    expect(removeSpy).not.toHaveBeenCalled()
    const open = prompts()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ kind: 'absent', pks: [vouchee.pk] })

    answerPrompt(open[0]!.id, true)
    expect(removeSpy).toHaveBeenCalledTimes(1)
    expect(removeSpy).toHaveBeenCalledWith('c1', vouchee.pk)
    expect(prompts()).toEqual([])
  })

  it('answering a prompt with no just dismisses it', () => {
    const self = key()
    const vouchee = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: self.pk, role: 'guardian' }, { pk: vouchee.pk, role: 'peer' }] })] })
    storeVouch(must(inviteEv(self, 'c1', vouchee.pk, 'peer', 50)))
    const removeSpy = vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)

    const other = key()
    onContactsChanged(snapOf([contact(other.pk, 'kin')]), snapOf([contact(vouchee.pk, 'kin'), contact(other.pk, 'kin')]))
    const id = prompts()[0]!.id
    answerPrompt(id, false)
    expect(removeSpy).not.toHaveBeenCalled()
    expect(prompts()).toEqual([])
  })

  it('two drops in one update raise one bulk prompt and remove nothing', () => {
    const self = key()
    const voucheeA = key()
    const voucheeB = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => {
      p.circles = [makeCircle({
        id: 'c1',
        members: [{ pk: self.pk, role: 'guardian' }, { pk: voucheeA.pk, role: 'peer' }, { pk: voucheeB.pk, role: 'peer' }],
      })]
    })
    storeVouch(must(inviteEv(self, 'c1', voucheeA.pk, 'peer', 50)))
    storeVouch(must(inviteEv(self, 'c1', voucheeB.pk, 'peer', 51)))
    const removeSpy = vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)

    const prev = snapOf([contact(voucheeA.pk, 'kin'), contact(voucheeB.pk, 'kin')])
    const next = snapOf([contact(voucheeA.pk, 'ken'), contact(voucheeB.pk, 'ken')])
    onContactsChanged(next, prev)

    expect(removeSpy).not.toHaveBeenCalled()
    const open = prompts()
    expect(open).toHaveLength(1)
    expect(open[0]!.kind).toBe('bulk')
    expect(new Set(open[0]!.pks)).toEqual(new Set([voucheeA.pk, voucheeB.pk]))
  })

  it('a disconnected grant removes nothing and raises no prompt', () => {
    const self = key()
    const vouchee = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: self.pk, role: 'guardian' }, { pk: vouchee.pk, role: 'peer' }] })] })
    storeVouch(must(inviteEv(self, 'c1', vouchee.pk, 'peer', 50)))
    const removeSpy = vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)

    const prev = snapOf([contact(vouchee.pk, 'kin')])
    const next: ContactsSnapshot = { status: 'disconnected', contacts: [], fresh: false, at: 0 }
    onContactsChanged(next, prev)

    expect(removeSpy).not.toHaveBeenCalled()
    expect(prompts()).toEqual([])
  })

  it('a truncated snapshot removes nothing and raises no prompt', () => {
    const self = key()
    const vouchee = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: self.pk, role: 'guardian' }, { pk: vouchee.pk, role: 'peer' }] })] })
    storeVouch(must(inviteEv(self, 'c1', vouchee.pk, 'peer', 50)))
    const removeSpy = vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)

    const prev = snapOf([contact(vouchee.pk, 'kin')])
    const next: ContactsSnapshot = { status: 'connected', contacts: [contact(vouchee.pk, 'ken')], fresh: true, at: 0, truncated: true }
    onContactsChanged(next, prev)

    expect(removeSpy).not.toHaveBeenCalled()
    expect(prompts()).toEqual([])
  })

  it('a linked guardian dropping from kin to ken is never dropped (C1)', () => {
    const self = key()
    const guardian = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: guardian.pk, role: 'guardian' }, { pk: self.pk, role: 'child' }] })] })
    storeVouch(must(inviteEv(guardian, 'c1', self.pk, 'child', 50)))
    // A REAL link pair — not just a vouch — so `linkedWithMe` reports true:
    // the guardian counts as usable regardless of what the contact grant
    // says next, per spec §6 ("a link counts as usable; only an unlink
    // drops it").
    expect(acceptLinkPair(
      finalizeEvent(guardianOfTemplate(self.pk, 100), guardian.sk),
      finalizeEvent(dependantOfTemplate(guardian.pk, 100), self.sk),
    )).toBe(true)
    const removeSpy = vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)
    const leaveSpy = vi.spyOn(circles, 'leaveCircle').mockResolvedValue(undefined)

    // Genuinely usable in `prev` (tier 'kin', not just linked) so this isn't
    // the old vacuous case — the drop is real, only the link exempts it.
    const prev = snapOf([contact(guardian.pk, 'kin')])
    const next = snapOf([contact(guardian.pk, 'ken')])
    onContactsChanged(next, prev)

    expect(removeSpy).not.toHaveBeenCalled()
    expect(leaveSpy).not.toHaveBeenCalled()
    expect(prompts()).toEqual([])
  })

  it('a blocked linked guardian is never dropped (C1)', () => {
    const self = key()
    const guardian = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: guardian.pk, role: 'guardian' }, { pk: self.pk, role: 'child' }] })] })
    storeVouch(must(inviteEv(guardian, 'c1', self.pk, 'child', 50)))
    expect(acceptLinkPair(
      finalizeEvent(guardianOfTemplate(self.pk, 100), guardian.sk),
      finalizeEvent(dependantOfTemplate(guardian.pk, 100), self.sk),
    )).toBe(true)
    const leaveSpy = vi.spyOn(circles, 'leaveCircle').mockResolvedValue(undefined)

    const prev = snapOf([contact(guardian.pk, 'kin')])
    const next = snapOf([contact(guardian.pk, 'kin', true)])
    onContactsChanged(next, prev)

    expect(leaveSpy).not.toHaveBeenCalled()
    expect(prompts()).toEqual([])
  })

  it('final review B, minor 4: a dependant session does not auto-remove its own vouchee — it gets a prompt, and answering it removes for real', () => {
    const self = key()
    const vouchee = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: true })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: self.pk, role: 'peer' }, { pk: vouchee.pk, role: 'peer' }] })] })
    storeVouch(must(inviteEv(self, 'c1', vouchee.pk, 'peer', 50)))
    const removeSpy = vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)

    const prev = snapOf([contact(vouchee.pk, 'kin')])
    const next = snapOf([contact(vouchee.pk, 'ken')])
    onContactsChanged(next, prev)

    // No silent removal — a prompt instead, same shape as an ordinary
    // absence.
    expect(removeSpy).not.toHaveBeenCalled()
    const open = prompts()
    expect(open).toHaveLength(1)
    expect(open[0]).toMatchObject({ kind: 'absent', pks: [vouchee.pk] })

    // The tap answering the prompt IS the guardian-tap the plan asks for —
    // it removes for real, dependant or not.
    answerPrompt(open[0]!.id, true)
    expect(removeSpy).toHaveBeenCalledTimes(1)
    expect(removeSpy).toHaveBeenCalledWith('c1', vouchee.pk)
  })

  it('final review B, minor 4: a dependant still leaves automatically when its OWN voucher drops (unaffected)', () => {
    const self = key()
    const voucher = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: true })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: voucher.pk, role: 'guardian' }, { pk: self.pk, role: 'child' }] })] })
    storeVouch(must(inviteEv(voucher, 'c1', self.pk, 'child', 50)))
    const leaveSpy = vi.spyOn(circles, 'leaveCircle').mockResolvedValue(undefined)

    const prev = snapOf([contact(voucher.pk, 'kin')])
    const next = snapOf([contact(voucher.pk, 'ken')])
    onContactsChanged(next, prev)

    expect(leaveSpy).toHaveBeenCalledTimes(1)
    expect(leaveSpy).toHaveBeenCalledWith('c1')
    expect(prompts()).toEqual([])
  })
})

describe('final review B, minor 6: bulk-prompt dedupe and a re-check at answer time', () => {
  it('two identical bulk drops raise only one prompt', () => {
    const self = key()
    const voucheeA = key()
    const voucheeB = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => {
      p.circles = [makeCircle({
        id: 'c1',
        members: [{ pk: self.pk, role: 'guardian' }, { pk: voucheeA.pk, role: 'peer' }, { pk: voucheeB.pk, role: 'peer' }],
      })]
    })
    storeVouch(must(inviteEv(self, 'c1', voucheeA.pk, 'peer', 50)))
    storeVouch(must(inviteEv(self, 'c1', voucheeB.pk, 'peer', 51)))
    vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)

    const prev = snapOf([contact(voucheeA.pk, 'kin'), contact(voucheeB.pk, 'kin')])
    const next = snapOf([contact(voucheeA.pk, 'ken'), contact(voucheeB.pk, 'ken')])
    // Two updates report the exact same bulk drop (e.g. the duplicate
    // watcher finding C1 flagged, or simply two identical polls).
    onContactsChanged(next, prev)
    onContactsChanged(next, prev)

    const open = prompts().filter((pr) => pr.kind === 'bulk')
    expect(open).toHaveLength(1)
  })

  it('a pk that becomes usable again before the prompt is answered is not removed', () => {
    const self = key()
    const vouchee = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: self.pk, role: 'guardian' }, { pk: vouchee.pk, role: 'peer' }] })] })
    storeVouch(must(inviteEv(self, 'c1', vouchee.pk, 'peer', 50)))
    const removeSpy = vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)

    const other = key()
    // A lone absence — raises a prompt without acting.
    onContactsChanged(snapOf([contact(other.pk, 'kin')]), snapOf([contact(vouchee.pk, 'kin'), contact(other.pk, 'kin')]))
    const id = prompts()[0]!.id

    // The contact comes back as usable (kin again) before the prompt is
    // answered — e.g. it was a transient My Signet blip.
    setContactsSource({ current: () => snapOf([contact(vouchee.pk, 'kin'), contact(other.pk, 'kin')]), onUpdate: () => () => {} })

    answerPrompt(id, true)
    expect(removeSpy).not.toHaveBeenCalled()
    expect(prompts()).toEqual([])
  })

  it('a pk that becomes guardian-linked before the prompt is answered is not removed', () => {
    const guardian = key()
    const dependant = key()
    sessionForTests({ identityPk: guardian.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: guardian.pk, role: 'guardian' }, { pk: dependant.pk, role: 'child' }] })] })
    storeVouch(must(inviteEv(guardian, 'c1', dependant.pk, 'child', 50)))
    const removeSpy = vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)

    const other = key()
    onContactsChanged(snapOf([contact(other.pk, 'kin')]), snapOf([contact(dependant.pk, 'kin'), contact(other.pk, 'kin')]))
    const id = prompts()[0]!.id

    expect(acceptLinkPair(
      finalizeEvent(guardianOfTemplate(dependant.pk, 100), guardian.sk),
      finalizeEvent(dependantOfTemplate(guardian.pk, 100), dependant.sk),
    )).toBe(true)

    answerPrompt(id, true)
    expect(removeSpy).not.toHaveBeenCalled()
  })
})

describe('a broken guardian link that backed a vouch', () => {
  it('is treated as an automatic explicit drop', () => {
    const guardian = key()
    const dependant = key()
    sessionForTests({ identityPk: guardian.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: guardian.pk, role: 'guardian' }, { pk: dependant.pk, role: 'child' }] })] })
    storeVouch(must(inviteEv(guardian, 'c1', dependant.pk, 'child', 50)))
    expect(acceptLinkPair(
      finalizeEvent(guardianOfTemplate(dependant.pk, 100), guardian.sk),
      finalizeEvent(dependantOfTemplate(guardian.pk, 100), dependant.sk),
    )).toBe(true)
    const removeSpy = vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)

    const stop = start()
    try {
      expect(acceptUnlink(finalizeEvent(unlinkTemplate(dependant.pk, 200), guardian.sk))).toBe(true)
      expect(removeSpy).toHaveBeenCalledWith('c1', dependant.pk)
    } finally {
      stop()
    }
  })

  it('final review B, minor 5: records the notice as a guardian-link removal, not a contacts drop', () => {
    const guardian = key()
    const dependant = key()
    sessionForTests({ identityPk: guardian.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', name: 'Family', members: [{ pk: guardian.pk, role: 'guardian' }, { pk: dependant.pk, role: 'child', name: 'Dependant' }] })] })
    storeVouch(must(inviteEv(guardian, 'c1', dependant.pk, 'child', 50)))
    expect(acceptLinkPair(
      finalizeEvent(guardianOfTemplate(dependant.pk, 100), guardian.sk),
      finalizeEvent(dependantOfTemplate(guardian.pk, 100), dependant.sk),
    )).toBe(true)
    vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)

    const stop = start()
    try {
      expect(acceptUnlink(finalizeEvent(unlinkTemplate(dependant.pk, 200), guardian.sk))).toBe(true)
      const entries = store.load().activity.filter((e) => e.kind === 'member-removed')
      expect(entries).toHaveLength(1)
      expect(entries[0]!.params.reason).toBe('Removed Dependant: guardian link removed')
      expect(entries[0]!.params.reason).not.toContain('no longer in your contacts')
    } finally {
      stop()
    }
  })
})

describe('hand-over', () => {
  it('an adult with the unvouched member as a usable contact queues one vouch, and does not double-queue', () => {
    const self = key()
    const target = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: self.pk, role: 'guardian' }, { pk: target.pk, role: 'peer', name: 'Target' }] })] })
    markUnvouched('c1', target.pk, 1_000)
    // A usable (kin) contact of mine.
    setContactsSource({ current: () => snapOf([contact(target.pk, 'kin')]), onUpdate: () => () => {} })

    tick(1_500)
    const items = structuralQueue.pending().filter((i) => i.action === 'vouch')
    expect(items).toHaveLength(1)
    expect(items[0]!.circleId).toBe('c1')
    expect(items[0]!.payload).toBe(vouchPayload(target.pk))

    tick(1_600)
    expect(structuralQueue.pending().filter((i) => i.action === 'vouch')).toHaveLength(1)
  })

  it('a dependant session queues no hand-over vouch', () => {
    const self = key()
    const target = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: true })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: self.pk, role: 'peer' }, { pk: target.pk, role: 'peer' }] })] })
    markUnvouched('c1', target.pk, 1_000)
    setContactsSource({ current: () => snapOf([contact(target.pk, 'kin')]), onUpdate: () => () => {} })

    tick(1_500)
    expect(structuralQueue.pending().filter((i) => i.action === 'vouch')).toHaveLength(0)
  })

  it('never hands over a vouch it is not authorised to make: a peer cannot vouch for a guardian (I1)', () => {
    const self = key()
    const target = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: self.pk, role: 'peer' }, { pk: target.pk, role: 'guardian', name: 'Target' }] })] })
    markUnvouched('c1', target.pk, 1_000)
    // A usable (kin) contact — `contacts.usable` alone would say yes; only
    // `mayVouch`'s role check catches that a `peer` can't vouch a `guardian`.
    setContactsSource({ current: () => snapOf([contact(target.pk, 'kin')]), onUpdate: () => () => {} })

    tick(1_500)
    expect(structuralQueue.pending().filter((i) => i.action === 'vouch')).toHaveLength(0)
    // Nothing was ever queued, so repeated ticks don't spam a signer prompt
    // either (the pre-fix bug: an invalid vouch signed and rejected every
    // 10 minutes for up to 72 h).
    tick(1_600)
    tick(2_200)
    expect(structuralQueue.pending().filter((i) => i.action === 'vouch')).toHaveLength(0)
  })

  it('never hands over a vouch it is not authorised to make: a dependant vouch needs a guardian link, not just a kin contact (I1)', () => {
    const self = key()
    const target = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: self.pk, role: 'guardian' }, { pk: target.pk, role: 'child', name: 'Target' }] })] })
    markUnvouched('c1', target.pk, 1_000)
    // Usable via contact tier alone (kin) but NOT linked to self.
    setContactsSource({ current: () => snapOf([contact(target.pk, 'kin')]), onUpdate: () => () => {} })

    tick(1_500)
    expect(structuralQueue.pending().filter((i) => i.action === 'vouch')).toHaveLength(0)
  })

  it('final review B, minor 7: a dismissed hand-over vouch is not re-offered every tick — only once `unvouchedSince` changes', () => {
    const self = key()
    const target = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: self.pk, role: 'guardian' }, { pk: target.pk, role: 'peer', name: 'Target' }] })] })
    markUnvouched('c1', target.pk, 1_000)
    setContactsSource({ current: () => snapOf([contact(target.pk, 'kin')]), onUpdate: () => () => {} })

    tick(1_500)
    const queued = structuralQueue.pending().filter((i) => i.action === 'vouch')
    expect(queued).toHaveLength(1)

    // The user dismisses it (structural-queue's own Dismiss/cancel).
    structuralQueue.cancel(queued[0]!.id)
    expect(structuralQueue.pending().filter((i) => i.action === 'vouch')).toHaveLength(0)

    // Repeated ticks, `unvouchedSince` unchanged — must not re-offer it.
    tick(1_600)
    tick(2_200)
    tick(2_800)
    expect(structuralQueue.pending().filter((i) => i.action === 'vouch')).toHaveLength(0)

    // A fresh unvouched mark (a different `since` — `markUnvouched` itself
    // is a no-op once a mark already exists for this pk, so this simulates
    // what a clear-then-remark round trip would leave behind).
    store.update((p) => { p.unvouchedSince['c1'] = { [target.pk]: 3_000 } })
    tick(3_100)
    expect(structuralQueue.pending().filter((i) => i.action === 'vouch')).toHaveLength(1)
  })
})

describe('the 72 h unvouched timeout (three non-child members)', () => {
  function threeMemberCircle(target: Key): { circle: store.StoredCircle; designated: Key; other: Key } {
    const [a, b, c] = [key(), key(), key()].sort((x, y) => (x.pk < y.pk ? -1 : 1))
    const circle = makeCircle({
      id: 'c1',
      members: [
        { pk: a.pk, role: 'guardian' },
        { pk: b.pk, role: 'guardian' },
        { pk: c.pk, role: 'peer' },
        { pk: target.pk, role: 'peer' },
      ],
    })
    return { circle, designated: a, other: b }
  }

  it('only the designated re-keyer re-keys right at 72 h', () => {
    const target = key()
    const { circle, designated, other } = threeMemberCircle(target)
    store.update((p) => { p.circles = [circle] })
    markUnvouched('c1', target.pk, 0)
    const rekeySpy = vi.spyOn(circles, 'sendRekey').mockResolvedValue(undefined)

    sessionForTests({ identityPk: designated.pk, phoneSkHex: skHex(), dependant: false })
    tick(72 * 3600)
    expect(rekeySpy).toHaveBeenCalledTimes(1)
    expect(rekeySpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), [target.pk])

    sessionForTests(null)
    rekeySpy.mockClear()
    sessionForTests({ identityPk: other.pk, phoneSkHex: skHex(), dependant: false })
    tick(72 * 3600)
    expect(rekeySpy).not.toHaveBeenCalled()
  })

  it('another member re-keys 10 minutes after 72 h only if the seed has not moved', () => {
    const target = key()
    const { circle, other } = threeMemberCircle(target)
    store.update((p) => { p.circles = [circle] })
    markUnvouched('c1', target.pk, 0)
    const rekeySpy = vi.spyOn(circles, 'sendRekey').mockResolvedValue(undefined)
    sessionForTests({ identityPk: other.pk, phoneSkHex: skHex(), dependant: false })

    tick(72 * 3600) // first observes the timeout — starts its own clock, doesn't act
    expect(rekeySpy).not.toHaveBeenCalled()
    tick(72 * 3600 + 599)
    expect(rekeySpy).not.toHaveBeenCalled()
    tick(72 * 3600 + 600)
    expect(rekeySpy).toHaveBeenCalledTimes(1)
    expect(rekeySpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), [target.pk])
  })

  it('does not fire the fallback once the seed has moved on', () => {
    const target = key()
    const { circle, other } = threeMemberCircle(target)
    store.update((p) => { p.circles = [circle] })
    markUnvouched('c1', target.pk, 0)
    const rekeySpy = vi.spyOn(circles, 'sendRekey').mockResolvedValue(undefined)
    sessionForTests({ identityPk: other.pk, phoneSkHex: skHex(), dependant: false })

    tick(72 * 3600)
    expect(rekeySpy).not.toHaveBeenCalled()
    // Someone else's re-key landed in the meantime.
    store.update((p) => { p.circles = [{ ...p.circles[0]!, seedHex: '2'.repeat(64) }] })
    tick(72 * 3600 + 600)
    expect(rekeySpy).not.toHaveBeenCalled()
  })

  it('a vouch arriving before 72 h cancels the removal', () => {
    const target = key()
    const { circle, designated } = threeMemberCircle(target)
    store.update((p) => { p.circles = [circle] })
    markUnvouched('c1', target.pk, 0)
    const rekeySpy = vi.spyOn(circles, 'sendRekey').mockResolvedValue(undefined)
    sessionForTests({ identityPk: designated.pk, phoneSkHex: skHex(), dependant: false })

    tick(71 * 3600)
    expect(rekeySpy).not.toHaveBeenCalled()
    expect(unvouchedSince('c1', target.pk)).not.toBeNull()
    expect(circles.acceptVouch('c1', handOverEv(designated, 'c1', target.pk, 71 * 3600 + 10), 71 * 3600 + 10)).toBe(true)
    expect(unvouchedSince('c1', target.pk)).toBeNull()

    tick(73 * 3600)
    expect(rekeySpy).not.toHaveBeenCalled()
  })
})

describe('a member who just left is re-keyed out', () => {
  it('immediately by the designated re-keyer', () => {
    const [a, b] = [key(), key()].sort((x, y) => (x.pk < y.pk ? -1 : 1))
    const leaver = key()
    // The roster no longer holds `leaver` — the config that removed them has
    // already applied by the time `onMemberLeft` fires.
    const circle = makeCircle({ id: 'c1', members: [{ pk: a.pk, role: 'guardian' }, { pk: b.pk, role: 'guardian' }] })
    store.update((p) => { p.circles = [circle] })
    sessionForTests({ identityPk: a.pk, phoneSkHex: skHex(), dependant: false })
    const rekeySpy = vi.spyOn(circles, 'sendRekey').mockResolvedValue(undefined)
    const onMemberLeftSpy = vi.spyOn(circles, 'onMemberLeft')

    const stop = start()
    try {
      const handler = onMemberLeftSpy.mock.calls[0]![0]
      handler('c1', leaver.pk, 1_000)
      expect(rekeySpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), [leaver.pk])
    } finally {
      stop()
    }
  })

  it('10 minutes later by another member, only if the seed has not moved', () => {
    const [a, b] = [key(), key()].sort((x, y) => (x.pk < y.pk ? -1 : 1))
    const leaver = key()
    const circle = makeCircle({ id: 'c1', members: [{ pk: a.pk, role: 'guardian' }, { pk: b.pk, role: 'guardian' }] })
    store.update((p) => { p.circles = [circle] })
    sessionForTests({ identityPk: b.pk, phoneSkHex: skHex(), dependant: false })
    const rekeySpy = vi.spyOn(circles, 'sendRekey').mockResolvedValue(undefined)
    const onMemberLeftSpy = vi.spyOn(circles, 'onMemberLeft')

    const stop = start()
    try {
      const handler = onMemberLeftSpy.mock.calls[0]![0]
      handler('c1', leaver.pk, 1_000)
      expect(rekeySpy).not.toHaveBeenCalled()
      tick(1_000 + 599)
      expect(rekeySpy).not.toHaveBeenCalled()
      tick(1_000 + 600)
      expect(rekeySpy).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), [leaver.pk])
    } finally {
      stop()
    }
  })
})

describe('sendRekey is deduped against an in-flight removal (I2)', () => {
  function twoGuardianCircle(target: Key): { circle: store.StoredCircle; designated: Key } {
    const [a, b] = [key(), key()].sort((x, y) => (x.pk < y.pk ? -1 : 1))
    const circle = makeCircle({ id: 'c1', members: [{ pk: a.pk, role: 'guardian' }, { pk: b.pk, role: 'guardian' }, { pk: target.pk, role: 'peer' }] })
    return { circle, designated: a }
  }

  it('the 72 h timeout does not resend once pendingRemovals already holds the pk', () => {
    const target = key()
    const { circle, designated } = twoGuardianCircle(target)
    store.update((p) => { p.circles = [circle]; p.pendingRemovals = { c1: [target.pk] } })
    markUnvouched('c1', target.pk, 0)
    const rekeySpy = vi.spyOn(circles, 'sendRekey').mockResolvedValue(undefined)
    sessionForTests({ identityPk: designated.pk, phoneSkHex: skHex(), dependant: false })

    tick(72 * 3600)
    expect(rekeySpy).not.toHaveBeenCalled()
  })

  it('the 72 h timeout does not resend once a queued rekey already carries the pk', () => {
    const target = key()
    const { circle, designated } = twoGuardianCircle(target)
    store.update((p) => {
      p.circles = [circle]
      p.structuralQueue = [{
        id: 'q1', action: 'rekey', circleId: 'c1',
        payload: JSON.stringify({ id: 'c1', next: 'a'.repeat(64), prev: 'b'.repeat(64), removals: [target.pk], to: [] }),
        label: 'Renew the key', status: 'waiting', createdAt: 0, attempts: 0,
      }]
    })
    markUnvouched('c1', target.pk, 0)
    const rekeySpy = vi.spyOn(circles, 'sendRekey').mockResolvedValue(undefined)
    sessionForTests({ identityPk: designated.pk, phoneSkHex: skHex(), dependant: false })

    tick(72 * 3600)
    expect(rekeySpy).not.toHaveBeenCalled()
  })

  it('an in-flight timeout re-key is not resent on the following ticks (the pre-fix flood)', () => {
    const target = key()
    const { circle, designated } = twoGuardianCircle(target)
    store.update((p) => { p.circles = [circle] })
    markUnvouched('c1', target.pk, 0)
    // Simulates the real `sendRekey`'s own side effect (recording the
    // removal in `pendingRemovals` — circles.ts ~1050-1072) without
    // exercising the real signer/session plumbing.
    const rekeySpy = vi.spyOn(circles, 'sendRekey').mockImplementation(async (c, removals) => {
      store.update((p) => { p.pendingRemovals = { ...p.pendingRemovals, [c.id]: [...(p.pendingRemovals[c.id] ?? []), ...removals] } })
    })
    sessionForTests({ identityPk: designated.pk, phoneSkHex: skHex(), dependant: false })

    tick(72 * 3600)
    expect(rekeySpy).toHaveBeenCalledTimes(1)
    tick(72 * 3600 + 600)
    tick(72 * 3600 + 1200)
    expect(rekeySpy).toHaveBeenCalledTimes(1)
  })

  it('the leave re-key is also skipped once pendingRemovals already holds the pk', () => {
    const [a, b] = [key(), key()].sort((x, y) => (x.pk < y.pk ? -1 : 1))
    const leaver = key()
    const circle = makeCircle({ id: 'c1', members: [{ pk: a.pk, role: 'guardian' }, { pk: b.pk, role: 'guardian' }] })
    store.update((p) => { p.circles = [circle]; p.pendingRemovals = { c1: [leaver.pk] } })
    sessionForTests({ identityPk: a.pk, phoneSkHex: skHex(), dependant: false })
    const rekeySpy = vi.spyOn(circles, 'sendRekey').mockResolvedValue(undefined)
    const onMemberLeftSpy = vi.spyOn(circles, 'onMemberLeft')

    const stop = start()
    try {
      const handler = onMemberLeftSpy.mock.calls[0]![0]
      handler('c1', leaver.pk, 1_000)
      expect(rekeySpy).not.toHaveBeenCalled()
    } finally {
      stop()
    }
  })
})

describe('reasoned Activity notices (I3)', () => {
  it('an explicit removal of my vouchee records why', () => {
    const self = key()
    const vouchee = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: self.pk, role: 'guardian' }, { pk: vouchee.pk, role: 'peer' }] })] })
    storeVouch(must(inviteEv(self, 'c1', vouchee.pk, 'peer', 50)))
    vi.spyOn(circles, 'removeMemberFromCircle').mockResolvedValue(undefined)

    const prev = snapOf([contact(vouchee.pk, 'kin')])
    const next = snapOf([contact(vouchee.pk, 'ken')])
    onContactsChanged(next, prev)

    const entries = store.load().activity.filter((e) => e.kind === 'member-removed')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.params.reason).toBe(`Removed ${vouchee.pk.slice(0, 8)}: no longer in your contacts`)
  })

  it('leaving because my voucher dropped records why', () => {
    const self = key()
    const voucher = key()
    sessionForTests({ identityPk: self.pk, phoneSkHex: skHex(), dependant: false })
    store.update((p) => { p.circles = [makeCircle({ id: 'c1', members: [{ pk: voucher.pk, role: 'guardian' }, { pk: self.pk, role: 'peer' }] })] })
    storeVouch(must(inviteEv(voucher, 'c1', self.pk, 'peer', 50)))
    vi.spyOn(circles, 'leaveCircle').mockResolvedValue(undefined)

    const prev = snapOf([contact(voucher.pk, 'kin')])
    const next = snapOf([contact(voucher.pk, 'ken')])
    onContactsChanged(next, prev)

    const entries = store.load().activity.filter((e) => e.kind === 'member-left')
    expect(entries).toHaveLength(1)
    expect(entries[0]!.params.reason).toBe(`Left Family: ${voucher.pk.slice(0, 8)} is no longer in your contacts`)
  })

  it('the 72 h timeout records why, exactly once across repeated ticks', () => {
    const [a, b] = [key(), key()].sort((x, y) => (x.pk < y.pk ? -1 : 1))
    const target = key()
    const circle = makeCircle({ id: 'c1', members: [{ pk: a.pk, role: 'guardian' }, { pk: b.pk, role: 'guardian' }, { pk: target.pk, role: 'peer' }] })
    store.update((p) => { p.circles = [circle] })
    markUnvouched('c1', target.pk, 0)
    vi.spyOn(circles, 'sendRekey').mockImplementation(async (c, removals) => {
      store.update((p) => { p.pendingRemovals = { ...p.pendingRemovals, [c.id]: [...(p.pendingRemovals[c.id] ?? []), ...removals] } })
    })
    sessionForTests({ identityPk: a.pk, phoneSkHex: skHex(), dependant: false })

    tick(72 * 3600)
    tick(72 * 3600 + 600)
    tick(72 * 3600 + 1200)

    const entries = store.load().activity.filter((e) => e.kind === 'member-removed' && e.params.reason?.includes('nobody vouched'))
    expect(entries).toHaveLength(1)
    expect(entries[0]!.params.reason).toBe(`Removed ${target.pk.slice(0, 8)}: nobody vouched for them within 72 hours`)
  })

  it('final review B, deferred minor: sendRekey returning early (e.g. our own phone revoked) never spams a notice, one per tick', () => {
    const [a, b] = [key(), key()].sort((x, y) => (x.pk < y.pk ? -1 : 1))
    const target = key()
    const circle = makeCircle({ id: 'c1', members: [{ pk: a.pk, role: 'guardian' }, { pk: b.pk, role: 'guardian' }, { pk: target.pk, role: 'peer' }] })
    store.update((p) => { p.circles = [circle] })
    markUnvouched('c1', target.pk, 0)
    // The real early-return path (circles.ts's own `sendRekey`: our own
    // phone revoked, nothing of ours survives to receive the new seed
    // either) never touches `pendingRemovals` — modelled here by a mock
    // that resolves without writing anything.
    const rekeySpy = vi.spyOn(circles, 'sendRekey').mockResolvedValue(undefined)
    sessionForTests({ identityPk: a.pk, phoneSkHex: skHex(), dependant: false }) // `a` is the designated re-keyer

    tick(72 * 3600)
    tick(72 * 3600 + 600)
    tick(72 * 3600 + 1200)

    expect(rekeySpy).toHaveBeenCalledTimes(3) // keeps quietly retrying
    expect(store.load().activity.filter((e) => e.kind === 'member-removed' && e.params.reason?.includes('nobody vouched'))).toHaveLength(0)

    // Once it actually succeeds (sets `pendingRemovals`), the notice fires —
    // exactly once.
    rekeySpy.mockImplementation(async (c, removals) => {
      store.update((p) => { p.pendingRemovals = { ...p.pendingRemovals, [c.id]: [...(p.pendingRemovals[c.id] ?? []), ...removals] } })
    })
    tick(72 * 3600 + 1800)
    const entries = store.load().activity.filter((e) => e.kind === 'member-removed' && e.params.reason?.includes('nobody vouched'))
    expect(entries).toHaveLength(1)
  })
})

describe('start() (final review B, finding C1: no re-entrant recursion via render())', () => {
  it('a member already past the 72 h grace, with self as designated re-keyer, mounts without start() re-entering through a render-like store subscriber', async () => {
    const [a, b] = [key(), key()].sort((x, y) => (x.pk < y.pk ? -1 : 1))
    const target = key()
    const circle = makeCircle({ id: 'c1', members: [{ pk: a.pk, role: 'guardian' }, { pk: b.pk, role: 'guardian' }, { pk: target.pk, role: 'peer' }] })
    store.update((p) => { p.circles = [circle] })
    // Long past 72 h ago by any real wall clock — `tick()`'s own `nowSec()`
    // is real, not fake (see trust-watch.ts's own doc comment).
    markUnvouched('c1', target.pk, 0)
    vi.spyOn(circles, 'sendRekey').mockImplementation(async (c, removals) => {
      // A real `sendRekey` eventually writes to the store too — exactly the
      // kind of write that used to re-enter `render()` while `start()` was
      // still on the stack (finding C1).
      store.update((p) => { p.pendingRemovals = { ...p.pendingRemovals, [c.id]: [...(p.pendingRemovals[c.id] ?? []), ...removals] } })
    })
    sessionForTests({ identityPk: a.pk, phoneSkHex: skHex(), dependant: false })

    // Same shape as app.ts's own render(): `if (!stopTrustWatch) stopTrustWatch
    // = trustWatch.start()`, called on every store notification — a render
    // subscriber guarded at a generous depth, same as the finding's own repro
    // (which needed only 50 levels to prove the bug).
    let stop: (() => void) | null = null
    let renderCalls = 0
    const GUARD_DEPTH = 50
    function renderLike(): void {
      renderCalls++
      if (renderCalls > GUARD_DEPTH) throw new Error('start() re-entered render() — unbounded recursion (finding C1)')
      if (!stop) stop = start()
    }
    const unsubscribe = store.subscribe(renderLike)
    try {
      renderLike() // the mounting render() call
      // Flush the deferred initial tick() (queueMicrotask) — see this
      // function's own doc comment on why one microtask turn suffices.
      await Promise.resolve()

      expect(renderCalls).toBeLessThan(GUARD_DEPTH)
      expect(circles.sendRekey).toHaveBeenCalledTimes(1)
      expect(circles.sendRekey).toHaveBeenCalledWith(expect.objectContaining({ id: 'c1' }), [target.pk])
    } finally {
      unsubscribe()
      stop?.()
    }
  })

  it('is idempotent: a second call before stop() returns the same stop function and does not double-subscribe', () => {
    const onMemberLeftSpy = vi.spyOn(circles, 'onMemberLeft')
    const stop1 = start()
    const stop2 = start()
    try {
      expect(stop2).toBe(stop1)
      expect(onMemberLeftSpy).toHaveBeenCalledTimes(1)
    } finally {
      stop1()
    }
  })

  it('stop() (sign-out) actually tears the watcher down — a later start() re-subscribes fresh', () => {
    const onMemberLeftSpy = vi.spyOn(circles, 'onMemberLeft')
    const stop1 = start()
    stop1()
    const stop2 = start()
    try {
      expect(stop2).not.toBe(stop1)
      expect(onMemberLeftSpy).toHaveBeenCalledTimes(2)
    } finally {
      stop2()
    }
  })
})
