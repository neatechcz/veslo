import { fromNodeHeaders } from "better-auth/node"
import { eq } from "drizzle-orm"
import { auth } from "../../auth.js"
import { db } from "../../db/index.js"
import { AdminUserStateTable } from "../../db/schema.js"
import { env } from "../../env.js"
import {
  evaluateSessionPolicy,
  SessionPolicyRejectionError,
} from "../../http/email-verification.js"
import type { SessionContext } from "../../http/session-context.js"

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

type ResolvedAuthSession = {
  user: {
    id: string
    email?: unknown
    emailVerified?: unknown
    name?: unknown
  }
} | null

export type DenUserSessionResolverDependencies = {
  getSession(token: string): Promise<ResolvedAuthSession>
  isUserDisabled(userId: string): Promise<boolean>
  requireEmailVerification: boolean
}

const defaultDependencies: DenUserSessionResolverDependencies = {
  getSession(token) {
    return auth.api.getSession({
      headers: fromNodeHeaders({
        authorization: `Bearer ${token}`,
      }),
    })
  },
  async isUserDisabled(userId) {
    const userState = await db
      .select({
        disabled: AdminUserStateTable.disabled,
      })
      .from(AdminUserStateTable)
      .where(eq(AdminUserStateTable.user_id, userId))
      .limit(1)

    return userState[0]?.disabled === true
  },
  requireEmailVerification: env.authRequireEmailVerification,
}

export class DenUserSessionResolver implements UserSessionResolver {
  private readonly dependencies: DenUserSessionResolverDependencies

  constructor(dependencies: DenUserSessionResolverDependencies = defaultDependencies) {
    this.dependencies = dependencies
  }

  async resolveSession(token: string): Promise<UserSession | null> {
    const trimmedToken = token.trim()
    if (!trimmedToken) {
      return null
    }

    const session = await this.dependencies.getSession(trimmedToken)

    if (!session?.user?.id) {
      return null
    }

    const email = typeof session.user.email === "string" ? session.user.email.trim() : ""
    const name = typeof session.user.name === "string" ? session.user.name.trim() : ""
    const context: SessionContext = {
      user: {
        id: session.user.id,
        email: email || null,
        emailVerified: session.user.emailVerified === true,
        name: name || null,
      },
    }
    const policyRejection = evaluateSessionPolicy(context, {
      disabled: await this.dependencies.isUserDisabled(session.user.id),
      requireEmailVerification: this.dependencies.requireEmailVerification,
    })

    if (policyRejection?.body.error === "user_disabled") {
      return null
    }
    if (policyRejection) {
      throw new SessionPolicyRejectionError(policyRejection)
    }

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
