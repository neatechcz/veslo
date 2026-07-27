import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

/**
 * Cross-process behaviour of the workspace skill lease.
 *
 * The in-process tests cover the protocol's branches; these two cover the thing
 * the protocol exists for, which only real processes can show: that server and
 * orchestrator — separate programs loading separate copies of the module —
 * actually exclude each other, and that a hard kill does not strand a workspace.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER_LEASE = pathToFileURL(
  join(HERE, "..", "workspace-skill-lease.ts"),
).href;
const ORCHESTRATOR_LEASE = pathToFileURL(
  join(HERE, "..", "..", "..", "orchestrator", "src", "workspace-skill-lease.ts"),
).href;

const WORKERS = 6;
const ITERATIONS = 15;

type WorkerRun = { stdout: string; code: number | null };

const runScript = (file: string, args: string[]): Promise<WorkerRun> =>
  new Promise((resolve, reject) => {
    // No shell: the reported pid must be the runtime itself, so the crash test
    // can signal it directly instead of killing an intermediate wrapper.
    const child = spawn(process.execPath, [file, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(`worker exited ${code}: ${stderr}`));
      else resolve({ stdout, code });
    });
  });

describe("workspace skill lease under real cross-process contention", () => {
  test(
    "separate processes never interleave inside the lease",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "veslo-lease-contention-"));
      try {
        const counterFile = join(workspace, "counter.json");
        await writeFile(counterFile, JSON.stringify({ count: 0 }), "utf8");

        // A read-modify-write with a deliberate gap: without mutual exclusion
        // the concurrent writers lose updates and the final count falls short.
        const workerFile = join(workspace, "worker.mjs");
        await writeFile(
          workerFile,
          `
import { readFile, writeFile } from "node:fs/promises";
const [, , leaseModule, workspace, iterations, label] = process.argv;
const { withWorkspaceSkillLease } = await import(leaseModule);
const counterFile = ${JSON.stringify(counterFile).replace(/\\/g, "\\\\")};
for (let i = 0; i < Number(iterations); i += 1) {
  await withWorkspaceSkillLease(workspace, "contention-" + label, async () => {
    const current = JSON.parse(await readFile(counterFile, "utf8"));
    await new Promise((r) => setTimeout(r, 2));
    current.count += 1;
    await writeFile(counterFile, JSON.stringify(current), "utf8");
  });
}
`,
          "utf8",
        );

        await Promise.all(
          Array.from({ length: WORKERS }, (_, i) =>
            runScript(workerFile, [
              i % 2 === 0 ? SERVER_LEASE : ORCHESTRATOR_LEASE,
              workspace,
              String(ITERATIONS),
              String(i),
            ]),
          ),
        );

        const final = JSON.parse(await readFile(counterFile, "utf8")) as {
          count: number;
        };
        expect(final.count).toBe(WORKERS * ITERATIONS);
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
    120_000,
  );

  test(
    "a hard-killed holder does not strand the workspace",
    async () => {
      const workspace = await mkdtemp(join(tmpdir(), "veslo-lease-crash-"));
      try {
        const holderFile = join(workspace, "holder.mjs");
        await writeFile(
          holderFile,
          `
import { withWorkspaceSkillLease } from ${JSON.stringify(SERVER_LEASE)};
await withWorkspaceSkillLease(process.argv[2], "engine-stage", async () => {
  console.log("HELD");
  await new Promise(() => {});
});
`,
          "utf8",
        );

        const holder = spawn(process.execPath, [holderFile, workspace], {
          stdio: ["ignore", "pipe", "pipe"],
        });
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(
            () => reject(new Error("holder never acquired the lease")),
            60_000,
          );
          holder.stdout.on("data", (chunk) => {
            if (String(chunk).includes("HELD")) {
              clearTimeout(timer);
              resolve();
            }
          });
        });

        // No release, no cleanup, no further heartbeat.
        const holderExited = new Promise<void>((resolve) =>
          holder.on("close", () => resolve()),
        );
        holder.kill("SIGKILL");
        await holderExited;

        const waiterFile = join(workspace, "waiter.mjs");
        await writeFile(
          waiterFile,
          `
import { withWorkspaceSkillLease } from ${JSON.stringify(ORCHESTRATOR_LEASE)};
await withWorkspaceSkillLease(process.argv[2], "materialize", async () => {
  console.log("RECLAIMED");
});
`,
          "utf8",
        );

        const waiter = await runScript(waiterFile, [workspace]);
        expect(waiter.stdout).toContain("RECLAIMED");
      } finally {
        await rm(workspace, { recursive: true, force: true });
      }
    },
    120_000,
  );
});
