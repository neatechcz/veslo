# Onboarding Test Skill Design

## Goal

Provide a repository-local Codex skill that lets developers test Veslo's first-run onboarding flow without changing product code or adding UI.

## Problem

Deleting local app data alone does not reliably produce onboarding in this repo. On the next launch, the development app can rehydrate cloud connection settings from `packages/app/.env.development` and resume direct entry instead of showing onboarding.

## Constraints

- Keep this repository-only. Do not add a global Codex skill.
- Do not change product behavior or add new UI.
- Normal launches must keep the current direct-entry behavior.
- The test flow should be developer-only and repeatable.

## Decision

Create a repo-local skill plus a helper script under `.opencode/skills/`.

The helper script will:

1. Stop if the default Vite port is already in use, so it does not reuse an existing dev server with stale env.
2. Clear the local Veslo desktop development state on macOS:
   - `~/Library/Application Support/com.neatech.veslo.dev`
   - `~/Library/Caches/com.neatech.veslo.dev`
   - `~/Library/Caches/veslo`
   - `~/Library/WebKit/veslo`
   - `~/.veslo/veslo-orchestrator-dev` (or `VESLO_DATA_DIR` if set)
3. Launch `pnpm dev` with all `VITE_VESLO_*` auto-connect variables overridden to empty strings for that process only.

Because Vite does not overwrite existing shell env with dotenv values, empty process env values are enough to suppress the cloud auto-connect values from `packages/app/.env.development` for that launch.

## Why This Is The Smallest Working Shape

- No product code changes
- No new settings or hidden UI
- No `.env` file renames or edits
- No risk of leaving the app in a modified default state
- The bypass lasts only for the launched process

## Expected Flow

1. Developer closes any running `pnpm dev` / `pnpm dev:ui` process.
2. Developer invokes the repo-local onboarding-test skill.
3. Codex runs the helper script.
4. The helper script clears local state and starts the app with auto-connect env disabled for that run.
5. Veslo opens in the normal onboarding flow.
6. Later launches return to the current default behavior.

## Out Of Scope

- Changing packaged-app behavior
- Adding a one-shot launch flag to Veslo
- Supporting remote execution in the product
- Converting this workflow into end-user UI
