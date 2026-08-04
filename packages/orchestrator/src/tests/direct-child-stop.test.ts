import { describe, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { EventEmitter, once } from "node:events";

import {
  stopDirectChild,
  type DirectChildStopSchedule,
} from "../direct-child-stop.js";

class FakeSchedule implements DirectChildStopSchedule {
  private nextId = 1;
  private callbacks = new Map<number, () => void>();

  setTimeout = (callback: () => void): unknown => {
    const id = this.nextId++;
    this.callbacks.set(id, callback);
    return id;
  };

  clearTimeout = (handle: unknown): void => {
    this.callbacks.delete(handle as number);
  };

  runNext(): void {
    const entry = this.callbacks.entries().next().value as [number, () => void] | undefined;
    if (!entry) throw new Error("no scheduled timeout");
    this.callbacks.delete(entry[0]);
    entry[1]();
  }
}

class FakeChild extends EventEmitter {
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly signals: NodeJS.Signals[] = [];
  onKill: (signal: NodeJS.Signals) => boolean = () => true;

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal);
    return this.onKill(signal);
  }

  observeExit(code: number | null = 0, signal: NodeJS.Signals | null = null): void {
    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
  }
}

function child(value: FakeChild): ChildProcess {
  return value as unknown as ChildProcess;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("stopDirectChild", () => {
  test("reports an already-exited child without signalling", async () => {
    const value = new FakeChild();
    value.exitCode = 0;

    await expect(stopDirectChild(child(value))).resolves.toEqual({ outcome: "exit_observed" });
    expect(value.signals).toEqual([]);
  });

  test("reports an exit observed during the SIGTERM phase", async () => {
    const value = new FakeChild();
    const schedule = new FakeSchedule();
    const stopped = stopDirectChild(child(value), 10, schedule);

    value.observeExit();

    await expect(stopped).resolves.toEqual({ outcome: "exit_observed" });
    expect(value.signals).toEqual(["SIGTERM"]);
  });

  test("reports an exit observed during the SIGKILL phase", async () => {
    const value = new FakeChild();
    const schedule = new FakeSchedule();
    value.onKill = (signal) => {
      if (signal === "SIGKILL") value.observeExit(null, "SIGKILL");
      return true;
    };
    const stopped = stopDirectChild(child(value), 10, schedule);

    schedule.runNext();

    await expect(stopped).resolves.toEqual({ outcome: "exit_observed" });
    expect(value.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("reports exit_unconfirmed after both phases time out", async () => {
    const value = new FakeChild();
    const schedule = new FakeSchedule();
    const stopped = stopDirectChild(child(value), 10, schedule);

    schedule.runNext();
    schedule.runNext();

    await expect(stopped).resolves.toEqual({ outcome: "exit_unconfirmed" });
    expect(value.signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("does not treat kill throwing as exit evidence", async () => {
    const value = new FakeChild();
    value.onKill = () => { throw new Error("kill failed"); };

    await expect(stopDirectChild(child(value))).resolves.toEqual({ outcome: "exit_unconfirmed" });
  });

  test("does not treat kill returning false as exit evidence", async () => {
    const value = new FakeChild();
    const schedule = new FakeSchedule();
    value.onKill = () => false;
    const stopped = stopDirectChild(child(value), 10, schedule);

    schedule.runNext();
    schedule.runNext();

    await expect(stopped).resolves.toEqual({ outcome: "exit_unconfirmed" });
  });

  test("attaches the exit listener before signalling", async () => {
    const value = new FakeChild();
    value.onKill = () => {
      expect(value.listenerCount("exit")).toBeGreaterThan(0);
      value.observeExit();
      return true;
    };

    await expect(stopDirectChild(child(value))).resolves.toEqual({ outcome: "exit_observed" });
  });

  test("observes and terminates a genuine long-lived child process", async () => {
    const value = spawn(process.execPath, ["-e", "setInterval(() => {}, 1_000)"], {
      stdio: "ignore",
    });
    await once(value, "spawn");
    const pid = value.pid;
    if (!pid) throw new Error("spawned child did not expose a PID");
    expect(processIsAlive(pid)).toBe(true);

    try {
      await expect(stopDirectChild(value, 5_000)).resolves.toEqual({ outcome: "exit_observed" });
      expect(value.exitCode !== null || value.signalCode !== null).toBe(true);
      expect(processIsAlive(pid)).toBe(false);
    } finally {
      if (processIsAlive(pid)) value.kill("SIGKILL");
    }
  });
});
