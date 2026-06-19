# Codex Auth Upload Helper Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a portal-assisted local helper flow for reconnecting Codex OAuth credentials.

**Architecture:** DEN managed-AI remains the authoritative runtime. Admin UI creates short-lived upload sessions for a selected `codex_oauth` credential; the local script creates a dedicated Codex login, validates `auth.json`, then uploads it to the one-time endpoint. The server replaces the encrypted credential secret and records audit state.

**Tech Stack:** Express admin routes, MySQL-backed managed-AI repositories, static admin JS, Node script, node:test, Playwright test scaffold.

---

### Task 1: API Contract Tests

**Files:**
- Modify: `services/den/test/admin-managed-ai-credentials.test.ts`

**Steps:**
1. Add a failing test proving `PATCH /admin/api/credentials/:credentialId` renames a credential.
2. Add a failing test proving `POST /admin/api/credentials/:credentialId/codex-auth-upload-session` returns a short-lived command payload only for platform admins and `codex_oauth` credentials.
3. Add a failing test proving `POST /admin/api/credentials/codex-auth-upload/:token` replaces the encrypted `codex_auth_json`, marks the credential healthy, records audit, and rejects token reuse.
4. Run the targeted test and confirm failures are for missing endpoints/repository methods.

### Task 2: Server Implementation

**Files:**
- Modify: `services/den/src/managed-ai/credentials/repository.ts`
- Modify: `services/den/src/managed-ai/credentials/mysql-repository.ts`
- Modify: `services/den/src/managed-ai/http/admin.ts`

**Steps:**
1. Add repository methods for credential rename and reconnect secret replacement.
2. Implement in-memory upload-session storage with expiry and one-time consumption.
3. Add admin routes for rename, upload-session creation, and token upload.
4. Run targeted tests until green.

### Task 3: Local Helper Script

**Files:**
- Create: `scripts/admin/codex-auth-upload.mjs`
- Create/modify tests as needed under `scripts/admin/` or `services/den/test/`.

**Steps:**
1. Add a failing test for auth JSON validation and upload payload creation.
2. Implement CLI parsing for upload URL/token, credential id/name, profile directory, and dry-run.
3. Run `codex login --device-auth` inside isolated `CODEX_HOME` unless an existing auth JSON path is supplied for tests.
4. Validate required `auth.json` fields, print `account_id`, require confirmation unless `--yes`, and upload via `fetch`.
5. Run script tests.

### Task 4: Admin UI

**Files:**
- Modify: `services/den/public-admin/index.html`
- Modify: `services/den/public-admin/app.js`
- Modify: `services/den/test/admin-managed-ai-ui.test.ts`

**Steps:**
1. Add failing UI source tests for rename controls and generated helper command.
2. Add rename action on credential detail.
3. Add reconnect command generation for Codex credentials.
4. Run UI tests.

### Task 5: Live Playwright Scaffold

**Files:**
- Create: `packages/e2e/specs/live-admin-codex-auth-upload.spec.ts`
- Update package script if needed.

**Steps:**
1. Add a skipped/guarded live spec that opens the production admin, selects `Vaclav CODEX`, clicks the reconnect command action, and invokes the local helper in dry-run/test-auth-json mode.
2. Guard the spec behind explicit live env vars so CI does not mutate production accidentally.
3. Run source/unit tests; run live spec only when required env vars are present.

### Task 6: Docs and Deployment

**Files:**
- Modify: `docs/admin-managed-ai-access.md`

**Steps:**
1. Document the portal-assisted helper workflow.
2. Build/test DEN.
3. Deploy to the owned server.
4. Run a production smoke check without uploading a real token unless the admin confirms.
