import assert from "node:assert/strict";
import test from "node:test";

import { createRoot } from "solid-js";

import { createSystemState } from "../system-state.js";
import type { Session } from "@opencode-ai/sdk/v2/client";

const createSession = (id: string): Session => ({
  id,
  title: `Session ${id}`,
  time: { created: 1, updated: 1 },
} as unknown as Session);

test("system active-run guard includes background workspace busy entries", () => {
  createRoot((dispose) => {
    const systemState = createSystemState({
      client: () => null,
      sessions: () => [],
      sessionStatusById: () => ({}),
      workspaceBusy: () => ({ "workspace-b": { "background-session": { startedAt: 1_000 } } }),
      refreshPlugins: async () => undefined,
      refreshSkills: async () => undefined,
      setProviders: () => undefined,
      setProviderDefaults: () => undefined,
      setProviderConnectedIds: () => undefined,
      setError: () => undefined,
    });

    assert.equal(systemState.anyActiveRuns(), true);

    dispose();
  });

  createRoot((dispose) => {
    const systemState = createSystemState({
      client: () => null,
      sessions: () => [],
      sessionStatusById: () => ({}),
      workspaceBusy: () => ({}),
      refreshPlugins: async () => undefined,
      refreshSkills: async () => undefined,
      setProviders: () => undefined,
      setProviderDefaults: () => undefined,
      setProviderConnectedIds: () => undefined,
      setError: () => undefined,
    });

    assert.equal(systemState.anyActiveRuns(), false);

    dispose();
  });
});

test("system active-run guard treats any non-idle visible status as active", () => {
  createRoot((dispose) => {
    const systemState = createSystemState({
      client: () => null,
      sessions: () => [createSession("session_a")],
      sessionStatusById: () => ({ session_a: "queued" }),
      workspaceBusy: () => ({}),
      refreshPlugins: async () => undefined,
      refreshSkills: async () => undefined,
      setProviders: () => undefined,
      setProviderDefaults: () => undefined,
      setProviderConnectedIds: () => undefined,
      setError: () => undefined,
    });

    assert.equal(systemState.anyActiveRuns(), true);

    dispose();
  });

  createRoot((dispose) => {
    const systemState = createSystemState({
      client: () => null,
      sessions: () => [createSession("session_a")],
      sessionStatusById: () => ({ session_a: "idle" }),
      workspaceBusy: () => ({}),
      refreshPlugins: async () => undefined,
      refreshSkills: async () => undefined,
      setProviders: () => undefined,
      setProviderDefaults: () => undefined,
      setProviderConnectedIds: () => undefined,
      setError: () => undefined,
    });

    assert.equal(systemState.anyActiveRuns(), false);

    dispose();
  });
});
