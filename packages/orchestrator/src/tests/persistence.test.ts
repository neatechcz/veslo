import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  atomicWriteJson,
  createDebouncedPersister,
} from "../persistence.js";

const cleanupDirs: string[] = [];

afterEach(async () => {
  while (cleanupDirs.length > 0) {
    const dir = cleanupDirs.pop()!;
    await rm(dir, { recursive: true, force: true });
  }
});

async function makeTmpDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "veslo-persistence-test-"));
  cleanupDirs.push(dir);
  return dir;
}

describe("atomicWriteJson", () => {
  test("writes complete JSON that round-trips", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "state.json");
    const value = { a: 1, nested: { b: [1, 2, 3] } };
    await atomicWriteJson(path, value);
    const raw = await readFile(path, "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw)).toEqual(value);
  });

  test("creates parent directory if missing", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "deeper", "nested", "state.json");
    await atomicWriteJson(path, { ok: true });
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toEqual({ ok: true });
  });

  test("does not leave .tmp.* artefacts behind on success", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "state.json");
    await atomicWriteJson(path, { x: 1 });
    await atomicWriteJson(path, { x: 2 });
    await atomicWriteJson(path, { x: 3 });
    const entries = await readdir(dir);
    expect(entries.filter((e) => e.includes(".tmp."))).toHaveLength(0);
    expect(entries).toContain("state.json");
  });

  test("overwrite preserves valid prior content if next write fails mid-flight", async () => {
    const dir = await makeTmpDir();
    const path = join(dir, "state.json");
    await atomicWriteJson(path, { v: 1 });
    // BigInt is not JSON-serializable → JSON.stringify throws inside atomicWriteJson
    await expect(
      atomicWriteJson(path, { v: BigInt(2) } as unknown as Record<string, unknown>),
    ).rejects.toThrow();
    const raw = await readFile(path, "utf8");
    expect(JSON.parse(raw)).toEqual({ v: 1 });
  });
});

describe("createDebouncedPersister", () => {
  test("coalesces rapid schedule calls into a single write", async () => {
    let writeCount = 0;
    const seen: number[] = [];
    const persister = createDebouncedPersister<number>({
      ms: 50,
      write: async (_path, state) => {
        writeCount++;
        seen.push(state);
      },
    });
    for (let i = 0; i < 10; i++) persister.schedule("/x", i);
    await persister.flush();
    expect(writeCount).toBe(1);
    expect(seen).toEqual([9]);
  });

  test("last scheduled state wins", async () => {
    const written: string[] = [];
    const persister = createDebouncedPersister<string>({
      ms: 30,
      write: async (_path, state) => {
        written.push(state);
      },
    });
    persister.schedule("/x", "alpha");
    persister.schedule("/x", "beta");
    persister.schedule("/x", "gamma");
    await persister.flush();
    expect(written).toEqual(["gamma"]);
  });

  test("flush executes pending write immediately without waiting for timer", async () => {
    let writeCount = 0;
    const persister = createDebouncedPersister<number>({
      ms: 10_000,
      write: async () => {
        writeCount++;
      },
    });
    persister.schedule("/x", 1);
    const start = Date.now();
    await persister.flush();
    expect(writeCount).toBe(1);
    expect(Date.now() - start).toBeLessThan(500);
  });

  test("schedule after a flushed write triggers another debounced write", async () => {
    let writeCount = 0;
    const persister = createDebouncedPersister<number>({
      ms: 20,
      write: async () => {
        writeCount++;
      },
    });
    persister.schedule("/x", 1);
    await persister.flush();
    expect(writeCount).toBe(1);
    persister.schedule("/x", 2);
    await persister.flush();
    expect(writeCount).toBe(2);
  });

  test("flush awaits an inflight write before returning", async () => {
    let resolveFirst!: () => void;
    let writes = 0;
    const persister = createDebouncedPersister<number>({
      ms: 5,
      write: async () => {
        writes++;
        if (writes === 1) {
          await new Promise<void>((resolve) => {
            resolveFirst = resolve;
          });
        }
      },
    });
    persister.schedule("/x", 1);
    // wait for timer to fire and start the write
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(writes).toBe(1);
    // schedule another while first is still inflight
    persister.schedule("/x", 2);
    const flushPromise = persister.flush();
    // unblock the first write
    resolveFirst();
    await flushPromise;
    // second scheduled state was flushed
    expect(writes).toBeGreaterThanOrEqual(2);
  });

  test("schedule after error retries on next call", async () => {
    let writes = 0;
    const errors: unknown[] = [];
    const persister = createDebouncedPersister<number>({
      ms: 10,
      onError: (err) => errors.push(err),
      write: async () => {
        writes++;
        if (writes === 1) throw new Error("disk full");
      },
    });
    persister.schedule("/x", 1);
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(writes).toBe(1);
    expect(errors).toHaveLength(1);
    persister.schedule("/x", 2);
    await persister.flush();
    expect(writes).toBe(2);
  });

  test("flush without any scheduled writes is a no-op", async () => {
    let writes = 0;
    const persister = createDebouncedPersister<number>({
      write: async () => {
        writes++;
      },
    });
    await persister.flush();
    expect(writes).toBe(0);
  });
});
