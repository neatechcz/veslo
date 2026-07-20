import assert from "node:assert/strict";
import test from "node:test";

import { MySqlSecretStore } from "../src/credentials/mysql-secret-store.js";
import type { AiGatewayDb } from "../src/db/index.js";

type SecretRow = {
  secret_ref: string;
  iv: string;
  auth_tag: string;
  ciphertext: string;
  created_at: Date;
  updated_at: Date;
};

function createPersistentSecretDb() {
  const rows = new Map<string, SecretRow>();

  const db = {
    insert() {
      return {
        async values(row: SecretRow) {
          rows.set(row.secret_ref, row);
        },
      };
    },
    select() {
      return {
        from() {
          return {
            where() {
              return {
                async limit() {
                  const row = rows.values().next().value as SecretRow | undefined;
                  return row ? [row] : [];
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: Partial<SecretRow>) {
          return {
            async where() {
              const row = rows.values().next().value as SecretRow | undefined;
              if (row) {
                rows.set(row.secret_ref, { ...row, ...values });
              }
            },
          };
        },
      };
    },
  } as unknown as AiGatewayDb;

  return {
    db,
    readEncryptedRow(secretRef: string) {
      return rows.get(secretRef) ?? null;
    },
  };
}

test("uploaded Codex auth remains readable after secret-store reconstruction", async () => {
  const persistentDb = createPersistentSecretDb();
  const secretKey = "test_secret_key_32_bytes_minimum____";
  const initialStore = new MySqlSecretStore(persistentDb.db, secretKey);
  const initial = await initialStore.put({
    kind: "codex_auth_json",
    authJson: JSON.stringify({ refresh_token: "initial-refresh-token" }),
  });
  const uploadedAuth = {
    kind: "codex_auth_json" as const,
    authJson: JSON.stringify({ refresh_token: "uploaded-refresh-token" }),
  };

  await initialStore.replace(initial.secretRef, uploadedAuth);

  const reconstructedStore = new MySqlSecretStore(persistentDb.db, secretKey);
  assert.deepEqual(await reconstructedStore.get(initial.secretRef), uploadedAuth);
  assert.doesNotMatch(
    JSON.stringify(persistentDb.readEncryptedRow(initial.secretRef)),
    /uploaded-refresh-token/,
  );
});
