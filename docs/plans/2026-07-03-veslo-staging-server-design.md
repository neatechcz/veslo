# Veslo Staging Server Design

## Context

Veslo needs a full staging environment for testing builds that are not ready for
production release. Staging must look like production from an operational
standpoint, but it must not publish desktop updater assets to `neatechcz/veslo-updates`
and must not mutate production server state.

The staging server is:

- Host: `62.109.146.56`
- Access model: VPN2-only for application traffic
- Base domain: `staging.veslo.work`
- Deployment model: manual GitHub Actions workflow on a self-hosted runner
  installed on the staging server, matching the production owned-server runner
  pattern.

The staging desktop app must be a separate manual-download build that connects
to the staging server. Staging desktop updates are manual installs, not automatic
updater feed installs.

## Decisions

1. Use a full staging app plus full staging cloud stack.
2. Run staging deploys manually.
3. Use the staging hostname namespace:
   - `api.staging.veslo.work`
   - `ai.staging.veslo.work`
   - `app.staging.veslo.work`
   - `admin.staging.veslo.work`
   - `*.workers.staging.veslo.work`
4. Use sanitized production-like data for staging.
5. Reuse production external credentials carefully when needed, but every public
   URL, callback URL, CORS origin, and worker domain must be staging-specific.
6. Install a staging self-hosted GitHub Actions runner on the staging server,
   with a staging-only label such as `veslo-staging-server`.
7. Build staging desktop artifacts manually from the private Veslo repository.
   Do not mirror or publish them to `neatechcz/veslo-updates`.
8. Disable or make inert the updater behavior for staging desktop builds.

## Architecture

Staging is a separate environment on `62.109.146.56` with the same service shape
as production:

- Den control plane
- Standalone AI Gateway
- web app
- worker manager
- owned worker runtime image
- MySQL for Den
- MySQL for AI Gateway
- Caddy or equivalent reverse proxy
- backup scheduler

The deployment stack should keep staging names distinct from production names
even though production and staging run on different hosts. The implementation
should use staging-specific values for app directory, env file, Compose project
name, Docker network, image tags, volume names, backup root, and health checks.

Recommended staging server paths:

- Stable checkout: `/home/neatech/veslo-owned-server-staging`
- Runner directory: `/home/neatech/actions-runner-veslo-staging`
- Env file: `/srv/veslo/env/staging.env`
- Backup root: `/srv/veslo/staging/backups`
- Dump input directory: `/srv/veslo/staging/dumps`

If `/srv/veslo` cannot be created with available privileges, use a user-owned
staging input directory and pass the exact paths through workflow variables.

## Hostnames And Routing

Staging DNS should point the staging names to `62.109.146.56`:

- `api.staging.veslo.work` routes to Den.
- `ai.staging.veslo.work` routes to AI Gateway.
- `app.staging.veslo.work` routes to the web app.
- `admin.staging.veslo.work` routes to the AI Gateway admin surface.
- `*.workers.staging.veslo.work` routes to the worker manager.

The current production admin surface lives under AI Gateway `/admin`. For
staging, `admin.staging.veslo.work` should either reverse proxy to the AI Gateway
admin routes or redirect root traffic to the AI Gateway `/admin` path. The user
should not need to remember `ai.staging.veslo.work/admin`.

Application traffic must be VPN2-only. DNS may resolve publicly, but firewall or
host policy must reject non-VPN traffic for staging HTTP/HTTPS and any operator
ports. The self-hosted runner works with this model because it only needs
outbound HTTPS access to GitHub.

## Deployment Flow

Create a separate manual workflow such as `Deploy Staging Server`.

The staging workflow should:

1. Run on `[self-hosted, linux, x64, veslo-staging-server]`.
2. Accept a branch input, defaulting to the workflow ref.
3. Use staging-specific workflow variables for app directory and env file.
4. Authenticate Git fetches with the workflow token, matching the production
   runner pattern.
5. Update or clone the stable staging checkout.
6. Validate the staging Compose config.
7. Build the same service images as production: worker runtime, worker manager,
   backup, Den, AI Gateway, and web.
8. Start database and worker-manager dependencies.
9. Run Den and AI Gateway migrations.
10. Start the full staging stack.
11. Verify internal service health.
12. Verify VPN-accessible staging endpoints.
13. Optionally refresh or run the staging backup scheduler.

The staging workflow must not use production workflow variables, production
runner labels, production app directories, production env file paths, production
backup paths, or production public endpoint checks.

## Staging App Build And Manual Release

Create a separate manual workflow such as `Build Staging App`.

The staging app workflow should:

1. Build desktop artifacts from a selected branch or commit.
2. Use staging service URLs in the app build/configuration.
3. Disable or make inert automatic updater behavior for the staging channel.
4. Upload artifacts only to the private Veslo repository context, such as
   workflow artifacts or a private staging prerelease in `neatechcz/veslo`.
5. Never mirror staging artifacts to `neatechcz/veslo-updates`.
6. Make the build visibly identifiable as staging in artifact names and release
   notes.

The staging desktop app must connect to:

- Den/API: `https://api.staging.veslo.work`
- AI Gateway: `https://ai.staging.veslo.work`
- web/auth callback: `https://app.staging.veslo.work`
- admin: `https://admin.staging.veslo.work`
- workers: `*.workers.staging.veslo.work`

Users install staging builds manually. A newer staging build replaces the older
one through another manual download and install.

## Configuration And Data

The staging env file is the source of truth for staging runtime configuration
and must stay outside git.

Production credentials may be reused only where the operator accepts the risk,
but every environment URL must point to staging:

- Better Auth URL
- CORS origins
- Den API base
- AI Gateway Den API base
- AI Gateway OpenAI redirect base
- web build arguments
- desktop auth callback URL
- Google Workspace OAuth redirect and success URLs
- connector base URLs
- worker public domain suffix
- backup root and alert recipients

Staging data comes from sanitized production snapshots. Restoring a snapshot is
an explicit operator step, not a side effect of a normal deploy.

The staging restore path should:

1. Copy sanitized Den and AI Gateway dumps to the staging server.
2. Restore the dumps into staging database volumes.
3. Run Den and AI Gateway migrations.
4. Verify representative users, organizations, sessions, and AI-access policy.
5. Avoid printing raw dumps, secrets, or user payloads in workflow logs.

## Safety Rules

- Staging must never publish to `neatechcz/veslo-updates`.
- Staging must never use the production runner label.
- Staging must never use the production env file path.
- Staging must never write to the production backup path.
- Staging deploys must be manual-only unless this design is revised.
- Staging database restore must be explicit and must not run silently on every
  deploy.
- Staging endpoint verification must understand VPN-only access; public internet
  failure is not itself a staging failure.
- Production rollback paths stay separate from staging rollback paths.

## Error Handling And Rollback

The staging workflow should fail with a clear phase:

- checkout or fetch
- config validation
- image build
- migration
- service startup
- internal health
- VPN endpoint health
- backup scheduler or backup run

If a deploy fails before service restart, the existing healthy staging stack
should remain running. If it fails after restart, the operator should redeploy a
previous branch or restore the latest staging backup.

Rollback options:

1. Redeploy a previous branch or commit with `Deploy Staging Server`.
2. Restore the latest staging database backup.
3. Stop the staging proxy while keeping database volumes intact if public
   staging exposure must be removed quickly.

## Testing And Acceptance

Server acceptance:

- staging runner is online in GitHub with the staging label
- manual staging deploy completes from the private Veslo repo
- staging DNS resolves to `62.109.146.56`
- VPN2-only access is enforced
- staging endpoints pass health checks
- Den and AI Gateway migrations run successfully
- worker manager is healthy
- wildcard worker routing passes at least one create, health, and delete smoke
- staging backups write only to the staging backup path

App acceptance:

- manual staging desktop artifact is built
- installed staging app connects to staging Den/API, not production
- auth flow returns to staging URLs
- managed AI routes through staging AI Gateway
- admin surface opens through staging
- updater is disabled or inert for staging
- a test user can run one real staging task end-to-end through the Tauri desktop
  app

Documentation acceptance:

- durable docs explain the staging server IP, VPN2-only access, hostnames,
  runner label, env path, deploy workflow, app build workflow, manual install
  process, data restore process, verification steps, and the rule that staging
  never publishes to `neatechcz/veslo-updates`

## Follow-up Implementation Plan

After this design is approved and committed, create an implementation plan that
covers:

1. workflow source guards for staging deploy and staging app build
2. staging env template and docs
3. staging reverse-proxy routing
4. staging deployment workflow
5. staging desktop build workflow and app configuration
6. staging backup/restore docs
7. VPN-only verification guidance
8. final server and desktop acceptance checks
