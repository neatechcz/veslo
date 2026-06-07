# VSLO-201 Canonical AI Admin Correction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Remove the accidental DEN admin UI and implement the VSLO-201 Pencil V2 admin interaction model in the single AI Gateway admin at `ai.veslo.work/admin`.

**Architecture:** AI Gateway serves the only admin shell and proxies DEN-owned organization/user APIs. DEN keeps backend admin APIs but redirects human `/admin` page traffic to the AI Gateway admin. The static admin UI remains framework-free HTML/CSS/JS and uses modal dialogs for item detail/editing.

**Tech Stack:** TypeScript, Express, static HTML/CSS/JS, node:test, Playwright/browser smoke for visual interaction checks.

---

## Task 1: Document The Canonical Admin Contract

**Files:**
- Modify: `docs/plans/2026-06-06-vslo-201-admin-gateway-design.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/features/session-runtime.md`
- Modify if present/relevant: `docs/dev/app-map.md`

**Step 1: Write or update docs assertions**

Document that:

- VSLO-201 "admin" means `ai.veslo.work/admin`,
- DEN is backend authority and not a second admin UI,
- `api.veslo.work/admin` redirects or is not a product surface,
- Sessions UI is removed,
- unsupported audit export/trace actions are not part of the UI.

**Step 2: Run docs grep sanity**

Run:

```bash
rg -n "api\\.veslo\\.work/admin|DEN admin shell|Sessions page|trace request|Export CSV|approval queue|autosave|auto-save" docs/dev docs/features docs/plans/2026-06-06-vslo-201-admin-gateway-design.md
```

Expected: no stale claim that DEN has a product admin shell, no recommendation to expose Sessions UI, no autosave recommendation.

## Task 2: Remove DEN Admin UI As A Product Surface

**Files:**
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Modify: `services/den/test/admin-managed-ai-ui.test.ts`
- Consider deleting after tests are adjusted: `services/den/public-admin/index.html`
- Consider deleting after tests are adjusted: `services/den/public-admin/app.js`
- Consider deleting after tests are adjusted: `services/den/public-admin/app.css`

**Step 1: Write failing DEN route tests**

Update DEN admin UI tests to assert:

- `GET /admin` redirects to `https://ai.veslo.work/admin`,
- `GET /admin/credentials` redirects to the corresponding AI Gateway admin path,
- `GET /admin/app.js` no longer serves DEN admin frontend JS,
- `/admin/api/credentials/openai/oauth/start` still works,
- `/admin/api/*` remains API and does not redirect.

Run:

```bash
pnpm --filter @neatech/den test -- test/admin-managed-ai-ui.test.ts test/admin-managed-ai-openai-oauth.test.ts test/admin-managed-ai-actions.test.ts
```

Expected: FAIL before routing change.

**Step 2: Implement redirect**

In DEN managed AI admin UI router:

- keep OpenAI OAuth admin API routes,
- remove static `public-admin` serving,
- add redirect handler for `/admin` and `/admin/*` except `/admin/api/*`,
- preserve query string only when it is safe and useful,
- map `/admin/credentials` to `https://ai.veslo.work/admin/credentials`.

**Step 3: Remove stale DEN public admin tests and assets**

Delete DEN public admin assets once no runtime imports them. Keep backend tests for `/admin/api` and `/v1/admin`.

**Step 4: Run focused DEN tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/admin-managed-ai-ui.test.ts test/admin-managed-ai-openai-oauth.test.ts test/admin-managed-ai-actions.test.ts test/admin-managed-ai-read-models.test.ts test/admin-routes.test.ts
```

Expected: PASS.

## Task 3: Add AI Gateway Modal Infrastructure

**Files:**
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/app.css`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write failing static UI tests**

Assert the AI Gateway admin shell contains:

- shared modal root or native dialog elements,
- user edit modal,
- credential detail modal,
- audit event modal,
- organization domain modal,
- organization invite modal,
- no audit export/trace buttons,
- no Sessions UI.

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/admin-ui.test.ts
```

Expected: FAIL.

**Step 2: Add modal HTML and CSS**

Use native `<dialog>` or accessible custom dialog markup. Keep dimensions stable and responsive. Add:

- modal backdrop styling,
- header/body/footer regions,
- close buttons,
- destructive button styling,
- compact form layout.

**Step 3: Add modal helpers**

In `app.js`, add helpers:

- `openModal(id)`,
- `closeModal(id)`,
- `closeAllModals()`,
- Escape/backdrop behavior,
- dirty state handling for modal forms.

**Step 4: Run static UI tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/admin-ui.test.ts
```

Expected: PASS for modal shell assertions.

## Task 4: Convert Users And Organization Editing To Modals

**Files:**
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/app.css`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write failing behavior/source tests**

Assert:

- clicking/selecting a user opens a user modal,
- create user opens the same modal in create mode,
- user role/platform admin/AI access changes are saved only by modal Save,
- organization admin never sees platform admin or AI access controls,
- organization page domain edit opens a domain modal,
- invite creation opens an invite modal,
- seat limit is read-only for organization admins.

**Step 2: Implement user modal**

Move the user editor fields from the side rail into the modal. Keep existing Save endpoint behavior. Remove the always-visible user editor rail.

**Step 3: Implement organization modals**

Use modal forms for:

- add/edit domain,
- send invite,
- edit organization member if member editing is exposed from the organization page.

**Step 4: Run AI Gateway admin tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/admin-ui.test.ts
```

Expected: PASS.

## Task 5: Convert Credentials And Audit Detail To Modals

**Files:**
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/app.css`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write failing tests**

Assert:

- credential rows open detail modal,
- credential modal shows health, 5h/weekly limit visibility, active leases, linked alerts, and actions,
- audit rows open read-only modal,
- audit modal uses loaded event payload,
- unsupported audit export and trace request are absent.

**Step 2: Implement credential modal**

Move selected credential detail out of the side rail. Keep credential actions as explicit command buttons.

**Step 3: Implement audit modal**

Render audit event detail in a modal. Keep audit page list-focused and read-only.

**Step 4: Run tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/admin-ui.test.ts
```

Expected: PASS.

## Task 6: Align Overview, Usage, And Alerts With Pencil V2

**Files:**
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/app.css`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write failing UI tests**

Assert:

- Overview uses command-center copy and capacity/incident priority labels,
- Usage is capacity-first and includes 5h and weekly remaining,
- Usage distinguishes measured, unknown, and unavailable credentials,
- Alerts page uses incident triage copy and no manual send-email button,
- no Sessions copy remains in UI.

**Step 2: Update copy and layout**

Keep data sources unchanged unless tests reveal a missing field. Remove stale labels from old report-first UI.

**Step 3: Run tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/admin-ui.test.ts
```

Expected: PASS.

## Task 7: Local Browser Smoke

**Files:**
- Create or update a temporary smoke artifact only if useful under `docs/plans/assets/`.

**Step 1: Start local AI Gateway admin test server**

Use an existing test fixture or minimal local server route from tests. Do not use `packages/web` or raw Vite as runtime proof.

**Step 2: Browser check**

Open the local admin shell and verify:

- page loads,
- navigation is visible,
- user modal opens and closes,
- credential modal opens and closes,
- audit modal opens and closes,
- no visible Sessions nav,
- no DEN admin shell target is linked.

**Step 3: Record result**

Save concise smoke output if useful.

## Task 8: Final Verification

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/admin-ui.test.ts test/admin-actions.test.ts test/admin-alerts.test.ts test/admin-read-models.test.ts test/admin-user-access.test.ts
pnpm --filter @neatech/den test -- test/admin-managed-ai-ui.test.ts test/admin-managed-ai-openai-oauth.test.ts test/admin-managed-ai-actions.test.ts test/admin-managed-ai-read-models.test.ts test/admin-routes.test.ts
graphify update .
```

If server source under `packages/server/src` is not modified, no server binary rebuild is required.
