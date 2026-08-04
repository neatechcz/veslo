import { randomUUID } from "node:crypto";

export type E2eEventStreamOwner = {
  workspaceId: string;
  engineOwnerId: string;
  directoryInstanceEpoch: number | null;
  enginePid: number | null;
  engineStartedAt: number | null;
};

export type E2eEventStreamGateSnapshot = E2eEventStreamOwner & {
  gateId: string;
  connectionId: string;
  armedAt: number;
  blockedReconnectAttempts: number;
};

export type E2eEventStreamGateTrace = (
  event: string,
  payload: Record<string, unknown>,
) => void;

type ActiveConnection = E2eEventStreamOwner & {
  connectionId: string;
  disconnect: () => void;
};

export type E2eEventStreamGateReleaseKind = "explicit" | "auto";

type ArmedGate = E2eEventStreamGateSnapshot & {
  releasePromise: Promise<void>;
  resolveRelease: () => void;
  autoReleaseTimer: unknown;
  releaseKind: E2eEventStreamGateReleaseKind | null;
};

/**
 * A scenario that dies between arm and release must not leave the workspace
 * unable to reconnect for the rest of the orchestrator's life. Fail-closed
 * belongs to the test, not to the runtime, so an armed gate always releases
 * itself eventually and says so in the trace.
 */
const AUTO_RELEASE_DEFAULT_MS = 120_000;

export class E2eEventStreamGateError extends Error {
  constructor(
    readonly code:
      | "event_stream_gate_already_armed"
      | "event_stream_gate_not_armed"
      | "event_stream_gate_id_mismatch"
      | "event_stream_gate_active_connection_missing"
      | "event_stream_gate_active_connection_ambiguous"
      | "event_stream_gate_connection_registered_while_armed"
      | "event_stream_gate_disconnect_failed",
    message: string,
  ) {
    super(message);
    this.name = "E2eEventStreamGateError";
  }
}

const normalized = (value: string) => value.trim();

const sameOwner = (left: E2eEventStreamOwner, right: E2eEventStreamOwner) =>
  left.workspaceId === right.workspaceId &&
  left.engineOwnerId === right.engineOwnerId &&
  left.directoryInstanceEpoch === right.directoryInstanceEpoch &&
  left.enginePid === right.enginePid &&
  left.engineStartedAt === right.engineStartedAt;

export class E2eEventStreamGate {
  private readonly activeConnectionsByWorkspace = new Map<string, Map<string, ActiveConnection>>();
  private armedGate: ArmedGate | null = null;

  constructor(private readonly deps: {
    now?: () => number;
    createId?: () => string;
    trace?: E2eEventStreamGateTrace;
    autoReleaseMs?: number;
    setTimeout?: (callback: () => void, delayMs: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
  } = {}) {}

  private now() {
    return this.deps.now?.() ?? Date.now();
  }

  private createId() {
    return this.deps.createId?.() ?? randomUUID();
  }

  private trace(event: string, payload: Record<string, unknown>) {
    this.deps.trace?.(event, payload);
  }

  private scheduleAutoRelease(gate: ArmedGate) {
    const delayMs = this.deps.autoReleaseMs ?? AUTO_RELEASE_DEFAULT_MS;
    const schedule = this.deps.setTimeout ?? ((callback, ms) => setTimeout(callback, ms));
    return schedule(() => {
      if (this.armedGate !== gate) return;
      this.armedGate = null;
      gate.releaseKind = "auto";
      this.trace("orchestrator:e2e-event-stream-gate:auto-released", {
        ...this.snapshot(gate),
        autoReleasedAfterMs: delayMs,
      });
      gate.resolveRelease();
    }, delayMs);
  }

  private clearAutoRelease(gate: ArmedGate) {
    if (gate.autoReleaseTimer === null) return;
    const clear = this.deps.clearTimeout ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    clear(gate.autoReleaseTimer);
    gate.autoReleaseTimer = null;
  }

  private connectionsFor(workspaceId: string) {
    return this.activeConnectionsByWorkspace.get(workspaceId) ?? new Map<string, ActiveConnection>();
  }

  registerActiveConnection(input: E2eEventStreamOwner & {
    disconnect: () => void;
    releasedGateId?: string | null;
  }): { connectionId: string; close: () => void } {
    const workspaceId = normalized(input.workspaceId);
    if (this.armedGate?.workspaceId === workspaceId) {
      throw new E2eEventStreamGateError(
        "event_stream_gate_connection_registered_while_armed",
        `Workspace ${workspaceId} attempted to register an event stream while its E2E gate was armed`,
      );
    }

    const connectionId = this.createId();
    const connection: ActiveConnection = {
      workspaceId,
      engineOwnerId: normalized(input.engineOwnerId),
      directoryInstanceEpoch: input.directoryInstanceEpoch,
      enginePid: input.enginePid,
      engineStartedAt: input.engineStartedAt,
      connectionId,
      disconnect: input.disconnect,
    };
    const connections = this.connectionsFor(workspaceId);
    connections.set(connectionId, connection);
    this.activeConnectionsByWorkspace.set(workspaceId, connections);

    const releasedGateId = normalized(input.releasedGateId ?? "");
    if (releasedGateId) {
      this.trace("orchestrator:e2e-event-stream-gate:connection-resumed", {
        ...connection,
        disconnect: undefined,
        gateId: releasedGateId,
      });
    }

    let closed = false;
    return {
      connectionId,
      close: () => {
        if (closed) return;
        closed = true;
        const current = this.activeConnectionsByWorkspace.get(workspaceId);
        current?.delete(connectionId);
        if (current?.size === 0) this.activeConnectionsByWorkspace.delete(workspaceId);
      },
    };
  }

  arm(workspaceIdInput: string): E2eEventStreamGateSnapshot {
    const workspaceId = normalized(workspaceIdInput);
    if (this.armedGate) {
      // Only one gate exists at a time on purpose: the desktop runtime is
      // single-tenant during tests, so a second armed workspace would mean two
      // scenarios are racing rather than one scenario re-arming.
      const scope = this.armedGate.workspaceId === workspaceId
        ? `for ${workspaceId}`
        : `for a different workspace (${this.armedGate.workspaceId})`;
      throw new E2eEventStreamGateError(
        "event_stream_gate_already_armed",
        `Event stream gate ${this.armedGate.gateId} is already armed ${scope}`,
      );
    }

    const connections = [...this.connectionsFor(workspaceId).values()];
    if (connections.length === 0) {
      throw new E2eEventStreamGateError(
        "event_stream_gate_active_connection_missing",
        `Workspace ${workspaceId} has no active app-facing event stream`,
      );
    }
    if (connections.length !== 1) {
      throw new E2eEventStreamGateError(
        "event_stream_gate_active_connection_ambiguous",
        `Workspace ${workspaceId} has ${connections.length} active app-facing event streams`,
      );
    }

    const connection = connections[0]!;
    let resolveRelease!: () => void;
    const releasePromise = new Promise<void>((resolve) => {
      resolveRelease = resolve;
    });
    const armedGate: ArmedGate = {
      workspaceId,
      engineOwnerId: connection.engineOwnerId,
      directoryInstanceEpoch: connection.directoryInstanceEpoch,
      enginePid: connection.enginePid,
      engineStartedAt: connection.engineStartedAt,
      gateId: this.createId(),
      connectionId: connection.connectionId,
      armedAt: this.now(),
      blockedReconnectAttempts: 0,
      releasePromise,
      resolveRelease,
      autoReleaseTimer: null,
      releaseKind: null,
    };
    this.armedGate = armedGate;
    armedGate.autoReleaseTimer = this.scheduleAutoRelease(armedGate);
    this.trace("orchestrator:e2e-event-stream-gate:armed", this.snapshot(armedGate));

    const current = this.activeConnectionsByWorkspace.get(workspaceId);
    current?.delete(connection.connectionId);
    if (current?.size === 0) this.activeConnectionsByWorkspace.delete(workspaceId);
    try {
      connection.disconnect();
    } catch (error) {
      this.armedGate = null;
      this.clearAutoRelease(armedGate);
      armedGate.resolveRelease();
      throw new E2eEventStreamGateError(
        "event_stream_gate_disconnect_failed",
        `Failed to disconnect workspace ${workspaceId} event stream: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.trace("orchestrator:e2e-event-stream-gate:active-disconnected", this.snapshot(armedGate));
    return this.snapshot(armedGate);
  }

  async waitIfArmed(owner: E2eEventStreamOwner): Promise<
    | { kind: "not-gated" }
    | {
        kind: "released";
        gate: E2eEventStreamGateSnapshot;
        ownerMatched: boolean;
        // An expired gate must never look like a deliberate release: a scenario
        // that dies mid-gap would otherwise appear to have proven the gap.
        releaseKind: E2eEventStreamGateReleaseKind;
      }
  > {
    const gate = this.armedGate;
    if (!gate || gate.workspaceId !== normalized(owner.workspaceId)) return { kind: "not-gated" };

    gate.blockedReconnectAttempts += 1;
    const ownerMatched = sameOwner(gate, owner);
    this.trace("orchestrator:e2e-event-stream-gate:reconnect-blocked", {
      ...this.snapshot(gate),
      observedEngineOwnerId: owner.engineOwnerId,
      observedDirectoryInstanceEpoch: owner.directoryInstanceEpoch,
      observedEnginePid: owner.enginePid,
      observedEngineStartedAt: owner.engineStartedAt,
      ownerMatched,
    });
    const snapshot = this.snapshot(gate);
    await gate.releasePromise;
    return { kind: "released", gate: snapshot, ownerMatched, releaseKind: gate.releaseKind ?? "auto" };
  }

  release(workspaceIdInput: string, gateIdInput: string): E2eEventStreamGateSnapshot & { releasedAt: number } {
    const workspaceId = normalized(workspaceIdInput);
    const gateId = normalized(gateIdInput);
    const gate = this.armedGate;
    if (!gate || gate.workspaceId !== workspaceId) {
      throw new E2eEventStreamGateError(
        "event_stream_gate_not_armed",
        `Workspace ${workspaceId} has no armed event stream gate`,
      );
    }
    if (!gateId || gate.gateId !== gateId) {
      throw new E2eEventStreamGateError(
        "event_stream_gate_id_mismatch",
        `Event stream gate id did not match the armed gate for ${workspaceId}`,
      );
    }

    const released = { ...this.snapshot(gate), releasedAt: this.now() };
    this.armedGate = null;
    gate.releaseKind = "explicit";
    this.clearAutoRelease(gate);
    this.trace("orchestrator:e2e-event-stream-gate:released", released);
    gate.resolveRelease();
    return released;
  }

  status(workspaceIdInput: string): {
    workspaceId: string;
    activeConnectionCount: number;
    armed: E2eEventStreamGateSnapshot | null;
  } {
    const workspaceId = normalized(workspaceIdInput);
    return {
      workspaceId,
      activeConnectionCount: this.connectionsFor(workspaceId).size,
      armed: this.armedGate?.workspaceId === workspaceId ? this.snapshot(this.armedGate) : null,
    };
  }

  private snapshot(gate: ArmedGate): E2eEventStreamGateSnapshot {
    return {
      workspaceId: gate.workspaceId,
      engineOwnerId: gate.engineOwnerId,
      directoryInstanceEpoch: gate.directoryInstanceEpoch,
      enginePid: gate.enginePid,
      engineStartedAt: gate.engineStartedAt,
      gateId: gate.gateId,
      connectionId: gate.connectionId,
      armedAt: gate.armedAt,
      blockedReconnectAttempts: gate.blockedReconnectAttempts,
    };
  }
}
