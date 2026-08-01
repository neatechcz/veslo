#!/usr/bin/env node
import { spawn } from "node:child_process";
import { constants as fsConstants, createWriteStream } from "node:fs";
import { copyFile, mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { finished } from "node:stream/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, resolve } from "node:path";

import { loadDotEnv } from "../load-env.mjs";

const scriptDir = resolve(dirname(fileURLToPath(import.meta.url)));
const repositoryRoot = resolve(scriptDir, "../..");
const productionSshScript = resolve(scriptDir, "production-ssh.mjs");
const DEFAULT_PRODUCTION_APP_DIR = "/home/neatech/veslo-owned-server-production";
const DEFAULT_PRODUCTION_ENV_FILE = "/home/neatech/veslo-owned-server-dark-launch-inputs/env/production.env";
const DEFAULT_PRODUCTION_SSH_HOST = "62.109.146.43";
const DEFAULT_PRODUCTION_SSH_USER = "neatech";
const MAX_ANOMALIES_DEFAULT = 30;
const MAX_TRACKED_RUNS = 2_000;

export function usage() {
  return `Usage:
  pnpm admin:feedback-diagnostics -- [--feedback <feedback-id>] [--include-feedback-text] [--include-events] [--json] [--output <path> | --output-dir <path>]

Reads one feedback report and its linked diagnostic capture through one read-only
SSH command. Payloads are decrypted only inside the Den container; this command
prints a redacted summary, never the raw diagnostic payloads or encryption keys.

Options:
  --feedback <id>              inspect a specific feedback report (default: latest)
  --include-feedback-text      include feedback title and description in output
  --max-anomalies <count>      cap reported diagnostic anomalies (default: ${MAX_ANOMALIES_DEFAULT}, max: 100)
  --json                       emit the summary as JSON
  --output <path>              write to this new file (never overwrites an existing file)
  --output-dir <path>          write a timestamped, feedback-named artifact into this directory
  --include-events             write every decrypted diagnostic event as NDJSON (requires output)
  --help, -h                   show this help`;
}

export function parseArgs(argv) {
  const options = {
    feedbackId: null,
    includeFeedbackText: false,
    json: false,
    outputPath: null,
    outputDirectory: null,
    includeEvents: false,
    maxAnomalies: MAX_ANOMALIES_DEFAULT,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") return { help: true };
    if (arg === "--include-feedback-text") {
      options.includeFeedbackText = true;
      continue;
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--output") {
      const outputPath = argv[++index]?.trim();
      if (!outputPath) throw new Error("--output requires a file path.");
      options.outputPath = outputPath;
      continue;
    }
    if (arg === "--output-dir") {
      const outputDirectory = argv[++index]?.trim();
      if (!outputDirectory) throw new Error("--output-dir requires a directory path.");
      options.outputDirectory = outputDirectory;
      continue;
    }
    if (arg === "--include-events") {
      options.includeEvents = true;
      continue;
    }
    if (arg === "--feedback") {
      const feedbackId = argv[++index]?.trim();
      if (!feedbackId || !/^[A-Za-z0-9_-]{1,128}$/.test(feedbackId)) {
        throw new Error("--feedback must be a non-empty feedback id containing only letters, digits, _ or -.");
      }
      options.feedbackId = feedbackId;
      continue;
    }
    if (arg === "--max-anomalies") {
      const count = Number.parseInt(argv[++index] ?? "", 10);
      if (!Number.isInteger(count) || count < 1 || count > 100) {
        throw new Error("--max-anomalies must be an integer from 1 through 100.");
      }
      options.maxAnomalies = count;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  if (options.outputPath && options.outputDirectory) {
    throw new Error("Use either --output or --output-dir, not both.");
  }
  return options;
}

export function summarizeDiagnosticLine(line) {
  if (typeof line !== "string") return null;
  const prefix = "[veslo:send-workflow] ";
  const runtimePrefix = "[veslo:runtime-trace] ";
  const gatewayPrefix = "[veslo:ai-gateway] ";
  const activePrefix = line.startsWith(prefix)
    ? prefix
    : line.startsWith(runtimePrefix)
      ? runtimePrefix
      : line.startsWith(gatewayPrefix)
        ? gatewayPrefix
        : null;
  if (!activePrefix) return null;

  const remainder = line.slice(activePrefix.length);
  const jsonStart = remainder.indexOf(" {");
  const event = jsonStart === -1 ? remainder : remainder.slice(0, jsonStart);
  let data = {};
  if (jsonStart !== -1) {
    try {
      data = JSON.parse(remainder.slice(jsonStart + 1));
    } catch {
      return null;
    }
  }

  let kind = null;
  if (event === "server:conversation-run:ai-gateway-provider-start-watch:timeout") kind = "provider_start_timeout";
  else if (/opencode-submit:error/.test(event)) kind = "opencode_submit_error";
  else if (/engine-unreachable|terminal-status/.test(event) && /unreachable/i.test(String(data.terminalError ?? ""))) {
    kind = "engine_unreachable";
  } else if (/opencode-json:fallback-orchestrator/.test(event)) kind = "opencode_fallback";
  else if (/opencode-json:error-status/.test(event)) kind = "opencode_status_error";
  else if (/lifecycle-reconcile/.test(event) && data.status === "failed") kind = "run_failed";
  if (!kind) return null;

  return {
    kind,
    event,
    runId: textOrNull(data.runId),
    conversationId: textOrNull(data.conversationId),
    clientMessageId: textOrNull(data.clientMessageId),
    status: textOrNull(data.status),
    code: textOrNull(data.code),
    reason: textOrNull(data.reason),
    terminalError: textOrNull(data.terminalError),
  };
}

function textOrNull(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

export function buildRemoteProgram(options) {
  const request = JSON.stringify(options);
  return String.raw`
const { createHash, createDecipheriv, createSecretKey } = require("node:crypto");
const { createRequire } = require("node:module");
const { existsSync } = require("node:fs");
const request = ${request};
const denPackagePath = ["/app/services/den/package.json", "/workspace/services/den/package.json"].find(existsSync);
if (!denPackagePath) throw new Error("Den package manifest is unavailable in the running container.");
const mysql = createRequire(denPackagePath)("mysql2");

function decrypt(row) {
  const masterKey = process.env.DEN_LOG_MASTER_KEY;
  if (!masterKey) throw new Error("DEN_LOG_MASTER_KEY is not configured in Den.");
  const key = createSecretKey(new Uint8Array(createHash("sha256").update(masterKey).digest()));
  const decipher = createDecipheriv("aes-256-gcm", key, new Uint8Array(Buffer.from(row.payload_iv, "base64")));
  decipher.setAuthTag(new Uint8Array(Buffer.from(row.payload_auth_tag, "base64")));
  return JSON.parse(Buffer.concat([
    new Uint8Array(decipher.update(new Uint8Array(Buffer.from(row.payload_ciphertext, "base64")))),
    new Uint8Array(decipher.final()),
  ]).toString("utf8"));
}

function traceSummary(line) {
  if (typeof line !== "string") return null;
  const prefixes = ["[veslo:send-workflow] ", "[veslo:runtime-trace] ", "[veslo:ai-gateway] "];
  const prefix = prefixes.find((value) => line.startsWith(value));
  if (!prefix) return null;
  const rest = line.slice(prefix.length);
  const jsonStart = rest.indexOf(" {");
  const event = jsonStart === -1 ? rest : rest.slice(0, jsonStart);
  let data = {};
  if (jsonStart !== -1) {
    try { data = JSON.parse(rest.slice(jsonStart + 1)); } catch { return null; }
  }
  let kind = null;
  if (event === "server:conversation-run:ai-gateway-provider-start-watch:timeout") kind = "provider_start_timeout";
  else if (/opencode-submit:error/.test(event)) kind = "opencode_submit_error";
  else if (/engine-unreachable|terminal-status/.test(event) && /unreachable/i.test(String(data.terminalError ?? ""))) kind = "engine_unreachable";
  else if (/opencode-json:fallback-orchestrator/.test(event)) kind = "opencode_fallback";
  else if (/opencode-json:error-status/.test(event)) kind = "opencode_status_error";
  else if (/lifecycle-reconcile/.test(event) && data.status === "failed") kind = "run_failed";
  return { event, data, kind };
}

function optional(value) {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  const text = typeof value === "string" ? value.trim() : "";
  return text || null;
}

function toIso(value) {
  return value instanceof Date ? value.toISOString() : value ?? null;
}

function query(connection, sql, values = []) {
  return new Promise((resolve, reject) => {
    connection.query(sql, values, (error, rows) => error ? reject(error) : resolve(rows));
  });
}

function streamRows(connection, sql, values, onRow) {
  return new Promise((resolve, reject) => {
    const queryStream = connection.query(sql, values);
    queryStream.on("error", reject);
    queryStream.on("result", (row) => {
      try {
        onRow(row);
      } catch (error) {
        connection.destroy();
        reject(error);
      }
    });
    queryStream.on("end", resolve);
  });
}

async function main() {
  const connection = mysql.createConnection(process.env.DATABASE_URL);
  await new Promise((resolve, reject) => connection.connect((error) => error ? reject(error) : resolve()));
  try {
    const reports = await query(connection, request.feedbackId
      ? "SELECT id, status, title, description, diagnostic_capture_id AS diagnosticCaptureId, submitted_at AS submittedAt, created_at AS createdAt, screenshot_status AS screenshotStatus FROM feedback_report WHERE id = ? LIMIT 1"
      : "SELECT id, status, title, description, diagnostic_capture_id AS diagnosticCaptureId, submitted_at AS submittedAt, created_at AS createdAt, screenshot_status AS screenshotStatus FROM feedback_report ORDER BY submitted_at DESC, created_at DESC LIMIT 1",
      request.feedbackId ? [request.feedbackId] : []);
    const report = reports[0];
    if (!report) throw new Error(request.feedbackId ? "Feedback report was not found." : "No feedback reports are stored.");

    const result = {
      feedback: {
        id: report.id,
        status: report.status,
        submittedAt: toIso(report.submittedAt),
        createdAt: toIso(report.createdAt),
        screenshotStatus: report.screenshotStatus,
        diagnosticCaptureId: report.diagnosticCaptureId,
        ...(request.includeFeedbackText ? { title: report.title, description: report.description } : {}),
      },
      diagnostics: null,
    };
    if (!report.diagnosticCaptureId) return result;

    if (request.includeEvents) {
      process.stdout.write(JSON.stringify({ recordType: "feedback", feedback: result.feedback }) + "\n");
    }

    const diagnostics = {
      captureId: report.diagnosticCaptureId,
      eventCount: 0,
      payloadBytes: 0,
      firstEventAt: null,
      lastEventAt: null,
      sources: {},
      signals: {},
      anomalies: [],
      runs: new Map(),
      omittedRunObservations: 0,
    };
    await streamRows(connection, "SELECT event_timestamp AS eventTimestamp, source, stream, level, sequence_no AS sequenceNo, payload_bytes AS payloadBytes, payload_ciphertext, payload_iv, payload_auth_tag FROM debug_log_event WHERE capture_id = ? ORDER BY event_timestamp ASC, sequence_no ASC", [report.diagnosticCaptureId], (row) => {
      diagnostics.eventCount += 1;
      diagnostics.payloadBytes += Number(row.payloadBytes) || 0;
      const at = toIso(row.eventTimestamp);
      if (!diagnostics.firstEventAt) diagnostics.firstEventAt = at;
      diagnostics.lastEventAt = at;
      diagnostics.sources[row.source] = (diagnostics.sources[row.source] ?? 0) + 1;

      const payload = decrypt(row);
      if (request.includeEvents) {
        process.stdout.write(JSON.stringify({
          recordType: "event",
          at,
          source: row.source,
          stream: row.stream,
          level: row.level,
          sequenceNo: row.sequenceNo,
          payload,
        }) + "\n");
      }
      const trace = traceSummary(payload?.line);
      if (!trace) return;
      const runId = optional(trace.data.runId);
      if (runId) {
        const existing = diagnostics.runs.get(runId);
        if (!existing && diagnostics.runs.size >= ${MAX_TRACKED_RUNS}) {
          diagnostics.omittedRunObservations += 1;
        } else {
          const run = existing ?? {
            runId,
            clientMessageId: optional(trace.data.clientMessageId),
            origin: optional(trace.data.origin),
            firstAt: at,
            lastAt: at,
            providerStarted: false,
            providerTimedOut: false,
            finalStatus: null,
            submitError: false,
          };
          run.lastAt = at;
          run.clientMessageId ||= optional(trace.data.clientMessageId);
          run.origin ||= optional(trace.data.origin);
          run.providerStarted ||= trace.event === "server:ai-gateway:provider-hit";
          run.providerTimedOut ||= trace.kind === "provider_start_timeout";
          run.submitError ||= trace.kind === "opencode_submit_error";
          if (["completed", "failed", "aborted"].includes(trace.data.status)) run.finalStatus = trace.data.status;
          diagnostics.runs.set(runId, run);
        }
      }
      if (!trace.kind) return;
      diagnostics.signals[trace.kind] = (diagnostics.signals[trace.kind] ?? 0) + 1;
      if (diagnostics.anomalies.length < request.maxAnomalies) {
        diagnostics.anomalies.push({
          at,
          kind: trace.kind,
          event: trace.event,
          runId,
          conversationId: optional(trace.data.conversationId),
          clientMessageId: optional(trace.data.clientMessageId),
          status: optional(trace.data.status),
          code: optional(trace.data.code),
          reason: optional(trace.data.reason),
          terminalError: optional(trace.data.terminalError),
        });
      }
    });
    result.diagnostics = {
      ...diagnostics,
      runs: [...diagnostics.runs.values()],
      runsTruncated: diagnostics.omittedRunObservations > 0,
    };
    return result;
  } finally {
    connection.end();
  }
}

main()
  .then((result) => {
    if (request.includeEvents) {
      process.stdout.write(JSON.stringify({ recordType: "summary", feedback: result.feedback, diagnostics: result.diagnostics }) + "\n");
      return;
    }
    process.stdout.write(JSON.stringify(result));
  })
  .catch((error) => {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + "\\n");
    process.exitCode = 1;
  });
`;
}

export function buildRemoteCommand(options, environment = process.env) {
  const encoded = Buffer.from(buildRemoteProgram(options), "utf8").toString("base64");
  const appDirectory = environment.VESLO_PRODUCTION_APP_DIR?.trim() || DEFAULT_PRODUCTION_APP_DIR;
  const environmentFile = environment.VESLO_PRODUCTION_ENV_FILE?.trim() || DEFAULT_PRODUCTION_ENV_FILE;
  return `cd ${shellQuote(appDirectory)} && sudo -n docker compose -f packaging/owned-server/compose.yml --env-file ${shellQuote(environmentFile)} exec -T den node -e 'eval(Buffer.from("${encoded}", "base64").toString())'`;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

async function runRemoteReport(options, fullEventOutputPath = null) {
  const remoteCommand = buildRemoteCommand(options);
  const productionSshConfigured = [
    process.env.VESLO_PRODUCTION_SSH_HOST,
    process.env.VESLO_PRODUCTION_SSH_USER,
    process.env.VESLO_PRODUCTION_SSH_IDENTITY_FILE,
  ].every((value) => value?.trim());
  const child = spawn(
    productionSshConfigured ? process.execPath : "ssh",
    productionSshConfigured
      ? [productionSshScript, "--", remoteCommand]
      : [
          "-o",
          "BatchMode=yes",
          "-o",
          "StrictHostKeyChecking=yes",
          "-o",
          "ConnectTimeout=10",
          `${process.env.VESLO_PRODUCTION_SSH_USER?.trim() || DEFAULT_PRODUCTION_SSH_USER}@${process.env.VESLO_PRODUCTION_SSH_HOST?.trim() || DEFAULT_PRODUCTION_SSH_HOST}`,
          remoteCommand,
        ],
    {
    cwd: repositoryRoot,
    stdio: ["ignore", "pipe", "pipe"],
    },
  );
  const stdout = [];
  const stderr = [];
  let fullEventOutput = null;
  let fullEventOutputFinished = null;
  if (fullEventOutputPath) {
    await mkdir(dirname(fullEventOutputPath), { recursive: true });
    fullEventOutput = createWriteStream(fullEventOutputPath, { encoding: "utf8", flags: "wx" });
    fullEventOutputFinished = finished(fullEventOutput);
    child.stdout.pipe(fullEventOutput);
  } else {
    child.stdout.on("data", (chunk) => stdout.push(chunk));
  }
  child.stderr.on("data", (chunk) => stderr.push(chunk));
  try {
    const code = await new Promise((resolveCode, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolveCode(exitCode ?? (signal ? 1 : 0)));
    });
    if (fullEventOutputFinished) await fullEventOutputFinished;
    if (code !== 0) {
      throw new Error(Buffer.concat(stderr).toString("utf8").trim() || `Production report command exited with ${code}.`);
    }
    if (fullEventOutputPath) return null;
    try {
      return JSON.parse(Buffer.concat(stdout).toString("utf8"));
    } catch {
      throw new Error("Production report command returned invalid JSON.");
    }
  } finally {
    fullEventOutput?.destroy();
  }
}

export function formatReport(report, includeFeedbackText) {
  const lines = [
    `Feedback: ${report.feedback.id} (${report.feedback.status})`,
    `Submitted: ${report.feedback.submittedAt ?? "unknown"}`,
    `Screenshot: ${report.feedback.screenshotStatus ?? "unknown"}`,
  ];
  if (includeFeedbackText) {
    lines.push(`Title: ${report.feedback.title ?? ""}`, `Description: ${report.feedback.description ?? ""}`);
  } else {
    lines.push("Feedback text omitted; rerun with --include-feedback-text to display it.");
  }
  if (!report.diagnostics) {
    lines.push("Diagnostics: no diagnostic capture was attached.");
    return lines.join("\n");
  }
  const diagnostics = report.diagnostics;
  lines.push(
    `Diagnostics: ${diagnostics.eventCount} events, ${diagnostics.payloadBytes} bytes, ${diagnostics.firstEventAt ?? "unknown"} to ${diagnostics.lastEventAt ?? "unknown"}.`,
    `Sources: ${Object.entries(diagnostics.sources).map(([source, count]) => `${source}=${count}`).join(", ") || "none"}.`,
  );
  const signals = Object.entries(diagnostics.signals);
  lines.push(`Signals: ${signals.length ? signals.map(([kind, count]) => `${kind}=${count}`).join(", ") : "none"}.`);
  const runCounts = { completed: 0, failed: 0, aborted: 0, unresolved: 0, providerTimedOut: 0, submitError: 0 };
  for (const run of diagnostics.runs) {
    if (run.finalStatus === "completed") runCounts.completed += 1;
    else if (run.finalStatus === "failed") runCounts.failed += 1;
    else if (run.finalStatus === "aborted") runCounts.aborted += 1;
    else runCounts.unresolved += 1;
    if (run.providerTimedOut) runCounts.providerTimedOut += 1;
    if (run.submitError) runCounts.submitError += 1;
  }
  lines.push(
    `Runs: ${diagnostics.runs.length} tracked${diagnostics.runsTruncated ? ` (${diagnostics.omittedRunObservations} further observations omitted)` : ""}; completed=${runCounts.completed}, failed=${runCounts.failed}, aborted=${runCounts.aborted}, unresolved=${runCounts.unresolved}, provider timeouts=${runCounts.providerTimedOut}, submit errors=${runCounts.submitError}.`,
  );
  if (diagnostics.anomalies.length) {
    lines.push("Anomalies:");
    for (const anomaly of diagnostics.anomalies) {
      lines.push(`- ${anomaly.at} ${anomaly.kind}: ${anomaly.event}${anomaly.status ? ` (${anomaly.status})` : ""}${anomaly.code ? ` [${anomaly.code}]` : ""}${anomaly.terminalError ? ` - ${anomaly.terminalError}` : ""}`);
    }
  }
  return lines.join("\n");
}

export async function writeReportOutput(outputPath, content) {
  const resolvedPath = resolve(outputPath);
  await mkdir(dirname(resolvedPath), { recursive: true });
  await writeFile(resolvedPath, content, { encoding: "utf8", flag: "wx" });
  return resolvedPath;
}

export function feedbackDiagnosticArtifactName(options, now = new Date(), suffix = randomUUID().slice(0, 8)) {
  const feedbackName = (options.feedbackId ?? "latest").replace(/[^A-Za-z0-9_-]/g, "_");
  const timestamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  const extension = options.includeEvents ? "ndjson" : options.json ? "json" : "txt";
  const kind = options.includeEvents ? "events" : "summary";
  return `feedback-diagnostics-${feedbackName}-${timestamp}-${suffix}-${kind}.${extension}`;
}

function automaticOutputPath(outputDirectory, options) {
  const directory = resolve(outputDirectory);
  return resolve(directory, feedbackDiagnosticArtifactName(options));
}

function temporaryOutputPath(outputPath) {
  return `${outputPath}.partial-${process.pid}-${randomUUID()}`;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (options.includeEvents && !options.outputPath && !options.outputDirectory) {
    throw new Error("--include-events requires --output or --output-dir so full diagnostics are never printed to the terminal.");
  }
  loadDotEnv({ cwd: repositoryRoot });
  if (options.includeEvents) {
    const resolvedPath = options.outputDirectory
      ? automaticOutputPath(options.outputDirectory, options)
      : resolve(options.outputPath);
    await mkdir(dirname(resolvedPath), { recursive: true });
    const temporaryPath = temporaryOutputPath(resolvedPath);
    try {
      await runRemoteReport(options, temporaryPath);
      await copyFile(temporaryPath, resolvedPath, fsConstants.COPYFILE_EXCL);
    } catch (error) {
      await rm(temporaryPath, { force: true });
      throw error;
    }
    await rm(temporaryPath, { force: true });
    process.stdout.write(`Full feedback diagnostic event log saved to ${resolvedPath}\n`);
    return;
  }
  const report = await runRemoteReport(options);
  const output = options.json ? `${JSON.stringify(report, null, 2)}\n` : `${formatReport(report, options.includeFeedbackText)}\n`;
  if (options.outputPath || options.outputDirectory) {
    const outputPath = options.outputDirectory
      ? automaticOutputPath(options.outputDirectory, options)
      : await writeReportOutput(options.outputPath, output);
    if (options.outputDirectory) await writeReportOutput(outputPath, output);
    process.stdout.write(`Feedback diagnostic report saved to ${outputPath}\n`);
    return;
  }
  process.stdout.write(output);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
