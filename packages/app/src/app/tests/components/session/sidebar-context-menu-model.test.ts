import assert from "node:assert/strict";
import test from "node:test";

import {
  buildBackgroundMenuItems,
  buildProjectHeaderMenuItems,
  buildRecentRowMenuItems,
  buildSessionRowMenuItems,
  type ProjectHeaderMenuContext,
  type SessionMenuContext,
} from "../../../components/session/sidebar-context-menu-model.js";
import type { SidebarMenuEntry } from "../../../components/session/sidebar-context-menu-types.js";
import { isWindowsPlatform } from "../../../utils/index.js";
import { currentLocale, t } from "../../../../i18n/index.js";

const tr = (key: string) => t(key, currentLocale());
const noop = () => {};

type SidebarMenuItem = Extract<SidebarMenuEntry, { kind: "item" }>;

function sessionContext(overrides: Partial<SessionMenuContext> = {}): SessionMenuContext {
  return {
    workspaceType: "local",
    archived: false,
    connectionBusy: false,
    selectedText: "",
    allowRemoteActions: true,
    canRecover: false,
    onCopyText: noop,
    onRename: noop,
    onArchiveToggle: noop,
    onDelete: noop,
    onShare: noop,
    onSoul: noop,
    onReveal: noop,
    onRecover: noop,
    onTestConnection: noop,
    onEditConnection: noop,
    ...overrides,
  };
}

function projectHeaderContext(overrides: Partial<ProjectHeaderMenuContext> = {}): ProjectHeaderMenuContext {
  return {
    workspaceType: "local",
    connectionBusy: false,
    allowRemoteActions: true,
    canRecover: false,
    newSessionDisabled: false,
    onNewSession: noop,
    onRename: noop,
    onShare: noop,
    onSoul: noop,
    onReveal: noop,
    onRecover: noop,
    onTestConnection: noop,
    onEditConnection: noop,
    onRemoveWorkspace: noop,
    ...overrides,
  };
}

function itemLabels(entries: SidebarMenuEntry[]) {
  return entries.flatMap((entry) => (entry.kind === "item" ? [entry.label] : []));
}

function findItem(entries: SidebarMenuEntry[], label: string): SidebarMenuItem {
  const entry = entries.find((candidate) => candidate.kind === "item" && candidate.label === label);
  assert.ok(entry, `expected item ${label}`);
  assert.equal(entry.kind, "item");
  return entry;
}

function hasItem(entries: SidebarMenuEntry[], label: string) {
  return entries.some((entry) => entry.kind === "item" && entry.label === label);
}

test("local session row contains local project actions and ends with dangerous delete", () => {
  const items = buildSessionRowMenuItems(sessionContext());
  const revealLabel = isWindowsPlatform() ? tr("sidebar.reveal_in_explorer") : tr("sidebar.reveal_in_finder");

  assert.ok(hasItem(items, tr("sidebar.edit_name")));
  assert.ok(hasItem(items, tr("sidebar.archive_session")));
  assert.ok(items.some((entry) => entry.kind === "label" && entry.label === tr("sidebar.project_group")));
  assert.ok(hasItem(items, tr("sidebar.share")));
  assert.ok(hasItem(items, tr("sidebar.soul_settings")));
  assert.ok(hasItem(items, revealLabel));
  assert.equal(hasItem(items, tr("sidebar.recover")), false);
  assert.equal(hasItem(items, tr("sidebar.test_connection")), false);
  assert.equal(hasItem(items, tr("sidebar.edit_connection")), false);
  assert.equal(hasItem(items, tr("sidebar.remove_workspace")), false);

  const last = items.at(-1);
  assert.equal(last?.kind, "item");
  assert.equal(last.label, tr("session.delete_session_action"));
  assert.equal(last.danger, true);
});

test("remote session row disables recover and connection actions while busy", () => {
  const items = buildSessionRowMenuItems(
    sessionContext({
      workspaceType: "remote",
      canRecover: true,
      connectionBusy: true,
    }),
  );
  const revealLabel = isWindowsPlatform() ? tr("sidebar.reveal_in_explorer") : tr("sidebar.reveal_in_finder");

  assert.equal(hasItem(items, revealLabel), false);
  assert.equal(findItem(items, tr("sidebar.recover")).disabled, true);
  assert.equal(findItem(items, tr("sidebar.test_connection")).disabled, true);
  assert.equal(findItem(items, tr("sidebar.edit_connection")).disabled, true);
});

test("archived session row uses the unarchive label", () => {
  const items = buildSessionRowMenuItems(sessionContext({ archived: true }));

  assert.ok(hasItem(items, tr("sidebar.unarchive_session")));
});

test("selected session text prepends copy and passes selected text to the copy callback", () => {
  let copied = "";
  const items = buildSessionRowMenuItems(
    sessionContext({
      selectedText: "abc",
      onCopyText: (text) => {
        copied = text;
      },
    }),
  );

  assert.equal(items[0]?.kind, "item");
  assert.equal(items[0].label, tr("common.copy"));
  assert.equal(items[1]?.kind, "separator");
  items[0].onSelect();
  assert.equal(copied, "abc");
});

test("session row without delete omits delete and does not end with a separator", () => {
  const items = buildSessionRowMenuItems(sessionContext({ onDelete: undefined }));

  assert.equal(hasItem(items, tr("session.delete_session_action")), false);
  assert.notEqual(items.at(-1)?.kind, "separator");
});

test("recent row includes show in project without label entries", () => {
  const items = buildRecentRowMenuItems({
    archived: false,
    selectedText: "",
    onCopyText: noop,
    onRename: noop,
    onArchiveToggle: noop,
    onDelete: noop,
    onShowInProject: noop,
  });

  assert.ok(hasItem(items, tr("sidebar.show_in_project")));
  assert.equal(items.some((entry) => entry.kind === "label"), false);
});

test("project header starts with disabled new session and ends with dangerous remove workspace", () => {
  const items = buildProjectHeaderMenuItems(projectHeaderContext({ newSessionDisabled: true }));

  assert.equal(items[0]?.kind, "item");
  assert.equal(items[0].label, tr("sidebar.create_session_in_project"));
  assert.equal(items[0].disabled, true);

  const last = items.at(-1);
  assert.equal(last?.kind, "item");
  assert.equal(last.label, tr("sidebar.remove_workspace"));
  assert.equal(last.danger, true);
});

test("background menu omits search and keeps add plus archived items", () => {
  const items = buildBackgroundMenuItems({
    addDirectoryDisabled: false,
    onAddDirectory: noop,
    onArchivedItems: noop,
  });

  assert.equal(items.length, 2);
  assert.deepEqual(itemLabels(items), [tr("sidebar.add_directory_or_project"), tr("sidebar.archived_items")]);
});
