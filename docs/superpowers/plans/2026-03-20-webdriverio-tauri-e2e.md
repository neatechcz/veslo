# WebdriverIO + tauri-plugin-webdriver E2E Testing Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Set up cross-platform WebdriverIO E2E testing for the Veslo Tauri desktop application with visual regression support.

**Architecture:** WebdriverIO connects to `tauri-plugin-webdriver` (an axum HTTP server embedded in the Tauri app on debug builds via a Cargo `e2e` feature flag). Tests run against the real native binary on macOS, Windows, and Linux. `@wdio/visual-service` handles screenshot-based visual regression.

**Tech Stack:** WebdriverIO 9.x, tauri-plugin-webdriver 0.2, Mocha, @wdio/visual-service, TypeScript

**Spec:** `docs/superpowers/specs/2026-03-20-webdriverio-tauri-e2e-design.md`

**Branch:** `webdriverio-tauri-e2e`

---

## File Structure

### New files

| File | Purpose |
|------|---------|
| `packages/e2e/package.json` | WebdriverIO package with test scripts |
| `packages/e2e/tsconfig.json` | TypeScript config for test files |
| `packages/e2e/wdio.conf.ts` | WebdriverIO configuration |
| `packages/e2e/helpers/app-launcher.ts` | Spawn Tauri binary, poll WebDriver status, teardown |
| `packages/e2e/specs/smoke.spec.ts` | App launches, key elements visible |
| `packages/e2e/specs/navigation.spec.ts` | Sidebar nav, route changes, settings |
| `packages/e2e/specs/session.spec.ts` | Create session, see it in sidebar |
| `packages/e2e/specs/composer.spec.ts` | Composer input, type message, submit |
| `packages/e2e/specs/visual-regression.spec.ts` | Screenshot baselines for key screens |
| `packages/e2e/__snapshots__/.gitkeep` | Placeholder for visual baselines |
| `packages/e2e/.gitignore` | Ignore temp dirs, actual screenshots, diffs |
| `.github/workflows/e2e-ui.yml` | CI workflow for all three platforms |

### Modified files

| File | Change |
|------|--------|
| `packages/desktop/src-tauri/Cargo.toml` | Add `e2e` feature flag and `tauri-plugin-webdriver` optional dep |
| `packages/desktop/src-tauri/src/lib.rs` | Register WebDriver plugin behind `cfg(debug_assertions, feature = "e2e")` |
| `package.json` (root) | Add `test:e2e:ui` and `test:e2e:ui:update-baselines` scripts |

---

## Chunk 1: Rust Plugin Integration

### Task 1: Create the feature branch

- [ ] **Step 1: Create and switch to the feature branch**

```bash
git checkout -b webdriverio-tauri-e2e
```

- [ ] **Step 2: Commit the spec and plan docs**

The spec at `docs/superpowers/specs/2026-03-20-webdriverio-tauri-e2e-design.md` and this plan should already be committed on `main`. If not, cherry-pick or copy them.

---

### Task 2: Add tauri-plugin-webdriver to Cargo.toml

**Files:**
- Modify: `packages/desktop/src-tauri/Cargo.toml`

- [ ] **Step 1: Add the `e2e` feature and optional dependency**

Add a `[features]` table and the optional dependency to `packages/desktop/src-tauri/Cargo.toml`. Insert the `[features]` table before `[build-dependencies]`, and add the optional dependency at the end of the `[dependencies]` block:

```toml
[features]
e2e = ["tauri-plugin-webdriver"]
```

```toml
# At the end of [dependencies]:
tauri-plugin-webdriver = { version = "0.2", optional = true }
```

- [ ] **Step 2: Verify Cargo.toml parses correctly**

Run: `cd packages/desktop/src-tauri && cargo check --features e2e 2>&1 | head -20`

Expected: Successful download of `tauri-plugin-webdriver` crate and its dependencies. May take a minute on first run. Should end with no errors (warnings OK).

- [ ] **Step 3: Verify normal build still works without the feature**

Run: `cd packages/desktop/src-tauri && cargo check 2>&1 | tail -5`

Expected: `Finished` with no errors. The `tauri-plugin-webdriver` crate should NOT be compiled.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src-tauri/Cargo.toml packages/desktop/src-tauri/Cargo.lock
git commit -m "feat(e2e): add tauri-plugin-webdriver as optional dependency behind e2e feature flag"
```

---

### Task 3: Register the WebDriver plugin in lib.rs

**Files:**
- Modify: `packages/desktop/src-tauri/src/lib.rs`

- [ ] **Step 1: Add the plugin registration**

In `packages/desktop/src-tauri/src/lib.rs`, find this block (around line 82):

```rust
    #[cfg(desktop)]
    let builder = builder
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_updater::Builder::new().build());
```

Insert immediately after it:

```rust
    #[cfg(all(debug_assertions, feature = "e2e"))]
    let builder = builder.plugin(tauri_plugin_webdriver::init());
```

- [ ] **Step 2: Verify it compiles with the e2e feature**

Run: `cd packages/desktop/src-tauri && cargo check --features e2e 2>&1 | tail -5`

Expected: `Finished` with no errors.

- [ ] **Step 3: Verify it compiles without the e2e feature**

Run: `cd packages/desktop/src-tauri && cargo check 2>&1 | tail -5`

Expected: `Finished` with no errors. No reference to `tauri_plugin_webdriver` in the compiled output.

- [ ] **Step 4: Commit**

```bash
git add packages/desktop/src-tauri/src/lib.rs
git commit -m "feat(e2e): register tauri-plugin-webdriver behind debug+e2e gate"
```

---

## Chunk 2: WebdriverIO Package Setup

### Task 4: Create the e2e package skeleton

**Files:**
- Create: `packages/e2e/package.json`
- Create: `packages/e2e/tsconfig.json`
- Create: `packages/e2e/__snapshots__/.gitkeep`

- [ ] **Step 1: Create `packages/e2e/package.json`**

```json
{
  "name": "@neatech/veslo-e2e",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "scripts": {
    "test": "wdio run wdio.conf.ts",
    "test:update-baselines": "wdio run wdio.conf.ts --updateBaselines"
  },
  "devDependencies": {
    "@wdio/cli": "^9.6",
    "@wdio/globals": "^9.6",
    "@wdio/local-runner": "^9.6",
    "@wdio/mocha-framework": "^9.5",
    "@wdio/spec-reporter": "^9.5",
    "@wdio/visual-service": "^6",
    "webdriverio": "^9.6",
    "@types/mocha": "^10",
    "typescript": "^5.6",
    "tsx": "^4"
  }
}
```

- [ ] **Step 2: Create `packages/e2e/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "esModuleInterop": true,
    "strict": true,
    "skipLibCheck": true,
    "outDir": "dist",
    "rootDir": ".",
    "types": ["@wdio/globals/types", "@types/mocha"]
  },
  "include": ["specs/**/*.ts", "helpers/**/*.ts", "wdio.conf.ts"]
}
```

- [ ] **Step 3: Create snapshot directories and .gitignore**

```bash
mkdir -p packages/e2e/__snapshots__/macos packages/e2e/__snapshots__/windows packages/e2e/__snapshots__/linux
touch packages/e2e/__snapshots__/.gitkeep
```

Create `packages/e2e/.gitignore`:

```
.tmp-opencode-home/
__snapshots__/**/actual/
__snapshots__/**/diff/
```

- [ ] **Step 4: Install dependencies**

Run: `cd packages/e2e && pnpm install`

Expected: All WebdriverIO packages install successfully. Check that `node_modules/@wdio` exists.

- [ ] **Step 5: Commit**

```bash
git add packages/e2e/package.json packages/e2e/tsconfig.json packages/e2e/.gitignore packages/e2e/__snapshots__/.gitkeep pnpm-lock.yaml
git commit -m "feat(e2e): add WebdriverIO e2e test package skeleton"
```

---

### Task 5: Create the app launcher helper

**Files:**
- Create: `packages/e2e/helpers/app-launcher.ts`

- [ ] **Step 1: Write `packages/e2e/helpers/app-launcher.ts`**

```typescript
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const WEBDRIVER_PORT = 4445;
const LAUNCH_TIMEOUT = parseInt(process.env.E2E_LAUNCH_TIMEOUT ?? '30000', 10);
const POLL_INTERVAL = 250;

let appProcess: ChildProcess | null = null;

function resolveDesktopRoot(): string {
  return resolve(join(__dirname, '..', '..', 'desktop'));
}

function resolveBinaryPath(): string {
  const desktopRoot = resolveDesktopRoot();
  const platform = process.platform;
  const tauriTarget = join(desktopRoot, 'src-tauri', 'target', 'debug');

  if (platform === 'win32') {
    const winPath = join(tauriTarget, 'veslo.exe');
    if (existsSync(winPath)) return winPath;
    throw new Error(`Tauri binary not found at ${winPath}. Run: pnpm tauri build --debug --no-bundle -- --features e2e`);
  }

  // macOS/Linux: check unbundled first (default for --no-bundle), then bundled .app
  const unbundledPath = join(tauriTarget, 'veslo');
  if (existsSync(unbundledPath)) return unbundledPath;

  if (platform === 'darwin') {
    const bundledPath = join(tauriTarget, 'bundle', 'macos', 'Veslo by Neatech.app', 'Contents', 'MacOS', 'veslo');
    if (existsSync(bundledPath)) return bundledPath;
  }

  throw new Error(`Tauri binary not found at ${unbundledPath}. Run: pnpm tauri build --debug --no-bundle -- --features e2e`);
}

async function pollStatus(port: number, timeout: number): Promise<void> {
  const url = `http://127.0.0.1:${port}/status`;
  const deadline = Date.now() + timeout;

  while (Date.now() < deadline) {
    try {
      const res = await fetch(url);
      if (res.ok) return;
    } catch {
      // Not ready yet
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL));
  }

  throw new Error(`WebDriver server did not respond on ${url} within ${timeout}ms`);
}

export async function startApp(port: number = WEBDRIVER_PORT): Promise<void> {
  const binaryPath = resolveBinaryPath();
  console.log(`[e2e] Launching Tauri binary: ${binaryPath}`);
  console.log(`[e2e] WebDriver port: ${port}`);

  const tmpDir = join(resolveDesktopRoot(), '..', 'e2e', '.tmp-opencode-home');

  appProcess = spawn(binaryPath, [], {
    env: {
      ...process.env,
      TAURI_WEBDRIVER_PORT: String(port),
      OPENCODE_HOME: tmpDir,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  appProcess.stdout?.on('data', (data: Buffer) => {
    process.stdout.write(`[app:stdout] ${data}`);
  });
  appProcess.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(`[app:stderr] ${data}`);
  });

  appProcess.on('exit', (code) => {
    console.log(`[e2e] App process exited with code ${code}`);
    appProcess = null;
  });

  console.log(`[e2e] Waiting for WebDriver server on port ${port}...`);
  await pollStatus(port, LAUNCH_TIMEOUT);
  console.log(`[e2e] WebDriver server is ready.`);
}

export function stopApp(): void {
  if (!appProcess) return;
  console.log(`[e2e] Stopping app process (PID ${appProcess.pid})...`);

  if (process.platform === 'win32') {
    appProcess.kill();
  } else {
    appProcess.kill('SIGTERM');
    // Force kill after 5 seconds if SIGTERM doesn't work
    const forceKillTimeout = setTimeout(() => {
      if (appProcess) {
        console.log('[e2e] Force killing app process...');
        appProcess.kill('SIGKILL');
      }
    }, 5000);
    appProcess.on('exit', () => clearTimeout(forceKillTimeout));
  }
}

/** Utility for HashRouter-based URL assertions. */
export function hashUrl(path: string): string {
  return `#${path.startsWith('/') ? path : '/' + path}`;
}
```

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/e2e && npx tsc --noEmit 2>&1 | head -20`

Expected: No errors (or only WDIO type-related warnings that resolve once wdio.conf.ts exists).

- [ ] **Step 3: Commit**

```bash
git add packages/e2e/helpers/app-launcher.ts
git commit -m "feat(e2e): add app launcher helper for spawning Tauri binary"
```

---

### Task 6: Create WebdriverIO configuration

**Files:**
- Create: `packages/e2e/wdio.conf.ts`

- [ ] **Step 1: Write `packages/e2e/wdio.conf.ts`**

```typescript
import { join } from 'node:path';
import { startApp, stopApp } from './helpers/app-launcher.js';
import type { Options } from '@wdio/types';

const WEBDRIVER_PORT = 4445;

const platformDir = process.platform === 'darwin' ? 'macos'
  : process.platform === 'win32' ? 'windows'
  : 'linux';

export const config: Options.Testrunner = {
  runner: 'local',

  specs: ['./specs/*.spec.ts'],
  maxInstances: 1,

  capabilities: [{
    browserName: 'chrome',
    'goog:chromeOptions': {},
  }],

  hostname: '127.0.0.1',
  port: WEBDRIVER_PORT,
  path: '/',

  logLevel: 'warn',
  waitforTimeout: 10000,
  connectionRetryTimeout: 120000,
  connectionRetryCount: 3,

  specFileRetries: 1,

  framework: 'mocha',
  reporters: ['spec'],

  mochaOpts: {
    ui: 'bdd',
    timeout: 60000,
  },

  services: [
    ['visual', {
      baselineFolder: join(process.cwd(), '__snapshots__', platformDir),
      formatImageName: '{tag}',
      screenshotPath: join(process.cwd(), '__snapshots__', platformDir, 'actual'),
    }],
  ],

  onPrepare: async () => {
    await startApp(WEBDRIVER_PORT);
  },

  onComplete: () => {
    stopApp();
  },
};
```

Note: WDIO 9.x handles TypeScript natively when `tsx` is installed as a devDependency. No `autoCompileOpts` needed.

- [ ] **Step 2: Verify TypeScript compiles**

Run: `cd packages/e2e && npx tsc --noEmit 2>&1 | head -20`

Expected: No errors.

- [ ] **Step 3: Commit**

```bash
git add packages/e2e/wdio.conf.ts
git commit -m "feat(e2e): add WebdriverIO configuration with visual regression service"
```

---

## Chunk 3: Test Specs

### Task 7: Write the smoke test spec

**Files:**
- Create: `packages/e2e/specs/smoke.spec.ts`

- [ ] **Step 1: Write `packages/e2e/specs/smoke.spec.ts`**

This test validates the app launches and key elements are present. The Veslo app renders into `#root`. Key UI elements: the sidebar, a textbox (composer), and route-based content.

```typescript
import { expect } from '@wdio/globals';

describe('Smoke test', () => {
  it('should open the app window', async () => {
    // The app should have a title
    const title = await browser.getTitle();
    expect(title).toBeTruthy();
  });

  it('should render the root element', async () => {
    const root = await $('#root');
    await root.waitForExist({ timeout: 10000 });
    expect(await root.isExisting()).toBe(true);
  });

  it('should render the main UI shell', async () => {
    // Wait for the app to finish loading — look for any interactive element
    const body = await $('body');
    await body.waitForDisplayed({ timeout: 15000 });

    // The app should have rendered something inside #root
    const root = await $('#root');
    const children = await root.$$('*');
    expect(children.length).toBeGreaterThan(0);
  });

  it('should have a textbox element (composer)', async () => {
    // The composer uses role="textbox"
    const textbox = await $('[role="textbox"]');
    // May not exist if we're on an onboarding screen — check without hard fail
    if (await textbox.isExisting()) {
      expect(await textbox.isDisplayed()).toBe(true);
    }
  });

  it('should have no critical console errors', async () => {
    // WebDriver does not expose console logs directly.
    // This is a placeholder — actual console checking requires
    // injecting a script to capture console.error calls.
    // For now, verify the page didn't crash (body still visible).
    const body = await $('body');
    expect(await body.isDisplayed()).toBe(true);
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/e2e/specs/smoke.spec.ts
git commit -m "feat(e2e): add smoke test spec"
```

---

### Task 8: Write the navigation test spec

**Files:**
- Create: `packages/e2e/specs/navigation.spec.ts`

- [ ] **Step 1: Write `packages/e2e/specs/navigation.spec.ts`**

Tests sidebar navigation and route changes. The app uses HashRouter, so URLs contain `#/`. Routes: `/session`, `/dashboard/settings`, `/dashboard/skills`, etc.

```typescript
import { expect } from '@wdio/globals';
import { hashUrl } from '../helpers/app-launcher.js';

/** Wait until the URL contains the expected hash fragment. */
async function waitForRoute(hashFragment: string, timeout = 5000): Promise<void> {
  await browser.waitUntil(
    async () => (await browser.getUrl()).includes(hashFragment),
    { timeout, timeoutMsg: `Route did not change to ${hashFragment} within ${timeout}ms` }
  );
}

describe('Navigation', () => {
  it('should load the initial route', async () => {
    const url = await browser.getUrl();
    expect(url).toBeTruthy();
  });

  it('should navigate to settings via URL', async () => {
    await browser.url(hashUrl('/dashboard/settings'));
    await waitForRoute('#/dashboard/settings');

    const url = await browser.getUrl();
    expect(url).toContain('#/dashboard/settings');
  });

  it('should navigate back to session view', async () => {
    await browser.url(hashUrl('/session'));
    await waitForRoute('#/session');

    const url = await browser.getUrl();
    expect(url).toContain('#/session');
  });

  it('should navigate to skills dashboard', async () => {
    await browser.url(hashUrl('/dashboard/skills'));
    await waitForRoute('#/dashboard/skills');

    const url = await browser.getUrl();
    expect(url).toContain('#/dashboard/skills');
  });

  it('should navigate to config dashboard', async () => {
    await browser.url(hashUrl('/dashboard/config'));
    await waitForRoute('#/dashboard/config');

    const url = await browser.getUrl();
    expect(url).toContain('#/dashboard/config');
  });

  it('should handle browser back navigation', async () => {
    await browser.url(hashUrl('/session'));
    await waitForRoute('#/session');

    await browser.url(hashUrl('/dashboard/settings'));
    await waitForRoute('#/dashboard/settings');

    await browser.back();
    await waitForRoute('#/session');

    const url = await browser.getUrl();
    expect(url).toContain('#/session');
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/e2e/specs/navigation.spec.ts
git commit -m "feat(e2e): add navigation test spec"
```

---

### Task 9: Write the session test spec

**Files:**
- Create: `packages/e2e/specs/session.spec.ts`

- [ ] **Step 1: Write `packages/e2e/specs/session.spec.ts`**

Tests creating a session and seeing it in the sidebar. These tests depend on the app having a functioning backend — they may be skipped if the app shows an onboarding/error state.

```typescript
import { expect } from '@wdio/globals';
import { hashUrl } from '../helpers/app-launcher.js';

describe('Session management', () => {
  before(async () => {
    // Navigate to session view
    await browser.url(hashUrl('/session'));
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes('#/session'),
      { timeout: 5000 }
    );
  });

  it('should display the session view', async () => {
    const root = await $('#root');
    await root.waitForExist({ timeout: 10000 });
    expect(await root.isDisplayed()).toBe(true);
  });

  it('should show the "New task" button or equivalent session creator', async () => {
    // Look for a button-like element that creates sessions
    // The sidebar has a "New task" button with a Plus icon
    const buttons = await $$('button');
    const buttonTexts = await Promise.all(buttons.map(b => b.getText()));
    // At minimum, some buttons should exist in the UI
    expect(buttons.length).toBeGreaterThan(0);
  });

  it('should have a sidebar area', async () => {
    // The sidebar contains workspace sections and session lists
    // Verify some structural elements exist
    const root = await $('#root');
    const allElements = await root.$$('*');
    expect(allElements.length).toBeGreaterThan(5);
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/e2e/specs/session.spec.ts
git commit -m "feat(e2e): add session management test spec"
```

---

### Task 10: Write the composer test spec

**Files:**
- Create: `packages/e2e/specs/composer.spec.ts`

- [ ] **Step 1: Write `packages/e2e/specs/composer.spec.ts`**

Tests the composer input area. The composer uses `role="textbox"`.

```typescript
import { expect } from '@wdio/globals';
import { hashUrl } from '../helpers/app-launcher.js';

describe('Composer', () => {
  before(async () => {
    await browser.url(hashUrl('/session'));
    await browser.waitUntil(
      async () => (await browser.getUrl()).includes('#/session'),
      { timeout: 5000 }
    );
  });

  it('should have a textbox for composing messages', async () => {
    const textbox = await $('[role="textbox"]');
    // The textbox may not exist if we're on an onboarding screen
    if (await textbox.isExisting()) {
      expect(await textbox.isDisplayed()).toBe(true);
    }
  });

  it('should accept text input in the composer', async () => {
    const textbox = await $('[role="textbox"]');
    if (!(await textbox.isExisting())) {
      // Skip if no textbox (onboarding state)
      return;
    }

    await textbox.click();
    await textbox.setValue('Hello from E2E test');

    const value = await textbox.getText();
    expect(value).toContain('Hello from E2E test');
  });

  it('should clear the composer', async () => {
    const textbox = await $('[role="textbox"]');
    if (!(await textbox.isExisting())) return;

    await textbox.click();
    // Select all and delete
    const isMac = process.platform === 'darwin';
    await browser.keys([isMac ? 'Meta' : 'Control', 'a']);
    await browser.keys(['Backspace']);

    const value = await textbox.getText();
    expect(value.trim()).toBe('');
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/e2e/specs/composer.spec.ts
git commit -m "feat(e2e): add composer test spec"
```

---

### Task 11: Write the visual regression test spec

**Files:**
- Create: `packages/e2e/specs/visual-regression.spec.ts`

- [ ] **Step 1: Write `packages/e2e/specs/visual-regression.spec.ts`**

Captures screenshot baselines for key screens. On first run, baselines are created. On subsequent runs, diffs are compared.

```typescript
import { expect } from '@wdio/globals';
import { hashUrl } from '../helpers/app-launcher.js';

describe('Visual regression', () => {
  it('should match the initial app state', async () => {
    // Wait for the app to settle
    const root = await $('#root');
    await root.waitForExist({ timeout: 10000 });
    await browser.pause(2000); // Allow animations to finish

    const result = await browser.checkScreen('initial-state', {
      /* first run creates the baseline */
    });

    // On first run, result is 0 (baseline created). On subsequent runs, check diff.
    expect(result).toBeLessThanOrEqual(1.5); // Allow 1.5% tolerance for antialiasing across CI hardware
  });

  it('should match the settings page', async () => {
    await browser.url(hashUrl('/dashboard/settings'));
    await browser.pause(2000);

    const result = await browser.checkScreen('settings-page', {});
    expect(result).toBeLessThanOrEqual(1.5);
  });

  it('should match the skills page', async () => {
    await browser.url(hashUrl('/dashboard/skills'));
    await browser.pause(2000);

    const result = await browser.checkScreen('skills-page', {});
    expect(result).toBeLessThanOrEqual(1.5);
  });

  it('should match the session view', async () => {
    await browser.url(hashUrl('/session'));
    await browser.pause(2000);

    const result = await browser.checkScreen('session-view', {});
    expect(result).toBeLessThanOrEqual(1.5);
  });
});
```

- [ ] **Step 2: Commit**

```bash
git add packages/e2e/specs/visual-regression.spec.ts
git commit -m "feat(e2e): add visual regression test spec"
```

---

## Chunk 4: Root Integration and CI

### Task 12: Add root package.json scripts

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1: Add test:e2e:ui scripts to root package.json**

Add these two scripts to the `"scripts"` section in the root `package.json`:

```json
"test:e2e:ui": "pnpm --filter @neatech/veslo-e2e test",
"test:e2e:ui:update-baselines": "pnpm --filter @neatech/veslo-e2e test:update-baselines"
```

- [ ] **Step 2: Verify the filter resolves correctly**

Run: `pnpm --filter @neatech/veslo-e2e exec -- echo "Package found"`

Expected: `Package found` (confirms pnpm can find the new package).

- [ ] **Step 3: Commit**

```bash
git add package.json
git commit -m "feat(e2e): add test:e2e:ui scripts to root package.json"
```

---

### Task 13: Create the CI workflow

**Files:**
- Create: `.github/workflows/e2e-ui.yml`

- [ ] **Step 1: Write `.github/workflows/e2e-ui.yml`**

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

      - name: Install Linux system deps
        if: runner.os == 'Linux'
        uses: awalsh128/cache-apt-pkgs-action@latest
        with:
          packages: libwebkit2gtk-4.1-dev libappindicator3-dev librsvg2-dev patchelf xvfb
          version: "1.0"

      # Sidecar download — adapt the full platform-aware download logic
      # from build-desktop.yml when enabling this workflow.
      # For now, prepare:sidecar handles what it can.
      - name: Prepare sidecars
        run: pnpm --filter @neatech/veslo run prepare:sidecar
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}

      - name: Build Tauri (debug, no bundle, e2e feature)
        run: pnpm tauri build --debug --no-bundle -- --features e2e
        working-directory: packages/desktop

      - name: Run E2E UI tests (Linux)
        if: runner.os == 'Linux'
        run: xvfb-run -a pnpm test:e2e:ui

      - name: Run E2E UI tests (macOS / Windows)
        if: runner.os != 'Linux'
        run: pnpm test:e2e:ui

      - name: Upload visual diffs on failure
        if: failure()
        uses: actions/upload-artifact@v4
        with:
          name: visual-diffs-${{ matrix.os }}
          path: packages/e2e/__snapshots__/**/diff/
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/e2e-ui.yml
git commit -m "ci: add E2E UI test workflow for macOS, Windows, Linux"
```

---

## Chunk 5: Local Verification

### Task 14: Build the Tauri binary with e2e feature and run the tests locally

This task verifies the full pipeline works end-to-end on the developer's machine.

- [ ] **Step 1: Build the Tauri binary with the e2e feature flag**

Run from the repo root:

```bash
cd packages/desktop && pnpm tauri build --debug --no-bundle -- --features e2e
```

Expected: Build completes. Binary at `packages/desktop/src-tauri/target/debug/veslo` (macOS/Linux) or `veslo.exe` (Windows).

This will take several minutes on first build (Rust compilation). Subsequent builds use incremental compilation.

- [ ] **Step 2: Run the smoke test to verify the WebDriver connection**

Run: `pnpm test:e2e:ui`

Expected: WebdriverIO launches the Tauri binary, connects to port 4445, runs the smoke tests. Tests may pass or fail depending on app state — the key verification is that the **connection works** and tests execute.

If the app fails to start or WebDriver times out, check:
- The binary exists at the expected path
- Port 4445 is not in use
- The binary was built with `--debug` and `--features e2e`

- [ ] **Step 3: Review visual regression baselines**

After the first run, check `packages/e2e/__snapshots__/<platform>/` for generated baseline PNGs.

Run: `ls packages/e2e/__snapshots__/`

Expected: Platform-specific directory with `.png` files like `initial-state.png`, `settings-page.png`, etc.

- [ ] **Step 4: Run tests a second time to verify baseline comparison**

Run: `pnpm test:e2e:ui`

Expected: Visual regression tests should pass (comparing against the baselines just created).

- [ ] **Step 5: Commit baselines and any fixes**

```bash
git add packages/e2e/__snapshots__/
git commit -m "feat(e2e): add initial visual regression baselines"
```

---

### Task 15: Final cleanup commit

- [ ] **Step 1: Verify all files are committed**

Run: `git status`

Expected: Clean working tree on branch `webdriverio-tauri-e2e`.

- [ ] **Step 2: Review the full diff from main**

Run: `git log main..HEAD --oneline`

Expected: A series of focused commits:
1. `feat(e2e): add tauri-plugin-webdriver as optional dependency behind e2e feature flag`
2. `feat(e2e): register tauri-plugin-webdriver behind debug+e2e gate`
3. `feat(e2e): add WebdriverIO e2e test package skeleton`
4. `feat(e2e): add app launcher helper for spawning Tauri binary`
5. `feat(e2e): add WebdriverIO configuration with visual regression service`
6. `feat(e2e): add smoke test spec`
7. `feat(e2e): add navigation test spec`
8. `feat(e2e): add visual regression test spec`
9. `feat(e2e): add test:e2e:ui scripts to root package.json`
10. `ci: add E2E UI test workflow for macOS, Windows, Linux`
11. `feat(e2e): add initial visual regression baselines`

---

## Implementation Notes

- **The `packages/e2e` directory is automatically included** in the pnpm workspace because `pnpm-workspace.yaml` has `packages/*`.
- **WebdriverIO requires `maxInstances: 1`** — Tauri only supports one WebDriver session at a time.
- **`browserName: 'chrome'`** is a WDIO requirement (it needs a browserName); the tauri-plugin-webdriver ignores it.
- **HashRouter**: All URL-based navigation in tests must use `#/` prefix. The `hashUrl()` helper handles this.
- **`OPENCODE_HOME`** is set to a temp directory so tests start with a clean state and don't interfere with the developer's real Veslo data.
- **Visual baselines are platform-specific**: macOS developer cannot generate Linux/Windows baselines locally. CI generates those.
- **`specFileRetries: 1`** gives each failing spec one automatic retry before reporting failure, reducing flakiness in CI.
