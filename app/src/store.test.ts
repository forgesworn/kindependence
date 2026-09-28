import { describe, it, expect, beforeEach, vi } from 'vitest'
import * as store from './store.js'
import type { Circle } from '@forgesworn/covey-kit'
import type { SignedEvent } from '@forgesworn/roost-kit'

// A plausibly-shaped (not cryptographically valid — store.ts never verifies
// what it persists) signed event, reused wherever `Persisted` needs one
// (`session.statement`, `phoneKeys`, `revokedPhoneKeys`, `pendingStatements`).
const statementEvent: SignedEvent = {
  id: '1'.repeat(64), pubkey: 'b'.repeat(64), kind: 30078, created_at: 100,
  tags: [['d', 'kindependence/device/'], ['p', 'd'.repeat(64)]],
  content: 'Authorise this phone to send Kindependence circle messages for me.',
  sig: '2'.repeat(128),
}

// Minimal in-memory localStorage stand-in, installed fresh per test via
// vi.stubGlobal so each test starts with an empty store.
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

describe('store — defaults', () => {
  it('load() returns v1 defaults when nothing is persisted', () => {
    const p = store.load()
    expect(p).toEqual({
      v: 1, circles: [], settings: {}, safetyEvents: [], agreements: [],
      familyPolicies: {}, approvals: [], activity: [], dmThreads: {}, dmLastSeen: {}, circleChats: {}, circleChatLastSeen: {},
      places: {}, placesMeta: {}, placeEval: {}, placeLastEscalatedAt: {}, arrivalWindowMarks: {}, viewPrefs: {},
      meetPoints: {}, meetMeta: {}, pickups: [], agreementTravelMode: {}, leaveFired: {}, journeys: {},
      approvedLeaves: {}, leaveAreaPolicy: {}, mapChecks: { day: '', count: 0, lastAt: 0 },
      independenceLevel: {}, stepUpDismissedUntil: {}, stepUpLastEvaluated: 0,
      stepUpFirstObserved: {}, levelDefaults: {}, pins: {},
      phoneKeys: {}, revokedPhoneKeys: {}, pendingRevocations: {}, pendingStatements: [], seedHashes: {},
      structuralQueue: [], seenPersonalWraps: [], personalWrapRefusals: [],
      seedRecipients: {}, lastRekey: {}, pendingRemovals: {}, pendingRemovalsAt: {}, seenStructural: [], statementPostedAt: {},
      guardianLinks: {}, unlinks: {},
      vouches: {}, circleCreators: {}, unvouchedSince: {}, pendingVouches: {}, heldConfigs: {}, heldRekeys: {}, linkSecrets: {},
      trustPrompts: [],
    })
  })

  it('load() falls back to defaults on corrupt JSON, never throws', () => {
    localStorage.setItem('kindependence.v1', '{not json')
    expect(() => store.load()).not.toThrow()
    expect(store.load()).toEqual({
      v: 1, circles: [], settings: {}, safetyEvents: [], agreements: [],
      familyPolicies: {}, approvals: [], activity: [], dmThreads: {}, dmLastSeen: {}, circleChats: {}, circleChatLastSeen: {},
      places: {}, placesMeta: {}, placeEval: {}, placeLastEscalatedAt: {}, arrivalWindowMarks: {}, viewPrefs: {},
      meetPoints: {}, meetMeta: {}, pickups: [], agreementTravelMode: {}, leaveFired: {}, journeys: {},
      approvedLeaves: {}, leaveAreaPolicy: {}, mapChecks: { day: '', count: 0, lastAt: 0 },
      independenceLevel: {}, stepUpDismissedUntil: {}, stepUpLastEvaluated: 0,
      stepUpFirstObserved: {}, levelDefaults: {}, pins: {},
      phoneKeys: {}, revokedPhoneKeys: {}, pendingRevocations: {}, pendingStatements: [], seedHashes: {},
      structuralQueue: [], seenPersonalWraps: [], personalWrapRefusals: [],
      seedRecipients: {}, lastRekey: {}, pendingRemovals: {}, pendingRemovalsAt: {}, seenStructural: [], statementPostedAt: {},
      guardianLinks: {}, unlinks: {},
      vouches: {}, circleCreators: {}, unvouchedSince: {}, pendingVouches: {}, heldConfigs: {}, heldRekeys: {}, linkSecrets: {},
      trustPrompts: [],
    })
  })
})

describe('store — old pre-Task-5 identity format', () => {
  it('load() clears the whole blob (not just identity) when it finds identity.skHex', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({
      v: 1,
      identity: { role: 'parent', name: 'Alex', skHex: '1'.repeat(64), pkHex: '2'.repeat(64) },
      circles: [{ id: 'a', name: 'Old circle' }],
    }))

    const p = store.load()
    expect(p.circles).toEqual([])
    expect((p as { identity?: unknown }).identity).toBeUndefined()
    // the blob itself was removed, not just coerced in memory
    expect(localStorage.getItem('kindependence.v1')).toBeNull()
  })

  it('leaves an ordinary v1 blob (no identity.skHex) untouched', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({ v: 1, circles: [{ id: 'a', name: 'Keep me' }] }))
    const p = store.load()
    expect(p.circles).toEqual([{ id: 'a', name: 'Keep me' }])
    expect(localStorage.getItem('kindependence.v1')).not.toBeNull()
  })
})

describe('store — legacy voucherGoneAt field', () => {
  it('load() drops a legacy voucherGoneAt field from an old blob without throwing', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({
      v: 1, circles: [], voucherGoneAt: { a: { [`${'b'.repeat(64)}`]: 1000 } },
    }))
    expect(() => store.load()).not.toThrow()
    const p = store.load()
    expect((p as Record<string, unknown>).voucherGoneAt).toBeUndefined()
  })
})

describe('store — round trip', () => {
  it('save() then load() returns the same shape', () => {
    const circle: Circle = {
      id: 'a', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
      members: [{ pk: 'b'.repeat(64), role: 'guardian' }],
      createdAt: 100, configUpdatedAt: 100, configBy: 'b'.repeat(64),
    }
    const p: store.Persisted = {
      v: 1,
      circles: [circle],
      settings: { relayUrl: 'wss://relay.trotters.cc', routingUrl: 'https://routing.example', meetVenues: true },
      safetyEvents: [{ id: 'evt-1', circleId: 'a', from: 'b'.repeat(64), kind: 'checkin', at: 100 }],
      agreements: [{
        agreement: {
          t: 'agreement', id: 'agr-1', circleId: 'a', child: 'b'.repeat(64),
          byUnix: 200, schedule: [{ fromOffsetMin: -15, precision: 9 }], from: 'b'.repeat(64), at: 100,
        },
        status: 'acked',
      }],
      familyPolicies: {
        a: { t: 'family-policy', circleId: 'a', rules: { 'add-member': 'prompt' }, updatedAt: 100, by: 'b'.repeat(64) },
      },
      approvals: [{
        req: { t: 'approval-req', id: 'req-1', action: 'add-member', params: { circleId: 'a' }, from: 'b'.repeat(64), at: 100 },
        circleId: 'a',
      }],
      activity: [{ id: 'act-1', at: 100, kind: 'checkin', circleId: 'a', actorPk: 'b'.repeat(64), params: {} }],
      dmThreads: { [`${'b'.repeat(64)}`]: [{ id: 'dm-1', from: 'b'.repeat(64), text: 'hi', at: 100 }] },
      dmLastSeen: { [`${'b'.repeat(64)}`]: 100 },
      circleChats: { a: [{ id: 'cc-1', from: 'b'.repeat(64), text: 'Dinner ready', at: 100, structured: 'dinner-ready' }] },
      circleChatLastSeen: { a: 100 },
      places: {
        a: [{
          id: 'place-1', name: 'Home', type: 'home', centre: { lat: 51.5, lon: -0.12 }, radiusMetres: 100,
          arrivalNotify: true, departureNotify: false, escalation: 'grace', graceMinutes: 10,
          arrivalWindows: [{ id: 'win-1', days: [1, 2, 3, 4, 5], arriveBy: '08:45', graceMin: 10, enabled: true }],
        }],
      },
      placesMeta: { a: { updatedAt: 100, by: 'b'.repeat(64) } },
      placeEval: { a: { phase: 'grace', placeName: 'Home', graceEndsAt: 700 } },
      placeLastEscalatedAt: { 'a:Home': 90 },
      arrivalWindowMarks: { 'win-1': { day: '2026-07-20', met: true } },
      viewPrefs: { [`${'b'.repeat(64)}`]: { mutedUntil: 200, pinned: true } },
      meetPoints: {
        a: [{
          id: 'meet-1', name: 'Park gate', centre: { lat: 51.5, lon: -0.1 },
          expiresAt: 5000, createdBy: 'b'.repeat(64), createdAt: 4000,
        }],
      },
      meetMeta: { a: { updatedAt: 100, by: 'b'.repeat(64) } },
      pickups: [{
        id: 'pickup-request-100-a', circleId: 'a', childPk: 'b'.repeat(64), collectorPk: 'c'.repeat(64),
        phase: 'on-way', at: 200, etaMin: 12, direction: 'request', seenSent: true,
      }],
      agreementTravelMode: { 'agr-1': 'cycle' },
      leaveFired: { 'agr-1:200:soon': true },
      journeys: {
        a: {
          id: 'journey-1', circleId: 'a', dest: { kind: 'place', id: 'place-1', label: 'Home' },
          expectedBy: 300, startedAt: 100, floorPrecision: 7,
        },
      },
      approvedLeaves: { a: [{ placeId: 'place-1', until: 900 }] },
      leaveAreaPolicy: { a: 'prompt' },
      mapChecks: { day: '2026-07-20', count: 3, lastAt: 100 },
      frictionDismissedDay: '2026-07-19',
      independenceLevel: { [`a:${'b'.repeat(64)}`]: 2 },
      stepUpDismissedUntil: { [`a:${'b'.repeat(64)}`]: 900 },
      stepUpLastEvaluated: 500,
      stepUpFirstObserved: { [`a:${'b'.repeat(64)}`]: 400 },
      levelDefaults: { a: { graceMinutes: 5 } },
      pins: {
        a: [
          { id: 'pin-1', from: 'b'.repeat(64), kind: 'car', geohash: 'gcpvj0', precision: 9, timestamp: 100 },
          { id: 'pin-1', from: 'c'.repeat(64), kind: 'car', geohash: 'gcpvj0', precision: 9, timestamp: 200, removed: true },
        ],
      },
      session: {
        identityPk: 'b'.repeat(64), dependant: false, name: 'Alex',
        transport: { kind: 'nip55', packageName: 'app.example.signer' },
        phonePk: 'd'.repeat(64), statement: statementEvent,
      },
      phoneKeys: { a: { [`${'d'.repeat(64)}`]: { memberPk: 'b'.repeat(64), statement: statementEvent, lastSeen: 100 } } },
      revokedPhoneKeys: { [`${'e'.repeat(64)}`]: statementEvent },
      pendingRevocations: { [`${'c'.repeat(64)}`]: [statementEvent] },
      pendingStatements: [{ circleId: 'a', event: statementEvent }],
      seedHashes: { a: ['f'.repeat(64)] },
      structuralQueue: [{
        id: 'queued-1', action: 'config', circleId: 'a', payload: '{}', label: 'Update circle',
        status: 'waiting', createdAt: 100, attempts: 0,
      }],
      seenPersonalWraps: ['wrap-1'],
      personalWrapRefusals: ['0123456789abcdef:1'],
      seedRecipients: { a: ['d'.repeat(64)] },
      lastRekey: { a: { prev: 'f'.repeat(64), id: '1'.repeat(64), signerPk: '2'.repeat(64), removals: [], seedRecipients: ['d'.repeat(64)], mine: false, createdAt: 1, appliedAt: 2, before: { removedPks: [], removals: {}, members: [], phones: {} } } },
      pendingRemovals: { a: ['b'.repeat(64)] },
      pendingRemovalsAt: { a: { ['b'.repeat(64)]: 100 } },
      seenStructural: ['a:' + '1'.repeat(64)],
      statementPostedAt: { a: 1000 },
      guardianLinks: { [`${'b'.repeat(64)}:${'c'.repeat(64)}`]: { g: statementEvent, d: statementEvent } },
      unlinks: { [`${'b'.repeat(64)}:${'c'.repeat(64)}`]: statementEvent },
      vouches: { a: { ['b'.repeat(64)]: statementEvent } },
      circleCreators: { a: 'c'.repeat(64) },
      unvouchedSince: { a: { ['b'.repeat(64)]: 1000 } },
      pendingVouches: { a: [statementEvent] },
      heldConfigs: { a: statementEvent },
      heldRekeys: { a: statementEvent },
      linkSecrets: { ['d'.repeat(64)]: { createdAt: 1000, used: false } },
      trustPrompts: [{ id: 'prompt-1', kind: 'absent', pks: ['b'.repeat(64)], createdAt: 1000 }],
    }
    store.save(p)
    expect(store.load()).toEqual(p)
    expect(localStorage.getItem('kindependence.v1')).toBe(JSON.stringify(p))
  })

  it('update() mutates the persisted state and writes it through', () => {
    store.update((p) => {
      p.settings.relayUrl = 'wss://example.relay'
      p.seenStructural.push('leftover-item')
    })
    const p = store.load()
    expect(p.settings.relayUrl).toBe('wss://example.relay')
    expect(p.seenStructural).toEqual(['leftover-item'])
  })

  it('update() notifies subscribers', () => {
    const fn = vi.fn()
    const unsubscribe = store.subscribe(fn)
    store.update((p) => { p.settings.relayUrl = 'wss://another.relay' })
    expect(fn).toHaveBeenCalledTimes(1)
    unsubscribe()
    store.update((p) => { p.settings.relayUrl = 'wss://yet-another.relay' })
    expect(fn).toHaveBeenCalledTimes(1)
  })
})

describe('pendingRemovalsAt — load() coercion (stale-removal fix: request time per pending removal)', () => {
  it('coerces a missing pendingRemovalsAt key to {}', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({ v: 1, pendingRemovals: { a: ['b'.repeat(64)] } }))
    expect(store.load().pendingRemovalsAt).toEqual({})
  })

  it('coerces a non-object pendingRemovalsAt, and a circle entry whose values are not all numbers, to {}', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({ v: 1, pendingRemovalsAt: 'nope' }))
    expect(store.load().pendingRemovalsAt).toEqual({})
    localStorage.setItem('kindependence.v1', JSON.stringify({ v: 1, pendingRemovalsAt: { a: { ['b'.repeat(64)]: 'nope' } } }))
    expect(store.load().pendingRemovalsAt).toEqual({})
  })

  it('keeps a well-shaped pendingRemovalsAt record', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({ v: 1, pendingRemovalsAt: { a: { ['b'.repeat(64)]: 100 } } }))
    expect(store.load().pendingRemovalsAt).toEqual({ a: { ['b'.repeat(64)]: 100 } })
  })
})

describe('arrivalWindowMarks — load() coercion (Phase 3 Task 4: shape lands now, Task 5 owns the values)', () => {
  const base = {
    v: 1, circles: [], settings: {}, safetyEvents: [], agreements: [],
    familyPolicies: {}, approvals: [], activity: [], dmThreads: {}, dmLastSeen: {}, circleChats: {}, circleChatLastSeen: {},
    places: {}, placesMeta: {}, placeEval: {}, placeLastEscalatedAt: {},
  }

  it('round-trips a populated arrivalWindowMarks record', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({
      ...base,
      arrivalWindowMarks: {
        'win-1': { day: '2026-07-20', met: true },
        'win-2': { day: '2026-07-21', reminded: true, fired: true },
      },
    }))
    expect(store.load().arrivalWindowMarks).toEqual({
      'win-1': { day: '2026-07-20', met: true },
      'win-2': { day: '2026-07-21', reminded: true, fired: true },
    })
  })

  it('coerces a missing arrivalWindowMarks key to {}', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify(base))
    expect(store.load().arrivalWindowMarks).toEqual({})
  })

  it('coerces a non-object arrivalWindowMarks to {}', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, arrivalWindowMarks: 'not-an-object' }))
    expect(store.load().arrivalWindowMarks).toEqual({})
  })
})

describe('viewPrefs — load() coercion (Phase 4 Task 2: mute/pin, brief §9)', () => {
  const base = {
    v: 1, circles: [], settings: {}, safetyEvents: [], agreements: [],
    familyPolicies: {}, approvals: [], activity: [], dmThreads: {}, dmLastSeen: {}, circleChats: {}, circleChatLastSeen: {},
    places: {}, placesMeta: {}, placeEval: {}, placeLastEscalatedAt: {}, arrivalWindowMarks: {},
  }

  it('round-trips a populated viewPrefs record (mutedUntil + pinned, and a -1 sentinel entry)', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({
      ...base,
      viewPrefs: {
        [`${'aa'.repeat(32)}`]: { mutedUntil: 1234 },
        [`${'bb'.repeat(32)}`]: { pinned: true },
        [`${'cc'.repeat(32)}`]: { mutedUntil: -1 },
      },
    }))
    expect(store.load().viewPrefs).toEqual({
      [`${'aa'.repeat(32)}`]: { mutedUntil: 1234 },
      [`${'bb'.repeat(32)}`]: { pinned: true },
      [`${'cc'.repeat(32)}`]: { mutedUntil: -1 },
    })
  })

  it('coerces a missing viewPrefs key to {}', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify(base))
    expect(store.load().viewPrefs).toEqual({})
  })

  it('coerces a non-object viewPrefs to {}', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, viewPrefs: 'not-an-object' }))
    expect(store.load().viewPrefs).toEqual({})
  })
})

describe('pickups — load() coercion (Phase 4 Task 6: pickup lifecycle, brief §17.2-17.3, §30)', () => {
  const base = {
    v: 1, circles: [], settings: {}, safetyEvents: [], agreements: [],
    familyPolicies: {}, approvals: [], activity: [], dmThreads: {}, dmLastSeen: {}, circleChats: {}, circleChatLastSeen: {},
    places: {}, placesMeta: {}, placeEval: {}, placeLastEscalatedAt: {}, arrivalWindowMarks: {}, viewPrefs: {},
    meetPoints: {}, meetMeta: {},
  }

  it('round-trips a populated pickups array', () => {
    const pickups = [{
      id: 'pickup-offer-100-a', circleId: 'a', childPk: 'b'.repeat(64), collectorPk: 'c'.repeat(64),
      phase: 'suggested', at: 200, suggest: { name: 'Library', lat: 1, lon: 2 }, direction: 'offer',
    }]
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, pickups }))
    expect(store.load().pickups).toEqual(pickups)
  })

  it('coerces a missing pickups key to []', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify(base))
    expect(store.load().pickups).toEqual([])
  })

  it('coerces a non-array pickups to []', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, pickups: 'not-an-array' }))
    expect(store.load().pickups).toEqual([])
  })
})

describe('agreementTravelMode / leaveFired — load() coercion (Phase 4 Task 8: leave reminders, brief §15)', () => {
  const base = {
    v: 1, circles: [], settings: {}, safetyEvents: [], agreements: [],
    familyPolicies: {}, approvals: [], activity: [], dmThreads: {}, dmLastSeen: {}, circleChats: {}, circleChatLastSeen: {},
    places: {}, placesMeta: {}, placeEval: {}, placeLastEscalatedAt: {}, arrivalWindowMarks: {}, viewPrefs: {},
    meetPoints: {}, meetMeta: {}, pickups: [],
  }

  it('round-trips populated agreementTravelMode and leaveFired records', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({
      ...base,
      agreementTravelMode: { 'agr-1': 'drive', 'agr-2': 'walk' },
      leaveFired: { 'agr-1:200:soon': true, 'agr-1:200:now': true },
    }))
    expect(store.load().agreementTravelMode).toEqual({ 'agr-1': 'drive', 'agr-2': 'walk' })
    expect(store.load().leaveFired).toEqual({ 'agr-1:200:soon': true, 'agr-1:200:now': true })
  })

  it('coerces missing agreementTravelMode/leaveFired keys to {}', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify(base))
    expect(store.load().agreementTravelMode).toEqual({})
    expect(store.load().leaveFired).toEqual({})
  })

  it('coerces non-object agreementTravelMode/leaveFired to {}', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, agreementTravelMode: 'nope', leaveFired: 42 }))
    expect(store.load().agreementTravelMode).toEqual({})
    expect(store.load().leaveFired).toEqual({})
  })
})

describe('journeys — load() coercion (Phase 5 Task 3: journey mode, brief §32.2)', () => {
  const base = {
    v: 1, circles: [], settings: {}, safetyEvents: [], agreements: [],
    familyPolicies: {}, approvals: [], activity: [], dmThreads: {}, dmLastSeen: {}, circleChats: {}, circleChatLastSeen: {},
    places: {}, placesMeta: {}, placeEval: {}, placeLastEscalatedAt: {}, arrivalWindowMarks: {}, viewPrefs: {},
    meetPoints: {}, meetMeta: {}, pickups: [], agreementTravelMode: {}, leaveFired: {},
  }

  it('round-trips a populated journeys record', () => {
    const journeys = {
      a: { id: 'journey-1', circleId: 'a', dest: { kind: 'label', label: 'the park' }, startedAt: 100, floorPrecision: 7 },
    }
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, journeys }))
    expect(store.load().journeys).toEqual(journeys)
  })

  it('coerces a missing journeys key to {}', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify(base))
    expect(store.load().journeys).toEqual({})
  })

  it('coerces a non-object journeys to {}', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, journeys: 'nope' }))
    expect(store.load().journeys).toEqual({})
  })
})

describe('approvedLeaves / leaveAreaPolicy — load() coercion (Phase 5 Task 5: boundary-exit requests, brief §13.4)', () => {
  const base = {
    v: 1, circles: [], settings: {}, safetyEvents: [], agreements: [],
    familyPolicies: {}, approvals: [], activity: [], dmThreads: {}, dmLastSeen: {}, circleChats: {}, circleChatLastSeen: {},
    places: {}, placesMeta: {}, placeEval: {}, placeLastEscalatedAt: {}, arrivalWindowMarks: {}, viewPrefs: {},
    meetPoints: {}, meetMeta: {}, pickups: [], agreementTravelMode: {}, leaveFired: {}, journeys: {},
  }

  it('round-trips populated approvedLeaves and leaveAreaPolicy records', () => {
    const approvedLeaves = { a: [{ placeId: 'place-1', until: 5000 }] }
    const leaveAreaPolicy = { a: 'allow' }
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, approvedLeaves, leaveAreaPolicy }))
    expect(store.load().approvedLeaves).toEqual(approvedLeaves)
    expect(store.load().leaveAreaPolicy).toEqual(leaveAreaPolicy)
  })

  it('coerces missing approvedLeaves/leaveAreaPolicy keys to {}', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify(base))
    expect(store.load().approvedLeaves).toEqual({})
    expect(store.load().leaveAreaPolicy).toEqual({})
  })

  it('coerces non-object approvedLeaves/leaveAreaPolicy to {}', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, approvedLeaves: 'nope', leaveAreaPolicy: 42 }))
    expect(store.load().approvedLeaves).toEqual({})
    expect(store.load().leaveAreaPolicy).toEqual({})
  })
})

describe('pins — load() coercion (Phase 7 Task 4: flock pins, design spec §4)', () => {
  const base = {
    v: 1, circles: [], settings: {}, safetyEvents: [], agreements: [],
    familyPolicies: {}, approvals: [], activity: [], dmThreads: {}, dmLastSeen: {}, circleChats: {}, circleChatLastSeen: {},
    places: {}, placesMeta: {}, placeEval: {}, placeLastEscalatedAt: {}, arrivalWindowMarks: {}, viewPrefs: {},
    meetPoints: {}, meetMeta: {}, pickups: [], agreementTravelMode: {}, leaveFired: {}, journeys: {},
    approvedLeaves: {}, leaveAreaPolicy: {},
  }

  it('round-trips a populated pins record (a drop and a retained tombstone, same id)', () => {
    const pins = {
      a: [
        { id: 'pin-1', from: 'b'.repeat(64), kind: 'car', geohash: 'gcpvj0', precision: 9, timestamp: 100 },
        { id: 'pin-2', from: 'c'.repeat(64), kind: 'water', geohash: 'gcpvj1', precision: 9, timestamp: 200, removed: true },
      ],
    }
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, pins }))
    expect(store.load().pins).toEqual(pins)
  })

  it('coerces a missing pins key to {}', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify(base))
    expect(store.load().pins).toEqual({})
  })

  it('coerces a non-object pins to {}', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, pins: 'not-an-object' }))
    expect(store.load().pins).toEqual({})
  })
})

describe('pendingStatements — load() coercion (Signet identity plan Task 7: circle-scoped buffer)', () => {
  const base = {
    v: 1, circles: [], settings: {}, safetyEvents: [], agreements: [],
    familyPolicies: {}, approvals: [], activity: [], dmThreads: {}, dmLastSeen: {}, circleChats: {}, circleChatLastSeen: {},
    places: {}, placesMeta: {}, placeEval: {}, placeLastEscalatedAt: {},
  }

  it('keeps { circleId, event } entries and drops the old bare-event shape', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({
      ...base,
      pendingStatements: [statementEvent, { circleId: 'a', event: statementEvent }, { event: statementEvent }, null],
    }))
    expect(store.load().pendingStatements).toEqual([{ circleId: 'a', event: statementEvent }])
  })

  it('coerces a non-array pendingStatements to []', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, pendingStatements: 'nope' }))
    expect(store.load().pendingStatements).toEqual([])
  })
})

describe('contactsSnapshot — load() coercion (final review B, finding I2)', () => {
  const base = {
    v: 1, circles: [], settings: {}, safetyEvents: [], agreements: [],
    familyPolicies: {}, approvals: [], activity: [], dmThreads: {}, dmLastSeen: {}, circleChats: {}, circleChatLastSeen: {},
    places: {}, placesMeta: {}, placeEval: {}, placeLastEscalatedAt: {},
  }
  const goodContact = { contactId: 'c'.repeat(32), pks: ['b'.repeat(64)], name: 'Ann', tier: 'kin', blocked: false }

  it('round-trips a well-shaped connected snapshot, including truncated', () => {
    const contactsSnapshot = { status: 'connected', contacts: [goodContact], fresh: true, at: 1000, truncated: true }
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, contactsSnapshot }))
    expect(store.load().contactsSnapshot).toEqual(contactsSnapshot)
  })

  it('a contact missing an optional tier round-trips with tier undefined', () => {
    const noTier = { contactId: 'd'.repeat(32), pks: ['e'.repeat(64)], name: 'Bo', blocked: false }
    const contactsSnapshot = { status: 'connected', contacts: [noTier], fresh: false, at: 1000 }
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, contactsSnapshot }))
    expect(store.load().contactsSnapshot).toEqual(contactsSnapshot)
  })

  it('drops a malformed contact entry but keeps the well-shaped ones', () => {
    const contactsSnapshot = { status: 'connected', contacts: [goodContact, { contactId: 'bad' }, null, 'nope'], fresh: true, at: 1000 }
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, contactsSnapshot }))
    expect(store.load().contactsSnapshot).toEqual({ status: 'connected', contacts: [goodContact], fresh: true, at: 1000 })
  })

  it('is undefined when missing', () => {
    localStorage.setItem('kindependence.v1', JSON.stringify(base))
    expect(store.load().contactsSnapshot).toBeUndefined()
  })

  it.each([
    ['an empty object', {}],
    ['an array', []],
    ['a bad status', { status: 'bogus', contacts: [], fresh: true, at: 1 }],
    ['a non-array contacts', { status: 'connected', contacts: 'nope', fresh: true, at: 1 }],
    ['a non-boolean fresh', { status: 'connected', contacts: [], fresh: 'yes', at: 1 }],
    ['a non-numeric at', { status: 'connected', contacts: [], fresh: true, at: '1' }],
    ['a non-boolean truncated', { status: 'connected', contacts: [], fresh: true, at: 1, truncated: 'yes' }],
    ['a future renamed-field shape', { state: 'connected', people: [] }],
  ])('drops the whole snapshot for %s', (_label, garbage) => {
    localStorage.setItem('kindependence.v1', JSON.stringify({ ...base, contactsSnapshot: garbage }))
    expect(() => store.load()).not.toThrow()
    expect(store.load().contactsSnapshot).toBeUndefined()
  })
})
