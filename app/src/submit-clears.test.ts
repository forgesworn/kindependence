import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as store from './store.js'

// Review follow-up to 1e49361: a submit empties its own form fields
// (form-state.ts's `clearField`), so text the user typed can't come back
// into a form that stays on screen, or whose result renders later.

vi.mock('@forgesworn/roost-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgesworn/roost-kit')>()
  return { ...actual, publishSigned: vi.fn(async () => ({})), subscribeGiftWraps: vi.fn(() => () => {}) }
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

type Fake = { tagName: string; id: string; type?: string; value: string; defaultValue?: string; checked?: boolean; defaultChecked?: boolean }

/** A document holding `fields` (by id) and the checked radio per name. */
function fakeDocument(fields: Fake[], radios: Record<string, string> = {}) {
  const byId = new Map(fields.map((f) => [f.id, f]))
  return {
    addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible',
    getElementById: (id: string) => byId.get(id) ?? null,
    querySelector: (sel: string) => {
      const m = /name="([^"]+)"\]:checked/.exec(sel)
      return m && radios[m[1]] ? { value: radios[m[1]] } : null
    },
  }
}

const text = (id: string, value: string, type = 'text'): Fake => ({ tagName: 'INPUT', id, type, value, defaultValue: '' })
const box = (id: string, checked: boolean): Fake => ({ tagName: 'INPUT', id, type: 'checkbox', value: 'on', checked, defaultChecked: false })

const CIRCLE = {
  id: 'c1', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
  members: [{ pk: 'a'.repeat(64), role: 'guardian' }, { pk: 'b'.repeat(64), role: 'child' }],
  createdAt: 100, configUpdatedAt: 100, configBy: 'a'.repeat(64),
}
const node = (data: Record<string, string> = {}) => ({ dataset: data }) as unknown as HTMLElement

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage())
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  store.update((p) => { p.circles = [CIRCLE as never] })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('a submit empties its own form', () => {
  it('meet: name and circle', async () => {
    const circle: Fake = { tagName: 'INPUT', id: 'meet-circle', type: 'text', value: 'c1', defaultValue: '' }
    const name = text('meet-name', 'Park gate')
    vi.stubGlobal('document', fakeDocument([circle, name], { 'meet-expiry': '1h' }))
    const meet = await import('./meet.js')
    meet.openMeetForm({ lat: 51.5, lon: -0.1 })
    meet.handleAction('meet-form-submit', node())
    expect(name.value).toBe('')
  })

  it('agreement: place, time, note and the location tick', async () => {
    const fields = [
      text('agreement-child', 'b'.repeat(64)),
      text('agreement-place-label', 'School gate'),
      box('agreement-use-location', true),
      text('agreement-by-time', '2030-01-01T15:00', 'datetime-local'),
      text('agreement-note', 'be good'),
    ]
    vi.stubGlobal('document', fakeDocument(fields, { 'agreement-schedule': 'default' }))
    const agreements = await import('./agreements.js')
    agreements.handleAction('agreement-new', node({ circle: 'c1' }))
    agreements.handleAction('agreement-create-submit', node({ circle: 'c1' }))
    expect(fields.map((f) => f.type === 'checkbox' ? f.checked : f.value)).toEqual(['', '', false, '', ''])
  })

  it('pickup: the suggested spot', async () => {
    const name = text('pickup-suggest-name', 'Library')
    vi.stubGlobal('document', fakeDocument([name]))
    const pickup = await import('./pickup.js')
    pickup.handleAction('pickup-suggest-open', node({ record: 'r1' }))
    pickup.handleAction('pickup-suggest-submit', node({ record: 'r1' }))
    expect(name.value).toBe('')
  })

  it('pickup: a failed submit (no name) keeps nothing to clear and the form stays', async () => {
    const name = text('pickup-suggest-name', '   ')
    vi.stubGlobal('document', fakeDocument([name]))
    const pickup = await import('./pickup.js')
    pickup.handleAction('pickup-suggest-open', node({ record: 'r1' }))
    pickup.handleAction('pickup-suggest-submit', node({ record: 'r1' }))
    expect(name.value).toBe('   ') // validation failed: what was typed stays
  })

  it('places: the add-place form', async () => {
    const placeFields = [text('place-circle', 'c1'), text('place-name', 'Home'), box('place-arrival-notify', true), box('place-departure-notify', true)]
    vi.stubGlobal('document', fakeDocument(placeFields, { 'place-type': 'home', 'place-radius': '100', 'place-escalation': 'grace' }))
    const places = await import('./places.js')
    places.openPlaceForm({ lat: 51.5, lon: -0.1 })
    places.handleAction('places-form-submit', node())
    expect(placeFields.map((f) => f.type === 'checkbox' ? f.checked : f.value)).toEqual(['', '', false, false])
  })
})
