import assert from "node:assert/strict";
import test from "node:test";

import type { AiGatewayDb } from "../src/db/index.js";
import {
  AiAccessAuditPersistenceError,
  AiAccessProviderMismatchError,
  MySqlAiAccessMutation,
} from "../src/access/mysql-repository.js";
import { platformModelPolicyTable, userAiAccessPolicyTable } from "../src/db/schema.js";

type StoredRow = Record<string, unknown>;

function createTransactionalAiAccessDb(options: {
  initialRow?: StoredRow | null;
  failAudit?: boolean;
  activeProvider?: string | null;
} = {}) {
  let row = options.initialRow ?? null;
  const activeProvider = options.activeProvider ?? "codex_oauth";
  const policyWrites: Array<{ kind: "insert" | "update"; values: StoredRow }> = [];
  const auditWrites: StoredRow[] = [];
  const lockedTables: string[] = [];
  let transactionCount = 0;

  const tx = {
    select() {
      return {
        from(table: unknown) {
          return {
            where() {
              return {
                limit() {
                  return {
                    async for() {
                      if (table === platformModelPolicyTable) {
                        lockedTables.push("platform_model_policy:update");
                        return activeProvider
                          ? [{ activeProvider }]
                          : [];
                      }
                      if (table === userAiAccessPolicyTable) {
                        lockedTables.push("user_ai_access_policy:update");
                        return row ? [row] : [];
                      }
                      throw new Error("unexpected select table");
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
    lockedTables,
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
  assert.deepEqual(writable.lockedTables.slice(0, 2), [
    "platform_model_policy:update",
    "user_ai_access_policy:update",
  ]);
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

test("admin AI-access mutation rejects enabled assignments that race against a changed active provider", async () => {
  const writable = createTransactionalAiAccessDb({ activeProvider: "openai_compatible" });
  const mutation = new MySqlAiAccessMutation(writable.db);

  await assert.rejects(
    mutation.upsertUserAiAccessWithAudit({
      actorUserId: "admin_real",
      organizationId: "org_123",
      userId: "user_123",
      enabled: true,
      provider: "codex_oauth",
      credentialId: "cred_codex",
      assignmentOrigin: "admin_assigned",
    }),
    (error: unknown) => error instanceof AiAccessProviderMismatchError
      && error.message === "ai_access_provider_mismatch"
      && (error as { status?: number }).status === 409,
  );

  assert.equal(writable.transactionCount, 1);
  assert.deepEqual(writable.lockedTables, ["platform_model_policy:update"]);
  assert.deepEqual(writable.policyWrites, []);
  assert.deepEqual(writable.auditWrites, []);
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
