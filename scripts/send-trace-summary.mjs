#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_TRACE_PATH = ".tmp/send-workflow-trace.ndjson";

const args = process.argv.slice(2);
const jsonOutput = args.includes("--json");
const includeSiblingTraceSet = args.includes("--all");
const limitArg = args.find((arg) => arg.startsWith("--limit="));
const limit = limitArg ? Math.max(1, Number.parseInt(limitArg.slice("--limit=".length), 10) || 20) : 20;
const tracePathArg = args.find((arg) => !arg.startsWith("--"));
const tracePath = resolve(process.cwd(), tracePathArg || DEFAULT_TRACE_PATH);

function isSendWorkflowTraceFileName(value) {
  return /^send-workflow-trace(?:[.-].+)?\.ndjson$/i.test(value);
}

function listTraceFilesInDirectory(directory) {
  return readdirSync(directory)
    .filter(isSendWorkflowTraceFileName)
    .map((name) => resolve(directory, name))
    .filter((filePath) => statSync(filePath).isFile())
    .sort();
}

function resolveTraceInputFiles(filePath, options = {}) {
  const includeSiblings = Boolean(options.includeSiblingTraceSet);
  if (existsSync(filePath)) {
    const stats = statSync(filePath);
    if (stats.isDirectory()) {
      const files = listTraceFilesInDirectory(filePath);
      if (files.length) return files;
      throw new Error(`No send workflow trace files found in directory: ${filePath}`);
    }
    if (stats.isFile()) {
      if (includeSiblings && isSendWorkflowTraceFileName(basename(filePath))) {
        const files = listTraceFilesInDirectory(dirname(filePath));
        if (files.length) return files;
      }
      return [filePath];
    }
  }

  if (isSendWorkflowTraceFileName(basename(filePath)) && existsSync(dirname(filePath))) {
    const files = listTraceFilesInDirectory(dirname(filePath));
    if (files.length) return files;
  }

  throw new Error(`Trace file not found: ${filePath}`);
}

function classifyPhase(event) {
  const text = String(event || "").toLowerCase();
  if (!text) return "unknown";
  if (text.includes("orchestrator:proxy")) return "orchestrator-proxy";
  if (text.includes("managed-ai-runtime-auth-prime")) return "managed-ai-auth-prime";
  if (
    text.includes("runtime-preflight") ||
    text.includes("ensure-local-runtime") ||
    text.includes("blocked-runtime") ||
    text.includes("runtime-recovery")
  ) return "runtime-preflight";
  if (text.includes("server-submit-first") || text.includes("create-session-and-open")) return "server-submit-first";
  if (text.includes("server-submit-existing")) return "server-submit-existing";
  if (text.includes("conversation-create") || text.includes("opencode/session")) return "session-create";
  if (text.includes("conversation-submit-run") || text.includes("opencode-submit")) return "run-submit";
  if (text.includes("queue-drain") || text.includes("queued")) return "queue-drain";
  if (text.includes("ai-gateway")) return "ai-gateway";
  if (text.includes("transcript") || text.includes("session-sse")) return "transcript";
  if (text.includes("skill-materialization") || text.includes("skills-ready")) return "skill-materialization";
  return "other";
}

function isExpectedProxyStreamClose(entry) {
  const event = String(entry.event || "").toLowerCase();
  const method = String(entry.method || "").toUpperCase();
  const path = String(entry.path || "");
  const error = String(entry.error || "").toLowerCase();
  return (
    event === "orchestrator:proxy-upstream:error" &&
    method === "GET" &&
    path.includes("/opencode/event") &&
    error.includes("socket connection was closed unexpectedly") &&
    Number(entry.durationMs || 0) >= 1000
  );
}

function isProblemEvent(entry) {
  if (isExpectedProxyStreamClose(entry)) return false;
  const event = String(entry.event || "").toLowerCase();
  const outcome = String(entry.outcome || "").toLowerCase();
  const status = typeof entry.status === "number" ? entry.status : null;
  if (status !== null && status >= 400) return true;
  if (outcome === "error" || outcome === "failed") return true;
  return (
    event.includes("validation-failed") ||
    event.endsWith(":error") ||
    event.endsWith("-error") ||
    event.endsWith(":failed") ||
    event.endsWith("-failed") ||
    event.includes(":blocked") ||
    event.includes("-blocked") ||
    event.includes(":unavailable") ||
    event.includes("-unavailable")
  );
}

function traceKey(entry) {
  const direct = entry.traceId || entry.uiSendTraceId || entry.sendTraceId;
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  if (typeof entry.runId === "string" && entry.runId.trim()) return `run:${entry.runId.trim()}`;
  if (typeof entry.requestId === "string" && entry.requestId.trim()) return `request:${entry.requestId.trim()}`;
  return "no-trace";
}

function addValue(set, value) {
  if (typeof value === "string" && value.trim()) set.add(value.trim());
}

function parseTraceLine(line) {
  try {
    return { entries: [JSON.parse(line)], malformedFragments: 0 };
  } catch {
    // Older Windows dev runs could interleave process writes and glue multiple JSON
    // objects on one NDJSON row. Recover complete objects so summaries stay useful.
  }

  const entries = [];
  let malformedFragments = 0;
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (start === -1) {
      if (char === "{") {
        start = index;
        depth = 1;
      }
      continue;
    }

    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      const fragment = line.slice(start, index + 1);
      try {
        entries.push(JSON.parse(fragment));
      } catch {
        malformedFragments += 1;
      }
      start = -1;
    }
  }

  if (start !== -1) malformedFragments += 1;
  return { entries, malformedFragments };
}

function summarizeTraceFiles(filePaths) {
  if (!filePaths.length) {
    throw new Error("No trace files provided.");
  }

  const groups = new Map();
  let parsedLines = 0;
  let skippedLines = 0;
  let skippedFragments = 0;

  for (const filePath of filePaths) {
    if (!existsSync(filePath)) {
      throw new Error(`Trace file not found: ${filePath}`);
    }
    const lines = readFileSync(filePath, "utf8").split(/\r?\n/);

    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseTraceLine(line);
      skippedFragments += parsed.malformedFragments;
      if (!parsed.entries.length) {
        skippedLines += 1;
        continue;
      }

      for (const entry of parsed.entries) {
        parsedLines += 1;
        if (!entry || typeof entry !== "object") continue;

        const key = traceKey(entry);
        const current = groups.get(key) || {
          key,
          firstAt: null,
          lastAt: null,
          count: 0,
          phases: new Set(),
          events: new Set(),
          workspaces: new Set(),
          conversations: new Set(),
          sessions: new Set(),
          runs: new Set(),
          clientMessages: new Set(),
          statuses: new Set(),
          problems: [],
        };

        const event = typeof entry.event === "string" ? entry.event : "";
        current.count += 1;
        current.phases.add(classifyPhase(event));
        addValue(current.events, event);
        addValue(current.workspaces, entry.workspaceId);
        addValue(current.conversations, entry.conversationId);
        addValue(current.sessions, entry.sessionID);
        addValue(current.sessions, entry.sessionId);
        addValue(current.sessions, entry.opencodeSessionId);
        addValue(current.runs, entry.runId);
        addValue(current.clientMessages, entry.clientMessageId);
        if (entry.status !== undefined && entry.status !== null) current.statuses.add(String(entry.status));
        if (entry.outcome !== undefined && entry.outcome !== null) current.statuses.add(`outcome:${entry.outcome}`);

        const at = typeof entry.at === "string" ? entry.at : null;
        if (at && (!current.firstAt || at < current.firstAt)) current.firstAt = at;
        if (at && (!current.lastAt || at > current.lastAt)) current.lastAt = at;

        if (isProblemEvent(entry)) {
          current.problems.push({
            at,
            event,
            phase: classifyPhase(event),
            status: entry.status ?? null,
            code: entry.code ?? null,
            outcome: entry.outcome ?? null,
            message: entry.message ?? null,
            error: entry.error ?? null,
            method: entry.method ?? null,
            path: entry.path ?? null,
            durationMs: entry.durationMs ?? null,
          });
        }

        groups.set(key, current);
      }
    }
  }

  const traces = [...groups.values()]
    .map((group) => ({
      ...group,
      phases: [...group.phases].sort(),
      events: [...group.events].sort(),
      workspaces: [...group.workspaces].sort(),
      conversations: [...group.conversations].sort(),
      sessions: [...group.sessions].sort(),
      runs: [...group.runs].sort(),
      clientMessages: [...group.clientMessages].sort(),
      statuses: [...group.statuses].sort(),
    }))
    .sort((left, right) => String(right.lastAt || "").localeCompare(String(left.lastAt || "")));

  return {
    filePath: filePaths.length === 1 ? filePaths[0] : null,
    filePaths,
    parsedLines,
    skippedLines,
    skippedFragments,
    traceCount: traces.length,
    traces,
  };
}

function summarizeTraceFile(filePath) {
  return summarizeTraceFiles([filePath]);
}

function compactList(values, max = 5) {
  if (!values.length) return "-";
  const head = values.slice(0, max).join(", ");
  return values.length > max ? `${head}, +${values.length - max}` : head;
}

function printText(summary) {
  console.log(`Send trace summary: ${summary.filePath || `${summary.filePaths.length} files`}`);
  if (summary.filePaths.length > 1) {
    for (const filePath of summary.filePaths) console.log(`  - ${filePath}`);
  }
  const skippedSuffix = summary.skippedFragments ? `, skipped fragments ${summary.skippedFragments}` : "";
  console.log(`Parsed ${summary.parsedLines} entr${summary.parsedLines === 1 ? "y" : "ies"}, skipped lines ${summary.skippedLines}${skippedSuffix}, grouped ${summary.traceCount} trace(s).`);
  console.log("");
  for (const trace of summary.traces.slice(0, limit)) {
    const problemCount = trace.problems.length;
    console.log(`${trace.key}`);
    console.log(`  window: ${trace.firstAt || "-"} -> ${trace.lastAt || "-"}`);
    console.log(`  phases: ${compactList(trace.phases, 10)}`);
    console.log(`  workspace: ${compactList(trace.workspaces)}`);
    console.log(`  conversation: ${compactList(trace.conversations)}`);
    console.log(`  session: ${compactList(trace.sessions)}`);
    console.log(`  run: ${compactList(trace.runs)}`);
    console.log(`  clientMessage: ${compactList(trace.clientMessages)}`);
    console.log(`  statuses: ${compactList(trace.statuses, 8)}`);
    console.log(`  events: ${trace.count}; problems: ${problemCount}`);
    for (const problem of trace.problems.slice(0, 3)) {
      const detail = problem.message || problem.error || problem.code || "";
      const route = problem.method && problem.path ? ` ${problem.method} ${problem.path}` : "";
      console.log(`    - ${problem.at || "-"} [${problem.phase}] ${problem.event || "-"}${route} ${detail}`.trimEnd());
    }
    if (problemCount > 3) console.log(`    - +${problemCount - 3} more`);
    console.log("");
  }
}

function main() {
  try {
    const files = resolveTraceInputFiles(tracePath, {
      includeSiblingTraceSet: includeSiblingTraceSet || !tracePathArg,
    });
    const summary = summarizeTraceFiles(files);
    if (jsonOutput) {
      console.log(JSON.stringify({
        ...summary,
        traces: summary.traces.slice(0, limit),
      }, null, 2));
    } else {
      printText(summary);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main();
}

export {
  classifyPhase,
  isExpectedProxyStreamClose,
  isProblemEvent,
  parseTraceLine,
  resolveTraceInputFiles,
  summarizeTraceFile,
  summarizeTraceFiles,
  traceKey,
};
