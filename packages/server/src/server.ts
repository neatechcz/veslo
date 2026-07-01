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
import type { SoulPendingEdit } from "./soul-cache.js";
import type { SoulDocument, SoulScope, SoulVersion } from "./soul-memory.js";
import { createSoulController, type SoulMaterializationTestHookInput } from "./soul-controller.js";
import type { SoulMaterializationResult } from "./soul-materializer.js";
import {
  getSoulStatus,
  listSoulHeartbeats,
  readOpencodeConfig,
  soulMaterializationApprovalPaths as soulRuntimeMaterializationApprovalPaths,
} from "./soul-runtime.js";
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
  readSkillMaterializationManifest,
} from "./skill-materializer.js";
import { getPlatformManagedPersonalGlobalSkillSet } from "./platform-managed-skills.js";
import type { SkillSetMaterializationResult } from "./skill-materializer.js";
import {
  personalGlobalManagedSkillsRoot,
  userGlobalSkillRootsForMutation,
  workspaceManagedSkillsRoot,
  workspaceSkillRootsForMutation,
} from "./skill-roots.js";
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
import { workspaceResourceOwner } from "./resource-owner.js";
import { provisionWorkspaceInternalSystem, resolveVesloAppDataDir } from "./internal-system.js";
import { ApiError, formatError } from "./errors.js";
import {
  createAiGatewayRuntimeOwner,
  normalizeAiGatewaySessionId,
  type ActiveAiGatewayProxyRequest,
  type ActiveAiGatewayRunContext,
  type AiGatewayRuntimeAuthorizationEntry,
  type AiGatewaySessionResolution,
} from "./ai-gateway-runtime-owner.js";
import { createWorkspaceConfigOwner } from "./workspace-config-owner.js";
import { recordAudit, readAuditEntries, readLastAudit, resolveVesloDataDir, setAuditDebugLogPipeline } from "./audit.js";
import { createDebugLogPipeline, type DebugLogPipeline } from "./debug-log-pipeline.js";
import { validateDebugLogBatch } from "./debug-log-events.js";
import { ReloadEventStore } from "./events.js";
import { parseFrontmatter } from "./frontmatter.js";
import { opencodeConfigPath, vesloConfigPath } from "./workspace-files.js";
import { ensureDir, exists, hashToken, shortId } from "./utils.js";
import { persistServerWorkspaceState, workspaceIdForPath } from "./workspaces.js";
import { TokenService } from "./tokens.js";
import { TOY_UI_CSS, TOY_UI_HTML, TOY_UI_JS, cssResponse, htmlResponse, jsResponse } from "./toy-ui.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { registerAiGatewayRoutes } from "./routes/ai-gateway.js";
import { registerAutomationRoutes } from "./routes/automations.js";
import { registerCommandRoutes } from "./routes/commands.js";
import {
  registerConversationSessionRoutes,
  type ConversationExecutionTarget,
  type ConversationRunTracer,
} from "./routes/conversations.js";
import {
  createConversationRunLifecycleController,
  type ConversationRunLifecycleController,
  type ConversationRunLifecycleControllerOptions,
} from "./conversation-run-lifecycle-controller.js";
import {
  registerFileSessionRoutes,
  resolveInboxEnabled,
  resolveInboxMaxBytes,
  resolveOutboxEnabled,
} from "./routes/file-sessions.js";
import { registerHealthStatusRoutes } from "./routes/health.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerOpenCodeRouterRoutes } from "./routes/opencode-router.js";
import { registerPluginRoutes } from "./routes/plugins.js";
import { registerSchedulerRoutes } from "./routes/scheduler.js";
import { registerSessionArchiveRoutes } from "./routes/session-archives.js";
import { registerSkillEnabledRoutes } from "./routes/skill-enabled.js";
import { registerSkillMaterializationRoutes } from "./routes/skill-materialization.js";
import { registerSkillRegistryRoutes } from "./routes/skill-registry.js";
import { registerSkillRemovalRoutes } from "./routes/skill-removals.js";
import { registerSoulRoutes } from "./routes/soul.js";
import { registerUserGlobalSkillRoutes } from "./routes/user-global-skills.js";
import { registerWorkspaceManagementRoutes } from "./routes/workspace-management.js";
import { registerWorkspaceSkillRoutes } from "./routes/workspace-skills.js";
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
const CONVERSATION_RUN_LIFECYCLE_RECONCILE_INITIAL_DELAY_DEFAULT_MS = 250;
const CONVERSATION_RUN_LIFECYCLE_RECONCILE_POLL_DEFAULT_MS = 1_000;
const CONVERSATION_RUN_LIFECYCLE_RECONCILE_MAX_ATTEMPTS_DEFAULT = 600;
const AUTOMATION_OPENCODE_REQUEST_TIMEOUT_MS = 30_000;
export const REDACTED_SECRET_VALUE = "[REDACTED]";
const GATEWAY_CALLER_AUTH_HEADER = "x-veslo-gateway-authorization";
const GATEWAY_ACCESS_TOKEN_HEADER = "x-veslo-gateway-token";
const GATEWAY_SESSION_ID_HEADER = "x-veslo-session-id";
const GATEWAY_WORKSPACE_ID_HEADER = "x-veslo-workspace-id";
const OPENCODE_SESSION_ID_TEMPLATE = "${OPENCODE_SESSION_ID}";
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

const aiGatewayRuntimeOwner = createAiGatewayRuntimeOwner({
  providerStartTimeoutMs: resolveAiGatewayProviderStartTimeoutMs,
  recordTrace: (event, payload) => recordSendWorkflowTrace("server", event, payload),
});
const soulController = createSoulController();

type ServerLogger = {
  log: (level: LogLevel, message: string, attributes?: LogAttributes) => void;
};

let conversationRunLifecycleControllerFactoryForTests:
  | ((options: ConversationRunLifecycleControllerOptions) => ConversationRunLifecycleController)
  | null = null;

export function setSoulMaterializationTestHookForTests(
  hook: ((input: SoulMaterializationTestHookInput) => Promise<void>) | null,
): void {
  soulController.setMaterializationTestHookForTests(hook);
}

export function setConversationRunLifecycleControllerFactoryForTests(
  factory: ((options: ConversationRunLifecycleControllerOptions) => ConversationRunLifecycleController) | null,
): void {
  conversationRunLifecycleControllerFactoryForTests = factory;
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

const workspaceConfigOwner = createWorkspaceConfigOwner({
  readOpencodeConfig,
  redactSensitiveConfig,
});

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
  const routeBundle = createRoutes(config, approvals, tokens, automationRunner);
  const routes = routeBundle.routes;
  const conversationRunLifecycleController = routeBundle.conversationRunLifecycleController;
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
  conversationRunLifecycleController.start();
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
    conversationRunLifecycleController.stop();
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
const VESLO_CONVERSATION_RUN_ID_HEADER = "x-veslo-conversation-run-id";

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

function isWorkspaceOpencodeProxyUrl(url: URL, workspaceId: string): boolean {
  const match = /^\/workspace\/([^/]+)\/opencode(?:\/|$)/.exec(url.pathname);
  if (!match) return false;
  try {
    return decodeURIComponent(match[1] ?? "") === workspaceId;
  } catch {
    return false;
  }
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
    conversationRunId?: string | null;
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
  const conversationRunId = init.conversationRunId?.trim() ?? "";
  const shouldSendConversationRunId = Boolean(conversationRunId && isWorkspaceOpencodeProxyUrl(url, workspace.id));
  if (shouldSendConversationRunId) {
    headers.set(VESLO_CONVERSATION_RUN_ID_HEADER, conversationRunId);
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
    hasConversationRunId: shouldSendConversationRunId,
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

function buildActiveAiGatewayResolutionDiagnostics(input: {
  incomingSessionId?: string | null;
  workspaceId?: string | null;
}): Record<string, unknown> {
  return aiGatewayRuntimeOwner.buildResolutionDiagnostics(input);
}

function registerAiGatewayRuntimeAuthorization(input: {
  actor?: Actor;
  authorization: string;
  source: AiGatewayRuntimeAuthorizationEntry["source"];
}): void {
  aiGatewayRuntimeOwner.registerRuntimeAuthorization(input);
}

function clearAiGatewayRuntimeAuthorization(actor?: Actor): void {
  aiGatewayRuntimeOwner.clearRuntimeAuthorization(actor);
}

function syncAiGatewayRuntimeAuthorizationFromAccessBundle(input: {
  actor?: Actor;
  value: unknown;
  callerAuthorization: string;
}): void {
  aiGatewayRuntimeOwner.syncRuntimeAuthorizationFromAccessBundle(input);
}

function resolveAiGatewayProviderAuthorization(input: {
  request: Request;
  actor?: Actor;
}): {
  authorization: string;
  source: "legacy-header" | AiGatewayRuntimeAuthorizationEntry["source"];
} {
  return aiGatewayRuntimeOwner.resolveProviderAuthorization({
    ...input,
    accessTokenHeader: GATEWAY_ACCESS_TOKEN_HEADER,
  });
}

function listActiveAiGatewayRunContexts(now = Date.now()): ActiveAiGatewayRunContext[] {
  return aiGatewayRuntimeOwner.listActiveRunContexts(now);
}

function unregisterActiveAiGatewayRun(
  input: Pick<ActiveAiGatewayRunContext, "workspaceId" | "conversationId" | "runId" | "opencodeSessionId">,
): void {
  aiGatewayRuntimeOwner.unregisterActiveRun(input);
}
function registerActiveAiGatewayRun(input: Omit<ActiveAiGatewayRunContext, "at">): void {
  aiGatewayRuntimeOwner.registerActiveRun(input);
}

function resolveAiGatewaySession(input: {
  incomingSessionId?: string | null;
  openCodeSessionId?: string | null;
  workspaceId?: string | null;
}): AiGatewaySessionResolution {
  return aiGatewayRuntimeOwner.resolveSession(input);
}

function registerActiveAiGatewayProxyRequest(input: Omit<ActiveAiGatewayProxyRequest, "abortReason">): ActiveAiGatewayProxyRequest {
  return aiGatewayRuntimeOwner.registerActiveProxyRequest(input);
}

function unregisterActiveAiGatewayProxyRequest(requestId: string): void {
  aiGatewayRuntimeOwner.unregisterActiveProxyRequest(requestId);
}

function abortActiveAiGatewayProxyRequests(input: {
  workspaceId: string;
  runId?: string | null;
  sessionId?: string | null;
  reason: string;
}): ActiveAiGatewayProxyRequest[] {
  return aiGatewayRuntimeOwner.abortActiveProxyRequests(input);
}

function recordAiGatewaySessionHit(input: {
  sessionId?: string;
  workspaceId?: string;
  requestId: string;
  provider: string | null;
  gatewayPath: string;
  now?: number;
}): void {
  aiGatewayRuntimeOwner.recordSessionHit({
    ...input,
    at: input.now,
  });
}

function hasAiGatewayProviderHitAfter(input: {
  sessionId: string;
  workspaceId: string;
  startedAt: number;
}): boolean {
  return aiGatewayRuntimeOwner.hasProviderHitAfter(input);
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
  return aiGatewayRuntimeOwner.waitForProviderStart(input);
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
  return soulController.soulDenContext(ctx);
}

function requireSoulDenToken(ctx: SoulDenContext): string {
  return soulController.requireSoulDenToken(ctx);
}

function requireSoulOrgId(ctx: SoulDenContext): string {
  return soulController.requireSoulOrgId(ctx);
}

function requireSoulUserId(ctx: SoulDenContext): string {
  return soulController.requireSoulUserId(ctx);
}

function soulCanEdit(ctx: RequestContext, scope: SoulScope): boolean {
  return soulController.soulCanEdit(ctx, scope);
}

function soulSummary(input: {
  scope: SoulScope;
  ownerId: string;
  document: SoulDocument | null;
  canEdit: boolean;
  status?: SoulSummary["status"];
  workspace?: WorkspaceInfo;
}): SoulSummary {
  return soulController.soulSummary(input);
}

function emptySoulDocument(scope: SoulScope, ownerId: string): SoulDocument {
  return soulController.emptySoulDocument(scope, ownerId);
}

function isSoulDenUnavailable(error: unknown): boolean {
  return soulController.isSoulDenUnavailable(error);
}

function validateSoulScopeParam(value: string): SoulScope {
  return soulController.validateSoulScopeParam(value);
}

function requireSoulText(body: Record<string, unknown>, field: "content" | "changeSummary"): string {
  return soulController.requireSoulText(body, field);
}

function optionalSoulBaseVersionId(body: Record<string, unknown>): string | null {
  return soulController.optionalSoulBaseVersionId(body);
}

function soulActorId(ctx: RequestContext): string {
  return soulController.soulActorId(ctx);
}

function soulVersionId(prefix = "soul_v"): string {
  return soulController.soulVersionId(prefix);
}

function soulVersionResponse(document: SoulDocument, versionId: string): SoulVersion {
  return soulController.soulVersionResponse(document, versionId);
}

async function readCachedSoulVersions(dataDir: string, scope: SoulScope, ownerId: string): Promise<SoulVersion[]> {
  return soulController.readCachedSoulVersions(dataDir, scope, ownerId);
}

async function materializeSoulForWorkspace(
  dataDir: string,
  ctx: RequestContext,
  workspace: WorkspaceInfo,
  overrides: Partial<Record<SoulScope, SoulDocument | null>> = {},
  options: { workspaceActive?: boolean } = {},
): Promise<SoulMaterializationResult> {
  return soulController.materializeSoulForWorkspace(dataDir, ctx, workspace, overrides, options);
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
  return soulController.materializeSoulForConfiguredWorkspaces(dataDir, config, ctx, overrides, options);
}

function soulReadPayload(input: {
  document: SoulDocument | null;
  summary: SoulSummary;
  pendingEdits?: SoulPendingEdit[];
  denSynced?: boolean;
  materialization?: unknown;
}) {
  return soulController.soulReadPayload(input);
}

function activeSoulWorkspaceIdsFromBody(body: Record<string, unknown>, config?: ServerConfig): Set<string> {
  return soulController.activeSoulWorkspaceIdsFromBody(body, config);
}

function soulWorkspaceActiveFromBody(body: Record<string, unknown>, workspaceId: string): boolean {
  return soulController.soulWorkspaceActiveFromBody(body, workspaceId);
}

async function configuredSoulMaterializationApprovalPaths(
  config: ServerConfig,
  extraPaths: string[],
): Promise<string[]> {
  return soulController.configuredSoulMaterializationApprovalPaths(config, extraPaths);
}

function globalSoulApprovalWorkspaceId(config: ServerConfig): string {
  return soulController.globalSoulApprovalWorkspaceId(config);
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
): { routes: Route[]; conversationRunLifecycleController: ConversationRunLifecycleController } {
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
    const sessionPath = `/session/${encodeURIComponent(opencodeSessionId)}`;
    switch (kind) {
      case "prompt_async":
        return `${sessionPath}/prompt_async?${query.toString()}`;
      case "command":
        return `${sessionPath}/command?${query.toString()}`;
      case "shell":
        return `${sessionPath}/shell?${query.toString()}`;
      case "summarize":
        return `${sessionPath}/summarize?${query.toString()}`;
    }
  };

  type ConversationRunLifecycleReconcileInput = {
    workspace: WorkspaceInfo;
    conversationId: string;
    runId: string;
    reason: string;
    abortRequested?: boolean;
    delayMs?: number;
    attempt?: number;
  };
  let scheduleConversationRunLifecycleReconcile:
    ((input: ConversationRunLifecycleReconcileInput) => void) | null = null;

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
          conversationRunId: runId,
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
      scheduleConversationRunLifecycleReconcile?.({
        workspace,
        conversationId: target.conversationId,
        runId,
        reason: "submit-failed",
        delayMs: 0,
      });
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
          scheduleConversationRunLifecycleReconcile?.({
            workspace,
            conversationId: target.conversationId,
            runId,
            reason: "ai-gateway-provider-start-timeout",
            delayMs: 0,
          });
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
    scheduleConversationRunLifecycleReconcile?.({
      workspace,
      conversationId: target.conversationId,
      runId,
      reason: "accepted",
      delayMs: resolveConversationRunLifecycleReconcileInitialDelayMs(),
    });
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

  const conversationRunLifecycleReconcileKey = (workspaceId: string, conversationId: string, runId: string) =>
    `${workspaceId}\0${conversationId}\0${runId}`;
  const conversationRunLifecycleReconcileTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const conversationRunLifecycleReconcileInFlight = new Set<string>();

  async function reconcileConversationRunLifecycle(input: ConversationRunLifecycleReconcileInput): Promise<void> {
    const lifecycleOwner = input.workspace.workspaceType === "remote" ? null : lifecycleClient;
    if (!lifecycleOwner) return;
    const conversationId = input.conversationId.trim();
    const runId = input.runId.trim();
    if (!conversationId || !runId) return;

    const key = conversationRunLifecycleReconcileKey(input.workspace.id, conversationId, runId);
    if (conversationRunLifecycleReconcileInFlight.has(key)) {
      scheduleConversationRunLifecycleReconcile?.({
        ...input,
        delayMs: resolveConversationRunLifecycleReconcilePollMs(),
      });
      return;
    }

    const attempt = input.attempt ?? 0;
    const scheduleNextAttempt = () => {
      const nextAttempt = attempt + 1;
      if (nextAttempt >= resolveConversationRunLifecycleReconcileMaxAttempts()) {
        recordSendWorkflowTrace("server", "server:conversation-run:lifecycle-reconcile-exhausted", {
          workspaceId: input.workspace.id,
          conversationId,
          runId,
          reason: input.reason,
          abortRequested: input.abortRequested === true,
          attempts: nextAttempt,
        });
        return;
      }
      scheduleConversationRunLifecycleReconcile?.({
        ...input,
        conversationId,
        runId,
        attempt: nextAttempt,
        delayMs: resolveConversationRunLifecycleReconcilePollMs(),
      });
    };

    conversationRunLifecycleReconcileInFlight.add(key);
    try {
      const status = await lifecycleOwner.status(input.workspace.id, conversationId, runId);
      recordSendWorkflowTrace("server", "server:conversation-run:lifecycle-reconcile", {
        workspaceId: input.workspace.id,
        conversationId,
        runId,
        reason: input.reason,
        abortRequested: input.abortRequested === true,
        status: status?.status ?? null,
        stale: status?.stale ?? null,
        attempt,
      });

      if (!status) {
        if (input.abortRequested === true) {
          await lifecycleOwner.markAborted(
            input.workspace.id,
            runId,
            "user abort reconciled after missing lifecycle status",
          ).catch((error) => {
            recordSendWorkflowTrace("server", "server:conversation-run:lifecycle-mark-aborted-error", {
              workspaceId: input.workspace.id,
              conversationId,
              runId,
              reason: input.reason,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
        scheduleConversationQueueDrain(input.workspace.id, conversationId, 0);
        return;
      }

      if (status.stale === true) {
        recordSendWorkflowTrace("server", "server:conversation-run:lifecycle-reconcile-stale", {
          workspaceId: input.workspace.id,
          conversationId,
          runId,
          reason: input.reason,
          status: status.status,
          abortRequested: input.abortRequested === true,
          attempt,
        });
        scheduleNextAttempt();
        return;
      }

      if (!isActiveLifecycleStatus(status.status)) {
        if (input.abortRequested === true && status.status !== "aborted") {
          await lifecycleOwner.markAborted(
            input.workspace.id,
            runId,
            "user abort reconciled after engine became inactive",
          ).catch((error) => {
            recordSendWorkflowTrace("server", "server:conversation-run:lifecycle-mark-aborted-error", {
              workspaceId: input.workspace.id,
              conversationId,
              runId,
              reason: input.reason,
              status: status.status,
              message: error instanceof Error ? error.message : String(error),
            });
          });
        }
        scheduleConversationQueueDrain(input.workspace.id, conversationId, 0);
        return;
      }

      scheduleNextAttempt();
    } catch (error) {
      recordSendWorkflowTrace("server", "server:conversation-run:lifecycle-reconcile-error", {
        workspaceId: input.workspace.id,
        conversationId,
        runId,
        reason: input.reason,
        abortRequested: input.abortRequested === true,
        attempt,
        message: error instanceof Error ? error.message : String(error),
      });
      scheduleNextAttempt();
    } finally {
      conversationRunLifecycleReconcileInFlight.delete(key);
    }
  }

  scheduleConversationRunLifecycleReconcile = (input) => {
    const conversationId = input.conversationId.trim();
    const runId = input.runId.trim();
    if (!conversationId || !runId) return;
    const key = conversationRunLifecycleReconcileKey(input.workspace.id, conversationId, runId);
    const delayMs = Math.max(0, input.delayMs ?? 0);
    const existing = conversationRunLifecycleReconcileTimers.get(key);
    if (existing) {
      if (delayMs > 0 && input.abortRequested !== true) return;
      clearTimeout(existing);
      conversationRunLifecycleReconcileTimers.delete(key);
    }
    const timer = setTimeout(() => {
      conversationRunLifecycleReconcileTimers.delete(key);
      void reconcileConversationRunLifecycle({
        ...input,
        conversationId,
        runId,
        attempt: input.attempt ?? 0,
      });
    }, delayMs);
    (timer as { unref?: () => void }).unref?.();
    conversationRunLifecycleReconcileTimers.set(key, timer);
  };

  const conversationRunLifecycleControllerFactory =
    conversationRunLifecycleControllerFactoryForTests ?? createConversationRunLifecycleController;
  const conversationRunLifecycleController = conversationRunLifecycleControllerFactory({
    lifecycleClient,
    queueStore: conversationRunQueueStore,
    submitOpenCode: submitConversationRunToOpenCode,
    scheduleQueueDrain: scheduleConversationQueueDrain,
    queueDrainPollMs: CONVERSATION_QUEUE_DRAIN_POLL_MS,
  });

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
    return soulController.readOrganizationSoulModel(serverDataDir, ctx);
  };

  const readUserSoulModel = async (ctx: RequestContext) => {
    return soulController.readUserSoulModel(serverDataDir, ctx);
  };

  const readWorkspaceSoulModel = async (ctx: RequestContext, workspace: WorkspaceInfo) => {
    return soulController.readWorkspaceSoulModel(serverDataDir, ctx, workspace);
  };

  const recordWorkspaceFileEvent = (workspaceId: string, input: { type: "write" | "delete" | "rename" | "mkdir"; path: string; toPath?: string; revision?: string }) => {
    return fileSessions.recordWorkspaceEvent({ workspaceId, ...input });
  };

  registerHealthStatusRoutes(routes, {
    serverVersion: SERVER_VERSION,
    buildCapabilities,
    resolveToyUiEnabled,
    serializeWorkspaceForResponse,
  });

  registerWorkspaceManagementRoutes(routes, {
    serverDataDir,
    serializeWorkspaceForResponse,
    optionalBodyHttpUrl,
    optionalBodyString,
    persistWorkspaceDeletion,
    redactSensitiveConfig,
    readOpencodeConfig,
    readVesloConfig,
    materializeSoulForWorkspace,
    writeVesloConfig,
    buildConfigTrigger,
    reloadOpencodeEngine,
    exportWorkspace,
    importWorkspace,
  });
  registerSessionArchiveRoutes(routes, { resolveArchiveOwnerKey, sessionArchives });

  registerAiGatewayRoutes(routes, { proxyAiGatewayReadinessRequest, proxyAiGatewayRequest });

  registerAdminRoutes(routes);
  registerConversationSessionRoutes(routes, {
    conversationService,
    sessionTranscriptPrefetch,
    conversationRunLifecycleController,
    lifecycleClient,
    resolveConversationReadDirectory,
    loadConversationTranscriptResponse,
    createConversationRunTracer,
    resolveConversationExecutionTarget,
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
        await lifecycleOwner.markAbortRequested(workspace.id, runId).catch((error) => {
          recordSendWorkflowTrace("server", "server:conversation-run:lifecycle-abort-requested-error", {
            workspaceId: workspace.id,
            conversationId: target.conversationId,
            runId,
            message: error instanceof Error ? error.message : String(error),
          });
        });
        scheduleConversationRunLifecycleReconcile?.({
          workspace,
          conversationId: target.conversationId,
          runId,
          reason: "abort-requested",
          abortRequested: true,
          delayMs: 0,
        });
      }
      return { upstream, abortedGatewayRequestCount: abortedGatewayRequests.length };
    },
    reconcileConversationLifecycleAfterTranscriptAppend,
    recordSendWorkflowTrace,
  });

  registerOpenCodeRouterRoutes(routes);

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

  registerSkillMaterializationRoutes(routes, { serverDataDir });

  registerWorkspaceSkillRoutes(routes, { serverDataDir });

  registerMcpRoutes(routes, { fetchOpencodeJson });

  registerCommandRoutes(routes, { requireHost });

  registerAutomationRoutes(routes);

  registerSchedulerRoutes(routes);

  registerSoulRoutes(routes, {
    serverDataDir,
    readOrganizationSoulModel,
    readUserSoulModel,
    readWorkspaceSoulModel,
    soulReadPayload,
    materializeSoulForWorkspace,
    materializeSoulForConfiguredWorkspaces,
    activeSoulWorkspaceIdsFromBody,
    soulWorkspaceActiveFromBody,
    soulMaterializationApprovalPaths: (workspace) => soulRuntimeMaterializationApprovalPaths(workspace.path),
    configuredSoulMaterializationApprovalPaths,
    globalSoulApprovalWorkspaceId,
    validateSoulScopeParam,
    readCachedSoulVersions,
    soulDenContext,
    requireSoulDenToken,
    requireSoulOrgId,
    requireSoulUserId,
    soulCanEdit,
    soulSummary,
    isSoulDenUnavailable,
    requireSoulText,
    optionalSoulBaseVersionId,
    soulVersionResponse,
    emptySoulDocument,
    soulActorId,
    soulVersionId,
    parseInteger,
    getSoulStatus,
    listSoulHeartbeats,
  });
  return { routes, conversationRunLifecycleController };
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

function resolveConversationRunLifecycleReconcileInitialDelayMs(): number {
  const parsed = parseInteger(process.env.VESLO_CONVERSATION_RUN_LIFECYCLE_RECONCILE_INITIAL_DELAY_MS);
  if (parsed !== null && parsed >= 0) {
    return clampNumber(parsed, 0, 60_000);
  }
  return CONVERSATION_RUN_LIFECYCLE_RECONCILE_INITIAL_DELAY_DEFAULT_MS;
}

function resolveConversationRunLifecycleReconcilePollMs(): number {
  const parsed = parseInteger(process.env.VESLO_CONVERSATION_RUN_LIFECYCLE_RECONCILE_POLL_MS);
  if (parsed !== null && parsed > 0) {
    return clampNumber(parsed, 10, 60_000);
  }
  return CONVERSATION_RUN_LIFECYCLE_RECONCILE_POLL_DEFAULT_MS;
}

function resolveConversationRunLifecycleReconcileMaxAttempts(): number {
  const parsed = parseInteger(process.env.VESLO_CONVERSATION_RUN_LIFECYCLE_RECONCILE_MAX_ATTEMPTS);
  if (parsed !== null && parsed > 0) {
    return clampNumber(parsed, 1, 600);
  }
  return CONVERSATION_RUN_LIFECYCLE_RECONCILE_MAX_ATTEMPTS_DEFAULT;
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

async function readVesloConfig(workspaceRoot: string): Promise<Record<string, unknown>> {
  return workspaceConfigOwner.readVesloConfig(workspaceRoot);
}

function resolveOpencodeDirectory(workspace: WorkspaceInfo): string | null {
  return workspaceConfigOwner.resolveOpencodeDirectory(workspace);
}

async function resolveConversationReadDirectory(
  workspace: WorkspaceInfo,
  requestedRaw: string | null,
): Promise<string | null> {
  return workspaceConfigOwner.resolveConversationReadDirectory(workspace, requestedRaw);
}

function normalizeConversationReadDirectoryRequest(
  workspace: WorkspaceInfo,
  requestedRaw: string | null,
  fallback: string | null,
): string {
  return workspaceConfigOwner.normalizeConversationReadDirectoryRequest(workspace, requestedRaw, fallback);
}

function buildOpencodeReloadUrl(baseUrl: string, directory?: string | null): string {
  return workspaceConfigOwner.buildOpencodeReloadUrl(baseUrl, directory);
}

function buildOpencodeAuthHeader(workspace: WorkspaceInfo): string | null {
  return workspaceConfigOwner.buildOpencodeAuthHeader(workspace);
}

function parseOpencodeErrorBody(input: string): unknown {
  return workspaceConfigOwner.parseOpencodeErrorBody(input);
}

async function reloadOpencodeEngine(workspace: WorkspaceInfo): Promise<void> {
  return workspaceConfigOwner.reloadOpencodeEngine(workspace);
}

async function writeVesloConfig(workspaceRoot: string, payload: Record<string, unknown>, merge: boolean): Promise<void> {
  return workspaceConfigOwner.writeVesloConfig(workspaceRoot, payload, merge);
}

async function exportWorkspace(workspace: WorkspaceInfo) {
  return workspaceConfigOwner.exportWorkspace(workspace);
}

async function importWorkspace(workspace: WorkspaceInfo, payload: Record<string, unknown>): Promise<void> {
  return workspaceConfigOwner.importWorkspace(workspace, payload);
}
