# Admin Data Loading and Scope Isolation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make every AI Gateway admin route fail closed while loading, prevent cross-page and cross-organization data flashes, and move organization member and AI-access reads and writes behind organization-scoped server boundaries.

**Architecture:** Add a small pure page-load state machine keyed by canonical route and generation, then make the static admin client clear route-owned state and show a neutral blurred skeleton before starting abortable requests. Keep global readiness independent. Split global directory data from organization member data, load organization resources only through organization-qualified APIs, and enforce organization membership at the Gateway before AI-access reads or writes.

**Tech Stack:** TypeScript, Express, browser-native ES modules, HTML/CSS, Node test runner through `tsx --test`, Playwright, pnpm.

---

## Working Rules

- Work in the staging-based branch that contains the deployed admin portal, not the reverted/simpler admin implementation on `main`.
- Keep unrelated changes in the root checkout untouched.
- Follow red-green-refactor for every task: add the failing test, run it and confirm the expected failure, make the smallest change, then rerun the focused test.
- Do not render previous real data beneath the blur. Hide and clear the real route panel; blur only neutral skeleton shapes.
- Do not use the global user or organization directory as an organization authorization boundary.
- Do not deploy until the complete verification matrix in Task 8 passes.

## Task 1: Add a canonical page-load state machine

**Files:**

- Create: `services/ai-gateway/public-admin/admin-page-load-state.js`
- Create: `services/ai-gateway/test/admin-page-load-state.test.ts`

### Step 1: Write the failing state-machine tests

Cover these contracts:

```ts
test("route scope keys include organization identity", () => {
  assert.equal(pageLoads.adminRouteScopeKey({ area: "platform", page: "platform-users", organizationId: null }), "platform:platform-users");
  assert.equal(pageLoads.adminRouteScopeKey({ area: "organization", page: "members", organizationId: "org_a" }), "organization:org_a:members");
});

test("beginning a newer page invalidates all older completions", () => {
  const state = pageLoads.createAdminPageLoadState();
  const orgA = pageLoads.beginAdminPageLoad(state, { area: "organization", page: "members", organizationId: "org_a" });
  const orgB = pageLoads.beginAdminPageLoad(state, { area: "organization", page: "members", organizationId: "org_b" });

  assert.equal(pageLoads.completeAdminPageLoad(state, orgA, false), false);
  assert.equal(pageLoads.failAdminPageLoad(state, orgA, new Error("late")), false);
  assert.equal(pageLoads.completeAdminPageLoad(state, orgB, false), true);
  assert.equal(state.status, "ready");
});

test("empty, error, and aborted loads are distinct", () => {
  // Assert ready/empty/error transitions and that AbortError never creates a page error.
});
```

The module should expose only pure functions and serializable state. A request token contains the canonical key and monotonically increasing generation.

### Step 2: Run the test to verify it fails

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-page-load-state.test.ts
```

Expected: FAIL because `admin-page-load-state.js` does not exist.

### Step 3: Implement the minimal state machine

Implement:

```js
export function adminRouteScopeKey(route) {}
export function createAdminPageLoadState() {}
export function beginAdminPageLoad(state, route) {}
export function isAdminPageLoadCurrent(state, request) {}
export function completeAdminPageLoad(state, request, empty) {}
export function failAdminPageLoad(state, request, error) {}
```

Use statuses `idle`, `loading`, `ready`, `empty`, and `error`. Normalize errors into safe display text without retaining response payload data in the state machine.

### Step 4: Run the focused tests

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-page-load-state.test.ts test/admin-route-state.test.ts
```

Expected: PASS.

### Step 5: Commit

```bash
git add services/ai-gateway/public-admin/admin-page-load-state.js services/ai-gateway/test/admin-page-load-state.test.ts
git commit -m "test: define admin page load generations"
```

## Task 2: Replace initial example data with the loading, empty, and error shell

**Files:**

- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.css`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

### Step 1: Add failing shell assertions

Extend the admin UI test to assert that the HTML:

- contains a single reusable page-state region with `aria-busy="true"`;
- contains `Loading data...` inside `role="status"` with polite announcement;
- contains an `aria-hidden="true"` skeleton surface;
- contains a hidden error state and Retry button;
- does not contain the hardcoded overview values `18`, `2`, or `41` as metric content;
- does not contain realistic alert, audit, user, usage, chart, or status seed content;
- does not contain the static `2 credential alerts` live signal.

Add CSS source assertions for a neutral skeleton, subtle skeleton blur, reduced-motion handling, and a loading state that hides the real data panels.

### Step 2: Run the test to verify it fails

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts
```

Expected: FAIL because the shell still contains realistic example values and has no reusable loading/error surface.

### Step 3: Make the initial document fail closed

In `index.html`:

- replace all realistic initial metric text with empty placeholders;
- remove initial user, alert, audit, usage, credential, and chart examples;
- make all route-owned controls disabled or hidden until a route becomes ready;
- add `#admin-page-state`, `#admin-page-loading`, `#admin-page-error`, `#admin-page-error-message`, and `#admin-page-retry`;
- use shape-only skeleton cards, rows, form fields, and chart bars with no text content;
- keep the page title, route description, navigation, organization context, and backend connection surface outside the blocked data region.

In `app.css`:

- blur and soften only `.admin-page-skeleton`;
- hide active `[data-page]` content while the page state is loading or errored;
- keep focus indicators and error actions unblurred;
- disable skeleton animation under `prefers-reduced-motion`.

### Step 4: Run the focused test

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts
```

Expected: PASS.

### Step 5: Commit

```bash
git add services/ai-gateway/public-admin/index.html services/ai-gateway/public-admin/app.css services/ai-gateway/test/admin-ui.test.ts
git commit -m "fix: make admin shell fail closed while loading"
```

## Task 3: Integrate route generations, synchronous clearing, and background readiness

**Files:**

- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`
- Modify: `services/ai-gateway/test/admin-route-state.test.ts`

### Step 1: Add failing client-contract tests

Assert that the client:

- imports the page-load state module;
- owns one route `AbortController` and page-load state;
- begins the new page load before calling `renderRoute()` or starting route fetches;
- closes every modal and clears selected credential, alert, audit, user/member, domain, and invite IDs on scope change;
- synchronously clears all route-owned collections and records;
- attaches the route signal to every required request;
- commits ready, empty, or error only for the current key and generation;
- treats `AbortError` as an abandoned route, not a visible error;
- calls `loadReadiness()` after authenticated bootstrap without awaiting it;
- never calls `await loadReadiness()` inside `loadRouteData`;
- retries the current canonical route from the Retry button.

Add a pure route-state test proving platform and organization scope changes invalidate mutation completions as well as reads.

### Step 2: Run the tests to verify they fail

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts test/admin-route-state.test.ts
```

Expected: FAIL because navigation currently renders reused panels before clearing them and awaits readiness before route data.

### Step 3: Introduce route-owned client state

Add to the client state:

```js
pageLoad: createAdminPageLoadState(),
organizationDirectory: [],
organizationMembers: [],
```

Keep `state.users` exclusively for Platform Users and platform overview counts. Keep `state.organizationDirectory` exclusively for the Platform Organizations page. Use the authenticated session organizations plus the directly loaded organization for workspace chrome; do not repurpose the global directory collection.

Create helpers with explicit responsibilities:

```js
function beginRouteDataLoad(route) {}
function clearRouteOwnedState() {}
function renderAdminPageState() {}
function finishRouteDataLoad(request, results) {}
function failRouteDataLoad(request, error) {}
function currentRouteSubjects() {}
```

`beginRouteDataLoad` must abort the old controller, create the new controller, close all dialogs, clear selected IDs and route records, render the route title/chrome, and show the skeleton before the first fetch promise is created.

### Step 4: Make route loading atomic

Refactor `loadRouteData(route)` so it:

1. receives the request token and signal created by navigation;
2. starts required route requests concurrently;
3. stores results in local variables until every required request succeeds;
4. checks key and generation;
5. assigns state and renders the real panel once;
6. otherwise renders empty or error without previous data.

Do not let individual loaders render partial route data. Optional global readiness continues to update only its own signal.

Map errors as follows:

- `401`: clear auth state and return to sign-in;
- `403`: render `Access denied` in an otherwise empty data region;
- organization `404`: render `Organization not found`;
- network/`5xx`: show a concise error and Retry;
- abort: no visible error.

### Step 5: Run the focused tests

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-page-load-state.test.ts test/admin-route-state.test.ts test/admin-ui.test.ts
```

Expected: PASS.

### Step 6: Commit

```bash
git add services/ai-gateway/public-admin/app.js services/ai-gateway/test/admin-ui.test.ts services/ai-gateway/test/admin-route-state.test.ts
git commit -m "fix: isolate admin route loading generations"
```

## Task 4: Make organization workspace and member operations organization-scoped

**Files:**

- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`
- Modify: `services/ai-gateway/test/admin-route-state.test.ts`

### Step 1: Add failing API and client tests

Add server tests proving:

- `GET /admin/api/organizations/:orgId/members` returns only the service response for that organization;
- member list/create/update/delete all require `requireOrganizationAccess`, not capability presence alone;
- an organization administrator receives `403` for another organization's member routes;
- a platform administrator may access an explicitly routed organization;
- the routed organization record is loaded with `GET /admin/api/organizations/:orgId` without first calling `GET /admin/api/organizations`.

Add client source assertions proving:

- Members and AI Access call `/organizations/:orgId/members`;
- only Platform Users and platform overview may call `/users`;
- member edits call `/organizations/:orgId/members/:membershipId`;
- organization workspace loading does not request the global organization directory;
- organization member results live in `state.organizationMembers`, never `state.users`.

### Step 2: Run the tests to verify they fail

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts test/admin-route-state.test.ts
```

Expected: FAIL because Members and AI Access use `/users`, the organization loader fetches the full directory, and member proxy routes do not all enforce local organization access.

### Step 3: Harden the Gateway member routes

Add `requireOrganizationAccess(res, req.params.orgId)` to member list, create, update, and delete before proxying to DEN. Keep DEN's own enforcement as defense in depth.

Do not accept an organization ID from a request body when the route already supplies it.

### Step 4: Split platform users from organization members in the client

Implement a small adapter from `AdminOrganizationMemberRecord` to the existing member-list/editor view. Preserve `membershipId` for scoped mutations. Update `currentUser()` and filtering/render helpers to read from `currentRouteSubjects()`.

Refactor organization workspace loading:

- fetch the routed organization directly;
- for Domains & Invites, request organization, domains, and invites in parallel;
- for Members and AI Access, request organization and members in parallel;
- never await the global organization directory;
- use cached/session organizations only for selector chrome.

### Step 5: Run the focused tests

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts test/admin-route-state.test.ts
```

Expected: PASS.

### Step 6: Commit

```bash
git add services/ai-gateway/src/http/admin.ts services/ai-gateway/public-admin/app.js services/ai-gateway/test/admin-ui.test.ts services/ai-gateway/test/admin-route-state.test.ts
git commit -m "fix: scope admin organization member data"
```

## Task 5: Add organization-qualified AI-access APIs and membership checks

**Files:**

- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/test/admin-user-access.test.ts`
- Modify: `services/ai-gateway/test/admin-openai-compatible.test.ts`
- Modify: `services/ai-gateway/test/admin-actions.test.ts`

### Step 1: Write failing route tests

Add tests for:

```text
GET /admin/api/organizations/:orgId/members/:userId/ai-access
PUT /admin/api/organizations/:orgId/members/:userId/ai-access
```

Prove that both routes:

- require the managed-AI capability;
- require access to the path organization;
- call `listOrganizationMembers(token, orgId)` and reject a user not present in that response;
- call the AI-access service only after membership is confirmed;
- forward the path organization ID and real actor ID on writes;
- reject legacy per-user model fields without writing;
- preserve credential eligibility and repair behavior;
- return `404 member_not_found` for a user outside the routed organization;
- do not trust an `organizationId` in the JSON body.

Add a migration test that the unqualified `/admin/api/users/:userId/ai-access` read and write routes are no longer available.

### Step 2: Run the tests to verify they fail

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-user-access.test.ts test/admin-openai-compatible.test.ts test/admin-actions.test.ts
```

Expected: FAIL because only the unqualified routes exist and the read does not verify organization membership.

### Step 3: Implement one shared membership guard

Create an internal helper that:

1. checks route-level organization access;
2. obtains the scoped member collection through `AdminService.listOrganizationMembers`;
3. finds an exact `member.userId === req.params.userId` match;
4. emits a safe `404 member_not_found` without calling the access repository when absent.

Use the helper in both qualified routes. Remove the organization ID from the write body contract. Remove the unqualified routes after all internal callers are migrated in Task 6.

### Step 4: Run the focused tests

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-user-access.test.ts test/admin-openai-compatible.test.ts test/admin-actions.test.ts
```

Expected: PASS.

### Step 5: Commit

```bash
git add services/ai-gateway/src/http/admin.ts services/ai-gateway/test/admin-user-access.test.ts services/ai-gateway/test/admin-openai-compatible.test.ts services/ai-gateway/test/admin-actions.test.ts
git commit -m "fix: qualify admin AI access by organization"
```

## Task 6: Migrate the admin client and live admin helpers to qualified AI access

**Files:**

- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`
- Modify: `packages/e2e/helpers/live-admin-client.ts`
- Modify: `packages/e2e/helpers/live-admin-client.test.ts`
- Modify: `packages/e2e/scripts/check-live-admin-user.ts`

### Step 1: Add failing client tests

Assert that:

- selecting an AI Access member calls the organization-qualified GET route;
- saving calls the organization-qualified PUT route without `organizationId` in the body;
- a member selection is cleared on organization or page change;
- late access responses cannot populate a dialog owned by a newer route generation;
- AI Access actions remain disabled until the scoped member collection is ready;
- helper callers require an explicit organization ID and build only qualified URLs.

### Step 2: Run the tests to verify they fail

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts
pnpm --filter @neatech/veslo-e2e exec tsx --test helpers/live-admin-client.test.ts
```

Expected: FAIL because the client and helper still use `/users/:userId/ai-access`.

### Step 3: Migrate every caller

Build the request path only from the current canonical organization route and selected scoped member. Capture the current page-load token before opening or saving the dialog, and check it again before changing state or status text.

Change live helper method signatures to require `organizationId`. Update the live check script to resolve the organization before reading or writing AI access. Do not add a compatibility fallback to the old URL.

### Step 4: Run the focused tests

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts test/admin-user-access.test.ts
pnpm --filter @neatech/veslo-e2e exec tsx --test helpers/live-admin-client.test.ts
```

Expected: PASS.

### Step 5: Commit

```bash
git add services/ai-gateway/public-admin/app.js services/ai-gateway/test/admin-ui.test.ts packages/e2e/helpers/live-admin-client.ts packages/e2e/helpers/live-admin-client.test.ts packages/e2e/scripts/check-live-admin-user.ts
git commit -m "fix: use scoped AI access in admin clients"
```

## Task 7: Add browser E2E coverage for every unsafe transition

**Files:**

- Create: `packages/e2e/specs/ai-gateway-admin-data-isolation.playwright.spec.ts`
- Modify: `packages/e2e/package.json`

### Step 1: Build a deterministic local admin harness

Reuse the static-server style from the existing admin billing Playwright specs, but serve `services/ai-gateway/public-admin`. Intercept `/admin/api/*` and `/readiness` in Playwright so each response can be resolved manually.

The harness must record every requested URL and support:

- delayed session, readiness, organization, member, global user, billing, audit, domain, invite, and AI-access responses;
- explicit `401`, `403`, `404`, `500`, and network failure responses;
- two organizations with unmistakably different names and members;
- a frame observer installed before app bootstrap that records any forbidden prior-scope text found after navigation begins.

### Step 2: Write the failing E2E scenarios

Add scenarios for:

1. Initial shell has no example metrics, people, alerts, audit events, or chart values.
2. Platform Users to Organization Members removes every global user before the members response resolves.
3. Organization A to Organization B never exposes A's member, domain, invite, billing, AI-access, or audit content in a visible or accessible node.
4. A late Platform Users or Organization A response cannot change the current route.
5. A delayed or failed `/readiness` response does not delay destination requests or page reveal.
6. Members and AI Access never request `/admin/api/users`.
7. AI Access uses only organization-qualified read and write URLs.
8. Loading, true empty, retryable error, `401`, `403`, and organization `404` states are distinct.
9. Route-owned dialogs close and selections disappear during navigation.
10. The skeleton is `aria-hidden`, the page region is busy during load, and old data nodes are removed rather than visually obscured.

For the strict frame assertion, start observing immediately before the click or history navigation and fail if forbidden text appears in any `requestAnimationFrame` or mutation callback until the destination is ready.

### Step 3: Add the script and run the test to verify it fails

Add:

```json
"test:ai-gateway-admin-data-isolation": "playwright test ./specs/ai-gateway-admin-data-isolation.playwright.spec.ts"
```

Run:

```bash
pnpm --filter @neatech/veslo-e2e test:ai-gateway-admin-data-isolation
```

Expected: FAIL against the current transition behavior before Tasks 2 through 6, or PASS when written after those tasks only after temporarily reverting one guard to demonstrate the test detects the regression. Restore the guard immediately.

### Step 4: Complete the harness and make all scenarios pass

Avoid screenshots as the primary assertion. Assert DOM removal, accessibility attributes, request order, request URLs, and state after delayed responses. Screenshots may be retained only as optional debugging artifacts.

### Step 5: Run the browser suite three times

Run:

```bash
pnpm --filter @neatech/veslo-e2e test:ai-gateway-admin-data-isolation
pnpm --filter @neatech/veslo-e2e test:ai-gateway-admin-data-isolation
pnpm --filter @neatech/veslo-e2e test:ai-gateway-admin-data-isolation
```

Expected: PASS three consecutive times with no retries required.

### Step 6: Commit

```bash
git add packages/e2e/specs/ai-gateway-admin-data-isolation.playwright.spec.ts packages/e2e/package.json
git commit -m "test: cover admin data isolation transitions"
```

## Task 8: Document durable behavior and run the full verification matrix

**Files:**

- Create: `docs/features/admin-data-loading-and-scope-isolation.md`
- Modify: `docs/admin-managed-ai-access.md`
- Modify only if behavior changed during implementation: `docs/plans/2026-07-14-admin-data-loading-isolation-design.md`

### Step 1: Write canonical behavior documentation

Document:

- canonical platform and organization scope keys;
- the fail-closed loading, empty, and error contract;
- which pages may call global directories;
- organization-qualified member and AI-access APIs;
- readiness being background-only;
- the no-stale-frame E2E acceptance rule;
- the removed unqualified AI-access endpoints and updated operational examples.

Keep the implementation plan historical; put durable product/runtime semantics in `docs/features/`.

### Step 2: Run focused API and UI tests

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test \
  test/admin-page-load-state.test.ts \
  test/admin-route-state.test.ts \
  test/admin-ui.test.ts \
  test/admin-user-access.test.ts \
  test/admin-openai-compatible.test.ts \
  test/admin-actions.test.ts
```

Expected: PASS.

### Step 3: Run all AI Gateway tests and build

Run:

```bash
pnpm --filter @neatech/ai-gateway test
pnpm --filter @neatech/ai-gateway build
```

Expected: PASS with zero failures and a clean TypeScript build.

### Step 4: Run helper and browser E2E tests

Run:

```bash
pnpm --filter @neatech/veslo-e2e exec tsx --test helpers/live-admin-client.test.ts
pnpm --filter @neatech/veslo-e2e test:ai-gateway-admin-data-isolation
pnpm --filter @neatech/veslo-e2e test:den-admin-billing-lifecycle
```

Expected: PASS. The billing suite confirms the adjacent admin browser harness remains intact.

### Step 5: Inspect for forbidden global calls and seed content

Run:

```bash
rg -n 'fetchJson\("/users"|/admin/api/users/.+/ai-access|2 credential alerts|>18<|>41<' services/ai-gateway/public-admin packages/e2e
```

Expected: no organization-scoped caller and no realistic initial seed content. Any remaining `/users` call must be demonstrably restricted to Platform Users or the platform overview count.

### Step 6: Verify the complete diff

Run:

```bash
git diff --check
git status --short
git log --oneline --decorate -10
```

Expected: no whitespace errors, only planned files changed, and no unrelated root-checkout changes included.

### Step 7: Commit documentation

```bash
git add docs/features/admin-data-loading-and-scope-isolation.md docs/admin-managed-ai-access.md docs/plans/2026-07-14-admin-data-loading-isolation-design.md
git commit -m "docs: define admin loading isolation contract"
```

## Release Gate

Do not merge or deploy unless all of these are true:

- focused API/UI tests pass;
- the complete AI Gateway suite passes;
- the AI Gateway TypeScript build passes;
- the browser isolation suite passes three consecutive times;
- no organization page requests the global user directory;
- no organization workspace blocks on the global organization directory or readiness;
- old scope content is absent from both visible DOM and accessible nodes for every observed transition frame;
- the branch contains no secrets or unrelated user changes.
