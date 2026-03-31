import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().optional(),
  AI_GATEWAY_HOST: z.string().default("0.0.0.0"),
  AI_GATEWAY_PORT: z.coerce.number().int().positive().default(4034),
  AI_GATEWAY_DEN_API_BASE: z.string().optional(),
  NODE_ENV: z.string().optional(),
});

export function parseEnv(source: NodeJS.ProcessEnv) {
  const parsed = envSchema.parse(source);

  return {
    host: parsed.AI_GATEWAY_HOST,
    port: parsed.PORT ?? parsed.AI_GATEWAY_PORT,
    denApiBase: (parsed.AI_GATEWAY_DEN_API_BASE ?? (parsed.NODE_ENV === "production" ? "https://den-control-plane-veslo.onrender.com" : "http://127.0.0.1:8788")).replace(/\/+$/, ""),
  };
}

export const env = parseEnv(process.env);
