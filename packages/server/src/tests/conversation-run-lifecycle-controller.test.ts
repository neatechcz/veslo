import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "bun:test";

import {
  createConversationRunLifecycleController,
  type ConversationRunLifecycleController,
  type ConversationRunEngineLossResult,
  type ConversationRunLifecycleSubmitInput,
  type ConversationRunLifecycleSnapshot,
} from "../conversation-run-lifecycle-controller.js";
import { ApiError } from "../errors.js";
import {
  OrchestratorLifecycleRequestError,
  RunAlreadyActiveError,
  type LifecycleRunStatusResult,
  type OrchestratorLifecycleClient,
} from "../orchestrator-lifecycle-client.js";
import {
  ConversationRunReservationConflictError,
  type ConversationRunQueueItem,
  type ConversationRunQueueStore,
  type ConversationTerminalHandoffBarrier,
  type ConversationWorkspaceRuntimeOperation,
  type ConversationWorkspaceRunEngineOwner,
  type ConversationWorkspaceRunReservation,
} from "../conversation-run-queue-store.js";
import {
  setConversationRunLifecycleControllerFactoryForTests,
  startServer,
} from "../server.js";
import { createConversationRunOpenCodeMessageId } from "../conversation-run-message-id.js";

const tempDirs: string[] = [];
const runningServers: Array<{ stop?: (closeActiveConnections?: boolean) => void }> = [];
const envRestores: Array<() => void> = [];

afterEach(async () => {
  setConversationRunLifecycleControllerFactoryForTests(null);

  while (runningServers.length > 0) {
    const server = runningServers.pop();
    try {
      server?.stop?.(true);
    } catch {
      // ignore fixture cleanup failures
    }
  }

  while (envRestores.length > 0) {
    envRestores.pop()?.();
  }

  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (!dir) continue;
    await rm(dir, { recursive: true, force: true });
  }
});

type TimerRecord = {
  id: number;
  callback: () => void;
  delayMs: number;
  cleared: boolean;
  fired: boolean;
};

class TimerHarness {
  private nextTimerId = 1;
  readonly timers: TimerRecord[] = [];

  readonly port = {
    setTimeout: (callback: () => void, delayMs: number) => {
      const timer = {
        id: this.nextTimerId++,
        callback,
        delayMs,
        cleared: false,
        fired: false,
      };
      this.timers.push(timer);
      return timer.id;
    },
    clearTimeout: (handle: unknown) => {
      const timer = this.timers.find((candidate) => candidate.id === handle);
      if (timer) timer.cleared = true;
    },
  };

  activeTimers() {
    return this.timers.filter((timer) => !timer.cleared && !timer.fired);
  }

  fire(timerId: number) {
    const timer = this.timers.find((candidate) => candidate.id === timerId);
    if (!timer) throw new Error(`Timer ${timerId} not found`);
    timer.fired = true;
    timer.callback();
  }
}

class LifecycleHarness implements OrchestratorLifecycleClient {
  activeResult: LifecycleRunStatusResult | null = null;
  activeResults: Array<LifecycleRunStatusResult | null> = [];
  activeError: unknown = null;
  statusResult: LifecycleRunStatusResult | null = null;
  statusResults: Array<LifecycleRunStatusResult | null> = [];
  statusError: unknown = null;
  registerError: unknown = null;
  registerResult: LifecycleRunStatusResult | null = null;
  markFailedError: unknown = null;
  recoverProviderStartTimeoutError: unknown = null;
  recoverTerminalRuntimeHandoffError: unknown = null;
  onRegister: ((input: Parameters<OrchestratorLifecycleClient["register"]>[0]) => void) | null = null;
  onRecoverTerminalRuntimeHandoff: ((workspaceId: string, runId: string) => void) | null = null;
  readonly calls: string[] = [];
  readonly registerInputs: Array<Parameters<OrchestratorLifecycleClient["register"]>[0]> = [];

  private withIdleTerminalHandoff(result: LifecycleRunStatusResult | null): LifecycleRunStatusResult | null {
    if (!result || !["completed", "failed", "aborted"].includes(result.status)) return result;
    return result.runtimeReadyForSuccessor === undefined
      ? { ...result, runtimeReadyForSuccessor: true }
      : result;
  }

  async active(workspaceId: string, conversationId: string): Promise<LifecycleRunStatusResult | null> {
    this.calls.push(`active:${workspaceId}:${conversationId}`);
    if (this.activeError) throw this.activeError;
    if (this.activeResults.length > 0) return this.withIdleTerminalHandoff(this.activeResults.shift() ?? null);
    return this.withIdleTerminalHandoff(this.activeResult);
  }

  async register(
    input: Parameters<OrchestratorLifecycleClient["register"]>[0],
  ): Promise<LifecycleRunStatusResult | null> {
    this.registerInputs.push(input);
    this.calls.push(
      `register:${input.workspaceId}:${input.conversationId}:${input.runId}:${input.opencodeSessionId}:${input.kind}`,
    );
    this.onRegister?.(input);
    if (this.registerError) throw this.registerError;
    return this.registerResult ?? {
      runId: input.runId,
      status: "running",
      stale: false,
      clientMessageId: input.clientMessageId ?? null,
      origin: input.origin ?? null,
    };
  }

  async markFailed(workspaceId: string, runId: string, reason: string): Promise<void> {
    this.calls.push(`markFailed:${workspaceId}:${runId}:${reason}`);
    if (this.markFailedError) throw this.markFailedError;
  }

  async markAborted(workspaceId: string, runId: string, reason: string): Promise<void> {
    this.calls.push(`markAborted:${workspaceId}:${runId}:${reason}`);
  }

  async markAbortRequested(workspaceId: string, runId: string): Promise<void> {
    this.calls.push(`markAbortRequested:${workspaceId}:${runId}`);
  }

  async recoverProviderStartTimeout(workspaceId: string, runId: string): Promise<LifecycleRunStatusResult | null> {
    this.calls.push(`recoverProviderStartTimeout:${workspaceId}:${runId}`);
    if (this.recoverProviderStartTimeoutError) throw this.recoverProviderStartTimeoutError;
    return this.withIdleTerminalHandoff(this.statusResult);
  }

  async recoverTerminalRuntimeHandoff(workspaceId: string, runId: string): Promise<LifecycleRunStatusResult | null> {
    this.calls.push(`recoverTerminalRuntimeHandoff:${workspaceId}:${runId}`);
    this.onRecoverTerminalRuntimeHandoff?.(workspaceId, runId);
    if (this.recoverTerminalRuntimeHandoffError) throw this.recoverTerminalRuntimeHandoffError;
    return this.withIdleTerminalHandoff(this.statusResult);
  }

  async status(workspaceId: string, conversationId: string, runId: string): Promise<LifecycleRunStatusResult | null> {
    this.calls.push(`status:${workspaceId}:${conversationId}:${runId}`);
    if (this.statusError) throw this.statusError;
    if (this.statusResults.length > 0) return this.withIdleTerminalHandoff(this.statusResults.shift() ?? null);
    return this.withIdleTerminalHandoff(this.statusResult);
  }
}

type SubmittedOpenCodeCall = {
  opencodeMessageId?: string | null;
  runTrace: { entries: Array<Record<string, unknown>> };
};

class QueueHarness implements ConversationRunQueueStore {
  private nextId = 1;
  readonly items: ConversationRunQueueItem[] = [];
  readonly reservations = new Map<string, ConversationWorkspaceRunReservation>();
  readonly handoffBarriers = new Map<string, ConversationTerminalHandoffBarrier>();
  readonly runtimeOperations = new Map<string, ConversationWorkspaceRuntimeOperation>();
  readonly enqueueCalls: Array<Parameters<ConversationRunQueueStore["enqueue"]>[0]> = [];
  lostClaimQueueItemId: string | null = null;
  reservationConflictRunId: string | null = null;

  enqueue(input: Parameters<ConversationRunQueueStore["enqueue"]>[0]) {
    this.enqueueCalls.push(input);
    const existing = input.clientMessageId
      ? this.items.find((item) =>
        item.workspaceId === input.workspaceId &&
        item.conversationId === input.conversationId &&
        item.clientMessageId === input.clientMessageId
      )
      : null;
    if (existing) {
      return {
        item: existing,
        inserted: false,
        queuePosition: this.items.findIndex((item) => item.queueItemId === existing.queueItemId) + 1,
      };
    }
    const now = Date.now();
    const item: ConversationRunQueueItem = {
      queueItemId: `queue-${this.nextId++}`,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      opencodeSessionId: input.opencodeSessionId,
      directory: input.directory,
      reservedRunId: input.reservedRunId,
      clientMessageId: input.clientMessageId ?? null,
      opencodeMessageId: null,
      origin: input.origin ?? null,
      kind: input.kind,
      bodyJson: input.bodyJson,
      state: "pending",
      activeRunId: input.activeRunId ?? null,
      attempts: 0,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      submittedAt: null,
      completedAt: null,
      error: null,
      idempotencyConflictClientMessageId: null,
    };
    this.items.push(item);
    return {
      item,
      inserted: true,
      queuePosition: this.items.length,
    };
  }

  nextPending(workspaceId: string, conversationId: string): ConversationRunQueueItem | null {
    return this.items.find((item) =>
      item.workspaceId === workspaceId && item.conversationId === conversationId && item.state === "pending"
    ) ?? null;
  }

  listForConversation(): ReturnType<ConversationRunQueueStore["listForConversation"]> {
    return { items: [], nextCursor: null };
  }

  readConversationRunStatusSnapshot(
    input: Parameters<ConversationRunQueueStore["readConversationRunStatusSnapshot"]>[0],
  ): ReturnType<ConversationRunQueueStore["readConversationRunStatusSnapshot"]> {
    const item = input.runId === "latest"
      ? this.items.find((candidate) =>
        candidate.workspaceId === input.workspaceId &&
        candidate.conversationId === input.conversationId &&
        (candidate.state === "pending" || candidate.state === "starting") &&
        this.reservations.has(`${candidate.workspaceId}\0${candidate.reservedRunId}`)
      ) ?? this.items.find((candidate) =>
        candidate.workspaceId === input.workspaceId &&
        candidate.conversationId === input.conversationId &&
        (candidate.state === "pending" || candidate.state === "starting")
      ) ?? null
      : this.items.find((candidate) =>
        candidate.workspaceId === input.workspaceId &&
        candidate.conversationId === input.conversationId &&
        candidate.reservedRunId === input.runId
      ) ?? null;
    const selectedRunId = item?.reservedRunId ?? (input.runId === "latest" ? null : input.runId);
    const reservation = selectedRunId
      ? this.reservations.get(`${input.workspaceId}\0${selectedRunId}`) ?? null
      : null;
    const directBarrier = selectedRunId
      ? this.getTerminalHandoffBarrier(input.workspaceId, input.conversationId, selectedRunId)
      : null;
    return {
      item,
      reservation,
      terminalHandoff: item
        ? this.getActiveTerminalHandoffBarrier(input.workspaceId, input.conversationId)
        : directBarrier,
    };
  }

  markStarting(queueItemId: string): ConversationRunQueueItem | null {
    const item = this.items.find((candidate) => candidate.queueItemId === queueItemId);
    if (!item || item.state !== "pending") return null;
    item.state = "starting";
    item.attempts += 1;
    item.startedAt = Date.now();
    item.updatedAt = item.startedAt;
    if (!item.opencodeMessageId && item.kind === "prompt_async" && item.clientMessageId) {
      item.opencodeMessageId = createConversationRunOpenCodeMessageId({
        workspaceId: item.workspaceId,
        engineSessionId: item.opencodeSessionId,
        clientMessageId: item.clientMessageId,
        runId: item.reservedRunId,
        timestamp: item.startedAt,
      });
    }
    item.error = null;
    if (this.lostClaimQueueItemId === queueItemId) return null;
    return item;
  }

  claimStartingWithReservation(queueItemId: string) {
    if (this.reservationConflictRunId) {
      throw new ConversationRunReservationConflictError(this.reservationConflictRunId);
    }
    const item = this.markStarting(queueItemId);
    if (!item) return null;
    const reservation = this.reserveWorkspaceRun({
      workspaceId: item.workspaceId,
      conversationId: item.conversationId,
      runId: item.reservedRunId,
      directory: item.directory,
      opencodeSessionId: item.opencodeSessionId,
      state: "starting",
    });
    return { item, reservation };
  }

  markPending(queueItemId: string, activeRunId?: string | null): ConversationRunQueueItem | null {
    const item = this.items.find((candidate) => candidate.queueItemId === queueItemId);
    if (!item || item.state !== "starting") return null;
    item.state = "pending";
    item.activeRunId = activeRunId ?? null;
    item.startedAt = null;
    item.updatedAt = Date.now();
    return item;
  }

  markSubmitted(queueItemId: string): ConversationRunQueueItem | null {
    const item = this.items.find((candidate) => candidate.queueItemId === queueItemId);
    if (!item || item.state !== "starting") return null;
    const now = Date.now();
    item.state = "submitted";
    item.submittedAt = now;
    item.completedAt = now;
    item.updatedAt = now;
    return item;
  }

  markFailed(queueItemId: string, error: string): ConversationRunQueueItem | null {
    const item = this.items.find((candidate) => candidate.queueItemId === queueItemId);
    if (!item || item.state !== "starting") return null;
    const now = Date.now();
    item.state = "failed";
    item.error = error;
    item.completedAt = now;
    item.updatedAt = now;
    return item;
  }

  getForConversation(
    workspaceId: string,
    conversationId: string,
    queueItemId: string,
  ): ConversationRunQueueItem | null {
    return this.items.find((item) =>
      item.workspaceId === workspaceId &&
      item.conversationId === conversationId &&
      item.queueItemId === queueItemId
    ) ?? null;
  }

  getForReservedRun(
    workspaceId: string,
    conversationId: string,
    reservedRunId: string,
  ): ConversationRunQueueItem | null {
    return this.items.find((item) =>
      item.workspaceId === workspaceId &&
      item.conversationId === conversationId &&
      item.reservedRunId === reservedRunId
    ) ?? null;
  }

  listStarting(): ConversationRunQueueItem[] {
    return this.items.filter((item) => item.state === "starting");
  }

  pendingConversationKeys(): Array<{ workspaceId: string; conversationId: string }> {
    const keys = new Map<string, { workspaceId: string; conversationId: string }>();
    for (const item of this.items) {
      if (item.state !== "pending") continue;
      const key = `${item.workspaceId}\0${item.conversationId}`;
      keys.set(key, { workspaceId: item.workspaceId, conversationId: item.conversationId });
    }
    return [...keys.values()];
  }

  reserveWorkspaceRun(input: Parameters<ConversationRunQueueStore["reserveWorkspaceRun"]>[0]) {
    const key = `${input.workspaceId}\0${input.runId}`;
    const previous = this.reservations.get(key);
    const timestamp = Date.now();
    const reservation: ConversationWorkspaceRunReservation = {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      runId: input.runId,
      state: input.state ?? "starting",
      engineSlotId: previous?.engineSlotId ?? null,
      engineOwnerId: previous?.engineOwnerId ?? null,
      directoryInstanceEpoch: previous?.directoryInstanceEpoch ?? null,
      enginePid: previous?.enginePid ?? null,
      engineStartedAt: previous?.engineStartedAt ?? null,
      engineBaseUrl: previous?.engineBaseUrl ?? null,
      skillViewRevision: previous?.skillViewRevision ?? null,
      authorizationRevision: previous?.authorizationRevision ?? null,
      openCodeConfigDigest: previous?.openCodeConfigDigest ?? null,
      providerStartAbortPending: previous?.providerStartAbortPending ?? false,
      providerStartAbortDirectory: input.directory ?? previous?.providerStartAbortDirectory ?? null,
      providerStartAbortOpenCodeSessionId: input.opencodeSessionId ?? previous?.providerStartAbortOpenCodeSessionId ?? null,
      providerStartAbortAttempts: previous?.providerStartAbortAttempts ?? 0,
      providerStartAbortLastError: previous?.providerStartAbortLastError ?? null,
      providerStartAbortNextAttemptAt: previous?.providerStartAbortNextAttemptAt ?? null,
      providerStartAbortDeadlineAt: previous?.providerStartAbortDeadlineAt ?? null,
      terminalizationReason: previous?.terminalizationReason ?? null,
      terminalizationAttempts: previous?.terminalizationAttempts ?? 0,
      terminalizationLastError: previous?.terminalizationLastError ?? null,
      terminalizationNextAttemptAt: previous?.terminalizationNextAttemptAt ?? null,
      terminalizationDeadlineAt: previous?.terminalizationDeadlineAt ?? null,
      terminalHandoffReason: previous?.terminalHandoffReason ?? null,
      terminalHandoffFingerprint: previous?.terminalHandoffFingerprint ?? null,
      terminalHandoffAttempts: previous?.terminalHandoffAttempts ?? 0,
      terminalHandoffRequestedAt: previous?.terminalHandoffRequestedAt ?? null,
      terminalHandoffDecidedAt: previous?.terminalHandoffDecidedAt ?? null,
      createdAt: previous?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
    this.reservations.set(key, reservation);
    return reservation;
  }

  attachWorkspaceRunEngineOwner(
    workspaceId: string,
    runId: string,
    owner: ConversationWorkspaceRunEngineOwner,
  ) {
    const key = `${workspaceId}\0${runId}`;
    const previous = this.reservations.get(key);
    if (!previous) return null;
    if (
      previous.engineOwnerId &&
      (previous.engineSlotId !== owner.engineSlotId ||
        previous.engineOwnerId !== owner.engineOwnerId ||
        previous.directoryInstanceEpoch !== (owner.directoryInstanceEpoch ?? null) ||
        previous.enginePid !== owner.enginePid ||
        previous.engineStartedAt !== owner.engineStartedAt ||
        previous.engineBaseUrl !== owner.engineBaseUrl)
    ) return null;
    const reservation = { ...previous, ...owner, updatedAt: Date.now() };
    this.reservations.set(key, reservation);
    return reservation;
  }

  activateWorkspaceRun(workspaceId: string, runId: string) {
    const key = `${workspaceId}\0${runId}`;
    const previous = this.reservations.get(key);
    if (!previous) return null;
    const reservation = { ...previous, state: "active" as const, updatedAt: Date.now() };
    this.reservations.set(key, reservation);
    return reservation;
  }

  markWorkspaceRunTerminalizationPending(input: Parameters<ConversationRunQueueStore["markWorkspaceRunTerminalizationPending"]>[0]) {
    const key = `${input.workspaceId}\0${input.runId}`;
    const previous = this.reservations.get(key);
    if (!previous) return null;
    const reservation: ConversationWorkspaceRunReservation = {
      ...previous,
      state: "terminalization_pending",
      terminalizationReason: input.reason,
      terminalizationAttempts: input.attempts,
      terminalizationLastError: input.lastError,
      terminalizationNextAttemptAt: input.nextAttemptAt,
      terminalizationDeadlineAt: input.deadlineAt,
      updatedAt: Date.now(),
    };
    this.reservations.set(key, reservation);
    return reservation;
  }

  markWorkspaceRunTerminalHandoffPending(
    input: Parameters<ConversationRunQueueStore["markWorkspaceRunTerminalHandoffPending"]>[0],
  ) {
    const key = `${input.workspaceId}\0${input.runId}`;
    const previous = this.reservations.get(key);
    if (!previous) return null;
    const reservation: ConversationWorkspaceRunReservation = {
      ...previous,
      state: "terminal_handoff_pending",
      terminalHandoffReason: input.reason,
      terminalHandoffFingerprint: input.fingerprint,
      terminalHandoffAttempts: input.attempts,
      terminalHandoffRequestedAt: input.requestedAt ?? Date.now(),
      terminalHandoffDecidedAt: null,
      updatedAt: Date.now(),
    };
    this.reservations.set(key, reservation);
    return reservation;
  }

  markWorkspaceRunTerminalHandoffUnresolved(
    input: Parameters<ConversationRunQueueStore["markWorkspaceRunTerminalHandoffUnresolved"]>[0],
  ) {
    const key = `${input.workspaceId}\0${input.runId}`;
    const previous = this.reservations.get(key);
    if (!previous) return null;
    const reservation: ConversationWorkspaceRunReservation = {
      ...previous,
      state: "terminal_handoff_unresolved",
      terminalHandoffReason: input.reason,
      terminalHandoffFingerprint: input.fingerprint,
      terminalHandoffAttempts: input.attempts,
      terminalHandoffDecidedAt: input.decidedAt ?? Date.now(),
      updatedAt: Date.now(),
    };
    this.reservations.set(key, reservation);
    return reservation;
  }

  reopenWorkspaceRunTerminalHandoff(workspaceId: string, runId: string) {
    const key = `${workspaceId}\0${runId}`;
    const previous = this.reservations.get(key);
    if (!previous || previous.state !== "terminal_handoff_unresolved") return null;
    const reservation: ConversationWorkspaceRunReservation = {
      ...previous,
      state: "active",
      updatedAt: Date.now(),
    };
    this.reservations.set(key, reservation);
    return reservation;
  }

  getTerminalHandoffBarrier(workspaceId: string, conversationId: string, runId: string) {
    return this.handoffBarriers.get(`${workspaceId}\0${conversationId}\0${runId}`) ?? null;
  }

  getActiveTerminalHandoffBarrier(workspaceId: string, conversationId: string) {
    return [...this.handoffBarriers.values()].find((barrier) =>
      barrier.workspaceId === workspaceId && barrier.conversationId === conversationId && barrier.state !== "resolved"
    ) ?? null;
  }

  observeTerminalHandoffBarrier(input: Parameters<ConversationRunQueueStore["observeTerminalHandoffBarrier"]>[0]) {
    const key = `${input.workspaceId}\0${input.conversationId}\0${input.runId}`;
    const existing = this.handoffBarriers.get(key);
    if (existing) return existing;
    const timestamp = Date.now();
    const barrier: ConversationTerminalHandoffBarrier = {
      ...input,
      state: "observed",
      attempts: 0,
      requestedAt: null,
      decidedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    this.handoffBarriers.set(key, barrier);
    return barrier;
  }

  requestTerminalHandoffBarrierEvidence(input: Parameters<ConversationRunQueueStore["requestTerminalHandoffBarrierEvidence"]>[0]) {
    const key = `${input.workspaceId}\0${input.conversationId}\0${input.runId}`;
    const previous = this.handoffBarriers.get(key);
    if (!previous || previous.state !== "observed") return null;
    const barrier = {
      ...previous,
      fingerprint: input.fingerprint,
      reason: input.reason,
      state: "evidence_requested" as const,
      attempts: previous.attempts + 1,
      requestedAt: Date.now(),
      decidedAt: null,
      updatedAt: Date.now(),
    };
    this.handoffBarriers.set(key, barrier);
    return barrier;
  }

  resolveTerminalHandoffBarrier(input: Parameters<ConversationRunQueueStore["resolveTerminalHandoffBarrier"]>[0]) {
    const key = `${input.workspaceId}\0${input.conversationId}\0${input.runId}`;
    const previous = this.handoffBarriers.get(key);
    if (!previous || previous.state === "resolved") return null;
    const barrier = { ...previous, state: "resolved" as const, reason: input.reason, decidedAt: Date.now(), updatedAt: Date.now() };
    this.handoffBarriers.set(key, barrier);
    return barrier;
  }

  markTerminalHandoffBarrierUnresolved(input: Parameters<ConversationRunQueueStore["markTerminalHandoffBarrierUnresolved"]>[0]) {
    const key = `${input.workspaceId}\0${input.conversationId}\0${input.runId}`;
    const previous = this.handoffBarriers.get(key);
    if (!previous || (previous.state !== "observed" && previous.state !== "evidence_requested")) return null;
    const barrier = { ...previous, state: "unresolved" as const, reason: input.reason, decidedAt: Date.now(), updatedAt: Date.now() };
    this.handoffBarriers.set(key, barrier);
    return barrier;
  }

  reopenTerminalHandoffBarrier(workspaceId: string, conversationId: string, runId: string) {
    const key = `${workspaceId}\0${conversationId}\0${runId}`;
    const previous = this.handoffBarriers.get(key);
    if (!previous || previous.state !== "unresolved") return null;
    const barrier = { ...previous, state: "observed" as const, updatedAt: Date.now() };
    this.handoffBarriers.set(key, barrier);
    return barrier;
  }

  listTerminalHandoffBarriers() {
    return [...this.handoffBarriers.values()];
  }

  markWorkspaceRunProviderStartAbortPending(
    input: Parameters<ConversationRunQueueStore["markWorkspaceRunProviderStartAbortPending"]>[0],
  ) {
    const key = `${input.workspaceId}\0${input.runId}`;
    const previous = this.reservations.get(key);
    if (!previous) return null;
    const reservation = {
      ...previous,
      providerStartAbortPending: true,
      providerStartAbortDirectory: input.directory,
      providerStartAbortOpenCodeSessionId: input.opencodeSessionId,
      providerStartAbortAttempts: input.attempts ?? 0,
      providerStartAbortLastError: input.lastError ?? null,
      providerStartAbortNextAttemptAt: input.nextAttemptAt ?? null,
      providerStartAbortDeadlineAt: input.deadlineAt ?? null,
      updatedAt: Date.now(),
    };
    this.reservations.set(key, reservation);
    return reservation;
  }

  releaseWorkspaceRun(workspaceId: string, runId: string) {
    return this.reservations.delete(`${workspaceId}\0${runId}`);
  }

  listWorkspaceRunReservations() {
    return [...this.reservations.values()];
  }

  acquireWorkspaceRuntimeOperation(input: Parameters<ConversationRunQueueStore["acquireWorkspaceRuntimeOperation"]>[0]) {
    const existing = this.runtimeOperations.get(input.workspaceId);
    if (existing && (existing.state === "granted" || existing.state === "executing") && existing.expiresAt > Date.now()) {
      return { operation: existing, acquired: false };
    }
    const now = Date.now();
    const operation: ConversationWorkspaceRuntimeOperation = {
      workspaceId: input.workspaceId,
      operationId: input.operationId ?? `operation-${this.nextId++}`,
      kind: input.kind,
      sourceClass: input.sourceClass,
      reasonCode: input.reasonCode,
      state: "granted",
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
      terminalCode: null,
    };
    this.runtimeOperations.set(input.workspaceId, operation);
    return { operation, acquired: true };
  }

  getWorkspaceRuntimeOperation(workspaceId: string) {
    return this.runtimeOperations.get(workspaceId) ?? null;
  }

  beginWorkspaceRuntimeOperation(workspaceId: string, operationId: string) {
    const operation = this.runtimeOperations.get(workspaceId);
    if (!operation || operation.operationId !== operationId || operation.state !== "granted" || operation.expiresAt <= Date.now()) {
      return null;
    }
    const next = { ...operation, state: "executing" as const, updatedAt: Date.now() };
    this.runtimeOperations.set(workspaceId, next);
    return next;
  }

  completeWorkspaceRuntimeOperation(input: Parameters<ConversationRunQueueStore["completeWorkspaceRuntimeOperation"]>[0]) {
    const operation = this.runtimeOperations.get(input.workspaceId);
    if (!operation || operation.operationId !== input.operationId || (operation.state !== "granted" && operation.state !== "executing")) {
      return null;
    }
    const next = { ...operation, state: input.state, terminalCode: input.terminalCode ?? null, updatedAt: Date.now() };
    this.runtimeOperations.set(input.workspaceId, next);
    return next;
  }

  expireWorkspaceRuntimeOperations(now = Date.now()) {
    const expired: ConversationWorkspaceRuntimeOperation[] = [];
    for (const [workspaceId, operation] of this.runtimeOperations) {
      if ((operation.state !== "granted" && operation.state !== "executing") || operation.expiresAt > now) continue;
      const next = { ...operation, state: "outcome_unknown" as const, terminalCode: "lease_expired", updatedAt: now };
      this.runtimeOperations.set(workspaceId, next);
      expired.push(next);
    }
    return expired;
  }

  listActiveWorkspaceRuntimeOperations(now = Date.now()) {
    return [...this.runtimeOperations.values()].filter((operation) =>
      (operation.state === "granted" || operation.state === "executing") && operation.expiresAt > now
    );
  }
}

function createRunTrace() {
  const entries: Array<Record<string, unknown>> = [];
  return {
    entries,
    traceId: "trace-test",
    record(event: string, payload: Record<string, unknown> = {}) {
      entries.push({ event, ...payload });
    },
    async step<T>(event: string, fn: () => Promise<T>, payload: Record<string, unknown> = {}): Promise<T> {
      entries.push({ event: `${event}:start`, ...payload });
      const result = await fn();
      entries.push({ event, ...payload });
      return result;
    },
  };
}

function submitInput(overrides: Partial<ConversationRunLifecycleSubmitInput> = {}): ConversationRunLifecycleSubmitInput {
  return {
    runTrace: createRunTrace(),
    workspace: {
      id: "ws_1",
      name: "Workspace",
      path: "/repo",
      workspaceType: "local",
    },
    target: {
      directory: "/repo",
      opencodeSessionId: "sess-a",
      conversationId: "conv-a",
    },
    runId: "run-reserved",
    kind: "prompt_async",
    body: { kind: "prompt_async", parts: [{ type: "text", text: "Hello" }] },
    clientMessageId: "msg-a",
    origin: "composer",
    expectAiGatewayStart: false,
    ...overrides,
  };
}

function controllerHarness(options?: {
  ingestTerminalTranscript?: (input: { runId: string }) => Promise<{ kind: "persisted" | "unchanged" | "incomplete" | "exhausted" } | void>;
  withLifecycle?: boolean;
  engineOwnerAttachGraceMs?: number;
  submitEngineOwner?: ConversationWorkspaceRunEngineOwner | null;
  startupReservation?: Partial<ConversationWorkspaceRunReservation> & { conversationId: string; runId: string };
}) {
  const lifecycle = new LifecycleHarness();
  const queue = new QueueHarness();
  if (options?.startupReservation) {
    queue.reserveWorkspaceRun({
      workspaceId: "ws_1",
      conversationId: options.startupReservation.conversationId,
      runId: options.startupReservation.runId,
      state: options.startupReservation.state ?? "active",
    });
    const reservation = queue.reservations.get(`ws_1\0${options.startupReservation.runId}`)!;
    queue.reservations.set(`ws_1\0${options.startupReservation.runId}`, {
      ...reservation,
      ...options.startupReservation,
      workspaceId: "ws_1",
    });
  }
  const timers = new TimerHarness();
  const workspaces = [
    {
      id: "ws_1",
      name: "Workspace",
      path: "/repo",
      workspaceType: "local" as const,
    },
  ];
  const behavior = {
    submitError: null as unknown,
    abortError: null as unknown,
    providerStartResult: { started: true, timeoutMs: 25 },
    submitEngineOwner: options?.submitEngineOwner ?? null,
    beforeCaptureEngineOwner: null as (() => void) | null,
  };
  const submitCalls: unknown[] = [];
  const admissionOrder: string[] = [];
  const admittedRunIds: string[] = [];
  const activeGatewayCalls: Array<{ kind: "register" | "unregister"; input: unknown }> = [];
  const activeProxyAbortCalls: unknown[] = [];
  const providerWatchCalls: unknown[] = [];
  const abortCalls: unknown[] = [];
  const drainCalls: Array<{ workspaceId: string; conversationId: string; delayMs: number }> = [];
  const traceEntries: Array<Record<string, unknown>> = [];
  const backgroundTraceEntries: Array<Array<Record<string, unknown>>> = [];
  const terminalRecoveries: Array<{ runId: string; lifecycle: string; canonicalRecovery: string }> = [];
  const reconcileCalls: Array<{
    workspaceId: string;
    conversationId: string;
    runId: string;
    reason: string;
    delayMs: number | undefined;
  }> = [];
  const controller = createConversationRunLifecycleController({
    lifecycleClient: options?.withLifecycle === false ? null : lifecycle,
    queueStore: queue,
    timers: timers.port,
    resolveWorkspace: (workspaceId) => workspaces.find((workspace) => workspace.id === workspaceId) ?? null,
    createBackgroundRunTrace: () => {
      const trace = createRunTrace();
      backgroundTraceEntries.push(trace.entries);
      return trace;
    },
    submitOpenCode: async (input) => {
      admissionOrder.push("upstream");
      submitCalls.push(input);
      if (behavior.submitError) throw behavior.submitError;
      behavior.beforeCaptureEngineOwner?.();
      if (behavior.submitEngineOwner) input.captureEngineOwner?.(behavior.submitEngineOwner);
      return { accepted: true };
    },
    aiGatewayActiveRun: {
      register: (input) => {
        activeGatewayCalls.push({ kind: "register", input });
      },
      unregister: (input) => {
        activeGatewayCalls.push({ kind: "unregister", input });
      },
    },
    aiGatewayProviderWatch: {
      waitForProviderStart: async (input) => {
        providerWatchCalls.push(input);
        return behavior.providerStartResult;
      },
    },
    abortOpenCode: async (input) => {
      abortCalls.push(input);
      if (behavior.abortError) throw behavior.abortError;
      return { aborted: true };
    },
    abortActiveGatewayProxyRequests: (input) => {
      activeProxyAbortCalls.push(input);
      return [{ requestId: "proxy-1" }];
    },
    queueDrainPollMs: 1_500,
    resolveLifecycleReconcilePollMs: () => 2_000,
    resolveLifecycleReconcileMaxAttempts: () => 3,
    ingestTerminalTranscript: options?.ingestTerminalTranscript
      ? async (input) => await options.ingestTerminalTranscript!({ runId: input.runId })
      : undefined,
    onTerminalTranscriptRecovery: (input) => {
      terminalRecoveries.push({
        runId: input.runId,
        lifecycle: input.lifecycle,
        canonicalRecovery: input.canonicalRecovery,
      });
    },
    onRunAdmitted: (input) => {
      admissionOrder.push("admitted");
      admittedRunIds.push(input.runId);
    },
    trace: {
      record: (event, payload = {}) => {
        traceEntries.push({ event, ...payload });
        if (event !== "conversation-run-lifecycle:start" && event !== "conversation-run-lifecycle:stop") {
          reconcileCalls.push({
            workspaceId: typeof payload.workspaceId === "string" ? payload.workspaceId : "",
            conversationId: typeof payload.conversationId === "string" ? payload.conversationId : "",
            runId: typeof payload.runId === "string" ? payload.runId : "",
            reason: typeof payload.reason === "string" ? payload.reason : event,
            delayMs: typeof payload.delayMs === "number" ? payload.delayMs : undefined,
          });
        }
      },
    },
    resolveLifecycleReconcileInitialDelayMs: () => 1_234,
    resolveEngineOwnerAttachGraceMs: () => options?.engineOwnerAttachGraceMs ?? 80_000,
  });
  return {
    controller,
    lifecycle,
    queue,
    timers,
    workspaces,
    behavior,
    submitCalls,
    admissionOrder,
    admittedRunIds,
    activeGatewayCalls,
    activeProxyAbortCalls,
    providerWatchCalls,
    abortCalls,
    drainCalls,
    traceEntries,
    backgroundTraceEntries,
    terminalRecoveries,
    reconcileCalls,
  };
}

function enqueuePendingRun(queue: QueueHarness, overrides: Partial<Parameters<QueueHarness["enqueue"]>[0]> = {}) {
  return queue.enqueue({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    opencodeSessionId: "sess-a",
    directory: "/repo",
    reservedRunId: "run-queued",
    clientMessageId: "msg-queued",
    origin: "composer",
    kind: "prompt_async",
    bodyJson: JSON.stringify({ kind: "prompt_async", parts: [{ type: "text", text: "Queued" }] }),
    activeRunId: null,
    ...overrides,
  }).item;
}

function snapshotStub(overrides: Partial<ConversationRunLifecycleSnapshot> = {}): ConversationRunLifecycleSnapshot {
  return {
    started: false,
    activeTimerCount: 0,
    diagnostics: {
      enabled: false,
      intervalMs: null,
      runs: 0,
    },
    lifecycle: {
      pendingQueueDrains: [],
      pendingLifecycleReconciles: [],
      inFlightQueueDrains: [],
      inFlightLifecycleReconciles: [],
    },
    ports: {
      lifecycleClient: false,
      queueStore: false,
      submitOpenCode: false,
      aiGatewayProviderWatch: false,
    },
    ...overrides,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

test("controller shell starts, stops, and clears diagnostics timers", () => {
  const timers = new TimerHarness();
  const traceEvents: string[] = [];
  const controller = createConversationRunLifecycleController({
    diagnostics: { intervalMs: 250 },
    timers: timers.port,
    trace: {
      record: (event) => {
        traceEvents.push(event);
      },
    },
  });

  expect(controller.snapshotForTests()).toEqual(snapshotStub({
    diagnostics: { enabled: true, intervalMs: 250, runs: 0 },
  }));

  controller.start();
  controller.start();

  expect(controller.snapshotForTests()).toEqual(snapshotStub({
    started: true,
    activeTimerCount: 1,
    diagnostics: { enabled: true, intervalMs: 250, runs: 0 },
  }));
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([250]);

  timers.fire(timers.activeTimers()[0]!.id);

  expect(controller.snapshotForTests()).toEqual(snapshotStub({
    started: true,
    activeTimerCount: 1,
    diagnostics: { enabled: true, intervalMs: 250, runs: 1 },
  }));

  controller.stop();
  controller.stop();

  expect(controller.snapshotForTests()).toEqual(snapshotStub({
    diagnostics: { enabled: true, intervalMs: 250, runs: 1 },
  }));
  expect(timers.activeTimers()).toEqual([]);
  expect(traceEvents).toEqual([
    "conversation-run-lifecycle:start",
    "conversation-run-lifecycle:diagnostics",
    "conversation-run-lifecycle:stop",
  ]);
});

test("controller shell records explicit ports without invoking behavior", () => {
  const submitCalls: unknown[] = [];
  const providerWatchCalls: unknown[] = [];
  const controller = createConversationRunLifecycleController({
    lifecycleClient: {} as never,
    queueStore: {} as never,
    submitOpenCode: async (input) => {
      submitCalls.push(input);
      return null;
    },
    aiGatewayProviderWatch: {
      waitForProviderStart: async (input) => {
        providerWatchCalls.push(input);
        return { started: false, timeoutMs: 25 };
      },
    },
  });

  controller.start();
  controller.stop();

  expect(controller.snapshotForTests().ports).toEqual({
    lifecycleClient: true,
    queueStore: true,
    submitOpenCode: true,
    aiGatewayProviderWatch: true,
  });
  expect(submitCalls).toEqual([]);
  expect(providerWatchCalls).toEqual([]);
});

test("engine-loss notification releases only matching workspace reservations and is idempotent", () => {
  const queue = new QueueHarness();
  queue.reserveWorkspaceRun({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-a",
    state: "active",
  });
  queue.reserveWorkspaceRun({
    workspaceId: "ws_1",
    conversationId: "conv-b",
    runId: "run-b",
    state: "active",
  });
  queue.attachWorkspaceRunEngineOwner("ws_1", "run-a", {
    engineSlotId: "ws_1",
    engineOwnerId: "generation-1",
    enginePid: 101,
    engineStartedAt: 1_000,
    engineBaseUrl: "http://127.0.0.1:4101",
  });
  const timers = new TimerHarness();
  const controller = createConversationRunLifecycleController({
    queueStore: queue,
    timers: timers.port,
    queueDrainPollMs: 1_500,
  });

  const notification = {
    eventId: "loss-event-1",
    workspaceId: "ws_1",
    engineSlotId: "ws_1",
    engineOwnerId: "generation-1",
    enginePid: 101,
    engineStartedAt: 1_000,
    engineBaseUrl: "http://127.0.0.1:4101",
    runIds: ["run-a", "run-a", "missing-run"],
    reason: "engine exited",
  };
  const first = controller.notifyEngineLoss(notification);
  const duplicate = controller.notifyEngineLoss(notification);

  expect(first).toEqual({
    eventId: "loss-event-1",
    acceptedRunIds: ["run-a"],
    ignoredRunIds: ["missing-run"],
    drainedConversations: ["conv-a"],
    duplicate: false,
  });
  expect(duplicate).toEqual({ ...first, duplicate: true });
  expect(queue.reservations.has("ws_1\0run-a")).toBe(false);
  expect(queue.reservations.has("ws_1\0run-b")).toBe(true);
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([0]);
});

test("engine-loss ignores a stale generation after the reservation was attached", () => {
  const queue = new QueueHarness();
  queue.reserveWorkspaceRun({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-a",
    state: "active",
  });
  queue.attachWorkspaceRunEngineOwner("ws_1", "run-a", {
    engineSlotId: "ws_1",
    engineOwnerId: "generation-2",
    enginePid: 202,
    engineStartedAt: 2_000,
    engineBaseUrl: "http://127.0.0.1:4202",
  });
  const controller = createConversationRunLifecycleController({
    queueStore: queue,
    timers: new TimerHarness().port,
    queueDrainPollMs: 1_500,
  });

  const stale = controller.notifyEngineLoss({
    eventId: "loss-stale",
    workspaceId: "ws_1",
    engineSlotId: "ws_1",
    engineOwnerId: "generation-1",
    enginePid: 101,
    engineStartedAt: 1_000,
    engineBaseUrl: "http://127.0.0.1:4101",
    runIds: ["run-a"],
    reason: "old engine exited",
  });

  expect(stale.acceptedRunIds).toEqual([]);
  expect(stale.ignoredRunIds).toEqual(["run-a"]);
  expect(queue.reservations.has("ws_1\0run-a")).toBe(true);
});

test("multi-step owner loss releases one run and drains the next run onto the new generation", async () => {
  const firstOwner: ConversationWorkspaceRunEngineOwner = {
    engineSlotId: "ws_1",
    engineOwnerId: "generation-1",
    enginePid: 101,
    engineStartedAt: 1_000,
    engineBaseUrl: "http://127.0.0.1:4101",
  };
  const secondOwner: ConversationWorkspaceRunEngineOwner = {
    engineSlotId: "ws_1",
    engineOwnerId: "generation-2",
    enginePid: 202,
    engineStartedAt: 2_000,
    engineBaseUrl: "http://127.0.0.1:4202",
  };
  const harness = controllerHarness({ submitEngineOwner: firstOwner });
  const { controller, queue, behavior, submitCalls, timers } = harness;

  await controller.submitRun(submitInput({ runId: "run-a" }));
  enqueuePendingRun(queue, {
    conversationId: "conv-a",
    reservedRunId: "run-b",
    clientMessageId: "msg-b",
  });

  expect(queue.reservations.get("ws_1\0run-a")).toEqual(
    expect.objectContaining({ state: "active", ...firstOwner }),
  );

  const staleLoss = controller.notifyEngineLoss({
    eventId: "loss-stale-before-restart",
    workspaceId: "ws_1",
    engineSlotId: "ws_1",
    engineOwnerId: "generation-0",
    enginePid: 99,
    engineStartedAt: 900,
    engineBaseUrl: "http://127.0.0.1:4099",
    runIds: ["run-a"],
    reason: "stale callback",
  });
  expect(staleLoss.acceptedRunIds).toEqual([]);
  expect(queue.reservations.has("ws_1\0run-a")).toBe(true);

  const currentLoss = controller.notifyEngineLoss({
    eventId: "loss-generation-1",
    workspaceId: "ws_1",
    engineSlotId: "ws_1",
    engineOwnerId: firstOwner.engineOwnerId,
    enginePid: firstOwner.enginePid,
    engineStartedAt: firstOwner.engineStartedAt,
    engineBaseUrl: firstOwner.engineBaseUrl,
    runIds: ["run-a"],
    reason: "generation-1 exited",
  });
  expect(currentLoss.acceptedRunIds).toEqual(["run-a"]);
  expect(queue.reservations.has("ws_1\0run-a")).toBe(false);

  behavior.submitEngineOwner = secondOwner;
  const drainTimer = timers.activeTimers().find((timer) => timer.delayMs === 0);
  expect(drainTimer).toBeDefined();
  timers.fire(drainTimer!.id);
  for (let index = 0; index < 8; index += 1) await flushMicrotasks();

  expect(queue.items.find((item) => item.reservedRunId === "run-b")?.state).toBe("submitted");
  expect(submitCalls.map((call) => (call as { runId: string }).runId)).toEqual(["run-a", "run-b"]);
  expect(queue.reservations.get("ws_1\0run-b")).toEqual(
    expect.objectContaining({ state: "active", ...secondOwner }),
  );

  const staleSecondLoss = controller.notifyEngineLoss({
    eventId: "loss-stale-after-restart",
    workspaceId: "ws_1",
    engineSlotId: "ws_1",
    engineOwnerId: firstOwner.engineOwnerId,
    enginePid: firstOwner.enginePid,
    engineStartedAt: firstOwner.engineStartedAt,
    engineBaseUrl: firstOwner.engineBaseUrl,
    runIds: ["run-b"],
    reason: "old generation callback",
  });
  expect(staleSecondLoss.acceptedRunIds).toEqual([]);
  expect(queue.reservations.has("ws_1\0run-b")).toBe(true);

  const secondLoss = controller.notifyEngineLoss({
    eventId: "loss-generation-2",
    workspaceId: "ws_1",
    engineSlotId: "ws_1",
    engineOwnerId: secondOwner.engineOwnerId,
    enginePid: secondOwner.enginePid,
    engineStartedAt: secondOwner.engineStartedAt,
    engineBaseUrl: secondOwner.engineBaseUrl,
    runIds: ["run-b"],
    reason: "generation-2 exited",
  });
  expect(secondLoss.acceptedRunIds).toEqual(["run-b"]);
  expect(queue.reservations.has("ws_1\0run-b")).toBe(false);
});

test("multi-step owner-loss race is reconciled when the response owner arrives after the loss callback", async () => {
  const owner: ConversationWorkspaceRunEngineOwner = {
    engineSlotId: "ws_1",
    engineOwnerId: "generation-race",
    enginePid: 303,
    engineStartedAt: 3_000,
    engineBaseUrl: "http://127.0.0.1:4303",
  };
  const harness = controllerHarness({ submitEngineOwner: owner });
  const { controller, queue, behavior, timers, submitCalls } = harness;
  let lossResult: ConversationRunEngineLossResult | null = null;
  behavior.beforeCaptureEngineOwner = () => {
    lossResult = controller.notifyEngineLoss({
      eventId: "loss-before-owner-capture",
      workspaceId: "ws_1",
      engineSlotId: owner.engineSlotId,
      engineOwnerId: owner.engineOwnerId,
      enginePid: owner.enginePid,
      engineStartedAt: owner.engineStartedAt,
      engineBaseUrl: owner.engineBaseUrl,
      runIds: ["run-race"],
      reason: "engine exited before response headers were persisted",
    });
  };

  await controller.submitRun(submitInput({ runId: "run-race" }));

  expect(lossResult).toMatchObject({
    acceptedRunIds: [],
    ignoredRunIds: ["run-race"],
    duplicate: false,
  });
  expect(queue.reservations.has("ws_1\0run-race")).toBe(false);
  expect(timers.activeTimers().some((timer) => timer.delayMs === 0)).toBe(true);
  const submitTrace = (submitCalls[0] as {
    runTrace: { entries: Array<Record<string, unknown>> };
  }).runTrace;
  expect(submitTrace.entries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:engine-owner-persist-failed",
    runId: "run-race",
  }));
});

test("server stop calls the lifecycle controller stop hook", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "veslo-lifecycle-controller-workspace-"));
  const dataDir = await mkdtemp(join(tmpdir(), "veslo-lifecycle-controller-data-"));
  tempDirs.push(workspaceRoot, dataDir);

  const previousDataDir = process.env.VESLO_DATA_DIR;
  process.env.VESLO_DATA_DIR = dataDir;
  envRestores.push(() => {
    if (previousDataDir === undefined) {
      delete process.env.VESLO_DATA_DIR;
    } else {
      process.env.VESLO_DATA_DIR = previousDataDir;
    }
  });

  let startCalls = 0;
  let stopCalls = 0;
  const fakeController: ConversationRunLifecycleController = {
    notifyEngineLoss: () => ({
      eventId: "",
      acceptedRunIds: [],
      ignoredRunIds: [],
      drainedConversations: [],
      duplicate: false,
    }),
    submitRun: async () => {
      throw new Error("submitRun should not be called by the shutdown fixture");
    },
    submitAcceptedRun: async () => {
      throw new Error("submitAcceptedRun should not be called by the shutdown fixture");
    },
    abortRun: async () => {
      throw new Error("abortRun should not be called by the shutdown fixture");
    },
    reloadWorkspaceEngineIfIdle: async () => {
      throw new Error("reloadWorkspaceEngineIfIdle should not be called by the shutdown fixture");
    },
    requestWorkspaceRuntimeOperation: async () => {
      throw new Error("requestWorkspaceRuntimeOperation should not be called by the shutdown fixture");
    },
    beginWorkspaceRuntimeOperation: async () => {
      throw new Error("beginWorkspaceRuntimeOperation should not be called by the shutdown fixture");
    },
    completeWorkspaceRuntimeOperation: async () => {
      throw new Error("completeWorkspaceRuntimeOperation should not be called by the shutdown fixture");
    },
    subscribeWorkspaceIdle: () => () => {},
    scheduleQueueDrain: () => {
      throw new Error("scheduleQueueDrain should not be called by the shutdown fixture");
    },
    drainConversationQueue: async () => {
      throw new Error("drainConversationQueue should not be called by the shutdown fixture");
    },
    scheduleLifecycleReconcile: () => {
      throw new Error("scheduleLifecycleReconcile should not be called by the shutdown fixture");
    },
    reconcileConversationRunLifecycle: async () => {
      throw new Error("reconcileConversationRunLifecycle should not be called by the shutdown fixture");
    },
    retryTerminalRuntimeHandoff: async () => {
      throw new Error("retryTerminalRuntimeHandoff should not be called by the shutdown fixture");
    },
    start: () => {
      startCalls += 1;
    },
    stop: () => {
      stopCalls += 1;
    },
    snapshotForTests: () => snapshotStub(),
  };
  setConversationRunLifecycleControllerFactoryForTests(() => fakeController);

  const server = startServer({
    host: "127.0.0.1",
    port: 0,
    token: "client-token",
    hostToken: "host-token",
    approval: { mode: "auto", timeoutMs: 1_000 },
    corsOrigins: ["*"],
    workspaces: [
      { id: "ws_1", name: "Workspace", path: workspaceRoot, workspaceType: "local" },
    ],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "cli",
    hostTokenSource: "cli",
    logFormat: "pretty",
    logRequests: false,
    debugLogs: {
      enabled: false,
      ingestUrl: null,
      ingestToken: null,
      batchMaxEvents: 200,
      batchMaxBytes: 256 * 1024,
      spoolMaxBytes: 100 * 1024 * 1024,
      flushIntervalMs: 60_000,
    },
  });
  runningServers.push(server as { stop?: (closeActiveConnections?: boolean) => void });

  expect(startCalls).toBe(1);
  server.stop(true);
  runningServers.pop();

  expect(stopCalls).toBe(1);
});

test("submitRun registers inactive local runs before submitting", async () => {
  const { controller, lifecycle, queue, submitCalls, drainCalls } = controllerHarness();

  const result = await controller.submitRun(submitInput());

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  expect(result.payload.runId).toBe("run-reserved");
  expect(result.payload.upstream).toEqual({ accepted: true });
  expect(lifecycle.calls).toEqual([
    "active:ws_1:conv-a",
    "status:ws_1:conv-a:latest",
    "register:ws_1:conv-a:run-reserved:sess-a:prompt",
  ]);
  expect(queue.items).toEqual([]);
  expect(drainCalls).toEqual([]);
  expect(submitCalls).toHaveLength(1);
  const submittedMessageId = (submitCalls[0] as SubmittedOpenCodeCall).opencodeMessageId;
  expect(submittedMessageId).toMatch(/^msg_[0-9a-f]{26}$/);
  expect(lifecycle.registerInputs[0]?.opencodeMessageId).toBe(submittedMessageId);
});

test("submitRun emits an authoritative correlation record only after durable admission", async () => {
  const input = submitInput({ runId: "run-correlation", clientMessageId: "msg-correlation" });
  const { controller } = controllerHarness();

  await controller.submitRun(input);

  expect(input.runTrace.entries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:admitted",
    correlation: {
      version: 1,
      authoritativeOperation: { kind: "conversation-run", id: "run-correlation" },
      causation: { clientMessageId: "msg-correlation", queueItemId: null },
      scope: { workspaceId: "ws_1", conversationId: "conv-a" },
      origin: "composer",
      phase: "admitted",
      outcome: "accepted",
      reason: null,
    },
  }));
});

test("submitRun announces the exact prompt run before upstream dispatch", async () => {
  const { controller, admissionOrder, admittedRunIds } = controllerHarness();

  await controller.submitRun(submitInput({ runId: "run-admission-order" }));

  expect(admittedRunIds).toEqual(["run-admission-order"]);
  expect(admissionOrder).toEqual(["admitted", "upstream"]);
});

test("submitRun queues immediately for server-queue-only policy", async () => {
  const { controller, lifecycle, queue, submitCalls, timers } = controllerHarness();

  const result = await controller.submitRun(submitInput({
    submitQueuePolicy: "server-queue-only",
  }));

  expect(result.httpStatus).toBe(202);
  expect(result.payload.status).toBe("queued");
  expect(result.payload.reservedRunId).toBe("run-reserved");
  expect(result.payload.queueItemId).toBe("queue-1");
  expect(result.payload.activeRunId).toBe(null);
  expect(lifecycle.calls).toEqual([]);
  expect(queue.enqueueCalls[0]?.activeRunId).toBe(null);
  expect(JSON.parse(queue.enqueueCalls[0]?.bodyJson ?? "{}").opencodeMessageId).toBeUndefined();
  expect(submitCalls).toEqual([]);
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([1_500]);
});

test("submitRun queues when active peek finds an active run", async () => {
  const { controller, lifecycle, queue, submitCalls, timers } = controllerHarness();
  lifecycle.activeResult = { runId: "run-active", status: "running", stale: false };

  const result = await controller.submitRun(submitInput());

  expect(result.httpStatus).toBe(202);
  expect(result.payload.status).toBe("queued");
  expect(result.payload.reservedRunId).toBe("run-reserved");
  expect(result.payload.queueItemId).toBe("queue-1");
  expect(result.payload.activeRunId).toBe("run-active");
  expect(result.payload.queuePosition).toBe(1);
  expect(lifecycle.calls).toEqual(["active:ws_1:conv-a"]);
  expect(queue.enqueueCalls[0]?.activeRunId).toBe("run-active");
  expect(submitCalls).toEqual([]);
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([1_500]);
});

test("submitRun reuses active direct run when clientMessageId matches", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();
  lifecycle.activeResult = {
    runId: "run-active",
    status: "running",
    stale: false,
    clientMessageId: "msg-a",
    origin: "composer",
  };

  const result = await controller.submitRun(submitInput({ runId: "run-retry" }));

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  expect(result.payload.runId).toBe("run-active");
  expect(result.payload.reusedActiveRun).toBe(true);
  expect(queue.items).toEqual([]);
  expect(submitCalls).toEqual([]);
});

test("submitRun never bypasses an active owner when its readiness projection is inconsistent", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();
  lifecycle.activeResult = {
    runId: "run-active",
    status: "running",
    stale: false,
    runtimeReadyForSuccessor: true,
    clientMessageId: "another-message",
    origin: "composer",
  };

  const result = await controller.submitRun(submitInput());

  expect(result.payload.status).toBe("queued");
  expect(result.payload.activeRunId).toBe("run-active");
  expect(lifecycle.calls).toEqual(["active:ws_1:conv-a"]);
  expect(queue.items).toHaveLength(1);
  expect(submitCalls).toEqual([]);
});

test("submitRun queues when lifecycle register reports an active run", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();
  lifecycle.registerError = new RunAlreadyActiveError("run-active-register");

  const result = await controller.submitRun(submitInput());

  expect(result.httpStatus).toBe(202);
  expect(result.payload.status).toBe("queued");
  expect(result.payload.activeRunId).toBe("run-active-register");
  expect(lifecycle.calls).toEqual([
    "active:ws_1:conv-a",
    "status:ws_1:conv-a:latest",
    "register:ws_1:conv-a:run-reserved:sess-a:prompt",
    "active:ws_1:conv-a",
    "status:ws_1:conv-a:latest",
  ]);
  expect(queue.items).toHaveLength(1);
  expect(submitCalls).toEqual([]);
});

test("submitRun reuses active run after register conflict when clientMessageId matches", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();
  lifecycle.activeResults = [
    null,
    {
      runId: "run-active-register",
      status: "running",
      stale: false,
      clientMessageId: "msg-a",
      origin: "composer",
    },
  ];
  lifecycle.registerError = new RunAlreadyActiveError("run-active-register");

  const result = await controller.submitRun(submitInput({ runId: "run-retry" }));

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  expect(result.payload.runId).toBe("run-active-register");
  expect(result.payload.reusedActiveRun).toBe(true);
  expect(lifecycle.calls).toEqual([
    "active:ws_1:conv-a",
    "status:ws_1:conv-a:latest",
    "register:ws_1:conv-a:run-retry:sess-a:prompt",
    "active:ws_1:conv-a",
  ]);
  expect(queue.items).toEqual([]);
  expect(submitCalls).toEqual([]);
});

test("submitRun preserves the draft instead of queueing behind an unresolved historical terminal owner", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();
  lifecycle.statusResult = {
    runId: "run-historical-terminal",
    status: "failed",
    stale: true,
    runtimeReadyForSuccessor: null,
    unavailableReason: "no_current_engine",
    engineOwnerId: "owner-before-restart",
    enginePid: 1234,
    engineStartedAt: 5678,
  };
  lifecycle.recoverTerminalRuntimeHandoffError = new OrchestratorLifecycleRequestError(
    "/workspace/ws_1/runs/run-historical-terminal/recover-terminal-runtime-handoff",
    409,
    { error: "terminal_handoff_recovery_owner_unknown", reason: "process_identity_unavailable" },
  );

  await expect(controller.submitRun(submitInput())).rejects.toMatchObject({
    status: 409,
    code: "terminal_handoff_recovery_required",
    details: expect.objectContaining({
      blockingRunId: "run-historical-terminal",
      reason: "process_identity_unavailable",
    }),
  } satisfies Partial<ApiError>);

  expect(lifecycle.calls).toEqual([
    "active:ws_1:conv-a",
    "status:ws_1:conv-a:latest",
    "recoverTerminalRuntimeHandoff:ws_1:run-historical-terminal",
  ]);
  expect(queue.items).toEqual([]);
  expect(submitCalls).toEqual([]);
  // The rejected submit must leave the same durable fence the queue drain
  // leaves, so the run status can project it and the app can offer its
  // existing retry-verification action instead of a bare error.
  expect(queue.getTerminalHandoffBarrier("ws_1", "conv-a", "run-historical-terminal")).toEqual(
    expect.objectContaining({ state: "unresolved", reason: "process_identity_unavailable" }),
  );
});

test("submitRun returns a post-recovery lifecycle read failure without creating a handoff barrier", async () => {
  const { controller, lifecycle, queue, timers } = controllerHarness();
  lifecycle.statusResult = {
    runId: "run-historical-terminal",
    status: "failed",
    stale: true,
    runtimeReadyForSuccessor: null,
    unavailableReason: "no_current_engine",
    engineOwnerId: "owner-before-restart",
    enginePid: 1234,
    engineStartedAt: 5678,
  };
  lifecycle.onRecoverTerminalRuntimeHandoff = () => {
    lifecycle.statusError = new OrchestratorLifecycleRequestError(
      "/workspace/ws_1/conversations/conv-a/runs/latest",
      503,
      { error: "daemon_unavailable" },
    );
  };

  await expect(controller.submitRun(submitInput())).rejects.toMatchObject({
    status: 503,
    code: "lifecycle_unavailable",
  } satisfies Partial<ApiError>);

  expect(queue.items).toEqual([]);
  expect(queue.getTerminalHandoffBarrier("ws_1", "conv-a", "run-historical-terminal")).toBeNull();
  expect(timers.activeTimers()).toEqual([]);
});

test("submitRun records unresolved when successful handoff recovery is not confirmed by the fresh status", async () => {
  const { controller, lifecycle } = controllerHarness();
  const staleTerminal: LifecycleRunStatusResult = {
    runId: "run-historical-terminal",
    status: "failed",
    stale: true,
    runtimeReadyForSuccessor: null,
    unavailableReason: "no_current_engine",
    engineOwnerId: "owner-before-restart",
    enginePid: 1234,
    engineStartedAt: 5678,
  };
  lifecycle.statusResults = [staleTerminal, staleTerminal];
  const input = submitInput();

  await expect(controller.submitRun(input)).rejects.toMatchObject({
    status: 409,
    code: "terminal_handoff_recovery_required",
  } satisfies Partial<ApiError>);

  expect(input.runTrace.entries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:terminal-handoff-recovery:result",
    runId: "run-historical-terminal",
    outcome: "unresolved",
    generationEvidenceKind: "unresolved",
  }));
});

test("submitRun retries one registration race after guarded terminal recovery proves the predecessor idle", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();
  lifecycle.statusResults = [
    null,
    {
      runId: "run-historical-terminal",
      status: "failed",
      stale: true,
      runtimeReadyForSuccessor: null,
      unavailableReason: "no_current_engine",
      engineOwnerId: "owner-before-restart",
      enginePid: 1234,
      engineStartedAt: 5678,
    },
    {
      runId: "run-historical-terminal",
      status: "failed",
      stale: false,
      runtimeReadyForSuccessor: true,
      engineOwnerState: "lost",
    },
  ];
  lifecycle.registerError = new RunAlreadyActiveError("run-historical-terminal");
  let registerAttempts = 0;
  lifecycle.onRegister = () => {
    registerAttempts += 1;
    if (registerAttempts === 2) lifecycle.registerError = null;
  };

  const input = submitInput();
  const result = await controller.submitRun(input);

  expect(result.payload.status).toBe("submitted");
  expect(lifecycle.calls).toEqual([
    "active:ws_1:conv-a",
    "status:ws_1:conv-a:latest",
    "register:ws_1:conv-a:run-reserved:sess-a:prompt",
    "active:ws_1:conv-a",
    "status:ws_1:conv-a:latest",
    "recoverTerminalRuntimeHandoff:ws_1:run-historical-terminal",
    "status:ws_1:conv-a:latest",
    "register:ws_1:conv-a:run-reserved:sess-a:prompt",
  ]);
  expect(queue.items).toEqual([]);
  expect(submitCalls).toHaveLength(1);
  expect(input.runTrace.entries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:terminal-handoff-recovery:result",
    runId: "run-historical-terminal",
    outcome: "lost_proven",
    generationEvidenceKind: "lost_proven",
  }));
});

test("submitRun reconciles an outcome-unknown guarded retry instead of queueing behind itself", async () => {
  const { controller, lifecycle, queue, timers, reconcileCalls } = controllerHarness();
  lifecycle.statusResults = [
    null,
    {
      runId: "run-historical-terminal",
      status: "failed",
      stale: true,
      runtimeReadyForSuccessor: null,
      unavailableReason: "no_current_engine",
      engineOwnerId: "owner-before-restart",
      enginePid: 1234,
      engineStartedAt: 5678,
    },
    {
      runId: "run-historical-terminal",
      status: "failed",
      stale: false,
      runtimeReadyForSuccessor: true,
      engineOwnerState: "lost",
    },
  ];
  lifecycle.registerError = new RunAlreadyActiveError("run-historical-terminal");
  let registerAttempts = 0;
  lifecycle.onRegister = () => {
    registerAttempts += 1;
    if (registerAttempts === 2) {
      lifecycle.registerError = new OrchestratorLifecycleRequestError("/lifecycle", 503, { error: "unavailable" });
    }
  };

  await expect(controller.submitRun(submitInput())).rejects.toMatchObject({
    status: 503,
    code: "lifecycle_unavailable",
  } satisfies Partial<ApiError>);

  expect(queue.items).toEqual([]);
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({
    runId: "run-reserved",
    state: "starting",
  }));
  expect(timers.activeTimers()).toContainEqual(expect.objectContaining({ delayMs: 0 }));
  expect(reconcileCalls).toContainEqual(expect.objectContaining({
    reason: "lifecycle-register-after-proven-handoff-recovery-unconfirmed",
    runId: "run-reserved",
  }));
});

test("submitRun bypasses local lifecycle and queue paths for remote workspaces", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();

  const result = await controller.submitRun(submitInput({
    workspace: {
      id: "ws_remote",
      name: "Remote",
      path: "/repo",
      workspaceType: "remote",
    },
  }));

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  expect(lifecycle.calls).toEqual([]);
  expect(queue.items).toEqual([]);
  expect(submitCalls).toHaveLength(1);
});

test("submitRun maps lifecycle request failures to the existing API error shape", async () => {
  const { controller, lifecycle, queue, timers, reconcileCalls } = controllerHarness();
  lifecycle.registerError = new OrchestratorLifecycleRequestError("/lifecycle", 503, { code: "down" });

  await expect(controller.submitRun(submitInput())).rejects.toMatchObject({
    status: 503,
    code: "lifecycle_unavailable",
  } satisfies Partial<ApiError>);
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({
    runId: "run-reserved",
    state: "starting",
  }));
  expect(timers.activeTimers()).toContainEqual(expect.objectContaining({ delayMs: 0 }));
  expect(reconcileCalls).toContainEqual(expect.objectContaining({
    reason: "lifecycle-register-unconfirmed",
    runId: "run-reserved",
  }));
});

test("pre-attachment engine-loss evidence expires without releasing a run", async () => {
  const owner: ConversationWorkspaceRunEngineOwner = {
    engineSlotId: "ws_1",
    engineOwnerId: "generation-expired",
    enginePid: 404,
    engineStartedAt: 4_000,
    engineBaseUrl: "http://127.0.0.1:4404",
  };
  const harness = controllerHarness({
    submitEngineOwner: owner,
    engineOwnerAttachGraceMs: 25,
  });
  const { controller, queue, behavior, timers, traceEntries } = harness;
  behavior.beforeCaptureEngineOwner = () => {
    controller.notifyEngineLoss({
      eventId: "loss-before-owner-expiry",
      workspaceId: "ws_1",
      engineSlotId: owner.engineSlotId,
      engineOwnerId: owner.engineOwnerId,
      enginePid: owner.enginePid,
      engineStartedAt: owner.engineStartedAt,
      engineBaseUrl: owner.engineBaseUrl,
      runIds: ["run-expired"],
      reason: "engine exited before response headers were persisted",
    });
    const expiryTimer = timers.activeTimers().find((timer) => timer.delayMs === 25);
    expect(expiryTimer).toBeDefined();
    timers.fire(expiryTimer!.id);
  };

  await controller.submitRun(submitInput({ runId: "run-expired" }));

  expect(queue.reservations.get("ws_1\0run-expired")).toEqual(
    expect.objectContaining({ state: "active", ...owner }),
  );
  expect(traceEntries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:engine-loss-pre-attachment-expired",
    runId: "run-expired",
    graceMs: 25,
  }));
});

test("submitRun returns the existing queue item for an idempotent client message id", async () => {
  const { controller, lifecycle, queue } = controllerHarness();
  lifecycle.activeResult = { runId: "run-active", status: "running", stale: false };

  const first = await controller.submitRun(submitInput({ runId: "run-first" }));
  const second = await controller.submitRun(submitInput({ runId: "run-second" }));

  expect(first.httpStatus).toBe(202);
  expect(first.payload.queueItemId).toBe("queue-1");
  expect(first.payload.reservedRunId).toBe("run-first");
  expect(second.httpStatus).toBe(200);
  expect(second.payload.queueItemId).toBe("queue-1");
  expect(second.payload.reservedRunId).toBe("run-first");
  expect(queue.enqueueCalls).toHaveLength(2);
});

test("submitRun schedules accepted lifecycle reconciliation after successful OpenCode submit", async () => {
  const { controller, reconcileCalls, activeGatewayCalls, providerWatchCalls } = controllerHarness();

  const result = await controller.submitRun(submitInput());

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  expect(reconcileCalls).toEqual([{
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "accepted",
    delayMs: 1_234,
  }]);
  expect(activeGatewayCalls).toEqual([]);
  expect(providerWatchCalls).toEqual([]);
});

test("submitRun keeps the reservation through exact runtime handoff after a terminal submit failure", async () => {
  const {
    controller,
    behavior,
    lifecycle,
    queue,
    timers,
    activeGatewayCalls,
    providerWatchCalls,
    reconcileCalls,
  } = controllerHarness();
  behavior.submitError = new Error("opencode submit failed");
  const input = submitInput({ expectAiGatewayStart: true });

  await expect(controller.submitRun(input)).rejects.toThrow(
    "opencode submit failed",
  );

  expect(lifecycle.calls).toContain("markFailed:ws_1:run-reserved:opencode submit failed");
  expect(reconcileCalls).toContainEqual(expect.objectContaining({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "upstream-submit-failed-terminalized",
    delayMs: 0,
  }));
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({ runId: "run-reserved" }));
  expect(reconcileCalls).not.toContainEqual(expect.objectContaining({
    reason: "server:conversation-run:queue-drain-scheduled",
  }));

  lifecycle.statusResult = {
    runId: "run-reserved",
    status: "failed",
    stale: false,
    runtimeReadyForSuccessor: false,
  };
  const busyHandoffTimer = timers.activeTimers().find((timer) => timer.delayMs === 0);
  expect(busyHandoffTimer).toBeDefined();
  timers.fire(busyHandoffTimer!.id);
  await flushMicrotasks();
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({ runId: "run-reserved" }));

  lifecycle.statusResult = {
    ...lifecycle.statusResult,
    runtimeReadyForSuccessor: true,
  };
  await controller.reconcileConversationRunLifecycle({
    workspace: input.workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "upstream-submit-failed-runtime-idle",
  });
  expect(queue.listWorkspaceRunReservations()).toEqual([]);
  expect(reconcileCalls).toContainEqual(expect.objectContaining({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    reason: "server:conversation-run:queue-drain-scheduled",
    delayMs: 0,
  }));
  expect(activeGatewayCalls.map((call) => call.kind)).toEqual(["register", "unregister"]);
  expect(providerWatchCalls).toEqual([]);
  expect(input.runTrace.entries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:admitted",
    correlation: expect.objectContaining({
      authoritativeOperation: { kind: "conversation-run", id: "run-reserved" },
      causation: expect.objectContaining({ clientMessageId: "msg-a" }),
    }),
  }));
});

test("submitRun releases a failed direct legacy run so its draft can retry", async () => {
  const { controller, behavior, queue, timers } = controllerHarness({ withLifecycle: false });
  behavior.submitError = new Error("opencode submit failed");

  await expect(controller.submitRun(submitInput())).rejects.toThrow("opencode submit failed");

  expect(queue.listWorkspaceRunReservations()).toEqual([]);
  expect(timers.activeTimers()).toContainEqual(expect.objectContaining({ delayMs: 0 }));
});

test("submitRun traces lifecycle markFailed errors without hiding the submit failure", async () => {
  const {
    controller,
    behavior,
    lifecycle,
    activeGatewayCalls,
    reconcileCalls,
    traceEntries,
    queue,
  } = controllerHarness();
  behavior.submitError = new Error("opencode submit failed");
  lifecycle.markFailedError = new Error("lifecycle mark failed");
  const input = submitInput({ expectAiGatewayStart: true });

  await expect(controller.submitRun(input)).rejects.toThrow("opencode submit failed");

  expect(lifecycle.calls).toContain("markFailed:ws_1:run-reserved:opencode submit failed");
  expect(input.runTrace.entries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:lifecycle-mark-failed:error",
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "opencode submit failed",
    message: "lifecycle mark failed",
  }));
  expect(traceEntries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:lifecycle-mark-failed:error",
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "opencode submit failed",
    message: "lifecycle mark failed",
  }));
  expect(reconcileCalls).toContainEqual(expect.objectContaining({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "server:conversation-run:terminalization-retry-scheduled",
    delayMs: 1_000,
  }));
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({
    workspaceId: "ws_1",
    runId: "run-reserved",
    state: "terminalization_pending",
    terminalizationReason: "upstream_submit_failed",
    terminalizationAttempts: 1,
  }));
  expect(activeGatewayCalls.map((call) => call.kind)).toEqual(["register", "unregister"]);
});

test("terminalization retry keeps the reservation until lifecycle termination succeeds", async () => {
  const { controller, behavior, lifecycle, queue, timers, reconcileCalls } = controllerHarness();
  behavior.submitError = new Error("opencode submit failed");
  lifecycle.markFailedError = new Error("lifecycle temporarily unavailable");

  await expect(controller.submitRun(submitInput())).rejects.toThrow("opencode submit failed");
  expect(queue.listWorkspaceRunReservations()).toHaveLength(1);
  const retryTimer = timers.activeTimers().find((timer) => timer.delayMs === 1_000);
  expect(retryTimer).toBeDefined();

  lifecycle.markFailedError = null;
  timers.fire(retryTimer!.id);
  await flushMicrotasks();

  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({ runId: "run-reserved" }));
  expect(lifecycle.calls.filter((call) => call.startsWith("markFailed:"))).toHaveLength(2);
  expect(reconcileCalls).toContainEqual(expect.objectContaining({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "terminalization-retry-terminalized",
    delayMs: 0,
  }));

  lifecycle.statusResult = {
    runId: "run-reserved",
    status: "failed",
    stale: false,
    runtimeReadyForSuccessor: true,
  };
  const handoffTimer = timers.activeTimers().find((timer) => timer.delayMs === 0);
  expect(handoffTimer).toBeDefined();
  timers.fire(handoffTimer!.id);
  await flushMicrotasks();

  expect(queue.listWorkspaceRunReservations()).toEqual([]);
  expect(reconcileCalls).toContainEqual(expect.objectContaining({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    reason: "server:conversation-run:queue-drain-scheduled",
  }));
});

test("startup restores a pending terminalization retry without a new submit", () => {
  const nextAttemptAt = Date.now() + 17_000;
  const { controller, timers, queue } = controllerHarness({
    startupReservation: {
      conversationId: "conv-a",
      runId: "run-pending",
      state: "terminalization_pending",
      terminalizationReason: "upstream_submit_failed",
      terminalizationAttempts: 3,
      terminalizationLastError: "lifecycle unavailable",
      terminalizationNextAttemptAt: nextAttemptAt,
      terminalizationDeadlineAt: Date.now() + 300_000,
    },
  });

  controller.start();

  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({
    runId: "run-pending",
    state: "terminalization_pending",
    terminalizationReason: "upstream_submit_failed",
    terminalizationAttempts: 3,
    terminalizationNextAttemptAt: nextAttemptAt,
  }));
  const retryTimer = timers.activeTimers().find((timer) => timer.delayMs > 0);
  expect(retryTimer?.delayMs).toBeGreaterThanOrEqual(16_900);
  expect(retryTimer?.delayMs).toBeLessThanOrEqual(17_000);
});

test("submitRun persists its server reservation before lifecycle registration", async () => {
  const { controller, lifecycle, queue } = controllerHarness();
  lifecycle.onRegister = (input) => {
    expect(queue.reservations.get(`${input.workspaceId}\0${input.runId}`)).toEqual(
      expect.objectContaining({ conversationId: input.conversationId, state: "starting" }),
    );
  };

  await controller.submitRun(submitInput());
});

test("provider-start timeout aborts the stuck OpenCode session before failing and draining its queue", async () => {
  const {
    controller,
    behavior,
    lifecycle,
    queue,
    timers,
    submitCalls,
    activeGatewayCalls,
    activeProxyAbortCalls,
    providerWatchCalls,
    abortCalls,
    reconcileCalls,
  } = controllerHarness();
  behavior.providerStartResult = { started: false, timeoutMs: 25 };
  lifecycle.statusResult = {
    runId: "run-reserved",
    status: "failed",
    stale: false,
    runtimeReadyForSuccessor: true,
  };
  enqueuePendingRun(queue);

  const input = submitInput({ expectAiGatewayStart: true });
  const result = await controller.submitRun(input);

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  for (let index = 0; index < 5; index += 1) await flushMicrotasks();
  expect(providerWatchCalls).toHaveLength(1);
  expect(input.runTrace.entries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:ai-gateway-provider-start-watch:timeout",
    providerHitScope: "none",
    providerHitCount: 0,
    firstProviderHitAt: null,
    lastProviderHitAt: null,
  }));
  expect(abortCalls).toHaveLength(1);
  expect(activeProxyAbortCalls).toEqual([expect.objectContaining({
    workspaceId: "ws_1",
    runId: "run-reserved",
    sessionId: "sess-a",
    reason: "ai-gateway-provider-start-timeout",
  })]);
  expect(lifecycle.calls).toContain(
    "markFailed:ws_1:run-reserved:AI gateway provider request did not start within 25ms; OpenCode session was aborted.",
  );
  expect(activeGatewayCalls.map((call) => call.kind)).toEqual(["register", "unregister"]);
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({ runId: "run-reserved" }));

  const handoffTimer = timers.activeTimers().find((timer) => timer.delayMs === 0);
  expect(handoffTimer).toBeDefined();
  timers.fire(handoffTimer!.id);
  for (let index = 0; index < 5; index += 1) await flushMicrotasks();
  expect(queue.listWorkspaceRunReservations()).toEqual([]);

  const drainTimer = timers.activeTimers().find((timer) => timer.delayMs === 0);
  expect(drainTimer).toBeDefined();
  timers.fire(drainTimer!.id);
  for (let index = 0; index < 5; index += 1) await flushMicrotasks();

  expect(submitCalls.map((call) => (call as { runId: string }).runId)).toEqual([
    "run-reserved",
    "run-queued",
  ]);
  expect(reconcileCalls).not.toContainEqual(expect.objectContaining({
    reason: "ai-gateway-provider-start-timeout",
  }));
});

test("terminal transcript keeps the reservation until the runtime handoff is idle", async () => {
  const { controller, lifecycle, queue, timers } = controllerHarness();
  await controller.submitRun(submitInput());
  lifecycle.statusResult = {
    runId: "run-reserved",
    status: "completed",
    stale: false,
    runtimeReadyForSuccessor: false,
  };

  await controller.reconcileConversationRunLifecycle({
    workspace: submitInput().workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "terminal-transcript-before-idle",
  });

  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({ runId: "run-reserved" }));
  expect(timers.activeTimers()).toContainEqual(expect.objectContaining({ delayMs: 1_234 }));

  lifecycle.statusResult = {
    ...lifecycle.statusResult,
    runtimeReadyForSuccessor: true,
  };
  await controller.reconcileConversationRunLifecycle({
    workspace: submitInput().workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "terminal-runtime-idle",
  });

  expect(queue.listWorkspaceRunReservations()).toEqual([]);
});

test("stale terminal handoff asks the lifecycle owner once to retire an absent old runtime", async () => {
  const { controller, lifecycle, queue, timers, traceEntries } = controllerHarness();
  const input = submitInput();
  await controller.submitRun(input);
  enqueuePendingRun(queue);
  lifecycle.statusResult = {
    runId: "run-reserved",
    status: "failed",
    stale: true,
    runtimeReadyForSuccessor: false,
    engineOwnerState: "attached",
    unavailableReason: "no_current_engine",
  };

  await controller.reconcileConversationRunLifecycle({
    workspace: input.workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "queue-drain-terminal-handoff-pending",
  });
  expect(lifecycle.calls).toContain("recoverTerminalRuntimeHandoff:ws_1:run-reserved");
  expect(queue.items[0]?.state).toBe("pending");
  expect(traceEntries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:terminal-runtime-handoff-recovery",
    runId: "run-reserved",
    outcome: "requested",
  }));

  lifecycle.statusResult = {
    ...lifecycle.statusResult,
    stale: false,
    runtimeReadyForSuccessor: true,
    engineOwnerState: "lost",
  };
  const recoveryReconcile = timers.activeTimers().find((timer) => timer.delayMs === 0);
  expect(recoveryReconcile).toBeDefined();
  timers.fire(recoveryReconcile!.id);
  await flushMicrotasks();

  expect(queue.listWorkspaceRunReservations()).not.toContainEqual(expect.objectContaining({ runId: "run-reserved" }));
});

test("stale terminal handoff does not repeat a rejected recovery request on every poll", async () => {
  const { controller, lifecycle, queue } = controllerHarness();
  const input = submitInput();
  await controller.submitRun(input);
  enqueuePendingRun(queue);
  lifecycle.statusResult = {
    runId: "run-reserved",
    status: "failed",
    stale: true,
    runtimeReadyForSuccessor: false,
    engineOwnerState: "attached",
    unavailableReason: "no_current_engine",
  };
  lifecycle.recoverTerminalRuntimeHandoffError = new OrchestratorLifecycleRequestError(
    "/workspace/ws_1/runs/run-reserved/recover-terminal-runtime-handoff",
    409,
    { error: "terminal_handoff_recovery_runtime_active" },
  );

  await controller.reconcileConversationRunLifecycle({
    workspace: input.workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "queue-drain-terminal-handoff-pending",
  });
  await controller.reconcileConversationRunLifecycle({
    workspace: input.workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "queue-drain-terminal-handoff-pending",
    attempt: 1,
  });

  expect(lifecycle.calls.filter((call) => call === "recoverTerminalRuntimeHandoff:ws_1:run-reserved")).toHaveLength(1);
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({
    runId: "run-reserved",
    state: "terminal_handoff_unresolved",
    terminalHandoffAttempts: 1,
  }));
});

test("explicit terminal handoff retry is the only way to reopen a durable unresolved decision", async () => {
  const { controller, lifecycle, queue } = controllerHarness();
  const input = submitInput();
  await controller.submitRun(input);
  lifecycle.statusResult = {
    runId: "run-reserved",
    status: "failed",
    stale: true,
    runtimeReadyForSuccessor: false,
    engineOwnerState: "attached",
    unavailableReason: "no_current_engine",
  };
  lifecycle.recoverTerminalRuntimeHandoffError = new OrchestratorLifecycleRequestError(
    "/workspace/ws_1/runs/run-reserved/recover-terminal-runtime-handoff",
    409,
    { error: "terminal_handoff_recovery_owner_live_or_ambiguous", reason: "exact_process_alive" },
  );

  await controller.reconcileConversationRunLifecycle({
    workspace: input.workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "initial-terminal-handoff",
  });
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({
    runId: "run-reserved",
    state: "terminal_handoff_unresolved",
    terminalHandoffReason: "exact_process_alive",
  }));

  lifecycle.recoverTerminalRuntimeHandoffError = null;
  await expect(controller.retryTerminalRuntimeHandoff({
    workspace: input.workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "terminal-runtime-handoff-explicit-retry",
  })).resolves.toBe(true);

  expect(lifecycle.calls.filter((call) => call === "recoverTerminalRuntimeHandoff:ws_1:run-reserved")).toHaveLength(2);
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({
    runId: "run-reserved",
    state: "terminal_handoff_pending",
  }));
});

test("stale terminal status errors never request owner-loss recovery", async () => {
  const { controller, lifecycle, queue } = controllerHarness();
  const input = submitInput();
  await controller.submitRun(input);
  enqueuePendingRun(queue);
  lifecycle.statusResult = {
    runId: "run-reserved",
    status: "failed",
    stale: true,
    runtimeReadyForSuccessor: false,
    engineOwnerState: "attached",
    unavailableReason: "session_status_http",
    unavailableHttpStatus: 502,
  };

  await controller.reconcileConversationRunLifecycle({
    workspace: input.workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "terminal-status-http-error",
  });

  expect(lifecycle.calls).not.toContain("recoverTerminalRuntimeHandoff:ws_1:run-reserved");
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({
    runId: "run-reserved",
    state: "active",
  }));
});

test("provider-start terminal handoff requests one generation-fenced runtime recovery", async () => {
  const { controller, lifecycle, queue } = controllerHarness();
  const input = submitInput();
  await controller.submitRun(input);
  lifecycle.statusResult = {
    runId: "run-reserved",
    status: "failed",
    stale: false,
    runtimeReadyForSuccessor: false,
  };

  await controller.reconcileConversationRunLifecycle({
    workspace: input.workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "provider-start-timeout-aborted",
    attempt: 0,
  });

  expect(lifecycle.calls.filter((call) => call === "recoverProviderStartTimeout:ws_1:run-reserved")).toHaveLength(1);
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({ runId: "run-reserved" }));

  lifecycle.statusResult = {
    ...lifecycle.statusResult,
    runtimeReadyForSuccessor: true,
    engineOwnerState: "lost",
  };
  await controller.reconcileConversationRunLifecycle({
    workspace: input.workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "provider-start-timeout-runtime-recovered",
  });

  expect(queue.listWorkspaceRunReservations()).toEqual([]);
});

test("provider-start terminal handoff retries a refused generation recovery without releasing the queue", async () => {
  const { controller, lifecycle, queue } = controllerHarness();
  const input = submitInput();
  await controller.submitRun(input);
  lifecycle.statusResult = {
    runId: "run-reserved",
    status: "failed",
    stale: false,
    runtimeReadyForSuccessor: false,
  };
  lifecycle.recoverProviderStartTimeoutError = new Error("active peer still owns engine");

  await controller.reconcileConversationRunLifecycle({
    workspace: input.workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "provider-start-timeout-aborted",
    attempt: 0,
  });

  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({ runId: "run-reserved" }));
  lifecycle.recoverProviderStartTimeoutError = null;
  await controller.reconcileConversationRunLifecycle({
    workspace: input.workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "provider-start-timeout-aborted",
    attempt: 1,
  });

  expect(lifecycle.calls.filter((call) => call === "recoverProviderStartTimeout:ws_1:run-reserved")).toHaveLength(2);
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({ runId: "run-reserved" }));
});

test("provider-start timeout retries a failed OpenCode abort without releasing the queue", async () => {
  const { controller, behavior, lifecycle, queue, timers, abortCalls, activeGatewayCalls, reconcileCalls } = controllerHarness();
  behavior.providerStartResult = { started: false, timeoutMs: 25 };
  behavior.abortError = new Error("OpenCode abort unavailable");

  await controller.submitRun(submitInput({ expectAiGatewayStart: true }));
  for (let index = 0; index < 5; index += 1) await flushMicrotasks();

  expect(abortCalls).toHaveLength(1);
  expect(lifecycle.calls.some((call) => call.startsWith("markFailed:"))).toBe(false);
  expect(activeGatewayCalls.map((call) => call.kind)).toEqual(["register"]);
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({ runId: "run-reserved" }));
  expect(reconcileCalls.some((call) =>
    call.reason === "ai-gateway-provider-start-timeout-abort-retry" &&
    typeof call.delayMs === "number" &&
    call.delayMs > 4_900 &&
    call.delayMs <= 5_000,
  )).toBe(true);

  await controller.reconcileConversationRunLifecycle({
    workspace: submitInput().workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "accepted",
    delayMs: 0,
  });
  // Direct admission performs one latest-predecessor read. The retry branch
  // below must not add an unrelated status poll while its durable abort
  // recovery is still pending.
  expect(lifecycle.calls.filter((call) => call.startsWith("status:"))).toHaveLength(1);
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({ runId: "run-reserved" }));

  behavior.abortError = null;
  lifecycle.statusResult = {
    runId: "run-reserved",
    status: "running",
    stale: false,
  };
  const retryTimer = timers.activeTimers().find((timer) => timer.delayMs > 4_900 && timer.delayMs <= 5_000);
  expect(retryTimer).toBeDefined();
  timers.fire(retryTimer!.id);
  for (let index = 0; index < 5; index += 1) await flushMicrotasks();

  expect(lifecycle.calls).toContain(
    "markFailed:ws_1:run-reserved:AI gateway provider request did not start within 25ms; OpenCode session was aborted.",
  );
  expect(abortCalls).toHaveLength(2);
  lifecycle.statusResult = {
    runId: "run-reserved",
    status: "failed",
    stale: false,
    runtimeReadyForSuccessor: true,
  };
  const handoffTimer = timers.activeTimers().find((timer) => timer.delayMs === 0);
  expect(handoffTimer).toBeDefined();
  timers.fire(handoffTimer!.id);
  for (let index = 0; index < 5; index += 1) await flushMicrotasks();
  expect(queue.listWorkspaceRunReservations()).toEqual([]);
});

test("provider-start abort recovery has a durable finite retry budget", async () => {
  const { controller, behavior, queue, timers, abortCalls } = controllerHarness();
  behavior.providerStartResult = { started: false, timeoutMs: 25 };
  behavior.abortError = new Error("OpenCode abort unavailable");

  await controller.submitRun(submitInput({ expectAiGatewayStart: true }));
  for (let index = 0; index < 5; index += 1) await flushMicrotasks();

  for (const delayMs of [5_000, 10_000]) {
    const retry = timers.activeTimers().find((timer) => timer.delayMs === delayMs);
    expect(retry).toBeDefined();
    timers.fire(retry!.id);
    for (let index = 0; index < 5; index += 1) await flushMicrotasks();
  }

  expect(abortCalls).toHaveLength(3);
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({
    runId: "run-reserved",
    providerStartAbortPending: true,
    providerStartAbortAttempts: 3,
    providerStartAbortNextAttemptAt: null,
  }));
  expect(timers.activeTimers().some((timer) => [5_000, 10_000, 20_000].includes(timer.delayMs))).toBe(false);
});

test("startup rechecks an exhausted provider-start abort recovery before draining its successor", async () => {
  const { controller, lifecycle, queue, timers, submitCalls, traceEntries } = controllerHarness({
    startupReservation: {
      conversationId: "conv-a",
      runId: "run-stale",
      state: "active",
      providerStartAbortPending: true,
      providerStartAbortDirectory: "/repo",
      providerStartAbortOpenCodeSessionId: "sess-a",
      providerStartAbortAttempts: 3,
      providerStartAbortLastError: "OpenCode abort unavailable",
      providerStartAbortNextAttemptAt: null,
      providerStartAbortDeadlineAt: Date.now() - 1,
    },
  });
  enqueuePendingRun(queue);
  lifecycle.statusResult = {
    runId: "run-stale",
    status: "failed",
    stale: false,
    runtimeReadyForSuccessor: true,
  };

  controller.start();

  const reconciliation = timers.activeTimers().find((timer) => timer.delayMs === 0);
  expect(reconciliation).toBeDefined();
  timers.fire(reconciliation!.id);
  for (let index = 0; index < 5; index += 1) await flushMicrotasks();

  expect(lifecycle.calls).toContain("status:ws_1:conv-a:run-stale");
  expect(queue.listWorkspaceRunReservations()).toEqual([]);
  expect(traceEntries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:provider-start-timeout-abort:recovery-exhausted",
    runId: "run-stale",
  }));

  const drain = timers.activeTimers().find((timer) => timer.delayMs === 0);
  expect(drain).toBeDefined();
  timers.fire(drain!.id);
  for (let index = 0; index < 5; index += 1) await flushMicrotasks();

  expect(submitCalls).toHaveLength(1);
  expect(queue.nextPending("ws_1", "conv-a")).toBeNull();
});

test("provider-start timeout releases a run that completed before its abort retry", async () => {
  const { controller, behavior, lifecycle, queue, timers, abortCalls } = controllerHarness();
  behavior.providerStartResult = { started: false, timeoutMs: 25 };
  behavior.abortError = new Error("OpenCode abort unavailable");

  await controller.submitRun(submitInput({ expectAiGatewayStart: true }));
  for (let index = 0; index < 5; index += 1) await flushMicrotasks();
  lifecycle.statusResult = { runId: "run-reserved", status: "completed", stale: false };
  behavior.abortError = null;

  const retryTimer = timers.activeTimers().find((timer) => timer.delayMs === 5_000);
  expect(retryTimer).toBeDefined();
  timers.fire(retryTimer!.id);
  for (let index = 0; index < 5; index += 1) await flushMicrotasks();

  expect(abortCalls).toHaveLength(1);
  expect(lifecycle.calls.some((call) => call.startsWith("markFailed:"))).toBe(false);
  expect(lifecycle.calls.some((call) => call.startsWith("markAborted:"))).toBe(false);
  expect(queue.listWorkspaceRunReservations()).toEqual([]);
});

test("provider-start watcher errors retain the normal lifecycle reconcile budget", async () => {
  const { controller, lifecycle } = controllerHarness();
  lifecycle.statusResult = {
    runId: "run-reserved",
    status: "running",
    stale: false,
  };

  await controller.reconcileConversationRunLifecycle({
    workspace: submitInput().workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "ai-gateway-provider-start-watch-error",
    attempt: 1,
  });

  expect(lifecycle.calls.some((call) => call.startsWith("markFailed:"))).toBe(false);
});

test("guarded workspace reload blocks an admitted run and succeeds after terminal release", async () => {
  const { controller, lifecycle } = controllerHarness();
  lifecycle.statusResult = { runId: "run-reserved", status: "completed", stale: false };
  let reloads = 0;

  await controller.submitRun(submitInput());
  const blocked = await controller.reloadWorkspaceEngineIfIdle({
    workspaceId: "ws_1",
    reload: async () => {
      reloads += 1;
    },
  });
  expect(blocked).toEqual({ kind: "blocked", reason: "active-runs" });
  expect(reloads).toBe(0);

  await controller.reconcileConversationRunLifecycle({
    workspace: submitInput().workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "test-terminal-release",
  });
  const reloaded = await controller.reloadWorkspaceEngineIfIdle({
    workspaceId: "ws_1",
    reload: async () => {
      reloads += 1;
    },
  });
  expect(reloaded).toEqual({ kind: "reloaded" });
  expect(reloads).toBe(1);
});

test("control-plane rebind remains grantable while a run is reserved", async () => {
  const { controller, lifecycle } = controllerHarness();
  lifecycle.statusResult = { runId: "run-reserved", status: "completed", stale: false };

  await controller.submitRun(submitInput());
  const granted = await controller.requestWorkspaceRuntimeOperation({
    workspaceId: "ws_1",
    operationId: "rebind-a",
    kind: "rebind_control_plane",
    sourceClass: "automatic",
    reasonCode: "sse_invalid_bearer",
    expiresAt: Date.now() + 10_000,
  });
  expect(granted).toEqual(expect.objectContaining({
    kind: "granted",
    operation: expect.objectContaining({ operationId: "rebind-a", state: "granted" }),
  }));
  expect(await controller.beginWorkspaceRuntimeOperation("ws_1", "rebind-a")).toEqual(
    expect.objectContaining({ state: "executing" }),
  );
});

test("idle-only runtime operation records why an active reservation blocks it", async () => {
  const { controller, traceEntries } = controllerHarness();
  await controller.submitRun(submitInput());

  await expect(controller.requestWorkspaceRuntimeOperation({
    workspaceId: "ws_1",
    operationId: "reload-a",
    kind: "reload_workspace_if_idle",
    sourceClass: "automatic",
    reasonCode: "test-reload",
    expiresAt: Date.now() + 10_000,
  })).resolves.toEqual({ kind: "blocked", reason: "active-runs" });
  expect(traceEntries).toContainEqual(expect.objectContaining({
    event: "server:runtime-operation:blocked",
    workspaceId: "ws_1",
    operationKind: "reload_workspace_if_idle",
    reason: "active-runs",
    reservationCount: 1,
  }));
});

test("runtime-operation lease queues new input until completion then permits the server queue", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();
  lifecycle.statusResult = { runId: "run-next", status: "completed", stale: false, runtimeReadyForSuccessor: true };
  const granted = await controller.requestWorkspaceRuntimeOperation({
    workspaceId: "ws_1",
    operationId: "rebind-a",
    kind: "rebind_control_plane",
    sourceClass: "automatic",
    reasonCode: "sse_invalid_bearer",
    expiresAt: Date.now() + 10_000,
  });
  expect(granted.kind).toBe("granted");

  const queued = await controller.submitRun(submitInput({ runId: "run-next", clientMessageId: "msg-next" }));
  expect(queued.httpStatus).toBe(202);
  expect(queue.items).toContainEqual(expect.objectContaining({ reservedRunId: "run-next", state: "pending" }));
  expect(submitCalls).toEqual([]);

  await controller.beginWorkspaceRuntimeOperation("ws_1", "rebind-a");
  await controller.completeWorkspaceRuntimeOperation({
    workspaceId: "ws_1",
    operationId: "rebind-a",
    state: "completed",
    terminalCode: "rebound",
  });
  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(submitCalls).toHaveLength(1);
  expect(queue.items).toContainEqual(expect.objectContaining({ reservedRunId: "run-next", state: "submitted" }));
});

test("unknown runtime-operation outcome keeps queued input fenced until a new explicit operation is granted", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();
  lifecycle.statusResult = { runId: "run-next", status: "completed", stale: false, runtimeReadyForSuccessor: true };
  const first = await controller.requestWorkspaceRuntimeOperation({
    workspaceId: "ws_1",
    operationId: "rebind-expired",
    kind: "rebind_control_plane",
    sourceClass: "automatic",
    reasonCode: "sse_invalid_bearer",
    expiresAt: Date.now() + 10_000,
  });
  expect(first.kind).toBe("granted");
  await controller.completeWorkspaceRuntimeOperation({
    workspaceId: "ws_1",
    operationId: "rebind-expired",
    state: "outcome_unknown",
    terminalCode: "lease_expired",
  });

  const queued = await controller.submitRun(submitInput({ runId: "run-next", clientMessageId: "msg-next" }));
  expect(queued.httpStatus).toBe(202);
  await controller.drainConversationQueue("ws_1", "conv-a");
  expect(submitCalls).toEqual([]);
  expect(queue.items).toContainEqual(expect.objectContaining({ reservedRunId: "run-next", state: "pending" }));

  const replacement = await controller.requestWorkspaceRuntimeOperation({
    workspaceId: "ws_1",
    operationId: "rebind-retry",
    kind: "rebind_control_plane",
    sourceClass: "automatic",
    reasonCode: "sse_invalid_bearer",
    expiresAt: Date.now() + 10_000,
  });
  expect(replacement).toEqual(expect.objectContaining({
    kind: "granted",
    operation: expect.objectContaining({ operationId: "rebind-retry", state: "granted" }),
  }));
});

test("workspace idle subscribers are notified once when the final run reaches terminal state", async () => {
  const { controller, lifecycle } = controllerHarness();
  lifecycle.statusResult = { runId: "run-reserved", status: "completed", stale: false };
  const idleWorkspaces: string[] = [];
  const unsubscribe = controller.subscribeWorkspaceIdle((workspaceId) => {
    idleWorkspaces.push(workspaceId);
  });

  await controller.submitRun(submitInput());
  await controller.reconcileConversationRunLifecycle({
    workspace: submitInput().workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "test-terminal-release",
  });
  await controller.reconcileConversationRunLifecycle({
    workspace: submitInput().workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "test-terminal-release-repeat",
  });
  unsubscribe();

  expect(idleWorkspaces).toEqual(["ws_1"]);
});

test("terminal release is idempotent for guarded workspace reload", async () => {
  const { controller, lifecycle } = controllerHarness();
  lifecycle.statusResult = { runId: "run-reserved", status: "completed", stale: false };
  await controller.submitRun(submitInput());
  const terminal = {
    workspace: submitInput().workspace,
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "test-terminal-release",
  };

  await controller.reconcileConversationRunLifecycle(terminal);
  await controller.reconcileConversationRunLifecycle(terminal);
  const result = await controller.reloadWorkspaceEngineIfIdle({
    workspaceId: "ws_1",
    reload: async () => undefined,
  });
  expect(result).toEqual({ kind: "reloaded" });
});

test("submitRun retains managed-AI correlation in direct start mode until the runtime-owner TTL", async () => {
  const { controller, activeGatewayCalls, providerWatchCalls } = controllerHarness({ withLifecycle: false });

  const result = await controller.submitRun(submitInput({ expectAiGatewayStart: true }));

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  expect(activeGatewayCalls.map((call) => call.kind)).toEqual(["register"]);
  expect(providerWatchCalls).toEqual([]);
});

test("submitRun keeps active gateway context after provider start and clears it on terminal lifecycle reconcile", async () => {
  const {
    controller,
    lifecycle,
    timers,
    activeGatewayCalls,
    providerWatchCalls,
    abortCalls,
    reconcileCalls,
  } = controllerHarness();

  const result = await controller.submitRun(submitInput({
    expectAiGatewayStart: true,
    runtimeAuthorizationActorTokenHash: "request-actor-hash",
    runtimeAuthorizationOrgId: "org-a",
  }));

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  await flushMicrotasks();
  expect(providerWatchCalls).toHaveLength(1);
  expect(abortCalls).toEqual([]);
  expect(activeGatewayCalls.map((call) => call.kind)).toEqual(["register"]);
  expect(activeGatewayCalls[0]?.input).toMatchObject({
    runtimeAuthorizationActorTokenHash: "request-actor-hash",
    runtimeAuthorizationOrgId: "org-a",
  });
  expect(reconcileCalls).toEqual([{
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "accepted",
    delayMs: 1_234,
  }]);

  lifecycle.statusResult = { runId: "run-reserved", status: "completed", stale: false };
  timers.fire(timers.activeTimers()[0]!.id);
  await flushMicrotasks();

  expect(activeGatewayCalls.map((call) => call.kind)).toEqual(["register", "unregister"]);
  expect(activeGatewayCalls[1]?.input).toEqual({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    opencodeSessionId: "sess-a",
  });
});

test("terminal lifecycle reconcile requests one server-owned transcript ingest before queue drain", async () => {
  const ingestedRunIds: string[] = [];
  const { controller, lifecycle, timers } = controllerHarness({
    ingestTerminalTranscript: async ({ runId }) => {
      ingestedRunIds.push(runId);
    },
  });

  await controller.submitRun(submitInput());
  lifecycle.statusResult = { runId: "run-reserved", status: "completed", stale: false };
  timers.fire(timers.activeTimers()[0]!.id);
  await flushMicrotasks();

  expect(ingestedRunIds).toEqual(["run-reserved"]);
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toContain(0);
});

test("terminal delivery evidence calls an exhausted canonical ingest unavailable, not recovered", async () => {
  const { controller, lifecycle, timers, terminalRecoveries } = controllerHarness({
    ingestTerminalTranscript: async () => ({ kind: "exhausted" }),
  });

  await controller.submitRun(submitInput());
  lifecycle.statusResult = { runId: "run-reserved", status: "failed", stale: false };
  timers.fire(timers.activeTimers()[0]!.id);
  await flushMicrotasks();
  await flushMicrotasks();

  expect(terminalRecoveries).toContainEqual({
    runId: "run-reserved",
    lifecycle: "failed",
    canonicalRecovery: "unavailable",
  });
});

test("terminal delivery evidence records unavailable recovery even when no ingest port exists", async () => {
  const { controller, lifecycle, timers, terminalRecoveries } = controllerHarness();

  await controller.submitRun(submitInput());
  lifecycle.statusResult = { runId: "run-reserved", status: "completed", stale: false };
  timers.fire(timers.activeTimers()[0]!.id);
  await flushMicrotasks();

  expect(terminalRecoveries).toContainEqual({
    runId: "run-reserved",
    lifecycle: "completed",
    canonicalRecovery: "unavailable",
  });
});

test("submitRun tracks active gateway context for command runs when provider start is expected", async () => {
  const { controller, activeGatewayCalls, providerWatchCalls, reconcileCalls } = controllerHarness();

  const result = await controller.submitRun(submitInput({
    kind: "command",
    body: { kind: "command", command: "skills.run", arguments: "{}" },
    expectAiGatewayStart: true,
  }));

  expect(result.httpStatus).toBe(200);
  expect(result.payload.status).toBe("submitted");
  await flushMicrotasks();
  expect(activeGatewayCalls.map((call) => call.kind)).toEqual(["register"]);
  expect(activeGatewayCalls[0]?.input).toMatchObject({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    opencodeSessionId: "sess-a",
    clientMessageId: "msg-a",
    origin: "composer",
  });
  expect(providerWatchCalls).toHaveLength(1);
  expect(providerWatchCalls[0]).toMatchObject({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    opencodeSessionId: "sess-a",
    clientMessageId: "msg-a",
    origin: "composer",
  });
  expect(reconcileCalls).toEqual([{
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-reserved",
    reason: "accepted",
    delayMs: 1_234,
  }]);
});

test("queue drain keeps pending work blocked while latest lifecycle is active", async () => {
  const { controller, lifecycle, queue, submitCalls, timers, backgroundTraceEntries } = controllerHarness();
  enqueuePendingRun(queue);
  lifecycle.statusResult = { runId: "run-active", status: "running", stale: false };

  await controller.drainConversationQueue("ws_1", "conv-a");
  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(queue.items[0]?.state).toBe("pending");
  expect(submitCalls).toEqual([]);
  expect(lifecycle.calls).toEqual(["status:ws_1:conv-a:latest", "status:ws_1:conv-a:latest"]);
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([1_500]);
  const activeDeferrals = backgroundTraceEntries.flat().filter(
    (entry) => entry.event === "server:conversation-run:queue-drain-active-deferred",
  );
  expect(activeDeferrals).toEqual([expect.objectContaining({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    queueItemId: queue.items[0]?.queueItemId,
    runId: "run-queued",
    blockingRunId: "run-active",
    status: "running",
    stale: false,
    clientMessageId: "msg-queued",
    queuedClientMessageId: "msg-queued",
    blockingClientMessageId: null,
  })]);
});

test("queue drain turns an unresolved terminal predecessor into one durable barrier without another poll", async () => {
  const { controller, lifecycle, queue, timers, backgroundTraceEntries } = controllerHarness();
  const queued = enqueuePendingRun(queue, { clientMessageId: "msg-historical-successor" });
  lifecycle.statusResult = {
    runId: "run-historical-terminal",
    status: "failed",
    stale: true,
    runtimeReadyForSuccessor: null,
    unavailableReason: "no_current_engine",
    engineOwnerId: "owner-before-restart",
    enginePid: 1234,
    engineStartedAt: 5678,
  };
  lifecycle.recoverTerminalRuntimeHandoffError = new OrchestratorLifecycleRequestError(
    "/workspace/ws_1/runs/run-historical-terminal/recover-terminal-runtime-handoff",
    409,
    { error: "terminal_handoff_recovery_owner_unknown", reason: "process_identity_unavailable" },
  );

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(queue.getForReservedRun("ws_1", "conv-a", queued.reservedRunId)?.state).toBe("pending");
  expect(queue.getTerminalHandoffBarrier("ws_1", "conv-a", "run-historical-terminal")).toEqual(expect.objectContaining({
    state: "unresolved",
    reason: "process_identity_unavailable",
  }));
  expect(timers.activeTimers()).toEqual([]);
  expect(backgroundTraceEntries.flat()).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:queue-drain-terminal-handoff-unresolved",
    queueItemId: queued.queueItemId,
    blockingRunId: "run-historical-terminal",
    reason: "process_identity_unavailable",
  }));
});

test("queue drain reconciles the run holding a conflicting stale reservation", async () => {
  const { controller, lifecycle, queue, timers, reconcileCalls, traceEntries } = controllerHarness();
  const queued = enqueuePendingRun(queue);
  queue.reserveWorkspaceRun({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-terminal",
    state: "active",
  });
  queue.reservationConflictRunId = "run-terminal";
  lifecycle.statusResult = {
    runId: "run-terminal",
    status: "completed",
    stale: false,
    runtimeReadyForSuccessor: true,
  };

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(queue.getForReservedRun("ws_1", "conv-a", queued.reservedRunId)?.state).toBe("pending");
  expect(reconcileCalls).toContainEqual(expect.objectContaining({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-terminal",
    reason: "queue-drain-reservation-conflict",
    delayMs: 0,
  }));
  expect(timers.activeTimers().map((timer) => timer.delayMs).sort((left, right) => left - right)).toEqual([0, 1_500]);
  expect(traceEntries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:queue-drain-reservation-conflict",
    queueItemId: queued.queueItemId,
    activeRunId: "run-terminal",
    reservationConflictAttempts: 1,
  }));
});

test("queue drain claims a proven-lost predecessor release without provider-start evidence", async () => {
  const { controller, lifecycle, queue, traceEntries } = controllerHarness();
  enqueuePendingRun(queue);
  queue.reserveWorkspaceRun({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-terminal",
    state: "active",
  });
  queue.reservationConflictRunId = "run-terminal";
  lifecycle.statusResult = {
    runId: "run-terminal",
    status: "failed",
    stale: false,
    runtimeReadyForSuccessor: true,
    engineOwnerState: "lost",
  };

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(traceEntries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:lifecycle-reconcile-scheduled",
    runId: "run-terminal",
    reason: "queue-drain-reservation-conflict",
    predecessorReleaseProven: true,
  }));
});

test("queue drain never claims a predecessor release while its engine owner is still attached", async () => {
  const { controller, lifecycle, queue, traceEntries } = controllerHarness();
  enqueuePendingRun(queue);
  queue.reserveWorkspaceRun({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-terminal",
    state: "active",
  });
  queue.reservationConflictRunId = "run-terminal";
  lifecycle.statusResult = {
    runId: "run-terminal",
    status: "failed",
    stale: false,
    runtimeReadyForSuccessor: true,
    engineOwnerState: "attached",
  };

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(traceEntries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:lifecycle-reconcile-scheduled",
    runId: "run-terminal",
    reason: "queue-drain-reservation-conflict",
    predecessorReleaseProven: false,
  }));
});

test("queue drain caps repeated reservation conflicts and persists one unresolved barrier", async () => {
  const { controller, lifecycle, queue, timers, backgroundTraceEntries } = controllerHarness();
  const queued = enqueuePendingRun(queue);
  queue.reservationConflictRunId = "run-terminal";
  lifecycle.statusResult = {
    runId: "run-terminal",
    status: "completed",
    stale: false,
    runtimeReadyForSuccessor: true,
  };

  for (let attempt = 1; attempt < 40; attempt += 1) {
    await controller.drainConversationQueue("ws_1", "conv-a");
  }
  const timerCountBeforeCap = timers.timers.length;
  await controller.drainConversationQueue("ws_1", "conv-a");
  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(timers.timers).toHaveLength(timerCountBeforeCap);
  expect(queue.getForReservedRun("ws_1", "conv-a", queued.reservedRunId)?.state).toBe("pending");
  expect(queue.getTerminalHandoffBarrier("ws_1", "conv-a", "run-terminal")).toEqual(expect.objectContaining({
    state: "unresolved",
    reason: "reservation_conflict_unresolved",
  }));
  expect(backgroundTraceEntries.flat().filter(
    (entry) => entry.event === "server:conversation-run:queue-drain-reservation-conflict-unresolved",
  )).toEqual([expect.objectContaining({
    queueItemId: queued.queueItemId,
    blockingRunId: "run-terminal",
    reason: "reservation_conflict_unresolved",
    reservationConflictAttempts: 40,
  })]);
});

test("queue drain does not make a durable handoff barrier from a post-recovery lifecycle read failure", async () => {
  const { controller, lifecycle, queue, timers, backgroundTraceEntries } = controllerHarness();
  const queued = enqueuePendingRun(queue, { clientMessageId: "msg-retry-after-lifecycle-read" });
  lifecycle.statusResult = {
    runId: "run-historical-terminal",
    status: "failed",
    stale: true,
    runtimeReadyForSuccessor: null,
    unavailableReason: "no_current_engine",
    engineOwnerId: "owner-before-restart",
    enginePid: 1234,
    engineStartedAt: 5678,
  };
  lifecycle.onRecoverTerminalRuntimeHandoff = () => {
    lifecycle.statusError = new OrchestratorLifecycleRequestError(
      "/workspace/ws_1/conversations/conv-a/runs/latest",
      503,
      { error: "daemon_unavailable" },
    );
  };

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(queue.getForReservedRun("ws_1", "conv-a", queued.reservedRunId)?.state).toBe("pending");
  expect(queue.getTerminalHandoffBarrier("ws_1", "conv-a", "run-historical-terminal")).toBeNull();
  expect(timers.activeTimers()).toContainEqual(expect.objectContaining({ delayMs: 1_500 }));
  expect(backgroundTraceEntries.flat()).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:queue-drain-status-error",
    queueItemId: queued.queueItemId,
    lifecycleHttpStatus: 503,
  }));
});

test("queue-drain status diagnostics retain a safe error classification without a redacted message", async () => {
  const { controller, lifecycle, queue, backgroundTraceEntries } = controllerHarness();
  enqueuePendingRun(queue);
  lifecycle.statusError = new OrchestratorLifecycleRequestError(
    "/workspace/ws_1/conversations/conv-a/runs/latest",
    503,
    { error: "daemon_unavailable" },
  );

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(backgroundTraceEntries.flat()).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:queue-drain-status-error",
    queueItemId: "queue-1",
    runId: "run-queued",
    clientMessageId: "msg-queued",
    errorKind: "lifecycle_request_failed",
    lifecycleHttpStatus: 503,
    nextRetryInMs: 1_500,
  }));
  expect(backgroundTraceEntries.flat().find(
    (entry) => entry.event === "server:conversation-run:queue-drain-status-error",
  )).not.toHaveProperty("message");
});

test("queue drain delegates generic stale active runs to normal lifecycle reconciliation", async () => {
  const { controller, lifecycle, queue, submitCalls, timers, backgroundTraceEntries } = controllerHarness();
  enqueuePendingRun(queue);
  lifecycle.statusResult = {
    runId: "run-zombie",
    status: "running",
    stale: true,
    waitReason: "engine_unreachable",
    noProgressSeconds: 900,
  };

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(queue.items[0]?.state).toBe("pending");
  expect(submitCalls).toEqual([]);
  expect(lifecycle.calls).toContain("status:ws_1:conv-a:latest");
  expect(lifecycle.calls.some((call) => call.startsWith("markFailed:"))).toBe(false);
  expect(backgroundTraceEntries.flat()).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:queue-drain-stale-active-deferred",
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-queued",
    blockingRunId: "run-zombie",
    waitReason: "engine_unreachable",
  }));
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([0]);

  timers.fire(timers.activeTimers()[0]!.id);
  await flushMicrotasks();

  expect(lifecycle.calls).toContain("status:ws_1:conv-a:run-zombie");
  expect(lifecycle.calls.some((call) => call.startsWith("markFailed:"))).toBe(false);
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([2_000]);
});

test("lifecycle reconcile keeps polling stale status until terminal", async () => {
  const { controller, lifecycle, timers, workspaces } = controllerHarness();
  lifecycle.statusResult = { runId: "run-stale", status: "running", stale: true };

  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-stale",
    reason: "accepted",
  });

  expect(lifecycle.calls).toEqual(["status:ws_1:conv-a:run-stale"]);
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([2_000]);
});

test("lifecycle reconciliation closes an unreachable engine after its progress grace window", async () => {
  const { controller, lifecycle, timers, traceEntries, workspaces } = controllerHarness();
  lifecycle.statusResult = {
    runId: "run-unreachable",
    status: "running",
    stale: true,
    activityKind: "unknown",
    waitReason: "engine_unreachable",
    lastUsefulProgressAt: Date.now() - 60_001,
  };

  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-unreachable",
    reason: "accepted",
  });

  expect(lifecycle.calls).toContain("status:ws_1:conv-a:run-unreachable");
  expect(lifecycle.calls).toContain(
    "markFailed:ws_1:run-unreachable:engine remained unreachable after useful run progress stopped",
  );
  expect(traceEntries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:lifecycle-reconcile-engine-unreachable",
    runId: "run-unreachable",
  }));
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([0]);
});

test("lifecycle reconcile fails stale active runs after poll budget exhaustion and wakes queue", async () => {
  const { controller, lifecycle, timers, workspaces } = controllerHarness();
  lifecycle.statusResult = {
    runId: "run-stale",
    status: "blocked",
    stale: true,
    waitReason: "engine_unreachable",
    noProgressSeconds: 900,
  };

  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-stale",
    reason: "accepted",
    attempt: 2,
  });

  expect(lifecycle.calls).toContain("status:ws_1:conv-a:run-stale");
  expect(lifecycle.calls).toContain(
    "markFailed:ws_1:run-stale:run lifecycle reconcile exhausted while active status remained unresolved",
  );
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([0]);
});

test("lifecycle reconcile keeps an exact no-output model retry in low-churn background observation", async () => {
  const { controller, lifecycle, timers, traceEntries, workspaces } = controllerHarness();
  lifecycle.statusResult = {
    runId: "run-model-retry",
    status: "running",
    stale: false,
    activityKind: "model_retry",
    waitReason: "model_retry_no_output",
    noProgressSeconds: 601,
  };

  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-model-retry",
    reason: "accepted",
    attempt: 2,
  });

  expect(lifecycle.calls).toContain("status:ws_1:conv-a:run-model-retry");
  expect(lifecycle.calls.some((call) => call.startsWith("markFailed:"))).toBe(false);
  expect(timers.activeTimers()).toContainEqual(expect.objectContaining({ delayMs: 30_000 }));
  expect(traceEntries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:model-retry-background-reconcile",
    runId: "run-model-retry",
  }));
});

test("startup reconciliation closes an old assistant-message orphan without repeated polling", async () => {
  const { controller, lifecycle, queue, timers, traceEntries } = controllerHarness({
    startupReservation: { conversationId: "conv-a", runId: "run-orphaned" },
  });
  lifecycle.statusResult = {
    runId: "run-orphaned",
    status: "running",
    stale: false,
    activityKind: "unknown",
    waitReason: "assistant_message_open",
    lastUsefulProgressAt: Date.now() - 60_001,
  };

  controller.start();
  timers.fire(timers.activeTimers()[0]!.id);
  await flushMicrotasks();

  expect(lifecycle.calls).toContain("status:ws_1:conv-a:run-orphaned");
  expect(lifecycle.calls).toContain(
    "markFailed:ws_1:run-orphaned:startup lifecycle reservation had no useful progress while its assistant message remained open",
  );
  expect(queue.listWorkspaceRunReservations()).toEqual([]);
  expect(traceEntries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:lifecycle-reconcile-startup-orphaned",
    runId: "run-orphaned",
  }));
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([0]);
});

test("lifecycle reconcile ingests an unresolved active transcript before poll budget failure", async () => {
  const ingestedRunIds: string[] = [];
  const { controller, lifecycle, timers, workspaces } = controllerHarness({
    ingestTerminalTranscript: async ({ runId }) => {
      ingestedRunIds.push(runId);
    },
  });
  lifecycle.statusResult = {
    runId: "run-active",
    status: "running",
    stale: false,
    activityKind: "unknown",
    waitReason: "assistant_message_open",
    noProgressSeconds: null,
  };

  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-active",
    directory: "/tmp/workspace-a",
    opencodeSessionId: "sess-a",
    reason: "accepted",
    attempt: 2,
  });

  expect(lifecycle.calls).toContain(
    "markFailed:ws_1:run-active:run lifecycle reconcile exhausted while active status remained unresolved",
  );
  expect(ingestedRunIds).toEqual(["run-active"]);
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([0]);
});

test("lifecycle reconcile trace includes active run diagnostics", async () => {
  const { controller, lifecycle, traceEntries, workspaces } = controllerHarness();
  lifecycle.statusResult = {
    runId: "run-active",
    status: "running",
    stale: false,
    clientMessageId: "msg-a",
    origin: "session:normal",
    activityKind: "unknown",
    waitReason: "assistant_message_open",
    noProgressSeconds: 17,
  };

  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-active",
    reason: "accepted",
  });

  expect(
    traceEntries.find((entry) => entry.event === "server:conversation-run:lifecycle-reconcile"),
  ).toMatchObject({
    runId: "run-active",
    status: "running",
    stale: false,
    clientMessageId: "msg-a",
    origin: "session:normal",
    activityKind: "unknown",
    waitReason: "assistant_message_open",
    noProgressSeconds: 17,
  });
});

test("lifecycle reconcile trace records a redacted terminal failure and engine binding", async () => {
  const { controller, lifecycle, traceEntries, workspaces } = controllerHarness();
  lifecycle.statusResult = {
    runId: "run-failed",
    status: "failed",
    stale: false,
    error: "provider rejected request: api_key=secret-value",
    engineSlotId: "slot-a",
    engineOwnerId: "owner-a",
    engineOwnerState: "attached",
    enginePid: 4242,
    engineStartedAt: 123,
  };

  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-failed",
    reason: "accepted",
  });

  expect(
    traceEntries.find((entry) => entry.event === "server:conversation-run:lifecycle-reconcile"),
  ).toMatchObject({
    runId: "run-failed",
    status: "failed",
    terminalError: "provider rejected request: api_key=[redacted]",
    engineSlotId: "slot-a",
    engineOwnerId: "owner-a",
    engineOwnerState: "attached",
    enginePid: 4242,
    engineStartedAt: 123,
  });
});

test("queue drain submits the next pending item after terminal latest lifecycle", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();
  const queued = enqueuePendingRun(queue);
  lifecycle.statusResult = { runId: "run-terminal", status: "completed", stale: false };

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(queue.items[0]?.state).toBe("submitted");
  expect(submitCalls).toHaveLength(1);
  const submittedMessageId = (submitCalls[0] as SubmittedOpenCodeCall).opencodeMessageId;
  expect(submittedMessageId).toMatch(/^msg_[0-9a-f]{26}$/);
  expect(lifecycle.registerInputs[0]?.opencodeMessageId).toBe(submittedMessageId);
  expect(lifecycle.calls).toEqual([
    "status:ws_1:conv-a:latest",
    "register:ws_1:conv-a:run-queued:sess-a:prompt",
  ]);
  expect(submitCalls).toHaveLength(1);
  const admittedTrace = (submitCalls[0] as SubmittedOpenCodeCall).runTrace.entries.find(
    (entry) => entry.event === "server:conversation-run:admitted",
  );
  expect(admittedTrace).toMatchObject({
    correlation: expect.objectContaining({
      authoritativeOperation: { kind: "conversation-run", id: "run-queued" },
      causation: expect.objectContaining({ queueItemId: queued.queueItemId, clientMessageId: "msg-queued" }),
    }),
  });
  expect((submitCalls[0] as SubmittedOpenCodeCall).runTrace.entries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:queue-drain-claimed",
    queueItemId: queued.queueItemId,
    runId: "run-queued",
    queueWaitMs: expect.any(Number),
  }));
  expect((submitCalls[0] as SubmittedOpenCodeCall).runTrace.entries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:queue-drain-submitted",
    queueItemId: queued.queueItemId,
    runId: "run-queued",
    queueWaitMs: expect.any(Number),
  }));
});

test("queue drain gives a delayed draft an admission-time OpenCode message id", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();
  const queued = enqueuePendingRun(queue);
  // Model a draft that waited behind a previous assistant turn. Its queue
  // timestamp must never determine OpenCode's chronological turn ordering.
  queue.items[0]!.createdAt = 1;
  lifecycle.statusResult = { runId: "run-terminal", status: "completed", stale: false };

  await controller.drainConversationQueue("ws_1", "conv-a");

  const submittedMessageId = (submitCalls[0] as SubmittedOpenCodeCall).opencodeMessageId;
  const startedAt = queue.items[0]?.startedAt;
  expect(startedAt).toEqual(expect.any(Number));
  expect(submittedMessageId).toBe(createConversationRunOpenCodeMessageId({
    workspaceId: "ws_1",
    engineSessionId: "sess-a",
    clientMessageId: "msg-queued",
    runId: "run-queued",
    timestamp: startedAt!,
  }));
  expect(submittedMessageId).not.toBe(createConversationRunOpenCodeMessageId({
    workspaceId: "ws_1",
    engineSessionId: "sess-a",
    clientMessageId: "msg-queued",
    runId: "run-queued",
    timestamp: queued.createdAt,
  }));
});

test("queue drain reuses an attached terminal runtime only after exact idle evidence", async () => {
  const { controller, lifecycle, queue, submitCalls } = controllerHarness();
  enqueuePendingRun(queue);
  lifecycle.statusResult = {
    runId: "run-terminal",
    status: "completed",
    stale: false,
    runtimeReadyForSuccessor: true,
    engineOwnerState: "attached",
  };

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(lifecycle.calls).toEqual([
    "status:ws_1:conv-a:latest",
    "register:ws_1:conv-a:run-queued:sess-a:prompt",
  ]);
  expect(queue.items[0]?.state).toBe("submitted");
  expect(submitCalls).toHaveLength(1);
});

test("submitRun does not retain a local reservation when the legacy runtime has no lifecycle owner", async () => {
  const { controller, queue, submitCalls } = controllerHarness({ withLifecycle: false });

  await controller.submitRun(submitInput({ runId: "run-legacy-first", clientMessageId: "msg-legacy-first" }));
  await controller.submitRun(submitInput({ runId: "run-legacy-follow-up", clientMessageId: "msg-legacy-follow-up" }));

  expect(queue.listWorkspaceRunReservations()).toEqual([]);
  expect(submitCalls).toHaveLength(2);
});

test("queue drain does not submit when another controller wins the durable claim", async () => {
  const { controller, queue, submitCalls } = controllerHarness();
  const item = enqueuePendingRun(queue);
  queue.lostClaimQueueItemId = item.queueItemId;

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(queue.items[0]?.state).toBe("starting");
  expect(submitCalls).toEqual([]);
});

test("lifecycle reconcile marks missing aborted runs as aborted and wakes queue", async () => {
  const { controller, lifecycle, timers, workspaces } = controllerHarness();
  lifecycle.statusResult = null;

  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-abort",
    reason: "abort-requested",
    abortRequested: true,
  });

  expect(lifecycle.calls).toContain(
    "markAborted:ws_1:run-abort:user abort reconciled after missing lifecycle status",
  );
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([0]);
});

test("lifecycle reconcile marks inactive abort-requested runs as aborted and wakes queue", async () => {
  const { controller, lifecycle, timers, workspaces } = controllerHarness();
  lifecycle.statusResult = { runId: "run-abort", status: "completed", stale: false };

  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-abort",
    reason: "abort-requested",
    abortRequested: true,
  });

  expect(lifecycle.calls).toContain(
    "markAborted:ws_1:run-abort:user abort reconciled after engine became inactive",
  );
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([0]);
});

test("queue drain re-pends items when lifecycle register sees another active run", async () => {
  const { controller, lifecycle, queue, submitCalls, timers } = controllerHarness();
  enqueuePendingRun(queue);
  lifecycle.statusResult = null;
  lifecycle.registerError = new RunAlreadyActiveError("run-active-register");

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(queue.items[0]?.state).toBe("pending");
  expect(queue.items[0]?.activeRunId).toBe("run-active-register");
  expect(submitCalls).toEqual([]);
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([1_500]);
});

test("submitRun rejects a local server-queue-only intent without a lifecycle owner", async () => {
  const input = submitInput({ submitQueuePolicy: "server-queue-only" });
  const { controller, queue, submitCalls } = controllerHarness({ withLifecycle: false });

  await expect(controller.submitRun(input)).rejects.toMatchObject({
    status: 503,
    code: "lifecycle_unavailable",
  } satisfies Partial<ApiError>);

  expect(queue.items).toEqual([]);
  expect(submitCalls).toEqual([]);
  expect(input.runTrace.entries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:queue-policy-lifecycle-unavailable",
    runId: "run-reserved",
  }));
});

test("queue drain retains an unconfirmed lifecycle registration for exact recovery", async () => {
  const { controller, lifecycle, queue, submitCalls, timers, reconcileCalls } = controllerHarness();
  enqueuePendingRun(queue);
  lifecycle.statusResult = null;
  lifecycle.registerError = new OrchestratorLifecycleRequestError("/lifecycle", 503, { code: "down" });

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(queue.items[0]).toEqual(expect.objectContaining({ state: "starting" }));
  expect(queue.listWorkspaceRunReservations()).toContainEqual(expect.objectContaining({
    runId: "run-queued",
    state: "starting",
  }));
  expect(submitCalls).toEqual([]);
  expect(timers.activeTimers()).toContainEqual(expect.objectContaining({ delayMs: 0 }));
  expect(reconcileCalls).toContainEqual(expect.objectContaining({
    reason: "queue-lifecycle-register-unconfirmed",
    runId: "run-queued",
  }));
});

test("exact missing lifecycle recovery re-pends an unconfirmed queued registration", async () => {
  const { controller, lifecycle, queue } = controllerHarness();
  const item = enqueuePendingRun(queue);
  queue.markStarting(item.queueItemId);
  queue.reserveWorkspaceRun({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-queued",
    state: "starting",
  });
  lifecycle.statusResult = null;

  await controller.reconcileConversationRunLifecycle({
    workspace: submitInput().workspace,
    conversationId: "conv-a",
    runId: "run-queued",
    reason: "queue-lifecycle-register-unconfirmed",
    delayMs: 0,
  });

  expect(queue.items[0]).toEqual(expect.objectContaining({ state: "pending", attempts: 1 }));
  expect(queue.listWorkspaceRunReservations()).toEqual([]);
});

test("queue drain marks pending items failed when accepted submit fails", async () => {
  const { controller, lifecycle, queue, behavior, backgroundTraceEntries } = controllerHarness();
  enqueuePendingRun(queue);
  lifecycle.statusResult = null;
  behavior.submitError = new Error("accepted submit failed");

  await controller.drainConversationQueue("ws_1", "conv-a");

  expect(queue.items[0]?.state).toBe("failed");
  expect(queue.items[0]?.error).toBe("accepted submit failed");
  expect(backgroundTraceEntries.flat()).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:queue-drain-submit-failed",
    queueItemId: queue.items[0]?.queueItemId,
    runId: "run-queued",
    message: "accepted submit failed",
  }));
});

test("queue drain reuses one OpenCode message id when the same queued run is retried", async () => {
  const { controller, lifecycle, queue, behavior, submitCalls } = controllerHarness();
  enqueuePendingRun(queue);
  lifecycle.statusResult = null;
  behavior.submitError = new Error("first queued submit failed");

  await controller.drainConversationQueue("ws_1", "conv-a");

  const firstMessageId = (submitCalls[0] as SubmittedOpenCodeCall).opencodeMessageId;
  expect(firstMessageId).toMatch(/^msg_[0-9a-f]{26}$/);
  expect(queue.items[0]?.state).toBe("failed");

  queue.items[0]!.state = "pending";
  behavior.submitError = null;
  await controller.drainConversationQueue("ws_1", "conv-a");

  const secondMessageId = (submitCalls[1] as SubmittedOpenCodeCall).opencodeMessageId;
  expect(secondMessageId).toBe(firstMessageId);
  expect(lifecycle.registerInputs.map((input) => input.opencodeMessageId)).toEqual([
    firstMessageId,
    secondMessageId,
  ]);
});

test("stop clears queued drain and lifecycle reconcile timers", () => {
  const { controller, timers, workspaces } = controllerHarness();

  controller.scheduleQueueDrain("ws_1", "conv-a", 500);
  controller.scheduleLifecycleReconcile({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-a",
    reason: "accepted",
    delayMs: 750,
  });

  expect(controller.snapshotForTests().activeTimerCount).toBe(2);

  controller.stop();

  expect(controller.snapshotForTests().activeTimerCount).toBe(0);
  expect(timers.activeTimers()).toEqual([]);
});

test("snapshot exposes pending lifecycle timer diagnostics", () => {
  const { controller, workspaces } = controllerHarness();

  controller.scheduleQueueDrain("ws_1", "conv-a", 500);
  controller.scheduleLifecycleReconcile({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-a",
    reason: "accepted",
    delayMs: 750,
  });

  expect(controller.snapshotForTests().lifecycle).toEqual({
    pendingQueueDrains: [{ workspaceId: "ws_1", conversationId: "conv-a" }],
    pendingLifecycleReconciles: [{ workspaceId: "ws_1", conversationId: "conv-a", runId: "run-a" }],
    inFlightQueueDrains: [],
    inFlightLifecycleReconciles: [],
  });
});

test("startup schedules queue drains for pending conversation keys", () => {
  const { controller, queue, timers } = controllerHarness();
  enqueuePendingRun(queue, { conversationId: "conv-a", reservedRunId: "run-a" });
  enqueuePendingRun(queue, { conversationId: "conv-b", reservedRunId: "run-b", clientMessageId: "msg-b" });

  controller.start();

  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([1_500, 1_500]);
});

test("startup returns an absent starting queue row to pending before scheduling its drain", async () => {
  const { controller, queue, timers, traceEntries } = controllerHarness();
  const item = enqueuePendingRun(queue, { conversationId: "conv-a", reservedRunId: "run-a" });
  queue.markStarting(item.queueItemId);

  controller.start();
  await Promise.resolve();
  await Promise.resolve();

  expect(queue.items[0]?.state).toBe("pending");
  expect(queue.items[0]?.startedAt).toBeNull();
  expect(timers.activeTimers().map((timer) => timer.delayMs)).toEqual([1_500]);
  expect(traceEntries).toContainEqual({
    event: "server:conversation-run:queue-starting-recovered-absent",
    workspaceId: "ws_1",
    conversationId: "conv-a",
    queueItemId: item.queueItemId,
    runId: "run-a",
  });
});

test("startup retains a durable unresolved terminal handoff without recreating its poll loop", () => {
  const { controller, timers, traceEntries } = controllerHarness({
    startupReservation: {
      conversationId: "conv-a",
      runId: "run-a",
      state: "terminal_handoff_unresolved",
      terminalHandoffReason: "terminal_handoff_recovery_owner_live_or_ambiguous",
      terminalHandoffFingerprint: "run-a\0owner-a\0no_current_engine",
      terminalHandoffAttempts: 1,
      terminalHandoffRequestedAt: 1_000,
      terminalHandoffDecidedAt: 1_100,
    },
  });

  controller.start();

  expect(timers.activeTimers()).toEqual([]);
  expect(traceEntries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:terminal-runtime-handoff-unresolved",
    workspaceId: "ws_1",
    runId: "run-a",
    startup: true,
  }));
});

test("a stale terminal predecessor without a reservation owns a durable handoff barrier", async () => {
  const { controller, lifecycle, queue, workspaces, timers } = controllerHarness();
  const successor = enqueuePendingRun(queue, { reservedRunId: "run-successor" });
  lifecycle.statusResult = {
    runId: "run-predecessor",
    status: "failed",
    stale: true,
    runtimeReadyForSuccessor: false,
    unavailableReason: "no_current_engine",
    engineOwnerId: "owner-before-restart",
    enginePid: 1234,
    engineStartedAt: 5678,
  };

  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-predecessor",
    reason: "queue-drain-terminal-handoff-pending",
    delayMs: 0,
  });

  expect(lifecycle.calls.filter((call) => call === "recoverTerminalRuntimeHandoff:ws_1:run-predecessor")).toHaveLength(1);
  expect(queue.getTerminalHandoffBarrier("ws_1", "conv-a", "run-predecessor")).toEqual(expect.objectContaining({
    state: "evidence_requested",
    attempts: 1,
  }));
  expect(queue.getForReservedRun("ws_1", "conv-a", successor.reservedRunId)?.state).toBe("pending");
  expect(queue.listWorkspaceRunReservations()).toEqual([]);

  lifecycle.statusResult = {
    ...lifecycle.statusResult,
    stale: false,
    runtimeReadyForSuccessor: true,
    engineOwnerState: "lost",
  };
  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-predecessor",
    reason: "terminal-runtime-handoff-recovered",
    delayMs: 0,
  });

  expect(queue.getTerminalHandoffBarrier("ws_1", "conv-a", "run-predecessor")?.state).toBe("resolved");
  expect(timers.activeTimers().some((timer) => timer.delayMs === 0)).toBe(true);
});

test("startup converts an interrupted reservationless handoff into an explicit retry fence", () => {
  const { controller, queue, timers, traceEntries } = controllerHarness();
  queue.observeTerminalHandoffBarrier({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-predecessor",
    fingerprint: "owner-before-restart",
    reason: "no_current_engine",
  });
  queue.requestTerminalHandoffBarrierEvidence({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-predecessor",
    fingerprint: "owner-before-restart",
    reason: "no_current_engine",
  });

  controller.start();

  expect(queue.getTerminalHandoffBarrier("ws_1", "conv-a", "run-predecessor")).toEqual(expect.objectContaining({
    state: "unresolved",
    reason: "recovery_interrupted_by_restart",
  }));
  expect(timers.activeTimers()).toEqual([]);
  expect(traceEntries).toContainEqual(expect.objectContaining({
    event: "server:conversation-run:terminal-runtime-handoff-unresolved",
    reservationPresent: false,
  }));
});

test("a reservationless handoff becomes unresolved when its post-recovery read is still ambiguous", async () => {
  const { controller, lifecycle, queue, workspaces } = controllerHarness();
  lifecycle.statusResult = {
    runId: "run-predecessor",
    status: "failed",
    stale: true,
    runtimeReadyForSuccessor: false,
    unavailableReason: "no_current_engine",
  };

  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-predecessor",
    reason: "queue-drain-terminal-handoff-pending",
    delayMs: 0,
  });
  await controller.reconcileConversationRunLifecycle({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-predecessor",
    reason: "terminal-runtime-handoff-recovered",
    delayMs: 0,
  });

  expect(queue.getTerminalHandoffBarrier("ws_1", "conv-a", "run-predecessor")).toEqual(expect.objectContaining({
    state: "unresolved",
    reason: "recovery_result_not_confirmed",
  }));
  expect(lifecycle.calls.filter((call) => call === "recoverTerminalRuntimeHandoff:ws_1:run-predecessor")).toHaveLength(1);
});

test("explicit retry reopens only the matching reservationless handoff barrier", async () => {
  const { controller, lifecycle, queue, workspaces } = controllerHarness();
  queue.observeTerminalHandoffBarrier({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-predecessor",
    fingerprint: "owner-before-restart",
    reason: "no_current_engine",
  });
  queue.requestTerminalHandoffBarrierEvidence({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-predecessor",
    fingerprint: "owner-before-restart",
    reason: "no_current_engine",
  });
  queue.markTerminalHandoffBarrierUnresolved({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-predecessor",
    reason: "recovery_interrupted_by_restart",
  });
  lifecycle.statusResult = {
    runId: "run-predecessor",
    status: "failed",
    stale: true,
    runtimeReadyForSuccessor: false,
    unavailableReason: "no_current_engine",
  };

  await expect(controller.retryTerminalRuntimeHandoff({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-predecessor",
    directory: "/repo",
    opencodeSessionId: "sess-a",
    reason: "terminal-runtime-handoff-explicit-retry",
    delayMs: 0,
  })).resolves.toBe(true);

  expect(lifecycle.calls.filter((call) => call === "recoverTerminalRuntimeHandoff:ws_1:run-predecessor")).toHaveLength(1);
  expect(queue.getTerminalHandoffBarrier("ws_1", "conv-a", "run-predecessor")?.state).toBe("evidence_requested");
  expect(await controller.retryTerminalRuntimeHandoff({
    workspace: workspaces[0]!,
    conversationId: "conv-a",
    runId: "run-other",
    directory: "/repo",
    opencodeSessionId: "sess-a",
    reason: "terminal-runtime-handoff-explicit-retry",
    delayMs: 0,
  })).toBe(false);
});

test("startup keeps an active starting queue row out of replay and restores its reservation", async () => {
  const { controller, lifecycle, queue, timers, submitCalls } = controllerHarness();
  const item = enqueuePendingRun(queue, { conversationId: "conv-a", reservedRunId: "run-a" });
  queue.markStarting(item.queueItemId);
  lifecycle.statusResult = { runId: "run-a", status: "running", stale: false };

  controller.start();
  await Promise.resolve();
  await Promise.resolve();

  expect(queue.items[0]?.state).toBe("starting");
  expect(queue.reservations.get("ws_1\0run-a")).toEqual(
    expect.objectContaining({ state: "starting", conversationId: "conv-a" }),
  );
  expect(submitCalls).toEqual([]);
  expect(timers.activeTimers().some((timer) => timer.delayMs === 0)).toBe(true);
});

test("abortRun aborts gateway requests, calls OpenCode abort, marks requested, and schedules reconcile", async () => {
  const {
    controller,
    lifecycle,
    workspaces,
    activeProxyAbortCalls,
    abortCalls,
    reconcileCalls,
  } = controllerHarness();

  const result = await controller.abortRun({
    workspace: workspaces[0]!,
    target: {
      directory: "/repo",
      binding: null,
      opencodeSessionId: "sess-a",
      conversationId: "conv-a",
    },
    runId: "run-abort",
  });

  expect(result).toEqual({ upstream: { aborted: true }, abortedGatewayRequestCount: 1 });
  expect(activeProxyAbortCalls).toEqual([{
    workspaceId: "ws_1",
    runId: "run-abort",
    sessionId: "sess-a",
    reason: "conversation-abort",
  }]);
  expect(abortCalls).toHaveLength(1);
  expect(lifecycle.calls).toContain("markAbortRequested:ws_1:run-abort");
  expect(lifecycle.calls).toContain(
    "markAborted:ws_1:run-abort:user abort reconciled after OpenCode abort",
  );
  expect(reconcileCalls).toContainEqual({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-abort",
    reason: "abort-requested",
    delayMs: 0,
  });
});

test("abortRun records lifecycle intent when OpenCode abort fails", async () => {
  const {
    controller,
    lifecycle,
    workspaces,
    behavior,
    activeProxyAbortCalls,
    abortCalls,
    reconcileCalls,
  } = controllerHarness();
  behavior.abortError = new Error("opencode abort failed");

  const result = await controller.abortRun({
    workspace: workspaces[0]!,
    target: {
      directory: "/repo",
      binding: null,
      opencodeSessionId: "sess-a",
      conversationId: "conv-a",
    },
    runId: "run-abort",
  });

  expect(result).toEqual({
    upstream: {
      ok: false,
      error: "opencode_abort_failed",
      message: "opencode abort failed",
    },
    abortedGatewayRequestCount: 1,
  });
  expect(activeProxyAbortCalls).toHaveLength(1);
  expect(abortCalls).toHaveLength(1);
  expect(lifecycle.calls).toContain("markAbortRequested:ws_1:run-abort");
  expect(lifecycle.calls.some((call) => call.startsWith("markAborted:"))).toBe(false);
  expect(reconcileCalls).toContainEqual({
    workspaceId: "ws_1",
    conversationId: "conv-a",
    runId: "run-abort",
    reason: "abort-requested",
    delayMs: 0,
  });
});
