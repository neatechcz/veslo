import { describe, expect, test } from "bun:test";
import { createRunDeliverySnapshotNotifier } from "../run-delivery-snapshot-notifier.js";

const observation = {
  workspaceId: "workspace-a",
  conversationId: "conversation-a",
  runId: "run-a",
  opencodeSessionId: "session-a",
  engineOwnerId: "owner-a",
  enginePid: 123,
  engineStartedAt: 456,
  engineBaseUrl: "http://127.0.0.1:1234",
  eventCount: 2,
  firstObservedAt: "2026-07-30T10:00:00.000Z",
  lastObservedAt: "2026-07-30T10:00:01.000Z",
};

describe("run delivery snapshot notifier", () => {
  test("posts one bounded router aggregate with lifecycle authentication", async () => {
    const requests: Request[] = [];
    const notify = createRunDeliverySnapshotNotifier({
      baseUrl: "http://server.local/",
      token: "lifecycle-token",
      fetchImpl: async (input, init) => {
        requests.push(new Request(input, init));
        return new Response(null, { status: 202 });
      },
    });

    expect(await notify(observation)).toBe(true);
    const request = requests[0];
    expect(request?.url).toBe("http://server.local/internal/orchestrator/run-delivery-snapshot/router-observed");
    expect(request?.headers.get("X-Veslo-Orchestrator-Token")).toBe("lifecycle-token");
    expect(await request?.json()).toEqual({ schema: "veslo-run-delivery-snapshot/v1", ...observation });
  });

  test("rejects invalid aggregates without issuing a request", async () => {
    let calls = 0;
    const notify = createRunDeliverySnapshotNotifier({
      baseUrl: "http://server.local",
      token: "lifecycle-token",
      fetchImpl: async () => {
        calls += 1;
        return new Response(null, { status: 202 });
      },
    });

    expect(await notify({ ...observation, eventCount: 0 })).toBe(false);
    expect(calls).toBe(0);
  });

  test("fails closed when the diagnostic endpoint does not answer before its bounded timeout", async () => {
    let aborted = false;
    const notify = createRunDeliverySnapshotNotifier({
      baseUrl: "http://server.local",
      token: "lifecycle-token",
      timeoutMs: 10,
      fetchImpl: async (_input, init) => await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new DOMException("aborted", "AbortError"));
        }, { once: true });
      }),
    });

    expect(await notify(observation)).toBe(false);
    expect(aborted).toBe(true);
  });
});
