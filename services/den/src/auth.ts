import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { bearer } from "better-auth/plugins/bearer"
import { db } from "./db/index.js"
import { maybeAssignDefaultManagedAiAccessForNewUser } from "./managed-ai/signup-assignment.js"
import * as schema from "./db/schema.js"
import { fireAndForgetAuthEmail, sendResetPasswordAuthEmail, sendVerificationAuthEmail } from "./email/auth-mailer.js"
import { env, isAuthEmailConfigured } from "./env.js"
import { ensureDefaultOrg } from "./orgs.js"

const socialProviders = env.github.clientId && env.github.clientSecret
  ? {
      github: {
        clientId: env.github.clientId,
        clientSecret: env.github.clientSecret,
      },
    }
  : undefined

const authEmailVerification = isAuthEmailConfigured()
  ? {
      sendOnSignUp: true,
      autoSignInAfterVerification: false,
      sendVerificationEmail: async ({ user, url }: { user: { email: string }; url: string }) => {
        void fireAndForgetAuthEmail(sendVerificationAuthEmail({ to: user.email, url }), "verification email")
      },
    }
  : undefined

const authEmailPasswordReset = isAuthEmailConfigured()
  ? {
      sendResetPassword: async ({ user, url }: { user: { email: string }; url: string }) => {
        void fireAndForgetAuthEmail(sendResetPasswordAuthEmail({ to: user.email, url }), "password reset email")
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
  ...(authEmailVerification ? { emailVerification: authEmailVerification } : {}),
  emailAndPassword: {
    enabled: true,
    requireEmailVerification: false,
    ...(authEmailPasswordReset ?? {}),
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          const name = user.name ?? user.email ?? "Personal"
          await ensureDefaultOrg(user.id, name)
          await maybeAssignDefaultManagedAiAccessForNewUser(user.id)
        },
      },
    },
  },
})
