import { describe, it, expect, vi, afterEach } from 'vitest'
import { finalizeEvent, generateSecretKey, getPublicKey, verifiedSymbol } from 'nostr-tools/pure'
import { npubEncode } from 'nostr-tools/nip19'
import type { EventTemplate, SignedEvent } from '@forgesworn/roost-kit'
import type { SignetSigner } from 'signet-login'
import {
  RemoteSigner,
  SignerAborted,
  SignerRejected,
  SignerUnavailable,
  mapSignerError,
  transportFromSignetSigner,
  transportFromNip55,
  type SignerTransport,
} from './remote-signer.js'
import { signedEventFromNip55, publicKeyFromNip55 } from './nip55.js'
import { fakeBunker } from './test-support/fake-bunker.js'

// Fake Nip55 plugin behind `@capacitor/core`'s `registerPlugin` (only
// nip55.ts reaches it). Each native call is parked as a deferred the test
// settles by hand, and `open` counts calls in flight, so overlap shows.
const nativeNip55 = vi.hoisted(() => {
  const state = {
    open: 0,
    maxOpen: 0,
    pending: [] as Array<{ method: string; args: unknown; resolve: (v: unknown) => void; reject: (e: unknown) => void }>,
  }
  const park = (method: string) => (args?: unknown): Promise<unknown> => {
    state.open += 1
    state.maxOpen = Math.max(state.maxOpen, state.open)
    return new Promise((resolve, reject) => {
      const settle = <A>(f: (a: A) => void) => (a: A) => { state.open -= 1; f(a) }
      state.pending.push({ method, args, resolve: settle(resolve), reject: settle(reject) })
    })
  }
  return {
    state,
    plugin: {
      signEvent: park('signEvent'),
      nip44Encrypt: park('nip44Encrypt'),
      nip44Decrypt: park('nip44Decrypt'),
    },
  }
})

vi.mock('@capacitor/core', () => ({
  registerPlugin: () => nativeNip55.plugin,
}))

const T: EventTemplate = { kind: 1, content: 'hello', tags: [['t', 'x']], created_at: 1_700_000_000 }
const STATE: EventTemplate = { kind: 30078, content: 'state', tags: [['d', 'kindependence:x']], created_at: 1_700_000_000 }

afterEach(() => {
  vi.useRealTimers()
})

/** A transport whose signEvent hands back whatever `tamper` makes of an
 *  honestly-signed event — for the "returned event doesn't match" cases. */
function tamperingTransport(tamper: (e: SignedEvent, sk: Uint8Array) => SignedEvent): SignerTransport {
  const sk = generateSecretKey()
  return {
    pubkey: getPublicKey(sk),
    async signEvent(t) {
      return tamper(finalizeEvent({ ...t, created_at: t.created_at ?? 0 }, sk) as SignedEvent, sk)
    },
    async nip44Encrypt() { return 'x' },
    async nip44Decrypt() { return 'x' },
    async close() {},
  }
}

describe('RemoteSigner — owner route', () => {
  it('signs, encrypts and decrypts round-trip', async () => {
    const skA = generateSecretKey()
    const skB = generateSecretKey()
    const a = new RemoteSigner(fakeBunker({ sk: skA }))
    const b = new RemoteSigner(fakeBunker({ sk: skB }))
    expect(a.pubkey).toBe(getPublicKey(skA))

    const ev = await a.signEvent(T)
    expect(ev.pubkey).toBe(a.pubkey)
    expect(ev.kind).toBe(1)
    expect(ev.content).toBe('hello')
    expect(ev.tags).toEqual([['t', 'x']])
    expect(ev.created_at).toBe(1_700_000_000)

    const ct = await a.nip44Encrypt(b.pubkey, 'secret')
    expect(ct).not.toBe('secret')
    expect(await b.nip44Decrypt(a.pubkey, ct)).toBe('secret')
  })

  it('fills created_at when the template has none', async () => {
    const s = new RemoteSigner(fakeBunker({}))
    const before = Math.floor(Date.now() / 1000)
    const ev = await s.signEvent({ kind: 1, content: 'c', tags: [] })
    expect(ev.created_at).toBeGreaterThanOrEqual(before)
  })

  it('owner refusal via approve → SignerRejected', async () => {
    const s = new RemoteSigner(fakeBunker({ approve: () => false }))
    await expect(s.signEvent(T)).rejects.toBeInstanceOf(SignerRejected)
  })
})

describe('RemoteSigner — checks the returned event', () => {
  it('a different pubkey → SignerRejected', async () => {
    const other = generateSecretKey()
    const s = new RemoteSigner(tamperingTransport((e) => finalizeEvent({ kind: e.kind, content: e.content, tags: e.tags, created_at: e.created_at }, other) as SignedEvent))
    await expect(s.signEvent(T)).rejects.toBeInstanceOf(SignerRejected)
  })

  it('tampered content (signature no longer valid) → SignerRejected', async () => {
    const s = new RemoteSigner(tamperingTransport((e) => ({ ...e, content: 'evil' })))
    await expect(s.signEvent(T)).rejects.toBeInstanceOf(SignerRejected)
  })

  it('tampered content even with a cached verified flag → SignerRejected', async () => {
    const s = new RemoteSigner(tamperingTransport((e) => {
      const copy = { ...e, content: 'evil' } as SignedEvent & { [verifiedSymbol]?: boolean }
      copy[verifiedSymbol] = true
      return copy
    }))
    await expect(s.signEvent(T)).rejects.toBeInstanceOf(SignerRejected)
  })

  it('validly signed but for different content / kind / tags / created_at → SignerRejected', async () => {
    const variants: Array<(t: EventTemplate) => EventTemplate> = [
      (t) => ({ ...t, content: 'other' }),
      (t) => ({ ...t, kind: 2 }),
      (t) => ({ ...t, tags: [] }),
      (t) => ({ ...t, created_at: (t.created_at ?? 0) + 1 }),
    ]
    for (const change of variants) {
      const s = new RemoteSigner(tamperingTransport((e, sk) => finalizeEvent(change({ kind: e.kind, content: e.content, tags: e.tags, created_at: e.created_at }), sk) as SignedEvent))
      await expect(s.signEvent(T)).rejects.toBeInstanceOf(SignerRejected)
    }
  })
})

describe('RemoteSigner — dependant route', () => {
  it('nip44Decrypt → SignerRejected', async () => {
    const s = new RemoteSigner(fakeBunker({ dependant: true }))
    await expect(s.nip44Decrypt(getPublicKey(generateSecretKey()), 'x')).rejects.toBeInstanceOf(SignerRejected)
    await expect(s.nip44Encrypt(getPublicKey(generateSecretKey()), 'x')).rejects.toBeInstanceOf(SignerRejected)
  })

  it('kind 30078 with approve=false → SignerRejected', async () => {
    const approve = vi.fn(() => false)
    const s = new RemoteSigner(fakeBunker({ dependant: true, approve }))
    await expect(s.signEvent(STATE)).rejects.toBeInstanceOf(SignerRejected)
    expect(approve).toHaveBeenCalledWith({ method: 'sign_event', kind: 30078 })
  })

  it('kind 30078 with approve=true → signed', async () => {
    const s = new RemoteSigner(fakeBunker({ dependant: true, approve: () => true }))
    const ev = await s.signEvent(STATE)
    expect(ev.kind).toBe(30078)
  })

  it('at full autonomy: signs and does nip44 without calling approve', async () => {
    const approve = vi.fn(() => false)
    const bunker = fakeBunker({ dependant: true, fullAutonomy: true, approve })
    const s = new RemoteSigner(bunker)
    const ev = await s.signEvent(STATE)
    expect(ev.kind).toBe(30078)
    const peer = getPublicKey(generateSecretKey())
    await expect(s.nip44Encrypt(peer, 'hi')).resolves.toEqual(expect.any(String))
    expect(approve).not.toHaveBeenCalled()
    expect(bunker.requests).toEqual([
      { method: 'sign_event', kind: 30078 },
      { method: 'nip44_encrypt' },
    ])
  })
})

describe('RemoteSigner — asleep bunker', () => {
  it('asleep → SignerUnavailable after timeoutMs', async () => {
    vi.useFakeTimers()
    const s = new RemoteSigner(fakeBunker({ asleep: () => true }), { timeoutMs: 5_000 })
    const p = s.signEvent(T)
    const settled = vi.fn()
    p.then(settled, settled)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).rejects.toBeInstanceOf(SignerUnavailable)
  })

  it('default timeout is 60 s', async () => {
    vi.useFakeTimers()
    const s = new RemoteSigner(fakeBunker({ asleep: () => true }))
    const p = s.signEvent(T)
    const settled = vi.fn()
    p.then(settled, settled)
    await vi.advanceTimersByTimeAsync(59_999)
    expect(settled).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await expect(p).rejects.toBeInstanceOf(SignerUnavailable)
  })

  it('an asleep fake stops polling once the request is past 300 s', async () => {
    vi.useFakeTimers()
    const asleep = vi.fn(() => true)
    const s = new RemoteSigner(fakeBunker({ asleep }), { timeoutMs: 5_000 })
    s.signEvent(T).catch(() => {})
    await vi.advanceTimersByTimeAsync(302_000)
    const calls = asleep.mock.calls.length
    await vi.advanceTimersByTimeAsync(10_000)
    expect(asleep.mock.calls.length).toBe(calls)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('woken after 301 s → SignerUnavailable (request dropped)', async () => {
    vi.useFakeTimers()
    let asleep = true
    const s = new RemoteSigner(fakeBunker({ asleep: () => asleep, now: () => Date.now() }), { timeoutMs: 600_000 })
    const p = s.signEvent(T)
    p.catch(() => {})
    await vi.advanceTimersByTimeAsync(301_000)
    asleep = false
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(p).rejects.toBeInstanceOf(SignerUnavailable)
  })

  it('woken within 300 s → signed', async () => {
    vi.useFakeTimers()
    let asleep = true
    const s = new RemoteSigner(fakeBunker({ asleep: () => asleep }), { timeoutMs: 600_000 })
    const p = s.signEvent(T)
    await vi.advanceTimersByTimeAsync(200_000)
    asleep = false
    await vi.advanceTimersByTimeAsync(2_000)
    await expect(p).resolves.toMatchObject({ kind: 1, content: 'hello' })
  })
})

describe('error mapping', () => {
  const table: Array<[string, 'rejected' | 'unavailable']> = [
    // signet-login / NIP-46 bunker
    ['user rejected the request', 'rejected'],
    ['Request Rejected', 'rejected'],
    ['permission denied', 'rejected'],
    ['denied by guardian', 'rejected'],
    ['the owner declined', 'rejected'],
    ['cancelled by user', 'rejected'],
    ['nip46-sign_event-timeout', 'unavailable'],
    ['nip46-sign_event-publish-failed', 'unavailable'],
    ['bunker-closed', 'unavailable'],
    ['bunker-connect-timeout', 'unavailable'],
    ['event returned from bunker is improperly signed: {}', 'unavailable'],
    // NIP-55 plugin
    ['Cancelled in My Signet.', 'rejected'],
    ['My Signet declined to sign.', 'rejected'],
    ['My Signet returned nothing.', 'unavailable'],
    ['No signer app answers nostrsigner: intents', 'unavailable'],
    ['', 'unavailable'],
  ]
  for (const [message, kind] of table) {
    it(`"${message}" → ${kind}`, () => {
      const mapped = mapSignerError(new Error(message))
      expect(mapped).toBeInstanceOf(kind === 'rejected' ? SignerRejected : SignerUnavailable)
    })
  }

  const objectTable: Array<[unknown, 'rejected' | 'unavailable']> = [
    [{ message: 'User declined' }, 'rejected'],
    [{ message: 'Cancelled in My Signet.' }, 'rejected'],
    [{ message: 'nip46-sign_event-timeout' }, 'unavailable'],
    [{ message: 42 }, 'unavailable'],
    [{ code: 'denied' }, 'unavailable'],
    [null, 'unavailable'],
  ]
  for (const [value, kind] of objectTable) {
    it(`${JSON.stringify(value)} (not an Error) → ${kind}`, () => {
      expect(mapSignerError(value)).toBeInstanceOf(kind === 'rejected' ? SignerRejected : SignerUnavailable)
    })
  }

  // Step-8 root cause: a NIP-55 intent that came back RESULT_CANCELED with
  // no explicit `rejected` extra (My Signet's activity was finished under
  // it — e.g. its singleTask MainActivity relaunched from the launcher
  // while the PIN screen was up) is nobody saying no. Nip55Plugin marks the
  // two cases with distinct codes, and the code wins over the wording.
  it('plugin code SIGNER_ABORTED (no answer) → SignerUnavailable, even if the words say cancel', () => {
    const aborted = Object.assign(new Error('Signing was cancelled in My Signet.'), { code: 'SIGNER_ABORTED' })
    expect(mapSignerError(aborted)).toBeInstanceOf(SignerUnavailable)
    expect(mapSignerError({ message: 'My Signet closed before answering.', code: 'SIGNER_ABORTED' })).toBeInstanceOf(SignerUnavailable)
    // Final review, item 1: its own class, so nothing re-sends it on its own.
    expect(mapSignerError(aborted)).toBeInstanceOf(SignerAborted)
    expect(mapSignerError(new Error('My Signet is locked'))).not.toBeInstanceOf(SignerAborted)
  })

  it('plugin code SIGNER_REJECTED (explicit `rejected` extra) → SignerRejected, whatever the words', () => {
    expect(mapSignerError(Object.assign(new Error('My Signet declined to sign.'), { code: 'SIGNER_REJECTED' }))).toBeInstanceOf(SignerRejected)
    expect(mapSignerError({ message: 'no', code: 'SIGNER_REJECTED' })).toBeInstanceOf(SignerRejected)
  })

  it('the plugin\'s abort wording alone does not read as a refusal', () => {
    expect(mapSignerError(new Error('My Signet closed before answering.'))).toBeInstanceOf(SignerUnavailable)
  })

  it('reads the message of a non-Error object', () => {
    expect(mapSignerError({ message: 'user declined' }).message).toBe('user declined')
  })

  it('non-Error values map to SignerUnavailable, and existing classes pass through', () => {
    expect(mapSignerError('boom')).toBeInstanceOf(SignerUnavailable)
    expect(mapSignerError(undefined)).toBeInstanceOf(SignerUnavailable)
    const r = new SignerRejected('x')
    const u = new SignerUnavailable('y')
    expect(mapSignerError(r)).toBe(r)
    expect(mapSignerError(u)).toBe(u)
  })

  it('RemoteSigner maps transport errors', async () => {
    const t = tamperingTransport((e) => e)
    t.signEvent = async () => { throw new Error('user denied') }
    t.nip44Encrypt = async () => { throw new Error('nip46-nip44_encrypt-timeout') }
    const s = new RemoteSigner(t)
    await expect(s.signEvent(T)).rejects.toBeInstanceOf(SignerRejected)
    await expect(s.nip44Encrypt(s.pubkey, 'x')).rejects.toBeInstanceOf(SignerUnavailable)
  })
})

describe('transportFromSignetSigner', () => {
  function signet(withNip44: boolean): SignetSigner & { closed: boolean } {
    const sk = generateSecretKey()
    const out = {
      pubkey: getPublicKey(sk),
      method: 'bunker' as const,
      capabilities: {} as SignetSigner['capabilities'],
      closed: false,
      async signEvent(t: { kind: number; content: string; tags?: string[][]; created_at?: number }) {
        return finalizeEvent({ kind: t.kind, content: t.content, tags: t.tags ?? [], created_at: t.created_at ?? 0 }, sk)
      },
      nip44: withNip44 ? { encrypt: async () => 'ct', decrypt: async () => 'pt' } : undefined,
      async close() { out.closed = true },
    }
    return out as SignetSigner & { closed: boolean }
  }

  it('signs through and closes', async () => {
    const inner = signet(true)
    const t = transportFromSignetSigner(inner)
    const s = new RemoteSigner(t)
    expect(s.pubkey).toBe(inner.pubkey)
    const ev = await s.signEvent(T)
    expect(ev.content).toBe('hello')
    expect(await s.nip44Encrypt(inner.pubkey, 'x')).toBe('ct')
    expect(await s.nip44Decrypt(inner.pubkey, 'x')).toBe('pt')
    await t.close()
    expect(inner.closed).toBe(true)
  })

  it('missing nip44 → SignerRejected', async () => {
    const t = transportFromSignetSigner(signet(false))
    await expect(t.nip44Encrypt('a', 'b')).rejects.toBeInstanceOf(SignerRejected)
    await expect(t.nip44Decrypt('a', 'b')).rejects.toBeInstanceOf(SignerRejected)
  })
})

describe('NIP-55 answers', () => {
  const sk = generateSecretKey()
  const pk = getPublicKey(sk)
  const signed = finalizeEvent({ kind: 1, content: 'c', tags: [], created_at: 5 }, sk) as SignedEvent
  const unsigned = { pubkey: pk, kind: 1, content: 'c', tags: [], created_at: 5 }

  it('takes the whole event when the signer returns one', () => {
    expect(signedEventFromNip55({ event: JSON.stringify(signed) }, unsigned)).toMatchObject({ id: signed.id, sig: signed.sig })
  })

  it('rebuilds the event from a bare signature', () => {
    const ev = signedEventFromNip55({ result: signed.sig.toUpperCase() }, unsigned)
    expect(ev).toMatchObject({ id: signed.id, sig: signed.sig, pubkey: pk })
  })

  it('returns null for nothing usable', () => {
    expect(signedEventFromNip55({ result: 'nope' }, unsigned)).toBeNull()
    expect(signedEventFromNip55({ event: '{bad' }, unsigned)).toBeNull()
  })

  it('reads a public key as hex or npub', () => {
    expect(publicKeyFromNip55(pk)).toBe(pk)
    expect(publicKeyFromNip55(pk.toUpperCase())).toBe(pk)
    expect(publicKeyFromNip55(npubEncode(pk))).toBe(pk)
    expect(publicKeyFromNip55('garbage')).toBeNull()
  })
})

describe('transportFromNip55 — one request at a time', () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }

  it('never overlaps calls, and a rejection releases the queue', async () => {
    const st = nativeNip55.state
    st.open = 0; st.maxOpen = 0; st.pending.length = 0
    const t = transportFromNip55('a'.repeat(64), 'com.example.signer')
    const first = t.nip44Encrypt('b'.repeat(64), 'one')
    const second = t.nip44Decrypt('b'.repeat(64), 'two')
    const third = t.nip44Encrypt('b'.repeat(64), 'three')
    await flush()
    expect(st.pending.map((p) => p.method)).toEqual(['nip44Encrypt'])

    st.pending.shift()!.reject(new Error('My Signet declined.'))
    await expect(first).rejects.toThrow('declined')
    await flush()
    expect(st.pending.map((p) => p.method)).toEqual(['nip44Decrypt'])

    st.pending.shift()!.resolve({ result: 'pt' })
    await expect(second).resolves.toBe('pt')
    await flush()
    st.pending.shift()!.resolve({ result: 'ct' })
    await expect(third).resolves.toBe('ct')
    expect(st.maxOpen).toBe(1)
  })

  it('a request that never answers releases the queue after holdMs', async () => {
    vi.useFakeTimers()
    const st = nativeNip55.state
    st.open = 0; st.maxOpen = 0; st.pending.length = 0
    const t = transportFromNip55('a'.repeat(64), 'com.example.signer', { holdMs: 1_000 })
    void t.nip44Encrypt('b'.repeat(64), 'stuck')
    const next = t.nip44Decrypt('b'.repeat(64), 'next')
    await vi.advanceTimersByTimeAsync(999)
    expect(st.pending.map((p) => p.method)).toEqual(['nip44Encrypt'])
    await vi.advanceTimersByTimeAsync(1)
    expect(st.pending.map((p) => p.method)).toEqual(['nip44Encrypt', 'nip44Decrypt'])
    st.pending[1]!.resolve({ result: 'pt' })
    await expect(next).resolves.toBe('pt')
  })
})

// Review follow-up to 36c939d: a background call (a relay-delivered wrap
// being unwrapped) must never fall back to the `nostrsigner:` intent — the
// plugin is told `interactive: false` and answers from the content
// provider alone; one the provider can't answer comes back unavailable.
describe('background calls (interactive: false)', () => {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await Promise.resolve()
    await new Promise((r) => setTimeout(r, 0))
  }

  it('a background RemoteSigner tells the NIP-55 plugin not to use an intent; a normal one does not', async () => {
    const st = nativeNip55.state
    st.open = 0; st.maxOpen = 0; st.pending.length = 0
    const t = transportFromNip55('a'.repeat(64), 'com.example.signer')
    const bg = new RemoteSigner(t, { interactive: false })
    const fg = new RemoteSigner(t)
    const a = bg.nip44Decrypt('b'.repeat(64), 'ct1')
    await flush()
    expect(st.pending[0]!.args).toMatchObject({ payload: 'ct1', interactive: false })
    st.pending.shift()!.resolve({ result: 'pt1' })
    await expect(a).resolves.toBe('pt1')
    const b = fg.nip44Decrypt('b'.repeat(64), 'ct2')
    await flush()
    expect(st.pending[0]!.args).not.toHaveProperty('interactive')
    st.pending.shift()!.resolve({ result: 'pt2' })
    await expect(b).resolves.toBe('pt2')
    const c = bg.signEvent(T)
    await flush()
    expect(st.pending[0]!.args).toMatchObject({ interactive: false })
    st.pending.shift()!.reject(new Error('stop'))
    await expect(c).rejects.toThrow()
  })

  it("the plugin's can't-answer-silently rejection is SignerUnavailable (defer), not a refusal", async () => {
    const st = nativeNip55.state
    st.open = 0; st.maxOpen = 0; st.pending.length = 0
    const bg = new RemoteSigner(transportFromNip55('a'.repeat(64), 'com.example.signer'), { interactive: false })
    const p = bg.nip44Decrypt('b'.repeat(64), 'ct')
    await flush()
    st.pending.shift()!.reject(new Error('The signer app could not answer in the background.'))
    const err = await p.catch((e: unknown) => e)
    expect(err).toBeInstanceOf(SignerUnavailable)
    expect(err).not.toBeInstanceOf(SignerRejected)
  })
})
