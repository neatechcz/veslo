---
name: test-onboarding-flow
description: Use when testing Veslo's first-run onboarding flow from this repository and you need to clear local desktop state while bypassing development cloud auto-connect for one launch
---

# Test Onboarding Flow

## Overview

Use this repository-local skill to reproduce Veslo's onboarding flow without changing product code. The helper script clears the local macOS desktop development state and launches `pnpm dev` with the repo's `VITE_VESLO_*` auto-connect variables overridden to empty strings for that process only.

## When to Use

- The dev app keeps opening directly into an existing connected state.
- You need to verify the onboarding path defined in `PRODUCT.md`.
- You want a repo-local developer workflow, not a product feature.

Do not use when:

- You are testing a packaged build.
- You need a brand-new cloud identity or organization.
- `pnpm dev` or `pnpm dev:ui` is already running.

## Quick Use

1. Stop any running Veslo dev processes.
2. From the repo root, run:

```bash
.opencode/skills/test-onboarding-flow/scripts/run-onboarding-test.sh
```

3. Verify Veslo opens in onboarding instead of direct entry.
4. After the test, close the app and run `pnpm dev` normally to return to the default behavior.

## What The Helper Clears

- `~/Library/Application Support/com.neatech.veslo.dev`
- `~/Library/Caches/com.neatech.veslo.dev`
- `~/Library/Caches/veslo`
- `~/Library/WebKit/veslo`
- `~/.veslo/veslo-orchestrator-dev` unless `VESLO_DATA_DIR` overrides it

## Common Mistakes

- Reusing an existing Vite server. The helper aborts if the target port is already in use.
- Editing `packages/app/.env.development`. Do not modify the file. The helper only overrides process env for the launched run.
- Expecting cloud data to reset. This workflow clears local app state only.

## Notes

- This helper currently targets the default macOS desktop development setup used in this repo.
- The reason it works is that Vite does not overwrite preexisting shell env with dotenv values, so empty `VITE_VESLO_*` process env values suppress the cloud auto-connect settings from `packages/app/.env.development`.
