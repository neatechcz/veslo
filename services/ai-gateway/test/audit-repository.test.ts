import assert from "node:assert/strict";
import test from "node:test";

import { createAuditEventId, MySqlAuditRepository } from "../src/audit/mysql-repository.js";

test("createAuditEventId stays within the audit_event.id column limit", () => {
  const id = createAuditEventId({
    actorUserId: "vaclav.soukup@neatec.cz",
    entityType: "credential",
    entityId: "cred_4dc1ceda-2f85-4a28-a15b-0507a33cdb51",
    action: "credential.drain",
    result: "warning",
    summary: "Draining credential for new assignments.",
  });

  assert.ok(id.startsWith("audit_"));
  assert.ok(id.length <= 64, `expected audit id <= 64 chars, got ${id.length}: ${id}`);
});

test("audit repository persists organization scope and applies it before limiting", async () => {
  const inserts: Array<Record<string, unknown>> = [];
  let whereCalled = false;
  const rows = [{
    id: "audit_org_1",
    actor_user_id: "admin_1",
    organization_id: "org_1",
    entity_type: "user",
    entity_id: "user_1",
    action: "organization.member.update",
    result: "ok",
    summary: "Updated membership.",
    created_at: new Date("2026-07-12T12:00:00.000Z"),
  }];
  const db = {
    insert() {
      return { async values(value: Record<string, unknown>) { inserts.push(value); } };
    },
    select() {
      return {
        from() {
          return {
            where() {
              whereCalled = true;
              return { orderBy() { return { async limit() { return rows; } }; } };
            },
          };
        },
      };
    },
  };
  const repository = new MySqlAuditRepository(db as any);
  await repository.recordEvent({
    actorUserId: "admin_1",
    organizationId: "org_1",
    entityType: "user",
    entityId: "user_1",
    action: "organization.member.update",
    result: "ok",
  });
  assert.equal(inserts[0]?.organization_id, "org_1");
  const events = await repository.listEvents({ limit: 100, organizationId: "org_1" });
  assert.equal(whereCalled, true);
  assert.equal(events[0]?.organizationId, "org_1");
});
