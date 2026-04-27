# Auto-Assign Healthy Codex Credentials Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Auto-assign new users to a healthy Codex credential with verified OK upstream status, and keep the admin Users credential picker limited to eligible credentials.

**Architecture:** Add one backend eligibility selector inside the AI Gateway admin service and reuse it for both user provisioning and the admin Users read model. A credential is eligible only when it is `codex_oauth`, `healthy`, and its Codex status probe reports `available: true`; among eligible credentials, prefer the one with the fewest active leases and fall back deterministically when counts tie. The public admin UI stays thin: it consumes the filtered backend credential list, shows the selected assignment, and surfaces a clear empty state when no eligible credential exists.

**Tech Stack:** TypeScript, Express, MySQL/Drizzle, Node test runner, static admin UI.

---

### Task 1: Add Codex credential eligibility selection in the admin service

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/test/admin-actions.test.ts`
- Modify: `services/ai-gateway/test/admin-user-access.test.ts`
- Modify: `services/ai-gateway/test/admin-read-models.test.ts`

**Step 1: Write the failing tests**

Add coverage for a helper that selects the best Codex credential from the admin inventory:

```ts
test("selects the least-loaded healthy codex credential with OK upstream status", async () => {
  const selected = await service.getEligibleCodexCredentialForAutoAssign();

  assert.equal(selected?.credentialId, "cred_codex_2");
});

test("returns null when no eligible codex credential exists", async () => {
  const selected = await service.getEligibleCodexCredentialForAutoAssign();

  assert.equal(selected, null);
});
```

The failing shape should prove three conditions at once:
- `provider === "codex_oauth"`
- `state === "healthy"`
- `codexStatusProvider.getStatus(...).available === true`

**Step 2: Run the tests to verify failure**

Run:

```bash
pnpm --dir services/ai-gateway test -- test/admin-actions.test.ts test/admin-read-models.test.ts
```

Expected: failure because the service does not yet expose an eligibility selector and does not filter by probe status.

**Step 3: Implement the minimal service helper**

Add a single backend helper in `services/ai-gateway/src/http/admin.ts` that:
- reads admin credentials
- filters to Codex credentials in `healthy` state
- asks the Codex status provider for each candidate
- keeps only `available: true`
- sorts by lowest `activeLeases`
- uses deterministic tie-breaking

**Step 4: Re-run the tests**

Run the same command and expect the new tests to pass.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/http/admin.ts services/ai-gateway/test/admin-actions.test.ts services/ai-gateway/test/admin-user-access.test.ts services/ai-gateway/test/admin-read-models.test.ts
git commit -m "feat: select eligible codex credentials for assignment"
```

### Task 2: Auto-assign new users to the best eligible Codex credential

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/test/admin-actions.test.ts`

**Step 1: Write the failing test**

Add a test that creates a user and verifies the admin service also persists AI access when an eligible Codex credential exists:

```ts
test("createUser auto-assigns codex ai access when an eligible credential exists", async () => {
  const result = await service.createUser("admin-token", {
    email: "new-user@example.test",
    name: "New User",
    platformAdmin: false,
    orgId: null,
    orgRole: "member",
  });

  assert.equal(result.email, "new-user@example.test");
  assert.equal(upsertUserAiAccessCalls.length, 1);
  assert.equal(upsertUserAiAccessCalls[0]?.credentialId, "cred_codex_2");
  assert.equal(upsertUserAiAccessCalls[0]?.defaultModel, "gpt-5.4");
});
```

Also add the negative case:

```ts
test("createUser skips ai access when no eligible codex credential exists", async () => {
  await service.createUser(...);
  assert.equal(upsertUserAiAccessCalls.length, 0);
});
```

**Step 2: Run the test and confirm failure**

Run:

```bash
pnpm --dir services/ai-gateway test -- test/admin-actions.test.ts
```

Expected: the test fails because `createUser` only creates the user today and does not provision AI access.

**Step 3: Implement auto-assignment**

Update `createUser` in `services/ai-gateway/src/http/admin.ts` so that after the Den user is created:
- it calls the eligibility helper
- if a credential is returned, it upserts AI access for the new user
- it uses a fixed default Codex model and a matching allowed-model list
- it leaves AI access disabled when no eligible credential is available

Keep the user creation API response unchanged unless the current code already returns AI access data.

**Step 4: Re-run the test**

Run the same command and expect it to pass.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/http/admin.ts services/ai-gateway/test/admin-actions.test.ts
git commit -m "feat: auto-assign codex access on user creation"
```

### Task 3: Filter the Users credential picker to eligible Codex credentials only

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`
- Modify: `services/ai-gateway/test/admin-user-access.test.ts`

**Step 1: Write the failing UI and API tests**

Add coverage that:
- `GET /admin/api/users/:userId/ai-access` only returns eligible Codex credentials in `availableCredentials`
- the Users page shows only those credentials in the `Assigned credential` dropdown
- when no eligible credential exists, the UI shows a clear empty state instead of offering broken options

**Step 2: Run the tests to verify failure**

Run:

```bash
pnpm --dir services/ai-gateway test -- test/admin-ui.test.ts test/admin-user-access.test.ts
```

Expected: failure because the current admin service returns every Codex credential, regardless of health or status.

**Step 3: Update the read model and UI copy**

Update the backend to return only eligible credentials for the Users page.

Update the admin UI so the credential dropdown:
- renders only backend-eligible credentials
- explains why assignment is unavailable when the list is empty
- keeps the rest of the form unchanged

**Step 4: Re-run the tests**

Run the same command and expect it to pass.

**Step 5: Commit**

```bash
git add services/ai-gateway/src/http/admin.ts services/ai-gateway/public-admin/index.html services/ai-gateway/public-admin/app.js services/ai-gateway/test/admin-ui.test.ts services/ai-gateway/test/admin-user-access.test.ts
git commit -m "feat: filter codex credential assignment options"
```

### Task 4: Update the docs and verify the gateway build

**Files:**
- Modify: `docs/admin-managed-ai-access.md`
- Modify: `docs/plans/2026-04-27-auto-assign-healthy-codex-credentials.md` if the implementation diverges from the approved design

**Step 1: Update the durable behavior docs**

Document that:
- new users can be auto-assigned a Codex credential when one is eligible
- the picker only shows healthy Codex credentials whose upstream status is OK
- failed or revoked credentials are intentionally hidden from assignment

**Step 2: Run the focused verification**

Run:

```bash
pnpm --dir services/ai-gateway test -- test/admin-actions.test.ts test/admin-user-access.test.ts test/admin-ui.test.ts test/admin-read-models.test.ts
pnpm --dir services/ai-gateway build
```

Expected: all targeted tests pass, then the gateway compiles cleanly.

**Step 3: Commit**

```bash
git add docs/admin-managed-ai-access.md docs/plans/2026-04-27-auto-assign-healthy-codex-credentials.md
git commit -m "docs: describe codex auto-assignment policy"
```
