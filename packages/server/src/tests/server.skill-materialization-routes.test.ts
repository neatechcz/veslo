import { describe, expect, test } from "bun:test";
import { matchRoute, type Route } from "../routing.js";
import {
  createWorkspaceMaterializationSerialQueue,
  registerSkillMaterializationRoutes,
} from "../routes/skill-materialization.js";

describe("Skill materialization routes", () => {
  test("serializes materialization writes for one workspace", async () => {
    const queue = createWorkspaceMaterializationSerialQueue();
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStartedResolve: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = queue.run("ws_1", async () => {
      events.push("first:start");
      firstStartedResolve?.();
      await firstGate;
      events.push("first:end");
      return "first";
    });
    await firstStarted;

    const second = queue.run("ws_1", async () => {
      events.push("second:start");
      return "second";
    });
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst?.();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
  });

  test("registers the skill materialization workflow contract", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<typeof registerSkillMaterializationRoutes>[1];

    registerSkillMaterializationRoutes(routes, dependencies);

    const expectedRoutes: Array<[string, string, Route["auth"]]> = [
      ["GET", "/skills/materialization", "client"],
      ["POST", "/skills/materialization/sync-global", "host"],
      ["GET", "/workspace/ws_1/skills/materialization", "client"],
      ["POST", "/workspace/ws_1/skills/user-global-store/sync", "client"],
      ["POST", "/workspace/ws_1/skills/materialization/sync", "host"],
    ];

    expect(routes).toHaveLength(expectedRoutes.length);
    for (const [index, [method, path, auth]] of expectedRoutes.entries()) {
      const route = matchRoute([routes[index]!], method, path);
      expect(route).not.toBeNull();
      expect(route?.auth).toBe(auth);
    }

    expect(matchRoute(routes, "DELETE", "/skills/materialization")).toBeNull();
  });
});
