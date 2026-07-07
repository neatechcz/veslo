import type { SkillItem, SkillResolveCandidate, SkillResolveResult } from "./types.js";

const STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "or",
  "for",
  "to",
  "the",
  "this",
  "that",
  "with",
  "from",
  "into",
  "on",
  "in",
  "of",
  "please",
  "use",
  "using",
  "skill",
  "skills",
  "pro",
  "na",
  "do",
  "i",
  "u",
  "v",
  "s",
  "z",
  "k",
  "tohle",
  "tento",
  "tahle",
  "ten",
  "ta",
  "to",
  "prosim",
]);

const SKILL_HINT_WORDS = new Set(["skill", "skills", "dovednost", "dovednosti"]);

const DEFAULT_MATCH_THRESHOLD = 0.58;
const DEFAULT_AMBIGUITY_DELTA = 0.08;
const EXPLICIT_SINGLE_CANDIDATE_FALLBACK_THRESHOLD = 0.15;
const EXPLICIT_MULTI_CANDIDATE_FALLBACK_THRESHOLD = 0.24;

function normalize(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(value: string): string[] {
  return normalize(value)
    .split(/[^a-z0-9]+/g)
    .map((token) => token.trim())
    .filter((token) => token.length >= 2 && !STOP_WORDS.has(token));
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsPhrase(text: string, phrase: string): boolean {
  if (!phrase) return false;
  const regex = new RegExp(`(?:^|[^a-z0-9-])${escapeRegex(phrase)}(?=$|[^a-z0-9-])`, "i");
  return regex.test(text);
}

function extractQuotedPhrases(value: string): string[] {
  const out = new Set<string>();
  const regex = /["'“”‘’]([^"'“”‘’]{3,120})["'“”‘’]/g;
  for (const match of value.matchAll(regex)) {
    const phrase = normalize(match[1] ?? "");
    if (phrase.length >= 3) out.add(phrase);
  }
  return [...out];
}

function overlapRatio(textTokens: Set<string>, skillTokens: Set<string>): number {
  if (skillTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of skillTokens) {
    if (textTokens.has(token)) overlap += 1;
  }
  return overlap / skillTokens.size;
}

function overlapCount(textTokens: Set<string>, skillTokens: Set<string>): number {
  if (skillTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of skillTokens) {
    if (textTokens.has(token)) overlap += 1;
  }
  return overlap;
}

function roundScore(score: number): number {
  return Math.round(score * 1000) / 1000;
}

function isExplicitSkillRequest(normalizedText: string): boolean {
  const asksForSkill = /(?:^|[^a-z0-9])(skill|skills|dovednost|dovednosti)(?=$|[^a-z0-9])/i.test(
    normalizedText,
  );
  if (!asksForSkill) return false;

  return /(?:^|[^a-z0-9])(use|using|run|apply|invoke|load|pouzij|použij|spust|spustit|nacti|načti)(?=$|[^a-z0-9])/i.test(
    normalizedText,
  );
}

export function resolveSkillMatch(input: {
  text: string;
  skills: SkillItem[];
  threshold?: number;
  ambiguityDelta?: number;
  maxCandidates?: number;
}): SkillResolveResult {
  const threshold = typeof input.threshold === "number" ? input.threshold : DEFAULT_MATCH_THRESHOLD;
  const ambiguityDelta = typeof input.ambiguityDelta === "number" ? input.ambiguityDelta : DEFAULT_AMBIGUITY_DELTA;
  const maxCandidates = typeof input.maxCandidates === "number" ? input.maxCandidates : 5;

  const normalizedText = normalize(input.text ?? "");
  if (!normalizedText) {
    return { text: input.text ?? "", match: null, candidates: [] };
  }

  const textTokens = new Set(tokenize(normalizedText));
  const textHasSkillHint = [...SKILL_HINT_WORDS].some((word) =>
    new RegExp(`(?:^|[^a-z0-9])${escapeRegex(word)}(?=$|[^a-z0-9])`, "i").test(normalizedText),
  );
  const explicitSkillRequest = isExplicitSkillRequest(normalizedText);

  const scored: SkillResolveCandidate[] = [];

  for (const skill of input.skills) {
    if (skill.disableModelInvocation) continue;

    const reasons: string[] = [];
    let score = 0;

    const nameNorm = normalize(skill.name);
    const aliases = (skill.aliases ?? []).map((alias) => normalize(alias)).filter(Boolean);
    const triggerNorm = normalize(skill.trigger ?? "");
    const whenNorm = normalize(skill.whenToUse ?? "");
    const descriptionNorm = normalize(skill.description ?? "");

    const exactNameMention = containsPhrase(normalizedText, nameNorm);
    if (exactNameMention) {
      score += 0.78;
      reasons.push("exact-name");
    }

    const aliasHit = aliases.find((alias) => containsPhrase(normalizedText, alias));
    if (aliasHit) {
      score += 0.68;
      reasons.push("alias");
    }

    if (triggerNorm && normalizedText.includes(triggerNorm)) {
      score += 0.25;
      reasons.push("trigger");
    }

    const nameTokens = new Set(tokenize(nameNorm.replace(/-/g, " ")));
    const aliasTokens = new Set(tokenize(aliases.join(" ")));
    const triggerTokens = new Set(tokenize(triggerNorm));
    const whenTokens = new Set(tokenize(whenNorm));
    const descriptionTokens = new Set(tokenize(descriptionNorm));
    const detailTokens = new Set<string>([
      ...nameTokens,
      ...aliasTokens,
      ...triggerTokens,
      ...whenTokens,
      ...descriptionTokens,
    ]);

    const nameOverlap = overlapRatio(textTokens, nameTokens);
    const nameOverlapCount = overlapCount(textTokens, nameTokens);
    if (nameOverlap > 0) {
      score += 0.32 * nameOverlap;
      reasons.push("name-token-overlap");
    }

    const detailOverlap = overlapRatio(textTokens, detailTokens);
    const detailOverlapCount = overlapCount(textTokens, detailTokens);
    if (detailOverlap > 0) {
      score += 0.55 * detailOverlap;
      reasons.push("description-overlap");
    }

    const quotedPhrases = extractQuotedPhrases(
      [skill.description, skill.trigger, skill.whenToUse].filter(Boolean).join(" "),
    );
    const phraseHit = quotedPhrases.find((phrase) => normalizedText.includes(phrase));
    if (phraseHit) {
      score += 0.38;
      reasons.push("quoted-trigger-phrase");
    }

    if (textHasSkillHint && (nameOverlap > 0 || detailOverlap > 0 || exactNameMention || Boolean(aliasHit))) {
      score += 0.06;
      reasons.push("skill-hint");
    }
    if (textHasSkillHint && (nameOverlapCount >= 2 || detailOverlapCount >= 2)) {
      score += 0.22;
      reasons.push("multi-token-skill-match");
    }
    if (detailOverlapCount >= 3) {
      score += 0.1;
      reasons.push("strong-overlap");
    }

    score = Math.min(1, score);
    if (score <= 0) continue;

    scored.push({
      name: skill.name,
      score: roundScore(score),
      reasons,
      description: skill.description,
      trigger: skill.trigger,
    });
  }

  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.name.localeCompare(b.name);
  });

  const candidates = scored.slice(0, Math.max(1, maxCandidates));
  const best = candidates[0];
  const second = candidates[1];
  let match: SkillResolveCandidate | null = null;

  if (best && best.score >= threshold) {
    const bestHasSpecificMention = best.reasons.includes("exact-name") || best.reasons.includes("alias");
    const secondHasSpecificMention = Boolean(
      second && (second.reasons.includes("exact-name") || second.reasons.includes("alias")),
    );
    const ambiguous =
      second &&
      best.score - second.score < ambiguityDelta &&
      !(bestHasSpecificMention && !secondHasSpecificMention);
    if (!ambiguous) {
      match = best;
    }
  }

  if (!match && best && explicitSkillRequest) {
    const secondScore = second?.score ?? 0;
    const gap = best.score - secondScore;
    const singleCandidateFallback =
      candidates.length === 1 && best.score >= EXPLICIT_SINGLE_CANDIDATE_FALLBACK_THRESHOLD;
    const multiCandidateFallback =
      best.score >= EXPLICIT_MULTI_CANDIDATE_FALLBACK_THRESHOLD && gap >= ambiguityDelta;

    if (singleCandidateFallback || multiCandidateFallback) {
      match = {
        ...best,
        reasons: [...best.reasons, "explicit-skill-request-fallback"],
      };
    }
  }

  return {
    text: input.text,
    match,
    candidates,
  };
}
