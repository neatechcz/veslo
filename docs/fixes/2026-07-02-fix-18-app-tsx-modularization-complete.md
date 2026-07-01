# Fix 18: App TSX Modularization Complete

## Problem

`packages/app/src/app/app.tsx` had grown into a 12k+ line application shell that mixed top-level
composition with route sync, server connection state, Den auth handoff, managed-AI access/config
sync, conversation API adapters, attachment staging, send orchestration, session creation/mutation
workflows, archive state, sidebar decorations, capabilities loading, deep-link handling, MCP/skill
orchestration, scheduled automations, Soul data, startup hydration, send tracing, and page prop
assembly.

That made app-level changes hard to split across agents and encouraged new behavior to be added
back into the shell instead of to the owning business module.

## Fix

- Completed the implementation plan in
  `docs/plans/2026-07-01-app-tsx-parallel-modularization-implementation-plan.md`; AM00 through
  AM25 are merged and `done: true`.
- Kept `packages/app/src/app/app.tsx` as the public `App` composition root, top-level Solid owner,
  dependency wiring surface, modal mount point, and JSX route shell.
- Extracted durable app/context owners:
  - `packages/app/src/app/context/app-shell-environment.ts`
  - `packages/app/src/app/context/app-route-sync.ts`
  - `packages/app/src/app/context/feedback-workflow.ts`
  - `packages/app/src/app/context/veslo-server-connection.ts`
  - `packages/app/src/app/context/workspace-runtime-debug-probe.ts`
  - `packages/app/src/app/context/den-desktop-auth-workflow.ts`
  - `packages/app/src/app/context/managed-ai-access-store.ts`
  - `packages/app/src/app/context/managed-ai-runtime-config.ts`
  - `packages/app/src/app/context/conversation-service.ts`
  - `packages/app/src/app/context/app-deep-link-workflow.ts`
  - `packages/app/src/app/context/skill-registry-orchestrator.ts`
  - `packages/app/src/app/context/mcp-connection-workflow.ts`
  - `packages/app/src/app/context/app-startup-hydration.ts`
  - `packages/app/src/app/context/app-send-trace.ts`
- Extracted session/page/dashboard workflow owners:
  - `packages/app/src/app/pages/session-attachment-staging.ts`
  - `packages/app/src/app/pages/session-send-workflow.ts`
  - `packages/app/src/app/pages/session-creation-workflow.ts`
  - `packages/app/src/app/pages/session-mutation-workflow.ts`
  - `packages/app/src/app/context/session-archive-store.ts`
  - `packages/app/src/app/context/session-sidebar-decorations.ts`
  - `packages/app/src/app/context/session-route-sync.ts`
  - `packages/app/src/app/context/session-capabilities-store.ts`
  - `packages/app/src/app/pages/scheduled-automation-store.ts`
  - `packages/app/src/app/pages/soul-data-store.ts`
  - `packages/app/src/app/app-view-props.ts`
- Retargeted app source-contract tests so they assert the owning modules and final shell wiring
  instead of requiring business logic to stay inline in `app.tsx`.
- Updated live documentation:
  - `docs/dev/app-map.md`
  - `docs/agents-doc/agents.md`

## Coverage

- `app-modularization-contract.test.ts` locks the expected module factories and prevents the app
  shell from re-owning large extracted workflows.
- Focused module tests cover the extracted workflow/store boundaries for route sync, shell
  environment effects, feedback, Veslo server connection, Den auth, managed-AI access/config,
  conversation service, attachment staging, send, creation, mutation, archive, sidebar decorations,
  session route sync, capabilities, deep links, skill registry, MCP connection, scheduled
  automations, Soul data, startup hydration, view props, and send trace behavior.
- `app.tsx` is now 4,353 lines in the local checkout used for this checkpoint.

## Verification

Final code verification was run on 2026-07-02 before this documentation checkpoint:

```powershell
pnpm --filter @neatech/veslo-ui typecheck
pnpm --filter @neatech/veslo-ui test:unit
git diff --check
```

Result:

- app typecheck passed
- app unit suite passed
- `git diff --check` passed with existing Windows LF -> CRLF warnings only

## Status

The `app.tsx` modularization project is complete. Future app work should start from the owning
module in `docs/dev/app-map.md` and only return to `app.tsx` for composition, dependency injection,
route shell wiring, or top-level modal/provider mounting.
