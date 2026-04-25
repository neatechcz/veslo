import assert from "node:assert/strict";
import test from "node:test";

import type { AiGatewayDb } from "../src/db/index.js";
import { MySqlLeaseRepository } from "../src/leases/mysql-repository.js";
import type { CreateSessionLeaseInput } from "../src/leases/repository.js";

function createLeaseDb(options?: {
  readonly insertError?: unknown;
  readonly selectResults?: readonly unknown[][];
}) {
  let insertedValues: unknown;
  let selectCalls = 0;
  const selectResults = options?.selectResults ?? [[]];

  return {
    db: {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    const result = selectResults[Math.min(selectCalls, selectResults.length - 1)] ?? [];
                    selectCalls++;
                    return result;
                  },
                };
              },
            };
          },
        };
      },
      insert() {
        return {
          async values(values: unknown) {
            insertedValues = values;
            if (options?.insertError) {
              throw options.insertError;
            }
          },
        };
      },
    },
    insertedValues() {
      return insertedValues;
    },
    selectCalls() {
      return selectCalls;
    },
  };
}

test("creates session lease ids that fit the database id column for DEN users", async () => {
  const fakeDb = createLeaseDb();
  const repository = new MySqlLeaseRepository(fakeDb.db as AiGatewayDb);
  const input: CreateSessionLeaseInput = {
    ownerUserId: "YbEpnmkd7mDMY6S6WM3CS7YYWK1TO85u",
    provider: "openai",
    sessionId: "probe-openai-1776003793652",
    activeBindingId: "binding_openai_platform",
  };

  const lease = await repository.createLeaseIfMissing(input);
  const inserted = fakeDb.insertedValues() as { id: string };

  assert.equal(lease.id, inserted.id);
  assert.ok(inserted.id.length <= 64, `${inserted.id} has length ${inserted.id.length}`);
  assert.match(inserted.id, /^lease_openai_/);
  assert.doesNotMatch(inserted.id, /YbEpnmkd7mDMY6S6WM3CS7YYWK1TO85u/);
  assert.doesNotMatch(inserted.id, /probe-openai-1776003793652/);
});

test("returns the winning lease when create loses a duplicate-key race", async () => {
  const input: CreateSessionLeaseInput = {
    ownerUserId: "YbEpnmkd7mDMY6S6WM3CS7YYWK1TO85u",
    provider: "codex_oauth",
    sessionId: "opencode-session-1776233512872",
    activeBindingId: "binding_codex_oauth_worker",
  };
  const winningLeaseRow = {
    id: "lease_codex_winner",
    owner_user_id: input.ownerUserId,
    provider: input.provider,
    session_id: input.sessionId,
    active_binding_id: "binding_codex_oauth_worker",
    created_at: new Date("2026-04-15T06:13:01.000Z"),
    updated_at: new Date("2026-04-15T06:13:01.000Z"),
  };
  const duplicateEntryError = Object.assign(new Error("Failed query: insert into session_lease"), {
    cause: Object.assign(
      new Error(
        "Duplicate entry 'opencode-session-1776233512872-codex_oauth' for key 'session_lease.session_lease_session_provider'",
      ),
      {
        code: "ER_DUP_ENTRY",
        errno: 1062,
      },
    ),
  });
  const fakeDb = createLeaseDb({
    insertError: duplicateEntryError,
    selectResults: [[], [winningLeaseRow]],
  });
  const repository = new MySqlLeaseRepository(fakeDb.db as AiGatewayDb);

  const lease = await repository.createLeaseIfMissing(input);

  assert.equal(lease.id, "lease_codex_winner");
  assert.equal(lease.ownerUserId, input.ownerUserId);
  assert.equal(lease.provider, input.provider);
  assert.equal(lease.sessionId, input.sessionId);
  assert.equal(lease.activeBindingId, "binding_codex_oauth_worker");
  assert.equal(fakeDb.selectCalls(), 2);
});
