# Admin-Managed AI Access Finish Phase Design

## Goal

Finish the branch to a merge-ready state by adding one more end-to-end policy flow test, cleaning up the supporting E2E/admin tooling, verifying parity with the mounted Windows working copy, and using CI-supported paths for Windows MSI building and AI gateway deployment.

## Recommended Approach

Use the existing branch as the source of truth and keep the remaining work incremental:

1. Add one focused backend end-to-end test that proves the admin can change a user's AI access policy and that the user-facing effective policy reflects the change.
2. Keep the desktop E2E scope focused on the already-working authenticated settings read-only behavior instead of mutating live hosted state from the app test harness.
3. Document the new live-auth and live-admin scripts so reviewers and operators can reproduce the same verification steps.
4. Compare the WSL worktree against the mounted Windows repo path and synchronize the source tree contents if needed.
5. Use GitHub Actions for the Windows MSI and AI gateway deployment because this WSL session cannot reliably execute Windows-native build tooling.

## Why This Approach

This avoids brittle live-environment mutation in desktop WebDriver tests while still closing the only meaningful coverage gap: admin policy writes should drive the effective user policy. It also respects the actual constraints of this environment: the mounted `D:` repo is visible, but `cmd.exe` and `powershell.exe` currently fail from WSL, so Windows-native packaging should go through the repository's existing CI workflow.

## Scope

### Code

- Add a local integration-style test for:
  - `PUT /admin/api/users/:userId/ai-access`
  - `GET /api/me/ai-access`
  - updated effective policy visibility for that same user
- Keep existing desktop E2E coverage and rerun it after cleanup.
- Clean up and retain:
  - desktop auth seed helper
  - live admin lookup helper
  - E2E type fixes

### Docs and Tooling

- Document:
  - `pnpm run seed:live-auth`
  - `pnpm run check:live-admin-user`
  - CI path for Windows MSI
  - CI path for AI gateway deploy

### Release / Deploy

- Prepare the branch for push and CI execution.
- Trigger:
  - `Build Windows MSI`
  - `Deploy AI Gateway`

## Non-Goals

- Building a Windows MSI locally inside this WSL shell.
- Mutating the live hosted admin directory from the desktop E2E harness.
- Broad refactors unrelated to admin-managed AI access completion.
