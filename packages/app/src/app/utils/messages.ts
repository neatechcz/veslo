import type { Part, Session } from "@opencode-ai/sdk/v2/client";
import type {
  MessageGroup,
  MessageInfo,
  MessageWithParts,
  ModelRef,
  OpencodeEvent,
  PlaceholderAssistantMessage,
} from "../types";

export function normalizeEvent(raw: unknown): OpencodeEvent | null {
  if (!raw || typeof raw !== "object") {
    return null;
  }

  const record = raw as Record<string, unknown>;

  if (typeof record.type === "string") {
    return {
      type: record.type,
      properties: record.properties,
    };
  }

  if (record.payload && typeof record.payload === "object") {
    const payload = record.payload as Record<string, unknown>;
    if (typeof payload.type === "string") {
      return {
        type: payload.type,
        properties: payload.properties,
      };
    }
  }

  return null;
}

export function upsertSession(list: Session[], next: Session) {
  const idx = list.findIndex((s) => s.id === next.id);
  if (idx === -1) return [...list, next];

  const copy = list.slice();
  copy[idx] = next;
  return copy;
}

export function upsertMessage(list: MessageWithParts[], nextInfo: MessageInfo) {
  const idx = list.findIndex((m) => m.info.id === nextInfo.id);
  if (idx === -1) {
    return list.concat({ info: nextInfo, parts: [] });
  }

  const copy = list.slice();
  copy[idx] = { ...copy[idx], info: nextInfo };
  return copy;
}

export function upsertPart(list: MessageWithParts[], nextPart: Part) {
  const msgIdx = list.findIndex((m) => m.info.id === nextPart.messageID);
  if (msgIdx === -1) {
    // avoids missing streaming events before message.updated
    const placeholder: PlaceholderAssistantMessage = {
      id: nextPart.messageID,
      sessionID: nextPart.sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: "",
      modelID: "",
      providerID: "",
      mode: "",
      agent: "",
      path: { cwd: "", root: "" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    };

    return list.concat({ info: placeholder, parts: [nextPart] });
  }

  const copy = list.slice();
  const msg = copy[msgIdx];
  const parts = msg.parts.slice();
  const partIdx = parts.findIndex((p) => p.id === nextPart.id);

  if (partIdx === -1) {
    parts.push(nextPart);
  } else {
    parts[partIdx] = nextPart;
  }

  copy[msgIdx] = { ...msg, parts };
  return copy;
}

export function removePart(list: MessageWithParts[], messageID: string, partID: string) {
  const msgIdx = list.findIndex((m) => m.info.id === messageID);
  if (msgIdx === -1) return list;

  const copy = list.slice();
  const msg = copy[msgIdx];
  copy[msgIdx] = { ...msg, parts: msg.parts.filter((p) => p.id !== partID) };
  return copy;
}

export function normalizeSessionStatus(status: unknown) {
  if (typeof status === "string") {
    const normalized = status.trim().toLowerCase();
    if (normalized === "busy" || normalized === "running") return "running";
    if (normalized === "retry" || normalized === "retrying") return "retry";
    return "idle";
  }

  if (!status || typeof status !== "object") return "idle";
  const record = status as Record<string, unknown>;
  if (typeof record.type === "string") {
    return normalizeSessionStatus(record.type);
  }
  if ("status" in record && record.status !== status) {
    return normalizeSessionStatus(record.status);
  }
  return "idle";
}

export function extractSessionId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const direct =
    (typeof record.sessionID === "string" ? record.sessionID : null) ??
    (typeof record.sessionId === "string" ? record.sessionId : null);
  const directTrimmed = direct?.trim();
  if (directTrimmed) return directTrimmed;

  if (record.info && typeof record.info === "object") {
    const nested = extractSessionId(record.info);
    if (nested) return nested;
  }

  if (record.part && typeof record.part === "object") {
    const nested = extractSessionId(record.part);
    if (nested) return nested;
  }

  return null;
}

export function modelFromUserMessage(info: MessageInfo): ModelRef | null {
  if (!info || typeof info !== "object") return null;
  if ((info as any).role !== "user") return null;

  const model = (info as any).model as unknown;
  if (!model || typeof model !== "object") return null;

  const providerID = (model as any).providerID;
  const modelID = (model as any).modelID;

  if (typeof providerID !== "string" || typeof modelID !== "string") return null;
  return { providerID, modelID };
}

export function lastUserModelFromMessages(list: MessageWithParts[]): ModelRef | null {
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const model = modelFromUserMessage(list[i]?.info);
    if (model) return model;
  }

  return null;
}

export function isStepPart(part: Part) {
  return part.type === "reasoning" || part.type === "tool";
}

export function isUserVisiblePart(part: Part) {
  const flags = part as { synthetic?: boolean; ignored?: boolean };
  if (flags.synthetic || flags.ignored) return false;
  if (part.type === "text" && isInternalAgentHandoff(part)) return false;
  if (part.type === "text" && isInternalAgentPlan(part)) return false;
  return true;
}

export function isVisibleTextPart(part: Part) {
  return part.type === "text" && isUserVisiblePart(part);
}

/**
 * Detect internal agent handoff / session-compaction text that should be hidden.
 *
 * When OpenCode's `session.summarize()` runs, the AI model produces a
 * summary for the *next* agent context (e.g. "Notes for Next Agent …").
 * The server sometimes emits this as a regular TextPart without the
 * `synthetic` flag, so it leaks into the user-visible message stream.
 *
 * We catch the most reliable markers here.  The patterns are intentionally
 * tight to avoid false-positives on normal conversation text.
 */
const HANDOFF_MARKERS = [
  "notes for next agent",
  "the next agent should",
  "context for the next",
  "handoff to the next",
] as const;

function isInternalAgentHandoff(part: Part): boolean {
  const text = (part as { text?: string }).text;
  if (!text || text.length < 40) return false;
  const lower = text.toLowerCase();
  return HANDOFF_MARKERS.some((marker) => lower.includes(marker));
}

/**
 * Detect internal agent plan/summary text that should be hidden.
 *
 * After completing a task, the agent sometimes emits a structured
 * plan/summary document with sections like "Goal", "Instructions",
 * "Discoveries", "Accomplished", and "Relevant files".  This is meant
 * for internal bookkeeping (session compaction / context carry-over)
 * and should not be shown to the user.
 *
 * We match section headers in plain-text form ("Goal"), with optional
 * Markdown prefixes ("## Goal"), or with trailing colons ("Goal:").
 * At least 3 distinct section groups must match to avoid false positives.
 */
const PLAN_SECTION_PATTERNS: RegExp[] = [
  // Goal / Objective
  /^#{0,4}\s*(?:goal|objective)s?:?\s*$/im,
  // Instructions / Key directives / Constraints
  /^#{0,4}\s*(?:instructions|key directives|constraints):?\s*$/im,
  // Discoveries / Findings / Key findings
  /^#{0,4}\s*(?:discover(?:ies|y)|(?:key )?findings):?\s*$/im,
  // Accomplished / Completed / Done
  /^#{0,4}\s*(?:accomplished|completed|done):?\s*$/im,
  // Relevant files / directories / File paths
  /^#{0,4}\s*(?:relevant files|file paths|relevant directories)/im,
  // Still pending / Next steps / Remaining work / TODO
  /^#{0,4}\s*(?:still pending|next steps|remaining work|todo):?\s*/im,
];

function isInternalAgentPlan(part: Part): boolean {
  const text = (part as { text?: string }).text;
  if (!text || text.length < 100) return false;
  let matches = 0;
  for (const pattern of PLAN_SECTION_PATTERNS) {
    if (pattern.test(text)) matches++;
  }
  return matches >= 3;
}

const EXPLORATION_TOOL_NAMES = new Set(["read", "glob", "grep", "search", "list", "list_files"]);

function isExplorationToolPart(part: Part) {
  if (part.type !== "tool") return false;
  const tool = typeof (part as any).tool === "string" ? String((part as any).tool).toLowerCase() : "";
  return EXPLORATION_TOOL_NAMES.has(tool);
}

export function groupMessageParts(parts: Part[], messageId: string): MessageGroup[] {
  const groups: MessageGroup[] = [];
  const explorationSteps: Part[] = [];
  let textBuffer = "";
  let stepGroupIndex = 0;
  let sawExecution = false;

  const flushText = () => {
    if (!textBuffer) return;
    groups.push({
      kind: "text",
      part: { type: "text", text: textBuffer } as Part,
      segment: sawExecution ? "result" : "intent",
    });
    textBuffer = "";
  };

  const pushSteps = (stepParts: Part[], mode: "exploration" | "standalone") => {
    if (!stepParts.length) return;
    groups.push({
      kind: "steps",
      id: `steps-${messageId}-${stepGroupIndex}`,
      parts: stepParts,
      segment: "execution",
      mode,
    });
    stepGroupIndex += 1;
    sawExecution = true;
  };

  const flushExplorationSteps = () => {
    if (!explorationSteps.length) return;
    pushSteps(explorationSteps.splice(0, explorationSteps.length), "exploration");
  };

  parts.forEach((part) => {
    if (part.type === "text") {
      if (!isVisibleTextPart(part)) {
        return;
      }
      flushExplorationSteps();
      textBuffer += (part as { text?: string }).text ?? "";
      return;
    }

    if (part.type === "agent") {
      flushExplorationSteps();
      const name = (part as { name?: string }).name ?? "";
      textBuffer += name ? `@${name}` : "@agent";
      return;
    }

    if (part.type === "file") {
      flushExplorationSteps();
      flushText();
      groups.push({ kind: "text", part, segment: sawExecution ? "result" : "intent" });
      return;
    }

    if (part.type === "step-start" || part.type === "step-finish") {
      return;
    }

    flushText();

    if (isExplorationToolPart(part)) {
      explorationSteps.push(part);
      return;
    }

    if (part.type === "reasoning" && explorationSteps.length > 0) {
      explorationSteps.push(part);
      return;
    }

    flushExplorationSteps();
    pushSteps([part], "standalone");
  });

  flushText();

  flushExplorationSteps();

  return groups;
}
