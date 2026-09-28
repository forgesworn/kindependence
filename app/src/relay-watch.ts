// Relay liveness, observed on the wire (review follow-up to 9aeaff2).
//
// pool-health.ts has to know whether the shared roost-kit relay pool is
// actually delivering: after Android WebView freezes the page its sockets
// are gone, nostr-tools drops the relays and closes their subscriptions for
// good — while publishes, each on a fresh connection, still succeed. Neither
// a clock nor publish success says whether the inbox subscriptions are
// open, and roost-kit keeps its pool private. So this module watches the
// sockets themselves: nostr-tools' `useWebSocketImplementation` lets the app
// hand every pool built afterwards a WebSocket subclass that records, per
// socket, the `#p` tags of each REQ it sends, forgets a subscription on the
// client's CLOSE or the relay's CLOSED, and forgets the socket on close.
// An inbox tag is live when some OPEN socket carries a REQ for it.
//
// Observation only: nothing sent or received is changed.

import { useWebSocketImplementation } from 'nostr-tools/pool'

/** What this module needs of a socket — a real WebSocket, or a test fake. */
export interface SocketLike {
  readonly url: string
  readonly readyState: number
  send(data: string): void
  addEventListener(type: 'message', fn: (ev: { data: unknown }) => void): void
  addEventListener(type: 'close' | 'error', fn: () => void): void
}

const OPEN = 1

interface Watched {
  ws: SocketLike
  /** subscription id → the `#p` tags its REQ filters name */
  subs: Map<string, string[]>
}

const sockets = new Set<Watched>()
let installed = false
const downListeners = new Set<() => void>()

/** Calls `fn` whenever a watched socket errors or closes (after it has
 *  stopped counting as live). pool-health.ts uses it to re-check liveness
 *  the moment a socket goes, instead of only on the next resume — after a
 *  freeze the close often lands AFTER the page's resume event. Returns the
 *  unsubscribe. */
export function onSocketDown(fn: () => void): () => void {
  downListeners.add(fn)
  return () => { downListeners.delete(fn) }
}

function socketDown(): void {
  for (const fn of [...downListeners]) {
    try { fn() } catch { /* a listener's failure must not stop the others */ }
  }
}

function pTags(filters: unknown[]): string[] {
  const out: string[] = []
  for (const f of filters) {
    const p = f && typeof f === 'object' ? (f as Record<string, unknown>)['#p'] : undefined
    if (Array.isArray(p)) for (const t of p) if (typeof t === 'string') out.push(t)
  }
  return out
}

function parse(data: unknown): unknown[] | null {
  if (typeof data !== 'string') return null
  try {
    const v: unknown = JSON.parse(data)
    return Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

/** Starts watching `ws`. Called by the tracking WebSocket's constructor;
 *  exported for tests. */
export function watch(ws: SocketLike): void {
  const w: Watched = { ws, subs: new Map() }
  sockets.add(w)
  const send = ws.send.bind(ws)
  ;(ws as { send: (data: string) => void }).send = (data: string): void => {
    if (typeof data === 'string' && (data.startsWith('["REQ"') || data.startsWith('["CLOSE"'))) {
      const msg = parse(data)
      if (msg && typeof msg[1] === 'string') {
        if (msg[0] === 'REQ') w.subs.set(msg[1], pTags(msg.slice(2)))
        else if (msg[0] === 'CLOSE') w.subs.delete(msg[1])
      }
    }
    send(data)
  }
  ws.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string' || !ev.data.startsWith('["CLOSED"')) return
    const msg = parse(ev.data)
    if (msg && typeof msg[1] === 'string') w.subs.delete(msg[1])
  })
  ws.addEventListener('error', () => { socketDown() })
  ws.addEventListener('close', () => {
    sockets.delete(w)
    socketDown()
  })
}

/** The `#p` tags with a subscription open on an OPEN socket right now. */
export function liveTags(): Set<string> {
  const out = new Set<string>()
  for (const w of sockets) {
    if (w.ws.readyState !== OPEN) continue
    for (const tags of w.subs.values()) for (const t of tags) out.add(t)
  }
  return out
}

/** Whether sockets are being watched at all (false: liveness is unknown). */
export function isInstalled(): boolean {
  return installed
}

/** A WebSocket-shaped constructor — either the browser's own, or
 *  native-socket.ts's `NativeWebSocket` once the native bridge is up. Both
 *  satisfy `SocketLike` once constructed. */
export type WebSocketCtor = new (url: string | URL, protocols?: string | string[]) => SocketLike

/** Hands nostr-tools a WebSocket that reports to `watch`, for every pool
 *  built from now on — so call it before the first subscribe or publish
 *  (app.ts's `mount`). `base`, when given (native socket bridge plan: the
 *  bridge's `NativeWebSocket`), is wrapped instead of the browser's own —
 *  app.ts passes it only once the bridge actually installed, so the browser
 *  WebSocket remains the default everywhere else (web, or the bridge
 *  unavailable). Idempotent; a no-op where there is no WebSocket at all. */
export function install(base?: WebSocketCtor): void {
  if (installed) return
  const Base = base ?? ((globalThis as { WebSocket?: WebSocketCtor }).WebSocket)
  if (typeof Base !== 'function') return
  class WatchedWebSocket extends Base {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols)
      watch(this as unknown as SocketLike)
    }
  }
  useWebSocketImplementation(WatchedWebSocket)
  installed = true
  // Device-check hook (read-only): the socket and subscription counts, for
  // the acceptance checks driven over CDP (internal device check (2026-09-26)).
  ;(globalThis as { __relayWatch?: unknown }).__relayWatch = {
    sockets: () => [...sockets].map((w) => ({ url: w.ws.url, readyState: w.ws.readyState, subs: [...w.subs.keys()] })),
    liveTags: () => [...liveTags()],
  }
}

/** Test seam: forget every watched socket and mark tracking installed (or not). */
export function resetForTests(opts: { installed?: boolean } = {}): void {
  sockets.clear()
  installed = opts.installed ?? false
}
