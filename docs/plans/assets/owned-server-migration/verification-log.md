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
