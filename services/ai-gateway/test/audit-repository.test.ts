import assert from "node:assert/strict";
import test from "node:test";

import { createAuditEventId } from "../src/audit/mysql-repository.js";

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
