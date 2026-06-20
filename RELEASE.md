# Release checklist

Veslo releases should be deterministic, easy to reproduce, and fully verifiable with CLI tooling.

## Agent-assisted releases

Use the repo-local `veslo-release` skill before mutating release state from an agent. The Codex/OpenAI-compatible package lives under `.opencode/skills/veslo-release` with `agents/openai.yaml` metadata; the Claude Code copy lives under `.claude/skills/veslo-release`. Keep the two `SKILL.md` files functionally identical.

The skill must resolve beta vs production, generate public-safe release notes from real git changes, and treat `neatechcz/veslo-updates` as the public updater target rather than a required local checkout.

## Preflight

- Sync the default branch (currently `main`).
- Run `pnpm release:review` and fix any mismatches.
- If you are building sidecar assets, set `SOURCE_DATE_EPOCH` to the tag timestamp for deterministic manifests.

## App release (desktop)

1. Bump versions (app + desktop + Tauri + Cargo):
    - `pnpm bump:calver` (CalVer format: `YYYY.M.P`)
2. Re-run `pnpm release:review`.
3. Build sidecars for the desktop bundle:
   - `pnpm --filter @neatech/veslo prepare:sidecar`
   - Windows x64 sidecars must use Bun's `bun-windows-x64-baseline` target so packaged apps run on older supported x64 CPUs.
4. Commit the version bump.
5. Tag and push:
   - `git tag vYYYY.M.P`
   - `git push origin vYYYY.M.P`

## Windows signing

Windows desktop builds are signed in GitHub Actions through Azure Artifact Signing. The `release-signing` GitHub environment must provide:

- Secrets: `AZURE_CLIENT_ID`, `AZURE_TENANT_ID`, `AZURE_SUBSCRIPTION_ID`
- Variables: `AZURE_ARTIFACT_SIGNING_ENDPOINT`, `AZURE_ARTIFACT_SIGNING_ACCOUNT_NAME`, `AZURE_ARTIFACT_SIGNING_CERT_PROFILE_NAME`

The Azure principal behind `AZURE_CLIENT_ID` must have `Artifact Signing Certificate Profile Signer` on the certificate profile. Windows workflows install the Artifact Signing dlib package, call the Tauri Windows `signCommand`, then verify Authenticode signatures on the app executable and MSI before upload. The bundled `versions.json` sidecar manifest is intentionally skipped by the sign command because Tauri packages it through `externalBin` even though it is not an executable.

Each Windows `signtool` invocation is bounded by `VESLO_WINDOWS_SIGNING_TIMEOUT_SECONDS` (default `300`) and retried up to `VESLO_WINDOWS_SIGNING_MAX_ATTEMPTS` times (default `3`) so a stalled Azure Artifact Signing request fails or recovers without hanging the whole release indefinitely.

## macOS signing and notarization

macOS desktop builds use a Developer ID Application certificate for signing:

- Secrets: `APPLE_SIGNING_IDENTITY`, `APPLE_CODESIGN_CERT_P12_BASE64`, `APPLE_CODESIGN_CERT_PASSWORD`

For notarization, GitHub Actions supports either App Store Connect API key credentials:

- Secrets: `APPLE_NOTARY_API_KEY_ID`, `APPLE_NOTARY_API_ISSUER_ID`, `APPLE_NOTARY_API_KEY_P8_BASE64`

Or Apple ID app-specific password credentials:

- Secrets: `APPLE_NOTARY_APPLE_ID`, `APPLE_NOTARY_APP_SPECIFIC_PASSWORD`
- Variable or secret: `APPLE_TEAM_ID`

Use the Apple ID app-specific password path when the Apple Developer account can manage certificates but is not enabled for App Store Connect.

## veslo-orchestrator (npm + sidecars)

1. Bump versions (includes `packages/orchestrator/package.json`):
   - `pnpm bump:calver`
2. Build sidecar assets and manifest:
   - `pnpm --filter veslo-orchestrator build:sidecars`
   - Release sidecars are built for macOS and Windows only. Windows x64 sidecars must use Bun's `bun-windows-x64-baseline` target.
3. Create the GitHub release for sidecars:
   - `gh release create veslo-orchestrator-vYYYY.M.P packages/orchestrator/dist/sidecars/* --repo neatechcz/veslo`
4. Publish the package:
   - `pnpm --filter veslo-orchestrator publish --access public`

## veslo-server + opencode-router (if version changed)

- `pnpm --filter veslo-server publish --access public`
- `pnpm --filter veslo-code-router publish --access public`

## Verification

- `veslo start --workspace /path/to/workspace --check --check-events`
- `gh run list --repo neatechcz/veslo --workflow "Release App" --limit 5`
- `gh release view vYYYY.M.P --repo neatechcz/veslo`

Use `pnpm release:review --json` when automating these checks in scripts or agents.

## npm publishing

If you want `Release App` to publish `veslo-orchestrator`, `veslo-server`, and `veslo-code-router` to npm, configure:

- GitHub Actions secret: `NPM_TOKEN` (npm automation token)

If `NPM_TOKEN` is not set, the npm publish job is skipped.
