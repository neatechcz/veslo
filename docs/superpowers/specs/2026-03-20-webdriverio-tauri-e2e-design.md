# WebdriverIO + tauri-plugin-webdriver E2E Testing for Veslo

**Date**: 2026-03-20
**Status**: Approved
**Scope**: Cross-platform UI E2E testing and visual regression for the Veslo Tauri desktop application

## Problem

Veslo has strong API-level E2E tests (Node.js scripts testing the OpenCode server via HTTP) but zero automated UI testing. The Chrome MCP verification step in the development workflow is manual and not reproducible in CI. There is no visual regression detection. UI bugs can reach production unnoticed.

## Decision

Use **WebdriverIO** with the **`tauri-plugin-webdriver`** community crate to test the real Tauri native application across macOS, Windows, and Linux. Add **`@wdio/visual-service`** for screenshot-based visual regression testing.

### Why not Playwright?

Playwright cannot connect to WKWebView on macOS (Apple provides no WebDriver/CDP for embedded WKWebView). Since Veslo is a Tauri app and macOS is a primary target, Playwright cannot test the real native binary cross-platform. The `tauri-plugin-webdriver` crate solves this by embedding a W3C WebDriver server inside the app.

## Architecture

```
WebdriverIO test specs (.spec.ts)
         |
         | W3C WebDriver protocol (HTTP)
         v
tauri-plugin-webdriver (embedded axum server, port 4445)
         |
         | Native WebView API calls
         v
WKWebView (macOS) / WebView2 (Win) / WebKitGTK (Linux)
         |
         v
   Veslo SolidJS UI (HashRouter)
```

### How it works

1. `tauri-plugin-webdriver` (Rust crate, v0.2.x) is added to the Tauri app behind a Cargo feature flag (`e2e`). The plugin registration in Rust is gated behind `#[cfg(debug_assertions)]`.
2. On debug builds with the `e2e` feature enabled, the plugin starts an axum HTTP server on `127.0.0.1:4445` that speaks W3C WebDriver protocol.
3. Platform-specific backends (`macos.rs` via `objc2-web-kit`, `windows.rs` via `webview2-com`, `linux.rs` via `webkit2gtk`) translate WebDriver commands to native WebView API calls.
4. WebdriverIO connects to port 4445 and runs test specs against the real native app.
5. `@wdio/visual-service` captures screenshots through the standard W3C screenshot endpoints and compares against baselines.

### Security

The embedded WebDriver server is **unauthenticated HTTP on localhost**. It is double-gated: behind both the `e2e` Cargo feature flag and `#[cfg(debug_assertions)]`. This means it is only compiled when explicitly requested (`--features e2e`) AND only active in debug builds. It is excluded from all production/release builds regardless of feature flags. It must never be included in release builds.

## Components

### 1. Rust plugin integration

**`packages/desktop/src-tauri/Cargo.toml`** — add the dependency behind a feature flag:

```toml
[features]
e2e = ["tauri-plugin-webdriver"]

[dependencies]
tauri-plugin-webdriver = { version = "0.2", optional = true }
```

Note: `cfg(debug_assertions)` cannot be used in Cargo.toml `[target]` tables for dependency resolution (it's a compiler flag, not a target cfg). The feature flag approach keeps the dependency out of normal builds entirely.

**`packages/desktop/src-tauri/src/lib.rs`** — register the plugin (only active when both the feature and debug mode are enabled):

```rust
#[cfg(all(debug_assertions, feature = "e2e"))]
let builder = builder.plugin(tauri_plugin_webdriver::init());
```

To build with the WebDriver plugin: `cargo tauri build --debug -- --features e2e` or set `CARGO_FLAGS=--features=e2e`.

Minimum Rust version: 1.90.

### 2. WebdriverIO test package

New package at `packages/e2e/`:

```
packages/e2e/
  package.json              # WebdriverIO + dependencies
  tsconfig.json             # TypeScript config
  wdio.conf.ts              # WebdriverIO configuration
  helpers/
    app-launcher.ts         # Spawn Tauri binary, poll /status, teardown
  specs/
    smoke.spec.ts           # App launches, main elements visible
    session.spec.ts         # Create session, see it in sidebar
    composer.spec.ts        # Type in composer, send message
    navigation.spec.ts      # Sidebar navigation, route changes
    visual-regression.spec.ts  # Screenshot baselines for key screens
  __snapshots__/            # Visual regression baselines (git-tracked)
    macos/                  # macOS-specific baselines
    windows/                # Windows-specific baselines
    linux/                  # Linux-specific baselines
```

**Dependencies:**

```json
{
  "devDependencies": {
    "@wdio/cli": "^9.6",
    "@wdio/globals": "^9.6",
    "@wdio/local-runner": "^9.6",
    "@wdio/mocha-framework": "^9.5",
    "@wdio/spec-reporter": "^9.5",
    "@wdio/visual-service": "^6",
    "webdriverio": "^9.6",
    "@types/mocha": "^10",
    "typescript": "^5.6"
  }
}
```

### 3. WebdriverIO configuration (`wdio.conf.ts`)

Key settings:

- `hostname`: `127.0.0.1`
- `port`: `4445` (direct connection to the plugin, no intermediary)
- `maxInstances`: `1` (Tauri supports one session at a time)
- `browserName`: `'chrome'` (WDIO requires this field; the plugin ignores it)
- `framework`: `mocha`
- `reporters`: `['spec']`
- `services`: `[['visual', { baselineFolder: './__snapshots__/' }]]`
- `onPrepare`: calls `app-launcher.ts` to spawn the Tauri binary
- `onComplete`: kills the Tauri process

### 4. App launcher (`helpers/app-launcher.ts`)

Responsibilities:

1. Resolve the Tauri binary path (platform-specific, supports both bundled `.app` and unbundled binary from `--no-bundle`)
2. Spawn the binary with `TAURI_WEBDRIVER_PORT=4445` environment variable
3. Poll `http://127.0.0.1:4445/status` with 250ms intervals, 30-second timeout
4. On teardown, send SIGTERM (Unix) or kill the process (Windows)

Binary path resolution (the Cargo package name is `veslo`, from `src-tauri/Cargo.toml`). With `--no-bundle` (the default for CI and local E2E), only the unbundled path exists:

- macOS: `src-tauri/target/debug/veslo`
- Windows: `src-tauri/target/debug/veslo.exe`
- Linux: `src-tauri/target/debug/veslo`

For local development where someone builds with bundling, the macOS `.app` path is: `src-tauri/target/debug/bundle/macos/Veslo by Neatech.app/Contents/MacOS/veslo`. The launcher should check the unbundled path first (most common case) and fall back to the bundled path.

Note: with `--no-bundle` on macOS, the binary runs without a dock icon or proper macOS application chrome. This is expected for CI; locally, developers can build with bundling if they want the full native experience during test debugging.

### 5. Visual regression

`@wdio/visual-service` integrates with WDIO to capture and compare screenshots:

- `browser.checkScreen('name')` — full-page comparison
- `browser.checkElement(element, 'name')` — element-level comparison
- Baselines are platform-specific (macOS/Windows/Linux render differently) and stored in `__snapshots__/<platform>/`
- On first run, baselines are created. On subsequent runs, diffs are generated.
- Diff threshold configurable (default: 0% mismatch tolerance, adjustable for antialiasing)

## Initial test cases

### smoke.spec.ts

- App window opens and is visible
- Sidebar is rendered
- Composer input is present
- No console errors on startup

### session.spec.ts

- Create a new session via UI
- Session appears in the sidebar list
- Clicking a session navigates to it

### composer.spec.ts

- Focus the composer input
- Type a message
- Submit button becomes active
- (If backend is mocked/available) Message appears in the chat

### navigation.spec.ts

- Click sidebar items, verify route changes
- Back navigation works
- Settings panel opens and closes

### visual-regression.spec.ts

- Empty state (no sessions)
- Active session view
- Settings panel
- Sidebar collapsed/expanded states

## CI workflow

**File**: `.github/workflows/e2e-ui.yml`

```yaml
name: E2E UI Tests
on:
  push:
    branches: [dev]
  pull_request:
    branches: [dev]

permissions:
  contents: read

jobs:
  e2e-ui:
    strategy:
      fail-fast: false
      matrix:
        os: [ubuntu-latest, macos-latest, windows-latest]
    runs-on: ${{ matrix.os }}
    steps:
      - uses: actions/checkout@v4

      - uses: dtolnay/rust-toolchain@stable
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: packages/desktop/src-tauri

      - uses: pnpm/action-setup@v4
        with:
          version: 10.27.0
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'pnpm'

      - name: Install dependencies
        run: pnpm install --frozen-lockfile

      # Linux-specific: install system deps
      - name: Install Linux deps
        if: runner.os == 'Linux'
        uses: awalsh128/cache-apt-pkgs-action@latest
        with:
          packages: libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xvfb
          version: "1.0"

      # Sidecar download — mirrors the approach in build-desktop.yml.
      # The beforeBuildCommand in tauri.conf.json runs prepare:sidecar,
      # which expects sidecar binaries to exist. The full sidecar download
      # logic must be adapted from build-desktop.yml (which downloads
      # platform-specific OpenCode binaries from GitHub releases before
      # running prepare:sidecar). This is a multi-step process:
      # 1. Download platform-specific OpenCode sidecar from GitHub releases
      # 2. Place it in the expected location for prepare:sidecar
      # 3. Run prepare:sidecar to finalize
      # See build-desktop.yml for the full platform-aware download logic.
      - name: Download and prepare sidecars
        run: pnpm --filter @neatech/veslo run prepare:sidecar
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Build Tauri (debug, no bundle, e2e feature)
        run: pnpm tauri build --debug --no-bundle -- --features e2e
        working-directory: packages/desktop

      - name: Run E2E UI tests (Linux)
        if: runner.os == 'Linux'
        run: xvfb-run -a pnpm test:e2e:ui
        working-directory: packages/e2e

      - name: Run E2E UI tests (macOS/Windows)
        if: runner.os != 'Linux'
        run: pnpm test:e2e:ui
        working-directory: packages/e2e

      - name: Upload visual diffs on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: visual-diffs-${{ matrix.os }}
          path: packages/e2e/__snapshots__/**/diff/
```

### CI considerations

- `--debug` flag is required so `debug_assertions` is true and the WebDriver plugin is active
- `--no-bundle` skips DMG/NSIS/deb creation, significantly faster
- `-- --features e2e` passes the Cargo feature flag to include the WebDriver plugin
- `xvfb-run` on Linux provides a virtual display for the webview
- macOS and Windows runners have display servers available
- Visual regression diffs uploaded as artifacts when tests fail
- Rust and pnpm caches used for faster builds
- pnpm version explicitly pinned to `10.27.0` matching the root `package.json` `packageManager` field and all existing CI workflows
- Node 20 matches the existing CI workflows
- Branch triggers (`dev`) match the existing `ci.yml` pattern
- Sidecar download step is required because `beforeBuildCommand` runs `prepare:sidecar`
- First CI run with a cold Rust cache will take 10-15 minutes; subsequent cached runs are much faster

## Integration with existing tests

| Script | Layer | Framework | Runs in CI |
|--------|-------|-----------|------------|
| `pnpm test:unit` | Unit | Node `--test` | Yes (existing) |
| `pnpm test:e2e` | API | Custom Node scripts | Yes (existing) |
| `pnpm test:e2e:ui` | UI | WebdriverIO | Yes (new) |

Root `package.json` script:

```json
"test:e2e:ui": "pnpm --filter @neatech/veslo-e2e test"
```

The `packages/e2e/package.json` defines `"test": "wdio run wdio.conf.ts"` and `"test:update-baselines": "wdio run wdio.conf.ts --updateBaselines"`.

The existing `test:e2e` is unchanged.

## AGENTS.md / CLAUDE.md updates

The New Feature Workflow (steps 4-8) will be updated to reference the WebdriverIO suite as the automated UI verification gate. The Chrome MCP step becomes optional (for ad-hoc visual debugging) rather than the primary gate.

## Test environment and initial state

The Veslo app requires a workspace to be configured and an OpenCode server to be running for most UI flows. For E2E tests:

- The `app-launcher.ts` helper will set `OPENCODE_HOME` to a temporary directory, ensuring a clean state per test run.
- Smoke tests (app launches, elements visible) work with no workspace configured — they verify the empty/onboarding state.
- Session and composer tests require the app to have completed initial setup. A `beforeAll` hook in these specs will use WebDriver to navigate through any onboarding flow if present.
- If the app cannot connect to an OpenCode backend, UI tests should still verify the UI shell renders correctly (error states, loading states).

## Retry and flakiness strategy

- WDIO's `specFileRetries: 1` will be configured to retry failed spec files once before reporting failure.
- Default `waitforTimeout: 10000` (10 seconds) for element waits.
- App launch timeout: 30 seconds (configurable via env var `E2E_LAUNCH_TIMEOUT`).
- CI failures that are visual-only (screenshot diff) upload the diff artifacts for human review.

## Visual regression baseline management

- Baselines are git-tracked in `packages/e2e/__snapshots__/<platform>/`.
- When an intentional UI change is made, developers regenerate baselines: `pnpm test:e2e:ui:update-baselines`.
- The root `package.json` includes: `"test:e2e:ui:update-baselines": "pnpm --filter @neatech/veslo-e2e test:update-baselines"`.
- CI runs compare against committed baselines. If a test fails due to a visual diff, the developer must update baselines locally and commit them.
- Platform-specific baselines mean a macOS developer cannot update Linux baselines locally — CI generates those. Consider a CI job that auto-commits updated baselines on a designated branch if needed.

## URL assertions and HashRouter

The SolidJS app uses `HashRouter` for Tauri (hash-based routing). All URL assertions in tests must account for the `#` prefix. For example, the settings route is `#/settings`, not `/settings`. The `app-launcher.ts` helper should expose a `getUrl(path)` utility that prepends the hash prefix.

## Constraints and limitations

- **One session at a time**: `maxInstances: 1` is required. No parallel browser instances.
- **Debug builds only**: The WebDriver server must never ship in release builds.
- **Community crate**: `tauri-plugin-webdriver` (v0.2.x, published Feb 2026, 10 GitHub stars) is not an official Tauri project. Monitor for breaking changes.
- **Visual baselines are platform-specific**: macOS, Windows, and Linux render fonts and anti-aliasing differently. Each platform has its own baseline directory.
- **Build required**: Tests run against the compiled Tauri binary, not the Vite dev server. A `cargo tauri build --debug --no-bundle -- --features e2e` step is needed before running tests.
- **Rust 1.90+**: The plugin requires Rust 1.90 minimum.

## Dependencies added

### Rust (debug-only)

| Crate | Version | Purpose |
|-------|---------|---------|
| `tauri-plugin-webdriver` | 0.2 | Embedded W3C WebDriver server |

### Node (devDependencies, packages/e2e)

| Package | Version | Purpose |
|---------|---------|---------|
| `@wdio/cli` | ^9.6 | WebdriverIO CLI |
| `@wdio/globals` | ^9.6 | Global WDIO types |
| `@wdio/local-runner` | ^9.6 | Local test runner |
| `@wdio/mocha-framework` | ^9.5 | Mocha integration |
| `@wdio/spec-reporter` | ^9.5 | Console output |
| `@wdio/visual-service` | ^6 | Visual regression |
| `webdriverio` | ^9.6 | WebDriver client |

## Success criteria

1. `pnpm test:e2e:ui` runs the smoke test suite against the real Tauri binary on macOS
2. Visual regression baselines are captured and compared on subsequent runs
3. CI workflow passes on all three platforms (macOS, Windows, Linux)
4. The test suite detects a deliberately introduced UI regression (e.g., hiding the sidebar)
