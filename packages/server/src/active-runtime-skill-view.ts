import { createHash } from "node:crypto";
import { readdir, readFile, rm, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { ApiError } from "./errors.js";
import { recordSkillAudit } from "./skill-audit-trace.js";
import {
  allowRuntimeSkillAuthorization,
  isRuntimeSkillAuthorizationFenced,
} from "./runtime-skill-revocation-fence.js";
import {
  resolveActiveWorkspaceSkills,
  writeEffectiveSkillManifest,
  type ListSkillsOptions,
} from "./skills.js";
import type { SkillItem, WorkspaceInfo } from "./types.js";

const RUNTIME_VIEW_CONTRACT_VERSION = "active-runtime-skill-view/v1";

// These values are part of the direct-launch protocol. A missing durable
// manifest is still an explicit, verifiable empty binding rather than an
// unbound launch that happens to have no paths.
export const EMPTY_SERVING_RUNTIME_SKILL_VIEW_REVISION = "empty-direct-skill-view/v1";
export const EMPTY_SERVING_RUNTIME_AUTHORIZATION_REVISION = "empty-direct-skill-authorization/v1";

export type ActiveRuntimeSkillView = {
  workspaceId: string;
  workspaceRoot: string;
  revision: string;
  authorizationRevision: string;
  generatedAt: string;
  sourceFingerprint: string;
  manifestPath: string;
  skills: SkillItem[];
  /** Internal compare-and-swap token captured before candidate discovery. */
  validationGeneration?: number;
  /** Local fence store used to authorize this exact validated promotion. */
  revocationDataDir?: string;
};

/**
 * The minimal binding an ordinary runtime send needs. Reading it must never
 * discover sources, rewrite the manifest, or wait for a fresh Skills view.
 */
export type ServingRuntimeSkillBinding = Pick<
  ActiveRuntimeSkillView,
  "revision" | "authorizationRevision"
>;

export const EMPTY_SERVING_RUNTIME_SKILL_BINDING: ServingRuntimeSkillBinding = {
  revision: EMPTY_SERVING_RUNTIME_SKILL_VIEW_REVISION,
  authorizationRevision: EMPTY_SERVING_RUNTIME_AUTHORIZATION_REVISION,
};

export type ServingRuntimeSkillSummary = ServingRuntimeSkillBinding & {
  generatedAt: string;
  activeCount: number;
  items: SkillItem[];
};

type RuntimeOptions = Omit<ListSkillsOptions, "includeGlobal" | "globalOwner" | "includeDisabled">;
export type PrepareRuntimeSkillCandidateOptions = RuntimeOptions;

const cache = new Map<string, ActiveRuntimeSkillView>();
const generations = new Map<string, number>();
const publicationQueues = new Map<string, Promise<void>>();
let beforePublicationForTests: (() => Promise<void>) | null = null;

function cacheKey(workspaceId: string, workspaceRoot: string): string {
  return `${workspaceId}\u0000${resolve(workspaceRoot)}`;
}

function generationFor(key: string): number {
  return generations.get(key) ?? 0;
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

/**
 * Metadata signature of everything under a skill, not just its entrypoint.
 *
 * The orchestrator stages the whole skill directory, so a revision derived from
 * `SKILL.md` alone would call a view unchanged after an edit to a nested script
 * or schema — and the engine would then be launched against content nobody
 * agreed to. Metadata only: the entrypoint keeps its content hash, while nested
 * files are compared by size and mtime so resolving a view stays cheap.
 */
async function nestedSourceSignature(skillDir: string): Promise<string | null> {
  const entries: string[] = [];
  const walk = async (current: string, prefix: string): Promise<void> => {
    const listing = await readdir(current, { withFileTypes: true });
    listing.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of listing) {
      const absolute = join(current, entry.name);
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        entries.push(`d ${relative}`);
        await walk(absolute, relative);
        continue;
      }
      const info = await stat(absolute);
      entries.push(`f ${relative} ${info.size} ${info.mtimeMs}`);
    }
  };
  try {
    await walk(skillDir, "");
  } catch {
    return null;
  }
  return createHash("sha256").update(entries.join("\n")).digest("hex");
}

async function sourceFingerprint(
  workspace: WorkspaceInfo,
  skills: SkillItem[],
  options: RuntimeOptions,
): Promise<string> {
  const entries = await Promise.all(skills.map(async (skill) => {
    try {
      const metadata = await stat(skill.path);
      const contentHash = createHash("sha256").update(await readFile(skill.path)).digest("hex");
      return {
        name: skill.name,
        path: resolve(skill.path),
        size: metadata.size,
        mtimeMs: metadata.mtimeMs,
        contentHash,
        treeHash: await nestedSourceSignature(dirname(resolve(skill.path))),
        enabled: skill.enabled !== false,
        source: skill.registry?.source ?? null,
        removalPolicy: skill.registry?.removalPolicy ?? null,
      };
    } catch {
      return { name: skill.name, path: resolve(skill.path), missing: true };
    }
  }));
  const disabled = (options.disabledSkills ?? []).map((record) => ({
    name: record.name,
    path: record.path ?? null,
    scope: record.scope,
    workspaceId: record.workspaceId ?? null,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return digest({
    contract: RUNTIME_VIEW_CONTRACT_VERSION,
    workspaceId: workspace.id,
    workspaceRoot: resolve(workspace.path),
    entries: entries.sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path)),
    disabled,
  });
}

function authorizationRevision(
  workspace: WorkspaceInfo,
  skills: SkillItem[],
  options: RuntimeOptions,
): string {
  const disabled = (options.disabledSkills ?? []).map((record) => ({
    name: record.name,
    path: record.path ?? null,
    scope: record.scope,
    workspaceId: record.workspaceId ?? null,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const entries = skills.map((skill) => ({
    name: skill.name,
    path: resolve(skill.path),
    source: skill.registry?.source ?? "workspace",
    removalPolicy: skill.registry?.removalPolicy ?? "user_removable",
  })).sort((left, right) => left.name.localeCompare(right.name) || left.path.localeCompare(right.path));
  return digest({
    contract: `${RUNTIME_VIEW_CONTRACT_VERSION}/authorization`,
    workspaceId: workspace.id,
    workspaceRoot: resolve(workspace.path),
    entries,
    disabled,
  });
}

/** Resolve a current management/command view without publishing engine state. */
export async function resolveActiveRuntimeSkillView(
  workspace: WorkspaceInfo,
  options: PrepareRuntimeSkillCandidateOptions = {},
): Promise<ActiveRuntimeSkillView> {
  const skills = await resolveActiveWorkspaceSkills(workspace.path, {
    ...options,
    includeDisabled: false,
  });
  const fingerprint = await sourceFingerprint(workspace, skills, options);
  const revision = digest({
    contract: RUNTIME_VIEW_CONTRACT_VERSION,
    workspaceId: workspace.id,
    workspaceRoot: resolve(workspace.path),
    sourceFingerprint: fingerprint,
  });
  return {
    workspaceId: workspace.id,
    workspaceRoot: resolve(workspace.path),
    revision,
    authorizationRevision: authorizationRevision(workspace, skills, options),
    generatedAt: new Date().toISOString(),
    sourceFingerprint: fingerprint,
    manifestPath: resolve(workspace.path, ".opencode", "veslo.runtime.skills.json"),
    skills,
  };
}

/**
 * Materialize a candidate beside the serving manifest without changing the
 * durable last-known-good binding. The orchestrator receives this exact path
 * for validation and replacement; only a successful reload may promote it.
 */
export async function prepareRuntimeSkillCandidate(
  workspace: WorkspaceInfo,
  options: PrepareRuntimeSkillCandidateOptions = {},
): Promise<ActiveRuntimeSkillView> {
  const startedAt = Date.now();
  const key = cacheKey(workspace.id, workspace.path);
  const validationGeneration = generationFor(key);
  const resolvedView = await resolveActiveRuntimeSkillView(workspace, options);
  if (validationGeneration !== generationFor(key)) {
    throw new ApiError(409, "candidate_superseded", "Runtime skill candidate was superseded during discovery");
  }
  const manifestPath = resolve(
    workspace.path,
    ".opencode",
    `veslo.runtime.skills.candidate.${resolvedView.revision}.json`,
  );
  await writeEffectiveSkillManifest(workspace.path, resolvedView.skills, resolvedView.revision, {
    authorizationRevision: resolvedView.authorizationRevision,
    manifestPath,
  });
  const view: ActiveRuntimeSkillView = {
    ...resolvedView,
    manifestPath,
    validationGeneration,
    ...(options.dataDir ? { revocationDataDir: options.dataDir } : {}),
  };
  recordSkillAudit("active-runtime-view-candidate-prepared", {
    workspaceId: workspace.id,
    revision: view.revision,
    activeCount: view.skills.length,
    // Preparation walks every skill tree to fingerprint it. Most candidates are
    // never promoted, so this is the cost of work that is usually discarded.
    durationMs: Date.now() - startedAt,
    generation: validationGeneration,
  });
  return view;
}

/** Promote an already validated candidate to the sole durable serving view. */
export async function publishValidatedRuntimeSkillCandidate(
  candidate: ActiveRuntimeSkillView,
): Promise<void> {
  const key = cacheKey(candidate.workspaceId, candidate.workspaceRoot);
  await beforePublicationForTests?.();
  const previousPublication = publicationQueues.get(key) ?? Promise.resolve();
  const publication = previousPublication.catch(() => undefined).then(async () => {
    const expectedGeneration = candidate.validationGeneration;
    const assertCurrent = () => {
      if (
        typeof expectedGeneration !== "number" ||
        expectedGeneration !== generationFor(key)
      ) {
        throw new ApiError(409, "candidate_superseded", "Runtime skill candidate is no longer current");
      }
    };
    assertCurrent();
    await writeEffectiveSkillManifest(candidate.workspaceRoot, candidate.skills, candidate.revision, {
      authorizationRevision: candidate.authorizationRevision,
      commitGuard: assertCurrent,
    });
    await allowRuntimeSkillAuthorization({
      ...(candidate.revocationDataDir ? { dataDir: candidate.revocationDataDir } : {}),
      workspaceId: candidate.workspaceId,
      authorizationRevision: candidate.authorizationRevision,
      commitGuard: assertCurrent,
    });
    if (expectedGeneration === generationFor(key)) {
      cache.set(key, {
        ...candidate,
        manifestPath: resolve(candidate.workspaceRoot, ".opencode", "veslo.runtime.skills.json"),
      });
    }
    recordSkillAudit("active-runtime-view-promoted", {
      workspaceId: candidate.workspaceId,
      revision: candidate.revision,
      activeCount: candidate.skills.length,
    });
  });
  const publicationQueue = publication.then(() => undefined, () => undefined);
  publicationQueues.set(key, publicationQueue);
  let promoted = false;
  try {
    await publication;
    promoted = true;
  } finally {
    if (publicationQueues.get(key) === publicationQueue) publicationQueues.delete(key);
    if (promoted) {
      await removeRuntimeSkillCandidateSidecar(
        candidate,
        "active-runtime-view-candidate-cleaned",
        "published_cleanup",
      );
    } else {
      await discardRuntimeSkillCandidate(candidate);
    }
  }
}

/** Candidate sidecars are transient validation inputs, never durable state. */
export async function discardRuntimeSkillCandidate(
  candidate: Pick<ActiveRuntimeSkillView, "manifestPath" | "workspaceRoot"> &
    Partial<Pick<ActiveRuntimeSkillView, "workspaceId" | "revision">>,
): Promise<void> {
  await removeRuntimeSkillCandidateSidecar(
    candidate,
    "active-runtime-view-candidate-discarded",
    "not_promoted",
  );
}

async function removeRuntimeSkillCandidateSidecar(
  candidate: Pick<ActiveRuntimeSkillView, "manifestPath" | "workspaceRoot"> &
    Partial<Pick<ActiveRuntimeSkillView, "workspaceId" | "revision">>,
  event:
    | "active-runtime-view-candidate-cleaned"
    | "active-runtime-view-candidate-discarded",
  reason: "published_cleanup" | "not_promoted",
): Promise<void> {
  const servingPath = resolve(candidate.workspaceRoot, ".opencode", "veslo.runtime.skills.json");
  if (resolve(candidate.manifestPath) === servingPath) return;
  await rm(candidate.manifestPath, { force: true }).catch(() => undefined);
  recordSkillAudit(event, {
    workspaceId: candidate.workspaceId ?? null,
    revision: candidate.revision ?? null,
    reason,
  });
}

/**
 * Return the last successfully published runtime binding without making Skills
 * control-plane work part of the send path. The manifest is deliberately the
 * durable fallback when this process no longer has the in-memory view.
 */
export async function readServingRuntimeSkillBinding(
  workspace: Pick<WorkspaceInfo, "id" | "path">,
  options: { dataDir?: string; bypassCache?: boolean } = {},
): Promise<ServingRuntimeSkillBinding | null> {
  const cached = options.bypassCache ? undefined : cache.get(cacheKey(workspace.id, workspace.path));
  if (cached) {
    if (await isRuntimeSkillAuthorizationFenced({
      dataDir: options.dataDir,
      workspaceId: workspace.id,
      authorizationRevision: cached.authorizationRevision,
    })) return null;
    return {
      revision: cached.revision,
      authorizationRevision: cached.authorizationRevision,
    };
  }
  try {
    const manifestPath = resolve(workspace.path, ".opencode", "veslo.runtime.skills.json");
    const parsed = JSON.parse(await readFile(manifestPath, "utf8")) as {
      schemaVersion?: unknown;
      workspaceRoot?: unknown;
      revision?: unknown;
      authorizationRevision?: unknown;
    };
    if (
      (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) ||
      typeof parsed.workspaceRoot !== "string" ||
      resolve(parsed.workspaceRoot) !== resolve(workspace.path) ||
      typeof parsed.revision !== "string" ||
      !parsed.revision ||
      typeof parsed.authorizationRevision !== "string" ||
      !parsed.authorizationRevision
    ) return null;
    const binding = {
      revision: parsed.revision,
      authorizationRevision: parsed.authorizationRevision,
    };
    if (await isRuntimeSkillAuthorizationFenced({
      dataDir: options.dataDir,
      workspaceId: workspace.id,
      authorizationRevision: binding.authorizationRevision,
    })) return null;
    return binding;
  } catch {
    return null;
  }
}

/** Read serving metadata for app preflight without resolving live sources. */
export async function readServingRuntimeSkillSummary(
  workspace: Pick<WorkspaceInfo, "id" | "path">,
  options: { dataDir?: string; bypassCache?: boolean } = {},
): Promise<ServingRuntimeSkillSummary | null> {
  const cached = options.bypassCache ? undefined : cache.get(cacheKey(workspace.id, workspace.path));
  if (cached) {
    if (await isRuntimeSkillAuthorizationFenced({
      dataDir: options.dataDir,
      workspaceId: workspace.id,
      authorizationRevision: cached.authorizationRevision,
    })) return null;
    return {
      revision: cached.revision,
      authorizationRevision: cached.authorizationRevision,
      generatedAt: cached.generatedAt,
      activeCount: cached.skills.length,
      items: cached.skills,
    };
  }
  try {
    const parsed = JSON.parse(
      await readFile(resolve(workspace.path, ".opencode", "veslo.runtime.skills.json"), "utf8"),
    ) as {
      schemaVersion?: unknown;
      generatedAt?: unknown;
      workspaceRoot?: unknown;
      revision?: unknown;
      authorizationRevision?: unknown;
      entries?: unknown;
    };
    if (
      (parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2 && parsed.schemaVersion !== 3) ||
      typeof parsed.workspaceRoot !== "string" ||
      resolve(parsed.workspaceRoot) !== resolve(workspace.path) ||
      typeof parsed.revision !== "string" ||
      !parsed.revision ||
      typeof parsed.authorizationRevision !== "string" ||
      !parsed.authorizationRevision ||
      !Array.isArray(parsed.entries)
    ) return null;
    if (await isRuntimeSkillAuthorizationFenced({
      dataDir: options.dataDir,
      workspaceId: workspace.id,
      authorizationRevision: parsed.authorizationRevision,
    })) return null;
    return {
      revision: parsed.revision,
      authorizationRevision: parsed.authorizationRevision,
      generatedAt: typeof parsed.generatedAt === "string" ? parsed.generatedAt : new Date(0).toISOString(),
      activeCount: parsed.entries.length,
      // A persisted manifest intentionally contains only launch policy. Do not
      // reread mutable source files merely to decorate an app preflight.
      items: [],
    };
  } catch {
    return null;
  }
}

/**
 * Why a serving view was dropped. Without it an invalidation burst is
 * indistinguishable from a single change, and attributing one means correlating
 * timestamps against another process's trace by hand.
 */
export type RuntimeSkillViewInvalidationReason =
  | "workspace-activate"
  | "workspace-config-patch"
  | "workspace-import"
  | "workspace-provision"
  | "skill-enabled-state"
  | "skill-materialization"
  | "skill-removal"
  | "skill-restore"
  | "user-global-skills"
  | "runtime-prepare"
  | "source-watcher"
  | "skill-view-conflict"
  | "unspecified";

export function invalidateActiveRuntimeSkillView(
  workspace: Pick<WorkspaceInfo, "id" | "path">,
  reason: RuntimeSkillViewInvalidationReason = "unspecified",
): void {
  const key = cacheKey(workspace.id, workspace.path);
  const hadCachedView = cache.delete(key);
  const generation = generationFor(key) + 1;
  generations.set(key, generation);
  recordSkillAudit("active-runtime-view-invalidated", {
    workspaceId: workspace.id,
    reason,
    // The generation makes a burst countable, and pairs an invalidation with
    // the candidate it supersedes.
    generation,
    hadCachedView,
  });
}

export function evictActiveRuntimeSkillView(workspaceId: string, workspaceRoot: string): void {
  const key = cacheKey(workspaceId, workspaceRoot);
  cache.delete(key);
  generations.set(key, generationFor(key) + 1);
}

/** Test-only state reset; production invalidation is always workspace scoped. */
export function resetActiveRuntimeSkillViewsForTests(): void {
  cache.clear();
  generations.clear();
  publicationQueues.clear();
  beforePublicationForTests = null;
}

/** Test-only deterministic barrier for invalidation/publication races. */
export function setActiveRuntimeSkillViewBeforePublicationForTests(
  callback: (() => Promise<void>) | null,
): void {
  beforePublicationForTests = callback;
}
