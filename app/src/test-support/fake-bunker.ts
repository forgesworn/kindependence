// Test double for My Signet as a bunker (Signet identity plan, Task 4).
// Behaves like My Signet today (companion platform spec §1):
//  - owner route: serves get_public_key, sign_event and nip44_* — whatever
//    `approve` allows (what the owner taps; default: allow).
//  - dependant route: nip44_* is refused below full autonomy; sign_event of
//    an unclassified kind (such as 30078) asks every time via `approve`
//    (what the guardian taps) below full autonomy, and is automatic at full
//    autonomy.
//  - asleep: while `asleep()` is true a request hangs (the caller's own
//    timeout fires). When it wakes, a request older than 300 s by `now()`
//    is dropped. The fake stops waiting (and polling) once a request has
//    slept past 300 s — it is doomed by then, and the caller has usually
//    given up long before, so no timer loop outlives the test.
// Every request is logged in `requests` before any policy runs.

import { finalizeEvent, generateSecretKey, getPublicKey } from 'nostr-tools/pure'
import { encrypt, decrypt, getConversationKey } from 'nostr-tools/nip44'
import type { SignedEvent } from '@forgesworn/roost-kit'
import { SignerRejected, SignerUnavailable, type SignerTransport } from '../remote-signer.js'

export interface FakeBunkerRequest {
  method: string
  kind?: number
}

const MAX_AGE_MS = 300_000
const WAKE_POLL_MS = 1_000

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export function fakeBunker(opts: {
  sk?: Uint8Array
  dependant?: boolean
  fullAutonomy?: boolean
  latencyMs?: number
  asleep?: () => boolean
  approve?: (req: FakeBunkerRequest) => boolean
  now?: () => number
}): SignerTransport & { requests: FakeBunkerRequest[] } {
  const sk = opts.sk ?? generateSecretKey()
  const pubkey = getPublicKey(sk)
  const now = opts.now ?? (() => Date.now())
  const approve = opts.approve ?? (() => true)
  const requests: FakeBunkerRequest[] = []

  /** Arrival, sleep, expiry and policy for one request. */
  async function admit(req: FakeBunkerRequest): Promise<void> {
    requests.push(req)
    const issuedAt = now()
    if (opts.latencyMs) await wait(opts.latencyMs)
    if (opts.asleep?.()) {
      let slept = 0
      while (opts.asleep()) {
        if (slept > MAX_AGE_MS) throw new SignerUnavailable('request expired while the signer was asleep')
        await wait(WAKE_POLL_MS)
        slept += WAKE_POLL_MS
      }
      if (now() - issuedAt > MAX_AGE_MS) throw new SignerUnavailable('request expired while the signer was asleep')
    }
    if (!opts.dependant) {
      if (!approve(req)) throw new SignerRejected('the owner declined')
      return
    }
    if (opts.fullAutonomy) return
    if (req.method.startsWith('nip44_')) throw new SignerRejected('nip44 is refused below full autonomy')
    if (req.method === 'sign_event' && !approve(req)) throw new SignerRejected('the guardian declined')
  }

  return {
    pubkey,
    requests,
    async signEvent(t) {
      await admit({ method: 'sign_event', kind: t.kind })
      return finalizeEvent({ ...t, created_at: t.created_at ?? Math.floor(now() / 1000) }, sk) as SignedEvent
    },
    async nip44Encrypt(peer, pt) {
      await admit({ method: 'nip44_encrypt' })
      return encrypt(pt, getConversationKey(sk, peer))
    },
    async nip44Decrypt(peer, ct) {
      await admit({ method: 'nip44_decrypt' })
      return decrypt(ct, getConversationKey(sk, peer))
    },
    async close() {},
  }
}
