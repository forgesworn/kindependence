// Native socket bridge (internal design record: 2026-09-28-native-socket-bridge.md):
// moves the relay TRANSPORT only to a Capacitor plugin (`RelaySocket`) backed
// by a foreground Android service — protocol logic (nostr-tools, roost-kit)
// is unchanged, it is just handed a WebSocket-shaped class backed by native
// sockets instead of the browser's own. While the WebView is frozen (screen
// off, backgrounded) the native side keeps the sockets open and buffers
// incoming frames in an ordered, seq-numbered per-socket event log; this
// module replays that log in order on resume, deduplicating by seq, so a
// frozen page never silently drops delivery the way it used to (see
// pool-health.ts's own doc comment on the WebView-freeze bug this exists
// to fix upstream of).
//
// Boxed plugin-proxy rule (nip55.ts, 38d810b): a Capacitor plugin proxy
// answers every property, `then` included, so a promise resolved with it
// invokes the missing native `then()` and rejects. `resolvePlugin` therefore
// always hands the proxy back boxed (`{ p }`), never bare, from an async
// function.
//
// Seq rule (plan, verbatim): per socket this module keeps `lastSeq`. A
// pushed entry with `seq === lastSeq + 1` is dispatched and `lastSeq`
// advances; `seq <= lastSeq` is a duplicate and dropped; `seq > lastSeq + 1`
// means something was missed (a push lost to a frozen page, most likely) and
// triggers a single-flight `receive({ id, afterSeq: lastSeq })` pull, applied
// with the same rule. `resync()` — wired to `resume` / `visibilitychange`
// (→visible) / `pageshow` on the document handed to `install` — runs that
// same pull for every socket that isn't CLOSED, so entries missed while the
// page was frozen (and never pushed again) are recovered too. A `receive`
// whose `gap` is true means the native log evicted something this module
// never saw — unrecoverable — so the socket closes: native `close`, then
// `error`, then `close` (code 1006), same order/semantics as a real socket
// failure. `seq` in both `open`'s and `attach`'s results is the LAST
// ASSIGNED seq on that socket (0 for a socket with no log entries yet; the
// entry log then starts at seq 1) — matches `lastSeq`'s own meaning, so
// `lastSeq = result.seq` needs no +1/-1 adjustment. A live push that lands
// while a `receive()` pull is already in flight is not applied directly
// (the pull's own response is about to supersede it); its seq is only
// remembered (`strandedSeq`) and re-pulled for once the in-flight pull
// settles, so it is never silently dropped.

import { isNativePlatform } from './native.js'
import { currentSession } from './session.js'
import type { Persisted } from './store.js'

// --- Wire contract with RelaySocketPlugin.java (verbatim from the plan's
// "Plugin API" table) -------------------------------------------------------

export interface RelaySocketOpenResult {
  id: string
  state: number
  seq: number
}

export interface RelaySocketEntry {
  id: string
  seq: number
  type: 'open' | 'message' | 'error' | 'close'
  data?: string
  code?: number
  reason?: string
  message?: string
}

export interface RelaySocketReceiveResult {
  entries: RelaySocketEntry[]
  state: number
  dropped: number
  gap: boolean
}

interface PluginListenerHandle {
  remove(): Promise<void>
}

export interface RelaySocketPlugin {
  attach(o: { session: string }): Promise<{ sockets: Array<{ id: string; url: string; state: number; seq: number }> }>
  open(o: { url: string }): Promise<RelaySocketOpenResult>
  send(o: { id: string; data: string }): Promise<Record<string, never>>
  close(o: { id: string; code?: number; reason?: string }): Promise<Record<string, never>>
  receive(o: { id: string; afterSeq: number }): Promise<RelaySocketReceiveResult>
  ack(o: { id: string; upToSeq: number }): Promise<Record<string, never>>
  setActive(o: { active: boolean }): Promise<Record<string, never>>
  addListener(eventName: 'entry', cb: (entry: RelaySocketEntry) => void): Promise<PluginListenerHandle>
}

/** Minimal shape `install`/tests need of `document` — real `Document`
 *  satisfies it; tests hand a plain `EventTarget`-like fake. */
export interface DocLike {
  addEventListener(type: string, fn: (ev?: unknown) => void): void
  visibilityState?: string
}

const CLOSE_FALLBACK_MS = 5_000
const ACK_DEBOUNCE_MS = 250

function invalidStateError(): Error {
  const e = new Error("Failed to execute 'send': the socket is not OPEN.")
  e.name = 'InvalidStateError'
  return e
}

type EntryEventType = 'open' | 'message' | 'error' | 'close'

/** The subset of the browser `WebSocket` interface nostr-tools 2.23.9
 *  actually uses (see the module doc comment / build brief for the exact
 *  verified usage): `on*` properties (assigned, not addEventListener'd),
 *  `static OPEN` etc. read off the class it was handed, `send` only after
 *  `onopen`, `close` only when `readyState === OPEN`. relay-watch.ts
 *  additionally wraps `send` and uses `addEventListener`. */
export class NativeWebSocket {
  static readonly CONNECTING = 0
  static readonly OPEN = 1
  static readonly CLOSING = 2
  static readonly CLOSED = 3

  readonly url: string
  readyState: number = NativeWebSocket.CONNECTING

  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: ((ev: { message?: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null

  private id: string | null = null
  private lastSeq = -1
  private closeRequested = false
  private closeCode = 1000
  private closeReason = ''
  private closeFallback: ReturnType<typeof setTimeout> | null = null
  private ackTimer: ReturnType<typeof setTimeout> | null = null
  private resyncInFlight: Promise<void> | null = null
  /** Highest seq seen in a live push that arrived while a `receive()` pull
   *  was already in flight (Opus review: a frame pushed mid-pull was
   *  otherwise silently stranded — dropped from `onEntry`'s gap branch
   *  because `pull()` returned the already-in-flight promise without
   *  noting anything newer had shown up). `pull()`'s `finally` checks this
   *  against the (now-advanced) `lastSeq` and pulls again if it's still
   *  ahead — single-flight, since a fresh `resyncInFlight` is null by then. */
  private strandedSeq = 0

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- one listener slot serves four differently-shaped events (open/message/error/close); relay-watch.ts and nostr-tools each cast their own narrower view.
  private readonly listeners: Record<EntryEventType, Set<(ev?: any) => void>> = {
    open: new Set(),
    message: new Set(),
    error: new Set(),
    close: new Set(),
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- kept for constructor-signature compatibility with the browser WebSocket relay-watch.ts's install() also accepts.
  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url)
    void this.openSocket()
  }

  addEventListener(type: EntryEventType, fn: (ev?: any) => void): void {
    this.listeners[type].add(fn)
  }

  removeEventListener(type: EntryEventType, fn: (ev?: any) => void): void {
    this.listeners[type].delete(fn)
  }

  send(data: string): void {
    if (this.readyState !== NativeWebSocket.OPEN || !this.id) throw invalidStateError()
    const plug = currentPlugin()
    if (!plug) return
    void plug.send({ id: this.id, data }).catch((e: unknown) => {
      console.warn('native-socket: send failed', e)
    })
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === NativeWebSocket.CLOSING || this.readyState === NativeWebSocket.CLOSED) return
    this.readyState = NativeWebSocket.CLOSING
    this.closeCode = code
    this.closeReason = reason
    if (this.id) {
      const plug = currentPlugin()
      if (plug) void plug.close({ id: this.id, code, reason }).catch(() => { /* best effort; the fallback below covers a stuck close */ })
    } else {
      this.closeRequested = true
    }
    if (this.closeFallback) clearTimeout(this.closeFallback)
    this.closeFallback = setTimeout(() => {
      this.closeFallback = null
      this.finishClose(code, reason)
    }, CLOSE_FALLBACK_MS)
  }

  /** Entry pushed live via `notifyListeners('entry', …)` — routed here by
   *  module id → instance lookup. Not private: called from the module-level
   *  listener registered in `finishInstall`. */
  onEntry(entry: RelaySocketEntry): void {
    if (entry.seq <= this.lastSeq) return // duplicate — a push that survived is deduplicated by seq
    if (this.resyncInFlight) {
      // A pull is already correcting the sequence from an older `lastSeq`;
      // applying this entry now (even one that looks like `lastSeq + 1` at
      // this stale point) risks the pull's own response re-delivering or
      // skipping past it out of order. Just remember how far live pushes
      // have gotten — `pull()`'s `finally` re-checks once the in-flight
      // pull's own entries are applied.
      if (entry.seq > this.strandedSeq) this.strandedSeq = entry.seq
      return
    }
    if (entry.seq === this.lastSeq + 1) {
      this.advance(entry)
      this.scheduleAck()
    } else {
      void this.pull() // a gap in the live push — pull what was missed
    }
  }

  /** Single-flight `receive(afterSeq)` pull, applying entries with the same
   *  seq rule as a live push (minus the ack debounce — `receive` itself acks
   *  everything up to `afterSeq` on the native side). Used both for a gap
   *  found in a live push and for `resync()` on resume. Not private: called
   *  from the module-level `resync()`. */
  pull(): Promise<void> {
    if (this.resyncInFlight) return this.resyncInFlight
    const plug = currentPlugin()
    if (!this.id || !plug) return Promise.resolve()
    const id = this.id
    const p = plug
      .receive({ id, afterSeq: this.lastSeq })
      .then(async (res) => {
        if (res.gap) {
          await this.handleGap()
          return
        }
        for (const e of res.entries) {
          if (e.seq <= this.lastSeq) continue
          this.advance(e)
        }
      })
      .catch((e: unknown) => {
        console.warn('native-socket: receive failed', e)
      })
      .finally(() => {
        this.resyncInFlight = null
        const stranded = this.strandedSeq
        this.strandedSeq = 0
        if (stranded > this.lastSeq && this.readyState !== NativeWebSocket.CLOSED) void this.pull()
      })
    this.resyncInFlight = p
    return p
  }

  private async openSocket(): Promise<void> {
    const plug = currentPlugin()
    if (!plug) {
      this.dispatch('error', {})
      this.readyState = NativeWebSocket.CLOSED
      this.dispatch('close', { code: 1006, reason: '' })
      return
    }
    let result: RelaySocketOpenResult
    try {
      result = await plug.open({ url: this.url })
    } catch (e) {
      this.dispatch('error', { message: e instanceof Error ? e.message : String(e) })
      this.readyState = NativeWebSocket.CLOSED
      this.dispatch('close', { code: 1006, reason: '' })
      return
    }
    this.id = result.id
    this.lastSeq = result.seq
    instances.set(result.id, this)
    if (this.closeRequested) {
      this.closeRequested = false
      void plug.close({ id: result.id, code: this.closeCode, reason: this.closeReason }).catch(() => { /* fallback timer covers it */ })
      return
    }
    if (result.state === 1) {
      // Adopted: already OPEN on the native side before this session attached.
      this.readyState = NativeWebSocket.OPEN
      queueMicrotask(() => this.dispatch('open', {}))
    }
  }

  private advance(entry: RelaySocketEntry): void {
    this.lastSeq = entry.seq
    switch (entry.type) {
      case 'open':
        // Only a genuinely CONNECTING socket can become OPEN here — a stale
        // or replayed open entry arriving once the socket has already moved
        // to CLOSING/CLOSED (e.g. a local close() racing a native open that
        // was already in flight) must not resurrect it (Opus review).
        if (this.readyState === NativeWebSocket.CONNECTING) {
          this.readyState = NativeWebSocket.OPEN
          this.dispatch('open', {})
        }
        break
      case 'message':
        this.dispatch('message', { data: entry.data ?? '' })
        break
      case 'error':
        this.dispatch('error', { message: entry.message })
        break
      case 'close':
        // Opus review: a close entry — pushed live or delivered by a
        // receive() pull — must be acked immediately (not the usual 250ms
        // debounce), or the native side never reaps the socket once JS has
        // torn it down. finishClose's `ackNow` sends it synchronously.
        this.finishClose(entry.code ?? 1000, entry.reason ?? '', true)
        break
    }
  }

  private async handleGap(): Promise<void> {
    console.warn('native-socket: gap', { id: this.id, url: this.url })
    const plug = currentPlugin()
    if (this.id && plug) {
      try {
        await plug.close({ id: this.id })
      } catch {
        // best effort — the socket is being torn down either way
      }
    }
    this.dispatch('error', {})
    this.finishClose(1006, '')
  }

  /** `ackNow`: true when `code`/`reason` come from a real native `close`
   *  entry (pushed or pulled) — that entry's seq (already folded into
   *  `lastSeq` by `advance` before this runs) must be acked right away, not
   *  left to the debounce, since nothing further will ever schedule one for
   *  a closed socket. False for a synthetic close (a gap's forced close, or
   *  `close()`'s own 5s fallback) — there is no log entry to ack. */
  private finishClose(code: number, reason: string, ackNow = false): void {
    if (this.readyState === NativeWebSocket.CLOSED) return
    if (this.closeFallback) {
      clearTimeout(this.closeFallback)
      this.closeFallback = null
    }
    if (this.ackTimer) {
      clearTimeout(this.ackTimer)
      this.ackTimer = null
    }
    this.readyState = NativeWebSocket.CLOSED
    this.dispatch('close', { code, reason })
    if (ackNow && this.id) {
      const plug = currentPlugin()
      if (plug) void plug.ack({ id: this.id, upToSeq: this.lastSeq }).catch(() => { /* the socket's gone natively either way */ })
    }
    if (this.id) instances.delete(this.id)
  }

  private scheduleAck(): void {
    if (this.ackTimer) clearTimeout(this.ackTimer)
    this.ackTimer = setTimeout(() => {
      this.ackTimer = null
      const plug = currentPlugin()
      if (this.id && plug) void plug.ack({ id: this.id, upToSeq: this.lastSeq }).catch(() => { /* the next ack (or a later receive) will catch it up */ })
    }, ACK_DEBOUNCE_MS)
  }

  private dispatch(type: EntryEventType, ev: unknown): void {
    const handler = type === 'open' ? this.onopen : type === 'message' ? this.onmessage : type === 'error' ? this.onerror : this.onclose
    if (handler) {
      try {
        ;(handler as (e?: unknown) => void)(ev)
      } catch {
        // one handler's failure must not stop delivery to the others (relay-watch.ts's own discipline)
      }
    }
    for (const fn of [...this.listeners[type]]) {
      try {
        fn(ev)
      } catch {
        // same
      }
    }
  }
}

// --- Module state ------------------------------------------------------

let plug: RelaySocketPlugin | null = null
let bridgeInstalled = false
let active = false
const instances = new Map<string, NativeWebSocket>()

function currentPlugin(): RelaySocketPlugin | null {
  return plug
}

function randomSession(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}

// A Capacitor plugin proxy answers every property, `then` included, so a
// promise resolved with it calls the missing native `then()` and rejects —
// handed back boxed (nip55.ts's own rule, 38d810b).
async function resolvePlugin(): Promise<{ p: RelaySocketPlugin } | null> {
  if (!isNativePlatform()) return null
  const { Capacitor, registerPlugin } = await import('@capacitor/core')
  if (!Capacitor.isPluginAvailable('RelaySocket')) return null
  return { p: registerPlugin<RelaySocketPlugin>('RelaySocket') }
}

function resync(): void {
  // Opus review: Android 15+ caps a dataSync foreground service at 6h/day
  // and may have stopped it while this device was backgrounded for a while
  // — re-asserting `setActive(true)` on every resume (native `setActive` is
  // idempotent either way) is the belt-and-braces recovery for that, same
  // spirit as pool-health.ts's own resume-triggered recovery.
  if (active) {
    const cur = currentPlugin()
    if (cur) void cur.setActive({ active: true }).catch((e: unknown) => { console.warn('native-socket: setActive failed', e) })
  }
  for (const inst of instances.values()) {
    if (inst.readyState !== NativeWebSocket.CLOSED) void inst.pull()
  }
}

function wireResync(doc: DocLike): void {
  const onResume = (): void => resync()
  doc.addEventListener('resume', onResume)
  doc.addEventListener('visibilitychange', () => {
    if (doc.visibilityState === undefined || doc.visibilityState === 'visible') resync()
  })
  doc.addEventListener('pageshow', onResume)
}

async function finishInstall(p: RelaySocketPlugin, doc: DocLike): Promise<boolean> {
  const session = randomSession()
  try {
    await p.attach({ session })
  } catch {
    return false
  }
  plug = p
  bridgeInstalled = true
  await p.addListener('entry', (entry) => {
    instances.get(entry.id)?.onEntry(entry)
  })
  wireResync(doc)
  return true
}

/** Resolves the plugin (no-op on web, or when the plugin was never synced
 *  into the native build), attaches this JS session as the bridge's owner,
 *  registers the `entry` push listener, and wires `doc`'s `resume` /
 *  `visibilitychange` (→visible) / `pageshow` to `resync()`. Returns false
 *  wherever the bridge is unavailable — the caller (app.ts) then falls back
 *  to the browser WebSocket via relay-watch.ts's own default. */
export async function install(doc: Document): Promise<boolean> {
  const boxed = await resolvePlugin()
  if (!boxed) return false
  return finishInstall(boxed.p, doc)
}

/** Test seam: same wiring as `install`, but with an already-resolved (fake)
 *  plugin instead of resolving one via Capacitor — skips `isNativePlatform`/
 *  `Capacitor.isPluginAvailable`. */
export async function installWithPluginForTests(fake: RelaySocketPlugin, doc: DocLike): Promise<boolean> {
  return finishInstall(fake, doc)
}

/** The class to hand to relay-watch.ts's `install(base)` once the bridge is
 *  up — `undefined` otherwise, so the caller falls back to the browser
 *  WebSocket. */
export function webSocketClass(): typeof NativeWebSocket | undefined {
  return bridgeInstalled ? NativeWebSocket : undefined
}

/** Whether the native bridge is currently the active transport (the last
 *  value `ensure` sent to `setActive`) — pool-health.ts logs this alongside
 *  every safety-net pool rebuild, since a rebuild firing while the bridge is
 *  active would mean the bridge itself didn't do its job. */
export function isActive(): boolean {
  return active
}

/** Mirrors native-geo.ts's `ensure` gate: the foreground service (and the
 *  sockets it keeps open) should run whenever this device is natively
 *  running, signed in, and sharing with at least one circle — the same
 *  "sharing" stand-in native-geo.ts's own doc comment explains. Calls
 *  `setActive` only on a change, and only once the bridge is installed
 *  (nothing to tell otherwise). Called from app.ts's `render()`, next to
 *  `nativeGeo.ensure(p)`. */
export function ensure(p: Persisted): void {
  if (!bridgeInstalled) return
  const want = isNativePlatform() && !!currentSession() && p.circles.length > 0
  if (want === active) return
  active = want
  const cur = currentPlugin()
  if (cur) void cur.setActive({ active: want }).catch((e: unknown) => { console.warn('native-socket: setActive failed', e) })
}

/** Test seam: forgets the plugin, every tracked socket instance, and the
 *  active/installed flags. */
export function resetForTests(): void {
  plug = null
  bridgeInstalled = false
  active = false
  instances.clear()
}

/** Test seam: pretend the bridge is (not) the active transport. */
export function setActiveForTests(v: boolean): void {
  active = v
}
