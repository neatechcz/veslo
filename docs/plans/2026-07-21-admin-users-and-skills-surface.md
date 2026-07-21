# Admin Users and Skills Surface Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add organization and platform skill governance to the existing web Admin UI while preserving the real administrator identity, explicit organization scope, and the desktop app's role as the local skill workbench.

**Architecture:** Den remains the source of truth for users, organizations, roles, skill registry state, approvals, installations, rollouts, and audit. The existing AI Gateway Admin UI adds one shared skills workspace rendered in organization or platform scope and calls Den through authenticated server-side admin facades. The desktop app only submits publish requests, shows effective managed state, and deep-links authorized administrators into the web UI.

**Tech Stack:** TypeScript, Express, Drizzle/MySQL, Node test runner, vanilla JavaScript Admin SPA, Playwright, SolidJS, Tauri Pilot, pnpm.

---

## Guardrails

- Follow `AGENTS.md`, `docs/dev/testing-playbook.md`, and `docs/dev/engineering-quality-gates.md`.
- Use the Tauri desktop runtime for desktop verification; never use raw Vite as runtime proof.
- Prefer the browser E2E path for Admin UI behavior. Add unit/contract tests only to support the primary E2E path.
- Keep organization and platform routes separate. A platform route must never retain an organization id.
- A platform administrator may run organization-admin operations only through an explicit organization route.
- Never mint an organization-admin session or replace the real actor identity.
- The audit event must contain the real actor user id, target organization id, and authority source.
- Do not implement a second complete admin UI in the desktop app.
- Do not deploy production as part of implementation. Production deployment remains a separately authorized manual workflow.

## Task 1: Write the browser-level governance acceptance test

**Files:**

- Modify: `packages/e2e/specs/ai-gateway-admin-data-isolation.playwright.spec.ts`
- Modify: `packages/e2e/package.json`

**Step 1: Add registry fixtures to the existing Admin UI harness**

Add two organizations, one organization skill per organization, one platform
skill, pending review requests, rollout policies, and installations. Use unique
markers such as `ORG-A-SKILL-PRIVATE`, `ORG-B-SKILL-PRIVATE`, and
`PLATFORM-SKILL-VISIBLE` so the existing stale-frame observer can detect leaks.

The harness must recognize these future requests:

```text
GET /admin/api/organizations/org-a/skills
GET /admin/api/organizations/org-a/skill-review-requests
GET /admin/api/organizations/org-a/skill-rollout-policies
GET /admin/api/organizations/org-a/skill-installations
GET /admin/api/platform-skills
GET /admin/api/platform-skill-review-requests
GET /admin/api/platform-skill-rollout-policies
GET /admin/api/platform-skill-installations
```

**Step 2: Add failing organization-admin scenarios**

Add a `test.describe("Admin skills governance", ...)` block that proves:

```ts
test("organization admin loads only the routed organization skills", async ({ page }) => {
  await openAdmin(page, "/admin/organizations/org-a/skills");
  await waitForPageReady(page);
  await expect(page.locator("#admin-skills-catalog")).toContainText("ORG-A-SKILL-PRIVATE");
  await expect(page.locator("body")).not.toContainText("ORG-B-SKILL-PRIVATE");
  await expect(page.locator("body")).not.toContainText("PLATFORM-SKILL-VISIBLE");
});
```

Also assert that the organization administrator cannot navigate to or open
`/admin/platform-skills`.

**Step 3: Add failing platform-admin organization parity scenarios**

Open `/admin/organizations/org-a/skills` with a platform-admin session. Assert
that the same organization actions are visible and that the header contains a
stable `Managing organization` indicator. Submit an approval and assert the
request path contains `org-a`, while the request body contains no caller-chosen
organization override.

**Step 4: Add failing platform-skill scenarios**

Open `/admin/platform-skills`, assert that only platform records render, and
exercise one system review approval and one rollout update.

**Step 5: Add failing organization-switch isolation scenario**

Delay all four `org-b` skill requests, switch from `org-a` to `org-b`, and arm
the existing leak observer for every org-a skill marker. Assert that catalog,
review, rollout, installation, dialog, visible text, and accessible labels are
cleared synchronously and no delayed org-a response can return.

**Step 6: Add a focused script**

Add:

```json
"test:admin-skills-governance": "playwright test ./specs/ai-gateway-admin-data-isolation.playwright.spec.ts --grep 'Admin skills governance' --output=/tmp/veslo-admin-skills-governance-results"
```

**Step 7: Run the E2E test and verify it fails for missing routes/UI**

Run:

```bash
pnpm --filter @neatech/veslo-e2e test:admin-skills-governance
```

Expected: FAIL because the new routes, navigation, and skill page do not exist.

**Step 8: Commit the red acceptance test**

```bash
git add packages/e2e/specs/ai-gateway-admin-data-isolation.playwright.spec.ts packages/e2e/package.json
git commit -m "test: define admin skill governance flow"
```

## Task 2: Add Den administration read models and explicit audit authority

**Files:**

- Modify: `services/den/src/skills/store.ts`
- Modify: `services/den/src/skills/db-store.ts`
- Modify: `services/den/src/skills/routes.ts`
- Modify: `services/den/test/skill-registry-routes.test.ts`
- Modify: `services/den/test/skill-registry-schema.test.ts`

**Step 1: Write failing tests for review-request listing**

Cover `GET /v1/skill-review-requests` with filters for `scope`, `orgId`,
`status`, `skillId`, and pagination. Assert that:

- an organization administrator sees only requests for the selected org;
- a platform administrator in organization context sees the same org result;
- only a platform administrator can request `scope=system` without org context;
- ordinary members cannot list the organization review queue.

Use this response contract:

```ts
export type RegistrySkillReviewRequest = {
  requestId: string;
  scope: "org" | "system";
  orgId: string | null;
  skillId: string;
  versionId: string;
  status: "pending_review" | "approved" | "rejected";
  requestedByUserId: string;
  reason: string | null;
  reviewerNote: string | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  releaseChannel: string | null;
  createdAt: string;
  updatedAt: string;
};
```

**Step 2: Write failing tests for installation listing**

Cover `GET /v1/skill-installations` with `orgId`, `skillId`, `scope`, `status`,
and pagination filters. Return enough target information for administration:

```ts
export type RegistrySkillInstallationDetail = {
  installationId: string;
  scope: "user" | "org" | "workspace" | "system";
  orgId: string | null;
  ownerUserId: string | null;
  workspaceId: string | null;
  skillId: string;
  versionId: string | null;
  enabled: boolean;
  updatePolicy: "pinned" | "latest_user" | "latest_approved" | "release_channel";
  releaseChannel: string | null;
  status: "active" | "disabled" | "deleted";
  installedAt: string;
  updatedAt: string;
};
```

Assert that organization reads cannot expose another organization or personal
installations outside the selected org.

**Step 3: Write failing audit tests**

Extend `SkillRegistryRouteContext` with:

```ts
authority: "member" | "organization_admin" | "platform_admin" | "system";
```

Assert that request creation, approval, rejection, installation mutation, and
rollout mutation events contain:

```json
{
  "authority": "platform_admin"
}
```

inside the existing JSON payload when performed by a platform administrator.
Assert that `actorUserId` remains the real administrator and `orgId` remains the
selected organization.

**Step 4: Run the focused Den tests and verify they fail**

```bash
pnpm --filter @neatech/den exec tsx --test test/skill-registry-routes.test.ts test/skill-registry-schema.test.ts
```

Expected: FAIL because list methods, routes, and authority metadata are absent.

**Step 5: Implement the store contracts in memory and DB stores**

Add to `SkillRegistryStore`:

```ts
listReviewRequests(
  context: SkillRegistryRouteContext,
  filters?: Record<string, unknown>,
): Promise<{ reviewRequests: RegistrySkillReviewRequest[]; nextCursor: string | null }>;

listInstallations(
  context: SkillRegistryRouteContext,
  filters?: Record<string, unknown>,
): Promise<{ installations: RegistrySkillInstallationDetail[]; nextCursor: string | null }>;
```

Implement identical filtering, authorization, serialization, cursor ordering,
and tenant isolation in both stores. DB queries must apply org/system predicates
before pagination rather than filtering a global result in memory.

**Step 6: Add the read routes**

Register before parameterized skill routes:

```ts
router.get("/skill-review-requests", ...);
router.get("/skill-installations", ...);
```

Derive `authority` in `defaultResolveContext`. The platform bootstrap context
uses `system`; normal organization owners/admins use `organization_admin`.

**Step 7: Complete governance audit events**

Record `skill.review_requested` and `skill.version.rejected` in addition to the
existing approval and rollout/installation events. Make `recordEvent` merge the
authority into every payload without allowing caller payloads to overwrite it:

```ts
payload: {
  ...(isRecord(input.payload) ? input.payload : {}),
  authority: context.authority,
}
```

No schema migration is needed because the authority is stored in the existing
JSON audit payload.

**Step 8: Run tests and typecheck**

```bash
pnpm --filter @neatech/den exec tsx --test test/skill-registry-routes.test.ts test/skill-registry-schema.test.ts test/core-platform-skill-bootstrap.test.ts
pnpm --filter @neatech/den typecheck
```

Expected: PASS.

**Step 9: Commit**

```bash
git add services/den/src/skills/store.ts services/den/src/skills/db-store.ts services/den/src/skills/routes.ts services/den/test/skill-registry-routes.test.ts services/den/test/skill-registry-schema.test.ts
git commit -m "feat(den): expose skill governance read models"
```

## Task 3: Add the authenticated Admin UI skill facade

**Files:**

- Create: `services/ai-gateway/src/http/admin-skills.ts`
- Create: `services/ai-gateway/test/admin-skills.test.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`

**Step 1: Write failing facade authorization tests**

Create a dedicated test that starts the Admin router with a fake Den skill
client. Prove:

- organization admins can call only their routed organization;
- platform admins can call any explicit organization without membership;
- organization admins cannot call platform-skill routes;
- forwarded organization requests use the path org id in both Den header and
  forced body fields;
- caller-supplied `orgId`, `scope`, or `catalogScope` cannot escape the route;
- the real Den bearer token is forwarded server-side and never returned.

**Step 2: Define a narrow Den skill client**

In `admin-skills.ts`, define methods for:

```ts
type AdminSkillRegistryClient = {
  listSkills(token: string, scope: AdminSkillScope, query: URLSearchParams): Promise<unknown>;
  listReviewRequests(token: string, scope: AdminSkillScope, query: URLSearchParams): Promise<unknown>;
  approveReviewRequest(token: string, scope: AdminSkillScope, requestId: string, body: unknown): Promise<unknown>;
  rejectReviewRequest(token: string, scope: AdminSkillScope, requestId: string, body: unknown): Promise<unknown>;
  listRolloutPolicies(token: string, scope: AdminSkillScope, query: URLSearchParams): Promise<unknown>;
  createRolloutPolicy(token: string, scope: AdminSkillScope, body: unknown): Promise<unknown>;
  updateRolloutPolicy(token: string, scope: AdminSkillScope, policyId: string, body: unknown): Promise<unknown>;
  deleteRolloutPolicy(token: string, scope: AdminSkillScope, policyId: string): Promise<unknown>;
  listInstallations(token: string, scope: AdminSkillScope, query: URLSearchParams): Promise<unknown>;
  createInstallation(token: string, scope: AdminSkillScope, body: unknown): Promise<unknown>;
  updateInstallation(token: string, scope: AdminSkillScope, installationId: string, body: unknown): Promise<unknown>;
  deleteInstallation(token: string, scope: AdminSkillScope, installationId: string): Promise<unknown>;
  restoreInstallation(token: string, scope: AdminSkillScope, installationId: string, body: unknown): Promise<unknown>;
  listVersions(token: string, scope: AdminSkillScope, skillId: string): Promise<unknown>;
  getPackage(token: string, scope: AdminSkillScope, versionId: string): Promise<unknown>;
};
```

Use:

```ts
type AdminSkillScope =
  | { kind: "organization"; organizationId: string }
  | { kind: "platform" };
```

**Step 3: Register organization routes**

Add server-side routes under:

```text
/admin/api/organizations/:orgId/skills
/admin/api/organizations/:orgId/skill-review-requests
/admin/api/organizations/:orgId/skill-review-requests/:requestId/approve
/admin/api/organizations/:orgId/skill-review-requests/:requestId/reject
/admin/api/organizations/:orgId/skill-rollout-policies
/admin/api/organizations/:orgId/skill-rollout-policies/:policyId
/admin/api/organizations/:orgId/skill-installations
/admin/api/organizations/:orgId/skill-installations/:installationId
/admin/api/organizations/:orgId/skill-installations/:installationId/restore
/admin/api/organizations/:orgId/skills/:skillId/versions
/admin/api/organizations/:orgId/skill-versions/:versionId/package
```

Each route must first use the same organization access check already used by
Members, then call the shared organization facade.

**Step 4: Register platform routes**

Add matching routes under `/admin/api/platform-*`. Require
`session.platformAdmin === true` before forwarding. Force `scope=system` for
skill records and installations, `scope=system` for review requests, and
`catalogScope=platform` for rollout policies.

**Step 5: Preserve Den errors safely**

Forward status and validated JSON error codes. Do not forward raw HTML,
credentials, headers, or unbounded upstream bodies.

**Step 6: Run focused tests**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-skills.test.ts test/admin-ui.test.ts
pnpm --filter @neatech/ai-gateway typecheck
```

Expected: PASS.

**Step 7: Commit**

```bash
git add services/ai-gateway/src/http/admin-skills.ts services/ai-gateway/src/http/admin.ts services/ai-gateway/test/admin-skills.test.ts
git commit -m "feat(ai-gateway): proxy scoped skill administration"
```

## Task 4: Add skill capabilities, canonical routes, and shared page state

**Files:**

- Modify: `services/den/src/http/admin.ts`
- Modify: `services/den/test/admin-contract.test.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/public-admin/admin-route-state.js`
- Modify: `services/ai-gateway/public-admin/admin-page-load-state.js`
- Create: `services/ai-gateway/public-admin/admin-skills-state.js`
- Modify: `services/ai-gateway/test/admin-route-state.test.ts`
- Modify: `services/ai-gateway/test/admin-page-load-state.test.ts`
- Create: `services/ai-gateway/test/admin-skills-state.test.ts`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write failing capability tests**

Append `skills` to each service's existing organization-admin capability and
allowed-page sets. Append `platformSkills` only to the platform sets. Preserve
service-specific existing capabilities such as Den billing rather than forcing
the two arrays to become otherwise identical. Require this structural
relationship in both services:

```ts
OrganizationAdminCapabilities = [
  ...existingOrganizationAdminCapabilities,
  "skills",
];
PlatformAdminCapabilities = [
  ...OrganizationAdminCapabilities,
  "platformSkills",
  // existing platform capabilities
];
```

Mirror the change in both Den and AI Gateway contracts. This spread is the
structural enforcement that platform admins always inherit organization skill
administration.

**Step 2: Write failing route-state tests**

Add canonical descriptors:

```ts
["/admin/platform-skills", { area: "platform", page: "platform-skills", organizationId: null }]
["/admin/organizations/org_1/skills", { area: "organization", page: "skills", organizationId: "org_1" }]
```

Assert that organization switching preserves the `skills` subpage, platform
routes reject organization ids, and organization admins cannot access
`platform-skills`.

**Step 3: Write failing shared-state tests**

Create `admin-skills-state.js` with pure helpers:

```js
export function skillAdminScopeForRoute(route) {
  if (route?.area === "platform" && route.page === "platform-skills") {
    return { kind: "platform" };
  }
  if (route?.area === "organization" && route.page === "skills" && route.organizationId) {
    return { kind: "organization", organizationId: route.organizationId };
  }
  return null;
}

export function createAdminSkillsState() {
  return {
    tab: "catalog",
    skills: [],
    reviewRequests: [],
    rolloutPolicies: [],
    installations: [],
    selectedSkillId: null,
    selectedReviewRequestId: null,
    mutationStatus: "",
  };
}
```

Add helpers that build facade paths from the canonical scope and reject any
unqualified or mismatched route.

**Step 4: Implement route and capability changes**

Update `PLATFORM_PAGES`, `ORGANIZATION_PAGES`, route parsing/formatting, shell
path authorization, asset allow-list, and the fallback navigation HTML. Serve
`admin-skills-state.js` as a static Admin asset.

**Step 5: Run tests**

```bash
pnpm --filter @neatech/den exec tsx --test test/admin-contract.test.ts
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-route-state.test.ts test/admin-page-load-state.test.ts test/admin-skills-state.test.ts test/admin-ui.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/http/admin.ts services/den/test/admin-contract.test.ts services/ai-gateway/src/http/admin.ts services/ai-gateway/public-admin/admin-route-state.js services/ai-gateway/public-admin/admin-page-load-state.js services/ai-gateway/public-admin/admin-skills-state.js services/ai-gateway/test/admin-route-state.test.ts services/ai-gateway/test/admin-page-load-state.test.ts services/ai-gateway/test/admin-skills-state.test.ts services/ai-gateway/test/admin-ui.test.ts
git commit -m "feat(admin): add scoped skill administration routes"
```

## Task 5: Render the organization and platform skill workspaces

**Files:**

- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/app.css`
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write failing source and HTTP shell tests**

Assert that both protected and fallback shells contain:

```html
<a href="/admin/platform-skills" data-platform-route="platform-skills">Platform Skills</a>
<a data-organization-route="skills">Skills</a>
```

Organization-admin shells must not contain the platform link. Platform-admin
organization pages must contain a visible `Managing organization` indicator.

**Step 2: Add one shared Skills page skeleton**

Add a single page region used by both route scopes. Include:

- page heading and explicit scope label;
- tabs with stable ids for Catalog, Review requests, Rollouts, Installations;
- empty containers with no sample data;
- one shared detail dialog root;
- mutation status live region.

Do not create separate organization and platform DOM implementations.

**Step 3: Add route-owned data loading**

When the current route is a skills route, clear every skill collection and
dialog synchronously, then request the four facade collections in parallel.
Commit results only if both the route key and page generation still match.

Use the existing page-load contract:

```js
const [skills, reviewRequests, rolloutPolicies, installations] = await Promise.all([
  fetchJson(scopePaths.skills, { signal }),
  fetchJson(scopePaths.reviewRequests, { signal }),
  fetchJson(scopePaths.rolloutPolicies, { signal }),
  fetchJson(scopePaths.installations, { signal }),
]);
```

**Step 4: Render read-only tables and evidence**

Catalog rows show scope, review status, latest version, and updated time. Review
rows show requester, reason, version, status, resolution, and reviewer note.
Rollout rows show target, audience, update policy, removal policy, and enabled
state. Installation rows show target identity, version, policy, status, and
restore availability.

All labels and action attributes must avoid stale or hidden organization data.

**Step 5: Run focused Admin tests**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts test/admin-route-state.test.ts test/admin-page-load-state.test.ts test/admin-skills-state.test.ts
```

Expected: PASS.

**Step 6: Run the acceptance test**

```bash
pnpm --filter @neatech/veslo-e2e test:admin-skills-governance
```

Expected: the read and isolation scenarios pass; mutation scenarios may still
fail until Task 6.

**Step 7: Commit**

```bash
git add services/ai-gateway/public-admin/index.html services/ai-gateway/public-admin/app.js services/ai-gateway/public-admin/app.css services/ai-gateway/src/http/admin.ts services/ai-gateway/test/admin-ui.test.ts
git commit -m "feat(admin): render organization and platform skills"
```

## Task 6: Wire review, rollout, and installation mutations

**Files:**

- Modify: `services/ai-gateway/public-admin/admin-skills-state.js`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.css`
- Modify: `services/ai-gateway/test/admin-skills-state.test.ts`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`
- Modify: `services/ai-gateway/test/admin-skills.test.ts`
- Modify: `packages/e2e/specs/ai-gateway-admin-data-isolation.playwright.spec.ts`

**Step 1: Write failing mutation-state tests**

Add pure builders that derive every path and forced scope from
`skillAdminScopeForRoute`. They must return `null` for invalid routes and must
never accept organization id or catalog scope from form data.

Cover these actions:

- approve/reject review request;
- create/update/disable rollout policy;
- create/update/delete/restore installation;
- open version history and package evidence.

**Step 2: Write failing route-generation tests**

Start a mutation, switch route or organization, resolve the old request, and
assert that it cannot close a dialog, publish success, select a row, or replace
the new route state.

**Step 3: Implement review actions**

The review dialog displays immutable version metadata and package files before
Approve or Reject becomes available. Require a reviewer note on rejection.
After success, refresh all four scoped collections using a new page generation.

**Step 4: Implement rollout actions**

Validate target/audience shapes in the browser for immediate feedback, while
leaving Den as final authority. Organization scope permits only organization
catalog policies; platform scope permits only platform policies. Show locked
policies as immutable to ordinary users.

**Step 5: Implement installation actions**

Provide create, enable/disable, remove, and restore. Require concrete target
ids for user/workspace targets and concrete version ids where policy requires
pinning. Do not directly mutate desktop files from the Admin UI.

**Step 6: Run service, UI, and browser tests**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-skills.test.ts test/admin-skills-state.test.ts test/admin-ui.test.ts
pnpm --filter @neatech/veslo-e2e test:admin-skills-governance
```

Expected: PASS, including both role modes and stale-mutation isolation.

**Step 7: Commit**

```bash
git add services/ai-gateway/public-admin/admin-skills-state.js services/ai-gateway/public-admin/app.js services/ai-gateway/public-admin/index.html services/ai-gateway/public-admin/app.css services/ai-gateway/test/admin-skills-state.test.ts services/ai-gateway/test/admin-ui.test.ts services/ai-gateway/test/admin-skills.test.ts packages/e2e/specs/ai-gateway-admin-data-isolation.playwright.spec.ts
git commit -m "feat(admin): manage skill reviews and rollouts"
```

## Task 7: Add authorized desktop deep links without duplicating administration

**Files:**

- Create: `packages/app/src/app/lib/admin-skill-links.ts`
- Create: `packages/app/src/app/tests/lib/admin-skill-links.test.ts`
- Modify: `packages/app/src/app/lib/den-auth.ts`
- Modify: `packages/app/src/app/pages/skills.tsx`
- Modify: `packages/app/src/app/pages/dashboard.tsx`
- Modify: `packages/app/src/app/app-view-props.ts`
- Modify: `packages/app/src/app/tests/pages/skills-layout-contract.test.ts`

**Step 1: Write failing link-builder tests**

Build canonical URLs from the deployment domain:

```ts
organizationSkillsAdminUrl("veslo.work", "org_1")
// https://ai.veslo.work/admin/organizations/org_1/skills

platformSkillsAdminUrl("staging.veslo.work")
// https://ai.staging.veslo.work/admin/platform-skills
```

Reject empty organization ids and URL-encode ids. Use the canonical AI Gateway
origin plus `/admin`; do not use an unverified production `admin.*` alias.

**Step 2: Add a minimal admin-access read**

Use the signed-in Den token to load the existing admin session contract and
derive only:

```ts
type SkillAdminAccess = {
  organizationAdmin: boolean;
  platformAdmin: boolean;
};
```

An unreachable admin session hides links and does not block the Skills page.
Do not persist another credential or admin cookie in the desktop app.

**Step 3: Add links to the Skills page**

Show **Manage organization skills** for the active organization admin and for a
platform admin with an active org. Show **Manage platform skills** only for a
platform admin. Open links with `openExternalUrl` from `lib/tauri-url.ts`.

Do not add approve, reject, rollout, installation, user, or membership forms to
the desktop page.

**Step 4: Run app tests and typecheck**

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/admin-skill-links.test.ts src/app/tests/pages/skills-layout-contract.test.ts
pnpm --filter @neatech/veslo-ui typecheck
```

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/admin-skill-links.ts packages/app/src/app/tests/lib/admin-skill-links.test.ts packages/app/src/app/lib/den-auth.ts packages/app/src/app/pages/skills.tsx packages/app/src/app/pages/dashboard.tsx packages/app/src/app/app-view-props.ts packages/app/src/app/tests/pages/skills-layout-contract.test.ts
git commit -m "feat(app): link skill admins to web governance"
```

## Task 8: Add deployment smoke coverage and update canonical documentation

**Files:**

- Modify: `.github/workflows/deploy-owned-server.yml`
- Modify: `services/den/test/deploy-den-workflow.test.ts`
- Modify: `docs/features/admin-data-loading-and-scope-isolation.md`
- Modify: `docs/features/skill-registry-and-distribution.md`
- Modify: `docs/dev/app-map.md`
- Modify: `docs/dev/cloud-deployments.md`

**Step 1: Write a failing deployment workflow contract test**

Assert that public deployment verification checks the protected existence of:

```text
/v1/skills
/v1/skill-review-requests
/v1/skill-rollout-policies
/v1/skill-installations
```

Each unauthenticated request must return the expected JSON `401`, not `404` or
HTML.

**Step 2: Add the smoke assertions**

Reuse the workflow's existing `assert_json_error_route` helper. Do not perform
authenticated mutations in the deployment workflow.

**Step 3: Promote implemented behavior into canonical docs**

After the implementation and tests pass:

- add `/admin/platform-skills` and
  `/admin/organizations/:organizationId/skills` to the canonical scope table;
- document the four Skills subsections and required load dependencies;
- document the Admin UI facade as the governance surface and desktop as the
  workbench/materialization surface;
- keep the authority-delegation invariant unchanged;
- document the canonical Admin origin actually used by desktop deep links.

**Step 4: Run documentation/workflow tests**

```bash
pnpm --filter @neatech/den exec tsx --test test/deploy-den-workflow.test.ts
git diff --check
```

Expected: PASS.

**Step 5: Commit**

```bash
git add .github/workflows/deploy-owned-server.yml services/den/test/deploy-den-workflow.test.ts docs/features/admin-data-loading-and-scope-isolation.md docs/features/skill-registry-and-distribution.md docs/dev/app-map.md docs/dev/cloud-deployments.md
git commit -m "docs: document skill administration governance"
```

## Task 9: Run final focused and repository verification

**Files:**

- No source changes expected.

**Step 1: Re-run Den skill and admin tests**

```bash
pnpm --filter @neatech/den exec tsx --test test/skill-registry-routes.test.ts test/skill-registry-schema.test.ts test/core-platform-skill-bootstrap.test.ts test/admin-contract.test.ts test/deploy-den-workflow.test.ts
```

Expected: PASS with zero failures.

**Step 2: Re-run AI Gateway Admin tests**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-skills.test.ts test/admin-skills-state.test.ts test/admin-route-state.test.ts test/admin-page-load-state.test.ts test/admin-ui.test.ts test/admin-user-access.test.ts
```

Expected: PASS with zero failures.

**Step 3: Run the primary browser E2E**

```bash
pnpm --filter @neatech/veslo-e2e test:admin-skills-governance
```

Expected: PASS for organization admin, platform admin in organization context,
platform skills, and route/mutation isolation.

**Step 4: Run app contracts**

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm src/app/tests/lib/admin-skill-links.test.ts src/app/tests/pages/skills-layout-contract.test.ts src/app/tests/pages/skills-bulk-publish-gate.test.ts src/app/tests/lib/veslo-server.test.ts
```

Expected: PASS.

**Step 5: Run the normal repository gate**

```bash
pnpm check
```

Expected: PASS. This does not replace the browser E2E above.

**Step 6: Verify the real desktop boundary**

Run the mandatory Veslo desktop process preflight from
`docs/dev/testing-playbook.md`. Then build and run the existing real-Tauri skill
publish scenario:

```bash
pnpm test:pilot:skill-publish
```

Expected: PASS. Confirm that the desktop still submits a registry request and
does not expose web-admin mutation forms. If the deep-link control itself needs
native opener proof, add a narrowly scoped Tauri Pilot assertion rather than
using a web-only runtime.

**Step 7: Inspect the final repository state**

```bash
git status --short
git log --oneline --decorate -12
```

Expected: only intentional commits and no uncommitted source changes.

## Task 10: Production rollout after separate authorization

**Files:**

- No source changes expected.

**Step 1: Stop unless production deployment is explicitly authorized**

Implementation completion does not authorize production deployment.

**Step 2: If authorized, use the repo-local release/deployment workflow**

Follow `docs/dev/cloud-deployments.md`. Dispatch `Deploy Owned Server` manually
for the reviewed pushed commit. Do not deploy from a dirty or unpushed branch.

**Step 3: Verify deployed revision and public routes**

Confirm that the workflow checked out the exact reviewed SHA, applied Den
migrations, started healthy services, and passed the new protected-route
smokes.

**Step 4: Run an authenticated production smoke only with explicit permission**

Use dedicated test records. Verify one organization-admin read, one platform
admin organization-scoped read, and one reversible rollout mutation. Confirm
the audit row contains the real actor, selected organization, and authority.
Restore the test mutation before ending the smoke.
