import { classifyUpstreamFailure, type UpstreamFailureInput, type UpstreamFailureKind } from "./error-classifier.js";
import type { LeaseRepository, SessionLease } from "./repository.js";

export type BindingSelector = {
  selectInitialBinding(input: { sessionId: string }): Promise<string>;
  selectReplacementBinding(input: { sessionId: string; previousBindingId: string }): Promise<string>;
};

export type HandleFailureInput = {
  sessionId: string;
  currentBindingId: string;
  failureKind: UpstreamFailureKind;
};

export class LeaseBroker {
  private readonly rebindingBySession = new Map<string, Promise<SessionLease>>();

  constructor(
    private readonly leases: LeaseRepository,
    private readonly selector: BindingSelector,
  ) {}

  async getOrCreateActiveLease(sessionId: string): Promise<SessionLease> {
    const existing = await this.leases.getActiveLeaseBySessionId(sessionId);
    if (existing) {
      return existing;
    }

    const activeBindingId = await this.selector.selectInitialBinding({ sessionId });
    return this.leases.createSessionLease({
      sessionId,
      activeBindingId,
    });
  }

  async handleUpstreamFailure(input: {
    sessionId: string;
    currentBindingId: string;
    failure: UpstreamFailureInput;
  }): Promise<SessionLease> {
    return this.handleFailure({
      sessionId: input.sessionId,
      currentBindingId: input.currentBindingId,
      failureKind: classifyUpstreamFailure(input.failure),
    });
  }

  async handleFailure(input: HandleFailureInput): Promise<SessionLease> {
    if (input.failureKind === "permanent_credential") {
      return this.rebindSingleFlight(input.sessionId, input.currentBindingId);
    }

    // Refreshable auth and transient upstream issues keep the current sticky binding.
    return this.getOrCreateActiveLease(input.sessionId);
  }

  private async rebindSingleFlight(sessionId: string, currentBindingId: string): Promise<SessionLease> {
    const active = this.rebindingBySession.get(sessionId);
    if (active) {
      return active;
    }

    const rebinding = this.rebindLease(sessionId, currentBindingId).finally(() => {
      this.rebindingBySession.delete(sessionId);
    });

    this.rebindingBySession.set(sessionId, rebinding);
    return rebinding;
  }

  private async rebindLease(sessionId: string, currentBindingId: string): Promise<SessionLease> {
    const currentLease = await this.leases.getActiveLeaseBySessionId(sessionId);
    if (!currentLease) {
      return this.getOrCreateActiveLease(sessionId);
    }

    if (currentLease.activeBindingId !== currentBindingId) {
      return currentLease;
    }

    const replacementBindingId = await this.selector.selectReplacementBinding({
      sessionId,
      previousBindingId: currentBindingId,
    });

    if (replacementBindingId === currentBindingId) {
      return currentLease;
    }

    return this.leases.rebindSessionLease({
      sessionId,
      activeBindingId: replacementBindingId,
    });
  }
}
