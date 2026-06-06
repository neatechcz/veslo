import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import type { Agent } from "@opencode-ai/sdk/v2/client";
import fuzzysort from "fuzzysort";
import { ArrowUp, File as FileIcon, Loader2, Paperclip, Square, Terminal, X, Zap } from "lucide-solid";

import type { ComposerAttachment, ComposerDraft, ComposerPart, PromptMode, SlashCommandOption } from "../../types";
import { perfNow, recordPerfLog } from "../../lib/perf-log";
import { readClipboardFilePaths } from "../../lib/tauri";
import { currentLocale, t, useTranslate } from "../../../i18n";
import { extractFileReferencePathsFromDataTransfer, extractFilesFromDataTransfer, isFileDragTransfer } from "../../utils/data-transfer-files";
import { looksLikePdfDocumentPrefix } from "../../utils/pdf-signature";


type MentionOption = {
  id: string;
  kind: "agent" | "file";
  label: string;
  value: string;
  display: string;
  recent?: boolean;
};

type MentionGroup = {
  category: "agent" | "recent" | "file";
  items: MentionOption[];
};

export type ComposerSendOptions = {
  sendNow?: boolean;
  source?: "button" | "enter" | "ctrl-enter";
};

type ComposerProps = {
  initialDraft: ComposerDraft;
  prompt: string;
  developerMode: boolean;
  busy: boolean;
  isStreaming: boolean;
  stopShortcutConfirmPending?: boolean;
  compactTopSpacing?: boolean;
  compactWidth?: boolean;
  entryPlacement?: "footer" | "center";
  onSend: (draft: ComposerDraft, options?: ComposerSendOptions) => Promise<boolean>;
  onStop: () => void;
  onDraftChange: (draft: ComposerDraft) => void;
  selectedAgent: string | null;
  onSelectAgent: (agent: string | null) => void;
  showNotionBanner: boolean;
  onNotionBannerClick: () => void;
  toast: string | null;
  onToast: (message: string) => void;
  listAgents: () => Promise<Agent[]>;
  recentFiles: string[];
  searchFiles: (query: string) => Promise<string[]>;
  isRemoteWorkspace: boolean;
  isSandboxWorkspace: boolean;
  localWorkspacePath?: string | null;
  canChooseSessionFolder: boolean;
  onChooseSessionFolder: () => Promise<void> | void;
  attachmentsEnabled: boolean;
  attachmentsDisabledReason: string | null;
  listCommands: () => Promise<SlashCommandOption[]>;
  engineReady?: boolean;
};

const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;
const IMAGE_COMPRESS_MAX_PX = 2048;
const IMAGE_COMPRESS_QUALITY = 0.82;
const IMAGE_COMPRESS_TARGET_BYTES = 1_500_000;
const ACCEPTED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const PDF_SIGNATURE_SCAN_BYTES = 2048;

const isImageMime = (mime: string) => ACCEPTED_IMAGE_TYPES.includes(mime);

const formatFileSize = (bytes: number) => {
  const mb = bytes / (1024 * 1024);
  if (mb >= 10 || Number.isInteger(mb)) return `${Math.round(mb)} MB`;
  return `${Math.round(mb * 10) / 10} MB`;
};

function recordSendTrace(event: string, payload?: Record<string, unknown>) {
  if (typeof window === "undefined") return;
  try {
    const root = window as typeof window & {
      __vesloSendTrace?: Array<Record<string, unknown>>;
    };
    const logs = root.__vesloSendTrace ?? [];
    logs.push({
      at: new Date().toISOString(),
      source: "composer",
      event,
      ...(payload ?? {}),
    });
    if (logs.length > 120) logs.splice(0, logs.length - 120);
    root.__vesloSendTrace = logs;
  } catch {
    // ignore
  }
}

const fileToDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(t("session.attachment_read_failed", currentLocale())));
    reader.onload = () => {
      const result = typeof reader.result === "string" ? reader.result : "";
      resolve(result);
    };
    reader.readAsDataURL(file);
  });

/**
 * Compress an image file to JPEG using OffscreenCanvas (off main thread when possible).
 * Falls back to regular canvas if OffscreenCanvas is unavailable.
 * Returns a new File with compressed data, or the original if compression isn't beneficial.
 */
const compressImageFile = async (file: File): Promise<File> => {
  // Skip GIFs (animated) and already-small images
  if (file.type === "image/gif" || file.size <= IMAGE_COMPRESS_TARGET_BYTES) {
    return file;
  }

  const bitmap = await createImageBitmap(file);
  const { width, height } = bitmap;

  // Calculate scaled dimensions
  const maxDim = Math.max(width, height);
  const scale = maxDim > IMAGE_COMPRESS_MAX_PX ? IMAGE_COMPRESS_MAX_PX / maxDim : 1;
  const targetW = Math.round(width * scale);
  const targetH = Math.round(height * scale);

  let blob: Blob | null = null;

  if (typeof OffscreenCanvas !== "undefined") {
    const offscreen = new OffscreenCanvas(targetW, targetH);
    const ctx = offscreen.getContext("2d");
    if (ctx) {
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      blob = await offscreen.convertToBlob({ type: "image/jpeg", quality: IMAGE_COMPRESS_QUALITY });
    }
  }

  if (!blob) {
    const canvas = document.createElement("canvas");
    canvas.width = targetW;
    canvas.height = targetH;
    const ctx = canvas.getContext("2d");
    if (!ctx) return file;
    ctx.drawImage(bitmap, 0, 0, targetW, targetH);
    blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", IMAGE_COMPRESS_QUALITY),
    );
  }

  bitmap.close();

  if (!blob || blob.size >= file.size) {
    return file; // Compression didn't help
  }

  const ext = file.name.replace(/\.[^.]+$/, "");
  return new File([blob], `${ext || "image"}.jpg`, { type: "image/jpeg" });
};

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

const normalizeText = (value: string) => value.replace(/\u00a0/g, " ");
const readEditorText = (editor: HTMLElement | undefined) => normalizeText(editor?.textContent ?? "");
const RECENT_EMIT_TTL_MS = 30_000;
const MAX_RECENT_EMITS = 400;
const DRAFT_FLUSH_DEBOUNCE_MS = 140;

const partsToText = (parts: ComposerPart[]) =>
  parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "agent") return `@${part.name}`;
      if (part.type === "file") return `@${part.path}`;
      return part.label;
    })
    .join("");

const partsToResolvedText = (parts: ComposerPart[]) =>
  parts
    .map((part) => {
      if (part.type === "text") return part.text;
      if (part.type === "agent") return `@${part.name}`;
      if (part.type === "file") return `@${part.path}`;
      return part.text;
    })
    .join("");

const createMentionSpan = (part: Extract<ComposerPart, { type: "agent" | "file" }>) => {
  const span = document.createElement("span");
  const label = part.type === "agent" ? part.name : part.path;
  span.textContent = `@${label}`;
  span.contentEditable = "false";
  span.dataset.mentionKind = part.type;
  span.dataset.mentionValue = part.type === "agent" ? part.name : part.path;
  span.dataset.mentionLabel = label;
  span.className =
    "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-gray-3 text-gray-11 border border-gray-6";
  return span;
};

const createSlashSpan = (cmd: SlashCommandOption) => {
  const span = document.createElement("span");
  span.textContent = `/${cmd.name}`;
  span.contentEditable = "false";
  span.dataset.slashCommand = cmd.name;
  span.dataset.slashSource = cmd.source ?? "command";
  span.title = cmd.source ? `${cmd.source} command` : "command";

  const tone =
    cmd.source === "skill"
      ? "bg-indigo-3/20 text-indigo-11 border-indigo-7/30"
      : cmd.source === "mcp"
        ? "bg-purple-3/15 text-purple-11 border-purple-7/30"
        : "bg-blue-3/15 text-blue-11 border-blue-7/30";

  span.className = `inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold border ${tone}`;
  return span;
};

const insertTextWithBreaks = (target: HTMLElement, text: string) => {
  const chunks = text.split("\n");
  chunks.forEach((chunk, index) => {
    if (chunk.length) {
      target.appendChild(document.createTextNode(chunk));
    }
    if (index < chunks.length - 1) {
      target.appendChild(document.createElement("br"));
    }
  });
};

const sanitizePastedPlainText = (value: string) => normalizeText(value).replace(/\r\n?/g, "\n");

const htmlToPlainText = (html: string) => {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.innerText ?? "";
};

const countLines = (value: string) => (value ? value.split("\n").length : 0);

const textToFragment = (text: string) => {
  const frag = document.createDocumentFragment();
  const chunks = text.split("\n");
  chunks.forEach((chunk, index) => {
    if (chunk.length) frag.appendChild(document.createTextNode(chunk));
    if (index < chunks.length - 1) frag.appendChild(document.createElement("br"));
  });
  return frag;
};

const buildPartsFromEditor = (root: HTMLElement, pasteTextById?: Map<string, string>): ComposerPart[] => {
  const parts: ComposerPart[] = [];
  const pushText = (text: string) => {
    if (!text) return;
    const last = parts[parts.length - 1];
    if (last?.type === "text") {
      last.text += text;
      return;
    }
    parts.push({ type: "text", text });
  };

  const walk = (node: Node) => {
    if (node.nodeType === Node.TEXT_NODE) {
      pushText(node.textContent ?? "");
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as HTMLElement;
    if (el.dataset.mentionKind) {
      const kind = el.dataset.mentionKind === "agent" ? "agent" : "file";
      if (kind === "agent") {
        parts.push({ type: "agent", name: el.dataset.mentionValue ?? "" });
      } else {
        parts.push({ type: "file", path: el.dataset.mentionValue ?? "", label: el.dataset.mentionLabel ?? undefined });
      }
      return;
    }
    if (el.dataset.pasteId) {
      const id = el.dataset.pasteId ?? "";
      const label = el.dataset.pasteLabel ?? el.textContent ?? "[pasted text]";
      const lines = Number(el.dataset.pasteLines ?? "0") || 0;
      const text = pasteTextById?.get(id) ?? label;
      parts.push({ type: "paste", id, label, text, lines });
      return;
    }
    if (el.tagName === "BR") {
      pushText("\n");
      return;
    }
    if (el.tagName === "DIV") {
      if (!el.childNodes.length) {
        pushText("\n");
        return;
      }
      el.childNodes.forEach(walk);
      pushText("\n");
      return;
    }
    el.childNodes.forEach(walk);
  };

  root.childNodes.forEach(walk);
  return parts;
};

const getSelectionOffsets = (root: HTMLElement) => {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const startRange = range.cloneRange();
  startRange.selectNodeContents(root);
  startRange.setEnd(range.startContainer, range.startOffset);
  const endRange = range.cloneRange();
  endRange.selectNodeContents(root);
  endRange.setEnd(range.endContainer, range.endOffset);
  return {
    start: startRange.toString().length,
    end: endRange.toString().length,
  };
};

const restoreSelectionOffsets = (root: HTMLElement, offsets: { start: number; end: number }) => {
  const selection = window.getSelection();
  if (!selection) return;

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let node: Node | null;
  let current = 0;
  let startNode: Node | null = null;
  let endNode: Node | null = null;
  let startOffset = 0;
  let endOffset = 0;

  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!startNode && current + length >= offsets.start) {
      startNode = node;
      startOffset = offsets.start - current;
    }
    if (!endNode && current + length >= offsets.end) {
      endNode = node;
      endOffset = offsets.end - current;
      break;
    }
    current += length;
  }

  const range = document.createRange();
  if (!startNode || !endNode) {
    range.selectNodeContents(root);
    range.collapse(false);
  } else {
    range.setStart(startNode, clamp(startOffset, 0, (startNode.textContent ?? "").length));
    range.setEnd(endNode, clamp(endOffset, 0, (endNode.textContent ?? "").length));
  }
  selection.removeAllRanges();
  selection.addRange(range);
};

const buildRangeFromOffsets = (root: HTMLElement, start: number, end: number) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  let node: Node | null;
  let current = 0;
  let startNode: Node | null = null;
  let endNode: Node | null = null;
  let startOffset = 0;
  let endOffset = 0;

  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (!startNode && current + length >= start) {
      startNode = node;
      startOffset = start - current;
    }
    if (!endNode && current + length >= end) {
      endNode = node;
      endOffset = end - current;
      break;
    }
    current += length;
  }

  const range = document.createRange();
  if (!startNode || !endNode) {
    range.selectNodeContents(root);
    range.collapse(false);
    return range;
  }
  range.setStart(startNode, clamp(startOffset, 0, (startNode.textContent ?? "").length));
  range.setEnd(endNode, clamp(endOffset, 0, (endNode.textContent ?? "").length));
  return range;
};

export default function Composer(props: ComposerProps) {
  const translate = useTranslate();
  const composerWidthClass = createMemo(() => "max-w-[960px]");
  const rootClass = createMemo(() =>
    props.entryPlacement === "center"
      ? "relative z-20 bg-transparent px-0 pt-0 pb-0"
      : `sticky bottom-0 z-20 bg-gradient-to-t from-gray-1 via-gray-1 to-transparent px-8 ${props.compactTopSpacing ? "pt-0" : "pt-12"} pb-3`,
  );
  let editorRef: HTMLDivElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let mentionSearchRun = 0;
  let suppressPromptSync = false;
  let pasteCounter = 0;
  let draftScheduledAt = 0;
  let lastInputAt = 0;
  let fileDragDepth = 0;
  const pasteTextById = new Map<string, string>();
  // Track IME composition state so we can combine it with keyCode === 229 to
  // reliably suppress Enter during CJK input across Chrome, Safari, and WebKit.
  let imeComposing = false;
  const [mentionIndex, setMentionIndex] = createSignal(0);
  const [mentionQuery, setMentionQuery] = createSignal("");
  const [mentionOpen, setMentionOpen] = createSignal(false);
  const [searchResults, setSearchResults] = createSignal<string[]>([]);
  const [attachments, setAttachments] = createSignal<ComposerAttachment[]>(
    (props.initialDraft.attachments ?? []).map((attachment) => ({ ...attachment })),
  );
  const [draftText, setDraftText] = createSignal(normalizeText(props.initialDraft.text ?? props.prompt));
  const [mode, setMode] = createSignal<PromptMode>(props.initialDraft.mode ?? "prompt");
  const [historySnapshot, setHistorySnapshot] = createSignal<ComposerDraft | null>(null);
  const [historyIndex, setHistoryIndex] = createSignal({ prompt: -1, shell: -1 });
  const [history, setHistory] = createSignal({ prompt: [] as ComposerDraft[], shell: [] as ComposerDraft[] });
  const [fileDragOver, setFileDragOver] = createSignal(false);
  const attachmentsDisabled = createMemo(() => !props.attachmentsEnabled);
  const hasDraftContent = createMemo(() => draftText().trim().length > 0 || attachments().length > 0);
  const isReadonly = createMemo(() => props.selectedAgent === "plan");

  const createPasteSpan = (part: Extract<ComposerPart, { type: "paste" }>) => {
    pasteTextById.set(part.id, part.text);
    const span = document.createElement("span");
    span.textContent = part.label;
    span.contentEditable = "false";
    span.dataset.pasteId = part.id;
    span.dataset.pasteLabel = part.label;
    span.dataset.pasteLines = String(part.lines);
    span.title = translate("session.click_expand_paste");
    span.className =
      "inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-semibold bg-gray-3 text-gray-10 border border-gray-6 cursor-pointer hover:bg-gray-4 hover:text-gray-11";
    return span;
  };

  // Slash command state
  const [slashOpen, setSlashOpen] = createSignal(false);
  const [slashQuery, setSlashQuery] = createSignal("");
  const [slashIndex, setSlashIndex] = createSignal(0);
  const [slashCommands, setSlashCommands] = createSignal<SlashCommandOption[]>([]);
  const [slashLoading, setSlashLoading] = createSignal(false);

  onMount(() => {
    queueMicrotask(() => focusEditorEnd());

    // Bind composition events directly via addEventListener because SolidJS
    // does not delegate compositionstart/compositionend — the camelCase JSX
    // form (onCompositionStart) may silently fail to attach.
    if (editorRef) {
      editorRef.addEventListener("compositionstart", () => {
        imeComposing = true;
      });
      editorRef.addEventListener("compositionend", () => {
        requestAnimationFrame(() => {
          imeComposing = false;
        });
      });
    }

    const clearDragState = () => {
      clearFileDragState();
    };
    window.addEventListener("dragend", clearDragState);
    window.addEventListener("drop", clearDragState);
    onCleanup(() => {
      window.removeEventListener("dragend", clearDragState);
      window.removeEventListener("drop", clearDragState);
    });
  });

  const mentionGroups = createMemo<MentionGroup[]>(() => {
    if (!mentionOpen()) return [];
    const query = mentionQuery().trim().toLowerCase();
    const seen = new Set<string>();
    const recentFiles: MentionOption[] = props.recentFiles
      .filter((file: string) => {
        if (!file) return false;
        if (seen.has(file)) return false;
        seen.add(file);
        return true;
      })
      .map((file: string) => ({
        id: `file:${file}`,
        kind: "file" as const,
        label: file,
        value: file,
        display: file,
        recent: true,
      }));
    const searchFiles: MentionOption[] = searchResults()
      .filter((file: string) => file && !seen.has(file))
      .map((file: string) => ({
        id: `file:${file}`,
        kind: "file" as const,
        label: file,
        value: file,
        display: file,
      }));
    const all = [...recentFiles, ...searchFiles];
    const list = query
      ? fuzzysort.go(query, all, { keys: ["display"] }).map((entry: any) => entry.obj)
      : all;
    const groups: MentionGroup[] = [];
    const bucket = new Map<MentionGroup["category"], MentionOption[]>();
    for (const item of list) {
      const category = item.recent ? "recent" : "file";
      const current = bucket.get(category);
      if (current) {
        current.push(item);
        continue;
      }
      bucket.set(category, [item]);
    }
    const order: MentionGroup["category"][] = ["file", "recent"];
    for (const category of order) {
      const items = bucket.get(category);
      if (!items?.length) continue;
      groups.push({ category, items });
    }
    return groups;
  });

  const mentionOptions = createMemo(() => mentionGroups().flatMap((group: MentionGroup) => group.items));
  const mentionVisible = createMemo(() => mentionOptions().slice(0, 10));

  createEffect(() => {
    if (!mentionOpen()) return;
    mentionOptions();
    setMentionIndex(0);
  });

  // Track recent emits to distinguish echoes from external updates.
  // Keep a bounded, time-windowed set so stale echoes cannot win races.
  const recentEmits = new Map<string, number>();
  const rememberRecentEmit = (value: string) => {
    const now = Date.now();
    if (recentEmits.has(value)) {
      recentEmits.delete(value);
    }
    recentEmits.set(value, now);

    for (const [key, timestamp] of recentEmits) {
      if (now - timestamp <= RECENT_EMIT_TTL_MS) break;
      recentEmits.delete(key);
    }

    while (recentEmits.size > MAX_RECENT_EMITS) {
      const oldest = recentEmits.keys().next();
      if (oldest.done) break;
      recentEmits.delete(oldest.value);
    }
  };

  const resetRecentEmits = (value: string) => {
    recentEmits.clear();
    rememberRecentEmit(value);
  };

  // Sync from props: ignore echoes of what we just sent
  createEffect(() => {
    if (!editorRef) return;
    const value = props.prompt;
    const current = readEditorText(editorRef);

    // Robust Echo Cancellation:
    // If the incoming value matches ANY recently emitted text, it's a stale echo or confirmation.
    // We ignore it to prevent overwriting the user's newer local state.
    if (recentEmits.has(value)) {
      // If we've converged (parent matches local), we can clean up the set to save memory,
      // but keeping a few items is cheap and safer for race conditions.
      if (value === current) {
        resetRecentEmits(value);
        setDraftText(value);
      }
      return;
    }

    // If we get here, 'value' is something we didn't send recently.
    // It must be an external event (History Navigation, Clear, Agent Action, etc).

    if (suppressPromptSync) {
      if (!value && current) {
        setEditorText("");
        setAttachments([]);
        setHistoryIndex((currentIndex: { prompt: number; shell: number }) => ({ ...currentIndex, [mode()]: -1 }));
        setHistorySnapshot(null);
        queueMicrotask(() => focusEditorEnd());
      }
      return;
    }
    if (value === current) {
      // Even if it matches current, make sure it's tracked as a valid base state
      rememberRecentEmit(value);
      setDraftText(value);
      return;
    }

    // External update confirmed
    if (value.startsWith("!") && mode() === "prompt") {
      setMode("shell");
      setEditorText(value.slice(1).trimStart());
      rememberRecentEmit(value);
      emitDraftChange();
      queueMicrotask(() => focusEditorEnd());
      return;
    }

    rememberRecentEmit(value); // It's now the new baseline
    setEditorText(value);
    if (!value) {
      setAttachments([]);
      setHistoryIndex((currentIndex: { prompt: number; shell: number }) => ({ ...currentIndex, [mode()]: -1 }));
      setHistorySnapshot(null);
    }

    // We don't emitDraftChange here usually, to avoid loops, but if we changed text we might need to?
    // Actually original code did emitDraftChange(). Let's keep it but be careful.
    // If we emit, we add to Set again.
    emitDraftChange();
    queueMicrotask(() => focusEditorEnd());
  });

  let emitTimer: number | null = null;
  const emitDraftChange = () => {
    if (!editorRef) return;
    draftScheduledAt = perfNow();

    if (emitTimer) window.clearTimeout(emitTimer);
    emitTimer = window.setTimeout(() => {
      flushDraftChange();
    }, DRAFT_FLUSH_DEBOUNCE_MS);
  };

  const flushDraftChange = () => {
    const flushStartedAt = perfNow();
    const queuedMs = draftScheduledAt > 0 ? Math.round((flushStartedAt - draftScheduledAt) * 100) / 100 : null;
    if (emitTimer) {
      window.clearTimeout(emitTimer);
      emitTimer = null;
    }
    if (!editorRef) return;
    const buildStartedAt = perfNow();
    const parts = buildPartsFromEditor(editorRef, pasteTextById);
    const buildMs = Math.round((perfNow() - buildStartedAt) * 100) / 100;
    const serializeStartedAt = perfNow();
    const text = normalizeText(partsToText(parts));
    const resolvedText = normalizeText(partsToResolvedText(parts));
    const serializeMs = Math.round((perfNow() - serializeStartedAt) * 100) / 100;
    setDraftText(text);

    rememberRecentEmit(text); // Track that we sent this, expect an echo later

    suppressPromptSync = true;
    const draftChangeStartedAt = perfNow();
    props.onDraftChange({
      mode: mode(),
      parts,
      attachments: attachments(),
      text,
      resolvedText,
    });
    const draftChangeMs = Math.round((perfNow() - draftChangeStartedAt) * 100) / 100;
    const totalMs = Math.round((perfNow() - flushStartedAt) * 100) / 100;
    if (
      props.developerMode &&
      ((queuedMs !== null && queuedMs >= 90) || buildMs >= 8 || serializeMs >= 8 || draftChangeMs >= 8 || totalMs >= 12 || text.length >= 2_500)
    ) {
      recordPerfLog(true, "session.input", "draft-flush", {
        queuedMs,
        buildMs,
        serializeMs,
        draftChangeMs,
        totalMs,
        chars: text.length,
        parts: parts.length,
        mode: mode(),
      });
    }
    draftScheduledAt = 0;
    queueMicrotask(() => {
      suppressPromptSync = false;
    });
  };

  const handleEditorInput = () => {
    if (submitLocked()) return;
    const startedAt = perfNow();
    const currentText = readEditorText(editorRef);
    const mentionStartedAt = perfNow();
    if (mentionOpen() || currentText.includes("@")) {
      updateMentionQuery(currentText);
    } else {
      setMentionOpen(false);
      setMentionQuery("");
    }
    const mentionMs = Math.round((perfNow() - mentionStartedAt) * 100) / 100;
    const slashStartedAt = perfNow();
    updateSlashQuery(currentText);
    const slashMs = Math.round((perfNow() - slashStartedAt) * 100) / 100;
    setDraftText(currentText);
    emitDraftChange();

    const totalMs = Math.round((perfNow() - startedAt) * 100) / 100;
    const now = Date.now();
    const sincePrevInputMs = lastInputAt > 0 ? now - lastInputAt : null;
    lastInputAt = now;

    if (props.developerMode && (totalMs >= 8 || mentionMs >= 4 || slashMs >= 4)) {
      recordPerfLog(true, "session.input", "keystroke", {
        totalMs,
        mentionMs,
        slashMs,
        sincePrevInputMs,
        chars: editorRef?.textContent?.length ?? 0,
        mentionOpen: mentionOpen(),
        slashOpen: slashOpen(),
      });
    }
  };

  const focusEditorEnd = () => {
    if (!editorRef) return;
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(editorRef);
    range.collapse(false);
    selection.removeAllRanges();
    selection.addRange(range);
    editorRef.focus();
  };

  const renderParts = (parts: ComposerPart[], keepSelection = true) => {
    if (!editorRef) return;
    const selection = keepSelection ? getSelectionOffsets(editorRef) : null;
    editorRef.innerHTML = "";
    parts.forEach((part) => {
      if (part.type === "text") {
        insertTextWithBreaks(editorRef!, part.text);
        return;
      }
      if (part.type === "paste") {
        const span = createPasteSpan(part);
        editorRef?.appendChild(span);
        editorRef?.appendChild(document.createTextNode(" "));
        return;
      }
      const span = createMentionSpan(part);
      editorRef?.appendChild(span);
      editorRef?.appendChild(document.createTextNode(" "));
    });
    if (selection) {
      restoreSelectionOffsets(editorRef, selection);
    }
  };

  const setEditorText = (value: string) => {
    if (!editorRef) return;
    setDraftText(normalizeText(value));
    renderParts(value ? [{ type: "text", text: value }] : [], false);
  };

  const updateMentionQuery = (currentText?: string) => {
    if (!editorRef) return;
    if (mode() === "shell") {
      setMentionOpen(false);
      setMentionQuery("");
      return;
    }
    const offsets = getSelectionOffsets(editorRef);
    if (!offsets || offsets.start !== offsets.end) {
      setMentionOpen(false);
      setMentionQuery("");
      return;
    }
    const text = currentText ?? readEditorText(editorRef);
    const before = text.slice(0, offsets.start);
    const match = before.match(/@(\S*)$/);
    if (!match) {
      setMentionOpen(false);
      setMentionQuery("");
      return;
    }
    setMentionQuery(match[1] ?? "");
    setMentionOpen(true);
  };

  const updateSlashQuery = (currentText?: string) => {
    if (!editorRef) return;
    if (mode() === "shell") {
      setSlashOpen(false);
      setSlashQuery("");
      return;
    }
    const text = currentText ?? readEditorText(editorRef);
    // Only trigger when the entire input matches /command (no spaces, starts with /)
    const slashMatch = text.match(/^\/(\S*)$/);
    if (!slashMatch) {
      setSlashOpen(false);
      setSlashQuery("");
      return;
    }
    setSlashQuery(slashMatch[1] ?? "");
    setSlashOpen(true);
  };

  const slashFiltered = createMemo(() => {
    if (!slashOpen()) return [];
    const query = slashQuery().trim().toLowerCase();
    const commands = slashCommands();
    if (!query) return commands.slice(0, 15);
    return fuzzysort
      .go(query, commands, { keys: ["name", "description"] })
      .map((entry: any) => entry.obj)
      .slice(0, 15);
  });

  createEffect(() => {
    if (!slashOpen()) return;
    slashFiltered();
    setSlashIndex(0);
  });

  // Refresh commands each time the slash picker opens so hot-reloaded skills
  // and commands become selectable without restarting the session view.
  createEffect(() => {
    if (!slashOpen()) return;
    setSlashLoading(true);
    props
      .listCommands()
      .then((commands) => setSlashCommands(commands))
      .catch(() => setSlashCommands([]))
      .finally(() => setSlashLoading(false));
  });

  // If the editor contains an exact /command (no spaces), auto-convert it into a styled chip.
  // This enables flows like pre-filling "/skill-creator" from other pages.
  createEffect(() => {
    if (!slashOpen()) return;
    const query = slashQuery().trim();
    if (!query) return;
    const cmd = slashCommands().find((c) => c.name === query);
    if (!cmd) return;
    handleSlashSelect(cmd);
  });

  const handleSlashSelect = (cmd: SlashCommandOption) => {
    if (submitLocked()) return;
    if (!editorRef) return;
    setSlashOpen(false);
    setSlashQuery("");
    // Replace editor content with a styled "/<command>" chip and a trailing space for args.
    const text = `/${cmd.name} `;
    editorRef.innerHTML = "";
    const chip = createSlashSpan(cmd);
    editorRef.appendChild(chip);
    editorRef.appendChild(document.createTextNode(" "));
    suppressPromptSync = true;
    props.onDraftChange({
      mode: mode(),
      parts: [{ type: "text", text }],
      attachments: attachments(),
      text,
    });
    queueMicrotask(() => {
      suppressPromptSync = false;
    });
    requestAnimationFrame(() => {
      editorRef!.focus();
      const selection = window.getSelection();
      if (selection) {
        const range = document.createRange();
        range.selectNodeContents(editorRef!);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }
    });
  };

  const insertMention = (option: MentionOption) => {
    if (submitLocked()) return;
    if (!editorRef) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    const beforeRange = range.cloneRange();
    beforeRange.selectNodeContents(editorRef);
    beforeRange.setEnd(range.endContainer, range.endOffset);
    const beforeText = normalizeText(beforeRange.toString());
    const match = beforeText.match(/@(\S*)$/);
    if (!match) return;
    const start = match.index ?? beforeText.length - match[0].length;
    const end = beforeText.length;
    const deleteRange = buildRangeFromOffsets(editorRef, start, end);
    deleteRange.deleteContents();

    const mentionPart =
      option.kind === "agent"
        ? ({ type: "agent", name: option.value } as ComposerPart)
        : ({ type: "file", path: option.value, label: option.label } as ComposerPart);
    const mentionNode = createMentionSpan(mentionPart as Extract<ComposerPart, { type: "agent" | "file" }>);
    deleteRange.insertNode(mentionNode);
    mentionNode.after(document.createTextNode(" "));

    const cursor = document.createRange();
    cursor.setStartAfter(mentionNode.nextSibling ?? mentionNode);
    cursor.collapse(true);
    selection.removeAllRanges();
    selection.addRange(cursor);
    setMentionOpen(false);
    setMentionQuery("");
    emitDraftChange();
  };

  const canNavigateHistory = (direction: "up" | "down", event: KeyboardEvent) => {
    if (!editorRef) return false;
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) return false;
    if (historyIndex()[mode()] === -1 && hasDraftContent()) return false;
    const offsets = getSelectionOffsets(editorRef);
    if (!offsets || offsets.start !== offsets.end) return false;
    const total = readEditorText(editorRef).length;
    return direction === "up" ? offsets.start === 0 : offsets.start === total;
  };

  const applyHistoryDraft = (draft: ComposerDraft | null) => {
    if (!draft) return;
    setMode(draft.mode);
    renderParts(draft.parts, false);
    setDraftText(draft.text);
    setAttachments(draft.attachments ?? []);
    props.onDraftChange(draft);
  };

  const navigateHistory = (direction: "up" | "down") => {
    const key = mode();
    const list = history()[key];
    if (!list.length) return;
    const index = historyIndex()[key];
    const nextIndex = direction === "up" ? index + 1 : index - 1;
    if (nextIndex < -1 || nextIndex >= list.length) return;

    if (index === -1 && direction === "up") {
      const parts = editorRef ? buildPartsFromEditor(editorRef, pasteTextById) : [];
      const text = normalizeText(partsToText(parts));
      const resolvedText = normalizeText(partsToResolvedText(parts));
      setHistorySnapshot({ mode: key, parts, attachments: attachments(), text, resolvedText });
    }

    setHistoryIndex((current: { prompt: number; shell: number }) => ({ ...current, [key]: nextIndex }));
    if (nextIndex === -1) {
      applyHistoryDraft(historySnapshot());
      setHistorySnapshot(null);
      return;
    }
    const target = list[list.length - 1 - nextIndex];
    applyHistoryDraft(target);
  };

  const [sending, setSending] = createSignal(false);
  const [sendNowPending, setSendNowPending] = createSignal(false);
  const submitLocked = createMemo(() => sending());
  const sendDisabled = createMemo(() => !hasDraftContent() || (props.busy && !props.isStreaming));

  const sendDraft = async (options: ComposerSendOptions = {}) => {
    if (options.sendNow && sendNowPending()) return;

    recordSendTrace("sendDraft:start", {
      busy: props.busy,
      streaming: props.isStreaming,
      sendNow: options.sendNow,
      source: options.source,
    });
    // Ensure any pending debounce updates are committed before sending
    flushDraftChange();

    if (!editorRef) return;
    const parts = buildPartsFromEditor(editorRef, pasteTextById);
    const text = normalizeText(partsToText(parts));
    const resolvedText = normalizeText(partsToResolvedText(parts));
    const draft: ComposerDraft = { mode: mode(), parts, attachments: attachments(), text, resolvedText };

    // Detect slash command: text like "/commandname arg1 arg2"
    if (text.startsWith("/")) {
      const [cmdToken, ...argTokens] = text.split(" ");
      const commandName = cmdToken.slice(1); // strip leading /
      if (commandName) {
        const matchedCommand = slashCommands().find((c) => c.name === commandName);
        if (matchedCommand) {
          draft.command = { name: commandName, arguments: argTokens.join(" ") };
        }
      }
    }

    recordHistory(draft);
    const submittedDraft = draft;
    setSending(true);
    if (options.sendNow) setSendNowPending(true);
    setMentionOpen(false);
    setMentionQuery("");
    setSlashOpen(false);
    setSlashQuery("");
    recordSendTrace("sendDraft:onSend", {
      textLength: text.length,
      attachmentCount: draft.attachments.length,
      sendNow: options.sendNow,
      source: options.source,
    });
    let sent = false;
    let sendPromise: Promise<boolean>;
    try {
      sendPromise = props.onSend(submittedDraft, options);
    } catch (error) {
      setSending(false);
      if (options.sendNow) setSendNowPending(false);
      recordSendTrace("sendDraft:onSend:error", {
        message: error instanceof Error ? error.message : String(error),
        sendNow: options.sendNow,
        source: options.source,
      });
      return;
    }
    setAttachments([]);
    setEditorText("");
    rememberRecentEmit("");
    suppressPromptSync = true;
    props.onDraftChange({
      mode: submittedDraft.mode,
      parts: [],
      attachments: [],
      text: "",
      resolvedText: "",
    });
    queueMicrotask(() => {
      suppressPromptSync = false;
    });
    setSending(false);
    try {
      sent = await sendPromise;
    } catch (error) {
      recordSendTrace("sendDraft:onSend:error", {
        message: error instanceof Error ? error.message : String(error),
        sendNow: options.sendNow,
        source: options.source,
      });
    } finally {
      if (options.sendNow) setSendNowPending(false);
    }
    recordSendTrace("sendDraft:onSend:result", {
      sent,
      busy: props.busy,
      streaming: props.isStreaming,
      sendNow: options.sendNow,
      source: options.source,
    });
    if (!sent) {
      return;
    }
    emitDraftChange();
    queueMicrotask(() => focusEditorEnd());
  };

  const recordHistory = (draft: ComposerDraft) => {
    const trimmed = draft.text.trim();
    if (!trimmed && !draft.attachments.length) return;
    setHistory((current: { prompt: ComposerDraft[]; shell: ComposerDraft[] }) => ({
      ...current,
      [draft.mode]: [...current[draft.mode], { ...draft, attachments: [] }],
    }));
    setHistoryIndex((current: { prompt: number; shell: number }) => ({ ...current, [draft.mode]: -1 }));
    setHistorySnapshot(null);
  };

  const insertFileReferencesAtSelection = (references: Array<{ path: string }>) => {
    if (!editorRef || !references.length) return false;
    let selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || !editorRef.contains(selection.getRangeAt(0).commonAncestorContainer)) {
      focusEditorEnd();
      selection = window.getSelection();
    }
    if (!selection || selection.rangeCount === 0) return false;

    const range = selection.getRangeAt(0);
    range.deleteContents();
    const fragment = document.createDocumentFragment();
    let last: ChildNode | null = null;

    for (const reference of references) {
      const mentionNode = createMentionSpan({ type: "file", path: reference.path });
      fragment.appendChild(mentionNode);
      last = fragment.appendChild(document.createTextNode(" "));
    }

    range.insertNode(fragment);
    if (last) {
      const cursor = document.createRange();
      cursor.setStartAfter(last);
      cursor.collapse(true);
      selection.removeAllRanges();
      selection.addRange(cursor);
    }

    updateMentionQuery();
    updateSlashQuery();
    emitDraftChange();
    return true;
  };

  const addAttachments = async (
    files: File[],
    transfer?: Parameters<typeof extractFileReferencePathsFromDataTransfer>[0],
    nativeFilePaths: string[] = [],
  ) => {
    if (submitLocked()) return;
    const fileReferencePaths = extractFileReferencePathsFromDataTransfer(transfer, files, nativeFilePaths);
    const largeFileReferences: Array<{ file: File; path: string; size: string; limit: string }> = [];
    const filesToAttach: File[] = [];
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) {
        const size = formatFileSize(file.size);
        const limit = formatFileSize(MAX_ATTACHMENT_BYTES);
        const referencePath = fileReferencePaths.get(file);
        if (referencePath) {
          largeFileReferences.push({ file, path: referencePath, size, limit });
          continue;
        }
        props.onToast(translate("session.attachment_reference_unavailable_for_large_file", { name: file.name, size, limit }));
        continue;
      }
      filesToAttach.push(file);
    }
    if (largeFileReferences.length) {
      insertFileReferencesAtSelection(largeFileReferences.map((item) => ({ path: item.path })));
      const first = largeFileReferences[0];
      props.onToast(
        largeFileReferences.length === 1
          ? translate("session.attachment_reference_inserted_for_large_file", {
              name: first.file.name,
              size: first.size,
              limit: first.limit,
            })
          : translate("session.attachment_references_inserted_for_large_files", {
              count: String(largeFileReferences.length),
              limit: first.limit,
            }),
      );
    }
    if (!filesToAttach.length) return;

    if (attachmentsDisabled()) {
      props.onToast(props.attachmentsDisabledReason ?? translate("session.attachments_unavailable"));
      return;
    }

    const next: ComposerAttachment[] = [];
    for (const file of filesToAttach) {
      try {
        // Compress images before encoding to data URL
        const processed = isImageMime(file.type) ? await compressImageFile(file) : file;
        const isPdfAttachment = processed.type === "application/pdf" || processed.name.toLowerCase().endsWith(".pdf");
        if (isPdfAttachment) {
          const prefix = new Uint8Array(await processed.slice(0, PDF_SIGNATURE_SCAN_BYTES).arrayBuffer());
          if (!looksLikePdfDocumentPrefix(prefix)) {
            props.onToast(translate("session.attachment_invalid_pdf", { name: file.name }));
            continue;
          }
        }
        const dataUrl = await fileToDataUrl(processed);
        // Pre-check: data URL will be embedded in JSON body; reject if too large
        const estimatedJsonBytes = dataUrl.length + 512; // data URL + JSON overhead
        if (estimatedJsonBytes > MAX_ATTACHMENT_BYTES) {
          props.onToast(translate("session.attachment_encoded_too_large", { name: file.name }));
          continue;
        }
        next.push({
          id: `${processed.name}-${file.lastModified}-${Math.random().toString(36).slice(2)}`,
          name: processed.name,
          mimeType: processed.type || "application/octet-stream",
          size: processed.size,
          kind: isImageMime(processed.type) ? "image" : "file",
          dataUrl,
        });
      } catch (error) {
        props.onToast(error instanceof Error ? error.message : translate("session.failed_read_attachment"));
      }
    }
    if (next.length) {
      setAttachments((current: ComposerAttachment[]) => [...current, ...next]);
      emitDraftChange();
    }
  };

  const insertPlainTextAtSelection = (text: string) => {
    if (!editorRef) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();
    const fragment = textToFragment(text);
    const last = fragment.lastChild;
    range.insertNode(fragment);

    if (!last) return;
    const cursor = document.createRange();
    cursor.setStartAfter(last);
    cursor.collapse(true);
    selection.removeAllRanges();
    selection.addRange(cursor);
  };

  const insertCollapsedPasteAtSelection = (text: string, lines: number) => {
    if (!editorRef) return;
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    const range = selection.getRangeAt(0);
    range.deleteContents();

    pasteCounter += 1;
    const id = `paste-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const label = `[pasted text ${pasteCounter}]`;
    const part = { type: "paste", id, label, text, lines } as const;
    const span = createPasteSpan(part);

    range.insertNode(span);
    span.after(document.createTextNode(" "));

    const cursor = document.createRange();
    cursor.setStartAfter(span.nextSibling ?? span);
    cursor.collapse(true);
    selection.removeAllRanges();
    selection.addRange(cursor);
  };

  const handleEditorClick = (event: MouseEvent) => {
    if (submitLocked()) {
      event.preventDefault();
      return;
    }
    if (!editorRef) return;
    const target = event.target as HTMLElement | null;
    const span = (target?.closest?.("span[data-paste-id]") as HTMLElement | null) ?? null;
    if (!span || !editorRef.contains(span)) return;
    const id = span.dataset.pasteId ?? "";
    if (!id) return;
    const text = pasteTextById.get(id);
    if (typeof text !== "string") return;

    event.preventDefault();
    event.stopPropagation();

    const fragment = textToFragment(text);
    const last = fragment.lastChild;
    span.replaceWith(fragment);
    pasteTextById.delete(id);

    const selection = window.getSelection();
    if (selection) {
      const cursor = document.createRange();
      if (last && last.parentNode) {
        cursor.setStartAfter(last);
        cursor.collapse(true);
      } else {
        cursor.selectNodeContents(editorRef);
        cursor.collapse(false);
      }
      selection.removeAllRanges();
      selection.addRange(cursor);
    }

    updateMentionQuery();
    updateSlashQuery();
    emitDraftChange();
  };

  const handlePaste = (event: ClipboardEvent) => {
    if (submitLocked()) {
      event.preventDefault();
      return;
    }
    if (!event.clipboardData) return;
    const clipboard = event.clipboardData;
    const allFiles = extractFilesFromDataTransfer(clipboard);
    if (allFiles.length) {
      event.preventDefault();
      void (async () => {
        const nativeFilePaths = await readClipboardFilePaths();
        await addAttachments(allFiles, clipboard, nativeFilePaths);
      })();
      return;
    }

    const plainForCheck = clipboard.getData("text/plain") ?? "";
    const trimmedForCheck = plainForCheck.trim();
    if (trimmedForCheck && (props.isSandboxWorkspace || props.isRemoteWorkspace)) {
      const hasFileUrl = /file:\/\//i.test(trimmedForCheck);
      const hasAbsolutePosix = /(^|\s)\/(Users|home|var|etc|opt|tmp|private|Volumes|Applications)\//.test(trimmedForCheck);
      const hasAbsoluteWindows = /(^|\s)[a-zA-Z]:\\/.test(trimmedForCheck);
      if (hasFileUrl || hasAbsolutePosix || hasAbsoluteWindows) {
        props.onToast(translate("session.remote_worker_local_paths_warning"));
      }
    }

    const plain = clipboard.getData("text/plain") || clipboard.getData("text") || "";
    const html = clipboard.getData("text/html") || "";
    const raw = plain || (html ? htmlToPlainText(html) : "");
    if (!raw) return;

    event.preventDefault();
    const text = sanitizePastedPlainText(raw);
    const lines = countLines(text);
    if (lines > 10) {
      insertCollapsedPasteAtSelection(text, lines);
    } else {
      insertPlainTextAtSelection(text);
    }

    updateMentionQuery();
    updateSlashQuery();
    emitDraftChange();
  };

  const clearFileDragState = () => {
    fileDragDepth = 0;
    setFileDragOver(false);
  };

  const handleDragEnter = (event: DragEvent) => {
    if (!isFileDragTransfer(event.dataTransfer)) return;
    event.preventDefault();
    if (submitLocked()) return;
    if (attachmentsDisabled()) return;
    fileDragDepth += 1;
    setFileDragOver(true);
  };

  const handleDragLeave = (event: DragEvent) => {
    if (!isFileDragTransfer(event.dataTransfer)) return;
    fileDragDepth = Math.max(0, fileDragDepth - 1);
    if (fileDragDepth === 0) {
      setFileDragOver(false);
    }
  };

  const handleDrop = (event: DragEvent) => {
    if (!event.dataTransfer || !isFileDragTransfer(event.dataTransfer)) return;
    event.preventDefault();
    clearFileDragState();
    if (submitLocked()) return;
    const files = extractFilesFromDataTransfer(event.dataTransfer);
    if (files.length) void addAttachments(files, event.dataTransfer);
  };

  const handleKeyDown = (event: KeyboardEvent) => {
    if (submitLocked()) {
      event.preventDefault();
      return;
    }
    // Make slash chips behave like single tokens.
    if ((event.key === "Backspace" || event.key === "Delete") && editorRef) {
      const selection = window.getSelection();
      if (selection && selection.rangeCount) {
        const range = selection.getRangeAt(0);
        if (!editorRef.contains(range.startContainer) || !editorRef.contains(range.endContainer)) return;

        const isSlashChip = (node: Node | null): node is HTMLElement =>
          node instanceof HTMLElement && Boolean(node.dataset.slashCommand);
        const isSingleSpace = (node: Node | null): node is Text => node instanceof Text && (node.textContent ?? "") === " ";
        const removeSlashChip = (chip: HTMLElement) => {
          const next = chip.nextSibling;
          if (isSingleSpace(next)) {
            next.parentNode?.removeChild(next);
          }
          chip.parentNode?.removeChild(chip);
        };

        if (!range.collapsed) {
          const selectedChip = Array.from(editorRef.querySelectorAll("span[data-slash-command]")).find((candidate) =>
            range.intersectsNode(candidate),
          );
          if (selectedChip instanceof HTMLElement && selectedChip.dataset.slashCommand) {
            event.preventDefault();
            removeSlashChip(selectedChip);
            emitDraftChange();
            return;
          }
        }

        const direction: "backward" | "forward" = event.key === "Backspace" ? "backward" : "forward";
        const container = range.startContainer;
        const offset = range.startOffset;

        const resolveBoundaryNode = () => {
          if (container === editorRef) {
            if (direction === "backward") {
              return offset > 0 ? editorRef.childNodes[offset - 1] : null;
            }
            return offset < editorRef.childNodes.length ? editorRef.childNodes[offset] : null;
          }

          if (container.nodeType === Node.TEXT_NODE && container.parentNode === editorRef) {
            const length = (container.textContent ?? "").length;
            if (direction === "backward") {
              if (offset === 0) return container.previousSibling;
              if (offset === length) return container;
              return null;
            }
            if (offset === length) return container.nextSibling;
            if (offset === 0) return container;
            return null;
          }

          return null;
        };

        const resolveSlashChip = (candidate: Node | null) => {
          if (isSlashChip(candidate)) return candidate;
          if (!isSingleSpace(candidate)) return null;
          const neighbor = direction === "backward" ? candidate.previousSibling : candidate.nextSibling;
          return isSlashChip(neighbor) ? neighbor : null;
        };

        const targetChip = resolveSlashChip(resolveBoundaryNode());
        if (targetChip) {
          event.preventDefault();
          removeSlashChip(targetChip);
          emitDraftChange();
          return;
        }
      }
    }

    if (event.key === "Enter" && event.shiftKey) {
      event.preventDefault();
      document.execCommand("insertLineBreak");
      emitDraftChange();
      return;
    }
    // Block Enter while IME is composing. We check three signals:
    // 1. event.isComposing — standard API (unreliable in some WebKit builds)
    // 2. imeComposing — manual flag from compositionstart/end
    // 3. event.keyCode === 229 — legacy but reliable IME indicator across all browsers
    const imeActive = event.isComposing || imeComposing || event.keyCode === 229;
    if (event.key === "Enter" && imeActive) return;

    if (mentionOpen()) {
      const options = mentionOptions();
      const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if (event.key === "Enter" && !imeActive) {
        event.preventDefault();
        const active = options[mentionIndex()] ?? options[0];
        if (active) insertMention(active);
        return;
      }
      if (event.key === "ArrowDown" || (ctrl && event.key === "n")) {
        event.preventDefault();
        if (!options.length) return;
        setMentionIndex((i: number) => (i + 1) % options.length);
        return;
      }
      if (event.key === "ArrowUp" || (ctrl && event.key === "p")) {
        event.preventDefault();
        if (!options.length) return;
        setMentionIndex((i: number) => (i - 1 + options.length) % options.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setMentionOpen(false);
        setMentionQuery("");
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const active = options[mentionIndex()] ?? options[0];
        if (active) insertMention(active);
        return;
      }
    }

    // Slash command popup keyboard navigation
    if (slashOpen()) {
      const options = slashFiltered();
      const ctrl = event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey;
      if (event.key === "Enter" && !imeActive) {
        event.preventDefault();
        const active = options[slashIndex()] ?? options[0];
        if (active) handleSlashSelect(active);
        return;
      }
      if (event.key === "ArrowDown" || (ctrl && event.key === "n")) {
        event.preventDefault();
        if (!options.length) return;
        setSlashIndex((i: number) => (i + 1) % options.length);
        return;
      }
      if (event.key === "ArrowUp" || (ctrl && event.key === "p")) {
        event.preventDefault();
        if (!options.length) return;
        setSlashIndex((i: number) => (i - 1 + options.length) % options.length);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        setSlashOpen(false);
        setSlashQuery("");
        return;
      }
      if (event.key === "Tab") {
        event.preventDefault();
        const active = options[slashIndex()] ?? options[0];
        if (active) handleSlashSelect(active);
        return;
      }
    }

    if (
      event.key === "Enter" &&
      event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !mentionOpen() &&
      !slashOpen()
    ) {
      event.preventDefault();
      document.execCommand("insertLineBreak");
      emitDraftChange();
      return;
    }

    if (
      event.key === "Tab" &&
      event.shiftKey &&
      !event.defaultPrevented &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !props.busy
    ) {
      event.preventDefault();
      props.onSelectAgent(isReadonly() ? "veslo" : "plan");
      return;
    }

    if (event.key === "!" && mode() === "prompt") {
      const offsets = editorRef ? getSelectionOffsets(editorRef) : null;
      if (offsets && offsets.start === 0 && offsets.end === 0) {
        event.preventDefault();
        setMode("shell");
        emitDraftChange();
        return;
      }
    }

    if (event.key === "Escape" && mode() === "shell") {
      event.preventDefault();
      setMode("prompt");
      emitDraftChange();
      return;
    }

    if (event.key === "ArrowUp" && canNavigateHistory("up", event)) {
      event.preventDefault();
      navigateHistory("up");
      return;
    }

    if (event.key === "ArrowDown" && canNavigateHistory("down", event)) {
      event.preventDefault();
      navigateHistory("down");
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      if (sending()) return;
      if (props.busy && !props.isStreaming) return;
      if (event.ctrlKey || event.metaKey) {
        void sendDraft({ sendNow: true, source: "ctrl-enter" });
        return;
      }
      void sendDraft({ sendNow: false, source: "enter" });
    }
  };

  // Agent loading removed — agents are no longer shown in @mention dropdown.

  createEffect(() => {
    if (!mentionOpen()) {
      setSearchResults([]);
      return;
    }
    const query = mentionQuery().trim();
    if (!query) {
      setSearchResults([]);
      return;
    }
    const runId = (mentionSearchRun += 1);
    const timeout = window.setTimeout(() => {
      props
        .searchFiles(query)
        .then((results) => {
          if (runId !== mentionSearchRun) return;
          setSearchResults(results);
        })
        .catch(() => {
          if (runId !== mentionSearchRun) return;
          setSearchResults([]);
        });
    }, 150);
    onCleanup(() => {
      window.clearTimeout(timeout);
    });
  });

  createEffect(() => {
    if (mode() !== "shell") return;
    setMentionOpen(false);
    setMentionQuery("");
    setSlashOpen(false);
    setSlashQuery("");
  });



  createEffect(() => {
    const handler = () => {
      editorRef?.focus();
    };
    window.addEventListener("veslo:focusPrompt", handler);
    onCleanup(() => window.removeEventListener("veslo:focusPrompt", handler));
  });

  onCleanup(() => {
    if (emitTimer !== null) {
      window.clearTimeout(emitTimer);
      emitTimer = null;
    }
  });

  return (
    <div
      class={rootClass()}
      style={{ contain: "layout style" }}
    >
      <div class={`mx-auto w-full ${composerWidthClass()}`}>
        <div
          class={`bg-gray-1 border border-gray-6/80 rounded-xl overflow-visible transition-all relative group/input ${
            fileDragOver() ? "border-blue-7/70 ring-2 ring-blue-7/35 bg-blue-2/20" : ""
          } ${mentionOpen() || slashOpen() ? "rounded-t-none border-t-transparent" : "shadow-[0_8px_30px_rgba(0,0,0,0.08)]"}`}
          onDragEnter={handleDragEnter}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onDragOver={(event: DragEvent) => {
            if (!isFileDragTransfer(event.dataTransfer)) return;
            event.preventDefault();
            if (submitLocked()) return;
            if (attachmentsDisabled()) return;
            setFileDragOver(true);
          }}
        >
          <Show when={fileDragOver()}>
            <div class="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-xl border-2 border-dashed border-blue-8/55 bg-blue-3/20">
              <span class="rounded-full border border-blue-8/35 bg-blue-2/80 px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.08em] text-blue-11">
                {translate("inbox.drop_files_title")}
              </span>
            </div>
          </Show>

          <Show when={mentionOpen()}>
            <div class="absolute bottom-full left-[-1px] right-[-1px] z-30">
              <div class="rounded-t-xl border border-gray-6 border-b-0 bg-gray-1 shadow-xl overflow-hidden">
                <div class="p-2 bg-gray-1 max-h-64 overflow-y-auto" onMouseDown={(event: MouseEvent) => event.preventDefault()}>
                  <Show
                    when={mentionVisible().length}
                    fallback={<div class="px-3 py-2 text-xs text-gray-10">{translate("session.no_matches_found")}</div>}
                  >
                    <For each={mentionVisible()}>
                      {(option: MentionOption) => {
                        const optionIndex = createMemo(() => mentionOptions().findIndex((item) => item.id === option.id));
                        const active = createMemo(() => mentionOptions()[mentionIndex()]?.id === option.id);
                        return (
                          <button
                            type="button"
                            class={`w-full flex items-center gap-2 rounded-xl px-3 py-2 text-left transition-colors ${active() ? "bg-gray-3 text-gray-12" : "text-gray-11 hover:bg-gray-2"
                              }`}
                            onMouseDown={(event: MouseEvent) => {
                              event.preventDefault();
                              insertMention(option);
                            }}
                            onMouseEnter={() => setMentionIndex(optionIndex())}
                          >
                            <FileIcon size={14} class="text-gray-9" />
                            <div class="flex items-center min-w-0 text-xs">
                              {(() => {
                                const value = option.value;
                                const slash = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
                                const dir = slash === -1 ? "" : value.slice(0, slash + 1);
                                const name = slash === -1 ? value : value.slice(slash + 1);
                                return (
                                  <>
                                    <span class="text-gray-9 truncate">{dir}</span>
                                    <Show when={name}>
                                      <span class="text-gray-11 font-semibold">{name}</span>
                                    </Show>
                                  </>
                                );
                              })()}
                            </div>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                </div>
              </div>
            </div>
          </Show>

          {/* Slash command popup */}
          <Show when={slashOpen()}>
            <div class="absolute bottom-full left-[-1px] right-[-1px] z-30">
              <div class="rounded-t-xl border border-gray-6 border-b-0 bg-gray-1 overflow-hidden">
                <div class="p-2 bg-gray-1 max-h-64 overflow-y-auto" onMouseDown={(event: MouseEvent) => event.preventDefault()}>
                  <Show
                    when={slashFiltered().length}
                    fallback={
                      <div class="px-3 py-2 text-xs text-gray-10">
                        {slashLoading() ? translate("session.loading_commands") : translate("session.no_commands_found")}
                      </div>
                    }
                  >
                    <For each={slashFiltered()}>
                      {(cmd: SlashCommandOption, index) => {
                        const active = createMemo(() => slashIndex() === index());
                        return (
                          <button
                            type="button"
                            class={`w-full flex items-center justify-between gap-4 rounded-xl px-3 py-2 text-left transition-colors ${active() ? "bg-gray-3 text-gray-12" : "text-gray-11 hover:bg-gray-2"
                              }`}
                            onMouseDown={(event: MouseEvent) => {
                              event.preventDefault();
                              handleSlashSelect(cmd);
                            }}
                            onMouseEnter={() => setSlashIndex(index())}
                          >
                            <div class="flex items-center gap-2 min-w-0">
                              <Terminal size={14} class="text-gray-9 shrink-0" />
                              <span class="text-xs font-semibold text-gray-11 whitespace-nowrap">/{cmd.name}</span>
                              <Show when={cmd.description}>
                                <span class="text-xs text-gray-10 truncate">{cmd.description}</span>
                              </Show>
                            </div>
                            <Show when={cmd.source && cmd.source !== "command"}>
                              <span class="text-[10px] uppercase tracking-wider text-gray-10 shrink-0">
                                {cmd.source === "skill" ? translate("dashboard.skills") : cmd.source === "mcp" ? "MCP" : ""}
                              </span>
                            </Show>
                          </button>
                        );
                      }}
                    </For>
                  </Show>
                </div>
              </div>
            </div>
          </Show>

          <div class="p-3">
            <Show when={props.showNotionBanner}>
              <button
                type="button"
                class="w-full mb-2 flex items-center justify-between gap-3 rounded-xl border border-green-7/20 bg-green-7/10 px-3 py-2 text-left text-sm text-green-12 transition-colors hover:bg-green-7/15"
                onClick={props.onNotionBannerClick}
              >
                <span>{translate("session.try_notion_prompt")}</span>
                <span class="text-xs text-green-12 font-medium">{translate("session.insert_prompt")}</span>
              </button>
            </Show>

            <Show when={attachments().length}>
              <div class="mb-3 flex flex-wrap gap-2">
                <For each={attachments()}>
                  {(attachment: ComposerAttachment) => (
                    <div class="flex items-center gap-2 rounded-2xl border border-gray-6 bg-gray-2 px-3 py-2 text-xs text-gray-10">
                      <Show
                        when={attachment.kind === "image"}
                        fallback={<FileIcon size={14} class="text-gray-9" />}
                      >
                        <div class="h-10 w-10 rounded-xl bg-gray-1 overflow-hidden border border-gray-6">
                          <img src={attachment.dataUrl} alt={attachment.name} class="h-full w-full object-cover" />
                        </div>
                      </Show>
                      <div class="max-w-[160px]">
                        <div class="truncate text-gray-11">{attachment.name}</div>
                        <div class="text-[10px] text-gray-10">
                          {attachment.kind === "image" ? translate("session.attachment_image") : attachment.mimeType || translate("session.attachment_file")}
                        </div>
                      </div>
                      <button
                        type="button"
                        class="ml-1 rounded-full p-1 text-gray-10 hover:text-gray-11 hover:bg-gray-4"
                        onClick={() => {
                          if (submitLocked()) return;
                          setAttachments((current: ComposerAttachment[]) =>
                            current.filter((item) => item.id !== attachment.id)
                          );
                          emitDraftChange();
                        }}
                        disabled={submitLocked()}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <div class="relative">
              <Show when={props.toast}>
                <div class="absolute bottom-full right-0 mb-2 z-30 rounded-xl border border-gray-6 bg-gray-1 px-3 py-2 text-xs text-gray-11 shadow-lg backdrop-blur-md">
                  <span>{props.toast}</span>
                </div>
              </Show>

              <div class="flex flex-col gap-2">
                <div class="flex-1 min-w-0">
                  <div class="relative">
                    <Show when={!hasDraftContent()}>
                      <div class="font-reading type-reading-md absolute left-0 top-0 text-gray-9 pointer-events-none">
                        {translate("session.placeholder")}
                      </div>
                    </Show>
                    <div
                      ref={editorRef}
                      contentEditable={!submitLocked()}
                      role="textbox"
                      aria-disabled={submitLocked() ? "true" : "false"}
                      aria-multiline="true"
                      onInput={handleEditorInput}
                      onKeyDown={handleKeyDown}
                      onPaste={handlePaste}
                      onClick={handleEditorClick}
                      class="font-reading type-reading-md bg-transparent border-none p-0 pb-2 pr-2 text-gray-12 focus:ring-0 whitespace-pre-wrap break-words resize-none min-h-[24px] max-h-40 overflow-y-auto overflow-x-hidden outline-none"
                    />

                    <div class="mt-3 flex items-center justify-between gap-3 pt-2">
                      <div class="flex min-w-0 flex-wrap items-center gap-2">
                        <div class="flex items-center gap-1.5">
                          <input
                            ref={fileInputRef}
                            type="file"
                            multiple
                            class="hidden"
                            disabled={attachmentsDisabled() || submitLocked()}
                            onChange={(event: Event) => {
                              const target = event.currentTarget as HTMLInputElement;
                              const files = Array.from(target.files ?? []);
                              if (files.length) void addAttachments(files);
                              target.value = "";
                            }}
                          />
                          <button
                            type="button"
                            class={`p-1.5 hover:bg-gray-3 rounded-md text-gray-10 transition-colors ${attachmentsDisabled() || submitLocked() ? "cursor-not-allowed" : ""
                              }`}
                            onClick={() => {
                              if (submitLocked()) return;
                              if (attachmentsDisabled()) return;
                              fileInputRef?.click();
                            }}
                            disabled={attachmentsDisabled() || submitLocked()}
                            title={
                              attachmentsDisabled()
                                ? props.attachmentsDisabledReason ?? translate("session.attachments_unavailable")
                                : translate("session.attach_files")
                            }
                          >
                            <Paperclip size={16} />
                          </button>
                        </div>

                        <button
                          type="button"
                          disabled={props.busy || submitLocked()}
                          class={`font-product type-ui-sm inline-flex items-center gap-1.5 rounded-lg border px-2.5 py-1 font-medium transition-colors ${
                            isReadonly()
                              ? "border-blue-6 bg-blue-3 text-blue-11"
                              : "border-gray-6/80 bg-gray-2 text-gray-10 hover:text-gray-11"
                          }`}
                          onClick={() => props.onSelectAgent(isReadonly() ? "veslo" : "plan")}
                          title={
                            isReadonly()
                              ? translate("session.readonly_mode_active_title")
                              : translate("session.readonly_mode_inactive_title")
                          }
                        >
                          <span class={`inline-block w-1.5 h-1.5 rounded-full ${isReadonly() ? "bg-blue-9" : "bg-gray-8"}`} />
                          {translate("session.readonly_mode_toggle")}
                        </button>

                        <Show when={props.canChooseSessionFolder}>
                          <button
                            type="button"
                            class="font-product type-ui-xs inline-flex shrink-0 items-center rounded-md border border-gray-6 bg-gray-2 px-2 py-1 font-bold uppercase tracking-widest text-gray-10 transition-colors hover:bg-gray-3 hover:text-gray-11"
                            disabled={submitLocked()}
                            onClick={() => {
                              if (submitLocked()) return;
                              void props.onChooseSessionFolder();
                            }}
                          >
                            {translate("session.choose_folder")}
                          </button>
                        </Show>
                      </div>

                      <div class="flex shrink-0 items-center gap-2">
                        <Show
                          when={props.isStreaming}
                          fallback={
                            <button
                              type="button"
                              disabled={sendDisabled()}
                              onClick={() => {
                                recordSendTrace("sendButton:click", {
                                  sending: sending(),
                                  busy: props.busy,
                                  hasDraftContent: hasDraftContent(),
                                });
                                if (sending() || (props.busy && !props.isStreaming)) {
                                  recordSendTrace("sendButton:blocked", {
                                    sending: sending(),
                                    busy: props.busy,
                                  });
                                  return;
                                }
                                void sendDraft({ sendNow: false, source: "button" });
                              }}
                              class={`shrink-0 p-1.5 rounded-full ${
                                sending()
                                  ? "bg-[#1B29FF] text-white pointer-events-none"
                                  : `transition-colors ${sendDisabled()
                                    ? "bg-gray-4 text-gray-10"
                                    : "bg-[#1B29FF] text-white hover:bg-blue-10"}`
                              }`}
                              title={translate("session.queue_message_label")}
                              aria-label={translate("session.queue_message_label")}
                            >
                              {sending()
                                ? <Loader2 size={18} class="animate-spin" />
                                : <ArrowUp size={18} />
                              }
                            </button>
                          }
                        >
                          <button
                            type="button"
                            onClick={() => props.onStop()}
                            class="inline-flex h-8 w-10 shrink-0 items-center justify-center rounded-full bg-gray-12 text-gray-1 transition-colors hover:bg-gray-11"
                            title={
                              props.stopShortcutConfirmPending
                                ? translate("session.stop_escape_confirm_label")
                                : translate("session.stop_label")
                            }
                            aria-label={
                              props.stopShortcutConfirmPending
                                ? translate("session.stop_escape_confirm_label")
                                : translate("session.stop_label")
                            }
                          >
                            <Show
                              when={props.stopShortcutConfirmPending}
                              fallback={<Square size={14} fill="currentColor" />}
                            >
                              <span class="font-product text-xs font-bold leading-none">Esc</span>
                            </Show>
                          </button>
                          <Show when={hasDraftContent()}>
                            <button
                              type="button"
                              onClick={() => {
                                if (sending() || sendNowPending()) return;
                                void sendDraft({ sendNow: true, source: "button" });
                              }}
                              disabled={sendNowPending()}
                              class={`shrink-0 p-1.5 rounded-full bg-[#1B29FF] text-white transition-colors ${
                                sendNowPending() ? "opacity-70" : "hover:bg-blue-10"
                              }`}
                              title={translate("session.send_now_title")}
                              aria-label={translate("session.send_now_label")}
                            >
                              <Zap size={16} />
                            </button>
                          </Show>
                        </Show>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
