import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  BATTERY_SIGNAL_TYPE,
  BATTERY_BUCKET,
  BATTERY_MIN_INTERVAL_SEC,
  BATTERY_LOW_CROSSINGS,
  BATTERY_FRESH_SEC,
  LOW_BATTERY_PCT,
  LOW_BATTERY_RESET_PCT,
  buildBatteryInner,
  buildBatteryWrap,
  parseBatterySignal,
  parseIncomingBattery,
  shouldSendBattery,
  shareBatteryDefault,
  effectiveShareBattery,
  lowBatteryTransition,
  batteryFor,
  latestBatteryFor,
  handleIncomingSignal,
  readBattery,
  type BatteryReading,
  type BatteryEmitMemory,
  type MemberBattery,
} from './battery.js'
import type { Circle } from '@forgesworn/covey-kit'
import { makeLocalSigner, deriveInbox, toHex } from '@forgesworn/covey-kit'
import { giftUnwrap, rawNip44Decrypt } from '@forgesworn/roost-kit'
import type { Rumor } from '@forgesworn/roost-kit'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import * as store from './store.js'
import { sessionForTests, currentSession } from './session.js'
import type { Sender } from './beacons.js'

const PK_GUARDIAN = 'a'.repeat(64)
const PK_CHILD = 'b'.repeat(64)

function fakeCircle(overrides: Partial<Circle> = {}): Circle {
  return {
    id: 'circle-1', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
    members: [
      { pk: PK_GUARDIAN, role: 'guardian' },
      { pk: PK_CHILD, role: 'child' },
    ],
    createdAt: 100, configUpdatedAt: 100, configBy: PK_GUARDIAN,
    ...overrides,
  }
}

function fakeReading(overrides: Partial<BatteryReading> = {}): BatteryReading {
  return { pct: 50, charging: false, at: 1000, ...overrides }
}

describe('BATTERY_SIGNAL_TYPE / constants — task-contract values', () => {
  it('uses the kindependence-battery wire type', () => {
    expect(BATTERY_SIGNAL_TYPE).toBe('kindependence-battery')
  })

  it('defaults the bucket/interval/crossings exactly per the task contract', () => {
    expect(BATTERY_BUCKET).toBe(5)
    expect(BATTERY_MIN_INTERVAL_SEC).toBe(600)
    expect(BATTERY_LOW_CROSSINGS).toEqual([20, 10])
  })
})

describe('parseBatterySignal — round-trips buildBatteryInner content, rejects malformed wholesale', () => {
  it('round-trips a valid reading built by buildBatteryInner', () => {
    const inner = buildBatteryInner('circle-1', PK_CHILD, fakeReading({ pct: 42, charging: true, at: 5000 }))
    expect(inner.tags).toEqual([['t', BATTERY_SIGNAL_TYPE]])
    expect(inner.created_at).toBe(5000)
    const decoded = parseBatterySignal(inner.content, 'circle-1')
    expect(decoded).toEqual({ from: PK_CHILD, pct: 42, charging: true, at: 5000 })
  })

  it('rejects a wrong t', () => {
    const content = JSON.stringify({ t: 'kindependence-places', circleId: 'circle-1', from: PK_CHILD, pct: 50, charging: false, at: 1000 })
    expect(parseBatterySignal(content, 'circle-1')).toBeNull()
  })

  it('rejects a mismatched circleId', () => {
    const inner = buildBatteryInner('circle-1', PK_CHILD, fakeReading())
    expect(parseBatterySignal(inner.content, 'circle-other')).toBeNull()
  })

  it.each([101, -1, 1.5, NaN])('rejects an out-of-range/non-integer pct (%s)', (pct) => {
    const content = JSON.stringify({ t: BATTERY_SIGNAL_TYPE, circleId: 'circle-1', from: PK_CHILD, pct, charging: false, at: 1000 })
    expect(parseBatterySignal(content, 'circle-1')).toBeNull()
  })

  it('rejects a non-hex/wrong-length from', () => {
    const content = JSON.stringify({ t: BATTERY_SIGNAL_TYPE, circleId: 'circle-1', from: 'not-hex', pct: 50, charging: false, at: 1000 })
    expect(parseBatterySignal(content, 'circle-1')).toBeNull()
  })

  it('rejects a non-boolean charging', () => {
    const content = JSON.stringify({ t: BATTERY_SIGNAL_TYPE, circleId: 'circle-1', from: PK_CHILD, pct: 50, charging: 'yes', at: 1000 })
    expect(parseBatterySignal(content, 'circle-1')).toBeNull()
  })

  it('rejects malformed JSON', () => {
    expect(parseBatterySignal('{not json', 'circle-1')).toBeNull()
  })

  it('rejects null content', () => {
    expect(parseBatterySignal(null as unknown as string, 'circle-1')).toBeNull()
  })

  it('never throws on a non-object payload', () => {
    expect(parseBatterySignal('42', 'circle-1')).toBeNull()
    expect(parseBatterySignal('"a string"', 'circle-1')).toBeNull()
  })
})

describe('shouldSendBattery — pure emit policy', () => {
  it('sends on the first reading ever (no prior memory)', () => {
    expect(shouldSendBattery(undefined, fakeReading())).toBe(true)
  })

  it('suppresses when nothing relevant changed', () => {
    const mem: BatteryEmitMemory = { pct: 50, charging: false, at: 1000 }
    expect(shouldSendBattery(mem, fakeReading({ pct: 50, charging: false, at: 1005 }))).toBe(false)
  })

  it('a same-bucket change stays suppressed regardless of elapsed time', () => {
    const mem: BatteryEmitMemory = { pct: 53, charging: false, at: 1000 }
    expect(shouldSendBattery(mem, fakeReading({ pct: 51, charging: false, at: 1000 + BATTERY_MIN_INTERVAL_SEC }))).toBe(false)
  })

  it('a bucket change before the min interval is suppressed', () => {
    const mem: BatteryEmitMemory = { pct: 54, charging: false, at: 1000 } // bucket 10
    const r = fakeReading({ pct: 49, charging: false, at: 1000 + BATTERY_MIN_INTERVAL_SEC - 1 }) // bucket 9
    expect(shouldSendBattery(mem, r)).toBe(false)
  })

  it('the same bucket change sends once the min interval has elapsed', () => {
    const mem: BatteryEmitMemory = { pct: 54, charging: false, at: 1000 }
    const r = fakeReading({ pct: 49, charging: false, at: 1000 + BATTERY_MIN_INTERVAL_SEC })
    expect(shouldSendBattery(mem, r)).toBe(true)
  })

  it('an upward bucket change also respects the min interval (not just downward)', () => {
    const mem: BatteryEmitMemory = { pct: 49, charging: false, at: 1000 } // bucket 9
    const early = fakeReading({ pct: 54, charging: false, at: 1000 + BATTERY_MIN_INTERVAL_SEC - 1 }) // bucket 10
    expect(shouldSendBattery(mem, early)).toBe(false)
    const late = fakeReading({ pct: 54, charging: false, at: 1000 + BATTERY_MIN_INTERVAL_SEC })
    expect(shouldSendBattery(mem, late)).toBe(true)
  })

  it('a charging-state flip sends immediately, regardless of interval or bucket', () => {
    const mem: BatteryEmitMemory = { pct: 50, charging: false, at: 1000 }
    expect(shouldSendBattery(mem, fakeReading({ pct: 50, charging: true, at: 1001 }))).toBe(true)
  })

  it('crossing DOWN through 20 sends immediately mid-interval', () => {
    const mem: BatteryEmitMemory = { pct: 22, charging: false, at: 1000 }
    expect(shouldSendBattery(mem, fakeReading({ pct: 19, charging: false, at: 1001 }))).toBe(true)
  })

  it('crossing DOWN through 10 sends immediately mid-interval', () => {
    const mem: BatteryEmitMemory = { pct: 12, charging: false, at: 1000 }
    expect(shouldSendBattery(mem, fakeReading({ pct: 9, charging: false, at: 1001 }))).toBe(true)
  })

  it('landing exactly on the 20 threshold from above still counts as crossing it', () => {
    const mem: BatteryEmitMemory = { pct: 21, charging: false, at: 1000 }
    expect(shouldSendBattery(mem, fakeReading({ pct: 20, charging: false, at: 1001 }))).toBe(true)
  })

  it('already below the threshold is not a fresh crossing (same bucket, isolates the crossing rule)', () => {
    const mem: BatteryEmitMemory = { pct: 15, charging: false, at: 1000 }
    expect(shouldSendBattery(mem, fakeReading({ pct: 14, charging: false, at: 1001 }))).toBe(false)
  })

  it('rising back above a threshold is not itself a downward crossing', () => {
    const mem: BatteryEmitMemory = { pct: 9, charging: false, at: 1000 }
    expect(shouldSendBattery(mem, fakeReading({ pct: 11, charging: false, at: 1001 }))).toBe(false)
  })
})

describe('shareBatteryDefault / effectiveShareBattery — child-shares-by-default policy', () => {
  const circle = fakeCircle()

  it('defaults ON for a child', () => {
    expect(shareBatteryDefault(circle, PK_CHILD)).toBe(true)
    expect(effectiveShareBattery({}, circle, PK_CHILD)).toBe(true)
  })

  it('defaults OFF for a guardian', () => {
    expect(shareBatteryDefault(circle, PK_GUARDIAN)).toBe(false)
    expect(effectiveShareBattery({}, circle, PK_GUARDIAN)).toBe(false)
  })

  it('an explicit override turns a child OFF', () => {
    const settings = { shareBattery: { [circle.id]: false } }
    expect(effectiveShareBattery(settings, circle, PK_CHILD)).toBe(false)
  })

  it('an explicit override turns a guardian ON', () => {
    const settings = { shareBattery: { [circle.id]: true } }
    expect(effectiveShareBattery(settings, circle, PK_GUARDIAN)).toBe(true)
  })
})

describe('buildBatteryWrap — wire round trip through gift-wrap + parseBatterySignal', () => {
  it('round-trips a reading end to end, keyed to the signer\'s own pubkey as `from`', async () => {
    const sk = generateSecretKey()
    const skHex = toHex(sk)
    const pkHex = getPublicKey(sk)
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle({ members: [{ pk: pkHex, role: 'child' }] })
    const reading = fakeReading({ pct: 33, charging: true, at: 9000 })

    const wrap = await buildBatteryWrap(signer, pkHex, circle, reading)
    expect(wrap.kind).toBe(1059) // outer NIP-59 gift wrap

    const inbox = deriveInbox(circle.seedHex)
    const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), wrap)
    expect(rumor).not.toBeNull()

    const decoded = parseBatterySignal((rumor as Rumor).content, circle.id)
    expect(decoded).toEqual({ from: pkHex, pct: 33, charging: true, at: 9000 })
  })
})

// ---------------------------------------------------------------------------
// Phase 3, Task 2 — receive side: low-battery episode state machine,
// received-state map, incoming-signal handler, and the readBattery() clamp
// fix (Task 1 review follow-up, Minor #1).
// ---------------------------------------------------------------------------

function fakeMemberBattery(overrides: Partial<MemberBattery> = {}): MemberBattery {
  return { pct: 50, charging: false, at: 1000, ...overrides }
}

describe('lowBatteryTransition — pure low-battery alert episode state machine', () => {
  it('fires when a fresh reading dips to 15% or below from a non-episode state', () => {
    expect(lowBatteryTransition(undefined, false, fakeMemberBattery({ pct: LOW_BATTERY_PCT }))).toEqual({ inEpisode: true, fire: true })
    expect(lowBatteryTransition(undefined, false, fakeMemberBattery({ pct: 5 }))).toEqual({ inEpisode: true, fire: true })
  })

  it('does not refire while already in an active episode', () => {
    expect(lowBatteryTransition(undefined, true, fakeMemberBattery({ pct: 10 }))).toEqual({ inEpisode: true, fire: false })
  })

  it('charging suppresses firing and ends an active episode', () => {
    expect(lowBatteryTransition(undefined, false, fakeMemberBattery({ pct: 10, charging: true }))).toEqual({ inEpisode: false, fire: false })
    expect(lowBatteryTransition(undefined, true, fakeMemberBattery({ pct: 10, charging: true }))).toEqual({ inEpisode: false, fire: false })
  })

  it('resetting above LOW_BATTERY_RESET_PCT (25%) ends an active episode without firing — it can rearm on the next dip', () => {
    expect(lowBatteryTransition(undefined, true, fakeMemberBattery({ pct: 30 }))).toEqual({ inEpisode: false, fire: false })
  })

  it('15% while charging never fires', () => {
    expect(lowBatteryTransition(undefined, false, fakeMemberBattery({ pct: LOW_BATTERY_PCT, charging: true }))).toEqual({ inEpisode: false, fire: false })
  })

  it('boundary: exactly 25% stays in the episode (not yet reset); 26% resets it', () => {
    expect(lowBatteryTransition(undefined, true, fakeMemberBattery({ pct: LOW_BATTERY_RESET_PCT }))).toEqual({ inEpisode: true, fire: false })
    expect(lowBatteryTransition(undefined, true, fakeMemberBattery({ pct: LOW_BATTERY_RESET_PCT + 1 }))).toEqual({ inEpisode: false, fire: false })
  })
})

describe('parseIncomingBattery — parse + spoofed-`from` rejection, pure', () => {
  it('accepts a valid, self-consistent signal (content `from` matches the signing pubkey)', () => {
    const inner = buildBatteryInner('circle-1', PK_CHILD, fakeReading({ pct: 42, at: 5000 }))
    expect(parseIncomingBattery(inner.content, 'circle-1', PK_CHILD)).toEqual({ from: PK_CHILD, pct: 42, charging: false, at: 5000 })
  })

  it('rejects a spoofed `from` — content claims one pubkey, rumor signed by another', () => {
    const inner = buildBatteryInner('circle-1', PK_CHILD, fakeReading())
    expect(parseIncomingBattery(inner.content, 'circle-1', PK_GUARDIAN)).toBeNull()
  })

  it('rejects malformed content the same way parseBatterySignal itself does', () => {
    expect(parseIncomingBattery('{not json', 'circle-1', PK_CHILD)).toBeNull()
  })

  it('rejects a mismatched circleId', () => {
    const inner = buildBatteryInner('circle-1', PK_CHILD, fakeReading())
    expect(parseIncomingBattery(inner.content, 'circle-other', PK_CHILD)).toBeNull()
  })
})

describe('latestBatteryFor — freshest reading across circles (pure once populated)', () => {
  it('returns undefined when nothing has been heard', () => {
    expect(latestBatteryFor(PK_CHILD, ['circle-1', 'circle-2'])).toBeUndefined()
  })
})

/** Minimal in-memory localStorage stand-in (mirrors approvals.test.ts's/places.test.ts's). */
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

/** Signs this device in for a test: `identityPk` is the signed-in identity,
 *  `phoneSkHex` this device's own phone key. Returns the derived phone
 *  pubkey — tests that need to simulate this device's OWN echo build a
 *  rumor/sender with `signerPk` set to this value. */
function signIn(identityPk: string, phoneSkHex: string): string {
  sessionForTests({ identityPk, phoneSkHex })
  return currentSession()!.phonePk
}

/** A resolved sender for a phone-key (non-structural) circle signal —
 *  `phonePk` the sealing phone key, `memberPk` the identity it resolves to
 *  (a distinct value only matters for the spoofed-sender test below). */
function fakeSender(phonePk: string, memberPk: string = phonePk): Sender {
  return { signerPk: phonePk, memberPk, structural: false }
}

// ---------------------------------------------------------------------------
// handleIncomingSignal — matching, self-echo, spoofed-from rejection, upsert,
// and the low-battery Activity+notify side effect. `handleIncomingSignal`
// takes an already-decoded `Rumor`, same precedent as approvals.test.ts's/
// places.test.ts's own coverage — no beacons/network mocking needed.
// ---------------------------------------------------------------------------

describe('handleIncomingSignal', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })

  it('ignores a signal whose pubkey is this device\'s own (self-echo)', () => {
    const myPhonePk = signIn(PK_CHILD, toHex(generateSecretKey()))
    const circle = fakeCircle()
    const rumor: Rumor = { pubkey: myPhonePk, created_at: 1000, kind: 20_078, tags: [['t', BATTERY_SIGNAL_TYPE]], content: 'not json' }
    expect(() => handleIncomingSignal(circle, rumor, BATTERY_SIGNAL_TYPE, fakeSender(myPhonePk, PK_CHILD))).not.toThrow()
    expect(batteryFor(circle.id, PK_CHILD)).toBeUndefined()
  })

  it('ignores a non-battery `t`', () => {
    signIn(PK_GUARDIAN, toHex(generateSecretKey()))
    const circle = fakeCircle()
    const inner = buildBatteryInner(circle.id, PK_CHILD, fakeReading({ pct: 50, at: 1000 }))
    const rumor: Rumor = { pubkey: PK_CHILD, created_at: 1000, kind: 20_078, tags: [['t', 'beacon']], content: inner.content }
    handleIncomingSignal(circle, rumor, 'beacon', fakeSender(PK_CHILD))
    expect(batteryFor(circle.id, PK_CHILD)).toBeUndefined()
  })

  it('upserts a valid reading into batteryFor/latestBatteryFor', () => {
    signIn(PK_GUARDIAN, toHex(generateSecretKey()))
    const circle = fakeCircle({ id: `circle-upsert-${Math.random()}` })
    const inner = buildBatteryInner(circle.id, PK_CHILD, fakeReading({ pct: 60, charging: true, at: 1234 }))
    const rumor: Rumor = { pubkey: PK_CHILD, created_at: 1234, kind: 20_078, tags: [['t', BATTERY_SIGNAL_TYPE]], content: inner.content }
    handleIncomingSignal(circle, rumor, BATTERY_SIGNAL_TYPE, fakeSender(PK_CHILD))
    expect(batteryFor(circle.id, PK_CHILD)).toEqual({ pct: 60, charging: true, at: 1234 })
    expect(latestBatteryFor(PK_CHILD, [circle.id])).toEqual({ pct: 60, charging: true, at: 1234 })
  })

  it('rejects a spoofed `from` — does not upsert anything', () => {
    // A third device (neither the rumor's actual signer nor the pubkey the
    // content claims) so the self-echo guard above can't be what's rejecting
    // this — isolates the spoofed-`from` check specifically.
    const observer = 'd'.repeat(64)
    signIn(observer, toHex(generateSecretKey()))
    const circle = fakeCircle({ id: `circle-spoof-${Math.random()}` })
    const inner = buildBatteryInner(circle.id, PK_CHILD, fakeReading({ pct: 50, at: 1000 }))
    // Signed by the guardian, but the content claims to be from the child.
    const rumor: Rumor = { pubkey: PK_GUARDIAN, created_at: 1000, kind: 20_078, tags: [['t', BATTERY_SIGNAL_TYPE]], content: inner.content }
    handleIncomingSignal(circle, rumor, BATTERY_SIGNAL_TYPE, fakeSender(PK_GUARDIAN))
    expect(batteryFor(circle.id, PK_CHILD)).toBeUndefined()
    expect(batteryFor(circle.id, PK_GUARDIAN)).toBeUndefined()
  })

  it('records a battery-low Activity entry on a fresh low crossing', () => {
    signIn(PK_GUARDIAN, toHex(generateSecretKey()))
    const circle = fakeCircle({ id: `circle-low-${Math.random()}` })
    const at = Math.floor(Date.now() / 1000)
    const inner = buildBatteryInner(circle.id, PK_CHILD, fakeReading({ pct: 10, at }))
    const rumor: Rumor = { pubkey: PK_CHILD, created_at: at, kind: 20_078, tags: [['t', BATTERY_SIGNAL_TYPE]], content: inner.content }
    handleIncomingSignal(circle, rumor, BATTERY_SIGNAL_TYPE, fakeSender(PK_CHILD))
    const evt = store.load().activity.find((e) => e.kind === 'battery-low' && e.circleId === circle.id)
    expect(evt).toBeDefined()
    expect(evt?.actorPk).toBe(PK_CHILD)
    expect(evt?.params.pct).toBe('10')
  })

  it('does not record an Activity entry for a normal (non-low) reading', () => {
    signIn(PK_GUARDIAN, toHex(generateSecretKey()))
    const circle = fakeCircle({ id: `circle-normal-${Math.random()}` })
    const at = Math.floor(Date.now() / 1000)
    const inner = buildBatteryInner(circle.id, PK_CHILD, fakeReading({ pct: 80, at }))
    const rumor: Rumor = { pubkey: PK_CHILD, created_at: at, kind: 20_078, tags: [['t', BATTERY_SIGNAL_TYPE]], content: inner.content }
    handleIncomingSignal(circle, rumor, BATTERY_SIGNAL_TYPE, fakeSender(PK_CHILD))
    expect(store.load().activity.some((e) => e.kind === 'battery-low' && e.circleId === circle.id)).toBe(false)
  })

  it('does not record a second Activity entry for a continued low reading (same episode)', () => {
    signIn(PK_GUARDIAN, toHex(generateSecretKey()))
    const circle = fakeCircle({ id: `circle-continued-${Math.random()}` })
    const at = Math.floor(Date.now() / 1000)
    const first = buildBatteryInner(circle.id, PK_CHILD, fakeReading({ pct: 12, at }))
    handleIncomingSignal(circle, { pubkey: PK_CHILD, created_at: at, kind: 20_078, tags: [['t', BATTERY_SIGNAL_TYPE]], content: first.content }, BATTERY_SIGNAL_TYPE, fakeSender(PK_CHILD))
    const second = buildBatteryInner(circle.id, PK_CHILD, fakeReading({ pct: 8, at: at + 60 }))
    handleIncomingSignal(circle, { pubkey: PK_CHILD, created_at: at + 60, kind: 20_078, tags: [['t', BATTERY_SIGNAL_TYPE]], content: second.content }, BATTERY_SIGNAL_TYPE, fakeSender(PK_CHILD))
    const lowEvents = store.load().activity.filter((e) => e.kind === 'battery-low' && e.circleId === circle.id)
    expect(lowEvents).toHaveLength(1)
  })

  it('a replayed OLDER reading (final review Minor #3) neither changes the shown state nor perturbs the low-battery episode', () => {
    signIn(PK_GUARDIAN, toHex(generateSecretKey()))
    const circle = fakeCircle({ id: `circle-replay-${Math.random()}` })
    const at = Math.floor(Date.now() / 1000)

    // First, a fresh low reading — starts the episode, fires once.
    const low = buildBatteryInner(circle.id, PK_CHILD, fakeReading({ pct: 10, at }))
    handleIncomingSignal(circle, { pubkey: PK_CHILD, created_at: at, kind: 20_078, tags: [['t', BATTERY_SIGNAL_TYPE]], content: low.content }, BATTERY_SIGNAL_TYPE, fakeSender(PK_CHILD))
    expect(batteryFor(circle.id, PK_CHILD)).toEqual({ pct: 10, charging: false, at })

    // A relay replay delivers an OLDER, healthy-looking reading out of order
    // (giftwrap `created_at` is randomized — delivery order proves nothing
    // about the inner `at`). Must not overwrite the shown state...
    const stale = buildBatteryInner(circle.id, PK_CHILD, fakeReading({ pct: 90, charging: true, at: at - 500 }))
    handleIncomingSignal(circle, { pubkey: PK_CHILD, created_at: at - 500, kind: 20_078, tags: [['t', BATTERY_SIGNAL_TYPE]], content: stale.content }, BATTERY_SIGNAL_TYPE, fakeSender(PK_CHILD))
    expect(batteryFor(circle.id, PK_CHILD)).toEqual({ pct: 10, charging: false, at })

    // ...nor rearm the episode: a genuinely fresh low reading right after
    // must NOT fire again (still the same, never-ended episode) — if the
    // stale replay had gone through `lowBatteryTransition` (charging: true,
    // pct 90 > LOW_BATTERY_RESET_PCT), it would have wrongly ended the
    // episode and let this one re-fire.
    const stillLow = buildBatteryInner(circle.id, PK_CHILD, fakeReading({ pct: 8, at: at + 60 }))
    handleIncomingSignal(circle, { pubkey: PK_CHILD, created_at: at + 60, kind: 20_078, tags: [['t', BATTERY_SIGNAL_TYPE]], content: stillLow.content }, BATTERY_SIGNAL_TYPE, fakeSender(PK_CHILD))
    const lowEvents = store.load().activity.filter((e) => e.kind === 'battery-low' && e.circleId === circle.id)
    expect(lowEvents).toHaveLength(1)
  })

  it('honours settings.batteryAlertsOff — still upserts and records Activity, but no notification (no-throw is the observable proxy here)', () => {
    sessionForTests({ identityPk: PK_GUARDIAN, phoneSkHex: toHex(generateSecretKey()) })
    store.save({ ...store.load(), settings: { batteryAlertsOff: true } })
    const circle = fakeCircle({ id: `circle-muted-${Math.random()}` })
    const at = Math.floor(Date.now() / 1000)
    const inner = buildBatteryInner(circle.id, PK_CHILD, fakeReading({ pct: 5, at }))
    const rumor: Rumor = { pubkey: PK_CHILD, created_at: at, kind: 20_078, tags: [['t', BATTERY_SIGNAL_TYPE]], content: inner.content }
    expect(() => handleIncomingSignal(circle, rumor, BATTERY_SIGNAL_TYPE, fakeSender(PK_CHILD))).not.toThrow()
    expect(batteryFor(circle.id, PK_CHILD)).toEqual({ pct: 5, charging: false, at })
    expect(store.load().activity.some((e) => e.kind === 'battery-low' && e.circleId === circle.id)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// readBattery() — clamps pct into 0-100 at construction (Task 1 review
// follow-up, Minor #1), both the web (`navigator.getBattery()`) and native
// (`@capacitor/device`) paths.
// ---------------------------------------------------------------------------

vi.mock('@capacitor/device', () => ({
  Device: { getBatteryInfo: vi.fn(async () => ({ batteryLevel: 1.4, isCharging: true })) },
}))

describe('readBattery — clamps pct into 0-100 at construction', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('web path: clamps a below-0 fractional level up to 0', async () => {
    vi.stubGlobal('navigator', { getBattery: async () => ({ level: -0.2, charging: false }) })
    expect(await readBattery()).toEqual({ pct: 0, charging: false })
  })

  it('web path: clamps an above-1 fractional level down to 100', async () => {
    vi.stubGlobal('navigator', { getBattery: async () => ({ level: 1.3, charging: true }) })
    expect(await readBattery()).toEqual({ pct: 100, charging: true })
  })

  it('native path: clamps an above-1 batteryLevel down to 100', async () => {
    vi.stubGlobal('window', { Capacitor: { isNativePlatform: () => true } })
    expect(await readBattery()).toEqual({ pct: 100, charging: true })
  })
})
