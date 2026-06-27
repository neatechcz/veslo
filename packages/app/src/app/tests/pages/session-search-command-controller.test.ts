import assert from "node:assert/strict";
import test from "node:test";
import type { MessageWithParts } from "../../types";
import {
  activeSearchHitForIndex,
  clampActiveSearchHitIndex,
  collectSessionSearchHits,
  formatSearchPositionLabel,
  moveActiveSearchHitIndex,
  resolveCommandPaletteItems,
  resolveSessionSearchCommandShortcut,
} from "../../pages/session-search-command-controller.js";

const message = (id: string, parts: Array<Record<string, unknown>>): MessageWithParts => ({
  info: { id } as MessageWithParts["info"],
  parts: parts as MessageWithParts["parts"],
});

const labels = {
  createSessionTitle: "Start chat",
  createSessionDetail: "Start a fresh chat",
  createSessionMeta: "Create",
  searchSessionsTitle: "Search sessions",
  searchSessionsDetail: (count: number) => `${count} available`,
  searchSessionsMeta: "Jump",
  currentWorkspaceMeta: "Current worker",
  switchWorkspaceMeta: "Switch",
  untitledSession: "Untitled",
  quickActionsTitle: "Quick actions",
  actionsPlaceholder: "Search actions",
  sessionsPlaceholder: "Find sessions",
  noSearchMatches: "No matches",
};

test("search hit derivation can scan all messages when hidden transcript windows are revealed", () => {
  const messages = [
    message("visible-1", [{ type: "text", text: "alpha visible" }]),
    message("hidden-1", [{ type: "text", text: "alpha hidden" }]),
    message("ignored", [{ type: "text", text: "alpha ignored", ignored: true }]),
  ];

  const windowedHits = collectSessionSearchHits({
    messages: messages.slice(0, 1),
    query: "alpha",
  });
  const revealedHits = collectSessionSearchHits({
    messages,
    query: "alpha",
  });

  assert.deepEqual(windowedHits.map((hit) => hit.messageId), ["visible-1"]);
  assert.deepEqual(revealedHits.map((hit) => hit.messageId), ["visible-1", "hidden-1"]);
});

test("active search hit movement wraps and clamps safely when messages change", () => {
  const hits = [{ messageId: "m1" }, { messageId: "m2" }];

  const next = moveActiveSearchHitIndex({ current: 0, total: hits.length, offset: 1 });
  assert.equal(activeSearchHitForIndex(hits, next)?.messageId, "m2");

  const previous = moveActiveSearchHitIndex({ current: next, total: hits.length, offset: -1 });
  assert.equal(activeSearchHitForIndex(hits, previous)?.messageId, "m1");

  const clamped = clampActiveSearchHitIndex({ current: 1, total: 1 });
  assert.equal(activeSearchHitForIndex(hits.slice(0, 1), clamped)?.messageId, "m1");
  assert.equal(formatSearchPositionLabel({ hits: hits.slice(0, 1), activeIndex: clamped, noMatchesLabel: "No matches" }), "1/1");
});

test("command palette items expose disabled states from workspace, runtime, and session state", () => {
  const items = resolveCommandPaletteItems({
    mode: "root",
    query: "",
    activeWorkspaceId: "workspace-a",
    sessionOptions: [],
    labels,
    state: {
      canCreateSession: false,
      createSessionDisabledReason: "Workspace unavailable",
      runtimeReady: false,
      runtimeDisabledReason: "Runtime offline",
      hasSessionNavigation: false,
      sessionNavigationDisabledReason: "No sessions loaded",
    },
    actions: {
      createSession: () => undefined,
      openSessionsMode: () => undefined,
      openSession: () => undefined,
    },
  });

  assert.deepEqual(
    items.map((item) => [item.id, item.disabled, item.disabledReason]),
    [
      ["new-session", true, "Workspace unavailable"],
      ["sessions", true, "No sessions loaded"],
    ],
  );
});

test("shortcut routing opens and closes controller state without stealing composer input", () => {
  assert.equal(
    resolveSessionSearchCommandShortcut({
      key: "a",
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      commandPaletteOpen: false,
      searchOpen: false,
      commandPaletteMode: "root",
      commandPaletteQuery: "",
      isComposing: false,
      keyCode: 0,
    }),
    "ignore",
  );

  assert.equal(
    resolveSessionSearchCommandShortcut({
      key: "k",
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: true,
      altKey: false,
      shiftKey: false,
      commandPaletteOpen: false,
      searchOpen: false,
      commandPaletteMode: "root",
      commandPaletteQuery: "",
      isComposing: false,
      keyCode: 0,
    }),
    "toggle-command-palette",
  );

  assert.equal(
    resolveSessionSearchCommandShortcut({
      key: "Escape",
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      commandPaletteOpen: true,
      searchOpen: false,
      commandPaletteMode: "root",
      commandPaletteQuery: "",
      isComposing: false,
      keyCode: 0,
    }),
    "close-command-palette",
  );

  assert.equal(
    resolveSessionSearchCommandShortcut({
      key: "Enter",
      defaultPrevented: false,
      metaKey: false,
      ctrlKey: false,
      altKey: false,
      shiftKey: false,
      commandPaletteOpen: true,
      searchOpen: false,
      commandPaletteMode: "root",
      commandPaletteQuery: "",
      isComposing: true,
      keyCode: 229,
    }),
    "ignore",
  );
});
