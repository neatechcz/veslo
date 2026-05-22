# Cloud Deployments

This document defines the operational deploy policy for Veslo cloud services.

Veslo is local-first. Cloud services are data, sync, auth, and provisioning infrastructure. They must not be treated as the default application runtime under test.

## Owned server production host prerequisites

Owned-server production deployments must be defined from repo-owned deployment artifacts, not hand-edited containers. The minimum supported host profile is:

- Ubuntu 24.04 or a compatible Linux host supported by Docker Engine.
- Docker Compose for all long-running Veslo cloud services.
- A deployment account with either direct Docker socket access or validated `sudo docker` and `sudo docker compose` access.
- Public inbound ports 80 and 443 for HTTP validation, TLS issuance, and HTTPS service traffic.
- DNS control for the production app, Den API, AI Gateway, and later worker hostnames.
- Persistent disk for MySQL data, Caddy state, logs, and deployment releases, with a documented path for expansion.
- Off-server backup storage for database dumps and configuration recovery material.
- Outbound HTTPS access for GitHub, npm/pnpm registry traffic, Render and Vercel APIs during transition, OpenAI and other model-provider APIs, Polar, YouTrack, and Lettr.

Auth email delivery uses Lettr over HTTPS. Direct SMTP access is not required for Veslo production auth email.

Before live traffic moves to an owned server, operators must confirm firewall ownership, OS patching ownership, backup ownership, restore testing cadence, monitoring/alerting ownership, and whether the host should run with swap or remain no-swap by policy.

## Managed-AI routing and admin visibility

Signed-in app identity and desktop handoff can come from DEN, but managed-AI assignment and admin truth follow the service that receives the routed managed-AI request. The inference base URL is separate from DEN auth: desktop and orchestrator defaults route managed-AI requests to the owned standalone AI Gateway at `https://ai.veslo.work`. The previous Render AI Gateway remains available only as a transition and rollback target.

For the standalone gateway, AI Gateway admin is where operators inspect routed usage, rotated credentials, exhausted Codex credentials, OpenAI-compatible custom provider credentials, cached tokens, and credential eligibility. DEN admin and standalone AI Gateway admin show the same assignment and credential state only when they share the same managed-AI backing database and config.

## Den control plane on Render

The Den control-plane Render service is deployed explicitly. A commit, push, or merge to `main` or `dev` must not deploy it by itself.

Deploys are run through the `Deploy Den` GitHub Actions workflow. That workflow is intentionally `workflow_dispatch` only.

To deploy Den:

1. Open GitHub Actions.
2. Select `Deploy Den`.
3. Run the workflow manually.
4. Leave the `branch` input empty to use the configured branch resolution, or enter a branch to override it for that run.

The workflow resolves the Render source branch in this order:

1. Manual `branch` workflow input.
2. `DEN_RENDER_CONTROL_PLANE_BRANCH` GitHub Actions variable.
3. The selected workflow branch.

During every manual deploy, the workflow also patches the Render control-plane service with `autoDeploy: no`. This keeps native Render auto-deploy disabled even if the dashboard setting drifted.

## Render auto-deploy policy

Render Auto-Deploy must remain off for the Den control-plane service.

If an operator needs to check or repair the live setting outside GitHub Actions:

1. Open the service in the Render Dashboard.
2. Go to service settings.
3. Set Auto-Deploy to Off.

The equivalent Render API update is:

```json
{
  "autoDeploy": "no"
}
```

Manual deploys remain allowed through the GitHub Actions workflow. Do not use native Render auto-deploy, deploy hooks, or push-triggered GitHub Actions for the Den control plane unless this document and the workflow are updated in the same change.

## Worker services

Den-provisioned worker services are created with Render auto-deploy disabled. Worker service creation is part of the Den provisioning flow, not the control-plane release flow.

During the owned-server migration, Den must keep Render worker provisioning available as rollback until the owned-server worker manager has been verified. The supported migration modes are:

- `stub` for local/dev placeholder workers.
- `render` for the existing Render worker provisioning path.
- `owned-server` for worker containers created on the owned server by the internal worker manager.

In `owned-server` mode, Den calls an internal authenticated worker-manager API. Den must not mount or use the Docker socket directly. The worker manager owns Docker container creation, health checks, lifecycle labels, per-worker workspace volumes, and public wildcard worker routing under `*.workers.veslo.work`.

The production cutover from Render workers to owned-server workers requires one successful staging create/delete cycle before changing production `PROVISIONER_MODE` to `owned-server`. After the switch, run a normal authenticated `POST /v1/workers` cloud-worker create, poll, public `/health`, and delete smoke through the production API before starting the observation window. This API-level smoke catches restored-schema drift and missing worker runtime images that a direct provisioner check can miss.

Render worker configuration must remain present until Phase 7 decommissions Render.

## Verification

For changes to Den deployment behavior:

1. Confirm `Deploy Den` has no `push` trigger.
2. Confirm the workflow patches the Render control-plane service with `autoDeploy: no`.
3. Confirm this document and any service-local deployment notes match the workflow.
4. If a live Render change is required immediately, apply the dashboard/API setting directly or run the manual workflow after the workflow change is available on GitHub.
