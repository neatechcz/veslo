import { For, Show, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import type { JSX } from "solid-js";
import type { Part } from "@opencode-ai/sdk/v2/client";
import { Bot, Check, ChevronDown, ChevronRight, CircleAlert, Copy, Eye, File, FileEdit, FolderSearch, Pencil, Search, Sparkles, Terminal } from "lucide-solid";
import { createVirtualizer } from "@tanstack/solid-virtual";

import {
  SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX,
  type MessageGroup,
  type MessageWithParts,
  type SidebarSubagentDecoration,
  type StepGroupMode,
} from "../../types";
import { compactHumanStepText, containsPathLikeText, summarizeStep } from "../../utils";
import PartView from "../part-view";
import { perfNow, recordPerfLog } from "../../lib/perf-log";
import { getTaskPartSubagentInfo, isVesloInternalSubagentType } from "../../lib/internal-subagents";
import { currentLocale, t } from "../../../i18n";
import { buildTimelineDetailModel, type TimelineRowModel, type TimelineRowType, type TimelineSectionKind } from "./timeline-detail-model.js";
import {
  createTimelineSectionStateId,
  reconcileTimelineOpenSectionIds,
  toggleTimelineSection,
  type TimelineDetailState,
} from "./timeline-detail-state.js";
import type { EditableUserMessageDraft } from "./message-editability";
import {
  buildProgressRenderBlocks,
  type ProgressCommentItem,
  type ProgressGroupItem,
  type ProgressRenderBlock,
  type ProgressStepItem,
} from "./progress-grouping-model.js";
import { currentLocale as __vesloCurrentLocale, t as __vesloT } from "../../../i18n";

export type PendingMessageState = {
  state: "error";
  error?: string;
};

export type MessageListProps = {
  messages: MessageWithParts[];
  isStreaming?: boolean;
  developerMode: boolean;
  showThinking: boolean;
  expandedStepIds: Set<string>;
  setExpandedStepIds: (updater: (current: Set<string>) => Set<string>) => void;
  expandedTimelineSectionIds: Set<string>;
  setExpandedTimelineSectionIds: (updater: (current: Set<string>) => Set<string>) => void;
  openSessionById?: (sessionId: string) => void;
  searchMatchMessageIds?: ReadonlySet<string>;
  activeSearchMessageId?: string | null;
  searchHighlightQuery?: string;
  workspaceRoot?: string;
  scrollElement?: () => HTMLElement | undefined;
  setScrollToMessageById?: (handler: ((messageId: string, behavior?: ScrollBehavior) => boolean) | null) => void;
  subagentDecorationsBySessionId?: Record<string, SidebarSubagentDecoration>;
  editableUserMessage?: EditableUserMessageDraft | null;
  onEditUserMessage?: (editable: EditableUserMessageDraft) => void;
  pendingMessageStateById?: Record<string, PendingMessageState>;
  footer?: JSX.Element;
};

type StepTimelineGroup = {
  id: string;
  parts: Part[];
  mode: StepGroupMode;
};

type MessageBlockItem = ProgressRenderBlock;

const VIRTUALIZATION_THRESHOLD = 500;
const VIRTUAL_OVERSCAN = 4;

function sameStringSet(left: ReadonlySet<string>, right: ReadonlySet<string>): boolean {
  if (left.size !== right.size) return false;
  for (const value of left) {
    if (!right.has(value)) return false;
  }
  return true;
}

/** Icon for a given tool category */
function ToolIcon(props: { category: string; size?: number }) {
  const s = () => props.size ?? 12;
  switch (props.category) {
    case "plan":
      return <Sparkles size={s()} />;
    case "explore":
    case "read":
      return <Eye size={s()} />;
    case "list":
      return <FolderSearch size={s()} />;
    case "action":
    case "edit":
      return <Pencil size={s()} />;
    case "write":
      return <FileEdit size={s()} />;
    case "verify":
      return <Check size={s()} />;
    case "issues":
    case "issue":
      return <CircleAlert size={s()} />;
    case "search":
      return <Search size={s()} />;
    case "command":
    case "terminal":
      return <Terminal size={s()} />;
    case "task":
      return <Bot size={s()} />;
    case "skill":
      return <Sparkles size={s()} />;
    case "note":
      return <Sparkles size={s()} />;
    case "tool":
    default:
      return <File size={s()} />;
  }
}

function statusChipClass(status?: string): string {
  switch (status) {
    case "done":
      return "border border-green-7/30 bg-green-3/80 text-green-11";
    case "pass":
      return "border border-emerald-7/30 bg-emerald-3/80 text-emerald-11";
    case "running":
      return "border border-blue-7/30 bg-blue-3/80 text-blue-11";
    case "error":
      return "border border-red-7/30 bg-red-3/80 text-red-11";
    default:
      return "border border-gray-6 bg-gray-3 text-gray-10";
  }
}

function latestStepPart(stepGroups: StepTimelineGroup[]): Part | undefined {
  for (let groupIndex = stepGroups.length - 1; groupIndex >= 0; groupIndex -= 1) {
    const parts = stepGroups[groupIndex]?.parts ?? [];
    for (let partIndex = parts.length - 1; partIndex >= 0; partIndex -= 1) {
      const part = parts[partIndex];
      if (part.type === "tool" || part.type === "reasoning") {
        return part;
      }
    }
  }
  return undefined;
}

function getPartTimestampRange(part: Part): { start?: number; end?: number } {
  const directTime = (part as { time?: { start?: unknown; end?: unknown } }).time;
  const stateTime = (part as { state?: { time?: { start?: unknown; end?: unknown } } }).state?.time;
  const start =
    typeof directTime?.start === "number"
      ? directTime.start
      : typeof stateTime?.start === "number"
        ? stateTime.start
        : undefined;
  const end =
    typeof directTime?.end === "number"
      ? directTime.end
      : typeof stateTime?.end === "number"
        ? stateTime.end
        : undefined;
  return { start, end };
}

function formatElapsedDuration(durationMs: number): string {
  if (durationMs < 1000) {
    return `${Math.max(1, Math.round(durationMs))} ms`;
  }

  const totalSeconds = Math.max(1, Math.round(durationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes} min ${seconds} s` : `${totalMinutes} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
}

function formatTimelineDuration(parts: Part[]): string {
  let earliestStart: number | undefined;
  let latestEnd: number | undefined;

  for (const part of parts) {
    const { start, end } = getPartTimestampRange(part);
    if (typeof start !== "number") continue;
    earliestStart = earliestStart === undefined ? start : Math.min(earliestStart, start);
    const effectiveEnd = typeof end === "number" ? end : Date.now();
    latestEnd = latestEnd === undefined ? effectiveEnd : Math.max(latestEnd, effectiveEnd);
  }

  if (earliestStart === undefined || latestEnd === undefined || latestEnd < earliestStart) {
    return "";
  }

  return formatElapsedDuration(latestEnd - earliestStart);
}

type TaskStepInfo = {
  isTask: boolean;
  agentType?: string;
  sessionId?: string;
  isInternal: boolean;
};

type TimelineRowView = {
  id: string;
  row: TimelineRowModel;
  part?: Part;
  task: TaskStepInfo;
};

type TimelineSectionLabelKind = TimelineSectionKind | "thinking" | "subagents";

type TimelineSectionView = {
  id: string;
  kind: TimelineSectionKind;
  labelKind: TimelineSectionLabelKind;
  summary: string;
  status?: TimelineRowModel["status"];
  rows: TimelineRowView[];
};

function formatAgentType(agentType: string): string {
  const clean = agentType.trim().replace(/[_-]+/g, " ");
  if (!clean) return "";
  return clean
    .split(/\s+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function getTaskStepInfo(part: Part): TaskStepInfo {
  const info = getTaskPartSubagentInfo(part);
  if (!info.isTask) return { isTask: false, isInternal: false };
  const agentType = info.subagentType && !info.internal ? formatAgentType(info.subagentType) : undefined;
  return { isTask: true, agentType, sessionId: info.sessionId, isInternal: info.internal };
}

export default function MessageList(props: MessageListProps) {
  const tr = (key: string, replacements?: Record<string, string>) => {
    let value = t(key, currentLocale());
    if (!replacements) return value;
    for (const [name, replacement] of Object.entries(replacements)) {
      value = value.replace(`{${name}}`, replacement);
    }
    return value;
  };

  const timelineSectionTitle = (kind: TimelineSectionLabelKind) => {
    if (kind === "thinking") return tr("session.timeline_section_thinking");
    if (kind === "subagents") return tr("session.timeline_section_subagents");
    return tr(`session.timeline_section_${kind}`);
  };
  const plural = (count: number, oneKey: string, otherKey: string) =>
    tr(count === 1 ? oneKey : otherKey, { count: String(count) });

  const timelineStatusLabel = (status?: TimelineRowModel["status"]) => {
    switch (status) {
      case "done":
        return tr("session.timeline_status_done");
      case "running":
        return tr("session.timeline_status_running");
      case "error":
        return tr("session.timeline_status_error");
      case "pass":
        return tr("session.timeline_status_pass");
      default:
        return "";
    }
  };
  const taskDecoration = (task: TaskStepInfo): SidebarSubagentDecoration | null => {
    if (!task.isTask || task.isInternal) return null;
    const sessionId = task.sessionId?.trim() ?? "";
    if (!sessionId) return null;
    const entry = props.subagentDecorationsBySessionId?.[sessionId];
    if (!entry) return null;
    const label = entry.label?.trim() ?? "";
    const color = entry.color?.trim() ?? "";
    if (!label || !color) return null;
    return { label, color };
  };
  const countSectionRows = (rows: TimelineRowView[], kinds: TimelineRowType[]) => {
    const set = new Set(kinds);
    return rows.filter((entry) => set.has(entry.row.rowType)).length;
  };
  const countTimelineRows = (sections: TimelineSectionView[], kinds: TimelineRowType[]) => {
    const set = new Set(kinds);
    return sections.reduce(
      (count, section) => count + section.rows.filter((entry) => set.has(entry.row.rowType)).length,
      0,
    );
  };
  const countSectionMediaEvidence = (rows: TimelineRowView[], kind: "created" | "analyzed") =>
    rows.reduce(
      (count, entry) => count + (entry.row.mediaEvidence ?? []).filter((item) => item.kind === kind).length,
      0,
    );
  const countTimelineMediaEvidence = (sections: TimelineSectionView[], kind: "created" | "analyzed") =>
    sections.reduce((count, section) => count + countSectionMediaEvidence(section.rows, kind), 0);
  const imageEvidenceSummary = (count: number, kind: "created" | "analyzed") => {
    if (count <= 0) return "";
    return `${count} ${count === 1 ? "image" : "images"} ${kind}`;
  };
  const localizedSectionTitle = (section: TimelineSectionView) => timelineSectionTitle(section.labelKind);
  const sectionStatusFromRows = (rows: TimelineRowView[]) => {
    if (rows.some((entry) => entry.row.status === "error")) return "error" as const;
    if (rows.some((entry) => entry.row.status === "running")) return "running" as const;
    if (rows.some((entry) => entry.row.status === "pass")) return "pass" as const;
    if (rows.some((entry) => entry.row.status === "done")) return "done" as const;
    return undefined;
  };
  const splitActionSectionRows = (rows: TimelineRowView[]) => {
    const thinkingRows: TimelineRowView[] = [];
    const subagentRows: TimelineRowView[] = [];
    const otherRows: TimelineRowView[] = [];

    for (const row of rows) {
      if (row.row.rowType === "note") {
        thinkingRows.push(row);
        continue;
      }
      if (row.task.isTask && !row.task.isInternal) {
        subagentRows.push(row);
        continue;
      }
      otherRows.push(row);
    }

    return [
      {
        labelKind: "thinking" as const,
        rows: thinkingRows,
      },
      {
        labelKind: "subagents" as const,
        rows: subagentRows,
      },
      {
        labelKind: "action" as const,
        rows: otherRows,
      },
    ].filter((group) => group.rows.length > 0);
  };
  const localizedSectionSummary = (section: TimelineSectionView) => {
    switch (section.kind) {
      case "plan": {
        const plans = countSectionRows(section.rows, ["plan"]);
        return plans === 1
          ? tr("session.timeline_summary_plan_ready")
          : tr("session.timeline_summary_plan_steps", { count: String(plans) });
      }
      case "explore": {
        const items: string[] = [];
        const fileCount = countSectionRows(section.rows, ["read"]);
        const searchCount = countSectionRows(section.rows, ["search"]);
        const listCount = countSectionRows(section.rows, ["list"]);
        if (fileCount > 0) items.push(plural(fileCount, "session.timeline_file_one", "session.timeline_file_other"));
        if (searchCount > 0) items.push(plural(searchCount, "session.timeline_search_one", "session.timeline_search_other"));
        if (listCount > 0) items.push(plural(listCount, "session.timeline_list_one", "session.timeline_list_other"));
        return items.length > 0 ? items.join(" · ") : tr("session.timeline_context_activity");
      }
      case "action": {
        const items: string[] = [];
        const actions = countSectionRows(section.rows, ["edit", "write", "task", "skill", "command", "tool"]);
        const thoughts = countSectionRows(section.rows, ["note"]);
        const createdImages = imageEvidenceSummary(countSectionMediaEvidence(section.rows, "created"), "created");
        const analyzedImages = imageEvidenceSummary(countSectionMediaEvidence(section.rows, "analyzed"), "analyzed");
        if (actions > 0) items.push(plural(actions, "session.timeline_summary_action_one", "session.timeline_summary_action_other"));
        if (thoughts > 0) items.push(plural(thoughts, "session.timeline_summary_thinking_one", "session.timeline_summary_thinking_other"));
        if (createdImages) items.push(createdImages);
        if (analyzedImages) items.push(analyzedImages);
        return items.join(" · ");
      }
      case "verify":
        return section.rows.some((entry) => entry.row.status === "error")
          ? tr("session.timeline_summary_verify_failed")
          : section.rows.some((entry) => entry.row.status === "running")
            ? tr("session.timeline_summary_verify_running")
            : tr("session.timeline_summary_verify_ok");
      case "issues": {
        const issues = countSectionRows(section.rows, ["issue"]);
        return plural(issues, "session.timeline_summary_issue_one", "session.timeline_summary_issue_other");
      }
    }
  };
  const localizedTimelineSummary = (sections: TimelineSectionView[]) => {
    const items: string[] = [];
    const planCount = countTimelineRows(sections, ["plan"]);
    const fileCount = countTimelineRows(sections, ["read"]);
    const searchCount = countTimelineRows(sections, ["search"]);
    const listCount = countTimelineRows(sections, ["list"]);
    const actionCount = countTimelineRows(sections, ["edit", "write", "task", "skill", "command", "tool"]);
    const thoughtCount = countTimelineRows(sections, ["note"]);
    const issueCount = countTimelineRows(sections, ["issue"]);
    const createdImageCount = countTimelineMediaEvidence(sections, "created");
    const analyzedImageCount = countTimelineMediaEvidence(sections, "analyzed");
    const verifySections = sections.filter((section) => section.kind === "verify");

    if (planCount > 0) {
      items.push(
        planCount === 1
          ? tr("session.timeline_summary_plan_ready")
          : tr("session.timeline_summary_plan_steps", { count: String(planCount) }),
      );
    }
    if (fileCount > 0) items.push(plural(fileCount, "session.timeline_file_one", "session.timeline_file_other"));
    if (searchCount > 0) items.push(plural(searchCount, "session.timeline_search_one", "session.timeline_search_other"));
    if (listCount > 0) items.push(plural(listCount, "session.timeline_list_one", "session.timeline_list_other"));
    if (actionCount > 0) items.push(plural(actionCount, "session.timeline_summary_action_one", "session.timeline_summary_action_other"));
    if (thoughtCount > 0) items.push(plural(thoughtCount, "session.timeline_summary_thinking_one", "session.timeline_summary_thinking_other"));
    if (createdImageCount > 0) items.push(imageEvidenceSummary(createdImageCount, "created"));
    if (analyzedImageCount > 0) items.push(imageEvidenceSummary(analyzedImageCount, "analyzed"));
    if (verifySections.length > 0) {
      const hasVerifyError = verifySections.some((section) => section.rows.some((entry) => entry.row.status === "error"));
      const hasVerifyRunning = verifySections.some((section) => section.rows.some((entry) => entry.row.status === "running"));
      items.push(
        hasVerifyError
          ? tr("session.timeline_summary_verify_failed")
          : hasVerifyRunning
            ? tr("session.timeline_summary_verify_running")
            : tr("session.timeline_summary_verify_ok"),
      );
    }
    if (issueCount > 0) items.push(plural(issueCount, "session.timeline_summary_issue_one", "session.timeline_summary_issue_other"));
    return items.join(" · ");
  };

  const [copyingId, setCopyingId] = createSignal<string | null>(null);
  let previousMessagePartCountById = new Map<string, number>();
  let copyTimeout: number | undefined;
  const isAttachmentPart = (part: Part) => {
    if (part.type !== "file") return false;
    const url = (part as { url?: string }).url;
    return typeof url === "string" && !url.startsWith("file://");
  };
  const attachmentsForMessage = (message: MessageWithParts) =>
    message.parts
      .filter(isAttachmentPart)
      .map((part) => {
        const record = part as { url?: string; filename?: string; mime?: string };
        return {
          url: record.url ?? "",
          filename: record.filename ?? "attachment",
          mime: record.mime ?? "application/octet-stream",
        };
      })
      .filter((attachment) => !!attachment.url);
  const isImageAttachment = (mime: string) => mime.startsWith("image/");
  onCleanup(() => {
    if (copyTimeout !== undefined) {
      window.clearTimeout(copyTimeout);
    }
  });

  const handleCopy = async (text: string, id: string) => {
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // navigator.clipboard can fail in Tauri WKWebView; fall back to execCommand
    }
    if (!ok) {
      try {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.style.position = "fixed";
        ta.style.left = "-9999px";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        // ignore
      }
    }
    if (ok) {
      setCopyingId(id);
      if (copyTimeout !== undefined) {
        window.clearTimeout(copyTimeout);
      }
      copyTimeout = window.setTimeout(() => {
        setCopyingId(null);
        copyTimeout = undefined;
      }, 2000);
    }
  };

  const partToText = (part: Part) => {
    if (part.type === "text") {
      return String((part as { text?: string }).text ?? "");
    }
    if (part.type === "agent") {
      const name = (part as { name?: string }).name ?? "";
      return name ? `@${name}` : "@agent";
    }
    if (part.type === "file") {
      const record = part as { label?: string; path?: string; filename?: string };
      const label = record.label ?? record.path ?? record.filename ?? "";
      return label ? `@${label}` : "@file";
    }
    return "";
  };

  const toggleSteps = (id: string, relatedIds: string[] = []) => {
    props.setExpandedStepIds((current) => {
      const next = new Set(current);
      const isExpanded = next.has(id) || relatedIds.some((relatedId) => next.has(relatedId));
      if (isExpanded) {
        next.delete(id);
        relatedIds.forEach((relatedId) => next.delete(relatedId));
      } else {
        next.add(id);
        relatedIds.forEach((relatedId) => next.add(relatedId));
      }
      return next;
    });
  };

  const toggleProgressGroup = (id: string, items: ProgressGroupItem[]) => {
    props.setExpandedStepIds((current) => {
      const next = new Set(current);
      const wasExpanded = next.has(id);
      next.delete(id);
      items.forEach((item) => {
        if (item.kind === "steps") next.delete(item.id);
      });
      if (!wasExpanded) next.add(id);
      return next;
    });
  };

  const isStepsExpanded = (id: string, relatedIds: string[] = []) =>
    props.expandedStepIds.has(id) ||
    relatedIds.some((relatedId) => props.expandedStepIds.has(relatedId));

  const messageBlocks = createMemo<MessageBlockItem[]>(() => {
    const startedAt = perfNow();
    const nextMessagePartCountById = new Map<string, number>();
    let changedMessageCount = 0;
    let addedMessageCount = 0;

    props.messages.forEach((message, index) => {
      const messageId = String((message.info as any).id ?? "");
      const idKey = messageId || `idx:${index}`;
      const totalParts = message.parts.length;
      nextMessagePartCountById.set(idKey, totalParts);
      const previousPartCount = previousMessagePartCountById.get(idKey);
      if (previousPartCount === undefined) {
        addedMessageCount += 1;
      } else if (previousPartCount !== totalParts) {
        changedMessageCount += 1;
      }
    });

    const blocks = buildProgressRenderBlocks({
      messages: props.messages,
      isStreaming: Boolean(props.isStreaming),
      developerMode: props.developerMode,
      showThinking: props.showThinking,
    });

    const toolPartCount = blocks.reduce((count, block) => {
      if (block.kind === "message") {
        return count + block.renderableParts.filter((part) => part.type === "tool").length;
      }
      return count + block.items.reduce((itemCount, item) => itemCount + (item.kind === "steps" ? item.parts.filter((part) => part.type === "tool").length : 0), 0);
    }, 0);
    const stepGroupCount = blocks.reduce((count, block) => {
      if (block.kind === "message") {
        return count + block.groups.filter((group) => group.kind === "steps").length;
      }
      return count + block.items.filter((item) => item.kind === "steps").length;
    }, 0);

    let removedMessageCount = 0;
    previousMessagePartCountById.forEach((_partCount, id) => {
      if (!nextMessagePartCountById.has(id)) {
        removedMessageCount += 1;
      }
    });
    previousMessagePartCountById = nextMessagePartCountById;

    const elapsedMs = Math.round((perfNow() - startedAt) * 100) / 100;
    if (
      props.developerMode &&
      (
        elapsedMs >= 6 ||
        (Boolean(props.isStreaming) && props.messages.length >= 16 && changedMessageCount <= 2 && addedMessageCount <= 1 && removedMessageCount === 0) ||
        (Boolean(props.isStreaming) && toolPartCount >= 10)
      )
    ) {
      recordPerfLog(true, "session.render", "message-blocks", {
        messageCount: props.messages.length,
        blockCount: blocks.length,
        changedMessageCount,
        addedMessageCount,
        removedMessageCount,
        toolPartCount,
        stepGroupCount,
        streaming: Boolean(props.isStreaming),
        ms: elapsedMs,
      });
    }

    return blocks;
  });

  const latestAssistantMessageId = createMemo(() => {
    for (let index = props.messages.length - 1; index >= 0; index -= 1) {
      const message = props.messages[index];
      if ((message.info as any).role === "assistant") {
        return String((message.info as any).id ?? "");
      }
    }
    return "";
  });

  const blockIndexByMessageId = createMemo(() => {
    const next = new Map<string, number>();
    messageBlocks().forEach((block, index) => {
      if (block.kind === "progress-group") {
        block.messageIds.forEach((id) => {
          if (id) next.set(id, index);
        });
        return;
      }
      if (block.messageId) {
        next.set(block.messageId, index);
      }
    });
    return next;
  });

  const shouldVirtualize = createMemo(
    () => Boolean(props.scrollElement?.()) && messageBlocks().length >= VIRTUALIZATION_THRESHOLD,
  );

  const virtualizer = createVirtualizer<HTMLElement, HTMLDivElement>({
    get count() {
      return messageBlocks().length;
    },
    getScrollElement: () => props.scrollElement?.() ?? null,
    estimateSize: () => 220,
    overscan: VIRTUAL_OVERSCAN,
    getItemKey: (index) => {
      const block = messageBlocks()[index];
      if (!block) return `block-${index}`;
      if (block.kind === "progress-group") {
        return `progress-${block.messageIds.join(",")}`;
      }
      return `message-${block.messageId}`;
    },
  });

  let cachedVirtualRows: ReturnType<typeof virtualizer.getVirtualItems> = [];
  const virtualRows = createMemo(() => {
    if (!shouldVirtualize()) {
      cachedVirtualRows = [];
      return [];
    }
    const rows = virtualizer.getVirtualItems();
    if (rows.length > 0) {
      cachedVirtualRows = rows;
      return rows;
    }
    return cachedVirtualRows;
  });

  const virtualRowByIndex = createMemo(() => {
    const map = new Map<number, ReturnType<typeof virtualizer.getVirtualItems>[number]>();
    virtualRows().forEach((row) => {
      map.set(row.index, row);
    });
    return map;
  });

  const virtualRowIndices = createMemo(() => virtualRows().map((row) => row.index));

  const shouldUseContentVisibility = createMemo(() => !shouldVirtualize() && messageBlocks().length > 500);
  const blockPerfStyle = (index: number): JSX.CSSProperties | undefined => {
    if (!shouldUseContentVisibility()) return undefined;
    const total = messageBlocks().length;
    if (index >= total - 24) return undefined;
    return {
      "content-visibility": "auto",
      "contain-intrinsic-size": "220px",
    };
  };

  createEffect(() => {
    const setScrollToMessageById = props.setScrollToMessageById;
    if (!setScrollToMessageById) return;
    const indexById = blockIndexByMessageId();
    const useVirtualization = shouldVirtualize();

    setScrollToMessageById((messageId, behavior = "smooth") => {
      const index = indexById.get(messageId);
      if (index === undefined) return false;

      if (useVirtualization) {
        virtualizer.scrollToIndex(index, { align: "center" });
        return true;
      }

      const container = props.scrollElement?.();
      if (!container) return false;
      const escapedId = messageId.replace(/"/g, '\\"');
      const target = container.querySelector(`[data-message-id="${escapedId}"]`) as HTMLElement | null;
      if (!target) return false;
      target.scrollIntoView({ behavior, block: "center" });
      return true;
    });
  });

  createEffect(() => {
    if (!shouldVirtualize()) return;
    queueMicrotask(() => {
      virtualizer.measure();
    });
  });

  onCleanup(() => {
    props.setScrollToMessageById?.(null);
  });

  const canShowTimelineTechnicalDetail = (entry: { part?: Part; row: TimelineRowModel }) =>
    Boolean(entry.row.technicalDetail) && (entry.part?.type !== "reasoning" || props.showThinking);

  const ProgressComment = (commentProps: { item: ProgressCommentItem }) => (
    <div data-testid="session-progress-comment" class="font-reading type-reading-md text-gray-12 antialiased">
      <PartView
        part={commentProps.item.part}
        developerMode={props.developerMode}
        showThinking={props.showThinking}
        workspaceRoot={props.workspaceRoot}
        tone="light"
        renderMarkdown={true}
        highlightQuery={props.searchHighlightQuery}
      />
    </div>
  );

  const ProgressStepGroup = (stepProps: { item: ProgressStepItem }) => (
    <div data-testid="session-progress-step-group">
      <StepsContainer
        id={stepProps.item.id}
        stepGroups={[{ id: stepProps.item.id, parts: stepProps.item.parts, mode: stepProps.item.mode }]}
        isUser={false}
        isInline={true}
        isProgressChild={true}
      />
    </div>
  );

  /** Expandable steps container */
  const StepsContainer = (containerProps: {
    id: string;
    relatedIds?: string[];
    stepGroups: StepTimelineGroup[];
    progressItems?: ProgressGroupItem[];
    isUser: boolean;
    isInline?: boolean;
    isProgressChild?: boolean;
  }) => {
    const relatedIds = () =>
      containerProps.relatedIds ?? containerProps.stepGroups.map((group) => group.id).filter((id) => id !== containerProps.id);
    const progressItems = () => containerProps.progressItems ?? null;
    const expanded = () => progressItems() ? props.expandedStepIds.has(containerProps.id) : isStepsExpanded(containerProps.id, relatedIds());
    const toggleContainer = () => {
      const items = progressItems();
      if (items) {
        toggleProgressGroup(containerProps.id, items);
        return;
      }
      toggleSteps(containerProps.id, relatedIds());
    };
    const latestStep = () => latestStepPart(containerProps.stepGroups);
    const allStepParts = () => containerProps.stepGroups.flatMap((group) => group.parts);

    const compactPathToken = (value: string) => {
      const token = value
        .trim()
        .replace(/^[`'"([{]+|[`'"\])},.;:]+$/g, "");
      const segments = token.split(/[\\/]/).filter(Boolean);
      return segments.length > 0 ? segments[segments.length - 1] : token;
    };

    const compactText = (value: string, max = 42, options?: { preservePaths?: boolean }) => {
      const singleLine = value.replace(/\s+/g, " ").trim();
      if (!singleLine) return "";
      if (options?.preservePaths && containsPathLikeText(singleLine)) return singleLine;
      return singleLine.length > max ? `${singleLine.slice(0, Math.max(0, max - 3))}...` : singleLine;
    };

    const isPathLike = (value: string) =>
      /^(?:[A-Za-z]:[\\/]|~[\\/]|\/[\w_\-~]|\.\.?[\\/])/.test(value) ||
      /[\\/](?:\.opencode|Users|Library|workspaces)[\\/]/.test(value);

    const toolHeadline = (part: Part) => {
      if (part.type !== "tool") return "";

      const record = part as any;
      const state = record.state ?? {};
      const input = state.input && typeof state.input === "object" ? (state.input as Record<string, unknown>) : {};
      const tool = typeof record.tool === "string" ? record.tool.toLowerCase() : "";

      const pick = (...keys: string[]) => {
        for (const key of keys) {
          const value = input[key];
          if (typeof value === "string" && value.trim()) return value.trim();
        }
        return "";
      };

      const target = (...keys: string[]) => {
        const raw = pick(...keys);
        if (!raw) return "";
        return isPathLike(raw) ? compactPathToken(raw) : raw;
      };

      if (tool === "bash") {
        const description = pick("description");
        if (description) return compactHumanStepText(description, 42);
        const command = pick("command", "cmd");
        return command ? compactText(t("tools.run_target", currentLocale()).replace("{target}", command), 48) : t("tools.run_command", currentLocale());
      }

      if (tool === "read") {
        const file = target("filePath", "path", "file");
        return file ? t("tools.read_target", currentLocale()).replace("{target}", file) : t("tools.read_file", currentLocale());
      }

      if (tool === "edit") {
        const file = target("filePath", "path", "file");
        return file ? t("tools.edit_target", currentLocale()).replace("{target}", file) : t("tools.edit_file", currentLocale());
      }

      if (tool === "write" || tool === "apply_patch") {
        const file = target("filePath", "path", "file");
        return file ? t("tools.write_target", currentLocale()).replace("{target}", file) : t("tools.write_file", currentLocale());
      }

      if (tool === "grep" || tool === "glob" || tool === "search") {
        const pattern = pick("pattern", "query");
        return pattern ? t("tools.search_target", currentLocale()).replace("{target}", compactText(pattern, 36)) : t("tools.search_code", currentLocale());
      }

      if (tool === "list" || tool === "list_files") {
        const path = target("path");
        return path ? t("tools.list_target", currentLocale()).replace("{target}", path) : t("tools.list_files", currentLocale());
      }

      if (tool === "task") {
        const agent = pick("subagent_type");
        if (isVesloInternalSubagentType(agent)) return t("tools.internal_processing", currentLocale());
        const description = pick("description");
        if (description) return compactHumanStepText(description, 42);
        return agent ? t("tools.delegate_target", currentLocale()).replace("{target}", agent) : t("tools.delegate_task", currentLocale());
      }

      if (tool === "webfetch") {
        const url = pick("url");
        return url ? t("tools.fetch_target", currentLocale()).replace("{target}", compactText(url, 36)) : t("tools.fetch_web_page", currentLocale());
      }

      if (tool === "skill") {
        const name = pick("name");
        return name ? t("tools.load_skill_named", currentLocale()).replace("{name}", name) : t("tools.load_skill", currentLocale());
      }

      return "";
    };

    const latestStepLabel = () => {
      const step = latestStep();
      if (!step) return t("session.last_step", currentLocale());

      const fromTool = toolHeadline(step);
      if (fromTool) return compactText(fromTool, 42, { preservePaths: true });

      if (step.type === "tool") {
        const toolName = String((step as any).tool ?? "").trim();
        if (toolName) {
          const friendlyTool = toolName.replace(/[_-]+/g, " ");
          return compactText(friendlyTool);
        }
      }

      const summary = summarizeStep(step);
      const title = compactText(summary.title, 42, { preservePaths: true });
      const detail = compactText(summary.detail ?? "", 42, { preservePaths: true });
      const generic = /^(application|tool|step|working|done|completed|success)$/i.test(title);

      if (title && !generic) return title;
      if (detail) return detail;
      if (title) return title;
      return t("session.last_step", currentLocale());
    };

    const timelineModel = createMemo(() =>
      buildTimelineDetailModel({
        parts: allStepParts(),
        latestLabel: latestStepLabel(),
        workspaceRoot: props.workspaceRoot,
      }),
    );
    const timelineSections = createMemo<TimelineSectionView[]>(() => {
      const parts = allStepParts();
      let cursor = 0;
      const baseSections = timelineModel().sections.map((section, sectionIndex) => {
        const rows = section.rows.map((row, rowIndex) => {
          const part = parts[cursor + rowIndex];
          return {
            id: `${containerProps.id}:section:${sectionIndex}:row:${rowIndex}`,
            row,
            part,
            task: part ? getTaskStepInfo(part) : { isTask: false, isInternal: false },
          };
        });
        cursor += section.rows.length;
        return {
          kind: section.kind,
          labelKind: section.kind,
          summary: section.summary,
          status: section.status,
          rows,
        };
      });

      const sectionCounts = new Map<TimelineSectionLabelKind, number>();
      const withStableSectionId = (section: Omit<TimelineSectionView, "id">): TimelineSectionView => {
        const occurrence = sectionCounts.get(section.labelKind) ?? 0;
        sectionCounts.set(section.labelKind, occurrence + 1);
        return {
          ...section,
          id: createTimelineSectionStateId(containerProps.id, section.labelKind, occurrence),
        };
      };

      const sections: TimelineSectionView[] = [];
      for (const section of baseSections) {
        if (section.kind !== "action") {
          sections.push(withStableSectionId(section));
          continue;
        }

        const splitGroups = splitActionSectionRows(section.rows);
        if (splitGroups.length <= 1) {
          sections.push(withStableSectionId({
            ...section,
            labelKind: splitGroups[0]?.labelKind ?? "action",
          }));
          continue;
        }

        splitGroups.forEach((group) => {
          sections.push(withStableSectionId({
            kind: "action",
            labelKind: group.labelKind,
            summary: section.summary,
            status: sectionStatusFromRows(group.rows),
            rows: group.rows,
          }));
        });
      }

      return sections;
    });
    const timelineDetailState = (): TimelineDetailState => ({
      expanded: false,
      openSectionIds: props.expandedTimelineSectionIds,
    });
    const setTimelineDetailState = (updater: (current: TimelineDetailState) => TimelineDetailState) => {
      props.setExpandedTimelineSectionIds((current) => updater({ expanded: false, openSectionIds: current }).openSectionIds);
    };
    createEffect(() => {
      const sections = timelineSections().map((section) => ({
        id: section.id,
        kind: section.kind,
        status: section.status,
      }));
      props.setExpandedTimelineSectionIds((current) => {
        const next = reconcileTimelineOpenSectionIds(current, {
          containerId: containerProps.id,
          sections,
        });
        return sameStringSet(current, next) ? current : next;
      });
    });

    const hasRunning = () => timelineSections().some((section) => section.status === "running");
    const commentCount = () => progressItems()?.filter((item) => item.kind === "comment").length ?? 0;
    const commentSummary = () => {
      const count = commentCount();
      return count > 0 ? plural(count, "session.timeline_summary_comment_one", "session.timeline_summary_comment_other") : "";
    };
    const collapsedSummary = () => {
      const timelineSummary = localizedTimelineSummary(timelineSections());
      if (containerProps.isProgressChild) {
        return latestStepLabel() || timelineSummary || tr("session.timeline_execution");
      }
      return [commentSummary(), timelineSummary].filter(Boolean).join(" · ") ||
        latestStepLabel() ||
        tr("session.timeline_execution");
    };
    const collapsedMeta = () => {
      const labels = Array.from(new Set(timelineSections().map((section) => localizedSectionTitle(section)).filter(Boolean)));
      const duration = formatTimelineDuration(allStepParts());
      return [...labels, duration].filter(Boolean).join(" · ") || tr("session.timeline_execution");
    };
    const singleSectionMode = () => timelineSections().length === 1;
    const sectionExpanded = (sectionId: string) => timelineDetailState().openSectionIds.has(sectionId);
    const sectionDisplayCategory = (section: TimelineSectionView): TimelineRowType | TimelineSectionKind => {
      if (section.labelKind === "thinking") return "note";
      if (section.labelKind === "subagents") return "task";
      return section.kind;
    };
    const displayedTimelineRow = (entry: TimelineRowView): TimelineRowModel => {
      if (entry.part?.type === "reasoning" && entry.row.rowType === "note" && !props.showThinking) {
        return {
          ...entry.row,
          primary: tr("session.timeline_thinking"),
          secondary: undefined,
          technicalDetail: undefined,
        };
      }

      return entry.row;
    };
    const iconAccentClass = (category: TimelineRowType | TimelineSectionKind) => {
      switch (category) {
        case "issue":
        case "issues":
          return "bg-red-3/70 text-red-11";
        case "verify":
          return "bg-emerald-3/70 text-emerald-11";
        case "task":
          return "bg-blue-3/70 text-blue-11";
        case "note":
        case "skill":
        case "plan":
          return "bg-purple-3/70 text-purple-11";
        case "edit":
        case "write":
        case "action":
        case "command":
          return "bg-amber-3/70 text-amber-11";
        case "read":
        case "list":
        case "search":
        case "explore":
          return "bg-sky-3/70 text-sky-11";
        default:
          return "bg-gray-3 text-gray-10";
      }
    };

    return (
      <div class={containerProps.isInline ? (containerProps.isUser ? "mt-2" : "mt-3 pt-3") : ""}>
        <button
          class={`flex w-full items-start gap-2 rounded-[18px] border px-3 py-2 text-left transition-colors ${
            containerProps.isUser
              ? "border-gray-6 bg-gray-2/60 text-gray-10 hover:text-gray-11"
              : "border-gray-6/70 bg-gray-2/35 text-gray-10 hover:text-gray-12"
          }`}
          onClick={toggleContainer}
        >
          <ChevronRight
            size={14}
            class={`mt-0.5 shrink-0 transition-transform duration-200 ${expanded() ? "rotate-90" : ""}`}
          />
          <div class="min-w-0 flex-1">
            <div class="flex items-center gap-2">
              <span class="font-medium leading-5 text-[13px] text-gray-12">{collapsedSummary()}</span>
              <Show when={hasRunning()}>
                <span class={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusChipClass("running")}`}>
                  {timelineStatusLabel("running")}
                </span>
              </Show>
            </div>
            <div class="mt-0.5 text-[11px] leading-4 text-gray-9">{collapsedMeta()}</div>
          </div>
        </button>

        <Show when={expanded()}>
          <Show when={progressItems()}>
            {(items) => (
              <div class="mt-2 space-y-2">
                <For each={items()}>
                  {(item) => item.kind === "comment" ? <ProgressComment item={item} /> : <ProgressStepGroup item={item} />}
                </For>
              </div>
            )}
          </Show>
          <Show when={!progressItems()}>
            <div class="mt-2 space-y-2">
              <For each={timelineSections()}>
                {(section) => (
                  <section class="rounded-[18px] border border-gray-6/60 bg-gray-2/35">
                    <Show
                      when={!singleSectionMode()}
                      fallback={(
                        <div class="flex items-center gap-2 px-3 py-2">
                          <div class={`shrink-0 rounded-full p-1.5 ${iconAccentClass(sectionDisplayCategory(section))}`}>
                            <ToolIcon category={sectionDisplayCategory(section)} size={13} />
                          </div>
                          <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2">
                              <span class="truncate text-[13px] font-medium text-gray-12">{localizedSectionTitle(section)}</span>
                            </div>
                          </div>
                          <Show when={section.status}>
                            {(status) => (
                              <span class={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusChipClass(status())}`}>
                                {timelineStatusLabel(status())}
                              </span>
                            )}
                          </Show>
                        </div>
                      )}
                    >
                      <button
                        type="button"
                        class="flex w-full items-center gap-2 px-3 py-2 text-left"
                        onClick={(event) => {
                          event.preventDefault();
                          event.stopPropagation();
                          setTimelineDetailState((current) => toggleTimelineSection(current, section.id));
                        }}
                      >
                        <ChevronRight
                          size={14}
                          class={`shrink-0 transition-transform duration-200 ${sectionExpanded(section.id) ? "rotate-90" : ""}`}
                        />
                        <div class={`shrink-0 rounded-full p-1.5 ${iconAccentClass(sectionDisplayCategory(section))}`}>
                          <ToolIcon category={sectionDisplayCategory(section)} size={13} />
                        </div>
                        <div class="min-w-0 flex-1">
                          <div class="flex items-center gap-2">
                            <span class="truncate text-[13px] font-medium text-gray-12">{localizedSectionTitle(section)}</span>
                            <span class="truncate text-[11px] text-gray-9">{localizedSectionSummary(section)}</span>
                          </div>
                        </div>
                        <Show when={section.status}>
                          {(status) => (
                            <span class={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusChipClass(status())}`}>
                              {timelineStatusLabel(status())}
                            </span>
                          )}
                        </Show>
                      </button>
                    </Show>

                    <Show when={singleSectionMode() || sectionExpanded(section.id)}>
                      <div class="border-t border-gray-6/50 px-3 pb-2">
                        <For each={section.rows}>
                          {(entry, rowIndex) => (
                            <div
                              class={rowIndex() === 0 ? "pt-2" : "border-t border-gray-6/40 py-2"}
                              data-testid={containerProps.isProgressChild ? "session-progress-row" : undefined}
                            >
                              {(() => {
                                const row = displayedTimelineRow(entry);
                                return (
                                  <div class="flex items-start gap-2">
                                    <div class={`mt-0.5 shrink-0 rounded-full p-1.5 ${iconAccentClass(row.rowType)}`}>
                                      <ToolIcon category={row.rowType} size={13} />
                                    </div>
                                    <div class="min-w-0 flex-1">
                                      <div class="flex items-start gap-2">
                                        <div class="min-w-0 flex-1">
                                          <div class="text-[13px] font-medium leading-5 text-gray-12">
                                            <Show when={taskDecoration(entry.task)}>
                                              {(decoration) => (
                                                <span
                                                  class="mr-1.5 inline-flex items-center rounded-full border px-1.5 py-0.5 text-[10px] align-middle"
                                                  style={{
                                                    color: decoration().color,
                                                    "border-color": `${decoration().color}66`,
                                                    "background-color": `${decoration().color}1a`,
                                                  }}
                                                  title={decoration().label}
                                                >
                                                  {decoration().label}
                                                </span>
                                              )}
                                            </Show>
                                            {row.primary}
                                          </div>
                                          <Show when={row.secondary}>
                                            <div class="mt-0.5 text-[12px] leading-5 text-gray-10 break-words">
                                              {row.secondary}
                                            </div>
                                          </Show>
                                        </div>
                                        <Show when={row.status}>
                                          {(status) => (
                                            <span class={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-medium ${statusChipClass(status())}`}>
                                              {timelineStatusLabel(status())}
                                            </span>
                                          )}
                                        </Show>
                                      </div>

                                      <div class="mt-1 flex flex-wrap items-center gap-2">
                                        <Show when={row.rowType === "skill"}>
                                          <span class="inline-flex items-center rounded-full bg-purple-3/80 px-2 py-0.5 text-[10px] font-medium text-purple-11">
                                            {tr("session.timeline_badge_skill")}
                                          </span>
                                        </Show>
                                        <Show when={entry.task.isTask && !entry.task.isInternal}>
                                          <span class="inline-flex items-center rounded-full bg-blue-3/80 px-2 py-0.5 text-[10px] font-medium text-blue-11">
                                            {tr("session.timeline_badge_subagent")}
                                          </span>
                                        </Show>
                                        <Show when={entry.task.agentType}>
                                          {(agentType) => <span class="text-[11px] text-gray-9">{agentType()} {__vesloT("ui.literal.agent_m65q5i", __vesloCurrentLocale())}</span>}
                                        </Show>
                                        <Show when={entry.task.isInternal}>
                                          <span class="text-[11px] text-gray-9">{tr("session.timeline_internal_processing")}</span>
                                        </Show>
                                        <Show when={Boolean(entry.task.sessionId && props.openSessionById && !entry.task.isInternal)}>
                                          <button
                                            type="button"
                                            class="text-[11px] text-blue-11 hover:text-blue-10 underline underline-offset-2"
                                            onClick={(event) => {
                                              event.preventDefault();
                                              event.stopPropagation();
                                              const sessionId = entry.task.sessionId;
                                              if (!sessionId) return;
                                              props.openSessionById?.(sessionId);
                                            }}
                                          >
                                            {tr("session.open")}
                                          </button>
                                        </Show>
                                      </div>

                                      <Show when={canShowTimelineTechnicalDetail(entry)}>
                                        <details class="mt-2">
                                          <summary class="font-product type-ui-xs inline-flex cursor-pointer list-none items-center gap-1 text-gray-10 hover:text-gray-11">
                                            <ChevronDown size={12} class="shrink-0" />
                                            {tr("session.timeline_technical_detail")}
                                          </summary>
                                          <pre class="font-mono type-ui-xs mt-1 whitespace-pre-wrap break-all rounded-xl bg-gray-2 px-2 py-1 text-gray-10">
                                            <code>{row.technicalDetail}</code>
                                          </pre>
                                        </details>
                                      </Show>
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </section>
                )}
              </For>
              <Show when={hasRunning()}>
                <div class="h-2" />
              </Show>
            </div>
          </Show>
        </Show>
      </div>
    );
  };

  const renderBlock = (block: MessageBlockItem, blockIndex: number) => {
    const blockMessageIds = block.kind === "progress-group" ? block.messageIds : [block.messageId];
    const hasSearchMatch = blockMessageIds.some((id) => props.searchMatchMessageIds?.has(id));
    const hasActiveSearchMatch = blockMessageIds.some((id) => id === props.activeSearchMessageId);
    const searchOutlineClass = hasActiveSearchMatch
      ? "outline outline-2 outline-amber-8/70 outline-offset-2 rounded-2xl"
      : hasSearchMatch
        ? "outline outline-1 outline-amber-7/50 outline-offset-1 rounded-2xl"
        : "";

    if (block.kind === "progress-group") {
      const stepGroups = block.items
        .filter((item): item is Extract<ProgressGroupItem, { kind: "steps" }> => item.kind === "steps")
        .map((item) => ({ id: item.id, parts: item.parts, mode: item.mode }));
      return (
        <div
          class="flex group justify-start"
          data-message-role="assistant"
          data-message-id={block.messageIds[0] ?? ""}
          style={blockPerfStyle(blockIndex)}
        >
          <div
            class={`w-full relative max-w-[960px] text-gray-12 group ${searchOutlineClass}`}
            data-testid="session-progress-group"
          >
            <StepsContainer
              id={block.id}
              relatedIds={stepGroups.map((stepGroup) => stepGroup.id).filter((stepId) => stepId !== block.id)}
              stepGroups={stepGroups}
              progressItems={block.items}
              isUser={false}
            />
          </div>
        </div>
      );
    }

    const groupSpacing = block.isUser ? "mb-3" : "mb-4";
    const isSyntheticSessionError =
      !block.isUser && block.messageId.startsWith(SYNTHETIC_SESSION_ERROR_MESSAGE_PREFIX);
    const textGroups = () =>
      block.groups.filter(
        (group): group is { kind: "text"; part: Part; segment: "intent" | "result" } => group.kind === "text",
      );
    const inlineStepGroups = () =>
      block.groups
        .filter((group) => group.kind === "steps")
        .map((group) => {
          const stepGroup = group as {
            kind: "steps";
            id: string;
            parts: Part[];
            segment: "execution";
            mode: StepGroupMode;
          };
          return { id: stepGroup.id, parts: stepGroup.parts, mode: stepGroup.mode };
        });
    const editableMessage = () =>
      props.editableUserMessage?.messageId === block.messageId ? props.editableUserMessage : null;
    const pendingMessageState = () => props.pendingMessageStateById?.[block.messageId] ?? null;

    if (isSyntheticSessionError) {
      const messageText = block.renderableParts
        .map((part) => partToText(part))
        .join(" ")
        .replace(/\s*\n+\s*/g, " ")
        .replace(/\s{2,}/g, " ")
        .trim();

      return (
        <div
          class="flex group justify-start"
          data-message-role="assistant"
          data-message-id={block.messageId}
          style={blockPerfStyle(blockIndex)}
        >
          <div class={`w-full relative max-w-[960px] ${searchOutlineClass}`}>
            <div
              class="font-reading type-reading-md inline-flex max-w-full items-start gap-2 rounded-[18px] border border-red-7/20 bg-red-1/35 px-3 py-2 text-red-12 shadow-sm"
              role="alert"
            >
              <CircleAlert size={14} class="mt-0.5 shrink-0" />
              <div class="min-w-0 break-words">{messageText}</div>
            </div>
          </div>
        </div>
      );
    }

    return (
            <div
              class={`flex group ${block.isUser ? "justify-end" : "justify-start"}`.trim()}
              data-message-role={block.isUser ? "user" : "assistant"}
              data-message-id={block.messageId}
              style={blockPerfStyle(blockIndex)}
            >
              <div
                class={`w-full relative ${
                  block.isUser
                    ? "font-reading type-reading-md max-w-[80%] px-5 py-3 rounded-[24px] bg-gray-3 text-gray-12"
                    : "font-reading type-reading-md max-w-[960px] text-gray-12 antialiased group"
                } ${searchOutlineClass}`}
              >
                <Show when={attachmentsForMessage(block.message).length > 0}>
                  <div class={block.isUser ? "mb-3 flex flex-wrap gap-2" : "mb-4 flex flex-wrap gap-2"}>
                    <For each={attachmentsForMessage(block.message)}>
                      {(attachment) => (
                        <div class="font-product type-ui-sm flex items-center gap-2 rounded-2xl border border-gray-6 bg-gray-1/70 px-3 py-2 text-gray-11">
                          <Show
                            when={isImageAttachment(attachment.mime)}
                            fallback={<File size={14} class="text-gray-9" />}
                          >
                            <div class="h-12 w-12 rounded-xl bg-gray-2 overflow-hidden border border-gray-6">
                              <img
                                src={attachment.url}
                                alt={attachment.filename}
                                class="h-full w-full object-cover"
                              />
                            </div>
                          </Show>
                          <div class="max-w-[180px]">
                            <div class="truncate text-gray-12">{attachment.filename}</div>
                            <div class="font-product type-ui-xs text-gray-9">{attachment.mime}</div>
                          </div>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                <For each={textGroups()}>
                  {(group, idx) => (
                    <div class={idx() === textGroups().length - 1 ? "" : groupSpacing}>
                      {(() => {
                        const isStreamingLatestAssistant =
                          !block.isUser && props.isStreaming && block.messageId === latestAssistantMessageId();
                        const markdownThrottleMs = isStreamingLatestAssistant ? 550 : 100;
                        return (
                          <PartView
                            part={group.part}
                            developerMode={props.developerMode}
                            showThinking={props.showThinking}
                            workspaceRoot={props.workspaceRoot}
                            tone={block.isUser ? "dark" : "light"}
                            renderMarkdown={!block.isUser}
                            markdownThrottleMs={markdownThrottleMs}
                            highlightQuery={hasSearchMatch ? props.searchHighlightQuery : undefined}
                          />
                        );
                      })()}
                    </div>
                  )}
                </For>
                <Show when={inlineStepGroups().length > 0}>
                  <StepsContainer
                    id={inlineStepGroups()[0]!.id}
                    relatedIds={inlineStepGroups().map((stepGroup) => stepGroup.id).filter((stepId) => stepId !== inlineStepGroups()[0]!.id)}
                    stepGroups={inlineStepGroups()}
                    isUser={block.isUser}
                    isInline={true}
                  />
                </Show>
                <Show when={block.isUser && pendingMessageState()?.state === "error"}>
                  <div
                    class="mt-2 flex items-center gap-1.5 font-product type-ui-xs text-red-11"
                    title={pendingMessageState()?.error ?? undefined}
                    role="status"
                  >
                    <CircleAlert size={12} />
                    <span>{tr("session.pending_submit_failed")}</span>
                  </div>
                </Show>
                <div class="absolute bottom-2 right-2 flex justify-end gap-1 opacity-100 pointer-events-auto md:opacity-0 md:pointer-events-none md:group-hover:opacity-100 md:group-hover:pointer-events-auto md:group-focus-within:opacity-100 md:group-focus-within:pointer-events-auto transition-opacity select-none">
                  <Show when={editableMessage()}>
                    {(editable) => (
                      <button
                        class="text-dls-secondary hover:text-dls-text p-1 rounded hover:bg-dls-hover transition-colors"
                        title={tr("session.edit_message_title")}
                        aria-label={tr("session.edit_message_title")}
                        onClick={() => props.onEditUserMessage?.(editable())}
                      >
                        <Pencil size={12} />
                      </button>
                    )}
                  </Show>
                  <button
                    class="text-dls-secondary hover:text-dls-text p-1 rounded hover:bg-dls-hover transition-colors"
                    title={__vesloT("ui.literal.copy_message_1b3i55", __vesloCurrentLocale())}
                    onClick={() => {
                      const text = block.renderableParts
                        .map((part) => partToText(part))
                        .join("\n");
                      handleCopy(text, block.messageId);
                    }}
                  >
                    <Show when={copyingId() === block.messageId} fallback={<Copy size={12} />}>
                      <Check size={12} class="text-green-10" />
                    </Show>
                  </button>
                </div>
              </div>
            </div>
          );
        };

  return (
    <div class="pb-24" style={{ contain: "layout paint style" }}>
      <Show
        when={shouldVirtualize()}
        fallback={(
          <div class="space-y-4">
            <For each={messageBlocks()}>{(block, blockIndex) => renderBlock(block, blockIndex())}</For>
          </div>
        )}
      >
        <Show
          when={virtualRows().length > 0}
          fallback={(
            <div class="space-y-4">
              <For each={messageBlocks()}>{(block, blockIndex) => renderBlock(block, blockIndex())}</For>
            </div>
          )}
        >
          <div
            class="relative"
            style={{
              height: `${virtualizer.getTotalSize()}px`,
              width: "100%",
            }}
          >
            <For each={virtualRowIndices()}>
              {(rowIndex) => {
                const virtualRow = virtualRowByIndex().get(rowIndex);
                if (!virtualRow) return null;
                const block = messageBlocks()[rowIndex];
                if (!block) return null;
                return (
                  <div
                    data-index={rowIndex}
                    ref={(el) => virtualizer.measureElement(el)}
                    class="absolute left-0 top-0 w-full pb-4"
                    style={{
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  >
                    {renderBlock(block, rowIndex)}
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </Show>
      <Show when={props.footer}>{props.footer}</Show>
    </div>
  );
}
