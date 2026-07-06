import { createHash } from "node:crypto";

import { ApiError } from "./errors.js";

export type ConversationSubmitDraftMode = "prompt" | "shell";

export type ConversationSubmitAttachment = {
  name: string;
  kind: string;
  mimeType: string;
  dataUrl?: string | null;
  contentBase64?: string | null;
  fileSessionPath?: string | null;
};

export type ConversationSubmitRequest = {
  clientMessageId: string;
  origin: string;
  source?: string | null;
  target?: {
    conversationId?: string | null;
    opencodeSessionId?: string | null;
    directory?: string | null;
    pendingClientSessionId?: string | null;
  };
  draft: {
    mode: ConversationSubmitDraftMode;
    text: string;
    resolvedText?: string | null;
    parts: unknown[];
    command?: { name: string; arguments: string } | null;
    attachments?: ConversationSubmitAttachment[];
  };
  options?: {
    sendNow?: boolean;
    replaceMessageId?: string | null;
    submitQueuePolicy?: "normal" | "send-now" | "server-queue-only";
    model?: unknown;
    agent?: string | null;
    variant?: string | null;
    expectAiGatewayStart?: boolean;
    dryRun?: boolean;
  };
};

export type ConversationSubmitDebugTraceEntry = {
  source?: string;
  event: string;
  [key: string]: unknown;
};

export type ConversationSubmitResolvedRunInput =
  | {
      kind: "prompt_async";
      text: string;
      parts: unknown[];
    }
  | {
      kind: "shell";
      command: string;
    }
  | {
      kind: "command";
      command: string;
      arguments: string;
      parts?: unknown[];
    };

export type ConversationSubmitDryRunResult = {
  status: "dry_run";
  workspaceId: string;
  clientMessageId: string;
  requestHash: string;
  draftDisposition: "keep";
  resolvedRunInput: ConversationSubmitResolvedRunInput;
  target: {
    directory: string | null;
    conversationId?: string | null;
    opencodeSessionId?: string | null;
    pendingClientSessionId?: string | null;
  };
};

export type ConversationSubmitMaterializedResult = {
  status: "materialized";
  workspaceId: string;
  conversationId: string;
  opencodeSessionId: string;
  clientMessageId: string;
  pendingClientSessionId?: string | null;
  materializedSession: unknown;
  draftDisposition: "keep";
};

export type ConversationSubmitSubmittedResult = {
  status: "submitted";
  workspaceId: string;
  conversationId: string;
  opencodeSessionId: string;
  runId: string;
  clientMessageId: string;
  materializedSession?: unknown | null;
  draftDisposition: "clear";
};

export type ConversationSubmitQueuedResult = {
  status: "queued";
  workspaceId: string;
  conversationId: string;
  opencodeSessionId: string;
  queueItemId: string;
  reservedRunId: string;
  queuePosition: number;
  clientMessageId: string;
  materializedSession?: unknown | null;
  draftDisposition: "clear";
};

export type ConversationSubmitBlockedResult = {
  status: "blocked";
  code: string;
  message: string;
  draftDisposition: "restore" | "keep";
  recoverable: boolean;
};

export type ConversationSubmitFailedResult = {
  status: "failed";
  code: string;
  message: string;
  draftDisposition: "restore" | "mark-failed";
  debugTrace?: ConversationSubmitDebugTraceEntry[];
};

export type ConversationSubmitResult =
  | ConversationSubmitDryRunResult
  | ConversationSubmitMaterializedResult
  | ConversationSubmitSubmittedResult
  | ConversationSubmitQueuedResult
  | ConversationSubmitBlockedResult
  | ConversationSubmitFailedResult;

const normalizeText = (value: string | null | undefined) => value?.trim() ?? "";

const normalizeNullableText = (value: string | null | undefined) => normalizeText(value) || null;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function bodyString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  return typeof value === "string" ? value.trim() : "";
}

function optionalBodyString(body: Record<string, unknown>, field: string): string | null | undefined {
  if (body[field] === null) return null;
  const value = body[field];
  return typeof value === "string" ? value.trim() || null : undefined;
}

function optionalBodyBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  return typeof body[field] === "boolean" ? body[field] : undefined;
}

function parseTarget(value: unknown): ConversationSubmitRequest["target"] {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new ApiError(400, "invalid_payload", "target must be an object");
  }
  return {
    conversationId: optionalBodyString(value, "conversationId"),
    opencodeSessionId: optionalBodyString(value, "opencodeSessionId"),
    directory: optionalBodyString(value, "directory"),
    pendingClientSessionId: optionalBodyString(value, "pendingClientSessionId"),
  };
}

function parseCommand(value: unknown): ConversationSubmitRequest["draft"]["command"] {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new ApiError(400, "invalid_payload", "draft.command must be an object");
  }
  const name = bodyString(value, "name");
  if (!name) {
    throw new ApiError(400, "invalid_payload", "draft.command.name is required");
  }
  return {
    name,
    arguments: bodyString(value, "arguments"),
  };
}

function parseAttachments(value: unknown): ConversationSubmitAttachment[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new ApiError(400, "invalid_payload", "draft.attachments must be an array");
  }
  return value.map((item, index) => {
    if (!isRecord(item)) {
      throw new ApiError(400, "invalid_payload", `draft.attachments[${index}] must be an object`);
    }
    const name = bodyString(item, "name");
    const kind = bodyString(item, "kind");
    const mimeType = bodyString(item, "mimeType");
    if (!name || !kind || !mimeType) {
      throw new ApiError(400, "invalid_payload", `draft.attachments[${index}] requires name, kind, and mimeType`);
    }
    return {
      name,
      kind,
      mimeType,
      dataUrl: optionalBodyString(item, "dataUrl"),
      contentBase64: optionalBodyString(item, "contentBase64"),
      fileSessionPath: optionalBodyString(item, "fileSessionPath"),
    };
  });
}

function parseOptions(value: unknown): ConversationSubmitRequest["options"] {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new ApiError(400, "invalid_payload", "options must be an object");
  }
  const queuePolicyRaw = bodyString(value, "submitQueuePolicy");
  const submitQueuePolicy = queuePolicyRaw === "normal" ||
    queuePolicyRaw === "send-now" ||
    queuePolicyRaw === "server-queue-only"
      ? queuePolicyRaw
      : undefined;
  if (queuePolicyRaw && !submitQueuePolicy) {
    throw new ApiError(400, "invalid_payload", "options.submitQueuePolicy is invalid");
  }
  return {
    sendNow: optionalBodyBoolean(value, "sendNow"),
    replaceMessageId: optionalBodyString(value, "replaceMessageId"),
    ...(submitQueuePolicy ? { submitQueuePolicy } : {}),
    model: value.model,
    agent: optionalBodyString(value, "agent"),
    variant: optionalBodyString(value, "variant"),
    expectAiGatewayStart: optionalBodyBoolean(value, "expectAiGatewayStart"),
    dryRun: optionalBodyBoolean(value, "dryRun"),
  };
}

export function parseConversationSubmitRequest(body: Record<string, unknown>): ConversationSubmitRequest {
  const clientMessageId = bodyString(body, "clientMessageId");
  if (!clientMessageId) {
    throw new ApiError(400, "missing_client_message_id", "clientMessageId is required");
  }
  const origin = bodyString(body, "origin");
  if (!origin) {
    throw new ApiError(400, "invalid_payload", "origin is required");
  }
  const draftInput = body.draft;
  if (!isRecord(draftInput)) {
    throw new ApiError(400, "invalid_payload", "draft is required");
  }
  const mode = bodyString(draftInput, "mode");
  if (mode !== "prompt" && mode !== "shell") {
    throw new ApiError(400, "invalid_payload", "draft.mode must be prompt or shell");
  }
  const parts = draftInput.parts;
  if (parts !== undefined && !Array.isArray(parts)) {
    throw new ApiError(400, "invalid_payload", "draft.parts must be an array");
  }
  return {
    clientMessageId,
    origin,
    source: optionalBodyString(body, "source"),
    target: parseTarget(body.target),
    draft: {
      mode,
      text: typeof draftInput.text === "string" ? draftInput.text : "",
      resolvedText: optionalBodyString(draftInput, "resolvedText"),
      parts: Array.isArray(parts) ? parts : [],
      command: parseCommand(draftInput.command),
      attachments: parseAttachments(draftInput.attachments),
    },
    options: parseOptions(body.options),
  };
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (!isRecord(value)) return value;
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const next = value[key];
    if (next !== undefined) result[key] = stableJsonValue(next);
  }
  return result;
}

export function stableJsonStringify(value: unknown): string {
  return JSON.stringify(stableJsonValue(value));
}

export function createConversationSubmitRequestHash(request: ConversationSubmitRequest): string {
  const hashInput = {
    clientMessageId: request.clientMessageId,
    origin: request.origin,
    source: normalizeNullableText(request.source),
    target: {
      conversationId: normalizeNullableText(request.target?.conversationId),
      opencodeSessionId: normalizeNullableText(request.target?.opencodeSessionId),
      directory: normalizeNullableText(request.target?.directory),
      pendingClientSessionId: normalizeNullableText(request.target?.pendingClientSessionId),
    },
    draft: {
      mode: request.draft.mode,
      text: request.draft.text,
      resolvedText: request.draft.resolvedText ?? null,
      parts: request.draft.parts,
      command: request.draft.command ?? null,
      attachments: request.draft.attachments ?? [],
    },
    options: {
      sendNow: request.options?.sendNow === true,
      replaceMessageId: normalizeNullableText(request.options?.replaceMessageId),
      submitQueuePolicy: request.options?.submitQueuePolicy ?? null,
      model: request.options?.model ?? null,
      agent: normalizeNullableText(request.options?.agent),
      variant: normalizeNullableText(request.options?.variant),
      expectAiGatewayStart: request.options?.expectAiGatewayStart === true,
      dryRun: request.options?.dryRun === true,
    },
  };
  return createHash("sha256").update(stableJsonStringify(hashInput)).digest("hex");
}

export function conversationSubmitDraftIsEmpty(request: ConversationSubmitRequest): boolean {
  return !request.draft.text.trim() &&
    !request.draft.resolvedText?.trim() &&
    request.draft.parts.length === 0 &&
    !request.draft.command &&
    (request.draft.attachments?.length ?? 0) === 0;
}
