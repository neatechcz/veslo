import { For, Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { Copy, FileCode2, FileText, FolderTree, MapPin, MoveRight, RotateCcw, Send, ShieldCheck, Trash2, X } from "lucide-solid";

import Button from "./button";
import SkillVersionHistory, {
  formatSkillPackageHash,
  type SkillVersionRow,
  type SkillVersionTargetMetadata,
} from "./skill-version-history";
import { currentLocale, t } from "../../i18n";

export type SkillDetailTab = "overview" | "files" | "locations" | "versions" | "sharing" | "audit";

export const SKILL_DETAIL_TABS = [
  { id: "overview", labelKey: "skills.detail_tab_overview" },
  { id: "files", labelKey: "skills.detail_tab_files" },
  { id: "locations", labelKey: "skills.detail_tab_locations" },
  { id: "versions", labelKey: "skills.detail_tab_versions" },
  { id: "sharing", labelKey: "skills.detail_tab_sharing" },
  { id: "audit", labelKey: "skills.detail_tab_audit" },
] satisfies Array<{ id: SkillDetailTab; labelKey: string }>;

export type SkillDetailMetadata = {
  id: string;
  name: string;
  description?: string | null;
  trigger?: string | null;
  status?: string | null;
  source?: string | null;
  publisher?: string | null;
  approvalStatus?: "approved" | "pending" | "rejected" | null;
  currentVersionId?: string | null;
  packageHash?: string | null;
  updatedAt?: string | null;
};

export type SkillDetailAction = "copy" | "move" | "publish" | "requestApproval" | "restore" | "delete";

export type SkillDetailFile = {
  path: string;
  sizeBytes: number;
  mediaType: string;
  executable?: boolean;
  text?: string;
};

export type SkillDetailLocation = {
  id: string;
  label: string;
  scope: "global" | "workspace" | "organization" | "platform";
  path: string;
  writable?: boolean;
  active?: boolean;
  source?: string | null;
  lifecycle?: "active" | "removed";
  restoreAvailable?: boolean;
  restoreUnavailableReason?: string | null;
};

export type SkillAuditEntry = {
  id: string;
  action: string;
  createdAt: string;
  actor?: string | null;
  target?: string | null;
  details?: string | null;
};

export type SkillDetailActionInput = {
  skill: SkillDetailMetadata;
  location?: SkillDetailLocation | null;
};

export type SkillDetailDrawerProps = {
  open: boolean;
  skill: SkillDetailMetadata | null;
  locations?: SkillDetailLocation[];
  versions?: SkillVersionRow[];
  versionTargets?: SkillVersionTargetMetadata[];
  auditEntries?: SkillAuditEntry[];
  files?: SkillDetailFile[];
  filesLoading?: boolean;
  filesError?: string | null;
  selectedTab?: SkillDetailTab;
  selectedFilePath?: string | null;
  selectedVersionId?: string | null;
  selectedVersionTargetId?: string | null;
  actionPending?: Partial<Record<SkillDetailAction, boolean>>;
  actionUnavailableReason?: Partial<Record<SkillDetailAction, string | null | undefined>>;
  onSelectTab?: (tab: SkillDetailTab) => void;
  onSelectFile?: (file: SkillDetailFile) => void;
  onRetryFiles?: () => void;
  onSelectVersion?: (version: SkillVersionRow) => void;
  onSelectVersionTarget?: (target: SkillVersionTargetMetadata) => void;
  onClose: () => void;
  onEditSkill?: (input: SkillDetailActionInput) => void;
  onCopySkill?: (input: SkillDetailActionInput) => void;
  onMoveSkill?: (input: SkillDetailActionInput) => void;
  onCopyToWorkspaceSkill?: (input: SkillDetailActionInput) => void;
  onPublishSkill?: (input: SkillDetailActionInput) => void;
  onRequestApproval?: (input: SkillDetailActionInput) => void;
  onRestoreSkill?: (input: SkillDetailActionInput) => void;
  onRestoreVersion?: (version: SkillVersionRow) => void;
  onDeleteSkill?: (input: SkillDetailActionInput) => void;
};

const titleId = "skill-detail-drawer-title";

function fieldValue(value: string | null | undefined, fallback: string) {
  const normalized = value?.trim();
  return normalized || fallback;
}

function fileBaseName(path: string) {
  return path.split("/").filter(Boolean).pop() || path;
}

function formatFileSize(bytes: number) {
  if (!Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function isCodeLikeFile(file: SkillDetailFile) {
  return file.mediaType.startsWith("text/") ||
    file.mediaType === "application/json" ||
    file.mediaType === "application/yaml" ||
    file.mediaType === "image/svg+xml";
}

export default function SkillDetailDrawer(props: SkillDetailDrawerProps) {
  const [localTab, setLocalTab] = createSignal<SkillDetailTab>("overview");
  const activeTab = createMemo(() => props.selectedTab ?? localTab());
  const translate = (key: string) => t(key, currentLocale());

  const selectTab = (tab: SkillDetailTab) => {
    setLocalTab(tab);
    props.onSelectTab?.(tab);
  };

  const actionInput = (skill: SkillDetailMetadata, location?: SkillDetailLocation | null): SkillDetailActionInput => ({
    skill,
    location: location ?? null,
  });
  const actionUnavailableReason = (action: SkillDetailAction) => props.actionUnavailableReason?.[action] ?? null;
  const actionDisabled = (action: SkillDetailAction) =>
    Boolean(props.actionPending?.[action]) || Boolean(actionUnavailableReason(action));
  const actionTitle = (action: SkillDetailAction, labelKey: string) => actionUnavailableReason(action) ?? translate(labelKey);
  const activeLocation = createMemo(() => props.locations?.find((location) => location.active) ?? null);
  const showOverviewRestoreAction = createMemo(() =>
    Boolean(props.onRestoreSkill && activeLocation()?.lifecycle === "removed" && activeLocation()?.restoreAvailable)
  );
  const selectedFile = createMemo(() => {
    const files = props.files ?? [];
    if (files.length === 0) return null;
    const selectedPath = props.selectedFilePath?.trim();
    return files.find((file) => file.path === selectedPath) ?? files.find((file) => file.path === "SKILL.md") ?? files[0] ?? null;
  });

  const scopeLabel = (scope: SkillDetailLocation["scope"]) => {
    switch (scope) {
      case "global":
        return translate("skills.detail_scope_global");
      case "workspace":
        return translate("skills.detail_scope_workspace");
      case "organization":
        return translate("skills.detail_scope_organization");
      case "platform":
        return translate("skills.detail_scope_platform");
    }
  };

  const closeFromBackdrop = (event: MouseEvent & { currentTarget: HTMLDivElement; target: Element }) => {
    if (event.target === event.currentTarget) props.onClose();
  };

  createEffect(() => {
    if (!props.open) return;
    const closeFromEscape = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key !== "Escape") return;
      if (document.querySelector("[data-modal-shell-root]")) return;
      event.preventDefault();
      props.onClose();
    };
    window.addEventListener("keydown", closeFromEscape);
    onCleanup(() => window.removeEventListener("keydown", closeFromEscape));
  });

  return (
    <Show when={props.open ? props.skill : null} keyed>
      {(skill) => (
        <div
          class="fixed inset-0 z-50 flex justify-end bg-gray-1/60 backdrop-blur-sm"
          data-testid="skill-detail-drawer-backdrop"
          onClick={closeFromBackdrop}
        >
          <aside
            class="flex h-full w-full max-w-[560px] flex-col border-l border-dls-border bg-gray-1 shadow-2xl"
            data-testid="skill-detail-drawer"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <header class="border-b border-dls-border px-4 pb-3 pt-10">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="type-ui-xs uppercase text-dls-muted">{translate("skills.detail_type")}</p>
                  <h2 id={titleId} class="truncate type-heading-sm text-dls-text">
                    {skill.name}
                  </h2>
                </div>
                <button
                  type="button"
                  class="rounded-lg p-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
                  aria-label={translate("skills.detail_close")}
                  onClick={props.onClose}
                >
                  <X size={18} />
                </button>
              </div>

              <nav class="mt-3 flex gap-1 overflow-x-auto" aria-label={translate("skills.detail_sections")}>
                <For each={SKILL_DETAIL_TABS}>
                  {(tab) => (
                    <button
                      type="button"
                      classList={{
                        "border-[var(--dls-accent-border)] bg-[var(--dls-accent-tint)] text-dls-text": activeTab() === tab.id,
                        "border-transparent bg-transparent text-[var(--dls-button-ghost)] hover:bg-[var(--dls-accent-tint)] hover:text-dls-accent": activeTab() !== tab.id,
                      }}
                      class="shrink-0 rounded-[var(--dls-radius)] border px-3 py-1.5 type-ui-sm font-medium"
                      aria-current={activeTab() === tab.id ? "page" : undefined}
                      onClick={() => selectTab(tab.id)}
                    >
                      {translate(tab.labelKey)}
                    </button>
                  )}
                </For>
              </nav>
            </header>

            <div class="flex-1 overflow-y-auto px-4 py-4">
              <Switch>
                <Match when={activeTab() === "overview"}>
                  <section class="space-y-4" aria-label={translate("skills.detail_overview")}>
                    <div class="grid gap-3 rounded-lg border border-dls-border bg-gray-2 p-3">
                      <dl class="grid gap-3 type-ui-sm sm:grid-cols-2">
                        <div class="min-w-0">
                          <dt class="type-ui-xs uppercase text-dls-muted">{translate("skills.detail_description")}</dt>
                          <dd class="line-clamp-3 text-dls-text">{fieldValue(skill.description, translate("skills.detail_not_set"))}</dd>
                        </div>
                        <div class="min-w-0">
                          <dt class="type-ui-xs uppercase text-dls-muted">{translate("skills.detail_trigger")}</dt>
                          <dd class="truncate font-mono text-[12px] text-dls-text">{fieldValue(skill.trigger, translate("skills.detail_not_set"))}</dd>
                        </div>
                        <div class="min-w-0">
                          <dt class="type-ui-xs uppercase text-dls-muted">{translate("skills.detail_status")}</dt>
                          <dd class="truncate text-dls-text">{fieldValue(skill.status ?? skill.approvalStatus, translate("skills.detail_not_set"))}</dd>
                        </div>
                        <div class="min-w-0">
                          <dt class="type-ui-xs uppercase text-dls-muted">{translate("skills.detail_package_hash")}</dt>
                          <dd class="truncate font-mono text-[12px] text-dls-text" title={skill.packageHash ?? undefined}>
                            {formatSkillPackageHash(skill.packageHash, translate("skills.detail_no_hash"))}
                          </dd>
                        </div>
                      </dl>
                    </div>

                    <div class="flex flex-wrap gap-2">
                      <Show when={props.onEditSkill}>
                        <Button
                          variant="outline"
                          class="h-9 px-3 type-ui-sm"
                          onClick={() => props.onEditSkill?.(actionInput(skill))}
                        >
                          {translate("skills.detail_edit")}
                        </Button>
                      </Show>
                      <Show when={props.onCopySkill}>
                        <Button
                          variant="outline"
                          class="h-9 px-3 type-ui-sm"
                          disabled={actionDisabled("copy")}
                          title={actionTitle("copy", "skills.detail_copy_to_global")}
                          onClick={() => props.onCopySkill?.(actionInput(skill))}
                        >
                          <Copy size={14} />
                          {translate("skills.detail_copy_to_global")}
                        </Button>
                      </Show>
                      <Show when={props.onCopyToWorkspaceSkill}>
                        <Button
                          variant="outline"
                          class="h-9 px-3 type-ui-sm"
                          data-testid="skill-detail-install-workspace-button"
                          onClick={() => props.onCopyToWorkspaceSkill?.(actionInput(skill))}
                        >
                          <Copy size={14} />
                          {translate("skills.detail_copy_to_workspace")}
                        </Button>
                      </Show>
                      <Show when={props.onMoveSkill}>
                        <Button
                          variant="outline"
                          class="h-9 px-3 type-ui-sm"
                          disabled={actionDisabled("move")}
                          title={actionTitle("move", "skills.detail_move_to_global")}
                          onClick={() => props.onMoveSkill?.(actionInput(skill))}
                        >
                          <MoveRight size={14} />
                          {translate("skills.detail_move_to_global")}
                        </Button>
                      </Show>
                      <Show when={props.onPublishSkill}>
                        <Button
                          variant="outline"
                          class="h-9 px-3 type-ui-sm"
                          disabled={props.actionPending?.publish}
                          onClick={() => props.onPublishSkill?.(actionInput(skill))}
                        >
                          <Send size={14} />
                          {translate("skills.detail_publish_organization")}
                        </Button>
                      </Show>
                      <Show when={props.onRequestApproval}>
                        <Button
                          variant="outline"
                          class="h-9 px-3 type-ui-sm"
                          disabled={props.actionPending?.requestApproval}
                          onClick={() => props.onRequestApproval?.(actionInput(skill))}
                        >
                          <ShieldCheck size={14} />
                          {translate("skills.detail_request_system_approval")}
                        </Button>
                      </Show>
                      <Show when={showOverviewRestoreAction()}>
                        <Button
                          variant="outline"
                          class="h-9 px-3 type-ui-sm"
                          disabled={actionDisabled("restore")}
                          title={actionTitle("restore", "skills.restore_skill")}
                          onClick={() => props.onRestoreSkill?.(actionInput(skill, activeLocation()))}
                        >
                          <RotateCcw size={14} />
                          {translate("skills.restore_skill")}
                        </Button>
                      </Show>
                      <Show when={props.onDeleteSkill}>
                        <Button
                          variant="danger"
                          class="h-9 px-3 type-ui-sm"
                          disabled={actionDisabled("delete")}
                          title={actionTitle("delete", "skills.detail_delete")}
                          onClick={() => props.onDeleteSkill?.(actionInput(skill))}
                        >
                          <Trash2 size={14} />
                          {translate("skills.detail_delete")}
                        </Button>
                      </Show>
                    </div>
                  </section>
                </Match>

                <Match when={activeTab() === "files"}>
                  <section
                    class="space-y-3"
                    aria-label={translate("skills.detail_files")}
                    data-testid="skill-detail-files-tab"
                    data-extend-ui="file-system-block"
                  >
                    <Show when={props.filesLoading}>
                      <div class="rounded-lg border border-dls-border bg-gray-2 px-3 py-2 type-ui-sm text-dls-secondary">
                        {translate("skills.detail_files_loading")}
                      </div>
                    </Show>
                    <Show when={!props.filesLoading && props.filesError}>
                      {(error) => (
                        <div class="rounded-lg border border-red-8/40 bg-red-3/20 px-3 py-2">
                          <p class="type-ui-sm text-red-11">{error()}</p>
                          <Show when={props.onRetryFiles}>
                            <Button
                              variant="outline"
                              class="mt-2 h-8 px-2 type-ui-xs"
                              onClick={() => props.onRetryFiles?.()}
                            >
                              <RotateCcw size={13} />
                              {translate("skills.detail_files_retry")}
                            </Button>
                          </Show>
                        </div>
                      )}
                    </Show>
                    <Show
                      when={!props.filesLoading && !props.filesError && (props.files?.length ?? 0) > 0}
                      fallback={
                        <Show when={!props.filesLoading && !props.filesError}>
                          <div class="rounded-lg border border-dls-border bg-gray-2 px-3 py-2 type-ui-sm text-dls-secondary">
                            {translate("skills.detail_files_empty")}
                          </div>
                        </Show>
                      }
                    >
                      <div class="grid min-h-[360px] gap-3">
                        <div class="min-h-0 rounded-lg border border-dls-border bg-gray-2" aria-label={translate("skills.detail_files")}>
                          <div class="flex items-center gap-2 border-b border-dls-border px-3 py-2 type-ui-xs uppercase text-dls-muted">
                            <FolderTree size={13} />
                            {translate("skills.detail_files")}
                          </div>
                          <div class="max-h-[180px] overflow-y-auto p-1">
                            <For each={props.files ?? []}>
                              {(file) => {
                                const selected = createMemo(() => selectedFile()?.path === file.path);
                                return (
                                  <button
                                    type="button"
                                    classList={{
                                      "bg-dls-hover text-dls-text": selected(),
                                      "text-dls-secondary hover:bg-dls-hover hover:text-dls-text": !selected(),
                                    }}
                                    class="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left type-ui-sm"
                                    aria-current={selected() ? "true" : undefined}
                                    title={file.path}
                                    data-testid="skill-detail-file-row"
                                    onClick={() => props.onSelectFile?.(file)}
                                  >
                                    <Show when={isCodeLikeFile(file)} fallback={<FileText size={14} class="shrink-0 text-dls-muted" />}>
                                      <FileCode2 size={14} class="shrink-0 text-dls-muted" />
                                    </Show>
                                    <span class="min-w-0 flex-1 truncate">{fileBaseName(file.path)}</span>
                                    <span class="shrink-0 type-ui-xs text-dls-muted">{formatFileSize(file.sizeBytes)}</span>
                                  </button>
                                );
                              }}
                            </For>
                          </div>
                        </div>
                        <Show when={selectedFile()} keyed>
                          {(file) => (
                            <article class="min-w-0 overflow-hidden rounded-lg border border-dls-border bg-gray-2" data-testid="skill-detail-file-preview">
                              <div class="border-b border-dls-border px-3 py-2">
                                <h3 class="truncate type-ui-sm font-semibold text-dls-text" title={file.path}>{file.path}</h3>
                                <p class="truncate type-ui-xs text-dls-muted">
                                  {file.mediaType} / {formatFileSize(file.sizeBytes)}
                                  <Show when={file.executable}> / {translate("skills.detail_files_executable")}</Show>
                                </p>
                              </div>
                              <Show
                                when={file.text !== undefined}
                                fallback={
                                  <div class="px-3 py-8 text-center type-ui-sm text-dls-secondary">
                                    {translate("skills.detail_files_binary_unavailable")}
                                  </div>
                                }
                              >
                                <pre class="max-h-[520px] overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-[12px] leading-5 text-dls-text">
                                  <code>{file.text}</code>
                                </pre>
                              </Show>
                            </article>
                          )}
                        </Show>
                      </div>
                    </Show>
                  </section>
                </Match>

                <Match when={activeTab() === "locations"}>
                  <section class="space-y-2" aria-label={translate("skills.detail_locations")}>
                    <Show
                      when={(props.locations?.length ?? 0) > 0}
                      fallback={<div class="rounded-lg border border-dls-border bg-gray-2 px-3 py-2 type-ui-sm text-dls-secondary">{translate("skills.detail_no_locations")}</div>}
                    >
                      <For each={props.locations ?? []}>
                        {(location) => (
                          <article
                            class="rounded-lg border border-dls-border bg-gray-2 p-3"
                            data-testid="skill-detail-location"
                            data-skill-detail-location-lifecycle={location.lifecycle ?? "active"}
                            data-skill-detail-location-scope={location.scope}
                          >
                            <div class="flex items-start justify-between gap-3">
                              <div class="min-w-0">
                                <div class="flex items-center gap-2">
                                  <MapPin size={14} class="text-dls-secondary" />
                                  <h3 class="truncate type-ui-md font-semibold text-dls-text">{location.label}</h3>
                                  <span class="rounded-full border border-dls-border px-2 py-0.5 type-ui-xs capitalize text-dls-secondary">
                                    {scopeLabel(location.scope)}
                                  </span>
                                  <Show when={location.lifecycle === "removed"}>
                                    <span class="rounded-full border border-amber-7/40 bg-amber-3/20 px-2 py-0.5 type-ui-xs text-amber-11">
                                      {translate("skills.removed_status")}
                                    </span>
                                  </Show>
                                </div>
                                <p class="mt-1 truncate font-mono text-[12px] text-dls-secondary" title={location.path}>
                                  {location.path}
                                </p>
                              </div>
                              <Show when={props.onRestoreSkill && location.lifecycle === "removed" && location.restoreAvailable}>
                                <Button
                                  variant="outline"
                                  class="h-8 shrink-0 px-2 type-ui-xs"
                                  disabled={Boolean(location.restoreUnavailableReason)}
                                  title={location.restoreUnavailableReason ?? translate("skills.restore_skill")}
                                  onClick={() => props.onRestoreSkill?.(actionInput(skill, location))}
                                >
                                  <RotateCcw size={13} />
                                  {translate("skills.restore_skill")}
                                </Button>
                              </Show>
                            </div>
                          </article>
                        )}
                      </For>
                    </Show>
                  </section>
                </Match>

                <Match when={activeTab() === "versions"}>
                  <SkillVersionHistory
                    versions={props.versions ?? []}
                    targets={props.versionTargets}
                    selectedVersionId={props.selectedVersionId}
                    selectedTargetId={props.selectedVersionTargetId}
                    restoreDisabled={props.actionPending?.restore}
                    onSelectVersion={props.onSelectVersion}
                    onRestoreVersion={props.onRestoreVersion}
                    onSelectTarget={props.onSelectVersionTarget}
                  />
                </Match>

                <Match when={activeTab() === "sharing"}>
                  <section class="space-y-3" aria-label={translate("skills.detail_sharing")}>
                    <dl class="grid gap-3 rounded-lg border border-dls-border bg-gray-2 p-3 type-ui-sm sm:grid-cols-2">
                      <div class="min-w-0">
                        <dt class="type-ui-xs uppercase text-dls-muted">{translate("skills.detail_publisher")}</dt>
                        <dd class="truncate text-dls-text">{fieldValue(skill.publisher, translate("skills.detail_not_set"))}</dd>
                      </div>
                      <div class="min-w-0">
                        <dt class="type-ui-xs uppercase text-dls-muted">{translate("skills.detail_approval")}</dt>
                        <dd class="truncate text-dls-text">{fieldValue(skill.approvalStatus, translate("skills.detail_not_set"))}</dd>
                      </div>
                    </dl>
                    <div class="flex flex-wrap gap-2">
                      <Show when={props.onPublishSkill}>
                        <Button
                          variant="outline"
                          class="h-9 px-3 type-ui-sm"
                          disabled={props.actionPending?.publish}
                          onClick={() => props.onPublishSkill?.(actionInput(skill))}
                        >
                          <Send size={14} />
                          {translate("skills.detail_publish_organization")}
                        </Button>
                      </Show>
                      <Show when={props.onRequestApproval}>
                        <Button
                          variant="outline"
                          class="h-9 px-3 type-ui-sm"
                          disabled={props.actionPending?.requestApproval}
                          onClick={() => props.onRequestApproval?.(actionInput(skill))}
                        >
                          <ShieldCheck size={14} />
                          {translate("skills.detail_request_system_approval")}
                        </Button>
                      </Show>
                    </div>
                  </section>
                </Match>

                <Match when={activeTab() === "audit"}>
                  <section class="space-y-2" aria-label={translate("skills.detail_audit")}>
                    <Show
                      when={(props.auditEntries?.length ?? 0) > 0}
                      fallback={<div class="rounded-lg border border-dls-border bg-gray-2 px-3 py-2 type-ui-sm text-dls-secondary">{translate("skills.detail_no_audit_entries")}</div>}
                    >
                      <For each={props.auditEntries ?? []}>
                        {(entry) => (
                          <article class="rounded-lg border border-dls-border bg-gray-2 px-3 py-2">
                            <div class="flex items-start justify-between gap-3">
                              <div class="min-w-0">
                                <h3 class="truncate type-ui-md font-semibold text-dls-text">{entry.action}</h3>
                                <p class="truncate type-ui-sm text-dls-secondary">{fieldValue(entry.details ?? entry.target, translate("skills.detail_not_set"))}</p>
                              </div>
                              <time class="shrink-0 type-ui-xs text-dls-muted">{entry.createdAt}</time>
                            </div>
                            <Show when={entry.actor}>
                              {(actor) => <p class="mt-1 type-ui-xs text-dls-muted">{actor()}</p>}
                            </Show>
                          </article>
                        )}
                      </For>
                    </Show>
                  </section>
                </Match>
              </Switch>
            </div>
          </aside>
        </div>
      )}
    </Show>
  );
}
