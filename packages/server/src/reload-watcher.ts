import { existsSync, watch, type FSWatcher } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

import type { ReloadEventStore } from "./events.js";
import type { ReloadEvent, ReloadReason, ReloadTrigger, ServerConfig, WorkspaceInfo } from "./types.js";

type LogLevel = "info" | "warn" | "error";

type Logger = {
  log: (level: LogLevel, message: string, attributes?: Record<string, unknown>) => void;
};

type DirectoryTreeWatcher = {
  scheduleRescan: () => void;
  close: () => void;
};

export function startReloadWatchers(input: {
  config: ServerConfig;
  reloadEvents: ReloadEventStore;
  logger?: Logger | null;
  debounceMs?: number;
  onReloadEvent?: (workspace: WorkspaceInfo, event: ReloadEvent) => void;
  onReloadHint?: (
    workspace: WorkspaceInfo,
    reason: ReloadReason,
    trigger?: ReloadTrigger,
  ) => void;
}): { close: () => void } {
  const { config, reloadEvents } = input;
  const logger = input.logger ?? null;
  const debounceMs = typeof input.debounceMs === "number" ? input.debounceMs : 750;

  const closers: Array<() => void> = [];

  for (const workspace of config.workspaces) {
    try {
      closers.push(
        startWorkspaceReloadWatcher({
          workspace,
          reloadEvents,
          logger,
          debounceMs,
          onReloadEvent: input.onReloadEvent,
          onReloadHint: input.onReloadHint,
        }),
      );
    } catch (error) {
      logger?.log("warn", "Reload watcher failed to start", {
        workspaceId: workspace.id,
        workspacePath: workspace.path,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (config.workspaces.length) {
    logger?.log("info", `Reload watcher enabled (${config.workspaces.length})`, {
      workspaceCount: config.workspaces.length,
    });
  }

  return {
    close: () => {
      for (const close of closers) {
        try {
          close();
        } catch {
          // ignore
        }
      }
    },
  };
}

function startWorkspaceReloadWatcher(input: {
  workspace: WorkspaceInfo;
  reloadEvents: ReloadEventStore;
  logger: Logger | null;
  debounceMs: number;
  onReloadEvent?: (workspace: WorkspaceInfo, event: ReloadEvent) => void;
  onReloadHint?: (
    workspace: WorkspaceInfo,
    reason: ReloadReason,
    trigger?: ReloadTrigger,
  ) => void;
}): () => void {
  const { workspace, reloadEvents, logger, debounceMs } = input;
  const root = resolve(workspace.path);

  const trees: DirectoryTreeWatcher[] = [];
  const closeAll = () => {
    for (const tree of trees) {
      tree.close();
    }
    rootWatcher?.close();
  };

  const record = (reason: ReloadReason, trigger?: ReloadTrigger) => {
    input.onReloadHint?.(workspace, reason, trigger);
    const event = reloadEvents.recordDebounced(
      workspace.id,
      reason,
      trigger,
      debounceMs,
    );
    if (event) input.onReloadEvent?.(workspace, event);
  };

  // Watch the workspace root for top-level config files.
  let rootWatcher: FSWatcher | null = null;
  if (existsSync(root)) {
    try {
      rootWatcher = watch(
        root,
        { persistent: false },
        (_eventType, filename) => {
          const raw = filename ? filename.toString() : "";
          const name = raw.trim();
          if (!name) {
            for (const tree of trees) tree.scheduleRescan();
            return;
          }

          if (name === "opencode.json" || name === "opencode.jsonc") {
            record("config", {
              type: "config",
              name,
              action: "updated",
              path: join(root, name),
            });
            return;
          }

          if (name === "AGENTS.md") {
            record("agents", {
              type: "agent",
              action: "updated",
              path: join(root, name),
            });
            return;
          }

          // If a supported skill-root parent is created or removed, rescan the
          // relevant trees so roots introduced after startup are watched too.
          if ([".opencode", ".claude", ".agents", ".agent"].includes(name)) {
            if (name !== ".opencode") {
              record("skills", {
                type: "skill",
                action: "updated",
                path: join(root, name),
              });
            }
            for (const tree of trees) tree.scheduleRescan();
          }
        },
      );
      rootWatcher.on("error", (error) => {
        logger?.log("warn", "Reload watcher root error", {
          workspaceId: workspace.id,
          workspacePath: root,
          reasonCode: "watcher_overflow",
          error: error instanceof Error ? error.message : String(error),
        });
        // A watcher error means its event stream is no longer authoritative.
        // Publish a conservative skills hint and rebuild every recursive tree.
        record("skills", {
          type: "skill",
          action: "updated",
          path: root,
        });
        for (const tree of trees) tree.scheduleRescan();
      });
    } catch (error) {
      logger?.log("warn", "Reload watcher root failed", {
        workspaceId: workspace.id,
        workspacePath: root,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const opencodeRoot = join(root, ".opencode");

  trees.push(
    createDirectoryTreeWatcher({
      rootDir: join(opencodeRoot, "skills"),
      workspace,
      reloadEvents,
      reason: "skills",
      triggerType: "skill",
      debounceMs,
      logger,
      onReloadEvent: input.onReloadEvent,
      onReloadHint: input.onReloadHint,
    }),
  );
  // The effective runtime view accepts all four workspace-local skill roots.
  // Watch each one recursively so a direct-source edit is scoped to its own
  // workspace instead of being discovered only on a later unrelated reload.
  for (const rootDir of [
    join(root, ".claude", "skills"),
    join(root, ".agents", "skills"),
    join(root, ".agent", "skills"),
  ]) {
    trees.push(
      createDirectoryTreeWatcher({
        rootDir,
        workspace,
        reloadEvents,
        reason: "skills",
        triggerType: "skill",
        debounceMs,
        logger,
        onReloadEvent: input.onReloadEvent,
        onReloadHint: input.onReloadHint,
      }),
    );
  }
  trees.push(
    createDirectoryTreeWatcher({
      rootDir: join(opencodeRoot, "commands"),
      workspace,
      reloadEvents,
      reason: "commands",
      triggerType: "command",
      debounceMs,
      logger,
      onReloadEvent: input.onReloadEvent,
      onReloadHint: input.onReloadHint,
    }),
  );
  trees.push(
    createDirectoryTreeWatcher({
      rootDir: join(opencodeRoot, "plugins"),
      workspace,
      reloadEvents,
      reason: "plugins",
      triggerType: "plugin",
      debounceMs,
      logger,
      onReloadEvent: input.onReloadEvent,
      onReloadHint: input.onReloadHint,
    }),
  );
  trees.push(
    createDirectoryTreeWatcher({
      rootDir: join(opencodeRoot, "agents"),
      workspace,
      reloadEvents,
      reason: "agents",
      triggerType: "agent",
      debounceMs,
      logger,
      onReloadEvent: input.onReloadEvent,
      onReloadHint: input.onReloadHint,
    }),
  );
  trees.push(
    createDirectoryTreeWatcher({
      rootDir: join(opencodeRoot, "agent"),
      workspace,
      reloadEvents,
      reason: "agents",
      triggerType: "agent",
      debounceMs,
      logger,
      onReloadEvent: input.onReloadEvent,
      onReloadHint: input.onReloadHint,
    }),
  );

  // Kick off an initial scan so we start watching existing trees.
  for (const tree of trees) {
    tree.scheduleRescan();
  }

  return closeAll;
}

function createDirectoryTreeWatcher(input: {
  rootDir: string;
  workspace: WorkspaceInfo;
  reloadEvents: ReloadEventStore;
  reason: ReloadReason;
  triggerType: ReloadTrigger["type"];
  debounceMs: number;
  logger: Logger | null;
  onReloadEvent?: (workspace: WorkspaceInfo, event: ReloadEvent) => void;
  onReloadHint?: (
    workspace: WorkspaceInfo,
    reason: ReloadReason,
    trigger?: ReloadTrigger,
  ) => void;
}): DirectoryTreeWatcher {
  const { rootDir, workspace, reloadEvents, reason, triggerType, debounceMs, logger } = input;
  const resolvedRoot = resolve(rootDir);

  const watchers = new Map<string, FSWatcher>();
  let closed = false;
  let scanTimer: ReturnType<typeof setTimeout> | null = null;
  let scanning = false;
  let rescanRequested = false;
  let lastRootExists = existsSync(resolvedRoot);

  const close = () => {
    if (closed) return;
    closed = true;
    if (scanTimer) {
      clearTimeout(scanTimer);
      scanTimer = null;
    }
    for (const watcher of watchers.values()) {
      try {
        watcher.close();
      } catch {
        // ignore
      }
    }
    watchers.clear();
  };

  const record = (path: string) => {
    const trigger: ReloadTrigger = {
      type: triggerType,
      action: "updated",
      path,
    };

    if (reason === "skills" || reason === "commands" || reason === "agents") {
      const rel = path.slice(resolvedRoot.length).replace(/^[/\\]+/, "");
      const name = rel.split(/[/\\]+/).filter(Boolean)[0] ?? "";
      if (name) {
        trigger.name = reason === "commands" ? name.replace(/\.md$/i, "") : name;
      }
    }

    input.onReloadHint?.(workspace, reason, trigger);
    const event = reloadEvents.recordDebounced(workspace.id, reason, trigger, debounceMs);
    if (event) input.onReloadEvent?.(workspace, event);
  };

  const shouldIgnoreEntry = (absPath: string) => {
    const base = basename(absPath);
    if (!base) return true;
    if (base === ".DS_Store" || base === "Thumbs.db") return true;
    return false;
  };

  const shouldSkipDir = (name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return true;
    if (trimmed === ".git" || trimmed === "node_modules") return true;
    return false;
  };

  const ensureWatcher = (dir: string) => {
    if (watchers.has(dir)) return;
    try {
      const watcher = watch(
        dir,
        { persistent: false },
        (_eventType, filename) => {
          if (closed) return;
          const raw = filename ? filename.toString() : "";
          const name = raw.trim();
          const absPath = name ? join(dir, name) : dir;
          if (!shouldIgnoreEntry(absPath)) {
            record(absPath);
          }
          scheduleRescan();
        },
      );
      watcher.on("error", (error) => {
        logger?.log("warn", "Reload watcher dir error", {
          workspaceId: workspace.id,
          reason,
          dir,
          reasonCode: "watcher_overflow",
          error: error instanceof Error ? error.message : String(error),
        });
        // Treat an errored directory watcher as an overflow/missed-event
        // boundary: trigger the same reconciliation path and rebuild the
        // complete watched tree before relying on events again.
        record(resolvedRoot);
        scheduleRescan();
      });
      watchers.set(dir, watcher);
    } catch (error) {
      logger?.log("warn", "Reload watcher dir failed", {
        workspaceId: workspace.id,
        reason,
        dir,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  const scanDirs = async (): Promise<Set<string>> => {
    const dirs = new Set<string>();
    const stack = [resolvedRoot];
    while (stack.length) {
      const dir = stack.pop();
      if (!dir) continue;
      dirs.add(dir);
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        if (shouldSkipDir(entry.name)) continue;
        stack.push(join(dir, entry.name));
      }
    }
    return dirs;
  };

  const scan = async () => {
    if (closed) return;
    if (scanning) {
      rescanRequested = true;
      return;
    }
    scanning = true;
    try {
      const existsNow = existsSync(resolvedRoot);
      if (existsNow !== lastRootExists) {
        lastRootExists = existsNow;
        const trigger: ReloadTrigger = {
          type: triggerType,
          action: "updated",
          path: resolvedRoot,
        };
        input.onReloadHint?.(workspace, reason, trigger);
        const event = reloadEvents.recordDebounced(
          workspace.id,
          reason,
          trigger,
          debounceMs,
        );
        if (event) input.onReloadEvent?.(workspace, event);
      }
      if (!existsNow) {
        for (const watcher of watchers.values()) {
          try {
            watcher.close();
          } catch {
            // ignore
          }
        }
        watchers.clear();
        return;
      }

      const dirs = await scanDirs();
      for (const dir of dirs) {
        ensureWatcher(dir);
      }
      for (const dir of Array.from(watchers.keys())) {
        if (!dirs.has(dir)) {
          const watcher = watchers.get(dir);
          try {
            watcher?.close();
          } catch {
            // ignore
          }
          watchers.delete(dir);
        }
      }
    } finally {
      scanning = false;
      if (rescanRequested) {
        rescanRequested = false;
        scheduleRescan();
      }
    }
  };

  const scheduleRescan = () => {
    if (closed) return;
    if (scanTimer) return;
    scanTimer = setTimeout(() => {
      scanTimer = null;
      void scan();
    }, 200);
  };

  return { scheduleRescan, close };
}
