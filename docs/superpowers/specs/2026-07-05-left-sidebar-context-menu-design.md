# Left Sidebar Context Menu Design

Date: 2026-07-05
Status: Approved by user (approach A — shared primitive + declarative menu model)

## Problem

The left sidebar (`packages/app/src/app/pages/session-left-sidebar.tsx`) is composed of the
update pill, the workspace/session list (`packages/app/src/app/components/session/workspace-session-list.tsx`),
the dashboard nav (`sidebar-dashboard-nav.tsx`), and the bottom status controls
(`sidebar-status-controls.tsx`). Right-click behavior today is inconsistent:

- Right-clicking a session row opens the **workspace** menu (rename/share/Soul/reveal/remote
  actions) instead of session actions. Session actions (archive, delete) exist only as hover
  buttons on the row.
- The workspace menu, the top-bar "more actions" flyout, and a menu in the legacy
  `components/session/sidebar.tsx` are three independent hand-rolled menu implementations
  (positioning, Escape handling, outside-click each duplicated).
- Other sidebar parts (project headers outside the "⋯" button, chat rows, Recent rows, empty
  list area) have no right-click support at all.
- A global Tauri-only copy menu (`components/desktop-context-menu.tsx`) shows "Copy" on
  right-click over selected text and must coexist with any local menu (it respects
  `event.defaultPrevented`).

## Goals

- One consistent context-menu behavior across every part of the left sidebar.
- Right-click on a session offers session actions first; workspace actions are a separate group.
- Replace the duplicated menu implementations with a single primitive.
- No new business logic: menu items delegate to existing callbacks/workflows.

## Non-goals

- Native OS menus (Tauri/Rust layer) — rejected: hard to E2E-test with tauri-pilot, cannot
  follow the DLS theme, desktop-only.
- Context menus for the dashboard nav (Automations/Skills) and the bottom status controls —
  they have their own dedicated controls (YAGNI).
- Changing what the delegated actions do (rename, share, archive, delete, Soul, remote
  connection actions keep their current modals/confirmations/toasts).

## Design

### 1. `SidebarContextMenu` component (new, `packages/app/src/app/components/`)

Single rendering implementation for all sidebar menus:

- Rendered via portal; position clamped to the viewport with padding.
- Opens either at pointer coordinates (right-click) or anchored to an element ("⋯" buttons).
- Closes on Escape, outside click, scroll, window resize, and window blur.
- Keyboard navigation: ArrowUp/ArrowDown moves focus, Enter/Space activates, Home/End jump.
- Accessibility: `role="menu"` / `role="menuitem"`, `aria-disabled` for disabled items.
- Supports separators, group labels, destructive styling (`danger`), and disabled items.

### 2. Declarative menu model (new, pure module next to the component)

```ts
type MenuItem =
  | { kind: "item"; id: string; label: string; icon?: Component; danger?: boolean;
      disabled?: boolean; onSelect: () => void }
  | { kind: "separator" }
  | { kind: "label"; label: string };
```

One pure builder function per target kind:

- `buildSessionRowMenuItems(ctx)` — session row in project view
- `buildChatRowMenuItems(ctx)` — chat row in the chat section
- `buildProjectHeaderMenuItems(ctx)` — project/workspace header
- `buildRecentRowMenuItems(ctx)` — row in the Recent view
- `buildSidebarBackgroundMenuItems(ctx)` — empty area of the list

`ctx` carries plain data and callbacks already available as `WorkspaceSessionList` props:
workspace type (local/remote), archive state, Soul status, connection/busy state, selected
text (if any), and the existing action callbacks. Builders render nothing — they are unit
testable in isolation.

### 3. State and data flow

`WorkspaceSessionList` keeps a single signal:

```ts
type MenuState = {
  targetKind: "session" | "chat" | "project" | "recent" | "background";
  workspaceId?: string;
  sessionId?: string;
  x: number;
  y: number;
  anchorEl?: HTMLElement; // when opened from a "⋯" button
} | null;
```

When `anchorEl` is set it takes precedence over `x`/`y`: the menu is positioned relative to
the anchor rect (below, right-aligned), and `x`/`y` are ignored.

`onContextMenu` handlers on rows/headers/background only `preventDefault()` and set this
signal. Menu items are computed with a memo from the matching builder. Selecting an item
invokes the existing prop callback and closes the menu.

### 4. Menu contents per target

| Target | Items |
| --- | --- |
| Session row | Rename · Archive/Unarchive · — · group "Project": Share, Soul, Reveal in Finder/Explorer, (remote: Recover, Test connection, Edit connection) · — · Delete (danger) |
| Chat row | Rename · Archive/Unarchive · Delete (danger) |
| Project header | New session · Rename · Share · Soul settings/Enable Soul · Reveal (local) · (remote: Recover, Test connection, Edit connection) · — · Remove workspace (danger) |
| Recent row | Rename · Archive/Unarchive · Show in project · — · Delete (danger). No "Project" group — workspace actions are reachable via "Show in project" |
| Empty list area | Add directory/project (delegates to the same `onAddDirectorySession` callback as the toolbar button) · Search sessions · Archived items |

No "Open" item on any row menu — opening is the row's left-click action.

Rules:

- "Remove workspace" appears only in the project-header menu (matches current guard where the
  session-sourced menu hides it).
- Unavailable actions (connection in progress, pending workspace switch) render `disabled`,
  not hidden, so the menu shape is stable.
- When text is selected inside the target at right-click time, "Copy" is prepended with a
  separator; the local menu always calls `preventDefault()` so the global copy handler never
  fires alongside it. Outside the sidebar the global handler is unchanged.

### 5. Migration

- Replace the hand-rolled workspace menu inside `workspace-session-list.tsx` with the new
  primitive; the "⋯" workspace button opens the same project-header menu anchored to the button.
- Convert the top-bar "more actions" flyout (Archived items, Search sessions) to the same
  primitive.
- The legacy `components/session/sidebar.tsx` menu is not migrated: the component is dead code
  (only its `SidebarSectionState` type is imported by `pages/session.tsx`). Move the type and
  delete the file as part of cleanup. Two source-reading tests load the file via
  `readFileSync` and must be updated or removed together with it:
  `packages/app/src/app/tests/components/session/sidebar-connection-message.test.ts` and
  `packages/app/src/app/tests/pages/app-shell-typography.test.ts`.

### 6. Error handling

Menu actions are fire-and-forget delegations to existing workflows (modals own confirmation,
errors surface via existing toasts/messages). The menu closes immediately on selection and
holds no async state.

### 7. Testing

Primary (per repo rules) — E2E with tauri-pilot (`packages/desktop` + `packages/e2e`):

- Right-click a session row → session items shown; Archive actually archives.
- Right-click a project header → workspace items incl. Remove workspace.
- Escape and outside click close the menu.
- Right-click over selected text inside a row → "Copy" item present and copies.

Supporting unit tests (pure model, `pnpm --filter @neatech/veslo-ui test:*`):

- local vs. remote workspace item sets; archived vs. active session; disabled states while
  connecting; "Remove workspace" only for project-header target; Copy item present only with
  selected text.
