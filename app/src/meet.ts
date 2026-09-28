// Temporary meeting points + rendezvous-kit fair-spot suggestion (Phase 4
// Task 5, brief §6.6-6.7). Same render-on-state/registration idioms as every
// other domain module here (places.ts in particular — the wire/store shape
// below mirrors its `kindependence-places` companion signal almost exactly):
// `ensure()` is the one side-effecting entry point (registers with
// beacons.ts's circle-inbox dispatch, starts a light countdown-refresh
// timer); `view()`/`handleAction()` own this module's UI; the pure section
// below (wire encode/decode, expiry) is unit-tested in isolation
// (meet.test.ts).
//
// A meeting point is deliberately NOT a `Place` (places.ts): it has no
// geofence/escalation semantics at all, is short-lived by construction
// (every point carries its own `expiresAt`), and any circle member — not
// only a guardian — may propose one. It's a plain marker + a shared,
// synced expiry, nothing more.
//
// Wire — ONE signal, `t:'kindependence-meet'`, gift-wrapped to the circle's
// shared inbox exactly like every other kindependence companion payload
// (unencrypted-but-gift-wrapped kind-20078 rumor, BROOD's own
// `buildBroodInner` pattern — see places.ts's own module doc comment for why
// a second encryption layer buys nothing here): full-set-replacement,
// latest-wins, reusing flock's own `isNewerFenceSet` clock check UNMODIFIED
// (it only needs `{updatedAt, by}, same as places.ts already does). There is
// no flock-interop half here (no `fences` signal) — a meeting point has no
// geometry a plain flock client could usefully render anyway, so unlike
// places.ts this is a single-signal wire, not a pair.
//
// PRIVACY (binding, task contract): the fair-spot suggestion itself
// (`suggestMeetSpot`, travel.ts) never contacts anything but the user's own
// opted-in `settings.routingUrl` (routing/isochrones) and, independently,
// `settings.overpassUrl` (review-minor: its own separate field, no longer
// `routingUrl` reused) for the venue search — reachable at all only when
// `settings.meetVenues` (default OFF) is ALSO on, the venue gate — see
// travel.ts's own module doc comment for the full reasoning, including why
// this deliberately doesn't call rendezvous-kit's own `findRendezvous`
// directly.

import * as store from './store.js'
import { clearFields } from './form-state.js'
import * as beacons from './beacons.js'
import * as activity from './activity.js'
import { appRelays } from './circles.js'
import { heuristicTravelSec, suggestMeetSpot, type MeetParticipant, type MeetSuggestion } from './travel.js'
import { currentSession, phoneSigner } from './session.js'
import { deriveInbox, isGuardian, toHex } from '@forgesworn/covey-kit'
import type { Circle } from '@forgesworn/covey-kit'
import { giftWrap } from '@forgesworn/roost-kit'
import type { Rumor, Signer, SignedEvent } from '@forgesworn/roost-kit'
import { isNewerFenceSet } from '@forgesworn/flock/fences'
import { encode as encodeGeohash, decode as decodeGeohash } from 'geohash-kit'
import { KINDS } from 'canary-kit/nostr'

const nowSec = (): number => Math.floor(Date.now() / 1000)

// ---------------------------------------------------------------------------
// Constants + shape — task-contract verbatim.
// ---------------------------------------------------------------------------

export const MEET_SIGNAL_TYPE = 'kindependence-meet'

export interface MeetPoint {
  id: string
  name: string
  centre: { lat: number; lon: number }
  /** Unix seconds — once passed, `liveMeetPoints` filters this point out of
   *  every render/evaluation, though it (deliberately) isn't proactively
   *  purged from the synced set until the next edit — same "no separate
   *  healing pass" scope-down as places.ts's own known v1 gap. */
  expiresAt: number
  createdBy: string
  createdAt: number
}

export const MAX_MEET_POINTS = 10
export const MAX_MEET_NAME_LEN = 40

function randomHex(byteLen: number): string {
  return toHex(crypto.getRandomValues(new Uint8Array(byteLen)))
}

/** A fresh meeting-point id — unlinkability handle, not a secret, same idiom
 *  as places.ts's `newPlaceId`. */
export function newMeetId(): string {
  return randomHex(8)
}

// ---------------------------------------------------------------------------
// Expiry — the create form's four choices (task contract, verbatim).
// ---------------------------------------------------------------------------

export type MeetExpiryChoice = '1h' | '3h' | 'today-22' | '24h'

export const MEET_EXPIRY_CHOICES: ReadonlyArray<{ id: MeetExpiryChoice; label: string }> = [
  { id: '1h', label: '1 hour' },
  { id: '3h', label: '3 hours' },
  { id: 'today-22', label: 'Until 10pm today' },
  { id: '24h', label: '24 hours' },
]

/** `choice` resolved against `nowSecValue` into an absolute unix-seconds
 *  `expiresAt`. `'today-22'` rolls to TOMORROW's 22:00 when `nowSecValue` is
 *  already at or past 22:00 local time today (rather than either rejecting
 *  the choice or producing an `expiresAt` in the past) — the same "fail to
 *  the safe, still-usable interpretation" spirit as places.ts's own
 *  `windowCrossesMidnight` guard, just resolved silently here since this is
 *  a plain expiry pick, not a recurring schedule someone could misconfigure. */
export function computeExpiresAt(choice: MeetExpiryChoice, nowSecValue: number): number {
  switch (choice) {
    case '1h': return nowSecValue + 3600
    case '3h': return nowSecValue + 3 * 3600
    case '24h': return nowSecValue + 24 * 3600
    case 'today-22': {
      const d = new Date(nowSecValue * 1000)
      d.setHours(22, 0, 0, 0)
      let end = Math.floor(d.getTime() / 1000)
      if (end <= nowSecValue) end += 24 * 3600
      return end
    }
  }
}

/** Points whose `expiresAt` is still in the future relative to
 *  `nowSecValue` — pure, the one expiry filter every reader (the map, the
 *  create-form cap check, the tap sheet) shares. */
export function liveMeetPoints(points: readonly MeetPoint[], nowSecValue: number): MeetPoint[] {
  return points.filter((p) => p.expiresAt > nowSecValue)
}

// ---------------------------------------------------------------------------
// Wire — full-set, gift-wrapped, latest-wins (mirrors places.ts's
// `PlacesMetaSignal`/`buildPlacesWraps`/`parsePlacesMetaSignal` exactly, one
// signal instead of two — see the module doc comment).
// ---------------------------------------------------------------------------

interface MeetSignal {
  t: typeof MEET_SIGNAL_TYPE
  circleId: string
  points: MeetPoint[]
  updatedAt: number
  by: string
}

function buildMeetInner(circleId: string, points: readonly MeetPoint[], updatedAt: number, by: string): { kind: number; content: string; tags: string[][]; created_at: number } {
  const signal: MeetSignal = { t: MEET_SIGNAL_TYPE, circleId, points: [...points], updatedAt, by }
  return { kind: KINDS.signal, content: JSON.stringify(signal), tags: [['t', MEET_SIGNAL_TYPE]], created_at: updatedAt }
}

/** Builds the gift-wrapped `kindependence-meet` signal for a circle's complete
 *  meeting-point set. Pure apart from the gift-wrap call, directly
 *  round-trip testable without a relay — same shape as places.ts's
 *  `buildPlacesWraps`. */
export async function buildMeetWrap(
  signer: Signer,
  circle: Circle,
  points: readonly MeetPoint[],
  updatedAt: number,
  by: string,
): Promise<SignedEvent> {
  const inner = buildMeetInner(circle.id, points, updatedAt, by)
  const inbox = deriveInbox(circle.seedHex)
  return giftWrap(signer, inbox.pk, inner, inbox.pk)
}

function parseMeetPoint(o: unknown): MeetPoint | null {
  if (typeof o !== 'object' || o === null) return null
  const r = o as Record<string, unknown>
  if (typeof r.id !== 'string' || !r.id) return null
  if (typeof r.name !== 'string') return null
  const centre = r.centre as { lat?: unknown; lon?: unknown } | undefined
  if (!centre || typeof centre.lat !== 'number' || typeof centre.lon !== 'number' || !Number.isFinite(centre.lat) || !Number.isFinite(centre.lon)) return null
  if (typeof r.expiresAt !== 'number' || !Number.isFinite(r.expiresAt)) return null
  if (typeof r.createdBy !== 'string' || !r.createdBy) return null
  if (typeof r.createdAt !== 'number' || !Number.isFinite(r.createdAt)) return null
  return {
    id: r.id,
    name: r.name.slice(0, MAX_MEET_NAME_LEN),
    centre: { lat: centre.lat, lon: centre.lon },
    expiresAt: r.expiresAt,
    createdBy: r.createdBy,
    createdAt: r.createdAt,
  }
}

/** Decode + strictly validate a `kindependence-meet` rumor's content — same
 *  all-or-nothing discipline as places.ts's `parsePlacesMetaSignal`: any
 *  malformed point rejects the WHOLE set. Never throws; `null` for anything
 *  malformed, wrong-circle, or oversized. */
export function parseMeetSignal(content: string, expectedCircleId: string): { points: MeetPoint[]; updatedAt: number; by: string } | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(content)
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const r = parsed as Record<string, unknown>
  if (r.t !== MEET_SIGNAL_TYPE) return null
  if (r.circleId !== expectedCircleId) return null
  if (typeof r.updatedAt !== 'number' || typeof r.by !== 'string') return null
  if (!Array.isArray(r.points) || r.points.length > MAX_MEET_POINTS) return null
  const points: MeetPoint[] = []
  for (const raw of r.points) {
    const pt = parseMeetPoint(raw)
    if (!pt) return null
    points.push(pt)
  }
  return { points, updatedAt: r.updatedAt, by: r.by }
}

// ---------------------------------------------------------------------------
// Outbound — any circle member may create; a full-set publish either way
// (mirrors places.ts's `savePlaces`/`addPlace`/`deletePlace`, minus the
// guardian-only gate places.ts applies at the SAVE step — see
// `deleteMeetPoint`'s own doc comment for where the permission check here
// actually lives instead).
// ---------------------------------------------------------------------------

async function saveMeetPoints(circleId: string, points: MeetPoint[]): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle) return
  const at = nowSec()
  store.update((sp) => {
    sp.meetPoints = { ...sp.meetPoints, [circleId]: points }
    sp.meetMeta = { ...sp.meetMeta, [circleId]: { updatedAt: at, by: self.identityPk } }
  })
  const wrap = await buildMeetWrap(phoneSigner(), circle, points, at, self.identityPk)
  await beacons.publishOrEnqueue(appRelays(p), wrap)
}

export interface NewMeetDraft {
  name: string
  centre: { lat: number; lon: number }
  expiresAt: number
}

/** Appends a fresh point to `circleId`'s LIVE set (already-expired points
 *  are dropped from the published set at this point too, so a stale point
 *  never blocks room for a new one against `MAX_MEET_POINTS`, and the wire
 *  payload doesn't grow with dead entries forever). Silently no-ops without
 *  a signed-in identity/known circle, or once the live set is already at
 *  capacity — same "quiet cap, no error UI" convention as places.ts's
 *  `addPlace`. */
export async function addMeetPoint(circleId: string, draft: NewMeetDraft): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle) return
  const at = nowSec()
  const current = liveMeetPoints(p.meetPoints[circleId] ?? [], at)
  if (current.length >= MAX_MEET_POINTS) return
  const point: MeetPoint = {
    id: newMeetId(),
    name: draft.name.slice(0, MAX_MEET_NAME_LEN),
    centre: draft.centre,
    expiresAt: draft.expiresAt,
    createdBy: self.identityPk,
    createdAt: at,
  }
  await saveMeetPoints(circleId, [...current, point])
  activity.recordActivity({
    // Review queue item 2 (Phase 7 Task 5): `point.id` appended, same as
    // `deleteMeetPoint`'s own `-del-${pointId}` suffix just below — without
    // it, two meet points created in the same circle within the same
    // wall-clock second collide on the bare
    // `local-meet-point-<at>-<circleId>` id (inherited gap, pins.ts's
    // `dropPin` had the same one — see that fix).
    id: `${activity.localActivityId('meet-point', at, circleId)}-${point.id}`,
    at, kind: 'meet-point', circleId, actorPk: self.identityPk,
    params: { name: point.name, action: 'created' },
  })
}

/** Removes `pointId` from `circleId`'s set — gated here (not at
 *  `saveMeetPoints`, unlike places.ts's guardian-only `savePlaces`) since
 *  who may delete depends on the INDIVIDUAL point (its own creator, or any
 *  guardian), not a blanket per-circle role check. Silently no-ops for
 *  anyone else, an unknown point, or a signed-out/unknown circle. */
export async function deleteMeetPoint(circleId: string, pointId: string): Promise<void> {
  const p = store.load()
  const self = currentSession()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!self || !circle) return
  const current = p.meetPoints[circleId] ?? []
  const target = current.find((pt) => pt.id === pointId)
  if (!target) return
  const canDelete = target.createdBy === self.identityPk || isGuardian(circle, self.identityPk)
  if (!canDelete) return
  const at = nowSec()
  await saveMeetPoints(circleId, current.filter((pt) => pt.id !== pointId))
  activity.recordActivity({
    id: activity.localActivityId('meet-point', at, circleId) + `-del-${pointId}`,
    at, kind: 'meet-point', circleId, actorPk: self.identityPk,
    params: { name: target.name, action: 'deleted' },
  })
}

// ---------------------------------------------------------------------------
// Incoming — registered with beacons.ts as an additional handler for
// non-beacon circle-inbox signals (see places.ts's own doc comment on
// `setSignalHandler` for the shared-dispatch contract every handler here
// follows).
// ---------------------------------------------------------------------------

function applyIncomingMeet(circleId: string, points: MeetPoint[], updatedAt: number, by: string): void {
  store.update((p) => {
    const current = p.meetMeta[circleId]
    const newer = isNewerFenceSet({ updatedAt, by }, current ? { fencesUpdatedAt: current.updatedAt, fencesBy: current.by } : undefined)
    if (!newer) return
    // sender-auth: ffb48b9 class, LOOSENED per review (Phase 7 Task 1 fix
    // wave): the original rule required a point new to this device to be
    // self-attributed by the signal's own sender — but full-set
    // carry-forward (any member may resend another's earlier points
    // alongside their own, see the module doc comment's wire section) means
    // a late joiner receiving a multi-author set from a non-creator member
    // is entirely legitimate, and the old rule dropped the WHOLE set for it,
    // stranding the joiner until the circle's creator happened to republish
    // directly. What's still preserved (anti-reattribution, the actual
    // security property here): an ALREADY-KNOWN point's `createdBy` is
    // immutable once this device has trusted an attribution — no later
    // resync, by any sender, may rewrite it. A point new to this device
    // simply accepts whatever `createdBy` it carries; the signal's sender is
    // already authenticated (`by === sender.memberPk`, checked by the caller
    // above) even though it may differ from any individual point's creator.
    // Any reattribution of a known point drops the WHOLE incoming set, same
    // "never partially apply" discipline as `parseMeetSignal`'s own
    // one-bad-point rejection.
    const priorById = new Map((p.meetPoints[circleId] ?? []).map((pt) => [pt.id, pt]))
    for (const pt of points) {
      const prior = priorById.get(pt.id)
      if (prior && pt.createdBy !== prior.createdBy) return
    }
    p.meetPoints = { ...p.meetPoints, [circleId]: points }
    p.meetMeta = { ...p.meetMeta, [circleId]: { updatedAt, by } }
  })
}

/** Registered with beacons.ts's circle-inbox dispatch. Ignores its own
 *  echo, same discipline as every other handler in this codebase. */
export function handleIncomingSignal(circle: Circle, rumor: Rumor, t: string, sender: beacons.Sender): void {
  if (t !== MEET_SIGNAL_TYPE) return
  const self = currentSession()
  if (self && sender.signerPk === self.phonePk) return
  const parsed = parseMeetSignal(rumor.content, circle.id)
  if (!parsed) return
  // sender-auth: ffb48b9 class — `by` claims who last updated this circle's
  // meeting-point set (the clock-tiebreak actor); it must equal the
  // now-authenticated resolved sender, else the update is dropped wholesale.
  if (parsed.by !== sender.memberPk) return
  applyIncomingMeet(circle.id, parsed.points, parsed.updatedAt, parsed.by)
}

// ---------------------------------------------------------------------------
// ensure() — the one side-effecting entry point, called from app.ts's
// render() (idempotent, identity-independent, same convention as
// places.ts/safety.ts/agreements.ts). The light timer here only refreshes
// the countdown/expiry display (map markers, the tap sheet) — there's no
// evaluation state machine to run, unlike places.ts's own `tick()`.
// ---------------------------------------------------------------------------

const TICK_INTERVAL_MS = 30_000

/** Exported for direct unit testing (final-review fix 5) — otherwise only
 *  ever invoked by `ensure()`'s own `setInterval`. */
export function tick(): void {
  const p = store.load()
  const now = nowSec()
  // Final-review fix 5: gate on LIVE points (`liveMeetPoints`), not raw
  // `list.length`. A meet point isn't proactively purged from
  // `p.meetPoints` once it expires (see `MeetPoint.expiresAt`'s own doc
  // comment) — with the raw-length check, a circle whose points had all
  // long since expired would still re-notify every 30s forever (nothing
  // left to refresh a countdown for), a needless render every tick for the
  // rest of the session.
  const anyLive = Object.values(p.meetPoints).some((list) => liveMeetPoints(list, now).length > 0)
  if (anyLive) store.notify()
}

let registered = false
export function ensure(): void {
  if (registered) return
  registered = true
  beacons.setSignalHandler(handleIncomingSignal)
  setInterval(tick, TICK_INTERVAL_MS)
}

// ---------------------------------------------------------------------------
// View — the Map tab's "Add meeting point here" button + inline creation
// form (same button-not-long-press choice places.ts documents at length —
// this app has no long-press gesture layered onto the map canvas), the tap
// sheet, and the You-tab advanced routing settings. UI wiring only past this
// point — no unit tests (build-gated), same convention as every other
// domain module here. esc() on every wire-derived string (point names) per
// global-constraints.md.
// ---------------------------------------------------------------------------

const esc = (s: string): string =>
  s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c] as string)

function shortPk(pk: string): string {
  return `${pk.slice(0, 8)}…`
}

interface MeetFormState {
  circleId?: string
  lat: number
  lon: number
  name: string
  choice: MeetExpiryChoice
  suggestion?: MeetSuggestion
  suggesting?: boolean
  error?: string
}
let formState: MeetFormState | null = null

/** Opens the "add a meeting point" form centred on `centre` — app.ts's
 *  `meet-add-here` action (which alone holds the live MapView's centre)
 *  calls this, mirroring `places.openPlaceForm` exactly. */
export function openMeetForm(centre: { lat: number; lon: number }): void {
  formState = { lat: centre.lat, lon: centre.lon, name: '', choice: '1h' }
  store.notify()
}
function closeMeetForm(): void {
  formState = null
  store.notify()
}

/** The Map tab's "Add meeting point here" button — any signed-in member of
 *  at least one circle may propose a meeting point (unlike places.ts's
 *  guardian-only equivalent). */
export function mapOverlayView(p: store.Persisted): string {
  if (!currentSession() || !p.circles.length) return ''
  return `<button type="button" class="map-chip meet-add" data-action="meet-add-here">Add meeting point here</button>`
}

/** Every live position this device currently knows for `circle`'s members —
 *  `suggestMeetSpot`'s participant list, and the tap sheet's per-member
 *  distance rows below. Members with no recent fix are simply absent (there
 *  is nothing to estimate a distance/suggestion from for them). */
function knownMemberPositions(circle: Circle): Array<{ pk: string; name: string; lat: number; lon: number }> {
  const merged = beacons.mergeMemberPositions([circle], beacons.memberPositions)
  const out: Array<{ pk: string; name: string; lat: number; lon: number }> = []
  for (const m of circle.members) {
    const entry = merged.get(m.pk)
    if (!entry) continue
    const { lat, lon } = decodeGeohash(entry.pos.geohash)
    out.push({ pk: m.pk, name: m.name || shortPk(m.pk), lat, lon })
  }
  return out
}

export function formView(p: store.Persisted): string {
  if (!formState) return ''
  const state = formState
  if (!p.circles.length) return ''
  const circleOptions = p.circles.map((c) => `<option value="${esc(c.id)}"${c.id === state.circleId ? ' selected' : ''}>${esc(c.name)}</option>`).join('')
  const expiryRadios = MEET_EXPIRY_CHOICES.map((choice, i) => `
    <label class="confirm-gate"><input type="radio" name="meet-expiry" value="${choice.id}"${choice.id === state.choice ? ' checked' : (i === 0 && !state.choice ? ' checked' : '')} /> ${esc(choice.label)}</label>`).join('')
  const err = state.error ? `<p class="form-error">${esc(state.error)}</p>` : ''
  const suggestion = state.suggestion
    ? `<p class="muted small">Suggested: ${esc(state.suggestion.label)}${state.suggestion.source === 'centroid' ? ' (straight-line middle — no routing engine configured)' : ''}</p>`
    : ''
  const suggestBtn = `<button type="button" data-action="meet-suggest"${state.suggesting ? ' disabled' : ''}>${state.suggesting ? 'Finding a fair spot…' : 'Suggest fair spot'}</button>`
  return `
    <div class="place-form">
      <h3>Add a meeting point</h3>
      <select id="meet-circle">${circleOptions}</select>
      <input id="meet-name" type="text" maxlength="${MAX_MEET_NAME_LEN}" placeholder="Name (e.g. Park gate)" value="${esc(state.name)}" />
      <div class="schedule-chips">${expiryRadios}</div>
      ${suggestBtn}
      ${suggestion}
      ${err}
      <div class="sheet-actions">
        <button type="button" data-action="meet-form-submit">Save meeting point</button>
        <button type="button" data-action="meet-form-cancel">Cancel</button>
      </div>
    </div>`
}

function inputValue(id: string): string {
  return (document.getElementById(id) as HTMLInputElement | null)?.value.trim() ?? ''
}

/** "Suggest fair spot" — the ONLY place in this module that ever touches
 *  the network (via travel.ts's `suggestMeetSpot`, itself never throwing
 *  and never contacting anything but `settings.routingUrl` and,
 *  independently, `settings.overpassUrl`). Uses every circle member's
 *  currently-known position as a participant; a circle with fewer than 2
 *  known positions still resolves (via `suggestMeetSpot`'s own centroid
 *  fallback), just without anything meaningfully "fair" to offer. */
async function suggestFairSpot(): Promise<void> {
  if (!formState) return
  const circleId = (document.getElementById('meet-circle') as HTMLSelectElement | null)?.value ?? formState.circleId
  const p = store.load()
  const circle = p.circles.find((c) => c.id === circleId)
  if (!circle) return
  formState = { ...formState, circleId, suggesting: true, error: undefined }
  store.notify()
  const participants: MeetParticipant[] = knownMemberPositions(circle).map((m) => ({ lat: m.lat, lon: m.lon, label: m.name }))
  const suggestion = await suggestMeetSpot(participants, p.settings.routingUrl, p.settings.overpassUrl, p.settings.meetVenues === true)
  if (!formState) return // form was cancelled while the suggestion was in flight
  formState = {
    ...formState,
    circleId,
    lat: suggestion.centre.lat,
    lon: suggestion.centre.lon,
    name: formState.name || suggestion.label,
    suggestion,
    suggesting: false,
  }
  store.notify()
}

function submitMeetForm(): void {
  if (!formState) return
  const circleId = (document.getElementById('meet-circle') as HTMLSelectElement | null)?.value ?? ''
  const name = inputValue('meet-name')
  const choiceRaw = (document.querySelector('input[name="meet-expiry"]:checked') as HTMLInputElement | null)?.value
  const choice = MEET_EXPIRY_CHOICES.some((c) => c.id === choiceRaw) ? (choiceRaw as MeetExpiryChoice) : undefined

  if (!circleId) { formState = { ...formState, circleId, error: 'Choose a circle.' }; store.notify(); return }
  if (!name) { formState = { ...formState, circleId, error: 'Enter a name for this meeting point.' }; store.notify(); return }
  if (!choice) { formState = { ...formState, circleId, error: 'Choose how long this meeting point should last.' }; store.notify(); return }

  const draft: NewMeetDraft = { name, centre: { lat: formState.lat, lon: formState.lon }, expiresAt: computeExpiresAt(choice, nowSec()) }
  clearFields(['meet-circle', 'meet-name']) // submitted: the form starts afresh
  formState = null
  store.notify()
  void addMeetPoint(circleId, draft)
}

// ---------------------------------------------------------------------------
// Tap sheet — opened from a map marker tap (app.ts wires MapView's
// `onMeetSelect` callback to `openMeetSheet`), same "own module-level
// ephemeral UI state" idiom as `formState` above.
// ---------------------------------------------------------------------------

let sheetPointId: string | null = null

export function openMeetSheet(id: string): void {
  sheetPointId = id
  store.notify()
}
export function closeMeetSheet(): void {
  sheetPointId = null
  store.notify()
}

/** Finds `id` across every circle's meeting-point set — meet point ids are
 *  random 8-byte handles (`newMeetId`), so a bare id (no circleId) is
 *  enough to locate the owning circle without MapView needing to track
 *  per-marker circle ownership itself. */
function findMeetPoint(p: store.Persisted, id: string): { circle: Circle; point: MeetPoint } | undefined {
  for (const circle of p.circles) {
    const point = (p.meetPoints[circle.id] ?? []).find((pt) => pt.id === id)
    if (point) return { circle, point }
  }
  return undefined
}

function formatCountdown(remainingSec: number): string {
  if (remainingSec <= 0) return 'Expired'
  if (remainingSec < 3600) return `${Math.ceil(remainingSec / 60)} min left`
  return `${Math.ceil(remainingSec / 3600)} h left`
}

function formatWalkTime(sec: number): string {
  const min = Math.max(1, Math.round(sec / 60))
  return `~${min} min walk`
}

/** The tap sheet — name, live countdown, every known member's heuristic
 *  (on-device, no-network — task contract: "per-member distance via
 *  heuristic always, engine distances only in the suggest flow") walking
 *  distance, Navigate/Copy (reusing app.ts's EXISTING `map-sheet-navigate`/
 *  `map-sheet-copy` wiring — see their own doc comment in app.ts for why a
 *  meeting point's precise centre can ride the same
 *  `data-geohash`/`data-precision` dataset contract those actions already
 *  read, with zero new app.ts dispatch needed), and delete (creator or any
 *  guardian). `''` when no sheet is open, or the id no longer resolves
 *  (e.g. the point was deleted from another device between renders). */
export function sheetView(p: store.Persisted): string {
  if (!sheetPointId) return ''
  const self = currentSession()
  if (!self) return ''
  const found = findMeetPoint(p, sheetPointId)
  if (!found) return ''
  const { circle, point } = found
  const now = nowSec()
  const countdown = formatCountdown(point.expiresAt - now)
  const canDelete = point.createdBy === self.identityPk || isGuardian(circle, self.identityPk)
  const merged = beacons.mergeMemberPositions([circle], beacons.memberPositions)
  const rows = circle.members.map((m) => {
    const entry = merged.get(m.pk)
    const label = esc(m.name || shortPk(m.pk))
    if (!entry) return `<li class="contact-item">${label}<span class="badge">No recent location</span></li>`
    const { lat, lon } = decodeGeohash(entry.pos.geohash)
    const sec = heuristicTravelSec({ lat, lon }, point.centre, 'walk')
    return `<li class="contact-item">${label}<span class="badge">${esc(formatWalkTime(sec))}</span></li>`
  }).join('')
  const geohash = encodeGeohash(point.centre.lat, point.centre.lon, 9)
  const navAttrs = ` data-geohash="${esc(geohash)}" data-precision="9"`
  const deleteBtn = canDelete
    ? `<button type="button" data-action="meet-delete" data-circle="${esc(circle.id)}" data-id="${esc(point.id)}">Remove</button>`
    : ''
  return `
    <div class="place-form">
      <h3>${esc(point.name)}</h3>
      <p class="muted small">${esc(countdown)} · ${esc(circle.name)}</p>
      <ul class="contact-list">${rows}</ul>
      <div class="sheet-actions">
        <button type="button" data-action="map-sheet-navigate"${navAttrs}>Navigate</button>
        <button type="button" data-action="map-sheet-copy"${navAttrs}>Copy location</button>
        ${deleteBtn}
        <button type="button" data-action="meet-sheet-close">Close</button>
      </div>
    </div>`
}

// ---------------------------------------------------------------------------
// You-tab advanced section — routing URL + venues toggle (task contract).
// ---------------------------------------------------------------------------

// Review-minor: softened now that the venue search has its own separate
// `overpassUrl` field, never `routingUrl` — the note used to say "your
// routing server's Overpass endpoint", which no longer describes what
// actually gets contacted.
const MEET_VENUES_NOTE = 'Suggesting a fair spot sends the search area to the Overpass server you configure — never a public one.'

export function settingsView(p: store.Persisted): string {
  const routingUrl = p.settings.routingUrl ?? ''
  const overpassUrl = p.settings.overpassUrl ?? ''
  const venuesOn = p.settings.meetVenues === true
  return `
    <section class="contact-group">
      <h2>Meeting-point routing (advanced)</h2>
      <p class="muted small">
        Optional: point kindependence at your own self-hosted routing engine
        (Valhalla or OSRM) to estimate real travel times and suggest a fair
        meeting spot. Left blank, everything stays on this device — a plain
        straight-line estimate, never sent anywhere.
      </p>
      <input id="meet-routing-url" type="text" placeholder="https://your-routing-server" value="${esc(routingUrl)}" />
      <div class="sheet-actions">
        <button type="button" data-action="meet-routing-url-save">Save</button>
      </div>
      <p class="muted small">
        Optional: point kindependence at your own self-hosted Overpass-compatible
        server to suggest a real venue (cafe, park, library…) inside the fair
        spot, instead of just an unnamed point. Separate from the routing
        server above — a self-hoster who runs only one of the two can leave
        the other blank.
      </p>
      <input id="meet-overpass-url" type="text" placeholder="https://your-overpass-server" value="${esc(overpassUrl)}" />
      <div class="sheet-actions">
        <button type="button" data-action="meet-overpass-url-save">Save</button>
      </div>
      <button type="button" class="precision-chip" data-action="meet-venues-toggle" aria-current="${venuesOn}">
        Suggest real venues (uses Overpass)
      </button>
      <p class="muted small">${esc(MEET_VENUES_NOTE)}</p>
    </section>`
}

function saveRoutingUrl(): void {
  const raw = inputValue('meet-routing-url')
  store.update((p) => {
    p.settings = { ...p.settings, routingUrl: raw || undefined }
  })
}

function saveOverpassUrl(): void {
  const raw = inputValue('meet-overpass-url')
  store.update((p) => {
    p.settings = { ...p.settings, overpassUrl: raw || undefined }
  })
}

// ---------------------------------------------------------------------------
// Action dispatch — app.ts delegates every `meet-*` action here, EXCEPT
// `meet-add-here` (needs the live MapView's centre, same as places.ts's own
// `places-add-here` carve-out).
// ---------------------------------------------------------------------------

export function handleAction(action: string, node: HTMLElement): void {
  switch (action) {
    case 'meet-form-submit':
      submitMeetForm()
      break
    case 'meet-form-cancel':
      closeMeetForm()
      break
    case 'meet-suggest':
      void suggestFairSpot()
      break
    case 'meet-delete':
      void deleteMeetPoint(node.dataset.circle ?? '', node.dataset.id ?? '')
      closeMeetSheet()
      break
    case 'meet-sheet-close':
      closeMeetSheet()
      break
    case 'meet-routing-url-save':
      saveRoutingUrl()
      break
    case 'meet-overpass-url-save':
      saveOverpassUrl()
      break
    case 'meet-venues-toggle':
      store.update((p) => {
        p.settings = { ...p.settings, meetVenues: !(p.settings.meetVenues === true) }
      })
      break
    default:
      break
  }
}
