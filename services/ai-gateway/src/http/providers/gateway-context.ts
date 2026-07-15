import type { Response } from "express"

export function readGatewayOrganizationId(res: Response): string | null {
  const value = res.locals.gatewayOrganizationId
  return typeof value === "string" && value.trim() ? value.trim() : null
}
