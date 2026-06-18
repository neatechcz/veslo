import type { Accessor } from "solid-js";

import type { OpencodeAuth } from "../lib/opencode";
import type { OpencodeConnectStatus } from "../types";
import type { WorkspaceInfo } from "../lib/tauri";
import type { WorkspaceRouting } from "./workspace-routing";
import type {
  WorkspaceConnectContext,
  WorkspaceConnectOptions,
} from "./workspace-types";

export type WorkspaceConnectionControllerDeps = {
  routing: WorkspaceRouting;
  activeWorkspaceId: Accessor<string>;
  activeWorkspaceRoot: Accessor<string>;
  activeWorkspaceType: Accessor<WorkspaceInfo["workspaceType"] | null>;
  baseUrl: Accessor<string>;
  client: Accessor<unknown>;
  clientDirectory: Accessor<string>;
  selectedSessionId: Accessor<string | null>;
  normalizeWorkspaceScopePath: (
    value?: string | null,
    workspaceType?: WorkspaceInfo["workspaceType"] | null,
  ) => string;
  setClient: (value: any) => void;
  setConnectedVersion: (value: string | null) => void;
  setBaseUrl: (value: string) => void;
  setClientDirectory: (value: string) => void;
  setError: (value: string | null) => void;
  setBusy: (value: boolean) => void;
  setBusyLabel: (value: string | null) => void;
  setBusyStartedAt: (value: number | null) => void;
  setSseConnected: (value: boolean) => void;
  setTab: (value: any) => void;
  setView: (value: any) => void;
  setOpencodeConnectStatus?: (status: OpencodeConnectStatus | null) => void;
  loadSessions: (scopeRoot?: string) => Promise<void>;
  refreshPendingPermissions: () => Promise<void>;
  onEngineStable?: () => void;
  wsDebug: (label: string, payload?: unknown) => void;
};

const connectRequestKey = (
  normalizeWorkspaceScopePath: WorkspaceConnectionControllerDeps["normalizeWorkspaceScopePath"],
  nextBaseUrl: string,
  directory?: string,
  context?: WorkspaceConnectContext,
  auth?: OpencodeAuth,
  connectOptions?: WorkspaceConnectOptions,
) =>
  [
    nextBaseUrl.trim(),
    normalizeWorkspaceScopePath(directory ?? "", context?.workspaceType),
    context?.workspaceId?.trim() ?? "",
    context?.workspaceType ?? "",
    normalizeWorkspaceScopePath(context?.targetRoot ?? "", context?.workspaceType),
    context?.reason ?? "",
    auth?.mode ?? (auth ? "basic" : "none"),
    String(connectOptions?.quiet ?? false),
    String(connectOptions?.navigate ?? true),
  ].join("::");

export function createWorkspaceConnectionController(
  deps: WorkspaceConnectionControllerDeps,
) {
  const connectInFlightByKey = new Map<string, Promise<boolean>>();

  const commitRoutedClient = (
    entry: { client: unknown; directory?: string | null },
    nextBaseUrl: string,
    incomingDirectory: string,
  ) => {
    deps.setClient(entry.client);
    deps.setConnectedVersion(null);
    deps.setBaseUrl(nextBaseUrl);
    deps.setClientDirectory(entry.directory ?? incomingDirectory);
  };

  const runPostConnectSideEffects = async (
    context: WorkspaceConnectContext | undefined,
    navigate: boolean,
  ) => {
    try {
      await deps.loadSessions(context?.targetRoot);
    } catch (error) {
      console.warn("[workspace] multi loadSessions failed", error);
    }
    try {
      await deps.refreshPendingPermissions();
    } catch (error) {
      console.warn("[workspace] multi refreshPendingPermissions failed", error);
    }
    if (navigate && !deps.selectedSessionId()) {
      deps.setTab("scheduled");
      deps.setView("session");
    }
    deps.onEngineStable?.();
  };

  async function connectToServer(
    nextBaseUrl: string,
    directory?: string,
    context?: WorkspaceConnectContext,
    auth?: OpencodeAuth,
    connectOptions?: WorkspaceConnectOptions,
  ) {
    const requestKey = connectRequestKey(
      deps.normalizeWorkspaceScopePath,
      nextBaseUrl,
      directory,
      context,
      auth,
      connectOptions,
    );
    const existing = connectInFlightByKey.get(requestKey);
    if (existing) {
      deps.wsDebug("connect:dedupe", {
        baseUrl: nextBaseUrl,
        directory: directory ?? null,
        reason: context?.reason ?? null,
        workspaceType: context?.workspaceType ?? null,
      });
      return existing;
    }

    const incomingDirectory = directory?.trim() ?? "";
    const connectWorkspaceType = context?.workspaceType ?? deps.activeWorkspaceType();
    const incomingDirectoryScope = deps.normalizeWorkspaceScopePath(
      incomingDirectory,
      connectWorkspaceType,
    );
    const activeRoot = deps.activeWorkspaceRoot().trim();
    const activeRootScope = deps.normalizeWorkspaceScopePath(activeRoot, connectWorkspaceType);

    if (
      context?.workspaceType === "local" &&
      activeRootScope &&
      incomingDirectoryScope &&
      activeRootScope !== incomingDirectoryScope
    ) {
      deps.wsDebug("connect:abort-stale-workspace", {
        baseUrl: nextBaseUrl,
        directory: incomingDirectory,
        directoryScope: incomingDirectoryScope,
        activeRoot,
        activeRootScope,
        reason: context?.reason ?? null,
      });
      console.log("[workspace] connect ABORT (stale workspace - user switched away)", {
        baseUrl: nextBaseUrl,
        directory: incomingDirectory,
        activeRoot,
        reason: context?.reason ?? null,
      });
      return false;
    }

    const guardWorkspaceId = (context?.workspaceId ?? deps.activeWorkspaceId() ?? "").trim();
    const cachedRoutingClient = guardWorkspaceId ? deps.routing.client(guardWorkspaceId) : null;
    if (
      !connectOptions?.forceRefresh &&
      deps.client() &&
      cachedRoutingClient &&
      (deps.baseUrl()?.trim() ?? "") === nextBaseUrl &&
      deps.normalizeWorkspaceScopePath(deps.clientDirectory(), connectWorkspaceType) === incomingDirectoryScope
    ) {
      if (deps.client() !== cachedRoutingClient) {
        commitRoutedClient({ client: cachedRoutingClient, directory: incomingDirectory }, nextBaseUrl, incomingDirectory);
      }
      deps.wsDebug("connect:idempotent-skip", {
        workspaceId: guardWorkspaceId || null,
        baseUrl: nextBaseUrl,
        directory: incomingDirectory || null,
        reason: context?.reason ?? null,
        reboundGlobalClient: deps.client() === cachedRoutingClient,
      });
      console.log("[workspace] connect SKIP (idempotent - already connected)", {
        baseUrl: nextBaseUrl,
        directory: incomingDirectory || null,
        reason: context?.reason ?? null,
      });
      return true;
    }

    const workspaceId = context?.workspaceId ?? deps.activeWorkspaceId().trim() ?? "";
    if (!workspaceId) {
      deps.wsDebug("connect:no-workspace-id", {
        baseUrl: nextBaseUrl,
        directory: directory ?? null,
      });
      deps.setError("Connect requires a workspace id");
      return false;
    }

    const connectAttempt = (async () => {
      const connectStart = Date.now();
      const quiet = connectOptions?.quiet ?? false;
      const quietPortRefresh = quiet && context?.reason === "port-rotation";
      const navigate = connectOptions?.navigate ?? true;
      if (!quiet) {
        deps.setError(null);
        deps.setBusy(true);
        deps.setBusyLabel("status.connecting");
        deps.setBusyStartedAt(Date.now());
        deps.setSseConnected(false);
      }
      deps.wsDebug("connect:multi:start", {
        workspaceId,
        baseUrl: nextBaseUrl,
        directory: incomingDirectory || null,
        reason: context?.reason ?? null,
      });

      try {
        const entry = await deps.routing.ensure(
          workspaceId,
          nextBaseUrl,
          {
            directory: incomingDirectory || undefined,
            auth,
            skipHealth: quietPortRefresh,
            context: {
              workspaceType: context?.workspaceType,
              targetRoot: context?.targetRoot,
              reason: context?.reason,
            },
          },
        );
        if (!entry) {
          const detail = deps.routing.lastEnsureError(workspaceId);
          const message = detail
            ? `Failed to ensure workspace client: ${detail}`
            : "Failed to ensure workspace client";
          deps.setError(message);
          deps.setOpencodeConnectStatus?.({
            at: Date.now(),
            baseUrl: nextBaseUrl,
            directory: directory ?? null,
            reason: context?.reason ?? null,
            status: "error",
            error: message,
          });
          return false;
        }

        const currentActiveId = deps.activeWorkspaceId().trim();
        const currentActiveRoot = deps.activeWorkspaceRoot().trim();
        const currentActiveRootScope = deps.normalizeWorkspaceScopePath(
          currentActiveRoot,
          connectWorkspaceType,
        );
        if (
          context?.workspaceType === "local" &&
          ((currentActiveId && currentActiveId !== workspaceId) ||
            (currentActiveRootScope &&
              incomingDirectoryScope &&
              currentActiveRootScope !== incomingDirectoryScope))
        ) {
          deps.wsDebug("connect:abort-stale-after-ensure", {
            workspaceId,
            activeWorkspaceId: currentActiveId || null,
            baseUrl: nextBaseUrl,
            directory: incomingDirectory || null,
            directoryScope: incomingDirectoryScope || null,
            activeRoot: currentActiveRoot || null,
            activeRootScope: currentActiveRootScope || null,
            reason: context?.reason ?? null,
            ms: Date.now() - connectStart,
          });
          console.log("[workspace] connect ABORT (stale workspace after ensure)", {
            workspaceId,
            activeWorkspaceId: currentActiveId || null,
            baseUrl: nextBaseUrl,
            directory: incomingDirectory || null,
            activeRoot: currentActiveRoot || null,
            reason: context?.reason ?? null,
          });
          return false;
        }

        commitRoutedClient(entry, nextBaseUrl, incomingDirectory);
        deps.wsDebug("connect:ensured", {
          workspaceId,
          ms: Date.now() - connectStart,
        });

        if (quietPortRefresh) {
          deps.wsDebug("connect:proxy-bound", {
            workspaceId,
            ms: Date.now() - connectStart,
            reason: context?.reason ?? null,
          });
          return true;
        }

        await runPostConnectSideEffects(context, navigate);
        deps.setOpencodeConnectStatus?.({
          at: Date.now(),
          baseUrl: nextBaseUrl,
          directory: directory ?? null,
          reason: context?.reason ?? null,
          status: "connected",
          error: null,
        });
        return true;
      } catch (error) {
        const message = error instanceof Error ? error.message : "Unknown connect error";
        deps.setError(message);
        deps.setOpencodeConnectStatus?.({
          at: Date.now(),
          baseUrl: nextBaseUrl,
          directory: directory ?? null,
          reason: context?.reason ?? null,
          status: "error",
          error: message,
        });
        return false;
      } finally {
        if (!quiet) {
          deps.setBusy(false);
          deps.setBusyLabel(null);
          deps.setBusyStartedAt(null);
        }
      }
    })();

    connectInFlightByKey.set(requestKey, connectAttempt);
    try {
      return await connectAttempt;
    } finally {
      if (connectInFlightByKey.get(requestKey) === connectAttempt) {
        connectInFlightByKey.delete(requestKey);
      }
    }
  }

  return { connectToServer };
}
