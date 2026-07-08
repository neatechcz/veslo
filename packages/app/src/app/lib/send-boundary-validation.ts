import { z } from "zod";

import type { SendRuntimePreparationResult } from "../context/send-runtime-readiness";
import type {
  VesloConversationSubmitRequest,
  VesloConversationSubmitResult,
} from "./veslo-server";

export type ConversationSubmitTerminalResult = Extract<
  VesloConversationSubmitResult,
  { status: "submitted" | "queued" | "blocked" | "failed" }
>;

type SendBoundaryValidationIssue = {
  code: string;
  expected?: string | null;
  received?: string | null;
  message: string;
  path: string;
};

type SendBoundaryValidationFailure = {
  ok: false;
  message: string;
  issues: SendBoundaryValidationIssue[];
};

export type SendBoundaryValidationResult<T> =
  | { ok: true; value: T }
  | SendBoundaryValidationFailure;

export type SendBoundaryValidationMode = "off" | "report" | "strict";

type SendBoundaryValidationOptions = {
  context?: Record<string, unknown>;
  event: string;
  mode?: SendBoundaryValidationMode;
  recordSendTrace: (event: string, payload?: Record<string, unknown>) => void;
  schema: string;
  traceId?: string | null;
};

type SendBoundarySchema = {
  safeParse: (value: unknown) => { success: true } | { success: false; error: z.ZodError };
};

export type SendBoundaryValidationEnv = Record<string, string | boolean | undefined>;

export type SendBoundaryFailurePhase =
  | "app-runtime-preflight"
  | "managed-ai-auth-prime"
  | "server-session-create"
  | "server-run-submit"
  | "queued-run-drain"
  | "contract-validation"
  | "unknown";

export type SendBoundaryFailureClassifierInput = {
  code?: string | null;
  context?: Record<string, unknown>;
  debugTrace?: Array<Record<string, unknown>>;
  event?: string | null;
  message?: string | null;
  phase?: string | null;
  schema?: string | null;
  status?: string | null;
};

const nullableStringSchema = z.string().nullable().optional();
const nonEmptyStringSchema = z.string().min(1);
const promptModeSchema = z.enum(["prompt", "shell"]);

const debugTraceEntrySchema = z.object({
  event: z.string().optional(),
  source: z.string().optional(),
}).catchall(z.unknown());

const conversationSubmitAttachmentSchema = z.object({
  name: z.string(),
  kind: z.string(),
  mimeType: z.string(),
  dataUrl: nullableStringSchema,
  contentBase64: nullableStringSchema,
  fileSessionPath: nullableStringSchema,
});

const conversationSubmitDraftSchema = z.object({
  mode: promptModeSchema,
  text: z.string(),
  resolvedText: nullableStringSchema,
  parts: z.array(z.unknown()),
  command: z.object({
    name: nonEmptyStringSchema,
    arguments: z.string(),
  }).nullable().optional(),
  attachments: z.array(conversationSubmitAttachmentSchema).optional(),
});

const composerAttachmentSchema = z.object({
  id: z.string().optional(),
  name: nonEmptyStringSchema,
  mimeType: z.string(),
  size: z.number().nonnegative().optional(),
  kind: z.enum(["image", "file"]),
  dataUrl: z.string().optional(),
}).passthrough();

const composerDraftSchema = z.object({
  mode: promptModeSchema,
  text: z.string(),
  resolvedText: nullableStringSchema,
  parts: z.array(z.unknown()),
  command: z.object({
    name: nonEmptyStringSchema,
    arguments: z.string(),
  }).nullable().optional(),
  attachments: z.array(composerAttachmentSchema),
}).passthrough();

const sendTargetWorkspaceSchema = z.object({
  workspaceId: nonEmptyStringSchema,
  workspaceRoot: z.string(),
  directory: z.string(),
}).passthrough();

const sendPreflightContextSummarySchema = z.object({
  traceId: nonEmptyStringSchema,
  targetWorkspace: sendTargetWorkspaceSchema.nullable().optional(),
}).passthrough();

const legacyFallbackPrepareInputSchema = z.object({
  traceId: nonEmptyStringSchema,
  targetWorkspaceId: nonEmptyStringSchema,
  sendPreflight: sendPreflightContextSummarySchema,
  sendTargetWorkspace: sendTargetWorkspaceSchema.nullable().optional(),
});

const sendCorrelationSchema = z.object({
  clientMessageId: nonEmptyStringSchema,
  origin: nonEmptyStringSchema,
  source: nullableStringSchema,
}).passthrough();

const legacyFallbackSubmitInputSchema = z.object({
  traceId: nonEmptyStringSchema,
  sessionID: nonEmptyStringSchema,
  targetWorkspaceId: nonEmptyStringSchema,
  commandName: nullableStringSchema,
  compactCommand: z.boolean(),
  hasExplicitDraft: z.boolean(),
  draft: composerDraftSchema,
  sendCorrelation: sendCorrelationSchema,
  sendPreflight: sendPreflightContextSummarySchema,
  sendTargetWorkspace: sendTargetWorkspaceSchema.nullable().optional(),
});

const stagedSessionAttachmentSchema = z.object({
  name: nonEmptyStringSchema,
  kind: z.enum(["image", "file"]),
  mimeType: z.string(),
  relativePath: nonEmptyStringSchema,
  absolutePath: nonEmptyStringSchema,
});

const routedComposerDraftResultSchema = z.object({
  draft: composerDraftSchema,
  system: z.string().optional(),
  error: z.string().optional(),
});

const conversationSubmitOptionsSchema = z.object({
  sendNow: z.boolean().optional(),
  replaceMessageId: nullableStringSchema,
  submitQueuePolicy: z.enum(["normal", "send-now", "server-queue-only"]).optional(),
  model: z.unknown().optional(),
  agent: nullableStringSchema,
  variant: nullableStringSchema,
  expectAiGatewayStart: z.boolean().optional(),
  dryRun: z.boolean().optional(),
  implicitSkillCommandPolicy: z.enum(["confirm", "allow", "disable"]).optional(),
}).optional();

const conversationSubmitRequestSchema = z.object({
  clientMessageId: nonEmptyStringSchema,
  origin: nonEmptyStringSchema,
  source: nullableStringSchema,
  target: z.object({
    conversationId: nullableStringSchema,
    opencodeSessionId: nullableStringSchema,
    directory: nullableStringSchema,
    pendingClientSessionId: nullableStringSchema,
  }).optional(),
  draft: conversationSubmitDraftSchema,
  options: conversationSubmitOptionsSchema,
});

const submittedResultSchema = z.object({
  status: z.literal("submitted"),
  workspaceId: nonEmptyStringSchema,
  conversationId: nonEmptyStringSchema,
  opencodeSessionId: nonEmptyStringSchema,
  runId: nonEmptyStringSchema,
  clientMessageId: nonEmptyStringSchema,
  materializedSession: z.unknown().nullable().optional(),
  draftDisposition: z.literal("clear"),
  debugTrace: z.array(debugTraceEntrySchema).optional(),
});

const queuedResultSchema = z.object({
  status: z.literal("queued"),
  workspaceId: nonEmptyStringSchema,
  conversationId: nonEmptyStringSchema,
  opencodeSessionId: nonEmptyStringSchema,
  queueItemId: nonEmptyStringSchema,
  reservedRunId: nonEmptyStringSchema,
  queuePosition: z.number().int().nonnegative(),
  clientMessageId: nonEmptyStringSchema,
  materializedSession: z.unknown().nullable().optional(),
  draftDisposition: z.literal("clear"),
  debugTrace: z.array(debugTraceEntrySchema).optional(),
});

const conversationSubmitConfirmationSchema = z.object({
  type: z.literal("implicit_skill_command"),
  skillName: nonEmptyStringSchema,
  arguments: z.string(),
});

const blockedResultSchema = z.object({
  status: z.literal("blocked"),
  code: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
  workspaceId: z.string().optional(),
  conversationId: z.string().optional(),
  opencodeSessionId: z.string().optional(),
  clientMessageId: z.string().optional(),
  pendingClientSessionId: nullableStringSchema,
  materializedSession: z.unknown().nullable().optional(),
  draftDisposition: z.enum(["restore", "keep"]),
  recoverable: z.boolean(),
  confirmation: conversationSubmitConfirmationSchema.optional(),
});

const failedResultSchema = z.object({
  status: z.literal("failed"),
  code: nonEmptyStringSchema,
  message: nonEmptyStringSchema,
  workspaceId: z.string().optional(),
  conversationId: z.string().optional(),
  opencodeSessionId: z.string().optional(),
  queueItemId: z.string().optional(),
  reservedRunId: z.string().optional(),
  clientMessageId: z.string().optional(),
  pendingClientSessionId: nullableStringSchema,
  materializedSession: z.unknown().nullable().optional(),
  draftDisposition: z.enum(["restore", "mark-failed"]),
  debugTrace: z.array(debugTraceEntrySchema).optional(),
});

const conversationSubmitTerminalResultSchema = z.discriminatedUnion("status", [
  submittedResultSchema,
  queuedResultSchema,
  blockedResultSchema,
  failedResultSchema,
]);

const sendRuntimePreparationResultSchema = z.object({
  ok: z.boolean(),
  runtimeReady: z.boolean(),
  managedAiReady: z.boolean(),
  workspaceId: z.string().nullable(),
  activeWorkspace: z.boolean(),
  recoveryAttempted: z.boolean(),
  reason: z.enum([
    "runtime-health-skipped",
    "runtime-health-skip",
    "runtime-health-ok",
    "runtime-recovery-ok",
    "runtime-recovery-not-started",
    "runtime-recovery-error",
    "managed-ai-bootstrap-blocked",
  ]),
});

function issuePath(path: PropertyKey[]): string {
  return path.length ? path.map(String).join(".") : "<root>";
}

function validationIssues(error: z.ZodError): SendBoundaryValidationIssue[] {
  return error.issues.slice(0, 10).map((issue) => {
    const detail = issue as z.ZodIssue & {
      expected?: unknown;
      received?: unknown;
    };
    return {
      code: issue.code,
      expected: typeof detail.expected === "string" ? detail.expected : null,
      received: typeof detail.received === "string" ? detail.received : null,
      message: issue.message,
      path: issuePath(issue.path),
    };
  });
}

function issueCodeCounts(error: z.ZodError): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const issue of error.issues) {
    counts[issue.code] = (counts[issue.code] ?? 0) + 1;
  }
  return counts;
}

function issuePathPreview(error: z.ZodError): string[] {
  return error.issues.slice(0, 10).map((issue) => issuePath(issue.path));
}

function firstIssue(error: z.ZodError): SendBoundaryValidationIssue | null {
  return validationIssues(error)[0] ?? null;
}

function summarizeArray(value: unknown[]): Record<string, unknown> {
  return {
    valueType: "array",
    length: value.length,
    itemTypes: value
      .slice(0, 8)
      .map((item) => item === null ? "null" : Array.isArray(item) ? "array" : typeof item),
  };
}

function summarizeValue(value: unknown): Record<string, unknown> {
  if (Array.isArray(value)) {
    return summarizeArray(value);
  }
  if (!value || typeof value !== "object") {
    return { valueType: value === null ? "null" : typeof value };
  }
  const record = value as Record<string, unknown>;
  return {
    valueType: "object",
    status: typeof record.status === "string" ? record.status : null,
    keys: Object.keys(record).slice(0, 12),
    keyCount: Object.keys(record).length,
  };
}

function textFromClassifierInput(input: SendBoundaryFailureClassifierInput): string {
  const debugTraceText = Array.isArray(input.debugTrace)
    ? input.debugTrace.map((entry) => `${String(entry.event ?? "")} ${String(entry.code ?? "")}`).join(" ")
    : "";
  return [
    input.phase,
    input.event,
    input.schema,
    input.status,
    input.code,
    input.message,
    input.context?.phase,
    input.context?.event,
    debugTraceText,
  ]
    .filter((value) => typeof value === "string" && value.trim())
    .join(" ")
    .toLowerCase();
}

export function classifySendBoundaryFailurePhase(
  input: SendBoundaryFailureClassifierInput,
): SendBoundaryFailurePhase {
  const text = textFromClassifierInput(input);
  if (!text) return "unknown";
  if (
    text.includes("managed-ai-runtime-auth-prime") ||
    text.includes("managed ai gateway authorization") ||
    text.includes("managed-ai-auth-prime") ||
    text.includes("auth-prime")
  ) {
    return "managed-ai-auth-prime";
  }
  if (
    text.includes("runtime-preflight") ||
    text.includes("send-runtime-preparation") ||
    text.includes("runtime preparation")
  ) {
    return "app-runtime-preflight";
  }
  if (
    text.includes("run_submit") ||
    text.includes("run-submit") ||
    text.includes("prompt_async") ||
    text.includes("command-run")
  ) {
    return "server-run-submit";
  }
  if (
    text.includes("conversation_create") ||
    text.includes("conversation-create") ||
    text.includes("create conversation") ||
    text.includes("session-create") ||
    text.includes("/session")
  ) {
    return "server-session-create";
  }
  if (
    text.includes("queue-drain") ||
    text.includes("queued_run") ||
    text.includes("queue-zombie") ||
    text.includes("active run") ||
    text.includes("queueposition")
  ) {
    return "queued-run-drain";
  }
  if (text.includes("contract") || text.includes("validation")) {
    return "contract-validation";
  }
  return "unknown";
}

export function resolveSendBoundaryValidationMode(
  env?: SendBoundaryValidationEnv,
): SendBoundaryValidationMode {
  const raw = typeof env?.VITE_VESLO_SEND_BOUNDARY_VALIDATION === "string"
    ? env.VITE_VESLO_SEND_BOUNDARY_VALIDATION.trim().toLowerCase()
    : env?.VITE_VESLO_SEND_BOUNDARY_VALIDATION === false
      ? "off"
      : env?.VITE_VESLO_SEND_BOUNDARY_VALIDATION === true
        ? "report"
        : "";
  if (["0", "false", "no", "off", "disabled"].includes(raw)) return "off";
  if (["strict", "fail", "fail-closed", "block", "blocking"].includes(raw)) return "strict";
  if (["1", "true", "yes", "on", "enabled", "report", "warn", "warning"].includes(raw)) return "report";
  return "report";
}

function validateSendBoundary<T>(
  schema: SendBoundarySchema,
  value: unknown,
  options: SendBoundaryValidationOptions,
): SendBoundaryValidationResult<T> {
  const mode = options.mode ?? "report";
  if (mode === "off") {
    return { ok: true, value: value as T };
  }

  const result = schema.safeParse(value);
  if (result.success) {
    options.recordSendTrace(options.event.replace(/validation-failed$/, "validation-checked"), {
      ...(options.traceId ? { traceId: options.traceId } : {}),
      ...(options.context ?? {}),
      schema: options.schema,
      validator: "zod",
      validationMode: mode,
      strict: mode === "strict",
      payload: summarizeValue(value),
    });
    return { ok: true, value: value as T };
  }

  const issues = validationIssues(result.error);
  const primaryIssue = firstIssue(result.error);
  const message = `Invalid ${options.schema} send contract: ${issues
    .map((issue) => `${issue.path}: ${issue.message}`)
    .join("; ")}`;
  options.recordSendTrace(options.event, {
    ...(options.traceId ? { traceId: options.traceId } : {}),
    ...(options.context ?? {}),
    schema: options.schema,
    validator: "zod",
    validationMode: mode,
    strict: mode === "strict",
    blocking: mode === "strict",
    issueCount: result.error.issues.length,
    issueCodeCounts: issueCodeCounts(result.error),
    issuePaths: issuePathPreview(result.error),
    primaryIssue,
    issues,
    payload: summarizeValue(value),
  });
  if (mode !== "strict") {
    return { ok: true, value: value as T };
  }
  return { ok: false, message, issues };
}

export function validateConversationSubmitRequest(
  value: unknown,
  options: Omit<SendBoundaryValidationOptions, "schema">,
): SendBoundaryValidationResult<VesloConversationSubmitRequest> {
  return validateSendBoundary(conversationSubmitRequestSchema, value, {
    ...options,
    schema: "conversation-submit-request",
  });
}

export function validateLegacyFallbackPrepareInput<T>(
  value: T,
  options: Omit<SendBoundaryValidationOptions, "schema">,
): SendBoundaryValidationResult<T> {
  return validateSendBoundary(legacyFallbackPrepareInputSchema, value, {
    ...options,
    schema: "legacy-fallback-prepare-input",
  });
}

export function validateLegacyFallbackSubmitInput<T>(
  value: T,
  options: Omit<SendBoundaryValidationOptions, "schema">,
): SendBoundaryValidationResult<T> {
  return validateSendBoundary(legacyFallbackSubmitInputSchema, value, {
    ...options,
    schema: "legacy-fallback-submit-input",
  });
}

export function validateStagedSessionAttachments<T>(
  value: T,
  options: Omit<SendBoundaryValidationOptions, "schema">,
): SendBoundaryValidationResult<T> {
  return validateSendBoundary(z.array(stagedSessionAttachmentSchema), value, {
    ...options,
    schema: "staged-session-attachments",
  });
}

export function validateRoutedComposerDraftResult<T>(
  value: T,
  options: Omit<SendBoundaryValidationOptions, "schema">,
): SendBoundaryValidationResult<T> {
  return validateSendBoundary(routedComposerDraftResultSchema, value, {
    ...options,
    schema: "routed-composer-draft-result",
  });
}

export function validateConversationSubmitTerminalResult(
  value: unknown,
  options: Omit<SendBoundaryValidationOptions, "schema">,
): SendBoundaryValidationResult<ConversationSubmitTerminalResult> {
  return validateSendBoundary(conversationSubmitTerminalResultSchema, value, {
    ...options,
    schema: "conversation-submit-terminal-result",
  });
}

export function validateSendRuntimePreparationResult(
  value: unknown,
  options: Omit<SendBoundaryValidationOptions, "schema">,
): SendBoundaryValidationResult<SendRuntimePreparationResult> {
  return validateSendBoundary(sendRuntimePreparationResultSchema, value, {
    ...options,
    schema: "send-runtime-preparation-result",
  });
}
