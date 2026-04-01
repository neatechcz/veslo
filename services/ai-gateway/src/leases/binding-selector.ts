import type { CredentialRepository } from "../credentials/repository.js";
import type { ResolveLeaseInput } from "./repository.js";

export type BindingSelector = {
  selectInitialBinding(input: ResolveLeaseInput): Promise<string>;
  selectReplacementBinding(input: ResolveLeaseInput & { previousBindingId: string }): Promise<string>;
};

export class DefaultBindingSelector implements BindingSelector {
  constructor(private readonly credentials: CredentialRepository) {}

  async selectInitialBinding(input: ResolveLeaseInput): Promise<string> {
    const bindings = await this.listEligibleBindings(input);
    return bindings[0]?.id ?? this.throwNoEligibleBindings(input);
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
}
