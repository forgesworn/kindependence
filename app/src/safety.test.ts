import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  SOS_HOLD_MS,
  helpLocationFrom,
  buildHelpWrap,
  decodeHelp,
  buildCheckinWrap,
  decodeCheckin,
  buildPickupReqWrap,
  decodePickupReq,
  buildPickupAnswerWrap,
  shouldNotifyForSafetyEvent,
  REASON_MATCH_WINDOW_SEC,
  withinReasonWindow,
  pruneExpired,
  findMatch,
  handleIncomingSignal,
} from './safety.js'
import { decodeBeaconRumor, publishOrEnqueue } from './beacons.js'
import * as store from './store.js'
import type { Fix } from './geo.js'
import { makeLocalSigner, deriveInbox, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftUnwrap, rawNip44Decrypt } from '@forgesworn/roost-kit'
import type { Rumor } from '@forgesworn/roost-kit'
import { buildFindPingSignal, FIND_PING_SIGNAL_TYPE } from '@forgesworn/flock/findping'
import { buildKindependenceMsgSignal } from './legacy-buzz.js'
import { encode as encodeGeohash } from 'geohash-kit'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { sessionForTests } from './session.js'
import type { Sender } from './beacons.js'

/** A resolved sender for a phone-key (non-structural) circle signal —
 *  `phonePk` the sealing phone key, `memberPk` the identity it resolves to
 *  (a distinct value only matters for the spoofed-sender tests). */
function fakeSender(phonePk: string, memberPk: string = phonePk): Sender {
  return { signerPk: phonePk, memberPk, structural: false }
}

// Partial-mock beacons (same idiom as meet.test.ts/pins.test.ts) so the
// findreq freshness-gate block below can observe `autoAnswerPickup`'s
// disclosure (publishOrEnqueue) and give it a deterministic fix (selfFix)
// without any real transport/geolocation. Everything else stays real.
vi.mock('./beacons.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./beacons.js')>()
  return {
    ...actual,
    publishOrEnqueue: vi.fn(async () => {}),
    selfFix: vi.fn(() => ({ lat: 51.5, lon: -0.12, accuracy: 10, at: 1_700_000_000 })),
  }
})

/** Minimal in-memory localStorage stand-in (mirrors meet.test.ts's/
 *  battery.test.ts's own — needed only by the `handleIncomingSignal` describe
 *  block below, which reads/writes `store` state). */
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

const PK_A = 'a'.repeat(64)
const PK_B = 'b'.repeat(64)

function fakeCircle(overrides: Partial<Circle> = {}): Circle {
  return {
    id: 'circle-1', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
    members: [{ pk: PK_A, role: 'guardian' }], createdAt: 100, configUpdatedAt: 100, configBy: PK_A,
    ...overrides,
  }
}

async function unwrap(wrap: Awaited<ReturnType<typeof buildHelpWrap>>, circle: Circle): Promise<Rumor> {
  const inbox = deriveInbox(circle.seedHex)
  const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), wrap)
  expect(rumor).not.toBeNull()
  return rumor as Rumor
}

describe('SOS_HOLD_MS', () => {
  it('is the 1.5s hold the task contract specifies', () => {
    expect(SOS_HOLD_MS).toBe(1500)
  })
})

describe('shouldNotifyForSafetyEvent (final-review I3 — replay-burst fix)', () => {
  it('notifies when the event was genuinely inserted AND is fresh', () => {
    expect(shouldNotifyForSafetyEvent(true, 1000, 1000)).toBe(true)
    expect(shouldNotifyForSafetyEvent(true, 1000, 1000 + 599)).toBe(true)
  })

  it('never notifies for a deduped event (already on the log), no matter how fresh', () => {
    expect(shouldNotifyForSafetyEvent(false, 1000, 1000)).toBe(false)
  })

  it('never notifies for a stale event (a stored-wrap replay), even if it was just inserted', () => {
    // 16 days of relay-replayed history landing on first subscription open —
    // exactly the burst this fix exists to silence.
    expect(shouldNotifyForSafetyEvent(true, 1000, 1000 + 16 * 24 * 3600)).toBe(false)
    expect(shouldNotifyForSafetyEvent(true, 1000, 1000 + 601)).toBe(false)
  })
})

describe('helpLocationFrom', () => {
  it('encodes a fix at help precision (11)', () => {
    const fix: Fix = { lat: 51.5074, lon: -0.1278, accuracy: 5, at: 1_700_000_000 }
    const loc = helpLocationFrom(fix)
    expect(loc).toEqual({ geohash: encodeGeohash(fix.lat, fix.lon, 11), precision: 11, locationSource: 'beacon' })
  })

  it('returns null for a missing fix (location-less alert)', () => {
    expect(helpLocationFrom(null)).toBeNull()
  })
})

describe('buildHelpWrap / decodeHelp — wire round trip', () => {
  it('round-trips a located SOS through the gift wrap + duress cipher', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const fix: Fix = { lat: 51.5074, lon: -0.1278, accuracy: 5, at: 1_700_000_000 }
    const location = helpLocationFrom(fix)

    const wrap = await buildHelpWrap(signer, circle, signer.pubkey, location)
    expect(wrap.kind).toBe(1059) // outer NIP-59 gift wrap, never the bare inner signal

    const rumor = await unwrap(wrap, circle)
    const alert = await decodeHelp(rumor, circle.seedHex)
    expect(alert).not.toBeNull()
    expect(alert?.member).toBe(signer.pubkey)
    expect(alert?.geohash).toBe(location?.geohash)
    expect(alert?.precision).toBe(11)
    expect(alert?.locationSource).toBe('beacon')
    expect(alert?.scope).toBe('group')
  })

  it('round-trips a location-less SOS (no fix available)', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()

    const wrap = await buildHelpWrap(signer, circle, signer.pubkey, null)
    const rumor = await unwrap(wrap, circle)
    const alert = await decodeHelp(rumor, circle.seedHex)
    expect(alert).not.toBeNull()
    expect(alert?.locationSource).toBe('none')
    expect(alert?.geohash).toBe('')
  })

  it('returns null when decrypted with the wrong circle seed', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const wrap = await buildHelpWrap(signer, circle, signer.pubkey, null)
    const rumor = await unwrap(wrap, circle)
    expect(await decodeHelp(rumor, '2'.repeat(64))).toBeNull()
  })

  it('returns null for a rumor that is not a help signal', async () => {
    const rumor: Rumor = { pubkey: PK_A, created_at: 1000, kind: 20_078, tags: [['t', 'beacon']], content: 'whatever' }
    expect(await decodeHelp(rumor, '1'.repeat(64))).toBeNull()
  })
})

describe('buildCheckinWrap / decodeCheckin — check_in fixed action + legacy free-text compat', () => {
  it('round-trips a check-in as the fixed check_in action (upstream always attaches the location roll-call ask)', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()

    const wrap = await buildCheckinWrap(signer, circle, signer.pubkey, false, 1_700_000_000)
    expect(wrap.kind).toBe(1059)
    const rumor = await unwrap(wrap, circle)
    const buzz = await decodeCheckin(rumor, circle.seedHex, signer.pubkey)
    expect(buzz).not.toBeNull()
    expect(buzz?.from).toBe(signer.pubkey)
    expect(buzz?.timestamp).toBe(1_700_000_000)
    // Phase 7 Task 3: flock made a check-in inherently a location ROLL-CALL, so
    // the ask rides every check_in regardless of the (now-vestigial)
    // shareLocation arg. It's a request that others report — never our own auto-
    // disclosure, and the receive path does not auto-answer it.
    expect(buzz?.ask).toBe('location')
  })

  it('shareLocation no longer changes the wire — the check_in payload is identical either way', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const wrap = await buildCheckinWrap(signer, circle, signer.pubkey, true, 1_700_000_000)
    const buzz = await decodeCheckin(await unwrap(wrap, circle), circle.seedHex, signer.pubkey)
    expect(buzz?.ask).toBe('location')
  })

  it('is tagged as a real flock buzz signal (t:"buzz"), not a kindependence-only type', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const wrap = await buildCheckinWrap(signer, circle, signer.pubkey, false, 1000)
    const rumor = await unwrap(wrap, circle)
    expect(rumor.tags.find((t) => t[0] === 't')?.[1]).toBe('buzz')
  })

  it('accepts a LEGACY free-text "Check in" buzz on the receive compat window (spec §3: receive accepts both)', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    // A pre-migration check-in carried no explicit `action`, only the free-text
    // `reason:'Check in'`. Build that old-shape payload (the kindependence codec
    // emits {from,reason,timestamp}) and label it t:'buzz' like a real legacy
    // flock buzz — decodeCheckin must still recognise it as a check-in.
    const inner = await buildKindependenceMsgSignal({ groupId: circle.id, seedHex: circle.seedHex, from: signer.pubkey, reason: 'Check in', timestamp: 1000 })
    const rumor: Rumor = { pubkey: signer.pubkey, created_at: inner.created_at, kind: inner.kind, tags: [['t', 'buzz']], content: inner.content }
    const buzz = await decodeCheckin(rumor, circle.seedHex, signer.pubkey)
    expect(buzz).not.toBeNull()
    expect(buzz?.from).toBe(signer.pubkey)
    expect(buzz?.timestamp).toBe(1000)
  })

  it('drops a forged LEGACY check-in whose content-embedded from does not match the authenticated sender (final-review fix, Minor #4)', async () => {
    const circle = fakeCircle()
    const senderPk = makeLocalSigner(toHex(generateSecretKey())).pubkey // the wrap's REAL, authenticated seal signer
    const claimedPk = makeLocalSigner(toHex(generateSecretKey())).pubkey // dishonestly claimed `from`
    // Same legacy shape as the positive test above, but the content's own
    // `from` claims a DIFFERENT pubkey than the wrap's real signer.
    const inner = await buildKindependenceMsgSignal({ groupId: circle.id, seedHex: circle.seedHex, from: claimedPk, reason: 'Check in', timestamp: 1000 })
    const rumor: Rumor = { pubkey: senderPk, created_at: inner.created_at, kind: inner.kind, tags: [['t', 'buzz']], content: inner.content }
    expect(await decodeCheckin(rumor, circle.seedHex, senderPk)).toBeNull()
  })

  it('returns null for a DIFFERENT coordination action (on_my_way is not a check-in)', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const { buildBuzzSignal } = await import('@forgesworn/flock/buzz')
    const inner = await buildBuzzSignal({ groupId: circle.id, seedHex: circle.seedHex, from: signer.pubkey, action: 'on_my_way', timestamp: 1000 })
    const rumor: Rumor = { pubkey: signer.pubkey, created_at: inner.created_at, kind: inner.kind, tags: inner.tags, content: inner.content }
    expect(await decodeCheckin(rumor, circle.seedHex, signer.pubkey)).toBeNull()
  })

  it('returns null for a rumor with a different t tag (e.g. a pickup request)', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const wrap = await buildPickupReqWrap(signer, circle, signer.pubkey, PK_A, 1000)
    const rumor = await unwrap(wrap, circle)
    expect(await decodeCheckin(rumor, circle.seedHex, signer.pubkey)).toBeNull()
  })

  it('returns null when decrypted with the wrong circle seed', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const wrap = await buildCheckinWrap(signer, circle, signer.pubkey, false, 1000)
    const rumor = await unwrap(wrap, circle)
    expect(await decodeCheckin(rumor, '2'.repeat(64), signer.pubkey)).toBeNull()
  })
})

describe('buildPickupReqWrap / decodePickupReq — wire round trip (vendored flock findping.ts)', () => {
  it('round-trips a pickup request naming the target child', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()

    const wrap = await buildPickupReqWrap(signer, circle, signer.pubkey, PK_B, 1_700_000_000)
    expect(wrap.kind).toBe(1059)
    const rumor = await unwrap(wrap, circle)
    const ping = await decodePickupReq(rumor, circle.seedHex)
    expect(ping).toEqual({ from: signer.pubkey, target: PK_B, timestamp: 1_700_000_000 })
  })

  it('is tagged as a real flock find-ping signal (t:"findreq")', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const wrap = await buildPickupReqWrap(signer, circle, signer.pubkey, PK_B, 1000)
    const rumor = await unwrap(wrap, circle)
    expect(rumor.tags.find((t) => t[0] === 't')?.[1]).toBe('findreq')
  })

  it('returns null for a rumor that is not a pickup request', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const wrap = await buildCheckinWrap(signer, circle, signer.pubkey, false, 1000)
    const rumor = await unwrap(wrap, circle)
    expect(await decodePickupReq(rumor, circle.seedHex)).toBeNull()
  })

  it('returns null when decrypted with the wrong circle seed', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const wrap = await buildPickupReqWrap(signer, circle, signer.pubkey, PK_B, 1000)
    const rumor = await unwrap(wrap, circle)
    expect(await decodePickupReq(rumor, '2'.repeat(64))).toBeNull()
  })
})

describe('Task 6 (brief §11.4-11.5/§2.3) — reason-DM↔findreq correlation reducers', () => {
  describe('withinReasonWindow', () => {
    it('matches the same sender within the window, either direction', () => {
      expect(withinReasonWindow({ from: PK_A, at: 1000 }, { from: PK_A, at: 1050 })).toBe(true)
      expect(withinReasonWindow({ from: PK_A, at: 1050 }, { from: PK_A, at: 1000 })).toBe(true)
    })

    it('matches exactly at the window boundary (inclusive)', () => {
      expect(withinReasonWindow({ from: PK_A, at: 1000 }, { from: PK_A, at: 1000 + REASON_MATCH_WINDOW_SEC })).toBe(true)
    })

    it('does not match past the window boundary', () => {
      expect(withinReasonWindow({ from: PK_A, at: 1000 }, { from: PK_A, at: 1000 + REASON_MATCH_WINDOW_SEC + 1 })).toBe(false)
    })

    it('does not match a different sender, even at the same instant', () => {
      expect(withinReasonWindow({ from: PK_A, at: 1000 }, { from: PK_B, at: 1000 })).toBe(false)
    })

    it('respects a custom window', () => {
      expect(withinReasonWindow({ from: PK_A, at: 1000 }, { from: PK_A, at: 1010 }, 5)).toBe(false)
      expect(withinReasonWindow({ from: PK_A, at: 1000 }, { from: PK_A, at: 1010 }, 15)).toBe(true)
    })
  })

  describe('pruneExpired', () => {
    it('drops entries older than the window, keeps the rest', () => {
      const items = [{ at: 1000 }, { at: 1900 }, { at: 2000 }]
      expect(pruneExpired(items, 2000)).toEqual([{ at: 1900 }, { at: 2000 }]) // 1000 is 1000s old > 120s window
    })

    it('keeps an entry exactly at the window boundary', () => {
      const items = [{ at: 1000 }]
      expect(pruneExpired(items, 1000 + REASON_MATCH_WINDOW_SEC)).toEqual(items)
    })

    it('returns an empty array unchanged', () => {
      expect(pruneExpired([], 1000)).toEqual([])
    })
  })

  describe('findMatch', () => {
    it('finds the first correlating entry', () => {
      const pending = [{ from: PK_B, at: 500 }, { from: PK_A, at: 1050 }]
      expect(findMatch(pending, { from: PK_A, at: 1000 })).toEqual({ from: PK_A, at: 1050 })
    })

    it('returns undefined when nothing correlates (wrong sender)', () => {
      expect(findMatch([{ from: PK_B, at: 1000 }], { from: PK_A, at: 1000 })).toBeUndefined()
    })

    it('returns undefined when nothing correlates (outside the window)', () => {
      expect(findMatch([{ from: PK_A, at: 1000 }], { from: PK_A, at: 1000 + REASON_MATCH_WINDOW_SEC + 1 })).toBeUndefined()
    })

    it('returns undefined for an empty pending list', () => {
      expect(findMatch([], { from: PK_A, at: 1000 })).toBeUndefined()
    })
  })
})

describe('buildPickupAnswerWrap — emits a PLAIN beacon (t:"beacon"), not a distinct pickup type', () => {
  it('round-trips through beacons.ts\'s own decodeBeaconRumor at precision 9 — proving the answer is indistinguishable from routine sharing', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const fix: Fix = { lat: 51.5074, lon: -0.1278, accuracy: 3, at: 1_700_000_000 }

    const wrap = await buildPickupAnswerWrap(signer, circle, fix)
    expect(wrap.kind).toBe(1059)
    const rumor = await unwrap(wrap, circle)
    expect(rumor.tags.find((t) => t[0] === 't')?.[1]).toBe('beacon')

    const pos = await decodeBeaconRumor(rumor, circle.seedHex)
    expect(pos).not.toBeNull()
    expect(pos?.geohash).toBe(encodeGeohash(fix.lat, fix.lon, 9))
    expect(pos?.precision).toBe(9)
  })
})

describe('handleIncomingSignal — findreq sender-auth binding (ffb48b9 class)', () => {
  // Repin fallout note: roost-kit 504cff8 now authenticates rumor.pubkey
  // (verifies the seal signature + binds the rumor author) — but ping.from
  // is a SEPARATE, content-embedded field the sender writes themselves
  // inside the encrypted findreq payload. Nothing about giftUnwrap's fix
  // stops a legitimate circle member from writing a DIFFERENT member's
  // pubkey into that field — hence this app-level bind-and-drop check.
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const circle = fakeCircle()

  /** Builds a plain (un-gift-wrapped) findreq `Rumor` — `senderPk` is what
   *  the AUTHENTICATED wrap would have carried as `rumor.pubkey` (post-
   *  504cff8, always the real signer); `contentFrom` is the separate,
   *  attacker-controlled `from` field inside the encrypted payload. Same
   *  "build the inner signal directly, skip the outer gift-wrap" idiom as
   *  battery.test.ts's own spoofed-`from` test — the binding under test
   *  operates on an already-unwrapped rumor, so a real NIP-59 wrap adds
   *  nothing to what's being verified here. */
  async function findreqRumor(senderPk: string, contentFrom: string, targetPk: string, at: number): Promise<Rumor> {
    const inner = await buildFindPingSignal({ groupId: circle.id, seedHex: circle.seedHex, from: contentFrom, target: targetPk, timestamp: at })
    return { id: `findreq-${senderPk}-${at}`, pubkey: senderPk, ...inner } as unknown as Rumor
  }

  it('applies a genuine findreq (ping.from === rumor.pubkey)', async () => {
    const asker = 'c'.repeat(64)
    const child = PK_B
    const rumor = await findreqRumor(asker, asker, child, 1_700_000_000)
    // Final-review fix, Minor #5: handleIncomingSignal now returns its async
    // tail's promise (same seam pins.ts's own handleIncomingSignal got, this
    // shape being trivially identical — a sync wrapper voiding an async
    // tail), so this can await completion directly instead of racing a
    // fixed-delay flush() against the real decrypt inside it.
    await handleIncomingSignal(circle, rumor, FIND_PING_SIGNAL_TYPE, fakeSender(asker))
    expect(store.load().safetyEvents.some((e) => e.kind === 'pickup' && e.from === child)).toBe(true)
  })

  it('drops a forged findreq (content ping.from names someone other than the actual sender) — nothing recorded', async () => {
    const attacker = 'd'.repeat(64) // the real, authenticated wrap sender
    const victim = 'e'.repeat(64) // whoever the content dishonestly claims is asking
    const child = PK_B
    const forged = await findreqRumor(attacker, victim, child, 1_700_000_001)
    // Awaits directly now (final-review fix, Minor #5) instead of the old
    // "dispatch a legitimate findreq right after and wait for ITS effect"
    // ordering trick a void-returning handler forced here — see the doc
    // comment on the previous test.
    await handleIncomingSignal(circle, forged, FIND_PING_SIGNAL_TYPE, fakeSender(attacker))
    expect(store.load().safetyEvents.some((e) => e.from === victim)).toBe(false)
    expect(store.load().safetyEvents.some((e) => e.at === 1_700_000_001)).toBe(false)
  })
})

// Flock ff5eead parity: a findreq answer is a one-shot EXACT-location
// disclosure, so it must only answer a LIVE request. The rumor-id dedup is
// per-session — after a relaunch, a captured findreq wrap replayed by a
// malicious/sloppy relay lands as "new" and, pre-gate, re-disclosed the
// child's current position with no prompt. The embedded timestamp is sealed
// by the sender, so a replayer can't advance it — gating on it is sound.
// Fail-closed: a genuinely delayed ask is simply re-asked (rate-limited).
describe('findreq auto-answer freshness gate', () => {
  beforeEach(() => {
    vi.stubGlobal('localStorage', fakeLocalStorage())
    vi.mocked(publishOrEnqueue).mockClear()
  })
  afterEach(() => vi.unstubAllGlobals())

  const circle = fakeCircle()

  function childSelf(): { pkHex: string } {
    const identityPk = getPublicKey(generateSecretKey())
    sessionForTests({ identityPk, phoneSkHex: toHex(generateSecretKey()), dependant: true })
    return { pkHex: identityPk }
  }

  async function targetedFindreq(targetPk: string, at: number): Promise<Rumor> {
    const inner = await buildFindPingSignal({ groupId: circle.id, seedHex: circle.seedHex, from: PK_A, target: targetPk, timestamp: at })
    return { id: `findreq-${at}`, pubkey: PK_A, ...inner } as unknown as Rumor
  }

  /** `autoAnswerPickup` is fired void (fire-and-forget) from the signal
   *  handler, so give its async tail a macrotask to land before asserting. */
  const flush = (): Promise<void> => new Promise((r) => { setTimeout(r, 10) })

  it('answers a fresh findreq addressed to this device with a location disclosure (positive control)', async () => {
    const self = childSelf()
    const rumor = await targetedFindreq(self.pkHex, Math.floor(Date.now() / 1000) - 10)
    await handleIncomingSignal(circle, rumor, FIND_PING_SIGNAL_TYPE, fakeSender(PK_A))
    await vi.waitFor(() => { expect(publishOrEnqueue).toHaveBeenCalledTimes(1) })
  })

  it('records but does NOT answer a stale findreq — no disclosure from a replayed wrap', async () => {
    const self = childSelf()
    const rumor = await targetedFindreq(self.pkHex, Math.floor(Date.now() / 1000) - (5 * 60 + 30))
    await handleIncomingSignal(circle, rumor, FIND_PING_SIGNAL_TYPE, fakeSender(PK_A))
    await flush()
    expect(publishOrEnqueue).not.toHaveBeenCalled()
    // The log/state path is unaffected — only the disclosure gates (flock's
    // own split: state updates newest-wins, actions gate on freshness).
    expect(store.load().safetyEvents.some((e) => e.kind === 'pickup')).toBe(true)
  })
})
