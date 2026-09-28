import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as store from './store.js'
import { sessionForTests, startSession, setTransportFactoryForTests, signOut } from './session.js'
import { setContactsSource } from './contacts.js'
import { fakeContacts } from './test-support/fake-contacts.js'
import { fakeBunker } from './test-support/fake-bunker.js'

// contacts-grant.ts talks to @forgesworn/signet-contacts over a real (fake)
// relay pool — far more than this module's own rendering/dispatch needs.
// Mocked at contacts-view.ts's own one call site (`beginPairing`) so these
// tests drive the connect flow's screen-state machine directly, the same
// "mock at the boundary this module actually calls" idiom contacts-
// grant.test.ts itself uses one layer down.
const beginPairingMock = vi.fn()
const grantedCapabilitiesMock = vi.fn(() => null as readonly string[] | null)
vi.mock('./contacts-grant.js', () => ({
  beginPairing: (...args: unknown[]) => beginPairingMock(...(args as [])),
  grantedCapabilities: (...args: unknown[]) => grantedCapabilitiesMock(...(args as [])),
}))

// Device check 2026-09-26, fix 6: mocked at contacts-view.ts's own one call
// site the same way, so these tests drive `openSignerUri`'s own choice
// (native openUri vs the window.open fallback) without a real plugin.
const nip55OpenUriMock = vi.fn(async () => {})
vi.mock('./nip55.js', () => ({
  openUri: (...args: unknown[]) => nip55OpenUriMock(...(args as [])),
}))

import {
  BANNER_TEXT,
  CONNECT_CONTACTS_LABEL,
  OPEN_MY_SIGNET_LABEL,
  DEPENDANT_SCAN_HINT,
  CONNECTED_LABEL,
  BULK_PROMPT_HEADER,
  CODE_COPY_PREFIX,
  CODE_CONFIRM_LABEL,
  CODE_CANCEL_LABEL,
  NARROWED_TIER_NOTICE,
  NARROWED_BLOCKS_NOTICE,
  NEEDED_CAPS_HINT,
  RECONNECT_LABEL,
  WAITING_CANCEL_LABEL,
  bannerView,
  connectScreenView,
  youContactsView,
  promptsView,
  handleAction,
  isConnected,
  resetForSignOut,
  resetForTests,
} from './contacts-view.js'
import { prompts as trustPrompts } from './trust-watch.js'
import type { SessionInfo } from './session.js'

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

function actionNode(dataset: Record<string, string>): HTMLElement {
  return { dataset } as unknown as HTMLElement
}

beforeEach(() => {
  vi.stubGlobal('localStorage', fakeLocalStorage())
  resetForTests()
  setContactsSource(null)
})

afterEach(async () => {
  sessionForTests(null)
  setTransportFactoryForTests(null)
  await signOut().catch(() => {})
  setContactsSource(null)
  beginPairingMock.mockReset()
  grantedCapabilitiesMock.mockReset()
  grantedCapabilitiesMock.mockReturnValue(null)
  nip55OpenUriMock.mockReset()
  nip55OpenUriMock.mockResolvedValue(undefined)
  vi.unstubAllGlobals()
})

/** A `PendingPairing`-shaped fake, same contract contacts-grant.ts's real
 *  `beginPairing` hands back once an ack lands: `code` to show, `confirm`/
 *  `cancel` to route the two buttons to. */
function fakePendingPairing(code = '042 917'): { code: string; confirm: () => Promise<void>; cancel: () => void; confirmCalls: number; cancelCalls: number } {
  const result = {
    code,
    confirmCalls: 0,
    cancelCalls: 0,
    async confirm() { result.confirmCalls++ },
    cancel() { result.cancelCalls++ },
  }
  return result
}

describe('bannerView', () => {
  it('is empty unless the grant is disconnected', () => {
    setContactsSource(fakeContacts({ status: 'none' }))
    expect(bannerView()).toBe('')
    setContactsSource(fakeContacts({ status: 'connected' }))
    expect(bannerView()).toBe('')
  })

  it(`shows "${BANNER_TEXT}" when disconnected`, () => {
    setContactsSource(fakeContacts({ status: 'disconnected' }))
    expect(bannerView()).toContain(BANNER_TEXT)
    expect(bannerView()).toContain('data-action="contacts-connect"')
  })
})

describe('connectScreenView', () => {
  it('shows the "Connect contacts" button (idle, non-NIP-55 session)', () => {
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
    const self = { identityPk: 'a'.repeat(64), dependant: false, name: 'Test', transport: { kind: 'nip46', bunkerUri: 'bunker://test' }, phonePk: 'x' } as SessionInfo
    const html = connectScreenView(self)
    expect(html).toContain(CONNECT_CONTACTS_LABEL)
    expect(html).not.toContain(OPEN_MY_SIGNET_LABEL)
  })

  it('shows the "Open My Signet" button for a NIP-55 session', async () => {
    const bunker = fakeBunker({})
    setTransportFactoryForTests(async () => bunker)
    const full = await startSession(
      { identityPk: bunker.pubkey, dependant: false, name: 'Test', transport: { kind: 'nip55', packageName: 'app.example.signer' } },
      bunker,
    )
    const html = connectScreenView(full)
    expect(html).toContain(OPEN_MY_SIGNET_LABEL)
    expect(html).not.toContain(CONNECT_CONTACTS_LABEL)
  })

  it('launches the signet-grant URI via the native plugin, targeted at the session\'s own signer package, and shows the waiting state', async () => {
    const bunker = fakeBunker({})
    setTransportFactoryForTests(async () => bunker)
    const full = await startSession(
      { identityPk: bunker.pubkey, dependant: false, name: 'Test', transport: { kind: 'nip55', packageName: 'app.example.signer' } },
      bunker,
    )
    const openSpy = vi.fn()
    vi.stubGlobal('window', { open: openSpy })
    let resolveWait: (v: ReturnType<typeof fakePendingPairing> | false) => void = () => {}
    beginPairingMock.mockResolvedValue({ uri: 'signet-grant://abc', wait: new Promise((r) => { resolveWait = r }) })

    handleAction('contacts-connect', actionNode({}))
    await Promise.resolve()
    await Promise.resolve()

    // Device check 2026-09-26, fix 6: targets the signer package directly
    // (never the plain, chooser-prone window.open) when one is known.
    expect(nip55OpenUriMock).toHaveBeenCalledWith({ uri: 'signet-grant://abc', packageName: 'app.example.signer' })
    expect(openSpy).not.toHaveBeenCalled()
    expect(connectScreenView(full)).toContain('Waiting for My Signet')
    expect(isConnected()).toBe(false)

    // The ack landed — the pairing verification code is shown; it must not
    // already say "Connected" (security MUST: nothing is persisted/fetched/
    // started, and nothing is shown as connected, until Continue).
    const pending = fakePendingPairing()
    resolveWait(pending)
    await Promise.resolve()
    await Promise.resolve()
    expect(isConnected()).toBe(false)
    const confirming = connectScreenView(full)
    expect(confirming).toContain(CODE_COPY_PREFIX)
    expect(confirming).toContain('042 917')
    expect(confirming).toContain(CODE_CONFIRM_LABEL)
    expect(confirming).toContain(CODE_CANCEL_LABEL)
    expect(confirming).not.toContain(CONNECTED_LABEL)

    // "Continue" — My Signet reported a match.
    handleAction('contacts-code-confirm', actionNode({}))
    await Promise.resolve()
    await Promise.resolve()
    expect(pending.confirmCalls).toBe(1)
    expect(pending.cancelCalls).toBe(0)
    expect(isConnected()).toBe(true)
    expect(connectScreenView(full)).toContain(CONNECTED_LABEL)
  })

  // Device check 2026-09-26, fix 6: the native plugin isn't available on
  // web/dev (or the call itself can fail) — better a chooser than nothing
  // opening at all.
  it('falls back to window.open when the native plugin call fails', async () => {
    const bunker = fakeBunker({})
    setTransportFactoryForTests(async () => bunker)
    const full = await startSession(
      { identityPk: bunker.pubkey, dependant: false, name: 'Test', transport: { kind: 'nip55', packageName: 'app.example.signer' } },
      bunker,
    )
    const openSpy = vi.fn()
    vi.stubGlobal('window', { open: openSpy })
    nip55OpenUriMock.mockRejectedValue(new Error('not available'))
    beginPairingMock.mockResolvedValue({ uri: 'signet-grant://abc', wait: new Promise(() => {}) })

    handleAction('contacts-connect', actionNode({}))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(openSpy).toHaveBeenCalledWith('signet-grant://abc', '_blank')
  })

  it('"It didn\'t match / Cancel" discards the pairing and returns to idle, without ever confirming', async () => {
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
    const self = { identityPk: 'a'.repeat(64), dependant: false, name: 'Test', transport: { kind: 'nip46', bunkerUri: 'bunker://test' }, phonePk: 'x' } as SessionInfo
    const pending = fakePendingPairing()
    beginPairingMock.mockResolvedValue({ uri: 'signet-grant://x', wait: Promise.resolve(pending) })

    handleAction('contacts-connect', actionNode({}))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    expect(connectScreenView(self)).toContain(CODE_CANCEL_LABEL)

    handleAction('contacts-code-cancel', actionNode({}))
    expect(pending.cancelCalls).toBe(1)
    expect(pending.confirmCalls).toBe(0)
    expect(isConnected()).toBe(false)
    expect(connectScreenView(self)).toContain(CONNECT_CONTACTS_LABEL)
  })

  it('sign-out while the code is showing discards it (resetForSignOut calls cancel)', async () => {
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
    const pending = fakePendingPairing()
    beginPairingMock.mockResolvedValue({ uri: 'signet-grant://x', wait: Promise.resolve(pending) })

    handleAction('contacts-connect', actionNode({}))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    resetForSignOut()

    expect(pending.cancelCalls).toBe(1)
    expect(pending.confirmCalls).toBe(0)
    expect(isConnected()).toBe(false)
  })

  it('shows the QR and waiting state for a non-NIP-55 session, with the dependant hint for a dependant', async () => {
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64), dependant: true })
    const self = { identityPk: 'a'.repeat(64), dependant: true, name: 'Test', transport: { kind: 'nip46', bunkerUri: 'bunker://test' }, phonePk: 'x' } as SessionInfo
    let resolveWait: (v: boolean) => void = () => {}
    beginPairingMock.mockResolvedValue({ uri: 'signet-grant://xyz', wait: new Promise<boolean>((r) => { resolveWait = r }) })

    handleAction('contacts-connect', actionNode({}))
    await Promise.resolve()
    await Promise.resolve()

    const html = connectScreenView(self)
    expect(html).toContain('<img class="qr"')
    expect(html).toContain(DEPENDANT_SCAN_HINT)
    expect(html).toContain(WAITING_CANCEL_LABEL)
    expect(html).toContain('data-action="contacts-connect-cancel"')
    resolveWait(false)
  })

  it('shows a failure notice when the wait resolves false, and can be retried', async () => {
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
    const self = { identityPk: 'a'.repeat(64), dependant: false, name: 'Test', transport: { kind: 'nip46', bunkerUri: 'bunker://test' }, phonePk: 'x' } as SessionInfo
    beginPairingMock.mockResolvedValue({ uri: 'signet-grant://x', wait: Promise.resolve(false) })

    handleAction('contacts-connect', actionNode({}))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    expect(connectScreenView(self)).toContain('form-error')
  })

  // Device check 2026-09-26, fix 2: the "waiting" screen had no way out.
  describe('Cancel while waiting', () => {
    it('shows Cancel on the NIP-55 waiting screen, and it returns to idle', async () => {
      const bunker = fakeBunker({})
      setTransportFactoryForTests(async () => bunker)
      const full = await startSession(
        { identityPk: bunker.pubkey, dependant: false, name: 'Test', transport: { kind: 'nip55', packageName: 'app.example.signer' } },
        bunker,
      )
      vi.stubGlobal('window', { open: vi.fn() })
      beginPairingMock.mockResolvedValue({ uri: 'signet-grant://abc', wait: new Promise(() => {}) })

      handleAction('contacts-connect', actionNode({}))
      await Promise.resolve()
      await Promise.resolve()
      expect(connectScreenView(full)).toContain(WAITING_CANCEL_LABEL)

      handleAction('contacts-connect-cancel', actionNode({}))
      const html = connectScreenView(full)
      // Back to idle — its own Connect/"Open My Signet" button is "Try again".
      expect(html).toContain(OPEN_MY_SIGNET_LABEL)
      expect(html).not.toContain('Waiting for My Signet')
    })

    it('a late ack for a cancelled attempt is ignored — never shown as a code screen', async () => {
      sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
      const self = { identityPk: 'a'.repeat(64), dependant: false, name: 'Test', transport: { kind: 'nip46', bunkerUri: 'bunker://test' }, phonePk: 'x' } as SessionInfo
      const pending = fakePendingPairing()
      let resolveWait: (v: typeof pending | false) => void = () => {}
      beginPairingMock.mockResolvedValue({ uri: 'signet-grant://x', wait: new Promise((r) => { resolveWait = r }) })

      handleAction('contacts-connect', actionNode({}))
      await Promise.resolve()
      await Promise.resolve()
      expect(connectScreenView(self)).toContain('Waiting for My Signet')

      handleAction('contacts-connect-cancel', actionNode({}))
      expect(connectScreenView(self)).toContain(CONNECT_CONTACTS_LABEL)

      // The ack this cancelled attempt was waiting on arrives late.
      resolveWait(pending)
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(connectScreenView(self)).toContain(CONNECT_CONTACTS_LABEL)
      expect(connectScreenView(self)).not.toContain(CODE_COPY_PREFIX)
      expect(isConnected()).toBe(false)
    })

    it('a late timeout (wait resolves false) for a cancelled attempt does not show the failure notice', async () => {
      sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
      const self = { identityPk: 'a'.repeat(64), dependant: false, name: 'Test', transport: { kind: 'nip46', bunkerUri: 'bunker://test' }, phonePk: 'x' } as SessionInfo
      let resolveWait: (v: false) => void = () => {}
      beginPairingMock.mockResolvedValue({ uri: 'signet-grant://x', wait: new Promise((r) => { resolveWait = r }) })

      handleAction('contacts-connect', actionNode({}))
      await Promise.resolve()
      await Promise.resolve()

      handleAction('contacts-connect-cancel', actionNode({}))
      resolveWait(false)
      await Promise.resolve()
      await Promise.resolve()

      expect(connectScreenView(self)).not.toContain('form-error')
      expect(connectScreenView(self)).toContain(CONNECT_CONTACTS_LABEL)
    })

    it('cancelling and reconnecting starts a genuinely fresh pairing (a new beginPairing call)', async () => {
      sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
      const self = { identityPk: 'a'.repeat(64), dependant: false, name: 'Test', transport: { kind: 'nip46', bunkerUri: 'bunker://test' }, phonePk: 'x' } as SessionInfo
      beginPairingMock.mockResolvedValue({ uri: 'signet-grant://x', wait: new Promise(() => {}) })

      handleAction('contacts-connect', actionNode({}))
      await Promise.resolve()
      await Promise.resolve()
      handleAction('contacts-connect-cancel', actionNode({}))

      beginPairingMock.mockClear()
      const pending = fakePendingPairing()
      beginPairingMock.mockResolvedValue({ uri: 'signet-grant://y', wait: Promise.resolve(pending) })
      handleAction('contacts-connect', actionNode({}))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()

      expect(beginPairingMock).toHaveBeenCalledTimes(1)
      expect(connectScreenView(self)).toContain(CODE_COPY_PREFIX)
    })
  })

  // Device check 2026-09-26, fix 1: the narrowed-grant notice had no way to
  // act on it.
  it('shows a Reconnect button alongside the narrowed-grant notice once connected, and it starts a fresh pairing exactly like Connect', async () => {
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
    const self = { identityPk: 'a'.repeat(64), dependant: false, name: 'Test', transport: { kind: 'nip46', bunkerUri: 'bunker://test' }, phonePk: 'x' } as SessionInfo
    const pending = fakePendingPairing()
    beginPairingMock.mockResolvedValue({ uri: 'signet-grant://x', wait: Promise.resolve(pending) })

    handleAction('contacts-connect', actionNode({}))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    handleAction('contacts-code-confirm', actionNode({}))
    await Promise.resolve()
    await Promise.resolve()
    expect(isConnected()).toBe(true)

    grantedCapabilitiesMock.mockReturnValue(['signet.contacts.read:directory'])
    const html = connectScreenView(self)
    expect(html).toContain(NARROWED_TIER_NOTICE)
    expect(html).toContain(RECONNECT_LABEL)
    expect(html).toContain('data-action="contacts-connect"')

    beginPairingMock.mockClear()
    beginPairingMock.mockResolvedValue({ uri: 'signet-grant://y', wait: new Promise(() => {}) })
    handleAction('contacts-connect', actionNode({}))
    await Promise.resolve()
    expect(beginPairingMock).toHaveBeenCalledTimes(1)
    expect(connectScreenView(self)).toContain('Waiting for My Signet')
  })

  it('shows no Reconnect button once connected with the full grant (nothing to reconnect for)', async () => {
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
    const self = { identityPk: 'a'.repeat(64), dependant: false, name: 'Test', transport: { kind: 'nip46', bunkerUri: 'bunker://test' }, phonePk: 'x' } as SessionInfo
    const pending = fakePendingPairing()
    beginPairingMock.mockResolvedValue({ uri: 'signet-grant://x', wait: Promise.resolve(pending) })

    handleAction('contacts-connect', actionNode({}))
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()
    handleAction('contacts-code-confirm', actionNode({}))
    await Promise.resolve()
    await Promise.resolve()

    expect(connectScreenView(self)).not.toContain(RECONNECT_LABEL)
  })

  // Session decision: tell the user which three boxes to tick in My Signet,
  // right where they're about to go tick them (or are already waiting on
  // having ticked them) — never once already connected/confirming.
  describe('the "tick all three" hint', () => {
    it('shows on the idle screen for a NIP-55 session', async () => {
      const bunker = fakeBunker({})
      setTransportFactoryForTests(async () => bunker)
      const full = await startSession(
        { identityPk: bunker.pubkey, dependant: false, name: 'Test', transport: { kind: 'nip55', packageName: 'app.example.signer' } },
        bunker,
      )
      expect(connectScreenView(full)).toContain(NEEDED_CAPS_HINT)
    })

    it('shows on the idle screen for a QR (non-NIP-55) session', () => {
      sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
      const self = { identityPk: 'a'.repeat(64), dependant: false, name: 'Test', transport: { kind: 'nip46', bunkerUri: 'bunker://test' }, phonePk: 'x' } as SessionInfo
      expect(connectScreenView(self)).toContain(NEEDED_CAPS_HINT)
    })

    it('shows on the QR waiting screen', async () => {
      sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
      const self = { identityPk: 'a'.repeat(64), dependant: false, name: 'Test', transport: { kind: 'nip46', bunkerUri: 'bunker://test' }, phonePk: 'x' } as SessionInfo
      beginPairingMock.mockResolvedValue({ uri: 'signet-grant://x', wait: new Promise(() => {}) })

      handleAction('contacts-connect', actionNode({}))
      await Promise.resolve()
      await Promise.resolve()

      expect(connectScreenView(self)).toContain(NEEDED_CAPS_HINT)
    })

    it('does not show once confirming or connected', async () => {
      sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
      const self = { identityPk: 'a'.repeat(64), dependant: false, name: 'Test', transport: { kind: 'nip46', bunkerUri: 'bunker://test' }, phonePk: 'x' } as SessionInfo
      const pending = fakePendingPairing()
      beginPairingMock.mockResolvedValue({ uri: 'signet-grant://x', wait: Promise.resolve(pending) })

      handleAction('contacts-connect', actionNode({}))
      await Promise.resolve()
      await Promise.resolve()
      await Promise.resolve()
      expect(connectScreenView(self)).not.toContain(NEEDED_CAPS_HINT)

      handleAction('contacts-code-confirm', actionNode({}))
      await Promise.resolve()
      await Promise.resolve()
      expect(connectScreenView(self)).not.toContain(NEEDED_CAPS_HINT)
    })
  })
})

describe('youContactsView', () => {
  it('shows "Connect contacts" when the grant has never paired', () => {
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
    setContactsSource(fakeContacts({ status: 'none' }))
    expect(youContactsView()).toContain(CONNECT_CONTACTS_LABEL)
  })

  it('shows a connected summary when paired', () => {
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
    setContactsSource(fakeContacts({
      status: 'connected',
      contacts: [{ contactId: 'k1', pks: ['x'.repeat(64)], name: 'Kim', tier: 'kin', blocked: false }],
    }))
    const html = youContactsView()
    expect(html).toContain(CONNECTED_LABEL)
    expect(html).toContain('1 contact.')
  })

  it('defers to the banner when disconnected (renders nothing itself)', () => {
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
    setContactsSource(fakeContacts({ status: 'disconnected' }))
    expect(youContactsView()).toBe('')
  })

  it('is empty when signed out', () => {
    expect(youContactsView()).toBe('')
  })

  it('shows the tier notice when the grant lacks signet.contacts.read:tier', () => {
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
    setContactsSource(fakeContacts({ status: 'connected', contacts: [] }))
    grantedCapabilitiesMock.mockReturnValue(['signet.contacts.read:directory', 'signet.contacts.blocks.read'])
    const html = youContactsView()
    expect(html).toContain(NARROWED_TIER_NOTICE)
    expect(html).not.toContain(NARROWED_BLOCKS_NOTICE)
  })

  it("shows the softer blocks notice when the grant lacks blocks.read, and both when it lacks both", () => {
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
    setContactsSource(fakeContacts({ status: 'connected', contacts: [] }))
    grantedCapabilitiesMock.mockReturnValue(['signet.contacts.read:directory', 'signet.contacts.read:tier'])
    let html = youContactsView()
    expect(html).toContain(NARROWED_BLOCKS_NOTICE)
    expect(html).not.toContain(NARROWED_TIER_NOTICE)

    grantedCapabilitiesMock.mockReturnValue(['signet.contacts.read:directory'])
    html = youContactsView()
    expect(html).toContain(NARROWED_TIER_NOTICE)
    expect(html).toContain(NARROWED_BLOCKS_NOTICE)
  })

  it('shows neither notice with the full grant', () => {
    sessionForTests({ identityPk: 'a'.repeat(64), phoneSkHex: 'b'.repeat(64) })
    setContactsSource(fakeContacts({ status: 'connected', contacts: [] }))
    grantedCapabilitiesMock.mockReturnValue([
      'signet.contacts.read:directory', 'signet.contacts.read:tier', 'signet.contacts.blocks.read',
    ])
    const html = youContactsView()
    expect(html).not.toContain(NARROWED_TIER_NOTICE)
    expect(html).not.toContain(NARROWED_BLOCKS_NOTICE)
  })
})

describe('promptsView and trust-prompt actions', () => {
  it('renders the exact absent-prompt copy, and Remove/Keep answer the prompt', () => {
    store.update((p) => {
      p.circles = [{
        id: 'c1', name: 'Home', seedHex: '1'.repeat(64), epoch: 0,
        members: [{ pk: 'a'.repeat(64), role: 'guardian', name: 'Alex' }], createdAt: 100, configUpdatedAt: 100, configBy: 'a'.repeat(64),
      }]
      p.trustPrompts = [{ id: 'p1', kind: 'absent', pks: ['a'.repeat(64)], createdAt: 0 }]
    })
    const html = promptsView()
    expect(html).toContain('Alex is no longer in your contacts. Remove from circles?')
    expect(html).toContain('data-action="contacts-prompt-remove" data-prompt="p1"')
    expect(html).toContain('data-action="contacts-prompt-keep" data-prompt="p1"')

    handleAction('contacts-prompt-keep', actionNode({ prompt: 'p1' }))
    expect(trustPrompts()).toHaveLength(0)
  })

  it(`renders the bulk-prompt header "${BULK_PROMPT_HEADER}" with a list, and Remove all/Keep all answer it`, () => {
    store.update((p) => {
      p.circles = [{
        id: 'c1', name: 'Home', seedHex: '1'.repeat(64), epoch: 0,
        members: [
          { pk: 'a'.repeat(64), role: 'guardian', name: 'Alex' },
          { pk: 'b'.repeat(64), role: 'peer', name: 'Blair' },
        ],
        createdAt: 100, configUpdatedAt: 100, configBy: 'a'.repeat(64),
      }]
      p.trustPrompts = [{ id: 'p2', kind: 'bulk', pks: ['a'.repeat(64), 'b'.repeat(64)], createdAt: 0 }]
    })
    const html = promptsView()
    expect(html).toContain(BULK_PROMPT_HEADER)
    expect(html).toContain('<li>Alex</li>')
    expect(html).toContain('<li>Blair</li>')
    expect(html).toContain('Remove all')
    expect(html).toContain('Keep all')

    handleAction('contacts-prompt-remove', actionNode({ prompt: 'p2' }))
    expect(trustPrompts()).toHaveLength(0)
  })

  it('is empty with no open prompts', () => {
    expect(promptsView()).toBe('')
  })
})
