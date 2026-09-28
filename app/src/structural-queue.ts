// Structural queue (Signet identity plan, Task 6): a persisted queue of
// identity-signed structural actions (structural.ts) waiting on the remote
// My Signet signer, which may be asleep, slow, or say no — and which must
// survive app restarts. Items live in `Persisted.structuralQueue`
// (store.ts, `QueuedAction`); nothing signed is ever persisted — an item is
// re-signed on every attempt, so `prev` is always the hash of the circle's
// seed AT SIGNING TIME (a rekey between enqueue and drain is picked up) —
// until it has been signed once: from then on the persisted signed event
// is resent as-is (see `signed` below).
//
// `drain()` works the queue one item at a time, in order:
//  - circle gone            → the item is dropped;
//  - no sender registered   → stop (senders are registered at startup; a
//                             drain before that must not burn a signer
//                             prompt on an event nobody can send);
//  - SignerUnavailable      → stays waiting (attempts+1), this drain stops;
//  - SignerAborted          → marked 'paused' (the person backed out of the
//                             signer's screen): shown as waiting with a
//                             Retry, never re-sent until they tap it; this
//                             drain stops (no prompt straight after a Back);
//  - SignerRejected         → marked 'rejected' (the UI offers `retry` or
//                             `cancel`), the drain moves on;
//  - signed                 → the event is persisted on the item BEFORE the
//                             sender runs; a later attempt (after a failed
//                             send or a restart) resends that same event
//                             without re-signing, so receivers see one id;
//  - sender throws          → stays waiting (attempts+1), this drain stops;
//  - success                → the item is removed.
// Rejected and paused items are skipped until retried. Only one drain runs at a time
// (a module-level promise guard). A drain runs on `enqueue`, on app resume
// (`visibilitychange` → visible), on `online`, and every 30 s while any
// item waits. App start calls `start()` AFTER session.ts's `restore()` and
// after registering every sender: it installs the resume/online hooks,
// arms the tick and runs one drain for whatever a previous run left.

import type { SignedEvent } from '@forgesworn/roost-kit'
import { bytesToHex } from '@noble/hashes/utils.js'
import * as store from './store.js'
import type { QueuedAction } from './store.js'
import { currentSession, identitySigner } from './session.js'
import { structuralTemplate, seedHash, type StructuralAction } from './structural.js'
import { GUARDIAN_APPROVAL_TIMEOUT_MS, SignerAborted, SignerRejected, SignerTimedOut } from './remote-signer.js'

export type { QueuedAction } from './store.js'

export type StructuralSender = (signed: SignedEvent, q: QueuedAction) => Promise<void>

/** UI copy while an item waits on the signer: an owner's own My Signet… */
export const WAITING_FOR_SIGNET = 'Waiting for My Signet'
/** …or, for a dependant's session, the guardian who approves it. */
export const WAITING_FOR_PARENT = 'Waiting for your parent'

const TICK_MS = 30_000
/** Final fix A7: the signer deadline for structural signs, and the minimum
 *  gap between two signer requests for the same item — My Signet keeps a
 *  request about this long, and a dependant's guardian may take minutes to
 *  tap. */
export const STRUCTURAL_SIGN_TIMEOUT_MS = GUARDIAN_APPROVAL_TIMEOUT_MS

const senders = new Map<StructuralAction, StructuralSender>()
const listeners = new Set<() => void>()
let running: Promise<void> | null = null
let runId = 0
let started = false
let tick: ReturnType<typeof setTimeout> | null = null

export function registerSender(action: StructuralAction, send: StructuralSender): void {
  senders.set(action, send)
}

export function onChange(cb: () => void): () => void {
  listeners.add(cb)
  return () => { listeners.delete(cb) }
}

/** Every queued item (waiting, paused and rejected), oldest first. */
export function pending(): QueuedAction[] {
  return store.load().structuralQueue
}

/** The waiting-state copy for the current session. */
export function waitingCopy(): string {
  return currentSession()?.dependant ? WAITING_FOR_PARENT : WAITING_FOR_SIGNET
}

function mutate(fn: (q: QueuedAction[]) => QueuedAction[]): void {
  store.update((p) => { p.structuralQueue = fn(p.structuralQueue) })
  for (const l of listeners) l()
}

function patch(id: string, fn: (q: QueuedAction) => QueuedAction): void {
  mutate((q) => q.map((a) => (a.id === id ? fn(a) : a)))
}

function remove(id: string): void {
  mutate((q) => q.filter((a) => a.id !== id))
}

/** `payload` is what the identity signer signs; `seed` (final fix A3) and
 *  `recipientPk` (final fix A2) are kept on the item for its sender only
 *  and never signed. */
export function enqueue(a: { action: StructuralAction; circleId: string; payload: string; label: string; seed?: string; recipientPk?: string }): QueuedAction {
  const item: QueuedAction = {
    id: bytesToHex(crypto.getRandomValues(new Uint8Array(16))),
    action: a.action,
    circleId: a.circleId,
    payload: a.payload,
    label: a.label,
    status: 'waiting',
    createdAt: Date.now(),
    attempts: 0,
    ...(a.seed !== undefined ? { seed: a.seed } : {}),
    ...(a.recipientPk !== undefined ? { recipientPk: a.recipientPk } : {}),
    ...(currentSession() ? { identityPk: currentSession()!.identityPk } : {}),
  }
  mutate((q) => [...q, item])
  void drain()
  return item
}

/** Final fix round 4: whether a sender may still apply `item` locally once
 *  its send has resolved — a session exists, it is the identity that
 *  enqueued the item, and the item's circle is still in the store. A
 *  sign-out (which clears the store) during the send, or another identity
 *  signed in since, means the apply is skipped: nothing from the old
 *  session is written into the next one's store. */
export function stillEnqueuingSession(item: QueuedAction): boolean {
  const s = currentSession()
  if (!s || !item.identityPk || s.identityPk !== item.identityPk) return false
  return store.load().circles.some((c) => c.id === item.circleId)
}

/** Removes an item (any status) — the UI's cancel/dismiss. */
export function cancel(id: string): void {
  remove(id)
}

/** Puts a rejected or paused item back to waiting and drains — the UI's
 *  retry, the only thing that re-sends a paused item. */
export function retry(id: string): void {
  patch(id, (a) => ({ ...a, status: 'waiting' }))
  void drain()
}

/** Works the queue; concurrent callers share the one in-flight drain.
 *  Never rejects. */
export function drain(): Promise<void> {
  if (running) return running
  const id = ++runId
  // `run` starts after a tick, so `running` is always assigned before its
  // `finally` can clear it (a synchronously-empty run must not latch a
  // settled promise into the guard).
  running = (async () => {
    await null
    await run(id)
  })()
  return running
}

async function run(id: number): Promise<void> {
  try {
    for (;;) {
      // Re-read every time round: items may be enqueued, cancelled or the
      // circle re-keyed while an earlier item was out at the signer.
      const next = pending().find((a) => a.status === 'waiting')
      if (!next) break
      if (!(await attempt(next))) break
    }
  } catch {
    // attempt() classifies its own failures; anything else (the store,
    // say) just ends this drain — the items are still persisted.
  } finally {
    // Cleared in the same synchronous step as the last queue read above,
    // so an enqueue after that read always starts a fresh drain.
    if (runId === id) running = null
    armTick()
  }
}

/** One item. Returns whether the drain should carry on. */
async function attempt(item: QueuedAction): Promise<boolean> {
  const circle = store.load().circles.find((c) => c.id === item.circleId)
  if (!circle) {
    remove(item.id)
    return true
  }
  const send = senders.get(item.action)
  if (!send) return false

  let signed: SignedEvent
  if (item.signed) {
    signed = item.signed
  } else {
    if (!currentSession()) return false
    // A request for this item may still be on the signer's screen (e.g. it
    // was asked just before an app restart): don't stack a second prompt.
    if (item.requestedAt !== undefined && Date.now() - item.requestedAt < STRUCTURAL_SIGN_TIMEOUT_MS) return false
    const fresh = await sign(item, circle.seedHex)
    if (!fresh) return false
    if (fresh === 'rejected') return true
    if (fresh === 'paused') return false
    signed = fresh
  }

  // Cancelled while it was out at the signer: never send it.
  const still = pending().find((a) => a.id === item.id)
  if (!still || still.status !== 'waiting') return true
  if (!still.signed) patch(item.id, (a) => ({ ...a, signed }))

  try {
    await send(signed, { ...still, signed })
  } catch {
    patch(item.id, (a) => ({ ...a, attempts: a.attempts + 1 }))
    return false
  }
  remove(item.id)
  return true
}

/** Signs one item. `null` = try again later; `'rejected'` / `'paused'` =
 *  marked so. */
async function sign(item: QueuedAction, seedHex: string): Promise<SignedEvent | 'rejected' | 'paused' | null> {
  patch(item.id, (a) => ({ ...a, requestedAt: Date.now() }))
  try {
    const signed = await identitySigner({ timeoutMs: STRUCTURAL_SIGN_TIMEOUT_MS }).signEvent(
      structuralTemplate({
        action: item.action,
        circleId: item.circleId,
        prevSeedHash: seedHash(seedHex),
        payload: item.payload,
        nowSec: Math.floor(Date.now() / 1000),
      }),
    )
    patch(item.id, ({ requestedAt: _answered, ...a }) => a)
    return signed
  } catch (e) {
    if (e instanceof SignerRejected) {
      patch(item.id, ({ requestedAt: _answered, ...a }) => ({ ...a, status: 'rejected', attempts: a.attempts + 1 }))
      return 'rejected'
    }
    // The person backed out of the signer's screen: nothing is pending
    // there, and nothing automatic may ask again — only their Retry.
    if (e instanceof SignerAborted) {
      patch(item.id, ({ requestedAt: _aborted, ...a }) => ({ ...a, status: 'paused', attempts: a.attempts + 1 }))
      return 'paused'
    }
    // Timed out: the request may still be pending at the signer, so
    // `requestedAt` stays (attempt() waits it out). Anything else — a
    // connect or relay failure, or signed out mid-flight — never reached a
    // human: try again on the next drain.
    if (e instanceof SignerTimedOut) patch(item.id, (a) => ({ ...a, attempts: a.attempts + 1 }))
    else patch(item.id, ({ requestedAt: _failed, ...a }) => ({ ...a, attempts: a.attempts + 1 }))
    return null
  }
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

// ---------------------------------------------------------------------------
// View — Task 11 fix round 1, finding 1: a small banner/list of queued
// structural actions, rendered near the top of the Circles tab
// (app.ts's `signedInCirclesView`), same "own view(), called from app.ts"
// convention every other domain module follows (approvals.ts's
// `requestsView`, safety.ts's `view`, …). Empty when nothing is queued.
// ---------------------------------------------------------------------------

export function view(): string {
  const items = pending()
  if (!items.length) return ''
  return `<section class="contact-group" id="structural-queue-card"><h2>Pending</h2>${items.map(itemView).join('')}</section>`
}

function itemView(item: QueuedAction): string {
  if (item.status === 'rejected') {
    return `
      <div class="contact-item">${esc(item.label)}<span class="badge">Not approved</span>
        <div class="actions">
          <button type="button" data-action="structural-queue-retry" data-id="${esc(item.id)}">Retry</button>
          <button type="button" data-action="structural-queue-dismiss" data-id="${esc(item.id)}">Dismiss</button>
        </div>
      </div>
    `
  }
  if (item.status === 'paused') {
    return `
      <div class="contact-item">${esc(item.label)}<span class="badge">${esc(waitingCopy())}</span>
        <div class="actions">
          <button type="button" data-action="structural-queue-retry" data-id="${esc(item.id)}">Retry</button>
          <button type="button" data-action="structural-queue-cancel" data-id="${esc(item.id)}">Cancel</button>
        </div>
      </div>
    `
  }
  return `
    <div class="contact-item">${esc(item.label)}<span class="badge">${esc(waitingCopy())}</span>
      <button type="button" data-action="structural-queue-cancel" data-id="${esc(item.id)}">Cancel</button>
    </div>
  `
}

// app.ts delegates every `structural-queue-*` data-action here, same
// dispatch idiom as every other domain module's own `handleAction`.
export function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'structural-queue-cancel':
    case 'structural-queue-dismiss':
      cancel(node.dataset.id ?? '')
      break
    case 'structural-queue-retry':
      retry(node.dataset.id ?? '')
      break
    default:
      break
  }
}

function armTick(): void {
  if (tick || !pending().some((a) => a.status === 'waiting')) return
  tick = setTimeout(() => {
    tick = null
    void drain()
  }, TICK_MS)
}

function onVisibility(): void {
  if (document.visibilityState === 'visible') void drain()
}

function onOnline(): void {
  void drain()
}

/** App start, after `restore()` and registering senders. Idempotent:
 *  installs the resume/online hooks once, arms the tick and drains. */
export function start(): Promise<void> {
  if (!started) {
    started = true
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisibility)
    if (typeof window !== 'undefined') window.addEventListener('online', onOnline)
  }
  armTick()
  return drain()
}

/** Test seam: drops senders, listeners, the tick, the drain guard and the
 *  global event hooks, so a re-imported copy of this module is the only
 *  live one. */
export function resetForTests(): void {
  senders.clear()
  listeners.clear()
  if (tick) clearTimeout(tick)
  tick = null
  running = null
  runId++
  started = false
  if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisibility)
  if (typeof window !== 'undefined') window.removeEventListener('online', onOnline)
}
