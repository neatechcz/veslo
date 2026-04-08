export function deriveVisibleSessionPrefetchIds(input: {
  selectedSessionId: string | null;
  visibleSessionIds: string[];
}) {
  const ordered = new Set<string>();
  const selectedSessionId = input.selectedSessionId?.trim() ?? "";
  if (selectedSessionId) ordered.add(selectedSessionId);

  for (const sessionId of input.visibleSessionIds) {
    const normalized = sessionId.trim();
    if (!normalized) continue;
    ordered.add(normalized);
  }

  return Array.from(ordered);
}
