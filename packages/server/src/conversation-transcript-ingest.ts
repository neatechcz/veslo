import { normalizeConversationDirectoryKey } from "./conversation-binding-store.js";

export type TranscriptIngestIdentity = {
  workspaceId: string;
  directory: string;
  opencodeSessionId: string;
};

export type TranscriptIngestTrigger = "terminal-lifecycle" | "recovery";

export type TranscriptIngestRequest = TranscriptIngestIdentity & {
  trigger: TranscriptIngestTrigger;
  runId?: string | null;
  generation?: number;
};

const normalizeText = (value: string | null | undefined) => value?.trim() ?? "";

export function normalizeTranscriptIngestIdentity(input: {
  workspaceId?: string | null;
  directory?: string | null;
  opencodeSessionId?: string | null;
}): TranscriptIngestIdentity | null {
  const workspaceId = normalizeText(input.workspaceId);
  const directory = normalizeConversationDirectoryKey(input.directory);
  const opencodeSessionId = normalizeText(input.opencodeSessionId);
  if (!workspaceId || !directory || !opencodeSessionId) return null;
  return { workspaceId, directory, opencodeSessionId };
}

export function transcriptIngestMutexKey(identity: TranscriptIngestIdentity): string {
  return `${identity.workspaceId}\0${identity.directory}\0${identity.opencodeSessionId}`;
}
