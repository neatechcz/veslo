import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  createConversationRunDeliverySnapshotStore,
  RunDeliverySnapshotIdentityConflictError,
  RUN_DELIVERY_SNAPSHOT_MAX_TERMINAL_PER_WORKSPACE,
  RUN_DELIVERY_SNAPSHOT_MAX_ACTIVE_PER_WORKSPACE,
  RUN_DELIVERY_SNAPSHOT_TTL_MS,
} from "../conversation-run-delivery-snapshot-store.js";
import { projectConversationPromptIdentities } from "../conversation-prompt-identity-projection.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function tempDataDir() {
  const directory = await mkdtemp(join(tmpdir(), "veslo-run-delivery-snapshot-"));
  tempDirs.push(directory);
  return directory;
}

const identity = (runId = "run_1") => ({
  workspaceId: "ws_1",
  conversationId: "conv_1",
  runId,
});

const engineGeneration = (overrides: Partial<{
  engineOwnerId: string;
  enginePid: number;
  engineStartedAt: number;
  engineBaseUrl: string;
}> = {}) => ({
  engineOwnerId: "generation_a",
  enginePid: 101,
  engineStartedAt: 1_000,
  engineBaseUrl: "http://127.0.0.1:50101",
  ...overrides,
});

describe("conversation run delivery snapshot store", () => {
  test("replays an exact prompt identity idempotently and rejects conflicting reuse", async () => {
    let now = 1_000;
    const store = createConversationRunDeliverySnapshotStore({ dataDir: await tempDataDir(), now: () => now });

    const first = store.create({
      ...identity(),
      clientMessageId: "msg_1",
      opencodeMessageId: "opencode_msg_1",
      traceId: "trace_12345678",
      opencodeSessionId: "ses_1",
    });
    now += 1_000;
    const second = store.create({
      ...identity(),
      clientMessageId: "msg_1",
      opencodeMessageId: "opencode_msg_1",
      traceId: "different-diagnostics-must-not-replace",
    });

    expect(first.clientMessageId).toBe("msg_1");
    expect(first.opencodeMessageId).toBe("opencode_msg_1");
    expect(second).toEqual(first);
    expect(store.get(identity())?.router.sessionBoundEventCount).toBe(0);
    expect(() => store.create({
      ...identity(),
      clientMessageId: "different-client",
      opencodeMessageId: "opencode_msg_1",
    })).toThrow(RunDeliverySnapshotIdentityConflictError);
    expect(() => store.create({
      ...identity(),
      clientMessageId: "msg_1",
      opencodeMessageId: "different-opencode-message",
    })).toThrow(RunDeliverySnapshotIdentityConflictError);
  });

  test("joins only the exact session-bearing router observation and preserves its local observation time", async () => {
    const store = createConversationRunDeliverySnapshotStore({ dataDir: await tempDataDir(), now: () => 5_000 });
    store.create({ ...identity(), opencodeSessionId: "ses_1" });

    const observed = store.observeRouter({
      ...identity(),
      opencodeSessionId: "ses_1",
      ...engineGeneration(),
      directoryInstanceEpoch: 3,
      observedAt: "2026-07-30T10:00:00.000Z",
    });
    const mismatched = store.observeRouter({
      ...identity(),
      opencodeSessionId: "ses_other",
      ...engineGeneration(),
      observedAt: "2026-07-30T10:00:01.000Z",
    });

    expect(observed?.router).toEqual({
      sessionBoundEventCount: 1,
      firstObservedAt: "2026-07-30T10:00:00.000Z",
      lastObservedAt: "2026-07-30T10:00:00.000Z",
    });
    expect(observed?.engineOwnerId).toBe("generation_a");
    expect(observed?.engineGenerationId).toMatch(/^[a-f0-9]{64}$/);
    expect(observed?.directoryInstanceEpoch).toBe(3);
    expect(JSON.stringify(observed)).not.toContain("http://127.0.0.1:50101");
    expect(mismatched?.recording).toBe("incomplete");
    expect(mismatched?.router.sessionBoundEventCount).toBe(1);
  });

  test("lists only complete unexpired prompt identity pairs in the exact scope", async () => {
    let now = 5_000;
    const store = createConversationRunDeliverySnapshotStore({ dataDir: await tempDataDir(), now: () => now });
    store.create({
      ...identity("complete"),
      clientMessageId: "client-complete",
      opencodeMessageId: "opencode-complete",
    });
    store.markIncomplete(identity("complete"));
    store.create({
      ...identity("missing-opencode"),
      clientMessageId: "client-missing",
    });
    store.create({
      workspaceId: "ws_1",
      conversationId: "conv_other",
      runId: "cross-conversation",
      clientMessageId: "client-cross",
      opencodeMessageId: "opencode-cross",
    });

    const identities = store.listPromptIdentities({ workspaceId: "ws_1", conversationId: "conv_1" });
    expect(identities).toEqual([{
      opencodeMessageId: "opencode-complete",
      clientMessageId: "client-complete",
    }]);
    const projected = projectConversationPromptIdentities([
      { info: { id: "opencode-complete", role: "user" } },
      { info: { id: "opencode-cross", role: "user" } },
    ], identities) as Array<{ info: Record<string, unknown> }>;
    expect(projected[0]?.info.clientMessageId).toBe("client-complete");
    expect(projected[1]?.info).not.toHaveProperty("clientMessageId");

    now += RUN_DELIVERY_SNAPSHOT_TTL_MS + 1;
    expect(store.listPromptIdentities({ workspaceId: "ws_1", conversationId: "conv_1" })).toEqual([]);
  });

  test("marks an old run incomplete without accepting a replacement engine generation", async () => {
    const store = createConversationRunDeliverySnapshotStore({ dataDir: await tempDataDir(), now: () => 5_000 });
    store.create({ ...identity(), opencodeSessionId: "ses_1" });
    store.observeRouter({ ...identity(), opencodeSessionId: "ses_1", ...engineGeneration() });

    const stale = store.observeRouter({
      ...identity(),
      opencodeSessionId: "ses_1",
      ...engineGeneration({ enginePid: 202, engineStartedAt: 2_000, engineBaseUrl: "http://127.0.0.1:50202" }),
    });

    expect(stale?.recording).toBe("incomplete");
    expect(stale?.router.sessionBoundEventCount).toBe(1);
  });

  test("stores one app aggregate with allowlisted rejection reasons and no event ordering claim", async () => {
    const store = createConversationRunDeliverySnapshotStore({ dataDir: await tempDataDir(), now: () => 7_000 });
    store.create({ ...identity(), opencodeSessionId: "ses_1" });

    const snapshot = store.reportApp({
      ...identity(),
      acceptedEventCount: 4,
      rejectedByReason: {
        unknown_session: 2,
        arbitrary_untrusted_reason: 99,
      } as never,
      storeCommitCount: 3,
      firstObservedAt: "2026-07-30T10:00:02.000Z",
      lastObservedAt: "2026-07-30T10:00:04.000Z",
      reportedAt: "2026-07-30T10:00:08.000Z",
    });

    expect(snapshot?.app).toEqual({
      acceptedEventCount: 4,
      rejectedEventCount: 2,
      rejectedByReason: { unknown_session: 2 },
      storeCommitCount: 3,
      firstObservedAt: "2026-07-30T10:00:02.000Z",
      lastObservedAt: "2026-07-30T10:00:04.000Z",
      reportedAt: "2026-07-30T10:00:08.000Z",
    });
  });

  test("retains only bounded recent terminal snapshots and expires stale diagnostics", async () => {
    let now = 10_000;
    const store = createConversationRunDeliverySnapshotStore({ dataDir: await tempDataDir(), now: () => now });
    for (let index = 0; index <= RUN_DELIVERY_SNAPSHOT_MAX_TERMINAL_PER_WORKSPACE; index += 1) {
      const runId = `run_${index}`;
      store.create({ ...identity(runId), opencodeSessionId: `ses_${index}` });
      store.reportTerminal({
        ...identity(runId),
        lifecycle: "completed",
        canonicalRecovery: "recovered",
        hydration: "adopted",
        presentation: "visible_output",
      });
      now += 1;
    }

    expect(store.get(identity("run_0"))).toBeNull();
    expect(store.get(identity(`run_${RUN_DELIVERY_SNAPSHOT_MAX_TERMINAL_PER_WORKSPACE}`))).not.toBeNull();

    now += RUN_DELIVERY_SNAPSHOT_TTL_MS + 1;
    store.create({ ...identity("fresh"), opencodeSessionId: "ses_fresh" });
    expect(store.get(identity("run_1"))).toBeNull();
    expect(store.get(identity("fresh"))).not.toBeNull();
  });

  test("expires a stale diagnostic when it is read without a later write", async () => {
    let now = 10_000;
    const store = createConversationRunDeliverySnapshotStore({ dataDir: await tempDataDir(), now: () => now });
    store.create({ ...identity(), opencodeSessionId: "ses_1" });

    now += RUN_DELIVERY_SNAPSHOT_TTL_MS + 1;

    expect(store.get(identity())).toBeNull();
  });

  test("merges app presentation without replacing server lifecycle recovery", async () => {
    const store = createConversationRunDeliverySnapshotStore({ dataDir: await tempDataDir() });
    store.create(identity());
    store.reportTerminal({
      ...identity(),
      lifecycle: "completed",
      canonicalRecovery: "recovered",
      hydration: "not_attempted",
      presentation: "unknown",
    });
    const snapshot = store.reportTerminal({
      ...identity(),
      hydration: "adopted",
      presentation: "visible_output",
    });

    expect(snapshot?.terminal).toMatchObject({
      lifecycle: "completed",
      canonicalRecovery: "recovered",
      hydration: "adopted",
      presentation: "visible_output",
    });
  });

  test("atomically preserves router, app, and server-owned terminal evidence across successive writers", async () => {
    const store = createConversationRunDeliverySnapshotStore({ dataDir: await tempDataDir() });
    store.create({ ...identity(), opencodeSessionId: "ses_1" });
    store.observeRouter({ ...identity(), opencodeSessionId: "ses_1", ...engineGeneration(), eventCount: 3 });
    store.reportApp({ ...identity(), acceptedEventCount: 2, storeCommitCount: 1 });
    store.reportTerminal({ ...identity(), lifecycle: "completed", canonicalRecovery: "recovered" });
    const snapshot = store.reportTerminal({ ...identity(), hydration: "adopted", presentation: "visible_output" });

    expect(snapshot?.router.sessionBoundEventCount).toBe(3);
    expect(snapshot?.app).toMatchObject({ acceptedEventCount: 2, storeCommitCount: 1 });
    expect(snapshot?.terminal).toMatchObject({
      lifecycle: "completed",
      canonicalRecovery: "recovered",
      hydration: "adopted",
      presentation: "visible_output",
    });
  });

  test("bounds non-terminal diagnostics per workspace", async () => {
    const store = createConversationRunDeliverySnapshotStore({ dataDir: await tempDataDir() });
    for (let index = 0; index <= RUN_DELIVERY_SNAPSHOT_MAX_ACTIVE_PER_WORKSPACE; index += 1) {
      store.create({ ...identity(`active_${index}`), opencodeSessionId: `ses_active_${index}` });
    }

    expect(store.get(identity("active_0"))).toBeNull();
    expect(store.get(identity(`active_${RUN_DELIVERY_SNAPSHOT_MAX_ACTIVE_PER_WORKSPACE}`))).not.toBeNull();
  });
});
