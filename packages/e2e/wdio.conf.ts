import { join } from 'node:path';
import { ensureWebDriverReady, resolveWebDriverPort, startApp, stopApp } from './helpers/app-launcher.js';

const WEBDRIVER_PORT = resolveWebDriverPort();

export function resolveMochaTimeout(env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env): number {
  const parsed = Number(env.E2E_MOCHA_TIMEOUT ?? '180000');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 180000;
}

const platformDir = process.platform === 'darwin' ? 'macos'
  : process.platform === 'win32' ? 'windows'
  : 'linux';

const defaultSpecs = [
  './specs/admin-managed-ai-access.spec.ts',
  './specs/attachment-staging.spec.ts',
  './specs/composer.spec.ts',
  './specs/den-managed-openai-anthropic.spec.ts',
  './specs/extensions-mcp.spec.ts',
  './specs/feedback-bug-report.spec.ts',
  './specs/feedback-youtrack-live.spec.ts',
  './specs/live-admin-codex-roundtrip.spec.ts',
  './specs/markdown-drop-guard.spec.ts',
  './specs/navigation.spec.ts',
  './specs/skills-global-inventory.e2e.ts',
  './specs/session-capabilities.spec.ts',
  './specs/session-prefetch.spec.ts',
  './specs/session.spec.ts',
  './specs/settings-gear-navigation.spec.ts',
  './specs/sidebar-primary-actions-overflow.spec.ts',
  './specs/sidebar-primary-actions-pointer-navigation.spec.ts',
  './specs/smoke.spec.ts',
  './specs/typography.spec.ts',
  './specs/veslo-server-startup.spec.ts',
  './specs/visual-regression.spec.ts',
  // This spec intentionally reloads the Tauri webview while rewriting auth and
  // language state, which can leave later WebDriver sessions unable to mutate
  // hash routes on WebKit. Keep it last in the shared desktop app process.
  './specs/language-persistence.spec.ts',
];

export const config = {
  runner: 'local',

  specs: defaultSpecs,
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

  specFileRetries: process.env.E2E_LIVE_FEEDBACK_YOUTRACK?.trim() === '1' ? 0 : 1,

  framework: 'mocha',
  reporters: ['spec'],

  mochaOpts: {
    ui: 'bdd',
    timeout: resolveMochaTimeout(),
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

  beforeTest: async () => {
    await ensureWebDriverReady(WEBDRIVER_PORT);
  },

  onComplete: async () => {
    await stopApp();
  },
};
