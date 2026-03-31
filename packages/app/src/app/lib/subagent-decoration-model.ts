export type SubagentLocale = "cs" | "en";

export const SUBAGENT_DECORATION_PALETTE = [
  "#0f766e",
  "#2563eb",
  "#dc2626",
  "#7c3aed",
  "#ea580c",
  "#0891b2",
  "#16a34a",
  "#db2777",
  "#4f46e5",
  "#ca8a04",
  "#059669",
  "#be185d",
  "#9333ea",
  "#0284c7",
  "#f97316",
  "#65a30d",
  "#7e22ce",
  "#14b8a6",
  "#b45309",
  "#1d4ed8",
  "#c026d3",
  "#15803d",
  "#be123c",
  "#0ea5e9",
] as const;

export type SubagentDecorationRole = {
  roleKey: string;
  roleLabel: string;
  firstNameByLocale: Record<SubagentLocale, string>;
};

export type SubagentDecorationSession = {
  sessionId: string;
  parentSessionId: string;
  roleKey: string;
  roleLabel?: string;
  color?: string;
  occurrenceIndex?: number;
};

export type SubagentDecoration = {
  sessionId: string;
  parentSessionId: string;
  roleKey: string;
  roleLabel: string;
  firstName: string;
  displayName: string;
  color: string;
  locale: SubagentLocale;
  occurrenceIndex: number;
};

export type SubagentDecorationModel = {
  locale: SubagentLocale;
  decorations: SubagentDecoration[];
};

export type SubagentRoleProfile = {
  roleKey: string;
  roleLabel: string;
  firstName: string;
  firstNameByLocale: Record<SubagentLocale, string>;
};

type RoleCatalogEntry = {
  roleKey: string;
  keywords: string[];
  roleLabelByLocale: Record<SubagentLocale, string>;
  firstNameByLocale: Record<SubagentLocale, string>;
};

const ROLE_CATALOG: readonly RoleCatalogEntry[] = [
  {
    roleKey: "web-research",
    keywords: ["research", "search", "lookup", "find", "google", "web", "vyhle", "hled", "internet"],
    roleLabelByLocale: { en: "Web Research", cs: "Webový výzkum" },
    firstNameByLocale: { en: "Alex", cs: "Adam" },
  },
  {
    roleKey: "spreadsheet-processing",
    keywords: ["excel", "spreadsheet", "sheet", "csv", "tabulk", "xls", "xlsx"],
    roleLabelByLocale: { en: "Spreadsheet Processing", cs: "Zpracování tabulek" },
    firstNameByLocale: { en: "Emma", cs: "Ema" },
  },
  {
    roleKey: "document-editing",
    keywords: ["doc", "document", "word", "docs", "text", "edit", "rewrite", "soubor", "dokument"],
    roleLabelByLocale: { en: "Document Editing", cs: "Editace dokumentů" },
    firstNameByLocale: { en: "Nora", cs: "Nora" },
  },
  {
    roleKey: "slides-processing",
    keywords: ["slide", "ppt", "presentation", "deck", "slid", "prezentac"],
    roleLabelByLocale: { en: "Presentation Processing", cs: "Zpracování prezentací" },
    firstNameByLocale: { en: "Liam", cs: "Lukáš" },
  },
  {
    roleKey: "coding",
    keywords: ["code", "coding", "program", "implement", "debug", "refactor", "kód", "bug", "test"],
    roleLabelByLocale: { en: "Coding", cs: "Programování" },
    firstNameByLocale: { en: "Marek", cs: "Marek" },
  },
  {
    roleKey: "data-analysis",
    keywords: ["analysis", "analyze", "analytics", "data", "metrics", "insight", "analýz", "statistik"],
    roleLabelByLocale: { en: "Data Analysis", cs: "Datová analýza" },
    firstNameByLocale: { en: "Sofia", cs: "Sofie" },
  },
];

const GENERAL_FALLBACK_ROLE: RoleCatalogEntry = {
  roleKey: "general-assistant",
  keywords: [],
  roleLabelByLocale: { en: "General Assistant", cs: "Obecný asistent" },
  firstNameByLocale: { en: "Robin", cs: "Robin" },
};

export function normalizeSubagentLocale(value: unknown): SubagentLocale | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "cs" || normalized === "en") return normalized;
  if (normalized === "zh") return "en";
  return null;
}

export function normalizeSubagentRoleKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalized || null;
}

function normalizeLabel(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || null;
}

function normalizeFirstName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || null;
}

function normalizeId(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function normalizeOccurrenceIndex(value: unknown): number | null {
  if (!Number.isFinite(value)) return null;
  const normalized = Math.floor(Number(value));
  return normalized > 0 ? normalized : null;
}

function includesAnyKeyword(haystack: string, keywords: readonly string[]) {
  return keywords.some((keyword) => keyword.length > 0 && haystack.includes(keyword));
}

function roleCatalogEntryForRoleKey(roleKey: string) {
  return ROLE_CATALOG.find((entry) => entry.roleKey === roleKey) ?? null;
}

export function roleProfileFromRoleKey(
  roleKeyInput: string,
  localeInput: SubagentLocale,
): SubagentRoleProfile | null {
  const roleKey = normalizeSubagentRoleKey(roleKeyInput);
  const locale = normalizeSubagentLocale(localeInput);
  if (!roleKey || !locale) return null;
  const entry = roleCatalogEntryForRoleKey(roleKey);
  if (!entry) return null;
  return {
    roleKey: entry.roleKey,
    roleLabel: entry.roleLabelByLocale[locale],
    firstName: entry.firstNameByLocale[locale],
    firstNameByLocale: {
      cs: entry.firstNameByLocale.cs,
      en: entry.firstNameByLocale.en,
    },
  };
}

export function classifySubagentRoleDeterministic(input: {
  locale: SubagentLocale;
  prompt: string;
}): SubagentRoleProfile {
  const locale = normalizeSubagentLocale(input.locale);
  if (!locale) {
    throw new Error("Invalid subagent locale.");
  }
  const prompt = typeof input.prompt === "string" ? input.prompt.toLowerCase() : "";

  const match =
    ROLE_CATALOG.find((entry) => includesAnyKeyword(prompt, entry.keywords)) ??
    GENERAL_FALLBACK_ROLE;

  return {
    roleKey: match.roleKey,
    roleLabel: match.roleLabelByLocale[locale],
    firstName: match.firstNameByLocale[locale],
    firstNameByLocale: {
      cs: match.firstNameByLocale.cs,
      en: match.firstNameByLocale.en,
    },
  };
}

function sanitizeRole(role: SubagentDecorationRole): SubagentDecorationRole | null {
  const roleKey = normalizeSubagentRoleKey(role.roleKey);
  const roleLabel = normalizeLabel(role.roleLabel);
  const firstNameCs = normalizeFirstName(role.firstNameByLocale?.cs);
  const firstNameEn = normalizeFirstName(role.firstNameByLocale?.en);
  if (!roleKey || !roleLabel || !firstNameCs || !firstNameEn) return null;
  return {
    roleKey,
    roleLabel,
    firstNameByLocale: {
      cs: firstNameCs,
      en: firstNameEn,
    },
  };
}

function sanitizeSession(session: SubagentDecorationSession): SubagentDecorationSession | null {
  const sessionId = normalizeId(session.sessionId);
  const parentSessionId = normalizeId(session.parentSessionId);
  const roleKey = normalizeSubagentRoleKey(session.roleKey);
  const roleLabel = normalizeLabel(session.roleLabel ?? "");
  const color = normalizeColor(session.color ?? "");
  const occurrenceIndex = normalizeOccurrenceIndex(session.occurrenceIndex ?? null);
  if (!sessionId || !parentSessionId || !roleKey) return null;
  return {
    sessionId,
    parentSessionId,
    roleKey,
    roleLabel: roleLabel ?? undefined,
    color: color ?? undefined,
    occurrenceIndex: occurrenceIndex ?? undefined,
  };
}

type ParentAllocationState = {
  usedColors: Set<string>;
  usedIndicesByRoleKey: Map<string, Set<number>>;
  paletteCursor: number;
};

function nextFreeColor(parent: ParentAllocationState, palette: readonly string[]) {
  for (let offset = 0; offset < palette.length; offset += 1) {
    const index = (parent.paletteCursor + offset) % palette.length;
    const candidate = palette[index];
    if (!parent.usedColors.has(candidate)) {
      parent.paletteCursor = (index + 1) % palette.length;
      parent.usedColors.add(candidate);
      return candidate;
    }
  }

  // Palette exhausted for this parent: generate deterministic HSL fallbacks.
  let extraIndex = parent.usedColors.size + 1;
  while (true) {
    const candidate = `hsl(${(extraIndex * 47) % 360} 72% 46%)`;
    if (!parent.usedColors.has(candidate)) {
      parent.usedColors.add(candidate);
      return candidate;
    }
    extraIndex += 1;
  }
}

function nextFreeOccurrenceIndex(parent: ParentAllocationState, roleKey: string) {
  const used = parent.usedIndicesByRoleKey.get(roleKey) ?? new Set<number>();
  let index = 1;
  while (used.has(index)) index += 1;
  used.add(index);
  parent.usedIndicesByRoleKey.set(roleKey, used);
  return index;
}

export function buildSubagentDecorationModel(input: {
  locale: SubagentLocale;
  roles: SubagentDecorationRole[];
  sessions: SubagentDecorationSession[];
  palette?: readonly string[];
}): SubagentDecorationModel {
  const locale = normalizeSubagentLocale(input.locale);
  if (!locale) {
    throw new Error("Invalid subagent locale.");
  }

  const palette = input.palette ?? SUBAGENT_DECORATION_PALETTE;
  if (!Array.isArray(palette) || palette.length === 0) {
    throw new Error("Subagent decoration palette is empty.");
  }

  const roleByKey = new Map<string, SubagentDecorationRole>();
  for (const rawRole of input.roles) {
    const role = sanitizeRole(rawRole);
    if (!role) continue;
    roleByKey.set(role.roleKey, role);
  }

  const sessions = input.sessions
    .map((entry) => sanitizeSession(entry))
    .filter((entry): entry is SubagentDecorationSession => Boolean(entry))
    .sort((left, right) => {
      if (left.parentSessionId !== right.parentSessionId) {
        return left.parentSessionId.localeCompare(right.parentSessionId);
      }
      if (left.roleKey !== right.roleKey) return left.roleKey.localeCompare(right.roleKey);
      if (left.sessionId !== right.sessionId) return left.sessionId.localeCompare(right.sessionId);
      return 0;
    });

  const parentStateById = new Map<string, ParentAllocationState>();
  const getParentState = (parentSessionId: string) => {
    const existing = parentStateById.get(parentSessionId);
    if (existing) return existing;
    const next: ParentAllocationState = {
      usedColors: new Set<string>(),
      usedIndicesByRoleKey: new Map<string, Set<number>>(),
      paletteCursor: 0,
    };
    parentStateById.set(parentSessionId, next);
    return next;
  };

  const decorations: SubagentDecoration[] = [];

  for (const session of sessions) {
    const parentState = getParentState(session.parentSessionId);
    const roleFromRegistry = roleByKey.get(session.roleKey);
    const roleFromCatalog = roleCatalogEntryForRoleKey(session.roleKey);

    const roleLabel =
      roleFromRegistry?.roleLabel ??
      session.roleLabel ??
      roleFromCatalog?.roleLabelByLocale[locale] ??
      roleFromCatalog?.roleLabelByLocale.en ??
      "General Assistant";

    const firstNameByLocale = roleFromRegistry?.firstNameByLocale ??
      roleFromCatalog?.firstNameByLocale ??
      GENERAL_FALLBACK_ROLE.firstNameByLocale;
    const firstName = normalizeFirstName(firstNameByLocale[locale]) ??
      normalizeFirstName(firstNameByLocale.en) ??
      "Robin";

    let occurrenceIndex = normalizeOccurrenceIndex(session.occurrenceIndex ?? null);
    if (occurrenceIndex) {
      const used = parentState.usedIndicesByRoleKey.get(session.roleKey) ?? new Set<number>();
      if (used.has(occurrenceIndex)) {
        occurrenceIndex = null;
      } else {
        used.add(occurrenceIndex);
        parentState.usedIndicesByRoleKey.set(session.roleKey, used);
      }
    }
    if (!occurrenceIndex) {
      occurrenceIndex = nextFreeOccurrenceIndex(parentState, session.roleKey);
    }

    let color = normalizeColor(session.color ?? null);
    if (color) {
      if (parentState.usedColors.has(color)) {
        color = null;
      } else {
        parentState.usedColors.add(color);
      }
    }
    if (!color) {
      color = nextFreeColor(parentState, palette);
    }

    decorations.push({
      sessionId: session.sessionId,
      parentSessionId: session.parentSessionId,
      roleKey: session.roleKey,
      roleLabel,
      firstName,
      displayName: occurrenceIndex === 1 ? firstName : `${firstName} #${occurrenceIndex}`,
      color,
      locale,
      occurrenceIndex,
    });
  }

  return { locale, decorations };
}
