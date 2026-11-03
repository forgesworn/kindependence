// @vitest-environment happy-dom
import { beforeEach, afterEach, it, expect, vi } from 'vitest'
import { makeLocalSigner } from '@forgesworn/covey-kit'
import * as safety from './safety.js'
import * as store from './store.js'
import { sessionForTests } from './session.js'
import { publishOrEnqueue } from './beacons.js'
vi.mock('./beacons.js', async original => ({ ...await original<object>(), publishOrEnqueue: vi.fn(async () => 'sent'), selfFix: () => null }))
vi.mock('./geo.js', async original => ({ ...await original<object>(), currentPosition: vi.fn(async () => null) }))

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
  const pk = makeLocalSigner('2'.repeat(64)).pubkey
  sessionForTests({ identityPk: pk, phoneSkHex: '2'.repeat(64) })
  store.update(p => { p.circles = [{ id: 'family', name: 'Family', seedHex: '1'.repeat(64), epoch: 0, members: [{pk, role: 'guardian'}], createdAt: 1, configUpdatedAt: 1, configBy: pk }] })
  vi.mocked(publishOrEnqueue).mockClear()
})
afterEach(() => { vi.useRealTimers(); document.body.innerHTML = ''; sessionForTests(null); vi.restoreAllMocks() })

it('cancels a hold when its button is removed during a re-render', async () => {
  document.body.innerHTML = safety.sosButtonView()
  safety.wireSos(document.body)
  document.querySelector('button')!.dispatchEvent(new PointerEvent('pointerdown'))
  await vi.advanceTimersByTimeAsync(1000)
  document.body.innerHTML = safety.sosButtonView()
  await vi.advanceTimersByTimeAsync(1000)
  expect(publishOrEnqueue).not.toHaveBeenCalled()
})

it('cancels a released hold', async () => {
  document.body.innerHTML = safety.sosButtonView()
  safety.wireSos(document.body)
  const button = document.querySelector('button')!
  button.dispatchEvent(new PointerEvent('pointerdown'))
  await vi.advanceTimersByTimeAsync(1000)
  button.dispatchEvent(new PointerEvent('pointerup'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(publishOrEnqueue).not.toHaveBeenCalled()
})

it('offers a confirmation for keyboard or assistive activation', async () => {
  document.body.innerHTML = safety.sosButtonView()
  safety.wireSos(document.body)
  const confirm = vi.fn(() => false)
  window.confirm = confirm
  document.querySelector('button')!.dispatchEvent(new MouseEvent('click', { detail: 0 }))
  expect(confirm).toHaveBeenCalledTimes(1)
  expect(publishOrEnqueue).not.toHaveBeenCalled()
})
