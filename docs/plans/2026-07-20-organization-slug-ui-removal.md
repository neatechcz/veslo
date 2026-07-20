# Organization Slug UI Removal Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove organization slugs from every AI Gateway admin UI surface and prevent both admin roles from submitting slug changes while preserving the backend contract.

**Architecture:** Keep the organization `slug` field in DEN/AI Gateway data models and the PATCH parser for compatibility. Narrow only the browser presentation and mutation code: visible organization labels use name with ID fallback, selectors use name plus ID, and organization saves send only fields exposed by the role.

**Tech Stack:** Static HTML, browser JavaScript, Node.js test runner, Playwright, TypeScript, Express.

---

### Task 1: Lock the UI and compatibility contract with failing tests

**Files:**
- Modify: `services/ai-gateway/test/admin-ui.test.ts`
- Modify: `packages/e2e/specs/ai-gateway-admin-data-isolation.playwright.spec.ts`

**Step 1: Write the failing source-level test**

Add a test that loads `public-admin/index.html`, `public-admin/app.js`, and `src/http/admin.ts`. Assert:

```ts
assert.doesNotMatch(html, /id="organization-slug"/)
assert.doesNotMatch(html, /<span>Slug<\/span>/)
assert.doesNotMatch(script, /organizationSlug:\s*document\.getElementById\("organization-slug"\)/)
assert.doesNotMatch(topLevelFunctionSource(script, "organizationSelectorLabel"), /\.slug/)
assert.doesNotMatch(topLevelFunctionSource(script, "findOrganizationFromSelectorValue"), /\.slug/)
assert.doesNotMatch(topLevelFunctionSource(script, "renderOrganizationsDirectory"), /\.slug|No slug/)
assert.doesNotMatch(topLevelFunctionSource(script, "hasOrganizationPendingChanges"), /organizationSlug|\.slug/)
assert.doesNotMatch(topLevelFunctionSource(script, "renderOrganization"), /organizationSlug|\.slug/)
assert.doesNotMatch(topLevelFunctionSource(script, "saveOrganization"), /organizationSlug|\bslug\s*:/)
assert.match(topLevelFunctionSource(adminSource, "readOrganizationUpdateInput"), /hasOwn\(body, "slug"\)/)
```

Update the existing fail-closed control list so `organization-slug` is no longer expected in the shell. Extend the fallback-shell test with a nameless organization whose slug is a unique marker, and assert that the marker is absent while its ID is present.

**Step 2: Write failing Playwright coverage for both roles**

Add browser cases for a platform admin and an organization admin. Each case should open `/admin/organizations/org-a/overview` and verify:

```ts
await expect(page.locator('#organization-slug')).toHaveCount(0)
await expect(page.locator('#organization-selector-input')).not.toHaveValue(/organization-a/)
await expect(page.locator('#organization-selector-input')).toHaveValue(`${ORG_A.name} - ${ORG_A.id}`)
```

Change the organization name, intercept the PATCH, and assert the exact role-specific body:

```ts
// platform admin
expect(saveRecord.body).toEqual({ name: renamed, seatLimit: ORG_A.seatLimit })

// organization admin
expect(saveRecord.body).toEqual({ name: renamed })

expect(saveRecord.body).not.toHaveProperty('slug')
```

Return an organization response that still contains the original backend slug to prove the UI neither removes nor changes backend compatibility data. Also verify the platform organization directory renders name and ID without the slug marker.

**Step 3: Run the source test to verify RED**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts
```

Expected: FAIL because `organization-slug` and slug-dependent rendering/submission still exist.

**Step 4: Run the Playwright test to verify RED**

Run:

```bash
pnpm --filter @neatech/veslo-e2e exec playwright test ./specs/ai-gateway-admin-data-isolation.playwright.spec.ts --grep "organization slug" --output=/tmp/veslo-ai-gateway-org-slug-red
```

Expected: FAIL because the slug input and selector value are still visible and PATCH contains `slug`.

**Step 5: Commit the failing tests**

```bash
git add services/ai-gateway/test/admin-ui.test.ts packages/e2e/specs/ai-gateway-admin-data-isolation.playwright.spec.ts
git commit -m "test(ai-gateway): forbid organization slug in admin UI"
```

### Task 2: Remove slug from the AI Gateway admin UI

**Files:**
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/src/http/admin.ts`

**Step 1: Remove the form control**

Delete the complete `Slug` label and `organization-slug` input from the organization editor in `index.html`.

**Step 2: Remove browser references and visible fallbacks**

In `app.js`:

- remove `els.organizationSlug` and every clear/enable/value operation on it;
- label the active organization with `organization.name || organization.id`;
- make `organizationSelectorLabel` return unique values from `[name || id, id]`;
- match selector input only against the selector label, name, and ID;
- render datalist labels from name or ID and update the title to `Search by organization name or ID.`;
- compare only name and platform-only seat limit in pending-change detection;
- render organization directory cards with name and ID only;
- render editor title from name or ID;
- omit `slug` from `saveOrganization` PATCH payload;
- omit the unused `orgSlug` field from organization-scoped member adapters.

**Step 3: Remove the fallback-shell slug display**

In `adminFallbackShellHtml`, change the visible label fallback to:

```ts
const organizationLabel = escapeAdminShellHtml(organization.name || organization.id);
```

Do not change `readOrganizationUpdateInput`; it must continue accepting `slug` for compatibility.

**Step 4: Run focused tests to verify GREEN**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts
pnpm --filter @neatech/veslo-e2e exec playwright test ./specs/ai-gateway-admin-data-isolation.playwright.spec.ts --grep "organization slug" --output=/tmp/veslo-ai-gateway-org-slug-green
```

Expected: both commands PASS.

**Step 5: Commit the implementation**

```bash
git add services/ai-gateway/public-admin/index.html services/ai-gateway/public-admin/app.js services/ai-gateway/src/http/admin.ts
git commit -m "fix(ai-gateway): hide organization slug from admin UI"
```

### Task 3: Run regression and quality gates

**Files:**
- No production file changes expected.

**Step 1: Run the complete browser isolation suite**

```bash
pnpm --filter @neatech/veslo-e2e test:ai-gateway-admin-data-isolation
```

Expected: PASS with no browser page errors or stale-data leaks.

**Step 2: Run all AI Gateway tests**

```bash
pnpm --filter @neatech/ai-gateway test
```

Expected: 0 failures; environment-gated MySQL tests may remain skipped.

**Step 3: Run type checks and builds for changed cloud surfaces**

```bash
pnpm --filter @neatech/ai-gateway typecheck
pnpm --filter @neatech/veslo-e2e typecheck
pnpm --filter @neatech/ai-gateway build
git diff --check
```

Expected: all commands exit 0.

**Step 4: Review scope**

```bash
git status --short
git diff main...HEAD --stat
git diff main...HEAD -- packages/app packages/server
```

Expected: only the design/plan, AI Gateway admin sources, and their tests changed; the final command has no output.
