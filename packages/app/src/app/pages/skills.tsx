import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount, untrack } from "solid-js";

import type {
  HubSkillCard,
  HubSkillInstallTarget,
  SkillCard,
  SkillFileEntry,
  SkillInstance,
  SkillInventoryItem,
  SkillSaveResult,
} from "../types";
import type { WorkspaceInfo } from "../lib/tauri";
import type {
  VesloServerClient,
  VesloServerStatus,
  VesloSkillImportCandidate,
  VesloSkillImportSourceAgent,
  VesloSkillImportStatus,
  VesloSkillRegistryAuthContext,
} from "../lib/veslo-server";

import Button from "../components/button";
import ModalShell from "../components/modal-shell";
import SkillDetailDrawer, {
  type SkillDetailActionInput,
  type SkillDetailFile,
  type SkillDetailLocation,
  type SkillDetailMetadata,
  type SkillDetailTab,
} from "../components/skill-detail-drawer";
import SkillReviewDialog, { type SkillReviewActionInput, type SkillReviewTargetScope } from "../components/skill-review-dialog";
import type { SkillVersionRow, SkillVersionTargetMetadata } from "../components/skill-version-history";
import {
  ArrowRightToLine,
  Copy,
  Edit2,
  FolderOpen,
  LayoutGrid,
  Link2,
  Loader2,
  Package,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Table2,
  Trash2,
  Upload,
  X,
} from "lucide-solid";
import { currentLocale, t } from "../../i18n";
import { buildSkillInstallTargetWorkspaces } from "../lib/skill-install-targets";
import { skillMutationTargetFromInstance } from "../lib/skill-inventory";
import type { SkillMutationTarget } from "../lib/skill-inventory";
import { buildSkillPackageArchive } from "../lib/skill-package";
import { resolveSkillsBulkPublishDisabledReasonKey } from "./skills-bulk-publish-gate";
import {
  filterSkillInventoryItems,
  skillInventoryInstanceId,
  type SkillInventoryFilters,
  type SkillInventorySelectionId,
} from "../lib/skill-inventory-filters";
import { isTauriRuntime } from "../utils";
import { recordSendWorkflowTrace } from "../lib/send-workflow-trace";

type InstallResult = { ok: boolean; message: string };
type ActionSkillCard = SkillCard & { mutationTarget: SkillMutationTarget };
type InventoryViewMode = "cards" | "table";
type InventoryScopeFilter = "all" | SkillInstance["scope"];
type SkillImportSourceFilter = "all" | VesloSkillImportSourceAgent;
type SkillImportStatusFilter = "all" | VesloSkillImportStatus;
type WorkspaceInstallAction = {
  name: string;
  source: "detail" | "selection";
  targets: SkillMutationTarget[];
};

type SkillBundleV1 = {
  schemaVersion: 1;
  type: "skill";
  name: string;
  content: string;
  description?: string;
  trigger?: string;
};

const SKILLS_TOAST_DISMISS_DELAY_MS = 4_000;
const workspaceInstallTitleId = "skill-install-workspace-title";

const cloneSkillInventoryItem = (item: SkillInventoryItem): SkillInventoryItem => ({
  ...item,
  workspaceInstances: [...item.workspaceInstances],
});

const mergeRemoteFallbackIntoInventory = (
  inventoryItems: SkillInventoryItem[],
  fallbackItems: SkillInventoryItem[],
) =>
  [...inventoryItems, ...fallbackItems].reduce<SkillInventoryItem[]>((items, next) => {
    const existing = items.find((item) => item.name === next.name);
    if (!existing) return [...items, cloneSkillInventoryItem(next)];
    const mergedGlobalInstance = existing.globalInstance ?? next.globalInstance;
    return items.map((item) => (
      item.name === next.name
        ? {
            ...existing,
            description: existing.description ?? next.description,
            trigger: existing.trigger ?? next.trigger,
            globalInstance: mergedGlobalInstance,
            workspaceInstances: [...existing.workspaceInstances, ...next.workspaceInstances],
            hubItem: existing.hubItem ?? next.hubItem,
            status: mergedGlobalInstance ? "mixed" : "workspace-only",
          }
        : item
    ));
  }, []);

export type SkillsViewProps = {
  workspaceName: string;
  activeWorkspaceId: string;
  activeWorkspaceRoot: string;
  isRemoteWorkspace: boolean;
  isPrivateWorkspacePath: (folder: string | null | undefined) => boolean;
  busy: boolean;
  vesloServerStatus: VesloServerStatus;
  vesloServerClient: VesloServerClient | null;
  vesloServerCanWriteSkills: boolean;
  vesloServerSkillRegistryAvailable: boolean;
  skillRegistryAuthContext: VesloSkillRegistryAuthContext;
  canInstallSkillCreator: boolean;
  canUseDesktopTools: boolean;
  accessHint?: string | null;
  refreshSkills: (options?: { force?: boolean }) => void;
  refreshSkillInventory: (options?: { force?: boolean }) => void;
  refreshSkillImportCandidates: (options?: { force?: boolean }) => void;
  refreshHubSkills: (options?: { force?: boolean }) => void;
  skills: SkillCard[];
  skillsStatus: string | null;
  skillInventory: SkillInventoryItem[];
  skillInventoryStatus: string | null;
  skillImportCandidates: VesloSkillImportCandidate[];
  skillImportStatus: string | null;
  hubSkills: HubSkillCard[];
  hubSkillsStatus: string | null;
  workspaces: WorkspaceInfo[];
  installSkillCreator: () => Promise<InstallResult>;
  installHubSkill: (name: string, target: HubSkillInstallTarget) => Promise<InstallResult>;
  uninstallSkill: (name: string) => void;
  readSkill: (name: string) => Promise<{ name: string; path: string; content: string } | null>;
  saveSkill: (input: { name: string; path?: string; content: string; description?: string }) => Promise<SkillSaveResult>;
  readSkillInstanceFiles: (target: SkillMutationTarget) => Promise<{ files: SkillFileEntry[] } | null>;
  readSkillInstance: (target: SkillMutationTarget) => Promise<{ name: string; path: string; content: string } | null>;
  saveSkillInstance: (target: SkillMutationTarget, content: string) => Promise<SkillSaveResult>;
  setSkillInstanceEnabled: (target: SkillMutationTarget, enabled: boolean) => Promise<SkillSaveResult>;
  deleteSkillInstance: (target: SkillMutationTarget) => Promise<void>;
  removeSkillInstance: (target: SkillMutationTarget) => Promise<SkillSaveResult>;
  batchRemoveSkillInstances: (targets: SkillMutationTarget[]) => Promise<SkillSaveResult>;
  restoreSkillInstance: (target: SkillMutationTarget) => Promise<SkillSaveResult>;
  copySkillInstanceToGlobal: (target: SkillMutationTarget, options?: { deleteSource?: boolean }) => Promise<SkillSaveResult>;
  copySkillInstanceToWorkspace: (target: SkillMutationTarget, workspaceId: string) => Promise<SkillSaveResult>;
  importSkillCandidates: (candidateIds: string[]) => Promise<SkillSaveResult>;
  createSessionAndOpen: () => void;
  setPrompt: (value: string) => void;
};

export default function SkillsView(props: SkillsViewProps) {
  // Translation helper that uses current language from i18n
  const translate = (key: string, replacements?: Record<string, string>) => {
    let value = t(key, currentLocale());
    if (!replacements) return value;
    for (const [name, replacement] of Object.entries(replacements)) {
      value = value.replace(`{${name}}`, replacement);
    }
    return value;
  };

  const inventoryHasActiveWorkspaceRows = createMemo(() =>
    props.skillInventory.some((item) =>
      item.workspaceInstances.some((instance) => instance.workspaceId === props.activeWorkspaceId)
    )
  );

  const activeRemoteInventoryItems = createMemo<SkillInventoryItem[]>(() => {
    if (!props.isRemoteWorkspace || inventoryHasActiveWorkspaceRows()) return [];
    return props.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      trigger: skill.trigger,
      status: "workspace-only",
      workspaceInstances: [
        {
          id: `workspace:${props.activeWorkspaceId}:${skill.name}:${skill.path}`,
          name: skill.name,
          scope: "workspace",
          workspaceId: props.activeWorkspaceId,
          workspaceLabel: props.workspaceName,
          path: skill.path,
          description: skill.description,
          trigger: skill.trigger,
          source: "unknown",
          registry: skill.registry,
          enabled: true,
          readable: true,
          writable: true,
        },
      ],
    }));
  });

  const activeInstalledInventoryItems = createMemo(() =>
    mergeRemoteFallbackIntoInventory(
      filterSkillInventoryItems(props.skillInventory, { includeDeleted: false })
        .filter((item) => item.status !== "hub-only"),
      activeRemoteInventoryItems(),
    )
  );
  const installedInventoryItems = createMemo(() => activeInstalledInventoryItems());
  const inventoryItemsForDisplay = createMemo(() =>
    mergeRemoteFallbackIntoInventory(
      props.skillInventory,
      activeRemoteInventoryItems(),
    )
  );

  const [uninstallTarget, setUninstallTarget] = createSignal<SkillMutationTarget | null>(null);
  const uninstallOpen = createMemo(() => uninstallTarget() != null);
  const [bulkRemoveTargets, setBulkRemoveTargets] = createSignal<SkillMutationTarget[]>([]);
  const bulkRemoveOpen = createMemo(() => bulkRemoveTargets().length > 0);
  const [restoreTarget, setRestoreTarget] = createSignal<SkillMutationTarget | null>(null);
  const restoreOpen = createMemo(() => restoreTarget() != null);
  const [removePending, setRemovePending] = createSignal(false);
  const [restorePending, setRestorePending] = createSignal(false);
  const [enabledMutationIds, setEnabledMutationIds] = createSignal<string[]>([]);
  const skillMutationBusy = createMemo(() => props.busy || removePending() || restorePending());
  const [searchQuery, setSearchQuery] = createSignal("");
  const [inventoryScopeFilter, setInventoryScopeFilter] = createSignal<InventoryScopeFilter>("all");
  const [inventoryWorkspaceFilter, setInventoryWorkspaceFilter] = createSignal("all");
  const [inventoryIncludeDeleted, setInventoryIncludeDeleted] = createSignal(false);
  const [inventoryViewMode, setInventoryViewMode] = createSignal<InventoryViewMode>("cards");
  const [selectedInventoryIds, setSelectedInventoryIds] = createSignal<SkillInventorySelectionId[]>([]);
  const [skillImportOpen, setSkillImportOpen] = createSignal(false);
  const [skillImportSearch, setSkillImportSearch] = createSignal("");
  const [skillImportSourceFilter, setSkillImportSourceFilter] = createSignal<SkillImportSourceFilter>("all");
  const [skillImportStatusFilter, setSkillImportStatusFilter] = createSignal<SkillImportStatusFilter>("all");
  const [selectedSkillImportIds, setSelectedSkillImportIds] = createSignal<string[]>([]);
  const [skillImportBusy, setSkillImportBusy] = createSignal(false);

  const [installLinkOpen, setInstallLinkOpen] = createSignal(false);
  const [installLinkUrl, setInstallLinkUrl] = createSignal("");
  const [installLinkBusy, setInstallLinkBusy] = createSignal(false);
  const [installLinkError, setInstallLinkError] = createSignal<string | null>(null);
  const [installLinkBundle, setInstallLinkBundle] = createSignal<SkillBundleV1 | null>(null);

  const [installTargetSkill, setInstallTargetSkill] = createSignal<HubSkillCard | null>(null);
  const [selectedInstallScope, setSelectedInstallScope] = createSignal<"global" | "workspace">("workspace");
  const [selectedInstallWorkspaceId, setSelectedInstallWorkspaceId] = createSignal<string | null>(null);
  const [workspaceInstallAction, setWorkspaceInstallAction] = createSignal<WorkspaceInstallAction | null>(null);
  const [selectedWorkspaceInstallWorkspaceId, setSelectedWorkspaceInstallWorkspaceId] = createSignal<string | null>(null);
  const [workspaceInstallBusy, setWorkspaceInstallBusy] = createSignal(false);

  const [selectedSkill, setSelectedSkill] = createSignal<ActionSkillCard | null>(null);
  const [selectedContent, setSelectedContent] = createSignal("");
  const [selectedLoading, setSelectedLoading] = createSignal(false);
  const [selectedDirty, setSelectedDirty] = createSignal(false);
  const [selectedError, setSelectedError] = createSignal<string | null>(null);
  const [selectedDetail, setSelectedDetail] = createSignal<{ item: SkillInventoryItem; instance: SkillInstance } | null>(null);
  const [selectedDetailTab, setSelectedDetailTab] = createSignal<SkillDetailTab>("overview");
  const [selectedDetailFiles, setSelectedDetailFiles] = createSignal<SkillDetailFile[]>([]);
  const [selectedDetailFilesLoading, setSelectedDetailFilesLoading] = createSignal(false);
  const [selectedDetailFilesError, setSelectedDetailFilesError] = createSignal<string | null>(null);
  const [selectedDetailFilesTargetId, setSelectedDetailFilesTargetId] = createSignal<string | null>(null);
  const [selectedDetailFilePath, setSelectedDetailFilePath] = createSignal<string | null>(null);
  const [reviewDialog, setReviewDialog] = createSignal<{
    mode: "request" | "review";
    targetScope: SkillReviewTargetScope;
    action: SkillDetailActionInput;
    item: SkillInventoryItem;
    instance: SkillInstance;
  } | null>(null);
  const [reviewReason, setReviewReason] = createSignal("");
  const [reviewDrafts, setReviewDrafts] = createSignal<Record<string, string>>({});
  const [publishRequestPending, setPublishRequestPending] = createSignal(false);

  const [toast, setToast] = createSignal<string | null>(null);
  const [installingHubSkill, setInstallingHubSkill] = createSignal<string | null>(null);

  onMount(() => {
    const traceId = `skills-view-${Date.now()}`;
    const mountedAt = performance.now();
    const workspaceId = props.activeWorkspaceId;
    const workspaceType = props.isRemoteWorkspace ? "remote" : "local";
    const workspaceCount = props.workspaces.length;
    const refreshSkillInventory = props.refreshSkillInventory;
    const trace = (event: string, payload?: Record<string, unknown>) =>
      recordSendWorkflowTrace("skills-view", event, {
        traceId,
        workspaceId,
        workspaceType,
        workspaceCount,
        ...payload,
      });
    const traceRefresh = (refresh: () => Promise<void>) => {
      const startedAt = performance.now();
      trace("skills-view:inventory:start");
      void refresh().then(
        () => trace("skills-view:inventory:done", { durationMs: Math.round(performance.now() - startedAt) }),
        (error: unknown) => trace("skills-view:inventory:error", {
          durationMs: Math.round(performance.now() - startedAt),
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    };

    trace("skills-view:mount");
    requestAnimationFrame(() => {
      trace("skills-view:first-animation-frame", {
        durationMs: Math.round(performance.now() - mountedAt),
      });
    });
    onCleanup(() => {
      trace("skills-view:unmount", { durationMs: Math.round(performance.now() - mountedAt) });
    });
    traceRefresh(() => Promise.resolve(refreshSkillInventory({ force: true })));
  });

  createEffect(() => {
    const message = toast();
    if (!message) return;
    const id = window.setTimeout(() => setToast(null), SKILLS_TOAST_DISMISS_DELAY_MS);
    onCleanup(() => window.clearTimeout(id));
  });

  const maskError = (value: unknown) => (
    value instanceof Error ? value.message : translate("skills.unknown_error")
  );

  const stripFrontmatter = (content: string) => {
    const raw = String(content ?? "");
    const match = raw.match(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/);
    if (!match) return raw;
    return raw.slice(match[0].length);
  };

  const resolveUniqueSkillName = (base: string, taken: Set<string>) => {
    const trimmed = String(base ?? "").trim();
    if (!trimmed) return "";
    if (!taken.has(trimmed)) return trimmed;
    for (let i = 2; i < 1_000; i++) {
      const candidate = `${trimmed}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return `${trimmed}-${Date.now()}`;
  };

  const normalizeSkillPath = (value: string | null | undefined) =>
    String(value ?? "").trim().replace(/\\/g, "/");

  const workspaceLabelForInstance = (instance: SkillInstance) => {
    const workspaceId = instance.workspaceId?.trim();
    const workspace = workspaceId ? props.workspaces.find((item) => item.id === workspaceId) : null;
    return (
      instance.workspaceLabel?.trim() ||
      workspace?.displayName?.trim() ||
      workspace?.vesloWorkspaceName?.trim() ||
      workspace?.name?.trim() ||
      workspace?.path?.trim() ||
      workspaceId ||
      translate("skills.worker_fallback")
    );
  };

  const skillDirectoryPathForLocation = (path: string) =>
    path.trim().replace(/[\\/](?:SKILL\.md|AGENTS\.md)$/i, "");

  const openInventoryInstanceLocation = async (path: string) => {
    const originalTarget = path.trim();
    const target = skillDirectoryPathForLocation(path);
    if (!target) return;
    if (!isTauriRuntime()) {
      setToast(translate("skills.desktop_required"));
      return;
    }
    try {
      const { openPath, revealItemInDir } = await import("@tauri-apps/plugin-opener");
      try {
        await openPath(target);
      } catch {
        await revealItemInDir(originalTarget || target);
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : translate("skills.reveal_failed"));
    }
  };

  const workspaceLabelForTarget = (workspace: WorkspaceInfo) => (
    workspace.displayName?.trim() ||
    workspace.vesloWorkspaceName?.trim() ||
    workspace.name?.trim() ||
    workspace.directory?.trim() ||
    workspace.path?.trim() ||
    workspace.id
  );

  const inventoryInstanceLifecycle = (instance: SkillInstance) =>
    instance.lifecycle === "removed" ? "removed" : "active";

  const isPublishableInventoryInstance = (instance: SkillInstance) => {
    if (inventoryInstanceLifecycle(instance) !== "active") return false;
    if (instance.readable === false) return false;
    return instance.scope === "user-global" || instance.scope === "workspace";
  };

  const resolveSelectedDetailFromInventory = (
    detail: { item: SkillInventoryItem; instance: SkillInstance },
    items: SkillInventoryItem[],
  ): { item: SkillInventoryItem; instance: SkillInstance } | null => {
    const matchingItem = items.find((item) => item.name === detail.item.name);
    if (!matchingItem) return null;

    const instances = [matchingItem.globalInstance, ...matchingItem.workspaceInstances]
      .filter((instance): instance is SkillInstance => Boolean(instance));
    const matchingInstance = instances.find((instance) => instance.id === detail.instance.id);
    const replacementInstance = matchingInstance
      ?? instances.find((instance) => inventoryInstanceLifecycle(instance) === "active")
      ?? instances.at(0)
      ?? null;

    return replacementInstance ? { item: matchingItem, instance: replacementInstance } : null;
  };

  createEffect(() => {
    const detail = selectedDetail();
    if (!detail) return;
    const nextDetail = resolveSelectedDetailFromInventory(detail, inventoryItemsForDisplay());
    if (!nextDetail) {
      setSelectedDetail(null);
      return;
    }
    if (nextDetail.instance.id !== detail.instance.id || nextDetail.item !== detail.item) {
      setSelectedDetail(nextDetail);
    }
  });

  const canRevealInventoryInstanceLocation = (instance: SkillInstance) =>
    inventoryInstanceLifecycle(instance) === "active" && Boolean(instance.path.trim());

  const instanceHasRegistryMutationMetadata = (instance: SkillInstance) =>
    Boolean(instance.registry?.installationId?.trim() || instance.registry?.policyId?.trim());

  const instanceHasRestoreMetadata = (instance: SkillInstance) =>
    Boolean(instance.restoreTarget || instanceHasRegistryMutationMetadata(instance));

  const editableWorkspaceMutationTargetForInstance = (instance: SkillInstance): SkillMutationTarget | null => {
    if (inventoryInstanceLifecycle(instance) === "removed") return null;
    if (!instance.writable) return null;
    if (instance.scope !== "workspace") return null;
    if (instance.workspaceId !== props.activeWorkspaceId) return null;
    return skillMutationTargetFromInstance(instance);
  };

  const removeTargetForInstance = (instance: SkillInstance): SkillMutationTarget | null => {
    if (inventoryInstanceLifecycle(instance) === "removed") return null;
    if (instance.registry?.removalPolicy === "locked") return null;
    if (instance.scope === "user-global") return skillMutationTargetFromInstance(instance);
    if (instance.scope === "workspace") {
      if (instanceHasRegistryMutationMetadata(instance)) return skillMutationTargetFromInstance(instance);
      if (!instance.workspaceId?.trim()) return null;
      if (instance.writable === false) return null;
      return skillMutationTargetFromInstance(instance);
    }
    if (instance.scope === "organization" && instanceHasRegistryMutationMetadata(instance)) {
      return skillMutationTargetFromInstance(instance);
    }
    return null;
  };

  const restoreTargetForInstance = (instance: SkillInstance): SkillMutationTarget | null => {
    if (inventoryInstanceLifecycle(instance) !== "removed") return null;
    if (instance.registry?.removalPolicy === "locked") return null;
    if (!instanceHasRestoreMetadata(instance)) return null;
    return skillMutationTargetFromInstance(instance);
  };

  const workspaceForInstance = (instance: SkillInstance) => {
    const workspaceId = instance.workspaceId?.trim();
    if (!workspaceId) return null;
    return props.workspaces.find((workspace) => workspace.id === workspaceId) ?? null;
  };

  const workspaceInstanceHasLocalTransferSource = (instance: SkillInstance) => {
    const workspaceId = instance.workspaceId?.trim();
    if (!workspaceId) return false;
    if (workspaceId === props.activeWorkspaceId) return !props.isRemoteWorkspace;
    const workspace = workspaceForInstance(instance);
    const workspacePath = workspace?.path?.trim() || workspace?.directory?.trim() || "";
    return workspace?.workspaceType === "local" && Boolean(workspacePath);
  };

  const globalTransferTargetForInstance = (instance: SkillInstance): SkillMutationTarget | null => {
    if (globalTransferDisabledReasonForInstance(instance)) return null;
    return skillMutationTargetFromInstance(instance);
  };

  const actionSkillForInstance = (instance: SkillInstance): ActionSkillCard | null => {
    const mutationTarget = editableWorkspaceMutationTargetForInstance(instance);
    if (!mutationTarget) return null;
    const instancePath = normalizeSkillPath(instance.path);
    const skill = props.skills.find((candidate) =>
      candidate.name === instance.name && normalizeSkillPath(candidate.path) === instancePath
    );
    return skill
      ? {
          ...skill,
          mutationTarget,
        }
      : null;
  };

  const canRemoveInventoryInstance = (input: { item: SkillInventoryItem; instance: SkillInstance }) =>
    Boolean(removeTargetForInstance(input.instance));

  const canRestoreInventoryInstance = (input: { item: SkillInventoryItem; instance: SkillInstance }) =>
    Boolean(restoreTargetForInstance(input.instance));

  const uninstallDisabledReason = (input: { item: SkillInventoryItem; instance: SkillInstance }) => {
    if (inventoryInstanceLifecycle(input.instance) === "removed") return translate("skills.remove_location_unavailable");
    if (input.instance.registry?.removalPolicy === "locked") return translate("skills.managed_remove_locked");
    if (input.instance.scope === "workspace") {
      if (instanceHasRegistryMutationMetadata(input.instance)) return null;
      if (!input.instance.workspaceId?.trim()) return translate("skills.remove_location_unavailable");
      if (input.instance.writable === false) return translate("skills.uninstall_read_only");
      return null;
    }
    if (input.instance.scope === "user-global") return null;
    if (input.instance.scope === "organization") {
      return instanceHasRegistryMutationMetadata(input.instance) ? null : translate("skills.remove_location_unavailable");
    }
    return translate("skills.remove_location_unavailable");
  };

  const restoreDisabledReason = (input: { item: SkillInventoryItem; instance: SkillInstance }) => {
    if (inventoryInstanceLifecycle(input.instance) !== "removed") return translate("skills.restore_location_unavailable");
    if (input.instance.registry?.removalPolicy === "locked") return translate("skills.managed_restore_locked");
    if (!instanceHasRestoreMetadata(input.instance)) return translate("skills.restore_location_unavailable");
    return null;
  };

  const globalTransferDisabledReasonForInstance = (instance: SkillInstance) => {
    if (instance.writable === false) return translate("skills.copy_to_global_read_only");
    if (instance.scope === "user-global") return translate("skills.copy_to_global_already_global");
    if (instance.scope !== "workspace") return translate("skills.copy_to_global_unavailable");
    if (!workspaceInstanceHasLocalTransferSource(instance)) return translate("skills.copy_to_global_workspace_local_required");
    return null;
  };

  const installedInventoryFilterState = createMemo<SkillInventoryFilters>(() => {
    const scope = inventoryScopeFilter();
    const workspaceId = inventoryWorkspaceFilter();
    return {
      query: searchQuery(),
      scopes: scope === "all" ? undefined : [scope],
      workspaceId: workspaceId === "all" ? undefined : workspaceId,
      includeDeleted: inventoryIncludeDeleted(),
    };
  });

  const filteredInstalledInventoryItems = createMemo(() =>
    filterSkillInventoryItems(
      inventoryItemsForDisplay(),
      installedInventoryFilterState(),
    ).filter((item) => item.status !== "hub-only")
  );

  const allWorkspaceInventoryItems = createMemo(() =>
    filteredInstalledInventoryItems().filter((item) => Boolean(item.globalInstance))
  );

  const workspaceInventoryRows = createMemo(() =>
    filteredInstalledInventoryItems()
      .flatMap((item) =>
        item.globalInstance
          ? []
          : item.workspaceInstances.map((instance) => ({
              item,
              instance,
            }))
      )
  );

  const inventoryTableRows = createMemo(() => [
    ...allWorkspaceInventoryItems().flatMap((item) =>
      item.globalInstance
        ? [{
            item,
            instance: item.globalInstance,
            workspaceLabel: translate("skills.all_workspaces"),
          }]
        : []
    ),
    ...workspaceInventoryRows().map((row) => ({
      ...row,
      workspaceLabel: workspaceLabelForInstance(row.instance),
    })),
  ]);

  const currentInventorySelectionIds = createMemo(() =>
    inventoryTableRows().map((row) => skillInventoryInstanceId(row.instance))
  );
  const selectedInventoryIdSet = createMemo(() => new Set(selectedInventoryIds()));
  const enabledMutationIdSet = createMemo(() => new Set(enabledMutationIds()));
  const selectedInventoryCount = createMemo(() =>
    selectedInventoryIds().filter((id) => currentInventorySelectionIds().includes(id)).length
  );
  const allCurrentInventorySelected = createMemo(() => {
    const ids = currentInventorySelectionIds();
    return ids.length > 0 && ids.every((id) => selectedInventoryIdSet().has(id));
  });

  createEffect(() => {
    const allowed = new Set(currentInventorySelectionIds());
    setSelectedInventoryIds((prev) => prev.filter((id) => allowed.has(id)));
  });

  createEffect(() => {
    const allowed = new Set(props.skillImportCandidates.map((candidate) => candidate.id));
    setSelectedSkillImportIds((prev) => prev.filter((id) => allowed.has(id)));
  });

  const skillImportSourceOptions: SkillImportSourceFilter[] = ["all", "codex", "claude", "opencode", "agents"];
  const skillImportStatusOptions: SkillImportStatusFilter[] = ["all", "ready", "needs-review", "conflict", "invalid"];

  const importSourceLabel = (source: SkillImportSourceFilter) => {
    if (source === "codex") return translate("skills.import_source_codex");
    if (source === "claude") return translate("skills.import_source_claude");
    if (source === "opencode") return translate("skills.import_source_opencode");
    if (source === "agents") return translate("skills.import_source_agents");
    return translate("skills.import_source_all");
  };

  const importStatusLabel = (status: SkillImportStatusFilter) => {
    if (status === "ready") return translate("skills.import_status_ready");
    if (status === "needs-review") return translate("skills.import_status_needs_review");
    if (status === "conflict") return translate("skills.import_status_conflict");
    if (status === "invalid") return translate("skills.import_status_invalid");
    return translate("skills.import_status_all");
  };

  const targetLabelForImportCandidate = (candidate: VesloSkillImportCandidate) =>
    candidate.target.scope === "user-global"
      ? translate("skills.import_target_user")
      : translate("skills.import_target_workspace", { workspace: candidate.target.workspaceName });

  const canImportCandidate = (candidate: VesloSkillImportCandidate) =>
    candidate.status === "ready" || candidate.status === "needs-review";

  const filteredSkillImportCandidates = createMemo(() => {
    const query = skillImportSearch().trim().toLowerCase();
    return props.skillImportCandidates.filter((candidate) => {
      const sourceMatches = skillImportSourceFilter() === "all" || candidate.sourceAgent === skillImportSourceFilter();
      const statusMatches = skillImportStatusFilter() === "all" || candidate.status === skillImportStatusFilter();
      const queryMatches =
        !query ||
        candidate.name.toLowerCase().includes(query) ||
        candidate.description.toLowerCase().includes(query) ||
        candidate.sourcePath.toLowerCase().includes(query);
      return sourceMatches && statusMatches && queryMatches;
    });
  });

  const selectedSkillImportIdSet = createMemo(() => new Set(selectedSkillImportIds()));
  const selectedImportableSkillIds = createMemo(() =>
    filteredSkillImportCandidates()
      .filter((candidate) => selectedSkillImportIdSet().has(candidate.id) && canImportCandidate(candidate))
      .map((candidate) => candidate.id)
  );

  const toggleSkillImportSelection = (candidate: VesloSkillImportCandidate, checked: boolean) => {
    if (!canImportCandidate(candidate)) return;
    setSelectedSkillImportIds((prev) => {
      const next = new Set(prev);
      if (checked) next.add(candidate.id);
      else next.delete(candidate.id);
      return [...next];
    });
  };

  const openSkillImport = () => {
    setSkillImportOpen(true);
    props.refreshSkillImportCandidates({ force: true });
  };

  const closeSkillImport = () => {
    if (skillImportBusy()) return;
    setSkillImportOpen(false);
  };

  const confirmSkillImport = async () => {
    const ids = selectedImportableSkillIds();
    if (ids.length === 0 || skillImportBusy()) {
      if (ids.length === 0) setToast(translate("skills.import_select_candidate"));
      return;
    }
    setSkillImportBusy(true);
    try {
      const result = await props.importSkillCandidates(ids);
      setToast(result.message ?? translate(result.ok ? "skills.import_success_count" : "skills.import_failed_count", { count: String(ids.length) }));
      if (result.ok) {
        setSelectedSkillImportIds([]);
        setSkillImportOpen(false);
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : translate("skills.import_failed_count", { count: "1" }));
    } finally {
      setSkillImportBusy(false);
    }
  };

  const toggleInventorySelection = (id: SkillInventorySelectionId, checked: boolean) => {
    setSelectedInventoryIds((prev) => {
      const next = new Set(prev);
      if (checked) {
        next.add(id);
      } else {
        next.delete(id);
      }
      return [...next];
    });
  };

  const toggleAllCurrentInventorySelection = (checked: boolean) => {
    if (checked) {
      setSelectedInventoryIds(currentInventorySelectionIds());
    } else {
      const current = new Set(currentInventorySelectionIds());
      setSelectedInventoryIds((prev) => prev.filter((id) => !current.has(id)));
    }
  };

  const selectedInventoryRows = createMemo(() =>
    inventoryTableRows().filter((row) => selectedInventoryIdSet().has(skillInventoryInstanceId(row.instance)))
  );
  const selectedInventoryScope = createMemo<SkillInstance["scope"] | "mixed" | null>(() => {
    const selectedRows = selectedInventoryRows();
    if (selectedRows.length === 0) return null;
    const [first] = selectedRows;
    return selectedRows.every((row) => row.instance.scope === first.instance.scope)
      ? first.instance.scope
      : "mixed";
  });
  const selectedGlobalTransferTargets = createMemo(() =>
    selectedInventoryRows()
      .filter((row) => inventoryInstanceLifecycle(row.instance) === "active")
      .map((row) => globalTransferTargetForInstance(row.instance))
      .filter((target): target is SkillMutationTarget => Boolean(target))
  );
  const selectedRemoveTargets = createMemo(() =>
    selectedInventoryRows()
      .filter((row) => inventoryInstanceLifecycle(row.instance) === "active")
      .map((row) => removeTargetForInstance(row.instance))
      .filter((target): target is SkillMutationTarget => Boolean(target))
  );
  const bulkRemoveDisabledReason = createMemo(() => {
    const selectedRows = selectedInventoryRows();
    if (selectedRows.length === 0) return translate("skills.select_skill_location");
    if (selectedRows.some((row) => inventoryInstanceLifecycle(row.instance) !== "active")) {
      return translate("skills.bulk_removed_actions_unavailable");
    }
    const firstDisabledReason = selectedRows
      .map((row) => uninstallDisabledReason({ item: row.item, instance: row.instance }))
      .find((reason): reason is string => Boolean(reason));
    if (firstDisabledReason) return firstDisabledReason;
    if (selectedRemoveTargets().length !== selectedRows.length) return translate("skills.remove_location_unavailable");
    return null;
  });
  const globalTransferDisabledReason = createMemo(() => {
    const selectedRows = selectedInventoryRows();
    if (selectedRows.length === 0) return translate("skills.select_skill_location");
    if (selectedInventoryScope() === "mixed") return translate("skills.bulk_mixed_scope_actions_unavailable");
    if (selectedRows.some((row) => inventoryInstanceLifecycle(row.instance) !== "active")) {
      return translate("skills.bulk_removed_actions_unavailable");
    }
    const firstDisabledReason = selectedRows
      .map((row) => globalTransferDisabledReasonForInstance(row.instance))
      .find((reason): reason is string => Boolean(reason));
    if (firstDisabledReason) return firstDisabledReason;
    if (selectedGlobalTransferTargets().length !== selectedRows.length) return translate("skills.copy_to_global_unavailable");
    return null;
  });
  const selectedWorkspaceInstallTargets = createMemo(() =>
    selectedInventoryRows()
      .filter((row) =>
        inventoryInstanceLifecycle(row.instance) === "active" &&
        row.instance.scope === "user-global" &&
        row.instance.readable !== false
      )
      .map((row) => skillMutationTargetFromInstance(row.instance))
  );
  const workspaceInstallDisabledReason = createMemo(() => {
    const selectedRows = selectedInventoryRows();
    if (selectedRows.length === 0) return translate("skills.select_skill_location");
    if (selectedInventoryScope() === "mixed") return translate("skills.bulk_mixed_scope_actions_unavailable");
    if (selectedRows.some((row) => inventoryInstanceLifecycle(row.instance) !== "active")) {
      return translate("skills.bulk_removed_actions_unavailable");
    }
    if (selectedInventoryScope() !== "user-global") return translate("skills.copy_to_workspace_unavailable");
    if (selectedWorkspaceInstallTargets().length !== selectedRows.length) return translate("skills.copy_to_workspace_unavailable");
    return null;
  });
  const bulkPublishDisabledReason = createMemo(() => {
    const selectedRows = selectedInventoryRows();
    const row = selectedRows.at(0);
    const reasonKey = resolveSkillsBulkPublishDisabledReasonKey({
      selectedCount: selectedRows.length,
      selectedPublishable: Boolean(row && isPublishableInventoryInstance(row.instance)),
      vesloServerStatus: props.vesloServerStatus,
      vesloServerCanWriteSkills: props.vesloServerCanWriteSkills,
      vesloServerSkillRegistryAvailable: props.vesloServerSkillRegistryAvailable,
    });
    return reasonKey ? translate(reasonKey) : null;
  });
  const selectedInventoryShowsWorkspaceInstallAction = createMemo(() =>
    selectedInventoryRows().length > 0 &&
    selectedInventoryRows().every((row) => inventoryInstanceLifecycle(row.instance) === "active") &&
    selectedInventoryScope() === "user-global"
  );
  const selectedInventoryShowsGlobalTransferActions = createMemo(() =>
    selectedInventoryRows().length > 0 &&
    selectedInventoryRows().every((row) => inventoryInstanceLifecycle(row.instance) === "active") &&
    selectedInventoryScope() === "workspace"
  );

  const transferSelectedSkillsToGlobal = async (deleteSource: boolean) => {
    const disabledReason = globalTransferDisabledReason();
    if (disabledReason) {
      setToast(disabledReason);
      return;
    }

    for (const target of selectedGlobalTransferTargets()) {
      const result = await props.copySkillInstanceToGlobal(target, { deleteSource: true });
      if (!result.ok) {
        setToast(result.message ?? translate("skills.failed_save_skill"));
        return;
      }
    }

    setSelectedInventoryIds([]);
    setToast(translate("skills.moved_to_global"));
    props.refreshSkillInventory({ force: true });
  };

  const openSelectedWorkspaceInstallTargetPicker = () => {
    if (props.busy || workspaceInstallBusy()) return;
    const disabledReason = workspaceInstallDisabledReason();
    if (disabledReason) {
      setToast(disabledReason);
      return;
    }
    const targets = selectedWorkspaceInstallTargets();
    if (targets.length === 0) {
      setToast(translate("skills.copy_to_workspace_unavailable"));
      return;
    }
    const defaultWorkspace = defaultWorkspaceInstallTarget();
    setSelectedWorkspaceInstallWorkspaceId(defaultWorkspace?.id ?? null);
    setWorkspaceInstallAction({
      name: targets.length === 1 ? targets[0].name : translate("skills.selected_count", { count: String(targets.length) }),
      source: "selection",
      targets,
    });
  };

  const openSelectedBulkRemove = () => {
    if (props.busy || skillMutationBusy()) return;
    const disabledReason = bulkRemoveDisabledReason();
    if (disabledReason) {
      setToast(disabledReason);
      return;
    }
    const targets = selectedRemoveTargets();
    if (targets.length === 0) {
      setToast(translate("skills.remove_location_unavailable"));
      return;
    }
    setBulkRemoveTargets(targets);
  };

  const openSelectedBulkPublish = () => {
    const disabledReason = bulkPublishDisabledReason();
    if (disabledReason) {
      setToast(disabledReason);
      return;
    }
    const row = selectedInventoryRows().at(0);
    if (!row) return;
    openSkillReviewDialog("organization", skillDetailActionForInventoryRow(row), row);
  };

  const activeWorkspaceInstalledNames = createMemo(() =>
    new Set(
      installedInventoryItems()
        .flatMap((item) =>
          item.workspaceInstances.some((instance) => instance.workspaceId === props.activeWorkspaceId)
            ? [item.name]
            : []
        )
    )
  );
  const activeOrGlobalInstalledNames = createMemo(() =>
    new Set(
      installedInventoryItems()
        .flatMap((item) =>
          item.globalInstance || item.workspaceInstances.some((instance) => instance.workspaceId === props.activeWorkspaceId)
            ? [item.name]
            : []
        )
    )
  );
  const installedNames = createMemo(() => activeOrGlobalInstalledNames());
  const canOverwriteInstallLinkBundle = (name: string) => activeWorkspaceInstalledNames().has(name.trim());
  const installLinkShouldRename = (name: string, mode: "overwrite" | "keep-both") =>
    mode === "keep-both" || (installedNames().has(name.trim()) && !canOverwriteInstallLinkBundle(name));

  const openSkillDetail = (item: SkillInventoryItem, instance: SkillInstance) => {
    resetSelectedDetailFiles();
    setSelectedDetail({ item, instance });
    setSelectedDetailTab("overview");
  };

  const closeSkillDetail = () => {
    setSelectedDetail(null);
    setSelectedDetailTab("overview");
    resetSelectedDetailFiles();
  };

  function resetSelectedDetailFiles() {
    setSelectedDetailFiles([]);
    setSelectedDetailFilesLoading(false);
    setSelectedDetailFilesError(null);
    setSelectedDetailFilesTargetId(null);
    setSelectedDetailFilePath(null);
  }

  const firstPreferredSkillFilePath = (files: SkillDetailFile[]) =>
    files.find((file) => file.path === "SKILL.md")?.path ?? files[0]?.path ?? null;

  const loadSelectedDetailFiles = async (options?: { force?: boolean }) => {
    const detail = selectedDetail();
    if (!detail) return;
    const targetId = detail.instance.id;
    if (!options?.force && selectedDetailFilesTargetId() === targetId && (selectedDetailFiles().length > 0 || selectedDetailFilesError())) {
      return;
    }
    setSelectedDetailFilesLoading(true);
    setSelectedDetailFilesError(null);
    const result = await props.readSkillInstanceFiles(skillMutationTargetFromInstance(detail.instance));
    const currentDetail = selectedDetail();
    if (!currentDetail || currentDetail.instance.id !== targetId) return;
    if (!result) {
      setSelectedDetailFiles([]);
      setSelectedDetailFilesTargetId(targetId);
      setSelectedDetailFilesError(props.skillsStatus || translate("skills.failed_to_load"));
      setSelectedDetailFilePath(null);
      setSelectedDetailFilesLoading(false);
      return;
    }
    setSelectedDetailFiles(result.files);
    setSelectedDetailFilesTargetId(targetId);
    setSelectedDetailFilePath((current) =>
      current && result.files.some((file) => file.path === current)
        ? current
        : firstPreferredSkillFilePath(result.files)
    );
    setSelectedDetailFilesLoading(false);
  };

  const selectSkillDetailTab = (tab: SkillDetailTab) => {
    setSelectedDetailTab(tab);
    if (tab === "files") void loadSelectedDetailFiles();
  };

  const toggleTableRowSelection = (instance: SkillInstance) => {
    const id = skillInventoryInstanceId(instance);
    toggleInventorySelection(id, !selectedInventoryIdSet().has(id));
  };

  const scopeLabelForInstance = (instance: SkillInstance) => {
    if (instance.scope === "user-global") return translate("skills.filter_scope_global");
    if (instance.scope === "organization") return translate("skills.detail_scope_organization");
    if (instance.scope === "platform") return translate("skills.detail_scope_platform");
    return translate("skills.filter_scope_workspace");
  };

  const detailLocationScopeForInstance = (instance: SkillInstance): SkillDetailLocation["scope"] => {
    if (instance.scope === "user-global") return "global";
    if (instance.scope === "organization" || instance.scope === "platform") return instance.scope;
    return "workspace";
  };

  const skillEnabledPending = (instance: SkillInstance) => enabledMutationIdSet().has(instance.id);
  const canToggleSkillEnabled = (instance: SkillInstance) => inventoryInstanceLifecycle(instance) === "active";
  const skillEnabledTitle = (instance: SkillInstance) => {
    if (skillEnabledPending(instance)) return translate("skills.enable_state_saving");
    return instance.enabled === false ? translate("skills.enable_skill") : translate("skills.disable_skill");
  };

  const toggleSkillInstanceEnabled = async (instance: SkillInstance, enabled: boolean) => {
    if (!canToggleSkillEnabled(instance) || skillEnabledPending(instance)) return;
    const id = instance.id;
    setEnabledMutationIds((current) => current.includes(id) ? current : [...current, id]);
    try {
      const result = await props.setSkillInstanceEnabled(skillMutationTargetFromInstance(instance), enabled);
      setToast(result.message ?? translate(result.ok ? "ui.indirect.saved_1caget" : "skills.failed_to_load"));
    } catch (e) {
      setToast(e instanceof Error ? e.message : translate("skills.failed_to_load"));
    } finally {
      setEnabledMutationIds((current) => current.filter((candidate) => candidate !== id));
      props.refreshSkillInventory({ force: true });
    }
  };

  const renderSkillEnabledSwitch = (input: { item: SkillInventoryItem; instance: SkillInstance }) => {
    const checked = () => input.instance.enabled !== false;
    const pending = () => skillEnabledPending(input.instance);
    const disabled = () => pending() || !canToggleSkillEnabled(input.instance);
    const title = () => skillEnabledTitle(input.instance);
    return (
      <button
        type="button"
        role="switch"
        data-testid="skill-enabled-switch"
        aria-checked={checked()}
        aria-label={title()}
        title={title()}
        disabled={disabled()}
        class={`relative h-6 w-11 shrink-0 rounded-full border transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-[rgba(var(--dls-accent-rgb),0.25)] disabled:cursor-not-allowed disabled:opacity-60 ${
          checked()
            ? "border-gray-12/20 bg-gray-12"
            : "border-gray-6 bg-gray-3 hover:bg-gray-4"
        }`}
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void toggleSkillInstanceEnabled(input.instance, !checked());
        }}
      >
        <span
          class={`absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-gray-1 shadow-sm transition-transform ${
            checked() ? "translate-x-5" : "translate-x-0"
          }`}
        />
      </button>
    );
  };

  const skillDetailLocationFromInstance = (instance: SkillInstance): SkillDetailLocation => ({
    id: instance.id,
    label: instance.scope === "workspace" ? workspaceLabelForInstance(instance) : scopeLabelForInstance(instance),
    scope: detailLocationScopeForInstance(instance),
    path: instance.path,
    writable: instance.writable,
    active: selectedDetail()?.instance.id === instance.id,
    source: instance.source,
    lifecycle: inventoryInstanceLifecycle(instance),
    restoreAvailable: inventoryInstanceLifecycle(instance) === "removed" && instanceHasRestoreMetadata(instance),
    restoreUnavailableReason: restoreDisabledReason({ item: selectedDetail()?.item ?? { name: instance.name, workspaceInstances: [], status: "workspace-only" }, instance }),
  });

  const selectedDetailLocations = createMemo<SkillDetailLocation[]>(() => {
    const detail = selectedDetail();
    if (!detail) return [];
    const locations: SkillDetailLocation[] = [];
    if (detail.item.globalInstance) {
      locations.push(skillDetailLocationFromInstance(detail.item.globalInstance));
    }
    for (const instance of detail.item.workspaceInstances) {
      locations.push(skillDetailLocationFromInstance(instance));
    }
    return locations;
  });

  const selectedDetailMetadata = createMemo<SkillDetailMetadata | null>(() => {
    const detail = selectedDetail();
    if (!detail) return null;
    return {
      id: detail.instance.id,
      name: detail.item.name,
      description: detail.instance.description ?? detail.item.description ?? null,
      trigger: detail.instance.trigger ?? detail.item.trigger ?? null,
      status: inventoryInstanceLifecycle(detail.instance) === "removed" ? translate("skills.removed_status") : detail.item.status,
      source: detail.instance.source,
      approvalStatus: "approved",
      updatedAt: null,
    };
  });

  const selectedDetailVersionTarget = createMemo<SkillVersionTargetMetadata | null>(() => {
    const detail = selectedDetail();
    if (!detail) return null;
    return {
      id: detail.instance.id,
      label: detail.instance.scope === "workspace" ? workspaceLabelForInstance(detail.instance) : scopeLabelForInstance(detail.instance),
      scope: detailLocationScopeForInstance(detail.instance),
      path: detail.instance.path,
      workspaceId: detail.instance.workspaceId ?? null,
    };
  });

  const selectedDetailVersions = createMemo<SkillVersionRow[]>(() => {
    const detail = selectedDetail();
    const target = selectedDetailVersionTarget();
    if (!detail || !target) return [];
    return [{
      id: detail.instance.id,
      version: translate("skills.current_version"),
      createdAt: translate("skills.runtime_copy"),
      status: "approved",
      target,
      isCurrent: true,
    }];
  });

  const showRegistryActionPending = () => {
    setToast(translate("skills.registry_action_pending"));
  };

  const detailInstanceForAction = (input?: SkillDetailActionInput): SkillInstance | null => {
    const detail = selectedDetail();
    if (!detail) return null;
    const locationId = input?.location?.id;
    if (!locationId) return detail.instance;
    return [detail.item.globalInstance, ...detail.item.workspaceInstances].find((instance) => instance?.id === locationId) ?? detail.instance;
  };

  const selectedDetailGlobalTransferDisabledReason = createMemo(() => {
    const detail = selectedDetail();
    return detail ? globalTransferDisabledReasonForInstance(detail.instance) : null;
  });

  const selectedDetailIsWorkspaceSkill = createMemo(() => {
    const detail = selectedDetail();
    return detail?.instance.scope === "workspace" && inventoryInstanceLifecycle(detail.instance) === "active";
  });

  const selectedDetailCanTransferToUserSkill = createMemo(() => {
    const detail = selectedDetail();
    return Boolean(
      detail &&
      detail.instance.scope === "workspace" &&
      selectedDetailGlobalTransferDisabledReason() === null,
    );
  });

  const selectedDetailCanInstallToWorkspace = createMemo(() => {
    const detail = selectedDetail();
    return Boolean(
      detail &&
      inventoryInstanceLifecycle(detail.instance) === "active" &&
      detail.instance.scope === "user-global" &&
      detail.instance.readable !== false,
    );
  });

  const selectedDetailCanPublishFromLocal = createMemo(() => {
    const detail = selectedDetail();
    return detail ? isPublishableInventoryInstance(detail.instance) : false;
  });

  const selectedDetailCanDeactivate = createMemo(() => {
    const detail = selectedDetail();
    return detail ? canRemoveInventoryInstance({ item: detail.item, instance: detail.instance }) : false;
  });

  const selectedDetailShowsRemoveAction = createMemo(() => {
    const detail = selectedDetail();
    return Boolean(detail && inventoryInstanceLifecycle(detail.instance) === "active");
  });

  const selectedDetailCanRestore = createMemo(() => {
    const detail = selectedDetail();
    return detail ? canRestoreInventoryInstance({ item: detail.item, instance: detail.instance }) : false;
  });

  const selectedDetailHasRestoreAction = createMemo(() => {
    const detail = selectedDetail();
    if (!detail) return false;
    return [detail.item.globalInstance, ...detail.item.workspaceInstances].some((instance) =>
      Boolean(
        instance &&
        inventoryInstanceLifecycle(instance) === "removed" &&
        instanceHasRestoreMetadata(instance),
      )
    );
  });

  const selectedDetailDeleteDisabledReason = createMemo(() => {
    const detail = selectedDetail();
    if (!detail) return null;
    return selectedDetailCanDeactivate() ? null : uninstallDisabledReason({ item: detail.item, instance: detail.instance });
  });

  const selectedDetailRestoreDisabledReason = createMemo(() => {
    const detail = selectedDetail();
    if (!detail) return null;
    return selectedDetailCanRestore() ? null : restoreDisabledReason({ item: detail.item, instance: detail.instance });
  });

  const copySelectedSkillToGlobal = (deleteSource: boolean, input?: SkillDetailActionInput) => {
    const actionInstance = detailInstanceForAction(input);
    if (!actionInstance) return;
    const target = globalTransferTargetForInstance(actionInstance);
    if (!target) {
      setToast(globalTransferDisabledReasonForInstance(actionInstance) ?? translate("skills.copy_to_global_unavailable"));
      return;
    }

    void props.copySkillInstanceToGlobal(target, { deleteSource: true }).then((result) => untrack(() => {
      setToast(result.message ?? translate(result.ok ? "skills.moved_to_global" : "skills.failed_save_skill"));
      if (result.ok) props.refreshSkillInventory({ force: true });
    }));
  };

  const workspaceInstallTargetWorkspaces = createMemo<WorkspaceInfo[]>(() =>
    buildSkillInstallTargetWorkspaces({
      activeWorkspaceId: props.activeWorkspaceId,
      activeWorkspaceName: props.workspaceName,
      activeWorkspaceRoot: props.activeWorkspaceRoot,
      activeWorkspaceType: props.isRemoteWorkspace ? "remote" : "local",
      isPrivateWorkspacePath: props.isPrivateWorkspacePath,
      requireLocalFilesystemTarget: true,
      workspaces: props.workspaces,
    })
  );

  const workspaceInstallTargetDisabledReason = (workspace: WorkspaceInfo) => {
    if (workspace.workspaceType !== "local") return translate("skills.install_workspace_target_local_required");
    const workspacePath = workspace.path.trim() || workspace.directory?.trim() || "";
    if (!workspacePath && workspace.id !== props.activeWorkspaceId) {
      return translate("skills.install_workspace_target_local_required");
    }
    return null;
  };

  const selectedWorkspaceInstallWorkspace = createMemo(() => {
    const workspaceId = selectedWorkspaceInstallWorkspaceId()?.trim();
    if (!workspaceId) return null;
    return workspaceInstallTargetWorkspaces().find((workspace) => workspace.id === workspaceId) ?? null;
  });

  const workspaceInstallCanSubmit = createMemo(() => {
    const workspace = selectedWorkspaceInstallWorkspace();
    return Boolean(workspace && !workspaceInstallTargetDisabledReason(workspace));
  });

  const defaultWorkspaceInstallTarget = () =>
    workspaceInstallTargetWorkspaces().find((workspace) =>
      workspace.id === props.activeWorkspaceId && !workspaceInstallTargetDisabledReason(workspace)
    ) ?? workspaceInstallTargetWorkspaces().find((workspace) => !workspaceInstallTargetDisabledReason(workspace)) ?? null;

  const openWorkspaceInstallTargetPicker = (input: SkillDetailActionInput) => {
    if (props.busy || workspaceInstallBusy()) return;
    const actionInstance = detailInstanceForAction(input);
    if (!actionInstance || actionInstance.scope !== "user-global" || actionInstance.readable === false) {
      setToast(translate("skills.copy_to_workspace_unavailable"));
      return;
    }
    const defaultWorkspace = defaultWorkspaceInstallTarget();
    setSelectedWorkspaceInstallWorkspaceId(defaultWorkspace?.id ?? null);
    setWorkspaceInstallAction({
      name: input.skill.name,
      source: "detail",
      targets: [skillMutationTargetFromInstance(actionInstance)],
    });
  };

  const closeWorkspaceInstallTargetPicker = () => {
    if (workspaceInstallBusy()) return;
    setWorkspaceInstallAction(null);
    setSelectedWorkspaceInstallWorkspaceId(null);
  };

  const confirmWorkspaceInstallTarget = async () => {
    const action = workspaceInstallAction();
    if (!action) return;
    const workspaceId = selectedWorkspaceInstallWorkspaceId()?.trim();
    if (!workspaceId) {
      setToast(translate("skills.install_workspace_target_required"));
      return;
    }
    const workspace = selectedWorkspaceInstallWorkspace();
    if (!workspace || workspaceInstallTargetDisabledReason(workspace)) {
      setToast(translate("skills.install_workspace_target_local_required"));
      return;
    }
    if (action.targets.length === 0 || action.targets.some((target) => target.scope !== "user-global")) {
      setToast(translate("skills.copy_to_workspace_unavailable"));
      return;
    }

    setWorkspaceInstallBusy(true);
    try {
      for (const target of action.targets) {
        const result = await props.copySkillInstanceToWorkspace(target, workspaceId);
        if (!result.ok) {
          setToast(result.message ?? translate("skills.failed_save_skill"));
          return;
        }
      }
      setToast(translate("skills.copied_to_workspace"));
      setWorkspaceInstallAction(null);
      setSelectedWorkspaceInstallWorkspaceId(null);
      if (action.source === "selection") setSelectedInventoryIds([]);
      props.refreshSkillInventory({ force: true });
    } catch (e) {
      setToast(e instanceof Error ? e.message : translate("skills.failed_save_skill"));
    } finally {
      setWorkspaceInstallBusy(false);
    }
  };

  const editSelectedSkill = () => {
    const detail = selectedDetail();
    if (!detail) return;
    const skill = actionSkillForInstance(detail.instance);
    if (!skill) {
      setToast(translate("skills.edit_unavailable"));
      return;
    }
    void openSkill(skill);
  };

  const skillDetailMetadataForInventoryRow = (input: { item: SkillInventoryItem; instance: SkillInstance }): SkillDetailMetadata => ({
    id: input.instance.id,
    name: input.item.name,
    description: input.instance.description ?? input.item.description ?? null,
    trigger: input.instance.trigger ?? input.item.trigger ?? null,
    status: inventoryInstanceLifecycle(input.instance) === "removed" ? translate("skills.removed_status") : input.item.status,
    source: input.instance.source,
    approvalStatus: "approved",
    updatedAt: null,
  });

  const skillDetailActionForInventoryRow = (input: { item: SkillInventoryItem; instance: SkillInstance }): SkillDetailActionInput => ({
    skill: skillDetailMetadataForInventoryRow(input),
    location: skillDetailLocationFromInstance(input.instance),
  });

  const skillReviewDraftKey = (targetScope: SkillReviewTargetScope, action: SkillDetailActionInput) =>
    `${targetScope}:${action.skill.id}:${action.skill.currentVersionId ?? action.skill.id}`;

  const openSkillReviewDialog = (
    targetScope: SkillReviewTargetScope,
    action: SkillDetailActionInput,
    explicitTarget?: { item: SkillInventoryItem; instance: SkillInstance },
  ) => {
    const detail = selectedDetail();
    const instance = explicitTarget?.instance ?? detailInstanceForAction(action);
    const item = explicitTarget?.item ?? detail?.item;
    if (!item || !instance) {
      setToast(translate("skills.bulk_publish_not_publishable"));
      return;
    }
    setReviewReason(reviewDrafts()[skillReviewDraftKey(targetScope, action)] ?? "");
    setReviewDialog({
      mode: "request",
      targetScope,
      action,
      item,
      instance,
    });
  };

  const closeSkillReviewDialog = () => {
    setReviewDialog(null);
    setReviewReason("");
  };

  const saveSkillReviewDraft = (input: SkillReviewActionInput) => {
    const dialog = reviewDialog();
    if (!dialog) return;
    setReviewDrafts((current) => ({
      ...current,
      [skillReviewDraftKey(dialog.targetScope, dialog.action)]: input.reason,
    }));
    setToast(translate("skills.review_draft_saved"));
    closeSkillReviewDialog();
  };

  const canSubmitRegistryPublishRequest = createMemo(() =>
    Boolean(props.vesloServerClient) &&
    props.vesloServerCanWriteSkills &&
    props.vesloServerSkillRegistryAvailable
  );

  const reviewRequestScope = (targetScope: SkillReviewTargetScope): "org" | "system" =>
    targetScope === "organization" ? "org" : "system";

  const registrySkillScopeForInstance = (instance: SkillInstance): "user" | "workspace" =>
    instance.scope === "workspace" ? "workspace" : "user";

  const requestSkillRegistryPublish = async (input: SkillReviewActionInput) => {
    const dialog = reviewDialog();
    const client = props.vesloServerClient;
    if (!dialog || publishRequestPending()) return;
    if (!client || !canSubmitRegistryPublishRequest()) {
      setToast(bulkPublishDisabledReason() ?? translate("skills.review_service_unavailable_body"));
      return;
    }
    if (!isPublishableInventoryInstance(dialog.instance)) {
      setToast(translate("skills.bulk_publish_not_publishable"));
      return;
    }

    const target = skillMutationTargetFromInstance(dialog.instance);
    setPublishRequestPending(true);
    try {
      const filesResult = await props.readSkillInstanceFiles(target);
      if (!filesResult || filesResult.files.length === 0) {
        throw new Error(translate("skills.publish_request_files_unavailable"));
      }
      const missingTextFile = filesResult.files.find((file) => file.text === undefined);
      if (missingTextFile) {
        throw new Error(translate("skills.publish_request_missing_file_content", { path: missingTextFile.path }));
      }
      const archive = await buildSkillPackageArchive({
        metadata: {
          name: dialog.item.name,
          description: dialog.instance.description ?? dialog.item.description,
          trigger: dialog.instance.trigger ?? dialog.item.trigger,
        },
        files: filesResult.files,
      });
      const auth = props.skillRegistryAuthContext;
      const skillResponse = await client.createRegistrySkill({
        ...auth,
        scope: registrySkillScopeForInstance(dialog.instance),
        name: dialog.item.name,
        displayName: dialog.item.name,
        description: dialog.instance.description ?? dialog.item.description,
        workspaceId: dialog.instance.scope === "workspace"
          ? dialog.instance.workspaceId?.trim() || props.activeWorkspaceId
          : undefined,
      });
      const skillId = skillResponse.skill.id;
      const versionResponse = await client.createRegistrySkillVersion(skillId, {
        ...auth,
        package: archive as unknown as Record<string, unknown>,
      });
      await client.createRegistrySkillReviewRequest(skillId, {
        ...auth,
        scope: reviewRequestScope(input.targetScope),
        versionId: versionResponse.version.id,
        orgId: input.targetScope === "organization" ? auth.denOrgId : undefined,
        reason: input.reason || undefined,
      });

      setToast(translate(input.targetScope === "organization"
        ? "skills.publish_request_org_success"
        : "skills.publish_request_system_success"));
      props.refreshSkillInventory({ force: true });
      closeSkillReviewDialog();
    } catch (e) {
      setToast(translate("skills.publish_request_failed", { error: maskError(e) }));
    } finally {
      setPublishRequestPending(false);
    }
  };

  const selectedReviewMetadataDiff = createMemo(() => {
    const detail = reviewDialog();
    if (!detail) return [];
    return [
      {
        field: translate("skills.review_field_name"),
        before: null,
        after: detail.item.name,
      },
      {
        field: translate("skills.review_field_description"),
        before: null,
        after: detail.instance.description ?? detail.item.description ?? null,
      },
      {
        field: translate("skills.review_field_trigger"),
        before: null,
        after: detail.instance.trigger ?? detail.item.trigger ?? null,
      },
    ];
  });

  const selectedReviewFileDiffs = createMemo(() => {
    const detail = reviewDialog();
    if (!detail) return [];
    const reviewFilePath = detail.instance.path
      ? `${detail.instance.path.replace(/\/$/, "")}/SKILL.md`
      : "SKILL.md";
    return [
      {
        path: reviewFilePath,
        kind: "unchanged" as const,
        executable: false,
      },
    ];
  });

  const requestDetailDelete = () => {
    const detail = selectedDetail();
    if (!detail) return;
    const target = removeTargetForInstance(detail.instance);
    if (!target) {
      setToast(uninstallDisabledReason({ item: detail.item, instance: detail.instance }));
      return;
    }
    setUninstallTarget(target);
  };

  const removeWarningForTarget = (target: SkillMutationTarget | null) => {
    const key = target?.scope === "user-global"
      ? "skills.uninstall_warning_user_global"
      : target?.scope === "organization" || target?.registry
        ? "skills.uninstall_warning_managed"
        : "skills.uninstall_warning_workspace";
    return translate(key).replace("{name}", target?.name ?? "");
  };

  const requestDetailRestore = (input?: SkillDetailActionInput) => {
    const detail = selectedDetail();
    if (!detail) return;
    const actionInstance = detailInstanceForAction(input);
    if (!actionInstance) return;
    const target = restoreTargetForInstance(actionInstance);
    if (!target) {
      setToast(restoreDisabledReason({ item: detail.item, instance: actionInstance }));
      return;
    }
    setRestoreTarget(target);
  };

  const availableHubSkills = createMemo(() =>
    props.hubSkills.filter((skill) => !installedNames().has(skill.name))
  );

  const filteredHubSkills = createMemo(() => {
    const query = searchQuery().trim().toLowerCase();
    const items = availableHubSkills();
    if (!query) return items;
    return items.filter((skill) => {
      const description = skill.description ?? "";
      const trigger = skill.trigger ?? "";
      return (
        skill.name.toLowerCase().includes(query) ||
        description.toLowerCase().includes(query) ||
        trigger.toLowerCase().includes(query)
      );
    });
  });

  const installTargetWorkspaces = createMemo<WorkspaceInfo[]>(() =>
    buildSkillInstallTargetWorkspaces({
      activeWorkspaceId: props.activeWorkspaceId,
      activeWorkspaceName: props.workspaceName,
      activeWorkspaceRoot: props.activeWorkspaceRoot,
      activeWorkspaceType: props.isRemoteWorkspace ? "remote" : "local",
      isPrivateWorkspacePath: props.isPrivateWorkspacePath,
      workspaces: props.workspaces,
    })
  );

  const selectedInstallWorkspace = createMemo(() => {
    const workspaceId = selectedInstallWorkspaceId()?.trim();
    if (!workspaceId) return null;
    return installTargetWorkspaces().find((workspace) => workspace.id === workspaceId) ?? null;
  });

  const installTargetCanSubmit = createMemo(() =>
    selectedInstallScope() === "workspace" &&
    selectedInstallWorkspaceId() === props.activeWorkspaceId
  );

  const installTargetDisabledReason = (workspace: WorkspaceInfo) => (
    workspace.id === props.activeWorkspaceId
      ? null
      : translate("skills.install_target_switch_workspace")
  );

  const openHubInstallTargetPicker = (skill: HubSkillCard) => {
    if (props.busy || installingHubSkill()) return;
    setSelectedInstallScope("workspace");
    setSelectedInstallWorkspaceId(props.activeWorkspaceId);
    setInstallTargetSkill(skill);
  };

  const closeHubInstallTargetPicker = () => {
    if (props.busy || installingHubSkill()) return;
    setInstallTargetSkill(null);
  };

  const installFromHub = async (skill: HubSkillCard, target: HubSkillInstallTarget) => {
    if (props.busy || installingHubSkill()) return;
    setInstallingHubSkill(skill.name);
    setToast(translate("skills.installing_named", { name: skill.name }));
    try {
      const result = await props.installHubSkill(skill.name, target);
      props.refreshSkillInventory({ force: true });
      setToast(result.message);
      if (result.ok) {
        setInstallTargetSkill(null);
      }
    } catch (e) {
      setToast(e instanceof Error ? e.message : translate("skills.install_failed"));
    } finally {
      setInstallingHubSkill(null);
    }
  };

  const confirmHubInstallTarget = () => {
    const skill = installTargetSkill();
    if (!skill) return;
    if (selectedInstallScope() === "global") {
      void installFromHub(skill, { scope: "global" });
      return;
    }
    const workspaceId = selectedInstallWorkspaceId();
    if (!workspaceId) {
      setToast(translate("skills.install_target_required"));
      return;
    }
    void installFromHub(skill, {
      scope: "workspace",
      workspaceId,
    });
  };

  const openInstallFromLink = () => {
    if (props.busy) return;
    setInstallLinkOpen(true);
    setInstallLinkUrl("");
    setInstallLinkBusy(false);
    setInstallLinkError(null);
    setInstallLinkBundle(null);
  };

  const closeInstallFromLink = () => {
    setInstallLinkOpen(false);
    setInstallLinkBusy(false);
    setInstallLinkError(null);
    setInstallLinkBundle(null);
  };

  const previewInstallLink = async () => {
    const raw = installLinkUrl().trim();
    if (!raw) {
      setInstallLinkError(translate("skills.preview_link_required"));
      return;
    }
    if (installLinkBusy()) return;

    setInstallLinkBusy(true);
    setInstallLinkError(null);
    setInstallLinkBundle(null);
    try {
      const url = new URL(raw);
      const controller = new AbortController();
      const timer = window.setTimeout(() => controller.abort(), 15_000);
      try {
        const response = await fetch(url.toString(), {
          method: "GET",
          headers: { Accept: "application/json" },
          signal: controller.signal,
        });
        if (!response.ok) {
          const text = (await response.text()).trim();
          const suffix = text ? `: ${text}` : "";
          throw new Error(`${translate("skills.bundle_fetch_failed", { status: String(response.status) })}${suffix}`);
        }
        const json = (await response.json()) as Record<string, unknown>;
        const schemaVersion = typeof json.schemaVersion === "number" ? json.schemaVersion : null;
        const type = typeof json.type === "string" ? json.type : "";
        const name = typeof json.name === "string" ? json.name.trim() : "";
        const content = typeof json.content === "string" ? json.content : "";
        if (schemaVersion !== 1 || type !== "skill") {
          throw new Error(translate("skills.bundle_invalid"));
        }
        if (!name) throw new Error(translate("skills.bundle_missing_name"));
        if (!content) throw new Error(translate("skills.bundle_missing_content"));
        setInstallLinkBundle({
          schemaVersion: 1,
          type: "skill",
          name,
          content,
          description: typeof json.description === "string" ? json.description : undefined,
          trigger: typeof json.trigger === "string" ? json.trigger : undefined,
        });
      } finally {
        window.clearTimeout(timer);
      }
    } catch (e) {
      setInstallLinkError(maskError(e));
    } finally {
      setInstallLinkBusy(false);
    }
  };

  const installFromPreview = async (mode: "overwrite" | "keep-both") => {
    const bundle = installLinkBundle();
    if (!bundle) return;
    if (props.busy || installLinkBusy()) return;
    setInstallLinkBusy(true);
    setInstallLinkError(null);

    try {
      const desiredName = bundle.name.trim();
      const taken = installedNames();
      const shouldRename = installLinkShouldRename(desiredName, mode);
      const finalName = shouldRename ? resolveUniqueSkillName(desiredName, taken) : desiredName;
      const content = shouldRename ? stripFrontmatter(bundle.content) : bundle.content;

      const result = await Promise.resolve(
        props.saveSkill({
          name: finalName,
          content,
          description: bundle.description,
        }),
      );
      if (!result.ok) {
        setInstallLinkError(result.message ?? translate("skills.failed_save_skill"));
        return;
      }
      props.refreshSkills({ force: true });
      props.refreshSkillInventory({ force: true });
      setToast(translate("skills.installed_named", { name: finalName }));
      closeInstallFromLink();
    } catch (e) {
      setInstallLinkError(maskError(e));
    } finally {
      setInstallLinkBusy(false);
    }
  };

  const openSkill = async (skill: ActionSkillCard) => {
    if (props.busy) return;
    setSelectedSkill(skill);
    setSelectedContent("");
    setSelectedDirty(false);
    setSelectedError(null);
    setSelectedLoading(true);
    try {
      const result = await props.readSkillInstance(skill.mutationTarget);
      if (!result) {
        setSelectedError(translate("skills.failed_load_skill"));
        return;
      }
      setSelectedContent(result.content);
    } catch (e) {
      setSelectedError(e instanceof Error ? e.message : translate("skills.failed_load_skill"));
    } finally {
      setSelectedLoading(false);
    }
  };

  const closeSkill = () => {
    setSelectedSkill(null);
    setSelectedContent("");
    setSelectedDirty(false);
    setSelectedError(null);
    setSelectedLoading(false);
  };

  const saveSelectedSkill = async () => {
    const skill = selectedSkill();
    if (!skill) return;
    if (!selectedDirty()) return;
    setSelectedError(null);
    try {
      const result = await Promise.resolve(
        props.saveSkillInstance(skill.mutationTarget, selectedContent()),
      );
      if (!result.ok) {
        setSelectedError(result.message ?? translate("skills.failed_save_skill"));
        return;
      }
      props.refreshSkillInventory({ force: true });
      setSelectedDirty(false);
    } catch (e) {
      setSelectedError(e instanceof Error ? e.message : translate("skills.failed_save_skill"));
    }
  };

  const confirmRemoveSkillInstance = async () => {
    const target = uninstallTarget();
    if (!target || removePending()) return;
    setUninstallTarget(null);
    setRemovePending(true);
    try {
      const result = await props.removeSkillInstance(target);
      setToast(result.message ?? translate(result.ok ? "skills.uninstalled" : "skills.uninstall_failed"));
    } catch (e) {
      setToast(e instanceof Error ? e.message : translate("skills.uninstall_failed"));
    } finally {
      props.refreshSkillInventory({ force: true });
      setRemovePending(false);
    }
  };

  const confirmBulkRemoveSkillInstances = async () => {
    const targets = bulkRemoveTargets();
    if (targets.length === 0 || removePending()) return;
    setBulkRemoveTargets([]);
    setRemovePending(true);
    try {
      const result = await props.batchRemoveSkillInstances(targets);
      setToast(result.message ?? translate(result.ok ? "skills.bulk_removed" : "skills.bulk_remove_partial"));
      if (result.ok) setSelectedInventoryIds([]);
    } catch (e) {
      setToast(e instanceof Error ? e.message : translate("skills.bulk_remove_partial"));
    } finally {
      props.refreshSkillInventory({ force: true });
      setRemovePending(false);
    }
  };

  const confirmRestoreSkillInstance = async () => {
    const target = restoreTarget();
    if (!target || restorePending()) return;
    setRestoreTarget(null);
    setRestorePending(true);
    try {
      const result = await props.restoreSkillInstance(target);
      setToast(result.message ?? translate(result.ok ? "skills.restored" : "skills.restore_location_unavailable"));
    } catch (e) {
      setToast(e instanceof Error ? e.message : translate("skills.restore_location_unavailable"));
    } finally {
      props.refreshSkillInventory({ force: true });
      setRestorePending(false);
    }
  };

  const renderInventoryCard = (input: {
    item: SkillInventoryItem;
    instance: SkillInstance;
    workspaceLabel?: string;
  }) => {
    const displayDescription = () => input.instance.description ?? input.item.description ?? "";
    const lifecycle = () => inventoryInstanceLifecycle(input.instance);
    const canRemove = () => canRemoveInventoryInstance({ item: input.item, instance: input.instance });
    const canRestore = () => canRestoreInventoryInstance({ item: input.item, instance: input.instance });
    const showRestoreAction = () => lifecycle() === "removed" && instanceHasRestoreMetadata(input.instance);
    const removeTitle = () =>
      uninstallDisabledReason({ item: input.item, instance: input.instance }) ?? translate("skills.uninstall");
    const restoreTitle = () =>
      restoreDisabledReason({ item: input.item, instance: input.instance }) ?? translate("skills.restore_skill");
    const selectionId = () => skillInventoryInstanceId(input.instance);
    const selected = () => selectedInventoryIdSet().has(selectionId());
    const toggleCurrentSelection = () => toggleInventorySelection(selectionId(), !selected());
    const openDetails = () => openSkillDetail(input.item, input.instance);

    return (
      <div
        data-testid="skill-inventory-card"
        data-skill-inventory-name={input.item.name}
        data-skill-inventory-scope={input.instance.scope}
        data-skill-inventory-workspace-id={input.instance.workspaceId ?? ""}
        data-skill-inventory-lifecycle={inventoryInstanceLifecycle(input.instance)}
        role="button"
        tabindex="0"
        class="bg-dls-surface border border-dls-border rounded-xl p-4 flex items-start justify-between group transition-all text-left hover:border-dls-border hover:bg-dls-hover cursor-pointer"
        onClick={toggleCurrentSelection}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            if (e.isComposing || e.keyCode === 229) return;
            e.preventDefault();
            toggleCurrentSelection();
          }
        }}
      >
        <div class="flex gap-4 min-w-0">
          <input
            type="checkbox"
            class="mt-2 h-4 w-4 shrink-0 rounded border-dls-border"
            checked={selected()}
            aria-label={translate("skills.select_skill_location")}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => toggleInventorySelection(selectionId(), e.currentTarget.checked)}
          />
          <div class="w-10 h-10 rounded-lg flex items-center justify-center shadow-sm border border-dls-border bg-dls-surface">
            <Package size={20} class="text-dls-secondary" />
          </div>
          <div class="min-w-0">
            <div class="flex items-center gap-2 mb-0.5">
              <h4
                class="font-product type-ui-md font-semibold text-dls-text truncate"
                title={input.item.name}
              >
                {input.item.name}
              </h4>
              <Show when={lifecycle() === "removed"}>
                <span class="shrink-0 rounded-full border border-amber-7/40 bg-amber-3/20 px-2 py-0.5 type-ui-xs text-amber-11">
                  {translate("skills.removed_status")}
                </span>
              </Show>
              <Show when={input.instance.enabled === false && lifecycle() === "active"}>
                <span class="shrink-0 rounded-full border border-dls-border bg-dls-hover px-2 py-0.5 type-ui-xs text-dls-secondary">
                  {translate("skills.disabled_status")}
                </span>
              </Show>
              <button
                type="button"
                class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-dls-border bg-dls-hover text-dls-secondary transition-colors hover:bg-dls-active hover:text-dls-text disabled:opacity-40"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void openInventoryInstanceLocation(input.instance.path);
                }}
                disabled={!canRevealInventoryInstanceLocation(input.instance)}
                title={translate("skills.reveal_skill_location")}
                aria-label={translate("skills.reveal_skill_location")}
              >
                <FolderOpen size={13} />
              </button>
            </div>
            <Show when={displayDescription()}>
              <p class="font-reading type-ui-sm text-dls-secondary line-clamp-1">
                {displayDescription()}
              </p>
            </Show>
            <Show when={input.workspaceLabel}>
              <div class="font-product type-ui-xs mt-1 text-dls-secondary truncate">{input.workspaceLabel}</div>
            </Show>
          </div>
        </div>
        <div class="flex items-center gap-1">
          {renderSkillEnabledSwitch({ item: input.item, instance: input.instance })}
          <button
            type="button"
            data-testid="skill-inventory-detail-button"
            class="p-1.5 rounded-md text-dls-secondary transition-colors hover:bg-dls-active hover:text-dls-text"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              openDetails();
            }}
            title={translate("common.edit")}
            aria-label={translate("common.edit")}
          >
            <Edit2 size={14} />
          </button>
          <Show
            when={lifecycle() === "removed"}
            fallback={
              <button
                type="button"
                data-testid="skill-inventory-deactivate-button"
                class={`p-1.5 rounded-md transition-colors ${
                  skillMutationBusy() || !canRemove()
                    ? "text-dls-secondary opacity-40"
                    : "text-dls-secondary hover:text-red-11 hover:bg-red-3/10"
                }`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const target = removeTargetForInstance(input.instance);
                  if (!target || skillMutationBusy()) return;
                  setUninstallTarget(target);
                }}
                disabled={skillMutationBusy() || !canRemove()}
                title={removeTitle()}
                aria-label={removeTitle()}
              >
                <Trash2 size={14} />
              </button>
            }
          >
            <Show when={showRestoreAction()}>
              <button
                type="button"
                data-testid="skill-inventory-restore-button"
                class={`p-1.5 rounded-md transition-colors ${
                  skillMutationBusy() || !canRestore()
                    ? "text-dls-secondary opacity-40"
                    : "text-dls-secondary hover:text-green-11 hover:bg-green-3/10"
                }`}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  const target = restoreTargetForInstance(input.instance);
                  if (!target || skillMutationBusy()) return;
                  setRestoreTarget(target);
                }}
                disabled={skillMutationBusy() || !canRestore()}
                title={restoreTitle()}
                aria-label={restoreTitle()}
              >
                <RotateCcw size={14} />
              </button>
            </Show>
          </Show>
        </div>
      </div>
    );
  };

  return (
    <section data-testid="skills-page" class="space-y-8">
      <Show when={toast()}>
        <div class="fixed bottom-6 right-6 z-50 max-w-sm rounded-xl border border-dls-border bg-dls-surface px-4 py-3 text-xs text-dls-text shadow-2xl">
          {toast()}
        </div>
      </Show>

      <div class="space-y-1">
        <h2 class="font-product type-title-md text-dls-text">{translate("dashboard.skills")}</h2>
      </div>

      <div class="flex flex-wrap items-center gap-3 border-b border-dls-border pb-4">
        <button
          type="button"
          data-testid="skills-refresh-button"
          onClick={() => {
            props.refreshSkillInventory({ force: true });
            props.refreshSkills({ force: true });
          }}
          disabled={props.busy}
          class={`font-product type-ui-xs flex items-center gap-1.5 font-medium transition-colors ${
            props.busy
              ? "text-dls-secondary"
              : "text-dls-secondary hover:text-dls-text"
          }`}
        >
          <RefreshCw size={14} />
          {translate("skills.refresh")}
        </button>
        <div class="relative">
          <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-dls-secondary" />
          <input
            type="text"
            value={searchQuery()}
            onInput={(event) => setSearchQuery(event.currentTarget.value)}
            placeholder={translate("skills.search_placeholder_full")}
            class="font-reading type-ui-sm bg-dls-hover border border-dls-border rounded-lg py-1.5 pl-9 pr-4 w-56 focus:w-72 focus:outline-none transition-all"
          />
        </div>
        <select
          value={inventoryScopeFilter()}
          aria-label={translate("skills.filter_scope")}
          class="font-product type-ui-xs rounded-lg border border-dls-border bg-dls-surface px-2 py-1.5 text-dls-text"
          onChange={(event) => setInventoryScopeFilter(event.currentTarget.value as InventoryScopeFilter)}
        >
          <option value="all">{translate("skills.filter_scope_all")}</option>
          <option value="user-global">{translate("skills.filter_scope_global")}</option>
          <option value="workspace">{translate("skills.filter_scope_workspace")}</option>
          <option value="organization">{translate("skills.detail_scope_organization")}</option>
          <option value="platform">{translate("skills.detail_scope_platform")}</option>
        </select>
        <select
          value={inventoryWorkspaceFilter()}
          aria-label={translate("skills.filter_workspace")}
          class="font-product type-ui-xs rounded-lg border border-dls-border bg-dls-surface px-2 py-1.5 text-dls-text"
          onChange={(event) => setInventoryWorkspaceFilter(event.currentTarget.value)}
        >
          <option value="all">{translate("skills.filter_workspace_all")}</option>
          <For each={props.workspaces.filter((workspace) => workspace.workspaceType === "local")}>
            {(workspace) => <option value={workspace.id}>{workspaceLabelForTarget(workspace)}</option>}
          </For>
        </select>
        <label class="font-product type-ui-xs flex items-center gap-1.5 text-dls-secondary">
          <input
            type="checkbox"
            data-testid="skills-filter-deleted-checkbox"
            checked={inventoryIncludeDeleted()}
            onChange={(event) => setInventoryIncludeDeleted(event.currentTarget.checked)}
          />
          {translate("skills.restore_skills")}
        </label>
        <div class="flex rounded-lg border border-dls-border bg-dls-surface p-0.5">
          <button
            type="button"
            class={`inline-flex h-7 items-center gap-1 rounded-md px-2 type-ui-xs ${
              inventoryViewMode() === "cards" ? "bg-dls-active text-dls-text" : "text-dls-secondary hover:text-dls-text"
            }`}
            aria-pressed={inventoryViewMode() === "cards"}
            onClick={() => setInventoryViewMode("cards")}
          >
            <LayoutGrid size={13} />
            {translate("skills.view_cards")}
          </button>
          <button
            type="button"
            class={`inline-flex h-7 items-center gap-1 rounded-md px-2 type-ui-xs ${
              inventoryViewMode() === "table" ? "bg-dls-active text-dls-text" : "text-dls-secondary hover:text-dls-text"
            }`}
            aria-pressed={inventoryViewMode() === "table"}
            onClick={() => setInventoryViewMode("table")}
          >
            <Table2 size={13} />
            {translate("skills.view_table")}
          </button>
        </div>
        <button
          type="button"
          onClick={openInstallFromLink}
          disabled={props.busy}
          class={`font-product type-ui-xs flex items-center gap-1.5 px-3 py-1.5 font-medium rounded-lg transition-colors border ${
            props.busy
              ? "border-dls-border bg-dls-hover text-dls-secondary"
              : "border-dls-border bg-dls-surface text-dls-text hover:bg-dls-active"
          }`}
          title={translate("skills.install_from_link")}
        >
          <Link2 size={14} />
          {translate("skills.install_from_link")}
        </button>
        <button
          type="button"
          data-testid="skills-import-open"
          onClick={openSkillImport}
          disabled={props.busy}
          class={`font-product type-ui-xs flex items-center gap-1.5 px-3 py-1.5 font-medium rounded-lg transition-colors border ${
            props.busy
              ? "border-dls-border bg-dls-hover text-dls-secondary"
              : "border-dls-border bg-dls-surface text-dls-text hover:bg-dls-active"
          }`}
          title={translate("skills.import_from_agents")}
        >
          <Upload size={14} />
          {translate("skills.import_from_agents")}
        </button>
      </div>

      <Show when={props.accessHint}>
        <div class="font-product type-ui-xs text-dls-secondary">{props.accessHint}</div>
      </Show>
      <Show
        when={!props.accessHint && !props.canInstallSkillCreator && !props.canUseDesktopTools}
      >
        <div class="font-product type-ui-xs text-dls-secondary">{translate("skills.host_mode_only")}</div>
      </Show>

      <Show when={props.skillInventoryStatus}>
        <div class="rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary whitespace-pre-wrap break-words">
          {props.skillInventoryStatus}
        </div>
      </Show>

      <Show when={props.skillsStatus}>
        <div class="rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary whitespace-pre-wrap break-words">
          {props.skillsStatus}
        </div>
      </Show>

      <div data-testid="skills-installed-section" class="space-y-4">
        <div class="flex flex-wrap items-center justify-between gap-3">
          <h3 class="font-product type-title-md font-semibold text-dls-text">
            {translate("skills.installed")}
          </h3>
          <Show when={currentInventorySelectionIds().length}>
            <label class="font-product type-ui-xs flex items-center gap-2 text-dls-secondary">
              <input
                type="checkbox"
                checked={allCurrentInventorySelected()}
                onChange={(event) => toggleAllCurrentInventorySelection(event.currentTarget.checked)}
              />
              {translate("skills.select_all_filtered")}
            </label>
          </Show>
        </div>
        <Show when={selectedInventoryCount() > 0}>
          <div
            data-testid="skills-bulk-toolbar"
            class="flex flex-wrap items-center gap-2 rounded-lg border border-dls-border bg-dls-hover px-3 py-2"
          >
            <span class="font-product type-ui-xs text-dls-secondary">
              {translate("skills.selected_count", { count: String(selectedInventoryCount()) })}
            </span>
            <Show when={selectedInventoryShowsWorkspaceInstallAction()}>
              <Button
                variant="outline"
                class="h-8 px-2 type-ui-xs"
                data-testid="skills-bulk-install-workspace-button"
                title={workspaceInstallDisabledReason() ?? translate("skills.detail_copy_to_workspace")}
                disabled={props.busy || Boolean(workspaceInstallDisabledReason())}
                onClick={openSelectedWorkspaceInstallTargetPicker}
              >
                <Copy size={13} />
                {translate("skills.detail_copy_to_workspace")}
              </Button>
            </Show>
            <Show when={selectedInventoryShowsGlobalTransferActions()}>
              <Button
                variant="outline"
                class="h-8 px-2 type-ui-xs"
                data-testid="skills-bulk-copy-to-user-button"
                title={globalTransferDisabledReason() ?? translate("skills.copy_to_global")}
                disabled={props.busy || Boolean(globalTransferDisabledReason())}
                onClick={() => void transferSelectedSkillsToGlobal(true)}
              >
                <Copy size={13} />
                {translate("skills.copy_to_global")}
              </Button>
              <Button
                variant="outline"
                class="h-8 px-2 type-ui-xs"
                data-testid="skills-bulk-move-to-user-button"
                title={globalTransferDisabledReason() ?? translate("skills.move_to_global")}
                disabled={props.busy || Boolean(globalTransferDisabledReason())}
                onClick={() => void transferSelectedSkillsToGlobal(true)}
              >
                <ArrowRightToLine size={13} />
                {translate("skills.move_to_global")}
              </Button>
            </Show>
            <Button
              variant="outline"
              class="h-8 px-2 type-ui-xs"
              data-testid="skills-bulk-publish-button"
              title={bulkPublishDisabledReason() ?? translate("skills.bulk_publish")}
              disabled={Boolean(bulkPublishDisabledReason())}
              onClick={openSelectedBulkPublish}
            >
              <Upload size={13} />
              {translate("skills.bulk_publish")}
            </Button>
            <Button
              variant="danger"
              class="h-8 px-2 type-ui-xs"
              data-testid="skills-bulk-remove-button"
              title={bulkRemoveDisabledReason() ?? translate("skills.bulk_remove")}
              disabled={skillMutationBusy() || Boolean(bulkRemoveDisabledReason())}
              onClick={openSelectedBulkRemove}
            >
              <Trash2 size={13} />
              {translate("skills.bulk_remove")}
            </Button>
            <button
              type="button"
              class="font-product type-ui-xs text-dls-secondary hover:text-dls-text"
              onClick={() => setSelectedInventoryIds([])}
            >
              {translate("skills.clear_selection")}
            </button>
          </div>
        </Show>
        <Show
          when={filteredInstalledInventoryItems().length}
          fallback={
            <div class="font-reading type-ui-md rounded-xl border border-dls-border bg-dls-surface px-5 py-6 text-dls-secondary">
              {translate("skills.no_skills")}
            </div>
          }
        >
          <Show
            when={inventoryViewMode() === "table"}
            fallback={
              <div class="space-y-6">
                <Show when={allWorkspaceInventoryItems().length}>
                  <div data-testid="skills-all-workspaces-section" class="space-y-3">
                    <h4 class="font-product type-ui-xs font-bold text-dls-secondary uppercase tracking-widest">
                      {translate("skills.all_workspaces")}
                    </h4>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <For each={allWorkspaceInventoryItems()}>
                        {(item) => {
                          const instance = item.globalInstance!;
                          return renderInventoryCard({
                            item,
                            instance,
                          });
                        }}
                      </For>
                    </div>
                  </div>
                </Show>

                <Show when={workspaceInventoryRows().length}>
                  <div data-testid="skills-workspace-specific-section" class="space-y-3">
                    <h4 class="font-product type-ui-xs font-bold text-dls-secondary uppercase tracking-widest">
                      {translate("skills.workspace_specific")}
                    </h4>
                    <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
                      <For each={workspaceInventoryRows()}>
                        {(row) => renderInventoryCard({
                          item: row.item,
                          instance: row.instance,
                          workspaceLabel: workspaceLabelForInstance(row.instance),
                        })}
                      </For>
                    </div>
                  </div>
                </Show>
              </div>
            }
          >
            <div data-testid="skills-inventory-table" class="overflow-x-auto rounded-lg border border-dls-border bg-dls-surface">
              <table class="w-full min-w-[720px] border-collapse">
                <thead class="border-b border-dls-border bg-dls-hover text-left">
                  <tr class="font-product type-ui-xs uppercase text-dls-secondary">
                    <th class="w-10 px-3 py-2">
                      <span class="sr-only">{translate("skills.select_skill_location")}</span>
                    </th>
                    <th class="px-3 py-2">{translate("skills.skill_label")}</th>
                    <th class="px-3 py-2">{translate("skills.filter_scope")}</th>
                    <th class="px-3 py-2">{translate("skills.filter_workspace")}</th>
                    <th class="px-3 py-2">{translate("skills.source")}</th>
                    <th class="px-3 py-2 text-right">{translate("skills.actions")}</th>
                  </tr>
                </thead>
                <tbody>
                  <For each={inventoryTableRows()}>
                    {(row) => {
                      const selectionId = () => skillInventoryInstanceId(row.instance);
                      const lifecycle = () => inventoryInstanceLifecycle(row.instance);
                      const canRemove = () => canRemoveInventoryInstance({ item: row.item, instance: row.instance });
                      const canRestore = () => canRestoreInventoryInstance({ item: row.item, instance: row.instance });
                      const showRestoreAction = () => lifecycle() === "removed" && instanceHasRestoreMetadata(row.instance);
                      const removeTitle = () =>
                        uninstallDisabledReason({ item: row.item, instance: row.instance }) ?? translate("skills.uninstall");
                      const restoreTitle = () =>
                        restoreDisabledReason({ item: row.item, instance: row.instance }) ?? translate("skills.restore_skill");
                      const scopeLabel = () => scopeLabelForInstance(row.instance);
                      return (
                        <tr
                          class="border-b border-dls-border last:border-0 hover:bg-dls-hover"
                          data-testid="skill-inventory-table-row"
                          data-skill-inventory-name={row.item.name}
                          data-skill-inventory-scope={row.instance.scope}
                          data-skill-inventory-workspace-id={row.instance.workspaceId ?? ""}
                          data-skill-inventory-lifecycle={inventoryInstanceLifecycle(row.instance)}
                          onClick={() => toggleTableRowSelection(row.instance)}
                        >
                          <td class="px-3 py-2">
                            <input
                              type="checkbox"
                              checked={selectedInventoryIdSet().has(selectionId())}
                              aria-label={translate("skills.select_skill_location")}
                              onClick={(event) => event.stopPropagation()}
                              onChange={(event) => toggleInventorySelection(selectionId(), event.currentTarget.checked)}
                            />
                          </td>
                          <td class="max-w-[220px] px-3 py-2">
                            <div class="flex min-w-0 items-center gap-2">
                              <div class="truncate font-product type-ui-sm font-semibold text-dls-text">{row.item.name}</div>
                              <Show when={lifecycle() === "removed"}>
                                <span class="shrink-0 rounded-full border border-amber-7/40 bg-amber-3/20 px-2 py-0.5 type-ui-xs text-amber-11">
                                  {translate("skills.removed_status")}
                                </span>
                              </Show>
                              <Show when={row.instance.enabled === false && lifecycle() === "active"}>
                                <span class="shrink-0 rounded-full border border-dls-border bg-dls-hover px-2 py-0.5 type-ui-xs text-dls-secondary">
                                  {translate("skills.disabled_status")}
                                </span>
                              </Show>
                            </div>
                            <Show when={row.instance.description ?? row.item.description}>
                              {(description) => <div class="truncate type-ui-xs text-dls-secondary">{description()}</div>}
                            </Show>
                          </td>
                          <td class="px-3 py-2 type-ui-sm text-dls-secondary">
                            {scopeLabel()}
                          </td>
                          <td class="max-w-[220px] px-3 py-2 type-ui-sm text-dls-secondary">
                            <span class="block truncate">{row.workspaceLabel}</span>
                          </td>
                          <td class="px-3 py-2 type-ui-sm text-dls-secondary">{row.instance.source}</td>
                          <td class="px-3 py-2">
                            <div class="flex justify-end gap-1">
                              {renderSkillEnabledSwitch({ item: row.item, instance: row.instance })}
                              <button
                                type="button"
                                data-testid="skill-inventory-detail-button"
                                class="rounded-md p-1.5 text-dls-secondary hover:bg-dls-active hover:text-dls-text disabled:opacity-40"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  openSkillDetail(row.item, row.instance);
                                }}
                                aria-label={translate("common.edit")}
                                title={translate("common.edit")}
                              >
                                <Edit2 size={14} />
                              </button>
                              <button
                                type="button"
                                class="rounded-md p-1.5 text-dls-secondary hover:bg-dls-active hover:text-dls-text disabled:opacity-40"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  if (!canRevealInventoryInstanceLocation(row.instance)) return;
                                  void openInventoryInstanceLocation(row.instance.path);
                                }}
                                disabled={!canRevealInventoryInstanceLocation(row.instance)}
                                aria-label={translate("skills.reveal_skill_location")}
                                title={translate("skills.reveal_skill_location")}
                              >
                                <FolderOpen size={14} />
                              </button>
                              <Show
                                when={lifecycle() === "removed"}
                                fallback={
                                  <button
                                    type="button"
                                    data-testid="skill-inventory-deactivate-button"
                                    class={`rounded-md p-1.5 ${
                                      skillMutationBusy() || !canRemove()
                                        ? "text-dls-secondary opacity-40"
                                        : "text-dls-secondary hover:bg-red-3/10 hover:text-red-11"
                                    }`}
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      const target = removeTargetForInstance(row.instance);
                                      if (!target || skillMutationBusy()) return;
                                      setUninstallTarget(target);
                                    }}
                                    disabled={skillMutationBusy() || !canRemove()}
                                    aria-label={removeTitle()}
                                    title={removeTitle()}
                                  >
                                    <Trash2 size={14} />
                                  </button>
                                }
                              >
                                <Show when={showRestoreAction()}>
                                  <button
                                    type="button"
                                    data-testid="skill-inventory-restore-button"
                                    class={`rounded-md p-1.5 ${
                                      skillMutationBusy() || !canRestore()
                                        ? "text-dls-secondary opacity-40"
                                        : "text-dls-secondary hover:bg-green-3/10 hover:text-green-11"
                                    }`}
                                    onClick={(event) => {
                                      event.preventDefault();
                                      event.stopPropagation();
                                      const target = restoreTargetForInstance(row.instance);
                                      if (!target || skillMutationBusy()) return;
                                      setRestoreTarget(target);
                                    }}
                                    disabled={skillMutationBusy() || !canRestore()}
                                    aria-label={restoreTitle()}
                                    title={restoreTitle()}
                                  >
                                    <RotateCcw size={14} />
                                  </button>
                                </Show>
                              </Show>
                            </div>
                          </td>
                        </tr>
                      );
                    }}
                  </For>
                </tbody>
              </table>
            </div>
          </Show>
        </Show>
      </div>

      <div data-testid="skills-hub-section" class="space-y-4">
        <div class="flex items-center justify-between gap-3">
          <h3 class="text-[11px] font-bold text-dls-secondary uppercase tracking-widest">{translate("skills.install_skills")}</h3>
          <button
            type="button"
            onClick={() => props.refreshHubSkills({ force: true })}
            disabled={props.busy}
            class={`flex items-center gap-1.5 text-xs font-medium transition-colors ${
              props.busy
                ? "text-dls-secondary"
                : "text-dls-secondary hover:text-dls-text"
            }`}
            title={translate("skills.refresh_hub_catalog")}
          >
            <RefreshCw size={14} />
            {translate("skills.refresh_hub")}
          </button>
        </div>

        <Show when={props.hubSkillsStatus}>
          <div class="rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary whitespace-pre-wrap break-words">
            {props.hubSkillsStatus}
          </div>
        </Show>

        <Show
          when={filteredHubSkills().length}
          fallback={
            <Show when={!props.hubSkillsStatus}>
              <div data-testid="skills-hub-placeholder" class="rounded-xl border border-dls-border bg-dls-surface px-5 py-6 text-sm text-dls-secondary">
                {translate("skills.org_catalog_placeholder")}
              </div>
            </Show>
          }
        >
          <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
            <For each={filteredHubSkills()}>
              {(skill) => (
                <div class="bg-dls-surface border border-dls-border rounded-xl p-4 flex items-start justify-between gap-4 group hover:border-dls-border hover:bg-dls-hover transition-all text-left">
                  <div class="flex gap-4 min-w-0">
                    <div class="w-10 h-10 rounded-lg flex items-center justify-center shadow-sm border border-dls-border bg-dls-surface">
                      <Package size={20} class="text-dls-secondary" />
                    </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2 mb-0.5">
                        <h4 class="text-sm font-semibold text-dls-text truncate">{skill.name}</h4>
                      </div>
                      <Show when={skill.description} fallback={<p class="text-xs text-dls-secondary">{translate("skills.from_hub")}</p>}>
                        <p class="text-xs text-dls-secondary line-clamp-2">{skill.description}</p>
                      </Show>
                      <div class="mt-2 flex flex-wrap items-center gap-2 text-[11px] text-dls-secondary">
                        <span class="rounded-md border border-dls-border bg-dls-hover px-2 py-1 font-mono">
                          {skill.source.owner}/{skill.source.repo}
                        </span>
                        <Show when={skill.trigger}>
                          <span
                            class="inline-block max-w-full rounded-md border border-dls-border bg-dls-hover px-2 py-1 truncate"
                            title={translate("skills.trigger_title", { trigger: skill.trigger ?? "" }) || ""}
                          >
                            {translate("skills.trigger_label")} {skill.trigger}
                          </span>
                        </Show>
                      </div>
                    </div>
                  </div>
                  <button
                    type="button"
                    class={`inline-flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-xs font-medium transition-colors ${
                      props.busy || installingHubSkill() === skill.name
                        ? "border-dls-border bg-dls-hover text-dls-secondary"
                        : "border-dls-border bg-dls-surface text-dls-text hover:bg-dls-active"
                    }`}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      openHubInstallTargetPicker(skill);
                    }}
                    disabled={props.busy || installingHubSkill() === skill.name}
                    title={translate("skills.install_named", { name: skill.name })}
                  >
                    <Show
                      when={installingHubSkill() === skill.name}
                      fallback={<Plus size={14} />}
                    >
                      <Loader2 size={14} class="animate-spin" />
                    </Show>
                    {installingHubSkill() === skill.name ? translate("skills.installing_hub") : translate("skills.add_hub")}
                  </button>
                </div>
              )}
            </For>
          </div>
        </Show>
      </div>

      <ModalShell
        open={skillImportOpen()}
        onClose={closeSkillImport}
        layer="elevated"
        backdrop="medium"
        size="lg"
        class="max-h-[calc(100vh-2rem)] bg-dls-surface"
      >
        <div data-testid="skills-import-modal" class="flex max-h-[calc(100vh-2rem)] min-h-0 flex-col">
          <header class="shrink-0 border-b border-dls-border px-6 py-5">
            <div class="flex items-start justify-between gap-4">
              <div class="min-w-0">
                <h3 class="font-product type-title-md font-semibold text-dls-text">
                  {translate("skills.import_from_agents")}
                </h3>
                <p class="font-reading type-ui-sm mt-1 text-dls-secondary">
                  {translate("skills.import_from_agents_desc")}
                </p>
              </div>
              <button
                type="button"
                class="rounded-lg border border-dls-border bg-gray-2 p-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-50"
                aria-label={translate("common.close")}
                onClick={closeSkillImport}
                disabled={skillImportBusy()}
              >
                <X size={18} />
              </button>
            </div>
          </header>

          <div class="shrink-0 border-b border-dls-border px-6 py-4">
            <div class="flex flex-wrap items-center gap-3">
              <div class="relative">
                <Search size={14} class="absolute left-3 top-1/2 -translate-y-1/2 text-dls-secondary" />
                <input
                  type="text"
                  value={skillImportSearch()}
                  onInput={(event) => setSkillImportSearch(event.currentTarget.value)}
                  placeholder={translate("skills.import_search_placeholder")}
                  class="font-reading type-ui-sm w-64 rounded-lg border border-dls-border bg-dls-hover py-1.5 pl-9 pr-4 focus:outline-none"
                />
              </div>
              <select
                value={skillImportSourceFilter()}
                aria-label={translate("skills.import_source_filter")}
                class="font-product type-ui-xs rounded-lg border border-dls-border bg-dls-surface px-2 py-1.5 text-dls-text"
                onChange={(event) => setSkillImportSourceFilter(event.currentTarget.value as SkillImportSourceFilter)}
              >
                <For each={skillImportSourceOptions}>
                  {(source) => <option value={source}>{importSourceLabel(source)}</option>}
                </For>
              </select>
              <select
                value={skillImportStatusFilter()}
                aria-label={translate("skills.import_status_filter")}
                class="font-product type-ui-xs rounded-lg border border-dls-border bg-dls-surface px-2 py-1.5 text-dls-text"
                onChange={(event) => setSkillImportStatusFilter(event.currentTarget.value as SkillImportStatusFilter)}
              >
                <For each={skillImportStatusOptions}>
                  {(status) => <option value={status}>{importStatusLabel(status)}</option>}
                </For>
              </select>
              <button
                type="button"
                class="font-product type-ui-xs inline-flex items-center gap-1.5 rounded-lg border border-dls-border bg-dls-surface px-2.5 py-1.5 text-dls-secondary transition-colors hover:bg-dls-active hover:text-dls-text"
                onClick={() => props.refreshSkillImportCandidates({ force: true })}
                disabled={skillImportBusy()}
              >
                <RefreshCw size={13} />
                {translate("skills.refresh")}
              </button>
            </div>
          </div>

          <div class="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            <Show when={props.skillImportStatus}>
              <div class="mb-3 rounded-lg border border-dls-border bg-dls-hover px-3 py-2 type-ui-xs text-dls-secondary">
                {props.skillImportStatus}
              </div>
            </Show>
            <Show
              when={filteredSkillImportCandidates().length}
              fallback={
                <div class="rounded-lg border border-dls-border bg-dls-hover px-4 py-5 type-ui-sm text-dls-secondary">
                  {translate("skills.import_no_candidates")}
                </div>
              }
            >
              <div class="space-y-2">
                <For each={filteredSkillImportCandidates()}>
                  {(candidate) => {
                    const importable = () => canImportCandidate(candidate);
                    const selected = () => selectedSkillImportIdSet().has(candidate.id);
                    return (
                      <label
                        class={`flex items-start gap-3 rounded-lg border px-4 py-3 ${
                          importable()
                            ? "border-dls-border bg-dls-surface hover:bg-dls-hover"
                            : "border-dls-border bg-dls-hover opacity-75"
                        }`}
                        data-testid="skills-import-candidate"
                        data-skill-import-source={candidate.sourceAgent}
                        data-skill-import-status={candidate.status}
                      >
                        <input
                          type="checkbox"
                          class="mt-1"
                          checked={selected()}
                          disabled={!importable() || skillImportBusy()}
                          onChange={(event) => toggleSkillImportSelection(candidate, event.currentTarget.checked)}
                        />
                        <div class="min-w-0 flex-1">
                          <div class="flex flex-wrap items-center gap-2">
                            <span class="font-product type-ui-md font-semibold text-dls-text">{candidate.name}</span>
                            <span class="rounded-full border border-dls-border bg-dls-hover px-2 py-0.5 type-ui-xs text-dls-secondary">
                              {importSourceLabel(candidate.sourceAgent)}
                            </span>
                            <span class="rounded-full border border-dls-border bg-dls-hover px-2 py-0.5 type-ui-xs text-dls-secondary">
                              {importStatusLabel(candidate.status)}
                            </span>
                          </div>
                          <Show when={candidate.description}>
                            <p class="mt-1 font-reading type-ui-sm text-dls-secondary">{candidate.description}</p>
                          </Show>
                          <div class="mt-2 flex flex-wrap gap-2 type-ui-xs text-dls-secondary">
                            <span>{targetLabelForImportCandidate(candidate)}</span>
                            <span class="truncate">{candidate.sourcePath}</span>
                          </div>
                          <Show when={candidate.conflict?.message ?? candidate.warnings[0]}>
                            {(message) => (
                              <div class="mt-2 rounded-md border border-amber-7/40 bg-amber-3/20 px-2 py-1 type-ui-xs text-amber-11">
                                {message()}
                              </div>
                            )}
                          </Show>
                        </div>
                      </label>
                    );
                  }}
                </For>
              </div>
            </Show>
          </div>

          <footer class="shrink-0 border-t border-dls-border px-6 py-4">
            <div class="flex items-center justify-between gap-3">
              <span class="font-product type-ui-xs text-dls-secondary">
                {translate("skills.selected_count", { count: String(selectedImportableSkillIds().length) })}
              </span>
              <div class="flex justify-end gap-2">
                <Button variant="outline" onClick={closeSkillImport} disabled={skillImportBusy()}>
                  {translate("common.cancel")}
                </Button>
                <Button
                  variant="secondary"
                  onClick={confirmSkillImport}
                  disabled={skillImportBusy() || selectedImportableSkillIds().length === 0}
                >
                  <Show when={skillImportBusy()} fallback={translate("skills.import_selected")}>
                    <Loader2 size={14} class="animate-spin" />
                    {translate("skills.importing_selected")}
                  </Show>
                </Button>
              </div>
            </div>
          </footer>
        </div>
      </ModalShell>

      <Show when={installTargetSkill()}>
        {(skill) => (
          <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
            <div class="bg-dls-surface border border-dls-border w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden">
              <div class="p-6 space-y-5">
                <div>
                  <h3 class="text-lg font-semibold text-dls-text">{translate("skills.install_target_title")}</h3>
                  <p class="text-sm text-dls-secondary mt-1">
                    {translate("skills.install_target_description", { name: skill().name })}
                  </p>
                </div>

                <div class="space-y-3">
                  <label class="flex items-start gap-3 rounded-xl border border-dls-border bg-dls-hover px-4 py-3 opacity-70">
                    <input
                      type="radio"
                      class="mt-0.5"
                      checked={selectedInstallScope() === "global"}
                      disabled
                      onChange={() => setSelectedInstallScope("global")}
                    />
                    <div class="min-w-0">
                      <div class="text-sm font-semibold text-dls-text">
                        {translate("skills.install_target_all_workspaces")}
                      </div>
                      <div class="mt-1 text-xs text-dls-secondary">
                        {translate("skills.install_target_global_unavailable")}
                      </div>
                    </div>
                  </label>

                  <div class="space-y-2">
                    <div class="text-xs font-semibold uppercase tracking-widest text-dls-secondary">
                      {translate("skills.install_target_workspace")}
                    </div>
                    <For each={installTargetWorkspaces()}>
                      {(workspace) => {
                        const disabledReason = () => installTargetDisabledReason(workspace);
                        const isDisabled = () => Boolean(disabledReason());
                        return (
                          <label
                            class={`flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
                              isDisabled()
                                ? "border-dls-border bg-dls-hover opacity-70"
                                : "border-dls-border bg-dls-surface hover:bg-dls-hover"
                            }`}
                            title={disabledReason() ?? workspaceLabelForTarget(workspace)}
                          >
                            <input
                              type="radio"
                              class="mt-0.5"
                              checked={selectedInstallScope() === "workspace" && selectedInstallWorkspaceId() === workspace.id}
                              disabled={isDisabled()}
                              onChange={() => {
                                if (isDisabled()) return;
                                setSelectedInstallScope("workspace");
                                setSelectedInstallWorkspaceId(workspace.id);
                              }}
                            />
                            <div class="min-w-0">
                              <div class="flex flex-wrap items-center gap-2">
                                <span class="text-sm font-semibold text-dls-text truncate">
                                  {workspaceLabelForTarget(workspace)}
                                </span>
                                <Show when={workspace.id === props.activeWorkspaceId}>
                                  <span class="text-[11px] rounded-full border border-dls-border bg-dls-hover px-2 py-0.5 text-dls-secondary">
                                    {translate("skills.install_target_active_workspace")}
                                  </span>
                                </Show>
                              </div>
                              <div class="mt-1 text-xs text-dls-secondary truncate">
                                {disabledReason() ?? (workspace.workspaceType === "remote"
                                  ? translate("skills.install_target_remote_workspace")
                                  : translate("skills.install_target_local_workspace"))}
                              </div>
                            </div>
                          </label>
                        );
                      }}
                    </For>
                  </div>
                </div>

                <Show when={!installTargetCanSubmit()}>
                  <div class="rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary">
                    {selectedInstallScope() === "global"
                      ? translate("skills.install_target_global_unavailable")
                      : selectedInstallWorkspace()
                        ? translate("skills.install_target_switch_workspace")
                        : translate("skills.install_target_required")}
                  </div>
                </Show>

                <div class="flex justify-end gap-2">
                  <Button variant="outline" onClick={closeHubInstallTargetPicker} disabled={props.busy || Boolean(installingHubSkill())}>
                    {translate("common.cancel")}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={confirmHubInstallTarget}
                    disabled={props.busy || Boolean(installingHubSkill()) || !installTargetCanSubmit()}
                  >
                    {installingHubSkill() === skill().name ? translate("skills.installing_hub") : translate("skills.install_target_confirm")}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        )}
      </Show>

      <ModalShell
        open={Boolean(workspaceInstallAction())}
        onClose={closeWorkspaceInstallTargetPicker}
        layer="elevated"
        backdrop="medium"
        size="md"
        ariaLabelledBy={workspaceInstallTitleId}
        class="max-h-[calc(100vh-2rem)] bg-dls-surface"
      >
        <Show when={workspaceInstallAction()}>
          {(action) => (
            <div data-testid="skill-install-workspace-modal" class="flex max-h-[calc(100vh-2rem)] min-h-0 flex-col">
              <header class="shrink-0 border-b border-dls-border px-6 py-5">
                <div class="flex items-start justify-between gap-4">
                  <div class="min-w-0">
                    <h3 id={workspaceInstallTitleId} class="text-lg font-semibold text-dls-text">
                      {translate("skills.install_workspace_target_title")}
                    </h3>
                    <p class="text-sm text-dls-secondary mt-1">
                      {action().targets.length === 1
                        ? translate("skills.install_workspace_target_description", { name: action().name })
                        : translate("skills.install_workspace_target_bulk_description", { count: String(action().targets.length) })}
                    </p>
                  </div>
                  <button
                    type="button"
                    data-testid="skill-install-workspace-close"
                    class="rounded-lg border border-dls-border bg-gray-2 p-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={translate("common.close")}
                    onClick={closeWorkspaceInstallTargetPicker}
                    disabled={workspaceInstallBusy()}
                  >
                    <X size={18} />
                  </button>
                </div>
              </header>

              <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
                <div class="space-y-2">
                  <div class="text-xs font-semibold uppercase tracking-widest text-dls-secondary">
                    {translate("skills.install_target_workspace")}
                  </div>
                  <Show
                    when={workspaceInstallTargetWorkspaces().length}
                    fallback={
                      <div class="rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary">
                        {translate("skills.install_workspace_target_no_workspaces")}
                      </div>
                    }
                  >
                    <For each={workspaceInstallTargetWorkspaces()}>
                      {(workspace) => {
                        const disabledReason = () => workspaceInstallTargetDisabledReason(workspace);
                        const isDisabled = () => Boolean(disabledReason());
                        return (
                          <label
                            class={`flex items-start gap-3 rounded-xl border px-4 py-3 transition-colors ${
                              isDisabled()
                                ? "border-dls-border bg-dls-hover opacity-70"
                                : "border-dls-border bg-dls-surface hover:bg-dls-hover"
                            }`}
                            title={disabledReason() ?? workspaceLabelForTarget(workspace)}
                          >
                            <input
                              type="radio"
                              class="mt-0.5"
                              checked={selectedWorkspaceInstallWorkspaceId() === workspace.id}
                              disabled={isDisabled()}
                              onChange={() => {
                                if (isDisabled()) return;
                                setSelectedWorkspaceInstallWorkspaceId(workspace.id);
                              }}
                            />
                            <div class="min-w-0">
                              <div class="flex flex-wrap items-center gap-2">
                                <span class="text-sm font-semibold text-dls-text truncate">
                                  {workspaceLabelForTarget(workspace)}
                                </span>
                                <Show when={workspace.id === props.activeWorkspaceId}>
                                  <span class="text-[11px] rounded-full border border-dls-border bg-dls-hover px-2 py-0.5 text-dls-secondary">
                                    {translate("skills.install_target_active_workspace")}
                                  </span>
                                </Show>
                              </div>
                              <div class="mt-1 text-xs text-dls-secondary truncate">
                                {disabledReason() ?? translate("skills.install_target_local_workspace")}
                              </div>
                            </div>
                          </label>
                        );
                      }}
                    </For>
                  </Show>
                </div>

                <Show when={!workspaceInstallCanSubmit()}>
                  <div class="mt-4 rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary">
                    {selectedWorkspaceInstallWorkspace()
                      ? translate("skills.install_workspace_target_local_required")
                      : translate("skills.install_workspace_target_required")}
                  </div>
                </Show>
              </div>

              <footer class="shrink-0 border-t border-dls-border px-6 py-4">
                <div class="flex justify-end gap-2">
                  <Button variant="outline" onClick={closeWorkspaceInstallTargetPicker} disabled={workspaceInstallBusy()}>
                    {translate("common.cancel")}
                  </Button>
                  <Button
                    variant="secondary"
                    data-testid="skill-install-workspace-confirm"
                    onClick={() => void confirmWorkspaceInstallTarget()}
                    disabled={workspaceInstallBusy() || !workspaceInstallCanSubmit()}
                  >
                    {workspaceInstallBusy() ? translate("skills.installing_hub") : translate("skills.install_workspace_target_confirm")}
                  </Button>
                </div>
              </footer>
            </div>
          )}
        </Show>
      </ModalShell>

      <Show when={selectedSkill()}>
        <div class="fixed inset-0 z-50 bg-black/40 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="w-full max-w-4xl rounded-2xl border border-dls-border bg-dls-surface shadow-2xl overflow-hidden">
            <div class="px-5 py-4 border-b border-dls-border flex items-center justify-between gap-3">
              <div class="min-w-0">
                <div class="text-sm font-semibold text-dls-text truncate">{selectedSkill()!.name}</div>
                <div class="text-xs text-dls-secondary truncate">{selectedSkill()!.path}</div>
              </div>
              <div class="flex items-center gap-2">
                <button
                  type="button"
                  class={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${
                    selectedDirty() && !props.busy
                      ? "bg-dls-text text-dls-surface hover:opacity-90"
                      : "bg-dls-active text-dls-secondary"
                  }`}
                  disabled={!selectedDirty() || props.busy}
                  onClick={() => void saveSelectedSkill()}
                >
                  {translate("skills.save")}
                </button>
                <button
                  type="button"
                  class="px-3 py-1.5 text-xs font-medium rounded-lg bg-dls-hover text-dls-text hover:bg-dls-active transition-colors"
                  onClick={closeSkill}
                >
                  {translate("skills.close")}
                </button>
              </div>
            </div>

            <div class="p-5">
              <Show when={selectedError()}>
                <div class="mb-3 rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">
                  {selectedError()}
                </div>
              </Show>
              <Show
                when={!selectedLoading()}
                fallback={<div class="text-xs text-dls-secondary">{translate("skills.loading")}</div>}
              >
                <textarea
                  value={selectedContent()}
                  onInput={(e) => {
                    setSelectedContent(e.currentTarget.value);
                    setSelectedDirty(true);
                  }}
                  class="w-full min-h-[420px] rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs font-mono text-dls-text focus:outline-none focus:ring-2 focus:ring-[rgba(var(--dls-accent-rgb)/0.25)]"
                  spellcheck={false}
                />
              </Show>
            </div>
          </div>
        </div>
      </Show>

      <Show when={bulkRemoveOpen()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div
            data-testid="skill-bulk-remove-modal"
            class="bg-dls-surface border border-dls-border w-full max-w-md rounded-2xl shadow-2xl overflow-hidden"
          >
            <div class="p-6">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h3 class="text-lg font-semibold text-dls-text">{translate("skills.bulk_remove_title")}</h3>
                  <p class="text-sm text-dls-secondary mt-1">
                    {translate("skills.bulk_remove_warning", { count: String(bulkRemoveTargets().length) })}
                  </p>
                </div>
              </div>

              <div class="mt-4 max-h-48 overflow-y-auto rounded-xl bg-dls-hover border border-dls-border p-3 text-xs text-dls-secondary font-mono">
                <For each={bulkRemoveTargets()}>
                  {(target) => <div class="truncate">{target.name}</div>}
                </For>
              </div>

              <div class="mt-6 flex justify-end gap-2">
                <Button
                  variant="outline"
                  data-testid="skill-bulk-remove-cancel"
                  onClick={() => setBulkRemoveTargets([])}
                  disabled={skillMutationBusy()}
                >
                  {translate("common.cancel")}
                </Button>
                <Button
                  variant="danger"
                  data-testid="skill-bulk-remove-confirm"
                  onClick={() => void confirmBulkRemoveSkillInstances()}
                  disabled={skillMutationBusy()}
                >
                  {translate("skills.bulk_remove")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={uninstallOpen()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div
            data-testid="skill-uninstall-modal"
            class="bg-dls-surface border border-dls-border w-full max-w-md rounded-2xl shadow-2xl overflow-hidden"
          >
            <div class="p-6">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h3 class="text-lg font-semibold text-dls-text">{translate("skills.uninstall_title")}</h3>
                  <p class="text-sm text-dls-secondary mt-1">
                    {removeWarningForTarget(uninstallTarget())}
                  </p>
                </div>
              </div>

              <div class="mt-4 rounded-xl bg-dls-hover border border-dls-border p-3 text-xs text-dls-secondary font-mono break-all">
                {uninstallTarget()?.path}
              </div>

              <div class="mt-6 flex justify-end gap-2">
                <Button
                  variant="outline"
                  data-testid="skill-uninstall-cancel"
                  onClick={() => setUninstallTarget(null)}
                  disabled={skillMutationBusy()}
                >
                  {translate("common.cancel")}
                </Button>
                <Button
                  variant="danger"
                  data-testid="skill-uninstall-confirm"
                  onClick={() => void confirmRemoveSkillInstance()}
                  disabled={skillMutationBusy()}
                >
                  {translate("skills.uninstall")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={restoreOpen()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div
            data-testid="skill-restore-modal"
            class="bg-dls-surface border border-dls-border w-full max-w-md rounded-2xl shadow-2xl overflow-hidden"
          >
            <div class="p-6">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h3 class="text-lg font-semibold text-dls-text">{translate("skills.restore_title")}</h3>
                  <p class="text-sm text-dls-secondary mt-1">
                    {translate("skills.restore_warning").replace("{name}", restoreTarget()?.name ?? "")}
                  </p>
                </div>
              </div>

              <div class="mt-4 rounded-xl bg-dls-hover border border-dls-border p-3 text-xs text-dls-secondary font-mono break-all">
                {restoreTarget()?.path}
              </div>

              <div class="mt-6 flex justify-end gap-2">
                <Button
                  variant="outline"
                  data-testid="skill-restore-cancel"
                  onClick={() => setRestoreTarget(null)}
                  disabled={skillMutationBusy()}
                >
                  {translate("common.cancel")}
                </Button>
                <Button
                  variant="primary"
                  data-testid="skill-restore-confirm"
                  onClick={() => void confirmRestoreSkillInstance()}
                  disabled={skillMutationBusy()}
                >
                  {translate("skills.restore")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <SkillDetailDrawer
        open={Boolean(selectedDetail())}
        skill={selectedDetailMetadata()}
        locations={selectedDetailLocations()}
        versions={selectedDetailVersions()}
        versionTargets={selectedDetailVersionTarget() ? [selectedDetailVersionTarget()!] : []}
        selectedTab={selectedDetailTab()}
        files={selectedDetailFiles()}
        filesLoading={selectedDetailFilesLoading()}
        filesError={selectedDetailFilesError()}
        selectedFilePath={selectedDetailFilePath()}
        onSelectTab={selectSkillDetailTab}
        onSelectFile={(file) => setSelectedDetailFilePath(file.path)}
        onRetryFiles={() => void loadSelectedDetailFiles({ force: true })}
        onClose={closeSkillDetail}
        actionUnavailableReason={{
          copy: selectedDetailCanTransferToUserSkill() ? null : selectedDetailGlobalTransferDisabledReason(),
          move: selectedDetailCanTransferToUserSkill() ? null : selectedDetailGlobalTransferDisabledReason(),
          delete: selectedDetailDeleteDisabledReason(),
          restore: selectedDetailRestoreDisabledReason(),
        }}
        onEditSkill={selectedDetailIsWorkspaceSkill() ? editSelectedSkill : undefined}
        onCopySkill={selectedDetailIsWorkspaceSkill() ? (input) => copySelectedSkillToGlobal(true, input) : undefined}
        onMoveSkill={selectedDetailIsWorkspaceSkill() ? (input) => copySelectedSkillToGlobal(true, input) : undefined}
        onCopyToWorkspaceSkill={selectedDetailCanInstallToWorkspace() ? openWorkspaceInstallTargetPicker : undefined}
        onPublishSkill={selectedDetailCanPublishFromLocal() ? (action) => openSkillReviewDialog("organization", action) : undefined}
        onRequestApproval={selectedDetailCanPublishFromLocal() ? (action) => openSkillReviewDialog("system", action) : undefined}
        onRestoreSkill={selectedDetailHasRestoreAction() ? requestDetailRestore : undefined}
        onRestoreVersion={showRegistryActionPending}
        onDeleteSkill={selectedDetailShowsRemoveAction() ? requestDetailDelete : undefined}
      />

      <Show when={reviewDialog()}>
        {(dialog) => (
          <SkillReviewDialog
            open
            mode={dialog().mode}
            skillId={dialog().action.skill.id}
            versionId={dialog().action.skill.currentVersionId ?? dialog().action.skill.id}
            skillName={dialog().action.skill.name}
            versionLabel={translate("skills.current_version")}
            targetScope={dialog().targetScope}
            metadataDiff={selectedReviewMetadataDiff()}
            fileDiffs={selectedReviewFileDiffs()}
            reason={reviewReason()}
            pending={publishRequestPending()}
            onReasonChange={setReviewReason}
            onClose={closeSkillReviewDialog}
            onSaveDraft={saveSkillReviewDraft}
            onRequestOrganizationPublish={canSubmitRegistryPublishRequest() ? (input) => void requestSkillRegistryPublish(input) : undefined}
            onRequestSystemApproval={canSubmitRegistryPublishRequest() ? (input) => void requestSkillRegistryPublish(input) : undefined}
          />
        )}
      </Show>

      <Show when={installLinkOpen()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-dls-surface border border-dls-border w-full max-w-lg rounded-2xl shadow-2xl overflow-hidden">
            <div class="p-6 space-y-4">
              <div>
                <h3 class="text-lg font-semibold text-dls-text">{translate("skills.install_from_link_title")}</h3>
                <p class="text-sm text-dls-secondary mt-1">{translate("skills.install_from_link_desc")}</p>
              </div>

              <div class="space-y-2">
                <div class="text-xs font-semibold uppercase tracking-widest text-dls-secondary">{translate("skills.link_label")}</div>
                <input
                  type="url"
                  value={installLinkUrl()}
                  onInput={(e) => setInstallLinkUrl(e.currentTarget.value)}
                  placeholder="https://share.veslo.neatech.com/b/..."
                  class="w-full bg-dls-hover border border-dls-border rounded-lg px-3 py-2 text-xs font-mono text-dls-text focus:outline-none"
                  spellcheck={false}
                />
              </div>

              <Show when={installLinkError()}>
                <div class="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">
                  {installLinkError()}
                </div>
              </Show>

              <Show when={installLinkBundle()}>
                {(bundle) => {
                  const activeWorkspaceConflict = canOverwriteInstallLinkBundle(bundle().name);
                  const globalOnlyConflict = installedNames().has(bundle().name.trim()) && !activeWorkspaceConflict;
                  return (
                    <div class="rounded-xl border border-dls-border bg-dls-hover p-4 space-y-2">
                      <div class="text-xs font-semibold text-dls-text">{translate("skills.preview")}</div>
                      <div class="text-xs text-dls-secondary">
                        {translate("skills.skill_label")} <span class="font-mono">{bundle().name}</span>
                      </div>
                      <Show when={bundle().description}>
                        <div class="text-xs text-dls-secondary">{bundle().description}</div>
                      </Show>
                      <Show when={activeWorkspaceConflict}>
                        <div class="text-xs text-amber-11">{translate("skills.conflict_warning")}</div>
                      </Show>
                      <Show when={globalOnlyConflict}>
                        <div class="text-xs text-amber-11">{translate("skills.global_conflict_warning")}</div>
                      </Show>
                    </div>
                  );
                }}
              </Show>

              <div class="flex justify-end gap-2">
                <Button variant="outline" onClick={closeInstallFromLink} disabled={installLinkBusy()}>
                  {translate("common.cancel")}
                </Button>
                <Button
                  variant="outline"
                  onClick={() => void previewInstallLink()}
                  disabled={installLinkBusy() || !installLinkUrl().trim()}
                >
                  {installLinkBusy() && !installLinkBundle() ? translate("skills.loading") : translate("skills.preview")}
                </Button>
                <Show when={installLinkBundle()} keyed>
                  {(bundle) => {
                    const activeWorkspaceConflict = canOverwriteInstallLinkBundle(bundle.name);
                    const globalOnlyConflict = installedNames().has(bundle.name.trim()) && !activeWorkspaceConflict;
                    return (
                      <Show
                        when={activeWorkspaceConflict}
                        fallback={
                          <Button
                            variant="secondary"
                            onClick={() => void installFromPreview(globalOnlyConflict ? "keep-both" : "overwrite")}
                            disabled={installLinkBusy()}
                          >
                            {installLinkBusy()
                              ? translate("skills.installing_skill_creator").replace("...", "…")
                              : globalOnlyConflict ? translate("skills.keep_both") : translate("skills.install")}
                          </Button>
                        }
                      >
                        <div class="flex gap-2">
                          <Button
                            variant="outline"
                            onClick={() => void installFromPreview("keep-both")}
                            disabled={installLinkBusy()}
                          >
                            {installLinkBusy() ? translate("skills.installing_skill_creator").replace("...", "…") : translate("skills.keep_both")}
                          </Button>
                          <Button
                            variant="secondary"
                            onClick={() => void installFromPreview("overwrite")}
                            disabled={installLinkBusy()}
                          >
                            {installLinkBusy() ? translate("skills.installing_skill_creator").replace("...", "…") : translate("skills.overwrite")}
                          </Button>
                        </div>
                      </Show>
                    );
                  }}
                </Show>
              </div>
            </div>
          </div>
        </div>
      </Show>
    </section>
  );
}
