import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CLOUD_LOG_INGEST_URL = "https://api.veslo.work/v1/internal/debug-logs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const traceMirrorDir = resolve(repoRoot, ".tmp");
const traceMirrorFile = resolve(traceMirrorDir, "send-workflow-trace.cloud.ndjson");
const deriveTraceChannelFile = (basePath, channel) =>
  basePath.toLowerCase().endsWith(".ndjson")
    ? `${basePath.slice(0, -".ndjson".length)}.${channel}.ndjson`
    : `${basePath}.${channel}`;
const traceMirrorUploads = [
  { path: traceMirrorFile, kind: "send-workflow-trace" },
  { path: deriveTraceChannelFile(traceMirrorFile, "ui"), kind: "send-workflow-trace-ui" },
  { path: deriveTraceChannelFile(traceMirrorFile, "server"), kind: "send-workflow-trace-server" },
  { path: deriveTraceChannelFile(traceMirrorFile, "orchestrator"), kind: "send-workflow-trace-orchestrator" },
];
const diagnosticDumpUploadScript = resolve(repoRoot, "scripts", "upload-diagnostic-dump.mjs");
mkdirSync(traceMirrorDir, { recursive: true });

const resolvePnpmInvocation = () => {
  if (process.platform === "win32") {
    const corepackPnpm = resolve(dirname(process.execPath), "node_modules", "corepack", "dist", "pnpm.js");
    if (existsSync(corepackPnpm)) {
      return { command: process.execPath, prefixArgs: [corepackPnpm] };
    }
    return { command: "cmd.exe", prefixArgs: ["/d", "/s", "/c", "pnpm.cmd"] };
  }
  return { command: "pnpm", prefixArgs: [] };
};

const pnpm = resolvePnpmInvocation();

const withDefaultEnv = (defaults, base = process.env) => {
  const env = { ...base };
  for (const [name, value] of Object.entries(defaults)) {
    if (!env[name]?.trim()) env[name] = value;
  }
  return env;
};

const readOptionalCloudLogIngestToken = () =>
  process.env.VESLO_LOG_INGEST_TOKEN?.trim() || process.env.DEN_LOG_INGEST_TOKEN?.trim() || "";

const cloudLogIngestToken = readOptionalCloudLogIngestToken();

const responseExcerpt = async (response) => {
  const text = await response.text().catch(() => "");
  return text.trim().slice(0, 500);
};

const runCloudLogIngestPreflight = async (token) => {
  const batchId = `dev-force-sidecars-cloud-logs-preflight-${randomUUID()}`;
  const body = {
    batchId,
    events: [
      {
        id: randomUUID(),
        userId: "",
        orgId: "",
        workspaceId: "",
        source: "dev-with-force-sidecars-cloud-logs",
        stream: "preflight",
        level: "info",
        timestamp: Date.now() * 1_000_000,
        sequenceNo: 0,
        payload: {
          eventType: "cloud-log-ingest:preflight",
          target: CLOUD_LOG_INGEST_URL,
        },
      },
    ],
  };

  const response = await fetch(CLOUD_LOG_INGEST_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
      "Idempotency-Key": batchId,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });

  if (!response.ok) {
    throw new Error(`cloud log ingest preflight failed: HTTP ${response.status} ${await responseExcerpt(response)}`);
  }

  const parsed = await response.json().catch(() => null);
  if (!parsed?.acceptedBatchIds?.includes(batchId)) {
    throw new Error("cloud log ingest preflight was not confirmed by acceptedBatchIds");
  }

  console.log(`[dev-with-force-sidecars-cloud-logs] cloud debug-log ingest preflight accepted: ${batchId}`);
};

const runtimeLoggingEnv = withDefaultEnv({
  VESLO_TAURI_PILOT: "1",
  VESLO_E2E: "1",
  VESLO_RUNTIME_DIAGNOSTICS: "1",
  VITE_VESLO_RUNTIME_DIAGNOSTICS: "1",
  VESLO_RUNTIME_TRACE: "1",
  VESLO_SEND_WORKFLOW_TRACE: "1",
  VESLO_SEND_WORKFLOW_TRACE_MIRROR_FILE: traceMirrorFile,
  VESLO_SEND_WORKFLOW_TRACE_CONSOLE: "1",
  VITE_VESLO_SEND_WORKFLOW_TRACE: "1",
  VITE_VESLO_SESSION_UI_MUTATION_TRACE: "1",
  VESLO_OPENCODE_HEALTH_DIAG: "1",
  VESLO_LOG_FLUSH_INTERVAL_MS: "1000",
  RUST_BACKTRACE: "1",
});

if (cloudLogIngestToken) {
  runtimeLoggingEnv.VESLO_LOG_INGEST_URL = CLOUD_LOG_INGEST_URL;
  runtimeLoggingEnv.VESLO_LOG_INGEST_TOKEN = cloudLogIngestToken;
}

const runProcess = (command, args, env = process.env) => {
  const result = spawnSync(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });

  if (result.error) {
    console.error(result.error.message);
  }

  return result.status ?? (result.error ? 1 : result.signal ? 1 : 0);
};

const runPnpm = (args, env = process.env) => runProcess(pnpm.command, [...pnpm.prefixArgs, ...args], env);

const requireSuccess = (status) => {
  if (status !== 0) {
    process.exit(status || 1);
  }
};

const runDiagnosticDumpAuthPreflight = () => {
  console.log("[dev-with-force-sidecars-cloud-logs] checking diagnostic dump upload auth");
  const status = runProcess(process.execPath, [diagnosticDumpUploadScript, "--check-auth"]);
  if (status !== 0) {
    console.warn(
      [
        "[dev-with-force-sidecars-cloud-logs] diagnostic dump auth is not ready before launch; continuing.",
        "[dev-with-force-sidecars-cloud-logs] On macOS the desktop runtime may need to start once to migrate/create ~/.veslo/den-auth.json.",
        "[dev-with-force-sidecars-cloud-logs] Sign in inside Veslo if needed; the final trace upload will retry after dev exits.",
      ].join("\n"),
    );
  }
};

const uploadTraceMirrors = () => {
  let uploadStatus = 0;
  let uploaded = 0;

  for (const traceMirror of traceMirrorUploads) {
    if (!existsSync(traceMirror.path)) {
      continue;
    }

    const traceStat = statSync(traceMirror.path);
    if (traceStat.size <= 0) {
      console.log(`[dev-with-force-sidecars-cloud-logs] trace mirror is empty, skipping upload: ${traceMirror.path}`);
      continue;
    }

    uploaded++;
    console.log(`[dev-with-force-sidecars-cloud-logs] uploading trace mirror: ${traceMirror.path}`);
    const status = runProcess(
      process.execPath,
      [diagnosticDumpUploadScript, traceMirror.path],
      withDefaultEnv({
        VESLO_DIAGNOSTIC_DUMP_SOURCE: "dev-with-force-sidecars-cloud-logs",
        VESLO_DIAGNOSTIC_DUMP_KIND: traceMirror.kind,
      }),
    );
    uploadStatus ||= status;
  }

  if (uploaded === 0) {
    console.log(`[dev-with-force-sidecars-cloud-logs] no trace mirror files to upload under: ${traceMirrorDir}`);
  }

  return uploadStatus;
};

runDiagnosticDumpAuthPreflight();

if (cloudLogIngestToken) {
  try {
    await runCloudLogIngestPreflight(cloudLogIngestToken);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[dev-with-force-sidecars-cloud-logs] ${message}`);
    process.exit(1);
  }
} else {
  console.log(
    "[dev-with-force-sidecars-cloud-logs] no internal ingest token; live internal debug-log upload is disabled, final trace dump upload remains enabled via desktop login",
  );
}

requireSuccess(runPnpm(["-C", "packages/desktop", "prepare:sidecar", "--", "--force"]));
const devStatus = runPnpm(["dev", ...process.argv.slice(2)], runtimeLoggingEnv);
const uploadStatus = uploadTraceMirrors();
process.exit(devStatus || uploadStatus || 0);
