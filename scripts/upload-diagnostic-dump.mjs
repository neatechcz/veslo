import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

const DEFAULT_DESKTOP_DUMP_PATH = "/v1/desktop-diagnostic-dumps";
const DEFAULT_INTERNAL_DUMP_URL = "https://api.veslo.work/v1/internal/diagnostic-dumps";
const DEFAULT_SNAPSHOT_PATH = resolve(homedir(), ".veslo", "den-auth.json");
const VALID_AUTH_MODES = new Set(["auto", "desktop", "internal"]);

const args = process.argv.slice(2);
const checkAuthOnly = args.includes("--check-auth");
const showHelp = args.includes("--help") || args.includes("-h");
const inputPath = args.find((arg) => !arg.startsWith("--"))?.trim() ?? "";

if (showHelp || (!checkAuthOnly && !inputPath)) {
  console.error(
    [
      "Usage: node scripts/upload-diagnostic-dump.mjs <path-to-dump>",
      "       node scripts/upload-diagnostic-dump.mjs --check-auth",
      "",
      "Default auth mode is auto: use the current Veslo desktop login from ~/.veslo/den-auth.json.",
      "Internal server-to-server upload is still available with VESLO_DIAGNOSTIC_DUMP_AUTH_MODE=internal",
      "and VESLO_LOG_INGEST_TOKEN or DEN_LOG_INGEST_TOKEN.",
      "Set VESLO_DIAGNOSTIC_DUMP_VERIFY_AUTH=0 to skip the --check-auth /v1/me network check.",
    ].join("\n"),
  );
  process.exit(showHelp ? 0 : 1);
}

const source = process.env.VESLO_DIAGNOSTIC_DUMP_SOURCE?.trim() || "dev-helper";
const kind = process.env.VESLO_DIAGNOSTIC_DUMP_KIND?.trim() || "send-workflow-trace";
const workspaceId = process.env.VESLO_DIAGNOSTIC_DUMP_WORKSPACE_ID?.trim() || "";
const keepCompressed = process.env.VESLO_KEEP_DIAGNOSTIC_DUMP_UPLOAD?.trim() === "1";
const compressedDir = resolve(".tmp", "diagnostic-dumps");

const textOrNull = (value) => (typeof value === "string" && value.trim() ? value.trim() : null);

const normalizeHttpBase = (value) => {
  const trimmed = textOrNull(value);
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    if (!parsed.hostname) return null;
    parsed.hash = "";
    parsed.search = "";
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol}//${parsed.host}${pathname === "/" ? "" : pathname}`;
  } catch {
    return null;
  }
};

const parseDesktopAuthState = (candidate) => {
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return null;
  }

  const denApiBase = normalizeHttpBase(candidate.denApiBase);
  const token = textOrNull(candidate.token);
  const orgId = textOrNull(candidate.orgId) || textOrNull(candidate.org?.id);
  const userId = textOrNull(candidate.user?.id);

  if (!denApiBase || !token || !orgId) {
    return null;
  }

  return {
    denApiBase,
    token,
    orgId,
    userId,
  };
};

const readDesktopAuthSnapshot = async () => {
  const snapshotPath = process.env.VESLO_DEN_AUTH_SNAPSHOT_PATH?.trim() || DEFAULT_SNAPSHOT_PATH;
  let payload = "";
  try {
    payload = await readFile(snapshotPath, "utf8");
  } catch {
    return { auth: null, snapshotPath, reason: "snapshot file not found" };
  }

  let snapshot;
  try {
    snapshot = JSON.parse(payload);
  } catch {
    return { auth: null, snapshotPath, reason: "snapshot file is not valid JSON" };
  }

  const authJson = textOrNull(snapshot?.authJson) || textOrNull(snapshot?.auth_json);
  if (!authJson) {
    return { auth: null, snapshotPath, reason: "snapshot does not contain signed-in auth" };
  }

  let authCandidate;
  try {
    authCandidate = JSON.parse(authJson);
  } catch {
    return { auth: null, snapshotPath, reason: "snapshot authJson is not valid JSON" };
  }

  const auth = parseDesktopAuthState(authCandidate);
  if (!auth) {
    return { auth: null, snapshotPath, reason: "snapshot auth is incomplete" };
  }

  return { auth, snapshotPath, reason: null };
};

const readInternalToken = () =>
  process.env.VESLO_LOG_INGEST_TOKEN?.trim() || process.env.DEN_LOG_INGEST_TOKEN?.trim() || "";

const readAuthMode = () => {
  const mode = (process.env.VESLO_DIAGNOSTIC_DUMP_AUTH_MODE?.trim() || "auto").toLowerCase();
  if (!VALID_AUTH_MODES.has(mode)) {
    throw new Error(`Invalid VESLO_DIAGNOSTIC_DUMP_AUTH_MODE "${mode}". Expected auto, desktop, or internal.`);
  }
  return mode;
};

const resolveUploadTarget = async () => {
  const mode = readAuthMode();
  const snapshot = mode !== "internal" ? await readDesktopAuthSnapshot() : { auth: null, snapshotPath: DEFAULT_SNAPSHOT_PATH, reason: "desktop auth skipped" };
  const internalToken = mode !== "desktop" ? readInternalToken() : "";

  if (mode !== "internal" && snapshot.auth) {
    const defaultUrl = `${snapshot.auth.denApiBase}${DEFAULT_DESKTOP_DUMP_PATH}`;
    return {
      authMode: "desktop",
      denApiBase: snapshot.auth.denApiBase,
      dumpUrl: process.env.VESLO_DIAGNOSTIC_DUMP_URL?.trim() || defaultUrl,
      token: snapshot.auth.token,
      orgId: snapshot.auth.orgId,
      userId: snapshot.auth.userId,
      snapshotPath: snapshot.snapshotPath,
    };
  }

  if (mode !== "desktop" && internalToken) {
    return {
      authMode: "internal",
      denApiBase: "",
      dumpUrl: process.env.VESLO_DIAGNOSTIC_DUMP_URL?.trim() || DEFAULT_INTERNAL_DUMP_URL,
      token: internalToken,
      orgId: "",
      userId: "",
      snapshotPath: "",
    };
  }

  if (mode === "desktop") {
    throw new Error(
      [
        "Missing Veslo desktop login for diagnostic dump upload.",
        `Expected snapshot: ${snapshot.snapshotPath}`,
        `Reason: ${snapshot.reason}`,
        "Open Veslo, sign in to Den once, then run this command again.",
      ].join("\n"),
    );
  }

  if (mode === "internal") {
    throw new Error("Missing VESLO_LOG_INGEST_TOKEN or DEN_LOG_INGEST_TOKEN for internal diagnostic dump upload.");
  }

  throw new Error(
    [
      "No diagnostic dump upload auth is available.",
      `Desktop snapshot: ${snapshot.snapshotPath}`,
      `Desktop snapshot reason: ${snapshot.reason}`,
      "Preferred fix: open Veslo and sign in to Den once.",
      "Operator fallback: set VESLO_DIAGNOSTIC_DUMP_AUTH_MODE=internal plus VESLO_LOG_INGEST_TOKEN.",
    ].join("\n"),
  );
};

const sha256File = async (path) => {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};

const printTarget = (target) => {
  const suffix = target.authMode === "desktop"
    ? `org=${target.orgId}${target.userId ? ` user=${target.userId}` : ""} snapshot=${target.snapshotPath}`
    : "internal-token";
  console.log(`[upload-diagnostic-dump] auth=${target.authMode} target=${target.dumpUrl} ${suffix}`);
};

const verifyTargetAuth = async (target) => {
  if (target.authMode !== "desktop") {
    return;
  }
  if (process.env.VESLO_DIAGNOSTIC_DUMP_VERIFY_AUTH?.trim() === "0") {
    return;
  }

  const response = await fetch(`${target.denApiBase}/v1/me`, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${target.token}`,
    },
    signal: AbortSignal.timeout(8_000),
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`desktop Den login is not accepted by ${target.denApiBase}/v1/me: HTTP ${response.status} ${text.trim().slice(0, 300)}`);
  }

  if (!target.userId) {
    return;
  }

  const payload = JSON.parse(text || "{}");
  const serverUserId = typeof payload?.user?.id === "string" ? payload.user.id.trim() : "";
  if (serverUserId && serverUserId !== target.userId) {
    throw new Error("desktop Den login user mismatch between local snapshot and /v1/me");
  }
};

let target;
try {
  target = await resolveUploadTarget();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[upload-diagnostic-dump] ${message}`);
  process.exit(1);
}

if (checkAuthOnly) {
  try {
    await verifyTargetAuth(target);
    printTarget(target);
    process.exit(0);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[upload-diagnostic-dump] ${message}`);
    process.exit(1);
  }
}

const resolvedInputPath = resolve(inputPath);
const inputName = basename(resolvedInputPath);
const compressedPath = resolve(compressedDir, `${inputName}.${Date.now()}.gz`);

await stat(resolvedInputPath);
await mkdir(compressedDir, { recursive: true });
await pipeline(createReadStream(resolvedInputPath), createGzip({ level: 6 }), createWriteStream(compressedPath, { flags: "wx" }));

const [compressedStat, uncompressedStat, compressedSha256] = await Promise.all([
  stat(compressedPath),
  stat(resolvedInputPath),
  sha256File(compressedPath),
]);

try {
  const headers = {
    Authorization: `Bearer ${target.token}`,
    "Content-Type": "application/x-ndjson",
    "Content-Encoding": "gzip",
    "Content-Length": String(compressedStat.size),
    "x-veslo-dump-kind": kind,
    "x-veslo-dump-source": source,
    "x-veslo-dump-filename": `${inputName}.gz`,
    "x-veslo-dump-sha256": compressedSha256,
    "x-veslo-dump-uncompressed-bytes": String(uncompressedStat.size),
  };

  if (target.authMode === "desktop") {
    headers["x-veslo-org-id"] = target.orgId;
  }
  if (workspaceId) {
    headers["x-veslo-dump-workspace-id"] = workspaceId;
  }

  const response = await fetch(target.dumpUrl, {
    method: "POST",
    headers,
    body: createReadStream(compressedPath),
    duplex: "half",
  });

  const text = await response.text();
  if (!response.ok) {
    throw new Error(`diagnostic dump upload failed: HTTP ${response.status} ${text.trim().slice(0, 500)}`);
  }

  printTarget(target);
  console.log(text);
} finally {
  if (!keepCompressed) {
    await rm(compressedPath, { force: true }).catch(() => undefined);
  }
}
