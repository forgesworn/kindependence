# Data and network behaviour

Kindependence uses a separate device signing key and an external My Signet
identity signer. On Android, the phone signing key, contacts app key and bunker credentials
are encrypted using an Android Keystore key. Circle seeds and cached locations
are currently held in the WebView's plain localStorage, alongside circle state;
they do not receive the same Keystore protection. Browser builds use plain localStorage for device secrets and
are intended for development and testing.

The app stores circle state, granted contacts, activity, location-related
state and queued outgoing events on the device. Android cloud backup and device transfer are excluded.
Signing out clears app session data; it cannot erase data already delivered
to other circle members or retained by relays.

Circle traffic is encrypted and delivered through Nostr relays. Relays still
see connection metadata such as IP addresses, timing and public event
metadata. A circle uses a stable inbox tag until its seed changes, and beacon
cadence can reveal changes in sharing activity. Wraps request expiry after
roughly 16 days; relays may retain them longer. The built-in default relays are the public relays `wss://relay.damus.io`,
`wss://nos.lol` and `wss://relay.primal.net`; they are operated by third
parties, not by this project. A build can replace them using
`VITE_DEFAULT_RELAY` (a comma-separated list), The app currently has no relay editor; the saved-relay setting is a
configuration input, not an available settings control.

The map requests tiles directly from OpenStreetMap's public tile server by
default. The tile provider sees the viewer's IP address and the map areas
requested. Deployers can choose a different tile source with `VITE_TILE_URL`
and `VITE_TILE_ATTRIBUTION`. Optional routing and venue lookup use the
servers configured by the user. Routing requests can include this phone's
GPS coordinates and destinations; fair-spot requests include circle members'
shared positions. These requests are separate from circle sharing precision.
Leave reminders may make repeated routing requests. Opening an external navigation app shares
the selected destination with that provider.

Location, background location, camera and notification permissions support
sharing, QR scanning and alerts. Sharing precision and family settings
control what the app sends to circles. Members can retain information they
have already received. Treat test builds and public bug reports accordingly.

Android location sampling currently uses Google Play location services through
the background-geolocation plugin. The app cannot verify what the provider
transmits. Sending and geofence evaluation depend on the WebView running;
screen-off, restart and battery restrictions can interrupt updates. A foreground
service notification is not a delivery confirmation.
