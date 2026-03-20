# Release checklist

Veslo releases should be deterministic, easy to reproduce, and fully verifiable with CLI tooling.

## Preflight

- Sync the default branch (currently `dev`).
- Run `pnpm release:review` and fix any mismatches.
- If you are building sidecar assets, set `SOURCE_DATE_EPOCH` to the tag timestamp for deterministic manifests.

## App release (desktop)

1. Bump versions (app + desktop + Tauri + Cargo):
    - `pnpm bump:calver` (CalVer format: `YYYY.M.P`)
2. Re-run `pnpm release:review`.
3. Build sidecars for the desktop bundle:
   - `pnpm --filter @neatech/veslo prepare:sidecar`
4. Commit the version bump.
5. Tag and push:
   - `git tag vYYYY.M.P`
   - `git push origin vYYYY.M.P`

## veslo-orchestrator (npm + sidecars)

1. Bump versions (includes `packages/orchestrator/package.json`):
   - `pnpm bump:calver`
2. Build sidecar assets and manifest:
   - `pnpm --filter veslo-orchestrator build:sidecars`
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

## AUR

`Release App` publishes the Arch AUR package automatically after the Linux `.deb` asset is uploaded.

Required repo config:

- GitHub Actions secret: `AUR_SSH_PRIVATE_KEY` (SSH key with push access to the AUR package repo)
- Optional repo variable: `AUR_REPO` (defaults to `veslo`)

## npm publishing

If you want `Release App` to publish `veslo-orchestrator`, `veslo-server`, and `veslo-code-router` to npm, configure:

- GitHub Actions secret: `NPM_TOKEN` (npm automation token)

If `NPM_TOKEN` is not set, the npm publish job is skipped.
