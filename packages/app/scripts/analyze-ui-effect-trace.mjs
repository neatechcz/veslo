import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const stableTraceValue = (value) => {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableTraceValue).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableTraceValue(value[key])}`)
    .join(",")}}`;
};

export const dedupeIncidentWindowEntries = (windows) => {
  const entries = new Map();
  for (const window of windows) {
    for (const entry of window.entries) {
      const key = `${entry.at ?? ""}\u0000${entry.event ?? ""}\u0000${stableTraceValue(entry.payload ?? {})}`;
      entries.set(key, entry);
    }
  }
  return [...entries.values()];
};

export const analyzeTraceLines = (lines) => {
  const events = lines.flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
  const windows = lines.flatMap((line) => {
    try {
      const entry = JSON.parse(line);
      return entry.event === "ui-effect-trace:incident-window" &&
        Array.isArray(entry.entries)
        ? [entry]
        : [];
    } catch {
      return [];
    }
  });
  const benchmarks = events.filter(
    (entry) => entry.event === "ui-effect-trace:benchmark",
  );

  return {
    events,
    windows,
    benchmarks,
    incidentEntries: dedupeIncidentWindowEntries(windows),
  };
};

export const summarizeIncidentEntries = (entries) => {
  const counts = new Map();
  for (const entry of entries) {
    const owner =
      entry.event === "ui-effect:run"
        ? (entry.payload?.owner ?? "unknown-effect")
        : entry.event;
    counts.set(owner, (counts.get(owner) ?? 0) + 1);
  }
  return counts;
};

const summarizeMessageBlockMarkers = (events) =>
  events.flatMap((entry) => {
    if (
      entry.event !== "session-ui:render-source-mark" ||
      entry.source !== "MessageList.messageBlocks"
    )
      return [];
    const payload =
      entry.markerPayload ?? entry.payload?.markerPayload ?? entry;
    const sessionId = payload.selectedSessionId ?? entry.selectedSessionId;
    return sessionId
      ? [{ at: entry.at ?? payload.at ?? null, sessionId, payload }]
      : [];
  });

export const printTraceAnalysis = ({ events, windows, benchmarks = [], incidentEntries }) => {
  const counts = summarizeIncidentEntries(incidentEntries);
  console.log(
    `UI effect incident windows: ${windows.length} (overlapping sampled windows)`,
  );
  console.log(`Deduplicated incident entries: ${incidentEntries.length}`);
  console.log("Sampled incident-window event counts (not whole-run totals):");
  for (const [owner, count] of [...counts.entries()].sort(
    (left, right) => right[1] - left[1] || left[0].localeCompare(right[0]),
  )) {
    console.log(`${String(count).padStart(4)}  ${owner}`);
  }

  const messageBlockBenchmarks = benchmarks.filter(
    (entry) => entry.kind === "message-blocks-stream",
  );
  if (messageBlockBenchmarks.length > 0) {
    console.log("\nMessageList stream benchmarks (one aggregate per completed stream):");
    for (const benchmark of messageBlockBenchmarks) {
      const payload = benchmark.payload ?? {};
      console.log(
        [
          benchmark.at ?? "unknown-time",
          `durationMs=${payload.durationMs ?? "?"}`,
          `recomputes=${payload.recomputes ?? "?"}`,
          `memoNoOps=${payload.memoNoOps ?? "?"}`,
          `nested=${payload.nestedRecomputes ?? "?"}`,
          `displayChanges=${payload.displayChanges ?? "?"}`,
          `maxNoOpsIn30s=${payload.maxNoOpsIn30s ?? "?"}`,
          `totalSelfTimeMs=${payload.totalSelfTimeMs ?? "?"}`,
          `maxSelfTimeMs=${payload.maxSelfTimeMs ?? "?"}`,
        ].join("  "),
      );
    }
  }

  const messageBlockMarkers = summarizeMessageBlockMarkers(events);
  if (messageBlockMarkers.length === 0) return;
  console.log("\nMessageList recomputation summary (full trace markers):");
  const bySession = new Map();
  for (const marker of messageBlockMarkers) {
    const list = bySession.get(marker.sessionId) ?? [];
    list.push(marker);
    bySession.set(marker.sessionId, list);
  }

  for (const [sessionId, markers] of bySession) {
    const displayRevisions = new Set(
      markers
        .map(({ payload }) => payload.displayRevision)
        .filter((value) => value !== undefined),
    );
    const streamRevisions = new Set(
      markers
        .map(({ payload }) => payload.streamPartRevision)
        .filter((value) => value !== undefined),
    );
    const memoNoOps = markers.filter(
      ({ payload }) => payload.memoNoOp === true,
    ).length;
    const nested = markers.filter(
      ({ payload }) => payload.nestedReactiveDependencyChanged === true,
    ).length;
    const writes = markers.filter(
      ({ payload }) =>
        typeof payload.writeRevisionStart === "number" &&
        typeof payload.writeRevisionEnd === "number" &&
        payload.writeRevisionEnd > payload.writeRevisionStart,
    ).length;
    const boundaries = new Set(
      markers.flatMap(({ payload }) =>
        Object.values(payload.transcriptProjectionBoundaries ?? {})
          .map((boundary) =>
            boundary && typeof boundary === "object"
              ? `${boundary.stage}:${boundary.revision}`
              : null,
          )
          .filter(Boolean),
      ),
    );
    console.log(
      [
        sessionId,
        `markers=${markers.length}`,
        `displayRevisions=${displayRevisions.size}`,
        `streamRevisions=${streamRevisions.size}`,
        `nested=${nested}`,
        `memoNoOps=${memoNoOps}`,
        `directWriteMarkers=${writes}`,
        `boundaryRevisionsSeen=${boundaries.size}`,
      ].join("  "),
    );
  }
};

const scriptDir = fileURLToPath(new URL(".", import.meta.url));
const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  const input =
    process.argv[2] ??
    resolve(scriptDir, "../../../.tmp/send-workflow-trace.ui.ndjson");
  const lines = readFileSync(input, "utf8").split(/\r?\n/).filter(Boolean);
  printTraceAnalysis(analyzeTraceLines(lines));
}
