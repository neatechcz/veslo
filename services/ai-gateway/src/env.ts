import { config as loadEnv } from "dotenv";
import { z } from "zod";

loadEnv();

const envSchema = z.object({
  AI_GATEWAY_HOST: z.string().default("0.0.0.0"),
  AI_GATEWAY_PORT: z.coerce.number().int().positive().default(4034),
});

const parsed = envSchema.parse(process.env);

export const env = {
  host: parsed.AI_GATEWAY_HOST,
  port: parsed.AI_GATEWAY_PORT,
};
