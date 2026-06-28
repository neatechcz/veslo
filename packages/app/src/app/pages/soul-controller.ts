import { createComputed, createMemo, createSignal, type Accessor } from "solid-js";

import type {
  VesloServerClient,
  VesloSoulAuthContext,
  VesloSoulAnyMaterializationResult,
  VesloSoulReadResponse,
  VesloSoulSummary,
  VesloSoulVersion,
  VesloSoulVersionGetOptions,
  VesloSoulVersionListOptions,
} from "../lib/veslo-server";

type BaseSoulEditorSource = {
  key: string;
  summary: VesloSoulSummary | null;
};

export type SoulEditorSource =
  | (BaseSoulEditorSource & {
      scope: "organization" | "user";
    })
  | (BaseSoulEditorSource & {
      scope: "workspace";
      workspaceId: string;
    });

type PendingRequest = {
  requestId: number;
};

type RestorePendingRequest = PendingRequest & {
  versionId: string;
};

export type SoulEditorControllerInput<TSource extends SoulEditorSource = SoulEditorSource> = {
  sources: Accessor<TSource[]>;
  client: Accessor<VesloServerClient | null>;
  serverConnected: Accessor<boolean>;
  authContext: Accessor<VesloSoulAuthContext>;
  refresh: (options?: { force?: boolean }) => void;
  activeWorkspaceIds?: Accessor<string[]>;
  activeRun?: Accessor<boolean>;
  onMaterializationResult?: (
    source: TSource,
    materialization: VesloSoulAnyMaterializationResult | undefined,
  ) => void;
  defaultChangeSummary: Accessor<string>;
  defaultRestoreSummary: Accessor<string>;
  detailErrorMessage: Accessor<string>;
  historyErrorMessage: Accessor<string>;
  previewErrorMessage: Accessor<string>;
};

export const soulVersionContent = (response: VesloSoulReadResponse | null) => {
  const document = response?.document;
  if (!document) return "";
  const versions = Array.isArray(document.versions) ? document.versions : [];
  const currentVersionId = document.currentVersionId?.trim() ?? "";
  const current = currentVersionId ? versions.find((version) => version.id === currentVersionId) : null;
  return current?.content ?? versions[0]?.content ?? "";
};

export const soulVersionListOptions = (
  source: SoulEditorSource,
  authContext: VesloSoulAuthContext,
): VesloSoulVersionListOptions =>
  source.scope === "workspace" ? { ...authContext, workspaceId: source.workspaceId } : { ...authContext, limit: 50 };

export const soulVersionGetOptions = (
  source: SoulEditorSource,
  authContext: VesloSoulAuthContext,
): VesloSoulVersionGetOptions =>
  source.scope === "workspace" ? { ...authContext, workspaceId: source.workspaceId } : authContext;

const removeRecordKey = <T>(record: Record<string, T>, key: string) => {
  const next = { ...record };
  delete next[key];
  return next;
};

const authContextKey = (authContext: VesloSoulAuthContext) =>
  [
    authContext.denApiBase ?? "",
    authContext.denToken ?? "",
    authContext.denOrgId ?? "",
    authContext.denUserId ?? "",
  ].join("\u0000");

const sourceLoadKey = (source: SoulEditorSource) =>
  source.scope === "workspace"
    ? [source.key, source.scope, source.workspaceId].join("\u0000")
    : [source.key, source.scope].join("\u0000");

export function createSoulEditorController<TSource extends SoulEditorSource>(
  input: SoulEditorControllerInput<TSource>,
) {
  const [selectedSourceKey, setSelectedSourceKey] = createSignal<string | null>(null);
  const [detail, setDetail] = createSignal<VesloSoulReadResponse | null>(null);
  const [detailSourceKey, setDetailSourceKey] = createSignal<string | null>(null);
  const [detailLoading, setDetailLoading] = createSignal(false);
  const [detailError, setDetailError] = createSignal<string | null>(null);
  const [content, setContent] = createSignal("");
  const [initialContent, setInitialContent] = createSignal("");
  const [changeSummary, setChangeSummary] = createSignal("");
  const [savePendingBySource, setSavePendingBySource] = createSignal<Record<string, PendingRequest>>({});
  const [saveErrorsBySource, setSaveErrorsBySource] = createSignal<Record<string, string | null>>({});
  const [versions, setVersions] = createSignal<VesloSoulVersion[]>([]);
  const [historySourceKey, setHistorySourceKey] = createSignal<string | null>(null);
  const [historyLoading, setHistoryLoading] = createSignal(false);
  const [historyError, setHistoryError] = createSignal<string | null>(null);
  const [selectedVersionId, setSelectedVersionId] = createSignal<string | null>(null);
  const [selectedVersionPreview, setSelectedVersionPreview] = createSignal<VesloSoulVersion | null>(null);
  const [previewLoading, setPreviewLoading] = createSignal(false);
  const [previewError, setPreviewError] = createSignal<string | null>(null);
  const [restoreChangeSummary, setRestoreChangeSummary] = createSignal("");
  const [restorePendingBySource, setRestorePendingBySource] = createSignal<Record<string, RestorePendingRequest>>({});
  const [restoreErrorsBySource, setRestoreErrorsBySource] = createSignal<Record<string, string | null>>({});
  const [heartbeatPendingSourceKey, setHeartbeatPendingSourceKey] = createSignal<string | null>(null);
  const [heartbeatError, setHeartbeatError] = createSignal<string | null>(null);

  let detailRequestSeq = 0;
  let historyRequestSeq = 0;
  let previewRequestSeq = 0;
  let saveRequestSeq = 0;
  let restoreRequestSeq = 0;
  let activeLoadKey: string | null = null;
  let activeLoadClient: VesloServerClient | null = null;

  const selectedSource = createMemo(() => input.sources().find((source) => source.key === selectedSourceKey()) ?? null);
  const selectedDetail = createMemo(() => (detailSourceKey() === selectedSourceKey() ? detail() : null));
  const displaySummary = createMemo(() => selectedDetail()?.summary ?? selectedSource()?.summary ?? null);
  const currentBaseVersionId = createMemo(() =>
    selectedDetail()?.document?.currentVersionId ?? selectedSource()?.summary?.currentVersionId ?? null,
  );
  const selectedVersionIsCurrent = createMemo(() => {
    const versionId = selectedVersionId();
    return Boolean(versionId && versionId === currentBaseVersionId());
  });
  const selectedCanEdit = createMemo(() => {
    const source = selectedSource();
    if (!source) return false;
    if (source.scope === "organization") {
      return Boolean(source.summary?.canEdit);
    }
    return Boolean(selectedDetail()?.summary.canEdit ?? source.summary?.canEdit);
  });
  const selectedSavePending = createMemo(() => {
    const key = selectedSourceKey();
    return Boolean(key && savePendingBySource()[key]);
  });
  const selectedSaveError = createMemo(() => {
    const key = selectedSourceKey();
    return key ? saveErrorsBySource()[key] ?? null : null;
  });
  const saveDisabled = createMemo(
    () =>
      !selectedCanEdit() ||
      !input.client() ||
      !input.serverConnected() ||
      detailLoading() ||
      selectedSavePending() ||
      content() === initialContent(),
  );
  const selectedVersion = createMemo(() => versions().find((version) => version.id === selectedVersionId()) ?? null);
  const materialization = createMemo(() => selectedDetail()?.materialization ?? null);
  const materializationDiagnostic = createMemo(() => {
    const current = materialization();
    if (!current) return null;
    if ("workspaces" in current) {
      return current.workspaces.map((item) => item.result).find((result) => !result.ok) ?? null;
    }
    if (current.ok) return null;
    return current;
  });
  const selectedRestorePending = createMemo(() => {
    const key = selectedSourceKey();
    return Boolean(key && restorePendingBySource()[key]);
  });
  const selectedRestorePendingVersionId = createMemo(() => {
    const key = selectedSourceKey();
    return key ? restorePendingBySource()[key]?.versionId ?? null : null;
  });
  const selectedRestoreError = createMemo(() => {
    const key = selectedSourceKey();
    return key ? restoreErrorsBySource()[key] ?? null : null;
  });
  const restoreDisabled = createMemo(
    () =>
      !selectedVersionId() ||
      selectedVersionIsCurrent() ||
      !selectedCanEdit() ||
      !input.client() ||
      !input.serverConnected() ||
      selectedRestorePending(),
  );

  const sourceStillSelected = (source: SoulEditorSource, client: VesloServerClient) =>
    selectedSourceKey() === source.key && input.client() === client && input.serverConnected();

  const applyDetailResponse = (response: VesloSoulReadResponse, sourceKey = selectedSourceKey()) => {
    const nextContent = soulVersionContent(response);
    const nextVersions = Array.isArray(response.document?.versions) ? response.document.versions : null;
    setDetail(response);
    setDetailSourceKey(sourceKey);
    setContent(nextContent);
    setInitialContent(nextContent);
    setChangeSummary("");
    if (nextVersions) {
      setVersions(nextVersions);
      setHistorySourceKey(sourceKey);
      setHistoryError(null);
    }
  };

  const readSoulSource = (client: VesloServerClient, source: SoulEditorSource) => {
    switch (source.scope) {
      case "organization":
        return client.getOrganizationSoul(input.authContext());
      case "user":
        return client.getUserSoul(input.authContext());
      case "workspace":
        return client.getWorkspaceSoul(source.workspaceId, input.authContext());
    }
  };

  const loadSelectedDetail = async (source: SoulEditorSource, client: VesloServerClient) => {
    const requestSeq = ++detailRequestSeq;
    if (detailSourceKey() !== source.key) {
      setDetail(null);
      setDetailSourceKey(null);
      setContent("");
      setInitialContent("");
    }
    setDetailLoading(true);
    setDetailError(null);
    setSaveErrorsBySource((current) => ({ ...current, [source.key]: null }));
    setHeartbeatError(null);
    try {
      const response = await readSoulSource(client, source);
      if (requestSeq !== detailRequestSeq || !sourceStillSelected(source, client)) return;
      applyDetailResponse(response, source.key);
    } catch (error) {
      if (requestSeq !== detailRequestSeq || !sourceStillSelected(source, client)) return;
      setDetail(null);
      setDetailSourceKey(null);
      setContent("");
      setInitialContent("");
      setDetailError(error instanceof Error ? error.message : input.detailErrorMessage());
    } finally {
      if (requestSeq === detailRequestSeq && sourceStillSelected(source, client)) {
        setDetailLoading(false);
      }
    }
  };

  const loadSelectedHistory = async (source: SoulEditorSource, client: VesloServerClient) => {
    const requestSeq = ++historyRequestSeq;
    if (historySourceKey() !== source.key) {
      setVersions([]);
      setHistorySourceKey(null);
    }
    setHistoryLoading(true);
    setHistoryError(null);
    setSelectedVersionId(null);
    setSelectedVersionPreview(null);
    setPreviewError(null);
    try {
      const response = await client.listSoulVersions(source.scope, soulVersionListOptions(source, input.authContext()));
      if (requestSeq !== historyRequestSeq || !sourceStillSelected(source, client)) return;
      setVersions(Array.isArray(response.versions) ? response.versions : []);
      setHistorySourceKey(source.key);
    } catch (error) {
      if (requestSeq !== historyRequestSeq || !sourceStillSelected(source, client)) return;
      setVersions([]);
      setHistorySourceKey(null);
      setHistoryError(error instanceof Error ? error.message : input.historyErrorMessage());
    } finally {
      if (requestSeq === historyRequestSeq && sourceStillSelected(source, client)) {
        setHistoryLoading(false);
      }
    }
  };

  const reloadSelectedSource = (source: SoulEditorSource, client: VesloServerClient) => {
    void loadSelectedDetail(source, client);
    void loadSelectedHistory(source, client);
  };

  createComputed(() => {
    const sources = input.sources();
    const current = selectedSourceKey();
    if (!current || !sources.some((source) => source.key === current)) {
      setSelectedSourceKey(sources[0]?.key ?? null);
    }
  });

  createComputed(() => {
    const source = selectedSource();
    const client = input.client();
    const connected = input.serverConnected();
    const contextKey = authContextKey(input.authContext());
    if (!source || !client || !connected) {
      activeLoadKey = null;
      activeLoadClient = null;
      detailRequestSeq += 1;
      historyRequestSeq += 1;
      previewRequestSeq += 1;
      setDetail(null);
      setDetailSourceKey(null);
      setDetailLoading(false);
      setDetailError(null);
      setContent("");
      setInitialContent("");
      setVersions([]);
      setHistorySourceKey(null);
      setHistoryLoading(false);
      setHistoryError(null);
      setSelectedVersionId(null);
      setSelectedVersionPreview(null);
      setPreviewLoading(false);
      setPreviewError(null);
      return;
    }
    const nextLoadKey = `${sourceLoadKey(source)}\u0000${contextKey}`;
    if (activeLoadKey === nextLoadKey && activeLoadClient === client) {
      return;
    }
    activeLoadKey = nextLoadKey;
    activeLoadClient = client;
    reloadSelectedSource(source, client);
  });

  const changeSummaryValue = () => changeSummary().trim() || input.defaultChangeSummary();
  const restoreChangeSummaryValue = () => restoreChangeSummary().trim() || input.defaultRestoreSummary();
  const activeWorkspaceIdsPayload = () => {
    const activeWorkspaceIds = input.activeWorkspaceIds?.() ?? [];
    return {
      ...(activeWorkspaceIds.length ? { activeWorkspaceIds } : {}),
      ...(input.activeRun?.() === true ? { activeRun: true } : {}),
    };
  };

  const previewVersion = async (versionId: string) => {
    const source = selectedSource();
    const client = input.client();
    if (!source || !client || !input.serverConnected()) return;
    const requestSeq = ++previewRequestSeq;
    setSelectedVersionId(versionId);
    setSelectedVersionPreview(versions().find((version) => version.id === versionId) ?? null);
    setPreviewLoading(true);
    setPreviewError(null);
    try {
      const response = await client.getSoulVersion(source.scope, versionId, soulVersionGetOptions(source, input.authContext()));
      if (requestSeq !== previewRequestSeq || !sourceStillSelected(source, client) || selectedVersionId() !== versionId) {
        return;
      }
      setSelectedVersionPreview(response.version);
    } catch (error) {
      if (requestSeq !== previewRequestSeq || !sourceStillSelected(source, client) || selectedVersionId() !== versionId) {
        return;
      }
      setPreviewError(error instanceof Error ? error.message : input.previewErrorMessage());
    } finally {
      if (requestSeq === previewRequestSeq && sourceStillSelected(source, client) && selectedVersionId() === versionId) {
        setPreviewLoading(false);
      }
    }
  };

  const saveSelectedSoul = async () => {
    const source = selectedSource();
    const client = input.client();
    if (!source || !client || saveDisabled()) return;
    const requestId = ++saveRequestSeq;
    setSavePendingBySource((current) => ({ ...current, [source.key]: { requestId } }));
    setSaveErrorsBySource((current) => ({ ...current, [source.key]: null }));
    try {
      const mutationInput = {
        ...input.authContext(),
        content: content(),
        changeSummary: changeSummaryValue(),
        baseVersionId: currentBaseVersionId(),
        ...activeWorkspaceIdsPayload(),
      };
      let response: VesloSoulReadResponse;
      switch (source.scope) {
        case "organization":
          response = await client.updateOrganizationSoul(mutationInput);
          break;
        case "user":
          response = await client.updateUserSoul(mutationInput);
          break;
        case "workspace":
          response = await client.updateWorkspaceSoul(source.workspaceId, mutationInput);
          break;
      }
      if (!sourceStillSelected(source, client)) return;
      applyDetailResponse(response, source.key);
      input.onMaterializationResult?.(source, response.materialization);
      setSelectedVersionId(null);
      setSelectedVersionPreview(null);
      input.refresh({ force: true });
      void loadSelectedHistory(source, client);
    } catch (error) {
      if (savePendingBySource()[source.key]?.requestId === requestId) {
        setSaveErrorsBySource((current) => ({
          ...current,
          [source.key]: error instanceof Error ? error.message : input.detailErrorMessage(),
        }));
      }
    } finally {
      if (savePendingBySource()[source.key]?.requestId === requestId) {
        setSavePendingBySource((current) => removeRecordKey(current, source.key));
      }
    }
  };

  const restoreSelectedVersion = async (versionId: string) => {
    const source = selectedSource();
    const client = input.client();
    if (!source || !client || restoreDisabled()) return;
    const requestId = ++restoreRequestSeq;
    setRestorePendingBySource((current) => ({ ...current, [source.key]: { requestId, versionId } }));
    setRestoreErrorsBySource((current) => ({ ...current, [source.key]: null }));
    try {
      let response: VesloSoulReadResponse;
      const restoreInput = {
        ...input.authContext(),
        changeSummary: restoreChangeSummaryValue(),
        ...activeWorkspaceIdsPayload(),
      };
      switch (source.scope) {
        case "organization":
          response = await client.restoreOrganizationSoulVersion(versionId, restoreInput);
          break;
        case "user":
          response = await client.restoreUserSoulVersion(versionId, restoreInput);
          break;
        case "workspace":
          response = await client.restoreWorkspaceSoulVersion(source.workspaceId, versionId, restoreInput);
          break;
      }
      if (!sourceStillSelected(source, client)) return;
      applyDetailResponse(response, source.key);
      input.onMaterializationResult?.(source, response.materialization);
      setRestoreChangeSummary("");
      setSelectedVersionId(null);
      setSelectedVersionPreview(null);
      input.refresh({ force: true });
      reloadSelectedSource(source, client);
    } catch (error) {
      if (restorePendingBySource()[source.key]?.requestId === requestId) {
        setRestoreErrorsBySource((current) => ({
          ...current,
          [source.key]: error instanceof Error ? error.message : input.detailErrorMessage(),
        }));
      }
    } finally {
      if (restorePendingBySource()[source.key]?.requestId === requestId) {
        setRestorePendingBySource((current) => removeRecordKey(current, source.key));
      }
    }
  };

  const toggleWorkspaceHeartbeat = async () => {
    const source = selectedSource();
    const client = input.client();
    if (!source || source.scope !== "workspace" || !client || !input.serverConnected()) return;
    const nextEnabled = !(displaySummary()?.heartbeatEnabled ?? false);
    setHeartbeatPendingSourceKey(source.key);
    setHeartbeatError(null);
    try {
      const response = await client.setWorkspaceSoulHeartbeat(source.workspaceId, nextEnabled, input.authContext());
      if (!sourceStillSelected(source, client)) return;
      applyDetailResponse(response, source.key);
      input.refresh({ force: true });
      void loadSelectedHistory(source, client);
    } catch (error) {
      if (sourceStillSelected(source, client)) {
        setHeartbeatError(error instanceof Error ? error.message : input.detailErrorMessage());
      }
    } finally {
      if (heartbeatPendingSourceKey() === source.key) {
        setHeartbeatPendingSourceKey(null);
      }
    }
  };

  return {
    selectedSourceKey,
    setSelectedSourceKey,
    selectedSource,
    selectedDetail,
    displaySummary,
    currentBaseVersionId,
    selectedVersionIsCurrent,
    selectedCanEdit,
    saveDisabled,
    selectedSavePending,
    selectedSaveError,
    detail,
    detailLoading,
    detailError,
    content,
    setContent,
    initialContent,
    changeSummary,
    setChangeSummary,
    versions,
    historyLoading,
    historyError,
    selectedVersionId,
    setSelectedVersionId,
    selectedVersion,
    selectedVersionPreview,
    previewLoading,
    previewError,
    previewVersion,
    restoreChangeSummary,
    setRestoreChangeSummary,
    selectedRestorePending,
    selectedRestorePendingVersionId,
    selectedRestoreError,
    restoreDisabled,
    materialization,
    materializationDiagnostic,
    heartbeatPendingSourceKey,
    heartbeatError,
    saveSelectedSoul,
    restoreSelectedVersion,
    toggleWorkspaceHeartbeat,
  };
}
