import type { CredentialRepository } from "../credentials/repository.js";
import type { ResolveLeaseInput } from "./repository.js";

export type BindingSelector = {
  selectInitialBinding(input: ResolveLeaseInput): Promise<string>;
  selectReplacementBinding(input: ResolveLeaseInput & { previousBindingId: string }): Promise<string>;
};

export class DefaultBindingSelector implements BindingSelector {
  private readonly nextInitialIndexByPool = new Map<string, number>();

  constructor(private readonly credentials: CredentialRepository) {}

  async selectInitialBinding(input: ResolveLeaseInput): Promise<string> {
    const bindings = await this.listEligibleBindings(input);
    if (bindings.length === 0) {
      return this.throwNoEligibleBindings(input);
    }

    const poolKey = this.poolKey(input);
    const nextIndex = this.nextInitialIndexByPool.get(poolKey) ?? 0;
    this.nextInitialIndexByPool.set(poolKey, (nextIndex + 1) % bindings.length);

    return bindings[nextIndex % bindings.length]!.id;
  }

  async selectReplacementBinding(
    input: ResolveLeaseInput & { previousBindingId: string },
  ): Promise<string> {
    const replacements = await this.listEligibleBindings({
      ownerUserId: input.ownerUserId,
      provider: input.provider,
      excludeBindingId: input.previousBindingId,
    });

    return replacements[0]?.id ?? input.previousBindingId;
  }

  private async listEligibleBindings(input: {
    ownerUserId: string;
    provider: string;
    excludeBindingId?: string;
  }) {
    if (!this.credentials.listEligibleBindings) {
      throw new Error("eligible_binding_lookup_not_supported");
    }

    return this.credentials.listEligibleBindings(input);
  }

  private throwNoEligibleBindings(input: ResolveLeaseInput): never {
    throw new Error(`no_eligible_bindings:${input.ownerUserId}:${input.provider}`);
  }

  private poolKey(input: ResolveLeaseInput): string {
    return `${input.ownerUserId}:${input.provider}`;
  }
}
