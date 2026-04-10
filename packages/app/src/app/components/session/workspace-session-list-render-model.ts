type ResolveRenderableProjectGroupsInput<T> = {
  suspended: boolean;
  previousGroups: T[];
  nextGroups: T[];
};

export const resolveRenderableProjectGroups = <T>(
  input: ResolveRenderableProjectGroupsInput<T>,
): T[] => {
  if (!input.suspended) return input.nextGroups;
  if (input.previousGroups.length === 0) return input.nextGroups;
  return input.previousGroups;
};
