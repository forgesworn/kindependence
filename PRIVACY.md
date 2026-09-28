# Data and network behaviour

Kindependence uses a separate device signing key and an external My Signet
identity signer. On Android, device secrets are encrypted using an Android
Keystore key. Browser builds use plain localStorage for device secrets and
are intended for development and testing.

The app stores circle state, granted contacts, activity, location-related
state and queued outgoing events on the device. Android backup is disabled.
Signing out clears app session data; it cannot erase data already delivered
to other circle members or retained by relays.

Circle traffic is encrypted and delivered through Nostr relays. Relays still
see connection metadata such as IP addresses, timing and public event
metadata. The built-in default relay is `wss://relay.trotters.cc`; it can be
overridden using `VITE_DEFAULT_RELAY` or circle settings.

The map requests tiles directly from OpenStreetMap's public tile server by
default. The tile provider sees the viewer's IP address and the map areas
requested. Deployers can choose a different tile source with `VITE_TILE_URL`
and `VITE_TILE_ATTRIBUTION`. Optional routing and venue lookup use the
servers configured by the user. Opening an external navigation app shares
the selected destination with that provider.

Location, background location, camera and notification permissions support
sharing, QR scanning and alerts. Sharing precision and family settings
control what the app sends to circles. Members can retain information they
have already received. Treat test builds and public bug reports accordingly.
