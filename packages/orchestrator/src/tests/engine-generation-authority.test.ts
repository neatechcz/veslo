import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createEngineGenerationAuthority,
  linuxProcReadFailure,
  linuxProcStartTimeTicks,
  macosProcBsdInfoBirthToken,
  type ProcessInstanceInspector,
} from "../engine-generation-authority.js";
import { createRunStore } from "../run-store.js";

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
  return { create, value: create(), dbPath };
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
  test("parses the Linux process-start field after a spaced process name", () => {
    const fields: string[] = Array.from({ length: 20 }, (_, index) => index === 0 ? "S" : "0");
    fields[19] = "987654";

    expect(linuxProcStartTimeTicks(`42 (OpenCode Worker) ${fields.join(" ")}`)).toBe("987654");
    expect(linuxProcStartTimeTicks("malformed")).toBeNull();
  });

  test("keeps Linux owner recovery closed when boot_id is unavailable", () => {
    expect(linuxProcReadFailure("boot_id", { code: "ENOENT" })).toEqual({
      kind: "unknown",
      reason: "inspection_failed",
    });
    expect(linuxProcReadFailure("stat", { code: "ENOENT" })).toEqual({ kind: "absent" });
  });

  test("parses the XNU 136-byte macOS proc_bsdinfo layout only for the requested PID", () => {
    // XNU: pbi_pid=12, pbi_start_tvsec=120, pbi_start_tvusec=128, sizeof=136.
    // Deliberately do not use implementation constants here.
    const buffer = new Uint8Array(136);
    const view = new DataView(buffer.buffer);
    view.setUint32(12, 42, true);
    view.setBigUint64(120, 123n, true);
    view.setBigUint64(128, 456n, true);

    expect(macosProcBsdInfoBirthToken(42, buffer)).toBe("darwin:123:456");
    expect(macosProcBsdInfoBirthToken(43, buffer)).toBeNull();
    expect(macosProcBsdInfoBirthToken(42, buffer.subarray(0, 135))).toBeNull();
  });

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

  test("durably retires a historical owner without a generation only after its PID is absent", async () => {
    const inspector: ProcessInstanceInspector = {
      inspect: async () => ({ kind: "absent" }),
    };
    const { value, create } = await authority(inspector);

    const recovered = await value.resolveOwnerEvidence({
      owner,
      currentPoolEntry: false,
    });

    expect(recovered).toEqual(expect.objectContaining({ kind: "lost_proven" }));
    expect(create().get(owner.engineOwnerId)).toMatchObject({
      state: "exited_confirmed",
      closureReason: "legacy_process_absent",
      processBirthToken: null,
    });
    await expect(create().resolveOwnerEvidence({ owner, currentPoolEntry: false })).resolves.toEqual(
      expect.objectContaining({ kind: "lost_proven" }),
    );
  });

  test("preserves a historical terminal conversation row while filling its missing generation evidence", async () => {
    const inspector: ProcessInstanceInspector = {
      inspect: async () => ({ kind: "absent" }),
    };
    const { value, dbPath } = await authority(inspector);
    const runStore = createRunStore({ dbPath });
    runStore.insert({
      workspaceId: owner.workspaceId,
      conversationId: "conv-historical-hidden",
      runId: "run-historical-hidden",
      engineSessionId: "ses-historical-hidden",
      clientMessageId: "msg-historical-hidden",
      origin: "session:normal",
      directory: "C:/repo",
      kind: "prompt",
      status: "completed",
      abortRequested: false,
      createdAt: 1_600,
      startedAt: 1_600,
      completedAt: 1_700,
      error: null,
      engineSlotId: owner.engineSlotId,
      engineOwnerState: "attached",
      engineOwnerId: owner.engineOwnerId,
      enginePid: owner.enginePid,
      engineStartedAt: owner.engineStartedAt,
      engineBaseUrl: owner.engineBaseUrl,
      activityKind: "idle",
      waitReason: "none",
      lastUsefulProgressAt: 1_700,
      retrySince: null,
      lastProgressSignature: null,
    });

    expect(runStore.terminalAttachedWithEngineOwner()).toEqual([
      expect.objectContaining({ runId: "run-historical-hidden", engineOwnerId: owner.engineOwnerId }),
    ]);

    const before = new Database(dbPath, { readonly: true });
    try {
      expect(before.query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'engine_generation'").get()).toBeNull();
      expect(before.query("SELECT status, engine_owner_state, engine_owner_id, engine_pid, engine_started_at FROM conversation_run WHERE run_id = 'run-historical-hidden'").get()).toEqual({
        status: "completed",
        engine_owner_state: "attached",
        engine_owner_id: owner.engineOwnerId,
        engine_pid: owner.enginePid,
        engine_started_at: owner.engineStartedAt,
      });
    } finally {
      before.close();
    }

    await expect(value.resolveOwnerEvidence({ owner, currentPoolEntry: false })).resolves.toEqual(
      expect.objectContaining({ kind: "lost_proven" }),
    );
    expect(runStore.get(owner.workspaceId, "run-historical-hidden")).toMatchObject({
      status: "completed",
      engineOwnerState: "attached",
      engineOwnerId: owner.engineOwnerId,
      enginePid: owner.enginePid,
      engineStartedAt: owner.engineStartedAt,
    });
    expect(value.get(owner.engineOwnerId)).toMatchObject({
      state: "exited_confirmed",
      closureReason: "legacy_process_absent",
    });
  });

  test("does not adopt a historical owner without a generation while its PID is still present", async () => {
    const inspector: ProcessInstanceInspector = {
      inspect: async (pid) => ({ kind: "alive", identity: { pid, birthToken: "unknown-legacy-birth" } }),
    };
    const { value } = await authority(inspector);

    await expect(value.resolveOwnerEvidence({ owner, currentPoolEntry: false })).resolves.toEqual({
      kind: "unknown",
      reason: "generation_not_found",
    });
    expect(value.get(owner.engineOwnerId)).toBeNull();
  });

  test("keeps a historical owner without a generation closed when its PID cannot be inspected", async () => {
    const inspector: ProcessInstanceInspector = {
      inspect: async () => ({ kind: "unknown", reason: "inspection_failed" }),
    };
    const { value } = await authority(inspector);

    await expect(value.resolveOwnerEvidence({ owner, currentPoolEntry: false })).resolves.toEqual({
      kind: "unknown",
      reason: "process_identity_unavailable",
    });
    expect(value.get(owner.engineOwnerId)).toBeNull();
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
