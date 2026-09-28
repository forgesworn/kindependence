import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  PIN_SIGNAL_TYPE,
  PIN_KINDS,
  PIN_KIND_LIST,
  PIN_CAP,
  isPinKind,
  pinLabel,
  buildPinSignal,
  decryptPin,
  withPin,
  applyPin,
  newPinId,
  dropPin,
  removePin,
  handleIncomingSignal,
  ensure,
  type Pin,
} from './pins.js'
import * as store from './store.js'
import * as beacons from './beacons.js'
import { makeLocalSigner, deriveInbox, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftWrap, giftUnwrap, rawNip44Decrypt } from '@forgesworn/roost-kit'
import type { Rumor } from '@forgesworn/roost-kit'
import { deriveGroupKey, encryptEnvelope } from 'canary-kit/sync'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { sessionForTests, currentSession } from './session.js'
import type { Sender } from './beacons.js'
import { registerMemberAddedHandler } from './circles.js'

// dropPin/removePin publish through beacons.ts's real wire send — mocked
// here (same idiom as meet.test.ts's own `vi.mock('./beacons.js', ...)`) so
// those tests exercise the real store-mutation/permission logic without
// touching a network.
vi.mock('./beacons.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./beacons.js')>()
  return { ...actual, publishOrEnqueue: vi.fn(async () => {}) }
})

// Fix round 2 (finding 2): pins.ts's `ensure()` wires its anti-entropy
// resend directly to circles.ts's `registerMemberAddedHandler` — mocked
// (spreading everything else real, same idiom as `./beacons.js` above) so
// the wiring test below can capture the exact function pins.ts registers
// and drive it directly, without re-deriving circles.ts's whole
// structural-authority pipeline (already covered by that module's own
// receive.test.ts coverage of `registerMemberAddedHandler` itself firing on
// a genuinely new member).
vi.mock('./circles.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./circles.js')>()
  return { ...actual, registerMemberAddedHandler: vi.fn() }
})

/** Minimal in-memory localStorage stand-in (mirrors meet.test.ts's/places.test.ts's). */
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
 *  (a distinct value only matters for the spoofed-sender tests). */
function fakeSender(phonePk: string, memberPk: string = phonePk): Sender {
  return { signerPk: phonePk, memberPk, structural: false }
}

const PK_GUARDIAN = 'a'.repeat(64)
const PK_OTHER = 'b'.repeat(64)

function fakeCircle(overrides: Partial<Circle> = {}): Circle {
  return {
    id: 'circle-1', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
    members: [
      { pk: PK_GUARDIAN, role: 'guardian', name: 'Guardian' },
      { pk: PK_OTHER, role: 'child', name: 'Kid' },
    ],
    createdAt: 100, configUpdatedAt: 100, configBy: PK_GUARDIAN,
    ...overrides,
  } as Circle
}

function fakePin(overrides: Partial<Pin> = {}): Pin {
  return {
    id: '1'.repeat(8), from: PK_GUARDIAN, kind: 'car', geohash: 'gcpvj0', precision: 9, timestamp: 100,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// Wire round trip vs. flock's EXACT pin.test.ts fixture shapes (read
// verbatim off flock origin/main app/src/pin.test.ts for this task) — same
// SEED/A/B/ID constants and same assertions, so a divergence in kind/t-tag/
// field-shape/validation-message here would fail the identical check flock
// holds itself to. Ciphertext bytes are never compared (AES-GCM is
// randomised per call on both sides — that was never what "byte-compatible"
// means here); kind, t-tag, and decrypted field SHAPE are.
// ---------------------------------------------------------------------------
describe('wire — cross-validated against flock pin.test.ts fixtures', () => {
  const SEED = '0000000000000000000000000000000000000000000000000000000000000001'
  const A = 'a'.repeat(64)
  const B = 'b'.repeat(64)
  const ID = 'deadbeefcafef00d'

  const enc = (payload: Record<string, unknown>): Promise<string> =>
    encryptEnvelope(deriveGroupKey(SEED), JSON.stringify(payload))

  it('round-trips a fixed-kind pin (flock: "round-trips a fixed-kind pin")', async () => {
    const event = await buildPinSignal({ groupId: 'g', seedHex: SEED, id: ID, from: A, kind: 'car', geohash: 'gcpvj0', precision: 9, timestamp: 42 })
    expect(event.kind).toBe(20_078)
    expect(event.tags.find((t) => t[0] === 't')?.[1]).toBe(PIN_SIGNAL_TYPE)
    expect(await decryptPin(SEED, event.content)).toEqual<Pin>({ id: ID, from: A, kind: 'car', geohash: 'gcpvj0', precision: 9, timestamp: 42 })
  })

  it('carries a removal tombstone (flock: "carries a removal tombstone")', async () => {
    const event = await buildPinSignal({ groupId: 'g', seedHex: SEED, id: ID, from: A, kind: 'picnic', geohash: 'gcpvj0', precision: 9, timestamp: 7, removed: true })
    expect((await decryptPin(SEED, event.content)).removed).toBe(true)
  })

  it('rejects an unknown kind, bad geohash, and a wrong seed (flock: same test name)', async () => {
    await expect(buildPinSignal({ groupId: 'g', seedHex: SEED, id: ID, from: A, kind: 'nope' as never, geohash: 'gcpvj0', precision: 9 })).rejects.toThrow()
    await expect(decryptPin(SEED, await enc({ id: ID, from: A, kind: 'lol', geohash: 'gcpvj0', precision: 9, timestamp: 1 }))).rejects.toThrow(/kind/i)
    await expect(decryptPin(SEED, await enc({ id: ID, from: A, kind: 'car', geohash: 'NOT A GEOHASH', precision: 9, timestamp: 1 }))).rejects.toThrow(/geohash/i)
    const ok = await buildPinSignal({ groupId: 'g', seedHex: SEED, id: ID, from: A, kind: 'car', geohash: 'gcpvj0', precision: 9 })
    await expect(decryptPin('f'.repeat(64), ok.content)).rejects.toThrow()
  })

  it('labels from the fixed vocabulary and guards the kind (flock: same test name)', () => {
    expect(pinLabel('car')).toContain('Car')
    expect(isPinKind('car')).toBe(true)
    expect(isPinKind('meet at the corner')).toBe(false)
  })

  it('every vocabulary kind is well-formed, self-guarding, and matches flock verbatim (18 kinds, distinct glyphs)', () => {
    expect(PIN_KIND_LIST).toEqual([
      'meet', 'car', 'parking', 'home', 'food', 'drink', 'coffee', 'water', 'toilet',
      'picnic', 'tent', 'view', 'shop', 'atm', 'firstaid', 'kids', 'pet', 'avoid',
    ])
    expect(PIN_KIND_LIST).toHaveLength(18)
    expect(new Set(PIN_KIND_LIST).size).toBe(PIN_KIND_LIST.length) // no dup keys
    const glyphs = new Set<string>()
    for (const k of PIN_KIND_LIST) {
      expect(isPinKind(k)).toBe(true)
      const { glyph, label } = PIN_KINDS[k]
      expect(glyph.length).toBeGreaterThan(0)
      expect(label.trim().length).toBeGreaterThan(0)
      expect(pinLabel(k)).toBe(`${glyph} ${label}`)
      glyphs.add(glyph)
    }
    expect(glyphs.size).toBe(PIN_KIND_LIST.length) // distinct glyphs
  })

  it('round-trips the newer vocabulary kinds on the wire (flock: same test name)', async () => {
    for (const kind of ['meet', 'parking', 'food', 'toilet', 'firstaid'] as const) {
      const event = await buildPinSignal({ groupId: 'g', seedHex: SEED, id: ID, from: A, kind, geohash: 'gcpvj0', precision: 9, timestamp: 42 })
      expect((await decryptPin(SEED, event.content)).kind).toBe(kind)
    }
  })

  it('merges latest-wins per id and applies tombstones (flock: same test name + assertions)', () => {
    const car: Pin = { id: '1'.repeat(8), from: A, kind: 'car', geohash: 'g', precision: 9, timestamp: 10 }
    const carMoved: Pin = { ...car, geohash: 'h', timestamp: 20 }
    const other: Pin = { id: '2'.repeat(8), from: B, kind: 'water', geohash: 'k', precision: 9, timestamp: 5 }

    let list = withPin(undefined, car)
    list = withPin(list, other)
    expect(list).toHaveLength(2)

    expect(withPin(list, carMoved).find((p) => p.id === car.id)?.geohash).toBe('h')
    expect(withPin(list, { ...car, geohash: 'x', timestamp: 1 })).toBe(list)

    const removed = withPin(list, { ...car, timestamp: 30, removed: true })
    expect(removed.find((p) => p.id === car.id)?.removed).toBe(true)
    expect(removed).toHaveLength(2)
  })

  it('a replayed drop never resurrects a removed pin (flock: same test name + assertions)', () => {
    const car: Pin = { id: '1'.repeat(8), from: A, kind: 'car', geohash: 'g', precision: 9, timestamp: 10 }
    const tomb: Pin = { ...car, timestamp: 30, removed: true }

    let list = withPin(withPin(withPin(undefined, car), tomb), car)
    expect(list.find((p) => p.id === car.id)?.removed).toBe(true)

    list = withPin(withPin(undefined, tomb), car)
    expect(list.find((p) => p.id === car.id)?.removed).toBe(true)

    const reDropped = withPin(list, { ...car, geohash: 'z', timestamp: 40 })
    expect(reDropped.find((p) => p.id === car.id)?.removed).toBeUndefined()
    expect(reDropped.find((p) => p.id === car.id)?.geohash).toBe('z')
  })

  it("another member's tombstone lands on the pin — remover !== dropper (flock: same test name + assertions)", () => {
    const car: Pin = { id: '1'.repeat(8), from: A, kind: 'car', geohash: 'g', precision: 9, timestamp: 10 }
    const list = withPin(withPin(undefined, car), { ...car, from: B, timestamp: 30, removed: true })
    const entry = list.find((p) => p.id === car.id)
    expect(entry?.removed).toBe(true)
    expect(entry?.from).toBe(B)
    expect(withPin(list, car)).toBe(list)
  })
})

describe('newPinId', () => {
  it('is an 8-byte hex handle, within flock\'s own ID_RE (8-32 lowercase hex)', () => {
    expect(newPinId()).toMatch(/^[0-9a-f]{16}$/)
  })
  it('is not constant', () => {
    expect(newPinId()).not.toBe(newPinId())
  })
})

describe('applyPin — kindependence-only cap on top of withPin (not part of flock\'s wire)', () => {
  it('behaves exactly like withPin while under the cap', () => {
    const list = applyPin(undefined, fakePin({ id: 'a'.repeat(8) }))
    expect(list).toEqual([fakePin({ id: 'a'.repeat(8) })])
  })

  it('returns the same reference for an echo/stale replay (no change)', () => {
    const list = applyPin(undefined, fakePin({ id: 'a'.repeat(8), timestamp: 100 }))
    expect(applyPin(list, fakePin({ id: 'a'.repeat(8), timestamp: 50 }))).toBe(list)
  })

  it('evicts the OLDEST live pins once the live count would exceed PIN_CAP, never a tombstone', () => {
    // A fixed `now` well past every timestamp used below — pinned explicitly
    // so this test stays independent of the wall clock (this test is about
    // the LIVE-count cap; tombstone retention has its own describe block).
    const now = PIN_CAP + 1000
    let list: Pin[] = []
    for (let i = 0; i < PIN_CAP; i++) {
      list = applyPin(list, fakePin({ id: i.toString(16).padStart(8, '0'), timestamp: i }), now)
    }
    expect(list).toHaveLength(PIN_CAP)
    // A tombstone for one of the live pins REPLACES that same-id entry (not
    // an additional array element — `withPin` merges by id), so the total
    // length is unchanged; only the LIVE count drops by one, well under the
    // cap (a tombstone doesn't grow the live count, so nothing is evicted).
    const tombId = '00000000'
    list = applyPin(list, { ...fakePin({ id: tombId }), timestamp: PIN_CAP + 1, removed: true }, now)
    expect(list).toHaveLength(PIN_CAP) // same length — a same-id replace, not a new entry
    expect(list.filter((p) => !p.removed)).toHaveLength(PIN_CAP - 1)

    // One more fresh LIVE drop pushes the live count back to PIN_CAP — no
    // eviction yet (exactly at the cap).
    list = applyPin(list, fakePin({ id: 'fresh001', timestamp: PIN_CAP + 2 }), now)
    expect(list.filter((p) => !p.removed)).toHaveLength(PIN_CAP)

    // The oldest surviving live entry — id '00000001', timestamp 1 — is next
    // in line for eviction once ONE more live pin lands over the cap. The
    // tombstone (timestamp PIN_CAP+1) is never a candidate.
    const before = list.find((p) => p.id === '00000001'.padStart(8, '0'))
    expect(before).toBeDefined()
    list = applyPin(list, fakePin({ id: 'fresh002', timestamp: PIN_CAP + 3 }), now)
    expect(list.filter((p) => !p.removed)).toHaveLength(PIN_CAP)
    expect(list.find((p) => p.id === '00000001')).toBeUndefined() // oldest live evicted
    expect(list.find((p) => p.removed)).toBeDefined() // the tombstone survives eviction
  })
})

describe('applyPin — tombstones are retained indefinitely (flock parity)', () => {
  // The 20-day age prune this block used to cover (final-review fix, Minor
  // #3) was sound while the ONLY way a retracted drop could come back was a
  // relay replaying its stored copy (~16-day retention + ~2-day smear).
  // Flock's pin anti-entropy (6bea625) broke that premise: a holder who
  // missed the removal re-sends its authored drop as a FRESH wrap on any
  // presence announce — arbitrarily later than any fixed window — and a
  // pruned tombstone would have nothing left to outrank it. Tombstones now
  // simply stay (flock's own withPin retention); growth is bounded in
  // practice by how often a circle actually removes pins.

  it('retains a tombstone well past any fixed window (400 days old)', () => {
    const now = 100_000_000
    const tomb = fakePin({ id: 'a'.repeat(8), removed: true, timestamp: now - 400 * 24 * 3600 })
    const list = applyPin([tomb], fakePin({ id: 'b'.repeat(8), timestamp: now }), now)
    expect(list.find((p) => p.id === tomb.id)?.removed).toBe(true)
  })

  it('an anti-entropy re-send of an ancient drop never resurrects its removed pin', () => {
    const now = 100_000_000
    const tomb = fakePin({ id: 'e'.repeat(8), removed: true, timestamp: now - 400 * 24 * 3600 })
    let list = applyPin([tomb], fakePin({ id: 'f'.repeat(8), timestamp: now }), now)
    // A flock holder that missed the removal re-broadcasts the ORIGINAL drop
    // (original pin timestamp, fresh wrap) on a presence announce.
    const resentDrop: Pin = {
      id: tomb.id, from: tomb.from, kind: tomb.kind, geohash: tomb.geohash, precision: tomb.precision,
      timestamp: tomb.timestamp - 100,
    }
    list = applyPin(list, resentDrop, now)
    expect(list.find((p) => p.id === tomb.id)?.removed).toBe(true) // still removed
  })
})

describe('buildPinSignal + giftWrap round trip — kindependence\'s own transport over flock\'s inner wire', () => {
  it('round-trips a drop through the real gift-wrap send/receive path', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const pin = fakePin({ from: signer.pubkey })
    const inner = await buildPinSignal({ groupId: circle.id, seedHex: circle.seedHex, ...pin })
    const inbox = deriveInbox(circle.seedHex)
    const wrap = await giftWrap(signer, inbox.pk, inner, inbox.pk)
    expect(wrap.kind).toBe(1059) // outer NIP-59 gift wrap

    const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), wrap)
    expect(rumor).not.toBeNull()
    const decoded = await decryptPin(circle.seedHex, (rumor as Rumor).content)
    expect(decoded).toEqual(pin)
    expect((rumor as Rumor).pubkey).toBe(pin.from) // the seal signer IS the dropper — sender-auth's precondition
  })
})

describe('handleIncomingSignal — sender-auth (T1 class) + store apply', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const circle = fakeCircle()

  async function signalRumor(pubkey: string, pin: Pin): Promise<Rumor> {
    const inner = await buildPinSignal({ groupId: circle.id, seedHex: circle.seedHex, ...pin })
    return {
      id: `rumor-${pin.id}-${pin.timestamp}`,
      pubkey,
      kind: inner.kind,
      content: inner.content,
      tags: inner.tags,
      created_at: inner.created_at,
    }
  }

  it('applies a well-formed drop whose from matches the authenticated sender', async () => {
    const pin = fakePin({ from: PK_OTHER })
    await handleIncomingSignal(circle, await signalRumor(PK_OTHER, pin), PIN_SIGNAL_TYPE, fakeSender(PK_OTHER))
    expect(store.load().pins[circle.id]).toEqual([pin])
  })

  it('records a pin-dropped Activity entry for a genuinely new incoming drop', async () => {
    const pin = fakePin({ from: PK_OTHER, id: 'aaaaaaaa' })
    await handleIncomingSignal(circle, await signalRumor(PK_OTHER, pin), PIN_SIGNAL_TYPE, fakeSender(PK_OTHER))
    const evt = store.load().activity.find((e) => e.kind === 'pin-dropped' && e.circleId === circle.id)
    expect(evt).toBeDefined()
    expect(evt?.actorPk).toBe(PK_OTHER)
    expect(evt?.params.kind).toBe('car')
  })

  it('records a pin-removed Activity entry for a genuinely new incoming tombstone', async () => {
    const pin = fakePin({ from: PK_OTHER, id: 'bbbbbbbb' })
    await handleIncomingSignal(circle, await signalRumor(PK_OTHER, pin), PIN_SIGNAL_TYPE, fakeSender(PK_OTHER))
    expect(store.load().pins[circle.id]).toEqual([pin])
    const tomb: Pin = { ...pin, from: PK_GUARDIAN, timestamp: pin.timestamp + 1, removed: true }
    await handleIncomingSignal(circle, await signalRumor(PK_GUARDIAN, tomb), PIN_SIGNAL_TYPE, fakeSender(PK_GUARDIAN))
    const evt = store.load().activity.find((e) => e.kind === 'pin-removed' && e.circleId === circle.id)
    expect(evt).toBeDefined()
    expect(evt?.actorPk).toBe(PK_GUARDIAN) // the REMOVER, not the original dropper
  })

  it('rejects a forged drop whose from does not match the authenticated sender (T1 sender-auth)', async () => {
    // Validly wrapped/sealed by PK_OTHER (the real, authenticated sender),
    // but the pin content's own `from` dishonestly claims PK_GUARDIAN —
    // dropping "as" someone else.
    const pin = fakePin({ from: PK_GUARDIAN })
    // Final-review fix, Minor #5: awaits the real applyIncomingPin promise
    // directly (handleIncomingSignal now returns it) instead of racing a
    // fixed-delay flush() against the WebCrypto decrypt inside it — the
    // reviewer's diagnosed cross-test async leak (under load, a one-tick
    // flush() could resolve before that decrypt finishes, letting the
    // eventual apply land after a LATER test's localStorage stub swap).
    await handleIncomingSignal(circle, await signalRumor(PK_OTHER, pin), PIN_SIGNAL_TYPE, fakeSender(PK_OTHER))
    expect(store.load().pins[circle.id]).toBeUndefined()
    expect(store.load().activity.find((e) => e.kind === 'pin-dropped')).toBeUndefined()
  })

  it('rejects a forged tombstone whose from does not match the authenticated sender (removing "as" someone else)', async () => {
    const pin = fakePin({ from: PK_OTHER, id: 'cccccccc' })
    await handleIncomingSignal(circle, await signalRumor(PK_OTHER, pin), PIN_SIGNAL_TYPE, fakeSender(PK_OTHER))
    expect(store.load().pins[circle.id]).toEqual([pin])
    // PK_GUARDIAN's wrap (the real, authenticated sender) but the tombstone
    // content dishonestly claims from: PK_OTHER — removing "as" the original
    // dropper instead of signing it as the actual remover.
    const forgedTomb: Pin = { ...pin, timestamp: pin.timestamp + 1, removed: true } // from left as PK_OTHER
    await handleIncomingSignal(circle, await signalRumor(PK_GUARDIAN, forgedTomb), PIN_SIGNAL_TYPE, fakeSender(PK_GUARDIAN))
    expect(store.load().pins[circle.id]).toEqual([pin]) // unchanged — still live, not removed
  })

  it('ignores its own echo (rumor.pubkey === this device\'s identity)', async () => {
    const { pkHex, skHex } = realKeypair()
    const myPhonePk = signIn(pkHex, skHex)
    const pin = fakePin({ from: myPhonePk, id: 'dddddddd' })
    await handleIncomingSignal(circle, await signalRumor(myPhonePk, pin), PIN_SIGNAL_TYPE, fakeSender(myPhonePk))
    expect(store.load().pins[circle.id]).toBeUndefined()
  })

  it('ignores a signal with a different t', async () => {
    const pin = fakePin({ from: PK_OTHER })
    await handleIncomingSignal(circle, await signalRumor(PK_OTHER, pin), 'kindependence-meet', fakeSender(PK_OTHER))
    expect(store.load().pins[circle.id]).toBeUndefined()
  })

  it('never double-records Activity for a duplicate/replayed drop', async () => {
    const pin = fakePin({ from: PK_OTHER, id: 'eeeeeeee' })
    const rumor = await signalRumor(PK_OTHER, pin)
    await handleIncomingSignal(circle, rumor, PIN_SIGNAL_TYPE, fakeSender(PK_OTHER))
    expect(store.load().pins[circle.id]).toEqual([pin])
    const countAfterFirst = store.load().activity.filter((e) => e.kind === 'pin-dropped').length
    // Same rumor, replayed (a relay re-delivering stored history).
    await handleIncomingSignal(circle, rumor, PIN_SIGNAL_TYPE, fakeSender(PK_OTHER))
    expect(store.load().activity.filter((e) => e.kind === 'pin-dropped')).toHaveLength(countAfterFirst)
  })
})

describe('dropPin / removePin — outbound, tombstone matrix', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function setup(role: 'parent' | 'child', pk: string, sk: string): Circle {
    const circle = fakeCircle()
    signIn(pk, sk)
    void role // role no longer read by dropPin/removePin — kept for call-site clarity
    store.update((p) => {
      p.circles = [circle]
    })
    return circle
  }

  it('drops a pin, persists it, and records a pin-dropped Activity entry', async () => {
    const { pkHex, skHex } = realKeypair()
    const circle = setup('parent', pkHex, skHex)
    await dropPin(circle.id, 'water', { lat: 51.5, lon: -0.1 })
    const p = store.load()
    expect(p.pins[circle.id]).toHaveLength(1)
    expect(p.pins[circle.id]?.[0]?.kind).toBe('water')
    expect(p.pins[circle.id]?.[0]?.from).toBe(pkHex)
    expect(p.pins[circle.id]?.[0]?.precision).toBe(9)
    const evt = p.activity.find((e) => e.kind === 'pin-dropped')
    expect(evt?.params.kind).toBe('water')
    expect(evt?.actorPk).toBe(pkHex)
  })

  it('review queue item 2: two drops in the same circle within the same wall-clock second both record a distinct pin-dropped Activity entry (same-second id collision)', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2024, 0, 1, 9, 0, 0))
      const { pkHex, skHex } = realKeypair()
      const circle = setup('parent', pkHex, skHex)
      await dropPin(circle.id, 'water', { lat: 51.5, lon: -0.1 })
      await dropPin(circle.id, 'car', { lat: 51.6, lon: -0.2 }) // same second — would collide on the bare local-pin-dropped-<at>-<circleId> id
      const drops = store.load().activity.filter((e) => e.kind === 'pin-dropped' && e.circleId === circle.id)
      expect(drops).toHaveLength(2) // pre-fix: recordActivity's dedupe silently ate the second one
      expect(new Set(drops.map((e) => e.id)).size).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to exceed PIN_CAP (counting only LIVE pins)', async () => {
    const { pkHex, skHex } = realKeypair()
    const circle = setup('parent', pkHex, skHex)
    for (let i = 0; i < PIN_CAP; i++) {
      await dropPin(circle.id, 'car', { lat: 0, lon: 0 })
    }
    await dropPin(circle.id, 'car', { lat: 0, lon: 0 }) // overflow — silently no-ops
    expect(store.load().pins[circle.id]).toHaveLength(PIN_CAP)
  })

  it('lets ANY member remove a pin they did not drop (remove-by-anyone, flock d569b17)', async () => {
    // PK_OTHER (a 'child' member, not the dropper) removes the guardian's pin.
    const circle = fakeCircle()
    const { skHex } = realKeypair()
    signIn(PK_OTHER, skHex)
    store.update((p) => {
      p.circles = [circle]
      p.pins = { [circle.id]: [fakePin({ id: 'facade00', from: PK_GUARDIAN })] }
    })
    await removePin(circle.id, 'facade00')
    const entry = store.load().pins[circle.id]?.find((x) => x.id === 'facade00')
    expect(entry?.removed).toBe(true)
    expect(entry?.from).toBe(PK_OTHER) // the tombstone is signed as the REMOVER, not the original dropper
    const evt = store.load().activity.find((e) => e.kind === 'pin-removed')
    expect(evt?.actorPk).toBe(PK_OTHER)
  })

  it('drop (by another member) -> remove (by this device) -> a REPLAYED drop stays removed (tombstone matrix, via the real receive path)', async () => {
    // A cross-device scenario, not a self-echo: PK_OTHER drops a pin
    // (arrives here over the wire), this device (PK_GUARDIAN, remove-by-
    // anyone) removes it, then a relay replays PK_OTHER's ORIGINAL drop —
    // that must never resurrect it. A self-dropped-then-replayed pin would
    // instead hit `handleIncomingSignal`'s own-echo guard before ever
    // reaching the merge logic, which isn't the scenario worth proving here.
    const circle = fakeCircle()
    const { skHex } = realKeypair()
    signIn(PK_GUARDIAN, skHex)
    store.update((p) => {
      p.circles = [circle]
    })
    const originalDrop = fakePin({ id: 'deadbeef1', from: PK_OTHER, kind: 'toilet', timestamp: 1000 })
    const dropInner = await buildPinSignal({ groupId: circle.id, seedHex: circle.seedHex, ...originalDrop })
    const dropRumor: Rumor = { id: 'wrap-drop', pubkey: PK_OTHER, kind: dropInner.kind, content: dropInner.content, tags: dropInner.tags, created_at: dropInner.created_at }
    await handleIncomingSignal(circle, dropRumor, PIN_SIGNAL_TYPE, fakeSender(PK_OTHER))
    expect(store.load().pins[circle.id]).toEqual([originalDrop])

    await removePin(circle.id, 'deadbeef1')
    expect(store.load().pins[circle.id]?.find((p) => p.id === 'deadbeef1')?.removed).toBe(true)
    expect(store.load().pins[circle.id]?.find((p) => p.id === 'deadbeef1')?.from).toBe(PK_GUARDIAN) // remover, not dropper

    // The relay now replays PK_OTHER's ORIGINAL (older, pre-removal) drop wrap.
    await handleIncomingSignal(circle, dropRumor, PIN_SIGNAL_TYPE, fakeSender(PK_OTHER))
    const entry = store.load().pins[circle.id]?.find((p) => p.id === 'deadbeef1')
    expect(entry?.removed).toBe(true) // still removed — the replay never resurrected it
    expect(entry?.from).toBe(PK_GUARDIAN) // still attributed to the remover
    // No spurious pin-dropped Activity entry from the replay (the merge is
    // a no-op — `landPin` reports unchanged, so nothing new is recorded).
    expect(store.load().activity.filter((e) => e.kind === 'pin-dropped' && e.circleId === circle.id)).toHaveLength(1)
  })

  it('a no-op remove of an already-removed pin does not double-publish or double-record', async () => {
    const { pkHex, skHex } = realKeypair()
    const circle = setup('parent', pkHex, skHex)
    await dropPin(circle.id, 'atm', { lat: 0, lon: 0 })
    const id = store.load().pins[circle.id]?.[0]?.id as string
    await removePin(circle.id, id)
    const countAfterFirst = store.load().activity.filter((e) => e.kind === 'pin-removed').length
    await removePin(circle.id, id) // already removed — silent no-op
    expect(store.load().activity.filter((e) => e.kind === 'pin-removed')).toHaveLength(countAfterFirst)
  })

  it('does nothing without a signed-in identity', async () => {
    await dropPin('circle-1', 'car', { lat: 0, lon: 0 })
    expect(store.load().pins['circle-1']).toBeUndefined()
  })
})


// Flock 6bea625 parity — pin durability anti-entropy: re-send the pins THIS
// device authored (plus its authored tombstones, so deletions propagate)
// when the circle gains a member, keeping each pin's own timestamp (withPin
// is latest-wins, so re-sends are idempotent), debounced per circle. `from`
// is bound to the seal signer on receipt, so each pin has exactly one
// legitimate re-sender and the set partitions across members with no
// duplication. Without this, a flock member who joins or returns after a
// kindependence-authored drop — or a kindependence member joining after
// relay retention expired — never sees it.
//
// Fix round 2 (finding 2): the trigger used to be an unauthenticated
// `t:'joined'` self-announce, decoded and sender-bound right inside
// `handleIncomingSignal` — that whole mechanism is gone along with flock's
// announce (see circles.ts's own "Roster healing" doc comment). The
// production trigger is now `ensure()` registering the resend directly with
// circles.ts's `registerMemberAddedHandler` (mocked above), fired only
// after a structural config's authority is already verified — see
// receive.test.ts's own "fires registerMemberAddedHandler..." coverage for
// that half. This block covers pins.ts's own half: that `ensure()` actually
// performs the registration, and that the registered function is
// `resendAuthoredPins` behaving exactly as it always has.
describe('pins.ts wiring — resendAuthoredPins fires on a genuine roster addition (fix round 2, finding 2)', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(beacons.publishOrEnqueue).mockClear()
  })
  afterEach(() => vi.unstubAllGlobals())

  /** `ensure()` is idempotent (module-level `registered` guard) — calling it
   *  from every test in this block is harmless; only the FIRST call ever
   *  actually registers, so the handler is always `mock.calls[0][0]`. */
  function registeredResendHandler(): (circle: Circle, memberPk: string) => Promise<void> | void {
    ensure()
    expect(registerMemberAddedHandler).toHaveBeenCalledTimes(1)
    return vi.mocked(registerMemberAddedHandler).mock.calls[0]![0]
  }

  async function decryptPublishedPins(circle: Circle): Promise<Pin[]> {
    const inbox = deriveInbox(circle.seedHex)
    const out: Pin[] = []
    for (const call of vi.mocked(beacons.publishOrEnqueue).mock.calls) {
      const wrap = call[1] as { pubkey: string; content: string; tags: string[][] }
      const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), wrap)
      if (!rumor) continue
      out.push(await decryptPin(circle.seedHex, rumor.content))
    }
    return out
  }

  it("ensure() registers exactly one handler with circles.ts's registerMemberAddedHandler", () => {
    registeredResendHandler()
  })

  it("re-sends authored pins and authored tombstones with their ORIGINAL timestamps — never someone else's — when the handler fires for a new member", async () => {
    const handler = registeredResendHandler()
    const self = realKeypair()
    const newMember = realKeypair()
    const circle = fakeCircle({ id: 'ae-circle-1', seedHex: '4'.repeat(64) })
    const minePin = fakePin({ id: 'a1'.repeat(4), from: self.pkHex, timestamp: 1_000 })
    const mineTomb = fakePin({ id: 'b2'.repeat(4), from: self.pkHex, timestamp: 2_001, removed: true })
    const theirs = fakePin({ id: 'c3'.repeat(4), from: PK_OTHER, timestamp: 1_500 })
    signIn(self.pkHex, self.skHex)
    store.update((p) => {
      p.circles = [circle]
      p.pins = { 'ae-circle-1': [minePin, mineTomb, theirs] }
    })

    await handler(circle, newMember.pkHex)

    const resent = await decryptPublishedPins(circle)
    expect(resent).toHaveLength(2)
    const ids = resent.map((r) => r.id).sort()
    expect(ids).toEqual([minePin.id, mineTomb.id].sort())
    expect(resent.find((r) => r.id === minePin.id)?.timestamp).toBe(1_000) // original ts — latest-wins stays idempotent
    expect(resent.find((r) => r.id === mineTomb.id)?.removed).toBe(true) // deletions propagate
  })

  it('debounces per circle — a second addition right after re-sends nothing new', async () => {
    const handler = registeredResendHandler()
    const self = realKeypair()
    const newMember = realKeypair()
    const circle = fakeCircle({ id: 'ae-circle-2', seedHex: '5'.repeat(64) })
    signIn(self.pkHex, self.skHex)
    store.update((p) => {
      p.circles = [circle]
      p.pins = { 'ae-circle-2': [fakePin({ id: 'd4'.repeat(4), from: self.pkHex, timestamp: 1_000 })] }
    })

    await handler(circle, newMember.pkHex)
    await handler(circle, newMember.pkHex)

    expect(beacons.publishOrEnqueue).toHaveBeenCalledTimes(1)
  })

  it('no-ops when this device has authored no pins in that circle', async () => {
    const handler = registeredResendHandler()
    const self = realKeypair()
    const newMember = realKeypair()
    const circle = fakeCircle({ id: 'ae-circle-3', seedHex: '6'.repeat(64) })
    signIn(self.pkHex, self.skHex)
    store.update((p) => {
      p.circles = [circle]
      p.pins = { 'ae-circle-3': [fakePin({ id: 'e5'.repeat(4), from: PK_OTHER, timestamp: 1_000 })] }
    })

    await handler(circle, newMember.pkHex)

    expect(beacons.publishOrEnqueue).not.toHaveBeenCalled()
  })
})
