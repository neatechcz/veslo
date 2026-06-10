import { expect, test } from "bun:test";

import { parseSkillMarkdownMetadata } from "../skill-metadata.js";

test("parseSkillMarkdownMetadata extracts normalized local skill metadata", () => {
  const metadata = parseSkillMarkdownMetadata(
    [
      "---",
      "name: research-helper",
      "description:   Helps with research   ",
      "aliases:",
      "  - research",
      "  - source lookup",
      "paths: docs/**",
      "disable-model-invocation: yes",
      "user-invocable: false",
      "---",
      "",
      "# Research helper",
      "",
      "## When to use",
      "- Use for source-backed research requests.",
      "",
    ].join("\n"),
    {
      expectedName: "research-helper",
      fallbackName: "research-helper",
      requireDescription: true,
    },
  );

  expect(metadata).toEqual({
    aliases: ["research", "source lookup"],
    description: "Helps with research",
    disableModelInvocation: true,
    name: "research-helper",
    paths: ["docs/**"],
    trigger: "Use for source-backed research requests.",
    userInvocable: false,
  });
});

test("parseSkillMarkdownMetadata prefers explicit trigger and validates expected names", () => {
  expect(
    parseSkillMarkdownMetadata(
      [
        "---",
        "name: local-skill",
        "description: Local skill",
        "when: explicit trigger",
        "---",
        "",
        "## When to use",
        "- fallback trigger",
      ].join("\n"),
      {
        expectedName: "local-skill",
        fallbackName: "local-skill",
        requireDescription: true,
      },
    ).trigger,
  ).toBe("explicit trigger");

  expect(() =>
    parseSkillMarkdownMetadata("---\nname: other-skill\ndescription: Other\n---\n", {
      expectedName: "local-skill",
      fallbackName: "local-skill",
      requireDescription: true,
    }),
  ).toThrow(/must match/i);
});

test("parseSkillMarkdownMetadata accepts hub skill metadata without local-only fields", () => {
  const metadata = parseSkillMarkdownMetadata(
    [
      "---",
      "name: hub-skill",
      "description: Hub catalog skill",
      "---",
      "",
      "# Hub skill",
      "",
      "## When to use",
      "1. Run for catalog-backed installs.",
    ].join("\n"),
    {
      expectedName: "hub-skill",
      fallbackName: "hub-skill",
      descriptionMaxLength: 1024,
    },
  );

  expect(metadata).toEqual({
    description: "Hub catalog skill",
    name: "hub-skill",
    trigger: "Run for catalog-backed installs.",
  });
});
