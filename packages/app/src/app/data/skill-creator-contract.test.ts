import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const template = readFileSync(new URL("./skill-creator.md", import.meta.url), "utf8");

test("installable skill creator requires an explicit Veslo skill scope", () => {
  assert.match(template, /Where should this skill live: user skill, workspace skill, organization skill, or public skill\?/);
  assert.match(template, /Do not assume workspace scope/);
  assert.match(template, /User skill -> `scope: "user"`/);
  assert.match(template, /Workspace skill -> `scope: "workspace"`/);
  assert.match(template, /Organization skill -> `scope: "org"`/);
  assert.match(template, /Public skill -> `scope: "system"`/);
  assert.match(template, /POST \/v1\/skills/);
  assert.match(template, /POST \/v1\/skills\/:skillId\/versions/);
  assert.match(template, /POST \/v1\/skills\/:skillId\/review-requests/);
  assert.match(template, /removalPolicy: "locked"/);
});

test("installable skill creator asks for scope before path or API advice", () => {
  const scopeQuestion = template.indexOf(
    "Where should this skill live: user skill, workspace skill, organization skill, or public skill?",
  );
  const pathAdvice = template.indexOf(".opencode/skills");
  const apiAdvice = template.indexOf("POST /v1/skills");
  const firstAdvice = Math.min(...[pathAdvice, apiAdvice].filter((index) => index >= 0));

  assert.notEqual(scopeQuestion, -1);
  assert.notEqual(firstAdvice, Infinity);
  assert.ok(scopeQuestion < firstAdvice);
});

test("installable skill creator does not describe organization or public skills as immediate installs", () => {
  assert.match(template, /Do not claim organization or public skills are distributed/);
  assert.match(template, /Do not treat organization or public skills as immediate installs/);
  assert.match(template, /pending organization approval/);
  assert.match(template, /pending platform approval/);
  assert.doesNotMatch(template, /only in this workspace/);
  assert.doesNotMatch(template, /workspace-only/);
});
