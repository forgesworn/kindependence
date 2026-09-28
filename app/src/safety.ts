// Safety signals: SOS (help/duress), check-in ("I'm OK"), and guardian-
// requested pickup. The one hard rule (global-constraints.md, "the safety
// path is never gated"): none of these three flows may depend on approvals,
// family policy, or connectivity. Structurally enforced, not just by
// discipline — this file imports NOTHING from `@forgesworn/brood-kit` (the
// package that owns policy/approvals), so there is no code path here that
// COULD consult one. Offline publishes fail over to beacons.ts's shared
// outbox instead of being dropped (see `publishOrEnqueue`), flushed on the
// same `online`/app-start schedule as every routine beacon.
//
// Reuses beacons.ts's plumbing rather than duplicating it: `appRelays` (via
// circles.ts), the geo watch's last-known fix (`beacons.selfFix`), the
// publish-or-outbox primitive (`beacons.publishOrEnqueue`), and — for
// receiving — beacons.ts's existing per-circle gift-wrap subscription. A
// second subscription on the same circle inbox would be redundant (there is
// exactly one inbound stream per circle); instead `ensure()` registers this
// module's `handleIncomingSignal` as beacons.ts's handler for any circle-
// inbox signal it doesn't itself decode (`t !== 'beacon'`).
//
// Wire shapes — ALL THREE flows are wire-identical to real flock (every
// vendored builder below comes from flock's `src/`, not reinvented here):
//   - help (SOS): `@forgesworn/flock/signals`'s duress-alert builder — kind
//     20078, `t:'help'`, canary-kit's duress key/cipher. Published to EVERY
//     circle's inbox.
//   - check-in ("I'm OK"): `@forgesworn/flock/buzz`'s `buildBuzzSignal` with
//     the fixed `check_in` coordination action (Phase 7 Task 3) — `t:'buzz'`,
//     wire-identical to what an updated flock client emits (spec §3). Upstream
//     always attaches `ask:'location'` to a `check_in`: flock made a check-in
//     inherently a ROLL-CALL ("please report where you are"), never the sender
//     attaching their own fix and never an automatic disclosure — the receive
//     side must NOT auto-answer with location (it doesn't; `decodeCheckin`
//     only records the event). Receive routes by ACTION and also accepts the
//     legacy free-text `reason:'Check in'` for the compat window.
//   - pickup: guardian's ASK is `@forgesworn/flock/findping`'s
//     `buildFindPingSignal` (`t:'findreq'`, `{from, target, timestamp}`) —
//     flock's real "find my phone" remote-exact-ping request, reused here
//     for "guardian asks a child to share their exact spot." The child's
//     ANSWER is a PLAIN `t:'beacon'` location signal at precision 9 (flock's
//     `sendExactBeacon`: "an ordinary beacon — indistinguishable from any
//     other" — see findping.ts's own doc comment). Because it's wire-
//     identical to routine sharing, it is decoded entirely by beacons.ts's
//     existing `decodeBeaconRumor`/`upsertPosition` path — this module never
//     sees it and has no separate "pickup answer" handler.

import * as store from './store.js'
import type { SessionInfo } from './session.js'
import * as beacons from './beacons.js'
import * as activity from './activity.js'
import * as pickup from './pickup.js'
import { appRelays } from './circles.js'
import { currentPosition, type Fix } from './geo.js'
import { notify, shouldNotifyForEvent, type NotifyKind } from './notify.js'
import { currentSession, phoneSigner } from './session.js'
import { deriveInbox, isGuardian } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftWrap } from '@forgesworn/roost-kit'
import type { Rumor, SignedEvent, Signer } from '@forgesworn/roost-kit'
import { buildHelpSignal, buildLocationSignal, SIGNAL_TYPES } from '@forgesworn/flock/signals'
import { DEFAULT_PRECISIONS } from '@forgesworn/flock/policy'
import { buildBuzzSignal, decryptBuzz, BUZZ_SIGNAL_TYPE } from '@forgesworn/flock/buzz'
import { decodeLegacyBuzz } from './legacy-buzz.js'
import { buildFindPingSignal, decryptFindPing, FIND_PING_SIGNAL_TYPE, type FindPing } from '@forgesworn/flock/findping'
import { encode as encodeGeohash } from 'geohash-kit'
import { deriveDuressKey, decryptDuressAlert, type DuressAlert, type DuressLocation } from 'canary-kit'
import { KINDS } from 'canary-kit/nostr'

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** How long the SOS button's hold must last before it fires. */
export const SOS_HOLD_MS = 1500

/** Cap on `Persisted.safetyEvents` — a rolling recent-alerts log, not an
 *  audit trail; oldest entries fall off once it fills. */
const MAX_SAFETY_EVENTS = 50

/** How fresh an incoming safety event must be to fire a system Notification
 *  (final-review I3) — mirrors flock's own `MSG_FRESH_SEC` freshness-gate
 *  idiom (app.ts's buzz/dm/location handlers, ~app.ts:4305: `isFresh =
 *  nowSec() - bz.timestamp <= MSG_FRESH_SEC`), but a much tighter window: an
 *  alert Notification is urgent-by-definition, so anything this old is a
 *  relay's stored-wrap replay (fired on every gift-wrap subscription open —
 *  up to ~16 days of history), not news. The in-app banner/log
 *  (`safetyEvents`, `alertsView`) is unaffected either way — history is
 *  exactly what that's for. Task 9: the actual constant/logic now lives in
 *  notify.ts as `NOTIFY_FRESH_SEC`/`shouldNotifyForEvent` (every OTHER call
 *  site, e.g. places.ts, uses those names directly) — this alias is kept so
 *  this file's own call sites and every existing test of
 *  `shouldNotifyForSafetyEvent` need no changes. */
const SAFETY_FRESH_SEC = 600

/** A findreq is answered (a one-shot exact-location disclosure) only if this
 *  recent — it is a LIVE request, so a stale/replayed copy must not trigger
 *  a disclosure. Tighter than `SAFETY_FRESH_SEC` because dropping a late ask
 *  merely makes the asker re-ask, while answering a stale one reveals the
 *  child's location to a replay. Flock's own `FIND_PING_FRESH_SEC` value. */
const FIND_PING_FRESH_SEC = 5 * 60

// ---------------------------------------------------------------------------
// Pure(-ish) payload builders — unit-tested in safety.test.ts the same way
// beacons.test.ts proves buildBeaconWrap/decodeBeaconRumor: build → giftWrap
// → giftUnwrap → decode, without a relay. Each pair below is impure only in
// the two crypto calls (canary-kit cipher / NIP-59 wrap); no store or
// network access.
// ---------------------------------------------------------------------------

/** The help signal's location field from a fix, or null for a location-less
 *  alert — always at flock's own `help` precision (11), the same constant
 *  `decideEmission`'s `trigger:'help'` branch resolves to (see beacons.ts's
 *  `basePrecisionFor` doc comment for why this stays a shared constant
 *  rather than a hard-coded 11 here too). */
export function helpLocationFrom(fix: Fix | null): DuressLocation | null {
  if (!fix) return null
  return { geohash: encodeGeohash(fix.lat, fix.lon, DEFAULT_PRECISIONS.help), precision: DEFAULT_PRECISIONS.help, locationSource: 'beacon' }
}

/** Build the gift-wrapped SOS event for one circle. `memberPk` is who the
 *  alert is about (always the caller, in this app — v1 has no "raise the
 *  alarm for someone else" flow). */
export async function buildHelpWrap(signer: Signer, circle: Circle, memberPk: string, location: DuressLocation | null): Promise<SignedEvent> {
  const inner = await buildHelpSignal({ groupId: circle.id, seedHex: circle.seedHex, member: memberPk, location })
  const inbox = deriveInbox(circle.seedHex)
  return giftWrap(signer, inbox.pk, inner, inbox.pk)
}

/** Decode an already-unwrapped rumor as a help/SOS alert, or null if it
 *  isn't one (wrong kind/`t`), or fails to decrypt (wrong circle seed). */
export async function decodeHelp(rumor: Rumor, circleSeedHex: string): Promise<DuressAlert | null> {
  if (rumor.kind !== KINDS.signal) return null
  if (rumor.tags.find((tag) => tag[0] === 't')?.[1] !== SIGNAL_TYPES.help) return null
  try {
    return await decryptDuressAlert(deriveDuressKey(circleSeedHex), rumor.content)
  } catch {
    return null
  }
}

/** Build a check-in's gift-wrapped event for one circle: flock's own
 *  `buildBuzzSignal` with `reason:'Check in'` — exactly `doCheckIn`'s own
 *  call shape. `shareLocation` sets `ask:'location'` (a roll-call asking the
 *  rest of the circle to show where THEY are) when the UI's "optional
 *  coarse location" checkbox is checked; a plain `Buzz` has no field for the
 *  sender's own location, so there is nothing else "optional location"
 *  could wire-compatibly mean here. */
export async function buildCheckinWrap(signer: Signer, circle: Circle, selfPk: string, shareLocation: boolean, at: number): Promise<SignedEvent> {
  // Phase 7 Task 3: flock's check-in is now the fixed `check_in` coordination
  // action — wire-identical to what an updated flock client emits (spec §3).
  // Upstream `buildBuzzSignal` ALWAYS attaches `ask:'location'` to a `check_in`
  // (flock made a check-in inherently a location ROLL-CALL — "please report
  // where you are", never an automatic disclosure of ours), so `shareLocation`
  // no longer changes the wire — the payload is identical either way. The
  // parameter is retained for call-site/UI stability.
  void shareLocation
  const inner = await buildBuzzSignal({ groupId: circle.id, seedHex: circle.seedHex, from: selfPk, action: 'check_in', timestamp: at })
  const inbox = deriveInbox(circle.seedHex)
  return giftWrap(signer, inbox.pk, inner, inbox.pk)
}

/** A decoded check-in, normalised across the NEW fixed-action wire and the
 *  legacy free-text one — only the fields the receive path actually consumes. */
export interface DecodedCheckin {
  from: string
  timestamp: number
  ask?: 'location'
}

/** Decode an already-unwrapped rumor as a check-in, or null if it isn't one.
 *  Phase 7 Task 3 routes by ACTION, never the compat label: the NEW kit's
 *  `check_in` fixed action IS a check-in. `decryptBuzz` THROWS on legacy
 *  free-text, so a throw falls through to the kindependence-owned legacy decode,
 *  where `reason === 'Check in'` is a legacy check-in (the receive compat
 *  window — spec §3: "its receive side accepts both"). A plain `t:'buzz'` also
 *  carries other coordination traffic (e.g. `on_my_way`), which this must not
 *  mislabel as a check-in.
 *
 *  Final-review fix, Minor #4 (legacy-path binding consistency): BOTH
 *  branches below bind `from` to the resolved sender (`senderMemberPk` —
 *  Signet identity plan, Task 9; formerly the raw `rumor.pubkey`) and drop
 *  on mismatch — discovered while adding this that upstream `decryptBuzz` (flock's
 *  `@forgesworn/flock/buzz`) does its OWN "exact-label legacy migration":
 *  `reason:'Check in'` with no `action` field at all — precisely the
 *  kindependence-owned legacy codec's shape — resolves via `decryptBuzz`'s own
 *  `coordinationActionFromLabel` lookup to `action:'check_in'` and so is
 *  decoded by the FIRST (NEW-kit) branch, never even reaching the second
 *  try/catch below. Binding only the second branch (this codebase's usual
 *  "legacy path" framing) would therefore have been dead code for the one
 *  legacy check-in reason that actually exists on the wire — both branches
 *  return an unbound content-embedded `from`, so both need the check. */
/** `senderMemberPk` is the identity resolved behind the wrap's authenticated
 *  seal (beacons.ts's `Sender.memberPk` for a phone-key circle signal) —
 *  Signet identity plan, Task 9: the wire payload's own `from` is always the
 *  IDENTITY that sent it (never the phone key that merely sealed the wrap),
 *  so binding it against the resolved member, not the raw seal pubkey, is
 *  what actually proves the content isn't lying about its sender. */
export async function decodeCheckin(rumor: Rumor, circleSeedHex: string, senderMemberPk: string): Promise<DecodedCheckin | null> {
  if (rumor.kind !== KINDS.signal) return null
  if (rumor.tags.find((tag) => tag[0] === 't')?.[1] !== BUZZ_SIGNAL_TYPE) return null
  try {
    const buzz = await decryptBuzz(circleSeedHex, rumor.content)
    if (buzz.action !== 'check_in') return null
    // Drop-on-mismatch (see the doc comment above): every caller already
    // binds its OWN recorded `from` to the resolved sender instead of
    // trusting this content-embedded field (see `handleIncomingSignalAsync`'s
    // `t === BUZZ_SIGNAL_TYPE` branch), but returning an unbound field at
    // all leaves a trap for any future consumer that assumes this type IS
    // bound — same discipline as every other sender-auth path here.
    if (buzz.from !== senderMemberPk) return null
    return { from: buzz.from, timestamp: buzz.timestamp, ...(buzz.ask ? { ask: buzz.ask } : {}) }
  } catch {
    // Not a NEW fixed-action buzz — try the legacy free-text compat window.
  }
  try {
    const legacy = await decodeLegacyBuzz(circleSeedHex, rumor.content)
    if (legacy.reason !== 'Check in') return null
    if (legacy.from !== senderMemberPk) return null // same drop-on-mismatch as the branch above
    return { from: legacy.from, timestamp: legacy.timestamp, ...(legacy.ask ? { ask: legacy.ask } : {}) }
  } catch {
    return null
  }
}

/** Build a guardian's pickup ASK for one circle: flock's own
 *  `buildFindPingSignal` (the real "find my phone" remote-exact-ping
 *  request), targeting the child by pubkey. */
export async function buildPickupReqWrap(signer: Signer, circle: Circle, fromPk: string, childPk: string, at: number): Promise<SignedEvent> {
  const inner = await buildFindPingSignal({ groupId: circle.id, seedHex: circle.seedHex, from: fromPk, target: childPk, timestamp: at })
  const inbox = deriveInbox(circle.seedHex)
  return giftWrap(signer, inbox.pk, inner, inbox.pk)
}

/** Decode an already-unwrapped rumor as a pickup request (`t:'findreq'`), or
 *  null if it isn't one or fails to decrypt. */
export async function decodePickupReq(rumor: Rumor, circleSeedHex: string): Promise<FindPing | null> {
  if (rumor.kind !== KINDS.signal) return null
  if (rumor.tags.find((tag) => tag[0] === 't')?.[1] !== FIND_PING_SIGNAL_TYPE) return null
  try {
    return await decryptFindPing(circleSeedHex, rumor.content)
  } catch {
    return null
  }
}

/** Build the child's automatic ANSWER to a pickup request: a PLAIN
 *  `t:'beacon'` location signal at flock's own `full` precision (9) — NOT a
 *  distinct type. Flock's own `sendExactBeacon` does exactly this
 *  ("indistinguishable from any other [beacon]", findping.ts's doc comment)
 *  so a relay observer can't tell a "someone asked for this" fix from
 *  routine sharing. Because the wire shape is identical to a routine
 *  beacon, beacons.ts's existing `decodeBeaconRumor`/`upsertPosition` path
 *  absorbs it on receipt — this module has no separate decoder for it. */
export async function buildPickupAnswerWrap(signer: Signer, circle: Circle, fix: Fix): Promise<SignedEvent> {
  const geohash = encodeGeohash(fix.lat, fix.lon, DEFAULT_PRECISIONS.full)
  const inner = await buildLocationSignal({
    groupId: circle.id, seedHex: circle.seedHex, signalType: SIGNAL_TYPES.beacon, geohash, precision: DEFAULT_PRECISIONS.full,
  })
  const inbox = deriveInbox(circle.seedHex)
  return giftWrap(signer, inbox.pk, inner, inbox.pk)
}

// ---------------------------------------------------------------------------
// Recent-alerts log — Persisted.safetyEvents. Deduped by id (a receive
// re-delivery, e.g. from a relay replay, must not double-log), capped, and
// used both for the sender's own self-echo (no notification — you know you
// just pressed the button) and for incoming events (also fires a banner +
// Notification).
// ---------------------------------------------------------------------------

/** Appends `evt` to the recent-alerts log, deduped by id. Returns whether it
 *  was ACTUALLY inserted — false for a dedupe (an id already on the log,
 *  e.g. a relay replay re-delivering the same event) — so callers can tell
 *  "this is genuinely new" from "we've already seen this" (see
 *  `shouldNotifyForSafetyEvent` below, final-review I3). */
function appendSafetyEvent(evt: store.SafetyEvent): boolean {
  let inserted = false
  store.update((p) => {
    if (p.safetyEvents.some((e) => e.id === evt.id)) return
    p.safetyEvents = [evt, ...p.safetyEvents].slice(0, MAX_SAFETY_EVENTS)
    inserted = true
  })
  return inserted
}

function memberName(circle: Circle, pk: string): string {
  return circle.members.find((m) => m.pk === pk)?.name || `${pk.slice(0, 8)}…`
}

function alertTitle(evt: store.SafetyEvent, name: string): string {
  if (evt.kind === 'help') return `${name} needs help`
  if (evt.kind === 'checkin') return `${name} checked in`
  // A pickup ANSWER is a plain beacon (see buildPickupAnswerWrap's doc
  // comment) and never becomes a SafetyEvent — every 'pickup' entry here is
  // the guardian's ask.
  return `Pickup requested for ${name}`
}

/** Whether an incoming safety event should fire a system Notification
 *  (final-review I3): only when it was ACTUALLY inserted (not a dedupe of
 *  something already on the log) AND it's fresh (`SAFETY_FRESH_SEC`) —
 *  otherwise a stored-wrap replay on every subscription open (up to ~16
 *  days of history) re-fires a notification for every event in that
 *  history, every time. Pure — no store/Notification access — so the
 *  decision itself is unit-testable without touching the browser
 *  Notification API. Task 9: a thin alias over notify.ts's own
 *  `shouldNotifyForEvent` (identical behaviour — see `SAFETY_FRESH_SEC`'s doc
 *  comment above for why this name/signature is kept). */
export function shouldNotifyForSafetyEvent(inserted: boolean, at: number, nowSecValue: number): boolean {
  return shouldNotifyForEvent(inserted, at, nowSecValue, SAFETY_FRESH_SEC)
}

/** SafetyEvent kind -> Activity kind — `pickup` maps to `'pickup-requested'`
 *  (the incoming ANSWER is a plain beacon that never becomes a SafetyEvent
 *  at all, see `buildPickupAnswerWrap`'s doc comment, so this receive path
 *  only ever sees requests). */
const ACTIVITY_KIND_FOR_SAFETY: Record<store.SafetyEvent['kind'], activity.ActivityKind> = {
  help: 'sos', checkin: 'checkin', pickup: 'pickup-requested',
}

function recordIncomingEvent(evt: store.SafetyEvent, circle: Circle): void {
  const inserted = appendSafetyEvent(evt)
  // Receive side records the peer's action (task contract) — same `id` as
  // the SafetyEvent (already the rumor's own event id, or its synthetic
  // fallback), so a relay replay dedupes here exactly as it does above.
  // `evt.from` is the child for a pickup request (see `store.SafetyEvent`'s
  // own doc comment) — also stashed as `params.targetPk` so `summarize`/
  // `deepLinkFor` can name and centre-map on the right person without
  // re-deriving it.
  activity.recordActivity({
    id: evt.id, at: evt.at, kind: ACTIVITY_KIND_FOR_SAFETY[evt.kind], circleId: circle.id, actorPk: evt.from,
    params: { ...(evt.kind === 'pickup' ? { targetPk: evt.from } : {}), ...(evt.geohash ? { geohash: evt.geohash } : {}) },
  })
  if (shouldNotifyForSafetyEvent(inserted, evt.at, nowSec())) {
    // ACTIVITY_KIND_FOR_SAFETY's declared type is the wider activity.ActivityKind
    // (shared with the Activity-recording call above); its three actual values
    // here (sos/checkin/pickup-requested) are also notify.ts's own NotifyKind
    // literals, so this narrowing cast is safe.
    void notify(ACTIVITY_KIND_FOR_SAFETY[evt.kind] as NotifyKind, evt.from, alertTitle(evt, memberName(circle, evt.from)), circle.name)
  }
}

// ---------------------------------------------------------------------------
// Notification — in-app banners (the `safetyEvents` log rendered in
// `view()`) are the primary channel; notify.ts's `notify()` (web Notification
// API, or native LocalNotifications inside the Capacitor shell) is an
// ADDITIONAL nudge. On web this only ever fires once permission has already
// been granted — see notify.ts's own module doc comment for why neither
// platform's permission prompt fires from a receive-loop callback like this
// one on web (native does request lazily, on its own first attempt, which
// this codepath is as good a "first attempt" as any).
// ---------------------------------------------------------------------------

/** Prompts for Notification permission if it hasn't been decided yet.
 *  Re-renders afterwards so `view()`'s "Enable alerts" prompt can disappear
 *  once the user answers (the browser's own permission state persists
 *  across reloads — nothing about it is stored in `Persisted`). */
export function requestNotificationPermission(): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return
  void Notification.requestPermission().then(() => store.notify())
}

// ---------------------------------------------------------------------------
// Outgoing — SOS, check-in, pickup request. Each publishes via
// `beacons.publishOrEnqueue` (never throws: offline/all-relays-down falls
// over to the shared outbox instead of being dropped) and none of them
// consult policy/approvals — see the module doc comment.
// ---------------------------------------------------------------------------

/** Fire an SOS to every circle: a fresh high-accuracy fix if one arrives
 *  within a few seconds, else the last known fix, else a location-less
 *  alert — "current fix (or last known)" per the task contract; a denied/
 *  unavailable GPS must never block an SOS from going out. */
export async function triggerSos(): Promise<void> {
  const p = store.load()
  const self = currentSession()
  if (!self || !p.circles.length) return
  const relays = appRelays(p)
  const fresh = await currentPosition({ enableHighAccuracy: true, maximumAge: 0, timeoutMs: 8000 })
  const location = helpLocationFrom(fresh ?? beacons.selfFix())
  const at = nowSec()
  await Promise.all(p.circles.map(async (circle) => {
    const wrap = await buildHelpWrap(phoneSigner(), circle, self.identityPk, location)
    await beacons.publishOrEnqueue(relays, wrap)
    appendSafetyEvent({
      id: `local-help-${at}-${circle.id}`, circleId: circle.id, from: self.identityPk, kind: 'help', at,
      ...(location ? { geohash: location.geohash, precision: location.precision } : {}),
    })
    activity.recordActivity({ id: activity.localActivityId('sos', at, circle.id), at, kind: 'sos', circleId: circle.id, actorPk: self.identityPk, params: location ? { geohash: location.geohash } : {} })
  }))
}

/** Check in with every circle: always sends "I'm OK" (flock's own
 *  `doCheckIn`, one buzz per circle); `shareLocation` adds `ask:'location'`
 *  — a roll-call asking the REST of the circle to show where they are (see
 *  `buildCheckinWrap`'s doc comment for why this isn't the sender's own
 *  fix). */
export async function triggerCheckin(shareLocation: boolean): Promise<void> {
  const p = store.load()
  const self = currentSession()
  if (!self || !p.circles.length) return
  const relays = appRelays(p)
  const at = nowSec()
  await Promise.all(p.circles.map(async (circle) => {
    const wrap = await buildCheckinWrap(phoneSigner(), circle, self.identityPk, shareLocation, at)
    await beacons.publishOrEnqueue(relays, wrap)
    appendSafetyEvent({ id: `local-checkin-${at}-${circle.id}`, circleId: circle.id, from: self.identityPk, kind: 'checkin', at })
    activity.recordActivity({ id: activity.localActivityId('checkin', at, circle.id), at, kind: 'checkin', circleId: circle.id, actorPk: self.identityPk, params: {} })
  }))
}

/** Shared core of `requestPickup` and Task 6's `sendPreciseLocationFindreq`
 *  below — the findreq send + its own SafetyEvent/pickup-requested Activity
 *  recording, identical either way. The only difference between the two
 *  public entry points is which role check (if any) gates reaching this.
 *  Returns the `at` timestamp the findreq used, or null when there's no
 *  signed-in identity/matching circle (nothing to send). */
async function sendFindreq(circleId: string, targetPk: string): Promise<number | null> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle) return null
  const relays = appRelays(p)
  const at = nowSec()
  const wrap = await buildPickupReqWrap(phoneSigner(), circle, self.identityPk, targetPk, at)
  await beacons.publishOrEnqueue(relays, wrap)
  appendSafetyEvent({ id: `local-pickup-req-${at}-${circleId}`, circleId, from: targetPk, kind: 'pickup', at })
  activity.recordActivity({ id: activity.localActivityId('pickup-requested', at, circleId), at, kind: 'pickup-requested', circleId, actorPk: self.identityPk, params: { targetPk } })
  return at
}

/** A guardian's "request pickup" for one child in one circle. Guardian-only
 *  by UI (only rendered for a guardian — see `pickupView`) and re-checked
 *  here in case a stale view is somehow still on screen; NOT a policy/
 *  approval gate — a circle-role check is core circle membership, same kind
 *  of check `circles.ts` already makes for e.g. member removal. */
export async function requestPickup(circleId: string, childPk: string): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle || !isGuardian(circle, self.identityPk)) return
  const at = await sendFindreq(circleId, childPk)
  // Phase 4 Task 6 (brief §17.2-17.3, §30): opens this device's own
  // PickupRecord and announces a companion `!pickup:requested` buzz so the
  // CHILD's device can open its own copy too — see pickup.ts's own module
  // doc comment for why this is a separate buzz rather than hooking record-
  // creation straight off the findreq receipt (`sendFindreq` above is
  // SHARED with Task 5's role-unrestricted `sendPreciseLocationFindreq`,
  // which is often not about a pickup at all — the wire alone can't tell the
  // two apart). `at === null` only when there's no signed-in identity/
  // circle, already handled (nothing was sent).
  if (at !== null) await pickup.sendPickupRequestSignal(circleId, childPk, at)
}

/** A guardian's "offer a pickup" (Phase 4 Task 6, brief §17.3) — the OTHER
 *  direction from `requestPickup` above: rather than asking the child to
 *  disclose their location, the guardian proactively offers to come get
 *  them, and the child accepts/declines/suggests an alternative. Unlike
 *  `requestPickup`, this has no findreq/beacon-answer half at all — it's
 *  purely the new lifecycle buzz (pickup.ts's `sendPickupOffer`). Guardian-
 *  gated the same way (UI-only rendered for a guardian, re-checked here). */
export async function offerPickup(circleId: string, childPk: string): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle || !isGuardian(circle, self.identityPk)) return
  await pickup.sendPickupOffer(circleId, childPk)
}

/** Task 6 (brief §11.4/§11.5): sends the findreq half of the person sheet's
 *  "Request precise location" — the SAME wire and SAME recording as
 *  `requestPickup` above (`sendFindreq`), but with NO role gate: it works in
 *  BOTH directions, a child may request a guardian's precise location just
 *  as a guardian may request a child's (§11.5's "two-way emergency access").
 *  This relies on `autoAnswerPickup` below already answering purely by
 *  "is the request addressed to me" (`ping.target`) — it never inspects who
 *  the requester is or what role they hold, so no change was needed there
 *  for two-way access to already work; verified by inspection, not just
 *  assumed (see that function's own call site in `handleIncomingSignalAsync`).
 *  Returns the findreq's own `at` timestamp (or null if there's no signed-in
 *  identity / `circleId` doesn't resolve) so messages.ts's orchestrator can
 *  stamp a companion reason DM close enough in time to correlate — see
 *  `correlateIncomingFindreq`'s ~2min matching window below. */
export async function sendPreciseLocationFindreq(circleId: string, targetPk: string): Promise<number | null> {
  const p = store.load()
  if (!currentSession() || !p.circles.find((c) => c.id === circleId)) return null
  return sendFindreq(circleId, targetPk)
}

/** The child device's automatic answer to an incoming pickup request — no
 *  confirmation prompt (the safety path is never gated). Best-effort: if no
 *  fix is available at all (denied/unsupported geolocation), there is
 *  nothing to disclose and this silently no-ops, same discipline as
 *  beacons.ts's own routine emit loop. */
async function autoAnswerPickup(circle: Circle, selfPk: string): Promise<void> {
  const relays = appRelays(store.load())
  const fresh = await currentPosition({ enableHighAccuracy: true, maximumAge: 0, timeoutMs: 8000 })
  const fix = fresh ?? beacons.selfFix()
  if (!fix) return
  const wrap = await buildPickupAnswerWrap(phoneSigner(), circle, fix)
  await beacons.publishOrEnqueue(relays, wrap)
  // Send side records the child's OWN action of complying — the answer
  // itself is a plain beacon on the wire (see this function's doc comment),
  // so there is no separate receive-side signal for a guardian's device to
  // hook a matching 'pickup-accepted' entry off; the guardian's own
  // 'pickup-requested' entry (recorded in `requestPickup` above) plus the
  // child's live position updating on the map cover that side.
  const at = nowSec()
  activity.recordActivity({
    id: activity.localActivityId('pickup-accepted', at, circle.id), at, kind: 'pickup-accepted', circleId: circle.id,
    actorPk: selfPk, params: { geohash: encodeGeohash(fix.lat, fix.lon, DEFAULT_PRECISIONS.full) },
  })
}

// ---------------------------------------------------------------------------
// Task 6 (brief §11.4/§11.5, §2.3): transparent emergency location access —
// correlating an incoming findreq with its companion declared-reason DM.
//
// The findreq itself carries no reason (wire compat: "no new wire types" —
// see the module's own §11.4 task note); the reason rides a SEPARATE
// structured DM (messages.ts's `!precise-request:` prefix, sent to the
// circle's shared inbox so every member — not just the requester and the
// target — can correlate it, matching brief §2.3's "make casual misuse
// socially and visibly accountable" and this app's own discouragement copy
// ("recorded for everyone in the circle's activity")). Relay delivery order
// between the two is NOT guaranteed, so both directions are handled:
// `correlateIncomingFindreq` (called from the findreq receive path below)
// checks for an already-arrived reason first; `recordEmergencyAccessReason`
// (called by messages.ts on receipt of the reason DM) checks for an
// already-arrived findreq first. Whichever arrives SECOND resolves the
// match immediately; if the reason never arrives within the window, the
// findreq side falls back to recording 'not stated' — a deliberate design
// choice (see this module's own doc comment reference in the phase-2 task
// report): this makes EVERY findreq-based precise-location grant
// accountable, including one sent via the older plain "Request pickup"
// button (guardian-only, no reason prompt) — the same social nudge toward
// declaring a reason the brief's "casual misuse" language calls for, not
// just the ones sent through this task's new reason-picker UI.
//
// Ephemeral, module-level, NOT persisted (a reload losing an in-flight
// unmatched request is an acceptable trade-off — the findreq/DM themselves
// already survived the round trip; only the correlation bookkeeping is
// lost, same "ephemeral UI state" reasoning as everywhere else in this
// codebase for short-lived cross-render bookkeeping).
// ---------------------------------------------------------------------------

/** How long a findreq and its companion reason DM may be apart in time (in
 *  EITHER order — relay delivery isn't guaranteed to preserve send order)
 *  and still be treated as the same request (task contract: "~2 min"). */
export const REASON_MATCH_WINDOW_SEC = 120

interface TimedFrom { from: string; at: number }

/** Pure: do `a` and `b` (a findreq and a reason DM, in either role) share
 *  the same sender and fall within the match window? The one correlation
 *  rule both `correlateIncomingFindreq` and `recordEmergencyAccessReason`
 *  apply, just with their arguments swapped depending on which one arrived
 *  first. */
export function withinReasonWindow(a: TimedFrom, b: TimedFrom, windowSec: number = REASON_MATCH_WINDOW_SEC): boolean {
  return a.from === b.from && Math.abs(a.at - b.at) <= windowSec
}

/** Pure: `items` with anything older than `windowSec` (relative to `nowSecValue`)
 *  dropped — keeps the pending-match buffers from growing unboundedly across
 *  a long-lived session. */
export function pruneExpired<T extends { at: number }>(items: readonly T[], nowSecValue: number, windowSec: number = REASON_MATCH_WINDOW_SEC): T[] {
  return items.filter((i) => nowSecValue - i.at <= windowSec)
}

/** Pure: the first item in `items` that correlates with `target` (see
 *  `withinReasonWindow`), or undefined. */
export function findMatch<T extends TimedFrom>(items: readonly T[], target: TimedFrom, windowSec: number = REASON_MATCH_WINDOW_SEC): T | undefined {
  return items.find((i) => withinReasonWindow(i, target, windowSec))
}

interface PendingFindreq { id: string; circleId: string; from: string; target: string; at: number }
interface PendingReason { from: string; at: number; reason: string }

let pendingFindreqs: PendingFindreq[] = []
let pendingReasons: PendingReason[] = []

/** Records the actual 'emergency-access' Activity entry once a findreq and
 *  its reason (real or the 'not stated' fallback) are matched up — on EVERY
 *  circle member's device that saw the findreq, same as the existing
 *  'pickup-requested' entry right next to it (see the module-doc-comment
 *  section above for why that's deliberate, not scope creep). The
 *  Notification (task deliverable 3, brief §11.4's "notify the person whose
 *  location was accessed") is narrower — fired only on the ACTUAL target's
 *  own device, never a bystander's, so a request about one child's location
 *  doesn't push-alert every other guardian/child in the circle. `reason` is
 *  wire-controlled (a free-text field riding the reason DM) — esc()'d at
 *  render time by whichever view shows it (activity.ts's `itemView`,
 *  `emergencyAccessAlertsView` below), never here. */
function recordEmergencyAccess(circleId: string, requesterPk: string, targetPk: string, at: number, reason: string): void {
  const p = store.load()
  const circle = p.circles.find((c) => c.id === circleId)
  // targetPk is part of the id (Task 10 polish, T6 minor): without it, two
  // distinct "requester asks about a different target in the same circle at
  // the same timestamp" events would collide and the second would be
  // silently dropped as a dedupe.
  const id = `emergency-access-${circleId}-${requesterPk}-${targetPk}-${at}`
  const inserted = activity.recordActivity({ id, at, kind: 'emergency-access', circleId, actorPk: requesterPk, params: { targetPk, reason } })
  if (circle && currentSession()?.identityPk === targetPk && shouldNotifyForSafetyEvent(inserted, at, nowSec())) {
    void notify('emergency-access', requesterPk, `${memberName(circle, requesterPk)} requested your precise location`, `Reason: ${reason}`)
  }
}

/** Called from the findreq receive path (every circle member's device sees
 *  the shared-inbox findreq, same as the existing 'pickup-requested' entry
 *  just above it — see `recordIncomingEvent`). Looks for an already-arrived
 *  reason DM first; if none, buffers the findreq and schedules the
 *  `REASON_MATCH_WINDOW_SEC` fallback. `id` is the findreq rumor's own id
 *  (or its synthetic fallback) — reused as the pending entry's key so a late
 *  match (`recordEmergencyAccessReason`) and the scheduled fallback can tell
 *  whether the OTHER one already resolved this specific findreq. */
function correlateIncomingFindreq(circleId: string, id: string, fromPk: string, targetPk: string, at: number): void {
  const now = nowSec()
  pendingReasons = pruneExpired(pendingReasons, now)
  const match = findMatch(pendingReasons, { from: fromPk, at })
  if (match) {
    pendingReasons = pendingReasons.filter((r) => r !== match)
    recordEmergencyAccess(circleId, fromPk, targetPk, at, match.reason)
    return
  }
  const entry: PendingFindreq = { id, circleId, from: fromPk, target: targetPk, at }
  pendingFindreqs = [...pruneExpired(pendingFindreqs, now), entry]
  setTimeout(() => {
    if (!pendingFindreqs.some((f) => f.id === entry.id)) return // already matched by recordEmergencyAccessReason below
    pendingFindreqs = pendingFindreqs.filter((f) => f.id !== entry.id)
    recordEmergencyAccess(entry.circleId, entry.from, entry.target, entry.at, 'not stated')
  }, REASON_MATCH_WINDOW_SEC * 1000)
}

/** Called by messages.ts on receipt of a `!precise-request:` reason DM (its
 *  own structured-prefix mechanism — see that module's doc comment). A
 *  direct export rather than a registration callback: messages.ts already
 *  safely imports this module (no reverse dependency exists — see this
 *  module's own import list), and there is exactly one caller, so the
 *  registration indirection every OTHER cross-module hook in this codebase
 *  uses (`setSignalHandler`/`setNavigator`/…) would add nothing here. */
export function recordEmergencyAccessReason(circleId: string, fromPk: string, at: number, reason: string): void {
  const now = nowSec()
  pendingFindreqs = pruneExpired(pendingFindreqs, now)
  const match = findMatch(pendingFindreqs, { from: fromPk, at })
  if (match) {
    pendingFindreqs = pendingFindreqs.filter((f) => f.id !== match.id)
    recordEmergencyAccess(match.circleId, fromPk, match.target, match.at, reason)
    return
  }
  // No findreq seen yet — the reason DM arrived first (relay delivery order
  // isn't guaranteed). Buffer it so the findreq, expected shortly, can still
  // find it in `correlateIncomingFindreq` above.
  pendingReasons = [...pruneExpired(pendingReasons, now), { from: fromPk, at, reason }]
}

/** The Circles-tab "banner" half of task deliverable 3 (the Notification in
 *  `recordEmergencyAccess` above is the other half) — recent
 *  'emergency-access' entries where THIS device is the actual target,
 *  read straight off `p.activity` (Activity is the single source of truth;
 *  this reuses `activity.summarize` rather than duplicating its "who
 *  requested X's precise location — reason: …" copy), same freshness window
 *  as `alertsView`'s own safety events. Scoped to the target only — same
 *  "notify the person accessed, not every bystander" reasoning as the
 *  Notification. */
function emergencyAccessAlertsView(p: store.Persisted, fam: SessionInfo): string {
  const now = nowSec()
  const items = p.activity.filter((e) => e.kind === 'emergency-access' && e.params.targetPk === fam.identityPk && now - e.at <= SAFETY_FRESH_SEC).slice(0, 5)
  if (!items.length) return ''
  const rows = items.map((e) => `<li class="contact-item">${esc(activity.summarize(p, e))}<span class="badge">${ageLabel(e.at, now)}</span></li>`).join('')
  return `<section class="contact-group"><h2>Precise location requests</h2><ul class="contact-list">${rows}</ul></section>`
}

// ---------------------------------------------------------------------------
// Incoming — registered with beacons.ts as its handler for any circle-inbox
// signal that isn't a plain beacon (see beacons.ts's `setSignalHandler` doc
// comment). Entry point returns its async tail's own promise (final-review
// fix, Minor #5 — see the doc comment on `handleIncomingSignal` just below);
// does its real work in that async tail. A pickup ANSWER never reaches
// here — see `buildPickupAnswerWrap`'s doc comment — so there is no
// `SIGNAL_TYPES.pickup` branch below; `t:'pickup'` (flock's own self-
// triggered "I want picking up", distinct from this app's request/answer
// flow) falls through to the ignored default, same as `breach`/`cover`.
// ---------------------------------------------------------------------------

/** Final-review fix, Minor #5: returns `handleIncomingSignalAsync`'s promise
 *  instead of voiding it — the SAME "sync wrapper voids an async tail" shape
 *  pins.ts's own `handleIncomingSignal` had (see that module's doc comment
 *  for the full reasoning: a test can now `await` completion directly,
 *  instead of racing a fixed-delay `flush()` against this function's real
 *  decrypt calls, closing off the same class of cross-test async leak the
 *  reviewer diagnosed there). `beacons.ts`'s `CircleSignalHandler` type stays
 *  `(...) => void` — TypeScript's void-returning function types accept any
 *  actual return value, so `setSignalHandler(handleIncomingSignal)` below
 *  still type-checks. (meet.ts's own `handleIncomingSignal` was NOT given
 *  the same treatment: it's fully synchronous end to end — no async tail at
 *  all — so there's nothing to leak and nothing for a caller to usefully
 *  await.) */
export function handleIncomingSignal(circle: Circle, rumor: Rumor, t: string, sender: beacons.Sender): Promise<void> {
  return handleIncomingSignalAsync(circle, rumor, t, sender)
}

async function handleIncomingSignalAsync(circle: Circle, rumor: Rumor, t: string, sender: beacons.Sender): Promise<void> {
  const self = currentSession()
  // The circle inbox is shared — every member (including whoever just
  // published) subscribes to it, so a relay that echoes a publish back to
  // its own subscriber would hand this device its own SOS/check-in/pickup-
  // request straight back. That's already recorded locally (with the
  // sender's own synthetic id — see `triggerSos`/`triggerCheckin`/
  // `requestPickup`) the moment it was sent; re-processing the wire echo
  // would double-log it under a DIFFERENT id (dedup-by-id can't catch this,
  // since the two ids don't match) and, worse, fire a Notification telling
  // you that you need help.
  if (self && sender.signerPk === self.phonePk) return
  const id = rumor.id ?? `${t}-${sender.memberPk}-${rumor.created_at}`
  if (t === SIGNAL_TYPES.help) {
    const alert = await decodeHelp(rumor, circle.seedHex)
    if (!alert) return
    recordIncomingEvent({
      id, circleId: circle.id, from: sender.memberPk, kind: 'help', at: alert.timestamp,
      ...(alert.geohash ? { geohash: alert.geohash, precision: alert.precision } : {}),
    }, circle)
    return
  }
  if (t === BUZZ_SIGNAL_TYPE) {
    const buzz = await decodeCheckin(rumor, circle.seedHex, sender.memberPk)
    if (!buzz) return
    recordIncomingEvent({ id, circleId: circle.id, from: sender.memberPk, kind: 'checkin', at: buzz.timestamp }, circle)
    return
  }
  if (t === FIND_PING_SIGNAL_TYPE) {
    const ping = await decodePickupReq(rumor, circle.seedHex)
    if (!ping) return
    // sender-auth: ffb48b9 class — ping.from names the ASKER (the sender);
    // it must equal the now-authenticated resolved sender, else the content
    // is lying about who's asking — drop it wholesale. ping.target names a
    // THIRD PARTY (the child being asked for) and is never bound to the
    // sender.
    if (ping.from !== sender.memberPk) return
    recordIncomingEvent({ id, circleId: circle.id, from: ping.target, kind: 'pickup', at: ping.timestamp }, circle)
    correlateIncomingFindreq(circle.id, id, ping.from, ping.target, ping.timestamp)
    // Freshness-gate the DISCLOSURE only (flock ff5eead parity): the answer
    // is a one-shot exact-location reveal, and the rumor-id dedup is
    // per-session — after a relaunch a captured findreq wrap replays as
    // "new" and would re-disclose the child's current position with no
    // prompt. `ping.timestamp` is sealed by the sender (a replayer can't
    // advance it). Fail-closed: the cost of dropping a genuinely late ask is
    // that the asker re-asks (repeatable, rate-limited); the cost of
    // answering a stale one is an unwanted location reveal. The log +
    // reason-correlation above stay ungated — state records, actions gate.
    const live = nowSec() - ping.timestamp <= FIND_PING_FRESH_SEC
    if (live && self && self.identityPk === ping.target) void autoAnswerPickup(circle, self.identityPk)
    return
  }
  // Any other `t` (breach, cover, flock's self-triggered `pickup`, a future
  // type) isn't this module's concern — silently ignored, same discipline
  // as beacons.ts.
}

/** Registers this module's incoming-signal handler with beacons.ts. Called
 *  from app.ts's render() alongside circles.ensure/beacons.ensure — same
 *  idempotent "the one side-effecting entry point" idiom as both. */
let registered = false
export function ensure(): void {
  if (registered) return
  registered = true
  beacons.setSignalHandler(handleIncomingSignal)
}

// ---------------------------------------------------------------------------
// View — a Circles-tab section: the SOS hold button, check-in, per-child
// pickup requests (guardian only), a short recent-alerts log, and an
// "enable alerts" prompt when Notification permission hasn't been decided
// yet. UI wiring only past this point — no unit tests (build-gated).
// ---------------------------------------------------------------------------

/** Just the SOS hold button + its hint line — factored out so app.ts can
 *  render it standalone as the Map tab's overlay (phase-2 nav, brief §17.1:
 *  the SOS button stays globally reachable, not confined to the Circles
 *  tab's full `view()` below). Both copies share the same `data-sos-hold`
 *  marker, so `wireSos` (below) wires whichever of them — one, both, or
 *  neither — the active tab actually rendered. */
export function sosButtonView(): string {
  return `
    <button type="button" class="sos-button" data-sos-hold="1">Hold for SOS</button>
    <p class="muted small">Press and hold for ${(SOS_HOLD_MS / 1000).toFixed(1)}s to alert every circle.</p>
  `
}

export function view(p: store.Persisted, fam: SessionInfo): string {
  return `
    <section class="safety-section">
      ${sosButtonView()}
      ${checkinView()}
      ${pickupView(p, fam)}
      ${notificationsView()}
      ${emergencyAccessAlertsView(p, fam)}
      ${alertsView(p)}
    </section>
  `
}

function checkinView(): string {
  return `
    <div class="checkin-row">
      <button type="button" data-action="safety-checkin">I'm OK</button>
      <label class="confirm-gate"><input type="checkbox" id="checkin-share-location" /> Also ask everyone to show where they are</label>
    </div>
  `
}

function pickupView(p: store.Persisted, fam: SessionInfo): string {
  const rows: string[] = []
  for (const c of p.circles) {
    if (!isGuardian(c, fam.identityPk)) continue
    for (const m of c.members.filter((member) => member.role === 'child')) {
      rows.push(`
        <li class="contact-item">${esc(m.name || shortPk(m.pk))}
          <button type="button" data-action="safety-pickup" data-circle="${esc(c.id)}" data-pk="${esc(m.pk)}">Request pickup</button>
          <button type="button" data-action="safety-offer-pickup" data-circle="${esc(c.id)}" data-pk="${esc(m.pk)}">Offer pickup</button>
        </li>`)
    }
  }
  if (!rows.length) return ''
  return `<section class="contact-group"><h2>Pickup</h2><ul class="contact-list">${rows.join('')}</ul></section>`
}

function notificationsView(): string {
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return ''
  return `<button type="button" data-action="safety-enable-notifications">Enable alert notifications</button>`
}

function alertsView(p: store.Persisted): string {
  if (!p.safetyEvents.length) return ''
  const now = nowSec()
  const items = p.safetyEvents.slice(0, 5).map((e) => {
    const circle = p.circles.find((c) => c.id === e.circleId)
    const name = circle ? memberName(circle, e.from) : shortPk(e.from)
    return `<li class="contact-item">${esc(circle ? alertTitle(e, name) : name)}<span class="badge">${ageLabel(e.at, now)}</span></li>`
  }).join('')
  return `<section class="contact-group"><h2>Recent alerts</h2><ul class="contact-list">${items}</ul></section>`
}

function ageLabel(at: number, now: number): string {
  const seconds = Math.max(0, now - at)
  if (seconds < 60) return 'just now'
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`
  if (seconds < 86_400) return `${Math.floor(seconds / 3600)}h ago`
  return `${Math.floor(seconds / 86_400)}d ago`
}

function shortPk(pk: string): string {
  return `${pk.slice(0, 8)}…`
}

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

// ---------------------------------------------------------------------------
// Action dispatch — app.ts delegates every `safety-*` data-action here, same
// pattern as circles.ts's `handleAction`.
// ---------------------------------------------------------------------------

export function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'safety-checkin': {
      const shareLocation = (document.getElementById('checkin-share-location') as HTMLInputElement | null)?.checked ?? false
      void triggerCheckin(shareLocation)
      break
    }
    case 'safety-pickup':
      void requestPickup(node.dataset.circle ?? '', node.dataset.pk ?? '')
      break
    case 'safety-offer-pickup':
      void offerPickup(node.dataset.circle ?? '', node.dataset.pk ?? '')
      break
    case 'safety-enable-notifications':
      requestNotificationPermission()
      break
    default:
      break
  }
}

/**
 * Wires the SOS button's long-press (pointerdown/up timing, not a click —
 * see the task contract). Not part of app.ts's generic `[data-action]` click
 * dispatcher on purpose: the SOS button uses `data-sos-hold` instead of
 * `data-action` so a click firing on pointerup (every pointerdown/up pair
 * fires one) never double-triggers it. Called from app.ts's render() after
 * every innerHTML rebuild, same as `mountMap` — a fresh button node needs
 * fresh listeners each time.
 */
export function wireSos(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('[data-sos-hold]').forEach((el) => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const cancel = (): void => {
      el.classList.remove('pressing')
      if (timer !== null) { clearTimeout(timer); timer = null }
    }
    el.addEventListener('pointerdown', (ev) => {
      ev.preventDefault()
      el.classList.add('pressing')
      timer = setTimeout(() => { cancel(); void triggerSos() }, SOS_HOLD_MS)
    })
    el.addEventListener('pointerup', cancel)
    el.addEventListener('pointercancel', cancel)
    el.addEventListener('pointerleave', cancel)
  })
}
