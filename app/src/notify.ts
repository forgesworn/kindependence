// Notification abstraction (Task 9, brief §12/§29): ONE `notify(kind,
// actorPk, title, body)` entry point every domain module calls instead of
// touching the browser Notification API (or, natively, Capacitor's
// LocalNotifications plugin) directly. Before this task, safety.ts and
// places.ts each had their own near-identical `notifyIfGranted(title, body)`
// — web-only, and with no consolidation. This module:
//
//   - picks the transport: the web Notification API in a browser/PWA tab, or
//     @capacitor/local-notifications inside the Android shell
//     (`native.isNativePlatform()`) — never both;
//   - routes each `kind` to one of four native notification CHANNELS
//     (safety/places/messages/agreements — `CATEGORY_FOR_KIND`/`CHANNELS`
//     below), so a user can mute e.g. "Messages" without losing SOS alerts;
//   - collapses repeats (brief §29: "notifications consolidate rather than
//     repeat") — a burst of the same `kind` from the same actor within
//     `CONSOLIDATE_WINDOW_SEC` becomes ONE notification, not N. This is
//     `notify()`'s OWN, internal behaviour (`shouldFireNotification` below) —
//     every call site keeps doing exactly what it already did (decide
//     "is this event worth notifying about at all" — see
//     `shouldNotifyForEvent` below — then call `notify()`); the collapsing
//     itself needs no per-call-site bookkeeping.
//
// Web permission stays exactly as it always has: `notify()` never calls
// `Notification.requestPermission()` itself (see safety.ts's original
// `requestNotificationPermission` doc comment — a permission prompt firing
// from a receive-loop callback would be a surprising, un-attributable popup);
// only an explicit "Enable alerts" tap does that. Native is different: the
// system's own notification-permission dialog (Android 13+'s POST_NOTIFICATIONS
// runtime permission) is a routine, expected part of a fresh install — Capacitor
// apps commonly ask for it the first time it's actually needed — so the native
// path DOES request it, lazily, once, on this session's first native
// notification attempt (`ensureNativePermission` below).

import { isNativePlatform } from './native.js'
import * as store from './store.js'
import { parseHHMM } from './places.js'

// ---------------------------------------------------------------------------
// Kinds + categories (channels).
// ---------------------------------------------------------------------------

/** Every event kind that can fire a notification today. A deliberately
 *  smaller vocabulary than activity.ts's `ActivityKind` (which this overlaps
 *  with, `'message'` included) — not every recorded Activity kind is
 *  notification-worthy (e.g. routine `'precision-raised'` isn't), so this
 *  stays its own closed set rather than widening to the full union; add a
 *  kind here (and to `CATEGORY_FOR_KIND`) only when a real call site needs
 *  it. */
export type NotifyKind =
  | 'sos' | 'checkin' | 'pickup-requested' | 'pickup-status' | 'emergency-access'
  | 'safe-area-warning' | 'safe-area-escalation' | 'arrival' | 'departure'
  | 'window-reminder' | 'window-missed'
  // Phase 5 Task 3 (brief §32.2): journey-start/journey-done buzzes — same
  // 'places' channel as arrival/departure (a journey is "where a member is
  // headed/ended up", the same family), ordinary (NOT in
  // `QUIET_EXEMPT_KINDS` below — ordinary, quiet-holdable, unlike a genuine
  // safety escalation).
  | 'journey'
  | 'message' | 'request'
  | 'agreement-status' | 'leave-reminder'
  | 'battery-low'

/** The five native notification channels (task contract: "channel per
 *  kind-category: safety/places/messages/agreements/battery") — also just a
 *  plain grouping label on web, where there's no channel concept to speak
 *  of. */
export type NotifyCategory = 'safety' | 'places' | 'messages' | 'agreements' | 'battery'

const CATEGORY_FOR_KIND: Record<NotifyKind, NotifyCategory> = {
  sos: 'safety',
  checkin: 'safety',
  'pickup-requested': 'safety',
  'pickup-status': 'safety',
  'emergency-access': 'safety',
  'safe-area-warning': 'places',
  'safe-area-escalation': 'places',
  arrival: 'places',
  departure: 'places',
  'window-reminder': 'places',
  'window-missed': 'places',
  journey: 'places',
  message: 'messages',
  // Task 7 (actionable quick-chip notifications, brief): a chip whose
  // receipt is itself worth acting on (`come-home-now`/`dinner-ready`/
  // `pickup`/`checkin-request` — see messages.ts's `chipNotifyKind`), as
  // opposed to `'message'`'s free-form chat. Same channel as `'message'` —
  // both are "something happened in Messages" from a mute-granularity point
  // of view; only the copy differs (see `chipNotifyKind`'s call sites).
  request: 'messages',
  'agreement-status': 'agreements',
  // Task 8 (brief §15): travel-aware leave reminders — same channel as
  // 'agreement-status', a purely local child-side notification about the
  // SAME agreement the channel is already named for.
  'leave-reminder': 'agreements',
  'battery-low': 'battery',
}

interface ChannelDef { id: string; name: string; description: string }

/** Android notification channel definitions, one per category — created
 *  lazily (`ensureChannel` below) the first time each is actually used, not
 *  all five up front, so a device that never triggers e.g. an agreement
 *  notification never gets an empty "Agreements" channel cluttering system
 *  settings. `importance: 4` (HIGH, per Capacitor's numeric scale) everywhere:
 *  none of these five categories is something a user would want silently
 *  queued — the least urgent of them (a chat message) still deserves a
 *  heads-up the way the other four already got via the web Notification API. */
const CHANNELS: Record<NotifyCategory, ChannelDef> = {
  safety: { id: 'safety', name: 'Safety alerts', description: 'SOS, check-ins, and pickup requests' },
  places: { id: 'places', name: 'Safe areas', description: 'Arrivals, departures, and safe-area notices' },
  messages: { id: 'messages', name: 'Messages', description: 'Direct messages and circle chat' },
  agreements: { id: 'agreements', name: 'Agreements', description: 'Return-time agreement updates' },
  battery: { id: 'battery', name: 'Battery', description: 'Low-battery updates from your circle' },
}

// ---------------------------------------------------------------------------
// Pure decision helpers — unit-tested directly (notify.test.ts), no
// Notification/Capacitor access anywhere in this section.
// ---------------------------------------------------------------------------

/** How fresh an incoming, newly-recorded event must be to be worth a
 *  notification AT ALL — moved here from safety.ts's original
 *  `shouldNotifyForSafetyEvent` (kept there, and re-exported unchanged for
 *  places.ts, as a thin alias — see that file's own doc comment) unchanged in
 *  value and behaviour: a relay's stored-wrap replay on subscription open (up
 *  to ~16 days of history) must not re-fire a notification for every event in
 *  that history, every time. */
export const NOTIFY_FRESH_SEC = 600

/** Brief §29's consolidation window: a repeat of the SAME (kind, actor) within
 *  this many seconds of the last one that actually notified is collapsed —
 *  one notification per burst, not one per event. */
export const CONSOLIDATE_WINDOW_SEC = 300

/**
 * Whether a just-recorded event is fresh/new enough to be worth a
 * notification at all: `inserted` false means it was a dedupe (an id already
 * seen — e.g. a relay replay re-delivering the same event, never genuinely
 * new), and anything older than `freshSec` is stored-history, not news. Pure
 * — no store/Notification access — so every call site's "should I even
 * consider notifying" check is unit-testable without touching this module's
 * transport code at all. This is a SEPARATE gate from `shouldFireNotification`
 * below (consolidation) — both must pass for a notification to actually fire;
 * see `notify()`'s doc comment for why the two live at different layers.
 */
export function shouldNotifyForEvent(inserted: boolean, at: number, nowSecValue: number, freshSec: number = NOTIFY_FRESH_SEC): boolean {
  return inserted && nowSecValue - at <= freshSec
}

/**
 * Brief §29's consolidation rule, pure: given the last time a notification
 * for this exact (kind, actor) pair actually fired (`lastAt`, `undefined` if
 * never), should a NEW one fire now? `notify()` (below) is the only caller in
 * practice — it maintains `lastAt` itself, keyed by (kind, actor) — but kept
 * pure and exported so the collapsing rule itself is directly testable
 * without exercising the Notification API.
 */
export function shouldFireNotification(lastAt: number | undefined, nowSecValue: number, windowSec: number = CONSOLIDATE_WINDOW_SEC): boolean {
  return lastAt === undefined || nowSecValue - lastAt > windowSec
}

// ---------------------------------------------------------------------------
// Quiet hours (Phase 5 Task 1, brief §32.5) — a receiver-side LOCAL filter,
// wired inside `notify()` below as its one gate point: an ORDINARY kind's OS/
// web notification is HELD (dropped, not queued — a 7am flood would defeat
// the whole point, and Activity already has the record) while the device's
// own local clock falls inside `settings.quietHours`'s window. Never touches
// the wire, never touches Activity, never touches an in-app banner (e.g.
// places.ts's own private escalation banner) — every call site's
// `activity.recordActivity` (and any banner state) already ran BEFORE it
// calls `notify()`, entirely independent of whether the notification itself
// ends up held (verified by inspection: notify.ts never imports activity.ts).
// ---------------------------------------------------------------------------

/** The task-contract "always breaks through" kinds (brief §32.5) —
 *  time-critical safety/curfew events a guardian or child must see even
 *  overnight. Every OTHER `NotifyKind` is ORDINARY and is held while quiet
 *  hours are active (`checkin`, `arrival`, `departure`, `message`,
 *  `request`, `battery-low`, `agreement-status`, `safe-area-warning`,
 *  `window-reminder`). */
export const QUIET_EXEMPT_KINDS: ReadonlySet<NotifyKind> = new Set<NotifyKind>([
  'sos',
  'emergency-access',
  'safe-area-escalation',
  'pickup-requested',
  'pickup-status',
  'window-missed',
  'leave-reminder',
])

/**
 * Pure: is `localMinutes` (0-1439, device-local minutes-since-midnight)
 * currently inside `qh`'s quiet window? `undefined`, or `enabled: false`, is
 * never quiet. `start`/`end` are device-local `'HH:MM'` — parsed via
 * places.ts's `parseHHMM` (shared, not duplicated); a malformed value on
 * EITHER side fails safe to "not quiet" — a corrupt setting must never
 * accidentally hold every notification forever. The window is
 * inclusive-start, exclusive-end, and may cross midnight (`start > end` in
 * minutes, e.g. `22:00`-`07:00`): `start === end` (any valid, equal
 * `'HH:MM'`) means the WHOLE DAY counts as quiet while `enabled` — the "no
 * gap" edge case (a 24h window), not a config error.
 */
export function isQuietNow(qh: { enabled: boolean; start: string; end: string } | undefined, localMinutes: number): boolean {
  if (!qh || !qh.enabled) return false
  const startSec = parseHHMM(qh.start)
  const endSec = parseHHMM(qh.end)
  if (startSec === null || endSec === null) return false
  const start = Math.floor(startSec / 60)
  const end = Math.floor(endSec / 60)
  if (start === end) return true
  if (start < end) return localMinutes >= start && localMinutes < end
  return localMinutes >= start || localMinutes < end // crosses midnight
}

// ---------------------------------------------------------------------------
// notify() — the one impure entry point every domain module calls.
// ---------------------------------------------------------------------------

const nowSec = (): number => Math.floor(Date.now() / 1000)

/** `${kind}:${actorPk}` (empty string for a null actor) — the consolidation
 *  key: a repeat of the same kind from the same person collapses; a
 *  different actor (or a different kind from the same actor) does not. */
function consolidateKey(kind: NotifyKind, actorPk: string | null): string {
  return `${kind}:${actorPk ?? ''}`
}

const lastFiredAt = new Map<string, number>()

let nextNativeId = 1
/** Capacitor's LocalNotifications requires a 32-bit integer id per
 *  notification; nothing here ever needs to cancel one by id afterwards
 *  (unlike e.g. signet-app's approval banners), so a plain wrapping counter
 *  is enough to keep them from colliding within one session. */
function nextId(): number {
  const id = nextNativeId
  nextNativeId = nextNativeId >= 0x7fffffff ? 1 : nextNativeId + 1
  return id
}

let nativePermissionRequested = false
const createdChannels = new Set<NotifyCategory>()

async function nativeNotify(category: NotifyCategory, title: string, body: string): Promise<void> {
  try {
    const { LocalNotifications } = await import('@capacitor/local-notifications')
    if (!nativePermissionRequested) {
      nativePermissionRequested = true
      try {
        const perm = await LocalNotifications.checkPermissions()
        if (perm.display !== 'granted') await LocalNotifications.requestPermissions()
      } catch { /* best-effort — schedule() below still no-ops safely if denied */ }
    }
    if (!createdChannels.has(category)) {
      createdChannels.add(category)
      const ch = CHANNELS[category]
      try {
        await LocalNotifications.createChannel({ id: ch.id, name: ch.name, description: ch.description, importance: 4, visibility: 1 })
      } catch { /* channel already exists, or an older OS with no channel concept */ }
    }
    // smallIcon repeated per-call (capacitor.config.ts's `plugins.LocalNotifications.smallIcon`
    // already sets the same default) — belt-and-suspenders against the
    // launcher-icon fallback Android substitutes when none is resolved,
    // matching signet-app's own two-call-site convention (final review
    // follow-up, item 6/M-triage: "no custom notification small-icon").
    await LocalNotifications.schedule({ notifications: [{ id: nextId(), channelId: CHANNELS[category].id, title, body, smallIcon: 'ic_stat_kindependence' }] })
  } catch {
    // plugin unavailable (e.g. a dev build without `cap sync`) — the in-app
    // banner/log every call site already maintains is the fallback, same
    // "best-effort, never throws" discipline as beacons.ts's own outbox.
  }
}

/** Web transport — unchanged from the pre-Task-9 `notifyIfGranted` every
 *  call site used to define for itself: fires only if permission is ALREADY
 *  granted, never requests it (see the module doc comment). */
function webNotify(title: string, body: string): void {
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return
  try {
    new Notification(title, { body })
  } catch {
    // unsupported/blocked — the in-app banner/log already has this event
  }
}

/**
 * Fire a notification for `kind`, about `actorPk` (or `null` for one with no
 * single "who" — none of today's call sites need that, but the signature
 * leaves room). Collapses repeats per (kind, actor) within
 * `CONSOLIDATE_WINDOW_SEC` (brief §29, `shouldFireNotification` above) —
 * every OTHER gate (is this event fresh/newly-inserted at all —
 * `shouldNotifyForEvent`) is the CALLER's job, exactly as it was before this
 * task, just swapping the old `notifyIfGranted(title, body)` for this
 * `notify(kind, actorPk, title, body)`. Never throws.
 */
export async function notify(kind: NotifyKind, actorPk: string | null, title: string, body: string): Promise<void> {
  const key = consolidateKey(kind, actorPk)
  const now = nowSec()
  if (!shouldFireNotification(lastFiredAt.get(key), now)) return
  // Quiet hours (Phase 5 Task 1, brief §32.5) — AFTER the consolidation
  // check above (a collapsed repeat isn't "held", it was never novel to
  // begin with) but BEFORE the lastFiredAt stamp below: a HELD ordinary
  // notification must not consume this key's consolidation slot, so the
  // next genuine occurrence — once quiet hours end, or this device's clock
  // moves past the window — still fires instead of being silently
  // swallowed by its own held predecessor.
  if (!QUIET_EXEMPT_KINDS.has(kind)) {
    const nowDate = new Date()
    const localMinutes = nowDate.getHours() * 60 + nowDate.getMinutes()
    if (isQuietNow(store.load().settings.quietHours, localMinutes)) return
  }
  lastFiredAt.set(key, now)
  if (isNativePlatform()) {
    await nativeNotify(CATEGORY_FOR_KIND[kind], title, body)
  } else {
    webNotify(title, body)
  }
}
