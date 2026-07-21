import { eq } from "drizzle-orm"
import { db } from "../db/index.js"
import { AdminUserStateTable, AuthUserTable } from "../db/schema.js"
import { evaluateSessionPolicy, type SessionPolicyRejection } from "./email-verification.js"
import type { SessionContext } from "./session-context.js"

type DenTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

export type DesktopExchangePolicySubject = {
  user: SessionContext["user"]
  disabled: boolean
}

type DesktopExchangePolicyInput = {
  requireEmailVerification: boolean
} & (
  | { loadSubject: () => Promise<DesktopExchangePolicySubject | null> }
  | { tx: DenTransaction; userId: string }
)

export type DesktopExchangePolicyFailure =
  | { ok: false; kind: "user_not_found" }
  | ({ ok: false; kind: "policy" } & SessionPolicyRejection)

async function loadPersistedSubject(
  tx: DenTransaction,
  userId: string,
): Promise<DesktopExchangePolicySubject | null> {
  const userRows = await tx
    .select({
      id: AuthUserTable.id,
      email: AuthUserTable.email,
      emailVerified: AuthUserTable.emailVerified,
      name: AuthUserTable.name,
    })
    .from(AuthUserTable)
    .where(eq(AuthUserTable.id, userId))
    .limit(1)

  const user = userRows[0]
  if (!user) return null

  const userStateRows = await tx
    .select({ disabled: AdminUserStateTable.disabled })
    .from(AdminUserStateTable)
    .where(eq(AdminUserStateTable.user_id, userId))
    .limit(1)

  return {
    user: {
      id: user.id,
      email: user.email,
      emailVerified: user.emailVerified === true,
      name: user.name,
    },
    disabled: userStateRows[0]?.disabled === true,
  }
}

export async function continueDesktopExchangeAfterUserPolicy<T>(
  input: DesktopExchangePolicyInput,
  continueExchange: () => Promise<T>,
): Promise<T | DesktopExchangePolicyFailure> {
  const subject = "loadSubject" in input
    ? await input.loadSubject()
    : await loadPersistedSubject(input.tx, input.userId)

  if (!subject) {
    return { ok: false, kind: "user_not_found" }
  }

  const rejection = evaluateSessionPolicy(
    { user: subject.user },
    {
      disabled: subject.disabled,
      requireEmailVerification: input.requireEmailVerification,
    },
  )
  if (rejection) {
    return { ok: false, kind: "policy", ...rejection }
  }

  return continueExchange()
}
