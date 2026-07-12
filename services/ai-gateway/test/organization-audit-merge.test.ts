import assert from "node:assert/strict";
import test from "node:test";

import { mergeOrganizationAuditEvents } from "../src/audit/organization-audit.js";

const event = (id: string, timestamp: string, action: string) => ({
  id,
  timestamp,
  actor: `actor_${id}`,
  action,
  entityType: "organization",
  entityId: "org_1",
  result: "ok" as const,
  summary: action,
  changedFields: [],
});

test("organization audit merge labels sources, uses stable composite ids, orders newest first, and applies final limit", () => {
  const result = mergeOrganizationAuditEvents({
    denEvents: [
      event("den_old", "2026-07-12T09:00:00.000Z", "org.member.added"),
      event("den_new", "2026-07-12T12:00:00.000Z", "admin.billing.plan.updated"),
    ],
    gatewayEvents: [
      event("gateway_middle", "2026-07-12T11:00:00.000Z", "user.ai_access.update"),
      event("gateway_old", "2026-07-12T08:00:00.000Z", "legacy.gateway.event"),
    ],
    limit: 3,
  });

  assert.deepEqual(result, [
    { ...event("den_new", "2026-07-12T12:00:00.000Z", "admin.billing.plan.updated"), id: "den:den_new", source: "den" },
    { ...event("gateway_middle", "2026-07-12T11:00:00.000Z", "user.ai_access.update"), id: "ai-gateway:gateway_middle", source: "ai-gateway" },
    { ...event("den_old", "2026-07-12T09:00:00.000Z", "org.member.added"), id: "den:den_old", source: "den" },
  ]);
});

test("organization audit merge has deterministic ordering for equal timestamps", () => {
  const timestamp = "2026-07-12T12:00:00.000Z";

  const result = mergeOrganizationAuditEvents({
    denEvents: [event("z", timestamp, "den.event")],
    gatewayEvents: [event("a", timestamp, "gateway.event")],
    limit: 1000,
  });

  assert.deepEqual(result.map((entry) => entry.id), ["ai-gateway:a", "den:z"]);
  assert.equal(result.length, 2);
});
