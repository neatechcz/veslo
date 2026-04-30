# VSLO-133 Inference OAuth Utilization and Rotation Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make OAuth-backed inference credential assignment utilization-aware in both DEN managed-AI and the standalone AI Gateway, with admin visibility for rotated and exhausted Codex credentials.

**Architecture:** Extend usage accounting to include org, cached, and total token data. Add shared-by-shape Codex limit eligibility helpers in both services, use them during credential selection, and surface eligibility state in the standalone AI Gateway admin UI. Keep temporary Codex exhaustion separate from permanent credential health failures.

**Tech Stack:** TypeScript, Express, Drizzle/MySQL, Node test runner through `tsx`, Codex CLI worker/status probes, static admin HTML/CSS/JS.

---

## Execution Notes

- Use @superpowers:test-driven-development for each task.
- Work from repo root: `/home/michal/my_projects/veslo`.
- Do not start `packages/web`, raw Vite, or desktop runtime for the unit/API slices.
- Keep DEN and standalone AI Gateway behavior aligned. Prefer matching type names and error codes even where files differ.
- Do not log or return auth JSON, access tokens, refresh tokens, prompts, or completions.
- Treat Codex 5-hour/weekly exhaustion as temporary selection ineligibility, not as `unhealthy` or `revoked`.
- Final implementation should run focused tests for both services and then both service builds.

## Task 1: Extend Standalone AI Gateway Usage Accounting Contract

**Files:**
- Modify: `services/ai-gateway/src/db/schema.ts`
- Create: `services/ai-gateway/drizzle/0001_vslo_133_usage_accounting.sql`
- Modify: `services/ai-gateway/src/usage/repository.ts`
- Modify: `services/ai-gateway/src/usage/mysql-repository.ts`
- Modify: `services/ai-gateway/test/proxy-usage.test.ts`

**Step 1: Write the failing usage contract test**

In `services/ai-gateway/test/proxy-usage.test.ts`, update the successful OpenAI usage assertion to expect:

```ts
{
  requestId: "openai_req_usage_1",
  ownerUserId: "user_gateway",
  orgId: null,
  provider: "openai",
  sessionId: "session_openai_usage_1",
  credentialId: "cred_openai_1",
  bindingId: "binding_openai_primary",
  model: "gpt-4o-mini",
  inputTokens: 11,
  outputTokens: 7,
  cachedTokens: 0,
  totalTokens: 18,
}
```

Also add `usage.total_tokens: 18` to the fake upstream response body.

**Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/proxy-usage.test.ts
```

Expected: FAIL because `RecordUsageInput` and repository writes do not include `orgId`, `cachedTokens`, or `totalTokens`.

**Step 3: Extend the usage table schema**

In `services/ai-gateway/src/db/schema.ts`, add nullable `org_id` and token columns:

```ts
org_id: varchar("org_id", { length: 64 }),
cached_tokens: int("cached_tokens").notNull().default(0),
total_tokens: int("total_tokens").notNull().default(0),
```

Add indexes:

```ts
index("credential_usage_event_org_provider").on(table.org_id, table.provider),
index("credential_usage_event_credential_created").on(table.credential_record_id, table.created_at),
```

**Step 4: Add the SQL migration**

Create `services/ai-gateway/drizzle/0001_vslo_133_usage_accounting.sql`:

```sql
ALTER TABLE `credential_usage_event`
  ADD COLUMN `org_id` varchar(64),
  ADD COLUMN `cached_tokens` int NOT NULL DEFAULT 0,
  ADD COLUMN `total_tokens` int NOT NULL DEFAULT 0;
--> statement-breakpoint
UPDATE `credential_usage_event`
SET `total_tokens` = `input_tokens` + `output_tokens`
WHERE `total_tokens` = 0;
--> statement-breakpoint
CREATE INDEX `credential_usage_event_org_provider` ON `credential_usage_event` (`org_id`, `provider`);
--> statement-breakpoint
CREATE INDEX `credential_usage_event_credential_created` ON `credential_usage_event` (`credential_record_id`, `created_at`);
```

**Step 5: Extend the repository contract**

In `services/ai-gateway/src/usage/repository.ts`, change `RecordUsageInput`:

```ts
export type RecordUsageInput = {
  requestId: string;
  ownerUserId: string;
  orgId?: string | null;
  provider: string;
  sessionId: string;
  credentialId: string;
  bindingId: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedTokens?: number;
  totalTokens?: number;
};
```

**Step 6: Persist the new fields**

In `services/ai-gateway/src/usage/mysql-repository.ts`, write the new columns:

```ts
const inputTokens = input.inputTokens ?? 0;
const outputTokens = input.outputTokens ?? 0;
const cachedTokens = input.cachedTokens ?? 0;
const totalTokens = input.totalTokens ?? inputTokens + outputTokens;
```

Use those values in `.insert(...).values(...)`.

**Step 7: Update aggregate totals**

Use `row.total_tokens` when present instead of recomputing from input plus output. Add `orgId` to the internal event row and implement `groupBy === "org"` from `org_id`, falling back to `"unknown-org"`.

**Step 8: Run the focused test and confirm GREEN**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/proxy-usage.test.ts
```

Expected: PASS.

## Task 2: Add Standalone AI Gateway Token Accounting Helpers

**Files:**
- Create: `services/ai-gateway/src/usage/token-accounting.ts`
- Create: `services/ai-gateway/test/token-accounting.test.ts`
- Modify: `services/ai-gateway/src/http/providers/openai.ts`
- Modify: `services/ai-gateway/src/http/providers/anthropic.ts`

**Step 1: Write helper tests**

Create tests for:

```ts
assert.deepEqual(readOpenAiCompatibleUsage({
  usage: {
    prompt_tokens: 20,
    completion_tokens: 5,
    total_tokens: 25,
    prompt_tokens_details: { cached_tokens: 12 },
  },
}), {
  inputTokens: 20,
  outputTokens: 5,
  cachedTokens: 12,
  totalTokens: 25,
});
```

Also test `input_tokens`, `output_tokens`, missing usage, and Anthropic `usage.input_tokens/output_tokens`.

**Step 2: Run tests and confirm RED**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/token-accounting.test.ts
```

Expected: FAIL because the helper does not exist.

**Step 3: Implement the helper**

Add:

```ts
export type TokenUsageAccounting = {
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
};

export function readOpenAiCompatibleUsage(body: unknown): TokenUsageAccounting | null;
export function readAnthropicUsage(body: unknown): TokenUsageAccounting | null;
```

Implementation rules:

- accept finite numeric fields only
- OpenAI input: `prompt_tokens` then `input_tokens`
- OpenAI output: `completion_tokens` then `output_tokens`
- cached: nested `cached_tokens` under prompt/input token details
- total: `total_tokens`, else input plus output
- return null when no usage object exists

**Step 4: Wire OpenAI and Anthropic routes**

Replace local `getOpenAiUsage()` and `getAnthropicUsage()` logic with the helper. Pass all four token fields to `recordUsage`.

**Step 5: Run focused tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/token-accounting.test.ts test/proxy-usage.test.ts
```

Expected: PASS.

## Task 3: Add Standalone AI Gateway Codex Worker Usage Extraction

**Files:**
- Modify: `services/ai-gateway/src/providers/codex-cli-worker-transport.ts`
- Modify: `services/ai-gateway/test/codex-cli-worker-transport.test.ts`
- Modify: `services/ai-gateway/src/http/providers/codex-oauth.ts`
- Modify: `services/ai-gateway/test/codex-oauth-proxy.test.ts`

**Step 1: Add a failing Codex worker test**

In `services/ai-gateway/test/codex-cli-worker-transport.test.ts`, add a `spawnCodex` result with stdout or session log text that includes a `token_count` payload:

```ts
const tokenCountLine = JSON.stringify({
  payload: {
    type: "token_count",
    info: {
      input_tokens: 30,
      output_tokens: 9,
      total_tokens: 39,
      cached_tokens: 21,
    },
  },
});
```

Expected response body should include:

```ts
usage: {
  prompt_tokens: 30,
  completion_tokens: 9,
  total_tokens: 39,
  prompt_tokens_details: {
    cached_tokens: 21,
  },
}
```

**Step 2: Run and confirm RED**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-cli-worker-transport.test.ts
```

Expected: FAIL because Codex worker always returns `usage: null`.

**Step 3: Implement Codex token extraction**

Add a parser near the existing Codex worker helpers:

```ts
function readCodexTokenUsageFromText(text: string): TokenUsageAccounting | null
```

Scan JSON lines from newest to oldest. Support:

- `payload.type === "token_count"`
- nested `payload.info`
- direct fields `input_tokens`, `output_tokens`, `cached_tokens`, `total_tokens`
- fallback total = input + output

Use stdout first. If a later implementation reads session JSONL files, keep the same parser.

**Step 4: Return OpenAI-compatible usage**

In `chatCompletions()`, set:

```ts
usage: usage
  ? {
      prompt_tokens: usage.inputTokens,
      completion_tokens: usage.outputTokens,
      total_tokens: usage.totalTokens,
      prompt_tokens_details: { cached_tokens: usage.cachedTokens },
    }
  : null,
```

**Step 5: Update Codex proxy usage recording**

In `services/ai-gateway/src/http/providers/codex-oauth.ts`, use `readOpenAiCompatibleUsage()` against the worker response body and pass all token fields to `recordUsage`.

**Step 6: Run focused tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-cli-worker-transport.test.ts test/codex-oauth-proxy.test.ts
```

Expected: PASS.

## Task 4: Add Standalone AI Gateway Codex Eligibility Helpers

**Files:**
- Create: `services/ai-gateway/src/usage/codex-eligibility.ts`
- Create: `services/ai-gateway/test/codex-eligibility.test.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`

**Step 1: Write eligibility tests**

Cover:

- five-hour `usedPercent: 100` is exhausted
- weekly `usedPercent: 100` is exhausted
- reset time in the past is not exhausted by stale status alone
- unknown limits are eligible
- unavailable status with `invalid_grant` is permanently ineligible
- unavailable status with generic probe failure is eligible

**Step 2: Run and confirm RED**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-eligibility.test.ts
```

Expected: FAIL because the module does not exist.

**Step 3: Implement helper API**

Add:

```ts
export type CodexCredentialEligibility =
  | { eligible: true; state: "eligible"; reason: null }
  | { eligible: false; state: "exhausted"; reason: string; resetAt: string | null }
  | { eligible: false; state: "unavailable"; reason: string; resetAt: null };

export function evaluateCodexCredentialEligibility(
  status: CodexUsageStatus,
  now: Date = new Date(),
): CodexCredentialEligibility
```

**Step 4: Replace admin eligibility regex**

In `services/ai-gateway/src/http/admin.ts`, replace direct `isCodexStatusEligibleForAssignment()` logic with the helper. Preserve the current behavior where healthy probes with unknown limits are assignable.

**Step 5: Run admin tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-eligibility.test.ts test/admin-actions.test.ts test/admin-user-access.test.ts
```

Expected: PASS.

## Task 5: Make Standalone AI Gateway Binding Selection Utilization-Aware

**Files:**
- Modify: `services/ai-gateway/src/credentials/repository.ts`
- Modify: `services/ai-gateway/src/credentials/mysql-repository.ts`
- Modify: `services/ai-gateway/src/leases/binding-selector.ts`
- Modify: `services/ai-gateway/test/binding-selector.test.ts`
- Modify: `services/ai-gateway/test/proxy.test.ts`

**Step 1: Add failing selector tests**

Add tests proving:

- exhausted Codex binding is skipped when another healthy binding exists
- unknown limits remain selectable
- all exhausted Codex bindings throw `no_eligible_codex_credentials`
- `requiredBindingId` returns that binding without fallback, so the proxy can fail explicitly

Use a fake repository that returns bindings with attached credential ids and a fake status provider map.

**Step 2: Run and confirm RED**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/binding-selector.test.ts
```

Expected: FAIL because `DefaultBindingSelector` only rotates eligible bindings by repository order.

**Step 3: Extend repository read model**

Add optional repository method:

```ts
listRecentCredentialUsage?(input: {
  credentialIds: string[];
  since: Date;
}): Promise<Array<{
  credentialId: string;
  totalTokens: number;
  requestCount: number;
}>>;
```

Implement it in MySQL with `credential_usage_event.total_tokens`.

**Step 4: Extend DefaultBindingSelector dependencies**

Allow constructor deps:

```ts
type DefaultBindingSelectorDeps = {
  credentials: CredentialRepository;
  codexStatusProvider?: CodexCredentialStatusProvider;
  now?: () => Date;
};
```

Keep backward compatibility by accepting a raw `CredentialRepository` and normalizing internally.

**Step 5: Implement Codex candidate filtering**

For `provider === "codex_oauth"` and no `requiredBindingId`:

- list healthy bindings for `bindingOwnerUserId`
- fetch status by credential id/name when a provider exists
- evaluate eligibility
- drop exhausted/unavailable permanent candidates
- sort by active leases if available, then recent total tokens, then createdAt

If none remain, throw:

```ts
throw new Error("no_eligible_codex_credentials:all_codex_credentials_exhausted");
```

**Step 6: Run focused tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/binding-selector.test.ts test/proxy.test.ts
```

Expected: PASS.

## Task 6: Return Explicit Standalone AI Gateway Exhaustion Failures

**Files:**
- Modify: `services/ai-gateway/src/http/providers/codex-oauth.ts`
- Modify: `services/ai-gateway/test/codex-oauth-proxy.test.ts`

**Step 1: Add failing proxy tests**

Add tests for:

- assigned Codex credential is exhausted and returns HTTP 503 with `no_eligible_codex_credentials`
- all auto-selectable Codex credentials are exhausted and returns HTTP 503 with `all_codex_credentials_exhausted`

**Step 2: Run and confirm RED**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-oauth-proxy.test.ts
```

Expected: FAIL because selector errors currently fall into generic proxy failure.

**Step 3: Map selector errors**

In the Codex proxy catch block, map known selector errors:

```ts
if (message.startsWith("no_eligible_codex_credentials")) {
  res.status(503).json({
    error: "no_eligible_codex_credentials",
    reason: message.includes("all_codex_credentials_exhausted")
      ? "all_codex_credentials_exhausted"
      : "no_eligible_binding",
    provider: "codex_oauth",
  });
  return;
}
```

**Step 4: Run focused tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-oauth-proxy.test.ts
```

Expected: PASS.

## Task 7: Show Standalone AI Gateway Rotation State In Admin

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/test/admin-read-models.test.ts`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Add failing read-model tests**

In admin read-model tests, assert Codex credentials include:

```ts
eligibility: {
  state: "exhausted",
  reason: "5h limit exhausted",
  resetAt: "2026-04-30T18:00:00.000Z",
}
```

Also assert usage includes `cachedTokens` and `totalTokens`.

**Step 2: Add failing UI source tests**

Assert the admin shell/script contains:

- `Cached tokens`
- `Eligibility`
- `renderCredentialEligibility`
- `all_codex_credentials_exhausted`

**Step 3: Run and confirm RED**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-read-models.test.ts test/admin-ui.test.ts
```

Expected: FAIL until read models and static admin UI are extended.

**Step 4: Extend admin records**

Add optional fields to Codex credential read models:

```ts
cachedTokens: number;
totalTokens: number;
eligibility?: {
  state: "eligible" | "exhausted" | "unavailable" | "unhealthy" | "draining" | "revoked";
  reason: string | null;
  resetAt: string | null;
};
```

**Step 5: Render the fields**

Add compact admin table columns for cached tokens and eligibility. Use existing status-chip styles; do not introduce a new visual system.

**Step 6: Run focused tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-read-models.test.ts test/admin-ui.test.ts
```

Expected: PASS.

## Task 8: Port Usage Accounting Contract To DEN Managed-AI

**Files:**
- Modify: `services/den/src/managed-ai/schema.ts`
- Modify: `services/den/src/managed-ai/usage/repository.ts`
- Modify: `services/den/src/managed-ai/usage/mysql-repository.ts`
- Modify: `services/den/test/managed-ai-proxy-usage.test.ts`
- Modify: `services/den/test/admin-managed-ai-read-models.test.ts`

**Step 1: Add failing DEN usage tests**

Mirror the standalone gateway usage expectations:

```ts
orgId: null,
cachedTokens: 0,
totalTokens: 18,
```

Also add one aggregate test for `groupBy=org` returning an org bucket when rows have `org_id`.

**Step 2: Run and confirm RED**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/managed-ai-proxy-usage.test.ts test/admin-managed-ai-read-models.test.ts
```

Expected: FAIL because DEN usage records do not include these fields.

**Step 3: Update DEN managed-AI schema and repository**

Make the same schema and repository changes as Task 1, using DEN file paths. If DEN and standalone gateway share the same managed-AI database, keep column names identical.

**Step 4: Add startup/schema compatibility if needed**

If tests or deployment review show DEN can start against a database that has not run the AI Gateway migration, add idempotent reconciliation for these usage columns in DEN startup. Keep this focused to `credential_usage_event`.

**Step 5: Run focused tests**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/managed-ai-proxy-usage.test.ts test/admin-managed-ai-read-models.test.ts
```

Expected: PASS.

## Task 9: Port Token Accounting and Codex Usage Extraction To DEN

**Files:**
- Create: `services/den/src/managed-ai/usage/token-accounting.ts`
- Create: `services/den/test/managed-ai-token-accounting.test.ts`
- Modify: `services/den/src/managed-ai/http/providers/openai.ts`
- Modify: `services/den/src/managed-ai/http/providers/anthropic.ts`
- Modify: `services/den/src/managed-ai/http/providers/codex-oauth.ts`
- Modify: `services/den/src/managed-ai/providers/codex-cli-worker-transport.ts`
- Modify: `services/den/test/managed-ai-codex-cli-worker-transport.test.ts`
- Modify: `services/den/test/managed-ai-codex-oauth-proxy.test.ts`

**Step 1: Copy the token-accounting tests by behavior**

Use DEN imports, but keep the same test cases as the standalone gateway helper.

**Step 2: Run and confirm RED**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/managed-ai-token-accounting.test.ts
```

Expected: FAIL because the helper does not exist.

**Step 3: Implement the DEN helper**

Implement the same API:

```ts
readOpenAiCompatibleUsage(body)
readAnthropicUsage(body)
```

**Step 4: Wire all DEN providers**

Use the helper in OpenAI, Anthropic, and Codex OAuth proxy usage recording. Add Codex worker token-count parsing and OpenAI-compatible `usage` output exactly like the standalone gateway.

**Step 5: Run focused tests**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/managed-ai-token-accounting.test.ts test/managed-ai-codex-cli-worker-transport.test.ts test/managed-ai-codex-oauth-proxy.test.ts test/managed-ai-proxy-usage.test.ts
```

Expected: PASS.

## Task 10: Port Codex Limit Status and Eligibility To DEN

**Files:**
- Create: `services/den/src/managed-ai/usage/codex-status.ts`
- Create: `services/den/src/managed-ai/usage/codex-eligibility.ts`
- Create: `services/den/test/managed-ai-codex-status.test.ts`
- Create: `services/den/test/managed-ai-codex-eligibility.test.ts`
- Modify: `services/den/src/managed-ai/runtime/default-runtime.ts`
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Modify: `services/den/test/admin-managed-ai-user-access.test.ts`

**Step 1: Port status parser tests**

Use the existing standalone AI Gateway `codex-status` behavior as the source shape:

- parse nested rate-limit snapshots
- support string numbers
- expose 5-hour and weekly windows
- successful probe with unknown limits is available

**Step 2: Port eligibility tests**

Use the same cases from Task 4.

**Step 3: Run and confirm RED**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/managed-ai-codex-status.test.ts test/managed-ai-codex-eligibility.test.ts
```

Expected: FAIL because DEN does not have these modules.

**Step 4: Implement DEN status provider**

Copy/adapt the standalone gateway status provider, changing env names to `MANAGED_AI_CODEX_*`:

- `MANAGED_AI_CODEX_COMMAND`
- `MANAGED_AI_CODEX_WORKDIR`
- `MANAGED_AI_CODEX_TIMEOUT_MS`

Load credential auth JSON through DEN `SecretStore`.

**Step 5: Add the provider to runtime/admin dependencies**

Extend default runtime/admin dependencies so admin user-access APIs can ask which Codex credentials are eligible.

**Step 6: Run focused tests**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/managed-ai-codex-status.test.ts test/managed-ai-codex-eligibility.test.ts test/admin-managed-ai-user-access.test.ts
```

Expected: PASS.

## Task 11: Make DEN Binding Selection Utilization-Aware

**Files:**
- Modify: `services/den/src/managed-ai/credentials/repository.ts`
- Modify: `services/den/src/managed-ai/credentials/mysql-repository.ts`
- Modify: `services/den/src/managed-ai/leases/binding-selector.ts`
- Modify: `services/den/src/managed-ai/runtime/default-runtime.ts`
- Modify: `services/den/test/managed-ai-lease-broker.test.ts`
- Modify: `services/den/test/managed-ai-codex-oauth-proxy.test.ts`

**Step 1: Add failing DEN selection tests**

Mirror Task 5 selector cases in DEN paths:

- exhausted Codex binding skipped
- all exhausted throws explicit no-eligible error
- unknown limits remain selectable
- required assigned exhausted credential fails explicitly

**Step 2: Run and confirm RED**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/managed-ai-lease-broker.test.ts test/managed-ai-codex-oauth-proxy.test.ts
```

Expected: FAIL until DEN selector understands Codex utilization.

**Step 3: Implement the same selector behavior**

Keep error codes identical to standalone AI Gateway:

- `no_eligible_codex_credentials`
- `all_codex_credentials_exhausted`

**Step 4: Map DEN proxy errors**

In DEN Codex OAuth proxy, return the same structured HTTP 503 response as standalone AI Gateway for exhaustion failures.

**Step 5: Run focused tests**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/managed-ai-lease-broker.test.ts test/managed-ai-codex-oauth-proxy.test.ts
```

Expected: PASS.

## Task 12: Add DEN Admin Visibility For Eligibility and Rich Usage

**Files:**
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Modify: `services/den/public-admin/index.html`
- Modify: `services/den/public-admin/app.js`
- Modify: `services/den/test/admin-managed-ai-read-models.test.ts`
- Modify: `services/den/test/admin-managed-ai-ui.test.ts`

**Step 1: Add failing read-model and UI tests**

Mirror standalone AI Gateway admin assertions for:

- cached token totals
- total token totals
- Codex eligibility state
- exhausted reason and reset time

**Step 2: Run and confirm RED**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/admin-managed-ai-read-models.test.ts test/admin-managed-ai-ui.test.ts
```

Expected: FAIL until DEN admin read models and static UI are extended.

**Step 3: Implement matching admin fields**

Use the same field names as standalone AI Gateway so future UI consolidation is possible.

**Step 4: Run focused tests**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test test/admin-managed-ai-read-models.test.ts test/admin-managed-ai-ui.test.ts
```

Expected: PASS.

## Task 13: Update Durable Docs

**Files:**
- Modify: `docs/dev/cloud-deployments.md`
- Modify: `docs/features/session-runtime.md`
- Modify: `docs/dev/state-and-config-reference.md`

**Step 1: Document managed-AI routing and visibility**

Add a short note that signed-in identity and assignment come from DEN, while the default managed-AI inference base URL can still be standalone AI Gateway.

**Step 2: Document usage accounting semantics**

Document:

- request/user/org/session/credential usage attribution
- input/output/cached/total token storage
- Codex exhaustion as temporary ineligibility
- permanent auth failures as credential health failures

**Step 3: Run doc/source grep checks**

Run:

```bash
rg -n "cached tokens|all_codex_credentials_exhausted|temporary ineligibility|veslo-ai-gateway-dev" docs/dev docs/features
```

Expected: the new durable docs mention the behavior.

## Task 14: Final Verification

**Files:**
- No code edits unless verification exposes issues.

**Step 1: Run standalone AI Gateway focused tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test \
  test/token-accounting.test.ts \
  test/codex-status.test.ts \
  test/codex-eligibility.test.ts \
  test/binding-selector.test.ts \
  test/proxy-usage.test.ts \
  test/codex-cli-worker-transport.test.ts \
  test/codex-oauth-proxy.test.ts \
  test/admin-read-models.test.ts \
  test/admin-ui.test.ts \
  test/admin-user-access.test.ts
```

Expected: PASS.

**Step 2: Build standalone AI Gateway**

Run:

```bash
pnpm --filter @neatech/ai-gateway build
```

Expected: PASS.

**Step 3: Run DEN focused tests**

Run:

```bash
pnpm --filter @neatech/den exec tsx --test \
  test/managed-ai-token-accounting.test.ts \
  test/managed-ai-codex-status.test.ts \
  test/managed-ai-codex-eligibility.test.ts \
  test/managed-ai-lease-broker.test.ts \
  test/managed-ai-proxy-usage.test.ts \
  test/managed-ai-codex-cli-worker-transport.test.ts \
  test/managed-ai-codex-oauth-proxy.test.ts \
  test/admin-managed-ai-read-models.test.ts \
  test/admin-managed-ai-ui.test.ts \
  test/admin-managed-ai-user-access.test.ts
```

Expected: PASS.

**Step 4: Build DEN**

Run:

```bash
pnpm --filter @neatech/den build
```

Expected: PASS.

**Step 5: Optional live smoke**

If live managed Codex credentials are available and a real prompt is acceptable, run a desktop managed-Codex smoke through the normal Tauri runtime path from `docs/dev/testing-playbook.md`. Do not use `packages/web` or raw Vite as proof.

Expected: A signed-in desktop prompt succeeds when at least one Codex credential is eligible, and returns an actionable exhaustion error when all assigned/eligible Codex credentials are exhausted.
