import type { UserAiAccessPolicyRecord } from "../../access/repository.js"
import type { LeaseProvider } from "../../leases/repository.js"

export function applyAiAccessPolicy(input: {
  routeProvider: LeaseProvider
  aiAccess: UserAiAccessPolicyRecord
  body: unknown
}): { ok: true; body: Record<string, unknown> } | { ok: false; status: number; error: string } {
  if (input.aiAccess.provider !== input.routeProvider) {
    return {
      ok: false,
      status: 403,
      error: "provider_not_assigned",
    }
  }

  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request_body",
    }
  }

  const requestBody = { ...(input.body as Record<string, unknown>) }
  const requestedModel = typeof requestBody.model === "string" ? requestBody.model.trim() : ""
  const defaultModel = typeof input.aiAccess.defaultModel === "string" ? input.aiAccess.defaultModel.trim() : ""
  const effectiveModel = requestedModel || defaultModel

  if (!effectiveModel) {
    return {
      ok: false,
      status: 403,
      error: "ai_access_default_model_missing",
    }
  }

  const allowedModels = input.aiAccess.allowedModels.length > 0
    ? input.aiAccess.allowedModels
    : defaultModel
      ? [defaultModel]
      : []

  if (allowedModels.length > 0 && !allowedModels.includes(effectiveModel)) {
    return {
      ok: false,
      status: 403,
      error: "model_not_allowed",
    }
  }

  requestBody.model = effectiveModel
  return {
    ok: true,
    body: requestBody,
  }
}
