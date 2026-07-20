import assert from "node:assert/strict";
import test from "node:test";

import { resolveAuthorizedModelRoster } from "../src/access/authorized-model-roster.js";
import { resolveGatewayModelCapabilityDescriptor } from "../src/providers/model-capability-registry.js";

const codexAccess = {
  provider: "codex_oauth" as const,
  defaultModel: "gpt-5.6-sol",
  allowedModels: ["gpt-5.6-sol", "gpt-5.4", "gpt-5.4"],
};

test("authorized roster intersects a user's models with current platform enablement", () => {
  const roster = resolveAuthorizedModelRoster({
    aiAccess: codexAccess,
    platformPolicy: {
      enabledModels: [{ provider: "codex_oauth", model: "gpt-5.4" }],
      activeModel: { provider: "codex_oauth", model: "gpt-5.4" },
    } as never,
  });

  assert.deepEqual(roster, ["gpt-5.4"]);
});

test("authorized roster is empty when the requested model is no longer enabled", () => {
  const roster = resolveAuthorizedModelRoster({
    aiAccess: codexAccess,
    platformPolicy: {
      enabledModels: [{ provider: "codex_oauth", model: "gpt-5.5" }],
      activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
    } as never,
  });

  assert.deepEqual(roster, []);
});

test("reviewed GPT-5.6 Sol descriptor supports image attachments", () => {
  const descriptor = resolveGatewayModelCapabilityDescriptor({
    provider: "codex_oauth",
    model: "gpt-5.6-sol",
  });

  assert.equal(descriptor.capabilityStatus, "known");
  assert.equal(descriptor.attachment, true);
  assert.deepEqual(descriptor.modalities, { input: ["text", "image"] });
});

test("unreviewed Codex descriptors remain fail-closed for attachments", () => {
  const descriptor = resolveGatewayModelCapabilityDescriptor({
    provider: "codex_oauth",
    model: "gpt-5.4",
  });

  assert.equal(descriptor.capabilityStatus, "unknown");
  assert.equal(descriptor.attachment, undefined);
  assert.equal(descriptor.modalities, undefined);
});

test("missing platform policy publishes no authorized models", () => {
  assert.deepEqual(resolveAuthorizedModelRoster({ aiAccess: codexAccess }), []);
});
