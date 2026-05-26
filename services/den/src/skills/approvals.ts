import { SkillRegistryStoreError, type SkillRegistryRouteContext } from "./store.js"

export function requireOrgSkillAdmin(context: SkillRegistryRouteContext, orgId?: string | null) {
  if (context.isPlatformAdmin) {
    return
  }
  if (!orgId || context.orgId !== orgId) {
    throw new SkillRegistryStoreError(403, "organization_forbidden")
  }
  if (context.orgRole !== "owner") {
    throw new SkillRegistryStoreError(403, "insufficient_role")
  }
}

export function requirePlatformSkillAdmin(context: SkillRegistryRouteContext) {
  if (!context.isPlatformAdmin) {
    throw new SkillRegistryStoreError(403, "forbidden")
  }
}

export function requireWorkspaceSkillAdmin(context: SkillRegistryRouteContext, orgId?: string | null) {
  if (context.isPlatformAdmin) {
    return
  }
  if (!orgId || context.orgId !== orgId) {
    throw new SkillRegistryStoreError(403, "organization_forbidden")
  }
  if (context.orgRole !== "owner") {
    throw new SkillRegistryStoreError(403, "insufficient_role")
  }
}
