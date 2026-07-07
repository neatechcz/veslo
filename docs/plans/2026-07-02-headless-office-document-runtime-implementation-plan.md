---
title: Headless Office Document Runtime Package Implementation Plan
date: 2026-07-02
target: desktop installers, Veslo updater, managed runtime packages, platform core document skills
status: draft
done: false
base_branch: local/sandbox-merge
---

# Headless Office Document Runtime Package Implementation Plan

## Goal

Make Veslo's platform core document skills (`veslo-docx`, `veslo-xlsx`,
`veslo-pdf`, `veslo-pptx`) work on a clean end-user machine without requiring
the user to install Microsoft Office, LibreOffice, Python, Node, Homebrew,
Chocolatey, Poppler, Pandoc, or any other external tool manually.

All runtime preparation must be:

- headless and non-interactive
- integrated with Windows and macOS installers without hidden prerequisites
- distributed as Veslo-managed runtime packages that can be updated by the
  Veslo updater
- idempotent when rerun on already-prepared machines
- deterministic even when the user already has some or all tools installed
- isolated from the user's global `PATH`, Python, Node, npm, pip, Homebrew, and
  LibreOffice profile
- diagnosable and repairable through Veslo-owned checks

## Non-Goals

- Do not install Microsoft Office.
- Do not mutate the user's global Python, Node, npm, pip, Homebrew, Chocolatey,
  or system LibreOffice installation.
- Do not make document skills rely on whichever tools happen to be first on the
  user's `PATH`.
- Do not use interactive installers during app install, first run, auto-update,
  or skill execution.
- Do not leave document skill execution to best-effort `npm install -g` or
  `pip install` inside a chat run.
- Do not enable, import, or repair WSL from the default Windows installer path.
  The WSL sandbox provisioning code remains available only as an explicit
  future/opt-in path, not as the v1 document runtime delivery mechanism.

## Architecture

Introduce a Veslo-managed **Document Runtime Package** shipped by the installer
for offline first-run support and updated later by the Veslo updater. The
package owns the binaries, libraries, fonts, Python packages, Node packages, and
office renderer needed by the document skills.

## KISS Evaluation and Decision

The simplest reliable installer is not a package-manager installer. The v1
installer must only stage a complete Veslo-owned runtime package and run a
bounded `doctor` check. It must not run `apt`, `brew`, `choco`, `winget`,
`pip install`, `npm install`, WSL import, or WSL repair as part of the default
document-runtime path.

This keeps the installer contract small:

1. Copy or extract a signed runtime package into a versioned Veslo-owned path.
2. Verify the package manifest and signature/hash.
3. Run `veslo-document-runtime doctor --json` with a timeout.
4. Atomically mark that runtime version active only if doctor passes.
5. Otherwise keep the app installed and report an explicit unavailable reason.

Runtime build can be complex, but runtime install should be boring. CI/build
workers may use package managers to assemble the package; customer machines
must receive a sealed Veslo package.

Default execution must ignore host tools. Existing user installations of
LibreOffice, Python, Node, Homebrew, Chocolatey, Pandoc, or Poppler may be
reported as diagnostic context, but they are never used to make document skills
appear ready.

If a supported desktop platform does not yet have a sealed local runtime
package, the normal customer release is blocked. The KISS answer is an explicit
`remote-docs-only` artifact or owned-worker execution, not a best-effort global
install.

Production desktop installers must promise local document support on every
supported desktop platform. That means Windows and macOS release artifacts must
include, or be paired with, the sealed local document runtime package. A
runtime-less desktop build is allowed only as an explicitly named internal/dev
or enterprise-remote-only artifact, never as the normal customer installer.

Copying binaries is acceptable only at the runtime-tree level: copy/extract the
entire signed package with its manifest, binaries, dynamic libraries, resources,
fonts, Python environment, Node modules, and wrapper. Do not copy individual
tools opportunistically from host installs.

If a dependency cannot be made relocatable, the answer is not a global install.
Either:

- vendor that dependency through an official portable distribution,
- wrap it in a Veslo-owned runtime package installer that writes only to
  Veslo-owned resource/data directories, or
- remove or defer the feature that needs it from local v1 and run it only in the
  owned/remote worker runtime.

Runtime layouts:

- Windows v1: keep installer WSL provisioning disabled. Ship a signed native
  portable document runtime package or a signed runtime package installer that
  writes only into a Veslo-owned path. A normal Windows customer installer must
  include or pair with this package.
- Windows future/opt-in: a managed `VesloSandbox` WSL2 document runtime can be
  designed later, but it is not part of the default installer contract while
  WSL provisioning remains disabled in installations.
- macOS: bundle a signed and notarized portable runtime under
  `Veslo.app/Contents/Resources/document-runtime`.
- Owned/hosted workers: install the same dependency set into the worker runtime
  image so local and remote behavior match.

The app and server expose a single stable tool entrypoint:

```text
veslo-document-runtime doctor --json
veslo-document-runtime exec -- soffice --headless ...
veslo-document-runtime exec -- python ...
veslo-document-runtime exec -- node ...
```

Document skills should call the Veslo runtime entrypoint or run with a `PATH`
constructed by Veslo so they resolve managed tools first. Host tools may be
reported by diagnostics, but they are not authoritative for correctness.

## Scope Decision 2026-07-07 (inline bundle, reuse existing signing)

Per explicit product direction, v1 of DRT03/DRT04 does not build a separately
signed `.veslopkg` for the customer installer path. Instead:

- The real document-runtime tree (LibreOffice headless components, Poppler,
  Pandoc, QPDF, managed Python venv, managed Node modules, fonts) is assembled
  by a CI-only script and wired into `packages/desktop/src-tauri/tauri.conf.json`
  `bundle.resources`, so it is signed by the SAME existing pipeline that already
  signs `veslo.exe`/the MSI (Authenticode via Azure Artifact Signing on
  Windows) and the same pipeline that already codesigns/notarizes the macOS
  `.app` bundle. No new signing secrets, certificates, or CI environments are
  introduced.
- `scripts/release/verify-document-runtime-*.mjs` are updated to check for the
  bundled resource tree on disk (post-`tauri build`) instead of requiring a
  standalone `.veslopkg` + `.sig` pair.
- The separate updater package feed (`document-runtime-packages.json`,
  independent runtime package download/verify/activate/rollback flow described
  below) remains the target end-state for later, but is explicitly deferred.
  Runtime updates ship with the normal app update for now.
- This changes DRT03/DRT04 acceptance to: "the runtime ships inside the normal
  signed installer/app bundle and passes `doctor --json` after a normal
  install," not "a separately signed/distributed package exists."

## Package and Updater Contract

Note: the standalone package/updater contract below remains the documented
target end-state. The 2026-07-07 scope decision above ships DRT03/DRT04 via
inline bundle resources signed by the existing installer pipeline first; the
independent package-feed/updater flow is deferred, not abandoned.

The document runtime is a first-class Veslo package, not loose installer files.
The initial customer installer carries a bootstrap package so clean machines work
offline. The Veslo updater can later download, verify, install, activate, and
roll back newer document runtime packages independently of a full app reinstall.

Package identity:

- `packageId`: `veslo-document-runtime`
- `packageVersion`: CalVer aligned with Veslo releases, for example `2026.7.0`
- `platform`: `windows-native-x64`, `macos-arm64`, `macos-x64`, or
  `linux-x64`
- `channel`: `stable`, `prerelease`, or internal/dev
- `minimumAppVersion`: oldest Veslo app version allowed to run the package
- `contentSha256`: hash of the complete compressed package
- `manifestSha256`: hash of the internal runtime manifest
- `signature`: updater/package signature verified before extraction

Canonical artifact names should be stable and platform-specific, for example:

```text
veslo-document-runtime-windows-native-x64-2026.7.0.veslopkg
veslo-document-runtime-macos-arm64-2026.7.0.veslopkg
veslo-document-runtime-macos-x64-2026.7.0.veslopkg
```

The physical container can be a signed archive if that fits the existing release
pipeline better; the logical unit must still be a Veslo package with the fields
above.

Updater integration:

- Reuse the existing Veslo updater surface and release channel backed by
  `neatechcz/veslo-updates`.
- Keep Tauri's app updater feed valid for app updates. Add document runtime
  package metadata beside the existing release assets, for example a
  `document-runtime-packages.json` feed generated by release automation.
- Extend the app updater state to check both app updates and document runtime
  package updates, but keep install actions separate so a runtime package can be
  updated without replacing the app.
- Package install/update flow:
  - download to a Veslo-owned cache
  - verify signature/hash before extraction
  - extract into a staging version directory
  - run `veslo-document-runtime doctor --json` against staging
  - atomically switch the active runtime pointer only after doctor passes
  - keep the previous active package for rollback
  - report package update status in diagnostics
- Offline first install still works because normal customer installers include
  the bootstrap package. Online package update is an improvement path, not a
  prerequisite for first use.

## Runtime Contents

### System Binaries

- LibreOffice headless components:
  - Writer for DOCX rendering/conversion
  - Calc for XLSX recalculation
  - Impress for PPTX rendering/conversion
- Poppler utilities:
  - `pdftoppm`
  - `pdftotext`
  - `pdfimages`
- Pandoc
- QPDF for supported PDF split/merge/rotate/decrypt workflows
- Fontconfig and a stable font set:
  - Liberation
  - DejaVu
  - Noto core fonts
- Optional OCR:
  - `tesseract`
  - English language data initially; additional language packs later if needed

### Python Runtime

Use a Veslo-owned virtual environment, not system Python:

- `defusedxml`
- `lxml`
- `openpyxl`
- `pandas`
- `python-pptx`
- `Pillow`
- `six`
- `markitdown[pptx]`
- `pypdf`
- `pdfplumber`
- `reportlab`
- `pdf2image`
- `pypdfium2`
- `weasyprint`

### Node Runtime

Use bundled Node/Bun plus local runtime `node_modules`, not global npm:

- `docx`
- `pptxgenjs`
- `react`
- `react-dom`
- `react-icons`
- `pdf-lib`
- `pdfjs-dist`
- Playwright support only if browser binaries are also bundled and pinned. If
  this makes the runtime too large, revise the PPTX creation workflow to avoid
  browser-download-time Playwright dependencies.

## Runtime Contract

Add `packages/document-runtime` or an equivalent package that owns:

- package manifest schema
- runtime manifest schema
- expected tool versions
- `doctor` checks
- wrapper command generation
- platform path resolution
- upgrade/repair semantics
- JSON diagnostics consumed by desktop/server UI

Example manifest:

```json
{
  "schemaVersion": 1,
  "packageId": "veslo-document-runtime",
  "runtimeId": "veslo-document-runtime",
  "packageVersion": "2026.7.0",
  "version": "2026.7.0",
  "platform": "windows-native-x64",
  "channel": "stable",
  "minimumAppVersion": "2026.7.0",
  "tools": {
    "soffice": "24.x",
    "pandoc": "3.x",
    "poppler": "24.x",
    "qpdf": "11.x",
    "python": "3.11.x",
    "node": "22.x"
  },
  "contentSha256": "...",
  "manifestSha256": "...",
  "pythonPackagesHash": "...",
  "nodePackagesHash": "...",
  "fontsHash": "..."
}
```

Doctor output must be machine-readable and stable:

```json
{
  "ok": true,
  "packageId": "veslo-document-runtime",
  "packageVersion": "2026.7.0",
  "runtimeVersion": "2026.7.0",
  "platform": "windows-native-x64",
  "checks": [
    { "id": "soffice", "ok": true, "path": "...", "version": "..." },
    { "id": "pandoc", "ok": true, "path": "...", "version": "..." },
    { "id": "python-import-openpyxl", "ok": true },
    { "id": "node-module-docx", "ok": true }
  ]
}
```

## Agent Execution Protocol

This is the realization plan. The top-level frontmatter stays `done: false`
until every task in the ledger is complete and release verification passes.

Rules for agents taking work from this plan:

- Reserve exactly one task at a time by setting its `status` to `in_progress`
  and filling `reserved_by`.
- Leave `done: false` while implementation, review, or verification is still
  incomplete.
- Set a task to `done: true` only after the implementation and its listed
  verification commands pass, or after an equivalent verification note is added
  under that task.
- Do not flip another agent's task to `done: true`.
- Keep the top-level `done: false` until DRT10 proves all normal customer
  release gates, package updater gates, and rollback gates.

## Task Reservation Ledger

| id | task | status | reserved_by | done |
| --- | --- | --- | --- | --- |
| DRT01 | dependency inventory and lockfiles | completed | codex-20260702-document-runtime-package-contract | true |
| DRT02 | runtime CLI and doctor contract | completed | codex-20260702-document-runtime-cli | true |
| DRT03 | Windows native sealed runtime package | in_progress | claude-20260707-windows-inline-bundle | false |
| DRT04 | macOS bundled document runtime package | in_progress | codex-20260702-macos-document-runtime-package-gate | false |
| DRT05 | runtime package and Veslo updater integration | in_progress | codex-20260702-runtime-package-release-assets | false |
| DRT06 | core skill command rewiring | completed | codex-20260702-core-skill-runtime-rewire | true |
| DRT07 | app/server diagnostics and repair UX | in_progress | codex-20260702-document-runtime-diagnostics-contract | false |
| DRT08 | owned-worker runtime parity | pending |  | false |
| DRT09 | end-to-end document fixtures | pending |  | false |
| DRT10 | release gates and rollback policy | in_progress | codex-20260703-document-runtime-release-gates | false |

## Tasks

### DRT01: Dependency Inventory and Lockfiles

Cause:

- Current core skill packages list required tools in `SKILL.md`, but no product
  artifact guarantees those tools exist on client machines.
- Runtime behavior would vary with user-installed Homebrew, Python, npm,
  LibreOffice, and PATH state.

Implementation:

- Create a single dependency inventory for DOCX, XLSX, PDF, and PPTX.
- Define the sealed package formats before implementation:
  - Windows: signed native runtime package or signed runtime package installer
    that writes only into a Veslo-owned data/resource path. This is mandatory
    for normal customer installers.
  - macOS: signed/notarized bootstrap runtime package inside the app bundle or
    a signed runtime package expanded into a Veslo-owned app-support path.
  - Linux workers: Docker image layer built from the same manifest.
- Define `document-runtime-packages.json` feed schema for Veslo updater package
  discovery, including package URLs, hashes, signatures, channels, and minimum
  app version constraints.
- Explicitly reject artifact designs that require global PATH mutation,
  machine-wide Python/Node/npm/pip changes, Homebrew, Chocolatey, Winget, or
  user profile shell configuration.
- Pin exact versions or acceptable version ranges for:
  - LibreOffice
  - Poppler
  - Pandoc
  - Python runtime and wheels
  - Node runtime and packages
  - fonts
- Add a lockfile or generated manifest for each target:
  - `windows-native-x64`
  - `macos-arm64`
  - `macos-x64` if Intel macOS remains supported
  - `linux-x64` for owned workers
- Keep `windows-wsl2-x64` out of the v1 release gate while WSL provisioning is
  disabled in default Windows installers.
- Add a product release profile flag:
  - `local-docs-required`: normal customer desktop release; Windows/macOS
    runtime packages are mandatory.
  - `remote-docs-only`: explicit non-default artifact; local document skills
    stay unavailable and tasks must route to allowed remote/owned worker.
- Record license metadata for every bundled binary and library.
- Decide whether OCR is part of v1 or gated behind a later optional pack.

Verification:

```bash
pnpm exec node scripts/document-runtime/validate-manifest.mjs
pnpm exec node scripts/document-runtime/validate-package-feed.mjs
pnpm exec node scripts/document-runtime/check-licenses.mjs
```

Status 2026-07-02:

- Implemented `veslo-document-runtime` workspace package with manifest/feed
  validators.
- Added dependency inventory, per-target starter manifests, package feed
  example, and license inventory.
- Verified with:
  - `pnpm --filter veslo-document-runtime test`
  - `node scripts/document-runtime/validate-manifest.mjs`
  - `node scripts/document-runtime/validate-package-feed.mjs`
  - `node scripts/document-runtime/check-licenses.mjs`

### DRT02: Runtime CLI and Doctor Contract

Cause:

- Skills need one stable entrypoint that resolves Veslo-managed tools
  consistently across Windows, macOS, local runtime, and hosted workers.

Implementation:

- Add `veslo-document-runtime` wrapper:
  - `doctor --json`
  - `exec -- <command> ...`
  - `path --json`
  - `repair --headless`
- Ensure `exec` sets:
  - managed `PATH`
  - managed `PYTHONPATH` / venv
  - managed `NODE_PATH`
  - LibreOffice user profile under Veslo runtime data dir
  - temp directory under Veslo-controlled runtime temp
  - fontconfig paths where applicable
- Ensure `doctor` checks actual managed execution, not only file existence:
  - execute managed `soffice`, `pandoc`, `pdftoppm`, `pdftotext`,
    `pdfimages`, `qpdf`, and `weasyprint` probes
  - import every required Python package through managed Python
  - require every required Node package through managed Node
  - verify managed font directory discovery
- Keep full DOCX/PPTX/PDF/XLSX fixture conversions in DRT09 so the CLI contract
  remains small and does not duplicate the end-to-end document workflow suite.
- Add strict JSON schema tests for diagnostics.

Verification:

```bash
pnpm --filter veslo-document-runtime test
pnpm --filter veslo-document-runtime typecheck
```

Status 2026-07-02:

- Implemented `veslo-document-runtime` CLI entrypoints:
  - `doctor --json`
  - `path --json`
  - `repair --headless`
  - `exec -- <command> ...`
- Added active runtime pointer resolution through Veslo-owned runtime roots and
  `VESLO_DOCUMENT_RUNTIME_ROOT` / `VESLO_DOCUMENT_RUNTIME_ACTIVE_DIR`
  overrides for installer/updater staging and tests.
- Added managed execution environment construction with isolated `PATH`,
  `PYTHONPATH`, `NODE_PATH`, temp dir, fontconfig path, and LibreOffice profile
  path.
- Doctor now executes managed probes for `soffice`, `pandoc`, `pdftoppm`,
  `pdftotext`, `pdfimages`, `qpdf`, `weasyprint`, managed Python imports,
  managed Node package resolution, and managed font discovery. It does not fall
  back to host `PATH`.
- Added a regression test that removes a documented managed PDF command
  (`qpdf`) and verifies `doctor` reports `failed` instead of returning a false
  `ready`.
- Added a package-archive security regression test proving unsafe archive paths
  are rejected without activating a runtime.
- Full document conversion fixture coverage remains assigned to DRT09.
- Verified with:
  - `pnpm --filter veslo-document-runtime test`
  - `pnpm --filter veslo-document-runtime typecheck`

### DRT03: Windows Native Sealed Runtime Package

Cause:

- Windows installer builds currently keep WSL provisioning disabled. Document
  runtime work must not accidentally re-enable `VesloSandbox` import, WSL
  prerequisite repair, or WSL-based document setup in the default installer.
- Windows customer installers must still provide local document support on a
  clean machine without preinstalled tools, so the default path needs a native
  sealed package.

Implementation:

- Keep `VESLO_ENABLE_WSL_INSTALLER=0` behavior intact for default Windows
  installers.
- Produce a Windows native runtime package with:
  - a manifest and content hash
  - Authenticode signature or signed enclosing installer/archive
  - portable LibreOffice/renderer tree, not a machine-wide LibreOffice install
  - portable Python env, not system Python
  - local Node modules, not global npm
  - fonts and Poppler/Pandoc binaries resolved only through the wrapper
- Stage the package under a versioned Veslo-owned path, for example:
  `%LOCALAPPDATA%\Veslo\document-runtime\2026.7.0\`.
- Add Windows document runtime resolver support for:
  - bundled native runtime copied from installer resources
  - signed offline runtime package installer copied/extracted into a Veslo-owned
    data path
  - `remote_only` only for explicit non-default artifacts or after local runtime
    doctor failure when a remote worker is allowed
- Add an explicit product-policy state such as `disabled_by_product_policy` so
  support can distinguish policy blocks from corruption or missing host tools.
- Ensure `veslo-document-runtime doctor --json` on Windows never falls through
  to host `PATH` tools when the managed native runtime is absent.
- Preserve the existing WSL sandbox provisioning code as a dormant explicit
  future/opt-in path. Do not extend it as part of the default Windows document
  runtime implementation unless the product decision changes.
- Add tests that fail if Windows installer hooks, app startup, or repair UI
  start invoking WSL provisioning for document runtime while the no-WSL policy
  is active.
- Add tests that fail normal customer Windows builds when the native document
  runtime package is missing.

Verification:

```powershell
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/**/windows-sandbox-repair*.test.ts
pnpm --filter @neatech/veslo exec cargo test --manifest-path src-tauri/Cargo.toml wsl_sandbox
pnpm exec node scripts/release/verify-document-runtime-windows.mjs
veslo-document-runtime doctor --json
```

Status 2026-07-02:

- Implemented `scripts/release/verify-document-runtime-windows.mjs`.
- Added tests proving:
  - a `local-docs-required` Windows release passes only when the native
    `.veslopkg` and `.veslopkg.sig` exist,
  - a missing native package fails the Windows release gate,
  - an explicit `remote-docs-only` profile may omit the local package,
  - current Windows WiX/NSIS WSL hooks remain dormant and are not treated as
    document runtime readiness.
- Verified with:
  - `node --test scripts/release/verify-document-runtime-windows.test.mjs`
  - `node scripts/release/verify-document-runtime-windows.mjs --profile remote-docs-only --json`
  - `node scripts/release/verify-document-runtime-windows.mjs --profile local-docs-required --json`
    expected failure because the real Windows native runtime package artifact
    and signature are not yet present.
- DRT03 remains `done: false` until the actual Windows native runtime package
  with portable LibreOffice/Python/Node/Poppler/Pandoc/fonts is produced,
  signed, and placed where the release gate expects it.

Status 2026-07-07 (in progress, claude-20260707-windows-inline-bundle):

- Adopting the "Scope Decision 2026-07-07" inline-bundle approach above:
  assembling real Windows binaries via a CI-only script into
  `packages/desktop/src-tauri` resources, signed by the existing Windows
  Authenticode pipeline already in `build-windows-msi.yml` /
  `release-macos-aarch64.yml`, instead of a standalone `.veslopkg`.
- Work happening in worktree branch `docrt/windows-native-bundle`.

- Codex follow-up wires the Windows inline resource path into Tauri resources,
  adds the Windows assembler with preverified source facts and a generated
  trust-on-first-use SHA-256 lock, and updates the Windows release gate to
  require the bundled resource tree instead of a standalone `.veslopkg`/`.sig`.
- Liberation fonts are deferred for this Windows v1 because upstream releases do
  not provide a reliable prebuilt binary asset; DejaVu and Noto Sans
  latin/greek/cyrillic ship first, with Liberation kept as a target dependency.
- Expected download footprint before Python/Node package installs and before any
  LibreOffice trimming is roughly 635 MB. The assembler keeps the full
  LibreOffice administrative-install output until a network-capable end-to-end
  doctor run proves a smaller trimmed tree is safe.
- DRT03 remains `done: false` until the real network-capable assembly, generated
  source lock, `veslo-document-runtime doctor --json`, and signed MSI build pass.

### DRT04: macOS Bundled Document Runtime Package

Cause:

- macOS users may not have Homebrew, Python, Node, LibreOffice, Poppler, or
  Pandoc installed. The app bundle must be self-contained.

Implementation:

- Build a portable runtime tree under:
  - `packages/desktop/src-tauri/resources/document-runtime/macos-arm64`
  - `packages/desktop/src-tauri/resources/document-runtime/macos-x64`
- Bundle or vendor:
  - LibreOffice CLI/headless components
  - Poppler binaries and dylibs
  - Pandoc
  - Python runtime and venv
  - Node runtime and local `node_modules`
  - fonts
- Add macOS path resolver in `veslo-document-runtime`.
- Ensure all nested Mach-O binaries and dylibs are signed.
- Ensure the full app including nested runtime is notarized.
- Keep runtime execution headless and avoid first-run prompts.

Verification:

```bash
codesign --verify --deep --strict "target/release/bundle/macos/Veslo by Neatech.app"
spctl --assess --type execute "target/release/bundle/macos/Veslo by Neatech.app"
"target/release/bundle/macos/Veslo by Neatech.app/Contents/MacOS/veslo-document-runtime" doctor --json
```

Status 2026-07-02:

- Implemented `scripts/release/verify-document-runtime-macos.mjs`.
- Added tests proving:
  - a `local-docs-required` macOS release passes only when both
    `macos-arm64` and `macos-x64` `.veslopkg` artifacts and signatures exist,
  - missing macOS runtime packages fail the release gate,
  - an explicit `remote-docs-only` profile may omit local macOS package
    artifacts.
- Verified with:
  - `node --test scripts/release/verify-document-runtime-macos.test.mjs`
  - `node scripts/release/verify-document-runtime-macos.mjs --profile remote-docs-only --json`
  - `node scripts/release/verify-document-runtime-macos.mjs --profile local-docs-required --json`
    expected failure because the real macOS runtime package artifacts and
    signatures are not yet present.
- DRT04 remains `done: false` until signed/notarized macOS runtime packages are
  produced and pass the actual app bundle `codesign`, `spctl`, and
  `veslo-document-runtime doctor --json` checks.

### DRT05: Runtime Package and Veslo Updater Integration

Cause:

- A prepared runtime must be installed and repaired during fresh install,
  update, and first run without blocking on interactive prompts.
- Windows has a product constraint for v1: default installers must not use WSL
  provisioning as the document runtime repair path.
- Normal customer desktop installers must contain local document runtime support,
  not merely a future download path.
- The runtime must be independently updateable through Veslo's updater flow as
  a package, without requiring a full app reinstall.

Implementation:

- Add bootstrap runtime package resources to Tauri bundle config for macOS and
  Windows customer artifacts.
- Fail normal customer build packaging if the required runtime package for that
  platform is missing. Only explicitly named `remote-docs-only` or dev artifacts
  may omit it.
- Treat runtime install as copy/extract plus doctor only. Any package-manager
  work belongs to CI artifact assembly, not the customer installer.
- Keep Windows WiX/NSIS WSL hooks disabled by default. Windows installer hooks
  may stage a native runtime package or register runtime-pack metadata, but must
  not run `wsl2-client-installer.ps1`, import `VesloSandbox`, or call WSL repair
  because document skills are present.
- Extend release automation to publish document runtime packages beside desktop
  updater artifacts in the public updater release.
- Generate and upload a package feed such as `document-runtime-packages.json`
  beside `latest.json`. Do not break the Tauri updater schema for app updates.
- Extend the Veslo updater app state to check, download, verify, and install
  document runtime packages separately from app updates.
- Use the same updater UI/diagnostics surface for package update status:
  available, downloading, verifying, installing, ready, failed, rolled back.
- Add macOS first-launch/update check because DMG drag-install does not have
  the same postinstall script guarantees as MSI.
- Store runtime state under a versioned Veslo-owned directory.
- Make upgrades atomic:
  - stage new package
  - run doctor
  - switch active runtime pointer
  - keep previous runtime for rollback
- Do not let a normal Windows customer artifact omit the native runtime package.
  For explicit non-default artifacts that omit it, mark document runtime
  `remote_only` with a concrete reason and avoid host-tool fallback.
- Do not fail app installation if runtime repair requires reboot, signing
  verification fails, or an enterprise policy blocks optional runtime package
  installation. Keep the app usable and let diagnostics offer supported repair
  or remote fallback.

Verification:

```bash
pnpm --filter @neatech/veslo run prepare:sidecar
pnpm --filter @neatech/veslo tauri build
pnpm exec node scripts/release/verify-bundled-versions.mjs
pnpm exec node scripts/release/verify-document-runtime-policy.mjs
pnpm exec node scripts/release/verify-document-runtime-packages.mjs
```

Status 2026-07-02:

- Extended public release asset filtering so `mirror-public-release.mjs` can
  mirror:
  - `veslo-document-runtime-*.veslopkg`
  - `veslo-document-runtime-*.veslopkg.sig`
  - `document-runtime-packages.json`
- Added `scripts/release/generate-document-runtime-package-feed.mjs` to build a
  validated package feed from local runtime package artifacts, signatures, and
  target manifests.
- Added the headless `.veslopkg` archive contract:
  - `veslo-document-runtime pack --headless --source <expanded-runtime-dir> --output <file.veslopkg>`
  - `veslo-document-runtime install --headless --package <file.veslopkg> --sha256 <digest> --activate`
  - package archives are gzip NDJSON written/read with Node APIs only, so
    installer/updater execution does not depend on system `tar`, `zip`, Homebrew,
    Chocolatey, WSL, or global PATH
  - install verifies the artifact sha256 before extraction, preserves explicit
    directory entries such as empty `fonts/`, extracts to a temporary Veslo-owned
    directory, then calls the same doctor-before-activation staging path
- Added the headless expanded-package staging contract:
  - `veslo-document-runtime stage --headless --source <expanded-runtime-dir> --activate`
  - copies the verified source into the managed runtime root under
    `packages/<version>`
  - runs `doctor` against the staged copy before activation
  - rewrites `active.json` only after doctor passes
  - performs no host package-manager installs and does not mutate global PATH
- Added `repair --headless` support for recovering from a missing/corrupt active
  pointer by activating an already staged ready package.
- Added shared package-feed selection helpers for the updater path:
  - validate `document-runtime-packages.json`
  - select by platform and channel
  - respect `minimumAppVersion`
  - skip packages that are not newer than the installed document runtime version
- Added aggregate release gate scripts:
  - `scripts/release/verify-document-runtime-policy.mjs`
  - `scripts/release/verify-document-runtime-packages.mjs`
  - `scripts/release/verify-document-runtime.mjs`
- The aggregate package gate passes for explicit `remote-docs-only` artifacts and
  intentionally fails the current workspace for default `local-docs-required`
  because the real Windows/macOS `.veslopkg` artifacts and signatures are not
  present.
- Verified with:
  - `node --test scripts/release/public-release-assets.test.mjs`
  - `node --test scripts/release/generate-document-runtime-package-feed.test.mjs`
  - `node --test scripts/release/verify-document-runtime-packages.test.mjs`
  - `pnpm --filter veslo-document-runtime test`
  - `pnpm --filter veslo-document-runtime typecheck`
- DRT05 remains `done: false` until real package build/upload steps exist and
  the desktop updater app state can check, download, verify, install, activate,
  and roll back document runtime packages.

### DRT06: Core Skill Command Rewiring

Cause:

- Current skill instructions mention direct commands like `soffice`,
  `pdftoppm`, `pandoc`, `python`, `npm install -g docx`, and `pip install`.
  That leaks host environment assumptions into execution.

Implementation:

- Update DOCX/PDF/PPTX/XLSX core skill packages to call managed runtime tools.
- Replace global install instructions with:
  - use `veslo-document-runtime exec -- python ...`
  - use `veslo-document-runtime exec -- node ...`
  - use `veslo-document-runtime exec -- soffice ...`
  - use bundled packages; do not install dependencies during task execution
- Keep raw OOXML workflows, but run helper scripts through the managed Python.
- Ensure skill tests reject:
  - `npm install -g`
  - `pip install`
  - `brew install`
  - direct host `soffice` without Veslo runtime context
- Preserve platform skill package hashing and rollout behavior.

Status:

- Completed core document skill rewiring for DOCX/PDF/PPTX/XLSX instructions.
- Added managed runtime guidance to the main skill documents.
- Replaced host command examples in PDF references, PDF form helpers, PPTX
  workflows, PPTX html2pptx usage, DOCX workflows, and XLSX recalculation docs.
- Updated user-facing helper errors/usages that suggested host package installs
  or host Python entrypoints.
- Added a package-archive guard test so document skill markdown cannot reintroduce
  global install instructions or direct host command examples.
- Added a cross-surface guard that every required
  `veslo-document-runtime exec -- <command>` documented by DOCX/PDF/PPTX/XLSX
  skills is covered by `veslo-document-runtime doctor`; `pdftk` remains an
  explicitly optional command and is excluded from readiness.

Verification:

```bash
pnpm --dir services/den exec tsx --test test/core-platform-skills.test.ts
pnpm --dir services/den exec tsx --test test/core-platform-skill-bootstrap.test.ts
```

### DRT07: App/Server Diagnostics and Repair UX

Cause:

- Users and support need to know whether document skills are unavailable
  because the runtime is missing, corrupt, policy-blocked, outdated, or repair
  is in progress.
- On Windows, support must also see whether local document runtime failed
  because the bundled native runtime package is missing/corrupt, an explicit
  `remote-docs-only` artifact is in use, or installer WSL provisioning is
  disabled by product policy.

Implementation:

- Add server endpoint:
  - `GET /document-runtime/status`
  - `POST /document-runtime/repair`
- Add app state and UI surface:
  - settings diagnostics row
  - skill inventory readiness state for DOCX/XLSX/PDF/PPTX
  - blocking message before launching a document task when runtime is missing
- Represent Windows no-WSL policy separately from technical failures:
  - `ready`
  - `missing`
  - `repairing`
  - `blocked`
  - `outdated`
  - `failed`
  - `disabled_by_product_policy`
  - `package_update_available`
  - `package_installing`
  - `package_rollback`
  - `remote_only` (explicit non-default artifact or allowed fallback only)
- Treat `missing` in a normal customer installer as a packaging/runtime
  integrity problem, not a supported release state.
- Emit structured telemetry/debug logs without leaking document contents.
- Add repair guard:
  - no repair while active document run is using the runtime
  - retry-safe and cancellable where platform allows

Status:

- Started DRT07 with the server/app diagnostic contract.
- Added server route module for:
  - `GET /document-runtime/status`
  - `POST /document-runtime/repair`
- The server payload distinguishes `missing`, `remote_only`, package update
  states, repair state, skill readiness, and Windows
  `disabled_by_product_policy` WSL runtime policy.
- Added dependency injection points so the route can later be backed by the
  real updater/runtime installer without changing the HTTP shape.
- Wired the default server route through a document-runtime provider adapter
  that maps `veslo-document-runtime doctor()` and `repairHeadless()` results into
  the app diagnostics payload. If the provider cannot be loaded, the endpoint
  returns structured `blocked` diagnostics instead of failing the route.
- Added frontend document runtime model for settings-row state, per-format skill
  readiness, and document-task blocking messages.
- Added a Settings `Local runtime` diagnostics row backed by the shared model,
  with optional repair/update actions and active-run blocking for repair.
- Added Veslo server client methods for `getDocumentRuntimeStatus()` and
  `repairDocumentRuntime()` so dashboard state can poll the server route without
  adding another transport.
- Added app state polling for `/document-runtime/status` while the app window is
  visible, and wired the live status through Dashboard props into Settings.
- Added a Settings repair callback that calls `/document-runtime/repair`, updates
  the diagnostics state from the response, and refuses repair while any run is
  active.
- Added send preflight blocking for resolved `veslo-docx`, `veslo-xlsx`,
  `veslo-pdf`, and `veslo-pptx` skill commands when the document runtime status
  is not ready for that format.
- Extended `veslo-document-runtime repair --headless` so it can atomically
  activate a ready staged package under the runtime root (`packages/<version>` or
  `staged/<version>`) by rewriting `active.json`; no host package manager or
  global PATH mutation is involved.
- Added `veslo-document-runtime install --headless` so a verified `.veslopkg`
  can be extracted, doctor-checked, staged, and activated by the same local
  runtime package code path that Settings/server repair depends on.
- `doctor()` now reports whether a staged package is available for repair, so
  Settings can show the repair action only when the server can actually try it.
- DRT07 remains `done: false` until the desktop updater/app state is wired to
  call package download/install with progress, retry, and rollback semantics.

Verification:

```bash
pnpm --filter veslo-server exec bun test src/tests/server.document-runtime-routes.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/document-runtime.test.ts src/app/tests/pages/settings-document-runtime.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/veslo-server-document-runtime.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/app-view-props.test.ts src/app/tests/lib/document-runtime.test.ts src/app/tests/pages/settings-document-runtime.test.ts src/app/tests/lib/veslo-server-document-runtime.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/app-view-props.test.ts src/app/tests/lib/document-runtime.test.ts src/app/tests/pages/settings-document-runtime.test.ts src/app/tests/lib/veslo-server-document-runtime.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter veslo-document-runtime test
pnpm --filter veslo-document-runtime typecheck
pnpm --filter veslo-server test document-runtime
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/**/document-runtime*.test.ts
```

### DRT08: Owned-Worker Runtime Parity

Cause:

- Local and remote/owned worker execution should not produce different document
  outputs due to missing fonts, different LibreOffice versions, or different
  Python/Node packages.

Implementation:

- Extend `packaging/owned-server/Dockerfile` worker-runtime stage with the same
  dependency manifest.
- Add `veslo-document-runtime doctor --json` to worker health diagnostics.
- Keep worker image build deterministic through the same lockfile used by local
  bundles.

Verification:

```bash
docker build -f packaging/owned-server/Dockerfile --target worker-runtime .
docker run --rm <image> veslo-document-runtime doctor --json
pnpm exec node packaging/owned-server/worker-runtime-dockerfile.test.mjs
```

### DRT09: End-to-End Document Fixtures

Cause:

- A runtime can pass binary existence checks while still failing real document
  workflows.

Implementation:

- Add small fixture tests for each platform skill:
  - DOCX: create document, edit existing XML, add comment/tracked change,
    convert to PDF, render page image.
  - XLSX: create workbook with formulas, recalculate through LibreOffice,
    assert zero formula errors.
  - PPTX: create or edit small deck, convert to PDF, create thumbnails.
  - PDF: create PDF from markdown, extract text, fill a simple form or annotate
    a small fixture.
- Run fixtures through managed runtime only.
- Add tests for polluted host state:
  - no system `python` in PATH
  - fake broken `soffice` earlier in PATH
  - existing user LibreOffice profile
  - existing Homebrew install on macOS
- Add Windows no-local-runtime tests:
  - normal customer artifact fails release verification when native runtime is
    missing
  - explicit `remote-docs-only` artifact reports `remote_only`
  - document task preflight does not launch WSL repair
  - document task preflight does not execute host `python`, `node`, `soffice`,
    `pandoc`, or `pdftoppm`

Verification:

```bash
pnpm --filter @neatech/veslo-e2e test:document-runtime
veslo-document-runtime doctor --json
```

### DRT10: Release Gates and Rollback Policy

Cause:

- The runtime will be large and platform-specific. Broken runtime releases must
  not ship silently, and users need a fallback if a runtime update fails.

Implementation:

- Add release gates:
  - runtime manifest and package present for every normal customer desktop
    platform
  - `document-runtime-packages.json` present, signed/verified, and pointing at
    the correct public updater release assets
  - package hashes and signatures verified before extraction
  - doctor fixtures pass in CI on macOS and Windows customer artifacts
  - explicit `remote-docs-only` artifacts prove `remote_only` readiness without
    host-tool or WSL fallback
  - runtime license report generated
  - bundle size budget reviewed
  - codesign/notarization verified on macOS
  - Authenticode/MSI signing verified on Windows
- Add runtime rollback:
  - keep previous active package
  - rollback if doctor fails after package update
  - report rollback in diagnostics
- Add emergency disable flag:
  - platform can mark document runtime disabled while keeping app usable
  - document skills show a clear unavailable reason

Verification:

```bash
pnpm exec node scripts/release/verify-document-runtime.mjs
pnpm exec node scripts/release/verify-document-runtime-packages.mjs
git diff --check
```

Status 2026-07-03:

- Started DRT10 with aggregate release gates for document runtime package
  policy and cross-platform package presence.
- Added `scripts/release/verify-document-runtime-policy.mjs` to enforce the
  default Windows no-WSL document runtime policy without requiring local runtime
  artifacts.
- Added `scripts/release/verify-document-runtime-packages.mjs` to aggregate the
  Windows native and macOS package/signature gates.
- Added `scripts/release/verify-document-runtime.mjs` as the top-level release
  gate entrypoint referenced by this plan.
- Added aggregate tests that:
  - pass only when Windows, macOS arm64, and macOS x64 package/signature pairs
    are present for `local-docs-required`,
  - fail a normal release when any platform package is missing,
  - pass an explicit `remote-docs-only` profile without local artifacts,
  - prove the top-level gate delegates to package verification,
  - prove the Windows policy gate keeps the WSL document-runtime path dormant.
- Verified with:
  - `node --test scripts/release/verify-document-runtime-packages.test.mjs scripts/release/verify-document-runtime-windows.test.mjs scripts/release/verify-document-runtime-macos.test.mjs scripts/release/generate-document-runtime-package-feed.test.mjs scripts/release/public-release-assets.test.mjs`
  - `node scripts/release/verify-document-runtime-policy.mjs --json`
  - `node scripts/release/verify-document-runtime.mjs --profile remote-docs-only --json`
- DRT10 remains `done: false` until normal customer Windows/macOS artifacts
  exist, package signatures are real release signatures, document E2E fixtures
  pass against those artifacts, and rollback/emergency-disable behavior is
  implemented and verified.

## Platform Edge Cases

### Clean Machine

Expected:

- macOS installer/app has enough bundled package resources to prepare runtime
  headlessly.
- Windows installer does not enable/import/repair WSL. If the artifact includes
  a native runtime package or a signed offline runtime package installer is
  paired with the artifact, `doctor` passes before document skills are marked
  ready.
- A normal Windows customer artifact includes or pairs with the native runtime
  package. A missing/corrupt package is a packaging/runtime integrity problem,
  not a supported clean-machine state.
- No user prompts except OS-level install permissions that are unavoidable for
  the app installer itself.

### Partially Prepared Machine

Expected:

- Existing user tools are ignored for managed execution.
- Existing Veslo runtime package is repaired or upgraded based on manifest
  version and updater package feed.
- Broken host tools do not affect document skill execution.
- Existing `VesloSandbox` or personal WSL distros are ignored by default
  Windows installers while the no-WSL policy is active.

### Fully Prepared Machine

Expected:

- Veslo still uses managed runtime for deterministic results.
- Diagnostics may show host tools as informational only.
- Runtime install/repair is a no-op if the active package manifest and doctor
  pass.

### Windows No-WSL Installer Policy

Expected:

- Default Windows installers keep WSL provisioning disabled even when WSL is
  available on the machine.
- Document runtime status distinguishes:
  - native runtime present and ready
  - native runtime package missing/corrupt in a normal customer artifact
  - explicit `remote-docs-only` artifact
  - runtime package install blocked by policy
  - WSL disabled by product policy
- Remote/owned worker fallback can be offered if the account/workspace allows
  it.

### Enterprise-Locked Windows

Expected:

- If native runtime package install is blocked, app remains installed.
- Document runtime status becomes `blocked` with concrete reason.
- WSL policy blocks are reported separately from enterprise policy blocks.
- Remote/owned worker fallback can be offered if the account/workspace allows
  it.

### Offline Install

Expected:

- Fresh macOS install must not require network for document runtime if the
  selected installer artifact claims local document skills are included.
- Fresh Windows install must not require network or WSL for document runtime. If
  the selected Windows artifact claims local document skills are included, it
  must include the native runtime package or require a signed offline runtime
  package installer that is already available.
- A normal customer offline installer includes or pairs with the runtime package
  and passes doctor offline. Only an explicitly named `remote-docs-only`
  artifact may omit runtime packages, and it must label local execution as
  unavailable before any task starts.

## Implementation Order

1. DRT01 and DRT02: define the contract before touching installers.
2. DRT08: prove the dependency set in Docker first; fastest iteration and
   easiest CI validation.
3. DRT03: lock the Windows no-WSL installer policy and native sealed runtime
   package.
4. DRT04: macOS portable runtime package and signing.
5. DRT05: runtime package and Veslo updater integration.
6. DRT06: rewire skills away from host installs.
7. DRT07: diagnostics/repair UX.
8. DRT09 and DRT10: E2E fixtures and release gates.

## Acceptance Criteria

- On a clean Windows machine, Veslo installs headlessly without enabling,
  importing, or repairing WSL.
- On a clean Windows machine, the normal customer artifact includes or pairs
  with a native document runtime package and `veslo-document-runtime doctor
  --json` passes without requiring user-installed tools.
- An explicitly named `remote-docs-only` artifact may omit the native runtime
  package, but it must mark local DOCX/XLSX/PDF/PPTX execution unavailable
  before task launch; execution must not fall back to host `PATH`, Homebrew,
  Chocolatey, global Python, global Node, or WSL.
- A newer document runtime package can be delivered through the Veslo updater,
  verified, installed, doctor-checked, activated, and rolled back without a full
  app reinstall.
- On a clean macOS machine, Veslo app bundle contains the document runtime,
  passes codesign/notarization, and `doctor --json` passes without Homebrew.
- DOCX/XLSX/PDF/PPTX skills run through managed runtime commands only.
- A fake broken `soffice`, `python`, or `node` earlier in host `PATH` does not
  affect document skill execution.
- Existing user installs of LibreOffice/Python/Node do not change output.
- Runtime package update is atomic and rolls back on doctor failure.
- App diagnostics clearly distinguish `ready`, `missing`, `repairing`,
  `blocked`, `outdated`, `failed`, `disabled_by_product_policy`,
  `package_update_available`, `package_installing`, `package_rollback`, and
  `remote_only`.

## Risks

- Bundle size may grow substantially, especially with LibreOffice and browser
  dependencies for Playwright.
- Windows local-docs-required release is blocked until the signed native runtime
  package is small, legal, and supportable enough for the installer and Veslo
  updater. A remote-only release must be an explicitly named non-default
  artifact.
- macOS signing/notarization of nested LibreOffice/Python/Node binaries may need
  dedicated CI work.
- WSL provisioning remains disabled by product policy in default Windows
  installers; do not treat that as an enterprise block or runtime corruption.
- Native Windows runtime package installation may be blocked by enterprise
  policy; remote runtime fallback is necessary for some customers.
- Font differences can still affect PDF/image comparisons; the managed font set
  must be explicit and tested.
- LibreOffice conversion behavior can vary by version; pinning and fixture tests
  are required.
