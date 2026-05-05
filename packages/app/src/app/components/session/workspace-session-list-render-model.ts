type ProjectGroupLike = {
  key: string;
};

type ResolveRenderableProjectGroupsInput<T extends ProjectGroupLike> = {
  suspended: boolean;
  previousGroups: T[];
  nextGroups: T[];
};

export const resolveRenderableProjectGroups = <T extends ProjectGroupLike>(
  input: ResolveRenderableProjectGroupsInput<T>,
): T[] => {
  if (!input.suspended) return input.nextGroups;
  if (input.previousGroups.length === 0) return input.nextGroups;

  const nextByKey = new Map(input.nextGroups.map((group) => [group.key, group] as const));
  const emittedKeys = new Set<string>();
  const orderedGroups: T[] = [];

  for (const previousGroup of input.previousGroups) {
    const nextGroup = nextByKey.get(previousGroup.key);
    if (!nextGroup) continue;
    emittedKeys.add(nextGroup.key);
    orderedGroups.push(nextGroup);
  }

  for (const nextGroup of input.nextGroups) {
    if (emittedKeys.has(nextGroup.key)) continue;
    orderedGroups.push(nextGroup);
  }

  return orderedGroups;
};
