import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";

import { ApiError } from "./errors.js";
import { recordSkillAudit } from "./skill-audit-trace.js";
import {
  resolveActiveWorkspaceSkills,
  writeEffectiveSkillManifest,
  type ListSkillsOptions,
} from "./skills.js";
import type { SkillItem, WorkspaceInfo } from "./types.js";

const RUNTIME_VIEW_CONTRACT_VERSION = "active-runtime-skill-view/v1";
const MANUAL_EDIT_TTL_MS = 5_000;

export type ActiveRuntimeSkillView = {
  workspaceId: string;
  workspaceRoot: string;
  revision: string;
  generatedAt: string;
  sourceFingerprint: string;
  manifestPath: string;
  skills: SkillItem[];
};

type RuntimeOptions = Omit<ListSkillsOptions, "includeGlobal" | "globalOwner" | "includeDisabled">;
type CacheEntry = ActiveRuntimeSkillView & { expiresAt: number };
type Flight = { generation: number; promise: Promise<ActiveRuntimeSkillView | null> };

const cache = new Map<string, CacheEntry>();
const flights = new Map<string, Flight>();
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

function assertExpectedRevision(view: ActiveRuntimeSkillView, expectedRevision?: string): ActiveRuntimeSkillView {
  if (expectedRevision && expectedRevision !== view.revision) {
    throw new ApiError(409, "skill_view_stale", "The active runtime skill view is stale", {
      expectedRevision,
      actualRevision: view.revision,
    });
  }
  return view;
}

export async function ensureActiveRuntimeSkillView(
  workspace: WorkspaceInfo,
  options: RuntimeOptions & { expectedRevision?: string } = {},
): Promise<ActiveRuntimeSkillView> {
  const key = cacheKey(workspace.id, workspace.path);
  for (;;) {
    const generation = generationFor(key);
    const now = Date.now();
    const existing = cache.get(key);
    if (existing && existing.expiresAt > now) {
      recordSkillAudit("active-runtime-view-cache-hit", {
        workspaceId: workspace.id,
        revision: existing.revision,
        activeCount: existing.skills.length,
      });
      return assertExpectedRevision(existing, options.expectedRevision);
    }

    const pending = flights.get(key);
    if (pending?.generation === generation) {
      const view = await pending.promise;
      if (view) return assertExpectedRevision(view, options.expectedRevision);
      continue;
    }

    const flight: Flight = {
      generation,
      promise: (async (): Promise<ActiveRuntimeSkillView | null> => {
        // A runtime snapshot is engine-visible state. Disabled entries are never
        // included merely because a management caller requested them for UI.
        const skills = await resolveActiveWorkspaceSkills(workspace.path, { ...options, includeDisabled: false });
        const fingerprint = await sourceFingerprint(workspace, skills, options);
        const revision = digest({
          contract: RUNTIME_VIEW_CONTRACT_VERSION,
          workspaceId: workspace.id,
          workspaceRoot: resolve(workspace.path),
          sourceFingerprint: fingerprint,
        });
        const view: CacheEntry = {
          workspaceId: workspace.id,
          workspaceRoot: resolve(workspace.path),
          revision,
          generatedAt: new Date().toISOString(),
          sourceFingerprint: fingerprint,
          manifestPath: resolve(workspace.path, ".opencode", "veslo.runtime.skills.json"),
          skills,
          expiresAt: Date.now() + MANUAL_EDIT_TTL_MS,
        };
        await beforePublicationForTests?.();

        // Publication is serialized separately from discovery. This prevents an
        // invalidated, older flight from renaming its manifest over a newer one.
        const previousPublication = publicationQueues.get(key) ?? Promise.resolve();
        const publication = previousPublication.catch(() => undefined).then(async () => {
          if (generation !== generationFor(key)) return null;
          await writeEffectiveSkillManifest(workspace.path, skills, revision);
          if (generation !== generationFor(key)) return null;
          cache.set(key, view);
          recordSkillAudit("active-runtime-view-published", {
            workspaceId: workspace.id,
            revision,
            activeCount: skills.length,
          });
          return view;
        });
        const publicationQueue = publication.then(() => undefined, () => undefined);
        publicationQueues.set(key, publicationQueue);
        try {
          return await publication;
        } finally {
          if (publicationQueues.get(key) === publicationQueue) publicationQueues.delete(key);
        }
      })(),
    };
    flights.set(key, flight);
    try {
      const view = await flight.promise;
      if (view) return assertExpectedRevision(view, options.expectedRevision);
    } finally {
      if (flights.get(key) === flight) flights.delete(key);
    }
  }
}

export function invalidateActiveRuntimeSkillView(workspace: Pick<WorkspaceInfo, "id" | "path">): void {
  const key = cacheKey(workspace.id, workspace.path);
  cache.delete(key);
  generations.set(key, generationFor(key) + 1);
  recordSkillAudit("active-runtime-view-invalidated", { workspaceId: workspace.id });
}

export function evictActiveRuntimeSkillView(workspaceId: string, workspaceRoot: string): void {
  const key = cacheKey(workspaceId, workspaceRoot);
  cache.delete(key);
  generations.set(key, generationFor(key) + 1);
}

/** Test-only state reset; production invalidation is always workspace scoped. */
export function resetActiveRuntimeSkillViewsForTests(): void {
  cache.clear();
  flights.clear();
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
