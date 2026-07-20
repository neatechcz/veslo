import assert from "node:assert/strict";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";

import type { AlertRecord } from "../src/alerts/repository.js";
import type {
  AdminService,
  AdminSessionSnapshot,
  AdminUserRecord,
  AuditRecord,
  BrowserAuthExchangeInput,
  BrowserAuthStartInput,
  BrowserAuthStartPayload,
  CredentialRecord,
  SessionRecord,
  UsageResponse,
} from "../src/http/admin.js";
import { createDefaultAdminService, MySqlAdminCredentialActionRepository } from "../src/http/admin.js";
import { createApp } from "../src/index.js";

const AUTHORIZATION = { authorization: "Bearer admin-token" };

function createSession(): AdminSessionSnapshot {
  return {
    user: {
      id: "user_admin",
      email: "admin@example.test",
      emailVerified: true,
      name: "Admin",
    },
    platformAdmin: true,
    activeOrgId: null,
    organizations: [],
  };
}

function createCredential(
  id: string,
  state: CredentialRecord["state"],
  overrides: Partial<Pick<CredentialRecord, "provider" | "activeLeases">> = {},
): CredentialRecord {
  return {
    id,
    name: `Credential ${id}`,
    provider: overrides.provider ?? "openai",
    type: "oauth",
    state,
    scope: "user_admin",
    activeLeases: overrides.activeLeases ?? 2,
    alertCount: 1,
    lastRefreshAt: "2026-04-03T10:00:00.000Z",
    lastFailureAt: null,
    totalTokens: 321,
    nextRotationAt: null,
    linkedAlertIds: ["alert_health_1"],
  };
}

function createCodexAuthJson(refreshToken = "codex-refresh-token") {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: "codex-id-token",
      access_token: "codex-access-token",
      refresh_token: refreshToken,
      account_id: "acct_codex_runtime",
    },
  });
}

function createCodexAuthJsonWithEmail(email: string, refreshToken = "codex-refresh-token") {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  const idToken = [
    encode({ alg: "none", typ: "JWT" }),
    encode({ email }),
    "signature",
  ].join(".");

  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      id_token: idToken,
      access_token: "codex-access-token",
      refresh_token: refreshToken,
      account_id: "acct_codex_runtime",
    },
  });
}

function createUnusedDenClient() {
  return {
    async startBrowserAuth() {
      throw new Error("unused");
    },
    async exchangeBrowserAuth() {
      throw new Error("unused");
    },
    async getSession() {
      return createSession();
    },
    async listUsers() {
      return [];
    },
    async createUser() {
      throw new Error("unused");
    },
    async getEligibleCodexCredentialForAutoAssign() {
      return null;
    },
    async updateUser() {
      throw new Error("unused");
    },
    async listOrganizations() {
      return { organizations: [] };
    },
    async getOrganization() {
      throw new Error("unused");
    },
    async updateOrganization() {
      throw new Error("unused");
    },
    async listOrganizationMembers() {
      return { members: [] };
    },
    async createOrganizationMember() {
      throw new Error("unused");
    },
    async updateOrganizationMember() {
      throw new Error("unused");
    },
    async deleteOrganizationMember() {
      return;
    },
    async listOrganizationDomains() {
      return { domains: [] };
    },
    async createOrganizationDomain() {
      throw new Error("unused");
    },
    async updateOrganizationDomain() {
      throw new Error("unused");
    },
    async deleteOrganizationDomain() {
      return;
    },
    async listOrganizationInvites() {
      return { invites: [] };
    },
    async createOrganizationInvite() {
      throw new Error("unused");
    },
    async resendOrganizationInvite() {
      throw new Error("unused");
    },
    async revokeOrganizationInvite() {
      throw new Error("unused");
    },
    async disableUser() {
      throw new Error("unused");
    },
    async enableUser() {
      throw new Error("unused");
    },
    async deleteUser() {
      return;
    },
  };
}

function createAlert(id: string, status: AlertRecord["status"]): AlertRecord {
  return {
    id,
    title: "Provider rate limits increasing",
    severity: "high",
    source: "provider-rate-limit",
    reason: "rate_limit_exceeded",
    status,
    credentialId: "cred_openai_1",
    affectedSessions: 3,
    firstSeenAt: "2026-04-03T10:00:00.000Z",
    lastSeenAt: "2026-04-03T10:05:00.000Z",
    owner: status === "active" ? null : "admin@example.test",
    runbook: "Inspect quota pressure and rebalance routing across healthy credentials.",
  };
}

function createUsageResponse(): UsageResponse {
  return {
    summary: {
      totalTokens: 0,
      totalRequests: 0,
    },
    groupBy: "total",
    filters: {
      credentials: [],
      users: [],
      orgs: [],
    },
    series: [],
    topCredentials: [],
    topUsers: [],
    topOrgs: [],
  };
}

function createAdminServiceSpy() {
  const calls = {
    credential: [] as Array<Record<string, unknown>>,
    alert: [] as Array<{ action: string; alertId: string; token: string; actorUserId: string | null }>,
  };
  const session = createSession();

  const service: AdminService = {
    async startBrowserAuth(_input: BrowserAuthStartInput): Promise<BrowserAuthStartPayload> {
      throw new Error("unused");
    },
    async exchangeBrowserAuth(_input: BrowserAuthExchangeInput) {
      throw new Error("unused");
    },
    async getSession() {
      return session;
    },
    async listUsers(): Promise<AdminUserRecord[]> {
      return [];
    },
    async createUser() {
      throw new Error("unused");
    },
    async updateUser() {
      throw new Error("unused");
    },
    async disableUser() {
      throw new Error("unused");
    },
    async enableUser() {
      throw new Error("unused");
    },
    async deleteUser() {
      return;
    },
    async listCredentials() {
      return { credentials: [] };
    },
    async revokeCredential(token, credentialId, actorUserId) {
      calls.credential.push({ action: "revoke", credentialId, token, actorUserId });
      return { credential: createCredential(credentialId, "revoked") };
    },
    async drainCredential(token, credentialId, actorUserId) {
      calls.credential.push({ action: "drain", credentialId, token, actorUserId });
      return { credential: createCredential(credentialId, "draining") };
    },
    async rotateCredential(token, credentialId, actorUserId) {
      calls.credential.push({ action: "rotate", credentialId, token, actorUserId });
      return { credential: createCredential(credentialId, "draining") };
    },
    async deleteCredential(token, credentialId, actorUserId) {
      calls.credential.push({ action: "delete", credentialId, token, actorUserId });
      return {
        credential: {
          ...createCredential(credentialId, "revoked", { activeLeases: 0 }),
          deletedAt: "2026-04-03T11:00:00.000Z",
        },
      };
    },
    async renameCredential(token, credentialId, input, actorUserId) {
      calls.credential.push({ action: "rename", credentialId, token, actorUserId, name: input.name });
      return {
        credential: {
          ...createCredential(credentialId, "healthy", { provider: "codex_oauth", activeLeases: 0 }),
          name: input.name,
        },
      };
    },
    async createCodexAuthUploadSession(token, credentialId, input, actorUserId) {
      calls.credential.push({ action: "codex-auth-upload-session", credentialId, token, actorUserId, origin: input.origin });
      return {
        upload: {
          token: "upload-token",
          credentialId,
          credentialName: "Václav Codex",
          uploadUrl: `${input.origin}/admin/api/credentials/codex-auth-upload/upload-token`,
          expiresAt: "2026-06-17T08:10:00.000Z",
        },
        command: `node scripts/admin/codex-auth-upload.mjs --upload-url '${input.origin}/admin/api/credentials/codex-auth-upload/upload-token' --credential-id '${credentialId}' --credential-name 'Václav Codex'`,
      };
    },
    async createCodexAuthCredentialUploadSession(token, input, actorUserId) {
      calls.credential.push({ action: "codex-auth-credential-upload-session", token, actorUserId, origin: input.origin });
      return {
        upload: {
          token: "upload-token",
          credentialId: null,
          credentialName: "New Codex account",
          uploadUrl: `${input.origin}/admin/api/credentials/codex-auth-upload/upload-token`,
          expiresAt: "2026-06-17T08:10:00.000Z",
        },
        command: `node scripts/admin/codex-auth-upload.mjs --upload-url '${input.origin}/admin/api/credentials/codex-auth-upload/upload-token' --credential-name 'New Codex account'`,
      };
    },
    async uploadCodexAuth(token, input) {
      calls.credential.push({ action: "codex-auth-upload", token, authJson: input.authJson });
      return {
        ok: true,
        credentialId: "cred_codex_1",
        credentialName: "Václav Codex",
        accountId: "acct_codex_runtime",
      };
    },
    async reconnectCredential(token, credentialId, input, actorUserId) {
      calls.credential.push({ action: "reconnect", credentialId, token, actorUserId });
      return {
        credential: {
          ...createCredential(credentialId, "healthy", { provider: "codex_oauth", activeLeases: 0 }),
          lastRefreshAt: "2026-04-03T11:30:00.000Z",
        },
      };
    },
    async listSessions(): Promise<{ sessions: SessionRecord[] }> {
      return { sessions: [] };
    },
    async getUsage() {
      return createUsageResponse();
    },
    async listAlerts() {
      return { alerts: [] };
    },
    async acknowledgeAlert(token, alertId, actorUserId) {
      calls.alert.push({ action: "acknowledge", alertId, token, actorUserId });
      return { alert: createAlert(alertId, "acknowledged") };
    },
    async resolveAlert(token, alertId, actorUserId) {
      calls.alert.push({ action: "resolve", alertId, token, actorUserId });
      return { alert: createAlert(alertId, "resolved") };
    },
    async listAudit(): Promise<{ events: AuditRecord[] }> {
      return { events: [] };
    },
  };

  return { service, calls, session };
}

test("POST /admin/api/credentials actions forward admin actor identity and return credential payloads", async () => {
  const { service, calls, session } = createAdminServiceSpy();
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/admin/api/credentials/cred_openai_1`;
    const cases = [
      {
        action: "revoke",
        expected: { credential: createCredential("cred_openai_1", "revoked") },
      },
      {
        action: "drain",
        expected: { credential: createCredential("cred_openai_1", "draining") },
      },
      {
        action: "rotate",
        expected: { credential: createCredential("cred_openai_1", "draining") },
      },
    ];

    for (const entry of cases) {
      const response = await fetch(`${baseUrl}/${entry.action}`, {
        method: "POST",
        headers: AUTHORIZATION,
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), entry.expected);
    }

    assert.deepEqual(calls.credential, [
      { action: "revoke", credentialId: "cred_openai_1", token: "admin-token", actorUserId: session.user.email },
      { action: "drain", credentialId: "cred_openai_1", token: "admin-token", actorUserId: session.user.email },
      { action: "rotate", credentialId: "cred_openai_1", token: "admin-token", actorUserId: session.user.email },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("DELETE /admin/api/credentials/:credentialId forwards admin actor identity", async () => {
  const { service, calls, session } = createAdminServiceSpy();
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials/cred_revoked_1`, {
      method: "DELETE",
      headers: AUTHORIZATION,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      credential: {
        ...createCredential("cred_revoked_1", "revoked", { activeLeases: 0 }),
        deletedAt: "2026-04-03T11:00:00.000Z",
      },
    });
    assert.deepEqual(calls.credential, [
      { action: "delete", credentialId: "cred_revoked_1", token: "admin-token", actorUserId: session.user.email },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("PATCH /admin/api/credentials/:credentialId forwards credential rename", async () => {
  const { service, calls, session } = createAdminServiceSpy();
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials/cred_codex_1`, {
      method: "PATCH",
      headers: {
        ...AUTHORIZATION,
        "content-type": "application/json",
      },
      body: JSON.stringify({ name: "Václav Codex" }),
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).credential.name, "Václav Codex");
    assert.deepEqual(calls.credential.at(-1), {
      action: "rename",
      credentialId: "cred_codex_1",
      token: "admin-token",
      actorUserId: session.user.email,
      name: "Václav Codex",
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("POST /admin/api/credentials/:credentialId/codex-auth-upload-session forwards origin and actor", async () => {
  const { service, calls, session } = createAdminServiceSpy();
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials/cred_codex_1/codex-auth-upload-session`, {
      method: "POST",
      headers: AUTHORIZATION,
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.upload.credentialId, "cred_codex_1");
    assert.match(payload.command, /node scripts\/admin\/codex-auth-upload\.mjs/);
    assert.deepEqual(calls.credential.at(-1), {
      action: "codex-auth-upload-session",
      credentialId: "cred_codex_1",
      token: "admin-token",
      actorUserId: session.user.email,
      origin: `http://127.0.0.1:${port}`,
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("POST /admin/api/credentials/codex-auth-upload-session prepares a new Codex credential upload", async () => {
  const { service, calls, session } = createAdminServiceSpy();
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials/codex-auth-upload-session`, {
      method: "POST",
      headers: AUTHORIZATION,
    });

    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.upload.credentialId, null);
    assert.equal(payload.upload.credentialName, "New Codex account");
    assert.doesNotMatch(payload.command, /--credential-id/);
    assert.deepEqual(calls.credential.at(-1), {
      action: "codex-auth-credential-upload-session",
      token: "admin-token",
      actorUserId: session.user.email,
      origin: `http://127.0.0.1:${port}`,
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("POST /admin/api/credentials/codex-auth-upload/:token accepts one-time upload without admin bearer token", async () => {
  const { service, calls } = createAdminServiceSpy();
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials/codex-auth-upload/upload-token`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({ authJson: createCodexAuthJson("fresh-refresh-token") }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      ok: true,
      credentialId: "cred_codex_1",
      credentialName: "Václav Codex",
      accountId: "acct_codex_runtime",
    });
    assert.deepEqual(calls.credential.at(-1), {
      action: "codex-auth-upload",
      token: "upload-token",
      authJson: createCodexAuthJson("fresh-refresh-token"),
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("POST /admin/api/credentials/:credentialId/reconnect forwards new Codex auth JSON", async () => {
  const { service, calls, session } = createAdminServiceSpy();
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/credentials/cred_codex_1/reconnect`, {
      method: "POST",
      headers: {
        ...AUTHORIZATION,
        "content-type": "application/json",
      },
      body: JSON.stringify({ secret: createCodexAuthJson("fresh-refresh-token") }),
    });

    assert.equal(response.status, 200);
    assert.equal((await response.json()).credential.state, "healthy");
    assert.deepEqual(calls.credential.at(-1), {
      action: "reconnect",
      credentialId: "cred_codex_1",
      token: "admin-token",
      actorUserId: session.user.email,
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("createDefaultAdminService soft-deletes an unusable credential and tombstones its secret", async () => {
  const deletedCredential = {
    ...createCredential("cred_revoked_1", "revoked", { activeLeases: 0 }),
    alertCount: 0,
    linkedAlertIds: [],
    deletedAt: "2026-04-03T11:00:00.000Z",
  };
  const tombstones: unknown[] = [];
  const auditCalls: Array<{
    actorUserId?: string | null;
    entityType: string;
    entityId: string;
    action: string;
    result: "ok" | "warning" | "error";
    summary?: string | null;
  }> = [];
  const deleteCalls: Array<{ credentialId: string; allowHealthyUnavailable: boolean }> = [];
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: createUnusedDenClient(),
    credentialReadRepository: {
      async listAdminCredentials(input?: { includeDeleted?: boolean }) {
        assert.equal(input?.includeDeleted, true);
        return [deletedCredential];
      },
    },
    credentialActionRepository: {
      async revokeCredential() {
        throw new Error("unused");
      },
      async drainCredential() {
        throw new Error("unused");
      },
      async rotateCredential() {
        throw new Error("unused");
      },
      async deleteCredential(input: { credentialId: string; allowHealthyUnavailable?: boolean }) {
        deleteCalls.push({
          credentialId: input.credentialId,
          allowHealthyUnavailable: input.allowHealthyUnavailable === true,
        });
        return {
          deleted: true,
          secretRef: "secret_revoked_1",
          deletedAt: "2026-04-03T11:00:00.000Z",
        };
      },
    },
    secretStore: {
      async put() {
        throw new Error("unused");
      },
      async get() {
        throw new Error("unused");
      },
      async replace(secretRef, secret) {
        tombstones.push({ secretRef, secret });
      },
    },
    auditRepository: {
      async recordEvent(input) {
        auditCalls.push(input);
      },
    },
    alertRepository: {
      async listAlerts() {
        return [];
      },
    },
    now: () => new Date("2026-04-03T11:00:00.000Z"),
  });

  const payload = await service.deleteCredential("admin-token", "cred_revoked_1", "admin@example.test");

  assert.deepEqual(payload, { credential: deletedCredential });
  assert.deepEqual(deleteCalls, [{ credentialId: "cred_revoked_1", allowHealthyUnavailable: false }]);
  assert.deepEqual(tombstones, [
    {
      secretRef: "secret_revoked_1",
      secret: {
        kind: "deleted",
        deletedAt: "2026-04-03T11:00:00.000Z",
        reason: "admin_deleted",
      },
    },
  ]);
  assert.deepEqual(auditCalls, [
    {
      actorUserId: "admin@example.test",
      action: "credential.delete",
      entityType: "credential",
      entityId: "cred_revoked_1",
      result: "warning",
      summary: "Deleted credential cred_revoked_1.",
    },
  ]);
});

test("createDefaultAdminService reconnects a Codex credential in place", async () => {
  const secretReplacements: unknown[] = [];
  const reconnectCalls: string[] = [];
  const auditCalls: Array<{ action: string; entityId: string; result: string }> = [];
  const refreshedCredential = {
    ...createCredential("cred_codex_1", "healthy", { provider: "codex_oauth", activeLeases: 0 }),
    alertCount: 0,
    linkedAlertIds: [],
    lastRefreshAt: "2026-04-03T11:30:00.000Z",
  };
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: createUnusedDenClient(),
    credentialReadRepository: {
      async listAdminCredentials() {
        return [refreshedCredential];
      },
    },
    credentialActionRepository: {
      async revokeCredential() {
        throw new Error("unused");
      },
      async drainCredential() {
        throw new Error("unused");
      },
      async rotateCredential() {
        throw new Error("unused");
      },
      async deleteCredential() {
        throw new Error("unused");
      },
      async reconnectCredential(credentialId: string) {
        reconnectCalls.push(credentialId);
        return true;
      },
    } as any,
    credentialSecretLookupRepository: {
      async getCredentialRecordById(credentialId: string) {
        assert.equal(credentialId, "cred_codex_1");
        return {
          provider: "codex_oauth",
          secretRef: "secret_codex_1",
        };
      },
    },
    secretStore: {
      async put() {
        throw new Error("unused");
      },
      async get() {
        throw new Error("unused");
      },
      async replace(secretRef: string, secret: unknown) {
        secretReplacements.push({ secretRef, secret });
      },
    },
    auditRepository: {
      async recordEvent(input) {
        auditCalls.push({
          action: input.action,
          entityId: input.entityId,
          result: input.result,
        });
      },
      async listEvents() {
        return [];
      },
    },
    alertRepository: {
      async listAlerts() {
        return [];
      },
    },
  } as any);
  const freshAuthJson = createCodexAuthJson("fresh-refresh-token");

  const result = await (service as any).reconnectCredential(
    "admin-token",
    "cred_codex_1",
    { secret: freshAuthJson },
    "admin@example.test",
  );

  assert.equal(result.credential.id, "cred_codex_1");
  assert.equal(result.credential.state, "healthy");
  assert.deepEqual(secretReplacements, [
    {
      secretRef: "secret_codex_1",
      secret: {
        kind: "codex_auth_json",
        authJson: freshAuthJson,
      },
    },
  ]);
  assert.deepEqual(reconnectCalls, ["cred_codex_1"]);
  assert.deepEqual(auditCalls, [
    {
      action: "credential.reconnect",
      entityId: "cred_codex_1",
      result: "ok",
    },
  ]);
});

test("createDefaultAdminService uploads Codex auth through a one-time local helper session", async () => {
  const secretReplacements: unknown[] = [];
  const reconnectCalls: string[] = [];
  const auditCalls: Array<{ action: string; entityId: string; result: string }> = [];
  let currentTime = new Date("2026-06-17T08:00:00.000Z");
  const refreshedCredential = {
    ...createCredential("cred_codex_1", "healthy", { provider: "codex_oauth", activeLeases: 0 }),
    name: "Václav Codex",
    alertCount: 0,
    linkedAlertIds: [],
    lastRefreshAt: "2026-04-03T11:30:00.000Z",
  };
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: createUnusedDenClient(),
    credentialReadRepository: {
      async listAdminCredentials() {
        return [refreshedCredential];
      },
    },
    credentialActionRepository: {
      async renameCredential() {
        throw new Error("unused");
      },
      async revokeCredential() {
        throw new Error("unused");
      },
      async drainCredential() {
        throw new Error("unused");
      },
      async rotateCredential() {
        throw new Error("unused");
      },
      async deleteCredential() {
        throw new Error("unused");
      },
      async reconnectCredential(credentialId: string) {
        reconnectCalls.push(credentialId);
        return true;
      },
    } as any,
    credentialSecretLookupRepository: {
      async getCredentialRecordById(credentialId: string) {
        assert.equal(credentialId, "cred_codex_1");
        return {
          provider: "codex_oauth",
          secretRef: "secret_codex_1",
          name: "Václav Codex",
        };
      },
    },
    secretStore: {
      async put() {
        throw new Error("unused");
      },
      async get() {
        throw new Error("unused");
      },
      async replace(secretRef: string, secret: unknown) {
        secretReplacements.push({ secretRef, secret });
      },
    },
    auditRepository: {
      async recordEvent(input) {
        auditCalls.push({
          action: input.action,
          entityId: input.entityId,
          result: input.result,
        });
      },
      async listEvents() {
        return [];
      },
    },
    alertRepository: {
      async listAlerts() {
        return [];
      },
    },
    now: () => currentTime,
  } as any);
  const freshAuthJson = createCodexAuthJson("fresh-refresh-token");

  const sessionPayload = await (service as any).createCodexAuthUploadSession(
    "admin-token",
    "cred_codex_1",
    { origin: "https://ai.veslo.work" },
    "admin@example.test",
  );
  const expiringSessionPayload = await (service as any).createCodexAuthUploadSession(
    "admin-token",
    "cred_codex_1",
    { origin: "https://ai.veslo.work" },
    "admin@example.test",
  );

  assert.match(sessionPayload.upload.token, /^[a-f0-9]{48}$/);
  assert.equal(sessionPayload.upload.credentialName, "Václav Codex");
  assert.equal(sessionPayload.upload.uploadUrl, `https://ai.veslo.work/admin/api/credentials/codex-auth-upload/${sessionPayload.upload.token}`);
  assert.equal(sessionPayload.upload.expiresAt, "2026-06-17T08:20:00.000Z");
  assert.equal(expiringSessionPayload.upload.expiresAt, "2026-06-17T08:20:00.000Z");
  assert.match(sessionPayload.command, /node scripts\/admin\/codex-auth-upload\.mjs/);

  currentTime = new Date("2026-06-17T08:19:59.000Z");
  const result = await (service as any).uploadCodexAuth(sessionPayload.upload.token, {
    authJson: freshAuthJson,
  });

  assert.deepEqual(result, {
    ok: true,
    credentialId: "cred_codex_1",
    credentialName: "Václav Codex",
    accountId: "acct_codex_runtime",
  });
  assert.deepEqual(secretReplacements, [
    {
      secretRef: "secret_codex_1",
      secret: {
        kind: "codex_auth_json",
        authJson: freshAuthJson,
      },
    },
  ]);
  assert.deepEqual(reconnectCalls, ["cred_codex_1"]);
  assert.deepEqual(auditCalls, [
    {
      action: "credential.codex_auth_upload_session.create",
      entityId: "cred_codex_1",
      result: "ok",
    },
    {
      action: "credential.codex_auth_upload_session.create",
      entityId: "cred_codex_1",
      result: "ok",
    },
    {
      action: "credential.codex_auth_upload",
      entityId: "cred_codex_1",
      result: "ok",
    },
  ]);
  currentTime = new Date("2026-06-17T08:20:00.000Z");
  await assert.rejects(
    () => (service as any).uploadCodexAuth(expiringSessionPayload.upload.token, {
      authJson: freshAuthJson,
    }),
    /codex_auth_upload_session_not_found/,
  );
  await assert.rejects(
    () => (service as any).uploadCodexAuth(sessionPayload.upload.token, {
      authJson: freshAuthJson,
    }),
    /codex_auth_upload_session_not_found/,
  );
});

test("createDefaultAdminService creates a new Codex credential from a one-time local helper session", async () => {
  const secretPuts: unknown[] = [];
  const credentialCreates: unknown[] = [];
  const auditCalls: Array<{ action: string; entityId: string; result: string }> = [];
  const createdAt = new Date("2026-06-17T08:04:00.000Z");
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: createUnusedDenClient(),
    credentialReadRepository: {
      async listAdminCredentials() {
        return [];
      },
    },
    credentialActionRepository: {
      async renameCredential() {
        throw new Error("unused");
      },
      async revokeCredential() {
        throw new Error("unused");
      },
      async drainCredential() {
        throw new Error("unused");
      },
      async rotateCredential() {
        throw new Error("unused");
      },
      async deleteCredential() {
        throw new Error("unused");
      },
      async reconnectCredential() {
        throw new Error("unused");
      },
    } as any,
    credentialWriteRepository: {
      async createPlatformCredential(input: unknown) {
        credentialCreates.push(input);
        return {
          id: "cred_codex_new_1",
          ownerUserId: "platform:codex_oauth",
          provider: "codex_oauth",
          credentialType: "oauth",
          state: "healthy",
          secretRef: "secret_codex_new_1",
          name: "new.account@example.test Codex",
          createdAt,
          updatedAt: createdAt,
          lastFailureAt: null,
          deletedAt: null,
        };
      },
    },
    credentialSecretLookupRepository: {
      async getCredentialRecordById() {
        throw new Error("unused");
      },
    },
    secretStore: {
      async put(secret: unknown) {
        secretPuts.push(secret);
        return { secretRef: "secret_codex_new_1" };
      },
      async get() {
        throw new Error("unused");
      },
      async replace() {
        throw new Error("unused");
      },
    },
    auditRepository: {
      async recordEvent(input) {
        auditCalls.push({
          action: input.action,
          entityId: input.entityId,
          result: input.result,
        });
      },
      async listEvents() {
        return [];
      },
    },
    alertRepository: {
      async listAlerts() {
        return [];
      },
    },
    now: () => new Date("2026-06-17T08:00:00.000Z"),
  } as any);
  const freshAuthJson = createCodexAuthJsonWithEmail("new.account@example.test", "fresh-refresh-token");

  const sessionPayload = await (service as any).createCodexAuthCredentialUploadSession(
    "admin-token",
    { origin: "https://ai.veslo.work" },
    "admin@example.test",
  );

  assert.equal(sessionPayload.upload.credentialId, null);
  assert.equal(sessionPayload.upload.credentialName, "New Codex account");
  assert.equal(sessionPayload.upload.uploadUrl, `https://ai.veslo.work/admin/api/credentials/codex-auth-upload/${sessionPayload.upload.token}`);
  assert.doesNotMatch(sessionPayload.command, /--credential-id/);
  assert.match(sessionPayload.command, /--credential-name 'New Codex account'/);

  const result = await (service as any).uploadCodexAuth(sessionPayload.upload.token, {
    authJson: freshAuthJson,
  });

  assert.deepEqual(result, {
    ok: true,
    credentialId: "cred_codex_new_1",
    credentialName: "new.account@example.test Codex",
    accountId: "acct_codex_runtime",
  });
  assert.deepEqual(secretPuts, [
    {
      kind: "codex_auth_json",
      authJson: freshAuthJson,
    },
  ]);
  assert.deepEqual(credentialCreates, [
    {
      ownerUserId: "platform:codex_oauth",
      name: "new.account@example.test Codex",
      provider: "codex_oauth",
      credentialType: "oauth",
      secretRef: "secret_codex_new_1",
    },
  ]);
  assert.deepEqual(auditCalls, [
    {
      action: "credential.codex_auth_upload_session.create",
      entityId: "new_codex_credential",
      result: "ok",
    },
    {
      action: "credential.codex_auth_upload",
      entityId: "cred_codex_new_1",
      result: "ok",
    },
  ]);
});

test("createDefaultAdminService quarantines Codex credentials with reused refresh tokens", async () => {
  const quarantineCalls: Array<{ credentialId: string; reason: string }> = [];
  const auditCalls: Array<{ action: string; entityId: string; result: string }> = [];
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: createUnusedDenClient(),
    credentialReadRepository: {
      async listAdminCredentials() {
        return [
          {
            ...createCredential("cred_codex_michal", "healthy", { provider: "codex_oauth", activeLeases: 0 }),
            alertCount: 0,
            linkedAlertIds: [],
          },
        ];
      },
    },
    credentialActionRepository: {
      async revokeCredential() {
        throw new Error("unused");
      },
      async drainCredential() {
        throw new Error("unused");
      },
      async rotateCredential() {
        throw new Error("unused");
      },
      async deleteCredential() {
        throw new Error("unused");
      },
      async quarantineCredential(credentialId: string, reason: string) {
        quarantineCalls.push({ credentialId, reason });
        return true;
      },
    } as any,
    codexStatusProvider: {
      async getStatus() {
        return {
          available: false,
          source: "unavailable",
          label: "Codex limits unavailable",
          detail: "Your access token could not be refreshed because your refresh token was already used.",
          checkedAt: "2026-06-04T15:14:57.039Z",
        };
      },
    },
    auditRepository: {
      async recordEvent(input) {
        auditCalls.push({
          action: input.action,
          entityId: input.entityId,
          result: input.result,
        });
      },
      async listEvents() {
        return [];
      },
    },
    alertRepository: {
      async listAlerts() {
        return [];
      },
    },
  } as any);

  const result = await service.listCredentials("admin-token");

  assert.equal(result.credentials[0]?.eligibility?.state, "unavailable");
  assert.deepEqual(quarantineCalls, [
    {
      credentialId: "cred_codex_michal",
      reason: "codex_refresh_token_reused",
    },
  ]);
  assert.deepEqual(auditCalls, [
    {
      action: "credential.quarantine",
      entityId: "cred_codex_michal",
      result: "warning",
    },
  ]);
});

test("credential delete action allows revoked credentials with active leases", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const healthEvents: unknown[] = [];
  const db = {
    select(selection?: Record<string, unknown>) {
      if (!selection) {
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    return [
                      {
                        id: "cred_revoked_1",
                        state: "revoked",
                        deleted_at: null,
                        secret_ref: "secret_revoked_1",
                      },
                    ];
                  },
                };
              },
            };
          },
        };
      }

      if ("activeLeases" in selection) {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  async where() {
                    return [{ activeLeases: 3 }];
                  },
                };
              },
            };
          },
        };
      }

      if ("assignedUsers" in selection) {
        return {
          from() {
            return {
              async where() {
                return [{ assignedUsers: 0 }];
              },
            };
          },
        };
      }

      throw new Error("unexpected_select");
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values);
          return {
            async where() {
              return;
            },
          };
        },
      };
    },
    insert() {
      return {
        async values(value: unknown) {
          healthEvents.push(value);
        },
      };
    },
  };
  const repository = new MySqlAdminCredentialActionRepository(db as never);

  const result = await repository.deleteCredential({ credentialId: "cred_revoked_1" });

  assert.equal(result.deleted, true);
  if (result.deleted) {
    assert.equal(result.secretRef, "secret_revoked_1");
  }
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.state, "revoked");
  assert.ok(updates[0]?.deleted_at instanceof Date);
  assert.deepEqual(healthEvents, []);
});

test("credential delete action allows revoked credentials with assigned users", async () => {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select(selection?: Record<string, unknown>) {
      if (!selection) {
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    return [
                      {
                        id: "cred_revoked_1",
                        state: "revoked",
                        deleted_at: null,
                        secret_ref: "secret_revoked_1",
                      },
                    ];
                  },
                };
              },
            };
          },
        };
      }

      if ("activeLeases" in selection) {
        return {
          from() {
            return {
              innerJoin() {
                return {
                  async where() {
                    return [{ activeLeases: 0 }];
                  },
                };
              },
            };
          },
        };
      }

      if ("assignedUsers" in selection) {
        return {
          from() {
            return {
              async where() {
                return [{ assignedUsers: 2 }];
              },
            };
          },
        };
      }

      throw new Error("unexpected_select");
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          updates.push(values);
          return {
            async where() {
              return;
            },
          };
        },
      };
    },
    insert() {
      return {
        async values() {
          throw new Error("health_event_not_expected");
        },
      };
    },
  };
  const repository = new MySqlAdminCredentialActionRepository(db as never);

  const result = await repository.deleteCredential({ credentialId: "cred_revoked_1" });

  assert.equal(result.deleted, true);
  if (result.deleted) {
    assert.equal(result.secretRef, "secret_revoked_1");
  }
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.state, "revoked");
  assert.ok(updates[0]?.deleted_at instanceof Date);
});

test("POST /admin/api/alerts actions forward admin actor identity and return alert payloads", async () => {
  const { service, calls, session } = createAdminServiceSpy();
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}/admin/api/alerts/alert_health_1`;
    const cases = [
      {
        action: "acknowledge",
        expected: { alert: createAlert("alert_health_1", "acknowledged") },
      },
      {
        action: "resolve",
        expected: { alert: createAlert("alert_health_1", "resolved") },
      },
    ];

    for (const entry of cases) {
      const response = await fetch(`${baseUrl}/${entry.action}`, {
        method: "POST",
        headers: AUTHORIZATION,
      });

      assert.equal(response.status, 200);
      assert.deepEqual(await response.json(), entry.expected);
    }

    assert.deepEqual(calls.alert, [
      { action: "acknowledge", alertId: "alert_health_1", token: "admin-token", actorUserId: session.user.email },
      { action: "resolve", alertId: "alert_health_1", token: "admin-token", actorUserId: session.user.email },
    ]);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("createDefaultAdminService enriches credential payloads with unresolved linked alerts", async () => {
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: {
      async startBrowserAuth() {
        throw new Error("unused");
      },
      async exchangeBrowserAuth() {
        throw new Error("unused");
      },
      async getSession() {
        throw new Error("unused");
      },
      async listUsers() {
        throw new Error("unused");
      },
      async createUser() {
        throw new Error("unused");
      },
      async updateUser() {
        throw new Error("unused");
      },
      async disableUser() {
        throw new Error("unused");
      },
      async enableUser() {
        throw new Error("unused");
      },
      async deleteUser() {
        throw new Error("unused");
      },
    },
    credentialReadRepository: {
      async listAdminCredentials() {
        return [
          {
            ...createCredential("cred_openai_1", "healthy"),
            alertCount: 0,
            linkedAlertIds: [],
          },
        ];
      },
    },
    alertRepository: {
      async listAlerts() {
        return [
          createAlert("alert_health_active", "active"),
          createAlert("alert_health_acknowledged", "acknowledged"),
          createAlert("alert_health_resolved", "resolved"),
          {
            ...createAlert("alert_other_credential", "active"),
            credentialId: "cred_other",
          },
        ];
      },
    },
  });

  const payload = await service.listCredentials("admin-token");

  assert.deepEqual(payload, {
    credentials: [
      {
        ...createCredential("cred_openai_1", "healthy"),
        alertCount: 2,
        linkedAlertIds: ["alert_health_active", "alert_health_acknowledged"],
      },
    ],
  });
});

test("createDefaultAdminService does not duplicate DEN-owned user creation audit", async () => {
  const createdUser: AdminUserRecord = {
    id: "user_created",
    name: "Created User",
    email: "created@example.test",
    emailVerified: false,
    platformAdmin: false,
    disabled: false,
    memberships: [],
  };
  const auditCalls: Array<{
    actorUserId?: string | null;
    entityType: string;
    entityId: string;
    action: string;
    result: "ok" | "warning" | "error";
    summary?: string | null;
  }> = [];
  const consoleErrors: unknown[][] = [];
  const originalConsoleError = console.error;
  console.error = (...args: unknown[]) => {
    consoleErrors.push(args);
  };

  try {
    const service = createDefaultAdminService("http://den.example.test", {
      denClient: {
        async startBrowserAuth() {
          throw new Error("unused");
        },
        async exchangeBrowserAuth() {
          throw new Error("unused");
        },
        async getSession() {
          throw new Error("unused");
        },
        async listUsers() {
          throw new Error("unused");
        },
        async createUser() {
          return createdUser;
        },
        async updateUser() {
          throw new Error("unused");
        },
        async disableUser() {
          throw new Error("unused");
        },
        async enableUser() {
          throw new Error("unused");
        },
        async deleteUser() {
          throw new Error("unused");
        },
      },
      auditRepository: {
        async recordEvent(input) {
          auditCalls.push(input);
          throw new Error("audit_unavailable");
        },
      },
      credentialReadRepository: {
        async listAdminCredentials() {
          return [];
        },
      },
    });

    const result = await service.createUser("admin-token", {
      email: createdUser.email,
      name: createdUser.name,
      platformAdmin: createdUser.platformAdmin,
      orgId: null,
      orgRole: "member",
    });

    assert.deepEqual(result, createdUser);
    assert.deepEqual(auditCalls, []);
    assert.deepEqual(consoleErrors, []);
  } finally {
    console.error = originalConsoleError;
  }
});

test("default admin service selects the least-loaded healthy codex credential with OK upstream status", async () => {
  const statusChecks: string[] = [];
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: createUnusedDenClient(),
    credentialReadRepository: {
      async listAdminCredentials() {
        return [
          createCredential("cred_openai_1", "healthy", {
            provider: "openai",
            activeLeases: 0,
          }),
          createCredential("cred_codex_revoked", "revoked", {
            provider: "codex_oauth",
            activeLeases: 0,
          }),
          createCredential("cred_codex_unavailable", "healthy", {
            provider: "codex_oauth",
            activeLeases: 0,
          }),
          createCredential("cred_codex_3", "healthy", {
            provider: "codex_oauth",
            activeLeases: 1,
          }),
          createCredential("cred_codex_2", "healthy", {
            provider: "codex_oauth",
            activeLeases: 1,
          }),
          createCredential("cred_codex_1", "healthy", {
            provider: "codex_oauth",
            activeLeases: 4,
          }),
        ];
      },
    },
    codexStatusProvider: {
      async getStatus(input) {
        statusChecks.push(input.credentialId);
        return {
          available: input.credentialId !== "cred_codex_unavailable",
          source: "codex_exec_rate_limits",
          label: "Codex limits available",
          detail: null,
          checkedAt: "2026-04-27T12:00:00.000Z",
        };
      },
    },
  });

  const selected = await service.getEligibleCodexCredentialForAutoAssign();

  assert.equal(selected?.credentialId, "cred_codex_2");
  assert.deepEqual(statusChecks, [
    "cred_codex_unavailable",
    "cred_codex_3",
    "cred_codex_2",
    "cred_codex_1",
  ]);
});

test("default admin service returns null when no eligible codex credential exists", async () => {
  const statusChecks: string[] = [];
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: createUnusedDenClient(),
    credentialReadRepository: {
      async listAdminCredentials() {
        return [
          createCredential("cred_openai_1", "healthy", {
            provider: "openai",
            activeLeases: 0,
          }),
          createCredential("cred_codex_revoked", "revoked", {
            provider: "codex_oauth",
            activeLeases: 0,
          }),
          createCredential("cred_codex_draining", "draining", {
            provider: "codex_oauth",
            activeLeases: 0,
          }),
          createCredential("cred_codex_unavailable", "healthy", {
            provider: "codex_oauth",
            activeLeases: 0,
          }),
        ];
      },
    },
    codexStatusProvider: {
      async getStatus(input) {
        statusChecks.push(input.credentialId);
        return {
          available: false,
          source: "unavailable",
          label: "Codex limits unavailable",
          detail: null,
          checkedAt: "2026-04-27T12:00:00.000Z",
        };
      },
    },
  });

  const selected = await service.getEligibleCodexCredentialForAutoAssign();

  assert.equal(selected, null);
  assert.deepEqual(statusChecks, ["cred_codex_unavailable"]);
});

test("default admin service returns Codex model catalog for codex credentials", async () => {
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: createUnusedDenClient(),
    credentialSecretLookupRepository: {
      async getCredentialRecordById(credentialId: string) {
        assert.equal(credentialId, "cred_codex_1");
        return {
          provider: "codex_oauth",
          secretRef: "secret_codex_1",
        };
      },
    },
    secretStore: {
      async put() {
        throw new Error("unused");
      },
      async get() {
        throw new Error("should_not_read_codex_secret_for_catalog");
      },
      async replace() {
        throw new Error("unused");
      },
    },
    codexStatusProvider: {
      async getStatus() {
        return {
          available: true,
          source: "codex_exec_no_rate_limits",
          label: "Codex OK, limits unknown",
          checkedAt: "2026-06-04T15:14:57.039Z",
        };
      },
    },
  });

  const payload = await service.listCredentialModels("admin-token", "cred_codex_1");

  assert.equal(payload.credentialId, "cred_codex_1");
  assert.equal(payload.defaultModel, "gpt-5.6-sol");
  assert.ok(payload.models.includes("gpt-5.4"));
  assert.ok(payload.models.includes("gpt-5.5"));
});

test("default admin service filters unsupported Codex models for a specific credential", async () => {
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: createUnusedDenClient(),
    credentialSecretLookupRepository: {
      async getCredentialRecordById(credentialId: string) {
        assert.equal(credentialId, "cred_codex_vaclav");
        return {
          provider: "codex_oauth",
          secretRef: "secret_codex_vaclav",
          name: "Vaclav CODEX",
        };
      },
    },
    secretStore: {
      async put() {
        throw new Error("unused");
      },
      async get() {
        throw new Error("should_not_read_codex_secret_for_model_filter");
      },
      async replace() {
        throw new Error("unused");
      },
    },
    codexStatusProvider: {
      async getStatus(input) {
        assert.deepEqual(input, {
          credentialId: "cred_codex_vaclav",
          credentialName: "Vaclav CODEX",
        });
        return {
          available: true,
          source: "codex_exec_no_rate_limits",
          label: "Codex OK, limits unknown",
          checkedAt: "2026-06-04T15:14:57.039Z",
          detail: "The 'gpt-5.3-codex' model is not supported when using Codex with a ChatGPT account.",
          unsupportedModels: ["gpt-5.3-codex"],
        } as any;
      },
    },
  });

  const payload = await service.listCredentialModels("admin-token", "cred_codex_vaclav");

  assert.equal(payload.credentialId, "cred_codex_vaclav");
  assert.equal(payload.defaultModel, "gpt-5.6-sol");
  assert.ok(payload.models.includes("gpt-5.5"));
  assert.ok(!payload.models.includes("gpt-5.3-codex"));
});

test("createDefaultAdminService does not auto-assign codex ai access on user creation", async () => {
  const createdUser: AdminUserRecord = {
    id: "user_created",
    name: "Created User",
    email: "created@example.test",
    emailVerified: false,
    platformAdmin: false,
    disabled: false,
    memberships: [],
  };
  const upsertCalls: unknown[] = [];
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: {
      ...createUnusedDenClient(),
      async createUser() {
        return createdUser;
      },
    },
    credentialReadRepository: {
      async listAdminCredentials() {
        return [
          createCredential("cred_codex_1", "healthy", {
            provider: "codex_oauth",
            activeLeases: 4,
          }),
          createCredential("cred_codex_2", "healthy", {
            provider: "codex_oauth",
            activeLeases: 1,
          }),
        ];
      },
    },
    codexStatusProvider: {
      async getStatus(input) {
        return {
          available: false,
          source: "unavailable",
          label: "Codex limits unavailable",
          detail: input.credentialId === "cred_codex_2"
            ? "codex | OK | tokens used | 7,367"
            : "ERROR: Your access token could not be refreshed because your refresh token was already used.",
          checkedAt: "2026-04-27T12:00:00.000Z",
        };
      },
    },
    aiAccessRepository: {
      async getUserAiAccess() {
        return null;
      },
      async upsertUserAiAccess(input) {
        upsertCalls.push(input);
        return {
          id: "ai_access_user_created",
          ...input,
          createdAt: new Date("2026-04-27T12:00:00.000Z"),
          updatedAt: new Date("2026-04-27T12:00:00.000Z"),
        };
      },
    },
    auditRepository: {
      async recordEvent() {
        return;
      },
      async listEvents() {
        return [];
      },
    },
  });

  const result = await service.createUser("admin-token", {
    email: createdUser.email,
    name: createdUser.name,
    platformAdmin: createdUser.platformAdmin,
    orgId: null,
    orgRole: "member",
  });

  assert.deepEqual(result, createdUser);
  assert.deepEqual(upsertCalls, []);
});

test("createDefaultAdminService skips ai access when no eligible codex credential exists", async () => {
  const createdUser: AdminUserRecord = {
    id: "user_created",
    name: "Created User",
    email: "created@example.test",
    emailVerified: false,
    platformAdmin: false,
    disabled: false,
    memberships: [],
  };
  const upsertCalls: unknown[] = [];
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: {
      ...createUnusedDenClient(),
      async createUser() {
        return createdUser;
      },
    },
    credentialReadRepository: {
      async listAdminCredentials() {
        return [
          createCredential("cred_codex_unavailable", "healthy", {
            provider: "codex_oauth",
            activeLeases: 0,
          }),
        ];
      },
    },
    codexStatusProvider: {
      async getStatus() {
        return {
          available: false,
          source: "unavailable",
          label: "Codex limits unavailable",
          detail: null,
          checkedAt: "2026-04-27T12:00:00.000Z",
        };
      },
    },
    aiAccessRepository: {
      async getUserAiAccess() {
        return null;
      },
      async upsertUserAiAccess(input) {
        upsertCalls.push(input);
        throw new Error("unexpected_ai_access_upsert");
      },
    },
    auditRepository: {
      async recordEvent() {
        return;
      },
      async listEvents() {
        return [];
      },
    },
  });

  const result = await service.createUser("admin-token", {
    email: createdUser.email,
    name: createdUser.name,
    platformAdmin: createdUser.platformAdmin,
    orgId: null,
    orgRole: "member",
  });

  assert.deepEqual(result, createdUser);
  assert.deepEqual(upsertCalls, []);
});

test("default admin service rejects enabled codex_oauth access without credentialId", async () => {
  let upsertCalled = false;
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: {
      async startBrowserAuth() {
        throw new Error("unused");
      },
      async exchangeBrowserAuth() {
        throw new Error("unused");
      },
      async getSession() {
        return createSession();
      },
      async listUsers() {
        return [];
      },
      async createUser() {
        throw new Error("unused");
      },
      async updateUser() {
        throw new Error("unused");
      },
      async disableUser() {
        throw new Error("unused");
      },
      async enableUser() {
        throw new Error("unused");
      },
      async deleteUser() {
        throw new Error("unused");
      },
    },
    aiAccessRepository: {
      async getUserAiAccess() {
        return null;
      },
      async upsertUserAiAccess() {
        upsertCalled = true;
        throw new Error("unused");
      },
    } as any,
    modelPolicyRepository: {
      async getPolicy() {
        return {
          id: "platform",
          enabledModels: [{ provider: "codex_oauth", model: "gpt-5.5" }],
          activeModel: { provider: "codex_oauth", model: "gpt-5.5" },
          createdAt: new Date("2026-07-12T08:00:00.000Z"),
          updatedAt: new Date("2026-07-12T08:00:00.000Z"),
        };
      },
      async replacePolicy() { throw new Error("unused"); },
    } as any,
  });
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...AUTHORIZATION,
      },
      body: JSON.stringify({
        enabled: true,
        provider: "codex_oauth",
        organizationId: "org_1",
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), {
      error: "invalid_ai_access_credential_id",
    });
    assert.equal(upsertCalled, false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET admin read endpoints return JSON 502 payloads when read models fail", async () => {
  const { service } = createAdminServiceSpy();
  service.listCredentials = async () => {
    throw new Error("credential_store_down");
  };
  service.listSessions = async () => {
    throw new Error("session_store_down");
  };
  service.getUsage = async () => {
    throw new Error("usage_store_down");
  };
  service.listAlerts = async () => {
    throw new Error("alert_store_down");
  };
  service.listAudit = async () => {
    throw new Error("audit_store_down");
  };

  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const cases = [
      { path: "/admin/api/credentials", expected: { error: "credential_list_failed" } },
      { path: "/admin/api/sessions", expected: { error: "session_list_failed" } },
      { path: "/admin/api/usage", expected: { error: "usage_lookup_failed" } },
      { path: "/admin/api/alerts", expected: { error: "alert_list_failed" } },
      { path: "/admin/api/audit", expected: { error: "audit_list_failed" } },
    ];

    for (const entry of cases) {
      const response = await fetch(`http://127.0.0.1:${port}${entry.path}`, {
        headers: AUTHORIZATION,
      });

      assert.equal(response.status, 502);
      assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
      assert.deepEqual(await response.json(), entry.expected);
    }
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("organization billing facades preserve DEN status and body and enforce organization scope", async () => {
  const { service, session } = createAdminServiceSpy();
  session.platformAdmin = false;
  session.organizations = [{
    id: "org_1",
    name: "Acme",
    slug: "acme",
    ownerUserId: session.user.id,
    role: "organization_admin",
  }, {
    id: "org_2",
    name: "Member Org",
    slug: "member-org",
    ownerUserId: "user_other",
    role: "member",
  }];
  const calls: Array<{ action: string; orgId: string; body?: unknown }> = [];
  const response = (action: string, orgId: string, body?: unknown) => {
    calls.push({ action, orgId, ...(body === undefined ? {} : { body }) });
    return Promise.resolve({ status: 207, body: { action, orgId, accepted: body ?? null } });
  };
  service.getOrganizationBilling = (_token, orgId) => response("get", orgId);
  service.createOrganizationBillingCheckout = (_token, orgId, body) => response("checkout", orgId, body);
  service.createOrganizationBillingPortal = (_token, orgId, body) => response("portal", orgId, body);
  service.updateOrganizationBillingPlan = (_token, orgId, body) => response("plan", orgId, body);
  service.cancelOrganizationBilling = (_token, orgId, body) => response("cancel", orgId, body);
  service.updatePlatformOrganizationBilling = (_token, orgId, body) => response("platform", orgId, body);

  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const base = `http://127.0.0.1:${port}/admin/api/organizations/org_1/billing`;
    const cases: Array<[string, string, unknown?]> = [
      ["get", base],
      ["checkout", `${base}/checkout`, { interval: "monthly", quantities: { managedAiBasic: 2 } }],
      ["portal", `${base}/portal`, {}],
      ["plan", `${base}/plan`, { quantities: { managedAiBasic: 3 } }],
      ["cancel", `${base}/cancel`, {}],
    ];
    for (const [action, url, body] of cases) {
      const method = action === "get" ? "GET" : action === "plan" ? "PATCH" : "POST";
      const result = await fetch(url, {
        method,
        headers: { ...AUTHORIZATION, ...(body === undefined ? {} : { "content-type": "application/json" }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      assert.equal(result.status, 207, action);
      assert.deepEqual(await result.json(), { action, orgId: "org_1", accepted: body ?? null }, action);
    }

    const deniedOrg = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_2/billing`, { headers: AUTHORIZATION });
    assert.equal(deniedOrg.status, 403);
    assert.deepEqual(await deniedOrg.json(), { error: "forbidden" });
    const platformDenied = await fetch(`${base}/platform`, {
      method: "PATCH",
      headers: { ...AUTHORIZATION, "content-type": "application/json" },
      body: JSON.stringify({ status: "active" }),
    });
    assert.equal(platformDenied.status, 403);
    assert.equal(calls.some((entry) => entry.action === "platform"), false);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("organization billing facade preserves exact DEN validation errors", async () => {
  const { service, session } = createAdminServiceSpy();
  session.organizations = [{ id: "org_1", name: "Acme", slug: "acme", ownerUserId: session.user.id, role: "organization_admin" }];
  service.updateOrganizationBillingPlan = async () => ({
    status: 422,
    body: { error: "requested_license_limit_below_active_users", requestedLicenseLimit: 1, activeUserCount: 3 },
  });
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const result = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/billing/plan`, {
      method: "PATCH",
      headers: { ...AUTHORIZATION, "content-type": "application/json" },
      body: JSON.stringify({ quantities: { managedAiBasic: 1 } }),
    });
    assert.equal(result.status, 422);
    assert.deepEqual(await result.json(), {
      error: "requested_license_limit_below_active_users",
      requestedLicenseLimit: 1,
      activeUserCount: 3,
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("organization audit route authorizes and requests a server-scoped audit list", async () => {
  const { service, session } = createAdminServiceSpy();
  session.platformAdmin = false;
  session.organizations = [{ id: "org_1", name: "Acme", slug: "acme", ownerUserId: session.user.id, role: "organization_admin" }];
  const calls: Array<{ orgId: string; limit: number | undefined }> = [];
  service.listOrganizationAudit = async (_token, orgId, limit) => {
    calls.push({ orgId, limit });
    return {
      status: 200,
      body: {
        events: [{
          id: "den:audit_org_1",
          timestamp: "2026-07-12T12:00:00.000Z",
          actor: "admin@example.test",
          action: "organization.member.update",
          entityType: "user",
          entityId: "user_1",
          result: "ok",
          summary: "Membership updated.",
          changedFields: [],
          organizationId: orgId,
          source: "den",
        }],
      },
    };
  };
  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const allowed = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/audit?limit=25`, { headers: AUTHORIZATION });
    assert.equal(allowed.status, 200);
    assert.equal((await allowed.json()).events[0].organizationId, "org_1");
    const denied = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_2/audit`, { headers: AUTHORIZATION });
    assert.equal(denied.status, 403);
    assert.deepEqual(calls, [{ orgId: "org_1", limit: 25 }]);
  } finally {
    server.close();
    await once(server, "close");
  }
});
