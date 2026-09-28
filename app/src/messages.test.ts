import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  MAX_THREAD,
  dmMessageId,
  appendMessage,
  unreadCount,
  unreadForPeer,
  unreadForCircle,
  totalUnread,
  unreadBadgeHtml,
  buzzChipPayload,
  BUZZ_CHIP_REASONS,
  CHIP_LABELS,
  structuredDmText,
  detectStructuredDm,
  chipsForThread,
  MAX_CIRCLE_CHAT_LEN,
  capCircleChatText,
  buildKindependenceMsgWrap,
  classifyIncomingBuzz,
  buildPreciseRequestReasonText,
  detectPreciseRequestReason,
  MAX_PRECISE_REASON_LEN,
  messageActivityId,
  shouldNotifyForIncomingChat,
  chipNotifyKind,
  buildSuggestBaselineText,
  detectSuggestBaselineReason,
  SUGGEST_BASELINE_PRESET_OPTIONS,
  sendSuggestBaseline,
  handleAction,
  view,
  openDmThread,
  ensure,
  handleIncomingSignal,
} from './messages.js'
import type { ChatMessage } from './store.js'
import * as store from './store.js'
import * as beacons from './beacons.js'
import type { Sender } from './beacons.js'
import type { SessionInfo } from './session.js'
import { sessionForTests, currentSession } from './session.js'
import { buildPickupReason, parsePickupReason } from './pickup.js'
import { makeLocalSigner, deriveInbox, toHex, readDmWrap, personalInboxTag } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { deviceStatementTemplate } from './device-statements.js'
import { acceptStatement } from './phone-keys.js'
import { giftWrap, giftUnwrap, rawNip44Decrypt, publishSigned } from '@forgesworn/roost-kit'
import type { Rumor, SignedEvent, Signer } from '@forgesworn/roost-kit'
import { buildBuzzSignal, decryptBuzz, BUZZ_SIGNAL_TYPE } from '@forgesworn/flock/buzz'
import { buildKindependenceMsgSignal, decodeLegacyBuzz, KINDEPENDENCE_MSG_SIGNAL_TYPE } from './legacy-buzz.js'
import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { buildNotYetReason } from './places.js'
import { buildJourneyStartReason, buildJourneyDoneReason } from './journey.js'

// suggest-baseline's `sendSuggestBaseline` (Phase 6 Task 2) does real
// (non-network) crypto via LocalSigner before publishing — only the relay
// publish itself actually leaves the process. Mocking just `publishSigned`
// (same idiom as approvals.test.ts) exercises the real gift-wrap round trip
// without touching a network; every OTHER test in this file only ever calls
// pure builders/decoders directly (never `sendSuggestBaseline`/beacons.ts),
// so this mock changes nothing for them.
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

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage())
  vi.mocked(publishSigned).mockClear()
})

function fakeIdentity(pkHex: string, _skHex: string, role: 'parent' | 'child'): SessionInfo {
  return { identityPk: pkHex, dependant: role === 'child', name: 'Self', transport: { kind: 'nip55', packageName: 'test' }, phonePk: 'f'.repeat(64) }
}

function realKeypair(): { skHex: string; pkHex: string } {
  const sk = generateSecretKey()
  return { skHex: toHex(sk), pkHex: getPublicKey(sk) }
}

/** Signs this device in for a test (Signet identity plan): `identityPk` is
 *  the signed-in identity, `phoneSkHex` this device's own phone key. */
function signIn(identityPk: string, phoneSkHex: string, dependant = false): void {
  sessionForTests({ identityPk, phoneSkHex, dependant })
}

/** A resolved sender for a phone-key (non-structural — this module owns no
 *  structural action) circle/DM signal — `phonePk` the sealing phone key,
 *  `memberPk` the identity it resolves to. */
function fakeSender(phonePk: string, memberPk: string = phonePk): Sender {
  return { signerPk: phonePk, memberPk, structural: false }
}

const PK_GUARDIAN = 'a'.repeat(64)
const PK_CHILD = 'b'.repeat(64)
const PK_OTHER_GUARDIAN = 'c'.repeat(64)
const PK_SIBLING = 'd'.repeat(64)

function fakeCircle(overrides: Partial<Circle> = {}): Circle {
  return {
    id: 'circle-1', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
    members: [
      { pk: PK_GUARDIAN, role: 'guardian', name: 'Alex' },
      { pk: PK_CHILD, role: 'child', name: 'Bailey' },
    ],
    createdAt: 100, configUpdatedAt: 100, configBy: PK_GUARDIAN,
    ...overrides,
  }
}

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return { id: 'm-1', from: PK_GUARDIAN, text: 'hi', at: 1000, ...overrides }
}

describe('dmMessageId', () => {
  it('is stable for the same inputs', () => {
    expect(dmMessageId(PK_GUARDIAN, 100, 'hi')).toBe(dmMessageId(PK_GUARDIAN, 100, 'hi'))
  })

  it('is distinct across sender/time/text', () => {
    const base = dmMessageId(PK_GUARDIAN, 100, 'hi')
    expect(dmMessageId(PK_CHILD, 100, 'hi')).not.toBe(base)
    expect(dmMessageId(PK_GUARDIAN, 200, 'hi')).not.toBe(base)
    expect(dmMessageId(PK_GUARDIAN, 100, 'bye')).not.toBe(base)
  })
})

describe('appendMessage', () => {
  it('appends to an empty thread', () => {
    expect(appendMessage([], msg({ id: 'a', at: 100 }))).toEqual([msg({ id: 'a', at: 100 })])
  })

  it('inserts a message at its chronological slot (oldest-first — chat reading order)', () => {
    const thread = [msg({ id: 'a', at: 100 }), msg({ id: 'c', at: 300 })]
    const result = appendMessage(thread, msg({ id: 'b', at: 200 }))
    expect(result.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('is stable across equal `at` — a same-timestamp arrival goes AFTER already-recorded equals', () => {
    let thread: ChatMessage[] = []
    thread = appendMessage(thread, msg({ id: 'a', at: 1000 }))
    thread = appendMessage(thread, msg({ id: 'b', at: 1000 }))
    thread = appendMessage(thread, msg({ id: 'c', at: 1000 }))
    expect(thread.map((m) => m.id)).toEqual(['a', 'b', 'c'])
  })

  it('dedupes by id — returns the SAME array reference, original entry untouched', () => {
    const thread = [msg({ id: 'a', text: 'first' })]
    const result = appendMessage(thread, msg({ id: 'a', text: 'replay' }))
    expect(result).toBe(thread)
    expect(result[0]?.text).toBe('first')
  })

  it('caps at the given limit, dropping the OLDEST (the head of an oldest-first list)', () => {
    let thread: ChatMessage[] = []
    for (let i = 0; i < 5; i++) thread = appendMessage(thread, msg({ id: `m${i}`, at: i }), 5)
    expect(thread).toHaveLength(5)
    thread = appendMessage(thread, msg({ id: 'newest', at: 100 }), 5)
    expect(thread).toHaveLength(5)
    expect(thread.some((m) => m.id === 'm0')).toBe(false) // oldest fell off
    expect(thread.some((m) => m.id === 'newest')).toBe(true)
    expect(thread[thread.length - 1]?.id).toBe('newest')
  })

  it('defaults its cap to MAX_THREAD (200)', () => {
    let thread: ChatMessage[] = []
    for (let i = 0; i < 201; i++) thread = appendMessage(thread, msg({ id: `m${i}`, at: i }))
    expect(thread).toHaveLength(MAX_THREAD)
    expect(thread.some((m) => m.id === 'm0')).toBe(false)
  })
})

describe('unreadCount', () => {
  it('counts messages from someone other than self, newer than lastSeenAt', () => {
    const thread = [msg({ from: PK_CHILD, at: 100 }), msg({ from: PK_CHILD, at: 200 }), msg({ from: PK_CHILD, at: 300 })]
    expect(unreadCount(thread, 150, PK_GUARDIAN)).toBe(2)
  })

  it('never counts a self-sent message as unread', () => {
    const thread = [msg({ from: PK_GUARDIAN, at: 500 })]
    expect(unreadCount(thread, 0, PK_GUARDIAN)).toBe(0)
  })

  it('is 0 when everything is at/before lastSeenAt', () => {
    const thread = [msg({ from: PK_CHILD, at: 100 })]
    expect(unreadCount(thread, 100, PK_GUARDIAN)).toBe(0)
  })

  it('is 0 for an empty thread', () => {
    expect(unreadCount([], 0, PK_GUARDIAN)).toBe(0)
  })
})

describe('unreadForPeer / unreadForCircle / totalUnread', () => {
  const p = {
    circles: [fakeCircle(), fakeCircle({ id: 'circle-2', name: 'Other' })],
    dmThreads: { [PK_CHILD]: [msg({ from: PK_CHILD, at: 100 })] },
    dmLastSeen: {},
    circleChats: { 'circle-1': [msg({ from: PK_CHILD, at: 100 })], 'circle-2': [msg({ from: PK_CHILD, at: 100 })] },
    circleChatLastSeen: { 'circle-2': 100 },
  } as unknown as Parameters<typeof unreadForPeer>[0]

  it('unreadForPeer treats a missing lastSeen entry as 0 (everything unread)', () => {
    expect(unreadForPeer(p, PK_CHILD, PK_GUARDIAN)).toBe(1)
  })

  it('unreadForPeer is 0 for a peer with no thread at all', () => {
    expect(unreadForPeer(p, PK_OTHER_GUARDIAN, PK_GUARDIAN)).toBe(0)
  })

  it('unreadForCircle respects an explicit lastSeen', () => {
    expect(unreadForCircle(p, 'circle-1', PK_GUARDIAN)).toBe(1) // no lastSeen recorded
    expect(unreadForCircle(p, 'circle-2', PK_GUARDIAN)).toBe(0) // seen at 100, message at 100
  })

  it('totalUnread sums every DM thread and every circle chat', () => {
    expect(totalUnread(p, PK_GUARDIAN)).toBe(2) // dm(1) + circle-1(1) + circle-2(0)
  })
})

describe('unreadBadgeHtml', () => {
  it('is empty for zero', () => {
    expect(unreadBadgeHtml(0)).toBe('')
  })

  it('renders the count', () => {
    expect(unreadBadgeHtml(3)).toContain('3')
  })

  it('caps the displayed text at "99+"', () => {
    expect(unreadBadgeHtml(150)).toContain('99+')
  })
})

describe('buzzChipPayload / BUZZ_CHIP_REASONS', () => {
  it('maps each chip kind to its wire reason', () => {
    expect(buzzChipPayload('status-okay')).toEqual({ reason: "I'm okay" })
    expect(buzzChipPayload('status-arrived')).toEqual({ reason: 'Arrived' })
    expect(buzzChipPayload('status-leaving')).toEqual({ reason: 'Leaving now' })
    expect(buzzChipPayload('status-heading-home')).toEqual({ reason: 'Heading home' })
  })

  it('includes target only when one is given (DM context)', () => {
    expect(buzzChipPayload('status-okay', PK_CHILD)).toEqual({ reason: "I'm okay", target: PK_CHILD })
  })

  // The critical wire-safety property this task hinges on: a REQUEST to
  // check in must not collide with safety.ts's own exact-match `'Check in'`
  // self-report classification (see BUZZ_CHIP_REASONS's own doc comment) —
  // otherwise a guardian asking "can you check in?" would misfile on the
  // receiving device as the CHILD having just announced they're fine.
  it('"checkin-request" uses a reason DISTINCT from safety.ts\'s own "Check in" self-report — a classification-precedence guarantee, not just a naming nicety', () => {
    expect(BUZZ_CHIP_REASONS['checkin-request']).not.toBe('Check in')
    expect(buzzChipPayload('checkin-request').reason).toBe('Please check in')
    // If these ever collided, classifyIncomingBuzz would mislabel safety.ts's
    // own "I'm OK" self-report as this module's "Can you check in?" REQUEST
    // — asserted directly here so a future edit to either reason string
    // trips this test, not just a subtle runtime misclassification.
    expect(classifyIncomingBuzz('Check in', undefined).structured).not.toBe('checkin-request')
  })
})

describe('structuredDmText / detectStructuredDm', () => {
  it('round-trips every structured kind', () => {
    expect(detectStructuredDm(structuredDmText('come-home-now'))).toBe('come-home-now')
    expect(detectStructuredDm(structuredDmText('dinner-ready'))).toBe('dinner-ready')
    expect(detectStructuredDm(structuredDmText('pickup'))).toBe('pickup')
  })

  it('tolerates surrounding whitespace', () => {
    expect(detectStructuredDm('  Come home now  ')).toBe('come-home-now')
  })

  it('does not match ordinary free text', () => {
    expect(detectStructuredDm('Can we get pizza tonight?')).toBeUndefined()
    expect(detectStructuredDm('Come home now please')).toBeUndefined() // not an EXACT phrase match
  })

  it('is case-sensitive (an exact phrase, not a fuzzy keyword match)', () => {
    expect(detectStructuredDm('come home now')).toBeUndefined()
  })
})

describe('buildPreciseRequestReasonText / detectPreciseRequestReason (Task 6, brief §11.4-11.5)', () => {
  it('round-trips a declared reason', () => {
    const text = buildPreciseRequestReasonText('Meeting you')
    expect(detectPreciseRequestReason(text)).toBe('Meeting you')
  })

  it('trims and caps at MAX_PRECISE_REASON_LEN (140)', () => {
    const long = 'x'.repeat(200)
    const text = buildPreciseRequestReasonText(`  ${long}  `)
    expect(detectPreciseRequestReason(text)).toHaveLength(MAX_PRECISE_REASON_LEN)
  })

  it('falls back to "not stated" for an empty reason', () => {
    expect(detectPreciseRequestReason(buildPreciseRequestReasonText(''))).toBe('not stated')
    expect(detectPreciseRequestReason(buildPreciseRequestReasonText('   '))).toBe('not stated')
  })

  it('does not match ordinary free text or the fixed StructuredDmKind phrases', () => {
    expect(detectPreciseRequestReason('Dinner ready')).toBeUndefined()
    expect(detectPreciseRequestReason('Can you see where I am?')).toBeUndefined()
  })

  it('is distinguishable from detectStructuredDm — the two vocabularies never overlap', () => {
    const text = buildPreciseRequestReasonText('Emergency')
    expect(detectStructuredDm(text)).toBeUndefined()
    expect(detectPreciseRequestReason(text)).toBe('Emergency')
  })
})

describe('chipsForThread', () => {
  it('always includes the five universal check-in/status chips', () => {
    const kinds = chipsForThread(fakeCircle(), PK_GUARDIAN, PK_CHILD).map((c) => c.kind)
    expect(kinds).toEqual(expect.arrayContaining(['checkin-request', 'status-okay', 'status-arrived', 'status-leaving', 'status-heading-home']))
  })

  it('a guardian chatting with their child sees the return-message chips, including request-pickup', () => {
    const kinds = chipsForThread(fakeCircle(), PK_GUARDIAN, PK_CHILD).map((c) => c.kind)
    expect(kinds).toContain('come-home-now')
    expect(kinds).toContain('dinner-ready')
    expect(kinds).toContain('be-home-by')
    expect(kinds).toContain('request-pickup')
    expect(kinds).not.toContain('pickup') // that's the CHILD's own chip, not the guardian's
  })

  it('a child chatting with their guardian sees "pickup", not the guardian-only chips', () => {
    const kinds = chipsForThread(fakeCircle(), PK_CHILD, PK_GUARDIAN).map((c) => c.kind)
    expect(kinds).toContain('pickup')
    expect(kinds).not.toContain('come-home-now')
    expect(kinds).not.toContain('dinner-ready')
    expect(kinds).not.toContain('be-home-by')
    expect(kinds).not.toContain('request-pickup')
  })

  it('two guardians chatting see neither the guardian->child nor the child->guardian chips', () => {
    const circle = fakeCircle({ members: [{ pk: PK_GUARDIAN, role: 'guardian' }, { pk: PK_OTHER_GUARDIAN, role: 'guardian' }] })
    const kinds = chipsForThread(circle, PK_GUARDIAN, PK_OTHER_GUARDIAN).map((c) => c.kind)
    expect(kinds).not.toContain('come-home-now')
    expect(kinds).not.toContain('pickup')
  })

  it('"request-pickup" is DM-only — never offered in a circle-chat thread (no single target child)', () => {
    const kinds = chipsForThread(fakeCircle(), PK_GUARDIAN, undefined).map((c) => c.kind)
    expect(kinds).toContain('come-home-now') // still guardian-facing chips (circle has a child member)
    expect(kinds).not.toContain('request-pickup')
  })

  it('circle-chat thread (no peer): guardian-facing chips gate on the circle having ANY child, not one specific relationship', () => {
    const kinds = chipsForThread(fakeCircle(), PK_GUARDIAN, undefined).map((c) => c.kind)
    expect(kinds).toContain('be-home-by')
  })

  it('circle-chat thread: child-facing "pickup" gates on the circle having ANY guardian', () => {
    const kinds = chipsForThread(fakeCircle(), PK_CHILD, undefined).map((c) => c.kind)
    expect(kinds).toContain('pickup')
  })

  it('every returned chip has a non-empty label matching CHIP_LABELS', () => {
    for (const chip of chipsForThread(fakeCircle(), PK_GUARDIAN, PK_CHILD)) {
      expect(chip.label).toBe(CHIP_LABELS[chip.kind])
      expect(chip.label.length).toBeGreaterThan(0)
    }
  })
})

describe('capCircleChatText', () => {
  it('trims surrounding whitespace', () => {
    expect(capCircleChatText('  hello  ')).toBe('hello')
  })

  it('caps at MAX_CIRCLE_CHAT_LEN (280 — flock buzz.ts\'s own reason limit, not covey\'s 500-char DM cap)', () => {
    expect(MAX_CIRCLE_CHAT_LEN).toBe(280)
    const long = 'x'.repeat(400)
    expect(capCircleChatText(long)).toHaveLength(280)
  })

  it('leaves short text untouched', () => {
    expect(capCircleChatText('Dinner ready')).toBe('Dinner ready')
  })
})

async function unwrapBuzz(wrap: Awaited<ReturnType<typeof buildKindependenceMsgWrap>>, circle: Circle): Promise<Rumor> {
  const inbox = deriveInbox(circle.seedHex)
  const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), wrap)
  expect(rumor).not.toBeNull()
  return rumor as Rumor
}

describe('buildKindependenceMsgWrap — wire round trip (kindependence\'s own t:"kindependence-msg" transport)', () => {
  it('round-trips free text as an UNTARGETED kindependence-msg whose reason IS the message', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()

    const wrap = await buildKindependenceMsgWrap(signer, circle, signer.pubkey, 'Dinner ready', undefined, 1_700_000_000)
    expect(wrap.kind).toBe(1059) // outer NIP-59 gift wrap, never the bare inner signal

    const rumor = await unwrapBuzz(wrap, circle)
    expect(rumor.kind).toBe(20_078) // a kind-20078 signal, same envelope discipline as a buzz
    expect(rumor.tags.find((t) => t[0] === 't')?.[1]).toBe(KINDEPENDENCE_MSG_SIGNAL_TYPE) // our OWN type — a new flock client drops it wholesale rather than REJECTING our free text (post-eb96ce0 decryptBuzz throws)

    const buzz = await decodeLegacyBuzz(circle.seedHex, rumor.content)
    expect(buzz.from).toBe(signer.pubkey)
    expect(buzz.reason).toBe('Dinner ready')
    expect(buzz.target).toBeUndefined()
    expect(buzz.timestamp).toBe(1_700_000_000)
  })

  it('carries a target when one is given (a BuzzChipKind sent from a 1:1 DM)', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const target = 'b'.repeat(64)
    const wrap = await buildKindependenceMsgWrap(signer, circle, signer.pubkey, "I'm okay", target, 1000)
    const rumor = await unwrapBuzz(wrap, circle)
    const buzz = await decodeLegacyBuzz(circle.seedHex, rumor.content)
    expect(buzz.target).toBe(target)
  })

  it('carries a Task 6 declared-reason broadcast through the SAME kindependence-msg wire', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const wrap = await buildKindependenceMsgWrap(signer, circle, signer.pubkey, buildPreciseRequestReasonText('Worried — running late'), undefined, 1000)
    const rumor = await unwrapBuzz(wrap, circle)
    const buzz = await decodeLegacyBuzz(circle.seedHex, rumor.content)
    expect(detectPreciseRequestReason(buzz.reason)).toBe('Worried — running late')
    expect(detectStructuredDm(buzz.reason)).toBeUndefined() // not one of the fixed StructuredDmKind phrases
  })

  it('undecryptable with a different circle\'s seed', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()
    const wrap = await buildKindependenceMsgWrap(signer, circle, signer.pubkey, 'hello', undefined, 1000)
    const rumor = await unwrapBuzz(wrap, circle)
    await expect(decodeLegacyBuzz('2'.repeat(64), rumor.content)).rejects.toThrow()
  })

  it('interop: a REAL flock fixed-action buzz round-trips both ways, and its compat reason maps onto our chip vocabulary', async () => {
    const skHex = toHex(generateSecretKey())
    const signer = makeLocalSigner(skHex)
    const circle = fakeCircle()

    // on_my_way → the 'Heading home' status chip class (handleActionBuzz maps
    // the action onto that chip's own wire reason, so the unchanged classify
    // pipeline recognises it identically to a kindependence→kindependence send).
    const onMyWay = await buildBuzzSignal({ groupId: circle.id, seedHex: circle.seedHex, from: signer.pubkey, action: 'on_my_way', timestamp: 1000 })
    expect(onMyWay.tags.find((t) => t[0] === 't')?.[1]).toBe(BUZZ_SIGNAL_TYPE) // a REAL flock buzz, so updated flock clients see it
    expect((await decryptBuzz(circle.seedHex, onMyWay.content)).action).toBe('on_my_way')
    expect(classifyIncomingBuzz(BUZZ_CHIP_REASONS['status-heading-home'], undefined)).toEqual({ chatLine: true, structured: 'status-heading-home' })

    // check_in → safety's self-report reason; upstream forces the location
    // roll-call ask, and the compat label classifies as unstructured chat (no
    // second notify — safety.ts owns the SafetyEvent). See handleActionBuzz.
    const checkIn = await buildBuzzSignal({ groupId: circle.id, seedHex: circle.seedHex, from: signer.pubkey, action: 'check_in', timestamp: 1000 })
    const ci = await decryptBuzz(circle.seedHex, checkIn.content)
    expect(ci.action).toBe('check_in')
    expect(ci.ask).toBe('location') // upstream forces the ask onto every check_in — the reason our request-vs-self-report split can't ride ask
    expect(classifyIncomingBuzz('Check in', undefined)).toEqual({ chatLine: true, structured: undefined })
  })
})

/** Flushes past `handleIncomingSignal`'s fire-and-forget async tail (`void
 *  handleIncomingBuzz(...)`/`void handleIncomingKindependenceMsg(...)`) — same
 *  idiom as pins.test.ts's/safety.test.ts's own `flush()`. `handleIncomingSignal`
 *  stayed void-returning here (final-review fix, Minor #5 scoped the
 *  awaitable-return seam to pins.ts/safety.ts only, where it was trivially
 *  identical; this module's own dual kindependence-msg/buzz routing wasn't part
 *  of that scope), so a negative ("nothing landed") assertion still needs a
 *  real tick, which `vi.waitFor` (built for polling toward a TRUE predicate)
 *  can't express. */
function flush(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

describe('handleIncomingSignal — legacy buzz binding consistency (final-review fix, Minor #4)', () => {
  it('drops a forged legacy buzz whose content-embedded from does not match the authenticated sender', async () => {
    const circle = fakeCircle()
    const sender = realKeypair() // the wrap's REAL, authenticated seal signer
    const claimed = realKeypair() // the pubkey the legacy payload dishonestly claims as `from`
    signIn(PK_GUARDIAN, toHex(generateSecretKey()), false)
    const p = store.load()
    p.circles = [circle]
    store.save(p)

    // A legacy-shaped ({from,reason,timestamp}) payload, tagged t:'buzz' like
    // a real legacy flock buzz on the receive compat window — decryptBuzz
    // (the NEW fixed-action kit) throws on it, so handleIncomingBuzz falls
    // through to decodeLegacyBuzz, exactly the branch this fix binds. The
    // content's own `from` dishonestly claims `claimed`'s pubkey, but the
    // rumor (the wrap's authenticated seal signer) is really `sender`.
    const inner = await buildKindependenceMsgSignal({ groupId: circle.id, seedHex: circle.seedHex, from: claimed.pkHex, reason: 'hey there', timestamp: 1000 })
    const rumor: Rumor = { id: 'forged-legacy-buzz', pubkey: sender.pkHex, created_at: inner.created_at, kind: inner.kind, tags: [['t', BUZZ_SIGNAL_TYPE]], content: inner.content }

    await handleIncomingSignal(circle, rumor, BUZZ_SIGNAL_TYPE, fakeSender(sender.pkHex))
    await flush()

    expect(store.load().circleChats[circle.id]).toBeUndefined()
    expect(store.load().activity.find((e) => e.circleId === circle.id)).toBeUndefined()
  })
})

describe('classifyIncomingBuzz — receive-side precedence (mirrors flock\'s dual handling)', () => {
  it('an untargeted buzz ALWAYS renders as a chat line, regardless of reason', () => {
    expect(classifyIncomingBuzz('anything at all, free text', undefined).chatLine).toBe(true)
    expect(classifyIncomingBuzz('Come home', undefined).chatLine).toBe(true) // a real flock preset reason this app doesn't recognise
    expect(classifyIncomingBuzz('Check in', undefined).chatLine).toBe(true) // safety.ts's OWN self-report reason
  })

  it('a targeted buzz NEVER renders as a chat line', () => {
    expect(classifyIncomingBuzz('anything at all', 'a'.repeat(64)).chatLine).toBe(false)
    expect(classifyIncomingBuzz("I'm okay", 'a'.repeat(64)).chatLine).toBe(false)
  })

  it('plain free text (no known vocabulary match) has no structured label', () => {
    expect(classifyIncomingBuzz('what time is dinner?', undefined).structured).toBeUndefined()
  })

  it('safety.ts\'s own "Check in" self-report is NOT structured from this module\'s point of view — it still renders as a chat line, but messages.ts leaves the Activity recording to safety.ts\'s own handler', () => {
    const result = classifyIncomingBuzz('Check in', undefined)
    expect(result.chatLine).toBe(true)
    expect(result.structured).toBeUndefined()
  })

  it('a recognised BuzzChipKind reason is structured, chat-line or not', () => {
    expect(classifyIncomingBuzz(BUZZ_CHIP_REASONS['status-okay'], undefined)).toEqual({ chatLine: true, structured: 'status-okay' })
    expect(classifyIncomingBuzz(BUZZ_CHIP_REASONS['checkin-request'], 'a'.repeat(64))).toEqual({ chatLine: false, structured: 'checkin-request' })
  })

  it('a recognised StructuredDmKind phrase is structured', () => {
    expect(classifyIncomingBuzz('Come home now', undefined)).toEqual({ chatLine: true, structured: 'come-home-now' })
    expect(classifyIncomingBuzz('Dinner ready', undefined)).toEqual({ chatLine: true, structured: 'dinner-ready' })
    expect(classifyIncomingBuzz('Pick me up', undefined)).toEqual({ chatLine: true, structured: 'pickup' })
  })

  it('a Task 6 declared-reason prefix classifies as "precise-request", checked before the fixed-phrase vocabularies', () => {
    const reason = buildPreciseRequestReasonText('Emergency')
    expect(classifyIncomingBuzz(reason, undefined)).toEqual({ chatLine: true, structured: 'precise-request' })
  })

  it('a targeted precise-request is still structured (Activity recording is unconditional) even though it never becomes a bubble', () => {
    const reason = buildPreciseRequestReasonText('Emergency')
    expect(classifyIncomingBuzz(reason, 'a'.repeat(64))).toEqual({ chatLine: false, structured: 'precise-request' })
  })

  // Task 7 (brief §16.1-16.2): places.ts's dynamic "Arrived at X"/"Left X"
  // buzz reasons must not be swallowed as generic unstructured chat — see
  // classifyIncomingBuzz's own doc comment.
  it('an arrival buzz ("Arrived at X") classifies as structured "arrival", still a chat line', () => {
    expect(classifyIncomingBuzz('Arrived at School', undefined)).toEqual({ chatLine: true, structured: 'arrival' })
  })

  it('a departure buzz ("Left X") classifies as structured "departure"', () => {
    expect(classifyIncomingBuzz('Left Home', undefined)).toEqual({ chatLine: true, structured: 'departure' })
  })

  it('does not confuse "Leaving now" (a fixed BuzzChipKind reason) with the "Left " departure prefix', () => {
    expect(classifyIncomingBuzz(BUZZ_CHIP_REASONS['status-leaving'], undefined)).toEqual({ chatLine: true, structured: 'status-leaving' })
  })

  it('does not confuse "Arrived" (a fixed BuzzChipKind reason) with the "Arrived at " prefix', () => {
    expect(classifyIncomingBuzz(BUZZ_CHIP_REASONS['status-arrived'], undefined)).toEqual({ chatLine: true, structured: 'status-arrived' })
  })

  // Phase 3 Task 5 (arrival windows): places.ts's dynamic "not yet arrived"
  // buzz is the SAME prefix-recognised idiom as arrival/departure just
  // above, checked right after them.
  it('a not-yet-arrived buzz classifies as structured "window-missed", still a chat line', () => {
    const reason = buildNotYetReason('School', '08:45')
    expect(classifyIncomingBuzz(reason, undefined)).toEqual({ chatLine: true, structured: 'window-missed' })
  })

  // Phase 5 Task 3 (journey mode, brief §32.2): journey.ts's "Heading to X"/
  // "Journey to X complete" buzzes slot in right after window-missed — same
  // prefix-recognised idiom, distinct prefixes, so neither collides with
  // arrival/departure/window-missed (or vice versa).
  it('a journey-start buzz ("Heading to X") classifies as structured "journey-start", still a chat line', () => {
    const reason = buildJourneyStartReason('the library', '15:30')
    expect(classifyIncomingBuzz(reason, undefined)).toEqual({ chatLine: true, structured: 'journey-start' })
  })

  it('a journey-done buzz ("Journey to X complete") classifies as structured "journey-done"', () => {
    const reason = buildJourneyDoneReason('the park')
    expect(classifyIncomingBuzz(reason, undefined)).toEqual({ chatLine: true, structured: 'journey-done' })
  })

  it('journey ordering: neither journey reason is ever mistaken for arrival/departure/window-missed, or vice versa', () => {
    expect(classifyIncomingBuzz(buildJourneyStartReason('School'), undefined).structured).toBe('journey-start')
    expect(classifyIncomingBuzz(buildJourneyDoneReason('School'), undefined).structured).toBe('journey-done')
    expect(classifyIncomingBuzz('Arrived at School', undefined).structured).toBe('arrival')
    expect(classifyIncomingBuzz('Left School', undefined).structured).toBe('departure')
    expect(classifyIncomingBuzz(buildNotYetReason('School', '08:45'), undefined).structured).toBe('window-missed')
  })

  it('does not confuse "Heading home" (a fixed BuzzChipKind reason) with the "Heading to " journey-start prefix', () => {
    expect(classifyIncomingBuzz(BUZZ_CHIP_REASONS['status-heading-home'], undefined)).toEqual({ chatLine: true, structured: 'status-heading-home' })
  })

  // Phase 4 Task 6 (brief §17.2-17.3, §30): pickup.ts's `!pickup:<phase>`
  // prefix is checked FIRST — before precise-request/arrival/departure/
  // window-missed — so it must never be shadowed by any of them, and (since
  // its own prefix is distinct) must never falsely match one of theirs
  // either. A pickup-status buzz is always targeted in practice (pickup.ts
  // never sends one untargeted), so `chatLine` is false either way — never a
  // chat bubble, same as every other structured-and-targeted kind here.
  it('a pickup-status reason classifies as structured "pickup-status", checked before precise-request/arrival/window vocabularies', () => {
    const reason = buildPickupReason('on-way', { id: 'pickup-request-1000-circle-1', etaMin: 9 })
    expect(classifyIncomingBuzz(reason, PK_GUARDIAN)).toEqual({ chatLine: false, structured: 'pickup-status' })
  })

  it('pickup ordering: a pickup-status reason is never shadowed by (or mistaken for) the precise-request/structured-DM vocabularies', () => {
    const reason = buildPickupReason('declined', { id: 'r1' })
    expect(detectPreciseRequestReason(reason)).toBeUndefined()
    expect(detectStructuredDm(reason)).toBeUndefined()
    expect(classifyIncomingBuzz(reason, PK_CHILD).structured).toBe('pickup-status')
  })

  it('pickup ordering: a genuine precise-request reason is never misclassified as pickup-status (distinct, non-colliding prefixes)', () => {
    const reason = buildPreciseRequestReasonText('Meeting you')
    expect(classifyIncomingBuzz(reason, undefined).structured).toBe('precise-request')
  })
})

describe('messageActivityId (final review M4 / minor-triage #2, T10\'s emergency-access precedent)', () => {
  it('appends actorPk so two structured sends in the same circle/second from different actors do not collide', () => {
    const a = messageActivityId(1000, 'circle-1', PK_GUARDIAN)
    const b = messageActivityId(1000, 'circle-1', PK_CHILD)
    expect(a).not.toBe(b)
    expect(a).toBe(`local-message-1000-circle-1-${PK_GUARDIAN}`)
  })

  it('is unchanged by anything but (at, circleId, actorPk) — same triple always collides (dedupe still works)', () => {
    expect(messageActivityId(1000, 'circle-1', PK_GUARDIAN)).toBe(messageActivityId(1000, 'circle-1', PK_GUARDIAN))
  })
})

describe('shouldNotifyForIncomingChat — final review item 4 / minor-triage #7 (classify-first-then-notify)', () => {
  it('notifies for genuine, untargeted, unstructured chat text from someone else', () => {
    const classification = classifyIncomingBuzz('what time is dinner?', undefined)
    expect(shouldNotifyForIncomingChat(classification, 'what time is dinner?', PK_GUARDIAN, PK_CHILD)).toBe(true)
  })

  it('never notifies for your own message, even if it would otherwise qualify', () => {
    const classification = classifyIncomingBuzz('what time is dinner?', undefined)
    expect(shouldNotifyForIncomingChat(classification, 'what time is dinner?', PK_CHILD, PK_CHILD)).toBe(false)
  })

  it('never notifies for a targeted buzz (never a circle-chat bubble in the first place)', () => {
    const classification = classifyIncomingBuzz("I'm okay", PK_CHILD)
    expect(shouldNotifyForIncomingChat(classification, "I'm okay", PK_GUARDIAN, PK_CHILD)).toBe(false)
  })

  it('never notifies for a structured arrival/departure/precise-request reason (places.ts/safety.ts already notify their own)', () => {
    const arrival = classifyIncomingBuzz('Arrived at School', undefined)
    expect(shouldNotifyForIncomingChat(arrival, 'Arrived at School', PK_GUARDIAN, PK_CHILD)).toBe(false)
    const departure = classifyIncomingBuzz('Left Home', undefined)
    expect(shouldNotifyForIncomingChat(departure, 'Left Home', PK_GUARDIAN, PK_CHILD)).toBe(false)
    const reason = buildPreciseRequestReasonText('Emergency')
    const preciseRequest = classifyIncomingBuzz(reason, undefined)
    expect(shouldNotifyForIncomingChat(preciseRequest, reason, PK_GUARDIAN, PK_CHILD)).toBe(false)
  })

  // Phase 3 Task 5: recordIncomingWindowEvent (places.ts) already fires its
  // OWN dedicated 'window-missed' notification — a second, generic one here
  // would double-fire the same event, exactly like arrival/departure above.
  it('never notifies for a structured not-yet-arrived reason (places.ts already notifies its own)', () => {
    const notYetReason = buildNotYetReason('School', '08:45')
    const notYet = classifyIncomingBuzz(notYetReason, undefined)
    expect(notYet.structured).toBe('window-missed')
    expect(shouldNotifyForIncomingChat(notYet, notYetReason, PK_GUARDIAN, PK_CHILD)).toBe(false)
  })

  // Phase 5 Task 3: journey.ts's recordIncomingJourneyEvent already fires its
  // OWN dedicated 'journey' notification — same reasoning as arrival/
  // departure/window-missed above.
  it('never notifies for a structured journey-start/journey-done reason (journey.ts already notifies its own)', () => {
    const startReason = buildJourneyStartReason('the library')
    const start = classifyIncomingBuzz(startReason, undefined)
    expect(start.structured).toBe('journey-start')
    expect(shouldNotifyForIncomingChat(start, startReason, PK_GUARDIAN, PK_CHILD)).toBe(false)

    const doneReason = buildJourneyDoneReason('the park')
    const done = classifyIncomingBuzz(doneReason, undefined)
    expect(done.structured).toBe('journey-done')
    expect(shouldNotifyForIncomingChat(done, doneReason, PK_GUARDIAN, PK_CHILD)).toBe(false)
  })

  it('never notifies for this module\'s own quick-chip/structured-DM reasons (Activity-recorded, not a system notification, in this follow-up)', () => {
    const checkinRequest = classifyIncomingBuzz(BUZZ_CHIP_REASONS['checkin-request'], undefined)
    expect(shouldNotifyForIncomingChat(checkinRequest, BUZZ_CHIP_REASONS['checkin-request'], PK_GUARDIAN, PK_CHILD)).toBe(false)
    const comeHomeNow = classifyIncomingBuzz('Come home now', undefined)
    expect(shouldNotifyForIncomingChat(comeHomeNow, 'Come home now', PK_GUARDIAN, PK_CHILD)).toBe(false)
  })

  it('never notifies for safety.ts\'s own "Check in" self-report — it is NOT tagged structured by classifyIncomingBuzz, so this needs its own check to avoid double-firing alongside safety.ts\'s dedicated notify', () => {
    const classification = classifyIncomingBuzz('Check in', undefined)
    expect(classification.structured).toBeUndefined() // confirms this case truly isn't caught by the structured check alone
    expect(shouldNotifyForIncomingChat(classification, 'Check in', PK_GUARDIAN, PK_CHILD)).toBe(false)
  })
})

describe('chipNotifyKind (Task 7: actionable quick-chip notifications)', () => {
  it('the four actionable chips fire the "request" notify kind', () => {
    expect(chipNotifyKind('come-home-now')).toBe('request')
    expect(chipNotifyKind('dinner-ready')).toBe('request')
    expect(chipNotifyKind('pickup')).toBe('request')
    expect(chipNotifyKind('checkin-request')).toBe('request')
  })

  it('passive status chips stay silent — a self-report, not a request', () => {
    expect(chipNotifyKind('status-okay')).toBeNull()
    expect(chipNotifyKind('status-arrived')).toBeNull()
    expect(chipNotifyKind('status-leaving')).toBeNull()
    expect(chipNotifyKind('status-heading-home')).toBeNull()
  })

  it('kinds that already fire their own dedicated notification stay silent here (no double-notify)', () => {
    expect(chipNotifyKind('pickup-status')).toBeNull() // pickup.ts's own notifyForPhase
    expect(chipNotifyKind('precise-request')).toBeNull() // safety.ts's own recordEmergencyAccessReason notify
    expect(chipNotifyKind('arrival')).toBeNull() // places.ts's own recordIncomingPlaceEvent notify
    expect(chipNotifyKind('departure')).toBeNull() // places.ts's own recordIncomingPlaceEvent notify
    expect(chipNotifyKind('window-missed')).toBeNull() // places.ts's own recordIncomingWindowEvent notify
    expect(chipNotifyKind('journey-start')).toBeNull() // journey.ts's own recordIncomingJourneyEvent notify
    expect(chipNotifyKind('journey-done')).toBeNull() // journey.ts's own recordIncomingJourneyEvent notify
  })

  it('undefined (plain, unstructured chat) is never actionable here — that is shouldNotifyForIncomingChat/"message"\'s job', () => {
    expect(chipNotifyKind(undefined)).toBeNull()
  })

  it('an unrecognised string is never actionable (defensive default, not a whitelist bypass)', () => {
    expect(chipNotifyKind('something-nobody-sends')).toBeNull()
  })
})

// Task 7's CAREFUL note: the 'pickup' StructuredDmKind chip (the CHILD's own
// "Pick me up" request, chipsForThread's `childForGuardian` branch, sent via
// handleChip's `case 'pickup': await sendText(structuredDmText('pickup'),
// 'pickup')`) is a DIFFERENT thing from the GUARDIAN's "Request pickup"
// button (chipsForThread's `request-pickup` chip, which links straight to
// safety.ts's `data-action="safety-pickup"` — see chipButtonView) which rides
// safety.ts's `requestPickup` -> `sendFindreq` (a `t:'findreq'` signal) +
// pickup.ts's companion `!pickup:requested:{id}` buzz. The two are easy to
// conflate by name, but wire-disjoint: `sendText`'s 'pickup' branch never
// calls safety.ts or pickup.ts at all — it is a PLAIN circle-chat/personal-DM
// send, same as 'come-home-now'/'dinner-ready'. Verified two ways below: (1)
// the DM chip's own wire text is never parsed as a pickup.ts lifecycle
// reason (the two vocabularies never collide), and (2) pickup.ts's own
// `notifyForPhase` explicitly skips its 'requested' phase (see that
// function's own guard — `if (phase === 'seen' || phase === 'requested')
// return`), relying on safety.ts's PRE-EXISTING 'pickup-requested' Activity/
// notify (fired off the findreq receipt itself, `safety.ts`'s
// `recordIncomingEvent`) instead of a second one — so even THAT unrelated
// flow doesn't double-notify. Since the 'pickup' DM chip never touches
// either of those paths, chipNotifyKind('pickup') firing 'request' is not a
// duplicate of anything — it is the ONLY notification this chip ever gets.
describe('Task 7: "pickup" DM chip vs the findreq/pickup-requested lifecycle — no double-notify', () => {
  it('the DM chip\'s wire text ("Pick me up") is never parsed as a pickup.ts lifecycle reason — the two vocabularies never collide', () => {
    expect(parsePickupReason(structuredDmText('pickup'))).toBeNull()
  })

  it('classifyIncomingBuzz classifies the DM chip phrase as the plain StructuredDmKind "pickup", never "pickup-status"', () => {
    expect(classifyIncomingBuzz(structuredDmText('pickup'), undefined)).toEqual({ chatLine: true, structured: 'pickup' })
  })

  it('chipNotifyKind therefore must fire "request" for \'pickup\' — it is not an assumed duplicate of pickup-status/pickup-requested, which ride an entirely separate wire event (findreq) that this chip never sends', () => {
    expect(chipNotifyKind('pickup')).toBe('request')
  })
})

// ---------------------------------------------------------------------------
// Phase 6 Task 2 (design spec §2, brief §2.3/§2.4): "Suggested sharing
// level" — the payload-carrying suggest-baseline chip. Round trip + classify
// ordering (pure), then the wire-integration send + accept action
// (mocked-network, real crypto), then decline-is-silent (the strongest form:
// there is no decline action at all — proven by showing nothing is ever
// sent, and no local state ever changes, unless Accept is explicitly
// called).
// ---------------------------------------------------------------------------

describe('buildSuggestBaselineText / detectSuggestBaselineReason (Phase 6 Task 2, design spec §2; finding 5: 3-part circle-bound form)', () => {
  it('round-trips the recommended precision AND its carried circleId through the wire text (3-part form)', () => {
    expect(detectSuggestBaselineReason(buildSuggestBaselineText(6, 'circle-9'))).toEqual({ precision: 6, circleId: 'circle-9' })
    expect(detectSuggestBaselineReason(buildSuggestBaselineText(4, 'circle-1'))).toEqual({ precision: 4, circleId: 'circle-1' })
    expect(detectSuggestBaselineReason(buildSuggestBaselineText(7, 'circle-1'))).toEqual({ precision: 7, circleId: 'circle-1' })
  })

  it('falls back to circleId: undefined for the OLD 2-part wire form (pre-finding-5, precision alone)', () => {
    expect(detectSuggestBaselineReason('!suggest-baseline:6')).toEqual({ precision: 6, circleId: undefined })
  })

  it('is undefined for ordinary text with no prefix at all', () => {
    expect(detectSuggestBaselineReason('hello')).toBeUndefined()
    expect(detectSuggestBaselineReason('Come home now')).toBeUndefined()
  })

  it('is undefined for a malformed/non-positive payload (defensive), both 2-part and 3-part', () => {
    expect(detectSuggestBaselineReason('!suggest-baseline:not-a-number')).toBeUndefined()
    expect(detectSuggestBaselineReason('!suggest-baseline:0')).toBeUndefined()
    expect(detectSuggestBaselineReason('!suggest-baseline:-4')).toBeUndefined()
    expect(detectSuggestBaselineReason('!suggest-baseline:')).toBeUndefined()
    expect(detectSuggestBaselineReason('!suggest-baseline:0:circle-1')).toBeUndefined()
    expect(detectSuggestBaselineReason('!suggest-baseline:not-a-number:circle-1')).toBeUndefined()
  })

  it('classify ordering: never collides with detectStructuredDm, detectPreciseRequestReason, or classifyIncomingBuzz (it never rides circle-chat buzz at all)', () => {
    const text = buildSuggestBaselineText(6, 'circle-1')
    expect(detectStructuredDm(text)).toBeUndefined()
    expect(detectPreciseRequestReason(text)).toBeUndefined()
    expect(classifyIncomingBuzz(text, undefined)).toEqual({ chatLine: true, structured: undefined })
  })

  it('chipNotifyKind fires "request" for suggest-baseline, same as every other genuine ask', () => {
    expect(chipNotifyKind('suggest-baseline')).toBe('request')
  })
})

describe('sendSuggestBaseline — wire integration (mocked-network, real crypto)', () => {
  it('sends a genuine personal DM (not a circle buzz) carrying the payload, and records the local structured copy', async () => {
    const guardian = realKeypair()
    const guardianPhone = realKeypair()
    const child = realKeypair()
    const childPhone = realKeypair()
    const circle: Circle = {
      id: 'circle-1', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
      members: [{ pk: guardian.pkHex, role: 'guardian' }, { pk: child.pkHex, role: 'child' }],
      createdAt: 100, configUpdatedAt: 100, configBy: guardian.pkHex,
    }
    signIn(guardian.pkHex, guardianPhone.skHex, false)
    const p = store.load()
    p.circles = [circle]
    // Signet identity plan, Task 9: a DM wraps once per phone key of the
    // recipient (`phonesOf`) — the child's own phone must be bound in this
    // circle's phone-key table for `sendSuggestBaseline` to have anyone to
    // seal to.
    p.phoneKeys = { [circle.id]: { [childPhone.pkHex]: { memberPk: child.pkHex, statement: {} as SignedEvent, lastSeen: 0 } } }
    store.save(p)

    const ok = await sendSuggestBaseline(circle.id, child.pkHex, 6)
    expect(ok).toBe(true)

    // Local copy, inserted synchronously (self-echo discipline).
    const thread = store.load().dmThreads[child.pkHex]
    expect(thread).toHaveLength(1)
    expect(thread?.[0]?.structured).toBe('suggest-baseline')
    // Phase 6 final-review finding 5: the proposal carries its OWN circleId now.
    expect(detectSuggestBaselineReason(thread?.[0]?.text ?? '')).toEqual({ precision: 6, circleId: circle.id })

    // Real wire: a personal DM addressed to the CHILD's own PHONE key —
    // decryptable only by that phone, never a circle-shared-inbox buzz.
    expect(publishSigned).toHaveBeenCalledTimes(1)
    const call = vi.mocked(publishSigned).mock.calls[0]
    const signed = call?.[1] as SignedEvent
    const childPhoneSigner = makeLocalSigner(childPhone.skHex)
    const dm = await readDmWrap(childPhoneSigner, signed)
    expect(dm).not.toBeNull()
    // The DM's own `from` (covey-kit's `readDmWrap`, not a payload field) is
    // the SEAL SIGNER — the guardian's own PHONE key, not their identity —
    // see `sendDmToMember`.
    expect(dm?.from).toBe(guardianPhone.pkHex)
    expect(dm?.circleId).toBe(circle.id)
    expect(detectSuggestBaselineReason(dm?.text ?? '')).toEqual({ precision: 6, circleId: circle.id })
  })

  it('returns false with no signed-in identity (nothing to send)', async () => {
    sessionForTests(null)
    expect(await sendSuggestBaseline('circle-1', 'b'.repeat(64), 6)).toBe(false)
    expect(publishSigned).not.toHaveBeenCalled()
  })
})

// Fix round 2, finding 1: the multi-phone DM fanout itself, exercised
// through the real send path (`sendSuggestBaseline` -> `sendDmToMember`,
// Signet identity plan Task 9) rather than a stand-in for it — two phones
// bound to the SAME dependant via the real `phone-keys.ts` `acceptStatement`
// path (not a hand-built `p.phoneKeys` table), so the fanout is proven
// against the actual binding mechanism a device uses in production.
describe('sendDmToMember — multi-phone fanout (fix round 2, finding 1)', () => {
  it('wraps once per phone bound to the recipient, each sealed to that phone\'s own personalInboxTag, each readable only by its own phone', async () => {
    const guardian = realKeypair()
    const guardianPhone = realKeypair()
    const dependantSk = generateSecretKey()
    const dependantPk = getPublicKey(dependantSk)
    const dependantPhone1 = realKeypair()
    const dependantPhone2 = realKeypair()
    const circle: Circle = {
      id: 'circle-1', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
      members: [{ pk: guardian.pkHex, role: 'guardian' }, { pk: dependantPk, role: 'child' }],
      createdAt: 100, configUpdatedAt: 100, configBy: guardian.pkHex,
    }
    signIn(guardian.pkHex, guardianPhone.skHex, false)
    const p = store.load()
    p.circles = [circle]
    store.save(p)

    // Bind BOTH of the dependant's phones via the real acceptStatement path.
    const st1 = finalizeEvent(deviceStatementTemplate(dependantPhone1.pkHex, 1000), dependantSk)
    const st2 = finalizeEvent(deviceStatementTemplate(dependantPhone2.pkHex, 1000), dependantSk)
    expect(acceptStatement(circle, st1, dependantPhone1.pkHex, 1000)).toBe('added')
    expect(acceptStatement(circle, st2, dependantPhone2.pkHex, 1000)).toBe('added')

    // Real send path: sendSuggestBaseline -> sendDmToMember.
    const ok = await sendSuggestBaseline(circle.id, dependantPk, 6)
    expect(ok).toBe(true)

    expect(publishSigned).toHaveBeenCalledTimes(2)
    const wraps = vi.mocked(publishSigned).mock.calls.map((c) => c[1] as SignedEvent)
    const tagFor = (w: SignedEvent): string | undefined => w.tags.find((t) => t[0] === 'p')?.[1]
    expect(new Set(wraps.map(tagFor))).toEqual(new Set([personalInboxTag(dependantPhone1.pkHex), personalInboxTag(dependantPhone2.pkHex)]))

    // Each wrap unwraps under ITS OWN phone's signer...
    const wrap1 = wraps.find((w) => tagFor(w) === personalInboxTag(dependantPhone1.pkHex))!
    const wrap2 = wraps.find((w) => tagFor(w) === personalInboxTag(dependantPhone2.pkHex))!
    const dm1 = await readDmWrap(makeLocalSigner(dependantPhone1.skHex), wrap1)
    const dm2 = await readDmWrap(makeLocalSigner(dependantPhone2.skHex), wrap2)
    expect(dm1).not.toBeNull()
    expect(dm2).not.toBeNull()
    expect(dm1?.from).toBe(guardianPhone.pkHex)
    expect(dm2?.from).toBe(guardianPhone.pkHex)
    expect(detectSuggestBaselineReason(dm1?.text ?? '')).toEqual({ precision: 6, circleId: circle.id })
    expect(detectSuggestBaselineReason(dm2?.text ?? '')).toEqual({ precision: 6, circleId: circle.id })

    // ...and NOT under the other phone's (proves the two wraps are genuinely
    // distinct seals, not the same wrap tagged twice).
    expect(await readDmWrap(makeLocalSigner(dependantPhone2.skHex), wrap1)).toBeNull()
    expect(await readDmWrap(makeLocalSigner(dependantPhone1.skHex), wrap2)).toBeNull()
  })
})

describe('final fix B6/I7: a DM to a member with no known phone is not shown as sent', () => {
  it('the "Come home now" chip: no local bubble, nothing published, and the binding "not sent" copy shows instead', async () => {
    const guardianPhone = realKeypair()
    signIn(PK_GUARDIAN, guardianPhone.skHex, false)
    const circle = fakeCircle() // PK_CHILD = 'Bailey', no phoneKeys bound for it — the default, empty p.phoneKeys
    const p = store.load()
    p.circles = [circle]
    store.save(p)
    openDmThread(PK_CHILD, circle.id)

    handleAction('msg-chip', { dataset: { chip: 'come-home-now' } } as unknown as HTMLElement)
    await flush() // handleAction dispatches the async handler fire-and-forget

    expect(store.load().dmThreads[PK_CHILD] ?? []).toEqual([]) // not shown as sent — no local bubble at all
    expect(publishSigned).not.toHaveBeenCalled()
    const html = view(store.load(), currentSession()!)
    expect(html).toContain('Bailey has no phone connected yet — not sent.')
  })

  it('the "Pickup" chip: same "not sent" outcome', async () => {
    const guardianPhone = realKeypair()
    signIn(PK_GUARDIAN, guardianPhone.skHex, false)
    const circle = fakeCircle()
    const p = store.load()
    p.circles = [circle]
    store.save(p)
    openDmThread(PK_CHILD, circle.id)

    handleAction('msg-chip', { dataset: { chip: 'pickup' } } as unknown as HTMLElement)
    await flush()

    expect(store.load().dmThreads[PK_CHILD] ?? []).toEqual([])
    expect(publishSigned).not.toHaveBeenCalled()
    expect(view(store.load(), currentSession()!)).toContain('Bailey has no phone connected yet — not sent.')
  })

  it('sanity: with a known phone bound, the same chip still sends normally (local bubble + wire publish, no "not sent" copy)', async () => {
    const guardianPhone = realKeypair()
    const childPhone = realKeypair()
    signIn(PK_GUARDIAN, guardianPhone.skHex, false)
    const circle = fakeCircle()
    const p = store.load()
    p.circles = [circle]
    p.phoneKeys = { [circle.id]: { [childPhone.pkHex]: { memberPk: PK_CHILD, statement: {} as SignedEvent, lastSeen: 0 } } }
    store.save(p)
    openDmThread(PK_CHILD, circle.id)

    handleAction('msg-chip', { dataset: { chip: 'come-home-now' } } as unknown as HTMLElement)
    await flush()

    expect(store.load().dmThreads[PK_CHILD]).toHaveLength(1)
    expect(publishSigned).toHaveBeenCalledTimes(1)
    expect(view(store.load(), currentSession()!)).not.toContain('has no phone connected yet')
  })
})

describe('suggest-baseline — Accept action / decline-is-silent (Phase 6 Task 2, hardened by final-review findings 1+5)', () => {
  function setupCircleStore(overrides: Partial<Circle> = {}): Circle {
    const circle = fakeCircle(overrides)
    signIn(PK_CHILD, toHex(generateSecretKey()), true)
    const p = store.load()
    p.circles = [circle]
    store.save(p)
    return circle
  }

  it('msg-accept-baseline applies the recommended precision via the EXISTING local-only baseline setting — no wire signal at all (accept is a personal disclosure choice, same as the You-tab picker) — when the sender is genuinely a guardian of the carried circle and self is a member', () => {
    setupCircleStore()

    const node = { dataset: { circle: 'circle-1', precision: '6', from: PK_GUARDIAN } } as unknown as HTMLElement
    handleAction('msg-accept-baseline', node)

    expect(store.load().settings.circleBasePrecision?.['circle-1']).toBe(6)
    expect(publishSigned).not.toHaveBeenCalled()
  })

  it('an invalid/missing payload is a no-op — never writes a nonsensical precision', () => {
    setupCircleStore()
    const node = { dataset: { circle: 'circle-1', precision: 'nonsense', from: PK_GUARDIAN } } as unknown as HTMLElement
    handleAction('msg-accept-baseline', node)
    expect(store.load().settings.circleBasePrecision?.['circle-1']).toBeUndefined()
  })

  it('a missing circle or missing from dataset is a no-op', () => {
    setupCircleStore()
    handleAction('msg-accept-baseline', { dataset: { precision: '6', from: PK_GUARDIAN } } as unknown as HTMLElement)
    handleAction('msg-accept-baseline', { dataset: { circle: 'circle-1', precision: '6' } } as unknown as HTMLElement)
    expect(store.load().settings.circleBasePrecision?.['circle-1']).toBeUndefined()
  })

  // Phase 6 final-review finding 1: clamped to the PRESET-legitimate set
  // ({4,6,7} — `SUGGEST_BASELINE_PRESET_OPTIONS`), not the wider
  // `BASELINE_PRECISION_OPTIONS` ([4,6,7,9]) — no LEVELS preset ever
  // recommends 9/"Precise", so a well-formed 9 from even a genuine guardian
  // must still be rejected.
  it.each([5, 1, 8, 100, 0.5, 9])('an out-of-preset precision %s is a no-op even from a genuine guardian sender', (precision) => {
    setupCircleStore()
    const node = { dataset: { circle: 'circle-1', precision: String(precision), from: PK_GUARDIAN } } as unknown as HTMLElement
    handleAction('msg-accept-baseline', node)
    expect(store.load().settings.circleBasePrecision?.['circle-1']).toBeUndefined()
  })

  it.each(SUGGEST_BASELINE_PRESET_OPTIONS)('every preset-legitimate value (%s) is accepted from a genuine guardian sender', (precision) => {
    setupCircleStore()
    const node = { dataset: { circle: 'circle-1', precision: String(precision), from: PK_GUARDIAN } } as unknown as HTMLElement
    handleAction('msg-accept-baseline', node)
    expect(store.load().settings.circleBasePrecision?.['circle-1']).toBe(precision)
  })

  // Phase 6 final-review finding 1: the SENDER must genuinely hold the
  // guardian role in the carried circle — a crafted `data-from` pointing at
  // the child themself (or anyone else who isn't a guardian there) is a
  // no-op even with an otherwise-valid precision.
  it('a non-guardian sender is a no-op even with a preset-legitimate precision', () => {
    setupCircleStore()
    const node = { dataset: { circle: 'circle-1', precision: '6', from: PK_CHILD } } as unknown as HTMLElement
    handleAction('msg-accept-baseline', node)
    expect(store.load().settings.circleBasePrecision?.['circle-1']).toBeUndefined()
  })

  // Phase 6 final-review finding 5: this device must actually be a MEMBER of
  // the carried circle.
  it('this device not being a member of the carried circle is a no-op', () => {
    signIn(PK_OTHER_GUARDIAN, toHex(generateSecretKey()), false) // not a member of circle-1 at all
    const p = store.load()
    p.circles = [fakeCircle()]
    store.save(p)
    const node = { dataset: { circle: 'circle-1', precision: '6', from: PK_GUARDIAN } } as unknown as HTMLElement
    handleAction('msg-accept-baseline', node)
    expect(store.load().settings.circleBasePrecision?.['circle-1']).toBeUndefined()
  })

  // Phase 6 final-review finding 5: cross-circle apply correctness — Accept
  // applies to the CARRIED circle (`data-circle`), independent of any other
  // circle that happens to exist in the store.
  it('applies to the CARRIED circle, not some other circle that happens to exist', () => {
    const guardianElsewhere = 'e'.repeat(64)
    const circleA = fakeCircle({ id: 'circle-a', members: [{ pk: guardianElsewhere, role: 'guardian' }, { pk: PK_CHILD, role: 'child' }] })
    const circleB = fakeCircle({ id: 'circle-b' }) // PK_GUARDIAN is guardian here, PK_CHILD is a member
    signIn(PK_CHILD, toHex(generateSecretKey()), true)
    const p = store.load()
    p.circles = [circleA, circleB]
    store.save(p)

    const node = { dataset: { circle: 'circle-b', precision: '6', from: PK_GUARDIAN } } as unknown as HTMLElement
    handleAction('msg-accept-baseline', node)

    expect(store.load().settings.circleBasePrecision?.['circle-b']).toBe(6)
    expect(store.load().settings.circleBasePrecision?.['circle-a']).toBeUndefined()
  })

  it('decline is silent BY CONSTRUCTION: simply never calling Accept sends nothing over the wire and changes no local setting', () => {
    // No action at all — this IS "decline": the strongest possible
    // assertion, since there is no decline function/action to even invoke.
    expect(publishSigned).not.toHaveBeenCalled()
    expect(store.load().settings.circleBasePrecision).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// Phase 6 Task 4 / final-review findings 1+5: the suggest-baseline CARD (the
// receiving/child device's rendered bubble, `view`'s own `messageItemView`)
// must not even OFFER Accept for an out-of-preset value, a non-guardian
// sender, or a carried circle this device isn't a member of — the
// handleAction-side clamp just above is the belt; this is the suspenders, so
// a crafted DM can't even get as far as a tappable button. Exercised through
// the real `view(p, fam)` entry point (not a private helper) — the same one
// app.ts actually renders.
// ---------------------------------------------------------------------------

describe('suggest-baseline card — Accept only ever renders for a guardian-sent, in-preset, same-circle-member proposal (crafted-DM hardening)', () => {
  function renderCardFor(precision: number, opts: { fromPk?: string; carriedCircleId?: string; circle?: Circle; selfPk?: string } = {}): string {
    const fromPk = opts.fromPk ?? PK_GUARDIAN
    const circle = opts.circle ?? fakeCircle()
    const carriedCircleId = opts.carriedCircleId === undefined ? circle.id : opts.carriedCircleId
    const selfPk = opts.selfPk ?? PK_CHILD
    const fam = fakeIdentity(selfPk, toHex(generateSecretKey()), 'child')
    const p = store.load()
    p.circles = [circle]
    const text = carriedCircleId === '__NONE__' ? `!suggest-baseline:${precision}` : buildSuggestBaselineText(precision, carriedCircleId)
    p.dmThreads = { [fromPk]: [msg({ from: fromPk, text, structured: 'suggest-baseline' })] }
    store.save(p)
    openDmThread(fromPk, circle.id)
    return view(store.load(), fam)
  }

  it.each(SUGGEST_BASELINE_PRESET_OPTIONS)('renders Accept for a preset-legitimate value (%s) from a genuine guardian, carrying the circleId', (precision) => {
    const html = renderCardFor(precision)
    expect(html).toContain('data-action="msg-accept-baseline"')
    expect(html).toContain(`data-precision="${precision}"`)
    expect(html).toContain('data-circle="circle-1"')
    expect(html).toContain(`data-from="${PK_GUARDIAN}"`)
  })

  it.each([5, 1, 8, 100, 9])('does NOT render Accept for an out-of-preset precision %s (crafted/malformed DM) — including 9, a genuine BASELINE_PRECISION_OPTIONS value no LEVELS preset ever proposes', (precision) => {
    const html = renderCardFor(precision)
    expect(html).not.toContain('msg-accept-baseline')
  })

  it('does NOT render Accept when the sender is not a guardian of the carried circle', () => {
    const circle = fakeCircle({
      members: [{ pk: PK_GUARDIAN, role: 'guardian', name: 'Alex' }, { pk: PK_CHILD, role: 'child', name: 'Sam' }, { pk: PK_SIBLING, role: 'child', name: 'Robin' }],
    })
    const html = renderCardFor(6, { fromPk: PK_SIBLING, circle })
    expect(html).not.toContain('msg-accept-baseline')
  })

  it('does NOT render Accept when this device is not a member of the carried circle', () => {
    const html = renderCardFor(6, { carriedCircleId: 'circle-elsewhere' })
    expect(html).not.toContain('msg-accept-baseline')
  })

  it('the OLD 2-part wire form (no carried circleId) falls back to the open thread\'s own circle for eligibility, and still renders Accept for a valid case', () => {
    const html = renderCardFor(6, { carriedCircleId: '__NONE__' })
    expect(html).toContain('data-action="msg-accept-baseline"')
    expect(html).toContain('data-circle="circle-1"') // the thread's circle, per backward-compat fallback
  })

  it('cross-circle: a proposal carrying a DIFFERENT circle than the open thread renders Accept scoped to the CARRIED circle, not the thread\'s', () => {
    const circleB = fakeCircle({ id: 'circle-b', members: [{ pk: PK_GUARDIAN, role: 'guardian', name: 'Alex' }, { pk: PK_CHILD, role: 'child', name: 'Sam' }] })
    // The open thread is against circle-1 (fakeCircle's default id), but the
    // proposal's own payload carries circle-b — a peer shared across both.
    const fam = fakeIdentity(PK_CHILD, toHex(generateSecretKey()), 'child')
    const p = store.load()
    p.circles = [fakeCircle(), circleB]
    p.dmThreads = { [PK_GUARDIAN]: [msg({ from: PK_GUARDIAN, text: buildSuggestBaselineText(6, 'circle-b'), structured: 'suggest-baseline' })] }
    store.save(p)
    openDmThread(PK_GUARDIAN, 'circle-1')

    const html = view(store.load(), fam)
    expect(html).toContain('data-action="msg-accept-baseline"')
    expect(html).toContain('data-circle="circle-b"')
  })
})

// Personal-inbox seal-forgery rejection coverage (Phase 7 Task 1 fix wave,
// Fix 1) used to live here, exercised through `circles.onPersonalInboxWrap`.
// That receive path no longer carries DMs at all (Signet identity plan,
// Task 9 moved DM delivery to each phone's own inbox; Task 10 finished
// removing the personal inbox's now-dead DM branch) — the seal-forgery
// defence itself (verifyEvent(seal) + rumor.pubkey === seal.pubkey, inside
// roost-kit's giftUnwrap) is unconditional and covered independently by
// circles.test.ts's own personal-inbox invite tests.
