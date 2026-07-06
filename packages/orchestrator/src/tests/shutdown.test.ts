import { describe, expect, test } from "bun:test";

import { createOrchestratorShutdown } from "../shutdown.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("orchestrator shutdown", () => {
  test("stops engines without waiting for open server connections to close", async () => {
    const events: string[] = [];
    let closeServer: (() => void) | undefined;

    const shutdown = createOrchestratorShutdown({
      server: {
        close: (callback?: () => void) => {
          events.push("server-close-start");
          closeServer = () => {
            events.push("server-close-done");
            callback?.();
          };
          return undefined;
        },
      },
      clearSharedEngineLivenessTimer: () => events.push("clear-liveness-timer"),
      pool: {
        killAll: async () => {
          events.push("kill-all");
        },
      },
      sharedOpenCodeEngine: {
        dispose: async () => {
          events.push("dispose-shared-engine");
        },
      },
      persistShutdownState: async () => {
        events.push("persist");
      },
      exitProcess: (code) => {
        events.push(`exit:${code}`);
      },
      logger: {
        info: () => events.push("log-start"),
        debug: () => {},
        warn: () => {},
      },
      closeServerTimeoutMs: 100,
      context: { host: "127.0.0.1", port: 8787 },
    });

    const shutdownPromise = shutdown();
    await tick();

    expect(events).toContain("server-close-start");
    expect(events).toContain("kill-all");
    expect(events.indexOf("kill-all")).toBeGreaterThan(
      events.indexOf("server-close-start"),
    );
    expect(events.indexOf("persist")).toBeLessThan(events.indexOf("kill-all"));

    closeServer?.();
    await shutdownPromise;

    expect(events).toEqual([
      "log-start",
      "server-close-start",
      "clear-liveness-timer",
      "persist",
      "kill-all",
      "dispose-shared-engine",
      "server-close-done",
      "persist",
      "exit:0",
    ]);
  });

  test("shares one cleanup path for repeated shutdown requests", async () => {
    const events: string[] = [];
    let finishKillAll: (() => void) | undefined;

    const shutdown = createOrchestratorShutdown({
      server: {
        close: (callback?: () => void) => {
          events.push("server-close-start");
          callback?.();
          return undefined;
        },
      },
      pool: {
        killAll: async () => {
          events.push("kill-all");
          await new Promise<void>((resolve) => {
            finishKillAll = resolve;
          });
        },
      },
      persistShutdownState: async () => {
        events.push("persist");
      },
      exitProcess: (code) => {
        events.push(`exit:${code}`);
      },
      closeServerTimeoutMs: 100,
    });

    const first = shutdown();
    const second = shutdown();

    expect(first).toBe(second);
    await tick();
    expect(events).toEqual(["server-close-start", "persist", "kill-all"]);

    finishKillAll?.();
    await first;

    expect(events).toEqual(["server-close-start", "persist", "kill-all", "persist", "exit:0"]);
  });
});
