import { mkdir, readFile, writeFile, rm, rename } from "node:fs/promises";
import { appendFileSync, mkdirSync } from "node:fs";
import { createHash, randomInt, randomUUID } from "node:crypto";
import { homedir, hostname } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type {
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
import { fetchOrgSkillsCatalog } from "./den-catalog.js";
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
  readSoulMaterializationManifest,
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
import { listScheduledJobs } from "./scheduler.js";
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
import { TokenService } from "./tokens.js";
import { TOY_UI_CSS, TOY_UI_HTML, TOY_UI_JS, cssResponse, htmlResponse, jsResponse } from "./toy-ui.js";
import { registerAiGatewayRoutes } from "./routes/ai-gateway.js";
import { registerAutomationRoutes } from "./routes/automations.js";
import { registerCommandRoutes } from "./routes/commands.js";
import {
  registerConversationSessionRoutes,
  type ConversationExecutionTarget,
  type ConversationRunTracer,
} from "./routes/conversations.js";
import {
  registerFileSessionRoutes,
  resolveInboxEnabled,
  resolveInboxMaxBytes,
  resolveOutboxEnabled,
} from "./routes/file-sessions.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerOpenCodeRouterRoutes } from "./routes/opencode-router.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerSchedulerRoutes } from "./routes/scheduler.js";
import { registerSessionArchiveRoutes } from "./routes/session-archives.js";
import { registerSkillEnabledRoutes } from "./routes/skill-enabled.js";
import { registerSkillRegistryRoutes } from "./routes/skill-registry.js";
import { registerSkillRemovalRoutes } from "./routes/skill-removals.js";
import { registerUserGlobalSkillRoutes } from "./routes/user-global-skills.js";
import { addRoute, matchRoute, type AuthMode, type RequestContext, type Route } from "./routing.js";
import {
  buildOrchestratorWorkspaceOpencodeBaseUrl,
  contentLengthFor,
  emitReloadEvent,
  ensureWritable,
  isAuthorizedRoot,
  isAuthorizedRootSync,
  jsonResponse,
  normalizeOpencodeDirectory,
  readJsonBody,
  readOptionalJsonBody,
  readTextPreview,
  requireApproval,
  requireClientScope,
  requireSoulApproval,
  resolveWorkspace,
  resolveWorkspaceOpencodeBaseUrl,
  scopeRank,
} from "./route-helpers.js";
import { FileSessionStore } from "./file-sessions.js";
import { createSessionArchiveStore } from "./session-archives.js";
import { createSessionTranscriptPrefetchStore } from "./session-transcript-prefetch.js";
import {
  type AutomationExecutionInput,
  type AutomationExecutionResult,
  type AutomationRunner,
  createAutomationRunner,
} from "./automation-runner.js";
import type { AutomationTarget } from "./automations.js";
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

export { normalizeOpencodeDirectory } from "./route-helpers.js";
export { normalizeWorkspaceRelativePath } from "./routes/file-sessions.js";

const SERVER_VERSION = pkg.version;

const SKILL_BATCH_REMOVE_MAX_ITEMS = 50;
const AI_GATEWAY_DEFAULT_PORT = 4034;
const AI_GATEWAY_UPSTREAM_RESPONSE_SNIPPET_MAX = 1000;
const OPENCODE_JSON_DEFAULT_RESPONSE_MAX_BYTES = 1024 * 1024;
const OPENCODE_TRANSCRIPT_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const OPENCODE_JSON_FETCH_DEFAULT_TIMEOUT_MS = 5_000;
const OPENCODE_SESSION_CREATE_TIMEOUT_MS = 60_000;
const OPENCODE_CONVERSATION_SUBMIT_TIMEOUT_MS = 30_000;
// Send-timeout fix 2026-06-10 - upper bound for the proxy's wait on upstream
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
const OPENCODE_SESSION_ID_TEMPLATE = "${OPENCODE_SESSION_ID}";
const OPENCODE_SESSION_ID_MARKER = "OPENCODE_SESSION_ID";
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

  // VSLO-250 - optional second listener on a WSL-reachable bridge address
  // (e.g. the WSL virtual adapter IP). It shares the exact same fetch handler,
  // so token auth, CORS, proxying and streaming behave identically to the
  // primary listener. A bind failure here must not take down the primary
  // loopback listener; managed AI routing fails closed upstream instead.
  const bridgeHost = config.bridgeHost?.trim();
  let bridgeServer: StoppableServer | null = null;
  if (bridgeHost && bridgeHost !== config.host) {
    try {
      bridgeServer = Bun.serve({ ...serverOptions, hostname: bridgeHost }) as StoppableServer;
      logger.log("info", "veslo-server bridge listener started", {
        bridgeHost,
        port: config.port,
      });
    } catch (error) {
      bridgeServer = null;
      logger.log("error", "veslo-server bridge listener failed to start", {
        bridgeHost,
        port: config.port,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const originalStop = server.stop.bind(server);
  const stopBridge = bridgeServer ? bridgeServer.stop.bind(bridgeServer) : null;
  server.stop = (closeActiveConnections?: boolean) => {
    automationRunner.stop();
    if (stopBridge) {
      try {
        stopBridge(closeActiveConnections);
      } catch {
        // best effort: a failed bridge stop must not block primary shutdown
      }
    }
    return originalStop(closeActiveConnections);
  };

  return server;
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
  // Bound the wait for upstream response headers only - the timer is cleared
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
  if (containsUnresolvedOpenCodeSessionId(normalized)) return "";
  return normalized;
}

function containsUnresolvedOpenCodeSessionId(value?: string | null): boolean {
  return (value?.trim() ?? "").includes(OPENCODE_SESSION_ID_MARKER);
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

type AiGatewaySessionResolutionSource =
  | "veslo-session-header"
  | "opencode-session-header"
  | "workspace-active-run-context"
  | "sessionless-fallback"
  | "unresolved";

type AiGatewaySessionResolution = {
  sessionId: string;
  activeRunContext: ActiveAiGatewayRunContext | null;
  workspaceId: string | null;
  source: AiGatewaySessionResolutionSource;
  workspaceFallbackSuppressedReason?: string;
  workspaceFallbackCandidateCount?: number;
  activeContextCount?: number;
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

type AiGatewayRuntimeAuthorizationEntry = {
  authorization: string;
  at: number;
  source: "ai-access-token" | "caller-authorization";
};

const aiGatewaySessionHits = new Map<string, AiGatewaySessionHit[]>();
const aiGatewayWorkspaceHits = new Map<string, AiGatewaySessionHit[]>();
const activeAiGatewayRunsBySession = new Map<string, ActiveAiGatewayRunContext[]>();
const activeAiGatewayRunsByWorkspace = new Map<string, ActiveAiGatewayRunContext[]>();
const activeAiGatewayProxyRequests = new Map<string, ActiveAiGatewayProxyRequest>();
const aiGatewayRuntimeAuthorizationByActorToken = new Map<string, AiGatewayRuntimeAuthorizationEntry>();

function roundAiGatewayDiagnosticMs(value: number): number {
  return Math.round(value * 100) / 100;
}

function summarizeActiveAiGatewayRunContext(
  context: ActiveAiGatewayRunContext,
  now: number,
): Record<string, unknown> {
  const ageMs = Math.max(0, now - context.at);
  return {
    ageMs: roundAiGatewayDiagnosticMs(ageMs),
    expiresInMs: roundAiGatewayDiagnosticMs(Math.max(0, AI_GATEWAY_ACTIVE_RUN_TTL_MS - ageMs)),
    traceId: context.traceId,
    workspaceId: context.workspaceId,
    conversationId: context.conversationId,
    runId: context.runId,
    opencodeSessionId: context.opencodeSessionId,
    clientMessageId: context.clientMessageId,
    origin: context.origin,
  };
}

function summarizeActiveAiGatewayRunContexts(
  contexts: ActiveAiGatewayRunContext[],
  now: number,
  limit = 5,
): Array<Record<string, unknown>> {
  return contexts
    .slice()
    .sort((left, right) => right.at - left.at)
    .slice(0, limit)
    .map((context) => summarizeActiveAiGatewayRunContext(context, now));
}

function summarizeActiveAiGatewayContextKeys(
  itemsByKey: Map<string, ActiveAiGatewayRunContext[]>,
  limit = 20,
): string[] {
  return Array.from(itemsByKey.keys()).sort((left, right) => left.localeCompare(right)).slice(0, limit);
}

function summarizeRecentActiveAiGatewayContexts(now: number, limit = 8): Array<Record<string, unknown>> {
  const seen = new Set<string>();
  const contexts: ActiveAiGatewayRunContext[] = [];
  for (const items of activeAiGatewayRunsByWorkspace.values()) {
    for (const item of items) {
      const key = [
        item.workspaceId,
        item.conversationId,
        item.runId,
        item.opencodeSessionId,
        item.at,
      ].join("\0");
      if (seen.has(key)) continue;
      seen.add(key);
      contexts.push(item);
    }
  }
  return summarizeActiveAiGatewayRunContexts(contexts, now, limit);
}

function buildActiveAiGatewayResolutionDiagnostics(input: {
  incomingSessionId?: string | null;
  workspaceId?: string | null;
}): Record<string, unknown> {
  const now = Date.now();
  pruneActiveAiGatewayRuns(now);
  const normalizedIncomingSessionId = normalizeAiGatewaySessionId(input.incomingSessionId);
  const workspaceId = input.workspaceId?.trim() ?? "";
  const sessionCandidates = normalizedIncomingSessionId
    ? activeAiGatewayRunsBySession.get(normalizedIncomingSessionId) ?? []
    : [];
  const workspaceCandidates = workspaceId
    ? activeAiGatewayRunsByWorkspace.get(workspaceId) ?? []
    : [];
  return {
    normalizedIncomingSessionId: normalizedIncomingSessionId || null,
    workspaceId: workspaceId || null,
    sessionCandidateCount: sessionCandidates.length,
    workspaceCandidateCount: workspaceCandidates.length,
    totalSessionContextKeys: activeAiGatewayRunsBySession.size,
    totalWorkspaceContextKeys: activeAiGatewayRunsByWorkspace.size,
    sessionContextKeys: summarizeActiveAiGatewayContextKeys(activeAiGatewayRunsBySession),
    workspaceContextKeys: summarizeActiveAiGatewayContextKeys(activeAiGatewayRunsByWorkspace),
    sessionCandidates: summarizeActiveAiGatewayRunContexts(sessionCandidates, now),
    workspaceCandidates: summarizeActiveAiGatewayRunContexts(workspaceCandidates, now),
    recentContexts: summarizeRecentActiveAiGatewayContexts(now),
    activeProxyRequestCount: activeAiGatewayProxyRequests.size,
  };
}

function actorRuntimeTokenKey(actor?: Actor): string {
  return actor?.tokenHash?.trim() ?? "";
}

function topLevelRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function readAiAccessBundleAccessToken(value: unknown): string {
  const accessToken = topLevelRecord(value).accessToken;
  return typeof accessToken === "string" && accessToken.trim() !== REDACTED_SECRET_VALUE
    ? accessToken.trim()
    : "";
}

function readAiAccessBundleEnabled(value: unknown): boolean {
  const aiAccess = topLevelRecord(topLevelRecord(value).aiAccess);
  return aiAccess.enabled === true;
}

function registerAiGatewayRuntimeAuthorization(input: {
  actor?: Actor;
  authorization: string;
  source: AiGatewayRuntimeAuthorizationEntry["source"];
}): void {
  const key = actorRuntimeTokenKey(input.actor);
  const authorization = input.authorization.trim();
  if (!key || !authorization) return;
  aiGatewayRuntimeAuthorizationByActorToken.set(key, {
    authorization,
    source: input.source,
    at: Date.now(),
  });
}

function clearAiGatewayRuntimeAuthorization(actor?: Actor): void {
  const key = actorRuntimeTokenKey(actor);
  if (key) aiGatewayRuntimeAuthorizationByActorToken.delete(key);
}

function syncAiGatewayRuntimeAuthorizationFromAccessBundle(input: {
  actor?: Actor;
  value: unknown;
  callerAuthorization: string;
}): void {
  if (!readAiAccessBundleEnabled(input.value)) {
    clearAiGatewayRuntimeAuthorization(input.actor);
    return;
  }

  const accessToken = readAiAccessBundleAccessToken(input.value);
  if (accessToken) {
    registerAiGatewayRuntimeAuthorization({
      actor: input.actor,
      authorization: `Bearer ${accessToken}`,
      source: "ai-access-token",
    });
    return;
  }

  registerAiGatewayRuntimeAuthorization({
    actor: input.actor,
    authorization: input.callerAuthorization,
    source: "caller-authorization",
  });
}

function resolveAiGatewayProviderAuthorization(input: {
  request: Request;
  actor?: Actor;
}): {
  authorization: string;
  source: "legacy-header" | AiGatewayRuntimeAuthorizationEntry["source"];
} {
  const legacyAccessToken = input.request.headers.get(GATEWAY_ACCESS_TOKEN_HEADER)?.trim() ?? "";
  if (legacyAccessToken) {
    return {
      authorization: `Bearer ${legacyAccessToken}`,
      source: "legacy-header",
    };
  }

  const key = actorRuntimeTokenKey(input.actor);
  const runtime = key ? aiGatewayRuntimeAuthorizationByActorToken.get(key) : undefined;
  if (runtime?.authorization.trim()) {
    return {
      authorization: runtime.authorization,
      source: runtime.source,
    };
  }

  throw new ApiError(
    401,
    "gateway_runtime_authorization_required",
    "Managed AI gateway authorization is not available in this Veslo server runtime",
  );
}

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

function activeAiGatewayRunContextKey(context: ActiveAiGatewayRunContext): string {
  return [
    context.workspaceId,
    context.conversationId,
    context.runId,
    context.opencodeSessionId,
    context.at,
  ].join("\0");
}

function listActiveAiGatewayRunContexts(now = Date.now()): ActiveAiGatewayRunContext[] {
  pruneActiveAiGatewayRuns(now);
  const seen = new Set<string>();
  const contexts: ActiveAiGatewayRunContext[] = [];
  for (const items of activeAiGatewayRunsByWorkspace.values()) {
    for (const item of items) {
      const key = activeAiGatewayRunContextKey(item);
      if (seen.has(key)) continue;
      seen.add(key);
      contexts.push(item);
    }
  }
  return contexts;
}

function latestActiveAiGatewayRunContextBySession(sessionId?: string | null): ActiveAiGatewayRunContext | null {
  const normalizedSessionId = normalizeAiGatewaySessionId(sessionId);
  if (!normalizedSessionId) return null;
  const bySession = activeAiGatewayRunsBySession.get(normalizedSessionId) ?? [];
  return bySession[bySession.length - 1] ?? null;
}

function latestActiveAiGatewayRunContextByWorkspace(workspaceId?: string | null): ActiveAiGatewayRunContext | null {
  const normalizedWorkspaceId = workspaceId?.trim() ?? "";
  if (!normalizedWorkspaceId) return null;
  const byWorkspace = activeAiGatewayRunsByWorkspace.get(normalizedWorkspaceId) ?? [];
  return byWorkspace[byWorkspace.length - 1] ?? null;
}

function activeAiGatewayRunMatches(
  context: ActiveAiGatewayRunContext,
  input: Pick<ActiveAiGatewayRunContext, "workspaceId" | "conversationId" | "runId" | "opencodeSessionId">,
): boolean {
  return context.workspaceId === input.workspaceId &&
    context.conversationId === input.conversationId &&
    context.runId === input.runId &&
    context.opencodeSessionId === input.opencodeSessionId;
}

function unregisterActiveAiGatewayRun(
  input: Pick<ActiveAiGatewayRunContext, "workspaceId" | "conversationId" | "runId" | "opencodeSessionId">,
): void {
  const sessionId = normalizeAiGatewaySessionId(input.opencodeSessionId);
  if (sessionId) {
    const next = (activeAiGatewayRunsBySession.get(sessionId) ?? [])
      .filter((context) => !activeAiGatewayRunMatches(context, input));
    if (next.length) {
      activeAiGatewayRunsBySession.set(sessionId, next);
    } else {
      activeAiGatewayRunsBySession.delete(sessionId);
    }
  }

  const workspaceId = input.workspaceId.trim();
  if (workspaceId) {
    const next = (activeAiGatewayRunsByWorkspace.get(workspaceId) ?? [])
      .filter((context) => !activeAiGatewayRunMatches(context, input));
    if (next.length) {
      activeAiGatewayRunsByWorkspace.set(workspaceId, next);
    } else {
      activeAiGatewayRunsByWorkspace.delete(workspaceId);
    }
  }
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
    activeContextDiagnostics: buildActiveAiGatewayResolutionDiagnostics({
      incomingSessionId: input.opencodeSessionId,
      workspaceId: input.workspaceId,
    }),
  });
}

function resolveAiGatewaySession(input: {
  incomingSessionId?: string | null;
  openCodeSessionId?: string | null;
  workspaceId?: string | null;
}): AiGatewaySessionResolution {
  pruneActiveAiGatewayRuns();
  const hasUnresolvedOpenCodeSessionId = containsUnresolvedOpenCodeSessionId(input.incomingSessionId);
  const incomingSessionId = normalizeAiGatewaySessionId(input.incomingSessionId);
  const openCodeSessionId = normalizeAiGatewaySessionId(input.openCodeSessionId);
  const workspaceId = input.workspaceId?.trim() ?? "";

  if (incomingSessionId) {
    const activeRunContext = latestActiveAiGatewayRunContextBySession(incomingSessionId);
    return {
      sessionId: incomingSessionId,
      activeRunContext,
      workspaceId: activeRunContext?.workspaceId ?? null,
      source: "veslo-session-header",
    };
  }

  if (openCodeSessionId) {
    const activeRunContext = latestActiveAiGatewayRunContextBySession(openCodeSessionId);
    return {
      sessionId: openCodeSessionId,
      activeRunContext,
      workspaceId: activeRunContext?.workspaceId ?? null,
      source: "opencode-session-header",
    };
  }

  const workspaceContext = latestActiveAiGatewayRunContextByWorkspace(workspaceId);
  if (workspaceContext) {
    const activeContexts = listActiveAiGatewayRunContexts();
    const workspaceCandidates = workspaceId ? activeAiGatewayRunsByWorkspace.get(workspaceId) ?? [] : [];
    if (activeContexts.length === 1 && workspaceCandidates.length === 1) {
      return {
        sessionId: normalizeAiGatewaySessionId(workspaceContext.opencodeSessionId),
        activeRunContext: workspaceContext,
        workspaceId: workspaceContext.workspaceId,
        source: "workspace-active-run-context",
      };
    }
    return {
      sessionId: "",
      activeRunContext: null,
      workspaceId: workspaceId || null,
      source: hasUnresolvedOpenCodeSessionId ? "sessionless-fallback" : "unresolved",
      workspaceFallbackSuppressedReason: "ambiguous-active-run-context",
      workspaceFallbackCandidateCount: workspaceCandidates.length,
      activeContextCount: activeContexts.length,
    };
  }

  return {
    sessionId: "",
    activeRunContext: null,
    workspaceId: workspaceId || null,
    source: hasUnresolvedOpenCodeSessionId ? "sessionless-fallback" : "unresolved",
  };
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
  actor?: Actor;
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
  const providerAuthorization = input.auth === "gateway-token"
    ? resolveAiGatewayProviderAuthorization({ request: input.request, actor: input.actor })
    : null;
  const authorization = input.auth === "caller"
    ? requireAiGatewayCallerAuth(input.request)
    : providerAuthorization?.authorization ?? "";
  const incomingSessionId = input.requireSessionId ? requireAiGatewaySessionId(input.request) : undefined;
  const incomingOpenCodeSessionId = input.requireSessionId ? trimmedHeader(input.request, "x-session-id") : undefined;
  const incomingWorkspaceId = trimmedHeader(input.request, GATEWAY_WORKSPACE_ID_HEADER);
  const provider = resolveAiGatewayProvider(input.gatewayPath) ?? null;
  const incomingHeaderNames = headerNamesForTrace(input.request.headers);
  const incomingInternalHeaderSummary = {
    hasGatewayAccessToken: Boolean(gatewayAccessToken),
    hasRuntimeGatewayAuthorization: Boolean(providerAuthorization && providerAuthorization.source !== "legacy-header"),
    gatewayAuthorizationSource: providerAuthorization?.source ?? (input.auth === "caller" ? "caller" : "missing"),
    hasGatewayCallerAuth: Boolean(gatewayCallerAuth),
    hasWorkspaceId: Boolean(incomingWorkspaceId),
    hasSendTraceId: Boolean(trimmedHeader(input.request, "x-veslo-send-trace-id")),
    hasSessionId: Boolean(incomingSessionId),
    hasOpenCodeSessionId: Boolean(incomingOpenCodeSessionId),
    hasOpenCodeSessionAffinity: Boolean(trimmedHeader(input.request, "x-session-affinity")),
    hasHostToken: Boolean(trimmedHeader(input.request, "x-veslo-host-token")),
    hasClientId: Boolean(trimmedHeader(input.request, "x-veslo-client-id")),
  };
  const sessionResolution = input.requireSessionId
    ? resolveAiGatewaySession({
        incomingSessionId,
        openCodeSessionId: incomingOpenCodeSessionId,
        workspaceId: incomingWorkspaceId,
      })
    : null;
  const activeRunContext = sessionResolution?.activeRunContext ?? null;
  const sessionId = input.requireSessionId ? sessionResolution?.sessionId ?? "" : undefined;
  const workspaceId = input.requireSessionId
    ? sessionResolution?.workspaceId ?? undefined
    : incomingWorkspaceId ?? undefined;
  const isSessionlessFallback = input.requireSessionId && sessionResolution?.source === "sessionless-fallback";
  const forwardedSessionId = input.requireSessionId
    ? isSessionlessFallback
      ? incomingSessionId?.trim() || OPENCODE_SESSION_ID_TEMPLATE
      : sessionId ?? ""
    : undefined;
  const forwardedSessionHeaderMode = input.requireSessionId
    ? isSessionlessFallback
      ? "incoming-placeholder"
      : "resolved"
    : "not-required";
  if (input.requireSessionId && !sessionId && !isSessionlessFallback) {
    const activeContextDiagnostics = buildActiveAiGatewayResolutionDiagnostics({
      incomingSessionId,
      workspaceId: incomingWorkspaceId,
    });
    const unresolvedTrace = {
      requestId,
      provider,
      gatewayPath: input.gatewayPath,
      incomingSessionId,
      normalizedIncomingSessionId: normalizeAiGatewaySessionId(incomingSessionId) || null,
      incomingOpenCodeSessionId: incomingOpenCodeSessionId ?? null,
      normalizedIncomingOpenCodeSessionId: normalizeAiGatewaySessionId(incomingOpenCodeSessionId) || null,
      workspaceId: workspaceId ?? null,
      incomingWorkspaceId: incomingWorkspaceId ?? null,
      sessionResolutionSource: sessionResolution?.source ?? "unresolved",
      workspaceFallbackSuppressedReason: sessionResolution?.workspaceFallbackSuppressedReason ?? null,
      workspaceFallbackCandidateCount: sessionResolution?.workspaceFallbackCandidateCount ?? null,
      activeContextCount: sessionResolution?.activeContextCount ?? null,
      incomingHeaders: incomingHeaderNames,
      incomingInternalHeaders: incomingInternalHeaderSummary,
      activeContextDiagnostics,
    };
    recordSendWorkflowTrace("server", "server:ai-gateway:session-unresolved", unresolvedTrace);
    try {
      console.warn(`[veslo:ai-gateway] session-unresolved ${JSON.stringify(unresolvedTrace)}`);
    } catch {
      console.warn("[veslo:ai-gateway] session-unresolved");
    }
    throw new ApiError(400, "gateway_session_unresolved", "Gateway session id placeholder could not be resolved", {
      requestId,
      provider,
      incomingSessionId,
      incomingOpenCodeSessionId,
      workspaceId: incomingWorkspaceId,
      sessionResolutionSource: sessionResolution?.source ?? "unresolved",
    });
  }
  if (isSessionlessFallback) {
    const sessionlessTrace = {
      requestId,
      provider,
      gatewayPath: input.gatewayPath,
      incomingSessionId,
      normalizedIncomingSessionId: normalizeAiGatewaySessionId(incomingSessionId) || null,
      incomingOpenCodeSessionId: incomingOpenCodeSessionId ?? null,
      normalizedIncomingOpenCodeSessionId: normalizeAiGatewaySessionId(incomingOpenCodeSessionId) || null,
      workspaceId: workspaceId ?? null,
      incomingWorkspaceId: incomingWorkspaceId ?? null,
      sessionResolutionSource: sessionResolution?.source ?? "sessionless-fallback",
      workspaceFallbackSuppressedReason: sessionResolution?.workspaceFallbackSuppressedReason ?? null,
      workspaceFallbackCandidateCount: sessionResolution?.workspaceFallbackCandidateCount ?? null,
      activeContextCount: sessionResolution?.activeContextCount ?? null,
      forwardedSessionHeaderMode,
      incomingHeaders: incomingHeaderNames,
      incomingInternalHeaders: incomingInternalHeaderSummary,
      activeContextDiagnostics: buildActiveAiGatewayResolutionDiagnostics({
        incomingSessionId,
        workspaceId: incomingWorkspaceId,
      }),
    };
    recordSendWorkflowTrace("server", "server:ai-gateway:sessionless-forward", sessionlessTrace);
    try {
      console.log(`[veslo:ai-gateway] sessionless-forward ${JSON.stringify(sessionlessTrace)}`);
    } catch {
      console.log("[veslo:ai-gateway] sessionless-forward");
    }
  }
  const incomingSessionIdForTrace =
    incomingSessionId && incomingSessionId !== sessionId ? incomingSessionId : undefined;
  const incomingOpenCodeSessionIdForTrace =
    incomingOpenCodeSessionId && incomingOpenCodeSessionId !== sessionId ? incomingOpenCodeSessionId : undefined;
  const sessionResolvedFromActiveRunContext =
    sessionResolution?.source === "workspace-active-run-context";
  const watchdogHitRecorded = !isSessionlessFallback;
  if (watchdogHitRecorded) {
    recordAiGatewaySessionHit({
      sessionId,
      workspaceId,
      requestId,
      provider,
      gatewayPath: input.gatewayPath,
    });
  }
  recordSendWorkflowTrace("server", "server:ai-gateway:provider-hit", {
    traceId: activeRunContext?.traceId ?? null,
    requestId,
    provider,
    gatewayPath: input.gatewayPath,
    sessionId: sessionId ?? null,
    incomingSessionId: incomingSessionIdForTrace,
    incomingOpenCodeSessionId: incomingOpenCodeSessionIdForTrace,
    workspaceId: workspaceId ?? null,
    incomingWorkspaceId: incomingWorkspaceId ?? null,
    conversationId: activeRunContext?.conversationId ?? null,
    runId: activeRunContext?.runId ?? null,
    opencodeSessionId: activeRunContext?.opencodeSessionId ?? null,
    clientMessageId: activeRunContext?.clientMessageId ?? null,
    origin: activeRunContext?.origin ?? null,
    sessionResolutionSource: sessionResolution?.source ?? null,
    workspaceFallbackSuppressedReason: sessionResolution?.workspaceFallbackSuppressedReason ?? null,
    sessionResolvedFromActiveRunContext,
    watchdogHitRecorded,
    forwardedSessionHeaderMode,
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
        provider,
        gatewayPath: input.gatewayPath,
        sessionId: sessionId ?? null,
        workspaceId: workspaceId ?? null,
        incomingWorkspaceId: incomingWorkspaceId ?? null,
        incomingOpenCodeSessionId: incomingOpenCodeSessionIdForTrace,
        sessionResolutionSource: sessionResolution?.source ?? null,
        forwardedSessionHeaderMode,
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
    headers.set(GATEWAY_SESSION_ID_HEADER, forwardedSessionId ?? "");
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
      provider,
      sessionId: sessionId ?? null,
      incomingSessionId: incomingSessionIdForTrace,
      incomingOpenCodeSessionId: incomingOpenCodeSessionIdForTrace,
      workspaceId: workspaceId ?? null,
      incomingWorkspaceId: incomingWorkspaceId ?? null,
      traceId: activeRunContext?.traceId ?? null,
      conversationId: activeRunContext?.conversationId ?? null,
      runId: activeRunContext?.runId ?? null,
      opencodeSessionId: activeRunContext?.opencodeSessionId ?? null,
      clientMessageId: activeRunContext?.clientMessageId ?? null,
      origin: activeRunContext?.origin ?? null,
      targetOrigin: target.origin,
      targetPath: target.pathname,
      sessionResolutionSource: sessionResolution?.source ?? null,
      sessionResolvedFromActiveRunContext,
      watchdogHitRecorded,
      forwardedSessionHeaderMode,
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
      provider,
      sessionId: sessionId ?? null,
      incomingSessionId: incomingSessionIdForTrace,
      incomingOpenCodeSessionId: incomingOpenCodeSessionIdForTrace,
      workspaceId: workspaceId ?? null,
      incomingWorkspaceId: incomingWorkspaceId ?? null,
      traceId: activeRunContext?.traceId ?? null,
      conversationId: activeRunContext?.conversationId ?? null,
      runId: activeRunContext?.runId ?? null,
      opencodeSessionId: activeRunContext?.opencodeSessionId ?? null,
      clientMessageId: activeRunContext?.clientMessageId ?? null,
      origin: activeRunContext?.origin ?? null,
      sessionResolutionSource: sessionResolution?.source ?? null,
      watchdogHitRecorded,
      forwardedSessionHeaderMode,
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
    provider,
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
        provider,
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
        provider,
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
      provider,
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
  if (input.auth === "caller" && input.preserveAiAccessToken) {
    syncAiGatewayRuntimeAuthorizationFromAccessBundle({
      actor: input.actor,
      value: json,
      callerAuthorization: gatewayCallerAuth,
    });
  }
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

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
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
  workspaceRoot?: string,
): Promise<SoulDocument | null> {
  const cached = ownerId ? await readCachedSoulDocument({ dataDir, scope, ownerId }) : null;
  if (cached) return cached;
  const existing = workspaceRoot
    ? await readMaterializedSoulDocumentForScope(workspaceRoot, scope)
    : null;
  if (!existing) return null;
  if (ownerId && existing.ownerId !== ownerId) return null;
  return existing;
}

async function readMaterializedSoulDocumentForScope(
  workspaceRoot: string,
  scope: SoulScope,
): Promise<SoulDocument | null> {
  let manifest: Awaited<ReturnType<typeof readSoulMaterializationManifest>>;
  try {
    manifest = await readSoulMaterializationManifest(workspaceRoot);
  } catch {
    return null;
  }
  const entry = manifest?.files.find((file) => file.scope === scope);
  if (!entry?.ownerId) return null;

  let content = "";
  try {
    content = await readFile(join(workspaceRoot, entry.path), "utf8");
  } catch {
    return null;
  }

  const versionId = entry.currentVersionId ?? entry.sourceVersionId;
  return {
    id: entry.documentId ?? `${scope}_${entry.ownerId}`,
    scope,
    ownerId: entry.ownerId,
    currentVersionId: versionId,
    heartbeatEnabled: true,
    versions: versionId
      ? [{
          id: versionId,
          content: content.endsWith("\n") ? content.slice(0, -1) : content,
          changeSummary: "Existing materialized Soul runtime",
          createdAt: entry.materializedAt,
          createdBy: "system",
          source: "system",
          baseVersionId: null,
          restoreSourceVersionId: null,
        }]
      : [],
  };
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
      : await readCachedSoulForMaterialization(dataDir, "organization", den.orgId, workspace.path);
    const user = hasOverride("user")
      ? overrides.user ?? null
      : await readCachedSoulForMaterialization(dataDir, "user", den.userId, workspace.path);
    const workspaceDocument = hasOverride("workspace")
      ? overrides.workspace ?? null
      : await readCachedSoulForMaterialization(dataDir, "workspace", workspace.id, workspace.path);

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
    let activeAiGatewayRunRegistered = false;
    const unregisterRegisteredAiGatewayRun = () => {
      if (!activeAiGatewayRunRegistered) return;
      activeAiGatewayRunRegistered = false;
      unregisterActiveAiGatewayRun({
        workspaceId: workspace.id,
        conversationId: target.conversationId,
        runId,
        opencodeSessionId: target.opencodeSessionId,
      });
    };
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
      activeAiGatewayRunRegistered = true;
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
      unregisterRegisteredAiGatewayRun();
      throw error;
    }
    try {
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
    } finally {
      unregisterRegisteredAiGatewayRun();
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

  registerSessionArchiveRoutes(routes, { resolveArchiveOwnerKey, sessionArchives });

  registerAiGatewayRoutes(routes, { proxyAiGatewayReadinessRequest, proxyAiGatewayRequest });

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

    const soulMaterialization = await materializeSoulForWorkspace(serverDataDir, ctx, workspace);
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
      soulMaterialization,
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

  registerConversationSessionRoutes(routes, {
    conversationService,
    sessionTranscriptPrefetch,
    lifecycleClient,
    resolveConversationReadDirectory,
    loadConversationTranscriptResponse,
    createConversationRunTracer,
    resolveConversationExecutionTarget,
    submitConversationRunToOpenCode,
    enqueueConversationRun,
    deleteOpenCodeSession: async ({ workspace, sessionId }) => {
      await fetchOpencodeJson(workspace, `/session/${encodeURIComponent(sessionId)}`, {
        method: "DELETE",
      });
    },
    abortConversationRun: async ({ workspace, target, runId }) => {
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
      return { upstream, abortedGatewayRequestCount: abortedGatewayRequests.length };
    },
    reconcileConversationLifecycleAfterTranscriptAppend,
    recordSendWorkflowTrace,
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

  registerOpenCodeRouterRoutes(routes);

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

  registerFileSessionRoutes(routes, { fileSessions, recordWorkspaceFileEvent });

  registerPluginRoutes(routes);

  registerSkillRegistryRoutes(routes);

  registerSkillRemovalRoutes(routes, {
    serverDataDir,
    resolveActor: (ctx) => requireHostOrClient(ctx.request, config, ctx.tokens),
  });

  registerSkillEnabledRoutes(routes, { serverDataDir });

  registerUserGlobalSkillRoutes(routes, {
    serverDataDir,
    resolveActor: (ctx) => requireHostOrClient(ctx.request, config, ctx.tokens),
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

  registerMcpRoutes(routes, { fetchOpencodeJson });

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

  registerCommandRoutes(routes, { requireHost });

  registerAutomationRoutes(routes);

  registerSchedulerRoutes(routes);

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

type VesloServerConfigFile = Record<string, unknown> & {
  workspaces?: Array<Record<string, unknown>>;
  authorizedRoots?: string[];
};

function ensurePlainObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

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
    const explicitId = typeof obj.id === "string" ? obj.id.trim() : "";
    if (explicitId && explicitId === workspaceId) return false;
    const path = typeof obj.path === "string" ? obj.path.trim() : "";
    if (!path) return true;
    const pathId = workspaceIdForPath(resolve(configDir, path));
    return pathId !== workspaceId;
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
