// Offline circle traffic (Task 13, whole-branch check): proves that
// ordinary phone-key circle traffic — SOS, check-ins, beacons and circle
// chat — never touches the identity's remote signer (a My Signet bunker),
// so it keeps working end to end between two devices even while that
// bunker is completely unreachable (asleep). Every send below goes through
// its real, production entry point (`triggerSos`/`triggerCheckin`/
// `requestPreciseLocation`/`buildBeaconWrap`+`publishOrEnqueue`, the same
// pair `emitTick` itself calls) and every receive goes through the real
// choke point (`onCircleInboxWrap`), with only the network `publishSigned`
// call mocked (same idiom as approvals.test.ts/agreements.test.ts/
// messages.test.ts) — nothing about the signer split or the receive
// pipeline is faked.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { makeLocalSigner, deriveInbox, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { publishSigned } from '@forgesworn/roost-kit'
import type { SignedEvent } from '@forgesworn/roost-kit'
import * as store from './store.js'
import * as beacons from './beacons.js'
import { onCircleInboxWrap, buildBeaconWrap, memberPositions, resetReceiveForTests } from './beacons.js'
import { triggerSos, triggerCheckin, ensure as safetyEnsure } from './safety.js'
import { requestPreciseLocation, ensure as messagesEnsure } from './messages.js'
import { sessionForTests } from './session.js'
import { deviceStatementTemplate } from './device-statements.js'
import { acceptStatement } from './phone-keys.js'
import { fakeBunker } from './test-support/fake-bunker.js'

// The one thing that actually leaves the process — mocked so every send
// below is real crypto (real gift wrap, real signer choice) with only the
// relay publish itself intercepted, same idiom as approvals.test.ts /
// agreements.test.ts / messages.test.ts's own `vi.mock('@forgesworn/roost-kit', ...)`.
vi.mock('@forgesworn/roost-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgesworn/roost-kit')>()
  return { ...actual, publishSigned: vi.fn(async () => ({})) }
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

interface Key { sk: Uint8Array; skHex: string; pk: string }
function key(): Key {
  const sk = generateSecretKey()
  return { sk, skHex: toHex(sk), pk: getPublicKey(sk) }
}

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** Binds `phone` to `identity` in `circle` directly through phone-keys.ts's
 *  own acceptance path (a real signed device statement, verified and
 *  admitted) — same idiom as messages.test.ts's own multi-phone-fanout test
 *  ("via the real phone-keys.ts acceptStatement path") — so the RECEIVING
 *  device's `memberForPhone` resolves the sealing phone to its identity,
 *  exactly as the real onCircleInboxWrap choke point requires. */
async function bindPhone(circle: Circle, identity: Key, phone: Key): Promise<void> {
  const ev = await makeLocalSigner(identity.skHex).signEvent(deviceStatementTemplate(phone.pk, nowSec()))
  const result = acceptStatement(circle, ev, phone.pk, nowSec())
  if (result !== 'added') throw new Error(`bindPhone: expected 'added', got '${result}'`)
}

/** Feeds `wrap` (the LAST thing published via the mocked `publishSigned`
 *  above) into the real receive choke point for `circle`, as whichever
 *  session is currently active (`sessionForTests` before calling this). */
async function deliver(circle: Circle, wrap: SignedEvent): Promise<void> {
  await onCircleInboxWrap(circle.id, deriveInbox(circle.seedHex).sk, wrap)
}

function lastPublished(): SignedEvent {
  const calls = vi.mocked(publishSigned).mock.calls
  const call = calls[calls.length - 1]
  if (!call) throw new Error('publishSigned was never called')
  return call[1] as unknown as SignedEvent
}

describe('offline circle traffic — fake bunker asleep (Task 13)', () => {
  const A = key() // guardian, device A
  const A1 = key() // A's phone
  const B = key() // guardian, device B
  const B1 = key() // B's phone

  const circle: Circle = {
    id: 'circle-offline', name: 'Offline circle', seedHex: 'a'.repeat(64), epoch: 0,
    members: [{ pk: A.pk, role: 'guardian' }, { pk: B.pk, role: 'guardian' }],
    createdAt: 100, configUpdatedAt: 100, configBy: A.pk,
  }

  // Both bunkers are ASLEEP for the whole describe block — every assertion
  // below about "phone-key traffic never touches the signer" is checking
  // against a signer that would simply hang (per fake-bunker.ts's own doc
  // comment) if anything here ever called it.
  const bunkerA = fakeBunker({ sk: generateSecretKey(), asleep: () => true })
  const bunkerB = fakeBunker({ sk: generateSecretKey(), asleep: () => true })

  function signInA(): void {
    sessionForTests({ identityPk: A.pk, phoneSkHex: A1.skHex, dependant: false, transport: bunkerA })
  }
  function signInB(): void {
    sessionForTests({ identityPk: B.pk, phoneSkHex: B1.skHex, dependant: false, transport: bunkerB })
  }

  beforeEach(async () => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    resetReceiveForTests()
    vi.mocked(publishSigned).mockClear()
    bunkerA.requests.length = 0
    bunkerB.requests.length = 0
    store.update((p) => { p.circles = [circle] })
    await bindPhone(circle, A, A1)
    await bindPhone(circle, B, B1)
    // Registers safety.ts's/messages.ts's incoming-signal handlers with
    // beacons.ts — idempotent, same "call every render" contract these
    // ensure()s document; needed once so onCircleInboxWrap actually
    // dispatches non-beacon traffic below.
    safetyEnsure()
    messagesEnsure()
  })

  afterEach(() => {
    sessionForTests(null)
    vi.unstubAllGlobals()
  })

  it('SOS: triggerSos() sends and is received/resolved on the other device, with zero bunker requests either side', async () => {
    signInA()
    await triggerSos()
    expect(publishSigned).toHaveBeenCalledTimes(1)
    const wrap = lastPublished()
    // final fix I3: A and B share one store in this test (sessionForTests
    // leaves it alone), and triggerSos() already wrote its OWN local echo
    // (a synthetic `local-help-…` id) satisfying this exact assertion. Wipe
    // it before delivering so the assertion below can only pass if the
    // receive path (onCircleInboxWrap → handleIncomingSignal →
    // recordIncomingEvent) genuinely re-creates the event from the wire.
    store.update((p) => { p.safetyEvents = [] })

    signInB()
    await deliver(circle, wrap)
    // beacons.ts dispatches to safety.ts's registered handler without
    // awaiting it (a fire-and-forget signalHandlers loop), so the store
    // write can land a tick after `deliver()` resolves — waitFor tolerates
    // that gap without masking a genuinely broken receive path (which would
    // never satisfy this and time out).
    await vi.waitFor(() => {
      expect(store.load().safetyEvents.some((e) => e.kind === 'help' && e.from === A.pk && !e.id.startsWith('local-'))).toBe(true)
    })

    expect(bunkerA.requests).toHaveLength(0)
    expect(bunkerB.requests).toHaveLength(0)
  })

  it('check-in: triggerCheckin() sends and is received/resolved on the other device, with zero bunker requests either side', async () => {
    signInA()
    await triggerCheckin(false)
    expect(publishSigned).toHaveBeenCalledTimes(1)
    const wrap = lastPublished()
    // final fix I3: same shared-store local-echo problem as the SOS case
    // above — wipe it so delivery is what's actually proven.
    store.update((p) => { p.safetyEvents = [] })

    signInB()
    await deliver(circle, wrap)
    // Same unawaited signalHandlers dispatch as the SOS case above.
    await vi.waitFor(() => {
      expect(store.load().safetyEvents.some((e) => e.kind === 'checkin' && e.from === A.pk && !e.id.startsWith('local-'))).toBe(true)
    })

    expect(bunkerA.requests).toHaveLength(0)
    expect(bunkerB.requests).toHaveLength(0)
  })

  it('beacon: a location beacon (emitTick\'s own build+publish primitives) sends and is received/resolved on the other device, with zero bunker requests either side', async () => {
    signInA()
    const fix = { lat: 51.5, lon: -0.12, accuracy: 10, at: nowSec() }
    // emitTick itself is a private, timer-driven orchestrator; this is the
    // exact pair it calls (buildBeaconWrap + publishOrEnqueue) — the same
    // "wire round trip" idiom beacons.test.ts's own
    // `buildBeaconWrap / decodeBeaconRumor` tests use, just phone-signed via
    // the real session instead of a bare local key.
    const { phoneSigner } = await import('./session.js')
    const wrap = await buildBeaconWrap(phoneSigner(), circle, fix, 9)
    await beacons.publishOrEnqueue([], wrap)
    expect(publishSigned).toHaveBeenCalledTimes(1)

    signInB()
    await deliver(circle, wrap)
    expect(memberPositions(circle.id).get(A.pk)).toBeDefined()

    expect(bunkerA.requests).toHaveLength(0)
    expect(bunkerB.requests).toHaveLength(0)
  })

  it('circle chat: requestPreciseLocation() (messages.ts\'s untargeted circle-chat buzz path) sends and is received/resolved on the other device, with zero bunker requests either side', async () => {
    signInA()
    const ok = await requestPreciseLocation(circle.id, B.pk, 'checking in on the way home')
    expect(ok).toBe(true)
    // requestPreciseLocation fires two phone-key sends (the findreq, then
    // the circle-chat buzz) — the buzz is the one messages.ts's own
    // handleIncomingSignal turns into a circleChats line on the other end.
    expect(publishSigned).toHaveBeenCalledTimes(2)
    const wrap = lastPublished()
    // final fix I3: same shared-store local-echo problem — requestPreciseLocation()
    // already inserted its own local circle-chat line for this thread. Wipe it
    // so delivery is what's actually proven.
    store.update((p) => { p.circleChats = {} })

    signInB()
    await deliver(circle, wrap)
    // Same unawaited signalHandlers dispatch as the SOS/check-in cases above
    // (messages.ts's handler runs through the same beacons.ts loop).
    await vi.waitFor(() => {
      expect((store.load().circleChats[circle.id] ?? []).some((m) => m.from === A.pk)).toBe(true)
    })

    expect(bunkerA.requests).toHaveLength(0)
    expect(bunkerB.requests).toHaveLength(0)
  })
})
