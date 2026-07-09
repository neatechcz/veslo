import type { Part } from "@opencode-ai/sdk/v2/client";
import {
  partObjectField,
  partText,
  toolInputFromPart,
  toolNameFromPart,
} from "../../lib/opencode-part-access";
import { getBasename as basename } from "../../utils/workspace-path";
import { currentLocale, t } from "../../../i18n";
import { buildMediaEvidenceForParts, type MediaEvidence } from "./media-evidence-model.js";

export type TimelineSectionKind = "plan" | "explore" | "action" | "verify" | "issues";

export type TimelineRowType =
  | "plan"
  | "read"
  | "list"
  | "search"
  | "edit"
  | "write"
  | "task"
  | "skill"
  | "command"
  | "verify"
  | "issue"
  | "note"
  | "tool";

export type TimelineRowModel = {
  kind: TimelineSectionKind;
  rowType: TimelineRowType;
  primary: string;
  secondary?: string;
  status?: "done" | "running" | "error" | "pass";
  technicalDetail?: string;
  mediaEvidence?: MediaEvidence[];
};

export type TimelineSectionModel = {
  kind: TimelineSectionKind;
  title: string;
  summary: string;
  rows: TimelineRowModel[];
  status?: "done" | "running" | "error" | "pass";
};

export type TimelineDetailModel = {
  sections: TimelineSectionModel[];
  summary: string;
  latestLabel?: string;
};

type BuildTimelineDetailModelInput = {
  parts: Part[];
  latestLabel?: string;
  workspaceRoot?: string;
};

type BuildCollapsedSummaryInput = {
  sections: Array<Pick<TimelineSectionModel, "summary"> & Partial<Pick<TimelineSectionModel, "rows">>>;
  latestLabel?: string;
};

const EXPLORATION_TOOLS = new Set(["read", "glob", "grep", "search", "list", "list_files"]);
const ACTION_TOOLS = new Set(["edit", "write", "apply_patch", "task", "skill", "webfetch"]);
const VERIFY_TOOLS = new Set(["test", "lint", "build", "verify", "check"]);
const STRONG_TOOL_ERROR_PATTERNS = [
  /^session-error:/i,
  /\binvalid tool\b/i,
  /\bmodel tried to call\b/i,
  /\bunavailable tool\b/i,
  /\bunknown tool\b/i,
  /\btool not found\b/i,
] as const;

const SECTION_TITLE_KEYS: Record<TimelineSectionKind, string> = {
  plan: "timeline.section.plan",
  explore: "timeline.section.explore",
  action: "timeline.section.action",
  verify: "timeline.section.verify",
  issues: "timeline.section.issues",
};

type TimelineLocale = ReturnType<typeof currentLocale>;

function trForLocale(key: string, locale: TimelineLocale, replacements?: Record<string, string>): string {
  let value = t(key, locale);
  if (replacements) {
    for (const [placeholder, replacement] of Object.entries(replacements)) {
      value = value.replaceAll(`{${placeholder}}`, replacement);
    }
  }
  return value;
}

function tr(key: string, replacements?: Record<string, string>): string {
  return trForLocale(key, currentLocale(), replacements);
}

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function getToolName(part: Part): string {
  return toolNameFromPart(part).toLowerCase();
}

function getState(part: Part): Record<string, unknown> {
  return partObjectField(part, "state");
}

function getInput(part: Part): Record<string, unknown> {
  return toolInputFromPart(part);
}

function getStatus(part: Part): "done" | "running" | "error" | "pass" | undefined {
  const state = getState(part);
  const status = normalizeText(state.status).toLowerCase();
  if (status === "running" || status === "pending") return "running";
  if (status === "error" || status === "failed") return "error";
  if (status === "completed" || status === "done") return "done";
  return undefined;
}

function hasStrongToolErrorPayload(part: Part): boolean {
  if (part.type !== "tool") return false;
  const state = getState(part);
  if (normalizeText(state.error)) return true;

  const title = normalizeText(state.title);
  const detail = normalizeText(state.detail);
  const haystack = [title, detail].filter(Boolean).join("\n");
  if (!haystack) return false;
  return STRONG_TOOL_ERROR_PATTERNS.some((pattern) => pattern.test(haystack));
}

function isErrorPart(part: Part): boolean {
  const state = getState(part);
  const status = normalizeText(state.status).toLowerCase();
  if (status === "error" || status === "failed") return true;
  if (hasStrongToolErrorPayload(part)) return true;
  const text = normalizeText(partText(part));
  return text.toLowerCase().startsWith("session-error:");
}

function isExplicitPlanningText(part: Part): boolean {
  const text = normalizeText(partText(part));
  if (!text) return false;
  const firstLine = text.split(/\r?\n/, 1)[0].trim();
  return (
    /^#{0,3}\s*(?:plan|plán|planning|next steps|todo|objective|goals?)\b(?:\s*[:\-–—].*)?$/i.test(firstLine) ||
    /^#{0,3}\s*(?:plan|plán)\s*[:\-–—]\s*/i.test(firstLine)
  );
}

function isVerificationTool(toolName: string): boolean {
  return VERIFY_TOOLS.has(toolName);
}

function classifyPartKind(part: Part, previousKind?: TimelineSectionKind): TimelineSectionKind {
  if (isErrorPart(part)) return "issues";

  if (part.type === "reasoning" || part.type === "text") {
    if (isExplicitPlanningText(part)) return "plan";
    if (previousKind && previousKind !== "issues") return previousKind;
    return "action";
  }

  if (part.type !== "tool") {
    return previousKind && previousKind !== "issues" ? previousKind : "action";
  }

  const toolName = getToolName(part);
  if (isVerificationTool(toolName)) return "verify";
  if (EXPLORATION_TOOLS.has(toolName)) return "explore";
  if (ACTION_TOOLS.has(toolName)) return "action";
  if (toolName === "bash" || toolName === "shell" || toolName === "exec" || toolName === "command" || toolName === "run") {
    return "action";
  }
  return "action";
}

function toolInputText(input: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = input[key];
    const text = normalizeText(value);
    if (text) return text;
  }
  return "";
}

function toolOutputText(part: Part): string {
  const state = getState(part);
  const output = normalizeText(state.output);
  if (!output) return "";

  const lines = output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => !line.startsWith("<file>") && !line.startsWith("<path>") && !line.startsWith("<type>") && !line.startsWith("<content>") && !line.startsWith("</content>"));

  return lines[0] ?? "";
}

function formatReadPathHint(path: string): string {
  const normalized = path.trim().replace(/\\/g, "/").replace(/\/+/g, "/");
  if (!normalized) return "";
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length <= 3) return normalized;
  return segments.slice(-3).join("/");
}

function buildReadRow(part: Part): TimelineRowModel {
  const input = getInput(part);
  const path = toolInputText(input, ["filePath", "path", "file"]);
  const label = path ? basename(path) : tr("timeline.file_fallback");
  return {
    kind: "explore",
    rowType: "read",
    primary: tr("timeline.read_row", { label }),
    secondary: path ? formatReadPathHint(path) : undefined,
    technicalDetail: path || undefined,
    status: getStatus(part),
  };
}

function buildListRow(part: Part): TimelineRowModel {
  const input = getInput(part);
  const path = toolInputText(input, ["path"]);
  const label = path ? basename(path) : tr("timeline.files_fallback");
  return {
    kind: "explore",
    rowType: "list",
    primary: tr("timeline.list_row", { label }),
    secondary: path ? formatReadPathHint(path) : undefined,
    technicalDetail: path || undefined,
    status: getStatus(part),
  };
}

function buildSearchRow(part: Part): TimelineRowModel {
  const input = getInput(part);
  const pattern = toolInputText(input, ["pattern", "query"]);
  const path = toolInputText(input, ["path"]);
  return {
    kind: "explore",
    rowType: "search",
    primary: pattern ? tr("timeline.search_row", { pattern }) : tr("timeline.search_fallback"),
    secondary: path ? formatReadPathHint(path) : undefined,
    technicalDetail: pattern || path || undefined,
    status: getStatus(part),
  };
}

function buildWriteRow(part: Part, verb: string): TimelineRowModel {
  const input = getInput(part);
  const path = toolInputText(input, ["filePath", "path", "file"]);
  const label = path ? basename(path) : tr("timeline.file_fallback");
  return {
    kind: "action",
    rowType: verb === tr("timeline.edit_verb") ? "edit" : "write",
    primary: `${verb} ${label}`,
    secondary: path ? formatReadPathHint(path) : undefined,
    technicalDetail: path || undefined,
    status: getStatus(part),
  };
}

function buildTaskRow(part: Part): TimelineRowModel {
  const input = getInput(part);
  const description = toolInputText(input, ["description", "prompt", "title"]);
  const agentType = toolInputText(input, ["subagent_type", "name"]);
  const isSkill = getToolName(part) === "skill";

  return {
    kind: "action",
    rowType: isSkill ? "skill" : "task",
    primary: isSkill
      ? tr("timeline.loaded_skill_row", { label: agentType || tr("timeline.skill_fallback") })
      : tr("timeline.delegated_row", { label: description || tr("timeline.task_fallback") }),
    secondary: description ? description : agentType ? tr("timeline.agent_suffix", { agent: agentType }) : undefined,
    technicalDetail: description || agentType || undefined,
    status: getStatus(part),
  };
}

function buildBashRow(part: Part): TimelineRowModel {
  const input = getInput(part);
  const command = toolInputText(input, ["command", "cmd"]);
  const description = toolInputText(input, ["description", "title"]);
  const output = toolOutputText(part);
  const status = getStatus(part);
  const primary = description || (command ? tr("timeline.command_row", { command }) : tr("timeline.command_fallback"));
  const outcome =
    status === "error"
      ? output || tr("timeline.failed")
      : status === "running"
        ? tr("timeline.running")
        : output.startsWith("Success")
          ? output.match(/:\s*[MADR]\s+(.+)$/)?.[1] ?? tr("timeline.done")
          : output || tr("timeline.done");

  return {
    kind: "action",
    rowType: "command",
    primary,
    secondary: outcome,
    technicalDetail: command || description || undefined,
    status,
  };
}

function buildVerifyRow(part: Part): TimelineRowModel {
  const input = getInput(part);
  const command = toolInputText(input, ["command", "cmd"]);
  const description = toolInputText(input, ["description", "title"]);
  const output = toolOutputText(part);
  const status = getStatus(part);
  const primary = description || (command ? tr("timeline.verify_row", { command }) : tr("timeline.verify_fallback"));
  const secondary =
    status === "error"
      ? output || tr("timeline.failed")
      : status === "running"
        ? tr("timeline.running")
        : output || tr("timeline.done");

  return {
    kind: "verify",
    rowType: "verify",
    primary,
    secondary,
    technicalDetail: command || description || undefined,
    status,
  };
}

function buildGenericReasoningRow(part: Part, kind: TimelineSectionKind): TimelineRowModel {
  const text = normalizeText(partText(part));
  const clean = text.replace(/^session-error:\s*/i, "");
  const status = getStatus(part);
  if (kind === "issues") {
    return {
      kind,
      rowType: "issue",
      primary: tr("timeline.session_error"),
      secondary: clean || undefined,
      technicalDetail: text || undefined,
      status: "error",
    };
  }

  if (kind === "plan") {
    return {
      kind,
      rowType: "plan",
      primary: clean,
      secondary: undefined,
      technicalDetail: text || undefined,
      status: status ?? "done",
    };
  }

  return {
    kind,
    rowType: kind === "verify" ? "verify" : "note",
    primary: clean || tr("timeline.thinking"),
    secondary: undefined,
    technicalDetail: text || undefined,
    status,
  };
}

function buildRowModel(part: Part, kind: TimelineSectionKind): TimelineRowModel {
  if (kind === "issues") {
    return buildGenericReasoningRow(part, kind);
  }

  if (part.type === "reasoning" || part.type === "text") {
    return buildGenericReasoningRow(part, kind);
  }

  if (part.type !== "tool") {
    return buildGenericReasoningRow(part, kind);
  }

  const toolName = getToolName(part);
  const normalized = normalizeText(toolName);

  if (toolName === "read") return buildReadRow(part);
  if (toolName === "list" || toolName === "list_files") return buildListRow(part);
  if (toolName === "grep" || toolName === "glob" || toolName === "search") return buildSearchRow(part);
  if (toolName === "edit") return buildWriteRow(part, tr("timeline.edit_verb"));
  if (toolName === "write" || toolName === "apply_patch") return buildWriteRow(part, tr("timeline.write_verb"));
  if (toolName === "task" || toolName === "skill") return buildTaskRow(part);
  if (kind === "verify") return buildVerifyRow(part);
  if (toolName === "bash" || toolName === "shell" || toolName === "exec" || toolName === "command" || toolName === "run") {
    return buildBashRow(part);
  }

  const input = getInput(part);
  const title = normalized ? tr("timeline.generic_tool_row", { tool: normalized }) : tr("timeline.generic_tool_fallback");
  const raw = toolInputText(input, ["command", "cmd", "path", "filePath", "pattern", "query", "description", "name"]);

  return {
    kind,
    rowType: "tool",
    primary: title,
    secondary: raw ? basename(raw) : undefined,
    technicalDetail: raw || undefined,
    status: getStatus(part),
  };
}

function normalizeStaleRunningReasoningRow(
  row: TimelineRowModel,
  part: Part,
  index: number,
  total: number,
): TimelineRowModel {
  if (row.status !== "running") return row;
  if (index >= total - 1) return row;
  if (part.type !== "reasoning" && part.type !== "text") return row;
  return { ...row, status: "done" };
}

function sectionStatusFromRows(rows: TimelineRowModel[], kind: TimelineSectionKind): TimelineSectionModel["status"] {
  if (rows.some((row) => row.status === "error")) return "error";
  if (rows.some((row) => row.status === "running")) return "running";
  if (kind === "verify" && rows.length > 0) return "pass";
  return rows.length > 0 ? "done" : undefined;
}

function countRows(rows: TimelineRowModel[], kinds: readonly TimelineRowType[]) {
  const set = new Set(kinds);
  return rows.filter((row) => set.has(row.rowType)).length;
}

function countMediaEvidence(rows: TimelineRowModel[], kind: MediaEvidence["kind"]): number {
  return rows.reduce(
    (total, row) => total + (row.mediaEvidence ?? []).filter((item) => item.kind === kind).length,
    0,
  );
}

function summarizeMediaEvidenceCount(count: number, kind: MediaEvidence["kind"], locale: TimelineLocale = currentLocale()): string {
  if (count <= 0) return "";
  if (kind === "created") {
    return trForLocale(count === 1 ? "session.media_evidence_image_created_one" : "session.media_evidence_image_created_other", locale, {
      count: String(count),
    });
  }
  return trForLocale(count === 1 ? "session.media_evidence_image_analyzed_one" : "session.media_evidence_image_analyzed_other", locale, {
    count: String(count),
  });
}

function summaryLooksEnglish(value: string): boolean {
  return /\b(?:action|actions|file|files|image|images|issue|issues|list|lists|search|searches|verification)\b/i.test(value);
}

function mediaEvidenceSummaryLocale(summaries: string[]): TimelineLocale {
  const locale = currentLocale();
  if (locale === "en") return locale;
  return summaries.some(summaryLooksEnglish) ? "en" : locale;
}

function summarizeSection(kind: TimelineSectionKind, rows: TimelineRowModel[]): string {
  if (!rows.length) return "";

  switch (kind) {
    case "plan": {
      const plans = countRows(rows, ["plan"]);
      return plans === 1 ? tr("timeline.plan_ready") : tr("timeline.plan_steps", { count: String(plans) });
    }
    case "explore": {
      const files = countRows(rows, ["read"]);
      const searches = countRows(rows, ["search"]);
      const lists = countRows(rows, ["list"]);
      const items: string[] = [];
      if (files > 0) {
        items.push(
          tr(files === 1 ? "timeline.explore_file_one" : files >= 2 && files <= 4 ? "timeline.explore_file_few" : "timeline.explore_file_other", {
            count: String(files),
          }),
        );
      }
      if (searches > 0) items.push(tr("timeline.explore_search", { count: String(searches) }));
      if (lists > 0) items.push(tr(lists === 1 ? "timeline.explore_list_one" : "timeline.explore_list_other", { count: String(lists) }));
      return items.length > 0 ? items.join(" · ") : tr("timeline.explore_generic", { count: String(rows.length) });
    }
    case "action": {
      const actions = countRows(rows, ["edit", "write", "task", "skill", "command", "tool", "note"]);
      return actions === 1 ? tr("timeline.action_one") : tr("timeline.action_other", { count: String(actions) });
    }
    case "verify":
      return countRows(rows, ["verify"]) > 0 && rows.some((row) => row.status === "error")
        ? tr("timeline.verify_failed")
        : rows.some((row) => row.status === "running")
          ? tr("timeline.verify_running")
          : tr("timeline.verify_ok");
    case "issues": {
      const issues = countRows(rows, ["issue"]);
      return issues === 1 ? tr("timeline.issue_one") : tr("timeline.issue_other", { count: String(issues) });
    }
  }
}

function summarizeLatestLabel(sections: TimelineSectionModel[]): string | undefined {
  for (let i = sections.length - 1; i >= 0; i -= 1) {
    const section = sections[i];
    const row = section.rows.at(-1);
    if (!row) continue;
    const label = normalizeText(row.secondary || row.primary || row.technicalDetail);
    if (!label) continue;
    return label;
  }
  return undefined;
}

export function buildCollapsedSummary(input: BuildCollapsedSummaryInput): string {
  const summaries = input.sections.map((section) => normalizeText(section.summary)).filter(Boolean);
  const rows = input.sections.flatMap((section) => section.rows ?? []);
  const mediaSummaryLocale = mediaEvidenceSummaryLocale(summaries);
  const createdImages = summarizeMediaEvidenceCount(countMediaEvidence(rows, "created"), "created", mediaSummaryLocale);
  const analyzedImages = summarizeMediaEvidenceCount(countMediaEvidence(rows, "analyzed"), "analyzed", mediaSummaryLocale);
  const items = [...summaries, createdImages, analyzedImages].filter(Boolean);
  const base = items.join(" · ");
  if (input.latestLabel && summaries.length <= 1) {
    const latest = tr("timeline.latest_label", { label: input.latestLabel });
    return base ? `${base} · ${latest}` : latest;
  }
  return base;
}

export function buildTimelineDetailModel(input: BuildTimelineDetailModelInput): TimelineDetailModel {
  const parts = input.parts ?? [];
  const sections: TimelineSectionModel[] = [];
  let current: TimelineSectionModel | null = null;
  let previousKind: TimelineSectionKind | undefined;

  const appendSection = (kind: TimelineSectionKind, row: TimelineRowModel) => {
    if (!current || current.kind !== kind) {
      current = {
        kind,
        title: tr(SECTION_TITLE_KEYS[kind]),
        summary: "",
        rows: [],
      };
      sections.push(current);
    }

    current.rows.push(row);
    current.status = sectionStatusFromRows(current.rows, current.kind);
    current.summary = summarizeSection(current.kind, current.rows);
  };

  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const kind = classifyPartKind(part, previousKind);
    const baseRow = normalizeStaleRunningReasoningRow(buildRowModel(part, kind), part, index, parts.length);
    const mediaEvidence = buildMediaEvidenceForParts({
      parts: [part],
      sourceId: `${part.type}:${index}`,
      workspaceRoot: input.workspaceRoot,
    });
    const row = mediaEvidence.length > 0 ? { ...baseRow, mediaEvidence } : baseRow;
    appendSection(kind, row);
    previousKind = kind;
  }

  for (const section of sections) {
    section.status = sectionStatusFromRows(section.rows, section.kind);
    section.summary = summarizeSection(section.kind, section.rows);
  }

  const latestLabel = input.latestLabel ?? summarizeLatestLabel(sections);
  return {
    sections,
    summary: buildCollapsedSummary({
      sections,
      latestLabel,
    }),
    latestLabel,
  };
}
