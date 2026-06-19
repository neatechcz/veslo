import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSubagentDecorationModel,
  classifySubagentRoleDeterministic,
  SUBAGENT_DECORATION_PALETTE,
} from "../../lib/subagent-decoration-model.js";

test("deterministic classifier keeps stable role mapping for common topics", () => {
  const research = classifySubagentRoleDeterministic({
    locale: "cs",
    prompt: "prosím vyhledej na webu benchmarky",
  });
  const spreadsheet = classifySubagentRoleDeterministic({
    locale: "en",
    prompt: "process two excel sheets in parallel",
  });

  assert.equal(research.roleKey, "web-research");
  assert.equal(spreadsheet.roleKey, "spreadsheet-processing");
  assert.equal(spreadsheet.firstName, "Emma");
});

test("build model uses locale-specific first names and suffixes duplicate roles per parent", () => {
  const model = buildSubagentDecorationModel({
    locale: "cs",
    roles: [
      {
        roleKey: "web-research",
        roleLabel: "Webový výzkum",
        firstNameByLocale: { cs: "Adam", en: "Alex" },
      },
      {
        roleKey: "spreadsheet-processing",
        roleLabel: "Zpracování tabulek",
        firstNameByLocale: { cs: "Ema", en: "Emma" },
      },
    ],
    sessions: [
      {
        sessionId: "child-a",
        parentSessionId: "parent-1",
        roleKey: "web-research",
      },
      {
        sessionId: "child-b",
        parentSessionId: "parent-1",
        roleKey: "web-research",
      },
      {
        sessionId: "child-c",
        parentSessionId: "parent-1",
        roleKey: "spreadsheet-processing",
      },
      {
        sessionId: "child-d",
        parentSessionId: "parent-2",
        roleKey: "web-research",
      },
    ],
  });

  const bySessionId = new Map(model.decorations.map((entry) => [entry.sessionId, entry] as const));
  assert.equal(bySessionId.get("child-a")?.displayName, "Adam");
  assert.equal(bySessionId.get("child-b")?.displayName, "Adam #2");
  assert.equal(bySessionId.get("child-c")?.displayName, "Ema");
  assert.equal(bySessionId.get("child-d")?.displayName, "Adam");
});

test("build model keeps colors unique within one parent and honors persisted colors", () => {
  const model = buildSubagentDecorationModel({
    locale: "en",
    roles: [
      {
        roleKey: "web-research",
        roleLabel: "Web Research",
        firstNameByLocale: { cs: "Adam", en: "Alex" },
      },
    ],
    sessions: [
      {
        sessionId: "child-a",
        parentSessionId: "parent-1",
        roleKey: "web-research",
        color: "#123456",
        occurrenceIndex: 2,
      },
      {
        sessionId: "child-b",
        parentSessionId: "parent-1",
        roleKey: "web-research",
        color: "#123456",
      },
      {
        sessionId: "child-c",
        parentSessionId: "parent-1",
        roleKey: "web-research",
      },
    ],
  });

  const colors = model.decorations.map((entry) => entry.color);
  assert.equal(colors[0], "#123456");
  assert.equal(new Set(colors).size, colors.length);
  assert.equal(colors[1], SUBAGENT_DECORATION_PALETTE[0]);
  assert.equal(colors[2], SUBAGENT_DECORATION_PALETTE[1]);

  const bySessionId = new Map(model.decorations.map((entry) => [entry.sessionId, entry] as const));
  assert.equal(bySessionId.get("child-a")?.displayName, "Alex #2");
  assert.equal(bySessionId.get("child-b")?.displayName, "Alex");
  assert.equal(bySessionId.get("child-c")?.displayName, "Alex #3");
});

test("build model prefers catalog localization for known role keys", () => {
  const model = buildSubagentDecorationModel({
    locale: "en",
    roles: [
      {
        roleKey: "web-research",
        roleLabel: "Webový výzkum",
        firstNameByLocale: { cs: "Adam", en: "Alex" },
      },
    ],
    sessions: [
      {
        sessionId: "child-a",
        parentSessionId: "parent-1",
        roleKey: "web-research",
      },
    ],
  });

  const decoration = model.decorations[0];
  assert.equal(decoration?.roleLabel, "Web Research");
});
