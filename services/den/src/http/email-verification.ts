import type { Response } from "express"
import type { SessionContext } from "./session.js"

export function requireVerifiedEmail(_res: Response, _session: SessionContext): boolean {
  return false
}
