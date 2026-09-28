// Signer-split table (Task 13, whole-branch check): for every sender
// function the Task 9 migration touched, proves it uses EXACTLY the signer
// the plan assigns it — `phoneSigner()` for ordinary circle traffic, or
// `structural-queue.ts`'s `enqueue()` for an identity-signed structural
// action — by spying on both (real implementations still run; only calls
// are counted) and driving each function through its real, production
// entry point. Two functions don't fit the clean two-way split, and are
// called out where they're tested:
//  - `circles.ts`'s `doInvite` uses ALL THREE signer paths in one call:
//    `enqueue({action:'invite',...})` for the inner invite event (final fix
//    A2 — invites are queue-safe like every other structural action, no
//    direct un-queued `identitySigner()` call), `phoneSigner()` for the
//    outer wrap to the recipient's personal inbox once the queue's drain
//    has signed it, AND `enqueue({action:'config',...})` for the
//    roster-config broadcast that follows a successful invite.
//  - `messages.ts`'s `sendText`/`publishCircleBuzz`/`publishOnMyWay` are
//    private; `requestPreciseLocation`/`sendSuggestBaseline` (both exported)
//    are used as representative traffic through the same phone-key publish
//    primitives (`publishCircleBuzz`/`sendDmToMember`).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { toHex, makeLocalSigner } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { publishSigned } from '@forgesworn/roost-kit'
import * as store from './store.js'
import * as session from './session.js'
import { sessionForTests } from './session.js'
import type { SignerTransport } from './remote-signer.js'
import * as queue from './structural-queue.js'
import * as beacons from './beacons.js'
import { triggerSos, triggerCheckin, sendPreciseLocationFindreq, handleIncomingSignal as safetyHandleIncomingSignal } from './safety.js'
import { dropPin } from './pins.js'
import { addMeetPoint } from './meet.js'
import { startJourney } from './journey.js'
import { sendPickupRequestSignal, sendPickupOffer, performAction, openPickupRecord, type PickupRecord } from './pickup.js'
import * as battery from './battery.js'
import { requestPreciseLocation, sendSuggestBaseline } from './messages.js'
import { savePlaces, tick as placesTick, ensure as placesEnsure } from './places.js'
import type { Place } from './store.js'
import { raiseApproval, respondApproval, publishFamilyPolicy } from './approvals.js'
import { ackAgreement, sendAgreementStatus, requestExtend, proposeAgreement, respondExtend, DEFAULT_SCHEDULE } from './agreements.js'
import type { AgreementRecord } from './store.js'
import { buildApprovalReq } from './brood/index.js'
import { broadcastCreatedCircleConfig, removeMemberFromCircle, inviteToCircle } from './circles.js'
import { setContactsSource } from './contacts.js'
import { fakeContacts } from './test-support/fake-contacts.js'
import { buildFindPingSignal, FIND_PING_SIGNAL_TYPE } from '@forgesworn/flock/findping'
import type { Rumor } from '@forgesworn/roost-kit'

vi.mock('@forgesworn/roost-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgesworn/roost-kit')>()
  return { ...actual, publishSigned: vi.fn(async () => ({})) }
})
vi.mock('./notify.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./notify.js')>()
  return { ...actual, notify: vi.fn(async () => {}) }
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

function localTransport(skHex: string): SignerTransport {
  const s = makeLocalSigner(skHex)
  return {
    pubkey: s.pubkey,
    signEvent: (t) => s.signEvent(t),
    nip44Encrypt: (peer, pt) => s.nip44Encrypt(peer, pt),
    nip44Decrypt: (peer, ct) => s.nip44Decrypt(peer, ct),
    close: async () => {},
  }
}

function fakeCircle(id: string, overrides: Partial<Circle> = {}): Circle {
  const guardian = key()
  return {
    id, name: `Circle ${id}`, seedHex: '1'.repeat(64), epoch: 0,
    members: [{ pk: guardian.pk, role: 'guardian' }],
    createdAt: 100, configUpdatedAt: 100, configBy: guardian.pk,
    ...overrides,
  }
}

let phoneSignerSpy: ReturnType<typeof vi.spyOn>
let identitySignerSpy: ReturnType<typeof vi.spyOn>
let enqueueSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage())
  vi.mocked(publishSigned).mockClear()
  phoneSignerSpy = vi.spyOn(session, 'phoneSigner')
  identitySignerSpy = vi.spyOn(session, 'identitySigner')
  enqueueSpy = vi.spyOn(queue, 'enqueue')
})

afterEach(() => {
  sessionForTests(null)
  queue.resetForTests()
  vi.unstubAllGlobals()
  phoneSignerSpy.mockRestore()
  identitySignerSpy.mockRestore()
  enqueueSpy.mockRestore()
})

// ---------------------------------------------------------------------------
// Traffic — phoneSigner(), never enqueue()
// ---------------------------------------------------------------------------

describe('signer split — traffic (phoneSigner, never enqueue)', () => {
  it('safety.ts triggerSos', async () => {
    const self = key()
    const circle = fakeCircle('c-sos', { members: [{ pk: self.pk, role: 'guardian' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    await triggerSos()
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('safety.ts triggerCheckin', async () => {
    const self = key()
    const circle = fakeCircle('c-checkin', { members: [{ pk: self.pk, role: 'guardian' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    await triggerCheckin(false)
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('safety.ts sendPreciseLocationFindreq (sendFindreq)', async () => {
    const self = key()
    const target = key()
    const circle = fakeCircle('c-findreq', { members: [{ pk: self.pk, role: 'guardian' }, { pk: target.pk, role: 'child' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    const at = await sendPreciseLocationFindreq(circle.id, target.pk)
    expect(at).not.toBeNull()
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('safety.ts autoAnswerPickup (via a fresh findreq addressed to self)', async () => {
    const self = key()
    const asker = key()
    const circle = fakeCircle('c-autoanswer', { members: [{ pk: self.pk, role: 'child' }, { pk: asker.pk, role: 'guardian' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: true })
    store.update((p) => { p.circles = [circle] })
    beacons.feedFix({ lat: 51.5, lon: -0.12, accuracy: 10, at: nowSec() }) // autoAnswerPickup no-ops with nothing to disclose
    const inner = await buildFindPingSignal({ groupId: circle.id, seedHex: circle.seedHex, from: asker.pk, target: self.pk, timestamp: nowSec() })
    const rumor = { id: 'findreq-1', pubkey: asker.pk, ...inner } as unknown as Rumor
    phoneSignerSpy.mockClear()
    await safetyHandleIncomingSignal(circle, rumor, FIND_PING_SIGNAL_TYPE, { signerPk: asker.pk, memberPk: asker.pk, structural: false })
    await vi.waitFor(() => { expect(publishSigned).toHaveBeenCalled() })
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('beacons.ts emitTick (via ensure()+feedFix, the real timer-driven orchestrator)', async () => {
    const self = key()
    const circle = fakeCircle('c-beacon-tick', { members: [{ pk: self.pk, role: 'guardian' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    beacons.feedFix({ lat: 51.5, lon: -0.12, accuracy: 10, at: nowSec() })
    beacons.ensure(store.load())
    await vi.waitFor(() => { expect(phoneSignerSpy).toHaveBeenCalled() }, { timeout: 2000 })
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('pins.ts publishPin (via dropPin)', async () => {
    const self = key()
    const circle = fakeCircle('c-pin', { members: [{ pk: self.pk, role: 'guardian' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    await dropPin(circle.id, 'meet', { lat: 51.5, lon: -0.1 })
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('meet.ts saveMeetPoints (via addMeetPoint)', async () => {
    const self = key()
    const circle = fakeCircle('c-meet', { members: [{ pk: self.pk, role: 'guardian' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    await addMeetPoint(circle.id, { name: 'Gate 3', centre: { lat: 51.5, lon: -0.1 }, expiresAt: nowSec() + 3600 })
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('journey.ts sendJourneyBuzz (via startJourney)', async () => {
    const self = key()
    const circle = fakeCircle('c-journey', { members: [{ pk: self.pk, role: 'guardian' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    startJourney(circle.id, { kind: 'label', label: 'the park' })
    await vi.waitFor(() => { expect(phoneSignerSpy).toHaveBeenCalled() })
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('pickup.ts sendPickupRequestSignal', async () => {
    const self = key()
    const circle = fakeCircle('c-pickup-req', { members: [{ pk: self.pk, role: 'guardian' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    await sendPickupRequestSignal(circle.id, key().pk, nowSec())
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('pickup.ts sendPickupOffer', async () => {
    const self = key()
    const circle = fakeCircle('c-pickup-offer', { members: [{ pk: self.pk, role: 'guardian' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    await sendPickupOffer(circle.id, key().pk)
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('pickup.ts sendPhaseTransition (via performAction)', async () => {
    const collector = key()
    const child = key()
    const circle = fakeCircle('c-pickup-phase', { members: [{ pk: collector.pk, role: 'guardian' }, { pk: child.pk, role: 'child' }] })
    sessionForTests({ identityPk: collector.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => {
      p.circles = [circle]
      const record: PickupRecord = openPickupRecord([], { id: 'pk-1', circleId: circle.id, childPk: child.pk, collectorPk: collector.pk, direction: 'request', at: nowSec() })[0]!
      p.pickups = [record]
    })
    await performAction('pk-1', 'accept')
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('battery.ts poll (via ensure(), a real navigator.getBattery)', async () => {
    const self = key()
    const circle = fakeCircle('c-battery', { members: [{ pk: self.pk, role: 'child' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: true })
    store.update((p) => { p.circles = [circle] })
    vi.stubGlobal('navigator', { getBattery: async () => ({ level: 0.42, charging: false }) })
    battery.ensure(store.load())
    await vi.waitFor(() => { expect(phoneSignerSpy).toHaveBeenCalled() })
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('messages.ts publishCircleBuzz (via requestPreciseLocation)', async () => {
    const self = key()
    const target = key()
    const circle = fakeCircle('c-precise', { members: [{ pk: self.pk, role: 'guardian' }, { pk: target.pk, role: 'child' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    const ok = await requestPreciseLocation(circle.id, target.pk, 'checking in')
    expect(ok).toBe(true)
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('messages.ts sendDmToMember (via sendSuggestBaseline)', async () => {
    const guardian = key()
    const guardianPhone = key()
    const child = key()
    const childPhone = key()
    const circle = fakeCircle('c-suggest', { members: [{ pk: guardian.pk, role: 'guardian' }, { pk: child.pk, role: 'child' }] })
    sessionForTests({ identityPk: guardian.pk, phoneSkHex: guardianPhone.skHex, dependant: false })
    store.update((p) => {
      p.circles = [circle]
      p.phoneKeys = { [circle.id]: { [childPhone.pk]: { memberPk: child.pk, statement: {} as never, lastSeen: 0 } } }
    })
    const ok = await sendSuggestBaseline(circle.id, child.pk, 6)
    expect(ok).toBe(true)
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('agreements.ts ackAgreement', async () => {
    const child = key()
    const guardian = key()
    const circle = fakeCircle('c-ack', { members: [{ pk: guardian.pk, role: 'guardian' }, { pk: child.pk, role: 'child' }] })
    const record: AgreementRecord = {
      agreement: { t: 'agreement', id: 'agr-ack', circleId: circle.id, child: child.pk, byUnix: nowSec() + 3600, schedule: DEFAULT_SCHEDULE, from: guardian.pk, at: nowSec() },
      status: 'proposed',
    }
    sessionForTests({ identityPk: child.pk, phoneSkHex: key().skHex, dependant: true })
    store.update((p) => { p.circles = [circle]; p.agreements = [record] })
    await ackAgreement('agr-ack')
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('agreements.ts sendAgreementStatus', async () => {
    const child = key()
    const guardian = key()
    const circle = fakeCircle('c-status', { members: [{ pk: guardian.pk, role: 'guardian' }, { pk: child.pk, role: 'child' }] })
    const record: AgreementRecord = {
      agreement: { t: 'agreement', id: 'agr-status', circleId: circle.id, child: child.pk, byUnix: nowSec() + 3600, schedule: DEFAULT_SCHEDULE, from: guardian.pk, at: nowSec() },
      status: 'acked',
    }
    sessionForTests({ identityPk: child.pk, phoneSkHex: key().skHex, dependant: true })
    store.update((p) => { p.circles = [circle]; p.agreements = [record] })
    await sendAgreementStatus('agr-status', 'en-route')
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('agreements.ts requestExtend', async () => {
    const child = key()
    const guardian = key()
    const circle = fakeCircle('c-extend-req', { members: [{ pk: guardian.pk, role: 'guardian' }, { pk: child.pk, role: 'child' }] })
    const record: AgreementRecord = {
      agreement: { t: 'agreement', id: 'agr-extend', circleId: circle.id, child: child.pk, byUnix: nowSec() + 60, schedule: DEFAULT_SCHEDULE, from: guardian.pk, at: nowSec() },
      status: 'en-route',
    }
    sessionForTests({ identityPk: child.pk, phoneSkHex: key().skHex, dependant: true })
    store.update((p) => { p.circles = [circle]; p.agreements = [record] })
    await requestExtend('agr-extend', 15)
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('approvals.ts raiseApproval', async () => {
    const self = key()
    const circle = fakeCircle('c-raise', { members: [{ pk: self.pk, role: 'guardian' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    const id = await raiseApproval(circle.id, 'add-member', { pk: key().pk })
    expect(id).not.toBeNull()
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('places.ts sendPlaceBuzz (via tick(), a genuine departure)', async () => {
    const self = key()
    const circle = fakeCircle('c-place-buzz', { members: [{ pk: self.pk, role: 'child' }] })
    const place: Place = {
      id: 'home', name: 'Home', type: 'home', centre: { lat: 51.5, lon: -0.1 }, radiusMetres: 100,
      arrivalNotify: true, departureNotify: true, escalation: 'grace', graceMinutes: 20,
    }
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: true })
    store.update((p) => { p.circles = [circle]; p.places = { [circle.id]: [place] } })
    beacons.feedFix({ lat: place.centre.lat, lon: place.centre.lon, accuracy: 5, at: nowSec() })
    placesEnsure()
    await placesTick() // seeds silently (already inside)
    await placesTick() // steady state
    beacons.feedFix({ lat: place.centre.lat + 500 / 111_320, lon: place.centre.lon, accuracy: 5, at: nowSec() })
    phoneSignerSpy.mockClear()
    await placesTick() // genuine departure — sendPlaceBuzz
    await vi.waitFor(() => { expect(phoneSignerSpy).toHaveBeenCalled() })
    expect(enqueueSpy).not.toHaveBeenCalled()
  })

  it('places.ts sendBreachSignal (via tick(), cold-launch escalation)', async () => {
    const self = key()
    const circle = fakeCircle('c-breach', { members: [{ pk: self.pk, role: 'child' }] })
    const place: Place = {
      id: 'home2', name: 'Home', type: 'home', centre: { lat: 51.5, lon: -0.1 }, radiusMetres: 100,
      arrivalNotify: false, departureNotify: false, escalation: 'grace', graceMinutes: 20,
    }
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: true })
    store.update((p) => {
      p.circles = [circle]
      p.places = { [circle.id]: [place] }
      p.placeEval = { [circle.id]: { phase: 'grace', placeName: place.name, graceEndsAt: nowSec() - 5 } }
    })
    // A fix is already available (unlike places.test.ts's own cold-launch
    // C1 test, which deliberately starts with none): `checkGraceExpiry`
    // (time-based, independent of a fresh fix) escalates grace -> escalated
    // this same tick, and since a fix is already in hand `ensureBreachSent`
    // sends immediately, in the one tick — see `tick()`'s own "Review C1
    // fix" block.
    beacons.feedFix({ lat: place.centre.lat + 500 / 111_320, lon: place.centre.lon, accuracy: 5, at: nowSec() })
    placesEnsure()
    phoneSignerSpy.mockClear()
    await placesTick()
    await vi.waitFor(() => { expect(phoneSignerSpy).toHaveBeenCalled() })
    expect(enqueueSpy).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Structural — structural-queue.ts's enqueue(), never phoneSigner()
// ---------------------------------------------------------------------------

describe('signer split — structural (enqueue, never phoneSigner)', () => {
  it('approvals.ts publishFamilyPolicy', async () => {
    const self = key()
    const circle = fakeCircle('c-policy', { members: [{ pk: self.pk, role: 'guardian' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    await publishFamilyPolicy(circle.id, { 'add-member': 'allow' })
    expect(enqueueSpy).toHaveBeenCalled()
    expect(phoneSignerSpy).not.toHaveBeenCalled()
  })

  it('approvals.ts respondApproval', async () => {
    const guardian = key()
    const requester = key()
    const circle = fakeCircle('c-respond', { members: [{ pk: guardian.pk, role: 'guardian' }, { pk: requester.pk, role: 'child' }] })
    const req = buildApprovalReq({ id: 'appr-1', action: 'add-member', params: {}, from: requester.pk }, nowSec())
    sessionForTests({ identityPk: guardian.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle]; p.approvals = [{ req, circleId: circle.id }] })
    await respondApproval('appr-1', true)
    expect(enqueueSpy).toHaveBeenCalled()
    expect(phoneSignerSpy).not.toHaveBeenCalled()
  })

  it('agreements.ts proposeAgreement', async () => {
    const guardian = key()
    const child = key()
    const circle = fakeCircle('c-propose', { members: [{ pk: guardian.pk, role: 'guardian' }, { pk: child.pk, role: 'child' }] })
    sessionForTests({ identityPk: guardian.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    await proposeAgreement(circle.id, { child: child.pk, byUnix: nowSec() + 3600, schedule: DEFAULT_SCHEDULE })
    expect(enqueueSpy).toHaveBeenCalled()
    expect(phoneSignerSpy).not.toHaveBeenCalled()
  })

  it('agreements.ts respondExtend', async () => {
    const guardian = key()
    const child = key()
    const circle = fakeCircle('c-extend-resp', { members: [{ pk: guardian.pk, role: 'guardian' }, { pk: child.pk, role: 'child' }] })
    const record: AgreementRecord = {
      agreement: { t: 'agreement', id: 'agr-extend-resp', circleId: circle.id, child: child.pk, byUnix: nowSec() + 60, schedule: DEFAULT_SCHEDULE, from: guardian.pk, at: nowSec() },
      status: 'late',
      pendingExtend: { id: 'agr-extend-resp', extraMin: 15, by: child.pk, at: nowSec() },
    }
    sessionForTests({ identityPk: guardian.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle]; p.agreements = [record] })
    await respondExtend('agr-extend-resp', true)
    expect(enqueueSpy).toHaveBeenCalled()
    expect(phoneSignerSpy).not.toHaveBeenCalled()
  })

  it("places.ts savePlaces — structural only (final fix B1/I1): the flock-interop fences wrap no longer sends synchronously from savePlaces itself — it now sends from the 'places' queue sender, AFTER the identity-signed update, so phoneSigner() isn't touched until a later drain actually succeeds", async () => {
    const self = key()
    const circle = fakeCircle('c-places', { members: [{ pk: self.pk, role: 'guardian' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    await savePlaces(circle.id, [])
    expect(enqueueSpy).toHaveBeenCalled()
    expect(phoneSignerSpy).not.toHaveBeenCalled()
  })

  it('circles.ts broadcastCreatedCircleConfig (config)', async () => {
    const self = key()
    const circle = fakeCircle('c-config', { members: [{ pk: self.pk, role: 'guardian' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    await broadcastCreatedCircleConfig(store.load(), circle)
    expect(enqueueSpy).toHaveBeenCalled()
    expect(phoneSignerSpy).not.toHaveBeenCalled()
  })

  it('circles.ts removeMemberFromCircle (rekey, via sendRekey)', async () => {
    const self = key()
    const other = key()
    const circle = fakeCircle('c-remove', { members: [{ pk: self.pk, role: 'guardian' }, { pk: other.pk, role: 'child' }] })
    sessionForTests({ identityPk: self.pk, phoneSkHex: key().skHex, dependant: false })
    store.update((p) => { p.circles = [circle] })
    await removeMemberFromCircle(circle.id, other.pk)
    expect(enqueueSpy).toHaveBeenCalled()
    expect(phoneSignerSpy).not.toHaveBeenCalled()
  })

  it("circles.ts doInvite (via inviteToCircle) — final fix A2/I4: the invite itself is enqueued like every other structural action (no direct, un-queued identitySigner() call); the queue's drain signs it, phoneSigner() wraps it for the recipient's personal inbox, and a successful invite still enqueues the roster-config broadcast", async () => {
    const self = key()
    const identitySk = generateSecretKey()
    const circle = fakeCircle('c-invite', { members: [{ pk: self.pk, role: 'guardian' }] })
    const stmt = await makeLocalSigner(self.skHex).signEvent({ kind: 30_444, tags: [], content: '', created_at: nowSec() })
    sessionForTests({ identityPk: self.pk, phoneSkHex: self.skHex, dependant: false, statement: stmt, transport: localTransport(toHex(identitySk)) })
    store.update((p) => { p.circles = [circle] })
    // Plan 2, Task 6: only a usable contact can be invited.
    const invitee = key().pk
    setContactsSource(fakeContacts({ status: 'connected', contacts: [{ contactId: 'k', pks: [invitee], name: 'Kim', tier: 'kin', blocked: false }] }))
    await inviteToCircle(circle.id, invitee)
    setContactsSource(null)
    // The inner invite event goes through the queue (final fix A2), not a
    // direct identitySigner() call — this is what I4 changed. `doInvite`
    // awaits `drain()`, so by the time this resolves the queue has signed
    // the item (identitySigner, via the queue's own sign step),
    // `sendInvite` has wrapped it with `phoneSigner()` for the recipient's
    // personal inbox, AND enqueued the roster-config broadcast — still all
    // three signer paths in one call, but the invite event itself is now
    // queue-safe like the other seven structural actions.
    expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({ action: 'invite' }))
    expect(identitySignerSpy).toHaveBeenCalled()
    expect(phoneSignerSpy).toHaveBeenCalled()
    expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({ action: 'config' }))
  })
})
