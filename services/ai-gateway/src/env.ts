import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().optional(),
  AI_GATEWAY_HOST: z.string().default("0.0.0.0"),
  AI_GATEWAY_PORT: z.coerce.number().int().positive().default(4034),
});

export function parseEnv(source: NodeJS.ProcessEnv) {
  const parsed = envSchema.parse(source);

  return {
    host: parsed.AI_GATEWAY_HOST,
    port: parsed.PORT ?? parsed.AI_GATEWAY_PORT,
  };
}

export const env = parseEnv(process.env);
