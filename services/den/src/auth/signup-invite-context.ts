import { getOAuthState } from "better-auth/api"

export const SIGNUP_INVITE_TOKEN_HEADER = "x-veslo-signup-invite-token"

const SIGNUP_INVITE_TOKEN_KEYS = ["inviteToken", "invitationToken", "tokenHash", "token"] as const
const SOCIAL_SIGN_IN_PATH = "/sign-in/social"
const EMAIL_SIGN_UP_PATH = "/sign-up/email"
const OAUTH_CALLBACK_PATH = /^\/callback\/(?:[^/]+|:id)\/?$/

type SignupInviteContextDependencies = {
  getOAuthState: () => Promise<unknown>
}

const defaultDependencies: SignupInviteContextDependencies = {
  getOAuthState,
}

export async function resolveSignupInviteTokenFromAuthContext(
  context: unknown,
  dependencies: SignupInviteContextDependencies = defaultDependencies,
) {
  if (!isRecord(context) || typeof context.path !== "string") {
    return null
  }

  if (context.path === EMAIL_SIGN_UP_PATH) {
    const bodyToken = isRecord(context.body) ? readEmailInviteToken(context.body) : null
    if (bodyToken) {
      return bodyToken
    }

    return typeof context.getHeader === "function"
      ? decodeSignupInviteTokenHeader(context.getHeader(SIGNUP_INVITE_TOKEN_HEADER))
      : null
  }

  if (context.path === SOCIAL_SIGN_IN_PATH) {
    const additionalData = isRecord(context.body) && isRecord(context.body.additionalData)
      ? context.body.additionalData
      : null
    return additionalData ? readNonEmptyString(additionalData.vesloSignupInviteToken) : null
  }

  if (!OAUTH_CALLBACK_PATH.test(context.path)) {
    return null
  }

  try {
    const state = await dependencies.getOAuthState()
    return isRecord(state) ? readNonEmptyString(state.vesloSignupInviteToken) : null
  } catch {
    return null
  }
}

function readEmailInviteToken(body: Record<string, unknown>) {
  for (const key of SIGNUP_INVITE_TOKEN_KEYS) {
    const token = readNonEmptyString(body[key])
    if (token) {
      return token
    }
  }
  return null
}

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null
}

function decodeSignupInviteTokenHeader(value: unknown) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    return null
  }

  const decoded = Buffer.from(value, "base64url").toString("utf8").trim()
  return decoded || null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
