export type SkillLocationKind = "workspace" | "personal-global" | "organization" | "platform";

export type SkillLocation = {
  id: string;
  kind: SkillLocationKind;
  label?: string;
  workspaceId?: string;
  ownerUserId?: string;
  orgId?: string;
};

export type SkillLocationOperation = "copy" | "move" | "remove" | "restore";

export type SkillLocationConflictPolicy = "skip" | "rename" | "overwrite";

export type SkillLocationTargetConstraint = "allow-parallel" | "retarget-same-skill";

export type SkillLocationSelection = {
  installationId: string;
  skillId: string;
  name: string;
  slug: string;
  versionId: string;
  packageSha256: string;
  location: SkillLocation;
  originalLocation?: SkillLocation;
};

export type ExistingSkillTargetLocation = {
  installationId: string;
  skillId?: string;
  name: string;
  slug?: string;
  location: SkillLocation;
};

export type BuildSkillLocationActionReviewInput = {
  operation: SkillLocationOperation;
  selectedSourceLocations: readonly SkillLocationSelection[];
  targetLocations?: readonly SkillLocation[];
  existingTargetLocations?: readonly ExistingSkillTargetLocation[];
  conflictPolicy?: SkillLocationConflictPolicy;
  targetConstraint?: SkillLocationTargetConstraint;
};

export type CreateSkillInstallationStep = {
  type: "create-installation";
  operation: "copy" | "move";
  sourceInstallationId: string;
  skillId: string;
  name: string;
  slug: string;
  versionId: string;
  packageSha256: string;
  fromLocation: SkillLocation;
  targetLocation: SkillLocation;
  replaceInstallationId?: string;
  requiresBackupSnapshot?: true;
};

export type DeleteSkillInstallationStep = {
  type: "delete-installation";
  operation: "move" | "remove";
  installationId: string;
  skillId: string;
  name: string;
  slug: string;
  sourceLocation: SkillLocation;
};

export type RestoreSkillInstallationStep = {
  type: "restore-installation";
  operation: "restore";
  installationId: string;
  skillId: string;
  name: string;
  slug: string;
  versionId: string;
  packageSha256: string;
  sourceLocation: SkillLocation;
  targetLocation: SkillLocation;
  restoredFromLocation: SkillLocation;
  replaceInstallationId?: string;
  requiresBackupSnapshot?: true;
};

export type RetargetSkillInstallationStep = {
  type: "retarget-installation";
  operation: "move";
  installationId: string;
  skillId: string;
  name: string;
  slug: string;
  versionId: string;
  packageSha256: string;
  fromLocation: SkillLocation;
  targetLocation: SkillLocation;
  replaceInstallationId?: string;
  requiresBackupSnapshot?: true;
};

export type RequireSkillBackupSnapshotStep = {
  type: "require-backup-snapshot";
  operation: "copy" | "move" | "restore";
  skillId: string;
  name: string;
  slug: string;
  targetLocation: SkillLocation;
  existingInstallationId: string;
};

export type SkillLocationActionStep =
  | CreateSkillInstallationStep
  | DeleteSkillInstallationStep
  | RestoreSkillInstallationStep
  | RetargetSkillInstallationStep
  | RequireSkillBackupSnapshotStep;

export type SkillLocationActionConflict = {
  action: SkillLocationConflictPolicy;
  policy: SkillLocationConflictPolicy;
  reason?: "retarget-source-unavailable";
  skillId: string;
  name: string;
  slug: string;
  targetLocation: SkillLocation;
  existingInstallationId: string;
  resolvedName?: string;
  resolvedSlug?: string;
  requiresBackupSnapshot?: true;
};

export type SkillLocationAffectedSkill = {
  skillId: string;
  name: string;
  slug: string;
  sourceLocationIds: string[];
  targetLocationIds: string[];
  stepTypes: SkillLocationActionStep["type"][];
};

export type SkillLocationReloadImpact = {
  required: boolean;
  locationIds: string[];
  skillIds: string[];
};

export type SkillLocationActionReview = {
  affectedSkills: SkillLocationAffectedSkill[];
  steps: SkillLocationActionStep[];
  conflicts: SkillLocationActionConflict[];
  reloadImpact: SkillLocationReloadImpact;
  confirmationRequired: boolean;
};

type OccupiedSkillName = {
  installationId: string;
  name: string;
  slug: string;
};

type RetargetSkillInstallationSource = {
  installationId: string;
  location: SkillLocation;
};

type PlannedCreateStep = CreateSkillInstallationStep | RestoreSkillInstallationStep;

type PlannedTargetAction = {
  steps: SkillLocationActionStep[];
  createStep?: PlannedCreateStep;
};

const DEFAULT_CONFLICT_POLICY: SkillLocationConflictPolicy = "skip";
const DEFAULT_TARGET_CONSTRAINT: SkillLocationTargetConstraint = "allow-parallel";

export function buildSkillLocationActionReview(input: BuildSkillLocationActionReviewInput): SkillLocationActionReview {
  const conflictPolicy = input.conflictPolicy ?? DEFAULT_CONFLICT_POLICY;
  const targetConstraint = input.targetConstraint ?? DEFAULT_TARGET_CONSTRAINT;
  const existingTargetLocations = input.existingTargetLocations ?? [];
  const occupiedByLocation = buildOccupiedLocations(input.existingTargetLocations ?? []);
  const conflicts: SkillLocationActionConflict[] = [];
  const steps: SkillLocationActionStep[] = [];

  if (input.operation === "remove") {
    for (const selection of input.selectedSourceLocations) {
      steps.push(deleteStep(selection, "remove"));
    }
    return buildReview({ steps, conflicts });
  }

  if (input.operation === "restore") {
    for (const selection of input.selectedSourceLocations) {
      const targets = input.targetLocations?.length ? input.targetLocations : [selection.originalLocation ?? selection.location];
      for (const targetLocation of targets) {
        steps.push(
          ...planRestoreAction({
            selection,
            targetLocation,
            conflictPolicy,
            occupiedByLocation,
            conflicts,
          }).steps,
        );
      }
    }
    return buildReview({ steps, conflicts });
  }

  const targetLocations = input.targetLocations ?? [];
  const deferredDeletes: DeleteSkillInstallationStep[] = [];

  for (const selection of input.selectedSourceLocations) {
    let createdForSelection = false;
    for (const targetLocation of targetLocations) {
      const action = planCreateAction({
        operation: input.operation,
        selection,
        targetLocation,
        conflictPolicy,
        targetConstraint,
        existingTargetLocations,
        occupiedByLocation,
        conflicts,
      });
      steps.push(...action.steps);
      if (action.createStep) createdForSelection = true;
    }
    if (input.operation === "move" && createdForSelection) {
      deferredDeletes.push(deleteStep(selection, "move"));
    }
  }

  steps.push(...deferredDeletes);
  return buildReview({ steps, conflicts });
}

function planCreateAction(input: {
  operation: "copy" | "move";
  selection: SkillLocationSelection;
  targetLocation: SkillLocation;
  conflictPolicy: SkillLocationConflictPolicy;
  targetConstraint: SkillLocationTargetConstraint;
  existingTargetLocations: readonly ExistingSkillTargetLocation[];
  occupiedByLocation: Map<string, OccupiedSkillName[]>;
  conflicts: SkillLocationActionConflict[];
}): PlannedTargetAction {
  if (input.targetConstraint === "retarget-same-skill") {
    return planRetargetAction(input);
  }

  const { conflict, name, slug } = resolveTargetName(input);
  if (conflict?.action === "skip") {
    return { steps: [] };
  }

  const steps: SkillLocationActionStep[] = [];
  if (conflict?.action === "overwrite") {
    steps.push({
      type: "require-backup-snapshot",
      operation: input.operation,
      skillId: input.selection.skillId,
      name: input.selection.name,
      slug: input.selection.slug,
      targetLocation: input.targetLocation,
      existingInstallationId: conflict.existingInstallationId,
    });
  }

  const createStep: CreateSkillInstallationStep = {
    type: "create-installation",
    operation: input.operation,
    sourceInstallationId: input.selection.installationId,
    skillId: input.selection.skillId,
    name,
    slug,
    versionId: input.selection.versionId,
    packageSha256: input.selection.packageSha256,
    fromLocation: input.selection.location,
    targetLocation: input.targetLocation,
    ...(conflict?.action === "overwrite"
      ? {
          replaceInstallationId: conflict.existingInstallationId,
          requiresBackupSnapshot: true as const,
        }
      : {}),
  };

  steps.push(createStep);
  reserveLocationName(input.occupiedByLocation, input.targetLocation, {
    installationId: input.selection.installationId,
    name,
    slug,
  });
  return { steps, createStep };
}

function planRetargetAction(input: {
  operation: "copy" | "move";
  selection: SkillLocationSelection;
  targetLocation: SkillLocation;
  conflictPolicy: SkillLocationConflictPolicy;
  existingTargetLocations: readonly ExistingSkillTargetLocation[];
  occupiedByLocation: Map<string, OccupiedSkillName[]>;
  conflicts: SkillLocationActionConflict[];
}): PlannedTargetAction {
  const source = findRetargetSource(input.selection, input.targetLocation, input.existingTargetLocations);
  if (!source) {
    input.conflicts.push({
      action: "skip",
      policy: "skip",
      reason: "retarget-source-unavailable",
      skillId: input.selection.skillId,
      name: normalizeName(input.selection.name),
      slug: normalizeSlug(input.selection.slug || input.selection.name),
      targetLocation: input.targetLocation,
      existingInstallationId: input.selection.installationId,
    });
    return { steps: [] };
  }

  const { conflict, name, slug } = resolveTargetName(input);
  if (conflict?.action === "skip") {
    return { steps: [] };
  }

  const steps: SkillLocationActionStep[] = [];
  if (conflict?.action === "overwrite") {
    steps.push({
      type: "require-backup-snapshot",
      operation: "move",
      skillId: input.selection.skillId,
      name: input.selection.name,
      slug: input.selection.slug,
      targetLocation: input.targetLocation,
      existingInstallationId: conflict.existingInstallationId,
    });
  }

  const retargetStep = buildRetargetStep({
    selection: input.selection,
    source,
    targetLocation: input.targetLocation,
    name,
    slug,
    ...(conflict?.action === "overwrite" ? { replaceInstallationId: conflict.existingInstallationId } : {}),
  });

  steps.push(retargetStep);
  reserveLocationName(input.occupiedByLocation, input.targetLocation, {
    installationId: retargetStep.installationId,
    name,
    slug,
  });
  return { steps };
}

function buildRetargetStep(
  input: {
    selection: SkillLocationSelection;
    source: RetargetSkillInstallationSource;
    targetLocation: SkillLocation;
    name: string;
    slug: string;
    replaceInstallationId?: string;
  },
): RetargetSkillInstallationStep {
  return {
    type: "retarget-installation",
    operation: "move",
    installationId: input.source.installationId,
    skillId: input.selection.skillId,
    name: input.name,
    slug: input.slug,
    versionId: input.selection.versionId,
    packageSha256: input.selection.packageSha256,
    fromLocation: input.source.location,
    targetLocation: input.targetLocation,
    ...(input.replaceInstallationId
      ? {
          replaceInstallationId: input.replaceInstallationId,
          requiresBackupSnapshot: true as const,
        }
      : {}),
  };
}

function findRetargetSource(
  selection: SkillLocationSelection,
  targetLocation: SkillLocation,
  existingTargets: readonly ExistingSkillTargetLocation[],
): RetargetSkillInstallationSource | undefined {
  if (canRetargetBetweenLocations(selection.location, targetLocation)) {
    return { installationId: selection.installationId, location: selection.location };
  }

  const existingSource = existingTargets.find(
    (target) => target.skillId === selection.skillId && canRetargetBetweenLocations(target.location, targetLocation),
  );
  if (!existingSource) return undefined;

  return {
    installationId: existingSource.installationId,
    location: existingSource.location,
  };
}

function canRetargetBetweenLocations(fromLocation: SkillLocation, targetLocation: SkillLocation) {
  if (fromLocation.id === targetLocation.id) return false;
  return isRetargetableTargetKind(fromLocation.kind) && isRetargetableTargetKind(targetLocation.kind);
}

function isRetargetableTargetKind(kind: SkillLocationKind) {
  return kind === "personal-global" || kind === "workspace";
}

function planRestoreAction(input: {
  selection: SkillLocationSelection;
  targetLocation: SkillLocation;
  conflictPolicy: SkillLocationConflictPolicy;
  occupiedByLocation: Map<string, OccupiedSkillName[]>;
  conflicts: SkillLocationActionConflict[];
}): PlannedTargetAction {
  const { conflict, name, slug } = resolveTargetName({
    operation: "restore",
    selection: input.selection,
    targetLocation: input.targetLocation,
    conflictPolicy: input.conflictPolicy,
    occupiedByLocation: input.occupiedByLocation,
    conflicts: input.conflicts,
  });
  if (conflict?.action === "skip") {
    return { steps: [] };
  }

  const steps: SkillLocationActionStep[] = [];
  if (conflict?.action === "overwrite") {
    steps.push({
      type: "require-backup-snapshot",
      operation: "restore",
      skillId: input.selection.skillId,
      name: input.selection.name,
      slug: input.selection.slug,
      targetLocation: input.targetLocation,
      existingInstallationId: conflict.existingInstallationId,
    });
  }

  const restoreStep: RestoreSkillInstallationStep = {
    type: "restore-installation",
    operation: "restore",
    installationId: input.selection.installationId,
    skillId: input.selection.skillId,
    name,
    slug,
    versionId: input.selection.versionId,
    packageSha256: input.selection.packageSha256,
    sourceLocation: input.selection.location,
    targetLocation: input.targetLocation,
    restoredFromLocation: input.selection.location,
    ...(conflict?.action === "overwrite"
      ? {
          replaceInstallationId: conflict.existingInstallationId,
          requiresBackupSnapshot: true as const,
        }
      : {}),
  };

  steps.push(restoreStep);
  reserveLocationName(input.occupiedByLocation, input.targetLocation, {
    installationId: input.selection.installationId,
    name,
    slug,
  });
  return { steps, createStep: restoreStep };
}

function resolveTargetName(input: {
  operation: "copy" | "move" | "restore";
  selection: SkillLocationSelection;
  targetLocation: SkillLocation;
  conflictPolicy: SkillLocationConflictPolicy;
  occupiedByLocation: Map<string, OccupiedSkillName[]>;
  conflicts: SkillLocationActionConflict[];
}): {
  conflict?: SkillLocationActionConflict;
  name: string;
  slug: string;
} {
  const baseName = normalizeName(input.selection.name);
  const baseSlug = normalizeSlug(input.selection.slug || input.selection.name);
  const existing = findExistingTarget(input.occupiedByLocation, input.targetLocation, baseName, baseSlug);
  if (!existing) {
    return { name: baseName, slug: baseSlug };
  }

  if (input.conflictPolicy === "rename") {
    const unique = nextUniqueTargetName(input.occupiedByLocation, input.targetLocation, baseName, baseSlug);
    const conflict: SkillLocationActionConflict = {
      action: "rename",
      policy: input.conflictPolicy,
      skillId: input.selection.skillId,
      name: baseName,
      slug: baseSlug,
      targetLocation: input.targetLocation,
      existingInstallationId: existing.installationId,
      resolvedName: unique.name,
      resolvedSlug: unique.slug,
    };
    input.conflicts.push(conflict);
    return {
      conflict,
      name: unique.name,
      slug: unique.slug,
    };
  }

  if (input.conflictPolicy === "overwrite") {
    const conflict: SkillLocationActionConflict = {
      action: "overwrite",
      policy: input.conflictPolicy,
      skillId: input.selection.skillId,
      name: baseName,
      slug: baseSlug,
      targetLocation: input.targetLocation,
      existingInstallationId: existing.installationId,
      requiresBackupSnapshot: true,
    };
    input.conflicts.push(conflict);
    return {
      conflict,
      name: baseName,
      slug: baseSlug,
    };
  }

  const conflict: SkillLocationActionConflict = {
    action: "skip",
    policy: input.conflictPolicy,
    skillId: input.selection.skillId,
    name: baseName,
    slug: baseSlug,
    targetLocation: input.targetLocation,
    existingInstallationId: existing.installationId,
  };
  input.conflicts.push(conflict);
  return {
    conflict,
    name: baseName,
    slug: baseSlug,
  };
}

function deleteStep(selection: SkillLocationSelection, operation: "move" | "remove"): DeleteSkillInstallationStep {
  return {
    type: "delete-installation",
    operation,
    installationId: selection.installationId,
    skillId: selection.skillId,
    name: normalizeName(selection.name),
    slug: normalizeSlug(selection.slug || selection.name),
    sourceLocation: selection.location,
  };
}

function buildReview(input: {
  steps: SkillLocationActionStep[];
  conflicts: SkillLocationActionConflict[];
}): SkillLocationActionReview {
  return {
    affectedSkills: buildAffectedSkills(input.steps),
    steps: input.steps,
    conflicts: input.conflicts,
    reloadImpact: buildReloadImpact(input.steps),
    confirmationRequired: input.steps.length > 0,
  };
}

function buildAffectedSkills(steps: readonly SkillLocationActionStep[]): SkillLocationAffectedSkill[] {
  const affectedBySkillId = new Map<string, SkillLocationAffectedSkill>();

  for (const step of steps) {
    const affected = getOrCreateAffectedSkill(affectedBySkillId, step.skillId, step.name, step.slug);
    pushUnique(affected.stepTypes, step.type);

    if (step.type === "create-installation") {
      pushUnique(affected.sourceLocationIds, step.fromLocation.id);
      pushUnique(affected.targetLocationIds, step.targetLocation.id);
    } else if (step.type === "delete-installation") {
      pushUnique(affected.sourceLocationIds, step.sourceLocation.id);
    } else if (step.type === "restore-installation") {
      pushUnique(affected.sourceLocationIds, step.sourceLocation.id);
      pushUnique(affected.targetLocationIds, step.targetLocation.id);
    } else if (step.type === "retarget-installation") {
      pushUnique(affected.sourceLocationIds, step.fromLocation.id);
      pushUnique(affected.targetLocationIds, step.targetLocation.id);
    } else {
      pushUnique(affected.targetLocationIds, step.targetLocation.id);
    }
  }

  return Array.from(affectedBySkillId.values()).sort((left, right) => compareStrings(left.name, right.name));
}

function getOrCreateAffectedSkill(
  affectedBySkillId: Map<string, SkillLocationAffectedSkill>,
  skillId: string,
  name: string,
  slug: string,
): SkillLocationAffectedSkill {
  const existing = affectedBySkillId.get(skillId);
  if (existing) return existing;

  const affected: SkillLocationAffectedSkill = {
    skillId,
    name,
    slug,
    sourceLocationIds: [],
    targetLocationIds: [],
    stepTypes: [],
  };
  affectedBySkillId.set(skillId, affected);
  return affected;
}

function buildReloadImpact(steps: readonly SkillLocationActionStep[]): SkillLocationReloadImpact {
  const locationIds: string[] = [];
  const skillIds = new Set<string>();

  for (const step of steps) {
    skillIds.add(step.skillId);
    if (step.type === "create-installation" || step.type === "restore-installation") {
      pushUnique(locationIds, step.targetLocation.id);
    } else if (step.type === "delete-installation") {
      pushUnique(locationIds, step.sourceLocation.id);
    } else if (step.type === "retarget-installation") {
      pushUnique(locationIds, step.fromLocation.id);
      pushUnique(locationIds, step.targetLocation.id);
    } else {
      pushUnique(locationIds, step.targetLocation.id);
    }
  }

  return {
    required: steps.length > 0,
    locationIds,
    skillIds: Array.from(skillIds).sort(compareStrings),
  };
}

function buildOccupiedLocations(existingTargets: readonly ExistingSkillTargetLocation[]): Map<string, OccupiedSkillName[]> {
  const occupiedByLocation = new Map<string, OccupiedSkillName[]>();
  for (const target of existingTargets) {
    reserveLocationName(occupiedByLocation, target.location, {
      installationId: target.installationId,
      name: normalizeName(target.name),
      slug: normalizeSlug(target.slug || target.name),
    });
  }
  return occupiedByLocation;
}

function reserveLocationName(
  occupiedByLocation: Map<string, OccupiedSkillName[]>,
  location: SkillLocation,
  occupied: OccupiedSkillName,
) {
  const locationOccupied = occupiedByLocation.get(location.id) ?? [];
  locationOccupied.push(occupied);
  occupiedByLocation.set(location.id, locationOccupied);
}

function findExistingTarget(
  occupiedByLocation: Map<string, OccupiedSkillName[]>,
  location: SkillLocation,
  name: string,
  slug: string,
): OccupiedSkillName | undefined {
  const targetName = canonicalText(name);
  const targetSlug = canonicalText(slug);
  return (occupiedByLocation.get(location.id) ?? []).find(
    (occupied) => canonicalText(occupied.slug) === targetSlug || canonicalText(occupied.name) === targetName,
  );
}

function nextUniqueTargetName(
  occupiedByLocation: Map<string, OccupiedSkillName[]>,
  location: SkillLocation,
  baseName: string,
  baseSlug: string,
): { name: string; slug: string } {
  for (let suffix = 2; suffix < Number.MAX_SAFE_INTEGER; suffix += 1) {
    const name = `${baseName} ${suffix}`;
    const slug = `${baseSlug}-${suffix}`;
    if (!findExistingTarget(occupiedByLocation, location, name, slug)) {
      return { name, slug };
    }
  }
  throw new Error(`Could not find a unique skill name for ${baseName}`);
}

function normalizeName(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function normalizeSlug(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || "skill";
}

function canonicalText(value: string): string {
  return value.trim().toLowerCase();
}

function compareStrings(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function pushUnique<T>(items: T[], item: T) {
  if (!items.includes(item)) items.push(item);
}
