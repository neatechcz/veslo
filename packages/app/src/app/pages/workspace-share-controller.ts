import { createEffect, createMemo, createSignal, on, onCleanup, type Accessor } from "solid-js";
import type { WorkspaceInfo, VesloServerInfo } from "../lib/tauri";
import {
  buildVesloConnectInviteUrl,
  buildVesloWorkspaceBaseUrl,
  createVesloServerClient,
  parseVesloWorkspaceIdFromUrl,
  type VesloServerClient,
  type VesloServerSettings,
} from "../lib/veslo-server";
import { publishVesloBundleJson, type PublishBundleResult } from "../lib/publisher";
import type {
  SharedSkillItem,
  SharedSkillsSetBundleV1,
  SharedWorkspaceProfileBundleV1,
} from "../lib/shared-bundles";
import { normalizeDirectoryPath } from "../utils";

export type WorkspaceShareField = {
  label: string;
  value: string;
  secret?: boolean;
  placeholder?: string;
  hint?: string;
};

export type WorkspaceShareClient = Pick<VesloServerClient, "listWorkspaces" | "exportWorkspace">;

export type WorkspaceShareCreateClient = (input: {
  baseUrl: string;
  token?: string | null;
}) => WorkspaceShareClient;

export type WorkspaceShareTranslator = (key: string) => string;

export type WorkspaceSharePublishBundle = (input: {
  payload: unknown;
  bundleType: "workspace-profile" | "skills-set";
  name?: string;
}) => Promise<PublishBundleResult>;

export type WorkspaceShareExportContext = {
  client: WorkspaceShareClient;
  workspaceId: string;
  workspace: WorkspaceInfo;
};

type SharedSkillsSetBundleWithSource = SharedSkillsSetBundleV1 & {
  sourceWorkspace?: {
    id?: string;
    name?: string;
  };
};

export type WorkspaceShareControllerDeps = {
  shareWorkspaceId: Accessor<string | null>;
  workspaces: Accessor<WorkspaceInfo[]>;
  workspaceLabel: (workspace: WorkspaceInfo) => string;
  t: WorkspaceShareTranslator;
  serverHostInfo: Accessor<VesloServerInfo | null>;
  serverSettings: Accessor<VesloServerSettings>;
  engineRuntime: Accessor<string | null>;
  isDesktopRuntime: Accessor<boolean>;
  exportWorkspaceBusy: Accessor<boolean>;
  remoteTokenMissingPlaceholder: Accessor<string>;
  createClient?: WorkspaceShareCreateClient;
  publishBundle?: WorkspaceSharePublishBundle;
  writeClipboardText?: (value: string) => Promise<void>;
};

export type WorkspaceShareController = {
  shareWorkspace: Accessor<WorkspaceInfo | null>;
  shareWorkspaceName: Accessor<string>;
  shareWorkspaceDetail: Accessor<string>;
  shareFields: Accessor<WorkspaceShareField[]>;
  shareNote: Accessor<string | null>;
  shareServiceDisabledReason: Accessor<string | null>;
  exportDisabledReason: Accessor<string | null>;
  shareWorkspaceProfileBusy: Accessor<boolean>;
  shareWorkspaceProfileUrl: Accessor<string | null>;
  shareWorkspaceProfileError: Accessor<string | null>;
  shareSkillsSetBusy: Accessor<boolean>;
  shareSkillsSetUrl: Accessor<string | null>;
  shareSkillsSetError: Accessor<string | null>;
  publishWorkspaceProfileLink: () => Promise<void>;
  publishSkillsSetLink: () => Promise<void>;
};

export const resolveWorkspaceShare = (
  workspaces: readonly WorkspaceInfo[],
  workspaceId: string | null,
) => {
  const id = workspaceId?.trim() ?? "";
  if (!id) return null;
  return workspaces.find((workspace) => workspace.id === id) ?? null;
};

export const resolveWorkspaceShareDetail = ({
  workspace,
}: {
  workspace: WorkspaceInfo | null;
}) => {
  if (!workspace) return "";
  if (workspace.workspaceType === "remote") {
    if (workspace.remoteType === "veslo") {
      const hostUrl = workspace.vesloHostUrl?.trim() || workspace.baseUrl?.trim() || "";
      const mounted = buildVesloWorkspaceBaseUrl(hostUrl, workspace.vesloWorkspaceId);
      return mounted || hostUrl;
    }
    return workspace.baseUrl?.trim() || "";
  }
  return workspace.path?.trim() || "";
};

const localHostUrl = (hostInfo: VesloServerInfo | null) =>
  hostInfo?.connectUrl?.trim() ||
  hostInfo?.lanUrl?.trim() ||
  hostInfo?.mdnsUrl?.trim() ||
  hostInfo?.baseUrl?.trim() ||
  "";

export const resolveShareFields = ({
  workspace,
  hostInfo,
  settings,
  localVesloWorkspaceId,
  isDesktopRuntime,
  remoteTokenMissingPlaceholder,
  t,
}: {
  workspace: WorkspaceInfo | null;
  hostInfo: VesloServerInfo | null;
  settings: VesloServerSettings;
  localVesloWorkspaceId: string | null;
  isDesktopRuntime: boolean;
  remoteTokenMissingPlaceholder: string;
  t: WorkspaceShareTranslator;
}): WorkspaceShareField[] => {
  if (!workspace) return [];

  if (workspace.workspaceType !== "remote") {
    const hostUrl = localHostUrl(hostInfo);
    const mountedUrl = localVesloWorkspaceId
      ? buildVesloWorkspaceBaseUrl(hostUrl, localVesloWorkspaceId)
      : null;
    const url = mountedUrl || hostUrl;
    const token = hostInfo?.clientToken?.trim() || "";
    const inviteUrl = buildVesloConnectInviteUrl({
      workspaceUrl: url,
      token,
    });
    return [
      {
        label: t("share.invite_link_label"),
        value: inviteUrl,
        secret: true,
        placeholder: !isDesktopRuntime ? t("app.error.tauri_required") : t("config.starting_server"),
        hint: t("share.invite_link_hint"),
      },
      {
        label: t("share.worker_url_label"),
        value: url,
        placeholder: !isDesktopRuntime ? t("app.error.tauri_required") : t("config.starting_server"),
        hint: mountedUrl
          ? t("share.use_connecting_to_worker")
          : hostUrl
            ? t("share.worker_url_resolving")
            : undefined,
      },
      {
        label: t("dashboard.veslo_host_token_label"),
        value: token,
        secret: true,
        placeholder: isDesktopRuntime ? "-" : t("app.error.tauri_required"),
        hint: mountedUrl
          ? t("share.use_connecting_to_worker")
          : t("share.use_connecting_to_host"),
      },
    ];
  }

  if (workspace.remoteType === "veslo") {
    const hostUrl = workspace.vesloHostUrl?.trim() || workspace.baseUrl?.trim() || "";
    const url = buildVesloWorkspaceBaseUrl(hostUrl, workspace.vesloWorkspaceId) || hostUrl;
    const token =
      workspace.vesloToken?.trim() ||
      settings.token?.trim() ||
      "";
    const inviteUrl = buildVesloConnectInviteUrl({
      workspaceUrl: url,
      token,
    });
    return [
      {
        label: t("share.invite_link_label"),
        value: inviteUrl,
        secret: true,
        hint: t("share.invite_link_hint"),
      },
      {
        label: t("share.worker_url_label"),
        value: url,
      },
      {
        label: t("dashboard.veslo_host_token_label"),
        value: token,
        secret: true,
        placeholder: token ? undefined : remoteTokenMissingPlaceholder,
        hint: t("share.token_grants_access"),
      },
    ];
  }

  const baseUrl = workspace.baseUrl?.trim() || workspace.path?.trim() || "";
  const directory = workspace.directory?.trim() || "";
  return [
    {
      label: t("share.opencode_base_url_label"),
      value: baseUrl,
    },
    {
      label: t("onboarding.directory"),
      value: directory,
      placeholder: "(auto)",
    },
  ];
};

export const resolveShareNote = ({
  workspace,
  engineRuntime,
  t,
}: {
  workspace: WorkspaceInfo | null;
  engineRuntime: string | null;
  t: WorkspaceShareTranslator;
}) => {
  if (!workspace) return null;
  if (workspace.workspaceType === "local" && engineRuntime === "direct") {
    return t("share.direct_runtime_note");
  }
  return null;
};

export const resolveShareServiceDisabledReason = ({
  workspace,
  hostInfo,
  settings,
  t,
}: {
  workspace: WorkspaceInfo | null;
  hostInfo: VesloServerInfo | null;
  settings: VesloServerSettings;
  t: WorkspaceShareTranslator;
}) => {
  if (!workspace) return t("share.select_worker_first");
  if (workspace.workspaceType === "remote" && workspace.remoteType !== "veslo") {
    return t("share.veslo_workers_only");
  }
  if (workspace.workspaceType !== "remote") {
    const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
    const token = hostInfo?.clientToken?.trim() ?? "";
    if (!baseUrl || !token) {
      return t("share.local_host_not_ready");
    }
  } else {
    const hostUrl = workspace.vesloHostUrl?.trim() || workspace.baseUrl?.trim() || "";
    const token = workspace.vesloToken?.trim() || settings.token?.trim() || "";
    if (!hostUrl) return t("share.missing_host_url");
    if (!token) return t("share.missing_token");
  }
  return null;
};

export const resolveExportDisabledReason = ({
  workspace,
  isDesktopRuntime,
  exportWorkspaceBusy,
  t,
}: {
  workspace: WorkspaceInfo | null;
  isDesktopRuntime: boolean;
  exportWorkspaceBusy: boolean;
  t: WorkspaceShareTranslator;
}) => {
  if (!workspace) return t("share.export_local_desktop");
  if (workspace.workspaceType === "remote") return t("share.export_local_only");
  if (!isDesktopRuntime) return t("share.export_desktop_only");
  if (exportWorkspaceBusy) return t("share.export_running");
  return null;
};

const resolveLocalWorkspaceIdFromList = ({
  workspacePath,
  items,
}: {
  workspacePath: string;
  items: Array<{ id: string; path?: string | null }>;
}) => {
  const targetPath = normalizeDirectoryPath(workspacePath);
  const match = items.find((entry) => normalizeDirectoryPath(entry.path ?? "") === targetPath);
  return (match?.id ?? "").trim();
};

const resolveRemoteWorkspaceIdFromList = ({
  workspace,
  items,
  activeId,
}: {
  workspace: WorkspaceInfo;
  items: Array<{
    id: string;
    path?: string | null;
    directory?: string | null;
    opencode?: { directory?: string | null } | null;
  }>;
  activeId?: string | null;
}) => {
  const directoryHint = normalizeDirectoryPath(workspace.directory?.trim() ?? workspace.path?.trim() ?? "");
  const match = directoryHint
    ? items.find((entry) => {
        const entryPath = normalizeDirectoryPath(
          (entry.opencode?.directory ?? entry.directory ?? entry.path ?? "").trim(),
        );
        return Boolean(entryPath && entryPath === directoryHint);
      })
    : (activeId ? items.find((entry) => entry.id === activeId) : null) ?? items[0];
  return (match?.id ?? "").trim();
};

export const resolveShareExportContext = async ({
  workspace,
  hostInfo,
  settings,
  localVesloWorkspaceId,
  setLocalVesloWorkspaceId,
  createClient,
  t,
}: {
  workspace: WorkspaceInfo | null;
  hostInfo: VesloServerInfo | null;
  settings: VesloServerSettings;
  localVesloWorkspaceId: string | null;
  setLocalVesloWorkspaceId: (workspaceId: string | null) => void;
  createClient: WorkspaceShareCreateClient;
  t: WorkspaceShareTranslator;
}): Promise<WorkspaceShareExportContext> => {
  if (!workspace) {
    throw new Error(t("share.select_worker_first"));
  }

  if (workspace.workspaceType !== "remote") {
    const baseUrl = hostInfo?.baseUrl?.trim() ?? "";
    const token = hostInfo?.clientToken?.trim() ?? "";
    if (!baseUrl || !token) {
      throw new Error(t("share.local_host_not_ready"));
    }
    const client = createClient({ baseUrl, token });

    let workspaceId = localVesloWorkspaceId?.trim() ?? "";
    if (!workspaceId) {
      const response = await client.listWorkspaces();
      const items = Array.isArray(response.items) ? response.items : [];
      workspaceId = resolveLocalWorkspaceIdFromList({
        workspacePath: workspace.path?.trim() ?? "",
        items,
      });
      setLocalVesloWorkspaceId(workspaceId || null);
    }

    if (!workspaceId) {
      throw new Error(t("share.resolve_local_worker_failed"));
    }

    return { client, workspaceId, workspace };
  }

  if (workspace.remoteType !== "veslo") {
    throw new Error(t("share.veslo_workers_only"));
  }

  const hostUrl = workspace.vesloHostUrl?.trim() || workspace.baseUrl?.trim() || "";
  const token = workspace.vesloToken?.trim() || settings.token?.trim() || "";
  if (!hostUrl || !token) {
    throw new Error(t("share.host_url_token_required"));
  }

  const client = createClient({ baseUrl: hostUrl, token });
  let workspaceId =
    workspace.vesloWorkspaceId?.trim() ||
    parseVesloWorkspaceIdFromUrl(workspace.vesloHostUrl ?? "") ||
    parseVesloWorkspaceIdFromUrl(workspace.baseUrl ?? "") ||
    "";

  if (!workspaceId) {
    const response = await client.listWorkspaces();
    const items = Array.isArray(response.items) ? response.items : [];
    workspaceId = resolveRemoteWorkspaceIdFromList({
      workspace,
      items,
      activeId: response.activeId,
    });
  }

  if (!workspaceId) {
    throw new Error(t("share.resolve_remote_worker_failed"));
  }

  return { client, workspaceId, workspace };
};

export const publishWorkspaceProfileShare = async ({
  resolveContext,
  workspaceLabel,
  publishBundle,
  writeClipboardText,
  t,
}: {
  resolveContext: () => Promise<WorkspaceShareExportContext>;
  workspaceLabel: (workspace: WorkspaceInfo) => string;
  publishBundle: WorkspaceSharePublishBundle;
  writeClipboardText: (value: string) => Promise<void>;
  t: WorkspaceShareTranslator;
}) => {
  const { client, workspaceId, workspace } = await resolveContext();
  const exported = await client.exportWorkspace(workspaceId);
  const payload: SharedWorkspaceProfileBundleV1 = {
    schemaVersion: 1,
    type: "workspace-profile",
    name: `${workspaceLabel(workspace)} profile`,
    description: t("share.workspace_profile_description"),
    workspace: exported,
  };

  const result = await publishBundle({
    payload,
    bundleType: "workspace-profile",
    name: payload.name,
  });

  try {
    await writeClipboardText(result.url);
  } catch {
    // Clipboard access is best effort.
  }
  return result.url;
};

export const publishWorkspaceSkillsSetShare = async ({
  resolveContext,
  workspaceLabel,
  publishBundle,
  writeClipboardText,
  t,
}: {
  resolveContext: () => Promise<WorkspaceShareExportContext>;
  workspaceLabel: (workspace: WorkspaceInfo) => string;
  publishBundle: WorkspaceSharePublishBundle;
  writeClipboardText: (value: string) => Promise<void>;
  t: WorkspaceShareTranslator;
}) => {
  const { client, workspaceId, workspace } = await resolveContext();
  const exported = await client.exportWorkspace(workspaceId);
  const skills = Array.isArray(exported.skills) ? exported.skills : [];
  if (!skills.length) {
    throw new Error(t("share.no_skills_found"));
  }

  const payload: SharedSkillsSetBundleWithSource = {
    schemaVersion: 1,
    type: "skills-set",
    name: `${workspaceLabel(workspace)} skills`,
    description: t("share.skills_set_description"),
    skills: skills.map((skill): SharedSkillItem => ({
      name: skill.name,
      description: skill.description,
      trigger: skill.trigger,
      content: skill.content,
    })),
    sourceWorkspace: {
      id: workspaceId,
      name: workspaceLabel(workspace),
    },
  };

  const result = await publishBundle({
    payload,
    bundleType: "skills-set",
    name: payload.name,
  });

  try {
    await writeClipboardText(result.url);
  } catch {
    // Clipboard access is best effort.
  }
  return result.url;
};

export function createWorkspaceShareController(
  deps: WorkspaceShareControllerDeps,
): WorkspaceShareController {
  const createClient = deps.createClient ?? ((input) =>
    createVesloServerClient({
      baseUrl: input.baseUrl,
      token: input.token ?? undefined,
    }));
  const publishBundle = deps.publishBundle ?? publishVesloBundleJson;
  const writeClipboardText = deps.writeClipboardText ?? ((value) => navigator.clipboard.writeText(value));

  const [shareLocalVesloWorkspaceId, setShareLocalVesloWorkspaceId] = createSignal<string | null>(null);
  const [shareWorkspaceProfileBusy, setShareWorkspaceProfileBusy] = createSignal(false);
  const [shareWorkspaceProfileUrl, setShareWorkspaceProfileUrl] = createSignal<string | null>(null);
  const [shareWorkspaceProfileError, setShareWorkspaceProfileError] = createSignal<string | null>(null);
  const [shareSkillsSetBusy, setShareSkillsSetBusy] = createSignal(false);
  const [shareSkillsSetUrl, setShareSkillsSetUrl] = createSignal<string | null>(null);
  const [shareSkillsSetError, setShareSkillsSetError] = createSignal<string | null>(null);

  const shareWorkspace = createMemo(() =>
    resolveWorkspaceShare(deps.workspaces(), deps.shareWorkspaceId()),
  );

  const shareWorkspaceName = createMemo(() => {
    const workspace = shareWorkspace();
    return workspace ? deps.workspaceLabel(workspace) : "";
  });

  const shareWorkspaceDetail = createMemo(() =>
    resolveWorkspaceShareDetail({ workspace: shareWorkspace() }),
  );

  createEffect(
    on(deps.shareWorkspaceId, () => {
      setShareWorkspaceProfileBusy(false);
      setShareWorkspaceProfileUrl(null);
      setShareWorkspaceProfileError(null);
      setShareSkillsSetBusy(false);
      setShareSkillsSetUrl(null);
      setShareSkillsSetError(null);
    }),
  );

  createEffect(() => {
    const workspace = shareWorkspace();
    const baseUrl = deps.serverHostInfo()?.baseUrl?.trim() ?? "";
    const token = deps.serverHostInfo()?.clientToken?.trim() ?? "";
    const workspacePath = workspace?.workspaceType === "local" ? workspace.path?.trim() ?? "" : "";

    if (!workspace || workspace.workspaceType !== "local" || !workspacePath || !baseUrl || !token) {
      setShareLocalVesloWorkspaceId(null);
      return;
    }

    let cancelled = false;
    setShareLocalVesloWorkspaceId(null);

    void (async () => {
      try {
        const client = createClient({ baseUrl, token });
        const response = await client.listWorkspaces();
        if (cancelled) return;
        const items = Array.isArray(response.items) ? response.items : [];
        const workspaceId = resolveLocalWorkspaceIdFromList({
          workspacePath,
          items,
        });
        setShareLocalVesloWorkspaceId(workspaceId || null);
      } catch {
        if (!cancelled) setShareLocalVesloWorkspaceId(null);
      }
    })();

    onCleanup(() => {
      cancelled = true;
    });
  });

  const shareFields = createMemo(() =>
    resolveShareFields({
      workspace: shareWorkspace(),
      hostInfo: deps.serverHostInfo(),
      settings: deps.serverSettings(),
      localVesloWorkspaceId: shareLocalVesloWorkspaceId(),
      isDesktopRuntime: deps.isDesktopRuntime(),
      remoteTokenMissingPlaceholder: deps.remoteTokenMissingPlaceholder(),
      t: deps.t,
    }),
  );

  const shareNote = createMemo(() =>
    resolveShareNote({
      workspace: shareWorkspace(),
      engineRuntime: deps.engineRuntime(),
      t: deps.t,
    }),
  );

  const shareServiceDisabledReason = createMemo(() =>
    resolveShareServiceDisabledReason({
      workspace: shareWorkspace(),
      hostInfo: deps.serverHostInfo(),
      settings: deps.serverSettings(),
      t: deps.t,
    }),
  );

  const exportDisabledReason = createMemo(() =>
    resolveExportDisabledReason({
      workspace: shareWorkspace(),
      isDesktopRuntime: deps.isDesktopRuntime(),
      exportWorkspaceBusy: deps.exportWorkspaceBusy(),
      t: deps.t,
    }),
  );

  const resolveContext = () =>
    resolveShareExportContext({
      workspace: shareWorkspace(),
      hostInfo: deps.serverHostInfo(),
      settings: deps.serverSettings(),
      localVesloWorkspaceId: shareLocalVesloWorkspaceId(),
      setLocalVesloWorkspaceId: setShareLocalVesloWorkspaceId,
      createClient,
      t: deps.t,
    });

  const publishWorkspaceProfileLink = async () => {
    if (shareWorkspaceProfileBusy()) return;
    setShareWorkspaceProfileBusy(true);
    setShareWorkspaceProfileError(null);
    setShareWorkspaceProfileUrl(null);

    try {
      const url = await publishWorkspaceProfileShare({
        resolveContext,
        workspaceLabel: deps.workspaceLabel,
        publishBundle,
        writeClipboardText,
        t: deps.t,
      });
      setShareWorkspaceProfileUrl(url);
    } catch (error) {
      setShareWorkspaceProfileError(error instanceof Error ? error.message : deps.t("share.publish_workspace_failed"));
    } finally {
      setShareWorkspaceProfileBusy(false);
    }
  };

  const publishSkillsSetLink = async () => {
    if (shareSkillsSetBusy()) return;
    setShareSkillsSetBusy(true);
    setShareSkillsSetError(null);
    setShareSkillsSetUrl(null);

    try {
      const url = await publishWorkspaceSkillsSetShare({
        resolveContext,
        workspaceLabel: deps.workspaceLabel,
        publishBundle,
        writeClipboardText,
        t: deps.t,
      });
      setShareSkillsSetUrl(url);
    } catch (error) {
      setShareSkillsSetError(error instanceof Error ? error.message : deps.t("share.publish_skills_failed"));
    } finally {
      setShareSkillsSetBusy(false);
    }
  };

  return {
    shareWorkspace,
    shareWorkspaceName,
    shareWorkspaceDetail,
    shareFields,
    shareNote,
    shareServiceDisabledReason,
    exportDisabledReason,
    shareWorkspaceProfileBusy,
    shareWorkspaceProfileUrl,
    shareWorkspaceProfileError,
    shareSkillsSetBusy,
    shareSkillsSetUrl,
    shareSkillsSetError,
    publishWorkspaceProfileLink,
    publishSkillsSetLink,
  };
}
