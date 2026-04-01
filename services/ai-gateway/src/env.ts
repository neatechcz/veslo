import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().optional(),
  AI_GATEWAY_HOST: z.string().default("0.0.0.0"),
  AI_GATEWAY_PORT: z.coerce.number().int().positive().default(4034),
  AI_GATEWAY_DATABASE_URL: z.string().min(1).default("mysql://root:root@127.0.0.1:3306/veslo_ai_gateway"),
  AI_GATEWAY_SECRET_KEY: z.string().min(32).default("dev_only_ai_gateway_secret_key_32b__"),
  AI_GATEWAY_OPENAI_CLIENT_ID: z.string().min(1).default("veslo-dev-openai-client"),
  AI_GATEWAY_OPENAI_CLIENT_SECRET: z.string().min(1).default("veslo-dev-openai-secret"),
  AI_GATEWAY_OPENAI_REDIRECT_BASE: z.string().url().default("http://127.0.0.1:4034/auth/openai"),
  AI_GATEWAY_DEN_API_BASE: z.string().optional(),
  NODE_ENV: z.string().optional(),
});

export function parseEnv(source: NodeJS.ProcessEnv) {
  const parsed = envSchema.parse(source);

  return {
    host: parsed.AI_GATEWAY_HOST,
    port: parsed.PORT ?? parsed.AI_GATEWAY_PORT,
    databaseUrl: parsed.AI_GATEWAY_DATABASE_URL,
    secretKey: parsed.AI_GATEWAY_SECRET_KEY,
    openAiOAuth: {
      clientId: parsed.AI_GATEWAY_OPENAI_CLIENT_ID,
      clientSecret: parsed.AI_GATEWAY_OPENAI_CLIENT_SECRET,
      redirectBase: parsed.AI_GATEWAY_OPENAI_REDIRECT_BASE.replace(/\/+$/, ""),
    },
    denApiBase: (parsed.AI_GATEWAY_DEN_API_BASE ?? (parsed.NODE_ENV === "production" ? "https://den-control-plane-veslo.onrender.com" : "http://127.0.0.1:8788")).replace(/\/+$/, ""),
  };
}

export const env = parseEnv(process.env);
