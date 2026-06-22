---
name: tauribuild
description: Use when working in the Veslo repository and the user asks to build the full installed-style desktop app with Tauri Pilot enabled, especially via /tauribuild, "build full app with Tauri Pilot", release-profile Pilot build, installed-app reproduction, or GitHub-release-equivalent local macOS testing.
---

# Tauribuild

## Overview

Build a full Veslo macOS desktop artifact that is as close as practical to the GitHub release build while exposing Tauri Pilot for installed-app reproduction. This is a Veslo-only workflow, not a generic Tauri recipe and not a production release path.

## Use The Script

Run the bundled script from the Veslo repo root:

```bash
.agents/skills/tauribuild/scripts/tauribuild.sh
```

Useful options:

```bash
.agents/skills/tauribuild/scripts/tauribuild.sh --dry-run
.agents/skills/tauribuild/scripts/tauribuild.sh --skip-launch-check
```

The script:
- verifies it is in the Veslo repository;
- creates a temporary local `tauri-plugin-pilot` 0.7.2 copy;
- patches only that temporary Pilot copy so the `press` feature enables the socket/bridge in release builds;
- temporarily patches Veslo's desktop app to register Pilot for `release + e2e`;
- builds from `packages/desktop` with the release profile, `aarch64-apple-darwin`, `.app`, DMG, and updater tarball bundles;
- restores `Cargo.toml`, `Cargo.lock`, and desktop `lib.rs` from backups after the build;
- verifies the resulting binary contains Pilot 0.7.2 and `window.__PILOT__`;
- when no Veslo app is already running, launches the built app in an isolated profile and checks `tauri-pilot ping` and `state`.

## Output

Expected artifact paths:

```text
packages/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Veslo by Neatech.app
packages/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/dmg/Veslo by Neatech_<current-version>_aarch64.dmg
packages/desktop/src-tauri/target/aarch64-apple-darwin/release/bundle/macos/Veslo by Neatech.app.tar.gz
```

The app uses the production bundle id and app version from the current checkout. Local builds are unsigned unless the local machine has Apple signing configured; GitHub release artifacts are signed by CI. Do not present this build as byte-for-byte identical to GitHub: the intentional test-only deltas are local signing state and Pilot 0.7.2.

## Common Mistakes

- Do not use `pnpm tauri build --debug`; that does not reproduce the installed release profile.
- Do not force global Rust `debug_assertions`; it makes Tauri release context generation incoherent.
- Do not leave a path dependency or Pilot registration patch in the repo after the build.
- Do not downgrade to Veslo's pinned Pilot 0.7.0 for this flow; it can connect on macOS but fails useful `state`/eval calls.
- Do not start a UI-only web server. The target runtime is the Tauri desktop app.
