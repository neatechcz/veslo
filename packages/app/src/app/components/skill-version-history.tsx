import { For, Show, createMemo } from "solid-js";
import { RefreshCcw } from "lucide-solid";

import Button from "./button";
import { currentLocale, t } from "../../i18n";

export type SkillVersionApprovalStatus = "approved" | "pending" | "rejected";
export type SkillVersionTargetScope = "global" | "workspace" | "organization";

export type SkillVersionTargetMetadata = {
  id: string;
  label: string;
  scope: SkillVersionTargetScope;
  path?: string | null;
  workspaceId?: string | null;
  currentVersionId?: string | null;
};

export type SkillVersionRow = {
  id: string;
  version: string;
  createdAt: string;
  status: SkillVersionApprovalStatus;
  author?: string | null;
  notes?: string | null;
  packageHash?: string | null;
  target?: SkillVersionTargetMetadata | null;
  isCurrent?: boolean;
};

export type SkillVersionHistoryProps = {
  versions: SkillVersionRow[];
  targets?: SkillVersionTargetMetadata[];
  selectedVersionId?: string | null;
  selectedTargetId?: string | null;
  restoreDisabled?: boolean;
  emptyLabel?: string;
  onSelectVersion?: (version: SkillVersionRow) => void;
  onRestoreVersion?: (version: SkillVersionRow) => void;
  onSelectTarget?: (target: SkillVersionTargetMetadata) => void;
};

type SkillVersionTargetLabels = {
  noTarget: string;
  global: string;
  workspace: string;
  organization: string;
};

export const SKILL_VERSION_APPROVAL_STATUSES = ["approved", "pending", "rejected"] as const;

export function getSelectedSkillVersion(
  versions: readonly SkillVersionRow[],
  selectedVersionId?: string | null,
) {
  const selectedId = selectedVersionId?.trim();
  if (selectedId) {
    const selected = versions.find((version) => version.id === selectedId);
    if (selected) return selected;
  }
  return versions.find((version) => version.isCurrent) ?? versions[0] ?? null;
}

export function canRestoreSkillVersion(version: SkillVersionRow) {
  return version.status === "approved" && version.isCurrent !== true;
}

export function formatSkillPackageHash(packageHash?: string | null, fallback = t("skills.no_hash", currentLocale())) {
  const value = packageHash?.trim();
  if (!value) return fallback;
  if (value.length <= 28) return value;
  return `${value.slice(0, 16)}...${value.slice(-8)}`;
}

export function getSkillVersionTargetLabel(target?: SkillVersionTargetMetadata | null, labels?: SkillVersionTargetLabels) {
  if (!target) return labels?.noTarget ?? t("skills.no_target", currentLocale());
  switch (target.scope) {
    case "global":
      return `${labels?.global ?? t("session.capabilities_scope_global", currentLocale())}: ${target.label}`;
    case "workspace":
      return `${labels?.workspace ?? t("session.capabilities_scope_workspace", currentLocale())}: ${target.label}`;
    case "organization":
      return `${labels?.organization ?? t("skills.detail_scope_organization", currentLocale())}: ${target.label}`;
  }
}

function statusClass(status: SkillVersionApprovalStatus) {
  switch (status) {
    case "approved":
      return "border-green-6 bg-green-3 text-green-11";
    case "pending":
      return "border-amber-6 bg-amber-3 text-amber-11";
    case "rejected":
      return "border-red-6 bg-red-3 text-red-11";
  }
}

export default function SkillVersionHistory(props: SkillVersionHistoryProps) {
  const selectedVersion = createMemo(() => getSelectedSkillVersion(props.versions, props.selectedVersionId));
  const selectedTargetId = createMemo(() => props.selectedTargetId ?? props.targets?.[0]?.id ?? "");
  const translate = (key: string, replacements?: Record<string, string>) => {
    let value = t(key, currentLocale());
    if (!replacements) return value;
    for (const [name, replacement] of Object.entries(replacements)) {
      value = value.replace(`{${name}}`, replacement);
    }
    return value;
  };
  const targetLabels = createMemo<SkillVersionTargetLabels>(() => ({
    noTarget: translate("skills.detail_no_target"),
    global: translate("skills.detail_scope_global"),
    workspace: translate("skills.detail_scope_workspace"),
    organization: translate("skills.detail_scope_organization"),
  }));

  const statusLabel = (status: SkillVersionApprovalStatus) => {
    switch (status) {
      case "approved":
        return translate("skills.detail_status_approved");
      case "pending":
        return translate("skills.detail_status_pending");
      case "rejected":
        return translate("skills.detail_status_rejected");
    }
  };

  const handleTargetChange = (event: Event & { currentTarget: HTMLSelectElement }) => {
    const target = props.targets?.find((item) => item.id === event.currentTarget.value);
    if (target) props.onSelectTarget?.(target);
  };

  return (
    <section class="space-y-3" data-testid="skill-version-history">
      <Show when={(props.targets?.length ?? 0) > 0}>
        <label class="flex items-center gap-2 type-ui-sm text-dls-secondary">
          <span>{translate("skills.detail_target")}</span>
          <select
            class="min-w-0 flex-1 rounded-lg border border-dls-border bg-gray-2 px-2 py-1.5 type-ui-sm text-dls-text"
            aria-label={translate("skills.detail_version_target")}
            value={selectedTargetId()}
            onChange={handleTargetChange}
          >
            <For each={props.targets ?? []}>
              {(target) => (
                <option value={target.id}>
                  {getSkillVersionTargetLabel(target, targetLabels())}
                </option>
              )}
            </For>
          </select>
        </label>
      </Show>

      <Show
        when={props.versions.length > 0}
        fallback={<div class="rounded-lg border border-dls-border bg-gray-2 px-3 py-2 type-ui-sm text-dls-secondary">{props.emptyLabel ?? translate("skills.detail_no_versions")}</div>}
      >
        <div class="space-y-2" role="list" aria-label={translate("skills.detail_versions")}>
          <For each={props.versions}>
            {(version) => {
              const isSelected = () => selectedVersion()?.id === version.id;
              const restoreDisabled = () => props.restoreDisabled || !canRestoreSkillVersion(version);

              return (
                <article
                  classList={{
                    "border-dls-accent bg-[rgba(var(--dls-accent-rgb),0.06)]": isSelected(),
                    "border-dls-border bg-gray-2": !isSelected(),
                  }}
                  class="rounded-lg border px-3 py-2"
                  role="listitem"
                  data-skill-version-id={version.id}
                >
                  <div class="flex items-start justify-between gap-3">
                    <button
                      type="button"
                      class="min-w-0 flex-1 text-left"
                      aria-pressed={isSelected()}
                      onClick={() => props.onSelectVersion?.(version)}
                    >
                      <span class="flex items-center gap-2">
                        <span class="truncate type-ui-md font-semibold text-dls-text">{version.version}</span>
                        <span class={`rounded-full border px-2 py-0.5 type-ui-xs font-medium capitalize ${statusClass(version.status)}`}>
                          {statusLabel(version.status)}
                        </span>
                        <Show when={version.isCurrent}>
                          <span class="rounded-full border border-dls-border bg-gray-3 px-2 py-0.5 type-ui-xs text-dls-secondary">{translate("skills.detail_current")}</span>
                        </Show>
                      </span>
                      <span class="mt-1 block type-ui-sm text-dls-secondary">
                        {version.createdAt}
                        <Show when={version.author}>
                          {(author) => <span> {translate("skills.detail_by_author", { author: author() })}</span>}
                        </Show>
                      </span>
                    </button>

                    <Button
                      variant="ghost"
                      class="h-8 shrink-0 px-2 type-ui-sm"
                      disabled={restoreDisabled()}
                      aria-label={translate("skills.detail_restore_version", { version: version.version })}
                      onClick={() => props.onRestoreVersion?.(version)}
                    >
                      <RefreshCcw size={14} />
                      {translate("skills.detail_restore")}
                    </Button>
                  </div>

                  <dl class="mt-2 grid gap-2 type-ui-sm text-dls-secondary sm:grid-cols-2">
                    <div class="min-w-0">
                      <dt class="type-ui-xs uppercase text-dls-muted">{translate("skills.detail_package_hash")}</dt>
                      <dd class="truncate font-mono text-[12px] text-dls-text" title={version.packageHash ?? undefined}>
                        {formatSkillPackageHash(version.packageHash, translate("skills.detail_no_hash"))}
                      </dd>
                    </div>
                    <div class="min-w-0">
                      <dt class="type-ui-xs uppercase text-dls-muted">{translate("skills.detail_target")}</dt>
                      <dd class="truncate text-dls-text">{getSkillVersionTargetLabel(version.target, targetLabels())}</dd>
                    </div>
                  </dl>

                  <Show when={version.notes}>
                    {(notes) => <p class="mt-2 line-clamp-2 type-ui-sm text-dls-secondary">{notes()}</p>}
                  </Show>
                </article>
              );
            }}
          </For>
        </div>
      </Show>
    </section>
  );
}
