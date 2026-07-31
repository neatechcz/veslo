import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, test } from "bun:test";

import {
  resolveConversationSubmitDraft,
} from "../conversation-submit-draft-resolution.js";
import type { ConversationSubmitRequest } from "../conversation-submit-contract.js";
import { createDocumentRuntimeStatusPayload } from "../routes/document-runtime.js";

const request = (
  draft: ConversationSubmitRequest["draft"],
  overrides: Omit<Partial<ConversationSubmitRequest>, "draft"> = {},
): ConversationSubmitRequest => ({
  clientMessageId: "msg_1",
  origin: "session:normal",
  ...overrides,
  draft,
});

const localWorkspace = (root: string) => ({
  id: "ws_1",
  name: "Workspace",
  path: root,
  workspaceType: "local" as const,
});

describe("conversation submit draft resolution", () => {
  test("resolves shell drafts into shell run input", async () => {
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "shell",
        text: "npm test",
        resolvedText: " npm run test:unit ",
        parts: [{ type: "text", text: "npm test" }],
      }),
    });

    expect(result).toMatchObject({
      status: "ok",
      resolvedRunInput: {
        kind: "shell",
        command: "npm run test:unit",
      },
    });
  });

  test("resolves explicit command drafts into command run input", async () => {
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "prompt",
        text: "/deploy prod",
        parts: [{ type: "text", text: "/deploy prod" }],
        command: { name: "deploy", arguments: "prod" },
      }),
    });

    expect(result).toMatchObject({
      status: "ok",
      resolvedRunInput: {
        kind: "command",
        command: "deploy",
        arguments: "prod",
      },
    });
  });

  test("parses slash command text when the frontend command hint is missing", async () => {
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "prompt",
        text: " /review   src/app.ts ",
        parts: [{ type: "text", text: "/review src/app.ts" }],
      }),
    });

    expect(result).toMatchObject({
      status: "ok",
      resolvedRunInput: {
        kind: "command",
        command: "review",
        arguments: "src/app.ts",
      },
    });
  });

  test("keeps ordinary skill-named text as a prompt", async () => {
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "prompt",
        text: "ahoj",
        parts: [{ type: "text", text: "ahoj" }],
      }),
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "missing" }),
    });

    expect(result).toMatchObject({
      status: "ok",
      resolvedRunInput: {
        kind: "prompt_async",
        text: "ahoj",
      },
    });
  });

  test("resolves workspace file draft parts and ignores paths outside the workspace", async () => {
    const root = process.cwd();
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "prompt",
        text: "inspect project files",
        parts: [
          { type: "text", text: "inspect project files" },
          { type: "file", path: "docs/brief.md" },
          { type: "file", path: "../outside.md" },
          { type: "agent", name: "reviewer" },
        ],
      }),
      workspace: localWorkspace(root),
    });

    expect(result).toMatchObject({
      status: "ok",
      resolvedRunInput: {
        kind: "prompt_async",
        text: "inspect project files",
        parts: [
          { type: "text", text: "inspect project files" },
          {
            type: "file",
            url: pathToFileURL(resolve(root, "docs/brief.md")).href,
            filename: "brief.md",
            mime: "text/plain",
          },
          { type: "agent", name: "reviewer" },
        ],
      },
    });
  });

  test("keeps image attachment paths out of prompt text while preserving the inline file part", async () => {
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "prompt",
        text: "inspect screenshot",
        parts: [{ type: "text", text: "inspect screenshot" }],
        attachments: [{
          name: "shot.png",
          kind: "image",
          mimeType: "image/png",
          dataUrl: "data:image/png;base64,aGVsbG8=",
          fileSessionPath: "sessions/sess_1/shot.png",
        }],
      }, {
        options: {
          model: {
            providerID: "openai",
            modelID: "vision",
            modalities: { input: ["text", "image"], output: ["text"] },
          },
        },
      }),
      resolveManagedAiModelDescriptor: () => ({
        providerID: "openai",
        modelID: "vision",
        modalities: { input: ["text", "image"] },
      }),
      workspace: localWorkspace(process.cwd()),
    });

    expect(result).toMatchObject({
      status: "ok",
      resolvedRunInput: {
        kind: "prompt_async",
        text: "inspect screenshot",
        parts: [
          { type: "text", text: "inspect screenshot" },
          {
            type: "file",
            url: "data:image/png;base64,aGVsbG8=",
            filename: "shot.png",
            mime: "image/png",
          },
        ],
      },
    });
  });

  test("represents a staged non-image attachment only as a workspace path", async () => {
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "prompt",
        text: "inspect document",
        parts: [{ type: "text", text: "inspect document" }],
        attachments: [{
          name: "brief.docx",
          kind: "file",
          mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
          dataUrl: "data:application/octet-stream;base64,YmluYXJ5",
          fileSessionPath: "sessions/sess_1/brief.docx",
        }],
      }),
      workspace: localWorkspace(process.cwd()),
    });

    expect(result).toMatchObject({
      status: "ok",
      resolvedRunInput: {
        kind: "prompt_async",
        text: "inspect document\nAttached workspace file: sessions/sess_1/brief.docx",
        parts: [{
          type: "text",
          text: "inspect document\nAttached workspace file: sessions/sess_1/brief.docx",
        }],
      },
    });
  });

  test("blocks a raw non-image attachment that bypassed server staging", async () => {
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "prompt",
        text: "inspect document",
        parts: [{ type: "text", text: "inspect document" }],
        attachments: [{
          name: "brief.bin",
          kind: "file",
          mimeType: "application/octet-stream",
          dataUrl: "data:application/octet-stream;base64,YmluYXJ5",
        }],
      }),
    });

    expect(result).toMatchObject({
      status: "blocked",
      result: { code: "attachment_reference_missing" },
    });
  });
});
