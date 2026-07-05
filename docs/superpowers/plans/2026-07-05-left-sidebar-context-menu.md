# Left Sidebar Context Menu Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Execution note for this run:** the user requested implementation via **codex CLI subagents** (repo skill `codex-orchestrator`). Tasks are grouped into waves; tasks inside one wave own **disjoint file sets** and may run in parallel. Waves are strictly sequential. The orchestrator runs final verification itself (Wave 4).

**Spec:** `docs/superpowers/specs/2026-07-05-left-sidebar-context-menu-design.md`

**Goal:** One shared context-menu primitive + declarative per-target menu model for every part of the left sidebar, replacing three hand-rolled menus and adding right-click support to session rows, chat rows, project headers, recent rows, and the empty list area.

**Architecture:** A tiny shared types module (created up front by the orchestrator) is imported by both a rendering primitive (`SidebarContextMenu`) and a pure menu-model module (`build*MenuItems`). `WorkspaceSessionList` keeps one `MenuState` signal; row/background `contextmenu` handlers only set it. All actions delegate to existing prop callbacks; one new optional prop (`onRenameSession`) is wired in `pages/session.tsx` to the existing rename modal.

**Tech Stack:** SolidJS, Tailwind classes per DLS, `node --test` unit tests (`packages/app/src/app/tests/**`), tauri-pilot TOML scenario for E2E (`packages/e2e`).

**Key behavioral rules (from spec):**
- No "Open" item on any row menu — opening stays the left-click action.
- "Remove workspace" only in the project-header menu.
- Unavailable actions render `disabled`, not hidden.
- If text is selected inside the target on right-click, prepend "Copy" (`common.copy`) + separator; always `preventDefault()` so the global copy handler (`components/desktop-context-menu.tsx`) never double-fires.
- `anchorEl` (from "⋯" buttons) takes precedence over `x`/`y`.

---

## Task 0 (orchestrator, before dispatch): shared types module

**Files:**
- Create: `packages/app/src/app/components/session/sidebar-context-menu-types.ts`

Exact content:

```ts
export type SidebarMenuItem = {
  kind: "item";
  id: string;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  onSelect: () => void;
};

export type SidebarMenuSeparator = { kind: "separator" };

export type SidebarMenuLabel = { kind: "label"; label: string };

export type SidebarMenuEntry = SidebarMenuItem | SidebarMenuSeparator | SidebarMenuLabel;

export type SidebarMenuPlacement =
  | { x: number; y: number; anchorEl?: undefined }
  | { anchorEl: HTMLElement; x?: number; y?: number };
```

- [ ] Write file, `git add` + commit: `feat(app): add sidebar context menu shared types`

---

## Wave 1 — three parallel tasks, disjoint files

### Task 1: `SidebarContextMenu` rendering primitive

**Files (exclusive ownership):**
- Create: `packages/app/src/app/components/session/sidebar-context-menu.tsx`

**Requirements:**
- Props: `{ open: boolean; placement: SidebarMenuPlacement | null; entries: SidebarMenuEntry[]; onClose: () => void; testId?: string }` (import types from `./sidebar-context-menu-types`).
- Render `null` when `!open || !placement`. Otherwise render a fixed full-viewport backdrop layer (`class="fixed inset-0 z-[100]"`) that closes on click and on `contextmenu` (`preventDefault` + close), plus the panel:
  - Panel classes (match existing menu styling in `workspace-session-list.tsx`): `fixed z-[101] w-48 max-h-[calc(100vh-24px)] overflow-y-auto rounded-lg border border-gray-6 bg-gray-1 shadow-2xl shadow-gray-12/10 p-1`, `role="menu"`, `data-testid={props.testId ?? "sidebar-context-menu"}`.
  - Items: `role="menuitem"`, classes `w-full text-left px-2 py-1.5 text-sm rounded-md hover:bg-gray-3` + `text-red-11` when `danger`, `opacity-50 pointer-events-none` visual + `aria-disabled` + no-op when `disabled`. On select: call `entry.onSelect()` then `props.onClose()`.
  - Separator: `<div class="my-1 border-t border-gray-6/70" role="separator" />`. Label: `px-2 py-1 text-[11px] uppercase tracking-wide text-gray-9`.
- Positioning: measure panel via `getBoundingClientRect` after mount (`queueMicrotask`, store size in a signal — same pattern as `workspaceMenuStyle`/`workspaceMenuSize` in `workspace-session-list.tsx`, around lines 1760-1790). If `placement.anchorEl` is set it wins: place below the anchor rect, right-aligned (`left = rect.right - menuWidth`, `top = rect.bottom + 4`). Otherwise use `x`/`y`. Clamp both axes to viewport with 12px padding.
- Close behaviors: `Escape` keydown, outside click (backdrop), window `resize`, window `blur`, any `scroll` event with `capture: true` on `window` (so sidebar scrolling closes it). Register listeners only while open; clean up with `onCleanup`.
- Keyboard: ArrowDown/ArrowUp move focus among non-disabled items (wrap around), Home/End jump, Enter/Space activate the focused item. Focus the first item when opened via keyboard is NOT required; focus moves on first arrow press.
- No unit test file (behavior is covered by E2E; repo rule prefers E2E — `AGENTS.md`).

**Steps:**
- [ ] Implement component per above.
- [ ] Run: `pnpm --filter @neatech/veslo-ui typecheck` (or `pnpm typecheck` at repo root) — expect PASS.
- [ ] Commit: `feat(app): add shared sidebar context menu primitive`

### Task 2: i18n keys

**Files (exclusive ownership):**
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/cs.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`

**Steps:**
- [ ] Add to all three locales (keep alphabetical placement within the `sidebar.` block):
  - `"sidebar.show_in_project"`: en `"Show in project"`, cs `"Zobrazit v projektu"`, zh `"在项目中显示"`
  - `"sidebar.project_group"`: en `"Project"`, cs `"Projekt"`, zh `"项目"`
- [ ] Run: `pnpm --filter @neatech/veslo-ui test:i18n` — expect PASS (parity check).
- [ ] Commit: `feat(app): add sidebar context menu i18n keys`

### Task 3: menu model (pure) + unit tests — TDD

**Files (exclusive ownership):**
- Create: `packages/app/src/app/tests/components/session/sidebar-context-menu-model.test.ts`
- Create: `packages/app/src/app/components/session/sidebar-context-menu-model.ts`

**Model contract** (import types from `./sidebar-context-menu-types`; import `t`/locale the way `packages/app/src/app/components/sidebar-status-controls.model.ts` does — `const tr = (key: string) => t(key, currentLocale())`):

```ts
export type SessionMenuContext = {
  workspaceType: "local" | "remote";
  archived: boolean;
  connectionBusy: boolean;      // connecting or pending workspace switch
  selectedText: string;         // "" when nothing selected
  allowRemoteActions: boolean;  // props.showRemoteActions !== false
  canRecover: boolean;
  onCopyText: (text: string) => void;
  onRename: () => void;
  onArchiveToggle: () => void;
  onDelete?: () => void;        // omit => no Delete item
  onShare: () => void;
  onSoul: () => void;
  onReveal: () => void;         // local only
  onRecover: () => void;
  onTestConnection: () => void;
  onEditConnection: () => void;
};

export function buildSessionRowMenuItems(ctx: SessionMenuContext): SidebarMenuEntry[];
export function buildChatRowMenuItems(ctx: Pick<SessionMenuContext, "archived" | "selectedText" | "onCopyText" | "onRename" | "onArchiveToggle" | "onDelete">): SidebarMenuEntry[];
export function buildRecentRowMenuItems(ctx: Pick<SessionMenuContext, "archived" | "selectedText" | "onCopyText" | "onRename" | "onArchiveToggle" | "onDelete"> & { onShowInProject: () => void }): SidebarMenuEntry[];

export type ProjectHeaderMenuContext = {
  workspaceType: "local" | "remote";
  connectionBusy: boolean;
  allowRemoteActions: boolean;
  canRecover: boolean;
  newSessionDisabled: boolean;
  onNewSession: () => void;
  onRename: () => void;
  onShare: () => void;
  onSoul: () => void;
  onReveal: () => void;
  onRecover: () => void;
  onTestConnection: () => void;
  onEditConnection: () => void;
  onRemoveWorkspace: () => void;
};
export function buildProjectHeaderMenuItems(ctx: ProjectHeaderMenuContext): SidebarMenuEntry[];

export type BackgroundMenuContext = {
  addDirectoryDisabled: boolean;
  onAddDirectory: () => void;          // same callback as toolbar button (onAddDirectorySession)
  onSearchSessions?: () => void;
  onArchivedItems?: () => void;
};
export function buildBackgroundMenuItems(ctx: BackgroundMenuContext): SidebarMenuEntry[];
```

**Item order (exact, from spec):**
- Session row: [Copy + separator if `selectedText`] · Rename (`sidebar.edit_name`) · Archive/Unarchive (`sidebar.archive_session` / `sidebar.unarchive_session`) · separator · label `sidebar.project_group` · Share (`sidebar.share`) · Soul (`sidebar.soul_settings`, always this label — there is no per-workspace Soul status in the list component and no `sidebar.enable_soul` key exists) · Reveal (local only; `sidebar.reveal_in_finder` / `sidebar.reveal_in_explorer` by platform — reuse the `isWindowsPlatform()` pattern from `workspace-session-list.tsx:468`) · remote+allowed: Recover (`sidebar.recover`, only if `canRecover`), Test connection (`sidebar.test_connection`), Edit connection (`sidebar.edit_connection`) · separator · Delete (`session.delete_session_action`, danger, only when `onDelete` provided).
- Chat row: [Copy] · Rename · Archive/Unarchive · Delete (danger).
- Recent row: [Copy] · Rename · Archive/Unarchive · Show in project (`sidebar.show_in_project`) · separator · Delete (danger). No project group.
- Project header: New session (`sidebar.create_session_in_project`, disabled by `newSessionDisabled`) · Rename (`sidebar.edit_name`) · Share · Soul · Reveal (local) · remote actions as above · separator · Remove workspace (`sidebar.remove_workspace`, danger).
- Background: Add directory/project (`sidebar.add_directory_or_project`, disabled by flag) · Search (`session.command_palette_search_sessions`, only if callback given) · Archived items (`sidebar.archived_items`, only if callback given).
- `connectionBusy` ⇒ remote connection actions and Recover get `disabled: true` (present, not hidden).

**Test cases** (node --test, `assert` from `node:assert/strict`; run with `pnpm --filter @neatech/veslo-ui test:unit` — note the script glob runs all tests; that is fine):
- local session row: contains Rename/Archive/project-group Share+Soul+Reveal, no Recover/Test/Edit connection, no Remove workspace, Delete last and `danger`.
- remote session row with `canRecover` + `connectionBusy`: Recover/Test/Edit present with `disabled: true`; no Reveal.
- archived session row: Archive item label switches to `sidebar.unarchive_session`.
- `selectedText: "abc"`: first entry is Copy item, second is separator; selecting it calls `onCopyText("abc")`.
- session row without `onDelete`: no Delete item.
- recent row: has Show in project, has no `label` entries (no project group).
- project header: last item is Remove workspace with `danger: true`; first is New session; `newSessionDisabled` propagates.
- background: only provided callbacks yield items (omit `onSearchSessions` ⇒ 2 items).

**Steps:**
- [ ] Write the failing tests first.
- [ ] Run: `pnpm --filter @neatech/veslo-ui test:unit` — expect new tests FAIL (module missing).
- [ ] Implement `sidebar-context-menu-model.ts` minimally to pass.
- [ ] Run: `pnpm --filter @neatech/veslo-ui test:unit` — expect PASS.
- [ ] Commit: `feat(app): add declarative sidebar context menu model`

---

## Wave 2 — single task (hot files, no parallelism)

### Task 4: integrate into `WorkspaceSessionList` + wire rename in session page

**Files (exclusive ownership):**
- Modify: `packages/app/src/app/components/session/workspace-session-list.tsx`
- Modify: `packages/app/src/app/pages/session.tsx`

**workspace-session-list.tsx:**
- [ ] Add prop `onRenameSession?: (workspaceId: string, sessionId: string) => void` to `Props` (`workspace-session-list.tsx:97`).
- [ ] Replace `WorkspaceMenuTarget` state + the `workspaceMenu()` render function (search for `workspaceMenuContext`, currently around lines 1745-1920) with a single `MenuState` signal:

```ts
type MenuState = {
  targetKind: "session" | "chat" | "project" | "recent" | "background";
  workspaceId?: string;
  sessionId?: string;
  placement: SidebarMenuPlacement;
  selectedText: string;
} | null;
```

  `selectedText` is captured at open time via `window.getSelection()?.toString() ?? ""` (only when the selection's anchor node is inside the event's currentTarget; otherwise ""). `onCopyText` uses `navigator.clipboard.writeText` with the `execCommand` fallback — copy the two small helpers from `components/desktop-context-menu.tsx:47-75` or import them if trivially exportable (do NOT change `desktop-context-menu.tsx`; it is not owned by this task — if not exportable, duplicate the ~20 lines locally).
- [ ] Compute `entries` with a `createMemo` switching on `targetKind`, calling the Task 3 builders with data already available in the component (workspace type, archive state via `isSessionArchived`, busy/connecting state via the existing `isConnectionActionBusyFor`/pending-switch logic, `props.showRemoteActions`, `canRecoverWorkspace`). The Soul item has no state dependency — it always calls `props.onOpenSoul` with the `sidebar.soul_settings` label. Wire actions to existing props: `onOpenRenameWorkspace`, `onShareWorkspace`, `onOpenSoul`, `onRevealWorkspace`, `onRecoverWorkspace`, `onTestWorkspaceConnection`, `onEditWorkspaceConnection`, `onForgetWorkspace`, `onArchiveSession`/`onUnarchiveSession` (direct, no pending-confirm state — the menu itself is the explicit gesture), `onDeleteSession`, `onRenameSession`, `onAddDirectorySession`, `onOpenSessionSearch`, `onOpenArchivedSessions`, and the project "+" callback used by `sidebar.create_session_in_project`.
- [ ] Render one `<SidebarContextMenu testId="sidebar-context-menu" …/>` instance at component root; delete the old menu markup, `workspaceMenuStyle`, `workspaceMenuSize`, and the Escape-handling `createEffect` once unused.
- [ ] `contextmenu` handlers (each does `preventDefault();`, `stopPropagation();`, sets `MenuState`):
  - session tree rows: replace `handleSessionRowContextMenu` (`workspace-session-list.tsx:1144`) — `targetKind: "session"`.
  - chat rows (the render path using `sessionChatLabel`): `targetKind: "chat"`.
  - recent view rows: `targetKind: "recent"`.
  - project header block: `targetKind: "project"`; the existing "⋯" button (`handleWorkspaceMenuButtonClick`, `workspace-session-list.tsx:1160`) opens the same project menu with `placement: { anchorEl: button }`.
  - list background: `onContextMenu` on the scroll container; only when `event.target === event.currentTarget` or the hit element has no `[data-session-sidebar-row], [data-project-key], button` ancestor — `targetKind: "background"`.
- [ ] Top-bar "more actions" flyout (search for `moreActionsMenuOpen`): **leave it as-is.** Its view-mode entries are `menuitemradio` with `aria-checked` semantics that the primitive intentionally does not model. The spec's primary targets are the right-click menus; converting the flyout is out of scope for this task.
- [ ] "Show in project" (recent rows): `setSidebarMode("by-project")`, clear the project's collapsed state, then `queueMicrotask` + `document.querySelector('[data-project-key="…"]')?.scrollIntoView({ block: "center" })`.
- [ ] Keep `data-testid="session-workspace-context-menu"` working for any existing E2E by passing `testId="session-workspace-context-menu"`? **No** — grep `packages/e2e` for `session-workspace-context-menu` first; if referenced, keep that testId for the project menu instance and use `sidebar-context-menu` for the rest; if unreferenced, use the new testId everywhere.

**pages/session.tsx:**
- [ ] Generalize the rename modal to support a sidebar target: add `const [renameTargetSessionId, setRenameTargetSessionId] = createSignal<string | null>(null)` next to the existing rename state (`pages/session.tsx:2505-2540`). `openRenameModal` keeps current behavior (target = selected session, `setRenameTargetSessionId(null)`); new `openRenameModalFor(workspaceId, sessionId)` looks up the session title from the sidebar groups, sets `renameTitle`, sets the target id, opens the modal. `submitRename` uses `renameTargetSessionId() ?? props.selectedSessionId`.
- [ ] Pass `onRenameSession: openRenameModalFor` into `workspaceSessionListProps` (where the other sidebar callbacks are assembled for `SessionLeftSidebar` at `pages/session.tsx:3274`).

**Steps:**
- [ ] Implement, then run: `pnpm typecheck` — expect PASS.
- [ ] Run: `pnpm --filter @neatech/veslo-ui test:unit` — expect PASS (existing source-reading tests over `workspace-session-list.tsx` may assert on removed markup — fix any that fail by updating them to the new structure; they live under `packages/app/src/app/tests/**` and are owned by this task for edits).
- [ ] Run: `pnpm --filter @neatech/veslo-ui test:sidebar-flat` — expect PASS.
- [ ] Commit: `feat(app): unify left sidebar context menus on shared primitive`

---

## Wave 3 — two parallel tasks, disjoint files

### Task 5: legacy cleanup

**Files (exclusive ownership):**
- Modify: `packages/app/src/app/types.ts` (add `SidebarSectionState`)
- Delete: `packages/app/src/app/components/session/sidebar.tsx`
- Modify: `packages/app/src/app/pages/session.tsx` (only the import line for `SidebarSectionState`, `pages/session.tsx:124`)
- Modify/It may delete: `packages/app/src/app/tests/components/session/sidebar-connection-message.test.ts`
- Modify: `packages/app/src/app/tests/pages/app-shell-typography.test.ts`

**Steps:**
- [ ] Move the `SidebarSectionState` type from `components/session/sidebar.tsx` into `packages/app/src/app/types.ts`; update the import in `pages/session.tsx`.
- [ ] Delete `components/session/sidebar.tsx` (dead code — no runtime imports besides the type).
- [ ] `sidebar-connection-message.test.ts` reads the deleted file via `readFileSync`: delete the test if it only asserts on the legacy component; if it asserts behavior that now lives in `workspace-session-list.tsx`, retarget the read path.
- [ ] `app-shell-typography.test.ts` reads the file as one of several sources: remove it from the file list.
- [ ] Run: `pnpm typecheck && pnpm --filter @neatech/veslo-ui test:unit` — expect PASS.
- [ ] Commit: `chore(app): remove legacy session sidebar component`

### Task 6: E2E pilot scenario (write only — run happens in Wave 4)

**Files (exclusive ownership):**
- Create: `packages/e2e/pilot-scenarios/sidebar-context-menu.toml`
- Modify: `packages/e2e/package.json` (add `"test:pilot:sidebar-context-menu": "node --import=tsx/esm ./helpers/pilot-runner.ts --scenario sidebar-context-menu"`)

**Scenario outline** (follow the structure of `pilot-scenarios/sidebar-session-retention.toml` — `[scenario]` header, `[[step]]` entries with `wait` / `eval` actions; seed sessions the same way that scenario does):
1. Wait for `#root`; seed at least one workspace with one session (reuse the seeding eval pattern).
2. Dispatch a `contextmenu` MouseEvent on a `[data-session-sidebar-row]` element; wait for `[data-testid="sidebar-context-menu"]`; assert via eval that menu items include the Rename and Archive labels and do NOT include an "Open" item, and that "Remove workspace" is absent.
3. Press Escape (eval `KeyboardEvent`); assert the menu is gone.
4. Right-click the project header row; assert "Remove workspace" is present.
5. Click the Archive item on a session row; assert the row disappears from the list (or gains archived state) — mirror how existing scenarios assert sidebar row counts.
6. Right-click the empty area below the list; assert exactly the three background items (Add directory/project, Search, Archived items).
7. Select text inside a session row via eval (`window.getSelection().selectAllChildren(rowTitleEl)`), dispatch `contextmenu` on that row; assert the first menu item is the Copy label (`common.copy`); click it and assert the menu closed (clipboard content assertion is optional — skip if the webview blocks clipboard reads).

**Steps:**
- [ ] Write scenario + package script. Do NOT run the desktop app in this task.
- [ ] Commit: `test(e2e): add sidebar context menu pilot scenario`

---

## Wave 4 — orchestrator verification (no subagents)

- [ ] `pnpm typecheck` — PASS.
- [ ] `pnpm --filter @neatech/veslo-ui test:unit` — PASS.
- [ ] `pnpm --filter @neatech/veslo-ui test:i18n` — PASS.
- [ ] Desktop preflight per `docs/dev/testing-playbook.md` (single-tenant: detect and terminate internally started Veslo dev/test processes first).
- [ ] Run: `pnpm --filter @neatech/veslo-e2e test:pilot:sidebar-context-menu` (or the equivalent `test:pilot --scenario sidebar-context-menu`) — PASS. If blocked by a running Veslo instance that must not be killed, schedule a 10-minute retry per `AGENTS.md`.
- [ ] `graphify update .` (if CLI available).
- [ ] Update docs: add/refresh the sidebar context menu behavior in `docs/features/` (canonical behavior) — brief section: targets, items, keyboard/close behavior.
- [ ] Final commit of any doc/graph updates.

## File-ownership matrix (collision guard)

| File | Task |
| --- | --- |
| `components/session/sidebar-context-menu-types.ts` | 0 (orchestrator) |
| `components/session/sidebar-context-menu.tsx` | 1 |
| `src/i18n/locales/{en,cs,zh}.ts` | 2 |
| `components/session/sidebar-context-menu-model.ts` + its test | 3 |
| `components/session/workspace-session-list.tsx`, `pages/session.tsx` (body) | 4 |
| `types.ts`, delete `components/session/sidebar.tsx`, `pages/session.tsx` (import line only), two legacy-reading tests | 5 (runs after 4; the `session.tsx` overlap with Task 4 is resolved by wave ordering) |
| `packages/e2e/pilot-scenarios/sidebar-context-menu.toml`, `packages/e2e/package.json` | 6 |
