---
title: GitHub Actions Release Installer Improvement Implementation Plan
date: 2026-07-03
target: GitHub Actions release workflow, Tauri installers, bundled document runtime packages, public updater release
status: draft
done: false
base_branch: local/sandbox-merge
---

# GitHub Actions Release Installer Improvement Implementation Plan

## Goal

Make the GitHub Actions release produce a customer-grade desktop installer that
is self-contained, auditable, and aligned with the headless document-runtime
delivery model.

The release installer must:

- keep the default Windows installer path WSL-free
- bundle or pair the app with Veslo-owned runtime package assets
- fail release builds when required installer payloads are missing
- publish stable public assets for app updates and runtime-package updates
- keep manual MSI and prerelease workflows explicit about whether they are
  customer-ready or diagnostic/dev-only artifacts
- expose enough release-review checks that drift is caught before a tag ships

## Non-Goals

- Do not enable WSL provisioning in the default Windows installer.
- Do not make the release job build LibreOffice, Python, Node, Poppler, Pandoc,
  or platform runtime trees from scratch on every run.
- Do not use global package managers on customer machines.
- Do not rely on host-installed Microsoft Office, LibreOffice, Python, Node,
  Homebrew, Chocolatey, winget, npm, pip, or system `PATH` state.
- Do not conflate Tauri app updater artifacts with document-runtime package
  updater artifacts. They are related release assets, but they remain separate
  contracts.
- Do not block app installation forever if document-runtime activation fails.
  The installer may fail a release build, but an already-built app should report
  a clear local runtime unavailable state and offer repair/status actions.

## Current Release Surface

The current release path is centered on
`.github/workflows/release-macos-aarch64.yml`.

Important release jobs:

- `verify-release`: version and release-review gate.
- `publish-tauri`: macOS app bundle and updater artifacts.
- `publish-tauri-windows`: Windows MSI build and upload.
- `mirror-public-release`: mirrors approved source-release assets to the public
  updater repository.
- `publish-updater-json`: publishes public `latest.json`.

Adjacent workflows:

- `.github/workflows/build-desktop.yml`: manual Windows MSI artifact build.
- `.github/workflows/build-windows-msi.yml`: manual Windows MSI artifact build.
- `.github/workflows/prerelease.yml`: branch prerelease desktop artifacts.

The manual Windows workflows generate `src-tauri/tauri.conf.ci.json` to disable
Tauri updater artifacts. That config is useful for diagnostic/manual MSI
artifacts, but it is not the customer release config. Customer tag releases must
keep the base `tauri.conf.json` updater-artifact behavior and layer only the
runtime resource overlay plus platform release config.

Important installer config:

- `packages/desktop/src-tauri/tauri.conf.json`
  - `beforeBuildCommand` runs sidecar preparation and UI build.
  - `bundle.createUpdaterArtifacts` is enabled.
  - Windows `webviewInstallMode.type` is currently `skip`.
  - WSL scripts are present as resources, but default runtime delivery must not
    turn WSL on.
  - updater endpoint points at the public `veslo-updates` latest.json.
- `packages/desktop/src-tauri/tauri.windows.release.conf.json`
  - release-time Windows signing command and signing configuration.

Important release scripts:

- `scripts/release/review.mjs`
  - current strict release drift gate.
- `scripts/release/public-release-assets.mjs`
  - public asset allow-list and stable public names.
- `scripts/release/mirror-public-release.mjs`
  - source-to-public release mirroring.
- `scripts/release/generate-latest-json.mjs`
  - public app updater metadata.
- `scripts/release/generate-document-runtime-package-feed.mjs`
  - document-runtime package feed generation, including package content hashes.
- `scripts/release/verify-document-runtime-packages.mjs`
  - existing package/profile validator that must be extended rather than
    duplicated.
- `scripts/release/verify-document-runtime-windows.mjs` and
  `scripts/release/verify-document-runtime-macos.mjs`
  - platform-specific document-runtime verification.
- `scripts/release/verify-document-runtime-policy.mjs`
  - policy check for release/runtime defaults, including the no-WSL default
    installer rule.

The document-runtime implementation already defines a package-shaped direction:

- local runtime package assets use `.veslopkg` and `.veslopkg.sig`
- the public document-runtime feed is `document-runtime-packages.json`
- `local-docs-required` must fail when required local packages are missing
- `remote-docs-only` is an explicit non-default escape hatch

Current drift to account for before implementation:

- The package/profile validator already exists. The implementation must extend
  `verify-document-runtime-packages.mjs`, not create a second validator with the
  same ownership.
- The feed generator already writes package content hashes. The release
  verifier must compare package bytes to the feed hash instead of only checking
  that an artifact exists.
- `mirror-public-release.test.mjs` does not exist today. Any plan step that
  wants mirror-specific coverage must add that test explicitly, or keep expected
  core checks limited to existing tests.
- macOS release builds currently have multiple build branches: notarized bash
  build, signed `tauri-action`, and unsigned `tauri-action`. Runtime overlay
  wiring must cover all branches that can publish macOS artifacts.
- `src-tauri/tauri.conf.ci.json` disables updater artifacts in manual Windows
  workflows. Release-only examples must not use it unless they are explicitly
  labeled diagnostic dry-runs.

## Target Release Contract

Every customer release built from a tag must produce these release outputs:

- Windows MSI installer and Tauri updater artifacts.
- macOS app/update artifacts for supported architectures.
- `document-runtime-packages.json`.
- platform runtime packages:
  - `veslo-document-runtime-windows-native-x64-<runtime-version>.veslopkg`
  - `veslo-document-runtime-windows-native-x64-<runtime-version>.veslopkg.sig`
  - macOS equivalents for supported runtime platforms.

The source release may contain internal asset names. The public release must
contain stable public names accepted by `public-release-assets.mjs`.

The release must fail before publishing public updater metadata if any required
customer artifact is missing, unsigned, malformed, or not referenced by the
document-runtime package feed.

`document-runtime-packages.json` must have exactly one release owner. Platform
build jobs may materialize and upload platform package artifacts, but a single
post-build/feed step must generate or validate the shared feed after all
platform packages are known. Windows and macOS jobs must not race-upload or
clobber different copies of the shared feed.

## Installer Payload Model

Use a generated Tauri config overlay in CI instead of committing large runtime
packages into `tauri.conf.json`.

The overlay should map CI-produced files into app resources:

```json
{
  "bundle": {
    "resources": {
      "../../../.release/document-runtime/veslo-document-runtime-windows-native-x64-<version>.veslopkg": "document-runtime/veslo-document-runtime-windows-native-x64-<version>.veslopkg",
      "../../../.release/document-runtime/veslo-document-runtime-windows-native-x64-<version>.veslopkg.sig": "document-runtime/veslo-document-runtime-windows-native-x64-<version>.veslopkg.sig",
      "../../../.release/document-runtime/document-runtime-packages.json": "document-runtime/document-runtime-packages.json"
    }
  }
}
```

The exact relative paths should be generated from repo root and validated by a
script, not hand-maintained in YAML.

The app-side installer/bootstrap logic should treat the bundled package as the
offline first-run seed. The public feed remains the update source after install.

## Release Profiles

### `local-docs-required`

Default for customer releases.

Required behavior:

- bundled runtime package assets must exist for every customer platform being
  built
- package signature files must exist and feed hashes must verify
- generated Tauri config overlay must reference only existing files
- Windows release must remain WSL-free by policy
- `release:review --strict` must fail if the release workflow skips these gates

### `remote-docs-only`

Explicit non-default artifact profile.

Allowed behavior:

- no local runtime package is bundled
- installer is marked diagnostic/dev/prerelease, not customer-ready
- release notes and artifact metadata must clearly describe that document skills
  require remote execution or a future package repair path

This profile is useful for manual workflow debugging, but it must not silently
replace the customer release contract.

## Task Ledger

### GHAI01 - Release Workflow Contract Map

Status: implemented

Implementation:

- Document the current job graph for
  `.github/workflows/release-macos-aarch64.yml`.
- Add a small release-review fixture or parser helper that names the required
  installer jobs and required release steps.
- Teach `scripts/release/review.mjs` to report the release workflow as
  customer-installer-ready only when document-runtime package verification is
  wired into the tag release path.

Verification:

- `node --test scripts/release/review.test.mjs`
- `pnpm release:review --strict`

Implementation note:

- Added `Verify document runtime packages` to the release workflow's
  `verify-release` job.
- Added the `Release workflow gates local document runtime packages` strict
  review check, scoped to `verify-release`.
- This deliberately makes customer tag releases fail before Tauri publish when
  `local-docs-required` document-runtime packages are missing. It does not
  produce real `.veslopkg` payloads; that remains GHAI02/GHAI04-GHAI06.

### GHAI02 - Runtime Package Materialization and Validator Hardening

Status: pending

Implementation:

- Add a release step or reusable script that materializes already-built,
  signed, platform runtime packages into `.release/document-runtime`.
- Extend the existing `scripts/release/verify-document-runtime-packages.mjs`;
  do not add a parallel package validator.
- Inputs should be explicit:
  - package source path or release artifact id
  - runtime version
  - platform id
  - expected sha256
  - expected signature path
- Validate package/feed consistency:
  - every feed entry resolves to a staged `.veslopkg`
  - every staged customer package is referenced by the feed
  - package bytes match the feed `contentSha256`
  - `.veslopkg.sig` exists and is non-empty
- Keep this slice KISS: do not introduce new document-runtime signature
  key-management unless a real verification key is already wired in. Full
  cryptographic `.veslopkg.sig` verification is deferred release hardening; the
  first gate is `contentSha256` plus required signature-file presence.
- Keep `generate-document-runtime-package-feed.mjs` as the owner of feed
  generation and `verify-document-runtime-packages.mjs` as the owner of
  release-profile validation.
- The job must not assemble large third-party runtime trees from package
  managers during the release installer build.

Verification:

- `node scripts/release/verify-document-runtime-packages.mjs --profile local-docs-required --json`
- negative fixture: missing `.veslopkg` fails
- negative fixture: feed references a different hash fails
- negative fixture: package exists but `.veslopkg.sig` is missing or empty fails
- negative fixture: staged package is not referenced by the feed fails

### GHAI03 - Generated Tauri Resource Overlay

Status: pending

Implementation:

- Add `scripts/release/generate-tauri-runtime-resources.mjs`.
- Generate a CI-only Tauri config overlay that maps runtime packages and
  `document-runtime-packages.json` into `bundle.resources`.
- Refuse path traversal, missing files, duplicate destination paths, and
  platform/feed mismatches.
- Keep the base `tauri.conf.json` small; do not commit generated package
  resource entries.

Verification:

- `node --test scripts/release/generate-tauri-runtime-resources.test.mjs`
- generated overlay can be passed to `pnpm exec tauri build --config ...`
- generated overlay contains no absolute local developer paths

### GHAI04 - Windows MSI Release Integration

Status: pending

Implementation:

- Update `publish-tauri-windows` in
  `.github/workflows/release-macos-aarch64.yml`:
  - materialize Windows native runtime package before Tauri build
  - verify the package/feed before Tauri build
  - generate the Tauri runtime resource overlay
  - pass the overlay to `pnpm exec tauri -vvv build`
  - expose or upload Windows runtime package assets for the single feed-owner
    step
- Do not upload `document-runtime-packages.json` from the Windows build job.
  The shared feed is generated/validated once after all platform package assets
  are available.
- Add an explicit WSL policy check before MSI build:
  - default profile must not run WSL import/provision/repair steps
  - WSL scripts may remain resources only for an explicit future opt-in path

Verification:

- `pnpm release:review --strict`
- `node scripts/release/verify-document-runtime-policy.mjs --json`
- Windows dry-run or fixture test proves the generated MSI payload references
  the runtime package resources

### GHAI05 - macOS Release Integration

Status: pending

Implementation:

- Update macOS release matrix steps to materialize macOS runtime package assets
  before Tauri build.
- Generate the same Tauri resource overlay for the active macOS platform.
- Wire the overlay through every macOS publishing branch that can emit release
  artifacts:
  - notarized bash build using `pnpm exec tauri -vvv build`
  - signed `tauri-apps/tauri-action`
  - unsigned `tauri-apps/tauri-action`
- Keep the branch conditions intact. The overlay must be an additional config
  input, not a rewrite of signing/notarization selection.
- Confirm the resource inclusion happens before signing/notarization so app
  bundle signatures cover the packaged payload.
- Expose or upload macOS runtime package assets for the single feed-owner step.
- Do not upload `document-runtime-packages.json` from any macOS matrix branch.
  The shared feed is generated/validated once after all platform package assets
  are available.

Verification:

- `pnpm release:review --strict`
- macOS build log includes generated runtime overlay path
- notarization/signing step runs after resources are included
- a review fixture fails if any macOS publishing branch omits the overlay config

### GHAI06 - Public Release Asset and Feed Contract

Status: pending

Implementation:

- Add a single feed-owner release step after platform package materialization
  and before public mirroring.
- That step owns `document-runtime-packages.json`:
  - collect all Windows/macOS package artifacts and signatures
  - generate or validate one shared feed
  - verify every feed `contentSha256`
  - verify every referenced `.veslopkg.sig` exists and is non-empty
  - upload exactly one shared feed artifact to the source release
- Keep `scripts/release/public-release-assets.mjs` as the single allow-list for
  public runtime package asset names.
- Ensure `mirror-public-release` mirrors:
  - `.veslopkg`
  - `.veslopkg.sig`
  - `document-runtime-packages.json`
- Add a validation step before `publish-updater-json`:
  - public release contains every package referenced by
    `document-runtime-packages.json`
  - app `latest.json` remains valid and separate from the document-runtime feed
- The validator must run after `mirror-public-release` and before
  `publish-updater-json`, because the thing being verified is the public release
  state, not only the private source release.

Verification:

- `node --test scripts/release/public-release-assets.test.mjs`
- add `scripts/release/mirror-public-release.test.mjs` only if mirror-specific
  behavior needs direct unit coverage
- add or extend a public feed validator test before making it part of the core
  command set
- feed validator fails when a referenced public package asset is absent

### GHAI07 - Manual Workflow Profile Handling

Status: pending

Implementation:

- Decide profile behavior for:
  - `.github/workflows/build-desktop.yml`
  - `.github/workflows/build-windows-msi.yml`
  - `.github/workflows/prerelease.yml`
- Preferred KISS path:
  - manual diagnostic workflows default to `remote-docs-only`
  - customer-equivalent manual workflow must opt into `local-docs-required`
    and provide runtime package inputs
- Surface the selected profile in artifact names or summary output.

Verification:

- `scripts/release/review.mjs` detects profile drift
- manual workflow YAML clearly exposes the selected profile

### GHAI08 - Installer Payload Smoke Checks

Status: pending

Implementation:

- Add a post-build script that inspects built artifacts without installing them:
  - Windows MSI contains expected bundled resource payload or companion package
    artifacts
  - macOS app bundle contains expected resource payload
  - updater sidecars and document-runtime package feed are both present
- Prefer deterministic archive/MSI inspection over launching a GUI installer in
  CI.

Verification:

- positive fixture: built payload contains the runtime package
- negative fixture: missing package causes release failure before public publish
- CI summary reports package names, sha256 values, and feed path

### GHAI09 - App Bootstrap Contract

Status: pending

Implementation:

- Ensure the desktop app can locate the bundled package at runtime.
- The first-run repair/status path should:
  - read the bundled feed
  - verify the bundled package hash and signature-file presence
  - stage or activate the package in the Veslo-owned runtime directory
  - report actionable status if activation fails
- The app must not fall back to global host tools to mask a broken bundled
  package.

Verification:

- unit tests for bundled-feed discovery
- route/status tests for package present, package missing, and invalid
  hash or missing-signature states
- local `remote-docs-only` profile still reports that no local runtime package
  is bundled

### GHAI10 - Release Operator Checklist

Status: pending

Implementation:

- Update `RELEASE.md` with the installer contract:
  - required package inputs
  - release profile
  - expected public assets
  - strict review command
  - rollback/repair notes for document-runtime package feed mistakes
- Add a concise release note template entry for document-runtime package
  versions.

Verification:

- `pnpm release:review --strict`
- release docs mention both app updater `latest.json` and
  `document-runtime-packages.json`

## First Implementation Slice

Implement this before changing the full release workflow:

1. Add `scripts/release/generate-tauri-runtime-resources.mjs` and tests.
2. Extend the existing `scripts/release/verify-document-runtime-packages.mjs`
   and tests for hash, signature, staged-package, and feed consistency.
3. Extend `scripts/release/review.mjs` so strict review fails unless the tag
   release workflow contains the new package verification and Tauri overlay
   steps.
4. Wire the Windows release job first, because it is the primary customer MSI
   path and already has a dedicated `publish-tauri-windows` job.
5. Add the single feed-owner step so Windows/macOS package jobs cannot race on
   `document-runtime-packages.json`.
6. Then wire the macOS publishing branches and the public release feed
   validator.
7. Keep manual Windows workflows in `remote-docs-only` until they accept
   package inputs.

This slice gives an immediate drift gate and an auditable packaging path without
requiring the release job to manufacture the full document runtime itself.

## Acceptance Criteria

- `pnpm release:review --strict` fails if the customer tag release can publish
  an installer without the required document-runtime package gate.
- A `local-docs-required` tag release cannot publish public updater metadata
  unless all required `.veslopkg`, `.veslopkg.sig`, and
  `document-runtime-packages.json` assets are present and valid.
- The Windows MSI build receives a generated Tauri config overlay that maps the
  runtime package payload into app resources.
- macOS builds include runtime package resources before signing/notarization.
- The public release mirrors document-runtime package assets using stable names.
- Manual MSI/prerelease workflows are visibly marked as `remote-docs-only` or
  explicitly provide local runtime package inputs.
- WSL remains disabled in the default Windows installer path.

## Verification Command Set

Expected core checks:

```powershell
node --test scripts/release/review.test.mjs
node --test scripts/release/public-release-assets.test.mjs
node --test scripts/release/generate-document-runtime-package-feed.test.mjs
node --test scripts/release/verify-document-runtime-packages.test.mjs
node --test scripts/release/verify-document-runtime-windows.test.mjs
node --test scripts/release/verify-document-runtime-macos.test.mjs
node scripts/release/verify-document-runtime-policy.mjs --json
node scripts/release/verify-document-runtime-packages.mjs --profile remote-docs-only --json
pnpm release:review --strict
```

Expected checks after GHAI03 adds the overlay generator:

```powershell
node --test scripts/release/generate-tauri-runtime-resources.test.mjs
```

Expected release-only checks after runtime package artifacts exist:

```powershell
node scripts/release/verify-document-runtime-packages.mjs --profile local-docs-required --json
node scripts/release/generate-tauri-runtime-resources.mjs --profile local-docs-required --out .release/tauri.document-runtime.conf.json
pnpm --filter @neatech/veslo exec tauri build --config .release/tauri.document-runtime.conf.json --config src-tauri/tauri.windows.release.conf.json --target x86_64-pc-windows-msvc --bundles msi
```

For manual/diagnostic MSI dry-runs that intentionally disable updater
artifacts, `src-tauri/tauri.conf.ci.json` may still be used, but those artifacts
must be treated as `remote-docs-only` or otherwise non-customer release builds.

## Risks and Mitigations

- Risk: release workflow becomes too slow if it assembles large runtime trees.
  Mitigation: materialize prebuilt signed runtime packages; build the package in
  a separate controlled pipeline.
- Risk: Tauri resource paths drift because they are hand-maintained in YAML.
  Mitigation: generate the overlay from verified package/feed inputs.
- Risk: manual MSI workflows look customer-ready while omitting bundled runtime
  packages.
  Mitigation: make their profile explicit and include profile checks in
  `release:review`.
- Risk: app updater metadata and document-runtime package feed get mixed.
  Mitigation: keep `latest.json` and `document-runtime-packages.json` as
  separate validation targets.
- Risk: Windows and macOS jobs upload competing shared feed files.
  Mitigation: make one post-build/feed step own
  `document-runtime-packages.json`; platform jobs only provide package inputs.
- Risk: WSL scripts remain in resources and are mistaken for default installer
  behavior.
  Mitigation: keep a release policy check that verifies the default installer
  path does not run WSL provisioning.

## Done Definition

This plan is complete when a tag release can produce a Windows MSI and macOS
installer/update artifacts that either:

- pass `local-docs-required` with bundled, signed document-runtime package
  payloads and mirrored public package assets, or
- are explicitly marked as `remote-docs-only` and cannot be mistaken for the
  customer-ready installer.

The top-level plan should remain `done: false` until the full release workflow,
manual workflow profile handling, installer payload smoke checks, and public
asset/feed verification are all implemented and passing in CI.
