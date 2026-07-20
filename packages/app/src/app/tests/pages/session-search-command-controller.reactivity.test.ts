import assert from "node:assert/strict";
import test from "node:test";

import { createComputed, createRoot, createSignal } from "solid-js";

import {
  createSessionSearchCommandController,
  type CommandPaletteLabels,
} from "../../pages/session-search-command-controller.js";

const labels: CommandPaletteLabels = {
  createSessionTitle: "Start chat",
  createSessionDetail: "Start a fresh chat",
  createSessionMeta: "Create",
  searchSessionsTitle: "Search sessions",
  searchSessionsDetail: (count) => `${count} available`,
  searchSessionsMeta: "Jump",
  currentWorkspaceMeta: "Current worker",
  switchWorkspaceMeta: "Switch",
  untitledSession: "Untitled",
  quickActionsTitle: "Quick actions",
  actionsPlaceholder: "Search actions",
  sessionsPlaceholder: "Find sessions",
  noSearchMatches: "No matches",
};

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function solidRuntimeSupportsEffects(): boolean {
  let observed = 0;
  createRoot((dispose) => {
    const [value, setValue] = createSignal(0);
    createComputed(() => { observed = value(); });
    setValue(1);
    dispose();
  });
  return observed === 1;
}

const behaviorTestOptions = solidRuntimeSupportsEffects()
  ? {}
  : { skip: "Solid's Node server condition does not run effects; use the test:reactivity script." };

test("command palette focus effect runs once per open transition and stops after disposal", behaviorTestOptions, async () => {
  await createRoot(async (dispose) => {
    const [developerMode, setDeveloperMode] = createSignal(false);
    let focusCount = 0;
    const controller = createSessionSearchCommandController({
      messages: () => [],
      workspaceSessionGroups: () => [],
      activeWorkspaceId: () => "workspace-a",
      developerMode,
      labels,
      workspaceLabel: () => "Workspace",
      perfNow: () => 0,
      recordPerfLog: () => {},
      focusSearchInput: () => {},
      focusCommandPaletteInput: () => { focusCount += 1; },
      createSessionAndOpen: () => {},
      openSessionFromList: () => {},
      setToastMessage: () => {},
    });

    try {
      await flushEffects();
      assert.equal(focusCount, 0);

      controller.openCommandPalette();
      await flushEffects();
      assert.equal(focusCount, 1);

      controller.setCommandPaletteQuery("session");
      setDeveloperMode(true);
      await flushEffects();
      assert.equal(focusCount, 1, "query and unrelated controller inputs must not refocus");

      controller.closeCommandPalette();
      controller.openCommandPalette();
      await flushEffects();
      assert.equal(focusCount, 2);
    } finally {
      dispose();
    }

    controller.closeCommandPalette();
    controller.openCommandPalette();
    await flushEffects();
    assert.equal(focusCount, 2, "disposed controller must not run focus effects");
  });
});
