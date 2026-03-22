# Veslo Fresh Updater Signing Design

**Date:** 2026-03-22
**Status:** Approved

## Goal

Restore Veslo desktop self-update testing from a clean state by rotating the Tauri updater signing key, making macOS code signing optional for internal test releases, and documenting the two-release flow required to validate the updater end to end.

## Current State

- The desktop app trusts the updater public key pinned in `packages/desktop/src-tauri/tauri.conf.json`.
- The matching private updater signing key is not available in the GitHub repo secrets, so new updater artifacts cannot be signed for the currently-installed builds.
- The release workflow always exports macOS signing environment variables into Tauri, even when the Apple secrets are unset. This causes macOS builds to fail during `security import`.
- Public updater publishing to `neatechcz/veslo-updates` happens only after the desktop build matrix succeeds, so the failed macOS jobs block `latest.json`.
- Because we are intentionally starting fresh, compatibility with previously-installed Veslo builds is not required.

## Decision

Use a new updater signing key as the trust root for the next round of test builds. Publish one new baseline build that is installed manually once, then publish a second newer build to verify the in-app updater.

At the workflow level, keep strict defaults for normal releases, but add an explicit internal-test path that allows unsigned macOS builds when Apple code signing secrets are unavailable.

## Design

### 1. Rotate the updater trust root

- Generate a fresh Tauri updater minisign keypair.
- Store the private key and password in `neatechcz/veslo` GitHub secrets.
- Replace the pinned updater public key in `packages/desktop/src-tauri/tauri.conf.json`.

This intentionally breaks update compatibility with any build signed by the old key. That is acceptable because we are resetting the test channel.

### 2. Make release signing mode explicit

Introduce a release-signing resolution step that determines:

- whether updater signing is available
- whether macOS Apple signing is available
- whether unsigned macOS builds are allowed for the current run

This step should fail fast when updater signing is missing, because a release without updater signatures is not useful for updater testing.

For macOS:

- default behavior remains strict: require Apple signing unless explicitly running an internal unsigned-mac test release
- when unsigned macOS is allowed, run the Tauri build without exporting Apple signing variables at all

This avoids the current broken behavior where empty Apple secret values still trigger Tauri's signing path.

### 3. Keep public updater publishing unchanged once artifacts exist

The existing public release flow already mirrors desktop artifacts to `neatechcz/veslo-updates` and publishes `latest.json` from that public repo. Keep that routing intact.

The only behavioral change needed there is to ensure the desktop matrix can complete successfully in the new internal-test signing mode.

### 4. Add repo-local verification coverage

Add test coverage for the release signing resolution logic instead of trying to test GitHub Actions YAML directly. The tests should cover:

- updater signing required and missing
- Apple signing secrets present
- Apple signing secrets absent but unsigned macOS explicitly allowed
- strict mode rejecting unsigned macOS

Also add a small repo assertion that the updater pubkey is non-empty and the public endpoint remains `neatechcz/veslo-updates`.

### 5. Document the actual updater test sequence

Because we are starting fresh, one release is not enough to prove the updater works.

Required sequence:

1. cut and publish a new baseline release, for example `v2026.3.1`
2. manually install that build
3. cut and publish a second newer release, for example `v2026.3.2`
4. open the installed app and confirm the Updates UI detects, downloads, and installs `v2026.3.2`

This must be documented so operators do not mistake a successful first release for a complete updater test.

## Operator Setup

Required source-repo secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`
- `RELEASE_UPDATES_GH_TOKEN`

Optional for signed production-like macOS releases:

- `APPLE_SIGNING_IDENTITY`
- `APPLE_CODESIGN_CERT_P12_BASE64`
- `APPLE_CODESIGN_CERT_PASSWORD`
- `APPLE_NOTARY_API_KEY_ID`
- `APPLE_NOTARY_API_ISSUER_ID`
- `APPLE_NOTARY_API_KEY_P8_BASE64`

Internal test release knobs:

- set workflow input `allow_unsigned_macos=true` when Apple secrets are not configured
- keep `notarize=false` for that internal test flow
- publish the baseline and follow-up versions as normal public desktop releases because there are no external users yet

## Verification

Local verification before dispatching a release:

- `node --test scripts/release/release-signing.test.mjs`
- `node --test scripts/release/public-release-assets.test.mjs`
- `node scripts/release/review.mjs --strict`

Release verification after dispatch:

- confirm the source release has signed updater assets
- confirm the mirrored public release exists in `neatechcz/veslo-updates`
- confirm `latest.json` resolves from the public repo
- confirm the second release is offered in the app's Updates UI
