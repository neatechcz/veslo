import type { CredentialBinding, CredentialRepository } from "../credentials/repository.js";
import { CODEX_OAUTH_PROVIDER } from "../providers/ids.js";
import { evaluateCodexCredentialEligibility } from "../usage/codex-eligibility.js";
import type { CodexCredentialStatusProvider } from "../usage/codex-status.js";
import type { ResolveLeaseInput } from "./repository.js";

export type BindingSelector = {
  selectInitialBinding(input: ResolveLeaseInput): Promise<string>;
  selectReplacementBinding(input: ResolveLeaseInput & { previousBindingId: string }): Promise<string>;
};

export type DefaultBindingSelectorDeps = {
  credentials: CredentialRepository;
  codexStatusProvider?: CodexCredentialStatusProvider;
  now?: () => Date;
};

const CODEX_STATUS_PROBE_CONCURRENCY = 4;

export class DefaultBindingSelector implements BindingSelector {
  private readonly nextInitialIndexByPool = new Map<string, number>();
  private readonly credentials: CredentialRepository;
  private readonly codexStatusProvider?: CodexCredentialStatusProvider;
  private readonly now: () => Date;

  constructor(deps: CredentialRepository | DefaultBindingSelectorDeps) {
    const normalized = isDefaultBindingSelectorDeps(deps)
      ? deps
      : { credentials: deps };

    this.credentials = normalized.credentials;
    this.codexStatusProvider = normalized.codexStatusProvider;
    this.now = normalized.now ?? (() => new Date());
  }

  async selectInitialBinding(input: ResolveLeaseInput): Promise<string> {
    if (input.provider === CODEX_OAUTH_PROVIDER && input.requiredBindingId) {
      return this.selectRequiredCodexBinding(input.requiredBindingId);
    }

    if (input.requiredBindingId) {
      return input.requiredBindingId;
    }

    if (input.provider === CODEX_OAUTH_PROVIDER) {
      return this.selectCodexBinding(input);
    }

    const bindings = await this.listEligibleBindings({
      ownerUserId: this.resolveBindingOwnerUserId(input),
      provider: input.provider,
    });
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
    if (input.provider === CODEX_OAUTH_PROVIDER && input.requiredBindingId) {
      return this.selectRequiredCodexBinding(input.requiredBindingId);
    }

    if (input.requiredBindingId) {
      return input.requiredBindingId;
    }

    if (input.provider === CODEX_OAUTH_PROVIDER) {
      return this.selectCodexBinding({
        ...input,
        excludeBindingId: input.previousBindingId,
      });
    }

    const replacements = await this.listEligibleBindings({
      ownerUserId: this.resolveBindingOwnerUserId(input),
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

  private async selectCodexBinding(input: ResolveLeaseInput & { excludeBindingId?: string }): Promise<string> {
    const bindings = await this.listEligibleBindings({
      ownerUserId: this.resolveBindingOwnerUserId(input),
      provider: input.provider,
      excludeBindingId: input.excludeBindingId,
    });
    const candidates = await this.filterEligibleCodexCandidates(bindings);

    if (candidates.length === 0) {
      throw new Error("no_eligible_codex_credentials:all_codex_credentials_exhausted");
    }

    return candidates[0]!.binding.id;
  }

  private async selectRequiredCodexBinding(requiredBindingId: string): Promise<string> {
    if (!this.codexStatusProvider || !this.credentials.getCredentialRecordByBindingId) {
      return requiredBindingId;
    }

    const credential = await this.credentials.getCredentialRecordByBindingId(requiredBindingId);
    if (!credential) {
      return requiredBindingId;
    }

    const eligible = await this.isCodexCredentialEligible({
      credentialId: credential.id,
      credentialName: credential.name?.trim() || credential.id,
    });
    if (!eligible) {
      throw new Error("no_eligible_codex_credentials:assigned_credential_exhausted");
    }

    return requiredBindingId;
  }

  private async filterEligibleCodexCandidates(bindings: CredentialBinding[]): Promise<CodexCandidate[]> {
    const credentialIds = bindings.map((binding) => binding.credentialRecordId);
    const [activeLeasesByCredentialId, recentTokensByCredentialId] = await Promise.all([
      this.listActiveLeasesByCredentialId(credentialIds),
      this.listRecentTokensByCredentialId(credentialIds),
    ]);
    const candidates = await mapWithConcurrency(
      bindings,
      CODEX_STATUS_PROBE_CONCURRENCY,
      async (binding): Promise<CodexCandidate | null> => {
        const credential = this.credentials.getCredentialRecordById
          ? await this.credentials.getCredentialRecordById(binding.credentialRecordId)
          : null;
        const credentialName = credential?.name?.trim() || binding.credentialRecordId;

        const eligible = await this.isCodexCredentialEligible({
          credentialId: binding.credentialRecordId,
          credentialName,
        });
        if (!eligible) {
          return null;
        }

        return {
          binding,
          activeLeases: activeLeasesByCredentialId.get(binding.credentialRecordId) ?? 0,
          recentTotalTokens: recentTokensByCredentialId.get(binding.credentialRecordId) ?? 0,
        };
      },
    );

    return candidates
      .filter((candidate): candidate is CodexCandidate => candidate !== null)
      .sort(compareCodexCandidates);
  }

  private async isCodexCredentialEligible(input: {
    credentialId: string;
    credentialName: string;
  }): Promise<boolean> {
    if (!this.codexStatusProvider) {
      return true;
    }

    try {
      const status = await this.codexStatusProvider.getStatus(input);
      return evaluateCodexCredentialEligibility(status, this.now()).eligible;
    } catch {
      // Probe execution failures are treated like unknown limits so a
      // transient status check issue does not exhaust the credential.
      return true;
    }
  }

  private async listActiveLeasesByCredentialId(credentialIds: string[]): Promise<Map<string, number>> {
    if (!this.credentials.listActiveLeasesByCredential || credentialIds.length === 0) {
      return new Map();
    }

    const activeLeases = await this.credentials.listActiveLeasesByCredential(credentialIds);
    return new Map(activeLeases.map((entry) => [entry.credentialId, entry.activeLeases]));
  }

  private async listRecentTokensByCredentialId(credentialIds: string[]): Promise<Map<string, number>> {
    if (!this.credentials.listRecentCredentialUsage || credentialIds.length === 0) {
      return new Map();
    }

    const usage = await this.credentials.listRecentCredentialUsage({
      credentialIds,
      since: new Date(this.now().getTime() - 24 * 60 * 60 * 1000),
    });
    return new Map(usage.map((entry) => [entry.credentialId, entry.totalTokens]));
  }

  private throwNoEligibleBindings(input: ResolveLeaseInput): never {
    throw new Error(`no_eligible_bindings:${this.resolveBindingOwnerUserId(input)}:${input.provider}`);
  }

  private poolKey(input: ResolveLeaseInput): string {
    return `${this.resolveBindingOwnerUserId(input)}:${input.provider}`;
  }

  private resolveBindingOwnerUserId(input: ResolveLeaseInput): string {
    return input.bindingOwnerUserId ?? input.ownerUserId;
  }
}

type CodexCandidate = {
  binding: CredentialBinding;
  activeLeases: number;
  recentTotalTokens: number;
};

function compareCodexCandidates(left: CodexCandidate, right: CodexCandidate): number {
  const leaseDelta = left.activeLeases - right.activeLeases;
  if (leaseDelta !== 0) {
    return leaseDelta;
  }

  const tokenDelta = left.recentTotalTokens - right.recentTotalTokens;
  if (tokenDelta !== 0) {
    return tokenDelta;
  }

  const createdAtDelta = left.binding.createdAt.getTime() - right.binding.createdAt.getTime();
  if (createdAtDelta !== 0) {
    return createdAtDelta;
  }

  return left.binding.id.localeCompare(right.binding.id);
}

function isDefaultBindingSelectorDeps(
  deps: CredentialRepository | DefaultBindingSelectorDeps,
): deps is DefaultBindingSelectorDeps {
  return "credentials" in deps;
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]!);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, () => worker()),
  );
  return results;
}
