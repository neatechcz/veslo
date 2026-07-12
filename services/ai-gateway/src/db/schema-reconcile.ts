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
    CREATE TABLE IF NOT EXISTS \`ai_gateway_audit_event\` (
      \`id\` varchar(64) NOT NULL PRIMARY KEY,
      \`actor_user_id\` varchar(64),
      \`entity_type\` varchar(64) NOT NULL,
      \`entity_id\` varchar(64) NOT NULL,
      \`action\` varchar(64) NOT NULL,
      \`result\` varchar(32) NOT NULL,
      \`summary\` text,
      \`created_at\` timestamp(3) NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS \`user_ai_access_policy\` (
      \`id\` varchar(64) NOT NULL PRIMARY KEY,
      \`user_id\` varchar(64) NOT NULL,
      \`enabled\` int NOT NULL DEFAULT 1,
      \`provider\` varchar(64),
      \`credential_id\` varchar(64),
      \`default_model\` varchar(128),
      \`allowed_models_json\` text NOT NULL,
      \`assignment_origin\` varchar(32) NOT NULL DEFAULT 'admin_assigned',
      \`created_at\` timestamp(3) NOT NULL,
      \`updated_at\` timestamp(3) NOT NULL,
      UNIQUE KEY \`user_ai_access_policy_user_id\` (\`user_id\`)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS \`platform_model_policy\` (
      \`id\` varchar(32) NOT NULL PRIMARY KEY,
      \`enabled_models_json\` text NOT NULL,
      \`active_provider\` varchar(64) NOT NULL,
      \`active_model\` varchar(128) NOT NULL,
      \`created_at\` timestamp(3) NOT NULL,
      \`updated_at\` timestamp(3) NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS \`credential_record\` (
      \`id\` varchar(64) NOT NULL PRIMARY KEY,
      \`name\` varchar(255),
      \`owner_user_id\` varchar(64) NOT NULL,
      \`provider\` varchar(64) NOT NULL,
      \`credential_type\` enum('api_key','oauth') NOT NULL,
      \`state\` enum('healthy','degraded','draining','unhealthy','revoked') NOT NULL,
      \`secret_ref\` varchar(255) NOT NULL,
      \`deleted_at\` timestamp(3) NULL,
      \`created_at\` timestamp(3) NOT NULL,
      \`updated_at\` timestamp(3) NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS \`credential_secret\` (
      \`secret_ref\` varchar(255) NOT NULL PRIMARY KEY,
      \`iv\` text NOT NULL,
      \`auth_tag\` text NOT NULL,
      \`ciphertext\` text NOT NULL,
      \`created_at\` timestamp(3) NOT NULL,
      \`updated_at\` timestamp(3) NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS \`credential_binding\` (
      \`id\` varchar(64) NOT NULL PRIMARY KEY,
      \`owner_user_id\` varchar(64) NOT NULL,
      \`provider\` varchar(64) NOT NULL,
      \`credential_record_id\` varchar(64) NOT NULL,
      \`created_at\` timestamp(3) NOT NULL,
      \`updated_at\` timestamp(3) NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS \`session_lease\` (
      \`id\` varchar(64) NOT NULL PRIMARY KEY,
      \`owner_user_id\` varchar(64) NOT NULL,
      \`provider\` varchar(64) NOT NULL,
      \`session_id\` varchar(64) NOT NULL,
      \`active_binding_id\` varchar(64) NOT NULL,
      \`created_at\` timestamp(3) NOT NULL,
      \`updated_at\` timestamp(3) NOT NULL,
      UNIQUE KEY \`session_lease_session_provider\` (\`session_id\`, \`provider\`)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS \`credential_health_event\` (
      \`id\` varchar(64) NOT NULL PRIMARY KEY,
      \`credential_record_id\` varchar(64) NOT NULL,
      \`from_state\` enum('healthy','degraded','draining','unhealthy','revoked'),
      \`to_state\` enum('healthy','degraded','draining','unhealthy','revoked') NOT NULL,
      \`reason\` text,
      \`created_at\` timestamp(3) NOT NULL
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS \`credential_usage_event\` (
      \`id\` varchar(64) NOT NULL PRIMARY KEY,
      \`owner_user_id\` varchar(64) NOT NULL,
      \`org_id\` varchar(64),
      \`provider\` varchar(64) NOT NULL,
      \`credential_record_id\` varchar(64) NOT NULL,
      \`credential_binding_id\` varchar(64) NOT NULL,
      \`session_id\` varchar(64) NOT NULL,
      \`request_id\` varchar(64) NOT NULL,
      \`model\` varchar(128) NOT NULL,
      \`input_tokens\` int NOT NULL DEFAULT 0,
      \`output_tokens\` int NOT NULL DEFAULT 0,
      \`cached_tokens\` int NOT NULL DEFAULT 0,
      \`total_tokens\` int NOT NULL DEFAULT 0,
      \`created_at\` timestamp(3) NOT NULL,
      UNIQUE KEY \`credential_usage_event_request_id\` (\`request_id\`)
    )
  `);

  await ensureIndex(db, "ai_gateway_audit_event", "audit_event_entity", ["entity_type", "entity_id"]);
  await ensureIndex(db, "ai_gateway_audit_event", "audit_event_actor", ["actor_user_id"]);
  await ensureIndex(db, "ai_gateway_audit_event", "audit_event_action", ["action"]);
  await ensureIndex(db, "user_ai_access_policy", "user_ai_access_policy_provider", ["provider"]);
  await ensureColumn(db, "user_ai_access_policy", "credential_id", "varchar(64)");
  await ensureColumn(db, "user_ai_access_policy", "assignment_origin", "varchar(32) NOT NULL DEFAULT 'admin_assigned'");
  await ensureColumn(db, "credential_record", "name", "varchar(255)");
  await ensureColumn(db, "credential_record", "deleted_at", "timestamp(3) NULL");
  await ensureIndex(db, "credential_record", "credential_record_owner_provider_state", [
    "owner_user_id",
    "provider",
    "state",
  ]);
  await ensureIndex(db, "credential_binding", "credential_binding_owner_provider", ["owner_user_id", "provider"]);
  await ensureIndex(db, "credential_binding", "credential_binding_credential_record_id", ["credential_record_id"]);
  await ensureIndex(db, "session_lease", "session_lease_owner_provider", ["owner_user_id", "provider"]);
  await ensureIndex(db, "session_lease", "session_lease_active_binding_id", ["active_binding_id"]);
  await ensureIndex(db, "credential_health_event", "credential_health_event_credential_record_id", [
    "credential_record_id",
  ]);
  await ensureColumn(db, "credential_usage_event", "org_id", "varchar(64)");
  await ensureColumn(db, "credential_usage_event", "cached_tokens", "int NOT NULL DEFAULT 0");
  await ensureColumn(db, "credential_usage_event", "total_tokens", "int NOT NULL DEFAULT 0");
  await db.query(`
    UPDATE \`credential_usage_event\`
    SET \`total_tokens\` = \`input_tokens\` + \`output_tokens\`
    WHERE \`total_tokens\` = 0
  `);
  await ensureIndex(db, "credential_usage_event", "credential_usage_event_owner_provider", ["owner_user_id", "provider"]);
  await ensureIndex(db, "credential_usage_event", "credential_usage_event_binding_id", ["credential_binding_id"]);
  await ensureIndex(db, "credential_usage_event", "credential_usage_event_org_provider", ["org_id", "provider"]);
  await ensureIndex(db, "credential_usage_event", "credential_usage_event_credential_created", [
    "credential_record_id",
    "created_at",
  ]);
}
