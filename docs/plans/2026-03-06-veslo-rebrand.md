# Veslo Rebrand Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Rename the entire app from "OpenWork" by "Different AI" to "Veslo" by "Neatech" across all code, configs, pipelines, and documentation.

**Architecture:** This is a surgical rename across 170+ files. Each task group targets an independent area of the codebase. Tasks can be parallelized since they don't share files. After all renames, a final verification task checks everything compiles and type-checks.

**Tech Stack:** TypeScript (SolidJS), Rust (Tauri 2), GitHub Actions YAML, AUR PKGBUILD, npm packages

---

## Naming Reference Table

Every task should use this table for consistent replacements:

| Old | New | Context |
|-----|-----|---------|
| `OpenWork` | `Veslo` | Display name (PascalCase) |
| `openwork` | `veslo` | Identifiers, CLI, deep-links (lowercase) |
| `openwork_server` | `veslo_server` | Rust module names (snake_case) |
| `OpenworkServer` | `VesloServer` | Rust/TS type names (PascalCase) |
| `OPENWORK` | `VESLO` | Env vars, EOF markers (UPPER_CASE) |
| `Different AI` | `Neatech` | Company name |
| `different-ai` | `neatech` | npm scope, GitHub org |
| `differentai` | `neatech` | Bundle ID prefix |
| `com.differentai.openwork` | `com.neatech.veslo` | Bundle identifier |
| `app.openwork.software` | `app.veslo.neatech.com` | Web domain |
| `openwork.software` | `veslo.neatech.com` | Root domain |
| `opencode` (binary) | `veslo-code` | Terminal agent binary name |
| `opencode-router` (package) | `veslo-code-router` | Router package name |
| `openwork-orchestrator` | `veslo-orchestrator` | Orchestrator package/binary |
| `openwork-server` | `veslo-server` | Server package/binary |
| `openwork-desktop` | `veslo-desktop` | Release asset prefix |
| `openwork-ci` | `veslo-ci` | CI user-agent |
| `OpenWork Release Bot` | `Veslo Release Bot` | Git commit author |
| `openwork://` | `veslo://` | Deep-link scheme |
| `openwork-logo` | `veslo-logo` | Logo file/component names |
| `openwork-share` | `veslo-share` | Share service name |
| `openwork-default` | `veslo-default` | Tauri capability ID |
| `@openwork/den` | `@neatech/den` | Den package scope |
| `openwork-bundle` | `veslo-bundle` | Bundle data attributes |

**IMPORTANT:** Do NOT rename:
- `opencode` when it refers to the OpenCode engine/CLI itself (e.g. `.opencode/` directory, `opencode.json` config, `@opencode-ai/sdk`, the OpenCode project)
- `opencode` in comments describing OpenCode functionality
- The upstream `anomalyco/opencode` GitHub repo references
- `chrome-devtools-mcp` sidecar name

---

### Task 1: Tauri App Identity & Rust Crate Config

**Files:**
- Modify: `packages/desktop/src-tauri/tauri.conf.json`
- Modify: `packages/desktop/src-tauri/tauri.dev.conf.json`
- Modify: `packages/desktop/src-tauri/capabilities/default.json`
- Modify: `packages/desktop/src-tauri/Cargo.toml`

**Step 1: Update tauri.conf.json**

Apply these changes to `packages/desktop/src-tauri/tauri.conf.json`:
- Line 3: `"productName": "OpenWork"` → `"productName": "Veslo"`
- Line 5: `"identifier": "com.differentai.openwork"` → `"identifier": "com.neatech.veslo"`
- Line 8: `pnpm -C ../.. --filter @different-ai/openwork run prepare:sidecar` → `pnpm -C ../.. --filter @neatech/veslo run prepare:sidecar`
- Line 8: `pnpm -w build:ui` stays the same
- Line 15: `"title": "OpenWork"` → `"title": "Veslo"`
- Line 38: `"sidecars/opencode"` → `"sidecars/veslo-code"`
- Line 39: `"sidecars/openwork-server"` → `"sidecars/veslo-server"`
- Line 40: `"sidecars/opencode-router"` → `"sidecars/veslo-code-router"`
- Line 41: `"sidecars/openwork-orchestrator"` → `"sidecars/veslo-orchestrator"`
- Line 50: `"openwork"` → `"veslo"` (deep-link scheme)
- Line 55: Keep pubkey as-is (will be replaced when new key is generated)
- Line 57: `"https://github.com/different-ai/openwork/releases/latest/download/latest.json"` → `"https://github.com/neatech/veslo/releases/latest/download/latest.json"`

**Step 2: Update tauri.dev.conf.json**

Replace entire file content:
```json
{
  "$schema": "https://schema.tauri.app/config/2",
  "productName": "Veslo Dev",
  "identifier": "com.neatech.veslo.dev"
}
```

**Step 3: Update capabilities/default.json**

- Line 3: `"identifier": "openwork-default"` → `"identifier": "veslo-default"`
- Line 4: `"description": "Default OpenWork capability (UI permissions)"` → `"description": "Default Veslo capability (UI permissions)"`

**Step 4: Update Cargo.toml**

- Line 2: `name = "openwork"` → `name = "veslo"`
- Line 4: `description = "OpenWork"` → `description = "Veslo"`
- Line 5: `authors = ["Different AI"]` → `authors = ["Neatech"]`

**Step 5: Commit**

```bash
git add packages/desktop/src-tauri/tauri.conf.json packages/desktop/src-tauri/tauri.dev.conf.json packages/desktop/src-tauri/capabilities/default.json packages/desktop/src-tauri/Cargo.toml
git commit -m "refactor: rename Tauri app identity from OpenWork to Veslo"
```

---

### Task 2: Rust Source Code Rename

This task renames all Rust source files, modules, types, and string references.

**Files:**
- Rename directory: `packages/desktop/src-tauri/src/openwork_server/` → `packages/desktop/src-tauri/src/veslo_server/`
- Rename file: `packages/desktop/src-tauri/src/commands/openwork_server.rs` → `packages/desktop/src-tauri/src/commands/veslo_server.rs`
- Modify: `packages/desktop/src-tauri/src/main.rs`
- Modify: `packages/desktop/src-tauri/src/lib.rs`
- Modify: `packages/desktop/src-tauri/src/types.rs`
- Modify: `packages/desktop/src-tauri/src/commands/mod.rs`
- Modify: `packages/desktop/src-tauri/src/commands/orchestrator.rs`
- Modify: `packages/desktop/src-tauri/src/commands/engine.rs`
- Modify: `packages/desktop/src-tauri/src/commands/misc.rs`
- Modify: `packages/desktop/src-tauri/src/commands/workspace.rs`
- Modify: `packages/desktop/src-tauri/src/workspace/watch.rs`
- Modify: `packages/desktop/src-tauri/src/workspace/state.rs`
- Modify: `packages/desktop/src-tauri/src/workspace/files.rs`
- Modify: `packages/desktop/src-tauri/src/orchestrator/manager.rs`
- Modify: `packages/desktop/src-tauri/src/orchestrator/mod.rs`
- Modify: `packages/desktop/src-tauri/src/engine/spawn.rs`
- Modify: `packages/desktop/src-tauri/src/engine/doctor.rs`
- Modify: All files in `packages/desktop/src-tauri/src/veslo_server/` (after rename)

**Step 1: Rename the openwork_server directory and command file**

```bash
cd "packages/desktop/src-tauri/src"
git mv openwork_server veslo_server
git mv commands/openwork_server.rs commands/veslo_server.rs
```

**Step 2: Update main.rs**

- Line 4: `openwork::run()` → `veslo::run()`

**Step 3: Update lib.rs**

Apply these replacements throughout the file:
- `mod openwork_server` → `mod veslo_server`
- `reset_openwork_state` → `reset_veslo_state`
- `openwork_server_info` → `veslo_server_info`
- `openwork_server_restart` → `veslo_server_restart`
- `sandbox_cleanup_openwork_containers` → `sandbox_cleanup_veslo_containers`
- `workspace_openwork_read` → `workspace_veslo_read`
- `workspace_openwork_write` → `workspace_veslo_write`
- `OpenworkServerManager` → `VesloServerManager`
- `use openwork_server::manager::OpenworkServerManager` → `use veslo_server::manager::VesloServerManager`
- Comment: `orchestrator/opencode/openwork-server processes` → `orchestrator/veslo-code/veslo-server processes`

**Step 4: Update types.rs**

- `#[serde(rename = "openwork-orchestrator")]` → `#[serde(rename = "veslo-orchestrator")]`
- `pub openwork_host_url` → `pub veslo_host_url`
- `pub openwork_token` → `pub veslo_token`
- `pub openwork_workspace_id` → `pub veslo_workspace_id`
- `pub openwork_workspace_name` → `pub veslo_workspace_name`

**IMPORTANT for types.rs:** The `#[serde(rename = "...")]` attributes control JSON serialization. If the frontend reads these fields, the frontend must also be updated (handled in Task 5). Check if the serde renames use `camelCase` — if fields are `#[serde(rename_all = "camelCase")]` on the struct, the JSON keys are derived from the Rust field names. Renaming `openwork_host_url` would change the JSON key from `openworkHostUrl` to `vesloHostUrl`. Grep the frontend for these JSON keys and update them in Task 5.

**Step 5: Update commands/mod.rs**

- `pub mod openwork_server` → `pub mod veslo_server`

**Step 6: Update commands/orchestrator.rs**

- Line 23: `"openwork://sandbox-create-progress"` → `"veslo://sandbox-create-progress"`
- `pub openwork_url` → `pub veslo_url` (in OrchestratorDetachedHost struct)
- Any other `openwork` references in function names or comments

**Step 7: Update commands/engine.rs, commands/misc.rs, commands/workspace.rs**

Search each file for `openwork` and replace per the naming table:
- Function names: `openwork_*` → `veslo_*`
- Type references: `Openwork*` → `Veslo*`
- String literals containing `openwork` → `veslo`

**Step 8: Update workspace/watch.rs**

- Line 11: `"openwork://reload-required"` → `"veslo://reload-required"`
- Line 28-29: Comments `// Ignore OpenWork metadata` → `// Ignore Veslo metadata`; `openwork.json` reference — keep as-is if it refers to a config file name that hasn't changed, or rename if it's a Veslo-specific config

**Step 9: Update workspace/state.rs, workspace/files.rs**

Search for `openwork` references and rename per the naming table.

**Step 10: Update orchestrator/manager.rs, orchestrator/mod.rs**

Search for `openwork` references and rename. These likely reference `openwork-orchestrator` binary name and `openwork-server`.

**Step 11: Update engine/spawn.rs, engine/doctor.rs**

Search for `openwork` references and rename.

**Step 12: Update veslo_server/ module files (mod.rs, spawn.rs)**

After the directory rename, update internal references within these files.

**Step 13: Verify Rust compiles**

```bash
cd packages/desktop/src-tauri
cargo check 2>&1 | head -50
```

Expected: no compilation errors (may warn about unused if frontend isn't updated yet)

**Step 14: Commit**

```bash
git add packages/desktop/src-tauri/src/
git commit -m "refactor: rename Rust source from openwork to veslo"
```

---

### Task 3: Package Configs & Root Workspace

**Files:**
- Modify: `package.json` (root)
- Modify: `packages/desktop/package.json`
- Modify: `packages/app/package.json`
- Modify: `packages/orchestrator/package.json`
- Modify: `packages/server/package.json`
- Modify: `packages/opencode-router/package.json`
- Modify: `packages/landing/package.json`
- Modify: `services/openwork-share/package.json`

**Step 1: Update root package.json**

- Line 2: `"name": "@different-ai/openwork-workspace"` → `"name": "@neatech/veslo-workspace"`
- Lines 6-35: Replace ALL `@different-ai/openwork` with `@neatech/veslo` and `@different-ai/openwork-ui` with `@neatech/veslo-ui` in script filter commands
- Line 24: `openwork-orchestrator` → `veslo-orchestrator` in test:orchestrator filter

**Step 2: Update packages/desktop/package.json**

- Line 2: `"name": "@different-ai/openwork"` → `"name": "@neatech/veslo"`
- Line 9: `OPENWORK_DATA_DIR="$HOME/.openwork/openwork-orchestrator-dev"` → `VESLO_DATA_DIR="$HOME/.veslo/veslo-orchestrator-dev"` in dev script

**Step 3: Update packages/app/package.json**

- Line 2: `"name": "@different-ai/openwork-ui"` → `"name": "@neatech/veslo-ui"`

**Step 4: Update packages/orchestrator/package.json**

- Line 2: `"name": "openwork-orchestrator"` → `"name": "veslo-orchestrator"`
- Line 5: Update description replacing OpenWork with Veslo, opencode references stay
- Line 29: `"url": "git+https://github.com/different-ai/openwork.git"` → `"url": "git+https://github.com/neatech/veslo.git"`
- Line 32: Update homepage URL
- Lines 37-38: Update keywords

**Step 5: Update packages/server/package.json**

- Line 2: `"name": "openwork-server"` → `"name": "veslo-server"`
- Line 4: Update description
- Line 25: Update repo URL
- Line 28: Update homepage URL
- Lines 33-35: Update keywords

**Step 6: Update packages/opencode-router/package.json**

- Line 2: `"name": "opencode-router"` → `"name": "veslo-code-router"` (if name field exists)
- Line 4: Update description
- Line 13: Update repo URL

**Step 7: Update packages/landing/package.json**

- Line 2: `"name": "@different-ai/openwork-landing"` → `"name": "@neatech/veslo-landing"`

**Step 8: Update services/openwork-share/package.json**

- Line 2: `"name": "openwork-share-service"` → `"name": "veslo-share-service"`
- Line 7: Update build message

**Step 9: Commit**

```bash
git add package.json packages/desktop/package.json packages/app/package.json packages/orchestrator/package.json packages/server/package.json packages/opencode-router/package.json packages/landing/package.json services/openwork-share/package.json
git commit -m "refactor: rename all package.json names from openwork to veslo"
```

---

### Task 4: Desktop Scripts & Sidecar Preparation

**Files:**
- Modify: `packages/desktop/scripts/prepare-sidecar.mjs`

**Step 1: Update prepare-sidecar.mjs**

Search the entire file and apply these replacements:
- `OPENWORK_SIDECAR_FORCE_BUILD` → `VESLO_SIDECAR_FORCE_BUILD`
- `OPENWORK_SIDECAR_DIR` → `VESLO_SIDECAR_DIR`
- `OPENWORK_OPENCODE_GITHUB_REPO` → `VESLO_OPENCODE_GITHUB_REPO`
- `openwork-server` (as binary/package name) → `veslo-server`
- `openworkServer` (variable names) → `vesloServer`
- `openwork-orchestrator` → `veslo-orchestrator`
- `"openwork-server"` (in version object keys) → `"veslo-server"`
- `"openwork-orchestrator"` (in version object keys) → `"veslo-orchestrator"`
- `opencode` (as binary name, NOT as engine/project name) → `veslo-code`
- `opencode-router` (as binary/package name) → `veslo-code-router`
- Any `OPENWORK_CHROME_DEVTOOLS_MCP_VERSION` → `VESLO_CHROME_DEVTOOLS_MCP_VERSION`

**IMPORTANT:** Be careful with `opencode` — only rename when it refers to the binary being bundled as a sidecar (the file name in sidecars/). Do NOT rename references to the upstream OpenCode project or its GitHub repo.

**Step 2: Commit**

```bash
git add packages/desktop/scripts/prepare-sidecar.mjs
git commit -m "refactor: rename sidecar script references from openwork to veslo"
```

---

### Task 5: App UI TypeScript — Core Files

This task handles the main app source files. There are ~50 files to update.

**Files (all under `packages/app/src/`):**
- Rename: `app/lib/openwork-server.ts` → `app/lib/veslo-server.ts`
- Rename: `app/context/openwork-server.ts` → `app/context/veslo-server.ts`
- Rename: `app/components/openwork-logo.tsx` → `app/components/veslo-logo.tsx`
- Rename: `app/commands/openwork_server.rs` (already handled in Task 2)
- Modify: All ~50 files listed in the design audit

**Step 1: Rename files**

```bash
cd "packages/app/src"
git mv app/lib/openwork-server.ts app/lib/veslo-server.ts
git mv app/context/openwork-server.ts app/context/veslo-server.ts
git mv app/components/openwork-logo.tsx app/components/veslo-logo.tsx
```

**Step 2: Update veslo-server.ts (formerly openwork-server.ts)**

Search and replace throughout the file:
- `OpenworkServer` → `VesloServer` (type/interface names)
- `openworkServer` → `vesloServer` (variable/function names)
- `openwork` → `veslo` in string literals (e.g. `"openwork"` source type)
- `OpenWork` → `Veslo` in comments and descriptions

**Step 3: Update veslo-server.ts context file (formerly context/openwork-server.ts)**

- Update all imports from `../lib/openwork-server` → `../lib/veslo-server`
- Rename all `OpenworkServer*` types to `VesloServer*`
- Rename all `openworkServer*` functions to `vesloServer*`

**Step 4: Update veslo-logo.tsx (formerly openwork-logo.tsx)**

- `export default function OpenWorkLogo` → `export default function VesloLogo`
- `src="/openwork-logo.svg"` → `src="/veslo-logo.svg"`
- `alt="OpenWork"` → `alt="Veslo"`

**Step 5: Update all importing files**

Every file that imports from the renamed files needs updating. Search for these import paths and update them:
- `from "./openwork-server"` or `from "../lib/openwork-server"` → use `veslo-server`
- `from "./openwork-logo"` or `from "../components/openwork-logo"` → use `veslo-logo`
- `from "../context/openwork-server"` → use `veslo-server`

Key files to update imports in:
- `app/app.tsx` — imports, deep-link `openwork://` → `veslo://`, branding strings
- `app/context/workspace.ts` — `openwork://sandbox-create-progress` → `veslo://sandbox-create-progress`
- `app/context/updater.tsx` — update messages with OpenWork → Veslo
- `app/context/session.ts` — any OpenWork references
- `app/context/global-sdk.tsx` — any OpenWork references
- `app/context/global-sync.tsx`
- `app/context/local.tsx`
- `app/context/server.tsx`
- `app/context/extensions.ts`
- `app/pages/session.tsx` — branding
- `app/pages/dashboard.tsx` — branding
- `app/pages/settings.tsx` — branding, about section
- `app/pages/mcp.tsx`
- `app/pages/skills.tsx`
- `app/pages/plugins.tsx`
- `app/pages/onboarding.tsx`
- `app/pages/config.tsx`
- `app/pages/soul.tsx`
- `app/pages/scheduled.tsx`
- `app/pages/proto-workspaces.tsx`
- `app/pages/identities.tsx`
- `app/components/provider-auth-modal.tsx`
- `app/components/mcp-auth-modal.tsx`
- `app/components/workspace-switch-overlay.tsx`
- `app/components/share-workspace-modal.tsx`
- `app/components/create-remote-workspace-modal.tsx`
- `app/components/status-bar.tsx`
- `app/components/question-modal.tsx`
- `app/components/part-view.tsx`
- `app/components/session/sidebar.tsx`
- `app/components/session/workspace-session-list.tsx`
- `app/components/session/context-panel.tsx`
- `app/components/session/inbox-panel.tsx`
- `app/components/session/message-list.tsx`
- `app/components/session/composer.tsx`
- `app/system-state.ts`
- `app/constants.ts`
- `app/types.ts`
- `app/theme.ts`
- `app/mcp.ts`
- `app/entry.tsx`
- `app/lib/opencode.ts` — `mode?: "basic" | "openwork"` → `mode?: "basic" | "veslo"`, and `auth?.mode === "openwork"` → `auth?.mode === "veslo"`
- `app/lib/opencode-session.ts`
- `app/lib/tauri.ts`
- `app/lib/perf-log.ts`
- `app/lib/publisher.ts`
- `app/lib/font-zoom.ts`
- `app/utils/index.ts`
- `app/utils/persist.ts`
- `app/utils/plugins.ts`
- `app/utils/providers.ts`

**Replacement rules for all files:**
1. Import paths: `openwork-server` → `veslo-server`, `openwork-logo` → `veslo-logo`
2. Type names: `Openwork*` → `Veslo*`
3. Variable names: `openwork*` → `veslo*`
4. String literals: `"openwork"` → `"veslo"`, `"OpenWork"` → `"Veslo"`
5. Deep-links: `openwork://` → `veslo://`
6. JSON keys from Rust serde: `openworkHostUrl` → `vesloHostUrl`, `openworkToken` → `vesloToken`, etc.
7. Do NOT rename `opencode` when it refers to the OpenCode engine/SDK

**Step 6: Verify TypeScript compiles**

```bash
pnpm --filter @neatech/veslo-ui typecheck 2>&1 | head -50
```

**Step 7: Commit**

```bash
git add packages/app/src/
git commit -m "refactor: rename app UI source from OpenWork to Veslo"
```

---

### Task 6: Internationalization Strings

**Files:**
- Modify: `packages/app/src/i18n/locales/en.ts`
- Modify: `packages/app/src/i18n/locales/zh.ts`

**Step 1: Update en.ts**

Replace all user-facing "OpenWork" strings with "Veslo":
- Line 3: Comment — update "OpenWork" to "Veslo" in the list of untranslated terms
- Line 35: `OpenWork will run it` → `Veslo will run it`
- Line 60: `an OpenWork server` → `a Veslo server`
- Line 63: `the OpenWork server details` → `the Veslo server details`
- Line 66: `an OpenWork server` → `a Veslo server`
- Lines 67-78: All `OpenWork server URL`, `OpenWork server` → `Veslo server URL`, `Veslo server`
- Line 156: `Ask OpenWork...` → `Ask Veslo...`
- Line 231: `connected OpenWork server` → `connected Veslo server`
- Line 251: `Connect an OpenWork server` → `Connect a Veslo server`
- Line 308: `so OpenWork can use them` → `so Veslo can use them`
- Line 316: `what OpenWork can do` → `what Veslo can do`
- All other occurrences of `OpenWork` → `Veslo`
- `openwork.app` → `veslo.neatech.com` (if present)

**Step 2: Update zh.ts**

Apply same pattern — replace `OpenWork` with `Veslo` in all Chinese translation strings.

**Step 3: Commit**

```bash
git add packages/app/src/i18n/
git commit -m "refactor: rename i18n strings from OpenWork to Veslo"
```

---

### Task 7: Static Assets Rename

**Files:**
- Rename: `packages/app/public/openwork-logo.svg` → `packages/app/public/veslo-logo.svg`
- Rename: `packages/app/public/openwork-logo-square.svg` → `packages/app/public/veslo-logo-square.svg`
- Rename: `packages/landing/public/openwork-logo.svg` → `packages/landing/public/veslo-logo.svg`

**Step 1: Rename logo files**

```bash
git mv packages/app/public/openwork-logo.svg packages/app/public/veslo-logo.svg
git mv packages/app/public/openwork-logo-square.svg packages/app/public/veslo-logo-square.svg
git mv packages/landing/public/openwork-logo.svg packages/landing/public/veslo-logo.svg
```

**Step 2: Update any references to these filenames**

Grep for `openwork-logo` across the codebase and update paths (most should already be done in Task 5, but verify landing page files too).

**Step 3: Commit**

```bash
git add packages/app/public/ packages/landing/public/
git commit -m "refactor: rename logo asset files from openwork to veslo"
```

---

### Task 8: Release Pipeline & CI

**Files:**
- Modify: `.github/workflows/release-macos-aarch64.yml`
- Modify: `.github/workflows/prerelease.yml`
- Modify: `scripts/release/generate-latest-json.mjs`
- Modify: `scripts/release/verify-tag.mjs`
- Modify: `scripts/release/review.mjs`
- Modify: `scripts/release/ship.mjs` (if it has openwork references)
- Modify: `scripts/release/prepare.mjs` (if it has openwork references)

**Step 1: Update release-macos-aarch64.yml**

- Line 15: `release_name` description: `"OpenWork <tag>"` → `"Veslo <tag>"`
- Line 42: Description: `openwork-orchestrator sidecar` → `veslo-orchestrator sidecar`
- Line 47: Description: `openwork-orchestrator/openwork-server/opencode-router` → `veslo-orchestrator/veslo-server/veslo-code-router`
- Line 115: `RELEASE_NAME="OpenWork $TAG"` → `RELEASE_NAME="Veslo $TAG"`
- Line 168: `__OPENWORK_RELEASE_BODY_EOF__` → `__VESLO_RELEASE_BODY_EOF__` (all instances)
- Line 367: User-Agent: `openwork-ci` → `veslo-ci` (both in release and prerelease workflows)
- Lines 537, 566: `releaseAssetNamePattern: openwork-desktop-[platform]-[arch][ext]` → `veslo-desktop-[platform]-[arch][ext]`
- Line 589: Verify `tmp_dir` var: `openwork-bundle-verify` → `veslo-bundle-verify`
- Lines 595-596: `openwork-desktop-darwin-` → `veslo-desktop-darwin-`
- Line 598: `openwork-desktop-darwin-` → `veslo-desktop-darwin-`
- Line 600: `OpenWork.app` → `Veslo.app`
- Line 645: Job name: `openwork-orchestrator Sidecars` → `veslo-orchestrator Sidecars`
- Line 694: Filter: `openwork-orchestrator` → `veslo-orchestrator`
- Lines 710-711: Release tag: `openwork-orchestrator-v` → `veslo-orchestrator-v`
- Line 720: Build script: `openwork-orchestrator build:sidecars` → `veslo-orchestrator build:sidecars`
- Lines 727-738: Release create: all `openwork-orchestrator` → `veslo-orchestrator`
- Line 746: Upload: `openwork-orchestrator-v` → `veslo-orchestrator-v`
- Lines 816-818: npm view: `openwork-orchestrator` → `veslo-orchestrator`, `openwork-server` → `veslo-server`, `opencode-router` → `veslo-code-router`
- Lines 869, 875, 887-888: Publish filters and tags
- Line 925-926: Bot name: `"OpenWork Release Bot"` → `"Veslo Release Bot"`, email stays `release-bot@users.noreply.github.com`
- Line 933: AUR_REPO default: `openwork` → `veslo`

**Step 2: Update prerelease.yml**

- Line 35: `name="OpenWork ${tag}"` → `name="Veslo ${tag}"`
- Line 41-52: `__OPENWORK_RELEASE_BODY_EOF__` → `__VESLO_RELEASE_BODY_EOF__`
- Line 177: User-Agent: `openwork-ci` → `veslo-ci`

**Step 3: Update generate-latest-json.mjs**

- Line 17: `repo: ... "different-ai/openwork"` → `"neatech/veslo"`
- Line 49: `assetName.startsWith("openwork-desktop-")` → `assetName.startsWith("veslo-desktop-")`
- Line 51: `assetName.slice("openwork-desktop-".length)` → `assetName.slice("veslo-desktop-".length)`
- Line 106: `"User-Agent": "openwork-release-latest-json"` → `"User-Agent": "veslo-release-latest-json"`

**Step 4: Update verify-tag.mjs**

- Line 54: `"openwork-orchestrator"` → `"veslo-orchestrator"`
- Line 55: `"openwork-server"` → `"veslo-server"`
- Line 68: Update log message

**Step 5: Update review.mjs**

- All references to `openwork-orchestrator` → `veslo-orchestrator`
- All references to `openwork-server` → `veslo-server`
- `openworkServer*` variable names → `vesloServer*`
- `openwork-orchestrator-sidecars.json` → `veslo-orchestrator-sidecars.json`

**Step 6: Check and update ship.mjs and prepare.mjs**

Search for `openwork` and `different-ai` references and update if found.

**Step 7: Commit**

```bash
git add .github/workflows/ scripts/release/
git commit -m "refactor: rename CI/release pipeline from openwork to veslo"
```

---

### Task 9: Web & Landing Pages

**Files:**
- Modify: `packages/web/app/layout.tsx`
- Modify: `packages/web/app/page.tsx`
- Modify: `packages/web/components/cloud-control.tsx`
- Modify: `packages/web/app/api/den/[...path]/route.ts` (if has openwork refs)
- Modify: `packages/web/app/api/loops/den-signup/route.ts` (if has openwork refs)
- Modify: `packages/landing/app/page.tsx`
- Modify: `packages/landing/app/layout.tsx`
- Modify: `packages/landing/app/download/page.tsx`
- Modify: `packages/landing/app/enterprise/page.tsx`
- Modify: `packages/landing/app/den/page.tsx`
- Modify: `packages/landing/app/starter-success/page.tsx`
- Modify: `packages/landing/components/site-nav.tsx`
- Modify: `packages/landing/components/site-footer.tsx`
- Modify: `packages/landing/lib/github.ts`
- Modify: `packages/landing/next.config.js`

**Step 1: Update packages/web files**

- `packages/web/app/layout.tsx`: Title `"OpenWork Cloud"` → `"Veslo Cloud"`, description with `app.openwork.software` → `app.veslo.neatech.com`
- `packages/web/app/page.tsx`: `OpenWork` brand text → `Veslo`
- `packages/web/components/cloud-control.tsx`: `openwork://connect-remote` → `veslo://connect-remote`
- API routes: check for `openwork` string references and update

**Step 2: Update packages/landing files**

For each landing page file, replace:
- `OpenWork` → `Veslo` in all user-facing text
- `openwork.software` domain → `veslo.neatech.com`
- `different-ai/openwork` → `neatech/veslo` in GitHub links
- `openwork-orchestrator` → `veslo-orchestrator` in install commands
- `openwork start` → `veslo start` in CLI examples
- `opencode-router` → `veslo-code-router` in install commands
- `openwork-logo.svg` → `veslo-logo.svg` in asset references

**Step 3: Update landing/lib/github.ts**

This likely fetches GitHub release data — update repo references from `different-ai/openwork` to `neatech/veslo`.

**Step 4: Update landing/next.config.js**

Check for domain redirects or rewrites referencing `openwork.software`.

**Step 5: Commit**

```bash
git add packages/web/ packages/landing/
git commit -m "refactor: rename web and landing pages from OpenWork to Veslo"
```

---

### Task 10: Services & Packaging

**Files:**
- Modify: `services/openwork-share/api/b/render-bundle-page.js`
- Modify: `services/openwork-share/api/b/[id].js`
- Modify: `services/openwork-share/api/b/render-bundle-page.test.js`
- Modify: `services/openwork-share/api/v1/bundles.js`
- Modify: `services/openwork-share/README.md`
- Modify: `packaging/aur/PKGBUILD`
- Modify: `packaging/aur/.SRCINFO`

**Step 1: Update openwork-share service files**

In `render-bundle-page.js`:
- Line 1: `OPENWORK_SITE_URL = "https://openwork.software"` → `VESLO_SITE_URL = "https://veslo.neatech.com"`
- Line 2: `OPENWORK_DOWNLOAD_URL` → `VESLO_DOWNLOAD_URL`
- Lines 3-6: `OPENWORK_APP_URL`, `app.openwork.software` → `VESLO_APP_URL`, `app.veslo.neatech.com`
- Line 68: `openwork://import-bundle` → `veslo://import-bundle`
- Line 249: `OpenWork Share` → `Veslo Share`
- All `openwork-bundle-id` data attributes → `veslo-bundle-id`
- All `openwork-bundle` references → `veslo-bundle`

In `[id].js`:
- Line 54: `openwork-bundle-${id}.json` → `veslo-bundle-${id}.json`

In `bundles.js` and test file:
- Search for `openwork` and replace per naming table

In `README.md`:
- All `openwork://` → `veslo://`
- All `OpenWork` → `Veslo`

**Step 2: Update PKGBUILD**

- Line 1: `pkgname=openwork` → `pkgname=veslo`
- Line 4: `pkgdesc="An Open source alternative to Claude Cowork"` → update description with Veslo
- Line 6: `url="https://github.com/different-ai/openwork"` → `url="https://github.com/neatech/veslo"`
- Lines 11, 14: `openwork-${pkgver}.deb` → `veslo-${pkgver}.deb`
- Lines 18, 30, 37: `openwork-desktop-linux-amd64.deb` → `veslo-desktop-linux-amd64.deb`, `opt/openwork/` → `opt/veslo/`, `/usr/bin/openwork` → `/usr/bin/veslo`

**Step 3: Update .SRCINFO**

- Line 1: `pkgbase = openwork` → `pkgbase = veslo`
- Line 2: Update description
- Line 5: Update URL
- Lines 17-20: Update source and sha256sums references

**Step 4: Commit**

```bash
git add services/openwork-share/ packaging/aur/
git commit -m "refactor: rename services and packaging from openwork to veslo"
```

---

### Task 11: Documentation & README

**Files:**
- Modify: `README.md`

**Step 1: Update README.md**

Replace throughout the file:
- `# OpenWork` → `# Veslo`
- All `OpenWork` → `Veslo` in descriptions
- `different-ai/openwork` → `neatech/veslo` in URLs
- `@different-ai/openwork` → `@neatech/veslo` in commands
- `openwork-orchestrator` → `veslo-orchestrator` in install commands
- `openwork start` → `veslo start` in CLI examples
- `opencode-router` → `veslo-code-router` where it refers to the renamed package
- `openwork.software` → `veslo.neatech.com`
- `WEBKIT_DISABLE_DMABUF_RENDERER=1 openwork` → `WEBKIT_DISABLE_DMABUF_RENDERER=1 veslo`
- Keep references to `opencode` as the OpenCode engine, `.opencode/` directory, `opencode.json`

**Step 2: Commit**

```bash
git add README.md
git commit -m "refactor: rename README from OpenWork to Veslo"
```

---

### Task 12: Final Verification & Cleanup

**Files:** None (verification only)

**Step 1: Search for any remaining openwork references**

```bash
grep -ri "openwork" --include="*.ts" --include="*.tsx" --include="*.rs" --include="*.json" --include="*.yml" --include="*.mjs" --include="*.js" --include="*.md" -l . | grep -v node_modules | grep -v target | grep -v .git | grep -v pnpm-lock | grep -v Cargo.lock | grep -v ".solutions"
```

Any remaining files should be examined — they may be legitimate (e.g. `openwork.json` config file references) or may need additional updates.

**Step 2: Search for remaining different-ai references**

```bash
grep -ri "different-ai\|differentai\|Different AI" --include="*.ts" --include="*.tsx" --include="*.rs" --include="*.json" --include="*.yml" --include="*.mjs" --include="*.js" --include="*.md" -l . | grep -v node_modules | grep -v target | grep -v .git | grep -v pnpm-lock | grep -v Cargo.lock
```

**Step 3: Verify TypeScript compiles**

```bash
pnpm --filter @neatech/veslo-ui typecheck
```

**Step 4: Verify Rust compiles**

```bash
cd packages/desktop/src-tauri && cargo check
```

**Step 5: Run health tests**

```bash
pnpm test:health
```

**Step 6: Fix any remaining issues found in steps 1-5**

**Step 7: Final commit if any cleanup was needed**

```bash
git add -A
git commit -m "refactor: final cleanup for Veslo rebrand"
```
