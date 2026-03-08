# Multi-Tenant Cloud MVP Implementation Plan

Date: 2026-03-08

This plan matches the reduced `Option A` scope that is now being implemented.

## Goal
Ship the first real multi-tenant Veslo Cloud release with:

- explicit org context
- owner-managed memberships
- platform admin role foundation
- multi-org switching in cloud control

## Out of Scope
- domain-driven onboarding
- org-owned billing rewrite
- admin-invoiced billing
- model/provider org settings
- artifact sharing workflows
- AI project audits
- private member-only projects
- `Workers -> Projects` UI rename

## Implementation Slices

### Slice 1: Tenant and role foundation

Files:
- `services/den/src/db/schema.ts`
- `services/den/drizzle/0003_platform_role.sql`
- `services/den/src/http/access.ts`
- `services/den/src/http/session.ts`
- `services/den/src/http/org-auth.ts`

Deliverables:
- add `platform_role`
- replace hidden first-membership behavior with explicit org resolution
- support `x-veslo-org-id`
- preserve single-org fallback
- allow platform admin override where explicitly needed

### Slice 2: Organization membership APIs

Files:
- `services/den/src/http/orgs.ts`
- `services/den/src/index.ts`
- `services/den/src/audit.ts`

Deliverables:
- `GET /v1/orgs`
- `GET /v1/orgs/:orgId/members`
- `POST /v1/orgs/:orgId/members`
- `PATCH /v1/orgs/:orgId/members/:memberId`
- `DELETE /v1/orgs/:orgId/members/:memberId`
- prevent removing or demoting the final owner
- audit membership changes

### Slice 3: Project scoping

Files:
- `services/den/src/http/workers.ts`

Deliverables:
- list/create/get/delete/token routes scoped by explicit org context
- members can create projects
- delete allowed for creator, owner, or platform admin
- project create/delete audit events
- stop deleting audit history during project deletion

### Slice 4: Cloud control org switching

Files:
- `packages/web/components/cloud-control.tsx`

Deliverables:
- fetch organizations after login
- persist selected org in local storage
- send `x-veslo-org-id` on org-scoped project requests
- show active organization selector in cloud control

## Verification

### Focused rule tests

Files:
- `services/den/test/multi-tenant-rules.test.ts`

Coverage:
- explicit org selection rules
- owner/member role checks
- project delete permission rules
- final-owner protection

Command:

```bash
pnpm --filter @neatech/den test
```

### Type/build verification

Commands:

```bash
pnpm --filter @neatech/den build
pnpm --filter @neatech/veslo-web build
```

## Follow-Up After MVP

1. Add manual org creation and org settings screens.
2. Move billing from user-scoped to org-scoped.
3. Add domain create/join routing.
4. Add richer admin operations and platform settings UI.
