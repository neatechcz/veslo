# Veslo Desktop Updater

This document describes the self-update system used by the Veslo desktop app.

Scope:

- Applies to the Tauri desktop app in `packages/desktop`
- Does not apply to the browser-only UI
- Current public updater channel is backed by `neatechcz/veslo-updates`

If you need to test updater behavior, use the desktop app or packaged desktop builds. Do not use `pnpm dev:ui` or `packages/web`; the updater only exists in the Tauri app.

## Current Model

Veslo uses the Tauri updater plugin for desktop self-updates.

- The trusted updater public key and updater endpoint live in `packages/desktop/src-tauri/tauri.conf.json`.
- The frontend calls `@tauri-apps/plugin-updater` from `packages/app/src/app/system-state.ts`.
- The desktop shell exposes updater permissions through `packages/desktop/src-tauri/capabilities/default.json`.
- The app restarts through `@tauri-apps/plugin-process` after a successful install.

Today the updater feed is served from:

- `https://github.com/neatechcz/veslo-updates/releases/latest/download/latest.json`

That public feed is produced by the release workflow in this repo and published after desktop artifacts are mirrored to the public `veslo-updates` repository.

## Runtime Flow In The App

The updater flow is split between the Tauri shell and the Solid app state.

### 1. Environment gating

On startup the app calls the `updater_environment` Tauri command.

- Rust implementation: `packages/desktop/src-tauri/src/updater.rs`
- Command wiring: `packages/desktop/src-tauri/src/commands/updater.rs`

This currently blocks updates when Veslo is running from a mounted macOS disk image or an App Translocation path.

Expected user-facing behavior:

- If the app is launched from a mounted `.dmg`, updates are disabled.
- The Settings page shows the reason: install Veslo to `Applications` first.

### 2. Updater state

Updater state is stored in the Solid updater context in `packages/app/src/app/context/updater.ts`.

States:

- `idle`
- `checking`
- `available`
- `downloading`
- `ready`
- `error`

The state machine is managed in `packages/app/src/app/system-state.ts`.

### 3. Automatic checks

On Tauri startup, the app performs a quiet update check once per launch.

After that:

- background checks run only when `veslo.updateAutoCheck=1`
- the app polls once per minute to see whether it should re-check
- it only performs a new quiet check when the last completed check is at least one hour old

Relevant keys in local storage:

- `veslo.updateAutoCheck`
- `veslo.updateAutoDownload`
- `veslo.updateLastCheckedAt`

`veslo.updateAutoDownload` is default-off when absent. Users can opt in through Settings; otherwise the app only announces the available update and keeps the manual download flow available. Legacy default-on stored values are migrated off once so older installs stop downloading updater artifacts on every launch unless the user enables auto-download again.

### 4. Manual checks

Manual checks use:

```ts
check({ timeout: 8_000 })
```

If Tauri reports an available update, Veslo stores the returned update handle and surfaces the release version and notes in the UI.

### 5. Downloading

Downloads do not start automatically by default after an update is detected. The update remains available until the user chooses Download, unless the user has explicitly enabled auto-download in Settings.

The app listens to Tauri download events and converts them into progress state for the UI.

Auto-download failures are retried by the app state machine. Veslo retries clean full downloads after 30 seconds, 2 minutes, and 10 minutes. Each retry performs a fresh quiet update check and uses a fresh Tauri update handle. Veslo does not resume partial updater files; the Tauri updater plugin remains responsible for download integrity and signature validation.

### 6. Installing

Install is intentionally gated:

- if any session is actively running, Veslo refuses to install the update
- once the app is idle, the install flow is:
  - `pending.update.install()`
  - `pending.update.close()`
  - `relaunch()`

This prevents the app from restarting in the middle of a task run.

### 7. UI surfaces

Updater state is exposed in three places:

- Settings update card
- dashboard left-menu update pill
- session view left-menu update pill

The Settings view remains the primary surface for manual testing because it exposes check controls and detailed updater state. With auto-download enabled, the left-menu pill moves through download progress and then exposes `Update`; with auto-download disabled, it keeps the manual `Download` action so users do not need to open Settings after an update has been detected.

## Release And Feed Pipeline

The release pipeline is responsible for producing signed updater artifacts and turning them into a public `latest.json` feed.

### Desktop build config

`packages/desktop/src-tauri/tauri.conf.json` enables updater artifacts:

- `bundle.createUpdaterArtifacts = true`
- `plugins.updater.pubkey = ...`
- `plugins.updater.endpoints = ["https://github.com/neatechcz/veslo-updates/releases/latest/download/latest.json"]`

### Signing requirements

All updater releases require Tauri updater signing.

Required secrets:

- `TAURI_SIGNING_PRIVATE_KEY`
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`

Optional macOS signing and notarization secrets:

- `APPLE_SIGNING_IDENTITY`
- `APPLE_CODESIGN_CERT_P12_BASE64`
- `APPLE_CODESIGN_CERT_PASSWORD`

macOS notarization can use either App Store Connect API key credentials:

- `APPLE_NOTARY_API_KEY_ID`
- `APPLE_NOTARY_API_ISSUER_ID`
- `APPLE_NOTARY_API_KEY_P8_BASE64`

Or Apple ID app-specific password credentials:

- `APPLE_NOTARY_APPLE_ID`
- `APPLE_NOTARY_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID` as a repository variable or secret

Use the Apple ID path when the Developer Program account can access certificates at
developer.apple.com but is not enabled for App Store Connect API keys.

The signing decision is centralized in `scripts/release/release-signing.mjs`.

Behavior:

- updater signing is always required
- non-macOS releases only require updater signing
- macOS can run in signed, signed-notarized, or explicitly allowed unsigned test mode
- unsigned macOS is only allowed through the `allow_unsigned_macos` workflow input or repo default

### Source release vs public release

The main release workflow is `.github/workflows/release-macos-aarch64.yml`.

The flow is:

1. Build desktop artifacts in the source repo release
2. Sign updater artifacts during the Tauri build
3. Mirror public desktop artifacts into `neatechcz/veslo-updates`
4. Generate `latest.json` from the mirrored public release assets
5. Upload `latest.json` to the matching public release

Helper scripts:

- `scripts/release/mirror-public-release.mjs`
- `scripts/release/generate-latest-json.mjs`
- `scripts/release/public-release-assets.mjs`

### Public platform coverage

The current public mirror script only mirrors:

- macOS desktop artifacts
- Windows desktop artifacts
- their `.sig` files

Windows installers may keep the installer-native MSI filename in the source release and expose the updater-stable `veslo-desktop-windows-*` name as the GitHub asset label. The mirror treats either the asset name or that label as the public artifact name before generating `latest.json`.

That means the public updater feed currently covers macOS and Windows. Release automation does not build Linux desktop artifacts.

### Why `latest.json` is generated separately

The workflow uses Tauri builds with:

- `uploadUpdaterJson: false`

This is intentional. Veslo generates `latest.json` after the public assets have been mirrored, so the URLs inside the feed point at the public distribution repo rather than the source repo.

### CI note

The manual `build-desktop` Windows workflow intentionally disables updater artifact generation by creating a temporary `tauri.conf.ci.json` with:

- `bundle.createUpdaterArtifacts = false`

That build is useful for build validation, but it is not a real updater release test.

## How To Test The Updater

There are three useful levels of testing.

### Level 1: Repo-level verification

These checks validate the release plumbing without publishing a new build.

Run from repo root:

```bash
node --test scripts/release/release-signing.test.mjs
node --test scripts/release/public-release-assets.test.mjs
node scripts/release/review.mjs --strict
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml --locked
```

What they cover:

- updater signing rules and unsigned-macOS gating
- public release repo routing
- updater endpoint and pinned public key assertions
- release version consistency
- desktop Rust test suite used by CI

What they do not cover:

- real artifact signatures
- real `latest.json` publishing
- real install and relaunch behavior

### Level 2: Feed verification after a published release

Use this after a release workflow has produced assets.

Checks:

1. Confirm the public release exists:

```bash
gh release view vYYYY.M.P --repo neatechcz/veslo-updates
```

2. Confirm it contains:

- `veslo-desktop-darwin-*`
- `veslo-desktop-windows-*`
- matching `.sig` files
- `latest.json`

3. Download and inspect the feed:

```bash
mkdir -p /tmp/veslo-updater-check
gh release download vYYYY.M.P \
  --repo neatechcz/veslo-updates \
  --pattern latest.json \
  --dir /tmp/veslo-updater-check
cat /tmp/veslo-updater-check/latest.json
```

Verify:

- `version` matches the release tag without the leading `v`
- `platforms` contains the expected target keys
- each platform entry points at `github.com/neatechcz/veslo-updates/...`
- each platform entry has a non-empty `signature`

You can also regenerate the feed locally against an existing release:

```bash
node scripts/release/generate-latest-json.mjs \
  --tag vYYYY.M.P \
  --repo neatechcz/veslo-updates \
  --output /tmp/latest.json
cat /tmp/latest.json
```

This requires GitHub access and, for private or draft-only scenarios, an appropriate `GH_TOKEN`.

### Level 3: Required end-to-end updater validation

Because the updater only offers newer versions to an already-installed build, a real E2E validation always requires two releases.

#### Baseline release

1. Prepare and publish a baseline desktop release, for example `v2026.4.1`.
2. Install that build manually.
3. On macOS, move the app into `/Applications` and launch it from there. Do not run it from a mounted `.dmg`.

Typical release commands:

```bash
pnpm release:prepare
pnpm release:ship --watch
```

Or use the `Release App` workflow dispatch directly if you need custom inputs such as `allow_unsigned_macos=true`.

#### Follow-up release

1. Publish a newer release, for example `v2026.4.2`.
2. Wait until the public release and `latest.json` are available in `neatechcz/veslo-updates`.

#### In-app validation

Using the installed baseline app:

1. Open Settings and find the Updates card.
2. Click `Check` if the app has not already detected the update.
3. Confirm the UI transitions through:
   - `available`
   - `downloading` if you click `Download` or auto-download is on
   - `ready`
4. Confirm release notes appear when the release body is present.
5. Start a session run and verify that install is blocked while work is active.
6. Stop the run and click `Install & Restart`.
7. Confirm the app relaunches into the newer version.

Secondary checks:

- the update pill appears in dashboard/session views
- `veslo.updateLastCheckedAt` advances after a successful check
- the app no longer offers the same update after relaunch

## Troubleshooting

### "Updates are not supported in this environment"

Most likely causes:

- running from a mounted macOS `.dmg`
- running from an App Translocation path

Fix:

- install Veslo into `/Applications`
- relaunch from the installed app bundle

### No update is offered

Check:

- the installed app is older than the published version
- the public release exists in `neatechcz/veslo-updates`
- `latest.json` was uploaded successfully
- the public release contains assets for the current platform

### macOS release jobs fail before artifact upload

Check:

- updater signing secrets are set
- Apple signing secrets are set for signed/notarized runs
- if this is an internal test-only build, use `allow_unsigned_macos=true`

## Current Gaps

- There is no dedicated updater E2E automation in `packages/e2e` today.
- Real updater validation still depends on a manual two-release flow.

## Related Files

- `packages/app/src/app/system-state.ts`
- `packages/app/src/app/context/updater.ts`
- `packages/app/src/app/app.tsx`
- `packages/app/src/app/pages/settings.tsx`
- `packages/desktop/src-tauri/src/updater.rs`
- `packages/desktop/src-tauri/tauri.conf.json`
- `packages/desktop/src-tauri/capabilities/default.json`
- `.github/workflows/release-macos-aarch64.yml`
- `scripts/release/release-signing.mjs`
- `scripts/release/mirror-public-release.mjs`
- `scripts/release/generate-latest-json.mjs`

## Related Design Docs

- `docs/plans/2026-03-11-veslo-updates-release-routing-design.md`
- `docs/plans/2026-03-22-updater-fresh-signing-design.md`
