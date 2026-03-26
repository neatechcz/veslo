import type { Response } from "express"
import type { SessionContext } from "./session.js"

export function requireVerifiedEmail(res: Response, session: SessionContext): boolean {
  if (session.user.emailVerified) {
    return true
  }

  res.status(403).json({
    error: "email_verification_required",
    message: "Verify your email to continue.",
    email: session.user.email,
  })
  return false
}
