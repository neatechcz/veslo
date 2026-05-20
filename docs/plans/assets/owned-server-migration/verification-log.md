# Owned Server Migration Verification Log

This log records sanitized verification evidence for the VSLO-185 owned-server migration phases.

## 2026-05-20 - Phase 0 prerequisites documentation

- Worktree: `.worktrees/vslo-185-owned-server-migration`.
- Dependency setup: `pnpm install --frozen-lockfile --store-dir .pnpm-store` completed with generated-bin warnings for packages whose `dist` outputs are created by later builds.
- Baseline: `pnpm --filter @neatech/den test` passed with 248 passing, 1 skipped.
- Baseline: `pnpm --filter @neatech/ai-gateway test` passed with 199 passing.
- Scope: documented owned-server production host prerequisites in the canonical cloud deployment docs and linked the migration plan to that durable record.

## 2026-05-20 - Phase 1 Task 2 Compose skeleton

- Scope: added the repo-owned owned-server Compose skeleton, Caddy routes, env template, and operator README.
- Local validation: `docker compose -f packaging/owned-server/compose.yml config` exited 0. No containers were started.
- Server validation: copied the skeleton to `/home/neatech/veslo-owned-server-config-check` on `62.109.146.43`; `sudo docker compose --env-file packaging/owned-server/env.example -f packaging/owned-server/compose.yml config --quiet` exited 0. No containers were started.

## 2026-05-20 - Phase 1 Task 3 production builds

- Build validation: `pnpm --filter @neatech/den build` exited 0.
- Build validation: `pnpm --filter @neatech/ai-gateway build` exited 0.
- Build validation: `pnpm --filter @neatech/veslo-web build` exited 0.
- Scope: wired owned-server app services to Docker image build targets that enable Corepack, prepare `pnpm@10.27.0`, install from `pnpm-lock.yaml`, run each service build, and start with the existing package start script.
- Health checks: Compose defines Den `/health`, AI Gateway `/health`, and web `/` checks.
- Local validation: `/usr/bin/env -u YOUTRACK_MCP_TOKEN -u YOUTRACK_MCP_URL -u YOUTRACK_MCP_ARGS -u RENDER_API_KEY -u VERCEL_TOKEN -u POLAR_ACCESS_TOKEN -u LETTR_API_KEY docker compose --env-file packaging/owned-server/env.example -f packaging/owned-server/compose.yml config --quiet` exited 0.
- Server validation: copied the updated deployment files to `/home/neatech/veslo-owned-server-config-check` on `62.109.146.43`; `sudo docker compose --env-file packaging/owned-server/env.example -f packaging/owned-server/compose.yml config --quiet` exited 0. No containers were started.

## 2026-05-20 - Phase 2 Task 4 production env mapping

- Scope: added a production environment inventory for Den, temporary Render/Vercel worker provisioning, Polar, YouTrack, debug-log ingest, Den-managed AI, standalone AI Gateway, and the web app.
- Template update: `packaging/owned-server/env.example` now points operators to the inventory and flags continuity secrets plus build-time `NEXT_PUBLIC_*` values.
- Verification: `rg -n "DATABASE_URL|BETTER_AUTH|MANAGED_AI|AI_GATEWAY|YOUTRACK|POLAR|RENDER|VERCEL|DEN_LOG|DEN_API_BASE|DEN_AUTH_ORIGIN" docs/plans/assets/owned-server-migration/env-inventory.md packaging/owned-server/env.example` listed the expected migration env families in both files.
- Additional verification: `rg -n "LETTR_API_KEY|AUTH_EMAIL_ADDRESS|AUTH_EMAIL_FROM_NAME|NEXT_PUBLIC_OPENWORK|NEXT_PUBLIC_VESLO|LOOPS_API_KEY|WORKER_TOKEN_ENCRYPTION_KEY|GITHUB_CLIENT" docs/plans/assets/owned-server-migration/env-inventory.md packaging/owned-server/env.example` listed the expected auth-email, web-public, worker-token, and GitHub OAuth keys.

## 2026-05-20 - Phase 3 Task 5 database backup runbook

- Scope: added owned-server MySQL backup and restore runbook plus `backup-mysql.sh` and `restore-mysql.sh`.
- Backup policy: runbook documents daily automated backups, before-cutover manual backups, off-server copies, encryption before long-term storage or transfer, and restore test cadence.
- Restore safety: `restore-mysql.sh` refuses to run without `--apply` and prints a destructive restore warning before piping the dump to MySQL.
- Syntax validation: `bash -n packaging/owned-server/backup/backup-mysql.sh` exited 0.
- Syntax validation: `bash -n packaging/owned-server/backup/restore-mysql.sh` exited 0.
- Runbook validation: `rg -n "daily|before production cutover|off-server|Encrypt|restore|--apply|backup-mysql|restore-mysql|sudo docker compose" packaging/owned-server/backup/README.md packaging/owned-server/README.md packaging/owned-server/backup/*.sh` listed the expected policy and command language.

## 2026-05-20 - Phase 3 Task 6 rehearsal prerequisite check

- Direct Docker check: `docker ps` on `neatech@62.109.146.43` failed with Docker socket permission denied.
- Sudo Docker check: `sudo docker ps` on `neatech@62.109.146.43` exited 0 and showed no running containers.
- Staging env check: `/srv/veslo/env/staging.env` was not present.
- Dump check: no `.sql`, `.dump`, or `.sql.gz` files were found under the checked `/home/neatech` and `/srv/veslo` paths.
- Result: restore rehearsal was not run. Next prerequisite is to provide a staging env file and a non-production Den/AI Gateway dump copy, or explicitly approve creating a synthetic staging dataset for the rehearsal.
