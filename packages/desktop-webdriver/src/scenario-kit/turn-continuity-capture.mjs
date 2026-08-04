const CAPTURE_KEY = "__vesloWebDriverTurnContinuityCapture";

export async function beginTurnContinuityCapture(browser) {
  await browser.execute((captureKey) => {
    const previous = window[captureKey];
    previous?.observer?.disconnect?.();
    const frames = [];
    let sequence = 0;
    let previousSignature = "";
    const visible = (element) => {
      const style = window.getComputedStyle(element);
      return element.getClientRects().length > 0 && style.display !== "none" && style.visibility !== "hidden";
    };
    const attr = (element, name) => element.getAttribute(name) ?? "";
    const scan = (reason) => {
      const transcript = [...document.querySelectorAll("[data-message-role][data-message-id]")]
        .filter(visible)
        .map((element) => ({
          role: attr(element, "data-message-role"),
          messageId: attr(element, "data-message-id"),
          messageIds: attr(element, "data-message-ids"),
          parentMessageId: attr(element, "data-message-parent-id"),
          placeholderKind: attr(element, "data-message-placeholder-kind"),
          clientMessageId: attr(element, "data-client-message-id"),
          owner: attr(element, "data-message-owner"),
          testId: attr(element, "data-testid"),
        }));
      const queue = [...document.querySelectorAll('[data-queue-owner][data-queue-item-id]')]
        .filter(visible)
        .map((element) => ({
          owner: attr(element, "data-queue-owner"),
          queueItemId: attr(element, "data-queue-item-id"),
          clientMessageId: attr(element, "data-client-message-id"),
          reservedRunId: attr(element, "data-reserved-run-id"),
          state: attr(element, "data-queue-state"),
        }));
      const signature = JSON.stringify({ transcript, queue });
      if (signature === previousSignature) return;
      previousSignature = signature;
      frames.push({
        sequence: ++sequence,
        at: new Date().toISOString(),
        ts: Date.now(),
        reason,
        transcript,
        queue,
      });
      if (frames.length > 2_000) frames.shift();
    };
    const observer = new MutationObserver(() => scan("mutation"));
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: [
        "data-message-role",
        "data-message-id",
        "data-message-ids",
        "data-message-parent-id",
        "data-message-placeholder-kind",
        "data-client-message-id",
        "data-message-owner",
        "data-queue-owner",
        "data-queue-item-id",
        "data-reserved-run-id",
        "data-queue-state",
      ],
    });
    window[captureKey] = { observer, frames, scan };
    scan("initial");
  }, CAPTURE_KEY);
}

export async function readTurnContinuityCapture(browser) {
  return browser.execute((captureKey) => {
    const capture = window[captureKey];
    capture?.scan?.("read");
    return Array.isArray(capture?.frames) ? [...capture.frames] : [];
  }, CAPTURE_KEY);
}

export async function finishTurnContinuityCapture(browser) {
  return browser.execute((captureKey) => {
    const capture = window[captureKey];
    capture?.scan?.("finish");
    capture?.observer?.disconnect?.();
    const frames = Array.isArray(capture?.frames) ? [...capture.frames] : [];
    delete window[captureKey];
    return frames;
  }, CAPTURE_KEY);
}

export async function waitForNewCapturedQueueOwner(
  browser,
  baselineQueueItemIds = [],
  timeout = 20_000,
  { requireOwner = null } = {},
) {
  const baseline = new Set(baselineQueueItemIds.map((value) => String(value ?? "").trim()).filter(Boolean));
  let matched = null;
  await browser.waitUntil(async () => {
    const frames = await readTurnContinuityCapture(browser);
    const candidates = frames.flatMap((frame) => frame.queue ?? [])
      .filter((item) => item.queueItemId && !baseline.has(item.queueItemId) && item.clientMessageId);
    matched = requireOwner
      ? [...candidates].reverse().find((item) => item.owner === requireOwner) ?? null
      : [...candidates].reverse().find((item) => item.owner === "server")
        ?? candidates.at(-1)
        ?? null;
    return matched !== null;
  }, {
    timeout,
    interval: 100,
    timeoutMsg: "The queued turn never exposed a content-free queue owner identity.",
  });
  return matched;
}

export function summarizeTurnContinuityFrames(frames, clientMessageId) {
  const target = String(clientMessageId ?? "").trim();
  const normalizedFrames = Array.isArray(frames) ? frames : [];
  const targetQueueFrames = normalizedFrames.filter((frame) =>
    frame.queue?.some((item) => item.clientMessageId === target));
  const targetTranscriptFrames = normalizedFrames.filter((frame) =>
    frame.transcript?.some((item) => item.clientMessageId === target));
  const consecutiveAssistantFrames = normalizedFrames.filter((frame) =>
    frame.transcript?.some((item, index, transcript) =>
      index > 0 && item.role === "assistant" && transcript[index - 1]?.role === "assistant"));
  return {
    frameCount: normalizedFrames.length,
    targetClientMessageId: target,
    targetQueueFrameCount: targetQueueFrames.length,
    targetTranscriptFrameCount: targetTranscriptFrames.length,
    consecutiveAssistantFrameCount: consecutiveAssistantFrames.length,
    firstTargetQueueSequence: targetQueueFrames[0]?.sequence ?? null,
    firstTargetTranscriptSequence: targetTranscriptFrames[0]?.sequence ?? null,
    consecutiveAssistantSequences: consecutiveAssistantFrames.map((frame) => frame.sequence),
  };
}

export function analyzeCausalGapFrames(frames, {
  assistantMessageId,
  parentUserMessageId,
  clientMessageId,
}) {
  const assistantId = String(assistantMessageId ?? "").trim();
  const userId = String(parentUserMessageId ?? "").trim();
  const clientId = String(clientMessageId ?? "").trim();
  const invalidFrames = (Array.isArray(frames) ? frames : []).filter((frame) => {
    const transcript = frame.transcript ?? [];
    const assistantIndex = transcript.findIndex((row) =>
      row.messageId === assistantId || String(row.messageIds ?? "").split(",").includes(assistantId));
    if (assistantIndex === -1) return false;
    const exactUserVisible = transcript.some((row) =>
      row.role === "user" && (row.messageId === userId || row.clientMessageId === clientId));
    const exactQueueOwnerVisible = (frame.queue ?? []).some((row) => row.clientMessageId === clientId);
    const precedingAssistant = assistantIndex > 0 && transcript[assistantIndex - 1]?.role === "assistant";
    return precedingAssistant && !exactUserVisible && !exactQueueOwnerVisible;
  });
  return {
    assistantMessageId: assistantId,
    parentUserMessageId: userId,
    targetClientMessageId: clientId,
    invalidVisibleFrameCount: invalidFrames.length,
    invalidVisibleSequences: invalidFrames.map((frame) => frame.sequence),
    firstInvalidVisibleAt: invalidFrames[0]?.at ?? null,
  };
}

export function findCausalGapTrace(entries, { afterTs = 0, workspaceId = "" } = {}) {
  const scoped = (Array.isArray(entries) ? entries : [])
    .filter((entry) => Number(entry?.ts ?? 0) >= afterTs)
    .filter((entry) => !workspaceId || entry?.workspaceId === workspaceId);
  const assistantCandidates = scoped.filter((entry) =>
    entry?.event === "session-sse:message-updated" &&
    entry?.role === "assistant" &&
    entry?.parentMessageID &&
    entry?.parentPresent === false);
  for (const assistant of assistantCandidates) {
    const user = scoped.find((entry) =>
      entry?.event === "session-sse:message-updated" &&
      entry?.role === "user" &&
      entry?.messageID === assistant.parentMessageID &&
      Number(entry?.ts ?? 0) >= Number(assistant.ts ?? 0));
    if (!user) continue;
    const partFirst = scoped.find((entry) =>
      entry?.event === "session-sse:part-committed" &&
      entry?.messageID === assistant.messageID &&
      entry?.hasMessageBefore === false &&
      Number(entry?.ts ?? 0) <= Number(assistant.ts ?? 0));
    return {
      assistantMessageId: assistant.messageID,
      parentUserMessageId: assistant.parentMessageID,
      partFirstAt: partFirst?.at ?? null,
      assistantMetadataAt: assistant.at ?? null,
      userMetadataAt: user.at ?? null,
      gapMs: Number(user.ts ?? 0) - Number(assistant.ts ?? 0),
    };
  }
  return null;
}
