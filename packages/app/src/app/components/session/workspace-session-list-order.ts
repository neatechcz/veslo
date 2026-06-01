export const applyProjectOrder = <T extends { key: string }>(groups: T[], storedOrder: string[]): T[] => {
  if (!groups.length) return [];

  const byKey = new Map(groups.map((group) => [group.key, group] as const));
  const ordered: T[] = [];
  const used = new Set<string>();
  const storedKeys = new Set(
    storedOrder.map((rawKey) => rawKey.trim()).filter(Boolean),
  );

  for (const group of groups) {
    if (storedKeys.has(group.key) || used.has(group.key)) continue;
    used.add(group.key);
    ordered.push(group);
  }

  for (const rawKey of storedOrder) {
    const key = rawKey.trim();
    if (!key || used.has(key)) continue;
    const group = byKey.get(key);
    if (!group) continue;
    used.add(key);
    ordered.push(group);
  }

  return ordered;
};

export type ProjectDropPosition = "before" | "after";

export const reorderProjectKeys = (
  keys: string[],
  sourceKey: string,
  targetKey: string,
  position: ProjectDropPosition = "before",
): string[] => {
  const source = sourceKey.trim();
  const target = targetKey.trim();
  if (!source || !target || source === target) return keys.slice();

  const sourceIndex = keys.indexOf(source);
  const targetIndex = keys.indexOf(target);
  if (sourceIndex < 0 || targetIndex < 0) return keys.slice();

  const next = keys.slice();
  const [moved] = next.splice(sourceIndex, 1);
  const adjustedTargetIndex = sourceIndex < targetIndex ? targetIndex - 1 : targetIndex;
  const insertIndex = position === "after" ? adjustedTargetIndex + 1 : adjustedTargetIndex;
  next.splice(insertIndex, 0, moved);
  return next;
};

export const promoteProjectKeyInOrder = (storedOrder: string[], projectKey: string): string[] => {
  const promotedKey = projectKey.trim();
  if (!promotedKey) return storedOrder.map((rawKey) => rawKey.trim()).filter(Boolean);

  const next = [promotedKey];
  const used = new Set(next);
  for (const rawKey of storedOrder) {
    const key = rawKey.trim();
    if (!key || used.has(key)) continue;
    used.add(key);
    next.push(key);
  }
  return next;
};

export const mergeVisibleOrder = (storedOrder: string[], visibleOrderedKeys: string[]): string[] => {
  const normalizedVisible = [] as string[];
  const visibleSet = new Set<string>();

  for (const rawKey of visibleOrderedKeys) {
    const key = rawKey.trim();
    if (!key || visibleSet.has(key)) continue;
    visibleSet.add(key);
    normalizedVisible.push(key);
  }

  let visibleIndex = 0;
  const next: string[] = [];
  const usedVisible = new Set<string>();

  for (const rawKey of storedOrder) {
    const key = rawKey.trim();
    if (!key) continue;
    if (!visibleSet.has(key)) {
      next.push(key);
      continue;
    }

    while (visibleIndex < normalizedVisible.length && usedVisible.has(normalizedVisible[visibleIndex])) {
      visibleIndex += 1;
    }

    const replacement = normalizedVisible[visibleIndex];
    if (!replacement) continue;
    usedVisible.add(replacement);
    next.push(replacement);
    visibleIndex += 1;
  }

  for (const key of normalizedVisible) {
    if (usedVisible.has(key)) continue;
    next.push(key);
  }

  return next;
};
