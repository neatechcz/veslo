import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

const ENTRYPOINT = "SKILL.md";
const MARKER = ".veslo-managed.json";
const STAGING_MANIFEST = ".veslo-engine-skill-staging.json";
const GENERATION_RETENTION = 3;

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
  return value.length > 0 && !value.startsWith("..") && !value.includes(`..${"\\"}`) && !value.includes(`../`);
};

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
  const keep = new Set([currentName, ...generations.slice(0, GENERATION_RETENTION - 1)]);
  await Promise.all(generations
    .filter((generation) => !keep.has(generation))
    .map((generation) => rm(join(generationsRoot, generation), { recursive: true, force: true })));
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
): Promise<Candidate[]> {
  const candidates: Candidate[] = [];
  for (const entry of manifest.entries) {
    if (!entry || typeof entry.name !== "string" || typeof entry.path !== "string") continue;
    const sourcePath = resolve(entry.path);
    if (!isWithin(workspace, sourcePath) || sourcePath.toLowerCase().split(/[\\/]/).pop() !== ENTRYPOINT.toLowerCase()) continue;
    const sourceDir = dirname(sourcePath);
    try {
      await readFile(sourcePath, "utf8");
    } catch {
      continue;
    }
    candidates.push({
      name: entry.name,
      sourceDir,
      sourcePath,
      className: entry.source,
      removalPolicy: entry.removalPolicy === "locked" ? "locked" : "user_removable",
    });
  }
  return candidates;
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
    const normalizedRoot = root.replace(/\\/g, "/").toLowerCase();
    if (normalizedRoot.endsWith("/.opencode/skills") && (entry.name === "veslo-user" || entry.name === "veslo-managed")) {
      continue;
    }
    const sourceDir = join(root, entry.name);
    const add = async (name: string, dir: string, classificationRoot: string) => {
      try { await readFile(join(dir, ENTRYPOINT), "utf8"); } catch { return; }
      candidates.push({
        name,
        sourceDir: dir,
        className: await candidateClass(dir, classificationRoot),
        removalPolicy: await candidateRemovalPolicy(dir),
        sourcePath: join(dir, ENTRYPOINT),
      });
    };
    await add(entry.name, sourceDir, root);
    if (candidates.some((candidate) => candidate.sourceDir === sourceDir)) continue;
    let nested;
    try { nested = await readdir(sourceDir, { withFileTypes: true }); } catch { continue; }
    for (const child of nested) {
      if (!child.isDirectory()) continue;
      await add(child.name, join(sourceDir, child.name), root);
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

export async function stageEngineSkillView(input: {
  workspace: string;
  stagingRoot: string;
  /** Runtime launches must consume the server's effective resolver output. */
  requireEffectiveManifest?: boolean;
  /** Revision promised by the server for this launch. */
  expectedRevision?: string;
}): Promise<EngineSkillStagingResult> {
  const workspace = resolve(input.workspace);
  const stagingRoot = resolve(input.stagingRoot);
  if (!isWithin(dirname(stagingRoot), stagingRoot)) throw new Error("Engine skill staging root must be a child directory");
  await mkdir(stagingRoot, { recursive: true });
  const generationRoot = join(stagingRoot, "generations", `${Date.now()}-${randomUUID()}`);
  await mkdir(generationRoot, { recursive: true });

  const roots = [
    join(workspace, ".opencode", "skills"),
    join(workspace, ".opencode", "skills", "veslo-user"),
    join(workspace, ".opencode", "skills", "veslo-managed"),
    join(workspace, ".claude", "skills"),
  ];
  const manifest = await readEffectiveManifest(workspace);
  if (input.expectedRevision && manifest?.revision !== input.expectedRevision) {
    throw new Error(`skill_view_stale: expected ${input.expectedRevision}, received ${manifest?.revision ?? "none"}`);
  }
  const source = manifest
    ? "effective-manifest"
    : input.requireEffectiveManifest
      ? "fail-closed-no-manifest"
      : "legacy-discovery";
  const candidates = manifest
    ? await discoverEffectiveManifestCandidates(workspace, manifest)
    : input.requireEffectiveManifest
      ? []
      : (await Promise.all(roots.map(discover))).flat();
  const { selected, suppressed } = chooseCandidates(candidates);
  for (const candidate of selected) {
    await cp(candidate.sourceDir, join(generationRoot, candidate.name), { recursive: true, force: true });
  }
  const materialized = selected.map((candidate) => candidate.name);
  await writeFile(
    join(generationRoot, STAGING_MANIFEST),
    `${JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), generationRoot, materialized, suppressed }, null, 2)}\n`,
    "utf8",
  );
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
    suppressed,
  };
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
  const staged = await stageEngineSkillView({
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

  return { ...staged, runtimeRoot, skillViewRevision: revision };
}
