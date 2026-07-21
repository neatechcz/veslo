import { randomUUID } from "node:crypto"
import { maybeAssignDefaultManagedAiAccessForNewUser } from "../managed-ai/signup-assignment.js"
import {
  createOrActivateOrganizationMembership,
  resolveEnabledOrganizationDomainForEmail,
} from "../org-admin/repository.js"
import {
  ensureSignupOrganization,
  findExistingActiveOrganizationId,
} from "../orgs.js"
import { provisionVerifiedSignupUser } from "./signup-gate.js"

export type VerifiedSignupIdentity = {
  id: string
  name: string | null | undefined
  email: string | null | undefined
  emailVerified: boolean
}

export function provisionVerifiedSignupIdentity(user: VerifiedSignupIdentity) {
  return provisionVerifiedSignupUser({
    user,
    createMembershipId: randomUUID,
    findExistingOrganizationId: findExistingActiveOrganizationId,
    resolveEnabledOrganizationDomainForEmail,
    createOrActivateOrganizationMembership,
    ensureSignupOrganization,
    assignManagedAiAccess: maybeAssignDefaultManagedAiAccessForNewUser,
  })
}
