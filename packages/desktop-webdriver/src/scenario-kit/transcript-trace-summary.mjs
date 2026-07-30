const relevantEvent = (entry) => {
  const event = typeof entry?.event === "string" ? entry.event : "";
  return event.startsWith("session-sse:")
    || event.startsWith("session-transcript:")
    || event.startsWith("session-lifecycle-recovery:")
    || event.startsWith("ui-effect-trace:");
};

const count = (entries, event) => entries.filter((entry) => entry.event === event).length;

export function summarizeTranscriptTrace(entries, startedAt) {
  const startMs = Date.parse(startedAt);
  const scoped = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === "object")
    .filter((entry) => !Number.isFinite(startMs) || !Number.isFinite(entry.ts) || entry.ts >= startMs)
    .filter(relevantEvent);
  const byEvent = new Map();
  for (const entry of scoped) {
    const source = typeof entry.source === "string" ? entry.source : "unknown";
    const event = typeof entry.event === "string" ? entry.event : "unknown";
    const key = `${source}\0${event}`;
    byEvent.set(key, (byEvent.get(key) ?? 0) + 1);
  }
  const eventCounts = [...byEvent.entries()]
    .map(([key, value]) => {
      const [source, event] = key.split("\0");
      return { source, event, count: value };
    })
    .sort((left, right) => left.event.localeCompare(right.event) || left.source.localeCompare(right.source));
  const terminalEvents = scoped
    .filter((entry) => entry.event.startsWith("session-lifecycle-recovery:terminal"))
    .slice(-8)
    .map((entry) => ({
      event: entry.event,
      outcome: typeof entry.outcome === "string" ? entry.outcome : null,
      status: typeof entry.status === "string" ? entry.status : null,
      errorType: typeof entry.errorType === "string" ? entry.errorType : null,
    }));
  return {
    schema: "veslo-transcript-trace-summary/v1",
    relevantEventCount: scoped.length,
    eventCounts,
    ladder: {
      assistantMessageEvents: count(scoped, "session-sse:assistant-message-updated"),
      assistantTextPartEvents: count(scoped, "session-sse:assistant-part-updated"),
      committedPartEvents: count(scoped, "session-sse:part-committed"),
      ignoredMessageEvents: count(scoped, "session-sse:message-ignored"),
      ignoredPartEvents: count(scoped, "session-sse:part-ignored"),
      transcriptStoreWrites: count(scoped, "session-transcript:store-write"),
      canonicalProjectionBoundaries: count(scoped, "session-transcript:projection-boundary"),
      terminalEvents,
    },
  };
}

export async function collectTranscriptTraceSummary(browser, startedAt) {
  const entries = await collectSendWorkflowTrace(browser);
  return summarizeTranscriptTrace(entries, startedAt);
}

export async function collectSendWorkflowTrace(browser) {
  return browser.execute(() => {
    const dump = window.__vesloDumpSendWorkflowTrace;
    return typeof dump === "function" ? dump() : [];
  });
}

export function summarizeLatestSubmitRoute(entries, baselineEntryId = 0) {
  const scoped = (Array.isArray(entries) ? entries : [])
    .filter((entry) => entry && typeof entry === "object")
    .filter((entry) => Number(entry.id ?? 0) > baselineEntryId);
  const start = [...scoped].reverse().find((entry) => entry.event === "sendPromptImmediate:start");
  const traceId = typeof start?.traceId === "string" ? start.traceId : null;
  if (!traceId) return null;
  const attempt = scoped.filter((entry) => entry.traceId === traceId);
  return {
    traceId,
    createsConversation: attempt.some((entry) => entry.event === "sendPrompt:create-session-needed"),
    targetsExistingConversation: attempt.some((entry) => entry.event === "sendPrompt:server-submit-existing:start"),
  };
}
