import {
  createEffect,
  createMemo,
  createSignal,
  on,
  onCleanup,
  onMount,
  type Accessor,
  type Setter,
} from "solid-js";
import type { MessageWithParts } from "../types";

export const INITIAL_MESSAGE_WINDOW = 140;
export const MESSAGE_WINDOW_LOAD_CHUNK = 120;
export const STREAM_SCROLL_MIN_INTERVAL_MS = 90;
export const STREAM_RENDER_BATCH_MS = 220;

export type TranscriptWindowState = {
  windowSessionId: string | null;
  windowStart: number;
  windowExpanded: boolean;
};

export type TranscriptGrowthCounts = {
  messages: number;
  todos: number;
  parts: number;
};

export type RecordTranscriptViewportPerfLog = (
  enabled: boolean,
  category: string,
  event: string,
  payload?: Record<string, unknown>,
) => void;

export type SessionTranscriptViewportControllerDeps = {
  messages: Accessor<MessageWithParts[]>;
  optimisticSubmittedMessage: Accessor<MessageWithParts | null>;
  searchActive: Accessor<boolean>;
  sessionStatus: Accessor<string>;
  developerMode: Accessor<boolean>;
  selectedSessionId: Accessor<string | null>;
  hasEarlierMessages: Accessor<boolean>;
  isChatContainerReady: Accessor<boolean>;
  totalPartCount: Accessor<number>;
  loadEarlierMessages: (sessionId: string) => Promise<void>;
  messagesEndElement: Accessor<HTMLElement | undefined>;
  bottomVisibilityElement: Accessor<HTMLElement | undefined>;
  chatContainerElement: Accessor<HTMLElement | undefined>;
  now: () => number;
  perfNow: () => number;
  recordPerfLog: RecordTranscriptViewportPerfLog;
  queueMicrotask: (callback: () => void) => void;
};

export type SessionTranscriptViewportController = {
  renderedMessages: Accessor<MessageWithParts[]>;
  effectiveRenderedMessages: Accessor<MessageWithParts[]>;
  hiddenMessageCount: Accessor<number>;
  nextRevealCount: Accessor<number>;
  hasServerEarlierMessages: Accessor<boolean>;
  nearBottom: Accessor<boolean>;
  stickToBottom: Accessor<boolean>;
  setStickToBottom: Setter<boolean>;
  initialAnchorPending: Accessor<boolean>;
  revealEarlierMessages: () => Promise<void>;
  scheduleScrollToLatest: (behavior?: ScrollBehavior) => void;
  jumpToLatest: (behavior?: ScrollBehavior) => void;
  markSelectedSessionForInitialAnchor: (sessionId: string) => void;
};

export type ResolveRenderedTranscriptMessagesInput<T> = {
  messages: readonly T[];
  optimisticMessage: T | null;
  searchActive: boolean;
  windowExpanded: boolean;
  windowStart: number;
};

export const resolveTranscriptSourceMessages = <T,>({
  messages,
  optimisticMessage,
}: Pick<ResolveRenderedTranscriptMessagesInput<T>, "messages" | "optimisticMessage">): T[] =>
  optimisticMessage ? [...messages, optimisticMessage] : [...messages];

export const resolveRenderedTranscriptMessages = <T,>({
  messages,
  optimisticMessage,
  searchActive,
  windowExpanded,
  windowStart,
}: ResolveRenderedTranscriptMessagesInput<T>): T[] => {
  const sourceMessages = resolveTranscriptSourceMessages({ messages, optimisticMessage });
  if (windowExpanded || searchActive) return sourceMessages;
  if (windowStart <= 0) return sourceMessages;
  if (windowStart >= sourceMessages.length) return [];
  return sourceMessages.slice(windowStart);
};

export const resolveHiddenMessageCount = ({
  sourceMessageCount,
  renderedMessageCount,
  searchActive,
  windowExpanded,
}: {
  sourceMessageCount: number;
  renderedMessageCount: number;
  searchActive: boolean;
  windowExpanded: boolean;
}) => {
  if (windowExpanded || searchActive) return 0;
  const hidden = sourceMessageCount - renderedMessageCount;
  return hidden > 0 ? hidden : 0;
};

export const resolveNextRevealCount = (
  hiddenMessageCount: number,
  loadChunk = MESSAGE_WINDOW_LOAD_CHUNK,
) => {
  if (hiddenMessageCount <= 0) return 0;
  return Math.min(hiddenMessageCount, loadChunk);
};

export type RevealEarlierMessagesAction =
  | {
      kind: "reveal-window";
      nextWindowStart: number;
      expanded: boolean;
    }
  | {
      kind: "load-server-earlier";
      sessionId: string;
      nextWindowStart: 0;
      expanded: true;
    }
  | { kind: "none" };

export const resolveRevealEarlierMessagesAction = ({
  hiddenMessageCount,
  currentWindowStart,
  hasServerEarlierMessages,
  selectedSessionId,
  loadChunk = MESSAGE_WINDOW_LOAD_CHUNK,
}: {
  hiddenMessageCount: number;
  currentWindowStart: number;
  hasServerEarlierMessages: boolean;
  selectedSessionId: string | null;
  loadChunk?: number;
}): RevealEarlierMessagesAction => {
  if (hiddenMessageCount > 0) {
    const nextWindowStart = Math.max(0, currentWindowStart - loadChunk);
    return {
      kind: "reveal-window",
      nextWindowStart,
      expanded: nextWindowStart === 0,
    };
  }

  if (!hasServerEarlierMessages || !selectedSessionId) return { kind: "none" };
  return {
    kind: "load-server-earlier",
    sessionId: selectedSessionId,
    nextWindowStart: 0,
    expanded: true,
  };
};

export const resolveHasServerEarlierMessages = ({
  searchActive,
  selectedSessionId,
  hasEarlierMessages,
}: {
  searchActive: boolean;
  selectedSessionId: string | null;
  hasEarlierMessages: boolean;
}) => !searchActive && Boolean(selectedSessionId) && hasEarlierMessages;

export const resolveTranscriptWindowStateChange = ({
  sessionId,
  previousSessionId,
  messageCount,
  windowSessionId,
  currentWindowStart,
  windowExpanded,
  stickToBottom,
  initialWindow = INITIAL_MESSAGE_WINDOW,
}: {
  sessionId: string | null;
  previousSessionId: string | null;
  messageCount: number;
  windowSessionId: string | null;
  currentWindowStart: number;
  windowExpanded: boolean;
  stickToBottom: boolean;
  initialWindow?: number;
}): TranscriptWindowState => {
  let nextWindowSessionId = windowSessionId;
  let nextWindowStart = currentWindowStart;
  let nextWindowExpanded = windowExpanded;

  if (sessionId !== previousSessionId) {
    nextWindowSessionId = null;
    nextWindowExpanded = false;
    nextWindowStart = 0;
  }

  if (!sessionId || nextWindowExpanded || messageCount === 0) {
    return {
      windowSessionId: nextWindowSessionId,
      windowStart: nextWindowStart,
      windowExpanded: nextWindowExpanded,
    };
  }

  const targetStart = messageCount > initialWindow ? messageCount - initialWindow : 0;
  if (nextWindowSessionId !== sessionId) {
    return {
      windowSessionId: sessionId,
      windowStart: targetStart,
      windowExpanded: nextWindowExpanded,
    };
  }

  if (nextWindowStart <= 0 && targetStart > 0) {
    nextWindowStart = targetStart;
  } else if (stickToBottom && targetStart > nextWindowStart) {
    nextWindowStart = targetStart;
  }

  return {
    windowSessionId: nextWindowSessionId,
    windowStart: nextWindowStart,
    windowExpanded: nextWindowExpanded,
  };
};

export const clampMessageWindowStart = (windowStart: number, messageCount: number) =>
  windowStart > messageCount ? messageCount : windowStart;

export const hasTranscriptGrowth = (
  current: TranscriptGrowthCounts,
  previous: TranscriptGrowthCounts,
) =>
  current.messages > previous.messages ||
  current.todos > previous.todos ||
  current.parts > previous.parts;

export const shouldAutoScrollForTranscriptGrowth = ({
  current,
  previous,
  initialAnchorPending,
  stickToBottom,
}: {
  current: TranscriptGrowthCounts;
  previous: TranscriptGrowthCounts;
  initialAnchorPending: boolean;
  stickToBottom: boolean;
}) => hasTranscriptGrowth(current, previous) && !initialAnchorPending && stickToBottom;

export const shouldAutoScrollForRunProgress = ({
  showRunIndicator,
  initialAnchorPending,
  stickToBottom,
}: {
  showRunIndicator: boolean;
  initialAnchorPending: boolean;
  stickToBottom: boolean;
}) => showRunIndicator && !initialAnchorPending && stickToBottom;

export const isAtLatest = (container: HTMLElement, sentinel: HTMLElement) => {
  const containerRect = container.getBoundingClientRect();
  const sentinelRect = sentinel.getBoundingClientRect();
  return sentinelRect.bottom <= containerRect.bottom + 1;
};

export function createSessionTranscriptViewport(
  deps: SessionTranscriptViewportControllerDeps,
): SessionTranscriptViewportController {
  let scrollFrame: number | undefined;
  let trailingAutoScrollTimer: number | undefined;
  let pendingScrollBehavior: ScrollBehavior = "auto";
  let lastAutoScrollAt = 0;
  let streamRenderBatchTimer: number | undefined;
  let streamRenderBatchQueuedAt = 0;
  let streamRenderBatchReschedules = 0;
  let initialAnchorRafA: number | undefined;
  let initialAnchorRafB: number | undefined;
  let initialAnchorGuardTimer: ReturnType<typeof setTimeout> | undefined;
  let lastWindowPerfSignature = "";
  const [nearBottom, setNearBottom] = createSignal(true);
  const [stickToBottom, setStickToBottom] = createSignal(true);
  const [messageWindowStart, setMessageWindowStart] = createSignal(0);
  const [messageWindowSessionId, setMessageWindowSessionId] = createSignal<string | null>(null);
  const [messageWindowExpanded, setMessageWindowExpanded] = createSignal(false);
  const [initialAnchorPending, setInitialAnchorPending] = createSignal(false);

  const renderedMessages = createMemo(() =>
    resolveRenderedTranscriptMessages({
      messages: deps.messages(),
      optimisticMessage: deps.optimisticSubmittedMessage(),
      searchActive: deps.searchActive(),
      windowExpanded: messageWindowExpanded(),
      windowStart: messageWindowStart(),
    }),
  );

  const [batchedRenderedMessages, setBatchedRenderedMessages] = createSignal<MessageWithParts[]>(renderedMessages());

  // The direct memo path avoids a SolidJS batching gap that can flash the transcript
  // during rapid idle/running transitions. Keep the batched signal updated for the
  // perf experiment until the policy is deliberately removed.
  const effectiveRenderedMessages = renderedMessages;

  createEffect(() => {
    const next = renderedMessages();
    const sourceMessageCount = deps.messages().length;
    const sourcePartCount = deps.totalPartCount();
    if (deps.sessionStatus() === "idle") {
      if (streamRenderBatchTimer !== undefined) {
        window.clearTimeout(streamRenderBatchTimer);
        streamRenderBatchTimer = undefined;
      }
      setBatchedRenderedMessages(next);
      streamRenderBatchQueuedAt = 0;
      streamRenderBatchReschedules = 0;
      return;
    }

    if (streamRenderBatchQueuedAt <= 0) {
      streamRenderBatchQueuedAt = deps.perfNow();
    } else {
      streamRenderBatchReschedules += 1;
    }

    if (streamRenderBatchTimer !== undefined) {
      window.clearTimeout(streamRenderBatchTimer);
      streamRenderBatchTimer = undefined;
    }

    streamRenderBatchTimer = window.setTimeout(() => {
      const applyStartedAt = deps.perfNow();
      setBatchedRenderedMessages(next);
      streamRenderBatchTimer = undefined;
      const applyMs = Math.round((deps.perfNow() - applyStartedAt) * 100) / 100;
      const queuedMs = streamRenderBatchQueuedAt > 0
        ? Math.round((deps.perfNow() - streamRenderBatchQueuedAt) * 100) / 100
        : 0;
      const reschedules = streamRenderBatchReschedules;
      streamRenderBatchQueuedAt = 0;
      streamRenderBatchReschedules = 0;

      if (deps.developerMode()) {
        window.requestAnimationFrame(() => {
          const paintMs = Math.round((deps.perfNow() - applyStartedAt) * 100) / 100;
          if (queuedMs >= 180 || applyMs >= 8 || paintMs >= 24 || reschedules >= 3) {
            deps.recordPerfLog(true, "session.render", "batch-commit", {
              queuedMs,
              applyMs,
              paintMs,
              reschedules,
              sessionID: deps.selectedSessionId(),
              status: deps.sessionStatus(),
              sourceMessageCount,
              sourcePartCount,
              renderedMessageCount: next.length,
            });
          }
        });
      }
    }, STREAM_RENDER_BATCH_MS);
  });

  const hiddenMessageCount = createMemo(() =>
    resolveHiddenMessageCount({
      sourceMessageCount: deps.messages().length,
      renderedMessageCount: renderedMessages().length,
      searchActive: deps.searchActive(),
      windowExpanded: messageWindowExpanded(),
    }),
  );

  const nextRevealCount = createMemo(() => resolveNextRevealCount(hiddenMessageCount()));

  const hasServerEarlierMessages = createMemo(() =>
    resolveHasServerEarlierMessages({
      searchActive: deps.searchActive(),
      selectedSessionId: deps.selectedSessionId(),
      hasEarlierMessages: deps.hasEarlierMessages(),
    }),
  );

  const revealEarlierMessages = async () => {
    const action = resolveRevealEarlierMessagesAction({
      hiddenMessageCount: hiddenMessageCount(),
      currentWindowStart: messageWindowStart(),
      hasServerEarlierMessages: hasServerEarlierMessages(),
      selectedSessionId: deps.selectedSessionId(),
    });

    if (action.kind === "reveal-window") {
      if (deps.developerMode()) {
        deps.recordPerfLog(true, "session.window", "reveal", {
          sessionID: deps.selectedSessionId(),
          hiddenBefore: hiddenMessageCount(),
          nextStart: action.nextWindowStart,
        });
      }
      setMessageWindowStart(action.nextWindowStart);
      if (action.expanded) {
        setMessageWindowExpanded(true);
      }
      return;
    }

    if (action.kind !== "load-server-earlier") return;
    setMessageWindowExpanded(true);
    setMessageWindowStart(action.nextWindowStart);
    await deps.loadEarlierMessages(action.sessionId);
    if (deps.developerMode()) {
      deps.recordPerfLog(true, "session.window", "load-earlier", {
        sessionID: action.sessionId,
      });
    }
  };

  createEffect(() => {
    if (!deps.developerMode()) {
      lastWindowPerfSignature = "";
      return;
    }

    const signature = [
      deps.selectedSessionId() ?? "",
      deps.messages().length,
      deps.totalPartCount(),
      renderedMessages().length,
      hiddenMessageCount(),
      messageWindowExpanded() ? "1" : "0",
      deps.searchActive() ? "1" : "0",
    ].join("|");

    if (signature === lastWindowPerfSignature) return;
    lastWindowPerfSignature = signature;

    deps.recordPerfLog(true, "session.window", "state", {
      sessionID: deps.selectedSessionId(),
      messageCount: deps.messages().length,
      renderedMessageCount: renderedMessages().length,
      hiddenMessageCount: hiddenMessageCount(),
      partCount: deps.totalPartCount(),
      expanded: messageWindowExpanded(),
      searchActive: deps.searchActive(),
    });
  });

  const scrollToLatest = (behavior: ScrollBehavior = "auto") => {
    setStickToBottom(true);
    deps.messagesEndElement()?.scrollIntoView({ behavior, block: "end" });
  };

  const pinToLatestNow = () => {
    setStickToBottom(true);
    deps.messagesEndElement()?.scrollIntoView({ behavior: "auto", block: "end" });
  };

  const scheduleScrollToLatest = (behavior: ScrollBehavior = "auto") => {
    if (behavior === "smooth") {
      pendingScrollBehavior = "smooth";
    }
    if (scrollFrame !== undefined) return;
    scrollFrame = window.requestAnimationFrame(() => {
      scrollFrame = undefined;
      const nextBehavior = pendingScrollBehavior;
      pendingScrollBehavior = "auto";
      const now = deps.now();
      const remainingMs = STREAM_SCROLL_MIN_INTERVAL_MS - (now - lastAutoScrollAt);
      if (nextBehavior === "auto" && remainingMs > 0) {
        if (trailingAutoScrollTimer === undefined) {
          trailingAutoScrollTimer = window.setTimeout(() => {
            trailingAutoScrollTimer = undefined;
            if (!stickToBottom()) return;
            scheduleScrollToLatest("auto");
          }, remainingMs);
        }
        return;
      }
      if (trailingAutoScrollTimer !== undefined) {
        window.clearTimeout(trailingAutoScrollTimer);
        trailingAutoScrollTimer = undefined;
      }
      lastAutoScrollAt = now;
      scrollToLatest(nextBehavior);
    });
  };

  const jumpToLatest = (behavior: ScrollBehavior = "smooth") => {
    setStickToBottom(true);
    scheduleScrollToLatest(behavior);
  };

  const cancelInitialAnchorFrames = () => {
    if (initialAnchorRafA !== undefined) {
      window.cancelAnimationFrame(initialAnchorRafA);
      initialAnchorRafA = undefined;
    }
    if (initialAnchorRafB !== undefined) {
      window.cancelAnimationFrame(initialAnchorRafB);
      initialAnchorRafB = undefined;
    }
    if (initialAnchorGuardTimer) {
      clearTimeout(initialAnchorGuardTimer);
      initialAnchorGuardTimer = undefined;
    }
  };

  const applyInitialBottomAnchor = (sessionId: string) => {
    cancelInitialAnchorFrames();
    initialAnchorGuardTimer = setTimeout(() => {
      initialAnchorGuardTimer = undefined;
      if (deps.selectedSessionId() !== sessionId) return;
      setInitialAnchorPending(false);
    }, 200);
    pinToLatestNow();
    initialAnchorRafA = window.requestAnimationFrame(() => {
      initialAnchorRafA = undefined;
      pinToLatestNow();
      initialAnchorRafB = window.requestAnimationFrame(() => {
        initialAnchorRafB = undefined;
        pinToLatestNow();
        if (deps.selectedSessionId() !== sessionId) return;
        setInitialAnchorPending(false);
      });
    });
  };

  const markSelectedSessionForInitialAnchor = (sessionId: string) => {
    setInitialAnchorPending(true);
    setStickToBottom(true);
    deps.queueMicrotask(() => applyInitialBottomAnchor(sessionId));
  };

  onCleanup(() => {
    cancelInitialAnchorFrames();
    if (scrollFrame !== undefined) {
      window.cancelAnimationFrame(scrollFrame);
      scrollFrame = undefined;
    }
    if (trailingAutoScrollTimer !== undefined) {
      window.clearTimeout(trailingAutoScrollTimer);
      trailingAutoScrollTimer = undefined;
    }
    if (streamRenderBatchTimer !== undefined) {
      window.clearTimeout(streamRenderBatchTimer);
      streamRenderBatchTimer = undefined;
    }
    streamRenderBatchQueuedAt = 0;
    streamRenderBatchReschedules = 0;
  });

  createEffect(
    on(
      () => [deps.selectedSessionId(), deps.messages().length] as const,
      ([sessionId, count], previous) => {
        const previousSessionId = previous?.[0] ?? null;
        const next = resolveTranscriptWindowStateChange({
          sessionId,
          previousSessionId,
          messageCount: count,
          windowSessionId: messageWindowSessionId(),
          currentWindowStart: messageWindowStart(),
          windowExpanded: messageWindowExpanded(),
          stickToBottom: stickToBottom(),
        });

        setMessageWindowSessionId(next.windowSessionId);
        setMessageWindowStart(next.windowStart);
        setMessageWindowExpanded(next.windowExpanded);
      },
      { defer: true },
    ),
  );

  createEffect(() => {
    const clamped = clampMessageWindowStart(messageWindowStart(), deps.messages().length);
    if (clamped === messageWindowStart()) return;
    setMessageWindowStart(clamped);
  });

  onMount(() => {
    const container = deps.chatContainerElement();
    const sentinel = deps.bottomVisibilityElement();
    if (!container || !sentinel) return;

    const updateNearBottom = () => {
      const atLatest = isAtLatest(container, sentinel);
      setNearBottom(atLatest);
      setStickToBottom(atLatest);
    };

    updateNearBottom();
    container.addEventListener("scroll", updateNearBottom, { passive: true });

    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        const atLatest = Boolean(entry?.isIntersecting) || isAtLatest(container, sentinel);
        if (atLatest) {
          setNearBottom(true);
          setStickToBottom(true);
          return;
        }
        if (!stickToBottom()) {
          setNearBottom(false);
        }
      },
      {
        root: container,
        rootMargin: "0px",
        threshold: 0,
      },
    );

    observer.observe(sentinel);
    onCleanup(() => {
      container.removeEventListener("scroll", updateNearBottom);
      observer.disconnect();
    });
  });

  createEffect(
    on(
      () => [deps.selectedSessionId(), deps.messages().length, deps.isChatContainerReady(), initialAnchorPending()] as const,
      ([sessionId, count, ready, pending]) => {
        if (!pending) return;
        if (!sessionId) {
          setInitialAnchorPending(false);
          return;
        }
        if (!ready) return;
        if (count === 0) {
          setInitialAnchorPending(false);
          return;
        }
        deps.queueMicrotask(() => applyInitialBottomAnchor(sessionId));
      },
      { defer: true },
    ),
  );

  return {
    renderedMessages,
    effectiveRenderedMessages,
    hiddenMessageCount,
    nextRevealCount,
    hasServerEarlierMessages,
    nearBottom,
    stickToBottom,
    setStickToBottom,
    initialAnchorPending,
    revealEarlierMessages,
    scheduleScrollToLatest,
    jumpToLatest,
    markSelectedSessionForInitialAnchor,
  };
}
