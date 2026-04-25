import { fromNodeHeaders } from "better-auth/node"
import { eq } from "drizzle-orm"
import { auth } from "../../auth.js"
import { db } from "../../db/index.js"
import { AdminUserStateTable } from "../../db/schema.js"

export type UserSession = {
  token: string
  user: {
    id: string
    email?: string
    name?: string
  }
}

export interface UserSessionResolver {
  resolveSession(token: string): Promise<UserSession | null>
}

export class DenUserSessionResolver implements UserSessionResolver {
  async resolveSession(token: string): Promise<UserSession | null> {
    const trimmedToken = token.trim()
    if (!trimmedToken) {
      return null
    }

    const session = await auth.api.getSession({
      headers: fromNodeHeaders({
        authorization: `Bearer ${trimmedToken}`,
      }),
    })

    if (!session?.user?.id) {
      return null
    }

    const userState = await db
      .select({
        disabled: AdminUserStateTable.disabled,
      })
      .from(AdminUserStateTable)
      .where(eq(AdminUserStateTable.user_id, session.user.id))
      .limit(1)

    if (userState[0]?.disabled === true) {
      return null
    }

    const email = typeof session.user.email === "string" ? session.user.email.trim() : ""
    const name = typeof session.user.name === "string" ? session.user.name.trim() : ""

    return {
      token: trimmedToken,
      user: {
        id: session.user.id,
        email: email || undefined,
        name: name || undefined,
      },
    }
  }
}

export function readBearerToken(header: string | null | undefined): string | null {
  if (!header) {
    return null
  }

  const match = header.match(/^Bearer\s+(.+)$/i)
  const token = match?.[1]?.trim()
  return token || null
}
