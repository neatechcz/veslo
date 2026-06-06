# Soul Memory Management Design

## Status

Approved design from the June 2026 brainstorming session.

## Goal

Replace the current Soul heartbeat dashboard with a memory-management surface for Organization, User, and Workspace Soul documents. The page should manage durable memory, versions, permissions, API access, Den sync, Heartbeat behavior, and localization while fitting into Veslo's existing app shell and design system.

## Current Problem

The existing Soul page is centered on setup audit, heartbeat proof, and prompt-driven steering. The desired product direction is different: Soul should be a governed, editable, versioned memory layer, with Heartbeat acting as a maintenance mechanism rather than the primary UI concept.

## Design Principles

- Memory first, Heartbeat second.
- Den-backed version history is the durable source of truth for User and Organization Soul.
- Workspace Soul behaves like Skills: viewable and manageable without making the workspace active.
- Runtime materialization is automatic and should not be exposed as a primary user concern.
- Organization governance is enforced on the server, not only hidden in the UI.
- Every user-facing label must be localized.

## Page Structure

The Soul page has three fixed sections in this order:

1. Organization Soul
2. User Soul
3. Workspace Souls

This is intentionally not a pure inventory-first layout. The Organization and User documents are prominent because they are global context layers. Workspace Souls appear as a table below them.

The Pencil proposal frames are:

- `Soul Management Proposal CZ`
- `Soul Memory Editor Detail Proposal CZ`

The left navigation shown in the Pencil frame is only a contextual placeholder. The implementation should reuse the existing Veslo application shell and styles.

## Organization Soul

Organization Soul is company-wide memory:

- company tone and guardrails
- policies and compliance reminders
- cross-workspace process knowledge
- brand or operating principles
- organization-wide preferences for agent behavior

Visibility:

- readable by organization members
- editable only by Organization admins

Behavior:

- edits create new versions
- historical versions are read-only
- restore creates a new current version from an older version
- Organization Heartbeat may create suggestions, but cannot directly change Organization Soul
- Organization admins can accept, edit, or dismiss suggestions

## User Soul

User Soul is the user's work profile, not a transcript memory dump.

Examples:

- role: CFO, production director, owner, project manager
- areas of interest: cash flow, production throughput, reporting, risks, deadlines
- output preferences: brief, tabular, impact-focused, Czech
- decision context: how the user prioritizes work and evaluates tradeoffs

Visibility:

- readable and editable by the owning user

Behavior:

- edits create new versions
- can be updated through UI and API
- no Heartbeat automation in the MVP

## Workspace Souls

Workspace Souls are shown in a single table across all available workspaces.

The workspace does not need to be active or open in the engine. This mirrors the Skills behavior where inventory can be inspected and managed across workspace locations.

Suggested table columns:

- Workspace
- Version
- Updated
- Status
- Updated by
- Actions

User-facing statuses:

- `Active · HB on`
- `Active · HB off`
- `Conflict`
- `Not configured`

Avoid a primary `Runtime sync` or `Materialization` column. Runtime materialization is internal and should be automatic. If detailed materialization diagnostics are needed, expose them in a tooltip, secondary details panel, or debug/admin-only surface.

## Effective Soul Composition

When a workspace runtime needs context, Veslo composes the effective Soul in this order:

1. Organization Soul
2. User Soul
3. Workspace Soul

Organization guidance provides broad guardrails. User Soul adds personal role and preference context. Workspace Soul adds project-specific memory.

The composed result is materialized automatically into the local workspace runtime so agents can consume it. Users should not need to run a manual sync for normal operation.

## Den Sync And Local Cache

Den stores the canonical version history for User Soul and Organization Soul.

Local Veslo stores:

- cached current versions
- cached historical versions needed for UI
- pending offline edits when applicable
- local materialization state for workspace runtime

Every edit uses an optimistic base version. If Den receives an update against a stale base version, it returns a conflict. The UI should show the current server version and the local draft so the user can merge, discard, or save a new version after review.

Workspace Soul should also use the same versioning model. Its cloud sync depends on the workspace ownership model, but the UI and API should treat it consistently with Organization and User Soul.

## Versioning

Soul documents are immutable-versioned records.

Every version stores:

- version id
- scope: organization, user, or workspace
- owner id
- content
- change summary
- created at
- created by
- source: manual, API, heartbeat, restore, system
- base version id
- optional restore source version id

Current version is a pointer to the latest accepted version. Restoring an older version creates a new version rather than deleting history.

## API Requirements

Soul must be controllable through API, especially User Soul and Organization Soul.

Minimum API behaviors:

- read current Organization Soul
- update Organization Soul only for Organization admins
- read Organization Soul versions
- read a specific Organization Soul version
- restore an Organization Soul version only for Organization admins
- read current User Soul
- update User Soul for the owning user
- read User Soul versions
- read a specific User Soul version
- restore a User Soul version for the owning user

Workspace Soul should follow the same conventions once the workspace ownership and permission model is defined.

Authorization must be enforced by the server and Den-backed routes. UI-only hiding is not sufficient.

## Heartbeat Rules

Heartbeat is a background maintenance mechanism, not the main page concept.

### Workspace Heartbeat

If a Workspace Soul exists, Workspace Heartbeat turns on automatically.

Behavior:

- can create new Workspace Soul versions automatically
- each automatic change creates a version with source `heartbeat`
- Heartbeat can be disabled per workspace
- disabling Heartbeat stops automatic changes but keeps history
- version history shows whether a version was manual, API-created, restored, or Heartbeat-created

Because versions are historical, users can roll back by restoring a previous version.

### Organization Heartbeat

Organization Heartbeat creates suggestions only.

Behavior:

- runs automatically or on a configured cadence
- detects organization-wide patterns and possible memory improvements
- creates review suggestions for Organization admins
- never edits Organization Soul directly
- admin approval creates a new Organization Soul version

### User Soul

User Soul has no Heartbeat automation in the MVP.

## Editor Detail

Editing a Soul document opens a detail view or drawer with:

- scope breadcrumb
- document title
- role/permission badge
- base version badge
- Markdown editor
- Preview mode
- change summary field
- save as new version action
- cancel/discard action
- version history panel
- Heartbeat suggestions panel for Organization and Workspace scopes
- permissions panel

Saving never overwrites the current version in place. It creates a new version.

For Organization Soul, non-admin users can open a read-only detail and version history but cannot save.

## Localization

All new UI must use the existing localization system.

Required localized areas:

- section titles: Organization Soul, User Soul, Workspace Souls
- field labels and helper copy
- table headers
- statuses: Active, Heartbeat on, Heartbeat off, Conflict, Not configured
- editor actions: Open editor, Save new version, Cancel, Compare, Preview, Discard draft
- version history labels
- source labels: manual, API, heartbeat, restore, system
- permission explanations
- Heartbeat suggestion labels and actions
- empty states
- loading states
- error states
- conflict-resolution copy
- sync/offline/pending messages
- toasts and confirmation dialogs

At minimum update English and Czech. Chinese locale should receive a safe fallback or translated strings consistent with current repository localization practice.

## Error And Edge States

The UI must handle:

- no organization selected
- user not signed in
- user lacks Organization admin permissions
- Organization Soul missing
- User Soul missing
- workspace has no Workspace Soul
- Heartbeat disabled
- Heartbeat pending suggestions
- Den offline
- local pending draft
- update conflict
- failed version restore
- failed API update

## Automatic Behavior

The user should not need to manage runtime synchronization.

Automatic behavior:

- create a Den version after save
- cache the latest version locally
- recompute effective Soul for affected workspaces
- materialize effective Soul on workspace open, session start, reload, or background sync
- retry failed sync in the background
- surface only actionable failures

## Non-Goals

- No visible setup audit UI from the old page.
- No heartbeat proof feed as the primary page.
- No manual runtime sync button as a normal workflow.
- No automatic Organization Soul edits by Heartbeat.
- No User Soul Heartbeat automation in the MVP.

## Visual Direction

The central content should be quiet, dense, and operational. It should use existing Veslo app styles, not the placeholder navigation shell from the Pencil mock.

The Organization section is the primary region. User Soul is secondary. Workspace Souls use a table because it must scale across many workspaces and support management without activating a workspace.
