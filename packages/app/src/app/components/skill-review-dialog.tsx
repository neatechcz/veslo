import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { AlertTriangle, Check, FileCode, GitCompare, Send, ShieldCheck, X } from "lucide-solid";

import Button from "./button";
import ModalShell from "./modal-shell";
import { currentLocale, t } from "../../i18n";

export type SkillReviewTargetScope = "organization" | "system";
export type SkillReviewMode = "request" | "review";
export type SkillReviewDecision = "approve" | "reject";
export type SkillReviewFileDiffKind = "added" | "modified" | "removed" | "unchanged";

export type SkillReviewMetadataDiff = {
  field: string;
  before?: string | null;
  after?: string | null;
};

export type SkillReviewFileDiff = {
  path: string;
  kind: SkillReviewFileDiffKind;
  sizeBytes?: number | null;
  executable?: boolean;
};

export type SkillReviewWarning = {
  id: string;
  label: string;
  detail?: string | null;
  severity?: "info" | "warning" | "danger";
};

export type SkillReviewActionInput = {
  skillId: string;
  versionId: string;
  targetScope: SkillReviewTargetScope;
  reason: string;
  decision?: SkillReviewDecision;
};

export type SkillReviewDialogProps = {
  open: boolean;
  mode: SkillReviewMode;
  skillId: string;
  versionId: string;
  skillName: string;
  versionLabel?: string | null;
  targetScope: SkillReviewTargetScope;
  targetLabel?: string | null;
  metadataDiff?: SkillReviewMetadataDiff[];
  fileDiffs?: SkillReviewFileDiff[];
  warnings?: SkillReviewWarning[];
  reason?: string;
  pending?: boolean;
  onClose: () => void;
  onReasonChange?: (reason: string) => void;
  onRequestOrganizationPublish?: (input: SkillReviewActionInput) => void;
  onRequestSystemApproval?: (input: SkillReviewActionInput) => void;
  onApproveOrganizationVersion?: (input: SkillReviewActionInput) => void;
  onRejectOrganizationVersion?: (input: SkillReviewActionInput) => void;
  onApproveSystemVersion?: (input: SkillReviewActionInput) => void;
  onRejectSystemVersion?: (input: SkillReviewActionInput) => void;
};

const titleId = "skill-review-dialog-title";
const descriptionId = "skill-review-dialog-description";

export function isMarkdownFile(path: string) {
  return /\.mdx?$/i.test(path);
}

export function isScriptFile(path: string) {
  return /(^|\/)(scripts?|bin)\//i.test(path) || /\.(sh|bash|zsh|fish|ps1|cmd|bat|js|mjs|cjs|ts|tsx|py|rb|pl)$/i.test(path);
}

function formatValue(value: string | null | undefined, fallback: string) {
  const normalized = value?.trim();
  return normalized || fallback;
}

function formatBytes(sizeBytes?: number | null) {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes)) return "";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 102.4) / 10} KB`;
  return `${Math.round(sizeBytes / 1024 / 102.4) / 10} MB`;
}

function scopeLabel(scope: SkillReviewTargetScope, translate: (key: string) => string) {
  return scope === "organization" ? translate("skills.detail_scope_organization") : translate("skills.review_scope_system");
}

function fileKindClass(kind: SkillReviewFileDiffKind) {
  switch (kind) {
    case "added":
      return "border-green-6 bg-green-3 text-green-11";
    case "modified":
      return "border-amber-6 bg-amber-3 text-amber-11";
    case "removed":
      return "border-red-6 bg-red-3 text-red-11";
    case "unchanged":
      return "border-dls-border bg-gray-3 text-dls-secondary";
  }
}

function createFileWarnings(
  fileDiffs: readonly SkillReviewFileDiff[],
  labels: { nonMarkdown: string; executable: string; scriptPath: string },
) {
  return fileDiffs.flatMap((file) => {
    const warnings: SkillReviewWarning[] = [];
    if (!isMarkdownFile(file.path)) {
      warnings.push({
        id: `non-markdown:${file.path}`,
        label: labels.nonMarkdown,
        detail: file.path,
        severity: isScriptFile(file.path) ? "warning" : "info",
      });
    }
    if (file.executable) {
      warnings.push({
        id: `executable:${file.path}`,
        label: labels.executable,
        detail: file.path,
        severity: "danger",
      });
    }
    if (isScriptFile(file.path)) {
      warnings.push({
        id: `script:${file.path}`,
        label: labels.scriptPath,
        detail: file.path,
        severity: "warning",
      });
    }
    return warnings;
  });
}

function warningClass(severity: SkillReviewWarning["severity"]) {
  switch (severity) {
    case "danger":
      return "border-red-6 bg-red-3 text-red-11";
    case "warning":
      return "border-amber-6 bg-amber-3 text-amber-11";
    case "info":
    default:
      return "border-dls-border bg-gray-3 text-dls-secondary";
  }
}

export default function SkillReviewDialog(props: SkillReviewDialogProps) {
  const [localReason, setLocalReason] = createSignal(props.reason ?? "");
  const translate = (key: string) => t(key, currentLocale());
  const reason = createMemo(() => props.reason ?? localReason());
  const metadataDiff = createMemo(() => props.metadataDiff ?? []);
  const fileDiffs = createMemo(() => props.fileDiffs ?? []);
  const executableWarnings = createMemo(() => [
    ...createFileWarnings(fileDiffs(), {
      nonMarkdown: translate("skills.review_non_markdown"),
      executable: translate("skills.review_executable"),
      scriptPath: translate("skills.review_script_path"),
    }),
    ...(props.warnings ?? []),
  ]);

  const updateReason = (event: Event & { currentTarget: HTMLTextAreaElement }) => {
    const value = event.currentTarget.value;
    setLocalReason(value);
    props.onReasonChange?.(value);
  };

  const actionInput = (decision?: SkillReviewDecision): SkillReviewActionInput => ({
    skillId: props.skillId,
    versionId: props.versionId,
    targetScope: props.targetScope,
    reason: reason().trim(),
    decision,
  });

  const requestLabel = () =>
    props.targetScope === "organization"
      ? translate("skills.review_request_organization_publish")
      : translate("skills.review_request_system_approval");

  const approveLabel = () =>
    props.targetScope === "organization"
      ? translate("skills.review_approve_organization_version")
      : translate("skills.review_approve_system_version");

  const rejectLabel = () =>
    props.targetScope === "organization"
      ? translate("skills.review_reject_organization_version")
      : translate("skills.review_reject_system_version");

  const targetScopeDescription = () =>
    props.targetScope === "organization"
      ? translate("skills.review_organization_publish_description")
      : translate("skills.review_system_approval_description");

  const requestDisabled = () =>
    props.pending ||
    (props.targetScope === "organization" ? !props.onRequestOrganizationPublish : !props.onRequestSystemApproval);

  const approveDisabled = () =>
    props.pending ||
    (props.targetScope === "organization" ? !props.onApproveOrganizationVersion : !props.onApproveSystemVersion);

  const rejectDisabled = () =>
    props.pending ||
    (props.targetScope === "organization" ? !props.onRejectOrganizationVersion : !props.onRejectSystemVersion);

  const submitRequest = () => {
    if (props.targetScope === "organization") {
      props.onRequestOrganizationPublish?.(actionInput());
    } else {
      props.onRequestSystemApproval?.(actionInput());
    }
  };

  const approve = () => {
    if (props.targetScope === "organization") {
      props.onApproveOrganizationVersion?.(actionInput("approve"));
    } else {
      props.onApproveSystemVersion?.(actionInput("approve"));
    }
  };

  const reject = () => {
    if (props.targetScope === "organization") {
      props.onRejectOrganizationVersion?.(actionInput("reject"));
    } else {
      props.onRejectSystemVersion?.(actionInput("reject"));
    }
  };

  return (
    <ModalShell
      open={props.open}
      onClose={props.onClose}
      size="lg"
      align="start"
      ariaLabelledBy={titleId}
      ariaDescribedBy={descriptionId}
      class="max-w-6xl rounded-lg bg-gray-1"
    >
      <div data-testid="skill-review-dialog" class="flex max-h-[82vh] flex-col">
        <header class="border-b border-dls-border px-5 py-4">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p id={descriptionId} class="type-ui-xs uppercase text-dls-muted">
                {props.mode === "request" ? translate("skills.review_publish_request") : translate("skills.review_approval_review")}
              </p>
              <h2 id={titleId} class="mt-0.5 truncate type-heading-sm text-dls-text">
                {props.skillName}
              </h2>
              <p class="mt-1 max-w-2xl type-ui-sm text-dls-secondary">
                {translate("skills.review_request_intro")}
              </p>
              <div class="mt-3 flex flex-wrap items-center gap-2 type-ui-xs text-dls-secondary">
                <span class="rounded-full border border-dls-border bg-gray-2 px-2 py-0.5">
                  {props.versionLabel ?? props.versionId}
                </span>
                <span class="rounded-full border border-dls-border bg-gray-2 px-2 py-0.5">
                  {scopeLabel(props.targetScope, translate)}
                </span>
              </div>
            </div>
            <button
              type="button"
              class="rounded-lg p-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              aria-label={translate("skills.review_close")}
              onClick={props.onClose}
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <div class="space-y-4">
            <section class="rounded-lg border border-dls-border bg-gray-2 p-3 shadow-[inset_3px_0_0_var(--dls-accent)]" aria-label={translate("skills.review_target_scope")}>
              <div class="grid gap-3 md:grid-cols-[minmax(0,1fr)_220px]">
                <div class="min-w-0">
                  <h3 class="type-ui-sm font-semibold text-dls-text">{translate("skills.review_target_scope")}</h3>
                  <p class="mt-1 type-ui-sm text-dls-secondary">{targetScopeDescription()}</p>
                </div>
                <dl class="grid min-w-0 grid-cols-2 gap-3 rounded border border-dls-border bg-gray-1 px-3 py-2 type-ui-sm md:grid-cols-1">
                  <div class="min-w-0">
                    <dt class="type-ui-xs uppercase text-dls-muted">{translate("skills.review_scope")}</dt>
                    <dd class="truncate text-dls-text">{scopeLabel(props.targetScope, translate)}</dd>
                  </div>
                  <div class="min-w-0">
                    <dt class="type-ui-xs uppercase text-dls-muted">{translate("skills.review_target")}</dt>
                    <dd class="truncate text-dls-text" title={props.targetLabel ?? undefined}>
                      {props.targetLabel ?? scopeLabel(props.targetScope, translate)}
                    </dd>
                  </div>
                </dl>
              </div>
            </section>

            <div class="grid gap-4 xl:grid-cols-[minmax(560px,1fr)_320px]">
            <div class="min-w-0 space-y-4">
              <section class="rounded-lg border border-dls-border bg-gray-2 p-3" aria-label={translate("skills.review_metadata_diff")}>
                <div class="mb-2 flex items-center gap-2">
                  <GitCompare size={15} class="text-dls-secondary" />
                  <h3 class="type-ui-sm font-semibold text-dls-text">{translate("skills.review_metadata_diff")}</h3>
                </div>
                <Show
                  when={metadataDiff().length > 0}
                  fallback={<p class="type-ui-sm text-dls-secondary">{translate("skills.review_no_metadata_changes")}</p>}
                >
                  <dl class="space-y-2">
                    <For each={metadataDiff()}>
                      {(item) => (
                        <div class="rounded border border-dls-border bg-gray-1 px-3 py-2 type-ui-sm">
                          <dt class="type-ui-xs uppercase text-dls-muted">{item.field}</dt>
                          <dd class="mt-2 grid min-w-0 gap-2 sm:grid-cols-2">
                            <div class="min-w-0 rounded border border-dls-border bg-gray-2 px-2 py-1.5">
                              <div class="type-ui-xs uppercase text-dls-muted">{translate("skills.review_previous_value")}</div>
                              <div class="mt-0.5 truncate text-dls-secondary" title={item.before ?? undefined}>
                                {formatValue(item.before, translate("skills.review_field_not_set"))}
                              </div>
                            </div>
                            <div class="min-w-0 rounded border border-blue-6 bg-blue-2 px-2 py-1.5">
                              <div class="type-ui-xs uppercase text-blue-10">{translate("skills.review_current_value")}</div>
                              <div class="mt-0.5 truncate text-dls-text" title={item.after ?? undefined}>
                                {formatValue(item.after, translate("skills.review_field_not_set"))}
                              </div>
                            </div>
                          </dd>
                        </div>
                      )}
                    </For>
                  </dl>
                </Show>
              </section>

              <section class="rounded-lg border border-dls-border bg-gray-2 p-3" aria-label={translate("skills.review_file_tree_diff")}>
                <div class="mb-2 flex items-center gap-2">
                  <FileCode size={15} class="text-dls-secondary" />
                  <h3 class="type-ui-sm font-semibold text-dls-text">{translate("skills.review_file_tree_diff")}</h3>
                </div>
                <Show
                  when={fileDiffs().length > 0}
                  fallback={<p class="type-ui-sm text-dls-secondary">{translate("skills.review_no_file_changes")}</p>}
                >
                  <div class="space-y-1" role="list">
                    <For each={fileDiffs()}>
                      {(file) => (
                        <div class="grid grid-cols-[104px_minmax(0,1fr)_auto] items-center gap-2 rounded border border-dls-border bg-gray-1 px-2 py-1.5 type-ui-sm" role="listitem">
                          <span class={`rounded-full border px-2 py-0.5 text-center type-ui-xs capitalize ${fileKindClass(file.kind)}`}>
                            {translate(`skills.review_file_kind_${file.kind}`)}
                          </span>
                          <span class="min-w-0 truncate font-mono text-[12px] text-dls-text" title={file.path}>
                            {file.path}
                          </span>
                          <span class="flex items-center gap-1 text-[11px] text-dls-muted">
                            <Show when={!isMarkdownFile(file.path)}>
                              <span>{translate("skills.review_non_markdown")}</span>
                            </Show>
                            <Show when={file.executable}>
                              <span>{translate("skills.review_executable")}</span>
                            </Show>
                            <Show when={formatBytes(file.sizeBytes)}>
                              {(size) => <span>{size()}</span>}
                            </Show>
                          </span>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </section>
            </div>

            <aside class="min-w-0 space-y-4">
              <section class="rounded-lg border border-dls-border bg-gray-2 p-3" aria-label={translate("skills.review_warnings")}>
                <div class="mb-2 flex items-center gap-2">
                  <AlertTriangle size={15} class="text-dls-secondary" />
                  <h3 class="type-ui-sm font-semibold text-dls-text">{translate("skills.review_warnings")}</h3>
                </div>
                <Show
                  when={executableWarnings().length > 0}
                  fallback={<p class="type-ui-sm text-dls-secondary">{translate("skills.review_no_warnings")}</p>}
                >
                  <div class="space-y-1">
                    <For each={executableWarnings()}>
                      {(warning) => (
                        <div class={`rounded border px-2 py-1.5 type-ui-sm ${warningClass(warning.severity)}`}>
                          <div class="font-medium">{warning.label}</div>
                          <Show when={warning.detail}>
                            {(detail) => <div class="truncate font-mono text-[11px]" title={detail()}>{detail()}</div>}
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
              </section>

              <section class="rounded-lg border border-dls-border bg-gray-2 p-3" aria-label={translate("skills.review_changelog_reason")}>
                <label class="block">
                  <span class="type-ui-sm font-semibold text-dls-text">{translate("skills.review_changelog_reason")}</span>
                  <textarea
                    class="mt-2 min-h-28 w-full resize-y rounded-lg border border-dls-border bg-gray-1 px-3 py-2 type-ui-sm text-dls-text outline-none focus:border-dls-accent"
                    value={reason()}
                    placeholder={props.mode === "request" ? translate("skills.review_request_reason_placeholder") : translate("skills.review_decision_reason_placeholder")}
                    onInput={updateReason}
                  />
                </label>
              </section>
            </aside>
            </div>
          </div>
        </div>

        <footer class="flex flex-wrap items-center justify-end gap-2 border-t border-dls-border px-5 py-3">
          <Button variant="ghost" class="h-9 px-3 type-ui-sm" onClick={props.onClose}>
            {translate("skills.review_cancel")}
          </Button>
          <Switch>
            <Match when={props.mode === "request"}>
              <Button variant="primary" class="h-9 px-3 type-ui-sm" disabled={requestDisabled()} onClick={submitRequest}>
                <Send size={14} />
                {requestLabel()}
              </Button>
            </Match>
            <Match when={props.mode === "review"}>
              <Button variant="danger" class="h-9 px-3 type-ui-sm" disabled={rejectDisabled()} onClick={reject}>
                <X size={14} />
                {rejectLabel()}
              </Button>
              <Button variant="primary" class="h-9 px-3 type-ui-sm" disabled={approveDisabled()} onClick={approve}>
                <Check size={14} />
                <ShieldCheck size={14} />
                {approveLabel()}
              </Button>
            </Match>
          </Switch>
        </footer>
      </div>
    </ModalShell>
  );
}
