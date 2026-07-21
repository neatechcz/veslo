import { APIError, betterAuth } from "better-auth"
import { createAuthMiddleware } from "better-auth/api"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { bearer } from "better-auth/plugins/bearer"
import { eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"
import type { IncomingMessage, ServerResponse } from "node:http"
import { db } from "./db/index.js"
import { maybeAssignDefaultManagedAiAccessForNewUser } from "./managed-ai/signup-assignment.js"
import * as schema from "./db/schema.js"
import { fireAndForgetAuthEmail, sendResetPasswordAuthEmail, sendVerificationAuthEmail } from "./email/auth-mailer.js"
import { env, isAuthEmailConfigured } from "./env.js"
import { ensureSignupOrganization, findExistingActiveOrganizationId } from "./orgs.js"
import {
  resolveEmailSignupAccess,
  runSignupAfterUserCreateSideEffects,
  type SignupAccessError,
} from "./auth/signup-gate.js"
import { isAdminProvisioningSignupRequest } from "./auth/admin-provisioning.js"
import { provisionVerifiedSignupIdentity } from "./auth/verified-signup.js"
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

type AuthNodeHandler = (req: AuthNodeRequest, res: ServerResponse) => Promise<unknown>

type EmailSignupGuardResult =
  | { ok: true }
  | { ok: false; status: number; error: "invalid_signup_request" | SignupAccessError }

type VerificationDeliveryOutcome = {
  status: "initialized" | "pending" | "accepted" | "failed"
}

const SIGNUP_INVITE_TOKEN_HEADER = "x-veslo-signup-invite-token"
export const AUTH_REQUEST_BODY_LIMIT_BYTES = 64 * 1024
const VERIFICATION_EMAIL_DELIVERY_FAILED = {
  code: "VERIFICATION_EMAIL_DELIVERY_FAILED",
  message: "We could not send the verification email. Please try again.",
} as const
const verificationDeliveryOutcomes = new WeakMap<Request, VerificationDeliveryOutcome>()

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
      sendOnSignIn: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: sendVerificationEmailForAuth,
      afterEmailVerification: async (user: {
        id: string
        name?: string | null
        email?: string | null
        emailVerified?: boolean
      }) => {
        await provisionVerifiedSignupIdentity({
          id: user.id,
          name: user.name,
          email: user.email,
          emailVerified: user.emailVerified === true,
        })
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
  disabledPaths: ["/send-verification-email"],
  plugins: [bearer(), createVerificationDeliveryOutcomePlugin()],
  ...(authEmailVerification ? { emailVerification: authEmailVerification } : {}),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: env.authRequireEmailVerification,
    ...(authEmailPasswordReset ?? {}),
  },
  databaseHooks: {
    user: {
      create: {
        before: async (user, context) => {
          if (isAdminProvisioningSignupRequest(context)) {
            return
          }

          await authorizeSignupBeforeUserCreate({
            email: typeof user.email === "string" ? user.email : null,
            inviteToken: readInviteTokenFromAuthContext(context),
          })
        },
        after: async (user, context) => {
          if (isAdminProvisioningSignupRequest(context)) {
            return
          }

          const name = user.name ?? user.email ?? "Personal"
          await runSignupAfterUserCreateSideEffects({
            user: {
              id: user.id,
              email: user.email,
              emailVerified: user.emailVerified === true,
            },
            name,
            inviteToken: readInviteTokenFromAuthContext(context),
            createMembershipId: randomUUID,
            findExistingOrganizationId: findExistingActiveOrganizationId,
            resolveEnabledOrganizationDomainForEmail,
            createOrActivateOrganizationMembership,
            acceptOrganizationInvite,
            ensureSignupOrganization,
            assignManagedAiAccess: maybeAssignDefaultManagedAiAccessForNewUser,
            cleanupCreatedAuthUser,
          })
        },
      },
    },
  },
})

export async function sendVerificationEmailForAuth({
  user,
  url,
}: {
  user: { email: string }
  url: string
}, request?: Request) {
  const outcome = request ? verificationDeliveryOutcomes.get(request) : undefined
  if (outcome) {
    outcome.status = "pending"
  }

  try {
    await sendVerificationAuthEmail({ to: user.email, url })
    if (outcome) {
      outcome.status = "accepted"
    }
  } catch {
    if (outcome) {
      outcome.status = "failed"
    }
    console.error("[auth-mailer] verification delivery failed")
    throw new APIError("INTERNAL_SERVER_ERROR", {
      code: VERIFICATION_EMAIL_DELIVERY_FAILED.code,
      message: VERIFICATION_EMAIL_DELIVERY_FAILED.message,
    })
  }
}

function createVerificationDeliveryOutcomePlugin() {
  const matcher = (ctx: { path?: string }) =>
    ctx.path === "/sign-up/email" ||
    ctx.path === "/sign-in/email"

  return {
    id: "verification-delivery-outcome",
    hooks: {
      before: [{
        matcher,
        handler: createAuthMiddleware(async (ctx) => {
          if (ctx.request) {
            verificationDeliveryOutcomes.set(ctx.request, { status: "initialized" })
          }
        }),
      }],
      after: [{
        matcher,
        handler: createAuthMiddleware(async (ctx) => {
          if (!ctx.request) {
            return
          }

          const outcome = verificationDeliveryOutcomes.get(ctx.request)
          verificationDeliveryOutcomes.delete(ctx.request)
          if (!outcome || outcome.status === "initialized" || outcome.status === "accepted") {
            return
          }

          return new Response(JSON.stringify(VERIFICATION_EMAIL_DELIVERY_FAILED), {
            status: 502,
            headers: { "Content-Type": "application/json" },
          })
        }),
      }],
    },
  }
}

export function createAuthNodeHandler(baseHandler: AuthNodeHandler, guard = guardEmailSignupRequest): AuthNodeHandler {
  return async (req, res) => {
    if (!authRequestCanHaveBody(req)) {
      return baseHandler(req, res)
    }

    if (contentLengthExceedsAuthLimit(req)) {
      req.resume()
      sendAuthJson(res, 413, {
        code: "AUTH_REQUEST_TOO_LARGE",
        message: "Authentication request body is too large.",
      })
      return
    }

    const body = await readRequestBody(req, AUTH_REQUEST_BODY_LIMIT_BYTES)
    if (!body.ok) {
      sendAuthJson(res, 413, {
        code: "AUTH_REQUEST_TOO_LARGE",
        message: "Authentication request body is too large.",
      })
      return
    }

    const rawBody = body.rawBody
    if (isBetterAuthEmailSignupRequest(req)) {
      const guardResult = await guard(req, rawBody)
      if (!guardResult.ok) {
        sendAuthSignupError(res, guardResult.status, guardResult.error)
        return
      }

      setRequestSignupInviteToken(req, parseEmailSignupBody(rawBody)?.inviteToken ?? null)
    }

    req.body = rawBody
    return baseHandler(req, res)
  }
}

export async function guardEmailSignupRequest(_req: AuthNodeRequest, rawBody: string): Promise<EmailSignupGuardResult> {
  if (isAdminProvisioningSignupRequest(_req)) {
    return { ok: true }
  }

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
  return req.method === "POST" && readAuthRequestPath(req) === "/sign-up/email"
}

function readAuthRequestPath(req: AuthNodeRequest) {
  const requestUrl = req.originalUrl ?? req.url ?? ""
  const pathname = new URL(requestUrl, "http://localhost").pathname.replace(/\/+$/, "")
  return pathname.startsWith("/api/auth/") ? pathname.slice("/api/auth".length) : pathname
}

function authRequestCanHaveBody(req: IncomingMessage) {
  return req.method !== "GET" && req.method !== "HEAD" && req.method !== "OPTIONS"
}

function contentLengthExceedsAuthLimit(req: IncomingMessage) {
  const rawContentLength = req.headers["content-length"]
  if (typeof rawContentLength !== "string") {
    return false
  }
  const contentLength = Number(rawContentLength)
  return Number.isFinite(contentLength) && contentLength > AUTH_REQUEST_BODY_LIMIT_BYTES
}

function readRequestBody(
  req: IncomingMessage,
  limitBytes: number,
): Promise<{ ok: true; rawBody: string } | { ok: false }> {
  return new Promise((resolve, reject) => {
    const chunks: string[] = []
    const decoder = new TextDecoder()
    let totalBytes = 0
    let settled = false

    const cleanup = () => {
      req.off("data", onData)
      req.off("end", onEnd)
      req.off("error", onError)
      req.off("aborted", onAborted)
    }
    const finish = (result: { ok: true; rawBody: string } | { ok: false }) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(result)
    }
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      totalBytes += buffer.byteLength
      if (totalBytes > limitBytes) {
        finish({ ok: false })
        req.resume()
        return
      }
      chunks.push(decoder.decode(buffer, { stream: true }))
    }
    const onEnd = () => finish({ ok: true, rawBody: chunks.join("") + decoder.decode() })
    const onError = (error: Error) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const onAborted = () => onError(new Error("Auth request body was aborted"))

    req.on("data", onData)
    req.on("end", onEnd)
    req.on("error", onError)
    req.on("aborted", onAborted)
  })
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
  sendAuthJson(res, status, { error })
}

function sendAuthJson(res: ServerResponse, status: number, body: Record<string, unknown>) {
  res.statusCode = status
  res.setHeader("Content-Type", "application/json")
  res.end(JSON.stringify(body))
}

async function cleanupCreatedAuthUser(userId: string) {
  await db.transaction(async (tx) => {
    const users = await tx
      .select({
        email: schema.AuthUserTable.email,
      })
      .from(schema.AuthUserTable)
      .where(eq(schema.AuthUserTable.id, userId))
      .limit(1)

    const email = users[0]?.email ?? null

    await tx.delete(schema.AuthSessionTable).where(eq(schema.AuthSessionTable.userId, userId))
    await tx.delete(schema.AuthAccountTable).where(eq(schema.AuthAccountTable.userId, userId))
    if (email) {
      await tx.delete(schema.AuthVerificationTable).where(eq(schema.AuthVerificationTable.identifier, email))
    }
    await tx.delete(schema.AuthUserTable).where(eq(schema.AuthUserTable.id, userId))
  })
}

function throwSignupAccessApiError(error: SignupAccessError): never {
  throw new APIError(error === "seat_limit_reached" ? "CONFLICT" : "FORBIDDEN", {
    message: error,
    code: error,
  })
}
