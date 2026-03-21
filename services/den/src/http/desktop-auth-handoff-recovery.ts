import { sql } from "drizzle-orm"
import { db } from "../db/index.js"
import { DesktopAuthHandoffTable } from "../db/schema.js"

type DesktopAuthHandoffInsert = {
  id: string
  code: string
  sessionId: string | null
  userId: string
  orgId: string
  expiresAt: Date
  consumedAt: Date | null
  createdAt: Date
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function hasErrorCode(error: unknown, code: string): boolean {
  if (!isRecord(error)) {
    return false
  }

  if (error.code === code) {
    return true
  }

  return hasErrorCode(error.cause, code)
}

export async function withDesktopAuthHandoffSessionIdRecovery<T>(input: {
  run: () => Promise<T>
  repairSessionIdColumn: () => Promise<void>
}): Promise<T> {
  try {
    return await input.run()
  } catch (error) {
    if (!hasErrorCode(error, "ER_BAD_FIELD_ERROR")) {
      throw error
    }

    await input.repairSessionIdColumn()
    return input.run()
  }
}

let repairSessionIdColumnPromise: Promise<void> | null = null

async function ensureDesktopAuthHandoffSessionIdColumn() {
  if (repairSessionIdColumnPromise) {
    return repairSessionIdColumnPromise
  }

  repairSessionIdColumnPromise = (async () => {
    try {
      await db.execute(
        sql.raw("ALTER TABLE `desktop_auth_handoff` ADD COLUMN `session_id` varchar(64) NULL"),
      )
    } catch (error) {
      if (!hasErrorCode(error, "ER_DUP_FIELDNAME")) {
        throw error
      }
    }

    try {
      await db.execute(
        sql.raw(
          "CREATE INDEX `desktop_auth_handoff_session_id` ON `desktop_auth_handoff` (`session_id`)",
        ),
      )
    } catch (error) {
      if (!hasErrorCode(error, "ER_DUP_KEYNAME")) {
        throw error
      }
    }
  })()

  try {
    await repairSessionIdColumnPromise
  } finally {
    repairSessionIdColumnPromise = null
  }
}

export async function insertDesktopAuthHandoffRecord(input: DesktopAuthHandoffInsert): Promise<void> {
  await withDesktopAuthHandoffSessionIdRecovery({
    run: async () => {
      await db.insert(DesktopAuthHandoffTable).values({
        id: input.id,
        code: input.code,
        session_id: input.sessionId,
        user_id: input.userId,
        org_id: input.orgId,
        expires_at: input.expiresAt,
        consumed_at: input.consumedAt,
        created_at: input.createdAt,
      })
    },
    repairSessionIdColumn: ensureDesktopAuthHandoffSessionIdColumn,
  })
}
