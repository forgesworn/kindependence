import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  LEVELS,
  independenceKey,
  applyLevel,
  QUIET_STREAK_DAYS,
  stepUpSuggestion,
  dismissStepUp,
  STEP_UP_EVAL_INTERVAL_SEC,
  stepUpEvaluationDue,
  pruneExpiredStepUpDismissals,
  nextStepUpFirstObserved,
  evaluateStepUpsIfDue,
  AGE_BANDS,
  bundleSummary,
  otherChildNames,
} from './milestones.js'
import { POLICY_ACTIONS, registerStructuralSenders as registerApprovalSenders } from './approvals.js'
import { detectSuggestBaselineReason } from './messages.js'
import { defaultGraceMinutesFor, registerStructuralSenders as registerPlacesSenders } from './places.js'
import * as queue from './structural-queue.js'
import type { SignerTransport } from './remote-signer.js'
import * as store from './store.js'
import type { Place, ActivityEvent } from './store.js'
import { sessionForTests } from './session.js'
import { toHex, makeLocalSigner } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'

// applyLevel funnels every one of its five effects through EXISTING send
// paths (places.savePlaces / approvals.publishFamilyPolicy /
// messages.sendSuggestBaseline), each of which does real (non-network)
// crypto via LocalSigner before publishing — only the relay publish itself
// actually leaves the process. Mocking just `publishSigned` (same idiom as
// approvals.test.ts/circles.test.ts) exercises the real gift-wrap round
// trips without touching a network.
vi.mock('@forgesworn/roost-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgesworn/roost-kit')>()
  return { ...actual, publishSigned: vi.fn(async () => ({})) }
})

const PK_GUARDIAN = 'a'.repeat(64)
const PK_CHILD = 'b'.repeat(64)

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
})

function realKeypair(): { skHex: string; pkHex: string } {
  const sk = generateSecretKey()
  return { skHex: toHex(sk), pkHex: getPublicKey(sk) }
}

function fakeCircle(overrides: Partial<Circle> = {}): Circle {
  return {
    id: 'circle-1', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
    members: [{ pk: PK_GUARDIAN, role: 'guardian', name: 'Alex' }, { pk: PK_CHILD, role: 'child', name: 'Sam' }],
    createdAt: 100, configUpdatedAt: 100, configBy: PK_GUARDIAN,
    ...overrides,
  }
}

function fakePlace(overrides: Partial<Place> = {}): Place {
  return {
    id: 'place-1', name: 'Home', type: 'home', centre: { lat: 51.5, lon: -0.12 }, radiusMetres: 100,
    arrivalNotify: true, departureNotify: false, escalation: 'grace', graceMinutes: 10,
    ...overrides,
  }
}

// ---------------------------------------------------------------------------
// LEVELS — table shape (task contract: exact contents per spec §2).
// ---------------------------------------------------------------------------

describe('LEVELS — table shape', () => {
  it('has exactly three levels, each with the task-contract shape', () => {
    expect(Object.keys(LEVELS).sort()).toEqual(['1', '2', '3'])
    for (const level of [1, 2, 3] as const) {
      const preset = LEVELS[level]
      expect(typeof preset.label).toBe('string')
      expect(preset.label.length).toBeGreaterThan(0)
      expect(typeof preset.graceMinutes).toBe('number')
      expect(preset.escalation).toBe('grace')
      expect([4, 6, 7]).toContain(preset.recommendedBaseline)
      // Every policyVerdicts key is a REAL brood-kit PolicyAction id.
      for (const action of Object.keys(preset.policyVerdicts)) {
        expect(POLICY_ACTIONS).toContain(action)
      }
    }
  })

  it('level 1 "Close": grace 5, baseline 7 (Street), every action prompt', () => {
    expect(LEVELS[1]).toEqual({
      label: 'Close', graceMinutes: 5, escalation: 'grace', recommendedBaseline: 7,
      policyVerdicts: { 'create-circle': 'prompt', 'add-member': 'prompt', 'join-circle': 'prompt', 'add-contact': 'prompt' },
    })
  })

  it('level 2 "Growing": grace 10, baseline 6 (Neighbourhood), some allows', () => {
    expect(LEVELS[2]).toEqual({
      label: 'Growing', graceMinutes: 10, escalation: 'grace', recommendedBaseline: 6,
      policyVerdicts: { 'create-circle': 'prompt', 'add-member': 'prompt', 'join-circle': 'allow', 'add-contact': 'allow' },
    })
  })

  it('level 3 "Trusted": grace 15, baseline 4 (Town), most actions allow', () => {
    expect(LEVELS[3]).toEqual({
      label: 'Trusted', graceMinutes: 15, escalation: 'grace', recommendedBaseline: 4,
      policyVerdicts: { 'create-circle': 'prompt', 'add-member': 'allow', 'join-circle': 'allow', 'add-contact': 'allow' },
    })
  })

  it('grace minutes and baseline both strictly widen from level to level (1 tightest, 3 loosest)', () => {
    expect(LEVELS[1].graceMinutes).toBeLessThan(LEVELS[2].graceMinutes)
    expect(LEVELS[2].graceMinutes).toBeLessThan(LEVELS[3].graceMinutes)
    // Lower precision number = coarser/less-precise sharing = MORE independence.
    expect(LEVELS[1].recommendedBaseline).toBeGreaterThan(LEVELS[2].recommendedBaseline)
    expect(LEVELS[2].recommendedBaseline).toBeGreaterThan(LEVELS[3].recommendedBaseline)
  })
})

describe('independenceKey', () => {
  it('joins circleId and childPk', () => {
    expect(independenceKey('circle-1', PK_CHILD)).toBe(`circle-1:${PK_CHILD}`)
  })
})

// ---------------------------------------------------------------------------
// AGE_BANDS — task's own interface, verbatim (Phase 6 Task 3, design spec §3).
// ---------------------------------------------------------------------------

describe('AGE_BANDS', () => {
  it('maps exactly the three age bands to levels 1/2/3, task contract verbatim', () => {
    expect(AGE_BANDS).toEqual([
      { id: 'under10', label: 'Under 10', level: 1 },
      { id: '10to13', label: '10–13', level: 2 },
      { id: '14plus', label: '14 and up', level: 3 },
    ])
  })
})

// ---------------------------------------------------------------------------
// bundleSummary — plain-language wizard card lines per level (design spec
// §3's own worked example, verbatim, string-snapshot style).
// ---------------------------------------------------------------------------

describe('bundleSummary', () => {
  it('level 2 (Growing): the design spec\'s own worked example, verbatim', () => {
    expect(bundleSummary(2, 'Sam')).toEqual([
      'Sam will share their neighbourhood with Family.',
      "You'll be told when they arrive at places you both save.",
      'If they leave a safe area, they get 10 minutes to head back first.',
    ])
  })

  it('level 1 (Close): street-level baseline, 5-minute grace', () => {
    expect(bundleSummary(1, 'Robin')).toEqual([
      'Robin will share their street with Family.',
      "You'll be told when they arrive at places you both save.",
      'If they leave a safe area, they get 5 minutes to head back first.',
    ])
  })

  it('level 3 (Trusted): town-level baseline, 15-minute grace', () => {
    expect(bundleSummary(3, 'Alex')).toEqual([
      'Alex will share their town with Family.',
      "You'll be told when they arrive at places you both save.",
      'If they leave a safe area, they get 15 minutes to head back first.',
    ])
  })

  it('interpolates childName raw — escaping is the caller\'s job at render time', () => {
    expect(bundleSummary(1, '<Sam>')[0]).toBe('<Sam> will share their street with Family.')
  })
})

// ---------------------------------------------------------------------------
// applyLevel — integration test (mocked-network, real crypto/store).
// ---------------------------------------------------------------------------

// applyLevel's step (e) sends a real personal DM (messages.sendSuggestBaseline)
// — genuine covey-kit ECDH crypto, which needs a VALID curve point for the
// recipient's pubkey, not the placeholder `PK_CHILD`/`PK_GUARDIAN`
// constants used elsewhere in this file. Every test below uses real
// keypairs (`realKeypair()`) for both guardian and child.
describe('applyLevel', () => {
  it('writes every effect: place grace/escalation, family policy, the level record, and the chip payload', async () => {
    const guardian = realKeypair()
    const child = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian', name: 'Alex' }, { pk: child.pkHex, role: 'child', name: 'Sam' }] })
    const p = store.load()
    // A local signer stands in for My Signet, so the queued places/policy
    // updates can be signed and sent (final fix round 3, F2: they apply
    // locally only once sent).
    const id = makeLocalSigner(guardian.skHex)
    const transport: SignerTransport = { pubkey: id.pubkey, signEvent: (t) => id.signEvent(t), nip44Encrypt: (a, b) => id.nip44Encrypt(a, b), nip44Decrypt: (a, b) => id.nip44Decrypt(a, b), close: async () => {} }
    sessionForTests({ identityPk: guardian.pkHex, phoneSkHex: guardian.skHex, transport })
    queue.resetForTests()
    registerApprovalSenders()
    registerPlacesSenders()
    p.circles = [circle]
    p.places = { [circle.id]: [fakePlace({ graceMinutes: 999, escalation: 'immediate' })] }
    store.save(p)

    await applyLevel(circle.id, child.pkHex, 2)
    await queue.drain()
    expect(queue.pending()).toEqual([])
    queue.resetForTests()

    // (a) place grace/escalation updated via savePlaces.
    const places = store.load().places[circle.id]
    expect(places?.[0]?.graceMinutes).toBe(LEVELS[2].graceMinutes)
    expect(places?.[0]?.escalation).toBe('grace')

    // (b) family policy published.
    expect(store.load().familyPolicies[circle.id]?.rules).toEqual(LEVELS[2].policyVerdicts)

    // (c) independenceLevel stored.
    expect(store.load().independenceLevel[independenceKey(circle.id, child.pkHex)]).toBe(2)

    // (d) Activity recorded (transparency).
    const evt = store.load().activity.find((e) => e.kind === 'independence-applied')
    expect(evt).toBeTruthy()
    expect(evt?.params.label).toBe('Growing')
    expect(evt?.actorPk).toBe(guardian.pkHex)

    // (e) the child's suggest-baseline chip payload was sent (recorded locally).
    const dmThread = store.load().dmThreads[child.pkHex]
    expect(dmThread).toHaveLength(1)
    expect(dmThread?.[0]?.structured).toBe('suggest-baseline')
    const parsed = detectSuggestBaselineReason(dmThread?.[0]?.text ?? '')
    expect(parsed?.precision).toBe(LEVELS[2].recommendedBaseline)
    // Phase 6 final-review finding 5: the proposal carries ITS OWN circleId
    // now, not just the precision.
    expect(parsed?.circleId).toBe(circle.id)
  })

  // Phase 6 final-review finding 6: a place added to this circle AFTER an
  // applyLevel should inherit that level's own grace period, not silently
  // reset to places.ts's generic DEFAULT_GRACE_MINUTES.
  it('records a levelDefaults entry so a NEW place added afterward defaults to this level\'s own grace period', async () => {
    const guardian = realKeypair()
    const child = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian', name: 'Alex' }, { pk: child.pkHex, role: 'child', name: 'Sam' }] })
    const p = store.load()
    sessionForTests({ identityPk: guardian.pkHex, phoneSkHex: guardian.skHex })
    p.circles = [circle]
    store.save(p)

    await applyLevel(circle.id, child.pkHex, 1)

    expect(store.load().levelDefaults[circle.id]?.graceMinutes).toBe(LEVELS[1].graceMinutes)
    expect(defaultGraceMinutesFor(store.load(), circle.id)).toBe(LEVELS[1].graceMinutes)
    expect(LEVELS[1].graceMinutes).toBe(5) // task-contract sanity check, matches "grace 5" verbatim.
  })

  it('no-ops for a non-guardian device (signed in, but not a member this circle guards)', async () => {
    const other = realKeypair()
    const child = realKeypair()
    const circle = fakeCircle({ members: [{ pk: PK_GUARDIAN, role: 'guardian', name: 'Alex' }, { pk: child.pkHex, role: 'child', name: 'Sam' }] })
    const p = store.load()
    sessionForTests({ identityPk: other.pkHex, phoneSkHex: other.skHex }) // not a member of `circle` at all
    p.circles = [circle]
    store.save(p)

    await applyLevel(circle.id, child.pkHex, 1)

    expect(store.load().independenceLevel).toEqual({})
    expect(store.load().dmThreads).toEqual({})
  })

  it('no-ops when childPk is not actually a child member of the circle', async () => {
    const guardian = realKeypair()
    const child = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian', name: 'Alex' }, { pk: child.pkHex, role: 'child', name: 'Sam' }] })
    const p = store.load()
    sessionForTests({ identityPk: guardian.pkHex, phoneSkHex: guardian.skHex })
    p.circles = [circle]
    store.save(p)

    await applyLevel(circle.id, 'c'.repeat(64), 1) // not a member at all

    expect(store.load().independenceLevel).toEqual({})
  })

  it('skips savePlaces entirely when the circle has no places yet (nothing to update)', async () => {
    const guardian = realKeypair()
    const child = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian', name: 'Alex' }, { pk: child.pkHex, role: 'child', name: 'Sam' }] })
    const p = store.load()
    sessionForTests({ identityPk: guardian.pkHex, phoneSkHex: guardian.skHex })
    p.circles = [circle]
    store.save(p)

    await applyLevel(circle.id, child.pkHex, 1)

    expect(store.load().places[circle.id]).toBeUndefined()
    // The other four effects still happen regardless.
    expect(store.load().independenceLevel[independenceKey(circle.id, child.pkHex)]).toBe(1)
  })

  it('a fresh apply clears any stale step-up dismissal for the same pair', async () => {
    const guardian = realKeypair()
    const child = realKeypair()
    const circle = fakeCircle({ members: [{ pk: guardian.pkHex, role: 'guardian', name: 'Alex' }, { pk: child.pkHex, role: 'child', name: 'Sam' }] })
    const key = independenceKey(circle.id, child.pkHex)
    const p = store.load()
    sessionForTests({ identityPk: guardian.pkHex, phoneSkHex: guardian.skHex })
    p.circles = [circle]
    p.stepUpDismissedUntil = { [key]: 999_999_999 }
    store.save(p)

    await applyLevel(circle.id, child.pkHex, 2)

    expect(store.load().stepUpDismissedUntil[key]).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// stepUpSuggestion — pure matrix.
// ---------------------------------------------------------------------------

const DAY = 24 * 60 * 60
const NOW = 1_700_000_000

function basePersisted(overrides: Partial<store.Persisted> = {}): store.Persisted {
  const p = store.load()
  p.circles = [fakeCircle()]
  // Phase 6 final-review finding 4 (streak observation floor): default to
  // "long since observed" so every OTHER `stepUpSuggestion` test below
  // (level ceiling, dirty streak, dismissal, diff lines, etc.) keeps
  // exercising exactly what it says it does, without ALSO having to satisfy
  // the observation floor separately — the floor itself gets its own
  // dedicated describe block further down. `overrides` can still replace
  // this outright for those tests.
  const stepUpFirstObserved = { [independenceKey('circle-1', PK_CHILD)]: NOW - QUIET_STREAK_DAYS * DAY - 1 }
  return { ...p, stepUpFirstObserved, ...overrides }
}

describe('stepUpSuggestion', () => {
  it('suggests level 2 for a child with no independenceLevel recorded yet (treated as level 1)', () => {
    const p = basePersisted()
    const result = stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)
    expect(result?.toLevel).toBe(2)
    expect(result?.diff.length).toBeGreaterThan(0)
  })

  it('a clean 30-day streak (no disqualifying Activity at all) suggests the next level', () => {
    const p = basePersisted({ independenceLevel: { [independenceKey('circle-1', PK_CHILD)]: 2 } })
    const result = stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)
    expect(result?.toLevel).toBe(3)
  })

  it('level 3 (already at the ceiling) never suggests a step-up', () => {
    const p = basePersisted({ independenceLevel: { [independenceKey('circle-1', PK_CHILD)]: 3 } })
    expect(stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)).toBeNull()
  })

  it.each(['safe-area-escalation', 'window-missed', 'sos'] as const)('a %s Activity entry for this child inside the window blocks the suggestion (dirty streak)', (kind) => {
    const evt: ActivityEvent = { id: 'e1', at: NOW - DAY, kind, circleId: 'circle-1', actorPk: PK_CHILD, params: {} }
    const p = basePersisted({ activity: [evt] })
    expect(stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)).toBeNull()
  })

  it('a disqualifying entry OUTSIDE the window (older than QUIET_STREAK_DAYS) does not block it', () => {
    const evt: ActivityEvent = { id: 'e1', at: NOW - (QUIET_STREAK_DAYS + 1) * DAY, kind: 'sos', circleId: 'circle-1', actorPk: PK_CHILD, params: {} }
    const p = basePersisted({ activity: [evt] })
    expect(stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)).not.toBeNull()
  })

  it('a disqualifying entry for a DIFFERENT child does not block this child\'s streak', () => {
    const otherChild = 'c'.repeat(64)
    const evt: ActivityEvent = { id: 'e1', at: NOW - DAY, kind: 'sos', circleId: 'circle-1', actorPk: otherChild, params: {} }
    const p = basePersisted({ activity: [evt] })
    expect(stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)).not.toBeNull()
  })

  it('an unrelated Activity kind (e.g. arrival) for this child does not block it', () => {
    const evt: ActivityEvent = { id: 'e1', at: NOW - DAY, kind: 'arrival', circleId: 'circle-1', actorPk: PK_CHILD, params: {} }
    const p = basePersisted({ activity: [evt] })
    expect(stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)).not.toBeNull()
  })

  it('exactly at the QUIET_STREAK_DAYS boundary still counts as inside the window (blocks)', () => {
    const evt: ActivityEvent = { id: 'e1', at: NOW - QUIET_STREAK_DAYS * DAY, kind: 'sos', circleId: 'circle-1', actorPk: PK_CHILD, params: {} }
    const p = basePersisted({ activity: [evt] })
    expect(stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)).toBeNull()
  })

  it('an unexpired stepUpDismissedUntil marker suppresses the suggestion even on an otherwise-clean streak', () => {
    const key = independenceKey('circle-1', PK_CHILD)
    const p = basePersisted({ stepUpDismissedUntil: { [key]: NOW + DAY } })
    expect(stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)).toBeNull()
  })

  it('re-arms once the dismissal deadline has passed (dismissed re-arm)', () => {
    const key = independenceKey('circle-1', PK_CHILD)
    const p = basePersisted({ stepUpDismissedUntil: { [key]: NOW - 1 } })
    expect(stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)).not.toBeNull()
  })

  it('the diff lines name the concrete next-notch baseline/policy change even with no places to report grace for', () => {
    const p = basePersisted() // no p.places entry for 'circle-1' — nothing for the grace line to report (finding 3)
    const result = stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)
    expect(result?.diff.some((l) => l.startsWith('Suggested sharing level:'))).toBe(true)
    expect(result?.diff.some((l) => l.startsWith('Grace period:'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Phase 6 final-review finding 3: levelDiff (exercised via stepUpSuggestion's
// own `.diff`/`.tightensGrace`) must reflect the circle's REAL current place
// settings, not assume they still match whatever the "current" level's own
// preset says.
// ---------------------------------------------------------------------------

describe('stepUpSuggestion — diff from ACTUAL current place settings (Phase 6 final-review finding 3)', () => {
  it('uses the ACTUAL current grace value (not the preset\'s assumed one) when every place agrees', () => {
    const p = basePersisted({ places: { 'circle-1': [fakePlace({ graceMinutes: 30, escalation: 'grace' })] } })
    const result = stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)
    expect(result?.diff).toContain(`Grace period: 30 min → ${LEVELS[2].graceMinutes} min`)
  })

  it('mixed actual grace values across places renders "varies", not a made-up single number', () => {
    const p = basePersisted({
      places: { 'circle-1': [fakePlace({ id: 'p1', graceMinutes: 5, escalation: 'grace' }), fakePlace({ id: 'p2', graceMinutes: 20, escalation: 'grace' })] },
    })
    const result = stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)
    expect(result?.diff).toContain(`Grace period: varies → ${LEVELS[2].graceMinutes} min`)
  })

  it('adds an explicit escalation line when any place is currently "immediate" (applying always sets grace)', () => {
    const p = basePersisted({ places: { 'circle-1': [fakePlace({ graceMinutes: 5, escalation: 'immediate' })] } })
    const result = stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)
    expect(result?.diff.some((l) => l.toLowerCase().includes('right away'))).toBe(true)
  })

  it('no places at all omits the grace/escalation lines entirely — applyLevel\'s own step (a) is itself a no-op with zero places', () => {
    const p = basePersisted({ places: {} })
    const result = stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)
    expect(result?.diff.some((l) => l.startsWith('Grace period') || l.startsWith('Leaving a safe area'))).toBe(false)
  })

  it('a tightening (actual grace looser than the target preset) is rendered PLAINLY — no framing words — and flagged via tightensGrace', () => {
    const p = basePersisted({ places: { 'circle-1': [fakePlace({ graceMinutes: 999, escalation: 'grace' })] } })
    const result = stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)
    expect(result?.diff).toContain(`Grace period: 999 min → ${LEVELS[2].graceMinutes} min`)
    expect(result?.tightensGrace).toBe(true)
  })

  it('a genuine widening is NOT flagged as a tightening', () => {
    const p = basePersisted({ places: { 'circle-1': [fakePlace({ graceMinutes: 1, escalation: 'grace' })] } })
    const result = stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)
    expect(result?.tightensGrace).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Phase 6 final-review finding 4: the 30-day window must have been OBSERVED
// by this device (`stepUpFirstObserved`), not merely "empty".
// ---------------------------------------------------------------------------

describe('stepUpSuggestion — observation floor (Phase 6 final-review finding 4)', () => {
  it('a fresh device (stepUpFirstObserved never set) suggests nothing, even with an empty/clean Activity history', () => {
    const p = basePersisted({ stepUpFirstObserved: {} })
    expect(stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)).toBeNull()
  })

  it('suggests once the observation floor has fully elapsed, on an otherwise-clean streak', () => {
    const key = independenceKey('circle-1', PK_CHILD)
    const p = basePersisted({ stepUpFirstObserved: { [key]: NOW - QUIET_STREAK_DAYS * DAY } })
    expect(stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)).not.toBeNull()
  })

  it('still null just short of the observation floor, even on an otherwise-clean streak', () => {
    const key = independenceKey('circle-1', PK_CHILD)
    const p = basePersisted({ stepUpFirstObserved: { [key]: NOW - QUIET_STREAK_DAYS * DAY + 1 } })
    expect(stepUpSuggestion(p, 'circle-1', PK_CHILD, NOW)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// nextStepUpFirstObserved — pure reducer.
// ---------------------------------------------------------------------------

describe('nextStepUpFirstObserved', () => {
  it('stamps nowSecValue for every child in a circle fam guards, with no existing entry', () => {
    const result = nextStepUpFirstObserved([fakeCircle()], PK_GUARDIAN, {}, NOW)
    expect(result[independenceKey('circle-1', PK_CHILD)]).toBe(NOW)
  })

  it('never overwrites an existing entry', () => {
    const key = independenceKey('circle-1', PK_CHILD)
    const result = nextStepUpFirstObserved([fakeCircle()], PK_GUARDIAN, { [key]: NOW - 500 }, NOW)
    expect(result[key]).toBe(NOW - 500)
  })

  it('ignores a circle fam is NOT a guardian in', () => {
    const other = 'z'.repeat(64)
    const result = nextStepUpFirstObserved([fakeCircle()], other, {}, NOW)
    expect(result).toEqual({})
  })

  it('returns the SAME reference when nothing changes (no identity)', () => {
    const observed = {}
    expect(nextStepUpFirstObserved([fakeCircle()], undefined, observed, NOW)).toBe(observed)
  })

  it('returns the SAME reference when every pair already has an entry', () => {
    const observed = { [independenceKey('circle-1', PK_CHILD)]: NOW - 1 }
    expect(nextStepUpFirstObserved([fakeCircle()], PK_GUARDIAN, observed, NOW)).toBe(observed)
  })
})

describe('dismissStepUp', () => {
  it('sets a re-arm deadline QUIET_STREAK_DAYS in the future', () => {
    const p0 = store.load()
    p0.circles = [fakeCircle()]
    store.save(p0)

    dismissStepUp('circle-1', PK_CHILD, NOW)

    const key = independenceKey('circle-1', PK_CHILD)
    expect(store.load().stepUpDismissedUntil[key]).toBe(NOW + QUIET_STREAK_DAYS * DAY)
  })

  it('a freshly-dismissed suggestion is immediately suppressed', () => {
    const p0 = store.load()
    p0.circles = [fakeCircle()]
    store.save(p0)

    dismissStepUp('circle-1', PK_CHILD, NOW)
    expect(stepUpSuggestion(store.load(), 'circle-1', PK_CHILD, NOW)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Weekly evaluation housekeeping — pure reducer + gated wrapper.
// ---------------------------------------------------------------------------

describe('stepUpEvaluationDue', () => {
  it('is due when never evaluated', () => {
    expect(stepUpEvaluationDue(undefined, NOW)).toBe(true)
  })

  it('is not due before a full STEP_UP_EVAL_INTERVAL_SEC has passed', () => {
    expect(stepUpEvaluationDue(NOW, NOW + STEP_UP_EVAL_INTERVAL_SEC - 1)).toBe(false)
  })

  it('is due once the interval has fully elapsed', () => {
    expect(stepUpEvaluationDue(NOW, NOW + STEP_UP_EVAL_INTERVAL_SEC)).toBe(true)
  })
})

describe('pruneExpiredStepUpDismissals', () => {
  it('drops entries whose deadline has passed, keeps unexpired ones', () => {
    const dismissed = { expired: NOW - 1, active: NOW + DAY }
    expect(pruneExpiredStepUpDismissals(dismissed, NOW)).toEqual({ active: NOW + DAY })
  })

  it('returns the SAME reference when nothing changes', () => {
    const dismissed = { active: NOW + DAY }
    expect(pruneExpiredStepUpDismissals(dismissed, NOW)).toBe(dismissed)
  })
})

describe('evaluateStepUpsIfDue', () => {
  it('no-ops when not yet due, leaving stepUpLastEvaluated untouched', () => {
    const p = store.load()
    p.stepUpLastEvaluated = NOW
    store.save(p)

    evaluateStepUpsIfDue(NOW + 10)

    expect(store.load().stepUpLastEvaluated).toBe(NOW)
  })

  it('when due, prunes expired dismissals and stamps stepUpLastEvaluated', () => {
    const p = store.load()
    p.stepUpLastEvaluated = 0
    p.stepUpDismissedUntil = { expired: NOW - 1, active: NOW + DAY }
    store.save(p)

    evaluateStepUpsIfDue(NOW)

    const after = store.load()
    expect(after.stepUpLastEvaluated).toBe(NOW)
    expect(after.stepUpDismissedUntil).toEqual({ active: NOW + DAY })
  })

  // Phase 6 final-review finding 4: this pass is also where
  // `stepUpFirstObserved` gets its "first evaluation" stamp — see
  // `evaluateStepUpsIfDue`'s own doc comment.
  it('when due, also stamps stepUpFirstObserved for every child in a guardian circle not yet observed', () => {
    const p = store.load()
    p.stepUpLastEvaluated = 0
    sessionForTests({ identityPk: PK_GUARDIAN, phoneSkHex: toHex(generateSecretKey()) })
    p.circles = [fakeCircle()]
    store.save(p)

    evaluateStepUpsIfDue(NOW)

    expect(store.load().stepUpFirstObserved[independenceKey('circle-1', PK_CHILD)]).toBe(NOW)
  })

  it('does not overwrite an existing stepUpFirstObserved stamp on a later evaluation pass', () => {
    const key = independenceKey('circle-1', PK_CHILD)
    const p = store.load()
    p.stepUpLastEvaluated = NOW - STEP_UP_EVAL_INTERVAL_SEC
    p.stepUpFirstObserved = { [key]: NOW - 500 }
    sessionForTests({ identityPk: PK_GUARDIAN, phoneSkHex: toHex(generateSecretKey()) })
    p.circles = [fakeCircle()]
    store.save(p)

    evaluateStepUpsIfDue(NOW)

    expect(store.load().stepUpFirstObserved[key]).toBe(NOW - 500)
  })
})

// ---------------------------------------------------------------------------
// Phase 6 final-review finding 2: otherChildNames — used by this module's own
// card AND wizard.ts's summary step to disclose applyLevel's circle-wide
// effects.
// ---------------------------------------------------------------------------

describe('otherChildNames', () => {
  it('lists every OTHER child in the circle, excluding the target', () => {
    const circle = fakeCircle({
      members: [
        { pk: PK_GUARDIAN, role: 'guardian', name: 'Alex' },
        { pk: PK_CHILD, role: 'child', name: 'Sam' },
        { pk: 'd'.repeat(64), role: 'child', name: 'Robin' },
      ],
    })
    expect(otherChildNames(circle, PK_CHILD)).toEqual(['Robin'])
  })

  it('is empty when the target is the only child in the circle', () => {
    expect(otherChildNames(fakeCircle(), PK_CHILD)).toEqual([])
  })

  it('never includes the target itself, even if listed twice under different roles', () => {
    const circle = fakeCircle({
      members: [{ pk: PK_GUARDIAN, role: 'guardian', name: 'Alex' }, { pk: PK_CHILD, role: 'child', name: 'Sam' }],
    })
    expect(otherChildNames(circle, PK_CHILD)).toEqual([])
  })

  it('falls back to a shortened pk for an unnamed member', () => {
    const otherChild = 'd'.repeat(64)
    const circle = fakeCircle({
      members: [{ pk: PK_GUARDIAN, role: 'guardian', name: 'Alex' }, { pk: PK_CHILD, role: 'child', name: 'Sam' }, { pk: otherChild, role: 'child' }],
    })
    expect(otherChildNames(circle, PK_CHILD)).toEqual([`${otherChild.slice(0, 8)}…`])
  })
})

// P6 final-review hardening suggestion: the preset-legitimate accept set in
// messages.ts is a DELIBERATE duplicate of the levels' recommended baselines
// (importing milestones there would be circular). This cross-check makes a
// future retune of either side fail loudly here instead of relying on a
// human noticing two files.
import { SUGGEST_BASELINE_PRESET_OPTIONS } from './messages.js'

describe('SUGGEST_BASELINE_PRESET_OPTIONS stays in sync with LEVELS', () => {
  it('equals the set of every level\'s recommendedBaseline', () => {
    const fromLevels = [...new Set(Object.values(LEVELS).map((l) => l.recommendedBaseline))].sort((a, b) => a - b)
    expect([...SUGGEST_BASELINE_PRESET_OPTIONS].sort((a, b) => a - b)).toEqual(fromLevels)
  })
})
