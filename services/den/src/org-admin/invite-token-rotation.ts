import { hashOrganizationInviteToken } from "./invite-token.js"

type OrganizationInviteTokenRotationInput<T> = {
  expectedTokenHash: string
  createInviteToken: () => string
  compareAndSwap: (input: {
    expectedTokenHash: string
    nextTokenHash: string
  }) => Promise<boolean>
  onCommitted: (input: { inviteToken: string }) => Promise<T>
}

export async function rotateOrganizationInviteToken<T>(
  input: OrganizationInviteTokenRotationInput<T>,
): Promise<{ ok: true; value: T } | { ok: false }> {
  const inviteToken = input.createInviteToken()
  const nextTokenHash = hashOrganizationInviteToken(inviteToken)
  const committed = await input.compareAndSwap({
    expectedTokenHash: input.expectedTokenHash,
    nextTokenHash,
  })
  if (!committed) {
    return { ok: false }
  }

  return {
    ok: true,
    value: await input.onCommitted({ inviteToken }),
  }
}
