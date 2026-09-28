// Android home-screen widget (Phase 3 Task 6) — push-from-app, not
// pull-on-demand: this module builds a small JSON status payload out of
// state kindependence ALREADY has (this device's own circles' merged member
// positions, already-received battery readings, already-tracked
// agreements) and hands it to a tiny in-repo Capacitor plugin
// (`WidgetBridgePlugin.java`) that writes it to SharedPreferences and asks
// `KindependenceWidgetProvider` to redraw. No new data path, no network/JS in
// the provider itself — the provider only ever reads what this module last
// wrote.
//
// Split mirrors every other domain module here: `buildWidgetStatus` is the
// pure payload builder (fully unit-tested, widget.test.ts — brief's Step 1
// list), `ensure()` is the one side-effecting entry point app.ts's render()
// calls alongside places.ensure/battery.ensure.
//
// Row content is exclusively already-permitted info — `beacons.
// mergeMemberPositions` over this device's own circles, `battery.
// latestBatteryFor` (already-received readings), `p.agreements` (already-
// tracked). Nothing here asks for or discloses anything beyond what the Map
// tab and person sheet already render.
//
// Names resolve from a circle's own member list (same "member lookup,
// hex-prefix fallback" idiom used everywhere else a pk needs a display name
// — battery.ts's/places.ts's/safety.ts's own `memberName`), not npub —
// npub encoding IS available in this codebase (contacts.ts's `shortNpub`),
// but that idiom is for CONTACTS (a person you've pasted a raw key for),
// not circle members with a synced roster name; every call site that
// resolves a MEMBER's name (as this one does) uses the hex-prefix fallback,
// so this matches that idiom rather than contacts.ts's different one.
//
// Clock formatting: unlike `agreementScheduleText`/`locationModeLine`
// elsewhere, which deliberately push `toLocaleTimeString` out to a caller-
// supplied formatter to stay clock-free and unit-testable (see app.ts's own
// `formatClockTime` doc comment), `buildWidgetStatus` has no downstream
// "view" layer to push it to — the Java provider only ever renders the
// row text it's handed, verbatim. So the HH:MM formatting happens HERE,
// baked into `line2` — widget.test.ts computes its own expected string with
// the identical formula rather than a hard-coded literal, so the tests stay
// deterministic across whatever timezone the test runner happens to be in.

import * as store from './store.js'
import * as beacons from './beacons.js'
import * as battery from './battery.js'
import * as places from './places.js'
import * as agreements from './agreements.js'
import { selfRole } from './circles.js'
import { availabilityStateFull, availabilityLabelFull, precisionTerm, isMuted, type AvailabilityInputs } from './mapinfo.js'
import { isNativePlatform } from './native.js'
import { currentSession } from './session.js'
import { decode as decodeGeohash } from 'geohash-kit'
import { haversineMetres } from '@forgesworn/flock/geofence'

const nowSec = (): number => Math.floor(Date.now() / 1000)

// ---------------------------------------------------------------------------
// Wire shape — what the Java provider parses back out with org.json. Keep in
// lockstep with KindependenceWidgetProvider.java's `render()`.
// ---------------------------------------------------------------------------

export interface WidgetRow { name: string; line1: string; line2?: string }
export interface WidgetStatus { updatedAt: number; rows: WidgetRow[] }

/** Home-screen real estate caps the row count — matches
 *  `widget_kindependence.xml`'s 4 fixed row slots (`w_name1..4`/`w_line1..4`). */
export const MAX_WIDGET_ROWS = 4

/** A position coarser than this can't tell one place claim from another —
 *  "no place claims off a town-level cell" (task contract). Matches
 *  mapinfo.ts's own `isPrecise` threshold family in spirit, but this is a
 *  DIFFERENT, lower bar (Street, not Precise) — a place attachment is a much
 *  weaker claim than rendering an exact marker. */
const PLACE_MIN_PRECISION = 7

// ---------------------------------------------------------------------------
// buildWidgetStatus — pure. See widget.test.ts for the full behaviour
// matrix (brief's Step 1 list): guardian-with-dependant ordering, place
// attachment gating, agreement/battery line composition, truncation, self
// exclusion, empty input, name fallback.
// ---------------------------------------------------------------------------

function resolveName(p: store.Persisted, pk: string, circleIds: readonly string[]): string {
  for (const circleId of circleIds) {
    const circle = p.circles.find((c) => c.id === circleId)
    const name = circle?.members.find((m) => m.pk === pk)?.name
    if (name) return name
  }
  return `${pk.slice(0, 8)}…`
}

/** Whether `pk` is a row this device's OWN identity is a guardian-of-child
 *  for, in at least one of the circles it has a live position in — the
 *  ordering priority (task contract: "circles where self is guardian and
 *  pk role is child first"). Scoped to `circleIds` (not every circle `pk`
 *  might belong to) since that's the same set the row's own name/place
 *  resolution already draws from. */
function isGuardianOfChild(p: store.Persisted, selfPk: string | undefined, pk: string, circleIds: readonly string[]): boolean {
  if (!selfPk) return false
  return circleIds.some((circleId) => {
    const circle = p.circles.find((c) => c.id === circleId)
    if (!circle) return false
    return selfRole(circle, selfPk) === 'guardian' && circle.members.find((m) => m.pk === pk)?.role === 'child'
  })
}

/** The place name to append to `line1`, or undefined — gated to
 *  `PLACE_MIN_PRECISION`+ (task contract) and actual containment (haversine
 *  distance from the decoded point to the NEAREST synced place's centre,
 *  <= that place's own radius) — same "nearest, then check its own radius"
 *  idiom as places.ts's guardian-receive heuristic (`nearestPlace`), not a
 *  plain "closest wins regardless of radius" claim. */
function placeAttachment(p: store.Persisted, pos: beacons.MemberPosition, circleIds: readonly string[]): string | undefined {
  if (pos.precision < PLACE_MIN_PRECISION) return undefined
  const point = decodeGeohash(pos.geohash)
  const candidates = circleIds.flatMap((circleId) => p.places[circleId] ?? [])
  const nearest = places.nearestPlace(candidates, point)
  if (!nearest) return undefined
  return haversineMetres(point, nearest.centre) <= nearest.radiusMetres ? nearest.name : undefined
}

function formatClockTime(unixSec: number): string {
  return new Date(unixSec * 1000).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false })
}

/** `pk`'s active (acked or en-route — task contract) tracked agreement
 *  record, or undefined if there isn't one. A 'proposed' agreement (not
 *  yet acked) doesn't count as active — same lifecycle boundary
 *  agreements.ts's own reducers use. Split out from `agreementLine` below
 *  (Phase 4 Task 1, §10) so the SAME record also feeds the honest-
 *  availability 'sharing-scheduled' state's raise lookup
 *  (`agreementRaiseFor`) — one lookup, two consumers, rather than each
 *  re-deriving "the" active agreement independently. */
function activeAgreementRecordFor(p: store.Persisted, pk: string): store.AgreementRecord | undefined {
  return p.agreements.find((r) => r.agreement.child === pk && (r.status === 'acked' || r.status === 'en-route'))
}

/** "Home by 17:45" / "Grandma's by 17:45" for `active`'s deadline, or
 *  undefined when there is no active agreement. */
function agreementLine(active: store.AgreementRecord | undefined): string | undefined {
  if (!active) return undefined
  const hhmm = formatClockTime(active.agreement.byUnix)
  const label = active.agreement.place?.label
  return label ? `${label} by ${hhmm}` : `Home by ${hhmm}`
}

/** The active agreement's next-or-current schedule raise (Phase 4 Task 1,
 *  brief §10's 'sharing-scheduled' state), or undefined when there's no
 *  active agreement or its schedule never rises. Baseline is passed as 0
 *  rather than this pk's own chosen per-circle baseline — this device
 *  never knows another member's OWN baseline choice (a personal, local-
 *  only, never-synced-to-the-wire setting — store.ts's
 *  `Persisted.settings` doc comment); 0 treats any step the held schedule
 *  promises as worth surfacing, which is what 'sharing-scheduled' is
 *  actually claiming ("a raise IS coming"), not "a raise above whatever
 *  baseline we'd have to guess for them". */
function agreementRaiseFor(active: store.AgreementRecord | undefined, nowSecValue: number): { term: string; atUnix: number } | undefined {
  if (!active) return undefined
  const raise = agreements.nextOrCurrentRaise(0, active.agreement.schedule, active.agreement.byUnix, nowSecValue)
  return raise ? { term: precisionTerm(raise.precision), atUnix: raise.atUnix } : undefined
}

/** "Battery 42%" for a reading within `battery.BATTERY_FRESH_SEC`, or
 *  undefined for a stale/absent one — same freshness gate as the person
 *  sheet's own `batteryLineView` (app.ts). */
function batteryLine(reading: battery.MemberBattery | undefined, nowSecValue: number): string | undefined {
  if (!reading) return undefined
  if (nowSecValue - reading.at > battery.BATTERY_FRESH_SEC) return undefined
  return `Battery ${reading.pct}%`
}

/**
 * Builds the widget's full row set from state already in hand — pure, no
 * store/clock/plugin access (`nowSecValue` passed in, `batteryOf` passed in
 * so this stays directly testable against a stub rather than
 * `battery.latestBatteryFor` itself). See the module doc comment + brief for
 * the exact row-composition rules; the short version:
 *
 *  - every non-self pk in `merged`, resolved to a name via the first circle
 *    (of the ones the position was seen in) whose member list has them —
 *    unknown pk falls back to an 8-char hex prefix.
 *  - a MUTED pk is excluded entirely unless also pinned (review-minor:
 *    matches the map's own marker visibility, `mapinfo.isMuted`/`viewPrefs`
 *    — a viewing preference only, never a safety-signal gate).
 *  - ordered guardian-of-a-dependant rows first, then the rest by recency
 *    (most-recently-seen first) — within each group, recency breaks ties.
 *  - `line1`: the availability label, plus " · at <place>" only for a
 *    precision >= 7 position confidently inside one of their circles'
 *    places.
 *  - `line2`: active-agreement deadline, then fresh battery, joined by
 *    " · " — omitted entirely (no key) when neither applies.
 *  - truncated to `MAX_WIDGET_ROWS`.
 */
export function buildWidgetStatus(
  p: store.Persisted,
  merged: ReadonlyMap<string, beacons.MergedPersonPosition>,
  batteryOf: (pk: string, circleIds: readonly string[]) => battery.MemberBattery | undefined,
  nowSecValue: number,
): WidgetStatus {
  const selfPk = currentSession()?.identityPk
  // Review-minor: rows respect the Map tab's mute preference (mapinfo.ts's
  // `isMuted`, store.ts's `viewPrefs`) — a muted person's marker is already
  // hidden on the map (Task 2, brief §9), and the widget is just another
  // view onto the same already-permitted data, so it should agree rather
  // than keep surfacing a row the map itself no longer shows. Pinned is an
  // explicit override, same as the map's own auto-fit (`fitSet`): pinning
  // means "I want to see this one regardless", so a pinned-but-muted person
  // still gets a row. This is a VIEWING filter only — it runs over `merged`,
  // which `pushStatus` builds from the same already-received beacon data the
  // map/person sheet already have access to; nothing about what this device
  // has received or would disclose changes (store.ts's `viewPrefs` hard
  // invariant).
  const entries = [...merged.values()].filter((entry) => {
    if (entry.pubkey === selfPk) return false
    const pinned = p.viewPrefs[entry.pubkey]?.pinned === true
    return pinned || !isMuted(p.viewPrefs, entry.pubkey, nowSecValue)
  })

  entries.sort((a, b) => {
    const aFirst = isGuardianOfChild(p, selfPk, a.pubkey, a.circleIds) ? 0 : 1
    const bFirst = isGuardianOfChild(p, selfPk, b.pubkey, b.circleIds) ? 0 : 1
    if (aFirst !== bFirst) return aFirst - bFirst
    return b.pos.at - a.pos.at
  })

  const rows: WidgetRow[] = entries.slice(0, MAX_WIDGET_ROWS).map((entry) => {
    const name = resolveName(p, entry.pubkey, entry.circleIds)
    const placeName = placeAttachment(p, entry.pos, entry.circleIds)
    const active = activeAgreementRecordFor(p, entry.pubkey)
    const raise = agreementRaiseFor(active, nowSecValue)
    const battReading = batteryOf(entry.pubkey, entry.circleIds)

    // Phase 4 Task 1 (§10): honest availability — a widget row only ever
    // exists for a pk this device has a CURRENT position for (`merged`,
    // above), so `everHeard` is trivially true here; the 'never-heard'
    // state can never surface on the widget, only on the person sheet
    // (app.ts), which can open for a pk with no position at all.
    const inputs: AvailabilityInputs = {
      pos: entry.pos,
      battery: battReading ? { pct: battReading.pct, charging: battReading.charging, at: battReading.at } : undefined,
      agreementRaise: raise,
      everHeard: true,
    }
    const state = availabilityStateFull(inputs, nowSecValue)
    const raiseTime = raise ? formatClockTime(raise.atUnix) : undefined
    const line1 = availabilityLabelFull(state, raiseTime ? { raiseTime } : undefined) + (placeName ? ` · at ${placeName}` : '')

    const parts: string[] = []
    const agreement = agreementLine(active)
    if (agreement) parts.push(agreement)
    const batteryPart = batteryLine(battReading, nowSecValue)
    if (batteryPart) parts.push(batteryPart)

    return { name, line1, ...(parts.length ? { line2: parts.join(' · ') } : {}) }
  })

  return { updatedAt: nowSecValue, rows }
}

// ---------------------------------------------------------------------------
// ensure() — the one side-effecting entry point, called from app.ts's
// render() alongside places.ensure/battery.ensure. Subscribes to the store
// once (module flag) and pushes an initial status immediately on that first
// call — UNLESS that first push would be empty (`shouldSkipInitialPush`,
// below): cold launch reaches this before beacons.ts/battery.ts have heard
// anything this session, so an unguarded push would wipe last session's
// still-good widget rows with a freshly-stamped empty payload for no reason.
// Every store change after that schedules a 5s TRAILING debounce (rapid-fire
// changes — e.g. several beacons landing back to back — coalesce into one
// push, 5s after the last one) rather than a push per change, and is never
// subject to the initial-push skip.
//
// Native-only in effect (task contract), achieved the same way native-geo.ts
// achieves it: `pushStatus` checks `isNativePlatform()` AND wraps the actual
// plugin call in try/catch, so a web/dev build (or one without `cap sync`)
// silently no-ops rather than needing its own gate at every call site.
// ---------------------------------------------------------------------------

const PUSH_DEBOUNCE_MS = 5_000

interface WidgetBridgePlugin { update(o: { json: string }): Promise<void> }

/**
 * Cold-launch wipe guard (final review Minor #2): `ensure()`'s own very
 * first push fires before beacons.ts/battery.ts have heard anything this
 * session — `merged`/battery maps are still empty, so an unguarded push
 * would overwrite last session's still-valid widget rows with a
 * freshly-timestamped EMPTY payload the instant the app opens, even though
 * nothing has actually gone stale. Skip ONLY that one push, and ONLY when it
 * would have been empty — a first push that already has rows (nothing to
 * lose) goes through normally, and every push after the first (including a
 * deliberate empty one right after sign-out — app.ts's own `widget.ensure`
 * doc comment) is never gated by this, because `isFirstPush` is false by
 * then. Pure so the decision is directly unit-testable without a plugin
 * mock. */
export function shouldSkipInitialPush(isFirstPush: boolean, rows: number): boolean {
  return isFirstPush && rows === 0
}

let hasPushedOnce = false

async function pushStatus(p: store.Persisted): Promise<void> {
  if (!isNativePlatform()) return
  const merged = beacons.mergeMemberPositions(p.circles, beacons.memberPositions)
  const status = buildWidgetStatus(p, merged, battery.latestBatteryFor, nowSec())
  const isFirstPush = !hasPushedOnce
  hasPushedOnce = true
  if (shouldSkipInitialPush(isFirstPush, status.rows.length)) return
  try {
    const { registerPlugin } = await import('@capacitor/core')
    const WidgetBridge = registerPlugin<WidgetBridgePlugin>('WidgetBridge')
    await WidgetBridge.update({ json: JSON.stringify(status) })
  } catch {
    // plugin unavailable (web, or a dev build without `cap sync`) — silent
    // no-op, same discipline as native-geo.ts's own dynamic-import guard.
  }
}

let subscribed = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null

function scheduleDebouncedPush(): void {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(() => {
    debounceTimer = null
    void pushStatus(store.load())
  }, PUSH_DEBOUNCE_MS)
}

/** Idempotent: wires the store subscription once and pushes an initial
 *  status right away on the first call — skipped only if that first status
 *  would be empty (`shouldSkipInitialPush`); every later call (every render,
 *  same as every other domain module's `ensure()`) is a no-op — ongoing
 *  updates flow entirely through the store subscription's own debounced
 *  push, not through repeated `ensure()` calls. */
export function ensure(p: store.Persisted): void {
  if (subscribed) return
  subscribed = true
  store.subscribe(scheduleDebouncedPush)
  void pushStatus(p)
}
