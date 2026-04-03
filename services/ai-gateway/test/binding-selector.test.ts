import assert from "node:assert/strict";
import test from "node:test";

import type { CredentialBinding, CredentialRecord, CredentialRepository, ListEligibleBindingsInput } from "../src/credentials/repository.js";
import { DefaultBindingSelector } from "../src/leases/binding-selector.js";

class TestCredentialRepository implements CredentialRepository {
  public readonly listEligibleBindingsCalls: ListEligibleBindingsInput[] = [];

  constructor(private readonly bindings: CredentialBinding[]) {}

  async getCredentialRecordById(_credentialRecordId: string): Promise<CredentialRecord | null> {
    return null;
  }

  async listHealthyCredentialRecordIds(): Promise<string[]> {
    return [];
  }

  async listEligibleBindings(input: ListEligibleBindingsInput): Promise<CredentialBinding[]> {
    this.listEligibleBindingsCalls.push(input);
    return this.bindings.filter((binding) => {
      return !input.excludeBindingId || binding.id !== input.excludeBindingId;
    });
  }

  async markCredentialState(): Promise<void> {}
}

function binding(id: string): CredentialBinding {
  return {
    id,
    ownerUserId: "user_1",
    provider: "openai",
    credentialRecordId: `cred_${id}`,
    createdAt: new Date("2026-04-01T00:00:00.000Z"),
    updatedAt: new Date("2026-04-01T00:00:00.000Z"),
  };
}

test("rotates initial binding selection across eligible bindings in the same pool", async () => {
  const selector = new DefaultBindingSelector(
    new TestCredentialRepository([
      binding("binding_alpha"),
      binding("binding_beta"),
      binding("binding_gamma"),
    ]),
  );

  const first = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    provider: "openai",
    sessionId: "session_1",
  });
  const second = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    provider: "openai",
    sessionId: "session_2",
  });
  const third = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    provider: "openai",
    sessionId: "session_3",
  });
  const fourth = await selector.selectInitialBinding({
    ownerUserId: "user_1",
    provider: "openai",
    sessionId: "session_4",
  });

  assert.deepEqual([first, second, third, fourth], [
    "binding_alpha",
    "binding_beta",
    "binding_gamma",
    "binding_alpha",
  ]);
});

test("replacement selection excludes the failed binding", async () => {
  const repository = new TestCredentialRepository([
    binding("binding_alpha"),
    binding("binding_beta"),
    binding("binding_gamma"),
  ]);
  const selector = new DefaultBindingSelector(repository);

  const replacement = await selector.selectReplacementBinding({
    ownerUserId: "user_1",
    provider: "openai",
    sessionId: "session_rebind",
    previousBindingId: "binding_alpha",
  });

  assert.equal(replacement, "binding_beta");
  assert.deepEqual(repository.listEligibleBindingsCalls, [
    {
      ownerUserId: "user_1",
      provider: "openai",
      excludeBindingId: "binding_alpha",
    },
  ]);
});
