import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";

import { AssignedCredentialModelIncompatibleError } from "../src/access/auto-assignment-rotation.js";
import { createCodexOAuthProxyRouter } from "../src/http/providers/codex-oauth.js";

test("codex proxy rejects an assigned credential that cannot serve the request model snapshot", async () => {
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.gatewaySession = {
      token: "gateway-token",
      user: { id: "user_1", email: "user@example.test" },
    };
    res.locals.gatewayAiAccess = {
      id: "access_1",
      userId: "user_1",
      enabled: true,
      provider: "codex_oauth",
      credentialId: "cred_1",
      defaultModel: "legacy-model",
      allowedModels: ["legacy-model"],
      assignmentOrigin: "admin_assigned",
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    res.locals.gatewayActiveModel = { provider: "codex_oauth", model: "gpt-5.5" };
    next();
  });
  app.use(createCodexOAuthProxyRouter({
    autoAssignedCodexCredentialRotation: {
      async repairCodexAccess(input) {
        assert.deepEqual(input.activeModel, { provider: "codex_oauth", model: "gpt-5.5" });
        throw new AssignedCredentialModelIncompatibleError();
      },
    },
    credentials: {},
    secrets: {},
    usageRepository: {},
    leaseBroker: {
      async getOrCreateActiveLease() {
        assert.fail("lease broker must not run");
      },
    },
    codexOAuthTransport: {
      async chatCompletions() {
        assert.fail("transport must not run");
      },
    },
  } as never));

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-veslo-session-id": "session_1",
      },
      body: JSON.stringify({ messages: [] }),
    });
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "assigned_credential_model_incompatible" });
  } finally {
    server.close();
    await once(server, "close");
  }
});
