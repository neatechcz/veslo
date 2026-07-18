import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const input = process.argv[2] ?? resolve(scriptDir, "../../../.tmp/send-workflow-trace.ui.ndjson");
const lines = readFileSync(input, "utf8").split(/\r?\n/).filter(Boolean);
const windows = lines.flatMap((line) => {
  try {
    const entry = JSON.parse(line);
    return entry.event === "ui-effect-trace:incident-window" && Array.isArray(entry.entries) ? [entry] : [];
  } catch {
    return [];
  }
});

const counts = new Map();
for (const window of windows) {
  for (const entry of window.entries) {
    const owner = entry.event === "ui-effect:run" ? entry.payload?.owner ?? "unknown-effect" : entry.event;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
}

console.log(`UI effect incident windows: ${windows.length}`);
for (const [owner, count] of [...counts.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))) {
  console.log(`${String(count).padStart(4)}  ${owner}`);
}
