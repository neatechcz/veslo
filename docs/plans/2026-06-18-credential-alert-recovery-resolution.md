# Credential Alert Recovery Resolution Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Recovered credential faults should be resolved in the alert lifecycle so expired email throttles do not resend stale incident emails.

**Architecture:** Keep credential health events as immutable history, but derive alert status from the event stream. When a credential has a later `to_state = healthy` event, earlier non-healthy alerts for the same credential are reported as `resolved` even if no manual alert resolve audit exists.

**Tech Stack:** TypeScript, Node test runner, Drizzle-backed MySQL repositories.

---

### Task 1: Add Failing Alert Repository Test

**Files:**
- Create: `services/ai-gateway/test/mysql-alert-repository.test.ts`

**Step 1: Write the failing test**

Add a MySqlAlertRepository unit test with fake DB rows:
- older `codex_refresh_token_reused` event for `cred_1`
- later `admin_reconnect` event to `healthy` for `cred_1`
- optional acknowledge audit row for the old alert

Expected: `listAlerts()` returns the old fault alert with `status: "resolved"`.

**Step 2: Run test to verify it fails**

Run: `pnpm --filter @neatech/ai-gateway test -- test/mysql-alert-repository.test.ts`

Expected: FAIL because the old fault alert is still active or acknowledged.

### Task 2: Resolve Alerts From Later Healthy Events

**Files:**
- Modify: `services/ai-gateway/src/alerts/mysql-repository.ts`

**Step 1: Implement minimal derivation**

In `listAlerts()`, compute latest healthy recovery time by credential from returned health rows. When building any non-healthy alert with a later healthy recovery for the same credential, return it as resolved.

**Step 2: Keep manual actions compatible**

Manual `alert.resolve` still resolves alerts. Manual `alert.acknowledge` must not override a derived recovered status.

**Step 3: Run focused tests**

Run:
- `pnpm --filter @neatech/ai-gateway test -- test/mysql-alert-repository.test.ts`
- `pnpm --filter @neatech/ai-gateway test -- test/credential-alert-email-monitor.test.ts test/admin-alerts.test.ts`

Expected: PASS.

### Task 3: Update Behavior Docs

**Files:**
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/admin-managed-ai-access.md`

**Step 1: Document recovered alert semantics**

Clarify that credential fault emails are sent only for active current faults; later healthy recovery events resolve earlier credential-health fault alerts for email and admin alert status.

**Step 2: Run relevant verification**

Run: `pnpm --filter @neatech/ai-gateway test -- test/mysql-alert-repository.test.ts test/credential-alert-email-monitor.test.ts test/admin-alerts.test.ts`

Expected: PASS.
