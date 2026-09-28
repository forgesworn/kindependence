// Brood signal parser — see ../BROOD.md §7.4 ("strict parsing, never partial
// trust") and §7.5 ("unknown t is routine, not an error").
//
// `parseBroodSignal` takes the decrypted/unwrapped inner event (kind, tags,
// content — the mirror image of `build.ts`'s `BroodInnerEvent`) and either
// returns a fully-validated `BroodSignal` or `null`. It never throws: an
// unrecognized `t` (a flock signal sharing the same inbox, or a future
// brood type this version hasn't been taught) and a malformed payload are
// both just "not a signal I can use" to the caller, who is expected to
// ignore `null` rather than treat it as an exceptional error.
//
// Every field is rebuilt explicitly from the decoded JSON rather than cast
// wholesale — a single malformed field discards the whole signal.

import type {
  Agreement,
  AgreementAck,
  AgreementStatus,
  AgreementStatusKind,
  ApprovalReq,
  ApprovalResp,
  BroodSignal,
  BroodType,
  ExtendReq,
  ExtendResp,
  FamilyPolicy,
  PolicyAction,
  PolicyVerdict,
  PrecisionStep,
} from './types.js'
import { BROOD_SIGNAL_KIND } from './types.js'

const HEX_64_RE = /^[0-9a-f]{64}$/

const BROOD_TYPES: readonly BroodType[] = [
  'agreement',
  'agreement-ack',
  'agreement-status',
  'extend-req',
  'extend-resp',
  'family-policy',
  'approval-req',
  'approval-resp',
]

const STATUS_KINDS: readonly AgreementStatusKind[] = ['en-route', 'arrived', 'late']
const POLICY_ACTIONS: readonly PolicyAction[] = ['create-circle', 'add-member', 'join-circle', 'add-contact']
const POLICY_VERDICTS: readonly PolicyVerdict[] = ['allow', 'prompt', 'deny']

function isBroodType(v: string): v is BroodType {
  return (BROOD_TYPES as readonly string[]).includes(v)
}

function isHex64(v: unknown): v is string {
  return typeof v === 'string' && HEX_64_RE.test(v)
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v)
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function parseSchedule(v: unknown): PrecisionStep[] | null {
  if (!Array.isArray(v)) return null
  const steps: PrecisionStep[] = []
  for (const item of v) {
    if (!isPlainObject(item)) return null
    if (!isFiniteNumber(item.fromOffsetMin)) return null
    if (!Number.isInteger(item.precision) || (item.precision as number) < 1 || (item.precision as number) > 12) return null
    steps.push({ fromOffsetMin: item.fromOffsetMin, precision: item.precision as number })
  }
  return steps
}

function parsePlace(v: unknown): { label: string; geohash?: string } | null {
  if (!isPlainObject(v)) return null
  if (!isNonEmptyString(v.label)) return null
  if (v.geohash !== undefined && !isNonEmptyString(v.geohash)) return null
  return v.geohash === undefined ? { label: v.label } : { label: v.label, geohash: v.geohash }
}

function parseRules(v: unknown): Partial<Record<PolicyAction, PolicyVerdict>> | null {
  if (!isPlainObject(v)) return null
  const rules: Partial<Record<PolicyAction, PolicyVerdict>> = {}
  for (const [key, value] of Object.entries(v)) {
    if (!(POLICY_ACTIONS as readonly string[]).includes(key)) return null
    if (typeof value !== 'string' || !(POLICY_VERDICTS as readonly string[]).includes(value)) return null
    rules[key as PolicyAction] = value as PolicyVerdict
  }
  return rules
}

function parseParams(v: unknown): Record<string, string> | null {
  if (!isPlainObject(v)) return null
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(v)) {
    if (typeof value !== 'string') return null
    params[key] = value
  }
  return params
}

function parseAgreement(o: Record<string, unknown>): Agreement | null {
  if (!isNonEmptyString(o.id)) return null
  if (!isNonEmptyString(o.circleId)) return null
  if (!isHex64(o.child)) return null
  if (!isFiniteNumber(o.byUnix)) return null
  const schedule = parseSchedule(o.schedule)
  if (schedule === null) return null
  if (!isHex64(o.from)) return null
  if (!isFiniteNumber(o.at)) return null

  let place: { label: string; geohash?: string } | undefined
  if (o.place !== undefined) {
    const parsedPlace = parsePlace(o.place)
    if (parsedPlace === null) return null
    place = parsedPlace
  }
  if (o.note !== undefined && typeof o.note !== 'string') return null

  const result: Agreement = {
    t: 'agreement',
    id: o.id,
    circleId: o.circleId,
    child: o.child,
    byUnix: o.byUnix,
    schedule,
    from: o.from,
    at: o.at,
  }
  if (place !== undefined) result.place = place
  if (o.note !== undefined) result.note = o.note as string
  return result
}

function parseAgreementAck(o: Record<string, unknown>): AgreementAck | null {
  if (!isNonEmptyString(o.id)) return null
  if (!isHex64(o.by)) return null
  if (!isFiniteNumber(o.at)) return null
  return { t: 'agreement-ack', id: o.id, by: o.by, at: o.at }
}

function parseAgreementStatus(o: Record<string, unknown>): AgreementStatus | null {
  if (!isNonEmptyString(o.id)) return null
  if (typeof o.status !== 'string' || !(STATUS_KINDS as readonly string[]).includes(o.status)) return null
  if (!isHex64(o.by)) return null
  if (!isFiniteNumber(o.at)) return null
  return { t: 'agreement-status', id: o.id, status: o.status as AgreementStatusKind, by: o.by, at: o.at }
}

function parseExtendReq(o: Record<string, unknown>): ExtendReq | null {
  if (!isNonEmptyString(o.id)) return null
  if (!isFiniteNumber(o.extraMin)) return null
  if (!isHex64(o.by)) return null
  if (!isFiniteNumber(o.at)) return null
  return { t: 'extend-req', id: o.id, extraMin: o.extraMin, by: o.by, at: o.at }
}

function parseExtendResp(o: Record<string, unknown>): ExtendResp | null {
  if (!isNonEmptyString(o.id)) return null
  if (typeof o.ok !== 'boolean') return null
  if (o.extraMin !== undefined && !isFiniteNumber(o.extraMin)) return null
  if (!isHex64(o.by)) return null
  if (!isFiniteNumber(o.at)) return null
  const result: ExtendResp = { t: 'extend-resp', id: o.id, ok: o.ok, by: o.by, at: o.at }
  if (o.extraMin !== undefined) result.extraMin = o.extraMin
  return result
}

function parseFamilyPolicy(o: Record<string, unknown>): FamilyPolicy | null {
  if (!isNonEmptyString(o.circleId)) return null
  const rules = parseRules(o.rules)
  if (rules === null) return null
  if (!isFiniteNumber(o.updatedAt)) return null
  if (!isHex64(o.by)) return null
  return { t: 'family-policy', circleId: o.circleId, rules, updatedAt: o.updatedAt, by: o.by }
}

function parseApprovalReq(o: Record<string, unknown>): ApprovalReq | null {
  if (!isNonEmptyString(o.id)) return null
  if (typeof o.action !== 'string' || !(POLICY_ACTIONS as readonly string[]).includes(o.action)) return null
  const params = parseParams(o.params)
  if (params === null) return null
  if (!isHex64(o.from)) return null
  if (!isFiniteNumber(o.at)) return null
  return { t: 'approval-req', id: o.id, action: o.action as PolicyAction, params, from: o.from, at: o.at }
}

function parseApprovalResp(o: Record<string, unknown>): ApprovalResp | null {
  if (!isNonEmptyString(o.id)) return null
  if (typeof o.ok !== 'boolean') return null
  if (!isHex64(o.by)) return null
  if (!isFiniteNumber(o.at)) return null
  return { t: 'approval-resp', id: o.id, ok: o.ok, by: o.by, at: o.at }
}

/**
 * Parse a decrypted/unwrapped kind-20078 inner event into a {@link BroodSignal}.
 *
 * Returns `null` — never throws — when: `kind` isn't `BROOD_SIGNAL_KIND`;
 * there's no `t` tag; the `t` tag isn't a known {@link BroodType} (this
 * includes every flock `t` value — see BROOD.md §2/§7.5, unknown `t` is
 * routine, not an error); the `t` tag disagrees with the decoded content's
 * own `t` field; `content` isn't valid JSON; or any field fails full
 * per-type validation (64-hex pubkeys, finite numbers, enum membership,
 * schedule steps with precision 1..12).
 */
export function parseBroodSignal(inner: { kind: number; tags: string[][]; content: string }): BroodSignal | null {
  if (inner.kind !== BROOD_SIGNAL_KIND) return null

  const tTag = inner.tags.find((tag) => tag[0] === 't')?.[1]
  if (tTag === undefined || !isBroodType(tTag)) return null

  let parsed: unknown
  try {
    parsed = JSON.parse(inner.content)
  } catch {
    return null
  }
  if (!isPlainObject(parsed)) return null
  if (parsed.t !== tTag) return null

  switch (tTag) {
    case 'agreement':
      return parseAgreement(parsed)
    case 'agreement-ack':
      return parseAgreementAck(parsed)
    case 'agreement-status':
      return parseAgreementStatus(parsed)
    case 'extend-req':
      return parseExtendReq(parsed)
    case 'extend-resp':
      return parseExtendResp(parsed)
    case 'family-policy':
      return parseFamilyPolicy(parsed)
    case 'approval-req':
      return parseApprovalReq(parsed)
    case 'approval-resp':
      return parseApprovalResp(parsed)
  }
}
