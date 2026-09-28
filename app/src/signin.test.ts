// Sign in with My Signet (Signet identity plan, Task 11). `attemptSignIn`
// and `parseBunkerLink` are the pure/directly-testable core this module's
// screens sit on top of — same "fake the transport, not the network" idiom
// as session.test.ts's own `fakeBunker`, so these tests never touch a real
// relay, bunker, or NIP-55 intent.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as store from './store.js'
import * as session from './session.js'
import { attemptSignIn, parseBunkerLink, connectBunkerLink, handleAction, view, shouldShow, resetForTests } from './signin.js'
import { fakeBunker } from './test-support/fake-bunker.js'
import { verifyDeviceStatement } from './device-statements.js'
import { createBunkerSigner } from 'signet-login'
import * as contactsView from './contacts-view.js'
import * as linkPairing from './link-pairing.js'

// Task 11 fix round 1, finding 6: `connectBunkerLink` goes through the REAL
// signet-login entry point (unlike `attemptSignIn`'s fake `SignerTransport`
// above), so exercising it against a real bunker/relay would need a live
// signer. `isBunkerUri`/`buildNostrConnectUri`/`createBunkerSignerFromNostrConnect`
// stay real (`importOriginal`) — only `createBunkerSigner` itself is a mock,
// configured per-test below.
vi.mock('signet-login', async (importOriginal) => {
  const actual = await importOriginal<typeof import('signet-login')>()
  return { ...actual, createBunkerSigner: vi.fn() }
})

// Same in-memory localStorage stand-in as session.test.ts — `attemptSignIn`
// creates a phone key (secure-key.ts) and, on success, a persisted session
// (session.ts's own `store.update`), both of which need somewhere to write.
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

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage())
  resetForTests()
})

afterEach(async () => {
  session.setTransportFactoryForTests(null)
  await session.signOut()
  resetForTests()
  vi.mocked(createBunkerSigner).mockReset()
  vi.unstubAllGlobals()
})

describe('attemptSignIn', () => {
  it('a successful flow ends with a session and a verified statement', async () => {
    const transport = fakeBunker({})
    const result = await attemptSignIn({
      transport,
      identityPk: transport.pubkey,
      dependant: false,
      transportDescriptor: { kind: 'nip46', bunkerUri: 'bunker://test' },
    })

    expect(result.ok).toBe(true)
    const current = session.currentSession()
    expect(current?.identityPk).toBe(transport.pubkey)
    expect(current?.dependant).toBe(false)
    expect(current?.statement).toBeDefined()
    const verified = verifyDeviceStatement(current?.statement)
    expect(verified?.identityPk).toBe(transport.pubkey)
    expect(verified?.phonePk).toBe(current?.phonePk)
  })

  // Device check 2026-09-26, fix 5: `name` used to be the raw hex pubkey's
  // first 8 chars ("Signed in as a1b2c3d4…") — never hex now, a short npub
  // instead. No real display-name source exists for the signed-in identity
  // itself yet (My Signet's contacts grant deliberately never carries the
  // owner's own pubkey — signet-contacts docs/WIRE.md §0, R-31), so this is
  // the fallback path every sign-in takes today.
  it('names the session with a short npub, never the raw hex pubkey', async () => {
    const transport = fakeBunker({})
    const result = await attemptSignIn({
      transport,
      identityPk: transport.pubkey,
      dependant: false,
      transportDescriptor: { kind: 'nip46', bunkerUri: 'bunker://test' },
    })

    expect(result.ok).toBe(true)
    const name = session.currentSession()?.name
    expect(name).toMatch(/^npub1.{4}….{4}$/)
    expect(name).not.toContain(transport.pubkey)
    expect(name).not.toContain(transport.pubkey.slice(0, 8))
  })

  // Task 11 fix round 1, finding 7c: distinguished from an explicit
  // SignerRejected "no" — the signer signed SOMETHING, it just doesn't
  // verify against the identity this pending sign-in is for.
  it('a signed statement that fails verification is reported as "invalid", distinct from a signer rejection, and leaves no session', async () => {
    const transport = fakeBunker({})
    const result = await attemptSignIn({
      transport,
      identityPk: 'f'.repeat(64), // deliberately not transport.pubkey — the signed statement won't verify against it
      dependant: false,
      transportDescriptor: { kind: 'nip46', bunkerUri: 'bunker://test' },
    })

    expect(result).toEqual({ ok: false, reason: 'invalid' })
    expect(session.currentSession()).toBeNull()
    expect(store.load().session).toBeUndefined()
  })

  it('a declined statement leaves no session', async () => {
    const transport = fakeBunker({ approve: () => false })
    const result = await attemptSignIn({
      transport,
      identityPk: transport.pubkey,
      dependant: false,
      transportDescriptor: { kind: 'nip46', bunkerUri: 'bunker://test' },
    })

    expect(result).toEqual({ ok: false, reason: 'rejected' })
    expect(session.currentSession()).toBeNull()
    expect(store.load().session).toBeUndefined()
  })

  it('an unavailable signer leaves no session either, and can be retried against the same transport', async () => {
    let attempts = 0
    const transport = fakeBunker({
      approve: () => {
        attempts += 1
        return attempts > 1 // fails the first attempt, succeeds the retry
      },
    })
    const pending = {
      transport,
      identityPk: transport.pubkey,
      dependant: false,
      transportDescriptor: { kind: 'nip46' as const, bunkerUri: 'bunker://test' },
    }

    const first = await attemptSignIn(pending)
    expect(first).toEqual({ ok: false, reason: 'rejected' })
    expect(session.currentSession()).toBeNull()

    const second = await attemptSignIn(pending)
    expect(second.ok).toBe(true)
    expect(session.currentSession()?.identityPk).toBe(transport.pubkey)
  })

  it('final review B, finding 10: session.startSession() throwing is reported as ok:false, not left stuck on the contacts step', async () => {
    const transport = fakeBunker({})
    const startSpy = vi.spyOn(session, 'startSession').mockRejectedValueOnce(new Error('keystore boom'))

    const result = await attemptSignIn({
      transport,
      identityPk: transport.pubkey,
      dependant: false,
      transportDescriptor: { kind: 'nip46', bunkerUri: 'bunker://test' },
    })

    expect(result).toEqual({ ok: false, reason: 'unavailable' })
    expect(session.currentSession()).toBeNull()
    expect(store.load().session).toBeUndefined()
    // Not left stuck on "Connect your contacts" with no session behind it —
    // restored to the explain step instead.
    expect(view(store.load())).not.toContain('Connect your contacts')
    expect(view(store.load())).toContain('Almost there')
    startSpy.mockRestore()
  })

  it('marks the session dependant:true when asked to', async () => {
    const transport = fakeBunker({ dependant: true, fullAutonomy: true })
    const result = await attemptSignIn({
      transport,
      identityPk: transport.pubkey,
      dependant: true,
      transportDescriptor: { kind: 'nip46', bunkerUri: 'bunker://test' },
    })

    expect(result.ok).toBe(true)
    expect(session.currentSession()?.dependant).toBe(true)
  })
})

describe('parseBunkerLink', () => {
  const pk = 'a'.repeat(64)

  it('accepts a plain bunker link', () => {
    const parsed = parseBunkerLink(`bunker://${pk}?relay=wss://relay.example&secret=abc`)
    expect(parsed).toEqual({ ok: true, uri: `bunker://${pk}?relay=wss://relay.example&secret=abc`, dependant: false })
  })

  it('trims surrounding whitespace (paste/scan noise)', () => {
    const parsed = parseBunkerLink(`  bunker://${pk}?relay=wss://relay.example  `)
    expect(parsed.ok).toBe(true)
  })

  it('sets dependant:true when the URI carries a dependant parameter', () => {
    const parsed = parseBunkerLink(`bunker://${pk}?relay=wss://relay.example&secret=abc&dependant=1`)
    expect(parsed).toEqual({ ok: true, uri: `bunker://${pk}?relay=wss://relay.example&secret=abc&dependant=1`, dependant: true })
  })

  it('a malformed bunker link shows an error and does not throw', () => {
    expect(() => parseBunkerLink('not a bunker link at all')).not.toThrow()
    expect(parseBunkerLink('not a bunker link at all')).toEqual({ ok: false })
  })

  it('rejects an empty paste without throwing', () => {
    expect(() => parseBunkerLink('')).not.toThrow()
    expect(parseBunkerLink('   ')).toEqual({ ok: false })
  })

  it('rejects a nostrconnect:// link (the QR-flow scheme, not a reconnect link) without throwing', () => {
    expect(() => parseBunkerLink(`nostrconnect://${pk}?relay=wss://relay.example`)).not.toThrow()
    expect(parseBunkerLink(`nostrconnect://${pk}?relay=wss://relay.example`)).toEqual({ ok: false })
  })
})

// Task 11 fix round 1, finding 7a: a dependant sign-in must never flash the
// full signed-in app between the statement verifying (session.startSession's
// own notify fires mid-attemptSignIn) and doSign setting the keep-running
// hint on return — app.ts only renders the normal app once
// `signin.shouldShow()` goes false, so this asserts it never does, for a
// dependant, while `attemptSignIn` is still running.
describe('attemptSignIn: no flash for a dependant (finding 7a)', () => {
  it('shouldShow() stays true throughout — never goes false the instant the session exists but before the hint screen is set', async () => {
    const bunker = fakeBunker({ dependant: true, fullAutonomy: true })
    const sawFalseWithSession: boolean[] = []
    const unsub = store.subscribe(() => {
      if (session.currentSession()) sawFalseWithSession.push(shouldShow())
    })

    const result = await attemptSignIn({
      transport: bunker,
      identityPk: bunker.pubkey,
      dependant: true,
      transportDescriptor: { kind: 'nip46', bunkerUri: 'bunker://test' },
    })
    unsub()

    expect(result.ok).toBe(true)
    // At least one notify fired while a session existed (startSession's own,
    // and/or recordStatement's) — every one of them must have seen
    // shouldShow() still true.
    expect(sawFalseWithSession.length).toBeGreaterThan(0)
    expect(sawFalseWithSession.every((v) => v === true)).toBe(true)
  })
})

// Task 11 fix round 1, finding 6: goes through the REAL signet-login entry
// point (`createBunkerSigner`, mocked at the top of this file), not a fake
// `SignerTransport` — checks the client-key reuse and dependant-marking
// contract at that real boundary, not just against attemptSignIn's already-
// connected `pending`.
describe('connectBunkerLink (finding 6)', () => {
  it('connects via signet-login, reuses the persisted NIP-46 client key, and marks a dependant= uri', async () => {
    const pk = 'b'.repeat(64)
    const fakeSigner = {
      pubkey: pk,
      bunkerUri: `bunker://${pk}?relay=wss://relay.example&secret=xyz`,
      close: vi.fn(),
    } as unknown as Awaited<ReturnType<typeof createBunkerSigner>>
    vi.mocked(createBunkerSigner).mockResolvedValue(fakeSigner)

    // Priming this first mints (and persists) the client key connectBunkerLink
    // must reuse rather than generating its own.
    const expectedClientSk = await session.bunkerClientSk()

    await connectBunkerLink(`bunker://${pk}?relay=wss://relay.example&secret=xyz&dependant=1`, 'dependant')

    expect(createBunkerSigner).toHaveBeenCalledTimes(1)
    const call = vi.mocked(createBunkerSigner).mock.calls[0][0]
    expect(call.uri).toBe(`bunker://${pk}?relay=wss://relay.example&secret=xyz&dependant=1`)
    expect(call.clientSecretKey).toEqual(expectedClientSk)
    expect(call.appName).toBe('Kindependence')
    expect(call.requestTimeoutMs).toBe(300_000)

    // The resulting pending sign-in was marked dependant — surfaced through
    // the explain screen's own dependant-only copy.
    expect(view(store.load())).toContain('Your parent will be asked on their phone.')
  })

  it('a createBunkerSigner failure shows a retry error, without throwing', async () => {
    vi.mocked(createBunkerSigner).mockRejectedValue(new Error('connect failed'))
    const pk = 'c'.repeat(64)

    await expect(connectBunkerLink(`bunker://${pk}?relay=wss://relay.example`, 'bunker')).resolves.toBeUndefined()
    expect(view(store.load())).toContain("Couldn't connect with that link")
  })
})

// Task 11 fix round 1, finding 5.
describe('scanner: a getUserMedia grant that resolves after the screen has moved on', () => {
  it('stops the stale stream instead of wiring it up', async () => {
    const stop = vi.fn()
    let resolveMedia!: (s: MediaStream) => void
    const mediaPromise = new Promise<MediaStream>((resolve) => { resolveMedia = resolve })
    vi.stubGlobal('navigator', {
      mediaDevices: { getUserMedia: vi.fn(() => mediaPromise) },
    })

    // Starts scanning (the dependant screen's primary path) — this kicks off
    // startScan(), which is now suspended awaiting the deferred getUserMedia.
    handleAction('signin-go-dependant', null as unknown as HTMLElement)
    // Back out before the camera permission prompt resolves.
    handleAction('signin-back', null as unknown as HTMLElement)

    resolveMedia({ getTracks: () => [{ stop }] } as unknown as MediaStream)
    // Flush the microtask queue (startScan's own continuation) before the
    // macrotask boundary below runs, regardless of how many ticks `await`
    // actually costs on this engine.
    await new Promise((r) => setTimeout(r, 0))

    expect(stop).toHaveBeenCalledTimes(1)
    // Never got as far as showing the welcome screen was left in place —
    // no crash, no stale scan wired onto it.
    expect(view(store.load())).toContain('Sign in with My Signet')
  })
})

// Task 11 fix round 1, finding 7e.
describe('sign-out error resilience (finding 7e)', () => {
  it('resets this module\'s own screen state back to welcome even when session.signOut() throws', async () => {
    // Move off 'welcome' with an action that touches no DOM/network.
    handleAction('signin-go-link', null as unknown as HTMLElement)
    expect(view(store.load())).toContain('I have a bunker link')

    const spy = vi.spyOn(session, 'signOut').mockRejectedValueOnce(new Error('keystore boom'))
    handleAction('signin-sign-out', null as unknown as HTMLElement)
    await new Promise((r) => setTimeout(r, 0))

    expect(view(store.load())).toContain('Sign in with My Signet')
    spy.mockRestore()
  })
})

describe('final review B, findings 1 and 9: sign-out resets contacts-view and link-pairing state too', () => {
  it('doSignOut() (this module\'s "Sign out" routine, also called from devices.ts) resets both modules', async () => {
    const contactsSpy = vi.spyOn(contactsView, 'resetForSignOut')
    const linkSpy = vi.spyOn(linkPairing, 'resetForSignOut')
    vi.spyOn(session, 'signOut').mockResolvedValueOnce(undefined)

    handleAction('signin-sign-out', null as unknown as HTMLElement)
    await new Promise((r) => setTimeout(r, 0))

    expect(contactsSpy).toHaveBeenCalledTimes(1)
    expect(linkSpy).toHaveBeenCalledTimes(1)
    contactsSpy.mockRestore()
    linkSpy.mockRestore()
  })
})

// Plan 2, Task 10: not in this task's own `Test:` file list, but the
// contract's own step-1 line ("the sign-in contacts step can be skipped")
// is most directly checked here, against the real screen-state machine —
// added as the smallest reasonable choice for where a real regression would
// actually be caught (see this task's own report for the note).
describe('plan 2, Task 10: the "Connect your contacts" step is skippable', () => {
  it('shows right after a successful (dependant) sign-in, and Skip moves on to the keep-running hint', async () => {
    const bunker = fakeBunker({ dependant: true, fullAutonomy: true })
    const result = await attemptSignIn({
      transport: bunker,
      identityPk: bunker.pubkey,
      dependant: true,
      transportDescriptor: { kind: 'nip46', bunkerUri: 'bunker://test' },
    })
    expect(result.ok).toBe(true)
    // Still short-circuited to this module's own view — the contacts step,
    // not yet the keep-running hint.
    expect(shouldShow()).toBe(true)
    expect(view(store.load())).toContain('Connect your contacts')

    handleAction('signin-contacts-continue', null as unknown as HTMLElement)

    // Skipping moves a dependant on to the keep-running hint (not straight
    // to the signed-in app) — shouldShow() stays true for that one more
    // beat, same as before this step existed.
    expect(shouldShow()).toBe(true)
    expect(view(store.load())).toContain('One more thing')
    expect(view(store.load())).not.toContain('Connect your contacts')
  })
})

// Task 10 fix round 1 (Important finding): the review caught that the
// dependant-only pre-flip above (finding 7a) left an adult's sign-in
// vulnerable to the exact same flash — session.startSession()'s own
// synchronous store.update()/notify() fires for EVERY sign-in, dependant or
// not, so an adult's screen must already say 'contacts' by the time that
// notify lands, same as attemptSignIn's "no flash for a dependant" test
// above checks. Failing before the fix: the pre-flip in attemptSignIn only
// ran `if (pending.dependant)`, so an adult's first post-startSession notify
// still saw screen.kind === 'explain' with a session now existing —
// shouldShow() false, view() the full app for that one frame.
describe('attemptSignIn: no flash for an adult either (Task 10 fix round 1)', () => {
  it('shouldShow() stays true throughout, and the first notify after the session exists already shows the contacts step, not the app', async () => {
    const bunker = fakeBunker({ dependant: false, fullAutonomy: true })
    const sawFalseWithSession: boolean[] = []
    let viewAtFirstSessionNotify: string | null = null
    const unsub = store.subscribe(() => {
      if (session.currentSession()) {
        sawFalseWithSession.push(shouldShow())
        if (viewAtFirstSessionNotify === null) viewAtFirstSessionNotify = view(store.load())
      }
    })

    const result = await attemptSignIn({
      transport: bunker,
      identityPk: bunker.pubkey,
      dependant: false,
      transportDescriptor: { kind: 'nip46', bunkerUri: 'bunker://test' },
    })
    unsub()

    expect(result.ok).toBe(true)
    expect(sawFalseWithSession.length).toBeGreaterThan(0)
    expect(sawFalseWithSession.every((v) => v === true)).toBe(true)
    expect(viewAtFirstSessionNotify).toContain('Connect your contacts')
  })
})


describe('dependant device statement approval window', () => {
  it('accepts guardian approval after the previous outer 60-second deadline', async () => {
    vi.useFakeTimers()
    try {
      const transport = fakeBunker({ dependant: true, latencyMs: 65_000 })
      const pending = attemptSignIn({ transport, identityPk: transport.pubkey, dependant: true, transportDescriptor: { kind: 'nip46', bunkerUri: 'bunker://test' } })
      await vi.advanceTimersByTimeAsync(65_001)
      expect(await pending).toMatchObject({ ok: true })
    } finally { vi.useRealTimers() }
  })
})
