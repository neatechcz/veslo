import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

const ENTRYPOINT = "SKILL.md";
const MARKER = ".veslo-managed.json";
const STAGING_MANIFEST = ".veslo-engine-skill-staging.json";
const GENERATION_RECORD = ".veslo-engine-skill-generation.json";
const STAGING_LOCK_DIR = ".lock";
const STAGING_LOCK_OWNER = "owner.json";
const GENERATION_RETENTION = 3;
const STAGING_LOCK_WAIT_MS = 50;
const STAGING_LOCK_TIMEOUT_MS = 15_000;
const ORPHAN_GENERATION_RECOVERY_MS = 30_000;
const PROCESS_INSTANCE_ID = randomUUID();
const PROCESS_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000);

type GenerationState = "preparing" | "ready" | "leased" | "released";

type GenerationRecord = {
  schemaVersion: 1;
  operationId: string;
  generationRoot: string;
  state: GenerationState;
  engineOwnerId: string;
  processId: number;
  processInstanceId: string;
  processStartedAt: number;
  childPid?: number;
  updatedAt: string;
};

export type EngineSkillGenerationLease = {
  stagingRoot: string;
  generationRoot: string;
  operationId: string;
  engineOwnerId: string;
};

export class SkillViewChangedError extends Error {
  readonly code = "skill_view_changed";
  readonly retryable = true;
  readonly skillName: string;

  constructor(skillName: string) {
    super(`skill_view_changed: source for ${skillName} changed during staging`);
    this.name = "SkillViewChangedError";
    this.skillName = skillName;
  }
}

/**
 * A generation is not safe to clean up until the operation that created it
 * has finished consuming it.  Keep staging and cleanup single-flight per
 * root so a concurrent activation/refresh cannot remove another operation's
 * source tree between stageEngineSkillView() and its next copy.
 */
const stagingRootQueues = new Map<string, Promise<void>>();

type StagingLockOwner = {
  schemaVersion: 1;
  token: string;
  processId: number;
  processInstanceId: string;
  processStartedAt: number;
  stagingOperationId: string;
  acquiredAt: string;
  heartbeatAt: string;
};

const delay = (ms: number): Promise<void> => new Promise((resolveDelay) => setTimeout(resolveDelay, ms));

function processIsAlive(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function readLockOwner(lockDir: string): Promise<StagingLockOwner | null> {
  try {
    const parsed = JSON.parse(await readFile(join(lockDir, STAGING_LOCK_OWNER), "utf8")) as StagingLockOwner;
    if (parsed.schemaVersion !== 1 || typeof parsed.token !== "string" || !Number.isInteger(parsed.processId)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

async function recoverDeadFilesystemLock(
  lockDir: string,
  observedOwner: StagingLockOwner,
): Promise<boolean> {
  const recoveryDir = join(lockDir, ".recovery");
  try {
    await mkdir(recoveryDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    return false;
  }

  let removed = false;
  try {
    const current = await readLockOwner(lockDir);
    if (
      !current ||
      current.token !== observedOwner.token ||
      current.processInstanceId !== observedOwner.processInstanceId ||
      processIsAlive(current.processId)
    ) {
      return false;
    }
    await rm(lockDir, { recursive: true, force: true });
    removed = true;
    return true;
  } finally {
    if (!removed) await rm(recoveryDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function acquireFilesystemLock(stagingRoot: string): Promise<() => Promise<void>> {
  const lockDir = join(stagingRoot, STAGING_LOCK_DIR);
  const token = randomUUID();
  const deadline = Date.now() + STAGING_LOCK_TIMEOUT_MS;
  const owner: StagingLockOwner = {
    schemaVersion: 1,
    token,
    processId: process.pid,
    processInstanceId: PROCESS_INSTANCE_ID,
    processStartedAt: PROCESS_STARTED_AT,
    stagingOperationId: randomUUID(),
    acquiredAt: new Date().toISOString(),
    heartbeatAt: new Date().toISOString(),
  };

  for (;;) {
    let created = false;
    try {
      await mkdir(lockDir);
      created = true;
      await writeFile(join(lockDir, STAGING_LOCK_OWNER), `${JSON.stringify(owner)}\n`, "utf8");
      return async () => {
        const current = await readLockOwner(lockDir);
        if (current?.token === token) await rm(lockDir, { recursive: true, force: true });
      };
    } catch (error) {
      if (created) await rm(lockDir, { recursive: true, force: true }).catch(() => undefined);
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "ENOTEMPTY") throw error;

      const current = await readLockOwner(lockDir);
      if (current && !processIsAlive(current.processId) && await recoverDeadFilesystemLock(lockDir, current)) {
        continue;
      }
      if (Date.now() >= deadline) throw new Error("skill_staging_busy: another orchestrator owns the staging lock");
      await delay(STAGING_LOCK_WAIT_MS);
    }
  }
}

async function withStagingRootLock<T>(stagingRoot: string, operation: () => Promise<T>): Promise<T> {
  const key = resolve(stagingRoot).toLowerCase();
  const previous = stagingRootQueues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(async () => {
    await mkdir(resolve(stagingRoot), { recursive: true });
    const release = await acquireFilesystemLock(resolve(stagingRoot));
    try {
      return await operation();
    } finally {
      await release();
    }
  });
  const settled = current.then(() => undefined, () => undefined);
  stagingRootQueues.set(key, settled);
  try {
    return await current;
  } finally {
    if (stagingRootQueues.get(key) === settled) stagingRootQueues.delete(key);
  }
}

type Candidate = {
  name: string;
  sourceDir: string;
  className: "workspace-local" | "user-imported" | "policy-enforced";
  removalPolicy: "locked" | "user_removable";
  sourcePath: string;
};

type EffectiveSkillManifest = {
  schemaVersion: 1 | 2;
  workspaceRoot: string;
  revision?: string;
  entries: Array<{
    name: string;
    path: string;
    source: Candidate["className"];
    removalPolicy?: Candidate["removalPolicy"];
  }>;
};

export type EngineSkillStagingResult = {
  stagingRoot: string;
  source: "effective-manifest" | "fail-closed-no-manifest" | "legacy-discovery";
  materialized: string[];
  materializedDetails: Array<{ name: string; sourcePath: string; className: Candidate["className"] }>;
  suppressed: Array<{ name: string; reason: string }>;
  generationLease?: EngineSkillGenerationLease;
};

export type DirectorySkillViewPublishResult = EngineSkillStagingResult & {
  /**
   * Stable workspace-local root consumed through a relative `skills.paths`
   * entry by a directory-scoped OpenCode instance.
   */
  runtimeRoot: string;
  skillViewRevision: string;
};

type DirectorySkillViewSwapDeps = {
  renamePath?: typeof rename;
  removePath?: typeof rm;
};

/**
 * Promotes a pending workspace-local skill root. If final promotion fails and
 * restoration fails too, the previous root is deliberately retained for
 * recovery instead of being deleted by best-effort cleanup.
 */
export async function promoteDirectorySkillView(
  input: { runtimeRoot: string; pendingRoot: string; previousRoot: string },
  deps: DirectorySkillViewSwapDeps = {},
): Promise<void> {
  const renamePath = deps.renamePath ?? rename;
  const removePath = deps.removePath ?? rm;
  let previousExists = false;
  try {
    try {
      await renamePath(input.runtimeRoot, input.previousRoot);
      previousExists = true;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") throw error;
    }
    try {
      await renamePath(input.pendingRoot, input.runtimeRoot);
    } catch (error) {
      if (previousExists) {
        try {
          await renamePath(input.previousRoot, input.runtimeRoot);
        } catch {
          // The previous root remains at previousRoot for recovery.
        }
      }
      throw error;
    }
    if (previousExists) await removePath(input.previousRoot, { recursive: true, force: true });
  } finally {
    await removePath(input.pendingRoot, { recursive: true, force: true });
  }
}

const isWithin = (root: string, target: string): boolean => {
  const value = relative(resolve(root), resolve(target));
  return value.length > 0 && !isAbsolute(value) && !value.startsWith("..") && !value.includes(`..${"\\"}`) && !value.includes(`../`);
};

async function readGenerationRecord(generationRoot: string): Promise<GenerationRecord | null> {
  try {
    const parsed = JSON.parse(await readFile(join(generationRoot, GENERATION_RECORD), "utf8")) as GenerationRecord;
    if (parsed.schemaVersion !== 1 || typeof parsed.operationId !== "string" || typeof parsed.engineOwnerId !== "string") return null;
    return parsed;
  } catch {
    return null;
  }
}

async function writeGenerationRecord(generationRoot: string, record: GenerationRecord): Promise<void> {
  const path = join(generationRoot, GENERATION_RECORD);
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  await rename(temporaryPath, path);
}

async function releaseEngineSkillGenerationUnlocked(lease: EngineSkillGenerationLease): Promise<void> {
  const record = await readGenerationRecord(lease.generationRoot);
  if (!record || record.operationId !== lease.operationId || record.engineOwnerId !== lease.engineOwnerId) return;
  await writeGenerationRecord(lease.generationRoot, {
    ...record,
    state: "released",
    childPid: undefined,
    updatedAt: new Date().toISOString(),
  });
}

export async function claimEngineSkillGeneration(lease: EngineSkillGenerationLease, childPid: number): Promise<void> {
  await withStagingRootLock(lease.stagingRoot, async () => {
    const record = await readGenerationRecord(lease.generationRoot);
    if (!record || record.operationId !== lease.operationId || record.engineOwnerId !== lease.engineOwnerId) {
      throw new Error("skill_generation_invalid: generation lease does not match");
    }
    if (record.state !== "ready") throw new Error(`skill_generation_invalid: generation is ${record.state}`);
    await writeGenerationRecord(lease.generationRoot, {
      ...record,
      state: "leased",
      childPid,
      updatedAt: new Date().toISOString(),
    });
  });
}

export async function releaseEngineSkillGeneration(lease: EngineSkillGenerationLease): Promise<void> {
  await withStagingRootLock(lease.stagingRoot, () => releaseEngineSkillGenerationUnlocked(lease));
}

async function cleanupStagingGenerations(stagingRoot: string, currentGeneration: string): Promise<void> {
  const generationsRoot = join(stagingRoot, "generations");
  let entries;
  try {
    entries = await readdir(generationsRoot, { withFileTypes: true });
  } catch {
    return;
  }
  const generations = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  const currentName = currentGeneration.split(/[\\/]/).pop() ?? "";
  const records = await Promise.all(generations.map(async (generation) => ({
    generation,
    record: await readGenerationRecord(join(generationsRoot, generation)),
  })));
  const released = records.filter(({ record }) => record?.state === "released");
  const keep = new Set([currentName, ...released.slice(0, GENERATION_RETENTION).map(({ generation }) => generation)]);
  const now = Date.now();
  const orphaned = records.filter(({ generation, record }) => {
    if (!record || record.state !== "leased" || !record.childPid || keep.has(generation)) return false;
    const updatedAt = Date.parse(record.updatedAt);
    if (!Number.isFinite(updatedAt) || now - updatedAt < ORPHAN_GENERATION_RECOVERY_MS) return false;
    const ownerIsDead = !processIsAlive(record.processId);
    const childIsDead = !processIsAlive(record.childPid);
    return ownerIsDead && childIsDead;
  });
  const deletable = [
    ...released.slice(GENERATION_RETENTION).filter(({ generation }) => !keep.has(generation)),
    ...orphaned,
  ];
  await Promise.all(deletable.map(({ generation }) => rm(join(generationsRoot, generation), { recursive: true, force: true })));
}

async function readEffectiveManifest(workspace: string): Promise<EffectiveSkillManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(join(workspace, ".opencode", "veslo.runtime.skills.json"), "utf8")) as EffectiveSkillManifest;
    if ((parsed.schemaVersion !== 1 && parsed.schemaVersion !== 2) || resolve(parsed.workspaceRoot) !== workspace || !Array.isArray(parsed.entries)) return null;
    return parsed;
  } catch {
    return null;
  }
}

async function discoverEffectiveManifestCandidates(
  workspace: string,
  manifest: EffectiveSkillManifest,
): Promise<{ candidates: Candidate[]; suppressed: EngineSkillStagingResult["suppressed"] }> {
  const candidates: Candidate[] = [];
  const suppressed: EngineSkillStagingResult["suppressed"] = [];
  const workspacePhysical = await realpath(workspace).catch(() => null);
  if (typeof workspacePhysical !== "string") return { candidates, suppressed: [{ name: "<manifest>", reason: "missing_source" }] };
  const authorizedWorkspaceRoot: string = workspacePhysical;
  const sourceRoots = [
    join(workspace, ".opencode", "skills"),
    join(workspace, ".claude", "skills"),
    join(workspace, ".agents", "skills"),
    join(workspace, ".agent", "skills"),
  ];
  const physicalRoots = (await Promise.all(sourceRoots.map((root) => realpath(root).catch(() => null))))
    .filter((root): root is string => root !== null && isWithin(authorizedWorkspaceRoot, root));
  for (const entry of manifest.entries) {
    const entryName = entry && typeof entry.name === "string" ? entry.name : "<invalid>";
    if (!entry || typeof entry.name !== "string" || typeof entry.path !== "string") {
      suppressed.push({ name: entryName, reason: "invalid_manifest" });
      continue;
    }
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(entry.name) || entry.name.length > 64) {
      suppressed.push({ name: entry.name, reason: "invalid_name" });
      continue;
    }
    if (!(["workspace-local", "user-imported", "policy-enforced"] as string[]).includes(entry.source)) {
      suppressed.push({ name: entry.name, reason: "invalid_manifest" });
      continue;
    }
    const sourcePath = resolve(entry.path);
    if (!isWithin(workspace, sourcePath) || sourcePath.toLowerCase().split(/[\\/]/).pop() !== ENTRYPOINT.toLowerCase()) {
      suppressed.push({ name: entry.name, reason: "outside_authorized_root" });
      continue;
    }
    const physicalSourcePath = await realpath(sourcePath).catch(() => null);
    const physicalSourceDir = physicalSourcePath ? await realpath(dirname(physicalSourcePath)).catch(() => null) : null;
    if (!physicalSourcePath || !physicalSourceDir) {
      suppressed.push({ name: entry.name, reason: "missing_source" });
      continue;
    }
    if (!physicalRoots.some((root) => isWithin(root, physicalSourceDir) && isWithin(root, physicalSourcePath))) {
      suppressed.push({ name: entry.name, reason: "symlink_escape" });
      continue;
    }
    try {
      await readFile(physicalSourcePath, "utf8");
    } catch {
      suppressed.push({ name: entry.name, reason: "missing_source" });
      continue;
    }
    candidates.push({
      name: entry.name,
      sourceDir: physicalSourceDir,
      sourcePath,
      className: entry.source,
      removalPolicy: entry.removalPolicy === "locked" ? "locked" : "user_removable",
    });
  }
  return { candidates, suppressed };
}

const candidateClass = async (skillDir: string, root: string): Promise<Candidate["className"]> => {
  try {
    const marker = JSON.parse(await readFile(join(skillDir, MARKER), "utf8")) as { source?: string };
    if (marker.source === "organization" || marker.source === "platform") return "policy-enforced";
    if (marker.source === "personal") return "user-imported";
  } catch {
    // Unmanaged directories are classified by their root below.
  }
  const normalizedRoot = root.replace(/\\/g, "/").toLowerCase();
  if (normalizedRoot.includes("/veslo-user/") || normalizedRoot.endsWith("/veslo-user")) return "user-imported";
  if (normalizedRoot.includes("/veslo-managed/") || normalizedRoot.endsWith("/veslo-managed")) return "policy-enforced";
  return "workspace-local";
};

const candidateRemovalPolicy = async (skillDir: string): Promise<Candidate["removalPolicy"]> => {
  try {
    const marker = JSON.parse(await readFile(join(skillDir, MARKER), "utf8")) as { removalPolicy?: unknown };
    return marker.removalPolicy === "locked" ? "locked" : "user_removable";
  } catch {
    return "user_removable";
  }
};

async function discover(root: string): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return candidates;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const sourceDir = join(root, entry.name);
    const add = async (name: string, dir: string) => {
      try { await readFile(join(dir, ENTRYPOINT), "utf8"); } catch { return; }
      candidates.push({
        name,
        sourceDir: dir,
        className: await candidateClass(dir, dir),
        removalPolicy: await candidateRemovalPolicy(dir),
        sourcePath: join(dir, ENTRYPOINT),
      });
    };
    await add(entry.name, sourceDir);
    if (candidates.some((candidate) => candidate.sourceDir === sourceDir)) continue;
    let nested;
    try { nested = await readdir(sourceDir, { withFileTypes: true }); } catch { continue; }
    for (const child of nested) {
      if (!child.isDirectory()) continue;
      await add(child.name, join(sourceDir, child.name));
    }
  }
  return candidates;
}

function chooseCandidates(candidates: Candidate[]): { selected: Candidate[]; suppressed: EngineSkillStagingResult["suppressed"] } {
  const byName = new Map<string, Candidate[]>();
  for (const candidate of candidates) {
    const list = byName.get(candidate.name) ?? [];
    list.push(candidate);
    byName.set(candidate.name, list);
  }
  const selected: Candidate[] = [];
  const suppressed: EngineSkillStagingResult["suppressed"] = [];
  for (const [name, variants] of byName) {
    const policies = variants.filter((item) => item.className === "policy-enforced");
    const locals = variants.filter((item) => item.className === "workspace-local");
    const imports = variants.filter((item) => item.className === "user-imported");
    if (policies.length > 1) {
      suppressed.push({ name, reason: "policy-conflict" });
      continue;
    }
    if (policies.length === 1 && locals.length > 0) {
      if (policies[0]!.removalPolicy === "locked") {
        suppressed.push({ name, reason: "policy-conflict" });
        continue;
      }
      if (locals.length === 1) selected.push(locals[0]!);
      else suppressed.push({ name, reason: "equal-precedence-conflict" });
      continue;
    }
    if (policies.length === 1) {
      selected.push(policies[0]);
      continue;
    }
    if (locals.length === 1) {
      selected.push(locals[0]);
      continue;
    }
    if (locals.length > 1 || imports.length > 1) {
      suppressed.push({ name, reason: "equal-precedence-conflict" });
      continue;
    }
    if (imports.length === 1) selected.push(imports[0]);
  }
  selected.sort((left, right) => left.name.localeCompare(right.name));
  suppressed.sort((left, right) => left.name.localeCompare(right.name));
  return { selected, suppressed };
}

async function stageEngineSkillViewUnlocked(input: {
  workspace: string;
  stagingRoot: string;
  /** Runtime launches must consume the server's effective resolver output. */
  requireEffectiveManifest?: boolean;
  /** Revision promised by the server for this launch. */
  expectedRevision?: string;
  engineOwnerId?: string;
}): Promise<EngineSkillStagingResult> {
  const workspace = resolve(input.workspace);
  const stagingRoot = resolve(input.stagingRoot);
  if (!isWithin(dirname(stagingRoot), stagingRoot)) throw new Error("Engine skill staging root must be a child directory");
  await mkdir(stagingRoot, { recursive: true });
  const operationId = randomUUID();
  const requestedEngineOwnerId = input.engineOwnerId?.trim() || undefined;
  const engineOwnerId = requestedEngineOwnerId ?? `unclaimed-${PROCESS_INSTANCE_ID}`;
  const generationRoot = join(stagingRoot, "generations", `${Date.now()}-${operationId}`);
  const generationLease: EngineSkillGenerationLease = {
    stagingRoot,
    generationRoot,
    operationId,
    engineOwnerId,
  };
  await mkdir(generationRoot, { recursive: true });
  await writeGenerationRecord(generationRoot, {
    schemaVersion: 1,
    operationId,
    generationRoot,
    state: "preparing",
    engineOwnerId,
    processId: process.pid,
    processInstanceId: PROCESS_INSTANCE_ID,
    processStartedAt: PROCESS_STARTED_AT,
    updatedAt: new Date().toISOString(),
  });

  const roots = [
    join(workspace, ".opencode", "skills"),
    join(workspace, ".claude", "skills"),
    join(workspace, ".agents", "skills"),
    join(workspace, ".agent", "skills"),
  ];
  try {
    const manifest = await readEffectiveManifest(workspace);
    if (input.expectedRevision && manifest?.revision !== input.expectedRevision) {
      throw new Error(`skill_view_stale: expected ${input.expectedRevision}, received ${manifest?.revision ?? "none"}`);
    }
    const source = manifest
      ? "effective-manifest"
      : input.requireEffectiveManifest
        ? "fail-closed-no-manifest"
        : "legacy-discovery";
    let candidates: Candidate[];
    let manifestSuppressed: EngineSkillStagingResult["suppressed"] = [];
    if (manifest) {
      const discovered = await discoverEffectiveManifestCandidates(workspace, manifest);
      candidates = discovered.candidates;
      manifestSuppressed = discovered.suppressed;
    } else {
      candidates = input.requireEffectiveManifest
        ? []
        : (await Promise.all(roots.map(discover))).flat();
    }
    const { selected, suppressed } = chooseCandidates(candidates);
    const allSuppressed = [...manifestSuppressed, ...suppressed].sort((left, right) =>
      left.name.localeCompare(right.name) || left.reason.localeCompare(right.reason));
    for (const candidate of selected) {
      try {
        await cp(candidate.sourceDir, join(generationRoot, candidate.name), { recursive: true, force: true });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") throw new SkillViewChangedError(candidate.name);
        throw error;
      }
    }
    const materialized = selected.map((candidate) => candidate.name);
    await writeFile(
      join(generationRoot, STAGING_MANIFEST),
      `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), generationRoot, materialized, suppressed: allSuppressed }, null, 2)}\n`,
      "utf8",
    );
    await writeGenerationRecord(generationRoot, {
      schemaVersion: 1,
      operationId,
      generationRoot,
      state: requestedEngineOwnerId ? "ready" : "released",
      engineOwnerId,
      processId: process.pid,
      processInstanceId: PROCESS_INSTANCE_ID,
      processStartedAt: PROCESS_STARTED_AT,
      updatedAt: new Date().toISOString(),
    });
    const pointerPath = join(stagingRoot, "current.json");
    const pointerTemp = `${pointerPath}.${randomUUID()}.tmp`;
    await writeFile(pointerTemp, `${JSON.stringify({ schemaVersion: 1, generationRoot }, null, 2)}\n`, "utf8");
    await rename(pointerTemp, pointerPath);
    await cleanupStagingGenerations(stagingRoot, generationRoot);
    return {
      stagingRoot: generationRoot,
      source,
      materialized,
      materializedDetails: selected.map((candidate) => ({
        name: candidate.name,
        sourcePath: candidate.sourcePath,
        className: candidate.className,
      })),
      suppressed: allSuppressed,
      ...(requestedEngineOwnerId ? { generationLease } : {}),
    };
  } catch (error) {
    await rm(generationRoot, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

export async function stageEngineSkillView(input: {
  workspace: string;
  stagingRoot: string;
  /** Runtime launches must consume the server's effective resolver output. */
  requireEffectiveManifest?: boolean;
  /** Revision promised by the server for this launch. */
  expectedRevision?: string;
  engineOwnerId?: string;
}): Promise<EngineSkillStagingResult> {
  return withStagingRootLock(input.stagingRoot, () => stageEngineSkillViewUnlocked(input));
}

/**
 * Publish a server-owned effective view at a stable path inside one workspace.
 *
 * OpenCode resolves a relative `skills.paths` value against the request
 * directory.  The path therefore must stay stable for the lifetime of a
 * shared process; only this directory's contents are replaced while its
 * admission is closed by DirectorySkillViewLifecycle.  The two-step rename is
 * recoverable on Windows (where replacing a non-empty directory is not
 * portable): the previous view is retained until the new root is in place.
 */
export async function publishDirectorySkillView(input: {
  workspace: string;
  runtimeRoot: string;
  skillViewRevision: string;
}): Promise<DirectorySkillViewPublishResult> {
  const workspace = resolve(input.workspace);
  const runtimeRoot = resolve(input.runtimeRoot);
  const revision = input.skillViewRevision.trim();
  if (!revision) throw new Error("directory skill view revision is required");
  if (!isWithin(workspace, runtimeRoot)) {
    throw new Error("Directory skill runtime root must be inside its workspace");
  }

  const runtimeParent = dirname(runtimeRoot);
  const stagingRoot = join(runtimeParent, ".staging");
  return withStagingRootLock(stagingRoot, async () => {
    const staged = await stageEngineSkillViewUnlocked({
      workspace,
      stagingRoot,
      requireEffectiveManifest: true,
      expectedRevision: revision,
    });
    const pendingRoot = join(runtimeParent, `.pending-${randomUUID()}`);
    const previousRoot = join(runtimeParent, `.previous-${randomUUID()}`);
    await mkdir(runtimeParent, { recursive: true });

    try {
      await cp(staged.stagingRoot, pendingRoot, { recursive: true, force: true });
      await writeFile(
        join(pendingRoot, STAGING_MANIFEST),
        `${JSON.stringify({
          schemaVersion: 1,
          publishedAt: new Date().toISOString(),
          runtimeRoot,
          skillViewRevision: revision,
          materialized: staged.materialized,
          suppressed: staged.suppressed,
        }, null, 2)}\n`,
        "utf8",
      );

      await promoteDirectorySkillView({ runtimeRoot, pendingRoot, previousRoot });
    } finally {
      await rm(pendingRoot, { recursive: true, force: true });
    }

    if (staged.generationLease) await releaseEngineSkillGenerationUnlocked(staged.generationLease);
    return { ...staged, runtimeRoot, skillViewRevision: revision };
  });
}
