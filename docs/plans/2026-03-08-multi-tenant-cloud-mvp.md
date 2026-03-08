# Veslo Multi-Tenant Cloud MVP
Date: 2026-03-08

This document contains only what is necessary for the first multi-tenant version.

## MVP Scope
- strict org isolation with `org_id`
- active organization context per request/session
- role separation: `platform_admin`, `org_owner`, `org_member`
- project creation enabled for all org users
- workers renamed to projects in UI only
- org-owned billing with one subscription per org
- admin trial end override
- platform settings hidden from owners/members

## Domain Onboarding (MVP)
- If no org exists for domain: user creates org and becomes owner.
- If org exists and domain is open: user can create new org or request join.
- If owner locks domain to join-only: user can only request join.
- Join may require owner approval.
- Public-domain list is advisory; behavior must not rely on full completeness.

## Permission Model (MVP)
- Member:
  - create projects
  - edit/stop own or assigned projects
- Owner:
  - all member capabilities
  - manage membership and roles
  - manage org settings and billing flows
  - stop any org project
- Platform admin:
  - stronger-than-owner global authority
  - org suspension and exceptional interventions
  - full platform settings access
  - all admin actions audited with reason/scope

## Billing Model (MVP)
- One subscription per org.
- Owners are billing operators.
- Billing modes:
  - self-serve (Polar/Stripe)
  - admin-invoiced (owner request, admin approval)
- Admin can set/extend trial end date per org.

## Required MVP Functions
1. `resolveUserOrganizations(userId)`
2. `setActiveOrganization(sessionId, orgId)`
3. `requireOrgContext(request)`
4. `requireOrgRole(orgId, userId, role)`
5. `parseEmailDomain(email)`
6. `findOrganizationsByDomain(domain)`
7. `getDomainOnboardingOptions(userId, domain)`
8. `createOrganization(input, ownerUserId)`
9. `setOrganizationDomainPolicy(orgId, ownerId, policy)`
10. `requestOrganizationJoin(orgId, userId)`
11. `approveOrganizationJoin(orgId, ownerId, requestId)`
12. `inviteOrganizationMember(orgId, ownerId, email, role)`
13. `updateOrganizationMemberRole(orgId, ownerId, memberId, role)`
14. `createProject(orgId, actorId, payload)`
15. `listProjects(orgId, actorId)`
16. `updateProject(projectId, actorId, payload)`
17. `stopProject(projectId, actorId, reason)`
18. `adminSuspendOrganization(orgId, adminId, reason)`
19. `getOrganizationBilling(orgId, actorId)`
20. `startOrganizationCheckout(orgId, ownerId)`
21. `requestInvoicedBilling(orgId, ownerId)`
22. `approveInvoicedBilling(orgId, adminId)`
23. `setOrganizationTrialEnd(orgId, adminId, trialEndsAt)`
24. `getOrganizationSettings(orgId, actorId)`
25. `updateOrganizationSettings(orgId, ownerId, patch)`
26. `getPlatformSettings(adminId)`
27. `updatePlatformSettings(adminId, patch)`
28. `recordAuditEvent(input)`

## Required MVP Tables
- `platform_role`
- `org`
- `org_domain`
- `org_membership`
- `org_join_request`
- `org_settings`
- `org_subscription`
- `org_billing_request`
- `audit_event`

## Not in MVP
- global artifact catalog
- member contribution workflow UI
- org-to-global promotion workflow
- AI auto-audits/auto-stop
- owner-inaccessible private member projects

