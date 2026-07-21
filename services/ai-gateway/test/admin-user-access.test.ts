import assert from "node:assert/strict";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import test from "node:test";

import {
  createDefaultAdminService,
  type AdminOrganizationMemberRecord,
  type AdminSessionSnapshot,
  type CredentialRecord,
} from "../src/http/admin.js";
import { AiAccessAuditPersistenceError } from "../src/access/mysql-repository.js";
import { createApp } from "../src/index.js";
import { createPlatformModelCapabilityVerifier } from "../src/model-policy/capability-verifier.js";

const ADMIN_AUTHORIZATION = { authorization: "Bearer admin-token" };
const USER_AUTHORIZATION = { authorization: "Bearer den-user-token" };

const AI_ACCESS_PAYLOAD = {
  id: "ai_access_user_123",
  userId: "user_123",
  enabled: true,
  provider: "openai",
  credentialId: "cred_openai_123",
  defaultModel: "gpt-5.5",
  allowedModels: ["gpt-5.5"],
  updatedAt: "2026-04-08T10:00:00.000Z",
};

const AVAILABLE_CREDENTIALS = [
  { id: "cred_codex_123", name: "Shared Codex A", provider: "codex_oauth" },
  { id: "cred_codex_456", name: "Shared Codex B", provider: "codex_oauth" },
];

const ORGANIZATION_MEMBER: AdminOrganizationMemberRecord = {
  membershipId: "membership_123",
  userId: "user_123",
  name: "Target User",
  email: "target@example.test",
  platformAdmin: false,
  role: "member",
  status: "active",
  createdAt: "2026-07-12T08:00:00.000Z",
};

function createPlatformAdminSession(
  capabilities?: AdminSessionSnapshot["capabilities"],
): AdminSessionSnapshot {
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
    ...(capabilities ? { capabilities } : {}),
  };
}

function createOrganizationAdminSession(orgId: string): AdminSessionSnapshot {
  return {
    user: {
      id: "user_org_admin",
      email: "org-admin@example.test",
      emailVerified: true,
      name: "Organization Admin",
    },
    platformAdmin: false,
    activeOrgId: orgId,
    organizations: [{
      id: orgId,
      name: "Organization A",
      slug: "organization-a",
      role: "organization_admin",
    }],
    capabilities: ["managedAiUserAccess"],
  };
}

type QualifiedAiAccessCalls = {
  order: string[];
  listMembers: Array<{ token: string; orgId: string }>;
  get: Array<{ token: string; userId: string }>;
  upsert: Array<{
    token: string;
    userId: string;
    input: Record<string, unknown>;
    organizationId: string | null | undefined;
    actorUserId: string | null | undefined;
  }>;
};

function createQualifiedAiAccessApp(options: {
  session?: AdminSessionSnapshot;
  members?: unknown;
  memberResponse?: unknown;
  listMembersError?: unknown;
  upsertError?: unknown;
} = {}) {
  const calls: QualifiedAiAccessCalls = {
    order: [],
    listMembers: [],
    get: [],
    upsert: [],
  };
  const app = createApp({
    admin: {
      async getSession() {
        return options.session ?? createPlatformAdminSession();
      },
      async listOrganizationMembers(token: string, orgId: string) {
        calls.order.push("list-members");
        calls.listMembers.push({ token, orgId });
        if (options.listMembersError) throw options.listMembersError;
        return (Object.hasOwn(options, "memberResponse")
          ? options.memberResponse
          : { members: options.members ?? [ORGANIZATION_MEMBER] }) as any;
      },
      async getUserAiAccess(token: string, userId: string) {
        calls.order.push("get-ai-access");
        calls.get.push({ token, userId });
        return {
          aiAccess: { ...AI_ACCESS_PAYLOAD, userId },
          availableCredentials: AVAILABLE_CREDENTIALS,
        };
      },
      async upsertUserAiAccess(
        token: string,
        userId: string,
        input: Record<string, unknown>,
        organizationId?: string | null,
        actorUserId?: string | null,
      ) {
        calls.order.push("upsert-ai-access");
        calls.upsert.push({ token, userId, input, organizationId, actorUserId });
        if (options.upsertError) throw options.upsertError;
        return {
          aiAccess: { ...AI_ACCESS_PAYLOAD, userId, ...input },
          availableCredentials: AVAILABLE_CREDENTIALS,
        };
      },
    } as any,
  });
  return { app, calls };
}

async function requestQualifiedAiAccess(
  app: ReturnType<typeof createApp>,
  method: "GET" | "PUT",
  options: { orgId?: string; userId?: string; body?: Record<string, unknown> } = {},
) {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/admin/api/organizations/${options.orgId ?? "org_1"}/members/${options.userId ?? "user_123"}/ai-access`,
      {
        method,
        headers: method === "PUT"
          ? { "content-type": "application/json", ...ADMIN_AUTHORIZATION }
          : ADMIN_AUTHORIZATION,
        ...(method === "PUT"
          ? {
              body: JSON.stringify(options.body ?? {
                enabled: true,
              }),
            }
          : {}),
      },
    );
    return { status: response.status, body: await response.json() };
  } finally {
    server.close();
    await once(server, "close");
  }
}

let adminUserAccessUpsertCalls = 0;
let adminUserAccessMemberListCalls = 0;
let adminUserAccessOrganizationId: string | null | undefined;
let adminUserAccessActorUserId: string | null | undefined;

function createCredential(
  id: string,
  overrides: Partial<Pick<CredentialRecord, "provider" | "state" | "activeLeases">> = {},
): CredentialRecord {
  return {
    id,
    name: `Credential ${id}`,
    provider: overrides.provider ?? "codex_oauth",
    type: "oauth",
    state: overrides.state ?? "healthy",
    scope: "platform",
    activeLeases: overrides.activeLeases ?? 0,
    alertCount: 0,
    lastRefreshAt: "2026-04-27T12:00:00.000Z",
    lastFailureAt: null,
    totalTokens: 0,
    nextRotationAt: null,
    linkedAlertIds: [],
  };
}

function createCodexModelPolicyRepository(enabledModels = ["gpt-5.5"]) {
  return {
    async getPolicy() {
      return {
        id: "platform" as const,
        enabledModels: enabledModels.map((model) => ({ provider: "codex_oauth" as const, model })),
        activeModel: { provider: "codex_oauth" as const, model: "gpt-5.5" },
        createdAt: new Date("2026-07-12T08:00:00.000Z"),
        updatedAt: new Date("2026-07-12T08:00:00.000Z"),
      };
    },
    async replacePolicy() { throw new Error("unused"); },
  };
}

function createSupportedModelCapabilities() {
  return {
    async checkHealthyCredentialForModel() { return { status: "supported", credentialId: "unused" } as const; },
    async checkCredentialForModel(credentialId: string) { return { status: "supported", credentialId } as const; },
    async hasHealthyCredentialForModel() { return true; },
    invalidateCredential() {},
  };
}

function createToggleOnlyAdminServiceHarness() {
  const builds: Array<{ userId: string; origin: string }> = [];
  const reads: string[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const derived = {
    userId: "user_123",
    enabled: true,
    provider: "codex_oauth" as const,
    credentialId: "cred_healthy",
    defaultModel: "gpt-5.6",
    allowedModels: ["gpt-5.6"],
    assignmentOrigin: "admin_assigned" as const,
  };
  const savedRecord = {
    id: "access_user_123",
    ...derived,
    createdAt: new Date("2026-07-21T00:00:00.000Z"),
    updatedAt: new Date("2026-07-21T00:00:00.000Z"),
  };
  const service = createDefaultAdminService("http://den.example.test", {
    automaticUserAiAccess: {
      async getOrCreateUserAiAccess(userId) {
        reads.push(userId);
        return { ...savedRecord, userId, assignmentOrigin: "auto_assigned" };
      },
      async buildEnabledUpdate(userId, origin) {
        builds.push({ userId, origin });
        return { ...derived, userId, assignmentOrigin: origin };
      },
    },
    aiAccessMutation: {
      async upsertUserAiAccessWithAudit(input) {
        writes.push(input);
        return {
          ...savedRecord,
          ...input,
          createdAt: savedRecord.createdAt,
          updatedAt: savedRecord.updatedAt,
        };
      },
    },
  });
  return { service, builds, reads, writes };
}

test("default admin GET lazily creates missing AI access through the shared automatic service", async () => {
  const { service, reads } = createToggleOnlyAdminServiceHarness();

  const result = await service.getUserAiAccess("admin-token", "user_123");

  assert.deepEqual(reads, ["user_123"]);
  assert.equal(result.aiAccess?.enabled, true);
  assert.equal(result.aiAccess?.provider, "codex_oauth");
  assert.deepEqual(result.availableCredentials, []);
});

test("default admin enable derives routing server-side and audits exact actor and organization", async () => {
  const { service, builds, writes } = createToggleOnlyAdminServiceHarness();

  await service.upsertUserAiAccess("admin-token", "user_123", { enabled: true }, "org_1", "actor_1");

  assert.deepEqual(builds, [{ userId: "user_123", origin: "admin_assigned" }]);
  assert.deepEqual(writes, [{
    userId: "user_123",
    enabled: true,
    provider: "codex_oauth",
    credentialId: "cred_healthy",
    defaultModel: "gpt-5.6",
    allowedModels: ["gpt-5.6"],
    assignmentOrigin: "admin_assigned",
    actorUserId: "actor_1",
    organizationId: "org_1",
  }]);
});

test("default admin disable clears all routing and model fields without capability work", async () => {
  const { service, builds, writes } = createToggleOnlyAdminServiceHarness();

  await service.upsertUserAiAccess("admin-token", "user_123", { enabled: false }, "org_1", "actor_1");

  assert.deepEqual(builds, []);
  assert.deepEqual(writes, [{
    userId: "user_123",
    enabled: false,
    provider: null,
    credentialId: null,
    defaultModel: null,
    allowedModels: [],
    assignmentOrigin: "admin_assigned",
    actorUserId: "actor_1",
    organizationId: "org_1",
  }]);
});

function createAdminUserAccessApp(options: { upsertError?: Error; members?: unknown } = {}) {
  adminUserAccessUpsertCalls = 0;
  adminUserAccessMemberListCalls = 0;
  adminUserAccessOrganizationId = undefined;
  adminUserAccessActorUserId = undefined;
  let currentAiAccess = {
    ...AI_ACCESS_PAYLOAD,
  };

  const app = createApp({
    admin: {
      async startBrowserAuth() {
        throw new Error("unused");
      },
      async exchangeBrowserAuth() {
        throw new Error("unused");
      },
      async getSession() {
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
      },
      async listUsers() {
        return [];
      },
      async listOrganizationMembers() {
        adminUserAccessMemberListCalls += 1;
        return { members: options.members ?? [ORGANIZATION_MEMBER] };
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
      async revokeCredential() {
        throw new Error("unused");
      },
      async drainCredential() {
        throw new Error("unused");
      },
      async rotateCredential() {
        throw new Error("unused");
      },
      async listSessions() {
        return { sessions: [] };
      },
      async getUsage() {
        return {
          summary: { totalTokens: 0, totalRequests: 0 },
          groupBy: "total",
          filters: { credentials: [], users: [], orgs: [] },
          series: [],
          topCredentials: [],
          topUsers: [],
          topOrgs: [],
        };
      },
      async listAlerts() {
        return { alerts: [] };
      },
      async acknowledgeAlert() {
        throw new Error("unused");
      },
      async resolveAlert() {
        throw new Error("unused");
      },
      async listAudit() {
        return { events: [] };
      },
      async getUserAiAccess(_token: string, userId: string) {
        return {
          aiAccess: {
            ...currentAiAccess,
            userId,
          },
          availableCredentials: AVAILABLE_CREDENTIALS,
        };
      },
      async upsertUserAiAccess(_token: string, userId: string, input: Record<string, unknown>, organizationId?: string | null, actorUserId?: string | null) {
        if (options.upsertError) throw options.upsertError;
        adminUserAccessUpsertCalls += 1;
        adminUserAccessOrganizationId = organizationId;
        adminUserAccessActorUserId = actorUserId;
        currentAiAccess = {
          ...currentAiAccess,
          userId,
          ...input,
          provider: input.enabled === false ? null : currentAiAccess.provider,
          credentialId: input.enabled === false ? null : currentAiAccess.credentialId,
          defaultModel: input.enabled === false ? null : currentAiAccess.defaultModel,
          allowedModels: input.enabled === false ? [] : currentAiAccess.allowedModels,
        };
        return {
          aiAccess: {
            ...currentAiAccess,
          },
          availableCredentials: AVAILABLE_CREDENTIALS,
        };
      },
    } as any,
    userCredentials: {
      sessionResolver: {
        async resolveSession(token: string) {
          assert.equal(token, "den-user-token");
          return {
            token,
            user: {
              id: "user_123",
              email: "user@example.test",
            },
          };
        },
      },
      openAiOAuth: {
        async startAuthorization() {
          throw new Error("unused");
        },
        async exchangeCode() {
          throw new Error("unused");
        },
      },
      credentials: {
        async getCredentialRecordById() {
          return null;
        },
        async listHealthyCredentialRecordIds() {
          return [];
        },
        async markCredentialState() {},
      },
      secrets: {
        async put() {
          throw new Error("unused");
        },
        async get() {
          throw new Error("unused");
        },
      },
      aiAccess: {
        async getUserAiAccess(userId: string) {
          return {
            ...currentAiAccess,
            userId,
          };
        },
      },
      modelPolicy: {
        async getPolicy() {
          return {
            id: "platform",
            enabledModels: [{ provider: "openai", model: "gpt-5.5" }],
            activeModel: { provider: "openai", model: "gpt-5.5" },
            createdAt: new Date("2026-07-12T08:00:00.000Z"),
            updatedAt: new Date("2026-07-12T08:00:00.000Z"),
          };
        },
      },
    } as any,
  });

  return app;
}

for (const method of ["GET", "PUT"] as const) {
  test(`${method} qualified AI access rejects a missing capability before service calls`, async () => {
    const { app, calls } = createQualifiedAiAccessApp({
      session: createPlatformAdminSession(["organization"]),
    });

    const response = await requestQualifiedAiAccess(app, method);

    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: "forbidden" });
    assert.deepEqual(calls.order, []);
  });

  test(`${method} qualified AI access checks path organization access before membership`, async () => {
    const { app, calls } = createQualifiedAiAccessApp({
      session: createOrganizationAdminSession("org_a"),
    });

    const response = await requestQualifiedAiAccess(app, method, { orgId: "org_b" });

    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: "forbidden" });
    assert.deepEqual(calls.order, []);
  });

  test(`${method} qualified AI access requires an exact member user ID`, async () => {
    const { app, calls } = createQualifiedAiAccessApp({
      members: [{
        ...ORGANIZATION_MEMBER,
        membershipId: "user_123",
        userId: "different_user",
      }],
    });

    const response = await requestQualifiedAiAccess(app, method);

    assert.equal(response.status, 404);
    assert.deepEqual(response.body, { error: "member_not_found" });
    assert.deepEqual(calls.listMembers, [{ token: "admin-token", orgId: "org_1" }]);
    assert.deepEqual(calls.get, []);
    assert.deepEqual(calls.upsert, []);
  });

  test(`${method} qualified AI access rejects inactive target memberships`, async () => {
    for (const status of ["disabled", "removed"] as const) {
      const { app, calls } = createQualifiedAiAccessApp({
        members: [{ ...ORGANIZATION_MEMBER, status }],
      });

      const response = await requestQualifiedAiAccess(app, method);

      assert.equal(response.status, 404);
      assert.deepEqual(response.body, { error: "member_not_found" });
      assert.deepEqual(calls.get, []);
      assert.deepEqual(calls.upsert, []);
    }
  });

  test(`${method} qualified AI access fails closed on a malformed member response`, async () => {
    for (const memberResponse of [null, {}, { members: "not-an-array" }]) {
      const { app, calls } = createQualifiedAiAccessApp({ memberResponse });

      const response = await requestQualifiedAiAccess(app, method);

      assert.equal(response.status, 502);
      assert.deepEqual(response.body, { error: "organization_member_response_invalid" });
      assert.deepEqual(calls.get, []);
      assert.deepEqual(calls.upsert, []);
    }
  });

  test(`${method} qualified AI access fails closed on malformed member records`, async () => {
    const malformedMembers = [
      null,
      { userId: "user_123", status: "active" },
      { ...ORGANIZATION_MEMBER, email: 17 },
    ];
    for (const malformedMember of malformedMembers) {
      const { app, calls } = createQualifiedAiAccessApp({ members: [malformedMember] });

      const response = await requestQualifiedAiAccess(app, method);

      assert.equal(response.status, 502);
      assert.deepEqual(response.body, { error: "organization_member_response_invalid" });
      assert.deepEqual(calls.get, []);
      assert.deepEqual(calls.upsert, []);
    }
  });

  test(`${method} qualified AI access fails closed on missing or invalid member status`, async () => {
    const { status: _status, ...memberWithoutStatus } = ORGANIZATION_MEMBER;
    for (const member of [memberWithoutStatus, { ...ORGANIZATION_MEMBER, status: "pending" }]) {
      const { app, calls } = createQualifiedAiAccessApp({ members: [member] });

      const response = await requestQualifiedAiAccess(app, method);

      assert.equal(response.status, 502);
      assert.deepEqual(response.body, { error: "organization_member_response_invalid" });
      assert.deepEqual(calls.get, []);
      assert.deepEqual(calls.upsert, []);
    }
  });

  test(`${method} qualified AI access fails closed on duplicate target memberships`, async () => {
    const duplicateSets = [
      [ORGANIZATION_MEMBER, { ...ORGANIZATION_MEMBER, membershipId: "membership_456" }],
      [ORGANIZATION_MEMBER, {
        ...ORGANIZATION_MEMBER,
        membershipId: "membership_456",
        status: "disabled",
      }],
    ];
    for (const members of duplicateSets) {
      const { app, calls } = createQualifiedAiAccessApp({ members });

      const response = await requestQualifiedAiAccess(app, method);

      assert.equal(response.status, 502);
      assert.deepEqual(response.body, { error: "organization_member_response_invalid" });
      assert.deepEqual(calls.get, []);
      assert.deepEqual(calls.upsert, []);
    }
  });

  test(`${method} qualified AI access safely maps member-list failures before AI access`, async () => {
    for (const listMembersError of [
      new Error("private member payload"),
      { status: 404, message: "private organization payload" },
      { status: 503, message: "private DEN outage payload" },
    ]) {
      const { app, calls } = createQualifiedAiAccessApp({ listMembersError });

      const response = await requestQualifiedAiAccess(app, method);

      assert.equal(response.status, 502);
      assert.deepEqual(response.body, { error: "organization_member_lookup_failed" });
      assert.deepEqual(calls.order, ["list-members"]);
      assert.deepEqual(calls.get, []);
      assert.deepEqual(calls.upsert, []);
    }
  });

  test(`${method} qualified AI access sanitizes upstream authorization errors`, async () => {
    for (const [status, error] of [[401, "unauthorized"], [403, "forbidden"]] as const) {
      const { app, calls } = createQualifiedAiAccessApp({
        listMembersError: { status, message: "private DEN authorization payload" },
      });

      const response = await requestQualifiedAiAccess(app, method);

      assert.equal(response.status, status);
      assert.deepEqual(response.body, { error });
      assert.deepEqual(calls.order, ["list-members"]);
      assert.deepEqual(calls.get, []);
      assert.deepEqual(calls.upsert, []);
    }
  });
}

test("GET qualified AI access lists the path organization before reading the confirmed member", async () => {
  const { app, calls } = createQualifiedAiAccessApp();

  const response = await requestQualifiedAiAccess(app, "GET", { orgId: "org_explicit" });

  assert.equal(response.status, 200);
  assert.deepEqual(response.body, {
    aiAccess: AI_ACCESS_PAYLOAD,
    availableCredentials: AVAILABLE_CREDENTIALS,
  });
  assert.deepEqual(calls.listMembers, [{ token: "admin-token", orgId: "org_explicit" }]);
  assert.deepEqual(calls.get, [{ token: "admin-token", userId: "user_123" }]);
  assert.deepEqual(calls.upsert, []);
  assert.deepEqual(calls.order, ["list-members", "get-ai-access"]);
});

test("PUT qualified AI access uses the path organization and real session actor after membership", async () => {
  const { app, calls } = createQualifiedAiAccessApp();

  const response = await requestQualifiedAiAccess(app, "PUT", {
    orgId: "org_explicit",
    body: {
      enabled: true,
    },
  });

  assert.equal(response.status, 200);
  assert.deepEqual(calls.listMembers, [{ token: "admin-token", orgId: "org_explicit" }]);
  assert.deepEqual(calls.get, []);
  assert.deepEqual(calls.upsert, [{
    token: "admin-token",
    userId: "user_123",
    input: {
      enabled: true,
    },
    organizationId: "org_explicit",
    actorUserId: "user_admin",
  }]);
  assert.deepEqual(calls.order, ["list-members", "upsert-ai-access"]);
});

test("PUT qualified AI access rejects every client routing field before membership or writes", async () => {
  for (const [field, value] of [
    ["provider", "codex_oauth"],
    ["credentialId", "cred_codex_123"],
    ["defaultModel", "gpt-5.4"],
    ["allowedModels", ["gpt-5.4"]],
    ["model", "gpt-5.4"],
    ["routing", { provider: "codex_oauth" }],
  ] as const) {
    const { app, calls } = createQualifiedAiAccessApp();
    const response = await requestQualifiedAiAccess(app, "PUT", {
      body: { enabled: true, [field]: value },
    });

    assert.equal(response.status, 400, field);
    assert.deepEqual(response.body, { error: "user_ai_access_routing_not_supported" }, field);
    assert.deepEqual(calls.order, [], field);
  }
});

test("PUT qualified AI access requires an exact boolean enabled before membership", async () => {
  for (const body of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: null }]) {
    const { app, calls } = createQualifiedAiAccessApp();
    const response = await requestQualifiedAiAccess(app, "PUT", { body });

    assert.equal(response.status, 400);
    assert.deepEqual(response.body, { error: "user_ai_access_enabled_required" });
    assert.deepEqual(calls.order, []);
  }
});

test("PUT qualified AI access maps audit persistence failures", async () => {
  const { app, calls } = createQualifiedAiAccessApp({
    upsertError: new AiAccessAuditPersistenceError(new Error("audit unavailable")),
  });

  const response = await requestQualifiedAiAccess(app, "PUT");

  assert.equal(response.status, 502);
  assert.deepEqual(response.body, { error: "user_ai_access_audit_failed" });
  assert.deepEqual(calls.order, ["list-members", "upsert-ai-access"]);
});

test("unqualified admin AI-access GET and PUT return JSON 404 without service calls", async () => {
  for (const method of ["GET", "PUT"] as const) {
    const { app, calls } = createQualifiedAiAccessApp();
    const server = app.listen(0, "127.0.0.1");
    await once(server, "listening");

    try {
      const { port } = server.address() as AddressInfo;
      const response = await fetch(`http://127.0.0.1:${port}/admin/api/users/user_123/ai-access`, {
        method,
        headers: method === "PUT"
          ? { "content-type": "application/json", ...ADMIN_AUTHORIZATION }
          : ADMIN_AUTHORIZATION,
        ...(method === "PUT"
          ? { body: JSON.stringify({ enabled: true, provider: "codex_oauth", credentialId: "cred_codex_123" }) }
          : {}),
      });

      assert.equal(response.status, 404, method);
      assert.equal(response.headers.get("content-type")?.includes("application/json"), true, method);
      assert.deepEqual(await response.json(), { error: "not_found" }, method);
      assert.deepEqual(calls.order, [], method);
    } finally {
      server.close();
      await once(server, "close");
    }
  }
});

test("admin server source contains no unqualified AI-access business handlers", async () => {
  const source = await readFile(new URL("../src/http/admin.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /router\.get\("\/admin\/api\/users\/:userId\/ai-access"/);
  assert.doesNotMatch(source, /router\.put\("\/admin\/api\/users\/:userId\/ai-access"/);
  assert.match(source, /router\.get\("\/admin\/api\/organizations\/:orgId\/members\/:userId\/ai-access"/);
  assert.match(source, /router\.put\("\/admin\/api\/organizations\/:orgId\/members\/:userId\/ai-access"/);
});

test("PUT qualified AI access rejects legacy user model fields without writing", async () => {
  const app = createAdminUserAccessApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/members/user_123/ai-access`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...ADMIN_AUTHORIZATION },
      body: JSON.stringify({
        enabled: true,
        provider: "codex_oauth",
        credentialId: "cred_codex_123",
        defaultModel: "gpt-5.4",
        allowedModels: ["gpt-5.4"],
      }),
    });

    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "user_ai_access_routing_not_supported" });
    assert.equal(adminUserAccessUpsertCalls, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("PUT qualified AI access forwards path organization scope and real actor", async () => {
  const app = createAdminUserAccessApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/members/user_123/ai-access`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...ADMIN_AUTHORIZATION },
      body: JSON.stringify({
        enabled: true,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(adminUserAccessOrganizationId, "org_1");
    assert.equal(adminUserAccessActorUserId, "user_admin");
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("qualified PUT requires one active scoped membership before writing", async () => {
  const app = createAdminUserAccessApp({
    members: [{ ...ORGANIZATION_MEMBER, status: "disabled" }],
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/members/user_123/ai-access`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...ADMIN_AUTHORIZATION },
      body: JSON.stringify({
        enabled: false,
      }),
    });

    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "member_not_found" });
    assert.equal(adminUserAccessMemberListCalls, 1);
    assert.equal(adminUserAccessUpsertCalls, 0);
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("PUT qualified AI access reports audit persistence failure without success", async () => {
  const app = createAdminUserAccessApp({
    upsertError: new AiAccessAuditPersistenceError(new Error("audit unavailable")),
  });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/members/user_123/ai-access`, {
      method: "PUT",
      headers: { "content-type": "application/json", ...ADMIN_AUTHORIZATION },
      body: JSON.stringify({
        enabled: false,
      }),
    });

    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: "user_ai_access_audit_failed" });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("qualified AI-access PUT uses one scoped membership lookup without listing global users", async () => {
  const mutationInputs: unknown[] = [];
  let memberListCalls = 0;
  let globalUserListCalls = 0;
  const service = createDefaultAdminService("http://den.example.test", {
    denClient: {
      async getSession() {
        return createPlatformAdminSession();
      },
      async listOrganizationMembers(_token: string, orgId: string) {
        memberListCalls += 1;
        assert.equal(orgId, "org_1");
        return { members: [ORGANIZATION_MEMBER] };
      },
      async listUsers() {
        globalUserListCalls += 1;
        throw new Error("global user directory must not be queried");
      },
    },
    aiAccessRepository: {
      async getUserAiAccess() { return null; },
      async upsertUserAiAccess() { throw new Error("plain repository write must not be used"); },
    },
    automaticUserAiAccess: {
      async getOrCreateUserAiAccess() { throw new Error("unused"); },
      async buildEnabledUpdate(userId, assignmentOrigin) {
        return {
          userId,
          enabled: true,
          provider: "codex_oauth",
          credentialId: "cred_codex_123",
          defaultModel: "gpt-5.5",
          allowedModels: ["gpt-5.5", "gpt-5.6-sol"],
          assignmentOrigin,
        };
      },
    },
    aiAccessMutation: {
      async upsertUserAiAccessWithAudit(input: Record<string, unknown>) {
        mutationInputs.push(input);
        return {
          id: "ai_access_user_123",
          userId: "user_123",
          enabled: true,
          provider: "codex_oauth",
          credentialId: "cred_codex_123",
          defaultModel: "gpt-5.5",
          allowedModels: ["gpt-5.5"],
          assignmentOrigin: "admin_assigned",
          createdAt: new Date("2026-07-12T12:00:00.000Z"),
          updatedAt: new Date("2026-07-12T12:00:00.000Z"),
        };
      },
    },
    modelPolicyRepository: createCodexModelPolicyRepository(["gpt-5.5", "gpt-5.6-sol"]),
    modelCapabilities: createSupportedModelCapabilities(),
    credentialReadRepository: {
      async listAdminCredentials() {
        return [createCredential("cred_codex_123")];
      },
    },
    codexStatusProvider: {
      async getStatus() {
        return {
          available: true,
          source: "codex_exec_no_rate_limits",
          label: "Codex OK",
          checkedAt: "2026-07-12T12:00:00.000Z",
        } as const;
      },
    },
  } as any);

  const app = createApp({ admin: service });
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/admin/api/organizations/org_1/members/user_123/ai-access`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", ...ADMIN_AUTHORIZATION },
        body: JSON.stringify({
          enabled: true,
        }),
      },
    );
    assert.equal(response.status, 200);
  } finally {
    server.close();
    await once(server, "close");
  }

  assert.equal(memberListCalls, 1);
  assert.equal(globalUserListCalls, 0);
  assert.deepEqual(mutationInputs, [{
    actorUserId: "user_admin",
    organizationId: "org_1",
    userId: "user_123",
    enabled: true,
    provider: "codex_oauth",
    credentialId: "cred_codex_123",
    defaultModel: "gpt-5.5",
    allowedModels: ["gpt-5.5", "gpt-5.6-sol"],
    assignmentOrigin: "admin_assigned",
  }]);
});

test("PUT qualified AI access accepts the enabled-only contract", async () => {
  const app = createAdminUserAccessApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/members/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...ADMIN_AUTHORIZATION,
      },
      body: JSON.stringify({
        enabled: true,
      }),
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      aiAccess: {
        ...AI_ACCESS_PAYLOAD,
        userId: "user_123",
        enabled: true,
      },
      availableCredentials: AVAILABLE_CREDENTIALS,
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("GET /api/me/ai-access returns the signed-in user's effective ai access policy", async () => {
  const app = createAdminUserAccessApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const response = await fetch(`http://127.0.0.1:${port}/api/me/ai-access`, {
      headers: USER_AUTHORIZATION,
    });

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      aiAccess: {
        ...AI_ACCESS_PAYLOAD,
        effectiveModel: { provider: "openai", model: "gpt-5.5" },
        selectableModels: [],
      },
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});

test("admin ai access updates flow through to the signed-in user's effective policy", async () => {
  const app = createAdminUserAccessApp();
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");

  try {
    const { port } = server.address() as AddressInfo;
    const updateResponse = await fetch(`http://127.0.0.1:${port}/admin/api/organizations/org_1/members/user_123/ai-access`, {
      method: "PUT",
      headers: {
        "content-type": "application/json",
        ...ADMIN_AUTHORIZATION,
      },
      body: JSON.stringify({
        enabled: false,
      }),
    });

    assert.equal(updateResponse.status, 200);

    const effectivePolicyResponse = await fetch(`http://127.0.0.1:${port}/api/me/ai-access`, {
      headers: USER_AUTHORIZATION,
    });

    assert.equal(effectivePolicyResponse.status, 200);
    assert.deepEqual(await effectivePolicyResponse.json(), {
      aiAccess: {
        ...AI_ACCESS_PAYLOAD,
        userId: "user_123",
        enabled: false,
        provider: null,
        credentialId: null,
        defaultModel: null,
        allowedModels: [],
        effectiveModel: null,
        selectableModels: [],
      },
    });
  } finally {
    server.close();
    await once(server, "close");
  }
});
