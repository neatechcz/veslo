import { classifyUpstreamFailure, type UpstreamFailureInput, type UpstreamFailureKind } from "./error-classifier.js"
import type { BindingSelector } from "./binding-selector.js"
import type { LeaseRepository, ResolveLeaseInput, SessionLease } from "./repository.js"

export type HandleFailureInput = ResolveLeaseInput & {
  currentBindingId: string
  failureKind: UpstreamFailureKind
}

export class LeaseBroker {
  private readonly creationByScope = new Map<string, Promise<SessionLease>>()
  private readonly rebindingByScope = new Map<string, Promise<SessionLease>>()

  constructor(
    private readonly leases: LeaseRepository,
    private readonly selector: BindingSelector,
  ) {}

  async getOrCreateActiveLease(input: ResolveLeaseInput): Promise<SessionLease> {
    const existing = await this.leases.getActiveLease(input)
    if (existing) {
      if (input.requiredBindingId) {
        await this.selector.selectInitialBinding(input)
      }
      if (input.requiredBindingId && existing.activeBindingId !== input.requiredBindingId) {
        return this.rebindLease(input, existing.activeBindingId, input.requiredBindingId)
      }
      return existing
    }

    const key = leaseScopeKey(input)
    const inFlightCreation = this.creationByScope.get(key)
    if (inFlightCreation) {
      return inFlightCreation
    }

    const creation = this.createLeaseIfMissing(input).finally(() => {
      this.creationByScope.delete(key)
    })

    this.creationByScope.set(key, creation)
    return creation
  }

  async handleUpstreamFailure(input: ResolveLeaseInput & {
    currentBindingId: string
    failure: UpstreamFailureInput
  }): Promise<SessionLease> {
    return this.handleFailure({
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      sessionId: input.sessionId,
      currentBindingId: input.currentBindingId,
      failureKind: classifyUpstreamFailure(input.failure),
    })
  }

  async handleFailure(input: HandleFailureInput): Promise<SessionLease> {
    if (input.failureKind === "permanent_credential") {
      return this.rebindSingleFlight(input, input.currentBindingId)
    }

    return this.getOrCreateActiveLease(input)
  }

  private async rebindSingleFlight(input: ResolveLeaseInput, currentBindingId: string): Promise<SessionLease> {
    const key = leaseScopeKey(input)
    const active = this.rebindingByScope.get(key)
    if (active) {
      return active
    }

    const rebinding = this.rebindLease(input, currentBindingId).finally(() => {
      this.rebindingByScope.delete(key)
    })

    this.rebindingByScope.set(key, rebinding)
    return rebinding
  }

  private async rebindLease(
    input: ResolveLeaseInput,
    currentBindingId: string,
    nextBindingId?: string,
  ): Promise<SessionLease> {
    const currentLease = (await this.leases.getActiveLease(input)) ?? (await this.createLeaseIfMissing(input))

    if (currentLease.activeBindingId !== currentBindingId) {
      return currentLease
    }

    const replacementBindingId =
      nextBindingId ??
      (await this.selector.selectReplacementBinding({
        ...input,
        previousBindingId: currentBindingId,
      }))

    if (replacementBindingId === currentBindingId) {
      return currentLease
    }

    const rebound = await this.leases.rebindLease({
      ...input,
      expectedCurrentBindingId: currentBindingId,
      nextBindingId: replacementBindingId,
    })

    if (rebound) {
      return rebound
    }

    const latestLease = await this.leases.getActiveLease(input)
    return latestLease ?? this.getOrCreateActiveLease(input)
  }

  private async createLeaseIfMissing(input: ResolveLeaseInput): Promise<SessionLease> {
    const leaseBeforeCreate = await this.leases.getActiveLease(input)
    if (leaseBeforeCreate) {
      return leaseBeforeCreate
    }

    const activeBindingId = await this.selector.selectInitialBinding(input)
    return this.leases.createLeaseIfMissing({
      ...input,
      activeBindingId,
    })
  }
}

function leaseScopeKey(input: ResolveLeaseInput): string {
  return `${input.ownerUserId}:${input.provider}:${input.sessionId}`
}
