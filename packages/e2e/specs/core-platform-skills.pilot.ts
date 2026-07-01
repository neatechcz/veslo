import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from 'node:fs';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createAppLaunchEnv,
  seedDefaultWorkspaceState,
  terminateAppProcess,
} from '../helpers/app-launcher.js';
import { prepareDesktopAuthSeed } from '../helpers/desktop-auth-seed.js';
import {
  E2E_SKILL_REGISTRY_FIXTURE,
  E2E_SKILL_REGISTRY_ORG_ID,
  E2E_SKILL_REGISTRY_TOKEN,
  E2E_SKILL_REGISTRY_USER_ID,
  resetSkillRegistryFixtureState,
  startSkillRegistryFixture,
  stopSkillRegistryFixture,
} from '../helpers/skill-registry-fixture.js';

type VesloServerInfo = {
  running?: boolean;
  baseUrl?: string | null;
  clientToken?: string | null;
  hostToken?: string | null;
};

type VesloServerConnection = {
  baseUrl: string;
  clientToken: string;
  hostToken: string;
};

type GlobalMaterializationStatus = {
  scope: 'personal-global';
  status: string;
  registryConfigured: boolean;
  rootDir: string;
  synced?: boolean;
  materializedSkills: Array<{
    installationId: string;
    skillId: string;
    name: string;
    versionId: string;
    packageSha256: string;
    target: string;
    source?: string;
    removalPolicy?: string;
    skillDir?: string;
  }>;
};

type ManagedMarker = {
  schemaVersion?: number;
  installationId?: string;
  skillId?: string;
  name?: string;
  versionId?: string;
  packageSha256?: string;
  target?: string;
  source?: string;
  removalPolicy?: string;
  skillDir?: string;
};

type InventoryCard = {
  name: string;
  scope: string;
  workspaceId: string;
  lifecycle: string;
  section: 'all-workspaces' | 'workspace-specific' | 'unknown';
  text: string;
  deactivateButtonDisabled: boolean | null;
  deactivateButtonTitle: string;
};

type CoreSkillExpectation = {
  files: string[];
  skillTextIncludes: string;
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const e2eRoot = resolve(__dirname, '..');
const repoRoot = resolve(e2eRoot, '..', '..');
const desktopRoot = join(repoRoot, 'packages', 'desktop');
const isolatedProfileRoot = join(e2eRoot, '.tmp-veslo-home-pilot');
const tmpOpencodeHome = join(e2eRoot, '.tmp-opencode-home-pilot');
const xdgRuntimeDir = join('/tmp', `vp-${process.pid}`);
const pilotSocketPath = process.platform === 'win32'
  ? win32.join('\\\\.\\pipe', 'tauri-pilot-com.neatech.veslo.e2e')
  : join(xdgRuntimeDir, 'tauri-pilot-com.neatech.veslo.e2e.sock');

const launchTimeoutMs = Number(process.env.E2E_LAUNCH_TIMEOUT?.trim() || 120_000);
const pilotCommand = process.env.E2E_TAURI_PILOT_BIN?.trim() || 'tauri-pilot';

const expectedCoreSkills = E2E_SKILL_REGISTRY_FIXTURE.corePlatformSkills;
const internalRoutingPattern = /VESLO_INTERNAL_ROUTING|veslo-internal|veslo-delegate|delegate tool|hidden subagent|child session/i;
const corePlatformInventoryScopes = new Set(['platform', 'user-global']);
const expectedFilesBySkill = new Map<string, CoreSkillExpectation>([
  ['veslo-docx', {
    skillTextIncludes: '# DOCX creation, editing, and analysis',
    files: [
      'scripts/pack.py',
      'scripts/ooxml/scripts/validate.py',
      'scripts/ooxml/schemas/ISO-IEC29500-4_2016/wml.xsd',
    ],
  }],
  ['veslo-pdf', {
    skillTextIncludes: '# PDF Processing Guide',
    files: [
      'FORMS.md',
      'REFERENCE.md',
      'scripts/fill_fillable_fields.py',
    ],
  }],
  ['veslo-pptx', {
    skillTextIncludes: '# PPTX creation, editing, and analysis',
    files: [
      'html2pptx.md',
      'html2pptx.tgz',
      'scripts/thumbnail.py',
      'ooxml/scripts/validate.py',
    ],
  }],
  ['veslo-xlsx', {
    skillTextIncludes: '# Requirements for Outputs',
    files: [
      'recalc.py',
    ],
  }],
  ['skill-creator', {
    skillTextIncludes: '# Veslo Registry-Aware Skill Creation',
    files: [
      'references/veslo-registry-workflows.md',
      'scripts/init_skill.py',
      'scripts/package_skill.py',
      'scripts/quick_validate.py',
    ],
  }],
]);

function resolveBinaryPath(): string {
  const customBinaryPath = process.env.E2E_TAURI_BINARY?.trim();
  if (customBinaryPath) {
    if (existsSync(customBinaryPath)) return customBinaryPath;
    throw new Error(`Tauri binary not found at ${customBinaryPath}. Check E2E_TAURI_BINARY.`);
  }

  const tauriTarget = join(desktopRoot, 'src-tauri', 'target', 'debug');
  if (process.platform === 'win32') {
    const winPath = join(tauriTarget, 'veslo.exe');
    if (existsSync(winPath)) return winPath;
    throw new Error(`Tauri binary not found at ${winPath}. Run the e2e Tauri build first.`);
  }

  const unbundledPath = join(tauriTarget, 'veslo');
  if (existsSync(unbundledPath)) return unbundledPath;

  if (process.platform === 'darwin') {
    const bundledPath = join(tauriTarget, 'bundle', 'macos', 'Veslo E2E.app', 'Contents', 'MacOS', 'veslo');
    if (existsSync(bundledPath)) return bundledPath;
  }

  throw new Error(`Tauri binary not found at ${unbundledPath}. Run the e2e Tauri build first.`);
}

function normalizePath(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '');
}

function sha256File(path: string): string {
  return createHash('sha256')
    .update(new Uint8Array(readFileSync(path)))
    .digest('hex');
}

function workspaceRoot(): string {
  return join(isolatedProfileRoot, 'workspaces', 'visual-workspace');
}

function userManagedSkillsRoot(): string {
  return join(isolatedProfileRoot, '.config', 'opencode', 'skills', 'veslo-managed');
}

function skillRoot(name: string): string {
  return join(userManagedSkillsRoot(), name);
}

function fixtureDenAuthJson(registryBaseUrl: string): string {
  return JSON.stringify({
    denApiBase: registryBaseUrl,
    token: E2E_SKILL_REGISTRY_TOKEN,
    orgId: E2E_SKILL_REGISTRY_ORG_ID,
    user: {
      id: `${E2E_SKILL_REGISTRY_USER_ID}_fixture`,
      email: 'veslo-registry-e2e@example.test',
    },
    org: { id: E2E_SKILL_REGISTRY_ORG_ID, slug: 'veslo-e2e' },
  });
}

function createLaunchEnvironment(registryBaseUrl: string): NodeJS.ProcessEnv {
  rmSync(isolatedProfileRoot, { recursive: true, force: true });
  rmSync(tmpOpencodeHome, { recursive: true, force: true });
  mkdirSync(xdgRuntimeDir, { recursive: true });
  if (process.platform !== 'win32') {
    chmodSync(xdgRuntimeDir, 0o700);
    rmSync(pilotSocketPath, { force: true });
  }

  const seedEnv = {
    ...process.env,
    E2E_DEN_AUTH_JSON: fixtureDenAuthJson(registryBaseUrl),
  };
  const snapshotPath = prepareDesktopAuthSeed(tmpOpencodeHome, seedEnv);
  const env = createAppLaunchEnv(seedEnv, {
    vesloServerPort: Number(process.env.E2E_VESLO_SERVER_PORT?.trim() || 0) || undefined,
    opencodeHome: tmpOpencodeHome,
    snapshotPath,
  });

  env.HOME = isolatedProfileRoot;
  env.USERPROFILE = isolatedProfileRoot;
  env.XDG_DATA_HOME = join(isolatedProfileRoot, '.local', 'share');
  env.XDG_CONFIG_HOME = join(isolatedProfileRoot, '.config');
  env.XDG_CACHE_HOME = join(isolatedProfileRoot, '.cache');
  env.XDG_RUNTIME_DIR = xdgRuntimeDir;
  env.VESLO_SKILL_REGISTRY_BASE_URL = registryBaseUrl;
  env.VESLO_SKILL_REGISTRY_TOKEN = 'veslo-e2e-registry-token';
  env.RUST_BACKTRACE = env.RUST_BACKTRACE || '1';

  seedDefaultWorkspaceState(isolatedProfileRoot, env);
  return env;
}

function spawnDesktopApp(env: NodeJS.ProcessEnv): ChildProcess {
  const binaryPath = resolveBinaryPath();
  console.log(`[pilot-e2e] Launching Tauri binary: ${binaryPath}`);
  const child = spawn(binaryPath, [], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (data: Buffer) => process.stdout.write(`[app:stdout] ${data}`));
  child.stderr?.on('data', (data: Buffer) => process.stderr.write(`[app:stderr] ${data}`));
  child.on('exit', (code, signal) => {
    console.log(`[pilot-e2e] App process exited with code ${code}${signal ? ` signal ${signal}` : ''}`);
  });
  return child;
}

function childHasExited(child: ChildProcess): boolean {
  return child.exitCode !== null || child.signalCode !== null;
}

async function runProcess(
  command: string,
  args: string[],
  options: {
    env?: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
  } = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? 30_000;
  const child = spawn(command, args, {
    env: options.env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let stdout = '';
  let stderr = '';
  let settled = false;

  const result = await new Promise<{ stdout: string; stderr: string }>((resolveResult, rejectResult) => {
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGKILL');
      rejectResult(new Error(`${command} ${args.join(' ')} timed out after ${timeoutMs}ms\n${stderr}`));
    }, timeoutMs);

    child.stdout?.on('data', (data: Buffer) => {
      stdout += data.toString('utf8');
    });
    child.stderr?.on('data', (data: Buffer) => {
      stderr += data.toString('utf8');
    });
    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rejectResult(error);
    });
    child.on('exit', (code, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) {
        resolveResult({ stdout, stderr });
      } else {
        rejectResult(new Error(`${command} ${args.join(' ')} failed with ${signal ?? code}\n${stderr}\n${stdout}`));
      }
    });

    if (options.input !== undefined) {
      child.stdin?.end(options.input);
    } else {
      child.stdin?.end();
    }
  });

  return result;
}

async function pilotJson<T>(args: string[], input?: string, timeoutMs?: number): Promise<T> {
  const result = await runProcess(pilotCommand, ['--json', ...args], {
    input,
    timeoutMs,
    env: {
      ...process.env,
      TAURI_PILOT_SOCKET: pilotSocketPath,
      TAURI_PILOT_WINDOW: 'main',
    },
  });
  const raw = result.stdout.trim();
  if (!raw) return undefined as T;
  return JSON.parse(raw) as T;
}

async function pilotEval<T>(script: string, timeoutMs?: number): Promise<T> {
  return pilotJson<T>(['eval', '-'], script, timeoutMs);
}

async function pilotIpc<T>(command: string, args: Record<string, unknown> = {}, timeoutMs?: number): Promise<T> {
  const pilotArgs = Object.keys(args).length > 0
    ? ['ipc', command, '--args', JSON.stringify(args)]
    : ['ipc', command];
  return pilotJson<T>(pilotArgs, undefined, timeoutMs);
}

async function waitForPilotReady(appProcess: ChildProcess): Promise<void> {
  const deadline = Date.now() + launchTimeoutMs;
  let latestError: unknown = null;

  while (Date.now() < deadline) {
    if (childHasExited(appProcess)) {
      throw new Error('Spawned Tauri app exited before tauri-pilot became ready.');
    }
    try {
      await pilotJson(['ping'], undefined, 5_000);
      await pilotJson(['state'], undefined, 5_000);
      console.log('[pilot-e2e] tauri-pilot is ready.');
      return;
    } catch (error) {
      latestError = error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
    }
  }

  throw new Error(`tauri-pilot did not become ready on ${pilotSocketPath}: ${latestError}`);
}

async function waitForSelector(selector: string, timeoutMs = 45_000): Promise<void> {
  await pilotJson(['wait', '--selector', selector, '--timeout', String(timeoutMs)], undefined, timeoutMs + 5_000);
}

async function waitForLocalVesloServerReady(): Promise<VesloServerConnection> {
  const deadline = Date.now() + 45_000;
  let latest: VesloServerInfo | null = null;

  while (Date.now() < deadline) {
    try {
      latest = await pilotIpc<VesloServerInfo>('veslo_server_info', {}, 5_000);
      const baseUrl = latest.baseUrl?.trim().replace(/\/+$/, '') ?? '';
      const clientToken = latest.clientToken?.trim() ?? '';
      const hostToken = latest.hostToken?.trim() ?? '';
      if (latest.running && baseUrl && clientToken && hostToken) {
        const health = await fetch(`${baseUrl}/health`).catch(() => null);
        const capabilities = await fetch(`${baseUrl}/capabilities`, {
          headers: {
            Authorization: `Bearer ${clientToken}`,
            'X-Veslo-Host-Token': hostToken,
          },
        }).catch(() => null);
        if (health?.ok === true && capabilities?.ok === true) {
          return { baseUrl, clientToken, hostToken };
        }
      }
    } catch {
      // Not ready yet.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }

  throw new Error(`Local Veslo server did not become ready. Latest info: ${JSON.stringify(latest)}`);
}

async function prepareSkillsPage(registryBaseUrl: string): Promise<void> {
  const authJson = fixtureDenAuthJson(registryBaseUrl);
  await pilotEval<string>(`
    (() => {
      window.localStorage.setItem("veslo.language", "en");
      window.localStorage.setItem("veslo.onboardingComplete", "1");
      window.localStorage.setItem("veslo.startupPref", "local");
      window.localStorage.setItem("veslo.den.keepSignedIn", "1");
      window.localStorage.setItem("veslo.den.auth", ${JSON.stringify(authJson)});
      window.sessionStorage.removeItem("veslo.den.auth");
      const oldUrl = window.location.href;
      window.location.hash = "/dashboard/skills";
      window.dispatchEvent(new HashChangeEvent("hashchange", {
        oldURL: oldUrl,
        newURL: window.location.href,
      }));
      return window.location.hash;
    })()
  `);
  await waitForSelector('[data-testid="skills-page"]');
}

async function syncGlobalMaterialization(
  connection: VesloServerConnection,
  registryBaseUrl: string,
): Promise<GlobalMaterializationStatus> {
  const response = await fetch(`${connection.baseUrl}/skills/materialization/sync-global`, {
    method: 'POST',
    headers: {
      'X-Veslo-Host-Token': connection.hostToken,
      'x-veslo-den-api-base': registryBaseUrl,
      'x-veslo-den-token': E2E_SKILL_REGISTRY_TOKEN,
      'x-veslo-den-org-id': E2E_SKILL_REGISTRY_ORG_ID,
      'x-veslo-den-user-id': E2E_SKILL_REGISTRY_USER_ID,
      accept: 'application/json',
    },
  });
  if (response.status !== 200) {
    throw new Error(`sync-global failed with ${response.status}: ${await response.text()}`);
  }
  const payload = (await response.json()) as GlobalMaterializationStatus;
  assert.equal(payload.scope, 'personal-global');
  assert.equal(payload.synced, true);
  return payload;
}

async function fetchGlobalMaterializationStatus(
  connection: VesloServerConnection,
): Promise<GlobalMaterializationStatus> {
  const response = await fetch(`${connection.baseUrl}/skills/materialization`, {
    headers: {
      authorization: `Bearer ${connection.clientToken}`,
      accept: 'application/json',
    },
  });
  if (response.status !== 200) {
    throw new Error(`GET /skills/materialization failed with ${response.status}: ${await response.text()}`);
  }
  return (await response.json()) as GlobalMaterializationStatus;
}

function findMaterializedSkill(status: GlobalMaterializationStatus, name: string) {
  const skill = status.materializedSkills.find((candidate) => candidate.name === name);
  assert.ok(skill, `Expected ${name} in materialized skills: ${JSON.stringify(status.materializedSkills)}`);
  return skill;
}

function verifyMaterializationStatus(
  status: GlobalMaterializationStatus,
  options: { expectDetails?: boolean } = {},
): void {
  assert.equal(normalizePath(status.rootDir), normalizePath(userManagedSkillsRoot()));
  for (const skill of expectedCoreSkills) {
    const materialized = findMaterializedSkill(status, skill.name);
    assert.equal(materialized.installationId, skill.installationId);
    assert.equal(materialized.skillId, skill.skillId);
    assert.equal(materialized.name, skill.name);
    assert.equal(materialized.versionId, skill.versionId);
    assert.equal(materialized.packageSha256, skill.archive.packageSha256);
    assert.equal(materialized.target, 'personal-global');
    if (options.expectDetails) {
      assert.equal(materialized.source, 'platform');
      assert.equal(materialized.removalPolicy, 'locked');
      assert.equal(normalizePath(materialized.skillDir ?? ''), normalizePath(skillRoot(skill.name)));
    }
  }
}

function verifyMaterializedFiles(): void {
  for (const skill of expectedCoreSkills) {
    const root = skillRoot(skill.name);
    assert.equal(existsSync(root), true, `Expected skill directory for ${skill.name}`);

    const skillText = readFileSync(join(root, 'SKILL.md'), 'utf8');
    const expectation = expectedFilesBySkill.get(skill.name);
    assert.ok(expectation, `Missing expected file fixture for ${skill.name}`);
    assert.match(skillText, new RegExp(expectation.skillTextIncludes.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));

    for (const file of skill.archive.files) {
      const path = join(root, file.path);
      assert.equal(existsSync(path), true, `Expected ${skill.name} file ${file.path}`);
      const fileStat = statSync(path);
      assert.equal(fileStat.isFile(), true, `Expected ${skill.name} file ${file.path} to be a file`);
      assert.equal(fileStat.size, file.sizeBytes, `Expected ${skill.name} file ${file.path} size to match archive metadata`);
      assert.equal(sha256File(path), file.sha256, `Expected ${skill.name} file ${file.path} sha256 to match archive metadata`);
    }

    for (const file of expectation.files) {
      assert.equal(
        skill.archive.files.some((archiveFile) => archiveFile.path === file),
        true,
        `Expected ${skill.name} archive to include important support file ${file}`,
      );
    }

    const marker = JSON.parse(readFileSync(join(root, '.veslo-managed.json'), 'utf8')) as ManagedMarker;
    assert.deepEqual(
      {
        schemaVersion: marker.schemaVersion,
        installationId: marker.installationId,
        skillId: marker.skillId,
        name: marker.name,
        versionId: marker.versionId,
        packageSha256: marker.packageSha256,
        target: marker.target,
        source: marker.source,
        removalPolicy: marker.removalPolicy,
        skillDir: normalizePath(marker.skillDir ?? ''),
      },
      {
        schemaVersion: 1,
        installationId: skill.installationId,
        skillId: skill.skillId,
        name: skill.name,
        versionId: skill.versionId,
        packageSha256: skill.archive.packageSha256,
        target: 'personal-global',
        source: 'platform',
        removalPolicy: 'locked',
        skillDir: normalizePath(root),
      },
    );
  }
}

function internalAgentFileNames(): string[] {
  const agentsRoot = join(workspaceRoot(), '.opencode', 'agents');
  if (!existsSync(agentsRoot)) return [];
  return readdirSync(agentsRoot).filter((name) => /^veslo-internal-.*\.md$/.test(name));
}

function verifyNoInternalDelegationArtifacts(): void {
  assert.equal(existsSync(join(workspaceRoot(), '.opencode', 'veslo', 'internal')), false);
  assert.equal(existsSync(join(workspaceRoot(), '.opencode', 'plugins', 'veslo-delegate.js')), false);
  assert.deepEqual(internalAgentFileNames(), []);
  const vesloAgentPath = join(workspaceRoot(), '.opencode', 'agents', 'veslo.md');
  if (existsSync(vesloAgentPath)) {
    assert.doesNotMatch(readFileSync(vesloAgentPath, 'utf8'), internalRoutingPattern);
  }
}

async function refreshSkillsInventoryFromUi(): Promise<void> {
  const clicked = await pilotEval<boolean>(`
    (() => {
      const button = document.querySelector('[data-testid="skills-refresh-button"]');
      if (!(button instanceof HTMLButtonElement)) return false;
      button.click();
      return true;
    })()
  `);
  assert.equal(clicked, true, 'Expected skills refresh button to be clickable.');
}

async function readInventoryCards(): Promise<InventoryCard[]> {
  return pilotEval<InventoryCard[]>(`
    (() => {
      const allSection = document.querySelector('[data-testid="skills-all-workspaces-section"]');
      const workspaceSection = document.querySelector('[data-testid="skills-workspace-specific-section"]');
      return Array.from(document.querySelectorAll('[data-testid="skill-inventory-card"]')).map((card) => {
        const element = card;
        const section = allSection?.contains(element)
          ? "all-workspaces"
          : workspaceSection?.contains(element)
            ? "workspace-specific"
            : "unknown";
        const deactivateButton = element.querySelector('[data-testid="skill-inventory-deactivate-button"]');
        return {
          name: element.dataset.skillInventoryName ?? "",
          scope: element.dataset.skillInventoryScope ?? "",
          workspaceId: element.dataset.skillInventoryWorkspaceId ?? "",
          lifecycle: element.dataset.skillInventoryLifecycle ?? "",
          section,
          text: element.innerText,
          deactivateButtonDisabled: deactivateButton instanceof HTMLButtonElement ? deactivateButton.disabled : null,
          deactivateButtonTitle: deactivateButton?.getAttribute("title") ?? "",
        };
      });
    })()
  `);
}

async function readInventoryDiagnostics(connection: VesloServerConnection): Promise<unknown> {
  return pilotEval<unknown>(`
    (async () => {
      const localStorageEntries = {};
      for (const key of [
        "veslo.startupPref",
        "veslo.server.urlOverride",
        "veslo.server.token",
        "veslo.server.active",
        "veslo.server.list",
      ]) {
        localStorageEntries[key] = window.localStorage.getItem(key);
      }
      let materializationStatus = null;
      try {
        const response = await fetch(${JSON.stringify(`${connection.baseUrl}/skills/materialization`)}, {
          headers: {
            authorization: ${JSON.stringify(`Bearer ${connection.clientToken}`)},
            accept: "application/json",
          },
        });
        materializationStatus = {
          ok: response.ok,
          status: response.status,
          text: await response.text(),
        };
      } catch (error) {
        materializationStatus = {
          error: error instanceof Error ? error.message : String(error),
        };
      }
      return {
        location: window.location.href,
        visibilityState: document.visibilityState,
        localStorageEntries,
        materializationStatus,
      };
    })()
  `, 10_000);
}

async function waitForCoreSkillInventoryCards(connection: VesloServerConnection): Promise<InventoryCard[]> {
  const deadline = Date.now() + 30_000;
  let latestCards: InventoryCard[] = [];
  while (Date.now() < deadline) {
      latestCards = await readInventoryCards();
      const allPresent = expectedCoreSkills.every((skill) => latestCards.some((card) =>
        card.name === skill.name &&
        corePlatformInventoryScopes.has(card.scope) &&
        card.lifecycle === 'active' &&
        card.section === 'all-workspaces' &&
        card.deactivateButtonDisabled === true,
      ));
    if (allPresent) {
      return latestCards;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
  }
  const diagnostics = await readInventoryDiagnostics(connection).catch((error) => ({
    error: error instanceof Error ? error.message : String(error),
  }));
  throw new Error(`Core platform skill inventory cards did not appear. Latest: ${JSON.stringify(latestCards, null, 2)}\nDiagnostics: ${JSON.stringify(diagnostics, null, 2)}`);
}

function verifyInventoryCards(cards: InventoryCard[]): void {
  for (const skill of expectedCoreSkills) {
    const card = cards.find((candidate) => candidate.name === skill.name && corePlatformInventoryScopes.has(candidate.scope));
    assert.ok(card, `Expected UI inventory card for ${skill.name}`);
    assert.equal(card.workspaceId, '');
    assert.ok(corePlatformInventoryScopes.has(card.scope), `Expected platform-compatible UI scope for ${skill.name}`);
    assert.equal(card.lifecycle, 'active');
    assert.equal(card.section, 'all-workspaces');
    assert.equal(card.deactivateButtonDisabled, true, `Expected locked remove action for ${skill.name}`);
    assert.match(card.deactivateButtonTitle, /locked|policy|cannot be removed/i);
    assert.ok(card.text.includes(skill.name), `Expected UI card for ${skill.name} to show the skill name.`);
  }
}

async function run(): Promise<void> {
  process.chdir(e2eRoot);
  const registryBaseUrl = await startSkillRegistryFixture();
  let appProcess: ChildProcess | null = null;

  try {
    await resetSkillRegistryFixtureState();
    const env = createLaunchEnvironment(registryBaseUrl);
    appProcess = spawnDesktopApp(env);

    await waitForPilotReady(appProcess);
    await prepareSkillsPage(registryBaseUrl);
    const connection = await waitForLocalVesloServerReady();

    const syncStatus = await syncGlobalMaterialization(connection, registryBaseUrl);
    verifyMaterializationStatus(syncStatus);
    verifyMaterializedFiles();
    verifyNoInternalDelegationArtifacts();

    const status = await fetchGlobalMaterializationStatus(connection);
    verifyMaterializationStatus(status, { expectDetails: true });

    await refreshSkillsInventoryFromUi();
    const cards = await waitForCoreSkillInventoryCards(connection);
    verifyInventoryCards(cards);

    console.log('[pilot-e2e] Core platform skill tauri-pilot E2E passed.');
  } finally {
    if (appProcess && !childHasExited(appProcess)) {
      console.log(`[pilot-e2e] Stopping app process (PID ${appProcess.pid})...`);
      await terminateAppProcess(appProcess);
    }
    rmSync(xdgRuntimeDir, { recursive: true, force: true });
    await stopSkillRegistryFixture();
  }
}

run().catch(async (error) => {
  await stopSkillRegistryFixture().catch(() => {});
  console.error(error instanceof Error ? error.stack ?? error.message : error);
  process.exit(1);
});
