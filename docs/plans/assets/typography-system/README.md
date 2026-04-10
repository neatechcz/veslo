# Typography System Verification

## Screenshots

- `session.png`
  Tauri session surface after the typography rollout. Shows the reading font in the composer and session body.
- `settings.png`
  Tauri settings diagnostics surface with product chrome labels and mono technical strings.
- `skills.png`
  Tauri skills page with product titles and normalized dense metadata.
- `mcp.png`
  Tauri MCP page with the same title and dense metadata treatment as the rest of the shell.

`onboarding.png` was not captured in this pass. The Docker/browser gate failed before browser-backed verification, so onboarding was only verified by source-level and unit coverage in this run.

## Commands Run

### Focused app tests

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/styles/typography-contract.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/shared-typography.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/session-typography.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/components/session/message-list-path-layout.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/app-shell-typography.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/dashboard-sidebar-navigation-layout.test.ts
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/pages/session-sidebar-navigation-layout.test.ts
```

Result: all passed.

### App typecheck

```bash
pnpm --filter @neatech/veslo-ui typecheck
```

Result: failed on pre-existing repo errors outside this typography work. Remaining errors were in:

- `src/app/app.tsx`
- `src/app/context/session-select-background-hydration.test.ts`
- `src/app/context/session-transcript-hydration.test.ts`
- `src/app/context/session.ts`
- `src/app/context/workspace.ts`
- `src/app/macos-folder-permission-guard.test.ts`
- `src/app/stores/engine-store.ts`

No remaining typecheck error was left in `src/app/pages/skills.tsx` after the typography changes.

### Desktop runtime

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle -- --features e2e

cd ../e2e
pnpm test --spec ./specs/typography.spec.ts
pnpm test --spec ./specs/session.spec.ts
pnpm test --spec ./specs/visual-regression.spec.ts
```

Result:

- `pnpm tauri build --debug --no-bundle -- --features e2e`: passed
- `pnpm test --spec ./specs/typography.spec.ts`: passed
- `pnpm test --spec ./specs/session.spec.ts`: passed
- `pnpm test --spec ./specs/visual-regression.spec.ts`: failed

Visual regression notes:

- Existing full-screen baselines were updated locally for the changed pages.
- The spec remains unstable because several pages produce non-deterministic diffs across runs, with the session surface diverging the most.
- A `document.fonts.ready` wait was added before captures, which reduced but did not eliminate the instability.

WebDriver reuse:

- WebDriver launched a fresh Tauri binary for the desktop runs in this pass.

## Docker / Browser Gate

```bash
packaging/docker/dev-up.sh
```

Result: failed.

Observed failure:

- First attempt failed because the host OpenCode config mount was rejected.
- The script retried with fallback empty host dirs.
- Second attempt failed because the Docker orchestrator container exited during `pnpm install` with:

```text
ERR_PNPM_ENOTEMPTY ENOTEMPTY: directory not empty, rmdir '/app/node_modules/.pnpm/aria-query@5.3.2/node_modules/aria-query'
```

Because the Docker dev stack never became healthy, Chrome MCP verification could not be completed in this run.

## Remaining Visual Tuning Notes

- The main session/chat surface is now on the reading font and larger reading size.
- Shell titles, chips, and dense metadata are aligned to the product font and semantic `type-ui-*` scale.
- Diagnostics and path-like strings remain mono.
- Onboarding typography was updated in source, but its runtime screenshot is still missing from this verification pass.
