import { normalizeSkillRegistrySearchQuery } from "./search.js"

export function parseSkillRegistrySearchRouteQuery(query: Record<string, unknown>) {
  const language = typeof query.language === "string" ? query.language.trim() : undefined
  return {
    query: normalizeSkillRegistrySearchQuery(query.q ?? query.query),
    ...(language ? { language } : {}),
  }
}
