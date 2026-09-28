// Covers relay-watch.ts's `install(base?)` (native socket bridge plan): it
// must wrap the given base constructor when one is passed, and fall back to
// `globalThis.WebSocket` (or no-op where there is none) otherwise — the
// existing pool-health.test.ts / beacons.test.ts suites already exercise
// `watch()`/`liveTags()` themselves via direct `watch()` calls, so this file
// only covers the install-time base-selection behaviour that's new here.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useWebSocketImplementation } from 'nostr-tools/pool'
import * as relayWatch from './relay-watch.js'
import type { SocketLike } from './relay-watch.js'

vi.mock('nostr-tools/pool', () => ({
  useWebSocketImplementation: vi.fn(),
}))

class FakeSocket implements SocketLike {
  readonly url: string
  readyState = 1
  readonly protocols?: string | string[]
  constructor(url: string | URL, protocols?: string | string[]) {
    this.url = String(url)
    this.protocols = protocols
  }
  send(): void {}
  addEventListener(): void {}
}

beforeEach(() => {
  relayWatch.resetForTests()
  vi.mocked(useWebSocketImplementation).mockClear()
})

afterEach(() => {
  delete (globalThis as { WebSocket?: unknown }).WebSocket
})

describe('install(base?)', () => {
  it('wraps the given base constructor instead of globalThis.WebSocket', () => {
    relayWatch.install(FakeSocket as unknown as relayWatch.WebSocketCtor)
    expect(useWebSocketImplementation).toHaveBeenCalledTimes(1)
    const Wrapped = vi.mocked(useWebSocketImplementation).mock.calls[0]?.[0] as new (url: string) => SocketLike
    const inst = new Wrapped('wss://relay.example')
    expect(inst).toBeInstanceOf(FakeSocket)
    expect(inst.url).toBe('wss://relay.example')
  })

  it('falls back to globalThis.WebSocket when no base is given', () => {
    ;(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket
    relayWatch.install()
    expect(useWebSocketImplementation).toHaveBeenCalledTimes(1)
    const Wrapped = vi.mocked(useWebSocketImplementation).mock.calls[0]?.[0] as new (url: string) => SocketLike
    expect(new Wrapped('wss://relay.example')).toBeInstanceOf(FakeSocket)
  })

  it('is a no-op when no base is given and there is no globalThis.WebSocket', () => {
    delete (globalThis as { WebSocket?: unknown }).WebSocket
    relayWatch.install()
    expect(useWebSocketImplementation).not.toHaveBeenCalled()
  })

  it('is idempotent — a second call does nothing, even with a different base', () => {
    relayWatch.install(FakeSocket as unknown as relayWatch.WebSocketCtor)
    class OtherSocket extends FakeSocket {}
    relayWatch.install(OtherSocket as unknown as relayWatch.WebSocketCtor)
    expect(useWebSocketImplementation).toHaveBeenCalledTimes(1)
  })
})
