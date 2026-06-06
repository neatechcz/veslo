import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { bearer } from "better-auth/plugins/bearer"
import { randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { db } from "./db/index.js"
import { maybeAssignDefaultManagedAiAccessForNewUser } from "./managed-ai/signup-assignment.js"
import * as schema from "./db/schema.js"
import { fireAndForgetAuthEmail, sendResetPasswordAuthEmail, sendVerificationAuthEmail } from "./email/auth-mailer.js"
import { env, isAuthEmailConfigured } from "./env.js"
import { ensureDefaultOrg } from "./orgs.js"
import {
  completeSignupAfterUserCreate,
  resolveEmailSignupAccess,
  type SignupAccessDecision,
} from "./auth/signup-gate.js"
import { normalizeInviteEmail } from "./org-admin/policy.js"
import {
  acceptOrganizationInvite,
  countActiveOrganizationSeats,
  createOrActivateOrganizationMembership,
  resolveEnabledOrganizationDomainForEmail,
  resolveValidOrganizationInviteForSignup,
} from "./org-admin/repository.js"

type AuthNodeRequest = IncomingMessage & {
  body?: unknown
  originalUrl?: string
}

type AuthNodeHandler = (req: AuthNodeRequest, res: ServerResponse) => unknown
type SignupAccessError = Extract<SignupAccessDecision, { ok: false }>["error"]

type EmailSignupGuardResult =
  | { ok: true }
  | { ok: false; status: number; error: "invalid_signup_request" | SignupAccessError }

const pendingEmailSignupAccess = new Map<string, { inviteToken: string | null; expiresAt: number }>()
const PENDING_EMAIL_SIGNUP_TTL_MS = 5 * 60 * 1000

const socialProviders = env.github.clientId && env.github.clientSecret
  ? {
      github: {
        clientId: env.github.clientId,
        clientSecret: env.github.clientSecret,
      },
    }
  : undefined

const authEmailVerification = isAuthEmailConfigured()
  ? {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        void fireAndForgetAuthEmail(sendVerificationAuthEmail({ to: user.email, url }), "verification email")
      },
    }
  : undefined

const authEmailPasswordReset = isAuthEmailConfigured()
  ? {
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        void fireAndForgetAuthEmail(sendResetPasswordAuthEmail({ to: user.email, url }), "password reset email")
      },
    }
  : undefined

export const auth = betterAuth({
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  trustedOrigins: env.corsOrigins.length > 0 ? env.corsOrigins : undefined,
  socialProviders,
  database: drizzleAdapter(db, {
    provider: "mysql",
    schema,
  }),
  plugins: [bearer()],
  ...(authEmailVerification ? { emailVerification: authEmailVerification } : {}),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    ...(authEmailPasswordReset ?? {}),
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const name = user.name ?? user.email ?? "Personal"
          const signupResult = await completeSignupAfterUserCreate({
            user: {
              id: user.id,
              email: user.email,
            },
            inviteToken: consumePendingEmailSignupInviteToken(user.email),
            createMembershipId: randomUUID,
            resolveEnabledOrganizationDomainForEmail,
            createOrActivateOrganizationMembership,
            acceptOrganizationInvite,
          })
          if (!signupResult.activatedOrganizationMembership) {
            await ensureDefaultOrg(user.id, name)
          }
          await maybeAssignDefaultManagedAiAccessForNewUser(user.id)
        },
      },
    },
  },
})

export function createAuthNodeHandler(baseHandler: AuthNodeHandler, guard = guardEmailSignupRequest): AuthNodeHandler {
  return async (req, res) => {
    if (!isBetterAuthEmailSignupRequest(req)) {
      return baseHandler(req, res)
    }

    const rawBody = await readRequestBody(req)
    const guardResult = await guard(req, rawBody)
    if (!guardResult.ok) {
      sendAuthSignupError(res, guardResult.status, guardResult.error)
      return
    }

    req.body = rawBody
    return baseHandler(req, res)
  }
}

export async function guardEmailSignupRequest(_req: AuthNodeRequest, rawBody: string): Promise<EmailSignupGuardResult> {
  const parsed = parseEmailSignupBody(rawBody)
  if (!parsed) {
    return { ok: false, status: 400, error: "invalid_signup_request" }
  }

  const decision = await resolveEmailSignupAccess({
    email: parsed.email,
    inviteToken: parsed.inviteToken,
    dependencies: {
      resolveEnabledOrganizationDomainForEmail,
      countActiveOrganizationSeats,
      resolveValidOrganizationInviteForSignup,
    },
  })
  if (!decision.ok) {
    return {
      ok: false,
      status: decision.error === "seat_limit_reached" ? 409 : 403,
      error: decision.error,
    }
  }

  rememberPendingEmailSignup(parsed.email, parsed.inviteToken)
  return { ok: true }
}

function isBetterAuthEmailSignupRequest(req: AuthNodeRequest) {
  if (req.method !== "POST") {
    return false
  }

  const requestUrl = req.originalUrl ?? req.url ?? ""
  const pathname = new URL(requestUrl, "http://localhost").pathname.replace(/\/+$/, "")
  return pathname === "/api/auth/sign-up/email" || pathname === "/sign-up/email"
}

async function readRequestBody(req: IncomingMessage) {
  let rawBody = ""
  for await (const chunk of req) {
    rawBody += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8")
  }
  return rawBody
}

function parseEmailSignupBody(rawBody: string) {
  let parsed: unknown
  try {
    parsed = JSON.parse(rawBody)
  } catch {
    return null
  }

  if (!parsed || typeof parsed !== "object") {
    return null
  }

  const body = parsed as Record<string, unknown>
  const email = normalizeInviteEmail(body.email)
  if (!email) {
    return null
  }

  return {
    email,
    inviteToken: readInviteToken(body),
  }
}

function readInviteToken(body: Record<string, unknown>) {
  for (const key of ["inviteToken", "invitationToken", "tokenHash", "token"]) {
    const value = body[key]
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim()
    }
  }
  return null
}

function rememberPendingEmailSignup(email: string, inviteToken: string | null) {
  pendingEmailSignupAccess.set(email, {
    inviteToken,
    expiresAt: Date.now() + PENDING_EMAIL_SIGNUP_TTL_MS,
  })
}

function consumePendingEmailSignupInviteToken(email: string | null | undefined) {
  const normalizedEmail = normalizeInviteEmail(email)
  if (!normalizedEmail) {
    return null
  }

  const pending = pendingEmailSignupAccess.get(normalizedEmail) ?? null
  pendingEmailSignupAccess.delete(normalizedEmail)
  if (!pending || pending.expiresAt < Date.now()) {
    return null
  }
  return pending.inviteToken
}

function sendAuthSignupError(res: ServerResponse, status: number, error: string) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify({ error }))
}
