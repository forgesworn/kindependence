import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SignedEvent } from '@forgesworn/roost-kit'
import { fakeBunker } from './test-support/fake-bunker.js'
import { seedHash, verifyStructural } from './structural.js'
import type { StoredCircle, QueuedAction } from './store.js'

// Every test re-imports store/session/structural-queue fresh (vi.resetModules)
// so the "survives restart" test can simulate a cold start against the SAME
// fake localStorage — which also backs secure-key.ts's dev SecretStore, so
// the phone key survives the restart too. `document`/`window` are plain
// EventTargets (vitest runs in node) so resume/online can be dispatched.

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

const SEED_1 = '1'.repeat(64)
const SEED_2 = '2'.repeat(64)

function fakeCircle(id: string, seedHex: string): StoredCircle {
  return {
    id, name: 'Test circle', seedHex, epoch: 0,
    members: [], createdAt: 100, configUpdatedAt: 100, configBy: 'a'.repeat(64),
  } as unknown as StoredCircle
}

type Mods = {
  store: typeof import('./store.js')
  session: typeof import('./session.js')
  queue: typeof import('./structural-queue.js')
}

let m: Mods
let ls: Storage
let doc: EventTarget & { visibilityState: string }
let win: EventTarget

async function importFresh(): Promise<Mods> {
  vi.resetModules()
  return {
    store: await import('./store.js'),
    session: await import('./session.js'),
    queue: await import('./structural-queue.js'),
  }
}

async function signIn(bunker: ReturnType<typeof fakeBunker>, dependant = false): Promise<void> {
  await m.session.startSession(
    { identityPk: bunker.pubkey, dependant, name: 'Alex', transport: { kind: 'nip55', packageName: 'app.example.signer' } },
    bunker,
  )
}

function signCount(bunker: ReturnType<typeof fakeBunker>): number {
  return bunker.requests.filter((r) => r.method === 'sign_event').length
}

beforeEach(async () => {
  vi.useFakeTimers()
  ls = fakeLocalStorage()
  doc = Object.assign(new EventTarget(), { visibilityState: 'visible' })
  win = new EventTarget()
  vi.stubGlobal('localStorage', ls)
  vi.stubGlobal('document', doc)
  vi.stubGlobal('window', win)
  m = await importFresh()
  m.store.update((p) => { p.circles = [fakeCircle('c1', SEED_1), fakeCircle('c2', SEED_1)] })
  await m.queue.start()
})

afterEach(async () => {
  m.queue.resetForTests()
  m.session.setTransportFactoryForTests(null)
  await m.session.signOut()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('structural queue', () => {
  it('signs and sends in order', async () => {
    const bunker = fakeBunker({})
    await signIn(bunker)
    const sent: { ev: SignedEvent; q: QueuedAction }[] = []
    m.queue.registerSender('invite', async (ev, q) => { sent.push({ ev, q }) })
    m.queue.registerSender('places', async (ev, q) => { sent.push({ ev, q }) })

    m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'first', label: 'Invite Sam' })
    m.queue.enqueue({ action: 'places', circleId: 'c2', payload: 'second', label: 'Save places' })
    await m.queue.drain()

    expect(sent.map((s) => s.ev.content)).toEqual(['first', 'second'])
    const v = verifyStructural(sent[0].ev)
    expect(v).toMatchObject({ action: 'invite', circleId: 'c1', prev: seedHash(SEED_1), payload: 'first', signerPk: bunker.pubkey })
    expect(sent[0].q.label).toBe('Invite Sam')
    expect(m.queue.pending()).toEqual([])
    expect(m.store.load().structuralQueue).toEqual([])
  })

  it('asleep: stays waiting, then sends after wake + resume', async () => {
    let asleep = true
    const bunker = fakeBunker({ asleep: () => asleep })
    await signIn(bunker)
    const send = vi.fn(async () => {})
    m.queue.registerSender('invite', send)

    m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite' })
    await vi.advanceTimersByTimeAsync(301_000) // past the structural sign deadline (300 s, final fix A7)

    expect(send).not.toHaveBeenCalled()
    expect(m.queue.pending()).toMatchObject([{ status: 'waiting', attempts: 1 }])

    asleep = false
    doc.dispatchEvent(new Event('visibilitychange'))
    await m.queue.drain()

    expect(send).toHaveBeenCalledTimes(1)
    expect(m.queue.pending()).toEqual([])
  })

  it('retries every 30 s while items wait, and on coming back online', async () => {
    let asleep = true
    const bunker = fakeBunker({ asleep: () => asleep })
    await signIn(bunker)
    const send = vi.fn(async () => {})
    m.queue.registerSender('invite', send)

    m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite' })
    await vi.advanceTimersByTimeAsync(301_000) // the 300 s structural sign deadline (final fix A7)
    expect(signCount(bunker)).toBe(1)

    // The 30 s tick re-tries (and fails again while asleep).
    await vi.advanceTimersByTimeAsync(30_000)
    expect(signCount(bunker)).toBe(2)

    await vi.advanceTimersByTimeAsync(301_000)
    asleep = false
    win.dispatchEvent(new Event('online'))
    await m.queue.drain()
    expect(send).toHaveBeenCalledTimes(1)
    expect(m.queue.pending()).toEqual([])
  })

  it('rejected: status rejected, sender never called; retry re-signs', async () => {
    let approve = false
    const bunker = fakeBunker({ approve: () => approve })
    await signIn(bunker)
    const send = vi.fn(async () => {})
    m.queue.registerSender('rekey', send)

    const q = m.queue.enqueue({ action: 'rekey', circleId: 'c1', payload: 'p', label: 'Remove Sam' })
    await m.queue.drain()

    expect(send).not.toHaveBeenCalled()
    expect(m.queue.pending()).toMatchObject([{ id: q.id, status: 'rejected' }])

    // A rejected item does not come back on its own.
    await vi.advanceTimersByTimeAsync(31_000)
    expect(signCount(bunker)).toBe(1)

    approve = true
    m.queue.retry(q.id)
    await m.queue.drain()
    expect(send).toHaveBeenCalledTimes(1)
    expect(m.queue.pending()).toEqual([])
  })

  // Final review, item 1: Back / swipe-away on My Signet's signing screen
  // (RESULT_CANCELED, no `rejected` extra → SIGNER_ABORTED) is the person
  // backing out, not the signer being unreachable. The item pauses: it stays
  // listed with the waiting copy and a Retry, and nothing automatic (tick,
  // drain, resume, online) asks again — only the person's Retry does.
  function abortingSigner(): { plugin: ReturnType<typeof fakeBunker>; bunker: ReturnType<typeof fakeBunker>; setAbort(v: boolean): void; calls(): number } {
    const bunker = fakeBunker({})
    let abort = true
    let calls = 0
    const plugin = {
      ...bunker,
      async signEvent(t: Parameters<typeof bunker.signEvent>[0]) {
        calls++
        if (abort) throw Object.assign(new Error('Signing was cancelled in My Signet.'), { code: 'SIGNER_ABORTED' })
        return bunker.signEvent(t)
      },
    } as typeof bunker
    return { plugin, bunker, setAbort: (v) => { abort = v }, calls: () => calls }
  }

  it('NIP-55 intent finished without an answer (SIGNER_ABORTED): paused, not rejected, and never re-sent automatically', async () => {
    const s = abortingSigner()
    await signIn(s.plugin)
    const send = vi.fn(async () => {})
    m.queue.registerSender('invite', send)

    m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite' })
    await m.queue.drain()
    expect(send).not.toHaveBeenCalled()
    expect(s.calls()).toBe(1)
    expect(m.queue.pending()).toMatchObject([{ status: 'paused', attempts: 1 }])
    expect(m.queue.pending()[0]!.requestedAt).toBeUndefined()

    s.setAbort(false)
    // Not the tick…
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    // …nor a resume, coming back online, an explicit drain, or a restart.
    doc.dispatchEvent(new Event('visibilitychange'))
    win.dispatchEvent(new Event('online'))
    await m.queue.drain()
    await m.queue.start()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(s.calls()).toBe(1)
    expect(send).not.toHaveBeenCalled()
    expect(m.queue.pending()).toMatchObject([{ status: 'paused' }])
  })

  it('a paused item is re-sent by Retry', async () => {
    const s = abortingSigner()
    await signIn(s.plugin)
    const send = vi.fn(async () => {})
    m.queue.registerSender('invite', send)
    const q = m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite' })
    await m.queue.drain()
    expect(m.queue.pending()).toMatchObject([{ status: 'paused' }])

    s.setAbort(false)
    m.queue.handleAction('structural-queue-retry', { dataset: { id: q.id } } as unknown as HTMLElement)
    await m.queue.drain()
    expect(s.calls()).toBe(2)
    expect(send).toHaveBeenCalledTimes(1)
    expect(m.queue.pending()).toEqual([])
  })

  it('a paused item shows the waiting copy with Retry and Cancel', async () => {
    const s = abortingSigner()
    await signIn(s.plugin)
    m.queue.registerSender('invite', async () => {})
    const q = m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite Sam' })
    await m.queue.drain()

    const html = m.queue.view()
    expect(html).toContain('Invite Sam')
    expect(html).toContain(m.queue.WAITING_FOR_SIGNET)
    expect(html).not.toContain('Not approved')
    expect(html).toContain(`data-action="structural-queue-retry" data-id="${q.id}"`)
    expect(html).toContain(`data-action="structural-queue-cancel" data-id="${q.id}"`)
  })

  it('a paused item does not hold up later items', async () => {
    const s = abortingSigner()
    await signIn(s.plugin)
    const send = vi.fn(async () => {})
    m.queue.registerSender('invite', send)
    m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'first', label: 'First' })
    await m.queue.drain()
    expect(m.queue.pending()).toMatchObject([{ status: 'paused' }])

    s.setAbort(false)
    m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'second', label: 'Second' })
    await m.queue.drain()
    expect(send).toHaveBeenCalledTimes(1)
    expect(m.queue.pending()).toMatchObject([{ label: 'First', status: 'paused' }])
  })

  it('a signer that could not be reached (not an abort) still retries on its own', async () => {
    const bunker = fakeBunker({})
    let down = true
    const plugin = {
      ...bunker,
      async signEvent(t: Parameters<typeof bunker.signEvent>[0]) {
        if (down) throw new Error('My Signet is locked')
        return bunker.signEvent(t)
      },
    } as typeof bunker
    await signIn(plugin)
    const send = vi.fn(async () => {})
    m.queue.registerSender('invite', send)
    m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite' })
    await m.queue.drain()
    expect(m.queue.pending()).toMatchObject([{ status: 'waiting', attempts: 1 }])

    down = false
    await vi.advanceTimersByTimeAsync(30_000)
    expect(send).toHaveBeenCalledTimes(1)
    expect(m.queue.pending()).toEqual([])
  })

  it('cancel removes a waiting item', async () => {
    const bunker = fakeBunker({ asleep: () => true })
    await signIn(bunker)
    const send = vi.fn(async () => {})
    m.queue.registerSender('invite', send)
    const changes = vi.fn()
    m.queue.onChange(changes)

    const q = m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite' })
    await vi.advanceTimersByTimeAsync(61_000)
    expect(m.queue.pending()).toHaveLength(1)

    m.queue.cancel(q.id)
    expect(m.queue.pending()).toEqual([])
    expect(m.store.load().structuralQueue).toEqual([])
    expect(changes).toHaveBeenCalled()
    expect(send).not.toHaveBeenCalled()
  })

  it('survives restart: the sender is called exactly once after reload', async () => {
    const bunker = fakeBunker({})
    await signIn(bunker)
    // No sender registered in this run: the item stays queued, unsigned.
    m.queue.enqueue({ action: 'agreement', circleId: 'c1', payload: 'p', label: 'Agreement' })
    await m.queue.drain()
    expect(m.queue.pending()).toHaveLength(1)
    m.queue.resetForTests()

    // Cold start: fresh modules over the same localStorage/SecretStore.
    m = await importFresh()
    m.session.setTransportFactoryForTests(async () => bunker)
    expect(await m.session.restore()).not.toBeNull()
    expect(m.queue.pending()).toHaveLength(1)

    const send = vi.fn(async () => {})
    m.queue.registerSender('agreement', send)
    await m.queue.start()
    await m.queue.drain()

    expect(send).toHaveBeenCalledTimes(1)
    expect(m.queue.pending()).toEqual([])
  })

  it('two concurrent drain() calls from idle sign once', async () => {
    const bunker = fakeBunker({})
    await signIn(bunker)
    // No sender yet: enqueue's own drain stops without signing, leaving idle.
    m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite' })
    await m.queue.drain()
    expect(signCount(bunker)).toBe(0)

    const send = vi.fn(async () => {})
    m.queue.registerSender('invite', send)
    const a = m.queue.drain()
    const b = m.queue.drain()
    expect(a).toBe(b)
    await Promise.all([a, b])

    expect(signCount(bunker)).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
  })

  it('takes prev at signing time, not enqueue time', async () => {
    let asleep = true
    const bunker = fakeBunker({ asleep: () => asleep })
    await signIn(bunker)
    const sent: SignedEvent[] = []
    m.queue.registerSender('invite', async (ev) => { sent.push(ev) })

    m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite' })
    await vi.advanceTimersByTimeAsync(301_000)

    m.store.update((p) => { p.circles = p.circles.map((c) => (c.id === 'c1' ? { ...c, seedHex: SEED_2 } : c)) })
    asleep = false
    await m.queue.drain()

    expect(sent).toHaveLength(1)
    expect(verifyStructural(sent[0])?.prev).toBe(seedHash(SEED_2))
  })

  it('drops an item whose circle no longer exists', async () => {
    const bunker = fakeBunker({})
    await signIn(bunker)
    const send = vi.fn(async () => {})
    m.queue.registerSender('invite', send)

    m.queue.enqueue({ action: 'invite', circleId: 'gone', payload: 'p', label: 'Invite' })
    await m.queue.drain()

    expect(send).not.toHaveBeenCalled()
    expect(signCount(bunker)).toBe(0)
    expect(m.queue.pending()).toEqual([])
  })

  it('a sender that throws: the next drain resends the identical event without re-signing', async () => {
    const bunker = fakeBunker({})
    await signIn(bunker)
    let fail = true
    const sent: SignedEvent[] = []
    m.queue.registerSender('invite', async (ev) => { sent.push(ev); if (fail) throw new Error('relay down') })

    m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite' })
    await m.queue.drain()
    expect(m.queue.pending()).toMatchObject([{ status: 'waiting', attempts: 1 }])
    expect(m.queue.pending()[0].signed?.id).toBe(sent[0].id)

    fail = false
    await vi.advanceTimersByTimeAsync(30_000)
    await m.queue.drain()
    expect(signCount(bunker)).toBe(1)
    expect(sent).toHaveLength(2)
    expect(sent[1].id).toBe(sent[0].id)
    expect(m.queue.pending()).toEqual([])
  })

  it('restart between sign and send: the same event id is sent, no re-sign', async () => {
    const bunker = fakeBunker({})
    await signIn(bunker)
    const first: SignedEvent[] = []
    m.queue.registerSender('invite', async (ev) => { first.push(ev); throw new Error('app killed mid-send') })
    m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite' })
    await m.queue.drain()
    expect(first).toHaveLength(1)
    m.queue.resetForTests()

    m = await importFresh()
    m.session.setTransportFactoryForTests(async () => bunker)
    await m.session.restore()
    const sent: SignedEvent[] = []
    m.queue.registerSender('invite', async (ev) => { sent.push(ev) })
    await m.queue.start()

    expect(sent.map((e) => e.id)).toEqual([first[0].id])
    expect(signCount(bunker)).toBe(1)
    expect(m.queue.pending()).toEqual([])
  })

  it('a drain on an empty queue does not latch the guard: a later enqueue is sent', async () => {
    const bunker = fakeBunker({})
    await signIn(bunker)
    const send = vi.fn(async () => {})
    m.queue.registerSender('invite', send)

    await m.queue.drain()
    doc.dispatchEvent(new Event('visibilitychange'))
    await m.queue.drain()

    m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite' })
    await m.queue.drain()
    expect(send).toHaveBeenCalledTimes(1)
    expect(m.queue.pending()).toEqual([])
  })

  it('start() is idempotent: hooks are installed once', async () => {
    const add = vi.spyOn(doc, 'addEventListener')
    const addWin = vi.spyOn(win, 'addEventListener')
    await m.queue.start() // second call (beforeEach made the first)
    expect(add).not.toHaveBeenCalled()
    expect(addWin).not.toHaveBeenCalled()
  })

  it('final fix A7: a slow approval (120 s) produces exactly one signer request', async () => {
    const bunker = fakeBunker({ latencyMs: 120_000 })
    await signIn(bunker)
    const send = vi.fn(async () => {})
    m.queue.registerSender('invite', send)

    m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite' })
    await vi.advanceTimersByTimeAsync(130_000)

    expect(signCount(bunker)).toBe(1)
    expect(send).toHaveBeenCalledTimes(1)
    expect(m.queue.pending()).toEqual([])
  })

  it('final fix A7: after a restart, an item asked for less than 300 s ago is not asked for again', async () => {
    const bunker = fakeBunker({ latencyMs: 1_000_000 }) // the guardian hasn't tapped yet
    await signIn(bunker)
    m.queue.registerSender('invite', async () => {})
    m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite' })
    await vi.advanceTimersByTimeAsync(10_000)
    expect(signCount(bunker)).toBe(1)
    expect(m.queue.pending()[0]?.requestedAt).toBeTypeOf('number')
    m.queue.resetForTests()

    m = await importFresh()
    m.session.setTransportFactoryForTests(async () => bunker)
    expect(await m.session.restore()).not.toBeNull()
    m.queue.registerSender('invite', async () => {})
    await m.queue.start()
    await vi.advanceTimersByTimeAsync(200_000)
    expect(signCount(bunker)).toBe(1)
    await vi.advanceTimersByTimeAsync(120_000) // past 300 s since the request
    expect(signCount(bunker)).toBe(2)
  })

  it('waiting copy depends on whether the session is a dependant', async () => {
    await signIn(fakeBunker({}))
    expect(m.queue.waitingCopy()).toBe(m.queue.WAITING_FOR_SIGNET)
    expect(m.queue.WAITING_FOR_SIGNET).toBe('Waiting for My Signet')

    await signIn(fakeBunker({}), true)
    expect(m.queue.waitingCopy()).toBe(m.queue.WAITING_FOR_PARENT)
    expect(m.queue.WAITING_FOR_PARENT).toBe('Waiting for your parent')
  })

  // Task 11 fix round 1, finding 1.
  describe('view', () => {
    it('is empty with nothing queued', async () => {
      await signIn(fakeBunker({}))
      expect(m.queue.view()).toBe('')
    })

    it('a waiting item shows "Waiting for My Signet" for an adult session', async () => {
      const bunker = fakeBunker({ asleep: () => true })
      await signIn(bunker)
      m.queue.registerSender('invite', async () => {})
      const q = m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite Sam' })
      await vi.advanceTimersByTimeAsync(61_000)

      const html = m.queue.view()
      expect(html).toContain('Invite Sam')
      expect(html).toContain('Waiting for My Signet')
      expect(html).toContain(`data-action="structural-queue-cancel" data-id="${q.id}"`)
    })

    it('a waiting item shows "Waiting for your parent" for a dependant session', async () => {
      const bunker = fakeBunker({ dependant: true, asleep: () => true })
      await signIn(bunker, true)
      m.queue.registerSender('invite', async () => {})
      m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite Sam' })
      await vi.advanceTimersByTimeAsync(61_000)

      expect(m.queue.view()).toContain('Waiting for your parent')
    })

    it('a rejected item shows Retry and Dismiss', async () => {
      const bunker = fakeBunker({ approve: () => false })
      await signIn(bunker)
      m.queue.registerSender('rekey', async () => {})
      const q = m.queue.enqueue({ action: 'rekey', circleId: 'c1', payload: 'p', label: 'Remove Sam' })
      await m.queue.drain()

      const html = m.queue.view()
      expect(html).toContain('Remove Sam')
      expect(html).toContain('Not approved')
      expect(html).toContain(`data-action="structural-queue-retry" data-id="${q.id}"`)
      expect(html).toContain(`data-action="structural-queue-dismiss" data-id="${q.id}"`)
    })
  })

  // Task 11 fix round 1, finding 1.
  describe('handleAction', () => {
    it('cancel and dismiss both remove the item', async () => {
      const bunker = fakeBunker({ asleep: () => true })
      await signIn(bunker)
      m.queue.registerSender('invite', async () => {})
      const q = m.queue.enqueue({ action: 'invite', circleId: 'c1', payload: 'p', label: 'Invite' })
      await vi.advanceTimersByTimeAsync(61_000)
      expect(m.queue.pending()).toHaveLength(1)

      m.queue.handleAction('structural-queue-cancel', { dataset: { id: q.id } } as unknown as HTMLElement)
      expect(m.queue.pending()).toEqual([])
    })

    it('retry re-drains a rejected item', async () => {
      let approve = false
      const bunker = fakeBunker({ approve: () => approve })
      await signIn(bunker)
      const send = vi.fn(async () => {})
      m.queue.registerSender('rekey', send)
      const q = m.queue.enqueue({ action: 'rekey', circleId: 'c1', payload: 'p', label: 'Remove Sam' })
      await m.queue.drain()
      expect(m.queue.pending()).toMatchObject([{ status: 'rejected' }])

      approve = true
      m.queue.handleAction('structural-queue-retry', { dataset: { id: q.id } } as unknown as HTMLElement)
      await m.queue.drain()
      expect(send).toHaveBeenCalledTimes(1)
      expect(m.queue.pending()).toEqual([])
    })

    it('dismiss action removes a rejected item without retrying', async () => {
      const bunker = fakeBunker({ approve: () => false })
      await signIn(bunker)
      const send = vi.fn(async () => {})
      m.queue.registerSender('rekey', send)
      const q = m.queue.enqueue({ action: 'rekey', circleId: 'c1', payload: 'p', label: 'Remove Sam' })
      await m.queue.drain()

      m.queue.handleAction('structural-queue-dismiss', { dataset: { id: q.id } } as unknown as HTMLElement)
      expect(m.queue.pending()).toEqual([])
      expect(send).not.toHaveBeenCalled()
    })
  })
})
