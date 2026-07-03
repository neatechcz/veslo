import { z } from "zod"
import { parseStripeOrganizationBillingConfig } from "./billing/stripe-config.js"
import { parseManagedAiEnv } from "./managed-ai/env.js"

const schema = z.object({
  DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().min(1),
  WORKER_TOKEN_ENCRYPTION_KEY: z.string().optional(),
  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),
  LETTR_API_KEY: z.string().optional(),
  AUTH_EMAIL_ADDRESS: z.string().optional(),
  AUTH_EMAIL_FROM_NAME: z.string().optional(),
  PORT: z.string().optional(),
  CORS_ORIGINS: z.string().optional(),
  DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: z.string().optional(),
  PROVISIONER_MODE: z.enum(["stub", "render", "owned-server"]).optional(),
  WORKER_URL_TEMPLATE: z.string().optional(),
  OWNED_WORKER_MANAGER_URL: z.string().optional(),
  OWNED_WORKER_MANAGER_TOKEN: z.string().optional(),
  OWNED_WORKER_PUBLIC_DOMAIN_SUFFIX: z.string().optional(),
  RENDER_API_BASE: z.string().optional(),
  RENDER_API_KEY: z.string().optional(),
  RENDER_OWNER_ID: z.string().optional(),
  RENDER_WORKER_REPO: z.string().optional(),
  RENDER_WORKER_BRANCH: z.string().optional(),
  RENDER_WORKER_ROOT_DIR: z.string().optional(),
  RENDER_WORKER_PLAN: z.string().optional(),
  RENDER_WORKER_REGION: z.string().optional(),
  RENDER_WORKER_VESLO_VERSION: z.string().optional(),
  RENDER_WORKER_NAME_PREFIX: z.string().optional(),
  RENDER_WORKER_PUBLIC_DOMAIN_SUFFIX: z.string().optional(),
  RENDER_CUSTOM_DOMAIN_READY_TIMEOUT_MS: z.string().optional(),
  RENDER_PROVISION_TIMEOUT_MS: z.string().optional(),
  RENDER_HEALTHCHECK_TIMEOUT_MS: z.string().optional(),
  RENDER_POLL_INTERVAL_MS: z.string().optional(),
  VERCEL_API_BASE: z.string().optional(),
  VERCEL_TOKEN: z.string().optional(),
  VERCEL_TEAM_ID: z.string().optional(),
  VERCEL_TEAM_SLUG: z.string().optional(),
  VERCEL_DNS_DOMAIN: z.string().optional(),
  POLAR_FEATURE_GATE_ENABLED: z.string().optional(),
  POLAR_API_BASE: z.string().optional(),
  POLAR_ACCESS_TOKEN: z.string().optional(),
  POLAR_PRODUCT_ID: z.string().optional(),
  POLAR_BENEFIT_ID: z.string().optional(),
  POLAR_SUCCESS_URL: z.string().optional(),
  POLAR_RETURN_URL: z.string().optional(),
  STRIPE_ORG_BILLING_ENABLED: z.string().optional(),
  STRIPE_ORG_BILLING_SECRET_KEY: z.string().optional(),
  STRIPE_ORG_BILLING_WEBHOOK_SECRET: z.string().optional(),
  STRIPE_ORG_BILLING_SUCCESS_URL: z.string().optional(),
  STRIPE_ORG_BILLING_CANCEL_URL: z.string().optional(),
  STRIPE_ORG_BILLING_PORTAL_RETURN_URL: z.string().optional(),
  STRIPE_ORG_BILLING_BASIC_MONTHLY_PRICE_ID: z.string().optional(),
  STRIPE_ORG_BILLING_BASIC_ANNUAL_PRICE_ID: z.string().optional(),
  STRIPE_ORG_BILLING_EXTENDED_MONTHLY_PRICE_ID: z.string().optional(),
  STRIPE_ORG_BILLING_EXTENDED_ANNUAL_PRICE_ID: z.string().optional(),
  STRIPE_ORG_BILLING_TAX_MODE: z.string().optional(),
  YOUTRACK_PROJECT_KEY: z.string().optional(),
  YOUTRACK_URL: z.string().optional(),
  YOUTRACK_TOKEN: z.string().optional(),
  YOUTRACK_TIMEOUT_MS: z.string().optional(),
  DEN_LOG_INGEST_TOKEN: z.string().optional(),
  DEN_LOG_MASTER_KEY: z.string().optional(),
  DEN_LOG_MASTER_KEY_VERSION: z.string().optional(),
  DEN_LOG_RETENTION_DAYS: z.string().optional(),
  DEN_AI_GATEWAY_INTERNAL_TOKEN: z.string().optional(),
  MANAGED_AI_DATABASE_URL: z.string().optional(),
  MANAGED_AI_SECRET_KEY: z.string().optional(),
  MANAGED_AI_OPENAI_CLIENT_ID: z.string().optional(),
  MANAGED_AI_OPENAI_CLIENT_SECRET: z.string().optional(),
  MANAGED_AI_OPENAI_REDIRECT_BASE: z.string().optional(),
  GOOGLE_WORKSPACE_OAUTH_CLIENT_ID: z.string().optional(),
  GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET: z.string().optional(),
  GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI: z.string().optional(),
  GOOGLE_WORKSPACE_OAUTH_STATE_SECRET: z.string().optional(),
  GOOGLE_WORKSPACE_OAUTH_SUCCESS_REDIRECT_URL: z.string().optional(),
  GOOGLE_WORKSPACE_TOKEN_SECRET_KEY: z.string().optional(),
  GOOGLE_WORKSPACE_CONNECTOR_BASE_URL: z.string().optional(),
})

function parseJsonStringArray(raw: string | undefined, label: string) {
  if (!raw || raw.trim().length === 0) {
    return []
  }

  let parsedValue: unknown
  try {
    parsedValue = JSON.parse(raw)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`${label} must be a JSON string array. ${message}`)
  }

  if (!Array.isArray(parsedValue) || parsedValue.some((entry) => typeof entry !== "string")) {
    throw new Error(`${label} must be a JSON string array.`)
  }

  return parsedValue.map((entry) => entry.trim()).filter(Boolean)
}

function parsePositiveNumber(raw: string | undefined, fallback: number, label: string) {
  const parsedValue = Number(raw ?? String(fallback))
  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    throw new Error(`${label} must be a positive number.`)
  }

  return parsedValue
}

function normalizeOrigin(origin: string): string {
  const value = origin.trim()
  if (value === "*") {
    return value
  }
  return value.replace(/\/+$/, "")
}

function normalizedSecret(raw: string | undefined, label: string, minimumLength = 32) {
  const value = raw?.trim() || null
  if (!value) {
    return null
  }
  if (value.length < minimumLength) {
    throw new Error(`${label} must be at least ${minimumLength} characters.`)
  }
  return value
}

export function parseEnv(input: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.parse(input)
  const corsOrigins = parsed.CORS_ORIGINS?.split(",").map((origin) => normalizeOrigin(origin)).filter(Boolean)
  const polarFeatureGateEnabled = (parsed.POLAR_FEATURE_GATE_ENABLED ?? "false").toLowerCase() === "true"
  const nodeEnv = (input.NODE_ENV ?? "development").toLowerCase()
  const googleOauthClientId = parsed.GOOGLE_WORKSPACE_OAUTH_CLIENT_ID?.trim() || null
  const googleOauthClientSecret = parsed.GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET?.trim() || null
  const googleTokenSecretKey = normalizedSecret(
    parsed.GOOGLE_WORKSPACE_TOKEN_SECRET_KEY,
    "GOOGLE_WORKSPACE_TOKEN_SECRET_KEY",
  )
  const googleOauthConfigured = Boolean(googleOauthClientId || googleOauthClientSecret)

  if (nodeEnv === "production" && (corsOrigins ?? []).includes("*")) {
    throw new Error("CORS_ORIGINS cannot contain '*' in production for DEN")
  }
  if (nodeEnv === "production" && googleOauthConfigured) {
    if (!googleOauthClientId || !googleOauthClientSecret) {
      throw new Error("GOOGLE_WORKSPACE_OAUTH_CLIENT_ID and GOOGLE_WORKSPACE_OAUTH_CLIENT_SECRET must be configured together.")
    }
    if (!googleTokenSecretKey) {
      throw new Error("GOOGLE_WORKSPACE_TOKEN_SECRET_KEY is required when Google Workspace OAuth is enabled in production.")
    }
  }

  return {
    databaseUrl: parsed.DATABASE_URL,
    betterAuthSecret: parsed.BETTER_AUTH_SECRET,
    betterAuthUrl: parsed.BETTER_AUTH_URL,
    workerTokenEncryptionKey: parsed.WORKER_TOKEN_ENCRYPTION_KEY?.trim() || null,
    github: {
      clientId: parsed.GITHUB_CLIENT_ID?.trim() || undefined,
      clientSecret: parsed.GITHUB_CLIENT_SECRET?.trim() || undefined,
    },
    email: {
      lettrApiKey: parsed.LETTR_API_KEY?.trim() || undefined,
      address: parsed.AUTH_EMAIL_ADDRESS?.trim() || undefined,
      fromName: parsed.AUTH_EMAIL_FROM_NAME?.trim() || undefined,
    },
    port: Number(parsed.PORT ?? "8788"),
    corsOrigins: corsOrigins ?? [],
    desktopAuthRequireEmailVerified:
      (parsed.DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED ?? "false").toLowerCase() === "true",
    provisionerMode: parsed.PROVISIONER_MODE ?? "stub",
    workerUrlTemplate: parsed.WORKER_URL_TEMPLATE,
    ownedWorkerManager: {
      url: parsed.OWNED_WORKER_MANAGER_URL?.trim().replace(/\/+$/, "") || undefined,
      token: parsed.OWNED_WORKER_MANAGER_TOKEN?.trim() || undefined,
      publicDomainSuffix: parsed.OWNED_WORKER_PUBLIC_DOMAIN_SUFFIX?.trim() || undefined,
    },
    render: {
      apiBase: parsed.RENDER_API_BASE ?? "https://api.render.com/v1",
      apiKey: parsed.RENDER_API_KEY,
      ownerId: parsed.RENDER_OWNER_ID,
      workerRepo: parsed.RENDER_WORKER_REPO ?? "https://github.com/neatechcz/veslo",
      workerBranch: parsed.RENDER_WORKER_BRANCH ?? "dev",
      workerRootDir: parsed.RENDER_WORKER_ROOT_DIR ?? "services/den-worker-runtime",
      workerPlan: parsed.RENDER_WORKER_PLAN ?? "standard",
      workerRegion: parsed.RENDER_WORKER_REGION ?? "oregon",
      workerVesloVersion: parsed.RENDER_WORKER_VESLO_VERSION ?? "0.11.113",
      workerNamePrefix: parsed.RENDER_WORKER_NAME_PREFIX ?? "den-worker",
      workerPublicDomainSuffix: parsed.RENDER_WORKER_PUBLIC_DOMAIN_SUFFIX,
      customDomainReadyTimeoutMs: Number(parsed.RENDER_CUSTOM_DOMAIN_READY_TIMEOUT_MS ?? "240000"),
      provisionTimeoutMs: Number(parsed.RENDER_PROVISION_TIMEOUT_MS ?? "900000"),
      healthcheckTimeoutMs: Number(parsed.RENDER_HEALTHCHECK_TIMEOUT_MS ?? "180000"),
      pollIntervalMs: Number(parsed.RENDER_POLL_INTERVAL_MS ?? "5000"),
    },
    vercel: {
      apiBase: parsed.VERCEL_API_BASE ?? "https://api.vercel.com",
      token: parsed.VERCEL_TOKEN,
      teamId: parsed.VERCEL_TEAM_ID,
      teamSlug: parsed.VERCEL_TEAM_SLUG,
      dnsDomain: parsed.VERCEL_DNS_DOMAIN,
    },
    polar: {
      featureGateEnabled: polarFeatureGateEnabled,
      apiBase: parsed.POLAR_API_BASE ?? "https://api.polar.sh",
      accessToken: parsed.POLAR_ACCESS_TOKEN,
      productId: parsed.POLAR_PRODUCT_ID,
      benefitId: parsed.POLAR_BENEFIT_ID,
      successUrl: parsed.POLAR_SUCCESS_URL,
      returnUrl: parsed.POLAR_RETURN_URL,
    },
    organizationBilling: {
      stripe: parseStripeOrganizationBillingConfig(parsed),
    },
    youtrack: {
      projectKey: parsed.YOUTRACK_PROJECT_KEY?.trim() || null,
      baseUrl: parsed.YOUTRACK_URL?.trim().replace(/\/+$/, "") || null,
      token: parsed.YOUTRACK_TOKEN?.trim() || null,
      timeoutMs: parsePositiveNumber(parsed.YOUTRACK_TIMEOUT_MS, 20_000, "YOUTRACK_TIMEOUT_MS"),
    },
    debugLogs: {
      ingestToken: parsed.DEN_LOG_INGEST_TOKEN?.trim() || null,
      masterKey: parsed.DEN_LOG_MASTER_KEY?.trim() || null,
      masterKeyVersion: parsed.DEN_LOG_MASTER_KEY_VERSION?.trim() || null,
      retentionDays: parsePositiveNumber(parsed.DEN_LOG_RETENTION_DAYS, 30, "DEN_LOG_RETENTION_DAYS"),
    },
    aiGatewayInternalToken: parsed.DEN_AI_GATEWAY_INTERNAL_TOKEN?.trim() || null,
    managedAi: parseManagedAiEnv(parsed),
    googleWorkspace: {
      oauthClientId: googleOauthClientId,
      oauthClientSecret: googleOauthClientSecret,
      oauthRedirectUri: parsed.GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI?.trim() || null,
      oauthStateSecret:
        parsed.GOOGLE_WORKSPACE_OAUTH_STATE_SECRET?.trim() || parsed.BETTER_AUTH_SECRET.trim(),
      oauthSuccessRedirectUrl:
        parsed.GOOGLE_WORKSPACE_OAUTH_SUCCESS_REDIRECT_URL?.trim() ||
        "https://app.veslo.work/settings/integrations/google",
      tokenSecretKey: googleTokenSecretKey,
      connectorBaseUrl: parsed.GOOGLE_WORKSPACE_CONNECTOR_BASE_URL?.trim().replace(/\/+$/, "") ||
        parsed.BETTER_AUTH_URL.trim().replace(/\/+$/, ""),
    },
  }
}

export const env = parseEnv()

export function isAuthEmailConfigured() {
  return Boolean(env.email.lettrApiKey && env.email.address)
}
