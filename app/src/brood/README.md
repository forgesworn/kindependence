# BROOD module

Kindependence's family-logistics protocol: pure payload builders, strict
parsers and policy calculations for agreements and guardian approvals.

Import through `index.ts`. Storage, identity authority, encryption, signing
and relay transport remain the caller's responsibility. Family policy must
never gate SOS, check-in or other safety paths.

The source and three test suites were imported unchanged from the app's
previously pinned `@forgesworn/brood-kit` commit
`315fa4898a67e527944eeb450322ed1c44d1d212`. The original MIT notice is preserved
in [LICENSE](LICENSE). The wire specification is in
[docs/BROOD.md](../../../docs/BROOD.md).

Run the tests through the app's existing `npm test` command. Keep this module
free of app/platform dependencies so it can be extracted if another active
project needs it.
