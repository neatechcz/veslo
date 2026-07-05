import { config as loadEnv } from "dotenv";
import { z } from "zod";
import { deploymentServiceUrl } from "./deployment-endpoints.js";

loadEnv();

const envSchema = z.object({
  LETTR_API_KEY: z.string().optional(),
  AUTH_EMAIL_ADDRESS: z.string().optional(),
  AUTH_EMAIL_FROM_NAME: z.string().optional(),
  PORT: z.coerce.number().int().positive().optional(),
  AI_GATEWAY_HOST: z.string().default("0.0.0.0"),
  AI_GATEWAY_PORT: z.coerce.number().int().positive().default(4034),
  AI_GATEWAY_DATABASE_URL: z.string().min(1).default("mysql://root:root@127.0.0.1:3306/veslo_ai_gateway"),
  AI_GATEWAY_SECRET_KEY: z.string().min(32).default("dev_only_ai_gateway_secret_key_32b__"),
  AI_GATEWAY_OPENAI_CLIENT_ID: z.string().min(1).default("veslo-dev-openai-client"),
  AI_GATEWAY_OPENAI_CLIENT_SECRET: z.string().min(1).default("veslo-dev-openai-secret"),
  AI_GATEWAY_OPENAI_REDIRECT_BASE: z.preprocess(
    (value) => (typeof value === "string" && value.trim() === "" ? undefined : value),
    z.string().url().optional(),
  ),
  AI_GATEWAY_DEN_API_BASE: z.string().optional(),
  VESLO_DEPLOYMENT_DOMAIN: z.string().optional(),
  AI_GATEWAY_ALERT_EMAIL_RECIPIENTS: z.string().optional(),
  AI_GATEWAY_CODEX_CAPACITY_ALERT_EMAIL_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  AI_GATEWAY_DEN_INTERNAL_TOKEN: z.string().optional(),
  AI_GATEWAY_CREDENTIAL_ALERT_EMAIL_INTERVAL_MS: z.coerce.number().int().positive().optional(),
  NODE_ENV: z.string().optional(),
});

const DEFAULT_CODEX_CAPACITY_ALERT_EMAIL_INTERVAL_MS = 5 * 60 * 1000;
const DEFAULT_CREDENTIAL_ALERT_EMAIL_INTERVAL_MS = 60 * 1000;

export function parseEnv(source: NodeJS.ProcessEnv) {
  const parsed = envSchema.parse(source);
  const hostedDefaultsEnabled = parsed.NODE_ENV === "production" || Boolean(parsed.VESLO_DEPLOYMENT_DOMAIN?.trim());
  const defaultOpenAiRedirectBase = hostedDefaultsEnabled
    ? `${deploymentServiceUrl("ai", parsed.VESLO_DEPLOYMENT_DOMAIN)}/auth/openai`
    : "http://127.0.0.1:4034/auth/openai";
  const defaultDenApiBase = hostedDefaultsEnabled
    ? deploymentServiceUrl("api", parsed.VESLO_DEPLOYMENT_DOMAIN)
    : "http://127.0.0.1:8788";

  return {
    host: parsed.AI_GATEWAY_HOST,
    port: parsed.PORT ?? parsed.AI_GATEWAY_PORT,
    databaseUrl: parsed.AI_GATEWAY_DATABASE_URL,
    secretKey: parsed.AI_GATEWAY_SECRET_KEY,
    openAiOAuth: {
      clientId: parsed.AI_GATEWAY_OPENAI_CLIENT_ID,
      clientSecret: parsed.AI_GATEWAY_OPENAI_CLIENT_SECRET,
      redirectBase: (parsed.AI_GATEWAY_OPENAI_REDIRECT_BASE?.trim() || defaultOpenAiRedirectBase).replace(/\/+$/, ""),
    },
    email: {
      lettrApiKey: parsed.LETTR_API_KEY?.trim() || undefined,
      address: parsed.AUTH_EMAIL_ADDRESS?.trim() || undefined,
      fromName: parsed.AUTH_EMAIL_FROM_NAME?.trim() || undefined,
    },
    alertEmail: {
      recipients: parseEmailList(parsed.AI_GATEWAY_ALERT_EMAIL_RECIPIENTS),
      codexCapacityIntervalMs:
        parsed.AI_GATEWAY_CODEX_CAPACITY_ALERT_EMAIL_INTERVAL_MS ??
        DEFAULT_CODEX_CAPACITY_ALERT_EMAIL_INTERVAL_MS,
      credentialAlertIntervalMs:
        parsed.AI_GATEWAY_CREDENTIAL_ALERT_EMAIL_INTERVAL_MS ??
        DEFAULT_CREDENTIAL_ALERT_EMAIL_INTERVAL_MS,
    },
    denInternalToken: parsed.AI_GATEWAY_DEN_INTERNAL_TOKEN?.trim() || null,
    denApiBase: (parsed.AI_GATEWAY_DEN_API_BASE?.trim() || defaultDenApiBase).replace(/\/+$/, ""),
  };
}

function parseEmailList(value: string | undefined): string[] {
  if (!value) {
    return [];
  }

  return Array.from(new Set(
    value
      .split(/[,\s]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean),
  ));
}

export const env = parseEnv(process.env);
