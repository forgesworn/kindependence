// Kindependence's own vendored codec for the OLD flock-buzz payload shape.
//
// PROVENANCE: this is a faithful copy of flock-kit's PRE-eb96ce0 `src/buzz.ts`
// (commit 6fb1174 — the last revision before upstream replaced free-text buzz
// with a fixed coordination-action vocabulary). Upstream's new `decryptBuzz`
// THROWS on any free-text reason, so kindependence's whole rich vocabulary (circle
// chat, arrival/departure/not-yet, journey, pickup lifecycle, precise-request)
// can no longer ride flock's `t:'buzz'`. Kindependence keeps that vocabulary on its
// OWN inner signal type — `t:'kindependence-msg'` — whose payload is byte-identical
// to the old buzz `{from, reason, target?, timestamp, ask?}` and is group-
// envelope encrypted with the exact same canary-kit primitives.
//
// This module is the single source of truth for that wire, in BOTH directions:
//   - `buildKindependenceMsgSignal` — SEND: the unsigned kind-20078 `t:'kindependence-msg'`
//     signal every kindependence-specific send now builds (mirrors the old
//     `buildBuzzSignal` exactly, only the signal-type tag differs).
//   - `decodeLegacyBuzz` — RECEIVE (tolerant): decrypts + validates the old
//     payload shape. Used for BOTH `t:'kindependence-msg'` decode (same shape) AND
//     the legacy `t:'buzz'` free-text compatibility window (16-day relay replay
//     + phased device upgrades), where the NEW kit's `decryptBuzz` would throw.
//
// It imports ONLY canary-kit primitives (no app modules) so every send-side
// caller (messages/places/journey/pickup) can depend on it without an import
// cycle. The legacy SEND path on `t:'buzz'` is removed outright — kindependence
// never emits a free-text buzz again; this module only ever BUILDS on
// `t:'kindependence-msg'` and only ever DECODES (for compat) on either type.

import { buildSignalEvent, type UnsignedEvent } from 'canary-kit/nostr'
import { deriveGroupKey, encryptEnvelope, decryptEnvelope } from 'canary-kit/sync'

/** The `t`-tag value for kindependence's own rich-vocabulary signals — distinct
 *  from flock's `t:'buzz'` (a real flock client silently drops an unknown `t`,
 *  which is exactly the isolation we want: our free-text vocabulary never
 *  reaches a client that would now reject it). */
export const KINDEPENDENCE_MSG_SIGNAL_TYPE = 'kindependence-msg'

const HEX_64_RE = /^[0-9a-f]{64}$/
/** Old flock buzz `MAX_REASON` — the reason cap the whole app already assumes
 *  (`messages.MAX_CIRCLE_CHAT_LEN`, place/journey/pickup reasons all stay under
 *  it); `buildKindependenceMsgSignal` throws past it, same as the old kit did. */
const MAX_REASON = 280

/** A decoded kindependence-msg / legacy-buzz payload — the old flock `Buzz` shape. */
export interface LegacyBuzz {
  /** Sender pubkey (64-char hex). */
  from: string
  /** Free-text reason (kindependence's own vocabulary; preset or custom). */
  reason: string
  /** Optional recipient the message is aimed at (64-char hex); absent = whole circle. */
  target?: string
  /** Unix seconds. */
  timestamp: number
  /** Optional roll-call ask, only ever `'location'`; unknown values are dropped. */
  ask?: 'location'
}

function validateReason(reason: string): string {
  const r = (reason ?? '').trim()
  if (!r) throw new Error('reason must be a non-empty string')
  if (r.length > MAX_REASON) throw new Error(`reason must be at most ${MAX_REASON} characters`)
  return r
}

/**
 * Build an unsigned kind-20078 `t:'kindependence-msg'` signal, group-envelope
 * encrypted — the exact wire the old `buildBuzzSignal` produced, only the
 * signal-type tag differs. Payload shape is identical: `{from, reason,
 * timestamp, target?, ask?}`.
 *
 * @throws {Error} If `from`/`target` are not valid hex pubkeys or `reason` is empty/too long.
 */
export async function buildKindependenceMsgSignal(params: {
  groupId: string
  seedHex: string
  from: string
  reason: string
  target?: string
  timestamp?: number
  ask?: 'location'
}): Promise<UnsignedEvent> {
  if (!HEX_64_RE.test(params.from)) throw new Error('from must be a 64-character lowercase hex pubkey')
  if (params.target !== undefined && !HEX_64_RE.test(params.target)) {
    throw new Error('target must be a 64-character lowercase hex pubkey')
  }
  if (params.ask !== undefined && params.ask !== 'location') {
    throw new Error("ask must be 'location' when present")
  }
  const reason = validateReason(params.reason)
  const payload: LegacyBuzz = {
    from: params.from,
    reason,
    timestamp: params.timestamp ?? Math.floor(Date.now() / 1000),
    ...(params.target !== undefined && { target: params.target }),
    ...(params.ask !== undefined && { ask: params.ask }),
  }
  const encryptedContent = await encryptEnvelope(deriveGroupKey(params.seedHex), JSON.stringify(payload))
  return buildSignalEvent({ groupId: params.groupId, signalType: KINDEPENDENCE_MSG_SIGNAL_TYPE, encryptedContent })
}

/**
 * Decrypt + validate an old-shape payload with the group envelope key. Used
 * for `t:'kindependence-msg'` (kindependence's own vocabulary) AND, on the compat
 * window, legacy `t:'buzz'` free-text. Throws on anything malformed — callers
 * wrap in try/catch and drop silently on failure.
 */
export async function decodeLegacyBuzz(seedHex: string, content: string): Promise<LegacyBuzz> {
  const plaintext = await decryptEnvelope(deriveGroupKey(seedHex), content)
  let parsed: unknown
  try {
    parsed = JSON.parse(plaintext)
  } catch {
    throw new Error('Invalid payload: not valid JSON')
  }
  const o = parsed as Record<string, unknown>
  if (typeof o.from !== 'string' || !HEX_64_RE.test(o.from)) {
    throw new Error('Invalid payload: from must be a 64-character lowercase hex pubkey')
  }
  if (typeof o.reason !== 'string' || o.reason.trim().length === 0 || o.reason.length > MAX_REASON) {
    throw new Error('Invalid payload: reason missing or malformed')
  }
  if (typeof o.timestamp !== 'number' || !Number.isFinite(o.timestamp)) {
    throw new Error('Invalid payload: timestamp must be a number')
  }
  if (o.target !== undefined && (typeof o.target !== 'string' || !HEX_64_RE.test(o.target))) {
    throw new Error('Invalid payload: target must be a 64-character lowercase hex pubkey')
  }
  return {
    from: o.from,
    reason: o.reason,
    timestamp: o.timestamp,
    ...(typeof o.target === 'string' && { target: o.target }),
    // Unknown ask values are DROPPED, not fatal — a future ask kind must not
    // make today's client throw away the human-readable message carrying it.
    ...(o.ask === 'location' && { ask: 'location' as const }),
  }
}
