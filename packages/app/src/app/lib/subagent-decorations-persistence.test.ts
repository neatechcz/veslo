import assert from "node:assert/strict";
import test from "node:test";

import {
  emptySubagentDecorationsPersistence,
  parseSubagentDecorationsPersistence,
  serializeSubagentDecorationsPersistence,
} from "./subagent-decorations-persistence.js";

test("rejects invalid subagent decorations payloads", () => {
  const invalidPayloads = [
    null,
    "",
    "{",
    JSON.stringify({ schemaVersion: 2, type: "subagent-decorations" }),
    JSON.stringify({ schemaVersion: 1, type: "something-else" }),
    JSON.stringify({
      schemaVersion: 1,
      type: "subagent-decorations",
      roles: "broken",
      sessions: [],
    }),
  ];

  for (const payload of invalidPayloads) {
    assert.equal(parseSubagentDecorationsPersistence(payload), null);
  }
});

test("serializing an empty state returns null", () => {
  assert.equal(serializeSubagentDecorationsPersistence(emptySubagentDecorationsPersistence()), null);
});

test("normalizes, serializes, and round-trips role+session decoration payloads", () => {
  const next = serializeSubagentDecorationsPersistence({
    schemaVersion: 1,
    type: "subagent-decorations",
    roles: [
      {
        roleKey: "  Docx Writer  ",
        roleLabel: "  Document Writer  ",
        firstNameByLocale: { cs: "  Anna  ", en: "  Annie  " },
      },
      {
        roleKey: "PPTX-Editor",
        roleLabel: " Presentation Editor ",
        firstNameByLocale: { cs: "Eva", en: "  Eve " },
      },
    ],
    sessions: [
      {
        sessionId: " child-b ",
        workspaceId: " ws-1 ",
        parentSessionId: " parent-a ",
        roleKey: " PPTX-EDITOR ",
        roleLabel: " Presentation Editor ",
        color: " #2563eb ",
        occurrenceIndex: 2.9,
      },
      {
        sessionId: " child-a ",
        workspaceId: " ws-1 ",
        parentSessionId: " parent-a ",
        roleKey: " DOCX WRITER ",
        roleLabel: " Document Writer ",
        color: "#0f766e",
        occurrenceIndex: 1,
      },
    ],
  });

  assert.equal(
    next,
    JSON.stringify({
      schemaVersion: 1,
      type: "subagent-decorations",
      roles: [
        {
          roleKey: "docx-writer",
          roleLabel: "Document Writer",
          firstNameByLocale: { cs: "Anna", en: "Annie" },
        },
        {
          roleKey: "pptx-editor",
          roleLabel: "Presentation Editor",
          firstNameByLocale: { cs: "Eva", en: "Eve" },
        },
      ],
      sessions: [
        {
          sessionId: "child-a",
          workspaceId: "ws-1",
          parentSessionId: "parent-a",
          roleKey: "docx-writer",
          roleLabel: "Document Writer",
          color: "#0f766e",
          occurrenceIndex: 1,
        },
        {
          sessionId: "child-b",
          workspaceId: "ws-1",
          parentSessionId: "parent-a",
          roleKey: "pptx-editor",
          roleLabel: "Presentation Editor",
          color: "#2563eb",
          occurrenceIndex: 2,
        },
      ],
    }),
  );

  assert.deepEqual(parseSubagentDecorationsPersistence(next), {
    schemaVersion: 1,
    type: "subagent-decorations",
    roles: [
      {
        roleKey: "docx-writer",
        roleLabel: "Document Writer",
        firstNameByLocale: { cs: "Anna", en: "Annie" },
      },
      {
        roleKey: "pptx-editor",
        roleLabel: "Presentation Editor",
        firstNameByLocale: { cs: "Eva", en: "Eve" },
      },
    ],
    sessions: [
      {
        sessionId: "child-a",
        workspaceId: "ws-1",
        parentSessionId: "parent-a",
        roleKey: "docx-writer",
        roleLabel: "Document Writer",
        color: "#0f766e",
        occurrenceIndex: 1,
      },
      {
        sessionId: "child-b",
        workspaceId: "ws-1",
        parentSessionId: "parent-a",
        roleKey: "pptx-editor",
        roleLabel: "Presentation Editor",
        color: "#2563eb",
        occurrenceIndex: 2,
      },
    ],
  });
});
