import type { Part } from "@opencode-ai/sdk/v2/client";
import type { ArtifactItem, MessageWithParts } from "../types";
import { isVesloInternalSubagentType } from "../lib/internal-subagents";

/** Classify a tool name into a semantic category for icon selection */
export function classifyTool(toolName: string): "read" | "edit" | "write" | "search" | "terminal" | "glob" | "task" | "skill" | "tool" {
  const lower = toolName.toLowerCase();
  if (lower === "skill") return "skill";
  if (lower.includes("read") || lower.includes("cat") || lower.includes("fetch")) return "read";
  if (lower === "apply_patch") return "write";
  if (lower.includes("edit") || lower.includes("replace") || lower.includes("update")) return "edit";
  if (lower.includes("write") || lower.includes("create") || lower.includes("patch")) return "write";
  if (lower.includes("grep") || lower.includes("search") || lower.includes("find")) return "search";
  if (lower.includes("bash") || lower.includes("shell") || lower.includes("exec") || lower.includes("command") || lower.includes("run")) return "terminal";
  if (lower.includes("glob") || lower.includes("list") || lower.includes("ls")) return "glob";
  if (lower.includes("task") || lower.includes("agent") || lower.includes("todo")) return "task";
  return "tool";
}

/** Extract a clean filename from a file path */
function extractFilename(filePath: string): string {
  const parts = filePath.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || filePath;
}

function normalizeStepText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function cleanReasoningText(value: string): string {
  return value
    .replace(/\[REDACTED\]/g, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function truncateStepText(value: string, max = 80): string {
  return value.length > max ? `${value.slice(0, Math.max(0, max - 3))}...` : value;
}

function isPathLike(value: string): boolean {
  return /^(?:[A-Za-z]:[\\/]|~[\\/]|\/|\.\.?[\\/])/.test(value) || /[\\/]/.test(value);
}

function normalizePathToken(value: string): string {
  const clean = value.trim().replace(/^[`'"([{]+|[`'"\])},.;:]+$/g, "");
  if (!isPathLike(clean)) return clean;
  return extractFilename(clean);
}

function formatAgentLabel(value: string): string {
  const clean = value.trim().replace(/[_-]+/g, " ");
  if (!clean) return "";
  return clean
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function getToolInput(state: any): Record<string, unknown> {
  const input = state?.input;
  if (input && typeof input === "object") return input as Record<string, unknown>;
  return {};
}

function pickInputText(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    const text = normalizeStepText(value);
    if (text) return text;
  }
  return "";
}

function buildToolTitle(state: any, toolName: string): string {
  const lower = toolName.toLowerCase();
  const input = getToolInput(state);
  const pick = (...keys: string[]) => pickInputText(input, keys);
  const file = (...keys: string[]) => {
    const value = pick(...keys);
    if (!value) return "";
    return normalizePathToken(value);
  };

  if (lower === "read") {
    const target = file("filePath", "path", "file");
    return target ? `Read ${target}` : "Read file";
  }

  if (lower === "edit") {
    const target = file("filePath", "path", "file");
    return target ? `Edit ${target}` : "Edit file";
  }

  if (lower === "write") {
    const target = file("filePath", "path", "file");
    return target ? `Write ${target}` : "Write file";
  }

  if (lower === "apply_patch") {
    return "Apply patch";
  }

  if (lower === "list" || lower === "list_files") {
    const target = file("path");
    return target ? `List ${target}` : "List files";
  }

  if (lower === "grep" || lower === "glob" || lower === "search") {
    const pattern = pick("pattern", "query");
    return pattern ? `Search ${truncateStepText(pattern, 44)}` : "Search code";
  }

  if (lower === "bash") {
    const description = pick("description");
    if (description) return truncateStepText(description, 56);
    const command = pick("command", "cmd");
    if (command) return truncateStepText(`Run ${command}`, 56);
    return "Run command";
  }

  if (lower === "task") {
    const rawAgent = pick("subagent_type");
    if (isVesloInternalSubagentType(rawAgent)) return "Internal processing";
    const agent = formatAgentLabel(rawAgent);
    if (agent) return `${agent} task`;
    return "Task";
  }

  if (lower === "webfetch") {
    const url = pick("url");
    return url ? `Fetch ${truncateStepText(url, 44)}` : "Fetch web page";
  }

  if (lower === "skill") {
    const name = pick("name");
    return name ? `Load skill ${name}` : "Load skill";
  }

  const stateTitle = normalizeStepText(state?.title);
  if (stateTitle) {
    return truncateStepText(isPathLike(stateTitle) ? normalizePathToken(stateTitle) : stateTitle, 56);
  }

  const fallback = normalizeStepText(toolName).replace(/[_-]+/g, " ");
  return fallback || "Tool";
}

/** Build a concise detail line for a tool call — avoids dumping raw output */
function buildToolDetail(state: any, toolName: string): string | undefined {
  const lower = toolName.toLowerCase();
  const input = getToolInput(state);
  const pick = (...keys: string[]) => pickInputText(input, keys);

  if (lower === "read") {
    const chunks: string[] = [];
    const offset = input.offset;
    const limit = input.limit;
    if (typeof offset === "number") chunks.push(`offset ${offset}`);
    if (typeof limit === "number") chunks.push(`limit ${limit}`);
    if (chunks.length > 0) return chunks.join(" - ");
    return undefined;
  }

  if (lower === "bash") {
    const command = pick("command", "cmd");
    if (command) return truncateStepText(command, 80);
  }

  if (lower === "grep" || lower === "glob" || lower === "search") {
    const root = pick("path");
    if (root) return `in ${normalizePathToken(root)}`;
  }

  if (lower === "task") {
    const rawAgent = pick("subagent_type");
    if (isVesloInternalSubagentType(rawAgent)) {
      return "processing request";
    }
    const description = pick("description");
    if (description) return truncateStepText(description, 80);
    const agent = formatAgentLabel(rawAgent);
    if (agent) return `${agent} agent`;
  }

  if (lower === "webfetch") {
    const url = pick("url");
    if (url) return truncateStepText(url, 80);
  }

  // For file operations, show the filename
  const filePath = state?.path ?? state?.file;
  if (typeof filePath === "string" && filePath.trim()) {
    const name = extractFilename(filePath.trim());
    const status = state?.status;
    if (status === "completed" || status === "done") {
      return name;
    }
    return name;
  }

  // For edits that report updated files, show filename(s)
  const files = state?.files;
  if (Array.isArray(files) && files.length > 0) {
    const names = files.filter((f: any) => typeof f === "string").map(extractFilename);
    if (names.length === 1) return names[0];
    if (names.length > 1) return `${names[0]} +${names.length - 1} more`;
  }

  // For bash/terminal commands, show the command
  const command = state?.command ?? state?.cmd;
  if (typeof command === "string" && command.trim()) {
    const clean = command.trim();
    return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
  }

  // For search/grep, show the pattern
  const pattern = state?.pattern ?? state?.query;
  if (typeof pattern === "string" && pattern.trim()) {
    return `"${pattern.trim().length > 60 ? pattern.trim().slice(0, 57) + "..." : pattern.trim()}"`;
  }

  // Subtitle/detail from state as fallback
  const subtitle = state?.subtitle ?? state?.detail ?? state?.summary;
  if (typeof subtitle === "string" && subtitle.trim()) {
    const clean = subtitle.trim();
    return clean.length > 80 ? `${clean.slice(0, 77)}...` : clean;
  }

  // For completed tools with output, show a very short summary
  const outputRaw = typeof state?.output === "string" ? state.output.trim() : "";
  if (outputRaw) {
    if (lower === "read") return undefined;

    const output = outputRaw.length > 3000 ? outputRaw.slice(0, 3000) : outputRaw;

    // Extract just the first meaningful line (skip line numbers and raw file markers)
    const lines = output.split("\n").filter((l: string) => {
      const trimmed = l.trim();
      return (
        trimmed &&
        !trimmed.startsWith("<file>") &&
        !trimmed.startsWith("<path>") &&
        !trimmed.startsWith("<type>") &&
        !trimmed.startsWith("<content>") &&
        !trimmed.startsWith("</content>") &&
        !/^\d{5}\|/.test(trimmed) &&
        !/^\d+:\s/.test(trimmed)
      );
    });
    if (lines.length > 0) {
      const first = lines[0].trim();
      if (first.startsWith("Success")) {
        // "Success. Updated the following files: M foo.ts" -> "foo.ts"
        const match = first.match(/:\s*[MADR]\s+(.+)/);
        if (match) return extractFilename(match[1].trim());
        return "Done";
      }
      return first.length > 80 ? `${first.slice(0, 77)}...` : first;
    }
  }

  return undefined;
}

export function summarizeStep(part: Part): { title: string; detail?: string; isSkill?: boolean; skillName?: string; toolCategory?: string; status?: string } {
  if (part.type === "tool") {
    const record = part as any;
    const toolName = record.tool ? String(record.tool) : "Tool";
    const state = record.state ?? {};
    const title = buildToolTitle(state, toolName);
    const category = classifyTool(toolName);
    const status = state.status ? String(state.status) : undefined;
    const detail = buildToolDetail(state, toolName);
    const normalizedTitle = normalizeStepText(title).toLowerCase();
    const finalDetail = detail && normalizeStepText(detail).toLowerCase() !== normalizedTitle ? detail : undefined;

    // Detect skill trigger
    if (category === "skill") {
      const skillName = state.metadata?.name || title.replace(/^(Loaded skill:\s*|Load skill\s+)/i, "");
      return { title, isSkill: true, skillName, detail: finalDetail, toolCategory: category, status };
    }

    return { title, detail: finalDetail, toolCategory: category, status };
  }

  if (part.type === "reasoning") {
    const record = part as any;
    const text = typeof record.text === "string" ? cleanReasoningText(record.text) : "";
    if (!text) return { title: "Thinking", toolCategory: "tool" };

    const lines = text
      .split(/\r?\n/)
      .map((line: string) => line.trim())
      .filter(Boolean);
    const compact = lines.join(" ");

    let headline = "";
    let detail = "";
    if (lines.length > 1) {
      headline = lines[0];
      detail = lines.slice(1).join("\n");
    } else {
      const sentenceBreak = compact.indexOf(". ");
      if (sentenceBreak > 18 && sentenceBreak < 120) {
        headline = compact.slice(0, sentenceBreak + 1).trim();
        detail = compact.slice(sentenceBreak + 2).trim();
      } else {
        headline = compact;
        detail = compact;
      }
    }

    headline = headline.replace(/^thinking[:\s-]*/i, "").trim();
    const title = `Thinking: ${truncateStepText(headline || "reviewing context", 96)}`;
    return { title, detail: detail || undefined, toolCategory: "tool" };
  }

  if (part.type === "step-start" || part.type === "step-finish") {
    const reason = (part as any).reason;
    return {
      title: part.type === "step-start" ? "Step started" : "Step finished",
      detail: reason ? String(reason) : undefined,
      toolCategory: "tool",
    };
  }

  return { title: "Step", toolCategory: "tool" };
}

const ARTIFACT_PATH_PATTERN =
  /(?:^|[\s"'`([{])((?:[a-zA-Z]:[/\\]|\.{1,2}[/\\]|~[/\\]|[/\\])[\w./\\\-]*\.[a-z][a-z0-9]{0,9}|[\w.\-]+[/\\][\w./\\\-]*\.[a-z][a-z0-9]{0,9})/gi;
const ARTIFACT_OUTPUT_SCAN_LIMIT = 4000;
const ARTIFACT_OUTPUT_SKIP_TOOLS = new Set(["webfetch"]);

// Patterns that indicate a path is a truncated system/absolute path rather than a workspace-relative path
const TRUNCATED_SYSTEM_PATH_PATTERNS = [
  /com\.[^/]+\.(veslo|opencode)/i, // macOS app bundle identifiers
  /\.veslo\.dev\//i, // Veslo dev paths
  /Application Support\//i, // macOS Application Support
  /AppData[/\\]/i, // Windows AppData
  /\.local\/share\//i, // Linux XDG data
  /workspaces\/[^/]+\/workspaces\//i, // Nested workspaces paths (clearly malformed)
];

/**
 * Clean up an artifact path to extract the workspace-relative portion.
 * Returns null if the path should be rejected entirely.
 */
function cleanArtifactPath(rawPath: string): string | null {
  const normalized = rawPath.trim().replace(/[\\/]+/g, "/");
  if (!normalized) return null;

  // Check if this looks like a truncated system path
  for (const pattern of TRUNCATED_SYSTEM_PATH_PATTERNS) {
    if (pattern.test(normalized)) {
      // Try to extract just the relative part after "workspaces/<name>/"
      const workspacesMatch = normalized.match(/workspaces\/[^/]+\/(.+)$/i);
      if (workspacesMatch && workspacesMatch[1]) {
        const relative = workspacesMatch[1];
        // Validate the extracted path doesn't still contain system patterns
        if (!TRUNCATED_SYSTEM_PATH_PATTERNS.some((p) => p.test(relative))) {
          return relative;
        }
      }
      // Reject the path entirely if we can't extract a clean relative path
      return null;
    }
  }

  return normalized;
}

type DeriveArtifactsOptions = {
  maxMessages?: number;
};

export function deriveArtifacts(list: MessageWithParts[], options: DeriveArtifactsOptions = {}): ArtifactItem[] {
  const results = new Map<string, ArtifactItem>();
  const maxMessages =
    typeof options.maxMessages === "number" && Number.isFinite(options.maxMessages) && options.maxMessages > 0
      ? Math.floor(options.maxMessages)
      : null;
  const source = maxMessages && list.length > maxMessages ? list.slice(list.length - maxMessages) : list;

  source.forEach((message) => {
    const messageId = String((message.info as any)?.id ?? "");

    message.parts.forEach((part) => {
      if (part.type !== "tool") return;
      const record = part as any;
      const state = record.state ?? {};
      const matches = new Set<string>();

      const explicit = [
        state.path,
        state.file,
        ...(Array.isArray(state.files) ? state.files : []),
      ];

      explicit.forEach((f) => {
        if (typeof f === "string") {
          const trimmed = f.trim();
          if (
            trimmed.length > 0 &&
            trimmed.length <= 500 &&
            trimmed.includes(".") &&
            !/^\.{2,}$/.test(trimmed)
          ) {
            matches.add(trimmed);
          }
        }
      });

      const toolName =
        typeof record.tool === "string" && record.tool.trim()
          ? record.tool.trim().toLowerCase()
          : "";
      const titleText = typeof state.title === "string" ? state.title : "";
      const outputText =
        typeof state.output === "string" && !ARTIFACT_OUTPUT_SKIP_TOOLS.has(toolName)
          ? state.output.slice(0, ARTIFACT_OUTPUT_SCAN_LIMIT)
          : "";

      const text = [titleText, outputText]
        .filter((v): v is string => Boolean(v))
        .join(" ");

      if (text) {
        ARTIFACT_PATH_PATTERN.lastIndex = 0;
        Array.from(text.matchAll(ARTIFACT_PATH_PATTERN))
          .map((m) => m[1])
          .filter((f) => f && f.length <= 500)
          .forEach((f) => matches.add(f));
      }

      if (matches.size === 0) return;

      matches.forEach((match) => {
        const cleanedPath = cleanArtifactPath(match);
        if (!cleanedPath) return;

        const key = cleanedPath.toLowerCase();
        const name = cleanedPath.split("/").pop() ?? cleanedPath;
        const id = `artifact-${encodeURIComponent(cleanedPath)}`;

        // Delete and re-add to move to end (most recent)
        if (results.has(key)) results.delete(key);
        results.set(key, {
          id,
          name,
          path: cleanedPath,
          kind: "file" as const,
          size: state.size ? String(state.size) : undefined,
          messageId: messageId || undefined,
        });
      });
    });
  });

  return Array.from(results.values());
}

export function deriveWorkingFiles(items: ArtifactItem[]): string[] {
  const results: string[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const rawKey = item.path ?? item.name;
    const normalizedPath = rawKey.trim().replace(/[\\/]+/g, "/");
    const normalizedKey = normalizedPath.toLowerCase();
    if (!normalizedPath || seen.has(normalizedKey)) continue;
    seen.add(normalizedKey);
    results.push(normalizedPath);
    if (results.length >= 5) break;
  }

  return results;
}
