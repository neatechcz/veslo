import { createHash } from "node:crypto";
import { TextDecoder } from "node:util";

import { validateSkillPackageManifest } from "./skill-package-model.js";
import type { SkillPackageFile, SkillPackageManifest } from "./skill-package-model.js";
import {
  MAX_SKILL_PACKAGE_FILE_COUNT,
  MAX_SKILL_PACKAGE_FILE_SIZE_BYTES,
  MAX_SKILL_PACKAGE_TOTAL_SIZE_BYTES,
} from "./skill-packages.js";

type RegistrySkillVisibility = "personal" | "workspace" | "organization" | "platform";
type RegistrySkillReviewStatus = "draft" | "pending_review" | "approved" | "rejected";
export type RegistrySkillInstallationSource = "personal" | "workspace" | "organization" | "platform";
export type RegistrySkillRolloutPolicyTarget = "user-global" | "workspace";
export type RegistrySkillRolloutPolicyAudience =
  | "user"
  | "selected-workspaces"
  | "all-org-users"
  | "all-platform-users";
export type RegistrySkillRolloutPolicyCatalogScope = "organization" | "platform";
export type RegistrySkillRolloutPolicyUpdatePolicy =
  | "pinned"
  | "latest_user"
  | "latest_approved"
  | "release_channel";
export type RegistrySkillRolloutPolicyRemovalPolicy = "user_removable" | "admin_removable" | "locked";

type RegistrySkillVersionSummary = {
  id: string;
  version: string;
  packageSha256: string;
  createdAt: string;
};

type RegistrySkillSummary = {
  id: string;
  slug: string;
  name: string;
  description?: string;
  tags?: string[];
  visibility: RegistrySkillVisibility;
  reviewStatus: RegistrySkillReviewStatus;
  createdAt: string;
  updatedAt: string;
  latestVersion?: RegistrySkillVersionSummary;
};

export type RegistrySkillListResponse = {
  skills: RegistrySkillSummary[];
  nextCursor?: string | null;
};

export type RegistrySkillResponse = {
  skill: RegistrySkillSummary;
};

export type RegistrySkillVersionsResponse = {
  versions: RegistrySkillVersionSummary[];
  nextCursor?: string | null;
};

export type RegistrySkillVersionResponse = {
  version: RegistrySkillVersionSummary;
};

type RegistrySkillPackageFile = SkillPackageFile & {
  contentBase64: string;
};

export type RegistrySkillPackageArchive = Omit<SkillPackageManifest, "files"> & {
  files: RegistrySkillPackageFile[];
};

export type RegistrySkillPackageResponse = {
  versionId: string;
  skillId: string;
  package: RegistrySkillPackageArchive;
};

type RegistrySkillInstallation = {
  installationId: string;
  skillId: string;
  versionId: string;
  enabled: boolean;
  source: RegistrySkillInstallationSource;
  installedAt: string;
  updatedAt?: string;
  name?: string;
  packageSha256?: string;
  ownerUserId?: string | null;
  orgId?: string | null;
  workspaceId?: string | null;
  approved?: boolean;
  desiredVersionId?: string | null;
  desiredPackageSha256?: string | null;
};

export type RegistrySkillInstallationResponse = {
  installation: RegistrySkillInstallation;
};

export type RegistrySkillInstallationsResponse = {
  installations: RegistrySkillInstallation[];
  nextCursor?: string | null;
};

export type RegistrySkillRolloutPolicy = {
  id: string;
  skillId: string;
  versionId: string | null;
  target: RegistrySkillRolloutPolicyTarget;
  audience: RegistrySkillRolloutPolicyAudience;
  catalogScope: RegistrySkillRolloutPolicyCatalogScope;
  orgId?: string | null;
  userId?: string | null;
  workspaceId?: string | null;
  enabled: boolean;
  updatePolicy: RegistrySkillRolloutPolicyUpdatePolicy;
  releaseChannel?: string | null;
  removalPolicy: RegistrySkillRolloutPolicyRemovalPolicy;
  createdAt: string;
  updatedAt?: string;
};

export type RegistrySkillRolloutPoliciesResponse = {
  policies: RegistrySkillRolloutPolicy[];
  nextCursor?: string | null;
};

export type RegistrySkillRolloutPolicyResponse = {
  policy: RegistrySkillRolloutPolicy;
};

export type WorkspaceSkillSetResponse = {
  workspaceId: string;
  skillSetId?: string;
  revision?: string;
  skills: RegistrySkillInstallation[];
};

export type RegistrySkillReviewRequestResponse = {
  requestId: string;
  skillId: string;
  status: Extract<RegistrySkillReviewStatus, "pending_review" | "approved" | "rejected">;
  createdAt: string;
  updatedAt?: string;
};

export type RegistrySkillSearchResponse = RegistrySkillListResponse & {
  query: string;
};

type RegistrySkillEvent = {
  id: string;
  action: string;
  orgId?: string | null;
  workspaceId?: string | null;
  skillId?: string | null;
  versionId?: string | null;
  installationId?: string | null;
  actorUserId?: string | null;
  payload?: unknown;
  createdAt: string;
};

export type RegistrySkillEventsResponse = {
  events: RegistrySkillEvent[];
  nextCursor?: string | null;
  revision?: string | null;
};

const SHA256_PATTERN = /^[a-f0-9]{64}$/i;
const UTC_ISO_INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const requireRecord = (value: unknown, field: string): Record<string, unknown> => {
  if (!isRecord(value)) {
    throw new Error(`Skill registry ${field} must be an object`);
  }
  return value;
};

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Skill registry ${field} must be a non-empty string`);
  }
  return value.trim();
};

const requireStringValue = (value: unknown, field: string): string => {
  if (typeof value !== "string") {
    throw new Error(`Skill registry ${field} must be a string`);
  }
  return value;
};

const optionalString = (value: unknown, field: string): string | undefined => {
  if (value === undefined || value === null) return undefined;
  return requireString(value, field);
};

const requireBoolean = (value: unknown, field: string): boolean => {
  if (typeof value !== "boolean") {
    throw new Error(`Skill registry ${field} must be a boolean`);
  }
  return value;
};

const optionalBoolean = (value: unknown, field: string): boolean | undefined => {
  if (value === undefined || value === null) return undefined;
  return requireBoolean(value, field);
};

const requireIsoDateString = (value: unknown, field: string): string => {
  const date = requireString(value, field);
  const parsed = Date.parse(date);
  if (
    !UTC_ISO_INSTANT_PATTERN.test(date) ||
    Number.isNaN(parsed) ||
    new Date(parsed).toISOString() !== date
  ) {
    throw new Error(`Skill registry ${field} must be a UTC ISO instant string`);
  }
  return date;
};

const requireSha256 = (value: unknown, field: string): string => {
  const digest = requireString(value, field).toLowerCase();
  if (!SHA256_PATTERN.test(digest)) {
    throw new Error(`Skill registry ${field} must be a 64-character hex digest`);
  }
  return digest;
};

const requireStringArray = (value: unknown, field: string): string[] | undefined => {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error(`Skill registry ${field} must be an array`);
  }
  return value.map((entry, index) => requireString(entry, `${field}[${index}]`));
};

const requireEnum = <T extends string>(value: unknown, field: string, allowed: readonly T[]): T => {
  const normalized = requireString(value, field);
  if (!allowed.includes(normalized as T)) {
    throw new Error(`Skill registry ${field} must be one of: ${allowed.join(", ")}`);
  }
  return normalized as T;
};

const validateVersionSummary = (value: unknown, field: string): RegistrySkillVersionSummary => {
  const record = requireRecord(value, field);
  return {
    id: requireString(record.id, `${field}.id`),
    version: requireString(record.version, `${field}.version`),
    packageSha256: requireSha256(record.packageSha256, `${field}.packageSha256`),
    createdAt: requireIsoDateString(record.createdAt, `${field}.createdAt`),
  };
};

const validateSkillSummary = (value: unknown, field: string): RegistrySkillSummary => {
  const record = requireRecord(value, field);
  const description = optionalString(record.description, `${field}.description`);
  const tags = requireStringArray(record.tags, `${field}.tags`);
  const latestVersion =
    record.latestVersion === undefined || record.latestVersion === null
      ? undefined
      : validateVersionSummary(record.latestVersion, `${field}.latestVersion`);

  const skill: RegistrySkillSummary = {
    id: requireString(record.id, `${field}.id`),
    slug: requireString(record.slug, `${field}.slug`),
    name: requireString(record.name, `${field}.name`),
    visibility: requireEnum(record.visibility, `${field}.visibility`, [
      "personal",
      "workspace",
      "organization",
      "platform",
    ]),
    reviewStatus: requireEnum(record.reviewStatus, `${field}.reviewStatus`, [
      "draft",
      "pending_review",
      "approved",
      "rejected",
    ]),
    createdAt: requireIsoDateString(record.createdAt, `${field}.createdAt`),
    updatedAt: requireIsoDateString(record.updatedAt, `${field}.updatedAt`),
  };
  if (description) skill.description = description;
  if (tags) skill.tags = tags;
  if (latestVersion) skill.latestVersion = latestVersion;
  return skill;
};

const validatePaginatedCursor = (value: unknown, field: string): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireString(value, field);
};

const optionalNullableString = (value: unknown, field: string): string | null | undefined => {
  if (value === undefined) return undefined;
  if (value === null) return null;
  return requireString(value, field);
};

const requireNullableString = (value: unknown, field: string): string | null => {
  if (value === null) return null;
  return requireString(value, field);
};

const sha256 = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");

const maxBase64LengthForDecodedSize = (sizeBytes: number): number => {
  if (sizeBytes === 0) return 0;
  return Math.ceil(sizeBytes / 3) * 4;
};

const decodeUtf8 = (bytes: Buffer, path: string): string => {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error(`Skill registry package file text does not match archive bytes: ${path}`);
  }
};

const validatePackageFileBytes = (
  file: SkillPackageFile,
  archiveFile: RegistrySkillPackageFile,
): RegistrySkillPackageFile => {
  if (archiveFile.contentBase64.length > maxBase64LengthForDecodedSize(file.sizeBytes)) {
    throw new Error(`Skill registry package archive base64 content is too large: ${file.path}`);
  }
  if (!BASE64_PATTERN.test(archiveFile.contentBase64)) {
    throw new Error(`Skill registry package archive has invalid base64 content: ${file.path}`);
  }

  const bytes = Buffer.from(archiveFile.contentBase64, "base64");
  if (bytes.byteLength !== file.sizeBytes) {
    throw new Error(`Skill registry package file size does not match archive bytes: ${file.path}`);
  }
  if (sha256(bytes) !== file.sha256) {
    throw new Error(`Skill registry package file sha256 does not match archive bytes: ${file.path}`);
  }
  if (file.text !== undefined && decodeUtf8(bytes, file.path) !== file.text) {
    throw new Error(`Skill registry package file text does not match archive bytes: ${file.path}`);
  }

  return {
    ...file,
    contentBase64: archiveFile.contentBase64,
  };
};

const enforcePackageLimits = (files: Pick<SkillPackageFile, "path" | "sizeBytes">[]) => {
  if (files.length > MAX_SKILL_PACKAGE_FILE_COUNT) {
    throw new Error(`Skill registry package has too many files: ${files.length} > ${MAX_SKILL_PACKAGE_FILE_COUNT}`);
  }

  let totalSizeBytes = 0;
  for (const file of files) {
    if (file.sizeBytes > MAX_SKILL_PACKAGE_FILE_SIZE_BYTES) {
      throw new Error(
        `Skill registry package file is too large: ${file.path} (${file.sizeBytes} > ${MAX_SKILL_PACKAGE_FILE_SIZE_BYTES})`,
      );
    }
    totalSizeBytes += file.sizeBytes;
    if (totalSizeBytes > MAX_SKILL_PACKAGE_TOTAL_SIZE_BYTES) {
      throw new Error(
        `Skill registry package is too large: ${totalSizeBytes} > ${MAX_SKILL_PACKAGE_TOTAL_SIZE_BYTES}`,
      );
    }
  }
};

export function validateRegistrySkillListResponse(value: unknown): RegistrySkillListResponse {
  const record = requireRecord(value, "skill list response");
  if (!Array.isArray(record.skills)) {
    throw new Error("Skill registry skills must be an array");
  }
  return {
    skills: record.skills.map((skill, index) => validateSkillSummary(skill, `skills[${index}]`)),
    nextCursor: validatePaginatedCursor(record.nextCursor, "nextCursor"),
  };
}

export function validateRegistrySkillResponse(value: unknown): RegistrySkillResponse {
  const record = requireRecord(value, "skill response");
  return {
    skill: validateSkillSummary(record.skill, "skill"),
  };
}

export function validateRegistrySkillVersionsResponse(value: unknown): RegistrySkillVersionsResponse {
  const record = requireRecord(value, "skill versions response");
  if (!Array.isArray(record.versions)) {
    throw new Error("Skill registry versions must be an array");
  }
  return {
    versions: record.versions.map((version, index) => validateVersionSummary(version, `versions[${index}]`)),
    nextCursor: validatePaginatedCursor(record.nextCursor, "nextCursor"),
  };
}

export function validateRegistrySkillVersionResponse(value: unknown): RegistrySkillVersionResponse {
  const record = requireRecord(value, "skill version response");
  return {
    version: validateVersionSummary(record.version, "version"),
  };
}

const validatePackageArchive = (value: unknown): RegistrySkillPackageArchive => {
  const record = requireRecord(value, "package");
  if (!Array.isArray(record.files)) {
    throw new Error("Skill registry package.files must be an array");
  }

  const files = record.files.map((file, index) => {
    const fileRecord = requireRecord(file, `package.files[${index}]`);
    return {
      path: fileRecord.path,
      sha256: fileRecord.sha256,
      sizeBytes: fileRecord.sizeBytes,
      mediaType: fileRecord.mediaType,
      executable: fileRecord.executable,
      text: fileRecord.text,
      contentBase64: requireStringValue(fileRecord.contentBase64, `package.files[${index}].contentBase64`),
    } as RegistrySkillPackageFile;
  });

  const archive = {
    schemaVersion: record.schemaVersion,
    entrypoint: record.entrypoint,
    files,
    packageSha256: record.packageSha256,
    metadata: record.metadata,
  } as RegistrySkillPackageArchive;
  const manifest = validateSkillPackageManifest(archive);
  enforcePackageLimits(manifest.files);
  const archiveFilesByPath = new Map(files.map((file) => [file.path, file]));

  return {
    ...manifest,
    files: manifest.files.map((file) => {
      const archiveFile = archiveFilesByPath.get(file.path);
      if (!archiveFile) {
        throw new Error(`Skill registry package archive is missing content for file: ${file.path}`);
      }
      return validatePackageFileBytes(file, archiveFile);
    }),
  };
};

export function validateRegistrySkillPackageResponse(value: unknown): RegistrySkillPackageResponse {
  const record = requireRecord(value, "skill package response");
  return {
    versionId: requireString(record.versionId, "versionId"),
    skillId: requireString(record.skillId, "skillId"),
    package: validatePackageArchive(record.package),
  };
}

const validateInstallation = (value: unknown, field: string): RegistrySkillInstallation => {
  const record = requireRecord(value, field);
  const updatedAt = record.updatedAt === undefined ? undefined : requireIsoDateString(record.updatedAt, `${field}.updatedAt`);
  const name = optionalString(record.name, `${field}.name`);
  const packageSha256 = record.packageSha256 === undefined || record.packageSha256 === null
    ? undefined
    : requireSha256(record.packageSha256, `${field}.packageSha256`);
  const ownerUserId = optionalNullableString(record.ownerUserId, `${field}.ownerUserId`);
  const orgId = optionalNullableString(record.orgId, `${field}.orgId`);
  const workspaceId = optionalNullableString(record.workspaceId, `${field}.workspaceId`);
  const approved = optionalBoolean(record.approved, `${field}.approved`);
  const desiredVersionId = optionalNullableString(record.desiredVersionId, `${field}.desiredVersionId`);
  const desiredPackageSha256 = record.desiredPackageSha256 === undefined || record.desiredPackageSha256 === null
    ? optionalNullableString(record.desiredPackageSha256, `${field}.desiredPackageSha256`)
    : requireSha256(record.desiredPackageSha256, `${field}.desiredPackageSha256`);
  const installation: RegistrySkillInstallation = {
    installationId: requireString(record.installationId, `${field}.installationId`),
    skillId: requireString(record.skillId, `${field}.skillId`),
    versionId: requireString(record.versionId, `${field}.versionId`),
    enabled: requireBoolean(record.enabled, `${field}.enabled`),
    source: requireEnum(record.source, `${field}.source`, ["personal", "workspace", "organization", "platform"]),
    installedAt: requireIsoDateString(record.installedAt, `${field}.installedAt`),
  };
  if (updatedAt) installation.updatedAt = updatedAt;
  if (name) installation.name = name;
  if (packageSha256) installation.packageSha256 = packageSha256;
  if (ownerUserId !== undefined) installation.ownerUserId = ownerUserId;
  if (orgId !== undefined) installation.orgId = orgId;
  if (workspaceId !== undefined) installation.workspaceId = workspaceId;
  if (approved !== undefined) installation.approved = approved;
  if (desiredVersionId !== undefined) installation.desiredVersionId = desiredVersionId;
  if (desiredPackageSha256 !== undefined) installation.desiredPackageSha256 = desiredPackageSha256;
  return installation;
};

export function validateRegistrySkillInstallationResponse(value: unknown): RegistrySkillInstallationResponse {
  const record = requireRecord(value, "skill installation response");
  return {
    installation: validateInstallation(record.installation, "installation"),
  };
}

export function validateRegistrySkillInstallationsResponse(value: unknown): RegistrySkillInstallationsResponse {
  const record = requireRecord(value, "skill installations response");
  if (!Array.isArray(record.installations)) {
    throw new Error("Skill registry installations must be an array");
  }
  const seenInstallationIds = new Set<string>();
  const installations = record.installations.map((installation, index) => {
    const parsed = validateInstallation(installation, `installations[${index}]`);
    if (seenInstallationIds.has(parsed.installationId)) {
      throw new Error(`Skill registry installations contain duplicate installationId: ${parsed.installationId}`);
    }
    seenInstallationIds.add(parsed.installationId);
    return parsed;
  });
  return {
    installations,
    nextCursor: validatePaginatedCursor(record.nextCursor, "nextCursor"),
  };
}

const validateRolloutPolicy = (value: unknown, field: string): RegistrySkillRolloutPolicy => {
  const record = requireRecord(value, field);
  const orgId = optionalNullableString(record.orgId, `${field}.orgId`);
  const userId = optionalNullableString(record.userId, `${field}.userId`);
  const workspaceId = optionalNullableString(record.workspaceId, `${field}.workspaceId`);
  const releaseChannel = optionalNullableString(record.releaseChannel, `${field}.releaseChannel`);
  const updatedAt = record.updatedAt === undefined ? undefined : requireIsoDateString(record.updatedAt, `${field}.updatedAt`);
  const policy: RegistrySkillRolloutPolicy = {
    id: requireString(record.id, `${field}.id`),
    skillId: requireString(record.skillId, `${field}.skillId`),
    versionId: requireNullableString(record.versionId, `${field}.versionId`),
    target: requireEnum(record.target, `${field}.target`, ["user-global", "workspace"]),
    audience: requireEnum(record.audience, `${field}.audience`, [
      "user",
      "selected-workspaces",
      "all-org-users",
      "all-platform-users",
    ]),
    catalogScope: requireEnum(record.catalogScope, `${field}.catalogScope`, ["organization", "platform"]),
    enabled: requireBoolean(record.enabled, `${field}.enabled`),
    updatePolicy: requireEnum(record.updatePolicy, `${field}.updatePolicy`, [
      "pinned",
      "latest_user",
      "latest_approved",
      "release_channel",
    ]),
    removalPolicy: requireEnum(record.removalPolicy, `${field}.removalPolicy`, [
      "user_removable",
      "admin_removable",
      "locked",
    ]),
    createdAt: requireIsoDateString(record.createdAt, `${field}.createdAt`),
  };
  if (orgId !== undefined) policy.orgId = orgId;
  if (userId !== undefined) policy.userId = userId;
  if (workspaceId !== undefined) policy.workspaceId = workspaceId;
  if (releaseChannel !== undefined) policy.releaseChannel = releaseChannel;
  if (updatedAt) policy.updatedAt = updatedAt;
  return policy;
};

export function validateRegistrySkillRolloutPolicyResponse(value: unknown): RegistrySkillRolloutPolicyResponse {
  const record = requireRecord(value, "skill rollout policy response");
  return {
    policy: validateRolloutPolicy(record.policy, "policy"),
  };
}

export function validateRegistrySkillRolloutPoliciesResponse(value: unknown): RegistrySkillRolloutPoliciesResponse {
  const record = requireRecord(value, "skill rollout policies response");
  if (!Array.isArray(record.policies)) {
    throw new Error("Skill registry rollout policies must be an array");
  }
  const seenPolicyIds = new Set<string>();
  const policies = record.policies.map((policy, index) => {
    const parsed = validateRolloutPolicy(policy, `policies[${index}]`);
    if (seenPolicyIds.has(parsed.id)) {
      throw new Error(`Skill registry rollout policies contain duplicate policy id: ${parsed.id}`);
    }
    seenPolicyIds.add(parsed.id);
    return parsed;
  });
  return {
    policies,
    nextCursor: validatePaginatedCursor(record.nextCursor, "nextCursor"),
  };
}

export function validateWorkspaceSkillSetResponse(value: unknown): WorkspaceSkillSetResponse {
  const record = requireRecord(value, "workspace skill set response");
  if (!Array.isArray(record.skills)) {
    throw new Error("Skill registry workspace skill set skills must be an array");
  }
  const seenSkillIds = new Set<string>();
  const skills = record.skills.map((skill, index) => {
    const installation = validateInstallation(skill, `skills[${index}]`);
    if (seenSkillIds.has(installation.skillId)) {
      throw new Error(`Skill registry workspace skill set contains duplicate skillId: ${installation.skillId}`);
    }
    seenSkillIds.add(installation.skillId);
    return installation;
  });
  return {
    workspaceId: requireString(record.workspaceId, "workspaceId"),
    skillSetId: optionalString(record.skillSetId, "skillSetId"),
    revision: optionalString(record.revision, "revision"),
    skills,
  };
}

export function validateRegistrySkillReviewRequestResponse(value: unknown): RegistrySkillReviewRequestResponse {
  const record = requireRecord(value, "skill review request response");
  const updatedAt = record.updatedAt === undefined ? undefined : requireIsoDateString(record.updatedAt, "updatedAt");
  const response: RegistrySkillReviewRequestResponse = {
    requestId: requireString(record.requestId, "requestId"),
    skillId: requireString(record.skillId, "skillId"),
    status: requireEnum(record.status, "status", ["pending_review", "approved", "rejected"]),
    createdAt: requireIsoDateString(record.createdAt, "createdAt"),
  };
  if (updatedAt) response.updatedAt = updatedAt;
  return response;
}

export function validateRegistrySkillSearchResponse(value: unknown): RegistrySkillSearchResponse {
  const record = requireRecord(value, "skill search response");
  const list = validateRegistrySkillListResponse(record);
  return {
    ...list,
    query: requireString(record.query, "query"),
  };
}

const validateRegistrySkillEvent = (value: unknown, field: string): RegistrySkillEvent => {
  const record = requireRecord(value, field);
  const event: RegistrySkillEvent = {
    id: requireString(record.id, `${field}.id`),
    action: requireString(record.action, `${field}.action`),
    createdAt: requireIsoDateString(record.createdAt, `${field}.createdAt`),
  };

  const orgId = optionalNullableString(record.orgId, `${field}.orgId`);
  const workspaceId = optionalNullableString(record.workspaceId, `${field}.workspaceId`);
  const skillId = optionalNullableString(record.skillId, `${field}.skillId`);
  const versionId = optionalNullableString(record.versionId, `${field}.versionId`);
  const installationId = optionalNullableString(record.installationId, `${field}.installationId`);
  const actorUserId = optionalNullableString(record.actorUserId, `${field}.actorUserId`);
  if (orgId !== undefined) event.orgId = orgId;
  if (workspaceId !== undefined) event.workspaceId = workspaceId;
  if (skillId !== undefined) event.skillId = skillId;
  if (versionId !== undefined) event.versionId = versionId;
  if (installationId !== undefined) event.installationId = installationId;
  if (actorUserId !== undefined) event.actorUserId = actorUserId;
  if (Object.prototype.hasOwnProperty.call(record, "payload")) event.payload = record.payload;
  return event;
};

export function validateRegistrySkillEventsResponse(value: unknown): RegistrySkillEventsResponse {
  const record = requireRecord(value, "skill registry events response");
  if (!Array.isArray(record.events)) {
    throw new Error("Skill registry events must be an array");
  }
  const revision = validatePaginatedCursor(record.revision, "revision");
  return {
    events: record.events.map((event, index) => validateRegistrySkillEvent(event, `events[${index}]`)),
    nextCursor: validatePaginatedCursor(record.nextCursor, "nextCursor"),
    revision,
  };
}
