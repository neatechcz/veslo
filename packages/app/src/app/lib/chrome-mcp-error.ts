import type { Part } from "@opencode-ai/sdk/v2/client";

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
