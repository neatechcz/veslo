import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express from "express";

import {
  AssignedCredentialModelIncompatibleError,
  AssignedCredentialUnavailableError,
} from "../src/access/auto-assignment-rotation.js";
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

test("codex proxy rejects a client model override before credential repair", async () => {
  let repairCalls = 0;
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.gatewaySession = { token: "gateway-token", user: { id: "user_1", email: "user@example.test" } };
    res.locals.gatewayAiAccess = {
      id: "access_1", userId: "user_1", enabled: true, provider: "codex_oauth",
      credentialId: "cred_1", defaultModel: "legacy", allowedModels: ["legacy"],
      assignmentOrigin: "admin_assigned", createdAt: new Date(), updatedAt: new Date(),
    };
    res.locals.gatewayActiveModel = { provider: "codex_oauth", model: "gpt-5.5" };
    next();
  });
  app.use(createCodexOAuthProxyRouter({
    autoAssignedCodexCredentialRotation: {
      async repairCodexAccess(input) {
        repairCalls += 1;
        return input.aiAccess;
      },
    },
    credentials: {
      async getBindingByCredentialId() { assert.fail("credential lookup must not run"); },
    },
    secrets: {},
    usageRepository: {},
    leaseBroker: { async getOrCreateActiveLease() { assert.fail("lease must not run"); } },
    codexOAuthTransport: { async chatCompletions() { assert.fail("transport must not run"); } },
  } as never));

  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-veslo-session-id": "session_override" },
      body: JSON.stringify({ model: "gpt-5.4", messages: [] }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(await response.json(), { error: "model_override_not_allowed" });
    assert.equal(repairCalls, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});

async function requestWithRepairFailure(error: Error) {
  let credentialLookups = 0;
  const app = express();
  app.use(express.json());
  app.use((_req, res, next) => {
    res.locals.gatewaySession = { token: "gateway-token", user: { id: "user_1", email: "user@example.test" } };
    res.locals.gatewayAiAccess = {
      id: "access_1", userId: "user_1", enabled: true, provider: "codex_oauth",
      credentialId: "cred_1", defaultModel: "legacy", allowedModels: ["legacy"],
      assignmentOrigin: "admin_assigned", createdAt: new Date(), updatedAt: new Date(),
    };
    res.locals.gatewayActiveModel = { provider: "codex_oauth", model: "gpt-5.5" };
    next();
  });
  app.use(createCodexOAuthProxyRouter({
    autoAssignedCodexCredentialRotation: { async repairCodexAccess() { throw error; } },
    credentials: { async getBindingByCredentialId() { credentialLookups += 1; return null; } },
    secrets: {}, usageRepository: {}, leaseBroker: {}, codexOAuthTransport: {},
  } as never));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-veslo-session-id": "session_failure" },
      body: JSON.stringify({ messages: [] }),
    });
    return { status: response.status, body: await response.json(), credentialLookups };
  } finally {
    server.close();
    await once(server, "close");
  }
}

test("codex proxy preserves compatible credential exhaustion from repair", async () => {
  const response = await requestWithRepairFailure(
    new Error("no_eligible_codex_credentials:all_codex_credentials_exhausted"),
  );
  assert.deepEqual(response, {
    status: 503,
    body: {
      error: "no_eligible_codex_credentials",
      reason: "all_codex_credentials_exhausted",
      provider: "codex_oauth",
    },
    credentialLookups: 0,
  });
});

test("codex proxy preserves unavailable compatibility evidence from repair", async () => {
  const response = await requestWithRepairFailure(new AssignedCredentialUnavailableError());
  assert.deepEqual(response, {
    status: 503,
    body: { error: "assigned_credential_unavailable" },
    credentialLookups: 0,
  });
});
