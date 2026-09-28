// End-to-end contacts, pairing, removal and re-invite scenario, on fakes
// (plan 2, Task 11). Two adult sessions (A, B) and one dependant (D) share
// this one process, one "device" active at a time — the same
// swap-localStorage-and-session idiom receive.test.ts's and circles.test.ts's
// own multi-device tests use (see e.g. circles.test.ts's "invite round trip"
// and link-pairing.test.ts's "end to end" tests, which this scenario chains
// together). Every wrap is a REAL roost-kit `giftWrap`/`giftUnwrap` over real
// nostr-tools keys, sealed and signed for real by `test-support/fake-bunker`;
// only the relay publish (`publishSigned`) is mocked, and every wire event
// handed from one device to another here is captured off that mock and fed
// into the RECEIVING device's own real receive path
// (`onPersonalInboxWrap`/`onPhoneInboxWrap`/`onCircleInboxWrap`) — nothing
// here shortcuts production code.
//
// Scenario: A adds B (mutual kith) — the circle builds on both. A pairs in
// person with dependant D (link-pairing.ts) and adds D to the same family
// circle — D's device joins. B, already a member, learns of D from the
// circle's own config broadcast and sees D "added by A" (voucherOf). A's
// contacts then drop B to ken — trust-watch removes B on its own, and the
// re-key that does it never reaches B's phone. Later B is back to kith and A
// re-invites them with a fresh invite — B rejoins.
//
// Test seams (not production changes):
//  - `link-pairing.ts`'s own "choose a family circle" screen
//    (`addToFamilyCircle`) is private and UI-shaped; it does exactly two
//    things — binds the dependant's statement into the chosen circle, then
//    calls the exported `circles.inviteDependantToCircle` — so this test
//    calls those same two public steps directly instead of driving the
//    screen. link-pairing.test.ts already covers the screen itself.
//  - Fake timers here fake `Date` too (unlike receive.test.ts's own
//    `toFake: ['setTimeout', 'clearTimeout']`), and `tick()` below advances
//    the clock a couple of seconds between phases. This scenario chains many
//    real structural events signed by the SAME identity in quick succession
//    (config v2's own latest-wins merge is `updatedAt`-then-`by`, so two
//    such events landing in the same wall-clock second, from the same
//    signer, would tie and the later one would be dropped as a no-op merge
//    — never an issue in real usage, where minutes pass between a person's
//    actions) — advancing lets every config in this test win its merge on
//    its own timestamp, exactly as real elapsed time would.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('@forgesworn/roost-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgesworn/roost-kit')>()
  return { ...actual, publishSigned: vi.fn(async () => ({})) }
})

import { publishSigned } from '@forgesworn/roost-kit'
import type { SignedEvent } from '@forgesworn/roost-kit'
import { deriveInbox, personalInboxTag, toHex } from '@forgesworn/covey-kit'
import { generateSecretKey, getPublicKey, finalizeEvent } from 'nostr-tools/pure'
import * as store from './store.js'
import * as circles from './circles.js'
import * as beacons from './beacons.js'
import * as linkPairing from './link-pairing.js'
import * as structuralQueue from './structural-queue.js'
import * as trustWatch from './trust-watch.js'
import { sessionForTests, identitySigner } from './session.js'
import { fakeBunker } from './test-support/fake-bunker.js'
import { fakeContacts } from './test-support/fake-contacts.js'
import { setContactsSource } from './contacts.js'
import type { ContactsSnapshot } from './contacts.js'
import { deviceStatementTemplate } from './device-statements.js'
import { acceptStatement } from './phone-keys.js'
import { voucherOf } from './vouches.js'
import { linked } from './guardian-links.js'

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

function realKeypair(): { skHex: string; pkHex: string } {
  const sk = generateSecretKey()
  return { skHex: toHex(sk), pkHex: getPublicKey(sk) }
}

const nowS = (): number => Math.floor(Date.now() / 1000)

/** Advances the (faked) clock by `seconds`, flushing every microtask and
 *  timer interleaved along the way (structural-queue drains, rekey
 *  collection windows) — see this file's header doc comment. */
async function tick(seconds: number): Promise<void> {
  await vi.advanceTimersByTimeAsync(seconds * 1000)
}

/** Every wrap published (since the mock was last cleared) whose outer 'p'
 *  tag is `tag`. */
function wrapsTo(tag: string): SignedEvent[] {
  return vi.mocked(publishSigned).mock.calls
    .map((c) => c[1] as unknown as SignedEvent)
    .filter((w) => w.tags.find((t) => t[0] === 'p')?.[1] === tag)
}

function personalWraps(pk: string): SignedEvent[] {
  return wrapsTo(personalInboxTag(pk))
}

function circleInboxWraps(seedHex: string): SignedEvent[] {
  return wrapsTo(deriveInbox(seedHex).pk)
}

function contactsSnapshot(entries: Array<{ pk: string; name: string; tier: 'kin' | 'kith' | 'ken' }>): ContactsSnapshot {
  return { status: 'connected', contacts: entries.map((e, i) => ({ contactId: `c${i}`, pks: [e.pk], name: e.name, tier: e.tier, blocked: false })), fresh: true, at: nowS() }
}

const node = (dataset: Record<string, string> = {}): HTMLElement => ({ dataset } as unknown as HTMLElement)

// Module-level wiring, same as receive.test.ts's own top-level call: the
// choke point's dispatch to circles.ts's roster-apply handler.
beacons.setSignalHandler(circles.handleIncomingSignal)

describe('end-to-end: contacts, in-person pairing, trust-watch removal and re-invite', () => {
  const aStorage = fakeLocalStorage()
  const bStorage = fakeLocalStorage()
  const dStorage = fakeLocalStorage()

  function useDevice(storage: Storage): void {
    vi.stubGlobal('localStorage', storage)
  }

  beforeEach(() => {
    vi.mocked(publishSigned).mockClear()
    vi.mocked(publishSigned).mockResolvedValue({} as never)
    structuralQueue.resetForTests()
    circles.resetRekeyForTests()
    beacons.resetReceiveForTests()
    linkPairing.resetForTests()
    setContactsSource(null)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2025-06-01T12:00:00Z'))
  })

  afterEach(() => {
    sessionForTests(null)
    structuralQueue.resetForTests()
    setContactsSource(null)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('A adds B (mutual kith, circle builds on both); A pairs with and adds dependant D; ' +
    'B sees D added by A; A kens B (trust-watch removes them, the re-key excludes their phone); ' +
    'B is kith again and A re-invites them with a fresh invite — B rejoins', async () => {
    // ---- Fixtures: three identities, three devices ------------------------
    const aBunker = fakeBunker({})
    const A = aBunker.pubkey
    const aPhone = realKeypair()
    const bBunker = fakeBunker({})
    const B = bBunker.pubkey
    const bPhone = realKeypair()
    const dSk = generateSecretKey()
    const D = getPublicKey(dSk)
    const dPhone = realKeypair()
    const dBunker = fakeBunker({ sk: dSk, dependant: true, approve: () => true })

    const aStatement = await aBunker.signEvent(deviceStatementTemplate(aPhone.pkHex, nowS()))
    const bStatement = await bBunker.signEvent(deviceStatementTemplate(bPhone.pkHex, nowS()))
    const dStatement = finalizeEvent(deviceStatementTemplate(dPhone.pkHex, nowS()), dSk) as SignedEvent

    // Each identity's own view of its contacts (plan 2's grant) — a
    // persistent handle so a later `.set()` can change a tier without
    // losing the rest, even though `setContactsSource` (a module-level
    // singleton, unlike `store`) must be re-installed every time this test
    // switches which device is "current".
    const aContacts = fakeContacts(contactsSnapshot([{ pk: B, name: 'Bailey', tier: 'kith' }]))
    const bContacts = fakeContacts(contactsSnapshot([{ pk: A, name: 'Alex', tier: 'kith' }]))

    // `circles.ts`'s `uiView` (screen navigation) is a module-level
    // singleton, not part of `store` — switching "device" only swaps
    // localStorage and the session, so a screen a previous device
    // navigated to (e.g. `createCircleNow`'s own jump to the invite
    // screen) would otherwise leak into the next device's `view()`. Each
    // `activate*` resets it to the plain roster list.
    function resetUiView(): void {
      circles.handleAction('circle-cancel', node())
    }
    function activateA(): void {
      useDevice(aStorage)
      sessionForTests({ identityPk: A, phoneSkHex: aPhone.skHex, dependant: false, statement: aStatement, transport: aBunker })
      setContactsSource(aContacts)
      resetUiView()
    }
    function activateB(): void {
      useDevice(bStorage)
      sessionForTests({ identityPk: B, phoneSkHex: bPhone.skHex, dependant: false, statement: bStatement, transport: bBunker })
      setContactsSource(bContacts)
      resetUiView()
    }
    function activateD(): void {
      useDevice(dStorage)
      sessionForTests({ identityPk: D, phoneSkHex: dPhone.skHex, dependant: true, statement: dStatement, transport: dBunker })
      setContactsSource(null)
      resetUiView()
    }

    // ---- Step 1: A creates a family circle and adds B (mutual kith) ------
    activateA()
    circles.registerStructuralSenders() // idempotent; senders read currentSession()/store.load() live, so registering once (on A) covers every later switch back to A
    linkPairing.ensure()
    const familyId = circles.createCircleNow("A's family")
    expect(familyId).toBeTruthy()
    await tick(1)

    await circles.inviteToCircle(familyId!, B)
    await tick(1)
    expect(store.load().circles.find((c) => c.id === familyId)?.members.map((m) => m.pk)).toContain(B)
    const inviteToB = personalWraps(B).at(-1)!
    vi.mocked(publishSigned).mockClear()

    activateB()
    await circles.onPersonalInboxWrap(identitySigner(), inviteToB)
    expect(circles.view(store.load())).toContain("A's family")
    circles.handleAction('circle-accept', node())
    const bCircle = store.load().circles.find((c) => c.id === familyId)
    expect(bCircle?.members.map((m) => m.pk).sort()).toEqual([A, B].sort())
    // "circle built on both": A's own roster already carries B (asserted
    // above, before the switch); B's now carries A.

    // ---- Step 2: A pairs in person with dependant D ----------------------
    await tick(2)
    activateA()
    const secret = linkPairing.newLinkSecret(nowS())
    const uri = linkPairing.linkUri(A, aPhone.pkHex, secret)

    activateD()
    expect(await linkPairing.dependantScanned(uri)).toBe('sent')
    const pairWrap = personalWraps(aPhone.pkHex).at(-1)!
    vi.mocked(publishSigned).mockClear()

    activateA()
    await circles.onPhoneInboxWrap(pairWrap)
    expect(linked(A, D)).toBe(true)

    // ---- A adds D to the same family circle ------------------------------
    // (the two public steps `link-pairing.ts`'s own "choose circle" screen
    // takes once linked — see this file's header doc comment)
    await tick(2)
    const familyCircle = store.load().circles.find((c) => c.id === familyId)!
    acceptStatement(familyCircle, dStatement, dPhone.pkHex, nowS())
    await circles.inviteDependantToCircle(familyId!, D)
    await tick(1)
    expect(store.load().circles.find((c) => c.id === familyId)?.members.find((m) => m.pk === D)?.role).toBe('child')

    const inviteToD = personalWraps(dPhone.pkHex).at(-1)!
    const configForB = circleInboxWraps(store.load().circles.find((c) => c.id === familyId)!.seedHex)
    expect(configForB.length).toBeGreaterThan(0)
    vi.mocked(publishSigned).mockClear()

    // ---- D's device joins -------------------------------------------------
    activateD()
    await circles.onPhoneInboxWrap(inviteToD)
    expect(circles.view(store.load())).toContain("A's family")
    circles.handleAction('circle-accept', node())
    const dCircle = store.load().circles.find((c) => c.id === familyId)
    expect(dCircle?.members.find((m) => m.pk === D)?.role).toBe('child')
    expect(dCircle?.members.find((m) => m.pk === A)?.role).toBe('guardian')

    // ---- B, already a member, learns of D from the circle's own config —
    // ---- sees D "added by A" (voucherOf) ----------------------------------
    activateB()
    const seedAtAdd = store.load().circles.find((c) => c.id === familyId)!.seedHex
    const inbox = deriveInbox(seedAtAdd)
    for (const w of configForB) await beacons.onCircleInboxWrap(familyId!, inbox.sk, w)
    expect(store.load().circles.find((c) => c.id === familyId)?.members.some((m) => m.pk === D)).toBe(true)
    expect(voucherOf(familyId!, D)).toBe(A)
    expect(circles.view(store.load())).toContain('added by Alex')

    // ---- A's contacts drop B to ken: trust-watch removes B on its own,
    // ---- and the re-key that does it excludes B's phone -------------------
    await tick(2)
    activateA()
    const prevSnap = aContacts.current()
    aContacts.set({ contacts: [{ contactId: 'c0', pks: [B], name: 'Bailey', tier: 'ken', blocked: false }] })
    trustWatch.onContactsChanged(aContacts.current(), prevSnap)
    await tick(circles.REKEY_WINDOW_MS / 1000)

    const afterRemoval = store.load().circles.find((c) => c.id === familyId)!
    expect(afterRemoval.members.some((m) => m.pk === B)).toBe(false)
    expect(afterRemoval.removals?.[B]).toBeTruthy()
    const rekeyWraps = personalWraps(bPhone.pkHex)
    expect(rekeyWraps).toHaveLength(0) // B's phone never received the fresh seed
    expect(personalWraps(aPhone.pkHex).length + personalWraps(dPhone.pkHex).length).toBeGreaterThan(0) // the surviving members did
    vi.mocked(publishSigned).mockClear()

    // ---- B is back to kith; A re-invites with a fresh invite — B rejoins -
    await tick(2) // real elapsed time — the removal's tombstone is now safely in the past
    aContacts.set({ contacts: [{ contactId: 'c0', pks: [B], name: 'Bailey', tier: 'kith', blocked: false }] })
    await circles.inviteToCircle(familyId!, B)
    await tick(1)
    const freshInviteToB = personalWraps(B).at(-1)!
    expect(freshInviteToB).toBeTruthy()

    activateB()
    await circles.onPersonalInboxWrap(identitySigner(), freshInviteToB)
    expect(circles.view(store.load())).toContain("A's family")
    circles.handleAction('circle-accept', node())
    const rejoined = store.load().circles.find((c) => c.id === familyId)
    expect(rejoined?.members.map((m) => m.pk)).toContain(B)
    expect(rejoined?.members.map((m) => m.pk)).toContain(A)
  })
})
