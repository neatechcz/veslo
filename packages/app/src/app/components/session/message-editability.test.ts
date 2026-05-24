import assert from "node:assert/strict";
import test from "node:test";

import type { Part } from "@opencode-ai/sdk/v2/client";
import type { MessageWithParts } from "../../types";
import { getEditableUserMessageDraft } from "./message-editability";

const textPart = (messageID: string, text: string): Part => ({
  id: `${messageID}:text`,
  sessionID: "s1",
  messageID,
  type: "text",
  text,
} as Part);

const agentPart = (messageID: string, name: string): Part => ({
  id: `${messageID}:agent`,
  sessionID: "s1",
  messageID,
  type: "agent",
  name,
} as unknown as Part);

const filePart = (messageID: string, path: string, label?: string): Part => ({
  id: `${messageID}:file`,
  sessionID: "s1",
  messageID,
  type: "file",
  path,
  label,
} as unknown as Part);

const fileUrlPart = (messageID: string, url: string, filename?: string): Part => ({
  id: `${messageID}:file-url`,
  sessionID: "s1",
  messageID,
  type: "file",
  mime: "text/plain",
  url,
  filename,
} as unknown as Part);

const dataFilePart = (messageID: string, mime: string, filename: string): Part => ({
  id: `${messageID}:data-file`,
  sessionID: "s1",
  messageID,
  type: "file",
  mime,
  url: `data:${mime};base64,abc`,
  filename,
} as unknown as Part);

const toolPart = (messageID: string, tool: string): Part => ({
  id: `${messageID}:${tool}`,
  sessionID: "s1",
  messageID,
  type: "tool",
  tool,
} as unknown as Part);

const reasoningPart = (messageID: string): Part => ({
  id: `${messageID}:reasoning`,
  sessionID: "s1",
  messageID,
  type: "reasoning",
} as unknown as Part);

const stepPart = (messageID: string, type: "step-start" | "step-finish"): Part => ({
  id: `${messageID}:${type}`,
  sessionID: "s1",
  messageID,
  type,
} as unknown as Part);

const message = (id: string, role: "user" | "assistant", parts: Part[]): MessageWithParts => ({
  info: { id, role } as any,
  parts,
});

test("allows editing latest user message after read-only assistant activity", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [textPart("m1", "original")]),
      message("m2", "assistant", [
        reasoningPart("m2"),
        toolPart("m2", "read"),
        toolPart("m2", "search"),
        toolPart("m2", "list"),
      ]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result?.messageId, "m1");
  assert.equal(result?.draft.text, "original");
  assert.equal(result?.draft.resolvedText, "original");
  assert.deepEqual(result?.draft.parts, [{ type: "text", text: "original" }]);
  assert.equal(result?.draft.mode, "prompt");
  assert.deepEqual(result?.draft.attachments, []);
});

test("visible assistant text blocks editing", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [textPart("m1", "original")]),
      message("m2", "assistant", [textPart("m2", "visible answer")]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result, null);
});

test("assistant step markers and blank text after user message do not block editing", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [textPart("m1", "original")]),
      message("m2", "assistant", [
        stepPart("m2", "step-start"),
        textPart("m2", " \n\t "),
        stepPart("m2", "step-finish"),
      ]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result?.messageId, "m1");
  assert.equal(result?.draft.text, "original");
});

test("whitespace-only assistant text after user message does not block editing", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [textPart("m1", "original")]),
      message("m2", "assistant", [textPart("m2", " \n\t ")]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result?.messageId, "m1");
  assert.equal(result?.draft.text, "original");
});

test("mutating tools block editing", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [textPart("m1", "original")]),
      message("m2", "assistant", [toolPart("m2", "write")]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result, null);
});

test("list_files is read-only assistant activity", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [textPart("m1", "original")]),
      message("m2", "assistant", [toolPart("m2", "list_files")]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result?.messageId, "m1");
  assert.equal(result?.draft.text, "original");
});

test("shell and terminal tools block editing by default", () => {
  for (const tool of ["shell", "terminal", "bash"]) {
    const result = getEditableUserMessageDraft({
      messages: [
        message("m1", "user", [textPart("m1", "original")]),
        message("m2", "assistant", [toolPart("m2", tool)]),
      ],
      sessionIdle: true,
      queueEmpty: true,
      composerEmpty: true,
    });

    assert.equal(result, null, `${tool} should block editing`);
  }
});

test("older user messages are not editable", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [textPart("m1", "older")]),
      message("m2", "assistant", [reasoningPart("m2")]),
      message("m3", "user", [textPart("m3", "latest")]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result?.messageId, "m3");
  assert.equal(result?.draft.text, "latest");
});

test("unreconstructable attachments block editing", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [
        textPart("m1", "see image"),
        {
          id: "m1:image",
          sessionID: "s1",
          messageID: "m1",
          type: "file",
          mime: "image/png",
          url: "data:image/png;base64,abc",
        } as unknown as Part,
      ]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result, null);
});

test("non-image data file attachments represented by path text do not block reconstruction", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [
        textPart("m1", "Review this:\nsession/brief.docx"),
        dataFilePart(
          "m1",
          "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          "brief.docx",
        ),
      ]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result?.messageId, "m1");
  assert.equal(result?.draft.text, "Review this:\nsession/brief.docx");
  assert.deepEqual(result?.draft.parts, [{ type: "text", text: "Review this:\nsession/brief.docx" }]);
  assert.deepEqual(result?.draft.attachments, []);
});

test("session must be idle, queue must be empty, and composer must be empty", () => {
  const base = {
    messages: [message("m1", "user", [textPart("m1", "original")])],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  };

  assert.equal(getEditableUserMessageDraft({ ...base, sessionIdle: false }), null);
  assert.equal(getEditableUserMessageDraft({ ...base, queueEmpty: false }), null);
  assert.equal(getEditableUserMessageDraft({ ...base, composerEmpty: false }), null);
});

test("reconstructs agents and file references into composer parts", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [
        textPart("m1", "ask "),
        agentPart("m1", "reviewer"),
        textPart("m1", " about "),
        filePart("m1", "src/app.ts", "app.ts"),
      ]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result?.draft.text, "ask @reviewer about @src/app.ts");
  assert.equal(result?.draft.resolvedText, "ask @reviewer about @src/app.ts");
  assert.deepEqual(result?.draft.parts, [
    { type: "text", text: "ask " },
    { type: "agent", name: "reviewer" },
    { type: "text", text: " about " },
    { type: "file", path: "src/app.ts", label: "app.ts" },
  ]);
});

test("replaces matching resolved agent tokens instead of duplicating sent agent parts", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [
        textPart("m1", "ask @reviewer to check"),
        agentPart("m1", "reviewer"),
      ]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result?.draft.text, "ask @reviewer to check");
  assert.equal(result?.draft.resolvedText, "ask @reviewer to check");
  assert.deepEqual(result?.draft.parts, [
    { type: "text", text: "ask " },
    { type: "agent", name: "reviewer" },
    { type: "text", text: " to check" },
  ]);
});

test("reconstructs file URL references from sent composer file parts", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [
        textPart("m1", "read @/Users/me/project/docs/hello world.md"),
        fileUrlPart("m1", "file:///Users/me/project/docs/hello%20world.md", "hello world.md"),
      ]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result?.draft.text, "read @/Users/me/project/docs/hello world.md");
  assert.equal(result?.draft.resolvedText, "read @/Users/me/project/docs/hello world.md");
  assert.deepEqual(result?.draft.parts, [
    { type: "text", text: "read " },
    { type: "file", path: "/Users/me/project/docs/hello world.md", label: "hello world.md" },
  ]);
});

test("replaces matching resolved file path tokens instead of duplicating sent file parts", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [
        textPart("m1", "compare @/Users/me/project/docs/hello world.md and continue"),
        fileUrlPart("m1", "file:///Users/me/project/docs/hello%20world.md", "hello world.md"),
      ]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result?.draft.text, "compare @/Users/me/project/docs/hello world.md and continue");
  assert.equal(result?.draft.resolvedText, "compare @/Users/me/project/docs/hello world.md and continue");
  assert.deepEqual(result?.draft.parts, [
    { type: "text", text: "compare " },
    { type: "file", path: "/Users/me/project/docs/hello world.md", label: "hello world.md" },
    { type: "text", text: " and continue" },
  ]);
});

test("dedupes relative file mentions against absolute sent file parts", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [
        textPart("m1", "read @src/app.ts"),
        fileUrlPart("m1", "file:///Users/me/project/src/app.ts", "app.ts"),
      ]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result?.draft.text, "read @src/app.ts");
  assert.equal(result?.draft.resolvedText, "read @src/app.ts");
  assert.deepEqual(result?.draft.parts, [
    { type: "text", text: "read " },
    { type: "file", path: "src/app.ts", label: "app.ts" },
  ]);
});

test("does not replace exact file tokens with path-continuation suffixes", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [
        textPart("m1", "read @/tmp/abc"),
        fileUrlPart("m1", "file:///tmp/a", "a"),
      ]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result?.draft.text, "read @/tmp/abc@/tmp/a");
  assert.equal(result?.draft.resolvedText, "read @/tmp/abc@/tmp/a");
  assert.deepEqual(result?.draft.parts, [
    { type: "text", text: "read @/tmp/abc" },
    { type: "file", path: "/tmp/a", label: "a" },
  ]);
});

test("dedupes relative file mentions that contain spaces", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [
        textPart("m1", "read @docs/hello world.md"),
        fileUrlPart("m1", "file:///Users/me/project/docs/hello%20world.md", "hello world.md"),
      ]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result?.draft.text, "read @docs/hello world.md");
  assert.equal(result?.draft.resolvedText, "read @docs/hello world.md");
  assert.deepEqual(result?.draft.parts, [
    { type: "text", text: "read " },
    { type: "file", path: "docs/hello world.md", label: "hello world.md" },
  ]);
});

test("reconstructs safe file URL edge cases without URL parser loss", () => {
  const cases = [
    ["file:///tmp/100%/note.md", "/tmp/100%/note.md"],
    ["file://server/share/note.md", "//server/share/note.md"],
    ["file://localhost/tmp/a.txt", "/tmp/a.txt"],
    ["file:///C:/Users/x/note.md", "C:/Users/x/note.md"],
    ["file://C:/Users/x/note.md", "C:/Users/x/note.md"],
    ["file://C:\\Users\\x\\note.md", "C:\\Users\\x\\note.md"],
  ] as const;

  for (const [url, path] of cases) {
    const result = getEditableUserMessageDraft({
      messages: [message("m1", "user", [fileUrlPart("m1", url, "note.md")])],
      sessionIdle: true,
      queueEmpty: true,
      composerEmpty: true,
    });

    assert.equal(result?.draft.resolvedText, `@${path}`, url);
    assert.deepEqual(result?.draft.parts, [{ type: "file", path, label: "note.md" }], url);
  }
});

test("skips hidden latest user message in favor of previous visible user message", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [textPart("m1", "visible")]),
      message("m2", "assistant", [reasoningPart("m2")]),
      message("m3", "user", [{ ...textPart("m3", "hidden"), ignored: true } as Part]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result?.messageId, "m1");
  assert.equal(result?.draft.text, "visible");
});

test("ignored assistant text after the candidate does not block editing", () => {
  const result = getEditableUserMessageDraft({
    messages: [
      message("m1", "user", [textPart("m1", "original")]),
      message("m2", "assistant", [{ ...textPart("m2", "ignored answer"), ignored: true } as Part]),
    ],
    sessionIdle: true,
    queueEmpty: true,
    composerEmpty: true,
  });

  assert.equal(result?.messageId, "m1");
  assert.equal(result?.draft.text, "original");
});
