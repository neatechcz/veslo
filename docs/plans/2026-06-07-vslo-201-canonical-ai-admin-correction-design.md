# VSLO-201 Canonical AI Admin Correction Design

## Status

Approved correction for the VSLO-201 admin gateway implementation. This document supersedes the accidental two-admin interpretation of the earlier work.

## Decision

There is one product admin for this task: `https://ai.veslo.work/admin`.

When the project says "Admin Gateway", "admin", or "admin page" in VSLO-201 context, it means the AI Gateway admin shell at `ai.veslo.work/admin` and its subpages. DEN is not a second product admin UI.

## What Went Wrong

The original VSLO-201 design correctly identified `ai.veslo.work/admin` as the admin shell. Later implementation work updated both the AI Gateway public admin and a DEN public admin. Some later UI fixes landed only in the DEN public admin, so the production AI Gateway admin did not receive the visible Pencil V2 redesign.

That split created two conflicting admin products:

- `ai.veslo.work/admin`: the intended AI Gateway admin shell.
- `api.veslo.work/admin`: an accidental DEN admin shell.

The correction is to remove that split and make the AI Gateway admin the only user-facing admin.

## Target Architecture

AI Gateway owns and serves the admin UI:

- static admin shell,
- credentials,
- usage and Codex capacity,
- alerts,
- managed-AI user access,
- audit read model,
- facade routes under `/admin/api/*`.

DEN remains a backend authority:

- auth sessions,
- users,
- organizations,
- domains,
- invites,
- memberships,
- platform roles,
- seat limits.

AI Gateway calls DEN through admin APIs. DEN may keep `/v1/admin` and `/admin/api` backend APIs where the facade or legacy integrations need them, but DEN must not serve a separate admin shell.

## DEN `/admin` Behavior

`api.veslo.work/admin` should redirect to `https://ai.veslo.work/admin`.

The redirect must not break:

- `/admin/api/*`,
- `/v1/admin/*`,
- OpenAI OAuth admin API callbacks that are still implemented under DEN's admin API surface.

Only the static DEN admin page and its frontend assets are removed from the product surface.

## UI Contract

The Pencil V2 direction is the visual and interaction contract:

- platform admin navigation: Overview, Organization, Users, Credentials, Usage, Alerts, Audit,
- organization admin navigation: Organization, Users only,
- no Sessions page,
- no top-level Domains page,
- no top-level Approvals page,
- no list/detail page that mixes a dense list with an always-visible editor rail when the user is editing a specific item,
- item details and editing should open in modal dialogs,
- all form changes persist only through Save.

Command actions may execute from their own buttons:

- invite,
- resend invite,
- revoke invite,
- enable or disable user,
- delete user,
- drain, rotate, revoke, or delete credential,
- acknowledge or resolve alert.

Destructive commands need confirmation.

## Page Requirements

### Overview

Overview is a command center, not a reporting page. It should summarize current operator attention:

- Codex 5h remaining capacity,
- Codex weekly remaining capacity,
- limit visibility failure state,
- urgent alerts,
- pending invites or blocked domain signup,
- basic system counts.

Unsupported Sessions UI must not appear.

### Organization

Organization is the admission policy surface.

It must show:

- identity and seat usage,
- seat limit as platform-admin editable and organization-admin read-only,
- domains and self-signup behavior,
- pending invites,
- current org admin permission context.

Domain add/edit should use a modal with explicit Save. Invite creation can be an explicit command modal. Inline domain checkbox changes must not save automatically.

### Users

Users is shared by platform admins and organization admins.

The list is for scanning and selection. Creating or editing a user opens a modal. Role toggles and AI access controls save only through the modal Save button.

Platform admin can edit platform-admin role and managed-AI access. Organization admin cannot see or mutate platform admin fields or managed-AI assignments.

Removing the last platform admin is forbidden. Removing the last organization admin is allowed.

### Usage

Usage must prioritize Codex capacity:

- 5h remaining,
- weekly remaining,
- measured credential count,
- unknown-capacity functional credential count,
- unavailable limit telemetry,
- per-credential capacity rows.

Charts and token usage are secondary until capacity is visible.

### Alerts

Alerts is incident triage:

- active, acknowledged, resolved states,
- selected incident details,
- runbook,
- email delivery state when available,
- acknowledge and resolve commands.

Alert thresholds include 80, 90, 95, and 100 percent. The 95 percent urgent state, 100 percent exhausted state, and Codex limit visibility failure must trigger high-priority admin email behavior from the backend policy.

### Credentials

Credentials is the routing inventory.

The table scans provider, state, eligibility, active leases, Codex limits, and linked alerts. Clicking a credential opens a detail modal. Create credential remains platform-admin-only.

### Audit

Audit is read-only.

The existing API supports list/filter/detail from the list payload. It does not support server export, trace request, or separate event detail endpoints. The UI must not expose unsupported export or trace actions.

Clicking an audit row opens a read-only modal based on the loaded event payload.

## API Coverage

Most proposed V2 functions are backed by current APIs:

- organization profile, domains, invites, members,
- users create/update/disable/delete,
- managed-AI access assignment,
- credentials list/create/actions/models,
- usage filters and capacity summary,
- alerts list/acknowledge/resolve,
- audit list.

Unsupported or deliberately removed:

- Sessions UI,
- approval queue,
- manual alert email send button,
- audit CSV export,
- trace request,
- server-side audit event detail endpoint beyond the list payload.

Unsupported functions should not appear in the product screens.

## Documentation Rule

Canonical docs must state that the VSLO-201 admin is `ai.veslo.work/admin`. Any remaining DEN admin API references must describe backend API ownership only, not a second admin UI.

## Verification

Minimum verification:

- static source tests prove modal shells, no Sessions UI, and no DEN admin shell,
- route tests prove DEN `/admin` redirects while `/admin/api` remains API,
- AI Gateway admin tests prove org-admin nav restrictions and Save-only behavior,
- local browser smoke opens AI Gateway admin pages and validates modal open/close behavior,
- production verification compares deployed assets and checks `api.veslo.work/admin` redirect.
