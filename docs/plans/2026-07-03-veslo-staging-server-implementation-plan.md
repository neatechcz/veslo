# Veslo Staging Server Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build and verify a full VPN2-only Veslo staging environment on `62.109.146.56`, plus manual staging desktop app artifacts that connect only to staging.

**Architecture:** Add staging as a production-shaped but isolated owned-server environment: separate self-hosted runner label, manual deploy workflow, staging env/proxy templates, staging hostnames, staging backup/restore paths, and explicit VPN2-only verification. Add a separate staging desktop build path with staging URLs baked in, distinct app identifiers, and updater disabled/inert so staging never publishes to `neatechcz/veslo-updates`.

**Tech Stack:** GitHub Actions, self-hosted GitHub Actions runner, Docker Compose, Caddy, MySQL restore/backup helpers, Tauri v2, Solid/Vite, Rust, Node `node:test`, `tsx`, `pnpm@10.27.0`.

---

## Preconditions

- Use @test-driven-development for code/workflow changes.
- Use @verification-before-completion before claiming the staging server or staging app works.
- Keep production untouched unless a task explicitly says to read production-only docs or templates.
- Do not commit secrets, sanitized dumps, real production dumps, runner tokens, or env files.
- Before any desktop runtime/E2E validation, follow the Veslo desktop preflight in `docs/dev/testing-playbook.md`.

## Task 1: Add Staging Owned-Server Config Tests And Templates

**Files:**
- Create: `services/den/test/staging-owned-server-config.test.ts`
- Create: `packaging/owned-server/env.rehearsal.example`
- Modify: `packaging/owned-server/env.staging.example`
- Create: `packaging/owned-server/Caddyfile.staging`
- Modify: `packaging/owned-server/compose.yml`
- Modify: `packaging/owned-server/rehearsal/README.md`
- Modify: `packaging/owned-server/backup/README.md`

**Step 1: Write the failing test**

Create `services/den/test/staging-owned-server-config.test.ts`:

```ts
import assert from "node:assert/strict"
import { existsSync, readFileSync } from "node:fs"
import test from "node:test"

const root = new URL("../../..", import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), "utf8")

test("persistent staging env template uses staging public URLs", () => {
  const env = read("packaging/owned-server/env.staging.example")

  for (const expected of [
    "BETTER_AUTH_URL=https://api.staging.veslo.work",
    "CORS_ORIGINS=https://app.staging.veslo.work,https://ai.staging.veslo.work,https://admin.staging.veslo.work",
    "OWNED_WORKER_PUBLIC_DOMAIN_SUFFIX=workers.staging.veslo.work",
    "GOOGLE_WORKSPACE_OAUTH_REDIRECT_URI=https://api.staging.veslo.work/v1/integrations/google/oauth/callback",
    "GOOGLE_WORKSPACE_OAUTH_SUCCESS_REDIRECT_URL=https://app.staging.veslo.work/settings/integrations/google",
    "GOOGLE_WORKSPACE_CONNECTOR_BASE_URL=https://api.staging.veslo.work",
    "MICROSOFT_REDIRECT_URI=https://api.staging.veslo.work/v1/integrations/microsoft/oauth/callback",
    "MICROSOFT_CONNECTOR_BASE_URL=https://api.staging.veslo.work",
    "AI_GATEWAY_OPENAI_REDIRECT_BASE=https://ai.staging.veslo.work/auth/openai",
    "AI_GATEWAY_DEN_API_BASE=https://api.staging.veslo.work",
    "DEN_API_BASE=https://api.staging.veslo.work",
    "DEN_AUTH_ORIGIN=https://api.staging.veslo.work",
    "NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL=https://app.staging.veslo.work",
    "BACKUP_HOST_ROOT=/srv/veslo/staging/backups",
    "VESLO_CADDYFILE=./Caddyfile.staging",
  ]) {
    assert.match(env, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }

  assert.doesNotMatch(env, /^BETTER_AUTH_URL=http:\/\/den:8788$/m)
  assert.doesNotMatch(env, /^NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL=http:\/\/localhost:3005$/m)
})

test("database rehearsal env remains separate from durable staging", () => {
  assert.equal(existsSync(new URL("packaging/owned-server/env.rehearsal.example", root)), true)
  const rehearsal = read("packaging/owned-server/env.rehearsal.example")
  assert.match(rehearsal, /^BETTER_AUTH_URL=http:\/\/den:8788$/m)
  assert.match(rehearsal, /^NEXT_PUBLIC_VESLO_AUTH_CALLBACK_URL=http:\/\/localhost:3005$/m)
})

test("staging Caddyfile exposes all staging hostnames", () => {
  const caddy = read("packaging/owned-server/Caddyfile.staging")
  for (const expected of [
    "api.staging.veslo.work",
    "ai.staging.veslo.work",
    "app.staging.veslo.work",
    "admin.staging.veslo.work",
    "https://*.workers.staging.veslo.work",
    "reverse_proxy den:8788",
    "reverse_proxy ai-gateway:4034",
    "reverse_proxy web:3005",
    "reverse_proxy worker-manager:8790",
  ]) {
    assert.match(caddy, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }
})

test("owned-server compose lets staging override proxy file and backup host root", () => {
  const compose = read("packaging/owned-server/compose.yml")
  assert.match(compose, /\$\{VESLO_CADDYFILE:-\.\/Caddyfile\}:\/etc\/caddy\/Caddyfile:ro/)
  assert.match(compose, /\$\{BACKUP_HOST_ROOT:-\/srv\/veslo\/backups\}:\/srv\/veslo\/backups/)
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir services/den exec tsx --test test/staging-owned-server-config.test.ts
```

Expected: FAIL because `env.rehearsal.example`, `Caddyfile.staging`, and Compose overrides do not exist yet.

**Step 3: Implement staging and rehearsal templates**

1. Copy the current rehearsal-only `packaging/owned-server/env.staging.example` to `packaging/owned-server/env.rehearsal.example`.
2. Rewrite `packaging/owned-server/env.staging.example` as the durable staging template:
   - Keep the same variable coverage as `env.example`.
   - Replace all production public URLs with staging URLs.
   - Add `BACKUP_HOST_ROOT=/srv/veslo/staging/backups`.
   - Add `VESLO_CADDYFILE=./Caddyfile.staging`.
   - Use staging Docker/network/image names where env vars already exist.
3. Create `packaging/owned-server/Caddyfile.staging`:

```caddyfile
{
	email {$ACME_EMAIL}
	on_demand_tls {
		ask http://worker-manager:8790/tls/ask
	}
}

api.staging.veslo.work {
	encode zstd gzip
	reverse_proxy den:8788
}

ai.staging.veslo.work {
	encode zstd gzip
	reverse_proxy ai-gateway:4034
}

admin.staging.veslo.work {
	encode zstd gzip
	redir / /admin 308
	reverse_proxy ai-gateway:4034
}

app.staging.veslo.work {
	encode zstd gzip
	reverse_proxy web:3005
}

https://*.workers.staging.veslo.work {
	encode zstd gzip
	tls {
		on_demand
	}
	reverse_proxy worker-manager:8790
}
```

4. Modify `packaging/owned-server/compose.yml`:

```yaml
    volumes:
      - ${BACKUP_HOST_ROOT:-/srv/veslo/backups}:/srv/veslo/backups
```

and:

```yaml
    volumes:
      - ${VESLO_CADDYFILE:-./Caddyfile}:/etc/caddy/Caddyfile:ro
```

5. Update rehearsal docs to use `env.rehearsal.example` and `/srv/veslo/env/rehearsal.env`, so durable staging is no longer confused with restore rehearsal.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --dir services/den exec tsx --test test/staging-owned-server-config.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add services/den/test/staging-owned-server-config.test.ts packaging/owned-server/env.staging.example packaging/owned-server/env.rehearsal.example packaging/owned-server/Caddyfile.staging packaging/owned-server/compose.yml packaging/owned-server/rehearsal/README.md packaging/owned-server/backup/README.md
git commit -m "feat: add owned-server staging templates"
```

## Task 2: Add Manual Staging Server Deploy Workflow

**Files:**
- Create: `.github/workflows/deploy-staging-server.yml`
- Modify: `services/den/test/staging-owned-server-config.test.ts`

**Step 1: Extend the failing test**

Append to `services/den/test/staging-owned-server-config.test.ts`:

```ts
test("staging deploy workflow runs only on the staging self-hosted runner", () => {
  const workflow = read(".github/workflows/deploy-staging-server.yml")

  for (const expected of [
    "name: Deploy Staging Server",
    "workflow_dispatch",
    "runs-on:",
    "self-hosted",
    "linux",
    "x64",
    "veslo-staging-server",
    "STAGING_SERVER_APP_DIR",
    "STAGING_SERVER_ENV_FILE",
    "STAGING_COMPOSE_PROJECT",
    "STAGING_SERVER_CADDYFILE",
    "git_auth fetch --prune origin",
    "docker compose -p",
    "build worker-runtime-image worker-manager backup den ai-gateway web",
    "pnpm --filter @neatech/den db:migrate",
    "pnpm --filter @neatech/ai-gateway db:migrate",
    "https://api.staging.veslo.work/health",
    "https://ai.staging.veslo.work/health",
    "https://app.staging.veslo.work",
    "https://admin.staging.veslo.work/admin",
  ]) {
    assert.match(workflow, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
  }

  for (const forbidden of [
    "veslo-owned-server",
    "https://api.veslo.work/health",
    "https://ai.veslo.work/health",
    "https://app.veslo.work",
    "OWNED_SERVER_ENV_FILE",
    "OWNED_SERVER_APP_DIR",
    "/home/neatech/veslo-owned-server-production",
    "/home/neatech/veslo-owned-server-dark-launch-inputs/env/production.env",
    "neatechcz/veslo-updates",
  ]) {
    assert.equal(workflow.includes(forbidden), false, `staging workflow must not contain ${forbidden}`)
  }
})
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm --dir services/den exec tsx --test test/staging-owned-server-config.test.ts
```

Expected: FAIL because the staging deploy workflow does not exist.

**Step 3: Implement `.github/workflows/deploy-staging-server.yml`**

Base it on the production owned-server workflow, but keep every staging value separate:

- `name: Deploy Staging Server`
- `concurrency.group: deploy-staging-server`
- `runs-on: [self-hosted, linux, x64, veslo-staging-server]`
- variables:
  - `STAGING_SERVER_APP_DIR`, default `/home/neatech/veslo-owned-server-staging`
  - `STAGING_SERVER_ENV_FILE`, default `/srv/veslo/env/staging.env`
  - `STAGING_COMPOSE_PROJECT`, default `veslo-staging-server`
  - `STAGING_SERVER_CADDYFILE`, default `./Caddyfile.staging`
- `workflow_dispatch` inputs:
  - `branch`
  - `install_backup_timer`
  - `run_backup_now`
- `compose()` wrapper:

```bash
compose() {
  VESLO_CADDYFILE="$STAGING_SERVER_CADDYFILE" \
    sudo -n docker compose \
      -p "$STAGING_COMPOSE_PROJECT" \
      -f packaging/owned-server/compose.yml \
      --env-file "$STAGING_SERVER_ENV_FILE" \
      "$@"
}
```

- public checks must use staging URLs only.
- backup checks must use staging env and staging Compose project.

**Step 4: Run test to verify it passes**

Run:

```bash
pnpm --dir services/den exec tsx --test test/staging-owned-server-config.test.ts
```

Expected: PASS.

**Step 5: Commit**

```bash
git add .github/workflows/deploy-staging-server.yml services/den/test/staging-owned-server-config.test.ts
git commit -m "ci: add staging server deploy workflow"
```

## Task 3: Make Desktop Staging URLs Build-Time Safe

**Files:**
- Modify: `packages/app/src/app/lib/den-auth.ts`
- Modify: `packages/app/src/app/lib/ai-access.ts`
- Modify: `packages/app/src/app/lib/veslo-server/connection.ts`
- Modify: `packages/app/src/app/context/updater.ts`
- Modify: `packages/app/src/app/system-state.ts`
- Modify: `packages/app/src/app/tests/lib/den-auth.test.ts`
- Modify: `packages/app/src/app/tests/lib/ai-access.test.ts`
- Modify: `packages/app/src/app/tests/lib/veslo-server.test.ts`
- Modify: `packages/app/src/app/tests/context/updater.test.ts`
- Modify: `packages/desktop/src-tauri/src/veslo_server/spawn.rs`

**Step 1: Write failing app/Rust tests**

Add tests for:

- `getDefaultDenApiBase()` uses `VITE_DEN_API_BASE` when present.
- managed AI gateway default uses `VITE_MANAGED_AI_GATEWAY_BASE_URL` in the frontend.
- Veslo connect app URL uses `VITE_VESLO_CONNECT_APP_URL`.
- updater auto checks are disabled when `VITE_VESLO_UPDATER_ENABLED=false`.
- Rust managed AI base URL prefers runtime env, then build-time `option_env!`, then production default.

Use helper functions instead of mutating real `import.meta.env` directly. For example in `ai-access.ts`:

```ts
export function resolveDefaultManagedAiGatewayBaseUrl(env?: Record<string, string | undefined>) {
  const raw = env?.VITE_MANAGED_AI_GATEWAY_BASE_URL?.trim();
  return raw ? normalizeHttpUrl(raw) : "https://ai.veslo.work";
}
```

For Rust, refactor the tested helper to accept a build-time value:

```rust
fn resolve_managed_ai_base_url_from_env(
    managed_ai_base_url: Option<&str>,
    legacy_ai_gateway_base_url: Option<&str>,
    build_time_managed_ai_base_url: Option<&str>,
) -> String
```

Expected precedence:

1. runtime `VESLO_MANAGED_AI_BASE_URL`
2. runtime `VESLO_AI_GATEWAY_BASE_URL`
3. build-time `VESLO_MANAGED_AI_BASE_URL`
4. `https://ai.veslo.work`

**Step 2: Run tests to verify they fail**

Run:

```bash
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/lib/den-auth.test.ts \
  src/app/tests/lib/ai-access.test.ts \
  src/app/tests/lib/veslo-server.test.ts \
  src/app/tests/context/updater.test.ts

cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml managed_ai_base_url
```

Expected: FAIL on missing helpers or old hardcoded defaults.

**Step 3: Implement minimal app/Rust changes**

Implement these behaviors:

- `den-auth.ts`: keep `VITE_DEN_API_BASE` behavior and add/adjust tests only if already covered.
- `ai-access.ts`: make the exported default gateway value env-aware through a helper and keep production default unchanged.
- `connection.ts`: add `resolveDefaultVesloConnectAppUrl(env)` and use it wherever the default connect app URL is currently hardcoded.
- `updater.ts` or `system-state.ts`: add a simple staging-safe feature flag:

```ts
export function isUpdaterEnabled(env?: Record<string, string | undefined>) {
  return String(env?.VITE_VESLO_UPDATER_ENABLED ?? "true").trim().toLowerCase() !== "false";
}
```

Then make `checkForUpdates` return without calling `@tauri-apps/plugin-updater` when disabled.

- `spawn.rs`: use `option_env!("VESLO_MANAGED_AI_BASE_URL")` as the build-time fallback.

**Step 4: Run tests to verify they pass**

Run the same test commands from Step 2.

Expected: PASS.

**Step 5: Commit**

```bash
git add packages/app/src/app/lib/den-auth.ts packages/app/src/app/lib/ai-access.ts packages/app/src/app/lib/veslo-server/connection.ts packages/app/src/app/context/updater.ts packages/app/src/app/system-state.ts packages/app/src/app/tests/lib/den-auth.test.ts packages/app/src/app/tests/lib/ai-access.test.ts packages/app/src/app/tests/lib/veslo-server.test.ts packages/app/src/app/tests/context/updater.test.ts packages/desktop/src-tauri/src/veslo_server/spawn.rs
git commit -m "feat: support staging desktop endpoints"
```

## Task 4: Add Staging Desktop Tauri Config And Build Workflow

**Files:**
- Create: `scripts/release/staging-app-build.test.mjs`
- Create: `packages/desktop/src-tauri/tauri.staging.conf.json`
- Create: `packages/desktop/src-tauri/tauri.windows.staging.conf.json`
- Create: `.github/workflows/build-staging-app.yml`
- Modify: `package.json`

**Step 1: Write the failing source guard**

Create `scripts/release/staging-app-build.test.mjs`:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const readJson = (path) => JSON.parse(read(path));

test("staging Tauri config is a side-by-side app with updater artifacts disabled", () => {
  const staging = readJson("packages/desktop/src-tauri/tauri.staging.conf.json");
  assert.equal(staging.productName, "Veslo Staging");
  assert.equal(staging.identifier, "com.neatech.veslo.staging");
  assert.equal(staging.bundle.createUpdaterArtifacts, false);
});

test("staging Windows config uses a distinct upgrade code", () => {
  const prod = readJson("packages/desktop/src-tauri/tauri.conf.json");
  const stagingWindows = readJson("packages/desktop/src-tauri/tauri.windows.staging.conf.json");
  assert.notEqual(
    stagingWindows.bundle.windows.wix.upgradeCode,
    prod.bundle.windows.wix.upgradeCode,
  );
});

test("staging app workflow bakes staging endpoints and never publishes public updater assets", () => {
  const workflow = read(".github/workflows/build-staging-app.yml");
  for (const expected of [
    "name: Build Staging App",
    "workflow_dispatch",
    "VITE_DEN_API_BASE: https://api.staging.veslo.work",
    "VITE_MANAGED_AI_GATEWAY_BASE_URL: https://ai.staging.veslo.work",
    "VESLO_MANAGED_AI_BASE_URL: https://ai.staging.veslo.work",
    "VITE_VESLO_CONNECT_APP_URL: https://app.staging.veslo.work",
    "VITE_VESLO_UPDATER_ENABLED: false",
    "VESLO_GLITCHTIP_ENVIRONMENT: staging",
    "tauri.staging.conf.json",
    "actions/upload-artifact",
  ]) {
    assert.match(workflow, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  }
  for (const forbidden of [
    "neatechcz/veslo-updates",
    "mirror-public-release",
    "generate-latest-json",
    "publish-updater-json",
    "Release App",
  ]) {
    assert.equal(workflow.includes(forbidden), false, `staging app workflow must not include ${forbidden}`);
  }
});
```

Add a script to root `package.json`:

```json
"test:staging-app-build": "node scripts/release/staging-app-build.test.mjs"
```

**Step 2: Run test to verify it fails**

Run:

```bash
pnpm test:staging-app-build
```

Expected: FAIL because config/workflow files do not exist.

**Step 3: Implement staging Tauri configs**

Create `packages/desktop/src-tauri/tauri.staging.conf.json`:

```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Veslo Staging",
  "identifier": "com.neatech.veslo.staging",
  "bundle": {
    "createUpdaterArtifacts": false
  }
}
```

Create `packages/desktop/src-tauri/tauri.windows.staging.conf.json` with a new deterministic UUID for staging:

```json
{
  "bundle": {
    "windows": {
      "wix": {
        "upgradeCode": "<new-staging-upgrade-code>"
      }
    }
  }
}
```

Generate the UUID once:

```bash
uuidgen | tr '[:upper:]' '[:lower:]'
```

**Step 4: Implement `.github/workflows/build-staging-app.yml`**

Create a manual workflow that:

- accepts a `ref` input
- builds macOS arm64, macOS x64, and Windows x64 where the production release workflow already supports those targets
- sets staging env:

```yaml
VITE_DEN_API_BASE: https://api.staging.veslo.work
VITE_MANAGED_AI_GATEWAY_BASE_URL: https://ai.staging.veslo.work
VESLO_MANAGED_AI_BASE_URL: https://ai.staging.veslo.work
VITE_VESLO_CONNECT_APP_URL: https://app.staging.veslo.work
VITE_VESLO_UPDATER_ENABLED: "false"
VESLO_GLITCHTIP_ENVIRONMENT: staging
VITE_VESLO_GLITCHTIP_ENVIRONMENT: staging
```

- uses `pnpm@10.27.0`
- prepares sidecars
- runs `pnpm release:review --strict` unless the review needs a staging-specific skip for disabled updater artifacts
- builds with:

```bash
pnpm --filter @neatech/veslo exec tauri build \
  --config src-tauri/tauri.staging.conf.json \
  --target "$TARGET_TRIPLE" \
  --bundles "$BUNDLES"
```

and for Windows:

```powershell
pnpm --filter @neatech/veslo exec tauri build `
  --config src-tauri/tauri.staging.conf.json `
  --config src-tauri/tauri.windows.release.conf.json `
  --config src-tauri/tauri.windows.staging.conf.json `
  --target $env:TARGET_TRIPLE `
  --bundles msi
```

- uploads artifacts with names that include `staging`, target triple, and commit SHA.

**Step 5: Run test to verify it passes**

Run:

```bash
pnpm test:staging-app-build
```

Expected: PASS.

**Step 6: Commit**

```bash
git add scripts/release/staging-app-build.test.mjs packages/desktop/src-tauri/tauri.staging.conf.json packages/desktop/src-tauri/tauri.windows.staging.conf.json .github/workflows/build-staging-app.yml package.json
git commit -m "ci: build staging desktop app"
```

## Task 5: Document Durable Staging Operations

**Files:**
- Create: `docs/dev/staging-deployments.md`
- Modify: `docs/dev/documentation-map.md`
- Modify: `docs/dev/cloud-deployments.md`
- Modify: `packaging/owned-server/README.md`
- Modify: `docs/desktop-updater.md`
- Modify: `scripts/release/public-release-assets.test.mjs`

**Step 1: Write failing documentation guard**

Extend `scripts/release/public-release-assets.test.mjs` with:

```js
test("staging docs keep staging artifacts out of veslo-updates", () => {
  const docs = readFileSync(new URL("../../docs/dev/staging-deployments.md", import.meta.url), "utf8");
  assert.match(docs, /62\.109\.146\.56/);
  assert.match(docs, /VPN2-only/i);
  assert.match(docs, /veslo-staging-server/);
  assert.match(docs, /api\.staging\.veslo\.work/);
  assert.match(docs, /Build Staging App/);
  assert.match(docs, /Deploy Staging Server/);
  assert.match(docs, /never publishes to `neatechcz\/veslo-updates`/i);
});
```

**Step 2: Run test to verify it fails**

Run:

```bash
node scripts/release/public-release-assets.test.mjs
```

Expected: FAIL because the staging deployment doc does not exist.

**Step 3: Add durable docs**

Create `docs/dev/staging-deployments.md` with:

- staging server IP and VPN2-only access model
- hostnames
- DNS expectations
- runner label and runner directory
- stable checkout path
- env file path
- backup path
- deploy workflow
- staging app build workflow
- manual install process
- sanitized production snapshot restore process
- verification runbook
- explicit "never publish staging to `neatechcz/veslo-updates`" rule

Update:

- `docs/dev/documentation-map.md` to list the new doc.
- `docs/dev/cloud-deployments.md` to distinguish production and staging.
- `packaging/owned-server/README.md` to link staging-specific env/proxy/deploy docs.
- `docs/desktop-updater.md` to state staging builds are manual-download artifacts with updater disabled or inert.

**Step 4: Run test to verify it passes**

Run:

```bash
node scripts/release/public-release-assets.test.mjs
```

Expected: PASS.

**Step 5: Commit**

```bash
git add docs/dev/staging-deployments.md docs/dev/documentation-map.md docs/dev/cloud-deployments.md packaging/owned-server/README.md docs/desktop-updater.md scripts/release/public-release-assets.test.mjs
git commit -m "docs: document staging deployment operations"
```

## Task 6: Local Verification Before Server Work

**Files:**
- Test only.

**Step 1: Run focused tests**

Run:

```bash
pnpm --dir services/den exec tsx --test test/staging-owned-server-config.test.ts
pnpm test:staging-app-build
node scripts/release/public-release-assets.test.mjs
pnpm --filter @neatech/veslo-ui exec node --test --import=tsx/esm \
  src/app/tests/lib/den-auth.test.ts \
  src/app/tests/lib/ai-access.test.ts \
  src/app/tests/lib/veslo-server.test.ts \
  src/app/tests/context/updater.test.ts
cargo test --manifest-path packages/desktop/src-tauri/Cargo.toml managed_ai_base_url
```

Expected: all PASS.

**Step 2: Run workflow/config checks**

Run:

```bash
git diff --check
pnpm release:review --json
```

Expected:

- `git diff --check` exits 0.
- `pnpm release:review --json` exits 0 or reports only known staging-specific review gaps that are documented before continuing.

**Step 3: Commit any verification-only doc fix**

Only if verification requires docs/source adjustments:

```bash
git add <changed-files>
git commit -m "chore: finish staging deployment verification"
```

## Task 7: Install The Staging Self-Hosted Runner

**Files:**
- Server state only: `/home/neatech/actions-runner-veslo-staging`

**Step 1: Create a runner registration token**

Run locally with GitHub CLI authenticated to `neatechcz/veslo`:

```bash
runner_token="$(gh api -X POST repos/neatechcz/veslo/actions/runners/registration-token --jq .token)"
test -n "$runner_token"
```

Expected: token printed only into the shell variable. Do not commit or paste it into docs.

**Step 2: Connect to the staging server over VPN2**

Run:

```bash
ssh neatech@62.109.146.56 'hostname; uname -a; sudo -n docker ps >/dev/null && echo docker-ok'
```

Expected: SSH succeeds from the VPN2-connected operator machine and Docker works through non-interactive sudo.

**Step 3: Install and configure the runner**

Run on the staging server:

```bash
mkdir -p /home/neatech/actions-runner-veslo-staging
cd /home/neatech/actions-runner-veslo-staging
runner_version="$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest | node -e 'let d="";process.stdin.on("data",c=>d+=c);process.stdin.on("end",()=>console.log(JSON.parse(d).tag_name.replace(/^v/,"")))')
curl -fsSLO "https://github.com/actions/runner/releases/download/v${runner_version}/actions-runner-linux-x64-${runner_version}.tar.gz"
tar xzf "actions-runner-linux-x64-${runner_version}.tar.gz"
./config.sh \
  --url https://github.com/neatechcz/veslo \
  --token "$runner_token" \
  --name veslo-staging-server-62-109-146-56 \
  --labels veslo-staging-server \
  --unattended \
  --replace
```

If `runner_token` was created locally, pass it securely into the SSH session and clear shell history if needed.

**Step 4: Install/start as service**

Prefer the official service script:

```bash
cd /home/neatech/actions-runner-veslo-staging
sudo ./svc.sh install neatech
sudo ./svc.sh start
sudo ./svc.sh status
```

If service installation is not available, start the runner in a persistent session and document the temporary state before proceeding.

**Step 5: Verify GitHub sees the runner**

Run locally:

```bash
gh api repos/neatechcz/veslo/actions/runners \
  --jq '.runners[] | select(any(.labels[]; .name=="veslo-staging-server")) | {name,status,busy}'
```

Expected: one staging runner with `"status": "online"`.

## Task 8: Prepare Staging Server Env, DNS, VPN2, And Data

**Files:**
- Server env only: `/srv/veslo/env/staging.env`
- Server dumps only: `/srv/veslo/staging/dumps`
- Server backups only: `/srv/veslo/staging/backups`

**Step 1: Create server directories**

Run on the staging server:

```bash
sudo mkdir -p /srv/veslo/env /srv/veslo/staging/dumps /srv/veslo/staging/backups
sudo chown -R neatech:neatech /srv/veslo/staging
sudo chmod 700 /srv/veslo/staging /srv/veslo/staging/dumps
sudo chmod 750 /srv/veslo/staging/backups
```

Expected: directories exist and dumps are not world-readable.

**Step 2: Create staging env file**

After the repo checkout exists on the server, run:

```bash
cp /home/neatech/veslo-owned-server-staging/packaging/owned-server/env.staging.example /srv/veslo/env/staging.env
chmod 600 /srv/veslo/env/staging.env
```

Fill the env file with real staging values. Reused production credentials are allowed only where already approved, but all URLs must remain staging URLs.

**Step 3: Verify DNS**

Run from a VPN2-connected machine:

```bash
for host in \
  api.staging.veslo.work \
  ai.staging.veslo.work \
  app.staging.veslo.work \
  admin.staging.veslo.work; do
  dig +short "$host"
done
dig +short test-worker.workers.staging.veslo.work
```

Expected: every host resolves to `62.109.146.56`.

**Step 4: Enforce VPN2-only access**

Use the actual host firewall/provider firewall in place on `62.109.146.56`. Record the chosen mechanism in `docs/dev/staging-deployments.md` during implementation.

If using `ufw`, the shape is:

```bash
sudo ufw allow from <VPN2_CIDR_OR_EGRESS_IP> to any port 22 proto tcp
sudo ufw allow from <VPN2_CIDR_OR_EGRESS_IP> to any port 80 proto tcp
sudo ufw allow from <VPN2_CIDR_OR_EGRESS_IP> to any port 443 proto tcp
sudo ufw deny 22/tcp
sudo ufw deny 80/tcp
sudo ufw deny 443/tcp
sudo ufw status numbered
```

Expected: VPN2 traffic works; non-VPN traffic is blocked.

**Step 5: Restore sanitized production-like data**

Copy sanitized dumps into `/srv/veslo/staging/dumps`, then restore through the existing helper after the staging DB containers exist:

```bash
ENV_FILE=/srv/veslo/env/staging.env \
DOCKER_COMPOSE="sudo docker compose -p veslo-staging-server" \
  /home/neatech/veslo-owned-server-staging/packaging/owned-server/backup/restore-mysql.sh --apply den-db den /srv/veslo/staging/dumps/den-sanitized.sql

ENV_FILE=/srv/veslo/env/staging.env \
DOCKER_COMPOSE="sudo docker compose -p veslo-staging-server" \
  /home/neatech/veslo-owned-server-staging/packaging/owned-server/backup/restore-mysql.sh --apply ai-gateway-db veslo_ai_gateway /srv/veslo/staging/dumps/ai-gateway-sanitized.sql
```

Expected: restore succeeds and no raw dump contents are printed.

## Task 9: Deploy And Verify The Staging Server

**Files:**
- No repo edits unless a verification issue requires a fix.

**Step 1: Push branch with implementation commits**

Run:

```bash
git status --short
git push origin HEAD
```

Expected: implementation commits are available to GitHub.

**Step 2: Run the staging deploy workflow**

Run:

```bash
gh workflow run "Deploy Staging Server" --ref "$(git branch --show-current)" \
  -f branch="$(git branch --show-current)" \
  -f install_backup_timer=true \
  -f run_backup_now=false
gh run list --workflow "Deploy Staging Server" --limit 1
```

Watch the run:

```bash
gh run watch <run-id> --exit-status
```

Expected: workflow succeeds on `veslo-staging-server`.

**Step 3: Verify endpoints from VPN2**

Run:

```bash
curl -fsS https://api.staging.veslo.work/health
curl -fsS https://ai.staging.veslo.work/health
curl -fsSI https://app.staging.veslo.work >/dev/null
curl -fsSI https://admin.staging.veslo.work/admin >/dev/null
curl -i https://ai.staging.veslo.work/readiness
```

Expected:

- `/health` endpoints return success.
- web/admin return HTTP success or expected authenticated redirect.
- `/readiness` returns the current inference readiness state; failure may be acceptable only if documented as missing staging credentials/policy.

**Step 4: Verify VPN2-only behavior**

From a non-VPN network, run the same `curl` commands.

Expected: connection fails or is blocked. Do not treat this as staging failure.

**Step 5: Verify backup path**

Run:

```bash
gh workflow run "Deploy Staging Server" --ref "$(git branch --show-current)" \
  -f branch="$(git branch --show-current)" \
  -f install_backup_timer=true \
  -f run_backup_now=true
```

Expected: backup artifacts appear under `/srv/veslo/staging/backups`, not `/srv/veslo/backups`.

## Task 10: Build And Verify The Staging Desktop App

**Files:**
- No repo edits unless verification requires a fix.

**Step 1: Run staging app workflow**

Run:

```bash
gh workflow run "Build Staging App" --ref "$(git branch --show-current)" -f ref="$(git rev-parse HEAD)"
gh run list --workflow "Build Staging App" --limit 1
gh run watch <run-id> --exit-status
```

Expected: staging artifacts upload to the private repo workflow run and are not published to `neatechcz/veslo-updates`.

**Step 2: Inspect built artifact metadata**

Download artifacts from the workflow run and verify:

- product name contains `Veslo Staging`
- bundle identifier is `com.neatech.veslo.staging`
- Windows upgrade code differs from production
- no `latest.json` is generated or uploaded
- artifact names include `staging`

**Step 3: Install and run staging desktop app**

On a VPN2-connected machine, install the staging artifact. Before launch, follow the Veslo desktop process preflight from `docs/dev/testing-playbook.md`.

Expected:

- app launches as staging
- Den auth starts against `https://api.staging.veslo.work`
- managed AI routes through `https://ai.staging.veslo.work`
- updater check does not call the production `veslo-updates` feed

**Step 4: Run one end-to-end staging task**

Use the real Tauri desktop runtime, not a UI-only server:

1. sign in through staging auth
2. open or create a staging workspace/session
3. send one small prompt using staging managed AI
4. verify session/result persists in staging
5. open staging admin and confirm the staging user/session/AI policy is visible

Expected: the app talks only to staging endpoints.

## Task 11: Final Verification And Handoff

**Files:**
- Modify docs only if verification reveals drift.

**Step 1: Run local final checks**

Run:

```bash
pnpm --dir services/den exec tsx --test test/staging-owned-server-config.test.ts
pnpm test:staging-app-build
node scripts/release/public-release-assets.test.mjs
pnpm --filter @neatech/veslo-ui typecheck
git diff --check
```

Expected: all PASS.

**Step 2: Update graph if code changed and graphify is available**

Run:

```bash
command -v graphify >/dev/null 2>&1 && graphify update . || true
```

Expected: graph update succeeds or is skipped because graphify is unavailable. Do not fail the task only because graphify is unavailable.

**Step 3: Record final operational state**

Update `docs/dev/staging-deployments.md` with final verified values:

- actual runner name
- actual env file path
- actual firewall/VPN2 mechanism
- workflow run IDs
- staging app artifact run ID
- health/readiness status
- backup path verification

Do not include secrets or raw dump names if they disclose sensitive data.

**Step 4: Commit final docs**

```bash
git add docs/dev/staging-deployments.md
git commit -m "docs: record staging deployment verification"
```

**Step 5: Final handoff**

Report:

- staging server URL set
- runner label and status
- deploy workflow name and last successful run
- staging app build workflow name and artifact location
- VPN2-only verification result
- backup path result
- any known limitations, especially reused production credentials or readiness gaps
