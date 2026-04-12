import { sql } from "drizzle-orm";
import { index, int, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

const idColumn = () => varchar("id", { length: 64 }).notNull();

const timestamps = {
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
};

export const CoreTableNames = {
  credential_record: "credential_record",
  credential_secret: "credential_secret",
  credential_binding: "credential_binding",
  session_lease: "session_lease",
  credential_health_event: "credential_health_event",
  credential_usage_event: "credential_usage_event",
  audit_event: "ai_gateway_audit_event",
  user_ai_access_policy: "user_ai_access_policy",
} as const;

export const CredentialType = ["api_key", "oauth"] as const;
export const CredentialState = ["healthy", "degraded", "draining", "unhealthy", "revoked"] as const;

export type CredentialType = (typeof CredentialType)[number];
export type CredentialState = (typeof CredentialState)[number];

export const credentialRecordTable = mysqlTable(
  CoreTableNames.credential_record,
  {
    id: idColumn().primaryKey(),
    name: varchar("name", { length: 255 }),
    owner_user_id: varchar("owner_user_id", { length: 64 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    credential_type: mysqlEnum("credential_type", CredentialType).notNull(),
    state: mysqlEnum("state", CredentialState).notNull(),
    secret_ref: varchar("secret_ref", { length: 255 }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("credential_record_owner_provider_state").on(table.owner_user_id, table.provider, table.state),
  ],
);

export const credentialSecretTable = mysqlTable(
  CoreTableNames.credential_secret,
  {
    secret_ref: varchar("secret_ref", { length: 255 }).primaryKey(),
    iv: text("iv").notNull(),
    auth_tag: text("auth_tag").notNull(),
    ciphertext: text("ciphertext").notNull(),
    ...timestamps,
  },
);

export const credentialBindingTable = mysqlTable(
  CoreTableNames.credential_binding,
  {
    id: idColumn().primaryKey(),
    owner_user_id: varchar("owner_user_id", { length: 64 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    credential_record_id: varchar("credential_record_id", { length: 64 }).notNull(),
    ...timestamps,
  },
  (table) => [
    index("credential_binding_owner_provider").on(table.owner_user_id, table.provider),
    index("credential_binding_credential_record_id").on(table.credential_record_id),
  ],
);

export const sessionLeaseTable = mysqlTable(
  CoreTableNames.session_lease,
  {
    id: idColumn().primaryKey(),
    owner_user_id: varchar("owner_user_id", { length: 64 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    session_id: varchar("session_id", { length: 64 }).notNull(),
    active_binding_id: varchar("active_binding_id", { length: 64 }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("session_lease_session_provider").on(table.session_id, table.provider),
    index("session_lease_owner_provider").on(table.owner_user_id, table.provider),
    index("session_lease_active_binding_id").on(table.active_binding_id),
  ],
);

export const credentialHealthEventTable = mysqlTable(
  CoreTableNames.credential_health_event,
  {
    id: idColumn().primaryKey(),
    credential_record_id: varchar("credential_record_id", { length: 64 }).notNull(),
    from_state: mysqlEnum("from_state", CredentialState),
    to_state: mysqlEnum("to_state", CredentialState).notNull(),
    reason: text("reason"),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [index("credential_health_event_credential_record_id").on(table.credential_record_id)],
);

export const credentialUsageEventTable = mysqlTable(
  CoreTableNames.credential_usage_event,
  {
    id: idColumn().primaryKey(),
    owner_user_id: varchar("owner_user_id", { length: 64 }).notNull(),
    provider: varchar("provider", { length: 64 }).notNull(),
    credential_record_id: varchar("credential_record_id", { length: 64 }).notNull(),
    credential_binding_id: varchar("credential_binding_id", { length: 64 }).notNull(),
    session_id: varchar("session_id", { length: 64 }).notNull(),
    request_id: varchar("request_id", { length: 64 }).notNull(),
    model: varchar("model", { length: 128 }).notNull(),
    input_tokens: int("input_tokens").notNull().default(0),
    output_tokens: int("output_tokens").notNull().default(0),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("credential_usage_event_request_id").on(table.request_id),
    index("credential_usage_event_owner_provider").on(table.owner_user_id, table.provider),
    index("credential_usage_event_binding_id").on(table.credential_binding_id),
  ],
);

export const auditEventTable = mysqlTable(
  CoreTableNames.audit_event,
  {
    id: idColumn().primaryKey(),
    actor_user_id: varchar("actor_user_id", { length: 64 }),
    entity_type: varchar("entity_type", { length: 64 }).notNull(),
    entity_id: varchar("entity_id", { length: 64 }).notNull(),
    action: varchar("action", { length: 64 }).notNull(),
    result: varchar("result", { length: 32 }).notNull(),
    summary: text("summary"),
    created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  },
  (table) => [
    index("audit_event_entity").on(table.entity_type, table.entity_id),
    index("audit_event_actor").on(table.actor_user_id),
    index("audit_event_action").on(table.action),
  ],
);

export const userAiAccessPolicyTable = mysqlTable(
  CoreTableNames.user_ai_access_policy,
  {
    id: idColumn().primaryKey(),
    user_id: varchar("user_id", { length: 64 }).notNull(),
    enabled: int("enabled").notNull().default(1),
    provider: varchar("provider", { length: 64 }),
    default_model: varchar("default_model", { length: 128 }),
    allowed_models_json: text("allowed_models_json").notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("user_ai_access_policy_user_id").on(table.user_id),
    index("user_ai_access_policy_provider").on(table.provider),
  ],
);
