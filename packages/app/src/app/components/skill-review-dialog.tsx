import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { AlertTriangle, Check, FileCode, GitCompare, Save, Send, ShieldCheck, X } from "lucide-solid";

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
  onSaveDraft?: (input: SkillReviewActionInput) => void;
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
  const canRequestPublish = createMemo(() =>
    props.targetScope === "organization" ? Boolean(props.onRequestOrganizationPublish) : Boolean(props.onRequestSystemApproval),
  );
  const requestServiceUnavailable = createMemo(() => props.mode === "request" && !canRequestPublish());
  const dialogTitle = createMemo(() =>
    props.mode === "request" ? translate("skills.review_request_title") : props.skillName,
  );
  const modeLabel = createMemo(() =>
    props.mode === "request" ? translate("skills.review_request_mode_label") : translate("skills.review_review_mode_label"),
  );
  const approverLabel = createMemo(() =>
    props.targetScope === "organization"
      ? translate("skills.review_approver_organization")
      : translate("skills.review_approver_system"),
  );
  const summaryItems = createMemo(() => [
    { label: translate("skills.review_summary_skill"), value: props.skillName },
    { label: translate("skills.review_summary_version"), value: props.versionLabel ?? props.versionId },
    { label: translate("skills.review_summary_target"), value: scopeLabel(props.targetScope, translate) },
    { label: translate("skills.review_summary_approver"), value: approverLabel() },
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
    props.pending || !canRequestPublish();

  const approveDisabled = () =>
    props.pending ||
    (props.targetScope === "organization" ? !props.onApproveOrganizationVersion : !props.onApproveSystemVersion);

  const rejectDisabled = () =>
    props.pending ||
    (props.targetScope === "organization" ? !props.onRejectOrganizationVersion : !props.onRejectSystemVersion);

  const submitRequest = () => {
    if (requestDisabled()) return;
    if (props.targetScope === "organization") {
      props.onRequestOrganizationPublish?.(actionInput());
    } else {
      props.onRequestSystemApproval?.(actionInput());
    }
  };

  const saveDraft = () => {
    props.onSaveDraft?.(actionInput());
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
      size="none"
      align="center"
      ariaLabelledBy={titleId}
      ariaDescribedBy={descriptionId}
      class="h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-none rounded-xl bg-gray-1"
    >
      <div data-testid="skill-review-dialog" class="flex h-full min-h-0 flex-col">
        <header class="shrink-0 border-b border-dls-border px-6 py-5">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0 flex-1">
              <div class="mb-2 flex flex-wrap items-center gap-2">
                <span class="rounded-full border border-blue-6 bg-blue-2 px-2.5 py-1 type-ui-xs font-semibold text-blue-11">
                  {scopeLabel(props.targetScope, translate)}
                </span>
                <span class="type-ui-xs font-semibold uppercase text-dls-muted">{modeLabel()}</span>
              </div>
              <h2 id={titleId} class="type-heading-sm text-dls-text">{dialogTitle()}</h2>
              <p id={descriptionId} class="mt-2 max-w-3xl type-ui-sm leading-6 text-dls-secondary">
                {props.mode === "request" ? targetScopeDescription() : translate("skills.review_request_intro")}
              </p>
              <dl class="mt-4 grid gap-2 sm:grid-cols-4">
                <For each={summaryItems()}>
                  {(item) => (
                    <div class="min-w-0 rounded-lg border border-dls-border bg-gray-2 px-3 py-2">
                      <dt class="type-ui-xs font-semibold uppercase text-dls-muted">{item.label}</dt>
                      <dd class="mt-1 truncate type-ui-sm font-semibold text-dls-text" title={item.value}>
                        {item.value}
                      </dd>
                    </div>
                  )}
                </For>
              </dl>
            </div>
            <button
              type="button"
              class="rounded-lg border border-dls-border bg-gray-2 p-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              aria-label={translate("skills.review_close")}
              onClick={props.onClose}
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <Show when={requestServiceUnavailable()}>
          <section class="border-b border-amber-6 bg-amber-2 px-6 py-3" aria-label={translate("skills.review_service_unavailable_title")}>
            <div class="flex gap-3">
              <span class="mt-0.5 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-4 text-amber-11">
                <AlertTriangle size={16} />
              </span>
              <div class="min-w-0">
                <h3 class="type-ui-sm font-semibold text-amber-12">{translate("skills.review_service_unavailable_title")}</h3>
                <p class="mt-0.5 type-ui-sm leading-5 text-amber-11">{translate("skills.review_service_unavailable_body")}</p>
              </div>
            </div>
          </section>
        </Show>

        <div class="min-h-0 flex-1 overflow-y-auto px-6 py-5">
          <div class="grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
            <div class="min-w-0 space-y-4">
              <section class="rounded-lg border border-dls-border bg-gray-2 p-4" aria-label={translate("skills.review_what_will_be_submitted")}>
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <h3 class="type-ui-lg font-semibold text-dls-text">{translate("skills.review_what_will_be_submitted")}</h3>
                    <p class="mt-1 type-ui-sm leading-5 text-dls-secondary">{translate("skills.review_submitted_data_description")}</p>
                  </div>
                  <span class="shrink-0 rounded-full border border-green-6 bg-green-3 px-2.5 py-1 type-ui-xs font-semibold text-green-11">
                    {translate("skills.review_valid_package")}
                  </span>
                </div>

                <Show
                  when={metadataDiff().length > 0}
                  fallback={<p class="mt-4 type-ui-sm text-dls-secondary">{translate("skills.review_no_metadata_changes")}</p>}
                >
                  <dl class="mt-4 overflow-hidden rounded-lg border border-dls-border bg-gray-1">
                    <For each={metadataDiff()}>
                      {(item) => (
                        <div class="grid gap-2 border-b border-dls-border px-3 py-2.5 last:border-b-0 sm:grid-cols-[132px_minmax(0,1fr)]">
                          <dt class="type-ui-sm font-semibold text-dls-muted">{item.field}</dt>
                          <dd class="min-w-0">
                            <div class="grid gap-2 sm:grid-cols-2">
                              <div class="min-w-0 rounded border border-dls-border bg-gray-2 px-2 py-1.5">
                                <div class="type-ui-xs font-semibold uppercase text-dls-muted">{translate("skills.review_previous_value")}</div>
                                <div class="mt-0.5 truncate type-ui-sm text-dls-secondary" title={item.before ?? undefined}>
                                  {formatValue(item.before, translate("skills.review_field_not_set"))}
                                </div>
                              </div>
                              <div class="min-w-0 rounded border border-blue-6 bg-blue-2 px-2 py-1.5">
                                <div class="type-ui-xs font-semibold uppercase text-blue-10">{translate("skills.review_current_value")}</div>
                                <div class="mt-0.5 truncate type-ui-sm font-semibold text-dls-text" title={item.after ?? undefined}>
                                  {formatValue(item.after, translate("skills.review_field_not_set"))}
                                </div>
                              </div>
                            </div>
                          </dd>
                        </div>
                      )}
                    </For>
                  </dl>
                </Show>
              </section>

              <section class="rounded-lg border border-dls-border bg-gray-1 p-4" aria-label={translate("skills.review_changes_title")}>
                <h3 class="type-ui-lg font-semibold text-dls-text">{translate("skills.review_changes_title")}</h3>
                <div class="mt-3 space-y-2 type-ui-sm leading-5 text-dls-secondary">
                  <div class="flex gap-2">
                    <Check size={15} class="mt-0.5 shrink-0 text-green-10" />
                    <span>{translate("skills.review_changes_metadata")}</span>
                  </div>
                  <div class="flex gap-2">
                    <Check size={15} class="mt-0.5 shrink-0 text-green-10" />
                    <span>{translate("skills.review_changes_local_runtime")}</span>
                  </div>
                  <div class="flex gap-2">
                    <GitCompare size={15} class="mt-0.5 shrink-0 text-dls-secondary" />
                    <span>{translate("skills.review_changes_reviewer_diff")}</span>
                  </div>
                </div>

                <div class="mt-4 border-t border-dls-border pt-3">
                  <div class="mb-2 flex items-center gap-2">
                    <FileCode size={15} class="text-dls-secondary" />
                    <h4 class="type-ui-sm font-semibold text-dls-text">{translate("skills.review_file_tree_diff")}</h4>
                  </div>
                  <Show
                    when={fileDiffs().length > 0}
                    fallback={<p class="type-ui-sm text-dls-secondary">{translate("skills.review_no_file_changes")}</p>}
                  >
                    <div class="space-y-1" role="list">
                      <For each={fileDiffs()}>
                        {(file) => (
                          <div class="grid grid-cols-[104px_minmax(0,1fr)] items-center gap-2 rounded border border-dls-border bg-gray-2 px-2 py-1.5 type-ui-sm sm:grid-cols-[104px_minmax(0,1fr)_auto]" role="listitem">
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
                </div>
              </section>
            </div>

            <aside class="min-w-0 space-y-4">
              <section class="rounded-lg border border-dls-border bg-gray-2 p-4" aria-label={translate("skills.review_catalog_target_title")}>
                <h3 class="type-ui-sm font-semibold text-dls-text">{translate("skills.review_catalog_target_title")}</h3>
                <div class="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-gray-4 p-1">
                  <div
                    classList={{
                      "border-blue-6 bg-blue-2 text-blue-11": props.targetScope === "organization",
                      "border-transparent text-dls-secondary": props.targetScope !== "organization",
                    }}
                    class="rounded-md border px-2 py-2 text-center type-ui-xs font-semibold"
                  >
                    {translate("skills.detail_scope_organization")}
                  </div>
                  <div
                    classList={{
                      "border-blue-6 bg-blue-2 text-blue-11": props.targetScope === "system",
                      "border-transparent text-dls-secondary": props.targetScope !== "system",
                    }}
                    class="rounded-md border px-2 py-2 text-center type-ui-xs font-semibold"
                  >
                    {translate("skills.review_scope_system")}
                  </div>
                </div>
              </section>

              <section class="rounded-lg border border-dls-border bg-gray-1 p-4" aria-label={translate("skills.review_approval_flow_title")}>
                <h3 class="type-ui-sm font-semibold text-dls-text">{translate("skills.review_approval_flow_title")}</h3>
                <ol class="mt-3 space-y-2 type-ui-sm leading-5 text-dls-secondary">
                  <li class="flex gap-2"><span class="font-semibold text-dls-text">1.</span>{translate("skills.review_approval_flow_create_request")}</li>
                  <li class="flex gap-2"><span class="font-semibold text-dls-text">2.</span>{translate("skills.review_approval_flow_reviewer_checks")}</li>
                  <li class="flex gap-2"><span class="font-semibold text-dls-text">3.</span>{translate("skills.review_approval_flow_approved_catalog")}</li>
                  <li class="flex gap-2"><span class="font-semibold text-dls-text">4.</span>{translate("skills.review_approval_flow_rejected_reason")}</li>
                </ol>
              </section>

              <section class="rounded-lg border border-dls-border bg-gray-2 p-4" aria-label={translate("skills.review_preconditions_title")}>
                <h3 class="type-ui-sm font-semibold text-dls-text">{translate("skills.review_preconditions_title")}</h3>
                <div class="mt-3 space-y-2 type-ui-sm leading-5 text-dls-secondary">
                  <div class="flex gap-2">
                    <Check size={15} class="mt-0.5 shrink-0 text-green-10" />
                    <span>{translate("skills.review_precondition_metadata")}</span>
                  </div>
                  <div class="flex gap-2">
                    <Check size={15} class="mt-0.5 shrink-0 text-green-10" />
                    <span>{translate("skills.review_precondition_skill_file")}</span>
                  </div>
                  <div class="flex gap-2">
                    <Check size={15} class="mt-0.5 shrink-0 text-green-10" />
                    <span>{translate("skills.review_precondition_name_conflicts")}</span>
                  </div>
                  <Show when={requestServiceUnavailable()}>
                    <div class="flex gap-2 text-amber-11">
                      <AlertTriangle size={15} class="mt-0.5 shrink-0" />
                      <span>{translate("skills.review_precondition_service_unavailable")}</span>
                    </div>
                  </Show>
                </div>

                <Show
                  when={executableWarnings().length > 0}
                  fallback={<p class="mt-3 type-ui-sm text-dls-secondary">{translate("skills.review_no_warnings")}</p>}
                >
                  <div class="mt-3 space-y-1" aria-label={translate("skills.review_warnings")}>
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

              <section class="rounded-lg border border-dls-border bg-gray-1 p-4" aria-label={translate("skills.review_reviewer_note")}>
                <label class="block">
                  <span class="type-ui-sm font-semibold text-dls-text">{translate("skills.review_reviewer_note")}</span>
                  <textarea
                    class="mt-2 min-h-28 w-full resize-y rounded-lg border border-dls-border bg-gray-2 px-3 py-2 type-ui-sm text-dls-text outline-none focus:border-dls-accent"
                    value={reason()}
                    placeholder={props.mode === "request" ? translate("skills.review_request_reason_placeholder") : translate("skills.review_decision_reason_placeholder")}
                    onInput={updateReason}
                  />
                </label>
              </section>
            </aside>
          </div>
        </div>

        <footer class="shrink-0 flex flex-wrap items-center gap-3 border-t border-dls-border px-6 py-4">
          <p class="min-w-[220px] flex-1 type-ui-sm leading-5 text-dls-secondary">
            {requestServiceUnavailable() ? translate("skills.review_footer_unavailable") : translate("skills.review_request_intro")}
          </p>
          <Button variant="ghost" class="h-10 px-3 type-ui-sm" onClick={props.onClose}>
            {translate("skills.review_cancel")}
          </Button>
          <Switch>
            <Match when={props.mode === "request"}>
              <Show when={props.onSaveDraft}>
                <Button variant="outline" class="h-10 px-3 type-ui-sm" onClick={saveDraft}>
                  <Save size={14} />
                  {translate("skills.review_save_draft")}
                </Button>
              </Show>
              <Button variant="primary" class="h-10 px-3 type-ui-sm" disabled={requestDisabled()} onClick={submitRequest}>
                <Send size={14} />
                {requestLabel()}
              </Button>
            </Match>
            <Match when={props.mode === "review"}>
              <Button variant="danger" class="h-10 px-3 type-ui-sm" disabled={rejectDisabled()} onClick={reject}>
                <X size={14} />
                {rejectLabel()}
              </Button>
              <Button variant="primary" class="h-10 px-3 type-ui-sm" disabled={approveDisabled()} onClick={approve}>
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
