// Remote signer (Signet identity plan, Task 4): a `Signer` whose key lives
// in My Signet, not in this app. Kindependence asks for signatures and
// NIP-44 over one of two transports:
//  - NIP-46 via the `signet-login` package (`transportFromSignetSigner`),
//    for a bunker on another device or in the browser;
//  - NIP-55 via the app-local `Nip55Plugin` (`transportFromNip55`), for a
//    signer app installed on this phone.
//
// `RemoteSigner` puts one policy on top of either transport:
//  - every call has a deadline (default 60 s). A signer that is asleep, out
//    of reach or waiting on someone to tap never answers; the caller gets
//    `SignerUnavailable` and may retry later.
//  - every failure is classed as `SignerRejected` (someone, or a policy,
//    said no: do not retry) or `SignerUnavailable` (anything else: retry
//    later) by `mapSignerError`.
//  - every signed event that comes back is checked: a valid signature (via
//    `verifySignedWire`, never nostr-tools' `verifyEvent` on the returned
//    object — see its doc comment for the cached-flag bypass), by our
//    pubkey, over exactly the kind, content, tags and created_at we asked
//    for. Anything else is `SignerRejected`: a signer that returns the wrong
//    thing will not do better on a retry.

import type { EventTemplate, SignedEvent, Signer } from '@forgesworn/roost-kit'
import type { SignetSigner } from 'signet-login'
import { verifySignedWire } from './device-statements.js'
import * as nip55 from './nip55.js'

/** Per-call options a transport may honour.
 *
 *  `interactive: false` — the call was not started by the person (a relay
 *  delivered something in the background): the transport must answer only
 *  by its silent path and never bring the signer's screen up. For NIP-55
 *  that is the content provider alone — no `nostrsigner:` intent fallback;
 *  a provider that cannot answer silently (signer locked, not yet approved,
 *  busy) fails as `SignerUnavailable`. NIP-46 has only one path and ignores
 *  it. Omitted (or `true`): the normal path, intent fallback included. */
export interface SignerCallOpts {
  interactive?: boolean
}

export interface SignerTransport {
  readonly pubkey: string
  signEvent(t: EventTemplate, opts?: SignerCallOpts): Promise<SignedEvent>
  nip44Encrypt(peer: string, pt: string, opts?: SignerCallOpts): Promise<string>
  nip44Decrypt(peer: string, ct: string, opts?: SignerCallOpts): Promise<string>
  close(): Promise<void>
}

/** Called after any `RemoteSigner` call the signer answered — the signer is
 *  reachable again, so work deferred while it was not (circles.ts's
 *  deferred personal-inbox wraps) can be retried. */
const answeredListeners = new Set<() => void>()

/** Registers `fn` to run (asynchronously) each time a `RemoteSigner` call
 *  gets an answer from the signer. Returns an unregister function. */
export function onSignerAnswered(fn: () => void): () => void {
  answeredListeners.add(fn)
  return () => { answeredListeners.delete(fn) }
}

function noteSignerAnswered(): void {
  for (const fn of [...answeredListeners]) {
    setTimeout(() => {
      try { fn() } catch (e) { console.error('signer-answered listener failed', e) }
    }, 0)
  }
}

/** Timeout, asleep, no connection: retry later. */
export class SignerUnavailable extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignerUnavailable'
  }
}

/** Final fix A7: the `SignerUnavailable` of a request that got no answer
 *  before its deadline — unlike a connect or relay failure, the request may
 *  still be waiting on the signer's screen. */
export class SignerTimedOut extends SignerUnavailable {
  constructor(message: string) {
    super(message)
    this.name = 'SignerTimedOut'
  }
}

/** Final review, item 1: an interactive request the person backed out of —
 *  Back or swipe-away on the signer's screen (NIP-55 RESULT_CANCELED with no
 *  `rejected` extra, `NIP55_ABORTED`). Nobody said no, so it is a
 *  `SignerUnavailable` (a caller that only offers "try again" treats it as
 *  one), but it is NOT a reason to ask again on its own: nothing may re-send
 *  it automatically — only the person's own Retry. */
export class SignerAborted extends SignerUnavailable {
  constructor(message: string) {
    super(message)
    this.name = 'SignerAborted'
  }
}

/** The user or guardian said no, or the policy refused: do not retry. */
export class SignerRejected extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SignerRejected'
  }
}

const REJECTION = /reject|denied|declined|cancel/i

// Why signet-login's own "event returned from bunker is improperly signed"
// error maps to SignerUnavailable while RemoteSigner's verify failure (in
// signEvent below) is SignerRejected: the message has none of the refusal
// words, so the table sends it to "retry later" — it is thrown inside the
// NIP-46 client, where a garbled or truncated relay answer is the likely
// cause, and a fresh request can succeed. Our own check runs on an answer
// the transport delivered intact; an event that is still wrong there means
// the signer signed the wrong thing, and retrying will not change that.

/** Nip55Plugin's error codes (`call.reject(message, code)`; Capacitor puts
 *  the code on the rejected error's `code`). REJECTED: the signer said no —
 *  an explicit `rejected` extra, or its content provider refused. ABORTED:
 *  the intent came back RESULT_CANCELED with no `rejected` extra — the
 *  signer's activity was finished under it (step 8: My Signet's singleTask
 *  MainActivity relaunched from the launcher while its PIN screen was up),
 *  or the person backed out — nobody refused, so it is `SignerAborted`:
 *  retry only when the person asks. */
export const NIP55_REJECTED = 'SIGNER_REJECTED'
export const NIP55_ABORTED = 'SIGNER_ABORTED'

/** Classes any error from a transport. Our own two classes pass through
 *  unchanged; a Nip55Plugin code decides next (`NIP55_ABORTED` →
 *  `SignerAborted`, `NIP55_REJECTED` → `SignerRejected`); then
 *  an error whose message says someone refused (`reject`, `denied`,
 *  `declined`, `cancel`) is `SignerRejected`; everything else, timeouts
 *  included, is `SignerUnavailable`. */
export function mapSignerError(e: unknown): SignerRejected | SignerUnavailable {
  if (e instanceof SignerRejected || e instanceof SignerUnavailable) return e
  const message = messageOf(e)
  const code = e && typeof e === 'object' ? (e as { code?: unknown }).code : undefined
  if (code === NIP55_ABORTED) return new SignerAborted(message)
  if (code === NIP55_REJECTED) return new SignerRejected(message)
  return REJECTION.test(message) ? new SignerRejected(message) : new SignerUnavailable(message)
}

/** The text of whatever was thrown: an Error's message, a string, or a
 *  plain object's string `message` (bridges and some libraries reject with
 *  `{ message }` rather than an Error). */
function messageOf(e: unknown): string {
  if (e instanceof Error) return e.message
  if (typeof e === 'string') return e
  if (e && typeof e === 'object' && typeof (e as { message?: unknown }).message === 'string') {
    return (e as { message: string }).message
  }
  return 'signer error'
}

export const GUARDIAN_APPROVAL_TIMEOUT_MS = 300_000

const DEFAULT_TIMEOUT_MS = 60_000

function sameTags(a: unknown, b: string[][]): boolean {
  if (!Array.isArray(a) || a.length !== b.length) return false
  return a.every((tag, i) => {
    const want = b[i] as string[]
    return Array.isArray(tag) && tag.length === want.length && tag.every((v, j) => v === want[j])
  })
}

export class RemoteSigner implements Signer {
  readonly pubkey: string
  private readonly timeoutMs: number
  private readonly callOpts: SignerCallOpts | undefined

  /** `opts.interactive: false` makes every call of this signer a
   *  background one (see `SignerCallOpts`) — for work no one tapped for,
   *  such as unwrapping what a relay delivered. */
  constructor(private readonly transport: SignerTransport, opts: { timeoutMs?: number; interactive?: boolean } = {}) {
    this.pubkey = transport.pubkey
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.callOpts = opts.interactive === false ? { interactive: false } : undefined
  }

  /** Runs `op` against the deadline and classes its failure. A late answer
   *  after the deadline is dropped (the promise has already settled). */
  private call<R>(what: string, op: () => Promise<R>): Promise<R> {
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new SignerTimedOut(`${what}: no answer from the signer within ${this.timeoutMs} ms`)),
        this.timeoutMs,
      )
      let pending: Promise<R>
      try {
        pending = op()
      } catch (e) {
        pending = Promise.reject(e)
      }
      pending.then(
        (v) => { clearTimeout(timer); noteSignerAnswered(); resolve(v) },
        (e) => { clearTimeout(timer); reject(mapSignerError(e)) },
      )
    })
  }

  async signEvent(t: EventTemplate): Promise<SignedEvent> {
    const template: EventTemplate = {
      kind: t.kind,
      content: t.content,
      tags: t.tags.map((tag) => [...tag]),
      created_at: t.created_at ?? Math.floor(Date.now() / 1000),
    }
    const returned = await this.call('sign_event', () => this.transport.signEvent(template, this.callOpts))
    const ev = verifySignedWire(returned)
    if (!ev) throw new SignerRejected('the signer returned an event with an invalid signature')
    if (ev.pubkey !== this.pubkey) throw new SignerRejected('the signer signed with a different key')
    if (
      ev.kind !== template.kind ||
      ev.content !== template.content ||
      ev.created_at !== template.created_at ||
      !sameTags(ev.tags, template.tags)
    ) {
      throw new SignerRejected('the signer returned a different event from the one asked for')
    }
    return ev
  }

  async nip44Encrypt(peer: string, pt: string): Promise<string> {
    return stringAnswer(await this.call('nip44_encrypt', () => this.transport.nip44Encrypt(peer, pt, this.callOpts)))
  }

  async nip44Decrypt(peer: string, ct: string): Promise<string> {
    return stringAnswer(await this.call('nip44_decrypt', () => this.transport.nip44Decrypt(peer, ct, this.callOpts)))
  }
}

function stringAnswer(v: unknown): string {
  if (typeof v !== 'string') throw new SignerRejected('the signer returned no text')
  return v
}

/** NIP-46 through signet-login. A signer without NIP-44 refuses those
 *  calls outright (`SignerRejected`) — there is nothing to retry. NIP-46
 *  has one path only, so `SignerCallOpts.interactive` changes nothing. */
export function transportFromSignetSigner(s: SignetSigner): SignerTransport {
  return {
    pubkey: s.pubkey,
    async signEvent(t) {
      return s.signEvent({ kind: t.kind, content: t.content, tags: t.tags, created_at: t.created_at })
    },
    async nip44Encrypt(peer, pt) {
      if (!s.nip44) throw new SignerRejected('this signer does not offer NIP-44')
      return s.nip44.encrypt(peer, pt)
    },
    async nip44Decrypt(peer, ct) {
      if (!s.nip44) throw new SignerRejected('this signer does not offer NIP-44')
      return s.nip44.decrypt(peer, ct)
    },
    close: () => s.close(),
  }
}

/** Runs ops one at a time, in order. An op holds the chain until it settles
 *  or `holdMs` passes, whichever is first — so a request the signer never
 *  answers (the person left its screen open) cannot block every later one.
 *  Anything that runs after such a release while the old intent is still
 *  open is refused by Nip55Plugin itself ("still open") → SignerUnavailable. */
function serialised(holdMs: number): <R>(op: () => Promise<R>) => Promise<R> {
  let tail: Promise<void> = Promise.resolve()
  return <R>(op: () => Promise<R>): Promise<R> => {
    const run = tail.then(op)
    tail = tail.then(() => new Promise<void>((release) => {
      const timer = setTimeout(release, holdMs)
      const done = (): void => { clearTimeout(timer); release() }
      run.then(done, done)
    }))
    return run
  }
}

/** The plugin option for a background call: `interactive: false` tells
 *  Nip55Plugin to answer from the content provider only, never by intent
 *  (see `SignerCallOpts`). Nothing for a normal call. */
function background(o: SignerCallOpts | undefined): { interactive?: false } {
  return o?.interactive === false ? { interactive: false } : {}
}

/** NIP-55 through the app-local plugin, to the signer app `packageName`
 *  that holds `pubkey` (from `nip55.getPublicKey`). Nothing to close: each
 *  call is its own intent or content-provider query.
 *
 *  Requests are serialised: Capacitor tracks one outstanding activity-result
 *  call per plugin, so overlapping intents would answer the wrong request.
 *  `holdMs` (default 60 s, RemoteSigner's default deadline) is how long one
 *  request may hold the queue. */
export function transportFromNip55(pubkey: string, packageName: string, opts: { holdMs?: number } = {}): SignerTransport {
  const one = serialised(opts.holdMs ?? DEFAULT_TIMEOUT_MS)
  return {
    pubkey,
    signEvent: (t, o) => one(async () => {
      const unsigned = { pubkey, kind: t.kind, content: t.content, tags: t.tags, created_at: t.created_at ?? Math.floor(Date.now() / 1000) }
      const answer = await nip55.signEvent({ packageName, pubkey, eventJson: JSON.stringify(unsigned), ...background(o) })
      const ev = nip55.signedEventFromNip55(answer, unsigned)
      if (!ev) throw new SignerUnavailable('the signer app did not return a signed event')
      return ev
    }),
    nip44Encrypt: (peer, pt, o) => one(async () =>
      (await nip55.nip44Encrypt({ packageName, pubkey, peer, payload: pt, ...background(o) })).result),
    nip44Decrypt: (peer, ct, o) => one(async () =>
      (await nip55.nip44Decrypt({ packageName, pubkey, peer, payload: ct, ...background(o) })).result),
    async close() {},
  }
}
