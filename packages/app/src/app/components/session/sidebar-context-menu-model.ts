import { currentLocale, t } from "../../../i18n";
import { isWindowsPlatform } from "../../utils";
import type { SidebarMenuEntry } from "./sidebar-context-menu-types";

const tr = (key: string) => t(key, currentLocale());

export type SessionMenuContext = {
  workspaceType: "local" | "remote";
  archived: boolean;
  connectionBusy: boolean;
  selectedText: string;
  allowRemoteActions: boolean;
  canRecover: boolean;
  onCopyText: (text: string) => void;
  onRename: () => void;
  onArchiveToggle: () => void;
  onDelete?: () => void;
  onShare: () => void;
  onSoul: () => void;
  onReveal: () => void;
  onRecover: () => void;
  onTestConnection: () => void;
  onEditConnection: () => void;
};

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

export type BackgroundMenuContext = {
  addDirectoryDisabled: boolean;
  onAddDirectory: () => void;
  onSearchSessions?: () => void;
  onArchivedItems?: () => void;
};

const separator = (): SidebarMenuEntry => ({ kind: "separator" });

const label = (text: string): SidebarMenuEntry => ({ kind: "label", label: text });

const item = (
  id: string,
  text: string,
  onSelect: () => void,
  options: { danger?: boolean; disabled?: boolean } = {},
): SidebarMenuEntry => ({
  kind: "item",
  id,
  label: text,
  onSelect,
  ...options,
});

const archiveLabel = (archived: boolean) => tr(archived ? "sidebar.unarchive_session" : "sidebar.archive_session");

const revealLabel = () => tr(isWindowsPlatform() ? "sidebar.reveal_in_explorer" : "sidebar.reveal_in_finder");

const normalized = (entries: SidebarMenuEntry[]) => {
  const result: SidebarMenuEntry[] = [];
  for (const entry of entries) {
    if (entry.kind === "separator" && (result.length === 0 || result.at(-1)?.kind === "separator")) continue;
    result.push(entry);
  }
  while (result.at(-1)?.kind === "separator") result.pop();
  return result;
};

const copyEntries = (selectedText: string, onCopyText: (text: string) => void): SidebarMenuEntry[] =>
  selectedText === "" ? [] : [item("copy-text", tr("common.copy"), () => onCopyText(selectedText)), separator()];

const remoteActionEntries = (ctx: {
  workspaceType: "local" | "remote";
  allowRemoteActions: boolean;
  canRecover: boolean;
  connectionBusy: boolean;
  onRecover: () => void;
  onTestConnection: () => void;
  onEditConnection: () => void;
}): SidebarMenuEntry[] => {
  if (ctx.workspaceType !== "remote" || !ctx.allowRemoteActions) return [];

  return [
    ...(ctx.canRecover
      ? [item("recover", tr("sidebar.recover"), ctx.onRecover, { disabled: ctx.connectionBusy })]
      : []),
    item("test-connection", tr("sidebar.test_connection"), ctx.onTestConnection, {
      disabled: ctx.connectionBusy,
    }),
    item("edit-connection", tr("sidebar.edit_connection"), ctx.onEditConnection, {
      disabled: ctx.connectionBusy,
    }),
  ];
};

export function buildSessionRowMenuItems(ctx: SessionMenuContext): SidebarMenuEntry[] {
  return normalized([
    ...copyEntries(ctx.selectedText, ctx.onCopyText),
    item("rename", tr("sidebar.edit_name"), ctx.onRename),
    item("archive-toggle", archiveLabel(ctx.archived), ctx.onArchiveToggle),
    separator(),
    label(tr("sidebar.project_group")),
    item("share", tr("sidebar.share"), ctx.onShare),
    item("soul", tr("sidebar.soul_settings"), ctx.onSoul),
    ...(ctx.workspaceType === "local" ? [item("reveal", revealLabel(), ctx.onReveal)] : []),
    ...remoteActionEntries(ctx),
    ...(ctx.onDelete ? [separator(), item("delete", tr("session.delete_session_action"), ctx.onDelete, { danger: true })] : []),
  ]);
}

export function buildChatRowMenuItems(
  ctx: Pick<
    SessionMenuContext,
    "archived" | "selectedText" | "onCopyText" | "onRename" | "onArchiveToggle" | "onDelete"
  >,
): SidebarMenuEntry[] {
  return normalized([
    ...copyEntries(ctx.selectedText, ctx.onCopyText),
    item("rename", tr("sidebar.edit_name"), ctx.onRename),
    item("archive-toggle", archiveLabel(ctx.archived), ctx.onArchiveToggle),
    ...(ctx.onDelete ? [item("delete", tr("session.delete_session_action"), ctx.onDelete, { danger: true })] : []),
  ]);
}

export function buildRecentRowMenuItems(
  ctx: Pick<
    SessionMenuContext,
    "archived" | "selectedText" | "onCopyText" | "onRename" | "onArchiveToggle" | "onDelete"
  > & { onShowInProject: () => void },
): SidebarMenuEntry[] {
  return normalized([
    ...copyEntries(ctx.selectedText, ctx.onCopyText),
    item("rename", tr("sidebar.edit_name"), ctx.onRename),
    item("archive-toggle", archiveLabel(ctx.archived), ctx.onArchiveToggle),
    item("show-in-project", tr("sidebar.show_in_project"), ctx.onShowInProject),
    ...(ctx.onDelete ? [separator(), item("delete", tr("session.delete_session_action"), ctx.onDelete, { danger: true })] : []),
  ]);
}

export function buildProjectHeaderMenuItems(ctx: ProjectHeaderMenuContext): SidebarMenuEntry[] {
  return normalized([
    item("new-session", tr("sidebar.create_session_in_project"), ctx.onNewSession, {
      disabled: ctx.newSessionDisabled,
    }),
    item("rename", tr("sidebar.edit_name"), ctx.onRename),
    item("share", tr("sidebar.share"), ctx.onShare),
    item("soul", tr("sidebar.soul_settings"), ctx.onSoul),
    ...(ctx.workspaceType === "local" ? [item("reveal", revealLabel(), ctx.onReveal)] : []),
    ...remoteActionEntries(ctx),
    separator(),
    item("remove-workspace", tr("sidebar.remove_workspace"), ctx.onRemoveWorkspace, { danger: true }),
  ]);
}

export function buildBackgroundMenuItems(ctx: BackgroundMenuContext): SidebarMenuEntry[] {
  return normalized([
    item("add-directory", tr("sidebar.add_directory_or_project"), ctx.onAddDirectory, {
      disabled: ctx.addDirectoryDisabled,
    }),
    ...(ctx.onSearchSessions
      ? [item("search-sessions", tr("session.command_palette_search_sessions"), ctx.onSearchSessions)]
      : []),
    ...(ctx.onArchivedItems ? [item("archived-items", tr("sidebar.archived_items"), ctx.onArchivedItems)] : []),
  ]);
}
