import { mkdtemp, writeFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import { collectFileBackedDebugLogEvents } from "./debug-log-files.js";

const tempDirs: string[] = [];
const envSnapshot = new Map<string, string | undefined>();

afterEach(async () => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) await rm(dir, { recursive: true, force: true });
  }
  for (const [key, value] of envSnapshot.entries()) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  envSnapshot.clear();
});

test("collects agentlab and legacy audit log files as raw events", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-debug-log-files-"));
  tempDirs.push(workspaceRoot);
  envSnapshot.set("VESLO_DATA_DIR", process.env.VESLO_DATA_DIR);
  process.env.VESLO_DATA_DIR = join(workspaceRoot, "data");

  const agentlabDir = join(workspaceRoot, ".opencode", "veslo", "agentlab", "logs");
  const legacyDir = join(workspaceRoot, ".opencode", "veslo");
  await mkdir(agentlabDir, { recursive: true });
  await mkdir(legacyDir, { recursive: true });

  await writeFile(join(agentlabDir, "auto-1.log"), "line-a\nline-b\n", "utf8");
  await writeFile(join(legacyDir, "audit.jsonl"), "{\"id\":\"audit-1\"}\n", "utf8");

  const events = await collectFileBackedDebugLogEvents({
    workspaceRoot,
    workspaceId: "ws_1",
    userId: "usr_1",
    orgId: "org_1",
  });
  expect(events.map((entry) => entry.source)).toEqual(["agentlab", "audit"]);
});

test("does not resend unchanged file content on subsequent scans", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-debug-log-files-"));
  tempDirs.push(workspaceRoot);
  envSnapshot.set("VESLO_DATA_DIR", process.env.VESLO_DATA_DIR);
  process.env.VESLO_DATA_DIR = join(workspaceRoot, "data");

  const agentlabDir = join(workspaceRoot, ".opencode", "veslo", "agentlab", "logs");
  await mkdir(agentlabDir, { recursive: true });
  const logPath = join(agentlabDir, "auto-1.log");

  await writeFile(logPath, "line-a\n", "utf8");
  const first = await collectFileBackedDebugLogEvents({
    workspaceRoot,
    workspaceId: "ws_1",
    userId: "usr_1",
    orgId: "org_1",
  });
  expect(first.map((entry) => entry.source)).toEqual(["agentlab"]);
  expect(first[0]?.payload).toMatchObject({ content: "line-a\n" });

  const second = await collectFileBackedDebugLogEvents({
    workspaceRoot,
    workspaceId: "ws_1",
    userId: "usr_1",
    orgId: "org_1",
  });
  expect(second).toEqual([]);

  await writeFile(logPath, "line-a\nline-b\n", "utf8");
  const third = await collectFileBackedDebugLogEvents({
    workspaceRoot,
    workspaceId: "ws_1",
    userId: "usr_1",
    orgId: "org_1",
  });
  expect(third.map((entry) => entry.source)).toEqual(["agentlab"]);
  expect(third[0]?.payload).toMatchObject({ content: "line-b\n" });
});

test("re-emits a file when its content changes without changing size", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-debug-log-files-"));
  tempDirs.push(workspaceRoot);
  envSnapshot.set("VESLO_DATA_DIR", process.env.VESLO_DATA_DIR);
  process.env.VESLO_DATA_DIR = join(workspaceRoot, "data");

  const agentlabDir = join(workspaceRoot, ".opencode", "veslo", "agentlab", "logs");
  await mkdir(agentlabDir, { recursive: true });
  const logPath = join(agentlabDir, "auto-1.log");

  await writeFile(logPath, "alpha\n", "utf8");
  const first = await collectFileBackedDebugLogEvents({
    workspaceRoot,
    workspaceId: "ws_1",
    userId: "usr_1",
    orgId: "org_1",
  });
  expect(first.map((entry) => entry.source)).toEqual(["agentlab"]);
  expect(first[0]?.payload).toMatchObject({ content: "alpha\n" });

  await writeFile(logPath, "bravo\n", "utf8");
  const second = await collectFileBackedDebugLogEvents({
    workspaceRoot,
    workspaceId: "ws_1",
    userId: "usr_1",
    orgId: "org_1",
  });
  expect(second.map((entry) => entry.source)).toEqual(["agentlab"]);
  expect(second[0]?.payload).toMatchObject({ content: "bravo\n" });
});
