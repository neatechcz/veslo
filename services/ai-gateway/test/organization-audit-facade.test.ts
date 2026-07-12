import assert from "node:assert/strict";
import test from "node:test";

import { createDefaultAdminService } from "../src/http/admin.js";
import type { AuditEventRecord } from "../src/audit/repository.js";

const event = (id: string, timestamp: string, action: string): AuditEventRecord => ({
  id,
  timestamp,
  actor: `actor_${id}`,
  action,
  entityType: "organization",
  entityId: "org_1",
  result: "ok",
  summary: action,
  changedFields: [],
  organizationId: "org_1",
});

test("organization audit facade merges DEN and Gateway sources and applies one final limit", async () => {
  const denCalls: unknown[] = [];
  const gatewayCalls: unknown[] = [];
  const service = createDefaultAdminService("https://den.example.test", {
    denClient: {
      async listOrganizationAudit(token: string, organizationId: string, limit: number) {
        denCalls.push({ token, organizationId, limit });
        return {
          status: 200,
          body: {
            events: [
              event("den_new", "2026-07-12T12:00:00.000Z", "organization.member.update"),
              event("den_old", "2026-07-12T09:00:00.000Z", "organization.update"),
            ],
          },
        };
      },
    } as never,
    auditRepository: {
      async recordEvent() {},
      async listEvents(input) {
        gatewayCalls.push(input);
        return [event("gateway_middle", "2026-07-12T11:00:00.000Z", "user.ai_access.update")];
      },
    },
  });

  const result = await service.listOrganizationAudit!("token_123", "org_1", 2);

  assert.deepEqual(denCalls, [{ token: "token_123", organizationId: "org_1", limit: 100 }]);
  assert.deepEqual(gatewayCalls, [{ organizationId: "org_1", limit: 100 }]);
  assert.equal(result.status, 200);
  assert.deepEqual((result.body as { events: Array<{ id: string; source: string }> }).events.map(({ id, source }) => ({ id, source })), [
    { id: "den:den_new", source: "den" },
    { id: "ai-gateway:gateway_middle", source: "ai-gateway" },
  ]);
});

test("organization audit facade preserves exact DEN errors and does not return partial Gateway data", async () => {
  let gatewayReads = 0;
  const service = createDefaultAdminService("https://den.example.test", {
    denClient: {
      async listOrganizationAudit() {
        return { status: 403, body: { error: "organization_forbidden", detail: "DEN owns this decision" } };
      },
    } as never,
    auditRepository: {
      async recordEvent() {},
      async listEvents() {
        gatewayReads += 1;
        return [event("gateway", "2026-07-12T11:00:00.000Z", "user.ai_access.update")];
      },
    },
  });

  assert.deepEqual(await service.listOrganizationAudit!("token_123", "org_1", 20), {
    status: 403,
    body: { error: "organization_forbidden", detail: "DEN owns this decision" },
  });
  assert.equal(gatewayReads, 0);
});

test("organization audit facade fails closed when the Gateway source is unavailable", async () => {
  const service = createDefaultAdminService("https://den.example.test", {
    denClient: {
      async listOrganizationAudit() {
        return { status: 200, body: { events: [event("den", "2026-07-12T12:00:00.000Z", "organization.update")] } };
      },
    } as never,
    auditRepository: {
      async recordEvent() {},
      async listEvents() {
        throw new Error("gateway audit unavailable");
      },
    },
  });

  await assert.rejects(
    service.listOrganizationAudit!("token_123", "org_1", 20),
    /gateway audit unavailable/,
  );
});

test("organization audit facade strips unexpected DEN fields and rejects malformed success payloads", async () => {
  const valid = event("den", "2026-07-12T12:00:00.000Z", "organization.update");
  let body: unknown = { events: [{ ...valid, payload: { apiKey: "must-not-cross" } }] };
  const service = createDefaultAdminService("https://den.example.test", {
    denClient: {
      async listOrganizationAudit() { return { status: 200, body }; },
    } as never,
    auditRepository: {
      async recordEvent() {},
      async listEvents() { return []; },
    },
  });

  const validResult = await service.listOrganizationAudit!("token_123", "org_1", 20);
  const returned = (validResult.body as { events: Array<Record<string, unknown>> }).events[0]!;
  assert.equal(Object.hasOwn(returned, "payload"), false);
  assert.doesNotMatch(JSON.stringify(returned), /must-not-cross/);

  body = { events: [{ id: "incomplete" }] };
  await assert.rejects(
    service.listOrganizationAudit!("token_123", "org_1", 20),
    /organization_audit_den_response_invalid/,
  );
});
