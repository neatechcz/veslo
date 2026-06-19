import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TextDecoder } from 'node:util';

type PackageFile = {
  path: string;
  sha256: string;
  sizeBytes: number;
  mediaType: string;
  executable?: boolean;
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
    tags?: string[];
    language?: string;
  };
};

type FixtureSkill = {
  name: string;
  skillId: string;
  installationId: string;
  versionId: string;
  source: 'personal' | 'workspace' | 'organization' | 'platform';
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
export const E2E_GOOGLE_MCP_CATALOG_USER_ID = 'user_veslo_google_mcp_e2e';

const E2E_GOOGLE_MCP_CONNECTOR_DEFINITIONS = [
  {
    id: 'google-gmail',
    name: 'Google Gmail',
    description: 'Search Gmail threads and create draft email through Google MCP.',
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.compose',
    ],
  },
  {
    id: 'google-calendar',
    name: 'Google Calendar',
    description: 'List calendars, inspect availability, and manage events through Google MCP.',
    scopes: [
      'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
      'https://www.googleapis.com/auth/calendar.events.freebusy',
      'https://www.googleapis.com/auth/calendar.events.readonly',
    ],
  },
  {
    id: 'google-drive',
    name: 'Google Drive',
    description: 'Find and work with Google Drive files through Google MCP.',
    scopes: [
      'https://www.googleapis.com/auth/drive.readonly',
      'https://www.googleapis.com/auth/drive.file',
    ],
  },
] as const;

export function buildE2EGoogleMcpConnectors(baseUrl: string, orgId = E2E_SKILL_REGISTRY_ORG_ID) {
  const normalizedBaseUrl = baseUrl.trim().replace(/\/+$/, '');
  const orgPath = `/v1/orgs/${encodeURIComponent(orgId)}`;
  return E2E_GOOGLE_MCP_CONNECTOR_DEFINITIONS.map((connector) => ({
    id: connector.id,
    name: connector.name,
    description: connector.description,
    config: {
      type: 'remote',
      url: `${normalizedBaseUrl}${orgPath}/integrations/google/${connector.id}/mcp`,
      oauth: false,
      headers: {
        'X-Veslo-Connector': connector.id,
      },
    },
    authorization: {
      type: 'veslo-server-oauth',
      provider: 'google',
      connectorId: connector.id,
      scopes: [...connector.scopes],
      startPath: `${orgPath}/integrations/google/${connector.id}/oauth/start`,
      runtimeTokenPath: `${orgPath}/integrations/google/${connector.id}/runtime-token`,
      statusPath: `${orgPath}/integrations/google/connections`,
      disconnectPath: `${orgPath}/integrations/google/${connector.id}/connection`,
    },
    source: { scope: 'platform' },
    provider: { id: 'google', group: 'Google' },
  }));
}

export const E2E_GOOGLE_MCP_CONNECTORS = buildE2EGoogleMcpConnectors('https://api.veslo.work');

export function shouldUseGoogleMcpCatalogFixture(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.E2E_GOOGLE_MCP_CATALOG_FIXTURE?.trim() === '1';
}

export function createGoogleMcpCatalogDenAuthJson(baseUrl: string): string {
  const denApiBase = baseUrl.trim().replace(/\/+$/, '');
  return JSON.stringify({
    denApiBase,
    token: E2E_SKILL_REGISTRY_TOKEN,
    orgId: E2E_SKILL_REGISTRY_ORG_ID,
    user: {
      id: E2E_GOOGLE_MCP_CATALOG_USER_ID,
      email: 'veslo-google-mcp-e2e@example.test',
    },
    org: {
      id: E2E_SKILL_REGISTRY_ORG_ID,
      slug: 'veslo-google-mcp-e2e',
    },
  });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..', '..');
const CORE_PLATFORM_SKILL_ASSETS_ROOT = join(REPO_ROOT, 'services', 'den', 'src', 'skills', 'core-platform-skill-assets');
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function sha256(value: Buffer | string): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : new Uint8Array(value))
    .digest('hex');
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

function textForFile(bytes: Buffer, mediaType: string): string | undefined {
  if (
    !mediaType.startsWith('text/') &&
    mediaType !== 'application/json' &&
    mediaType !== 'application/yaml' &&
    mediaType !== 'image/svg+xml'
  ) {
    return undefined;
  }

  try {
    return UTF8_DECODER.decode(new Uint8Array(bytes));
  } catch {
    return undefined;
  }
}

function archiveFileFromBytes(path: string, bytes: Buffer, mediaType: string, executable = false): PackageFile {
  const text = textForFile(bytes, mediaType);
  return {
    path,
    sha256: sha256(bytes),
    sizeBytes: bytes.byteLength,
    mediaType,
    ...(executable ? { executable: true } : {}),
    ...(text !== undefined ? { text } : {}),
    contentBase64: bytes.toString('base64'),
  };
}

function archiveFile(path: string, text: string, mediaType = 'text/markdown'): PackageFile {
  const bytes = Buffer.from(text, 'utf8');
  return archiveFileFromBytes(path, bytes, mediaType);
}

function comparePackagePaths(left: PackageFile, right: PackageFile): number {
  if (left.path < right.path) return -1;
  if (left.path > right.path) return 1;
  return 0;
}

function buildArchiveFromFiles(
  metadata: PackageArchive['metadata'],
  files: PackageFile[],
): PackageArchive {
  const sortedFiles = [...files].sort(comparePackagePaths);
  const manifestWithoutHash = {
    schemaVersion: 1,
    entrypoint: 'SKILL.md',
    files: sortedFiles.map(({ contentBase64: _contentBase64, ...file }) => file),
    metadata,
  };
  const packageSha256 = sha256(stableStringify(manifestWithoutHash));
  return {
    ...manifestWithoutHash,
    files: sortedFiles,
    packageSha256,
  } as PackageArchive;
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
  ];
  const metadata = { name, description };
  return buildArchiveFromFiles(metadata, files);
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

type CorePlatformSkillName =
  | 'veslo-docx'
  | 'veslo-pdf'
  | 'veslo-pptx'
  | 'veslo-xlsx'
  | 'skill-creator';

type CorePlatformFixtureDefinition = {
  name: CorePlatformSkillName;
  sourcePack: string;
  skillId: string;
  policyId: string;
  versionId: string;
  description: string;
  tags: string[];
};

const CORE_PLATFORM_FIXTURE_DEFINITIONS: CorePlatformFixtureDefinition[] = [
  {
    name: 'veslo-docx',
    sourcePack: 'docx',
    skillId: 'skill_e2e_core_platform_docx',
    policyId: 'policy_e2e_core_platform_docx',
    versionId: 'version_core_platform_docx_1',
    description: 'Create, edit, analyze, convert, and validate Word DOCX documents using standard skill execution.',
    tags: ['documents', 'docx', 'office', 'platform-core'],
  },
  {
    name: 'veslo-pdf',
    sourcePack: 'pdf',
    skillId: 'skill_e2e_core_platform_pdf',
    policyId: 'policy_e2e_core_platform_pdf',
    versionId: 'version_core_platform_pdf_1',
    description: 'Extract, create, merge, split, annotate, fill forms, and validate PDF documents using standard skill execution.',
    tags: ['documents', 'pdf', 'office', 'platform-core'],
  },
  {
    name: 'veslo-pptx',
    sourcePack: 'pptx',
    skillId: 'skill_e2e_core_platform_pptx',
    policyId: 'policy_e2e_core_platform_pptx',
    versionId: 'version_core_platform_pptx_1',
    description: 'Create, edit, analyze, and visually validate PowerPoint PPTX presentations using standard skill execution.',
    tags: ['presentations', 'pptx', 'office', 'platform-core'],
  },
  {
    name: 'veslo-xlsx',
    sourcePack: 'xlsx',
    skillId: 'skill_e2e_core_platform_xlsx',
    policyId: 'policy_e2e_core_platform_xlsx',
    versionId: 'version_core_platform_xlsx_1',
    description: 'Create, edit, analyze, recalculate, and validate Excel XLSX workbooks using standard skill execution.',
    tags: ['spreadsheets', 'xlsx', 'office', 'platform-core'],
  },
  {
    name: 'skill-creator',
    sourcePack: 'skill-creator',
    skillId: 'skill_e2e_core_platform_skill_creator',
    policyId: 'policy_e2e_core_platform_skill_creator',
    versionId: 'version_core_platform_skill_creator_1',
    description: 'Create and update Veslo skills for user, workspace, organization, and public registry-backed distribution.',
    tags: ['skills', 'registry', 'authoring', 'platform-core'],
  },
];

function toPackagePath(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/');
}

function shouldSkipPackageFile(path: string): boolean {
  return path.endsWith('.pyc') || path === 'scripts/test_quick_validate.py';
}

function mediaTypeForPath(path: string): string {
  if (path.endsWith('.md')) return 'text/markdown';
  if (path.endsWith('.py')) return 'text/x-python';
  if (path.endsWith('.js')) return 'text/javascript';
  if (path.endsWith('.css')) return 'text/css';
  if (path.endsWith('.html')) return 'text/html';
  if (path.endsWith('.json')) return 'application/json';
  if (path.endsWith('.yaml') || path.endsWith('.yml')) return 'application/yaml';
  if (path.endsWith('.xml') || path.endsWith('.xsd')) return 'text/xml';
  if (path.endsWith('.tgz') || path.endsWith('.tar.gz')) return 'application/gzip';
  return 'application/octet-stream';
}

function isExecutablePath(path: string): boolean {
  return path.endsWith('.sh') || path.endsWith('.py');
}

function collectPackageFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root).sort((left, right) => left.localeCompare(right))) {
    if (entry === '__pycache__' || entry === '.DS_Store') continue;
    const path = join(root, entry);
    const stat = statSync(path);
    if (stat.isDirectory()) {
      files.push(...collectPackageFiles(path));
    } else if (stat.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function buildCorePlatformArchive(definition: CorePlatformFixtureDefinition): PackageArchive {
  const packRoot = join(CORE_PLATFORM_SKILL_ASSETS_ROOT, definition.sourcePack);
  const files = collectPackageFiles(packRoot)
    .map((absolutePath) => {
      const path = toPackagePath(relative(packRoot, absolutePath));
      if (shouldSkipPackageFile(path)) return null;
      return archiveFileFromBytes(
        path,
        readFileSync(absolutePath),
        mediaTypeForPath(path),
        isExecutablePath(path),
      );
    })
    .filter((file): file is PackageFile => Boolean(file));

  return buildArchiveFromFiles(
    {
      name: definition.name,
      description: definition.description,
      tags: definition.tags,
      language: 'en',
    },
    files,
  );
}

function corePlatformFixtureSkill(definition: CorePlatformFixtureDefinition): FixtureSkill {
  return {
    name: definition.name,
    skillId: definition.skillId,
    installationId: `rollout:${definition.policyId}`,
    versionId: definition.versionId,
    source: 'platform',
    archive: buildCorePlatformArchive(definition),
  };
}

const corePlatformSkills = CORE_PLATFORM_FIXTURE_DEFINITIONS.map(corePlatformFixtureSkill);
const corePlatformSkillByPolicyId = new Map(
  CORE_PLATFORM_FIXTURE_DEFINITIONS.map((definition, index) => [
    definition.policyId,
    {
      definition,
      skill: corePlatformSkills[index],
    },
  ]),
);
const corePlatformDocxSkill = corePlatformSkills.find((skill) => skill.name === 'veslo-docx') ?? corePlatformSkills[0];

export const E2E_SKILL_REGISTRY_FIXTURE = {
  runtimeSkill,
  runtimeSkillUpdated,
  orgShadowedSkill,
  orgLockedSkill,
  personalShadowSkill,
  personalGlobalSkill,
  orgRolloutTool,
  corePlatformDocxSkill,
  corePlatformSkills,
  orgRolloutToolPolicyId: 'policy_e2e_org_rollout_tool',
  corePlatformDocxPolicyId: 'policy_e2e_core_platform_docx',
  corePlatformPolicyIds: CORE_PLATFORM_FIXTURE_DEFINITIONS.map((definition) => definition.policyId),
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
  const rawBaseVersionId = body.baseVersionId;
  let baseVersionId: string | null = null;
  if (typeof rawBaseVersionId === 'string') {
    baseVersionId = rawBaseVersionId;
  }
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

function rolloutPolicyForCorePlatformDocx() {
  return rolloutPolicyForCorePlatformSkill(E2E_SKILL_REGISTRY_FIXTURE.corePlatformDocxPolicyId);
}

function rolloutPolicyForCorePlatformSkill(policyId: string) {
  const entry = corePlatformSkillByPolicyId.get(policyId);
  if (!entry) {
    throw new Error(`Unknown core platform skill rollout policy: ${policyId}`);
  }
  return {
    id: policyId,
    skillId: entry.skill.skillId,
    versionId: entry.skill.versionId,
    target: 'user-global',
    audience: 'all-platform-users',
    catalogScope: 'platform',
    orgId: null,
    enabled: !disabledRolloutPolicyIds.has(policyId),
    updatePolicy: 'pinned',
    releaseChannel: null,
    removalPolicy: 'locked',
    createdAt: '2026-06-06T00:00:00.000Z',
    updatedAt: '2026-06-06T00:00:00.000Z',
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

  const googleMcpCatalogMatch = /^\/v1\/orgs\/([^/]+)\/mcp\/catalog$/.exec(url.pathname);
  if (req.method === 'GET' && googleMcpCatalogMatch?.[1]) {
    if (!shouldUseGoogleMcpCatalogFixture()) {
      json(res, 404, { code: 'not_found', message: `Unhandled registry fixture path: ${url.pathname}` });
      return;
    }

    const authHeader = req.headers.authorization?.trim() ?? '';
    if (authHeader !== `Bearer ${E2E_SKILL_REGISTRY_TOKEN}`) {
      json(res, 401, { code: 'den_token_required', message: 'Missing or invalid Den token header' });
      return;
    }

    json(res, 200, { items: buildE2EGoogleMcpConnectors(base, googleMcpCatalogMatch[1]) });
    return;
  }

  const googleMcpRuntimeTokenMatch = /^\/v1\/orgs\/([^/]+)\/integrations\/google\/([^/]+)\/runtime-token$/.exec(url.pathname);
  if (req.method === 'POST' && googleMcpRuntimeTokenMatch?.[1] && googleMcpRuntimeTokenMatch?.[2]) {
    if (!shouldUseGoogleMcpCatalogFixture()) {
      json(res, 404, { code: 'not_found', message: `Unhandled registry fixture path: ${url.pathname}` });
      return;
    }

    const authHeader = req.headers.authorization?.trim() ?? '';
    if (authHeader !== `Bearer ${E2E_SKILL_REGISTRY_TOKEN}`) {
      json(res, 401, { code: 'den_token_required', message: 'Missing or invalid Den token header' });
      return;
    }

    json(res, 200, {
      token: `e2e-runtime-token-${decodeURIComponent(googleMcpRuntimeTokenMatch[2])}`,
      connectorId: decodeURIComponent(googleMcpRuntimeTokenMatch[2]),
      expiresAt: '2030-06-19T12:00:00.000Z',
    });
    return;
  }

  const googleMcpOAuthStartMatch = /^\/v1\/orgs\/([^/]+)\/integrations\/google\/([^/]+)\/oauth\/start$/.exec(url.pathname);
  if (req.method === 'GET' && googleMcpOAuthStartMatch?.[1] && googleMcpOAuthStartMatch?.[2]) {
    if (!shouldUseGoogleMcpCatalogFixture()) {
      json(res, 404, { code: 'not_found', message: `Unhandled registry fixture path: ${url.pathname}` });
      return;
    }

    const authHeader = req.headers.authorization?.trim() ?? '';
    if (authHeader !== `Bearer ${E2E_SKILL_REGISTRY_TOKEN}`) {
      json(res, 401, { code: 'den_token_required', message: 'Missing or invalid Den token header' });
      return;
    }

    const connectorId = decodeURIComponent(googleMcpOAuthStartMatch[2]);
    json(res, 200, {
      authorizeUrl: `${base}/__e2e/google-oauth/${encodeURIComponent(connectorId)}`,
      state: `e2e-state-${connectorId}`,
      connectorId,
      scopes: E2E_GOOGLE_MCP_CONNECTOR_DEFINITIONS.find((connector) => connector.id === connectorId)?.scopes ?? [],
    });
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
      ...corePlatformSkills,
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
      ...corePlatformSkills,
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
    const policies = target === 'user-global'
      ? [
          rolloutPolicyForOrgRolloutTool(),
          ...E2E_SKILL_REGISTRY_FIXTURE.corePlatformPolicyIds.map(rolloutPolicyForCorePlatformSkill),
        ]
        .filter((policy) => enabled !== 'true' || policy.enabled)
      : [];
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
      if (corePlatformSkillByPolicyId.has(policyId) && enabled === false) {
        disabledRolloutPolicyIds.add(policyId);
      }
      if (corePlatformSkillByPolicyId.has(policyId) && enabled === true) {
        disabledRolloutPolicyIds.delete(policyId);
      }
      updatedRolloutPolicyCalls.push({ policyId, enabled });
      const policy = corePlatformSkillByPolicyId.has(policyId)
        ? rolloutPolicyForCorePlatformSkill(policyId)
        : rolloutPolicyForOrgRolloutTool();
      json(res, 200, { policy });
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
