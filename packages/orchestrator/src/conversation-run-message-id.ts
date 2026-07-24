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
