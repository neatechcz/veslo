# Multi-Tenant Cloud Final Spec (MVP)
Date: 2026-03-08

## Objective
Define a strict MVP for a real multi-tenant Veslo cloud model:
- clear separation of `platform_admin` vs `org_owner` vs `org_member`
- hard tenant isolation with `org_id` scoping
- organization-owned billing with one subscription per org
- members can create projects in V1
- UI terminology shifts from **Workers** to **Projects** (UI only)

---

## 1) Final Decisions
| Area | Final Decision | MVP Status |
|---|---|---|
| Tenant model | All tenant entities are scoped by `org_id`; every request requires active org context. | In MVP |
| Roles | `platform_admin` (global), `org_owner`, `org_member`. | In MVP |
| UI naming | Rename Workers to Projects in UI; backend can keep `worker` entity temporarily. | In MVP |
| Project creation | Any org user can create projects. | In MVP |
| Admin authority | Admin rights are stronger than owner rights; intended for exceptional intervention, not daily operation. | In MVP |
| Private member-only projects | Keep extension path open; not implementing in V1. | Post-MVP |
| AI policy audits/auto-stop | Future governance feature. | Post-MVP |

---

## 2) Domain Login and Organization Creation
| Login Condition | User Options | Owner Policy Influence | Outcome |
|---|---|---|---|
| No organization exists for domain | Create organization | N/A | User becomes first owner |
| Organization exists for domain | Create new org or join existing org | Owner can lock behavior | Default open choice unless locked |
| Domain locked to join-only | Join existing only | Owner policy | New org creation disabled for that domain |
| Join requires approval | Submit join request | Owner approves/denies | Membership created after approval |
| Public domain email | Create personal org by default; join via invite/request | Public-domain list is advisory | No hard dependency on perfectly maintained list |

Notes:
- We explicitly do not rely on a perfect public-domain list.
- Owners can decide that matching-domain users may only join and cannot create a new org.

---

## 3) Access and Control Matrix
| Capability | Org Member | Org Owner | Platform Admin |
|---|---|---|---|
| Create project | Yes | Yes | Yes |
| Edit project | Own/assigned projects | Any org project | Global authority |
| Stop project (normal operation) | Own/assigned projects | Any org project | Yes, but exceptional |
| Suspend org execution | No | No | Yes |
| Manage members/roles | No | Yes | Yes |
| View/edit platform settings | No | No | Yes only |
| View/edit org settings | Read/use only (configurable) | Yes | Yes |

Admin intervention policy:
- allowed for security/compliance/billing/recovery incidents
- must always write audit event with `actor`, `reason`, `scope`, `timestamp`

---

## 4) Settings Boundaries
| Scope | Examples | Visibility | Edit Rights |
|---|---|---|---|
| Platform settings | Global model provider credentials, global connectors, platform model catalog | Platform admins only | Platform admins only |
| Organization settings | Join policy, domain lock, org model preference profile | Owners (optional member read-only) | Owners |
| Project settings | Project-level defaults and runtime knobs | Project collaborators | Creator/assigned collaborators + owner |
| User settings | Personal preferences/private artifacts | User only | User only |

---

## 5) Billing Model (Organization-Owned)
| Rule | Decision | MVP Status |
|---|---|---|
| Subscription cardinality | Exactly one subscription per organization | In MVP |
| Billing owner | Organization owners | In MVP |
| Self-serve mode | Checkout via Polar/Stripe | In MVP |
| Admin invoiced mode | Owner requests, admin approves, invoice handled outside in-app card flow | In MVP |
| Trial control | Admin can set or extend trial to any date/time | In MVP |

---

## 6) Artifact Sharing Semantics
| Concept | Final Meaning | MVP Status |
|---|---|---|
| Default scope | Artifacts are private by default (user-private or org-private) | In MVP |
| Sharing model | Sharing is explicit overlay action in UI | In MVP |
| Member contribution | Member submits skill/MCP/automation to owner for org sharing approval | Post-MVP |
| Org-to-global promotion | Owner submits org artifact to global catalog, admin approves | Post-MVP |

---

## 7) Data Model: MVP vs Later
| Table | Purpose | Scope |
|---|---|---|
| `platform_role` | Global admin grants | MVP |
| `org` | Organization root + policy flags | MVP |
| `org_domain` | Domain mapping + domain policy | MVP |
| `org_membership` | Owner/member roles | MVP |
| `org_join_request` | Owner approval join flow | MVP |
| `org_settings` | Org settings, including model preferences | MVP |
| `org_subscription` | Single org subscription + trial end | MVP |
| `org_billing_request` | Invoiced billing request/approval lifecycle | MVP |
| `audit_event` | Immutable logs for privileged actions | MVP |
| `artifact`, `artifact_release`, `artifact_distribution` | Contribution and global-sharing workflows | Post-MVP |

---

## 8) MVP Function Inventory (Required Now)
These are the minimum backend/service functions needed to ship V1 multi-tenancy.

| Function | Purpose | Why Required |
|---|---|---|
| `resolveUserOrganizations(userId)` | List org memberships | Org switch and auth scope |
| `setActiveOrganization(sessionId, orgId)` | Bind active org to session/context | Deterministic tenant context |
| `requireOrgContext(request)` | Validate active org on request | Isolation guard |
| `requireOrgRole(orgId, userId, role)` | Enforce role checks | Role separation |
| `parseEmailDomain(email)` | Normalize login domain | Domain flow |
| `findOrganizationsByDomain(domain)` | Find matching orgs | Join/create decision |
| `getDomainOnboardingOptions(userId, domain)` | Return allowed actions | Domain-policy enforcement |
| `createOrganization(input, ownerUserId)` | Create org + initial owner | Tenant creation |
| `setOrganizationDomainPolicy(orgId, ownerId, policy)` | Configure join-only/approval rules | Owner domain governance |
| `requestOrganizationJoin(orgId, userId)` | Submit join request | Approval flow |
| `approveOrganizationJoin(orgId, ownerId, requestId)` | Approve join request | Owner-controlled membership |
| `inviteOrganizationMember(orgId, ownerId, email, role)` | Invite member/owner | Controlled growth |
| `updateOrganizationMemberRole(orgId, ownerId, memberId, role)` | Promote/demote owner/member | Multi-owner management |
| `createProject(orgId, actorId, payload)` | Create project (backend worker) | Core product operation |
| `listProjects(orgId, actorId)` | List org-scoped projects | Tenant-safe UI data |
| `updateProject(projectId, actorId, payload)` | Edit project details | Project lifecycle |
| `stopProject(projectId, actorId, reason)` | Stop execution | Owner primary control |
| `adminSuspendOrganization(orgId, adminId, reason)` | Exceptional org suspension | Admin superuser safety |
| `getOrganizationBilling(orgId, actorId)` | Read billing state | Owner billing management |
| `startOrganizationCheckout(orgId, ownerId)` | Self-serve checkout | Paid activation path |
| `requestInvoicedBilling(orgId, ownerId)` | Request invoice mode | Enterprise billing path |
| `approveInvoicedBilling(orgId, adminId)` | Approve invoice mode | Admin billing governance |
| `setOrganizationTrialEnd(orgId, adminId, trialEndsAt)` | Set/extend trial | Explicit requirement |
| `getOrganizationSettings(orgId, actorId)` | Read org settings | Org configuration UX |
| `updateOrganizationSettings(orgId, ownerId, patch)` | Edit org settings | Owner control |
| `getPlatformSettings(adminId)` | Read platform settings | Admin-only global control |
| `updatePlatformSettings(adminId, patch)` | Edit platform settings | Admin-only global control |
| `recordAuditEvent(input)` | Persist immutable audit records | Governance + traceability |

---

## 9) Strict MVP Cut (Removed for V1)
| Deferred Capability | Reason Deferred |
|---|---|
| Global artifact catalog publication | Not needed to prove multi-tenant isolation |
| Member contribution workflow UI | Can follow foundation release |
| Org-to-global promotion workflow | Depends on global catalog |
| Automated DNS verification | Optional hardening, not V1-critical |
| AI project audits and auto-stop | Future governance layer |
| Owner-inaccessible private member projects | Future privacy model, keep extension path open |

---

## 10) Implementation Phases (MVP-first)
| Phase | Goal | Deliverable |
|---|---|---|
| Phase 1 | Tenant and role foundation | org context guards, role enforcement, platform admin role |
| Phase 2 | Domain onboarding rules | create/join decision API, owner join policy, join requests |
| Phase 3 | Billing ownership | org subscription model + self-serve + invoiced approvals + trial override |
| Phase 4 | Project UX and permissions | workers->projects UI rename, member project creation, owner/admin controls |
| Phase 5 | Hardening | audit coverage, permission tests, tenant isolation tests |

