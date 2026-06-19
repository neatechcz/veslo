# Hybrid WSL Runtime Distribution Plan

Status: draft  
Date: 2026-06-20  
Owner: Veslo desktop/runtime

> Strategy framing: despite the file slug, this is **online-first with a
> first-class offline/corporate fallback**, not offline-by-default. "Hybrid"
> throughout means online is the normal path and offline is fully supported.
> (The `offline-first` slug is misleading; consider renaming the file.)

## Problem

The Windows desktop package already bundles the host-side Veslo/OpenCode
sidecars, but the Windows sandbox runtime is not actually the Windows
OpenCode executable. Veslo runs OpenCode inside WSL2 through a Linux runtime.

The current managed WSL provisioning path is fragile for clean corporate
machines because it builds the runtime from the network at install/repair time:

- downloads the Ubuntu WSL rootfs
- downloads checksum metadata
- runs apt inside the distro
- downloads the Linux OpenCode release asset

Some network use is fine. Ubuntu rootfs downloads and apt installs are normal
runtime bootstrap mechanics, similar to how this repo already downloads pinned
tooling and release assets during build/dev flows. The problem is making that
network use a hidden prerequisite for the first real session and then surfacing
only a generic engine failure.

The product needs a hybrid path:

- online provisioning for normal users, with explicit progress, checksums,
  cache, and remediation
- offline/corporate provisioning for machines where GitHub, Ubuntu mirrors, or
  apt repositories are blocked
- no unpinned `latest` defaults and no upstream OpenCode download when Veslo can
  publish the matching Linux OpenCode asset itself

## GitHub Distribution Constraints

Use GitHub Releases for binary runtime payloads, not normal repository blobs.

Current GitHub docs checked on 2026-06-20:

- normal git repository objects are enforced at 100 MB
- release assets: up to 1000 assets per release, each asset must be under 2 GiB
- re-confirm those limits at implementation/release time because GitHub has
  changed limits historically

Even though GitHub Releases allow assets far larger than 200 MB, any optional
offline runtime bundle should use a conservative chunk target of 190 MiB per
part. That keeps the payload friendly to corporate proxies, mirrors, AV
scanners, and manual browser downloads while still avoiding git/LFS/billing
complexity.

References:

- https://docs.github.com/en/repositories/releasing-projects-on-github/about-releases
- https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits
- https://docs.github.com/repositories/working-with-files/managing-large-files/about-git-large-file-storage

## Goals

1. A Windows machine with WSL2 already enabled can provision VesloSandbox
   through either online bootstrap or a preseeded offline cache.
2. Linux OpenCode used inside WSL matches the OpenCode version bundled with the
   desktop app.
3. All directly downloaded or preseeded runtime artifacts are pinned,
   checksummed, and versioned.
4. MSI install remains non-destructive and per-user WSL import happens only in
   the correct user context.
5. Network use is visible, diagnosable, cacheable, and disabled in offline-only
   mode.
6. The same GitHub release can support normal users and enterprise deployment.

## Non-Goals

- Silently enabling WSL Windows features on locked-down machines.
- Avoiding all admin/reboot requirements when WSL is not installed.
- Mutating a user's personal Ubuntu distro as the product default.
- Making model inference/auth fully offline.
- Solving WSL history/database storage as part of this installer change.

## Recommended KISS Architecture

Use online provisioning as the normal path, and make offline provisioning a
first-class fallback.

Normal online path:

- download the pinned Ubuntu 22.04 WSL rootfs from the official Ubuntu source
- verify it against the rootfs SHA256 frozen into the bundled manifest
- import it as the managed `VesloSandbox` distro
- create/configure the `veslo` user and `/etc/wsl.conf`
- install `bubblewrap` and CA certificates through apt
- install Linux OpenCode from a Veslo-published release asset or local cache
- verify bwrap, DNS, OpenCode version, and workspace visibility

Offline/corporate path:

- use a preseeded runtime cache prepared from the same manifest
- optionally use a prebuilt rootfs bundle if apt/Ubuntu mirrors are blocked
- never require public internet during first-run repair when `OfflineOnly=true`

The key KISS rule: do not make the rootfs heavier unless the environment needs
it. Let normal users download Ubuntu/apt online. Give corporate installs a
preseeded cache and optional prebuilt rootfs bundle.

The standalone Linux OpenCode asset should be published by Veslo with the
Windows release. Repair can then update `/usr/local/bin/opencode` in-place when
the base distro is otherwise healthy. User install/repair should not fetch
OpenCode directly from upstream GitHub by default.

"Upstream" here means the OpenCode engine repo (`anomalyco/opencode`) that the
provisioner downloads `opencode-linux-x64-baseline.tar.gz` from today - the same
source the macOS/release build already uses. This is not a third-party trust
problem; it is availability and mirrorability. End-user first-run/repair should
pull the pinned baseline from a Veslo-controlled release asset (or local cache)
so rate-limited or blocked-network machines still work. Build-time mirroring of
that asset from the engine repo into the Veslo release stays fine.

## Artifact Manifest

The provisioning manifest should be small JSON and included both:

- as a GitHub Release asset
- as a desktop app resource for local version checks

Suggested shape:

```json
{
  "schemaVersion": 1,
  "runtimeId": "veslo-wsl-provisioning-windows-x64",
  "appVersion": "2026.6.1",
  "provisioningVersion": "2026.6.1-wsl1",
  "arch": "x64",
  "distroName": "VesloSandbox",
  "baseOs": "ubuntu-22.04",
  "opencodeVersion": "1.17.4",
  "minWindowsBuild": 19045,
  "requiresWsl2": true,
  "onlineRootfs": {
    "url": "https://cloud-images.ubuntu.com/wsl/releases/22.04/current/ubuntu-jammy-wsl-amd64-wsl.rootfs.tar.gz",
    "checksumSourceUrl": "https://cloud-images.ubuntu.com/wsl/releases/22.04/current/SHA256SUMS",
    "fileName": "ubuntu-jammy-wsl-amd64-wsl.rootfs.tar.gz",
    "sha256": "<sha256-frozen-at-veslo-release-time>",
    "resolvedAt": "2026-06-20T00:00:00Z"
  },
  "aptPackages": {
    "packages": ["bubblewrap", "ca-certificates"],
    "allowOnlineInstall": true,
    "versionPolicy": "ubuntu-repository-current"
  },
  "opencodeLinuxAsset": {
    "source": "veslo-github-release",
    "releaseRepo": "neatechcz/veslo-updates",
    "releaseTag": "v2026.6.1",
    "url": "https://github.com/neatechcz/veslo-updates/releases/download/v2026.6.1/opencode-linux-x64-baseline-1.17.4.tar.gz",
    "fileName": "opencode-linux-x64-baseline-1.17.4.tar.gz",
    "sha256": "<sha256>",
    "sizeBytes": 0
  },
  "optionalOfflineRootfs": {
    "fileName": "veslo-wsl-runtime-windows-x64-2026.6.1.rootfs.tar.gz",
    "sha256": "<sha256>",
    "parts": []
  },
  "createdAt": "2026-06-20T00:00:00Z"
}
```

### Manifest integrity, naming, and arch

- **Trust anchor.** Asset hashes live inside the manifest, so the manifest is
  itself the root of trust. The copy shipped as a desktop app resource is
  authoritative. A manifest fetched as a release asset must byte-match the
  bundled copy (or pass a signature/pin check) before its hashes are trusted;
  otherwise the hash-pinning is circular and a swapped manifest defeats it.
- **Rootfs pinning.** `onlineRootfs.url` may point at Ubuntu's `current/`
  location, but `onlineRootfs.sha256` is the pin. The release job resolves the
  current rootfs once, freezes its SHA256 into the bundled manifest, and the
  provisioner rejects any later download that does not match that hash.
  `checksumSourceUrl` is diagnostic/provenance only; it is not the runtime root
  of trust.
- **Apt reproducibility.** Online apt installs are package-name pinned against
  the configured Ubuntu repositories; they are not byte-reproducible unless we
  move to an apt snapshot or prebuilt rootfs. This is acceptable for the normal
  online bootstrap path. Corporate/offline installs that require exact bytes
  should use the optional prebuilt rootfs bundle or an internally mirrored apt
  snapshot.
- **Asset naming.** `opencodeLinuxAsset.fileName` must match exactly what the
  release builder uploads. The engine repo's native asset is
  `opencode-linux-x64-baseline.tar.gz` (no version in the name). Either keep
  that name on the re-hosted asset or commit to a versioned
  `opencode-linux-x64-baseline-<version>.tar.gz` and make the builder produce
  it - do not let the manifest and the uploaded file drift.
- **OpenCode locator.** `opencodeLinuxAsset` must include an immutable release
  locator (`releaseRepo` + `releaseTag`, or a full `url`). It must not depend on
  `latest`, because the bundled manifest and sidecar versions are the pin.
- **Per-arch manifest.** `arch`, `onlineRootfs`, and `optionalOfflineRootfs`
  are architecture-specific. If arm64 is added (Open Question 2), publish one
  manifest per arch rather than overloading the x64 manifest.

### Runtime markers (new artifacts)

Neither marker exists today; both must be added because the provisioning flow
relies on them to decide "base runtime fresh vs stale".

- **In-distro** `/etc/veslo-runtime.json`, written by the provisioner after a
  successful import/setup:

  ```json
  {
    "schemaVersion": 1,
    "provisioningVersion": "2026.6.1-wsl1",
    "baseOs": "ubuntu-22.04",
    "opencodeVersion": "1.17.4",
    "provisionedAt": "2026-06-20T00:00:00Z"
  }
  ```

- **Host-side** `%LOCALAPPDATA%\Veslo\wsl\<distro>\runtime.json` with the same
  `provisioningVersion`/`opencodeVersion` plus a verification timestamp, so
  first-run/Settings can report runtime status without entering WSL.

Staleness compares the marker's `provisioningVersion` (base runtime) and
`opencodeVersion` against the bundled manifest: a base-runtime mismatch requires
explicit repair/`-Force`; an OpenCode-only mismatch is fixed in place.

## Release Asset Strategy

Do not commit rootfs or OpenCode Linux assets into the repository.

Use this release layout:

- normal MSI remains a GitHub Release asset
- WSL provisioning manifest is a GitHub Release asset and app resource
- Linux OpenCode asset is a GitHub Release asset
- optional offline rootfs parts are GitHub Release assets only when we decide to
  support fully offline/corporate bootstrap
- optional `veslo-windows-offline-x64-<version>.zip` can bundle MSI plus the
  provisioning manifest, Linux OpenCode asset, and rootfs parts if it stays
  practical

For enterprise/corporate deployment, provide a small bootstrap script in the
offline bundle that:

1. verifies all included hashes
2. copies runtime assets into a known cache directory
3. runs the MSI
4. lets Veslo first-run/repair import the distro under the target user

Recommended cache lookup order:

1. explicit `VESLO_WSL_RUNTIME_DIR`
2. `%ProgramData%\Veslo\wsl-runtime-cache`
3. `%LOCALAPPDATA%\Veslo\wsl-runtime-cache`
4. app resource directory, if assets are bundled with a full installer
5. optional user-approved GitHub download only when not in offline-only mode

## Provisioner Changes

Extend the Windows WSL provisioner with hybrid inputs:

- `-ProvisioningManifestPath`
- `-RuntimeCacheDir`
- `-RootfsPartsDir`
- `-OpencodeLinuxAssetPath`
- `-OfflineOnly`
- `-AllowDownload`
- `-Force`
- `-CheckOnly`

Default production behavior from first-run/repair:

- local manifest required
- use local cache first
- allow Ubuntu rootfs download and apt only after explicit user action
- download Linux OpenCode from Veslo release/cache, not upstream OpenCode, by
  default
- `OfflineOnly=true` disables all network use and requires preseeded inputs

Flag precedence (state it explicitly to avoid ambiguity when flags combine):

- `-OfflineOnly` overrides everything: no network regardless of
  `-AllowDownload`, and a fast failure if a required input is missing from
  cache/parts.
- `-AllowDownload` only applies when `-OfflineOnly` is unset; it gates Ubuntu
  rootfs/apt and, as a last resort, the Veslo OpenCode asset download.
- `-CheckOnly` never downloads or mutates WSL.
- The existing `-SkipAptUpdate` flag is kept for backward compatibility (the MSI
  wrapper and current callers pass a fixed argument set); `-OfflineOnly` implies
  no apt at all.

Default MSI custom action behavior:

- no large downloads
- check and repair only when local cache is already available
- otherwise log the missing prerequisite and let first-run handle it

Provisioning flow:

Common preflight:

1. Check Windows and `wsl.exe`.
2. If WSL is missing or unusable, exit with a specific prerequisite status.
3. Locate and validate the provisioning manifest (the bundled copy is
   authoritative).

Branch A - `VesloSandbox` does not exist (fresh import):

4. Resolve rootfs from local cache, optional offline parts, or - only when
   downloads are allowed - the pinned online URL.
5. Verify the rootfs against `onlineRootfs.sha256` or
   `optionalOfflineRootfs.sha256` before import.
6. Import the verified rootfs as `VesloSandbox`.
7. Configure the `veslo` user, `/etc/wsl.conf`, and base packages (online: apt
   update/install for the pinned package names; offline: require those packages
   to already exist in the prebuilt rootfs).
8. Resolve and verify the Linux OpenCode asset (local cache or Veslo release),
   then install it to `/usr/local/bin/opencode`.
9. Write the in-distro `/etc/veslo-runtime.json` marker.

Branch B - `VesloSandbox` already exists (check/repair):

4. Read `/etc/veslo-runtime.json`. If it is absent or unreadable, treat the
   distro as base-runtime-stale.
5. If the base runtime matches the manifest but OpenCode is stale/missing,
   install OpenCode in place from the verified local/Veslo asset and refresh the
   marker - no rootfs reimport.
6. If the base runtime is stale, require explicit repair or `-Force`; do not
   reimport destructively without clear user/IT intent.

Both branches finish with:

10. Terminate/restart the distro so `/etc/wsl.conf` (default user) applies.
11. Run bwrap, DNS, user, wsl.conf, workspace-path, and OpenCode version checks.
12. Write/refresh the host-side runtime marker with version and verification
    timestamp.

## MSI And First-Run Behavior

The MSI custom action can remain best-effort, but it should not be the only
product path. WSL distros are per-user, and enterprise installers often run as
SYSTEM.

Most of this is already implemented: the MSI wrapper skips provisioning under
SYSTEM today and runs a check-before-repair pass so app updates do not reinstall
a healthy distro. The new work is offline/manifest awareness and the runtime
status screen, not the SYSTEM/best-effort behavior.

Expected behavior:

- MSI installs app files and provisioning scripts.
- MSI attempts a per-user prewarm only when not running as SYSTEM.
- MSI does not perform large network downloads by default.
- If prewarm cannot run, app first-run shows the runtime status screen.
- First-run repair runs under the actual desktop user.

First-run states:

- ready
- WSL missing
- WSL installed but reboot required
- WSL2 unavailable
- online provisioning unavailable
- offline cache missing
- offline cache corrupt
- VesloSandbox missing
- VesloSandbox outdated
- bubblewrap unavailable
- Linux OpenCode unavailable or wrong version
- workspace path not visible inside WSL

Each state needs a short user-facing remediation and a machine-readable code
for support/enterprise scripts.

## Build Pipeline

Add a release-only provisioning asset job:

1. Resolve pinned app version and OpenCode version.
2. Download the pinned Linux OpenCode release asset during release build.
3. Verify or compute the Linux OpenCode asset hash.
4. Resolve the official Ubuntu rootfs URL during release build and freeze the
   resolved rootfs SHA256 into the provisioning manifest.
5. Upload the manifest and Linux OpenCode asset to the GitHub Release.
6. Optional corporate bundle job: build a preconfigured rootfs, compress it,
   split into 190 MiB parts if needed, hash every part, and upload the parts.

Release review must fail if:

- Windows MSI release has no matching WSL provisioning manifest.
- Provisioning manifest OpenCode version differs from desktop/orchestrator
  pinned OpenCode version.
- Provisioning manifest rootfs entry is missing a frozen SHA256.
- Provisioning manifest OpenCode entry is missing an immutable release locator.
- Linux OpenCode asset is missing or un-hashed.
- Optional offline runtime parts are missing hashes.
- Optional offline runtime parts exceed the configured chunk limit.
- Provisioner contains upstream OpenCode download as the default path.

## Pinned Defaults Outside WSL

Starter workspace creation should not seed commands that fetch `@latest`
packages by default.

Required follow-up:

- replace `npx -y chrome-devtools-mcp@latest` in seeded workspace templates with
  the already-bundled `chrome-devtools-mcp` sidecar (a pinned shim exists), so
  first-run does not depend on npm or the network
- audit all default workspace templates for `latest`, `curl`, `wget`, `npx -y`,
  and package-manager installs
- allow explicit user-triggered online installs later, but keep first-run
  defaults offline-safe

## Test Matrix

Minimum Windows verification before shipping:

1. WSL2 enabled, no VesloSandbox, network allowed: online provisioning succeeds
   with visible progress and verified downloads.
2. WSL2 enabled, no VesloSandbox, no network, preseeded cache present:
   provisioning succeeds without network calls.
3. WSL2 enabled, no VesloSandbox, no network, no cache: first-run reports
   offline cache missing, not engine failure.
4. WSL2 enabled, corrupted offline part: import fails before mutating WSL.
5. WSL2 enabled, existing healthy VesloSandbox: check-only passes and no
   reinstall occurs.
6. WSL2 enabled, stale OpenCode only: OpenCode updates from local/Veslo asset.
7. WSL2 enabled, stale base runtime: repair requires explicit force/consent.
8. WSL missing: installer/app reports prerequisite, no misleading runtime error.
9. Install under SYSTEM: MSI skips WSL import, first-run user repair succeeds.
10. Corporate offline/proxy-blocked machine with `OfflineOnly=true`: no
   provisioner network calls occur.
11. First clean private session: workspace/draft creates offline, first send
   reaches the WSL OpenCode runtime after repair.
12. Update install: existing runtime is reused when compatible.

## Implementation Phases

### Phase 1: Manifest And Release Contract

- Define runtime manifest schema.
- Add release review checks.
- Add tests that reject unpinned or upstream-default downloads.
- Document GitHub release asset layout.

### Phase 2: Release Asset Builder

- Add a script/job that publishes the Linux OpenCode asset and provisioning
  manifest.
- Add optional offline rootfs build and chunking path.
- Publish dry-run artifacts locally before touching release automation.

### Phase 3: Hybrid Provisioner

- Add manifest/cache/asset inputs.
- Add hash verification for online and offline inputs.
- Use cache first, then allowed online downloads.
- Keep `-OfflineOnly` as a hard no-network mode.
- Remove upstream OpenCode download from the default path.

### Phase 4: Desktop First-Run Repair

- Add a WSL runtime doctor command.
- Surface actionable runtime states in onboarding/settings.
- Run repair in user context.
- Keep MSI prewarm best-effort only.

### Phase 5: Offline Starter Defaults

- Replace online `@latest` seeded tool commands.
- Verify new private workspace creation without internet.

### Phase 6: Clean-Machine E2E

- Add repeatable Windows VM/manual runbook.
- Capture logs/artifacts for each test matrix row.
- Promote the runbook into release criteria.

## Open Questions

1. Should the optional corporate asset be a single offline ZIP or MSI plus
   sidecar runtime parts?
2. Do we support Windows arm64 in the first pass, or x64 only?
3. Do we build a preconfigured rootfs in the first pass, or rely on official
   Ubuntu rootfs plus online apt for normal users?
4. Do we want base rootfs updates to reimport destructively, or keep a migration
   path that preserves WSL-local engine home data? Before deciding, enumerate
   what WSL-local state actually matters on reimport: conversation history is
   host-side (`bindings.sqlite`), so the real risk is narrower - engine
   auth/tokens, model cache, and anything written under `/home/veslo`.
5. Where should enterprise installers pre-seed runtime parts: ProgramData only,
   or ProgramData plus per-user LocalAppData?
6. Should app auto-download rootfs/OpenCode assets when online, or require
   manual user consent because the runtime is large?

## Recommendation

Implement x64 first with hybrid provisioning.

Keep normal MSI small enough for frequent app updates. Let the app download the
official Ubuntu rootfs and use apt during explicit first-run repair for normal
users. Publish the matching Linux OpenCode asset through the Veslo GitHub
release and install it from cache or that release asset.

Add the optional 190 MiB chunked offline rootfs bundle only for enterprise or
blocked-network installs. The app should reuse an already healthy VesloSandbox,
repair OpenCode from a local/Veslo Linux asset when possible, and only require
rootfs reimport for base runtime changes.

This gives Veslo a corporate-friendly path:

- normal users can bootstrap from the internet with clear progress
- IT can download/mirror GitHub assets once
- Assets can be mirrored internally.
- Installation can run without public internet.
- First-run errors are prerequisite/status errors, not mysterious OpenCode
  spawn failures.
