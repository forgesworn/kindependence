# Local Signet SDK candidate

`signet-login-0.17.3-local.tgz` is an unpublished build from the sibling
`signet-login` repo, commit `d6de549` on
`fix/bunker-metadata-and-request-deadline`. It adds optional bunker display
metadata and a configurable NIP-46 response deadline. Existing consumers
retain the 15-second default.

This checked-in snapshot makes the local Kindependence changes reproducible
without publishing or pushing the SDK. It contains the SDK's existing 0.17.3
package version; it is not the registry release of that version. Replace the
file dependency with an upstream release once publishing is authorised.

Rebuild the SDK with `npm ci && npm run build`, then use `npm pack` and name
the resulting archive `signet-login-0.17.3-local.tgz`. Reinstall from the archive
to update package-lock.json's integrity value.
