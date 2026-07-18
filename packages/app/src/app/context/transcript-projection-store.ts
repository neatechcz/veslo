import { createSignal } from "solid-js";

import type {
  VesloSessionLatestRunArtifacts,
  VesloSessionTranscriptSnapshot,
} from "../lib/veslo-server";
import { normalizeDirectoryPath } from "../utils";

export type TranscriptProjectionScope = {
  /**
   * App-owned workspace identity. It stays stable while a local workspace is
   * registered and receives a distinct Veslo server workspace id.
   */
  appWorkspaceId?: string | null;
  /**
   * Canonical Veslo workspace identity once it is known. Until then,
   * `workspaceId` may be the app workspace fallback.
   */
  serverWorkspaceId?: string | null;
  workspaceId: string;
  directory?: string | null;
  uiSessionId: string;
  conversationId?: string | null;
  opencodeSessionId?: string | null;
  selectionVersion: number;
  expectedRunId?: string | null;
};

type ProjectionState = {
  scope: TranscriptProjectionScope;
  artifacts: VesloSessionLatestRunArtifacts;
};

export type TranscriptProjectionStoreOptions = {
  selectedSessionId: () => string | null;
  currentSelectionVersion: () => number;
  isRunActive: (scope: TranscriptProjectionScope) => boolean;
  trace?: (event: string, payload?: Record<string, unknown>) => void;
};

const normalize = (value: string | null | undefined) => value?.trim() ?? "";

const normalizeDirectory = (value: string | null | undefined) => {
  const directory = normalize(value);
  return directory ? normalizeDirectoryPath(directory) : "";
};

const projectionAppWorkspaceId = (scope: TranscriptProjectionScope) =>
  normalize(scope.appWorkspaceId) || normalize(scope.workspaceId);

const expectedServerWorkspaceId = (scope: TranscriptProjectionScope) => {
  const explicit = normalize(scope.serverWorkspaceId);
  if (explicit) return explicit;

  const appWorkspaceId = normalize(scope.appWorkspaceId);
  const workspaceId = normalize(scope.workspaceId);
  return !appWorkspaceId || appWorkspaceId !== workspaceId ? workspaceId : "";
};

const sameProjectionTarget = (left: TranscriptProjectionScope, right: TranscriptProjectionScope) =>
  projectionAppWorkspaceId(left) === projectionAppWorkspaceId(right) &&
  normalizeDirectory(left.directory) === normalizeDirectory(right.directory) &&
  normalize(left.uiSessionId) === normalize(right.uiSessionId) &&
  left.selectionVersion === right.selectionVersion;

const sameScope = (left: TranscriptProjectionScope, right: TranscriptProjectionScope) =>
  sameProjectionTarget(left, right) &&
  normalize(left.expectedRunId) === normalize(right.expectedRunId);

const aliasesMatchScope = (
  scope: TranscriptProjectionScope,
  snapshot: VesloSessionTranscriptSnapshot,
) => {
  const serverWorkspaceId = expectedServerWorkspaceId(scope);
  if (serverWorkspaceId && normalize(snapshot.workspaceId) !== serverWorkspaceId) return false;
  const expectedDirectory = normalizeDirectory(scope.directory);
  if (expectedDirectory && normalizeDirectory(snapshot.directory) !== expectedDirectory) return false;

  const expectedConversationId = normalize(scope.conversationId);
  if (expectedConversationId && normalize(snapshot.conversationId) !== expectedConversationId) return false;
  const expectedOpenCodeSessionId = normalize(scope.opencodeSessionId);
  if (expectedOpenCodeSessionId && normalize(snapshot.opencodeSessionId) !== expectedOpenCodeSessionId) return false;
  if (expectedOpenCodeSessionId && normalize(snapshot.sessionId) !== expectedOpenCodeSessionId) return false;

  if (expectedConversationId || expectedOpenCodeSessionId) return true;

  const routeIdentity = normalize(scope.uiSessionId);
  return [snapshot.sessionId, snapshot.conversationId, snapshot.opencodeSessionId]
    .map(normalize)
    .includes(routeIdentity);
};

const artifactsMatchSnapshot = (
  artifacts: VesloSessionLatestRunArtifacts,
  snapshot: VesloSessionTranscriptSnapshot,
) => {
  const transcriptSessionId = normalize(snapshot.opencodeSessionId) || normalize(snapshot.sessionId);
  if (!transcriptSessionId || normalize(artifacts.sessionId) !== transcriptSessionId) return false;
  if (normalize(artifacts.workspaceId) !== normalize(snapshot.workspaceId)) return false;

  const snapshotDirectory = normalizeDirectory(snapshot.directory);
  if (snapshotDirectory && normalizeDirectory(artifacts.directory) !== snapshotDirectory) return false;
  const snapshotConversationId = normalize(snapshot.conversationId);
  if (snapshotConversationId && normalize(artifacts.conversationId) !== snapshotConversationId) return false;
  const snapshotOpenCodeSessionId = normalize(snapshot.opencodeSessionId);
  if (snapshotOpenCodeSessionId && normalize(artifacts.opencodeSessionId) !== snapshotOpenCodeSessionId) return false;

  return true;
};

const bindSnapshotIdentity = (
  scope: TranscriptProjectionScope,
  snapshot: VesloSessionTranscriptSnapshot,
): TranscriptProjectionScope => {
  const serverWorkspaceId = normalize(snapshot.workspaceId) || expectedServerWorkspaceId(scope);
  return {
    ...scope,
    ...(serverWorkspaceId
      ? {
          workspaceId: serverWorkspaceId,
          serverWorkspaceId,
        }
      : {}),
    ...(!normalize(scope.conversationId) && normalize(snapshot.conversationId)
      ? { conversationId: snapshot.conversationId?.trim() }
      : {}),
    ...(!normalize(scope.opencodeSessionId) && normalize(snapshot.opencodeSessionId)
      ? { opencodeSessionId: snapshot.opencodeSessionId?.trim() }
      : {}),
  };
};

export function createTranscriptProjectionStore(options: TranscriptProjectionStoreOptions) {
  const [reservation, setReservation] = createSignal<TranscriptProjectionScope | null>(null);
  const [projection, setProjection] = createSignal<ProjectionState | null>(null);

  const reserveTranscriptProjection = (scope: TranscriptProjectionScope) => {
    setReservation(scope);
    setProjection((current) => (current && sameScope(current.scope, scope) ? current : null));
  };

  const invalidateTranscriptProjection = (scope: TranscriptProjectionScope) => {
    const currentReservation = reservation();
    if (!currentReservation || sameProjectionTarget(currentReservation, scope)) {
      setReservation(scope);
    }
    setProjection((current) => (current && sameProjectionTarget(current.scope, scope) ? null : current));
  };

  const publishTranscriptProjection = (
    scope: TranscriptProjectionScope,
    snapshot: VesloSessionTranscriptSnapshot,
  ) => {
    const artifacts = snapshot.latestRunArtifacts;
    const currentReservation = reservation();
    const reject = (reason: string) => {
      options.trace?.("session-transcript-projection:reject", {
        reason,
        callerSelectionVersion: scope.selectionVersion,
      });
      return false;
    };
    if (!artifacts) return reject("missing-artifacts");
    if (!currentReservation || !sameScope(currentReservation, scope)) return reject("reservation-mismatch");
    if (options.currentSelectionVersion() !== scope.selectionVersion) return reject("selection-version-mismatch");
    if (normalize(options.selectedSessionId()) !== normalize(scope.uiSessionId)) return reject("selected-session-mismatch");
    if (!aliasesMatchScope(currentReservation, snapshot)) return reject("identity-mismatch");
    if (!artifactsMatchSnapshot(artifacts, snapshot)) return reject("artifact-identity-mismatch");
    if (options.isRunActive(currentReservation)) return reject("active-run");

    const boundScope = bindSnapshotIdentity(currentReservation, snapshot);
    setReservation(boundScope);
    setProjection({ scope: boundScope, artifacts });
    options.trace?.("session-transcript-projection:publish", {
      callerSelectionVersion: scope.selectionVersion,
      hasAnchorMessageId: Boolean(normalize(artifacts.anchorMessageId)),
    });
    return true;
  };

  const currentTranscriptProjection = () => {
    const current = projection();
    if (!current) return undefined;
    if (options.currentSelectionVersion() !== current.scope.selectionVersion) return undefined;
    if (normalize(options.selectedSessionId()) !== normalize(current.scope.uiSessionId)) return undefined;
    if (options.isRunActive(current.scope)) return undefined;
    return current.artifacts;
  };

  const isReservedTranscriptSnapshot = (snapshot: VesloSessionTranscriptSnapshot) => {
    const scope = reservation();
    return Boolean(scope && aliasesMatchScope(scope, snapshot));
  };

  return {
    reservation,
    reserveTranscriptProjection,
    invalidateTranscriptProjection,
    publishTranscriptProjection,
    currentTranscriptProjection,
    isReservedTranscriptSnapshot,
  };
}
