# Connections and Integrations

This document clarifies the difference between Providers, Skills, Plugins,
Napojení, MCP, and Messaging surfaces. Pluginy is the Czech localization label
for Plugins; English product, architecture, docs, and code should use Plugins.

## Terms

- Providers
  Model or auth providers used by OpenCode-backed model/runtime features.
- Skills
  Reusable prompt/workflow bundles, typically living under `.opencode/skills/`.
- Plugins
  OpenCode plugins configured through `opencode.json` or `opencode.jsonc` and
  managed from the Plugins dashboard tab. Pluginy is the Czech localization
  label for this same surface.
- Napojení
  The user-facing Connections page for MCP servers and external apps.
- MCP
  External capability servers connected through OpenCode config and surfaced
  inside Napojení as connected apps.
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
- import candidates from other agent skill folders
- reading and saving skill content

Workspace skills are filesystem-backed and usually live under
`.opencode/skills/`. User skills created or promoted through Veslo are stored in
the Veslo user skill store under the server data directory, then materialized
into the active workspace runtime under `.opencode/skills/veslo-user/` so
sandboxed OpenCode runs can see them without mounting host user skill roots.

The Skills page is an app-wide inventory, not a current-workspace-only view. It
separates user skills from workspace-specific skills. A user skill is shown once
in the user-skills section, not repeated under each workspace. When a skill has
a user-level copy and workspace-local copies, the workspace-local copies are
shown as workspace overrides.

Settings can expose Skills as a link tab, but that tab routes to this same
Skills page. It must not duplicate or summarize the inventory inside Settings.

User skills in this surface are runtime skills loaded from the Veslo user skill
store plus legacy local OpenCode-compatible user-level skill roots. They are not
organization catalog entries and do not imply Den/admin approval. Promotion to
an organization catalog, system-approved catalog, or bulk organization rollout
remains future work.
Starter workspace provisioning does not install creator skills such as
`skill-creator`, `plugin-creator`, or `agent-creator` into workspace-local
skill roots. Those creator skills are expected to be supplied through the
user skill root when available. Private app-created workspace provisioning also
removes workspace-local skill directories that are exact copies of a legacy
user-root skill, including during new private chat setup. Veslo-created user
skills should use the store as the source of truth; workspace materializations
under `veslo-user` are runtime copies.

Hub skill installs require an explicit target. Today, the supported target is
the active workspace; all-workspaces Hub install is visible as unavailable until
there is a safe global-write backend.

The import-from-other-agents flow scans known Codex, Claude Code, OpenCode, and
legacy agent skill folders as candidates. These folders are not added as runtime
skill roots. Import copies the selected candidate into Veslo-owned storage:
user-level source folders become Veslo user skills, and workspace-local source
folders become workspace skills in that workspace. The import view lets the user
filter by source agent and choose specific candidates, but the import target is
derived automatically from the source location.

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
Veslo surfaces this as the separate Plugins dashboard tab. The Czech
localization label for that tab is Pluginy.

PluginPolicy is plugin-only in this phase. It is the prepared target structure
for a future convergence of Plugins, Skills, and MCP/Napojení, but Skills and
MCP/Napojení are not migrated by this work. Skills still use their existing
inventory, stores, routes, materialization, and settings. MCP/Napojení still
uses its existing connected-app catalog, runtime status, auth, and OpenCode MCP
config flows.

For policy-managed Plugins, plugin policy and override state are the durable
source of truth. OpenCode config entries and plugin files are runtime
materialization output for Veslo-managed policy plugins. Existing unmanaged
OpenCode plugin entries are preserved and are edited only through the legacy
unmanaged plugin add/remove paths.

Platform plugins can be visible or hidden-debug-only, removable or locked, and
toggleable or locked-on. Hidden locked platform plugins exist for runtime/system
needs; they are visible only in debug surfaces and cannot be disabled or
removed. `opencode-scheduler` is hidden, locked, not disableable/removable, and
must not appear as a normal suggested or installed plugin. `Superpowers` is a
visible platform OpenCode plugin that is enabled by default and remains
user-disableable and user-removable for the user materialization.

## MCP

Napojení is the user-facing connected-app surface. Its underlying runtime model
is MCP: external apps and services are connected through MCP servers and then
shown as connected apps in the dashboard.

Current MCP behavior includes:

- listing configured MCP servers
- catalog browsing with explicit install actions
- quick connect flows for built-in entries through an explicit install button
- remote auth state
- remove/logout actions
- reload banner when config changes require engine reload

Local MCP servers are opt-in. In particular, Control Chrome is not attached to
every workspace automatically; it becomes part of OpenCode prompt/tool startup
only after the user explicitly connects it for that workspace. This keeps an
ordinary first prompt independent of browser-MCP process startup while
preserving browser automation where it was explicitly enabled.

MCP config is still OpenCode config, not `.opencode/veslo.json`.

The dashboard exposes Napojení as the MCP/external-app page. The MCP page
remains the owner of connected-app behavior, while Plugins remains the owner of
OpenCode plugin management.

### Platform Google Workspace MCP Connectors

Veslo provides Google Workspace MCP connectors as three separate platform
entries:

- Google Gmail
- Google Calendar
- Google Drive

They are not one combined Google connector. Each entry is distributed through
Veslo/Den catalog metadata as a platform connector and points local runtimes at
a Veslo-owned connector endpoint.

For normal Veslo usage, Veslo owns and distributes the Google OAuth client
configuration. Users should not create their own Google Cloud project, approve a
Google CLI, or supply Google OAuth client values just to use the platform
Google connectors. A Veslo deployment must still be configured with the
Veslo-owned Google OAuth app values before these connectors are enabled for
public users.

The production token boundary is server-managed: catalog metadata and local
OpenCode config do not contain Google OAuth client secrets or user Google token
material. Den starts Google OAuth, receives the production callback, exchanges
the code using Veslo's Google client secret, and stores encrypted per-user
Google grants server-side.

Keep these states distinct in product behavior and docs:

- catalog-visible: the connector is available from Veslo/Den catalog metadata
- install-requested: the user explicitly clicked the connector's install action
- installed/configured: OpenCode config contains the remote MCP entry
- server-authorized: the user completed Veslo-managed Google OAuth for that entry
- runtime-connected: the live runtime reports the MCP server as usable
- reload-needed: config changed but the runtime has not loaded it yet

Catalog visibility and installed config are not proof that Google OAuth has
completed or that the live runtime is connected.

### Platform Microsoft SharePoint MCP Connector

Veslo provides Microsoft SharePoint as a separate platform MCP connector, not
as a local folder mount or a generic Microsoft account import. The connector is
distributed through Veslo/Den catalog metadata and points local runtimes at a
Veslo-owned Microsoft connector endpoint.

The SharePoint connector is read-only. It requests Microsoft Graph delegated
read scopes for SharePoint and file access, plus OpenID/offline access scopes
needed for Veslo-managed sign-in. It must not request write scopes for the
initial platform connector.

The production token boundary matches the Google platform connector model:
catalog metadata and local OpenCode config do not contain Microsoft OAuth client
secrets, Microsoft access tokens, or Microsoft refresh tokens. Den starts
Microsoft OAuth, receives the callback, exchanges the code using Veslo's
Microsoft client secret, and stores encrypted per-user Microsoft grants
server-side.

The connector exposes read-only MCP tools for search, site/drive browsing, item
metadata, and bounded file-content reads. Runtime-connected still means the
live MCP server can answer those read calls; it is stronger than catalog-visible
or installed/configured.

## Messaging

Messaging channels and identities are managed through the `identities.tsx` surface and OpenCode Router-backed APIs.

Workspace-specific messaging behavior is loaded from
`<workspace>/.opencode/agents/opencode-router.md`. The Identities surface reads
and writes that file, and the OpenCode Router bridge consumes the same path at
runtime.

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
- Plugins UI: `packages/app/src/app/pages/plugins.tsx`
- Napojení shell: `packages/app/src/app/pages/extensions.tsx`
- MCP UI: `packages/app/src/app/pages/mcp.tsx`
- messaging identities UI: `packages/app/src/app/pages/identities.tsx`
