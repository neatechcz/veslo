import type { Session } from "@opencode-ai/sdk/v2/client";

import type { PendingSidebarSessionMetadata, SidebarSessionItem, View } from "../types";

export type CreatedSession = Session & {
  conversationId?: string | null;
  opencodeSessionId?: string | null;
  parentConversationId?: string | null;
  branchId?: string | null;
};

export type CreatedSessionWorkspaceInput = {
  pendingSidebarSession?: Pick<PendingSidebarSessionMetadata, "workspaceId"> | null;
  targetWorkspaceId?: string | null;
  connectingWorkspaceId?: string | null;
  activeWorkspaceId?: string | null;
};

const trim = (value: string | null | undefined) => value?.trim() ?? "";

export function buildCreatedSidebarSessionItem(input: {
  session: CreatedSession;
  displaySession: Session;
  pendingSidebarSession?: Pick<PendingSidebarSessionMetadata, "id"> | null;
}): SidebarSessionItem {
  const { session, displaySession, pendingSidebarSession } = input;
  return {
    id: displaySession.id,
    title: displaySession.title,
    slug: displaySession.slug,
    parentID: displaySession.parentID,
    time: displaySession.time,
    directory: displaySession.directory,
    conversationId: session.conversationId ?? null,
    opencodeSessionId: session.opencodeSessionId ?? session.id,
    parentConversationId: session.parentConversationId ?? null,
    branchId: session.branchId ?? null,
    pendingSessionInstanceId: trim(pendingSidebarSession?.id) || null,
  };
}

export function resolveCreatedSessionWorkspaceId(input: CreatedSessionWorkspaceInput): string {
  return (
    trim(input.pendingSidebarSession?.workspaceId) ||
    trim(input.targetWorkspaceId) ||
    trim(input.connectingWorkspaceId) ||
    trim(input.activeWorkspaceId)
  );
}

export function shouldRouteCreatedSessionAfterSelect(input: {
  blockAppDuringCreate: boolean;
  currentView: View;
}): boolean {
  return input.blockAppDuringCreate || input.currentView === "session";
}
