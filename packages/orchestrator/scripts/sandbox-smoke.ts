#!/usr/bin/env bun
/**
 * F4Ú1+Ú2 smoke test — sandbox isolation via Anthropic lib + Veslo
 * WorkerSandbox abstrakce.
 *
 * Run:  bun scripts/sandbox-smoke.ts   (z packages/orchestrator)
 *
 * Test plán:
 *   1. raw SandboxManager (F4Ú1) — allow/deny read+write working.
 *   2. MacSandboxExec.wrap() (F4Ú2) — same scenarios přes Veslo API.
 *   3. .git RO override (F4Ú5) — workspace má .git, sandbox musí denyWrite tam.
 */
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { SandboxManager, type SandboxRuntimeConfig } from "@anthropic-ai/sandbox-runtime";
import { MacSandboxExec } from "../src/sandbox/index.js";

const WORKDIR = "/tmp/sandbox-veslo-smoke";
const SECRET = join(WORKDIR, "secret.txt");
const SECRET_CONTENT = "veslo-sandbox-smoke-token-42";
const GIT_DIR = join(WORKDIR, ".git");

function setup() {
  try { rmSync(WORKDIR, { recursive: true, force: true }); } catch {}
  mkdirSync(WORKDIR, { recursive: true });
  writeFileSync(SECRET, SECRET_CONTENT);
  mkdirSync(GIT_DIR, { recursive: true });
  writeFileSync(join(GIT_DIR, "HEAD"), "ref: refs/heads/main\n");
}

async function runWrapped(label: string, wrapped: string) {
  return new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve) => {
    const child = spawn("/bin/sh", ["-c", wrapped], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (b) => (stdout += b.toString()));
    child.stderr!.on("data", (b) => (stderr += b.toString()));
    child.on("exit", (code) => {
      console.log(`[${label}] exit=${code}`);
      if (stdout.trim()) console.log(`[${label}] stdout: ${stdout.trim().split("\n").join(" | ")}`);
      if (stderr.trim()) console.log(`[${label}] stderr: ${stderr.trim().split("\n").join(" | ")}`);
      resolve({ stdout, stderr, code });
    });
  });
}

const fails: string[] = [];

async function partOne_rawManager() {
  console.log("\n--- Part 1: raw SandboxManager (F4Ú1 baseline) ---");
  const config: SandboxRuntimeConfig = {
    network: { allowedDomains: [], deniedDomains: [], allowLocalBinding: true },
    filesystem: {
      denyRead: [join(homedir(), ".ssh"), join(homedir(), ".aws")],
      allowWrite: [WORKDIR],
      denyWrite: [],
    },
  };
  await SandboxManager.initialize(config);
  if (!SandboxManager.isSandboxingEnabled()) {
    fails.push("part1: sandbox not enabled");
    return;
  }
  const allowed = await runWrapped("p1-allow-read", await SandboxManager.wrapWithSandbox(`cat ${SECRET}`));
  const denied = await runWrapped("p1-deny-read", await SandboxManager.wrapWithSandbox(`ls ${homedir()}/.ssh 2>&1 || true`));
  const write = await runWrapped("p1-allow-write", await SandboxManager.wrapWithSandbox(`echo new-line > ${join(WORKDIR, "out.txt")} && cat ${join(WORKDIR, "out.txt")}`));
  const denyWrite = await runWrapped("p1-deny-write", await SandboxManager.wrapWithSandbox(`echo escape > ${homedir()}/escape-p1.txt 2>&1 || true`));

  if (!allowed.stdout.includes(SECRET_CONTENT)) fails.push("part1: allowed-read missing secret");
  if (!/permitted|denied|EPERM|EACCES/i.test(denied.stdout + denied.stderr)) fails.push("part1: denied-read not blocked");
  if (!write.stdout.includes("new-line")) fails.push("part1: allowed-write not persisted");
  if (!/permitted|denied|EPERM|EACCES/i.test(denyWrite.stdout + denyWrite.stderr)) fails.push("part1: denied-write not blocked");
}

async function partTwo_workerSandbox() {
  console.log("\n--- Part 2: WorkerSandbox abstrakce (F4Ú2 API) ---");
  if (!MacSandboxExec.isAvailable()) {
    fails.push("part2: MacSandboxExec unavailable on this platform");
    return;
  }

  const wrappedAllow = await MacSandboxExec.wrap({
    command: `cat ${SECRET}`,
    workspacePath: WORKDIR,
  });
  const r1 = await runWrapped("p2-allow-read", wrappedAllow);
  if (!r1.stdout.includes(SECRET_CONTENT)) fails.push("part2: workspace read failed");

  const wrappedDeny = await MacSandboxExec.wrap({
    command: `ls ${homedir()}/.ssh 2>&1 || true`,
    workspacePath: WORKDIR,
  });
  const r2 = await runWrapped("p2-deny-read", wrappedDeny);
  if (!/permitted|denied|EPERM|EACCES/i.test(r2.stdout + r2.stderr)) fails.push("part2: ~/.ssh read not blocked");

  // F4Ú5 — .git ⊂ workspace should be RO. Try to write into .git, expect deny.
  const wrappedGitWrite = await MacSandboxExec.wrap({
    command: `echo evil > ${join(GIT_DIR, "config")} 2>&1 || true`,
    workspacePath: WORKDIR,
  });
  const r3 = await runWrapped("p2-deny-git-write", wrappedGitWrite);
  if (!/permitted|denied|EPERM|EACCES/i.test(r3.stdout + r3.stderr)) fails.push("part2: .git write not blocked");

  // But .git read MUST work (agent needs `git log`, `git show`).
  const wrappedGitRead = await MacSandboxExec.wrap({
    command: `cat ${join(GIT_DIR, "HEAD")}`,
    workspacePath: WORKDIR,
  });
  const r4 = await runWrapped("p2-allow-git-read", wrappedGitRead);
  if (!r4.stdout.includes("refs/heads/main")) fails.push("part2: .git read should be allowed");

  // Workspace file write outside .git must still work.
  const wrappedWsWrite = await MacSandboxExec.wrap({
    command: `echo hello > ${join(WORKDIR, "test.txt")} && cat ${join(WORKDIR, "test.txt")}`,
    workspacePath: WORKDIR,
  });
  const r5 = await runWrapped("p2-allow-ws-write", wrappedWsWrite);
  if (!r5.stdout.includes("hello")) fails.push("part2: workspace write outside .git should work");
}

async function main() {
  setup();
  console.log(`workdir=${WORKDIR}`);

  await partOne_rawManager();
  await partTwo_workerSandbox();

  console.log("\n=== Result ===");
  if (fails.length) {
    for (const f of fails) console.error("FAIL:", f);
    process.exit(1);
  }
  console.log(`PASS — all sandbox checks succeeded (workdir=${WORKDIR})`);
}

await main();
