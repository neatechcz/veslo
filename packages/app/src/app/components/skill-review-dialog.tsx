import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { AlertTriangle, Check, FileCode, GitCompare, Send, ShieldCheck, X } from "lucide-solid";

import Button from "./button";
import ModalShell from "./modal-shell";

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

function formatValue(value?: string | null) {
  const normalized = value?.trim();
  return normalized || "Not set";
}

function formatBytes(sizeBytes?: number | null) {
  if (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes)) return "";
  if (sizeBytes < 1024) return `${sizeBytes} B`;
  if (sizeBytes < 1024 * 1024) return `${Math.round(sizeBytes / 102.4) / 10} KB`;
  return `${Math.round(sizeBytes / 1024 / 102.4) / 10} MB`;
}

function scopeLabel(scope: SkillReviewTargetScope) {
  return scope === "organization" ? "Organization" : "System";
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

function createFileWarnings(fileDiffs: readonly SkillReviewFileDiff[]) {
  return fileDiffs.flatMap((file) => {
    const warnings: SkillReviewWarning[] = [];
    if (!isMarkdownFile(file.path)) {
      warnings.push({
        id: `non-markdown:${file.path}`,
        label: "Non-Markdown file",
        detail: file.path,
        severity: isScriptFile(file.path) ? "warning" : "info",
      });
    }
    if (file.executable) {
      warnings.push({
        id: `executable:${file.path}`,
        label: "Executable file",
        detail: file.path,
        severity: "danger",
      });
    }
    if (isScriptFile(file.path)) {
      warnings.push({
        id: `script:${file.path}`,
        label: "Script path",
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
  const reason = createMemo(() => props.reason ?? localReason());
  const metadataDiff = createMemo(() => props.metadataDiff ?? []);
  const fileDiffs = createMemo(() => props.fileDiffs ?? []);
  const executableWarnings = createMemo(() => [...createFileWarnings(fileDiffs()), ...(props.warnings ?? [])]);

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
    props.targetScope === "organization" ? "Request organization publish" : "Request system approval";

  const approveLabel = () =>
    props.targetScope === "organization" ? "Approve organization version" : "Approve system version";

  const rejectLabel = () =>
    props.targetScope === "organization" ? "Reject organization version" : "Reject system version";

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
      class="max-w-3xl rounded-lg bg-gray-1"
    >
      <div data-testid="skill-review-dialog" class="flex max-h-[82vh] flex-col">
        <header class="border-b border-dls-border px-4 py-3">
          <div class="flex items-start justify-between gap-3">
            <div class="min-w-0">
              <p id={descriptionId} class="type-ui-xs uppercase text-dls-muted">
                {props.mode === "request" ? "Publish request" : "Approval review"}
              </p>
              <h2 id={titleId} class="truncate type-heading-sm text-dls-text">
                {props.skillName}
              </h2>
              <p class="mt-1 truncate type-ui-sm text-dls-secondary">
                {props.versionLabel ?? props.versionId}
              </p>
            </div>
            <button
              type="button"
              class="rounded-lg p-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
              aria-label="Close skill review"
              onClick={props.onClose}
            >
              <X size={18} />
            </button>
          </div>
        </header>

        <div class="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          <div class="grid gap-4 lg:grid-cols-[minmax(0,1fr)_260px]">
            <div class="space-y-4">
              <section class="rounded-lg border border-dls-border bg-gray-2 p-3" aria-label="Metadata diff">
                <div class="mb-2 flex items-center gap-2">
                  <GitCompare size={15} class="text-dls-secondary" />
                  <h3 class="type-ui-sm font-semibold text-dls-text">Metadata diff</h3>
                </div>
                <Show
                  when={metadataDiff().length > 0}
                  fallback={<p class="type-ui-sm text-dls-secondary">No metadata changes</p>}
                >
                  <dl class="space-y-2">
                    <For each={metadataDiff()}>
                      {(item) => (
                        <div class="grid gap-1 type-ui-sm sm:grid-cols-[120px_minmax(0,1fr)]">
                          <dt class="truncate type-ui-xs uppercase text-dls-muted">{item.field}</dt>
                          <dd class="grid min-w-0 gap-1 sm:grid-cols-2">
                            <span class="truncate rounded border border-dls-border bg-gray-1 px-2 py-1 text-dls-secondary" title={item.before ?? undefined}>
                              {formatValue(item.before)}
                            </span>
                            <span class="truncate rounded border border-dls-border bg-gray-1 px-2 py-1 text-dls-text" title={item.after ?? undefined}>
                              {formatValue(item.after)}
                            </span>
                          </dd>
                        </div>
                      )}
                    </For>
                  </dl>
                </Show>
              </section>

              <section class="rounded-lg border border-dls-border bg-gray-2 p-3" aria-label="File tree diff">
                <div class="mb-2 flex items-center gap-2">
                  <FileCode size={15} class="text-dls-secondary" />
                  <h3 class="type-ui-sm font-semibold text-dls-text">File tree diff</h3>
                </div>
                <Show
                  when={fileDiffs().length > 0}
                  fallback={<p class="type-ui-sm text-dls-secondary">No file changes</p>}
                >
                  <div class="space-y-1" role="list">
                    <For each={fileDiffs()}>
                      {(file) => (
                        <div class="grid grid-cols-[78px_minmax(0,1fr)_auto] items-center gap-2 rounded border border-dls-border bg-gray-1 px-2 py-1.5 type-ui-sm" role="listitem">
                          <span class={`rounded-full border px-2 py-0.5 text-center type-ui-xs capitalize ${fileKindClass(file.kind)}`}>
                            {file.kind}
                          </span>
                          <span class="min-w-0 truncate font-mono text-[12px] text-dls-text" title={file.path}>
                            {file.path}
                          </span>
                          <span class="flex items-center gap-1 text-[11px] text-dls-muted">
                            <Show when={!isMarkdownFile(file.path)}>
                              <span>Non-Markdown</span>
                            </Show>
                            <Show when={file.executable}>
                              <span>Executable</span>
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

            <aside class="space-y-4">
              <section class="rounded-lg border border-dls-border bg-gray-2 p-3" aria-label="Target scope">
                <h3 class="type-ui-sm font-semibold text-dls-text">Target scope</h3>
                <dl class="mt-2 space-y-2 type-ui-sm">
                  <div>
                    <dt class="type-ui-xs uppercase text-dls-muted">Scope</dt>
                    <dd class="text-dls-text">{scopeLabel(props.targetScope)}</dd>
                  </div>
                  <div>
                    <dt class="type-ui-xs uppercase text-dls-muted">Target</dt>
                    <dd class="truncate text-dls-text" title={props.targetLabel ?? undefined}>
                      {props.targetLabel ?? scopeLabel(props.targetScope)}
                    </dd>
                  </div>
                </dl>
              </section>

              <section class="rounded-lg border border-dls-border bg-gray-2 p-3" aria-label="Executable and script warnings">
                <div class="mb-2 flex items-center gap-2">
                  <AlertTriangle size={15} class="text-dls-secondary" />
                  <h3 class="type-ui-sm font-semibold text-dls-text">Executable and script warnings</h3>
                </div>
                <Show
                  when={executableWarnings().length > 0}
                  fallback={<p class="type-ui-sm text-dls-secondary">No executable or script files detected</p>}
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

              <section class="rounded-lg border border-dls-border bg-gray-2 p-3" aria-label="Changelog / reason">
                <label class="block">
                  <span class="type-ui-sm font-semibold text-dls-text">Changelog / reason</span>
                  <textarea
                    class="mt-2 min-h-28 w-full resize-y rounded-lg border border-dls-border bg-gray-1 px-3 py-2 type-ui-sm text-dls-text outline-none focus:border-dls-accent"
                    value={reason()}
                    placeholder={props.mode === "request" ? "Summarize the publish request" : "Record the approval or rejection reason"}
                    onInput={updateReason}
                  />
                </label>
              </section>
            </aside>
          </div>
        </div>

        <footer class="flex flex-wrap items-center justify-end gap-2 border-t border-dls-border px-4 py-3">
          <Button variant="ghost" class="h-9 px-3 type-ui-sm" onClick={props.onClose}>
            Cancel
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
