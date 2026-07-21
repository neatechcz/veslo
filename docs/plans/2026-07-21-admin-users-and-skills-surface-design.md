# Admin Users and Skills Surface Design

Date: 2026-07-21

Status: Approved

## Goal

Place user and managed-skill administration in the right Veslo surfaces while
preserving the existing distinction between cloud governance and local skill
execution.

The design must serve two administrator roles:

- organization administrators manage their own members and organization-owned
  skills;
- platform administrators manage platform-wide state and can perform every
  organization-administrator operation after explicitly selecting an
  organization.

## Decision

The existing web Admin UI is the single cloud-governance surface for users,
organizations, organization skills, and platform skills. The desktop app
remains the workbench for authoring, testing, locally installing, and using
skills.

Cloud administration will not be duplicated in the desktop app. The desktop
may link into the correct organization page in the web Admin UI and may show
the effective managed state required to explain local runtime behavior.

## Alternatives considered

### Web Admin UI as the canonical governance surface

This is the selected approach. It extends the existing organization workspace,
member management, role model, audit model, and platform administration. It is
available independently of a particular desktop installation and keeps cloud
governance next to other cloud-owned controls.

### Desktop-only administration

This would put organization membership and platform governance into the local
runtime application. It would couple administrative access to a desktop
installation, mix local filesystem concerns with cloud control-plane concerns,
and duplicate the existing Admin UI authorization model.

### Full administration in both web and desktop

This would create two mutation surfaces, two navigation models, and a long-term
risk that permissions, validation, and error behavior diverge. Veslo may expose
read-only managed state and deep links in the desktop app, but not a second
complete administration product.

## Durable authorization principle

Every operation available to an organization administrator must also be
available to a platform administrator within an explicitly selected
organization.

The platform administrator receives the same organization-scoped capability,
not the identity of an organization administrator. No user session, display
identity, or audit actor is impersonated. The backend authorizes the real
platform administrator against the target organization and records:

- the real actor user id;
- the target organization id;
- the affected resource and operation;
- whether authority came from `organization_admin` or `platform_admin`.

Both roles use the same domain command, validation, and organization-scoped API
path. The platform administrator does not need to be inserted as an
organization member. Platform-wide routes cannot be used as an unscoped
shortcut for organization mutations.

## Information architecture

### Platform administration

The platform navigation contains:

- **Platform Users** for the global user directory, account state, and platform
  role assignment;
- **Organizations** for selecting an organization workspace;
- **Platform Skills** for the platform catalog, system review queue, approved
  versions, global installations, and platform rollout policies;
- the existing platform AI infrastructure and global audit areas.

Platform Skills is available only to platform administrators. Its actions
operate on platform-owned registry records and never infer an organization.

### Organization workspace

The organization navigation gains **Skills** alongside Overview, Members,
Domains & Invites, Billing, AI Access, and Audit. Its canonical route is:

```text
/admin/organizations/:organizationId/skills
```

The page is available to an administrator of that organization and to a
platform administrator who selected the organization. It contains four
subsections or tabs:

1. **Catalog** — organization-owned skills and their current approved version.
2. **Review requests** — pending, approved, and rejected organization publish
   requests with version evidence.
3. **Rollouts** — target, audience, update policy, removal policy, and enabled
   state.
4. **Installations** — organization, workspace, and user-targeted managed
   installations with restore state.

The page header always shows the selected organization. For a platform
administrator it also shows a persistent “Managing organization” indicator so
the elevated cross-organization context cannot be mistaken for platform-wide
state.

### Desktop application

The desktop Skills page continues to own:

- user and workspace skill authoring;
- editing and file inspection;
- testing in the real local runtime;
- local installation, removal, restore, and materialization status;
- submitting an organization publish request or platform approval request;
- explaining which managed policy produced an effective local skill.

It does not manage organization members, approve review requests, create
organization or platform rollout policies, or expose the global user directory.
When the signed-in user has administration access, it may offer **Manage
organization skills** and **Manage platform skills** links to the corresponding
web routes.

## Service and data boundaries

Den remains the source of truth for identity, organizations, memberships,
platform roles, and the skill registry. The existing Admin UI remains the
browser-facing shell. Its server-side admin facade forwards authenticated,
organization-qualified skill operations to Den, following the same pattern as
the existing Den-backed organization and member administration.

The browser never receives a global collection in order to filter it into an
organization view. Organization pages request only organization-qualified
data. Platform skill pages request platform-qualified data without retaining a
previous organization selection.

The local Veslo server remains responsible for materializing approved registry
packages into desktop runtime skill roots. The Admin UI changes desired cloud
state; desktops observe registry events and reconcile local materialization.

## Primary data flows

### Organization skill publication

1. A user authors and tests a local skill in the desktop app.
2. The desktop app packages the immutable version and submits an organization
   review request.
3. An organization administrator, or a platform administrator in the selected
   organization, reviews the request in the web Admin UI.
4. Approval promotes the version into the organization catalog.
5. An administrator creates or updates an organization rollout or installation.
6. Registry events notify signed-in desktops, which reconcile materialization
   through the local server.

### Platform skill publication

1. A user or internal author submits a platform approval request.
2. A platform administrator reviews it under Platform Skills.
3. Approval promotes the version into the platform catalog.
4. A platform administrator configures the platform rollout.
5. Desktops reconcile the desired platform-managed state through the same
   registry and local materialization flow.

### Platform administrator managing an organization

1. The platform administrator selects an organization from the existing
   organization directory or selector.
2. Navigation enters an organization-qualified route.
3. The server verifies the real platform role and the target organization.
4. The same organization command used for an organization administrator runs.
5. Audit records the real platform administrator and the selected organization.

## Error and isolation behavior

The Skills pages follow the existing fail-closed Admin UI contract:

- route changes clear prior organization data before loading the destination;
- late responses cannot update a newer organization route generation;
- `401` ends the admin session;
- `403` renders Access denied without stale records;
- `404` renders Organization not found for an invalid organization route;
- registry or validation failures retain the current form or review evidence
  and display a safe actionable error;
- mutations are disabled until the current scoped page is ready;
- a platform-to-organization transition never retains platform skill actions,
  and an organization switch never retains the previous organization's skill
  rows or dialogs.

## Testing strategy

Primary verification is browser-level E2E coverage of the deployed-style Admin
UI plus focused backend contract tests.

Required role scenarios:

- an organization administrator can list, review, approve, reject, install,
  restore, and configure rollout for their organization;
- that administrator cannot access another organization or Platform Skills;
- a platform administrator can perform the same organization operations after
  selecting any organization without becoming a member;
- platform-admin organization mutations record the real actor and
  `platform_admin` authority;
- a platform administrator can manage Platform Skills;
- ordinary members cannot reach either administration surface.

Required isolation scenarios:

- switching organizations never renders a stale skill row, review, rollout,
  installation, dialog, or accessible label from the previous organization;
- organization pages never request the global skill or user directory;
- platform pages do not retain or submit an organization id;
- delayed mutation responses cannot close dialogs or publish success after the
  route or organization changes.

The desktop E2E lane verifies the boundary rather than duplicating web admin
coverage: submit a publish request, observe an approved rollout event, reconcile
materialization in the real Tauri runtime, and open the correct web-admin deep
link.

## Non-goals

- Rebuilding the complete web Admin UI inside the desktop app.
- Logging in as or issuing a session for another organization administrator.
- Creating a second skill registry or duplicating Den-owned skill state in the
  Admin UI service.
- Making platform-wide routes mutate organization-owned resources without an
  explicit organization target.
- Adding marketplace pricing, ratings, purchases, or entitlements.

## Acceptance criteria

- User and organization administration remain in the existing web Admin UI.
- Organization Skills is an organization-qualified admin workspace available
  to both authorized organization administrators and platform administrators.
- Platform Skills is a separate platform-only workspace.
- Platform administrators use organization capabilities without identity
  impersonation or membership injection.
- Every organization mutation records the real actor, target organization, and
  authority source.
- The desktop remains the local skill workbench and links to web governance
  instead of duplicating it.
- Browser and desktop E2E coverage prove role boundaries, organization
  isolation, publication, rollout, and materialization.
