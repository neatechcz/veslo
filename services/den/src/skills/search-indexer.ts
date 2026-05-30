const TEXT_FILE_SIZE_LIMIT_BYTES = 128 * 1024

type SearchTextFile = {
  path: string
  text?: string | null
  sizeBytes?: number
  mediaType?: string
}

export type SkillSearchIndexInput = {
  name?: string | null
  description?: string | null
  trigger?: string | null
  tags?: readonly string[] | null
  files?: readonly SearchTextFile[]
}

export type SkillSearchDocument = {
  title: string
  body: string
  searchText: string
}

const CZECH_TO_ENGLISH_TERMS: Record<string, readonly string[]> = {
  akce: ["action"],
  bod: ["item"],
  body: ["items"],
  klient: ["client"],
  klienta: ["client"],
  minutes: ["minutes"],
  poznamka: ["note"],
  poznamky: ["notes"],
  schuzce: ["meeting"],
  schuzka: ["meeting"],
  schuzky: ["meeting"],
  souhrn: ["summary"],
  ukol: ["task", "action item"],
  ukoly: ["tasks", "action items"],
  zapis: ["minutes", "notes", "summary", "record"],
}

const PHRASE_EXPANSIONS: Record<string, readonly string[]> = {
  "zapis schuzky": ["meeting minutes", "meeting notes"],
  "zapis ze schuzky": ["meeting minutes", "meeting notes"],
  "poznamky ze schuzky": ["meeting notes", "meeting minutes"],
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function uniqueValues(values: Iterable<string>): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = normalizeSearchText(value)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function isSearchableTextFile(file: SearchTextFile): boolean {
  if (!file.text) return false
  if (file.sizeBytes !== undefined && file.sizeBytes > TEXT_FILE_SIZE_LIMIT_BYTES) return false
  const mediaType = file.mediaType?.toLowerCase() ?? ""
  if (mediaType.startsWith("text/")) return true
  return /\.(?:md|mdx|txt|ts|tsx|js|jsx|json|yaml|yml|py|sh)$/i.test(file.path)
}

export function buildSkillSearchDocument(input: SkillSearchIndexInput): SkillSearchDocument {
  const fileValues = (input.files ?? [])
    .filter(isSearchableTextFile)
    .flatMap((file) => [file.path, file.text ?? ""])
  const values = [
    input.name,
    input.description,
    input.trigger,
    ...(input.tags ?? []),
    ...fileValues,
  ].filter((value): value is string => typeof value === "string" && value.trim().length > 0)

  return {
    title: input.name?.trim() || "",
    body: values.join("\n"),
    searchText: uniqueValues(values).join(" "),
  }
}

export function expandSkillSearchQuery(query: string, language?: string | null): string[] {
  const normalized = normalizeSearchText(query)
  if (!normalized) return []

  const expanded = new Set<string>([normalized])
  const lang = normalizeSearchText(language ?? "")
  if (lang === "cs" || lang === "cz" || lang === "czech") {
    for (const phrase of PHRASE_EXPANSIONS[normalized] ?? []) {
      expanded.add(phrase)
    }
    for (const token of normalized.split(" ")) {
      expanded.add(token)
      for (const term of CZECH_TO_ENGLISH_TERMS[token] ?? []) {
        expanded.add(term)
      }
    }
  }

  return uniqueValues(expanded)
}

export function queryMatchesSkillSearchText(
  query: string,
  values: readonly (string | null | undefined)[],
  options: { language?: string | null } = {},
): boolean {
  const expanded = expandSkillSearchQuery(query, options.language)
  if (expanded.length === 0) return true

  const haystack = uniqueValues(values.filter((value): value is string => typeof value === "string")).join(" ")
  return expanded.some((term) => haystack.includes(term))
}
