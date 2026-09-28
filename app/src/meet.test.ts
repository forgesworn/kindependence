import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  MEET_SIGNAL_TYPE,
  MAX_MEET_POINTS,
  MAX_MEET_NAME_LEN,
  MEET_EXPIRY_CHOICES,
  newMeetId,
  computeExpiresAt,
  liveMeetPoints,
  buildMeetWrap,
  parseMeetSignal,
  addMeetPoint,
  deleteMeetPoint,
  handleIncomingSignal,
  tick,
  type MeetPoint,
} from './meet.js'
import * as store from './store.js'
import { makeLocalSigner, deriveInbox, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftUnwrap, rawNip44Decrypt } from '@forgesworn/roost-kit'
import type { Rumor } from '@forgesworn/roost-kit'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { sessionForTests, currentSession } from './session.js'
import type { Sender } from './beacons.js'
import { PLACES_SIGNAL_TYPE } from './places.js'

// addMeetPoint/deleteMeetPoint publish through beacons.ts's real wire send —
// mocked here (same idiom as places.test.ts's own `vi.mock('./beacons.js', ...)`)
// so those tests exercise the real store-mutation/permission logic without
// touching a network.
vi.mock('./beacons.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./beacons.js')>()
  return { ...actual, publishOrEnqueue: vi.fn(async () => {}) }
})

/** Minimal in-memory localStorage stand-in (mirrors places.test.ts's). */
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
 *  `phonePk` the sealing phone key, `memberPk` the identity it resolves to. */
function fakeSender(phonePk: string, memberPk: string = phonePk): Sender {
  return { signerPk: phonePk, memberPk, structural: false }
}

const PK_GUARDIAN = 'a'.repeat(64)
const PK_OTHER = 'b'.repeat(64)

/** A real "far in the future relative to actual wall-clock now" expiry —
 *  `addMeetPoint` computes `at = nowSec()` from the REAL clock internally
 *  (not an injected one), so a fixture expiry must be relative to that, not
 *  a small absolute epoch value (which `liveMeetPoints` would treat as
 *  already-expired against a real 2020s+ `Date.now()`). */
const FAR_FUTURE = Math.floor(Date.now() / 1000) + 100_000

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

function fakeMeetPoint(overrides: Partial<MeetPoint> = {}): MeetPoint {
  return {
    id: 'meet-1', name: 'Park gate', centre: { lat: 51.5, lon: -0.1 },
    expiresAt: 5000, createdBy: PK_GUARDIAN, createdAt: 4000,
    ...overrides,
  }
}

describe('newMeetId', () => {
  it('is an 8-byte hex handle', () => {
    expect(newMeetId()).toMatch(/^[0-9a-f]{16}$/)
  })
  it('is not constant', () => {
    expect(newMeetId()).not.toBe(newMeetId())
  })
})

describe('MAX_MEET_POINTS / MAX_MEET_NAME_LEN — task-contract defaults', () => {
  it('caps at 10 points', () => { expect(MAX_MEET_POINTS).toBe(10) })
  it('caps names at 40 chars', () => { expect(MAX_MEET_NAME_LEN).toBe(40) })
})

describe('MEET_EXPIRY_CHOICES / computeExpiresAt', () => {
  it('offers exactly the four task-contract choices', () => {
    expect(MEET_EXPIRY_CHOICES.map((c) => c.id)).toEqual(['1h', '3h', 'today-22', '24h'])
  })

  it('1h/3h/24h are plain offsets from now', () => {
    const now = 1_000_000
    expect(computeExpiresAt('1h', now)).toBe(now + 3600)
    expect(computeExpiresAt('3h', now)).toBe(now + 3 * 3600)
    expect(computeExpiresAt('24h', now)).toBe(now + 24 * 3600)
  })

  it("today-22 resolves to 22:00 local time on the same day when that's still ahead", () => {
    const now = new Date(2026, 0, 15, 10, 0, 0) // 15 Jan 2026, 10:00 local
    const nowSec = Math.floor(now.getTime() / 1000)
    const expected = new Date(2026, 0, 15, 22, 0, 0, 0)
    expect(computeExpiresAt('today-22', nowSec)).toBe(Math.floor(expected.getTime() / 1000))
  })

  it('today-22 rolls to tomorrow 22:00 when already past 22:00 today', () => {
    const now = new Date(2026, 0, 15, 23, 30, 0) // 15 Jan 2026, 23:30 local
    const nowSec = Math.floor(now.getTime() / 1000)
    const expected = new Date(2026, 0, 16, 22, 0, 0, 0)
    expect(computeExpiresAt('today-22', nowSec)).toBe(Math.floor(expected.getTime() / 1000))
  })
})

describe('liveMeetPoints — pure expiry filter', () => {
  it('keeps only points whose expiresAt is strictly after now', () => {
    const points = [
      fakeMeetPoint({ id: 'expired', expiresAt: 999 }),
      fakeMeetPoint({ id: 'boundary', expiresAt: 1000 }),
      fakeMeetPoint({ id: 'live', expiresAt: 1001 }),
    ]
    expect(liveMeetPoints(points, 1000).map((p) => p.id)).toEqual(['live'])
  })

  it('is empty for an empty input', () => {
    expect(liveMeetPoints([], 1000)).toEqual([])
  })
})

describe('wire round trip — buildMeetWrap + parseMeetSignal', () => {
  it('round-trips the full point set through gift-wrap', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const points: MeetPoint[] = [
      fakeMeetPoint({ id: 'p1', name: 'Park gate' }),
      fakeMeetPoint({ id: 'p2', name: 'Library steps', expiresAt: 6000 }),
    ]
    const wrap = await buildMeetWrap(signer, circle, points, 5000, PK_GUARDIAN)
    expect(wrap.kind).toBe(1059) // outer NIP-59 gift wrap

    const inbox = deriveInbox(circle.seedHex)
    const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), wrap)
    expect(rumor).not.toBeNull()
    const decoded = parseMeetSignal((rumor as Rumor).content, circle.id)
    expect(decoded).toEqual({ points, updatedAt: 5000, by: PK_GUARDIAN })
  })
})

describe('parseMeetSignal — strict validation, malformed rejected wholesale', () => {
  const good = JSON.stringify({ t: MEET_SIGNAL_TYPE, circleId: 'circle-1', points: [fakeMeetPoint()], updatedAt: 100, by: PK_GUARDIAN })

  it('accepts a well-formed signal', () => {
    expect(parseMeetSignal(good, 'circle-1')).not.toBeNull()
  })

  it('rejects invalid JSON', () => {
    expect(parseMeetSignal('{not json', 'circle-1')).toBeNull()
  })

  it('rejects the wrong `t` (a real neighbouring wire type, not just gibberish — places.ts’s own structural action, Task 9’s renamed wire value)', () => {
    const bad = JSON.stringify({ t: PLACES_SIGNAL_TYPE, circleId: 'circle-1', points: [], updatedAt: 100, by: PK_GUARDIAN })
    expect(parseMeetSignal(bad, 'circle-1')).toBeNull()
  })

  it('rejects a mismatched circleId', () => {
    expect(parseMeetSignal(good, 'circle-other')).toBeNull()
  })

  it('rejects a point missing expiresAt', () => {
    const { expiresAt: _drop, ...noExpiry } = fakeMeetPoint()
    const bad = JSON.stringify({ t: MEET_SIGNAL_TYPE, circleId: 'circle-1', points: [noExpiry], updatedAt: 100, by: PK_GUARDIAN })
    expect(parseMeetSignal(bad, 'circle-1')).toBeNull()
  })

  it('rejects a non-numeric expiresAt', () => {
    const bad = JSON.stringify({ t: MEET_SIGNAL_TYPE, circleId: 'circle-1', points: [{ ...fakeMeetPoint(), expiresAt: 'soon' }], updatedAt: 100, by: PK_GUARDIAN })
    expect(parseMeetSignal(bad, 'circle-1')).toBeNull()
  })

  it('rejects an oversized points array (> MAX_MEET_POINTS)', () => {
    const many = Array.from({ length: MAX_MEET_POINTS + 1 }, (_, i) => fakeMeetPoint({ id: `p${i}` }))
    const bad = JSON.stringify({ t: MEET_SIGNAL_TYPE, circleId: 'circle-1', points: many, updatedAt: 100, by: PK_GUARDIAN })
    expect(parseMeetSignal(bad, 'circle-1')).toBeNull()
  })

  it('rejects the whole set when ONE point is malformed (never partially applies)', () => {
    const bad = JSON.stringify({
      t: MEET_SIGNAL_TYPE, circleId: 'circle-1',
      points: [fakeMeetPoint({ id: 'ok' }), { id: 'bad' /* missing everything else */ }],
      updatedAt: 100, by: PK_GUARDIAN,
    })
    expect(parseMeetSignal(bad, 'circle-1')).toBeNull()
  })

  it('caps (truncates, not rejects) an over-length name — same discipline as places.ts', () => {
    const longName = 'x'.repeat(MAX_MEET_NAME_LEN + 20)
    const withLongName = JSON.stringify({ t: MEET_SIGNAL_TYPE, circleId: 'circle-1', points: [{ ...fakeMeetPoint(), name: longName }], updatedAt: 100, by: PK_GUARDIAN })
    const decoded = parseMeetSignal(withLongName, 'circle-1')
    expect(decoded).not.toBeNull()
    expect(decoded?.points[0]?.name.length).toBe(MAX_MEET_NAME_LEN)
  })
})

describe('latest-wins apply — handleIncomingSignal', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const circle = fakeCircle()

  function signalRumor(pubkey: string, points: MeetPoint[], updatedAt: number, by: string): Rumor {
    return {
      id: `rumor-${updatedAt}-${by}`,
      pubkey,
      kind: 20078,
      content: JSON.stringify({ t: MEET_SIGNAL_TYPE, circleId: circle.id, points, updatedAt, by }),
      tags: [['t', MEET_SIGNAL_TYPE]],
      created_at: updatedAt,
    } as unknown as Rumor
  }

  it('applies the first signal seen (no prior meta)', () => {
    // createdBy: PK_OTHER, matching the sender — the common case, still
    // accepted (a point new to this device no longer REQUIRES this match,
    // see the sender-auth describe block below, but of course still allows
    // it).
    const points = [fakeMeetPoint({ id: 'p1', createdBy: PK_OTHER })]
    handleIncomingSignal(circle, signalRumor(PK_OTHER, points, 5000, PK_OTHER), MEET_SIGNAL_TYPE, fakeSender(PK_OTHER))
    const p = store.load()
    expect(p.meetPoints[circle.id]).toEqual(points)
    expect(p.meetMeta[circle.id]).toEqual({ updatedAt: 5000, by: PK_OTHER })
  })

  it('ignores an OLDER incoming set (latest-wins)', () => {
    const newer = [fakeMeetPoint({ id: 'newer', createdBy: PK_OTHER })]
    handleIncomingSignal(circle, signalRumor(PK_OTHER, newer, 5000, PK_OTHER), MEET_SIGNAL_TYPE, fakeSender(PK_OTHER))
    const older = [fakeMeetPoint({ id: 'older', createdBy: PK_OTHER })]
    handleIncomingSignal(circle, signalRumor(PK_OTHER, older, 4000, PK_OTHER), MEET_SIGNAL_TYPE, fakeSender(PK_OTHER))
    const p = store.load()
    expect(p.meetPoints[circle.id]).toEqual(newer)
    expect(p.meetMeta[circle.id]).toEqual({ updatedAt: 5000, by: PK_OTHER })
  })

  it('applies a genuinely NEWER incoming set over an older one', () => {
    const older = [fakeMeetPoint({ id: 'older', createdBy: PK_OTHER })]
    handleIncomingSignal(circle, signalRumor(PK_OTHER, older, 4000, PK_OTHER), MEET_SIGNAL_TYPE, fakeSender(PK_OTHER))
    const newer = [fakeMeetPoint({ id: 'newer', createdBy: PK_OTHER })]
    handleIncomingSignal(circle, signalRumor(PK_OTHER, newer, 5000, PK_OTHER), MEET_SIGNAL_TYPE, fakeSender(PK_OTHER))
    const p = store.load()
    expect(p.meetPoints[circle.id]).toEqual(newer)
    expect(p.meetMeta[circle.id]).toEqual({ updatedAt: 5000, by: PK_OTHER })
  })

  it('drops its own echo (rumor.pubkey === this device\'s identity)', () => {
    const { pkHex, skHex } = realKeypair()
    const myPhonePk = signIn(pkHex, skHex)
    const points = [fakeMeetPoint({ id: 'self-echo' })]
    handleIncomingSignal(circle, signalRumor(myPhonePk, points, 9999, pkHex), MEET_SIGNAL_TYPE, fakeSender(myPhonePk, pkHex))
    const p = store.load()
    expect(p.meetPoints[circle.id]).toBeUndefined()
  })

  it('ignores a signal with a different `t` (places.ts’s own wire type — Task 9’s renamed value)', () => {
    const rumor = signalRumor(PK_OTHER, [fakeMeetPoint()], 5000, PK_OTHER)
    handleIncomingSignal(circle, rumor, PLACES_SIGNAL_TYPE, fakeSender(PK_OTHER))
    expect(store.load().meetPoints[circle.id]).toBeUndefined()
  })

  describe('sender-auth binding (ffb48b9 class) — forgery rejection', () => {
    it('drops a signal whose meta `by` names someone other than the actual sender', () => {
      // Validly "wrapped" (rumor.pubkey === PK_OTHER, the real sender) but
      // the content's own `by` field dishonestly claims PK_GUARDIAN.
      const points = [fakeMeetPoint({ id: 'forged-by', createdBy: PK_OTHER })]
      handleIncomingSignal(circle, signalRumor(PK_OTHER, points, 5000, PK_GUARDIAN), MEET_SIGNAL_TYPE, fakeSender(PK_OTHER))
      const p = store.load()
      expect(p.meetPoints[circle.id]).toBeUndefined()
      expect(p.meetMeta[circle.id]).toBeUndefined()
    })

    it('applies a signal carrying a point new to this device whose createdBy names someone other than the actual sender (late-joiner carry-forward)', () => {
      // rumor.pubkey === PK_OTHER (the real, authenticated sender) and `by`
      // matches it (so the meta-level check above still applies) — but the
      // POINT ITSELF claims PK_GUARDIAN created it, and this device has
      // never seen it before (e.g. a late joiner, or any device that missed
      // PK_GUARDIAN's original signal). Review loosening (Phase 7 Task 1 fix
      // wave): full-set carry-forward means any member may legitimately
      // relay a point another member created — a point new to THIS DEVICE
      // is no longer required to be self-attributed by the CURRENT sender,
      // only an already-known point's attribution is immutable (see the next
      // test). This is exactly the "two-author set from one member" late-
      // joiner shape the review asked to unblock.
      const points = [
        fakeMeetPoint({ id: 'guardian-made', createdBy: PK_GUARDIAN }),
        fakeMeetPoint({ id: 'other-made', createdBy: PK_OTHER }),
      ]
      handleIncomingSignal(circle, signalRumor(PK_OTHER, points, 5000, PK_OTHER), MEET_SIGNAL_TYPE, fakeSender(PK_OTHER))
      const p = store.load()
      expect(p.meetPoints[circle.id]).toEqual(points)
      expect(p.meetMeta[circle.id]).toEqual({ updatedAt: 5000, by: PK_OTHER })
    })

    it('drops an update that retroactively reattributes an ALREADY-KNOWN point to a different creator', () => {
      // First, a genuine introduction: PK_OTHER creates 'p1', correctly
      // self-attributed.
      const original = [fakeMeetPoint({ id: 'p1', createdBy: PK_OTHER })]
      handleIncomingSignal(circle, signalRumor(PK_OTHER, original, 5000, PK_OTHER), MEET_SIGNAL_TYPE, fakeSender(PK_OTHER))
      expect(store.load().meetPoints[circle.id]).toEqual(original)

      // A later, genuinely newer update carries 'p1' forward but now claims
      // PK_GUARDIAN created it — an attempt to rewrite already-trusted
      // authorship history. Dropped wholesale; the prior trusted state is
      // untouched.
      const rewritten = [fakeMeetPoint({ id: 'p1', createdBy: PK_GUARDIAN })]
      handleIncomingSignal(circle, signalRumor(PK_OTHER, rewritten, 6000, PK_OTHER), MEET_SIGNAL_TYPE, fakeSender(PK_OTHER))
      const p = store.load()
      expect(p.meetPoints[circle.id]).toEqual(original)
      expect(p.meetMeta[circle.id]).toEqual({ updatedAt: 5000, by: PK_OTHER })
    })
  })
})

describe('addMeetPoint / deleteMeetPoint', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function setup(role: 'parent' | 'child', pk: string, sk: string): Circle {
    const circle = fakeCircle()
    signIn(pk, sk)
    void role // role no longer read by addMeetPoint/deleteMeetPoint — kept for call-site clarity
    store.update((p) => {
      p.circles = [circle]
    })
    return circle
  }

  it('adds a point, persists it, and records a create Activity entry', async () => {
    const { pkHex, skHex } = realKeypair()
    const circle = setup('parent', pkHex, skHex)
    await addMeetPoint(circle.id, { name: 'Park gate', centre: { lat: 1, lon: 2 }, expiresAt: FAR_FUTURE })
    const p = store.load()
    expect(p.meetPoints[circle.id]).toHaveLength(1)
    expect(p.meetPoints[circle.id]?.[0]?.name).toBe('Park gate')
    expect(p.meetPoints[circle.id]?.[0]?.createdBy).toBe(pkHex)
    const evt = p.activity.find((e) => e.kind === 'meet-point' && e.params.action === 'created')
    expect(evt?.params.name).toBe('Park gate')
  })

  it('review queue item 2 (inherited from pins.ts\'s dropPin gap): two points created in the same circle within the same wall-clock second both record a distinct create Activity entry', async () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(new Date(2024, 0, 1, 9, 0, 0))
      const { pkHex, skHex } = realKeypair()
      const circle = setup('parent', pkHex, skHex)
      await addMeetPoint(circle.id, { name: 'Park gate', centre: { lat: 1, lon: 2 }, expiresAt: FAR_FUTURE })
      await addMeetPoint(circle.id, { name: 'Bus stop', centre: { lat: 3, lon: 4 }, expiresAt: FAR_FUTURE }) // same second — would collide on the bare local-meet-point-<at>-<circleId> id
      const created = store.load().activity.filter((e) => e.kind === 'meet-point' && e.params.action === 'created' && e.circleId === circle.id)
      expect(created).toHaveLength(2) // pre-fix: recordActivity's dedupe silently ate the second one
      expect(new Set(created.map((e) => e.id)).size).toBe(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('refuses to exceed MAX_MEET_POINTS (counting only LIVE points)', async () => {
    const { pkHex, skHex } = realKeypair()
    const circle = setup('parent', pkHex, skHex)
    for (let i = 0; i < MAX_MEET_POINTS; i++) {
      await addMeetPoint(circle.id, { name: `p${i}`, centre: { lat: 0, lon: 0 }, expiresAt: FAR_FUTURE })
    }
    await addMeetPoint(circle.id, { name: 'overflow', centre: { lat: 0, lon: 0 }, expiresAt: FAR_FUTURE })
    expect(store.load().meetPoints[circle.id]).toHaveLength(MAX_MEET_POINTS)
  })

  it('lets the creator delete their own point', async () => {
    const { pkHex, skHex } = realKeypair()
    const circle = setup('child', pkHex, skHex)
    await addMeetPoint(circle.id, { name: 'Mine', centre: { lat: 0, lon: 0 }, expiresAt: FAR_FUTURE })
    const id = store.load().meetPoints[circle.id]?.[0]?.id as string
    await deleteMeetPoint(circle.id, id)
    expect(store.load().meetPoints[circle.id]).toHaveLength(0)
    const evt = store.load().activity.find((e) => e.kind === 'meet-point' && e.params.action === 'deleted')
    expect(evt?.params.name).toBe('Mine')
  })

  it('refuses to let a non-creator, non-guardian member delete someone else\'s point', async () => {
    // PK_OTHER (a 'child' member, not the creator) tries to delete a point
    // created by the guardian.
    const circle = fakeCircle()
    const { skHex } = realKeypair()
    signIn(PK_OTHER, skHex)
    store.update((p) => {
      p.circles = [circle]
      p.meetPoints = { [circle.id]: [fakeMeetPoint({ id: 'guardian-made', createdBy: PK_GUARDIAN })] }
    })
    await deleteMeetPoint(circle.id, 'guardian-made')
    expect(store.load().meetPoints[circle.id]).toHaveLength(1)
  })

  it('lets a guardian delete a point they did not create', async () => {
    const circle = fakeCircle()
    const { skHex } = realKeypair()
    signIn(PK_GUARDIAN, skHex)
    store.update((p) => {
      p.circles = [circle]
      p.meetPoints = { [circle.id]: [fakeMeetPoint({ id: 'kid-made', createdBy: PK_OTHER })] }
    })
    await deleteMeetPoint(circle.id, 'kid-made')
    expect(store.load().meetPoints[circle.id]).toHaveLength(0)
  })
})

describe('tick — final-review fix 5: gates store.notify() on LIVE points, not raw list.length', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  function notifyCount(fn: () => void): number {
    let count = 0
    const unsubscribe = store.subscribe(() => { count++ })
    fn()
    unsubscribe()
    return count
  }

  it('does not notify when every point in every circle has already expired (raw length check used to churn forever here)', () => {
    const circle = fakeCircle()
    store.update((p) => {
      p.circles = [circle]
      p.meetPoints = { [circle.id]: [fakeMeetPoint({ expiresAt: Math.floor(Date.now() / 1000) - 100 })] }
    })
    expect(notifyCount(tick)).toBe(0)
  })

  it('notifies when at least one point is still live', () => {
    const circle = fakeCircle()
    store.update((p) => {
      p.circles = [circle]
      p.meetPoints = { [circle.id]: [fakeMeetPoint({ expiresAt: FAR_FUTURE })] }
    })
    expect(notifyCount(tick)).toBe(1)
  })

  it('does not notify when there are no points at all', () => {
    const circle = fakeCircle()
    store.update((p) => {
      p.circles = [circle]
      p.meetPoints = { [circle.id]: [] }
    })
    expect(notifyCount(tick)).toBe(0)
  })
})
