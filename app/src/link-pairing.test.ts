import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  LINK_URI_PREFIX,
  linkUri,
  parseLinkUri,
  newLinkSecret,
  dependantScanned,
  onLinkPair,
  unlink,
  ensure,
  handleAction,
  view,
  resetForTests,
} from './link-pairing.js'
import * as circles from './circles.js'
import * as beacons from './beacons.js'
import * as store from './store.js'
import * as structuralQueue from './structural-queue.js'
import { sessionForTests } from './session.js'
import { fakeBunker } from './test-support/fake-bunker.js'
import { deviceStatementTemplate, dependantOfTemplate, guardianOfTemplate } from './device-statements.js'
import { acceptLinkPair, linked } from './guardian-links.js'
import { memberForPhone, phonesOf } from './phone-keys.js'
import { setContactsSource } from './contacts.js'
import { KINDS } from 'canary-kit/nostr'
import { makeLocalSigner, personalInboxTag, toHex } from '@forgesworn/covey-kit'
import { getConversationKey, encrypt as nip44encrypt } from 'nostr-tools/nip44'
import type { Circle } from '@forgesworn/covey-kit'
import { publishSigned } from '@forgesworn/roost-kit'
import type { Rumor, SignedEvent } from '@forgesworn/roost-kit'
import { finalizeEvent, generateSecretKey, getEventHash, getPublicKey } from 'nostr-tools/pure'

vi.mock('@forgesworn/roost-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgesworn/roost-kit')>()
  return { ...actual, publishSigned: vi.fn(async () => ({})), subscribeGiftWraps: vi.fn(() => () => {}) }
})

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

const nowS = (): number => Math.floor(Date.now() / 1000)
const hex32 = (): string => toHex(crypto.getRandomValues(new Uint8Array(32)))

function keypair(): { sk: Uint8Array; skHex: string; pk: string } {
  const sk = generateSecretKey()
  return { sk, skHex: toHex(sk), pk: getPublicKey(sk) }
}

function circle(id: string, members: Circle['members']): Circle {
  return { id, name: `Circle ${id}`, seedHex: '1'.repeat(64), epoch: 0, members, createdAt: 100, configUpdatedAt: 100, configBy: members[0]!.pk }
}

/** A guardian session: identity = an awake fake bunker (My Signet),
 *  signed-in phone with its device statement. */
function guardianSession(opts: { asleep?: () => boolean } = {}): { G: string; gSk: Uint8Array; phone: ReturnType<typeof keypair>; bunker: ReturnType<typeof fakeBunker> } {
  const gSk = generateSecretKey()
  const bunker = fakeBunker({ sk: gSk, ...(opts.asleep ? { asleep: opts.asleep } : {}) })
  const phone = keypair()
  const statement = finalizeEvent(deviceStatementTemplate(phone.pk, nowS()), gSk) as SignedEvent
  sessionForTests({ identityPk: bunker.pubkey, phoneSkHex: phone.skHex, dependant: false, statement, transport: bunker })
  return { G: bunker.pubkey, gSk, phone, bunker }
}

/** A dependant identity with one phone and that phone's device statement. */
function dependant(): { D: string; dSk: Uint8Array; phone: ReturnType<typeof keypair>; statement: SignedEvent } {
  const dSk = generateSecretKey()
  const phone = keypair()
  return { D: getPublicKey(dSk), dSk, phone, statement: finalizeEvent(deviceStatementTemplate(phone.pk, nowS()), dSk) as SignedEvent }
}

/** The `t:'link-pair'` rumor a dependant's phone sends. */
function pairRumor(sealPk: string, content: { s: string; d: SignedEvent; statement: SignedEvent }): Rumor {
  const r = { pubkey: sealPk, created_at: nowS(), kind: KINDS.signal, tags: [['t', 'link-pair']], content: JSON.stringify(content) }
  return { ...r, id: getEventHash(r) } as Rumor
}

const node = (dataset: Record<string, string> = {}): HTMLElement => ({ dataset } as unknown as HTMLElement)

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage())
  vi.mocked(publishSigned).mockClear()
  vi.mocked(publishSigned).mockResolvedValue({} as never)
  setContactsSource(null)
  structuralQueue.resetForTests()
  resetForTests()
  ensure()
})
afterEach(() => {
  structuralQueue.resetForTests()
  resetForTests()
  sessionForTests(null)
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('linkUri / parseLinkUri', () => {
  it('round-trips the guardian pk, phone pk and secret', () => {
    const g = hex32(), p = hex32(), s = hex32()
    const uri = linkUri(g, p, s)
    expect(uri.startsWith(`${LINK_URI_PREFIX}?`)).toBe(true)
    expect(parseLinkUri(uri)).toEqual({ g, p, s })
    expect(parseLinkUri(`  ${uri}\n`)).toEqual({ g, p, s })
  })

  it('rejects non-hex and missing fields', () => {
    const g = hex32(), p = hex32(), s = hex32()
    expect(parseLinkUri(`${LINK_URI_PREFIX}?g=${g}&p=${p}`)).toBeNull()
    expect(parseLinkUri(`${LINK_URI_PREFIX}?g=${g}&s=${s}`)).toBeNull()
    expect(parseLinkUri(`${LINK_URI_PREFIX}?p=${p}&s=${s}`)).toBeNull()
    expect(parseLinkUri(`${LINK_URI_PREFIX}?g=${g}&p=${p}&s=${'z'.repeat(64)}`)).toBeNull()
    expect(parseLinkUri(`${LINK_URI_PREFIX}?g=${g.slice(1)}&p=${p}&s=${s}`)).toBeNull()
    expect(parseLinkUri(`${LINK_URI_PREFIX}?g=${g.toUpperCase()}&p=${p}&s=${s}`)).toBeNull()
    expect(parseLinkUri(`bunker://${g}?g=${g}&p=${p}&s=${s}`)).toBeNull()
    expect(parseLinkUri('')).toBeNull()
  })
})

describe('newLinkSecret', () => {
  it('stores a fresh unused 32-byte secret and prunes secrets older than a day', () => {
    store.update((p) => { p.linkSecrets = { old: { createdAt: 1000, used: false }, recent: { createdAt: 90_000, used: true } } })
    const s = newLinkSecret(1000 + 86_400 + 5)
    expect(s).toMatch(/^[0-9a-f]{64}$/)
    expect(store.load().linkSecrets).toEqual({ recent: { createdAt: 90_000, used: true }, [s]: { createdAt: 1000 + 86_400 + 5, used: false } })
  })
})

describe('onLinkPair (guardian phone)', () => {
  it('a valid pairing links the dependant; adding them to a new family circle sends a child invite to their phone and posts the link', async () => {
    const { G } = guardianSession()
    const dep = dependant()
    const postLink = vi.spyOn(beacons, 'postLink').mockResolvedValue()
    const s = newLinkSecret(nowS())
    const d = finalizeEvent(dependantOfTemplate(G, nowS()), dep.dSk) as SignedEvent
    expect(await onLinkPair(pairRumor(dep.phone.pk, { s, d, statement: dep.statement }), dep.phone.pk)).toBe('linked')
    expect(linked(G, dep.D)).toBe(true)
    expect(store.load().linkSecrets[s]?.used).toBe(true)
    expect(view(store.load())).toContain('New family circle')

    handleAction('link-new-family-circle', node())
    await vi.waitFor(async () => {
      await structuralQueue.drain()
      const fam = store.load().circles.find((c) => c.name === "Test's family")!
      expect(fam.members.find((m) => m.pk === dep.D)?.role).toBe('child')
      expect(postLink).toHaveBeenCalled()
    })
    const fam = store.load().circles.find((c) => c.name === "Test's family")!
    const wraps = vi.mocked(publishSigned).mock.calls.map((c) => c[1] as unknown as SignedEvent)
    const toPhone = wraps.filter((w) => w.tags.find((t) => t[0] === 'p')?.[1] === personalInboxTag(dep.phone.pk))
    expect(toPhone).toHaveLength(1)
    // The link is posted once the dependant is on the roster, as {g, d}.
    const [postedTo, content] = postLink.mock.calls[0]!
    expect(postedTo.id).toBe(fam.id)
    expect((content as { d: SignedEvent }).d.id).toBe(d.id)
    expect((content as { g: SignedEvent }).g.pubkey).toBe(G)
  })

  it('final review B, minor 9: a double tap on "New family circle" before the first invite resolves creates only one circle and sends one invite', async () => {
    const { G } = guardianSession()
    const dep = dependant()
    vi.spyOn(beacons, 'postLink').mockResolvedValue()
    const s = newLinkSecret(nowS())
    const d = finalizeEvent(dependantOfTemplate(G, nowS()), dep.dSk) as SignedEvent
    expect(await onLinkPair(pairRumor(dep.phone.pk, { s, d, statement: dep.statement }), dep.phone.pk)).toBe('linked')

    let resolveInvite: (() => void) | null = null
    const inviteSpy = vi.spyOn(circles, 'inviteDependantToCircle').mockImplementation(
      () => new Promise((resolve) => { resolveInvite = () => resolve(undefined) }))

    // Two rapid taps, same as a real double tap: the second fires before
    // the first's own `await circles.inviteDependantToCircle(...)` has any
    // chance to settle.
    handleAction('link-new-family-circle', node())
    handleAction('link-new-family-circle', node())

    expect(inviteSpy).toHaveBeenCalledTimes(1)
    expect(store.load().circles.filter((c) => c.name === "Test's family")).toHaveLength(1)

    resolveInvite?.()
    await vi.waitFor(() => { expect(inviteSpy).toHaveBeenCalledTimes(1) })
  })

  it('end to end: the dependant scans, signs dependant-of and the pair reaches the guardian phone inbox', async () => {
    const guardian = guardianSession()
    const s = newLinkSecret(nowS())
    const uri = linkUri(guardian.G, guardian.phone.pk, s)
    const secrets = store.load().linkSecrets
    // The dependant's phone (its own store), signing through My Signet
    // (the guardian taps approve).
    const dep = dependant()
    store.save({ ...store.load(), linkSecrets: {} })
    const depBunker = fakeBunker({ sk: dep.dSk, dependant: true, approve: () => true })
    sessionForTests({ identityPk: dep.D, phoneSkHex: dep.phone.skHex, dependant: true, statement: dep.statement, transport: depBunker })
    expect(await dependantScanned(uri)).toBe('sent')
    expect(depBunker.requests).toEqual([{ method: 'sign_event', kind: 30078 }])
    const wrap = vi.mocked(publishSigned).mock.calls.at(-1)![1] as unknown as SignedEvent
    expect(wrap.tags.find((t) => t[0] === 'p')?.[1]).toBe(personalInboxTag(guardian.phone.pk))

    // Back on the guardian's phone.
    store.save({ ...store.load(), linkSecrets: secrets })
    const gBunker = fakeBunker({ sk: guardian.gSk })
    sessionForTests({ identityPk: guardian.G, phoneSkHex: guardian.phone.skHex, dependant: false, transport: gBunker })
    await circles.onPhoneInboxWrap(wrap)
    expect(linked(guardian.G, dep.D)).toBe(true)
  })

  it('fix round 1: a link-pair whose seal is signed by another key than the claimed phone is dropped at unwrap', async () => {
    const guardian = guardianSession()
    const dep = dependant()
    const s = newLinkSecret(nowS())
    const d = finalizeEvent(dependantOfTemplate(guardian.G, nowS()), dep.dSk) as SignedEvent
    // The attacker holds dep's signed statements but not dep's phone key:
    // it seals with its own key, claiming dep's phone as the rumor author.
    const attacker = keypair()
    const at = nowS()
    const rumor = { pubkey: dep.phone.pk, created_at: at, kind: KINDS.signal, tags: [['t', 'link-pair']], content: JSON.stringify({ s, d, statement: dep.statement }) }
    const rumorWithId = { ...rumor, id: getEventHash(rumor) }
    const sealer = makeLocalSigner(attacker.skHex)
    const seal = await sealer.signEvent({ kind: 13, content: await sealer.nip44Encrypt(guardian.phone.pk, JSON.stringify(rumorWithId)), tags: [], created_at: at })
    const ephSk = generateSecretKey()
    const wrap = finalizeEvent({ kind: 1059, content: nip44encrypt(JSON.stringify(seal), getConversationKey(ephSk, guardian.phone.pk)), tags: [['p', personalInboxTag(guardian.phone.pk)]], created_at: at }, ephSk) as SignedEvent
    await circles.onPhoneInboxWrap(wrap)
    expect(linked(guardian.G, dep.D)).toBe(false)
    expect(store.load().linkSecrets[s]?.used).toBe(false)
    expect(guardian.bunker.requests).toEqual([])
  })

  it('dependantScanned refuses an adult session and a non-pairing code', async () => {
    guardianSession()
    expect(await dependantScanned(linkUri(hex32(), hex32(), hex32()))).toBe('not-dependant')
    const dep = dependant()
    sessionForTests({ identityPk: dep.D, phoneSkHex: dep.phone.skHex, dependant: true, statement: dep.statement })
    expect(await dependantScanned('bunker://nope')).toBe('invalid')
  })

  describe('rejections', () => {
    let bunker: ReturnType<typeof fakeBunker>
    function setup(): { G: string; dep: ReturnType<typeof dependant>; d: SignedEvent } {
      const g = guardianSession()
      bunker = g.bunker
      const dep = dependant()
      return { G: g.G, dep, d: finalizeEvent(dependantOfTemplate(g.G, nowS()), dep.dSk) as SignedEvent }
    }
    // A rejected request never asks My Signet for the guardian's signature.
    afterEach(() => { expect(bunker.requests.filter((r) => r.method === 'sign_event')).toHaveLength(expectedSigns) })
    let expectedSigns = 0
    beforeEach(() => { expectedSigns = 0 })

    it('a reused secret', async () => {
      const { G, dep, d } = setup()
      const s = newLinkSecret(nowS())
      const r = pairRumor(dep.phone.pk, { s, d, statement: dep.statement })
      expect(await onLinkPair(r, dep.phone.pk)).toBe('linked')
      expectedSigns = 1
      const other = dependant()
      const d2 = finalizeEvent(dependantOfTemplate(G, nowS()), other.dSk) as SignedEvent
      expect(await onLinkPair(pairRumor(other.phone.pk, { s, d: d2, statement: other.statement }), other.phone.pk)).toBe('rejected')
      expect(linked(G, other.D)).toBe(false)
    })

    it('an expired secret (11 minutes old)', async () => {
      const { G, dep } = setup()
      const s = newLinkSecret(nowS() - 660)
      const d = finalizeEvent(dependantOfTemplate(G, nowS() - 30), dep.dSk) as SignedEvent
      expect(await onLinkPair(pairRumor(dep.phone.pk, { s, d, statement: dep.statement }), dep.phone.pk)).toBe('rejected')
      expect(linked(G, dep.D)).toBe(false)
    })

    it('a secret from another pairing (not in linkSecrets)', async () => {
      const { G, dep, d } = setup()
      newLinkSecret(nowS())
      expect(await onLinkPair(pairRumor(dep.phone.pk, { s: hex32(), d, statement: dep.statement }), dep.phone.pk)).toBe('rejected')
      expect(linked(G, dep.D)).toBe(false)
    })

    it('a dependant-of naming another guardian', async () => {
      const { G, dep } = setup()
      const s = newLinkSecret(nowS())
      const d = finalizeEvent(dependantOfTemplate(keypair().pk, nowS()), dep.dSk) as SignedEvent
      expect(await onLinkPair(pairRumor(dep.phone.pk, { s, d, statement: dep.statement }), dep.phone.pk)).toBe('rejected')
      expect(linked(G, dep.D)).toBe(false)
    })

    it('a statement whose phone key is not the sealing phone', async () => {
      const { G, dep, d } = setup()
      const s = newLinkSecret(nowS())
      const relay = keypair()
      expect(await onLinkPair(pairRumor(relay.pk, { s, d, statement: dep.statement }), relay.pk)).toBe('rejected')
      expect(linked(G, dep.D)).toBe(false)
    })

    it('a statement for a different identity', async () => {
      const { G, dep, d } = setup()
      const s = newLinkSecret(nowS())
      const stranger = generateSecretKey()
      const statement = finalizeEvent(deviceStatementTemplate(dep.phone.pk, nowS()), stranger) as SignedEvent
      expect(await onLinkPair(pairRumor(dep.phone.pk, { s, d, statement }), dep.phone.pk)).toBe('rejected')
      expect(linked(G, dep.D)).toBe(false)
    })

    it('a dependant-of signed before the secret existed', async () => {
      const { G, dep } = setup()
      const s = newLinkSecret(nowS())
      const d = finalizeEvent(dependantOfTemplate(G, nowS() - 3600), dep.dSk) as SignedEvent
      expect(await onLinkPair(pairRumor(dep.phone.pk, { s, d, statement: dep.statement }), dep.phone.pk)).toBe('rejected')
    })
  })

  it('re-pairing from a new phone binds the new phone in shared circles and re-invites the dependant everywhere', async () => {
    const { G, gSk } = guardianSession()
    const dep = dependant()
    const at = nowS() - 3600
    expect(acceptLinkPair(finalizeEvent(guardianOfTemplate(dep.D, at), gSk), finalizeEvent(dependantOfTemplate(G, at), dep.dSk))).toBe(true)
    store.update((p) => {
      p.circles = [
        circle('fam', [{ pk: G, role: 'guardian' }, { pk: dep.D, role: 'child' }]),
        circle('club', [{ pk: G, role: 'guardian' }, { pk: dep.D, role: 'child' }]),
      ]
    })
    const reinvite = vi.spyOn(circles, 'reinviteDependantEverywhere')
    const postLink = vi.spyOn(beacons, 'postLink').mockResolvedValue()
    const s = newLinkSecret(nowS())
    const d = finalizeEvent(dependantOfTemplate(G, nowS()), dep.dSk) as SignedEvent
    expect(await onLinkPair(pairRumor(dep.phone.pk, { s, d, statement: dep.statement }), dep.phone.pk)).toBe('linked')
    expect(reinvite).toHaveBeenCalledWith(dep.D)
    expect(reinvite.mock.results[0]!.value).toBe(2)
    expect(memberForPhone('fam', dep.phone.pk)).toBe(dep.D)
    expect(memberForPhone('club', dep.phone.pk)).toBe(dep.D)
    // The new pair is posted into both circles at once (both are members).
    expect(postLink.mock.calls.map((c) => c[0].id).sort()).toEqual(['club', 'fam'])
    expect(view(store.load())).toContain('Re-adding')
  })

  it('adding a new dependant to an existing circle buffers their statement there and invites them', async () => {
    const { G } = guardianSession()
    const dep = dependant()
    store.update((p) => { p.circles = [circle('home', [{ pk: G, role: 'guardian' }])] })
    const invite = vi.spyOn(circles, 'inviteDependantToCircle').mockResolvedValue()
    const s = newLinkSecret(nowS())
    const d = finalizeEvent(dependantOfTemplate(G, nowS()), dep.dSk) as SignedEvent
    expect(await onLinkPair(pairRumor(dep.phone.pk, { s, d, statement: dep.statement }), dep.phone.pk)).toBe('linked')
    expect(view(store.load())).toContain('data-action="link-add-to-circle" data-circle="home"')
    handleAction('link-add-to-circle', node({ circle: 'home' }))
    await vi.waitFor(() => expect(invite).toHaveBeenCalledWith('home', dep.D))
    expect(store.load().pendingStatements.filter((e) => e.circleId === 'home').map((e) => e.event.id)).toEqual([dep.statement.id])
  })

  it('My Signet not answering: the secret is spent before any await, and "Try again" re-signs', async () => {
    let asleep = true
    const { G } = guardianSession({ asleep: () => asleep })
    const dep = dependant()
    const s = newLinkSecret(nowS())
    const d = finalizeEvent(dependantOfTemplate(G, nowS()), dep.dSk) as SignedEvent
    vi.useFakeTimers()
    const pending = onLinkPair(pairRumor(dep.phone.pk, { s, d, statement: dep.statement }), dep.phone.pk)
    expect(store.load().linkSecrets[s]?.used).toBe(true)
    expect(view(store.load())).toContain('approve in My Signet')
    await vi.advanceTimersByTimeAsync(301_000)
    expect(await pending).toBe('rejected')
    expect(linked(G, dep.D)).toBe(false)
    expect(view(store.load())).toContain('data-action="link-retry-sign"')
    vi.useRealTimers()
    asleep = false
    handleAction('link-retry-sign', node())
    await vi.waitFor(() => expect(linked(G, dep.D)).toBe(true))
  })
})

describe('unlink', () => {
  it('ends the link and posts the unlink into every shared circle', async () => {
    const { G, gSk } = guardianSession()
    const dep = dependant()
    const other = keypair()
    const at = nowS() - 60
    expect(acceptLinkPair(finalizeEvent(guardianOfTemplate(dep.D, at), gSk), finalizeEvent(dependantOfTemplate(G, at), dep.dSk))).toBe(true)
    store.update((p) => {
      p.circles = [
        circle('fam', [{ pk: G, role: 'guardian' }, { pk: dep.D, role: 'child' }]),
        circle('mine', [{ pk: G, role: 'guardian' }]),
        circle('theirs', [{ pk: other.pk, role: 'guardian' }, { pk: dep.D, role: 'child' }]),
      ]
    })
    const postLink = vi.spyOn(beacons, 'postLink').mockResolvedValue()
    expect(await unlink(dep.D)).toBe(true)
    expect(linked(G, dep.D)).toBe(false)
    expect(postLink).toHaveBeenCalledTimes(1)
    const [to, content] = postLink.mock.calls[0]!
    expect(to.id).toBe('fam')
    const ev = (content as { unlink: SignedEvent }).unlink
    expect(ev.pubkey).toBe(G)
    expect(ev.tags).toContainEqual(['p', dep.D])
  })

  it('from the Family section, after a confirm', async () => {
    const { G, gSk } = guardianSession()
    const dep = dependant()
    const at = nowS() - 60
    acceptLinkPair(finalizeEvent(guardianOfTemplate(dep.D, at), gSk), finalizeEvent(dependantOfTemplate(G, at), dep.dSk))
    expect(view(store.load())).toContain(`data-action="link-unlink" data-pk="${dep.D}"`)
    handleAction('link-unlink', node({ pk: dep.D }))
    expect(linked(G, dep.D)).toBe(true)
    handleAction('link-unlink-confirm', node())
    await vi.waitFor(() => expect(linked(G, dep.D)).toBe(false))
  })
})

describe('Family section', () => {
  it('a guardian gets a one-time pairing QR; a dependant gets the scanner button', () => {
    guardianSession()
    expect(view(store.load())).toContain('data-action="link-add-dependant"')
    handleAction('link-add-dependant', node())
    const secrets = Object.entries(store.load().linkSecrets)
    expect(secrets).toHaveLength(1)
    expect(secrets[0]![1].used).toBe(false)
    expect(view(store.load())).toContain('<img class="qr"')
    const dep = dependant()
    resetForTests()
    sessionForTests({ identityPk: dep.D, phoneSkHex: dep.phone.skHex, dependant: true, statement: dep.statement })
    expect(view(store.load())).toContain('data-action="link-scan"')
    expect(view(store.load())).not.toContain('link-add-dependant')
  })
})
