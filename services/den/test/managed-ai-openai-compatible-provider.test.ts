import assert from "node:assert/strict"
import test from "node:test"

import { getPlatformCredentialOwnerUserId } from "../src/managed-ai/credentials/platform-owner.js"
import {
  MANAGED_AI_PROVIDERS,
  formatManagedAiProviderLabel,
  isManagedAiProvider,
} from "../src/managed-ai/providers/ids.js"

test("openai_compatible is a managed provider with a platform credential owner", () => {
  assert.equal(MANAGED_AI_PROVIDERS.includes("openai_compatible" as never), true)
  assert.equal(isManagedAiProvider("openai_compatible"), true)
  assert.equal(formatManagedAiProviderLabel("openai_compatible"), "OpenAI-compatible")
  assert.equal(getPlatformCredentialOwnerUserId("openai_compatible" as never), "platform:openai_compatible")
})
