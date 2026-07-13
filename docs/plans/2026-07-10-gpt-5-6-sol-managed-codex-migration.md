# GPT-5.6 Sol Managed Codex Migration Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Upgrade Veslo's managed Codex backend to `gpt-5.6-sol`, migrate every Codex access policy attached to stored credentials, and prove every authoritative Codex credential plus the real desktop inference path.

**Architecture:** AI Gateway remains the runtime authority for credential selection and inference. The model catalog, status probe, DEN signup default, and stored `user_ai_access_policy` rows move together; encrypted credential secrets remain unchanged unless a real sequential probe rotates or rejects their auth state. Two guarded operator commands provide transactional policy migration and secret-safe per-credential inference, and the owned-server workflow runs them only after a backup.

**Tech Stack:** TypeScript, Node test runner through `tsx`, Drizzle ORM/MySQL, pnpm workspaces, OpenAI Codex CLI, GitHub Actions, Docker Compose, Tauri, Tauri Pilot.

---

## Preconditions and boundaries

- Work only in `.worktrees/gpt-5-6-sol-backend` on branch `codex/gpt-5-6-sol-backend`.
- Do not modify the user's root-worktree `opencode.jsonc`.
- Use `gpt-5.6-sol`, not the moving `gpt-5.6` alias.
- Do not implement a GPT-5.5 fallback.
- Never print credential secrets, access tokens, refresh tokens, database URLs, or secret keys.
- The untouched baseline is recorded as AI Gateway `297/297` passed and DEN `588 passed, 1 skipped, 0 failed`.
- Follow @test-driven-development for every behavior change and @verification-before-completion before every success claim.

### Task 1: Change managed Codex defaults to GPT-5.6 Sol

**Files:**

- Create: `services/ai-gateway/test/codex-model-catalog.test.ts`
- Modify: `services/ai-gateway/src/providers/codex-model-catalog.ts`
- Modify: `services/den/test/managed-ai-signup-assignment.test.ts`
- Modify: `services/den/src/managed-ai/signup-assignment.ts`

**Step 1: Write failing default-model tests**

Create catalog assertions equivalent to:

```ts
import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_DEFAULT_MODEL,
  listCodexModelCatalog,
  resolveCodexModelPolicy,
} from "../src/providers/codex-model-catalog.js";

test("GPT-5.6 Sol is the managed Codex default and first catalog model", () => {
  assert.equal(CODEX_DEFAULT_MODEL, "gpt-5.6-sol");
  assert.equal(listCodexModelCatalog()[0], "gpt-5.6-sol");
  assert.deepEqual(resolveCodexModelPolicy({ defaultModel: null, allowedModels: [] }), {
    defaultModel: "gpt-5.6-sol",
    allowedModels: ["gpt-5.6-sol"],
  });
});
```

Change the DEN signup test to require `DEFAULT_CODEX_AUTO_ASSIGN_MODEL === "gpt-5.6-sol"` and assert that a newly created policy uses it as both default and sole allowed model.

**Step 2: Run tests and verify RED**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-model-catalog.test.ts
pnpm --filter @neatech/den exec tsx --test test/managed-ai-signup-assignment.test.ts
```

Expected: both fail because the current default is `gpt-5.5`.

**Step 3: Implement the minimal default changes**

- Set both default constants to `gpt-5.6-sol`.
- Put `gpt-5.6-sol` first in the AI Gateway catalog.
- Retain older entries for admin visibility only; do not add fallback logic.

**Step 4: Run tests and verify GREEN**

Run the two focused commands again. Expected: pass.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/providers/codex-model-catalog.ts \
  services/ai-gateway/test/codex-model-catalog.test.ts \
  services/den/src/managed-ai/signup-assignment.ts \
  services/den/test/managed-ai-signup-assignment.test.ts
git commit -m "feat: default managed Codex to GPT-5.6 Sol"
```

### Task 2: Generalize Codex runtime incompatibility diagnostics

**Files:**

- Modify: `services/ai-gateway/test/codex-cli-worker-transport.test.ts`
- Modify: `services/ai-gateway/src/providers/codex-cli-worker-transport.ts`
- Modify: `services/den/test/managed-ai-codex-cli-worker-transport.test.ts`
- Modify: `services/den/src/managed-ai/providers/codex-cli-worker-transport.ts`

**Step 1: Write failing GPT-5.6 Sol compatibility tests**

For both transports, replace the hard-coded GPT-5.5-only regression with a GPT-5.6 Sol case:

```ts
test("returns an actionable runtime incompatibility error for an unsupported requested model", async () => {
  const transport = new CodexCliWorkerTransport({
    spawnCodex: async () => ({
      exitCode: 1,
      signal: null,
      timedOut: false,
      finalMessage: "",
      stdout: "",
      stderr: "Error: unknown model gpt-5.6-sol\n",
    }),
  });

  await assert.rejects(
    () => transport.chatCompletions({
      body: { model: "gpt-5.6-sol", messages: [{ role: "user", content: "Say ok." }] },
    }),
    (error) => error instanceof ProviderTransportError &&
      error.message === "codex_runtime_incompatible" &&
      JSON.stringify(error.body).includes("gpt-5.6-sol"),
  );
});
```

Keep/add a negative test proving `codex login required` remains `codex_worker_failed`.

**Step 2: Run tests and verify RED**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-cli-worker-transport.test.ts
pnpm --filter @neatech/den exec tsx --test test/managed-ai-codex-cli-worker-transport.test.ts
```

Expected: the GPT-5.6 Sol case is not classified as runtime incompatibility.

**Step 3: Implement generic requested-model detection**

Replace `isGpt55RuntimeIncompatibility` in both services with logic equivalent to:

```ts
function isRequestedModelRuntimeIncompatibility(input: {
  model: string;
  stderrTail: string | null;
}): boolean {
  const model = input.model.trim().toLowerCase();
  const stderr = input.stderrTail?.toLowerCase() ?? "";
  if (!model || model === "unknown" || !stderr.includes(model)) return false;
  return /(unknown|unsupported|not supported|not found|invalid|unrecognized|unavailable)\s+(?:requested\s+)?model|model\s+(?:is\s+)?(?:unknown|unsupported|not supported|not found|invalid|unrecognized|unavailable)/i.test(stderr) ||
    /(unknown|unsupported|not supported|not found|invalid|unrecognized|unavailable)/i.test(stderr);
}
```

Call it only in the existing failed-worker branch. Preserve the structured error code and message.

**Step 4: Run focused tests and verify GREEN**

Run both commands again. Expected: pass, including the negative auth case.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/providers/codex-cli-worker-transport.ts \
  services/ai-gateway/test/codex-cli-worker-transport.test.ts \
  services/den/src/managed-ai/providers/codex-cli-worker-transport.ts \
  services/den/test/managed-ai-codex-cli-worker-transport.test.ts
git commit -m "fix: detect unsupported Codex models generically"
```

### Task 3: Upgrade the bundled Codex runtime to 0.144.1

**Files:**

- Modify: `services/ai-gateway/test/render-codex-worker.test.ts`
- Modify: `services/den/test/managed-ai-render-codex-worker.test.ts`
- Modify: `services/ai-gateway/package.json`
- Modify: `services/den/package.json`
- Modify: `pnpm-lock.yaml`

**Step 1: Raise the tested runtime floor first**

Change both semver assertions from `0.137.0` to `0.144.1` and rename the tests to mention GPT-5.6 Sol support.

**Step 2: Run tests and verify RED**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/render-codex-worker.test.ts
pnpm --filter @neatech/den exec tsx --test test/managed-ai-render-codex-worker.test.ts
```

Expected: fail because both packages still pin `0.137.0`.

**Step 3: Update package pins and lockfile**

Set both package dependencies to exact `0.144.1`, then run:

```bash
pnpm install --lockfile-only
pnpm install --frozen-lockfile
```

Do not update unrelated dependencies.

**Step 4: Verify installed binaries and tests**

```bash
services/ai-gateway/node_modules/.bin/codex --version
services/den/node_modules/.bin/codex --version
pnpm --filter @neatech/ai-gateway exec tsx --test test/render-codex-worker.test.ts
pnpm --filter @neatech/den exec tsx --test test/managed-ai-render-codex-worker.test.ts
```

Expected: both binaries report `0.144.1`; tests pass.

**Step 5: Commit**

```bash
git add services/ai-gateway/package.json services/den/package.json \
  services/ai-gateway/test/render-codex-worker.test.ts \
  services/den/test/managed-ai-render-codex-worker.test.ts pnpm-lock.yaml
git commit -m "chore: upgrade backend Codex runtime to 0.144.1"
```

### Task 4: Add an idempotent transactional policy migration

**Files:**

- Create: `services/ai-gateway/src/ops/codex-model-migration.ts`
- Create: `services/ai-gateway/src/ops/migrate-codex-model.ts`
- Create: `services/ai-gateway/test/codex-model-migration.test.ts`
- Modify: `services/ai-gateway/package.json`

**Step 1: Write failing migration tests**

Define tests around an injected store with this contract:

```ts
export type CodexPolicySnapshot = {
  id: string;
  userId: string;
  enabled: boolean;
  credentialId: string | null;
  defaultModel: string | null;
  allowedModelsJson: string;
  assignmentOrigin: string;
};

export interface CodexPolicyMigrationStore {
  preview(): Promise<CodexPolicySnapshot[]>;
  apply(input: { model: string; now: Date }): Promise<CodexPolicySnapshot[]>;
}
```

Test all of the following:

- dry run returns matching/changed counts and performs no write;
- apply changes both enabled and disabled `codex_oauth` policies;
- apply preserves credential id and assignment origin;
- allowed models become exactly `["gpt-5.6-sol"]`;
- a second apply reports `changedCount: 0` and does not update timestamps;
- output summaries contain no secret-looking fields.

**Step 2: Run test and verify RED**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-model-migration.test.ts
```

Expected: fail because the operation module does not exist.

**Step 3: Implement migration core and MySQL store**

Use `userAiAccessPolicyTable` and a Drizzle transaction. The apply path must:

```ts
const targetAllowedModelsJson = JSON.stringify([model]);
const rows = await selectCodexPolicies(tx);
const changedIds = rows
  .filter((row) => row.defaultModel !== model || row.allowedModelsJson !== targetAllowedModelsJson)
  .map((row) => row.id);

if (changedIds.length > 0) {
  await tx.update(userAiAccessPolicyTable).set({
    default_model: model,
    allowed_models_json: targetAllowedModelsJson,
    updated_at: now,
  }).where(inArray(userAiAccessPolicyTable.id, changedIds));
}
```

Select by `provider = "codex_oauth"` only; do not filter on `enabled`. Calculate `changedCount` from pre-update snapshots. Validate model ids with `^[a-z0-9][a-z0-9._-]{0,127}$`.

**Step 4: Implement guarded CLI**

`migrate-codex-model.ts` must:

- default `--model` to `CODEX_DEFAULT_MODEL`;
- default to dry run;
- require `--apply` for writes;
- connect through `env.databaseUrl` and always close the DB handle;
- print one JSON summary containing mode, model, matched count, changed count, enabled count, and disabled count;
- never print DB URLs or secrets;
- exit non-zero for invalid arguments or failed transactions.

Add package script:

```json
"ops:codex-model-migration": "node dist/ops/migrate-codex-model.js"
```

**Step 5: Run focused tests and build**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-model-migration.test.ts
pnpm --filter @neatech/ai-gateway build
```

Expected: pass.

**Step 6: Commit**

```bash
git add services/ai-gateway/src/ops services/ai-gateway/test/codex-model-migration.test.ts \
  services/ai-gateway/package.json
git commit -m "feat: add transactional Codex model policy migration"
```

### Task 5: Add a sequential per-credential GPT-5.6 Sol probe

**Files:**

- Create: `services/ai-gateway/src/ops/codex-credential-probe.ts`
- Create: `services/ai-gateway/src/ops/probe-codex-credentials.ts`
- Create: `services/ai-gateway/test/codex-credential-probe.test.ts`
- Modify: `services/ai-gateway/src/usage/codex-status.ts`
- Modify: `services/ai-gateway/test/codex-status.test.ts`
- Modify: `services/ai-gateway/package.json`

**Step 1: Write failing configurable-model and sequencing tests**

Add a status-provider test proving `model: "gpt-5.6-sol"` is passed to the Codex subprocess instead of an inherited CLI default.

Test the probe coordinator with three credentials and an injected status function. Track active calls and assert:

```ts
assert.equal(maxConcurrentCalls, 1);
assert.deepEqual(results.map((entry) => entry.outcome), ["ok", "unsupported_model", "auth_failed"]);
assert.equal(results.length, 3);
assert.doesNotMatch(JSON.stringify(results), /refresh[_-]?token|access[_-]?token|secret/i);
```

Also verify deleted and non-Codex credentials are skipped, while unhealthy non-deleted Codex credentials are still tested and reported.

**Step 2: Run tests and verify RED**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test \
  test/codex-status.test.ts test/codex-credential-probe.test.ts
```

Expected: fail because model injection and the coordinator do not exist.

**Step 3: Make status probes model-configurable**

Add `model?: string` to `CachedCodexCredentialStatusProviderDeps`. Capture:

```ts
const model = deps.model?.trim() || CODEX_DEFAULT_MODEL;
```

Pass it into `runCodexExecRateLimitProbe`; preserve `CODEX_DEFAULT_MODEL` for all existing callers.

**Step 4: Implement sequential credential coordinator**

The coordinator must filter `listAdminCredentials()` to non-deleted `codex_oauth` rows, sort deterministically by id, and use `for...of` with `await`. Classify:

- `ok`: real probe succeeded and target model is not unsupported/exhausted;
- `unsupported_model`: status lists the requested model;
- `usage_exhausted`: eligibility reports exhaustion;
- `auth_failed`: invalid grant/login/token/reused refresh classification;
- `probe_failed`: all other failures.

Continue after every failure and return a non-zero CLI exit only after all results are printed if any credential failed.

**Step 5: Implement runtime CLI wiring**

Use `createDb`, `MySqlCredentialRepository`, `MySqlSecretStore`, and one `CachedCodexCredentialStatusProvider`. Load/save auth through the existing encrypted secret store so token rotations are persisted. Print only:

- model;
- total/passed/failed counts;
- credential id, display name, stored health state, outcome, safe status label, and elapsed milliseconds.

Add package script:

```json
"ops:codex-credential-probe": "node dist/ops/probe-codex-credentials.js"
```

**Step 6: Run focused tests and build**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test \
  test/codex-status.test.ts test/codex-credential-probe.test.ts
pnpm --filter @neatech/ai-gateway build
```

Expected: pass.

**Step 7: Commit**

```bash
git add services/ai-gateway/src/ops services/ai-gateway/src/usage/codex-status.ts \
  services/ai-gateway/test/codex-status.test.ts \
  services/ai-gateway/test/codex-credential-probe.test.ts services/ai-gateway/package.json
git commit -m "feat: probe every managed Codex credential sequentially"
```

### Task 6: Add a guarded backup-migrate-probe deployment path

**Files:**

- Create: `scripts/release/codex-model-rollout-workflow.test.mjs`
- Modify: `.github/workflows/deploy-owned-server.yml`

**Step 1: Write a failing workflow contract test**

Read the workflow as text and assert it contains:

- string input `codex_model_migration` defaulting to empty;
- boolean input `probe_codex_credentials` defaulting to false;
- validation that a model migration requires `run_backup_now=true`;
- migration step after the backup step;
- `ops:codex-model-migration -- --model ... --apply`;
- `ops:codex-credential-probe -- --model ...`;
- no literal credentials or database URLs.

**Step 2: Run test and verify RED**

```bash
node --test scripts/release/codex-model-rollout-workflow.test.mjs
```

Expected: fail because the inputs and operator step are missing.

**Step 3: Add generic workflow inputs and validation**

Add:

```yaml
      codex_model_migration:
        description: "Optional Codex model id to apply to every codex_oauth policy after backup."
        required: false
        type: string
        default: ""
      probe_codex_credentials:
        description: "Run the selected Codex model through every stored Codex credential."
        required: true
        type: boolean
        default: false
```

Reject a non-empty migration model unless `run_backup_now` is true. After the existing verified backup step, run the migration in the `ai-gateway` container and optionally run the sequential probe. Quote the model argument and rely on CLI validation.

**Step 4: Run workflow contract and YAML parse checks**

```bash
node --test scripts/release/codex-model-rollout-workflow.test.mjs
pnpm release:review --json
```

Expected: workflow test passes; release review reports no workflow syntax/config regression.

**Step 5: Commit**

```bash
git add .github/workflows/deploy-owned-server.yml \
  scripts/release/codex-model-rollout-workflow.test.mjs
git commit -m "ci: add guarded Codex model rollout operations"
```

### Task 7: Update canonical behavior and operator documentation

**Files:**

- Modify: `docs/admin-managed-ai-access.md`
- Modify: `docs/features/session-runtime.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/dev/cloud-deployments.md`

**Step 1: Update durable facts**

Document:

- GPT-5.6 Sol / `gpt-5.6-sol` as the catalog and signup default;
- credential records own auth, while policy rows own model selection;
- every Codex policy is migrated, including disabled rows;
- credential probes are sequential and secret-safe;
- unsupported credentials remain assigned to GPT-5.6 Sol with no GPT-5.5 fallback;
- exact dry-run/apply/probe commands;
- backup-before-migration workflow requirement;
- the difference between code deployed, policy migrated, credential tested, and desktop verified.

Do not rewrite historical sandbox evidence that intentionally records GPT-5.5 tests.

**Step 2: Check docs and model references**

```bash
rg -n 'gpt-5\.5|gpt-5\.6-sol|Codex credential|codex_model_migration' \
  docs/admin-managed-ai-access.md docs/features/session-runtime.md \
  docs/dev/state-and-config-reference.md docs/dev/cloud-deployments.md
git diff --check
```

Expected: current-behavior statements use GPT-5.6 Sol; historical references remain scoped.

**Step 3: Commit**

```bash
git add docs/admin-managed-ai-access.md docs/features/session-runtime.md \
  docs/dev/state-and-config-reference.md docs/dev/cloud-deployments.md
git commit -m "docs: document GPT-5.6 Sol credential rollout"
```

### Task 8: Run complete local verification

**Files:** none unless a real regression requires a scoped fix and a new red/green cycle.

**Step 1: Run focused suites**

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test \
  test/codex-model-catalog.test.ts \
  test/codex-cli-worker-transport.test.ts \
  test/codex-status.test.ts \
  test/codex-model-migration.test.ts \
  test/codex-credential-probe.test.ts \
  test/render-codex-worker.test.ts
pnpm --filter @neatech/den exec tsx --test \
  test/managed-ai-signup-assignment.test.ts \
  test/managed-ai-codex-cli-worker-transport.test.ts \
  test/managed-ai-render-codex-worker.test.ts
node --test scripts/release/codex-model-rollout-workflow.test.mjs
```

Expected: all pass.

**Step 2: Run full service suites and builds**

```bash
pnpm --filter @neatech/ai-gateway test
pnpm --filter @neatech/ai-gateway build
pnpm --filter @neatech/den test
pnpm --filter @neatech/den build
pnpm typecheck
```

Expected: zero failures. Record exact counts and any intentional skips.

**Step 3: Verify dependency and diff scope**

```bash
services/ai-gateway/node_modules/.bin/codex --version
services/den/node_modules/.bin/codex --version
git diff --check
git status --short
git diff --stat dev_vaclav...HEAD
```

Expected: Codex `0.144.1`; only planned files differ.

**Step 4: Review before live mutation**

Use @requesting-code-review, resolve only evidence-backed findings, and rerun affected tests.

### Task 9: Deploy, migrate policies, and probe every live credential

**Files:** no new source changes unless live evidence reveals a defect.

**Step 1: Push the verified feature branch**

```bash
git push -u origin codex/gpt-5-6-sol-backend
gh auth status
```

Expected: push succeeds; GitHub auth includes `repo` and `workflow`.

**Step 2: Verify current endpoints before mutation**

```bash
curl -fsS https://ai.staging.veslo.work/health
curl -fsS https://ai.staging.veslo.work/readiness
curl -fsS https://ai.veslo.work/health
curl -fsS https://ai.veslo.work/readiness
```

Record current state. A readiness failure is evidence, not a reason to skip backup.

**Step 3: Stage first when staging SSH/deploy access is available**

Use the staging Compose checkout and env file. Run a backup, deploy the exact feature-branch revision, then execute:

```bash
compose exec -T ai-gateway pnpm --filter @neatech/ai-gateway \
  ops:codex-model-migration -- --model gpt-5.6-sol
compose exec -T ai-gateway pnpm --filter @neatech/ai-gateway \
  ops:codex-model-migration -- --model gpt-5.6-sol --apply
compose exec -T ai-gateway pnpm --filter @neatech/ai-gateway \
  ops:codex-credential-probe -- --model gpt-5.6-sol
```

Expected:

- dry-run and apply matched counts agree;
- post-apply dry-run reports `changedCount: 0`;
- every non-deleted Codex credential appears once in probe output;
- failures are explicit and do not stop later credentials;
- health/readiness recover after deploy.

If staging SSH remains unavailable, report the exact access failure before production. The user accepts temporary inference breakage, but do not falsely claim staging was tested.

**Step 4: Dispatch the guarded production workflow**

```bash
gh workflow run deploy-owned-server.yml \
  --repo neatechcz/veslo \
  --ref codex/gpt-5-6-sol-backend \
  -f branch=codex/gpt-5-6-sol-backend \
  -f install_backup_timer=true \
  -f run_backup_now=true \
  -f codex_model_migration=gpt-5.6-sol \
  -f probe_codex_credentials=true
```

Capture the run id and watch it to completion:

```bash
gh run watch <run-id> --repo neatechcz/veslo --exit-status
gh run view <run-id> --repo neatechcz/veslo --log
```

Expected workflow order: deploy -> endpoint checks -> verified database backup -> transactional policy migration -> sequential credential probe.

**Step 5: Audit live results**

From workflow output or value-free database queries, confirm:

- all `provider='codex_oauth'` policy rows have `default_model='gpt-5.6-sol'`;
- every such `allowed_models_json` is exactly `["gpt-5.6-sol"]`;
- enabled and disabled policy counts are reported;
- credential ids/bindings and assignment origins were preserved;
- every non-deleted Codex credential was probed;
- no secret value appeared in logs;
- the deployed Codex binary reports `0.144.1`.

Run fresh health checks:

```bash
curl -fsS https://ai.veslo.work/health
curl -fsS https://ai.veslo.work/readiness
curl -fsS https://api.veslo.work/health
```

### Task 10: Prove the real Tauri desktop path end to end

**Files:**

- Create or modify only if existing live-inference coverage cannot record three sends:
  - `packages/e2e/pilot-scenarios/gpt-5-6-sol-three-message-roundtrip.toml`
  - `packages/e2e/specs/gpt-5-6-sol-three-message-roundtrip.test.ts`
  - `packages/e2e/helpers/pilot-runner.ts`

**Step 1: Add an E2E contract test before a new scenario if needed**

Require the scenario to:

- use live Den auth and no fixture;
- assert `/ai-gateway/me/ai-access` reports provider `codex_oauth` and model `gpt-5.6-sol`;
- send three unique exact-response prompts in one workspace;
- record the first as `cold run` and runs two/three separately;
- wait for and assert each visible assistant token;
- fail on `Send failed`, `model_not_allowed`, or `codex_runtime_incompatible`;
- avoid direct engine-start debug commands.

Run the contract test first and verify RED, then add the minimal Pilot scenario and rerun to GREEN.

**Step 2: Run mandatory desktop preflight**

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|@tauri-apps/cli/tauri\\.js dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite\\.js|bun --watch src/cli\\.ts|(^|/)target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Stop only internally started dev/test matches, then repeat the check and require no relevant process.

**Step 3: Build the real Pilot-enabled Tauri binary**

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e
```

Expected: build exits 0 and produces the debug Veslo binary.

**Step 4: Run live managed-AI inference with production auth**

```bash
cd ../e2e
VESLO_DEN_AUTH_SNAPSHOT_PATH="$HOME/.veslo/den-auth.json" \
E2E_MANAGED_AI_GATEWAY_FIXTURE=0 \
VESLO_E2E_EXPECTED_MANAGED_AI_PROVIDER=codex_oauth \
VESLO_E2E_EXPECTED_MANAGED_AI_MODEL=gpt-5.6-sol \
pnpm test:pilot:live-inference
```

Then run the dedicated three-message scenario if it was added:

```bash
VESLO_DEN_AUTH_SNAPSHOT_PATH="$HOME/.veslo/den-auth.json" \
E2E_MANAGED_AI_GATEWAY_FIXTURE=0 \
VESLO_E2E_EXPECTED_MANAGED_AI_PROVIDER=codex_oauth \
VESLO_E2E_EXPECTED_MANAGED_AI_MODEL=gpt-5.6-sol \
pnpm test:pilot -- --scenario gpt-5-6-sol-three-message-roundtrip
```

Record workspace id/path, provider/model/variant, exact prompts, cold/warm timings, visible assistant results, and any frontend/server error text.

**Step 5: Final verification and handoff**

Run @verification-before-completion. Re-read the approved design and verify each requirement from fresh command output. Report separately:

- code committed;
- branch pushed;
- backend revision deployed;
- policies migrated;
- each credential probe outcome;
- staging verified or explicitly blocked;
- production health/readiness;
- real desktop E2E result;
- any credential requiring reconnect.

Do not call the task complete while any required live state is unverified.
