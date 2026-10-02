# Kindependence

*Parachute, not helicopter.* — Consent-based family location: there for the
landing, out of the way the rest of the time.

Kindependence is part of the **[Kindred](https://kindred.software)** suite
(kin + the capability the child walks away with — here, independence: trusted
freedom).

Kindependence is a standalone family location and safety companion. It speaks the
same **FLOCK** protocol as `forgesworn/flock` — same circles, same wire
signals, same location format — so a mixed circle of flock and Kindependence
users works for every core safety flow (beacons, SOS, check-in, pickup,
dropped pins), no flock install required on either side. Kindependence's own
richer messaging (circle chat, journeys, pickup lifecycle, precise-location
reasons) is a separate, Kindependence-only wire type that a plain flock client
simply doesn't recognise — see **Flock convergence** below for exactly what's
shared and what isn't. Identity is managed by **My Signet**, using an external
signer over NIP-55 on Android or NIP-46 for QR/bunker connections. This app
creates a separate device key; it does not hold the family's identity keys.

The app itself is deliberately thin: reusable transport and circle primitives
live in MIT-licensed TypeScript libraries. Its family-logistics rules live in
the pure [BROOD module](app/src/brood/README.md) inside this repository. On top
of the FLOCK-compatible circle-of-trust layer, Kindependence adds **BROOD** — a
new, open family-logistics protocol (agreements, approvals, family policy)
that rides FLOCK's own transport unmodified; flock clients that don't know
BROOD's signal types simply ignore them.

## App tour

Four tabs, always reachable from the bottom nav: **Map**, **Circles**,
**Activity**, **You**. Copy throughout favours neutral, trust-first language
(e.g. "left safe area", never "breach"/"violation"/"tracking") — the wire
signal types keep their FLOCK names underneath, but nothing user-facing does.

- **Map** — circle members' positions, rendered at whatever precision they're
  actually sharing: a coarser fix draws as the geohash cell itself (a filled
  area, teal, labelled "Neighbourhood"/"Town"/etc — never a pin standing in
  for a location nobody disclosed), a precise fix (street-level or finer)
  draws as a normal avatar marker. Availability reads honestly beyond plain
  live/recent/stale, too, each built only from data this device already
  holds: a member with an upcoming precision raise shows "Precise from
  17:45" rather than just going quiet, a shared-and-very-low battery reading
  offers "battery may have run out" as a guess (never a fact), and someone
  never heard from at all reads "No location shared" — none of these can
  tell a viewer "chose not to share this" apart from "has nothing to share
  right now". Beacon cadence adapts to movement — a stationary device slows
  its routine tick from 60s to every 5 minutes and snaps back the instant it
  moves again, so a circle member who's been parked a while may show as
  "Recent" rather than "Live" even though sharing is working fine. Nearby
  markers collapse into an "N people" badge at the current zoom (tap opens
  the member list directly, no zoom-first step), and anyone panned or zoomed
  out of view gets a small edge chip pointing toward them, still correctly
  oriented if the map itself has been rotated with the two-finger gesture. A
  circle-selector chip row filters who's shown; tapping a marker/area opens
  a person sheet with their availability, last-update age, battery (when
  shared and recently reported), a **Mute** (10 min/1 hour/until tomorrow/3
  days/until you unmute) and **Pin** control (a viewing preference only —
  muting never touches what's shared, and a muted person's SOS/safe-area/
  pickup traffic still notifies exactly as if they were never muted; a
  pinned person always stays in the adaptive auto-fit even while travelling
  far from everyone else), and actions: message, request check-in, request
  precise location (both directions, always logged to Activity), navigate/
  copy location (also clamped to the same permitted precision — an
  approximate fix opens a map area, never a synthesized exact point), and
  pickup requests (accept/decline/suggest another spot/on the way/picked up,
  shown as a small dot-chain timeline). A map overlay button, **Add meeting
  point here**, drops a temporary **meeting point** (name + expiry — 1 hour,
  3 hours, until 10pm today, or 24 hours; up to 10 points per circle —
  distinct from a safe area: no geofence, no escalation, it just quietly
  disappears once it expires); its create form can also **Suggest a fair
  spot**, a plain
  on-device midpoint by default, or — opted in from the You tab — a real
  isochrone-based fair point from your own self-hosted routing engine.
  Tapping your own marker opens a **journey** section per circle: **Start
  journey** picks a destination (a safe place, a live meeting point, or a
  typed "somewhere else…") with an optional expected-by time, and always
  buzzes the circle "Heading to X" (plus the time, when given); the active
  card shows the destination and elapsed time with **I'm there**/**Cancel**.
  It auto-completes on arrival (inside a place's radius, or within 150m of a
  meeting point) or after 6 hours with no update either way — silently, no
  buzz, since nothing was actually confirmed. A completed journey to a safe
  place stays quiet too, UNLESS that place's own arrival alert is switched
  off (or the place has since been deleted) — then it sends "Journey to X
  complete" itself, so the circle still hears something rather than nothing;
  a meeting point or typed destination always gets that closing buzz, since
  nothing else would. Cancelling never buzzes — it's just "never mind".
  The SOS hold button stays reachable here (and on Circles) no matter what
  else is on screen.
- **Circles** — circle list and membership, invites, family policy and
  approval requests, **safe areas** (guardian-defined named places with a
  radius; a child's device evaluates arrivals/departures locally and only
  ever warns the child PRIVATELY first, with a grace period, before telling
  the rest of the circle — never framed as an accusation) with optional
  **expected-arrival windows** per place (e.g. "School — expected by 08:45,
  Mon–Fri": a reminder shortly before the deadline, a not-yet-arrived notice
  to the circle once the grace period passes, then a closing arrival notice
  whenever they do turn up; windows are day-scoped, so an arrival time plus
  grace period that would cross midnight is rejected in the editor rather
  than silently never firing) — the warning banner itself offers **Ask to go
  out**, a short form (where, who with, how long) that sends a real approval
  request to the circle's guardians; a guardian can set their own
  Allow/Deny/Prompt default for these asks (You tab, this device only), and
  Allow/approve suppresses the warning for that place until the granted time
  is up, then resumes normally from wherever things actually stand — never an
  instant escalation just because the window closed while still out.
  (**Compatibility note:** an older Kindependence build, or any other FLOCK
  client, doesn't know this request type and shows it as a generic
  "wants to add a new contact" approval card instead — no crash, just an
  oddly-labelled one; approving/denying it still works correctly underneath.)
  — plus **agreements** (return-time proposals with a
  disclosure schedule that can raise a child's shared precision as a
  deadline approaches, acknowledged/extended/tracked through to arrival)
  with a child-side **travel mode** picker (walking/cycling/driving)
  driving local **leave reminders** — "You'll need to leave for X soon" →
  "Leave now to make X by HH:MM" → "Running behind for X — ask for more
  time?", computed entirely on the child's own device and never sent over
  the wire (**honesty note:** without a self-hosted routing engine
  configured, the travel-time estimate behind these is a straight-line
  heuristic — distance × a fixed winding-factor fudge at a flat assumed
  speed — a rough guide for when to head out, not a real route), and
  **pickup lifecycle** cards (request/offer → accept/decline/suggest
  another spot → on the way → picked up) for circles with a tracked pickup.
- **Activity** — one append-only, newest-first timeline every safety/
  messaging/circle event lands in (arrivals, safe-area warnings, expected-
  arrival reminders/notices, check-ins, pickups, SOS, low-battery alerts,
  agreement lifecycle, approvals, membership changes, precise-location
  requests, messages, journeys, boundary-exit asks/approvals), filterable
  (All/Safety/Requests/People/a circle) and deep-linking back into the map
  or the relevant circle/approval. How much of it — and for how long — this
  device keeps is set from the You tab's **Routine history** controls.
- **You** — identity and children, a per-circle privacy overview ("who can
  see what about me?": role, current baseline precision, active agreement
  schedule shown in advance, expected-arrival windows, a plain-English
  "Sharing Neighbourhood with Family — Precise from 17:45" mode line), a
  per-circle baseline-precision picker (Town/Neighbourhood/Street/Precise —
  safety/agreement escalations can still raise it, never lower it), a
  per-circle **share my battery** toggle (on by default for children, off for
  guardians) and a global **low-battery alerts** toggle (on by default —
  notifies the circle once when a shared member's battery drops to 15% or
  below, rearming only once it climbs back above 25% or starts charging),
  optional **meeting-point routing**: your own self-hosted routing engine
  (Valhalla or OSRM) for real travel-time estimates and fair-spot geometry,
  and, as a separate opt-in on top, your own self-hosted Overpass-compatible
  server to name an actual venue (cafe, park, library…) inside that fair
  spot — a self-hoster can run one without the other, neither ever defaults
  to a public server, and leaving both blank keeps every suggestion a plain
  straight-line estimate that never leaves the device. Per-circle **sharing
  schedules** (up to 6 per circle: day-of-week chips + a from/to time window
  + a precision + a label, e.g. "After school — Mon–Fri 15:00–17:00 —
  Street") temporarily raise the baseline while active — the highest-
  precision window in effect wins, shown as an annotation next to the
  baseline picker along with when it ends. **Quiet hours** (e.g.
  22:00–07:00, device-local) hold ordinary notifications during that window
  without queuing or re-sending them later (Activity still keeps the full
  record either way) — SOS, precise-location requests, a safe-area
  escalation, pickup requests/updates, a genuinely-not-yet-arrived window
  notice, and travel-aware leave reminders always break through regardless.
  A boundary-exit **Allow/Deny/Prompt** default answers "Ask to go out"
  requests automatically (guardian-only, this device only — a family with
  two guardian devices sets it independently on each). **Routine history**
  controls set how many events this device keeps (100/500/1000) and an
  optional "drop routine history after 7 days" for arrivals, departures,
  precision changes, and structured messages — SOS, precise-location access,
  a safe-area escalation, family-policy changes, and every approval
  request/response (including boundary-exit asks) are never auto-pruned by
  either rule, only ever removable by hand via **Clear routine history**'s
  two-tap confirm — plus family policy, and Contacts (the companion-rail
  pairing/rolodex from the guide below).
- **Home-screen widget (Android)** — an optional widget showing up to four
  circle members at a glance (availability, place attachment at Street
  precision or finer, active return-time deadline, fresh battery),
  respecting the Map tab's Mute (a muted person's row is excluded, unless
  also pinned), refreshed automatically as new data arrives (no separate
  polling — it's pushed from whatever the app already has in hand). Add it
  from the phone's home screen: long-press an empty area → **Widgets** →
  **Kindependence** → drag it into place.
- **Messaging** — person-to-person DMs (genuinely wire-identical to flock's
  own personal-inbox DM) and per-circle group chat, plus structured one-tap
  messages that reuse existing wire signals rather than inventing new ones
  ("Can you check in?", "Pick me up", "I'm okay"/"Arrived"/"Heading home",
  "Come home now"/"Be home by" — the last two can create or update a return
  agreement). Circle chat and every one of these quick-chips ride
  Kindependence's own wire type (see **Flock convergence** below) — a real flock
  client doesn't see them, by design — with one exception: an UNTARGETED
  "Heading home" goes out as flock's real `on_my_way` coordination action
  instead, so an updated flock device in the same circle sees it as a
  first-class signal (a targeted "Heading home", sent from a 1:1 DM, still
  rides Kindependence's own wire — flock's fixed actions can't target one
  member). The actionable chips ("Can you check in?", "Come home now",
  "Dinner ready", "Pick me up") fire a notification on the receiving device
  whenever that thread isn't the one currently open (the
  chat bubble is enough while it is); the passive status chips ("I'm okay"/
  "Arrived"/"Heading home") never do, same as they've never notified.
- **Native (Android)** — local notifications (one channel each for safety/
  places/messages/agreements/battery, consolidating repeats of the same event
  within a few minutes rather than re-firing on every one) and background location
  (continues emitting beacons while the app is backgrounded, tied to the
  same sharing lifecycle as the foreground watch) via Capacitor plugins; see
  **Native build (Android)** below.

## Growing independence

Three more features, spread across Map/You/Circles, work as one arc rather
than three separate settings: **visibility** (you can always check) →
**reassurance** (so you don't have to, as often) → **trust** (extended
deliberately, in named steps) → **independence** (an age-appropriate
starting point, revisited any time).

- **Map-check friction** (Map tab) — a small, private, guardian-only card
  that appears once the map's been opened compulsively — on the eighth check
  of the day (a burst of taps within 60 seconds of each other only counts
  once) — on a day that's actually been quiet — no SOS, no safe-area
  escalation, no overdue pickup or return-time agreement. It never blocks,
  delays, or throttles anything, never appears on a day where something real
  is going on, and never leaves the guardian's own device (no wire signal, no
  Activity entry — the child never sees it or knows it exists). The card
  just points at arrival notifications as the thing already doing the
  watching; **Dismiss** clears it until the next day.
- **Independence milestones** (You tab) — three named levels (**Close** /
  **Growing** / **Trusted**) a guardian applies to a child, in one tap. What
  actually changes is CIRCLE-wide, not scoped to just that one child: the
  grace period (and warn-first-or-tell-right-away behaviour) for every safe
  place in the circle, and the family's default answer to membership/contact
  requests for the whole circle — so applying a level "for" one child
  currently affects every other child sharing that circle too. Only the
  "suggested sharing level" proposal itself is per-child (sent to just that
  one child's device, theirs to accept or not — never forced from the
  guardian's side). The app now says so up front, at the moment of applying
  ("This also updates safe areas and permissions for ...") rather than
  leaving a guardian to discover it later; true per-child scoping (so a level
  could genuinely apply to one child alone) is a planned follow-up, not yet
  built. After roughly a month of the app actually having been installed and
  watching — not merely "nothing bad happened yet because nothing has
  happened at all" — with no safety incidents involving that child, the You
  tab offers a step toward the next level with a plain before/after diff
  computed from the circle's REAL current settings (not an assumed preset
  value, so a guardian who's hand-edited a place's grace period sees the
  truth, including the rare case where the actual next-notch change is a
  tightening, plainly labelled as such rather than dressed up as "more
  independence"); declining is silent, and it's only offered again after
  another full quiet stretch.
- **Age-based setup wizard** — the same three levels, reached by age instead
  of by name: "how old is [child], roughly?" (under 10 / 10–13 / 14 and up)
  shows a plain-language summary of exactly what applying would change
  (including the same circle-wide disclosure above, when relevant) before
  asking to Apply or Skip. Offered right after adding a child during setup,
  and re-runnable any time after from that child's row on Circles.

None of this is styled as a game — no points, no streak-as-score, nothing
"unlocked" by behaving well; a level is a settings change a guardian makes
on purpose, and a family that never touches any of it keeps behaving exactly
as it already was. The specific numbers behind all three — the check-count
threshold, each level's grace minutes/policy defaults/suggested precision,
the month-long quiet window, the age-band boundaries — are conservative
starting points, not researched defaults, and are flagged in the source
(`[maintainer-review]` in `app/src/friction.ts`/`app/src/milestones.ts`) for a
tuning pass; every piece of copy above is likewise flagged `[copy]` pending
a wording review.

## Flock convergence

A periodic pass: re-read flock/flock-kit/roost-kit for what's shipped
upstream since Kindependence's own pins, and adopt what applies here.

- **Security.** `roost-kit`'s wrap-unwrapping now verifies the seal signature
  and checks the decrypted message actually came from who it claims before
  anything downstream trusts it, closing a real gap in Kindependence's previous
  pin. The same sender-check was then applied everywhere a message carries
  its own "who sent this" field (coordination messages, location-access
  requests, and similar), including one spot — reading a message sent to a
  person's own private inbox (invites, direct messages) — that a
  separately-pinned library hadn't caught up on yet, fixed by having
  Kindependence do that read itself against the corrected verification instead of
  trusting the older one. All of this is receive-side only: an unverifiable
  message is simply dropped, the same as any other message that fails to
  decrypt; nothing about sending changed, and nothing here touches the
  safety-critical send paths.
- **Staying connected.** Phone data connections can go quietly stuck —
  still "connected" but nothing actually arriving, and the app has no way to
  tell without checking. Both of Kindependence's relay connections (the main one,
  and the companion-rail's own separate one) now notice this on their own
  and reconnect automatically after about a minute of silence, without
  interrupting anything already in progress.
- **Wire migration.** flock's own coordination-message format tightened to a
  fixed, short list of message kinds (no free text). Kindependence's richer
  vocabulary — circle chat, journeys, pickup lifecycle, precise-location
  reasons — moved onto its own message type as a result: **Kindependence-specific
  messages are Kindependence↔Kindependence only; a plain flock client silently
  ignores them, by design, the same as it ignores any message type it
  doesn't recognise** — nothing crashes or errors, the content just doesn't
  arrive there. A receive-side compatibility window (16 days, to cover relay
  message replay and staggered device updates) keeps reading the OLD format
  too, for anyone still updating; sending on the old format is already gone.
  Two specific messages kept riding flock's real coordination format because
  they map onto it directly — an untargeted "Heading home" status, and
  safety's own "I'm OK" self-report — so those two specifically DO still
  reach an updated flock device sharing the circle. The pickup
  accept/decline/suggest-another/on-the-way/picked-up negotiation moved onto
  Kindependence's own message type along with everything else above; only the
  initial pickup request itself still rides flock's real wire. The same
  silent-drop behaviour applies within a family too, not just out to flock:
  **both phones in a circle need to update together** — during any version
  skew, a phone still on a pre-1.6 build doesn't recognise `kindependence-msg`
  either (the type didn't exist before this migration), so it silently drops
  an updated phone's circle chat, arrival/not-yet/departure notices, journey
  updates, and pickup-lifecycle messages, the same way a flock device does.
  SOS, beacons, and check-ins keep interoperating across that gap regardless,
  since none of those ever moved off flock's own wire.
- **Pins.** A new, flock-interoperable "drop a pin" feature: 18 fixed icons
  (car, water, meeting spot, and so on — never free text), dropped at the
  map's centre, removable by any circle member, using the exact same wire
  format flock's own pin feature does — so a mixed flock/Kindependence circle
  sees each other's pins directly, no translation needed. Since v1.7 pins
  also participate in flock's durability mechanism both ways: when someone
  joins (or a flock member re-announces), this phone re-sends the pins it
  authored — removals included — so late joiners see pins whose original
  relay copies have long expired.
- **Circle security gates (v1.7).** A circle-key rotation ("reseed") or a
  roster update is now only accepted from someone already in the circle's
  own member list, and a rotation older than the last one adopted is
  ignored. Before this, anyone who knew a circle's id and one member's
  public key — which any REMOVED member knows — could push a key the
  attacker chose (splitting the family onto a seed the attacker can read)
  or write themselves back into the roster. Removals are also durable now:
  they ride the rotation message itself, so every phone — flock's included
  — drops the removed member and never hands a rotated key back to them.
  Wire-format unchanged (older phones simply ignore the new field), but the
  usual rule applies: **both phones should update together.**

**In short, what's actually shared with a flock device today:** live
locations (beacons), SOS, "I'm OK"/"Heading home", precise-location requests,
pickup requests, and dropped pins. **What stays Kindependence-only:** circle
chat, journeys, pickup-lifecycle chat, and the free-text reason attached to a
precise-location request — a real flock client simply never sees these, it
doesn't reject them or show an error.

## Repository map

Transport and circle libraries have their own repositories and are pinned
here to immutable commits. BROOD lives under `app/src/brood/`. `app/` is the
PWA that consumes these modules. The pure modules have no
DOM, `localStorage`, `console.*`, or baked-in relay defaults; the app injects
those concerns.

| Repository | What it is |
|---|---|
| [`forgesworn/roost-kit`](https://github.com/forgesworn/roost-kit) | Transport: signer types, NIP-59 gift wrap, relay publish/subscribe, key rotation, and an offline outbox. The wire-level foundation everything else sits on. |
| [`forgesworn/covey-kit`](https://github.com/forgesworn/covey-kit) | Circles: keys, a local in-memory signer, personal-inbox payloads, word-code invites, roles, and latest-wins config merge. Depends on Roost. |
| [`app/src/brood/`](app/src/brood) | The local BROOD family protocol: agreements, family policy, approvals and schedule-driven disclosure. Its [wire specification](docs/BROOD.md) and tests live here. |
| [`app/`](app) | The Kindependence PWA (and Capacitor Android shell): onboarding/identity, circles, map, beacons, safety, safe areas, agreements, approvals, messaging, the Activity timeline, native notifications/background location, and the companion-rail contacts consumer. |

Every package is MIT licensed, matching the root [`LICENSE`](LICENSE).

## Project status

Kindependence is under active development. The Android app uses the Android
Keystore for device secrets. Browser builds currently store device secrets in
plain localStorage and are intended for development and testing. Use test
identities and locations for browser demos.

All external kit dependencies are public. See
[dependency access](#dependency-access) for installing without SSH credentials.
Signed Android distribution also requires an off-repository release key; see
[release signing](app/android/RELEASE_SIGNING.md).

## Quickstart

```bash
nvm use
# Public Git dependencies: this setting applies only to this installation.
GIT_CONFIG_COUNT=2 \
GIT_CONFIG_KEY_0=url.https://github.com/.insteadOf \
GIT_CONFIG_VALUE_0=ssh://git@github.com/ \
GIT_CONFIG_KEY_1=url.https://github.com/.insteadOf \
GIT_CONFIG_VALUE_1=git@github.com: \
npm ci
npm run -w app dev
```

Open the printed local URL. Node 24 or newer is required. Root-level scripts
(`npm run build`, `npm run typecheck`, `npm test`) run against the app
workspace.

## Design notes

- **Fonts:** the app ships the platform's own system-font stack
  (`system-ui, -apple-system, 'Segoe UI', sans-serif` — see
  `app/src/styles.css`) rather than self-hosting flock's Fraunces/Hanken
  Grotesk pair. That's a deliberate bundle-lean choice for v1, not an
  oversight — a distinct display-font identity is a brand decision Kindependence
  can make later without touching any wire or data-model code.
- **Icon:** `app/public/icon.svg` is the source mark. The repository also
  includes PNGs for PWA and Android launcher/splash assets. Keep those in
  sync when changing the mark. Icon-generation tooling is optional and is
  not installed with the app.

## Phone-testing guide

Use test identities and simulated locations when testing sharing flows.

### 1. Sign in and connect contacts

1. On Android, install My Signet and choose **Use My Signet on this phone**.
   In a browser, use **Connect with a QR code** or **I have a bunker link**
   with a compatible My Signet signer.
2. Approve the device statement. The phone gets its own transport key while
   My Signet keeps the identity signing key.
3. At **Connect your contacts**, approve the contacts grant in My Signet.
   Check that granted contacts appear and revoking the grant removes them.
4. Restart the app and check that sign-in and the contacts grant restore.

### 2. Two-device circle check

1. Sign in to two devices (or separate browser profiles) with separate test
   identities. In My Signet, add each other in person as kith.
2. Create a circle on one device, invite the other from the contacts picker,
   and accept the invitation. Check that both devices show the members.
3. With location permission granted, check the Map tab at the chosen sharing
   precision. Send a check-in, message and test SOS; confirm receipt and
   Activity entries on the other device.
4. In My Signet, downgrade the contact to ken. Confirm removal and key
   rotation, then restore kith and verify a fresh invitation works.
5. For a dependant, use **Set up a dependant's phone**, pair through the
   guardian's My Signet, then scan **Add a dependant** in Kindependence.
   Approve on the guardian's phone and verify the dependant joins the family
   circle and appears under Devices. Remote guardian approvals require My
   Signet's bunker serving to be enabled.

Camera and geolocation browser tests require a secure context (HTTPS or
localhost). Device testing records and implementation plans are maintained
in the private Kindred repository.

### 3. Relay / tile env overrides

Both the default relay and the map's tile source are overridable per
environment (Vite `import.meta.env`, so these are build-time — set them in
`app/.env.local` or the shell before `npm run -w app dev`/`build`):

- `VITE_DEFAULT_RELAY` — overrides the built-in default relays (a
  comma-separated list; defaults to `wss://relay.damus.io`, `wss://nos.lol`
  and `wss://relay.primal.net`) that circles, beacons, and safety signals fan
  out to when a relay hasn't been picked explicitly in settings.
- `VITE_TILE_URL` — overrides the raster tile source the Map tab uses
  (defaults to OSM's public tile server); pair with `VITE_TILE_ATTRIBUTION`
  to change the attribution string shown alongside it.

## Native build (Android)

Kindependence ships as a Capacitor shell around the same web app. Native
code includes secure storage, signer intents, a relay socket service and the
home-screen widget below, alongside `@capacitor/local-notifications`,
`@capacitor-community/background-geolocation`, `@capacitor/device` for
reading the device's own battery level/charging state, and Capacitor's own
webview/plugin bridge.

The home-screen widget is the one piece of real native UI, under
`app/android/app/src/main/java/dev/forgesworn/kindependence/`: a tiny in-repo
Capacitor plugin (`WidgetBridgePlugin.java`) that `widget.ts` hands a small
JSON status payload to, which writes it to `SharedPreferences` and asks the
app-widget provider (`KindependenceWidgetProvider.java`, registered in
`AndroidManifest.xml`, declared via `res/xml/widget_kindependence_info.xml`, laid
out in `res/layout/widget_kindependence.xml`) to redraw — no network or JS access
from the provider itself, it only ever reads what the app last wrote.

```bash
# Run from the repository root. Requires JDK 21 and the Android SDK.
npm run -w app build
(cd app && npx cap sync android)
(cd app/android && ./gradlew assembleDebug)
```

`assembleDebug` produces `app/android/app/build/outputs/apk/debug/app-debug.apk`,
signed with the Android SDK's own local debug key — install straight to a
connected/emulated device:

```bash
adb install -r app/android/app/build/outputs/apk/debug/app-debug.apk
```

There is **no release signing key in this repo, checked out, or generated by
default** — `assembleRelease` reads a keystore from entirely outside the repo
(or produces an unsigned APK if none is configured) and requires a
deliberate, human-confirmed key-generation step before it can ever produce a
real, publishable, update-compatible signature. See
[`app/android/RELEASE_SIGNING.md`](app/android/RELEASE_SIGNING.md) for the
full procedure; nothing there is needed for `assembleDebug`/local testing.

## Dependency access

The app pins `@forgesworn/flock`, `roost-kit`, `covey-kit` and
`signet-contacts` to immutable commits in public Git repositories. BROOD is a
local module, so installing does not require access to its former repository.

npm may resolve GitHub dependencies over SSH. The Quickstart temporarily
rewrites those GitHub fetches to anonymous HTTPS for `npm ci`, so an SSH key
is not required and your global Git settings stay unchanged. If your GitHub
SSH access is already configured, plain `npm ci` also works.

`signet-login` is a checked-in MIT-licensed SDK snapshot with local fixes;
its provenance and replacement instructions are in [vendor/README.md](vendor/README.md).
No publishing or repository visibility changes are performed by the build.

## Contributing and security

Run `npm run typecheck`, `npm test` and `npm run build` before proposing a
change. Android bridge changes also need `./gradlew testDebugUnitTest` from
`app/android` and device testing. Please use synthetic identities, contacts
and locations in reports and fixtures.

For security reports, see [SECURITY.md](SECURITY.md). For data storage and
network behaviour, see [PRIVACY.md](PRIVACY.md).
