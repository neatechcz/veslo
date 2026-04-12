import assert from "node:assert/strict";
import test from "node:test";

import type { AiGatewayDb } from "../src/db/index.js";
import { MySqlLeaseRepository } from "../src/leases/mysql-repository.js";
import type { CreateSessionLeaseInput } from "../src/leases/repository.js";

function createEmptyLeaseDb() {
  let insertedValues: unknown;

  return {
    db: {
      select() {
        return {
          from() {
            return {
              where() {
                return {
                  async limit() {
                    return [];
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
          },
        };
      },
    },
    insertedValues() {
      return insertedValues;
    },
  };
}

test("creates session lease ids that fit the database id column for DEN users", async () => {
  const fakeDb = createEmptyLeaseDb();
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
