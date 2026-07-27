import { describe, expect, test } from "bun:test";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  withWorkspaceSkillLease,
  workspaceSkillLeaseKey,
  workspaceSkillLeasePath,
} from "../workspace-skill-lease.js";

const STALE = new Date(0);

const makeWorkspace = (): Promise<string> =>
  mkdtemp(join(tmpdir(), "veslo-workspace-skill-lease-"));

const writeOwnerRecord = async (
  leasePath: string,
  owner: Record<string, unknown>,
): Promise<string> => {
  const ownerFile = join(leasePath, "owner.json");
  await writeFile(ownerFile, `${JSON.stringify(owner)}\n`, "utf8");
  return ownerFile;
};

describe("workspace skill lease", () => {
  test("re-entering the lease for the same workspace does not deadlock", async () => {
    const workspace = await makeWorkspace();
    try {
      const order: string[] = [];
      const result = await withWorkspaceSkillLease(
        workspace,
        "materialize",
        async () => {
          order.push("outer");
          const inner = await withWorkspaceSkillLease(
            workspace,
            "engine-stage",
            async () => {
              order.push("inner");
              return "inner-result";
            },
          );
          order.push("outer-end");
          return inner;
        },
      );

      expect(result).toBe("inner-result");
      expect(order).toEqual(["outer", "inner", "outer-end"]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("re-entry is keyed by resolved path, not by the string passed in", async () => {
    const workspace = await makeWorkspace();
    try {
      const viaRelativeSuffix = join(workspace, "sub", "..");
      expect(workspaceSkillLeaseKey(viaRelativeSuffix)).toBe(
        workspaceSkillLeaseKey(workspace),
      );

      const result = await withWorkspaceSkillLease(
        workspace,
        "materialize",
        async () =>
          withWorkspaceSkillLease(
            viaRelativeSuffix,
            "engine-stage",
            async () => "ok",
          ),
      );
      expect(result).toBe("ok");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("coordinates separately loaded server and orchestrator lease modules", async () => {
    const workspace = await makeWorkspace();
    try {
      // Keep this dynamic: server typecheck deliberately owns only server/src,
      // while Bun resolves the orchestrator's independently compiled copy.
      const { withWorkspaceSkillLease: withOrchestratorWorkspaceSkillLease } =
        await import(
          new URL(
            "../../../orchestrator/src/workspace-skill-lease.js",
            import.meta.url,
          ).href
        );
      const events: string[] = [];
      let releaseServer: (() => void) | undefined;
      let serverStartedResolve: (() => void) | undefined;
      const serverStarted = new Promise<void>((resolveStarted) => {
        serverStartedResolve = resolveStarted;
      });
      const serverGate = new Promise<void>((resolveServer) => {
        releaseServer = resolveServer;
      });

      const serverMutation = withWorkspaceSkillLease(
        workspace,
        "registry-skill-materialization",
        async () => {
          events.push("server:start");
          serverStartedResolve?.();
          await serverGate;
          events.push("server:end");
        },
      );
      await serverStarted;

      const orchestratorStage = withOrchestratorWorkspaceSkillLease(
        workspace,
        "engine-stage",
        async () => {
          events.push("orchestrator:start");
        },
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
      expect(events).toEqual(["server:start"]);

      releaseServer?.();
      await serverMutation;
      await orchestratorStage;
      expect(events).toEqual([
        "server:start",
        "server:end",
        "orchestrator:start",
      ]);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("reclaims a lease whose owner pid is alive but whose heartbeat stopped", async () => {
    const workspace = await makeWorkspace();
    try {
      const leasePath = workspaceSkillLeasePath(workspace);
      await mkdir(leasePath, { recursive: true });
      // A live pid the lease does not actually belong to — what pid reuse looks
      // like from a waiter's point of view. Only the dead heartbeat gives it away.
      const ownerFile = await writeOwnerRecord(leasePath, {
        schemaVersion: 1,
        token: "stale-token",
        processId: process.pid,
        processInstanceId: "some-other-process-instance",
        processStartedAt: 0,
        operation: "engine-stage",
        acquiredAt: new Date(0).toISOString(),
      });
      await utimes(ownerFile, STALE, STALE);

      await expect(
        withWorkspaceSkillLease(workspace, "materialize", async () => "taken"),
      ).resolves.toBe("taken");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("does not steal a lease whose heartbeat is current", async () => {
    const workspace = await makeWorkspace();
    try {
      const leasePath = workspaceSkillLeasePath(workspace);
      await mkdir(leasePath, { recursive: true });
      await writeOwnerRecord(leasePath, {
        schemaVersion: 1,
        token: "live-token",
        processId: process.pid,
        processInstanceId: "another-live-process",
        processStartedAt: Date.now(),
        operation: "engine-stage",
        acquiredAt: new Date().toISOString(),
      });

      let taken = false;
      const attempt = withWorkspaceSkillLease(
        workspace,
        "materialize",
        async () => {
          taken = true;
          return "taken";
        },
      );
      const settled = await Promise.race([
        attempt.then(() => "settled"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("waiting"), 300),
        ),
      ]);

      expect(settled).toBe("waiting");
      expect(taken).toBe(false);

      // Release it so the pending waiter finishes instead of leaking.
      await rm(leasePath, { recursive: true, force: true });
      await expect(attempt).resolves.toBe("taken");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("a recovery fence left behind by a crashed recovery does not wedge the workspace", async () => {
    const workspace = await makeWorkspace();
    try {
      const leasePath = workspaceSkillLeasePath(workspace);
      const fencePath = join(leasePath, ".recovery");
      await mkdir(fencePath, { recursive: true });
      // Age the fence first, then the lease: creating a child bumps the parent.
      await utimes(fencePath, STALE, STALE);
      await utimes(leasePath, STALE, STALE);

      await expect(
        withWorkspaceSkillLease(
          workspace,
          "runtime-skill-view",
          async () => "published",
        ),
      ).resolves.toBe("published");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("releases the lease when the guarded task throws", async () => {
    const workspace = await makeWorkspace();
    try {
      const leasePath = workspaceSkillLeasePath(workspace);
      await expect(
        withWorkspaceSkillLease(workspace, "materialize", async () => {
          throw new Error("task failed");
        }),
      ).rejects.toThrow("task failed");

      await expect(stat(leasePath)).rejects.toThrow();
      await expect(
        withWorkspaceSkillLease(workspace, "engine-stage", async () => "next"),
      ).resolves.toBe("next");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  test("server and orchestrator copies stay byte-identical", async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const serverCopy = join(here, "..", "workspace-skill-lease.ts");
    const orchestratorCopy = join(
      here,
      "..",
      "..",
      "..",
      "orchestrator",
      "src",
      "workspace-skill-lease.ts",
    );

    expect(await readFile(orchestratorCopy, "utf8")).toBe(
      await readFile(serverCopy, "utf8"),
    );
  });
});
