import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

/**
 * Cross-process lease guarding workspace skill sources.
 *
 * Every Veslo-owned mutation of workspace skill sources and every engine
 * staging operation must hold this lease.  The lock lives in the workspace so
 * separately launched server and orchestrator processes coordinate through the
 * same durable protocol rather than through process-local queues.
 *
 * This file is duplicated verbatim in `packages/server/src` and
 * `packages/orchestrator/src`.  The two copies must stay byte-identical: they
 * are the two ends of the same protocol, and a divergence silently reopens the
 * race they exist to close. `workspace-skill-lease.test.ts` enforces it.
 *
 * Liveness protocol: the holder bumps the owner file's mtime every
 * `LEASE_HEARTBEAT_MS`.  A waiter reclaims the lease when the owning process is
 * gone *or* when the heartbeat has stopped for `LEASE_STALE_MS`.  The heartbeat
 * is what makes recovery safe against PID reuse, which a liveness probe alone
 * cannot detect.
 */
const LEASE_DIRECTORY = [
  ".opencode",
  ".veslo",
  "workspace-skill-lease",
] as const;
const LEASE_OWNER_FILE = "owner.json";
const LEASE_RECOVERY_DIRECTORY = ".recovery";
const LEASE_WAIT_MS = 50;
const LEASE_TIMEOUT_MS = 30_000;
const LEASE_HEARTBEAT_MS = 1_000;
const LEASE_STALE_MS = 15_000;
const ABANDONED_LEASE_GRACE_MS = 5_000;
const RECOVERY_FENCE_STALE_MS = 15_000;
const PROCESS_INSTANCE_ID = randomUUID();
const PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1_000);

type WorkspaceSkillLeaseOwner = {
  schemaVersion: 1;
  token: string;
  processId: number;
  processInstanceId: string;
  processStartedAt: number;
  operation: string;
  acquiredAt: string;
};

const workspaceLeaseQueues = new Map<string, Promise<void>>();

/**
 * Lease keys held by the current async call stack.  Re-entering the lease for a
 * key already held would queue the inner acquisition behind the outer one while
 * the outer one waits for the inner task to finish — a promise cycle that never
 * settles, not even at `LEASE_TIMEOUT_MS`.
 */
const heldLeaseKeys = new AsyncLocalStorage<ReadonlySet<string>>();

const delay = (ms: number): Promise<void> =>
  new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function processIsAlive(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function workspaceSkillLeasePath(workspaceRoot: string): string {
  return join(resolve(workspaceRoot), ...LEASE_DIRECTORY);
}

export function workspaceSkillLeaseKey(workspaceRoot: string): string {
  const normalizedRoot = resolve(workspaceRoot);
  return process.platform === "win32"
    ? normalizedRoot.toLowerCase()
    : normalizedRoot;
}

function leaseOwnerFilePath(leasePath: string): string {
  return join(leasePath, LEASE_OWNER_FILE);
}

async function readLeaseOwner(
  leasePath: string,
): Promise<WorkspaceSkillLeaseOwner | null> {
  try {
    const owner = JSON.parse(
      await readFile(leaseOwnerFilePath(leasePath), "utf8"),
    ) as WorkspaceSkillLeaseOwner;
    if (
      owner.schemaVersion !== 1 ||
      typeof owner.token !== "string" ||
      !Number.isInteger(owner.processId) ||
      typeof owner.processInstanceId !== "string"
    ) {
      return null;
    }
    return owner;
  } catch {
    return null;
  }
}

async function ageMs(path: string): Promise<number | null> {
  try {
    return Date.now() - (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Serialize recovery so two waiters cannot both delete the same lease and hand
 * it to two different winners.  A fence left behind by a process that died
 * mid-recovery is itself reclaimed on age, otherwise one crash would wedge the
 * workspace permanently.
 */
async function acquireRecoveryFence(leasePath: string): Promise<boolean> {
  const recoveryPath = join(leasePath, LEASE_RECOVERY_DIRECTORY);
  try {
    await mkdir(recoveryPath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false;
    const fenceAgeMs = await ageMs(recoveryPath);
    if (fenceAgeMs === null || fenceAgeMs < RECOVERY_FENCE_STALE_MS)
      return false;
    await rm(recoveryPath, { recursive: true, force: true }).catch(
      () => undefined,
    );
    try {
      await mkdir(recoveryPath);
      return true;
    } catch {
      return false;
    }
  }
}

async function recoverLease(
  leasePath: string,
  stillUnusable: () => Promise<boolean>,
): Promise<boolean> {
  if (!(await acquireRecoveryFence(leasePath))) return false;
  const recoveryPath = join(leasePath, LEASE_RECOVERY_DIRECTORY);
  let removed = false;
  try {
    if (!(await stillUnusable())) return false;
    await rm(leasePath, { recursive: true, force: true });
    removed = true;
    return true;
  } catch {
    return false;
  } finally {
    if (!removed)
      await rm(recoveryPath, { recursive: true, force: true }).catch(
        () => undefined,
      );
  }
}

async function leaseOwnerIsUnusable(
  leasePath: string,
  owner: WorkspaceSkillLeaseOwner,
): Promise<boolean> {
  if (!processIsAlive(owner.processId)) return true;
  const heartbeatAgeMs = await ageMs(leaseOwnerFilePath(leasePath));
  return heartbeatAgeMs !== null && heartbeatAgeMs >= LEASE_STALE_MS;
}

async function acquireWorkspaceSkillLease(
  workspaceRoot: string,
  operation: string,
): Promise<() => Promise<void>> {
  const leasePath = workspaceSkillLeasePath(workspaceRoot);
  const ownerFile = leaseOwnerFilePath(leasePath);
  const token = randomUUID();
  const deadline = Date.now() + LEASE_TIMEOUT_MS;
  const owner: WorkspaceSkillLeaseOwner = {
    schemaVersion: 1,
    token,
    processId: process.pid,
    processInstanceId: PROCESS_INSTANCE_ID,
    processStartedAt: PROCESS_STARTED_AT,
    operation,
    acquiredAt: new Date().toISOString(),
  };

  await mkdir(dirname(leasePath), { recursive: true });
  for (;;) {
    let created = false;
    try {
      await mkdir(leasePath);
      created = true;
      await writeFile(ownerFile, `${JSON.stringify(owner)}\n`, "utf8");
      // Bump mtime rather than rewriting the file: a reader must never observe
      // a half-written owner record and mistake it for an abandoned lease.
      const heartbeat = setInterval(() => {
        const now = new Date();
        void utimes(ownerFile, now, now).catch(() => undefined);
      }, LEASE_HEARTBEAT_MS);
      heartbeat.unref?.();
      return async () => {
        clearInterval(heartbeat);
        const current = await readLeaseOwner(leasePath);
        // A missing or corrupt owner record still belongs to us: we created the
        // directory and never released it. Leaving it would strand the lease
        // until the abandoned-lease grace period elapses.
        if (current && current.token !== token) return;
        await rm(leasePath, { recursive: true, force: true });
      };
    } catch (error) {
      if (created)
        await rm(leasePath, { recursive: true, force: true }).catch(
          () => undefined,
        );
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;

      const current = await readLeaseOwner(leasePath);
      if (current) {
        if (
          (await leaseOwnerIsUnusable(leasePath, current)) &&
          (await recoverLease(leasePath, async () => {
            const observed = await readLeaseOwner(leasePath);
            if (
              !observed ||
              observed.token !== current.token ||
              observed.processInstanceId !== current.processInstanceId
            ) {
              return false;
            }
            return leaseOwnerIsUnusable(leasePath, observed);
          }))
        ) {
          continue;
        }
      } else {
        const ownerlessAgeMs = await ageMs(leasePath);
        if (
          ownerlessAgeMs !== null &&
          ownerlessAgeMs >= ABANDONED_LEASE_GRACE_MS &&
          (await recoverLease(
            leasePath,
            async () => (await readLeaseOwner(leasePath)) === null,
          ))
        ) {
          continue;
        }
      }

      if (Date.now() >= deadline) {
        const heldBy = current
          ? ` (held by pid ${current.processId} for "${current.operation}" since ${current.acquiredAt})`
          : "";
        throw new Error(
          `workspace_skill_lease_busy: another Veslo process is updating this workspace skill view${heldBy}`,
        );
      }
      await delay(LEASE_WAIT_MS);
    }
  }
}

export async function withWorkspaceSkillLease<T>(
  workspaceRoot: string,
  operation: string,
  task: () => Promise<T>,
): Promise<T> {
  const normalizedRoot = resolve(workspaceRoot);
  const key = workspaceSkillLeaseKey(normalizedRoot);

  const alreadyHeld = heldLeaseKeys.getStore();
  if (alreadyHeld?.has(key)) return task();
  const nextHeld = new Set(alreadyHeld ?? []);
  nextHeld.add(key);

  const previous = workspaceLeaseQueues.get(key) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const release = await acquireWorkspaceSkillLease(
        normalizedRoot,
        operation,
      );
      try {
        return await heldLeaseKeys.run(nextHeld, task);
      } finally {
        // A failure to clean up the lock must not replace the task's own error;
        // the lease recovers on its own through the heartbeat protocol.
        await release().catch(() => undefined);
      }
    });
  const settled = current.then(
    () => undefined,
    () => undefined,
  );
  workspaceLeaseQueues.set(key, settled);
  try {
    return await current;
  } finally {
    if (workspaceLeaseQueues.get(key) === settled)
      workspaceLeaseQueues.delete(key);
  }
}
