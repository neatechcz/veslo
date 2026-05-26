# Owned Server GitHub Actions Design

## Context

Production Veslo cloud traffic now terminates on the owned server at `neatech@62.109.146.43`. The repo still contains Render-oriented deployment workflows for Den and AI Gateway, which no longer match the active production runtime. The owned-server Compose stack is the production deployment unit and includes Den, AI Gateway, web, worker manager, databases, worker runtime image, and Caddy.

## Decision

Create a single `Deploy Owned Server` GitHub Actions workflow and retire the Render deployment workflows. The workflow will deploy the Compose stack over SSH to the owned server. It will operate on a stable server checkout, pull the requested branch from GitHub, rebuild the owned-server images, run Den and AI Gateway migrations, restart the stack, and verify public and internal health checks.

## Workflow Shape

The workflow is manual-only via `workflow_dispatch`. It accepts an optional branch input, defaulting to the workflow ref. Required connection/configuration values come from GitHub secrets or vars:

- `OWNED_SERVER_HOST`, defaulting to `62.109.146.43`
- `OWNED_SERVER_USER`, defaulting to `neatech`
- `OWNED_SERVER_SSH_KEY`
- `OWNED_SERVER_KNOWN_HOSTS`
- `OWNED_SERVER_APP_DIR`, defaulting to `/home/neatech/veslo-owned-server-production`
- `OWNED_SERVER_ENV_FILE`, defaulting to the current production env file path on the host

The default app directory is intentionally stable and separate from the earlier dark-launch directory names. The workflow can clone the repo into that directory if needed; persistent production data remains in Docker volumes and the external env file.

## Deployment Steps

1. Configure SSH from GitHub Actions.
2. SSH into the owned server.
3. Clone or update the server checkout to the selected branch.
4. Validate `packaging/owned-server/compose.yml` with the production env file.
5. Build the worker runtime image and app images.
6. Ensure database services and worker manager are running.
7. Run Den and AI Gateway migrations from the newly built images.
8. Start the full Compose stack.
9. Verify Compose service state, worker-manager local health, and public Den, AI Gateway, and web endpoints.

## Retired Render Workflows

`Deploy Den` and `Deploy AI Gateway` are removed because they mutate Render services. Render remains a historical rollback/decommission topic in docs, not the active GitHub Actions production deployment path.

## Testing

Add a source-level workflow guard that asserts:

- the owned-server workflow exists,
- it uses SSH,
- it runs owned-server Compose commands,
- it runs Den and AI Gateway migrations,
- it does not call Render APIs or use Render secrets,
- the old Render deployment workflows are absent.
