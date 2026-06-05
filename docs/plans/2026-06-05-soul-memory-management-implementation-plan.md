# Soul Memory Management Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the existing Soul heartbeat dashboard with a DB-first, versioned Soul memory management surface for Organization, User, and Workspace scopes.

**Architecture:** Den owns canonical User and Organization Soul version history. The local Veslo server exposes app-facing Soul routes, caches/syncs Den-backed data, manages workspace-local Soul versions, and materializes effective Soul into workspace runtime files automatically. The Solid app renders Organization, User, and Workspace sections plus a versioned editor detail, using existing i18n and design-system patterns.

**Tech Stack:** SolidJS app, Veslo local server TypeScript APIs, Den-auth context, Tauri desktop runtime, existing i18n locale files, Vitest/node tests, WebdriverIO desktop E2E.

---

## Task 1: Add Soul Memory Server Types And Pure Reducers

**Files:**
- Create: `packages/server/src/soul-memory.ts`
- Create: `packages/server/src/soul-memory.test.ts`
- Modify: `packages/server/src/types.ts`

**Step 1: Write failing tests for version creation and restore**

Create tests covering:

```ts
import { describe, expect, test } from "vitest";
import {
  createSoulVersion,
  restoreSoulVersion,
  resolveEffectiveSoul,
  type SoulDocument,
} from "./soul-memory.js";

test("createSoulVersion appends an immutable version and advances currentVersionId", () => {
  const now = "2026-06-05T10:00:00.000Z";
  const doc: SoulDocument = {
    id: "soul_user_1",
    scope: "user",
    ownerId: "user_1",
    currentVersionId: "v1",
    heartbeatEnabled: false,
    versions: [{
      id: "v1",
      content: "# User Soul\n",
      changeSummary: "Initial",
      createdAt: now,
      createdBy: "user_1",
      source: "manual",
      baseVersionId: null,
      restoreSourceVersionId: null,
    }],
  };

  const next = createSoulVersion(doc, {
    id: "v2",
    content: "# User Soul\n- CFO context\n",
    changeSummary: "Add CFO context",
    createdAt: "2026-06-05T10:10:00.000Z",
    createdBy: "user_1",
    source: "api",
    baseVersionId: "v1",
  });

  expect(next.currentVersionId).toBe("v2");
  expect(next.versions).toHaveLength(2);
  expect(next.versions[0]?.content).toBe("# User Soul\n");
});

test("restoreSoulVersion creates a new current version instead of mutating history", () => {
  const doc = /* build document with v1 and v2 */;
  const next = restoreSoulVersion(doc, {
    id: "v3",
    restoreSourceVersionId: "v1",
    createdAt: "2026-06-05T10:20:00.000Z",
    createdBy: "user_1",
    changeSummary: "Restore v1",
  });

  expect(next.currentVersionId).toBe("v3");
  expect(next.versions.at(-1)?.restoreSourceVersionId).toBe("v1");
});
```

**Step 2: Run tests and verify they fail**

Run: `pnpm --filter openwork-server test -- soul-memory.test.ts`

Expected: fail because `soul-memory.ts` does not exist.

**Step 3: Implement types and pure helpers**

Add:

```ts
export type SoulScope = "organization" | "user" | "workspace";
export type SoulVersionSource = "manual" | "api" | "heartbeat" | "restore" | "system";

export interface SoulVersion {
  id: string;
  content: string;
  changeSummary: string;
  createdAt: string;
  createdBy: string;
  source: SoulVersionSource;
  baseVersionId: string | null;
  restoreSourceVersionId: string | null;
}

export interface SoulDocument {
  id: string;
  scope: SoulScope;
  ownerId: string;
  currentVersionId: string | null;
  heartbeatEnabled: boolean;
  versions: SoulVersion[];
}
```

Implement:

- `currentSoulVersion(document)`
- `createSoulVersion(document, input)`
- `restoreSoulVersion(document, input)`
- `resolveEffectiveSoul({ organization, user, workspace })`
- validation for stale base version conflicts

**Step 4: Run tests and verify they pass**

Run: `pnpm --filter openwork-server test -- soul-memory.test.ts`

Expected: pass.

**Step 5: Commit**

```bash
git add packages/server/src/soul-memory.ts packages/server/src/soul-memory.test.ts packages/server/src/types.ts
git commit -m "feat: add soul memory model"
```

## Task 2: Add Den-Backed Soul Client And Local Cache

**Files:**
- Create: `packages/server/src/soul-den-client.ts`
- Create: `packages/server/src/soul-den-client.test.ts`
- Create: `packages/server/src/soul-cache.ts`
- Create: `packages/server/src/soul-cache.test.ts`

**Step 1: Write failing Den client tests**

Test:

- User Soul GET sends Den token and user/org context.
- Organization Soul PATCH sends Den token and org id.
- Organization update returns 403 when Den rejects non-admin writes.
- stale `baseVersionId` returns conflict.

Use a mocked `fetch` dependency:

```ts
const calls: Array<{ url: string; init: RequestInit }> = [];
const fetchImpl = async (url: string, init?: RequestInit) => {
  calls.push({ url: String(url), init: init ?? {} });
  return new Response(JSON.stringify({ document: sampleDocument }), { status: 200 });
};
```

**Step 2: Run tests and verify they fail**

Run: `pnpm --filter openwork-server test -- soul-den-client.test.ts soul-cache.test.ts`

Expected: fail because modules do not exist.

**Step 3: Implement Den client**

Implement functions:

- `getUserSoul(input)`
- `updateUserSoul(input)`
- `getOrganizationSoul(input)`
- `updateOrganizationSoul(input)`
- `listSoulVersions(input)`
- `getSoulVersion(input)`
- `restoreSoulVersion(input)`

Expected Den route contract:

- `GET /v1/soul/user`
- `PATCH /v1/soul/user`
- `GET /v1/soul/user/versions`
- `GET /v1/soul/user/versions/:versionId`
- `POST /v1/soul/user/versions/:versionId/restore`
- `GET /v1/soul/organization`
- `PATCH /v1/soul/organization`
- `GET /v1/soul/organization/versions`
- `GET /v1/soul/organization/versions/:versionId`
- `POST /v1/soul/organization/versions/:versionId/restore`

Forward:

- bearer token from Den auth
- `x-veslo-org-id`
- `x-veslo-user-id`
- request id when available

**Step 4: Implement local cache**

Store cache under Veslo server data dir:

- `soul-cache/user/<userId>.json`
- `soul-cache/organization/<orgId>.json`
- `soul-cache/workspace/<workspaceId>.json`
- `soul-cache/pending/*.json`

Cache rules:

- cache Den success responses
- serve cached current documents for read-only offline display
- mark pending edits when Den is unavailable
- never claim pending local edits are Den-synced

**Step 5: Run tests and verify they pass**

Run: `pnpm --filter openwork-server test -- soul-den-client.test.ts soul-cache.test.ts`

Expected: pass.

**Step 6: Commit**

```bash
git add packages/server/src/soul-den-client.ts packages/server/src/soul-den-client.test.ts packages/server/src/soul-cache.ts packages/server/src/soul-cache.test.ts
git commit -m "feat: sync soul memory with den"
```

## Task 3: Replace Existing Server Soul Routes With Memory Routes

**Files:**
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/types.ts`
- Create: `packages/server/src/soul-routes.test.ts`

**Step 1: Write failing route tests**

Test app-facing routes:

- `GET /soul` returns organization, user, and workspace summaries.
- `GET /soul/organization` returns read model.
- `PATCH /soul/organization` requires Den auth and propagates 403.
- `PATCH /soul/user` creates a new version.
- `GET /workspace/:id/soul` returns workspace document even when workspace is not active.
- `PATCH /workspace/:id/soul` creates a workspace version.
- `POST /workspace/:id/soul/heartbeat-toggle` toggles workspace Heartbeat.

**Step 2: Run tests and verify they fail**

Run: `pnpm --filter openwork-server test -- soul-routes.test.ts`

Expected: fail because routes do not exist.

**Step 3: Implement read routes**

Add app-facing routes:

- `GET /soul`
- `GET /soul/organization`
- `GET /soul/user`
- `GET /soul/workspaces`
- `GET /workspace/:id/soul`
- `GET /soul/:scope/versions`
- `GET /soul/:scope/versions/:versionId`

Return UI-oriented read models:

```ts
type SoulSummary = {
  scope: "organization" | "user" | "workspace";
  ownerId: string;
  title: string;
  currentVersionId: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  status: "active" | "pending" | "conflict" | "not_configured";
  heartbeatEnabled: boolean;
  pendingSuggestionCount: number;
  canEdit: boolean;
};
```

**Step 4: Implement write routes**

Add:

- `PATCH /soul/organization`
- `PATCH /soul/user`
- `POST /soul/organization/versions/:versionId/restore`
- `POST /soul/user/versions/:versionId/restore`
- `PATCH /workspace/:id/soul`
- `POST /workspace/:id/soul/versions/:versionId/restore`
- `POST /workspace/:id/soul/heartbeat-toggle`

Use server-side auth enforcement. For Organization writes, rely on Den authorization and return Den 403 as an app-visible permission error.

**Step 5: Keep old heartbeat endpoints compatibility-only**

Either remove the current heartbeat-dashboard usage or keep old endpoints behind compatibility functions until the app stops calling them. Do not keep the old setup-audit model in the new UI.

**Step 6: Run tests and verify they pass**

Run: `pnpm --filter openwork-server test -- soul-routes.test.ts`

Expected: pass.

**Step 7: Commit**

```bash
git add packages/server/src/server.ts packages/server/src/types.ts packages/server/src/soul-routes.test.ts
git commit -m "feat: add soul memory api routes"
```

## Task 4: Add Effective Soul Materialization

**Files:**
- Create: `packages/server/src/soul-materializer.ts`
- Create: `packages/server/src/soul-materializer.test.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/server/src/types.ts`

**Step 1: Write failing materializer tests**

Test:

- effective Soul composes Organization, User, Workspace in order
- materializer writes managed runtime files
- workspace Heartbeat turns on when Workspace Soul is created
- materializer does not expose manual sync as required user action
- failed materialization returns actionable status

**Step 2: Run tests and verify they fail**

Run: `pnpm --filter openwork-server test -- soul-materializer.test.ts`

Expected: fail because materializer does not exist.

**Step 3: Implement materializer**

Write managed files under workspace `.opencode/`:

- `.opencode/soul-company.md`
- `.opencode/soul-user.md`
- `.opencode/soul-workspace.md`
- `.opencode/veslo/soul-manifest.json`

Ensure `opencode.json/jsonc` instructions include:

- `.opencode/soul-company.md`
- `.opencode/soul-user.md`
- `.opencode/soul-workspace.md`

Do not overwrite user-authored unmanaged files without ownership markers in the manifest.

**Step 4: Trigger materialization automatically**

Call materialization from:

- workspace open/provision path
- session start path when server has workspace context
- Soul save/restore path for affected workspace
- workspace Heartbeat-created version path

If a workspace is busy, mark reload/materialization pending, matching skill materialization behavior.

**Step 5: Run tests and verify they pass**

Run: `pnpm --filter openwork-server test -- soul-materializer.test.ts`

Expected: pass.

**Step 6: Commit**

```bash
git add packages/server/src/soul-materializer.ts packages/server/src/soul-materializer.test.ts packages/server/src/server.ts packages/server/src/types.ts
git commit -m "feat: materialize effective soul memory"
```

## Task 5: Update App API Client Types

**Files:**
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Create: `packages/app/src/app/lib/soul-memory-client.test.ts`

**Step 1: Write failing app client tests**

Test that the API client exposes:

- `getSoulOverview`
- `getOrganizationSoul`
- `updateOrganizationSoul`
- `getUserSoul`
- `updateUserSoul`
- `listSoulVersions`
- `restoreSoulVersion`
- `getWorkspaceSoul`
- `updateWorkspaceSoul`
- `toggleWorkspaceSoulHeartbeat`

**Step 2: Run tests and verify they fail**

Run: `pnpm --filter @neatech/veslo-ui test -- soul-memory-client.test.ts`

Expected: fail because client methods do not exist.

**Step 3: Add app-side types and client methods**

Add types:

- `VesloSoulScope`
- `VesloSoulDocument`
- `VesloSoulVersion`
- `VesloSoulSummary`
- `VesloSoulSuggestion`
- `VesloSoulOverview`

Add methods to `createVesloServerClient`.

**Step 4: Run tests and verify they pass**

Run: `pnpm --filter @neatech/veslo-ui test -- soul-memory-client.test.ts`

Expected: pass.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/veslo-server.ts packages/app/src/app/lib/soul-memory-client.test.ts
git commit -m "feat: add soul memory client api"
```

## Task 6: Build App State For Soul Page

**Files:**
- Modify: `packages/app/src/app/app.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/pages/soul.tsx`
- Create: `packages/app/src/app/pages/soul-state.test.ts`

**Step 1: Write failing state tests**

Test:

- Soul page loads overview through Veslo server client.
- Organization/User edit buttons are enabled based on `canEdit`.
- Workspace rows render without switching active workspace.
- status labels map from server status to localized display state.

**Step 2: Run tests and verify they fail**

Run: `pnpm --filter @neatech/veslo-ui test -- soul-state.test.ts`

Expected: fail against old heartbeat page props.

**Step 3: Replace old Soul props**

Remove old page dependencies on:

- `VesloSoulStatus`
- `VesloSoulHeartbeatEntry`
- setup audit items
- run heartbeat prompt actions
- cadence prompt controls

Add state:

- overview loading/error
- selected editor target
- editor draft
- version history
- suggestions
- save/restore busy states

**Step 4: Run tests and verify they pass**

Run: `pnpm --filter @neatech/veslo-ui test -- soul-state.test.ts`

Expected: pass.

**Step 5: Commit**

```bash
git add packages/app/src/app/app.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/pages/soul.tsx packages/app/src/app/pages/soul-state.test.ts
git commit -m "feat: load soul memory page state"
```

## Task 7: Implement Soul Management Page UI

**Files:**
- Modify: `packages/app/src/app/pages/soul.tsx`
- Create: `packages/app/src/app/pages/soul-layout-contract.test.ts`

**Step 1: Write failing layout contract tests**

Assert source contains:

- Organization section before User section
- User section before Workspace section
- workspace table headers
- no old setup audit strings
- no primary runtime sync column
- Heartbeat statuses for workspace rows

**Step 2: Run tests and verify they fail**

Run: `pnpm --filter @neatech/veslo-ui test -- soul-layout-contract.test.ts`

Expected: fail while old page remains.

**Step 3: Implement central content UI**

Build:

- Organization Soul section
- User Soul section
- Workspace Souls table
- status badges
- version metadata
- Heartbeat suggestion count
- open editor actions
- read-only permission states

Use existing app shell and design tokens. Do not recreate the Pencil placeholder sidebar.

**Step 4: Run tests and verify they pass**

Run: `pnpm --filter @neatech/veslo-ui test -- soul-layout-contract.test.ts`

Expected: pass.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/soul.tsx packages/app/src/app/pages/soul-layout-contract.test.ts
git commit -m "feat: redesign soul management page"
```

## Task 8: Implement Soul Memory Editor Detail

**Files:**
- Modify: `packages/app/src/app/pages/soul.tsx`
- Create: `packages/app/src/app/pages/soul-editor.test.ts`

**Step 1: Write failing editor tests**

Test:

- opening Organization editor shows Markdown editor and version history
- non-admin Organization user sees read-only state
- saving requires content and sends `baseVersionId`
- saving creates new version and refreshes overview
- restore creates a new version
- conflict response shows conflict state instead of overwriting
- Organization Heartbeat suggestions can be accepted only by admins

**Step 2: Run tests and verify they fail**

Run: `pnpm --filter @neatech/veslo-ui test -- soul-editor.test.ts`

Expected: fail because editor does not exist.

**Step 3: Implement editor**

Add:

- scope breadcrumb
- Markdown/Preview toggle
- change summary field
- save new version
- cancel/discard draft
- version history panel
- Heartbeat suggestions panel for Organization and Workspace
- permission panel

Keep all text localized.

**Step 4: Run tests and verify they pass**

Run: `pnpm --filter @neatech/veslo-ui test -- soul-editor.test.ts`

Expected: pass.

**Step 5: Commit**

```bash
git add packages/app/src/app/pages/soul.tsx packages/app/src/app/pages/soul-editor.test.ts
git commit -m "feat: add soul memory editor"
```

## Task 9: Add Localization

**Files:**
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`
- Create: `packages/app/src/i18n/soul-localization.test.ts`

**Step 1: Write failing localization tests**

Test every `soul.*` key used by `soul.tsx` exists in:

- English
- Czech
- Chinese

Also test no old heartbeat setup-audit keys are required by the new page.

**Step 2: Run tests and verify they fail**

Run: `pnpm --filter @neatech/veslo-ui test -- soul-localization.test.ts`

Expected: fail until new keys are added.

**Step 3: Add localized strings**

Include keys for:

- Organization Soul
- User Soul
- Workspace Souls
- Open editor
- Save new version
- Version history
- Change summary
- Heartbeat suggestions
- Active
- Heartbeat on
- Heartbeat off
- Conflict
- Not configured
- Pending
- Read only
- Organization admin required
- API-created version
- Heartbeat-created version
- Restored version
- Den offline
- Pending sync
- Accept suggestion
- Edit suggestion
- Dismiss suggestion

For Chinese, use existing project convention: full translation when available, otherwise safe English fallback consistent with current locale practice.

**Step 4: Run tests and verify they pass**

Run: `pnpm --filter @neatech/veslo-ui test -- soul-localization.test.ts`

Expected: pass.

**Step 5: Commit**

```bash
git add packages/app/src/i18n/locales/en.ts packages/app/src/i18n/locales/cs.ts packages/app/src/i18n/locales/zh.ts packages/app/src/i18n/soul-localization.test.ts
git commit -m "feat: localize soul memory management"
```

## Task 10: Add Heartbeat Suggestion Model

**Files:**
- Modify: `packages/server/src/soul-memory.ts`
- Modify: `packages/server/src/soul-memory.test.ts`
- Modify: `packages/server/src/server.ts`
- Modify: `packages/app/src/app/lib/veslo-server.ts`
- Modify: `packages/app/src/app/pages/soul.tsx`

**Step 1: Write failing tests**

Server tests:

- workspace Heartbeat can create a version when enabled
- workspace Heartbeat is enabled automatically when Workspace Soul is created
- Organization Heartbeat creates suggestions, not versions

App tests:

- Organization suggestions appear in editor detail
- accepting an Organization suggestion calls save-new-version route
- Workspace Heartbeat toggle changes row state

**Step 2: Run tests and verify they fail**

Run:

```bash
pnpm --filter openwork-server test -- soul-memory.test.ts soul-routes.test.ts
pnpm --filter @neatech/veslo-ui test -- soul-editor.test.ts
```

Expected: fail until suggestion model is added.

**Step 3: Implement suggestion model**

Add:

```ts
type SoulSuggestion = {
  id: string;
  scope: "organization" | "workspace";
  ownerId: string;
  proposedContent: string;
  rationale: string;
  createdAt: string;
  createdBy: "heartbeat";
  status: "pending" | "accepted" | "dismissed";
  sourceVersionId: string | null;
};
```

Workspace path:

- Heartbeat creates direct version when enabled.

Organization path:

- Heartbeat creates pending suggestion.
- Admin accepts suggestion by saving it as a new version.

**Step 4: Run tests and verify they pass**

Run the same commands from Step 2.

Expected: pass.

**Step 5: Commit**

```bash
git add packages/server/src/soul-memory.ts packages/server/src/soul-memory.test.ts packages/server/src/server.ts packages/app/src/app/lib/veslo-server.ts packages/app/src/app/pages/soul.tsx
git commit -m "feat: add soul heartbeat suggestions"
```

## Task 11: Update Documentation

**Files:**
- Modify: `docs/features/soul-and-automations.md`
- Modify: `docs/features/skill-registry-and-distribution.md`
- Modify: `docs/dev/veslo-server-app-contract.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/dev/app-map.md`

**Step 1: Update feature docs**

Document:

- Soul page is now memory management, not heartbeat audit
- Organization/User/Workspace scope semantics
- versioning
- Den sync
- Heartbeat behavior
- API access
- localization expectations

**Step 2: Update server contract**

Document:

- new `/soul` routes
- Den auth headers
- capabilities changes
- conflict responses
- materialization behavior

**Step 3: Update state/config docs**

Document local cache and materialization files.

**Step 4: Commit**

```bash
git add docs/features/soul-and-automations.md docs/features/skill-registry-and-distribution.md docs/dev/veslo-server-app-contract.md docs/dev/state-and-config-reference.md docs/dev/app-map.md
git commit -m "docs: document soul memory management"
```

## Task 12: Verification And Desktop E2E

**Files:**
- Create: `packages/e2e/specs/soul-memory-management.spec.ts`
- Modify as needed: `packages/e2e/helpers/*`

**Step 1: Write E2E spec**

Cover:

- Soul page shows Organization, User, Workspace sections
- Organization non-admin cannot save
- Organization admin can save a new version
- User can save User Soul
- workspace table shows Heartbeat on/off states
- editor history shows manual/API/heartbeat/restore source labels
- UI text appears localized in Czech and English

**Step 2: Run focused unit tests**

Run:

```bash
pnpm --filter openwork-server test -- soul-memory.test.ts soul-den-client.test.ts soul-cache.test.ts soul-routes.test.ts soul-materializer.test.ts
pnpm --filter @neatech/veslo-ui test -- soul-state.test.ts soul-layout-contract.test.ts soul-editor.test.ts soul-localization.test.ts
```

Expected: pass.

**Step 3: Rebuild server binary**

Because `packages/server/src` changed, run:

```bash
pnpm --filter openwork-server build:bin
```

Expected: binary build succeeds.

**Step 4: Run real desktop E2E**

Follow `docs/dev/testing-playbook.md` preflight first. Then run the focused desktop E2E from `packages/e2e` against `packages/desktop`.

Expected: real Tauri runtime passes the Soul memory management scenario.

**Step 5: Commit verification spec and generated server binary/schema changes**

```bash
git add packages/e2e/specs/soul-memory-management.spec.ts packages/desktop/src-tauri/gen/schemas
git commit -m "test: verify soul memory management"
```

## Final Acceptance Criteria

- Old Soul setup-audit UI is removed from the app page.
- Organization Soul appears first.
- User Soul appears second.
- Workspace Souls appear in one table.
- User and Organization Soul are editable through UI and API.
- Organization Soul write requires Organization admin permission.
- Soul versions are immutable and synced to Den.
- Restore creates a new version.
- Workspace Soul can be inspected without opening that workspace runtime.
- Workspace Heartbeat auto-enables when Workspace Soul exists and can be disabled.
- Organization Heartbeat creates suggestions only.
- User Soul has no Heartbeat automation in MVP.
- Runtime materialization is automatic and not a primary user-facing workflow.
- New UI is localized in English, Czech, and Chinese fallback/translation.
- Server binary is rebuilt after server changes.
- Focused unit tests and real Tauri E2E pass.
