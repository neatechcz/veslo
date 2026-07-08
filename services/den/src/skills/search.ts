export function normalizeSkillRegistrySearchQuery(value: unknown): string {
  if (typeof value !== "string") {
    return ""
  }
  return value.trim()
}

function queryMatchesSkillText(query: string, values: readonly (string | null | undefined)[]) {
  const normalized = query.trim().toLowerCase()
  if (!normalized) {
    return true
  }

  return values
    .filter((value): value is string => typeof value === "string" && value.length > 0)
    .some((value) => value.toLowerCase().includes(normalized))
}
