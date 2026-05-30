# Extensions and Integrations

This document clarifies the difference between Providers, Skills, Plugins, MCP, and Messaging surfaces.

## Terms

- Providers
  Model or auth providers used by OpenCode-backed model/runtime features.
- Skills
  Reusable prompt/workflow bundles, typically living under `.opencode/skills/`.
- Plugins
  OpenCode plugins configured through `opencode.json` or `opencode.jsonc`.
- MCP
  External capability servers connected through OpenCode config and surfaced as connected apps.
- Messaging
  OpenCode Router-backed Slack and Telegram channel integration for a workspace.

## Providers

Providers are managed from the Settings model section.

Use them when the app needs:

- model provider auth
- provider API keys
- provider-backed model selection

Providers are not the same thing as MCP integrations.

## Skills

Skills are the main reusable workflow abstraction across workers and workspaces.

Current skills surface includes:

- installed skills from the app-wide inventory
- local filters, table mode, and bulk selection for inventory locations
- a detail drawer with locations and version-history placeholders
- hub skills
- local skill import
- reading and saving skill content

Skills are filesystem-backed and usually live under `.opencode/skills/`.

The Skills page is an app-wide inventory, not a current-workspace-only view. It
separates user skills from workspace-specific skills. A user skill is shown once
in the user-skills section, not repeated under each workspace. When a skill has
a user-level copy and workspace-local copies, the workspace-local copies are
shown as workspace overrides.

User skills in this surface are runtime skills discovered from local
OpenCode-compatible user-level skill roots. They are not organization catalog
entries and do not imply Den/admin approval. Promotion to an organization catalog,
system-approved catalog, or bulk organization rollout remains future work.
Starter workspace provisioning does not install creator skills such as
`skill-creator`, `plugin-creator`, or `agent-creator` into workspace-local
skill roots. Those creator skills are expected to be supplied through the
user skill root when available.

Hub skill installs require an explicit target. Today, the supported target is
the active workspace; all-workspaces Hub install is visible as unavailable until
there is a safe global-write backend.

User skills can be installed into a local workspace from the skill detail
drawer. Workspace skills use separate local actions for copying or moving into
user skills, so the drawer should show only actions relevant to the selected
skill location.

Registry-backed distribution is documented separately in
`docs/features/skill-registry-and-distribution.md`. The Skills page may show
registry-oriented copy, move, publish, approval, restore, install, and
deactivate controls only when they are backed by registry routes or clearly
surfaced as pending. Filesystem-only inventory must remain a fallback and must
not be treated as the source of truth for organization-approved or
platform-approved skills.

## Plugins

Plugins are OpenCode-native extensions configured through:

- `<workspace>/opencode.json`
- global OpenCode config for global plugin scope

Use plugins when the capability should be loaded by OpenCode startup/config behavior.

## MCP

MCP is treated as the connected-app surface.

Current MCP behavior includes:

- listing configured MCP servers
- quick connect flows
- remote auth state
- remove/logout actions
- reload banner when config changes require engine reload

MCP config is still OpenCode config, not `.opencode/veslo.json`.

## Messaging

Messaging channels and identities are managed through the `identities.tsx` surface and OpenCode Router-backed APIs.

Important distinction:

- messaging exists in runtime
- product direction intentionally hides most messaging UX from normal end-user navigation
- the codebase still contains the workspace-scoped messaging management surface

## Notion and Other Status Cards

Some integrations surface lightweight persisted status for UI continuity, but the durable source remains the actual runtime config and auth state.

## Source of Truth

- providers: `packages/app/src/app/pages/settings.tsx`
- skills and plugins and MCP wiring: `packages/app/src/app/context/extensions.ts`
- skills UI: `packages/app/src/app/pages/skills.tsx`
- plugins UI: `packages/app/src/app/pages/plugins.tsx`
- MCP UI: `packages/app/src/app/pages/mcp.tsx`
- messaging identities UI: `packages/app/src/app/pages/identities.tsx`
