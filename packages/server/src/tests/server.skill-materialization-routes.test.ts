import { describe, expect, test } from "bun:test";
import { access, mkdir, mkdtemp, rm, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { matchRoute, type Route } from "../routing.js";
import { registerSkillMaterializationRoutes } from "../routes/skill-materialization.js";
import {
  withWorkspaceSkillLease,
  workspaceSkillLeasePath,
} from "../workspace-skill-lease.js";

describe("Skill materialization routes", () => {
  test("serializes materialization writes and runtime staging for one workspace", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "veslo-workspace-skill-lease-"),
    );
    const events: string[] = [];
    let releaseFirst: (() => void) | undefined;
    let firstStartedResolve: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      firstStartedResolve = resolve;
    });
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withWorkspaceSkillLease(
      workspace,
      "materialize",
      async () => {
        events.push("first:start");
        firstStartedResolve?.();
        await firstGate;
        events.push("first:end");
        return "first";
      },
    );
    await firstStarted;

    const second = withWorkspaceSkillLease(
      workspace,
      "engine-stage",
      async () => {
        events.push("second:start");
        return "second";
      },
    );
    await Promise.resolve();
    expect(events).toEqual(["first:start"]);

    releaseFirst?.();
    await expect(first).resolves.toBe("first");
    await expect(second).resolves.toBe("second");
    expect(events).toEqual(["first:start", "first:end", "second:start"]);
    expect(workspaceSkillLeasePath(workspace)).toBe(
      join(workspace, ".opencode", ".veslo", "workspace-skill-lease"),
    );
    await rm(workspace, { recursive: true, force: true });
  });

  test("recovers an abandoned workspace lease without an owner record", async () => {
    const workspace = await mkdtemp(
      join(tmpdir(), "veslo-workspace-skill-lease-"),
    );
    try {
      const leasePath = workspaceSkillLeasePath(workspace);
      await mkdir(leasePath, { recursive: true });
      await utimes(leasePath, new Date(0), new Date(0));

      await expect(
        withWorkspaceSkillLease(
          workspace,
          "runtime-skill-view",
          async () => "published",
        ),
      ).resolves.toBe("published");
      await expect(access(leasePath)).rejects.toThrow();
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("registers the skill materialization workflow contract", () => {
    const routes: Route[] = [];
    const dependencies = {} as Parameters<
      typeof registerSkillMaterializationRoutes
    >[1];

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
