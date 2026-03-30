import { sql } from "drizzle-orm";
import { index, mysqlEnum, mysqlTable, text, timestamp, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

const idColumn = () => varchar("id", { length: 64 }).notNull();

const timestamps = {
  created_at: timestamp("created_at", { fsp: 3 }).notNull().defaultNow(),
  updated_at: timestamp("updated_at", { fsp: 3 })
    .notNull()
    .default(sql`CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)`),
};

export const CoreTableNames = {
  credential_record: "credential_record",
  credential_binding: "credential_binding",
  session_lease: "session_lease",
  credential_health_event: "credential_health_event",
} as const;

export const CredentialType = ["api_key", "oauth"] as const;
export const CredentialState = ["healthy", "degraded", "draining", "unhealthy", "revoked"] as const;

export type CredentialType = (typeof CredentialType)[number];
export type CredentialState = (typeof CredentialState)[number];

export const credentialRecordTable = mysqlTable(
  CoreTableNames.credential_record,
  {
    id: idColumn().primaryKey(),
    provider: varchar("provider", { length: 64 }).notNull(),
    credential_type: mysqlEnum("credential_type", CredentialType).notNull(),
    state: mysqlEnum("state", CredentialState).notNull(),
    secret_ref: varchar("secret_ref", { length: 255 }).notNull(),
    ...timestamps,
  },
  (table) => [index("credential_record_provider_state").on(table.provider, table.state)],
);

export const credentialBindingTable = mysqlTable(
  CoreTableNames.credential_binding,
  {
    id: idColumn().primaryKey(),
    credential_record_id: varchar("credential_record_id", { length: 64 }).notNull(),
    ...timestamps,
  },
  (table) => [index("credential_binding_credential_record_id").on(table.credential_record_id)],
);

export const sessionLeaseTable = mysqlTable(
  CoreTableNames.session_lease,
  {
    id: idColumn().primaryKey(),
    session_id: varchar("session_id", { length: 64 }).notNull(),
    active_binding_id: varchar("active_binding_id", { length: 64 }).notNull(),
    ...timestamps,
  },
  (table) => [
    uniqueIndex("session_lease_session_id").on(table.session_id),
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
