// Circles tab: create/join a circle, invite members (contact picker, npub
// paste), receive invites, sync roster config, and reseed on member removal.
// Render-on-state, same idiom as contacts.ts: `view()` is
// a pure string builder embedded in app.ts's Circles tab; `ensure()` is the one
// side-effecting entry point (keeps the personal-inbox gift-wrap
// subscription live), kept separate so app.ts can call it outside the render
// pass; `handleAction()` is the click dispatcher app.ts delegates
// `circle-*` actions to.
//
// Roster model (binding — see covey-kit's circle.ts): `mergeConfig` is a
// latest-wins FULL REPLACEMENT of the member list, not a CRDT union. Two
// devices independently broadcasting partial views of the roster can clobber
// each other. So every membership change here has exactly ONE writer: the
// device performing the change (invite-send) locally updates the roster via
// `upsertMember`, then sends the resulting FULL config as an identity-signed
// structural `config` event (Signet identity plan, Task 8: queued for the
// identity signer, then posted on the circle inbox — `enqueueConfig`).
// Removals are re-keys (`sendRekey`, spec 3 §5), not config writes. A device
// that only just joined never broadcasts its
// own (necessarily incomplete) view — it waits to receive the authoritative
// one. covey's `upsertMember`/`removeMember` do NOT bump
// `configUpdatedAt`/`configBy` themselves (see `addLocalMember`/
// `removeLocalMember` below) — every call site here does that explicitly so
// the latest-wins clock actually reflects the change.
//
// Invites (Signet identity plan, Task 10; plan 2, Task 6): identity-signed.
// `doInvite` queues a structural `invite` inner event (structural.ts) for
// the remote identity signer (final fix A2: through the structural queue,
// `sendInvite` sends it once signed) — payload `{ id, name, mode, pk, role,
// memberName? }`: plan 2 makes the invite name its invitee, so it IS the
// adder's vouch (vouches.ts); no seed (final fix A3: seeds are never
// signed). Only a usable contact (kin, kith or a guardian link) can be
// invited. `sendInvite` then gift-wraps an `InviteBundle` — `{ invite,
// statement: <this device's own device statement>, seed, config: <the
// newest config held>, links: <guardian links between members> }` — SEALED
// by the fast local `phoneSigner()` (not the remote identity signer — one
// remote round trip per invite, not two): to an adult's personal inbox, or
// to each phone inbox of a dependant (`inviteDependantToCircle`, a linked
// guardian only). A receiver authenticates it by checking the wrap's seal
// signer (the sender's phone key) against the attached statement's `p`,
// and the statement's `identityPk` against the inner event's own signer —
// proving the sealing phone is genuinely bound to the identity that signed
// the invite — then drops it silently unless it names us and (adult) the
// inviter is a usable contact, or (dependant) the inviter is a linked
// guardian; the roster is bootstrapped from the bundle's config, each
// member judged by its vouch (`bootstrapRoster`). The personal inbox itself
// is subscribed only for a non-dependant session (`!session.dependant`);
// every wrap id is checked against the persisted `seenPersonalWraps` log
// BEFORE any decrypt, so a re-delivered wrap costs nothing, even across a
// restart. The old spoken word-code invite path is removed — direct
// (contact/npub) invites only.
//
// Roster healing (final-review I2, SUPERSEDED — review fix round 1 of the
// Signet identity plan's Task 9): a fresh joiner's self-only placeholder
// roster used to be silent until the writer's config reached it, which
// flock's own `t:'joined'` announce (vendored `joined.ts`) fixed by having
// the joiner announce itself and any full-roster device confirm/rebroadcast.
// That mechanism (`announceJoin`, `handleJoinedRumor`, the pure
// `applyJoinedAnnounce`/`applyJoinedMember`/`hasFullRoster` decision it
// funnelled through) is REMOVED: since the Signet identity plan, Task 8,
// membership comes from an identity-signed, guardian-authorised structural
// `config` (or the invite that seeds a joiner's own placeholder roster) —
// an unauthenticated `t:'joined'` self-announcement adds nothing a phone key
// couldn't already forge, and the structural config a joiner replays on
// subscribing (unlike the old personal-inbox path) is itself the durable fix
// the announce used to paper over. Anything ELSE that used to key off a
// `joined` announce (pins.ts's own anti-entropy resend) now derives from a
// genuine roster CHANGE instead — see `registerMemberAddedHandler` below,
// fired from `applyConfig` once a structural config's authority has already
// been verified.

import * as store from './store.js'
import * as approvals from './approvals.js'
import * as beacons from './beacons.js'
import * as poolHealth from './pool-health.js'
import * as activity from './activity.js'
import * as messages from './messages.js'
import * as pickup from './pickup.js'
import * as mapinfo from './mapinfo.js'
import { currentSession, phoneSigner, identitySigner } from './session.js'
import type { SessionInfo } from './session.js'
import { enqueue, registerSender, drain, pending, waitingCopy } from './structural-queue.js'
import { seedHash, verifyStructural, type StructuralEvent } from './structural.js'
import { structuralAuthorised, parseConfigV2, configVerdict, configVouchFor, mayRemove, vouchValid, type TrustView, type ConfigV2, type ConfigVerdict } from './authority.js'
import { verifyVouch, storeVouch, vouchFor, voucherOf, allVouches, creatorOf, setCreator, markUnvouched, unvouchedSince, forgetCircleVouches, storePendingVouch, pendingVouchesFor, dropPendingVouches, dropVouch, clearUnvouched, handOversFor, allHandOvers, type Vouch } from './vouches.js'
import { linked, linkedWithMe, linkEvents, acceptLinkPair, acceptUnlink, unlinksBetween, dependantsOf } from './guardian-links.js'
import { snapshot, usable, known, candidates, contactTier } from './contacts.js'
import { memberForPhone, phonesOf, forgetMember, rescanBuffered, acceptStatement } from './phone-keys.js'
import { verifyDeviceStatement, verifyLinkStatement } from './device-statements.js'
import { SignerUnavailable, SignerRejected, onSignerAnswered } from './remote-signer.js'
import { KINDS } from 'canary-kit/nostr'
import {
  circleFromInvite,
  applyReseed,
  upsertMember,
  removeMember as coveyRemoveMember,
  isGuardian,
  personalInboxTag,
  toHex,
} from '@forgesworn/covey-kit'
import type { Circle, CircleMember, Role, DirectMessage } from '@forgesworn/covey-kit'
import { publishSigned, subscribeGiftWraps, giftWrap, giftUnwrap } from '@forgesworn/roost-kit'
import type { Signer, SignedEvent, Rumor } from '@forgesworn/roost-kit'
import type { PolicyAction, PolicyVerdict } from './brood/index.js'
import { npubEncode, decode as nip19Decode } from 'nostr-tools/nip19'
import * as formState from './form-state.js'

export type { Circle } from '@forgesworn/covey-kit'

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** `publishSigned`'s signed-event param carries an index signature (so it
 *  works with any nostr-tools event shape) that concrete interfaces like
 *  roost-kit's `SignedEvent` or nostr-tools' `VerifiedEvent` structurally
 *  lack — this is the one place that gap is bridged. */
function publish(relays: string[], signed: { id: string; sig: string }): Promise<unknown> {
  return publishSigned(relays, signed as unknown as { id: string; sig: string; [k: string]: unknown })
}

// ---------------------------------------------------------------------------
// Relay boot helper — the app's one place to assemble a relay array (kit
// purity: covey-kit/roost-kit take relays as plain parameters and bake in no
// defaults of their own). VITE_DEFAULT_RELAY overrides the built-in default.
// ---------------------------------------------------------------------------

const ENV_RELAY = typeof import.meta.env.VITE_DEFAULT_RELAY === 'string' ? import.meta.env.VITE_DEFAULT_RELAY.trim() : ''
const DEFAULT_RELAY = ENV_RELAY || 'wss://relay.trotters.cc'

/** The app's relay set for covey/roost transport calls, built once from
 *  settings and falling back to the default relay. */
export function appRelays(p: store.Persisted): string[] {
  return [p.settings.relayUrl || DEFAULT_RELAY]
}

// ---------------------------------------------------------------------------
// Child-gating (BROOD) — a CHILD device consults `circleId`'s current
// FamilyPolicy (approvals.ts's `verdictFor`, backed by real synced state)
// before create-circle/add-member. A GUARDIAN device never calls this at
// all — every call site below checks `fam.role === 'child'` first. That's
// not an oversight: guardians ARE the approval authority, so asking one to
// approve their own action would be nonsensical, and since
// `DEFAULT_VERDICT` is `'prompt'`, an unconditional check here would
// silently block every guardian action on a circle with no policy set yet
// (i.e. every circle, until a guardian visits Settings at least once).
// `join-circle`/`add-contact` share the same `PolicyAction` set (and get
// their own row on the Settings screen — approvals.ts's `policyView`) but
// have no gating call site in THIS app yet — out of this task's contract,
// left for a follow-up.
// ---------------------------------------------------------------------------

function checkPolicy(circleId: string, action: PolicyAction): PolicyVerdict {
  return approvals.verdictFor(circleId, action)
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/** A kindependence identity's own role in any circle it's part of: a parent is
 *  always a guardian, a child is always a child — used both when creating a
 *  circle and when accepting an invite into one. */
export function roleFor(famRole: 'parent' | 'child'): Role {
  return famRole === 'parent' ? 'guardian' : 'child'
}

/** This device's own role in `circle`, or undefined if it isn't (yet) a
 *  recognised member — e.g. right after accepting an invite, before the
 *  inviter's config broadcast arrives. */
export function selfRole(circle: Circle, pkHex: string): Role | undefined {
  return circle.members.find((m) => m.pk === pkHex)?.role
}

/** Adds/updates a member and bumps the latest-wins config clock — covey's
 *  `upsertMember` alone does not (see the module doc comment above). */
export function addLocalMember(circle: Circle, member: CircleMember, byPkHex: string, at: number): Circle {
  const updated = upsertMember(circle, member, byPkHex, at)
  return { ...updated, configUpdatedAt: at, configBy: byPkHex }
}

/** Removes a member and bumps the latest-wins config clock — covey's
 *  `removeMember` alone does not (see the module doc comment above). */
export function removeLocalMember(circle: Circle, pk: string, byPkHex: string, at: number): Circle {
  const updated = coveyRemoveMember(circle, pk, byPkHex, at)
  return { ...updated, configUpdatedAt: at, configBy: byPkHex }
}

/** `circleFromInvite` stamps `configUpdatedAt` at ACCEPT time — which is
 *  always later than the inviter's own config broadcast (necessarily sent
 *  before the invite could even be received, let alone accepted). Left as
 *  covey-kit hands it back, `mergeConfig`'s strict latest-wins check would
 *  then PERMANENTLY reject that broadcast's fuller roster, no matter how
 *  many times it's retried — a freshly-joined, self-only roster is exactly
 *  the placeholder covey-kit's own doc comment describes ("full roster
 *  arrives via config sync"), so it must lose to the first real broadcast
 *  it sees, not win by virtue of being newer. Resetting the clock to the
 *  oldest possible value (0) achieves that: any real broadcast's
 *  `updatedAt` (a genuine unix timestamp) is unconditionally greater. */
function resetConfigClock(circle: Circle): Circle {
  return { ...circle, configUpdatedAt: 0, configBy: '' }
}

function randomHex(byteLen: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLen)))
}

/** A fresh circle id — just an unlinkability handle, not a secret. */
export function newCircleId(): string {
  return randomHex(8)
}

/** Creates a brand-new circle with a fresh random seed (Signet identity plan:
 *  every seed, first and re-keyed, is fresh random — there is no circle root
 *  to derive epochs from) and `creator` as its sole initial member. */
export function newCircle(name: string, creator: CircleMember, at: number): { circle: Circle } {
  const circle: store.StoredCircle = {
    id: newCircleId(),
    name,
    seedHex: randomHex(32),
    epoch: 0,
    members: [creator],
    createdAt: at,
    configUpdatedAt: at,
    configBy: creator.pk,
    epochStartedAt: at,
  }
  return { circle }
}

/** Starts a circle's replay-protection chain (`Persisted.seedHashes`) at its
 *  initial seed. Mutates `p`. */
function startSeedChain(p: store.Persisted, circle: Circle): void {
  p.seedHashes = { ...p.seedHashes, [circle.id]: [seedHash(circle.seedHex)] }
}

/** Persists a freshly created circle: appends it to `p.circles` and starts
 *  its seed-hash chain. Mutates `p` in place — call from within a
 *  `store.update()` callback. */
export function saveNewCircle(p: store.Persisted, circle: Circle): void {
  p.circles = [...p.circles, circle]
  startSeedChain(p, circle)
}

/** Persists a circle this device just joined (invite accept):
 *  replaces, not duplicates, any existing local entry for the same id (a
 *  joiner re-admitted after being removed, per `handleIncomingInvite`'s
 *  re-admission gate, replaces its stale pre-removal copy rather than
 *  sitting alongside it) — but, Task 10 fix round 3 finding 1(b), KEEPS
 *  that existing entry's seed-hash chain and `removals`/`removedPks`
 *  (except for any pk the fresh `circle.members` lists NOW — always
 *  including us, freshly (re)joined, so never still tombstoned) rather than
 *  resetting them: an even-older, pre-removal invite must stay recognisable
 *  as "a seed epoch we already held" (`knownSeedHashes`, `invitePasses`)
 *  after re-joining, not look like a fresh cut-off re-invite all over
 *  again. A genuinely first-time join (no existing local entry) still
 *  starts a brand new chain. Mutates `p`. */
export function saveJoinedCircle(p: store.Persisted, circle: Circle): void {
  const existing = p.circles.find((c) => c.id === circle.id) as store.StoredCircle | undefined
  let merged: store.StoredCircle = circle
  if (existing) {
    // Carry over history for anyone the fresh roster doesn't (re-)list —
    // but never for a pk `circle.members` lists NOW (always includes us,
    // freshly (re)joined — we are plainly not removed in this new epoch,
    // whatever the stale copy's tombstones said).
    const nowMembers = new Set(circle.members.map((m) => m.pk))
    // Final review A, I2: unioned with the joining circle's own tombstones.
    const fresh = circle as store.StoredCircle
    const removedPks = [...new Set([...(existing.removedPks ?? []), ...(fresh.removedPks ?? [])])].filter((pk) => !nowMembers.has(pk)).sort()
    const removals = Object.fromEntries(Object.entries({ ...(existing.removals ?? {}), ...(fresh.removals ?? {}) }).filter(([pk]) => !nowMembers.has(pk)))
    merged = { ...circle, removedPks: removedPks.length ? removedPks : undefined, removals: Object.keys(removals).length ? removals : undefined }
  }
  p.circles = [...p.circles.filter((c) => c.id !== circle.id), merged]
  // Task 6 fix round 1: a held re-key installed the seed we held before; on
  // a new seed it is stale (the caller records the bundle's, if any).
  if (existing && existing.seedHex !== circle.seedHex) {
    const last = p.lastRekey?.[circle.id]
    if (last?.event) p.lastRekey = { ...p.lastRekey, [circle.id]: { ...last, event: undefined } }
    if (p.heldRekeys && Object.hasOwn(p.heldRekeys, circle.id)) {
      p.heldRekeys = Object.fromEntries(Object.entries(p.heldRekeys).filter(([k]) => k !== circle.id))
    }
  }
  const priorChain = (p.seedHashes?.[circle.id]) ?? (existing ? [seedHash(existing.seedHex)] : [])
  const newHash = seedHash(circle.seedHex)
  p.seedHashes = { ...p.seedHashes, [circle.id]: priorChain.includes(newHash) ? priorChain : [...priorChain, newHash] }
}

/** Every seed hash `circle` has had, oldest first — the persisted chain plus
 *  the current seed's hash (always known, even for a circle persisted before
 *  its chain was started). A non-re-key structural event may chain to any of
 *  these; a re-key only to the last. */
export function knownSeedHashes(circle: Circle): string[] {
  const chain = store.load().seedHashes[circle.id] ?? []
  const current = seedHash(circle.seedHex)
  return chain.includes(current) ? chain : [...chain, current]
}

// ---------------------------------------------------------------------------
// Personal-inbox unwrap (Phase 7 Task 1 fix wave — reviewer-confirmed,
// exploitable end-to-end): covey-kit's own `readInvite`/
// `readFromPersonalInbox`/`readDmWrap` internally call `giftUnwrap` from
// THEIR OWN dependency on `@forgesworn/roost-kit` — which covey-kit still
// pins at the OLD `e95c613` (no `verifyEvent(seal)`, no
// `rumor.pubkey === seal.pubkey` binding; see this app's own package.json,
// pinned separately at the patched `8364712`, and beacons.ts's
// `onCircleInboxWrap`, which already routes its OWN (symmetric, shared-
// group-inbox) unwrap through the app-scope import for the same reason).
//
// The attack (reviewer-confirmed): an attacker seals a wrap under their OWN
// real key — a completely legitimate NIP-44 encrypt/decrypt, ECDH doesn't
// block a sender encrypting to a real recipient with their own real key —
// then sets the DECRYPTED rumor's `pubkey` field (fully attacker-controlled
// plaintext, since they authored it) to any pubkey they like, e.g. a real
// guardian's. With no seal/rumor-pubkey binding check, covey's read
// functions return that forged identity as `from`, and every caller here
// trusts it completely.
//
// Fix: unwrap every personal-inbox wrap ourselves via THIS APP'S OWN
// `giftUnwrap` import above (resolved to the patched roost-kit at app scope
// — see package.json), which performs the seal-verification/pubkey-binding
// covey-kit's internal copy is still missing. Only after that succeeds do we
// hand the now-authenticated rumor to a small local parse/validate step — no
// unwrap logic of our own, just parsing already-authenticated content.
//
// Task 10 layers a SECOND authentication step on top, specific to invites:
// the wrap's seal is signed by the SENDER'S PHONE key (not their identity —
// the remote identity signer only signs the inner structural event, one
// remote round trip per invite, not two), so `rumor.pubkey` here is a phone
// key, not an identity. The rumor's own content carries the inviter's device
// statement alongside the signed invite; binding the two together (seal
// signer == statement's phone key, statement's identity == the invite's own
// signer) is what proves this wrap genuinely came from a device the claimed
// inviter identity has authorised — see `parseIncomingInvite` below.
// ---------------------------------------------------------------------------

/** Verifies (seal signature + `rumor.pubkey === seal.pubkey`) and returns the
 *  inner rumor of a personal-inbox wrap addressed to `signer`'s identity.
 *  `rumor` is null if the wrap isn't ours, isn't decryptable, or is a
 *  forged/tampered seal — `giftUnwrap` itself swallows every decrypt error
 *  into that same `null`, so `failure` observes the decrypt callback
 *  directly: `'unavailable'` when a decrypt call threw `SignerUnavailable`
 *  (the signer didn't answer, timed out, or — for a background call —
 *  could not answer silently: locked, not approved yet), `'rejected'` when
 *  it threw `SignerRejected` (a definite refusal; My Signet answers that for
 *  any backend error too, a NIP-44 MAC failure on junk included), null
 *  otherwise. See `handlePersonalWrap` for what each one does. */
async function unwrapPersonalInbox(
  signer: Signer,
  wrap: { pubkey: string; content: string },
): Promise<{ rumor: Rumor | null; failure: 'unavailable' | 'rejected' | null }> {
  let failure: 'unavailable' | 'rejected' | null = null
  const rumor = await giftUnwrap(async (pk, ct) => {
    try {
      return await signer.nip44Decrypt(pk, ct)
    } catch (e) {
      if (e instanceof SignerRejected) failure ??= 'rejected'
      else if (e instanceof SignerUnavailable) failure ??= 'unavailable'
      throw e
    }
  }, wrap)
  return { rumor, failure }
}

const INVITE_SEED_RE = /^[0-9a-f]{64}$/

/** The inner `invite` structural event's own payload (structural.ts's
 *  `payload`, JSON) — `id` duplicates the envelope's own `circle` tag
 *  (checked for agreement below), `name` names the joiner's circle,
 *  `mode` is the invite kind ('family' for every invite this app sends
 *  today), `expiresAt` optional and currently unused. Plan 2 (Task 6): the
 *  invite names its invitee (`pk`), the `role` they join at and optionally
 *  their `memberName` — it is the adder's vouch (vouches.ts); a plan-1
 *  invite without them is refused. Final fix A3: the seed is NOT here — it
 *  is never signed; it rides in the phone-sealed rumor, bound by the signed
 *  `prev` (= its hash). */
interface InviteInner { id: string; name: string; mode: string; expiresAt?: number; pk: string; role: Role; memberName?: string }
const INVITE_ROLES: ReadonlySet<string> = new Set<Role>(['guardian', 'peer', 'child'])
function parseInviteInner(payload: string): InviteInner | null {
  let raw: unknown
  try { raw = JSON.parse(payload) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.name !== 'string' || !r.name) return null
  if (typeof r.mode !== 'string' || !r.mode) return null
  if (r.expiresAt !== undefined && typeof r.expiresAt !== 'number') return null
  if (typeof r.pk !== 'string' || !INVITE_SEED_RE.test(r.pk)) return null
  if (typeof r.role !== 'string' || !INVITE_ROLES.has(r.role)) return null
  if (r.memberName !== undefined && typeof r.memberName !== 'string') return null
  return {
    id: r.id, name: r.name, mode: r.mode, pk: r.pk, role: r.role as Role,
    ...(typeof r.expiresAt === 'number' ? { expiresAt: r.expiresAt } : {}),
    ...(typeof r.memberName === 'string' ? { memberName: r.memberName } : {}),
  }
}

/** Plan 2 (Task 6): the phone-sealed invite rumor's content. `config` is
 *  the newest config inner event the inviting device holds for the circle
 *  (signed, v2, carrying vouches) or null; `links` the guardian-link pairs
 *  between the circle's members, plus the pair joining the adder to the
 *  invitee when the invitee is a dependant; `rekey` the latest applied
 *  re-key inner event (Task 6 pre-review ruling) — a held config can
 *  predate it, so the joiner drops its cumulative removals. */
interface InviteBundle { invite: SignedEvent; statement: SignedEvent; seed: string; config: SignedEvent | null; links: Array<{ g: SignedEvent; d: SignedEvent }>; rekey: SignedEvent | null; vouches: SignedEvent[]; unlinks: SignedEvent[] }

/** At most this many link pairs of a bundle are looked at. */
const MAX_BUNDLE_LINKS = 64
/** Final review A, I5: at most this many of a bundle's own vouches are
 *  looked at. */
const MAX_BUNDLE_VOUCHES = 256
/** Final review A, I6: at most this many held unlinks travel in a bundle
 *  (and are re-posted when a member is added). */
const MAX_BUNDLE_UNLINKS = 50

/** A personal- or phone-inbox invite, authenticated and parsed — see this
 *  section's own doc comment for the two-layer check (structural signature,
 *  then seal/statement binding). `from` is the inviter's identity pubkey
 *  (the inner event's own signer); `phonePk` the inviter's phone key that
 *  sealed this wrap (== `statement`'s own `p`, already checked here — kept
 *  so accept can bind it into the new circle's phone-key table without
 *  re-verifying); `createdAt` the inner event's own timestamp. `vouch` is
 *  the invite as a vouch (null for an invite from our own identity, which
 *  can't vouch for itself). `config` and `links` are the bundle's, not yet
 *  judged. */
interface ParsedInvite {
  circleId: string
  seedHex: string
  name: string
  mode: string
  expiresAt?: number
  from: string
  phonePk: string
  statement: SignedEvent
  createdAt: number
  pk: string
  role: Role
  memberName?: string
  vouch: Vouch | null
  config: unknown
  links: unknown[]
  rekey: unknown
  /** Final review A, I5: the inviter's current vouches, unverified. */
  bundleVouches: unknown[]
  /** Final review A, I6: unlinks between the circle's members, unverified. */
  bundleUnlinks: unknown[]
}

/** The roster a joiner starts from (plan 2, Task 6): the bundle config's
 *  members whose vouches hold, and us; with the creator, the vouches to
 *  store and the config (its clock) it came from. */
interface Bootstrap {
  roster: CircleMember[]
  creator: string | null
  /** Each member's original invite vouch (final fix N1: its voucher may
   *  have gone, a hand-over keeping them). */
  vouches: Vouch[]
  /** Final fix N1: the bundle's hand-overs for the roster, held apart. */
  handOvers: Vouch[]
  config: { event: SignedEvent; updatedAt: number; by: string } | null
  /** The verified bundle re-key (it installed the invite's seed), or null. */
  rekeyEvent: SignedEvent | null
  /** Final review A, I2: the bundle re-key's removals still off the
   *  roster, as tombstones (dated by the re-key, on the seed it installed). */
  tombs: Record<string, { at: number; hash: string }>
}

type IncomingInvite = ParsedInvite & Bootstrap

function parseIncomingInvite(rumor: Rumor): ParsedInvite | null {
  let raw: unknown
  try { raw = JSON.parse(rumor.content) } catch { return null }
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const inviteEv = verifyStructural(o.invite)
  if (!inviteEv || inviteEv.action !== 'invite') return null
  const statement = verifyDeviceStatement(o.statement)
  if (!statement) return null
  // The seal signer (this wrap's own authenticated sender — see
  // `unwrapPersonalInbox`) must be the phone the attached statement names,
  // and that statement's identity must be the SAME identity that signed the
  // invite — proving a device the claimed inviter authorised sent this,
  // not merely someone who once saw a copy of the invite and the statement.
  if (rumor.pubkey !== statement.phonePk) return null
  if (statement.identityPk !== inviteEv.signerPk) return null
  const inner = parseInviteInner(inviteEv.payload)
  if (!inner || inner.id !== inviteEv.circleId) return null
  // The seed rides in the rumor, beside the signed invite (final fix A3);
  // the invite's own signed `prev` tag must be its hash (Task 10 fix round
  // 1, finding 4) — that is what binds the unsigned seed to the signature.
  const seed = o.seed
  if (typeof seed !== 'string' || !INVITE_SEED_RE.test(seed)) return null
  if (inviteEv.prev !== seedHash(seed)) return null
  const own = inner.pk === inviteEv.signerPk
  const vouch = own ? null : verifyVouch(inviteEv.event)
  if (!own && !vouch) return null
  return {
    circleId: inviteEv.circleId,
    seedHex: seed,
    name: inner.name,
    mode: inner.mode,
    ...(inner.expiresAt !== undefined ? { expiresAt: inner.expiresAt } : {}),
    from: inviteEv.signerPk,
    phonePk: rumor.pubkey,
    statement: statement.event,
    createdAt: inviteEv.event.created_at,
    pk: inner.pk,
    role: inner.role,
    ...(inner.memberName !== undefined ? { memberName: inner.memberName } : {}),
    vouch,
    config: o.config ?? null,
    links: Array.isArray(o.links) ? o.links.slice(0, MAX_BUNDLE_LINKS) : [],
    rekey: o.rekey ?? null,
    bundleVouches: Array.isArray(o.vouches) ? o.vouches.slice(0, MAX_BUNDLE_VOUCHES) : [],
    bundleUnlinks: Array.isArray(o.unlinks) ? o.unlinks.slice(0, MAX_BUNDLE_UNLINKS) : [],
  }
}

/** The adult invitee check (spec §3, plan decision 8): the inviter must be
 *  one of our usable contacts (kin, kith or a guardian link), and the grant
 *  must have produced contacts at all. */
function inviterIsContact(from: string, selfPk: string): boolean {
  const s = snapshot()
  return known(s) && usable(s, from, linkedWithMe(selfPk))
}

/** A guardian-of / dependant-of pair from a bundle, verified, or null. */
function bundlePair(raw: unknown): { g: SignedEvent; d: SignedEvent; gPk: string; dPk: string; newest: number } | null {
  if (!raw || typeof raw !== 'object') return null
  const { g, d } = raw as { g?: unknown; d?: unknown }
  const vg = verifyLinkStatement(g)
  const vd = verifyLinkStatement(d)
  if (!vg || vg.kind !== 'guardian-of' || !vd || vd.kind !== 'dependant-of') return null
  if (vg.otherPk !== vd.signerPk || vd.otherPk !== vg.signerPk) return null
  return { g: vg.event, d: vd.event, gPk: vg.signerPk, dPk: vd.signerPk, newest: Math.max(vg.createdAt, vd.createdAt) }
}

/** The bundle config, verified: a signed structural `config` for this
 *  circle, in the v2 shape, written by its signer. `undefined` when the
 *  bundle carries none; null when it carries one that fails. */
function bundleConfig(circleId: string, raw: unknown): { cfg: ConfigV2; event: SignedEvent } | null | undefined {
  if (raw === null || raw === undefined) return undefined
  const ev = verifyStructural(raw)
  if (!ev || ev.action !== 'config' || ev.circleId !== circleId) return null
  const cfg = parseConfigV2(ev.payload)
  if (!cfg || cfg.id !== circleId || cfg.by !== ev.signerPk) return null
  return { cfg, event: ev.event }
}

/** A verified bundle re-key: its removals, date, the seed hash it
 *  installed, and the event (kept by the joiner to carry on). */
interface BundleRekey { removals: string[]; createdAt: number; next: string; event: SignedEvent }

/** The bundle re-key (Task 6 pre-review ruling), verified: a signed
 *  structural `rekey` for this circle whose signer is on the bundle
 *  config's roster (the inviter, without a config) and which installed the
 *  seed this invite carries. `undefined` when the bundle carries none; null
 *  when it carries one that fails. */
function bundleRekey(inv: ParsedInvite, cfg: ConfigV2 | undefined): BundleRekey | null | undefined {
  if (inv.rekey === null || inv.rekey === undefined) return undefined
  const ev = verifyStructural(inv.rekey)
  if (!ev || ev.action !== 'rekey' || ev.circleId !== inv.circleId) return null
  const onRoster = cfg ? cfg.members.some((m) => m.pk === ev.signerPk) : ev.signerPk === inv.from
  if (!onRoster) return null
  const payload = parseRekeyPayload(ev.payload)
  if (!payload || payload.id !== inv.circleId || payload.prev !== ev.prev || payload.next !== seedHash(inv.seedHex)) return null
  return { removals: payload.removals, createdAt: ev.event.created_at, next: payload.next, event: ev.event }
}

/** A trust view over a bootstrap roster (no stored vouches or marks yet;
 *  the guardian links this device holds). */
function bootView(members: CircleMember[], name: string, creator: string | null): TrustView {
  return { members, name, creator, voucherOf: () => null, vouchFor: () => null, linked, unvouchedSince: () => null }
}

/** Builds the joiner's roster (plan 2, Task 6). From the bundle config:
 *  its creator (`createdBy`) stands without a vouch — the only member who
 *  may; every other member needs a carried vouch `vouchValid` against the
 *  roster, and members failing it are dropped, repeatedly, so a member
 *  vouched only by a dropped one goes too. The inviter must survive. We are
 *  then added from the invite's own vouch, which must be valid against that
 *  roster (unless the config already lists us, or the invite is from our
 *  own identity). Without a config the roster is the inviter as a `peer`
 *  (plan-1 least privilege) and us. Null: refuse the invite. */
function bootstrapRoster(inv: ParsedInvite, self: SessionInfo, cfgInfo: { cfg: ConfigV2; event: SignedEvent } | undefined, rekey?: BundleRekey): Bootstrap | null {
  const selfPk = self.identityPk
  const own = inv.from === selfPk
  let roster: CircleMember[]
  let vouches: Vouch[] = []
  let handOvers: Vouch[] = []
  let creator: string | null = null
  if (!cfgInfo) {
    roster = own ? [] : [{ pk: inv.from, role: 'peer' }]
  } else {
    const { cfg } = cfgInfo
    creator = cfg.createdBy || null
    // Final review A, I5: the inviter's current vouches (hand-overs after a
    // voucher left included) first, then the config's.
    const carried = [...inv.bundleVouches, ...cfg.vouches].map((ev) => verifyVouch(ev)).filter((v): v is Vouch => !!v && v.circleId === inv.circleId)
    // A member the latest re-key removed is out, unless this config
    // re-admitted them (applyConfig's rule: dated after the re-key and
    // chained on the seed it installed). We never drop ourselves: the
    // invite itself is our re-admission (`invitePasses` gates it).
    const cfgPrev = cfgInfo.event.tags.find((t) => t[0] === 'prev')?.[1]
    const readmits = !!rekey && cfgInfo.event.created_at > rekey.createdAt && cfgPrev === rekey.next
    const rekeyRemoved = new Set(rekey ? rekey.removals.filter((pk) => pk !== selfPk) : [])
    const removed = readmits ? new Set<string>() : rekeyRemoved
    if (removed.has(inv.from)) return null
    // Final review A, I1: a re-admitted member stands only on an invite
    // dated after the removal (spec §5) — the creator included.
    const vouchOk = (x: Vouch): boolean => !rekeyRemoved.has(x.pk) || (x.role !== undefined && x.createdAt > rekey!.createdAt)
    let kept: CircleMember[] = cfg.members.filter((m) => !removed.has(m.pk)).map((m) => ({ ...m }))
    let chosen = new Map<string, Vouch>()
    for (;;) {
      const view = bootView(kept, cfg.name, creator)
      chosen = new Map()
      const next = kept.filter((m) => {
        if (m.pk === creator && !rekeyRemoved.has(m.pk)) return true
        const v = carried.find((x) => x.pk === m.pk && vouchOk(x) && vouchValid(view, x, m.role))
        if (v) chosen.set(m.pk, v)
        return !!v
      })
      if (next.length === kept.length) break
      kept = next
    }
    roster = kept
    // Final fix N1: the member table holds each member's original invite,
    // even one whose voucher has gone (a hand-over kept them on); the
    // hand-overs are held apart and never stand for the original.
    vouches = [...chosen.values()].flatMap((v) => {
      if (v.role !== undefined) return [v]
      const orig = carried.find((x) => x.pk === v.pk && x.role !== undefined && vouchOk(x))
      return orig ? [orig] : []
    })
    const onKept = new Set(kept.map((m) => m.pk))
    handOvers = carried.filter((x) => x.role === undefined && onKept.has(x.pk))
    if (!own && !roster.some((m) => m.pk === inv.from)) return null
  }
  if (!roster.some((m) => m.pk === selfPk)) {
    if (!own) {
      if (!inv.vouch || !vouchValid(bootView(roster, inv.name, creator), inv.vouch, inv.role)) return null
      vouches = [...vouches, inv.vouch]
    }
    roster = [...roster, { pk: selfPk, role: inv.role, name: self.name }]
  }
  const onRoster = new Set(roster.map((m) => m.pk))
  const tombs: Record<string, { at: number; hash: string }> = {}
  for (const pk of rekey?.removals ?? []) {
    if (pk !== selfPk && !onRoster.has(pk)) tombs[pk] = { at: rekey!.createdAt, hash: rekey!.next }
  }
  return {
    roster,
    creator,
    vouches,
    handOvers,
    config: cfgInfo ? { event: cfgInfo.event, updatedAt: cfgInfo.cfg.updatedAt, by: cfgInfo.cfg.by } : null,
    rekeyEvent: rekey?.event ?? null,
    tombs,
  }
}

/** Whether `inv` is for us on this channel, before anything is stored: an
 *  adult (personal inbox) takes a non-`child` invite from a usable contact
 *  (or from our own identity: another of our phones); a dependant (phone
 *  inbox) only a `child` invite from a guardian it is linked with. */
function inviteForUs(inv: ParsedInvite, self: SessionInfo, channel: 'personal' | 'phone'): boolean {
  if (inv.pk !== self.identityPk) return false
  const own = inv.from === self.identityPk
  if (channel === 'phone') return self.dependant && !own && inv.role === 'child'
  if (self.dependant || inv.role === 'child') return false
  return own || inviterIsContact(inv.from, self.identityPk)
}

/** Admits an invite that passed `inviteForUs`: stores the guardian links it
 *  carries (a dependant's own pair first: it must be accepted, and must
 *  link the inviter to us), then bootstraps the roster. A held creator the
 *  bundle contradicts refuses it. Null: dropped silently. */
function admitInvite(inv: ParsedInvite, self: SessionInfo, channel: 'personal' | 'phone'): IncomingInvite | null {
  const now = nowSec()
  const cfgInfo = bundleConfig(inv.circleId, inv.config)
  if (cfgInfo === null) return null
  const held = creatorOf(inv.circleId)
  if (held && cfgInfo?.cfg.createdBy && cfgInfo.cfg.createdBy !== held) return null
  const pairs = inv.links.map(bundlePair).filter((x): x is NonNullable<ReturnType<typeof bundlePair>> => !!x && x.newest <= now + beacons.LINK_MAX_SKEW_SEC)
  // Links between the circle's members (a `child` vouch needs one).
  const allowed = new Set([inv.from, self.identityPk, ...(cfgInfo?.cfg.members.map((m) => m.pk) ?? [])])
  // Final review A, I6: the unlinks between them first, so no pair from
  // before an unlink is accepted here.
  for (const u of inv.bundleUnlinks) {
    const v = verifyLinkStatement(u)
    if (v && v.kind === 'unlink' && allowed.has(v.signerPk) && allowed.has(v.otherPk) && v.createdAt <= now + beacons.LINK_MAX_SKEW_SEC) acceptUnlink(u)
  }
  if (channel === 'phone') {
    // Spec §7: a dependant accepts a join only from a linked guardian.
    const ours = pairs.find((x) => x.gPk === inv.from && x.dPk === self.identityPk)
    if (!ours || !acceptLinkPair(ours.g, ours.d) || !linked(inv.from, self.identityPk)) return null
  }
  for (const x of pairs) if (allowed.has(x.gPk) && allowed.has(x.dPk)) acceptLinkPair(x.g, x.d)
  const rekey = bundleRekey(inv, cfgInfo?.cfg)
  if (rekey === null) return null
  const boot = bootstrapRoster(inv, self, cfgInfo, rekey)
  return boot ? { ...inv, ...boot } : null
}

/** Mirrors covey-kit's own (unexported) `readDmWrap` parse step exactly,
 *  including its `MAX_DM_LEN` cap — dist/inbox.js. Content-only: `from` isn't
 *  known here — the phone-inbox path (Signet identity plan Task 9) first
 *  reads `c` out of this content to know which circle's phone-key table
 *  resolves the identity behind the SEALING PHONE. DMs no longer ride the
 *  personal inbox at all (Task 9 moved them to each phone's own inbox) —
 *  this is `onPhoneInboxWrap`'s helper only. */
const MAX_DM_LEN = 500
function parseDmContent(content: string): { circleId: string; text: string } | null {
  try {
    const o = JSON.parse(content) as Record<string, unknown>
    if (o.t !== 'dm' || typeof o.c !== 'string' || typeof o.text !== 'string') return null
    const text = o.text.trim().slice(0, MAX_DM_LEN)
    if (!text) return null
    return { circleId: o.c, text }
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// UI state — module-level, deliberately NOT persisted (same idiom as
// contacts.ts's pairingSession): a fresh load always starts at the circle
// list rather than resuming mid create/invite flow.
// ---------------------------------------------------------------------------

type View =
  | { kind: 'list'; notice?: string }
  | { kind: 'new-name'; error?: string; notice?: string }
  | { kind: 'invite'; circleId: string; npubError?: string; notice?: string }

let uiView: View = { kind: 'list' }

/** Final fix B7 (part A5 UI): the last "Re-send invite" tap's own refusal
 *  reason, per member row (`${circleId}:${pk}`) — same ephemeral, per-visit
 *  module state as `uiView`'s own `notice` fields. A queued (null) result
 *  clears any stale notice for that row. */
const resendStatus = new Map<string, string>()

/** A mis-tap during testing removed a member on a single tap — this arms an
 *  inline confirm block on that member's row, same "armed inline block, own
 *  Cancel button" shape as devices.ts's `signOutView`/`deviceRowView`
 *  remove-confirm (that module's own doc comment: no confirm DIALOG idiom
 *  exists anywhere in the codebase besides this one). Only one row's
 *  confirm is ever armed at a time — same single-value idiom as devices.ts's
 *  own `confirmingPhone` — tapping a different member's "Remove" simply
 *  re-arms it there instead; navigating away leaves it armed but inert
 *  (nothing removes without the explicit "Remove" tap on the confirm row
 *  itself). */
let confirmingRemoval: { circleId: string; pk: string } | null = null

/** An invite awaiting accept/decline — set by the personal-inbox
 *  subscription below. Interrupts whatever the Circles tab was otherwise
 *  showing (matches app.ts's onboarding `start-done` special case). */
let pendingInvite: IncomingInvite | null = null

let inboxUnsubscribe: (() => void) | null = null
let inboxSubKey: string | null = null

/** Handler for an incoming person-to-person DM arriving on THIS device's own
 *  phone inbox (Signet identity plan, Task 9 moved DMs off the personal
 *  inbox onto each phone's own inbox — see `onPhoneInboxWrap` below) —
 *  messages.ts registers its own (idempotent, plain assignment — "last
 *  registration wins", same idiom as beacons.ts's
 *  `setActiveAgreementProvider`). Registration, not import: messages.ts
 *  already imports this module (for `appRelays`/`selfRole`), so the reverse
 *  import would be circular in the wrong direction for this one call —
 *  matches beacons.ts's own reasoning for why `activeAgreementFor` is a
 *  registered provider rather than a direct import of agreements.ts. */
export type PersonalDmHandler = (dm: DirectMessage & { from: string }) => void
let personalDmHandler: PersonalDmHandler | null = null

/** Registers messages.ts's phone-inbox DM handler — see
 *  `PersonalDmHandler`'s doc comment. Pass `null` to unregister (test
 *  cleanup only). */
export function setPersonalDmHandler(fn: PersonalDmHandler | null): void {
  personalDmHandler = fn
}

/** Plan 2, Task 7: the phone-inbox rumor a dependant's phone sends to its
 *  guardian's phone during in-person pairing. */
export const LINK_PAIR_SIGNAL_TYPE = 'link-pair'

/** Handler for a `t:'link-pair'` rumor on this phone's inbox —
 *  link-pairing.ts registers `onLinkPair` (registration, not import: it
 *  imports this module). `sealPk` is the rumor's authenticated sender (the
 *  sealing phone key). Pass `null` to unregister (test cleanup only). */
export type LinkPairHandler = (rumor: Rumor, sealPk: string) => Promise<unknown>
let linkPairHandler: LinkPairHandler | null = null
export function setLinkPairHandler(fn: LinkPairHandler | null): void {
  linkPairHandler = fn
}

// ---------------------------------------------------------------------------
// Personal-inbox subscription — receive
// ---------------------------------------------------------------------------

/** Registers this module's redo-on-approval handlers with approvals.ts —
 *  `create-circle` re-runs `createCircleNow` with the stashed `name`;
 *  `add-member` re-runs `doInvite` for the original attempt's recipient,
 *  entirely bypassing `checkPolicy` a second time (the request has already
 *  been granted — re-checking would just raise ANOTHER prompt against an
 *  unchanged policy). Idempotent (approvals.ts's `registerApprovalAction`
 *  is a plain `Map.set`) — safe to call on every `ensure()`. */
let approvalActionsRegistered = false
function registerApprovalActions(): void {
  if (approvalActionsRegistered) return
  approvalActionsRegistered = true
  approvals.registerApprovalAction('create-circle', (params) => { createCircleNow(params.name ?? '') })
  approvals.registerApprovalAction('add-member', reRunAddMember)
}

/** Ensures the personal-inbox gift-wrap subscription is live — adults only
 *  (Signet identity plan, Task 10: `!session.dependant`; a dependant session
 *  never receives invites on the personal inbox at all). Idempotent — safe
 *  to call on every render regardless of active tab, since an invite can
 *  arrive while the user is on any screen. Unlike contacts.ts's `ensure()`,
 *  nothing here ever calls `store.update()` synchronously, so there's no
 *  render-pass to bail. */
export function ensure(p: store.Persisted): void {
  registerApprovalActions()
  registerStructuralSenders()
  beacons.setSignalHandler(handleIncomingSignal) // idempotent — see setSignalHandler's own doc comment
  ensurePhoneInbox(p)
  syncInboxScope()
  const self = currentSession()
  if (!self || self.dependant) {
    inboxUnsubscribe?.()
    inboxUnsubscribe = null
    inboxSubKey = null
    return
  }
  const relays = appRelays(p)
  // gen: prefix (pool-health.ts): a pool-staleness recovery bump changes
  // this key even though the identity/relays didn't, forcing a clean
  // unsubscribe/resubscribe on the fresh pool — see beacons.ts's
  // `ensureReceive`, which does the same, and pool-health.ts's `buildSubKey`
  // doc comment for why a pool reset alone isn't enough on its own.
  const key = poolHealth.buildSubKey(poolHealth.generation(), `${self.identityPk}@${relays.join(',')}`)
  if (key === inboxSubKey && inboxUnsubscribe) return
  inboxUnsubscribe?.()
  inboxSubKey = key
  const signer = personalInboxSigner()
  const inboxTag = personalInboxTag(self.identityPk)
  newPass() // the new subscription replays the backlog: a fresh decrypt budget
  const unsub = subscribeGiftWraps(relays, inboxTag, (e) => { void onPersonalInboxWrap(signer, e) })
  const release = poolHealth.expectInbox(inboxTag) // a resume checks it is really open (pool-health.ts's recoverOnResume)
  inboxUnsubscribe = () => { release(); unsub() }
}

let phoneInboxUnsubscribe: (() => void) | null = null
let phoneInboxSubKey: string | null = null

/** Keeps this phone's own inbox (`personalInboxTag(phonePk)`) subscribed
 *  while signed in — re-keys arrive there (and DMs, from Task 9). */
function ensurePhoneInbox(p: store.Persisted): void {
  const self = currentSession()
  if (!self) {
    phoneInboxUnsubscribe?.()
    phoneInboxUnsubscribe = null
    phoneInboxSubKey = null
    return
  }
  const relays = appRelays(p)
  const tag = personalInboxTag(self.phonePk)
  const key = poolHealth.buildSubKey(poolHealth.generation(), `${tag}@${relays.join(',')}`)
  if (key === phoneInboxSubKey && phoneInboxUnsubscribe) return
  phoneInboxUnsubscribe?.()
  phoneInboxSubKey = key
  const unsub = subscribeGiftWraps(relays, tag, (e) => { void onPhoneInboxWrap(e) })
  const release = poolHealth.expectInbox(tag)
  phoneInboxUnsubscribe = () => { release(); unsub() }
}

/** Persistent, wrap-id dedup (Signet identity plan, Task 10 — `seenPersonalWraps`,
 *  capped at 5000, oldest dropped, same idiom as beacons.ts's `seenStructural`).
 *  Checked BEFORE any decrypt, so a wrap this device has already handled
 *  (including across a restart — this is store-persisted, not in-memory)
 *  never pays the two remote `identitySigner()` round trips unwrapping it
 *  costs. */
function alreadySeenPersonalWrap(id: string): boolean {
  return pendingDrops.has(id) || store.load().seenPersonalWraps.includes(id)
}
function markPersonalWrapSeen(id: string): void {
  store.update((p) => {
    if (p.seenPersonalWraps.includes(id)) return
    p.seenPersonalWraps = [...p.seenPersonalWraps, id].slice(-5000)
  })
}

/** In-flight wrap ids currently being unwrapped (Task 10 fix round 1,
 *  finding 6): `seenPersonalWraps` alone only closes the dedup race AFTER a
 *  decrypt completes — two deliveries of the SAME wrap arriving close
 *  enough together (a relay re-delivery racing the first handling) would
 *  otherwise both pass the persisted-seen check and both pay the two remote
 *  `identitySigner()` decrypts. Checked/added synchronously before the
 *  first await below, so the second of two concurrent calls always sees
 *  it — in-memory only, no need to survive a restart (a genuine restart
 *  can't have anything in flight). */
const inFlightPersonalWraps = new Set<string>()

/** The signer every personal-inbox unwrap goes through: the identity
 *  signer, asked in the BACKGROUND only (`interactive: false` —
 *  remote-signer.ts's `SignerCallOpts`). A wrap arrives because a relay
 *  delivered it — anyone can put one in this inbox, and every resubscribe
 *  replays the backlog — so no unwrap may ever bring My Signet to the
 *  front: over NIP-55 it is the content provider only, never the
 *  `nostrsigner:` intent. A signer that can't answer silently (locked, not
 *  approved yet, asleep) defers the wrap instead (`handlePersonalWrap`). */
export function personalInboxSigner(): Signer {
  return identitySigner({ interactive: false })
}

/** A wrap the signer definitely refused this many times is dropped (marked
 *  seen): a junk wrap costs at most this many silent attempts. */
export const MAX_WRAP_REFUSALS = 3
/** Refusal records kept (oldest dropped). Review follow-up to 60c8176: at
 *  500, and with no since/limit on the REQ, more than 500 junk wraps meant
 *  every replay pushed the earliest out before they reached
 *  MAX_WRAP_REFUSALS — none was ever dropped. Records are compact
 *  (`<first 16 hex of the wrap id>:<n>`, ~20 bytes) so this many is cheap. */
export const MAX_REFUSAL_RECORDS = 5000
/** Silent identity-signer unwraps per pass. A pass is a resubscribe (its
 *  backlog replay), an availability tick (`retryDeferredPersonalWraps`), or
 *  at most `PASS_WINDOW_MS` of live deliveries. Wraps beyond the cap are
 *  deferred to the next tick, oldest first. */
export const DECRYPTS_PER_PASS = 50
const PASS_WINDOW_MS = 30_000
/** Bound on the in-memory deferred set. When full, a new wrap is not added
 *  (it was never marked seen, so a later resubscribe replays it) — the
 *  oldest, next in line, are kept. */
const MAX_DEFERRED_WRAPS = 1000

type InboxWrap = { id: string; pubkey: string; content: string; tags: string[][] }

/** Wraps not unwrapped yet — the signer couldn't answer silently, or the
 *  pass's decrypt budget was spent — retried oldest first by
 *  `retryDeferredPersonalWraps` when it next can (app resume, any signer
 *  call that got an answer). In memory only: a restart resubscribes and
 *  the relay replays them, as they were never marked seen. */
const deferredPersonalWraps = new Map<string, InboxWrap>()
let retryHookInstalled = false

/** Tells the UI when the deferred set turns empty or non-empty — the
 *  "waiting" notice (`inboxWaitingView`) lives on in-memory state only. */
function noteDeferredChange(wasEmpty: boolean): void {
  if (wasEmpty !== (deferredPersonalWraps.size === 0)) store.notify()
}

function undeferPersonalWrap(id: string): void {
  if (!deferredPersonalWraps.has(id)) return
  deferredPersonalWraps.delete(id)
  noteDeferredChange(false)
}

function deferPersonalWrap(e: InboxWrap): void {
  if (!deferredPersonalWraps.has(e.id)) {
    if (deferredPersonalWraps.size >= MAX_DEFERRED_WRAPS) return
    const wasEmpty = deferredPersonalWraps.size === 0
    deferredPersonalWraps.set(e.id, { id: e.id, pubkey: e.pubkey, content: e.content, tags: e.tags })
    noteDeferredChange(wasEmpty)
  }
  if (!retryHookInstalled) {
    retryHookInstalled = true
    onSignerAnswered(() => { void retryDeferredPersonalWraps() })
  }
}

let passBudget = DECRYPTS_PER_PASS
let passStartedAt = 0

/** Starts a fresh decrypt budget (a resubscribe, an availability tick). */
function newPass(): void {
  passBudget = DECRYPTS_PER_PASS
  passStartedAt = Date.now()
}

/** Takes one silent unwrap from the pass budget; false when it is spent. */
function takeBudget(): boolean {
  if (Date.now() - passStartedAt >= PASS_WINDOW_MS) newPass()
  if (passBudget <= 0) return false
  passBudget -= 1
  return true
}

const refusalKey = (id: string): string => id.slice(0, 16)

/** Refusal counts not yet written (key → count; 0 clears it) and wraps
 *  dropped but not yet marked seen — written in one `store.update` per
 *  pass (`flushWrapBookkeeping`), not one full-store write per wrap. */
const pendingRefusals = new Map<string, number>()
const pendingDrops = new Set<string>()

function refusalCount(id: string): number {
  const k = refusalKey(id)
  const pending = pendingRefusals.get(k)
  if (pending !== undefined) return pending
  const hit = store.load().personalWrapRefusals.find((r) => r.startsWith(`${k}:`))
  return hit ? Number(hit.slice(k.length + 1)) || 0 : 0
}

/** Counts one definite refusal of wrap `id`; true once it has reached
 *  `MAX_WRAP_REFUSALS` (the count is then cleared and the wrap dropped —
 *  marked seen at the next flush). */
function noteWrapRefusal(id: string): boolean {
  const n = refusalCount(id) + 1
  if (n >= MAX_WRAP_REFUSALS) {
    pendingRefusals.set(refusalKey(id), 0)
    pendingDrops.add(id)
    return true
  }
  pendingRefusals.set(refusalKey(id), n)
  return false
}

function clearWrapRefusals(id: string): void {
  if (refusalCount(id) > 0) pendingRefusals.set(refusalKey(id), 0)
}

/** Writes the pass's refusal counts and drops in one store update. */
function flushWrapBookkeeping(): void {
  if (pendingRefusals.size === 0 && pendingDrops.size === 0) return
  const refusals = [...pendingRefusals]
  const drops = [...pendingDrops]
  pendingRefusals.clear()
  pendingDrops.clear()
  store.update((p) => {
    const counts = new Map<string, number>()
    for (const r of p.personalWrapRefusals) {
      const i = r.lastIndexOf(':')
      counts.set(r.slice(0, i), Number(r.slice(i + 1)) || 0)
    }
    for (const [k, n] of refusals) {
      counts.delete(k)
      if (n > 0) counts.set(k, n)
    }
    p.personalWrapRefusals = [...counts].slice(-MAX_REFUSAL_RECORDS).map(([k, n]) => `${k}:${n}`)
    if (drops.length) {
      const seen = new Set(p.seenPersonalWraps)
      p.seenPersonalWraps = [...p.seenPersonalWraps, ...drops.filter((d) => !seen.has(d))].slice(-5000)
    }
  })
}

/** The identity the in-memory inbox state belongs to (undefined: not yet
 *  observed). */
let inboxScope: string | null | undefined

/** Forgets the deferred wraps, unwritten bookkeeping and the pass budget
 *  when the identity signs out or changes — they belong to the old inbox.
 *  On a change of identity the persisted refusal counts go too (sign-out
 *  already clears the whole store). */
function syncInboxScope(): void {
  const pk = currentSession()?.identityPk ?? null
  if (pk === inboxScope) return
  const prev = inboxScope
  inboxScope = pk
  if (prev === undefined) return
  deferredPersonalWraps.clear()
  checkNow = 'idle'
  pendingRefusals.clear()
  pendingDrops.clear()
  newPass()
  rerunRequested = false
  if (prev !== null && pk !== null && store.load().personalWrapRefusals.length > 0) {
    // Not synchronously: ensure() runs inside render and must not write.
    queueMicrotask(() => { store.update((p) => { p.personalWrapRefusals = [] }) })
  }
}

/** Test seam: the ids currently deferred. */
export function deferredPersonalWrapIdsForTests(): string[] {
  return [...deferredPersonalWraps.keys()]
}

/** Test seam: forgets every deferred wrap. */
export function resetDeferredPersonalWrapsForTests(): void {
  lastPassStartedAt = Number.NEGATIVE_INFINITY
  deferredPersonalWraps.clear()
  pendingRefusals.clear()
  pendingDrops.clear()
  newPass()
}

/** Final review, item 4: the least time between the starts of two
 *  deferred-retry passes. Every answered decrypt asks for another pass, each
 *  with a fresh `DECRYPTS_PER_PASS` budget, so without this the passes ran
 *  back to back and the per-pass cap did not bound the rate. A request
 *  inside the window runs once, at the window's end. */
export const MIN_PASS_GAP_MS = 5_000
let minPassGapMs = MIN_PASS_GAP_MS
let lastPassStartedAt = Number.NEGATIVE_INFINITY

/** Test seam: the pass spacing (`MIN_PASS_GAP_MS` unless set). */
export function setMinPassGapForTests(ms: number): void {
  minPassGapMs = ms
}

let retryRun: Promise<void> | null = null
let rerunRequested = false
/** True while a retry pass runs: its handles don't flush one by one. */
let passRunning = 0

/** Retries the deferred personal-inbox wraps, oldest first, with the
 *  background signer — at most `DECRYPTS_PER_PASS` per pass. Stops at the
 *  first wrap that defers again (the signer still can't answer — no point
 *  asking it about the rest now). Called on app resume and whenever a
 *  signer call gets an answer. A call while a pass is running is not
 *  dropped: it asks for one more pass once the current one finishes (an
 *  answer landing mid-pass may have made wraps deferred since then
 *  answerable). Pass starts are at least `MIN_PASS_GAP_MS` apart: a call
 *  inside that window waits for its end (coalesced with any others). */
export function retryDeferredPersonalWraps(): Promise<void> {
  if (retryRun) {
    rerunRequested = true
    return retryRun
  }
  if (deferredPersonalWraps.size === 0) return Promise.resolve()
  retryRun = (async () => {
    try {
      do {
        const wait = lastPassStartedAt + minPassGapMs - Date.now()
        if (wait > 0) await new Promise<void>((r) => setTimeout(r, wait))
        // Requests made up to here are covered by the pass about to start.
        rerunRequested = false
        lastPassStartedAt = Date.now()
        await retryPass()
      } while (rerunRequested)
    } finally {
      retryRun = null
    }
  })()
  return retryRun
}

async function retryPass(): Promise<void> {
  syncInboxScope()
  if (deferredPersonalWraps.size === 0) return
  const self = currentSession()
  if (!self || self.dependant) return
  newPass()
  passRunning++
  try {
    const signer = personalInboxSigner()
    for (const w of [...deferredPersonalWraps.values()]) {
      if (!deferredPersonalWraps.has(w.id)) continue
      if (!takeBudget()) break
      await handlePersonalWrap(signer, w)
      if (deferredPersonalWraps.has(w.id)) break
    }
  } finally {
    passRunning--
    flushWrapBookkeeping()
  }
}

/** Wraps one "Check now" tap may ask My Signet about, oldest first. */
export const CHECK_NOW_CAP = 10
/** The interactive signer's deadline: long enough for the person to unlock
 *  My Signet and enter their PIN. */
const CHECK_NOW_TIMEOUT_MS = 300_000
let checkNow: 'idle' | 'running' = 'idle'
let checkRun: Promise<void> | null = null

/** "Check now" — the ONLY interactive personal-inbox unwrap, and only ever
 *  from the person's own tap on the waiting notice (`inboxWaitingView`).
 *  My Signet's content provider can't decrypt while My Signet is in the
 *  background, so a genuine invite can wait in the deferred set until the
 *  person brings it forward. One pass: at most `CHECK_NOW_CAP` wraps, with
 *  interactive signing allowed; it stops at the first wrap that still
 *  can't be answered (the person backed out, or it timed out) and then
 *  ends — nothing re-arms it. A refusal counts towards `MAX_WRAP_REFUSALS`
 *  exactly as in the background. Background passes stay silent-only. */
export function checkDeferredNow(): Promise<void> {
  if (checkRun) return checkRun
  checkRun = (async () => {
    checkNow = 'running'
    store.notify()
    passRunning++
    try {
      syncInboxScope()
      const self = currentSession()
      if (!self || self.dependant) return
      const signer = identitySigner({ timeoutMs: CHECK_NOW_TIMEOUT_MS })
      let asked = 0
      for (const w of [...deferredPersonalWraps.values()]) {
        if (asked >= CHECK_NOW_CAP) break
        if (!deferredPersonalWraps.has(w.id)) continue
        asked++
        await handlePersonalWrap(signer, w)
        if (deferredPersonalWraps.has(w.id)) break
      }
    } finally {
      passRunning--
      flushWrapBookkeeping()
      checkNow = 'idle'
      checkRun = null
      store.notify()
    }
  })()
  return checkRun
}

/** The calm notice shown while personal-inbox wraps wait on My Signet —
 *  empty when none do. */
export function inboxWaitingView(): string {
  const self = currentSession()
  if (!self || self.dependant || deferredPersonalWraps.size === 0) return ''
  const busy = checkNow === 'running'
  return `<section class="contact-group banner" id="inbox-waiting-card"><p>An invite or message is waiting. Open My Signet to read it.</p><button type="button" data-action="circle-check-inbox"${busy ? ' disabled' : ''}>${busy ? 'Checking…' : 'Check now'}</button></section>`
}

/** The personal-inbox subscription's receive-side dispatcher — exported (same
 *  "directly unit-testable against a real wrap round trip" idiom as
 *  beacons.ts's `decodeBeaconRumor`) so the seal-forgery rejection this
 *  module's "Personal-inbox unwrap" section fixes can be exercised
 *  end-to-end, not just at the unit level of its pieces. `signer` is always
 *  the personal-inbox owner's own background identity signer
 *  (`personalInboxSigner`; adults only — see `ensure()`), so
 *  `unwrapPersonalInbox` above is the correct (asymmetric, real-identity-key)
 *  unwrap here. */
export async function onPersonalInboxWrap(signer: Signer, e: InboxWrap): Promise<void> {
  poolHealth.notePoolActivity() // the relay just delivered something → the shared pool is alive (even a dup/undecryptable wrap counts — see pool-health.ts)
  syncInboxScope()
  if (alreadySeenPersonalWrap(e.id)) { undeferPersonalWrap(e.id); return }
  if (inFlightPersonalWraps.has(e.id)) return
  // The pass's silent-unwrap budget is spent (a large backlog replay):
  // wait for the next availability tick instead of decrypting now.
  if (!takeBudget()) { deferPersonalWrap(e); return }
  await handlePersonalWrap(signer, e)
}

/** The wrap `id` is checked against `seenPersonalWraps` before anything else
 *  — including before the (possibly two, remote) decrypt calls
 *  `unwrapPersonalInbox` makes — and marked seen after handling, whatever
 *  the outcome, except:
 *   - the signer couldn't answer (`SignerUnavailable`: asleep, timed out,
 *     locked or not approved for a silent answer): not the wrap's fault.
 *     Left unmarked and DEFERRED — retried when the signer next answers
 *     (`retryDeferredPersonalWraps`), so a genuine invite that arrived while
 *     My Signet was locked is still delivered.
 *   - the signer refused (`SignerRejected`): left unmarked, but the refusal
 *     is counted per wrap (`personalWrapRefusals`, persisted); the
 *     `MAX_WRAP_REFUSALS`th drops it (marked seen, logged once). My Signet
 *     refuses for any backend error, so a junk wrap from a stranger —
 *     replayed on every resubscribe — costs at most that many silent
 *     attempts rather than one on every replay forever. */
async function handlePersonalWrap(signer: Signer, e: InboxWrap): Promise<void> {
  if (alreadySeenPersonalWrap(e.id)) { undeferPersonalWrap(e.id); return }
  if (inFlightPersonalWraps.has(e.id)) return
  inFlightPersonalWraps.add(e.id)
  const scope = inboxScope
  try {
    const { rumor, failure } = await unwrapPersonalInbox(signer, e)
    if (inboxScope !== scope) return // signed out / another identity meanwhile
    if (failure === 'unavailable') {
      deferPersonalWrap(e)
      return
    }
    undeferPersonalWrap(e.id)
    if (failure === 'rejected') {
      if (!noteWrapRefusal(e.id)) return // retried on a later delivery, up to MAX_WRAP_REFUSALS
      console.warn(`personal inbox: the signer refused wrap ${e.id} ${MAX_WRAP_REFUSALS} times; dropped`)
      return // marked seen with the pass's batched write (flushWrapBookkeeping)
    }
    clearWrapRefusals(e.id)
    markPersonalWrapSeen(e.id)
    if (!rumor) return // undecryptable, not ours, or a forged/tampered seal — see unwrapPersonalInbox
    const invite = parseIncomingInvite(rumor)
    if (invite) handleIncomingInvite(invite, 'personal')
    // Anything else (config, DMs, reseed) no longer rides the personal inbox
    // at all (Task 8/9/10) — silently ignored here.
  } finally {
    inFlightPersonalWraps.delete(e.id)
    // One store write per burst of deliveries (or per retry pass, flushed
    // at its end) rather than per wrap.
    if (passRunning === 0 && inFlightPersonalWraps.size === 0) flushWrapBookkeeping()
  }
}

/** Whether `invite` should be surfaced/accepted against `existing`, our
 *  current local circle for its id (undefined if we hold none). Shared by
 *  `handleIncomingInvite` (on receive) and `acceptPendingInvite`, which
 *  re-runs it at accept time (Task 10 fix round 2 finding 3: local state can
 *  change in the gap between an invite arriving and the user tapping
 *  Accept — e.g. a config for this SAME circle, from a device that never
 *  lost contact, lands in between).
 *
 *  Controller ruling, Task 10 fix round 2 finding 4: an invite whose seed
 *  hash we already know (it's in our own local chain for this circle)
 *  carries nothing new — ignored. An invite for a seed hash we've never
 *  held means we were cut off from a later epoch (a genuine re-invite),
 *  subject only to the date gate (this invite's created_at after any
 *  recorded removal of OUR OWN pk) when we happen to hold one. This does
 *  NOT gate on current self-membership: a device excluded from a removing
 *  re-key's `to` never learns it was removed at all (Task 8's own re-key
 *  reach design), so it keeps listing itself as a current member of a
 *  circle stuck on its pre-removal seed forever — self-membership alone
 *  can't tell a live member from a cut-off one, but the seed-hash chain
 *  can.
 *
 *  Controller ruling, Task 10 fix round 3 finding 1(a): an "unknown seed"
 *  alone isn't enough either — a replayed invite from before our CURRENT
 *  epoch even started must not be mistaken for a genuine cut-off re-invite
 *  just because our chain doesn't happen to reach back that far (e.g. a
 *  device that's been a single continuous member since `epochStartedAt`
 *  has no earlier history to know). Such an invite is dated at or before
 *  `existing.epochStartedAt` and is dropped even though its seed is
 *  "unknown" — a live circle must never be downgraded by a stale replay.
 *  `epochStartedAt` missing (data from before this field existed) defaults
 *  to 0 (never blocks) rather than wrongly refusing every re-invite for
 *  pre-existing circles. */
function invitePasses(invite: ParsedInvite, self: SessionInfo, existing: store.StoredCircle | undefined): boolean {
  if (!existing) return true
  if (knownSeedHashes(existing).includes(seedHash(invite.seedHex))) return false // a seed epoch we already hold: nothing new
  if (invite.createdAt <= (existing.epochStartedAt ?? 0)) return false // predates our current epoch: a stale replay, not a re-invite
  const tomb = existing.removals?.[self.identityPk]
  if (tomb && invite.createdAt <= tomb.at) return false
  return true
}

/** Plan 2 (Task 6): an invite that isn't for us on this `channel` (see
 *  `inviteForUs`) is dropped silently — no pending invite, no notice. The
 *  plan-1 re-admission gate (`invitePasses`) runs before anything the
 *  bundle carries is stored. */
function handleIncomingInvite(parsed: ParsedInvite, channel: 'personal' | 'phone'): void {
  const p = store.load()
  const self = currentSession()
  if (!self) return
  if (!inviteForUs(parsed, self, channel)) return
  const existing = p.circles.find((c) => c.id === parsed.circleId)
  if (!invitePasses(parsed, self, existing)) return
  const invite = admitInvite(parsed, self, channel)
  if (!invite) return
  pendingInvite = invite
  store.notify()
}

// ---------------------------------------------------------------------------
// Structural config and re-key (Signet identity plan, Task 8). Both are
// identity-signed inner events (structural.ts) queued for the identity
// signer (structural-queue.ts). A config travels on the circle inbox and
// reaches `applyConfig` through beacons.ts's choke point, which has already
// checked the envelope and the authority (authority.ts). A re-key carries a
// fresh seed, so it travels only to the phone keys of the members who stay
// (`sendRekeyEvent`), and is received on each phone's own inbox
// (`onPhoneInboxWrap`). Spec 3 §5 mechanics, plan-1 authority (guardians).
// ---------------------------------------------------------------------------

/** How long a device collects competing re-keys on the same `prev` after
 *  the first arrives, before applying the winner (`pickRekeyWinner`). */
export const REKEY_WINDOW_MS = 10_000

/** Re-key payload (the identity-signed content). `next` is the hash of
 *  the new seed — final fix A3: the seed itself is never signed (it would
 *  go to the identity signer and its logs); it travels beside the signed
 *  event in the phone-sealed rumor (`{ struct, seed }`), and a receiver
 *  requires `seedHash(seed) === next`. `to` is the sorted set of phone keys
 *  the sender wrapped the new seed to (its own phone included): receivers
 *  forward it to any phone of a remaining member it misses, and it's the
 *  circle's `seedRecipients` once applied. */
interface RekeyPayload { id: string; next: string; prev: string; removals: string[]; to: string[] }

function isHexList(x: unknown): x is string[] {
  return Array.isArray(x) && x.every((v) => typeof v === 'string' && INVITE_SEED_RE.test(v))
}

function parseRekeyPayload(json: string): RekeyPayload | null {
  let o: unknown
  try { o = JSON.parse(json) } catch { return null }
  if (!o || typeof o !== 'object') return null
  const r = o as Record<string, unknown>
  if (typeof r.id !== 'string' || typeof r.next !== 'string' || !INVITE_SEED_RE.test(r.next)) return null
  if (typeof r.prev !== 'string' || !INVITE_SEED_RE.test(r.prev) || !isHexList(r.removals) || !isHexList(r.to)) return null
  return { id: r.id, next: r.next, prev: r.prev, removals: [...new Set(r.removals)].sort(), to: [...new Set(r.to)].sort() }
}

/** A verified re-key and the seed it commits to (`seedHash(seed) ===
 *  payload.next`, checked before one is ever built). */
interface RekeyCandidate { ev: StructuralEvent; payload: RekeyPayload; seed: string }
interface RekeyWindow { prev: string; candidates: Map<string, RekeyCandidate>; timer: ReturnType<typeof setTimeout> }

const rekeyWindows = new Map<string, RekeyWindow>()
/** Inner ids of the re-keys THIS device sent, per circle, newest last: a
 *  losing one is re-enqueued on top of the winner. */
const ownRekeyIds = new Map<string, string[]>()

/** Re-key rumors from the phone inbox that can't be judged yet (their
 *  sealing phone isn't bound, or they build on a re-key not yet seen),
 *  per circle, oldest first, capped. Re-run when a phone binds in the
 *  circle and after every applied re-key. In memory: after a restart the
 *  relay replay re-delivers them. */
const PARK_CAP = 100
const parkedRekeys = new Map<string, Rumor[]>()

function parkRekey(circleId: string, rumor: Rumor): void {
  const list = parkedRekeys.get(circleId) ?? []
  if (rumor.id && list.some((r) => r.id === rumor.id)) return
  list.push(rumor)
  if (list.length > PARK_CAP) list.shift()
  parkedRekeys.set(circleId, list)
}

/** Test seam: the newest re-key id this device sent into `circleId`. */
export function lastOwnRekeyIdForTests(circleId: string): string | undefined {
  return ownRekeyIds.get(circleId)?.at(-1)
}

/** Test seam: drops open collection windows and every in-memory re-key /
 *  phone-inbox memory of this module (as an app kill would). */
export function resetRekeyForTests(): void {
  for (const w of rekeyWindows.values()) clearTimeout(w.timer)
  rekeyWindows.clear()
  ownRekeyIds.clear()
  parkedRekeys.clear()
  seenPhoneRumorIds.clear()
  postedUnlinks.clear()
}

/** Every non-revoked phone key of every member of `circle` not in
 *  `removals`, sorted. */
function remainingPhones(circle: Circle, removals: string[]): string[] {
  const removed = new Set(removals)
  return [...new Set(circle.members.filter((m) => !removed.has(m.pk)).flatMap((m) => phonesOf(circle.id, m.pk)))].sort()
}

/** Whether `phonePk` is presumed to hold `circleId`'s CURRENT seed: listed
 *  in `seedRecipients`, or bound in its phone-key table to a member who is
 *  still on the roster. */
export function phoneHoldsSeed(p: store.Persisted, circleId: string, phonePk: string): boolean {
  if (p.seedRecipients[circleId]?.includes(phonePk)) return true
  // Any phone bound to a member who stays may hold it: another device can
  // have forwarded it there without this one knowing (a device unaware of
  // a revocation forwards to every bound phone it knows).
  const binding = p.phoneKeys[circleId]?.[phonePk]
  const c = p.circles.find((x) => x.id === circleId)
  return !!binding && !!c?.members.some((m) => m.pk === binding.memberPk)
}

/** Records that `phonePk` holds `circleId`'s current seed (it posted on the
 *  current inbox), once the circle tracks recipients at all. */
export function notePhoneHoldsSeed(circleId: string, phonePk: string): void {
  store.update((p) => {
    const recipients = p.seedRecipients[circleId]
    if (!recipients || recipients.includes(phonePk)) return
    p.seedRecipients = { ...p.seedRecipients, [circleId]: [...recipients, phonePk].sort() }
  })
}

/** Queues a re-key of `circle` (spec 3 §5): a fresh random seed, the hash of
 *  the current one, the cumulative, sorted removal set (the circle's
 *  tombstones plus `removals`) and `to`, the phones it will be wrapped to.
 *  An empty `removals` re-keys without adding anyone to the set — the
 *  "without that phone" re-key after a revocation. Non-empty removals are
 *  also recorded in `pendingRemovals` until an applied re-key carries
 *  them, so an app kill can't lose them (`resumePendingRemovals`).
 *
 *  Task 12 fix round 1, item 1 (security): `self.phonePk` is added to `to`
 *  ONLY when it isn't itself revoked. `remainingPhones` already excludes a
 *  revoked phone via `phonesOf`'s own filter — this device's OWN phone was
 *  the one unconditional exception, so a re-key sent right as (or just
 *  after) THIS device's own phone gets revoked could otherwise still list a
 *  now-untrusted key as a recipient of the fresh seed. In the ordinary case
 *  this never triggers — beacons.ts's `applyRevocation` skips enqueuing a
 *  re-key at all for a revocation of this device's own phone (it signs out
 *  instead) — this is the defence for every OTHER path that calls
 *  `sendRekey` too. */
export async function sendRekey(circle: Circle, removals: string[]): Promise<void> {
  const p = store.load()
  const c = p.circles.find((x) => x.id === circle.id) ?? circle
  // Final review A, I2: removal sets are cumulative — our tombstones, and
  // those of the re-keys we hold (applied or from our bundle), except
  // anyone since re-admitted to the roster.
  const onRoster = new Set(c.members.map((m) => m.pk))
  const heldRemovals = [p.lastRekey[c.id]?.removals ?? [], ...[Object.hasOwn(p.heldRekeys, c.id) ? p.heldRekeys[c.id] : undefined].map((raw) => {
    const ev = verifyStructural(raw)
    return ev && ev.action === 'rekey' && ev.circleId === c.id ? parseRekeyPayload(ev.payload)?.removals ?? [] : []
  })].flat().filter((pk) => !onRoster.has(pk))
  const cumulative = [...new Set([...((c as store.StoredCircle).removedPks ?? []), ...heldRemovals, ...removals])].sort()
  const self = currentSession()
  const selfPhone = self && !p.revokedPhoneKeys[self.phonePk] ? self.phonePk : null
  const to = [...new Set([...remainingPhones(c, cumulative), ...(selfPhone ? [selfPhone] : [])])].sort()
  // Task 12 fix round 2, finding 2 (minor): our own phone is revoked AND no
  // other phone of ours survives in `to` either — this device's identity
  // has nothing left to receive the fresh seed through here. Sending would
  // hand the new seed only to phones that aren't ours, from a device with
  // no further standing in this circle; doSignOut (beacons.ts
  // `applyRevocation`'s normal path, when it was OUR OWN revocation) takes
  // it from here instead, and another surviving guardian device re-keys.
  if (self && !selfPhone && !to.some((pk) => phonesOf(c.id, self.identityPk).includes(pk))) return
  const seed = randomHex(32)
  const payload: RekeyPayload = { id: c.id, next: seedHash(seed), prev: seedHash(c.seedHex), removals: cumulative, to }
  if (removals.length) {
    const requestedAt = nowSec()
    store.update((p) => {
      p.pendingRemovals = { ...p.pendingRemovals, [c.id]: [...new Set([...(p.pendingRemovals[c.id] ?? []), ...removals])].sort() }
      // Stale-removal fix: stamps each NEWLY pending pk with when it was
      // asked for — first time only (`??=`), so a pk already pending keeps
      // its original request time across a repeat sendRekey. Compared, on
      // resend, against vouches.ts's `vouchFor` to tell a removal that's
      // genuinely still owed from one whose target has since been vouched
      // back onto the roster (see `dropReAddedSince`).
      const at = { ...(p.pendingRemovalsAt[c.id] ?? {}) }
      for (const pk of removals) at[pk] ??= requestedAt
      p.pendingRemovalsAt = { ...p.pendingRemovalsAt, [c.id]: at }
    })
  }
  enqueue({ action: 'rekey', circleId: c.id, payload: JSON.stringify(payload), label: `Renew the key for ${c.name}`, seed })
}

/** Drops from `removals` any pk who's been vouched back onto `circleId`'s
 *  roster (vouches.ts's `vouchFor` — an `invite`'s own vouch, "newest wins"
 *  per (circle, pk), so a fresh invite of an existing member's identity
 *  updates it) SINCE `sinceAt(pk)` — the removal's own request time, AND
 *  whose vouch was signed by someone who could actually have removed the
 *  target themselves (`mayRemove`, the same authority `sendRekey`'s own
 *  callers rely on) — not merely by anyone `mayVouch` lets add a peer (a
 *  dependant included). Without that check, a colluding member with no
 *  standing to remove the target could sign a fresh invite for them and
 *  make a genuinely-still-owed removal look like an "invited back" and
 *  drop it for good (security fix).
 *
 *  `mayRemove` is asked with `pk`'s voucher-of-record blinded to null for
 *  this one check: `vouch` — the fresh invite itself — is by construction
 *  `vouchFor(circleId, pk)`, so the live trust view's own `voucherOf(pk)`
 *  is always exactly `vouch.by` (nothing else could be held for a `pk`
 *  reaching here — a second invite is refused while one is already held).
 *  Asking `mayRemove` with the live view unblinded would let its "the
 *  member's original voucher may remove them" branch rubber-stamp every
 *  signer purely for having just signed *this* invite — the exact hole
 *  being closed. Blinded, that branch answers whether `vouch.by` already
 *  had standing over `pk` on some OTHER ground (guardian role, or the
 *  unvouched grace period run out) — genuine prior authority, not
 *  authority `vouch` is itself trying to manufacture. The signer being the
 *  target themselves never counts either — `mayRemove` alone would (it
 *  treats `pk === signerPk` as a self-removal), but that's a different
 *  judgement than "removed by someone else's re-key" (in practice `mayVouch`
 *  already refuses a self-vouch, so this is belt and suspenders).
 *
 *  Only a removal not yet applied ever reaches here (both call sites
 *  already checked tombstones): re-sending it against a member who's since
 *  been genuinely invited back would evict them for a decision that's gone
 *  stale. One Activity note per dropped member, same free-text-
 *  `params.reason` idiom trust-watch.ts's own `noticeDrop` uses on the same
 *  `member-removed` kind (`activity.ts`'s `summarize` renders it verbatim).
 *  Returns the survivors, in `removals`' own order. */
function dropReAddedSince(circleId: string, removals: string[], sinceAt: (pk: string) => number | undefined, now: number): string[] {
  const c = store.load().circles.find((x) => x.id === circleId)
  const liveView = trustViewFor(circleId)
  const dropped: string[] = []
  const kept = removals.filter((pk) => {
    const since = sinceAt(pk)
    const vouch = vouchFor(circleId, pk)
    const addedAt = vouch?.createdAt
    if (since === undefined || addedAt === undefined || addedAt <= since) return true
    const by = vouch!.by
    const view: TrustView = { ...liveView, voucherOf: (p) => (p === pk ? null : liveView.voucherOf(p)) }
    if (by === pk || !mayRemove(view, by, pk, now)) return true
    dropped.push(pk)
    return false
  })
  if (dropped.length) {
    // Dropped for good, not just this resend — otherwise the next resend
    // attempt (another stale-rekey retry, or the next `resumePendingRemovals`
    // at app start) would judge the very same pks all over again, and log a
    // fresh Activity note (its id is keyed on `now`) every single time.
    store.update((p) => {
      const pending = (p.pendingRemovals[circleId] ?? []).filter((pk) => !dropped.includes(pk))
      const { [circleId]: _old, ...otherPending } = p.pendingRemovals
      p.pendingRemovals = pending.length ? { ...otherPending, [circleId]: pending } : otherPending
      const at = Object.fromEntries(Object.entries(p.pendingRemovalsAt[circleId] ?? {}).filter(([pk]) => !dropped.includes(pk)))
      const { [circleId]: _oldAt, ...otherPendingAt } = p.pendingRemovalsAt
      p.pendingRemovalsAt = Object.keys(at).length ? { ...otherPendingAt, [circleId]: at } : otherPendingAt
    })
    for (const pk of dropped) {
      const name = c?.members.find((m) => m.pk === pk)?.name || shortNpub(pk)
      activity.recordActivity({
        id: `local-drop-stale-removal-${circleId}-${pk}-${now}`, at: now, kind: 'member-removed', circleId, actorPk: pk,
        params: { reason: `Didn't repeat an old removal of ${name}: they've been invited back.` },
      })
    }
  }
  return kept
}

/** App start (after `restore()` and registering senders): re-enqueues the
 *  removals this device asked for that no applied re-key carries yet and
 *  no queued re-key still holds. Stale-removal fix: drops (`dropReAddedSince`)
 *  anyone re-vouched onto the roster since `pendingRemovalsAt` recorded the
 *  request, rather than resending their removal too. */
export async function resumePendingRemovals(): Promise<void> {
  const p = store.load()
  const now = nowSec()
  for (const [circleId, pks] of Object.entries(p.pendingRemovals)) {
    const c = p.circles.find((x) => x.id === circleId)
    if (!c) {
      store.update((sp) => { const { [circleId]: _gone, ...rest } = sp.pendingRemovals; sp.pendingRemovals = rest })
      continue
    }
    const queued = new Set(p.structuralQueue
      .filter((q) => q.action === 'rekey' && q.circleId === circleId)
      .flatMap((q) => parseRekeyPayload(q.payload)?.removals ?? []))
    const tomb = new Set(c.removedPks ?? [])
    const missing = pks.filter((pk) => !tomb.has(pk) && !queued.has(pk))
    const requestedAt = p.pendingRemovalsAt[circleId] ?? {}
    const toResend = dropReAddedSince(circleId, missing, (pk) => requestedAt[pk], now)
    if (toResend.length) await sendRekey(c, toResend)
  }
}

/** Whether `pk`'s removal from `circleId` is already in flight, by the same
 *  test `resumePendingRemovals` makes before resending: recorded in
 *  `pendingRemovals` (a `sendRekey` this device already sent, kept until an
 *  applied re-key carries it), or a queued-but-not-yet-applied `rekey`
 *  already lists it in its `removals`. A caller deciding whether to call
 *  `sendRekey` again for the same pk (trust-watch.ts's timeout/leave
 *  fallback, Task 8 fix round 1, finding I2) should skip when this is
 *  true — otherwise every tick before the re-key applies enqueues (and
 *  signs) another one. */
export function removalPending(circleId: string, pk: string): boolean {
  const p = store.load()
  if (p.pendingRemovals[circleId]?.includes(pk)) return true
  return p.structuralQueue.some((q) =>
    q.action === 'rekey' && q.circleId === circleId && (parseRekeyPayload(q.payload)?.removals ?? []).includes(pk))
}

/** Gift-wraps a signed re-key and the seed it commits to (final fix A3:
 *  `{ struct, seed }` — the seed is phone-sealed, never signed) to
 *  `phonePk`'s own inbox, sealed by this phone. */
async function wrapRekeyTo(signed: SignedEvent, seed: string, phonePk: string): Promise<void> {
  const wrap = await giftWrap(phoneSigner(), phonePk, { kind: KINDS.signal, tags: [['t', 'struct']], content: JSON.stringify({ struct: signed, seed }) }, personalInboxTag(phonePk))
  await beacons.publishOrEnqueue(appRelays(store.load()), wrap)
}

/** The structural queue's sender for `rekey`. A re-key signed against a
 *  seed that has since been replaced (another re-key won) can't be sent —
 *  every receiver would drop it — so its removals not yet applied are
 *  re-enqueued as a fresh re-key on top of the current seed. Otherwise the
 *  signed event is gift-wrapped to every non-revoked phone in its `to`
 *  (this phone included, so a restart inside the window still receives it
 *  from the relay), and offered to this device's own collection window. */
async function sendRekeyEvent(signed: SignedEvent, circleId: string, seed: string | undefined): Promise<void> {
  const ev = verifyStructural(signed)
  const c = store.load().circles.find((x) => x.id === circleId)
  if (!ev || ev.action !== 'rekey' || !c) return
  const payload = parseRekeyPayload(ev.payload)
  if (!payload || payload.id !== c.id) return
  // Stale (built on a replaced seed) or its committed seed is missing from
  // the item (final fix A3 — nothing receivers could apply): either way its
  // removals not yet applied are re-sent as a fresh re-key.
  if (payload.prev !== ev.prev || ev.prev !== seedHash(c.seedHex) || !seed || seedHash(seed) !== payload.next) {
    const tombstones = new Set((c as store.StoredCircle).removedPks ?? [])
    const pendingRemovals = dropReAddedSince(circleId, payload.removals.filter((pk) => !tombstones.has(pk)), () => ev.event.created_at, nowSec())
    if (pendingRemovals.length) await sendRekey(c, pendingRemovals)
    return
  }
  const revoked = store.load().revokedPhoneKeys
  for (const phonePk of payload.to) {
    if (!revoked[phonePk]) await wrapRekeyTo(signed, seed, phonePk)
  }
  const mine = ownRekeyIds.get(c.id) ?? []
  if (!mine.includes(ev.event.id)) ownRekeyIds.set(c.id, [...mine, ev.event.id].slice(-20))
  offerRekey(c.id, { ev, payload, seed })
}

/** Adds a valid re-key to its circle's collection window, opening one (and
 *  its 10 s timer) on the first. A candidate for a different `prev` than the
 *  open window's is stale and ignored. */
function offerRekey(circleId: string, cand: RekeyCandidate): void {
  let w = rekeyWindows.get(circleId)
  if (!w) {
    w = { prev: cand.ev.prev, candidates: new Map(), timer: setTimeout(() => { closeRekeyWindow(circleId) }, REKEY_WINDOW_MS) }
    rekeyWindows.set(circleId, w)
  }
  if (w.prev !== cand.ev.prev) return
  w.candidates.set(cand.ev.event.id, cand)
}

/** Our own removals in `losers` that `winner` doesn't carry. */
function ownLostRemovals(circleId: string, losers: Array<{ id: string; removals: string[] }>, winner: string[]): string[] {
  const mine = new Set(ownRekeyIds.get(circleId) ?? [])
  const won = new Set(winner)
  return [...new Set(losers.filter((l) => mine.has(l.id)).flatMap((l) => l.removals).filter((pk) => !won.has(pk)))]
}

/** Final fix round 2, R2 (controller ruling): the winner among competing
 *  re-keys on the same `prev`. A candidate whose signer another candidate
 *  removes is disqualified; if that disqualifies every one (mutual removal),
 *  the winner is the one whose signer's identity pubkey is lexicographically
 *  lowest (a hex string compare) — stable and non-grindable, unlike roster
 *  order, which a guardian's own config can rearrange — else the lowest id
 *  among those left. Without the first step a removed guardian watching for
 *  a burst of re-key wraps could grind a lower id that removes the remover
 *  and take the circle on every device but the remover's. */
function pickRekeyWinner(cands: RekeyCandidate[]): RekeyCandidate | undefined {
  return pickByRekeyRule(cands, (c) => ({ id: c.ev.event.id, signerPk: c.ev.signerPk, removals: c.payload.removals }))
}

/** `pickRekeyWinner`'s rule over anything that names a re-key's id, signer
 *  and removals — shared by the window and the late path (final fix round 3,
 *  F1), so both always agree. */
function pickByRekeyRule<T>(cands: T[], facts: (c: T) => { id: string; signerPk: string; removals: string[] }): T | undefined {
  const byId = cands.map((c) => ({ c, f: facts(c) })).sort((a, b) => (a.f.id < b.f.id ? -1 : 1))
  const eligible = byId.filter((x) => !byId.some((o) => o !== x && o.f.removals.includes(x.f.signerPk)))
  if (eligible.length) return eligible[0]!.c
  // A stable sort: candidates with the same signer pubkey (impossible in
  // practice, but harmless) fall back to the lowest id, `byId`'s order.
  return [...byId].sort((a, b) => (a.f.signerPk < b.f.signerPk ? -1 : a.f.signerPk > b.f.signerPk ? 1 : 0))[0]?.c
}

/** Applies the winning candidate (`pickRekeyWinner`) if the circle is still
 *  on that `prev`. If the circle moved on meanwhile (a late winner replaced
 *  the re-key this window built on), this device's own candidates are
 *  re-enqueued. */
function closeRekeyWindow(circleId: string): void {
  const w = rekeyWindows.get(circleId)
  if (!w) return
  rekeyWindows.delete(circleId)
  const all = [...w.candidates.values()]
  if (!store.load().circles.some((x) => x.id === circleId)) return
  const winner = pickRekeyWinner(all)
  if (!winner) return
  const ranked = [winner, ...all.filter((c) => c !== winner)]
  const losers = ranked.slice(1).map((l) => ({ id: l.ev.event.id, removals: l.payload.removals }))
  if (!applyRekey(circleId, winner, 'next')) {
    const all = ranked.map((l) => ({ id: l.ev.event.id, removals: l.payload.removals }))
    const c = store.load().circles.find((x) => x.id === circleId)
    const lost = ownLostRemovals(circleId, all, c?.removedPks ?? [])
    if (c && lost.length) void sendRekey(c, lost)
    return
  }
  afterRekey(circleId, winner, losers)
}

/** A re-key on the same `prev` as the one applied that beats it
 *  (`lateBeatsApplied`), arriving after the window closed: it replaces the
 *  applied one (one level back). */
function replaceWithLateWinner(circleId: string, cand: RekeyCandidate): void {
  const last = store.load().lastRekey[circleId]
  if (!last || !applyRekey(circleId, cand, 'replace')) return
  afterRekey(circleId, cand, [])
  // Our own replaced removals are back in `pendingRemovals` (applyRekey);
  // re-enqueue them on top of the winner.
  const lost = lostOwnRemovals(last, cand.payload.removals)
  const c = store.load().circles.find((x) => x.id === circleId)
  if (c && lost.length) void sendRekey(c, lost)
}

/** The removals of a replaced re-key this device sent that the winner
 *  doesn't carry (and that weren't already tombstoned at `prev`). */
function lostOwnRemovals(last: store.LastRekey, winner: string[]): string[] {
  if (!last.mine) return []
  const keep = new Set([...winner, ...last.before.removedPks])
  return last.removals.filter((pk) => !keep.has(pk))
}

/** Everything after a re-key is applied: re-enqueue this device's own
 *  losing removals, forward the re-key to phones its sender missed,
 *  re-key again if it reached a revoked phone (guardian-role only), re-run
 *  parked work and re-post our statement on the new inbox. */
function afterRekey(circleId: string, winner: RekeyCandidate, losers: Array<{ id: string; removals: string[] }>): void {
  const c = store.load().circles.find((x) => x.id === circleId)
  if (!c) return
  const lost = ownLostRemovals(circleId, losers, winner.payload.removals)
  if (lost.length) void sendRekey(c, lost)
  void forwardRekey(c, winner)
  const self = currentSession()
  const revoked = store.load().revokedPhoneKeys
  if (self && isGuardian(c, self.identityPk) && winner.payload.to.some((pk) => revoked[pk])) void sendRekey(c, [])
  beacons.onPhonesBound(circleId)
  void beacons.postStatement(c).catch(() => { /* offline — the outbox retries */ })
}

/** Forwards the applied re-key (the same signed event) to every known,
 *  non-revoked phone of a remaining member that its `to` misses — once per
 *  phone, recorded in `seedRecipients`. */
async function forwardRekey(c: Circle, { ev, payload, seed }: RekeyCandidate): Promise<void> {
  const self = currentSession()
  const p = store.load()
  const have = new Set(p.lastRekey[c.id]?.id === ev.event.id ? p.lastRekey[c.id]?.seedRecipients ?? payload.to : payload.to)
  const missing = remainingPhones(c, []).filter((pk) => !have.has(pk) && pk !== self?.phonePk)
  if (!missing.length) return
  store.update((sp) => {
    const last = sp.lastRekey[c.id]
    if (!last || last.id !== ev.event.id) return
    const recipients = [...new Set([...last.seedRecipients, ...missing])].sort()
    sp.lastRekey = { ...sp.lastRekey, [c.id]: { ...last, seedRecipients: recipients } }
    sp.seedRecipients = { ...sp.seedRecipients, [c.id]: recipients }
  })
  for (const phonePk of missing) await wrapRekeyTo(ev.event, seed, phonePk)
}

/** Final fix A1: how long after the replaced re-key was applied, and how
 *  far past its own signed `created_at`, a late winner may still replace
 *  it. Past either bound the applied re-key stands. */
export const LATE_WINNER_MS = 10 * 60 * 1000
export const LATE_WINNER_SKEW_SEC = 600

/** The members a re-key removed that weren't already tombstoned at its
 *  `prev` — the people it newly cut out. */
function newlyRemoved(last: store.LastRekey): Set<string> {
  const before = new Set(last.before.removedPks)
  return new Set(last.removals.filter((pk) => !before.has(pk)))
}

/** Final fix round 3, F1: whether late re-key `ev` (removals `removals`)
 *  beats the applied `last` on the same `prev` — exactly
 *  `pickRekeyWinner([last, ev])`: disqualified if `last` removes its signer
 *  and it doesn't remove `last`'s; winning outright if it removes `last`'s
 *  signer and `last` doesn't remove its; a mutual removal goes to the lower
 *  identity pubkey; otherwise the lower id wins. */
function lateBeatsApplied(last: store.LastRekey, ev: StructuralEvent, removals: string[]): boolean {
  const lateFacts = { id: ev.event.id, signerPk: ev.signerPk, removals }
  const appliedFacts = { id: last.id, signerPk: last.signerPk, removals: last.removals }
  return pickByRekeyRule([appliedFacts, lateFacts], (f) => f) === lateFacts
}

/** Whether `ev`'s signer removes the signer of `last` while `last` newly
 *  removed it — a mutual removal, which `lateBeatsApplied` settles by
 *  pubkey (final fix round 3, F1), so it is the one case where a member
 *  `last` cut out may still have its re-key judged. Final fix round 4: only
 *  while `ev` is received within `REKEY_WINDOW_MS` of `last` being applied
 *  here (receipt time — no signed field can tell a race from retaliation),
 *  the same grace the collection window gives. After that a member `last`
 *  removed can never replace it (A1), whatever its pubkey. */
function mutualRemoval(last: store.LastRekey, ev: StructuralEvent, removals: string[]): boolean {
  if (Date.now() - last.appliedAt > REKEY_WINDOW_MS) return false
  return removals.includes(last.signerPk) && newlyRemoved(last).has(ev.signerPk)
}

/** Final fix A1 (critical), amended by final fix round 3, F1: whether `ev`
 *  may replace `last` at all. Its signer must not be one of the members
 *  `last` newly removed — no one contests their own removal — unless it is
 *  a mutual removal (`mutualRemoval`), which `lateBeatsApplied` decides by
 *  the same rule as the window. And it must come soon after `last`:
 *  received within `LATE_WINNER_MS` of `last` being applied here, and dated
 *  no more than `LATE_WINNER_SKEW_SEC` after it. Without these a removed
 *  guardian (still holding the old seed) could grind a lower id at leisure
 *  and replace its own removal. */
function lateWinnerAllowed(last: store.LastRekey, ev: StructuralEvent, removals: string[]): boolean {
  if (newlyRemoved(last).has(ev.signerPk) && !mutualRemoval(last, ev, removals)) return false
  if (Date.now() - last.appliedAt > LATE_WINNER_MS) return false
  return ev.event.created_at <= last.createdAt + LATE_WINNER_SKEW_SEC
}

/** Applies a re-key. `'next'`: it builds on the current seed. `'replace'`:
 *  it replaces the last applied re-key (same `prev`, lower id), on top of
 *  the circle as it was at `prev` — the replaced re-key's removals are
 *  rolled back (members and phone bindings restored); if it was this
 *  device's, those it lacks go back into `pendingRemovals`. Either way: its
 *  seed becomes current and its hash is appended to the chain, the removal
 *  set is unioned (removals only grow), removed members and their phone
 *  keys are dropped (with a `member-removed` Activity entry),
 *  `seedRecipients`/`lastRekey` record it, and `pendingRemovals` loses what
 *  it carries. Returns whether it applied. */
function applyRekey(circleId: string, { ev, payload, seed }: RekeyCandidate, mode: 'next' | 'replace'): boolean {
  let removedNow: string[] = []
  let restored: string[] = []
  let applied = false
  let rescan: Circle | undefined
  const now = nowSec()
  // Ours if signed by our identity (from any of its phones) — derived from
  // the signed event, so it survives a restart before the re-key applies.
  const mine = ev.signerPk === currentSession()?.identityPk
  store.update((sp) => {
    const idx = sp.circles.findIndex((x) => x.id === circleId)
    const c = idx >= 0 ? sp.circles[idx] : undefined
    if (!c) return
    const last = sp.lastRekey[circleId]
    if (mode === 'next' && seedHash(c.seedHex) !== ev.prev) return
    if (mode === 'replace' && (!last || last.prev !== ev.prev || !lateBeatsApplied(last, ev, payload.removals) || !lateWinnerAllowed(last, ev, payload.removals))) return
    // The state this re-key builds on.
    let members = c.members
    let baseTombs = c.removedPks ?? []
    let baseRemovals = c.removals ?? {}
    let pending = sp.pendingRemovals[circleId] ?? []
    let pendingAt = sp.pendingRemovalsAt[circleId] ?? {}
    if (mode === 'replace' && last) {
      members = [...c.members, ...last.before.members.filter((m) => !c.members.some((x) => x.pk === m.pk))]
      restored = last.before.members.map((m) => m.pk).filter((pk) => !payload.removals.includes(pk))
      baseTombs = last.before.removedPks
      baseRemovals = last.before.removals
      const table = { ...(sp.phoneKeys[circleId] ?? {}) }
      for (const [phonePk, binding] of Object.entries(last.before.phones)) {
        if (!sp.revokedPhoneKeys[phonePk] && !table[phonePk]) table[phonePk] = binding
      }
      sp.phoneKeys = { ...sp.phoneKeys, [circleId]: table }
      const lost = lostOwnRemovals(last, payload.removals)
      pending = [...new Set([...pending, ...lost])]
      pendingAt = { ...pendingAt }
      for (const pk of lost) pendingAt[pk] ??= now
    }
    const newHash = payload.next
    const removedPks = [...new Set([...baseTombs, ...payload.removals])].sort()
    const removals = { ...baseRemovals }
    for (const pk of payload.removals) removals[pk] ??= { at: ev.event.created_at, hash: newHash }
    const tomb = new Set(removedPks)
    const leaving = members.filter((m) => tomb.has(m.pk))
    removedNow = leaving.map((m) => m.pk)
    const leavingPhones = Object.fromEntries(Object.entries(sp.phoneKeys[circleId] ?? {}).filter(([, b]) => removedNow.includes(b.memberPk)))
    // Final review A, I1: a removed member's vouch goes with them — kept in
    // `before`, so a late winner that restores them restores it too.
    let vouchTable = Object.hasOwn(sp.vouches, circleId) ? sp.vouches[circleId] : undefined
    if (mode === 'replace' && last?.before.vouches) {
      for (const pk of restored) {
        const ev = Object.hasOwn(last.before.vouches, pk) ? last.before.vouches[pk] : undefined
        if (!ev) continue
        if (!vouchTable) {
          vouchTable = {}
          Object.defineProperty(sp.vouches, circleId, { value: vouchTable, enumerable: true, writable: true, configurable: true })
        }
        if (!Object.hasOwn(vouchTable, pk)) vouchTable[pk] = ev
      }
    }
    const leavingVouches: Record<string, SignedEvent> = {}
    if (vouchTable) {
      for (const pk of removedNow) {
        if (!Object.hasOwn(vouchTable, pk)) continue
        leavingVouches[pk] = vouchTable[pk]!
        delete vouchTable[pk]
      }
    }
    const rotated = mode === 'next'
      ? applyReseed(c, { id: c.id, s: seed }, now)
      : { ...c, seedHex: seed, reseededAt: now }
    // epochStartedAt (Task 10 fix round 3): the new epoch this re-key just
    // installed starts now, at the re-key's own signed created_at.
    const next: store.StoredCircle = { ...rotated, members: members.filter((m) => !tomb.has(m.pk)), removedPks, removals, epochStartedAt: ev.event.created_at }
    sp.circles[idx] = next
    const chain = sp.seedHashes[circleId] ?? [ev.prev]
    sp.seedHashes = { ...sp.seedHashes, [circleId]: chain.includes(newHash) ? chain : [...chain, newHash] }
    sp.seedRecipients = { ...sp.seedRecipients, [circleId]: payload.to }
    sp.lastRekey = {
      ...sp.lastRekey,
      [circleId]: {
        prev: ev.prev, id: ev.event.id, signerPk: ev.signerPk, removals: payload.removals, seedRecipients: payload.to, mine,
        createdAt: ev.event.created_at, appliedAt: Date.now(), event: ev.event,
        before: { removedPks: baseTombs, removals: baseRemovals, members: leaving, phones: leavingPhones, vouches: leavingVouches },
      },
    }
    // Task 6 fix round 1: a re-key held from a bundle installed the seed
    // this one replaced.
    if (Object.hasOwn(sp.heldRekeys, circleId)) sp.heldRekeys = Object.fromEntries(Object.entries(sp.heldRekeys).filter(([k]) => k !== circleId))
    pending = pending.filter((pk) => !tomb.has(pk))
    const { [circleId]: _old, ...otherPending } = sp.pendingRemovals
    sp.pendingRemovals = pending.length ? { ...otherPending, [circleId]: pending.sort() } : otherPending
    pendingAt = Object.fromEntries(Object.entries(pendingAt).filter(([pk]) => !tomb.has(pk)))
    const { [circleId]: _oldAt, ...otherPendingAt } = sp.pendingRemovalsAt
    sp.pendingRemovalsAt = Object.keys(pendingAt).length ? { ...otherPendingAt, [circleId]: pendingAt } : otherPendingAt
    applied = true
    rescan = next
  })
  // One `member-removed` entry per (circle, member, prev): a member removed
  // by both a replaced re-key and its late winner (same prev) is logged
  // once, and one the late winner restores has its entry withdrawn.
  if (restored.length) {
    const gone = new Set(restored.map((pk) => memberRemovedActivityId(circleId, pk, ev.prev)))
    store.update((sp) => { sp.activity = sp.activity.filter((a) => !gone.has(a.id)) })
  }
  for (const pk of removedNow) {
    forgetMember(circleId, pk)
    activity.recordActivity({ id: memberRemovedActivityId(circleId, pk, ev.prev), at: now, kind: 'member-removed', circleId, actorPk: pk, params: {} })
  }
  if (rescan) {
    // A removed voucher's vouchees who stay are unvouched (spec §4; Task 8
    // hands over or times them out) — from the re-key's own signed time,
    // clamped to now (final review A, I3: every device judges the grace
    // from the same moment, however late it applies the re-key).
    rejudgeVouched(rescan, new Set(removedNow), Math.min(ev.event.created_at, now))
    rescanBuffered(rescan, now)
  }
  return applied
}

function memberRemovedActivityId(circleId: string, pk: string, prev: string): string {
  return `member-removed-${circleId}-${pk}-${prev}`
}

// Phone inbox (`personalInboxTag(phonePk)`, decrypted locally with the phone
// key): re-keys now, DMs from Task 9. Content-bound rumor-id dedup, marked
// only once a rumor is handled or definitively rejected (a parked one is
// re-judged later, and a relay re-delivery must reach it again).
const seenPhoneRumorIds = new Set<string>()
function markPhoneRumorSeen(id: string): void {
  if (seenPhoneRumorIds.has(id)) return
  seenPhoneRumorIds.add(id)
  if (seenPhoneRumorIds.size > 1000) seenPhoneRumorIds.delete(seenPhoneRumorIds.values().next().value as string)
}

/** Receive side of this phone's own inbox: re-keys (circles.ts's own
 *  concern) and, Signet identity plan Task 9, person-to-person DMs
 *  (messages.ts's `setPersonalDmHandler` registration — see that module's
 *  own doc comment for why a DM now wraps once per phone key of the
 *  recipient, rather than once to the recipient's identity key directly). A
 *  rumor that parses as a DM is routed there and never reaches
 *  `judgeRekeyRumor` (mutually exclusive wire shapes: a DM carries no `t`
 *  tag on its inner event at all, so `judgeRekeyRumor`'s own `t !== 'struct'`
 *  check would just no-op on it anyway — the explicit branch here is purely
 *  to resolve and dispatch it, not to avoid a false match). */
export async function onPhoneInboxWrap(e: { pubkey: string; content: string }): Promise<void> {
  const self = currentSession()
  if (!self) return
  poolHealth.notePoolActivity()
  const signer = phoneSigner()
  const rumor = await giftUnwrap((pk, ct) => signer.nip44Decrypt(pk, ct), e)
  if (!rumor) return
  if (rumor.id && seenPhoneRumorIds.has(rumor.id)) return
  // Plan 2 (Task 6): a guardian's invite to a dependant arrives here — a
  // dependant has no personal inbox.
  const invite = parseIncomingInvite(rumor)
  if (invite) {
    if (rumor.id) markPhoneRumorSeen(rumor.id)
    handleIncomingInvite(invite, 'phone')
    return
  }
  // Plan 2 (Task 7): a dependant's pairing reply to this (guardian) phone.
  if (rumor.kind === KINDS.signal && rumor.tags.find((tag) => tag[0] === 't')?.[1] === LINK_PAIR_SIGNAL_TYPE) {
    if (rumor.id) markPhoneRumorSeen(rumor.id)
    if (rumor.pubkey !== self.phonePk) await linkPairHandler?.(rumor, rumor.pubkey)
    return
  }
  const dm = parseDmContent(rumor.content)
  if (dm) {
    // Own echo: a DM this device's own phone forwarded to another of the
    // recipient's phones (or, degenerately, to itself) never reaches the
    // handler — same discipline as every other phone-key receive path.
    if (rumor.pubkey !== self.phonePk) {
      const from = memberForPhone(dm.circleId, rumor.pubkey)
      if (from) personalDmHandler?.({ from, circleId: dm.circleId, text: dm.text, at: rumor.created_at })
    }
    if (rumor.id) markPhoneRumorSeen(rumor.id)
    return
  }
  const outcome = judgeRekeyRumor(rumor)
  if (rumor.id && outcome !== 'parked') markPhoneRumorSeen(rumor.id)
}

/** Judges a phone-inbox rumor carrying a re-key. Applied (after the window)
 *  only if: it verifies; its circle is one we hold; the sealing phone maps
 *  to a member (or is this phone — our own re-key, re-delivered); its
 *  signer is authorised (plan 1: guardian-role); its payload names the
 *  circle and agrees with the signed `prev`; and `prev` is the CURRENT
 *  seed hash. On the previous `prev` with a lower id than the applied one it
 *  replaces it (late winner), judged against the roster and phones as
 *  they were at that `prev`. A roster member's re-key with an unbound
 *  sealing phone, or with a `prev` this circle has never had (built on a
 *  re-key not seen yet), is parked; an outsider's is dropped. */
function judgeRekeyRumor(rumor: Rumor): 'done' | 'parked' {
  const self = currentSession()
  if (!self || rumor.kind !== KINDS.signal) return 'done'
  if (rumor.tags.find((tag) => tag[0] === 't')?.[1] !== 'struct') return 'done'
  let raw: unknown
  try { raw = JSON.parse(rumor.content) } catch { return 'done' }
  if (!raw || typeof raw !== 'object') return 'done'
  const { struct, seed } = raw as { struct?: unknown; seed?: unknown }
  const ev = verifyStructural(struct)
  if (!ev || ev.action !== 'rekey') return 'done'
  if (typeof seed !== 'string' || !INVITE_SEED_RE.test(seed)) return 'done'
  const p = store.load()
  const c = p.circles.find((x) => x.id === ev.circleId)
  if (!c) return 'done'
  const payload = parseRekeyPayload(ev.payload)
  if (!payload || payload.id !== c.id || payload.prev !== ev.prev) return 'done'
  // Final fix A3: the carried seed must be the one the signed event commits to.
  if (seedHash(seed) !== payload.next) return 'done'
  // A late winner is judged against the roster as it was at its `prev`,
  // minus the members the re-key it would replace newly removed (final fix
  // A1: no one contests their own removal — their re-key is dropped, not
  // parked — except its signer in a mutual removal, final fix round 3, F1).
  const last = p.lastRekey[c.id]
  const late = !!last && ev.prev !== seedHash(c.seedHex) && ev.prev === last.prev
  const cutOut = late && last ? newlyRemoved(last) : new Set<string>()
  if (late && last && mutualRemoval(last, ev, payload.removals)) cutOut.delete(ev.signerPk)
  const roster: Circle = late && last
    ? { ...c, members: [...c.members, ...last.before.members.filter((m) => !cutOut.has(m.pk) && !c.members.some((x) => x.pk === m.pk))] }
    : c
  // Final fix A1: a phone of a member the replaced re-key newly removed
  // never counts as bound — no one contests their own removal.
  const beforeBinding = late && last ? last.before.phones[rumor.pubkey] : undefined
  const sealerBound = rumor.pubkey === self.phonePk || !!memberForPhone(c.id, rumor.pubkey)
    || (!!beforeBinding && !cutOut.has(beforeBinding.memberPk) && !p.revokedPhoneKeys[rumor.pubkey])
  const signerOnRoster = roster.members.some((m) => m.pk === ev.signerPk)
  if (!sealerBound) {
    // Park only for a roster member's re-key (its phone may bind soon);
    // an outsider's is dropped, so it can't flood the park.
    if (!signerOnRoster) return 'done'
    parkRekey(c.id, rumor)
    return 'parked'
  }
  // Plan 2, Task 5: the full authority table, judged against the roster
  // at `prev` (plan-1 ruling).
  if (!structuralAuthorised(trustViewOf(roster), ev, nowSec())) return 'done'
  if (ev.prev === seedHash(c.seedHex)) {
    offerRekey(c.id, { ev, payload, seed })
    return 'done'
  }
  if (late && last) {
    if (lateBeatsApplied(last, ev, payload.removals) && lateWinnerAllowed(last, ev, payload.removals)) replaceWithLateWinner(c.id, { ev, payload, seed })
    return 'done'
  }
  if (knownSeedHashes(c).includes(ev.prev)) return 'done' // stale
  parkRekey(c.id, rumor)
  return 'parked'
}

/** Re-judges the re-keys parked for `circleId` (after a phone binds there,
 *  or a re-key is applied). */
export function rerunParkedRekeys(circleId: string): void {
  const list = parkedRekeys.get(circleId)
  if (!list?.length) return
  parkedRekeys.delete(circleId)
  for (const rumor of list) {
    if (judgeRekeyRumor(rumor) !== 'parked' && rumor.id) markPhoneRumorSeen(rumor.id)
  }
}

/** Final fix round 2, R1c: how far ahead of our clock a received config's
 *  `updatedAt` may be before it is refused. */
export const CONFIG_FUTURE_SKEW_SEC = 600

// ---------------------------------------------------------------------------
// Trust view, vouches and config v2 (plan 2, Task 5; spec §3–4)
// ---------------------------------------------------------------------------

/** The authority.ts view of `circle` as given (its roster, name), with this
 *  device's stored creator, vouches, unvouched marks and guardian links. */
function trustViewOf(circle: Circle): TrustView {
  const id = circle.id
  return {
    members: circle.members,
    name: circle.name,
    creator: creatorOf(id),
    voucherOf: (pk) => voucherOf(id, pk),
    vouchFor: (pk) => heldVouches(id, pk),
    linked,
    unvouchedSince: (pk) => unvouchedSince(id, pk),
    removedAt: (pk) => {
      const r = (circle as store.StoredCircle).removals
      return r && Object.hasOwn(r, pk) ? r[pk]!.at : null
    },
  }
}

/** The vouches a config adding `pk` may rely on: the member table's, then
 *  the pending ones (Task 5 fix round 1). */
function heldVouches(circleId: string, pk: string): Vouch[] {
  const main = vouchFor(circleId, pk)
  return [...(main ? [main] : []), ...pendingVouchesFor(circleId, pk)]
}

/** The trust view of `circleId`'s current roster (an empty roster, which
 *  authorises nothing, when the circle isn't held). */
export function trustViewFor(circleId: string): TrustView {
  const c = store.load().circles.find((x) => x.id === circleId)
  return trustViewOf(c ?? { id: circleId, name: '', seedHex: '', epoch: 0, members: [], createdAt: 0, configUpdatedAt: 0, configBy: '' })
}

/** Plan 2, Task 5 (controller ruling R4): fired when an applied config
 *  removes its own signer — a leave. Task 8 re-keys the leaver out. */
export type MemberLeftHandler = (circleId: string, pk: string, nowSec: number) => void
const memberLeftHandlers = new Set<MemberLeftHandler>()
export function onMemberLeft(cb: MemberLeftHandler): () => void {
  memberLeftHandlers.add(cb)
  return () => { memberLeftHandlers.delete(cb) }
}

/** Stores a vouch (a signed `invite` naming its invitee, or a hand-over
 *  `vouch`) for `circleId` once the roster allows it (controller ruling R2).
 *  For a member, the vouch must be `vouchValid` for their current role.
 *  Final fix N1 (controller ruling): a hand-over never grants removal
 *  authority, so it never goes in the member table — that holds each
 *  member's original invite, replaced by nothing (an invite is stored for
 *  a member only when none is held). A hand-over is kept with the others
 *  for that member (one per voucher, any order) and clears their unvouched
 *  mark once one counts (`vouchedIn`). A vouch for someone not on the
 *  roster yet (a config adding them may be on its way) must be an invite
 *  by a roster member and goes in the pending table (Task 5 fix round 1):
 *  it is judged only when a config adds its vouchee, and a bad one can't
 *  block a good one. When stored, the parked configs adding that vouchee
 *  are re-judged unless `rerun` is false. True if stored. */
export function acceptVouch(circleId: string, raw: unknown, now: number, rerun = true): boolean {
  const v = verifyVouch(raw)
  const c = store.load().circles.find((x) => x.id === circleId)
  if (!v || !c || v.circleId !== circleId) return false
  const vouchee = c.members.find((m) => m.pk === v.pk)
  if (!vouchee) {
    // Final review A, I1: only an invite (it names a role) can add someone;
    // a hand-over is for a current member only.
    if (v.role === undefined || !c.members.some((m) => m.pk === v.by)) return false
    const stored = storePendingVouch(v, { nowSec: now })
    if (stored && rerun) beacons.onVouchStored(circleId, v.pk)
    return stored
  }
  if (!vouchValid(trustViewOf(c), v, vouchee.role)) return false
  if (v.role === undefined) {
    const stored = storePendingVouch(v, { nowSec: now })
    if (stored && unvouchedSince(circleId, v.pk) !== null && vouchedIn(c, v.pk, handOversFor(circleId, v.pk))) clearUnvouched(circleId, v.pk)
    return stored
  }
  if (vouchFor(circleId, v.pk)) return false
  return storeVouch(v, { nowSec: now })
}

/** Final fix N1 (controller ruling): whether member `pk` of `c` is
 *  vouched — their original voucher is still on the roster, or one of the
 *  hand-overs `hs` held for them counts: its signer may vouch for them now
 *  (`vouchValid`: on the roster, by role), and it is dated after their
 *  original vouch (a hand-over from before a removal and re-invite counts
 *  for nothing) and after any removal of its signer. Any one will do, so
 *  the answer depends only on what is held, never on arrival order. */
function vouchedIn(c: Circle, pk: string, hs: readonly Vouch[]): boolean {
  const orig = vouchFor(c.id, pk)
  if (orig && c.members.some((m) => m.pk === orig.by)) return true
  const role = c.members.find((m) => m.pk === pk)?.role
  if (!role) return false
  const view = trustViewOf(c)
  return hs.some((h) => {
    if (h.pk !== pk || (orig && h.createdAt <= orig.createdAt)) return false
    const gone = view.removedAt?.(h.by) ?? null
    return (gone === null || h.createdAt > gone) && vouchValid(view, h, role)
  })
}

/** Final fix N1: after the members `departed` left `c` (`c` is the roster
 *  after), re-judges each remaining member whose original voucher, or the
 *  signer of a hand-over held for them, is among them: still vouched
 *  (`vouchedIn`) clears their mark, otherwise they are unvouched from
 *  `since` — the departure's own signed time (final review A, I3). */
function rejudgeVouched(c: Circle, departed: ReadonlySet<string>, since: number): void {
  const hs = allHandOvers(c.id)
  for (const m of c.members) {
    const orig = vouchFor(c.id, m.pk)
    const mine = hs.filter((h) => h.pk === m.pk)
    if (!(orig && departed.has(orig.by)) && !mine.some((h) => departed.has(h.by))) continue
    if (vouchedIn(c, m.pk, mine)) clearUnvouched(c.id, m.pk)
    else markUnvouched(c.id, m.pk, since)
  }
}

/** The config v2 this device writes for `circle`'s roster: the held creator
 *  (`''` when none is held), every stored vouch whose vouchee is on it, and
 *  the pending vouches of a member with no stored one (one just added
 *  here, whose vouch receivers may not hold yet). */
function buildConfigV2(circle: Circle): ConfigV2 {
  const onRoster = new Set(circle.members.map((m) => m.pk))
  const stored = allVouches(circle.id).filter((ev) => { const v = verifyVouch(ev); return !!v && onRoster.has(v.pk) })
  const covered = new Set(stored.map((ev) => verifyVouch(ev)!.pk))
  const pending = circle.members.filter((m) => !covered.has(m.pk)).flatMap((m) => pendingVouchesFor(circle.id, m.pk).map((v) => v.event))
  return {
    v: 2,
    id: circle.id,
    name: circle.name,
    createdBy: creatorOf(circle.id) ?? '',
    updatedAt: circle.configUpdatedAt,
    by: circle.configBy,
    members: circle.members.map((m) => ({ pk: m.pk, role: m.role, ...(m.name !== undefined ? { name: m.name } : {}) })),
    vouches: [...stored, ...pending],
  }
}

/** Plan 2 (Task 6): keeps `signed` as `circleId`'s held config when it is
 *  a verified v2 `config` for that circle written by its signer, and newer
 *  than the one held (latest-wins, as `mergeConfigV2`). Called for the
 *  configs this device sends, the authorised ones it receives and a
 *  joiner's bundle config; `sendInvite` carries it in each bundle. */
export function rememberConfig(circleId: string, signed: SignedEvent): void {
  const ev = verifyStructural(signed)
  if (!ev || ev.action !== 'config' || ev.circleId !== circleId) return
  const cfg = parseConfigV2(ev.payload)
  if (!cfg || cfg.id !== circleId || cfg.by !== ev.signerPk) return
  store.update((p) => {
    const cur = Object.hasOwn(p.heldConfigs, circleId) ? p.heldConfigs[circleId] : undefined
    const h = cur ? parseConfigV2(cur.content) : null
    if (h && !(cfg.updatedAt > h.updatedAt || (cfg.updatedAt === h.updatedAt && cfg.by < h.by))) return
    Object.defineProperty(p.heldConfigs, circleId, { value: ev.event, enumerable: true, writable: true, configurable: true })
  })
}

/** The re-key that installed `circleId`'s current seed, re-verified, or
 *  null (Task 6 pre-review ruling: carried in each invite bundle). Either
 *  the one this device applied or the one its joining bundle carried (fix
 *  round 1); one that installed any other seed is never sent — a joiner
 *  would drop the whole invite. */
function heldRekey(circleId: string): SignedEvent | null {
  const p = store.load()
  const c = p.circles.find((x) => x.id === circleId)
  if (!c) return null
  const current = seedHash(c.seedHex)
  const candidates = [p.lastRekey[circleId]?.event, Object.hasOwn(p.heldRekeys, circleId) ? p.heldRekeys[circleId] : undefined]
  for (const raw of candidates) {
    const ev = verifyStructural(raw)
    if (!ev || ev.action !== 'rekey' || ev.circleId !== circleId) continue
    const payload = parseRekeyPayload(ev.payload)
    if (payload && payload.id === circleId && payload.prev === ev.prev && payload.next === current) return ev.event
  }
  return null
}

/** The held config for `circleId`, re-verified, or null. */
function heldConfig(circleId: string): SignedEvent | null {
  const p = store.load()
  const ev = Object.hasOwn(p.heldConfigs, circleId) ? verifyStructural(p.heldConfigs[circleId]) : null
  return ev && ev.action === 'config' && ev.circleId === circleId ? ev.event : null
}

/** Queues an identity-signed `config` for `circle`'s current roster. */
export function enqueueConfig(circle: Circle): void {
  enqueue({ action: 'config', circleId: circle.id, payload: JSON.stringify(buildConfigV2(circle)), label: `Update members of ${circle.name}` })
}

/** The choke point's verdict on a verified `config` from a roster member
 *  (beacons.ts `receiveStructural`): judged against the current roster,
 *  stored vouches and the vouches it carries. */
export function judgeConfig(circleId: string, signerPk: string, payload: string, now: number): ConfigVerdict {
  const cfg = parseConfigV2(payload)
  if (!cfg) return 'refused'
  return configVerdict(trustViewFor(circleId), circleId, signerPk, cfg, (pk) => heldVouches(circleId, pk), now)
}

/** Leaves `circleId`: queues a config that removes only us (any member may
 *  remove themself). Once it is sent, the circle is deleted here (the
 *  config sender — `forgetLeftCircle`). */
export async function leaveCircle(circleId: string): Promise<void> {
  const self = currentSession()
  const c = store.load().circles.find((x) => x.id === circleId)
  if (!self || !c || !c.members.some((m) => m.pk === self.identityPk)) return
  const at = Math.max(nowSec(), c.configUpdatedAt + 1)
  const left: Circle = { ...c, members: c.members.filter((m) => m.pk !== self.identityPk), configUpdatedAt: at, configBy: self.identityPk }
  registerStructuralSenders()
  enqueue({ action: 'config', circleId, payload: JSON.stringify(buildConfigV2(left)), label: `Leave ${c.name}` })
  await drain()
}

/** Deletes a circle this identity has left, with its seeds, vouches and
 *  phone keys, and records it in Activity. */
function forgetLeftCircle(circleId: string, selfPk: string): void {
  const c = store.load().circles.find((x) => x.id === circleId)
  if (!c) return
  store.update((sp) => {
    sp.circles = sp.circles.filter((x) => x.id !== circleId)
    const drop = <T>(rec: Record<string, T>): Record<string, T> => Object.fromEntries(Object.entries(rec).filter(([k]) => k !== circleId))
    sp.seedHashes = drop(sp.seedHashes)
    sp.phoneKeys = drop(sp.phoneKeys)
    sp.seedRecipients = drop(sp.seedRecipients)
    sp.lastRekey = drop(sp.lastRekey)
    sp.pendingRemovals = drop(sp.pendingRemovals)
    sp.pendingRemovalsAt = drop(sp.pendingRemovalsAt)
    sp.heldConfigs = drop(sp.heldConfigs)
    sp.heldRekeys = drop(sp.heldRekeys)
  })
  forgetCircleVouches(circleId)
  const at = nowSec()
  activity.recordActivity({ id: `member-left-${circleId}-${selfPk}-${at}`, at, kind: 'member-left', circleId, actorPk: selfPk, params: { name: c.name } })
}

/** Registers the structural queue's senders this module owns. Idempotent
 *  (a re-registration replaces the same function). */
export function registerStructuralSenders(): void {
  registerSender('config', async (signed, item) => {
    const c = store.load().circles.find((x) => x.id === item.circleId)
    if (!c) return
    await beacons.sendStructural(c, signed)
    // A config that removes its own signer is a leave (`leaveCircle`).
    const cfg = parseConfigV2(signed.content)
    if (cfg && cfg.by === signed.pubkey && !cfg.members.some((m) => m.pk === signed.pubkey)) forgetLeftCircle(c.id, signed.pubkey)
    else {
      rememberConfig(c.id, signed)
      const sent = store.load().circles.find((x) => x.id === c.id)
      if (sent) for (const h of configSentHandlers) h(sent)
    }
  })
  registerSender('rekey', (signed, item) => sendRekeyEvent(signed, item.circleId, item.seed))
  registerSender('invite', sendInvite)
  registerSender('vouch', async (signed, item) => {
    const c = store.load().circles.find((x) => x.id === item.circleId)
    if (!c) return
    await beacons.sendStructural(c, signed)
    acceptVouch(c.id, signed, nowSec()) // our own echo is skipped on receive
  })
}

/** A hook another domain module can register to learn "this circle gained a
 *  NEW member" — review fix round 1's replacement for the removed
 *  `t:'joined'` announce (see the module doc comment's "Roster healing"
 *  section): fired from `applyConfig` below, once per newly-added pk, only
 *  AFTER the structural config's authority has already been verified
 *  (beacons.ts's choke point, before this handler ever runs) — so, unlike
 *  the old announce, nothing here needs its own sender-binding check.
 *  Registration, not import, same "the module being extended exports the
 *  registration point" idiom as `beacons.ts`'s `setSignalHandler`/
 *  `registerPeriodicHook`. Multiple hooks may register (there's no reason a
 *  second future consumer couldn't also want this). */
export type MemberAddedHandler = (circle: Circle, memberPk: string) => void
const memberAddedHandlers: MemberAddedHandler[] = []
export function registerMemberAddedHandler(fn: MemberAddedHandler): void {
  if (!memberAddedHandlers.includes(fn)) memberAddedHandlers.push(fn)
}

/** Final review A, I6: `${circleId}:${unlink id}` of each held unlink
 *  re-posted this run. */
const postedUnlinks = new Set<string>()

/** Final review A, I6: re-posts the held unlinks between `circle`'s members
 *  into it (once per circle and unlink per run), so a member added by
 *  anyone learns the cut-off. */
function postHeldUnlinks(circle: Circle): void {
  for (const ev of unlinksBetween(new Set(circle.members.map((m) => m.pk)), MAX_BUNDLE_UNLINKS)) {
    const key = `${circle.id}:${ev.id}`
    if (postedUnlinks.has(key)) continue
    postedUnlinks.add(key)
    void beacons.postLink(circle, { unlink: ev }).catch(() => { postedUnlinks.delete(key) })
  }
}

/** Plan 2 (Task 7): fired after this device has posted its own config for a
 *  circle — the point at which a member it added locally reaches the other
 *  members' rosters (link-pairing.ts posts the guardian link then). */
export type ConfigSentHandler = (circle: Circle) => void
const configSentHandlers: ConfigSentHandler[] = []
export function registerConfigSentHandler(fn: ConfigSentHandler): void {
  if (!configSentHandlers.includes(fn)) configSentHandlers.push(fn)
}

/** Latest-wins config merge (covey `mergeConfig`'s rule, for v2): applied
 *  when newer, or as new with a lower writer pubkey. Returns `c` itself
 *  when it loses. */
function mergeConfigV2(c: Circle, cfg: ConfigV2): Circle {
  const wins = cfg.updatedAt > c.configUpdatedAt || (cfg.updatedAt === c.configUpdatedAt && cfg.by < c.configBy)
  if (!wins) return c
  return { ...c, name: cfg.name, members: cfg.members.map((m) => ({ ...m })), configUpdatedAt: cfg.updatedAt, configBy: cfg.by }
}

/** Applies an authorised structural config (the choke point has checked the
 *  envelope and authority). Latest-wins merge (`mergeConfigV2`), then
 *  tombstones: a removed member stays out unless this config re-admits them
 *  (controller ruling, Task 10 fix rounds 1 and 2) — which needs BOTH: this
 *  config's own signed `created_at` strictly after the removal's recorded
 *  time (never re-admitted merely by clock-independent means), AND its
 *  `prev` chained on or after the removal re-key's own seed (its writer had
 *  actually seen the re-key that removed them, not merely signed something
 *  dated later by coincidence or clock skew) — either alone is
 *  forgeable/spoofable by a writer who doesn't actually know about the
 *  removal; both together are the deliberate-re-admission signal.
 *
 *  Plan 2 (Task 5): once applied, each newly added member's vouch (the one
 *  the choke point judged it by, against the roster before) is stored as
 *  theirs; the other carried vouches only as `acceptVouch` allows (a config
 *  can't overwrite a live vouch); its `createdBy` is never adopted (fix
 *  round 1: only creation or the invite bundle sets a creator); a dropped
 *  member's vouchees still on the roster are marked unvouched; and a
 *  config dropping its own signer fires `onMemberLeft`. */
function applyConfig(circleId: string, rumor: Rumor): void {
  const cfg = parseConfigV2(rumor.content)
  if (!cfg || cfg.by !== rumor.pubkey) return
  // Final fix round 2, R1c: a far-future `updatedAt` would win latest-wins
  // forever, so one dated beyond the skew bound is refused on receipt.
  const now = nowSec()
  if (cfg.updatedAt > now + CONFIG_FUTURE_SKEW_SEC) return
  const prev = rumor.tags.find((t) => t[0] === 'prev')?.[1]
  const before = store.load().circles.find((x) => x.id === circleId)
  if (!before) return
  // The vouches the added members were judged by, against the roster before.
  const view = trustViewOf(before)
  const addedVouches = cfg.members
    .filter((m) => !before.members.some((x) => x.pk === m.pk))
    .map((m) => configVouchFor(view, circleId, cfg, m.pk, m.role, (pk) => heldVouches(circleId, pk)))
  let changed: Circle | undefined
  let addedPks: string[] = []
  let droppedPks: string[] = []
  store.update((sp) => {
    const idx = sp.circles.findIndex((x) => x.id === circleId)
    const c = idx >= 0 ? sp.circles[idx] : undefined
    if (!c || cfg.id !== c.id) return
    const merged = mergeConfigV2(c, cfg)
    if (merged === c) return // lost latest-wins
    const chain = sp.seedHashes[circleId] ?? [seedHash(c.seedHex)]
    const at = prev ? chain.indexOf(prev) : -1
    const removedPks: string[] = []
    const removals = { ...(c.removals ?? {}) }
    const out = new Set<string>()
    for (const pk of c.removedPks ?? []) {
      const r = removals[pk]
      // Receiver-side re-admission (controller ruling, Task 10 fix rounds 1
      // and 2): BOTH this config's own signed created_at after the removal
      // AND its prev chained on or after the removal re-key's seed — see
      // this function's own doc comment for why neither alone suffices.
      const readmit = merged.members.some((m) => m.pk === pk) && !!r && rumor.created_at > r.at
        && at >= 0 && at >= chain.indexOf(r.hash) && chain.indexOf(r.hash) >= 0
      if (readmit) { delete removals[pk]; continue }
      removedPks.push(pk)
      out.add(pk)
    }
    const next: store.StoredCircle = {
      ...merged,
      members: merged.members.filter((m) => !out.has(m.pk)),
      removedPks: removedPks.length ? removedPks : undefined,
      removals: Object.keys(removals).length ? removals : undefined,
    }
    const beforePks = new Set(c.members.map((m) => m.pk))
    addedPks = next.members.map((m) => m.pk).filter((pk) => !beforePks.has(pk))
    const after = new Set(next.members.map((m) => m.pk))
    droppedPks = c.members.map((m) => m.pk).filter((pk) => !after.has(pk))
    sp.circles[idx] = next
    changed = next
  })
  // Task 5 fix round 1: a received `createdBy` is never adopted — the
  // creator is set only at creation here or from the invite bundle.
  if (!changed) return
  const added = new Set(addedPks)
  for (const v of addedVouches) {
    if (!v || !added.has(v.pk)) continue
    // The vouch that put them on the roster is theirs, replacing any held
    // one (the member table holds members' vouches only); their pending
    // ones are done with.
    const held = vouchFor(circleId, v.pk)
    if (!held || held.event.id !== v.event.id) storeVouch(v, { supersede: !!held, nowSec: now })
    dropPendingVouches(circleId, v.pk)
  }
  // Final review A, I3: marked from the config's own signed time, clamped.
  rejudgeVouched(changed, new Set(droppedPks), Math.min(rumor.created_at, now))
  // Final review A, I1: a dropped member's vouch goes with them, and none
  // this config carries for them is kept.
  const dropped = new Set(droppedPks)
  for (const pk of droppedPks) dropVouch(circleId, pk)
  for (const ev of cfg.vouches) if (!dropped.has(verifyVouch(ev)?.pk ?? '')) acceptVouch(circleId, ev, now, false)
  // Final fix A9: a member this config dropped loses its phone bindings.
  for (const pk of droppedPks) forgetMember(circleId, pk)
  rescanBuffered(changed, now)
  beacons.onPhonesBound(circleId)
  for (const pk of addedPks) for (const h of memberAddedHandlers) h(changed, pk)
  if (addedPks.length) postHeldUnlinks(changed)
  // Our own identity left from another of our phones: this one leaves too.
  if (droppedPks.includes(cfg.by) && cfg.by === currentSession()?.identityPk) {
    forgetLeftCircle(circleId, cfg.by)
    return
  }
  if (droppedPks.includes(cfg.by)) {
    activity.recordActivity({ id: `member-left-${circleId}-${cfg.by}-${rumor.created_at}`, at: now, kind: 'member-left', circleId, actorPk: cfg.by, params: {} })
    for (const h of [...memberLeftHandlers]) {
      try { h(circleId, cfg.by, now) } catch { /* isolated */ }
    }
  }
}

function acceptPendingInvite(): void {
  const invite = pendingInvite
  if (!invite) return
  const self = currentSession()
  if (!self) return
  // Re-run the same gate handleIncomingInvite applied on receive (Task 10
  // fix round 2 finding 3) against FRESH state: local state can change
  // between an invite arriving and the user tapping Accept. Refused here
  // means the current local copy is left completely untouched — just an
  // accurate notice (Task 10 fix round 3 finding 2). Plan 2 (Task 6): the
  // contacts check and a dependant's guardian link are re-checked too.
  const existing = store.load().circles.find((c) => c.id === invite.circleId)
  const channel = self.dependant ? 'phone' : 'personal'
  const stillLinked = !self.dependant || linked(invite.from, self.identityPk)
  const heldCreator = creatorOf(invite.circleId)
  if (!invitePasses(invite, self, existing) || !inviteForUs(invite, self, channel) || !stillLinked
    || (heldCreator !== null && invite.creator !== null && heldCreator !== invite.creator)) {
    pendingInvite = null
    uiView = { kind: 'list', notice: 'This invite is out of date.' }
    store.notify()
    return
  }
  const fresh = circleFromInvite(
    { id: invite.circleId, s: invite.seedHex, n: invite.name },
    { pk: self.identityPk, role: invite.role, name: self.name },
    nowSec(),
  )
  // Plan 2 (Task 6): the roster is the bootstrap (`bootstrapRoster`), and
  // with a bundle config its clock is that config's, so an older config
  // replayed from the circle inbox can't roll the roster back. Without one
  // the clock stays zeroed: this roster never wins a merge or gets
  // broadcast — local gate seed data only, the inviter a `peer` (final fix
  // A8: the invite alone doesn't prove the inviter's role).
  const clocked = invite.config ? { ...fresh, configUpdatedAt: invite.config.updatedAt, configBy: invite.config.by } : resetConfigClock(fresh)
  // Final review A, I2: the bundle re-key's removals are ours too, so our
  // own re-keys carry them on (removal sets are cumulative).
  const tombPks = Object.keys(invite.tombs).sort()
  const circle: store.StoredCircle = {
    ...clocked,
    members: invite.roster.map((m) => ({ ...m })),
    ...(tombPks.length ? { removedPks: tombPks, removals: { ...invite.tombs } } : {}),
    // The join time IS the invite's own signed created_at (Task 10 fix
    // round 3), not "now": the epoch this invite carries started being
    // valid roughly when the inviter signed it, not when we happened to
    // tap Accept. Clamped to `nowSec()` (Task 10 fix round 4): a
    // future-dated invite (clock skew, or a hostile inviter) must never
    // push the epoch start into the future — that would let a later,
    // legitimately-dated re-invite for the SAME epoch get rejected by the
    // date gate above (`invite.createdAt <= existing.epochStartedAt`) as if
    // it predated an epoch that, from our own clock, hasn't started yet.
    epochStartedAt: Math.min(invite.createdAt, nowSec()),
  }
  pendingInvite = null
  store.update((sp) => {
    saveJoinedCircle(sp, circle)
    // Task 6 fix round 1: the verified bundle re-key installed the seed we
    // just joined on; hold it so our own invites carry it on.
    const rk = invite.rekeyEvent
    if (rk) Object.defineProperty(sp.heldRekeys, circle.id, { value: rk, enumerable: true, writable: true, configurable: true })
  })
  // The joiner's trust state is the bundle's: whatever an old copy of this
  // circle left behind goes, then the creator (only ever set here or at
  // creation), the vouches that put each member on the roster, and the
  // config the roster came from (for our own invites later).
  const joinNow = nowSec()
  forgetCircleVouches(circle.id)
  const creator = heldCreator ?? invite.creator
  if (creator) setCreator(circle.id, creator)
  for (const v of invite.vouches) storeVouch(v, { nowSec: joinNow })
  for (const v of invite.handOvers) storePendingVouch(v, { nowSec: joinNow })
  if (invite.config) rememberConfig(circle.id, invite.config.event)
  // Binds the inviter's own device statement (carried alongside the invite —
  // see `parseIncomingInvite`) into this circle's phone-key table: they're
  // already on the roster above (the trust anchor just seeded), so this
  // resolves immediately rather than buffering. `invite.phonePk` is the
  // wrap's own seal signer, already checked to equal the statement's `p`.
  acceptStatement(circle, invite.statement, invite.phonePk, nowSec())
  // Task 12 fix round 2, finding 1c: also bind our OWN statement right
  // away, local-state only — same reasoning as `createCircleNow`'s own
  // call. `beacons.postStatement` below binds it too (its own
  // `acceptStatement` call runs synchronously before its first network
  // await), so this is redundant on the happy path but not dependent on
  // that ordering.
  bindOwnStatement(circle)
  // Records this device's own action of joining. The writer learns of it
  // (and adds this device to a fresh config) via the identity-signed invite/
  // config path itself — see the module doc comment's "Roster healing"
  // section for why the old `joined` announce this used to pair with is
  // gone.
  const at = nowSec()
  activity.recordActivity({ id: `local-member-joined-${circle.id}-${self.identityPk}-${at}`, at, kind: 'member-joined', circleId: circle.id, actorPk: self.identityPk, params: {} })
  // Posts our own statement into the new circle — a no-op until this
  // session actually holds one (Task 11); safe to call regardless.
  void beacons.postStatement(circle).catch(() => { /* offline — refreshStatements retries */ })
}

function declinePendingInvite(): void {
  pendingInvite = null
  store.notify()
}

// ---------------------------------------------------------------------------
// Config broadcast — after every create/join/membership change
// ---------------------------------------------------------------------------

/** Public entry point for app.ts's onboarding flow (the family-circle
 *  creation path): queues the new circle's config as an identity-signed
 *  structural event, posted on the circle inbox once signed. A member who
 *  joins later still receives it (the circle-inbox subscription replays the
 *  wrap backlog). The extra parameters are ignored — kept until Task 11
 *  rewrites the onboarding caller. */
export async function broadcastCreatedCircleConfig(_p: store.Persisted, circle: Circle, _fam?: unknown): Promise<void> {
  enqueueConfig(circle)
}

/** Registered with beacons.ts (from `ensure()` above) as an ADDITIONAL
 *  handler for non-beacon circle-inbox signals, alongside agreements.ts's
 *  and approvals.ts's own — see beacons.ts's `setSignalHandler` doc comment.
 *  Review fix round 1: the old `t:'joined'` branch (an unauthenticated
 *  self-announcement) is gone — see the module doc comment's "Roster
 *  healing" section for why; membership changes reach every handler solely
 *  through the identity-signed, guardian-authorised structural `config`. */
export function handleIncomingSignal(circle: Circle, rumor: Rumor, t: string, sender?: beacons.Sender): void {
  if (t === 'config' && sender?.structural) applyConfig(circle.id, rumor)
}

// ---------------------------------------------------------------------------
// Create / invite / remove flows
// ---------------------------------------------------------------------------

function submitNewCircleName(): void {
  if (uiView.kind !== 'new-name') return
  const name = inputValue('circle-name')
  if (!name) {
    uiView = { kind: 'new-name', error: 'Enter a name for this circle.' }
    store.notify()
    return
  }
  const p = store.load()
  const self = currentSession()
  if (!self) return
  if (self.dependant) {
    // v1 simplification (same "always the first circle" idiom app.ts's map
    // tab already documents): the policy governing "may this child start a
    // brand-new circle" lives on the family circle they already belong to —
    // the one circle guaranteed to exist before a create-circle action could
    // even be asked for. No circle at all means there's nowhere to route
    // the ask, so it fails closed (deny) rather than silently allowing.
    const governing = p.circles[0]
    const verdict = governing ? checkPolicy(governing.id, 'create-circle') : 'deny'
    if (verdict === 'deny') {
      uiView = { kind: 'new-name', error: "Your family's settings don't allow creating a new circle." }
      store.notify()
      return
    }
    if (verdict === 'prompt') {
      if (governing) void approvals.raiseApproval(governing.id, 'create-circle', { name })
      formState.clearField('circle-name') // asked for: the field starts afresh
      uiView = { kind: 'new-name', notice: "Waiting for a parent to approve — you'll land on the invite screen once they do." }
      store.notify()
      return
    }
  }
  formState.clearField('circle-name') // created: the field starts afresh
  createCircleNow(name)
}

/** The actual circle-creation step, shared by the immediate-allow path above
 *  and approvals.ts's redo-on-approval handler (registered in
 *  `registerApprovalActions`) — the latter runs with NO further policy
 *  check, since the request that got it here has already been granted.
 *  Exported for regression testing (see circles.test.ts's createCircleNow
 *  coverage). Returns the new circle's id (plan 2, Task 7: pairing creates
 *  a family circle on the spot), or null when signed out. */
export function createCircleNow(name: string): string | null {
  const self = currentSession()
  if (!self) return null
  const { circle } = newCircle(name, { pk: self.identityPk, role: roleFor(self.dependant ? 'child' : 'parent'), name: self.name }, nowSec())
  store.update((sp) => { saveNewCircle(sp, circle) })
  setCreator(circle.id, self.identityPk)
  // Plan 2 (Task 6): the first config is signed now, so the first invite's
  // bundle carries one — a joiner bootstraps its roster (and learns the
  // creator) from it, and without it would hold the creator as a peer.
  registerStructuralSenders()
  enqueueConfig(circle)
  // Task 12 fix round 2, finding 1c (root cause): bind our own device
  // statement into this brand-new circle's phone-key table right away,
  // local-state only — see phone-keys.ts's `ownerOf` and this module's
  // `bindOwnStatement` for why an unbound creator's phone was the gap a
  // circle member could exploit to force a sign-out.
  bindOwnStatement(circle)
  uiView = { kind: 'invite', circleId: circle.id }
  store.notify()
  return circle.id
}

/** Binds this device's own signed statement into `circle`'s phone-key
 *  table, local-state only (no network) — a no-op until the session
 *  actually holds one (same guard `beacons.postStatement` uses). Task 12
 *  fix round 2, finding 1c: called right after a circle is created or
 *  joined so this device's own phone is never left unbound waiting on a
 *  network post (up to 24h away via `refreshStatements`) — see
 *  phone-keys.ts's `ownerOf` doc comment for why an unbound own phone was
 *  a security gap (another member's revocation of it read as "unknown" and
 *  was accepted). `beacons.postStatement` also binds it, redundantly but
 *  harmlessly (`acceptStatement` is idempotent) — this covers the local
 *  table even when that call hasn't run yet or fails offline. */
function bindOwnStatement(circle: Circle): void {
  const self = currentSession()
  if (!self?.statement) return
  acceptStatement(circle, self.statement, self.phonePk, nowSec())
}

function setInviteNotice(circleId: string, notice: string): void {
  if (uiView.kind === 'invite' && uiView.circleId === circleId) uiView = { ...uiView, notice }
  store.notify()
}

/** Sends an invite and records the invitee locally. Exported for regression
 *  testing (see circles.test.ts's concurrent-invite coverage). Plan 2
 *  (Task 6): a dependant session may invite too (one guardian tap, via the
 *  queue as usual) — only a usable contact (`enqueueInvite`). */
export async function inviteToCircle(circleId: string, recipientPk: string): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle) return
  if (recipientPk === self.identityPk) { setInviteNotice(circleId, "That's your own key."); return }
  if (circle.members.some((m) => m.pk === recipientPk)) { setInviteNotice(circleId, 'Already a member.'); return }
  await doInvite(circle, self, recipientPk)
}

/** Plan 2 (Task 6): the refusal for a recipient who isn't a usable contact. */
export const NOT_MET_REFUSAL = 'Only people you have met can be added.'

/** Final fix A5: why a dependant's phone can't be re-invited by itself —
 *  a dependant rejoins through a linked guardian, by pairing again in
 *  person (plan 2, Task 7: link-pairing.ts). */
export const DEPENDANT_REJOIN_REFUSAL = 'A dependant rejoins through their parent — pair their phone again in person.'

/** Final fix A5 (controller ruling): re-sends a normal invite (the queued
 *  `invite` path, final fix A2) for `circleId` to `memberPk`'s personal
 *  inbox — an identity ALREADY on the roster, including our own (our other
 *  or new phone) — WITHOUT any roster change. A fresh device of that
 *  identity with no copy of the circle accepts it through the normal
 *  accept flow and posts its own statement there; the roster arrives in
 *  the invite bundle's config and in our own identity's config, sent right
 *  after the invite (final fix round 2, R1a — `sendInvite`). Returns null
 *  once queued, or the reason it was refused. Plan 2 (Task 6): a dependant
 *  member is re-invited through `inviteDependantToCircle` when we are their
 *  linked guardian; otherwise, and for a dependant session, it is refused. */
export function resendInvite(circleId: string, memberPk: string): string | null {
  const self = currentSession()
  if (!self) return 'Sign in first.'
  if (self.dependant) return DEPENDANT_REJOIN_REFUSAL
  const circle = store.load().circles.find((c) => c.id === circleId)
  if (!circle) return 'That circle is no longer on this phone.'
  const member = circle.members.find((m) => m.pk === memberPk)
  if (!member) return 'Not a member of this circle.'
  if (member.role === 'child') {
    if (!linked(self.identityPk, memberPk)) return DEPENDANT_REJOIN_REFUSAL
    const refused = queueDependantInvite(circle, self, memberPk)
    if (!refused) void drain()
    return refused
  }
  return enqueueInvite(circle, self, memberPk, member.role, member.name)
}

/** Final fix A5: invites our own identity (our other or new phone) into
 *  every circle we're on — `resendInvite(c.id, self.identityPk)` for each.
 *  Returns null if at least one was queued, else the reason none was. */
export function inviteMyOtherPhone(): string | null {
  const self = currentSession()
  if (!self) return 'Sign in first.'
  if (self.dependant) return DEPENDANT_REJOIN_REFUSAL
  const mine = store.load().circles.filter((c) => c.members.some((m) => m.pk === self.identityPk))
  if (!mine.length) return "You're not in any circles yet."
  let firstRefusal: string | null = null
  let queued = 0
  for (const c of mine) {
    const refused = resendInvite(c.id, self.identityPk)
    if (refused) firstRefusal ??= refused
    else queued++
  }
  return queued ? null : firstRefusal
}

/** A display name for `pk`: the contacts grant's, else the name any held
 *  roster gives it, else a short npub. */
function nameOf(pk: string): string {
  const fromContacts = contactTier(snapshot(), pk).name
  if (fromContacts) return fromContacts
  for (const c of store.load().circles) {
    const n = c.members.find((m) => m.pk === pk)?.name
    if (n) return n
  }
  return shortNpub(pk)
}

/** Plan 2 (Task 6): queues a `child` invite of our linked dependant into
 *  `circle` (null once queued, else why not). Guardian only: an adult
 *  session linked with `dependantPk`, and a member of the circle. */
function queueDependantInvite(circle: Circle, self: SessionInfo, dependantPk: string): string | null {
  if (self.dependant || !linked(self.identityPk, dependantPk)) return 'Only a linked guardian can add their dependant.'
  if (!circle.members.some((m) => m.pk === self.identityPk)) return 'Not a member of this circle.'
  return enqueueInvite(circle, self, dependantPk, 'child', nameOf(dependantPk))
}

/** Plan 2 (Task 6): adds our linked dependant to `circleId` — a `child`
 *  invite through the queue; `sendInvite` wraps the bundle to every
 *  non-revoked phone key of the dependant (their phone inboxes), never a
 *  personal inbox (a dependant has none). */
export async function inviteDependantToCircle(circleId: string, dependantPk: string): Promise<void> {
  const self = currentSession()
  const circle = store.load().circles.find((c) => c.id === circleId)
  if (!self || !circle) return
  const refused = queueDependantInvite(circle, self, dependantPk)
  if (refused) { setInviteNotice(circleId, refused); return }
  setInviteNotice(circleId, `Invite queued — ${waitingCopy()}.`)
  await drain()
}

/** Plan 2 (Task 7 rejoin): queues a `child` invite of our linked dependant
 *  into every circle both of us are on. Returns how many were queued. */
export function reinviteDependantEverywhere(dependantPk: string): number {
  const self = currentSession()
  if (!self) return 0
  let queued = 0
  for (const c of store.load().circles) {
    if (!c.members.some((m) => m.pk === self.identityPk) || !c.members.some((m) => m.pk === dependantPk)) continue
    if (queueDependantInvite(c, self, dependantPk) === null) queued++
  }
  if (queued) void drain()
  return queued
}

/** The notice for an invite refused (or dropped) by a fresh tombstone. */
const REINVITE_TOO_SOON = "Can't re-invite right now — try again shortly."

/** Pre-flight for an invite and, if it passes, queues it (final fix A2):
 *  returns null once queued, or the notice explaining why not. Checks run
 *  BEFORE anything is queued (Task 10 fix round 1, finding 5): a missing
 *  device statement (sign-in hasn't finished issuing one) is not a
 *  connection problem; plan 2 (Task 6): a new recipient must be a usable
 *  contact (kin, kith or a guardian link — `NOT_MET_REFUSAL`; an existing
 *  member or our own identity is a re-invite and needs no check); and a
 *  stale local re-admission (the recipient is tombstoned by a removal
 *  recorded at or after "now") must not put a wire invite on the relay the
 *  recipient could accept while this device would still refuse to locally
 *  re-admit them. The sender re-checks the tombstone against the signed
 *  invite's own `created_at`.
 *
 *  The queued payload is the inner invite `{ id, name, mode, pk, role,
 *  memberName? }` — what the identity signer signs, and the adder's vouch
 *  (plan 2). No seed (final fix A3). */
function enqueueInvite(circle: Circle, self: SessionInfo, recipientPk: string, role: Role = 'peer', memberName?: string): string | null {
  if (!self.statement) return 'Finish signing in first.'
  const reinvite = recipientPk === self.identityPk || circle.members.some((m) => m.pk === recipientPk)
  if (!reinvite && !usable(snapshot(), recipientPk, linkedWithMe(self.identityPk))) return NOT_MET_REFUSAL
  const preTomb = store.load().circles.find((c) => c.id === circle.id)?.removals?.[recipientPk]
  if (preTomb && nowSec() <= preTomb.at) return REINVITE_TOO_SOON
  // The invite needs its sender; `ensure()` registers it at startup, and
  // registering again is idempotent.
  registerStructuralSenders()
  const name = memberName ?? contactTier(snapshot(), recipientPk).name
  const label = recipientPk === self.identityPk
    ? `Invite your other phone to ${circle.name}`
    : role === 'child' ? `Add ${name ?? shortNpub(recipientPk)} to ${circle.name}` : `Invite ${name ?? shortNpub(recipientPk)} to ${circle.name}`
  enqueue({
    action: 'invite',
    circleId: circle.id,
    payload: JSON.stringify({ id: circle.id, name: circle.name, mode: 'family', pk: recipientPk, role, ...(name ? { memberName: name } : {}) }),
    label,
    recipientPk,
  })
  return null
}

/** The actual invite step, shared by the immediate-allow path above and
 *  approvals.ts's redo-on-approval handler (`reRunAddMember`) — the latter
 *  runs with NO further policy check (see `createCircleNow`'s doc comment
 *  for why).
 *
 *  Final fix A2: the invite goes through the structural queue (like every
 *  other identity-signed action), so an asleep or slow My Signet — or a
 *  guardian taking minutes to approve — leaves it waiting instead of
 *  failing. `sendInvite` (the queue's `invite` sender) does the wrap and
 *  the local roster change once it is signed. Resolves once the queue has
 *  done what it can for now. */
async function doInvite(circle: Circle, self: SessionInfo, recipientPk: string): Promise<void> {
  const refused = enqueueInvite(circle, self, recipientPk)
  if (refused) { setInviteNotice(circle.id, refused); return }
  setInviteNotice(circle.id, `Invite queued — ${waitingCopy()}.`)
  await drain()
  const waiting = pending().some((q) => q.action === 'invite' && q.circleId === circle.id && q.recipientPk === recipientPk)
  const dropped = uiView.kind === 'invite' && uiView.notice === REINVITE_TOO_SOON
  if (!waiting && !dropped) setInviteNotice(circle.id, 'Invite sent.')
}

/** The non-revoked phone keys we know for `identityPk`: bound in any
 *  circle's phone-key table, or buffered there (a statement proven by its
 *  own phone's seal, for someone not on that roster yet — Task 7's pairing
 *  leaves the dependant's this way). */
function knownPhonesOf(identityPk: string): string[] {
  const p = store.load()
  const out = new Set<string>()
  for (const c of p.circles) for (const ph of phonesOf(c.id, identityPk)) out.add(ph)
  for (const e of p.pendingStatements) {
    const st = verifyDeviceStatement(e.event)
    if (st && st.identityPk === identityPk && !p.revokedPhoneKeys[st.phonePk]) out.add(st.phonePk)
  }
  return [...out]
}

/** The guardian-link pairs a bundle for `circle` carries: every pair held
 *  between its members, and, for a dependant invitee, the pair joining the
 *  adder to them. */
function bundleLinks(circle: Circle, adderPk: string, inviteePk: string, role: Role): Array<{ g: SignedEvent; d: SignedEvent }> {
  const pks = circle.members.map((m) => m.pk)
  const out: Array<{ g: SignedEvent; d: SignedEvent }> = []
  const seen = new Set<string>()
  const add = (g: string, d: string): void => {
    const key = `${g}:${d}`
    if (seen.has(key)) return
    const pair = linkEvents(g, d)
    if (pair) { seen.add(key); out.push({ g: pair.g, d: pair.d }) }
  }
  if (role === 'child') add(adderPk, inviteePk)
  for (const g of pks) for (const d of pks) if (g !== d) add(g, d)
  return out.slice(0, MAX_BUNDLE_LINKS)
}

/** The structural queue's sender for `invite` (final fix A2). Identity-
 *  signed invite (Signet identity plan, Task 10): the signed inner event is
 *  gift-wrapped, sealed by this device's own fast, local `phoneSigner()`,
 *  never the remote signer, as an `InviteBundle` (plan 2, Task 6): with
 *  this device's own device statement (so the recipient can bind the
 *  sealing phone to the inviting identity — see `parseIncomingInvite`), the
 *  seed it was signed against (final fix A3), the newest config held for
 *  the circle and the guardian links between its members. An adult's goes
 *  to their personal inbox; a dependant's (`role: 'child'`) to each of
 *  their known phone keys' own inboxes. Then, for a recipient not already
 *  on the roster: the signed invite is posted into the circle as
 *  `t:'vouch-post'` (members hold the vouch before the config arrives), the
 *  invitee is added locally at the invite's role with that vouch, and the
 *  config follows (`enqueueConfig`). A recipient already on the roster (a
 *  re-invite of an existing member's identity, final fix A5) changes
 *  nothing locally; it is followed by our own identity's config (final fix
 *  round 2, R1a). Dropped (never sent) if the recipient's tombstone is at
 *  or after the signed invite; re-queued on the current seed if the circle
 *  was re-keyed since it was signed. */
async function sendInvite(signed: SignedEvent, item: store.QueuedAction): Promise<void> {
  const ev = verifyStructural(signed)
  const c = store.load().circles.find((x) => x.id === item.circleId)
  const self = currentSession()
  const recipientPk = item.recipientPk
  if (!ev || ev.action !== 'invite' || !c || !self?.statement || !recipientPk) return
  const inner = parseInviteInner(ev.payload)
  if (!inner || inner.pk !== recipientPk) return
  const tomb = c.removals?.[recipientPk]
  // Final fix round 2, R3: say so, or doInvite would report it sent.
  if (tomb && signed.created_at <= tomb.at) { setInviteNotice(c.id, REINVITE_TOO_SOON); return }
  if (ev.prev !== seedHash(c.seedHex)) {
    // Signed against a seed since replaced: its seed is gone and the
    // invitee would join a dead epoch. Queue a fresh one on the current seed.
    enqueueInvite(c, self, recipientPk, inner.role, inner.memberName)
    return
  }
  const bundle: InviteBundle = {
    invite: signed, statement: self.statement, seed: c.seedHex,
    config: heldConfig(c.id), links: bundleLinks(c, self.identityPk, recipientPk, inner.role),
    rekey: heldRekey(c.id),
    // Final review A, I5: our vouches for the members, which the held
    // config may predate (a voucher left, hand-overs followed) — the
    // original invites first, then (final fix N1) the hand-overs by
    // members.
    vouches: [
      ...allVouches(c.id).filter((ev) => { const v = verifyVouch(ev); return !!v && c.members.some((m) => m.pk === v.pk) }),
      ...allHandOvers(c.id).filter((v) => c.members.some((m) => m.pk === v.pk) && c.members.some((m) => m.pk === v.by)).map((v) => v.event),
    ].slice(0, MAX_BUNDLE_VOUCHES),
    // Final review A, I6: and the unlinks between them.
    unlinks: unlinksBetween(new Set([...c.members.map((m) => m.pk), recipientPk]), MAX_BUNDLE_UNLINKS),
  }
  const rumor = { kind: 14, content: JSON.stringify(bundle), tags: [] }
  const relays = appRelays(store.load())
  if (inner.role === 'child') {
    const phones = knownPhonesOf(recipientPk)
    if (!phones.length) { setInviteNotice(c.id, 'No phone of theirs is known here yet.'); return }
    for (const ph of phones) await publish(relays, await giftWrap(phoneSigner(), ph, rumor, personalInboxTag(ph)))
  } else {
    await publish(relays, await giftWrap(phoneSigner(), recipientPk, rumor, personalInboxTag(recipientPk)))
  }
  // A new member: the vouch goes into the circle before the config.
  const fresh0 = store.load().circles.find((x) => x.id === item.circleId)
  if (fresh0 && !fresh0.members.some((m) => m.pk === recipientPk)) await beacons.postVouch(fresh0, signed)
  // The invitee is recorded locally at the role the signed invite names.
  // The mutation runs against FRESH state inside store.update()'s callback
  // — another change (a concurrent invite, a removal, a config sync) may
  // have landed since `c` was read (lost-update race).
  let updated: Circle | undefined
  let reinvited: Circle | undefined
  store.update((sp) => {
    const idx = sp.circles.findIndex((x) => x.id === item.circleId)
    const fresh = idx >= 0 ? sp.circles[idx] : undefined
    if (!fresh) return
    if (fresh.members.some((m) => m.pk === recipientPk)) { reinvited = fresh; return }
    // An explicit invite is a deliberate re-admission: lift any local
    // eviction tombstone — but only if THIS invite is dated after the
    // removal it would lift (controller ruling). This re-check only catches
    // a tombstone landing between the check above and this commit; the wire
    // invite has already gone out by then, so only the local re-admission
    // is skipped.
    const freshTomb = fresh.removals?.[recipientPk]
    if (freshTomb && signed.created_at <= freshTomb.at) return
    let removedPks = fresh.removedPks
    let removals = fresh.removals
    if (removedPks?.includes(recipientPk)) removedPks = removedPks.filter((x) => x !== recipientPk)
    if (removals && recipientPk in removals) {
      const { [recipientPk]: _gone, ...rest } = removals
      removals = rest
    }
    const unTombstoned: store.StoredCircle = {
      ...fresh,
      removedPks: removedPks?.length ? removedPks : undefined,
      removals: removals && Object.keys(removals).length ? removals : undefined,
    }
    updated = addLocalMember(unTombstoned, { pk: recipientPk, role: inner.role, ...(inner.memberName ? { name: inner.memberName } : {}) }, self.identityPk, nowSec())
    sp.circles[idx] = updated
  })
  if (updated) {
    // Our own vouch for them is theirs (Task 5 left it to Task 6 to promote
    // it on the local add), so the config carries it.
    if (acceptVouch(updated.id, signed, nowSec(), false)) dropPendingVouches(updated.id, recipientPk)
    enqueueConfig(updated)
    postHeldUnlinks(updated)
  }
  // Final fix round 2, R1a: a re-invite of an identity already on the
  // roster (resendInvite / inviteMyOtherPhone) is followed by our own
  // identity's config, so the new phone — whose placeholder trusts only
  // its inviter — gets the real roster at once. Same roster and config
  // clock as ours (it never out-dates a newer config elsewhere); only the
  // writer is us, as the choke point requires. Not sent while our own copy
  // is still an unconfigured placeholder.
  if (reinvited && reinvited.configBy !== '') enqueueConfig({ ...reinvited, configBy: self.identityPk })
}

const HEX64_RE = /^[0-9a-f]{64}$/i

/** Decodes a pasted pubkey — either an `npub1…` (NIP-19) or raw 64-char hex —
 *  into lowercase hex. Returns null for anything else (garbage paste, an
 *  nsec/nprofile/other NIP-19 type, wrong length). Pure; unit-tested
 *  directly. Moved here from the now-deleted contacts.ts (Signet identity
 *  plan, Task 11) — this invite-by-pubkey form is its only remaining caller. */
export function decodePubkeyInput(raw: string): string | null {
  const trimmed = raw.trim()
  if (HEX64_RE.test(trimmed)) return trimmed.toLowerCase()
  if (trimmed.startsWith('npub1')) {
    try {
      const decoded = nip19Decode(trimmed)
      return decoded.type === 'npub' ? decoded.data : null
    } catch {
      return null
    }
  }
  return null
}

function submitNpubInvite(circleId: string): void {
  if (uiView.kind !== 'invite') return
  const raw = inputValue('circle-invite-npub')
  const pk = decodePubkeyInput(raw)
  if (!pk) {
    uiView = { ...uiView, npubError: 'Enter a valid npub or 64-character hex pubkey.' }
    store.notify()
    return
  }
  uiView = { ...uiView, npubError: undefined }
  formState.clearField('circle-invite-npub') // sent: the field starts afresh
  store.notify()
  void inviteToCircle(circleId, pk)
}

/** approvals.ts's redo-on-approval handler for `add-member`: re-runs
 *  `doInvite` for the original (now approved) attempt's recipient — stashed
 *  in the approval request's own `params` (see `inviteToCircle`'s
 *  `raiseApproval` call). A circle that's vanished, or a session that's
 *  signed out, in the meantime is a silent no-op — same discipline every
 *  other "resume later" path in this app already follows. */
function reRunAddMember(params: Record<string, string>): void {
  const circleId = params.circleId
  if (!circleId || !params.pk) return
  const self = currentSession()
  const circle = store.load().circles.find((c) => c.id === circleId)
  if (!self || !circle) return
  void doInvite(circle, self, params.pk)
}

/** Removes a member by re-keying the circle without them (spec 3 §5): a
 *  fresh seed goes only to the phone keys of the members who stay, and the
 *  removal is carried in the re-key's cumulative removal set, applied by
 *  every receiver (and this device) when the re-key lands. Plan 2 (Task 5):
 *  allowed whenever the authority table lets us remove them (`mayRemove`:
 *  a guardian, their voucher, or anyone after the unvouched grace); leaving
 *  is `leaveCircle`. */
export async function removeMemberFromCircle(circleId: string, pk: string): Promise<void> {
  const self = currentSession()
  const circle = store.load().circles.find((c) => c.id === circleId)
  if (!self || !circle || !circle.members.some((m) => m.pk === self.identityPk)) return
  if (pk === self.identityPk || !circle.members.some((m) => m.pk === pk)) return
  if (!mayRemove(trustViewOf(circle), self.identityPk, pk, nowSec())) return
  // Final review B, minor 8: a double tap (or a second drop signal) before
  // the re-key applies must not queue a second one.
  if (removalPending(circleId, pk)) return
  // The `member-removed` Activity entry is recorded when a re-key carrying
  // this removal is applied (`applyRekey`), not here.
  await sendRekey(circle, [pk])
}

function inputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? ''
}

// ---------------------------------------------------------------------------
// Action dispatch — app.ts delegates every `circle-*` data-action here.
// ---------------------------------------------------------------------------

export function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'circle-check-inbox':
      void checkDeferredNow()
      break
    case 'circle-new':
      uiView = { kind: 'new-name' }
      store.notify()
      break
    case 'circle-cancel':
      uiView = { kind: 'list' }
      store.notify()
      break
    case 'circle-create-submit':
      submitNewCircleName()
      break
    case 'circle-invite-open':
      uiView = { kind: 'invite', circleId: node.dataset.circle ?? '' }
      store.notify()
      break
    case 'circle-invite-contact':
      void inviteToCircle(node.dataset.circle ?? '', node.dataset.pk ?? '')
      break
    case 'circle-invite-npub-submit':
      submitNpubInvite(node.dataset.circle ?? '')
      break
    case 'circle-invite-dependant':
      void inviteDependantToCircle(node.dataset.circle ?? '', node.dataset.pk ?? '')
      break
    case 'circle-meet-in-person': {
      // Plan decision 9 (Task 10): a NIP-55 session brings the signer app
      // to the foreground directly; every other transport keeps the plain
      // text hint (`MEET_IN_PERSON_HINT`).
      const self = currentSession()
      if (!self || !launchSignerApp(self)) setInviteNotice(node.dataset.circle ?? '', MEET_IN_PERSON_HINT)
      break
    }
    case 'circle-invite-done':
      uiView = { kind: 'list' }
      store.notify()
      break
    case 'circle-remove-member': {
      const circleId = node.dataset.circle ?? ''
      const pk = node.dataset.pk ?? ''
      if (circleId && pk) { confirmingRemoval = { circleId, pk }; store.notify() }
      break
    }
    case 'circle-remove-member-cancel':
      confirmingRemoval = null
      store.notify()
      break
    case 'circle-remove-member-confirm': {
      const circleId = node.dataset.circle ?? ''
      const pk = node.dataset.pk ?? ''
      confirmingRemoval = null
      store.notify()
      if (circleId && pk) void removeMemberFromCircle(circleId, pk)
      break
    }
    case 'circle-leave':
      void leaveCircle(node.dataset.circle ?? '')
      break
    case 'circle-resend-invite': {
      const circleId = node.dataset.circle ?? ''
      const pk = node.dataset.pk ?? ''
      const refused = resendInvite(circleId, pk)
      const key = `${circleId}:${pk}`
      if (refused) resendStatus.set(key, refused)
      else resendStatus.delete(key)
      store.notify()
      break
    }
    case 'circle-accept':
      acceptPendingInvite()
      break
    case 'circle-decline':
      declinePendingInvite()
      break
    default:
      break
  }
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export function view(p: store.Persisted): string {
  if (pendingInvite) return acceptView(pendingInvite)
  const self = currentSession()
  if (!self) return '<p class="muted">Sign in to see your circles.</p>'
  switch (uiView.kind) {
    case 'list': return listView(p, self, uiView)
    case 'new-name': return newNameView(uiView)
    case 'invite': return inviteView(p, uiView)
  }
}

function listView(p: store.Persisted, self: SessionInfo, step: Extract<View, { kind: 'list' }>): string {
  const items = p.circles.map((c) => circleItemView(p, c, self)).join('')
  const notice = step.notice ? `<p class="muted">${esc(step.notice)}</p>` : ''
  return `
    <section class="contact-group">
      <h2>Circles</h2>
      ${notice}
      ${items || '<p class="muted">No circles yet.</p>'}
    </section>
    <button type="button" data-action="circle-new">New circle</button>
  `
}

function circleItemView(p: store.Persisted, c: Circle, self: SessionInfo): string {
  const role = selfRole(c, self.identityPk)
  // Phase 6 Task 3 (design spec §3): the wizard's re-runnable entry point is
  // gated on plain guardianship — any guardian device can open the wizard
  // for a child it shares a circle with, same reasoning as
  // `messageBtn`/`viewBtn` below never gating on it either.
  const viewerIsGuardian = isGuardian(c, self.identityPk)
  // Plan 2 (Task 10): the "Remove" button is gated on the full authority
  // table (`mayRemove`), not plain guardianship — a voucher, or anyone once
  // their vouchee's been unvouched past the grace, can remove too. Computed
  // once per circle (not per member row).
  const view = trustViewFor(c.id)
  const members = c.members.map((m) => memberItemView(p, c, m, self, view, viewerIsGuardian)).join('')
  // Plan 2 (Task 6): any member may add people (spec §3).
  const inviteBtn = role !== undefined
    ? `<button type="button" data-action="circle-invite-open" data-circle="${esc(c.id)}">Invite members</button>`
    : ''
  // Circle chat (Task 5, brief §23.4: "group conversations live in the
  // relevant Circle page") — messages.ts owns the actual thread/composer;
  // this is just the entry point + unread badge.
  const chatUnread = messages.unreadForCircle(p, c.id, self.identityPk)
  // Pickup lifecycle cards (Phase 4 Task 6, brief §17.2-17.3, §30) —
  // circle-wide visibility (every member's device holds its own copy of a
  // record, see pickup.ts's own module doc comment); `actionsFor` (inside
  // `sectionView`) already restricts the rendered buttons to the record's
  // two actual parties, so a bystander guardian simply sees a read-only
  // timeline here, never a wrong control.
  const pickupCards = pickup.sectionView(p, pickup.cardsForCircle(p, c.id), self.identityPk, role === 'guardian' ? 'guardian' : 'child')
  return `
    <div>
      <div class="contact-item"><strong>${esc(c.name)}</strong><span class="badge">${esc(role ?? 'member')}</span></div>
      <ul class="contact-list">${members}</ul>
      ${inviteBtn}
      <button type="button" data-action="msg-open-circle" data-circle="${esc(c.id)}">Circle chat${messages.unreadBadgeHtml(chatUnread)}</button>
      ${pickupCards}
    </div>`
}

function memberItemView(p: store.Persisted, c: Circle, m: CircleMember, self: SessionInfo, view: TrustView, viewerIsGuardian: boolean): string {
  const selfPk = self.identityPk
  const label = m.pk === selfPk ? 'You' : esc(m.name || shortNpub(m.pk))
  // Plan 2 (Task 5/10): the authority table, not plain guardianship — a
  // voucher, or (past the unvouched grace) anyone — may remove someone
  // else. `mayRemove` is also true for `pk === selfPk` (leaving counts as a
  // removal authority-wise) — excluded here since that's `leaveBtn` below,
  // and `removeMemberFromCircle` itself refuses a self-target anyway.
  // Final fix (mis-tap during testing): a mid-confirm row shows the same
  // "armed inline block, own Cancel button" shape as devices.ts's
  // `signOutView` — "Remove"/"Cancel", never the two-tap same-button-
  // relabel devices.ts's OWN row uses elsewhere (`deviceRowView`) — this
  // copy needs the actual question text, not a relabelled button, so it
  // follows `signOutView`'s dialog-block shape instead.
  const removingThis = confirmingRemoval?.circleId === c.id && confirmingRemoval?.pk === m.pk
  const removeBtn = m.pk !== selfPk && mayRemove(view, selfPk, m.pk, nowSec())
    ? (removingThis
      ? `
        <div class="contact-item">
          <p>Remove ${label} from ${esc(c.name)}? They'll lose access to the circle.</p>
          <div class="actions">
            <button type="button" data-action="circle-remove-member-cancel">Cancel</button>
            <button type="button" data-action="circle-remove-member-confirm" data-circle="${esc(c.id)}" data-pk="${esc(m.pk)}">Remove</button>
          </div>
        </div>
      `
      : `<button type="button" data-action="circle-remove-member" data-circle="${esc(c.id)}" data-pk="${esc(m.pk)}">Remove</button>`)
    : ''
  // Plan 2 (Task 10): "Leave" on your own row, for everyone (any member may
  // remove themself — `leaveCircle`).
  const leaveBtn = m.pk === selfPk
    ? `<button type="button" data-action="circle-leave" data-circle="${esc(c.id)}">Leave</button>`
    : ''
  const addedBy = addedByLine(c, m, self)
  // Final fix B7 (part A5 UI): a member with no known phone bound in this
  // circle can't be reached at all — `resendInvite` (final fix A5) re-sends
  // the normal invite to their personal inbox without touching the roster.
  // The notice below shows either "queued" silence (nothing to show; the
  // structural-queue's own waiting badge elsewhere covers that) or the
  // refusal reason `resendInvite` returns.
  const resendBtn = m.pk !== selfPk && phonesOf(c.id, m.pk).length === 0
    ? `<button type="button" data-action="circle-resend-invite" data-circle="${esc(c.id)}" data-pk="${esc(m.pk)}">Re-send invite</button>`
    : ''
  const resendNotice = resendStatus.get(`${c.id}:${m.pk}`)
  const resendNoticeHtml = resendNotice ? `<p class="muted small">${esc(resendNotice)}</p>` : ''
  // Person-to-person DM (Task 5, brief §23.4: "person-to-person conversations
  // live in the relevant person's page") — a member row IS that page's list
  // entry point in this app's simplified nav (no separate per-member screen
  // yet); the map's person sheet is the other entry point (app.ts).
  const messageBtn = m.pk !== selfPk
    ? `<button type="button" data-action="msg-open-dm" data-pk="${esc(m.pk)}" data-circle="${esc(c.id)}">Message${messages.unreadBadgeHtml(messages.unreadForPeer(p, m.pk, selfPk))}</button>`
    : ''
  // Task 2 (brief §9): "View" is this list's entry point into the Map tab's
  // person sheet (app.ts's `map-sheet-open` handler switches to Map + opens
  // it) — a MUTED member no longer has a map marker to tap, so THIS is
  // their only remaining path to Mute/Pin controls/Unmute; harmless (and
  // consistent) to offer for every member, not just muted ones.
  const viewBtn = m.pk !== selfPk
    ? `<button type="button" data-action="map-sheet-open" data-pk="${esc(m.pk)}">View</button>`
    : ''
  const now = Math.floor(Date.now() / 1000)
  const mutedUntil = p.viewPrefs[m.pk]?.mutedUntil
  const mutedRow = m.pk !== selfPk && mapinfo.isMuted(p.viewPrefs, m.pk, now)
    ? `<p class="muted small">Muted${mutedUntil === undefined ? '' : ` · ${esc(mapinfo.muteRemainingLabel(mutedUntil, now))}`}</p>
       <button type="button" data-action="map-sheet-unmute" data-pk="${esc(m.pk)}">Unmute</button>`
    : ''
  // Phase 6 Task 3 (design spec §3, brief §2.4/§34.17-18): the age-based
  // setup wizard's re-runnable entry point — a guardian viewing one of
  // their own children's member row can (re-)launch the wizard any time,
  // not just once at onboarding (see app.ts's other entry point,
  // `onboardingStartDoneView`, for the "just added this child" moment).
  // wizard.ts owns the actual flow — this button only carries the data-*
  // payload it needs to open itself (`wizard-open`, dispatched centrally by
  // app.ts), same "render the button, never import the module" idiom as
  // `messageBtn`'s own `msg-open-dm` above.
  const wizardBtn = viewerIsGuardian && m.role === 'child'
    ? `<button type="button" data-action="wizard-open" data-circle="${esc(c.id)}" data-child="${esc(m.pk)}" data-child-name="${esc(m.name || shortNpub(m.pk))}">Set up sharing together</button>`
    : ''
  return `<li class="contact-item">${label}<span class="badge">${esc(m.role)}</span>${addedBy}${removeBtn}${leaveBtn}${messageBtn}${viewBtn}${wizardBtn}${mutedRow}${resendBtn}${resendNoticeHtml}</li>`
}

/** Plan 2 (Task 10, design spec's Member row): the creator's own row shows
 *  "started this circle" (no vouch needed there — see authority.ts's
 *  creator exemption); everyone else's shows who vouched for them
 *  (`voucherOf`), by name. A dependant viewing a member who isn't among ITS
 *  OWN usable contacts sees "added by your guardian" instead of a name, when
 *  that voucher is one of its linked guardians (Task 6's own bootstrap
 *  rule: such a member is kept on the roster, not dropped, but named
 *  generically rather than by a name the dependant has no way to
 *  recognise). No vouch on file (shouldn't happen once authorised, but the
 *  UI degrades quietly rather than assert) renders nothing. */
function addedByLine(c: Circle, m: CircleMember, self: SessionInfo): string {
  if (creatorOf(c.id) === m.pk) return '<p class="muted small">started this circle</p>'
  const voucher = voucherOf(c.id, m.pk)
  if (!voucher) return ''
  if (self.dependant && linked(voucher, self.identityPk) && !usable(snapshot(), m.pk, linkedWithMe(self.identityPk))) {
    return '<p class="muted small">added by your guardian</p>'
  }
  return `<p class="muted small">added by ${esc(nameOf(voucher))}</p>`
}

function newNameView(step: Extract<View, { kind: 'new-name' }>): string {
  const err = step.error ? `<p class="form-error">${esc(step.error)}</p>` : ''
  const notice = step.notice ? `<p class="muted">${esc(step.notice)}</p>` : ''
  return `
    <h2>New circle</h2>
    <input id="circle-name" type="text" placeholder="Circle name" />
    ${err}
    ${notice}
    <button type="button" data-action="circle-create-submit">Create</button>
    <button type="button" data-action="circle-cancel">Back</button>
  `
}

function inviteView(p: store.Persisted, step: Extract<View, { kind: 'invite' }>): string {
  const circle = p.circles.find((c) => c.id === step.circleId)
  if (!circle) return `<p class="muted">That circle is gone.</p><button type="button" data-action="circle-cancel">Back</button>`
  const self = currentSession()

  const notice = step.notice ? `<p class="muted">${esc(step.notice)}</p>` : ''
  const npubErr = step.npubError ? `<p class="form-error">${esc(step.npubError)}</p>` : ''

  // Plan 2 (Task 6): only usable contacts (kin, kith) can be invited; kens
  // show greyed, with one "Meet in person to add" button (plan decision 9).
  const exclude = new Set([...circle.members.map((m) => m.pk), ...(self ? [self.identityPk] : [])])
  const { usable: people, kens } = candidates(snapshot(), exclude)
  const contactsList = people
    .map((c) => {
      const pk = c.pks.find((x) => !exclude.has(x)) ?? ''
      return `
      <li class="contact-item">${esc(c.name)}
        <button type="button" data-action="circle-invite-contact" data-circle="${esc(circle.id)}" data-pk="${esc(pk)}">Invite</button>
      </li>`
    })
    .join('')
  const kensSection = kens.length
    ? `
    <section class="contact-group">
      <h2>Meet in person to add</h2>
      <ul class="contact-list">${kens.map((c) => `<li class="contact-item muted">${esc(c.name)}</li>`).join('')}</ul>
      <button type="button" data-action="circle-meet-in-person" data-circle="${esc(circle.id)}">Meet in person to add</button>
    </section>`
    : ''
  // A guardian adds their own linked dependants straight in (spec §7).
  const dependants = self && !self.dependant
    ? dependantsOf(self.identityPk).filter((pk) => !circle.members.some((m) => m.pk === pk))
    : []
  const dependantButtons = dependants
    .map((pk) => `<button type="button" data-action="circle-invite-dependant" data-circle="${esc(circle.id)}" data-pk="${esc(pk)}">Add ${esc(nameOf(pk))} (your dependant)</button>`)
    .join('')

  return `
    <h2>Invite to ${esc(circle.name)}</h2>
    ${notice}
    ${dependantButtons}
    <section class="contact-group">
      <h2>From your contacts</h2>
      ${contactsList ? `<ul class="contact-list">${contactsList}</ul>` : '<p class="muted">No contacts to add yet — people you have met in My Signet appear here.</p>'}
    </section>
    ${kensSection}
    <section class="add-contact">
      <h2>By key</h2>
      <input id="circle-invite-npub" type="text" placeholder="npub1… or 64-char hex" />
      ${npubErr}
      <button type="button" data-action="circle-invite-npub-submit" data-circle="${esc(circle.id)}">Send invite</button>
    </section>
    <button type="button" data-action="circle-invite-done">Done</button>
  `
}

/** Plan decision 9's "Meet in person to add": My Signet has no add-contact
 *  deep link (internal Signet integration notes) — this is the NIP-46 / browser text
 *  fallback, and the only copy shown at all unless `launchSignerApp` (Task
 *  10) actually launches something. */
export const MEET_IN_PERSON_HINT = 'Open My Signet → Add contact.'

/** Plan decision 9 (Task 10): a NIP-55 session's signer app is right here on
 *  this phone, so "Meet in person to add" can bring IT to the foreground
 *  directly rather than only showing text — there's still no add-contact
 *  deep link to target (internal Signet integration notes), so this can't jump
 *  straight to an "add contact" screen inside it, only launch the app
 *  itself. `nip55.ts`'s own plugin bridge has no generic "launch app" call
 *  (only `get_public_key`/`sign_event`/`nip44_*`), so the smallest working
 *  option is an Android `intent:` URL naming the signer's package with no
 *  target action — Android resolves that to the package's own launcher
 *  activity, the same trick used to deep-link an installed app that has no
 *  custom URI scheme of its own. Every other transport returns `false`
 *  (falls back to `MEET_IN_PERSON_HINT`'s text). Guarded for a `window`-less
 *  environment (this file's own test suite runs under Node, no DOM). */
function launchSignerApp(self: SessionInfo): boolean {
  if (self.transport.kind !== 'nip55') return false
  if (typeof window === 'undefined' || typeof window.open !== 'function') return false
  // Final review B, minor 3: the package name comes from the signer's
  // answer or the persisted session; a `;` could inject intent extras.
  if (!/^[A-Za-z0-9_.]+$/.test(self.transport.packageName)) return false
  window.open(`intent:#Intent;package=${self.transport.packageName};end`, '_blank')
  return true
}

function acceptView(invite: IncomingInvite): string {
  return `
    <h1>Circle invite</h1>
    <p class="muted">You've been invited to join "${esc(invite.name)}".</p>
    <button type="button" data-action="circle-accept">Accept</button>
    <button type="button" data-action="circle-decline">Decline</button>
  `
}

function shortNpub(pk: string): string {
  try {
    const n = npubEncode(pk)
    return `${n.slice(0, 12)}…${n.slice(-6)}`
  } catch {
    return pk.slice(0, 12)
  }
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)
