import assert from "node:assert/strict";
import test from "node:test";

import type { AiGatewayDb } from "../src/db/index.js";
import {
  AiAccessAuditPersistenceError,
  MySqlAiAccessMutation,
} from "../src/access/mysql-repository.js";

type StoredRow = Record<string, unknown>;

function createTransactionalAiAccessDb(options: {
  initialRow?: StoredRow | null;
  failAudit?: boolean;
} = {}) {
  let row = options.initialRow ?? null;
  const policyWrites: Array<{ kind: "insert" | "update"; values: StoredRow }> = [];
  const auditWrites: StoredRow[] = [];
  let transactionCount = 0;

  const tx = {
    select() {
      return {
        from() {
          return {
            where() {
              return {
                limit() {
                  return {
                    async for() {
                      return row ? [row] : [];
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        async values(values: StoredRow) {
          if (Object.hasOwn(values, "actor_user_id")) {
            if (options.failAudit) throw new Error("audit insert failed");
            auditWrites.push(values);
            return;
          }
          policyWrites.push({ kind: "insert", values });
          row = values;
        },
      };
    },
    update() {
      return {
        set(values: StoredRow) {
          policyWrites.push({ kind: "update", values });
          row = { ...(row ?? {}), ...values };
          return {
            async where() {},
          };
        },
      };
    },
  };

  return {
    policyWrites,
    auditWrites,
    get transactionCount() {
      return transactionCount;
    },
    db: {
      async transaction(callback: (transaction: unknown) => Promise<unknown>) {
        transactionCount += 1;
        return callback(tx);
      },
    } as AiGatewayDb,
  };
}

test("admin AI-access mutation writes policy and real-actor organization audit in one transaction", async () => {
  const writable = createTransactionalAiAccessDb();
  const mutation = new MySqlAiAccessMutation(writable.db);

  const saved = await mutation.upsertUserAiAccessWithAudit({
    actorUserId: "admin_real",
    organizationId: "org_123",
    userId: "user_123",
    enabled: true,
    provider: "codex_oauth",
    credentialId: "cred_secretish",
    assignmentOrigin: "admin_assigned",
  });

  assert.equal(writable.transactionCount, 1);
  assert.equal(writable.policyWrites.length, 1);
  assert.equal(saved.userId, "user_123");
  assert.equal(writable.auditWrites.length, 1);
  assert.deepEqual(writable.auditWrites[0], {
    id: writable.auditWrites[0]?.id,
    actor_user_id: "admin_real",
    organization_id: "org_123",
    entity_type: "user",
    entity_id: "user_123",
    action: "user.ai_access.update",
    result: "ok",
    summary: "Updated AI access for user user_123.",
    created_at: saved.updatedAt,
  });
  assert.doesNotMatch(JSON.stringify(writable.auditWrites[0]), /cred_secretish/);
});

test("admin AI-access mutation fails closed with a typed error when audit persistence fails", async () => {
  const writable = createTransactionalAiAccessDb({ failAudit: true });
  const mutation = new MySqlAiAccessMutation(writable.db);

  await assert.rejects(
    mutation.upsertUserAiAccessWithAudit({
      actorUserId: "admin_real",
      organizationId: "org_123",
      userId: "user_123",
      enabled: false,
      provider: null,
      credentialId: null,
      assignmentOrigin: "admin_assigned",
    }),
    (error: unknown) => error instanceof AiAccessAuditPersistenceError
      && error.message === "user_ai_access_audit_failed",
  );
  assert.equal(writable.transactionCount, 1);
});
