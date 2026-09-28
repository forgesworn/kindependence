// Battery sharing — SENDER side only (Phase 3, Task 1). A circle member can
// let the rest of their circle see this device's battery level/charging
// state, same "own companion wire signal, gift-wrapped like everything else"
// idiom as places.ts's `kindependence-places` (see that module's doc comment for
// the full rationale): `t:'kindependence-battery'` is a kindependence-only extension
// of flock's `t` vocabulary, carried as plain JSON on an UNENCRYPTED-BUT-
// GIFT-WRAPPED kind-20078 rumor addressed to the circle's shared inbox — the
// outer NIP-59 layer, keyed off the circle's own seed, is already the only
// confidentiality that matters between a circle's own members (agreements.ts's
// module doc comment). A real flock client sees an unrecognised `t` and drops
// it, same as any other app-specific signal.
//
// The RECEIVE half (Phase 3, Task 2): an in-memory per-circle map of the
// latest reading heard from each member (`batteryFor`/`latestBatteryFor`,
// mirrors beacons.ts's own `positions` idiom — ephemeral, not persisted),
// and a pure low-battery ALERT episode state machine (`lowBatteryTransition`)
// that fires exactly once per dip at/below `LOW_BATTERY_PCT`, rearming only
// once the reading rises back above `LOW_BATTERY_RESET_PCT` or the device
// starts charging — the same "hysteresis band, not a single threshold"
// discipline as places.ts's grace/escalated state machine, so a battery
// hovering right at 15% doesn't re-alert on every subsequent reading.
// `handleIncomingSignal` (registered with beacons.ts's circle-inbox dispatch
// from `ensure()`, same idiom as places.ts's own handler) is this module's
// one receive entry point.
//
// Emit policy (`shouldSendBattery`): battery is low-frequency, low-urgency
// data — routine polling stays coarse (a 5-point bucket, at least 10 minutes
// apart) to avoid spamming the circle inbox with a wire event every time the
// OS reports a 1% drop, but three transitions are worth telling the circle
// about the instant they happen, regardless of how recently the last one
// went out: plugging in/unplugging, and crossing down through the 20% or 10%
// "getting low" thresholds — the two moments a guardian most wants to know
// about promptly. Pure and unit-tested in isolation (battery.test.ts); the
// impure `ensure()`/poll loop at the bottom is this module's own thin
// orchestration layer, same split as every other domain module here.
//
// Sharing is a per-circle, per-device choice (`effectiveShareBattery`) —
// defaults ON for a child (the circle member whose battery a guardian is
// usually the one wanting to know about) and OFF for a guardian, same
// "defaults reflect who the feature is FOR" reasoning as places.ts's
// arrival/departure notify toggles, always overridable either way via the
// You-tab per-circle toggle.

import * as store from './store.js'
import { appRelays, selfRole } from './circles.js'
import * as beacons from './beacons.js'
import * as activity from './activity.js'
import { notify } from './notify.js'
import { shouldNotifyForSafetyEvent } from './safety.js'
import { isNativePlatform } from './native.js'
import { currentSession, phoneSigner } from './session.js'
import { deriveInbox } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftWrap } from '@forgesworn/roost-kit'
import type { Signer, SignedEvent, Rumor } from '@forgesworn/roost-kit'
import { KINDS } from 'canary-kit/nostr'

const nowSec = (): number => Math.floor(Date.now() / 1000)

// ---------------------------------------------------------------------------
// Wire — build + strictly-validating parse. Round-trip tested in
// battery.test.ts against this module's own parser (there is no vendored
// flock equivalent to interop with here, unlike places.ts's fences half —
// battery is a kindependence-only concept).
// ---------------------------------------------------------------------------

export const BATTERY_SIGNAL_TYPE = 'kindependence-battery'

export interface BatteryReading {
  /** Integer 0-100. */
  pct: number
  charging: boolean
  /** Unix seconds this reading was taken. */
  at: number
}

interface BatterySignal {
  t: typeof BATTERY_SIGNAL_TYPE
  circleId: string
  from: string
  pct: number
  charging: boolean
  at: number
}

export function buildBatteryInner(circleId: string, from: string, r: BatteryReading): { kind: number; content: string; tags: string[][]; created_at: number } {
  const signal: BatterySignal = { t: BATTERY_SIGNAL_TYPE, circleId, from, pct: r.pct, charging: r.charging, at: r.at }
  return { kind: KINDS.signal, content: JSON.stringify(signal), tags: [['t', BATTERY_SIGNAL_TYPE]], created_at: r.at }
}

/** Gift-wraps a battery reading to `circle`'s shared inbox, sealed by
 *  `signer` (this device's phone key) — `fromPk` is the SESSION IDENTITY
 *  pubkey (Signet identity plan, Task 9: the payload's own `from` is always
 *  the identity, never the phone key that merely sealed the wrap; unlike
 *  places.ts's guardian-authored `buildPlacesWraps`, which needs an
 *  explicit `by` since a guardian can edit on a child's behalf, there is
 *  exactly one identity per call here). */
export async function buildBatteryWrap(signer: Signer, fromPk: string, circle: Circle, r: BatteryReading): Promise<SignedEvent> {
  const inner = buildBatteryInner(circle.id, fromPk, r)
  const inbox = deriveInbox(circle.seedHex)
  return giftWrap(signer, inbox.pk, inner, inbox.pk)
}

const HEX64 = /^[0-9a-f]{64}$/

/** Decode + strictly validate a `kindependence-battery` rumor's content — reject
 *  the whole payload on any malformed field, same discipline as places.ts's
 *  `parsePlacesMetaSignal`. Never throws. */
export function parseBatterySignal(content: string, expectedCircleId: string): { from: string; pct: number; charging: boolean; at: number } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const r = parsed as Record<string, unknown>
  if (r.t !== BATTERY_SIGNAL_TYPE) return null
  if (r.circleId !== expectedCircleId) return null
  if (typeof r.from !== 'string' || !HEX64.test(r.from)) return null
  if (typeof r.pct !== 'number' || !Number.isFinite(r.pct) || !Number.isInteger(r.pct) || r.pct < 0 || r.pct > 100) return null
  if (typeof r.charging !== 'boolean') return null
  if (typeof r.at !== 'number' || !Number.isFinite(r.at) || r.at <= 0) return null
  return { from: r.from, pct: r.pct, charging: r.charging, at: r.at }
}

// ---------------------------------------------------------------------------
// Emit policy — pure. Decides, given the last reading actually SENT to a
// circle and the current reading, whether this one is worth a fresh wire
// send. See the module doc comment for the reasoning behind each rule.
// ---------------------------------------------------------------------------

/** Last reading actually SENT for a circle (not merely observed) — the emit
 *  loop's per-circle memory (`ensure()`'s poll, below). */
export interface BatteryEmitMemory { pct: number; charging: boolean; at: number }

/** Bucket width (percentage points) for the coarse routine-change check. */
export const BATTERY_BUCKET = 5
/** Minimum gap (seconds) between two routine-bucket-change sends. */
export const BATTERY_MIN_INTERVAL_SEC = 600
/** "Getting low" thresholds that always send immediately when crossed
 *  downward, regardless of the min interval. */
export const BATTERY_LOW_CROSSINGS = [20, 10] as const

/**
 * Pure predicate: is `r` worth sending, given `mem` (the last reading this
 * device actually sent for this circle, `undefined` if none yet)?
 *
 * True when:
 *   - there's no prior memory (first reading ever for this circle);
 *   - the charging state flipped;
 *   - `r.pct` crossed DOWN through 20 or 10 (`mem.pct` was strictly above the
 *     threshold, `r.pct` is at or below it) — these three ALWAYS send,
 *     independent of `BATTERY_MIN_INTERVAL_SEC`;
 *   - OR the coarse bucket changed (`floor(pct/BATTERY_BUCKET)` differs,
 *     whichever direction) AND at least `BATTERY_MIN_INTERVAL_SEC` has
 *     elapsed since the last send.
 */
export function shouldSendBattery(mem: BatteryEmitMemory | undefined, r: BatteryReading): boolean {
  if (!mem) return true
  if (mem.charging !== r.charging) return true
  for (const threshold of BATTERY_LOW_CROSSINGS) {
    if (mem.pct > threshold && r.pct <= threshold) return true
  }
  const bucketChanged = Math.floor(r.pct / BATTERY_BUCKET) !== Math.floor(mem.pct / BATTERY_BUCKET)
  return bucketChanged && r.at - mem.at >= BATTERY_MIN_INTERVAL_SEC
}

// ---------------------------------------------------------------------------
// Per-circle sharing choice — defaults ON for a child, OFF for a guardian,
// always overridable (You-tab toggle). Local-only, same "personal disclosure
// choice, never synced to the wire" convention as `circleBasePrecision`
// (store.ts's `Persisted.settings` doc comment).
// ---------------------------------------------------------------------------

export function shareBatteryDefault(circle: Circle, selfPk: string): boolean {
  return selfRole(circle, selfPk) === 'child'
}

export function effectiveShareBattery(settings: store.Persisted['settings'], circle: Circle, selfPk: string): boolean {
  return settings.shareBattery?.[circle.id] ?? shareBatteryDefault(circle, selfPk)
}

/** The You-tab toggle's write side — applies immediately, same "click
 *  applies, no separate save step" idiom as `beacons.setCircleBaselinePrecision`. */
export function setShareBattery(circleId: string, on: boolean): void {
  store.update((p) => {
    p.settings = { ...p.settings, shareBattery: { ...(p.settings.shareBattery ?? {}), [circleId]: on } }
  })
}

// ---------------------------------------------------------------------------
// Received battery state — per-circle, per-member latest reading heard over
// the wire. Ephemeral, module-level, `store.notify()` on change — same
// "positions" idiom as beacons.ts's own `MemberPosition` map (never
// persisted: a stale reading is worse than none, and a reload just means the
// next incoming signal repopulates it).
// ---------------------------------------------------------------------------

/** A circle member's most recently heard battery reading. */
export interface MemberBattery { pct: number; charging: boolean; at: number }

/** How stale a reading may be and still be worth showing on the person
 *  sheet/widget (task contract) — 90 minutes, generous relative to the emit
 *  side's own cadence (`BATTERY_MIN_INTERVAL_SEC`'s 10 minutes at the
 *  tightest) so a member whose device has simply been idle a while doesn't
 *  immediately look like "no data". */
export const BATTERY_FRESH_SEC = 5400

const batteryState = new Map<string, Map<string, MemberBattery>>() // circleId -> pubkey -> reading

function upsertBattery(circleId: string, pk: string, reading: MemberBattery): void {
  let byMember = batteryState.get(circleId)
  if (!byMember) { byMember = new Map(); batteryState.set(circleId, byMember) }
  byMember.set(pk, reading)
  store.notify()
}

/** `pk`'s latest known battery reading within `circleId`, or `undefined` if
 *  nothing's been heard yet. */
export function batteryFor(circleId: string, pk: string): MemberBattery | undefined {
  return batteryState.get(circleId)?.get(pk)
}

/** `pk`'s freshest reading across every circle in `circleIds` (the person
 *  sheet/widget's own concern: a member can share into more than one circle
 *  this device also belongs to, and the newest reading wins regardless of
 *  which circle it arrived on). `undefined` if nothing's been heard from
 *  `pk` in any of them. */
export function latestBatteryFor(pk: string, circleIds: readonly string[]): MemberBattery | undefined {
  let best: MemberBattery | undefined
  for (const circleId of circleIds) {
    const reading = batteryState.get(circleId)?.get(pk)
    if (reading && (!best || reading.at > best.at)) best = reading
  }
  return best
}

// ---------------------------------------------------------------------------
// Low-battery alert episode state machine — pure. `lowBatteryTransition` is
// the sole decision point: given whether an alert episode for this
// (circleId, pk) is already active and the freshly-heard reading, does this
// reading start a NEW episode (`fire: true`, worth an Activity entry +
// notification) or merely continue/end an existing one? Hysteresis, not a
// single threshold (see the module doc comment) — `LOW_BATTERY_PCT` starts
// an episode, `LOW_BATTERY_RESET_PCT` (strictly higher) or a charging flip
// ends it, so a reading oscillating right at the low threshold alerts once,
// not on every subsequent poll.
// ---------------------------------------------------------------------------

/** At/below this percentage (and not charging), a fresh reading starts a new
 *  low-battery episode. */
export const LOW_BATTERY_PCT = 15
/** Strictly above this percentage, an active episode ends (rearms) — a
 *  member must recover meaningfully past the alert line, not just tick up
 *  1%, before another dip alerts again. */
export const LOW_BATTERY_RESET_PCT = 25

/**
 * Pure: `prev` (this (circleId,pk)'s previously known reading, `undefined`
 * if none) is accepted for symmetry with this module's other "given the
 * last known state, decide" helpers (`shouldSendBattery`) but the rule
 * itself needs only `inEpisode` + `next` — see the section doc comment.
 * `fire` is true exactly when `next.pct <= LOW_BATTERY_PCT && !next.charging
 * && !inEpisode` (a fresh dip into low, not a continuation). The returned
 * `inEpisode` ends (`false`) whenever `next.pct > LOW_BATTERY_RESET_PCT ||
 * next.charging` (recovered, or plugged in); otherwise it carries the
 * caller's `inEpisode` through unchanged (still low, already alerted — or
 * still comfortably charged/high).
 */
export function lowBatteryTransition(prev: MemberBattery | undefined, inEpisode: boolean, next: MemberBattery): { inEpisode: boolean; fire: boolean } {
  if (next.charging || next.pct > LOW_BATTERY_RESET_PCT) {
    return { inEpisode: false, fire: false }
  }
  if (next.pct <= LOW_BATTERY_PCT && !inEpisode) {
    return { inEpisode: true, fire: true }
  }
  return { inEpisode, fire: false }
}

// ---------------------------------------------------------------------------
// Incoming — registered with beacons.ts as an additional handler for
// non-beacon circle-inbox signals (see beacons.ts's `setSignalHandler` doc
// comment; places.ts's own `handleIncomingSignal` is the idiom this mirrors).
// ---------------------------------------------------------------------------

function memberName(circle: Circle, pk: string): string {
  return circle.members.find((m) => m.pk === pk)?.name || `${pk.slice(0, 8)}…`
}

/** Decodes + validates an incoming battery rumor's content AND checks the
 *  payload's own claimed `from` against the rumor's actual signing pubkey —
 *  a mismatch means the content claims to be someone it isn't (a spoofed
 *  `from`), rejected wholesale same as any other malformed field. Pure — no
 *  store/side effects — so directly unit-testable without exercising
 *  `handleIncomingSignal`'s I/O. */
export function parseIncomingBattery(content: string, expectedCircleId: string, rumorPubkey: string): { from: string; pct: number; charging: boolean; at: number } | null {
  const parsed = parseBatterySignal(content, expectedCircleId)
  if (!parsed || parsed.from !== rumorPubkey) return null
  return parsed
}

/** Per-`${circleId}:${pk}` "is a low-battery episode currently active"
 *  memory — module-level/in-memory, same ephemeral trade-off as
 *  `batteryState` above. */
const lowBatteryEpisodes = new Map<string, boolean>()

/** Registered with beacons.ts's circle-inbox dispatch (from `ensure()`).
 *  Ignores its own echo, same discipline as every other handler in this
 *  codebase (places.ts:1044's idiom). Rejects an out-of-order replay (an
 *  older `at` than the reading already on file — final review Minor #3)
 *  before touching anything. Upserts the sender's reading into
 *  `batteryState` regardless of the alert outcome, then runs
 *  `lowBatteryTransition` to decide whether THIS reading starts a fresh
 *  low-battery episode — only then (never on every reading) does it record
 *  an Activity entry and, unless this device has opted out
 *  (`settings.batteryAlertsOff`) or the reading is stale
 *  (`shouldNotifyForSafetyEvent`'s freshness gate — a relay's stored-wrap
 *  replay must not re-fire), a notification. */
export function handleIncomingSignal(circle: Circle, rumor: Rumor, t: string, sender: beacons.Sender): void {
  const self = currentSession()
  if (self && sender.signerPk === self.phonePk) return
  if (t !== BATTERY_SIGNAL_TYPE) return
  const parsed = parseIncomingBattery(rumor.content, circle.id, sender.memberPk)
  if (!parsed) return
  const pk = parsed.from
  const next: MemberBattery = { pct: parsed.pct, charging: parsed.charging, at: parsed.at }
  const key = `${circle.id}:${pk}`
  const prev = batteryFor(circle.id, pk)
  // Monotonic guard (final review Minor #3): relay DELIVERY order is
  // uncorrelated with the inner `at` — the outer giftwrap's `created_at` is
  // randomized (gift-wrap-everything, global-constraints.md), so a replayed
  // OLDER reading can arrive after a newer one already landed. Reject it
  // before touching either the shown reading or the episode state machine —
  // an out-of-order replay must neither resurrect a stale pct/charging value
  // nor re-fire/rearm a low-battery episode that already moved on.
  if (prev && next.at <= prev.at) return
  const transition = lowBatteryTransition(prev, lowBatteryEpisodes.get(key) ?? false, next)
  lowBatteryEpisodes.set(key, transition.inEpisode)
  upsertBattery(circle.id, pk, next)
  if (!transition.fire) return
  const inserted = activity.recordActivity({
    id: activity.localActivityId('battery-low', next.at, circle.id) + '-' + pk,
    at: next.at,
    kind: 'battery-low',
    circleId: circle.id,
    actorPk: pk,
    params: { pct: String(next.pct) },
  })
  if (store.load().settings.batteryAlertsOff) return
  if (!shouldNotifyForSafetyEvent(inserted, next.at, nowSec())) return
  void notify('battery-low', pk, `${memberName(circle, pk)}'s phone battery is low (${next.pct}%)`, circle.name)
}

// ---------------------------------------------------------------------------
// Reading the device's own battery — native (`@capacitor/device`) or web
// (`navigator.getBattery()`, where present). Neither is in TypeScript's DOM
// lib any more (the Battery Status API was pulled from the web spec), so the
// web shape is hand-typed here, same "cast the global, don't fight the lib"
// idiom as native.ts's own `window.Capacitor` read. Best-effort throughout —
// unavailable/denied/erroring reduces to `null`, never throws, so `ensure()`'s
// poll loop can await this unconditionally.
// ---------------------------------------------------------------------------

interface BatteryManager {
  level: number // 0-1
  charging: boolean
}
interface NavigatorWithBattery extends Navigator {
  getBattery?: () => Promise<BatteryManager>
}

/** Clamps a computed percentage into the valid 0-100 range at construction
 *  (Task 1 review follow-up, Minor #1) — a buggy/rounding-quirky OS or
 *  browser battery report (a `batteryLevel`/`level` fractionally over 1, or
 *  negative) must never propagate a value outside `parseBatterySignal`'s own
 *  strict receive-side range check, which would otherwise reject the WHOLE
 *  reading wholesale on every other device that hears it. */
function clampPct(rawPct: number): number {
  return Math.min(100, Math.max(0, Math.round(rawPct)))
}

async function readBatteryNative(): Promise<{ pct: number; charging: boolean } | null> {
  try {
    const { Device } = await import('@capacitor/device')
    const info = await Device.getBatteryInfo()
    if (typeof info.batteryLevel !== 'number' || !Number.isFinite(info.batteryLevel)) return null
    return { pct: clampPct(info.batteryLevel * 100), charging: info.isCharging === true }
  } catch {
    return null // plugin unavailable (web, or a dev build without `cap sync`)
  }
}

async function readBatteryWeb(): Promise<{ pct: number; charging: boolean } | null> {
  const nav = navigator as NavigatorWithBattery
  if (typeof nav.getBattery !== 'function') return null
  try {
    const mgr = await nav.getBattery()
    return { pct: clampPct(mgr.level * 100), charging: mgr.charging }
  } catch {
    return null
  }
}

/** This device's current battery level/charging state, or `null` when
 *  unavailable (unsupported browser, plugin missing, or an error reading
 *  it). Gated on `isNativePlatform()` for the plugin path — a plain web/PWA
 *  visitor's bundle only ever reaches the `navigator.getBattery()` branch. */
export async function readBattery(): Promise<{ pct: number; charging: boolean } | null> {
  if (isNativePlatform()) return readBatteryNative()
  if (typeof navigator === 'undefined') return null
  return readBatteryWeb()
}

// ---------------------------------------------------------------------------
// ensure() — the one side-effecting entry point, called from app.ts's
// render() next to beacons.ensure(p)/places.ensure(). Identity-gated with
// teardown on sign-out (mirrors beacons.ts's `ensure`/`teardown` idiom,
// unlike places.ts's identity-independent `registered` flag) since, unlike
// places' incoming-signal registration, there is nothing useful for this
// module to do at all without a signed-in identity to poll/send as.
// ---------------------------------------------------------------------------

const POLL_INTERVAL_MS = 60_000

/** Per-circle "last reading actually sent" memory — module-level, ephemeral
 *  (a reload just means the next poll re-sends once, same trade-off as every
 *  other in-memory map in this codebase, e.g. beacons.ts's `raisedPrecisionState`). */
const emitMemory = new Map<string, BatteryEmitMemory>()

let started = false
let pollTimer: ReturnType<typeof setInterval> | null = null

async function poll(): Promise<void> {
  const p = store.load()
  const self = currentSession()
  if (!self) return
  const battery = await readBattery()
  if (!battery) return // unsupported/denied this poll — try again next tick
  const reading: BatteryReading = { pct: battery.pct, charging: battery.charging, at: nowSec() }
  const relays = appRelays(p)
  for (const circle of p.circles) {
    if (!effectiveShareBattery(p.settings, circle, self.identityPk)) continue
    if (!shouldSendBattery(emitMemory.get(circle.id), reading)) continue
    const wrap = await buildBatteryWrap(phoneSigner(), self.identityPk, circle, reading)
    await beacons.publishOrEnqueue(relays, wrap)
    emitMemory.set(circle.id, { pct: reading.pct, charging: reading.charging, at: reading.at })
  }
}

/** Idempotent: starts a 60s battery poll once an identity is present, tears
 *  it down (and forgets per-circle emit memory) on sign-out. Also registers
 *  `handleIncomingSignal` with beacons.ts's circle-inbox dispatch (idempotent
 *  by function reference — see `setSignalHandler`'s own doc comment — so
 *  calling this every render never accumulates duplicate handlers) and
 *  prunes `emitMemory` entries for any circle no longer in `p.circles`
 *  (Task 1 review follow-up, Minor #2 — mirrors beacons.ts:617-620's own
 *  prune loop: a removed/reseeded-away circle must not leave stale send
 *  memory behind that could suppress a legitimate first send if the same
 *  circle id ever reappeared). Safe to call every render, same as every
 *  other domain module's `ensure()`. */
export function ensure(p: store.Persisted): void {
  if (!currentSession()) {
    teardown()
    return
  }
  const liveIds = new Set(p.circles.map((c) => c.id))
  for (const id of [...emitMemory.keys()]) if (!liveIds.has(id)) emitMemory.delete(id)
  beacons.setSignalHandler(handleIncomingSignal)
  if (started) return
  started = true
  void poll() // don't make the first reading wait out a stale up-to-60s-old tick
  pollTimer = setInterval(() => { void poll() }, POLL_INTERVAL_MS)
}

function teardown(): void {
  started = false
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  emitMemory.clear()
  batteryState.clear()
  lowBatteryEpisodes.clear()
}
