# Codex Model Catalog Dropdown Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show admins a usable Codex / ChatGPT model dropdown when assigning AI access, while preserving the existing credential rotation behavior.

**Architecture:** Reuse the existing admin model-list endpoint that already backs the Default model datalist. OpenAI-compatible credentials continue to use live `/models` discovery. Codex OAuth credentials return a gateway-owned catalog with a stable default model, so the UI and any automatic default fill use one source.

**Tech Stack:** TypeScript, Express, static admin UI JavaScript, `node:test`, pnpm workspace scripts.

---

### Task 1: Codex Model Catalog API

**Files:**
- Create: `services/ai-gateway/src/providers/codex-model-catalog.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`
- Test: `services/ai-gateway/test/admin-actions.test.ts`

**Step 1: Write the failing test**

Add a default admin service test that calls `listCredentialModels` for a healthy `codex_oauth` credential and expects a non-empty list containing the catalog default model.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/admin-actions.test.ts
```

Expected: FAIL with `invalid_custom_provider_config`, because Codex credentials are not handled by the model-list endpoint yet.

**Step 3: Implement minimal code**

Add a Codex model catalog module exporting the ordered model list and default model. In `listCredentialModels`, return the catalog list for `codex_oauth` credentials before reading OpenAI-compatible secrets.

**Step 4: Run test to verify it passes**

Run the same focused test command. Expected: PASS.

### Task 2: Admin UI Uses Catalog For Codex

**Files:**
- Modify: `services/ai-gateway/public-admin/app.js`
- Test: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write the failing test**

Assert that the served admin script refreshes model options for `codex_oauth` credentials, not only `openai_compatible`, and applies a returned default model when the field is empty.

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/admin-ui.test.ts
```

Expected: FAIL because `refreshSelectedAiAccessModels` currently clears options unless the provider is `openai_compatible`.

**Step 3: Implement minimal code**

Allow `refreshSelectedAiAccessModels` for both providers. Cache models by credential ID as today, populate the same datalist, and prefill the default model only when the current default model field is empty.

**Step 4: Run test to verify it passes**

Run the same focused test command. Expected: PASS.

### Task 3: Verification

**Files:**
- Existing test files only unless regressions reveal missing coverage.

**Step 1: Run focused tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/admin-actions.test.ts test/admin-ui.test.ts test/admin-openai-compatible.test.ts
```

Expected: PASS.

**Step 2: Run full gateway checks**

Run:

```bash
pnpm --filter @neatech/ai-gateway test
pnpm --filter @neatech/ai-gateway build
```

Expected: PASS.
