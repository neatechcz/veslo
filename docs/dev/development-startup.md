# Development Startup Guide

Use this guide whenever someone asks to start Veslo during development (for example `spust`, `start app`, `run in dev mode`).

## Scope

- Authoritative runtime: `packages/desktop` (Tauri desktop app)
- Primary development mode: local mode with local OpenCode (do not treat cloud-backed execution as the default startup path)
- Do not use `packages/web` or UI-only web servers as proof that the app is running correctly.
- Do not start `pnpm -w dev:ui`, `pnpm --filter @neatech/veslo-ui dev`, or raw Vite as the Veslo app runtime.
- Never launch a previously built desktop app as a substitute for development startup. Always run a new build from current sources before starting.
- Veslo desktop is single-tenant during development and testing. Agents must clear internally started dev/test runtime instances before launching another runtime.

## Standard Dev Startup (Fresh Build Required, No Exceptions)

Run from repository root.

1. Verify whether app/dev processes are already running.
2. Stop previous app/dev processes and verify they are fully stopped.
3. Rebuild desktop artifacts from source.
4. Start Tauri dev runtime.
5. Confirm the expected runtime signals.

Never launch a second app/dev instance. This rule applies to normal development startup and to test runs, and it is an agent runbook responsibility rather than per-test spec logic.

```bash
# 1) Mandatory pre-check: detect already-running instances
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true

# 2) Stop previous internally started dev/test runs (safe if nothing is running)
pkill -f "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true

# 2b) Mandatory post-check: must be empty before continuing
pgrep -fl "pnpm -w dev:ui|pnpm --filter @neatech/veslo-ui dev|pnpm --filter @neatech/veslo dev|tauri dev --config src-tauri/tauri.dev.conf.json|vite/bin/vite.js|bun --watch src/cli\\.ts|/target/debug/veslo|target/debug/bundle/macos/(Veslo Dev|Veslo by Neatech)\\.app/Contents/MacOS/veslo" || true

# 3) Fresh rebuild (desktop native layer)
pnpm --filter @neatech/veslo exec cargo clean --manifest-path src-tauri/Cargo.toml
pnpm --filter @neatech/veslo exec cargo build --manifest-path src-tauri/Cargo.toml --no-default-features

# 4) Start dev runtime
pnpm dev
```

## Required Runtime Confirmation

Consider startup complete only when both appear in logs:

- `VITE ... ready` with local URL (default `http://localhost:5173/`)
- `Running target/debug/veslo`

If only Vite runs, desktop runtime is not fully started; stop it and use the desktop startup flow.

## After Server-Side Changes

If changes touched `packages/server/src`, rebuild server binary before relying on orchestrator-backed flows:

```bash
pnpm --filter openwork-server build:bin
```

Then run the standard dev startup flow above.

## PATH / Tooling Fallback

If shell PATH in automation sessions cannot find `pnpm`/`cargo`, use an explicit PATH prefix:

```bash
PATH="$HOME/.cargo/bin:$HOME/.bun/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin" /opt/homebrew/bin/pnpm dev
```

Use the same PATH prefix for the rebuild commands when needed.

## Interpretation Rule For Agents

When asked to "start" the app for development in this repo, always execute this fresh-build startup flow. Do not skip rebuild and do not launch stale prebuilt binaries as the startup path.

If the same session previously started Veslo in dev mode, stop that instance before launching tests. If an existing Veslo process cannot be identified as an internally started dev/test runtime from this repo, report it and ask for direction instead of force-killing it.
