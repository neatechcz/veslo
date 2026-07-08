import { z } from "zod";
import type { ApprovalMode, LogFormat } from "./types.js";
import { normalizeDenApiBaseUrl } from "./den-api-base.js";

export const SERVER_CONFIG_ENV_KEYS = [
  "VESLO_SERVER_CONFIG",
  "VESLO_SECRETS_FILE",
  "VESLO_WORKSPACES",
  "VESLO_OPENCODE_BASE_URL",
  "VESLO_OPENCODE_DIRECTORY",
  "VESLO_OPENCODE_USERNAME",
  "VESLO_OPENCODE_PASSWORD",
  "VESLO_ORCHESTRATOR_URL",
  "VESLO_ORCHESTRATOR_LIFECYCLE_TOKEN",
  "VESLO_TOKEN",
  "VESLO_HOST_TOKEN",
  "VESLO_INSTANCE_ID",
  "VESLO_RUNTIME_FILE",
  "VESLO_RUNTIME_DESCRIPTOR_PATH",
  "VESLO_APPROVAL_MODE",
  "VESLO_APPROVAL_TIMEOUT_MS",
  "VESLO_CORS_ORIGINS",
  "VESLO_READONLY",
  "VESLO_LOG_FORMAT",
  "VESLO_LOG_REQUESTS",
  "VESLO_LOG_INGEST_URL",
  "VESLO_LOG_INGEST_TOKEN",
  "VESLO_LOG_BATCH_MAX_EVENTS",
  "VESLO_LOG_BATCH_MAX_BYTES",
  "VESLO_LOG_SPOOL_MAX_BYTES",
  "VESLO_LOG_FLUSH_INTERVAL_MS",
  "VESLO_DEN_API_BASE",
  "VESLO_DEPLOYMENT_DOMAIN",
  "VESLO_SKILL_REGISTRY_BASE_URL",
  "VESLO_SKILL_REGISTRY_TOKEN",
  "VESLO_HOST",
  "VESLO_PORT",
  "VESLO_BRIDGE_HOST",
] as const;

type ServerConfigEnvKey = typeof SERVER_CONFIG_ENV_KEYS[number];

const TRUE_VALUES = new Set(["true", "1", "yes", "on"]);
const FALSE_VALUES = new Set(["false", "0", "no", "off"]);
const READONLY_TRUE_VALUES = new Set(["true", "1", "yes"]);
const READONLY_FALSE_VALUES = new Set(["false", "0", "no", "off"]);

function emptyToUndefined(value: unknown): unknown {
  return typeof value === "string" && value.trim() === "" ? undefined : value;
}

function optionalRawString() {
  return z.preprocess(emptyToUndefined, z.string().optional());
}

function optionalTrimmedString() {
  return z.preprocess(emptyToUndefined, z.string().transform((value) => value.trim()).optional());
}

function parseBooleanEnv(
  value: string | undefined,
  ctx: z.RefinementCtx,
  options: { truthy?: Set<string>; falsy?: Set<string>; label: string },
): boolean | undefined {
  if (value === undefined) return undefined;
  const normalized = value.trim().toLowerCase();
  const truthy = options.truthy ?? TRUE_VALUES;
  const falsy = options.falsy ?? FALSE_VALUES;
  if (truthy.has(normalized)) return true;
  if (falsy.has(normalized)) return false;
  ctx.addIssue({
    code: "custom",
    message: `${options.label} must be one of: ${[...truthy, ...falsy].join(", ")}`,
  });
  return z.NEVER;
}

function optionalBoolean(options: { truthy?: Set<string>; falsy?: Set<string>; label: string }) {
  return optionalTrimmedString().transform((value, ctx) => parseBooleanEnv(value, ctx, options));
}

function optionalPositiveInteger(label: string) {
  return z.preprocess(
    emptyToUndefined,
    z.coerce.number({ error: `${label} must be a positive integer` }).int().positive().optional(),
  );
}

function optionalPort() {
  return z.preprocess(
    emptyToUndefined,
    z.coerce.number({ error: "VESLO_PORT must be a port number from 1 to 65535" })
      .int()
      .min(1)
      .max(65535)
      .optional(),
  );
}

function optionalHttpUrl(label: string, options: { stripTrailingSlash?: boolean } = {}) {
  return optionalTrimmedString().transform((value, ctx) => {
    if (value === undefined) return undefined;
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new Error("unsupported protocol");
      }
      return options.stripTrailingSlash ? value.replace(/\/+$/, "") : value;
    } catch {
      ctx.addIssue({ code: "custom", message: `${label} must be an absolute http(s) URL` });
      return z.NEVER;
    }
  });
}

function optionalDenApiBaseUrl(label: string) {
  return optionalTrimmedString().transform((value, ctx) => {
    if (value === undefined) return undefined;
    const normalized = normalizeDenApiBaseUrl(value);
    if (normalized) return normalized;
    ctx.addIssue({ code: "custom", message: `${label} must be an absolute http(s) URL without credentials, query, or hash` });
    return z.NEVER;
  });
}

const serverEnvSchema = z.object({
  VESLO_SERVER_CONFIG: optionalRawString(),
  VESLO_SECRETS_FILE: optionalTrimmedString(),
  VESLO_WORKSPACES: optionalRawString(),
  VESLO_OPENCODE_BASE_URL: optionalHttpUrl("VESLO_OPENCODE_BASE_URL"),
  VESLO_OPENCODE_DIRECTORY: optionalRawString(),
  VESLO_OPENCODE_USERNAME: optionalRawString(),
  VESLO_OPENCODE_PASSWORD: optionalRawString(),
  VESLO_ORCHESTRATOR_URL: optionalHttpUrl("VESLO_ORCHESTRATOR_URL", { stripTrailingSlash: true }),
  VESLO_ORCHESTRATOR_LIFECYCLE_TOKEN: optionalTrimmedString(),
  VESLO_TOKEN: optionalRawString(),
  VESLO_HOST_TOKEN: optionalRawString(),
  VESLO_INSTANCE_ID: optionalTrimmedString(),
  VESLO_RUNTIME_FILE: optionalTrimmedString(),
  VESLO_RUNTIME_DESCRIPTOR_PATH: optionalTrimmedString(),
  VESLO_APPROVAL_MODE: optionalTrimmedString().transform((value, ctx): ApprovalMode | undefined => {
    if (value === undefined) return undefined;
    if (value === "manual" || value === "auto") return value;
    ctx.addIssue({ code: "custom", message: "VESLO_APPROVAL_MODE must be manual or auto" });
    return z.NEVER;
  }),
  VESLO_APPROVAL_TIMEOUT_MS: optionalPositiveInteger("VESLO_APPROVAL_TIMEOUT_MS"),
  VESLO_CORS_ORIGINS: optionalRawString(),
  VESLO_READONLY: optionalBoolean({
    truthy: READONLY_TRUE_VALUES,
    falsy: READONLY_FALSE_VALUES,
    label: "VESLO_READONLY",
  }),
  VESLO_LOG_FORMAT: optionalTrimmedString().transform((value, ctx): LogFormat | undefined => {
    if (value === undefined) return undefined;
    const normalized = value.toLowerCase();
    if (normalized === "json") return "json";
    if (normalized === "pretty" || normalized === "text" || normalized === "human") return "pretty";
    ctx.addIssue({ code: "custom", message: "VESLO_LOG_FORMAT must be json, pretty, text, or human" });
    return z.NEVER;
  }),
  VESLO_LOG_REQUESTS: optionalBoolean({ label: "VESLO_LOG_REQUESTS" }),
  VESLO_LOG_INGEST_URL: optionalHttpUrl("VESLO_LOG_INGEST_URL"),
  VESLO_LOG_INGEST_TOKEN: optionalTrimmedString(),
  VESLO_LOG_BATCH_MAX_EVENTS: optionalPositiveInteger("VESLO_LOG_BATCH_MAX_EVENTS"),
  VESLO_LOG_BATCH_MAX_BYTES: optionalPositiveInteger("VESLO_LOG_BATCH_MAX_BYTES"),
  VESLO_LOG_SPOOL_MAX_BYTES: optionalPositiveInteger("VESLO_LOG_SPOOL_MAX_BYTES"),
  VESLO_LOG_FLUSH_INTERVAL_MS: optionalPositiveInteger("VESLO_LOG_FLUSH_INTERVAL_MS"),
  VESLO_DEN_API_BASE: optionalDenApiBaseUrl("VESLO_DEN_API_BASE"),
  VESLO_DEPLOYMENT_DOMAIN: optionalTrimmedString(),
  VESLO_SKILL_REGISTRY_BASE_URL: optionalDenApiBaseUrl("VESLO_SKILL_REGISTRY_BASE_URL"),
  VESLO_SKILL_REGISTRY_TOKEN: optionalTrimmedString(),
  VESLO_HOST: optionalRawString(),
  VESLO_PORT: optionalPort(),
  VESLO_BRIDGE_HOST: optionalRawString(),
});

export type ServerEnv = z.infer<typeof serverEnvSchema>;

class ServerEnvValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ServerEnvValidationError";
  }
}

function formatEnvError(error: z.ZodError): string {
  const lines = error.issues.map((issue) => {
    const key = issue.path.join(".") || "environment";
    return `- ${key}: ${issue.message}`;
  });
  return `Invalid Veslo server environment:\n${lines.join("\n")}`;
}

export function readServerEnv(env: NodeJS.ProcessEnv = process.env): ServerEnv {
  const input = Object.fromEntries(
    SERVER_CONFIG_ENV_KEYS.map((key: ServerConfigEnvKey) => [key, env[key]]),
  );
  const parsed = serverEnvSchema.safeParse(input);
  if (!parsed.success) {
    throw new ServerEnvValidationError(formatEnvError(parsed.error));
  }
  return parsed.data;
}
