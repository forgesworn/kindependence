import { expect, it, vi, beforeEach, afterEach } from 'vitest'
import * as store from './store.js'
import { guardianWarnings } from './watchdog.js'
beforeEach(() => vi.stubGlobal('localStorage', { getItem: () => null }))
afterEach(() => vi.restoreAllMocks())
it('warns the guardian after a deadline even when the dependant sends nothing', () => {
  const p = store.load()
  p.circles = [{ id: 'family', name: 'Family', seedHex: '1'.repeat(64), epoch: 0, members: [{pk: 'guardian', role: 'guardian'}, {pk: 'dependant', role: 'child', name: 'Sam'}], createdAt: 1, configUpdatedAt: 1, configBy: 'guardian' }]
  p.agreements = [{ agreement: {t:'agreement', id:'school', circleId:'family', child:'dependant', byUnix:1000, schedule:[], from:'guardian', at:1}, status: 'acked' }]
  expect(guardianWarnings(p, 'guardian', 999)).toEqual([])
  expect(guardianWarnings(p, 'guardian', 1001)[0]?.title).toContain('No arrival confirmation from Sam')
  expect(guardianWarnings(p, 'dependant', 1001)).toEqual([])
  p.agreements[0]!.status = 'arrived'
  expect(guardianWarnings(p, 'guardian', 1001)).toEqual([])
})

it('retains a conservative window confirmation after the beacon ages', async () => {
  const { upsertPosition } = await import('./beacons.js')
  const { encode } = await import('geohash-kit')
  const p = store.load()
  const now = Math.floor(new Date(2026, 10, 3, 10, 0).getTime() / 1000)
  vi.spyOn(Date, 'now').mockReturnValue(now * 1000)
  p.circles = [{ id:'window-family', name:'Family', seedHex:'1'.repeat(64), epoch:0, members:[{pk:'guardian',role:'guardian'},{pk:'dependant',role:'child'}], createdAt:1,configUpdatedAt:1,configBy:'guardian'}]
  p.places = { 'window-family': [{ id:'school', name:'School', centre:{lat:51.5,lon:0}, radiusMetres:300, arrivalNotify:false, departureNotify:false, escalation:'grace', graceMinutes:10, arrivalWindows:[{id:'morning',days:[2],arriveBy:'09:00',graceMin:10,enabled:true}] }] }
  upsertPosition('window-family', 'dependant', {geohash:encode(51.5,0,9),precision:9,at:now})
  expect(guardianWarnings(p, 'guardian', now, (id, at) => { p.settings.guardianWindowConfirmations = {[id]:at} })).toEqual([])
  expect(Object.keys(p.settings.guardianWindowConfirmations ?? {})).toHaveLength(1)
  expect(guardianWarnings(p, 'guardian', now + 600)).toEqual([])
})
