# Fix 20: Headless Document Runtime Package Contract

## Problem

The DOCX/XLSX/PDF/PPTX platform skills needed a local runtime that works on clean Windows and
macOS machines without assuming Microsoft Office, LibreOffice, Python, Node, Homebrew, WSL, npm,
pip, or PATH configuration already exists on the client.

Earlier runtime planning had the right product boundary, but the implementation still needed a
real package/update primitive. Expanded-directory staging alone was not enough for the Veslo
updater or customer installers because it did not define the artifact that gets downloaded,
verified, installed, doctor-checked, and activated.

## Fix

- Added `packages/document-runtime`, the Veslo-owned document runtime package contract for the
  DOCX, XLSX, PDF, and PPTX core skills.
- Defined target manifests, dependency inventory, license inventory, package feed validation, and
  platform package naming for:
  - `windows-native-x64`
  - `macos-arm64`
  - `macos-x64`
  - `linux-x64`
- Added `veslo-document-runtime doctor --json`, `path --json`, `exec --`, `repair --headless`,
  and `stage --headless`.
- Added the `.veslopkg` archive path:
  - `pack --headless --source <expanded-runtime-dir> --output <file.veslopkg>`
  - `install --headless --package <file.veslopkg> --sha256 <digest> --activate`
- The package archive is gzip NDJSON read and written through Node APIs, so install does not need
  system `tar`, `zip`, Homebrew, Chocolatey, WSL, or global PATH.
- `install --headless` verifies the artifact sha256 before extraction, preserves explicit
  directory entries such as empty `fonts/`, extracts only under a Veslo-owned temporary directory,
  runs `doctor` against the staged copy, and rewrites `active.json` only after doctor passes.
- Rewired DOCX/PDF/PPTX/XLSX core skill instructions and helpers to run through
  `veslo-document-runtime exec -- ...` instead of host `soffice`, `python`, `node`, `pip`,
  `npm install -g`, or `brew install` flows.
- Added server/app diagnostics:
  - `GET /document-runtime/status`
  - `POST /document-runtime/repair`
  - Settings local-runtime diagnostics row
  - send preflight blocking for document skills when the runtime is not ready
  - explicit distinction between `remote_only`, `missing`, `failed`, update states, and Windows
    no-WSL product policy.
- Added release-side validation for document runtime package artifacts, package signatures, and
  `document-runtime-packages.json`.

## Scope Boundaries

- This is a package/runtime contract checkpoint, not the final updater implementation.
- DRT05 remains `done: false` until real package build/upload steps exist and the desktop updater
  can check, download, verify, install, activate, retry, and roll back document runtime packages.
- DRT07 remains `done: false` until the desktop updater/app state is wired to the package install
  path with progress, retry, and rollback semantics.
- DRT03 and DRT04 remain open until signed/notarized Windows and macOS runtime artifacts are built
  from the manifests and included in customer installer profiles.

## Coverage

- `packages/document-runtime/src/runtime.test.mjs` covers doctor, isolated managed PATH, repair,
  expanded staging, `.veslopkg` pack/install, sha256 mismatch rejection, and no false activation.
- `packages/document-runtime/src/cli.test.mjs` covers CLI doctor/path/exec/stage and the
  pack/install artifact path.
- `packages/server/src/tests/server.document-runtime-routes.test.ts` covers status/repair route
  auth, default missing state, remote-only state, provider mapping, and provider fallback.
- App tests cover settings diagnostics, Veslo server client status/repair calls, live app prop
  wiring, and send preflight blocking for document skills.
- Den skill tests guard against reintroducing host package installs or direct host command
  examples in the core document skills.
- Release tests guard public release asset filtering, package-feed generation, and Windows/macOS
  local-docs-required package gates.

## Verification

Run on 2026-07-02:

```powershell
pnpm --filter veslo-document-runtime test
pnpm --filter veslo-document-runtime typecheck
pnpm --filter veslo-document-runtime validate:manifest
pnpm --filter veslo-document-runtime validate:package-feed
pnpm --filter veslo-document-runtime check:licenses
pnpm --filter veslo-server exec bun test src/tests/server.document-runtime-routes.test.ts
pnpm --filter veslo-server typecheck
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/pages/session-send-workflow.test.ts src/app/tests/app-view-props.test.ts src/app/tests/lib/document-runtime.test.ts src/app/tests/pages/settings-document-runtime.test.ts src/app/tests/lib/veslo-server-document-runtime.test.ts
pnpm --filter @neatech/veslo-ui typecheck
pnpm --dir services/den exec tsx --test test/core-platform-skills.test.ts test/core-platform-skill-bootstrap.test.ts
node --test scripts/release/public-release-assets.test.mjs scripts/release/generate-document-runtime-package-feed.test.mjs scripts/release/verify-document-runtime-windows.test.mjs scripts/release/verify-document-runtime-macos.test.mjs
git diff --check
```

Result:

- document runtime package tests passed: 22/22
- server document runtime route tests passed: 7/7
- app focused runtime/status/preflight tests passed: 21/21
- Den skill tests passed: 6/6
- release document-runtime tests passed: 23/23
- typecheck and validation entrypoints passed
- `git diff --check` passed with existing Windows LF -> CRLF warnings only

## Status

Checkpoint complete. The runtime package contract is now concrete and test-covered; remaining work
is the desktop updater/installer integration and signed platform package production tracked in the
headless office document runtime implementation plan.
