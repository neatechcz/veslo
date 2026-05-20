# Owned Server Production Environment Inventory

This inventory maps the production environment needed for the VSLO-185 owned-server migration. Store actual values only in the server-side env file or secret manager. Do not commit secrets.

## Source Rules

- Preserve continuity secrets from the current Render/Vercel production services when existing data depends on them.
- Generate new database bootstrap passwords for owned-server MySQL containers before the first restore.
- Keep temporary Render and Vercel worker-provisioning values until the owned-server worker provisioner replaces them in Phase 6.
- Use Lettr over HTTPS for auth email. Direct SMTP is not required.

## Den

| Variable | Source | Migration note |
| --- | --- | --- |
| `DATABASE_URL` | Owned-server env file | Points to `den-db` after restore. |
| `BETTER_AUTH_SECRET` | Existing Den production secret | Preserve for auth/session continuity. |
| `BETTER_AUTH_URL` | Owned-server domain | Use `https://api.veslo.work` for the owned-server cutover. |
| `WORKER_TOKEN_ENCRYPTION_KEY` | Existing Den production secret | Preserve so restored worker host tokens remain decryptable. |
| `GITHUB_CLIENT_ID` | Existing OAuth app or new owned-server OAuth app | OAuth callback domains must match the selected production domain. |
| `GITHUB_CLIENT_SECRET` | Existing OAuth app or new owned-server OAuth app | Keep out of git. |
| `LETTR_API_KEY` | Lettr | Required when auth email delivery is enabled. |
| `AUTH_EMAIL_ADDRESS` | Lettr sender config | Required with `LETTR_API_KEY`. |
| `AUTH_EMAIL_FROM_NAME` | Lettr sender config | User-facing sender display name. |
| `DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED` | Existing production policy | Keep aligned with current auth behavior during cutover. |
| `CORS_ORIGINS` | Owned-server domains | Include `https://app.veslo.work` and any temporary staging origins. Do not use `*` in production. |
| `PROVISIONER_MODE` | Existing migration decision | Use `render` until Phase 6 replaces Render worker provisioning. |
| `WORKER_URL_TEMPLATE` | Optional owned-server worker phase value | Leave empty while Render worker provisioning remains active. |

## Temporary Render Worker Provisioning

| Variable | Source | Migration note |
| --- | --- | --- |
| `RENDER_API_BASE` | Existing production value or default | Usually `https://api.render.com/v1`. |
| `RENDER_API_KEY` | Existing production secret | Required while `PROVISIONER_MODE=render`. |
| `RENDER_OWNER_ID` | Existing production value | Required while `PROVISIONER_MODE=render`. |
| `RENDER_WORKER_REPO` | Existing production value | Keep current worker source repo. |
| `RENDER_WORKER_BRANCH` | Existing production value | Keep current worker branch until Phase 6. |
| `RENDER_WORKER_ROOT_DIR` | Existing production value | Usually `services/den-worker-runtime`. |
| `RENDER_WORKER_PLAN` | Existing production value | Keep current worker size. |
| `RENDER_WORKER_REGION` | Existing production value | Keep current worker region unless intentionally changed. |
| `RENDER_WORKER_VESLO_VERSION` | Existing production value | Pin to the intended released worker version. |
| `RENDER_WORKER_NAME_PREFIX` | Existing production value | Keep naming stable for operator visibility. |
| `RENDER_WORKER_PUBLIC_DOMAIN_SUFFIX` | Existing production value | Needed if Render workers keep vanity domains during transition. |
| `RENDER_CUSTOM_DOMAIN_READY_TIMEOUT_MS` | Existing production value or default | Domain readiness wait. |
| `RENDER_PROVISION_TIMEOUT_MS` | Existing production value or default | Worker create wait. |
| `RENDER_HEALTHCHECK_TIMEOUT_MS` | Existing production value or default | Worker health wait. |
| `RENDER_POLL_INTERVAL_MS` | Existing production value or default | Render poll cadence. |

## Temporary Vercel Worker-Domain Integration

| Variable | Source | Migration note |
| --- | --- | --- |
| `VERCEL_API_BASE` | Existing production value or default | Usually `https://api.vercel.com`. |
| `VERCEL_TOKEN` | Existing production secret | Required only while temporary vanity worker domains remain enabled. |
| `VERCEL_TEAM_ID` | Existing production value | Optional team selector. |
| `VERCEL_TEAM_SLUG` | Existing production value | Optional team selector. |
| `VERCEL_DNS_DOMAIN` | Existing production value | Domain controlled by Vercel integration. |

## Polar

| Variable | Source | Migration note |
| --- | --- | --- |
| `POLAR_FEATURE_GATE_ENABLED` | Existing production policy | If `true`, the remaining `POLAR_*` values are required. |
| `POLAR_API_BASE` | Existing production value or default | Usually `https://api.polar.sh`. |
| `POLAR_ACCESS_TOKEN` | Existing production secret | Required when the paywall is enabled. |
| `POLAR_PRODUCT_ID` | Existing production value | Required when the paywall is enabled. |
| `POLAR_BENEFIT_ID` | Existing production value | Required when the paywall is enabled. |
| `POLAR_SUCCESS_URL` | Owned-server or existing production URL | Must match production checkout return behavior. |
| `POLAR_RETURN_URL` | Owned-server or existing production URL | Must match production checkout return behavior. |

## YouTrack Feedback Projection

| Variable | Source | Migration note |
| --- | --- | --- |
| `YOUTRACK_PROJECT_KEY` | Existing production value | Expected `VSLO`. |
| `YOUTRACK_MCP_COMMAND` | Existing production value | Use only for stdio MCP mode. |
| `YOUTRACK_MCP_ARGS` | Existing production value or secret | JSON string array for stdio MCP mode. |
| `YOUTRACK_MCP_TIMEOUT_MS` | Existing production value or default | Remote call timeout. |
| `YOUTRACK_MCP_WIRE_PROTOCOL` | Existing production value or default | `content-length` or `line`. |
| `YOUTRACK_MCP_URL` | Existing production secret/value | Remote HTTP MCP URL when using HTTP mode. |
| `YOUTRACK_MCP_TOKEN` | Existing production secret | Remote MCP token when using HTTP mode. |

## Den Debug-Log Ingest

| Variable | Source | Migration note |
| --- | --- | --- |
| `DEN_LOG_INGEST_TOKEN` | Existing production secret | Preserve for desktop/server upload compatibility. |
| `DEN_LOG_MASTER_KEY` | Existing production secret | Preserve so restored encrypted debug logs remain decryptable. |
| `DEN_LOG_MASTER_KEY_VERSION` | Existing production value | Keep aligned with the restored rows. |
| `DEN_LOG_RETENTION_DAYS` | Existing production value or default | Retention policy. |

## Den-Managed AI

| Variable | Source | Migration note |
| --- | --- | --- |
| `MANAGED_AI_DATABASE_URL` | Owned-server or shared managed-AI database | Set with `MANAGED_AI_SECRET_KEY` or leave both unset. |
| `MANAGED_AI_SECRET_KEY` | Existing production secret | Preserve when restored managed-AI credentials depend on it. |
| `MANAGED_AI_OPENAI_CLIENT_ID` | Existing production OAuth value | Set with the OpenAI OAuth fallback group or leave the group unset. |
| `MANAGED_AI_OPENAI_CLIENT_SECRET` | Existing production secret | Set with the OpenAI OAuth fallback group or leave the group unset. |
| `MANAGED_AI_OPENAI_REDIRECT_BASE` | Owned-server domain | Use owned-server redirect base if Den handles this flow. |
| `MANAGED_AI_CODEX_COMMAND` | Existing production value or default | Usually `codex`. |
| `MANAGED_AI_CODEX_HOME` | Owned-server volume path | Mounted through the Den Codex volume. |
| `MANAGED_AI_CODEX_ALLOW_HOST_HOME` | Existing production policy | Leave empty unless explicitly approved. |
| `MANAGED_AI_CODEX_WORKDIR` | Existing production value or default | Usually `/tmp`. |
| `MANAGED_AI_CODEX_TIMEOUT_MS` | Existing production value or default | Codex worker timeout. |
| `MANAGED_AI_CODEX_STATUS_TTL_MS` | Existing production value or default | Codex status cache TTL. |
| `MANAGED_AI_CODEX_AUTH_JSON` | Existing production secret | Required when Den-managed Codex runtime owns Codex OAuth execution. |
| `MANAGED_AI_CODEX_OAUTH_INFERENCE_BASE_URL` | Existing production value | Optional proxy override. |
| `MANAGED_AI_CODEX_OAUTH_BASE_URL` | Existing production value | Optional proxy override. |

## Standalone AI Gateway

| Variable | Source | Migration note |
| --- | --- | --- |
| `AI_GATEWAY_DATABASE_URL` | Owned-server env file | Points to `ai-gateway-db` after restore. |
| `AI_GATEWAY_SECRET_KEY` | Existing AI Gateway production secret | Preserve for encrypted credential continuity. |
| `AI_GATEWAY_OPENAI_CLIENT_ID` | Existing production OAuth value | Required by current gateway env parser. |
| `AI_GATEWAY_OPENAI_CLIENT_SECRET` | Existing production secret | Required by current gateway env parser. |
| `AI_GATEWAY_OPENAI_REDIRECT_BASE` | Owned-server domain | Use `https://ai.veslo.work/auth/openai`. |
| `AI_GATEWAY_DEN_API_BASE` | Owned-server Den domain | Use `https://api.veslo.work`. |
| `AI_GATEWAY_CODEX_COMMAND` | Existing production value or default | Usually `codex`. |
| `AI_GATEWAY_CODEX_HOME` | Owned-server volume path | Mounted through the AI Gateway Codex volume. |
| `AI_GATEWAY_CODEX_ALLOW_HOST_HOME` | Existing production policy | Leave empty unless explicitly approved. |
| `AI_GATEWAY_CODEX_WORKDIR` | Existing production value or default | Usually `/tmp`. |
| `AI_GATEWAY_CODEX_TIMEOUT_MS` | Existing production value or default | Codex worker timeout. |
| `AI_GATEWAY_CODEX_STATUS_TTL_MS` | Existing production value or default | Codex status cache TTL. |
| `AI_GATEWAY_CODEX_AUTH_JSON` | Existing production secret | Required when standalone AI Gateway owns Codex OAuth execution. |
| `AI_GATEWAY_CODEX_OAUTH_INFERENCE_BASE_URL` | Existing production value | Optional proxy override. |
| `AI_GATEWAY_CODEX_OAUTH_BASE_URL` | Existing production value | Optional proxy override. |

## Web App

| Variable | Source | Migration note |
| --- | --- | --- |
| `DEN_API_BASE` | Owned-server Den domain | Use `https://api.veslo.work`. |
| `DEN_AUTH_ORIGIN` | Owned-server Den domain | Use `https://api.veslo.work`. |
| `NEXT_PUBLIC_OPENWORK_APP_CONNECT_URL` | Existing production value | Legacy public connect URL if still used. |
| `NEXT_PUBLIC_OPENWORK_AUTH_CALLBACK_URL` | Owned-server app domain | Use `https://app.veslo.work`. |
| `NEXT_PUBLIC_VESLO_APP_CONNECT_URL` | Existing production value | Current public connect URL used by the cloud control UI. |
| `NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL` | Owned-server app domain | Use `https://app.veslo.work`. |
| `NEXT_PUBLIC_POSTHOG_KEY` | Existing production value | Analytics project key. |
| `NEXT_PUBLIC_POSTHOG_API_KEY` | Existing production value | Legacy/current alternate analytics key if used. |
| `NEXT_PUBLIC_POSTHOG_HOST` | Existing production value or default | Usually `https://us.i.posthog.com`. |
| `LOOPS_API_KEY` | Existing production secret | Required only when signup contact capture is enabled. |
