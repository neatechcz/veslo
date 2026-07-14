import type { UserAiAccessPolicyRecord } from "../../access/repository.js";
import type { LeaseProvider } from "../../leases/repository.js";
import type { PlatformModelRef } from "../../model-policy/repository.js";

export type AiAccessPolicyResult =
  | { ok: true; body: Record<string, unknown>; model: string }
  | { ok: false; status: number; error: string };

export type PlatformModelPolicyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string };

export function applyAiAccessPolicy(input: {
  routeProvider: LeaseProvider;
  aiAccess: UserAiAccessPolicyRecord;
  body: unknown;
}): AiAccessPolicyResult {
  if (input.aiAccess.provider !== input.routeProvider) {
    return {
      ok: false,
      status: 403,
      error: "provider_not_assigned",
    };
  }

  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request_body",
    };
  }

  const requestBody = { ...(input.body as Record<string, unknown>) };
  const requestedModel = normalizeManagedModelRef(
    typeof requestBody.model === "string" ? requestBody.model : "",
    input.routeProvider,
  );
  const defaultModel = normalizeManagedModelRef(
    typeof input.aiAccess.defaultModel === "string" ? input.aiAccess.defaultModel : "",
    input.routeProvider,
  );
  const effectiveModel = requestedModel || defaultModel;

  if (!effectiveModel) {
    return {
      ok: false,
      status: 403,
      error: "ai_access_default_model_missing",
    };
  }

  const allowedModels = input.aiAccess.allowedModels.length > 0
    ? input.aiAccess.allowedModels.map((value) => normalizeManagedModelRef(value, input.routeProvider)).filter(Boolean)
    : defaultModel
      ? [defaultModel]
      : [];

  if (allowedModels.length > 0 && !allowedModels.includes(effectiveModel)) {
    return {
      ok: false,
      status: 403,
      error: "model_not_allowed",
    };
  }

  requestBody.model = effectiveModel;
  return {
    ok: true,
    body: requestBody,
    model: effectiveModel,
  };
}

export function applyPlatformModelPolicy(input: {
  routeProvider: LeaseProvider;
  activeModel: PlatformModelRef;
  body: unknown;
}): PlatformModelPolicyResult {
  if (input.routeProvider !== input.activeModel.provider) {
    return {
      ok: false,
      status: 403,
      error: "active_model_provider_mismatch",
    };
  }

  if (!input.body || typeof input.body !== "object" || Array.isArray(input.body)) {
    return {
      ok: false,
      status: 400,
      error: "invalid_request_body",
    };
  }

  const requestBody = { ...(input.body as Record<string, unknown>) };
  const requestedModel = typeof requestBody.model === "string" ? requestBody.model : "";
  if (requestedModel && requestedModel !== input.activeModel.model) {
    return {
      ok: false,
      status: 403,
      error: "model_override_not_allowed",
    };
  }

  requestBody.model = input.activeModel.model;
  return {
    ok: true,
    body: requestBody,
  };
}

function normalizeManagedModelRef(model: string, routeProvider: LeaseProvider): string {
  const trimmed = model.trim();
  if (!trimmed) {
    return "";
  }

  const prefix = `${routeProvider}/`;
  if (!trimmed.startsWith(prefix)) {
    return trimmed;
  }

  const normalized = trimmed.slice(prefix.length).trim();
  return normalized || trimmed;
}
