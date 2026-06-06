import { createHash } from "node:crypto"

export function hashOrganizationInviteToken(inviteToken: string) {
  return createHash("sha256").update(inviteToken, "utf8").digest("hex")
}
