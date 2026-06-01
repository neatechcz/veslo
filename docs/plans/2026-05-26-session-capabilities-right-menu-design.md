# Session Capabilities Right Menu Design

## Goal

Show the Skills and MCP servers available to the currently selected chat in the session right menu. The panel must reflect the workspace directory of the selected chat, not the currently active runtime workspace.

## Decisions

- The selected chat's working directory is the authoritative workspace scope.
- Veslo chats are expected to have a working directory. If the directory is not loaded yet, the panel shows a loading or unavailable state instead of falling back to another workspace.
- The right menu is read-only. Installation, deletion, Hub catalog browsing, and MCP connection management stay in the existing Skills and MCP dashboard surfaces.
- The panel shows installed/configured capabilities only:
  - workspace Skills plus globally inherited Skills
  - workspace MCP plus globally inherited MCP
  - no Hub-only items
  - no chat-artifact-derived "used" capabilities

## Architecture

Add a session-scoped capabilities loader/cache that takes an explicit workspace directory and returns Skills and MCP data for that directory. It should reuse the same canonical data paths that feed the existing Skills and MCP menus rather than adding a separate parser in the session UI.

For Skills, use the same inventory/listing behavior as the Skills surface so global and workspace instances are represented consistently. For MCP, use the same workspace MCP listing behavior as the MCP surface, including project configuration and global OpenCode configuration inheritance.

The session page derives the capabilities scope from the selected chat's directory. The active workspace remains relevant for runtime actions, but it must not determine the right-menu capabilities when a different chat is selected.

## UI

Extend the session right menu below the existing artifacts area with a compact capabilities panel:

- `Skills`: display name, description or trigger, and source badge for workspace/global where available.
- `MCP`: server name, local/remote type, short command or URL detail, and runtime status when status can be resolved for the same directory.

Sections are collapsible and independently show loading, empty, and error states. Errors stay local to the section and do not trigger a global app error banner.

## Data Freshness

Cache entries are keyed by the selected chat workspace directory. Switching chats should show cached data for the matching directory when available and refresh when the shared Skills/MCP data is invalidated by mutation or workspace reload events.

The dashboard Skills/MCP surfaces remain the management source of truth. When those surfaces refresh or mutate capabilities, the session capabilities cache should be invalidated or refreshed through the same shared store boundary.

## Testing

Prefer E2E coverage in the desktop runtime:

- Open or create chats in workspaces with different configured Skills/MCP and verify the right menu follows the selected chat directory.
- Verify global Skills/MCP appear alongside workspace-scoped entries.
- Verify selecting a chat from another workspace does not show capabilities from the currently active runtime workspace.

Add focused model/store tests where useful to cover cache keying and no-active-workspace fallback behavior.
