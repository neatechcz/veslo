export type SoulScope = "organization" | "user" | "workspace";
type SoulVersionSource = "manual" | "api" | "heartbeat" | "restore" | "system";

export interface SoulVersion {
  id: string;
  content: string;
  changeSummary: string;
  createdAt: string;
  createdBy: string;
  source: SoulVersionSource;
  baseVersionId: string | null;
  restoreSourceVersionId: string | null;
}

export interface SoulDocument {
  id: string;
  scope: SoulScope;
  ownerId: string;
  currentVersionId: string | null;
  heartbeatEnabled: boolean;
  versions: SoulVersion[];
}

export interface CreateSoulVersionInput {
  id: string;
  content: string;
  changeSummary: string;
  createdAt: string;
  createdBy: string;
  source: Exclude<SoulVersionSource, "restore">;
  baseVersionId: string | null;
}

export interface RestoreSoulVersionInput {
  id: string;
  restoreSourceVersionId: string;
  changeSummary: string;
  createdAt: string;
  createdBy: string;
}

export interface ResolveEffectiveSoulInput {
  organization?: SoulDocument | null;
  user?: SoulDocument | null;
  workspace?: SoulDocument | null;
}

export function currentSoulVersion(document: SoulDocument): SoulVersion | null {
  if (document.currentVersionId === null) return null;
  return document.versions.find(version => version.id === document.currentVersionId) ?? null;
}

export function createSoulVersion(document: SoulDocument, input: CreateSoulVersionInput): SoulDocument {
  validateNewVersionId(document, input.id);
  validateCurrentVersionPointer(document);
  validateBaseVersion(document, input.baseVersionId);
  validateVersionMetadata(input);

  const version: SoulVersion = {
    id: input.id,
    content: input.content,
    changeSummary: input.changeSummary,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    source: input.source,
    baseVersionId: input.baseVersionId,
    restoreSourceVersionId: null,
  };

  return {
    ...document,
    currentVersionId: version.id,
    versions: [...document.versions, version],
  };
}

export function restoreSoulVersion(document: SoulDocument, input: RestoreSoulVersionInput): SoulDocument {
  validateNewVersionId(document, input.id);
  validateCurrentVersionPointer(document);
  validateVersionMetadata(input);

  const sourceVersion = document.versions.find(version => version.id === input.restoreSourceVersionId);
  if (!sourceVersion) {
    throw new Error(`Cannot restore missing Soul version "${input.restoreSourceVersionId}".`);
  }

  const version: SoulVersion = {
    id: input.id,
    content: sourceVersion.content,
    changeSummary: input.changeSummary,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    source: "restore",
    baseVersionId: document.currentVersionId,
    restoreSourceVersionId: sourceVersion.id,
  };

  return {
    ...document,
    currentVersionId: version.id,
    versions: [...document.versions, version],
  };
}

export function resolveEffectiveSoul(input: ResolveEffectiveSoulInput): string {
  return [input.organization, input.user, input.workspace]
    .map(document => (document ? currentSoulVersion(document) : null))
    .filter((version): version is SoulVersion => version !== null)
    .map(version => version.content)
    .filter(content => content.length > 0)
    .join("\n\n");
}

function validateNewVersionId(document: SoulDocument, id: string): void {
  assertNonEmptyString(id, "id");
  if (document.versions.some(version => version.id === id)) {
    throw new Error(`Soul version "${id}" already exists.`);
  }
}

function validateCurrentVersionPointer(document: SoulDocument): void {
  if (document.currentVersionId !== null && !currentSoulVersion(document)) {
    throw new Error(`Soul document currentVersionId "${document.currentVersionId}" does not exist.`);
  }
}

function validateBaseVersion(document: SoulDocument, baseVersionId: string | null): void {
  if (baseVersionId !== document.currentVersionId) {
    throw new Error(
      `Stale baseVersionId "${baseVersionId ?? "null"}"; expected "${document.currentVersionId ?? "null"}".`,
    );
  }
}

function validateVersionMetadata(input: {
  changeSummary: string;
  createdAt: string;
  createdBy: string;
}): void {
  assertNonEmptyString(input.changeSummary, "changeSummary");
  assertNonEmptyString(input.createdAt, "createdAt");
  assertNonEmptyString(input.createdBy, "createdBy");
}

function assertNonEmptyString(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new Error(`Soul version ${field} must not be empty.`);
  }
}
