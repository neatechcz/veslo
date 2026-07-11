import type { Part } from "@opencode-ai/sdk/v2/client";
import { toolNameFromPart, toolStateFromPart } from "./opencode-part-access";

const CHROME_TOOL_PREFIXES = ["chrome-devtools_", "control-chrome_", "chrome_"];
const PROFILE_CONFLICT_PATTERNS = [
  "the browser is already running for",
  "use --isolated to run multiple browser instances",
];

const readString = (value: unknown) => (typeof value === "string" ? value.trim() : "");
const readLooseText = (value: unknown) => {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (!value) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
};

const isChromeTool = (toolName: string) => {
  const lower = toolName.toLowerCase();
  return CHROME_TOOL_PREFIXES.some((prefix) => lower.startsWith(prefix));
};

const hasProfileConflictSignature = (value: string) => {
  const haystack = value.toLowerCase();
  return PROFILE_CONFLICT_PATTERNS.every((pattern) => haystack.includes(pattern));
};

const terminalStatuses = new Set([
  "completed",
  "done",
  "success",
  "failed",
  "error",
  "cancelled",
  "canceled",
]);

export type ChromeMcpToolTraceDiagnostics = {
  tool: string;
  toolCallId: string;
  status: string;
  terminal: boolean;
  hasOutput: boolean;
  hasError: boolean;
  errorKind: "none" | "profile-conflict" | "timeout" | "connection" | "launch" | "protocol" | "unknown";
  errorCode: string | null;
  detailLength: number;
  errorFingerprint: string | null;
};

const safeErrorCode = (value: unknown): string | null => {
  const code = readString(value);
  return /^[a-z0-9_.-]{1,80}$/i.test(code) ? code : null;
};

const shortFingerprint = (value: string): string | null => {
  const normalized = value.trim();
  if (!normalized) return null;
  let hash = 0x811c9dc5;
  for (let index = 0; index < normalized.length; index += 1) {
    hash ^= normalized.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const errorKindForDetail = (detail: string, hasError: boolean): ChromeMcpToolTraceDiagnostics["errorKind"] => {
  if (!hasError) return "none";
  const normalized = detail.toLowerCase();
  if (hasProfileConflictSignature(normalized)) return "profile-conflict";
  if (/timeout|timed out|deadline exceeded/.test(normalized)) return "timeout";
  if (/econnrefused|connection refused|connect econn|socket|network|websocket/.test(normalized)) return "connection";
  if (/launch|executable|spawn|browser.*(not running|not found)/.test(normalized)) return "launch";
  if (/protocol|cdp|devtools/.test(normalized)) return "protocol";
  return "unknown";
};

/** Safe telemetry only: never returns output, URLs, or error detail text. */
export function chromeMcpToolTraceDiagnostics(part: Part): ChromeMcpToolTraceDiagnostics | null {
  if (!isChromeMcpTool(part)) return null;
  const record = part as Part & { callID?: unknown; callId?: unknown; toolCallId?: unknown };
  const state = toolStateFromPart(part);
  const tool = toolNameFromPart(part).trim();
  const status = readString(state.status).toLowerCase() || "unknown";
  const output = readLooseText(state.output);
  const detail = [
    readLooseText(state.error),
    readLooseText(state.detail),
    readLooseText(state.title),
    readLooseText(state.summary),
    readLooseText(state.subtitle),
    status === "error" || status === "failed" ? output : "",
  ].filter(Boolean).join("\n");
  const hasError = Boolean(detail) || status === "error" || status === "failed";
  const errorRecord = state.error && typeof state.error === "object" && !Array.isArray(state.error)
    ? state.error as Record<string, unknown>
    : null;
  const toolCallId =
    readString(record.callID) || readString(record.callId) || readString(record.toolCallId) || part.id;

  return {
    tool,
    toolCallId,
    status,
    terminal: terminalStatuses.has(status),
    hasOutput: Boolean(output),
    hasError,
    errorKind: errorKindForDetail(detail, hasError),
    errorCode: safeErrorCode(errorRecord?.code) ?? safeErrorCode(state.code),
    detailLength: detail.length,
    errorFingerprint: hasError ? shortFingerprint(detail || status) : null,
  };
}

export function isChromeMcpTool(part: Part): boolean {
  if (part.type !== "tool") return false;
  const record = part as Part & { tool?: unknown };
  const toolName = readString(record.tool);
  return Boolean(toolName && isChromeTool(toolName));
}

export function detectChromeMcpCompletedError(part: Part): string | null {
  if (!isChromeMcpTool(part)) return null;

  const record = part as Part & { tool?: unknown; state?: Record<string, unknown> };
  const toolName = readString(record.tool);
  if (!toolName) return null;

  const state = record.state ?? {};
  const status = readString(state.status).toLowerCase();
  if (status !== "completed") return null;

  const detail = readString(state.detail);
  const output = readLooseText(state.output);
  const title = readString(state.title);
  const summary = readString(state.summary);
  const subtitle = readString(state.subtitle);
  const combined = [detail, output, title, summary, subtitle].filter(Boolean).join("\n");
  if (!combined || !hasProfileConflictSignature(combined)) return null;

  // Keep the original engine detail so users can act on exact remediation hints.
  return `Chrome MCP failed: ${detail || output || title || summary || subtitle}`;
}
