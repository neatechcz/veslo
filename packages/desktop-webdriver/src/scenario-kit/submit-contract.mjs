const traceEntriesAfter = (entries, baselineEntryId) => (Array.isArray(entries) ? entries : [])
  .filter((entry) => entry && typeof entry === "object")
  .filter((entry) => Number(entry.id ?? 0) > baselineEntryId);

export function traceCursor(entries) {
  const id = Number((Array.isArray(entries) ? entries : []).at(-1)?.id ?? 0);
  return Number.isFinite(id) ? id : 0;
}

export function summarizeSubmitContract(entries, baselineEntryId = 0) {
  const scoped = traceEntriesAfter(entries, baselineEntryId);
  const starts = scoped.filter((entry) => entry.event === "sendPromptImmediate:start");
  const traceIds = [...new Set(starts.map((entry) => String(entry.traceId ?? "").trim()).filter(Boolean))];
  return {
    submitStartCount: starts.length,
    traceIds,
    createsConversation: scoped.some((entry) => entry.event === "sendPrompt:create-session-needed"),
    targetsExistingConversation: scoped.some((entry) => entry.event === "sendPrompt:server-submit-existing:start"),
  };
}

export function requireSingleSubmitContract(entries, baselineEntryId, expectedRoute) {
  const summary = summarizeSubmitContract(entries, baselineEntryId);
  if (summary.submitStartCount !== 1 || summary.traceIds.length !== 1) {
    throw new Error(`Expected exactly one submit attempt, observed ${summary.submitStartCount} starts across ${summary.traceIds.length} trace ids.`);
  }
  if (expectedRoute === "new" && (!summary.createsConversation || summary.targetsExistingConversation)) {
    throw new Error(`Expected one new-conversation submit route: ${JSON.stringify(summary)}`);
  }
  if (expectedRoute === "existing" && (summary.createsConversation || !summary.targetsExistingConversation)) {
    throw new Error(`Expected one existing-conversation submit route: ${JSON.stringify(summary)}`);
  }
  return summary;
}

export function identityAdoptionAfter(entries, baselineEntryId = 0) {
  return traceEntriesAfter(entries, baselineEntryId).find((entry) =>
    entry.event === "pending-submit:transcript-reconciliation" &&
    entry.result === "adopt" &&
    entry.matchKind === "identity" &&
    entry.candidateCount === 1) ?? null;
}

export async function waitForCanonicalIdentityAdoption(browser, baselineEntryId, timeout = 30_000) {
  let adoption = null;
  await browser.waitUntil(async () => {
    const entries = await browser.execute(() => {
      const dump = window.__vesloDumpSendWorkflowTrace;
      return typeof dump === "function" ? dump() : [];
    });
    adoption = identityAdoptionAfter(entries, baselineEntryId);
    return adoption !== null;
  }, {
    timeout,
    interval: 150,
    timeoutMsg: "The canonical user row was not adopted through its unique client message identity.",
  });
  return adoption;
}
