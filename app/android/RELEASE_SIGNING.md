# Release signing — Kindependence Android APK

The release build (`assembleRelease`) signs with a keystore supplied **entirely
from outside the repo** — no key material is ever committed. The signing config
lives in `app/android/app/build.gradle` (`signingConfigs.release`) and reads a
`keystore.properties` file from
`~/.android-keystores/kindependence-keystore.properties` (override the path with
the `KINDEPENDENCE_KEYSTORE_PROPERTIES` env var).

**If the properties file is absent, `assembleRelease` produces an *unsigned*
APK** (`app/android/app/build/outputs/apk/release/app-release-unsigned.apk`)
rather than failing, so CI and other machines can still assemble. The
`assembleDebug` build always signs with the SDK's local debug key (fine for
on-device testing, **not** for distribution — different signature to the
release key, so a debug install must be uninstalled before a release APK will
install).

> ⚠️ **No release key exists yet.** This scaffolding only wires up where a key
> *would* be read from — it does not create one. Generating the permanent
> signing key is a deliberate, human-confirmed step (not something to script
> or run speculatively), because **the first key an app is published with is
> permanent**: every future update must be signed by the same key or
> Android/GrapheneOS refuses to install it as an update. Once created, the key
> is owned by the keyholder, held off-repo, and backed up per the restore
> notes below. Never lose it.

## keystore.properties format

```properties
storeFile=/absolute/path/to/kindependence-release.jks
storePassword=…
keyAlias=kindependence
keyPassword=…
```

## Creating the key (when ready — human decision, not automated)

```bash
keytool -genkeypair -v \
  -keystore ~/.android-keystores/kindependence-release.jks \
  -alias kindependence \
  -keyalg RSA -keysize 4096 -validity 10000
```

Store the resulting `.jks` and its passwords somewhere durable and offline
(password manager + encrypted backup, same pattern as Signet's key). Losing
the key means every future update is a new, incompatible application from
Android's point of view.

## Restoring on a new machine

1. Copy the `.jks` file and its `keystore.properties` to
   `~/.android-keystores/kindependence-keystore.properties` (or point
   `KINDEPENDENCE_KEYSTORE_PROPERTIES` at wherever they live).
2. Confirm `storeFile` in the properties file is an absolute path to the
   restored `.jks`.
3. Run `./gradlew assembleRelease` and verify the output is signed (see
   below) with the canonical cert digest before publishing.

## Canonical release cert

Every published APK must verify with this signing-cert digest (also stated in
the GitHub release notes so users can pin it):

```
SHA-256: TO BE RECORDED AT KEY CREATION
```

## Building a signed release

```bash
# from repo root
npm run build && (cd app && npx cap sync android)
cd app/android && ./gradlew assembleRelease
# → app/build/outputs/apk/release/app-release.apk  (signed, once the key exists)
```

Verify the signature:

```bash
"$ANDROID_HOME"/build-tools/<version>/apksigner verify --print-certs \
  app/build/outputs/apk/release/app-release.apk
```

Bump `versionCode` and `versionName` in `app/android/app/build.gradle` before
each release.

## Human steps still required before first publish

1. Decide on and generate the permanent release key (see above) — off-repo,
   never in CI logs.
2. Back it up per the restore procedure above.
3. Record the real certificate SHA-256 in this file, replacing the
   `TO BE RECORDED AT KEY CREATION` placeholder.
4. Provision the signed-build GitHub Actions secrets (base64 keystore +
   passwords — see `.github/workflows/release-apk.yml`) so CI can build signed
   APKs without the key ever touching the repo.
