import { For, Show, createEffect, createMemo, createSignal, onCleanup, onMount } from "solid-js";

import type {
  HubSkillCard,
  HubSkillInstallTarget,
  SkillCard,
  SkillInstance,
  SkillInventoryItem,
  SkillSaveResult,
} from "../types";
import type { WorkspaceInfo } from "../lib/tauri";

import Button from "../components/button";
import SkillDetailDrawer, {
  type SkillDetailActionInput,
  type SkillDetailLocation,
  type SkillDetailMetadata,
  type SkillDetailTab,
} from "../components/skill-detail-drawer";
import SkillReviewDialog, { type SkillReviewTargetScope } from "../components/skill-review-dialog";
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
  Search,
  Share2,
  Table2,
  Trash2,
  Upload,
} from "lucide-solid";
import { currentLocale, t } from "../../i18n";
import { DEFAULT_VESLO_PUBLISHER_BASE_URL, publishVesloBundleJson } from "../lib/publisher";
import { skillMutationTargetFromInstance } from "../lib/skill-inventory";
import type { SkillMutationTarget } from "../lib/skill-inventory";
import {
  filterSkillInventoryItems,
  selectAllSkillInventoryIdsForCurrentFilter,
  skillInventoryInstanceId,
  type SkillInventoryFilters,
  type SkillInventorySelectionId,
} from "../lib/skill-inventory-filters";
import { isTauriRuntime } from "../utils";

type InstallResult = { ok: boolean; message: string };
type ActionSkillCard = SkillCard & { mutationTarget: SkillMutationTarget };
type InventoryViewMode = "cards" | "table";

type SkillBundleV1 = {
  schemaVersion: 1;
  type: "skill";
  name: string;
  content: string;
  description?: string;
  trigger?: string;
};

const SKILLS_TOAST_DISMISS_DELAY_MS = 4_000;

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
  isRemoteWorkspace: boolean;
  busy: boolean;
  canInstallSkillCreator: boolean;
  canUseDesktopTools: boolean;
  accessHint?: string | null;
  refreshSkills: (options?: { force?: boolean }) => void;
  refreshSkillInventory: (options?: { force?: boolean }) => void;
  refreshHubSkills: (options?: { force?: boolean }) => void;
  skills: SkillCard[];
  skillsStatus: string | null;
  skillInventory: SkillInventoryItem[];
  skillInventoryStatus: string | null;
  hubSkills: HubSkillCard[];
  hubSkillsStatus: string | null;
  workspaces: WorkspaceInfo[];
  importLocalSkill: () => void;
  installSkillCreator: () => Promise<InstallResult>;
  installHubSkill: (name: string, target: HubSkillInstallTarget) => Promise<InstallResult>;
  revealSkillsFolder: () => void;
  uninstallSkill: (name: string) => void;
  readSkill: (name: string) => Promise<{ name: string; path: string; content: string } | null>;
  saveSkill: (input: { name: string; path?: string; content: string; description?: string }) => Promise<SkillSaveResult>;
  readSkillInstance: (target: SkillMutationTarget) => Promise<{ name: string; path: string; content: string } | null>;
  saveSkillInstance: (target: SkillMutationTarget, content: string) => Promise<SkillSaveResult>;
  deleteSkillInstance: (target: SkillMutationTarget) => Promise<void>;
  copySkillInstanceToGlobal: (target: SkillMutationTarget, options?: { deleteSource?: boolean }) => Promise<SkillSaveResult>;
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
          readable: true,
          writable: true,
        },
      ],
    }));
  });

  const installedInventoryItems = createMemo(() =>
    mergeRemoteFallbackIntoInventory(
      props.skillInventory.filter((item) => item.status !== "hub-only"),
      activeRemoteInventoryItems(),
    )
  );

  const [uninstallTarget, setUninstallTarget] = createSignal<SkillMutationTarget | null>(null);
  const uninstallOpen = createMemo(() => uninstallTarget() != null);
  const [searchQuery, setSearchQuery] = createSignal("");
  const [inventoryScopeFilter, setInventoryScopeFilter] = createSignal<"all" | "user-global" | "workspace">("all");
  const [inventoryWorkspaceFilter, setInventoryWorkspaceFilter] = createSignal("all");
  const [inventoryIncludeDeleted, setInventoryIncludeDeleted] = createSignal(false);
  const [inventoryViewMode, setInventoryViewMode] = createSignal<InventoryViewMode>("cards");
  const [selectedInventoryIds, setSelectedInventoryIds] = createSignal<SkillInventorySelectionId[]>([]);

  const [shareTarget, setShareTarget] = createSignal<SkillCard | null>(null);
  const shareOpen = createMemo(() => shareTarget() != null);
  const [shareBusy, setShareBusy] = createSignal(false);
  const [shareUrl, setShareUrl] = createSignal<string | null>(null);
  const [shareError, setShareError] = createSignal<string | null>(null);

  const [installLinkOpen, setInstallLinkOpen] = createSignal(false);
  const [installLinkUrl, setInstallLinkUrl] = createSignal("");
  const [installLinkBusy, setInstallLinkBusy] = createSignal(false);
  const [installLinkError, setInstallLinkError] = createSignal<string | null>(null);
  const [installLinkBundle, setInstallLinkBundle] = createSignal<SkillBundleV1 | null>(null);

  const [installTargetSkill, setInstallTargetSkill] = createSignal<HubSkillCard | null>(null);
  const [selectedInstallScope, setSelectedInstallScope] = createSignal<"global" | "workspace">("workspace");
  const [selectedInstallWorkspaceId, setSelectedInstallWorkspaceId] = createSignal<string | null>(null);

  const [selectedSkill, setSelectedSkill] = createSignal<ActionSkillCard | null>(null);
  const [selectedContent, setSelectedContent] = createSignal("");
  const [selectedLoading, setSelectedLoading] = createSignal(false);
  const [selectedDirty, setSelectedDirty] = createSignal(false);
  const [selectedError, setSelectedError] = createSignal<string | null>(null);
  const [selectedDetail, setSelectedDetail] = createSignal<{ item: SkillInventoryItem; instance: SkillInstance } | null>(null);
  const [selectedDetailTab, setSelectedDetailTab] = createSignal<SkillDetailTab>("overview");
  const [reviewDialog, setReviewDialog] = createSignal<{
    mode: "request" | "review";
    targetScope: SkillReviewTargetScope;
    action: SkillDetailActionInput;
  } | null>(null);
  const [reviewReason, setReviewReason] = createSignal("");

  const [toast, setToast] = createSignal<string | null>(null);
  const [installingHubSkill, setInstallingHubSkill] = createSignal<string | null>(null);

  onMount(() => {
    props.refreshSkillInventory({ force: true });
    props.refreshHubSkills();
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

  const mutationTargetForInstance = (instance: SkillInstance): SkillMutationTarget | null => {
    if (!instance.writable) return null;
    if (instance.scope !== "workspace") return null;
    if (instance.workspaceId !== props.activeWorkspaceId) return null;
    return skillMutationTargetFromInstance(instance);
  };

  const actionSkillForInstance = (instance: SkillInstance): ActionSkillCard | null => {
    const mutationTarget = mutationTargetForInstance(instance);
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

  const canUninstallInventoryInstance = (input: { item: SkillInventoryItem; instance: SkillInstance }) =>
    Boolean(mutationTargetForInstance(input.instance));

  const uninstallDisabledReason = (input: { item: SkillInventoryItem; instance: SkillInstance }) => {
    if (input.instance.writable === false) return translate("skills.uninstall_read_only");
    if (input.instance.scope !== "workspace") return translate("skills.uninstall_scope_ambiguous");
    if (input.instance.workspaceId !== props.activeWorkspaceId) return translate("skills.uninstall_not_active_workspace");
    return translate("skills.uninstall_scoped_pending");
  };

  const globalTransferDisabledReasonForInstance = (instance: SkillInstance) => {
    if (instance.writable === false) return translate("skills.copy_to_global_read_only");
    if (instance.scope === "user-global") return translate("skills.copy_to_global_already_global");
    if (instance.scope !== "workspace") return translate("skills.copy_to_global_unavailable");
    if (instance.workspaceId !== props.activeWorkspaceId) return translate("skills.copy_to_global_not_active_workspace");
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
    filterSkillInventoryItems(installedInventoryItems(), installedInventoryFilterState())
  );

  const allWorkspaceInventoryItems = createMemo(() =>
    filteredInstalledInventoryItems().filter((item) => Boolean(item.globalInstance))
  );

  const workspaceInventoryRows = createMemo(() =>
    filteredInstalledInventoryItems()
      .flatMap((item) =>
        item.workspaceInstances.map((instance) => ({
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
    selectAllSkillInventoryIdsForCurrentFilter(installedInventoryItems(), installedInventoryFilterState())
  );
  const selectedInventoryIdSet = createMemo(() => new Set(selectedInventoryIds()));
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
  const selectedGlobalTransferTargets = createMemo(() =>
    selectedInventoryRows()
      .map((row) => mutationTargetForInstance(row.instance))
      .filter((target): target is SkillMutationTarget => Boolean(target))
  );
  const globalTransferDisabledReason = createMemo(() => {
    const selectedRows = selectedInventoryRows();
    if (selectedRows.length === 0) return translate("skills.select_skill_location");
    if (selectedGlobalTransferTargets().length !== selectedRows.length) return translate("skills.copy_to_global_unavailable");
    return null;
  });

  const transferSelectedSkillsToGlobal = async (deleteSource: boolean) => {
    const disabledReason = globalTransferDisabledReason();
    if (disabledReason) {
      setToast(disabledReason);
      return;
    }

    for (const target of selectedGlobalTransferTargets()) {
      const result = await props.copySkillInstanceToGlobal(target, { deleteSource });
      if (!result.ok) {
        setToast(result.message ?? translate("skills.failed_save_skill"));
        return;
      }
    }

    setSelectedInventoryIds([]);
    setToast(translate(deleteSource ? "skills.moved_to_global" : "skills.copied_to_global"));
    props.refreshSkillInventory({ force: true });
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
    setSelectedDetail({ item, instance });
    setSelectedDetailTab("overview");
  };

  const toggleTableRowSelection = (instance: SkillInstance) => {
    const id = skillInventoryInstanceId(instance);
    toggleInventorySelection(id, !selectedInventoryIdSet().has(id));
  };

  const skillDetailLocationFromInstance = (instance: SkillInstance): SkillDetailLocation => ({
    id: instance.id,
    label: instance.scope === "user-global" ? translate("skills.all_workspaces") : workspaceLabelForInstance(instance),
    scope: instance.scope === "user-global" ? "global" : "workspace",
    path: instance.path,
    writable: instance.writable,
    active: selectedDetail()?.instance.id === instance.id,
    source: instance.source,
    actionUnavailableReason: {
      copy: globalTransferDisabledReasonForInstance(instance),
      move: globalTransferDisabledReasonForInstance(instance),
    },
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
      status: detail.item.status,
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
      label: detail.instance.scope === "user-global" ? translate("skills.all_workspaces") : workspaceLabelForInstance(detail.instance),
      scope: detail.instance.scope === "user-global" ? "global" : "workspace",
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

  const copySelectedSkillToGlobal = (deleteSource: boolean, input?: SkillDetailActionInput) => {
    const actionInstance = detailInstanceForAction(input);
    if (!actionInstance) return;
    const target = mutationTargetForInstance(actionInstance);
    if (!target) {
      setToast(globalTransferDisabledReasonForInstance(actionInstance) ?? translate("skills.copy_to_global_unavailable"));
      return;
    }

    void props.copySkillInstanceToGlobal(target, { deleteSource }).then((result) => {
      setToast(result.message ?? translate(result.ok ? "skills.copied_to_global" : "skills.failed_save_skill"));
      if (result.ok) props.refreshSkillInventory({ force: true });
    });
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

  const openSkillReviewDialog = (targetScope: SkillReviewTargetScope, action: SkillDetailActionInput) => {
    setReviewReason("");
    setReviewDialog({
      mode: "request",
      targetScope,
      action,
    });
  };

  const closeSkillReviewDialog = () => {
    setReviewDialog(null);
    setReviewReason("");
  };

  const selectedReviewMetadataDiff = createMemo(() => {
    const detail = selectedDetail();
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
    const detail = selectedDetail();
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
    const target = mutationTargetForInstance(detail.instance);
    if (!target) {
      setToast(uninstallDisabledReason({ item: detail.item, instance: detail.instance }));
      return;
    }
    setUninstallTarget(target);
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

  const installTargetWorkspaces = createMemo<WorkspaceInfo[]>(() => {
    if (props.workspaces.some((workspace) => workspace.id === props.activeWorkspaceId)) {
      return props.workspaces;
    }
    return [
      {
        id: props.activeWorkspaceId,
        name: props.workspaceName,
        path: "",
        preset: "",
        workspaceType: props.isRemoteWorkspace ? "remote" : "local",
      },
      ...props.workspaces,
    ];
  });

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

  const importLocalSkillAndRefreshInventory = () =>
    Promise.resolve(props.importLocalSkill())
      .finally(() => props.refreshSkillInventory({ force: true }));

  const recommendedSkills = createMemo(() => {
    const items: Array<{
      id: string;
      title: string;
      description: string;
      icon: any;
      onClick: () => void | Promise<void>;
      disabled: boolean;
    }> = [
      {
        id: "import-local",
        title: translate("skills.import_local"),
        description: translate("skills.import_local_hint"),
        icon: Upload,
        onClick: importLocalSkillAndRefreshInventory,
        disabled: props.busy || !props.canUseDesktopTools,
      },
      {
        id: "reveal-folder",
        title: translate("skills.reveal_folder"),
        description: translate("skills.reveal_folder_hint"),
        icon: FolderOpen,
        onClick: props.revealSkillsFolder,
        disabled: props.busy || !props.canUseDesktopTools,
      },
    ];

    return items;
  });

  const openShareLink = (skill: SkillCard) => {
    if (props.busy) return;
    setShareTarget(skill);
    setShareBusy(false);
    setShareUrl(null);
    setShareError(null);
  };

  const closeShareLink = () => {
    setShareTarget(null);
    setShareBusy(false);
    setShareUrl(null);
    setShareError(null);
  };

  const publishShareLink = async () => {
    const target = shareTarget();
    if (!target) return;
    if (props.busy || shareBusy()) return;
    setShareBusy(true);
    setShareUrl(null);
    setShareError(null);

    try {
      const skill = await props.readSkill(target.name);
      if (!skill) throw new Error(translate("skills.failed_load_skill"));

      const payload: SkillBundleV1 = {
        schemaVersion: 1,
        type: "skill",
        name: target.name,
        content: skill.content,
        description: target.description ?? undefined,
        trigger: target.trigger ?? undefined,
      };

      const result = await publishVesloBundleJson({
        payload,
        bundleType: "skill",
        name: target.name,
      });

      setShareUrl(result.url);
      try {
        await navigator.clipboard.writeText(result.url);
        setToast(translate("skills.link_copied"));
      } catch {
        // ignore
      }
    } catch (e) {
      setShareError(maskError(e));
    } finally {
      setShareBusy(false);
    }
  };

  const copyShareLink = async () => {
    const url = shareUrl()?.trim();
    if (!url) return;
    try {
      await navigator.clipboard.writeText(url);
      setToast(translate("skills.link_copied"));
    } catch {
      setShareError(translate("skills.failed_copy_link"));
    }
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

  const recommendedDisabledReason = (id: string) => {
    void id;

    if (!props.canUseDesktopTools) {
      return translate("skills.desktop_required");
    }

    return null;
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

  const renderInventoryCard = (input: {
    item: SkillInventoryItem;
    instance: SkillInstance;
    workspaceLabel?: string;
  }) => {
    const actionSkill = createMemo(() => actionSkillForInstance(input.instance));
    const displayDescription = () => input.instance.description ?? input.item.description ?? "";
    const canUseActions = () => Boolean(actionSkill());
    const canUninstall = () => canUninstallInventoryInstance({ item: input.item, instance: input.instance });
    const uninstallTitle = () =>
      uninstallDisabledReason({ item: input.item, instance: input.instance }) ?? translate("skills.uninstall");
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
              <button
                type="button"
                class="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-md border border-dls-border bg-dls-hover text-dls-secondary transition-colors hover:bg-dls-active hover:text-dls-text disabled:opacity-40"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void openInventoryInstanceLocation(input.instance.path);
                }}
                disabled={!input.instance.path.trim()}
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
          <button
            type="button"
            class={`p-1.5 rounded-md transition-colors ${
              props.busy || !canUseActions()
                ? "text-dls-secondary opacity-40"
                : "text-dls-secondary hover:text-dls-text hover:bg-dls-active"
            }`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const skill = actionSkill();
              if (!skill || props.busy) return;
              openShareLink(skill);
            }}
            disabled={props.busy || !canUseActions()}
            title={translate("skills.share_action")}
            aria-label={translate("skills.share_action")}
          >
            <Share2 size={14} />
          </button>
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
          <button
            type="button"
            class={`p-1.5 rounded-md transition-colors ${
              props.busy || !canUninstall()
                ? "text-dls-secondary opacity-40"
                : "text-dls-secondary hover:text-red-11 hover:bg-red-3/10"
            }`}
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              const target = mutationTargetForInstance(input.instance);
              if (!target || props.busy) return;
              setUninstallTarget(target);
            }}
            disabled={props.busy || !canUninstall()}
            title={uninstallTitle()}
            aria-label={uninstallTitle()}
          >
            <Trash2 size={14} />
          </button>
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
          onChange={(event) => setInventoryScopeFilter(event.currentTarget.value as "all" | "user-global" | "workspace")}
        >
          <option value="all">{translate("skills.filter_scope_all")}</option>
          <option value="user-global">{translate("skills.filter_scope_global")}</option>
          <option value="workspace">{translate("skills.filter_scope_workspace")}</option>
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
            checked={inventoryIncludeDeleted()}
            onChange={(event) => setInventoryIncludeDeleted(event.currentTarget.checked)}
          />
          {translate("skills.filter_deleted")}
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
            <Button
              variant="outline"
              class="h-8 px-2 type-ui-xs"
              title={globalTransferDisabledReason() ?? translate("skills.copy_to_global")}
              disabled={props.busy || Boolean(globalTransferDisabledReason())}
              onClick={() => void transferSelectedSkillsToGlobal(false)}
            >
              <Copy size={13} />
              {translate("skills.copy_to_global")}
            </Button>
            <Button
              variant="outline"
              class="h-8 px-2 type-ui-xs"
              title={globalTransferDisabledReason() ?? translate("skills.move_to_global")}
              disabled={props.busy || Boolean(globalTransferDisabledReason())}
              onClick={() => void transferSelectedSkillsToGlobal(true)}
            >
              <ArrowRightToLine size={13} />
              {translate("skills.move_to_global")}
            </Button>
            <Button variant="outline" class="h-8 px-2 type-ui-xs" disabled title={translate("skills.registry_action_pending")} onClick={showRegistryActionPending}>
              <Upload size={13} />
              {translate("skills.bulk_publish")}
            </Button>
            <Button variant="outline" class="h-8 px-2 type-ui-xs" disabled title={translate("skills.registry_action_pending")} onClick={showRegistryActionPending}>
              <Package size={13} />
              {translate("skills.bulk_adopt")}
            </Button>
            <Button variant="danger" class="h-8 px-2 type-ui-xs" disabled title={translate("skills.registry_action_pending")} onClick={showRegistryActionPending}>
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
                      return (
                        <tr
                          class="border-b border-dls-border last:border-0 hover:bg-dls-hover"
                          data-testid="skill-inventory-table-row"
                          data-skill-inventory-name={row.item.name}
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
                            <div class="truncate font-product type-ui-sm font-semibold text-dls-text">{row.item.name}</div>
                            <Show when={row.instance.description ?? row.item.description}>
                              {(description) => <div class="truncate type-ui-xs text-dls-secondary">{description()}</div>}
                            </Show>
                          </td>
                          <td class="px-3 py-2 type-ui-sm text-dls-secondary">
                            {row.instance.scope === "user-global" ? translate("skills.filter_scope_global") : translate("skills.filter_scope_workspace")}
                          </td>
                          <td class="max-w-[220px] px-3 py-2 type-ui-sm text-dls-secondary">
                            <span class="block truncate">{row.workspaceLabel}</span>
                          </td>
                          <td class="px-3 py-2 type-ui-sm text-dls-secondary">{row.instance.source}</td>
                          <td class="px-3 py-2">
                            <div class="flex justify-end gap-1">
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
                                class="rounded-md p-1.5 text-dls-secondary hover:bg-dls-active hover:text-dls-text"
                                onClick={(event) => {
                                  event.preventDefault();
                                  event.stopPropagation();
                                  void openInventoryInstanceLocation(row.instance.path);
                                }}
                                aria-label={translate("skills.reveal_skill_location")}
                                title={translate("skills.reveal_skill_location")}
                              >
                                <FolderOpen size={14} />
                              </button>
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

      <div class="space-y-4">
        <h3 class="text-[11px] font-bold text-dls-secondary uppercase tracking-widest">{translate("skills.capability_setup")}</h3>
        <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
          <For each={recommendedSkills()}>
            {(item) => (
              <div
                role="button"
                tabindex="0"
                class={`bg-dls-surface border border-dls-border rounded-xl p-4 flex items-start justify-between group transition-all text-left ${
                  item.disabled ? "opacity-80" : "hover:border-dls-border hover:bg-dls-hover"
                }`}
                onClick={() => {
                  if (item.disabled) {
                    const reason = recommendedDisabledReason(item.id);
                    if (reason) setToast(reason);
                    return;
                  }
                  void item.onClick();
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  if (e.isComposing || e.keyCode === 229) return;
                  e.preventDefault();
                  if (item.disabled) {
                    const reason = recommendedDisabledReason(item.id);
                    if (reason) setToast(reason);
                    return;
                  }
                  void item.onClick();
                }}
                title={item.disabled ? (recommendedDisabledReason(item.id) ?? item.title) : item.title}
              >
                <div class="flex gap-4 min-w-0">
                  <div class="w-10 h-10 rounded-lg flex items-center justify-center shadow-sm border border-dls-border bg-dls-hover">
                    <item.icon size={20} class="text-dls-secondary" />
                  </div>
                    <div class="min-w-0">
                      <div class="flex items-center gap-2 mb-0.5">
                        <h4 class="text-sm font-semibold text-dls-text truncate">{item.title}</h4>
                      </div>
                      <p class="text-xs text-dls-secondary line-clamp-2">{item.description}</p>
                    </div>
                  </div>
                <button
                  type="button"
                  class={`p-1.5 rounded-md transition-colors ${
                    item.disabled
                      ? "text-dls-secondary opacity-40"
                      : "text-dls-secondary hover:text-dls-text hover:bg-dls-hover"
                  }`}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (item.disabled) {
                      const reason = recommendedDisabledReason(item.id);
                      if (reason) setToast(reason);
                      return;
                    }
                    void item.onClick();
                  }}
                  disabled={item.disabled}
                  title={item.title}
                  aria-label={item.title}
                >
                  <Plus size={16} />
                </button>
              </div>
            )}
          </For>
        </div>
      </div>

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

      <Show when={uninstallOpen()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-dls-surface border border-dls-border w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
            <div class="p-6">
              <div class="flex items-start justify-between gap-4">
                <div>
                  <h3 class="text-lg font-semibold text-dls-text">{translate("skills.uninstall_title")}</h3>
                  <p class="text-sm text-dls-secondary mt-1">
                    {translate("skills.uninstall_warning").replace("{name}", uninstallTarget()?.name ?? "")}
                  </p>
                </div>
              </div>

              <div class="mt-4 rounded-xl bg-dls-hover border border-dls-border p-3 text-xs text-dls-secondary font-mono break-all">
                {uninstallTarget()?.path}
              </div>

              <div class="mt-6 flex justify-end gap-2">
                <Button variant="outline" onClick={() => setUninstallTarget(null)} disabled={props.busy}>
                  {translate("common.cancel")}
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    const target = uninstallTarget();
                    setUninstallTarget(null);
                    if (!target) return;
                    void Promise.resolve(props.deleteSkillInstance(target)).finally(() => {
                      props.refreshSkillInventory({ force: true });
                    });
                  }}
                  disabled={props.busy}
                >
                  {translate("skills.uninstall")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </Show>

      <Show when={shareOpen()}>
        <div class="fixed inset-0 z-50 bg-black/20 backdrop-blur-sm flex items-center justify-center p-4">
          <div class="bg-dls-surface border border-dls-border w-full max-w-md rounded-2xl shadow-2xl overflow-hidden">
            <div class="p-6 space-y-4">
              <div>
                <h3 class="text-lg font-semibold text-dls-text">{translate("skills.share_title")}</h3>
                <p class="text-sm text-dls-secondary mt-1">
                  {translate("skills.share_description")}
                </p>
              </div>

              <div class="rounded-xl border border-dls-border bg-dls-hover px-4 py-3 text-xs text-dls-secondary">
                <div class="font-semibold text-dls-text">{shareTarget()?.name}</div>
                <div class="mt-1 font-mono break-all">{translate("skills.publisher_label")} {DEFAULT_VESLO_PUBLISHER_BASE_URL}</div>
              </div>

              <Show when={shareError()}>
                <div class="rounded-xl border border-red-7/20 bg-red-1/40 px-4 py-3 text-xs text-red-12">
                  {shareError()}
                </div>
              </Show>

              <Show
                when={shareUrl()}
                fallback={
                  <div class="flex justify-end gap-2">
                    <Button variant="outline" onClick={closeShareLink} disabled={shareBusy()}>
                      {translate("common.cancel")}
                    </Button>
                    <Button variant="secondary" onClick={() => void publishShareLink()} disabled={shareBusy()}>
                      {shareBusy() ? translate("skills.publishing") : translate("skills.create_link")}
                    </Button>
                  </div>
                }
              >
                <div class="flex items-start gap-2 rounded-xl bg-dls-hover border border-dls-border p-3">
                  <div class="min-w-0 flex-1 text-xs text-dls-secondary font-mono break-all">{shareUrl()}</div>
                  <Button
                    variant="outline"
                    onClick={() => void copyShareLink()}
                    disabled={!shareUrl()}
                  >
                    <Copy size={14} />
                    {translate("skills.copy_link")}
                  </Button>
                </div>
                <div class="flex justify-end gap-2">
                  <Button variant="secondary" onClick={closeShareLink}>
                    {translate("skills.done")}
                  </Button>
                </div>
              </Show>
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
        onSelectTab={setSelectedDetailTab}
        onClose={() => setSelectedDetail(null)}
        actionUnavailableReason={{
          copy: selectedDetailGlobalTransferDisabledReason(),
          move: selectedDetailGlobalTransferDisabledReason(),
        }}
        onEditSkill={editSelectedSkill}
        onCopySkill={(input) => copySelectedSkillToGlobal(false, input)}
        onMoveSkill={(input) => copySelectedSkillToGlobal(true, input)}
        onPublishSkill={(action) => openSkillReviewDialog("organization", action)}
        onRequestApproval={(action) => openSkillReviewDialog("system", action)}
        onRestoreVersion={showRegistryActionPending}
        onDeleteSkill={requestDetailDelete}
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
            onReasonChange={setReviewReason}
            onClose={closeSkillReviewDialog}
            onRequestOrganizationPublish={() => {
              showRegistryActionPending();
              closeSkillReviewDialog();
            }}
            onRequestSystemApproval={() => {
              showRegistryActionPending();
              closeSkillReviewDialog();
            }}
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
