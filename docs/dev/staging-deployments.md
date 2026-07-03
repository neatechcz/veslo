# Staging Deployments

This document is the canonical runbook for the Veslo staging environment.

Staging is a production-shaped environment for validation work only. It is not
the public release channel, and it never publishes to `neatechcz/veslo-updates`.

## Scope

- Server: `62.109.146.56`
- Network: VPN2-only operator access
- Domain family: `staging.veslo.work`
- Server deploy workflow: `Deploy Staging Server`
- Desktop artifact workflow: `Build Staging App`
- Repository: private `neatechcz/veslo`
- Public updater repository: out of scope

Staging is deployed from this repository and stays in this repository. Do not
move staging artifacts, env files, dumps, or workflow outputs into the public
updater repository.

## Hostnames

DNS for these hostnames must point at `62.109.146.56` from VPN2-connected
operator networks:

- `https://api.staging.veslo.work` routes to Den.
- `https://ai.staging.veslo.work` routes to AI Gateway.
- `https://admin.staging.veslo.work/admin` routes to AI Gateway admin.
- `https://app.staging.veslo.work` routes to the web app.
- `https://<worker-id>.workers.staging.veslo.work` routes to owned-server workers.

Worker routing requires wildcard DNS for `*.workers.staging.veslo.work`.

## Server Runner

The staging server uses a repository self-hosted GitHub Actions runner installed
on the staging server. The runner must have these labels:

- `self-hosted`
- `linux`
- `x64`
- `veslo-staging-server`

Preferred runner directory:

```bash
/home/neatech/actions-runner-veslo-staging
```

The runner connects outbound to GitHub over HTTPS and runs Docker Compose
locally. GitHub-hosted runners should not be used for staging server deploys
because the server is VPN2-only.

## Server Paths

Use these staging paths unless a later runbook deliberately changes them:

```bash
/home/neatech/veslo-staging-server
/srv/veslo/env/staging.env
/srv/veslo/staging/dumps
/srv/veslo/staging/backups
```

The server-side staging env starts from:

```bash
packaging/owned-server/env.staging.example
```

The Caddy routing file is:

```bash
packaging/owned-server/Caddyfile.staging
```

The database rehearsal template remains separate:

```bash
packaging/owned-server/env.rehearsal.example
```

Use rehearsal env files only for isolated restore/migration rehearsals that do
not bind public staging hostnames.

## Deploy Staging Server

Run `Deploy Staging Server` manually from GitHub Actions.

Inputs:

- `branch`: leave empty to deploy the selected workflow ref, or set a branch
  explicitly.
- `install_backup_timer`: keep enabled for normal staging deploys.
- `run_backup_now`: enable when the deploy should immediately create and verify
  a staging backup set.

The workflow uses the `veslo-staging-server` runner, fetches the requested ref
through the job `GITHUB_TOKEN`, builds the owned-server Compose images, runs Den
and AI Gateway migrations, starts the full stack, and verifies these staging
URLs:

```bash
https://api.staging.veslo.work/health
https://ai.staging.veslo.work/health
https://app.staging.veslo.work
https://admin.staging.veslo.work/admin
```

The staging Compose project is `veslo-staging-server`. It must not reuse the
production Compose project, production env path, or production checkout path.

## Build Staging App

Run `Build Staging App` manually from GitHub Actions when a desktop app build
should connect to staging.

The workflow bakes these endpoints into the app build:

```bash
VITE_DEN_API_BASE=https://api.staging.veslo.work
VITE_MANAGED_AI_GATEWAY_BASE_URL=https://ai.staging.veslo.work
VESLO_MANAGED_AI_BASE_URL=https://ai.staging.veslo.work
VITE_VESLO_CONNECT_APP_URL=https://app.staging.veslo.work
VITE_VESLO_UPDATER_ENABLED=false
```

The staging app has a distinct Tauri identity:

```bash
productName=Veslo Staging
identifier=com.neatech.veslo.staging
```

Windows staging MSI builds also use a distinct WiX upgrade code so they do not
upgrade or uninstall the production app.

The workflow uploads private GitHub Actions artifacts only. Staging desktop
builds are installed manually by downloading the workflow artifact and running
the installer. They are not self-updating, do not generate updater artifacts,
and never publish `latest.json`.

## Data

Staging may use sanitized production-like data only. Real production dumps must
not be restored directly unless an operator has explicitly approved the data
handling for that run and the resulting env values remain staging-only.

Recommended flow:

1. Put sanitized dumps under `/srv/veslo/staging/dumps`.
2. Record source, timestamp, and checksum in private operator notes.
3. Restore into the staging Compose project.
4. Run Den and AI Gateway migrations through `Deploy Staging Server`.
5. Verify health, auth, managed-AI, worker create/delete, and backup behavior.
6. Remove obsolete dumps after the verification window.

Never commit dumps, checksums that reveal private storage paths, runner tokens,
or filled env files.

## Verification

After a staging deploy, verify from a VPN2-connected machine:

```bash
curl -fsS https://api.staging.veslo.work/health
curl -fsS https://ai.staging.veslo.work/health
curl -fsSI https://app.staging.veslo.work
curl -fsSI https://admin.staging.veslo.work/admin
```

Verify the internal worker manager from the staging server:

```bash
sudo docker compose \
  -p veslo-staging-server \
  -f /home/neatech/veslo-staging-server/packaging/owned-server/compose.yml \
  --env-file /srv/veslo/env/staging.env \
  exec -T worker-manager \
  node -e "fetch('http://127.0.0.1:8790/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
```

Before connecting users to a staging desktop build, install the newest
`Build Staging App` artifact and confirm:

- Den auth points at `api.staging.veslo.work`.
- Managed AI points at `ai.staging.veslo.work`.
- Connect/share URLs point at `app.staging.veslo.work`.
- Updater checks are disabled for the staging app.

## Boundaries

- Production deploys use `Deploy Owned Server`, `veslo-owned-server`, and
  production hostnames.
- Staging deploys use `Deploy Staging Server`, `veslo-staging-server`, and
  staging hostnames.
- Public production app updates use `neatechcz/veslo-updates`.
- Staging app artifacts are private manual-download artifacts and never publish
  to `neatechcz/veslo-updates`.
