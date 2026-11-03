import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { publishSigned, type SignedEvent } from '@forgesworn/roost-kit'
import { deriveInbox, type Circle } from '@forgesworn/covey-kit'
import * as beacons from './beacons.js'
import * as geo from './geo.js'
import * as store from './store.js'
import { sessionForTests } from './session.js'

vi.mock('@forgesworn/roost-kit', async original => ({ ...await original<object>(), publishSigned: vi.fn() }))

const circle: Circle = { id: 'family', name: 'Family', seedHex: '1'.repeat(64), epoch: 0, members: [{ pk: 'a'.repeat(64), role: 'guardian' }], createdAt: 1, configUpdatedAt: 1, configBy: 'a'.repeat(64) }
function event(id: string): SignedEvent {
  return { id, sig: '', pubkey: '', kind: 1059, content: '', created_at: 1, tags: [['p', deriveInbox(circle.seedHex).pk]] }
}
beforeEach(() => {
  const data = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => data.set(k, v), removeItem: (k: string) => data.delete(k), key: (i: number) => [...data.keys()][i], get length() { return data.size } })
  sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: '2'.repeat(64) })
  store.update(p => { p.circles = [structuredClone(circle)] })
  vi.mocked(publishSigned).mockRejectedValue(new Error('offline'))
})
afterEach(() => { beacons.clearOutbox(); sessionForTests(null); vi.restoreAllMocks(); vi.unstubAllGlobals() })

describe('offline delivery', () => {
  it('keeps the newest routine beacon and sends SOS first', async () => {
    for (let i = 0; i < 20; i++) await beacons.publishOrEnqueue([], event(`routine-${i}`), { priority: 'routine', circleId: circle.id })
    await beacons.publishOrEnqueue([], event('sos'), { priority: 'help', circleId: circle.id, help: { memberPk: 'a'.repeat(64), location: null } })
    const sent: string[] = []
    vi.mocked(publishSigned).mockImplementation(async (_relays, e) => { sent.push(e.id); return {} })
    expect(await beacons.flushOutbox()).toEqual({ sent: 2, dropped: 0, remaining: 0 })
    expect(sent).toEqual(['sos', 'routine-19'])
  })

  it('withholds a flush while signed out', async () => {
    await beacons.publishOrEnqueue([], event('old'))
    sessionForTests(null)
    vi.mocked(publishSigned).mockClear().mockResolvedValue({})
    await beacons.flushOutbox()
    expect(publishSigned).not.toHaveBeenCalled()
  })

  it('drops a routine location addressed to a replaced circle seed', async () => {
    await beacons.publishOrEnqueue([], event('old-location'), { priority: 'routine', circleId: circle.id })
    store.update(p => { p.circles[0]!.seedHex = '3'.repeat(64) })
    vi.mocked(publishSigned).mockClear().mockResolvedValue({})
    expect(await beacons.flushOutbox()).toEqual({ sent: 0, dropped: 1, remaining: 0 })
    expect(publishSigned).not.toHaveBeenCalled()
  })

  it('does not resurrect a cleared queue when an in-flight publish fails', async () => {
    let reject!: (e: Error) => void
    vi.mocked(publishSigned).mockImplementation(() => new Promise((_resolve, fail) => { reject = fail }))
    const sending = beacons.publishOrEnqueue([], event('discarded'))
    beacons.clearOutbox()
    reject(new Error('offline'))
    expect(await sending).toBe('failed')
    expect(localStorage.getItem('kindependence.beacons.outbox.v1')).toBeNull()
  })
})

describe('sensor confirmation', () => {
  it('does not reuse an old fix when the sensor cannot confirm it', async () => {
    beacons.feedFix({ lat: 51.5, lon: 0, at: Math.floor(Date.now() / 1000) - 600, accuracy: 10 })
    vi.spyOn(geo, 'currentPosition').mockResolvedValue(null)
    expect(await beacons.freshFix()).toBeNull()
  })

  it('confirms a stationary phone with one shared sensor request', async () => {
    const fix = { lat: 51.5, lon: 0, at: Math.floor(Date.now() / 1000), accuracy: 10 }
    const sensor = vi.spyOn(geo, 'currentPosition').mockResolvedValue(fix)
    const [a, b] = await Promise.all([beacons.freshFix(), beacons.freshFix()])
    expect(a).toEqual(fix)
    expect(b).toEqual(fix)
    expect(sensor).toHaveBeenCalledTimes(1)
  })
})

it('rejects a send built for a previous session or circle seed', async () => {
  const { currentSession } = await import('./session.js')
  const previous = currentSession()
  sessionForTests({ identityPk: 'b'.repeat(64), phoneSkHex: '4'.repeat(64) })
  vi.mocked(publishSigned).mockClear()
  expect(await beacons.publishOrEnqueue([], event('old-session'), { session: previous, circle })).toBe('failed')
  store.update(p => { p.circles[0]!.seedHex = '3'.repeat(64) })
  expect(await beacons.publishOrEnqueue([], event('old-seed'), { circle })).toBe('failed')
  expect(publishSigned).not.toHaveBeenCalled()
})

it('checks the raw phone key when retrying a personal inbox wrap', async () => {
  const { personalInboxTag } = await import('@forgesworn/covey-kit')
  const phone = '3'.repeat(64)
  const signed = { ...event('personal'), tags: [['p', personalInboxTag(phone)]] }
  await beacons.publishOrEnqueue([], signed, { personal: true, recipientPhonePk: phone })
  store.update(p => { p.revokedPhoneKeys[phone] = event('revocation') })
  vi.mocked(publishSigned).mockClear().mockResolvedValue({})
  expect((await beacons.flushOutbox()).dropped).toBe(1)
  expect(publishSigned).not.toHaveBeenCalled()
})

it('reselects priority after each publish and skips replaced routine beacons', async () => {
  await beacons.publishOrEnqueue([], event('first'))
  await beacons.publishOrEnqueue([], event('routine-old'), { priority: 'routine', circleId: circle.id })
  let release!: () => void
  const sent: string[] = []
  vi.mocked(publishSigned).mockImplementation(async (_relays, e) => {
    sent.push(e.id)
    if (e.id === 'first') await new Promise<void>(resolve => { release = resolve })
    return {}
  })
  const flushing = beacons.flushOutbox()
  await vi.waitFor(() => expect(release).toBeDefined())
  vi.mocked(publishSigned).mockRejectedValue(new Error('offline'))
  await beacons.publishOrEnqueue([], event('routine-new'), { priority: 'routine', circleId: circle.id })
  await beacons.publishOrEnqueue([], event('urgent'), { priority: 'help', circleId: circle.id, help: { memberPk: 'a'.repeat(64), location: null } })
  vi.mocked(publishSigned).mockImplementation(async (_relays, e) => { sent.push(e.id); return {} })
  release()
  await flushing
  expect(sent).toEqual(['first', 'urgent', 'routine-new'])
})

it('preserves an SOS timestamp across key rotation and omits an old location', async () => {
  const { giftUnwrap, rawNip44Decrypt } = await import('@forgesworn/roost-kit')
  const { decodeHelp } = await import('./safety.js')
  const at = Math.floor(Date.now() / 1000) - 3600
  await beacons.publishOrEnqueue([], event('help-old'), { priority: 'help', circleId: circle.id, help: { memberPk: 'a'.repeat(64), at, location: { geohash: 'gcpvj0', precision: 6, locationSource: 'beacon' } } })
  const raw = JSON.parse(localStorage.getItem('kindependence.beacons.outbox.v1')!)
  raw[0].queuedAt = at
  localStorage.setItem('kindependence.beacons.outbox.v1', JSON.stringify(raw))
  // Simulate time passing without mutating the in-memory queue snapshot.
  vi.spyOn(Date, 'now').mockReturnValue((at + 7200) * 1000)
  store.update(p => { p.circles[0]!.seedHex = '3'.repeat(64) })
  const inbox = deriveInbox('3'.repeat(64))
  let alert: Awaited<ReturnType<typeof decodeHelp>> = null
  vi.mocked(publishSigned).mockImplementation(async (_relays, signed) => {
    const rumor = await giftUnwrap(rawNip44Decrypt(inbox.sk), signed as SignedEvent)
    alert = await decodeHelp(rumor!, '3'.repeat(64))
    return {}
  })
  await beacons.flushOutbox()
  expect(alert?.timestamp).toBe(at)
  expect(alert?.geohash).toBe('')
})

it('drops queued precise disclosure after the sharing plan is lowered', async () => {
  const at = Math.floor(Date.now() / 1000)
  beacons.feedFix({ lat: 51.5, lon: 0, accuracy: 5, at })
  store.update(p => { p.settings.circleBasePrecision = { [circle.id]: 9 } })
  expect(await beacons.publishOrEnqueue([], event('precise'), { circle, priority: 'routine', routinePrecision: 9, observedAt: at })).toBe('queued')
  store.update(p => { p.settings.circleBasePrecision = { [circle.id]: 4 } })
  vi.mocked(publishSigned).mockClear().mockResolvedValue({})
  expect((await beacons.flushOutbox()).dropped).toBe(1)
  expect(publishSigned).not.toHaveBeenCalled()
})

it('leaves structural retry ownership with the structural queue', async () => {
  await expect(beacons.sendStructural(circle, event('structural'))).rejects.toThrow('offline')
  expect(localStorage.getItem('kindependence.beacons.outbox.v1')).toBeNull()
})
