# Rebrand: OpenWork → Veslo by Neatech

**Date:** 2026-03-06
**Status:** Approved

## Summary

Full rebrand of the app from "OpenWork" by "Different AI" to "Veslo" by "Neatech". Covers app identity, deep-links, updater config, release pipelines, UI strings, packaging, and all code references.

## Naming Table

| Context | Old | New |
|---------|-----|-----|
| App name | OpenWork | Veslo |
| Company | Different AI | Neatech |
| GitHub repo | different-ai/openwork | neatech/veslo |
| Bundle ID | com.differentai.openwork | com.neatech.veslo |
| Bundle ID (dev) | com.differentai.openwork.dev | com.neatech.veslo.dev |
| npm scope | @different-ai/* | @neatech/* |
| Deep-link scheme | openwork:// | veslo:// |
| Updater endpoint | github.com/different-ai/openwork/... | github.com/neatech/veslo/... |
| Web domain | app.openwork.software | app.veslo.neatech.com |
| AUR package | openwork | veslo |
| Rust crate | openwork | veslo |
| Release assets | openwork-desktop-* | veslo-desktop-* |
| Orchestrator tag | openwork-orchestrator-v* | veslo-orchestrator-v* |
| npm: orchestrator | openwork-orchestrator | veslo-orchestrator |
| npm: server | openwork-server | veslo-server |
| npm: opencode-router | opencode-router | veslo-code-router |
| Terminal binary | opencode | veslo-code |
| CI user-agent | openwork-ci | veslo-ci |
| Release bot | OpenWork Release Bot | Veslo Release Bot |
| Logo files | openwork-logo* | veslo-logo* |
| Logo component | openwork-logo.tsx | veslo-logo.tsx |
| Web title | OpenWork Cloud | Veslo Cloud |
| Capability ID | openwork-default | veslo-default |

## Files to Edit

### Category 1 — Tauri App Identity
- `packages/desktop/src-tauri/tauri.conf.json` — productName, identifier, window title, deep-link scheme, updater endpoint, updater pubkey
- `packages/desktop/src-tauri/tauri.dev.conf.json` — productName, identifier
- `packages/desktop/src-tauri/capabilities/default.json` — capability identifier and description

### Category 2 — Rust Source
- `packages/desktop/src-tauri/Cargo.toml` — crate name, description, authors
- `packages/desktop/src-tauri/src/commands/orchestrator.rs` — `openwork://` event strings
- `packages/desktop/src-tauri/src/workspace/watch.rs` — `openwork://` event strings

### Category 3 — Package Configs
- `package.json` (root) — workspace name
- `packages/desktop/package.json` — package name
- `packages/app/package.json` — package name
- Other workspace package.json files referencing old names

### Category 4 — Release Pipeline
- `.github/workflows/release-macos-aarch64.yml` — release name, asset patterns, npm package names, orchestrator tags, user-agent, bot name, EOF markers, AUR_REPO
- `.github/workflows/prerelease.yml` — release name, EOF markers, user-agent
- `scripts/release/generate-latest-json.mjs` — default repo, asset prefix, user-agent

### Category 5 — App UI & i18n
- `packages/app/src/app/app.tsx` — deep-link handling, branding
- `packages/app/src/app/components/openwork-logo.tsx` — rename file + update references
- `packages/app/src/i18n/locales/en.ts` — English strings
- `packages/app/src/i18n/locales/zh.ts` — Chinese strings
- `packages/app/src/app/pages/settings.tsx` — branding references
- `packages/app/src/app/context/updater.tsx` — update messages
- `packages/app/src/app/system-state.ts` — constants
- `packages/app/src/app/context/workspace.ts` — `openwork://` events

### Category 6 — Web/Landing
- `packages/web/app/layout.tsx` — title, description, domain
- `packages/web/components/cloud-control.tsx` — `openwork://connect-remote` deep-link
- Landing page files with OpenWork branding

### Category 7 — Packaging
- `packaging/aur/PKGBUILD` — pkgname, description, url
- `packaging/aur/.SRCINFO` — same fields

### Category 8 — Services
- `services/openwork-share/` — deep-link references (`openwork://import-bundle`)

### Category 9 — Static Assets (file renames)
- `packages/app/public/openwork-logo.svg` → `veslo-logo.svg`
- `packages/app/public/openwork-logo-square.svg` → `veslo-logo-square.svg`
- `packages/landing/public/openwork-logo.svg` → `veslo-logo.svg`

### Category 10 — Documentation
- `README.md`

## External Actions Required
- Transfer/rename GitHub repo from different-ai/openwork to neatech/veslo
- Generate new Tauri updater signing keypair
- Update GitHub secrets with new signing keys
- Register new npm org @neatech (if not already done)
- Set up DNS for app.veslo.neatech.com

## Approach
Surgical rename — edit each file individually with targeted replacements. No global search-replace to avoid accidentally renaming things we want to keep.

## Out of Scope
- Visual rebrand (new icons/logos artwork) — separate task
- Actual GitHub repo transfer — manual action in GitHub Settings
