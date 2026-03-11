# Veslo Updates Release Routing Design

**Date:** 2026-03-11
**Status:** Approved

## Goal

Route all public desktop update artifacts for Veslo to `neatechcz/veslo-updates` while keeping the build and source-controlled release workflow in the main code repository.

## Current State

- The desktop app updater endpoint still points at `https://github.com/neatech/veslo/releases/latest/download/latest.json`.
- The main release workflow generates and uploads `latest.json` into the source repository release.
- `neatechcz/veslo-updates` exists as a public distribution repository, but it has no workflow and no mirrored assets yet.
- The current version across app, desktop, orchestrator, server, and router packages is `2026.3.0`.
- No `v2026.3.0` release exists yet in `neatechcz/veslo` or `neatechcz/veslo-updates`, so the correct release version remains `2026.3.0`.

## Decision

Keep the build in the main repository, then mirror only the public desktop artifacts into `neatechcz/veslo-updates`. The app updater will read `latest.json` from the public distribution repository.

## Design

### 1. Updater Endpoint

Change the Tauri updater endpoint to:

`https://github.com/neatechcz/veslo-updates/releases/latest/download/latest.json`

This makes in-app macOS and Windows updates resolve from the public distribution repo instead of the source repo.

### 2. Release Workflow Routing

The main release workflow will continue to:

- validate the tag
- build desktop artifacts on GitHub Actions
- sign updater artifacts
- create the source release for internal traceability

After those steps, the workflow will also:

- create or reuse the matching tag/release in `neatechcz/veslo-updates`
- mirror only public desktop updater assets to that release
- generate `latest.json` against the public release assets
- upload `latest.json` to `neatechcz/veslo-updates`

The mirrored asset set should include:

- macOS updater artifacts
- Windows updater artifacts
- their `.sig` files
- `latest.json`

Non-desktop sidecar releases and npm publishing remain in the source repository.

### 3. Cross-Repo Authentication

Because the default `GITHUB_TOKEN` cannot write to another repository, the workflow will use explicit public-release configuration:

- repository variable: `VESLO_UPDATES_REPO`
- repository secret: `VESLO_UPDATES_GH_TOKEN`

The expected value for `VESLO_UPDATES_REPO` is `neatechcz/veslo-updates`.

### 4. Script and Workflow Shape

Avoid hardcoding the public repo name in multiple places. The workflow should pass the configured repo explicitly into any helper scripts that:

- enumerate public desktop assets
- mirror assets
- generate `latest.json`

This keeps the pipeline readable and makes future repo moves easier.

### 5. Release Procedure

For the current public release:

1. cut the release from clean remote `main`
2. use tag `v2026.3.0`
3. let GitHub Actions build macOS and Windows artifacts
4. confirm the public release appears in `neatechcz/veslo-updates`
5. confirm `latest.json` points to the public repo asset URLs

## Verification

Local verification before pushing:

- `node scripts/release/review.mjs --strict`
- `pnpm --filter @neatech/veslo-ui typecheck`

Workflow verification after push:

- confirm the source workflow succeeds
- confirm the `v2026.3.0` release exists in `neatechcz/veslo-updates`
- confirm macOS and Windows assets are attached there
- confirm `latest.json` is attached there and references `neatechcz/veslo-updates`
