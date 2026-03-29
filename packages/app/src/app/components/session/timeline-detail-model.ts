import type { Part } from "@opencode-ai/sdk/v2/client";

export type TimelineSectionKind = "plan" | "explore" | "action" | "verify" | "issues";

export type TimelineRowModel = {
  kind: TimelineSectionKind;
  primary: string;
  secondary?: string;
  status?: "done" | "running" | "error" | "pass";
  technicalDetail?: string;
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
};

type BuildCollapsedSummaryInput = {
  sections: Array<Pick<TimelineSectionModel, "summary">>;
  latestLabel?: string;
};

const EXPLORATION_TOOLS = new Set(["read", "glob", "grep", "search", "list", "list_files"]);
const ACTION_TOOLS = new Set(["edit", "write", "apply_patch", "task", "skill", "webfetch"]);
const VERIFY_TOOLS = new Set(["test", "lint", "build", "verify", "check"]);

const SECTION_TITLES: Record<TimelineSectionKind, string> = {
  plan: "Plan",
  explore: "Explore",
  action: "Action",
  verify: "Verify",
  issues: "Issues",
};

function normalizeText(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim();
}

function basename(value: string): string {
  const normalized = value.trim().replace(/\\/g, "/");
  const parts = normalized.split("/").filter(Boolean);
  return parts[parts.length - 1] ?? normalized;
}

function getToolName(part: Part): string {
  return typeof (part as any).tool === "string" ? String((part as any).tool).toLowerCase() : "";
}

function getState(part: Part): Record<string, unknown> {
  const state = (part as any).state;
  return state && typeof state === "object" ? (state as Record<string, unknown>) : {};
}

function getInput(part: Part): Record<string, unknown> {
  const state = getState(part);
  const input = state.input;
  return input && typeof input === "object" ? (input as Record<string, unknown>) : {};
}

function getStatus(part: Part): "done" | "running" | "error" | "pass" | undefined {
  const state = getState(part);
  const status = normalizeText(state.status).toLowerCase();
  if (status === "running" || status === "pending") return "running";
  if (status === "error" || status === "failed") return "error";
  if (status === "completed" || status === "done") return "done";
  return undefined;
}

function isErrorPart(part: Part): boolean {
  const state = getState(part);
  const status = normalizeText(state.status).toLowerCase();
  if (status === "error" || status === "failed") return true;
  const text = normalizeText((part as any).text);
  return text.toLowerCase().startsWith("session-error:");
}

function isPlanningText(part: Part): boolean {
  const text = normalizeText((part as any).text);
  if (!text) return false;
  const lower = text.toLowerCase();
  return (
    lower.startsWith("plan:") ||
    lower.startsWith("plán:") ||
    lower.startsWith("plan ") ||
    lower.startsWith("plán ") ||
    /\b(first|next|then|after that|finally|let's|we will|i will|i'm going to|we're going to)\b/i.test(text)
  );
}

function isVerificationTool(toolName: string): boolean {
  return VERIFY_TOOLS.has(toolName);
}

function classifyPartKind(part: Part, previousKind?: TimelineSectionKind): TimelineSectionKind {
  if (isErrorPart(part)) return "issues";

  if (part.type === "reasoning" || part.type === "text") {
    if (isPlanningText(part)) return "plan";
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

function buildReadRow(part: Part): TimelineRowModel {
  const input = getInput(part);
  const path = toolInputText(input, ["filePath", "path", "file"]);
  const label = path ? basename(path) : "soubor";
  return {
    kind: "explore",
    primary: `Načetl ${label}`,
    secondary: path ? `v ${label}` : undefined,
    technicalDetail: path || undefined,
    status: getStatus(part),
  };
}

function buildListRow(part: Part): TimelineRowModel {
  const input = getInput(part);
  const path = toolInputText(input, ["path"]);
  const label = path ? basename(path) : "soubory";
  return {
    kind: "explore",
    primary: `Vypsal ${label}`,
    secondary: path ? `v ${path}` : undefined,
    technicalDetail: path || undefined,
    status: getStatus(part),
  };
}

function buildSearchRow(part: Part): TimelineRowModel {
  const input = getInput(part);
  const pattern = toolInputText(input, ["pattern", "query"]);
  const path = toolInputText(input, ["path"]);
  const secondary = path ? `v ${basename(path)}` : undefined;
  return {
    kind: "explore",
    primary: pattern ? `Vyhledal "${pattern}"` : "Vyhledal",
    secondary,
    technicalDetail: pattern || path || undefined,
    status: getStatus(part),
  };
}

function buildWriteRow(part: Part, verb: string): TimelineRowModel {
  const input = getInput(part);
  const path = toolInputText(input, ["filePath", "path", "file"]);
  const label = path ? basename(path) : "soubor";
  return {
    kind: "action",
    primary: `${verb} ${label}`,
    secondary: path ? `v ${label}` : undefined,
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
    primary: isSkill ? `Načetl skill ${agentType || "skill"}` : `Delegoval ${description || "úlohu"}`,
    secondary: description ? description : agentType ? `${agentType} agent` : undefined,
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
  const primary = description || (command ? `Spustil ${command}` : "Spustil příkaz");
  const outcome =
    status === "error"
      ? output || "selhalo"
      : status === "running"
        ? "běží"
        : output.startsWith("Success")
          ? output.match(/:\s*[MADR]\s+(.+)$/)?.[1] ?? "hotovo"
          : output || "hotovo";

  return {
    kind: "action",
    primary,
    secondary: outcome,
    technicalDetail: command || description || undefined,
    status,
  };
}

function buildGenericReasoningRow(part: Part, kind: TimelineSectionKind): TimelineRowModel {
  const text = normalizeText((part as any).text);
  const clean = text.replace(/^session-error:\s*/i, "");
  const status = getStatus(part);
  if (kind === "issues") {
    return {
      kind,
      primary: "Chyba relace",
      secondary: clean || undefined,
      technicalDetail: text || undefined,
      status: "error",
    };
  }

  if (kind === "plan") {
    return {
      kind,
      primary: clean,
      secondary: undefined,
      technicalDetail: text || undefined,
      status: status ?? "done",
    };
  }

  return {
    kind,
    primary: clean || "Poznámka",
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
  if (toolName === "edit") return buildWriteRow(part, "Upravil");
  if (toolName === "write" || toolName === "apply_patch") return buildWriteRow(part, "Zapsal");
  if (toolName === "task" || toolName === "skill") return buildTaskRow(part);
  if (toolName === "bash" || toolName === "shell" || toolName === "exec" || toolName === "command" || toolName === "run") {
    return buildBashRow(part);
  }

  const input = getInput(part);
  const title = normalized ? `Provedl ${normalized}` : "Provedl krok";
  const raw = toolInputText(input, ["command", "cmd", "path", "filePath", "pattern", "query", "description", "name"]);

  return {
    kind,
    primary: title,
    secondary: raw ? basename(raw) : undefined,
    technicalDetail: raw || undefined,
    status: getStatus(part),
  };
}

function sectionStatusFromRows(rows: TimelineRowModel[], kind: TimelineSectionKind): TimelineSectionModel["status"] {
  if (rows.some((row) => row.status === "error")) return "error";
  if (rows.some((row) => row.status === "running")) return "running";
  if (kind === "verify" && rows.length > 0) return "pass";
  return rows.length > 0 ? "done" : undefined;
}

function summarizeSection(kind: TimelineSectionKind, rows: TimelineRowModel[]): string {
  if (!rows.length) return "";

  switch (kind) {
    case "plan":
      return rows.length === 1 ? "Plán připraven" : `Plán rozdělen do ${rows.length} kroků`;
    case "explore": {
      const files = rows.filter((row) => row.primary.startsWith("Načetl ")).length;
      const searches = rows.filter((row) => row.primary.startsWith("Vyhledal ")).length;
      const lists = rows.filter((row) => row.primary.startsWith("Vypsal ")).length;
      const items: string[] = [];
      if (files > 0) items.push(`${files} soubor${files === 1 ? "" : files >= 2 && files <= 4 ? "y" : "ů"}`);
      if (searches > 0) items.push(`${searches} hledání`);
      if (lists > 0) items.push(`${lists} výpis${lists === 1 ? "" : "ů"}`);
      return items.length > 0 ? items.join(" · ") : `${rows.length} průzkumů`;
    }
    case "action":
      return rows.length === 1 ? "1 akce" : `${rows.length} akcí`;
    case "verify":
      return rows.some((row) => row.status === "error")
        ? "ověření selhalo"
        : rows.some((row) => row.status === "running")
          ? "ověření běží"
          : "ověření OK";
    case "issues":
      return rows.length === 1 ? "1 problém" : `${rows.length} problémů`;
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
  const base = summaries.join(" · ");
  if (input.latestLabel && summaries.length <= 1) {
    return base ? `${base} · poslední: ${input.latestLabel}` : `poslední: ${input.latestLabel}`;
  }
  return base;
}

export function buildTimelineDetailModel(input: BuildTimelineDetailModelInput): TimelineDetailModel {
  const sections: TimelineSectionModel[] = [];
  let current: TimelineSectionModel | null = null;
  let previousKind: TimelineSectionKind | undefined;

  const appendSection = (kind: TimelineSectionKind, row: TimelineRowModel) => {
    if (!current || current.kind !== kind) {
      current = {
        kind,
        title: SECTION_TITLES[kind],
        summary: "",
        rows: [],
      };
      sections.push(current);
    }

    current.rows.push(row);
    current.status = sectionStatusFromRows(current.rows, current.kind);
    current.summary = summarizeSection(current.kind, current.rows);
  };

  for (const part of input.parts ?? []) {
    const kind = classifyPartKind(part, previousKind);
    const row = buildRowModel(part, kind);
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
