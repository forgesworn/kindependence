// The app's built-in relay set — the one definition circles.ts, approvals.ts
// and signin.ts share. Deliberately import-free (and kept out of circles.ts,
// which approvals.ts cannot import without closing a module cycle — see
// approvals.ts's module doc comment), so any module can depend on it safely.

/** Public relays the app uses when the user has not chosen one. */
export const PUBLIC_RELAYS: readonly string[] = [
  'wss://relay.damus.io',
  'wss://nos.lol',
  'wss://relay.primal.net',
]

/** Parse a comma-separated relay list (a build-time `VITE_DEFAULT_RELAY`
 *  value): trims each entry and drops empties. */
export function parseRelayList(raw: unknown): string[] {
  if (typeof raw !== 'string') return []
  return raw.split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

/** The default relays: `VITE_DEFAULT_RELAY` (comma-separated) when set, else
 *  `PUBLIC_RELAYS`. Vite's ImportMetaEnv types env vars `any`, so the value is
 *  narrowed before use. */
export const DEFAULT_RELAYS: readonly string[] = (() => {
  const fromEnv = parseRelayList(import.meta.env.VITE_DEFAULT_RELAY)
  return fromEnv.length > 0 ? fromEnv : PUBLIC_RELAYS
})()

/** The relay set for a persisted-settings value: a user-set `relayUrl` wins as
 *  the only relay; otherwise a fresh copy of the defaults. */
export function relaysFromSettings(settings: { relayUrl?: string }): string[] {
  return settings.relayUrl ? [settings.relayUrl] : [...DEFAULT_RELAYS]
}
