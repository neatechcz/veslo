import { APIError, betterAuth } from "better-auth"
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
  type SignupAccessError,
} from "./auth/signup-gate.js"
import { normalizeInviteEmail } from "./org-admin/policy.js"
import {
  acceptOrganizationInvite,
  assertCanActivateOrganizationSeat,
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

type EmailSignupGuardResult =
  | { ok: true }
  | { ok: false; status: number; error: "invalid_signup_request" | SignupAccessError }

const SIGNUP_INVITE_TOKEN_HEADER = "x-veslo-signup-invite-token"

const signupAccessDependencies = {
  resolveEnabledOrganizationDomainForEmail,
  countActiveOrganizationSeats,
  assertCanActivateOrganizationSeat,
  resolveValidOrganizationInviteForSignup,
}

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
        before: async (user, context) => {
          await authorizeSignupBeforeUserCreate({
            email: typeof user.email === "string" ? user.email : null,
            inviteToken: readInviteTokenFromAuthContext(context),
          })
        },
        after: async (user, context) => {
          const name = user.name ?? user.email ?? "Personal"
          const signupResult = await completeSignupAfterUserCreate({
            user: {
              id: user.id,
              email: user.email,
            },
            inviteToken: readInviteTokenFromAuthContext(context),
            createMembershipId: randomUUID,
            resolveEnabledOrganizationDomainForEmail,
            createOrActivateOrganizationMembership,
            acceptOrganizationInvite,
          })
          if (signupResult.createDefaultOrganization) {
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

    setRequestSignupInviteToken(req, parseEmailSignupBody(rawBody)?.inviteToken ?? null)
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
    dependencies: signupAccessDependencies,
  })
  if (!decision.ok) {
    return {
      ok: false,
      status: decision.error === "seat_limit_reached" ? 409 : 403,
      error: decision.error,
    }
  }

  return { ok: true }
}

async function authorizeSignupBeforeUserCreate(input: {
  email: string | null | undefined
  inviteToken: string | null
}) {
  const decision = await resolveEmailSignupAccess({
    email: input.email ?? "",
    inviteToken: input.inviteToken,
    dependencies: signupAccessDependencies,
  })
  if (!decision.ok) {
    throwSignupAccessApiError(decision.error)
  }
  return decision
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

function readInviteTokenFromAuthContext(context: unknown) {
  if (!isRecord(context)) {
    return null
  }

  if (isRecord(context.body)) {
    const token = readInviteToken(context.body)
    if (token) {
      return token
    }
  }

  if (context.path !== "/sign-up/email") {
    return null
  }

  const getHeader = context.getHeader
  if (typeof getHeader !== "function") {
    return null
  }

  return decodeSignupInviteTokenHeader(getHeader(SIGNUP_INVITE_TOKEN_HEADER))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}

function setRequestSignupInviteToken(req: AuthNodeRequest, inviteToken: string | null) {
  const headers = req.headers as Record<string, string | string[] | undefined>
  if (!inviteToken) {
    delete headers[SIGNUP_INVITE_TOKEN_HEADER]
    return
  }

  headers[SIGNUP_INVITE_TOKEN_HEADER] = Buffer.from(inviteToken, "utf8").toString("base64url")
}

function decodeSignupInviteTokenHeader(value: string | null | undefined) {
  if (!value) {
    return null
  }

  const decoded = Buffer.from(value, "base64url").toString("utf8").trim()
  return decoded || null
}

function sendAuthSignupError(res: ServerResponse, status: number, error: string) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify({ error }))
}

function throwSignupAccessApiError(error: SignupAccessError): never {
  throw new APIError(error === "seat_limit_reached" ? "CONFLICT" : "FORBIDDEN", {
    message: error,
    code: error,
  })
}
