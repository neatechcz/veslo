# Codex Limit Status Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Show Codex 5h and weekly limit status on both the hosted AI Gateway Usage and Credentials pages, while keeping healthy-but-unparsed Codex probes separate from real authentication failures.

**Architecture:** Keep `upstreamStatus` as the shared admin read model. Extend the Codex probe/parser so successful probes with missing rate-limit windows become a non-error "limits unknown" state, decorate Codex credentials returned by the Credentials API with the same cached status used by Usage, and render a shared 5h/weekly summary in both admin pages.

**Tech Stack:** TypeScript, Express, Node test runner through `tsx`, Codex CLI status probe, static HTML/CSS/JS admin shell.

---

## Execution Notes

- Use @superpowers:test-driven-development for each implementation task.
- Work from repo root: `/home/michal/my_projects/veslo/.worktrees/codex-ok-main`.
- Do not start `packages/web`, raw Vite, or desktop runtime for this admin-gateway change.
- Do not add a database migration. This is live/cached status metadata.
- Do not make Codex assignment require parsed 5h/weekly limits. Assignment should still accept a healthy `codex | OK` probe and reject refresh-token/401 failures.

### Task 1: Add Parser Coverage For Current Codex Limit Shapes

**Files:**
- Modify: `services/ai-gateway/test/codex-status.test.ts`
- Modify: `services/ai-gateway/src/usage/codex-status.ts`

**Step 1: Add a failing nested-shape parser test**

Add this test after the existing `parseRateLimitsFromSessionLog reads Codex token_count rate limits` test:

```ts
test("parseRateLimitsFromSessionLog finds nested Codex rate limits with string numbers", () => {
  const sessionLog = [
    JSON.stringify({
      timestamp: "2026-04-28T10:00:00.000Z",
      type: "event_msg",
      payload: {
        type: "agent_message",
        message: {
          metadata: {
            rate_limits: {
              primary: {
                used_percent: "72.5",
                window_minutes: "300",
                resets_at: "1777370400",
              },
              secondary: {
                used_percent: "41",
                window_minutes: "10080",
                resets_at: "1777816800",
              },
              plan_type: "team",
            },
          },
        },
      },
    }),
  ].join("\n");

  assert.deepEqual(parseRateLimitsFromSessionLog(sessionLog), {
    primary: {
      used_percent: 72.5,
      window_minutes: 300,
      resets_at: 1777370400,
    },
    secondary: {
      used_percent: 41,
      window_minutes: 10080,
      resets_at: 1777816800,
    },
    plan_type: "team",
  });
});
```

**Step 2: Add a failing partial-window mapping test**

Add this test after the existing `codexUsageStatusFromRateLimits exposes 5h and weekly windows` test:

```ts
test("codexUsageStatusFromRateLimits keeps partial 5h and weekly windows distinct", () => {
  const status = codexUsageStatusFromRateLimits(
    {
      primary: {
        used_percent: 88,
        window_minutes: 10080,
        resets_at: 1777816800,
      },
      plan_type: "plus",
    },
    "2026-04-28T10:00:00.000Z",
  );

  assert.equal(status.limits?.fiveHour, null);
  assert.equal(status.limits?.weekly?.label, "Weekly");
  assert.equal(status.limits?.weekly?.usedPercent, 88);
});
```

**Step 3: Run the focused test and confirm RED**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-status.test.ts
```

Expected: FAIL on the nested-shape parser test because the current parser only reads `payload.info.rate_limits` on `token_count` events and only accepts numeric fields.

Do not commit yet. This is the red checkpoint.

### Task 2: Implement Conservative Rate-Limit Discovery

**Files:**
- Modify: `services/ai-gateway/src/usage/codex-status.ts`
- Test: `services/ai-gateway/test/codex-status.test.ts`

**Step 1: Add string-number parsing**

Replace `getNumber()` with a helper that accepts finite numbers and finite numeric strings:

```ts
function getNumber(record: Record<string, unknown> | null, key: string): number | null {
  const value = record?.[key];
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
```

**Step 2: Add recursive rate-limit candidate discovery**

Update `parseRateLimitsFromSessionLog()` so it still prefers the current `token_count.info.rate_limits` shape, then falls back to a bounded recursive search:

```ts
export function parseRateLimitsFromSessionLog(text: string): CodexRateLimitsSnapshot | null {
  const lines = text
    .split(/\r?\n/g)
    .map((line) => line.trim())
    .filter(Boolean);

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    try {
      const parsed = JSON.parse(lines[index] ?? "");
      const payload = getRecord(parsed, "payload");
      const tokenType = getString(payload, "type");
      if (tokenType === "token_count") {
        const snapshot = readRateLimitsSnapshot(getRecord(payload, "info")?.rate_limits);
        if (snapshot) {
          return snapshot;
        }
      }

      const fallback = findRateLimitsSnapshot(parsed);
      if (fallback) {
        return fallback;
      }
    } catch {
      continue;
    }
  }

  return null;
}
```

Add this helper near `readRateLimitsSnapshot()`:

```ts
function findRateLimitsSnapshot(value: unknown, depth = 0): CodexRateLimitsSnapshot | null {
  if (depth > 6) {
    return null;
  }

  const record = getRecord(value);
  if (!record) {
    return null;
  }

  const direct = readRateLimitsSnapshot(record.rate_limits);
  if (direct) {
    return direct;
  }

  for (const key of ["payload", "info", "message", "data", "event", "metadata"]) {
    const nested = findRateLimitsSnapshot(record[key], depth + 1);
    if (nested) {
      return nested;
    }
  }

  return null;
}
```

Keep the fallback bounded and conservative. Do not scan arbitrary text, stdout, stderr, auth JSON, or secrets.

**Step 3: Run the focused test and confirm GREEN**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-status.test.ts
```

Expected: PASS.

**Step 4: Commit parser work**

Run:

```bash
git add services/ai-gateway/src/usage/codex-status.ts services/ai-gateway/test/codex-status.test.ts
git commit -m "fix: parse codex limit windows from session logs"
```

### Task 3: Represent Healthy Probes With Unknown Limits

**Files:**
- Modify: `services/ai-gateway/test/codex-status.test.ts`
- Modify: `services/ai-gateway/src/usage/codex-status.ts`

**Step 1: Add a failing provider test**

Add this test after `CachedCodexCredentialStatusProvider reuses recent probe results`:

```ts
test("CachedCodexCredentialStatusProvider reports healthy probes with unknown limits", async () => {
  const provider = new CachedCodexCredentialStatusProvider({
    ttlMs: 5 * 60 * 1000,
    now: () => new Date("2026-04-28T10:00:00.000Z"),
    loadCredentialAuthJson: async () => JSON.stringify({ auth_mode: "chatgpt", tokens: { refresh_token: "rt", account_id: "acct" } }),
    probe: async () => ({
      checkedAt: "2026-04-28T10:00:00.000Z",
      rateLimits: null,
      ok: true,
      detail: "codex | OK | tokens used | 1,499",
    }),
  });

  const status = await provider.getStatus({
    credentialId: "cred_codex_1",
    credentialName: "Credential cred_codex_1",
  });

  assert.equal(status.available, true);
  assert.equal(status.source, "codex_exec_no_rate_limits");
  assert.equal(status.label, "Codex OK, limits unknown");
  assert.equal(status.detail, "codex | OK | tokens used | 1,499");
  assert.equal(status.limits?.fiveHour, null);
  assert.equal(status.limits?.weekly, null);
});
```

**Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-status.test.ts
```

Expected: FAIL because `ProbeResult` does not expose `ok` and missing limits currently return unavailable status.

**Step 3: Extend the status source and probe result**

Update `CodexUsageStatusSource`:

```ts
export type CodexUsageStatusSource =
  | "codex_exec_rate_limits"
  | "codex_exec_no_rate_limits"
  | "codex_status"
  | "codex_login_status"
  | "unavailable";
```

Update `ProbeResult`:

```ts
type ProbeResult = {
  checkedAt: string;
  rateLimits: CodexRateLimitsSnapshot | null;
  ok?: boolean;
  detail?: string | null;
};
```

**Step 4: Add an unknown-limits status helper**

Add:

```ts
function codexUsageStatusUnknownLimits(checkedAt: string, detail?: string | null): CodexUsageStatus {
  return {
    available: true,
    source: "codex_exec_no_rate_limits",
    label: "Codex OK, limits unknown",
    detail: detail ?? null,
    checkedAt,
    limits: {
      fiveHour: null,
      weekly: null,
    },
  };
}
```

**Step 5: Use the helper in the cached provider**

Change the no-limits branch in `CachedCodexCredentialStatusProvider.getStatus()`:

```ts
status = result.rateLimits
  ? codexUsageStatusFromRateLimits(result.rateLimits, result.checkedAt, result.detail)
  : result.ok === true
    ? codexUsageStatusUnknownLimits(result.checkedAt, result.detail)
    : unavailableStatus(result.detail || "Codex probe did not return rate limits.", result.checkedAt);
```

**Step 6: Set `ok` in the live probe**

In `runCodexExecRateLimitProbe()`, include `ok: result.exitCode === 0 && !result.timedOut` in both the rate-limits and no-rate-limits returns.

**Step 7: Run the focused test and confirm GREEN**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-status.test.ts
```

Expected: PASS.

**Step 8: Commit healthy-unknown status work**

Run:

```bash
git add services/ai-gateway/src/usage/codex-status.ts services/ai-gateway/test/codex-status.test.ts
git commit -m "fix: distinguish codex ok from unknown limits"
```

### Task 4: Add Credentials API Upstream Status Coverage

**Files:**
- Modify: `services/ai-gateway/test/admin-read-models.test.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`

**Step 1: Add a failing credentials endpoint test**

Add this test after `admin credentials endpoint returns repository-backed credentials`:

```ts
test("admin credentials endpoint includes Codex upstream limit status", async () => {
  const app = createAdminApp({
    credentials: [
      createCredential("cred_openai_1"),
      createCredential("cred_codex_1", {
        provider: "codex_oauth",
        activeLeases: 0,
        totalTokens: 0,
      }),
    ],
    codexStatusProvider: {
      async getStatus() {
        return {
          available: true,
          source: "codex_exec_rate_limits",
          label: "Codex limits available",
          detail: null,
          checkedAt: "2026-04-28T10:00:00.000Z",
          planType: "plus",
          limits: {
            fiveHour: {
              label: "5h",
              usedPercent: 30,
              windowMinutes: 300,
              resetAt: "2026-04-28T15:00:00.000Z",
            },
            weekly: {
              label: "Weekly",
              usedPercent: 33,
              windowMinutes: 10080,
              resetAt: "2026-05-01T12:00:00.000Z",
            },
          },
        };
      },
    },
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials`, {
      headers: AUTHORIZATION,
    });

    assert.equal(response.status, 200);
    const body = await response.json();
    const codex = body.credentials.find((entry: CredentialRecord) => entry.id === "cred_codex_1");
    const openai = body.credentials.find((entry: CredentialRecord) => entry.id === "cred_openai_1");
    assert.equal(openai.upstreamStatus, undefined);
    assert.equal(codex.upstreamStatus.limits.fiveHour.usedPercent, 30);
    assert.equal(codex.upstreamStatus.limits.weekly.usedPercent, 33);
  } finally {
    server.close();
    await once(server, "close");
  }
});
```

**Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-read-models.test.ts
```

Expected: FAIL because `/admin/api/credentials` does not include `upstreamStatus`.

Do not commit yet.

### Task 5: Decorate Codex Credentials In Admin Read Models

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Test: `services/ai-gateway/test/admin-read-models.test.ts`

**Step 1: Extend the credentials read type**

Change:

```ts
export type CredentialRecord = AdminCredentialRecord;
```

to:

```ts
export type CredentialRecord = AdminCredentialRecord & {
  upstreamStatus?: CodexUsageStatus | null;
};
```

**Step 2: Add a shared status decorator**

Add this helper near `withCredentialUsage()`:

```ts
async function withCodexUpstreamStatus(
  credentials: CredentialRecord[],
  statusProvider: CodexCredentialStatusProvider,
): Promise<CredentialRecord[]> {
  return Promise.all(
    credentials.map(async (credential) => {
      if (credential.provider !== "codex_oauth") {
        return credential;
      }

      return {
        ...credential,
        upstreamStatus: await statusProvider.getStatus({
          credentialId: credential.id,
          credentialName: credential.name,
        }),
      };
    }),
  );
}
```

**Step 3: Use the decorator in the credentials endpoint**

Change `listCredentials()`:

```ts
async listCredentials() {
  return { credentials: await withCodexUpstreamStatus(await listCredentialsWithAlerts(), codexStatusProvider) };
},
```

**Step 4: Reuse decorated status in Usage**

In `getUsage()`, decorate credentials before passing them into `withCredentialUsage()`:

```ts
const [usage, credentials] = await Promise.all([
  usageRepository.aggregateUsage(input),
  getCredentialReadRepository().listAdminCredentials(),
]);
return withCredentialUsage(usage, await withCodexUpstreamStatus(credentials, codexStatusProvider), codexStatusProvider);
```

Then update `withCredentialUsage()` so it uses `credential.upstreamStatus` when present:

```ts
upstreamStatus:
  credential.provider === "codex_oauth"
    ? credential.upstreamStatus ?? await statusProvider.getStatus({
        credentialId: credential.id,
        credentialName: credential.name,
      })
    : null,
```

The existing cache should prevent duplicate live probes if both pages are loaded near each other.

**Step 5: Run the focused tests and confirm GREEN**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-read-models.test.ts
```

Expected: PASS.

**Step 6: Commit read-model work**

Run:

```bash
git add services/ai-gateway/src/http/admin.ts services/ai-gateway/test/admin-read-models.test.ts
git commit -m "feat: expose codex status on credentials"
```

### Task 6: Add Admin UI Coverage For Credentials Limit Status

**Files:**
- Modify: `services/ai-gateway/test/admin-ui.test.ts`
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`

**Step 1: Add failing static HTML assertions**

In `GET /admin/credentials serves the admin shell with an admin-only platform credential form`, assert the Credentials table has its own Codex limits header:

```ts
assert.match(html, /<th>Last refresh<\/th>\s*<th>Codex limits<\/th>/);
```

**Step 2: Add failing script assertions**

In `GET /admin/app.js renders credential usage and Codex limits status`, add:

```ts
assert.match(script, /renderCredentialCodexStatus/);
assert.match(script, /Codex OK, limits unknown/);
assert.match(script, /5h: unknown/);
assert.match(script, /Weekly: unknown/);
```

**Step 3: Run the focused test and confirm RED**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts
```

Expected: FAIL because the Credentials page does not have a Codex limits column or renderer.

Do not commit yet.

### Task 7: Render Shared 5h And Weekly Status In Credentials And Usage

**Files:**
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Test: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Add the Credentials table header**

In the Credentials table header, add:

```html
<th>Codex limits</th>
```

after `Last refresh`.

Update the loading/example rows to include one extra cell, and update the empty row in `renderCredentials()` from `colspan="6"` to `colspan="7"`.

**Step 2: Add a credentials-specific renderer that reuses the shared formatter**

Add near `formatCredentialUpstreamStatus()`:

```js
function renderCredentialCodexStatus(credential) {
  if (credential.provider !== "codex_oauth") {
    return `<span class="muted">N/A</span>`;
  }

  const upstreamStatus = formatCredentialUpstreamStatus(credential);
  return `<span class="status-chip ${escapeHtml(upstreamStatus.tone)}">${escapeHtml(upstreamStatus.label)}</span><span>${escapeHtml(upstreamStatus.limitSummary)}</span><span>${escapeHtml(upstreamStatus.detail)}</span>`;
}
```

**Step 3: Use it in `renderCredentials()` rows**

Add this cell after `Last refresh`:

```js
<td>${renderCredentialCodexStatus(credential)}</td>
```

**Step 4: Add Codex status to the selected credential detail**

Inside the selected credential detail stack, add:

```js
${selected.provider === "codex_oauth" ? `
  <div class="detail-line"><span>Codex upstream</span><strong>${escapeHtml(formatCredentialUpstreamStatus(selected).label)}</strong></div>
  <div class="detail-line"><span>Codex limits</span><strong>${escapeHtml(formatCredentialUpstreamStatus(selected).limitSummary || "5h: unknown | Weekly: unknown")}</strong></div>
` : ""}
```

If desired during implementation, compute `const selectedUpstreamStatus = formatCredentialUpstreamStatus(selected)` before the template to avoid repeated calls.

**Step 5: Improve unknown-limit formatting for both pages**

Change `formatCredentialUpstreamStatus()` so `available` status with no parsed windows is informational instead of warning:

```js
const hasLimits = Boolean(status.limits?.fiveHour || status.limits?.weekly);
return {
  label: status.label || (hasLimits ? "Codex limits available" : "Codex OK, limits unknown"),
  detail: [status.detail, status.checkedAt ? `Checked ${formatDate(status.checkedAt)}` : ""]
    .filter(Boolean)
    .join(" "),
  limitSummary,
  tone: hasLimits ? "success" : "info",
};
```

Change `formatCredentialLimitSummary()` so it always shows both windows for Codex statuses:

```js
function formatCredentialLimitSummary(status) {
  const limits = status?.limits;
  if (!limits) {
    return "";
  }

  const lines = [
    formatLimitWindowSummary("5h", limits.fiveHour),
    formatLimitWindowSummary("Weekly", limits.weekly),
  ];

  if (typeof status.planType === "string" && status.planType.trim()) {
    lines.unshift(`Plan ${status.planType}`);
  }

  return lines.join(" | ");
}

function formatLimitWindowSummary(label, entry) {
  if (!entry) {
    return `${label}: unknown`;
  }
  const used = typeof entry.usedPercent === "number" ? `${Math.round(entry.usedPercent)}% used` : "usage unknown";
  const reset = entry.resetAt ? `resets ${formatDate(entry.resetAt)}` : "reset unknown";
  return `${entry.label || label}: ${used}, ${reset}`;
}
```

**Step 6: Run the focused UI test and confirm GREEN**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/admin-ui.test.ts
```

Expected: PASS.

**Step 7: Commit UI work**

Run:

```bash
git add services/ai-gateway/public-admin/index.html services/ai-gateway/public-admin/app.js services/ai-gateway/test/admin-ui.test.ts
git commit -m "feat: show codex limits on credentials"
```

### Task 8: Update Canonical Admin Documentation

**Files:**
- Modify: `docs/admin-managed-ai-access.md`

**Step 1: Update admin behavior docs**

Replace the existing Usage-only Codex limits bullet with:

```md
- The hosted admin `Usage` and `Credentials` pages show best-effort Codex upstream status for runtime credentials. When the Codex probe returns parseable 5h and weekly windows, both pages show those windows and reset times. When the probe succeeds but no windows are parsed, both pages show `Codex OK, limits unknown` without making the credential ineligible. Authentication failures such as `invalid_grant`, reused refresh tokens, or 401 responses remain visible as unavailable upstream status and require reconnecting or rotating the credential.
```

**Step 2: Run a docs diff check**

Run:

```bash
git diff --check
```

Expected: no output.

**Step 3: Commit docs**

Run:

```bash
git add docs/admin-managed-ai-access.md
git commit -m "docs: document codex limit status states"
```

### Task 9: Final Verification

**Files:**
- Modify only if verification reveals defects.

**Step 1: Run focused status and admin tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway exec tsx --test test/codex-status.test.ts test/admin-read-models.test.ts test/admin-ui.test.ts
```

Expected: PASS.

**Step 2: Run the full AI Gateway test suite**

Run:

```bash
pnpm --filter @neatech/ai-gateway test
```

Expected: PASS.

**Step 3: Build AI Gateway**

Run:

```bash
pnpm --filter @neatech/ai-gateway build
```

Expected: PASS.

**Step 4: Check worktree status**

Run:

```bash
git status --short --branch
```

Expected: branch contains only intentional committed implementation changes, with a clean working tree.

**Step 5: Optional live verification after deploy**

After this branch is merged and deployed, visit:

```text
https://veslo-ai-gateway-dev.onrender.com/admin/usage
https://veslo-ai-gateway-dev.onrender.com/admin/credentials
```

Expected:

- Codex credentials with parsed windows show both `5h` and `Weekly` statuses.
- Healthy Codex credentials without parsed windows show `Codex OK, limits unknown`.
- Credentials with `invalid_grant`, reused refresh token, or 401 details show unavailable upstream status.
