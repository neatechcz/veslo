import { ManagedAiTableNames } from "../schema.js"

/**
 * Den reads and writes the managed-AI audit table, but does not own its schema:
 * `ai_gateway_audit_event` is created by the AI Gateway migrations. Den also
 * accepts an optional `MANAGED_AI_DATABASE_URL`, so it can legitimately be
 * pointed at a database those migrations never touched.
 *
 * That combination has exactly one dangerous failure mode: the monitor keeps
 * running and every audit read or write fails with a raw driver error that says
 * nothing about deployment order. Converting it into an explicit, named failure
 * is the difference between "unknown outage" and "apply the AI Gateway
 * migration to this database".
 */

export const MANAGED_AI_AUDIT_TABLE = ManagedAiTableNames.audit_event

export const MANAGED_AI_AUDIT_SCHEMA_UNAVAILABLE =
  "managed_ai_audit_schema_unavailable"

const MYSQL_ER_NO_SUCH_TABLE = 1146

export function isMissingAuditTableError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false
  const candidate = error as { code?: unknown; errno?: unknown; message?: unknown }
  if (candidate.code === "ER_NO_SUCH_TABLE") return true
  if (candidate.errno === MYSQL_ER_NO_SUCH_TABLE) return true
  return (
    typeof candidate.message === "string" &&
    candidate.message.includes(MANAGED_AI_AUDIT_TABLE) &&
    /doesn't exist|does not exist|unknown table/i.test(candidate.message)
  )
}

export class ManagedAiAuditSchemaUnavailableError extends Error {
  readonly code = MANAGED_AI_AUDIT_SCHEMA_UNAVAILABLE
  readonly table = MANAGED_AI_AUDIT_TABLE

  constructor(cause: unknown) {
    super(
      `${MANAGED_AI_AUDIT_SCHEMA_UNAVAILABLE}: table \`${MANAGED_AI_AUDIT_TABLE}\` is missing from the managed-AI database. ` +
        "It is owned by the AI Gateway migrations; apply them to this exact database before enabling managed AI.",
    )
    this.name = "ManagedAiAuditSchemaUnavailableError"
    this.cause = cause
  }
}

/** Fail closed with an actionable name instead of a raw driver error. */
export async function withManagedAiAuditSchema<T>(
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation()
  } catch (error) {
    if (isMissingAuditTableError(error)) {
      throw new ManagedAiAuditSchemaUnavailableError(error)
    }
    throw error
  }
}
