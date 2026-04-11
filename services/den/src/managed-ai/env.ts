export type ManagedAiEnv = {
  enabled: boolean
  databaseUrl: string | null
  secretKey: string | null
  openAi: {
    clientId: string | null
    clientSecret: string | null
    redirectBase: string | null
  }
}

type ManagedAiEnvInput = {
  MANAGED_AI_DATABASE_URL?: string
  MANAGED_AI_SECRET_KEY?: string
  MANAGED_AI_OPENAI_CLIENT_ID?: string
  MANAGED_AI_OPENAI_CLIENT_SECRET?: string
  MANAGED_AI_OPENAI_REDIRECT_BASE?: string
}

function readOptionalEnv(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

export function parseManagedAiEnv(env: ManagedAiEnvInput): ManagedAiEnv {
  const databaseUrl = readOptionalEnv(env.MANAGED_AI_DATABASE_URL)
  const secretKey = readOptionalEnv(env.MANAGED_AI_SECRET_KEY)
  const clientId = readOptionalEnv(env.MANAGED_AI_OPENAI_CLIENT_ID)
  const clientSecret = readOptionalEnv(env.MANAGED_AI_OPENAI_CLIENT_SECRET)
  const redirectBase = readOptionalEnv(env.MANAGED_AI_OPENAI_REDIRECT_BASE)

  const configuredValues = [databaseUrl, secretKey, clientId, clientSecret, redirectBase]
  const configuredCount = configuredValues.filter((value): value is string => Boolean(value)).length

  if (configuredCount === 0) {
    return {
      enabled: false,
      databaseUrl: null,
      secretKey: null,
      openAi: {
        clientId: null,
        clientSecret: null,
        redirectBase: null,
      },
    }
  }

  if (configuredCount !== configuredValues.length) {
    throw new Error(
      "managed-ai env vars must be configured together: set MANAGED_AI_DATABASE_URL, MANAGED_AI_SECRET_KEY, MANAGED_AI_OPENAI_CLIENT_ID, MANAGED_AI_OPENAI_CLIENT_SECRET, and MANAGED_AI_OPENAI_REDIRECT_BASE or leave them unset",
    )
  }

  return {
    enabled: true,
    databaseUrl,
    secretKey,
    openAi: {
      clientId,
      clientSecret,
      redirectBase,
    },
  }
}
