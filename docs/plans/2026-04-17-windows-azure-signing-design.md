# Veslo Windows Azure Signing Design

**Date:** 2026-04-17
**Status:** Approved

## Goal

Sign every Windows release build in GitHub Actions by using Azure Artifact Signing, while keeping the existing Tauri updater asset contract intact.

## Current State

- The release workflow builds Windows artifacts with `tauri-action`, but it does not perform Windows Authenticode signing.
- Tauri updater publishing depends on `veslo-desktop-windows-<arch>.msi` plus the matching `.sig` asset.
- Azure Artifact Signing is now provisioned for Veslo:
  - account: `VesloSign`
  - endpoint: `https://plc.codesigning.azure.net/`
  - certificate profile: `veslo-public-trust`
  - GitHub OIDC environment: `release-signing`

## Decision

Use Tauri's Windows `signCommand` hook during the Windows bundle build so the executable and MSI are signed before upload. Authenticate the signing command through Azure login plus the Artifact Signing SignTool integration on the Windows runner.

Do not upload unsigned Windows assets and do not rely on a post-upload replacement step.

## Design

### 1. Split Windows release handling from the generic matrix

- Keep the existing matrix job for macOS and Linux.
- Move Windows release work into a dedicated `publish-tauri-windows` job.
- Attach that job to the GitHub environment `release-signing` so the Azure OIDC secrets are available only where needed.

This avoids leaking release-signing credentials into non-Windows jobs and makes the signing path explicit.

### 2. Sign during bundling, not after upload

- Add a Windows-only Tauri config overlay that sets `bundle.windows.signCommand`.
- Point the sign command at a repo-local PowerShell script.
- The script signs the path passed by Tauri (`%1`) by invoking `signtool.exe` with Azure Artifact Signing's `Azure.CodeSigning.Dlib.dll`.

This ensures the generated app executable and the MSI installer are both signed as part of the normal Tauri bundling flow.

### 3. Use Azure OIDC plus SignTool integration

On the Windows release job:

- authenticate with `azure/login`
- install Artifact Signing Client Tools
- generate the Artifact Signing metadata JSON from the GitHub environment variables
- let the Tauri sign command use Azure CLI/DefaultAzureCredential from that logged-in session

This keeps the workflow secret footprint minimal. No Windows certificate file or client secret is stored in GitHub.

### 4. Keep updater and public release asset names unchanged

The workflow must still publish:

- `veslo-desktop-windows-x64.msi`
- `veslo-desktop-windows-x64.msi.sig`

No changes are needed in `generate-latest-json.mjs`, `mirror-public-release.mjs`, or the updater endpoint as long as those names stay stable.

### 5. Fail fast when Windows signing is unavailable

Extend the release-signing resolver to require Azure signing configuration for Windows jobs:

- `AZURE_CLIENT_ID`
- `AZURE_TENANT_ID`
- `AZURE_SUBSCRIPTION_ID`
- `AZURE_ARTIFACT_SIGNING_ENDPOINT`
- `AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME`
- `AZURE_ARTIFACT_SIGNING_CERT_PROFILE_NAME`

If any are missing, the Windows release job must fail before build, instead of producing unsigned artifacts.

## Verification

Local verification:

- `node --test scripts/release/release-signing.test.mjs`

Workflow verification:

- confirm the Windows workflow path references `azure/login`
- confirm it installs Artifact Signing Client Tools
- confirm it signs Windows bundles through the repo-local sign script
- confirm it uploads the existing `veslo-desktop-windows-x64.msi` and `.sig` assets

Release verification after dispatch:

- `Get-AuthenticodeSignature` reports `Valid` for the built MSI
- the signed MSI is attached to the source release
- the mirrored public release still generates `latest.json`
