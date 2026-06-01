import { parseFrontmatter } from "./frontmatter.js";
import { validateDescription, validateSkillName } from "./validators.js";

export type SkillMarkdownMetadata = {
  name: string;
  description?: string;
  trigger?: string;
  aliases?: string[];
  paths?: string[];
  tags?: string[];
  language?: string;
  disableModelInvocation?: boolean;
  userInvocable?: boolean;
  whenToUse?: string;
};

export type ParseSkillMarkdownMetadataOptions = {
  fallbackName: string;
  expectedName?: string;
  requireDescription?: boolean;
  descriptionMaxLength?: number;
};

const normalizeText = (value: unknown): string | undefined => {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ");
  return normalized || undefined;
};

const parseBoolean = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes"].includes(normalized)) return true;
  if (["false", "0", "no"].includes(normalized)) return false;
  return undefined;
};

const parseStringList = (value: unknown): string[] | undefined => {
  if (Array.isArray(value)) {
    const items = value.map(normalizeText).filter((entry): entry is string => Boolean(entry));
    return items.length ? items : undefined;
  }
  const single = normalizeText(value);
  return single ? [single] : undefined;
};

export const extractTriggerFromSkillBody = (body: string): string => {
  const lines = body.split(/\r?\n/);
  let inWhenSection = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (/^#{1,6}\s+/.test(trimmed)) {
      const heading = trimmed.replace(/^#{1,6}\s+/, "").trim();
      inWhenSection = /^when to use$/i.test(heading);
      continue;
    }

    if (!inWhenSection) continue;

    const cleaned = trimmed
      .replace(/^[-*+]\s+/, "")
      .replace(/^\d+[.)]\s+/, "")
      .trim();

    if (cleaned) return cleaned;
  }

  return "";
};

export function parseSkillMarkdownMetadata(
  markdown: string,
  options: ParseSkillMarkdownMetadataOptions,
): SkillMarkdownMetadata {
  const { data, body } = parseFrontmatter(markdown);
  const name = normalizeText(data.name) ?? options.fallbackName;

  validateSkillName(name);
  if (options.expectedName && name !== options.expectedName) {
    throw new Error(`Skill frontmatter name must match expected name '${options.expectedName}'.`);
  }

  const descriptionRaw = normalizeText(data.description);
  const description = options.descriptionMaxLength && descriptionRaw
    ? descriptionRaw.slice(0, options.descriptionMaxLength)
    : descriptionRaw;
  if (options.requireDescription) {
    validateDescription(description);
  }

  const trigger =
    normalizeText(data.trigger) ??
    normalizeText(data.when) ??
    normalizeText(extractTriggerFromSkillBody(body));
  const whenToUse = normalizeText(data.when_to_use) ?? normalizeText(data.whenToUse);
  const aliases = parseStringList(data.aliases);
  const paths = parseStringList(data.paths);
  const tags = parseStringList(data.tags);
  const language = normalizeText(data.language);
  const disableModelInvocation =
    parseBoolean(data["disable-model-invocation"]) ??
    parseBoolean(data.disableModelInvocation);
  const userInvocable =
    parseBoolean(data["user-invocable"]) ??
    parseBoolean(data.userInvocable);

  return {
    name,
    ...(description ? { description } : {}),
    ...(trigger ? { trigger } : {}),
    ...(aliases ? { aliases } : {}),
    ...(paths ? { paths } : {}),
    ...(tags ? { tags } : {}),
    ...(language ? { language } : {}),
    ...(disableModelInvocation !== undefined ? { disableModelInvocation } : {}),
    ...(userInvocable !== undefined ? { userInvocable } : {}),
    ...(whenToUse ? { whenToUse } : {}),
  };
}
