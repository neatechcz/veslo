import { mkdir, readFile, writeFile, rm, readdir, realpath, rename, stat } from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type {
  ApprovalRequest,
  Capabilities,
  ServerConfig,
  WorkspaceInfo,
  Actor,
  ReloadReason,
  ReloadTrigger,
  TokenScope,
  SandboxBackend,
  ResourceOwner,
  WorkspaceSkillConflict,
  WorkspaceSkillMaterialization,
  DisabledSkillTarget,
} from "./types.js";
import { ApprovalService } from "./approvals.js";
import { addPlugin, listPlugins, normalizePluginSpec, removePlugin } from "./plugins.js";
import { addMcp, installHubMcp, listMcp, removeMcp } from "./mcp.js";
import {
  deleteGlobalSkillRecoverable,
  deleteSkillAtPathRecoverable,
  deleteSkillRecoverable,
  disabledRecordMatchesSkill,
  listSkills,
  readGlobalSkillAtPath,
  readSkillAtPath,
  updateSkillAtPath,
  upsertSkill,
  userGlobalSkillRootsForMutation,
  workspaceSkillRootsForMutation,
} from "./skills.js";
import { installHubSkill } from "./skill-hub.js";
import {
  listSkillRemovals,
  readSkillRemovalRecord,
  restoreSkillRemoval,
  type SkillRemovalRecord,
  type SkillRemovalScope,
} from "./skill-removal-journal.js";
import {
  listDisabledSkills,
  setSkillEnabledState,
} from "./skill-enabled-overrides.js";
import { createOrgMcpRuntimeToken, fetchOrgMcpCatalog, fetchOrgSkillsCatalog } from "./den-catalog.js";
import {
  getOrganizationSoul,
  getSoulVersion,
  getUserSoul,
  listSoulVersions,
  restoreSoulVersion as restoreDenSoulVersion,
  updateOrganizationSoul,
  updateUserSoul,
} from "./soul-den-client.js";
import {
  cacheSoulDocument,
  listPendingSoulEdits,
  readCachedSoulDocument,
  soulCachePath,
  soulPendingCacheDir,
  writePendingSoulEdit,
  type SoulPendingEdit,
} from "./soul-cache.js";
import {
  createSoulVersion,
  currentSoulVersion,
  restoreSoulVersion as restoreLocalSoulVersion,
  type SoulDocument,
  type SoulScope,
  type SoulVersion,
} from "./soul-memory.js";
import {
  materializeEffectiveSoul,
  readSoulMaterializationStatus,
  type SoulMaterializationResult,
} from "./soul-materializer.js";
import {
  createRegistrySkill,
  createRegistrySkillInstallation,
  createRegistrySkillRolloutPolicy,
  createRegistrySkillReviewRequest,
  createRegistrySkillVersion,
  approveRegistrySkillReviewRequest,
  deleteRegistrySkillInstallation,
  deleteRegistrySkillRolloutPolicy,
  downloadSkillPackageFromRegistry,
  getWorkspaceSkillSetFromRegistry,
  listRegistrySkillEvents,
  listRegistrySkillInstallations,
  listRegistrySkillRolloutPolicies,
  listRegistrySkillVersions,
  rejectRegistrySkillReviewRequest,
  replaceRegistryWorkspaceSkillSet,
  restoreRegistrySkillInstallation,
  searchRegistrySkills,
  updateRegistrySkillRolloutPolicy,
  updateRegistrySkillInstallation,
} from "./skill-registry-client.js";
import {
  materializeWorkspaceSkillSet,
  materializePersonalGlobalSkillSet,
  personalGlobalManagedSkillsRoot,
  readSkillMaterializationManifest,
  workspaceManagedSkillsRoot,
} from "./skill-materializer.js";
import { getPlatformManagedPersonalGlobalSkillSet } from "./platform-managed-skills.js";
import type { SkillSetMaterializationResult } from "./skill-materializer.js";
import {
  deleteUserGlobalSkill,
  listUserGlobalSkills,
  materializeUserGlobalSkillsForWorkspace,
  readUserGlobalSkill,
  upsertUserGlobalSkill,
  userGlobalMaterializedSkillsRoot,
  userGlobalSkillStorePath,
} from "./user-skill-store.js";
import type {
  RegistrySkillPackageArchive,
  RegistrySkillRolloutPolicy,
  RegistrySkillRolloutPolicyAudience,
  RegistrySkillRolloutPolicyCatalogScope,
  RegistrySkillRolloutPolicyRemovalPolicy,
  RegistrySkillRolloutPolicyTarget,
  RegistrySkillRolloutPolicyUpdatePolicy,
} from "./skill-registry-types.js";
import type { SkillPackageArchive } from "./skill-packages.js";
import { resolveSkillMatch } from "./skill-resolver.js";
import { resolveWorkspaceSkillSet } from "./workspace-skill-set.js";
import type { WorkspaceSkillRegistryInstallation, WorkspaceSkillRolloutPolicy } from "./workspace-skill-set.js";
import { writeWorkspaceSkillLockfile } from "./workspace-skill-lockfile.js";
import { deleteCommand, listCommands, upsertCommand } from "./commands.js";
import { localUserResourceOwner, organizationResourceOwner, workspaceResourceOwner } from "./resource-owner.js";
import { deleteScheduledJob, listScheduledJobs, resolveScheduledJob } from "./scheduler.js";
import { provisionWorkspaceInternalSystem, resolveVesloAppDataDir } from "./internal-system.js";
import { ApiError, formatError } from "./errors.js";
import { readJsoncFile, updateJsoncTopLevel, writeJsoncFile } from "./jsonc.js";
import { recordAudit, readAuditEntries, readLastAudit, resolveVesloDataDir, setAuditDebugLogPipeline } from "./audit.js";
import { createDebugLogPipeline, type DebugLogPipeline } from "./debug-log-pipeline.js";
import { validateDebugLogBatch } from "./debug-log-events.js";
import { ReloadEventStore } from "./events.js";
import { parseFrontmatter } from "./frontmatter.js";
import { opencodeConfigPath, vesloConfigPath, projectCommandsDir, projectSkillsDir } from "./workspace-files.js";
import { ensureDir, exists, hashToken, shortId } from "./utils.js";
import { persistServerWorkspaceState, workspaceIdForPath } from "./workspaces.js";
import { sanitizeCommandName, validateMcpName } from "./validators.js";
import { TokenService } from "./tokens.js";
import { TOY_UI_CSS, TOY_UI_HTML, TOY_UI_JS, cssResponse, htmlResponse, jsResponse } from "./toy-ui.js";
import { FileSessionStore } from "./file-sessions.js";
import { createSessionArchiveStore } from "./session-archives.js";
import { deriveLatestRunArtifactsResponse, type SessionArtifactMessage, type SessionArtifactPart } from "./session-artifacts.js";
import { createSessionTranscriptPrefetchStore } from "./session-transcript-prefetch.js";
import {
  type AutomationExecutionInput,
  type AutomationExecutionResult,
  type AutomationRunner,
  createAutomationRunner,
} from "./automation-runner.js";
import {
  type AutomationRun,
  type AutomationSchedule,
  type AutomationStatus,
  type AutomationTarget,
  type VesloAutomation,
  computeNextAutomationRunAt,
  parseAutomationSchedule,
  parseAutomationStatus,
} from "./automations.js";
import {
  mutateAutomationStore,
  readAutomationStore,
  resolveAutomationsPath,
} from "./automation-store.js";
import { createConversationReadStore } from "./conversation-read-store.js";
import { createConversationBindingStore } from "./conversation-binding-store.js";
import { createConversationTranscriptStore } from "./conversation-transcript-store.js";
import { createConversationService } from "./conversation-service.js";
import {
  createConversationRunQueueStore,
  type ConversationRunQueueItem,
} from "./conversation-run-queue-store.js";
import {
  createOrchestratorLifecycleClient,
  type LifecycleRunStatus,
  type OrchestratorLifecycleClient,
  OrchestratorLifecycleRequestError,
  RunAlreadyActiveError,
} from "./orchestrator-lifecycle-client.js";
import pkg from "../package.json" with { type: "json" };

const SERVER_VERSION = pkg.version;

const FILE_SESSION_DEFAULT_TTL_MS = 15 * 60 * 1000;
const FILE_SESSION_MIN_TTL_MS = 30 * 1000;
const FILE_SESSION_MAX_TTL_MS = 24 * 60 * 60 * 1000;
const FILE_SESSION_MAX_BATCH_ITEMS = 64;
const FILE_SESSION_MAX_FILE_BYTES = 5_000_000;
const DEFAULT_JSON_BODY_MAX_BYTES = 1024 * 1024;
const FILE_SESSION_WRITE_BODY_MAX_BYTES = Math.ceil(FILE_SESSION_MAX_FILE_BYTES * 4 / 3) + 1024 * 1024;
const WORKSPACE_FILE_CONTENT_BODY_MAX_BYTES = FILE_SESSION_MAX_FILE_BYTES + 256 * 1024;
const FILE_SESSION_CATALOG_DEFAULT_LIMIT = 2000;
const FILE_SESSION_CATALOG_MAX_LIMIT = 10000;
const SESSION_TRANSCRIPT_DEFAULT_LIMIT = 140;
const SESSION_TRANSCRIPT_MAX_LIMIT = 200;
const SKILL_BATCH_REMOVE_MAX_ITEMS = 50;
const AI_GATEWAY_DEFAULT_PORT = 4034;
const AI_GATEWAY_UPSTREAM_RESPONSE_SNIPPET_MAX = 1000;
const OPENCODE_JSON_DEFAULT_RESPONSE_MAX_BYTES = 1024 * 1024;
const OPENCODE_TRANSCRIPT_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const OPENCODE_JSON_FETCH_DEFAULT_TIMEOUT_MS = 5_000;
const OPENCODE_SESSION_CREATE_TIMEOUT_MS = 60_000;
const OPENCODE_CONVERSATION_SUBMIT_TIMEOUT_MS = 30_000;
// Send-timeout fix 2026-06-10 — upper bound for the proxy's wait on upstream
// response HEADERS (body streaming, e.g. SSE, is never cut). Must stay above
// the orchestrator's 60s cold OpenCode health window so a legitimate POST that
// cold-spawns the engine is not aborted mid-spawn.
const OPENCODE_PROXY_HEADERS_DEFAULT_TIMEOUT_MS = 75_000;
const AI_GATEWAY_PROXY_HEADERS_DEFAULT_TIMEOUT_MS = 45_000;
const AI_GATEWAY_PROVIDER_START_DEFAULT_TIMEOUT_MS = 30_000;
const AI_GATEWAY_SESSION_HIT_TTL_MS = 5 * 60 * 1000;
const AI_GATEWAY_ACTIVE_RUN_TTL_MS = 10 * 60 * 1000;
const AUTOMATION_OPENCODE_REQUEST_TIMEOUT_MS = 30_000;
export const REDACTED_SECRET_VALUE = "[REDACTED]";
const GATEWAY_CALLER_AUTH_HEADER = "x-veslo-gateway-authorization";
const GATEWAY_ACCESS_TOKEN_HEADER = "x-veslo-gateway-token";
const GATEWAY_SESSION_ID_HEADER = "x-veslo-session-id";
const GATEWAY_WORKSPACE_ID_HEADER = "x-veslo-workspace-id";
const AI_GATEWAY_MODEL_DIAGNOSTIC_MAX_REQUEST_BYTES = 64 * 1024;
const AI_GATEWAY_JSON_REDACTION_MAX_RESPONSE_BYTES = 64 * 1024;
const AI_GATEWAY_ERROR_DIAGNOSTIC_MAX_RESPONSE_BYTES = 64 * 1024;

const REDACTED_CONFIG_KEYS = [
  "password",
  "token",
  "secret",
  "apikey",
  "accesskey",
  "privatekey",
  "authorization",
];

type LogLevel = "info" | "warn" | "error";

type LogAttributes = Record<string, unknown>;

const SEND_WORKFLOW_TRACE_SCHEMA = "send-workflow/v1";

function truthyEnv(name: string): boolean {
  const value = process.env[name]?.trim().toLowerCase() ?? "";
  return value === "1" || value === "true" || value === "yes" || value === "on";
}

function resolveSendWorkflowTraceFile(): string {
  const override = process.env.VESLO_SEND_WORKFLOW_TRACE_FILE?.trim();
  if (override) return override;
  const pilotDir = process.env.TAURI_PILOT_LOG_DIR?.trim();
  if (pilotDir) return join(pilotDir, "send-workflow-trace.ndjson");
  const runtimeTraceFile = process.env.VESLO_RUNTIME_TRACE_FILE?.trim();
  if (runtimeTraceFile) return join(dirname(runtimeTraceFile), "send-workflow-trace.ndjson");
  return join(resolveVesloDataDir(), "send-workflow-trace.ndjson");
}

function sendWorkflowTraceEnabled(): boolean {
  return truthyEnv("VESLO_SEND_WORKFLOW_TRACE") || Boolean(process.env.VESLO_SEND_WORKFLOW_TRACE_FILE?.trim());
}

function recordSendWorkflowTrace(
  source: string,
  event: string,
  payload: Record<string, unknown> = {},
): void {
  if (!sendWorkflowTraceEnabled()) return;
  const entry = {
    schema: SEND_WORKFLOW_TRACE_SCHEMA,
    at: new Date().toISOString(),
    ts: Date.now(),
    source,
    event,
    processPid: process.pid,
    processRunId: process.env.VESLO_RUN_ID?.trim() || null,
    ...payload,
  };
  try {
    const file = resolveSendWorkflowTraceFile();
    mkdirSync(dirname(file), { recursive: true });
    appendFileSync(file, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Diagnostics must never affect runtime behavior.
  }
  if (truthyEnv("VESLO_SEND_WORKFLOW_TRACE_CONSOLE")) {
    try {
      console.log(`[veslo:send-workflow] ${event} ${JSON.stringify(entry)}`);
    } catch {
      console.log(`[veslo:send-workflow] ${event}`);
    }
  }
}

type ServerLogger = {
  log: (level: LogLevel, message: string, attributes?: LogAttributes) => void;
};

type SoulMaterializationTestHookInput = {
  workspaceId: string;
  overrides: Partial<Record<SoulScope, SoulDocument | null>>;
};

let soulMaterializationTestHookForTests: ((input: SoulMaterializationTestHookInput) => Promise<void>) | null = null;
const soulMaterializationLocks = new Map<string, Promise<void>>();

export function setSoulMaterializationTestHookForTests(
  hook: ((input: SoulMaterializationTestHookInput) => Promise<void>) | null,
): void {
  soulMaterializationTestHookForTests = hook;
}

async function withSoulMaterializationLock<T>(workspaceId: string, run: () => Promise<T>): Promise<T> {
  const previous = soulMaterializationLocks.get(workspaceId)?.catch(() => undefined) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    releaseCurrent = resolveCurrent;
  });
  const queued = previous.then(() => current);
  soulMaterializationLocks.set(workspaceId, queued);
  await previous;
  try {
    return await run();
  } finally {
    releaseCurrent();
    if (soulMaterializationLocks.get(workspaceId) === queued) {
      soulMaterializationLocks.delete(workspaceId);
    }
  }
}

function normalizeConfigKey(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function isSensitiveConfigKey(key: string): boolean {
  const normalized = normalizeConfigKey(key);
  if (!normalized) return false;
  if (normalized === "tokensource") return false;
  // VSLO-86 — x-veslo-gateway-token must round-trip in clear so the frontend
  // can re-patch opencode.jsonc on disk with a valid token. Without this
  // exception, getConfig returned "[REDACTED]", the patch effect echoed the
  // literal back, and engines later sent "[REDACTED]" as the Den gateway
  // header → AI gateway 401. The same header lives in the allow-list on the
  // client (GATEWAY_PROVIDER_ALLOWED_HEADER_KEYS); keep both in sync.
  if (normalized === "xveslogatewaytoken") return false;
  return REDACTED_CONFIG_KEYS.some((segment) => normalized === segment || normalized.endsWith(segment));
}

export function redactSensitiveConfig<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => redactSensitiveConfig(item)) as T;
  }
  if (!value || typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};
  for (const [key, rawValue] of Object.entries(input)) {
    if (isSensitiveConfigKey(key)) {
      output[key] = rawValue === null || rawValue === undefined || rawValue === ""
        ? rawValue
        : REDACTED_SECRET_VALUE;
      continue;
    }
    output[key] = redactSensitiveConfig(rawValue);
  }
  return output as T;
}

function redactAiAccessBundleForClient<T>(value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return redactSensitiveConfig(value);
  }

  const input = value as Record<string, unknown>;
  const output = redactSensitiveConfig(input) as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(input, "accessToken")) {
    output.accessToken = input.accessToken;
  }
  return output as T;
}

const LOG_LEVEL_NUMBERS: Record<LogLevel, number> = {
  info: 9,
  warn: 13,
  error: 17,
};

function toUnixNano(): string {
  return (BigInt(Date.now()) * 1_000_000n).toString();
}

export function createServerLogger(config: ServerConfig): ServerLogger {
  const runId = process.env.VESLO_RUN_ID ?? shortId();
  const host = hostname().trim();
  const resource: Record<string, string> = {
    "service.name": "veslo-server",
    "service.version": SERVER_VERSION,
    "service.instance.id": runId,
  };
  if (host) {
    resource["host.name"] = host;
  }
  const baseAttributes: LogAttributes = {
    "run.id": runId,
    "process.pid": process.pid,
  };

  const emit = (level: LogLevel, message: string, attributes?: LogAttributes) => {
    const merged = { ...baseAttributes, ...(attributes ?? {}) };
    if (config.logFormat === "json") {
      const record = {
        timeUnixNano: toUnixNano(),
        severityText: level.toUpperCase(),
        severityNumber: LOG_LEVEL_NUMBERS[level],
        body: message,
        attributes: merged,
        resource,
      };
      process.stdout.write(`${JSON.stringify(record)}\n`);
      return;
    }
    process.stdout.write(`${message}\n`);
  };

  return { log: emit };
}

function logRequest(input: {
  logger: ServerLogger;
  request: Request;
  response: Response;
  durationMs: number;
  authMode: AuthMode;
  proxyService?: "opencode" | "opencode-router";
  proxyBaseUrl?: string;
  error?: string;
  errorDetails?: unknown;
}) {
  const { logger, request, response, durationMs, authMode, proxyService, proxyBaseUrl, error, errorDetails } = input;
  const status = response.status;
  const level: LogLevel = status >= 500 ? "error" : status >= 400 ? "warn" : "info";
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const proxyLabel = proxyBaseUrl ? ` (${proxyService ?? "proxy"})` : "";
  const message = `${method} ${url.pathname} ${status} ${durationMs}ms${proxyLabel}`;
  const attributes: LogAttributes = {
    method,
    path: url.pathname,
    status,
    durationMs,
    auth: authMode,
  };
  if (proxyBaseUrl) {
    attributes["proxy.base_url"] = proxyBaseUrl;
    if (proxyService) attributes["proxy.service"] = proxyService;
  }
  if (error) {
    attributes.error = error;
  }
  if (errorDetails !== undefined) {
    attributes["error.details"] = redactSensitiveConfig(errorDetails);
  }
  logger.log(level, message, attributes);
}

type AuthMode = "none" | "client" | "host";

function normalizeOpenCodeRouterProxyPath(pathname: string): string {
  const trimmed = pathname.trim();
  if (!trimmed) return "/opencode-router";
  if (trimmed === "/opencode-router/") return "/opencode-router";
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

function resolveOpenCodeRouterProxyPolicy(
  method: string,
  pathname: string,
): { auth: AuthMode; requiredScope?: TokenScope } {
  const normalized = normalizeOpenCodeRouterProxyPath(pathname);
  const upper = method.trim().toUpperCase();

  if (upper === "GET") {
    if (normalized === "/opencode-router" || normalized === "/opencode-router/health") {
      return { auth: "client" };
    }
    if (normalized === "/opencode-router/bindings") {
      return { auth: "client", requiredScope: "collaborator" };
    }
    if (normalized === "/opencode-router/identities/telegram" || normalized === "/opencode-router/identities/slack") {
      return { auth: "client", requiredScope: "collaborator" };
    }
  }

  return { auth: "host" };
}

function parseWorkspaceMount(pathname: string): { workspaceId: string; restPath: string } | null {
  if (!pathname.startsWith("/w/")) return null;
  const remainder = pathname.slice(3);
  if (!remainder) return null;
  const slash = remainder.indexOf("/");
  if (slash === -1) {
    return { workspaceId: decodeURIComponent(remainder), restPath: "/" };
  }
  const workspaceId = remainder.slice(0, slash);
  const restPath = remainder.slice(slash) || "/";
  if (!workspaceId.trim()) return null;
  return { workspaceId: decodeURIComponent(workspaceId), restPath };
}

/**
 * Canonical multi-workspace OpenCode mount: `/workspace/:id/opencode[/*]`.
 * Returned `restPath` is the OpenCode-relative path (always starts with `/opencode`),
 * which `proxyOpencodeRequest` already understands the same way as the short `/w/:id` form.
 */
export function parseWorkspaceOpencodeMount(
  pathname: string,
): { workspaceId: string; restPath: string } | null {
  if (!pathname.startsWith("/workspace/")) return null;
  const remainder = pathname.slice("/workspace/".length);
  if (!remainder) return null;
  const slash = remainder.indexOf("/");
  if (slash === -1) return null;
  const workspaceId = remainder.slice(0, slash);
  const restPath = remainder.slice(slash) || "/";
  if (!workspaceId.trim()) return null;
  if (restPath !== "/opencode" && !restPath.startsWith("/opencode/")) return null;
  return { workspaceId: decodeURIComponent(workspaceId), restPath };
}

function normalizeOpencodeProxyPath(proxyPath: string): string {
  const raw = (proxyPath ?? "").trim() || "/";
  const withoutPrefix = raw.startsWith("/opencode") ? raw.slice("/opencode".length) : raw;
  const normalized = (withoutPrefix || "/").replace(/\/+$/, "");
  return normalized || "/";
}

function assertOpencodeProxyAllowed(actor: Actor, method: string, proxyPath: string) {
  const m = method.toUpperCase();
  const scope = actor.scope ?? "viewer";

  if (scope === "viewer" && m !== "GET" && m !== "HEAD") {
    throw new ApiError(403, "forbidden", "Viewer tokens are read-only");
  }

  // Prevent collaborators/viewers from self-approving OpenCode permission requests via the proxy.
  // OpenCode uses /permission/:requestId/reply (and historically also a session-scoped variant).
  if (scope !== "owner" && m !== "GET" && m !== "HEAD") {
    const normalized = normalizeOpencodeProxyPath(proxyPath);
    if (/\/permission\/[^/]+\/reply$/.test(normalized)) {
      throw new ApiError(403, "forbidden", "Only owner tokens can reply to permission requests");
    }
  }
}

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  auth: AuthMode;
  handler: (ctx: RequestContext) => Promise<Response>;
}

interface RequestContext {
  request: Request;
  url: URL;
  params: Record<string, string>;
  config: ServerConfig;
  approvals: ApprovalService;
  reloadEvents: ReloadEventStore;
  tokens: TokenService;
  automationRunner: AutomationRunner;
  actor?: Actor;
}

type AgentLabSchedule =
  | { kind: "interval"; seconds: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekly"; weekday: number; hour: number; minute: number };

type AgentLabAutomation = {
  id: string;
  name: string;
  enabled: boolean;
  schedule: AgentLabSchedule;
  prompt: string;
  createdAt: number;
  updatedAt?: number;
  lastRunAt?: number;
  lastRunSessionId?: string;
};

type AgentLabAutomationStore = {
  schemaVersion: number;
  updatedAt: number;
  items: AgentLabAutomation[];
};

type SoulHeartbeatEntry = {
  id: string;
  ts: string | null;
  workspace: string | null;
  summary: string;
  looseEnds: string[];
  nextAction: string | null;
};

type SoulStatus = {
  enabled: boolean;
  state: "off" | "healthy" | "stale" | "error";
  memoryEnabled: boolean;
  instructionsEnabled: boolean;
  heartbeatLogExists: boolean;
  heartbeatCommandExists: boolean;
  heartbeatJob: {
    name: string;
    slug: string;
    schedule: string;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    lastRunError: string | null;
  } | null;
  heartbeatCount: number;
  lastHeartbeatAt: string | null;
  lastHeartbeatSummary: string | null;
  staleAfterMs: number | null;
  overdue: boolean;
  summary: string;
  memoryPath: string;
  heartbeatPath: string;
};

export function startServer(config: ServerConfig) {
  const approvals = new ApprovalService(config.approval);
  const reloadEvents = new ReloadEventStore();
  const tokens = new TokenService(config);
  const runnerWorkspaces = config.readOnly
    ? []
    : config.workspaces
      .filter((workspace) => isAuthorizedRootSync(resolve(workspace.path), config.authorizedRoots))
      .map((workspace) => ({ ...workspace, path: resolve(workspace.path) }));
  const automationRunner = createAutomationRunner({
    workspaces: runnerWorkspaces,
    execute: createOpenCodeAutomationExecutor(config),
  });
  const routes = createRoutes(config, approvals, tokens, automationRunner);
  const baseLogger = createServerLogger(config);

  const debugLogPipeline: DebugLogPipeline = createDebugLogPipeline({
    config: config.debugLogs,
    spoolDir: join(resolveVesloDataDir(), "debug-log-spool"),
    logger: baseLogger,
  });
  setAuditDebugLogPipeline(debugLogPipeline);

  const logger: typeof baseLogger = {
    log(level, message, attributes) {
      baseLogger.log(level, message, attributes);
      void debugLogPipeline.append({
        id: randomUUID(),
        userId: "",
        orgId: "",
        workspaceId: "",
        source: "veslo-server-self",
        stream: "logger",
        level,
        timestamp: Date.now() * 1_000_000,
        sequenceNo: 0,
        payload: { message, attributes: attributes ?? {} },
      }).catch(() => undefined);
    },
  };

  const shutdownDebugLogPipeline = async () => {
    setAuditDebugLogPipeline(null);
    await debugLogPipeline.shutdown();
  };
  const handleSignal = () => {
    void shutdownDebugLogPipeline();
  };
  process.once("SIGINT", handleSignal);
  process.once("SIGTERM", handleSignal);

  const serverOptions: {
    hostname: string;
    port: number;
    fetch: (request: Request) => Response | Promise<Response>;
  } = {
    hostname: config.host,
    port: config.port,
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const startedAt = Date.now();
      let authMode: AuthMode = "none";
      let proxyService: "opencode" | "opencode-router" | undefined;
      let proxyBaseUrl: string | undefined;
      let errorMessage: string | undefined;
      let errorDetails: unknown;

      const finalize = (response: Response) => {
        const wrapped = withCors(response, request, config);
        if (config.logRequests && url.pathname !== "/debug-logs") {
          logRequest({
            logger,
            request,
            response: wrapped,
            durationMs: Date.now() - startedAt,
            authMode,
            proxyService,
            proxyBaseUrl,
            error: errorMessage,
            errorDetails,
          });
        }
        return wrapped;
      };

      if (request.method === "OPTIONS") {
        return finalize(new Response(null, { status: 204 }));
      }

      const canonicalOpencodeMount = parseWorkspaceOpencodeMount(url.pathname);
      const mount = canonicalOpencodeMount ?? parseWorkspaceMount(url.pathname);
      const opencodeMount =
        canonicalOpencodeMount ??
        (mount && (mount.restPath === "/opencode" || mount.restPath.startsWith("/opencode/"))
          ? mount
          : null);

      if (opencodeMount) {
        authMode = "client";
        try {
          const actor = await requireClient(request, config, tokens);
          assertOpencodeProxyAllowed(actor, request.method, opencodeMount.restPath);
          const workspace = await resolveWorkspace(config, opencodeMount.workspaceId);
          proxyService = "opencode";
          proxyBaseUrl = workspace.baseUrl?.trim() || undefined;
          const response = await proxyOpencodeRequest({
            request,
            url,
            workspace,
            proxyPath: opencodeMount.restPath,
          });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          errorDetails = apiError.details;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      if (mount && (mount.restPath === "/opencode-router" || mount.restPath.startsWith("/opencode-router/"))) {
        const policy = resolveOpenCodeRouterProxyPolicy(request.method, mount.restPath);
        authMode = policy.auth;
        try {
          if (authMode === "host") {
            await requireHost(request, config, tokens);
          } else {
            const actor = await requireClient(request, config, tokens);
            if (policy.requiredScope && scopeRank(actor.scope ?? "viewer") < scopeRank(policy.requiredScope)) {
              throw new ApiError(403, "forbidden", "Insufficient token scope", {
                required: policy.requiredScope,
                scope: actor.scope,
              });
            }
          }
          proxyService = "opencode-router";
          proxyBaseUrl = resolveOpenCodeRouterBaseUrl();
          const response = await proxyOpenCodeRouterRequest({ request, url, proxyPath: mount.restPath });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          errorDetails = apiError.details;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      // Allow clients to use a mounted base URL (e.g. http://host:8787/w/<id>) while
      // still calling the existing /workspace/:id/* API surface.
      // Example: baseUrl + "/workspace/<id>/plugins" => "/w/<id>/workspace/<id>/plugins".
      // We strip the mount prefix and route-match on the rest path.
      //
      // Important: when using a mounted base URL, enforce that the nested /workspace/:id
      // matches the mount workspace id to preserve the "single-workspace" mental model.
      if (mount && mount.restPath.startsWith("/workspace/")) {
        const match = mount.restPath.match(/^\/workspace\/([^/]+)/);
        const nestedId = match?.[1] ? decodeURIComponent(match[1]) : null;
        if (nestedId && nestedId !== mount.workspaceId) {
          errorMessage = "not_found";
          return finalize(jsonResponse({ code: "not_found", message: "Not found" }, 404));
        }
        url.pathname = mount.restPath;
      }

      // Session archives are global per-account metadata, but mounted clients may
      // still call them relative to /w/:id.
      if (mount && (mount.restPath === "/session-archives" || mount.restPath.startsWith("/session-archives/"))) {
        url.pathname = mount.restPath;
      }

      // AI gateway routes are also host-level APIs, but OpenCode provider config can
      // be generated from a workspace-mounted base URL.
      if (mount && (mount.restPath === "/ai-gateway" || mount.restPath.startsWith("/ai-gateway/"))) {
        url.pathname = mount.restPath;
      }

      if (url.pathname === "/opencode" || url.pathname.startsWith("/opencode/")) {
        authMode = "client";
        proxyBaseUrl = config.workspaces[0]?.baseUrl?.trim() || undefined;
        try {
          const actor = await requireClient(request, config, tokens);
          assertOpencodeProxyAllowed(actor, request.method, url.pathname);
          proxyService = "opencode";
          const response = await proxyOpencodeRequest({ request, url, workspace: config.workspaces[0] });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          errorDetails = apiError.details;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      if (url.pathname === "/opencode-router" || url.pathname.startsWith("/opencode-router/")) {
        const policy = resolveOpenCodeRouterProxyPolicy(request.method, url.pathname);
        authMode = policy.auth;
        try {
          if (authMode === "host") {
            await requireHost(request, config, tokens);
          } else {
            const actor = await requireClient(request, config, tokens);
            if (policy.requiredScope && scopeRank(actor.scope ?? "viewer") < scopeRank(policy.requiredScope)) {
              throw new ApiError(403, "forbidden", "Insufficient token scope", {
                required: policy.requiredScope,
                scope: actor.scope,
              });
            }
          }
          proxyService = "opencode-router";
          proxyBaseUrl = resolveOpenCodeRouterBaseUrl();
          const response = await proxyOpenCodeRouterRequest({ request, url });
          return finalize(response);
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          errorDetails = apiError.details;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      if (url.pathname === "/debug-logs" && request.method === "POST") {
        authMode = "host";
        try {
          await requireHost(request, config, tokens);
          const body = await readJsonBody(request, {
            maxBytes: config.debugLogs.batchMaxBytes,
            label: "debug log batch",
          }).catch((error) => {
            if (error instanceof ApiError && error.code === "invalid_json") return null;
            throw error;
          });
          const issues = validateDebugLogBatch(body);
          if (issues.length > 0) {
            return finalize(
              jsonResponse({ code: "invalid_batch", message: "Invalid debug log batch", issues }, 400),
            );
          }
          const batch = body as { batchId: string; events: Parameters<DebugLogPipeline["append"]>[0] };
          await debugLogPipeline.append(batch.events);
          return finalize(
            jsonResponse(
              {
                ok: true,
                acceptedBatchIds: [batch.batchId],
                cloudUploadEnabled: debugLogPipeline.isEnabled(),
              },
              202,
            ),
          );
        } catch (error) {
          const apiError = error instanceof ApiError
            ? error
            : new ApiError(500, "internal_error", "Unexpected server error");
          errorMessage = apiError.message;
          errorDetails = apiError.details;
          return finalize(jsonResponse(formatError(apiError), apiError.status));
        }
      }

      const route = matchRoute(routes, request.method, url.pathname);
      if (!route) {
        errorMessage = "not_found";
        return finalize(jsonResponse({ code: "not_found", message: "Not found" }, 404));
      }

      authMode = route.auth;
      try {
        const actor = route.auth === "host"
          ? await requireHost(request, config, tokens)
          : route.auth === "client"
            ? await requireClient(request, config, tokens)
            : undefined;
        const response = await route.handler({
          request,
          url,
          params: route.params,
          config,
          approvals,
          reloadEvents,
          tokens,
          automationRunner,
          actor,
        });
        return finalize(response);
      } catch (error) {
        if (!(error instanceof ApiError)) {
          console.error("[veslo-server] Unhandled error:", error);
        }
        const apiError = error instanceof ApiError
          ? error
          : new ApiError(500, "internal_error", "Unexpected server error");
        errorMessage = apiError.message;
        errorDetails = apiError.details;
        return finalize(jsonResponse(formatError(apiError), apiError.status));
      }
    },
  };

  (serverOptions as { idleTimeout?: number }).idleTimeout = 120;

  type StoppableServer = ReturnType<typeof Bun.serve> & { stop: (closeActiveConnections?: boolean) => void };
  const server = Bun.serve(serverOptions) as StoppableServer;
  void automationRunner.start().catch((error) => {
    logger.log("error", "automation runner start failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  });

  const originalStop = server.stop.bind(server);
  server.stop = (closeActiveConnections?: boolean) => {
    automationRunner.stop();
    return originalStop(closeActiveConnections);
  };

  return server;
}

function matchRoute(routes: Route[], method: string, path: string) {
  for (const route of routes) {
    if (route.method !== method) continue;
    const match = path.match(route.regex);
    if (!match) continue;
    const params: Record<string, string> = {};
    route.keys.forEach((key, index) => {
      params[key] = decodeURIComponent(match[index + 1]);
    });
    return { ...route, params };
  }
  return null;
}

function addRoute(routes: Route[], method: string, path: string, auth: AuthMode, handler: Route["handler"]) {
  const keys: string[] = [];
  const regex = pathToRegex(path, keys);
  routes.push({ method, regex, keys, auth, handler });
}

function pathToRegex(path: string, keys: string[]): RegExp {
  const pattern = path.replace(/:([A-Za-z0-9_]+)/g, (_, key) => {
    keys.push(key);
    return "([^/]+)";
  });
  return new RegExp(`^${pattern}$`);
}

const HOP_BY_HOP_REQUEST_HEADERS = [
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "trailers",
  "transfer-encoding",
  "upgrade",
];
const ACCEPT_ENCODING_HEADER = "accept-encoding";
const ACCEPT_ENCODING_IDENTITY = "identity";
const AI_GATEWAY_LOCAL_ONLY_REQUEST_HEADERS = [
  "x-session-affinity",
  "x-session-id",
];

function buildOpencodeProxyUrl(baseUrl: string, path: string, search: string, workspaceId?: string) {
  const target = new URL(baseUrl);
  const trimmedPath = path.replace(/^\/opencode/, "");
  const suffix = trimmedPath === "" ? "/" : trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  const basePath = target.pathname.replace(/\/+$/, "") || "";
  const workspaceMount = basePath.match(/^\/workspace\/([^/]+)\/opencode(?:\/.*)?$/);
  if (workspaceMount) {
    const id = encodeURIComponent(workspaceId ?? decodeURIComponent(workspaceMount[1] ?? ""));
    target.pathname = `/workspace/${id}/opencode${suffix === "/" ? "" : suffix}`;
  } else {
    target.pathname = `${basePath}${suffix === "/" ? "" : suffix}` || "/";
  }
  target.search = search;
  return target.toString();
}

function buildOrchestratorWorkspaceOpencodeBaseUrl(config: ServerConfig, workspace: WorkspaceInfo): string {
  if (workspace.workspaceType !== "local") return "";
  const daemonUrl = config.orchestratorDaemonUrl?.trim().replace(/\/+$/, "") ?? "";
  const workspaceId = workspace.id?.trim() ?? "";
  if (!daemonUrl || !workspaceId) return "";
  return `${daemonUrl}/workspace/${encodeURIComponent(workspaceId)}/opencode`;
}

function isEmptyWorkspaceOpencodeMount(baseUrl: string): boolean {
  try {
    const url = new URL(baseUrl);
    const match = url.pathname.match(/^\/workspace\/([^/]*)\/opencode(?:\/.*)?$/);
    return Boolean(match && !(match[1] ?? "").trim());
  } catch {
    return false;
  }
}

function resolveWorkspaceOpencodeBaseUrl(config: ServerConfig, workspace: WorkspaceInfo): string {
  const configured = workspace.baseUrl?.trim() ?? "";
  const derived = buildOrchestratorWorkspaceOpencodeBaseUrl(config, workspace);
  if (configured && !isEmptyWorkspaceOpencodeMount(configured)) return configured;
  return derived || configured;
}

async function fetchOpencodeJson(
  workspace: WorkspaceInfo,
  path: string,
  init: {
    method: string;
    body?: unknown;
    directory?: string | null;
    maxResponseBytes?: number;
    timeoutMs?: number;
    sendTraceId?: string | null;
  },
) {
  const baseUrl = workspace.baseUrl?.trim() ?? "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const [pathname, search = ""] = path.split("?");
  const url = new URL(buildOpencodeProxyUrl(
    baseUrl,
    pathname.startsWith("/") ? pathname : `/${pathname}`,
    search ? `?${search}` : "",
    workspace.id,
  ));

  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  const sendTraceId = init.sendTraceId?.trim() ?? "";
  if (sendTraceId) {
    headers.set("x-veslo-send-trace-id", sendTraceId);
  }

  const directoryOverride = init.directory?.trim() ?? "";
  const directory = directoryOverride
    ? normalizeOpencodeDirectory(directoryOverride)
    : resolveOpencodeDirectory(workspace);
  if (directory) {
    headers.set("x-opencode-directory", directory);
  }

  const auth = buildOpencodeAuthHeader(workspace);
  if (auth) {
    headers.set("Authorization", auth);
  }

  const timeoutMs = init.timeoutMs ?? resolveOpenCodeJsonFetchTimeoutMs();
  const requestStartedAt = Date.now();
  recordSendWorkflowTrace("server", "server:opencode-json:start", {
    traceId: sendTraceId || null,
    workspaceId: workspace.id,
    workspaceType: workspace.workspaceType,
    method: init.method,
    path,
    targetUrl: url.toString(),
    directory: directory || null,
    timeoutMs,
    hasAuth: Boolean(auth),
    hasBody: init.body !== undefined,
  });
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (typeof timeout === "object" && timeout && "unref" in timeout) {
    (timeout as { unref?: () => void }).unref?.();
  }

  try {
    const response = await fetch(url.toString(), {
      method: init.method,
      headers,
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: controller.signal,
    });

    let text = "";
    try {
      text = await readResponseTextWithLimit(
        response,
        init.maxResponseBytes ?? OPENCODE_JSON_DEFAULT_RESPONSE_MAX_BYTES,
      );
    } catch (error) {
      if (timedOut || isAbortError(error)) {
        throw new ApiError(502, "opencode_request_timeout", "OpenCode request timed out", {
          path,
          timeoutMs,
        });
      }
      if (error instanceof ApiError && error.code === "upstream_payload_too_large") {
        throw new ApiError(502, "opencode_response_too_large", "OpenCode response exceeds local parsing limit", {
          path,
          ...(error.details && typeof error.details === "object" ? error.details as Record<string, unknown> : {}),
        });
      }
      throw error;
    }

    let json: any = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = null;
    }
    if (!response.ok) {
      recordSendWorkflowTrace("server", "server:opencode-json:error-status", {
        traceId: sendTraceId || null,
        workspaceId: workspace.id,
        method: init.method,
        path,
        status: response.status,
        durationMs: Date.now() - requestStartedAt,
      });
      throw new ApiError(502, "opencode_request_failed", "OpenCode request failed", {
        status: response.status,
        body: json ?? text,
        path,
      });
    }
    recordSendWorkflowTrace("server", "server:opencode-json:done", {
      traceId: sendTraceId || null,
      workspaceId: workspace.id,
      method: init.method,
      path,
      status: response.status,
      durationMs: Date.now() - requestStartedAt,
    });
    return json;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut || isAbortError(error)) {
      recordSendWorkflowTrace("server", "server:opencode-json:timeout", {
        traceId: sendTraceId || null,
        workspaceId: workspace.id,
        method: init.method,
        path,
        timeoutMs,
        durationMs: Date.now() - requestStartedAt,
      });
      throw new ApiError(502, "opencode_request_timeout", "OpenCode request timed out", {
        path,
        timeoutMs,
      });
    }
    recordSendWorkflowTrace("server", "server:opencode-json:error", {
      traceId: sendTraceId || null,
      workspaceId: workspace.id,
      method: init.method,
      path,
      error: error instanceof Error ? error.message : String(error),
      durationMs: Date.now() - requestStartedAt,
    });
    throw new ApiError(502, "opencode_request_failed", "OpenCode request failed", {
      path,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

function detailsText(details: unknown): string {
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function shouldRetryOpenCodeViaOrchestrator(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  if (error.code === "opencode_request_timeout") return true;
  if (error.code !== "opencode_request_failed") return false;
  const details = isRecordLike(error.details) ? error.details : {};
  const status = typeof details.status === "number" ? details.status : null;
  const text = detailsText(error.details).toLowerCase();
  return (
    status === 404 ||
    status === 502 ||
    status === 503 ||
    text.includes("engine_not_running") ||
    text.includes("connection refused") ||
    text.includes("econnrefused") ||
    text.includes("failed to fetch") ||
    text.includes("fetch failed") ||
    text.includes("error sending request")
  );
}

function orchestratorFallbackWorkspace(config: ServerConfig, workspace: WorkspaceInfo): WorkspaceInfo | null {
  const baseUrl = buildOrchestratorWorkspaceOpencodeBaseUrl(config, workspace);
  if (!baseUrl) return null;
  if (workspace.baseUrl?.trim() === baseUrl) return null;
  return { ...workspace, baseUrl };
}

async function fetchOpencodeJsonWithOrchestratorFallback(
  config: ServerConfig,
  workspace: WorkspaceInfo,
  path: string,
  init: Parameters<typeof fetchOpencodeJson>[2],
) {
  try {
    return await fetchOpencodeJson(workspace, path, init);
  } catch (error) {
    const fallback = orchestratorFallbackWorkspace(config, workspace);
    if (!fallback || !shouldRetryOpenCodeViaOrchestrator(error)) {
      throw error;
    }
    recordSendWorkflowTrace("server", "server:opencode-json:fallback-orchestrator", {
      traceId: init.sendTraceId?.trim() || null,
      workspaceId: workspace.id,
      method: init.method,
      path,
      primaryBaseUrl: workspace.baseUrl?.trim() || null,
      fallbackBaseUrl: fallback.baseUrl ?? null,
      error: error instanceof Error ? error.message : String(error),
      code: error instanceof ApiError ? error.code : null,
    });
    return await fetchOpencodeJson(fallback, path, init);
  }
}

function createOpenCodeAutomationExecutor(
  config: ServerConfig,
): (input: AutomationExecutionInput) => Promise<AutomationExecutionResult> {
  return async (input) => {
    const workspace = await resolveWorkspace(config, input.workspaceId);

    const preferredSessionId = input.target.preferredSessionId?.trim() || "";
    if (preferredSessionId) {
      try {
        const existing = await fetchOpencodeJson(
          workspace,
          `/session/${encodeURIComponent(preferredSessionId)}`,
          { method: "GET", timeoutMs: AUTOMATION_OPENCODE_REQUEST_TIMEOUT_MS },
        );
        const existingId = typeof existing?.id === "string" ? existing.id.trim() : "";
        if (existingId) {
          await postAutomationPrompt(workspace, existingId, input.prompt, input.target);
          return { sessionId: existingId, createdSession: false };
        }
      } catch {
        // Missing or inaccessible preferred sessions fall back to a fresh session.
      }
    }

    const created = await fetchOpencodeJson(workspace, "/session", {
      method: "POST",
      body: { title: input.target.fallbackTitle?.trim() || `Automation: ${input.automation.name}` },
      timeoutMs: AUTOMATION_OPENCODE_REQUEST_TIMEOUT_MS,
    });
    const sessionId = typeof created?.id === "string" ? created.id.trim() : "";
    if (!sessionId) {
      throw new ApiError(502, "opencode_failed", "OpenCode session did not return an id");
    }
    await postAutomationPrompt(workspace, sessionId, input.prompt, input.target);
    return { sessionId, createdSession: true };
  };
}

async function postAutomationPrompt(
  workspace: WorkspaceInfo,
  sessionId: string,
  prompt: string,
  target: AutomationTarget,
): Promise<void> {
  const body: Record<string, unknown> = {
    parts: [{ type: "text", text: prompt }],
  };
  const agent = target.agent?.trim();
  if (agent) {
    body.agent = agent;
  }
  const model = typeof target.model === "string" ? target.model.trim() : "";
  if (model) {
    body.model = model;
  }
  const variant = typeof target.variant === "string" ? target.variant.trim() : "";
  if (variant) {
    body.variant = variant;
  }
  await fetchOpencodeJson(workspace, `/session/${encodeURIComponent(sessionId)}/prompt_async`, {
    method: "POST",
    body,
    timeoutMs: AUTOMATION_OPENCODE_REQUEST_TIMEOUT_MS,
  });
}

function buildOpenCodeRouterProxyUrl(baseUrl: string, path: string, search: string) {
  const target = new URL(baseUrl);
  const trimmedPath = path.replace(/^\/opencode-router/, "");
  const normalized = trimmedPath.startsWith("/") ? trimmedPath : `/${trimmedPath}`;
  target.pathname = normalized === "/" ? "/" : normalized;
  target.search = search;
  return target.toString();
}

async function proxyOpencodeRequest(input: {
  request: Request;
  url: URL;
  workspace?: WorkspaceInfo;
  proxyPath?: string;
}) {
  const workspace = input.workspace;
  const baseUrl = workspace?.baseUrl?.trim() ?? "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const proxyPath = input.proxyPath ?? input.url.pathname;
  const targetUrl = buildOpencodeProxyUrl(baseUrl, proxyPath, input.url.search, workspace?.id);
  const headers = new Headers(input.request.headers);
  headers.delete("authorization");
  headers.delete("x-veslo-host-token");
  headers.delete("x-veslo-client-id");
  headers.delete("host");
  headers.delete("origin");
  headers.delete("content-length");
  for (const header of HOP_BY_HOP_REQUEST_HEADERS) {
    headers.delete(header);
  }
  headers.set(ACCEPT_ENCODING_HEADER, ACCEPT_ENCODING_IDENTITY);

  // Per-request directory override (e.g. from sessions moved via "Choose folder")
  // takes priority over the workspace-level default.
  // Always strip a client-supplied `x-opencode-directory` header first so the
  // engine cannot be redirected to an attacker-chosen path by spoofing this
  // header through the proxy.
  headers.delete("x-opencode-directory");
  const queryDir = input.url.searchParams.get("directory")?.trim() || null;
  const directory = queryDir ?? (workspace ? resolveOpencodeDirectory(workspace) : null);
  if (directory) {
    headers.set("x-opencode-directory", directory);
  }

  const auth = workspace ? buildOpencodeAuthHeader(workspace) : null;
  if (auth) {
    headers.set("Authorization", auth);
  }

  const method = input.request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : input.request.body;
  // Bound the wait for upstream response headers only — the timer is cleared
  // as soon as fetch resolves, so streaming bodies (SSE) are never aborted.
  // Without this, a hung engine/orchestrator held proxied requests open until
  // the caller's own timeout fired (observed as 60s client-side hangs).
  const headersTimeoutMs = resolveOpencodeProxyHeadersTimeoutMs();
  const controller = new AbortController();
  let timedOut = false;
  const headersTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, headersTimeoutMs);
  if (typeof headersTimer === "object" && headersTimer && "unref" in headersTimer) {
    (headersTimer as { unref?: () => void }).unref?.();
  }
  let response: Response;
  try {
    response = await fetch(targetUrl, {
      method,
      headers,
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if (timedOut || isAbortError(error)) {
      throw new ApiError(502, "opencode_proxy_timeout", "OpenCode proxy timed out waiting for upstream response", {
        url: targetUrl,
        timeoutMs: headersTimeoutMs,
      });
    }
    throw new ApiError(502, "opencode_proxy_failed", "OpenCode proxy request failed", {
      url: targetUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(headersTimer);
  }

  return sanitizeProxyResponse(response);
}

/**
 * Strip hop-by-hop and transport-level headers that Bun's native fetch keeps
 * in the upstream response even after it has already decoded the body for us.
 * Without this the browser sees `content-encoding: gzip` on a plain-text
 * payload and bails out with ERR_CONTENT_DECODING_FAILED, breaking any UI
 * code that reaches through /opencode/* (including session.create).
 */
export function sanitizeProxyResponse(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("transfer-encoding");
  headers.delete("content-length");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function resolveOpenCodeRouterBaseUrl(): string {
  const port = parseInteger(process.env.OPENCODE_ROUTER_HEALTH_PORT);
  if (!port) {
    throw new ApiError(404, "opencodeRouter_unconfigured", "OpenCodeRouter is not configured on this host");
  }
  return `http://127.0.0.1:${port}`;
}

async function proxyOpenCodeRouterRequest(input: {
  request: Request;
  url: URL;
  proxyPath?: string;
}) {
  const baseUrl = resolveOpenCodeRouterBaseUrl();
  const proxyPath = input.proxyPath ?? input.url.pathname;
  const targetUrl = buildOpenCodeRouterProxyUrl(baseUrl, proxyPath, input.url.search);
  const headers = new Headers(input.request.headers);
  headers.delete("authorization");
  headers.delete("x-veslo-host-token");
  headers.delete("x-veslo-client-id");
  headers.delete("host");
  headers.delete("origin");

  const method = input.request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : input.request.body;
  try {
    const response = await fetch(targetUrl, {
      method,
      headers,
      body,
    });
    return response;
  } catch (error) {
    const port = parseInteger(process.env.OPENCODE_ROUTER_HEALTH_PORT);
    throw new ApiError(503, "opencodeRouter_unreachable", "OpenCodeRouter is not reachable on this host", {
      baseUrl,
      port,
      targetUrl,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function resolveAiGatewayBaseUrl(): string {
  const override =
    process.env.VESLO_MANAGED_AI_BASE_URL?.trim() ||
    process.env.VESLO_AI_GATEWAY_BASE_URL?.trim();
  if (override) {
    return override.replace(/\/+$/, "");
  }
  const port = parseInteger(process.env.AI_GATEWAY_PORT) ?? AI_GATEWAY_DEFAULT_PORT;
  return `http://127.0.0.1:${port}`;
}

function requireAiGatewayCallerAuth(request: Request): string {
  const authorization = request.headers.get(GATEWAY_CALLER_AUTH_HEADER)?.trim() ?? "";
  if (!authorization) {
    throw new ApiError(401, "gateway_unauthorized", "Gateway caller authorization is required");
  }
  return authorization;
}

function requireAiGatewayAccessToken(request: Request): string {
  const accessToken = request.headers.get(GATEWAY_ACCESS_TOKEN_HEADER)?.trim() ?? "";
  if (!accessToken) {
    throw new ApiError(401, "gateway_unauthorized", "Gateway access token is required");
  }
  return `Bearer ${accessToken}`;
}

function requireAiGatewaySessionId(request: Request): string {
  const sessionId = request.headers.get(GATEWAY_SESSION_ID_HEADER)?.trim() ?? "";
  if (!sessionId) {
    throw new ApiError(400, "gateway_session_required", "Gateway session id is required");
  }
  return sessionId;
}

function normalizeAiGatewaySessionId(sessionId?: string | null): string {
  const normalized = sessionId?.trim() ?? "";
  if (!normalized) return "";
  if (normalized === "${OPENCODE_SESSION_ID}") return "";
  return normalized;
}

function trimmedHeader(request: Request, name: string): string | undefined {
  const value = request.headers.get(name)?.trim() ?? "";
  return value || undefined;
}

function headerNamesForTrace(headers: Headers): string[] {
  return Array.from(headers.keys()).sort((a, b) => a.localeCompare(b));
}

function resolveAiGatewayProvider(gatewayPath: string): string | undefined {
  const match = gatewayPath.match(/^\/providers\/([^/]+)/);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

type AiGatewaySessionHit = {
  at: number;
  requestId: string;
  provider: string | null;
  gatewayPath: string;
  sessionId: string | null;
  workspaceId: string | null;
};

type ActiveAiGatewayRunContext = {
  at: number;
  traceId: string | null;
  workspaceId: string;
  conversationId: string;
  runId: string;
  opencodeSessionId: string;
  clientMessageId: string | null;
  origin: string | null;
};

type ActiveAiGatewayProxyRequest = {
  requestId: string;
  controller: AbortController;
  startedAt: number;
  abortReason: string | null;
  provider: string | null;
  gatewayPath: string;
  sessionId: string | null;
  workspaceId: string | null;
  traceId: string | null;
  conversationId: string | null;
  runId: string | null;
  opencodeSessionId: string | null;
  clientMessageId: string | null;
  origin: string | null;
};

const aiGatewaySessionHits = new Map<string, AiGatewaySessionHit[]>();
const aiGatewayWorkspaceHits = new Map<string, AiGatewaySessionHit[]>();
const activeAiGatewayRunsBySession = new Map<string, ActiveAiGatewayRunContext[]>();
const activeAiGatewayRunsByWorkspace = new Map<string, ActiveAiGatewayRunContext[]>();
const activeAiGatewayProxyRequests = new Map<string, ActiveAiGatewayProxyRequest>();

function pruneAiGatewaySessionHits(now = Date.now()): void {
  const cutoff = now - AI_GATEWAY_SESSION_HIT_TTL_MS;
  const prune = (hitsByKey: Map<string, AiGatewaySessionHit[]>) => {
    for (const [key, hits] of hitsByKey) {
      const liveHits = hits.filter((hit) => hit.at >= cutoff);
      if (liveHits.length) {
        hitsByKey.set(key, liveHits);
      } else {
        hitsByKey.delete(key);
      }
    }
  };
  prune(aiGatewaySessionHits);
  prune(aiGatewayWorkspaceHits);
}

function pruneActiveAiGatewayRuns(now = Date.now()): void {
  const cutoff = now - AI_GATEWAY_ACTIVE_RUN_TTL_MS;
  const prune = (itemsByKey: Map<string, ActiveAiGatewayRunContext[]>) => {
    for (const [key, items] of itemsByKey) {
      const liveItems = items.filter((item) => item.at >= cutoff);
      if (liveItems.length) {
        itemsByKey.set(key, liveItems);
      } else {
        itemsByKey.delete(key);
      }
    }
  };
  prune(activeAiGatewayRunsBySession);
  prune(activeAiGatewayRunsByWorkspace);
}

function registerActiveAiGatewayRun(input: Omit<ActiveAiGatewayRunContext, "at">): void {
  const now = Date.now();
  pruneActiveAiGatewayRuns(now);
  const context: ActiveAiGatewayRunContext = { ...input, at: now };
  const sessionId = normalizeAiGatewaySessionId(input.opencodeSessionId);
  if (sessionId) {
    const items = activeAiGatewayRunsBySession.get(sessionId) ?? [];
    items.push(context);
    activeAiGatewayRunsBySession.set(sessionId, items.slice(-10));
  }
  const workspaceId = input.workspaceId.trim();
  if (workspaceId) {
    const items = activeAiGatewayRunsByWorkspace.get(workspaceId) ?? [];
    items.push(context);
    activeAiGatewayRunsByWorkspace.set(workspaceId, items.slice(-10));
  }
  recordSendWorkflowTrace("server", "server:ai-gateway-active-run:register", {
    traceId: input.traceId,
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    runId: input.runId,
    opencodeSessionId: input.opencodeSessionId,
    clientMessageId: input.clientMessageId,
    origin: input.origin,
  });
}

function resolveActiveAiGatewayRunContext(input: {
  sessionId?: string | null;
  workspaceId?: string | null;
}): ActiveAiGatewayRunContext | null {
  pruneActiveAiGatewayRuns();
  const sessionId = normalizeAiGatewaySessionId(input.sessionId);
  if (sessionId) {
    const bySession = activeAiGatewayRunsBySession.get(sessionId) ?? [];
    if (bySession.length) return bySession[bySession.length - 1] ?? null;
  }
  const workspaceId = input.workspaceId?.trim() ?? "";
  if (workspaceId) {
    const byWorkspace = activeAiGatewayRunsByWorkspace.get(workspaceId) ?? [];
    if (byWorkspace.length) return byWorkspace[byWorkspace.length - 1] ?? null;
  }
  return null;
}

function registerActiveAiGatewayProxyRequest(input: Omit<ActiveAiGatewayProxyRequest, "abortReason">): ActiveAiGatewayProxyRequest {
  const entry: ActiveAiGatewayProxyRequest = {
    ...input,
    abortReason: null,
  };
  activeAiGatewayProxyRequests.set(entry.requestId, entry);
  return entry;
}

function unregisterActiveAiGatewayProxyRequest(requestId: string): void {
  activeAiGatewayProxyRequests.delete(requestId);
}

function abortActiveAiGatewayProxyRequests(input: {
  workspaceId: string;
  runId?: string | null;
  sessionId?: string | null;
  reason: string;
}): ActiveAiGatewayProxyRequest[] {
  const workspaceId = input.workspaceId.trim();
  const runId = input.runId?.trim() ?? "";
  const sessionId = normalizeAiGatewaySessionId(input.sessionId);
  if (!workspaceId || (!runId && !sessionId)) return [];

  const aborted: ActiveAiGatewayProxyRequest[] = [];
  for (const entry of activeAiGatewayProxyRequests.values()) {
    if (entry.workspaceId !== workspaceId) continue;
    const runMatches = Boolean(runId && entry.runId === runId);
    const sessionMatches = Boolean(sessionId && entry.sessionId === sessionId);
    if (!runMatches && !sessionMatches) continue;
    entry.abortReason = input.reason;
    entry.controller.abort();
    aborted.push(entry);
  }

  if (aborted.length) {
    const first = aborted[0];
    recordSendWorkflowTrace("server", "server:ai-gateway:proxy-abort-active", {
      traceId: first?.traceId ?? null,
      workspaceId,
      runId: runId || null,
      sessionId: sessionId || null,
      reason: input.reason,
      requestIds: aborted.map((entry) => entry.requestId),
      count: aborted.length,
      conversationIds: Array.from(new Set(aborted.map((entry) => entry.conversationId).filter(Boolean))),
      clientMessageIds: Array.from(new Set(aborted.map((entry) => entry.clientMessageId).filter(Boolean))),
    });
  }

  return aborted;
}

function recordAiGatewaySessionHit(input: {
  sessionId?: string;
  workspaceId?: string;
  requestId: string;
  provider: string | null;
  gatewayPath: string;
  now?: number;
}): void {
  const sessionId = normalizeAiGatewaySessionId(input.sessionId);
  const workspaceId = input.workspaceId?.trim() ?? "";
  if (!sessionId && !workspaceId) return;
  const now = input.now ?? Date.now();
  pruneAiGatewaySessionHits(now);
  const hit: AiGatewaySessionHit = {
    at: now,
    requestId: input.requestId,
    provider: input.provider,
    gatewayPath: input.gatewayPath,
    sessionId: sessionId || null,
    workspaceId: workspaceId || null,
  };
  if (sessionId) {
    const hits = aiGatewaySessionHits.get(sessionId) ?? [];
    hits.push(hit);
    aiGatewaySessionHits.set(sessionId, hits.slice(-50));
  }
  if (workspaceId) {
    const hits = aiGatewayWorkspaceHits.get(workspaceId) ?? [];
    hits.push(hit);
    aiGatewayWorkspaceHits.set(workspaceId, hits.slice(-50));
  }
}

function hasAiGatewayProviderHitAfter(input: {
  sessionId: string;
  workspaceId: string;
  startedAt: number;
}): boolean {
  const normalizedSessionId = normalizeAiGatewaySessionId(input.sessionId);
  const normalizedWorkspaceId = input.workspaceId.trim();
  pruneAiGatewaySessionHits();
  if (
    normalizedSessionId &&
    (aiGatewaySessionHits.get(normalizedSessionId) ?? []).some((hit) => hit.at >= input.startedAt)
  ) {
    return true;
  }
  if (
    normalizedWorkspaceId &&
    (aiGatewayWorkspaceHits.get(normalizedWorkspaceId) ?? []).some((hit) => hit.at >= input.startedAt)
  ) {
    return true;
  }
  return false;
}

function logAiGatewayProviderStartTimeout(input: Record<string, unknown>): void {
  try {
    console.warn(`[veslo:ai-gateway] provider-start-timeout ${JSON.stringify(input)}`);
  } catch {
    console.warn("[veslo:ai-gateway] provider-start-timeout");
  }
}

function logAiGatewayProviderStartWatch(input: Record<string, unknown>): void {
  try {
    console.log(`[veslo:ai-gateway] provider-start-watch ${JSON.stringify(input)}`);
  } catch {
    console.log("[veslo:ai-gateway] provider-start-watch");
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForAiGatewayProviderStart(input: {
  workspaceId: string;
  conversationId: string;
  runId: string;
  opencodeSessionId: string;
  clientMessageId?: string | null;
  origin?: string | null;
  startedAt: number;
}): Promise<{ started: boolean; timeoutMs: number }> {
  const timeoutMs = resolveAiGatewayProviderStartTimeoutMs();
  const opencodeSessionId = input.opencodeSessionId.trim();
  const workspaceId = input.workspaceId.trim();
  if (!opencodeSessionId) return { started: false, timeoutMs };

  logAiGatewayProviderStartWatch({
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    runId: input.runId,
    opencodeSessionId,
    clientMessageId: input.clientMessageId ?? null,
    origin: input.origin ?? null,
    timeoutMs,
  });

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (hasAiGatewayProviderHitAfter({ sessionId: opencodeSessionId, workspaceId, startedAt: input.startedAt })) {
      return { started: true, timeoutMs };
    }
    await sleep(Math.min(100, Math.max(5, deadline - Date.now())));
  }

  const started = hasAiGatewayProviderHitAfter({ sessionId: opencodeSessionId, workspaceId, startedAt: input.startedAt });
  if (!started) {
    logAiGatewayProviderStartTimeout({
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      runId: input.runId,
      opencodeSessionId,
      clientMessageId: input.clientMessageId ?? null,
      origin: input.origin ?? null,
      timeoutMs,
    });
  }
  return { started, timeoutMs };
}

type AiGatewayRequestDiagnostic = {
  contentType: string | null;
  contentLength: number | null;
  skipped?: string;
  bodySha256?: string;
  bodyBytes?: number;
  jsonKeys?: string[];
  model?: string;
  stream?: boolean;
  messageCount?: number;
  messageRoles?: string[];
  lastMessageRole?: string;
  lastUserContentBytes?: number;
  toolCount?: number;
  hasTools?: boolean;
  hasToolChoice?: boolean;
  hasResponseFormat?: boolean;
  hasReasoning?: boolean;
};

function summarizeChatCompletionBody(json: Record<string, unknown>, text: string): AiGatewayRequestDiagnostic {
  const messages = Array.isArray(json.messages) ? json.messages : [];
  const messageRoles = messages
    .map((message) => {
      if (!message || typeof message !== "object") return "";
      const role = (message as { role?: unknown }).role;
      return typeof role === "string" ? role : "";
    })
    .filter(Boolean);
  const lastUserMessage = [...messages].reverse().find((message) => {
    if (!message || typeof message !== "object") return false;
    return (message as { role?: unknown }).role === "user";
  }) as { content?: unknown } | undefined;
  const lastUserContent = lastUserMessage?.content;
  const lastUserContentBytes =
    typeof lastUserContent === "string"
      ? Buffer.byteLength(lastUserContent, "utf8")
      : Array.isArray(lastUserContent)
        ? Buffer.byteLength(JSON.stringify(lastUserContent), "utf8")
        : undefined;
  const model = typeof json.model === "string" && json.model.trim() ? json.model.trim() : undefined;
  const tools = Array.isArray(json.tools) ? json.tools : undefined;

  return {
    contentType: null,
    contentLength: null,
    bodySha256: createHash("sha256").update(text).digest("hex"),
    bodyBytes: Buffer.byteLength(text, "utf8"),
    jsonKeys: Object.keys(json).sort((a, b) => a.localeCompare(b)),
    model,
    stream: typeof json.stream === "boolean" ? json.stream : undefined,
    messageCount: messages.length,
    messageRoles: messageRoles.slice(-12),
    lastMessageRole: messageRoles[messageRoles.length - 1],
    lastUserContentBytes,
    toolCount: tools?.length,
    hasTools: Boolean(tools?.length),
    hasToolChoice: "tool_choice" in json || "toolChoice" in json,
    hasResponseFormat: "response_format" in json || "responseFormat" in json,
    hasReasoning: "reasoning" in json || "reasoning_effort" in json || "reasoningEffort" in json,
  };
}

async function readAiGatewayRequestDiagnostic(request: Request): Promise<AiGatewayRequestDiagnostic> {
  const contentType = request.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().includes("application/json")) {
    return { contentType: contentType || null, contentLength: null, skipped: "non-json" };
  }

  const contentLength = Number(request.headers.get("content-length") ?? NaN);
  if (!Number.isFinite(contentLength) || contentLength < 0) {
    return { contentType: contentType || null, contentLength: null, skipped: "unknown-content-length" };
  }
  if (contentLength > AI_GATEWAY_MODEL_DIAGNOSTIC_MAX_REQUEST_BYTES) {
    return {
      contentType: contentType || null,
      contentLength,
      skipped: "content-length-too-large",
    };
  }

  try {
    const text = await request.clone().text();
    const json = text ? JSON.parse(text) : null;
    if (!json || typeof json !== "object" || Array.isArray(json)) {
      return {
        contentType: contentType || null,
        contentLength,
        bodySha256: createHash("sha256").update(text).digest("hex"),
        bodyBytes: Buffer.byteLength(text, "utf8"),
        skipped: "non-object-json",
      };
    }
    return {
      ...summarizeChatCompletionBody(json as Record<string, unknown>, text),
      contentType: contentType || null,
      contentLength,
    };
  } catch {
    return { contentType: contentType || null, contentLength, skipped: "parse-failed" };
  }
}

function redactKnownSecretsFromText(text: string, secrets: Array<string | undefined>): string {
  let output = text;
  for (const secret of secrets) {
    if (!secret) continue;
    output = output.split(secret).join(REDACTED_SECRET_VALUE);
  }
  return output
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, `Bearer ${REDACTED_SECRET_VALUE}`)
    .replace(/\bsk-[A-Za-z0-9_-]{8,}\b/g, REDACTED_SECRET_VALUE);
}

function expandKnownSecrets(secrets: Array<string | undefined>): Array<string | undefined> {
  const expanded: string[] = [];
  for (const secret of secrets) {
    const trimmed = secret?.trim();
    if (!trimmed) continue;
    expanded.push(trimmed);
    const bearer = trimmed.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
    if (bearer) {
      expanded.push(bearer);
    }
  }
  return Array.from(new Set(expanded));
}

function truncateAiGatewaySnippet(text: string): { text: string; truncated: boolean } {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= AI_GATEWAY_UPSTREAM_RESPONSE_SNIPPET_MAX) {
    return { text: normalized, truncated: false };
  }
  return {
    text: `${normalized.slice(0, AI_GATEWAY_UPSTREAM_RESPONSE_SNIPPET_MAX)}...`,
    truncated: true,
  };
}

function buildAiGatewayUpstreamSnippet(input: {
  text: string;
  contentType: string;
  knownSecrets: Array<string | undefined>;
}): { text: string; truncated: boolean } {
  const contentType = input.contentType.toLowerCase();
  let text = input.text;
  if (contentType.includes("application/json")) {
    try {
      text = JSON.stringify(redactSensitiveConfig(JSON.parse(input.text)));
    } catch {
      text = input.text;
    }
  }
  return truncateAiGatewaySnippet(redactKnownSecretsFromText(text, input.knownSecrets));
}

async function readTextPreview(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<{ text: string; truncated: boolean }> {
  if (!body) return { text: "", truncated: false };
  const reader = body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  let truncated = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const chunk = Buffer.from(value);
      const remaining = maxBytes - total;
      if (chunk.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(chunk.subarray(0, remaining));
          total += remaining;
        }
        truncated = true;
        await reader.cancel().catch(() => undefined);
        break;
      }

      chunks.push(chunk);
      total += chunk.byteLength;
    }
  } finally {
    if (truncated) {
      await reader.cancel().catch(() => undefined);
    }
  }

  return {
    text: Buffer.concat(chunks).toString("utf8"),
    truncated,
  };
}

async function readResponseTextWithLimit(response: Response, maxBytes: number): Promise<string> {
  const contentLength = Number(response.headers.get("content-length") ?? NaN);
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ApiError(502, "upstream_payload_too_large", "Upstream response body exceeds local parsing limit", {
      maxBytes,
      size: contentLength,
    });
  }

  const preview = await readTextPreview(response.body, maxBytes);
  if (preview.truncated) {
    throw new ApiError(502, "upstream_payload_too_large", "Upstream response body exceeds local parsing limit", {
      maxBytes,
    });
  }
  return preview.text;
}

function firstResponseHeader(headers: Headers, names: string[]): string | undefined {
  for (const name of names) {
    const value = headers.get(name)?.trim() ?? "";
    if (value) return value;
  }
  return undefined;
}

function buildAiGatewayFailureDetails(input: {
  requestId: string;
  request: Request;
  gatewayPath: string;
  sessionId?: string;
  model?: string;
  response: Response;
  responseText: string;
  responseTextTruncated?: boolean;
  knownSecrets: Array<string | undefined>;
}) {
  const contentType = input.response.headers.get("content-type") ?? "";
  const userId =
    trimmedHeader(input.request, "x-veslo-account-id") ??
    trimmedHeader(input.request, "x-veslo-user-id") ??
    trimmedHeader(input.request, "x-veslo-den-user-id");
  const orgId =
    trimmedHeader(input.request, "x-veslo-den-org-id") ??
    trimmedHeader(input.request, "x-veslo-org-id");

  const upstreamSnippet = buildAiGatewayUpstreamSnippet({
    text: input.responseText,
    contentType,
    knownSecrets: input.knownSecrets,
  });

  return {
    requestId: input.requestId,
    provider: resolveAiGatewayProvider(input.gatewayPath),
    model: input.model,
    sessionId: input.sessionId,
    userId,
    orgId,
    upstreamStatus: input.response.status,
    upstreamStatusText: input.response.statusText,
    upstreamRequestId: firstResponseHeader(input.response.headers, [
      "x-request-id",
      "x-correlation-id",
      "openai-request-id",
      "cf-ray",
      "x-vercel-id",
      "x-amzn-trace-id",
    ]),
    upstreamContentType: contentType || undefined,
    upstreamResponse: upstreamSnippet.text,
    upstreamResponseTruncated: input.responseTextTruncated || upstreamSnippet.truncated || undefined,
  };
}

async function proxyAiGatewayReadinessRequest(input: {
  request: Request;
  url: URL;
}) {
  const baseUrl = resolveAiGatewayBaseUrl();
  const target = new URL(baseUrl);
  target.pathname = "/readiness";
  target.search = input.url.search;

  const requestId = randomUUID();
  const headers = new Headers();
  headers.set("Authorization", requireAiGatewayCallerAuth(input.request));
  headers.set("accept", input.request.headers.get("accept") ?? "application/json");
  headers.set("x-veslo-request-id", requestId);
  headers.set("accept-encoding", "identity");

  let response: Response;
  try {
    response = await fetch(target.toString(), {
      method: "GET",
      headers,
    });
  } catch (error) {
    throw new ApiError(503, "ai_gateway_unreachable", "AI gateway readiness is not reachable on this host", {
      requestId,
      baseUrl,
      targetUrl: target.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: sanitizeDecodedProxyResponseHeaders(response.headers),
  });
}

async function proxyAiGatewayRequest(input: {
  request: Request;
  url: URL;
  gatewayPath: string;
  auth: "caller" | "gateway-token";
  requireSessionId?: boolean;
  preserveAiAccessToken?: boolean;
}) {
  const startedAt = perfMs();
  let headersPreparedAt = startedAt;
  let modelDiagnosticStartedAt: number | undefined;
  let modelDiagnosticFinishedAt: number | undefined;
  let upstreamFetchStartedAt: number | undefined;
  let upstreamHeadersReceivedAt: number | undefined;
  let upstreamBodyDoneAt: number | undefined;
  let redactionDoneAt: number | undefined;
  const baseUrl = resolveAiGatewayBaseUrl();
  const target = new URL(baseUrl);
  target.pathname = input.gatewayPath.startsWith("/") ? input.gatewayPath : `/${input.gatewayPath}`;
  target.search = input.url.search;

  const headers = new Headers(input.request.headers);
  const requestId = randomUUID();
  const gatewayAccessToken = input.request.headers.get(GATEWAY_ACCESS_TOKEN_HEADER)?.trim() ?? "";
  const gatewayCallerAuth = input.request.headers.get(GATEWAY_CALLER_AUTH_HEADER)?.trim() ?? "";
  const authorization =
    input.auth === "caller" ? requireAiGatewayCallerAuth(input.request) : requireAiGatewayAccessToken(input.request);
  const incomingSessionId = input.requireSessionId ? requireAiGatewaySessionId(input.request) : undefined;
  const workspaceId = trimmedHeader(input.request, GATEWAY_WORKSPACE_ID_HEADER);
  const activeRunContext = resolveActiveAiGatewayRunContext({ sessionId: incomingSessionId, workspaceId });
  const sessionId = input.requireSessionId
    ? normalizeAiGatewaySessionId(incomingSessionId) ||
      normalizeAiGatewaySessionId(activeRunContext?.opencodeSessionId) ||
      ""
    : undefined;
  if (input.requireSessionId && !sessionId) {
    throw new ApiError(400, "gateway_session_unresolved", "Gateway session id placeholder could not be resolved", {
      requestId,
      provider: resolveAiGatewayProvider(input.gatewayPath),
      incomingSessionId,
      workspaceId,
    });
  }
  const incomingSessionIdForTrace =
    incomingSessionId && incomingSessionId !== sessionId ? incomingSessionId : undefined;
  const sessionResolvedFromActiveRunContext =
    Boolean(input.requireSessionId) &&
    Boolean(incomingSessionId) &&
    incomingSessionId !== sessionId &&
    Boolean(activeRunContext?.opencodeSessionId);
  const incomingHeaderNames = headerNamesForTrace(input.request.headers);
  const incomingInternalHeaderSummary = {
    hasGatewayAccessToken: Boolean(gatewayAccessToken),
    hasGatewayCallerAuth: Boolean(gatewayCallerAuth),
    hasWorkspaceId: Boolean(workspaceId),
    hasSendTraceId: Boolean(trimmedHeader(input.request, "x-veslo-send-trace-id")),
    hasSessionId: Boolean(incomingSessionId),
    hasHostToken: Boolean(trimmedHeader(input.request, "x-veslo-host-token")),
    hasClientId: Boolean(trimmedHeader(input.request, "x-veslo-client-id")),
  };
  recordAiGatewaySessionHit({
    sessionId,
    workspaceId,
    requestId,
    provider: resolveAiGatewayProvider(input.gatewayPath) ?? null,
    gatewayPath: input.gatewayPath,
  });
  recordSendWorkflowTrace("server", "server:ai-gateway:provider-hit", {
    traceId: activeRunContext?.traceId ?? null,
    requestId,
    provider: resolveAiGatewayProvider(input.gatewayPath) ?? null,
    gatewayPath: input.gatewayPath,
    sessionId: sessionId ?? null,
    incomingSessionId: incomingSessionIdForTrace,
    workspaceId: workspaceId ?? null,
    conversationId: activeRunContext?.conversationId ?? null,
    runId: activeRunContext?.runId ?? null,
    opencodeSessionId: activeRunContext?.opencodeSessionId ?? null,
    clientMessageId: activeRunContext?.clientMessageId ?? null,
    origin: activeRunContext?.origin ?? null,
    sessionResolvedFromActiveRunContext,
    incomingHeaders: incomingHeaderNames,
    incomingInternalHeaders: incomingInternalHeaderSummary,
  });
  let model: string | undefined;
  let requestDiagnostic: AiGatewayRequestDiagnostic | undefined;
  modelDiagnosticStartedAt = perfMs();
  const modelDiagnosticPromise = readAiGatewayRequestDiagnostic(input.request)
    .then((value) => {
      requestDiagnostic = value;
      model = value.model;
      recordSendWorkflowTrace("server", "server:ai-gateway:request-diagnostic", {
        traceId: activeRunContext?.traceId ?? null,
        requestId,
        provider: resolveAiGatewayProvider(input.gatewayPath) ?? null,
        gatewayPath: input.gatewayPath,
        sessionId: sessionId ?? null,
        workspaceId: workspaceId ?? null,
        conversationId: activeRunContext?.conversationId ?? null,
        runId: activeRunContext?.runId ?? null,
        opencodeSessionId: activeRunContext?.opencodeSessionId ?? null,
        clientMessageId: activeRunContext?.clientMessageId ?? null,
        ...value,
      });
      return value.model;
    })
    .finally(() => {
      modelDiagnosticFinishedAt = perfMs();
    });

  headers.set("Authorization", authorization);
  if (input.requireSessionId) {
    headers.set(GATEWAY_SESSION_ID_HEADER, sessionId ?? "");
  }
  headers.set("x-veslo-request-id", requestId);
  headers.delete(GATEWAY_CALLER_AUTH_HEADER);
  headers.delete(GATEWAY_ACCESS_TOKEN_HEADER);
  headers.delete("x-veslo-host-token");
  headers.delete("x-veslo-client-id");
  headers.delete(GATEWAY_WORKSPACE_ID_HEADER);
  headers.delete("x-veslo-send-trace-id");
  for (const name of AI_GATEWAY_LOCAL_ONLY_REQUEST_HEADERS) {
    headers.delete(name);
  }
  for (const name of HOP_BY_HOP_REQUEST_HEADERS) {
    headers.delete(name);
  }
  headers.delete("host");
  headers.delete("origin");
  headers.delete("content-length");
  headers.set("accept-encoding", "identity");
  const forwardedHeaderNames = headerNamesForTrace(headers);

  const method = input.request.method.toUpperCase();
  const body = method === "GET" || method === "HEAD" ? undefined : input.request.body;
  headersPreparedAt = perfMs();

  const logEvent = (event: "start", extra: Record<string, unknown> = {}) => {
    const attributes = {
      requestId,
      method,
      gatewayPath: input.gatewayPath,
      provider: resolveAiGatewayProvider(input.gatewayPath) ?? null,
      sessionId: sessionId ?? null,
      incomingSessionId: incomingSessionIdForTrace,
      workspaceId: workspaceId ?? null,
      traceId: activeRunContext?.traceId ?? null,
      conversationId: activeRunContext?.conversationId ?? null,
      runId: activeRunContext?.runId ?? null,
      opencodeSessionId: activeRunContext?.opencodeSessionId ?? null,
      clientMessageId: activeRunContext?.clientMessageId ?? null,
      origin: activeRunContext?.origin ?? null,
      targetOrigin: target.origin,
      targetPath: target.pathname,
      sessionResolvedFromActiveRunContext,
      incomingHeaders: incomingHeaderNames,
      forwardedHeaders: forwardedHeaderNames,
      incomingInternalHeaders: incomingInternalHeaderSummary,
      strippedInternalHeaders: [
        GATEWAY_CALLER_AUTH_HEADER,
        GATEWAY_ACCESS_TOKEN_HEADER,
        "x-veslo-host-token",
        "x-veslo-client-id",
        GATEWAY_WORKSPACE_ID_HEADER,
        "x-veslo-send-trace-id",
      ],
      strippedLocalOnlyHeaders: AI_GATEWAY_LOCAL_ONLY_REQUEST_HEADERS,
      strippedTransportHeaders: [
        ...HOP_BY_HOP_REQUEST_HEADERS,
        "host",
        "origin",
        "content-length",
      ],
      ...extra,
    };
    recordSendWorkflowTrace("server", `server:ai-gateway:proxy-${event}`, attributes);
    try {
      console.log(`[veslo:ai-gateway] proxy-${event} ${JSON.stringify(attributes)}`);
    } catch {
      console.log(`[veslo:ai-gateway] proxy-${event}`);
    }
  };

  const logTiming = (status: number, outcome: "ok" | "error", extra: Record<string, unknown> = {}) => {
    const finishedAt = perfMs();
    const attributes = {
      requestId,
      method,
      gatewayPath: input.gatewayPath,
      provider: resolveAiGatewayProvider(input.gatewayPath) ?? null,
      sessionId: sessionId ?? null,
      incomingSessionId: incomingSessionIdForTrace,
      workspaceId: workspaceId ?? null,
      traceId: activeRunContext?.traceId ?? null,
      conversationId: activeRunContext?.conversationId ?? null,
      runId: activeRunContext?.runId ?? null,
      opencodeSessionId: activeRunContext?.opencodeSessionId ?? null,
      clientMessageId: activeRunContext?.clientMessageId ?? null,
      origin: activeRunContext?.origin ?? null,
      model: model ?? null,
      requestDiagnostic,
      status,
      outcome,
      totalMs: roundTraceMs(finishedAt - startedAt),
      localPreflightMs: roundTraceMs((upstreamFetchStartedAt ?? headersPreparedAt) - startedAt),
      modelDiagnosticMs:
        modelDiagnosticStartedAt !== undefined && modelDiagnosticFinishedAt !== undefined
          ? roundTraceMs(modelDiagnosticFinishedAt - modelDiagnosticStartedAt)
          : undefined,
      upstreamHeadersMs:
        upstreamFetchStartedAt !== undefined && upstreamHeadersReceivedAt !== undefined
          ? roundTraceMs(upstreamHeadersReceivedAt - upstreamFetchStartedAt)
          : undefined,
      upstreamBodyMs:
        upstreamHeadersReceivedAt !== undefined && upstreamBodyDoneAt !== undefined
          ? roundTraceMs(upstreamBodyDoneAt - upstreamHeadersReceivedAt)
          : undefined,
      redactionMs:
        upstreamHeadersReceivedAt !== undefined && redactionDoneAt !== undefined
          ? roundTraceMs(redactionDoneAt - upstreamHeadersReceivedAt)
          : undefined,
      targetOrigin: target.origin,
      targetPath: target.pathname,
      ...extra,
    };
    recordSendWorkflowTrace("server", "server:ai-gateway:proxy:timing", attributes);
    try {
      console.log(`[veslo:ai-gateway] proxy ${JSON.stringify(attributes)}`);
    } catch {
      console.log("[veslo:ai-gateway] proxy");
    }
  };

  const headersTimeoutMs = resolveAiGatewayProxyHeadersTimeoutMs();
  const controller = new AbortController();
  const activeProxyRequest = registerActiveAiGatewayProxyRequest({
    requestId,
    controller,
    startedAt,
    provider: resolveAiGatewayProvider(input.gatewayPath) ?? null,
    gatewayPath: input.gatewayPath,
    sessionId: sessionId || null,
    workspaceId: workspaceId ?? null,
    traceId: activeRunContext?.traceId ?? null,
    conversationId: activeRunContext?.conversationId ?? null,
    runId: activeRunContext?.runId ?? null,
    opencodeSessionId: activeRunContext?.opencodeSessionId ?? null,
    clientMessageId: activeRunContext?.clientMessageId ?? null,
    origin: activeRunContext?.origin ?? null,
  });
  let timedOut = false;
  const headersTimer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, headersTimeoutMs);
  if (typeof headersTimer === "object" && headersTimer && "unref" in headersTimer) {
    (headersTimer as { unref?: () => void }).unref?.();
  }

  let response: Response;
  try {
    upstreamFetchStartedAt = perfMs();
    logEvent("start", { timeoutMs: headersTimeoutMs });
    response = await fetch(target.toString(), {
      method,
      headers,
      body,
      signal: controller.signal,
    });
    upstreamHeadersReceivedAt = perfMs();
  } catch (error) {
    const diagnosticModel = model ?? await modelDiagnosticPromise;
    if (activeProxyRequest.abortReason) {
      logTiming(499, "error", {
        error: "AI gateway proxy request was aborted",
        abortReason: activeProxyRequest.abortReason,
        timeoutMs: headersTimeoutMs,
      });
      throw new ApiError(499, "ai_gateway_aborted", "AI gateway request was aborted", {
        requestId,
        provider: resolveAiGatewayProvider(input.gatewayPath),
        model: diagnosticModel,
        sessionId,
        baseUrl,
        targetUrl: target.toString(),
        abortReason: activeProxyRequest.abortReason,
      });
    }
    if (timedOut || isAbortError(error)) {
      logTiming(504, "error", {
        error: "AI gateway upstream did not send response headers before timeout",
        timeoutMs: headersTimeoutMs,
      });
      throw new ApiError(504, "ai_gateway_timeout", "AI gateway timed out waiting for upstream response", {
        requestId,
        provider: resolveAiGatewayProvider(input.gatewayPath),
        model: diagnosticModel,
        sessionId,
        baseUrl,
        targetUrl: target.toString(),
        timeoutMs: headersTimeoutMs,
      });
    }
    logTiming(503, "error", {
      error: error instanceof Error ? error.message : String(error),
    });
    throw new ApiError(503, "ai_gateway_unreachable", "AI gateway is not reachable on this host", {
      requestId,
      provider: resolveAiGatewayProvider(input.gatewayPath),
      model: diagnosticModel,
      sessionId,
      baseUrl,
      targetUrl: target.toString(),
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(headersTimer);
    unregisterActiveAiGatewayProxyRequest(requestId);
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (!response.ok) {
    const diagnostic = await readTextPreview(response.body, AI_GATEWAY_ERROR_DIAGNOSTIC_MAX_RESPONSE_BYTES);
    upstreamBodyDoneAt = perfMs();
    const diagnosticModel = model ?? await modelDiagnosticPromise;
    logTiming(response.status, "error", {
      upstreamStatus: response.status,
      upstreamContentType: contentType || undefined,
      upstreamResponseTruncated: diagnostic.truncated || undefined,
    });
    throw new ApiError(502, "ai_gateway_upstream_failed", "AI gateway upstream request failed", buildAiGatewayFailureDetails({
      requestId,
      request: input.request,
      gatewayPath: input.gatewayPath,
      sessionId,
      model: diagnosticModel,
      response,
      responseText: diagnostic.text,
      responseTextTruncated: diagnostic.truncated,
      knownSecrets: expandKnownSecrets([gatewayAccessToken, gatewayCallerAuth, authorization]),
    }));
  }

  if (!contentType.toLowerCase().includes("application/json") || !input.preserveAiAccessToken) {
    logTiming(response.status, "ok", {
      streaming: true,
      upstreamContentType: contentType || undefined,
    });
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: sanitizeDecodedProxyResponseHeaders(response.headers),
    });
  }

  const text = await readResponseTextWithLimit(response, AI_GATEWAY_JSON_REDACTION_MAX_RESPONSE_BYTES);
  upstreamBodyDoneAt = perfMs();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    logTiming(response.status, "ok", {
      streaming: false,
      upstreamContentType: contentType || undefined,
      jsonParse: "failed",
    });
    return new Response(text, {
      status: response.status,
      headers: contentType ? { "Content-Type": contentType } : undefined,
    });
  }

  const redacted = input.preserveAiAccessToken ? redactAiAccessBundleForClient(json) : redactSensitiveConfig(json);
  redactionDoneAt = perfMs();
  logTiming(response.status, "ok", {
    streaming: false,
    upstreamContentType: contentType || undefined,
  });
  return jsonResponse(
    redacted,
    response.status,
  );
}

function sanitizeDecodedProxyResponseHeaders(headers: Headers): Headers {
  const sanitized = new Headers(headers);
  sanitized.delete("content-encoding");
  sanitized.delete("content-length");
  return sanitized;
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function opencodeRouterDebugEnabled(): boolean {
  return ["1", "true", "yes"].includes((process.env.VESLO_DEBUG_OPENCODE_ROUTER ?? "").toLowerCase());
}

function logOpenCodeRouterDebug(message: string, details?: Record<string, unknown>) {
  if (!opencodeRouterDebugEnabled()) return;
  const payload = details ? ` ${JSON.stringify(details)}` : "";
  console.log(`[opencodeRouter] ${message}${payload}`);
}

function withCors(response: Response, request: Request, config: ServerConfig) {
  const origin = request.headers.get("origin");
  const allowedOrigins = config.corsOrigins;
  let allowOrigin: string | null = null;
  if (allowedOrigins.includes("*")) {
    allowOrigin = "*";
  } else if (origin && allowedOrigins.includes(origin)) {
    allowOrigin = origin;
  }

  if (!allowOrigin) return response;
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", allowOrigin);
  headers.set(
    "Access-Control-Allow-Headers",
    "Authorization, Content-Type, X-Veslo-Host-Token, X-Veslo-Client-Id, X-Veslo-Send-Trace-Id, x-veslo-account-id, X-Veslo-User-Id, X-Veslo-Den-User-Id, X-Veslo-Org-Id, X-Veslo-Den-Org-Id, X-Veslo-Gateway-Authorization, X-Veslo-Gateway-Token, X-Veslo-Session-Id, X-Veslo-Workspace-Id, X-OpenCode-Directory, X-Opencode-Directory, x-opencode-directory",
  );
  headers.set("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
  headers.set("Vary", "Origin");
  return new Response(response.body, { status: response.status, headers });
}

async function requireClient(request: Request, config: ServerConfig, tokens: TokenService): Promise<Actor> {
  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const token = match?.[1];
  if (!token) {
    throw new ApiError(401, "unauthorized", "Invalid bearer token");
  }
  const scope = await tokens.scopeForToken(token);
  if (!scope) {
    throw new ApiError(401, "unauthorized", "Invalid bearer token");
  }
  const clientId = request.headers.get("x-veslo-client-id") ?? undefined;
  return { type: "remote", clientId, tokenHash: hashToken(token), scope };
}

async function requireHost(request: Request, config: ServerConfig, tokens: TokenService): Promise<Actor> {
  const hostToken = request.headers.get("x-veslo-host-token");
  if (hostToken && hostToken === config.hostToken) {
    return { type: "host", tokenHash: hashToken(hostToken), scope: "owner" };
  }

  const header = request.headers.get("authorization") ?? "";
  const match = header.match(/^Bearer\s+(.+)$/i);
  const bearer = match?.[1];
  if (!bearer) {
    throw new ApiError(401, "unauthorized", "Invalid host token");
  }
  const scope = await tokens.scopeForToken(bearer);
  if (scope !== "owner") {
    throw new ApiError(401, "unauthorized", "Invalid host token");
  }
  const clientId = request.headers.get("x-veslo-client-id") ?? undefined;
  return { type: "remote", clientId, tokenHash: hashToken(bearer), scope };
}

async function requireHostOrClient(request: Request, config: ServerConfig, tokens: TokenService): Promise<Actor> {
  if (request.headers.get("x-veslo-host-token")) {
    return requireHost(request, config, tokens);
  }
  return requireClient(request, config, tokens);
}

export function resolveArchiveOwnerKey(request: Request): string {
  const accountId = request.headers.get("x-veslo-account-id")?.trim() ?? "";
  if (!accountId) {
    throw new ApiError(400, "account_id_required", "A stable cloud account id is required for session archive sync.");
  }
  return accountId;
}

function buildCapabilities(config: ServerConfig): Capabilities {
  const writeEnabled = !config.readOnly;
  const schemaVersion = 1;
  const inboxEnabled = resolveInboxEnabled();
  const outboxEnabled = resolveOutboxEnabled();
  const maxBytes = resolveInboxMaxBytes();
  const toyUiEnabled = resolveToyUiEnabled();
  const browserProvider = resolveBrowserProvider();
  const opencodeRouterConfigured = Boolean(parseInteger(process.env.OPENCODE_ROUTER_HEALTH_PORT));
  const opencodeConfigured = config.workspaces.some((workspace) => Boolean(workspace.baseUrl?.trim()));
  return {
    schemaVersion,
    serverVersion: SERVER_VERSION,
    skills: { read: true, write: writeEnabled, source: "veslo" },
    hub: {
      skills: {
        read: true,
        install: writeEnabled,
      },
      mcp: {
        read: true,
        install: writeEnabled,
      },
    },
    plugins: { read: true, write: writeEnabled },
    mcp: { read: true, write: writeEnabled },
    commands: { read: true, write: writeEnabled },
    config: { read: true, write: writeEnabled },
    sandbox: resolveSandboxCapability(),

    approvals: { mode: config.approval.mode, timeoutMs: config.approval.timeoutMs },
    ui: { toy: toyUiEnabled },
    tokens: { scoped: true, scopes: ["owner", "collaborator", "viewer"] },
    proxy: {
      opencode: opencodeConfigured,
      opencodeRouter: opencodeRouterConfigured,
    },
    toolProviders: {
      browser: browserProvider,
      files: {
        injection: writeEnabled && inboxEnabled,
        outbox: outboxEnabled,
        inboxPath: ".opencode/veslo/inbox/",
        outboxPath: ".opencode/veslo/outbox/",
        maxBytes,
      },
    },
  };
}

function resolveSandboxCapability(): Capabilities["sandbox"] {
  const raw = (process.env.VESLO_SANDBOX_BACKEND ?? "none").trim() as SandboxBackend;
  const known = new Set<SandboxBackend>([
    "none",
    "docker",
    "container",
    "mac-sandbox-exec",
    "windows-wsl2",
    "windows-job-object",
    "stub",
  ]);
  const activeBackends = new Set<SandboxBackend>([
    "mac-sandbox-exec",
    "windows-wsl2",
  ]);
  const backend = known.has(raw) ? raw : "none";
  return {
    enabled: activeBackends.has(backend) && process.env.VESLO_DISABLE_SANDBOX !== "1",
    backend,
  };
}

function resolveInboxEnabled(): boolean {
  const raw = (process.env.VESLO_INBOX_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveOutboxEnabled(): boolean {
  const raw = (process.env.VESLO_OUTBOX_ENABLED ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveInboxMaxBytes(): number {
  const raw = (process.env.VESLO_INBOX_MAX_BYTES ?? "").trim();
  const parsed = raw ? Number(raw) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(Math.trunc(parsed), 250_000_000);
  }
  return 50_000_000;
}

function resolveToyUiEnabled(): boolean {
  const raw = (process.env.VESLO_TOY_UI ?? "").trim().toLowerCase();
  if (!raw) return true;
  return ["1", "true", "yes", "on"].includes(raw);
}

function resolveBrowserProvider(): Capabilities["toolProviders"]["browser"] {
  const raw = (process.env.VESLO_BROWSER_PROVIDER ?? "").trim().toLowerCase();
  if (raw === "sandbox-headless") {
    return { enabled: true, placement: "in-sandbox", mode: "headless" };
  }
  if (raw === "host-interactive") {
    return { enabled: true, placement: "host-machine", mode: "interactive" };
  }
  if (raw === "client-interactive") {
    return { enabled: true, placement: "client-machine", mode: "interactive" };
  }
  return { enabled: false, placement: "external", mode: "none" };
}

function resolveInboxDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "veslo", "inbox");
}

function resolveOutboxDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "veslo", "outbox");
}

function resolveAgentLabDir(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "veslo", "agentlab");
}

function resolveAgentLabAutomationsPath(workspaceRoot: string): string {
  return join(resolveAgentLabDir(workspaceRoot), "automations.json");
}

function resolveAgentLabLogsDir(workspaceRoot: string): string {
  return join(resolveAgentLabDir(workspaceRoot), "logs");
}

function clampInt(value: unknown, options: { min: number; max: number; name: string }): number {
  const num = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(num)) {
    throw new ApiError(400, "invalid_payload", `${options.name} must be a number`);
  }
  const int = Math.trunc(num);
  if (int < options.min || int > options.max) {
    throw new ApiError(400, "invalid_payload", `${options.name} must be between ${options.min} and ${options.max}`);
  }
  return int;
}

function parseAgentLabSchedule(value: unknown): AgentLabSchedule {
  if (!value || typeof value !== "object") {
    throw new ApiError(400, "invalid_payload", "schedule is required");
  }
  const schedule = value as Record<string, unknown>;
  const kind = typeof schedule.kind === "string" ? schedule.kind.trim() : "";
  if (kind === "interval") {
    const seconds = clampInt(schedule.seconds, { min: 60, max: 7 * 24 * 60 * 60, name: "schedule.seconds" });
    return { kind: "interval", seconds };
  }
  if (kind === "daily") {
    const hour = clampInt(schedule.hour, { min: 0, max: 23, name: "schedule.hour" });
    const minute = clampInt(schedule.minute, { min: 0, max: 59, name: "schedule.minute" });
    return { kind: "daily", hour, minute };
  }
  if (kind === "weekly") {
    const weekday = clampInt(schedule.weekday, { min: 1, max: 7, name: "schedule.weekday" });
    const hour = clampInt(schedule.hour, { min: 0, max: 23, name: "schedule.hour" });
    const minute = clampInt(schedule.minute, { min: 0, max: 59, name: "schedule.minute" });
    return { kind: "weekly", weekday, hour, minute };
  }
  throw new ApiError(400, "invalid_payload", "schedule.kind must be interval, daily, or weekly");
}

function validateAgentLabAutomationId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new ApiError(400, "invalid_payload", "automation id is required");
  }
  if (raw.length > 80) {
    throw new ApiError(400, "invalid_payload", "automation id is too long");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
    throw new ApiError(400, "invalid_payload", "automation id must match /^[a-zA-Z0-9_-]+$/");
  }
  return raw;
}

async function readAgentLabAutomations(workspaceRoot: string): Promise<AgentLabAutomationStore> {
  const path = resolveAgentLabAutomationsPath(workspaceRoot);
  if (!(await exists(path))) {
    return { schemaVersion: 1, updatedAt: Date.now(), items: [] };
  }
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<AgentLabAutomationStore>;
    const items = Array.isArray(parsed.items) ? parsed.items : [];
    const normalized: AgentLabAutomation[] = [];
    for (const item of items) {
      const record = item as Partial<AgentLabAutomation>;
      const id = typeof record.id === "string" ? record.id.trim() : "";
      const name = typeof record.name === "string" ? record.name.trim() : "";
      const prompt = typeof record.prompt === "string" ? record.prompt : "";
      const enabled = typeof record.enabled === "boolean" ? record.enabled : true;
      if (!id || !name || !prompt) continue;
      let schedule: AgentLabSchedule;
      try {
        schedule = parseAgentLabSchedule(record.schedule);
      } catch {
        continue;
      }
      normalized.push({
        id,
        name,
        enabled,
        schedule,
        prompt,
        createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
        updatedAt: typeof record.updatedAt === "number" ? record.updatedAt : undefined,
        lastRunAt: typeof record.lastRunAt === "number" ? record.lastRunAt : undefined,
        lastRunSessionId: typeof record.lastRunSessionId === "string" ? record.lastRunSessionId : undefined,
      });
    }
    return {
      schemaVersion: typeof parsed.schemaVersion === "number" ? parsed.schemaVersion : 1,
      updatedAt: typeof parsed.updatedAt === "number" ? parsed.updatedAt : Date.now(),
      items: normalized,
    };
  } catch {
    throw new ApiError(422, "invalid_json", "Failed to parse Agent Lab automations");
  }
}

async function writeAgentLabAutomations(workspaceRoot: string, store: AgentLabAutomationStore): Promise<void> {
  const path = resolveAgentLabAutomationsPath(workspaceRoot);
  await ensureDir(dirname(path));
  await writeFile(path, JSON.stringify({ ...store, updatedAt: Date.now() }, null, 2) + "\n", "utf8");
}

export function normalizeWorkspaceRelativePath(input: string, options: { allowSubdirs: boolean }): string {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new ApiError(400, "invalid_path", "Path is required");
  }
  if (raw.includes("\u0000")) {
    throw new ApiError(400, "invalid_path", "Path contains null byte");
  }

  // A lot of user-facing surfaces (artifacts, tool logs) reference files as
  // `workspace/<path>` or `/workspace/<path>`. The server API expects
  // workspace-relative paths, so normalize those common prefixes here.
  let normalized = raw.replace(/\\/g, "/");
  normalized = normalized.replace(/^\/+/, "");
  normalized = normalized.replace(/^\.\//, "");
  normalized = normalized.replace(/^workspace\//, "");
  normalized = normalized.replace(/^\/+/, "");

  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) {
    throw new ApiError(400, "invalid_path", "Path is required");
  }
  if (!options.allowSubdirs && parts.length > 1) {
    throw new ApiError(400, "invalid_path", "Subdirectories are not allowed");
  }
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new ApiError(400, "invalid_path", "Path traversal is not allowed");
    }
  }
  return parts.join("/");
}

async function resolveSafeChildPath(root: string, child: string): Promise<string> {
  // Use realpath when the path exists so that symlinks inside the workspace
  // pointing outside cannot be used to escape the boundary. Fall back to the
  // resolved (non-realpath) form when the candidate doesn't exist yet — that
  // covers write/mkdir operations that legitimately target a future path.
  const rootResolved = await realpath(root).catch(() => resolve(root));
  const candidate = resolve(rootResolved, child);
  const candidateResolved = await realpath(candidate).catch(() => candidate);
  if (candidateResolved === rootResolved) {
    throw new ApiError(400, "invalid_path", "Path must point to a file");
  }
  if (!candidateResolved.startsWith(rootResolved + sep)) {
    throw new ApiError(400, "invalid_path", "Path traversal is not allowed");
  }
  return candidate;
}

function encodeArtifactId(path: string): string {
  return Buffer.from(path, "utf8").toString("base64url");
}

function decodeArtifactId(id: string): string {
  const raw = (id ?? "").trim();
  if (!raw) {
    throw new ApiError(400, "invalid_artifact", "Artifact id is required");
  }
  try {
    const decoded = Buffer.from(raw, "base64url").toString("utf8");
    return normalizeWorkspaceRelativePath(decoded, { allowSubdirs: true });
  } catch {
    throw new ApiError(400, "invalid_artifact", "Artifact id is invalid");
  }
}

function encodeInboxId(path: string): string {
  return encodeArtifactId(path);
}

function decodeInboxId(id: string): string {
  try {
    return decodeArtifactId(id);
  } catch {
    throw new ApiError(400, "invalid_inbox_item", "Inbox item id is invalid");
  }
}

async function listArtifacts(outboxRoot: string): Promise<Array<{ id: string; path: string; size: number; updatedAt: number }>> {
  const rootResolved = resolve(outboxRoot);
  if (!(await exists(rootResolved))) return [];

  const items: Array<{ id: string; path: string; size: number; updatedAt: number }> = [];
  const walk = async (dir: string) => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      const rel = normalizeWorkspaceRelativePath(relative(rootResolved, abs), { allowSubdirs: true });
      const info = await stat(abs);
      items.push({
        id: encodeArtifactId(rel),
        path: rel,
        size: info.size,
        updatedAt: info.mtimeMs,
      });
    }
  };

  try {
    await walk(rootResolved);
  } catch {
    return [];
  }

  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return items;
}

async function listInbox(inboxRoot: string): Promise<Array<{ id: string; path: string; size: number; updatedAt: number; name: string }>> {
  const items = await listArtifacts(inboxRoot);
  return items.map((item) => ({
    ...item,
    id: encodeInboxId(item.path),
    name: basename(item.path),
  }));
}

type FileSessionCatalogEntry = {
  path: string;
  kind: "file" | "dir";
  size: number;
  mtimeMs: number;
  revision: string;
};

function fileRevision(info: { mtimeMs: number; size: number }): string {
  return `${Math.floor(info.mtimeMs)}:${info.size}`;
}

function parseFileSessionTtlMs(input: unknown): number {
  const raw = typeof input === "number" && Number.isFinite(input) ? input : Number.NaN;
  if (Number.isNaN(raw)) return FILE_SESSION_DEFAULT_TTL_MS;
  const ttlMs = Math.floor(raw * 1000);
  if (ttlMs < FILE_SESSION_MIN_TTL_MS) return FILE_SESSION_MIN_TTL_MS;
  if (ttlMs > FILE_SESSION_MAX_TTL_MS) return FILE_SESSION_MAX_TTL_MS;
  return ttlMs;
}

function parseCatalogLimit(input: string | null): number {
  if (!input) return FILE_SESSION_CATALOG_DEFAULT_LIMIT;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed <= 0) return FILE_SESSION_CATALOG_DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), FILE_SESSION_CATALOG_MAX_LIMIT);
}

function parseSessionCursor(input: string | null): number {
  if (!input) return 0;
  const parsed = Number(input);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.floor(parsed);
}

function parseSessionTranscriptLimit(input: unknown): number {
  const parsed =
    typeof input === "number" && Number.isFinite(input)
      ? input
      : typeof input === "string"
        ? Number(input)
        : Number.NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return SESSION_TRANSCRIPT_DEFAULT_LIMIT;
  return Math.min(Math.floor(parsed), SESSION_TRANSCRIPT_MAX_LIMIT);
}

function parseSessionTranscriptMessages(input: unknown): unknown[] {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "messages must be an array");
  }
  return input;
}

function parseSessionTranscriptParts(input: unknown): Record<string, unknown[]> {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "partsByMessageId must be an object");
  }
  const partsByMessageId: Record<string, unknown[]> = {};
  for (const [messageId, parts] of Object.entries(input as Record<string, unknown>)) {
    const id = messageId.trim();
    if (!id) continue;
    if (!Array.isArray(parts)) {
      throw new ApiError(400, "invalid_payload", "partsByMessageId values must be arrays");
    }
    partsByMessageId[id] = parts;
  }
  return partsByMessageId;
}

function parseTranscriptStringArray(input: unknown, field: string): string[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", `${field} must be an array`);
  }
  return input
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .filter((value) => value.length > 0);
}

function parseSessionTranscriptDeletedParts(input: unknown): Record<string, string[]> {
  if (input == null) return {};
  if (typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "deletedPartsByMessageId must be an object");
  }
  const deletedPartsByMessageId: Record<string, string[]> = {};
  for (const [messageId, partIds] of Object.entries(input as Record<string, unknown>)) {
    const id = messageId.trim();
    if (!id) continue;
    const parsed = parseTranscriptStringArray(partIds, "deletedPartsByMessageId values");
    if (parsed.length > 0) deletedPartsByMessageId[id] = parsed;
  }
  return deletedPartsByMessageId;
}

function readTranscriptMessageInfo(message: unknown): Record<string, unknown> | null {
  if (!isRecordLike(message)) return null;
  return isRecordLike(message.info) ? message.info : message;
}

function readTranscriptString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readPositiveTranscriptNumber(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function transcriptAssistantMessageIsTerminal(info: Record<string, unknown>): boolean {
  const time = isRecordLike(info.time) ? info.time : null;
  if (time && readPositiveTranscriptNumber(time.completed) !== null) return true;
  if (isRecordLike(info.error)) return true;
  if (readTranscriptString(info.finish)) return true;
  return false;
}

function transcriptLatestAssistantLooksTerminal(messages: unknown[]): boolean {
  if (messages.length === 0) return false;
  const latestInfo = readTranscriptMessageInfo(messages[messages.length - 1]);
  if (!latestInfo) return false;
  if (readTranscriptString(latestInfo.role) !== "assistant") return false;
  return transcriptAssistantMessageIsTerminal(latestInfo);
}

function transcriptReasonSignalsIdle(reason: string): boolean {
  const normalized = reason.trim().toLowerCase();
  return normalized.includes("session.idle") || normalized.includes("session.error");
}

function shouldReconcileLifecycleAfterTranscriptAppend(messages: unknown[], reason: string): boolean {
  return transcriptReasonSignalsIdle(reason) || transcriptLatestAssistantLooksTerminal(messages);
}

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveTranscriptMessageIdForArtifacts(message: Record<string, unknown>): string {
  const direct = typeof message.id === "string" ? message.id.trim() : "";
  if (direct) return direct;
  const info = isRecordLike(message.info) ? message.info : null;
  return typeof info?.id === "string" ? info.id.trim() : "";
}

function attachTranscriptPartsForArtifacts(
  messages: unknown[],
  partsByMessageId: Record<string, unknown[]>,
): SessionArtifactMessage[] {
  const result: SessionArtifactMessage[] = [];
  for (const rawMessage of messages) {
    if (!isRecordLike(rawMessage)) continue;
    const messageId = resolveTranscriptMessageIdForArtifacts(rawMessage);
    const persistedParts = messageId ? partsByMessageId[messageId] ?? [] : [];
    const inlineParts = Array.isArray(rawMessage.parts) ? rawMessage.parts : [];
    const parts = (persistedParts.length > 0 ? persistedParts : inlineParts)
      .filter(isRecordLike) as SessionArtifactPart[];
    result.push({
      ...rawMessage,
      parts,
    });
  }
  return result;
}

function parseSessionIdArray(input: unknown, fieldName: string): string[] {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", `${fieldName} must be an array`);
  }

  const ids: string[] = [];
  for (const value of input) {
    if (typeof value !== "string") {
      throw new ApiError(400, "invalid_payload", `${fieldName} entries must be strings`);
    }
    const normalized = value.trim();
    if (!normalized) continue;
    ids.push(normalized);
  }
  return ids;
}

function parseOptionalSessionId(input: unknown): string | undefined {
  if (typeof input !== "string") return undefined;
  const normalized = input.trim();
  return normalized ? normalized : undefined;
}

function parseSessionDirectoryMap(input: unknown): Record<string, string> {
  if (input === undefined || input === null) return {};
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "sessionDirectoriesById must be an object");
  }

  const result: Record<string, string> = {};
  for (const [sessionIdRaw, directoryRaw] of Object.entries(input as Record<string, unknown>)) {
    const sessionId = sessionIdRaw.trim();
    if (!sessionId) continue;
    if (typeof directoryRaw !== "string") {
      throw new ApiError(400, "invalid_payload", "sessionDirectoriesById entries must be strings");
    }
    const directory = directoryRaw.trim();
    if (!directory) continue;
    result[sessionId] = directory;
  }
  return result;
}

const CONVERSATION_RUN_BODY_FIELDS: Record<string, string[]> = {
  prompt_async: [
    "messageID",
    "model",
    "agent",
    "noReply",
    "tools",
    "system",
    "variant",
    "parts",
    "reasoning_effort",
  ],
  command: [
    "messageID",
    "agent",
    "model",
    "arguments",
    "command",
    "variant",
    "parts",
    "reasoning_effort",
  ],
  shell: [
    "agent",
    "model",
    "command",
  ],
  summarize: [
    "providerID",
    "modelID",
    "auto",
  ],
};

function parseConversationRunKind(input: unknown): "prompt_async" | "command" | "shell" | "summarize" {
  const kind = typeof input === "string" ? input.trim() : "";
  if (kind === "prompt" || kind === "prompt_async") return "prompt_async";
  if (kind === "command" || kind === "shell" || kind === "summarize") return kind;
  throw new ApiError(400, "invalid_payload", "kind must be prompt_async, command, shell, or summarize");
}

function buildConversationRunBody(kind: "prompt_async" | "command" | "shell" | "summarize", body: Record<string, unknown>) {
  const result: Record<string, unknown> = {};
  for (const field of CONVERSATION_RUN_BODY_FIELDS[kind] ?? []) {
    if (body[field] !== undefined) result[field] = body[field];
  }
  return result;
}

function summarizeConversationRunBodyForTrace(body: Record<string, unknown>) {
  const model = body.model;
  const modelSummary =
    typeof model === "string"
      ? { type: "string", value: model }
      : model && typeof model === "object" && !Array.isArray(model)
        ? {
            type: "object",
            providerID:
              typeof (model as { providerID?: unknown }).providerID === "string"
                ? (model as { providerID: string }).providerID
                : null,
            modelID:
              typeof (model as { modelID?: unknown }).modelID === "string"
                ? (model as { modelID: string }).modelID
                : null,
          }
        : model === undefined
          ? null
          : { type: typeof model };
  const parts = Array.isArray(body.parts) ? body.parts : [];
  const textChars = parts.reduce((total, part) => {
    if (!part || typeof part !== "object") return total;
    const text = (part as { text?: unknown }).text;
    return total + (typeof text === "string" ? text.length : 0);
  }, 0);
  return {
    fields: Object.keys(body).sort(),
    messageID: typeof body.messageID === "string" ? body.messageID : null,
    agent: typeof body.agent === "string" ? body.agent : null,
    variant: typeof body.variant === "string" ? body.variant : null,
    model: modelSummary,
    partCount: parts.length,
    textChars,
    hasSystem: typeof body.system === "string" && body.system.length > 0,
    hasTools: Boolean(body.tools && typeof body.tools === "object"),
    hasReasoningEffort: typeof body.reasoning_effort === "string" && body.reasoning_effort.length > 0,
    noReply: body.noReply === true,
  };
}

function lifecycleRunKind(kind: "prompt_async" | "command" | "shell" | "summarize") {
  return kind === "prompt_async" ? "prompt" : kind;
}

function lifecycleRequestApiError(error: OrchestratorLifecycleRequestError): ApiError {
  const status = error.status === 401 || error.status === 403
    ? 503
    : error.status === 404
      ? 404
      : error.status === 501
        ? 501
        : 503;
  const code = status === 404
    ? "lifecycle_not_found"
    : status === 501
      ? "lifecycle_unsupported"
      : "lifecycle_unavailable";
  return new ApiError(status, code, "Run lifecycle owner is unavailable", {
    upstreamStatus: error.status,
    path: error.path,
    body: error.body,
  });
}

type ConversationRunDebugTraceEntry = {
  source: "server";
  event: string;
  at: string;
  ts: number;
  traceId?: string;
  durationMs?: number;
  [key: string]: unknown;
};

const roundTraceMs = (value: number) => Math.round(value * 100) / 100;

const perfMs = () =>
  typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();

function createConversationRunTracer(request: Request) {
  const traceId = request.headers.get("x-veslo-send-trace-id")?.trim() || "";
  const enabled = Boolean(traceId) || ["1", "true", "yes"].includes((process.env.VESLO_FLOW_LOG ?? "").toLowerCase());
  const entries: ConversationRunDebugTraceEntry[] = [];

  const record = (event: string, payload: Record<string, unknown> = {}) => {
    const entry: ConversationRunDebugTraceEntry = {
      source: "server",
      event,
      at: new Date().toISOString(),
      ts: Date.now(),
      ...(traceId ? { traceId } : {}),
      ...payload,
    };
    entries.push(entry);
    recordSendWorkflowTrace("server", event, entry);
    if (enabled) {
      try {
        console.log(`[veslo:send-flow] ${event} ${JSON.stringify(entry)}`);
      } catch {
        console.log(`[veslo:send-flow] ${event}`);
      }
    }
  };

  const step = async <T,>(
    event: string,
    fn: () => Promise<T>,
    payload: Record<string, unknown> = {},
  ): Promise<T> => {
    const startedAt = perfMs();
    record(`${event}:start`, payload);
    try {
      const result = await fn();
      record(event, {
        ...payload,
        durationMs: roundTraceMs(perfMs() - startedAt),
        outcome: "ok",
      });
      return result;
    } catch (error) {
      record(`${event}:error`, {
        ...payload,
        durationMs: roundTraceMs(perfMs() - startedAt),
        outcome: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };

  return { entries, record, step, traceId: traceId || null };
}

type ConversationRunTracer = ReturnType<typeof createConversationRunTracer>;

function createBackgroundConversationRunTracer(traceId: string | null = null): ConversationRunTracer {
  const entries: ConversationRunDebugTraceEntry[] = [];
  const normalizedTraceId = traceId?.trim() || null;
  const record = (event: string, payload: Record<string, unknown> = {}) => {
    const entry: ConversationRunDebugTraceEntry = {
      source: "server",
      event,
      at: new Date().toISOString(),
      ts: Date.now(),
      ...(normalizedTraceId ? { traceId: normalizedTraceId } : {}),
      ...payload,
    };
    entries.push(entry);
    recordSendWorkflowTrace("server", event, entry);
  };
  const step = async <T,>(
    event: string,
    fn: () => Promise<T>,
    payload: Record<string, unknown> = {},
  ): Promise<T> => {
    const startedAt = perfMs();
    record(`${event}:start`, payload);
    try {
      const result = await fn();
      record(event, {
        ...payload,
        durationMs: roundTraceMs(perfMs() - startedAt),
        outcome: "ok",
      });
      return result;
    } catch (error) {
      record(`${event}:error`, {
        ...payload,
        durationMs: roundTraceMs(perfMs() - startedAt),
        outcome: "error",
        message: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  };
  return { entries, record, step, traceId: normalizedTraceId };
}

const ACTIVE_LIFECYCLE_STATUSES = new Set<LifecycleRunStatus>(["submitted", "running", "blocked"]);
const isActiveLifecycleStatus = (status: LifecycleRunStatus | string | null | undefined): boolean =>
  Boolean(status && ACTIVE_LIFECYCLE_STATUSES.has(status as LifecycleRunStatus));

function isVesloConversationId(input: string): boolean {
  return /^conv-[0-9a-f]{20}$/i.test(input.trim());
}

function requireConversationRunId(body: Record<string, unknown>): string {
  const runId = optionalBodyString(body, "runId");
  if (!runId) {
    throw new ApiError(400, "invalid_payload", "runId is required");
  }
  return runId;
}

const ownerForWorkspace = (workspace: WorkspaceInfo) =>
  workspaceResourceOwner({ workspaceId: workspace.id, root: workspace.path, label: workspace.name });

function parseCatalogPathFilter(input: string | null): string | null {
  if (!input) return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  return normalizeWorkspaceRelativePath(trimmed, { allowSubdirs: true });
}

function matchesCatalogFilter(path: string, filter: string | null): boolean {
  if (!filter) return true;
  return path === filter || path.startsWith(`${filter}/`);
}

function normalizeResolvedRelativePath(input: string): string {
  const normalized = input.replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  if (!parts.length) {
    throw new ApiError(400, "invalid_path", "Path is required");
  }
  for (const part of parts) {
    if (part === "." || part === "..") {
      throw new ApiError(400, "invalid_path", "Path traversal is not allowed");
    }
  }
  return parts.join("/");
}

async function listWorkspaceCatalogEntries(workspaceRoot: string): Promise<FileSessionCatalogEntry[]> {
  const rootResolved = resolve(workspaceRoot);
  const items: FileSessionCatalogEntry[] = [];

  const walk = async (dirPath: string) => {
    const entries = await readdir(dirPath, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of entries) {
      const absPath = join(dirPath, entry.name);
      const relRaw = relative(rootResolved, absPath).replace(/\\/g, "/");
      const rel = normalizeResolvedRelativePath(relRaw);

      if (entry.isDirectory()) {
        const info = await stat(absPath);
        items.push({
          path: rel,
          kind: "dir",
          size: 0,
          mtimeMs: info.mtimeMs,
          revision: fileRevision({ mtimeMs: info.mtimeMs, size: 0 }),
        });
        await walk(absPath);
        continue;
      }

      if (!entry.isFile()) continue;
      const info = await stat(absPath);
      items.push({
        path: rel,
        kind: "file",
        size: info.size,
        mtimeMs: info.mtimeMs,
        revision: fileRevision(info),
      });
    }
  };

  if (await exists(rootResolved)) {
    await walk(rootResolved);
  }

  items.sort((a, b) => a.path.localeCompare(b.path));
  return items;
}

function parseBatchPathList(input: unknown): string[] {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "paths must be an array");
  }
  if (!input.length) {
    throw new ApiError(400, "invalid_payload", "paths must not be empty");
  }
  if (input.length > FILE_SESSION_MAX_BATCH_ITEMS) {
    throw new ApiError(400, "invalid_payload", `paths must include <= ${FILE_SESSION_MAX_BATCH_ITEMS} items`);
  }
  return input.map((raw) => normalizeWorkspaceRelativePath(String(raw ?? ""), { allowSubdirs: true }));
}

function parseBatchWriteList(input: unknown): Array<{ path: string; contentBase64: string; ifMatchRevision?: string; force?: boolean }> {
  if (!Array.isArray(input)) {
    throw new ApiError(400, "invalid_payload", "writes must be an array");
  }
  if (!input.length) {
    throw new ApiError(400, "invalid_payload", "writes must not be empty");
  }
  if (input.length > FILE_SESSION_MAX_BATCH_ITEMS) {
    throw new ApiError(400, "invalid_payload", `writes must include <= ${FILE_SESSION_MAX_BATCH_ITEMS} items`);
  }

  return input.map((raw) => {
    if (!raw || typeof raw !== "object") {
      throw new ApiError(400, "invalid_payload", "write entries must be objects");
    }
    const record = raw as Record<string, unknown>;
    const contentBase64 = typeof record.contentBase64 === "string" ? record.contentBase64.trim() : "";
    if (!contentBase64) {
      throw new ApiError(400, "invalid_payload", "contentBase64 is required");
    }
    const ifMatchRevision =
      typeof record.ifMatchRevision === "string" && record.ifMatchRevision.trim().length
        ? record.ifMatchRevision.trim()
        : undefined;
    return {
      path: normalizeWorkspaceRelativePath(String(record.path ?? ""), { allowSubdirs: true }),
      contentBase64,
      ...(ifMatchRevision ? { ifMatchRevision } : {}),
      ...(record.force === true ? { force: true } : {}),
    };
  });
}

function emitReloadEvent(
  reloadEvents: ReloadEventStore,
  workspace: WorkspaceInfo,
  reason: ReloadReason,
  trigger?: ReloadTrigger,
) {
  reloadEvents.recordDebounced(workspace.id, reason, trigger);
}

function buildConfigTrigger(path: string): ReloadTrigger {
  const name = path.split(/[\\/]/).filter(Boolean).pop();
  return {
    type: "config",
    name: name || "opencode.json",
    action: "updated",
    path,
  };
}

export function serializeWorkspace(workspace: ServerConfig["workspaces"][number], config?: ServerConfig) {
  const { opencodeUsername, opencodePassword, baseUrl: rawBaseUrl, ...rest } = workspace;
  const baseUrl = config ? resolveWorkspaceOpencodeBaseUrl(config, workspace) : rawBaseUrl;
  const opencodeDirectory = resolveOpencodeDirectory(workspace);
  const opencode =
    baseUrl || opencodeDirectory || opencodeUsername || opencodePassword
      ? {
          baseUrl,
          directory: opencodeDirectory ?? undefined,
          username: opencodeUsername,
        }
      : undefined;
  return {
    ...rest,
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    opencode,
  };
}

function skillRegistryBaseUrl(config: ServerConfig): string {
  return config.skillRegistryBaseUrl?.trim() || "";
}

function normalizeSkillRegistryBaseUrl(value: string | null | undefined): string {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return "";
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "";
    if (url.username || url.password || url.search || url.hash) return "";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return "";
  }
}

function skillRegistryRequestBaseUrl(ctx: RequestContext): string {
  return (
    skillRegistryBaseUrl(ctx.config) ||
    normalizeSkillRegistryBaseUrl(ctx.request.headers.get("x-veslo-den-api-base"))
  );
}

function requireSkillRegistryRequestBaseUrl(ctx: RequestContext): void {
  if (!skillRegistryRequestBaseUrl(ctx)) {
    throw new ApiError(503, "skill_registry_misconfigured", "Skill registry base URL is missing");
  }
}

function skillRegistryRequestInput(ctx: RequestContext) {
  const userId = ctx.request.headers.get("x-veslo-den-user-id")?.trim() ||
    ctx.request.headers.get("x-veslo-user-id")?.trim() ||
    ctx.request.headers.get("x-veslo-account-id")?.trim() ||
    undefined;
  return {
    baseUrl: skillRegistryRequestBaseUrl(ctx),
    token: ctx.config.skillRegistryToken?.trim() || undefined,
    denToken: ctx.request.headers.get("x-veslo-den-token")?.trim() || undefined,
    orgId: ctx.request.headers.get("x-veslo-den-org-id")?.trim() || undefined,
    userId,
  };
}

type SoulSummary = {
  scope: "organization" | "user" | "workspace";
  ownerId: string;
  owner: ResourceOwner;
  title: string;
  currentVersionId: string | null;
  updatedAt: string | null;
  updatedBy: string | null;
  status: "active" | "pending" | "conflict" | "not_configured";
  heartbeatEnabled: boolean;
  pendingSuggestionCount: number;
  canEdit: boolean;
};

type SoulDenContext = {
  baseUrl: string;
  denToken?: string;
  orgId?: string;
  userId?: string;
};

function soulDenContext(ctx: RequestContext): SoulDenContext {
  const userId = ctx.request.headers.get("x-veslo-den-user-id")?.trim() ||
    ctx.request.headers.get("x-veslo-user-id")?.trim() ||
    ctx.request.headers.get("x-veslo-account-id")?.trim() ||
    undefined;
  return {
    baseUrl: ctx.config.denApiBase?.trim() || normalizeSkillRegistryBaseUrl(ctx.request.headers.get("x-veslo-den-api-base")),
    denToken: ctx.request.headers.get("x-veslo-den-token")?.trim() || undefined,
    orgId: ctx.request.headers.get("x-veslo-den-org-id")?.trim() || undefined,
    userId,
  };
}

function requireSoulDenToken(ctx: SoulDenContext): string {
  if (!ctx.denToken) {
    throw new ApiError(401, "den_token_required", "Den token is required");
  }
  return ctx.denToken;
}

function requireSoulOrgId(ctx: SoulDenContext): string {
  if (!ctx.orgId) {
    throw new ApiError(400, "den_org_required", "Den organization id is required");
  }
  return ctx.orgId;
}

function requireSoulUserId(ctx: SoulDenContext): string {
  if (!ctx.userId) {
    throw new ApiError(400, "den_user_required", "Den user id is required");
  }
  return ctx.userId;
}

function soulCanEdit(ctx: RequestContext, scope: SoulScope): boolean {
  if (ctx.config.readOnly) return false;
  const tokenScope = ctx.actor?.scope;
  const hasCollaboratorScope = Boolean(tokenScope && scopeRank(tokenScope) >= scopeRank("collaborator"));
  if (scope === "organization") {
    const den = soulDenContext(ctx);
    return Boolean(hasCollaboratorScope && den.denToken && den.orgId);
  }
  return hasCollaboratorScope;
}

function soulUpdatedAt(document: SoulDocument | null): string | null {
  if (!document) return null;
  return currentSoulVersion(document)?.createdAt ?? null;
}

function soulUpdatedBy(document: SoulDocument | null): string | null {
  if (!document) return null;
  return currentSoulVersion(document)?.createdBy ?? null;
}

function soulTitle(scope: SoulScope, workspace?: WorkspaceInfo): string {
  if (scope === "organization") return "Organization Soul";
  if (scope === "user") return "User Soul";
  return workspace?.name ? `${workspace.name} Soul` : "Workspace Soul";
}

function soulResourceOwner(input: {
  scope: SoulScope;
  ownerId: string;
  workspace?: WorkspaceInfo;
}): ResourceOwner {
  if (input.scope === "organization") {
    return organizationResourceOwner({ orgId: input.ownerId, label: "Organization" });
  }
  if (input.scope === "user") {
    return localUserResourceOwner({ userId: input.ownerId, label: "User" });
  }
  if (input.workspace) {
    return ownerForWorkspace(input.workspace);
  }
  return workspaceResourceOwner({ workspaceId: input.ownerId });
}

function soulSummary(input: {
  scope: SoulScope;
  ownerId: string;
  document: SoulDocument | null;
  canEdit: boolean;
  status?: SoulSummary["status"];
  workspace?: WorkspaceInfo;
}): SoulSummary {
  const status = input.status ?? (input.document?.currentVersionId ? "active" : "not_configured");
  return {
    scope: input.scope,
    ownerId: input.ownerId,
    owner: soulResourceOwner(input),
    title: soulTitle(input.scope, input.workspace),
    currentVersionId: input.document?.currentVersionId ?? null,
    updatedAt: soulUpdatedAt(input.document),
    updatedBy: soulUpdatedBy(input.document),
    status,
    heartbeatEnabled: input.document?.heartbeatEnabled ?? false,
    pendingSuggestionCount: 0,
    canEdit: input.canEdit,
  };
}

function emptySoulDocument(scope: SoulScope, ownerId: string): SoulDocument {
  return {
    id: `${scope}_${ownerId}`,
    scope,
    ownerId,
    currentVersionId: null,
    heartbeatEnabled: false,
    versions: [],
  };
}

function isSoulDenUnavailable(error: unknown): boolean {
  if (!(error instanceof ApiError)) return false;
  return error.code === "soul_den_fetch_failed" || error.code === "soul_den_misconfigured";
}

function validateSoulScopeParam(value: string): SoulScope {
  if (value === "organization" || value === "user" || value === "workspace") return value;
  throw new ApiError(400, "invalid_soul_scope", "Soul scope is invalid");
}

function requireSoulText(body: Record<string, unknown>, field: "content" | "changeSummary"): string {
  const value = body[field];
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, "invalid_request", `Field ${field} is required`);
  }
  return value;
}

function optionalSoulBaseVersionId(body: Record<string, unknown>): string | null {
  const value = body.baseVersionId;
  if (value === undefined || value === null) return null;
  if (typeof value === "string") return value;
  throw new ApiError(400, "invalid_request", "Field baseVersionId must be a string or null");
}

function soulActorId(ctx: RequestContext): string {
  return ctx.request.headers.get("x-veslo-den-user-id")?.trim() ||
    ctx.request.headers.get("x-veslo-user-id")?.trim() ||
    ctx.request.headers.get("x-veslo-account-id")?.trim() ||
    ctx.actor?.tokenHash ||
    ctx.actor?.clientId ||
    "system";
}

function soulVersionId(prefix = "soul_v"): string {
  return `${prefix}${shortId()}`;
}

function soulVersionResponse(document: SoulDocument, versionId: string): SoulVersion {
  const version = document.versions.find((item) => item.id === versionId);
  if (!version) {
    throw new ApiError(404, "soul_version_not_found", "Soul version not found");
  }
  return version;
}

async function readCachedSoulVersions(dataDir: string, scope: SoulScope, ownerId: string): Promise<SoulVersion[]> {
  const document = await readCachedSoulDocument({ dataDir, scope, ownerId });
  return document?.versions ?? [];
}

async function readPendingSoulEditsFor(dataDir: string, scope: SoulScope, ownerId: string): Promise<SoulPendingEdit[]> {
  const edits = await listPendingSoulEdits({ dataDir });
  return edits.filter((edit) => edit.scope === scope && edit.ownerId === ownerId);
}

async function readCachedSoulForMaterialization(
  dataDir: string,
  scope: SoulScope,
  ownerId: string | undefined,
): Promise<SoulDocument | null> {
  if (!ownerId) return null;
  return readCachedSoulDocument({ dataDir, scope, ownerId });
}

async function materializeSoulForWorkspace(
  dataDir: string,
  ctx: RequestContext,
  workspace: WorkspaceInfo,
  overrides: Partial<Record<SoulScope, SoulDocument | null>> = {},
  options: { workspaceActive?: boolean } = {},
): Promise<SoulMaterializationResult> {
  return withSoulMaterializationLock(workspace.id, async () => {
    const den = soulDenContext(ctx);
    const hasOverride = (scope: SoulScope) => Object.prototype.hasOwnProperty.call(overrides, scope);
    const organization = hasOverride("organization")
      ? overrides.organization ?? null
      : await readCachedSoulForMaterialization(dataDir, "organization", den.orgId);
    const user = hasOverride("user")
      ? overrides.user ?? null
      : await readCachedSoulForMaterialization(dataDir, "user", den.userId);
    const workspaceDocument = hasOverride("workspace")
      ? overrides.workspace ?? null
      : await readCachedSoulForMaterialization(dataDir, "workspace", workspace.id);

    await soulMaterializationTestHookForTests?.({ workspaceId: workspace.id, overrides });

    return materializeEffectiveSoul({
      workspaceRoot: workspace.path,
      organization,
      user,
      workspace: workspaceDocument,
      workspaceActive: options.workspaceActive,
    });
  });
}

async function materializeSoulForConfiguredWorkspaces(
  dataDir: string,
  config: ServerConfig,
  ctx: RequestContext,
  overrides: Partial<Record<SoulScope, SoulDocument | null>>,
  options: { activeWorkspaceIds?: Set<string> } = {},
): Promise<{
  ok: boolean;
  pending: boolean;
  manualSyncRequired: false;
  workspaces: Array<{ workspaceId: string; result: SoulMaterializationResult }>;
}> {
  const workspaces = [];
  for (const configuredWorkspace of config.workspaces) {
    const workspace = await resolveWorkspace(config, configuredWorkspace.id);
    const result = await materializeSoulForWorkspace(dataDir, ctx, workspace, overrides, {
      workspaceActive: options.activeWorkspaceIds?.has(workspace.id) === true,
    });
    workspaces.push({ workspaceId: workspace.id, result });
  }
  return {
    ok: workspaces.every((item) => item.result.ok),
    pending: workspaces.some((item) => item.result.pending),
    manualSyncRequired: false,
    workspaces,
  };
}

function soulReadPayload(input: {
  document: SoulDocument | null;
  summary: SoulSummary;
  pendingEdits?: SoulPendingEdit[];
  denSynced?: boolean;
  materialization?: unknown;
}) {
  return {
    document: input.document ?? emptySoulDocument(input.summary.scope, input.summary.ownerId),
    summary: input.summary,
    ...(input.pendingEdits ? { pendingEdits: input.pendingEdits } : {}),
    ...(input.denSynced === undefined ? {} : { denSynced: input.denSynced }),
    ...(input.materialization === undefined ? {} : { materialization: input.materialization }),
  };
}

function activeSoulWorkspaceIdsFromBody(body: Record<string, unknown>): Set<string> {
  const raw = Array.isArray(body.activeWorkspaceIds) ? body.activeWorkspaceIds : [];
  return new Set(
    raw
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean),
  );
}

function soulWorkspaceActiveFromBody(body: Record<string, unknown>, workspaceId: string): boolean {
  return body.activeRun === true || activeSoulWorkspaceIdsFromBody(body).has(workspaceId);
}

async function buildSoulMaterializationStatus(workspace: WorkspaceInfo): Promise<SoulMaterializationResult | undefined> {
  return readSoulMaterializationStatus(workspace.path);
}

function uniqueApprovalPaths(paths: string[]): string[] {
  return [...new Set(paths.filter((path) => path.trim().length > 0))];
}

function soulMaterializationApprovalPaths(workspace: WorkspaceInfo): string[] {
  return [
    opencodeConfigPath(workspace.path),
    join(workspace.path, ".opencode", "soul-company.md"),
    join(workspace.path, ".opencode", "soul-user.md"),
    join(workspace.path, ".opencode", "soul-workspace.md"),
    join(workspace.path, ".opencode", "veslo", "soul-manifest.json"),
  ];
}

async function configuredSoulMaterializationApprovalPaths(
  config: ServerConfig,
  extraPaths: string[],
): Promise<string[]> {
  const paths = [...extraPaths];
  for (const configuredWorkspace of config.workspaces) {
    const workspace = await resolveWorkspace(config, configuredWorkspace.id);
    paths.push(...soulMaterializationApprovalPaths(workspace));
  }
  return uniqueApprovalPaths(paths);
}

function globalSoulApprovalWorkspaceId(config: ServerConfig): string {
  return config.workspaces[0]?.id ?? "__soul__";
}

async function requireSoulApproval(
  ctx: RequestContext,
  input: {
    workspaceId: string;
    action: string;
    summary: string;
    paths: string[];
  },
): Promise<void> {
  await requireApproval(ctx, {
    workspaceId: input.workspaceId,
    action: input.action,
    summary: input.summary,
    paths: uniqueApprovalPaths(input.paths),
  });
}

function materializationEntryPayload(entry: WorkspaceSkillMaterialization & {
  skillDir?: string;
  materializedAt?: string;
}) {
  return {
    installationId: entry.installationId,
    skillId: entry.skillId,
    name: entry.name,
    versionId: entry.versionId,
    packageSha256: entry.packageSha256,
    source: entry.source,
    target: entry.target,
    removalPolicy: entry.removalPolicy,
    ...(entry.skillDir ? { skillDir: entry.skillDir } : {}),
    ...(entry.materializedAt ? { materializedAt: entry.materializedAt } : {}),
  };
}

function materializationSummaryPayload(entry: WorkspaceSkillMaterialization) {
  return {
    installationId: entry.installationId,
    skillId: entry.skillId,
    name: entry.name,
    versionId: entry.versionId,
    packageSha256: entry.packageSha256,
    source: entry.source,
    target: entry.target,
    removalPolicy: entry.removalPolicy,
  };
}

const materializationMatchesDesired = (
  entry: WorkspaceSkillMaterialization,
  desired: WorkspaceSkillMaterialization,
): boolean =>
  entry.installationId === desired.installationId &&
  entry.skillId === desired.skillId &&
  entry.name === desired.name &&
  entry.versionId === desired.versionId &&
  entry.packageSha256 === desired.packageSha256 &&
  entry.source === desired.source &&
  entry.removalPolicy === desired.removalPolicy &&
  entry.target === desired.target;

async function buildWorkspaceSkillMaterializationStatus(config: ServerConfig, workspace: WorkspaceInfo) {
  const rootDir = workspaceManagedSkillsRoot(workspace.path);
  const manifest = await readSkillMaterializationManifest(rootDir);
  const registryConfigured = Boolean(skillRegistryBaseUrl(config));
  return {
    workspaceId: workspace.id,
    status: registryConfigured ? "pending" : "not-configured",
    registryConfigured,
    rootDir,
    materializedSkills: manifest?.entries.map(materializationEntryPayload) ?? [],
    reloadRequired: registryConfigured,
  };
}

async function buildGlobalSkillMaterializationStatus(config: ServerConfig) {
  const rootDir = personalGlobalManagedSkillsRoot();
  const manifest = await readSkillMaterializationManifest(rootDir);
  const registryConfigured = Boolean(skillRegistryBaseUrl(config));
  const platformSkillSet = await getPlatformManagedPersonalGlobalSkillSet();
  const platformSynced = platformSkillSet.skills.every((skill) =>
    manifest?.entries.some((entry) => materializationMatchesDesired(entry, skill)) ?? false
  );
  const platformPending = platformSkillSet.skills.length > 0 && !platformSynced;
  return {
    scope: "personal-global",
    status: registryConfigured || platformPending ? "pending" : "synced",
    registryConfigured,
    rootDir,
    materializedSkills: manifest?.entries.map(materializationEntryPayload) ?? [],
    platformManaged: {
      enabled: platformSkillSet.skills.length > 0,
      synced: platformSynced,
      desiredSkills: platformSkillSet.skills.map(materializationSummaryPayload),
    },
    reloadRequired: registryConfigured || platformPending,
  };
}

function desiredSkillSetRevision(materializations: WorkspaceSkillMaterialization[]) {
  const payload = materializations
    .map((entry) => ({
      installationId: entry.installationId,
      skillId: entry.skillId,
      name: entry.name,
      versionId: entry.versionId,
      packageSha256: entry.packageSha256,
      source: entry.source,
      target: entry.target,
      removalPolicy: entry.removalPolicy,
    }))
    .sort((left, right) => left.name.localeCompare(right.name) || left.installationId.localeCompare(right.installationId));
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

function registryInstallationToWorkspaceInstallation(input: {
  installation: Awaited<ReturnType<typeof getWorkspaceSkillSetFromRegistry>>["skills"][number];
  workspace: WorkspaceInfo;
  packageResponse: { versionId: string; package: SkillPackageArchive };
  orgId?: string;
  userId?: string;
}): WorkspaceSkillRegistryInstallation {
  const { installation, workspace, packageResponse, orgId, userId } = input;
  return {
    installationId: installation.installationId,
    skillId: installation.skillId,
    name: installation.name?.trim() || packageResponse.package.metadata.name,
    versionId: packageResponse.versionId,
    packageSha256: installation.desiredPackageSha256?.trim() || installation.packageSha256?.trim() || packageResponse.package.packageSha256,
    enabled: installation.enabled,
    source: installation.source,
    installedAt: installation.installedAt,
    ownerUserId: installation.ownerUserId ?? (installation.source === "personal" ? userId : undefined),
    orgId: installation.orgId ?? (installation.source === "organization" ? orgId : undefined),
    workspaceId: installation.workspaceId ?? (installation.source === "workspace" ? workspace.id : undefined),
    approved: installation.approved ?? (installation.source === "personal" ? undefined : true),
    desiredVersionId: installation.desiredVersionId ?? null,
    desiredPackageSha256: installation.desiredPackageSha256 ?? null,
  };
}

function requireRolloutPolicyVersionId(policy: RegistrySkillRolloutPolicy): string {
  const versionId = policy.versionId?.trim();
  if (versionId) return versionId;
  throw new ApiError(
    409,
    "skill_rollout_version_unresolved",
    "Skill rollout policy must resolve to a concrete package version before materialization",
    { policyId: policy.id, skillId: policy.skillId },
  );
}

function registryRolloutPolicyToWorkspacePolicy(input: {
  policy: RegistrySkillRolloutPolicy;
  packageResponse: { versionId: string; package: SkillPackageArchive };
  orgId?: string;
}): WorkspaceSkillRolloutPolicy {
  const { policy, packageResponse, orgId } = input;
  return {
    id: policy.id,
    skillId: policy.skillId,
    name: packageResponse.package.metadata.name,
    versionId: packageResponse.versionId,
    packageSha256: packageResponse.package.packageSha256,
    enabled: policy.enabled,
    source: policy.catalogScope === "organization" ? "organization" : "platform",
    target: policy.target === "user-global" ? "personal-global" : "workspace",
    audience: policy.audience,
    orgId: policy.orgId ?? (policy.catalogScope === "organization" ? orgId : undefined),
    userId: policy.userId ?? undefined,
    workspaceId: policy.workspaceId ?? undefined,
    removalPolicy: policy.removalPolicy,
    updatePolicy: policy.updatePolicy,
    releaseChannel: policy.releaseChannel ?? null,
  };
}

function registryRolloutPolicyAppliesToMaterialization(input: {
  policy: RegistrySkillRolloutPolicy;
  userId?: string;
  orgId?: string;
  workspaceId?: string;
}): boolean {
  const { policy, userId, orgId, workspaceId } = input;
  if (!policy.enabled) return false;
  if (policy.catalogScope === "organization" && (!orgId || policy.orgId !== orgId)) return false;

  if (policy.target === "workspace") {
    return policy.audience === "selected-workspaces" && Boolean(workspaceId && policy.workspaceId === workspaceId);
  }

  if (policy.audience === "user") {
    return Boolean(userId && policy.userId === userId);
  }
  if (policy.audience === "all-org-users") {
    return Boolean(orgId && policy.orgId === orgId);
  }
  return policy.audience === "all-platform-users";
}

function assertNoPlatformManagedPersonalGlobalNameConflicts(input: {
  materializations: WorkspaceSkillMaterialization[];
  platformSkills: WorkspaceSkillMaterialization[];
}) {
  const platformNames = new Set(input.platformSkills.map((skill) => skill.name));
  const duplicate = input.materializations.find((skill) =>
    skill.target === "personal-global" && platformNames.has(skill.name)
  );
  if (!duplicate) return;
  throw new ApiError(
    409,
    "managed_skill_name_conflict",
    `Platform-managed skill ${duplicate.name} conflicts with registry-managed personal-global skill ${duplicate.installationId}`,
    { name: duplicate.name, installationId: duplicate.installationId },
  );
}

async function fetchRegistryWorkspaceMaterializations(
  ctx: RequestContext,
  workspace: WorkspaceInfo,
): Promise<{
  materializations: WorkspaceSkillMaterialization[];
  conflicts: WorkspaceSkillConflict[];
  packagesByInstallationId: Map<string, SkillPackageArchive>;
  personalGlobalSyncRequired: boolean;
  skillSetId: string;
  skillSetRevision: string;
}> {
  const baseUrl = skillRegistryRequestBaseUrl(ctx);
  if (!baseUrl) {
    throw new ApiError(503, "skill_registry_misconfigured", "Skill registry base URL is missing");
  }

  const registryInput = skillRegistryRequestInput(ctx);
  const platformSkillSet = await getPlatformManagedPersonalGlobalSkillSet();
  const skillSet = await getWorkspaceSkillSetFromRegistry({
    ...registryInput,
    workspaceId: workspace.id,
  });

  const registryInstallations: WorkspaceSkillRegistryInstallation[] = [];
  const rolloutPolicies: WorkspaceSkillRolloutPolicy[] = [];
  const packagesByInstallationId = new Map<string, SkillPackageArchive>();
  for (const [installationId, archive] of platformSkillSet.archivesByInstallationId) {
    packagesByInstallationId.set(installationId, archive);
  }
  const seenInstallationIds = new Set<string>();
  const personalGlobalWorkspace: WorkspaceInfo = {
    id: "personal-global",
    name: "Personal global skills",
    path: personalGlobalManagedSkillsRoot(),
    workspaceType: "local",
  };
  let personalGlobalSyncRequired = false;
  const addRegistryInstallation = async (
    installation: typeof skillSet.skills[number],
    targetWorkspace: WorkspaceInfo,
  ) => {
    if (!installation.enabled) return;
    if (seenInstallationIds.has(installation.installationId)) return;
    seenInstallationIds.add(installation.installationId);
    const versionId = installation.desiredVersionId?.trim() || installation.versionId;
    const packageResponse = await downloadSkillPackageFromRegistry({
      ...registryInput,
      versionId,
    });
    const workspaceInstallation = registryInstallationToWorkspaceInstallation({
      installation,
      workspace: targetWorkspace,
      packageResponse,
      orgId: registryInput.orgId,
      userId: registryInput.userId,
    });
    registryInstallations.push(workspaceInstallation);
    packagesByInstallationId.set(workspaceInstallation.installationId, packageResponse.package);
  };

  for (const installation of skillSet.skills) {
    await addRegistryInstallation(installation, workspace);
  }

  const personalGlobalInstallations = await listRegistrySkillInstallations({
    ...registryInput,
    source: "personal",
    target: "personal-global",
  });
  if (personalGlobalInstallations.installations.length > 0) {
    personalGlobalSyncRequired = true;
  }
  for (const installation of personalGlobalInstallations.installations) {
    await addRegistryInstallation(installation, personalGlobalWorkspace);
  }

  for (const query of [
    { target: "workspace" as const, workspaceId: workspace.id },
    { target: "user-global" as const },
  ]) {
    const rolloutPoliciesResponse = await listRegistrySkillRolloutPolicies({
      ...registryInput,
      ...query,
      enabled: true,
    });
    for (const policy of rolloutPoliciesResponse.policies) {
      if (!registryRolloutPolicyAppliesToMaterialization({
        policy,
        userId: registryInput.userId,
        orgId: registryInput.orgId,
        workspaceId: workspace.id,
      })) {
        continue;
      }
      if (policy.target === "user-global") {
        personalGlobalSyncRequired = true;
      }
      const packageResponse = await downloadSkillPackageFromRegistry({
        ...registryInput,
        versionId: requireRolloutPolicyVersionId(policy),
      });
      const workspacePolicy = registryRolloutPolicyToWorkspacePolicy({
        policy,
        packageResponse,
        orgId: registryInput.orgId,
      });
      rolloutPolicies.push(workspacePolicy);
      packagesByInstallationId.set(`rollout:${workspacePolicy.id}`, packageResponse.package);
    }
  }

  const resolution = resolveWorkspaceSkillSet({
    workspace: {
      id: workspace.id,
      scope: registryInput.orgId ? "organization" : "personal",
      orgId: registryInput.orgId,
    },
    user: {
      id: registryInput.userId ?? "local-user",
      orgId: registryInput.orgId,
    },
    registryInstallations,
    rolloutPolicies,
    localUnmanagedSkills: [],
    policy: {},
  });
  assertNoPlatformManagedPersonalGlobalNameConflicts({
    materializations: resolution.requiredMaterializations,
    platformSkills: platformSkillSet.skills,
  });
  const materializations = personalGlobalSyncRequired
    ? [...resolution.requiredMaterializations, ...platformSkillSet.skills]
    : resolution.requiredMaterializations;

  return {
    materializations,
    conflicts: resolution.conflicts,
    packagesByInstallationId,
    personalGlobalSyncRequired,
    skillSetId: skillSet.skillSetId?.trim() || `workspace:${workspace.id}`,
    skillSetRevision: skillSet.revision?.trim() || desiredSkillSetRevision(materializations),
  };
}

async function fetchRegistryPersonalGlobalMaterializations(
  ctx: RequestContext,
): Promise<{
  materializations: WorkspaceSkillMaterialization[];
  conflicts: WorkspaceSkillConflict[];
  packagesByInstallationId: Map<string, SkillPackageArchive>;
}> {
  const baseUrl = skillRegistryRequestBaseUrl(ctx);
  const platformSkillSet = await getPlatformManagedPersonalGlobalSkillSet();
  if (!baseUrl) {
    return {
      materializations: platformSkillSet.skills,
      conflicts: [],
      packagesByInstallationId: platformSkillSet.archivesByInstallationId,
    };
  }

  const registryInput = skillRegistryRequestInput(ctx);
  const installations = await listRegistrySkillInstallations({
    ...registryInput,
    source: "personal",
    target: "personal-global",
  });

  const registryInstallations: WorkspaceSkillRegistryInstallation[] = [];
  const rolloutPolicies: WorkspaceSkillRolloutPolicy[] = [];
  const packagesByInstallationId = new Map<string, SkillPackageArchive>();
  for (const [installationId, archive] of platformSkillSet.archivesByInstallationId) {
    packagesByInstallationId.set(installationId, archive);
  }
  const personalGlobalWorkspace: WorkspaceInfo = {
    id: "personal-global",
    name: "Personal global skills",
    path: personalGlobalManagedSkillsRoot(),
    workspaceType: "local",
  };
  for (const installation of installations.installations) {
    if (!installation.enabled) continue;
    const packageResponse = await downloadSkillPackageFromRegistry({
      ...registryInput,
      versionId: installation.versionId,
    });
    const workspaceInstallation = registryInstallationToWorkspaceInstallation({
      installation,
      workspace: personalGlobalWorkspace,
      packageResponse,
      orgId: registryInput.orgId,
      userId: registryInput.userId,
    });
    registryInstallations.push(workspaceInstallation);
    packagesByInstallationId.set(workspaceInstallation.installationId, packageResponse.package);
  }

  const rolloutPoliciesResponse = await listRegistrySkillRolloutPolicies({
    ...registryInput,
    target: "user-global",
    enabled: true,
  });
  for (const policy of rolloutPoliciesResponse.policies) {
    if (!registryRolloutPolicyAppliesToMaterialization({
      policy,
      userId: registryInput.userId,
      orgId: registryInput.orgId,
    })) {
      continue;
    }
    const packageResponse = await downloadSkillPackageFromRegistry({
      ...registryInput,
      versionId: requireRolloutPolicyVersionId(policy),
    });
    const workspacePolicy = registryRolloutPolicyToWorkspacePolicy({
      policy,
      packageResponse,
      orgId: registryInput.orgId,
    });
    rolloutPolicies.push(workspacePolicy);
    packagesByInstallationId.set(`rollout:${workspacePolicy.id}`, packageResponse.package);
  }

  const resolution = resolveWorkspaceSkillSet({
    workspace: {
      id: personalGlobalWorkspace.id,
      scope: registryInput.orgId ? "organization" : "personal",
      orgId: registryInput.orgId,
    },
    user: {
      id: registryInput.userId ?? "local-user",
      orgId: registryInput.orgId,
    },
    registryInstallations,
    rolloutPolicies,
    localUnmanagedSkills: [],
    policy: {},
  });
  assertNoPlatformManagedPersonalGlobalNameConflicts({
    materializations: resolution.requiredMaterializations,
    platformSkills: platformSkillSet.skills,
  });
  const materializations = [...resolution.requiredMaterializations, ...platformSkillSet.skills];

  return { materializations, conflicts: resolution.conflicts, packagesByInstallationId };
}

const trimmedSearchParam = (params: URLSearchParams, key: string): string | undefined => {
  const value = params.get(key)?.trim();
  return value || undefined;
};

const parseSkillRemovalScope = (value: string | undefined): SkillRemovalScope | undefined => {
  if (!value) return undefined;
  if (value === "workspace" || value === "user-global") return value;
  throw new ApiError(400, "invalid_scope", "Skill removal scope must be workspace or user-global");
};

type SkillBatchRemoveScope = "workspace" | "user-global" | "organization";

type SkillBatchRemoveItem = {
  id?: string;
  index: number;
  name: string;
  scope: SkillBatchRemoveScope;
  path?: string;
  workspaceId?: string;
  reason?: string;
  registry?: {
    installationId?: string;
    policyId?: string;
  };
};

type SkillBatchRemoveSuccess = {
  id?: string;
  index: number;
  ok: true;
  name: string;
  scope: SkillBatchRemoveScope;
  path?: string;
  removalId?: string;
  reloadRequired?: boolean;
  registry?: {
    installationId?: string;
    policyId?: string;
  };
  trigger?: ReloadTrigger & { scope?: SkillBatchRemoveScope };
};

type SkillBatchRemoveFailure = {
  id?: string;
  index: number;
  ok: false;
  name?: string;
  scope?: string;
  code: string;
  message: string;
  status: number;
  details?: unknown;
};

const optionalRecordString = (record: Record<string, unknown>, field: string): string | undefined => {
  const value = record[field];
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
};

const parseSkillBatchRemoveItem = (value: unknown, index: number): SkillBatchRemoveItem => {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_skill_batch_item", "Skill batch item must be an object");
  }
  const record = value as Record<string, unknown>;
  const name = optionalRecordString(record, "name");
  if (!name) {
    throw new ApiError(400, "invalid_skill_batch_item", "Skill batch item name is required");
  }
  const rawScope = optionalRecordString(record, "scope");
  if (rawScope !== "workspace" && rawScope !== "user-global" && rawScope !== "organization") {
    throw new ApiError(
      400,
      "invalid_skill_batch_item",
      "Skill batch item scope must be workspace, user-global, or organization",
    );
  }
  const registryValue = record.registry;
  let registry: SkillBatchRemoveItem["registry"];
  if (registryValue !== undefined) {
    if (!registryValue || typeof registryValue !== "object" || Array.isArray(registryValue)) {
      throw new ApiError(400, "invalid_skill_batch_item", "Skill batch item registry must be an object");
    }
    const registryRecord = registryValue as Record<string, unknown>;
    const installationId = optionalRecordString(registryRecord, "installationId");
    const policyId = optionalRecordString(registryRecord, "policyId");
    if (installationId && policyId) {
      throw new ApiError(
        400,
        "invalid_skill_batch_item",
        "Skill batch item must not include both registry.installationId and registry.policyId",
      );
    }
    if (installationId || policyId) registry = { installationId, policyId };
  }

  return {
    index,
    name,
    scope: rawScope,
    ...(optionalRecordString(record, "id") ? { id: optionalRecordString(record, "id") } : {}),
    ...(optionalRecordString(record, "path") ? { path: optionalRecordString(record, "path") } : {}),
    ...(optionalRecordString(record, "workspaceId") ? { workspaceId: optionalRecordString(record, "workspaceId") } : {}),
    ...(optionalRecordString(record, "reason") ? { reason: optionalRecordString(record, "reason") } : {}),
    ...(registry ? { registry } : {}),
  };
};

const skillBatchRemoveFailure = (
  value: unknown,
  index: number,
  error: unknown,
): SkillBatchRemoveFailure => {
  const record = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const apiError = error instanceof ApiError
    ? error
    : new ApiError(500, "internal_error", "Unexpected server error");
  return {
    ...(optionalRecordString(record, "id") ? { id: optionalRecordString(record, "id") } : {}),
    index,
    ok: false,
    ...(optionalRecordString(record, "name") ? { name: optionalRecordString(record, "name") } : {}),
    ...(optionalRecordString(record, "scope") ? { scope: optionalRecordString(record, "scope") } : {}),
    code: apiError.code,
    message: apiError.message,
    status: apiError.status,
    ...(apiError.details !== undefined ? { details: apiError.details } : {}),
  };
};

type SkillRemovalListItem = {
  id: string;
  name: string;
  scope: SkillRemovalScope;
  workspaceId?: string;
  path: string;
  reason?: string;
  status: "removed" | "restored";
  removedAt: string;
  restoredAt?: string;
  canRestore: boolean;
};

const serializeSkillRemoval = (record: SkillRemovalRecord): SkillRemovalListItem => ({
  id: record.id,
  name: record.name,
  scope: record.scope,
  ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
  path: record.originalPath,
  ...(record.reason ? { reason: record.reason } : {}),
  status: record.restoredAt ? "restored" : "removed",
  removedAt: record.removedAt ?? "",
  ...(record.restoredAt ? { restoredAt: record.restoredAt } : {}),
  canRestore: !record.restoredAt,
});

function requireBodyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new ApiError(400, "invalid_request", `Field ${field} is required`);
  }
  return value.trim();
}

function optionalBodyString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  if (typeof value !== "string") return undefined;
  return value.trim() || undefined;
}

function optionalBodyNullableString(body: Record<string, unknown>, field: string): string | null | undefined {
  if (body[field] === null) return null;
  return optionalBodyString(body, field);
}

function optionalBodyBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field];
  return typeof value === "boolean" ? value : undefined;
}

function optionalBodyHttpUrl(body: Record<string, unknown>, field: string): string | undefined {
  const value = optionalBodyString(body, field);
  if (!value) return undefined;
  if (!value.startsWith("http://") && !value.startsWith("https://")) {
    throw new ApiError(400, "invalid_payload", `${field} must start with http:// or https://`);
  }
  return value.replace(/\/+$/, "");
}

function requireBodyObject(body: Record<string, unknown>, field: string): Record<string, unknown> {
  const value = body[field];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_request", `Field ${field} is required`);
  }
  return value as Record<string, unknown>;
}

function requireNonEmptyPayloadString(value: unknown, name: string): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) {
    throw new ApiError(400, "invalid_payload", `${name} is required`);
  }
  return trimmed;
}

function optionalPayloadString(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_payload", `${name} must be a string or null`);
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function optionalNullablePayloadString(value: unknown, name: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") {
    throw new ApiError(400, "invalid_payload", `${name} must be a string or null`);
  }
  const trimmed = value.trim();
  return trimmed || null;
}

function parseAutomationTargetPayload(value: unknown, previous: AutomationTarget = {}): AutomationTarget {
  if (value === undefined) return previous;
  if (value === null) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_payload", "target must be an object or null");
  }
  const target = value as Record<string, unknown>;
  const next: AutomationTarget = { ...previous };
  const preferredSessionId = optionalPayloadString(target.preferredSessionId, "target.preferredSessionId");
  const fallbackTitle = optionalPayloadString(target.fallbackTitle, "target.fallbackTitle");
  const agent = optionalPayloadString(target.agent, "target.agent");
  const model = optionalNullablePayloadString(target.model, "target.model");
  const variant = optionalNullablePayloadString(target.variant, "target.variant");
  if (preferredSessionId !== undefined) {
    if (preferredSessionId) next.preferredSessionId = preferredSessionId;
    else delete next.preferredSessionId;
  }
  if (fallbackTitle !== undefined) {
    if (fallbackTitle) next.fallbackTitle = fallbackTitle;
    else delete next.fallbackTitle;
  }
  if (agent !== undefined) {
    if (agent) next.agent = agent;
    else delete next.agent;
  }
  if (model !== undefined) next.model = model;
  if (variant !== undefined) next.variant = variant;
  return next;
}

function parseOptionalAutomationStatus(value: unknown): AutomationStatus | undefined {
  if (value === undefined || value === null) return undefined;
  return parseAutomationStatus(value);
}

function resolveAutomationState(
  input: { enabled?: unknown; status?: unknown },
  previous: { enabled: boolean; status: AutomationStatus },
): { enabled: boolean; status: AutomationStatus } {
  if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
    throw new ApiError(400, "invalid_payload", "enabled must be a boolean");
  }
  const explicitStatus = parseOptionalAutomationStatus(input.status);
  let enabled = typeof input.enabled === "boolean" ? input.enabled : previous.enabled;
  let status = explicitStatus ?? previous.status;

  if (explicitStatus) {
    enabled = explicitStatus === "active";
  } else if (typeof input.enabled === "boolean") {
    status = input.enabled ? "active" : "paused";
  }

  if (status !== "active") {
    enabled = false;
  }
  if (status === "active" && !enabled) {
    status = "paused";
  }
  return { enabled, status };
}

function isTerminalAutomationStatus(status: AutomationStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function canReactivateWithSchedule(schedule: AutomationSchedule): boolean {
  if (schedule.kind !== "oneShot") {
    return true;
  }
  return Date.parse(schedule.runAt) > Date.now();
}

function nextAutomationRunAt(
  schedule: AutomationSchedule,
  state: { enabled: boolean; status: AutomationStatus },
): string | null {
  if (!state.enabled || state.status !== "active") {
    return null;
  }
  return computeNextAutomationRunAt(schedule, Date.now());
}

function validateAutomationId(value: unknown): string {
  const raw = typeof value === "string" ? value.trim() : "";
  if (!raw) {
    throw new ApiError(400, "invalid_payload", "automation id is required");
  }
  if (raw.length > 80) {
    throw new ApiError(400, "invalid_payload", "automation id is too long");
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
    throw new ApiError(400, "invalid_payload", "automation id must match /^[a-zA-Z0-9_-]+$/");
  }
  return raw;
}

function createAutomationFromPayload(
  workspace: WorkspaceInfo,
  body: Record<string, unknown>,
): VesloAutomation {
  const name = requireNonEmptyPayloadString(body.name, "name");
  const prompt = requireNonEmptyPayloadString(body.prompt, "prompt");
  const schedule = parseAutomationSchedule(body.schedule);
  const state = resolveAutomationState(
    { enabled: body.enabled, status: body.status },
    { enabled: true, status: "active" },
  );
  const now = new Date().toISOString();
  const id = body.id === undefined || body.id === null
    ? `automation_${shortId().replace(/-/g, "")}`
    : validateAutomationId(body.id);

  return {
    id,
    workspaceId: workspace.id,
    name,
    enabled: state.enabled,
    status: state.status,
    schedule,
    prompt,
    target: parseAutomationTargetPayload(body.target),
    createdAt: now,
    updatedAt: now,
    nextRunAt: nextAutomationRunAt(schedule, state),
    completedAt: null,
    lastRunId: null,
  };
}

function updateAutomationFromPayload(
  existing: VesloAutomation,
  body: Record<string, unknown>,
): VesloAutomation {
  const name = body.name === undefined ? existing.name : requireNonEmptyPayloadString(body.name, "name");
  const prompt = body.prompt === undefined ? existing.prompt : requireNonEmptyPayloadString(body.prompt, "prompt");
  const schedule = body.schedule === undefined ? existing.schedule : parseAutomationSchedule(body.schedule);
  const wantsActive = body.enabled === true || body.status === "active";
  if (isTerminalAutomationStatus(existing.status) && wantsActive) {
    const allowed = body.status === "active" && body.schedule !== undefined && canReactivateWithSchedule(schedule);
    if (!allowed) {
      throw new ApiError(
        409,
        "automation_terminal",
        "Terminal automations require an explicit active status and updated future or recurring schedule to reactivate",
      );
    }
  }
  const state = resolveAutomationState(
    { enabled: body.enabled, status: body.status },
    { enabled: existing.enabled, status: existing.status },
  );
  return {
    ...existing,
    name,
    prompt,
    schedule,
    enabled: state.enabled,
    status: state.status,
    target: parseAutomationTargetPayload(body.target, existing.target),
    updatedAt: new Date().toISOString(),
    nextRunAt: nextAutomationRunAt(schedule, state),
    completedAt: state.status === "completed" ? existing.completedAt ?? new Date().toISOString() : existing.completedAt ?? null,
  };
}

function toLegacyAgentLabAutomation(
  automation: VesloAutomation,
  runs: AutomationRun[],
): AgentLabAutomation {
  const lastRun = automation.lastRunId
    ? runs.find((run) => run.id === automation.lastRunId)
    : [...runs].reverse().find((run) => run.automationId === automation.id);
  return {
    id: automation.id,
    name: automation.name,
    enabled: automation.enabled,
    schedule: automation.schedule as AgentLabSchedule,
    prompt: automation.prompt,
    createdAt: Date.parse(automation.createdAt),
    updatedAt: Date.parse(automation.updatedAt),
    lastRunAt: lastRun?.finishedAt ? Date.parse(lastRun.finishedAt) : undefined,
    lastRunSessionId: lastRun?.sessionId ?? undefined,
  };
}

function isLegacyAgentLabSchedule(schedule: AutomationSchedule): schedule is AgentLabSchedule {
  return schedule.kind === "interval" || schedule.kind === "daily" || schedule.kind === "weekly";
}

function legacyAgentLabStoreFromAutomations(store: { updatedAt: string; items: VesloAutomation[]; runs: AutomationRun[] }): AgentLabAutomationStore {
  return {
    schemaVersion: 1,
    updatedAt: Date.parse(store.updatedAt),
    items: store.items
      .filter((item) => isLegacyAgentLabSchedule(item.schedule))
      .map((item) => toLegacyAgentLabAutomation(item, store.runs)),
  };
}

function createRoutes(
  config: ServerConfig,
  approvals: ApprovalService,
  tokens: TokenService,
  automationRunner: AutomationRunner,
): Route[] {
  const routes: Route[] = [];
  const serializeWorkspaceForResponse = (workspace: WorkspaceInfo) => serializeWorkspace(workspace, config);
  const serverDataDir = resolveVesloDataDir();
  const fileSessions = new FileSessionStore();
  const sessionArchives = createSessionArchiveStore();
  const conversationReadStore = createConversationReadStore();
  const conversationBindingStore = createConversationBindingStore({ dataDir: serverDataDir });
  const conversationTranscriptStore = createConversationTranscriptStore({ dataDir: serverDataDir });
  const conversationRunQueueStore = createConversationRunQueueStore({ dataDir: serverDataDir });
  const conversationService = createConversationService({
    readStore: conversationReadStore,
    bindingStore: conversationBindingStore,
    transcriptStore: conversationTranscriptStore,
    createOpenCodeSession: async ({ workspace, directory, title, sendTraceId }) => {
      const scopedWorkspace = directory ? { ...workspace, directory } : workspace;
      return await fetchOpencodeJsonWithOrchestratorFallback(config, scopedWorkspace, "/session", {
        method: "POST",
        timeoutMs: OPENCODE_SESSION_CREATE_TIMEOUT_MS,
        sendTraceId,
        body: {
          ...(directory ? { directory } : {}),
          ...(title?.trim() ? { title: title.trim() } : {}),
        },
      });
    },
  });
  const lifecycleClient =
    config.orchestratorDaemonUrl && config.orchestratorLifecycleToken
      ? createOrchestratorLifecycleClient({
          daemonUrl: config.orchestratorDaemonUrl,
          token: config.orchestratorLifecycleToken,
        })
      : null;

  const sessionTranscriptPrefetch = createSessionTranscriptPrefetchStore({
    loadTranscript: async ({ workspaceId, sessionId, limit, directory }) => {
      const workspace = await resolveWorkspace(config, workspaceId);
      const resolvedDirectory = directory ?? resolveOpencodeDirectory(workspace);
      return await conversationService.loadTranscript({
        workspace,
        sessionId,
        directory: resolvedDirectory,
        limit,
      });
    },
  });

  const loadConversationTranscriptResponse = async (input: {
    workspace: WorkspaceInfo;
    sessionOrConversationId: string;
    limit: number;
    directory: string | null;
  }) => {
    const binding = await conversationService.resolveOpenCodeSessionForRead({
      workspaceId: input.workspace.id,
      directory: input.directory,
      sessionOrConversationId: input.sessionOrConversationId,
    });
    if (!binding && isVesloConversationId(input.sessionOrConversationId)) {
      throw new ApiError(404, "conversation_not_found", "Conversation was not found in this workspace");
    }
    const opencodeSessionId = binding?.engineSessionId ?? input.sessionOrConversationId;
    const snapshot = await sessionTranscriptPrefetch.getOrLoad({
      workspaceId: input.workspace.id,
      sessionId: opencodeSessionId,
      limit: input.limit,
      directory: input.directory,
    });
    return {
      workspaceId: input.workspace.id,
      sessionId: opencodeSessionId,
      conversationId: binding?.conversationId,
      opencodeSessionId,
      limit: snapshot.limit,
      messages: snapshot.messages,
      partsByMessageId: snapshot.partsByMessageId,
      fetchedAt: snapshot.fetchedAt,
      staleAt: snapshot.staleAt,
      source: snapshot.source,
    };
  };

  const resolveConversationExecutionTarget = async (input: {
    workspace: WorkspaceInfo;
    sessionOrConversationId: string;
    requestedDirectory: string | undefined;
    missingDirectoryMessage: string;
  }) => {
    if (!input.requestedDirectory) {
      throw new ApiError(400, "invalid_directory", input.missingDirectoryMessage);
    }
    const directory = await resolveConversationReadDirectory(
      input.workspace,
      input.requestedDirectory,
    );
    if (!directory) {
      throw new ApiError(400, "invalid_directory", "Conversation directory is required");
    }
    const binding = await conversationService.resolveOpenCodeSessionForRead({
      workspaceId: input.workspace.id,
      directory,
      sessionOrConversationId: input.sessionOrConversationId,
    });
    if (!binding && isVesloConversationId(input.sessionOrConversationId)) {
      throw new ApiError(404, "conversation_not_found", "Conversation was not found in this workspace");
    }
    return {
      directory,
      binding,
      opencodeSessionId: binding?.engineSessionId ?? input.sessionOrConversationId,
      conversationId: binding?.conversationId ?? input.sessionOrConversationId,
    };
  };

  type ConversationExecutionTarget = Awaited<ReturnType<typeof resolveConversationExecutionTarget>>;

  const buildConversationRunSubmitPath = (
    kind: "prompt_async" | "command" | "shell" | "summarize",
    opencodeSessionId: string,
    directory: string,
  ) => {
    const query = new URLSearchParams();
    query.set("directory", directory);
    return kind === "prompt_async"
      ? `/session/${encodeURIComponent(opencodeSessionId)}/prompt_async?${query.toString()}`
      : kind === "command"
        ? `/session/${encodeURIComponent(opencodeSessionId)}/command?${query.toString()}`
          : kind === "shell"
            ? `/session/${encodeURIComponent(opencodeSessionId)}/shell?${query.toString()}`
            : `/session/${encodeURIComponent(opencodeSessionId)}/summarize?${query.toString()}`;
  };

  const submitConversationRunToOpenCode = async (input: {
    runTrace: ConversationRunTracer;
    workspace: WorkspaceInfo;
    target: ConversationExecutionTarget;
    runId: string;
    kind: "prompt_async" | "command" | "shell" | "summarize";
    body: Record<string, unknown>;
    clientMessageId: string | null;
    origin: string | null;
    expectAiGatewayStart: boolean;
    lifecycleOwner: OrchestratorLifecycleClient | null;
  }) => {
    const {
      runTrace,
      workspace,
      target,
      runId,
      kind,
      body,
      clientMessageId,
      origin,
      expectAiGatewayStart,
      lifecycleOwner,
    } = input;
    const path = buildConversationRunSubmitPath(kind, target.opencodeSessionId, target.directory);
    const aiGatewayProviderWatchStartedAt = Date.now();
    const opencodeRunBody = buildConversationRunBody(kind, body);
    runTrace.record("server:conversation-run:opencode-submit-body", {
      workspaceId: workspace.id,
      conversationId: target.conversationId,
      runId,
      kind,
      clientMessageId,
      origin,
      opencodeSessionId: target.opencodeSessionId,
      body: summarizeConversationRunBodyForTrace(opencodeRunBody),
    });
    if (kind === "prompt_async" && expectAiGatewayStart) {
      registerActiveAiGatewayRun({
        traceId: runTrace.traceId,
        workspaceId: workspace.id,
        conversationId: target.conversationId,
        runId,
        opencodeSessionId: target.opencodeSessionId,
        clientMessageId,
        origin,
      });
    }
    let upstream: unknown;
    try {
      upstream = await runTrace.step(
        "server:conversation-run:opencode-submit",
        () => fetchOpencodeJsonWithOrchestratorFallback(config, { ...workspace, directory: target.directory }, path, {
          method: "POST",
          timeoutMs: OPENCODE_CONVERSATION_SUBMIT_TIMEOUT_MS,
          body: opencodeRunBody,
          sendTraceId: runTrace.traceId,
        }),
        {
          workspaceId: workspace.id,
          conversationId: target.conversationId,
          runId,
          kind,
          clientMessageId,
          origin,
          opencodeSessionId: target.opencodeSessionId,
        },
      );
    } catch (error) {
      if (lifecycleOwner) {
        await runTrace.step(
          "server:conversation-run:lifecycle-mark-failed",
          () => lifecycleOwner.markFailed(
            workspace.id,
            runId,
            error instanceof Error ? error.message : String(error),
          ),
          {
            workspaceId: workspace.id,
            conversationId: target.conversationId,
            runId,
          },
        ).catch(() => undefined);
      }
      throw error;
    }
    if (lifecycleOwner && kind === "prompt_async" && expectAiGatewayStart) {
      const providerStart = await runTrace.step(
        "server:conversation-run:ai-gateway-provider-start-watch",
        () => waitForAiGatewayProviderStart({
          workspaceId: workspace.id,
          conversationId: target.conversationId,
          runId,
          opencodeSessionId: target.opencodeSessionId,
          clientMessageId,
          origin,
          startedAt: aiGatewayProviderWatchStartedAt,
        }),
        {
          workspaceId: workspace.id,
          conversationId: target.conversationId,
          runId,
          clientMessageId,
          origin,
          opencodeSessionId: target.opencodeSessionId,
        },
      );
      if (!providerStart.started) {
        const error = `AI gateway provider request did not start within ${providerStart.timeoutMs}ms.`;
        await runTrace.step(
          "server:conversation-run:lifecycle-mark-failed-ai-gateway-provider-start-timeout",
          () => lifecycleOwner.markFailed(workspace.id, runId, error),
          {
            workspaceId: workspace.id,
            conversationId: target.conversationId,
            runId,
            opencodeSessionId: target.opencodeSessionId,
            timeoutMs: providerStart.timeoutMs,
          },
        ).catch(() => undefined);
        const abortQuery = new URLSearchParams();
        abortQuery.set("directory", target.directory);
        await runTrace.step(
          "server:conversation-run:opencode-abort-ai-gateway-provider-start-timeout",
          () => fetchOpencodeJsonWithOrchestratorFallback(
            config,
            { ...workspace, directory: target.directory },
            `/session/${encodeURIComponent(target.opencodeSessionId)}/abort?${abortQuery.toString()}`,
            { method: "POST", sendTraceId: runTrace.traceId },
          ),
          {
            workspaceId: workspace.id,
            conversationId: target.conversationId,
            runId,
            opencodeSessionId: target.opencodeSessionId,
          },
        ).catch((abortError) => {
          runTrace.record("server:conversation-run:opencode-abort-ai-gateway-provider-start-timeout:error", {
            workspaceId: workspace.id,
            conversationId: target.conversationId,
            runId,
            opencodeSessionId: target.opencodeSessionId,
            error: abortError instanceof Error ? abortError.message : String(abortError),
          });
        });
        throw new ApiError(504, "ai_gateway_provider_start_timeout", error, {
          workspaceId: workspace.id,
          conversationId: target.conversationId,
          runId,
          opencodeSessionId: target.opencodeSessionId,
          clientMessageId,
          origin,
          timeoutMs: providerStart.timeoutMs,
        });
      }
    }
    return upstream;
  };

  const conversationQueueKey = (workspaceId: string, conversationId: string) => `${workspaceId}\0${conversationId}`;
  const conversationQueueDrainTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const conversationQueueDrainInFlight = new Set<string>();
  const CONVERSATION_QUEUE_DRAIN_POLL_MS = 1_500;

  const scheduleConversationQueueDrain = (
    workspaceId: string,
    conversationId: string,
    delayMs = 0,
  ) => {
    const key = conversationQueueKey(workspaceId, conversationId);
    const existing = conversationQueueDrainTimers.get(key);
    if (existing) {
      if (delayMs > 0) return;
      clearTimeout(existing);
      conversationQueueDrainTimers.delete(key);
    }
    const timer = setTimeout(() => {
      conversationQueueDrainTimers.delete(key);
      void drainConversationQueue(workspaceId, conversationId);
    }, Math.max(0, delayMs));
    (timer as { unref?: () => void }).unref?.();
    conversationQueueDrainTimers.set(key, timer);
  };

  const enqueueConversationRun = (input: {
    runTrace: ConversationRunTracer;
    workspace: WorkspaceInfo;
    target: ConversationExecutionTarget;
    runId: string;
    kind: "prompt_async" | "command" | "shell" | "summarize";
    body: Record<string, unknown>;
    clientMessageId: string | null;
    origin: string | null;
    activeRunId: string | null;
  }) => {
    const bodyJson = JSON.stringify({
      ...input.body,
      directory: input.target.directory,
      kind: input.kind,
      ...(input.clientMessageId ? { clientMessageId: input.clientMessageId } : {}),
      ...(input.origin ? { origin: input.origin } : {}),
    });
    const queued = conversationRunQueueStore.enqueue({
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      opencodeSessionId: input.target.opencodeSessionId,
      directory: input.target.directory,
      reservedRunId: input.runId,
      clientMessageId: input.clientMessageId,
      origin: input.origin,
      kind: input.kind,
      bodyJson,
      activeRunId: input.activeRunId,
    });
    input.runTrace.record("server:conversation-run:queued", {
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      opencodeSessionId: input.target.opencodeSessionId,
      runId: queued.item.reservedRunId,
      queueItemId: queued.item.queueItemId,
      activeRunId: queued.item.activeRunId,
      queuePosition: queued.queuePosition,
      inserted: queued.inserted,
      clientMessageId: input.clientMessageId,
      origin: input.origin,
    });
    scheduleConversationQueueDrain(input.workspace.id, input.target.conversationId, CONVERSATION_QUEUE_DRAIN_POLL_MS);
    return jsonResponse({
      ok: true,
      workspaceId: input.workspace.id,
      conversationId: input.target.conversationId,
      opencodeSessionId: input.target.opencodeSessionId,
      runId: queued.item.reservedRunId,
      reservedRunId: queued.item.reservedRunId,
      queueItemId: queued.item.queueItemId,
      activeRunId: queued.item.activeRunId,
      queuePosition: queued.queuePosition,
      clientMessageId: input.clientMessageId,
      origin: input.origin,
      status: "queued",
      kind: input.kind,
      debugTrace: input.runTrace.entries,
    }, queued.inserted ? 202 : 200);
  };

  async function drainConversationQueue(workspaceId: string, conversationId: string): Promise<void> {
    const key = conversationQueueKey(workspaceId, conversationId);
    if (conversationQueueDrainInFlight.has(key)) return;
    conversationQueueDrainInFlight.add(key);
    let item: ConversationRunQueueItem | null = null;
    try {
      const workspace = config.workspaces.find((candidate) => candidate.id === workspaceId);
      if (!workspace) return;
      const lifecycleOwner = workspace.workspaceType === "remote" ? null : lifecycleClient;
      const runTrace = createBackgroundConversationRunTracer();
      if (lifecycleOwner) {
        try {
          const latest = await lifecycleOwner.status(workspace.id, conversationId, "latest");
          if (latest && isActiveLifecycleStatus(latest.status)) {
            scheduleConversationQueueDrain(workspaceId, conversationId, CONVERSATION_QUEUE_DRAIN_POLL_MS);
            return;
          }
        } catch (error) {
          runTrace.record("server:conversation-run:queue-drain-status-error", {
            workspaceId,
            conversationId,
            message: error instanceof Error ? error.message : String(error),
          });
          scheduleConversationQueueDrain(workspaceId, conversationId, CONVERSATION_QUEUE_DRAIN_POLL_MS);
          return;
        }
      }

      item = conversationRunQueueStore.nextPending(workspaceId, conversationId);
      if (!item) return;
      item = conversationRunQueueStore.markStarting(item.queueItemId);
      if (!item || item.state !== "starting") return;

      let body: Record<string, unknown>;
      try {
        const parsed = JSON.parse(item.bodyJson) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          throw new Error("queued run body must be an object");
        }
        body = parsed as Record<string, unknown>;
      } catch (error) {
        conversationRunQueueStore.markFailed(item.queueItemId, error instanceof Error ? error.message : String(error));
        return;
      }

      const kind = parseConversationRunKind(item.kind);
      const expectAiGatewayStart = optionalBodyBoolean(body, "expectAiGatewayStart") === true;
      const target: ConversationExecutionTarget = {
        directory: item.directory,
        binding: null,
        opencodeSessionId: item.opencodeSessionId,
        conversationId: item.conversationId,
      };

      if (lifecycleOwner) {
        try {
          await runTrace.step(
            "server:conversation-run:queue-lifecycle-register",
            () => lifecycleOwner.register({
              workspaceId: workspace.id,
              conversationId: item!.conversationId,
              runId: item!.reservedRunId,
              engineSessionId: item!.opencodeSessionId,
              directory: item!.directory,
              kind: lifecycleRunKind(kind),
            }),
            {
              workspaceId: workspace.id,
              conversationId: item.conversationId,
              runId: item.reservedRunId,
              engineSessionId: item.opencodeSessionId,
              queueItemId: item.queueItemId,
            },
          );
        } catch (error) {
          if (error instanceof RunAlreadyActiveError) {
            conversationRunQueueStore.markPending(item.queueItemId, error.activeRunId);
            scheduleConversationQueueDrain(workspaceId, conversationId, CONVERSATION_QUEUE_DRAIN_POLL_MS);
            return;
          }
          conversationRunQueueStore.markFailed(item.queueItemId, error instanceof Error ? error.message : String(error));
          return;
        }
      }

      await submitConversationRunToOpenCode({
        runTrace,
        workspace,
        target,
        runId: item.reservedRunId,
        kind,
        body,
        clientMessageId: item.clientMessageId,
        origin: item.origin,
        expectAiGatewayStart,
        lifecycleOwner,
      });
      conversationRunQueueStore.markSubmitted(item.queueItemId);
      scheduleConversationQueueDrain(workspaceId, conversationId, CONVERSATION_QUEUE_DRAIN_POLL_MS);
    } catch (error) {
      if (item) {
        conversationRunQueueStore.markFailed(item.queueItemId, error instanceof Error ? error.message : String(error));
      }
    } finally {
      conversationQueueDrainInFlight.delete(key);
    }
  }

  const reconcileConversationLifecycleAfterTranscriptAppend = (input: {
    workspace: WorkspaceInfo;
    conversationId: string;
    sessionId: string;
    reason: string;
    shouldReconcile: boolean;
  }) => {
    if (!input.shouldReconcile) return;
    const conversationId = input.conversationId.trim();
    if (!conversationId) return;
    const lifecycleOwner = input.workspace.workspaceType === "remote" ? null : lifecycleClient;
    if (!lifecycleOwner) return;

    void (async () => {
      try {
        const latest = await lifecycleOwner.status(input.workspace.id, conversationId, "latest");
        recordSendWorkflowTrace("server", "server:conversation-run:transcript-reconcile", {
          workspaceId: input.workspace.id,
          conversationId,
          sessionId: input.sessionId,
          reason: input.reason || null,
          runId: latest?.runId ?? null,
          status: latest?.status ?? null,
          stale: latest?.stale ?? null,
        });
        if (latest && !isActiveLifecycleStatus(latest.status)) {
          scheduleConversationQueueDrain(input.workspace.id, conversationId, 0);
        }
      } catch (error) {
        recordSendWorkflowTrace("server", "server:conversation-run:transcript-reconcile-error", {
          workspaceId: input.workspace.id,
          conversationId,
          sessionId: input.sessionId,
          reason: input.reason || null,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    })();
  };

  for (const pending of conversationRunQueueStore.pendingConversationKeys()) {
    scheduleConversationQueueDrain(pending.workspaceId, pending.conversationId, CONVERSATION_QUEUE_DRAIN_POLL_MS);
  }

  const serializeFileSession = (session: {
    id: string;
    workspaceId: string;
    createdAt: number;
    expiresAt: number;
    canWrite: boolean;
  }) => ({
    id: session.id,
    workspaceId: session.workspaceId,
    createdAt: session.createdAt,
    expiresAt: session.expiresAt,
    ttlMs: Math.max(0, session.expiresAt - Date.now()),
    canWrite: session.canWrite,
  });

  const resolveFileSession = (ctx: RequestContext, sessionId: string) => {
    const session = fileSessions.get(sessionId);
    if (!session) {
      throw new ApiError(404, "file_session_not_found", "File session not found");
    }

    if (!ctx.actor?.tokenHash || session.actorTokenHash !== ctx.actor.tokenHash) {
      throw new ApiError(403, "forbidden", "File session does not belong to this token");
    }

    const workspace = config.workspaces.find((item) => item.id === session.workspaceId);
    if (!workspace) {
      throw new ApiError(404, "workspace_not_found", "Workspace not found for this file session");
    }

    return { session, workspace };
  };

  const readOrganizationSoulModel = async (ctx: RequestContext) => {
    const den = soulDenContext(ctx);
    const ownerId = den.orgId ?? "organization";
    if (den.baseUrl && den.denToken && den.orgId) {
      try {
        const document = await getOrganizationSoul({ ...den, token: den.denToken });
        await cacheSoulDocument({ dataDir: serverDataDir, document });
        return {
          document,
          summary: soulSummary({
            scope: "organization",
            ownerId: document.ownerId,
            document,
            canEdit: soulCanEdit(ctx, "organization"),
          }),
          denSynced: true,
        };
      } catch (error) {
        if (!isSoulDenUnavailable(error)) throw error;
      }
    }

    const cached = den.orgId
      ? await readCachedSoulDocument({ dataDir: serverDataDir, scope: "organization", ownerId: den.orgId })
      : null;
    return {
      document: cached,
      summary: soulSummary({
        scope: "organization",
        ownerId,
        document: cached,
        canEdit: soulCanEdit(ctx, "organization"),
      }),
      denSynced: false,
    };
  };

  const readUserSoulModel = async (ctx: RequestContext) => {
    const den = soulDenContext(ctx);
    const ownerId = den.userId ?? "user";
    if (den.baseUrl && den.denToken && den.userId) {
      try {
        const document = await getUserSoul({ ...den, token: den.denToken });
        await cacheSoulDocument({ dataDir: serverDataDir, document });
        return {
          document,
          summary: soulSummary({
            scope: "user",
            ownerId: document.ownerId,
            document,
            canEdit: soulCanEdit(ctx, "user"),
          }),
          denSynced: true,
        };
      } catch (error) {
        if (!isSoulDenUnavailable(error)) throw error;
      }
    }

    const cached = den.userId
      ? await readCachedSoulDocument({ dataDir: serverDataDir, scope: "user", ownerId: den.userId })
      : null;
    const pendingEdits = den.userId
      ? await readPendingSoulEditsFor(serverDataDir, "user", den.userId)
      : [];
    return {
      document: cached,
      summary: soulSummary({
        scope: "user",
        ownerId,
        document: cached,
        canEdit: soulCanEdit(ctx, "user"),
        status: pendingEdits.length > 0 ? "pending" : undefined,
      }),
      pendingEdits: pendingEdits.length > 0 ? pendingEdits : undefined,
      denSynced: false,
    };
  };

  const readWorkspaceSoulModel = async (ctx: RequestContext, workspace: WorkspaceInfo) => {
    const document = await readCachedSoulDocument({
      dataDir: serverDataDir,
      scope: "workspace",
      ownerId: workspace.id,
    });
    return {
      document,
      summary: soulSummary({
        scope: "workspace",
        ownerId: workspace.id,
        document,
        canEdit: soulCanEdit(ctx, "workspace"),
        workspace,
      }),
      materialization: await buildSoulMaterializationStatus(workspace),
    };
  };

  const recordWorkspaceFileEvent = (workspaceId: string, input: { type: "write" | "delete" | "rename" | "mkdir"; path: string; toPath?: string; revision?: string }) => {
    return fileSessions.recordWorkspaceEvent({ workspaceId, ...input });
  };

  addRoute(routes, "GET", "/health", "none", async () => {
    return jsonResponse({
      ok: true,
      version: SERVER_VERSION,
      uptimeMs: Date.now() - config.startedAt,
      token: config.token,
      pid: process.pid,
    });
  });

  addRoute(routes, "GET", "/w/:id/health", "none", async () => {
    return jsonResponse({
      ok: true,
      version: SERVER_VERSION,
      uptimeMs: Date.now() - config.startedAt,
      token: config.token,
      pid: process.pid,
    });
  });

  addRoute(routes, "GET", "/ui", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return htmlResponse(TOY_UI_HTML);
  });

  addRoute(routes, "GET", "/w/:id/ui", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return htmlResponse(TOY_UI_HTML);
  });

  addRoute(routes, "GET", "/ui/assets/toy.css", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return cssResponse(TOY_UI_CSS);
  });

  addRoute(routes, "GET", "/ui/assets/toy.js", "none", async () => {
    if (!resolveToyUiEnabled()) {
      throw new ApiError(404, "ui_disabled", "Toy UI is disabled");
    }
    return jsResponse(TOY_UI_JS);
  });

  addRoute(routes, "GET", "/w/:id/status", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse({
      ok: true,
      version: SERVER_VERSION,
      uptimeMs: Date.now() - config.startedAt,
      readOnly: config.readOnly,
      approval: config.approval,
      corsOrigins: config.corsOrigins,
      workspaceCount: 1,
      activeWorkspaceId: workspace.id,
      workspace: serializeWorkspaceForResponse(workspace),
      authorizedRoots: config.authorizedRoots,
      server: {
        host: config.host,
        port: config.port,
        configPath: config.configPath ?? null,
      },
      tokenSource: {
        client: config.tokenSource,
        host: config.hostTokenSource,
      },
    });
  });

  addRoute(routes, "GET", "/w/:id/capabilities", "client", async () => {
    return jsonResponse(buildCapabilities(config));
  });

  addRoute(routes, "GET", "/w/:id/workspaces", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse({ items: [serializeWorkspaceForResponse(workspace)], activeId: workspace.id });
  });

  addRoute(routes, "GET", "/status", "client", async () => {
    const active = config.workspaces[0];
    return jsonResponse({
      ok: true,
      version: SERVER_VERSION,
      uptimeMs: Date.now() - config.startedAt,
      readOnly: config.readOnly,
      approval: config.approval,
      corsOrigins: config.corsOrigins,
      workspaceCount: config.workspaces.length,
      activeWorkspaceId: active?.id ?? null,
      workspace: active ? serializeWorkspaceForResponse(active) : null,
      authorizedRoots: config.authorizedRoots,
      server: {
        host: config.host,
        port: config.port,
        configPath: config.configPath ?? null,
      },
      tokenSource: {
        client: config.tokenSource,
        host: config.hostTokenSource,
      },
    });
  });

  addRoute(routes, "GET", "/whoami", "client", async (ctx) => {
    return jsonResponse({ ok: true, actor: ctx.actor ?? null });
  });

  addRoute(routes, "GET", "/capabilities", "client", async () => {
    return jsonResponse(buildCapabilities(config));
  });

  addRoute(routes, "GET", "/workspaces", "client", async () => {
    const active = config.workspaces[0] ?? null;
    const items = config.workspaces.map(serializeWorkspaceForResponse);
    return jsonResponse({ items, activeId: active?.id ?? null });
  });

  addRoute(routes, "POST", "/workspaces/local", "host", async (ctx) => {
    ensureWritable(config);
    const body = await readJsonBody(ctx.request);
    const folderPath = typeof body.path === "string" ? body.path.trim() : "";
    if (!folderPath) {
      throw new ApiError(400, "invalid_payload", "path is required");
    }
    const name = typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : basename(folderPath);
    const baseUrl = optionalBodyHttpUrl(body, "baseUrl");
    const directory = optionalBodyString(body, "directory");
    const opencodeUsername = optionalBodyString(body, "opencodeUsername");
    const opencodePassword = optionalBodyString(body, "opencodePassword");

    const workspacePath = resolve(folderPath);
    await mkdir(workspacePath, { recursive: true });

    const id = workspaceIdForPath(workspacePath);
    const existing = config.workspaces.find((entry) => entry.id === id);
    if (existing) {
      const hasOpencodeMetadata = Boolean(
        baseUrl || directory || opencodeUsername || opencodePassword,
      );
      const nextWorkspace: WorkspaceInfo = {
        ...existing,
        ...(name && existing.name !== name ? { name } : {}),
        ...(baseUrl ? { baseUrl } : {}),
        ...(directory ? { directory } : {}),
        ...(opencodeUsername ? { opencodeUsername } : {}),
        ...(opencodePassword ? { opencodePassword } : {}),
      };
      const changed =
        nextWorkspace.name !== existing.name ||
        nextWorkspace.baseUrl !== existing.baseUrl ||
        nextWorkspace.directory !== existing.directory ||
        nextWorkspace.opencodeUsername !== existing.opencodeUsername ||
        nextWorkspace.opencodePassword !== existing.opencodePassword;
      if (changed && (baseUrl || directory || opencodeUsername || opencodePassword)) {
        config.workspaces = config.workspaces.map((entry) =>
          entry.id === id ? nextWorkspace : entry,
        );
        const persisted = await persistServerWorkspaceState(config);
        return jsonResponse({
          activeId: config.workspaces[0]?.id ?? null,
          items: config.workspaces.map(serializeWorkspaceForResponse),
          persisted,
        });
      }
      if (hasOpencodeMetadata) {
        return jsonResponse({
          activeId: config.workspaces[0]?.id ?? null,
          items: config.workspaces.map(serializeWorkspaceForResponse),
          persisted: false,
        });
      }
      throw new ApiError(409, "workspace_exists", "Workspace already exists", {
        id,
        path: workspacePath,
      });
    }

    const workspace: WorkspaceInfo = {
      id,
      name,
      path: workspacePath,
      workspaceType: "local",
      ...(baseUrl ? { baseUrl } : {}),
      ...(directory ? { directory } : {}),
      ...(opencodeUsername ? { opencodeUsername } : {}),
      ...(opencodePassword ? { opencodePassword } : {}),
    };

    // Prepend so it becomes the active workspace (single-active-workspace model).
    config.workspaces = [workspace, ...config.workspaces];
    if (!config.authorizedRoots.some((root) => resolve(root) === workspacePath)) {
      config.authorizedRoots = [...config.authorizedRoots, workspacePath];
    }
    const persisted = await persistServerWorkspaceState(config);
    await ctx.automationRunner.upsertWorkspace({ id: workspace.id, path: workspacePath });

    return jsonResponse(
      {
        activeId: workspace.id,
        items: config.workspaces.map(serializeWorkspaceForResponse),
        persisted,
      },
      201,
    );
  });

  addRoute(routes, "PATCH", "/workspaces/:id", "host", async (ctx) => {
    ensureWritable(config);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const nextName = typeof body.name === "string" && body.name.trim()
      ? body.name.trim()
      : undefined;

    if (!nextName) {
      throw new ApiError(400, "invalid_payload", "name must be a non-empty string");
    }

    config.workspaces = config.workspaces.map((entry) =>
      entry.id === workspace.id ? { ...entry, name: nextName } : entry,
    );
    const persisted = await persistServerWorkspaceState(config);

    return jsonResponse({
      items: config.workspaces.map(serializeWorkspaceForResponse),
      persisted,
    });
  });

  addRoute(routes, "GET", "/session-archives", "client", async (ctx) => {
    const ownerKey = resolveArchiveOwnerKey(ctx.request);
    return jsonResponse({ items: await sessionArchives.list(ownerKey) });
  });

  addRoute(routes, "PUT", "/session-archives/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    const ownerKey = resolveArchiveOwnerKey(ctx.request);
    const body = await readJsonBody(ctx.request);
    const archivedAt = typeof body.archivedAt === "number" && Number.isFinite(body.archivedAt) ? body.archivedAt : Date.now();
    const titleSnapshot = typeof body.titleSnapshot === "string" ? body.titleSnapshot : "";
    return jsonResponse({
      items: await sessionArchives.put(ownerKey, {
        sessionId: ctx.params.sessionId,
        archivedAt,
        titleSnapshot,
        workspaceIdAtArchive: typeof body.workspaceIdAtArchive === "string" ? body.workspaceIdAtArchive : undefined,
        workspaceLabelSnapshot: typeof body.workspaceLabelSnapshot === "string" ? body.workspaceLabelSnapshot : undefined,
        resolvedDirectoryAtArchive:
          typeof body.resolvedDirectoryAtArchive === "string" ? body.resolvedDirectoryAtArchive : undefined,
        projectRootAtArchive: typeof body.projectRootAtArchive === "string" ? body.projectRootAtArchive : undefined,
        projectLabelSnapshot: typeof body.projectLabelSnapshot === "string" ? body.projectLabelSnapshot : undefined,
        parentSessionId:
          typeof body.parentSessionId === "string"
            ? body.parentSessionId
            : body.parentSessionId === null
              ? null
              : undefined,
        createdAtSnapshot:
          typeof body.createdAtSnapshot === "number" && Number.isFinite(body.createdAtSnapshot)
            ? body.createdAtSnapshot
            : body.createdAtSnapshot === null
              ? null
              : undefined,
        updatedAtSnapshot:
          typeof body.updatedAtSnapshot === "number" && Number.isFinite(body.updatedAtSnapshot)
            ? body.updatedAtSnapshot
            : body.updatedAtSnapshot === null
              ? null
              : undefined,
        workspaceIdentity: typeof body.workspaceIdentity === "string" ? body.workspaceIdentity : undefined,
      }),
    });
  });

  addRoute(routes, "DELETE", "/session-archives/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    const ownerKey = resolveArchiveOwnerKey(ctx.request);
    return jsonResponse({ items: await sessionArchives.delete(ownerKey, ctx.params.sessionId) });
  });

  addRoute(routes, "GET", "/ai-gateway/me/ai-access", "client", async (ctx) => {
    return proxyAiGatewayRequest({
      request: ctx.request,
      url: ctx.url,
      gatewayPath: "/api/me/ai-access",
      auth: "caller",
      preserveAiAccessToken: true,
    });
  });

  addRoute(routes, "GET", "/ai-gateway/readiness", "client", async (ctx) => {
    return proxyAiGatewayReadinessRequest({
      request: ctx.request,
      url: ctx.url,
    });
  });

  addRoute(routes, "POST", "/ai-gateway/providers/openai/v1/chat/completions", "client", async (ctx) => {
    return proxyAiGatewayRequest({
      request: ctx.request,
      url: ctx.url,
      gatewayPath: "/providers/openai/v1/chat/completions",
      auth: "gateway-token",
      requireSessionId: true,
    });
  });

  addRoute(routes, "POST", "/ai-gateway/providers/anthropic/v1/messages", "client", async (ctx) => {
    return proxyAiGatewayRequest({
      request: ctx.request,
      url: ctx.url,
      gatewayPath: "/providers/anthropic/v1/messages",
      auth: "gateway-token",
      requireSessionId: true,
    });
  });

  addRoute(routes, "POST", "/ai-gateway/providers/codex_oauth/v1/chat/completions", "client", async (ctx) => {
    return proxyAiGatewayRequest({
      request: ctx.request,
      url: ctx.url,
      gatewayPath: "/providers/codex_oauth/v1/chat/completions",
      auth: "gateway-token",
      requireSessionId: true,
    });
  });

  addRoute(routes, "POST", "/ai-gateway/providers/openai_compatible/v1/chat/completions", "client", async (ctx) => {
    return proxyAiGatewayRequest({
      request: ctx.request,
      url: ctx.url,
      gatewayPath: "/providers/openai_compatible/v1/chat/completions",
      auth: "gateway-token",
      requireSessionId: true,
    });
  });

  addRoute(routes, "GET", "/tokens", "host", async () => {
    const items = await tokens.list();
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/tokens", "host", async (ctx) => {
    ensureWritable(config);
    const body = await readJsonBody(ctx.request);
    const scopeRaw = typeof body.scope === "string" ? body.scope.trim() : "";
    const scope = scopeRaw === "owner" || scopeRaw === "collaborator" || scopeRaw === "viewer" ? scopeRaw : null;
    if (!scope) {
      throw new ApiError(400, "invalid_scope", "Token scope must be owner, collaborator, or viewer");
    }
    const label = typeof body.label === "string" ? body.label.trim() : undefined;
    const issued = await tokens.create(scope, { label });
    return jsonResponse(issued, 201);
  });

  addRoute(routes, "DELETE", "/tokens/:id", "host", async (ctx) => {
    ensureWritable(config);
    const ok = await tokens.revoke(ctx.params.id);
    if (!ok) {
      throw new ApiError(404, "token_not_found", "Token not found");
    }
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/workspaces/:id/activate", "host", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    config.workspaces = [
      workspace,
      ...config.workspaces.filter((entry) => entry.id !== workspace.id),
    ];

    let provision: { version: string; status: "updated" | "unchanged"; written: number; unchanged: number } | null = null;
    let userGlobalSkills: Awaited<ReturnType<typeof materializeUserGlobalSkillsForWorkspace>> | null = null;
    try {
      provision = await provisionWorkspaceInternalSystem(workspace.path, resolveVesloAppDataDir());
      if (provision.written > 0) {
        emitReloadEvent(ctx.reloadEvents, workspace, "agents", {
          type: "agent",
          action: "updated",
          path: ".opencode/agents/veslo.md",
        });
      }
      userGlobalSkills = await materializeUserGlobalSkillsForWorkspace({
        workspaceRoot: workspace.path,
        workspaceId: workspace.id,
        dataDir: serverDataDir,
      });
      if (userGlobalSkills.reloadRequired) {
        emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
          type: "skill",
          name: "veslo-user",
          action: "updated",
          path: userGlobalSkills.rootDir,
        });
      }
    } catch (error) {
      console.warn("[veslo-server] workspace activation provisioning failed", {
        workspaceId: workspace.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.activate",
      target: "workspace",
      summary: "Switched active workspace",
      timestamp: Date.now(),
    });
    return jsonResponse({
      activeId: workspace.id,
      workspace: serializeWorkspaceForResponse(workspace),
      provision,
      userGlobalSkills,
    });
  });

  addRoute(routes, "DELETE", "/workspaces/:id", "host", async (ctx) => {
    ensureWritable(config);

    const workspace = await resolveWorkspace(config, ctx.params.id);

    // Attempt to persist to server.json (when present) before mutating in-memory state.
    const configPath = config.configPath?.trim() ?? "";
    const persisted = configPath
      ? await persistWorkspaceDeletion(configPath, workspace.id, workspace.path)
      : false;

    const before = config.workspaces.length;
    config.workspaces = config.workspaces.filter((entry) => entry.id !== workspace.id);
    const deleted = before !== config.workspaces.length;

    if (deleted) {
      // Only remove exact matches; authorizedRoots can contain broader entries.
      config.authorizedRoots = config.authorizedRoots.filter((root) => resolve(root) !== resolve(workspace.path));
      ctx.automationRunner.removeWorkspace(workspace.id);
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "workspace.delete",
      target: "workspace",
      summary: "Deleted workspace from Veslo server",
      timestamp: Date.now(),
    });

    const active = config.workspaces[0] ?? null;
    return jsonResponse({
      ok: true,
      deleted,
      persisted,
      activeId: active?.id ?? null,
      items: config.workspaces.map(serializeWorkspaceForResponse),
    });
  });

  addRoute(routes, "GET", "/workspace/:id/config", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const opencode = redactSensitiveConfig(await readOpencodeConfig(workspace.path));
    const veslo = redactSensitiveConfig(await readVesloConfig(workspace.path));
    const lastAudit = await readLastAudit(workspace.path, workspace.id);
    return jsonResponse({ opencode, veslo, updatedAt: lastAudit?.timestamp ?? null });
  });

  addRoute(routes, "POST", "/workspace/:id/system/provision", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);

    const result = await provisionWorkspaceInternalSystem(workspace.path, resolveVesloAppDataDir());
    const userGlobalSkills = await materializeUserGlobalSkillsForWorkspace({
      workspaceRoot: workspace.path,
      workspaceId: workspace.id,
      dataDir: serverDataDir,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "system.provision",
      target: ".opencode/agents/veslo.md",
      summary: `Updated Veslo workspace instructions (${result.status})`,
      timestamp: Date.now(),
    });

    if (result.written > 0) {
      emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
        type: "skill",
        action: "updated",
        path: ".opencode/veslo/internal",
      });
    }
    if (userGlobalSkills.reloadRequired) {
      emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
        type: "skill",
        name: "veslo-user",
        action: "updated",
        path: userGlobalSkills.rootDir,
      });
    }
    if (result.written > 0) {
      emitReloadEvent(ctx.reloadEvents, workspace, "agents", {
        type: "agent",
        action: "updated",
        path: ".opencode/agents/veslo.md",
      });
    }

    return jsonResponse({
      ok: true,
      workspaceId: workspace.id,
      version: result.version,
      status: result.status,
      written: result.written,
      unchanged: result.unchanged,
      userGlobalSkills,
    });
  });

  addRoute(routes, "GET", "/workspace/:id/audit", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const limitParam = ctx.url.searchParams.get("limit");
    const parsed = limitParam ? Number(limitParam) : NaN;
    const limit = Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, 200) : 50;
    const items = await readAuditEntries(workspace.path, workspace.id, limit);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/sessions/:sessionId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");

    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }

    // OpenCode session deletion via the upstream API.
    await fetchOpencodeJson(workspace, `/session/${encodeURIComponent(sessionId)}`, {
      method: "DELETE",
    });

    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/conversations", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const directory = await resolveConversationReadDirectory(
      workspace,
      ctx.url.searchParams.get("directory"),
    );
    const result = await conversationService.listConversations({
      workspace,
      directory,
      sync: ctx.url.searchParams.get("sync") === "true" || ctx.url.searchParams.get("sync") === "1",
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/conversations", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const sendTraceId = ctx.request.headers.get("x-veslo-send-trace-id")?.trim() || null;
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readOptionalJsonBody(ctx.request);
    const directory = await resolveConversationReadDirectory(
      workspace,
      optionalBodyNullableString(body, "directory") ?? null,
    );
    const startedAt = Date.now();
    recordSendWorkflowTrace("server", "server:conversation-create:start", {
      traceId: sendTraceId,
      workspaceId: workspace.id,
      directory,
      hasTitle: Boolean(optionalBodyNullableString(body, "title")?.trim()),
    });
    try {
      const result = await conversationService.createConversation({
        workspace,
        directory,
        title: optionalBodyNullableString(body, "title") ?? null,
        sendTraceId,
      });
      recordSendWorkflowTrace("server", "server:conversation-create:done", {
        traceId: sendTraceId,
        workspaceId: workspace.id,
        directory,
        conversationId: result.conversationId,
        opencodeSessionId: result.opencodeSessionId,
        durationMs: Date.now() - startedAt,
      });
      return jsonResponse(result, 201);
    } catch (error) {
      recordSendWorkflowTrace("server", "server:conversation-create:error", {
        traceId: sendTraceId,
        workspaceId: workspace.id,
        directory,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error;
    }
  });

  addRoute(routes, "POST", "/workspace/:id/conversations/import", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const rawSessions = body.sessions;
    if (!Array.isArray(rawSessions)) {
      throw new ApiError(400, "invalid_payload", "sessions must be an array");
    }
    const directory = await resolveConversationReadDirectory(
      workspace,
      optionalBodyNullableString(body, "directory") ?? null,
    );
    const sessions = rawSessions.map((item) => {
      if (!item || typeof item !== "object" || Array.isArray(item)) {
        throw new ApiError(400, "invalid_payload", "sessions must contain objects");
      }
      const record = item as Record<string, unknown>;
      const time = record.time && typeof record.time === "object" && !Array.isArray(record.time)
        ? record.time as Record<string, unknown>
        : null;
      return {
        id: typeof record.id === "string" ? record.id : "",
        title: typeof record.title === "string" ? record.title : null,
        parentID: typeof record.parentID === "string" ? record.parentID : null,
        time: {
          created: typeof time?.created === "number" ? time.created : null,
          updated: typeof time?.updated === "number" ? time.updated : null,
        },
      };
    });
    const result = await conversationService.importOpenCodeSessions({
      workspace,
      directory,
      sessions,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/conversations/:conversationId/transcript", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const conversationId = (ctx.params.conversationId ?? "").trim();
    if (!conversationId) {
      throw new ApiError(400, "invalid_payload", "conversationId is required");
    }
    const limit = parseSessionTranscriptLimit(ctx.url.searchParams.get("limit"));
    const directory = await resolveConversationReadDirectory(
      workspace,
      ctx.url.searchParams.get("directory"),
    );
    const result = await loadConversationTranscriptResponse({
      workspace,
      sessionOrConversationId: conversationId,
      limit,
      directory,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/conversations/:conversationId/runs", "client", async (ctx) => {
    const runTrace = createConversationRunTracer(ctx.request);
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    runTrace.record("server:conversation-run:start", {
      workspaceId: ctx.params.id,
      conversationId: ctx.params.conversationId,
    });
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionOrConversationId = (ctx.params.conversationId ?? "").trim();
    if (!sessionOrConversationId) {
      throw new ApiError(400, "invalid_payload", "conversationId is required");
    }
    const body = await readJsonBody(ctx.request);
    const kind = parseConversationRunKind(body.kind);
    const clientMessageId = optionalBodyString(body, "clientMessageId") || optionalBodyString(body, "messageID");
    const origin = optionalBodyString(body, "origin");
    const expectAiGatewayStart = optionalBodyBoolean(body, "expectAiGatewayStart") === true;
    runTrace.record("server:conversation-run:payload", {
      workspaceId: workspace.id,
      conversationId: sessionOrConversationId,
      kind,
      clientMessageId: clientMessageId || null,
      origin: origin || null,
      expectAiGatewayStart,
    });
    const target = await runTrace.step(
      "server:conversation-run:resolve-target",
      () => resolveConversationExecutionTarget({
        workspace,
        sessionOrConversationId,
        requestedDirectory: optionalBodyString(body, "directory"),
        missingDirectoryMessage: "Conversation run directory is required",
      }),
      {
        workspaceId: workspace.id,
        workspaceType: workspace.workspaceType,
        kind,
      },
    );
    const runId = shortId();
    const lifecycleOwner = workspace.workspaceType === "remote" ? null : lifecycleClient;
    runTrace.record("server:conversation-run:lifecycle-owner", {
      workspaceId: workspace.id,
      runId,
      clientMessageId: clientMessageId || null,
      origin: origin || null,
      enabled: Boolean(lifecycleOwner),
      workspaceType: workspace.workspaceType,
    });
    if (lifecycleOwner) {
      try {
        const active = await runTrace.step(
          "server:conversation-run:lifecycle-active-peek",
          () => lifecycleOwner.active(workspace.id, target.conversationId),
          {
            workspaceId: workspace.id,
            conversationId: target.conversationId,
          },
        );
        if (active && isActiveLifecycleStatus(active.status)) {
          return enqueueConversationRun({
            runTrace,
            workspace,
            target,
            runId,
            kind,
            body,
            clientMessageId: clientMessageId || null,
            origin: origin || null,
            activeRunId: active.runId,
          });
        }
      } catch (error) {
        runTrace.record("server:conversation-run:lifecycle-active-peek-skipped", {
          workspaceId: workspace.id,
          conversationId: target.conversationId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
      try {
        await runTrace.step(
          "server:conversation-run:lifecycle-register",
          () => lifecycleOwner.register({
            workspaceId: workspace.id,
            conversationId: target.conversationId,
            runId,
            engineSessionId: target.opencodeSessionId,
            directory: target.directory,
            kind: lifecycleRunKind(kind),
          }),
          {
            workspaceId: workspace.id,
            conversationId: target.conversationId,
            runId,
            engineSessionId: target.opencodeSessionId,
            kind: lifecycleRunKind(kind),
          },
        );
      } catch (error) {
        if (error instanceof RunAlreadyActiveError) {
          return enqueueConversationRun({
            runTrace,
            workspace,
            target,
            runId,
            kind,
            body,
            clientMessageId: clientMessageId || null,
            origin: origin || null,
            activeRunId: error.activeRunId || null,
          });
        }
        if (error instanceof OrchestratorLifecycleRequestError) {
          throw lifecycleRequestApiError(error);
        }
        throw error;
      }
    }
    const upstream = await submitConversationRunToOpenCode({
      runTrace,
      workspace,
      target,
      runId,
      kind,
      body,
      clientMessageId: clientMessageId || null,
      origin: origin || null,
      expectAiGatewayStart,
      lifecycleOwner,
    });
    return jsonResponse({
      ok: true,
      workspaceId: workspace.id,
      conversationId: target.conversationId,
      opencodeSessionId: target.opencodeSessionId,
      runId,
      clientMessageId: clientMessageId || null,
      origin: origin || null,
      status: "submitted",
      kind,
      upstream,
      debugTrace: runTrace.entries,
    });
  });

  addRoute(routes, "POST", "/workspace/:id/conversations/:conversationId/abort", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionOrConversationId = (ctx.params.conversationId ?? "").trim();
    if (!sessionOrConversationId) {
      throw new ApiError(400, "invalid_payload", "conversationId is required");
    }
    const body = await readJsonBody(ctx.request);
    const runId = requireConversationRunId(body);
    const target = await resolveConversationExecutionTarget({
      workspace,
      sessionOrConversationId,
      requestedDirectory: optionalBodyString(body, "directory"),
      missingDirectoryMessage: "Conversation abort directory is required",
    });
    recordSendWorkflowTrace("server", "server:conversation-abort:start", {
      traceId: null,
      workspaceId: workspace.id,
      conversationId: target.conversationId,
      runId,
      opencodeSessionId: target.opencodeSessionId,
      sessionOrConversationId,
    });
    const abortedGatewayRequests = abortActiveAiGatewayProxyRequests({
      workspaceId: workspace.id,
      runId,
      sessionId: target.opencodeSessionId,
      reason: "conversation-abort",
    });
    const query = new URLSearchParams();
    query.set("directory", target.directory);
    const upstream = await fetchOpencodeJsonWithOrchestratorFallback(
      config,
      { ...workspace, directory: target.directory },
      `/session/${encodeURIComponent(target.opencodeSessionId)}/abort?${query.toString()}`,
      { method: "POST" },
    );
    const lifecycleOwner = workspace.workspaceType === "remote" ? null : lifecycleClient;
    if (lifecycleOwner) {
      await lifecycleOwner.markAbortRequested(workspace.id, runId).catch(() => undefined);
    }
    recordSendWorkflowTrace("server", "server:conversation-abort:done", {
      traceId: null,
      workspaceId: workspace.id,
      conversationId: target.conversationId,
      runId,
      opencodeSessionId: target.opencodeSessionId,
      abortedGatewayRequestCount: abortedGatewayRequests.length,
      upstreamStatus: typeof upstream === "object" && upstream && "status" in upstream ? upstream.status : null,
    });
    return jsonResponse({
      ok: true,
      workspaceId: workspace.id,
      conversationId: target.conversationId,
      opencodeSessionId: target.opencodeSessionId,
      runId,
      status: "submitted",
      kind: "abort",
      upstream,
    });
  });

  addRoute(routes, "GET", "/workspace/:id/conversations/:conversationId/runs/:runId", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const conversationId = (ctx.params.conversationId ?? "").trim();
    const runId = (ctx.params.runId ?? "").trim();
    if (!conversationId || !runId) {
      throw new ApiError(400, "invalid_payload", "conversationId and runId are required");
    }
    if (!lifecycleClient) {
      throw new ApiError(503, "lifecycle_unavailable", "Run lifecycle owner is not configured");
    }
    let status;
    try {
      status = await lifecycleClient.status(workspace.id, conversationId, runId);
    } catch (error) {
      if (error instanceof OrchestratorLifecycleRequestError) {
        throw lifecycleRequestApiError(error);
      }
      throw error;
    }
    if (!status) {
      throw new ApiError(404, "run_not_found", "Run was not found for this conversation");
    }
    return jsonResponse({
      ok: true,
      workspaceId: workspace.id,
      conversationId,
      runId: status.runId,
      status: status.status,
      stale: status.stale,
    });
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/transcript-prefetch", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const payload = body as Record<string, unknown>;
    const clickedSessionId = parseOptionalSessionId(payload.clickedSessionId);
    const selectedSessionId = parseOptionalSessionId(payload.selectedSessionId);
    const loadedTopLevelSessionIds = parseSessionIdArray(payload.loadedTopLevelSessionIds, "loadedTopLevelSessionIds");
    const expandedSubagentSessionIds = parseSessionIdArray(
      payload.expandedSubagentSessionIds,
      "expandedSubagentSessionIds",
    );
    const limit = parseSessionTranscriptLimit((body as Record<string, unknown>).limit);
    const directory = await resolveConversationReadDirectory(
      workspace,
      optionalBodyNullableString(payload, "directory") ?? null,
    );
    const rawSessionDirectoriesById = parseSessionDirectoryMap(payload.sessionDirectoriesById);
    const sessionDirectoriesById: Record<string, string> = {};
    for (const [sessionId, sessionDirectory] of Object.entries(rawSessionDirectoriesById)) {
      const resolvedSessionDirectory = await resolveConversationReadDirectory(workspace, sessionDirectory);
      if (!resolvedSessionDirectory) {
        throw new ApiError(400, "invalid_directory", "Session directory is required");
      }
      sessionDirectoriesById[sessionId] = resolvedSessionDirectory;
    }
    const result = await sessionTranscriptPrefetch.updateInterest({
      workspaceId: workspace.id,
      clickedSessionId,
      selectedSessionId,
      loadedTopLevelSessionIds,
      expandedSubagentSessionIds,
      directory,
      sessionDirectoriesById,
      limit,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/sessions/:sessionId/transcript", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const body = await readJsonBody(ctx.request);
    const directory = await resolveConversationReadDirectory(
      workspace,
      optionalBodyNullableString(body, "directory") ?? null,
    );
    if (!directory) {
      throw new ApiError(400, "invalid_directory", "Conversation directory is required");
    }
    const binding = await conversationService.resolveOpenCodeSessionForRead({
      workspaceId: workspace.id,
      directory,
      sessionOrConversationId: sessionId,
    });
    if (!binding && isVesloConversationId(sessionId)) {
      throw new ApiError(404, "conversation_not_found", "Conversation was not found in this workspace");
    }

    const messages = parseSessionTranscriptMessages(body.messages);
    const partsByMessageId = parseSessionTranscriptParts(body.partsByMessageId);
    const reason = optionalBodyString(body, "reason") ?? "";
    const result = await conversationService.appendTranscript({
      workspace,
      sessionId,
      directory,
      limit: parseSessionTranscriptLimit(body.limit),
      messages,
      partsByMessageId,
      deletedMessageIds: parseTranscriptStringArray(body.deletedMessageIds, "deletedMessageIds"),
      deletedPartsByMessageId: parseSessionTranscriptDeletedParts(body.deletedPartsByMessageId),
    });
    sessionTranscriptPrefetch.invalidate({
      workspaceId: workspace.id,
      sessionId: result.opencodeSessionId,
      directory,
    });
    if (result.conversationId) {
      sessionTranscriptPrefetch.invalidate({
        workspaceId: workspace.id,
        sessionId: result.conversationId,
        directory,
      });
    }
    reconcileConversationLifecycleAfterTranscriptAppend({
      workspace,
      conversationId: result.conversationId ?? binding?.conversationId ?? sessionId,
      sessionId: result.opencodeSessionId,
      reason,
      shouldReconcile: shouldReconcileLifecycleAfterTranscriptAppend(messages, reason),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/transcript", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const limit = parseSessionTranscriptLimit(ctx.url.searchParams.get("limit"));
    const directory = await resolveConversationReadDirectory(
      workspace,
      ctx.url.searchParams.get("directory"),
    );
    const result = await loadConversationTranscriptResponse({
      workspace,
      sessionOrConversationId: sessionId,
      limit,
      directory,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/sessions/:sessionId/artifacts/latest-run", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const sessionId = (ctx.params.sessionId ?? "").trim();
    if (!sessionId) {
      throw new ApiError(400, "invalid_payload", "sessionId is required");
    }
    const directory = await resolveConversationReadDirectory(
      workspace,
      ctx.url.searchParams.get("directory"),
    );
    const transcript = await loadConversationTranscriptResponse({
      workspace,
      sessionOrConversationId: sessionId,
      limit: SESSION_TRANSCRIPT_MAX_LIMIT,
      directory,
    });
    const messages = attachTranscriptPartsForArtifacts(
      transcript.messages,
      transcript.partsByMessageId,
    );

    return jsonResponse(
      deriveLatestRunArtifactsResponse({
        sessionId: transcript.opencodeSessionId,
        workspaceId: workspace.id,
        messages,
      }, { workspaceRoot: directory ?? workspace.path }),
    );
  });

  addRoute(routes, "PATCH", "/workspace/:id/config", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const opencode = body.opencode as Record<string, unknown> | undefined;
    const veslo = body.veslo as Record<string, unknown> | undefined;

    if (!opencode && !veslo) {
      throw new ApiError(400, "invalid_payload", "opencode or veslo updates required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.patch",
      summary: "Patch workspace config",
      paths: [opencode ? opencodeConfigPath(workspace.path) : null, veslo ? vesloConfigPath(workspace.path) : null].filter(Boolean) as string[],
    });

    if (opencode) {
      await updateJsoncTopLevel(opencodeConfigPath(workspace.path), opencode);
    }
    if (veslo) {
      await writeVesloConfig(workspace.path, veslo, true);
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.patch",
      target: "opencode.json",
      summary: "Patched workspace config",
      timestamp: Date.now(),
    });

    if (opencode) {
      emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(opencodeConfigPath(workspace.path)));
    }

    return jsonResponse({ updatedAt: Date.now() });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/telegram-token", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;
    logOpenCodeRouterDebug("telegram-token:request", {
      workspaceId: workspace.id,
      actor: ctx.actor?.type ?? "unknown",
      hasToken: Boolean(token),
      healthPort: healthPort ?? null,
      requestHost,
    });
    if (!token) {
      throw new ApiError(400, "token_required", "Telegram token is required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.telegram.set-token",
      summary: "Set Telegram bot token",
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    const identityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    await persistOpenCodeRouterTelegramIdentity({ id: identityId, token, enabled: true, directory: workspace.path });

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/identities/telegram",
      { id: identityId, token, enabled: true, directory: workspace.path },
      { port, requestHost, timeoutMs: 3_000 },
    );

    const result: Record<string, unknown> = {
      ok: true,
      persisted: true,
      applied: apply.applied,
      telegram: { configured: true, enabled: true },
    };

    const bot = await fetchTelegramBotInfo(token);
    if (bot) {
      (result.telegram as Record<string, unknown>).bot = bot;
    }

    // Reflect opencodeRouter apply status when available.
    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.telegram && typeof record.telegram === "object") {
        const telegram = record.telegram as Record<string, unknown>;
        if (typeof telegram.applied === "boolean") {
          (result.telegram as Record<string, unknown>).applied = telegram.applied;
          result.applied = telegram.applied;
        }
        if (typeof telegram.starting === "boolean") {
          (result.telegram as Record<string, unknown>).starting = telegram.starting;
        }
        if (typeof telegram.error === "string" && telegram.error.trim()) {
          (result.telegram as Record<string, unknown>).error = telegram.error;
          result.applyError = telegram.error;
        }
      }
    }

    if (!apply.applied) {
      result.applyError = (typeof result.applyError === "string" && result.applyError.trim())
        ? result.applyError
        : apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") result.applyStatus = apply.status;
    }
    logOpenCodeRouterDebug("telegram-token:updated", {
      workspaceId: workspace.id,
      applied: typeof result.applied === "boolean" ? result.applied : null,
      applyError: typeof result.applyError === "string" ? result.applyError : null,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.telegram.set-token",
      target: "opencodeRouter.telegram",
      summary: "Updated Telegram bot token",
      timestamp: Date.now(),
    });

    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-router/telegram", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    await resolveWorkspace(config, ctx.params.id);
    const info = await readOpenCodeRouterTelegramInfo();
    return jsonResponse({ ok: true, ...info });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/telegram-enabled", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const enabled = body.enabled === true || body.enabled === "true";
    const clearToken = body.clearToken === true || body.clearToken === "true";
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.telegram.set-enabled",
      summary: enabled ? "Enable Telegram" : "Disable Telegram",
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    await persistOpenCodeRouterTelegramEnabled(enabled, { clearToken: !enabled && clearToken });

    // OpenCodeRouter no longer exposes a channel-wide enable/disable endpoint.
    // Persisting the flag gates all identities on next start.
    const response: Record<string, unknown> = {
      ok: true,
      persisted: true,
      enabled,
      applied: false,
      applyError: "Restart opencodeRouter to apply",
    };

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.telegram.set-enabled",
      target: "opencodeRouter.telegram",
      summary: enabled ? "Enabled Telegram" : "Disabled Telegram",
      timestamp: Date.now(),
    });

    return jsonResponse(response);
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/slack-tokens", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
    const appToken = typeof body.appToken === "string" ? body.appToken.trim() : "";
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;
    logOpenCodeRouterDebug("slack-tokens:request", {
      workspaceId: workspace.id,
      actor: ctx.actor?.type ?? "unknown",
      hasBotToken: Boolean(botToken),
      hasAppToken: Boolean(appToken),
      healthPort: healthPort ?? null,
      requestHost,
    });
    if (!botToken || !appToken) {
      throw new ApiError(400, "token_required", "Slack botToken and appToken are required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.slack.set-tokens",
      summary: "Set Slack bot tokens",
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    const identityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    await persistOpenCodeRouterSlackIdentity({ id: identityId, botToken, appToken, enabled: true, directory: workspace.path });

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/identities/slack",
      { id: identityId, botToken, appToken, enabled: true, directory: workspace.path },
      { port, requestHost, timeoutMs: 3_000 },
    );

    const result: Record<string, unknown> = {
      ok: true,
      persisted: true,
      applied: apply.applied,
      slack: { configured: true, enabled: true },
    };

    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.slack && typeof record.slack === "object") {
        const slack = record.slack as Record<string, unknown>;
        if (typeof slack.applied === "boolean") {
          (result.slack as Record<string, unknown>).applied = slack.applied;
          result.applied = slack.applied;
        }
        if (typeof slack.starting === "boolean") {
          (result.slack as Record<string, unknown>).starting = slack.starting;
        }
        if (typeof slack.error === "string" && slack.error.trim()) {
          (result.slack as Record<string, unknown>).error = slack.error;
          result.applyError = slack.error;
        }
      }
    }

    if (!apply.applied) {
      result.applyError = (typeof result.applyError === "string" && result.applyError.trim())
        ? result.applyError
        : apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") result.applyStatus = apply.status;
    }
    logOpenCodeRouterDebug("slack-tokens:updated", {
      workspaceId: workspace.id,
      applied: typeof result.applied === "boolean" ? result.applied : null,
      applyError: typeof result.applyError === "string" ? result.applyError : null,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.slack.set-tokens",
      target: "opencodeRouter.slack",
      summary: "Updated Slack bot tokens",
      timestamp: Date.now(),
    });

    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-router/identities/telegram", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);

    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;

    const apply = await tryFetchOpenCodeRouterHealth("GET", "/identities/telegram", {
      port,
      requestHost,
      timeoutMs: 2_000,
    });

    if (apply.applied && apply.body && typeof apply.body === "object") {
      const payload = apply.body as Record<string, unknown>;
      const rawItems = (payload as any).items;
      if (Array.isArray(rawItems)) {
        const items = rawItems
          .filter(
            (entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
          )
          .map((entry) => {
            const id = normalizeOpenCodeRouterIdentityId(entry.id);
            const enabled = entry.enabled === undefined ? true : entry.enabled === true || entry.enabled === "true";
            const running = entry.running === true || entry.running === "true";
            const access = normalizeTelegramAccessMode(
              entry.access,
              entry.pairingRequired === true || entry.pairingRequired === "true" ? "private" : "public",
            );
            return { id, enabled, running, access, pairingRequired: access === "private" };
          })
          .filter((item) => item.id === workspaceIdentityId);
        return jsonResponse({ ...payload, items });
      }
      return jsonResponse(payload);
    }

    const current = await readOpenCodeRouterConfigFile(resolveOpenCodeRouterConfigPath());
    const channels = ensurePlainObject(current.channels);
    const telegram = ensurePlainObject(channels.telegram);
    const botsRaw = (telegram as any).bots;
    const bots = Array.isArray(botsRaw) ? (botsRaw as unknown[]) : [];
    const items = bots
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
      .map((entry) => {
        const id = normalizeOpenCodeRouterIdentityId(entry.id);
        const enabled = entry.enabled === undefined ? true : entry.enabled === true || entry.enabled === "true";
        const { access } = resolveTelegramAccessFromRecord(entry);
        return { id, enabled, running: false, access, pairingRequired: access === "private" };
      })
      .filter((item) => item.id === workspaceIdentityId);
    return jsonResponse({ ok: true, items });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/identities/telegram", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const token = typeof body.token === "string" ? body.token.trim() : "";
    const enabled = body.enabled === undefined ? true : body.enabled === true || body.enabled === "true";
    const access = normalizeTelegramAccessMode(body.access, "public");
    const pairingCodeInput = typeof body.pairingCode === "string" ? body.pairingCode : "";
    const normalizedPairingCodeInput = normalizeTelegramPairingCode(pairingCodeInput);
    if (
      access === "private" &&
      pairingCodeInput.trim() &&
      (normalizedPairingCodeInput.length < 6 || normalizedPairingCodeInput.length > 24)
    ) {
      throw new ApiError(
        400,
        "invalid_pairing_code",
        "Pairing code must be 6-24 letters or numbers",
      );
    }
    const pairingCode =
      access === "private"
        ? (normalizedPairingCodeInput || normalizeTelegramPairingCode(generateTelegramPairingCode()))
        : "";
    const pairingCodeHash = access === "private" ? hashTelegramPairingCode(pairingCode) : "";
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const requestedId = typeof body.id === "string" ? normalizeOpenCodeRouterIdentityId(body.id) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = workspaceIdentityId;
    if (identityId === "env") {
      throw new ApiError(400, "invalid_identity", "Identity id 'env' is reserved");
    }
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;
    if (!token) {
      throw new ApiError(400, "token_required", "Telegram token is required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.telegram.identity.upsert",
      summary: `Upsert Telegram identity (${identityId})`,
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    await persistOpenCodeRouterTelegramIdentity({
      id: identityId,
      token,
      enabled,
      directory: workspace.path,
      access,
      ...(access === "private" ? { pairingCodeHash } : {}),
    });

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/identities/telegram",
      {
        id: identityId,
        token,
        enabled,
        directory: workspace.path,
        access,
        ...(access === "private" ? { pairingCodeHash } : {}),
      },
      { port, requestHost, timeoutMs: 3_000 },
    );

    const response: Record<string, unknown> = {
      ok: true,
      persisted: true,
      applied: apply.applied,
      telegram: {
        id: identityId,
        enabled,
        access,
        pairingRequired: access === "private",
        ...(access === "private" ? { pairingCode } : {}),
      },
    };

    const bot = await fetchTelegramBotInfo(token);
    if (bot) {
      (response.telegram as Record<string, unknown>).bot = bot;
    }

    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.telegram && typeof record.telegram === "object") {
        response.telegram = {
          ...(response.telegram as Record<string, unknown>),
          ...(record.telegram as Record<string, unknown>),
          access,
          pairingRequired: access === "private",
          ...(access === "private" ? { pairingCode } : {}),
        };
      }
    }

    if (!apply.applied) {
      response.applyError = apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") response.applyStatus = apply.status;
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.telegram.identity.upsert",
      target: "opencodeRouter.telegram",
      summary: `Upserted Telegram identity (${identityId})`,
      timestamp: Date.now(),
    });

    return jsonResponse(response);
  });

  addRoute(routes, "DELETE", "/workspace/:id/opencode-router/identities/telegram/:identityId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const requestedId = normalizeOpenCodeRouterIdentityId(ctx.params.identityId);
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = workspaceIdentityId;
    if (identityId === "env") {
      throw new ApiError(400, "invalid_identity", "Identity id 'env' is reserved");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.telegram.identity.delete",
      summary: `Delete Telegram identity (${identityId})`,
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    const deleted = await deleteOpenCodeRouterTelegramIdentity(identityId);
    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;
    const apply = await tryFetchOpenCodeRouterHealth(
      "DELETE",
      `/identities/telegram/${encodeURIComponent(identityId)}`,
      {
        port,
        requestHost,
        timeoutMs: 3_000,
      },
    );

    const response: Record<string, unknown> = {
      ok: true,
      persisted: true,
      deleted,
      applied: apply.applied,
      telegram: { id: identityId, deleted },
    };

    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.telegram && typeof record.telegram === "object") {
        response.telegram = record.telegram;
      }
    }

    if (!apply.applied) {
      response.applyError = apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") response.applyStatus = apply.status;
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.telegram.identity.delete",
      target: "opencodeRouter.telegram",
      summary: `Deleted Telegram identity (${identityId})`,
      timestamp: Date.now(),
    });

    return jsonResponse(response);
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-router/identities/slack", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);

    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;

    const apply = await tryFetchOpenCodeRouterHealth("GET", "/identities/slack", {
      port,
      requestHost,
      timeoutMs: 2_000,
    });

    if (apply.applied && apply.body && typeof apply.body === "object") {
      const payload = apply.body as Record<string, unknown>;
      const rawItems = (payload as any).items;
      if (Array.isArray(rawItems)) {
        const items = rawItems
          .filter(
            (entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)),
          )
          .map((entry) => {
            const id = normalizeOpenCodeRouterIdentityId(entry.id);
            const enabled = entry.enabled === undefined ? true : entry.enabled === true || entry.enabled === "true";
            const running = entry.running === true || entry.running === "true";
            return { id, enabled, running };
          })
          .filter((item) => item.id === workspaceIdentityId);
        return jsonResponse({ ...payload, items });
      }
      return jsonResponse(payload);
    }

    const current = await readOpenCodeRouterConfigFile(resolveOpenCodeRouterConfigPath());
    const channels = ensurePlainObject(current.channels);
    const slack = ensurePlainObject(channels.slack);
    const appsRaw = (slack as any).apps;
    const apps = Array.isArray(appsRaw) ? (appsRaw as unknown[]) : [];
    const items = apps
      .filter((entry): entry is Record<string, unknown> => Boolean(entry && typeof entry === "object" && !Array.isArray(entry)))
      .map((entry) => {
        const id = normalizeOpenCodeRouterIdentityId(entry.id);
        const enabled = entry.enabled === undefined ? true : entry.enabled === true || entry.enabled === "true";
        return { id, enabled, running: false };
      })
      .filter((item) => item.id === workspaceIdentityId);
    return jsonResponse({ ok: true, items });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/identities/slack", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const botToken = typeof body.botToken === "string" ? body.botToken.trim() : "";
    const appToken = typeof body.appToken === "string" ? body.appToken.trim() : "";
    const enabled = body.enabled === undefined ? true : body.enabled === true || body.enabled === "true";
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const requestedId = typeof body.id === "string" ? normalizeOpenCodeRouterIdentityId(body.id) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = workspaceIdentityId;
    if (identityId === "env") {
      throw new ApiError(400, "invalid_identity", "Identity id 'env' is reserved");
    }
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;
    if (!botToken || !appToken) {
      throw new ApiError(400, "token_required", "Slack botToken and appToken are required");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.slack.identity.upsert",
      summary: `Upsert Slack identity (${identityId})`,
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    await persistOpenCodeRouterSlackIdentity({ id: identityId, botToken, appToken, enabled, directory: workspace.path });

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/identities/slack",
      { id: identityId, botToken, appToken, enabled, directory: workspace.path },
      { port, requestHost, timeoutMs: 3_000 },
    );

    const response: Record<string, unknown> = {
      ok: true,
      persisted: true,
      applied: apply.applied,
      slack: { id: identityId, enabled },
    };

    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.slack && typeof record.slack === "object") {
        response.slack = record.slack;
      }
    }

    if (!apply.applied) {
      response.applyError = apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") response.applyStatus = apply.status;
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.slack.identity.upsert",
      target: "opencodeRouter.slack",
      summary: `Upserted Slack identity (${identityId})`,
      timestamp: Date.now(),
    });

    return jsonResponse(response);
  });

  addRoute(routes, "DELETE", "/workspace/:id/opencode-router/identities/slack/:identityId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const requestedId = normalizeOpenCodeRouterIdentityId(ctx.params.identityId);
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = workspaceIdentityId;
    if (identityId === "env") {
      throw new ApiError(400, "invalid_identity", "Identity id 'env' is reserved");
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "opencodeRouter.slack.identity.delete",
      summary: `Delete Slack identity (${identityId})`,
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    const deleted = await deleteOpenCodeRouterSlackIdentity(identityId);
    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;
    const apply = await tryFetchOpenCodeRouterHealth(
      "DELETE",
      `/identities/slack/${encodeURIComponent(identityId)}`,
      {
        port,
        requestHost,
        timeoutMs: 3_000,
      },
    );

    const response: Record<string, unknown> = {
      ok: true,
      persisted: true,
      deleted,
      applied: apply.applied,
      slack: { id: identityId, deleted },
    };

    if (apply.body && typeof apply.body === "object") {
      const record = apply.body as Record<string, unknown>;
      if (record.slack && typeof record.slack === "object") {
        response.slack = record.slack;
      }
    }

    if (!apply.applied) {
      response.applyError = apply.error ?? "OpenCodeRouter did not apply the update";
      if (typeof apply.status === "number") response.applyStatus = apply.status;
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.slack.identity.delete",
      target: "opencodeRouter.slack",
      summary: `Deleted Slack identity (${identityId})`,
      timestamp: Date.now(),
    });

    return jsonResponse(response);
  });

  addRoute(routes, "GET", "/workspace/:id/opencode-router/bindings", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const healthPortParam = parseInteger(ctx.url.searchParams.get("healthPort") ?? undefined);
    const port = healthPortParam ?? resolveOpenCodeRouterHealthPort();
    const requestHost = ctx.url.hostname;

    const search = new URLSearchParams();
    const channel = (ctx.url.searchParams.get("channel") ?? "").trim();
    const identityIdParam = (ctx.url.searchParams.get("identityId") ?? "").trim();
    const requestedId = identityIdParam ? normalizeOpenCodeRouterIdentityId(identityIdParam) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    if (channel) search.set("channel", channel);
    search.set("identityId", workspaceIdentityId);
    const suffix = search.toString();
    const pathname = suffix ? `/bindings?${suffix}` : "/bindings";

    const apply = await tryFetchOpenCodeRouterHealth("GET", pathname, { port, requestHost, timeoutMs: 2_000 });
    if (apply.applied && apply.body && typeof apply.body === "object") {
      return jsonResponse(apply.body);
    }
    throw new ApiError(503, "opencodeRouter_unreachable", "OpenCodeRouter is not reachable on this host", {
      port,
      error: apply.error,
      status: apply.status,
    });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/bindings", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const body = await readJsonBody(ctx.request);
    const channel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
    const identityIdParam = typeof body.identityId === "string" ? body.identityId.trim() : "";
    const requestedId = identityIdParam ? normalizeOpenCodeRouterIdentityId(identityIdParam) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = workspaceIdentityId;
    const peerId = typeof body.peerId === "string" ? body.peerId.trim() : "";
    const directory = typeof body.directory === "string" ? body.directory.trim() : "";
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;

    if (channel !== "telegram" && channel !== "slack") {
      throw new ApiError(400, "invalid_channel", "channel must be 'telegram' or 'slack'");
    }
    if (!peerId) {
      throw new ApiError(400, "peer_required", "peerId is required");
    }

    const action = directory ? "opencodeRouter.binding.set" : "opencodeRouter.binding.clear";
    const summary = directory
      ? `Bind ${channel}/${identityId}:${peerId} -> ${directory}`
      : `Clear binding for ${channel}/${identityId}:${peerId}`;

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action,
      summary,
      paths: [resolveOpenCodeRouterConfigPath()],
    });

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const payload: Record<string, unknown> = {
      channel,
      identityId,
      peerId,
      ...(directory ? { directory } : {}),
    };
    const apply = await tryPostOpenCodeRouterHealth("/bindings", payload, { port, requestHost, timeoutMs: 3_000 });
    if (!apply.applied) {
      throw new ApiError(503, "opencodeRouter_unreachable", "OpenCodeRouter did not apply binding update", {
        port,
        error: apply.error,
        status: apply.status,
      });
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action,
      target: "opencodeRouter.binding",
      summary,
      timestamp: Date.now(),
    });

    if (apply.body && typeof apply.body === "object") {
      return jsonResponse(apply.body);
    }
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/workspace/:id/opencode-router/send", "client", async (ctx) => {
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const workspaceIdentityId = normalizeOpenCodeRouterIdentityId(workspace.id);
    const body = await readJsonBody(ctx.request);
    const channel = typeof body.channel === "string" ? body.channel.trim().toLowerCase() : "";
    const text = typeof body.text === "string" ? body.text : "";
    const peerId = typeof body.peerId === "string" ? body.peerId.trim() : "";
    const autoBind = body.autoBind === true || body.autoBind === "true";
    const directoryInput = typeof body.directory === "string" ? body.directory.trim() : "";
    const directory = directoryInput || workspace.path;
    const healthPort = normalizeHealthPort(body.healthPort);
    const requestHost = ctx.url.hostname;

    const identityIdParam = typeof body.identityId === "string" ? body.identityId.trim() : "";
    const requestedId = identityIdParam ? normalizeOpenCodeRouterIdentityId(identityIdParam) : "";
    if (requestedId && requestedId !== workspaceIdentityId) {
      throw new ApiError(
        400,
        "identity_mismatch",
        `Identity id is scoped to this workspace (${workspace.id}).`,
        { expected: workspaceIdentityId, received: requestedId },
      );
    }
    const identityId = requestedId || undefined;

    if (channel !== "telegram" && channel !== "slack") {
      throw new ApiError(400, "invalid_channel", "channel must be 'telegram' or 'slack'");
    }
    if (!directory.trim() && !peerId) {
      throw new ApiError(400, "directory_required", "directory is required when peerId is not provided");
    }
    if (!text.trim()) {
      throw new ApiError(400, "text_required", "text is required");
    }

    const port = healthPort ?? resolveOpenCodeRouterHealthPort();
    const apply = await tryPostOpenCodeRouterHealth(
      "/send",
      {
        channel,
        ...(identityId ? { identityId } : {}),
        ...(directory.trim() ? { directory } : {}),
        ...(peerId ? { peerId } : {}),
        ...(autoBind ? { autoBind: true } : {}),
        text,
      },
      { port, requestHost, timeoutMs: 5_000 },
    );

    if (!apply.applied) {
      throw new ApiError(503, "opencodeRouter_unreachable", "OpenCodeRouter did not send the message", {
        port,
        error: apply.error,
        status: apply.status,
      });
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "opencodeRouter.send",
      target: `opencodeRouter.${channel}`,
      summary: `Sent outbound ${channel} message${identityId ? ` for ${identityId}` : ""}${peerId ? ` to ${peerId}` : ""}`,
      timestamp: Date.now(),
    });

    if (apply.body && typeof apply.body === "object") {
      return jsonResponse(apply.body);
    }
    return jsonResponse({
      ok: true,
      channel,
      identityId,
      directory,
      attempted: 0,
      sent: 0,
    });
  });

  addRoute(routes, "GET", "/workspace/:id/events", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const since = parseInteger(trimmedSearchParam(ctx.url.searchParams, "since"));
    return jsonResponse({
      items: ctx.reloadEvents.list(workspace.id, since ?? undefined),
      cursor: ctx.reloadEvents.cursor(),
      workspaceId: workspace.id,
    });
  });

  addRoute(routes, "POST", "/workspace/:id/engine/reload", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    requireClientScope(ctx, "collaborator");

    await reloadOpencodeEngine(workspace);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "engine.reload",
      target: workspace.baseUrl ?? "opencode",
      summary: "Reloaded workspace engine",
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true, reloadedAt: Date.now() });
  });

  addRoute(routes, "GET", "/workspace/:id/inbox", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveInboxEnabled()) {
      return jsonResponse({ items: [] });
    }
    const inboxRoot = resolveInboxDir(workspace.path);
    const items = await listInbox(inboxRoot);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/inbox/:inboxId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveInboxEnabled()) {
      throw new ApiError(404, "inbox_disabled", "Workspace inbox is disabled");
    }
    const inboxRoot = resolveInboxDir(workspace.path);
    const relativePath = decodeInboxId(ctx.params.inboxId);
    const absPath = await resolveSafeChildPath(inboxRoot, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "inbox_item_not_found", "Inbox item not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "inbox_item_not_found", "Inbox item not found");
    }

    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Length", String(info.size));
    headers.set("Content-Disposition", `attachment; filename=\"${basename(relativePath)}\"`);
    return new Response((Bun as any).file(absPath), { status: 200, headers });
  });

  addRoute(routes, "POST", "/workspace/:id/inbox", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    if (!resolveInboxEnabled()) {
      throw new ApiError(404, "inbox_disabled", "Workspace inbox is disabled");
    }
    const workspace = await resolveWorkspace(config, ctx.params.id);

    const contentType = ctx.request.headers.get("content-type") ?? "";
    if (!contentType.toLowerCase().includes("multipart/form-data")) {
      throw new ApiError(400, "invalid_payload", "Expected multipart/form-data");
    }
    const maxBytes = resolveInboxMaxBytes();
    const contentLength = contentLengthFor(ctx.request.headers);
    if (contentLength !== null && contentLength > maxBytes) {
      await ctx.request.body?.cancel().catch(() => undefined);
      throw new ApiError(413, "payload_too_large", "Request body exceeds size limit", {
        label: "workspace inbox upload",
        maxBytes,
        size: contentLength,
      });
    }
    const form = await ctx.request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new ApiError(400, "file_required", "Form field 'file' is required");
    }

    const queryPath = (ctx.url.searchParams.get("path") ?? "").trim();
    const formPath = typeof form.get("path") === "string" ? String(form.get("path") || "").trim() : "";
    const requestedPath = queryPath || formPath || file.name;

    const relativePath = normalizeWorkspaceRelativePath(requestedPath, { allowSubdirs: true });
    const inboxRoot = resolveInboxDir(workspace.path);
    const dest = await resolveSafeChildPath(inboxRoot, relativePath);
    if (file.size > maxBytes) {
      throw new ApiError(413, "file_too_large", "File exceeds upload limit", { maxBytes, size: file.size });
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "workspace.inbox.upload",
      summary: `Upload ${relativePath} to inbox`,
      paths: [dest],
    });

    await ensureDir(dirname(dest));
    const bytes = Buffer.from(await file.arrayBuffer());
    const tmp = `${dest}.tmp-${shortId()}`;
    await writeFile(tmp, bytes);
    await rename(tmp, dest);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "workspace.inbox.upload",
      target: dest,
      summary: `Uploaded ${relativePath} to inbox`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true, path: relativePath, bytes: file.size });
  });

  addRoute(routes, "GET", "/workspace/:id/artifacts", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveOutboxEnabled()) {
      return jsonResponse({ items: [] });
    }
    const outboxRoot = resolveOutboxDir(workspace.path);
    const items = await listArtifacts(outboxRoot);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/artifacts/:artifactId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    if (!resolveOutboxEnabled()) {
      throw new ApiError(404, "outbox_disabled", "Workspace outbox is disabled");
    }
    const outboxRoot = resolveOutboxDir(workspace.path);
    const relativePath = decodeArtifactId(ctx.params.artifactId);
    const absPath = await resolveSafeChildPath(outboxRoot, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "artifact_not_found", "Artifact not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "artifact_not_found", "Artifact not found");
    }

    const headers = new Headers();
    headers.set("Content-Type", "application/octet-stream");
    headers.set("Content-Length", String(info.size));
    headers.set("Content-Disposition", `attachment; filename="${basename(relativePath)}"`);
    return new Response((Bun as any).file(absPath), { status: 200, headers });
  });

  addRoute(routes, "POST", "/workspace/:id/files/sessions", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const ttlMs = parseFileSessionTtlMs((body as Record<string, unknown>).ttlSeconds);
    const requestWrite = (body as Record<string, unknown>).write !== false;
    const canWrite =
      requestWrite &&
      !config.readOnly &&
      scopeRank(ctx.actor?.scope ?? "viewer") >= scopeRank("collaborator");

    const session = fileSessions.create({
      workspaceId: workspace.id,
      workspaceRoot: workspace.path,
      actorTokenHash: ctx.actor?.tokenHash ?? "",
      actorScope: ctx.actor?.scope ?? "viewer",
      canWrite,
      ttlMs,
    });

    return jsonResponse({ session: serializeFileSession(session) });
  });

  addRoute(routes, "POST", "/files/sessions/:sessionId/renew", "client", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const ttlMs = parseFileSessionTtlMs((body as Record<string, unknown>).ttlSeconds);
    const { session } = resolveFileSession(ctx, ctx.params.sessionId);
    const renewed = fileSessions.renew(session.id, ttlMs);
    if (!renewed) {
      throw new ApiError(404, "file_session_not_found", "File session not found");
    }
    return jsonResponse({ session: serializeFileSession(renewed) });
  });

  addRoute(routes, "DELETE", "/files/sessions/:sessionId", "client", async (ctx) => {
    const { session } = resolveFileSession(ctx, ctx.params.sessionId);
    fileSessions.close(session.id);
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/files/sessions/:sessionId/catalog/snapshot", "client", async (ctx) => {
    const { workspace } = resolveFileSession(ctx, ctx.params.sessionId);
    const prefix = parseCatalogPathFilter(ctx.url.searchParams.get("prefix"));
    const after = parseCatalogPathFilter(ctx.url.searchParams.get("after"));
    const includeDirs = ctx.url.searchParams.get("includeDirs") !== "false";
    const limit = parseCatalogLimit(ctx.url.searchParams.get("limit"));

    const entries = await listWorkspaceCatalogEntries(workspace.path);
    const filtered = entries.filter((entry) => {
      if (!includeDirs && entry.kind === "dir") return false;
      if (!matchesCatalogFilter(entry.path, prefix)) return false;
      if (after && entry.path <= after) return false;
      return true;
    });

    const items = filtered.slice(0, limit);
    const truncated = filtered.length > items.length;
    const nextAfter = truncated ? items[items.length - 1]?.path : undefined;
    const events = fileSessions.listWorkspaceEvents(workspace.id, Number.MAX_SAFE_INTEGER);

    return jsonResponse({
      sessionId: ctx.params.sessionId,
      workspaceId: workspace.id,
      generatedAt: Date.now(),
      cursor: events.cursor,
      total: filtered.length,
      truncated,
      nextAfter,
      items,
    });
  });

  addRoute(routes, "GET", "/files/sessions/:sessionId/catalog/events", "client", async (ctx) => {
    const { workspace } = resolveFileSession(ctx, ctx.params.sessionId);
    const since = parseSessionCursor(ctx.url.searchParams.get("since"));
    const events = fileSessions.listWorkspaceEvents(workspace.id, since);
    return jsonResponse(events);
  });

  addRoute(routes, "POST", "/files/sessions/:sessionId/read-batch", "client", async (ctx) => {
    const { workspace } = resolveFileSession(ctx, ctx.params.sessionId);
    const body = await readJsonBody(ctx.request);
    const paths = parseBatchPathList((body as Record<string, unknown>).paths);
    const items: Array<Record<string, unknown>> = [];

    for (const relativePath of paths) {
      try {
        const absPath = await resolveSafeChildPath(workspace.path, relativePath);
        if (!(await exists(absPath))) {
          items.push({ ok: false, path: relativePath, code: "file_not_found", message: "File not found" });
          continue;
        }
        const info = await stat(absPath);
        if (!info.isFile()) {
          items.push({ ok: false, path: relativePath, code: "file_not_found", message: "File not found" });
          continue;
        }
        if (info.size > FILE_SESSION_MAX_FILE_BYTES) {
          items.push({
            ok: false,
            path: relativePath,
            code: "file_too_large",
            message: "File exceeds size limit",
            maxBytes: FILE_SESSION_MAX_FILE_BYTES,
            size: info.size,
          });
          continue;
        }

        const content = await readFile(absPath);
        items.push({
          ok: true,
          path: relativePath,
          kind: "file",
          bytes: info.size,
          updatedAt: info.mtimeMs,
          revision: fileRevision(info),
          contentBase64: content.toString("base64"),
        });
      } catch (error) {
        const message = error instanceof ApiError ? error.message : "Unable to read file";
        const code = error instanceof ApiError ? error.code : "read_failed";
        items.push({ ok: false, path: relativePath, code, message });
      }
    }

    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/files/sessions/:sessionId/write-batch", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const { session, workspace } = resolveFileSession(ctx, ctx.params.sessionId);
    if (!session.canWrite) {
      throw new ApiError(403, "forbidden", "File session is read-only");
    }

    const body = await readJsonBody(ctx.request, {
      maxBytes: FILE_SESSION_WRITE_BODY_MAX_BYTES,
      label: "file session write batch",
    });
    const writes = parseBatchWriteList((body as Record<string, unknown>).writes);
    const items: Array<Record<string, unknown>> = [];

    const plan: Array<{
      path: string;
      absPath: string;
      bytes: Buffer;
      ifMatchRevision?: string;
      force?: boolean;
      beforeRevision: string | null;
    }> = [];

    for (const write of writes) {
      try {
        const absPath = await resolveSafeChildPath(workspace.path, write.path);
        const bytes = Buffer.from(write.contentBase64, "base64");
        if (bytes.byteLength > FILE_SESSION_MAX_FILE_BYTES) {
          items.push({
            ok: false,
            path: write.path,
            code: "file_too_large",
            message: "File exceeds size limit",
            maxBytes: FILE_SESSION_MAX_FILE_BYTES,
            size: bytes.byteLength,
          });
          continue;
        }

        const before = (await exists(absPath)) ? await stat(absPath) : null;
        if (before && !before.isFile()) {
          items.push({ ok: false, path: write.path, code: "invalid_path", message: "Path must point to a file" });
          continue;
        }
        const beforeRevision = before ? fileRevision(before) : null;
        if (!write.force && write.ifMatchRevision && write.ifMatchRevision !== beforeRevision) {
          items.push({
            ok: false,
            path: write.path,
            code: "conflict",
            message: "File changed since it was loaded",
            expectedRevision: write.ifMatchRevision,
            currentRevision: beforeRevision,
          });
          continue;
        }

        plan.push({
          path: write.path,
          absPath,
          bytes,
          beforeRevision,
          ...(write.ifMatchRevision ? { ifMatchRevision: write.ifMatchRevision } : {}),
          ...(write.force ? { force: true } : {}),
        });
      } catch (error) {
        const message = error instanceof ApiError ? error.message : "Invalid write request";
        const code = error instanceof ApiError ? error.code : "invalid_payload";
        items.push({ ok: false, path: write.path, code, message });
      }
    }

    if (plan.length) {
      await requireApproval(ctx, {
        workspaceId: workspace.id,
        action: "workspace.files.session.write",
        summary: `Write ${plan.length} file(s) via file session`,
        paths: plan.map((item) => item.absPath),
      });
    }

    for (const entry of plan) {
      try {
        const before = (await exists(entry.absPath)) ? await stat(entry.absPath) : null;
        const currentRevision = before ? fileRevision(before) : null;
        if (!entry.force && entry.ifMatchRevision && currentRevision !== entry.ifMatchRevision) {
          items.push({
            ok: false,
            path: entry.path,
            code: "conflict",
            message: "File changed before write could be applied",
            expectedRevision: entry.ifMatchRevision,
            currentRevision,
          });
          continue;
        }

        await ensureDir(dirname(entry.absPath));
        const tmp = `${entry.absPath}.tmp-${shortId()}`;
        await writeFile(tmp, entry.bytes);
        await rename(tmp, entry.absPath);
        const after = await stat(entry.absPath);
        const revision = fileRevision(after);

        recordWorkspaceFileEvent(workspace.id, { type: "write", path: entry.path, revision });

        await recordAudit(workspace.path, {
          id: shortId(),
          workspaceId: workspace.id,
          actor: ctx.actor ?? { type: "remote" },
          action: "workspace.files.session.write",
          target: entry.absPath,
          summary: `Wrote ${entry.path} via file session`,
          timestamp: Date.now(),
        });

        items.push({
          ok: true,
          path: entry.path,
          bytes: entry.bytes.byteLength,
          updatedAt: after.mtimeMs,
          revision,
          previousRevision: entry.beforeRevision,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Failed to write file";
        items.push({ ok: false, path: entry.path, code: "write_failed", message });
      }
    }

    const events = fileSessions.listWorkspaceEvents(workspace.id, Number.MAX_SAFE_INTEGER);
    return jsonResponse({ items, cursor: events.cursor });
  });

  addRoute(routes, "POST", "/files/sessions/:sessionId/ops", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const { session, workspace } = resolveFileSession(ctx, ctx.params.sessionId);
    if (!session.canWrite) {
      throw new ApiError(403, "forbidden", "File session is read-only");
    }

    const body = await readJsonBody(ctx.request);
    const operations = Array.isArray((body as Record<string, unknown>).operations)
      ? ((body as Record<string, unknown>).operations as Array<Record<string, unknown>>)
      : null;
    if (!operations || !operations.length) {
      throw new ApiError(400, "invalid_payload", "operations must be a non-empty array");
    }
    if (operations.length > FILE_SESSION_MAX_BATCH_ITEMS) {
      throw new ApiError(400, "invalid_payload", `operations must include <= ${FILE_SESSION_MAX_BATCH_ITEMS} items`);
    }

    const items: Array<Record<string, unknown>> = [];
    const approvalPaths: string[] = [];
    for (const op of operations) {
      if (typeof op?.path === "string" && op.path.trim()) {
        approvalPaths.push(await resolveSafeChildPath(workspace.path, normalizeWorkspaceRelativePath(op.path, { allowSubdirs: true })));
      }
      if (typeof op?.from === "string" && op.from.trim()) {
        approvalPaths.push(await resolveSafeChildPath(workspace.path, normalizeWorkspaceRelativePath(op.from, { allowSubdirs: true })));
      }
      if (typeof op?.to === "string" && op.to.trim()) {
        approvalPaths.push(await resolveSafeChildPath(workspace.path, normalizeWorkspaceRelativePath(op.to, { allowSubdirs: true })));
      }
    }

    if (approvalPaths.length) {
      await requireApproval(ctx, {
        workspaceId: workspace.id,
        action: "workspace.files.session.ops",
        summary: `Apply ${operations.length} file operation(s) via file session`,
        paths: approvalPaths,
      });
    }

    for (const op of operations) {
      const type = String(op.type ?? "").trim();
      try {
        if (type === "mkdir") {
          const path = normalizeWorkspaceRelativePath(String(op.path ?? ""), { allowSubdirs: true });
          const absPath = await resolveSafeChildPath(workspace.path, path);
          await ensureDir(absPath);
          recordWorkspaceFileEvent(workspace.id, { type: "mkdir", path });
          items.push({ ok: true, type, path });
          continue;
        }

        if (type === "delete") {
          const path = normalizeWorkspaceRelativePath(String(op.path ?? ""), { allowSubdirs: true });
          const absPath = await resolveSafeChildPath(workspace.path, path);
          if (!(await exists(absPath))) {
            items.push({ ok: false, type, path, code: "file_not_found", message: "Path not found" });
            continue;
          }
          await rm(absPath, { recursive: op.recursive === true, force: false });
          recordWorkspaceFileEvent(workspace.id, { type: "delete", path });
          items.push({ ok: true, type, path });
          continue;
        }

        if (type === "rename") {
          const from = normalizeWorkspaceRelativePath(String(op.from ?? ""), { allowSubdirs: true });
          const to = normalizeWorkspaceRelativePath(String(op.to ?? ""), { allowSubdirs: true });
          const fromAbs = await resolveSafeChildPath(workspace.path, from);
          const toAbs = await resolveSafeChildPath(workspace.path, to);
          if (!(await exists(fromAbs))) {
            items.push({ ok: false, type, from, to, code: "file_not_found", message: "Source path not found" });
            continue;
          }
          await ensureDir(dirname(toAbs));
          await rename(fromAbs, toAbs);
          recordWorkspaceFileEvent(workspace.id, { type: "rename", path: from, toPath: to });
          items.push({ ok: true, type, from, to });
          continue;
        }

        items.push({ ok: false, type, code: "invalid_operation", message: `Unsupported operation type: ${type}` });
      } catch (error) {
        const message = error instanceof Error ? error.message : "Operation failed";
        items.push({ ok: false, type, code: "operation_failed", message });
      }
    }

    const events = fileSessions.listWorkspaceEvents(workspace.id, Number.MAX_SAFE_INTEGER);
    return jsonResponse({ items, cursor: events.cursor });
  });

  addRoute(routes, "GET", "/workspace/:id/files/content", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const requested = (ctx.url.searchParams.get("path") ?? "").trim();
    const relativePath = normalizeWorkspaceRelativePath(requested, { allowSubdirs: true });
    const lowered = relativePath.toLowerCase();
    const isMarkdown = lowered.endsWith(".md") || lowered.endsWith(".mdx") || lowered.endsWith(".markdown");
    if (!isMarkdown) {
      throw new ApiError(400, "invalid_path", "Only markdown files are supported");
    }

    const absPath = await resolveSafeChildPath(workspace.path, relativePath);
    if (!(await exists(absPath))) {
      throw new ApiError(404, "file_not_found", "File not found");
    }
    const info = await stat(absPath);
    if (!info.isFile()) {
      throw new ApiError(404, "file_not_found", "File not found");
    }

    const maxBytes = FILE_SESSION_MAX_FILE_BYTES;
    if (info.size > maxBytes) {
      throw new ApiError(413, "file_too_large", "File exceeds size limit", { maxBytes, size: info.size });
    }

    const content = await readFile(absPath, "utf8");
    return jsonResponse({ path: relativePath, content, bytes: info.size, updatedAt: info.mtimeMs });
  });

  addRoute(routes, "POST", "/workspace/:id/files/content", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request, {
      maxBytes: WORKSPACE_FILE_CONTENT_BODY_MAX_BYTES,
      label: "workspace file content",
    });

    const requestedPath = String(body.path ?? "");
    const relativePath = normalizeWorkspaceRelativePath(requestedPath, { allowSubdirs: true });
    const lowered = relativePath.toLowerCase();
    const isMarkdown = lowered.endsWith(".md") || lowered.endsWith(".mdx") || lowered.endsWith(".markdown");
    if (!isMarkdown) {
      throw new ApiError(400, "invalid_path", "Only markdown files are supported");
    }

    if (typeof body.content !== "string") {
      throw new ApiError(400, "invalid_payload", "content must be a string");
    }
    const content = body.content;
    const bytes = Buffer.byteLength(content, "utf8");
    const maxBytes = FILE_SESSION_MAX_FILE_BYTES;
    if (bytes > maxBytes) {
      throw new ApiError(413, "file_too_large", "File exceeds size limit", { maxBytes, size: bytes });
    }

    const baseUpdatedAtRaw = body.baseUpdatedAt;
    const baseUpdatedAt =
      typeof baseUpdatedAtRaw === "number" && Number.isFinite(baseUpdatedAtRaw) ? baseUpdatedAtRaw : null;
    const force = body.force === true;

    const absPath = await resolveSafeChildPath(workspace.path, relativePath);

    const before = (await exists(absPath)) ? await stat(absPath) : null;
    if (before && !before.isFile()) {
      throw new ApiError(400, "invalid_path", "Path must point to a file");
    }
    const beforeUpdatedAt = before ? before.mtimeMs : null;
    if (!force && beforeUpdatedAt !== null && baseUpdatedAt !== null && beforeUpdatedAt !== baseUpdatedAt) {
      throw new ApiError(409, "conflict", "File changed since it was loaded", {
        baseUpdatedAt,
        currentUpdatedAt: beforeUpdatedAt,
      });
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "workspace.file.write",
      summary: `Write ${relativePath}`,
      paths: [absPath],
    });

    await ensureDir(dirname(absPath));
    const tmp = `${absPath}.tmp-${shortId()}`;
    await writeFile(tmp, content, "utf8");
    await rename(tmp, absPath);
    const after = await stat(absPath);
    const revision = fileRevision(after);

    recordWorkspaceFileEvent(workspace.id, {
      type: "write",
      path: relativePath,
      revision,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "workspace.file.write",
      target: absPath,
      summary: `Wrote ${relativePath}`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true, path: relativePath, bytes, updatedAt: after.mtimeMs, revision });
  });

  addRoute(routes, "GET", "/workspace/:id/plugins", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const result = await listPlugins(workspace.path, includeGlobal, { workspaceOwner: ownerForWorkspace(workspace) });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/plugins", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const spec = String(body.spec ?? "");
    const normalized = normalizePluginSpec(spec);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.add",
      summary: `Add plugin ${spec}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const changed = await addPlugin(workspace.path, spec);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.add",
      target: "opencode.json",
      summary: `Added ${spec}`,
      timestamp: Date.now(),
    });
    if (changed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", {
        type: "plugin",
        name: normalized,
        action: "added",
      });
    }
    const result = await listPlugins(workspace.path, false, { workspaceOwner: ownerForWorkspace(workspace) });
    return jsonResponse(result);
  });

  addRoute(routes, "DELETE", "/workspace/:id/plugins/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    const normalized = normalizePluginSpec(name);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "plugins.remove",
      summary: `Remove plugin ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const removed = await removePlugin(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "plugins.remove",
      target: "opencode.json",
      summary: `Removed ${name}`,
      timestamp: Date.now(),
    });
    if (removed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "plugins", {
        type: "plugin",
        name: normalized,
        action: "removed",
      });
    }
    const result = await listPlugins(workspace.path, false, { workspaceOwner: ownerForWorkspace(workspace) });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/skills", "host", async (ctx) => {
    ensureWritable(config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await createRegistrySkill({
      ...skillRegistryRequestInput(ctx),
      scope: requireBodyString(body, "scope"),
      name: requireBodyString(body, "name"),
      displayName: optionalBodyString(body, "displayName"),
      description: optionalBodyString(body, "description"),
      targetOrgId: optionalBodyString(body, "orgId"),
      workspaceId: optionalBodyString(body, "workspaceId"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/v1/skills/:skillId/versions", "client", async (ctx) => {
    requireSkillRegistryRequestBaseUrl(ctx);
    const limit = parseInteger(trimmedSearchParam(ctx.url.searchParams, "limit"));
    const result = await listRegistrySkillVersions({
      ...skillRegistryRequestInput(ctx),
      skillId: ctx.params.skillId ?? "",
      cursor: trimmedSearchParam(ctx.url.searchParams, "cursor"),
      limit: limit ?? undefined,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/skills/:skillId/versions", "host", async (ctx) => {
    ensureWritable(config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await createRegistrySkillVersion({
      ...skillRegistryRequestInput(ctx),
      skillId: ctx.params.skillId ?? "",
      package: requireBodyObject(body, "package") as RegistrySkillPackageArchive,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/skills/:skillId/review-requests", "host", async (ctx) => {
    ensureWritable(config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await createRegistrySkillReviewRequest({
      ...skillRegistryRequestInput(ctx),
      skillId: ctx.params.skillId ?? "",
      scope: requireBodyString(body, "scope"),
      versionId: requireBodyString(body, "versionId"),
      targetOrgId: optionalBodyString(body, "orgId"),
      reason: optionalBodyString(body, "reason"),
      releaseChannel: optionalBodyString(body, "releaseChannel"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/skill-review-requests/:requestId/approve", "host", async (ctx) => {
    ensureWritable(config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await approveRegistrySkillReviewRequest({
      ...skillRegistryRequestInput(ctx),
      requestId: ctx.params.requestId ?? "",
      reviewerNote: optionalBodyString(body, "reviewerNote"),
      releaseChannel: optionalBodyString(body, "releaseChannel"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/skill-review-requests/:requestId/reject", "host", async (ctx) => {
    ensureWritable(config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await rejectRegistrySkillReviewRequest({
      ...skillRegistryRequestInput(ctx),
      requestId: ctx.params.requestId ?? "",
      reviewerNote: optionalBodyString(body, "reviewerNote"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/skill-installations", "host", async (ctx) => {
    ensureWritable(config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await createRegistrySkillInstallation({
      ...skillRegistryRequestInput(ctx),
      scope: requireBodyString(body, "scope"),
      skillId: requireBodyString(body, "skillId"),
      versionId: requireBodyString(body, "versionId"),
      targetOrgId: optionalBodyString(body, "orgId"),
      ownerUserId: optionalBodyString(body, "ownerUserId"),
      workspaceId: optionalBodyString(body, "workspaceId"),
      updatePolicy: optionalBodyString(body, "updatePolicy"),
      releaseChannel: optionalBodyString(body, "releaseChannel"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "PATCH", "/v1/skill-installations/:installationId", "host", async (ctx) => {
    ensureWritable(config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await updateRegistrySkillInstallation({
      ...skillRegistryRequestInput(ctx),
      installationId: ctx.params.installationId ?? "",
      enabled: optionalBodyBoolean(body, "enabled"),
      versionId: optionalBodyNullableString(body, "versionId"),
      updatePolicy: optionalBodyString(body, "updatePolicy"),
      releaseChannel: optionalBodyNullableString(body, "releaseChannel"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "DELETE", "/v1/skill-installations/:installationId", "host", async (ctx) => {
    ensureWritable(config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const result = await deleteRegistrySkillInstallation({
      ...skillRegistryRequestInput(ctx),
      installationId: ctx.params.installationId ?? "",
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/skill-installations/:installationId/restore", "host", async (ctx) => {
    ensureWritable(config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await restoreRegistrySkillInstallation({
      ...skillRegistryRequestInput(ctx),
      installationId: ctx.params.installationId ?? "",
      targetOrgId: optionalBodyNullableString(body, "orgId"),
      ownerUserId: optionalBodyNullableString(body, "ownerUserId"),
      workspaceId: optionalBodyNullableString(body, "workspaceId"),
      versionId: optionalBodyNullableString(body, "versionId"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "PATCH", "/v1/workspaces/:workspaceId/skill-set", "host", async (ctx) => {
    ensureWritable(config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const skills = Array.isArray(body.skills) ? body.skills : [];
    const result = await replaceRegistryWorkspaceSkillSet({
      ...skillRegistryRequestInput(ctx),
      workspaceId: ctx.params.workspaceId ?? "",
      targetOrgId: optionalBodyString(body, "orgId"),
      releaseChannel: optionalBodyString(body, "releaseChannel"),
      skills: skills as Array<{ installationId: string; desiredVersionId?: string | null; releaseChannel?: string | null }>,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/v1/skill-rollout-policies", "client", async (ctx) => {
    if (!skillRegistryRequestBaseUrl(ctx)) {
      return jsonResponse({ policies: [], nextCursor: null });
    }

    const limit = parseInteger(trimmedSearchParam(ctx.url.searchParams, "limit"));
    const enabledParam = trimmedSearchParam(ctx.url.searchParams, "enabled");
    const result = await listRegistrySkillRolloutPolicies({
      ...skillRegistryRequestInput(ctx),
      cursor: trimmedSearchParam(ctx.url.searchParams, "cursor"),
      limit: limit ?? undefined,
      skillId: trimmedSearchParam(ctx.url.searchParams, "skillId"),
      target: trimmedSearchParam(ctx.url.searchParams, "target") as RegistrySkillRolloutPolicyTarget | undefined,
      audience: trimmedSearchParam(ctx.url.searchParams, "audience") as
        | RegistrySkillRolloutPolicyAudience
        | undefined,
      catalogScope: trimmedSearchParam(ctx.url.searchParams, "catalogScope") as
        | RegistrySkillRolloutPolicyCatalogScope
        | undefined,
      targetOrgId: trimmedSearchParam(ctx.url.searchParams, "orgId"),
      targetUserId: trimmedSearchParam(ctx.url.searchParams, "userId"),
      workspaceId: trimmedSearchParam(ctx.url.searchParams, "workspaceId"),
      enabled: enabledParam === undefined ? undefined : enabledParam === "true",
    });
    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/v1/skill-rollout-policies", "host", async (ctx) => {
    ensureWritable(config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await createRegistrySkillRolloutPolicy({
      ...skillRegistryRequestInput(ctx),
      skillId: requireBodyString(body, "skillId"),
      versionId: optionalBodyNullableString(body, "versionId"),
      target: requireBodyString(body, "target") as RegistrySkillRolloutPolicyTarget,
      audience: requireBodyString(body, "audience") as RegistrySkillRolloutPolicyAudience,
      catalogScope: requireBodyString(body, "catalogScope") as RegistrySkillRolloutPolicyCatalogScope,
      targetOrgId: optionalBodyString(body, "orgId"),
      targetUserId: optionalBodyString(body, "userId"),
      workspaceId: optionalBodyString(body, "workspaceId"),
      enabled: optionalBodyBoolean(body, "enabled"),
      updatePolicy: requireBodyString(body, "updatePolicy") as RegistrySkillRolloutPolicyUpdatePolicy,
      releaseChannel: optionalBodyNullableString(body, "releaseChannel"),
      removalPolicy: requireBodyString(body, "removalPolicy") as RegistrySkillRolloutPolicyRemovalPolicy,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "PATCH", "/v1/skill-rollout-policies/:policyId", "host", async (ctx) => {
    ensureWritable(config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const body = await readJsonBody(ctx.request);
    const result = await updateRegistrySkillRolloutPolicy({
      ...skillRegistryRequestInput(ctx),
      policyId: ctx.params.policyId ?? "",
      skillId: optionalBodyString(body, "skillId"),
      versionId: optionalBodyNullableString(body, "versionId"),
      target: optionalBodyString(body, "target") as RegistrySkillRolloutPolicyTarget | undefined,
      audience: optionalBodyString(body, "audience") as RegistrySkillRolloutPolicyAudience | undefined,
      catalogScope: optionalBodyString(body, "catalogScope") as RegistrySkillRolloutPolicyCatalogScope | undefined,
      targetOrgId: optionalBodyNullableString(body, "orgId"),
      targetUserId: optionalBodyNullableString(body, "userId"),
      workspaceId: optionalBodyNullableString(body, "workspaceId"),
      enabled: optionalBodyBoolean(body, "enabled"),
      updatePolicy: optionalBodyString(body, "updatePolicy") as RegistrySkillRolloutPolicyUpdatePolicy | undefined,
      releaseChannel: optionalBodyNullableString(body, "releaseChannel"),
      removalPolicy: optionalBodyString(body, "removalPolicy") as
        | RegistrySkillRolloutPolicyRemovalPolicy
        | undefined,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "DELETE", "/v1/skill-rollout-policies/:policyId", "host", async (ctx) => {
    ensureWritable(config);
    requireSkillRegistryRequestBaseUrl(ctx);
    const result = await deleteRegistrySkillRolloutPolicy({
      ...skillRegistryRequestInput(ctx),
      policyId: ctx.params.policyId ?? "",
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/v1/skills/search", "client", async (ctx) => {
    const query = trimmedSearchParam(ctx.url.searchParams, "q");
    if (!query) {
      throw new ApiError(400, "invalid_query", "Skill registry search query is required");
    }

    if (!skillRegistryRequestBaseUrl(ctx)) {
      return jsonResponse({
        query,
        skills: [],
        nextCursor: null,
        registryConfigured: false,
      });
    }

    const limit = parseInteger(trimmedSearchParam(ctx.url.searchParams, "limit"));
    const includeDeletedParam = trimmedSearchParam(ctx.url.searchParams, "includeDeleted");
    const result = await searchRegistrySkills({
      ...skillRegistryRequestInput(ctx),
      query,
      cursor: trimmedSearchParam(ctx.url.searchParams, "cursor"),
      limit: limit ?? undefined,
      workspaceId: trimmedSearchParam(ctx.url.searchParams, "workspaceId"),
      ownerScope: trimmedSearchParam(ctx.url.searchParams, "ownerScope"),
      reviewStatus: trimmedSearchParam(ctx.url.searchParams, "reviewStatus"),
      includeDeleted: includeDeletedParam === undefined ? undefined : includeDeletedParam === "true",
      language: trimmedSearchParam(ctx.url.searchParams, "language"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/v1/skill-registry-events", "client", async (ctx) => {
    if (!skillRegistryRequestBaseUrl(ctx)) {
      return jsonResponse({
        events: [],
        nextCursor: null,
        revision: null,
        registryConfigured: false,
      });
    }

    const limit = parseInteger(trimmedSearchParam(ctx.url.searchParams, "limit"));
    const result = await listRegistrySkillEvents({
      ...skillRegistryRequestInput(ctx),
      cursor: trimmedSearchParam(ctx.url.searchParams, "cursor"),
      limit: limit ?? undefined,
      orgId: trimmedSearchParam(ctx.url.searchParams, "orgId"),
      workspaceId: trimmedSearchParam(ctx.url.searchParams, "workspaceId"),
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/skill-removals", "none", async (ctx) => {
    const actor = await requireHostOrClient(ctx.request, config, ctx.tokens);
    if (scopeRank(actor.scope ?? "viewer") < scopeRank("collaborator")) {
      throw new ApiError(403, "forbidden", "Insufficient token scope", {
        required: "collaborator",
        scope: actor.scope,
      });
    }
    const includeRestored = trimmedSearchParam(ctx.url.searchParams, "includeRestored") === "true";
    const scope = parseSkillRemovalScope(trimmedSearchParam(ctx.url.searchParams, "scope")) ?? "workspace";
    const workspaceId = trimmedSearchParam(ctx.url.searchParams, "workspaceId");
    let items = await listSkillRemovals({
      dataDir: serverDataDir,
      scope,
      includeRestored,
    });
    if (scope === "workspace") {
      if (workspaceId) {
        const workspace = await resolveWorkspace(config, workspaceId);
        items = items.filter((record) => record.workspaceId === workspace.id);
      } else {
        const visibleWorkspaceIds = new Set<string>();
        for (const workspace of config.workspaces) {
          try {
            const resolved = await resolveWorkspace(config, workspace.id);
            visibleWorkspaceIds.add(resolved.id);
          } catch {
            // Skip workspaces that are no longer authorized for this server.
          }
        }
        items = items.filter((record) => record.workspaceId && visibleWorkspaceIds.has(record.workspaceId));
      }
    } else if (actor.type !== "host" && actor.scope !== "owner") {
      throw new ApiError(403, "forbidden", "Owner or host access is required for user-global skill removals");
    }
    return jsonResponse({ items: items.map(serializeSkillRemoval) });
  });

  addRoute(routes, "POST", "/skill-removals/:id/restore", "host", async (ctx) => {
    ensureWritable(config);
    const record = await readSkillRemovalRecord({ dataDir: serverDataDir, removalId: ctx.params.id });
    let workspace: WorkspaceInfo | null = null;
    let skillRoots: string[] | undefined;
    if (record.scope === "workspace") {
      if (!record.workspaceId) {
        throw new ApiError(400, "invalid_skill_removal_record", "Workspace skill removal is missing a workspace id");
      }
      workspace = await resolveWorkspace(config, record.workspaceId);
      skillRoots = await workspaceSkillRootsForMutation(workspace.path);
    }
    const result = await restoreSkillRemoval({
      dataDir: serverDataDir,
      removalId: ctx.params.id,
      actor: ctx.actor ?? { type: "host" },
      ...(workspace && skillRoots
        ? {
            workspace: {
              id: workspace.id,
              rootDir: workspace.path,
              skillRoots,
            },
            authorizedRoots: config.authorizedRoots,
          }
        : record.scope === "user-global"
          ? { userGlobalSkillRoots: userGlobalSkillRootsForMutation() }
          : {}),
    });
    const reloadTrigger = {
      type: "skill" as const,
      name: record.name,
      action: "added" as const,
      path: result.path,
    };
    if (workspace) {
      await recordAudit(workspace.path, {
        id: shortId(),
        workspaceId: workspace.id,
        actor: ctx.actor ?? { type: "host" },
        action: "skills.restore",
        target: result.path,
        summary: `Restored skill ${record.name}`,
        timestamp: Date.now(),
      });
      emitReloadEvent(ctx.reloadEvents, workspace, "skills", reloadTrigger);
    } else if (record.scope === "user-global") {
      for (const configuredWorkspace of config.workspaces) {
        try {
          const resolved = await resolveWorkspace(config, configuredWorkspace.id);
          emitReloadEvent(ctx.reloadEvents, resolved, "skills", reloadTrigger);
        } catch {
          // Skip workspaces that are no longer authorized for this server.
        }
      }
    }
    return jsonResponse({
      ok: true,
      ...result,
      reloadRequired: true,
      trigger: { ...reloadTrigger, scope: record.scope },
    });
  });

  const removeSkillBatchItem = async (
    ctx: RequestContext,
    item: SkillBatchRemoveItem,
  ): Promise<SkillBatchRemoveSuccess> => {
    const installationId = item.registry?.installationId?.trim() ?? "";
    if (installationId) {
      requireSkillRegistryRequestBaseUrl(ctx);
      await deleteRegistrySkillInstallation({
        ...skillRegistryRequestInput(ctx),
        installationId,
      });
      const trigger = { type: "skill" as const, name: item.name, action: "removed" as const };
      return {
        id: item.id,
        index: item.index,
        ok: true,
        name: item.name,
        scope: item.scope,
        registry: { installationId },
        reloadRequired: true,
        trigger: { ...trigger, scope: item.scope },
      };
    }

    const policyId = item.registry?.policyId?.trim() ?? "";
    if (policyId) {
      requireSkillRegistryRequestBaseUrl(ctx);
      await updateRegistrySkillRolloutPolicy({
        ...skillRegistryRequestInput(ctx),
        policyId,
        enabled: false,
      });
      const trigger = { type: "skill" as const, name: item.name, action: "removed" as const };
      return {
        id: item.id,
        index: item.index,
        ok: true,
        name: item.name,
        scope: item.scope,
        registry: { policyId },
        reloadRequired: true,
        trigger: { ...trigger, scope: item.scope },
      };
    }

    if (item.scope === "workspace") {
      const workspaceId = item.workspaceId?.trim() ?? "";
      if (!workspaceId) {
        throw new ApiError(400, "invalid_skill_batch_item", "Workspace skill batch item requires workspaceId");
      }
      const workspace = await resolveWorkspace(config, workspaceId);
      const result = item.path
        ? await deleteSkillAtPathRecoverable(workspace.path, { name: item.name, path: item.path }, {
            dataDir: serverDataDir,
            workspaceId: workspace.id,
            actor: ctx.actor ?? { type: "host" },
            reason: item.reason,
          })
        : await deleteSkillRecoverable(workspace.path, item.name, {
            dataDir: serverDataDir,
            workspaceId: workspace.id,
            actor: ctx.actor ?? { type: "host" },
            reason: item.reason,
          });
      await recordAudit(workspace.path, {
        id: shortId(),
        workspaceId: workspace.id,
        actor: ctx.actor ?? { type: "host" },
        action: "skills.delete",
        target: result.path,
        summary: `Deleted skill ${item.name}`,
        timestamp: Date.now(),
      });
      const reloadTrigger = {
        type: "skill" as const,
        name: item.name,
        action: "removed" as const,
        path: result.path,
      };
      emitReloadEvent(ctx.reloadEvents, workspace, "skills", reloadTrigger);
      return {
        id: item.id,
        index: item.index,
        ok: true,
        name: item.name,
        scope: item.scope,
        path: result.path,
        removalId: result.removalId,
        reloadRequired: true,
        trigger: { ...reloadTrigger, scope: item.scope },
      };
    }

    if (item.scope === "user-global") {
      const result = await deleteGlobalSkillRecoverable(
        item.name,
        { path: item.path },
        {
          dataDir: serverDataDir,
          actor: ctx.actor ?? { type: "host" },
          reason: item.reason,
        },
      );
      const reloadTrigger = {
        type: "skill" as const,
        name: item.name,
        action: "removed" as const,
        path: result.path,
      };
      for (const configuredWorkspace of config.workspaces) {
        try {
          const resolved = await resolveWorkspace(config, configuredWorkspace.id);
          emitReloadEvent(ctx.reloadEvents, resolved, "skills", reloadTrigger);
        } catch {
          // Skip workspaces that are no longer authorized for this server.
        }
      }
      return {
        id: item.id,
        index: item.index,
        ok: true,
        name: item.name,
        scope: item.scope,
        path: result.path,
        removalId: result.removalId,
        reloadRequired: true,
        trigger: { ...reloadTrigger, scope: item.scope },
      };
    }

    throw new ApiError(400, "invalid_skill_batch_item", "Organization skills require registry mutation metadata");
  };

  addRoute(routes, "POST", "/skills/batch-remove", "host", async (ctx) => {
    ensureWritable(config);
    const body = await readJsonBody(ctx.request);
    if (!Array.isArray(body.items)) {
      throw new ApiError(400, "invalid_skill_batch_request", "Field items must be an array");
    }
    if (body.items.length > SKILL_BATCH_REMOVE_MAX_ITEMS) {
      throw new ApiError(
        400,
        "invalid_skill_batch_request",
        `Field items must contain at most ${SKILL_BATCH_REMOVE_MAX_ITEMS} entries`,
      );
    }

    const results: Array<SkillBatchRemoveSuccess | SkillBatchRemoveFailure> = [];
    for (const [index, rawItem] of body.items.entries()) {
      try {
        const item = parseSkillBatchRemoveItem(rawItem, index);
        results.push(await removeSkillBatchItem(ctx, item));
      } catch (error) {
        results.push(skillBatchRemoveFailure(rawItem, index, error));
      }
    }

    const succeeded = results.filter((result) => result.ok).length;
    const failed = results.length - succeeded;
    return jsonResponse({
      ok: failed === 0,
      succeeded,
      failed,
      results,
    });
  });

  addRoute(routes, "GET", "/skills/disabled", "client", async (ctx) => {
    const workspaceId = trimmedSearchParam(ctx.url.searchParams, "workspaceId");
    if (workspaceId) {
      await resolveWorkspace(config, workspaceId);
    }
    const items = await listDisabledSkills({
      dataDir: serverDataDir,
      workspaceId,
      includeGlobal: true,
    });
    return jsonResponse({ items });
  });

  addRoute(routes, "PATCH", "/skills/enabled-state", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const body = await readJsonBody(ctx.request);
    const target = requireBodyObject(body, "target") as unknown as DisabledSkillTarget;
    const enabled = optionalBodyBoolean(body, "enabled");
    if (enabled === undefined) {
      throw new ApiError(400, "invalid_enabled", "enabled is required");
    }

    const workspaceId = typeof target.workspaceId === "string" ? target.workspaceId.trim() : "";
    const workspace = workspaceId ? await resolveWorkspace(config, workspaceId) : null;
    const result = await setSkillEnabledState({
      dataDir: serverDataDir,
      target,
      enabled,
      actor: ctx.actor ?? { type: "remote" },
    });

    const reloadTrigger: ReloadTrigger = {
      type: "skill",
      name: typeof target.name === "string" ? target.name.trim() || undefined : undefined,
      action: "updated",
      path: typeof target.path === "string" ? target.path.trim() || undefined : undefined,
    };
    if (workspace) {
      emitReloadEvent(ctx.reloadEvents, workspace, "skills", reloadTrigger);
    } else if (target.scope === "user-global" || target.scope === "organization" || target.scope === "platform") {
      for (const configuredWorkspace of config.workspaces) {
        emitReloadEvent(ctx.reloadEvents, configuredWorkspace, "skills", reloadTrigger);
      }
    }

    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/skills/user-global-store", "client", async () => {
    return jsonResponse({ items: await listUserGlobalSkills(serverDataDir) });
  });

  addRoute(routes, "GET", "/skills/user-global-store/:name", "client", async (ctx) => {
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    return jsonResponse(await readUserGlobalSkill(name, serverDataDir));
  });

  addRoute(routes, "POST", "/skills/user-global-store", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "").trim();
    const content = String(body.content ?? "");
    const description = body.description ? String(body.description) : undefined;
    const enabled = typeof body.enabled === "boolean" ? body.enabled : undefined;
    const result = await upsertUserGlobalSkill({ name, content, description, enabled }, serverDataDir);

    await recordAudit(userGlobalSkillStorePath(serverDataDir), {
      id: shortId(),
      workspaceId: "global",
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.user_global_store.upsert",
      target: result.item.path,
      summary: `Upserted user-global skill ${result.item.name}`,
      timestamp: Date.now(),
    });

    return jsonResponse({
      ok: true,
      action: result.action,
      item: result.item,
      reloadRequired: true,
      trigger: {
        type: "skill",
        name: result.item.name,
        action: result.action,
        path: result.item.path,
        scope: "user-global",
      },
    });
  });

  addRoute(routes, "DELETE", "/skills/user-global-store/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const result = await deleteUserGlobalSkill(name, serverDataDir);

    await recordAudit(userGlobalSkillStorePath(serverDataDir), {
      id: shortId(),
      workspaceId: "global",
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.user_global_store.delete",
      target: result.item.path,
      summary: `Deleted user-global skill ${result.item.name}`,
      timestamp: Date.now(),
    });

    return jsonResponse({
      ok: true,
      name: result.item.name,
      path: result.item.path,
      reloadRequired: true,
      trigger: {
        type: "skill",
        name: result.item.name,
        action: "removed",
        path: result.item.path,
        scope: "user-global",
      },
    });
  });

  addRoute(routes, "GET", "/skills/user-global/:name", "none", async (ctx) => {
    await requireHostOrClient(ctx.request, config, ctx.tokens);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const instancePath = trimmedSearchParam(ctx.url.searchParams, "path");
    if (!instancePath) {
      throw new ApiError(400, "invalid_skill_path", "User-global exact skill read requires path");
    }
    const result = await readGlobalSkillAtPath({ name, path: instancePath });
    const item = {
      name,
      path: result.path,
      description: "",
      scope: "global" as const,
    };
    const disabledSkills = await listDisabledSkills({
      dataDir: serverDataDir,
      includeGlobal: true,
    });
    const disabled = disabledSkills.some((record) => disabledRecordMatchesSkill(record, item, undefined));
    if (disabled && ctx.url.searchParams.get("includeDisabled") !== "true") {
      throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
    }
    return jsonResponse({
      item: disabled ? { ...item, enabled: false, disabledReason: "user" } : item,
      content: result.content,
    });
  });

  addRoute(routes, "DELETE", "/skills/user-global/:name", "none", async (ctx) => {
    ensureWritable(config);
    const actor = await requireHostOrClient(ctx.request, config, ctx.tokens);
    if (scopeRank(actor.scope ?? "viewer") < scopeRank("collaborator")) {
      throw new ApiError(403, "forbidden", "Insufficient token scope", {
        required: "collaborator",
        scope: actor.scope,
      });
    }
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const result = await deleteGlobalSkillRecoverable(
      name,
      { path: trimmedSearchParam(ctx.url.searchParams, "path") },
      {
        dataDir: serverDataDir,
        actor,
        reason: trimmedSearchParam(ctx.url.searchParams, "reason"),
      },
    );
    const reloadTrigger = {
      type: "skill" as const,
      name,
      action: "removed" as const,
      path: result.path,
    };
    for (const configuredWorkspace of config.workspaces) {
      try {
        const resolved = await resolveWorkspace(config, configuredWorkspace.id);
        emitReloadEvent(ctx.reloadEvents, resolved, "skills", reloadTrigger);
      } catch {
        // Skip workspaces that are no longer authorized for this server.
      }
    }
    return jsonResponse({
      ok: true,
      name,
      path: result.path,
      removalId: result.removalId,
      reloadRequired: true,
      trigger: { ...reloadTrigger, scope: "user-global" },
    });
  });

  addRoute(routes, "GET", "/skills/materialization", "client", async () => {
    return jsonResponse(await buildGlobalSkillMaterializationStatus(config));
  });

  addRoute(routes, "POST", "/skills/materialization/sync-global", "host", async (ctx) => {
    ensureWritable(config);
    const body = await readOptionalJsonBody(ctx.request);
    if (body.activeRun === true) {
      const status = await buildGlobalSkillMaterializationStatus(config);
      return jsonResponse({
        ...status,
        status: "pending",
        synced: false,
        reloadRequired: true,
        conflicts: [],
      }, 202);
    }

    const { materializations, conflicts, packagesByInstallationId } = await fetchRegistryPersonalGlobalMaterializations(ctx);
    const loadPackage = async (skill: WorkspaceSkillMaterialization) => {
      const archive = packagesByInstallationId.get(skill.installationId);
      if (!archive) {
        throw new ApiError(500, "skill_package_missing", `Missing package for skill ${skill.name}`);
      }
      return archive;
    };

    const result = await materializePersonalGlobalSkillSet({
      skills: materializations,
      loadPackage,
      unmanagedSkillRoots: userGlobalSkillRootsForMutation(),
    });

    await recordAudit(result.rootDir, {
      id: shortId(),
      workspaceId: "global",
      actor: ctx.actor ?? { type: "host" },
      action: "skills.materialization.sync-global",
      target: result.rootDir,
      summary: `Synced ${materializations.length} managed global skill materialization(s)`,
      timestamp: Date.now(),
    });
    for (const workspace of config.workspaces) {
      emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
        type: "skill",
        name: "veslo-managed",
        action: "updated",
        path: result.rootDir,
      });
    }

    return jsonResponse({
      scope: "personal-global",
      status: "synced",
      synced: true,
      reloadRequired: true,
      registryConfigured: Boolean(skillRegistryBaseUrl(config)),
      rootDir: result.rootDir,
      materializedSkills: materializations.map(materializationSummaryPayload),
      conflicts,
      removedSkillNames: result.removedSkillNames,
      backupDirs: result.backupDirs,
    });
  });

  addRoute(routes, "GET", "/hub/skills", "client", async (ctx) => {
    const denToken = ctx.request.headers.get("x-veslo-den-token")?.trim() || "";
    if (!denToken) {
      throw new ApiError(401, "den_token_required", "Missing Den token header (x-veslo-den-token)");
    }

    const denOrgId = ctx.request.headers.get("x-veslo-den-org-id")?.trim() || "";
    if (!denOrgId) {
      throw new ApiError(400, "den_org_required", "Missing Den org header (x-veslo-den-org-id)");
    }

    const denApiBase = config.denApiBase?.trim() || "";
    if (!denApiBase) {
      return jsonResponse({ items: [] });
    }

    const items = await fetchOrgSkillsCatalog({
      baseUrl: denApiBase,
      orgId: denOrgId,
      denToken,
    });

    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/hub/mcp", "client", async (ctx) => {
    const denToken = ctx.request.headers.get("x-veslo-den-token")?.trim() || "";
    if (!denToken) {
      throw new ApiError(401, "den_token_required", "Missing Den token header (x-veslo-den-token)");
    }

    const denOrgId = ctx.request.headers.get("x-veslo-den-org-id")?.trim() || "";
    if (!denOrgId) {
      throw new ApiError(400, "den_org_required", "Missing Den org header (x-veslo-den-org-id)");
    }

    const denApiBase = config.denApiBase?.trim() || "";
    if (!denApiBase) {
      return jsonResponse({ items: [] });
    }

    const items = await fetchOrgMcpCatalog({
      baseUrl: denApiBase,
      orgId: denOrgId,
      denToken,
    });

    return jsonResponse({ items });
  });

  const listWorkspaceRuntimeSkills = async (
    workspace: WorkspaceInfo,
    options: { includeGlobal: boolean; includeDisabled?: boolean },
  ) => {
    const disabledSkills = await listDisabledSkills({
      dataDir: serverDataDir,
      workspaceId: workspace.id,
      includeGlobal: true,
    });
    return listSkills(workspace.path, {
      includeGlobal: options.includeGlobal,
      includeDisabled: options.includeDisabled,
      disabledSkills,
      workspaceId: workspace.id,
      workspaceOwner: ownerForWorkspace(workspace),
    });
  };

  addRoute(routes, "GET", "/workspace/:id/skills", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const includeDisabled = ctx.url.searchParams.get("includeDisabled") === "true";
    const items = await listWorkspaceRuntimeSkills(workspace, { includeGlobal, includeDisabled });
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/skills/resolve", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const text = typeof body.text === "string" ? body.text : "";
    const includeGlobal = body?.includeGlobal === true || ctx.url.searchParams.get("includeGlobal") === "true";
    const threshold = typeof body.threshold === "number" ? body.threshold : undefined;
    const ambiguityDelta = typeof body.ambiguityDelta === "number" ? body.ambiguityDelta : undefined;
    const maxCandidates = typeof body.maxCandidates === "number" ? body.maxCandidates : undefined;
    const skills = await listWorkspaceRuntimeSkills(workspace, { includeGlobal });
    const result = resolveSkillMatch({
      text,
      skills,
      threshold,
      ambiguityDelta,
      maxCandidates,
    });
    return jsonResponse(result);
  });

  addRoute(routes, "GET", "/workspace/:id/skills/materialization", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse(await buildWorkspaceSkillMaterializationStatus(config, workspace));
  });

  addRoute(routes, "POST", "/workspace/:id/skills/user-global-store/sync", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.user_global_store.sync",
      summary: "Sync user-global skills into workspace runtime",
      paths: [userGlobalMaterializedSkillsRoot(workspace.path)],
    });

    const result = await materializeUserGlobalSkillsForWorkspace({
      workspaceRoot: workspace.path,
      workspaceId: workspace.id,
      dataDir: serverDataDir,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.user_global_store.sync",
      target: result.rootDir,
      summary: `Synced ${result.materializedSkills.length} user-global skill(s) into workspace runtime`,
      timestamp: Date.now(),
    });

    if (result.reloadRequired) {
      emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
        type: "skill",
        name: "veslo-user",
        action: "updated",
        path: result.rootDir,
      });
    }

    return jsonResponse(result);
  });

  addRoute(routes, "POST", "/workspace/:id/skills/materialization/sync", "host", async (ctx) => {
    ensureWritable(config);
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readOptionalJsonBody(ctx.request);
    if (body.activeRun === true) {
      const status = await buildWorkspaceSkillMaterializationStatus(config, workspace);
      return jsonResponse({
        ...status,
        status: "pending",
        synced: false,
        reloadRequired: true,
        conflicts: [],
      }, 202);
    }

    const {
      materializations,
      conflicts,
      packagesByInstallationId,
      personalGlobalSyncRequired,
      skillSetId,
      skillSetRevision,
    } =
      await fetchRegistryWorkspaceMaterializations(ctx, workspace);
    const workspaceMaterializations = materializations.filter((skill) => skill.target === "workspace");
    const personalGlobalMaterializations = materializations.filter((skill) => skill.target === "personal-global");
    const loadPackage = async (skill: WorkspaceSkillMaterialization) => {
      const archive = packagesByInstallationId.get(skill.installationId);
      if (!archive) {
        throw new ApiError(500, "skill_package_missing", `Missing package for skill ${skill.name}`);
      }
      return archive;
    };

    const workspaceResult = await materializeWorkspaceSkillSet({
      workspaceRoot: workspace.path,
      skills: workspaceMaterializations,
      loadPackage,
    });
    let personalGlobalResult: SkillSetMaterializationResult = {
      rootDir: personalGlobalManagedSkillsRoot(),
      materializedSkills: [],
      removedSkillNames: [],
      backupDirs: [],
    };
    if (personalGlobalSyncRequired) {
      personalGlobalResult = await materializePersonalGlobalSkillSet({
        skills: personalGlobalMaterializations,
        loadPackage,
        unmanagedSkillRoots: userGlobalSkillRootsForMutation(),
      });
    }
    const responseMaterializations = [
      ...workspaceMaterializations,
      ...personalGlobalMaterializations,
    ];
    const lockfileEntries = workspaceMaterializations.map((skill) => ({
      skillId: skill.skillId,
      installationId: skill.installationId,
      versionId: skill.versionId,
      name: skill.name,
      packageSha256: skill.packageSha256,
    }));
    const lockfilePath = await writeWorkspaceSkillLockfile(workspace.path, {
      schemaVersion: 1,
      workspaceId: workspace.id,
      skillSetId,
      skillSetRevision,
      entries: lockfileEntries,
    });

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "host" },
      action: "skills.materialization.sync",
      target: workspaceResult.rootDir,
      summary: `Synced ${responseMaterializations.length} managed skill materialization(s)`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name: "veslo-managed",
      action: "updated",
      path: workspaceResult.rootDir,
    });

    return jsonResponse({
      workspaceId: workspace.id,
      status: "synced",
      synced: true,
      reloadRequired: true,
      registryConfigured: true,
      rootDir: workspaceResult.rootDir,
      globalRootDir: personalGlobalResult.rootDir,
      lockfilePath,
      materializedSkills: responseMaterializations.map(materializationSummaryPayload),
      conflicts,
      removedSkillNames: [
        ...workspaceResult.removedSkillNames,
        ...personalGlobalResult.removedSkillNames,
      ].sort(),
      backupDirs: [
        ...workspaceResult.backupDirs,
        ...personalGlobalResult.backupDirs,
      ],
    });
  });

  addRoute(routes, "POST", "/workspace/:id/skills/hub/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const body = await readJsonBody(ctx.request);
    const overwrite = body?.overwrite === true;
    const repoPayload = body?.repo && typeof body.repo === "object" ? (body.repo as Record<string, unknown>) : undefined;
    const repo = repoPayload
      ? {
          owner: typeof repoPayload.owner === "string" ? repoPayload.owner : undefined,
          repo: typeof repoPayload.repo === "string" ? repoPayload.repo : undefined,
          ref: typeof repoPayload.ref === "string" ? repoPayload.ref : undefined,
        }
      : undefined;

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.install_hub",
      summary: `Install hub skill ${name}`,
      paths: [join(workspace.path, ".opencode", "skills", name)],
    });

    const result = await installHubSkill(workspace.path, { name, overwrite, repo });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.install_hub",
      target: result.path,
      summary: `Installed hub skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: result.action,
      path: result.path,
    });

    return jsonResponse({ ok: true, ...result });
  });

  addRoute(routes, "GET", "/workspace/:id/skills/:name", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const includeGlobal = ctx.url.searchParams.get("includeGlobal") === "true";
    const includeDisabled = ctx.url.searchParams.get("includeDisabled") === "true";
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const items = await listWorkspaceRuntimeSkills(workspace, { includeGlobal, includeDisabled });
    const instancePath = ctx.url.searchParams.get("path")?.trim() ?? "";
    if (instancePath) {
      const allowedItem = items.find((skill) => skill.name === name && resolve(skill.path) === resolve(instancePath));
      if (!allowedItem) {
        throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
      }
      const result = await readSkillAtPath(workspace.path, { name, path: instancePath });
      return jsonResponse({
        item: allowedItem,
        content: result.content,
      });
    }
    const item = items.find((skill) => skill.name === name);
    if (!item) {
      throw new ApiError(404, "skill_not_found", `Skill not found: ${name}`);
    }
    const content = await readFile(item.path, "utf8");
    return jsonResponse({ item, content });
  });

  addRoute(routes, "POST", "/workspace/:id/skills", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const content = String(body.content ?? "");
    const description = body.description ? String(body.description) : undefined;
    const instancePath = typeof body.path === "string" ? body.path.trim() : "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.upsert",
      summary: `Upsert skill ${name}`,
      paths: [instancePath || join(workspace.path, ".opencode", "skills", name, "SKILL.md")],
    });
    const result = instancePath
      ? await updateSkillAtPath(workspace.path, { name, path: instancePath, content, description })
      : await upsertSkill(workspace.path, { name, content, description });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.upsert",
      target: result.path,
      summary: `Upserted skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: result.action,
      path: result.path,
    });
    return jsonResponse({ name, path: result.path, description: description ?? "", scope: "project" });
  });

  addRoute(routes, "DELETE", "/workspace/:id/skills/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    if (!name) {
      throw new ApiError(400, "invalid_skill_name", "Skill name is required");
    }
    const instancePath = ctx.url.searchParams.get("path")?.trim() ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "skills.delete",
      summary: `Delete skill ${name}`,
      paths: [instancePath || join(workspace.path, ".opencode", "skills", name)],
    });
    const result = instancePath
      ? await deleteSkillAtPathRecoverable(workspace.path, { name, path: instancePath }, {
          dataDir: serverDataDir,
          workspaceId: workspace.id,
          actor: ctx.actor ?? { type: "remote" },
          reason: trimmedSearchParam(ctx.url.searchParams, "reason"),
        })
      : await deleteSkillRecoverable(workspace.path, name, {
          dataDir: serverDataDir,
          workspaceId: workspace.id,
          actor: ctx.actor ?? { type: "remote" },
          reason: trimmedSearchParam(ctx.url.searchParams, "reason"),
        });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "skills.delete",
      target: result.path,
      summary: `Deleted skill ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "skills", {
      type: "skill",
      name,
      action: "removed",
      path: result.path,
    });
    return jsonResponse({ ok: true, name, path: result.path, removalId: result.removalId });
  });

  addRoute(routes, "GET", "/workspace/:id/mcp", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listMcp(workspace.path, { workspaceOwner: ownerForWorkspace(workspace) });
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/mcp/hub/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const catalogName = String(ctx.params.name ?? "").trim();
    if (!catalogName) {
      throw new ApiError(400, "invalid_mcp_name", "MCP name is required");
    }

    const denToken = ctx.request.headers.get("x-veslo-den-token")?.trim() || "";
    if (!denToken) {
      throw new ApiError(401, "den_token_required", "Missing Den token header (x-veslo-den-token)");
    }

    const denOrgId = ctx.request.headers.get("x-veslo-den-org-id")?.trim() || "";
    if (!denOrgId) {
      throw new ApiError(400, "den_org_required", "Missing Den org header (x-veslo-den-org-id)");
    }

    const denApiBase = config.denApiBase?.trim() || "";
    if (!denApiBase) {
      throw new ApiError(503, "den_catalog_misconfigured", "Den catalog base URL is missing");
    }

    const items = await fetchOrgMcpCatalog({
      baseUrl: denApiBase,
      orgId: denOrgId,
      denToken,
    });
    const item = items.find((entry) => entry.id === catalogName || entry.name === catalogName);
    if (!item) {
      throw new ApiError(404, "hub_mcp_not_found", `Hub MCP not found: ${catalogName}`);
    }

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.install_hub",
      summary: `Install hub MCP ${catalogName}`,
      paths: [opencodeConfigPath(workspace.path)],
    });

    let installItem = item;
    if (item.authorization?.type === "veslo-server-oauth") {
      const runtimeToken = await createOrgMcpRuntimeToken({
        baseUrl: denApiBase,
        denToken,
        runtimeTokenPath: item.authorization.runtimeTokenPath,
      });
      installItem = {
        ...item,
        config: {
          ...item.config,
          headers: {
            ...(item.config.headers ?? {}),
            "X-Veslo-Connector-Token": runtimeToken.token,
          },
        },
      };
    }

    const result = await installHubMcp(workspace.path, installItem);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.install_hub",
      target: "opencode.json",
      summary: `Installed hub MCP ${result.name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
      type: "mcp",
      name: result.name,
      action: result.action,
    });

    return jsonResponse({ ok: true, ...result });
  });

  addRoute(routes, "POST", "/workspace/:id/mcp", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const configPayload = body.config as Record<string, unknown> | undefined;
    if (!configPayload) {
      throw new ApiError(400, "invalid_payload", "MCP config is required");
    }
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.add",
      summary: `Add MCP ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const result = await addMcp(workspace.path, name, configPayload);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.add",
      target: "opencode.json",
      summary: `Added MCP ${name}`,
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
      type: "mcp",
      name,
      action: result.action,
    });
    const items = await listMcp(workspace.path, { workspaceOwner: ownerForWorkspace(workspace) });
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/mcp/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.remove",
      summary: `Remove MCP ${name}`,
      paths: [opencodeConfigPath(workspace.path)],
    });
    const removed = await removeMcp(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.remove",
      target: "opencode.json",
      summary: `Removed MCP ${name}`,
      timestamp: Date.now(),
    });
    if (removed) {
      emitReloadEvent(ctx.reloadEvents, workspace, "mcp", {
        type: "mcp",
        name,
        action: "removed",
      });
    }
    const items = await listMcp(workspace.path, { workspaceOwner: ownerForWorkspace(workspace) });
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/mcp/:name/auth", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = String(ctx.params.name ?? "").trim();
    validateMcpName(name);

    const authStorePath = join(homedir(), ".config", "opencode", "mcp-auth.json");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "mcp.auth.remove",
      summary: `Logout MCP ${name}`,
      paths: [authStorePath],
    });

    // Best-effort disconnect so any active connection is torn down.
    try {
      await fetchOpencodeJson(workspace, `/mcp/${encodeURIComponent(name)}/disconnect`, { method: "POST" });
    } catch {
      // ignore
    }

    try {
      await fetchOpencodeJson(workspace, `/mcp/${encodeURIComponent(name)}/auth`, { method: "DELETE" });
    } catch (error) {
      // Treat missing credentials as a successful logout (idempotent).
      if (
        error instanceof ApiError &&
        error.code === "opencode_request_failed" &&
        error.details &&
        typeof error.details === "object" &&
        "status" in (error.details as Record<string, unknown>) &&
        (error.details as { status?: unknown }).status === 404
      ) {
        // ok
      } else {
        throw error;
      }
    }

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "mcp.auth.remove",
      target: authStorePath,
      summary: `Logged out MCP ${name}`,
      timestamp: Date.now(),
    });

    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/commands", "client", async (ctx) => {
    const scope = ctx.url.searchParams.get("scope") === "global" ? "global" : "workspace";
    if (scope === "global") {
      await requireHost(ctx.request, config, tokens);
    }
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listCommands(workspace.path, scope, { workspaceOwner: ownerForWorkspace(workspace) });
    return jsonResponse({ items });
  });

  addRoute(routes, "POST", "/workspace/:id/commands", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const name = String(body.name ?? "");
    const template = String(body.template ?? "");
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.upsert",
      summary: `Upsert command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    const path = await upsertCommand(workspace.path, {
      name,
      description: body.description ? String(body.description) : undefined,
      template,
      agent: body.agent ? String(body.agent) : undefined,
      model: body.model ? String(body.model) : undefined,
      subtask: typeof body.subtask === "boolean" ? body.subtask : undefined,
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.upsert",
      target: path,
      summary: `Upserted command ${name}`,
      timestamp: Date.now(),
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "commands", {
      type: "command",
      name: sanitizeCommandName(name),
      action: "updated",
      path,
    });
    const items = await listCommands(workspace.path, "workspace", { workspaceOwner: ownerForWorkspace(workspace) });
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/commands/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "commands.delete",
      summary: `Delete command ${name}`,
      paths: [join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`)],
    });
    await deleteCommand(workspace.path, name);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "commands.delete",
      target: join(workspace.path, ".opencode", "commands"),
      summary: `Deleted command ${name}`,
      timestamp: Date.now(),
    });

    emitReloadEvent(ctx.reloadEvents, workspace, "commands", {
      type: "command",
      name: sanitizeCommandName(name),
      action: "removed",
      path: join(workspace.path, ".opencode", "commands", `${sanitizeCommandName(name)}.md`),
    });
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/workspace/:id/automations", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const store = await readAutomationStore(workspace.path, workspace.id, { migrateLegacy: !config.readOnly });
    return jsonResponse({ items: store.items, updatedAt: store.updatedAt });
  });

  addRoute(routes, "POST", "/workspace/:id/automations", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const automation = createAutomationFromPayload(workspace, body);
    const path = resolveAutomationsPath(workspace.path);

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "automations.create",
      summary: `Create automation ${automation.name}`,
      paths: [path],
    });

    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      if (store.items.some((item) => item.id === automation.id)) {
        throw new ApiError(409, "automation_conflict", "Automation id already exists");
      }
      return { ...store, updatedAt: automation.updatedAt, items: [automation, ...store.items] };
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "automations.create",
      target: path,
      summary: `Created automation ${automation.name}`,
      timestamp: Date.now(),
    });
    await ctx.automationRunner.refreshWorkspace(workspace.id);
    return jsonResponse({ automation }, 201);
  });

  addRoute(routes, "PATCH", "/workspace/:id/automations/:automationId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAutomationId(ctx.params.automationId);
    const body = await readJsonBody(ctx.request);
    const path = resolveAutomationsPath(workspace.path);

    let automation: VesloAutomation | null = null;
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "automations.update",
      summary: `Update automation ${automationId}`,
      paths: [path],
    });
    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      const items = store.items.map((item) => {
        if (item.id !== automationId) return item;
        automation = updateAutomationFromPayload(item, body);
        return automation;
      });
      if (!automation) {
        throw new ApiError(404, "automation_not_found", "Automation not found");
      }
      return { ...store, updatedAt: automation.updatedAt, items };
    });
    const updatedAutomation = automation as VesloAutomation | null;
    if (!updatedAutomation) {
      throw new ApiError(404, "automation_not_found", "Automation not found");
    }
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "automations.update",
      target: path,
      summary: `Updated automation ${updatedAutomation.name}`,
      timestamp: Date.now(),
    });
    await ctx.automationRunner.refreshWorkspace(workspace.id);
    return jsonResponse({ automation: updatedAutomation });
  });

  addRoute(routes, "DELETE", "/workspace/:id/automations/:automationId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAutomationId(ctx.params.automationId);
    const path = resolveAutomationsPath(workspace.path);

    let automation: VesloAutomation | null = null;
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "automations.delete",
      summary: `Cancel automation ${automationId}`,
      paths: [path],
    });
    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      const updatedAt = new Date().toISOString();
      const items = store.items.map((item) => {
        if (item.id !== automationId) return item;
        automation = {
          ...item,
          enabled: false,
          status: "cancelled",
          nextRunAt: null,
          updatedAt,
        };
        return automation;
      });
      if (!automation) {
        throw new ApiError(404, "automation_not_found", "Automation not found");
      }
      return { ...store, updatedAt, items };
    });
    const cancelledAutomation = automation as VesloAutomation | null;
    if (!cancelledAutomation) {
      throw new ApiError(404, "automation_not_found", "Automation not found");
    }
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "automations.delete",
      target: path,
      summary: `Cancelled automation ${cancelledAutomation.name}`,
      timestamp: Date.now(),
    });
    await ctx.automationRunner.refreshWorkspace(workspace.id);
    return jsonResponse({ automation: cancelledAutomation });
  });

  addRoute(routes, "POST", "/workspace/:id/automations/:automationId/run", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAutomationId(ctx.params.automationId);
    const path = resolveAutomationsPath(workspace.path);

    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "automations.run",
      summary: `Run automation ${automationId}`,
      paths: [path],
    });
    const run = await ctx.automationRunner.runNow(workspace.id, automationId);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "automations.run",
      target: path,
      summary: `Ran automation ${automationId}`,
      timestamp: Date.now(),
    });
    return jsonResponse({ run });
  });

  addRoute(routes, "GET", "/workspace/:id/automations/:automationId/runs", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAutomationId(ctx.params.automationId);
    const store = await readAutomationStore(workspace.path, workspace.id, { migrateLegacy: !config.readOnly });
    const items = store.runs.filter((run) => run.automationId === automationId);
    if (!store.items.some((item) => item.id === automationId) && items.length === 0) {
      throw new ApiError(404, "automation_not_found", "Automation not found");
    }
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/agentlab/automations", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const store = await readAutomationStore(workspace.path, workspace.id, { migrateLegacy: !config.readOnly });
    const legacy = legacyAgentLabStoreFromAutomations(store);
    return jsonResponse({ items: legacy.items, updatedAt: legacy.updatedAt });
  });

  addRoute(routes, "POST", "/workspace/:id/agentlab/automations", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const automation = createAutomationFromPayload(workspace, {
      ...body,
      id: body.id ? validateAgentLabAutomationId(body.id) : `agentlab_${shortId().replace(/-/g, "")}`,
    });
    const path = resolveAutomationsPath(workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "automations.create",
      summary: `Upsert automation ${automation.name}`,
      paths: [path],
    });

    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      const existing = store.items.find((item) => item.id === automation.id);
      const nextAutomation = existing
        ? { ...automation, createdAt: existing.createdAt, lastRunId: existing.lastRunId ?? null }
        : automation;
      const items = store.items.filter((item) => item.id !== automation.id);
      return { ...store, updatedAt: nextAutomation.updatedAt, items: [nextAutomation, ...items] };
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "automations.create",
      target: path,
      summary: `Upserted automation ${automation.name}`,
      timestamp: Date.now(),
    });
    await ctx.automationRunner.refreshWorkspace(workspace.id);

    const next = legacyAgentLabStoreFromAutomations(await readAutomationStore(workspace.path, workspace.id));
    return jsonResponse({ items: next.items, updatedAt: next.updatedAt }, 201);
  });

  addRoute(routes, "DELETE", "/workspace/:id/agentlab/automations/:automationId", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAgentLabAutomationId(ctx.params.automationId);

    const path = resolveAutomationsPath(workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "automations.delete",
      summary: `Cancel automation ${automationId}`,
      paths: [path],
    });

    let automation: VesloAutomation | null = null;
    await mutateAutomationStore(workspace.path, workspace.id, (store) => {
      const updatedAt = new Date().toISOString();
      const items = store.items.map((item) => {
        if (item.id !== automationId) return item;
        automation = { ...item, enabled: false, status: "cancelled", nextRunAt: null, updatedAt };
        return automation;
      });
      if (!automation) {
        throw new ApiError(404, "automation_not_found", "Automation not found");
      }
      return { ...store, updatedAt, items };
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "automations.delete",
      target: path,
      summary: `Cancelled automation ${automationId}`,
      timestamp: Date.now(),
    });
    await ctx.automationRunner.refreshWorkspace(workspace.id);
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "POST", "/workspace/:id/agentlab/automations/:automationId/run", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAgentLabAutomationId(ctx.params.automationId);
    const path = resolveAutomationsPath(workspace.path);
    const run = await ctx.automationRunner.runNow(workspace.id, automationId);

    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "automations.run",
      target: path,
      summary: `Ran automation ${automationId}`,
      timestamp: Date.now(),
    });

    if (run.status === "failed") {
      return jsonResponse({
        ok: false,
        automationId,
        sessionId: run.sessionId,
        ranAt: run.finishedAt ? Date.parse(run.finishedAt) : Date.now(),
        run,
      }, 502);
    }

    return jsonResponse({
      ok: true,
      automationId,
      sessionId: run.sessionId,
      ranAt: run.finishedAt ? Date.parse(run.finishedAt) : Date.now(),
      run,
    });
  });

  addRoute(routes, "GET", "/workspace/:id/agentlab/automations/logs", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const logsDir = resolveAgentLabLogsDir(workspace.path);
    if (!(await exists(logsDir))) {
      return jsonResponse({ items: [] });
    }
    const entries = await readdir(logsDir, { withFileTypes: true });
    const items: Array<{ id: string; path: string; size: number; updatedAt: number }> = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (!entry.name.endsWith(".log")) continue;
      const id = entry.name.slice(0, -4);
      const abs = join(logsDir, entry.name);
      try {
        const info = await stat(abs);
        items.push({ id, path: entry.name, size: info.size, updatedAt: info.mtimeMs });
      } catch {
        // ignore
      }
    }
    items.sort((a, b) => b.updatedAt - a.updatedAt);
    return jsonResponse({ items });
  });

  addRoute(routes, "GET", "/workspace/:id/agentlab/automations/logs/:automationId", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const automationId = validateAgentLabAutomationId(ctx.params.automationId);
    const logsDir = resolveAgentLabLogsDir(workspace.path);
    const abs = join(logsDir, `${automationId}.log`);
    if (!(await exists(abs))) {
      throw new ApiError(404, "log_not_found", "Log not found");
    }
    const content = await readFile(abs, "utf8");
    return jsonResponse({ id: automationId, content });
  });

  addRoute(routes, "GET", "/workspace/:id/scheduler/jobs", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const items = await listScheduledJobs(workspace.path);
    return jsonResponse({ items });
  });

  addRoute(routes, "DELETE", "/workspace/:id/scheduler/jobs/:name", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const name = ctx.params.name ?? "";
    const { job, jobFile, systemPaths } = await resolveScheduledJob(name, workspace.path);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "scheduler.delete",
      summary: `Delete scheduled job ${job.name}`,
      paths: [jobFile, ...systemPaths],
    });
    await deleteScheduledJob(job, jobFile);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "scheduler.delete",
      target: jobFile,
      summary: `Deleted scheduled job ${job.name}`,
      timestamp: Date.now(),
    });
    return jsonResponse({ job });
  });

  addRoute(routes, "GET", "/soul", "client", async (ctx) => {
    const organization = await readOrganizationSoulModel(ctx);
    const user = await readUserSoulModel(ctx);
    const workspaces = await Promise.all(config.workspaces.map(async (configuredWorkspace) => {
      const workspace = await resolveWorkspace(config, configuredWorkspace.id);
      return (await readWorkspaceSoulModel(ctx, workspace)).summary;
    }));
    return jsonResponse({
      organization: organization.summary,
      user: user.summary,
      workspaces,
    });
  });

  addRoute(routes, "GET", "/soul/organization", "client", async (ctx) => {
    return jsonResponse(soulReadPayload(await readOrganizationSoulModel(ctx)));
  });

  addRoute(routes, "GET", "/soul/user", "client", async (ctx) => {
    return jsonResponse(soulReadPayload(await readUserSoulModel(ctx)));
  });

  addRoute(routes, "GET", "/soul/workspaces", "client", async (ctx) => {
    const workspaces = await Promise.all(config.workspaces.map(async (configuredWorkspace) => {
      const workspace = await resolveWorkspace(config, configuredWorkspace.id);
      return (await readWorkspaceSoulModel(ctx, workspace)).summary;
    }));
    return jsonResponse({ workspaces });
  });

  addRoute(routes, "GET", "/workspace/:id/soul", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    return jsonResponse(soulReadPayload(await readWorkspaceSoulModel(ctx, workspace)));
  });

  addRoute(routes, "POST", "/workspace/:id/soul/materialization/sync", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readOptionalJsonBody(ctx.request);
    await requireSoulApproval(ctx, {
      workspaceId: workspace.id,
      action: "soul.materialization.sync",
      summary: `Sync Soul runtime files for ${workspace.name}`,
      paths: soulMaterializationApprovalPaths(workspace),
    });
    const result = await materializeSoulForWorkspace(serverDataDir, ctx, workspace, {}, {
      workspaceActive: soulWorkspaceActiveFromBody(body, workspace.id),
    });
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "soul.materialization.sync",
      target: workspace.path,
      summary: result.pending
        ? "Soul runtime sync is pending because the workspace has an active run"
        : "Synced Soul runtime files",
      timestamp: Date.now(),
    });
    return jsonResponse(result, result.pending ? 202 : 200);
  });

  addRoute(routes, "GET", "/soul/:scope/versions", "client", async (ctx) => {
    const scope = validateSoulScopeParam(ctx.params.scope);
    if (scope === "workspace") {
      const workspaceId = ctx.url.searchParams.get("workspaceId")?.trim();
      if (!workspaceId) {
        throw new ApiError(400, "workspace_id_required", "workspaceId query parameter is required");
      }
      const workspace = await resolveWorkspace(config, workspaceId);
      const versions = await readCachedSoulVersions(serverDataDir, "workspace", workspace.id);
      return jsonResponse({ versions, nextCursor: null });
    }

    const den = soulDenContext(ctx);
    const ownerId = scope === "organization" ? den.orgId : den.userId;
    if (den.baseUrl && den.denToken && ownerId) {
      try {
        const response = await listSoulVersions({
          ...den,
          token: den.denToken,
          scope,
          cursor: ctx.url.searchParams.get("cursor")?.trim() || undefined,
          limit: parseInteger(ctx.url.searchParams.get("limit") ?? undefined) ?? undefined,
        });
        return jsonResponse(response);
      } catch (error) {
        if (!isSoulDenUnavailable(error)) throw error;
      }
    }

    const versions = ownerId ? await readCachedSoulVersions(serverDataDir, scope, ownerId) : [];
    return jsonResponse({ versions, nextCursor: null, denSynced: false });
  });

  addRoute(routes, "GET", "/soul/:scope/versions/:versionId", "client", async (ctx) => {
    const scope = validateSoulScopeParam(ctx.params.scope);
    if (scope === "workspace") {
      const workspaceId = ctx.url.searchParams.get("workspaceId")?.trim();
      if (!workspaceId) {
        throw new ApiError(400, "workspace_id_required", "workspaceId query parameter is required");
      }
      const workspace = await resolveWorkspace(config, workspaceId);
      const document = await readCachedSoulDocument({ dataDir: serverDataDir, scope: "workspace", ownerId: workspace.id });
      if (!document) throw new ApiError(404, "soul_not_found", "Soul document not found");
      return jsonResponse({ version: soulVersionResponse(document, ctx.params.versionId) });
    }

    const den = soulDenContext(ctx);
    const ownerId = scope === "organization" ? den.orgId : den.userId;
    if (den.baseUrl && den.denToken && ownerId) {
      try {
        const version = await getSoulVersion({ ...den, token: den.denToken, scope, versionId: ctx.params.versionId });
        return jsonResponse({ version });
      } catch (error) {
        if (!isSoulDenUnavailable(error)) throw error;
      }
    }

    if (!ownerId) throw new ApiError(404, "soul_not_found", "Soul document not found");
    const document = await readCachedSoulDocument({ dataDir: serverDataDir, scope, ownerId });
    if (!document) throw new ApiError(404, "soul_not_found", "Soul document not found");
    return jsonResponse({ version: soulVersionResponse(document, ctx.params.versionId), denSynced: false });
  });

  addRoute(routes, "PATCH", "/soul/organization", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const den = soulDenContext(ctx);
    const denToken = requireSoulDenToken(den);
    const orgId = requireSoulOrgId(den);
    if (!den.baseUrl) {
      throw new ApiError(503, "soul_den_misconfigured", "Soul Den base URL is missing");
    }
    const body = await readJsonBody(ctx.request);
    const content = requireSoulText(body, "content");
    const changeSummary = requireSoulText(body, "changeSummary");
    const baseVersionId = optionalSoulBaseVersionId(body);
    await requireSoulApproval(ctx, {
      workspaceId: globalSoulApprovalWorkspaceId(config),
      action: "soul.organization.update",
      summary: "Update Organization Soul",
      paths: await configuredSoulMaterializationApprovalPaths(config, [
        soulCachePath({ dataDir: serverDataDir, scope: "organization", ownerId: orgId }),
      ]),
    });
    const document = await updateOrganizationSoul({
      ...den,
      token: denToken,
      content,
      changeSummary,
      baseVersionId,
    });
    await cacheSoulDocument({ dataDir: serverDataDir, document });
    const materialization = await materializeSoulForConfiguredWorkspaces(serverDataDir, config, ctx, {
      organization: document,
    }, {
      activeWorkspaceIds: activeSoulWorkspaceIdsFromBody(body),
    });
    return jsonResponse(soulReadPayload({
      document,
      summary: soulSummary({
        scope: "organization",
        ownerId: document.ownerId,
        document,
        canEdit: soulCanEdit(ctx, "organization"),
      }),
      denSynced: true,
      materialization,
    }));
  });

  addRoute(routes, "PATCH", "/soul/user", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const den = soulDenContext(ctx);
    const userId = requireSoulUserId(den);
    const body = await readJsonBody(ctx.request);
    const content = requireSoulText(body, "content");
    const changeSummary = requireSoulText(body, "changeSummary");
    const baseVersionId = optionalSoulBaseVersionId(body);
    await requireSoulApproval(ctx, {
      workspaceId: globalSoulApprovalWorkspaceId(config),
      action: "soul.user.update",
      summary: "Update User Soul",
      paths: await configuredSoulMaterializationApprovalPaths(config, [
        soulCachePath({ dataDir: serverDataDir, scope: "user", ownerId: userId }),
        soulPendingCacheDir(serverDataDir),
      ]),
    });

    if (den.baseUrl && den.denToken) {
      try {
        const document = await updateUserSoul({
          ...den,
          token: den.denToken,
          content,
          changeSummary,
          baseVersionId,
        });
        await cacheSoulDocument({ dataDir: serverDataDir, document });
        const materialization = await materializeSoulForConfiguredWorkspaces(serverDataDir, config, ctx, {
          user: document,
        }, {
          activeWorkspaceIds: activeSoulWorkspaceIdsFromBody(body),
        });
        return jsonResponse(soulReadPayload({
          document,
          summary: soulSummary({
            scope: "user",
            ownerId: document.ownerId,
            document,
            canEdit: soulCanEdit(ctx, "user"),
          }),
          denSynced: true,
          materialization,
        }));
      } catch (error) {
        if (!isSoulDenUnavailable(error)) throw error;
      }
    }

    const pendingEdit = await writePendingSoulEdit({
      dataDir: serverDataDir,
      edit: {
        scope: "user",
        ownerId: userId,
        content,
        changeSummary,
        baseVersionId,
        createdAt: new Date().toISOString(),
        createdBy: soulActorId(ctx),
      },
    });
    const cached = await readCachedSoulDocument({ dataDir: serverDataDir, scope: "user", ownerId: userId });
    return jsonResponse(soulReadPayload({
      document: cached,
      summary: soulSummary({
        scope: "user",
        ownerId: userId,
        document: cached,
        canEdit: soulCanEdit(ctx, "user"),
        status: "pending",
      }),
      pendingEdits: [pendingEdit],
      denSynced: false,
    }), 202);
  });

  addRoute(routes, "POST", "/soul/organization/versions/:versionId/restore", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const den = soulDenContext(ctx);
    const denToken = requireSoulDenToken(den);
    const orgId = requireSoulOrgId(den);
    if (!den.baseUrl) {
      throw new ApiError(503, "soul_den_misconfigured", "Soul Den base URL is missing");
    }
    const body = await readOptionalJsonBody(ctx.request);
    const changeSummary = typeof body.changeSummary === "string" && body.changeSummary.trim()
      ? body.changeSummary
      : "Restore Organization Soul version";
    await requireSoulApproval(ctx, {
      workspaceId: globalSoulApprovalWorkspaceId(config),
      action: "soul.organization.restore",
      summary: `Restore Organization Soul version ${ctx.params.versionId}`,
      paths: await configuredSoulMaterializationApprovalPaths(config, [
        soulCachePath({ dataDir: serverDataDir, scope: "organization", ownerId: orgId }),
      ]),
    });
    const document = await restoreDenSoulVersion({
      ...den,
      token: denToken,
      scope: "organization",
      versionId: ctx.params.versionId,
      changeSummary,
    });
    await cacheSoulDocument({ dataDir: serverDataDir, document });
    const materialization = await materializeSoulForConfiguredWorkspaces(serverDataDir, config, ctx, {
      organization: document,
    }, {
      activeWorkspaceIds: activeSoulWorkspaceIdsFromBody(body),
    });
    return jsonResponse(soulReadPayload({
      document,
      summary: soulSummary({
        scope: "organization",
        ownerId: document.ownerId,
        document,
        canEdit: soulCanEdit(ctx, "organization"),
      }),
      denSynced: true,
      materialization,
    }));
  });

  addRoute(routes, "POST", "/soul/user/versions/:versionId/restore", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const den = soulDenContext(ctx);
    const userId = requireSoulUserId(den);
    const body = await readOptionalJsonBody(ctx.request);
    const changeSummary = typeof body.changeSummary === "string" && body.changeSummary.trim()
      ? body.changeSummary
      : "Restore User Soul version";
    await requireSoulApproval(ctx, {
      workspaceId: globalSoulApprovalWorkspaceId(config),
      action: "soul.user.restore",
      summary: `Restore User Soul version ${ctx.params.versionId}`,
      paths: await configuredSoulMaterializationApprovalPaths(config, [
        soulCachePath({ dataDir: serverDataDir, scope: "user", ownerId: userId }),
      ]),
    });
    if (den.baseUrl && den.denToken) {
      try {
        const document = await restoreDenSoulVersion({
          ...den,
          token: den.denToken,
          scope: "user",
          versionId: ctx.params.versionId,
          changeSummary,
        });
        await cacheSoulDocument({ dataDir: serverDataDir, document });
        const materialization = await materializeSoulForConfiguredWorkspaces(serverDataDir, config, ctx, {
          user: document,
        }, {
          activeWorkspaceIds: activeSoulWorkspaceIdsFromBody(body),
        });
        return jsonResponse(soulReadPayload({
          document,
          summary: soulSummary({
            scope: "user",
            ownerId: document.ownerId,
            document,
            canEdit: soulCanEdit(ctx, "user"),
          }),
          denSynced: true,
          materialization,
        }));
      } catch (error) {
        if (!isSoulDenUnavailable(error)) throw error;
      }
    }

    const cached = await readCachedSoulDocument({ dataDir: serverDataDir, scope: "user", ownerId: userId });
    if (!cached) throw new ApiError(404, "soul_not_found", "Soul document not found");
    const restored = restoreLocalSoulVersion(cached, {
      id: soulVersionId("user_restore_"),
      restoreSourceVersionId: ctx.params.versionId,
      changeSummary,
      createdAt: new Date().toISOString(),
      createdBy: soulActorId(ctx),
    });
    await cacheSoulDocument({ dataDir: serverDataDir, document: restored });
    const materialization = await materializeSoulForConfiguredWorkspaces(serverDataDir, config, ctx, {
      user: restored,
    }, {
      activeWorkspaceIds: activeSoulWorkspaceIdsFromBody(body),
    });
    return jsonResponse(soulReadPayload({
      document: restored,
      summary: soulSummary({
        scope: "user",
        ownerId: restored.ownerId,
        document: restored,
        canEdit: soulCanEdit(ctx, "user"),
        status: "pending",
      }),
      pendingEdits: await listPendingSoulEdits({ dataDir: serverDataDir }),
      denSynced: false,
      materialization,
    }));
  });

  addRoute(routes, "PATCH", "/workspace/:id/soul", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    const content = requireSoulText(body, "content");
    const changeSummary = requireSoulText(body, "changeSummary");
    const baseVersionId = optionalSoulBaseVersionId(body);
    await requireSoulApproval(ctx, {
      workspaceId: workspace.id,
      action: "soul.workspace.update",
      summary: `Update Workspace Soul for ${workspace.name}`,
      paths: [
        soulCachePath({ dataDir: serverDataDir, scope: "workspace", ownerId: workspace.id }),
        ...soulMaterializationApprovalPaths(workspace),
      ],
    });
    const existing = await readCachedSoulDocument({
      dataDir: serverDataDir,
      scope: "workspace",
      ownerId: workspace.id,
    });
    const document = createSoulVersion(
      existing ?? { ...emptySoulDocument("workspace", workspace.id), heartbeatEnabled: true },
      {
        id: soulVersionId("workspace_"),
        content,
        changeSummary,
        createdAt: new Date().toISOString(),
        createdBy: soulActorId(ctx),
        source: "api",
        baseVersionId,
      },
    );
    const nextDocument = { ...document, heartbeatEnabled: existing?.heartbeatEnabled ?? true };
    await cacheSoulDocument({ dataDir: serverDataDir, document: nextDocument });
    const materialization = await materializeSoulForWorkspace(serverDataDir, ctx, workspace, {
      workspace: nextDocument,
    }, {
      workspaceActive: soulWorkspaceActiveFromBody(body, workspace.id),
    });
    return jsonResponse(soulReadPayload({
      document: nextDocument,
      summary: soulSummary({
        scope: "workspace",
        ownerId: workspace.id,
        document: nextDocument,
        canEdit: soulCanEdit(ctx, "workspace"),
        workspace,
      }),
      materialization,
    }));
  });

  addRoute(routes, "POST", "/workspace/:id/soul/versions/:versionId/restore", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const document = await readCachedSoulDocument({ dataDir: serverDataDir, scope: "workspace", ownerId: workspace.id });
    if (!document) throw new ApiError(404, "soul_not_found", "Soul document not found");
    const body = await readOptionalJsonBody(ctx.request);
    const changeSummary = typeof body.changeSummary === "string" && body.changeSummary.trim()
      ? body.changeSummary
      : "Restore Workspace Soul version";
    await requireSoulApproval(ctx, {
      workspaceId: workspace.id,
      action: "soul.workspace.restore",
      summary: `Restore Workspace Soul version ${ctx.params.versionId}`,
      paths: [
        soulCachePath({ dataDir: serverDataDir, scope: "workspace", ownerId: workspace.id }),
        ...soulMaterializationApprovalPaths(workspace),
      ],
    });
    const restored = restoreLocalSoulVersion(document, {
      id: soulVersionId("workspace_restore_"),
      restoreSourceVersionId: ctx.params.versionId,
      changeSummary,
      createdAt: new Date().toISOString(),
      createdBy: soulActorId(ctx),
    });
    await cacheSoulDocument({ dataDir: serverDataDir, document: restored });
    const materialization = await materializeSoulForWorkspace(serverDataDir, ctx, workspace, {
      workspace: restored,
    }, {
      workspaceActive: soulWorkspaceActiveFromBody(body, workspace.id),
    });
    return jsonResponse(soulReadPayload({
      document: restored,
      summary: soulSummary({
        scope: "workspace",
        ownerId: workspace.id,
        document: restored,
        canEdit: soulCanEdit(ctx, "workspace"),
        workspace,
      }),
      materialization,
    }));
  });

  addRoute(routes, "POST", "/workspace/:id/soul/heartbeat-toggle", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readOptionalJsonBody(ctx.request);
    const existing = await readCachedSoulDocument({ dataDir: serverDataDir, scope: "workspace", ownerId: workspace.id });
    const enabled = typeof body.enabled === "boolean" ? body.enabled : !(existing?.heartbeatEnabled ?? false);
    await requireSoulApproval(ctx, {
      workspaceId: workspace.id,
      action: "soul.workspace.heartbeat-toggle",
      summary: `${enabled ? "Enable" : "Disable"} Workspace Soul heartbeat`,
      paths: [
        soulCachePath({ dataDir: serverDataDir, scope: "workspace", ownerId: workspace.id }),
      ],
    });
    const document = { ...(existing ?? emptySoulDocument("workspace", workspace.id)), heartbeatEnabled: enabled };
    await cacheSoulDocument({ dataDir: serverDataDir, document });
    return jsonResponse(soulReadPayload({
      document,
      summary: soulSummary({
        scope: "workspace",
        ownerId: workspace.id,
        document,
        canEdit: soulCanEdit(ctx, "workspace"),
        workspace,
      }),
    }));
  });

  addRoute(routes, "GET", "/workspace/:id/soul/status", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const status = await getSoulStatus(workspace.path);
    return jsonResponse(status);
  });

  addRoute(routes, "GET", "/workspace/:id/soul/heartbeats", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const limitParam = ctx.url.searchParams.get("limit");
    const parsedLimit = limitParam ? Number(limitParam) : NaN;
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.min(parsedLimit, 200) : 20;
    const { items, total, path } = await listSoulHeartbeats(workspace.path, limit);
    return jsonResponse({ items, total, path });
  });

  addRoute(routes, "GET", "/workspace/:id/export", "client", async (ctx) => {
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const exportPayload = await exportWorkspace(workspace);
    return jsonResponse(exportPayload);
  });

  addRoute(routes, "POST", "/workspace/:id/import", "client", async (ctx) => {
    ensureWritable(config);
    requireClientScope(ctx, "collaborator");
    const workspace = await resolveWorkspace(config, ctx.params.id);
    const body = await readJsonBody(ctx.request);
    await requireApproval(ctx, {
      workspaceId: workspace.id,
      action: "config.import",
      summary: "Import workspace config",
      paths: [opencodeConfigPath(workspace.path), vesloConfigPath(workspace.path)],
    });
    await importWorkspace(workspace, body);
    await recordAudit(workspace.path, {
      id: shortId(),
      workspaceId: workspace.id,
      actor: ctx.actor ?? { type: "remote" },
      action: "config.import",
      target: "workspace",
      summary: "Imported workspace config",
      timestamp: Date.now(),
    });
    emitReloadEvent(ctx.reloadEvents, workspace, "config", buildConfigTrigger(opencodeConfigPath(workspace.path)));
    return jsonResponse({ ok: true });
  });

  addRoute(routes, "GET", "/approvals", "host", async (ctx) => {
    return jsonResponse({ items: ctx.approvals.list() });
  });

  addRoute(routes, "POST", "/approvals/:id", "host", async (ctx) => {
    const body = await readJsonBody(ctx.request);
    const reply = body.reply === "allow" ? "allow" : "deny";
    const result = ctx.approvals.respond(ctx.params.id, reply);
    if (!result) {
      throw new ApiError(404, "approval_not_found", "Approval request not found");
    }
    return jsonResponse({ ok: true, allowed: result.allowed });
  });

  return routes;
}

async function resolveWorkspace(config: ServerConfig, id: string): Promise<WorkspaceInfo> {
  const workspace = config.workspaces.find((entry) => entry.id === id);
  if (!workspace) {
    throw new ApiError(404, "workspace_not_found", "Workspace not found");
  }
  const resolvedWorkspace = resolve(workspace.path);
  const authorized = isAuthorizedRootSync(resolvedWorkspace, config.authorizedRoots);
  if (!authorized) {
    throw new ApiError(403, "workspace_unauthorized", "Workspace is not authorized");
  }
  const baseUrl = resolveWorkspaceOpencodeBaseUrl(config, workspace);
  return {
    ...workspace,
    path: resolvedWorkspace,
    ...(baseUrl ? { baseUrl } : {}),
  };
}

function isAuthorizedRootSync(workspacePath: string, roots: string[]): boolean {
  const normalizeAuthorizedPath = (value: string) => {
    const resolved = normalizeOpencodeDirectory(resolve(value));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const resolvedWorkspace = normalizeAuthorizedPath(workspacePath);
  for (const root of roots) {
    const resolvedRoot = normalizeAuthorizedPath(root);
    if (resolvedWorkspace === resolvedRoot) return true;
    if (resolvedWorkspace.startsWith(resolvedRoot + sep)) return true;
  }
  return false;
}

async function isAuthorizedRoot(workspacePath: string, roots: string[]): Promise<boolean> {
  const normalizeAuthorizedPath = (value: string) => {
    const resolved = normalizeOpencodeDirectory(resolve(value));
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  const resolvedWorkspace = normalizeAuthorizedPath(workspacePath);
  for (const root of roots) {
    const resolvedRoot = normalizeAuthorizedPath(root);
    if (resolvedWorkspace === resolvedRoot) return true;
    if (resolvedWorkspace.startsWith(resolvedRoot + sep)) return true;
  }
  return false;
}

function ensureWritable(config: ServerConfig): void {
  if (config.readOnly) {
    throw new ApiError(403, "read_only", "Server is read-only");
  }
}

function scopeRank(scope: TokenScope): number {
  if (scope === "viewer") return 1;
  if (scope === "collaborator") return 2;
  return 3;
}

function requireClientScope(ctx: RequestContext, required: TokenScope): void {
  const scope = ctx.actor?.scope;
  if (!scope) {
    throw new ApiError(401, "unauthorized", "Missing token scope");
  }
  if (scopeRank(scope) < scopeRank(required)) {
    throw new ApiError(403, "forbidden", "Insufficient token scope", { required, scope });
  }
}

type BodyReadOptions = {
  maxBytes?: number;
  label?: string;
};

function readMaxBytes(options?: BodyReadOptions): number {
  return options?.maxBytes ?? DEFAULT_JSON_BODY_MAX_BYTES;
}

function bodyLimitLabel(options?: BodyReadOptions): string {
  return options?.label ?? "request body";
}

function contentLengthFor(headers: Headers): number | null {
  const parsed = Number(headers.get("content-length") ?? NaN);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return parsed;
}

async function readRequestTextWithLimit(request: Request, options?: BodyReadOptions): Promise<string> {
  const maxBytes = readMaxBytes(options);
  const label = bodyLimitLabel(options);
  const contentLength = contentLengthFor(request.headers);
  if (contentLength !== null && contentLength > maxBytes) {
    await request.body?.cancel().catch(() => undefined);
    throw new ApiError(413, "payload_too_large", "Request body exceeds size limit", {
      label,
      maxBytes,
      size: contentLength,
    });
  }

  const preview = await readTextPreview(request.body, maxBytes);
  if (preview.truncated) {
    throw new ApiError(413, "payload_too_large", "Request body exceeds size limit", {
      label,
      maxBytes,
    });
  }
  return preview.text;
}

async function readJsonBody(request: Request, options?: BodyReadOptions): Promise<Record<string, unknown>> {
  try {
    const text = await readRequestTextWithLimit(request, options);
    const json = JSON.parse(text);
    return json as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

async function readOptionalJsonBody(request: Request, options?: BodyReadOptions): Promise<Record<string, unknown>> {
  const text = await readRequestTextWithLimit(request, options);
  if (!text.trim()) return {};
  try {
    const json = JSON.parse(text);
    return json && typeof json === "object" && !Array.isArray(json) ? json as Record<string, unknown> : {};
  } catch {
    throw new ApiError(400, "invalid_json", "Invalid JSON body");
  }
}

function parseInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function resolveOpenCodeJsonFetchTimeoutMs(): number {
  const parsed = parseInteger(process.env.VESLO_OPENCODE_JSON_FETCH_TIMEOUT_MS);
  if (parsed && parsed > 0) {
    return clampNumber(parsed, 100, 60_000);
  }
  return OPENCODE_JSON_FETCH_DEFAULT_TIMEOUT_MS;
}

function resolveOpencodeProxyHeadersTimeoutMs(): number {
  const parsed = parseInteger(process.env.VESLO_OPENCODE_PROXY_HEADERS_TIMEOUT_MS);
  if (parsed && parsed > 0) {
    return clampNumber(parsed, 100, 600_000);
  }
  return OPENCODE_PROXY_HEADERS_DEFAULT_TIMEOUT_MS;
}

function resolveAiGatewayProxyHeadersTimeoutMs(): number {
  const parsed = parseInteger(process.env.VESLO_AI_GATEWAY_PROXY_HEADERS_TIMEOUT_MS);
  if (parsed && parsed > 0) {
    return clampNumber(parsed, 100, 600_000);
  }
  return AI_GATEWAY_PROXY_HEADERS_DEFAULT_TIMEOUT_MS;
}

function resolveAiGatewayProviderStartTimeoutMs(): number {
  const parsed = parseInteger(process.env.VESLO_AI_GATEWAY_PROVIDER_START_TIMEOUT_MS);
  if (parsed && parsed > 0) {
    return clampNumber(parsed, 10, 600_000);
  }
  return AI_GATEWAY_PROVIDER_START_DEFAULT_TIMEOUT_MS;
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = "name" in error ? String((error as { name?: unknown }).name ?? "") : "";
  return name === "AbortError" || name === "TimeoutError";
}

function expandHome(value: string): string {
  if (value.startsWith("~/")) {
    return join(homedir(), value.slice(2));
  }
  return value;
}

function resolveOpenCodeRouterConfigPath(): string {
  const override = process.env.OPENCODE_ROUTER_CONFIG_PATH?.trim();
  if (override) return expandHome(override);
  const dataDir = process.env.OPENCODE_ROUTER_DATA_DIR?.trim() || join(homedir(), ".veslo", "opencode-router");
  return join(expandHome(dataDir), "opencode-router.json");
}

function resolveOpenCodeRouterHealthPort(): number {
  return parseInteger(process.env.OPENCODE_ROUTER_HEALTH_PORT) ?? 3005;
}

function parseJsonResponse(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

function normalizeHealthPort(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const port = Math.trunc(value);
  if (port <= 0 || port > 65535) return null;
  return port;
}

type OpenCodeRouterConfigFile = Record<string, unknown> & {
  version?: number;
  channels?: Record<string, unknown> & {
    telegram?: Record<string, unknown>;
    slack?: Record<string, unknown>;
  };
};

type TelegramBotInfo = {
  id: number;
  username?: string;
  name?: string;
};

function ensurePlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

type VesloServerConfigFile = Record<string, unknown> & {
  workspaces?: Array<Record<string, unknown>>;
  authorizedRoots?: string[];
};

async function persistWorkspaceDeletion(configPath: string, workspaceId: string, workspacePath: string): Promise<boolean> {
  if (!configPath.trim()) return false;
  if (!(await exists(configPath))) {
    // If the server was started from CLI args/env, avoid implicitly creating server.json
    // because it can change token behavior on restart.
    return false;
  }

  let raw = "";
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new ApiError(500, "server_config_read_failed", "Failed to read server config", {
      path: configPath,
      error: String(error),
    });
  }

  let parsed: VesloServerConfigFile;
  try {
    parsed = ensurePlainObject(JSON.parse(raw)) as VesloServerConfigFile;
  } catch (error) {
    throw new ApiError(422, "invalid_json", "Failed to parse server config", {
      path: configPath,
      error: String(error),
    });
  }

  const configDir = dirname(configPath);
  const workspacesRaw = parsed.workspaces;
  const workspaces = Array.isArray(workspacesRaw) ? workspacesRaw : [];

  const nextWorkspaces = workspaces.filter((entry) => {
    const obj = ensurePlainObject(entry);
    const path = typeof obj.path === "string" ? obj.path.trim() : "";
    if (!path) return true;
    const id = workspaceIdForPath(resolve(configDir, path));
    return id !== workspaceId;
  });

  const rootsRaw = parsed.authorizedRoots;
  const roots = Array.isArray(rootsRaw) ? rootsRaw : [];
  const nextRoots = roots.filter((root) => {
    const value = typeof root === "string" ? root.trim() : "";
    if (!value) return false;
    return resolve(configDir, value) !== resolve(workspacePath);
  });

  const workspacesChanged = nextWorkspaces.length !== workspaces.length;
  const rootsChanged = nextRoots.length !== roots.length;
  if (!workspacesChanged && !rootsChanged) return false;

  const next: VesloServerConfigFile = {
    ...parsed,
    ...(workspacesChanged ? { workspaces: nextWorkspaces } : {}),
    ...(rootsChanged ? { authorizedRoots: nextRoots } : {}),
  };

  await ensureDir(dirname(configPath));
  const tmpPath = `${configPath}.tmp.${shortId()}`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, configPath);
    return true;
  } finally {
    try {
      await rm(tmpPath);
    } catch {
      // ignore
    }
  }
}

function normalizeOpenCodeRouterIdentityId(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  if (!trimmed) return "default";
  const safe = trimmed.replace(/[^a-zA-Z0-9_.-]+/g, "-");
  const cleaned = safe.replace(/^-+|-+$/g, "").slice(0, 48);
  return cleaned || "default";
}

type TelegramAccessMode = "public" | "private";

const TELEGRAM_PAIRING_CODE_HASH_PATTERN = /^[a-f0-9]{64}$/;
const TELEGRAM_PAIRING_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

function normalizeTelegramAccessMode(value: unknown, fallback: TelegramAccessMode = "public"): TelegramAccessMode {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (raw === "private") return "private";
  if (raw === "public") return "public";
  return fallback;
}

function normalizeTelegramPairingCode(value: string): string {
  return value.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

function normalizeTelegramPairingCodeHash(value: unknown): string {
  const raw = typeof value === "string" ? value.trim().toLowerCase() : "";
  if (!TELEGRAM_PAIRING_CODE_HASH_PATTERN.test(raw)) return "";
  return raw;
}

function hashTelegramPairingCode(value: string): string {
  return createHash("sha256").update(normalizeTelegramPairingCode(value)).digest("hex");
}

function generateTelegramPairingCode(): string {
  let code = "";
  for (let index = 0; index < 8; index += 1) {
    code += TELEGRAM_PAIRING_CODE_ALPHABET[randomInt(0, TELEGRAM_PAIRING_CODE_ALPHABET.length)] ?? "";
  }
  if (code.length !== 8) {
    throw new ApiError(500, "pairing_code_generation_failed", "Failed to generate Telegram pairing code");
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

function resolveTelegramAccessFromRecord(record: Record<string, unknown>): {
  access: TelegramAccessMode;
  pairingCodeHash: string;
} {
  const pairingCodeHash = normalizeTelegramPairingCodeHash(record.pairingCodeHash);
  const access = normalizeTelegramAccessMode(record.access, pairingCodeHash ? "private" : "public");
  return {
    access,
    pairingCodeHash: access === "private" ? pairingCodeHash : "",
  };
}

async function readOpenCodeRouterConfigFile(configPath: string): Promise<OpenCodeRouterConfigFile> {
  if (!(await exists(configPath))) {
    return { version: 1 };
  }

  let raw = "";
  try {
    raw = await readFile(configPath, "utf8");
  } catch (error) {
    throw new ApiError(500, "opencodeRouter_config_read_failed", "Failed to read opencode-router.json", {
      path: configPath,
      error: String(error),
    });
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    return ensurePlainObject(parsed) as OpenCodeRouterConfigFile;
  } catch (error) {
    throw new ApiError(422, "invalid_json", "Failed to parse opencode-router.json", {
      path: configPath,
      error: String(error),
    });
  }
}

async function writeOpenCodeRouterConfigFile(configPath: string, config: OpenCodeRouterConfigFile): Promise<void> {
  await ensureDir(dirname(configPath));
  const next: OpenCodeRouterConfigFile = {
    ...config,
    version: typeof config.version === "number" && Number.isFinite(config.version) ? config.version : 1,
  };
  const tmpPath = `${configPath}.tmp.${shortId()}`;
  try {
    await writeFile(tmpPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    await rename(tmpPath, configPath);
  } finally {
    // Best-effort cleanup if rename failed.
    try {
      await rm(tmpPath);
    } catch {
      // ignore
    }
  }
}

async function persistOpenCodeRouterTelegramToken(token: string): Promise<void> {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const telegram = ensurePlainObject(channels.telegram);

  const botsRaw = (telegram as any).bots;
  const bots = Array.isArray(botsRaw) ? (botsRaw as unknown[]) : [];
  const nextBots: Array<Record<string, unknown>> = [];
  let found = false;
  for (const entry of bots) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id !== "default") {
      nextBots.push(record);
      continue;
    }
    found = true;
    nextBots.push({ id: "default", token, enabled: true });
  }
  if (!found) nextBots.push({ id: "default", token, enabled: true });

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      telegram: {
        ...telegram,
        // New format (multi-identity)
        bots: nextBots,
        // Legacy (single-identity)
        token,
        enabled: true,
      },
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
}

async function persistOpenCodeRouterTelegramIdentity(identity: {
  id: string;
  token: string;
  enabled: boolean;
  directory?: string;
  access?: TelegramAccessMode;
  pairingCodeHash?: string;
}): Promise<void> {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const telegram = ensurePlainObject(channels.telegram);

  const id = normalizeOpenCodeRouterIdentityId(identity.id);
  const token = identity.token.trim();
  const directory = typeof identity.directory === "string" ? identity.directory.trim() : "";
  const requestedAccess = identity.access ? normalizeTelegramAccessMode(identity.access, "public") : undefined;
  const requestedPairingCodeHash = normalizeTelegramPairingCodeHash(identity.pairingCodeHash);
  if (!token) {
    throw new ApiError(400, "token_required", "Telegram token is required");
  }

  const botsRaw = (telegram as any).bots;
  const bots = Array.isArray(botsRaw) ? (botsRaw as unknown[]) : [];
  const nextBots: Array<Record<string, unknown>> = [];
  let found = false;
  for (const entry of bots) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const entryId = normalizeOpenCodeRouterIdentityId(record.id);
    if (entryId !== id) {
      nextBots.push(record);
      continue;
    }
    found = true;
    const prevDir = typeof record.directory === "string" ? record.directory.trim() : "";
    const nextDir = directory || prevDir;
    const existingAccessState = resolveTelegramAccessFromRecord(record);
    const access = requestedAccess ?? existingAccessState.access;
    const pairingCodeHash = access === "private"
      ? (requestedPairingCodeHash || existingAccessState.pairingCodeHash)
      : "";
    if (access === "private" && !pairingCodeHash) {
      throw new ApiError(400, "pairing_code_required", "Telegram private access requires a pairing code hash");
    }
    nextBots.push({
      id,
      token,
      enabled: identity.enabled,
      ...(nextDir ? { directory: nextDir } : {}),
      access,
      ...(access === "private" ? { pairingCodeHash } : {}),
    });
  }
  if (!found) {
    const access = requestedAccess ?? "public";
    const pairingCodeHash = access === "private" ? requestedPairingCodeHash : "";
    if (access === "private" && !pairingCodeHash) {
      throw new ApiError(400, "pairing_code_required", "Telegram private access requires a pairing code hash");
    }
    nextBots.push({
      id,
      token,
      enabled: identity.enabled,
      ...(directory ? { directory } : {}),
      access,
      ...(access === "private" ? { pairingCodeHash } : {}),
    });
  }

  const nextTelegram: Record<string, unknown> = {
    ...telegram,
    enabled: true,
    bots: nextBots,
  };
  if (id === "default") {
    // Legacy fallback.
    nextTelegram.token = token;
  }

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      telegram: nextTelegram,
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
}

async function deleteOpenCodeRouterTelegramIdentity(idRaw: string): Promise<boolean> {
  const id = normalizeOpenCodeRouterIdentityId(idRaw);
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const telegram = ensurePlainObject(channels.telegram);

  const botsRaw = (telegram as any).bots;
  const bots = Array.isArray(botsRaw) ? (botsRaw as unknown[]) : [];
  const nextBots: Array<Record<string, unknown>> = [];
  let deleted = false;
  for (const entry of bots) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const entryId = normalizeOpenCodeRouterIdentityId(record.id);
    if (entryId === id) {
      deleted = true;
      continue;
    }
    nextBots.push(record);
  }

  const nextTelegram: Record<string, unknown> = {
    ...telegram,
    bots: nextBots,
  };
  if (id === "default") {
    delete (nextTelegram as any).token;
  }

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      telegram: nextTelegram,
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
  return deleted;
}

async function persistOpenCodeRouterTelegramEnabled(enabled: boolean, options?: { clearToken?: boolean }) {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const telegram = ensurePlainObject(channels.telegram);

  const botsRaw = (telegram as any).bots;
  const bots = Array.isArray(botsRaw) ? (botsRaw as unknown[]) : [];
  const nextBots: Array<Record<string, unknown>> = [];
  for (const entry of bots) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (!id) {
      nextBots.push(record);
      continue;
    }
    // Leave per-bot enabled as-is; global channel enabled gates all identities.
    if (!enabled && options?.clearToken && id === "default") {
      const nextRecord = { ...record };
      delete (nextRecord as any).token;
      nextBots.push(nextRecord);
      continue;
    }
    nextBots.push(record);
  }

  const nextTelegram: Record<string, unknown> = {
    ...telegram,
    enabled,
    ...(bots.length ? { bots: nextBots } : {}),
  };
  if (!enabled && options?.clearToken) {
    delete nextTelegram.token;
  }

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      telegram: nextTelegram,
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
}

async function fetchTelegramBotInfo(token: string): Promise<TelegramBotInfo | null> {
  const trimmed = token.trim();
  if (!trimmed) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3_000);
  try {
    const response = await fetch(`https://api.telegram.org/bot${trimmed}/getMe`, {
      method: "GET",
      signal: controller.signal,
    });
    const json = (await response.json().catch(() => null)) as any;
    if (!response.ok || !json?.ok || !json?.result) return null;
    const result = json.result as Record<string, unknown>;
    const id = typeof result.id === "number" ? result.id : null;
    if (id == null) return null;
    const username = typeof result.username === "string" ? result.username : undefined;
    const name = typeof result.first_name === "string" ? result.first_name : undefined;
    return { id, username, name };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function readOpenCodeRouterTelegramInfo(): Promise<{
  configured: boolean;
  enabled: boolean;
  bot: TelegramBotInfo | null;
}> {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const telegram = ensurePlainObject(channels.telegram);

  const channelEnabled = telegram.enabled === undefined ? true : telegram.enabled === true || telegram.enabled === "true";

  const botsRaw = (telegram as any).bots;
  const bots = Array.isArray(botsRaw) ? (botsRaw as unknown[]) : [];
  let token = "";
  let identityEnabled = true;
  for (const entry of bots) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id !== "default") continue;
    token = typeof record.token === "string" ? record.token.trim() : "";
    identityEnabled = record.enabled === undefined ? true : record.enabled === true || record.enabled === "true";
    break;
  }
  if (!token) {
    // Legacy fallback.
    token = typeof telegram.token === "string" ? telegram.token.trim() : "";
  }

  const configured = Boolean(token);
  const bot = configured ? await fetchTelegramBotInfo(token) : null;
  const enabled = configured ? channelEnabled && identityEnabled : false;
  return { configured, enabled, bot };
}

async function persistOpenCodeRouterSlackTokens(botToken: string, appToken: string): Promise<void> {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const slack = ensurePlainObject(channels.slack);

  const appsRaw = (slack as any).apps;
  const apps = Array.isArray(appsRaw) ? (appsRaw as unknown[]) : [];
  const nextApps: Array<Record<string, unknown>> = [];
  let found = false;
  for (const entry of apps) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === "string" ? record.id.trim() : "";
    if (id !== "default") {
      nextApps.push(record);
      continue;
    }
    found = true;
    nextApps.push({ id: "default", botToken, appToken, enabled: true });
  }
  if (!found) nextApps.push({ id: "default", botToken, appToken, enabled: true });

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      slack: {
        ...slack,
        // New format (multi-identity)
        apps: nextApps,
        // Legacy (single-identity)
        botToken,
        appToken,
        enabled: true,
      },
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
}

async function persistOpenCodeRouterSlackIdentity(identity: {
  id: string;
  botToken: string;
  appToken: string;
  enabled: boolean;
  directory?: string;
}): Promise<void> {
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const slack = ensurePlainObject(channels.slack);

  const id = normalizeOpenCodeRouterIdentityId(identity.id);
  const botToken = identity.botToken.trim();
  const appToken = identity.appToken.trim();
  const directory = typeof identity.directory === "string" ? identity.directory.trim() : "";
  if (!botToken || !appToken) {
    throw new ApiError(400, "token_required", "Slack botToken and appToken are required");
  }

  const appsRaw = (slack as any).apps;
  const apps = Array.isArray(appsRaw) ? (appsRaw as unknown[]) : [];
  const nextApps: Array<Record<string, unknown>> = [];
  let found = false;
  for (const entry of apps) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const entryId = normalizeOpenCodeRouterIdentityId(record.id);
    if (entryId !== id) {
      nextApps.push(record);
      continue;
    }
    found = true;
    const prevDir = typeof record.directory === "string" ? record.directory.trim() : "";
    const nextDir = directory || prevDir;
    nextApps.push({ id, botToken, appToken, enabled: identity.enabled, ...(nextDir ? { directory: nextDir } : {}) });
  }
  if (!found) {
    nextApps.push({ id, botToken, appToken, enabled: identity.enabled, ...(directory ? { directory } : {}) });
  }

  const nextSlack: Record<string, unknown> = {
    ...slack,
    enabled: true,
    apps: nextApps,
  };
  if (id === "default") {
    // Legacy fallback.
    nextSlack.botToken = botToken;
    nextSlack.appToken = appToken;
  }

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      slack: nextSlack,
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
}

async function deleteOpenCodeRouterSlackIdentity(idRaw: string): Promise<boolean> {
  const id = normalizeOpenCodeRouterIdentityId(idRaw);
  const configPath = resolveOpenCodeRouterConfigPath();
  const current = await readOpenCodeRouterConfigFile(configPath);
  const channels = ensurePlainObject(current.channels);
  const slack = ensurePlainObject(channels.slack);

  const appsRaw = (slack as any).apps;
  const apps = Array.isArray(appsRaw) ? (appsRaw as unknown[]) : [];
  const nextApps: Array<Record<string, unknown>> = [];
  let deleted = false;
  for (const entry of apps) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    const record = entry as Record<string, unknown>;
    const entryId = normalizeOpenCodeRouterIdentityId(record.id);
    if (entryId === id) {
      deleted = true;
      continue;
    }
    nextApps.push(record);
  }

  const nextSlack: Record<string, unknown> = {
    ...slack,
    apps: nextApps,
  };
  if (id === "default") {
    delete (nextSlack as any).botToken;
    delete (nextSlack as any).appToken;
  }

  const next: OpenCodeRouterConfigFile = {
    ...current,
    channels: {
      ...channels,
      slack: nextSlack,
    },
  };
  await writeOpenCodeRouterConfigFile(configPath, next);
  return deleted;
}

type OpenCodeRouterApplyAttempt = {
  applied: boolean;
  port: number;
  hosts: string[];
  host?: string;
  status?: number;
  error?: string;
  body?: unknown;
};

async function tryPostOpenCodeRouterHealth(
  pathname: string,
  payload: unknown,
  options: { port: number; requestHost?: string | null; timeoutMs: number },
): Promise<OpenCodeRouterApplyAttempt> {
  const candidates = Array.from(
    new Set(
      ["127.0.0.1", options.requestHost].filter(
        (host): host is string => Boolean(host && host.trim()),
      ),
    ),
  );
  const port = options.port;

  let lastError: OpenCodeRouterApplyAttempt | null = null;
  for (const host of candidates) {
    const url = `http://${host}:${port}${pathname}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await response.text();
      const parsed = parseJsonResponse(text);

      if (response.ok) {
        return {
          applied: true,
          port,
          hosts: candidates,
          host,
          status: response.status,
          body: parsed,
        };
      }

      const detail =
        typeof parsed === "object" && parsed && "error" in parsed
          ? String((parsed as Record<string, unknown>).error)
          : response.statusText || "OpenCodeRouter request failed";
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        status: response.status,
        error: detail,
        body: parsed,
      };
    } catch (error) {
      clearTimeout(timer);
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `Timeout after ${options.timeoutMs}ms`
          : String(error);
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        error: message,
      };
    }
  }

  return (
    lastError ?? {
      applied: false,
      port,
      hosts: candidates,
      error: "OpenCodeRouter health server is unavailable",
    }
  );
}

async function tryFetchOpenCodeRouterHealth(
  method: "GET" | "DELETE",
  pathname: string,
  options: { port: number; requestHost?: string | null; timeoutMs: number },
): Promise<OpenCodeRouterApplyAttempt> {
  const candidates = Array.from(
    new Set(
      ["127.0.0.1", options.requestHost].filter(
        (host): host is string => Boolean(host && host.trim()),
      ),
    ),
  );
  const port = options.port;

  let lastError: OpenCodeRouterApplyAttempt | null = null;
  for (const host of candidates) {
    const url = `http://${host}:${port}${pathname}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.timeoutMs);
    try {
      const response = await fetch(url, {
        method,
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
      });
      clearTimeout(timer);

      const text = await response.text();
      const parsed = parseJsonResponse(text);

      if (response.ok) {
        return {
          applied: true,
          port,
          hosts: candidates,
          host,
          status: response.status,
          body: parsed,
        };
      }

      const detail =
        typeof parsed === "object" && parsed && "error" in parsed
          ? String((parsed as Record<string, unknown>).error)
          : response.statusText || "OpenCodeRouter request failed";
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        status: response.status,
        error: detail,
        body: parsed,
      };
    } catch (error) {
      clearTimeout(timer);
      const message =
        error instanceof Error && error.name === "AbortError"
          ? `Timeout after ${options.timeoutMs}ms`
          : String(error);
      lastError = {
        applied: false,
        port,
        hosts: candidates,
        host,
        error: message,
      };
    }
  }

  return (
    lastError ?? {
      applied: false,
      port,
      hosts: candidates,
      error: "OpenCodeRouter health server is unavailable",
    }
  );
}

async function updateOpenCodeRouterTelegramToken(
  token: string,
  healthPortOverride?: number | null,
  requestHost?: string | null,
): Promise<Record<string, unknown>> {
  // Always persist first so the token is saved even if opencodeRouter is offline.
  await persistOpenCodeRouterTelegramToken(token);

  const port = healthPortOverride ?? resolveOpenCodeRouterHealthPort();
  const apply = await tryPostOpenCodeRouterHealth(
    "/config/telegram-token",
    { token },
    { port, requestHost, timeoutMs: 3_000 },
  );

  const response: Record<string, unknown> = {
    ok: true,
    persisted: true,
    applied: apply.applied,
    telegram: { configured: true, enabled: true },
  };

  const bot = await fetchTelegramBotInfo(token);
  if (bot) {
    (response.telegram as Record<string, unknown>).bot = bot;
  }

  // Prefer opencodeRouter's response payload when available.
  if (apply.body && typeof apply.body === "object") {
    const record = apply.body as Record<string, unknown>;
    if (record.telegram && typeof record.telegram === "object") {
      response.telegram = record.telegram;
    }
  }

  // If opencodeRouter reports apply status, reflect it at the top-level.
  let telegramStarting = false;
  if (response.telegram && typeof response.telegram === "object") {
    const telegram = response.telegram as Record<string, unknown>;
    if (typeof telegram.applied === "boolean") {
      response.applied = telegram.applied;
    }
    if (typeof telegram.starting === "boolean") {
      telegramStarting = telegram.starting;
    }
    if (!response.applyError && typeof telegram.error === "string" && telegram.error.trim()) {
      response.applyError = telegram.error;
    }
  }

  if (!apply.applied) {
    response.applyError = (typeof response.applyError === "string" && response.applyError.trim())
      ? response.applyError
      : apply.error ?? "OpenCodeRouter did not apply the update";
    if (typeof apply.status === "number") response.applyStatus = apply.status;
  } else if (response.applied === false && !telegramStarting && !response.applyError) {
    response.applyError = "OpenCodeRouter did not apply the update";
  }

  return response;
}

async function updateOpenCodeRouterSlackTokens(
  botToken: string,
  appToken: string,
  healthPortOverride?: number | null,
  requestHost?: string | null,
): Promise<Record<string, unknown>> {
  await persistOpenCodeRouterSlackTokens(botToken, appToken);

  const port = healthPortOverride ?? resolveOpenCodeRouterHealthPort();
  const apply = await tryPostOpenCodeRouterHealth(
    "/config/slack-tokens",
    { botToken, appToken },
    { port, requestHost, timeoutMs: 3_000 },
  );

  const response: Record<string, unknown> = {
    ok: true,
    persisted: true,
    applied: apply.applied,
    slack: { configured: true, enabled: true },
  };

  if (apply.body && typeof apply.body === "object") {
    const record = apply.body as Record<string, unknown>;
    if (record.slack && typeof record.slack === "object") {
      response.slack = record.slack;
    }
  }

  let slackStarting = false;
  if (response.slack && typeof response.slack === "object") {
    const slack = response.slack as Record<string, unknown>;
    if (typeof slack.applied === "boolean") {
      response.applied = slack.applied;
    }
    if (typeof slack.starting === "boolean") {
      slackStarting = slack.starting;
    }
    if (!response.applyError && typeof slack.error === "string" && slack.error.trim()) {
      response.applyError = slack.error;
    }
  }

  if (!apply.applied) {
    response.applyError = (typeof response.applyError === "string" && response.applyError.trim())
      ? response.applyError
      : apply.error ?? "OpenCodeRouter did not apply the update";
    if (typeof apply.status === "number") response.applyStatus = apply.status;
  } else if (response.applied === false && !slackStarting && !response.applyError) {
    response.applyError = "OpenCodeRouter did not apply the update";
  }

  return response;
}

function resolveSoulMemoryPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "soul.md");
}

function resolveSoulHeartbeatPath(workspaceRoot: string): string {
  return join(workspaceRoot, ".opencode", "soul", "heartbeat.jsonl");
}

function normalizeSoulTimestamp(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return null;
    const parsed = Date.parse(trimmed);
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : trimmed;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  return null;
}

function toSoulStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed ? [trimmed] : [];
  }
  return [];
}

function parseSoulHeartbeatLine(rawLine: string, lineIndex: number): SoulHeartbeatEntry | null {
  const trimmed = rawLine.trim();
  if (!trimmed) return null;
  let parsed: Record<string, unknown>;
  try {
    const value = JSON.parse(trimmed);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    parsed = value as Record<string, unknown>;
  } catch {
    return null;
  }

  const ts = normalizeSoulTimestamp(parsed.ts);
  const workspace = typeof parsed.workspace === "string" && parsed.workspace.trim()
    ? parsed.workspace.trim()
    : null;
  const looseEnds = toSoulStringArray(parsed.loose_ends ?? parsed.looseEnds);
  const nextActionRaw = parsed.next_action ?? parsed.nextAction;
  const nextAction = typeof nextActionRaw === "string" && nextActionRaw.trim() ? nextActionRaw.trim() : null;
  const summaryRaw = typeof parsed.summary === "string" ? parsed.summary.trim() : "";
  const summary =
    summaryRaw ||
    nextAction ||
    (looseEnds.length ? `Loose ends: ${looseEnds.slice(0, 2).join("; ")}` : "(no summary)");

  return {
    id: `${ts ?? "unknown"}-${lineIndex}`,
    ts,
    workspace,
    summary,
    looseEnds,
    nextAction,
  };
}

function parseSoulHeartbeatEntries(content: string): SoulHeartbeatEntry[] {
  const lines = content.split(/\r?\n/);
  const items: SoulHeartbeatEntry[] = [];
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const item = parseSoulHeartbeatLine(lines[i] ?? "", i + 1);
    if (item) items.push(item);
  }
  return items;
}

function configIncludesSoulInstruction(config: Record<string, unknown>): boolean {
  const target = ".opencode/soul.md";
  const instructions = config.instructions;
  if (typeof instructions === "string") {
    return instructions.includes(target);
  }
  if (Array.isArray(instructions)) {
    return instructions.some((entry) => typeof entry === "string" && entry.includes(target));
  }
  return false;
}

function estimateCronIntervalMs(schedule: string): number | null {
  const parts = schedule.trim().split(/\s+/);
  if (parts.length < 5) return null;
  const [minute, hour, dom, mon, dow] = parts;
  if (!minute || !hour || !dom || !mon || !dow) return null;

  if (minute === "*" && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    return 60_000;
  }

  const minuteEvery = /^\*\/(\d+)$/.exec(minute);
  if (minuteEvery && hour === "*" && dom === "*" && mon === "*" && dow === "*") {
    const interval = Number(minuteEvery[1]);
    if (Number.isFinite(interval) && interval > 0) {
      return interval * 60_000;
    }
  }

  const hourEvery = /^\*\/(\d+)$/.exec(hour);
  if (hourEvery && /^\d+$/.test(minute) && dom === "*" && mon === "*" && dow === "*") {
    const interval = Number(hourEvery[1]);
    if (Number.isFinite(interval) && interval > 0) {
      return interval * 60 * 60_000;
    }
  }

  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow === "*") {
    return 24 * 60 * 60_000;
  }

  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === "*" && mon === "*" && dow !== "*") {
    return 24 * 60 * 60_000;
  }

  return null;
}

async function listSoulHeartbeats(
  workspaceRoot: string,
  limit: number,
): Promise<{ items: SoulHeartbeatEntry[]; total: number; path: string }> {
  const heartbeatPath = resolveSoulHeartbeatPath(workspaceRoot);
  const relativePath = ".opencode/soul/heartbeat.jsonl";
  if (!(await exists(heartbeatPath))) {
    return { items: [], total: 0, path: relativePath };
  }

  const content = await readFile(heartbeatPath, "utf8");
  const all = parseSoulHeartbeatEntries(content);
  return { items: all.slice(0, Math.max(1, limit)), total: all.length, path: relativePath };
}

async function getSoulStatus(workspaceRoot: string): Promise<SoulStatus> {
  const [opencodeConfig, memoryEnabled, heartbeatLogExists] = await Promise.all([
    readOpencodeConfig(workspaceRoot),
    exists(resolveSoulMemoryPath(workspaceRoot)),
    exists(resolveSoulHeartbeatPath(workspaceRoot)),
  ]);

  let heartbeatCommandExists = false;
  try {
    const commands = await listCommands(workspaceRoot, "workspace");
    heartbeatCommandExists = commands.some((command) => command.name === "soul-heartbeat");
  } catch {
    heartbeatCommandExists = false;
  }

  let heartbeatJob: {
    name: string;
    slug: string;
    schedule: string;
    lastRunAt: string | null;
    lastRunStatus: string | null;
    lastRunError: string | null;
  } | null = null;

  try {
    const jobs = await listScheduledJobs(workspaceRoot);
    const found = jobs.find((job) => {
      if (job.name === "soul-heartbeat") return true;
      if (job.slug === "soul-heartbeat") return true;
      return job.slug.includes("soul-heartbeat");
    });
    if (found) {
      heartbeatJob = {
        name: found.name,
        slug: found.slug,
        schedule: found.schedule,
        lastRunAt: found.lastRunAt ?? null,
        lastRunStatus: found.lastRunStatus ?? null,
        lastRunError: found.lastRunError ?? null,
      };
    }
  } catch {
    heartbeatJob = null;
  }

  const instructionsEnabled = configIncludesSoulInstruction(opencodeConfig);
  const heartbeats = await listSoulHeartbeats(workspaceRoot, 500);
  const lastHeartbeat = heartbeats.items[0] ?? null;
  const lastHeartbeatAt = lastHeartbeat?.ts ?? null;
  const lastHeartbeatSummary = lastHeartbeat?.summary ?? null;

  const enabled =
    memoryEnabled ||
    instructionsEnabled ||
    heartbeatLogExists ||
    heartbeatCommandExists ||
    Boolean(heartbeatJob);

  const estimatedIntervalMs = heartbeatJob ? estimateCronIntervalMs(heartbeatJob.schedule) : null;
  const staleAfterMs = enabled
    ? Math.max(estimatedIntervalMs ? estimatedIntervalMs * 2 : 24 * 60 * 60_000, 30 * 60_000)
    : null;

  const parsedLastHeartbeat = lastHeartbeatAt ? Date.parse(lastHeartbeatAt) : NaN;
  const hasLastHeartbeat = Number.isFinite(parsedLastHeartbeat);
  const overdue = Boolean(
    enabled &&
    staleAfterMs != null &&
    (heartbeatJob || lastHeartbeatAt) &&
    (!hasLastHeartbeat || Date.now() - parsedLastHeartbeat > staleAfterMs),
  );

  let state: SoulStatus["state"] = "off";
  if (!enabled) {
    state = "off";
  } else if ((heartbeatJob?.lastRunStatus ?? "") === "failed" || Boolean(heartbeatJob?.lastRunError?.trim())) {
    state = "error";
  } else if (overdue) {
    state = "stale";
  } else {
    state = "healthy";
  }

  const summary = !enabled
    ? "Soul mode is not enabled for this worker yet."
    : state === "error"
      ? "Soul heartbeat ran into an error."
      : state === "stale"
        ? "Soul heartbeat is overdue."
        : heartbeatJob
          ? "Soul mode is active and heartbeat is on schedule."
          : "Soul mode is active. Heartbeat schedule not found.";

  return {
    enabled,
    state,
    memoryEnabled,
    instructionsEnabled,
    heartbeatLogExists,
    heartbeatCommandExists,
    heartbeatJob,
    heartbeatCount: heartbeats.total,
    lastHeartbeatAt,
    lastHeartbeatSummary,
    staleAfterMs,
    overdue,
    summary,
    memoryPath: ".opencode/soul.md",
    heartbeatPath: ".opencode/soul/heartbeat.jsonl",
  };
}

async function readOpencodeConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const { data } = await readJsoncFile(opencodeConfigPath(workspaceRoot), {} as Record<string, unknown>);
  return data;
}

async function readVesloConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  const path = vesloConfigPath(workspaceRoot);
  if (!(await exists(path))) return {};
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new ApiError(422, "invalid_json", "Failed to parse veslo.json");
  }
}

function resolveOpencodeDirectory(workspace: WorkspaceInfo): string | null {
  const explicit = workspace.directory?.trim() ?? "";
  if (explicit) return normalizeOpencodeDirectory(explicit);
  if (workspace.workspaceType === "local") return normalizeOpencodeDirectory(workspace.path);
  return null;
}

async function resolveConversationReadDirectory(
  workspace: WorkspaceInfo,
  requestedRaw: string | null,
): Promise<string | null> {
  const fallback = resolveOpencodeDirectory(workspace);
  const requested = normalizeConversationReadDirectoryRequest(workspace, requestedRaw, fallback);
  if (!requested) return fallback;

  if (!isAbsolute(requested)) {
    throw new ApiError(400, "invalid_directory", "Conversation directory must be absolute");
  }

  const directory = normalizeOpencodeDirectory(resolve(requested));
  const allowedRoots = [
    workspace.path,
    fallback,
  ].filter((value): value is string => Boolean(value?.trim()));
  const authorized = await isAuthorizedRoot(directory, allowedRoots);
  if (!authorized) {
    throw new ApiError(403, "directory_unauthorized", "Conversation directory is outside this workspace");
  }
  return directory;
}

function normalizeConversationReadDirectoryRequest(
  workspace: WorkspaceInfo,
  requestedRaw: string | null,
  fallback: string | null,
): string {
  const requested = requestedRaw?.trim() ?? "";
  if (!requested) return "";

  const workspaceRoot = fallback?.trim() || workspace.directory?.trim() || workspace.path?.trim() || "";
  const slashRequested = requested.replace(/\\/g, "/");
  if (slashRequested === "/workspace" || slashRequested === "workspace") {
    return workspaceRoot;
  }
  if (slashRequested.startsWith("/workspace/") || slashRequested.startsWith("workspace/")) {
    const relativePath = slashRequested.replace(/^\/?workspace\/+/, "");
    return workspaceRoot ? join(workspaceRoot, relativePath) : requested;
  }

  if (process.platform === "win32") {
    const wslMount = slashRequested.match(/^\/mnt\/([A-Za-z])(?:\/(.*))?$/);
    if (wslMount) {
      const drive = wslMount[1]?.toUpperCase();
      const rest = wslMount[2]?.trim() ?? "";
      return drive ? (rest ? `${drive}:/${rest}` : `${drive}:/`) : requested;
    }
  }

  return requested;
}

export function normalizeOpencodeDirectory(directory: string): string {
  // OpenCode stores/list-filters Windows sessions by regular drive paths
  // (`C:\Users\...`). Tauri can persist local workspaces as extended-length
  // paths (`\\?\C:\Users\...`); passing those through as the directory query
  // makes OpenCode return an empty session list even though the sessions exist.
  if (process.platform === "win32") {
    return directory.replace(/^\\\\\?\\/, "").replace(/^\/\/\?\//, "");
  }
  return directory;
}

function buildOpencodeReloadUrl(baseUrl: string, directory?: string | null): string {
  try {
    const url = new URL(baseUrl);
    url.pathname = "/instance/dispose";
    url.search = "";
    if (directory) {
      url.searchParams.set("directory", directory);
    }
    return url.toString();
  } catch {
    throw new ApiError(400, "opencode_url_invalid", "OpenCode base URL is invalid");
  }
}

function buildOpencodeAuthHeader(workspace: WorkspaceInfo): string | null {
  const username = workspace.opencodeUsername?.trim() ?? "";
  const password = workspace.opencodePassword?.trim() ?? "";
  if (!username || !password) return null;
  return `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`;
}

function parseOpencodeErrorBody(input: string): unknown {
  const trimmed = input.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed;
  }
}

async function reloadOpencodeEngine(workspace: WorkspaceInfo): Promise<void> {
  const baseUrl = workspace.baseUrl?.trim() ?? "";
  if (!baseUrl) {
    throw new ApiError(400, "opencode_unconfigured", "OpenCode base URL is missing for this workspace");
  }

  const directory = resolveOpencodeDirectory(workspace);
  const targetUrl = buildOpencodeReloadUrl(baseUrl, directory);
  const headers: Record<string, string> = {};
  const auth = buildOpencodeAuthHeader(workspace);
  if (auth) headers.Authorization = auth;

  const timeoutMs = resolveOpenCodeJsonFetchTimeoutMs();
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  if (typeof timeout === "object" && timeout && "unref" in timeout) {
    (timeout as { unref?: () => void }).unref?.();
  }

  try {
    const response = await fetch(targetUrl, { method: "POST", headers, signal: controller.signal });
    if (response.ok) return;
    const body = parseOpencodeErrorBody(await readResponseTextWithLimit(response, OPENCODE_JSON_DEFAULT_RESPONSE_MAX_BYTES));
    throw new ApiError(502, "opencode_reload_failed", "OpenCode reload failed", {
      status: response.status,
      body,
    });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (timedOut || isAbortError(error)) {
      throw new ApiError(502, "opencode_request_timeout", "OpenCode request timed out", {
        path: "/instance/dispose",
        timeoutMs,
      });
    }
    throw new ApiError(502, "opencode_reload_failed", "OpenCode reload failed", {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function writeVesloConfig(workspaceRoot: string, payload: Record<string, unknown>, merge: boolean): Promise<void> {
  const path = vesloConfigPath(workspaceRoot);
  const next = merge ? { ...(await readVesloConfig(workspaceRoot)), ...payload } : payload;
  await ensureDir(join(workspaceRoot, ".opencode"));
  await writeFile(path, JSON.stringify(next, null, 2) + "\n", "utf8");
}

async function requireApproval(
  ctx: RequestContext,
  input: Omit<ApprovalRequest, "id" | "createdAt" | "actor">,
): Promise<void> {
  const actor = ctx.actor ?? { type: "remote" };
  const result = await ctx.approvals.requestApproval({ ...input, actor });
  if (!result.allowed) {
    throw new ApiError(403, "write_denied", "Write request denied", {
      requestId: result.id,
      reason: result.reason,
    });
  }
}

async function exportWorkspace(workspace: WorkspaceInfo) {
  const opencode = redactSensitiveConfig(await readOpencodeConfig(workspace.path));
  const veslo = redactSensitiveConfig(await readVesloConfig(workspace.path));
  const skills = await listSkills(workspace.path, false);
  const commands = await listCommands(workspace.path, "workspace");
  const skillContents = await Promise.all(
    skills.map(async (skill) => ({
      name: skill.name,
      description: skill.description,
      content: await readFile(skill.path, "utf8"),
    })),
  );
  const commandContents = await Promise.all(
    commands.map(async (command) => ({
      name: command.name,
      description: command.description,
      template: command.template,
    })),
  );

  return {
    workspaceId: workspace.id,
    exportedAt: Date.now(),
    opencode,
    veslo,
    skills: skillContents,
    commands: commandContents,
  };
}

async function importWorkspace(workspace: WorkspaceInfo, payload: Record<string, unknown>): Promise<void> {
  const modes = (payload.mode as Record<string, string> | undefined) ?? {};
  const opencode = payload.opencode as Record<string, unknown> | undefined;
  const veslo = payload.veslo as Record<string, unknown> | undefined;
  const skills = (payload.skills as { name: string; content: string; description?: string }[] | undefined) ?? [];
  const commands = (payload.commands as { name: string; content?: string; description?: string; template?: string; agent?: string; model?: string | null; subtask?: boolean }[] | undefined) ?? [];

  if (opencode) {
    if (modes.opencode === "replace") {
      await writeJsoncFile(opencodeConfigPath(workspace.path), opencode);
    } else {
      await updateJsoncTopLevel(opencodeConfigPath(workspace.path), opencode);
    }
  }

  if (veslo) {
    if (modes.veslo === "replace") {
      await writeVesloConfig(workspace.path, veslo, false);
    } else {
      await writeVesloConfig(workspace.path, veslo, true);
    }
  }

  if (skills.length > 0) {
    if (modes.skills === "replace") {
      await rm(projectSkillsDir(workspace.path), { recursive: true, force: true });
    }
    for (const skill of skills) {
      await upsertSkill(workspace.path, skill);
    }
  }

  if (commands.length > 0) {
    if (modes.commands === "replace") {
      await rm(projectCommandsDir(workspace.path), { recursive: true, force: true });
    }
    for (const command of commands) {
      if (command.content) {
        const parsed = parseFrontmatter(command.content);
        const name = command.name || (typeof parsed.data.name === "string" ? parsed.data.name : "");
        const description = command.description || (typeof parsed.data.description === "string" ? parsed.data.description : undefined);
        if (!name) {
          throw new ApiError(400, "invalid_command", "Command name is required");
        }
        const template = parsed.body.trim();
        await upsertCommand(workspace.path, {
          name,
          description,
          template,
          agent: typeof parsed.data.agent === "string" ? parsed.data.agent : undefined,
          model: typeof parsed.data.model === "string" ? parsed.data.model : undefined,
          subtask: typeof parsed.data.subtask === "boolean" ? parsed.data.subtask : undefined,
        });
      } else {
        const name = command.name ?? "";
        const template = command.template ?? "";
        await upsertCommand(workspace.path, {
          name,
          description: command.description,
          template,
          agent: command.agent,
          model: command.model,
          subtask: command.subtask,
        });
      }
    }
  }
}
