# AI Gateway Alert Email Delivery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make standalone AI Gateway send real Codex capacity alert e-mails for urgent and critical alert states.

**Architecture:** Keep alert rendering in the existing AI Gateway admin and add backend delivery in the AI Gateway process. The backend monitor builds capacity alerts from the credential read model, sends only e-mail-worthy states, records delivery attempts as audit events, and deduplicates per alert and recipient.

**Tech Stack:** TypeScript, Node test runner, Express AI Gateway service, Lettr HTTPS email API, MySQL-backed audit repository.

---

### Task 1: Add Alert Email Configuration

**Files:**
- Modify: `services/ai-gateway/src/env.ts`
- Test: `services/ai-gateway/test/env.test.ts`

**Steps:**
1. Add failing tests for `LETTR_API_KEY`, `AUTH_EMAIL_ADDRESS`, `AUTH_EMAIL_FROM_NAME`, `AI_GATEWAY_ALERT_EMAIL_RECIPIENTS`, and `AI_GATEWAY_CODEX_CAPACITY_ALERT_EMAIL_INTERVAL_MS`.
2. Run the env test and confirm it fails.
3. Parse sender settings and normalize recipient lists to unique lowercase e-mails.
4. Run the env test and confirm it passes.

### Task 2: Add Lettr Alert Mailer

**Files:**
- Create: `services/ai-gateway/src/email/admin-alert-mailer.ts`
- Test: `services/ai-gateway/test/alert-mailer.test.ts`

**Steps:**
1. Add a failing test for the Lettr payload and disabled configuration.
2. Run the mailer test and confirm it fails on the missing module.
3. Implement the Lettr sender with a 30s timeout and explicit missing-config errors.
4. Run the mailer test and confirm it passes.

### Task 3: Add Capacity Alert Monitor

**Files:**
- Create: `services/ai-gateway/src/alerts/codex-capacity-monitor.ts`
- Test: `services/ai-gateway/test/codex-capacity-alert-monitor.test.ts`

**Steps:**
1. Add failing tests for urgent/critical sends, visibility alerts, dedupe, failed-recipient retry, and overlapping-run suppression.
2. Run the monitor test and confirm it fails on the missing module.
3. Implement monitor runner using existing capacity alert builders and audit events.
4. Run the monitor test and confirm it passes.

### Task 4: Wire Default Admin Service and Startup

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/src/index.ts`
- Test: `services/ai-gateway/test/admin-alerts.test.ts`

**Steps:**
1. Add a failing service-level test proving the default admin service can send alert e-mails through the monitor.
2. Run the focused admin alert tests and confirm the new test fails.
3. Add `runCodexCapacityAlertEmailMonitor` to the default admin service.
4. Start the monitor from `startServer()` only when Lettr and recipients are configured.
5. Run the focused tests and confirm they pass.

### Task 5: Document Deployment Contract

**Files:**
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/features/session-runtime.md`
- Modify: `packaging/owned-server/README.md`
- Modify: `packaging/owned-server/compose.yml`
- Modify: `packaging/owned-server/env.example`
- Modify: `packaging/owned-server/env.staging.example`
- Modify: `packaging/docker/docker-compose.dev.yml`

**Steps:**
1. Document that standalone AI Gateway alert emails require Lettr sender env and `AI_GATEWAY_ALERT_EMAIL_RECIPIENTS`.
2. Add the new env vars to owned-server and dev Compose surfaces.
3. Run AI Gateway tests and build.
