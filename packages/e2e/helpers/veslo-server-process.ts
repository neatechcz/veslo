import { createHash } from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

type WorkspaceSkillLockfile = {
  schemaVersion: 1;
  workspaceId: string;
  skillSetId: string;
  skillSetRevision: string;
  entries: Array<{
    name: string;
    packageSha256: string;
    installationId: string;
    versionId: string;
    skillId: string;
  }>;
};

export type StandaloneVesloServerProfile = {
  profileRoot: string;
  workspaceRoot: string;
  workspaceId: string;
  lockfilePath: string;
  baseUrl: string;
  clientToken: string;
  hostToken: string;
  process: ChildProcess;
  stop: () => Promise<void>;
};

type StartStandaloneVesloServerProfileInput = {
  profileRoot: string;
  registryBaseUrl: string;
  registryToken?: string;
  profileName: string;
};

type SyncStandaloneWorkspaceInput = {
  profile: StandaloneVesloServerProfile;
  denToken: string;
  orgId: string;
  userId: string;
};

function resolveServerPackageRoot(): string {
  return resolve(join(__dirname, '..', '..', 'server'));
}

function resolveBunBinary(): string {
  const explicit = process.env.BUN_BIN?.trim() || process.env.BUN?.trim();
  if (explicit) return explicit;

  const home = process.env.HOME?.trim() || process.env.USERPROFILE?.trim();
  const localBun = home ? join(home, '.bun', 'bin', process.platform === 'win32' ? 'bun.exe' : 'bun') : '';
  if (localBun && existsSync(localBun)) return localBun;

  return 'bun';
}

function workspaceIdForPath(path: string): string {
  const hash = createHash('sha256').update(resolve(path)).digest('hex');
  return `ws_${hash.slice(0, 12)}`;
}

async function getFreePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
  const address = server.address();
  await new Promise<void>((resolveClose, reject) => {
    server.close((error) => error ? reject(error) : resolveClose());
  });
  if (!address || typeof address === 'string') {
    throw new Error('Unable to reserve a TCP port for the standalone Veslo server.');
  }
  return address.port;
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function processHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function stopProcess(child: ChildProcess): Promise<void> {
  if (processHasExited(child)) return;

  await new Promise<void>((resolveStop) => {
    let settled = false;
    let forceTimer: NodeJS.Timeout | null = null;
    let timeoutTimer: NodeJS.Timeout | null = null;

    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (timeoutTimer) clearTimeout(timeoutTimer);
      resolveStop();
    };

    child.once('exit', finish);
    child.kill(process.platform === 'win32' ? undefined : 'SIGTERM');

    forceTimer = setTimeout(() => {
      if (!processHasExited(child)) child.kill(process.platform === 'win32' ? undefined : 'SIGKILL');
    }, 5_000);
    timeoutTimer = setTimeout(finish, 10_000);
  });
}

async function waitForServerReady(input: {
  child: ChildProcess;
  baseUrl: string;
  stdout: string[];
  stderr: string[];
  spawnErrors: Error[];
  timeoutMs?: number;
}): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (input.spawnErrors.length > 0) {
      throw input.spawnErrors[0];
    }
    if (processHasExited(input.child)) {
      throw new Error([
        `Standalone Veslo server exited before it became ready (code ${input.child.exitCode ?? 'unknown'}).`,
        input.stdout.join('').trim(),
        input.stderr.join('').trim(),
      ].filter(Boolean).join('\n'));
    }

    const response = await fetchWithTimeout(`${input.baseUrl}/health`, 300).catch(() => null);
    if (response?.ok) {
      const payload = (await response.json().catch(() => null)) as { ok?: boolean } | null;
      if (payload?.ok === true) return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 250));
  }

  throw new Error([
    `Standalone Veslo server did not become ready at ${input.baseUrl} within ${timeoutMs}ms.`,
    input.stdout.join('').trim(),
    input.stderr.join('').trim(),
  ].filter(Boolean).join('\n'));
}

export async function startStandaloneVesloServerProfile(
  input: StartStandaloneVesloServerProfileInput,
): Promise<StandaloneVesloServerProfile> {
  const profileRoot = resolve(input.profileRoot);
  const workspaceRoot = join(profileRoot, 'workspace');
  const workspaceId = workspaceIdForPath(workspaceRoot);
  const lockfilePath = join(workspaceRoot, '.opencode', 'veslo.skills.lock.json');
  const configPath = join(profileRoot, 'server.json');
  const port = await getFreePort();
  const clientToken = `client-${input.profileName}`;
  const hostToken = `host-${input.profileName}`;
  const registryToken = input.registryToken ?? 'veslo-e2e-registry-token';

  rmSync(profileRoot, { recursive: true, force: true });
  mkdirSync(workspaceRoot, { recursive: true });
  writeFileSync(
    configPath,
    `${JSON.stringify({
      host: '127.0.0.1',
      port,
      token: clientToken,
      hostToken,
      approval: { mode: 'auto', timeoutMs: 1_000 },
      workspaces: [{ path: workspaceRoot, name: `Shared ${input.profileName}` }],
      corsOrigins: ['*'],
      authorizedRoots: [workspaceRoot],
      readOnly: false,
      skillRegistryBaseUrl: input.registryBaseUrl,
      logFormat: 'pretty',
      logRequests: false,
    }, null, 2)}\n`,
  );

  const stdout: string[] = [];
  const stderr: string[] = [];
  const spawnErrors: Error[] = [];
  const serverRoot = resolveServerPackageRoot();
  const bunBin = resolveBunBinary();
  const env = {
    ...process.env,
    HOME: profileRoot,
    USERPROFILE: profileRoot,
    XDG_CONFIG_HOME: join(profileRoot, '.config'),
    XDG_DATA_HOME: join(profileRoot, '.local', 'share'),
    XDG_CACHE_HOME: join(profileRoot, '.cache'),
    VESLO_SERVER_CONFIG: configPath,
    VESLO_HOST: '127.0.0.1',
    VESLO_PORT: String(port),
    VESLO_TOKEN: clientToken,
    VESLO_HOST_TOKEN: hostToken,
    VESLO_WORKSPACES: '',
    VESLO_SKILL_REGISTRY_BASE_URL: input.registryBaseUrl,
    VESLO_SKILL_REGISTRY_TOKEN: registryToken,
    VESLO_LOG_REQUESTS: 'false',
  };

  const child = spawn(bunBin, ['src/cli.ts', '--config', configPath], {
    cwd: serverRoot,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (data: Buffer) => stdout.push(data.toString('utf8')));
  child.stderr?.on('data', (data: Buffer) => stderr.push(data.toString('utf8')));
  child.once('error', (error) => spawnErrors.push(error));

  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServerReady({ child, baseUrl, stdout, stderr, spawnErrors });
  } catch (error) {
    await stopProcess(child);
    throw error;
  }

  return {
    profileRoot,
    workspaceRoot,
    workspaceId,
    lockfilePath,
    baseUrl,
    clientToken,
    hostToken,
    process: child,
    stop: () => stopProcess(child),
  };
}

async function syncStandaloneWorkspaceSkillMaterialization(
  input: SyncStandaloneWorkspaceInput,
): Promise<unknown> {
  const response = await fetch(
    `${input.profile.baseUrl}/workspace/${input.profile.workspaceId}/skills/materialization/sync`,
    {
      method: 'POST',
      headers: {
        'x-veslo-host-token': input.profile.hostToken,
        'x-veslo-den-token': input.denToken,
        'x-veslo-den-org-id': input.orgId,
        'x-veslo-den-user-id': input.userId,
        accept: 'application/json',
        'content-type': 'application/json',
      },
    },
  );

  if (response.status !== 200) {
    const body = await response.text().catch(() => '');
    throw new Error(`Standalone workspace materialization sync failed with ${response.status}: ${body}`);
  }

  return response.json();
}

function readStandaloneWorkspaceLockfile(profile: StandaloneVesloServerProfile): WorkspaceSkillLockfile {
  if (!existsSync(profile.lockfilePath)) {
    throw new Error(`Standalone workspace lockfile is missing at ${profile.lockfilePath}`);
  }
  return JSON.parse(readFileSync(profile.lockfilePath, 'utf8')) as WorkspaceSkillLockfile;
}
