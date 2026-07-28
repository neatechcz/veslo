import { describe, expect, test } from "bun:test";

import { createWorkspaceOperationQueue } from "../workspace-operation-queue.js";

describe("workspace operation queue", () => {
  test("serializes one workspace while allowing another to proceed", async () => {
    const enqueue = createWorkspaceOperationQueue();
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = enqueue("workspace-a", async () => {
      order.push("a:first:start");
      await firstGate;
      order.push("a:first:end");
    });
    const second = enqueue("workspace-a", async () => {
      order.push("a:second");
    });
    const other = enqueue("workspace-b", async () => {
      order.push("b");
    });

    await other;
    expect(order).toEqual(["a:first:start", "b"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["a:first:start", "b", "a:first:end", "a:second"]);
  });
});
