import { For, Show, createResource, createSignal } from "solid-js";
import { FolderOpen, PlugZap, RefreshCcw } from "lucide-solid";

import { isTauriRuntime } from "../utils";
import { listLocalSkills, readOpencodeConfig, type LocalSkillCard, type WorkspaceInfo } from "../lib/tauri";

type McpEntry = {
  name: string;
  transport?: string;
};

type WorkspaceExtensions = {
  workspace: WorkspaceInfo;
  skills: LocalSkillCard[];
  mcp: McpEntry[];
  hint?: string;
  error?: string;
};

async function fetchOne(ws: WorkspaceInfo): Promise<WorkspaceExtensions> {
  if (ws.workspaceType !== "local" || !ws.path) {
    return {
      workspace: ws,
      skills: [],
      mcp: [],
      hint: "Open this workspace to manage its skills and MCP servers.",
    };
  }
  if (!isTauriRuntime()) {
    return {
      workspace: ws,
      skills: [],
      mcp: [],
      hint: "Available in the desktop app.",
    };
  }

  try {
    const [skills, config] = await Promise.all([
      listLocalSkills(ws.path).catch(() => [] as LocalSkillCard[]),
      readOpencodeConfig("project", ws.path).catch(() => null),
    ]);

    const mcp: McpEntry[] = [];
    if (config?.exists && config.content) {
      try {
        const parsed = JSON.parse(config.content) as { mcp?: Record<string, unknown> };
        if (parsed.mcp && typeof parsed.mcp === "object") {
          for (const [name, cfg] of Object.entries(parsed.mcp)) {
            const c = (cfg ?? {}) as Record<string, unknown>;
            const transport = typeof c.type === "string" ? c.type : undefined;
            mcp.push({ name, transport });
          }
        }
      } catch {
        // ignore parse errors — config may be empty or invalid
      }
    }

    return { workspace: ws, skills, mcp };
  } catch (e) {
    return {
      workspace: ws,
      skills: [],
      mcp: [],
      error: e instanceof Error ? e.message : "Failed to load",
    };
  }
}

function workspaceLabel(ws: WorkspaceInfo): string {
  const display = ws.displayName?.trim();
  if (display) return display;
  return ws.name?.trim() || ws.path || ws.id;
}

export type ExtensionsOverviewProps = {
  workspaces: WorkspaceInfo[];
};

export default function ExtensionsOverview(props: ExtensionsOverviewProps) {
  const [reloadKey, setReloadKey] = createSignal(0);

  const source = () =>
    `${reloadKey()}|${props.workspaces.map((w) => `${w.id}:${w.path}`).join(",")}`;

  const [data] = createResource(source, async () => {
    const snapshot = props.workspaces.slice();
    const results = await Promise.all(snapshot.map((w) => fetchOne(w)));
    return results;
  });

  const handleRefresh = () => setReloadKey((v) => v + 1);

  return (
    <div class="space-y-6">
      <div class="bg-gray-2/30 border border-gray-7/60 rounded-2xl p-5 space-y-4">
        <div class="flex items-start justify-between gap-4">
          <div>
            <div class="flex items-center gap-2">
              <PlugZap size={16} class="text-gray-11" />
              <div class="text-sm font-medium text-gray-12">Skills &amp; MCP</div>
              <span class="rounded-full border border-gray-6/60 bg-gray-3/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-10">
                Global
              </span>
            </div>
            <div class="text-xs text-gray-9 mt-1">
              Overview of skills and MCP servers across all known workspaces. Skill files
              are checked on disk before listing — entries without a SKILL.md are hidden.
            </div>
          </div>
          <button
            type="button"
            class="inline-flex items-center gap-1.5 rounded-md border border-dls-border bg-dls-surface px-3 py-1.5 text-xs font-medium text-dls-secondary shadow-sm transition-colors duration-150 hover:bg-dls-hover hover:text-dls-text disabled:cursor-not-allowed disabled:opacity-60"
            onClick={handleRefresh}
            disabled={data.loading}
          >
            <RefreshCcw size={14} class={data.loading ? "animate-spin" : ""} />
            Refresh
          </button>
        </div>

        <Show
          when={data.latest !== undefined}
          fallback={<div class="text-xs text-gray-9">Loading…</div>}
        >
          <Show
            when={(data.latest ?? []).length > 0}
            fallback={
              <div class="rounded-xl border border-dashed border-gray-7/50 bg-gray-1/40 px-3 py-4 text-xs text-gray-9">
                No workspaces yet.
              </div>
            }
          >
            <div class="space-y-3">
              <For each={data.latest}>
                {(entry) => (
                  <div class="rounded-xl border border-gray-6/60 bg-gray-1/40 px-4 py-3 space-y-3">
                    <div class="flex flex-wrap items-center gap-2">
                      <FolderOpen size={14} class="text-gray-11" />
                      <div class="text-sm font-medium text-gray-12">
                        {workspaceLabel(entry.workspace)}
                      </div>
                      <Show when={entry.workspace.workspaceType === "remote"}>
                        <span class="rounded-full border border-gray-6/60 bg-gray-3/40 px-2 py-0.5 text-[10px] uppercase tracking-wide text-gray-10">
                          Remote
                        </span>
                      </Show>
                      <Show when={entry.workspace.path}>
                        <span class="text-[11px] text-gray-8 truncate font-mono">
                          {entry.workspace.path}
                        </span>
                      </Show>
                    </div>

                    <Show when={entry.error}>
                      <div class="text-xs text-red-11">{entry.error}</div>
                    </Show>
                    <Show when={entry.hint && !entry.error}>
                      <div class="text-xs text-gray-9">{entry.hint}</div>
                    </Show>

                    <Show when={!entry.hint && !entry.error}>
                      <div class="grid gap-3 md:grid-cols-2">
                        <div class="rounded-lg border border-gray-6/60 bg-gray-1/60 px-3 py-2">
                          <div class="flex items-center justify-between">
                            <div class="text-[11px] uppercase tracking-wide text-gray-8">
                              Skills
                            </div>
                            <div class="text-[11px] text-gray-9">
                              {entry.skills.length}
                            </div>
                          </div>
                          <Show
                            when={entry.skills.length > 0}
                            fallback={<div class="text-xs text-gray-9 mt-1">—</div>}
                          >
                            <ul class="mt-1 space-y-1">
                              <For each={entry.skills}>
                                {(s) => (
                                  <li class="text-xs text-gray-12">
                                    <span class="font-medium">{s.name}</span>
                                    <Show when={s.description}>
                                      <span class="text-gray-9"> — {s.description}</span>
                                    </Show>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </Show>
                        </div>

                        <div class="rounded-lg border border-gray-6/60 bg-gray-1/60 px-3 py-2">
                          <div class="flex items-center justify-between">
                            <div class="text-[11px] uppercase tracking-wide text-gray-8">
                              MCP
                            </div>
                            <div class="text-[11px] text-gray-9">
                              {entry.mcp.length}
                            </div>
                          </div>
                          <Show
                            when={entry.mcp.length > 0}
                            fallback={<div class="text-xs text-gray-9 mt-1">—</div>}
                          >
                            <ul class="mt-1 space-y-1">
                              <For each={entry.mcp}>
                                {(m) => (
                                  <li class="text-xs text-gray-12">
                                    <span class="font-medium">{m.name}</span>
                                    <Show when={m.transport}>
                                      <span class="text-gray-9"> · {m.transport}</span>
                                    </Show>
                                    <span class="text-gray-9"> · Configured</span>
                                  </li>
                                )}
                              </For>
                            </ul>
                          </Show>
                        </div>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </div>
  );
}
