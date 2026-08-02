import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEngineGenerationAuthority,
  type ProcessInstanceInspector,
} from "../engine-generation-authority.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function authority(inspector: ProcessInstanceInspector) {
  const directory = await mkdtemp(join(tmpdir(), "veslo-engine-generation-"));
  directories.push(directory);
  const dbPath = join(directory, "runs.sqlite");
  const create = () => createEngineGenerationAuthority({
    dbPath,
    orchestratorInstanceId: "orchestrator-a",
    orchestratorStartedAt: 1_000,
    inspector,
    now: () => 2_000,
  });
  return { create, value: create() };
}

const owner = {
  workspaceId: "ws-a",
  engineSlotId: "ws-a",
  engineOwnerId: "generation-a",
  engineStartedAt: 1_500,
  enginePid: 42,
  engineBaseUrl: "http://127.0.0.1:4010",
};

async function activate(value: ReturnType<typeof createEngineGenerationAuthority>) {
  value.registerCreating(owner);
  await value.activate(owner);
}

describe("engine generation authority", () => {
  test("confirms one exact absent process as lost across a fresh authority instance", async () => {
    let observation: "alive" | "absent" = "alive";
    const inspector: ProcessInstanceInspector = {
      inspect: async (pid) => observation === "alive"
        ? { kind: "alive", identity: { pid, birthToken: "birth-a" } }
        : { kind: "absent" },
    };
    const { value, create } = await authority(inspector);
    await activate(value);

    observation = "absent";
    const recovered = await create().resolveOwnerEvidence({
      owner,
      currentPoolEntry: false,
    });

    expect(recovered.kind).toBe("lost_proven");
    expect(create().get(owner.engineOwnerId)).toMatchObject({ state: "exited_confirmed" });
  });

  test("fails closed when the PID belongs to a different process birth", async () => {
    let birthToken = "birth-a";
    const inspector: ProcessInstanceInspector = {
      inspect: async (pid) => ({ kind: "alive", identity: { pid, birthToken } }),
    };
    const { value } = await authority(inspector);
    await activate(value);

    birthToken = "birth-b";
    await expect(value.resolveOwnerEvidence({ owner, currentPoolEntry: false })).resolves.toEqual({
      kind: "unknown",
      reason: "pid_reused",
    });
  });

  test("can prove absence after a persisted stop whose exit callback was interrupted", async () => {
    let observation: "alive" | "absent" = "alive";
    const inspector: ProcessInstanceInspector = {
      inspect: async (pid) => observation === "alive"
        ? { kind: "alive", identity: { pid, birthToken: "birth-a" } }
        : { kind: "absent" },
    };
    const { value } = await authority(inspector);
    await activate(value);
    expect(value.beginStop(owner, "clean_shutdown_requested")?.state).toBe("stopping");

    observation = "absent";
    await expect(value.resolveOwnerEvidence({ owner, currentPoolEntry: false })).resolves.toEqual(
      expect.objectContaining({ kind: "lost_proven" }),
    );
    expect(value.get(owner.engineOwnerId)?.state).toBe("exited_confirmed");
  });

  test("keeps automatic recovery closed when exact process identity was unavailable at activation", async () => {
    const inspector: ProcessInstanceInspector = {
      inspect: async () => ({ kind: "unknown", reason: "unsupported" }),
    };
    const { value } = await authority(inspector);
    await activate(value);

    await expect(value.resolveOwnerEvidence({ owner, currentPoolEntry: false })).resolves.toEqual({
      kind: "unknown",
      reason: "generation_incomplete",
    });
  });


  test("a current pool entry remains a conservative blocker even when the old PID is absent", async () => {
    const inspector: ProcessInstanceInspector = {
      inspect: async () => ({ kind: "absent" }),
    };
    const { value } = await authority(inspector);
    await activate(value);

    await expect(value.resolveOwnerEvidence({ owner, currentPoolEntry: true })).resolves.toEqual({
      kind: "live_or_ambiguous",
      reason: "current_pool_entry",
    });
  });
});
