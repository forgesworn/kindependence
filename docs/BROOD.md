# BROOD Protocol

**Status:** Draft · **Version:** 0.1 · **Date:** 2026-07-18

Family logistics and administrative approvals for fledgling circles, riding
FLOCK's own wire transport unmodified.

## 1. Motivation

FLOCK gives a circle disclosure-on-event location sharing and duress
signaling: it decides *whether* and *how precisely* a device discloses
where someone is. It says nothing about the logistics families actually run
on top of that — "pick Jamie up from school by 5:30," "running ten minutes
late, can we push it," "Jamie's guardian has to sign off before she joins a
new circle." That gap is what the BROOD module fills: a small, transport-
identical vocabulary of **agreements** (scheduled pickups/meets, with an
acknowledge → track → extend lifecycle) and **family policy** (which
administrative actions a family requires guardian approval for, plus the
approval request/response that satisfies it).

The BROOD module is a **pure payload/policy library**, per the workspace's kit-
purity rule: it depends on neither `roost-kit` nor `covey-kit`, does no
signing, gift-wrapping, or key derivation, and touches no storage or DOM.
It produces and parses plain JS objects; the caller (`app/`) carries the
`{kind, content, tags, created_at}` shape it produces through `roost-kit`'s
signer and gift-wrap, exactly as it would any other FLOCK signal.

## 2. Transport

Brood signals are **FLOCK inner signals**, kind `20078`, gift-wrapped per
FLOCK §transport; flock clients ignore unknown `t`.

Concretely: `20078` is the same ephemeral kind FLOCK's `canary-kit`-based
`buildSignalEvent` produces, discriminated the same way — a `['t', <type>]`
tag naming the payload. Brood does not invent a new wire kind or a new
discovery mechanism; it reuses FLOCK's.

The BROOD module itself never touches the wire. `buildBroodInner` returns the
**unwrapped inner shape** — `{ kind, content, tags, created_at }` — exactly
what FLOCK's builders return before gift-wrapping. The caller is
responsible for gift-wrapping it (NIP-59, via `roost-kit`, byte-compatible
with FLOCK's own wrap: NIP-44 seal, NIP-40 16-day expiry, backdated
`created_at`) before it ever reaches a relay, per the workspace's
gift-wrap-everything rule (inherited unmodified from FLOCK's `PRIVACY.md`
item 1). A relay never sees a bare brood signal, exactly as it never sees a
bare FLOCK one.

Because brood's `t` values (`agreement`, `agreement-ack`,
`agreement-status`, `extend-req`, `extend-resp`, `family-policy`,
`approval-req`, `approval-resp`) sit outside FLOCK's own `t` vocabulary
(`beacon`, `breach`, `pickup`, `help`, `fences`, `checkin`, …), a stock
flock client that ever unwraps one dispatches on `t`, finds no handler, and
drops it silently — the same fate as FLOCK's own `cover` decoy traffic
(FLOCK.md §3.3). Brood clients return the favor: `parseBroodSignal` returns
`null` for any `t` it doesn't recognize, so a flock signal arriving on a
shared inbox is ignored rather than mis-parsed. Neither side needs to know
the other's vocabulary in advance — the shared kind and single-tag
discriminator is the entire contract.

Brood carries no `d` tag (unlike FLOCK's stored/replaceable kind-30078
group state, or its group-scoped kind-20078 signals with `d = ssg/<hash>`)
— a brood signal is never stored or fetched by a stable `d`-tag; it rides
the same opaque gift-wrap path as everything else, so its own tags need
only the one `t` discriminator FLOCK already uses for the same purpose.
Routing (which circle, which agreement) lives inside `content`, never in a
plaintext tag. Likewise no `expiration` tag: `20078` is ephemeral and
unstored regardless, and relay-retention bounding is the gift-wrap's job
(the uniform 16-day NIP-40 window on the outer `1059`), not the inner
signal's — matching FLOCK's own kind-20078 builders, which carry no
`expiration` either.

## 3. Signal table

| `t` | Direction | Payload | Semantics |
|---|---|---|---|
| `agreement` | proposer → circle | `id, circleId, child, place?, byUnix, schedule, note?, from, at` | Proposes a scheduled pickup/meet: `child` (pubkey) is expected at the optional `place` (`label` + optional `geohash`) by `byUnix`. `schedule` is a list of `{fromOffsetMin, precision}` steps (minutes relative to `byUnix`, negative = before) that raise disclosure precision as the deadline approaches — see `policy.ts`'s `agreementPrecision` (Task 10). `from`/`at` identify and timestamp the proposer. |
| `agreement-ack` | recipient → circle | `id, by, at` | Acknowledges the `agreement` named by `id`; moves it from *proposed* to *acked*. |
| `agreement-status` | tracked party → circle | `id, status ∈ {en-route, arrived, late}, by, at` | Reports lifecycle progress against the agreement's `byUnix`. `late` may be raised by any device that observes the deadline pass with no `arrived` — see `policy.ts`'s `isLate`. |
| `extend-req` | tracked party → circle | `id, extraMin, by, at` | Requests pushing the agreement's deadline out by `extraMin` minutes. |
| `extend-resp` | guardian → circle | `id, ok, extraMin?, by, at` | Grants (`ok:true`, optionally counter-offering a smaller `extraMin` than requested) or refuses (`ok:false`) an `extend-req`. |
| `family-policy` | guardian → circle | `circleId, rules, updatedAt, by` | The circle's **complete** approval ruleset, full-set replicated — see §5. |
| `approval-req` | requester → guardian(s) | `id, action ∈ PolicyAction, params, from, at` | Raised when local policy evaluation for `action` returns `prompt` (the default) — see §6. |
| `approval-resp` | guardian → requester | `id, ok, by, at` | Answers the `approval-req` named by `id`. |

`PolicyAction ∈ {create-circle, add-member, join-circle, add-contact}` —
the fixed set of administrative actions family policy can govern.
`PolicyVerdict ∈ {allow, prompt, deny}`.

## 4. Agreement lifecycle

```
proposed  (agreement)
    │
    │ agreement-ack
    ▼
acked
    │  (schedule precision escalates toward byUnix — §agreementPrecision)
    ▼
en-route ──agreement-status{status:'en-route'}──▶ arrived   (terminal: fulfilled)
    │                                              agreement-status{status:'arrived'}
    │
    │  byUnix + grace elapses with no 'arrived'
    ▼
late ──agreement-status{status:'late'}
    │
    │  extend-req  ──▶  extend-resp{ok:true, extraMin?}
    ▼
extended  (byUnix effectively pushed out by extraMin; lifecycle resumes
           at en-route/arrived/late against the new deadline)
```

An `extend-req` may equally be sent from `en-route`, not only from `late` —
"running ten minutes early is fine, but I want fifteen more" is a normal
request, not just a rescue from tardiness. A refused extension
(`extend-resp{ok:false}`) leaves the original `byUnix` in force; the tracked
party's status continues to evolve against it (typically toward `late`).

## 5. Family policy — full-set, latest-wins

`family-policy` carries the circle's **entire** ruleset on every edit, never
a delta — the same idiom FLOCK uses for safe-place (fence) sync (FLOCK.md
§3.2): idempotent full-state replication needs no CRDT and has no
partial-update race to reason about, at the cost of a slightly larger
payload — acceptable, since edits are rare and the ruleset is at most four
keys (`PolicyAction` is a closed, small set).

Convergence rule (identical to FLOCK's fence-set tie-break,
`isNewerFenceSet`): a receiver adopts an incoming `family-policy` only when
it is **newer** — a strictly higher `updatedAt`. On an exact clock tie, the
**lexicographically smaller `by`** wins, so two guardians editing at the
same instant converge on the same winner on every device without
coordination. An exact echo (same `updatedAt`, same `by`) is never
"newer," so replays and gift-wrap retries are no-ops. `policy.ts`'s
`latestPolicy` (Task 10) implements this comparison; the BROOD module's job here
is only to define the shape it compares.

`rules: Partial<Record<PolicyAction, PolicyVerdict>>` — an action **absent**
from the map is not implicitly `allow` or `deny`; it falls through to
`DEFAULT_VERDICT = 'prompt'` (`policy.ts`'s `evaluatePolicy`). A family that
has never set a policy, or has not yet decided on one particular action,
gets the safe default — ask, don't silently permit or silently block.

## 6. Approval flow

1. A device about to perform a governed action (`create-circle`,
   `add-member`, `join-circle`, `add-contact`) evaluates the circle's
   current `family-policy` locally: `allow` → proceed with no signal
   sent; `deny` → block, no signal sent; `prompt` (the default, including
   "no policy has been set yet") → send `approval-req` to the circle.
2. `approval-req` carries `action`, free-form string-keyed `params`
   describing what's being asked (e.g. `{name: 'New Circle'}` for
   `create-circle`), and `from` (requester's pubkey). Any guardian device
   subscribed to the circle can see it.
3. A guardian answers with `approval-resp{ id, ok, by, at }`, `id` matching
   the request.
4. The requester proceeds only on `ok: true`. `ok: false` and "no response
   has arrived yet" are different states to the requester's own UI (it
   needs to know whether to keep waiting) — but see §7.2: on the *wire*,
   nothing distinguishes a granted request from a refused one, or either
   from an ordinary agreement signal.

Approvals govern **administrative** circle actions only. They never gate
anything on the safety path — see §7.1.

## 7. Security considerations

1. **Safety path is never gated.** SOS, check-in, beacon, and pickup
   emission (FLOCK's `help`/`checkin`/`beacon`/`pickup` signals) MUST NEVER
   depend on a `family-policy` verdict or on a pending or denied
   `approval-req`. Approvals gate administrative circle actions — creating
   or joining a circle, adding a member or contact — **never** safety
   disclosure. A device that is out of policy budget, offline, or awaiting
   an approval it will never need for this purpose still emits
   SOS/check-in/beacon/pickup unconditionally (offline → outbox, per
   `roost-kit`). This mirrors FLOCK's own precedence — `help > pickup >
   breach > night-out > withhold` (FLOCK.md §4) — nothing brood adds may
   insert itself above, or interrupt, that chain. This is a hard
   requirement on every caller, not a preference: gating a safety signal
   on an approval round-trip would mean a duress or overdue-child alert
   silently waits on a guardian's reply, exactly the failure mode FLOCK
   exists to prevent.
2. **Withhold-is-not-a-tell, inherited.** (FLOCK.md §6 item 1; Levy &
   Schneier, 2020.) A `deny` verdict and an unanswered `approval-req` are
   ordinary encrypted signals — same kind, same tag, same gift-wrap shape
   as an `allow`. Nothing about brood's wire format lets a relay, or a
   coercer inspecting traffic metadata, distinguish "asked and refused"
   from "asked and granted" from "never asked at all" — the verdict lives
   only inside the NIP-44 encryption, exactly like FLOCK's `allclear`
   `coerced` flag rides inside its own encryption rather than as a tag.
3. **No cryptography, no key material.** the BROOD module performs no signing,
   encryption, or key derivation, and holds no secrets. `by`/`from`/`child`
   pubkeys are opaque hex strings supplied by the caller (derived
   elsewhere, per Signet's identity scheme); the BROOD module's validation stops
   at checking they are *shaped* like pubkeys (64-char lowercase hex),
   never at verifying whose they really are — that trust boundary belongs
   to the transport layer (signature verification) and app-level circle
   membership, not to this package.
4. **Strict parsing, never partial trust.** `parseBroodSignal` rebuilds
   each signal field-by-field from the decoded JSON rather than trusting
   it wholesale (the same discipline as FLOCK's `parseFence`) — a
   malformed field anywhere in the payload discards the whole signal
   (`null`) rather than admitting a partially-valid one.
5. **Unknown `t` is routine, not an error.** Brood and flock signals may
   share a transport (same gift-wrap path, potentially the same relays and
   inbox keys), so `parseBroodSignal` treats an unrecognized `t` — or a
   `t` tag that disagrees with the decoded payload's own `t` field — as
   "not mine" (`null`) rather than throwing. The same tolerance FLOCK
   extends to unknown or future `t` values it hasn't been taught yet.
