// Dropped pins — flock interop on the map (Phase 7 Task 4, design spec §4).
// Flock shipped a fixed-vocabulary "mark a spot" feature (`app/src/pin.ts`,
// app-level — NOT yet part of the published `@forgesworn/flock` kit, so
// there is nothing to import; this module is a from-scratch, byte-mirror of
// its wire): a member drops one of 18 provider-fixed KINDS (never free
// text — same "no free-form content on the wire" discipline as flock's
// fixed-vocabulary buzz actions) at a geohash. Same envelope discipline as
// every other kindependence companion signal: a small JSON payload sealed with
// the circle's group-envelope key (`canary-kit/sync`'s `deriveGroupKey` +
// `encryptEnvelope`, the SAME primitives flock's own pin.ts calls directly —
// this app already depends on `canary-kit` itself, so there is no need to
// route through the `@forgesworn/flock` package at all), carried as a
// kind-20078 signal (`t:'pin'`), then gift-wrapped to the circle's shared
// inbox exactly like a beacon/meeting-point signal (`giftWrap(signer,
// inbox.pk, inner, inbox.pk)` — beacons.ts/meet.ts's own idiom). Adopting
// this wire byte-compatibly means a mixed flock/kindependence circle shares
// pins transparently; a plain flock device that has this feature reads
// ours and vice versa.
//
// Tombstone removal mirrors flock's d569b17 final form exactly (read in
// full for this task): a removal is a re-send of the SAME pin id with
// `removed:true`, signed as the REMOVER (not the original dropper) — any
// circle member may remove any pin (shared pins are shared housekeeping),
// but only by signing the tombstone as themselves. Receivers bind a pin's
// `from` to the wrap's authenticated seal signer either way (drop OR
// tombstone) — T1's sender-auth class, exactly flock's own `landPin` gate
// (`pin.from !== e.pubkey -> drop`). Tombstones are RETAINED as entries
// (never discarded) so a replayed drop can never resurrect a removed pin —
// see `withPin`'s own doc comment for the full replay-proofing reasoning,
// copied verbatim from flock's.
//
// Kindependence-only addition, NOT part of flock's wire or its pin.ts: a
// storage bound (`PIN_CAP`, `applyPin`) — flock's own `withPin` has no cap
// at all. The live-pin cap never evicts a tombstone for CAP reasons (that
// would reopen the exact replay hole d569b17 closed) — only ever the OLDEST
// live (non-removed) entries once a circle's live count would exceed the
// cap. Tombstones are retained indefinitely, matching flock — the earlier
// 20-day age prune's premise died with pin anti-entropy; see `applyPin`'s
// section doc comment for the full story.
//
// Same module shape as meet.ts (wire -> store -> outbound -> incoming ->
// ensure() -> UI), the closest sibling feature — see that file's own doc
// comment for the shared conventions this follows.

import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'
import { giftWrap } from '@forgesworn/roost-kit'
import type { Rumor, SignedEvent } from '@forgesworn/roost-kit'
import { deriveInbox, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { encode as encodeGeohash } from 'geohash-kit'
import * as store from './store.js'
import * as beacons from './beacons.js'
import * as activity from './activity.js'
import { appRelays, registerMemberAddedHandler } from './circles.js'
import { resolveCircleSelection } from './mapinfo.js'
import { currentSession, phoneSigner } from './session.js'

const nowSec = (): number => Math.floor(Date.now() / 1000)

// ---------------------------------------------------------------------------
// Wire — byte-mirror of flock's `app/src/pin.ts` (read in full for this
// task). Vocabulary, field names/shapes, validation regexes, and
// `withPin`'s merge/tombstone semantics are copied verbatim; only the
// transport call at the very bottom (`buildPinWrap`) differs, because
// kindependence's own gift-wrap send path (roost-kit's `giftWrap`, the same
// beacons.ts/meet.ts already use) stands in for flock's own `publishSignal`
// helper — the WIRE those two produce is identical either way (same
// kind-20078 inner event, same outer NIP-59 wrap).
// ---------------------------------------------------------------------------

/** The `t`-tag value for pin signals — flock's own, verbatim. */
export const PIN_SIGNAL_TYPE = 'pin'

/** The complete, fixed pin vocabulary — copied verbatim from flock's
 *  pin.ts, including key order (the picker order, most-reached first) and
 *  every glyph/label. Labels + glyphs are rendered locally; the wire
 *  carries only the key, so the relay never learns which icon (let alone
 *  what it means) was dropped, and there is no free-form text to leak. This
 *  table must never diverge from flock's own — an added/renamed/reordered
 *  kind here is a WIRE change, not a cosmetic one (a flock device would
 *  reject an unknown key outright, see `decryptPin` below). */
export const PIN_KINDS = {
  meet: { label: 'Meet here', glyph: '📍' },
  car: { label: 'Car', glyph: '🚗' },
  parking: { label: 'Parking', glyph: '🅿️' },
  home: { label: 'Home', glyph: '🏠' },
  food: { label: 'Food', glyph: '🍽️' },
  drink: { label: 'Drinks', glyph: '🍺' },
  coffee: { label: 'Coffee', glyph: '☕' },
  water: { label: 'Water', glyph: '🚰' },
  toilet: { label: 'Toilets', glyph: '🚻' },
  picnic: { label: 'Picnic', glyph: '🧺' },
  tent: { label: 'Camp', glyph: '⛺' },
  view: { label: 'Photo spot', glyph: '📸' },
  shop: { label: 'Shop', glyph: '🛍️' },
  atm: { label: 'Cash', glyph: '🏧' },
  firstaid: { label: 'First aid', glyph: '⛑️' },
  kids: { label: 'Kids', glyph: '🧒' },
  pet: { label: 'Pet', glyph: '🐾' },
  avoid: { label: 'Avoid', glyph: '⚠️' },
} as const

export type PinKind = keyof typeof PIN_KINDS
export const PIN_KIND_LIST = Object.keys(PIN_KINDS) as PinKind[]

export function isPinKind(v: unknown): v is PinKind {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(PIN_KINDS, v)
}

/** Local label for a pin — glyph + provider-defined name, never caller
 *  prose. esc()'d at every render-time interpolation (below) even though
 *  the vocabulary is provider-fixed, not wire-carried free text — house
 *  convention (every wire-derived string is esc()'d at the point it's
 *  spliced into an HTML template, regardless of how trusted its source). */
export function pinLabel(kind: PinKind): string {
  return `${PIN_KINDS[kind].glyph} ${PIN_KINDS[kind].label}`
}

/** A decrypted dropped pin — flock's own shape, verbatim. `removed` is a
 *  tombstone: the same id re-sent with `removed:true` retracts it
 *  (latest-timestamp-wins on the receiver, see `withPin`). */
export interface Pin {
  /** Stable id (the dropper mints it) so an edit/removal targets the same pin. */
  id: string
  /** Dropper pubkey for a fresh drop; the REMOVER's pubkey for a tombstone
   *  (flock's d569b17 — see this module's own doc comment). 64-char hex. */
  from: string
  /** Fixed protocol kind. */
  kind: PinKind
  /** Geohash of the spot. */
  geohash: string
  /** Geohash precision the spot was placed at. */
  precision: number
  /** Unix seconds. */
  timestamp: number
  /** Tombstone: this drop retracts the pin with this id. */
  removed?: boolean
}

const HEX_64_RE = /^[0-9a-f]{64}$/
const ID_RE = /^[0-9a-f]{8,32}$/
const GEOHASH_RE = /^[0-9a-z]{1,12}$/

/** Build an encrypted, unsigned kind-20078 pin signal (drop or removal) —
 *  flock's `buildPinSignal`, verbatim (same validation, same field order,
 *  same envelope primitives). */
export async function buildPinSignal(params: {
  groupId: string
  seedHex: string
  id: string
  from: string
  kind: PinKind
  geohash: string
  precision: number
  timestamp?: number
  removed?: boolean
}): Promise<UnsignedEvent> {
  if (!HEX_64_RE.test(params.from)) throw new Error('from must be a 64-character lowercase hex pubkey')
  if (!ID_RE.test(params.id)) throw new Error('pin id must be 8–32 lowercase hex chars')
  if (!isPinKind(params.kind)) throw new Error('unknown pin kind')
  if (!GEOHASH_RE.test(params.geohash)) throw new Error('invalid geohash')
  if (!Number.isInteger(params.precision) || params.precision < 1 || params.precision > 12) {
    throw new Error('precision must be an integer 1–12')
  }
  const payload: Pin = {
    id: params.id,
    from: params.from,
    kind: params.kind,
    geohash: params.geohash,
    precision: params.precision,
    timestamp: params.timestamp ?? nowSec(),
    ...(params.removed ? { removed: true } : {}),
  }
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(payload))
  return buildSignalEvent({ groupId: params.groupId, signalType: PIN_SIGNAL_TYPE, encryptedContent })
}

/** Decrypt and validate a pin signal — flock's `decryptPin`, verbatim.
 *  Rejects anything that isn't a well-formed provider-defined pin (unknown
 *  kind, bad geohash, missing fields). */
export async function decryptPin(seedHex: string, content: string): Promise<Pin> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Invalid pin payload: not valid JSON')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid pin payload')
  const o = parsed as Record<string, unknown>
  if (typeof o.id !== 'string' || !ID_RE.test(o.id)) throw new Error('Invalid pin: id')
  if (typeof o.from !== 'string' || !HEX_64_RE.test(o.from)) throw new Error('Invalid pin: from')
  if (!isPinKind(o.kind)) throw new Error('Invalid pin: unknown kind')
  if (typeof o.geohash !== 'string' || !GEOHASH_RE.test(o.geohash)) throw new Error('Invalid pin: geohash')
  if (typeof o.precision !== 'number' || !Number.isInteger(o.precision)) throw new Error('Invalid pin: precision')
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) throw new Error('Invalid pin: timestamp')
  return {
    id: o.id,
    from: o.from,
    kind: o.kind,
    geohash: o.geohash,
    precision: o.precision,
    timestamp: o.timestamp,
    ...(o.removed === true ? { removed: true } : {}),
  }
}

/** Merge an incoming pin into a list — latest-timestamp-wins per id.
 *  Flock's `withPin`, verbatim (post-d569b17 final form): tombstones are
 *  RETAINED as entries, not dropped — relays replay historical wraps in
 *  arbitrary order (gift-wrap timestamps are deliberately smeared), so a
 *  removal must keep outranking the original drop on every future replay.
 *  Discarding the entry would let a replayed drop resurrect a deleted pin,
 *  and a tombstone that arrived before its drop would be forgotten
 *  entirely. Display layers filter `removed` (map.ts/this module's own
 *  `sheetView`/`findPin`). Pure; returns the same ref when nothing
 *  changed. */
export function withPin(list: readonly Pin[] | undefined, incoming: Pin): Pin[] {
  const cur = list ?? []
  const existing = cur.find((p) => p.id === incoming.id)
  if (existing && existing.timestamp >= incoming.timestamp) return cur as Pin[]
  return [...cur.filter((p) => p.id !== incoming.id), incoming]
}

// ---------------------------------------------------------------------------
// Kindependence addition — NOT part of flock's wire or pin.ts: a storage bound.
// Flock's own `withPin` never caps a circle's pin list at all. `applyPin`
// layers a LIVE-count cap (`PIN_CAP`) on top, purely locally: once a
// circle's LIVE (non-tombstoned) count would exceed it, the OLDEST live
// entries are evicted first — tombstones are NEVER evicted (that would
// reopen the exact replay hole tombstone retention exists to close, see
// `withPin` above), so this only bounds how many currently-visible pins a
// circle can accumulate, never a circle's history of removed ones.
//
// Tombstones are retained INDEFINITELY (flock parity). An earlier 20-day
// age prune (final-review fix, Minor #3) reasoned from relay retention:
// ~16 days of history + ~2 days of wrap-timestamp smear meant no relay
// could still replay a drop 20 days after its tombstone. Flock's pin
// anti-entropy (6bea625 — re-implemented below, `resendAuthoredPins`) broke
// that premise: a holder who missed the removal re-sends its authored drop
// as a FRESH wrap on any presence announce, arbitrarily later than any
// fixed window, and a pruned tombstone would have nothing left to outrank
// it — the deleted pin would resurrect. Growth is bounded in practice by
// how often a circle actually removes pins.
// ---------------------------------------------------------------------------

/** Max LIVE (non-removed) pins kept per circle (task contract). */
export const PIN_CAP = 50

function livePins(list: readonly Pin[]): Pin[] {
  return list.filter((p) => !p.removed)
}

/** `withPin`'s merge, then the kindependence-only live-count cap (see the
 *  section doc comment above — tombstones are never pruned, by age or
 *  otherwise). Pure; returns the same ref as `withPin` when nothing changed
 *  at all (echo/stale replay), and the cap step returns its input reference
 *  unmodified whenever it had nothing to do (the common case) — never a
 *  needless new array identity. `nowSecValue` is retained for call-site
 *  compatibility (tests pass an explicit clock, same idiom as
 *  pool-health.ts's `notePoolActivity`) though nothing time-based remains. */
export function applyPin(list: readonly Pin[] | undefined, incoming: Pin, _nowSecValue: number = nowSec()): Pin[] {
  const cur = list ?? []
  const merged = withPin(cur, incoming)
  if (merged === cur) return merged
  const live = livePins(merged)
  if (live.length <= PIN_CAP) return merged
  const overflow = live.length - PIN_CAP
  const evictIds = new Set(
    [...live].sort((a, b) => a.timestamp - b.timestamp).slice(0, overflow).map((p) => p.id),
  )
  return merged.filter((p) => !evictIds.has(p.id))
}

function randomHex(byteLen: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLen)))
}

/** A fresh pin id — unlinkability handle, not a secret, same idiom as
 *  meet.ts's `newMeetId`/places.ts's `newPlaceId`. 16 lowercase hex chars,
 *  well within flock's own `ID_RE` (8-32). */
export function newPinId(): string {
  return randomHex(8)
}

/** A strictly-monotonic timestamp for RE-SENDING an existing pin id (a
 *  removal) — mirrors flock's own `nextPinTs`: pins carry whole-second
 *  timestamps and `withPin` breaks ties by keeping what it already holds
 *  (replay-proofing), so a removal landing in the SAME second as the drop
 *  it retracts would be discarded as a stale echo. Bumps one past the prior
 *  entry so a legitimate local change always outranks it. */
function nextPinTs(prev: Pin): number {
  return Math.max(nowSec(), prev.timestamp + 1)
}

/** Every drop is exact (task contract, mirrors flock's own `dropPin`:
 *  "Exact by construction (precision 9)"). */
const DROP_PRECISION = 9

// ---------------------------------------------------------------------------
// Store apply — merges an incoming (or self-dropped) pin into a circle's
// list, persists, and notifies. Mirrors meet.ts's `saveMeetPoints`/places.ts's
// own store-write helpers; `landPin` is the ONE write path for
// `Persisted.pins`.
// ---------------------------------------------------------------------------

/** Applies `pin` to `circleId`'s list via `applyPin` and persists. Returns
 *  whether anything actually changed (false for an echo/stale/duplicate
 *  replay) — callers use this to avoid double-recording Activity for a
 *  relay replay of something already held. */
function landPin(circleId: string, pin: Pin): boolean {
  let changed = false
  store.update((p) => {
    const cur = p.pins[circleId] ?? []
    const next = applyPin(cur, pin)
    if (next === cur) return
    changed = true
    p.pins = { ...p.pins, [circleId]: next }
  })
  return changed
}

// ---------------------------------------------------------------------------
// Outbound — drop a fresh pin, or remove an existing one (any member, per
// flock's remove-by-anyone). Both are optimistic (land locally, then
// publish — beacons.ts's `publishOrEnqueue` never throws, falling back to
// the shared outbox on any failure), same idiom as flock's own
// `dropPin`/`removePin`.
// ---------------------------------------------------------------------------

async function publishPin(circleId: string, pin: Pin): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle) return
  const inner = await buildPinSignal({ groupId: circle.id, seedHex: circle.seedHex, ...pin })
  const inbox = deriveInbox(circle.seedHex)
  const wrap: SignedEvent = await giftWrap(phoneSigner(), inbox.pk, inner, inbox.pk)
  await beacons.publishOrEnqueue(appRelays(p), wrap)
}

/** Drops a pin of `kind` at `centre` for `circleId` — any signed-in member
 *  of the circle may drop (task contract; unlike places.ts's guardian-only
 *  safe places). Silently no-ops without a signed-in identity/known circle,
 *  or once the circle's LIVE pin count is already at `PIN_CAP` — same
 *  "quiet cap, no error UI" convention as meet.ts's `addMeetPoint`. */
export async function dropPin(circleId: string, kind: PinKind, centre: { lat: number; lon: number }): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle) return
  if (livePins(p.pins[circleId] ?? []).length >= PIN_CAP) return
  const at = nowSec()
  const pin: Pin = {
    id: newPinId(),
    from: self.identityPk,
    kind,
    geohash: encodeGeohash(centre.lat, centre.lon, DROP_PRECISION),
    precision: DROP_PRECISION,
    timestamp: at,
  }
  landPin(circleId, pin)
  activity.recordActivity({
    // Review queue item 2 (Phase 7 Task 5): `pin.id` appended, same as
    // `removePin` just below — without it, two drops in the same circle
    // within the same wall-clock second collide on the bare
    // `local-pin-dropped-<at>-<circleId>` id and `recordActivity`'s dedupe
    // silently drops the second Activity entry.
    id: `${activity.localActivityId('pin-dropped', at, circleId)}-${pin.id}`, at, kind: 'pin-dropped', circleId, actorPk: self.identityPk,
    params: { kind: pin.kind, label: pinLabel(pin.kind) },
  })
  await publishPin(circleId, pin)
}

/** Retracts `pinId` — a tombstone signed as THIS device (the remover), per
 *  flock's d569b17 remove-by-anyone semantics: any circle member may
 *  remove any pin, not only its own dropper (see this module's own doc
 *  comment). Silently no-ops without a signed-in identity/known circle, an
 *  unrecognised `pinId`, or a pin already removed (a stale double-tap on
 *  the sheet's Remove button). */
export async function removePin(circleId: string, pinId: string): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle) return
  const current = (p.pins[circleId] ?? []).find((x) => x.id === pinId)
  if (!current || current.removed) return
  const tomb: Pin = { ...current, from: self.identityPk, timestamp: nextPinTs(current), removed: true }
  landPin(circleId, tomb)
  activity.recordActivity({
    id: `${activity.localActivityId('pin-removed', nowSec(), circleId)}-${pinId}`, at: tomb.timestamp, kind: 'pin-removed', circleId, actorPk: self.identityPk,
    params: { kind: tomb.kind, label: pinLabel(tomb.kind) },
  })
  await publishPin(circleId, tomb)
}

// ---------------------------------------------------------------------------
// Incoming — registered with beacons.ts's circle-inbox dispatch (see that
// module's own doc comment on `setSignalHandler`/`signalHandlers`).
// ---------------------------------------------------------------------------

/** Registered with beacons.ts's circle-inbox dispatch. Ignores its own
 *  echo, same discipline as every other handler in this codebase (meet.ts's
 *  `handleIncomingSignal`, safety.ts's `handleIncomingSignalAsync`).
 *
 *  Final-review fix, Minor #5: returns `applyIncomingPin`'s promise instead
 *  of voiding it, so a test can `await` completion directly instead of
 *  racing a fixed-delay `flush()` against the real WebCrypto decrypt inside
 *  it (the reviewer's diagnosed cross-test async leak: under load, that
 *  decrypt can outlive a one-tick `flush()`, land after a LATER test's
 *  `afterEach` has already swapped in a fresh `localStorage` stub, and write
 *  a pin into that later test's store). `beacons.ts`'s own
 *  `CircleSignalHandler` type stays `(...) => void` — TypeScript's void-
 *  returning function types accept any actual return value, so
 *  `setSignalHandler(handleIncomingSignal)` below still type-checks; the
 *  wider return type only matters to a caller that chooses to await it. */
export function handleIncomingSignal(circle: Circle, rumor: Rumor, t: string, sender: beacons.Sender): Promise<void> | void {
  const self = currentSession()
  if (self && sender.signerPk === self.phonePk) return
  if (t !== PIN_SIGNAL_TYPE) return
  return applyIncomingPin(circle, rumor, sender)
}

/** How long after re-sending a circle's authored pins another member-added
 *  trigger is ignored — flock's own anti-entropy debounce, kept as-is.
 *  Bounds the publish burst several roster additions in quick succession
 *  (e.g. a guardian inviting a whole family at once) could otherwise
 *  trigger. */
const PIN_RESEND_DEBOUNCE_SEC = 30
const lastPinResendAt = new Map<string, number>()

/** Re-sends every pin THIS device authored for `circle` — tombstones
 *  included, so deletions propagate and can't resurrect — keeping each
 *  pin's own timestamp (`withPin` is latest-wins, so a re-send is
 *  idempotent on every receiver). `from` is bound to the seal signer on
 *  receipt (see `applyIncomingPin`), so each pin has exactly ONE legitimate
 *  re-sender and the set partitions across members with no duplication.
 *
 *  Fix round 2 (review finding 2): the old flock-parity trigger — an
 *  unauthenticated `t:'joined'` self-announce, decrypted and member-bound by
 *  hand right here — is GONE along with the announce mechanism itself (see
 *  circles.ts's own "Roster healing" doc comment). This now registers
 *  directly with circles.ts's `registerMemberAddedHandler`
 *  (`MemberAddedHandler = (circle, memberPk) => void`, matched by signature
 *  below), fired from `applyConfig` only once a structural config's
 *  authority has already been verified — so, unlike the old announce, there
 *  is no separate decrypt/sender-binding check to do here: a genuinely NEW
 *  member is already established fact by the time this runs. `memberPk`
 *  itself isn't needed — every current pin author re-broadcasts on ANY
 *  addition to the circle, not just for the new member specifically. */
async function resendAuthoredPins(circle: Circle, _memberPk: string): Promise<void> {
  const p = store.load()
  const self = currentSession()
  if (!self) return
  const now = nowSec()
  if (now - (lastPinResendAt.get(circle.id) ?? 0) < PIN_RESEND_DEBOUNCE_SEC) return
  const mine = (p.pins[circle.id] ?? []).filter((pin) => pin.from === self.identityPk)
  if (!mine.length) return
  lastPinResendAt.set(circle.id, now)
  for (const pin of mine) await publishPin(circle.id, pin)
}

async function applyIncomingPin(circle: Circle, rumor: Rumor, sender: beacons.Sender): Promise<void> {
  let pin: Pin
  try {
    pin = await decryptPin(circle.seedHex, rumor.content)
  } catch {
    // undecryptable/malformed — silently drop, same discipline as
    // beacons.ts's `decodeBeaconRumor`: a bad payload must never crash the
    // receive loop for every other member's traffic.
    return
  }
  // Sender-auth (T1's class, mirrors flock's own `landPin` receive gate
  // EXACTLY): `pin.from` is the dropper for a fresh drop, or the REMOVER
  // for a tombstone (d569b17 — the tombstone's `from` is reassigned to the
  // remover before it's ever built, see `removePin` above) — either way it
  // must equal the resolved member behind the wrap's authenticated seal.
  // Any member may remove any pin, but only by signing the tombstone as
  // themselves; nobody may drop OR remove "as" someone else.
  if (pin.from !== sender.memberPk) return
  const changed = landPin(circle.id, pin)
  if (!changed) return // an echo / older-than-held / duplicate replay — never double-record Activity for it
  activity.recordActivity({
    id: rumor.id ?? `pin-${sender.memberPk}-${rumor.created_at}`,
    at: pin.timestamp, kind: pin.removed ? 'pin-removed' : 'pin-dropped', circleId: circle.id, actorPk: pin.from,
    params: { kind: pin.kind, label: pinLabel(pin.kind) },
  })
}

// ---------------------------------------------------------------------------
// ensure() — the one side-effecting entry point, called from app.ts's
// render(). Idempotent and identity-independent, same convention as
// meet.ts/places.ts's own `ensure()`.
// ---------------------------------------------------------------------------

let registered = false
export function ensure(): void {
  if (registered) return
  registered = true
  beacons.setSignalHandler(handleIncomingSignal)
  // Fix round 2 (finding 2): production wiring for the anti-entropy resend
  // — see `resendAuthoredPins`'s own doc comment for why a verified
  // roster-add is what drives it now, not the removed `joined` announce.
  registerMemberAddedHandler(resendAuthoredPins)
}

// ---------------------------------------------------------------------------
// View — the Map tab's "Drop a pin here" button + kind picker (18 glyphs,
// flock's own adbd606 UX finding: drop at the map's CENTRE, matching this
// app's existing centre-button idiom for places/meeting points — see
// meet.ts's own module doc comment on why a button beats a long-press
// here), and the per-pin tap sheet. UI wiring only past this point — no
// unit tests (build-gated), same convention as every other domain module
// here. esc() on every interpolated string per global-constraints.md, even
// though glyph/label are provider-fixed, not wire-carried free text (the
// dropper's NAME, by contrast, genuinely is wire-carried — same esc()
// either way).
// ---------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

function memberName(circle: Circle, pk: string): string {
  return circle.members.find((m) => m.pk === pk)?.name || `${pk.slice(0, 8)}…`
}

/** The Map tab's "Drop a pin here" button — beside places.ts's/meet.ts's
 *  own map-centre actions. Any signed-in member of at least one circle may
 *  drop (task contract). */
export function mapOverlayView(p: store.Persisted): string {
  if (!currentSession() || !p.circles.length) return ''
  return `<button type="button" class="map-chip pins-add" data-action="pins-add-here">Drop a pin here</button>`
}

interface KindPickerState {
  centre: { lat: number; lon: number }
}
let kindPicker: KindPickerState | null = null

/** Opens the kind-picker grid, centred on `centre` (app.ts's `pins-add-here`
 *  action, which alone holds the live MapView's centre — mirrors
 *  meet.ts's/places.ts's own `openMeetForm`/`openPlaceForm`). */
export function openKindPicker(centre: { lat: number; lon: number }): void {
  kindPicker = { centre }
  store.notify()
}
function closeKindPicker(): void {
  kindPicker = null
  store.notify()
}

/** The 18-glyph kind picker — tapping a glyph drops immediately at the
 *  centre `openKindPicker` captured (task contract: "kind picker grid ->
 *  drops at map centre", one tap, no separate confirm step). */
export function kindPickerView(p: store.Persisted): string {
  if (!kindPicker || !p.circles.length) return ''
  // Review queue item 3 (Phase 7 Task 5): default-select the Map tab's
  // current circle filter (`p.settings.mapCircles`, via the SAME
  // `resolveCircleSelection` the map itself renders from — mapinfo.ts's own
  // module doc comment) when it resolves to exactly ONE circle — i.e. the
  // person has filtered the map down to a single circle (the chip row's
  // one-circle-name state) or simply belongs to only one. That's the one
  // case where "the circle this pin is obviously for" is unambiguous; for
  // "All" or an explicit multi-circle selection there's no single
  // least-surprising default, so the picker falls back to its ordinary
  // first-option default (unchanged) rather than guessing. Applies to this
  // picker only — meet.ts's/places.ts's own forms are untouched (their own
  // circle pickers are a separate, out-of-scope decision; see this task's
  // brief).
  const effective = resolveCircleSelection(p.circles.map((c) => c.id), p.settings.mapCircles)
  const defaultCircleId = effective.size === 1 ? [...effective][0] : undefined
  const circleOptions = p.circles
    .map((c) => `<option value="${esc(c.id)}"${c.id === defaultCircleId ? ' selected' : ''}>${esc(c.name)}</option>`)
    .join('')
  const grid = PIN_KIND_LIST
    .map((k) => `<button type="button" class="pin-kind-btn" data-action="pins-kind-pick" data-kind="${esc(k)}">${esc(pinLabel(k))}</button>`)
    .join('')
  return `
    <div class="place-form">
      <h3>Drop a pin</h3>
      <select id="pins-circle">${circleOptions}</select>
      <div class="pin-kind-grid">${grid}</div>
      <div class="sheet-actions">
        <button type="button" data-action="pins-kind-cancel">Cancel</button>
      </div>
    </div>`
}

let sheetPinId: string | null = null

/** Opens (or, with `closePinSheet`, closes) the per-pin tap sheet — app.ts
 *  wires MapView's `onPinSelect` callback to this, mirroring
 *  `meet.openMeetSheet`/`closeMeetSheet`. */
export function openPinSheet(id: string): void {
  sheetPinId = id
  store.notify()
}
export function closePinSheet(): void {
  sheetPinId = null
  store.notify()
}

/** Finds `id` across every circle's pin set (a LIVE one only — a tombstoned
 *  pin's sheet, if still open when the removal lands, simply closes: see
 *  callers) — pin ids are random 8-byte handles (`newPinId`), so a bare id
 *  is enough to locate the owning circle, same idiom as meet.ts's own
 *  `findMeetPoint`. */
function findPin(p: store.Persisted, id: string): { circle: Circle; pin: Pin } | undefined {
  for (const circle of p.circles) {
    const pin = (p.pins[circle.id] ?? []).find((x) => x.id === id && !x.removed)
    if (pin) return { circle, pin }
  }
  return undefined
}

/** The tap sheet — kind label, dropper name, age, Navigate/Copy (reusing
 *  app.ts's EXISTING `map-sheet-navigate`/`map-sheet-copy` wiring at the
 *  pin's own geohash/precision — see meet.ts's own sheetView doc comment
 *  for why a pin's precise centre can ride the same
 *  `data-geohash`/`data-precision` dataset contract those actions already
 *  read, with zero new app.ts dispatch needed), and Remove — available to
 *  ANY member, per flock's remove-by-anyone (no creator/guardian gate,
 *  unlike meet.ts's own `canDelete`). `''` when no sheet is open, or the id
 *  no longer resolves (e.g. removed from another device between renders). */
export function sheetView(p: store.Persisted): string {
  if (!sheetPinId) return ''
  const self = currentSession()
  if (!self) return ''
  const found = findPin(p, sheetPinId)
  if (!found) return ''
  const { circle, pin } = found
  const dropper = pin.from === self.identityPk ? 'You' : memberName(circle, pin.from)
  const age = activity.relativeTime(pin.timestamp, nowSec())
  const navAttrs = ` data-geohash="${esc(pin.geohash)}" data-precision="${pin.precision}"`
  return `
    <div class="place-form">
      <h3>${esc(pinLabel(pin.kind))}</h3>
      <p class="muted small">${esc(dropper)} · ${esc(age)} · ${esc(circle.name)}</p>
      <div class="sheet-actions">
        <button type="button" data-action="map-sheet-navigate"${navAttrs}>Navigate</button>
        <button type="button" data-action="map-sheet-copy"${navAttrs}>Copy location</button>
        <button type="button" data-action="pins-remove" data-circle="${esc(circle.id)}" data-id="${esc(pin.id)}">Remove</button>
        <button type="button" data-action="pins-sheet-close">Close</button>
      </div>
    </div>`
}

// ---------------------------------------------------------------------------
// Action dispatch — app.ts delegates every `pins-*` action here, EXCEPT
// `pins-add-here` (needs the live MapView's centre, same
// places.ts/meet.ts-mirroring carve-out documented in `mapOverlayView`'s
// own doc comment).
// ---------------------------------------------------------------------------

export function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'pins-kind-pick': {
      const kind = node.dataset.kind
      const circleId = (document.getElementById('pins-circle') as HTMLSelectElement | null)?.value
      const centre = kindPicker?.centre
      if (centre && circleId && isPinKind(kind)) {
        closeKindPicker()
        void dropPin(circleId, kind, centre)
      }
      break
    }
    case 'pins-kind-cancel':
      closeKindPicker()
      break
    case 'pins-remove': {
      const circleId = node.dataset.circle
      const id = node.dataset.id
      closePinSheet()
      if (circleId && id) void removePin(circleId, id)
      break
    }
    case 'pins-sheet-close':
      closePinSheet()
      break
    default:
      break
  }
}
