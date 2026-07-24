import { createHash } from "node:crypto";

export function deriveConversationRunOpenCodeMessageId(input: {
  workspaceId: string;
  engineSessionId: string;
  clientMessageId: string;
}): string {
  const workspaceId = input.workspaceId.trim();
  const engineSessionId = input.engineSessionId.trim();
  const clientMessageId = input.clientMessageId.trim();
  if (!workspaceId || !engineSessionId || !clientMessageId) {
    throw new Error("workspaceId, engineSessionId, and clientMessageId are required to derive an OpenCode message id");
  }
  const digest = createHash("sha256")
    .update("veslo-opencode-run-message:v1\u0000")
    .update(workspaceId)
    .update("\u0000")
    .update(engineSessionId)
    .update("\u0000")
    .update(clientMessageId)
    .digest("hex")
    .slice(0, 32);
  return `msg_veslo_v1_${digest}`;
}

const OPENCODE_ID_TIMESTAMP_MASK = 0xffffffffffffn;

export function createConversationRunOpenCodeMessageId(input: {
  workspaceId: string;
  engineSessionId: string;
  clientMessageId: string;
  runId: string;
  timestamp?: number;
}): string {
  const workspaceId = input.workspaceId.trim();
  const engineSessionId = input.engineSessionId.trim();
  const clientMessageId = input.clientMessageId.trim();
  const runId = input.runId.trim();
  const timestamp = Math.floor(input.timestamp ?? Date.now());
  if (!workspaceId || !engineSessionId || !clientMessageId || !runId || !Number.isFinite(timestamp) || timestamp <= 0) {
    throw new Error(
      "workspaceId, engineSessionId, clientMessageId, runId, and a positive timestamp are required to create an OpenCode message id",
    );
  }

  // OpenCode 1.17.x compares user and assistant message ids lexicographically
  // when deciding whether a completed assistant turn is newer. Mirror its
  // ascending 48-bit timestamp prefix and reserve counter zero; OpenCode's
  // subsequently allocated assistant id therefore sorts after this admission.
  const encodedTimestamp = (BigInt(timestamp) * 0x1000n) & OPENCODE_ID_TIMESTAMP_MASK;
  const timeHex = encodedTimestamp.toString(16).padStart(12, "0");
  const suffix = createHash("sha256")
    .update("veslo-opencode-run-message:v2\u0000")
    .update(workspaceId)
    .update("\u0000")
    .update(engineSessionId)
    .update("\u0000")
    .update(clientMessageId)
    .update("\u0000")
    .update(runId)
    .digest("hex")
    .slice(0, 14);
  return `msg_${timeHex}${suffix}`;
}
