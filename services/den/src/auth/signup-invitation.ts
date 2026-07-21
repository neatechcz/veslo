export function buildOrganizationInvitationUrl(publicAppBaseUrl: string, inviteToken: string) {
  if (!inviteToken.trim()) {
    throw new Error("Organization invitation token is required")
  }

  const invitationUrl = new URL("/", publicAppBaseUrl)
  invitationUrl.searchParams.set("inviteToken", inviteToken)
  return invitationUrl.toString()
}
