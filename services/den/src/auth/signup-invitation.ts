export function buildOrganizationInvitationUrl(publicAppBaseUrl: string, inviteToken: string) {
  if (!inviteToken.trim()) {
    throw new Error("Organization invitation token is required")
  }

  const invitationUrl = new URL("/", publicAppBaseUrl)
  const fragment = new URLSearchParams()
  fragment.set("inviteToken", inviteToken)
  invitationUrl.hash = fragment.toString()
  return invitationUrl.toString()
}
