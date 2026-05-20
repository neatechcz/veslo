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

## 2026-05-20 - Phase 3 Task 6 isolated staging rehearsal path

- Scope: added a staging env template and runbook for restore rehearsal using Compose project `veslo-owned-server-staging`.
- Safety: the rehearsal path starts only `den`, `ai-gateway`, and database dependencies; `proxy` is not started and public ports 80/443 are not bound.
- Sudo Docker path: Task 6 now treats `sudo docker ps` and `sudo docker compose ...` as the approved server path when direct Docker socket access fails.
- Synthetic fallback: documented an explicit synthetic-dump path for cases where no real non-production dump is available; this validates restore mechanics and migration commands, not production-data compatibility.
- Local validation: `/usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/michal docker compose -p veslo-owned-server-staging --env-file packaging/owned-server/env.staging.example -f packaging/owned-server/compose.yml config --quiet` exited 0. No containers were started.
- Runbook validation: `rg -n "veslo-owned-server-staging|env.staging.example|Synthetic Fallback|sudo docker ps|80/443|proxy" docs/plans/2026-05-19-veslo-owned-server-migration.md packaging/owned-server/README.md packaging/owned-server/backup/README.md packaging/owned-server/rehearsal/README.md` listed the expected staging, sudo Docker, synthetic fallback, and proxy safety language.
- Whitespace validation: `git diff --check` exited 0.

## 2026-05-20 - Phase 3 Task 6 synthetic staging rehearsal

- Scope: ran an approved synthetic restore rehearsal on `62.109.146.43` using Compose project `veslo-owned-server-staging`.
- Server path: used `/home/neatech/veslo-owned-server-staging-rehearsal-8b75cf07` because general sudo for creating `/srv/veslo` was unavailable; `sudo -n docker ...` remained available and was used for all Docker commands.
- Compose validation: `sudo -n docker compose -p veslo-owned-server-staging -f packaging/owned-server/compose.yml --env-file <home-rehearsal-env> config --quiet` exited 0.
- Initial issue: starting long-lived app containers before running migrations caused boot-time schema reconciliation to create tables first, then Den migration failed on an already-existing table. Runbook was corrected to start database services only, restore dumps, run one-off migrations, then start app services.
- Initial issue: Den migration files contained multiple SQL statements without Drizzle statement breakpoints. Added a focused regression test and statement breakpoints in Den migration SQL files.
- Initial issue: Den main migrations targeted managed-AI tables owned by the AI Gateway database. Added a focused ownership regression test and changed the Den managed-AI migration entries to no-op statements so Den `DATABASE_URL` migrations do not mutate AI Gateway tables.
- Synthetic restore: `den-db` and `ai-gateway-db` became healthy, both synthetic dumps restored through `restore-mysql.sh --apply`, and both sentinel row checks returned `1`.
- Build validation: `sudo -n docker compose -p veslo-owned-server-staging ... build den ai-gateway` built both images successfully.
- Migration validation: one-off Den migration exited with `migrations applied successfully`.
- Migration validation: one-off AI Gateway migration exited with `migrations applied successfully`.
- App validation: `sudo -n docker compose -p veslo-owned-server-staging ... up -d den ai-gateway` started both app services; `ps` showed Den, AI Gateway, and both MySQL containers healthy.
- Port safety: `sudo -n docker ps --format 'table {{.Names}}\t{{.Ports}}'` showed only internal container ports `8788/tcp`, `4034/tcp`, `3306/tcp`, and `33060/tcp`; `web` and `proxy` were not started and host ports 80/443 were not bound.
- Backup validation: `backup-mysql.sh` wrote staged Den and AI Gateway dumps under the home rehearsal directory.
- Backup checksums: AI Gateway rehearsal dump `3835720f340076d8c098a90ad57cfee21899010dbba19ea3d55fdafaf9267dfa`; Den rehearsal dump `834a253ab704927f65fba226db533c23a33f3ececef25fa332c12fb288c609ed`.
- Teardown: `sudo -n docker compose -p veslo-owned-server-staging ... down -v` removed staging containers, volumes, and network. Final `sudo -n docker ps` showed no running containers.
- Local regression validation: `pnpm --filter @neatech/den exec tsx --test test/drizzle-migration-format.test.ts test/drizzle-migration-ownership.test.ts` passed with 2 passing tests.
- Local suite validation: `pnpm --filter @neatech/den test` passed with 249 passing, 1 skipped.
- Local Compose validation: `/usr/bin/env -i PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin HOME=/home/michal docker compose -p veslo-owned-server-staging --env-file packaging/owned-server/env.staging.example -f packaging/owned-server/compose.yml config --quiet` exited 0.
- Whitespace validation: `git diff --check` exited 0.
- Secret scan: checked migration docs, packaging, and service files for the provided sudo password and real-looking service secrets; no matches were found.
- Limitation: this proves restore, migration, startup, backup, and teardown mechanics with synthetic data only. A real non-production or production dump rehearsal is still required before Phase 5 live traffic cutover.

## 2026-05-20 - Phase 4 Task 7 health verification blocker

- Scope: started dark-launch health verification for `api.veslo.work`, `ai.veslo.work`, and `app.veslo.work`.
- Den health: `curl -fsS --max-time 10 https://api.veslo.work/health` reached DNS but failed to connect to port 443.
- AI Gateway health: `curl -fsS --max-time 10 https://ai.veslo.work/health` reached DNS but failed to connect to port 443.
- Web health: `curl -I --max-time 10 https://app.veslo.work` reached DNS but failed to connect to port 443.
- Server check: `sudo -n docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'` on `62.109.146.43` showed no running containers.
- Result: Phase 4 Task 7 is blocked until a dark-launch stack is started with a real env file, restored data, and a proxy/TLS path. Do not start public `proxy` against synthetic data because these hostnames are already public Veslo names and Phase 5 cutover has not been approved.
- Next prerequisite: provide or create the owned-server env file, restore a real non-production or production dump copy, start the stack without switching live traffic unexpectedly, then rerun Task 7 health checks.

## 2026-05-20 - Phase 4 dark-launch blocker recheck

- Server recheck: `sudo -n docker ps --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}'` on `62.109.146.43` showed no running containers.
- Server port recheck: no listeners were found for ports 80, 443, 8788, 4034, or 3005.
- Server env recheck: no production env file was found under the checked `/srv/veslo` or `/home/neatech` paths; the only env artifact found was the previous synthetic staging rehearsal env.
- Server dump recheck: only synthetic rehearsal dumps, rehearsal backups, and repo migration SQL files were found under the checked paths. No real Den or AI Gateway dump copy was present.
- Local artifact recheck: the migration worktree search found only env examples and Drizzle migration SQL files. No real `.env`, `.sql.gz`, or production dump artifact was found in the migration worktree.
- Local artifact recheck: the main checkout contains an ignored Den `.env`; key-only inspection showed Den/Render-oriented variables but not the full owned-server production env, AI Gateway env, web env, Lettr keys, managed-AI keys, debug-log keys, or dump artifacts. No secret values were printed or copied.
- Server path prep: general sudo for creating `/srv/veslo` is still unavailable through this account, so the default `/srv/veslo` paths remain a maintainer task.
- Server path prep: created user-owned dark-launch input directories under `/home/neatech/veslo-owned-server-dark-launch-inputs` for env, dumps, and backups with mode `700`.
- Safety decision: did not start `proxy` or public TLS because Phase 4 requires production-equivalent env values and real restored data, not synthetic rehearsal data.
- Scope update: added a Phase 4 dark-launch entry gate and runbook so the remaining work is explicit before the health, auth, managed-AI, feedback, debug-log, and backup checks are rerun.
- Result: Phase 4 still cannot pass until the production-equivalent env file and real Den plus AI Gateway dump copies are provided on the server, then restored and migrated through the dark-launch runbook.

## 2026-05-20 - Phase 4 real-data dark launch

- Scope: completed the owned-server production-equivalent env, acquired real Render MySQL data through an AI Gateway Render one-off job, restored Den and AI Gateway databases, migrated/reconciled schemas, started app services and proxy, and ran health/auth/AI/feedback/debug-log checks.
- Deployment source: built and ran commit `20176997` from the owned-server dark-launch checkout on `62.109.146.43`.
- Env completion: generated the server production env from Render service env values plus owned-server database passwords; Lettr SMTP remains the email provider; Den-managed OpenAI OAuth keys stayed fully unset because the source values were blank.
- Dump acquisition: the Den Render service could not run one-off jobs on its free tier, so the dump ran from the starter-plan AI Gateway service against the shared Render MySQL database. Corrected JSON serialization in the temporary dump job before restore.
- Dump evidence: Den and AI Gateway restored from the same corrected real shared dump copy. Sanitized checksum for the restored `.sql.gz` inputs: `768d1e15a1799bb30c89b60008d20a224c6631f107b0d4a8a77f4fd374176938`.
- Restore/migration issue: the shared Render database contained mixed Drizzle migration metadata. Den required controlled migration metadata reconciliation and `worker_token.token` widening to `varchar(512)` before `migrations applied successfully`.
- Restore/migration issue: AI Gateway restored with Den migration metadata in the shared database. AI Gateway migration metadata was reconciled to the gateway journal, then `migrations applied successfully`.
- Additional issue found during Phase 4 smoke: Den debug-log tables were present with an older schema while the `0012_debug_logs` SQL file was missing from Den Drizzle's journal. Added a regression test, updated the journal, reconciled the live dark-launch debug-log schema, and recorded the `0012_debug_logs` hash in `__drizzle_migrations`.
- Additional issue found during Phase 4 smoke: blank Codex OAuth base URL env values were passed as real empty strings, causing AI Gateway to call `/backend-api/codex/responses` as a relative URL. Added Den and AI Gateway regression tests and set the live dark-launch Codex OAuth base values to `https://chatgpt.com`.
- Public health verification from the local machine with normal TLS validation: `https://api.veslo.work/health` returned `{"ok":true}`, `https://ai.veslo.work/health` returned `{"ok":true,"service":"ai-gateway"}`, and `https://app.veslo.work` returned HTTP 200 via Caddy.
- Full Phase 4 smoke run at `2026-05-20T19:06:47.824Z`: API health, AI health, web root, existing bearer auth, desktop auth start/handoff/exchange, exchanged-token `/v1/me`, managed-AI access, Codex OAuth chat completion, feedback projection, debug-log ingest, and debug-log admin lookup all returned `ok: true`.
- Managed-AI evidence: AI access returned enabled `codex_oauth` access with default model `gpt-5.5`; a Codex OAuth chat completion returned HTTP 200 with a response id, model `gpt-5.5`, choices, and usage keys. The AI Gateway database recorded `1` usage row for the smoke session.
- Feedback evidence: feedback projection returned HTTP 201, status `projected`, and YouTrack issue `VSLO-188`. An earlier pre-fix feedback smoke also projected `VSLO-187`.
- Debug-log evidence: ingest returned HTTP 202 with one accepted batch, admin lookup returned HTTP 200 and found the ingested event, and database checks returned `1` matching debug batch plus `1` matching debug event.
- Service status after the passing run: Den, AI Gateway, web, Den DB, and AI Gateway DB were healthy; proxy stayed up on ports 80/443. A recent Den/AI Gateway log scan after the passing smoke run found no matching error lines.
- Local focused regression verification: `pnpm --dir .worktrees/vslo-185-owned-server-migration --filter @neatech/den exec tsx --test test/drizzle-migration-format.test.ts test/managed-ai-codex-oauth-inference-proxy-transport.test.ts` passed with 6 passing tests.
- Local focused regression verification: `pnpm --dir .worktrees/vslo-185-owned-server-migration --filter @neatech/ai-gateway exec tsx --test test/codex-oauth-inference-proxy-transport.test.ts` passed with 4 passing tests.
- Local suite verification: `pnpm --dir .worktrees/vslo-185-owned-server-migration --filter @neatech/den test` passed with 251 passing and 1 skipped.
- Local suite verification: `pnpm --dir .worktrees/vslo-185-owned-server-migration --filter @neatech/ai-gateway test` passed with 200 passing.
- Whitespace verification: `git diff --check` exited 0.
