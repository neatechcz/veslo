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

test("system reload state emits safe diagnostics without trigger names or paths", () => {
  createRoot((dispose) => {
    const traces: Array<{ event: string; payload: Record<string, unknown> }> = [];
    const systemState = createSystemState({
      client: () => null,
      sessions: () => [],
      sessionStatusById: () => ({}),
      refreshPlugins: async () => undefined,
      refreshSkills: async () => undefined,
      setProviders: () => undefined,
      setProviderDefaults: () => undefined,
      setProviderConnectedIds: () => undefined,
      setError: () => undefined,
      recordReloadTrace: (event, payload) => traces.push({ event, payload }),
    });

    systemState.markReloadRequired("config", {
      type: "config",
      name: "opencode.json",
      path: "C:/private/opencode.json",
      action: "updated",
    });
    systemState.clearReloadRequired();

    assert.deepEqual(traces, [
      {
        event: "reload-state:marked",
        payload: {
          reason: "config",
          alreadyRequired: false,
          previousReasons: [],
          reasons: ["config"],
          triggerType: "config",
          triggerAction: "updated",
        },
      },
      {
        event: "reload-state:cleared",
        payload: {
          wasRequired: true,
          previousReasons: ["config"],
          triggerType: "config",
          triggerAction: "updated",
        },
      },
    ]);
    dispose();
  });
});
