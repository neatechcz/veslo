import assert from "node:assert/strict";
import test from "node:test";
import type { MessageWithParts } from "../../types";
import {
  INITIAL_MESSAGE_WINDOW,
  MESSAGE_WINDOW_LOAD_CHUNK,
  resolveHiddenMessageCount,
  resolveRevealEarlierMessagesAction,
  resolveRenderedTranscriptMessages,
  resolveTranscriptWindowStateChange,
  shouldAutoScrollForRunProgress,
  shouldAutoScrollForTranscriptGrowth,
} from "../../pages/session-transcript-viewport.js";

const message = (id: string): MessageWithParts => ({
  info: { id } as MessageWithParts["info"],
  parts: [],
});

test("rendered transcript window contains canonical messages when there is no local submitted echo", () => {
  const messages = Array.from({ length: 6 }, (_, index) => message(`m${index + 1}`));

  const rendered = resolveRenderedTranscriptMessages({
    messages,
    localSubmittedMessage: null,
    searchActive: false,
    windowExpanded: false,
    windowStart: 4,
  });

  assert.deepEqual(rendered.map((item) => item.info.id), ["m5", "m6"]);
});

test("rendered transcript window appends a local submitted echo without masking canonical messages", () => {
  const messages = Array.from({ length: 2 }, (_, index) => message(`m${index + 1}`));

  const rendered = resolveRenderedTranscriptMessages({
    messages,
    localSubmittedMessage: message("local-submit"),
    searchActive: false,
    windowExpanded: false,
    windowStart: 0,
  });

  assert.deepEqual(rendered.map((item) => item.info.id), ["m1", "m2", "local-submit"]);
});

test("transcript windowing is disabled while search is active or the window is expanded", () => {
  const messages = Array.from({ length: 4 }, (_, index) => message(`m${index + 1}`));

  assert.deepEqual(
    resolveRenderedTranscriptMessages({
      messages,
      localSubmittedMessage: null,
      searchActive: true,
      windowExpanded: false,
      windowStart: 2,
    }).map((item) => item.info.id),
    ["m1", "m2", "m3", "m4"],
  );

  assert.equal(
    resolveHiddenMessageCount({
      sourceMessageCount: messages.length,
      renderedMessageCount: 2,
      searchActive: true,
      windowExpanded: false,
    }),
    0,
  );
});

test("reveal earlier messages expands by one coarse chunk before loading server history", () => {
  assert.deepEqual(
    resolveRevealEarlierMessagesAction({
      hiddenMessageCount: MESSAGE_WINDOW_LOAD_CHUNK + 5,
      currentWindowStart: 160,
      hasServerEarlierMessages: true,
      selectedSessionId: "local-session",
    }),
    {
      kind: "reveal-window",
      nextWindowStart: 40,
      expanded: false,
    },
  );

  assert.deepEqual(
    resolveRevealEarlierMessagesAction({
      hiddenMessageCount: 20,
      currentWindowStart: 20,
      hasServerEarlierMessages: true,
      selectedSessionId: "local-session",
    }),
    {
      kind: "reveal-window",
      nextWindowStart: 0,
      expanded: true,
    },
  );

  assert.deepEqual(
    resolveRevealEarlierMessagesAction({
      hiddenMessageCount: 0,
      currentWindowStart: 0,
      hasServerEarlierMessages: true,
      selectedSessionId: "server-session",
    }),
    {
      kind: "load-server-earlier",
      sessionId: "server-session",
      nextWindowStart: 0,
      expanded: true,
    },
  );
});

test("message-window state resets on session switch and tracks latest growth only while pinned", () => {
  const firstVisit = resolveTranscriptWindowStateChange({
    sessionId: "s1",
    previousSessionId: null,
    messageCount: INITIAL_MESSAGE_WINDOW + 20,
    windowSessionId: null,
    currentWindowStart: 0,
    windowExpanded: false,
    stickToBottom: true,
  });

  assert.deepEqual(firstVisit, {
    windowSessionId: "s1",
    windowStart: 20,
    windowExpanded: false,
  });

  const growsWhilePinned = resolveTranscriptWindowStateChange({
    sessionId: "s1",
    previousSessionId: "s1",
    messageCount: INITIAL_MESSAGE_WINDOW + 30,
    windowSessionId: "s1",
    currentWindowStart: 20,
    windowExpanded: false,
    stickToBottom: true,
  });
  assert.equal(growsWhilePinned.windowStart, 30);

  const growsWhileUnpinned = resolveTranscriptWindowStateChange({
    sessionId: "s1",
    previousSessionId: "s1",
    messageCount: INITIAL_MESSAGE_WINDOW + 40,
    windowSessionId: "s1",
    currentWindowStart: 30,
    windowExpanded: false,
    stickToBottom: false,
  });
  assert.equal(growsWhileUnpinned.windowStart, 30);

  const switched = resolveTranscriptWindowStateChange({
    sessionId: null,
    previousSessionId: "s1",
    messageCount: 0,
    windowSessionId: "s1",
    currentWindowStart: 30,
    windowExpanded: true,
    stickToBottom: true,
  });
  assert.deepEqual(switched, {
    windowSessionId: null,
    windowStart: 0,
    windowExpanded: false,
  });
});

test("auto-scroll decisions keep sticky bottom intent separate from visible near-bottom state", () => {
  assert.equal(
    shouldAutoScrollForRunProgress({
      showRunIndicator: true,
      initialAnchorPending: false,
      stickToBottom: true,
    }),
    true,
  );
  assert.equal(
    shouldAutoScrollForRunProgress({
      showRunIndicator: true,
      initialAnchorPending: true,
      stickToBottom: true,
    }),
    false,
  );

  assert.equal(
    shouldAutoScrollForTranscriptGrowth({
      current: { messages: 3, todos: 1, parts: 8 },
      previous: { messages: 2, todos: 1, parts: 8 },
      initialAnchorPending: false,
      stickToBottom: true,
    }),
    true,
  );
  assert.equal(
    shouldAutoScrollForTranscriptGrowth({
      current: { messages: 3, todos: 1, parts: 8 },
      previous: { messages: 2, todos: 1, parts: 8 },
      initialAnchorPending: false,
      stickToBottom: false,
    }),
    false,
  );
});
