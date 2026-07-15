# Admin Portal and Global Managed-AI Model Policy Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Split the canonical admin portal into platform and organization operating areas, move Managed-AI model policy out of user assignments, and make one platform-selected model authoritative for every user.

**Architecture:** AI Gateway owns a singleton platform model policy containing multiple enabled provider/model references and exactly one active model. User AI-access records retain enablement and compatible credential assignment, while runtime responses compose the active model from the platform policy. The canonical AI Gateway admin exposes platform AI Infrastructure and explicit organization-workspace routes; DEN remains the source for identity, organization, and billing data.

**Tech Stack:** TypeScript, Express, Drizzle ORM/MySQL, static HTML/CSS/JavaScript admin client, SolidJS desktop UI, Node test runner, Tauri Pilot.

---

## Preconditions

- Create a dedicated `codex/` worktree before implementing; do not execute this plan directly on `dev_vaclav`.
- Read `AGENTS.md`, `packages/app/AGENTS.md`, `packages/desktop/AGENTS.md`, `docs/dev/testing-playbook.md`, and `docs/dev/opencode-workspace-runtime-architecture.md` before changing runtime behavior.
- When changing SolidJS files, load the repository's SolidJS-patterns skill first.
- Keep the existing per-user model database columns during the compatibility rollout. Stop reading and writing them as authority before removing them in a later cleanup migration.
- Use the real Tauri desktop app for final runtime verification; do not use a Vite or `packages/web` runtime.

### Task 1: Add the platform model-policy domain and MySQL persistence

**Files:**
- Create: `services/ai-gateway/src/model-policy/repository.ts`
- Create: `services/ai-gateway/src/model-policy/mysql-repository.ts`
- Create: `services/ai-gateway/test/mysql-model-policy-repository.test.ts`
- Create: `services/ai-gateway/drizzle/0003_platform_model_policy.sql`
- Modify: `services/ai-gateway/src/db/schema.ts`
- Modify: `services/ai-gateway/src/db/schema-reconcile.ts`
- Modify: `services/ai-gateway/test/schema.test.ts`
- Modify: `services/ai-gateway/test/schema-reconcile.test.ts`

**Step 1: Write the failing repository and schema tests**

Add tests proving that the singleton policy:

- stores multiple unique provider/model references;
- requires the active model to be present in `enabledModels`;
- round-trips provider, model, and timestamps;
- replaces the policy atomically rather than partially updating it;
- returns `null` when no platform policy has been configured.

Use this domain shape in the test:

```ts
export type PlatformModelRef = {
  provider: AiGatewayProvider;
  model: string;
};

export type PlatformModelPolicyRecord = {
  id: "platform";
  enabledModels: PlatformModelRef[];
  activeModel: PlatformModelRef;
  createdAt: Date;
  updatedAt: Date;
};
```

**Step 2: Run the focused tests and verify failure**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test \
  test/schema.test.ts \
  test/schema-reconcile.test.ts \
  test/mysql-model-policy-repository.test.ts
```

Expected: FAIL because the model-policy table and repository do not exist.

**Step 3: Add the singleton table and repository**

Add a `platform_model_policy` table with:

```sql
CREATE TABLE IF NOT EXISTS `platform_model_policy` (
  `id` varchar(32) NOT NULL PRIMARY KEY,
  `enabled_models_json` text NOT NULL,
  `active_provider` varchar(64) NOT NULL,
  `active_model` varchar(128) NOT NULL,
  `created_at` timestamp(3) NOT NULL,
  `updated_at` timestamp(3) NOT NULL
);
```

Implement:

```ts
export interface PlatformModelPolicyRepository {
  getPolicy(): Promise<PlatformModelPolicyRecord | null>;
  replacePolicy(input: {
    enabledModels: PlatformModelRef[];
    activeModel: PlatformModelRef;
  }): Promise<PlatformModelPolicyRecord>;
}
```

Normalize whitespace, deduplicate by `provider/model`, reject an empty list, and reject an active model not present in the enabled list. Do not infer a default from historical user rows.

**Step 4: Run the focused tests and typecheck**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test \
  test/schema.test.ts \
  test/schema-reconcile.test.ts \
  test/mysql-model-policy-repository.test.ts
pnpm --dir services/ai-gateway exec tsc -p tsconfig.json --noEmit
```

Expected: all focused tests pass and TypeScript exits 0.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/model-policy \
  services/ai-gateway/src/db/schema.ts \
  services/ai-gateway/src/db/schema-reconcile.ts \
  services/ai-gateway/drizzle/0003_platform_model_policy.sql \
  services/ai-gateway/test/schema.test.ts \
  services/ai-gateway/test/schema-reconcile.test.ts \
  services/ai-gateway/test/mysql-model-policy-repository.test.ts
git commit -m "feat(ai-gateway): persist platform model policy"
```

### Task 2: Expose platform-admin model-policy APIs with validation and audit

**Files:**
- Modify: `services/ai-gateway/src/runtime/default-runtime.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/test/runtime-persistence.test.ts`
- Create: `services/ai-gateway/test/admin-model-policy.test.ts`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write failing API authorization and validation tests**

Cover:

- `GET /admin/api/ai-infrastructure/model-policy` returns the current policy;
- `PUT /admin/api/ai-infrastructure/model-policy` is platform-admin-only;
- organization administrators receive 403;
- empty enabled-model lists are rejected;
- duplicate model references are normalized;
- active model must be enabled;
- a model must be discoverable from at least one healthy compatible credential before activation;
- a successful replacement records `platform.model_policy.update` in global audit;
- a failed replacement leaves the previous policy unchanged.

Expected payload:

```json
{
  "policy": {
    "enabledModels": [
      { "provider": "codex_oauth", "model": "gpt-5.5" },
      { "provider": "codex_oauth", "model": "gpt-5.4" }
    ],
    "activeModel": { "provider": "codex_oauth", "model": "gpt-5.5" },
    "updatedAt": "2026-07-12T00:00:00.000Z"
  }
}
```

**Step 2: Run the tests and verify failure**

```bash
pnpm --dir services/ai-gateway exec tsx --test \
  test/admin-model-policy.test.ts \
  test/runtime-persistence.test.ts \
  test/admin-ui.test.ts
```

Expected: FAIL because runtime state and admin routes lack a model-policy repository.

**Step 3: Wire the repository and admin service**

Add `modelPolicy: PlatformModelPolicyRepository` to `RuntimeState`. Instantiate `MySqlPlatformModelPolicyRepository` in `createDefaultRuntimeState()`.

Add these admin-service methods:

```ts
getPlatformModelPolicy(token: string): Promise<PlatformModelPolicyPayload>;
replacePlatformModelPolicy(
  token: string,
  input: ReplacePlatformModelPolicyInput,
): Promise<PlatformModelPolicyPayload>;
```

Add GET/PUT routes under `/admin/api/ai-infrastructure/model-policy`. Reuse the existing platform-admin authorization guard. Use credential model discovery to validate activation; do not accept a client claim that an unknown model is healthy.

Record an audit summary containing old and new active provider/model references, without including credential secrets.

**Step 4: Run focused tests and typecheck**

```bash
pnpm --dir services/ai-gateway exec tsx --test \
  test/admin-model-policy.test.ts \
  test/runtime-persistence.test.ts \
  test/admin-ui.test.ts
pnpm --dir services/ai-gateway exec tsc -p tsconfig.json --noEmit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/runtime/default-runtime.ts \
  services/ai-gateway/src/http/admin.ts \
  services/ai-gateway/test/runtime-persistence.test.ts \
  services/ai-gateway/test/admin-model-policy.test.ts \
  services/ai-gateway/test/admin-ui.test.ts
git commit -m "feat(ai-gateway): administer global model policy"
```

### Task 3: Make the global active model authoritative at runtime

**Files:**
- Modify: `services/ai-gateway/src/http/proxy-dependencies.ts`
- Modify: `services/ai-gateway/src/http/proxy.ts`
- Modify: `services/ai-gateway/src/http/providers/access-policy.ts`
- Modify: `services/ai-gateway/src/runtime/default-runtime.ts`
- Modify: `services/ai-gateway/src/http/readiness.ts`
- Modify: `services/ai-gateway/test/access-policy.test.ts`
- Modify: `services/ai-gateway/test/proxy-access-policy.test.ts`
- Modify: `services/ai-gateway/test/proxy.test.ts`
- Create: `services/ai-gateway/test/readiness.test.ts`

**Step 1: Write failing runtime policy tests**

Prove that:

- omitted request model becomes the platform active model;
- a client-supplied different model is rejected with `model_override_not_allowed`;
- the request route provider must equal the active model provider;
- missing global policy returns `platform_model_policy_not_configured`;
- unhealthy/no-compatible credential is reported separately from missing model policy;
- two different enabled users resolve the same model;
- readiness is not ready when no active model exists.

The policy function should become:

```ts
export function applyPlatformModelPolicy(input: {
  routeProvider: LeaseProvider;
  activeModel: PlatformModelRef;
  body: unknown;
}): PolicyResult;
```

**Step 2: Run the focused tests and verify failure**

```bash
pnpm --dir services/ai-gateway exec tsx --test \
  test/access-policy.test.ts \
  test/proxy-access-policy.test.ts \
  test/proxy.test.ts \
  test/readiness.test.ts
```

Expected: tests fail because runtime policy still reads per-user model fields.

**Step 3: Load the singleton policy before provider routing**

Add the model-policy repository to proxy dependencies. After authentication and user AI-access enablement, load the global policy and store it in request locals. Apply the platform active model in every provider route.

Use strict override behavior:

```ts
if (requestedModel && requestedModel !== activeModel.model) {
  return { ok: false, status: 403, error: "model_override_not_allowed" };
}

requestBody.model = activeModel.model;
```

Do not add automatic cross-model fallback. Credential selection may rotate only among credentials compatible with the active provider/model.

**Step 4: Update readiness**

Add a `modelPolicy` readiness check that reports `platform_model_policy_not_configured` when no active model exists. Keep credential and provider reachability checks separate so operations can distinguish configuration from upstream failure.

**Step 5: Run tests and typecheck**

```bash
pnpm --dir services/ai-gateway exec tsx --test \
  test/access-policy.test.ts \
  test/proxy-access-policy.test.ts \
  test/proxy.test.ts \
  test/readiness.test.ts
pnpm --dir services/ai-gateway exec tsc -p tsconfig.json --noEmit
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/ai-gateway/src/http \
  services/ai-gateway/src/runtime/default-runtime.ts \
  services/ai-gateway/test/access-policy.test.ts \
  services/ai-gateway/test/proxy-access-policy.test.ts \
  services/ai-gateway/test/proxy.test.ts \
  services/ai-gateway/test/readiness.test.ts
git commit -m "feat(ai-gateway): enforce the platform active model"
```

### Task 4: Remove model authority from user AI-access records

**Files:**
- Modify: `services/ai-gateway/src/access/repository.ts`
- Modify: `services/ai-gateway/src/access/mysql-repository.ts`
- Modify: `services/ai-gateway/src/access/auto-assignment-rotation.ts`
- Modify: `services/ai-gateway/src/http/user-credentials.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/test/mysql-ai-access-repository.test.ts`
- Modify: `services/ai-gateway/test/auto-assignment-rotation.test.ts`
- Modify: `services/ai-gateway/test/user-credentials.test.ts`
- Modify: `services/ai-gateway/test/admin-user-access.test.ts`

**Step 1: Write failing user-policy contract tests**

Change expected user policy to:

```ts
export type UserAiAccessPolicyRecord = {
  id: string;
  userId: string;
  enabled: boolean;
  provider: AiAccessProvider | null;
  credentialId: string | null;
  assignmentOrigin: AiAccessAssignmentOrigin;
  createdAt: Date;
  updatedAt: Date;
};
```

Prove that:

- user admin writes reject or ignore no model fields; the preferred behavior is 400 `user_model_policy_not_supported` when legacy clients send them;
- a credential assignment must be compatible with the active model provider;
- credential rotation preserves access and credential origin without copying model fields;
- `/api/me/ai-access` returns one read-only `effectiveModel` composed from the global policy;
- historical `default_model` and `allowed_models_json` columns are not read as authority.

**Step 2: Run tests and verify failure**

```bash
pnpm --dir services/ai-gateway exec tsx --test \
  test/mysql-ai-access-repository.test.ts \
  test/auto-assignment-rotation.test.ts \
  test/user-credentials.test.ts \
  test/admin-user-access.test.ts
```

Expected: FAIL because models still belong to user records.

**Step 3: Simplify the repository and compose effective access**

Stop setting `default_model` and `allowed_models_json` on new user updates. Leave the columns in place for rollback/history, but exclude them from domain types and runtime decisions.

Return this user-facing shape:

```json
{
  "aiAccess": {
    "enabled": true,
    "provider": "codex_oauth",
    "credentialId": "credential-id",
    "effectiveModel": {
      "provider": "codex_oauth",
      "model": "gpt-5.5"
    }
  }
}
```

Keep credential assignment and rotation because they manage capacity/authentication. Constrain assignments to the active model provider.

**Step 4: Run tests and typecheck**

```bash
pnpm --dir services/ai-gateway exec tsx --test \
  test/mysql-ai-access-repository.test.ts \
  test/auto-assignment-rotation.test.ts \
  test/user-credentials.test.ts \
  test/admin-user-access.test.ts
pnpm --dir services/ai-gateway exec tsc -p tsconfig.json --noEmit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/access \
  services/ai-gateway/src/http/user-credentials.ts \
  services/ai-gateway/src/http/admin.ts \
  services/ai-gateway/test/mysql-ai-access-repository.test.ts \
  services/ai-gateway/test/auto-assignment-rotation.test.ts \
  services/ai-gateway/test/user-credentials.test.ts \
  services/ai-gateway/test/admin-user-access.test.ts
git commit -m "refactor(ai-gateway): remove per-user model policy"
```

### Task 5: Add AI Infrastructure model controls and remove model fields from Users

**Files:**
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/app.css`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write failing static UI contract tests**

Require:

- an AI Infrastructure page or section with enabled-model list and active-model control;
- model choices loaded from credential-backed model discovery;
- a Save action calling the model-policy PUT endpoint;
- no Default model or Allowed models controls in the user dialog;
- user AI access still supports enabled state and compatible assigned credential;
- no user-facing model switch language;
- platform administrators only can mutate the global policy.

**Step 2: Run the UI tests and verify failure**

```bash
pnpm --dir services/ai-gateway exec tsx --test test/admin-ui.test.ts
```

Expected: FAIL because model inputs remain inside the user editor.

**Step 3: Build the infrastructure model editor**

Add state shaped like:

```js
modelPolicy: {
  enabledModels: [],
  activeModel: null,
  dirty: false,
  saving: false,
}
```

The UI must:

- show all configured models and their provider;
- mark exactly one model Active;
- prevent disabling the active row;
- require explicit Save;
- show backend validation errors without discarding the prior saved policy;
- remove the user editor's model datalist and allowed-model textarea.

**Step 4: Run UI tests**

```bash
pnpm --dir services/ai-gateway exec tsx --test test/admin-ui.test.ts test/admin-model-policy.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/public-admin \
  services/ai-gateway/test/admin-ui.test.ts \
  services/ai-gateway/test/admin-model-policy.test.ts
git commit -m "feat(admin): manage platform models in AI infrastructure"
```

### Task 6: Split platform navigation from the organization workspace

**Files:**
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/app.css`
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`
- Modify: `services/ai-gateway/test/admin-actions.test.ts`

**Step 1: Write failing navigation and scoping tests**

Cover these routes:

```text
/admin
/admin/organizations
/admin/ai-infrastructure
/admin/platform-users
/admin/audit
/admin/organizations/:orgId/overview
/admin/organizations/:orgId/members
/admin/organizations/:orgId/domains-invites
/admin/organizations/:orgId/billing
/admin/organizations/:orgId/ai-access
/admin/organizations/:orgId/audit
```

Prove that:

- global pages contain no active-organization selector;
- organization pages always render `Operating organization: <name>`;
- the organization selector exists only in organization workspace markup;
- switching organization preserves the current organization subpage;
- organization administrators cannot navigate outside organizations they administer;
- platform routes do not append or reuse stale organization query parameters.

**Step 2: Run focused tests and verify failure**

```bash
pnpm --dir services/ai-gateway exec tsx --test \
  test/admin-ui.test.ts \
  test/admin-actions.test.ts
```

Expected: FAIL because the current portal is flat and the selector is global.

**Step 3: Implement explicit route parsing and navigation groups**

Replace the flat `DEFAULT_PAGES` approach with a route descriptor:

```js
{
  area: "platform" | "organization",
  page: string,
  organizationId: string | null,
}
```

Global navigation must not read `currentOrganizationId()`. Organization data loaders must require the organization id from the route descriptor rather than falling back to a globally selected value.

**Step 4: Run tests**

```bash
pnpm --dir services/ai-gateway exec tsx --test \
  test/admin-ui.test.ts \
  test/admin-actions.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/ai-gateway/public-admin \
  services/ai-gateway/src/http/admin.ts \
  services/ai-gateway/test/admin-ui.test.ts \
  services/ai-gateway/test/admin-actions.test.ts
git commit -m "feat(admin): separate platform and organization workspaces"
```

### Task 7: Add organization billing and scoped audit facades to the canonical portal

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/src/audit/repository.ts`
- Modify: `services/ai-gateway/src/audit/mysql-repository.ts`
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Create: `services/ai-gateway/test/admin-organization-billing.test.ts`
- Modify: `services/ai-gateway/test/admin-actions.test.ts`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write failing facade and authorization tests**

Prove that AI Gateway forwards DEN-backed billing operations without duplicating billing logic:

```text
GET   /admin/api/organizations/:orgId/billing
POST  /admin/api/organizations/:orgId/billing/checkout
POST  /admin/api/organizations/:orgId/billing/portal
PATCH /admin/api/organizations/:orgId/billing/plan
POST  /admin/api/organizations/:orgId/billing/cancel
PATCH /admin/api/organizations/:orgId/billing/platform
```

Also prove organization audit is filtered server-side by organization id and authorized against the DEN admin session. Do not fetch global audit and filter it only in the browser.

**Step 2: Run focused tests and verify failure**

```bash
pnpm --dir services/ai-gateway exec tsx --test \
  test/admin-organization-billing.test.ts \
  test/admin-actions.test.ts \
  test/admin-ui.test.ts
```

Expected: FAIL because the canonical AI Gateway facade lacks billing routes and scoped audit.

**Step 3: Extend the DEN admin client and facade routes**

Forward the existing DEN billing API payloads and status codes. Preserve DEN as entitlement authority. Do not copy Stripe secrets or billing calculations into AI Gateway.

Extend audit repository listing with an optional organization filter backed by stored organization context. If current AI Gateway audit records lack organization id, add that context to new relevant events and show a clear empty/partial-history state for legacy events rather than guessing.

**Step 4: Render organization billing and audit pages**

Use the route's organization id for every request. Platform-only manual billing controls must remain hidden and rejected for organization administrators.

**Step 5: Run tests and typecheck**

```bash
pnpm --dir services/ai-gateway exec tsx --test \
  test/admin-organization-billing.test.ts \
  test/admin-actions.test.ts \
  test/admin-ui.test.ts
pnpm --dir services/ai-gateway exec tsc -p tsconfig.json --noEmit
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/ai-gateway/src/http/admin.ts \
  services/ai-gateway/src/audit \
  services/ai-gateway/public-admin \
  services/ai-gateway/test/admin-organization-billing.test.ts \
  services/ai-gateway/test/admin-actions.test.ts \
  services/ai-gateway/test/admin-ui.test.ts
git commit -m "feat(admin): add organization billing workspace"
```

### Task 8: Update the desktop Managed-AI contract without adding a model picker

**Files:**
- Modify: `packages/app/src/app/lib/ai-access.ts`
- Modify: `packages/app/src/app/context/managed-ai-access-store.ts`
- Modify: `packages/app/src/app/context/managed-ai-runtime-config.ts`
- Modify: `packages/app/src/app/app-view-props.ts`
- Modify: `packages/app/src/app/pages/settings.tsx`
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/app/tests/lib/ai-access.test.ts`
- Modify: `packages/app/src/app/tests/context/managed-ai-access-store.test.ts`
- Modify: `packages/app/src/app/tests/context/managed-ai-runtime-config.test.ts`
- Modify: `packages/app/src/app/tests/app-overlay-i18n.test.ts`

**Step 1: Write failing desktop contract tests**

Prove that:

- `effectiveModel` from AI Gateway becomes the internal Managed-AI runtime model;
- no allowed-model list is presented as a user preference;
- settings show only that AI configuration is platform-managed;
- no installed-app control can change the Managed-AI model;
- local/BYOK model behavior remains unchanged and is not accidentally removed.

**Step 2: Run focused tests and verify failure**

```bash
pnpm --dir packages/app exec node --test --import=tsx/esm \
  src/app/tests/lib/ai-access.test.ts \
  src/app/tests/context/managed-ai-access-store.test.ts \
  src/app/tests/context/managed-ai-runtime-config.test.ts
```

Expected: FAIL because the app still expects `defaultModel` plus `allowedModels` from user access.

**Step 3: Adapt the runtime profile**

Map the gateway's read-only effective model to the internal OpenCode configuration. It is acceptable for internal generated config to contain a single model entry; it must not become editable user state.

Remove the allowed-model summary from Settings and replace it with concise administrator-managed copy. Preserve local provider model controls outside Managed AI.

**Step 4: Run package tests and typecheck**

```bash
pnpm typecheck
pnpm --filter @neatech/veslo-ui test:unit
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app \
  packages/app/src/i18n/locales/en.ts \
  packages/app/src/i18n/locales/cs.ts
git commit -m "refactor(app): consume the platform managed model"
```

### Task 9: Add rollout-safe migration and compatibility coverage

**Files:**
- Modify: `services/den/src/managed-ai/access/repository.ts`
- Modify: `services/den/src/managed-ai/access/mysql-repository.ts`
- Modify: `services/den/src/managed-ai/signup-assignment.ts`
- Modify: `services/den/src/managed-ai/http/user-credentials.ts`
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Modify: `services/den/test/managed-ai-signup-assignment.test.ts`
- Modify: `services/den/test/managed-ai-user-access.test.ts`
- Create: `services/ai-gateway/test/model-policy-migration.test.ts`

**Step 1: Write failing compatibility tests**

Cover:

- legacy per-user model values do not override the global active model;
- DEN signup no longer hardcodes a per-user model;
- signup still assigns eligible credentials when the active provider supports that flow;
- missing platform policy blocks inference but does not break account creation;
- a deployment can configure the global policy before enabling global runtime enforcement;
- rollback retains historical columns without making them authoritative during the new path.

**Step 2: Run tests and verify failure**

```bash
pnpm --dir services/den exec tsx --test \
  test/managed-ai-signup-assignment.test.ts \
  test/managed-ai-user-access.test.ts
pnpm --dir services/ai-gateway exec tsx --test test/model-policy-migration.test.ts
```

Expected: FAIL because DEN still writes per-user model values.

**Step 3: Remove DEN-side model writes and define rollout order**

Keep DEN identity, entitlement, and signup responsibilities. Stop assigning default/allowed models in DEN user policy. Where legacy DEN managed-AI endpoints must remain temporarily, return the gateway effective model as read-only compatibility data or fail explicitly when no gateway policy is available; do not create a second model-policy authority.

Document deployment order in the migration test comments and canonical docs:

1. deploy schema/repository/API support;
2. configure and verify the platform policy;
3. deploy runtime enforcement and simplified user contracts;
4. remove obsolete UI controls;
5. drop legacy columns only in a later separately approved cleanup.

**Step 4: Rebuild DEN and run tests**

```bash
pnpm --dir services/den exec tsx --test \
  test/managed-ai-signup-assignment.test.ts \
  test/managed-ai-user-access.test.ts
pnpm --dir services/den exec tsc -p tsconfig.json --noEmit
pnpm --dir services/ai-gateway exec tsx --test test/model-policy-migration.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/managed-ai \
  services/den/test/managed-ai-signup-assignment.test.ts \
  services/den/test/managed-ai-user-access.test.ts \
  services/ai-gateway/test/model-policy-migration.test.ts
git commit -m "refactor(den): stop assigning per-user models"
```

### Task 10: Update canonical documentation

**Files:**
- Modify: `docs/admin-managed-ai-access.md`
- Modify: `docs/features/session-runtime.md`
- Modify: `docs/features/organization-billing.md`
- Modify: `docs/dev/cloud-deployments.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/dev/app-map.md`
- Modify: `docs/INDEX.md`

**Step 1: Add a documentation contract check if an existing one covers these files**

Update current source-contract tests that assert per-user default/allowed model semantics. The new documentation must state:

- AI Gateway owns the global model policy;
- multiple backend models may be configured;
- exactly one active model serves all managed users;
- users cannot choose or override Managed-AI models;
- billing entitlement and user enablement are evaluated before model resolution;
- credential rotation is separate from model selection;
- organization context exists only inside the organization workspace.

**Step 2: Update the canonical docs**

Remove claims that platform administrators set default or allowed models per user. Keep historical plan documents unchanged.

**Step 3: Run documentation/source contract tests and diff checks**

```bash
git diff --check
pnpm --dir services/ai-gateway exec tsx --test test/admin-ui.test.ts test/admin-user-access.test.ts
pnpm typecheck
```

Expected: PASS.

**Step 4: Commit**

```bash
git add docs/admin-managed-ai-access.md \
  docs/features/session-runtime.md \
  docs/features/organization-billing.md \
  docs/dev/cloud-deployments.md \
  docs/dev/state-and-config-reference.md \
  docs/dev/app-map.md \
  docs/INDEX.md
git commit -m "docs: document global managed AI model policy"
```

### Task 11: Add real desktop E2E proof and run the final verification gate

**Files:**
- Create: `packages/e2e/pilot-scenarios/global-managed-ai-model-policy.toml`
- Modify: `packages/e2e/helpers/pilot-runner.ts`
- Modify: `packages/e2e/helpers/pilot-runner.test.ts`
- Modify: `packages/e2e/package.json`
- Modify: `docs/dev/testing-playbook.md`

**Step 1: Write failing Pilot-runner selection tests**

Require the new scenario to be selectable by name and to run only after the Veslo desktop preflight. The scenario must use a controlled gateway fixture or dedicated test policy that has two enabled models and one active model.

**Step 2: Write the Pilot scenario**

The real Tauri scenario must prove:

1. Managed AI becomes ready with two configured backend models.
2. The installed app exposes no Managed-AI model picker or `Change model` action.
3. A user sends a prompt through the actual desktop runtime.
4. The captured gateway request uses the active model.
5. A client-side attempt to request the non-active model is rejected by the gateway.
6. A second user/access fixture resolves the same active model.

**Step 3: Run helper tests**

```bash
pnpm --dir packages/e2e exec node --import=tsx/esm --test helpers/pilot-runner.test.ts
```

Expected: PASS.

**Step 4: Run service gates**

```bash
pnpm --dir services/ai-gateway test
pnpm --dir services/ai-gateway build
pnpm --dir services/den exec tsc -p tsconfig.json --noEmit
pnpm typecheck
```

Expected: PASS. If the local dependency tree contains a platform-mismatched `esbuild`, repair the workspace installation before classifying any test as a product failure.

**Step 5: Run desktop preflight and Tauri Pilot**

Follow the exact process cleanup and fresh-build procedure in `docs/dev/testing-playbook.md`, then run:

```bash
pnpm --filter @neatech/veslo-e2e test:pilot -- --scenario global-managed-ai-model-policy
```

Expected: PASS against the real Tauri desktop app.

**Step 6: Run final repository checks**

```bash
git diff --check
git status --short
git log --oneline --decorate -12
```

Expected: no unstaged implementation changes, no generated secrets, and only intentional commits from this plan.

**Step 7: Commit the E2E and workflow documentation**

```bash
git add packages/e2e/pilot-scenarios/global-managed-ai-model-policy.toml \
  packages/e2e/helpers/pilot-runner.ts \
  packages/e2e/helpers/pilot-runner.test.ts \
  packages/e2e/package.json \
  docs/dev/testing-playbook.md
git commit -m "test(e2e): prove the global managed AI model"
```

## Completion Criteria

- The canonical admin clearly separates platform pages from organization workspaces.
- Organization selection appears only inside an organization workspace.
- AI Infrastructure stores multiple backend models and exactly one active model.
- User AI-access administration contains no model controls or model persistence.
- Managed-AI clients cannot switch or override the platform active model.
- Credential rotation remains possible without changing the active model.
- Billing entitlement and user-access checks happen before model resolution.
- Canonical docs describe the new authority boundaries.
- Focused service tests, TypeScript checks, and the real Tauri Pilot scenario pass.
