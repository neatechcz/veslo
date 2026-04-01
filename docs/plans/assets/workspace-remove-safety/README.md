# Workspace Remove Safety Verification

Date: 2026-04-01

## Automated checks

Run from repo root:

```bash
pnpm --filter @neatech/veslo-ui test:workspace-remove-safety
```

This executes:

1. Rust safety tests in `packages/desktop/src-tauri` for `workspace_forget` mode behavior.
2. UI/store contract test in `packages/app/src/app/context/workspace-forget-mode.test.ts`.

## Expected behavior

1. `detach_only` keeps `.opencode` and `opencode.jsonc` on disk.
2. `delete_local_data` removes `.opencode` and `opencode.jsonc`.
3. App bridge defaults to `detach_only`.
