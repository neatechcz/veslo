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

## 2026-05-21 - Phase 5 production cutover

- Scope: executed the owned-domain production cutover checks and changed new-build defaults away from Render toward the owned server.
- Current routing: `dig +short app.veslo.work` returned `62.109.146.43`; `dig +short api.veslo.work` and `dig +short ai.veslo.work` returned `app.veslo.work.` then `62.109.146.43`.
- Owned-server stack: Den, AI Gateway, web, Den DB, and AI Gateway DB were healthy; proxy stayed up on public ports 80 and 443.
- Public health verification: `https://api.veslo.work/health` returned `{"ok":true}`, `https://ai.veslo.work/health` returned `{"ok":true,"service":"ai-gateway"}`, and `https://app.veslo.work` returned HTTP 200 via Caddy.
- Phase 5 owned-server backup: Den and AI Gateway MySQL dumps were written under the server backup area at `20260521T150108Z`.
- Backup checksums: AI Gateway dump `b1cee8b9c85b1869fbf0e495de5c0604f11abcfa02714de3a68b1e6c56b7158b`; Den dump `7141b292c494fa98dc8c59115de5e22340a21d2535c3550e097cf73e0486a915`.
- Backup script issue: the server checkout had backup scripts without executable mode, so the successful backup used `bash packaging/owned-server/backup/backup-mysql.sh`. The migration branch now tracks the backup and restore scripts as executable so the documented direct invocation works in future checkouts.
- Render rollback target check: `https://den-control-plane-veslo.onrender.com/health` and `https://veslo-ai-gateway-dev.onrender.com/health` both returned HTTP 200 with Render headers.
- Phase 5 smoke run at `2026-05-21T15:02:50.971Z`: API health, AI health, web root, existing bearer auth, desktop auth start/handoff/exchange, exchanged-token `/v1/me`, managed-AI access, Codex OAuth chat completion, feedback projection, debug-log ingest, and debug-log admin lookup all returned `ok: true`.
- Managed-AI evidence: AI access returned enabled `codex_oauth` access with default model `gpt-5.5`; a Codex OAuth chat completion returned HTTP 200 with response id `resp_069897f265ed0a33016a0f1e99d4cc8191a400bb6fd80b7b74`, model `gpt-5.5`, choices, and usage keys.
- Feedback evidence: feedback projection returned HTTP 201, status `projected`, and YouTrack issue `VSLO-189`.
- Debug-log evidence: ingest returned HTTP 202 with one accepted batch, admin lookup returned HTTP 200, and the ingested event was found.
- Post-smoke logs: recent Den and AI Gateway logs had no matching `error`, `exception`, `unhandled`, or `fatal` lines.
- New-build default routing: desktop Den auth defaults to `https://api.veslo.work`; desktop managed AI and orchestrator managed AI default to `https://ai.veslo.work`; the web Den proxy defaults to `https://api.veslo.work`; AI Gateway production Den fallback defaults to `https://api.veslo.work`.
- Local focused default verification: app Den/AI tests passed with 48 passing; AI Gateway env test passed with 4 passing; orchestrator owned-server default test passed with 1 passing; web owned-server default test passed with 1 passing.
- Local broader verification: app unit suite passed with 744 passing; AI Gateway suite passed with 201 passing; orchestrator suite passed with 7 passing; web proxy tests passed with 2 passing.
- Whitespace verification: `git diff --check` exited 0 after the final documentation update.
- Cutover deviation: because the owned domains were already live on the owned server, no destructive final Render restore was run during Phase 5. Restoring a fresh Render dump after owned-server writes could overwrite owned-server production writes. Render remains available as rollback and as a transition surface for old released desktop clients until client defaults are rolled out or a forwarding strategy is chosen.

## 2026-05-21 - Phase 5 AI Gateway admin UI verification

- Scope: verified the AI Gateway admin web UI as part of the owned-server migration from the Render admin surface to `https://ai.veslo.work/admin/`.
- Public browser shell: Chrome loaded `https://ai.veslo.work/admin/` and rendered the AI Gateway Admin navigation, signed-out browser sign-in panel, and admin sections for credentials, sessions, usage, alerts, users, and audit.
- Public static assets: `https://ai.veslo.work/admin/` returned HTTP 200; `/admin/app.css` and `/admin/app.js` loaded successfully. After the admin shell hygiene fix, the browser network list had no `/favicon.ico` 404 and the console had no errors, warnings, or issues.
- Admin browser-auth start: `POST https://ai.veslo.work/admin/api/auth/browser/start` returned HTTP 200 and produced an authorize URL under `https://api.veslo.work/`, confirming the owned admin UI starts browser handoff through the owned Den API.
- Unauthenticated API guard: `GET https://ai.veslo.work/admin/api/session` returned HTTP 401 without a bearer token.
- Authenticated admin API check: using the server-side platform-admin smoke token without printing the token, `/admin/api/session`, `/admin/api/credentials`, `/admin/api/users`, `/admin/api/usage?groupBy=credential`, `/admin/api/alerts`, and `/admin/api/audit` all returned HTTP 200 with the expected top-level response markers.
- Live deploy: copied the updated admin shell into the owned-server release directory, rebuilt only the `ai-gateway` Docker image, restarted only the `ai-gateway` service, and waited for the container health check to become healthy.
- Post-deploy health: `https://ai.veslo.work/health` returned `{"ok":true,"service":"ai-gateway"}`.

## 2026-05-21 - Phase 6 owned worker-manager staging verification

- Scope: implemented the owned-server worker-manager service, Den `PROVISIONER_MODE=owned-server`, Compose/Caddy wiring, and source-built worker runtime image.
- Local red/green verification: the new owned-server Den provisioner test first failed because `owned-server` was not an allowed `PROVISIONER_MODE`; the new worker-manager tests first failed because `services/worker-manager/src/app.js` did not exist. Both passed after implementation.
- Runtime packaging issue found during server build: `npm install -g veslo-orchestrator@0.11.113` failed with npm `404` because the package is not published in the registry. The worker runtime image was changed to build `veslo-server` and `veslo-orchestrator` from repo sources, install Bun, and run the built orchestrator with the built Veslo server path.
- Local verification: worker-manager tests passed with 5 passing tests; focused Den provisioner tests passed with 2 passing tests; the full Den test suite passed with 252 passing and 1 skipped; worker-manager TypeScript build passed; Den TypeScript build passed; `git diff --check` exited 0.
- Local Compose verification: `docker compose -f packaging/owned-server/compose.yml --env-file packaging/owned-server/env.example --profile worker-image config` rendered the owned-server stack, including `worker-manager`, the named worker network, and the build-only `worker-runtime-image` profile.
- Server staging path: copied the current worktree to `/home/neatech/veslo-phase6-worker-staging` on `62.109.146.43` and used isolated Compose project `veslo-phase6-worker` with network `veslo-phase6-worker-runtime`. No live `veslo-owned-server-*` services were restarted.
- Server build verification: `sudo -n docker compose -p veslo-phase6-worker ... --profile worker-image build worker-runtime-image worker-manager` built both images successfully after the source-built runtime fix.
- Server worker-manager verification: started only the isolated `worker-manager` service, waited for health, created one test worker through `POST /workers`, received a `healthy` owned-server worker response, confirmed the worker `/health` returned HTTP 200, and deleted it through `DELETE /workers/:id` with HTTP 204.
- Server cleanup verification: no `veslo-worker-phase6-test-*` containers or volumes remained after delete; the isolated staging Compose project was torn down with `down -v`; the live owned-server containers remained running.
- Caddy verification: validated the Phase 6 Caddyfile in a Caddy 2.10 container with `ACME_EMAIL=ops@veslo.work`; validation returned `Valid configuration`.
- Remaining production cutover gate: production `PROVISIONER_MODE` has not been switched to `owned-server`. Render worker provisioning remains the live rollback/transition path until DNS wildcard readiness and a deliberate production worker cutover are approved.

## 2026-05-21 - Phase 6 production worker cutover

- Scope: switched production worker provisioning from Render to the owned-server worker manager after the staging worker lifecycle and wildcard DNS gates passed.
- DNS gate: a random `*.workers.veslo.work` hostname resolved to `62.109.146.43` from the owned server before the cutover.
- Deploy/build: synced the Phase 6 source into the live owned-server checkout and built the production `worker-runtime-image`, `worker-manager`, and `den` images with `sudo -n docker compose --profile worker-image build worker-runtime-image worker-manager den`; all three images built successfully.
- Env cutover: backed up the production env as `production.env.bak-20260521T204748Z`, set `PROVISIONER_MODE=owned-server`, set the internal worker-manager URL/token and `workers.veslo.work` public suffix, kept Render worker values in the env for rollback, and set worker-manager to use the existing live Compose network.
- Cutover issue found and resolved: the first restart used the fresh `veslo-owned-server-runtime` network while the already-running DB/web/AI containers were on `veslo-owned-server_default`, so Den could not resolve `den-db` and restarted. The env was corrected to `VESLO_DOCKER_NETWORK=veslo-owned-server_default`, the affected containers were force-recreated, and Den recovered healthy. The empty temporary runtime network was removed.
- Post-restart status: Den, AI Gateway, web, worker-manager, Den DB, and AI Gateway DB were running; Den, AI Gateway, web, worker-manager, and both DB containers reported healthy. Proxy stayed up on ports 80 and 443.
- Public health verification: `https://api.veslo.work/health`, `https://ai.veslo.work/health`, and `https://app.veslo.work/` returned HTTP 200 after the cutover.
- Runtime env verification: Den logged `den listening on 8788 (provisioner=owned-server)`. Worker-manager runtime env used `WORKER_IMAGE=veslo-owned-server-worker-runtime:local` and `WORKER_DOCKER_NETWORK=veslo-owned-server_default`.
- Production worker lifecycle smoke: ran the production Den owned-server provisioner inside the live Den container. It created worker `a4704394-a9b2-4942-b2a0-424f98ab3377`, returned provider `owned-server`, status `healthy`, and URL `https://a4704394-a9b2-4942-b2a0-424f98ab3377.workers.veslo.work`; the public worker `/health` endpoint returned HTTP 200 on the first attempt; Den then deprovisioned the worker.
- Cleanup verification: no smoke worker container or volume remained after deprovisioning.
- Log verification: recent Den logs after the final restart showed table ensure success, managed-AI runtime enabled, and `provisioner=owned-server`; worker-manager logs showed it listening on `0.0.0.0:8790`.
- API caveat: the worker lifecycle smoke invoked Den's production provisioner module from inside the Den container instead of authenticated `POST /v1/workers`, because no reusable API session was available without minting or printing auth material. It still exercised the production Den-owned worker provisioner, worker-manager API, Docker worker runtime, public wildcard route, and deprovision path.

## 2026-05-22 - Phase 7 authenticated worker observation gate

- Scope: ran the normal authenticated production `/v1/workers` API lifecycle smoke before starting the post-cutover observation window, fixed the restored-schema drift it exposed, rebuilt the missing worker runtime image, and took a fresh owned-server backup.
- Initial authenticated smoke issue: server-side smoke auth succeeded against `/v1/me`, but `POST /v1/workers` returned HTTP 500 before provisioning. Den logs showed the insert into `worker` failed because the restored production table was missing `failure_reason`.
- Code fix: added a regression test for MySQL/Drizzle metadata tuple parsing and fixed Den startup schema reconciliation so `[[], fields]` is treated as zero rows instead of a present row. This lets boot-time reconciliation add missing restored-schema columns such as `worker.failure_reason`.
- Local verification: the focused schema reconciliation test first failed before the export/fix existed, then passed after the fix. `pnpm --filter @neatech/den build` exited 0. `pnpm --filter @neatech/den test` passed with 254 passing and 1 skipped.
- Production deploy: synced the Den fix into the live owned-server checkout, rebuilt `veslo-owned-server-den:local`, and restarted only Den. Den became healthy, logged table ensure success, and the live `worker.failure_reason` column was present as nullable `varchar(2048)`.
- Second authenticated smoke issue: authenticated worker creation reached async provisioning but failed because Docker did not have `veslo-owned-server-worker-runtime:local`. The failed worker was deleted through the normal API with HTTP 204, and no failed worker container remained.
- Worker runtime repair: rebuilt `worker-runtime-image`; Docker then listed `veslo-owned-server-worker-runtime:local`.
- Passing authenticated worker lifecycle: `/v1/me` returned HTTP 200; `POST /v1/workers` returned HTTP 202 for worker `90475b51-d8af-4749-a3cb-c8a6f7932b30`; polling `/v1/workers/:id` reached `healthy` on attempt 3 with provider `owned-server`, region `owned-server`, and URL `https://90475b51-d8af-4749-a3cb-c8a6f7932b30.workers.veslo.work`; the public worker `/health` endpoint returned HTTP 200 on attempt 1; `DELETE /v1/workers/:id` returned HTTP 204; the follow-up GET returned HTTP 404.
- Cleanup verification: no `veslo-worker-*` containers remained, and no volumes remained for the failed or passing smoke worker IDs.
- Final service verification: Den, AI Gateway, web, worker-manager, Den DB, and AI Gateway DB were running; Den, AI Gateway, web, worker-manager, and both DB containers reported healthy. Public `https://api.veslo.work/health`, `https://ai.veslo.work/health`, and `https://app.veslo.work/` returned HTTP 200. Den was still running `PROVISIONER_MODE=owned-server`.
- Final log verification: recent Den and worker-manager error scans after the passing smoke returned no matching `error`, `exception`, `unhandled`, or `fatal` lines.
- Post-cutover backup: Den and AI Gateway MySQL dumps were written under the server backup area at `20260522T084153Z`.
- Backup checksums: AI Gateway dump `e73c8596541aaf7a7cecd0191b97dfdc6450f4d05955b9278d5b9bad5c8a7b82`; Den dump `47cf2f645cc9a12da4406891440805e40add996c0833be5fb960616f3610cfb6`.
- Observation state: owned-server worker provisioning is live through the normal authenticated API path. Keep Render worker configuration available as rollback during the observation window; do not decommission Render until observation is clean and final Render snapshots/secrets are handled.
