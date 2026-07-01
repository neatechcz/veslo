import { describe, expect, test } from "bun:test";
import type { SkillItem } from "../types.js";
import { resolveSkillMatch } from "../skill-resolver.js";

function skill(overrides: Partial<SkillItem> & Pick<SkillItem, "name" | "description">): SkillItem {
  return {
    name: overrides.name,
    description: overrides.description,
    path: overrides.path ?? `/tmp/${overrides.name}/SKILL.md`,
    scope: overrides.scope ?? "project",
    trigger: overrides.trigger,
    disableModelInvocation: overrides.disableModelInvocation,
    userInvocable: overrides.userInvocable,
    aliases: overrides.aliases,
    whenToUse: overrides.whenToUse,
    paths: overrides.paths,
  };
}

describe("resolveSkillMatch", () => {
  test("prefers explicit skill-name mention", () => {
    const skills: SkillItem[] = [
      skill({
        name: "company-research-czech",
        description: "Use when user asks to research a company in Czech context.",
      }),
      skill({
        name: "pdf-rotate",
        description: "Use when user asks to rotate PDF pages.",
      }),
    ];

    const result = resolveSkillMatch({
      text: "use company-research-czech skill for this",
      skills,
    });

    expect(result.match?.name).toBe("company-research-czech");
    expect(result.candidates[0]?.name).toBe("company-research-czech");
    expect((result.candidates[0]?.score ?? 0) >= 0.8).toBe(true);
  });

  test("matches by description/trigger phrases without exact name", () => {
    const skills: SkillItem[] = [
      skill({
        name: "company-research-czech",
        description: "Use when user asks for company search and profile extraction from a website.",
        trigger: "company search",
      }),
      skill({
        name: "release-notes",
        description: "Use when user asks to summarize release changes.",
      }),
    ];

    const result = resolveSkillMatch({
      text: "https://www.evoptima.com/en/homepage use company search skill for this",
      skills,
    });

    expect(result.match?.name).toBe("company-research-czech");
  });

  test("matches the platform DOCX skill from MS Word wording", () => {
    const skills: SkillItem[] = [
      skill({
        name: "veslo-docx",
        description: "Create, edit, analyze, convert, and validate Word DOCX documents using standard skill execution.",
        aliases: ["MS Word", "Microsoft Word"],
        whenToUse: "Use for Word and DOCX document workflows.",
        scope: "global",
      }),
      skill({
        name: "veslo-pdf",
        description: "Extract, create, merge, split, annotate, fill forms, and validate PDF documents.",
        aliases: ["PDF"],
        scope: "global",
      }),
    ];

    const result = resolveSkillMatch({
      text: "pouzij MS Word skill a priprav upravu brief.docx",
      skills,
    });

    expect(result.match?.name).toBe("veslo-docx");
    expect(result.candidates[0]?.name).toBe("veslo-docx");
    expect(result.candidates.some((candidate) => candidate.name === "veslo-pdf")).toBe(false);
  });

  test("uses explicit-skill fallback when only one candidate is plausible", () => {
    const skills: SkillItem[] = [
      skill({
        name: "czech-company-financials",
        description: "Extract turnover, profit, and key financial data for Czech companies.",
        trigger: "Use this skill when the user asks for Czech company financial data from justice.cz.",
      }),
      skill({
        name: "workspace-guide",
        description: "Guide users through workspace onboarding.",
      }),
      skill({
        name: "get-started",
        description: "Intro setup flow.",
      }),
    ];

    const result = resolveSkillMatch({
      text: "https://www.evoptima.com/en/homepage use company search skill for this",
      skills,
    });

    expect(result.match?.name).toBe("czech-company-financials");
    expect(result.match?.reasons.includes("explicit-skill-request-fallback")).toBe(true);
  });

  test("does not auto-match when scores are low", () => {
    const skills: SkillItem[] = [
      skill({
        name: "pdf-rotate",
        description: "Rotate pages in PDF files.",
      }),
      skill({
        name: "xlsx-formulas",
        description: "Create and edit spreadsheet formulas.",
      }),
    ];

    const result = resolveSkillMatch({
      text: "write a haiku about spring weather",
      skills,
    });

    expect(result.match).toBeNull();
  });

  test("does not force a match for explicit skill request without any overlap", () => {
    const skills: SkillItem[] = [
      skill({
        name: "pdf-rotate",
        description: "Rotate pages in PDF files.",
      }),
      skill({
        name: "xlsx-formulas",
        description: "Create and edit spreadsheet formulas.",
      }),
    ];

    const result = resolveSkillMatch({
      text: "use skill for this, write a short poem about spring",
      skills,
    });

    expect(result.match).toBeNull();
  });

  test("skips skills with disable-model-invocation", () => {
    const skills: SkillItem[] = [
      skill({
        name: "company-research-czech",
        description: "Use for company search.",
        disableModelInvocation: true,
      }),
      skill({
        name: "general-company-research",
        description: "Use when user asks for company profile research.",
      }),
    ];

    const result = resolveSkillMatch({
      text: "use company research skill for this",
      skills,
    });

    expect(result.match?.name).toBe("general-company-research");
    expect(result.candidates.some((candidate) => candidate.name === "company-research-czech")).toBe(false);
  });
});
