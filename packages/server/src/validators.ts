import { ApiError } from "./errors.js";

const SKILL_NAME_REGEX = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const COMMAND_NAME_REGEX = /^[A-Za-z0-9_-]+$/;
const MCP_NAME_REGEX = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_CUSTOM_MCP_HEADER_NAMES = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-veslo-den-token",
  "x-veslo-connector-token",
]);

export type ValidateMcpConfigOptions = {
  allowVesloConnectorTokenHeader?: boolean;
};

export function validateSkillName(name: string): void {
  if (!name || name.length < 1 || name.length > 64 || !SKILL_NAME_REGEX.test(name)) {
    throw new ApiError(400, "invalid_skill_name", "Skill name must be kebab-case (1-64 chars)");
  }
}

export function validateDescription(description: string | undefined): void {
  if (!description || description.length < 1 || description.length > 1024) {
    throw new ApiError(422, "invalid_description", "Description must be 1-1024 characters");
  }
}

export function validatePluginSpec(spec: string): void {
  if (!spec || spec.trim().length === 0) {
    throw new ApiError(400, "invalid_plugin_spec", "Plugin spec is required");
  }
}

export function sanitizeCommandName(name: string): string {
  const trimmed = name.trim().replace(/^\/+/, "");
  return trimmed;
}

export function validateCommandName(name: string): void {
  if (!name || !COMMAND_NAME_REGEX.test(name)) {
    throw new ApiError(400, "invalid_command_name", "Command name must be alphanumeric with _ or -");
  }
}

export function validateMcpName(name: string): void {
  if (!name || name.startsWith("-") || !MCP_NAME_REGEX.test(name)) {
    throw new ApiError(400, "invalid_mcp_name", "MCP name must be alphanumeric and not start with -");
  }
}

function validateStringRecord(value: unknown, field: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_mcp_config", `MCP ${field} must be an object`);
  }

  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (!key.trim() || typeof entry !== "string" || entry.length === 0 || /[\0\r\n]/.test(entry)) {
      throw new ApiError(400, "invalid_mcp_config", `MCP ${field} must contain string values`);
    }
    result[key] = entry;
  }
  return result;
}

function validateMcpHeaders(value: unknown, options: ValidateMcpConfigOptions): void {
  const headers = validateStringRecord(value, "headers");
  if (!headers) return;

  for (const [key, entry] of Object.entries(headers)) {
    const normalizedKey = key.trim().toLowerCase();
    const isVesloConnectorToken = normalizedKey === "x-veslo-connector-token";
    if (
      FORBIDDEN_CUSTOM_MCP_HEADER_NAMES.has(normalizedKey) &&
      !(isVesloConnectorToken && options.allowVesloConnectorTokenHeader)
    ) {
      throw new ApiError(400, "invalid_mcp_config", `MCP header is not allowed: ${key}`);
    }
    if (/\{env:/i.test(entry)) {
      throw new ApiError(400, "invalid_mcp_config", "MCP headers must not contain env interpolation");
    }
  }
}

function validateMcpOAuth(value: unknown): void {
  if (value === undefined) return;
  if (typeof value === "boolean") return;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_mcp_config", "MCP oauth must be a boolean or an object");
  }

  const payload = value as Record<string, unknown>;
  for (const [key, entry] of Object.entries(payload)) {
    if (typeof entry !== "string") {
      throw new ApiError(400, "invalid_mcp_config", `MCP oauth field must be a string: ${key}`);
    }
  }
}

export function validateMcpConfig(config: Record<string, unknown>, options: ValidateMcpConfigOptions = {}): void {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new ApiError(400, "invalid_mcp_config", "MCP config must be an object");
  }

  const type = config.type;
  if (type !== "local" && type !== "remote") {
    throw new ApiError(400, "invalid_mcp_config", "MCP config type must be local or remote");
  }
  if (config.enabled !== undefined && typeof config.enabled !== "boolean") {
    throw new ApiError(400, "invalid_mcp_config", "MCP enabled must be a boolean");
  }
  if (
    config.timeout !== undefined &&
    (typeof config.timeout !== "number" || !Number.isFinite(config.timeout) || config.timeout <= 0)
  ) {
    throw new ApiError(400, "invalid_mcp_config", "MCP timeout must be a positive number");
  }
  validateMcpHeaders(config.headers, options);
  validateStringRecord(config.environment, "environment");
  validateStringRecord(config.env, "env");
  validateMcpOAuth(config.oauth);

  if (type === "local") {
    const command = config.command;
    if (
      !Array.isArray(command) ||
      command.length === 0 ||
      command.some((part) => typeof part !== "string" || !part.trim() || /[\0\r\n]/.test(part))
    ) {
      throw new ApiError(400, "invalid_mcp_config", "Local MCP requires command array");
    }
  }
  if (type === "remote") {
    const url = config.url;
    if (!url || typeof url !== "string") {
      throw new ApiError(400, "invalid_mcp_config", "Remote MCP requires url");
    }
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      throw new ApiError(400, "invalid_mcp_config", "Remote MCP url must be a valid URL");
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      throw new ApiError(400, "invalid_mcp_config", "Remote MCP url must use http or https");
    }
    if (!parsed.hostname) {
      throw new ApiError(400, "invalid_mcp_config", "Remote MCP url must include a host");
    }
  }
}
