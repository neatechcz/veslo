import { For, Match, Show, Switch, createMemo, createSignal, untrack } from "solid-js";
import { AlertTriangle, Check, Save, Send, ShieldCheck, X } from "lucide-solid";

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

function scopeLabel(scope: SkillReviewTargetScope, translate: (key: string) => string) {
  return scope === "organization" ? translate("skills.detail_scope_organization") : translate("skills.review_scope_system");
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

function submittedFileLabel(path: string) {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (/(^|\/)SKILL\.md$/i.test(normalized)) return "SKILL.md";
  if (/(^|\/)scripts?\//i.test(normalized)) return "scripts";
  if (/(^|\/)assets?\//i.test(normalized)) return "assets";
  return normalized.split("/").filter(Boolean).at(-1) ?? normalized;
}

export default function SkillReviewDialog(props: SkillReviewDialogProps) {
  const [localReason, setLocalReason] = createSignal(untrack(() => props.reason ?? ""));
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
    { label: translate("skills.review_summary_target"), value: props.targetLabel ?? scopeLabel(props.targetScope, translate) },
    { label: translate("skills.review_summary_approver"), value: approverLabel() },
  ]);
  const metadataAfter = (key: string) => {
    const label = translate(key);
    return metadataDiff().find((item) => item.field === label)?.after;
  };
  const fileSummary = createMemo(() => {
    const labels = fileDiffs().map((file) => submittedFileLabel(file.path)).filter(Boolean);
    const uniqueLabels = Array.from(new Set(labels));
    return uniqueLabels.length > 0 ? uniqueLabels.join(", ") : "SKILL.md";
  });
  const visibilityLabel = createMemo(() =>
    props.targetScope === "organization"
      ? translate("skills.review_visibility_organization")
      : translate("skills.review_visibility_system"),
  );
  const submittedRows = createMemo(() => [
    {
      label: translate("skills.review_field_name"),
      value: formatValue(metadataAfter("skills.review_field_name"), props.skillName),
    },
    {
      label: translate("skills.review_field_description"),
      value: formatValue(metadataAfter("skills.review_field_description"), translate("skills.review_field_not_set")),
    },
    { label: translate("skills.review_field_files"), value: fileSummary() },
    { label: translate("skills.review_field_visibility"), value: visibilityLabel() },
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
      class="h-[min(902px,calc(100vh-2rem))] max-h-[calc(100vh-2rem)] w-[calc(100vw-2rem)] max-w-[1080px] rounded-[10px] bg-gray-1"
    >
      <div data-testid="skill-review-dialog" class="flex h-full min-h-0 flex-col">
        <header class="shrink-0 px-7 pb-6 pt-6">
          <div class="flex items-start justify-between gap-4">
            <div class="min-w-0 flex-1">
              <div class="mb-2 flex flex-wrap items-center gap-2">
                <span class="rounded-full border border-blue-6 bg-blue-2 px-2.5 py-0.5 type-ui-sm font-semibold text-blue-11">
                  {scopeLabel(props.targetScope, translate)}
                </span>
                <span class="type-ui-sm font-semibold text-dls-muted">{modeLabel()}</span>
              </div>
              <h2 id={titleId} class="text-[28px] font-bold leading-tight text-dls-text">{dialogTitle()}</h2>
              <p id={descriptionId} class="mt-2 max-w-[920px] type-ui-md leading-6 text-dls-secondary">
                {props.mode === "request" ? targetScopeDescription() : translate("skills.review_request_intro")}
              </p>
              <dl class="mt-6 grid gap-2.5 sm:grid-cols-4">
                <For each={summaryItems()}>
                  {(item) => (
                    <div class="min-w-0 rounded-lg border border-dls-border bg-gray-2 px-3 py-3">
                      <dt class="type-ui-sm font-semibold text-dls-muted">{item.label}</dt>
                      <dd class="mt-1 truncate type-ui-md font-semibold text-dls-text" title={item.value}>
                        {item.value}
                      </dd>
                    </div>
                  )}
                </For>
              </dl>
            </div>
            <button
              type="button"
              class="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-dls-border bg-gray-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              aria-label={translate("skills.review_close")}
              onClick={() => props.onClose()}
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <Show when={requestServiceUnavailable()}>
          <section class="border-b border-amber-7 bg-amber-2 px-7 py-3.5" aria-label={translate("skills.review_service_unavailable_title")}>
            <div class="flex gap-3">
              <span class="mt-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-amber-3 text-amber-11">
                <AlertTriangle size={16} />
              </span>
              <div class="min-w-0">
                <h3 class="type-ui-sm font-semibold text-amber-12">{translate("skills.review_service_unavailable_title")}</h3>
                <p class="mt-0.5 type-ui-sm leading-5 text-amber-11">
                  {translate("skills.review_service_unavailable_body")}
                </p>
              </div>
            </div>
          </section>
        </Show>

        <div class="min-h-0 flex-1 overflow-y-auto px-7 py-[22px]">
          <div class="grid gap-[22px] xl:grid-cols-[minmax(0,1fr)_360px]">
            <div class="min-w-0 space-y-[14px]">
              <section class="rounded-lg border border-dls-border bg-gray-2 p-4" aria-label={translate("skills.review_what_will_be_submitted")}>
                <div class="flex items-start justify-between gap-3">
                  <div class="min-w-0">
                    <h3 class="text-[20px] font-bold leading-6 text-dls-text">{translate("skills.review_what_will_be_submitted")}</h3>
                    <p class="mt-1 type-ui-sm leading-5 text-dls-secondary">{translate("skills.review_submitted_data_description")}</p>
                  </div>
                  <span class="shrink-0 rounded-full border border-green-6 bg-green-2 px-2.5 py-0.5 type-ui-sm font-semibold text-green-11">
                    {translate("skills.review_valid_package")}
                  </span>
                </div>

                <dl class="mt-4 overflow-hidden rounded-lg border border-dls-border bg-gray-1">
                  <For each={submittedRows()}>
                    {(item) => (
                      <div class="grid gap-2 border-b border-dls-border px-3 py-3 last:border-b-0 sm:grid-cols-[140px_minmax(0,1fr)]">
                        <dt class="type-ui-sm font-semibold text-dls-muted">{item.label}</dt>
                        <dd class="min-w-0 type-ui-sm font-semibold text-dls-text" title={item.value}>
                          {item.value}
                        </dd>
                      </div>
                    )}
                  </For>
                </dl>
              </section>

              <section class="rounded-lg border border-dls-border bg-gray-1 p-4" aria-label={translate("skills.review_changes_title")}>
                <h3 class="text-[20px] font-bold leading-6 text-dls-text">{translate("skills.review_changes_title")}</h3>
                <ul class="mt-3 list-disc space-y-1 pl-4 type-ui-md leading-6 text-dls-secondary">
                  <li>{translate("skills.review_changes_metadata")}</li>
                  <li>{translate("skills.review_changes_local_runtime")}</li>
                  <li>{translate("skills.review_changes_reviewer_diff")}</li>
                </ul>
              </section>
            </div>

            <aside class="min-w-0 space-y-[14px]">
              <section class="rounded-lg border border-dls-border bg-gray-2 p-4" aria-label={translate("skills.review_catalog_target_title")}>
                <h3 class="text-[18px] font-bold leading-6 text-dls-text">{translate("skills.review_catalog_target_title")}</h3>
                <div class="mt-3 grid grid-cols-2 gap-1 rounded-lg bg-gray-4 p-1">
                  <div
                    classList={{
                      "bg-gray-1 text-dls-text shadow-[0_1px_2px_rgba(15,23,42,0.08)]": props.targetScope === "organization",
                      "border-transparent text-dls-secondary": props.targetScope !== "organization",
                    }}
                    class="rounded-md border px-2 py-2 text-center type-ui-sm font-semibold"
                  >
                    {translate("skills.detail_scope_organization")}
                  </div>
                  <div
                    classList={{
                      "bg-gray-1 text-dls-text shadow-[0_1px_2px_rgba(15,23,42,0.08)]": props.targetScope === "system",
                      "border-transparent text-dls-secondary": props.targetScope !== "system",
                    }}
                    class="rounded-md border px-2 py-2 text-center type-ui-sm font-semibold"
                  >
                    {translate("skills.review_scope_system")}
                  </div>
                </div>
              </section>

              <section class="rounded-lg border border-dls-border bg-gray-1 p-4" aria-label={translate("skills.review_approval_flow_title")}>
                <h3 class="text-[18px] font-bold leading-6 text-dls-text">{translate("skills.review_approval_flow_title")}</h3>
                <ol class="mt-3 space-y-1 type-ui-md leading-5 text-dls-secondary">
                  <li>1. {translate("skills.review_approval_flow_create_request")}</li>
                  <li>2. {translate("skills.review_approval_flow_reviewer_checks")}</li>
                  <li>3. {translate("skills.review_approval_flow_approved_catalog")}</li>
                  <li>4. {translate("skills.review_approval_flow_rejected_reason")}</li>
                </ol>
              </section>

              <section class="rounded-lg border border-dls-border bg-gray-2 p-4" aria-label={translate("skills.review_preconditions_title")}>
                <h3 class="text-[18px] font-bold leading-6 text-dls-text">{translate("skills.review_preconditions_title")}</h3>
                <div class="mt-3 space-y-1 type-ui-md leading-5 text-dls-secondary">
                  <div class="flex gap-1.5">
                    <span class="text-dls-text">✓</span>
                    <span>{translate("skills.review_precondition_metadata")}</span>
                  </div>
                  <div class="flex gap-1.5">
                    <span class="text-dls-text">✓</span>
                    <span>{translate("skills.review_precondition_skill_file")}</span>
                  </div>
                  <div class="flex gap-1.5">
                    <span class="text-dls-text">✓</span>
                    <span>{translate("skills.review_precondition_name_conflicts")}</span>
                  </div>
                  <Show when={requestServiceUnavailable()}>
                    <div class="flex gap-1.5">
                      <span class="text-dls-text">!</span>
                      <span>{translate("skills.review_precondition_service_unavailable")}</span>
                    </div>
                  </Show>
                </div>

                <Show when={executableWarnings().length > 0}>
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
                  <span class="text-[18px] font-bold leading-6 text-dls-text">{translate("skills.review_reviewer_note")}</span>
                  <textarea
                    class="mt-2 min-h-24 w-full resize-y rounded-lg border border-dls-border bg-gray-2 px-3 py-2 type-ui-sm text-dls-text outline-none focus:border-dls-accent"
                    value={reason()}
                    placeholder={props.mode === "request" ? translate("skills.review_request_reason_placeholder") : translate("skills.review_decision_reason_placeholder")}
                    onInput={updateReason}
                  />
                </label>
              </section>
            </aside>
          </div>
        </div>

        <footer class="shrink-0 flex flex-wrap items-center gap-3 border-t border-dls-border px-7 py-4">
          <p class="min-w-[220px] flex-1 type-ui-sm leading-5 text-dls-secondary">
            {requestServiceUnavailable() ? translate("skills.review_footer_unavailable") : translate("skills.review_request_intro")}
          </p>
          <Button variant="outline" class="h-10 px-4 type-ui-md" onClick={props.onClose}>
            {translate("skills.review_cancel")}
          </Button>
          <Switch>
            <Match when={props.mode === "request"}>
              <Show when={props.onSaveDraft}>
                <Button variant="outline" class="h-10 px-4 type-ui-md" onClick={saveDraft}>
                  <Save size={14} />
                  {translate("skills.review_save_draft")}
                </Button>
              </Show>
              <Button
                variant="primary"
                class="h-10 px-4 type-ui-md"
                data-testid="skill-review-submit-button"
                disabled={requestDisabled()}
                onClick={submitRequest}
              >
                <Send size={14} />
                {requestLabel()}
              </Button>
            </Match>
            <Match when={props.mode === "review"}>
              <Button variant="danger" class="h-10 px-4 type-ui-md" disabled={rejectDisabled()} onClick={reject}>
                <X size={14} />
                {rejectLabel()}
              </Button>
              <Button variant="primary" class="h-10 px-4 type-ui-md" disabled={approveDisabled()} onClick={approve}>
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
