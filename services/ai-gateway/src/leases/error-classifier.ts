export type UpstreamFailureKind =
  | "refreshable_auth"
  | "permanent_credential"
  | "transient_upstream";

export type UpstreamFailureInput = {
  kind?: UpstreamFailureKind;
  statusCode?: number;
  code?: string;
};

const PERMANENT_CREDENTIAL_CODES = new Set([
  "invalid_api_key",
  "invalid_grant",
  "insufficient_quota",
  "revoked_token",
]);

export function classifyUpstreamFailure(input: UpstreamFailureInput): UpstreamFailureKind {
  if (input.kind) {
    return input.kind;
  }

  if (input.code && PERMANENT_CREDENTIAL_CODES.has(input.code)) {
    return "permanent_credential";
  }

  if (input.statusCode === 401 || input.statusCode === 403) {
    return "refreshable_auth";
  }

  return "transient_upstream";
}
