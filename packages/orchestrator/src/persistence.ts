import { randomBytes } from "node:crypto";
import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const tmpPath = `${path}.tmp.${randomBytes(6).toString("hex")}`;
  try {
    await writeFile(tmpPath, payload, "utf8");
    await rename(tmpPath, path);
  } finally {
    await rm(tmpPath, { force: true });
  }
}

/**
 * Remove stale `.tmp.*` files left behind when the process crashed between
 * `writeFile` and `rename` inside `atomicWriteJson`. Safe to call on startup
 * before the first write; matches files named `<basename>.tmp.<hex>` so we
 * never touch the canonical state file itself.
 */
export async function cleanupStaleTmpFiles(targetPath: string): Promise<number> {
  const dir = dirname(targetPath);
  const prefix = `${basename(targetPath)}.tmp.`;
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!entry.startsWith(prefix)) continue;
    try {
      await rm(`${dir}/${entry}`, { force: true });
      removed += 1;
    } catch {
      // best-effort; ignore per-file errors
    }
  }
  return removed;
}

export type DebouncedPersister<TState> = {
  schedule: (path: string, state: TState) => void;
  flush: () => Promise<void>;
};

export type DebouncedPersisterOptions<TState> = {
  write: (path: string, state: TState) => Promise<void>;
  ms?: number;
  onError?: (error: unknown) => void;
};

const DEFAULT_PERSIST_DEBOUNCE_MS = 500;

export function createDebouncedPersister<TState>(
  options: DebouncedPersisterOptions<TState>,
): DebouncedPersister<TState> {
  const ms = options.ms ?? DEFAULT_PERSIST_DEBOUNCE_MS;
  const onError = options.onError;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending: { path: string; state: TState } | null = null;
  let inflight: Promise<void> | null = null;

  const arm = (): void => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      const next = pending;
      pending = null;
      if (!next) return;
      inflight = options
        .write(next.path, next.state)
        .catch((err) => {
          onError?.(err);
        })
        .finally(() => {
          inflight = null;
          if (pending) arm();
        });
    }, ms);
  };

  return {
    schedule(path, state) {
      pending = { path, state };
      arm();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      if (pending) {
        const next = pending;
        pending = null;
        await options.write(next.path, next.state);
      }
      if (inflight) await inflight;
    },
  };
}
