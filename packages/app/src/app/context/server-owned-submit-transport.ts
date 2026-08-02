import type { SendRuntimePreflightTargetWorkspace } from "./send-runtime-readiness";

type LocalWorkspaceCandidate = {
  id?: string | null;
  workspaceType?: string | null;
  path?: string | null;
  directory?: string | null;
};

export type ServerOwnedSubmitTransportTarget =
  | { kind: "skip"; reason: "non-tauri" | "non-local-workspace" }
  | {
      kind: "local";
      workspaceId: string;
      workspacePath: string;
    }
  | {
      kind: "unavailable";
    reason: "missing-target" | "workspace-not-found" | "missing-workspace-root";
  };

type TransportTrace = (event: string, payload: Record<string, unknown>) => void;

export type ControlPlaneBindingStatus = {
  matches: boolean;
  reason: string;
};

export function classifyAdmissionTransportError(error: unknown): string {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  if (message.includes("did not become ready")) return "daemon-not-ready";
  if (message.includes("without a workspace proxy descriptor")) {
    return "proxy-descriptor-missing";
  }
  if (message.includes("lifecycle credentials")) {
    return "lifecycle-credentials-missing";
  }
  if (message.includes("credentials could not be persisted")) {
    return "credentials-persist-failed";
  }
  if (message.includes("OpenCode CLI is unavailable")) {
    return "opencode-cli-unavailable";
  }
  if (message.includes("Bundled OpenCode sidecar is unavailable")) {
    return "bundled-sidecar-unavailable";
  }
  return "unknown";
}

export type EnsureServerOwnedSubmitTransportInput = {
  isTauriRuntime: boolean;
  targetWorkspace?: SendRuntimePreflightTargetWorkspace | null;
  workspaces: readonly LocalWorkspaceCandidate[];
  traceId?: string | null;
  ensureAdmissionTransport: (input: {
    workspaceId: string;
    workspacePath: string;
  }) => Promise<unknown>;
  ensureLocalVesloServerRunning: (input: {
    requireRuntimeChainReady: false;
    forceRestart?: false;
  }) => Promise<boolean>;
  inspectControlPlaneBinding: (workspaceId: string) => Promise<ControlPlaneBindingStatus>;
  rebindControlPlane: (workspaceId: string) => Promise<boolean>;
  recordTrace?: TransportTrace;
};

/**
 * The daemon-only admission port belongs exclusively to a local desktop
 * workspace. Remote and browser submits already have their own server route
 * and must never attempt a Tauri filesystem/runtime operation.
 */
export function resolveServerOwnedSubmitTransportTarget(input: {
  isTauriRuntime: boolean;
  targetWorkspace?: SendRuntimePreflightTargetWorkspace | null;
  workspaces: readonly LocalWorkspaceCandidate[];
}): ServerOwnedSubmitTransportTarget {
  if (!input.isTauriRuntime) return { kind: "skip", reason: "non-tauri" };

  const workspaceId = input.targetWorkspace?.workspaceId?.trim() ?? "";
  if (!workspaceId) return { kind: "unavailable", reason: "missing-target" };

  const workspace =
    input.workspaces.find((candidate) => candidate.id?.trim() === workspaceId) ??
    null;
  if (!workspace) return { kind: "unavailable", reason: "workspace-not-found" };
  if (workspace.workspaceType !== "local") {
    return { kind: "skip", reason: "non-local-workspace" };
  }

  const workspacePath = workspace.path?.trim() || workspace.directory?.trim() || "";
  if (!workspacePath) {
    return { kind: "unavailable", reason: "missing-workspace-root" };
  }
  return { kind: "local", workspaceId, workspacePath };
}

/**
 * A server-owned first submit needs the desktop admission daemon and a Veslo
 * server configured with that daemon's current lifecycle token. The server
 * itself decides whether a missing binding may be repaired: the app may only
 * ask for the server-owned control-plane operation after it has confirmed that
 * the daemon exists.
 */
export async function ensureServerOwnedSubmitTransport(
  input: EnsureServerOwnedSubmitTransportInput,
): Promise<boolean> {
  const target = resolveServerOwnedSubmitTransportTarget(input);
  const trace = (event: string, payload: Record<string, unknown>) => {
    input.recordTrace?.(event, {
      traceId: input.traceId ?? null,
      ...payload,
    });
  };
  if (target.kind === "skip") {
    trace("runtime-readiness:admission-transport:skipped", { reason: target.reason });
    return true;
  }
  if (target.kind === "unavailable") {
    trace("runtime-readiness:admission-transport:unavailable", { reason: target.reason });
    return false;
  }

  const { workspaceId, workspacePath } = target;
  trace("runtime-readiness:admission-transport:start", {
    workspaceId,
    readiness: "admission-transport-starting",
  });
  try {
    await input.ensureAdmissionTransport({ workspaceId, workspacePath });
  } catch (error) {
    trace("runtime-readiness:admission-transport:error", {
      workspaceId,
      errorType: error instanceof Error ? error.name : typeof error,
      errorCode: classifyAdmissionTransportError(error),
    });
    return false;
  }

  trace("runtime-readiness:admission-transport:daemon-ready", {
    workspaceId,
    readiness: "admission-transport-ready",
  });
  try {
    let ready = await input.ensureLocalVesloServerRunning({
      requireRuntimeChainReady: false,
    });
    if (!ready) {
      trace("runtime-readiness:admission-transport:end", {
        workspaceId,
        ready: false,
        readiness: "service-unavailable",
      });
      return false;
    }

    const binding = await input.inspectControlPlaneBinding(workspaceId);
    if (!binding.matches) {
      trace("runtime-readiness:admission-transport:binding-missing", {
        workspaceId,
        bindingReason: binding.reason,
      });
      const rebound = await input.rebindControlPlane(workspaceId);
      if (!rebound) {
        trace("runtime-readiness:admission-transport:end", {
          workspaceId,
          ready: false,
          readiness: "control-plane-rebind-unavailable",
        });
        return false;
      }
      ready = await input.ensureLocalVesloServerRunning({
        requireRuntimeChainReady: false,
      });
      const reboundBinding = ready
        ? await input.inspectControlPlaneBinding(workspaceId)
        : { matches: false, reason: "server-unavailable" };
      if (!reboundBinding.matches) {
        trace("runtime-readiness:admission-transport:end", {
          workspaceId,
          ready: false,
          readiness: "control-plane-binding-unconfirmed",
          bindingReason: reboundBinding.reason,
        });
        return false;
      }
    }
    trace("runtime-readiness:admission-transport:end", {
      workspaceId,
      ready,
      readiness: ready ? "service-ready" : "service-unavailable",
    });
    return ready;
  } catch (error) {
    trace("runtime-readiness:admission-transport:service-error", {
      workspaceId,
      errorType: error instanceof Error ? error.name : "unknown",
    });
    throw error;
  }
}
