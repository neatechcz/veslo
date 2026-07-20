# Cloud User-ID AI Access Compatibility Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a cloud-only, bearer-verified user-ID AI-access route without changing the desktop application, local Veslo server, DEN, existing `/me` APIs, or inference proxy endpoints.

**Architecture:** The AI Gateway user-credentials router will expose canonical and mounted explicit-user routes beside the existing `/me` routes. A small middleware will compare the route ID with the user independently resolved from the bearer token, then both route families will invoke one shared AI-access response handler that continues composing `effectiveModel` from the singleton platform policy.

**Tech Stack:** TypeScript, Express, Node test runner through `tsx --test`, pnpm.

---

## Working Rules

- Follow @test-driven-development: add the compatibility tests first, observe the expected 404, then implement the smallest route change.
- Keep bearer-token session resolution as the only identity authority.
- Never use an identity header or an unmatched path ID for repository lookups.
- Do not modify `packages/app`, `packages/server`, or `services/den`.
- Do not alter provider inference routes, request bodies, model overrides, or user model persistence.
- Keep historical per-user model fields non-authoritative.

### Task 1: Define the explicit user-ID HTTP contract

**Files:**

- Modify: `services/ai-gateway/test/user-credentials.test.ts`

**Step 1: Add a parity test for both explicit routes**

Start the real Express application with the existing user-credential fixture. Request both routes with the fixture's bearer token:

```ts
const paths = [
  "/api/users/user_123/ai-access",
  "/ai-gateway/users/user_123/ai-access",
]
```

For each response, assert status `200` and the same payload already expected from `/api/me/ai-access`, including:

```ts
effectiveModel: { provider: "openai", model: "gpt-5.5" }
```

**Step 2: Add a cross-user rejection test**

Create a fixture whose session resolves to `user_123`, while AI-access and model-policy methods record or fail if invoked. Request:

```text
GET /api/users/user_456/ai-access
```

Assert:

```ts
assert.equal(response.status, 403)
assert.deepEqual(await response.json(), { error: "user_identity_mismatch" })
assert.equal(aiAccessReads, 0)
assert.equal(modelPolicyReads, 0)
```

Repeat the same assertion for the `/ai-gateway/users/...` alias.

**Step 3: Add authentication and null-response coverage**

- Request the explicit route without a bearer token and assert `401 unauthorized`.
- Configure the authenticated fixture with no AI-access record and assert the explicit route returns `200 { "aiAccess": null }` without reading model policy.

**Step 4: Run the focused tests and verify RED**

Run:

```bash
pnpm --dir services/ai-gateway exec tsx --test --test-name-pattern "explicit user|user identity" test/user-credentials.test.ts
```

Expected: FAIL because both explicit user-ID paths currently return `404`.

### Task 2: Add the shared, verified cloud routes

**Files:**

- Modify: `services/ai-gateway/src/http/user-credentials.ts`

**Step 1: Extract the shared response handler**

Rename the route-local `getMyAiAccess` handler to a neutral `getUserAiAccess`. It must continue reading only:

```ts
const session = res.locals.userSession as UserSession
deps.aiAccess?.getUserAiAccess(session.user.id)
```

Keep the existing model-policy lookup, Codex assignment repair, serialization, and error behavior unchanged.

**Step 2: Add exact identity matching middleware**

Add middleware with this contract:

```ts
const requireMatchingRouteUser = (req: Request, res: Response, next: NextFunction) => {
  const session = res.locals.userSession as UserSession
  const requestedUserId = typeof req.params.userId === "string" ? req.params.userId.trim() : ""
  if (!requestedUserId || requestedUserId !== session.user.id) {
    res.status(403).json({ error: "user_identity_mismatch" })
    return
  }
  next()
}
```

Do not copy the route ID into session state and do not pass it directly to repositories.

**Step 3: Register the canonical and mounted aliases**

Keep the existing routes and add:

```ts
router.get("/api/users/:userId/ai-access", requireMatchingRouteUser, getUserAiAccess)
router.get(
  "/ai-gateway/users/:userId/ai-access",
  requireUserSession,
  requireMatchingRouteUser,
  getUserAiAccess,
)
```

**Step 4: Run the focused tests and verify GREEN**

Run the focused command from Task 1.

Expected: all explicit-user compatibility tests pass.

**Step 5: Run the existing inference identity regression**

```bash
pnpm --dir services/ai-gateway exec tsx --test --test-name-pattern "resolved gateway user identity" test/proxy-auth.test.ts
```

Expected: PASS, proving that inference still ignores caller-supplied owner-user headers.

**Step 6: Commit the route and tests**

```bash
git add services/ai-gateway/src/http/user-credentials.ts services/ai-gateway/test/user-credentials.test.ts
git commit -m "feat(ai-gateway): add verified user access route"
```

### Task 3: Document and verify the cloud-only compatibility contract

**Files:**

- Modify: `docs/features/session-runtime.md`

**Step 1: Update canonical behavior documentation**

Document beside the existing `/api/me/ai-access` contract that:

- `/api/users/:userId/ai-access` and its mounted alias return the same response;
- the path ID must equal the bearer-token user;
- `/me` remains the application route and current desktop/local-server behavior does not change;
- the explicit route does not restore identity headers or per-user model authority.

**Step 2: Run the complete AI Gateway suite**

```bash
pnpm --dir services/ai-gateway test
```

Expected: PASS with no failures other than explicitly skipped environment-backed tests.

**Step 3: Build the AI Gateway**

```bash
pnpm --dir services/ai-gateway build
```

Expected: PASS.

**Step 4: Run the repository handoff gate when available**

```bash
pnpm check
```

Expected on a current checkout: PASS. This historical staging branch is known not to define the command; if it still reports `Command "check" not found`, record that tooling gap without modifying unrelated root tooling.

**Step 5: Verify scope and formatting**

```bash
git diff --check
git status --short
git diff --name-only HEAD~2
```

Expected: only the approved design/plan, AI Gateway route/test, and canonical feature documentation changed. No `packages/app`, `packages/server`, or `services/den` files appear.

**Step 6: Commit documentation and the implementation plan**

```bash
git add docs/features/session-runtime.md docs/plans/2026-07-20-cloud-user-id-ai-access-compatibility-implementation-plan.md
git commit -m "docs(ai-gateway): document user id compatibility"
```
