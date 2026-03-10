import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { bearer } from "better-auth/plugins/bearer"
import { db } from "./db/index.js"
import * as schema from "./db/schema.js"
import { env } from "./env.js"
import { ensureDefaultOrg } from "./orgs.js"

const socialProviders = env.github.clientId && env.github.clientSecret
  ? {
      github: {
        clientId: env.github.clientId,
        clientSecret: env.github.clientSecret,
      },
    }
  : undefined

export const auth = betterAuth({
  baseURL: env.betterAuthUrl,
  secret: env.betterAuthSecret,
  trustedOrigins: env.corsOrigins.length > 0 ? env.corsOrigins : undefined,
  socialProviders,
  database: drizzleAdapter(db, {
    provider: "mysql",
    schema,
  }),
  plugins: [bearer()],
  emailAndPassword: {
    enabled: true,
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const name = user.name ?? user.email ?? "Personal"
          await ensureDefaultOrg(user.id, name)
        },
      },
    },
  },
})
