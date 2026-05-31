import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { join } from 'node:path';

type PackageFile = {
  path: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  text?: string;
  contentBase64: string;
};

type PackageArchive = {
  schemaVersion: 1;
  entrypoint: 'SKILL.md';
  files: PackageFile[];
  packageSha256: string;
  metadata: {
    name: string;
    description?: string;
  };
};

type FixtureSkill = {
  name: string;
  skillId: string;
  installationId: string;
  versionId: string;
  source: 'personal' | 'workspace' | 'organization';
  archive: PackageArchive;
};

export const E2E_SKILL_REGISTRY_ORG_ID = 'org_veslo_e2e_default';
export const E2E_SKILL_REGISTRY_USER_ID = 'user_veslo_e2e_default';
export const E2E_SKILL_REGISTRY_TOKEN = 'veslo-e2e-default-token';
export const E2E_SKILL_REGISTRY_WORKSPACE_ID = 'e2e-visual-workspace';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;

  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entryValue]) => `${JSON.stringify(key)}:${stableStringify(entryValue)}`)
    .join(',')}}`;
}

function archiveFile(path: string, text: string, mediaType = 'text/markdown'): PackageFile {
  const bytes = Buffer.from(text, 'utf8');
  return {
    path,
    sha256: sha256(text),
    sizeBytes: bytes.byteLength,
    mediaType,
    text,
    contentBase64: bytes.toString('base64'),
  };
}

function comparePackagePaths(left: PackageFile, right: PackageFile): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function buildArchive(name: string, description: string): PackageArchive {
  const files = [
    archiveFile(
      'SKILL.md',
      [
        '---',
        `name: ${name}`,
        `description: ${description}`,
        '---',
        '',
        `# ${name}`,
        '',
        description,
        '',
      ].join('\n'),
    ),
    archiveFile('scripts/run.txt', `${name}\n`, 'text/plain'),
  ].sort(comparePackagePaths);
  const metadata = { name, description };
  const manifestWithoutHash = {
    schemaVersion: 1,
    entrypoint: 'SKILL.md',
    files: files.map(({ contentBase64, ...file }) => file),
    metadata,
  };
  const packageSha256 = sha256(stableStringify(manifestWithoutHash));
  return {
    ...manifestWithoutHash,
    files,
    packageSha256,
  } as PackageArchive;
}

function fixtureSkill(input: Omit<FixtureSkill, 'archive'> & { description: string }): FixtureSkill {
  return {
    name: input.name,
    skillId: input.skillId,
    installationId: input.installationId,
    versionId: input.versionId,
    source: input.source,
    archive: buildArchive(input.name, input.description),
  };
}

const runtimeSkill = fixtureSkill({
  name: 'e2e-managed-runtime-skill',
  skillId: 'skill_e2e_managed_runtime_skill',
  installationId: 'install_e2e_managed_runtime_skill',
  versionId: 'version_e2e_runtime_1',
  source: 'workspace',
  description: 'Managed materialized runtime fixture skill from the registry.',
});

const runtimeSkillUpdated = fixtureSkill({
  name: 'e2e-managed-runtime-skill',
  skillId: 'skill_e2e_managed_runtime_skill',
  installationId: 'install_e2e_managed_runtime_skill',
  versionId: 'version_e2e_runtime_2',
  source: 'workspace',
  description: 'Updated approved managed runtime fixture skill from the registry.',
});

const orgShadowedSkill = fixtureSkill({
  name: 'e2e-org-shadowed-skill',
  skillId: 'skill_e2e_org_shadowed',
  installationId: 'install_e2e_org_shadowed',
  versionId: 'version_org_shadowed_1',
  source: 'organization',
  description: 'Organization-managed workspace skill from the registry fixture.',
});

const orgLockedSkill = fixtureSkill({
  name: 'e2e-org-locked-skill',
  skillId: 'skill_e2e_org_locked',
  installationId: 'install_e2e_org_locked',
  versionId: 'version_org_locked_1',
  source: 'organization',
  description: 'Organization-managed locked skill from the registry fixture.',
});

const personalShadowSkill = fixtureSkill({
  name: 'e2e-org-shadowed-skill',
  skillId: 'skill_e2e_personal_shadow',
  installationId: 'install_e2e_personal_shadow',
  versionId: 'version_personal_shadow_1',
  source: 'personal',
  description: 'Personal global copy that must not shadow the organization-managed skill.',
});

export const E2E_SKILL_REGISTRY_FIXTURE = {
  runtimeSkill,
  runtimeSkillUpdated,
  orgShadowedSkill,
  orgLockedSkill,
  personalShadowSkill,
  workspaceSkillSetId: 'skill_set_e2e_org_workspace',
  workspaceSkillSetRevision: 'rev_e2e_org_workspace_1',
  workspaceSkillSetUpdatedRevision: 'rev_e2e_org_workspace_2',
};

let registryServer: Server | null = null;
let registryBaseUrl: string | null = null;
let useUpdatedRuntimeVersion = false;
let deletedInstallationIds = new Set<string>();
let deletedInstallationCalls: string[] = [];

const fixtureInfoPath = () => join(process.cwd(), '.tmp-skill-registry-fixture.json');

function currentRuntimeSkill(): FixtureSkill {
  return useUpdatedRuntimeVersion ? runtimeSkillUpdated : runtimeSkill;
}

function currentSkillSetRevision(): string {
  return useUpdatedRuntimeVersion
    ? E2E_SKILL_REGISTRY_FIXTURE.workspaceSkillSetUpdatedRevision
    : E2E_SKILL_REGISTRY_FIXTURE.workspaceSkillSetRevision;
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'content-type': 'application/json',
  });
  res.end(`${JSON.stringify(payload)}\n`);
}

function installationFor(skill: FixtureSkill, workspaceId = E2E_SKILL_REGISTRY_WORKSPACE_ID) {
  return {
    installationId: skill.installationId,
    skillId: skill.skillId,
    versionId: skill.versionId,
    enabled: true,
    source: skill.source,
    installedAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
    name: skill.name,
    packageSha256: skill.archive.packageSha256,
    ownerUserId: skill.source === 'personal' ? E2E_SKILL_REGISTRY_USER_ID : null,
    orgId: skill.source === 'organization' || skill.source === 'workspace' ? E2E_SKILL_REGISTRY_ORG_ID : null,
    workspaceId: skill.source === 'workspace' ? workspaceId : null,
    approved: skill.source === 'personal' ? undefined : true,
  };
}

function handleRegistryRequest(req: IncomingMessage, res: ServerResponse): void {
  const base = registryBaseUrl ?? 'http://127.0.0.1';
  const url = new URL(req.url ?? '/', base);
  if (req.method === 'POST' && url.pathname === '/__e2e/reset') {
    useUpdatedRuntimeVersion = false;
    deletedInstallationIds = new Set();
    deletedInstallationCalls = [];
    json(res, 200, { ok: true, mode: 'initial' });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/__e2e/use-updated-runtime-version') {
    useUpdatedRuntimeVersion = true;
    json(res, 200, { ok: true, mode: 'updated' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/__e2e/events') {
    json(res, 200, { deletedInstallationCalls });
    return;
  }

  const runtime = currentRuntimeSkill();
  const packageByVersion = new Map(
    [
      runtimeSkill,
      runtimeSkillUpdated,
      orgShadowedSkill,
      orgLockedSkill,
      personalShadowSkill,
    ].map((skill) => [skill.versionId, skill]),
  );

  const workspaceSkillSetMatch = /^\/v1\/workspaces\/([^/]+)\/skill-set$/.exec(url.pathname);
  if (workspaceSkillSetMatch?.[1]) {
    const workspaceId = decodeURIComponent(workspaceSkillSetMatch[1]);
    json(res, 200, {
      workspaceId,
      skillSetId: E2E_SKILL_REGISTRY_FIXTURE.workspaceSkillSetId,
      revision: currentSkillSetRevision(),
      skills: [
        installationFor(runtime, workspaceId),
        installationFor(orgShadowedSkill, workspaceId),
        installationFor(orgLockedSkill, workspaceId),
        installationFor(personalShadowSkill, workspaceId),
      ].filter((installation) => !deletedInstallationIds.has(installation.installationId)),
    });
    return;
  }

  const installationMatch = /^\/v1\/skill-installations\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'DELETE' && installationMatch?.[1]) {
    const installationId = decodeURIComponent(installationMatch[1]);
    deletedInstallationIds.add(installationId);
    deletedInstallationCalls.push(installationId);
    const skill = [
      runtimeSkill,
      runtimeSkillUpdated,
      orgShadowedSkill,
      orgLockedSkill,
      personalShadowSkill,
    ].find((candidate) => candidate.installationId === installationId);
    if (!skill) {
      json(res, 404, { code: 'not_found', message: 'Installation not found' });
      return;
    }
    json(res, 200, {
      installation: {
        ...installationFor(skill),
        enabled: false,
      },
    });
    return;
  }

  const packageMatch = /^\/v1\/skill-versions\/([^/]+)\/package$/.exec(url.pathname);
  if (packageMatch?.[1]) {
    const versionId = decodeURIComponent(packageMatch[1]);
    const skill = packageByVersion.get(versionId);
    if (!skill) {
      json(res, 404, { code: 'not_found', message: 'Version not found' });
      return;
    }
    json(res, 200, {
      versionId: skill.versionId,
      skillId: skill.skillId,
      package: skill.archive,
    });
    return;
  }

  if (url.pathname === '/v1/skill-installations') {
    json(res, 200, { installations: [], nextCursor: null });
    return;
  }

  if (url.pathname === '/v1/skill-rollout-policies') {
    json(res, 200, { policies: [], nextCursor: null });
    return;
  }

  if (url.pathname === '/v1/skill-registry-events') {
    json(res, 200, { events: [], nextCursor: null });
    return;
  }

  if (url.pathname === '/v1/skills/search') {
    json(res, 200, { query: url.searchParams.get('q') ?? '', skills: [], nextCursor: null });
    return;
  }

  if (url.pathname === '/v1/skills') {
    json(res, 200, { skills: [], nextCursor: null });
    return;
  }

  json(res, 404, { code: 'not_found', message: `Unhandled registry fixture path: ${url.pathname}` });
}

export async function startSkillRegistryFixture(): Promise<string> {
  if (registryBaseUrl) return registryBaseUrl;

  useUpdatedRuntimeVersion = false;
  registryServer = createServer(handleRegistryRequest);
  await new Promise<void>((resolve, reject) => {
    registryServer?.once('error', reject);
    registryServer?.listen(0, '127.0.0.1', () => resolve());
  });
  const address = registryServer.address();
  if (!address || typeof address === 'string') {
    throw new Error('Skill registry fixture did not expose a TCP port.');
  }
  registryBaseUrl = `http://127.0.0.1:${address.port}`;
  writeFileSync(fixtureInfoPath(), `${JSON.stringify({ baseUrl: registryBaseUrl }, null, 2)}\n`);
  return registryBaseUrl;
}

export async function stopSkillRegistryFixture(): Promise<void> {
  const server = registryServer;
  registryServer = null;
  registryBaseUrl = null;
  useUpdatedRuntimeVersion = false;
  deletedInstallationIds = new Set();
  deletedInstallationCalls = [];
  rmSync(fixtureInfoPath(), { force: true });
  if (!server) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

export function readSkillRegistryFixtureBaseUrl(): string {
  const path = fixtureInfoPath();
  if (!existsSync(path)) {
    throw new Error(`Skill registry fixture info is missing at ${path}`);
  }
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as { baseUrl?: unknown };
  const baseUrl = typeof parsed.baseUrl === 'string' ? parsed.baseUrl.trim().replace(/\/+$/, '') : '';
  if (!baseUrl) {
    throw new Error(`Skill registry fixture info at ${path} does not include baseUrl`);
  }
  return baseUrl;
}

async function postFixtureControl(pathname: string): Promise<void> {
  const response = await fetch(`${readSkillRegistryFixtureBaseUrl()}${pathname}`, { method: 'POST' });
  if (!response.ok) {
    throw new Error(`Skill registry fixture control ${pathname} failed with ${response.status}`);
  }
}

export async function resetSkillRegistryFixtureState(): Promise<void> {
  await postFixtureControl('/__e2e/reset');
}

export async function useUpdatedRuntimeSkillVersion(): Promise<void> {
  await postFixtureControl('/__e2e/use-updated-runtime-version');
}

export async function readSkillRegistryFixtureEvents(): Promise<{ deletedInstallationCalls: string[] }> {
  const response = await fetch(`${readSkillRegistryFixtureBaseUrl()}/__e2e/events`);
  if (!response.ok) {
    throw new Error(`Skill registry fixture events failed with ${response.status}`);
  }
  return (await response.json()) as { deletedInstallationCalls: string[] };
}
