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

  test("blocks implicit skill prompts for confirmation by default", async () => {
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "prompt",
        text: "use company research skill for this site",
        parts: [{ type: "text", text: "use company research skill for this site" }],
      }),
      resolveSkillCommand: async ({ text }) => {
        expect(text).toBe("use company research skill for this site");
        return "company-research-czech";
      },
    });

    expect(result).toMatchObject({
      status: "blocked",
      result: {
        status: "blocked",
        code: "implicit_skill_confirmation_required",
        draftDisposition: "keep",
        recoverable: true,
        confirmation: {
          type: "implicit_skill_command",
          skillName: "company-research-czech",
          arguments: "use company research skill for this site",
        },
      },
    });
  });

  test("resolves implicit skill prompts into command run input when allowed", async () => {
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "prompt",
        text: "use company research skill for this site",
        parts: [{ type: "text", text: "use company research skill for this site" }],
      }, {
        options: { implicitSkillCommandPolicy: "allow" },
      }),
      resolveSkillCommand: async ({ text }) => {
        expect(text).toBe("use company research skill for this site");
        return "company-research-czech";
      },
    });

    expect(result).toMatchObject({
      status: "ok",
      resolvedRunInput: {
        kind: "command",
        command: "company-research-czech",
        arguments: "use company research skill for this site",
      },
    });
  });

  test("skips implicit skill resolution when disabled", async () => {
    let resolveCalls = 0;
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "prompt",
        text: "use company research skill for this site",
        parts: [{ type: "text", text: "use company research skill for this site" }],
      }, {
        options: { implicitSkillCommandPolicy: "disable" },
      }),
      resolveSkillCommand: async () => {
        resolveCalls += 1;
        return "company-research-czech";
      },
    });

    expect(resolveCalls).toBe(0);
    expect(result).toMatchObject({
      status: "ok",
      resolvedRunInput: {
        kind: "prompt_async",
        text: "use company research skill for this site",
      },
    });
  });

  test("falls back to prompt when implicit skill resolution fails", async () => {
    const debugTrace: Array<Record<string, unknown>> = [];
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "prompt",
        text: "plain prompt should still send",
        parts: [{ type: "text", text: "plain prompt should still send" }],
      }),
      resolveSkillCommand: async () => {
        throw new Error("skill registry unavailable");
      },
      recordDebugTrace: (entry) => debugTrace.push(entry),
    });

    expect(result).toMatchObject({
      status: "ok",
      resolvedRunInput: {
        kind: "prompt_async",
        text: "plain prompt should still send",
      },
    });
    expect(debugTrace).toMatchObject([
      {
        event: "implicit_skill_resolution_failed",
        message: "skill registry unavailable",
      },
    ]);
  });

  test("falls back to prompt when implicit document skill lacks runtime", async () => {
    const result = await resolveConversationSubmitDraft({
      request: request({
        mode: "prompt",
        text: "create a docx summary",
        parts: [{ type: "text", text: "create a docx summary" }],
      }),
      resolveSkillCommand: async () => "veslo-docx",
      documentRuntimeStatus: () => createDocumentRuntimeStatusPayload({ status: "missing" }),
    });

    expect(result).toMatchObject({
      status: "ok",
      resolvedRunInput: {
        kind: "prompt_async",
        text: "create a docx summary",
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
