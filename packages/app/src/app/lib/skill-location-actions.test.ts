import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSkillLocationActionReview,
  type SkillLocation,
  type SkillLocationSelection,
} from "./skill-location-actions.js";

const personal: SkillLocation = {
  id: "personal:user-1",
  kind: "personal-global",
  label: "My global skills",
  ownerUserId: "user-1",
};

const workspaceAlpha: SkillLocation = {
  id: "workspace:alpha",
  kind: "workspace",
  label: "Alpha",
  workspaceId: "alpha",
};

const workspaceBeta: SkillLocation = {
  id: "workspace:beta",
  kind: "workspace",
  label: "Beta",
  workspaceId: "beta",
};

const workspaceArchive: SkillLocation = {
  id: "workspace:archive",
  kind: "workspace",
  label: "Archive",
  workspaceId: "archive",
};

const sourceSkill = (overrides: Partial<SkillLocationSelection> = {}): SkillLocationSelection => ({
  installationId: "install-research-personal",
  skillId: "skill-research",
  name: "Research",
  slug: "research",
  versionId: "version-research-1",
  packageSha256: "sha-research-1",
  location: personal,
  ...overrides,
});

test("copy defaults conflicts to skip and creates target installation steps for the same package", () => {
  const review = buildSkillLocationActionReview({
    operation: "copy",
    selectedSourceLocations: [sourceSkill()],
    targetLocations: [workspaceAlpha, workspaceBeta],
    existingTargetLocations: [
      {
        installationId: "install-research-alpha",
        skillId: "skill-research",
        name: "Research",
        slug: "research",
        location: workspaceAlpha,
      },
    ],
  });

  assert.deepEqual(
    review.steps.map((step) => step.type),
    ["create-installation"],
  );
  assert.deepEqual(review.steps[0], {
    type: "create-installation",
    operation: "copy",
    sourceInstallationId: "install-research-personal",
    skillId: "skill-research",
    name: "Research",
    slug: "research",
    versionId: "version-research-1",
    packageSha256: "sha-research-1",
    fromLocation: personal,
    targetLocation: workspaceBeta,
  });
  assert.deepEqual(review.conflicts, [
    {
      action: "skip",
      policy: "skip",
      skillId: "skill-research",
      name: "Research",
      slug: "research",
      targetLocation: workspaceAlpha,
      existingInstallationId: "install-research-alpha",
    },
  ]);
  assert.deepEqual(review.affectedSkills, [
    {
      skillId: "skill-research",
      name: "Research",
      slug: "research",
      sourceLocationIds: ["personal:user-1"],
      targetLocationIds: ["workspace:beta"],
      stepTypes: ["create-installation"],
    },
  ]);
  assert.deepEqual(review.reloadImpact, {
    required: true,
    locationIds: ["workspace:beta"],
    skillIds: ["skill-research"],
  });
  assert.equal(review.confirmationRequired, true);
});

test("move orders target creation before source deletion and marks overwrite backup requirements", () => {
  const review = buildSkillLocationActionReview({
    operation: "move",
    conflictPolicy: "overwrite",
    selectedSourceLocations: [sourceSkill()],
    targetLocations: [workspaceAlpha],
    existingTargetLocations: [
      {
        installationId: "install-research-alpha-old",
        skillId: "skill-research-old",
        name: "Research",
        slug: "research",
        location: workspaceAlpha,
      },
    ],
  });

  assert.deepEqual(
    review.steps.map((step) => step.type),
    ["require-backup-snapshot", "create-installation", "delete-installation"],
  );
  assert.deepEqual(review.steps[0], {
    type: "require-backup-snapshot",
    operation: "move",
    skillId: "skill-research",
    name: "Research",
    slug: "research",
    targetLocation: workspaceAlpha,
    existingInstallationId: "install-research-alpha-old",
  });
  assert.deepEqual(review.steps[1], {
    type: "create-installation",
    operation: "move",
    sourceInstallationId: "install-research-personal",
    skillId: "skill-research",
    name: "Research",
    slug: "research",
    versionId: "version-research-1",
    packageSha256: "sha-research-1",
    fromLocation: personal,
    targetLocation: workspaceAlpha,
    replaceInstallationId: "install-research-alpha-old",
    requiresBackupSnapshot: true,
  });
  assert.deepEqual(review.steps[2], {
    type: "delete-installation",
    operation: "move",
    installationId: "install-research-personal",
    skillId: "skill-research",
    name: "Research",
    slug: "research",
    sourceLocation: personal,
  });
  assert.deepEqual(review.conflicts, [
    {
      action: "overwrite",
      policy: "overwrite",
      skillId: "skill-research",
      name: "Research",
      slug: "research",
      targetLocation: workspaceAlpha,
      existingInstallationId: "install-research-alpha-old",
      requiresBackupSnapshot: true,
    },
  ]);
  assert.deepEqual(review.reloadImpact.locationIds, ["workspace:alpha", "personal:user-1"]);
  assert.equal(review.confirmationRequired, true);
});

test("exclusive same-skill target changes produce retarget steps instead of parallel create steps", () => {
  const review = buildSkillLocationActionReview({
    operation: "copy",
    targetConstraint: "retarget-same-skill",
    selectedSourceLocations: [sourceSkill()],
    targetLocations: [workspaceAlpha],
    existingTargetLocations: [
      {
        installationId: "install-research-personal",
        skillId: "skill-research",
        name: "Research",
        slug: "research",
        location: personal,
      },
    ],
  });

  assert.deepEqual(
    review.steps.map((step) => step.type),
    ["retarget-installation"],
  );
  assert.deepEqual(review.steps[0], {
    type: "retarget-installation",
    operation: "move",
    installationId: "install-research-personal",
    skillId: "skill-research",
    name: "Research",
    slug: "research",
    versionId: "version-research-1",
    packageSha256: "sha-research-1",
    fromLocation: personal,
    targetLocation: workspaceAlpha,
  });
  assert.equal(review.steps.some((step) => step.type === "create-installation"), false);
  assert.deepEqual(review.affectedSkills, [
    {
      skillId: "skill-research",
      name: "Research",
      slug: "research",
      sourceLocationIds: ["personal:user-1"],
      targetLocationIds: ["workspace:alpha"],
      stepTypes: ["retarget-installation"],
    },
  ]);
});

test("rename conflict policy assigns unique target slugs and names", () => {
  const review = buildSkillLocationActionReview({
    operation: "copy",
    conflictPolicy: "rename",
    selectedSourceLocations: [
      sourceSkill({
        installationId: "install-planning-personal",
        skillId: "skill-planning",
        name: "Planning",
        slug: "planning",
        versionId: "version-planning-1",
        packageSha256: "sha-planning-1",
      }),
    ],
    targetLocations: [workspaceAlpha],
    existingTargetLocations: [
      {
        installationId: "install-planning-alpha",
        skillId: "skill-planning",
        name: "Planning",
        slug: "planning",
        location: workspaceAlpha,
      },
      {
        installationId: "install-planning-alpha-2",
        skillId: "skill-planning-2",
        name: "Planning 2",
        slug: "planning-2",
        location: workspaceAlpha,
      },
    ],
  });

  assert.deepEqual(review.conflicts, [
    {
      action: "rename",
      policy: "rename",
      skillId: "skill-planning",
      name: "Planning",
      slug: "planning",
      targetLocation: workspaceAlpha,
      existingInstallationId: "install-planning-alpha",
      resolvedName: "Planning 3",
      resolvedSlug: "planning-3",
    },
  ]);
  assert.deepEqual(review.steps, [
    {
      type: "create-installation",
      operation: "copy",
      sourceInstallationId: "install-planning-personal",
      skillId: "skill-planning",
      name: "Planning 3",
      slug: "planning-3",
      versionId: "version-planning-1",
      packageSha256: "sha-planning-1",
      fromLocation: personal,
      targetLocation: workspaceAlpha,
    },
  ]);
});

test("remove creates delete steps for the selected source locations", () => {
  const review = buildSkillLocationActionReview({
    operation: "remove",
    selectedSourceLocations: [
      sourceSkill(),
      sourceSkill({
        installationId: "install-deploy-alpha",
        skillId: "skill-deploy",
        name: "Deploy",
        slug: "deploy",
        versionId: "version-deploy-1",
        packageSha256: "sha-deploy-1",
        location: workspaceAlpha,
      }),
    ],
  });

  assert.deepEqual(review.steps, [
    {
      type: "delete-installation",
      operation: "remove",
      installationId: "install-research-personal",
      skillId: "skill-research",
      name: "Research",
      slug: "research",
      sourceLocation: personal,
    },
    {
      type: "delete-installation",
      operation: "remove",
      installationId: "install-deploy-alpha",
      skillId: "skill-deploy",
      name: "Deploy",
      slug: "deploy",
      sourceLocation: workspaceAlpha,
    },
  ]);
  assert.deepEqual(review.conflicts, []);
  assert.deepEqual(review.reloadImpact, {
    required: true,
    locationIds: ["personal:user-1", "workspace:alpha"],
    skillIds: ["skill-deploy", "skill-research"],
  });
});

test("restore creates restore steps using the original location or explicit target locations", () => {
  const deleted = sourceSkill({
    installationId: "install-research-deleted",
    location: workspaceArchive,
    originalLocation: workspaceAlpha,
  });

  const originalReview = buildSkillLocationActionReview({
    operation: "restore",
    selectedSourceLocations: [deleted],
  });

  assert.deepEqual(originalReview.steps, [
    {
      type: "restore-installation",
      operation: "restore",
      installationId: "install-research-deleted",
      skillId: "skill-research",
      name: "Research",
      slug: "research",
      versionId: "version-research-1",
      packageSha256: "sha-research-1",
      sourceLocation: workspaceArchive,
      targetLocation: workspaceAlpha,
      restoredFromLocation: workspaceArchive,
    },
  ]);

  const targetReview = buildSkillLocationActionReview({
    operation: "restore",
    selectedSourceLocations: [deleted],
    targetLocations: [workspaceBeta],
  });

  assert.deepEqual(targetReview.steps, [
    {
      type: "restore-installation",
      operation: "restore",
      installationId: "install-research-deleted",
      skillId: "skill-research",
      name: "Research",
      slug: "research",
      versionId: "version-research-1",
      packageSha256: "sha-research-1",
      sourceLocation: workspaceArchive,
      targetLocation: workspaceBeta,
      restoredFromLocation: workspaceArchive,
    },
  ]);
});
