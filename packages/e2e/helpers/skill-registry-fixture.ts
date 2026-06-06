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

type SoulScope = 'organization' | 'user';

type SoulVersion = {
  id: string;
  content: string;
  changeSummary: string;
  createdAt: string;
  createdBy: string;
  source: 'manual' | 'api' | 'heartbeat' | 'restore' | 'system';
  baseVersionId: string | null;
  restoreSourceVersionId: string | null;
};

type SoulDocument = {
  id: string;
  scope: SoulScope;
  ownerId: string;
  currentVersionId: string | null;
  heartbeatEnabled: boolean;
  versions: SoulVersion[];
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

const personalGlobalSkill = fixtureSkill({
  name: 'e2e-user-managed-skill',
  skillId: 'skill_e2e_user_managed',
  installationId: 'install_e2e_user_managed',
  versionId: 'version_user_managed_1',
  source: 'personal',
  description: 'Personal managed skill from the registry fixture.',
});

const orgRolloutTool = fixtureSkill({
  name: 'org-rollout-tool',
  skillId: 'skill_e2e_org_rollout_tool',
  installationId: 'rollout:policy_e2e_org_rollout_tool',
  versionId: 'version_org_rollout_tool_1',
  source: 'organization',
  description: 'Organization rollout tool materialized into user skills.',
});

export const E2E_SKILL_REGISTRY_FIXTURE = {
  runtimeSkill,
  runtimeSkillUpdated,
  orgShadowedSkill,
  orgLockedSkill,
  personalShadowSkill,
  personalGlobalSkill,
  orgRolloutTool,
  orgRolloutToolPolicyId: 'policy_e2e_org_rollout_tool',
  workspaceSkillSetId: 'skill_set_e2e_org_workspace',
  workspaceSkillSetRevision: 'rev_e2e_org_workspace_1',
  workspaceSkillSetUpdatedRevision: 'rev_e2e_org_workspace_2',
};

let registryServer: Server | null = null;
let registryBaseUrl: string | null = null;
let useUpdatedRuntimeVersion = false;
let deletedInstallationIds = new Set<string>();
let deletedInstallationCalls: string[] = [];
let disabledRolloutPolicyIds = new Set<string>();
let updatedRolloutPolicyCalls: Array<{ policyId: string; enabled: boolean | null }> = [];
let soulVersionSeq = 1;
let soulDocuments = createDefaultSoulDocuments();

const fixtureInfoPath = () => join(process.cwd(), '.tmp-skill-registry-fixture.json');

function currentRuntimeSkill(): FixtureSkill {
  return useUpdatedRuntimeVersion ? runtimeSkillUpdated : runtimeSkill;
}

function currentSkillSetRevision(): string {
  return useUpdatedRuntimeVersion
    ? E2E_SKILL_REGISTRY_FIXTURE.workspaceSkillSetUpdatedRevision
    : E2E_SKILL_REGISTRY_FIXTURE.workspaceSkillSetRevision;
}

function soulVersion(input: {
  id: string;
  content: string;
  changeSummary: string;
  createdBy: string;
  createdAt?: string;
  source?: SoulVersion['source'];
  baseVersionId?: string | null;
  restoreSourceVersionId?: string | null;
}): SoulVersion {
  return {
    id: input.id,
    content: input.content,
    changeSummary: input.changeSummary,
    createdAt: input.createdAt ?? '2026-06-06T10:00:00.000Z',
    createdBy: input.createdBy,
    source: input.source ?? 'api',
    baseVersionId: input.baseVersionId ?? null,
    restoreSourceVersionId: input.restoreSourceVersionId ?? null,
  };
}

function soulDocument(scope: SoulScope, ownerId: string, version: SoulVersion): SoulDocument {
  return {
    id: `${scope}_${ownerId}`,
    scope,
    ownerId,
    currentVersionId: version.id,
    heartbeatEnabled: false,
    versions: [version],
  };
}

function createDefaultSoulDocuments(): Record<SoulScope, SoulDocument> {
  soulVersionSeq = 1;
  return {
    organization: soulDocument('organization', E2E_SKILL_REGISTRY_ORG_ID, soulVersion({
      id: 'org_soul_v1',
      content: '# Organization Soul\n\n- Existing organization memory',
      changeSummary: 'Initial organization Soul',
      createdBy: E2E_SKILL_REGISTRY_USER_ID,
    })),
    user: soulDocument('user', E2E_SKILL_REGISTRY_USER_ID, soulVersion({
      id: 'user_soul_v1',
      content: '# User Soul\n\n- Existing user memory',
      changeSummary: 'Initial user Soul',
      createdBy: E2E_SKILL_REGISTRY_USER_ID,
    })),
  };
}

function requestHeader(req: IncomingMessage, name: string): string {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0]?.trim() ?? '' : value?.trim() ?? '';
}

function soulOwnerId(scope: SoulScope, req: IncomingMessage): string {
  if (scope === 'organization') {
    return requestHeader(req, 'x-veslo-den-org-id') || requestHeader(req, 'x-veslo-org-id') || E2E_SKILL_REGISTRY_ORG_ID;
  }
  return requestHeader(req, 'x-veslo-den-user-id') || requestHeader(req, 'x-veslo-user-id') || E2E_SKILL_REGISTRY_USER_ID;
}

function ensureSoulDocumentOwner(scope: SoulScope, req: IncomingMessage): SoulDocument {
  const ownerId = soulOwnerId(scope, req);
  const current = soulDocuments[scope];
  if (current.ownerId === ownerId) return current;
  const version = soulVersion({
    id: `${scope}_soul_v1`,
    content: scope === 'organization' ? '# Organization Soul' : '# User Soul',
    changeSummary: `Initial ${scope} Soul`,
    createdBy: requestHeader(req, 'x-veslo-den-user-id') || E2E_SKILL_REGISTRY_USER_ID,
  });
  const next = soulDocument(scope, ownerId, version);
  soulDocuments = { ...soulDocuments, [scope]: next };
  return next;
}

function updateSoulDocument(scope: SoulScope, req: IncomingMessage, body: Record<string, unknown>): SoulDocument {
  const current = ensureSoulDocumentOwner(scope, req);
  const content = typeof body.content === 'string' ? body.content : '';
  const changeSummary = typeof body.changeSummary === 'string' ? body.changeSummary : '';
  const baseVersionId = body.baseVersionId === null || typeof body.baseVersionId === 'string' ? body.baseVersionId : null;
  if (!content.trim() || !changeSummary.trim()) {
    throw new Error('invalid_soul_update');
  }
  if (baseVersionId && current.currentVersionId && baseVersionId !== current.currentVersionId) {
    throw new Error('soul_conflict');
  }

  const version = soulVersion({
    id: `${scope}_soul_v${++soulVersionSeq}`,
    content,
    changeSummary,
    createdAt: new Date().toISOString(),
    createdBy: requestHeader(req, 'x-veslo-den-user-id') || E2E_SKILL_REGISTRY_USER_ID,
    baseVersionId,
  });
  const updated = {
    ...current,
    currentVersionId: version.id,
    versions: [...current.versions, version],
  };
  soulDocuments = { ...soulDocuments, [scope]: updated };
  return updated;
}

function restoreSoulDocument(scope: SoulScope, req: IncomingMessage, versionId: string, body: Record<string, unknown>): SoulDocument {
  const current = ensureSoulDocumentOwner(scope, req);
  const source = current.versions.find((version) => version.id === versionId);
  if (!source) {
    throw new Error('soul_not_found');
  }
  const version = soulVersion({
    id: `${scope}_soul_restore_${++soulVersionSeq}`,
    content: source.content,
    changeSummary: typeof body.changeSummary === 'string' && body.changeSummary.trim()
      ? body.changeSummary
      : `Restore ${scope} Soul`,
    createdAt: new Date().toISOString(),
    createdBy: requestHeader(req, 'x-veslo-den-user-id') || E2E_SKILL_REGISTRY_USER_ID,
    source: 'restore',
    baseVersionId: current.currentVersionId,
    restoreSourceVersionId: source.id,
  });
  const restored = {
    ...current,
    currentVersionId: version.id,
    versions: [...current.versions, version],
  };
  soulDocuments = { ...soulDocuments, [scope]: restored };
  return restored;
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

function rolloutPolicyForOrgRolloutTool() {
  return {
    id: E2E_SKILL_REGISTRY_FIXTURE.orgRolloutToolPolicyId,
    skillId: orgRolloutTool.skillId,
    versionId: orgRolloutTool.versionId,
    target: 'user-global',
    audience: 'all-org-users',
    catalogScope: 'organization',
    orgId: E2E_SKILL_REGISTRY_ORG_ID,
    enabled: !disabledRolloutPolicyIds.has(E2E_SKILL_REGISTRY_FIXTURE.orgRolloutToolPolicyId),
    updatePolicy: 'pinned',
    releaseChannel: null,
    removalPolicy: 'admin_removable',
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
  };
}

function readJsonBody(req: IncomingMessage, callback: (body: Record<string, unknown>) => void): void {
  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => {
    raw += chunk;
  });
  req.on('end', () => {
    try {
      const parsed = raw.trim() ? JSON.parse(raw) : {};
      callback(parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {});
    } catch {
      callback({});
    }
  });
}

function handleRegistryRequest(req: IncomingMessage, res: ServerResponse): void {
  const base = registryBaseUrl ?? 'http://127.0.0.1';
  const url = new URL(req.url ?? '/', base);
  if (req.method === 'POST' && url.pathname === '/__e2e/reset') {
    useUpdatedRuntimeVersion = false;
    deletedInstallationIds = new Set();
    deletedInstallationCalls = [];
    disabledRolloutPolicyIds = new Set();
    updatedRolloutPolicyCalls = [];
    soulDocuments = createDefaultSoulDocuments();
    json(res, 200, { ok: true, mode: 'initial' });
    return;
  }
  if (req.method === 'POST' && url.pathname === '/__e2e/use-updated-runtime-version') {
    useUpdatedRuntimeVersion = true;
    json(res, 200, { ok: true, mode: 'updated' });
    return;
  }
  if (req.method === 'GET' && url.pathname === '/__e2e/events') {
    json(res, 200, { deletedInstallationCalls, updatedRolloutPolicyCalls });
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
      personalGlobalSkill,
      orgRolloutTool,
    ].map((skill) => [skill.versionId, skill]),
  );

  const soulDocumentMatch = /^\/v1\/soul\/(organization|user)$/.exec(url.pathname);
  if (soulDocumentMatch?.[1]) {
    const scope = soulDocumentMatch[1] as SoulScope;
    if (req.method === 'GET') {
      json(res, 200, ensureSoulDocumentOwner(scope, req));
      return;
    }
    if (req.method === 'PATCH') {
      readJsonBody(req, (body) => {
        try {
          json(res, 200, updateSoulDocument(scope, req, body));
        } catch (error) {
          const code = error instanceof Error ? error.message : 'invalid_soul_update';
          json(res, code === 'soul_conflict' ? 409 : 400, { code });
        }
      });
      return;
    }
  }

  const soulVersionsMatch = /^\/v1\/soul\/(organization|user)\/versions$/.exec(url.pathname);
  if (req.method === 'GET' && soulVersionsMatch?.[1]) {
    const scope = soulVersionsMatch[1] as SoulScope;
    json(res, 200, { versions: ensureSoulDocumentOwner(scope, req).versions, nextCursor: null });
    return;
  }

  const soulVersionMatch = /^\/v1\/soul\/(organization|user)\/versions\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'GET' && soulVersionMatch?.[1] && soulVersionMatch[2]) {
    const scope = soulVersionMatch[1] as SoulScope;
    const versionId = decodeURIComponent(soulVersionMatch[2]);
    const version = ensureSoulDocumentOwner(scope, req).versions.find((item) => item.id === versionId);
    if (!version) {
      json(res, 404, { code: 'not_found', message: 'Soul version not found' });
      return;
    }
    json(res, 200, version);
    return;
  }

  const soulRestoreMatch = /^\/v1\/soul\/(organization|user)\/versions\/([^/]+)\/restore$/.exec(url.pathname);
  if (req.method === 'POST' && soulRestoreMatch?.[1] && soulRestoreMatch[2]) {
    const scope = soulRestoreMatch[1] as SoulScope;
    const versionId = decodeURIComponent(soulRestoreMatch[2]);
    readJsonBody(req, (body) => {
      try {
        json(res, 200, restoreSoulDocument(scope, req, versionId, body));
      } catch {
        json(res, 404, { code: 'not_found', message: 'Soul version not found' });
      }
    });
    return;
  }

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
      personalGlobalSkill,
      orgRolloutTool,
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
    const source = url.searchParams.get('source')?.trim() ?? '';
    const target = url.searchParams.get('target')?.trim() ?? '';
    const installations = source === 'personal' && target === 'personal-global'
      ? [installationFor(personalGlobalSkill)].filter((installation) => !deletedInstallationIds.has(installation.installationId))
      : [];
    json(res, 200, { installations, nextCursor: null });
    return;
  }

  if (url.pathname === '/v1/skill-rollout-policies') {
    const target = url.searchParams.get('target')?.trim() ?? '';
    const enabled = url.searchParams.get('enabled')?.trim() ?? '';
    const policy = rolloutPolicyForOrgRolloutTool();
    const policies = target === 'user-global' && (enabled !== 'true' || policy.enabled) ? [policy] : [];
    json(res, 200, { policies, nextCursor: null });
    return;
  }

  const rolloutPolicyMatch = /^\/v1\/skill-rollout-policies\/([^/]+)$/.exec(url.pathname);
  if (req.method === 'PATCH' && rolloutPolicyMatch?.[1]) {
    const policyId = decodeURIComponent(rolloutPolicyMatch[1]);
    readJsonBody(req, (body) => {
      const enabled = typeof body.enabled === 'boolean' ? body.enabled : null;
      if (policyId === E2E_SKILL_REGISTRY_FIXTURE.orgRolloutToolPolicyId && enabled === false) {
        disabledRolloutPolicyIds.add(policyId);
      }
      if (policyId === E2E_SKILL_REGISTRY_FIXTURE.orgRolloutToolPolicyId && enabled === true) {
        disabledRolloutPolicyIds.delete(policyId);
      }
      updatedRolloutPolicyCalls.push({ policyId, enabled });
      json(res, 200, { policy: rolloutPolicyForOrgRolloutTool() });
    });
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
  disabledRolloutPolicyIds = new Set();
  updatedRolloutPolicyCalls = [];
  soulDocuments = createDefaultSoulDocuments();
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

export async function readSkillRegistryFixtureEvents(): Promise<{
  deletedInstallationCalls: string[];
  updatedRolloutPolicyCalls: Array<{ policyId: string; enabled: boolean | null }>;
}> {
  const response = await fetch(`${readSkillRegistryFixtureBaseUrl()}/__e2e/events`);
  if (!response.ok) {
    throw new Error(`Skill registry fixture events failed with ${response.status}`);
  }
  return (await response.json()) as {
    deletedInstallationCalls: string[];
    updatedRolloutPolicyCalls: Array<{ policyId: string; enabled: boolean | null }>;
  };
}
