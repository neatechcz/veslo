import assert from "node:assert/strict";
import test from "node:test";

import { getPlatformCredentialOwnerUserId } from "../src/credentials/platform-owner.js";
import {
  AI_GATEWAY_PROVIDERS,
  formatAiGatewayProviderLabel,
  isAiGatewayProvider,
} from "../src/providers/ids.js";

test("openai_compatible is an ai gateway provider with a platform credential owner", () => {
  assert.equal(AI_GATEWAY_PROVIDERS.includes("openai_compatible" as never), true);
  assert.equal(isAiGatewayProvider("openai_compatible"), true);
  assert.equal(formatAiGatewayProviderLabel("openai_compatible"), "OpenAI-compatible");
  assert.equal(getPlatformCredentialOwnerUserId("openai_compatible" as never), "platform:openai_compatible");
});
