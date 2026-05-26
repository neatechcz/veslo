# Cloud Deployments

This document defines the operational deploy policy for Veslo cloud services.

Veslo is local-first. Cloud services are data, sync, auth, and provisioning infrastructure. They must not be treated as the default application runtime under test.

## Owned server production

Veslo production cloud services run on the owned server through the repo-owned Docker Compose stack. Deployments must be defined from repo-owned deployment artifacts, not hand-edited containers.

The current production entry points are:

- `https://api.veslo.work` for Den.
- `https://ai.veslo.work` for the standalone AI Gateway.
- `https://app.veslo.work` for the web app.
- `https://*.workers.veslo.work` for owned-server cloud workers.

The minimum supported host profile is:

- Ubuntu 24.04 or a compatible Linux host supported by Docker Engine.
- Docker Compose for all long-running Veslo cloud services.
- A deployment account with either direct Docker socket access or validated `sudo docker` and `sudo docker compose` access.
- Public inbound ports 80 and 443 for HTTP validation, TLS issuance, and HTTPS service traffic.
- DNS control for the production app, Den API, AI Gateway, and later worker hostnames.
- Persistent disk for MySQL data, Caddy state, logs, and deployment releases, with a documented path for expansion.
- Off-server backup storage for database dumps and configuration recovery material.
- Outbound HTTPS access for GitHub, npm/pnpm registry traffic, OpenAI and other model-provider APIs, Polar, YouTrack, Lettr, and any transition-only provider APIs that remain enabled in the environment.

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

The workflow creates or updates a stable Git checkout on the owned server, checks out the requested branch, validates the production environment file and Compose file, builds the app and worker images, runs Den and AI Gateway migrations, starts the Compose stack, and verifies internal plus public health endpoints.

Required GitHub Actions configuration:

- A self-hosted runner assigned to this repository with labels `self-hosted`, `linux`, `x64`, and `veslo-owned-server`.
- `OWNED_SERVER_APP_DIR` variable. Defaults to the stable production checkout path.
- `OWNED_SERVER_ENV_FILE` variable. Defaults to the current production env file path on the owned server.

Do not store production secrets in the repository. Keep production environment values in the server-side env file and GitHub secrets only.

## Managed-AI routing and admin visibility

Signed-in app identity and desktop handoff can come from DEN, but managed-AI assignment and admin truth follow the service that receives the routed managed-AI request. The inference base URL is separate from DEN auth: desktop and orchestrator defaults route managed-AI requests to the owned standalone AI Gateway at `https://ai.veslo.work`. The previous Render AI Gateway is a rollback target only.

For the standalone gateway, AI Gateway admin is where operators inspect routed usage, rotated credentials, exhausted Codex credentials, OpenAI-compatible custom provider credentials, cached tokens, and credential eligibility. DEN admin and standalone AI Gateway admin show the same assignment and credential state only when they share the same managed-AI backing database and config.

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
4. Confirm this document and any service-local deployment notes match the workflow.
