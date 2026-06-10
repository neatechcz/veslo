import assert from "node:assert/strict";
import test from "node:test";

import { shouldAutoReloadManagedAiConfig } from "../../lib/managed-ai-config-reload.js";

test("auto-reloads managed AI config when no runs are active and reload is available", () => {
  assert.equal(
    shouldAutoReloadManagedAiConfig({
      hasManagedProfile: true,
      hasConfigChanged: true,
      hasActiveRuns: false,
      canReloadWorkspace: true,
    }),
    true,
  );
});

test("does not auto-reload when the managed config did not change", () => {
  assert.equal(
    shouldAutoReloadManagedAiConfig({
      hasManagedProfile: true,
      hasConfigChanged: false,
      hasActiveRuns: false,
      canReloadWorkspace: true,
    }),
    false,
  );
});

test("does not auto-reload when a run is active", () => {
  assert.equal(
    shouldAutoReloadManagedAiConfig({
      hasManagedProfile: true,
      hasConfigChanged: true,
      hasActiveRuns: true,
      canReloadWorkspace: true,
    }),
    false,
  );
});

test("does not auto-reload when reload is unavailable", () => {
  assert.equal(
    shouldAutoReloadManagedAiConfig({
      hasManagedProfile: true,
      hasConfigChanged: true,
      hasActiveRuns: false,
      canReloadWorkspace: false,
    }),
    false,
  );
});
