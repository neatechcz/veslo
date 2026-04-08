import { join } from 'node:path';
import { ensureWebDriverReady, startApp, stopApp } from './helpers/app-launcher.js';

const WEBDRIVER_PORT = 4445;

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

  beforeTest: async () => {
    await ensureWebDriverReady(WEBDRIVER_PORT);
  },

  onComplete: () => {
    stopApp();
  },
};
