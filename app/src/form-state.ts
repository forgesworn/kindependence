// Form fields that survive a re-render.
//
// app.ts re-renders by replacing the whole root's innerHTML on every store
// notify. Device check 2026-09-27 (phase 2 step 6): on the Pixel that fires
// about once a second — every foreground location fix (beacons.ts's
// `applyFix`) calls `store.notify()` — so text typed into "Circle name" (or
// any other field, or a ticked checkbox) was wiped within a second, and the
// keyboard closed with it. No field in the app kept its value across a
// render; forms only worked because nothing re-rendered between typing and
// tapping.
//
// So `render()` captures the user's edits before it replaces the markup and
// puts them back afterwards:
//   - the focused field (the one being typed into) always keeps its value,
//     caret and focus;
//   - other edited fields keep theirs too, until the user taps an action —
//     an action is a submit or a navigation, and the markup it renders
//     next is meant to start the form afresh (e.g. an empty chat box after
//     Send, an empty name after Create), exactly as before.
// A field is put back only where the new markup renders the same field
// (same key, same tag and type) with the same default it had before — if
// the markup itself changed what the field starts at, the markup wins.
//
//
// Review follow-up: the root cause is fixed first — `renderInto` does not
// touch the DOM at all when the markup is exactly what it last wrote there,
// so the ~1s location re-render of a screen that doesn't show live location
// no longer recreates any field (no wipe, no focus/IME churn). Capture and
// restore remain the fallback for a genuine re-render, with three rules:
//   - a submit clears its own field (`clearField`): Send empties the chat
//     box even though it is still focused;
//   - a field that wasn't re-created, or already holds the saved value, is
//     left alone — no value write, no re-focus, no caret move;
//   - a field may carry a scope (`data-form-scope`, e.g. the chat thread):
//     its saved value only goes back into the same field in the same scope,
//     so a draft never carries into another thread's `#msg-text`.
//
// Works on a small structural slice of the DOM so it is testable under
// vitest's node environment without a DOM library.

export interface FieldLike {
  tagName: string
  id: string
  name?: string
  type?: string
  value: string
  defaultValue?: string
  checked?: boolean
  defaultChecked?: boolean
  options?: ArrayLike<{ value: string; defaultSelected: boolean }>
  selectionStart?: number | null
  selectionEnd?: number | null
  focus?: (opts?: { preventScroll?: boolean }) => void
  setSelectionRange?: (start: number, end: number) => void
  getAttribute?: (name: string) => string | null
}

export interface RootLike {
  querySelectorAll(selector: string): ArrayLike<unknown>
}

interface FieldState {
  /** the element itself, to tell a re-created field from a kept one */
  node: FieldLike
  tag: string
  type: string
  base: string
  value: string
  checked: boolean | undefined
  selection: [number, number] | null
}

export interface FormSnapshot {
  fields: Map<string, FieldState>
  focusedKey: string | null
}

const FIELDS = 'input, textarea, select'
const SKIP_TYPES = new Set(['button', 'submit', 'reset', 'hidden', 'file', 'image'])
const CHECKABLE = new Set(['checkbox', 'radio'])
const CARET_TYPES = new Set(['text', 'search', 'url', 'tel', 'password', 'textarea'])

function typeOf(el: FieldLike): string {
  const tag = el.tagName.toLowerCase()
  if (tag === 'textarea') return 'textarea'
  if (tag === 'select') return 'select'
  return (el.type || 'text').toLowerCase()
}

/** A stable key for the same field across two renders: its id, or for an
 *  id-less radio/checkbox its name plus its own value. Null: not trackable. */
function keyOf(el: FieldLike): string | null {
  const scope = el.getAttribute?.('data-form-scope')
  const suffix = scope ? `@${scope}` : ''
  if (el.id) return `#${el.id}${suffix}`
  if (!el.name) return null
  const type = typeOf(el)
  if (CHECKABLE.has(type)) return `${el.name}=${el.getAttribute?.('value') ?? el.value}${suffix}`
  return `${el.name}${suffix}`
}

/** What the markup made the field start at. */
function baseOf(el: FieldLike, type: string): string {
  if (CHECKABLE.has(type)) return String(!!el.defaultChecked)
  if (type === 'select') {
    const opts = Array.from(el.options ?? [])
    return (opts.find((o) => o.defaultSelected) ?? opts[0])?.value ?? ''
  }
  return el.defaultValue ?? ''
}

function currentOf(el: FieldLike, type: string): string {
  return CHECKABLE.has(type) ? String(!!el.checked) : el.value
}

function fieldsIn(root: RootLike): FieldLike[] {
  return (Array.from(root.querySelectorAll(FIELDS)) as FieldLike[]).filter((el) => !SKIP_TYPES.has(typeOf(el)))
}

/** The user's edits in `root` right now. `keepUnfocused` false drops every
 *  edit but the focused field's (an action happened since the last render). */
export function captureForm(root: RootLike, active: unknown, keepUnfocused: boolean): FormSnapshot {
  const fields = new Map<string, FieldState>()
  let focusedKey: string | null = null
  for (const el of fieldsIn(root)) {
    const key = keyOf(el)
    if (!key || fields.has(key)) continue
    const type = typeOf(el)
    const focused = el === active
    const base = baseOf(el, type)
    const value = currentOf(el, type)
    if (!focused && (!keepUnfocused || value === base)) continue
    let selection: [number, number] | null = null
    if (focused && CARET_TYPES.has(type) && typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number') {
      selection = [el.selectionStart, el.selectionEnd]
    }
    fields.set(key, { node: el, tag: el.tagName.toLowerCase(), type, base, value: el.value, checked: CHECKABLE.has(type) ? !!el.checked : undefined, selection })
    if (focused) focusedKey = key
  }
  return { fields, focusedKey }
}

/** Puts `snap`'s edits back onto the freshly rendered `root`. */
export function restoreForm(root: RootLike, snap: FormSnapshot): void {
  if (!snap.fields.size) return
  for (const el of fieldsIn(root)) {
    const key = keyOf(el)
    if (!key) continue
    const was = snap.fields.get(key)
    if (!was) continue
    const type = typeOf(el)
    if (was.tag !== el.tagName.toLowerCase() || was.type !== type) continue
    if (el === was.node) continue // not re-created: it still holds its own value, focus and caret
    if (baseOf(el, type) !== was.base) continue // the markup moved the field on: it wins
    if (CHECKABLE.has(type)) {
      if (el.checked !== !!was.checked) el.checked = !!was.checked
    } else if (el.value !== was.value) {
      el.value = was.value
    }
    if (key === snap.focusedKey) {
      try { el.focus?.({ preventScroll: true }) } catch { /* not focusable any more */ }
      if (was.selection) {
        try { el.setSelectionRange?.(was.selection[0], was.selection[1]) } catch { /* type without a caret */ }
      }
    }
  }
}

/** What `renderInto` last wrote into each container. */
const lastHtml = new WeakMap<object, string>()

export interface RenderTarget extends RootLike {
  innerHTML: string
}

/** Puts `html` into `el` — unless it is exactly what was last written
 *  there, in which case the DOM is not touched at all (nothing visible
 *  changed; every field keeps its node, value, focus and caret). A genuine
 *  re-render keeps the user's edits (`captureForm`/`restoreForm`; `active`
 *  and `keepUnfocused` as for `captureForm`). True when the DOM was
 *  replaced — the caller then wires the new nodes. */
export function renderInto(el: RenderTarget, html: string, active: unknown, keepUnfocused: boolean): boolean {
  if (lastHtml.get(el) === html) return false
  const snap = captureForm(el, active, keepUnfocused)
  el.innerHTML = html
  lastHtml.set(el, html)
  restoreForm(el, snap)
  return true
}

/** A submit's own field, emptied: Send, Create, Invite. Form state lives
 *  only in the DOM between renders, so emptying the field (back to its
 *  markup default) is also what the next capture saves — the text can't
 *  come back, not even into a field that keeps focus. */
export function clearField(id: string, doc?: { getElementById(id: string): unknown }): void {
  const d = doc ?? (typeof document !== 'undefined' ? document : null)
  const el = d?.getElementById(id) as FieldLike | null | undefined
  if (!el) return
  const type = typeOf(el)
  if (CHECKABLE.has(type)) el.checked = !!el.defaultChecked
  else el.value = type === 'select' ? baseOf(el, type) : el.defaultValue ?? ''
}

/** `clearField` for each id: a submit's whole form, emptied. */
export function clearFields(ids: readonly string[], doc?: { getElementById(id: string): unknown }): void {
  for (const id of ids) clearField(id, doc)
}

/**
 * Whether the next render keeps unfocused edits (`renderInto`'s
 * `keepUnfocused`). A user action (submit, navigation) makes the render
 * right after it start unfocused fields afresh — and that render consumes
 * the action whether or not it replaced the DOM. Review follow-up to
 * 1e49361: the epoch used to advance only on a DOM replacement, so after an
 * action whose render changed nothing, the next unrelated re-render (a
 * location fix, ~1 s later) still counted as "after an action" and wiped
 * text typed into an unfocused field. A submit whose result renders later
 * (asynchronously) empties its own fields with `clearField` instead.
 */
export class ActionEpoch {
  private action = 0
  private rendered = 0

  /** A user action happened. */
  noteAction(): void {
    this.action += 1
  }

  /** For the render about to happen: false iff an action happened since the
   *  last render. Consumes it. */
  keepUnfocused(): boolean {
    const keep = this.action === this.rendered
    this.rendered = this.action
    return keep
  }
}
