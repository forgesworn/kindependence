import { describe, it, expect, vi } from 'vitest'
import { captureForm, restoreForm, renderInto, clearField, ActionEpoch, type FieldLike, type RootLike } from './form-state.js'

// A structural stand-in for a rendered field (vitest runs under node here).
function field(o: Partial<FieldLike> & { tagName?: string }): FieldLike & { focus: ReturnType<typeof vi.fn>; setSelectionRange: ReturnType<typeof vi.fn> } {
  const f = {
    tagName: 'INPUT',
    id: '',
    type: 'text',
    value: o.defaultValue ?? '',
    defaultValue: '',
    focus: vi.fn(),
    setSelectionRange: vi.fn(),
    ...o,
  }
  if (f.type === 'checkbox' || f.type === 'radio') {
    const value = o.value ?? 'on'
    f.value = value
    f.getAttribute = (n: string) => (n === 'value' ? value : null)
    if (f.checked === undefined) f.checked = !!f.defaultChecked
  }
  return f as FieldLike & { focus: ReturnType<typeof vi.fn>; setSelectionRange: ReturnType<typeof vi.fn> }
}

function rootOf(...fields: FieldLike[]): RootLike {
  return { querySelectorAll: () => fields }
}

describe('form-state (device check 2026-09-27: typed text wiped by the ~1s location re-render)', () => {
  it('the circle-name field being typed into keeps its text, focus and caret across a background re-render', () => {
    const typed = field({ id: 'circle-name', value: 'PhaseTwo', selectionStart: 8, selectionEnd: 8 })
    const snap = captureForm(rootOf(typed), typed, true)

    const fresh = field({ id: 'circle-name' }) // the new markup: <input id="circle-name">
    restoreForm(rootOf(fresh), snap)

    expect(fresh.value).toBe('PhaseTwo')
    expect(fresh.focus).toHaveBeenCalled()
    expect(fresh.setSelectionRange).toHaveBeenCalledWith(8, 8)
  })

  it('an edited field the user has moved on from also survives a background re-render', () => {
    const a = field({ id: 'meet-name', value: 'Park gate' })
    const b = field({ id: 'meet-note', value: 'by the' })
    const snap = captureForm(rootOf(a, b), b, true)

    const a2 = field({ id: 'meet-name' })
    const b2 = field({ id: 'meet-note' })
    restoreForm(rootOf(a2, b2), snap)

    expect(a2.value).toBe('Park gate')
    expect(b2.value).toBe('by the')
    expect(a2.focus).not.toHaveBeenCalled()
    expect(b2.focus).toHaveBeenCalled()
  })

  it('after an action (submit/navigate) unfocused edits are dropped: the form starts afresh as before', () => {
    const chat = field({ id: 'chat-input', value: 'on my way' })
    const button = {} // focus moved to the tapped button
    const snap = captureForm(rootOf(chat), button, false)

    const fresh = field({ id: 'chat-input' })
    restoreForm(rootOf(fresh), snap)
    expect(fresh.value).toBe('')
  })

  it('the markup wins when it changed the field\'s own starting value', () => {
    const edited = field({ id: 'quiet-start', defaultValue: '22:00', value: '21:30' })
    const snap = captureForm(rootOf(edited), null, true)

    const fresh = field({ id: 'quiet-start', defaultValue: '23:00' })
    restoreForm(rootOf(fresh), snap)
    expect(fresh.value).toBe('23:00')
  })

  it('checkbox ticks and radio choices (id-less, keyed by name + value) survive too', () => {
    const box = field({ id: 'also-ask', type: 'checkbox', checked: true })
    const r1 = field({ name: 'meet-expiry', type: 'radio', value: '1h', defaultChecked: true, checked: false })
    const r2 = field({ name: 'meet-expiry', type: 'radio', value: '3h', checked: true })
    const snap = captureForm(rootOf(box, r1, r2), null, true)

    const box2 = field({ id: 'also-ask', type: 'checkbox' })
    const r1b = field({ name: 'meet-expiry', type: 'radio', value: '1h', defaultChecked: true })
    const r2b = field({ name: 'meet-expiry', type: 'radio', value: '3h' })
    restoreForm(rootOf(box2, r1b, r2b), snap)

    expect(box2.checked).toBe(true)
    expect(r1b.checked).toBe(false)
    expect(r2b.checked).toBe(true)
  })

  it('a field that is gone, or is now a different kind of field, is left alone', () => {
    const typed = field({ id: 'x', value: 'abc' })
    const snap = captureForm(rootOf(typed), typed, true)
    const other = field({ id: 'x', tagName: 'TEXTAREA', type: undefined })
    restoreForm(rootOf(other), snap)
    expect(other.value).toBe('')
    expect(other.focus).not.toHaveBeenCalled()
  })

  it('buttons and hidden inputs are never captured', () => {
    const hidden = field({ id: 'h', type: 'hidden', value: 'x' })
    const snap = captureForm(rootOf(hidden), null, true)
    expect(snap.fields.size).toBe(0)
  })
})

// Review follow-up to e669c93. No DOM library in this project (vitest runs
// under node), so a tiny container stands in for the app root: writing its
// innerHTML re-creates one field object per `<input id=... >` in the
// markup, with its `data-form-scope` — enough to see which writes happen
// and which nodes survive.
function container() {
  let html = ''
  let nodes: Array<ReturnType<typeof field>> = []
  const el = {
    writes: 0,
    get innerHTML() { return html },
    set innerHTML(v: string) {
      el.writes += 1
      html = v
      nodes = [...v.matchAll(/<input id="([^"]+)"(?: data-form-scope="([^"]*)")?/g)].map((m) => {
        const scope = m[2] ?? null
        const f = field({ id: m[1] })
        f.getAttribute = (n: string) => (n === 'data-form-scope' ? scope : null)
        return f
      })
    },
    querySelectorAll: () => nodes,
    getElementById: (id: string) => nodes.find((n) => n.id === id) ?? null,
    node: (id: string) => nodes.find((n) => n.id === id)!,
  }
  return el
}

describe('renderInto (review follow-up: don\'t touch the DOM when nothing visible changed)', () => {
  const chat = (thread: string, messages: string) =>
    `<ul>${messages}</ul><input id="msg-text" data-form-scope="${thread}"><button data-action="msg-send">`

  it('an identical re-render does not write the DOM: the field keeps its node, text, focus and caret', () => {
    const root = container()
    expect(renderInto(root, '<input id="circle-name">', null, true)).toBe(true)
    const typed = root.node('circle-name')
    typed.value = 'PhaseTw'

    // the ~1 s location notify on a screen that doesn't show location
    expect(renderInto(root, '<input id="circle-name">', typed, true)).toBe(false)
    expect(root.writes).toBe(1)
    expect(root.node('circle-name')).toBe(typed)
    expect(typed.value).toBe('PhaseTw')
    expect(typed.focus).not.toHaveBeenCalled()
    expect(typed.setSelectionRange).not.toHaveBeenCalled()
  })

  it('a genuine re-render keeps the typed value (and focus) in the re-created field', () => {
    const root = container()
    renderInto(root, chat('circle:a', '<li>hi</li>'), null, true)
    const typed = root.node('msg-text')
    typed.value = 'on my w'
    typed.selectionStart = 7
    typed.selectionEnd = 7

    expect(renderInto(root, chat('circle:a', '<li>hi</li><li>new</li>'), typed, true)).toBe(true)
    const fresh = root.node('msg-text')
    expect(fresh).not.toBe(typed)
    expect(fresh.value).toBe('on my w')
    expect(fresh.focus).toHaveBeenCalled()
    expect(fresh.setSelectionRange).toHaveBeenCalledWith(7, 7)
  })

  it('Send clears the box and its saved state, even though the box keeps focus', () => {
    const root = container()
    renderInto(root, chat('circle:a', ''), null, true)
    const box = root.node('msg-text')
    box.value = 'on my way'

    clearField('msg-text', root) // msg-send
    expect(box.value).toBe('')
    // The send lands, the list grows; focus is still in the box and the
    // action epoch says "start afresh" only for unfocused fields.
    renderInto(root, chat('circle:a', '<li>on my way</li>'), box, false)
    expect(root.node('msg-text').value).toBe('')
  })

  it('a draft never carries into another thread (the shared #msg-text is scoped by thread)', () => {
    const root = container()
    renderInto(root, chat('dm:c:alice', ''), null, true)
    const box = root.node('msg-text')
    box.value = 'for Alice only'

    renderInto(root, chat('dm:c:bob', ''), box, true)
    expect(root.node('msg-text').value).toBe('')
    expect(root.node('msg-text').focus).not.toHaveBeenCalled()
  })

  it('restoreForm leaves a field alone that was not re-created, or already holds the value', () => {
    const kept = field({ id: 'a', value: 'x' })
    const snap = captureForm(rootOf(kept), kept, true)
    restoreForm(rootOf(kept), snap)
    expect(kept.focus).not.toHaveBeenCalled()
    expect(kept.setSelectionRange).not.toHaveBeenCalled()

    let writes = 0
    const same = field({ id: 'b', value: 'y' })
    const snap2 = captureForm(rootOf(same), null, true)
    const fresh = field({ id: 'b' })
    let v = 'y'
    Object.defineProperty(fresh, 'value', { get: () => v, set: (nv: string) => { writes += 1; v = nv } })
    restoreForm(rootOf(fresh), snap2)
    expect(writes).toBe(0)
  })
})

// Review follow-up to 1e49361: the epoch only advanced when the DOM was
// replaced, so after an action that changed no HTML (a tap whose render was
// identical) the next unrelated location re-render ran with
// keepUnfocused=false and wiped text typed into an unfocused field.
describe('ActionEpoch (an action is consumed by the next render, DOM replaced or not)', () => {
  it('an action with no DOM change does not make the next location re-render discard unfocused edits', () => {
    const epoch = new ActionEpoch()
    const root = container()
    renderInto(root, '<input id="meet-name"><input id="meet-note">', null, epoch.keepUnfocused())
    root.node('meet-name').value = 'Park gate' // typed, then the user moved on
    const note = root.node('meet-note')

    epoch.noteAction() // e.g. a tap on a chip whose render is identical
    expect(renderInto(root, '<input id="meet-name"><input id="meet-note">', note, epoch.keepUnfocused())).toBe(false)

    // ~1 s later a location fix re-renders for real
    expect(renderInto(root, '<p>2m ago</p><input id="meet-name"><input id="meet-note">', note, epoch.keepUnfocused())).toBe(true)
    expect(root.node('meet-name').value).toBe('Park gate')
  })

  it('the render right after an action still starts unfocused fields afresh', () => {
    const epoch = new ActionEpoch()
    expect(epoch.keepUnfocused()).toBe(true)
    epoch.noteAction()
    expect(epoch.keepUnfocused()).toBe(false)
    expect(epoch.keepUnfocused()).toBe(true)
  })
})

describe('clearField', () => {
  it('a select goes back to its markup-selected option, a checkbox to its default', () => {
    const sel = field({ id: 's', tagName: 'SELECT', type: undefined, value: 'b' })
    sel.options = [{ value: 'a', defaultSelected: false }, { value: 'b', defaultSelected: false }, { value: 'c', defaultSelected: true }]
    const box = field({ id: 'x', type: 'checkbox', checked: true, defaultChecked: false })
    const doc = { getElementById: (id: string) => (id === 's' ? sel : id === 'x' ? box : null) }
    clearField('s', doc)
    clearField('x', doc)
    clearField('missing', doc)
    expect(sel.value).toBe('c')
    expect(box.checked).toBe(false)
  })
})
