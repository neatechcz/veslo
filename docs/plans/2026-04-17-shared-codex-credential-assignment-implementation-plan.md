# Shared Codex Credential Assignment Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make `codex_oauth` a database-backed shared credential that admins assign to users in the admin UI so Veslo desktop prompt routing changes take effect without gateway redeploys.

**Architecture:** Extend managed AI user policy to include `credentialId`, add Codex credential creation and selection in the admin control plane, then route Codex prompt execution through the credential selected for the signed-in user instead of the global deploy-time auth secret.

**Tech Stack:** TypeScript, Express, Drizzle/MySQL, static admin UI, Node test runner, Codex CLI worker transport, WebdriverIO/Tauri E2E.

---

## Ground Rules

- Do not modify `vendor/opencode`.
- Do not commit raw access tokens, refresh tokens, or auth JSON.
- Keep the current global Codex env path only as a temporary compatibility fallback if needed during rollout.
- Prefer strict user-to-selected-credential routing for the first version. Do not add pool auto-selection.
- Run focused tests after each task.

### Task 1: Extend AI access policy with `credentialId`

**Files:**
- Modify: `services/den/src/managed-ai/schema.ts`
- Modify: `services/den/src/managed-ai/access/repository.ts`
- Modify: `services/den/src/managed-ai/access/mysql-repository.ts`
- Modify: `services/ai-gateway/src/schema.ts` if the gateway copy still mirrors this schema surface
- Modify: `services/ai-gateway/src/access/repository.ts`
- Modify: `services/ai-gateway/src/access/mysql-repository.ts`
- Test: `services/den/test/admin-managed-ai-user-access.test.ts`
- Test: `services/ai-gateway/test/mysql-ai-access-repository.test.ts`

**Step 1: Write the failing repository tests**

Add coverage that persisted AI access records round-trip `credentialId`:

```ts
test("upsertUserAiAccess persists credentialId for codex_oauth", async () => {
  const saved = await repository.upsertUserAiAccess({
    userId: "user_1",
    enabled: true,
    provider: "codex_oauth",
    defaultModel: "gpt-5.4",
    allowedModels: ["gpt-5.4"],
    credentialId: "cred_codex_shared_1",
  });

  assert.equal(saved.credentialId, "cred_codex_shared_1");
  const loaded = await repository.getUserAiAccess("user_1");
  assert.equal(loaded?.credentialId, "cred_codex_shared_1");
});
```

**Step 2: Run tests to verify failure**

Run:

```bash
pnpm --dir services/den test -- admin-managed-ai-user-access
pnpm --dir services/ai-gateway test -- mysql-ai-access-repository
```

Expected: failure because `credentialId` is not part of the stored record yet.

**Step 3: Add the column and types**

Implement:

- add nullable `credential_id` to `user_ai_access_policy`
- extend `UserAiAccessPolicyRecord`
- extend `UpsertUserAiAccessPolicyInput`
- read/write the field in MySQL repositories

**Step 4: Re-run the focused tests**

Run the same commands and expect them to pass.

**Step 5: Commit**

```bash
git add services/den/src/managed-ai/schema.ts services/den/src/managed-ai/access/repository.ts services/den/src/managed-ai/access/mysql-repository.ts services/ai-gateway/src/schema.ts services/ai-gateway/src/access/repository.ts services/ai-gateway/src/access/mysql-repository.ts services/den/test/admin-managed-ai-user-access.test.ts services/ai-gateway/test/mysql-ai-access-repository.test.ts
git commit -m "feat: persist ai access credential assignment"
```

### Task 2: Validate `credentialId` in admin APIs

**Files:**
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`
- Test: `services/den/test/admin-managed-ai-user-access.test.ts`
- Test: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write the failing API test**

Add a test that rejects enabled `codex_oauth` access without a credential id and accepts it with one:

```ts
test("codex_oauth ai access requires credentialId", async () => {
  const missing = await putUserAiAccess({
    userId: "user_1",
    enabled: true,
    provider: "codex_oauth",
    defaultModel: "gpt-5.4",
    allowedModels: ["gpt-5.4"],
    credentialId: null,
  });
  assert.equal(missing.status, 400);

  const valid = await putUserAiAccess({
    userId: "user_1",
    enabled: true,
    provider: "codex_oauth",
    defaultModel: "gpt-5.4",
    allowedModels: ["gpt-5.4"],
    credentialId: "cred_codex_shared_1",
  });
  assert.equal(valid.status, 200);
});
```

**Step 2: Run the targeted tests**

Run:

```bash
pnpm --dir services/den test -- admin-managed-ai-user-access
pnpm --dir services/ai-gateway test -- admin-ui
```

Expected: failure because admin validation does not know about `credentialId`.

**Step 3: Implement validation and response serialization**

Update the admin route validators and response serializers so:

- `credentialId` is accepted in payloads
- `credentialId` is returned in `aiAccess`
- `credentialId` is required for enabled `codex_oauth`

**Step 4: Re-run the targeted tests**

Run the same commands and expect pass.

**Step 5: Commit**

```bash
git add services/den/src/managed-ai/http/admin.ts services/ai-gateway/src/http/admin.ts services/den/test/admin-managed-ai-user-access.test.ts services/ai-gateway/test/admin-ui.test.ts
git commit -m "feat: validate codex credential selection in admin api"
```

### Task 3: Add shared Codex credential creation in admin

**Files:**
- Modify: `services/den/src/managed-ai/credentials/secret-store.ts`
- Modify: `services/den/src/managed-ai/credentials/mysql-secret-store.ts`
- Modify: `services/ai-gateway/src/credentials/secret-store.ts`
- Modify: `services/ai-gateway/src/credentials/mysql-secret-store.ts`
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Modify: `services/den/public-admin/index.html`
- Modify: `services/den/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Test: `services/den/test/admin-ui.test.ts`
- Test: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write the failing admin credential test**

Add a test for creating a `codex_oauth` credential through the admin API:

```ts
test("admin can create a shared codex_oauth credential", async () => {
  const response = await createCredential({
    provider: "codex_oauth",
    name: "Shared Codex A",
    secret: JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "x", refresh_token: "y" } }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.body.credential.provider, "codex_oauth");
  assert.equal(response.body.credential.type, "oauth");
});
```

**Step 2: Run the targeted tests**

Run:

```bash
pnpm --dir services/den test -- admin-ui
pnpm --dir services/ai-gateway test -- admin-ui
```

Expected: failure because `codex_oauth` is not a creatable admin credential type.

**Step 3: Implement Codex credential storage**

Implement:

- secret store support for a new encrypted secret kind such as `codex_auth_json`
- admin credential create path for `provider=codex_oauth`
- store `credentialType = "oauth"`
- set owner to `platform:codex_oauth`
- show provider option and UI copy in admin credentials page

**Step 4: Re-run the targeted tests**

Run the same commands and expect pass.

**Step 5: Commit**

```bash
git add services/den/src/managed-ai/credentials/secret-store.ts services/den/src/managed-ai/credentials/mysql-secret-store.ts services/ai-gateway/src/credentials/secret-store.ts services/ai-gateway/src/credentials/mysql-secret-store.ts services/den/src/managed-ai/http/admin.ts services/den/public-admin/index.html services/den/public-admin/app.js services/ai-gateway/public-admin/index.html services/ai-gateway/public-admin/app.js services/den/test/admin-ui.test.ts services/ai-gateway/test/admin-ui.test.ts
git commit -m "feat: add shared codex credential creation"
```

### Task 4: Add user-side credential selection UI in admin/users

**Files:**
- Modify: `services/den/src/managed-ai/http/admin.ts`
- Modify: `services/den/public-admin/index.html`
- Modify: `services/den/public-admin/app.js`
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Test: `services/den/test/admin-ui.test.ts`
- Test: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write the failing UI/API read-model test**

Add coverage that `/admin/users` can load available Codex credentials for assignment and persist the selected `credentialId`.

**Step 2: Run tests to verify failure**

Run:

```bash
pnpm --dir services/den test -- admin-ui
pnpm --dir services/ai-gateway test -- admin-ui
```

Expected: failure because the users editor does not expose credential choices.

**Step 3: Implement the selector**

Implement:

- admin API response that exposes eligible `codex_oauth` credentials for the users page
- users editor `Assigned credential` control when provider is `codex_oauth`
- save/load wiring for `credentialId`

UI requirement:

- label credentials by human-readable name first
- keep ids as hidden values only

**Step 4: Re-run the focused tests**

Run the same commands and expect pass.

**Step 5: Commit**

```bash
git add services/den/src/managed-ai/http/admin.ts services/den/public-admin/index.html services/den/public-admin/app.js services/ai-gateway/src/http/admin.ts services/ai-gateway/public-admin/index.html services/ai-gateway/public-admin/app.js services/den/test/admin-ui.test.ts services/ai-gateway/test/admin-ui.test.ts
git commit -m "feat: assign shared codex credentials to users"
```

### Task 5: Route Codex requests through the selected credential

**Files:**
- Modify: `services/den/src/managed-ai/http/providers/codex-oauth.ts`
- Modify: `services/den/src/managed-ai/http/proxy.ts`
- Modify: `services/den/src/managed-ai/leases/repository.ts` if a direct binding lookup helper is needed
- Modify: `services/den/src/managed-ai/credentials/repository.ts`
- Modify: `services/den/src/managed-ai/credentials/mysql-repository.ts`
- Modify: `services/ai-gateway/src/http/providers/codex-oauth.ts`
- Modify: `services/ai-gateway/src/http/proxy.ts`
- Modify: `services/ai-gateway/src/credentials/repository.ts`
- Modify: `services/ai-gateway/src/credentials/mysql-repository.ts`
- Test: `services/den/test/proxy.test.ts`
- Test: `services/ai-gateway/test/proxy.test.ts`

**Step 1: Write the failing routing test**

Add a test that a user with `credentialId="cred_A"` routes to that exact binding and not just any `platform:codex_oauth` binding.

**Step 2: Run the focused tests**

Run:

```bash
pnpm --dir services/den test -- proxy
pnpm --dir services/ai-gateway test -- proxy
```

Expected: failure because Codex routing still hardcodes `platform:codex_oauth`.

**Step 3: Implement direct credential resolution**

Implement:

- repository lookup from credential id to binding id
- Codex route logic that uses `aiAccess.credentialId`
- strict failure when the selected credential is missing, revoked, or unhealthy

Do not add automatic failover to a different credential in this task.

**Step 4: Re-run the focused tests**

Run the same commands and expect pass.

**Step 5: Commit**

```bash
git add services/den/src/managed-ai/http/providers/codex-oauth.ts services/den/src/managed-ai/http/proxy.ts services/den/src/managed-ai/leases/repository.ts services/den/src/managed-ai/credentials/repository.ts services/den/src/managed-ai/credentials/mysql-repository.ts services/ai-gateway/src/http/providers/codex-oauth.ts services/ai-gateway/src/http/proxy.ts services/ai-gateway/src/credentials/repository.ts services/ai-gateway/src/credentials/mysql-repository.ts services/den/test/proxy.test.ts services/ai-gateway/test/proxy.test.ts
git commit -m "feat: route codex via assigned shared credential"
```

### Task 6: Remove request-time dependence on global Codex auth env

**Files:**
- Modify: `services/den/src/managed-ai/http/providers/codex-oauth.ts`
- Modify: `services/den/src/managed-ai/providers/codex-cli-worker-transport.ts`
- Modify: `services/ai-gateway/src/http/providers/codex-oauth.ts`
- Modify: `services/ai-gateway/src/providers/codex-cli-worker-transport.ts`
- Test: `services/den/test/render-codex-worker.test.ts`
- Test: `services/ai-gateway/test/render-codex-worker.test.ts`

**Step 1: Write the failing transport test**

Add coverage that the Codex worker can accept auth material from the selected credential secret instead of only `AI_GATEWAY_CODEX_AUTH_JSON`.

**Step 2: Run the focused tests**

Run:

```bash
pnpm --dir services/den test -- render-codex-worker
pnpm --dir services/ai-gateway test -- render-codex-worker
```

Expected: failure because worker transport constructor still only reads global auth json.

**Step 3: Implement per-request auth materialization**

Implement:

- fetch selected credential secret before spawning worker
- pass auth json into the worker transport per request
- keep the env secret as fallback only during migration if necessary

**Step 4: Re-run focused tests**

Run the same commands and expect pass.

**Step 5: Commit**

```bash
git add services/den/src/managed-ai/http/providers/codex-oauth.ts services/den/src/managed-ai/providers/codex-cli-worker-transport.ts services/ai-gateway/src/http/providers/codex-oauth.ts services/ai-gateway/src/providers/codex-cli-worker-transport.ts services/den/test/render-codex-worker.test.ts services/ai-gateway/test/render-codex-worker.test.ts
git commit -m "feat: load codex auth from assigned credentials"
```

### Task 7: Verify real admin and Windows desktop flow

**Files:**
- Modify: `packages/e2e/specs/live-admin-codex-roundtrip.spec.ts`
- Modify: `packages/e2e/helpers/live-desktop-auth.ts`
- Modify: `packages/e2e/windows-veslo-runtime-probe.mjs`

**Step 1: Update the live E2E path**

Change the live E2E so it verifies:

- a real browser-based Veslo login
- real admin credential assignment
- no session-storage auth injection for the desktop auth step
- prompt success through the selected shared Codex credential

**Step 2: Build the desktop app**

Run:

```bash
pnpm --dir packages/desktop tauri build --debug --no-bundle -- --features e2e
```

Expected: build passes.

**Step 3: Run the focused Windows E2E**

Run:

```bash
pnpm --dir packages/e2e test --spec ./specs/live-admin-codex-roundtrip.spec.ts
```

Expected: real user sign-in, assigned credential visible, prompt round-trip succeeds.

**Step 4: Commit**

```bash
git add packages/e2e/specs/live-admin-codex-roundtrip.spec.ts packages/e2e/helpers/live-desktop-auth.ts packages/e2e/windows-veslo-runtime-probe.mjs
git commit -m "test: cover shared codex credential desktop flow"
```

### Final Verification

Run:

```bash
pnpm --dir services/den test
pnpm --dir services/ai-gateway test
pnpm --dir packages/e2e exec tsc --noEmit
pnpm --dir packages/desktop tauri build --debug --no-bundle -- --features e2e
pnpm --dir packages/e2e test --spec ./specs/live-admin-codex-roundtrip.spec.ts
```

Expected:

- unit and integration tests pass
- desktop build passes
- live Windows flow succeeds without changing deployment secrets
