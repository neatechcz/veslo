# VSLO-201 Admin Gateway Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build the approved VSLO-201 Admin Gateway: one `ai.veslo.work/admin` shell for managed-AI operations plus organization/domain/invite/user administration.

**Architecture:** Keep the standalone AI Gateway as the admin shell and managed-AI runtime authority. Use DEN as the authority for auth, users, organizations, domains, invites, memberships, platform roles, and seat limits. The AI Gateway admin service acts as the facade over DEN admin APIs and AI Gateway managed-AI repositories.

**Tech Stack:** TypeScript, Express, Better Auth, Drizzle/MySQL, static admin HTML/CSS/JS, node:test, WebdriverIO desktop E2E where user-facing desktop/auth behavior is affected.

---

## Required Context

Read first:

- `docs/plans/2026-06-06-vslo-201-admin-gateway-design.md`
- `docs/dev/testing-playbook.md`
- `docs/features/onboarding-and-auth.md`
- `docs/features/session-runtime.md`

Do not use `packages/web` or raw Vite as runtime proof. For desktop behavior, follow the desktop preflight in `docs/dev/testing-playbook.md`.

Keep existing unrelated working-tree changes out of every commit. Stage explicit paths only.

## Task 1: DEN Organization Schema

**Files:**
- Modify: `services/den/src/db/schema.ts`
- Create: `services/den/test/admin-gateway-org-schema.test.ts`
- Create: `services/den/drizzle/0015_vslo_201_admin_gateway_orgs.sql`
- Modify: `services/den/drizzle/meta/_journal.json`
- Create: `services/den/drizzle/meta/0015_snapshot.json` if using Drizzle generated snapshots

**Step 1: Write the failing schema test**

Create `services/den/test/admin-gateway-org-schema.test.ts`:

```ts
import assert from "node:assert/strict"
import test from "node:test"
import {
  OrgRole,
  OrganizationDomainTable,
  OrganizationInviteTable,
  OrganizationInviteStatus,
  OrganizationMembershipStatus,
  OrgMembershipTable,
  OrgTable,
} from "../src/db/schema.js"

test("admin gateway org schema exposes organization admin roles, membership status, domains, invites, and seat limits", () => {
  assert.deepEqual(OrgRole, ["member", "organization_admin"])
  assert.deepEqual(OrganizationMembershipStatus, ["active", "disabled", "removed"])
  assert.deepEqual(OrganizationInviteStatus, ["pending", "accepted", "expired", "revoked"])
  assert.ok(OrgTable.seat_limit)
  assert.ok(OrgMembershipTable.status)
  assert.ok(OrganizationDomainTable.domain)
  assert.ok(OrganizationDomainTable.self_signup_enabled)
  assert.ok(OrganizationInviteTable.email)
  assert.ok(OrganizationInviteTable.token_hash)
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/den test -- test/admin-gateway-org-schema.test.ts
```

Expected: FAIL because the new exports do not exist.

**Step 3: Update schema**

In `services/den/src/db/schema.ts`:

- change `OrgRole` to `["member", "organization_admin"]`
- add `OrganizationMembershipStatus = ["active", "disabled", "removed"]`
- add `OrganizationInviteStatus = ["pending", "accepted", "expired", "revoked"]`
- add `seat_limit` to `OrgTable`
- add `status` to `OrgMembershipTable`
- create `OrganizationDomainTable`
- create `OrganizationInviteTable`

Keep column names snake_case.

Use these table names:

- `organization_domain`
- `organization_invite`

**Step 4: Add migration**

Create `services/den/drizzle/0015_vslo_201_admin_gateway_orgs.sql`.

Migration intent:

- add `seat_limit` to `org`, nullable or defaulted conservatively,
- add `status` to `org_membership`, default `active`,
- migrate existing `org_membership.role = 'owner'` to `organization_admin`,
- recreate or alter the role enum as needed for MySQL,
- create `organization_domain`,
- create `organization_invite`,
- create unique index on normalized domain,
- create indexes on org/user/email/status fields.

If Drizzle cannot generate a clean enum migration, write the SQL manually and verify against a disposable MySQL database.

**Step 5: Run test to verify it passes**

Run:

```bash
pnpm --filter @neatech/den test -- test/admin-gateway-org-schema.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/db/schema.ts services/den/test/admin-gateway-org-schema.test.ts services/den/drizzle
git commit -m "feat: add admin gateway organization schema"
```

## Task 2: DEN Organization Policy Helpers

**Files:**
- Create: `services/den/src/org-admin/policy.ts`
- Create: `services/den/src/org-admin/repository.ts`
- Create: `services/den/test/org-admin-policy.test.ts`
- Create: `services/den/test/org-admin-repository.test.ts`

**Step 1: Write failing policy tests**

Create `services/den/test/org-admin-policy.test.ts`:

```ts
import assert from "node:assert/strict"
import test from "node:test"
import {
  canActivateSeat,
  normalizeEmailDomain,
  normalizeInviteEmail,
} from "../src/org-admin/policy.js"

test("normalizes email domains for organization domain matching", () => {
  assert.equal(normalizeEmailDomain(" User@Neatech.CZ "), "neatech.cz")
  assert.equal(normalizeEmailDomain("invalid"), null)
})

test("normalizes invite emails", () => {
  assert.equal(normalizeInviteEmail(" User@Neatech.CZ "), "user@neatech.cz")
  assert.equal(normalizeInviteEmail("invalid"), null)
})

test("seat activation requires available capacity when a limit exists", () => {
  assert.equal(canActivateSeat({ activeSeats: 9, seatLimit: 10 }), true)
  assert.equal(canActivateSeat({ activeSeats: 10, seatLimit: 10 }), false)
  assert.equal(canActivateSeat({ activeSeats: 999, seatLimit: null }), true)
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/den test -- test/org-admin-policy.test.ts
```

Expected: FAIL because `org-admin/policy.ts` does not exist.

**Step 3: Implement policy helpers**

Create `services/den/src/org-admin/policy.ts` with:

```ts
export function normalizeInviteEmail(value: unknown) {
  if (typeof value !== "string") return null
  const normalized = value.trim().toLowerCase()
  return normalized.includes("@") && normalized.split("@")[1]?.length ? normalized : null
}

export function normalizeEmailDomain(value: unknown) {
  const email = normalizeInviteEmail(value)
  if (!email) return null
  const domain = email.split("@").pop()?.trim().toLowerCase()
  return domain || null
}

export function canActivateSeat(input: { activeSeats: number; seatLimit: number | null }) {
  if (input.seatLimit === null) return true
  return input.activeSeats < input.seatLimit
}
```

**Step 4: Write repository tests**

Create repository tests for these cases:

- enabled domain resolves organization by email domain,
- disabled domain does not permit self-signup,
- no domain returns `domain_not_allowed`,
- active seat count blocks activation at limit,
- invite activation checks seat limit at activation time,
- invite cannot be accepted twice.

Use in-memory fakes if full MySQL setup is too heavy. Prefer repository integration with a disposable MySQL connection if existing test helpers make it easy.

**Step 5: Implement repository**

Create `services/den/src/org-admin/repository.ts` with functions:

- `resolveEnabledOrganizationDomainForEmail(email)`
- `countActiveOrganizationSeats(orgId)`
- `assertCanActivateOrganizationSeat(orgId)`
- `createOrganizationInvite(input)`
- `acceptOrganizationInvite(input)`
- `listOrganizationMembers(orgId)`
- `listOrganizationInvites(orgId)`
- `listOrganizationDomains(orgId)`

Return typed errors with stable codes:

- `domain_not_allowed`
- `seat_limit_reached`
- `invite_not_found`
- `invite_expired`
- `invite_already_used`

**Step 6: Run tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/org-admin-policy.test.ts test/org-admin-repository.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add services/den/src/org-admin services/den/test/org-admin-policy.test.ts services/den/test/org-admin-repository.test.ts
git commit -m "feat: add organization onboarding policy helpers"
```

## Task 3: DEN Signup Gating

**Files:**
- Modify: `services/den/src/auth.ts`
- Modify or create: `services/den/src/http/org-auth.ts`
- Create: `services/den/src/auth/signup-gate.ts`
- Create: `services/den/test/signup-domain-gate.test.ts`
- Modify: `services/den/test/auth-email-source.test.ts`
- Modify: `services/den/src/managed-ai/signup-assignment.ts`

**Step 1: Write failing signup gate tests**

Create `services/den/test/signup-domain-gate.test.ts`:

```ts
import assert from "node:assert/strict"
import test from "node:test"
import {
  decideSignupAccess,
} from "../src/auth/signup-gate.js"

test("enabled organization domain auto-activates when a seat is available", () => {
  assert.deepEqual(
    decideSignupAccess({
      matchingDomain: { organizationId: "org_1", selfSignupEnabled: true },
      activeSeats: 3,
      seatLimit: 10,
      hasValidInvite: false,
    }),
    { ok: true, mode: "domain", organizationId: "org_1" },
  )
})

test("enabled organization domain blocks when seat limit is reached", () => {
  assert.deepEqual(
    decideSignupAccess({
      matchingDomain: { organizationId: "org_1", selfSignupEnabled: true },
      activeSeats: 10,
      seatLimit: 10,
      hasValidInvite: false,
    }),
    { ok: false, error: "seat_limit_reached" },
  )
})

test("missing enabled domain requires invite", () => {
  assert.deepEqual(
    decideSignupAccess({
      matchingDomain: null,
      activeSeats: 0,
      seatLimit: null,
      hasValidInvite: false,
    }),
    { ok: false, error: "domain_not_allowed" },
  )
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/den test -- test/signup-domain-gate.test.ts
```

Expected: FAIL because `signup-gate.ts` does not exist.

**Step 3: Implement pure gate**

Create `services/den/src/auth/signup-gate.ts`.

Implement:

- `decideSignupAccess(input)`
- `applySignupAccessAfterUserCreate(input)` if needed for final membership creation.

Keep it pure where possible so tests are stable.

**Step 4: Wire into auth before account becomes usable**

Do not rely only on the existing user-create after-hook. That hook is too late to be the only barrier for disallowed domains.

Implementation options:

1. If Better Auth supports a pre-create hook in the installed version, use it to reject with `domain_not_allowed` or `seat_limit_reached`.
2. If not, wrap the Better Auth sign-up route before `toNodeHandler(auth)` and reject disallowed email signups before the Better Auth handler receives them.

After user creation succeeds for an allowed domain or invite:

- create active organization membership,
- skip personal default org creation for domain-joined users,
- run managed-AI assignment only after active membership exists.

**Step 5: Update auth source test**

In `services/den/test/auth-email-source.test.ts`, assert that auth imports or calls the signup gate and does not blindly call `ensureDefaultOrg` for every user.

**Step 6: Run tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/signup-domain-gate.test.ts test/auth-email-source.test.ts test/managed-ai-signup-assignment.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add services/den/src/auth.ts services/den/src/auth/signup-gate.ts services/den/src/http/org-auth.ts services/den/src/managed-ai/signup-assignment.ts services/den/test/signup-domain-gate.test.ts services/den/test/auth-email-source.test.ts
git commit -m "feat: gate signup by organization domains"
```

## Task 4: DEN Admin Capabilities And Organization APIs

**Files:**
- Modify: `services/den/src/http/admin.ts`
- Modify: `services/den/src/http/admin-runtime.ts`
- Modify: `services/den/src/http/org-auth.ts`
- Modify: `services/den/src/http/orgs.ts`
- Create: `services/den/test/admin-organization-routes.test.ts`
- Modify: `services/den/test/admin-contract.test.ts`
- Modify: `services/den/test/admin-routes.test.ts`

**Step 1: Write failing contract tests**

Add tests proving:

- platform admin session includes all visible admin sections,
- organization admin session includes only `users` and `organization`,
- non-admin member gets 403 for admin shell APIs,
- organization admin cannot fetch another organization,
- organization admin cannot edit seat limit,
- platform admin can edit seat limit.

Use route-level Express tests, matching the style of existing admin route tests.

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/den test -- test/admin-contract.test.ts test/admin-organization-routes.test.ts
```

Expected: FAIL because capability session and organization admin routes do not exist.

**Step 3: Add admin session capabilities**

Extend admin session response to include:

```ts
type AdminCapability = "credentials" | "sessions" | "usage" | "alerts" | "users" | "organizations" | "audit"
```

Add:

- `visibleAdminSections`
- per-organization role values using `organization_admin`
- `platformAdmin`

Replace platform-admin-only session checks where a scoped organization admin should be allowed.

**Step 4: Add organization admin endpoints**

Add DEN admin routes under `/v1/admin` and `/admin/api` facade source:

- `GET /organizations`
- `GET /organizations/:orgId`
- `PATCH /organizations/:orgId`
- `GET /organizations/:orgId/domains`
- `POST /organizations/:orgId/domains`
- `PATCH /organizations/:orgId/domains/:domainId`
- `DELETE /organizations/:orgId/domains/:domainId`
- `GET /organizations/:orgId/invites`
- `POST /organizations/:orgId/invites`
- `POST /organizations/:orgId/invites/:inviteId/revoke`
- `POST /organizations/:orgId/invites/:inviteId/resend`

Make seat-limit updates platform-admin-only.

**Step 5: Update existing org routes**

Update `services/den/src/http/orgs.ts` to use `organization_admin` instead of `owner` for admin-level org actions. Preserve backwards-compatible migration behavior only where old data may still exist during rollout.

**Step 6: Run tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/admin-contract.test.ts test/admin-routes.test.ts test/admin-organization-routes.test.ts test/org-auth-request.test.ts test/org-mcp-catalog.test.ts test/org-skills-catalog.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add services/den/src/http/admin.ts services/den/src/http/admin-runtime.ts services/den/src/http/org-auth.ts services/den/src/http/orgs.ts services/den/test/admin-contract.test.ts services/den/test/admin-routes.test.ts services/den/test/admin-organization-routes.test.ts
git commit -m "feat: expose scoped organization admin APIs"
```

## Task 5: AI Gateway Admin Facade For Organizations

**Files:**
- Modify: `services/ai-gateway/src/http/admin.ts`
- Create: `services/ai-gateway/test/admin-organization-facade.test.ts`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`
- Modify: `services/ai-gateway/test/admin-user-access.test.ts`

**Step 1: Write failing facade tests**

Create tests proving:

- `GET /admin/api/session` returns visible sections from DEN,
- organization admin can call `GET /admin/api/users` and receives scoped users from DEN,
- organization admin cannot call credentials, sessions, usage, alerts, or audit routes,
- platform admin can call existing managed-AI routes,
- organization endpoints proxy to DEN and preserve DEN errors.

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/admin-organization-facade.test.ts test/admin-user-access.test.ts
```

Expected: FAIL.

**Step 3: Extend `DenAdminApi`**

In `services/ai-gateway/src/http/admin.ts`, extend the DEN client with:

- list/get/update organizations,
- list/create/update/delete domains,
- list/create/revoke/resend invites,
- scoped user list if DEN exposes it separately.

**Step 4: Add route gates**

Add helpers:

- `requirePlatformAdmin(res.locals.adminSession)`
- `requireAdminSection(res.locals.adminSession, section)`
- `requireOrganizationAdminScope(session, orgId)`

Apply gates to every `/admin/api/*` route. Existing managed-AI routes must be platform-admin-only.

**Step 5: Implement facade routes**

Add AI Gateway routes:

- `GET /admin/api/organizations`
- `GET /admin/api/organizations/:orgId`
- `PATCH /admin/api/organizations/:orgId`
- `GET/POST/PATCH/DELETE /admin/api/organizations/:orgId/domains...`
- `GET/POST/POST revoke/resend /admin/api/organizations/:orgId/invites...`

The facade should not persist DEN-owned org data locally.

**Step 6: Run tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/admin-organization-facade.test.ts test/admin-ui.test.ts test/admin-user-access.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add services/ai-gateway/src/http/admin.ts services/ai-gateway/test/admin-organization-facade.test.ts services/ai-gateway/test/admin-ui.test.ts services/ai-gateway/test/admin-user-access.test.ts
git commit -m "feat: proxy organization admin through gateway admin"
```

## Task 6: Admin UI Navigation, Users, And Organization Pages

**Files:**
- Modify: `services/ai-gateway/public-admin/index.html`
- Modify: `services/ai-gateway/public-admin/app.js`
- Modify: `services/ai-gateway/public-admin/app.css`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write failing UI source tests**

Add assertions that admin HTML/JS contains:

- Organization nav item,
- capability-based nav filtering,
- no top-level Domains or Approvals nav,
- Users page scoped copy for organization admins,
- Organization page sections: Overview, Members, Invites, Domains, Settings,
- Save-only dirty state helpers,
- Organization Admin cannot see credential nav.

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/admin-ui.test.ts
```

Expected: FAIL.

**Step 2: Add capability-based nav**

In `app.js`:

- read `session.visibleAdminSections`,
- render only allowed nav items,
- redirect organization admins away from forbidden routes,
- show `Users` and `Organization` only for organization admins.

**Step 3: Add Organization page**

In `index.html`, add one `data-page="organization"` section with:

- Overview summary,
- Members panel,
- Invites panel,
- Domains panel,
- Settings panel.

Use existing static admin style patterns. Do not add a separate frontend framework.

**Step 4: Implement Save-only form state**

In `app.js`, add shared helpers:

- `createDirtyFormState(initial)`
- `markDirty(formKey)`
- `resetForm(formKey)`
- `saveForm(formKey, submit)`

Apply to Users and Organization forms. Do not submit on checkbox/toggle changes.

**Step 5: Add command action handlers**

Add explicit handlers for:

- invite user,
- revoke invite,
- resend invite,
- disable/enable user,
- remove from organization.

Use confirmation dialogs for destructive actions.

**Step 6: Run UI tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/admin-ui.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add services/ai-gateway/public-admin/index.html services/ai-gateway/public-admin/app.js services/ai-gateway/public-admin/app.css services/ai-gateway/test/admin-ui.test.ts
git commit -m "feat: add organization admin UI"
```

## Task 7: Codex Capacity Read Model

**Files:**
- Create: `services/ai-gateway/src/usage/codex-capacity.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`
- Create: `services/ai-gateway/test/codex-capacity.test.ts`
- Modify: `services/ai-gateway/test/admin-read-models.test.ts`
- Modify: `services/ai-gateway/test/admin-ui.test.ts`

**Step 1: Write failing capacity tests**

Create `services/ai-gateway/test/codex-capacity.test.ts`:

```ts
import assert from "node:assert/strict"
import test from "node:test"
import { summarizeCodexCapacity } from "../src/usage/codex-capacity.js"

test("summarizes 5h and weekly remaining capacity across measurable functional credentials", () => {
  const summary = summarizeCodexCapacity({
    credentials: [
      {
        id: "cred_1",
        name: "Codex A",
        eligibilityState: "eligible",
        activeLeases: 2,
        statusCheckedAt: "2026-06-06T10:00:00.000Z",
        limits: {
          fiveHour: { used: 40, limit: 100, resetAt: "2026-06-06T12:00:00.000Z" },
          weekly: { used: 300, limit: 1000, resetAt: "2026-06-09T00:00:00.000Z" },
        },
      },
      {
        id: "cred_2",
        name: "Codex B",
        eligibilityState: "eligible",
        activeLeases: 1,
        statusCheckedAt: "2026-06-06T10:00:00.000Z",
        limits: {
          fiveHour: { used: 80, limit: 100, resetAt: "2026-06-06T11:00:00.000Z" },
          weekly: { used: 500, limit: 1000, resetAt: "2026-06-08T00:00:00.000Z" },
        },
      },
    ],
  })

  assert.equal(summary.fiveHour.usedPercent, 60)
  assert.equal(summary.fiveHour.remaining, 80)
  assert.equal(summary.weekly.usedPercent, 40)
  assert.equal(summary.weekly.remaining, 1200)
  assert.equal(summary.fiveHour.nearestResetAt, "2026-06-06T11:00:00.000Z")
})

test("keeps functional unknown-capacity credentials out of percentage denominator", () => {
  const summary = summarizeCodexCapacity({
    credentials: [
      {
        id: "cred_unknown",
        name: "Codex Unknown",
        eligibilityState: "eligible",
        activeLeases: 0,
        statusCheckedAt: "2026-06-06T10:00:00.000Z",
        limits: { fiveHour: null, weekly: null },
      },
    ],
  })

  assert.equal(summary.fiveHour.measurableCredentials, 0)
  assert.equal(summary.fiveHour.unknownFunctionalCredentials, 1)
})

test("reports Codex limit visibility failure separately from unknown credential capacity", () => {
  const summary = summarizeCodexCapacity({
    credentials: [],
    limitReadError: {
      code: "codex_limits_unavailable",
      message: "Codex limits endpoint returned 403",
      occurredAt: "2026-06-06T10:00:00.000Z",
    },
    lastSuccessfulLimitReadAt: "2026-06-06T09:00:00.000Z",
  })

  assert.equal(summary.limitVisibility.status, "unavailable")
  assert.equal(summary.limitVisibility.errorCode, "codex_limits_unavailable")
  assert.equal(summary.limitVisibility.lastSuccessfulReadAt, "2026-06-06T09:00:00.000Z")
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/codex-capacity.test.ts
```

Expected: FAIL.

**Step 3: Implement capacity summary**

Create `services/ai-gateway/src/usage/codex-capacity.ts`.

Implement:

- `summarizeCodexCapacity(input)`
- per-window aggregation for 5h and weekly,
- unknown functional credential handling,
- limit visibility state: `current`, `stale`, or `unavailable`,
- last successful Codex limit read time and safe failure reason,
- excluded credential reason mapping.

**Step 4: Add capacity to admin usage response**

In `services/ai-gateway/src/http/admin.ts`, include capacity summary in `getUsage` response.

Add admin read model tests proving:

- capacity summary is present,
- 5h and weekly windows are separate,
- unknown-capacity credentials are listed separately,
- Codex limit visibility failure is represented separately from unknown credential capacity,
- excluded credentials include reason.

**Step 5: Add UI rendering**

In admin UI:

- add 5h capacity remaining card,
- add weekly capacity remaining card,
- show included credential count,
- show unknown functional credential count,
- show Codex limit telemetry state and last successful read time,
- show credential breakdown in Usage table.

**Step 6: Run tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/codex-capacity.test.ts test/admin-read-models.test.ts test/admin-ui.test.ts
```

Expected: PASS.

**Step 7: Commit**

```bash
git add services/ai-gateway/src/usage/codex-capacity.ts services/ai-gateway/src/http/admin.ts services/ai-gateway/public-admin/index.html services/ai-gateway/public-admin/app.js services/ai-gateway/public-admin/app.css services/ai-gateway/test/codex-capacity.test.ts services/ai-gateway/test/admin-read-models.test.ts services/ai-gateway/test/admin-ui.test.ts
git commit -m "feat: show Codex pool capacity"
```

## Task 8: Persistent Alert Policy And Email Attempts

**Files:**
- Modify: `services/ai-gateway/src/db/schema.ts`
- Create: `services/ai-gateway/drizzle/0003_vslo_201_alert_policy.sql`
- Modify: `services/ai-gateway/src/alerts/repository.ts`
- Modify: `services/ai-gateway/src/alerts/mysql-repository.ts`
- Create: `services/ai-gateway/src/alerts/policy.ts`
- Create: `services/ai-gateway/src/email/alert-mailer.ts`
- Modify: `services/ai-gateway/src/env.ts`
- Create: `services/ai-gateway/test/alert-policy.test.ts`
- Create: `services/ai-gateway/test/alert-email.test.ts`
- Modify: `services/ai-gateway/test/admin-alerts.test.ts`

**Step 1: Write failing alert policy tests**

Create tests proving:

- 80 percent pool usage creates warning,
- 90 percent pool usage creates critical,
- 95 percent pool usage creates a distinct urgent alert,
- 95 percent pool usage creates an immediate expanded email delivery intent to every platform admin recipient,
- 100 percent pool usage creates a distinct exhausted critical alert,
- 100 percent pool usage creates an immediate expanded email delivery intent,
- Codex limit visibility failure creates a distinct critical alert,
- Codex limit visibility failure creates an immediate expanded email delivery intent,
- 5h and weekly alerts have distinct keys,
- alert dedupe updates an existing alert instead of creating duplicates,
- warning-to-critical worsening re-notifies,
- critical-to-urgent worsening re-notifies,
- urgent-to-exhausted worsening re-notifies,
- resolved alert reopens on later worsening.

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/alert-policy.test.ts
```

Expected: FAIL.

**Step 3: Add alert persistence schema**

Add tables:

- `alert`
- `alert_event`
- `alert_delivery_attempt`

Fields should support:

- stable alert key,
- severity,
- status,
- source,
- credential id,
- pool/window metadata,
- JSON payload for credential breakdown,
- first/last seen,
- acknowledged/resolved actor metadata,
- delivery status and error.

**Step 4: Implement policy**

Create `services/ai-gateway/src/alerts/policy.ts`.

Inputs:

- Codex capacity summary,
- Codex limit visibility status,
- credential health events,
- current credential states.

Outputs:

- alert upsert requests,
- delivery intent requests.

Use stable alert keys for the new conditions:

- `capacity.codex.pool.5h.exhausted`
- `capacity.codex.pool.weekly.exhausted`
- `capacity.codex.pool.5h.urgent`
- `capacity.codex.pool.weekly.urgent`
- `capacity.codex.limits.unavailable`

**Step 5: Implement repository**

Update MySQL alert repository to:

- list persistent alerts,
- upsert alerts by key,
- acknowledge,
- resolve,
- record delivery attempt,
- keep credential-health-derived alerts only as inputs to policy, not as the final read model.

**Step 6: Add email mailer**

Create `services/ai-gateway/src/email/alert-mailer.ts`.

Use env-based configuration. Add env fields in `services/ai-gateway/src/env.ts`:

- `AI_GATEWAY_ALERT_EMAIL_RECIPIENTS`
- `AI_GATEWAY_ALERT_EMAIL_FROM`
- `AI_GATEWAY_ALERT_EMAIL_FROM_NAME`
- `LETTR_API_KEY` or service-specific equivalent if sharing the existing provider config is acceptable.

Do not print secrets.

Email tests must prove that 95 percent pool capacity, 100 percent pool exhaustion, and Codex limit visibility failures use the expanded high-priority template. For 95 percent alerts, assert that every platform admin recipient is included, with optional explicit recipients added on top. The template should include an urgent subject, pool status, current routing impact, 5h and weekly capacity summary, credential breakdown, unknown or stale credentials, last successful limit read, safe failure reason, and recommended recovery action.

**Step 7: Wire alert generation**

Wire policy evaluation into admin read/update paths conservatively first:

- before `listAlerts`,
- before `getUsage` if capacity is already computed there.

If this becomes too expensive, add a later scheduled evaluator. Keep the first implementation simple and deterministic.

**Step 8: Run tests**

Run:

```bash
pnpm --filter @neatech/ai-gateway test -- test/alert-policy.test.ts test/alert-email.test.ts test/admin-alerts.test.ts
```

Expected: PASS.

**Step 9: Commit**

```bash
git add services/ai-gateway/src/db/schema.ts services/ai-gateway/drizzle services/ai-gateway/src/alerts services/ai-gateway/src/email/alert-mailer.ts services/ai-gateway/src/env.ts services/ai-gateway/test/alert-policy.test.ts services/ai-gateway/test/alert-email.test.ts services/ai-gateway/test/admin-alerts.test.ts
git commit -m "feat: persist capacity alerts and email attempts"
```

## Task 9: Last Platform Admin Guard

**Files:**
- Modify: `services/den/src/http/admin-runtime.ts`
- Modify: `services/den/src/http/admin.ts`
- Create or modify: `services/den/test/admin-last-platform-admin.test.ts`
- Modify: `services/ai-gateway/test/admin-organization-facade.test.ts`

**Step 1: Write failing tests**

Cover:

- cannot demote last platform admin,
- cannot disable last platform admin,
- cannot delete last platform admin,
- can remove organization admin role even if it is the last org admin.

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/den test -- test/admin-last-platform-admin.test.ts
```

Expected: FAIL.

**Step 3: Implement guard**

Reuse or harden existing platform admin retention logic.

Ensure all code paths call it:

- update platform role,
- disable user,
- delete user.

Do not apply this guard to organization admin role removal.

**Step 4: Run tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/admin-last-platform-admin.test.ts test/admin-routes.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/src/http/admin-runtime.ts services/den/src/http/admin.ts services/den/test/admin-last-platform-admin.test.ts services/den/test/admin-routes.test.ts
git commit -m "fix: prevent removing last platform admin"
```

## Task 10: Admin Error Handling And Stale Saves

**Files:**
- Modify: `services/den/src/http/admin-runtime.ts`
- Modify: `services/den/src/http/orgs.ts`
- Modify: `services/ai-gateway/src/http/admin.ts`
- Modify: `services/ai-gateway/public-admin/app.js`
- Create: `services/ai-gateway/test/admin-save-behavior.test.ts`
- Modify: `services/den/test/admin-organization-routes.test.ts`

**Step 1: Write failing tests**

Test stable errors:

- `seat_limit_reached`
- `domain_not_allowed`
- `domain_already_claimed`
- `last_platform_admin_required`
- `organization_forbidden`
- `platform_admin_required`
- `stale_update`
- `alert_email_failed`
- `capacity_unknown`
- `codex_limits_unavailable`

**Step 2: Run tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/admin-organization-routes.test.ts
pnpm --filter @neatech/ai-gateway test -- test/admin-save-behavior.test.ts
```

Expected: FAIL.

**Step 3: Implement stable error mapping**

In DEN, throw or return stable error codes from org/user routes.

In AI Gateway facade, preserve DEN error codes and statuses instead of replacing them with generic `request_failed`.

In admin UI, map stable codes to clear operator-facing messages.

**Step 4: Implement stale save behavior**

Use `updatedAt` or equivalent version fields for organization/user/domain forms.

On stale save:

- return `409 { error: "stale_update" }`,
- keep local dirty state,
- offer refresh/discard in UI.

**Step 5: Run tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/admin-organization-routes.test.ts
pnpm --filter @neatech/ai-gateway test -- test/admin-save-behavior.test.ts
```

Expected: PASS.

**Step 6: Commit**

```bash
git add services/den/src/http/admin-runtime.ts services/den/src/http/orgs.ts services/ai-gateway/src/http/admin.ts services/ai-gateway/public-admin/app.js services/ai-gateway/test/admin-save-behavior.test.ts services/den/test/admin-organization-routes.test.ts
git commit -m "feat: add admin save error handling"
```

## Task 11: E2E Coverage

**Files:**
- Create: `packages/e2e/specs/admin-gateway-roles.spec.ts`
- Create or modify: `packages/e2e/helpers/admin-gateway-seed.ts`
- Modify: `packages/e2e/helpers/live-admin-client.ts`
- Modify: `packages/e2e/helpers/live-admin-check.ts`

**Step 1: Write E2E spec skeleton**

Add specs for:

- platform admin sees all sections,
- organization admin sees only Users and Organization,
- organization admin cannot navigate directly to Credentials/Usage/Alerts,
- Save-only form behavior on Users or Organization,
- enabled domain signup produces active membership up to seat limit,
- invite-only domain blocks self-signup.

**Step 2: Run desktop preflight**

Run from repo root:

```bash
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true
```

Stop only internally-started matching processes from this repo, then verify empty as required by `docs/dev/testing-playbook.md`.

**Step 3: Build E2E desktop binary**

Run:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e
```

Expected: build succeeds.

**Step 4: Run focused spec**

Run:

```bash
cd packages/e2e
pnpm test --spec ./specs/admin-gateway-roles.spec.ts
```

Expected: PASS or a clearly documented environment blocker.

**Step 5: Commit**

```bash
git add packages/e2e/specs/admin-gateway-roles.spec.ts packages/e2e/helpers/admin-gateway-seed.ts packages/e2e/helpers/live-admin-client.ts packages/e2e/helpers/live-admin-check.ts
git commit -m "test: cover admin gateway roles e2e"
```

## Task 12: Documentation Updates

**Files:**
- Modify: `docs/features/onboarding-and-auth.md`
- Modify: `docs/features/session-runtime.md`
- Modify: `docs/dev/state-and-config-reference.md`
- Modify: `docs/dev/app-map.md`

**Step 1: Update onboarding docs**

Document:

- enabled organization domains auto-activate users up to seat limit,
- invite-only behavior when no enabled domain allows signup,
- Organization Admin scope.

**Step 2: Update session runtime docs**

Document:

- active org membership is required before managed-AI access becomes usable,
- seat-limit failures are auth/onboarding failures, not provider failures,
- admin shell remains `ai.veslo.work/admin`.

**Step 3: Update state/config docs**

Document new persistence:

- organization domains,
- invites,
- membership status,
- alert persistence and delivery attempts,
- capacity summary semantics.
- Codex limit visibility failure semantics and high-priority alert email behavior.

**Step 4: Update app map**

Add the new DEN org-admin and AI Gateway admin/capacity/alert modules.

**Step 5: Run docs grep sanity**

Run:

```bash
rg -n "pending approval|Approvals|autosave|auto-save|owner" docs/features docs/dev docs/plans/2026-06-06-vslo-201-admin-gateway-design.md
```

Expected: no stale claims that domain signup defaults to pending approval, no stale recommendation to autosave admin settings. Existing unrelated "owner" terminology may remain where not part of organization admin behavior.

**Step 6: Commit**

```bash
git add docs/features/onboarding-and-auth.md docs/features/session-runtime.md docs/dev/state-and-config-reference.md docs/dev/app-map.md
git commit -m "docs: document admin gateway organization behavior"
```

## Task 13: Final Verification

**Files:**
- No source files unless verification exposes a bug.

**Step 1: Run focused service tests**

Run:

```bash
pnpm --filter @neatech/den test -- test/admin-gateway-org-schema.test.ts test/org-admin-policy.test.ts test/org-admin-repository.test.ts test/signup-domain-gate.test.ts test/admin-organization-routes.test.ts test/admin-last-platform-admin.test.ts
pnpm --filter @neatech/ai-gateway test -- test/admin-organization-facade.test.ts test/admin-ui.test.ts test/codex-capacity.test.ts test/alert-policy.test.ts test/alert-email.test.ts test/admin-alerts.test.ts test/admin-save-behavior.test.ts
```

Expected: PASS.

**Step 2: Run builds**

Run:

```bash
pnpm --filter @neatech/den build
pnpm --filter @neatech/ai-gateway build
```

Expected: PASS.

**Step 3: Run E2E**

Run the desktop preflight from `docs/dev/testing-playbook.md`, then:

```bash
cd packages/desktop
pnpm tauri build --debug --no-bundle --config src-tauri/tauri.dev.conf.json -- --features e2e

cd ../e2e
pnpm test --spec ./specs/admin-gateway-roles.spec.ts
```

Expected: PASS or documented environment blocker.

**Step 4: Run broad regression if time permits**

Run:

```bash
pnpm --filter @neatech/den test
pnpm --filter @neatech/ai-gateway test
```

Expected: PASS.

**Step 5: Final commit**

If any final fixes were needed:

```bash
git add <changed files>
git commit -m "fix: stabilize VSLO-201 admin gateway"
```

## Execution Notes

- Use frequent commits after each task.
- Keep DEN-owned organization data out of the AI Gateway database.
- Keep organization admins scoped server-side, not only in UI.
- Do not autosave form fields.
- Last-admin guard applies only to platform admins.
- Unknown Codex capacity is not included in pool percentage denominators.
- Alert emails must include credential breakdown for capacity alerts.
- Alerting must include 80 percent, 90 percent, 95 percent, and 100 percent capacity thresholds.
- 95 percent capacity must send urgent email to every platform admin recipient.
- Codex limit visibility failure must page admins with an expanded high-priority email.
