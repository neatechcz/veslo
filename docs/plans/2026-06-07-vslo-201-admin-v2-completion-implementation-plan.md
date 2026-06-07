# VSLO-201 Admin V2 Completion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Finish the confirmed missing parts of the VSLO-201 Pencil V2 AI Gateway admin experience in the canonical `/admin` UI.

**Architecture:** Keep the existing static AI Gateway admin shell in `services/ai-gateway/public-admin`. Fix browser routing and modal state locally in `app.js`, add the missing modal HTML in `index.html`, and cover the behavior with source/contract tests plus browser smoke verification.

**Tech Stack:** Vanilla HTML/CSS/JavaScript admin UI, Node `tsx --test`, Express AI Gateway admin tests, DEN admin runtime tests, Playwright browser automation.

---

### Task 1: Add Admin UI Regression Tests

**Files:**
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Steps:**
1. Add source-level tests proving platform navigation includes `Overview`.
2. Add source-level tests proving route initialization re-applies active page after session bootstrap.
3. Add source-level tests proving route-changing modal actions close open dialogs.
4. Add source-level tests proving organization domain and invite create/edit use modal shells instead of inline add forms.
5. Add source-level tests proving organization-admin Users UI hides platform-admin filter/copy and AI-access footer copy.
6. Run `pnpm --filter @neatech/ai-gateway test -- test/admin-ui.test.ts` and confirm new tests fail before implementation.

### Task 2: Fix Navigation And Direct Deep Links

**Files:**
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/app.css` if needed

**Steps:**
1. Add a visible `Overview` nav item for platform admins.
2. Keep organization admins restricted to `Organization` and `Users`.
3. After successful session bootstrap, call the route/page activation path for the current URL so direct loads of `/admin/credentials`, `/admin/usage`, `/admin/alerts`, and `/admin/audit` reveal the correct panel.
4. Keep `/admin` mapped to Overview and active in the nav.
5. Run focused admin UI tests.

### Task 3: Close Modals On Route And Lifecycle Actions

**Files:**
- Modify: `services/ai-gateway/public-admin/app.js`
- Test: `services/ai-gateway/test/admin-ui.test.ts`

**Steps:**
1. Add a small helper to close all open admin dialogs.
2. Use it when route navigation is triggered from buttons inside modals, including credential `Open alerts` and alert `Open audit`.
3. Close or refresh the alert detail modal after successful `Resolve`; prefer closing after terminal resolve.
4. Keep non-routing modal edits unchanged.
5. Run focused admin UI tests.

### Task 4: Convert Organization Domain And Invite Workflows To Modals

**Files:**
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/app.css`
- Test: `services/ai-gateway/test/admin-ui.test.ts`

**Steps:**
1. Replace inline domain add fields with an `Add domain` command that opens a domain modal.
2. Make existing domain rows open the same domain modal for enabled/self-signup editing.
3. Keep `Remove` as a command action with confirmation.
4. Replace inline invite create fields with a `Send invite` command that opens an invite modal.
5. Keep invite `Resend` and `Revoke` as command actions with confirmation for revoke.
6. Ensure no domain or invite change persists before modal Save/Send.
7. Run focused admin UI tests.

### Task 5: Clean Up Organization Admin Users UX

**Files:**
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/index.html` if necessary
- Test: `services/ai-gateway/test/admin-ui.test.ts`

**Steps:**
1. Hide the `Platform admin` role filter option for organization admins.
2. Avoid presenting platform-admin management language in organization-admin user rows.
3. Replace the user modal footer copy for organization admins so it only references organization membership changes.
4. Keep platform admin user management unchanged.
5. Run focused admin UI tests.

### Task 6: Verification And Browser Smoke

**Files:**
- Modify tests only if smoke reveals a missing stable selector or fixture mismatch.

**Steps:**
1. Run `pnpm --filter @neatech/ai-gateway test -- test/admin-ui.test.ts test/admin-read-models.test.ts`.
2. Run `pnpm --dir services/den exec tsx --test test/admin-runtime-bootstrap.test.ts test/admin-managed-ai-read-models.test.ts`.
3. Start a local admin test server or mock with the real admin response shape.
4. Browser-test platform admin:
   - `/admin` has Overview active in nav.
   - Direct deep links reveal their panels.
   - credential `Open alerts` closes credential modal.
   - alert `Open audit` closes alert modal.
   - alert `Resolve` does not leave stale active detail.
   - domain and invite workflows are modal-based.
5. Browser-test organization admin:
   - only Organization and Users nav are visible.
   - seat limit is hidden.
   - Users has no Create user.
   - platform-admin filter/management copy is absent.
6. Repeat fixes until all checks pass.
