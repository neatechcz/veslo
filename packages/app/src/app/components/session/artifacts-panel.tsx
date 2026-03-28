import { For, Show, createMemo } from "solid-js";
import { FolderSearch, HeartPulse, PlugZap, Sparkles } from "lucide-solid";
import type { JSX } from "solid-js";

import type { ArtifactFamily, ArtifactFamilyId, ArtifactFamilyItem } from "./artifact-family-model";

export type ArtifactsPanelProps = {
  families: ArtifactFamily[];
  workspaceRoot?: string;
  onRevealArtifact?: (path: string) => void;
  onOpenInObsidian?: (path: string) => void;
  obsidianAvailable?: boolean;
  id?: string;
};

const normalizePath = (value: string) => value.trim().replace(/[\\/]+/g, "/");
const splitPathSegments = (value: string) => value.split(/[/\\]/).filter(Boolean);

const toWorkspaceRelative = (file: string, root?: string) => {
  const normalizedRoot = (root ?? "").trim().replace(/[\\/]+/g, "/").replace(/\/+$/, "");
  if (!normalizedRoot) return file;

  const normalizedFile = file.replace(/[\\/]+/g, "/");
  const rootKey = normalizedRoot.toLowerCase();
  const fileKey = normalizedFile.toLowerCase();

  if (fileKey === rootKey) return normalizedFile.split("/").pop() ?? normalizedFile;
  if (fileKey.startsWith(`${rootKey}/`)) return normalizedFile.slice(normalizedRoot.length + 1);
  return normalizedFile;
};

const getBasename = (value: string) => {
  const segments = splitPathSegments(value);
  return segments[segments.length - 1] ?? value;
};

const isMarkdown = (value: string) => /\.(md|mdx|markdown)$/i.test(value);

const statusLabel = (value: string) => {
  if (value === "scanned") return "Scanned";
  if (value === "updated") return "Updated";
  if (value === "created") return "Created";
  if (value === "exported") return "Exported";
  if (value === "used") return "Used";
  if (value === "active") return "Active";
  return value;
};

const familyIcon = (family: ArtifactFamilyId): JSX.Element => {
  if (family === "files") return <FolderSearch size={14} class="text-gray-10" />;
  if (family === "skills") return <Sparkles size={14} class="text-gray-10" />;
  if (family === "mcp") return <PlugZap size={14} class="text-gray-10" />;
  return <HeartPulse size={14} class="text-gray-10" />;
};

export default function ArtifactsPanel(props: ArtifactsPanelProps) {
  const totalCount = createMemo(() =>
    props.families.reduce((sum, family) => sum + family.items.length, 0),
  );
  const canRevealArtifact = createMemo(() => typeof props.onRevealArtifact === "function");
  const canOpenObsidian = createMemo(
    () => Boolean(props.obsidianAvailable) && typeof props.onOpenInObsidian === "function",
  );

  const subtitleText = (item: ArtifactFamilyItem) => {
    if (item.path) return toWorkspaceRelative(item.path, props.workspaceRoot);
    const subtitle = item.subtitle?.trim();
    if (subtitle) return subtitle;
    const sourceName = item.sourceName?.trim();
    if (sourceName) return sourceName;
    return "";
  };

  return (
    <div id={props.id}>
      <div class="mb-3 flex items-center justify-between px-2">
        <span class="text-[11px] font-semibold uppercase tracking-wider text-gray-10">Artifacts</span>
        <Show when={totalCount() > 0}>
          <span class="rounded bg-gray-4/60 px-1.5 text-[11px] font-medium text-gray-10">
            {totalCount()}
          </span>
        </Show>
      </div>

      <div class="space-y-2">
        <Show
          when={props.families.length > 0}
          fallback={<div class="px-2 py-1 text-xs text-gray-10">No artifacts yet.</div>}
        >
          <For each={props.families}>
            {(family) => (
              <section class="rounded-xl border border-gray-5/80 bg-gray-2/40">
                <div class="flex items-center justify-between px-2 py-1.5">
                  <div class="flex items-center gap-2">
                    <div class="shrink-0">{familyIcon(family.family)}</div>
                    <div class="text-xs font-semibold text-gray-11">{family.label}</div>
                  </div>
                  <div class="rounded-md border border-gray-5 bg-gray-1 px-1.5 py-0.5 text-[10px] font-medium text-gray-10">
                    {family.items.length}
                  </div>
                </div>

                <div class="space-y-1 px-2 pb-2">
                  <For each={family.items}>
                    {(item) => {
                      const subtitle = () => subtitleText(item);
                      const canReveal = () => Boolean(item.path) && canRevealArtifact();
                      const canOpenMd = () => Boolean(item.path) && isMarkdown(item.path ?? "") && canOpenObsidian();
                      const displayTitle = () => {
                        if (item.path) {
                          return getBasename(normalizePath(item.path));
                        }
                        return item.title;
                      };

                      return (
                        <div
                          class="group flex items-start gap-2 rounded-lg border border-transparent px-2 py-1.5 transition-colors hover:border-gray-6/80 hover:bg-gray-1/70"
                          title={subtitle() || item.title}
                        >
                          <div class="min-w-0 flex-1">
                            <div class="flex items-center gap-2">
                              <div class="truncate text-xs font-medium text-gray-11">{displayTitle()}</div>
                              <div class="shrink-0 rounded-md border border-gray-6 bg-gray-2 px-1.5 py-0.5 text-[10px] font-medium text-gray-10">
                                {statusLabel(item.status)}
                              </div>
                            </div>
                            <Show when={subtitle()}>
                              <div class="truncate text-[11px] text-gray-9">{subtitle()}</div>
                            </Show>
                          </div>

                          <div class="flex shrink-0 items-center gap-1.5">
                            <Show when={canOpenMd()}>
                              <button
                                type="button"
                                class="rounded-md border border-gray-6 bg-gray-2 px-1.5 py-0.5 text-[10px] font-medium text-gray-10 transition-colors hover:border-gray-7 hover:text-gray-12"
                                onClick={() => item.path && props.onOpenInObsidian?.(item.path)}
                                title="Open in Obsidian"
                              >
                                Obsidian
                              </button>
                            </Show>
                            <Show when={canReveal()}>
                              <button
                                type="button"
                                class="rounded-md border border-gray-6 bg-gray-2 px-1.5 py-0.5 text-[10px] font-medium text-gray-10 transition-colors hover:border-gray-7 hover:text-gray-12"
                                onClick={() => item.path && props.onRevealArtifact?.(item.path)}
                                title="Reveal file"
                              >
                                Reveal
                              </button>
                            </Show>
                          </div>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </section>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
}
