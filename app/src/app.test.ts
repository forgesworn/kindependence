// Final fix B8 (ledger must-fix, Task 11 minor): a dedicated sign-out
// teardown regression test. The teardown is the only thing stopping the
// geo watch and inbox subscriptions after sign-out — a privacy regression
// Task 11 already hit once (see app.ts's own `render()` doc comment on
// "fix round 1, finding 4": circles.ensure/beacons.ensure/nativeGeo.ensure
// must be called UNCONDITIONALLY on every render, never gated on "is there
// a session" at the call site — gating the CALL meant the very render that
// should have torn everything down was the one render that skipped calling
// ensure() at all).
//
// app.ts's own view/render layer is otherwise build-gated, no unit tests
// (same convention as every other domain module's UI section) — its
// render() touches real DOM (innerHTML, querySelectorAll, addEventListener)
// and, on the Map tab, lazily loads maplibre-gl. This one test drives
// mount() with a minimal hand-stubbed `document`/root element (same
// "fakeLocalStorage()" idiom this codebase already uses everywhere else for
// a browser API not available under vitest's node environment), staying off
// the Map tab (via showTab('circles') before root exists) so the maplibre
// lazy-import path is never reached.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as store from './store.js'
import * as circles from './circles.js'
import * as beacons from './beacons.js'
import * as nativeGeo from './native-geo.js'
import * as structuralQueue from './structural-queue.js'
import { sessionForTests } from './session.js'
import type { SignerTransport } from './remote-signer.js'
import { makeLocalSigner, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { generateSecretKey, getPublicKey } from 'nostr-tools/pure'

// Every subscription this test's signed-in render opens (circles.ts's own
// personal/phone inbox, beacons.ts's per-circle inbox) goes through
// `subscribeGiftWraps` — mocked to return a fresh, trackable unsubscribe
// spy per call, and never actually deliver anything, so nothing here
// touches a real relay. `publishSigned` mocked too (beacons.ts's own
// `ensureOutboxFlush`/emit-timer machinery may attempt a publish).
const unsubscribeSpies: Array<ReturnType<typeof vi.fn>> = []
vi.mock('@forgesworn/roost-kit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@forgesworn/roost-kit')>()
  return {
    ...actual,
    publishSigned: vi.fn(async () => ({})),
    subscribeGiftWraps: vi.fn(() => {
      const unsub = vi.fn()
      unsubscribeSpies.push(unsub)
      return unsub
    }),
  }
})

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

/** Just enough of `HTMLElement` for `render()`'s own DOM writes
 *  (`root.innerHTML = …`, `root.querySelectorAll('[data-action]')`) to run
 *  without throwing — the rendered markup itself isn't this test's concern. */
function fakeRoot(): HTMLElement {
  return {
    innerHTML: '',
    querySelectorAll: () => [] as unknown as NodeListOf<HTMLElement>,
  } as unknown as HTMLElement
}

function localTransport(skHex: string): SignerTransport {
  const s = makeLocalSigner(skHex)
  return {
    pubkey: s.pubkey,
    signEvent: (t) => s.signEvent(t),
    nip44Encrypt: (peer, pt) => s.nip44Encrypt(peer, pt),
    nip44Decrypt: (peer, ct) => s.nip44Decrypt(peer, ct),
    close: async () => {},
  }
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage())
  vi.stubGlobal('document', {
    addEventListener: () => {}, removeEventListener: () => {}, visibilityState: 'visible', getElementById: () => null,
  })
  vi.stubGlobal('window', { addEventListener: () => {}, removeEventListener: () => {} })
  unsubscribeSpies.length = 0
})

afterEach(() => {
  sessionForTests(null)
  structuralQueue.resetForTests()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('final fix B8: sign-out teardown — circles.ensure/beacons.ensure/nativeGeo.ensure run unconditionally on every render, and the render right after sign-out actually closes every open subscription', () => {
  it('sign in, render (mount), sign out, render again: ensure() is called both times (never skipped), and every subscription opened while signed in is closed by the post-sign-out render', async () => {
    const { mount, showTab } = await import('./app.js')
    // Off the Map tab BEFORE root exists, so mount()'s own first render
    // never takes the lazy maplibre-gl import path.
    showTab('circles')

    const identitySk = generateSecretKey()
    const identityPk = getPublicKey(identitySk)
    const phoneSkHex = toHex(generateSecretKey())
    const circle: Circle = {
      id: 'c1', name: 'Test circle', seedHex: '1'.repeat(64), epoch: 0,
      members: [{ pk: identityPk, role: 'guardian' }], createdAt: 100, configUpdatedAt: 100, configBy: identityPk,
    }
    store.save({ ...store.load(), circles: [circle] })
    sessionForTests({ identityPk, phoneSkHex, dependant: false, transport: localTransport(toHex(identitySk)) })

    const circlesSpy = vi.spyOn(circles, 'ensure')
    const beaconsSpy = vi.spyOn(beacons, 'ensure')
    const nativeGeoSpy = vi.spyOn(nativeGeo, 'ensure')

    await mount(fakeRoot())

    // A store write DURING this first render (milestones.ts's own step-up
    // evaluation, places.ts's tick()) re-enters render() before mount()
    // returns, so this may already be more than one call — the point here
    // isn't an exact count, it's that ensure() runs AT LEAST once while
    // signed in, so there's something real to tear down below.
    const circlesCallsWhileSignedIn = circlesSpy.mock.calls.length
    const beaconsCallsWhileSignedIn = beaconsSpy.mock.calls.length
    const nativeGeoCallsWhileSignedIn = nativeGeoSpy.mock.calls.length
    expect(circlesCallsWhileSignedIn).toBeGreaterThan(0)
    expect(beaconsCallsWhileSignedIn).toBeGreaterThan(0)
    expect(nativeGeoCallsWhileSignedIn).toBeGreaterThan(0)
    // Signed in, with a circle: at least one subscription was actually opened.
    expect(unsubscribeSpies.length).toBeGreaterThan(0)
    for (const unsub of unsubscribeSpies) expect(unsub).not.toHaveBeenCalled()

    // Sign out — the same "session gone, store changed" shape
    // session.signOut()/store.clear() produces, without this test needing a
    // real Keystore/secretStore round trip.
    sessionForTests(null)
    store.notify()

    // Fix round 1, finding 4's own regression, guarded: a call site gated
    // on "is there a session" would have skipped exactly this render (the
    // one where the session just became null), leaking the geo watch and
    // every inbox subscription past sign-out. It must not be skipped — each
    // ensure() must have run AT LEAST ONE MORE time after the store changed.
    expect(circlesSpy.mock.calls.length).toBeGreaterThan(circlesCallsWhileSignedIn)
    expect(beaconsSpy.mock.calls.length).toBeGreaterThan(beaconsCallsWhileSignedIn)
    expect(nativeGeoSpy.mock.calls.length).toBeGreaterThan(nativeGeoCallsWhileSignedIn)
    // And it must have actually torn down every subscription opened above —
    // "no subscription writes to the store" after sign-out, proven here as
    // "no subscription is even still open to write from".
    for (const unsub of unsubscribeSpies) expect(unsub).toHaveBeenCalledTimes(1)
  })
})

describe('plan 2, Task 10: the disconnected banner and the You-tab "Connect contacts" entry', () => {
  it('shows the banner on both Circles and You when disconnected, and "Connect contacts" on You once reconnected to "none"', async () => {
    const { mount, showTab } = await import('./app.js')
    const { setContactsSource } = await import('./contacts.js')
    const { fakeContacts } = await import('./test-support/fake-contacts.js')
    showTab('circles')

    const identitySk = generateSecretKey()
    const identityPk = getPublicKey(identitySk)
    const phoneSkHex = toHex(generateSecretKey())
    sessionForTests({ identityPk, phoneSkHex, dependant: false, transport: localTransport(toHex(identitySk)) })
    setContactsSource(fakeContacts({ status: 'disconnected' }))

    const root = fakeRoot()
    await mount(root)
    expect(root.innerHTML).toContain('Contacts disconnected — reconnect My Signet')

    showTab('you')
    expect(root.innerHTML).toContain('Contacts disconnected — reconnect My Signet')

    setContactsSource(fakeContacts({ status: 'none' }))
    store.notify()
    expect(root.innerHTML).not.toContain('Contacts disconnected — reconnect My Signet')
    expect(root.innerHTML).toContain('Connect contacts')

    setContactsSource(null)
  })
})
