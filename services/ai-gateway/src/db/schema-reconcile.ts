type SchemaReconcileDb = {
  query(query: string, values?: readonly unknown[]): Promise<unknown>;
};

const identifierPattern = /^[a-zA-Z0-9_]+$/;

function quoteIdentifier(value: string) {
  if (!identifierPattern.test(value)) {
    throw new Error(`Invalid SQL identifier: ${value}`);
  }
  return `\`${value}\``;
}

function extractRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    if (Array.isArray(value[0])) {
      return value[0] as Array<Record<string, unknown>>;
    }
    return value as Array<Record<string, unknown>>;
  }

  if (value && typeof value === "object") {
    const maybeRows = (value as { rows?: unknown }).rows;
    if (Array.isArray(maybeRows)) {
      return maybeRows as Array<Record<string, unknown>>;
    }
  }

  return [];
}

async function ensureIndex(db: SchemaReconcileDb, table: string, indexName: string, columns: string[], unique = false) {
  const existing = await db.query(`
    SELECT 1
    FROM INFORMATION_SCHEMA.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND INDEX_NAME = ?
    LIMIT 1
  `, [table, indexName]);

  if (extractRows(existing).length > 0) {
    return;
  }

  const columnList = columns.map((column) => quoteIdentifier(column)).join(", ");
  const createKeyword = unique ? "CREATE UNIQUE INDEX" : "CREATE INDEX";
  await db.query(`${createKeyword} ${quoteIdentifier(indexName)} ON ${quoteIdentifier(table)} (${columnList})`);
}

async function ensureColumn(db: SchemaReconcileDb, table: string, columnName: string, columnDefinition: string) {
  const existing = await db.query(`
    SELECT 1
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_SCHEMA = DATABASE()
      AND TABLE_NAME = ?
      AND COLUMN_NAME = ?
    LIMIT 1
  `, [table, columnName]);

  if (extractRows(existing).length > 0) {
    return;
  }

  await db.query(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(columnName)} ${columnDefinition}`);
}

export async function ensureAiGatewaySchema(db: SchemaReconcileDb) {
  await db.query(`
    CREATE TABLE IF NOT EXISTS \`user_ai_access_policy\` (
      \`id\` varchar(64) NOT NULL PRIMARY KEY,
      \`user_id\` varchar(64) NOT NULL,
      \`enabled\` int NOT NULL DEFAULT 1,
      \`provider\` varchar(64),
      \`default_model\` varchar(128),
      \`allowed_models_json\` text NOT NULL,
      \`created_at\` timestamp(3) NOT NULL,
      \`updated_at\` timestamp(3) NOT NULL,
      UNIQUE KEY \`user_ai_access_policy_user_id\` (\`user_id\`)
    )
  `);

  await ensureIndex(db, "user_ai_access_policy", "user_ai_access_policy_provider", ["provider"]);
  await ensureColumn(db, "credential_record", "name", "varchar(255)");
}
