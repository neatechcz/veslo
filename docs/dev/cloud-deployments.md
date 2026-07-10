# Cloud Deployments

This document defines the operational deploy policy for Veslo cloud services.

Veslo is local-first. Cloud services are data, sync, auth, and provisioning infrastructure. They must not be treated as the default application runtime under test.

## Owned server production

Veslo production cloud services run on the owned server through the repo-owned Docker Compose stack. Deployments must be defined from repo-owned deployment artifacts, not hand-edited containers.

The production deployment domain is `veslo.work`. Services derive their public
origins from that domain instead of storing unrelated full URLs in multiple
places:

- `https://api.veslo.work` for Den.
- `https://ai.veslo.work` for the standalone AI Gateway.
- `https://app.veslo.work` for the web app.
- `https://*.workers.veslo.work` for owned-server cloud workers.

Staging uses the same rule with `VESLO_DEPLOYMENT_DOMAIN=staging.veslo.work`,
which derives `api.staging.veslo.work`, `ai.staging.veslo.work`,
`app.staging.veslo.work`, `admin.staging.veslo.work`, and
`workers.staging.veslo.work`. Full URL environment variables such as
`DEN_API_BASE`, `VESLO_MANAGED_AI_BASE_URL`, `AI_GATEWAY_DEN_API_BASE`,
`BETTER_AUTH_URL`, and OAuth redirect URLs are operator overrides only.

The minimum supported host profile is:

- Ubuntu 24.04 or a compatible Linux host supported by Docker Engine.
- Docker Compose for all long-running Veslo cloud services.
- A deployment account with either direct Docker socket access or validated `sudo docker` and `sudo docker compose` access.
- Public inbound ports 80 and 443 for HTTP validation, TLS issuance, and HTTPS service traffic.
- DNS control for the production app, Den API, AI Gateway, and later worker hostnames.
- Persistent disk for MySQL data, Caddy state, logs, and deployment releases, with a documented path for expansion.
- Off-server backup storage for database dumps and configuration recovery material.
- Outbound HTTPS access for GitHub, npm/pnpm registry traffic, OpenAI and other model-provider APIs, Polar, YouTrack, Lettr, and any transition-only provider APIs that remain enabled in the environment.

The owned-server stack owns Den, standalone AI Gateway, the web app, worker manager, and hosted worker traffic. Desktop updater metadata and public release downloads are static public GitHub release assets in the `neatechcz/veslo-updates` repository, not served by the owned-server stack. The Windows MSI build and signing path currently runs on a GitHub-hosted Windows runner, and the updater mirror/publish jobs run on GitHub-hosted Ubuntu runners. Moving desktop updater publishing to owned-server infrastructure would require either a dedicated Windows self-hosted runner for MSI build/signing, or replacing GitHub release hosting and CDN delivery with a repo-owned artifact host. Public bundle publishing is still served by the separate share service until a `share.veslo.work` deployment is added to the owned-server stack.

Auth email delivery uses Lettr over HTTPS. Direct SMTP access is not required for Veslo production auth email.

Operators must keep firewall ownership, OS patching ownership, backup ownership, restore testing cadence, monitoring/alerting ownership, and host swap policy documented for the production server.

## GitHub Actions deployment

Owned-server production deploys are run through the `Deploy Owned Server` GitHub Actions workflow. The workflow is intentionally `workflow_dispatch` only. A commit, push, or merge to `main` or `dev` must not deploy production by itself.

The deploy job runs on the repository self-hosted runner labeled `veslo-owned-server`. That runner must be installed on the owned server because GitHub-hosted runners cannot reliably reach the server over inbound SSH. The runner connects outbound to GitHub over HTTPS and executes the Docker Compose deployment locally on the host.

To deploy production:

1. Open GitHub Actions.
2. Select `Deploy Owned Server`.
3. Run the workflow manually.
4. Leave the `branch` input empty to deploy the selected workflow branch, or enter a branch to override it for that run.
5. Keep `install_backup_timer` enabled for production deploys so the repo-owned Compose backup scheduler is installed or refreshed on the server.
6. Enable `run_backup_now` only when the deploy should also create and verify an immediate database backup set.
7. To migrate managed Codex models, set `codex_model_migration` to the canonical model id and require `run_backup_now=true`; the workflow rejects a migration without a fresh verified backup.
8. Enable `probe_codex_credentials` only with a non-empty `codex_model_migration`. The probe uses the same model and starts only after migration idempotence is verified.

The workflow creates or updates a stable Git checkout on the owned server, checks out the requested branch, validates the production environment file and Compose file, builds the app and worker images, runs Den and AI Gateway migrations, starts the Compose stack, and verifies internal plus public health endpoints. When `install_backup_timer` is enabled, it validates Lettr alert env values and starts the Compose-managed `backup` scheduler. When `run_backup_now` is enabled, it runs the backup container once and verifies the compressed dumps plus checksums. When `codex_model_migration` is non-empty, the workflow then runs a dry run, apply, and post-apply dry run, requires the last result to report `changedCount: 0`, and optionally probes every Codex credential. AI Gateway health is process liveness; use AI Gateway `/readiness` separately when an operator needs the inference-available signal.

Required GitHub Actions configuration:

- A self-hosted runner assigned to this repository with labels `self-hosted`, `linux`, `x64`, and `veslo-owned-server`.
- `OWNED_SERVER_APP_DIR` variable. Defaults to the stable production checkout path.
- `OWNED_SERVER_ENV_FILE` variable. Defaults to the current production env file path on the owned server.
- `VESLO_DEPLOYMENT_DOMAIN` variable when deploying a non-production owned-server environment. Production defaults to `veslo.work`; staging should set `staging.veslo.work`.

Do not store production secrets in the repository. Keep production environment values in the server-side env file and GitHub secrets only.

### GPT-5.6 Sol rollout

The current managed Codex target is GPT-5.6 Sol, canonical model id `gpt-5.6-sol`; do not pass the moving `gpt-5.6` alias. For a manual staging rollout, define the deployment checkout's existing `compose` wrapper with `packaging/owned-server/compose.yml` and the environment-specific server env file, complete and verify a fresh backup, then run:

```bash
compose exec -T ai-gateway pnpm --filter @neatech/ai-gateway \
  ops:codex-model-migration -- --model gpt-5.6-sol
compose exec -T ai-gateway pnpm --filter @neatech/ai-gateway \
  ops:codex-model-migration -- --model gpt-5.6-sol --apply
compose exec -T ai-gateway pnpm --filter @neatech/ai-gateway \
  ops:codex-model-migration -- --model gpt-5.6-sol
compose exec -T ai-gateway pnpm --filter @neatech/ai-gateway \
  ops:codex-credential-probe -- --model gpt-5.6-sol
```

The first migration command is the pre-apply dry run and the third is the post-apply dry run. Their matched counts must agree, and the post-apply result must report `changedCount: 0`. The probe covers every non-deleted Codex credential, including unhealthy records, runs sequentially, continues after individual failures, and persists rotated auth through the encrypted secret store without printing it. Failed or unsupported credentials are reported for reconnect or recovery without changing the `gpt-5.6-sol` model policy or falling back to GPT-5.5. At request time, lazy repair can bind another healthy eligible credential while retaining that model; inference fails only when no eligible replacement can serve the request.

For production, the equivalent guarded workflow dispatch is:

```bash
gh workflow run deploy-owned-server.yml \
  --repo neatechcz/veslo \
  --ref codex/gpt-5-6-sol-backend \
  -f branch=codex/gpt-5-6-sol-backend \
  -f install_backup_timer=true \
  -f run_backup_now=true \
  -f codex_model_migration=gpt-5.6-sol \
  -f probe_codex_credentials=true
```

Treat rollout evidence as separate gates:

1. **Code committed** means the source change has a local commit; it is not yet remote or live.
2. **Code pushed** means the exact commit is present on the remote feature branch; it is not deployed by the push.
3. **Code deployed** means the owned-server workflow checked out that exact revision and its deployment and endpoint checks completed.
4. **Policy migrated** means every enabled and disabled `codex_oauth` policy has `default_model='gpt-5.6-sol'` and `allowed_models_json='["gpt-5.6-sol"]'`, with the post-apply dry run at `changedCount: 0`.
5. **Each credential tested** means every non-deleted Codex credential appears exactly once in the completed sequential probe output; failures remain explicit and do not invalidate coverage of later credentials.
6. **Desktop verified** means a real Tauri desktop run, not a UI-only web server, reads the GPT-5.6 Sol policy and completes the required live multi-message inference scenario.

Do not describe the migration as complete from any earlier gate. In particular, a successful deployment does not prove policy mutation, a migrated policy does not prove credential inference, and credential probes do not prove the desktop path.

## Production ops workflows

Production operations that mutate Den state must run on the owned-server runner
and use the owned-server Compose stack. `Grant Veslo Platform Admin` follows this
policy: it runs on the `veslo-owned-server` runner and executes inside the
running `den` service so database access stays on the owned server.

Do not reintroduce GitHub-hosted production database mutation workflows that
connect through externally reachable database URLs.

## Managed-AI routing and admin visibility

Signed-in app identity and desktop handoff can come from DEN, but managed-AI assignment and admin truth follow the service that receives the routed managed-AI request. The inference base URL is separate from DEN auth: desktop and orchestrator defaults route managed-AI requests to the owned standalone AI Gateway derived from `VESLO_DEPLOYMENT_DOMAIN`. Production derives `https://ai.veslo.work`; staging derives `https://ai.staging.veslo.work`. The previous Render AI Gateway is a rollback target only.

For the standalone gateway, the canonical admin is AI Gateway admin at `/admin` on the derived AI Gateway origin, for example `https://ai.veslo.work/admin` in production and `https://ai.staging.veslo.work/admin` in staging. When Veslo work items or implementation notes say "admin" for managed-AI operations, they mean this AI Gateway admin and its `/admin` subpages. There is no separate DEN admin UI for VSLO-201 managed-AI operations.

AI Gateway admin is where operators inspect organizations, users, routed usage, rotated credentials, exhausted Codex credentials, OpenAI-compatible custom provider credentials, cached tokens, credential eligibility, alerts, and audit events. DEN remains the backend owner for auth, users, organizations, domains, invites, memberships, platform roles, and seat limits; AI Gateway admin calls the DEN-backed admin APIs for that data instead of exposing a second DEN admin shell.

Standalone AI Gateway admin routes under `/admin` are protected before the admin shell is served. A browser without a valid gateway admin session is redirected to the existing DEN desktop-auth login page, and the DEN callback returns to the originally requested admin route. The gateway stores the resulting admin token in an HTTP-only `/admin` cookie and uses that cookie for admin API calls; unauthenticated users must not receive the admin HTML shell for `/admin` or its page routes.

## Retired Render deployment workflows

The legacy Render control-plane and AI Gateway deployment workflows are retired. Do not reintroduce `Deploy Den`, `Deploy AI Gateway`, native Render auto-deploy, deploy hooks, or push-triggered production deploys unless this document and the workflow source are updated in the same change.

Render configuration may remain in environment templates and Compose settings while Render worker provisioning is kept as a rollback mode. That configuration is not the production deployment path.

## Worker services

Worker service creation is part of the Den provisioning flow, not the production release flow.

During the owned-server migration, Den must keep Render worker provisioning available as rollback until the owned-server worker manager has been verified. The supported migration modes are:

- `stub` for local/dev placeholder workers.
- `render` for the existing Render worker provisioning path.
- `owned-server` for worker containers created on the owned server by the internal worker manager.

In `owned-server` mode, Den calls an internal authenticated worker-manager API. Den must not mount or use the Docker socket directly. The worker manager owns Docker container creation, health checks, lifecycle labels, per-worker workspace volumes, and public wildcard worker routing under `*.workers.veslo.work`.

The production cutover from Render workers to owned-server workers requires one successful staging create/delete cycle before changing production `PROVISIONER_MODE` to `owned-server`. After the switch, run a normal authenticated `POST /v1/workers` cloud-worker create, poll, public `/health`, and delete smoke through the production API before starting the observation window. This API-level smoke catches restored-schema drift and missing worker runtime images that a direct provisioner check can miss.

Render worker configuration may remain present only while rollback support is required.

## Verification

For changes to production deployment behavior:

1. Confirm `Deploy Owned Server` has no `push` trigger.
2. Confirm no active GitHub Actions workflow deploys production through Render.
3. Confirm the workflow validates the self-hosted runner path, server-side env file, Compose config, migrations, stack startup, internal worker-manager health, and public Den, AI Gateway, and web endpoints.
4. Confirm the workflow installs or refreshes the owned-server backup scheduler when requested and verifies immediate backup sets when `run_backup_now` is enabled.
5. For a Codex model rollout, confirm the workflow rejects migration without `run_backup_now=true`, runs dry-run/apply/post-dry-run only after backup verification, and delays the optional credential probe until `changedCount: 0` is proven.
6. Confirm this document and any service-local deployment notes match the workflow.
