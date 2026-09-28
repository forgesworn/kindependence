import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import type { Circle } from '@forgesworn/covey-kit'
import { deriveInbox, toHex } from '@forgesworn/covey-kit'
import { giftUnwrap, rawNip44Decrypt } from '@forgesworn/roost-kit'
import * as store from './store.js'
import * as structuralQueue from './structural-queue.js'
import { deviceStatementTemplate, revocationTemplate, verifyRevocation, guardianOfTemplate, dependantOfTemplate, unlinkTemplate } from './device-statements.js'
import { acceptLinkPair, acceptUnlink } from './guardian-links.js'
import { acceptStatement, memberForPhone } from './phone-keys.js'
import { sessionForTests, currentSession } from './session.js'
import * as signin from './signin.js'
import * as beacons from './beacons.js'
import * as circles from './circles.js'
import { SignerUnavailable } from './remote-signer.js'
import { WAITING_FOR_SIGNET } from './structural-queue.js'
import { fakeBunker } from './test-support/fake-bunker.js'
import {
  deviceEntries, membersWithoutPhoneAfterRemoval, removePhone, confirmRemoval, confirmSignOut, handleAction,
  dependantDeviceEntries, removeDependantPhone, confirmDependantRemoval,
  resetForTests, view,
} from './devices.js'

// `removePhone` does real (non-network) crypto via the identity signer and
// `giftWrap` — only the relay publish actually leaves the process. Same
// "mock just publishSigned" idiom as circles.test.ts/beacons.test.ts.
vi.mock('@forgesworn/roost-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgesworn/roost-kit')>()
  return { ...actual, publishSigned: vi.fn(async () => ({})) }
})
import { publishSigned } from '@forgesworn/roost-kit'

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

afterEach(() => {
  sessionForTests(null)
  structuralQueue.resetForTests()
  resetForTests()
  signin.resetForTests()
  vi.clearAllMocks()
})

interface Key { sk: Uint8Array; pk: string }
function key(): Key {
  const sk = generateSecretKey()
  return { sk, pk: getPublicKey(sk) }
}

function statement(identity: Key, phonePk: string, at = 1000) {
  return finalizeEvent(deviceStatementTemplate(phonePk, at), identity.sk)
}

function fakeCircle(overrides: Partial<Circle> = {}): Circle {
  return {
    id: 'circle-1', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
    members: [], createdAt: 100, configUpdatedAt: 100, configBy: '',
    ...overrides,
  }
}

const NOW = 2000

describe('deviceEntries / view — the phone list', () => {
  it('shows own and other phones, own first, with last-seen', () => {
    const alex = key()
    const ownPhone = key()
    const otherPhone = key()
    const circle = fakeCircle({ members: [{ pk: alex.pk, role: 'guardian' }] })
    store.save({ ...store.load(), circles: [circle] })
    expect(acceptStatement(circle, statement(alex, ownPhone.pk, 900), ownPhone.pk, 1000)).toBe('added')
    expect(acceptStatement(circle, statement(alex, otherPhone.pk, 950), otherPhone.pk, 1500)).toBe('added')

    sessionForTests({ identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk) })
    const p = store.load()
    const entries = deviceEntries(p, { identityPk: alex.pk, phonePk: ownPhone.pk } as never)

    expect(entries).toHaveLength(2)
    expect(entries[0]).toMatchObject({ phonePk: ownPhone.pk, own: true, addedAt: 900, lastSeen: 1000 })
    expect(entries[1]).toMatchObject({ phonePk: otherPhone.pk, own: false, addedAt: 950, lastSeen: 1500 })

    const html = view(p)
    expect(html).toContain('This phone')
    expect(html).toContain('Phone added')
    expect(html).toContain('Remove this phone')
    expect(html).toContain('>Remove<')
  })

  it('dedups a phone bound across more than one circle, keeping the freshest last-seen', () => {
    const alex = key()
    const phone = key()
    const c1 = fakeCircle({ id: 'c1', members: [{ pk: alex.pk, role: 'guardian' }] })
    const c2 = fakeCircle({ id: 'c2', members: [{ pk: alex.pk, role: 'guardian' }] })
    store.save({ ...store.load(), circles: [c1, c2] })
    expect(acceptStatement(c1, statement(alex, phone.pk, 900), phone.pk, 1000)).toBe('added')
    expect(acceptStatement(c2, statement(alex, phone.pk, 900), phone.pk, 1800)).toBe('added')

    const p = store.load()
    const entries = deviceEntries(p, { identityPk: alex.pk, phonePk: 'x'.repeat(64) } as never)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ phonePk: phone.pk, lastSeen: 1800, circleIds: ['c1', 'c2'] })
  })
})

describe('membersWithoutPhoneAfterRemoval — the confirm-dialog warning', () => {
  it('warns about a guardian-role, re-keyed circle whose member has no other known phone', () => {
    const alex = key()
    const bea = key()
    const alexPhoneA = key()
    const alexPhoneB = key()
    const circle = fakeCircle({
      name: 'Family',
      members: [{ pk: alex.pk, role: 'guardian' }, { pk: bea.pk, role: 'child', name: 'Bea' }],
    })
    store.save({ ...store.load(), circles: [circle] })
    expect(acceptStatement(circle, statement(alex, alexPhoneA.pk), alexPhoneA.pk, NOW)).toBe('added')
    expect(acceptStatement(circle, statement(alex, alexPhoneB.pk), alexPhoneB.pk, NOW)).toBe('added')
    // Bea has never posted a device statement into this circle — no known phone.

    const self = { identityPk: alex.pk, phonePk: alexPhoneA.pk } as never
    const p = store.load()

    // Removing alexPhoneB: Bea still has none, alex still has alexPhoneA — warns about Bea only.
    expect(membersWithoutPhoneAfterRemoval(p, self, alexPhoneB.pk)).toEqual([
      { memberName: 'Bea', circleName: 'Family' },
    ])
  })

  it('does not warn for a non-guardian device (no re-key would be triggered)', () => {
    const alex = key()
    const bea = key()
    const alexPhone = key()
    const circle = fakeCircle({
      members: [{ pk: alex.pk, role: 'child' }, { pk: bea.pk, role: 'guardian', name: 'Bea' }],
    })
    store.save({ ...store.load(), circles: [circle] })
    expect(acceptStatement(circle, statement(alex, alexPhone.pk), alexPhone.pk, NOW)).toBe('added')

    const self = { identityPk: alex.pk, phonePk: alexPhone.pk } as never
    expect(membersWithoutPhoneAfterRemoval(store.load(), self, alexPhone.pk)).toEqual([])
  })
})

describe('removePhone — success', () => {
  it('posts a revocation into every shared circle and enqueues a re-key in each guardian-role circle', async () => {
    const alex = key()
    const ownPhone = key()
    const otherPhone = key()
    const c1 = fakeCircle({ id: 'c1', name: 'Circle One', seedHex: 'a'.repeat(64), members: [{ pk: alex.pk, role: 'guardian' }] })
    const c2 = fakeCircle({ id: 'c2', name: 'Circle Two', seedHex: 'b'.repeat(64), members: [{ pk: alex.pk, role: 'guardian' }] })
    store.save({ ...store.load(), circles: [c1, c2] })
    expect(acceptStatement(c1, statement(alex, ownPhone.pk), ownPhone.pk, NOW)).toBe('added')
    expect(acceptStatement(c1, statement(alex, otherPhone.pk), otherPhone.pk, NOW)).toBe('added')
    expect(acceptStatement(c2, statement(alex, ownPhone.pk), ownPhone.pk, NOW)).toBe('added')
    expect(acceptStatement(c2, statement(alex, otherPhone.pk), otherPhone.pk, NOW)).toBe('added')

    const bunker = fakeBunker({ sk: alex.sk })
    sessionForTests({ identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk), transport: bunker })

    const result = await removePhone(otherPhone.pk)
    expect(result).toBe('removed')

    // Applied locally: dead everywhere, immediately.
    expect(memberForPhone('c1', otherPhone.pk)).toBeNull()
    expect(memberForPhone('c2', otherPhone.pk)).toBeNull()
    expect(store.load().revokedPhoneKeys[otherPhone.pk]).toBeTruthy()

    // A re-key was enqueued for both guardian-role circles.
    const queued = store.load().structuralQueue
    expect(queued.map((q) => q.circleId).sort()).toEqual(['c1', 'c2'])
    expect(queued.every((q) => q.action === 'rekey')).toBe(true)

    // Posted (t:'revoke') into both circle inboxes — c1's wrap is the FIRST
    // post (`shared` walks `p.circles` in order, [c1, c2]).
    expect(vi.mocked(publishSigned)).toHaveBeenCalledTimes(2)
    const [, firstWrap] = vi.mocked(publishSigned).mock.calls[0] as [string[], { pubkey: string; content: string }]
    const inbox1 = deriveInbox(c1.seedHex)
    const rumor = await giftUnwrap(rawNip44Decrypt(inbox1.sk), firstWrap)
    expect(rumor).not.toBeNull()
    const t = rumor!.tags.find((tag) => tag[0] === 't')?.[1]
    expect(t).toBe('revoke')
    const rv = verifyRevocation(JSON.parse(rumor!.content))
    expect(rv?.phonePk).toBe(otherPhone.pk)
    expect(rv?.signerPk).toBe(alex.pk)
  })

  it('removing THIS phone posts the revocation first, then signs out', async () => {
    const alex = key()
    const ownPhone = key()
    const c1 = fakeCircle({ id: 'c1', members: [{ pk: alex.pk, role: 'guardian' }] })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(alex, ownPhone.pk), ownPhone.pk, NOW)).toBe('added')

    const bunker = fakeBunker({ sk: alex.sk })
    sessionForTests({ identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk), transport: bunker })

    const result = await removePhone(ownPhone.pk)
    expect(result).toBe('signed-out')

    expect(vi.mocked(publishSigned)).toHaveBeenCalledTimes(1)
    // signOut() wipes the WHOLE local store back to defaults, AFTER posting.
    expect(store.load().circles).toEqual([])
    expect(store.load().session).toBeUndefined()
  })
})

describe('removePhone — a declined or unavailable signature changes nothing', () => {
  it('SignerRejected: no revocation posted, nothing enqueued', async () => {
    const alex = key()
    const ownPhone = key()
    const otherPhone = key()
    const c1 = fakeCircle({ id: 'c1', members: [{ pk: alex.pk, role: 'guardian' }] })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(alex, otherPhone.pk), otherPhone.pk, NOW)).toBe('added')

    const bunker = fakeBunker({ sk: alex.sk, approve: () => false })
    sessionForTests({ identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk), transport: bunker })

    const result = await removePhone(otherPhone.pk)
    expect(result).toBe('rejected')
    expect(vi.mocked(publishSigned)).not.toHaveBeenCalled()
    expect(store.load().revokedPhoneKeys[otherPhone.pk]).toBeUndefined()
    expect(store.load().structuralQueue).toEqual([])
    expect(memberForPhone('c1', otherPhone.pk)).toBe(alex.pk)
  })

  it('SignerUnavailable: no revocation posted, nothing enqueued', async () => {
    const alex = key()
    const ownPhone = key()
    const otherPhone = key()
    const c1 = fakeCircle({ id: 'c1', members: [{ pk: alex.pk, role: 'guardian' }] })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(alex, otherPhone.pk), otherPhone.pk, NOW)).toBe('added')

    sessionForTests({
      identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk),
      transport: {
        pubkey: alex.pk,
        signEvent: async () => { throw new SignerUnavailable('asleep') },
        nip44Encrypt: async () => { throw new Error('unused') },
        nip44Decrypt: async () => { throw new Error('unused') },
        close: async () => {},
      },
    })

    const result = await removePhone(otherPhone.pk)
    expect(result).toBe('unavailable')
    expect(vi.mocked(publishSigned)).not.toHaveBeenCalled()
    expect(store.load().revokedPhoneKeys[otherPhone.pk]).toBeUndefined()
    expect(store.load().structuralQueue).toEqual([])
    expect(memberForPhone('c1', otherPhone.pk)).toBe(alex.pk)
  })
})

describe('Task 12 fix round 1, item 2: the hardened sign-out routine', () => {
  it('own-phone removal still fully signs out even if the underlying signOut throws (Keystore error)', async () => {
    const alex = key()
    const ownPhone = key()
    const c1 = fakeCircle({ id: 'c1', members: [{ pk: alex.pk, role: 'guardian' }] })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(alex, ownPhone.pk), ownPhone.pk, NOW)).toBe('added')

    const bunker = fakeBunker({ sk: alex.sk })
    sessionForTests({ identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk), transport: bunker })

    // Same "Keystore remove fails" simulation as session.test.ts's own
    // signOut coverage: `session.signOut()` still propagates this (its own
    // doc comment), but `signin.ts`'s `doSignOut` — the routine `removePhone`
    // uses for THIS device's own phone — catches it, so this must resolve
    // cleanly rather than reject.
    const removeItem = localStorage.removeItem.bind(localStorage)
    vi.spyOn(localStorage, 'removeItem').mockImplementation((k: string) => {
      if (k === 'kindependence.secret.phone-key') throw new Error('keystore remove failed')
      removeItem(k)
    })

    const result = await removePhone(ownPhone.pk)
    expect(result).toBe('signed-out')
    expect(store.load().circles).toEqual([])
    expect(store.load().session).toBeUndefined()
  })

  it('confirmRemoval (own phone): a Keystore error during sign-out still resolves cleanly and leaves the app signed out', async () => {
    const alex = key()
    const ownPhone = key()
    const c1 = fakeCircle({ id: 'c1', members: [{ pk: alex.pk, role: 'guardian' }] })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(alex, ownPhone.pk), ownPhone.pk, NOW)).toBe('added')

    const bunker = fakeBunker({ sk: alex.sk })
    sessionForTests({ identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk), transport: bunker })

    const removeItem = localStorage.removeItem.bind(localStorage)
    vi.spyOn(localStorage, 'removeItem').mockImplementation((k: string) => {
      if (k === 'kindependence.secret.phone-key') throw new Error('keystore remove failed')
      removeItem(k)
    })

    // Must not throw/reject — confirmRemoval's own try/finally, PLUS
    // doSignOut's own internal catch, both stand between this and an
    // unhandled rejection (this is fire-and-forget from handleAction in
    // production — `void confirmRemoval(pk)`).
    await confirmRemoval(ownPhone.pk)

    // Signed out despite the Keystore hiccup: the sign-in screen is what
    // app.ts would render next (signin.ts's own `resetForSignOut`, run by
    // `doSignOut`'s `finally`, is what guarantees this rather than some
    // stale mid-flow screen).
    expect(signin.shouldShow()).toBe(true)
    expect(view(store.load())).toBe('') // no session left to render a Devices section for
  })

  it('confirmRemoval clears busyPhone and shows a generic notice when something unexpected throws', async () => {
    const alex = key()
    const ownPhone = key()
    const otherPhone = key()
    const c1 = fakeCircle({ id: 'c1', members: [{ pk: alex.pk, role: 'guardian' }] })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(alex, otherPhone.pk), otherPhone.pk, NOW)).toBe('added')

    // `identitySigner()` always wraps its transport in `RemoteSigner`, whose
    // own `mapSignerError` classes EVERY transport failure as either
    // `SignerRejected` or `SignerUnavailable` — there is no way to make the
    // sign step itself throw anything else. So the genuinely-unexpected
    // failure this test means to cover is simulated one step later:
    // `beacons.applyRevocation` (awaited directly, with no catch of its own
    // in `removePhone`) rejecting.
    const bunker = fakeBunker({ sk: alex.sk })
    sessionForTests({ identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk), transport: bunker })
    const applySpy = vi.spyOn(beacons, 'applyRevocation').mockRejectedValue(new Error('boom'))

    await confirmRemoval(otherPhone.pk)
    applySpy.mockRestore()

    const html = view(store.load())
    expect(html).toContain("Couldn't remove the phone.")
    expect(html).not.toContain(WAITING_FOR_SIGNET) // busyPhone cleared, not stuck
    expect(html).toContain('>Remove<') // back to the plain, re-enabled button
  })

  it('disables every OTHER phone\'s Remove button while one is busy', async () => {
    const alex = key()
    const ownPhone = key()
    const otherPhone = key()
    const c1 = fakeCircle({ id: 'c1', members: [{ pk: alex.pk, role: 'guardian' }] })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(alex, ownPhone.pk), ownPhone.pk, NOW)).toBe('added')
    expect(acceptStatement(c1, statement(alex, otherPhone.pk), otherPhone.pk, NOW)).toBe('added')

    let releaseSigner: () => void = () => {}
    const gate = new Promise<void>((resolve) => { releaseSigner = resolve })
    sessionForTests({
      identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk),
      transport: {
        pubkey: alex.pk,
        signEvent: async (t) => { await gate; return finalizeEvent(t, alex.sk) },
        nip44Encrypt: async () => { throw new Error('unused') },
        nip44Decrypt: async () => { throw new Error('unused') },
        close: async () => {},
      },
    })

    const inFlight = confirmRemoval(otherPhone.pk) // busyPhone = otherPhone, still awaiting the (gated) signer
    const html = view(store.load())
    expect(html).toContain(WAITING_FOR_SIGNET) // otherPhone's own row
    expect(html).toContain('disabled>Remove this phone') // ownPhone's Remove button, disabled while otherPhone is busy

    releaseSigner()
    await inFlight
  })
})

describe('Sign out confirmation (final fix B5/I5)', () => {
  it('shows a plain Sign out button by default, with no confirm copy', () => {
    const alex = key()
    const ownPhone = key()
    const c1 = fakeCircle({ id: 'c1', members: [{ pk: alex.pk, role: 'guardian' }] })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(alex, ownPhone.pk), ownPhone.pk, NOW)).toBe('added')
    sessionForTests({ identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk) })

    const html = view(store.load())
    expect(html).toContain('data-action="devices-sign-out"')
    expect(html).not.toContain('This removes your circles from this phone')
  })

  it('devices-sign-out arms a confirm step with the binding copy and Cancel/Sign out buttons; nothing is signed out yet', () => {
    const alex = key()
    const ownPhone = key()
    const c1 = fakeCircle({ id: 'c1', members: [{ pk: alex.pk, role: 'guardian' }] })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(alex, ownPhone.pk), ownPhone.pk, NOW)).toBe('added')
    sessionForTests({ identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk) })

    handleAction('devices-sign-out', null as unknown as HTMLElement)
    const html = view(store.load())
    expect(html).toContain('Sign out? This removes your circles from this phone. You can be invited back.')
    expect(html).toContain('data-action="devices-sign-out-cancel"')
    expect(html).toContain('data-action="devices-sign-out-confirm"')
    expect(currentSession()).not.toBeNull() // nothing signed out on the first tap
  })

  it('devices-sign-out-cancel disarms back to the plain button, nothing signed out', () => {
    const alex = key()
    const ownPhone = key()
    const c1 = fakeCircle({ id: 'c1', members: [{ pk: alex.pk, role: 'guardian' }] })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(alex, ownPhone.pk), ownPhone.pk, NOW)).toBe('added')
    sessionForTests({ identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk) })

    handleAction('devices-sign-out', null as unknown as HTMLElement)
    handleAction('devices-sign-out-cancel', null as unknown as HTMLElement)
    const html = view(store.load())
    expect(html).toContain('data-action="devices-sign-out"')
    expect(html).not.toContain('This removes your circles from this phone')
    expect(currentSession()).not.toBeNull()
  })

  it('confirmSignOut (the devices-sign-out-confirm handler) actually signs out — session and circles cleared', async () => {
    const alex = key()
    const ownPhone = key()
    const c1 = fakeCircle({ id: 'c1', members: [{ pk: alex.pk, role: 'guardian' }] })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(alex, ownPhone.pk), ownPhone.pk, NOW)).toBe('added')
    sessionForTests({ identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk) })

    handleAction('devices-sign-out', null as unknown as HTMLElement)
    await confirmSignOut()

    expect(store.load().session).toBeUndefined()
    expect(store.load().circles).toEqual([])
  })
})

describe('Add my other phone (final fix B7/A5 UI)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('is hidden for a dependant session', () => {
    const alex = key()
    const ownPhone = key()
    sessionForTests({ identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk), dependant: true })

    const html = view(store.load())
    expect(html).not.toContain('data-action="devices-add-other-phone"')
  })

  it('shown for a guardian session; tapping it calls circles.inviteMyOtherPhone() and, once queued, shows the accept-on-the-other-phone copy', () => {
    const alex = key()
    const ownPhone = key()
    sessionForTests({ identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk), dependant: false })
    const spy = vi.spyOn(circles, 'inviteMyOtherPhone').mockReturnValue(null)

    let html = view(store.load())
    expect(html).toContain('data-action="devices-add-other-phone"')

    handleAction('devices-add-other-phone', null as unknown as HTMLElement)
    expect(spy).toHaveBeenCalledTimes(1)
    html = view(store.load())
    expect(html).toContain('Open Kindependence on your other phone and accept the invites.')
  })

  it('shows the refusal reason instead when circles.inviteMyOtherPhone() refuses', () => {
    const alex = key()
    const ownPhone = key()
    sessionForTests({ identityPk: alex.pk, phoneSkHex: toHex(ownPhone.sk), dependant: false })
    vi.spyOn(circles, 'inviteMyOtherPhone').mockReturnValue("You're not in any circles yet.")

    handleAction('devices-add-other-phone', null as unknown as HTMLElement)
    const html = view(store.load())
    expect(html).toContain("You're not in any circles yet.")
    expect(html).not.toContain('Open Kindependence on your other phone')
  })
})

describe('Task 9: "Your dependants" — a linked guardian revokes the dependant\'s phone', () => {
  function link(guardian: Key, dependant: Key, at = 500): void {
    const g = finalizeEvent(guardianOfTemplate(dependant.pk, at), guardian.sk)
    const d = finalizeEvent(dependantOfTemplate(guardian.pk, at), dependant.sk)
    expect(acceptLinkPair(g, d)).toBe(true)
  }

  it('lists a linked dependant\'s phone under "Your dependants", named from the shared circle roster', () => {
    const guardian = key(); const dependant = key(); const depPhone = key()
    const c1 = fakeCircle({
      id: 'c1', members: [{ pk: guardian.pk, role: 'guardian' }, { pk: dependant.pk, role: 'child', name: 'Riley' }],
    })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(dependant, depPhone.pk, 900), depPhone.pk, 1000)).toBe('added')
    link(guardian, dependant)
    sessionForTests({ identityPk: guardian.pk, phoneSkHex: toHex(key().sk) })

    const p = store.load()
    const entries = dependantDeviceEntries(p, currentSession()!)
    expect(entries).toEqual([{ dependantPk: dependant.pk, dependantName: 'Riley', phonePk: depPhone.pk, addedAt: 900, lastSeen: 1000, circleIds: ['c1'] }])

    const html = view(p)
    expect(html).toContain('Your dependants')
    expect(html).toContain('Riley')
    expect(html).toContain('data-action="devices-remove-dependant"')
  })

  it('shows no "Your dependants" section for a guardian with no linked dependants', () => {
    sessionForTests({ identityPk: key().pk, phoneSkHex: toHex(key().sk) })
    const html = view(store.load())
    expect(html).not.toContain('Your dependants')
  })

  it('does not list a dependant\'s phone once the link is unlinked', () => {
    const guardian = key(); const dependant = key(); const depPhone = key()
    const c1 = fakeCircle({ id: 'c1', members: [{ pk: guardian.pk, role: 'guardian' }, { pk: dependant.pk, role: 'child' }] })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(dependant, depPhone.pk), depPhone.pk, NOW)).toBe('added')
    link(guardian, dependant)
    sessionForTests({ identityPk: guardian.pk, phoneSkHex: toHex(key().sk) })
    expect(dependantDeviceEntries(store.load(), currentSession()!)).toHaveLength(1)

    // Break the link (a later unlink signed by the dependant).
    expect(acceptUnlink(finalizeEvent(unlinkTemplate(guardian.pk, 600), dependant.sk))).toBe(true)
    expect(dependantDeviceEntries(store.load(), currentSession()!)).toEqual([])
    const html = view(store.load())
    expect(html).not.toContain('Your dependants')
  })

  it('removeDependantPhone signs and posts the revocation as the guardian, and applies it locally', async () => {
    const guardian = key(); const dependant = key(); const depPhone = key()
    const c1 = fakeCircle({ id: 'c1', name: 'Family', seedHex: 'a'.repeat(64), members: [{ pk: guardian.pk, role: 'guardian' }, { pk: dependant.pk, role: 'child', name: 'Riley' }] })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(dependant, depPhone.pk), depPhone.pk, NOW)).toBe('added')
    link(guardian, dependant)
    const bunker = fakeBunker({ sk: guardian.sk })
    sessionForTests({ identityPk: guardian.pk, phoneSkHex: toHex(key().sk), transport: bunker })

    const result = await removeDependantPhone(dependant.pk, depPhone.pk)
    expect(result).toBe('removed')
    expect(memberForPhone('c1', depPhone.pk)).toBeNull()
    expect(store.load().revokedPhoneKeys[depPhone.pk]).toBeTruthy()

    expect(vi.mocked(publishSigned)).toHaveBeenCalledTimes(1)
    const [, wrap] = vi.mocked(publishSigned).mock.calls[0] as [string[], { pubkey: string; content: string }]
    const inbox1 = deriveInbox(c1.seedHex)
    const rumor = await giftUnwrap(rawNip44Decrypt(inbox1.sk), wrap)
    expect(rumor).not.toBeNull()
    expect(rumor!.tags.find((t) => t[0] === 't')?.[1]).toBe('revoke')
    const rv = verifyRevocation(JSON.parse(rumor!.content))
    expect(rv?.phonePk).toBe(depPhone.pk)
    expect(rv?.signerPk).toBe(guardian.pk)
  })

  it('confirmDependantRemoval sets the My Signet reminder copy naming the dependant', async () => {
    const guardian = key(); const dependant = key(); const depPhone = key()
    const c1 = fakeCircle({ id: 'c1', name: 'Family', members: [{ pk: guardian.pk, role: 'guardian' }, { pk: dependant.pk, role: 'child', name: 'Riley' }] })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(dependant, depPhone.pk), depPhone.pk, NOW)).toBe('added')
    link(guardian, dependant)
    const bunker = fakeBunker({ sk: guardian.sk })
    sessionForTests({ identityPk: guardian.pk, phoneSkHex: toHex(key().sk), transport: bunker })

    await confirmDependantRemoval(dependant.pk, depPhone.pk)
    const html = view(store.load())
    expect(html).toContain('Also remove the pairing for Riley in My Signet.')
  })

  it('does not sign the guardian\'s own device out (guardian, not dependant, is being removed)', async () => {
    const guardian = key(); const dependant = key(); const depPhone = key()
    const c1 = fakeCircle({ id: 'c1', members: [{ pk: guardian.pk, role: 'guardian' }, { pk: dependant.pk, role: 'child' }] })
    store.save({ ...store.load(), circles: [c1] })
    expect(acceptStatement(c1, statement(dependant, depPhone.pk), depPhone.pk, NOW)).toBe('added')
    link(guardian, dependant)
    const bunker = fakeBunker({ sk: guardian.sk })
    sessionForTests({ identityPk: guardian.pk, phoneSkHex: toHex(key().sk), transport: bunker })

    await removeDependantPhone(dependant.pk, depPhone.pk)
    expect(currentSession()).not.toBeNull()
    expect(store.load().circles).toHaveLength(1)
  })
})
