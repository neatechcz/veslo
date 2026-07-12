import type { LeaseProvider } from "../../leases/repository.js";
import type { PlatformModelRef } from "../../model-policy/repository.js";

export type PlatformModelPolicyResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; status: number; error: string };

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
