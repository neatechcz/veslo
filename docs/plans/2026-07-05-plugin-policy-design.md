# Plugin Policy Design

## Purpose

Veslo needs full plugin management for OpenCode plugins while keeping Plugins separate from Skills and MCP/Napojení. This design introduces a plugin-only policy model with the same governance shape we want to use for future capability convergence, but it does not migrate Skills or MCP behavior in this phase.

English product and code documentation should use **Plugins**. **Pluginy** is the Czech localization label for the same product surface.

## Scope

This phase changes Plugins only.

Skills keep their existing independent inventory, registry, materialization, enablement, removal, and UI behavior. MCP/Napojení keeps its existing connected-app/catalog/runtime behavior. The PluginPolicy structure is the prepared target model for future Skills and MCP convergence, but no Skills or MCP routes, stores, UI contracts, or runtime behavior are migrated here.

Any future Skills or MCP migration must be handled as a separate task with its own compatibility and testing plan.

## Current State

Current plugin support is intentionally thin. Veslo reads and writes OpenCode plugin specs from OpenCode config and exposes add/remove actions around project and global plugin scopes. This is enough for manual plugin configuration, but it does not model ownership, rollout, visibility, enablement, removal policy, organization approval, platform defaults, or materialization state.

The existing global plugin concept should become **User plugin** in product language. Existing project plugin behavior stays available as **Project plugin** behavior.

## Model

Plugins use a plugin-scoped policy model named around plugins, for example `PluginPolicy`, not a generic capability name. The structure is intentionally future-proof, but the plugin-scoped naming prevents accidental Skills or MCP adoption during this phase. A later convergence task can rename or hoist the abstraction when those domains are intentionally migrated.

Plugin policy records define:

- owner level: `platform`, `organization`, `user`, or `project`
- target or materialization level
- visibility: visible or hidden-debug-only
- auto-install policy
- enablement policy
- removal policy: locked, admin-removable, or user-removable
- review and approval state for organization plugins
- materialization state

Policy fields must stay separate. Visibility does not imply enabled state. Enabled state does not imply removability. Auto-install does not imply locked. Locked hidden platform plugins are the strict system case: present, active, hidden, not removable, and not disableable.

## Plugin Levels

The Plugins surface supports all four levels:

- Platform plugin
- Organization plugin
- User plugin
- Project plugin

Organization plugins follow the same distribution and rights semantics as Skills and MCP servers: only organization admins can edit, approve, or roll out organization plugins organization-wide.

## Platform Plugins

Platform plugins can be:

- automatically installed
- visible or hidden-debug-only
- removable or locked depending on policy

Hidden locked platform plugins are automatically present, invisible in normal UI, visible only in debug mode, locked on, never disableable, and never removable. API-level mutations must reject disable and remove requests for these plugins; the UI must not be the only enforcement layer.

`opencode-scheduler` follows this hidden locked platform-plugin policy. It must not appear as a normal suggested plugin or installed plugin row.

`Superpowers` is a standard platform-provided OpenCode plugin. It is automatically installed on app install, visible in Plugins, enabled by default, and user-removable/user-disableable for the user materialization. Removing the user materialization does not delete the platform default; it records a user-level suppression/removal and leaves the plugin available for restore or reinstall.

## Source Of Truth And Data Flow

Plugin policy state is the durable source of truth for policy-managed plugins. OpenCode config and plugin files are runtime materialization output for Veslo-managed plugins, not the durable policy model.

For a workspace or session, Veslo resolves the effective plugin set by combining platform defaults, organization rollout, user plugins, and project plugins. Conflicts are resolved by policy rather than by whichever config file happens to be read first.

Veslo then materializes the effective enabled plugin set into OpenCode-compatible runtime locations. Materialized managed plugins must carry ownership markers or a manifest so future sync can update or remove only files and config entries that Veslo owns.

Disable and remove actions write policy overrides or materialization records. They should not directly delete raw OpenCode config unless the selected entry is unmanaged and the user is explicitly editing that unmanaged entry.

Plugin changes that affect runtime state mark the workspace for reload, matching the existing plugin reload behavior.

## Existing Config And Migration

Existing OpenCode plugin entries are preserved. They appear as unmanaged user or project plugins depending on their source.

Veslo must not delete or rewrite user-owned plugin entries unless it can prove they are Veslo-managed. Managed plugins must be identifiable through markers/manifests before sync can mutate them.

If a user already has Superpowers manually installed, the platform policy should deduplicate or adopt only when safe. If ownership cannot be proven safely, Veslo should show one clear conflict rather than create duplicate runtime entries or silently overwrite the user configuration.

Existing internal runtime plugin provisioning should not become a source of untracked user-visible plugins. Platform-managed plugin behavior should either adopt internal system plugins with explicit ownership markers or leave legacy internal provisioning separate and expose only policy-managed plugins through the Plugins surface. The scheduler requirement should be policy-managed rather than another untracked config entry.

## UI Behavior

The normal Plugins page shows visible Platform, Organization, User, and Project plugins. It does not show hidden locked platform plugins.

Debug mode can show hidden platform plugins as system/locked/effective rows. These rows have no enable, disable, remove, or restore actions unless a future policy explicitly allows such actions.

Superpowers appears as a normal visible platform plugin with enable/disable and remove/restore actions according to user-removable policy.

OpenCode scheduler does not appear as a normal suggested plugin or installed row.

## Documentation Rules

Documentation must state clearly:

- This phase changes Plugins only.
- Skills and MCP/Napojení keep their current independent systems.
- The plugin policy structure is the prepared target structure for future unification.
- The prepared structure is not yet used by Skills or MCP.
- Future Skills or MCP migration is separate work.
- User-visible Plugins are OpenCode plugins, not MCP connections and not external app connections.
- Hidden locked platform plugins exist for runtime/system needs and are visible only in debug mode.

Architecture and API documentation should use **Plugins**. Czech UI documentation may refer to **Pluginy** as the localized label.

## Failure Handling

Visible plugin failures should show normal user-facing status and offer retry, restore, or remove actions when allowed by policy.

Hidden locked platform plugin failures should surface in debug diagnostics, logs, or health/status output, not as normal Plugins UI noise.

Locked hidden plugins must reject disable and remove at the API layer.

If materialization cannot safely distinguish Veslo-managed files from user-owned files, sync must stop and report a conflict instead of overwriting or deleting user content.

## Verification

Verification should cover:

- Hidden locked platform plugin is materialized and active.
- Hidden locked platform plugin is absent from normal Plugins UI.
- Hidden locked platform plugin appears in debug mode with system/locked metadata.
- Hidden locked platform plugin cannot be disabled or removed.
- Superpowers is auto-installed, visible, enabled by default, disableable, and user-removable.
- Removing Superpowers removes or suppresses only the user materialization, not the platform default.
- Existing unmanaged project and user plugin entries are preserved.
- User and project plugins still support manual add/remove where allowed.
- Organization admin rules are enforced for organization plugins.
- Plugin runtime changes trigger reload state.
- Skills and MCP/Napojení behavior remains unchanged.
