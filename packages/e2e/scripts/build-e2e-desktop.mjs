import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const repoRoot = resolve(__dirname, '../../..');
const desktopRoot = resolve(repoRoot, 'packages/desktop');

export const E2E_DESKTOP_BUILD_STEPS = [
  {
    cwd: repoRoot,
    args: ['--filter', 'veslo-server', 'build:bin'],
    display: 'pnpm --filter veslo-server build:bin',
  },
  {
    cwd: repoRoot,
    args: ['--filter', '@neatech/veslo', 'run', 'prepare:sidecar'],
    env: { VESLO_SIDECAR_FORCE_BUILD: '1' },
    display: 'VESLO_SIDECAR_FORCE_BUILD=1 pnpm --filter @neatech/veslo run prepare:sidecar',
  },
  {
    cwd: desktopRoot,
    args: [
      'tauri',
      'build',
      '--debug',
      '--no-bundle',
      '--config',
      'src-tauri/tauri.e2e.conf.json',
      '--',
      '--features',
      'e2e',
    ],
    display: 'pnpm tauri build --debug --no-bundle --config src-tauri/tauri.e2e.conf.json -- --features e2e',
  },
];

export function resolvePnpmInvocation(platform = process.platform, comSpec = process.env.ComSpec) {
  if (platform === 'win32') {
    return {
      command: comSpec || 'cmd.exe',
      viaCmd: true,
    };
  }
  return {
    command: 'pnpm',
    viaCmd: false,
  };
}

export function runE2EDesktopBuild(args = process.argv.slice(2)) {
  const dryRun = args.includes('--dry-run');
  const unsupportedArgs = args.filter((arg) => arg !== '--dry-run');
  if (unsupportedArgs.length > 0) {
    throw new Error(`Unknown argument(s): ${unsupportedArgs.join(' ')}`);
  }

  const pnpm = resolvePnpmInvocation();
  for (const step of E2E_DESKTOP_BUILD_STEPS) {
    console.log(`[e2e] ${step.display}`);
    if (dryRun) continue;

    const args = pnpm.viaCmd
      ? ['/d', '/s', '/c', `pnpm ${step.args.join(' ')}`]
      : step.args;
    const result = spawnSync(pnpm.command, args, {
      cwd: step.cwd,
      env: { ...process.env, ...step.env },
      stdio: 'inherit',
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(`E2E desktop build step failed with exit code ${result.status ?? 'unknown'}: ${step.display}`);
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === __filename) {
  runE2EDesktopBuild();
}
