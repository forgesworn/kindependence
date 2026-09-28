// Covers native-socket.ts's NativeWebSocket (the WebSocket subset nostr-tools
// 2.23.9 uses, backed by a fake RelaySocket plugin) and its `ensure()` gate.
// The fake plugin is a plain object implementing the plan's Plugin API table
// (internal design record: 2026-09-28-native-socket-bridge.md), recording
// every call it receives and exposing `emit(entry)` so a test can push a
// live `entry` event the way the native side would via `notifyListeners`.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

let mockNative = false
vi.mock('./native.js', () => ({
  isNativePlatform: () => mockNative,
}))

let mockSession: unknown = null
vi.mock('./session.js', () => ({
  currentSession: () => mockSession,
}))

import * as nativeSocket from './native-socket.js'
import { NativeWebSocket } from './native-socket.js'
import type { RelaySocketEntry, RelaySocketOpenResult, RelaySocketPlugin, RelaySocketReceiveResult, DocLike } from './native-socket.js'
import * as relayWatch from './relay-watch.js'
import type { Persisted } from './store.js'

interface FakePlugin extends RelaySocketPlugin {
  emit(entry: RelaySocketEntry): void
  calls: {
    attach: Array<{ session: string }>
    open: Array<{ url: string }>
    send: Array<{ id: string; data: string }>
    close: Array<{ id: string; code?: number; reason?: string }>
    receive: Array<{ id: string; afterSeq: number }>
    ack: Array<{ id: string; upToSeq: number }>
    setActive: Array<{ active: boolean }>
  }
}

function makeFakePlugin(
  opts: {
    openResult?: RelaySocketOpenResult
    openReject?: unknown
    receiveImpl?: (o: { id: string; afterSeq: number }) => Promise<RelaySocketReceiveResult>
  } = {},
): FakePlugin {
  let entryListener: ((entry: RelaySocketEntry) => void) | null = null
  const calls: FakePlugin['calls'] = { attach: [], open: [], send: [], close: [], receive: [], ack: [], setActive: [] }
  return {
    calls,
    async attach(o) {
      calls.attach.push(o)
      return { sockets: [] }
    },
    async open(o) {
      calls.open.push(o)
      if (opts.openReject) throw opts.openReject
      return opts.openResult ?? { id: 'sock-1', state: 0, seq: 0 }
    },
    async send(o) {
      calls.send.push(o)
      return {}
    },
    async close(o) {
      calls.close.push(o)
      return {}
    },
    async receive(o) {
      calls.receive.push(o)
      if (opts.receiveImpl) return opts.receiveImpl(o)
      return { entries: [], state: 1, dropped: 0, gap: false }
    },
    async ack(o) {
      calls.ack.push(o)
      return {}
    },
    async setActive(o) {
      calls.setActive.push(o)
      return {}
    },
    async addListener(_name, cb) {
      entryListener = cb
      return { remove: async () => {} }
    },
    emit(entry) {
      entryListener?.(entry)
    },
  }
}

/** A minimal `document`-like `EventTarget` — real `dispatchEvent`/
 *  `addEventListener`, same idiom as pool-health.test.ts's own
 *  `Object.assign(new EventTarget(), { visibilityState: 'visible' })`. */
function fakeDoc(): DocLike & EventTarget {
  return Object.assign(new EventTarget(), { visibilityState: 'visible' }) as DocLike & EventTarget
}

/** Lets pending promise chains (open()/receive() resolution, dispatch) settle. */
async function flush(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await Promise.resolve()
}

beforeEach(() => {
  nativeSocket.resetForTests()
  relayWatch.resetForTests()
  mockNative = false
  mockSession = null
})

afterEach(() => {
  vi.useRealTimers()
})

describe('NativeWebSocket — event order and readyState', () => {
  it('dispatches open, then message, then close in order for a fresh (non-adopted) socket', async () => {
    const fake = makeFakePlugin({ openResult: { id: 's1', state: 0, seq: 0 } })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    const ws = new NativeWebSocket('wss://relay.example')
    expect(ws.readyState).toBe(NativeWebSocket.CONNECTING)
    await flush()

    const order: string[] = []
    ws.onopen = () => order.push('open')
    ws.onmessage = (ev) => order.push(`message:${ev.data}`)
    ws.onclose = () => order.push('close')

    fake.emit({ id: 's1', seq: 1, type: 'open' })
    fake.emit({ id: 's1', seq: 2, type: 'message', data: '["EVENT","sub1",{}]' })
    fake.emit({ id: 's1', seq: 3, type: 'close', code: 1000, reason: '' })
    await flush()

    expect(order).toEqual(['open', 'message:["EVENT","sub1",{}]', 'close'])
    expect(ws.readyState).toBe(NativeWebSocket.CLOSED)
  })

  it('dispatches onerror then onclose when open() rejects', async () => {
    const fake = makeFakePlugin({ openReject: new Error('native open failed') })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    const ws = new NativeWebSocket('wss://relay.example')
    const order: string[] = []
    ws.onerror = () => order.push('error')
    ws.onclose = (ev) => {
      order.push('close')
      expect(ev).toEqual({ code: 1006, reason: '' })
    }
    await flush()
    expect(order).toEqual(['error', 'close'])
    expect(ws.readyState).toBe(NativeWebSocket.CLOSED)
  })

  it('an adopted socket (open result state 1) fires onopen on a microtask, without waiting for a push', async () => {
    const fake = makeFakePlugin({ openResult: { id: 's1', state: 1, seq: 42 } })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    const ws = new NativeWebSocket('wss://relay.example')
    const opened = vi.fn()
    ws.onopen = opened
    expect(ws.readyState).toBe(NativeWebSocket.CONNECTING)
    expect(opened).not.toHaveBeenCalled()
    await flush()
    expect(opened).toHaveBeenCalledTimes(1)
    expect(ws.readyState).toBe(NativeWebSocket.OPEN)
  })

  // Opus review: `seq` on `open`'s result is the LAST ASSIGNED seq on that
  // socket, not the next one to expect — a fresh socket (no log entries
  // yet) is seq 0, and its `open` entry then arrives as seq 1. This was the
  // case silently broken by treating `seq` as "next expected".
  it('a fresh socket (open result state 0, seq 0) dispatches an open entry pushed as seq 1', async () => {
    const fake = makeFakePlugin({ openResult: { id: 's1', state: 0, seq: 0 } })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    const ws = new NativeWebSocket('wss://relay.example')
    await flush()
    expect(ws.readyState).toBe(NativeWebSocket.CONNECTING)

    const opened = vi.fn()
    ws.onopen = opened
    fake.emit({ id: 's1', seq: 1, type: 'open' })
    await flush()

    expect(opened).toHaveBeenCalledTimes(1)
    expect(ws.readyState).toBe(NativeWebSocket.OPEN)
    expect(fake.calls.receive).toEqual([]) // seq 1 is exactly lastSeq(0)+1 — no gap, no pull
  })

  it('an adopted socket with open result seq N then dispatches a live push at N+1', async () => {
    const fake = makeFakePlugin({ openResult: { id: 's1', state: 1, seq: 7 } })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    const ws = new NativeWebSocket('wss://relay.example')
    await flush()
    expect(ws.readyState).toBe(NativeWebSocket.OPEN)

    const messages: string[] = []
    ws.onmessage = (ev) => messages.push(ev.data)
    fake.emit({ id: 's1', seq: 8, type: 'message', data: 'm8' })
    await flush()

    expect(messages).toEqual(['m8'])
    expect(fake.calls.receive).toEqual([]) // seq 8 is exactly lastSeq(7)+1 — no gap, no pull
  })

  it('advance() ignores a stale/spurious open entry once the socket has left CONNECTING (does not resurrect a CLOSING/CLOSED socket)', async () => {
    const fake = makeFakePlugin({ openResult: { id: 's1', state: 1, seq: 5 } })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    const ws = new NativeWebSocket('wss://relay.example')
    await flush()
    expect(ws.readyState).toBe(NativeWebSocket.OPEN)

    ws.close()
    expect(ws.readyState).toBe(NativeWebSocket.CLOSING)

    const opened = vi.fn()
    ws.onopen = opened
    fake.emit({ id: 's1', seq: 6, type: 'open' }) // stale/spurious — the socket is already closing
    await flush()

    expect(opened).not.toHaveBeenCalled()
    expect(ws.readyState).toBe(NativeWebSocket.CLOSING) // unchanged, not resurrected to OPEN
  })
})

describe('NativeWebSocket — send', () => {
  it('throws InvalidStateError before OPEN; forwards to the plugin once OPEN', async () => {
    const fake = makeFakePlugin({ openResult: { id: 's1', state: 0, seq: 0 } })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    const ws = new NativeWebSocket('wss://relay.example')

    expect(() => ws.send('["REQ","sub1"]')).toThrow(expect.objectContaining({ name: 'InvalidStateError' }))
    await flush()

    fake.emit({ id: 's1', seq: 1, type: 'open' })
    await flush()
    expect(ws.readyState).toBe(NativeWebSocket.OPEN)

    ws.send('["REQ","sub1"]')
    await flush()
    expect(fake.calls.send).toEqual([{ id: 's1', data: '["REQ","sub1"]' }])
  })
})

describe('NativeWebSocket — close', () => {
  it('close(): CLOSING immediately, calls plugin close, CLOSED on the native close entry', async () => {
    const fake = makeFakePlugin({ openResult: { id: 's1', state: 1, seq: 5 } })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    const ws = new NativeWebSocket('wss://relay.example')
    await flush()
    expect(ws.readyState).toBe(NativeWebSocket.OPEN)

    ws.close(1000, 'bye')
    expect(ws.readyState).toBe(NativeWebSocket.CLOSING)
    await flush()
    expect(fake.calls.close).toEqual([{ id: 's1', code: 1000, reason: 'bye' }])

    fake.emit({ id: 's1', seq: 6, type: 'close', code: 1000, reason: 'bye' })
    await flush()
    expect(ws.readyState).toBe(NativeWebSocket.CLOSED)
  })

  it('synthesises a close after 5s of silence (fallback)', async () => {
    vi.useFakeTimers()
    const fake = makeFakePlugin({ openResult: { id: 's1', state: 1, seq: 1 } })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    const ws = new NativeWebSocket('wss://relay.example')
    await flush()
    expect(ws.readyState).toBe(NativeWebSocket.OPEN)

    const closed = vi.fn()
    ws.onclose = closed
    ws.close()
    expect(ws.readyState).toBe(NativeWebSocket.CLOSING)

    await vi.advanceTimersByTimeAsync(4999)
    expect(ws.readyState).toBe(NativeWebSocket.CLOSING)
    expect(closed).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    expect(ws.readyState).toBe(NativeWebSocket.CLOSED)
    expect(closed).toHaveBeenCalledTimes(1)
  })

  // Opus review: a close entry pushed live (the common screen-off case) was
  // never acked, so the native side never reaped that socket.
  it('a pushed close entry is acked immediately (not the 250ms debounce)', async () => {
    vi.useFakeTimers()
    const fake = makeFakePlugin({ openResult: { id: 's1', state: 1, seq: 5 } })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    new NativeWebSocket('wss://relay.example')
    await flush()

    fake.emit({ id: 's1', seq: 6, type: 'close', code: 1000, reason: 'bye' })
    await flush()

    expect(fake.calls.ack).toEqual([{ id: 's1', upToSeq: 6 }])
  })
})

describe('NativeWebSocket — seq rule', () => {
  it('an out-of-order live push triggers a single receive() pull and delivers entries in order', async () => {
    const fake = makeFakePlugin({
      openResult: { id: 's1', state: 0, seq: 0 },
      receiveImpl: async (o) => {
        expect(o).toEqual({ id: 's1', afterSeq: 0 })
        return {
          entries: [
            { id: 's1', seq: 1, type: 'open' },
            { id: 's1', seq: 2, type: 'message', data: 'm1' },
            { id: 's1', seq: 3, type: 'message', data: 'm2' },
          ],
          state: 1,
          dropped: 0,
          gap: false,
        }
      },
    })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    const ws = new NativeWebSocket('wss://relay.example')
    await flush()

    const order: string[] = []
    ws.onopen = () => order.push('open')
    ws.onmessage = (ev) => order.push(ev.data)

    fake.emit({ id: 's1', seq: 3, type: 'message', data: 'm2' }) // out of order: lastSeq is 0, expected 1
    await flush()

    expect(fake.calls.receive).toEqual([{ id: 's1', afterSeq: 0 }])
    expect(order).toEqual(['open', 'm1', 'm2'])
  })

  it('a duplicate (already-seen) seq is dropped, not re-dispatched, and never triggers a pull', async () => {
    const fake = makeFakePlugin({ openResult: { id: 's1', state: 0, seq: 0 } })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    const ws = new NativeWebSocket('wss://relay.example')
    await flush()

    const messages: string[] = []
    ws.onmessage = (ev) => messages.push(ev.data)

    fake.emit({ id: 's1', seq: 1, type: 'open' })
    fake.emit({ id: 's1', seq: 2, type: 'message', data: 'm1' })
    fake.emit({ id: 's1', seq: 2, type: 'message', data: 'm1-dup' })
    await flush()

    expect(messages).toEqual(['m1'])
    expect(fake.calls.receive).toEqual([])
  })

  it('debounces ack(upToSeq) 250ms after pushed entries are dispatched', async () => {
    vi.useFakeTimers()
    const fake = makeFakePlugin({ openResult: { id: 's1', state: 0, seq: 0 } })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    new NativeWebSocket('wss://relay.example')
    await flush()

    fake.emit({ id: 's1', seq: 1, type: 'open' })
    fake.emit({ id: 's1', seq: 2, type: 'message', data: 'm1' })
    await flush()
    expect(fake.calls.ack).toEqual([])

    await vi.advanceTimersByTimeAsync(250)
    expect(fake.calls.ack).toEqual([{ id: 's1', upToSeq: 2 }])
  })

  it('resync() (doc resume) replays entries missed while frozen, in order, before later live ones', async () => {
    const fake = makeFakePlugin({
      openResult: { id: 's1', state: 0, seq: 0 },
      receiveImpl: async (o) => {
        expect(o).toEqual({ id: 's1', afterSeq: 1 })
        return {
          entries: [
            { id: 's1', seq: 2, type: 'message', data: 'm2' },
            { id: 's1', seq: 3, type: 'message', data: 'm3' },
          ],
          state: 1,
          dropped: 0,
          gap: false,
        }
      },
    })
    const doc = fakeDoc()
    await nativeSocket.installWithPluginForTests(fake, doc)
    const ws = new NativeWebSocket('wss://relay.example')
    await flush()
    fake.emit({ id: 's1', seq: 1, type: 'open' })
    await flush()

    const messages: string[] = []
    ws.onmessage = (ev) => messages.push(ev.data)

    doc.dispatchEvent(new Event('resume'))
    await flush()
    expect(messages).toEqual(['m2', 'm3'])
    expect(fake.calls.receive).toEqual([{ id: 's1', afterSeq: 1 }])

    // A later live push, now exactly lastSeq+1, is delivered directly — no second pull.
    fake.emit({ id: 's1', seq: 4, type: 'message', data: 'm4' })
    await flush()
    expect(messages).toEqual(['m2', 'm3', 'm4'])
    expect(fake.calls.receive).toEqual([{ id: 's1', afterSeq: 1 }])
  })

  it('a frame pushed live while a receive() pull is already in flight is not stranded — it is picked up by a follow-up pull once the first settles', async () => {
    const fake = makeFakePlugin({
      openResult: { id: 's1', state: 1, seq: 10 }, // adopted; lastSeq starts at 10
      receiveImpl: async (o) => {
        if (o.afterSeq === 10) {
          return {
            entries: [
              { id: 's1', seq: 11, type: 'message', data: 'm11' },
              { id: 's1', seq: 12, type: 'message', data: 'm12' },
            ],
            state: 1,
            dropped: 0,
            gap: false,
          }
        }
        if (o.afterSeq === 12) {
          return { entries: [{ id: 's1', seq: 13, type: 'close', code: 1000, reason: 'bye' }], state: 3, dropped: 0, gap: false }
        }
        throw new Error(`unexpected afterSeq ${o.afterSeq}`)
      },
    })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    const ws = new NativeWebSocket('wss://relay.example')
    await flush()
    expect(ws.readyState).toBe(NativeWebSocket.OPEN)

    const messages: string[] = []
    ws.onmessage = (ev) => messages.push(ev.data)
    const closed = vi.fn()
    ws.onclose = closed

    // Push 12 (lastSeq 10, expected 11) is a gap — starts a pull(afterSeq: 10).
    fake.emit({ id: 's1', seq: 12, type: 'message', data: 'm12-push' })
    // Push 13 arrives before that pull resolves — it must not be lost.
    fake.emit({ id: 's1', seq: 13, type: 'close', code: 1000, reason: 'bye' })

    await flush(20)

    // No further push or resume() call was made — the follow-up pull the
    // stranded 13 triggers is enough to recover it.
    expect(messages).toEqual(['m11', 'm12'])
    expect(closed).toHaveBeenCalledTimes(1)
    expect(ws.readyState).toBe(NativeWebSocket.CLOSED)
    expect(fake.calls.receive).toEqual([
      { id: 's1', afterSeq: 10 },
      { id: 's1', afterSeq: 12 },
    ])
    // The close entry (seq 13) came from the follow-up receive() pull, not a
    // live push — it must still be acked immediately.
    expect(fake.calls.ack).toEqual([{ id: 's1', upToSeq: 13 }])
  })

  // Opus review: same requirement, isolated to the plain "delivered by a
  // receive() pull" path (no stranded-frame follow-up pull involved).
  it('a close entry delivered by a receive() pull is acked immediately', async () => {
    const fake = makeFakePlugin({
      openResult: { id: 's1', state: 0, seq: 0 },
      receiveImpl: async (o) => {
        expect(o).toEqual({ id: 's1', afterSeq: 0 })
        return {
          entries: [
            { id: 's1', seq: 1, type: 'open' },
            { id: 's1', seq: 2, type: 'close', code: 1000, reason: 'bye' },
          ],
          state: 3,
          dropped: 0,
          gap: false,
        }
      },
    })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    new NativeWebSocket('wss://relay.example')
    await flush()

    fake.emit({ id: 's1', seq: 2, type: 'close', code: 1000, reason: 'bye' }) // out of order (expected 1) -> pull
    await flush()

    expect(fake.calls.receive).toEqual([{ id: 's1', afterSeq: 0 }])
    expect(fake.calls.ack).toEqual([{ id: 's1', upToSeq: 2 }])
  })

  it('gap: true is unrecoverable — native close, then onerror, then onclose (code 1006)', async () => {
    const fake = makeFakePlugin({
      openResult: { id: 's1', state: 0, seq: 0 },
      receiveImpl: async () => ({ entries: [], state: 1, dropped: 500, gap: true }),
    })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    const ws = new NativeWebSocket('wss://relay.example')
    await flush()

    const order: string[] = []
    ws.onerror = () => order.push('error')
    ws.onclose = (ev) => {
      order.push('close')
      expect(ev).toEqual({ code: 1006, reason: '' })
    }
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    fake.emit({ id: 's1', seq: 5, type: 'message', data: 'm' }) // gap: lastSeq 0, seq 5
    await flush()

    expect(order).toEqual(['error', 'close'])
    expect(ws.readyState).toBe(NativeWebSocket.CLOSED)
    expect(fake.calls.close).toEqual([{ id: 's1' }])
    expect(warnSpy).toHaveBeenCalledWith('native-socket: gap', expect.any(Object))
    warnSpy.mockRestore()
  })
})

describe('ensure()', () => {
  it('calls setActive only on a change, and only once the bridge is installed', async () => {
    const fake = makeFakePlugin()
    const p = { v: 1, circles: [{}] } as unknown as Persisted

    // Bridge not installed yet: ensure is a no-op, whatever the gate says.
    mockNative = true
    mockSession = { pubkey: 'abc' }
    nativeSocket.ensure(p)
    expect(fake.calls.setActive).toEqual([])
    expect(nativeSocket.isActive()).toBe(false)

    await nativeSocket.installWithPluginForTests(fake, fakeDoc())

    nativeSocket.ensure(p) // native + signed in + a circle -> want true (change)
    await flush()
    expect(fake.calls.setActive).toEqual([{ active: true }])
    expect(nativeSocket.isActive()).toBe(true)

    nativeSocket.ensure(p) // same inputs -> no change, no extra call
    await flush()
    expect(fake.calls.setActive).toEqual([{ active: true }])

    mockSession = null // signed out -> want false (change)
    nativeSocket.ensure(p)
    await flush()
    expect(fake.calls.setActive).toEqual([{ active: true }, { active: false }])
    expect(nativeSocket.isActive()).toBe(false)
  })

  it('never wants active on web, even signed in with circles', async () => {
    const fake = makeFakePlugin()
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    mockNative = false
    mockSession = { pubkey: 'abc' }
    const p = { v: 1, circles: [{}] } as unknown as Persisted
    nativeSocket.ensure(p)
    await flush()
    expect(fake.calls.setActive).toEqual([])
    expect(nativeSocket.isActive()).toBe(false)
  })
})

describe('resync() re-asserts setActive on resume', () => {
  // Opus review: Android 15+ caps a dataSync foreground service at 6h/day —
  // it may have been stopped while this device was backgrounded for a
  // while. Re-sending setActive(true) on every resume/visible/pageshow
  // (idempotent natively) is the recovery for that.
  it('calls setActive({active:true}) again on resume when the bridge is currently active', async () => {
    const fake = makeFakePlugin()
    const doc = fakeDoc()
    await nativeSocket.installWithPluginForTests(fake, doc)
    mockNative = true
    mockSession = { pubkey: 'abc' }
    const p = { v: 1, circles: [{}] } as unknown as Persisted
    nativeSocket.ensure(p)
    await flush()
    expect(fake.calls.setActive).toEqual([{ active: true }])

    doc.dispatchEvent(new Event('resume'))
    await flush()
    expect(fake.calls.setActive).toEqual([{ active: true }, { active: true }])

    doc.dispatchEvent(new Event('pageshow'))
    await flush()
    expect(fake.calls.setActive).toEqual([{ active: true }, { active: true }, { active: true }])
  })

  it('does not call setActive on resume when the bridge is not active', async () => {
    const fake = makeFakePlugin()
    const doc = fakeDoc()
    await nativeSocket.installWithPluginForTests(fake, doc)
    doc.dispatchEvent(new Event('resume'))
    await flush()
    expect(fake.calls.setActive).toEqual([])
  })
})

describe('relay-watch integration', () => {
  it("relay-watch's watch() works on a NativeWebSocket (send wrap + addEventListener)", async () => {
    const fake = makeFakePlugin({ openResult: { id: 's1', state: 1, seq: 1 } })
    await nativeSocket.installWithPluginForTests(fake, fakeDoc())
    const ws = new NativeWebSocket('wss://relay.example')
    await flush()

    relayWatch.watch(ws as unknown as relayWatch.SocketLike)
    ws.send(JSON.stringify(['REQ', 'sub1', { '#p': ['abc'] }]))
    await flush()
    expect(relayWatch.liveTags()).toEqual(new Set(['abc']))

    fake.emit({ id: 's1', seq: 2, type: 'close', code: 1000, reason: '' })
    await flush()
    expect(relayWatch.liveTags().size).toBe(0)
  })
})
