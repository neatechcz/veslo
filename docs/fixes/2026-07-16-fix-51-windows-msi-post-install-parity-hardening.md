# Fix 51: Windows MSI Post-Install Parity Hardening

Date: 2026-07-16

## Scope

This checkpoint records the implementation work from the Windows dev-versus-MSI
parity audit. Its purpose is to make a Windows release fail before publication
when the final MSI differs materially from the checked-out development runtime.

It is not evidence that a public, signed MSI has already passed a real
`msiexec /i` clean-install or upgrade run. That evidence remains explicitly
open below.

## Problems Addressed

- `desktop-bootstrap:ready` could be missed when the first local-server ensure
  occurred during runtime warming. The old latch was set before an asynchronous
  diagnostic write had succeeded, while a successful spool forward could delete
  the only event that the installed-MSI verifier looked for.
- The packaged smoke used a debug build and could inherit checkout, sidecar,
  provider, credential, or dev-runtime overrides. Debug-only orchestrator
  autostart could therefore make a cold start pass for a reason unavailable to
  the release binary.
- An extracted MSI (`msiexec /a`) was being described too easily as an installed
  MSI test. The real `/i` harness existed but had no durable readiness marker
  and did not reject a candidate that reintroduced WSL provisioning before
  installation.
- Windows prerelease and staging flows could upload an MSI before its final
  extracted-payload and signature gates completed. This made a later gate a
  post-publication diagnostic rather than a release gate.
- Current Windows installers were still at risk of shipping or surfacing WSL
  sandbox setup even though the desktop default is shared non-sandbox runtime.
- A Windows configuration that skipped WebView2 did not meet the clean-machine
  first-launch contract.

## Implemented Behavior

### Bootstrap readiness

- The app has a reactive, retrying readiness observer. It records
  `desktop-bootstrap:ready` only after the local server is connected and the
  runtime is ready; a failed write leaves the latch available for retry.
- The desktop diagnostic forwarder writes the redacted ready event to a separate
  atomic marker. It survives normal spool forwarding and is read before the
  spool fallback by the installed-MSI verifier.
- The installed verifier requires the marker to describe connected server status
  and ready runtime readiness, not merely a successful MSI exit code.

### Production-shaped packaged smoke

- The smoke environment removes inherited `E2E_*`, `VESLO_*`, `VITE_*`,
  `OPENCODE_*`, provider, and credential overrides, then restores only its Pilot
  binary and the small set of smoke-owned variables.
- The focused packaged-smoke Pilot scenario injects
  `VESLO_DISABLE_DEV_AUTOSTART=1`, so the debug-only dev autostart path cannot
  make the smoke pass.
- The smoke keeps the release sidecar overlay, an isolated profile, bundled
  runtime binaries, and a deterministic local model fixture. It remains a fast
  developer signal, not a replacement for the final MSI gate.

### Final-MSI and workflow gates

- The shared extracted-MSI verifier checks the actual payload from one exact
  MSI, the compiled document-runtime provider, bundled Chrome DevTools MCP
  runtime, sidecar manifest/version integrity, and the absence of host
  Node/npm/Bun dependence. Signed Windows executables are compared with the
  shared Authenticode-canonical hash algorithm rather than a raw file hash.
- The verifier rejects WSL/VesloSandbox payload files and MSI custom actions.
  The installed-MSI harness performs the same candidate audit before any `/i`
  action, verifies elevation before it starts MSI work, and rejects stale updater
  logs unless a timestamp from the real in-app updater transaction is supplied.
- Production, prerelease, manual, and staging Windows paths run the extracted
  payload gate and signature verification before their first MSI upload. The
  prerelease Windows build no longer uses an upload-capable Tauri action before
  those gates.
- Release review and its tests enforce the upload ordering rather than relying
  on workflow step names. Extracted-MSI verification is named as extraction;
  installed-MSI verification is reserved for the `/i` VM harness.

### Windows prerequisites and WSL policy

- Windows uses the WebView2 `embedBootstrapper` mode and static release checks
  reject the former `skip` contract.
- Shipping Tauri configurations no longer include WSL setup resources, WiX WSL
  fragments/component groups, or NSIS WSL hooks. The app-side Windows sandbox
  repair policy is hidden, including for old persisted preferences and support
  flows.
- Source-only WSL support scripts remain outside shipping configuration for a
  future product decision; they are not an installer feature today.

## KISS Boundary

- The readiness fix extends the existing bootstrap diagnostic pipeline instead
  of introducing a second readiness service or log store.
- The final-MSI gates call shared scripts from workflows; verification logic is
  not copied into YAML.
- No full office runtime, host package manager, or WSL distribution was added to
  the MSI. Windows document runtime remains package-only in user app data.
- No real install was run on the development workstation as a substitute for a
  disposable-VM test.

## Verification

Parity implementation verification, run on 2026-07-15:

```powershell
node --test packages/desktop/scripts/tauri-config.test.mjs scripts/release/review.test.mjs scripts/release/release-signing.test.mjs scripts/release/verify-windows-msi-runtime.test.mjs scripts/release/verify-windows-msi-installed.test.mjs
# 60 passed, 0 failed

pnpm release:review --strict
# passed; only the normal SOURCE_DATE_EPOCH warning was emitted

pnpm desktop:smoke-packaged
# passed on Windows after the autostart and environment-isolation changes

git diff --check
git diff --cached --check
# passed; CRLF notices only
```

Checkpoint documentation verification, run on 2026-07-16:

```powershell
node --test scripts/desktop-smoke-packaged.test.mjs
# 5 passed, 0 failed

pnpm release:review --strict
# passed; only the normal SOURCE_DATE_EPOCH warning was emitted
```

A locally built unsigned Windows MSI was also administratively extracted. Its
271-file payload contained no WSL setup file or WSL/VesloSandbox custom action.
That is payload evidence only: it does not prove installation, first launch,
upgrade, WebView2 bootstrap, or updater behavior.

## Remaining Evidence Required

- A published, signed successor MSI must pass the extracted-MSI verifier with
  its final signed manifest hashes.
- The same MSI must be exercised in disposable Windows VMs with WebView2 both
  present and absent.
- The installed-MSI harness must run real `/i` scenarios for clean user,
  no-WSL image, upgrade from 26.6.26, normal and forced second start, foreign
  listener, and in-app updater evidence.
- Until that VM evidence exists, the Windows post-install parity plan remains
  `done: false`; neither a green source checkout nor `msiexec /a` is a release
  closure signal.

## Status

The code, static gates, workflow ordering, packaged smoke isolation, and
canonical release/developer documentation are implemented. The remaining work
is external release evidence over one public signed MSI in disposable VMs, not
another source-only implementation pass.
