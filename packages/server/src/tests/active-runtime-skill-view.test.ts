import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  EMPTY_SERVING_RUNTIME_SKILL_BINDING,
  invalidateActiveRuntimeSkillView,
  prepareRuntimeSkillCandidate,
  publishValidatedRuntimeSkillCandidate,
  readServingRuntimeSkillBinding,
  resolveActiveRuntimeSkillView,
  resetActiveRuntimeSkillViewsForTests,
  setActiveRuntimeSkillViewBeforePublicationForTests,
} from "../active-runtime-skill-view.js";
import {
  fenceRuntimeSkillAuthorization,
  isRuntimeSkillAuthorizationFenced,
} from "../runtime-skill-revocation-fence.js";

const roots: string[] = [];

async function workspaceFixture() {
  const path = await mkdtemp(join(process.env.TEMP ?? ".", "veslo-runtime-view-"));
  roots.push(path);
  await mkdir(join(path, ".opencode", "skills", "example"), { recursive: true });
  await writeFile(join(path, ".opencode", "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Example\n---\n", "utf8");
  return { id: "workspace-a", name: "Fixture", path, workspaceType: "local" as const };
}

async function publishFixtureView(
  workspace: Awaited<ReturnType<typeof workspaceFixture>>,
) {
  const candidate = await prepareRuntimeSkillCandidate(workspace);
  await publishValidatedRuntimeSkillCandidate(candidate);
  return candidate;
}

afterEach(async () => {
  resetActiveRuntimeSkillViewsForTests();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

test("canonical empty serving binding is stable and explicit", () => {
  expect(EMPTY_SERVING_RUNTIME_SKILL_BINDING).toEqual({
    revision: "empty-direct-skill-view/v1",
    authorizationRevision: "empty-direct-skill-authorization/v1",
  });
});

test("validated promotion writes an atomic serving manifest", async () => {
  const workspace = await workspaceFixture();
  const first = await publishFixtureView(workspace);

  const manifest = JSON.parse(await readFile(join(workspace.path, ".opencode", "veslo.runtime.skills.json"), "utf8"));
  expect(manifest.schemaVersion).toBe(3);
  expect(manifest.revision).toBe(first.revision);
  expect(manifest.authorizationRevision).toBe(first.authorizationRevision);
  expect(manifest.entries.map((entry: { name: string }) => entry.name)).toEqual(["example"]);
});

test("a managed skill is represented exactly once in the active runtime manifest", async () => {
  const workspace = await workspaceFixture();
  const managedDir = join(workspace.path, ".opencode", "skills", "veslo-managed", "managed-example");
  await mkdir(managedDir, { recursive: true });
  await writeFile(
    join(managedDir, "SKILL.md"),
    "---\nname: managed-example\ndescription: Managed example\n---\n",
    "utf8",
  );
  await writeFile(
    join(managedDir, ".veslo-managed.json"),
    JSON.stringify({ installationId: "managed-example-1", source: "organization", removalPolicy: "locked" }),
    "utf8",
  );

  await publishFixtureView(workspace);
  const manifest = JSON.parse(await readFile(join(workspace.path, ".opencode", "veslo.runtime.skills.json"), "utf8"));
  const managedEntries = manifest.entries.filter((entry: { name: string }) => entry.name === "managed-example");

  expect(managedEntries).toHaveLength(1);
});

test("a nested file change moves the revision, not just the entrypoint", async () => {
  const workspace = await workspaceFixture();
  const first = await publishFixtureView(workspace);

  // The orchestrator stages the whole skill directory, so a revision that only
  // tracked SKILL.md would call this view unchanged and launch an engine over
  // content nobody agreed to.
  const assets = join(workspace.path, ".opencode", "skills", "example", "assets");
  await mkdir(assets, { recursive: true });
  await writeFile(join(assets, "schema.json"), JSON.stringify({ v: 1 }), "utf8");
  invalidateActiveRuntimeSkillView(workspace);
  const afterAdd = await publishFixtureView(workspace);
  expect(afterAdd.revision).not.toBe(first.revision);

  await writeFile(join(assets, "schema.json"), JSON.stringify({ v: 2, padded: true }), "utf8");
  invalidateActiveRuntimeSkillView(workspace);
  const afterEdit = await publishFixtureView(workspace);
  expect(afterEdit.revision).not.toBe(afterAdd.revision);
  expect(afterEdit.authorizationRevision).toBe(first.authorizationRevision);
});

test("explicit invalidation produces a new view after a workspace mutation", async () => {
  const workspace = await workspaceFixture();
  const first = await publishFixtureView(workspace);
  await writeFile(join(workspace.path, ".opencode", "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Changed\n---\n", "utf8");
  invalidateActiveRuntimeSkillView(workspace);
  const next = await publishFixtureView(workspace);

  expect(next.revision).not.toBe(first.revision);
  expect(next.skills[0]?.description).toBe("Changed");
});

test("serving binding stays readable after invalidation without rediscovering Skills", async () => {
  const workspace = await workspaceFixture();
  const first = await publishFixtureView(workspace);
  await writeFile(
    join(workspace.path, ".opencode", "skills", "example", "SKILL.md"),
    "---\nname: example\ndescription: Changed after publication\n---\n",
    "utf8",
  );
  invalidateActiveRuntimeSkillView(workspace);

  await expect(readServingRuntimeSkillBinding(workspace)).resolves.toEqual({
    revision: first.revision,
    authorizationRevision: first.authorizationRevision,
  });
});

test("candidate manifest cannot replace the serving LKG until validation promotes it", async () => {
  const workspace = await workspaceFixture();
  const serving = await publishFixtureView(workspace);
  await writeFile(join(workspace.path, ".opencode", "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Candidate\n---\n", "utf8");
  const candidate = await prepareRuntimeSkillCandidate(workspace);

  expect(candidate.revision).not.toBe(serving.revision);
  await expect(readServingRuntimeSkillBinding(workspace)).resolves.toEqual({
    revision: serving.revision,
    authorizationRevision: serving.authorizationRevision,
  });

  await publishValidatedRuntimeSkillCandidate(candidate);
  await expect(readServingRuntimeSkillBinding(workspace)).resolves.toEqual({
    revision: candidate.revision,
    authorizationRevision: candidate.authorizationRevision,
  });
  await expect(readFile(candidate.manifestPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("resolve-only inventory never overwrites serving LKG", async () => {
  const workspace = await workspaceFixture();
  const serving = await publishFixtureView(workspace);
  await writeFile(
    join(workspace.path, ".opencode", "skills", "example", "SKILL.md"),
    "---\nname: example\ndescription: Resolve only\n---\n",
    "utf8",
  );

  const resolved = await resolveActiveRuntimeSkillView(workspace);

  expect(resolved.revision).not.toBe(serving.revision);
  await expect(readServingRuntimeSkillBinding(workspace)).resolves.toEqual({
    revision: serving.revision,
    authorizationRevision: serving.authorizationRevision,
  });
});

test("a superseded candidate cannot publish and its sidecar is removed", async () => {
  const workspace = await workspaceFixture();
  const serving = await publishFixtureView(workspace);
  await writeFile(
    join(workspace.path, ".opencode", "skills", "example", "SKILL.md"),
    "---\nname: example\ndescription: Candidate\n---\n",
    "utf8",
  );
  const candidate = await prepareRuntimeSkillCandidate(workspace);
  invalidateActiveRuntimeSkillView(workspace);

  await expect(publishValidatedRuntimeSkillCandidate(candidate)).rejects.toMatchObject({
    code: "candidate_superseded",
  });
  await expect(readServingRuntimeSkillBinding(workspace)).resolves.toEqual({
    revision: serving.revision,
    authorizationRevision: serving.authorizationRevision,
  });
  await expect(readFile(candidate.manifestPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
});

test("candidate promotion CAS rejects an invalidation that arrives before commit", async () => {
  const workspace = await workspaceFixture();
  const serving = await publishFixtureView(workspace);
  await writeFile(
    join(workspace.path, ".opencode", "skills", "example", "SKILL.md"),
    "---\nname: example\ndescription: Candidate race\n---\n",
    "utf8",
  );
  const candidate = await prepareRuntimeSkillCandidate(workspace);
  setActiveRuntimeSkillViewBeforePublicationForTests(async () => {
    invalidateActiveRuntimeSkillView(workspace);
  });

  await expect(publishValidatedRuntimeSkillCandidate(candidate)).rejects.toMatchObject({
    code: "candidate_superseded",
  });
  await expect(readServingRuntimeSkillBinding(workspace)).resolves.toEqual({
    revision: serving.revision,
    authorizationRevision: serving.authorizationRevision,
  });
});

test("persisted revocation fence rejects an otherwise durable old serving binding", async () => {
  const workspace = await workspaceFixture();
  const dataDir = await mkdtemp(join(process.env.TEMP ?? ".", "veslo-runtime-fence-"));
  roots.push(dataDir);
  const serving = await publishFixtureView(workspace);
  await fenceRuntimeSkillAuthorization({
    dataDir,
    workspaceId: workspace.id,
    authorizationRevision: serving.authorizationRevision,
  });

  await expect(readServingRuntimeSkillBinding(workspace, { dataDir })).resolves.toBeNull();
});

test("revocation fence never forgets an old authorization revision", async () => {
  const dataDir = await mkdtemp(join(process.env.TEMP ?? ".", "veslo-runtime-fence-history-"));
  roots.push(dataDir);
  for (let index = 0; index < 130; index += 1) {
    await fenceRuntimeSkillAuthorization({
      dataDir,
      workspaceId: "workspace-history",
      authorizationRevision: `authorization-${index}`,
    });
  }

  await expect(isRuntimeSkillAuthorizationFenced({
    dataDir,
    workspaceId: "workspace-history",
    authorizationRevision: "authorization-0",
  })).resolves.toBe(true);
});

test("validated promotion can explicitly re-authorize a recurring policy hash", async () => {
  const workspace = await workspaceFixture();
  const dataDir = await mkdtemp(join(process.env.TEMP ?? ".", "veslo-runtime-fence-reauthorize-"));
  roots.push(dataDir);
  const serving = await publishFixtureView(workspace);
  await fenceRuntimeSkillAuthorization({
    dataDir,
    workspaceId: workspace.id,
    authorizationRevision: serving.authorizationRevision,
  });
  invalidateActiveRuntimeSkillView(workspace);
  const candidate = await prepareRuntimeSkillCandidate(workspace, { dataDir });

  await publishValidatedRuntimeSkillCandidate(candidate);

  await expect(readServingRuntimeSkillBinding(workspace, { dataDir })).resolves.toEqual({
    revision: candidate.revision,
    authorizationRevision: candidate.authorizationRevision,
  });
});

test("a new validated candidate advances serving after an out-of-band workspace change", async () => {
  const workspace = await workspaceFixture();
  const first = await publishFixtureView(workspace);
  await writeFile(join(workspace.path, ".opencode", "skills", "example", "SKILL.md"), "---\nname: example\ndescription: Force refreshed\n---\n");
  invalidateActiveRuntimeSkillView(workspace);
  const refreshed = await publishFixtureView(workspace);

  expect(refreshed.revision).not.toBe(first.revision);
  expect(refreshed.skills[0]?.description).toBe("Force refreshed");
});

async function captureSkillAudit(run: () => Promise<void> | void) {
  const file = join(await mkdtemp(join(process.env.TEMP ?? ".", "veslo-audit-")), "audit.ndjson")
  const previous = process.env.VESLO_SKILL_AUDIT_LOG_FILE
  process.env.VESLO_SKILL_AUDIT_LOG_FILE = file
  try {
    await run()
  } finally {
    if (previous === undefined) delete process.env.VESLO_SKILL_AUDIT_LOG_FILE
    else process.env.VESLO_SKILL_AUDIT_LOG_FILE = previous
  }
  const raw = await readFile(file, "utf8").catch(() => "")
  return raw
    .split(/[\r\n]+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

test("invalidation records why it happened and which generation it produced", async () => {
  const workspace = await workspaceFixture()
  await publishFixtureView(workspace)

  const events = await captureSkillAudit(() => {
    invalidateActiveRuntimeSkillView(workspace, "workspace-config-patch")
    invalidateActiveRuntimeSkillView(workspace, "skill-enabled-state")
  })

  const invalidations = events.filter((e) => e.event === "active-runtime-view-invalidated")
  expect(invalidations).toHaveLength(2)
  expect(invalidations[0]?.reason).toBe("workspace-config-patch")
  expect(invalidations[1]?.reason).toBe("skill-enabled-state")
  // A burst is only countable if each entry says which generation it produced.
  expect(Number(invalidations[1]?.generation)).toBeGreaterThan(Number(invalidations[0]?.generation))
  // The first invalidation dropped a real cached view; the second had none left.
  expect(invalidations[0]?.hadCachedView).toBe(true)
  expect(invalidations[1]?.hadCachedView).toBe(false)
})

test("candidate preparation reports the cost of work that may be discarded", async () => {
  const workspace = await workspaceFixture()

  const events = await captureSkillAudit(async () => {
    await prepareRuntimeSkillCandidate(workspace)
  })

  const prepared = events.find((e) => e.event === "active-runtime-view-candidate-prepared")
  expect(prepared).toBeDefined()
  expect(typeof prepared?.durationMs).toBe("number")
  expect(Number(prepared?.durationMs)).toBeGreaterThanOrEqual(0)

  const resolution = events.find((e) => e.event === "active-runtime-resolution")
  expect(typeof resolution?.durationMs).toBe("number")
})
