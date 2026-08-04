import { readFile } from "node:fs/promises";

const pause = (milliseconds) => new Promise((resolvePause) => setTimeout(resolvePause, milliseconds));

export async function readWorkflowTrace(path) {
  const raw = await readFile(path, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  return raw
    .split(/\r?\n/)
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const parsed = JSON.parse(line);
        return parsed && typeof parsed === "object" ? [parsed] : [];
      } catch {
        return [];
      }
    });
}

export async function waitForWorkflowTraceEvent({
  path,
  event,
  afterTs = 0,
  timeoutMs = 30_000,
  matches = () => true,
}) {
  const deadline = Date.now() + timeoutMs;
  let latest = [];
  while (Date.now() < deadline) {
    latest = (await readWorkflowTrace(path))
      .filter((entry) => Number(entry?.ts ?? 0) >= afterTs)
      .filter((entry) => entry?.event === event);
    const match = latest.find(matches);
    if (match) return match;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${event}; observed ${latest.length} matching event names after ${afterTs}.`);
}
