// NIP-55 (Signet identity plan, Task 4): the Android signer-app contract,
// spoken through the app-local `Nip55Plugin.java` (hand-registered in
// MainActivity, like SecureKeyPlugin). The plugin tries the signer's
// content provider first (silent, once approved there) and falls back to a
// `nostrsigner:` intent; `get_public_key` always goes by intent, since it is
// the moment the person picks the account.
//
// The plugin hands back the signer's raw answer; the parsing (npub or hex,
// a whole signed event or a bare signature) lives here so it can be tested
// without Android. Plugin rejections carry a code — SIGNER_REJECTED for an
// explicit refusal, SIGNER_ABORTED for an intent finished with no answer —
// that `mapSignerError` (remote-signer.ts) classes them by.

import type { SignedEvent } from '@forgesworn/roost-kit'
import { getEventHash } from 'nostr-tools/pure'
import { decode } from 'nostr-tools/nip19'

export interface InstalledSigner {
  packageName: string
  label: string
}

/** A `sign_event` answer as the signer gave it: the whole event in `event`,
 *  or (older signers) only the signature in `result`. */
export interface Nip55SignAnswer {
  event?: string | null
  result?: string | null
}

/** `interactive: false` — answer from the signer's content provider only;
 *  if it cannot answer silently, reject (no `nostrsigner:` intent, so the
 *  signer app never comes to the front). For calls no one tapped for. */
interface Background {
  interactive?: false
}
type SignOpts = { packageName: string; pubkey: string; eventJson: string } & Background
type CryptOpts = { packageName: string; pubkey: string; peer: string; payload: string } & Background

/** Wire shape shared with `Nip55Plugin.java`. */
interface Nip55NativePlugin {
  installedSigners(): Promise<{ signers: InstalledSigner[] }>
  getPublicKey(o: { packageName?: string }): Promise<{ result: string; package?: string | null }>
  signEvent(o: SignOpts): Promise<Nip55SignAnswer>
  nip44Encrypt(o: CryptOpts): Promise<{ result: string }>
  nip44Decrypt(o: CryptOpts): Promise<{ result: string }>
  openUri(o: { uri: string; packageName?: string }): Promise<void>
}

/** Resolved fresh per call, with no module-scope `@capacitor/core` import —
 *  same discipline as secure-key.ts. */
// A Capacitor plugin proxy answers every property, `then` included, so a
// promise resolved with it calls the missing native `then()` and rejects.
// The proxy is therefore handed back boxed.
async function plugin(): Promise<{ p: Nip55NativePlugin }> {
  const { registerPlugin } = await import('@capacitor/core')
  return { p: registerPlugin<Nip55NativePlugin>('Nip55') }
}

const HEX_KEY = /^[0-9a-f]{64}$/
const HEX_SIG = /^[0-9a-f]{128}$/

/** A signer answers `get_public_key` with an npub or hex; both are the same key. */
export function publicKeyFromNip55(result: string | null | undefined): string | null {
  const v = result?.trim()
  if (!v) return null
  if (HEX_KEY.test(v.toLowerCase())) return v.toLowerCase()
  try {
    const d = decode(v)
    return d.type === 'npub' ? d.data : null
  } catch {
    return null
  }
}

/** The signed event out of a `sign_event` answer. Signature validity is not
 *  checked here — `RemoteSigner` does that for every transport. */
export function signedEventFromNip55(
  answer: Nip55SignAnswer,
  unsigned: Omit<SignedEvent, 'id' | 'sig'>,
): SignedEvent | null {
  if (answer.event) {
    try {
      const parsed: unknown = JSON.parse(answer.event)
      if (parsed && typeof parsed === 'object') return parsed as SignedEvent
    } catch {
      // fall through to the bare-signature form
    }
  }
  const sig = answer.result?.trim().toLowerCase()
  if (!sig || !HEX_SIG.test(sig)) return null
  const ev = { ...unsigned, tags: unsigned.tags.map((t) => [...t]) }
  return { ...ev, id: getEventHash(ev), sig }
}

export async function installedSigners(): Promise<InstalledSigner[]> {
  return (await (await plugin()).p.installedSigners()).signers
}

/** Asks the signer app (or, with no `packageName`, whichever the system
 *  picks) which key it holds. Returns the hex key and the package that
 *  answered, which is the one to sign with afterwards. */
export async function getPublicKey(o: { packageName?: string } = {}): Promise<{ pubkey: string; packageName: string }> {
  const answer = await (await plugin()).p.getPublicKey(o)
  const pubkey = publicKeyFromNip55(answer.result)
  if (!pubkey) throw new Error('The signer app did not return a public key.')
  const packageName = answer.package || o.packageName
  if (!packageName) throw new Error('The signer app did not say which app it is.')
  return { pubkey, packageName }
}

export async function signEvent(o: SignOpts): Promise<Nip55SignAnswer> {
  return (await plugin()).p.signEvent(o)
}

export async function nip44Encrypt(o: CryptOpts): Promise<{ result: string }> {
  return (await plugin()).p.nip44Encrypt(o)
}

export async function nip44Decrypt(o: CryptOpts): Promise<{ result: string }> {
  return (await plugin()).p.nip44Decrypt(o)
}

/** Device check 2026-09-26, fix 6: opens `uri` via `ACTION_VIEW`, targeted
 *  at `packageName` when one is given (`Nip55Plugin.openUri`'s own
 *  `setPackage`) — so Android never shows an "Open with" chooser when more
 *  than one app answers the same scheme (e.g. My Signet's release and
 *  acceptance builds side by side). Fire-and-forget: resolves once the
 *  intent is launched, not once anything answers it. */
export async function openUri(o: { uri: string; packageName?: string }): Promise<void> {
  await (await plugin()).p.openUri(o)
}
