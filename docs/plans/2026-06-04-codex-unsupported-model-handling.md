# Codex Unsupported Model Handling Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Keep a Codex OAuth credential usable when only one requested model is unsupported for that ChatGPT account.

**Architecture:** Treat upstream "model is not supported when using Codex with a ChatGPT account" responses as credential-available status with a credential-specific unsupported model list. Filter unsupported models from the Codex model catalog returned by the admin model endpoint so assignment UI avoids models that account cannot run.

**Tech Stack:** TypeScript, Node test runner, AI Gateway admin service and Codex status provider.

---

### Task 1: Prove Unsupported Codex Models Do Not Make The Credential Unavailable

**Files:**
- Test: `services/ai-gateway/test/codex-status.test.ts`
- Modify: `services/ai-gateway/src/usage/codex-status.ts`

**Step 1: Write the failing test**

Add a test where the Codex probe returns no rate limits, `ok: false`, and a detail containing `gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.` Assert the returned status is `available: true`, has `source: "codex_exec_no_rate_limits"`, and includes `unsupportedModels: ["gpt-5.3-codex"]`.

**Step 2: Run the focused test**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-status.test.ts
```

Expected: the new test fails because unsupported models are currently reported as unavailable.

**Step 3: Implement minimal status parsing**

Add `unsupportedModels?: string[]` to `CodexUsageStatus`, parse model names from the unsupported-model detail, and return an available unknown-limits status with that unsupported model list.

**Step 4: Verify**

Run the focused test again and expect all tests in `test/codex-status.test.ts` to pass.

### Task 2: Filter Unsupported Models From Admin Codex Model Choices

**Files:**
- Test: `services/ai-gateway/test/admin-actions.test.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`

**Step 1: Write the failing test**

Add a test where `listCredentialModels` for a Codex credential receives status with `unsupportedModels: ["gpt-5.3-codex"]`. Assert the model list excludes `gpt-5.3-codex`, still includes `gpt-5.5`, and keeps the default model valid.

**Step 2: Run the focused test**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-actions.test.ts
```

Expected: the new test fails because Codex model catalog currently returns every static model.

**Step 3: Implement model filtering**

For Codex credentials, load the credential name from the admin credential read model, ask the status provider for the credential status, remove any `unsupportedModels` from the Codex catalog, and choose the existing default when still available or the first remaining model otherwise.

**Step 4: Verify**

Run the focused admin actions test and expect it to pass.

### Task 3: Documentation And Final Verification

**Files:**
- Modify: `docs/admin-managed-ai-access.md`
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Document behavior**

Document that unsupported Codex models are treated as model-specific unavailability, while the credential remains usable with other supported models.

**Step 2: Run final checks**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-status.test.ts test/admin-actions.test.ts
pnpm --filter @neatech/ai-gateway build
```

Expected: focused tests and build pass.
