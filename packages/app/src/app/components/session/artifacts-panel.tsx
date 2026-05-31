import { For, Show, createMemo } from "solid-js";
import { FilePenLine, FileSearch, FolderSearch, HeartPulse, PlugZap, Sparkles } from "lucide-solid";
import type { JSX } from "solid-js";

import type { ArtifactFamily, ArtifactFamilyId, ArtifactFamilyItem } from "./artifact-family-model";
import { t as tr } from "../../../i18n";
import { splitPathSegments, toWorkspaceRelative, getBasename, getDirname, normalizePath } from "../../utils/workspace-path";

export type ArtifactsPanelProps = {
  families: ArtifactFamily[];
  workspaceRoot?: string;
  onRevealArtifact?: (path: string) => void;
  onOpenInObsidian?: (path: string) => void;
  obsidianAvailable?: boolean;
  id?: string;
};

const isMarkdown = (value: string) => /\.(md|mdx|markdown)$/i.test(value);

const statusLabel = (value: string) => {
  if (value === "scanned") return tr("session.artifact_status_scanned");
  if (value === "updated") return tr("session.artifact_status_updated");
  if (value === "created") return tr("session.artifact_status_created");
  if (value === "exported") return tr("session.artifact_status_exported");
  if (value === "used") return tr("session.artifact_status_used");
  if (value === "active") return tr("session.artifact_status_active");
  return value;
};

const fileGroupInteraction = (item: ArtifactFamilyItem) => {
  if (item.fileInteraction === "modified" || item.fileInteraction === "opened") return item.fileInteraction;
  if (item.kind === "file_output") return "modified";
  if (item.kind === "file_discovered") return "opened";
  if (item.status === "updated" || item.status === "created" || item.status === "exported") return "modified";
  return "opened";
};

const fileStatusLabel = (item: ArtifactFamilyItem) => {
  const interaction = fileGroupInteraction(item);
  if (interaction === "modified") return tr("session.artifact_files_modified");
  if (interaction === "opened") return tr("session.artifact_files_opened");
  return statusLabel(item.status);
};

const familyLabel = (family: ArtifactFamily) => {
  if (family.family === "files") return tr("session.artifact_family_files");
  if (family.family === "skills") return tr("session.artifact_family_skills");
  if (family.family === "mcp") return tr("session.artifact_family_mcp");
  if (family.family === "soul") return tr("session.artifact_family_soul");
  return family.label;
};

const familyIcon = (family: ArtifactFamilyId): JSX.Element => {
  if (family === "files") return <FolderSearch size={14} class="text-gray-10" />;
  if (family === "skills") return <Sparkles size={14} class="text-gray-10" />;
  if (family === "mcp") return <PlugZap size={14} class="text-gray-10" />;
  return <HeartPulse size={14} class="text-gray-10" />;
};

const subtitleText = (item: ArtifactFamilyItem, workspaceRoot?: string) => {
  if (item.path) return getDirname(toWorkspaceRelative(item.path, workspaceRoot));
  const subtitle = item.subtitle?.trim();
  if (subtitle) return subtitle;
  const sourceName = item.sourceName?.trim();
  if (sourceName) return sourceName;
  return "";
};

type ArtifactRowProps = {
  item: ArtifactFamilyItem;
  status: string;
  workspaceRoot?: string;
  canRevealArtifact: () => boolean;
  canOpenObsidian: () => boolean;
  onRevealArtifact?: (path: string) => void;
  onOpenInObsidian?: (path: string) => void;
};

function ArtifactRow(props: ArtifactRowProps) {
  const subtitle = () => subtitleText(props.item, props.workspaceRoot);
  const canReveal = () => Boolean(props.item.path) && props.canRevealArtifact();
  const canOpenMd = () => Boolean(props.item.path) && isMarkdown(props.item.path ?? "") && props.canOpenObsidian();
  const displayTitle = () => {
    if (props.item.path) {
      return getBasename(normalizePath(props.item.path));
    }
    return props.item.title;
  };

  return (
    <div
      class="group flex items-start gap-2 rounded-lg border border-transparent px-2 py-1.5 transition-colors hover:border-gray-6/80 hover:bg-gray-1/70"
    >
      <div class="min-w-0 flex-1 space-y-1">
        <div class="truncate text-xs font-medium text-gray-11" title={displayTitle()}>{displayTitle()}</div>
        <div class="flex flex-wrap items-center gap-1.5">
          <div class="shrink-0 rounded-md border border-gray-6 bg-gray-2 px-1.5 py-0.5 text-[10px] font-medium text-gray-10">
            {props.status}
          </div>
          <Show when={canOpenMd()}>
            <button
              type="button"
              class="rounded-md border border-gray-6 bg-gray-2 px-1.5 py-0.5 text-[10px] font-medium text-gray-10 transition-colors hover:border-gray-7 hover:text-gray-12"
              onClick={() => props.item.path && props.onOpenInObsidian?.(props.item.path)}
              title={tr("session.open_in_obsidian")}
            >
              Obsidian
            </button>
          </Show>
          <Show when={canReveal()}>
            <button
              type="button"
              class="rounded-md border border-gray-6 bg-gray-2 px-1.5 py-0.5 text-[10px] font-medium text-gray-10 transition-colors hover:border-gray-7 hover:text-gray-12"
              onClick={() => props.item.path && props.onRevealArtifact?.(props.item.path)}
              title={tr("session.reveal")}
            >
              {tr("session.reveal")}
            </button>
          </Show>
        </div>
        <Show when={subtitle()}>
          <div class="truncate text-[11px] text-gray-9" title={subtitle()}>{subtitle()}</div>
        </Show>
      </div>
    </div>
  );
}

type FileArtifactGroupProps = {
  testId: string;
  label: string;
  items: ArtifactFamilyItem[];
  icon: JSX.Element;
  workspaceRoot?: string;
  canRevealArtifact: () => boolean;
  canOpenObsidian: () => boolean;
  onRevealArtifact?: (path: string) => void;
  onOpenInObsidian?: (path: string) => void;
};

function FileArtifactGroup(props: FileArtifactGroupProps) {
  return (
    <Show when={props.items.length > 0}>
      <div class="space-y-1" data-testid={props.testId}>
        <div class="flex items-center justify-between px-1.5 py-1 text-[11px] font-medium text-gray-10">
          <div class="flex items-center gap-1.5">
            <div class="shrink-0">{props.icon}</div>
            <div>{props.label}</div>
          </div>
          <div class="rounded border border-gray-5 bg-gray-1 px-1.5 py-0.5 text-[10px] text-gray-9">
            {props.items.length}
          </div>
        </div>
        <For each={props.items}>
          {(item) => (
            <ArtifactRow
              item={item}
              status={fileStatusLabel(item)}
              workspaceRoot={props.workspaceRoot}
              canRevealArtifact={props.canRevealArtifact}
              canOpenObsidian={props.canOpenObsidian}
              onRevealArtifact={props.onRevealArtifact}
              onOpenInObsidian={props.onOpenInObsidian}
            />
          )}
        </For>
      </div>
    </Show>
  );
}

export default function ArtifactsPanel(props: ArtifactsPanelProps) {
  const totalCount = createMemo(() =>
    props.families.reduce((sum, family) => sum + family.items.length, 0),
  );
  const canRevealArtifact = createMemo(() => typeof props.onRevealArtifact === "function");
  const canOpenObsidian = createMemo(
    () => Boolean(props.obsidianAvailable) && typeof props.onOpenInObsidian === "function",
  );

  return (
    <div id={props.id}>
      <div class="mb-3 flex items-center justify-between px-2">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-gray-10">{tr("session.artifacts")}</span>
        <Show when={totalCount() > 0}>
          <span class="rounded bg-gray-4/60 px-1.5 text-[11px] font-medium text-gray-10">
            {totalCount()}
          </span>
        </Show>
      </div>

      <div class="space-y-2">
        <Show
          when={props.families.length > 0}
          fallback={<div class="px-2 py-1 text-xs text-gray-10">{tr("session.no_artifacts")}</div>}
        >
          <For each={props.families}>
            {(family) => {
              const modifiedFiles = () => family.items.filter((item) => fileGroupInteraction(item) === "modified");
              const openedFiles = () => family.items.filter((item) => fileGroupInteraction(item) === "opened");

              return (
                <section class="rounded-xl border border-gray-5/80 bg-gray-2/40">
                  <div class="flex items-center justify-between px-2 py-1.5">
                    <div class="flex items-center gap-2">
                      <div class="shrink-0">{familyIcon(family.family)}</div>
                      <div class="text-xs font-semibold text-gray-11">{familyLabel(family)}</div>
                    </div>
                    <div class="rounded-md border border-gray-5 bg-gray-1 px-1.5 py-0.5 text-[10px] font-medium text-gray-10">
                      {family.items.length}
                    </div>
                  </div>

                  <div class="space-y-1 px-2 pb-2">
                    <Show
                      when={family.family === "files"}
                      fallback={
                        <For each={family.items}>
                          {(item) => (
                            <ArtifactRow
                              item={item}
                              status={statusLabel(item.status)}
                              workspaceRoot={props.workspaceRoot}
                              canRevealArtifact={canRevealArtifact}
                              canOpenObsidian={canOpenObsidian}
                              onRevealArtifact={props.onRevealArtifact}
                              onOpenInObsidian={props.onOpenInObsidian}
                            />
                          )}
                        </For>
                      }
                    >
                      <div class="space-y-2">
                        <FileArtifactGroup
                          testId="session-artifact-files-modified"
                          label={tr("session.artifact_files_modified")}
                          icon={<FilePenLine size={12} class="text-gray-9" />}
                          items={modifiedFiles()}
                          workspaceRoot={props.workspaceRoot}
                          canRevealArtifact={canRevealArtifact}
                          canOpenObsidian={canOpenObsidian}
                          onRevealArtifact={props.onRevealArtifact}
                          onOpenInObsidian={props.onOpenInObsidian}
                        />
                        <FileArtifactGroup
                          testId="session-artifact-files-opened"
                          label={tr("session.artifact_files_opened")}
                          icon={<FileSearch size={12} class="text-gray-9" />}
                          items={openedFiles()}
                          workspaceRoot={props.workspaceRoot}
                          canRevealArtifact={canRevealArtifact}
                          canOpenObsidian={canOpenObsidian}
                          onRevealArtifact={props.onRevealArtifact}
                          onOpenInObsidian={props.onOpenInObsidian}
                        />
                      </div>
                    </Show>
                  </div>
                </section>
              );
            }}
          </For>
        </Show>
      </div>
    </div>
  );
}
