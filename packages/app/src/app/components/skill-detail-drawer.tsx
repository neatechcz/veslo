import { For, Match, Show, Switch, createMemo, createSignal } from "solid-js";
import { Copy, MapPin, MoveRight, Send, ShieldCheck, Trash2, X } from "lucide-solid";

import Button from "./button";
import SkillVersionHistory, {
  formatSkillPackageHash,
  type SkillVersionRow,
  type SkillVersionTargetMetadata,
} from "./skill-version-history";

export type SkillDetailTab = "overview" | "locations" | "versions" | "sharing" | "audit";

export const SKILL_DETAIL_TABS = [
  { id: "overview", label: "Overview" },
  { id: "locations", label: "Locations" },
  { id: "versions", label: "Versions" },
  { id: "sharing", label: "Sharing" },
  { id: "audit", label: "Audit" },
] satisfies Array<{ id: SkillDetailTab; label: string }>;

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

export type SkillDetailLocation = {
  id: string;
  label: string;
  scope: "global" | "workspace" | "organization";
  path: string;
  writable?: boolean;
  active?: boolean;
  source?: string | null;
};

export type SkillAuditEntry = {
  id: string;
  action: string;
  createdAt: string;
  actor?: string | null;
  target?: string | null;
  details?: string | null;
};

export type SkillDetailAction = "copy" | "move" | "publish" | "requestApproval" | "restore" | "delete";

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
  selectedTab?: SkillDetailTab;
  selectedVersionId?: string | null;
  selectedVersionTargetId?: string | null;
  actionPending?: Partial<Record<SkillDetailAction, boolean>>;
  onSelectTab?: (tab: SkillDetailTab) => void;
  onSelectVersion?: (version: SkillVersionRow) => void;
  onSelectVersionTarget?: (target: SkillVersionTargetMetadata) => void;
  onClose: () => void;
  onCopySkill?: (input: SkillDetailActionInput) => void;
  onMoveSkill?: (input: SkillDetailActionInput) => void;
  onPublishSkill?: (input: SkillDetailActionInput) => void;
  onRequestApproval?: (input: SkillDetailActionInput) => void;
  onRestoreVersion?: (version: SkillVersionRow) => void;
  onDeleteSkill?: (input: SkillDetailActionInput) => void;
};

const titleId = "skill-detail-drawer-title";

function fieldValue(value?: string | null) {
  const normalized = value?.trim();
  return normalized || "Not set";
}

export default function SkillDetailDrawer(props: SkillDetailDrawerProps) {
  const [localTab, setLocalTab] = createSignal<SkillDetailTab>("overview");
  const activeTab = createMemo(() => props.selectedTab ?? localTab());

  const selectTab = (tab: SkillDetailTab) => {
    setLocalTab(tab);
    props.onSelectTab?.(tab);
  };

  const actionInput = (skill: SkillDetailMetadata, location?: SkillDetailLocation | null): SkillDetailActionInput => ({
    skill,
    location: location ?? null,
  });

  return (
    <Show when={props.open ? props.skill : null} keyed>
      {(skill) => (
        <div class="fixed inset-0 z-50 flex justify-end bg-gray-1/60 backdrop-blur-sm" data-testid="skill-detail-drawer">
          <aside
            class="flex h-full w-full max-w-[560px] flex-col border-l border-dls-border bg-gray-1 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
          >
            <header class="border-b border-dls-border px-4 py-3">
              <div class="flex items-start justify-between gap-3">
                <div class="min-w-0">
                  <p class="type-ui-xs uppercase text-dls-muted">Skill</p>
                  <h2 id={titleId} class="truncate type-heading-sm text-dls-text">
                    {skill.name}
                  </h2>
                </div>
                <button
                  type="button"
                  class="rounded-lg p-2 text-dls-secondary transition-colors hover:bg-dls-hover hover:text-dls-text"
                  aria-label="Close skill details"
                  onClick={props.onClose}
                >
                  <X size={18} />
                </button>
              </div>

              <nav class="mt-3 flex gap-1 overflow-x-auto" aria-label="Skill detail sections">
                <For each={SKILL_DETAIL_TABS}>
                  {(tab) => (
                    <button
                      type="button"
                      classList={{
                        "bg-gray-12 text-gray-1": activeTab() === tab.id,
                        "text-dls-secondary hover:bg-dls-hover hover:text-dls-text": activeTab() !== tab.id,
                      }}
                      class="shrink-0 rounded-lg px-3 py-1.5 type-ui-sm font-medium"
                      aria-current={activeTab() === tab.id ? "page" : undefined}
                      onClick={() => selectTab(tab.id)}
                    >
                      {tab.label}
                    </button>
                  )}
                </For>
              </nav>
            </header>

            <div class="flex-1 overflow-y-auto px-4 py-4">
              <Switch>
                <Match when={activeTab() === "overview"}>
                  <section class="space-y-4" aria-label="Skill overview">
                    <div class="grid gap-3 rounded-lg border border-dls-border bg-gray-2 p-3">
                      <dl class="grid gap-3 type-ui-sm sm:grid-cols-2">
                        <div class="min-w-0">
                          <dt class="type-ui-xs uppercase text-dls-muted">Description</dt>
                          <dd class="line-clamp-3 text-dls-text">{fieldValue(skill.description)}</dd>
                        </div>
                        <div class="min-w-0">
                          <dt class="type-ui-xs uppercase text-dls-muted">Trigger</dt>
                          <dd class="truncate font-mono text-[12px] text-dls-text">{fieldValue(skill.trigger)}</dd>
                        </div>
                        <div class="min-w-0">
                          <dt class="type-ui-xs uppercase text-dls-muted">Status</dt>
                          <dd class="truncate text-dls-text">{fieldValue(skill.status ?? skill.approvalStatus)}</dd>
                        </div>
                        <div class="min-w-0">
                          <dt class="type-ui-xs uppercase text-dls-muted">Package hash</dt>
                          <dd class="truncate font-mono text-[12px] text-dls-text" title={skill.packageHash ?? undefined}>
                            {formatSkillPackageHash(skill.packageHash)}
                          </dd>
                        </div>
                      </dl>
                    </div>

                    <div class="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        class="h-9 px-3 type-ui-sm"
                        disabled={!props.onCopySkill || props.actionPending?.copy}
                        onClick={() => props.onCopySkill?.(actionInput(skill))}
                      >
                        <Copy size={14} />
                        Copy
                      </Button>
                      <Button
                        variant="outline"
                        class="h-9 px-3 type-ui-sm"
                        disabled={!props.onMoveSkill || props.actionPending?.move}
                        onClick={() => props.onMoveSkill?.(actionInput(skill))}
                      >
                        <MoveRight size={14} />
                        Move
                      </Button>
                      <Button
                        variant="outline"
                        class="h-9 px-3 type-ui-sm"
                        disabled={!props.onPublishSkill || props.actionPending?.publish}
                        onClick={() => props.onPublishSkill?.(actionInput(skill))}
                      >
                        <Send size={14} />
                        Publish
                      </Button>
                      <Button
                        variant="outline"
                        class="h-9 px-3 type-ui-sm"
                        disabled={!props.onRequestApproval || props.actionPending?.requestApproval}
                        onClick={() => props.onRequestApproval?.(actionInput(skill))}
                      >
                        <ShieldCheck size={14} />
                        Request approval
                      </Button>
                      <Button
                        variant="danger"
                        class="h-9 px-3 type-ui-sm"
                        disabled={!props.onDeleteSkill || props.actionPending?.delete}
                        onClick={() => props.onDeleteSkill?.(actionInput(skill))}
                      >
                        <Trash2 size={14} />
                        Delete
                      </Button>
                    </div>
                  </section>
                </Match>

                <Match when={activeTab() === "locations"}>
                  <section class="space-y-2" aria-label="Skill locations">
                    <Show
                      when={(props.locations?.length ?? 0) > 0}
                      fallback={<div class="rounded-lg border border-dls-border bg-gray-2 px-3 py-2 type-ui-sm text-dls-secondary">No locations</div>}
                    >
                      <For each={props.locations ?? []}>
                        {(location) => (
                          <article class="rounded-lg border border-dls-border bg-gray-2 p-3">
                            <div class="flex items-start justify-between gap-3">
                              <div class="min-w-0">
                                <div class="flex items-center gap-2">
                                  <MapPin size={14} class="text-dls-secondary" />
                                  <h3 class="truncate type-ui-md font-semibold text-dls-text">{location.label}</h3>
                                  <span class="rounded-full border border-dls-border px-2 py-0.5 type-ui-xs capitalize text-dls-secondary">
                                    {location.scope}
                                  </span>
                                </div>
                                <p class="mt-1 truncate font-mono text-[12px] text-dls-secondary" title={location.path}>
                                  {location.path}
                                </p>
                              </div>
                              <div class="flex shrink-0 gap-1">
                                <Button
                                  variant="ghost"
                                  class="h-8 px-2 type-ui-sm"
                                  disabled={!props.onCopySkill || props.actionPending?.copy}
                                  onClick={() => props.onCopySkill?.(actionInput(skill, location))}
                                >
                                  Copy
                                </Button>
                                <Button
                                  variant="ghost"
                                  class="h-8 px-2 type-ui-sm"
                                  disabled={!props.onMoveSkill || props.actionPending?.move || location.writable === false}
                                  onClick={() => props.onMoveSkill?.(actionInput(skill, location))}
                                >
                                  Move
                                </Button>
                              </div>
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
                  <section class="space-y-3" aria-label="Skill sharing">
                    <dl class="grid gap-3 rounded-lg border border-dls-border bg-gray-2 p-3 type-ui-sm sm:grid-cols-2">
                      <div class="min-w-0">
                        <dt class="type-ui-xs uppercase text-dls-muted">Publisher</dt>
                        <dd class="truncate text-dls-text">{fieldValue(skill.publisher)}</dd>
                      </div>
                      <div class="min-w-0">
                        <dt class="type-ui-xs uppercase text-dls-muted">Approval</dt>
                        <dd class="truncate text-dls-text">{fieldValue(skill.approvalStatus)}</dd>
                      </div>
                    </dl>
                    <div class="flex flex-wrap gap-2">
                      <Button
                        variant="outline"
                        class="h-9 px-3 type-ui-sm"
                        disabled={!props.onPublishSkill || props.actionPending?.publish}
                        onClick={() => props.onPublishSkill?.(actionInput(skill))}
                      >
                        <Send size={14} />
                        Publish
                      </Button>
                      <Button
                        variant="outline"
                        class="h-9 px-3 type-ui-sm"
                        disabled={!props.onRequestApproval || props.actionPending?.requestApproval}
                        onClick={() => props.onRequestApproval?.(actionInput(skill))}
                      >
                        <ShieldCheck size={14} />
                        Request approval
                      </Button>
                    </div>
                  </section>
                </Match>

                <Match when={activeTab() === "audit"}>
                  <section class="space-y-2" aria-label="Skill audit">
                    <Show
                      when={(props.auditEntries?.length ?? 0) > 0}
                      fallback={<div class="rounded-lg border border-dls-border bg-gray-2 px-3 py-2 type-ui-sm text-dls-secondary">No audit entries</div>}
                    >
                      <For each={props.auditEntries ?? []}>
                        {(entry) => (
                          <article class="rounded-lg border border-dls-border bg-gray-2 px-3 py-2">
                            <div class="flex items-start justify-between gap-3">
                              <div class="min-w-0">
                                <h3 class="truncate type-ui-md font-semibold text-dls-text">{entry.action}</h3>
                                <p class="truncate type-ui-sm text-dls-secondary">{fieldValue(entry.details ?? entry.target)}</p>
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
