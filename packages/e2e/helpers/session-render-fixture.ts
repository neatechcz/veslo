export type SessionRenderArtifactManifest = {
  scenario: 'session-render-stability';
  capturedAt: string;
  widths: number[];
  hasServerToken: boolean;
  sessionId: string | null;
  conversationId: string | null;
};

const cleanIdentifier = (value: unknown) => typeof value === 'string' && value.trim() ? value.trim() : null;

export function createSessionRenderArtifactManifest(input: {
  widths: number[];
  sessionId?: unknown;
  conversationId?: unknown;
  serverToken?: unknown;
  prompt?: unknown;
  attachmentPath?: unknown;
  capturedAt?: string;
}): SessionRenderArtifactManifest {
  return {
    scenario: 'session-render-stability',
    capturedAt: input.capturedAt ?? new Date().toISOString(),
    widths: [...new Set(input.widths.filter((width) => Number.isInteger(width) && width > 0))],
    hasServerToken: typeof input.serverToken === 'string' && input.serverToken.length > 0,
    sessionId: cleanIdentifier(input.sessionId),
    conversationId: cleanIdentifier(input.conversationId),
  };
}
