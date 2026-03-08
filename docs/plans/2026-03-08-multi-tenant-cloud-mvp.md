# Veslo Multi-Tenant Cloud MVP
Date: 2026-03-08

This is the reduced invite-first MVP.

## MVP Goal
Ship true tenant separation first, without domain automation or artifact sharing workflows.

## In MVP
- strict `org_id` isolation on all org-scoped data
- explicit org selection instead of `first membership wins`
- roles: `platform_admin`, `org_owner`, `org_member`
- personal org auto-created on signup remains in place
- multi-org access happens through owner-managed membership, not domain matching
- members can create projects
- cloud control exposes an active-organization selector for multi-org users
- platform settings are admin-only

## Not in MVP
- domain-based create/join routing
- `org_domain`
- `org_join_request`
- owner approval queues for domain users
- org model profile settings
- org-owned billing rewrite
- admin-invoiced billing
- global artifact sharing
- member contribution workflow
- org-to-global promotion
- AI project audits/auto-stop
- owner-inaccessible private member projects
- `Workers -> Projects` UI rename

## MVP Technical Changes
1. Replace implicit org resolution in Den with explicit org context on requests.
2. Add platform admin role storage and admin authorization checks.
3. Add organization list/switch support for authenticated users with multiple memberships.
4. Add owner-managed member add/remove/promote flows.
5. Scope project list/create/get/delete/token APIs to validated active org membership.
6. Keep current billing implementation unchanged for this MVP.

## Required MVP Functions
1. `resolveUserOrganizations(userId)`
2. `readRequestedOrganizationId(request)`
3. `requireOrganizationAccess(request, response, options)`
4. `isPlatformAdmin(userId)`
5. `listOrganizations(userId)`
6. `listOrganizationMembers(orgId, actorId)`
7. `addOrganizationMemberByEmail(orgId, ownerId, email, role)`
8. `removeOrganizationMember(orgId, ownerId, memberId)`
9. `updateOrganizationMemberRole(orgId, ownerId, memberId, role)`
10. `createProject(orgId, actorId, payload)`
11. `listProjects(orgId, actorId)`
12. `getProject(orgId, actorId, projectId)`
13. `issueProjectTokens(orgId, actorId, projectId)`
14. `deleteProject(orgId, actorId, projectId)`
15. `recordAuditEvent(input)`

## Required MVP Tables
- `platform_role`
- existing `org`
- existing `org_membership`
- existing `worker`
- existing `audit_event`

## Current Code Gaps
- `services/den/src/auth.ts` auto-creates a personal org and stops there.
- `services/den/src/http/workers.ts` still uses `getOrgId(userId).limit(1)`.
- worker endpoints are org-scoped, but only through that implicit first-membership lookup.
- there are no organization membership management endpoints.
- there is no admin role model yet.

## Acceptance Criteria
- A user with memberships in two orgs can switch orgs and see different projects in cloud control.
- A member cannot access projects from an org they do not belong to.
- An owner can add another existing user into the org.
- An owner can promote or remove org members without leaving the org ownerless.
- A platform admin can bypass org ownership checks for exceptional operations.
- Existing single-org users continue to work without migration pain.
