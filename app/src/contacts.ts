// Contacts core (plan 2, Task 1): the pure rules for turning a signet-
// contacts v2 grant projection into what the rest of the app needs — "is
// this pubkey usable", and "what changed since the last snapshot for the
// pubkeys I care about". This module has no My Signet or nostr-tools
// dependency at all; contacts-grant.ts (Task 2) is the only thing that ever
// calls `setContactsSource`, and the fake in test-support/fake-contacts.ts
// is what every other module's tests drive instead.
//
// Design (internal design record: 2026-09-25-kindependence-contacts-circles-
// design.md §2, §6): the only source of contacts is the grant. Kindependence
// enforces its own "usable" rule (kin, kith, or a guardian link) on top of
// whatever tiers the grant reports — kens are never usable, and a missing
// tier is not usable either ("absence is not Ken": a contact the grant
// hasn't classified yet must not silently count as trusted).

export type Tier = 'kin' | 'kith' | 'ken' | 'none'

export interface Contact {
  contactId: string
  pks: string[]
  name: string
  tier?: Tier
  blocked: boolean
}

/** `'none'` = never paired with My Signet contacts at all (distinct from
 *  `'disconnected'`, a grant that existed and was lost/revoked/expired). */
export type ContactsStatus = 'none' | 'connected' | 'disconnected'

export interface ContactsSnapshot {
  status: ContactsStatus
  contacts: Contact[]
  fresh: boolean
  at: number
  truncated?: boolean
}

export interface ContactsSource {
  current(): ContactsSnapshot
  onUpdate(cb: (s: ContactsSnapshot) => void): () => void
}

const EMPTY_SNAPSHOT: ContactsSnapshot = { status: 'none', contacts: [], fresh: false, at: 0 }

let source: ContactsSource | null = null
let unsubscribeSource: (() => void) | null = null
const subscribers = new Set<(next: ContactsSnapshot, prev: ContactsSnapshot) => void>()
let lastSnapshot: ContactsSnapshot = EMPTY_SNAPSHOT

/** Installs (or, with `null`, removes) the live contacts source. Only
 *  contacts-grant.ts calls this outside tests. Replacing a source
 *  unsubscribes from the old one first, so nothing keeps notifying after
 *  it's been swapped out. */
export function setContactsSource(src: ContactsSource | null): void {
  if (unsubscribeSource) {
    unsubscribeSource()
    unsubscribeSource = null
  }
  source = src
  if (!src) {
    lastSnapshot = EMPTY_SNAPSHOT
    return
  }
  lastSnapshot = src.current()
  unsubscribeSource = src.onUpdate((next) => {
    const prev = lastSnapshot
    lastSnapshot = next
    for (const cb of subscribers) cb(next, prev)
  })
}

/** The current snapshot, or the "never paired" default with no source
 *  installed. */
export function snapshot(): ContactsSnapshot {
  return source ? source.current() : EMPTY_SNAPSHOT
}

/** Subscribes to every update the installed source reports (before/after
 *  pair, so a caller can diff). Returns an unsubscribe function. A no-op
 *  until a source is installed — there is nothing to update from. */
export function onContactsUpdate(cb: (next: ContactsSnapshot, prev: ContactsSnapshot) => void): () => void {
  subscribers.add(cb)
  return () => subscribers.delete(cb)
}

/** Looks up `pk` across every contact record in the snapshot (a contactId
 *  may appear more than once in `contacts` — see this file's own
 *  `classifyUpdate` doc comment — so this is a plain scan, not a dedupe). */
export function contactTier(s: ContactsSnapshot, pk: string): { tier?: Tier; blocked: boolean; present: boolean; name?: string } {
  const c = s.contacts.find((c) => c.pks.includes(pk))
  if (!c) return { blocked: false, present: false }
  return { tier: c.tier, blocked: c.blocked, present: true, name: c.name }
}

/** True if a guardian link joins me and `pk` (Kindependence's own device-
 *  statement pair, spec §7) — checked ahead of contact tiers, since a
 *  guardian link counts as usable regardless of what (if anything) the
 *  grant reports for that pubkey. */
export type LinkCheck = (pk: string) => boolean

/** Whether `pk` may be added to (or kept in) a circle: a guardian link
 *  always wins; otherwise the contact holding `pk` must be present with
 *  tier `kin` or `kith`, and not blocked. A `ken` tier, a `none` tier, and a
 *  missing tier are all NOT usable — "absence is not Ken". */
export function usable(s: ContactsSnapshot, pk: string, linked: LinkCheck): boolean {
  if (linked(pk)) return true
  const info = contactTier(s, pk)
  if (!info.present || info.blocked) return false
  return info.tier === 'kin' || info.tier === 'kith'
}

/** Whether the grant has ever produced real contact data — `'connected'`
 *  status, or at least one contact record (some tests/fixtures report
 *  `status` lazily but still carry contacts). A revocation empties
 *  `contacts` and flips status away from `'connected'`, so a revoked grant
 *  is correctly NOT known any more. */
export function known(s: ContactsSnapshot): boolean {
  return s.status === 'connected' || s.contacts.length > 0
}

export interface Classified { dropped: string[]; absent: string[]; bulk: boolean; unknown: boolean }

/** Classifies what changed for the `watched` pubkeys (the members I vouched
 *  for, plus my own voucher) between two snapshots, for spec §6's automatic-
 *  removal rule. Only an EXPLICIT per-contact signal is a `dropped` pk —
 *  present in `next` with tier `ken` or `none`, or `blocked`. Everything
 *  else that isn't explicit falls out as neither dropped nor absent (a
 *  missing tier on an otherwise-present contact, say) — nothing acts on it
 *  automatically, per spec §6 ("everything else is unknown, and nothing is
 *  removed automatically").
 *
 *  `unknown` covers the grant-level signals spec §6 says must ask instead
 *  of act: not connected (includes disconnected/revoked/expired),
 *  truncated, or contacts going from non-empty to empty (an emptied-out
 *  grant looks identical on the wire to "no contacts left" and to a
 *  connection loss, so it's treated the same, cautious way). When
 *  `unknown` is set, `dropped`/`absent` are always empty — the caller asks
 *  about the whole grant, not per contact.
 *
 *  `bulk` (more than one explicit drop in the same update, e.g. a guardian
 *  lowering a ceiling for several people at once) tells the caller to ask
 *  once for the whole batch (Task 8) instead of removing silently. */
export function classifyUpdate(prev: ContactsSnapshot, next: ContactsSnapshot, watched: string[]): Classified {
  if (next.status !== 'connected' || next.truncated || (next.contacts.length === 0 && prev.contacts.length > 0)) {
    return { dropped: [], absent: [], bulk: false, unknown: true }
  }
  const noLink: LinkCheck = () => false
  const dropped: string[] = []
  const absent: string[] = []
  for (const pk of watched) {
    if (!usable(prev, pk, noLink)) continue
    const info = contactTier(next, pk)
    if (!info.present) {
      absent.push(pk)
      continue
    }
    if (info.blocked || info.tier === 'ken' || info.tier === 'none') {
      dropped.push(pk)
    }
  }
  return { dropped, absent, bulk: dropped.length > 1, unknown: false }
}

/** Groups the snapshot's contact records by `contactId` and buckets them
 *  for a picker: `usable` (kin/kith, not blocked, sorted by name) and
 *  `kens` (tier `ken`, not blocked — shown greyed, "Meet in person to
 *  add"). `none` and blocked contacts never appear in either list.
 *
 *  A contactId can have more than one record in `s.contacts` (one real
 *  person's several identity pubkeys can each carry their own tier — see
 *  `classifyUpdate`'s doc comment for why that matters). For a contactId
 *  group, the representative record is the first one (in array order) that
 *  still has at least one pk not in `exclude` (already a circle member, or
 *  the viewer's own pubkey); a contactId every one of whose pks is
 *  excluded is left out of both lists entirely. */
export function candidates(s: ContactsSnapshot, exclude: Set<string>): { usable: Contact[]; kens: Contact[] } {
  const groups = new Map<string, Contact[]>()
  for (const c of s.contacts) {
    const arr = groups.get(c.contactId)
    if (arr) arr.push(c)
    else groups.set(c.contactId, [c])
  }
  const usableList: Contact[] = []
  const kensList: Contact[] = []
  for (const entries of groups.values()) {
    const rep = entries.find((e) => e.pks.some((pk) => !exclude.has(pk)))
    if (!rep || rep.blocked) continue
    if (rep.tier === 'kin' || rep.tier === 'kith') usableList.push(rep)
    else if (rep.tier === 'ken') kensList.push(rep)
  }
  usableList.sort((a, b) => a.name.localeCompare(b.name))
  kensList.sort((a, b) => a.name.localeCompare(b.name))
  return { usable: usableList, kens: kensList }
}
