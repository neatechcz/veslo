import express from "express"
import { eq } from "drizzle-orm"
import { fromNodeHeaders } from "better-auth/node"
import { auth } from "../auth.js"
import { db } from "../db/index.js"
import { AdminUserStateTable } from "../db/schema.js"
import { env } from "../env.js"
import { enforceSessionPolicy } from "./email-verification.js"
import type { SessionContext } from "./session-context.js"

export type { SessionContext } from "./session-context.js"

export async function requireSession(req: express.Request, res: express.Response): Promise<SessionContext | null> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  })

  if (!session?.user?.id) {
    res.status(401).json({ error: "unauthorized" })
    return null
  }

  const context: SessionContext = {
    user: {
      id: session.user.id,
      email: typeof session.user.email === "string" ? session.user.email : null,
      emailVerified: session.user.emailVerified === true,
      name: typeof session.user.name === "string" ? session.user.name : null,
    },
  }

  const userState = await db
    .select({
      disabled: AdminUserStateTable.disabled,
    })
    .from(AdminUserStateTable)
    .where(eq(AdminUserStateTable.user_id, session.user.id))
    .limit(1)

  if (!enforceSessionPolicy(res, context, {
    disabled: userState[0]?.disabled === true,
    requireEmailVerification: env.authRequireEmailVerification,
  })) {
    return null
  }

  return context
}
