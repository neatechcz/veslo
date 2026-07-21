import type { Response } from "express"
import type { SessionContext } from "./session.js"

type SessionPolicy = {
  disabled: boolean
  requireEmailVerification: boolean
}

type SessionPolicyErrorBody =
  | { error: "user_disabled" }
  | {
      error: "email_verification_required"
      message: "Verify your email to continue."
      email: string | null
    }

export type SessionPolicyRejection = {
  status: 403
  body: SessionPolicyErrorBody
}

export class SessionPolicyRejectionError extends Error {
  readonly rejection: SessionPolicyRejection

  constructor(rejection: SessionPolicyRejection) {
    super(rejection.body.error)
    this.name = "SessionPolicyRejectionError"
    this.rejection = rejection
  }
}

export function evaluateSessionPolicy(
  session: SessionContext,
  policy: SessionPolicy,
): SessionPolicyRejection | null {
  if (policy.disabled) {
    return {
      status: 403,
      body: { error: "user_disabled" },
    }
  }

  if (policy.requireEmailVerification && !session.user.emailVerified) {
    return {
      status: 403,
      body: {
        error: "email_verification_required",
        message: "Verify your email to continue.",
        email: session.user.email,
      },
    }
  }

  return null
}

export function requireVerifiedEmail(res: Response, session: SessionContext): boolean {
  const rejection = evaluateSessionPolicy(session, {
    disabled: false,
    requireEmailVerification: true,
  })
  if (!rejection) {
    return true
  }

  res.status(rejection.status).json(rejection.body)
  return false
}

export function enforceSessionPolicy(
  res: Response,
  session: SessionContext,
  policy: SessionPolicy,
): boolean {
  const rejection = evaluateSessionPolicy(session, policy)
  if (rejection) {
    res.status(rejection.status).json(rejection.body)
    return false
  }

  return true
}

export function respondToSessionPolicyRejection(res: Response, error: unknown): boolean {
  if (!(error instanceof SessionPolicyRejectionError)) {
    return false
  }

  res.status(error.rejection.status).json(error.rejection.body)
  return true
}
