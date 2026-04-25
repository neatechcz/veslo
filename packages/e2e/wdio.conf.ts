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

export const config = {
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

  onComplete: () => {
    stopApp();
  },
};
