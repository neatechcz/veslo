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
  "authentication_error",
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

export function getUpstreamFailureInput(error: unknown): UpstreamFailureInput {
  const candidate = getRecord(error);
  const cause = getRecord(candidate?.cause);

  return {
    kind: parseFailureKind(candidate?.kind) ?? parseFailureKind(cause?.kind),
    statusCode: parseStatusCode(candidate?.statusCode) ?? parseStatusCode(cause?.statusCode),
    code: parseString(candidate?.code) ?? parseString(cause?.code),
  };
}

function getRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  return value as Record<string, unknown>;
}

function parseFailureKind(value: unknown): UpstreamFailureKind | undefined {
  if (
    value === "refreshable_auth" ||
    value === "permanent_credential" ||
    value === "transient_upstream"
  ) {
    return value;
  }

  return undefined;
}

function parseStatusCode(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function parseString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}
