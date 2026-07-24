import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import {
  CONVERSATION_SUBMIT_MAX_ATTACHMENT_BYTES,
  prepareConversationSubmitAttachments,
} from "../conversation-submit-attachment-staging.js";
import type { ConversationSubmitRequest } from "../conversation-submit-contract.js";
import type { WorkspaceInfo } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length) {
    const directory = tempDirs.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function fixture(): Promise<{ root: string; workspace: WorkspaceInfo }> {
  const root = await mkdtemp(join(tmpdir(), "veslo-submit-attachment-stage-"));
  tempDirs.push(root);
  return {
    root,
    workspace: {
      id: "ws_attachment",
      name: "Attachment workspace",
      path: root,
      workspaceType: "local",
    },
  };
}

function request(attachment: NonNullable<ConversationSubmitRequest["draft"]["attachments"]>[number]): ConversationSubmitRequest {
  return {
    clientMessageId: "msg_attachment",
    origin: "session:normal",
    draft: {
      mode: "prompt",
      text: "Inspect the attachment",
      parts: [{ type: "text", text: "Inspect the attachment" }],
      attachments: [attachment],
    },
  };
}

describe("conversation submit attachment staging", () => {
  test("atomically stages a raw non-image attachment and strips provider bytes", async () => {
    const { root, workspace } = await fixture();
    const originalRequest = request({
      name: "brief.txt",
      kind: "file",
      mimeType: "text/plain",
      dataUrl: "data:text/plain;base64,YnJpZWY=",
    });

    const first = await prepareConversationSubmitAttachments({
      workspace,
      request: originalRequest,
      directory: root,
      stagingSessionId: "ses_stage",
    });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    const attachment = first.request.draft.attachments?.[0];
    expect(attachment).toMatchObject({
      name: "brief.txt",
      dataUrl: null,
      contentBase64: null,
    });
    expect(attachment?.fileSessionPath).toMatch(/^sessions\/ses_stage-[a-f0-9]{12}\/attachments\/01-[a-f0-9]{16}-brief\.txt$/);
    expect(await readFile(join(root, ...(attachment?.fileSessionPath?.split("/") ?? [])), "utf8")).toBe("brief");

    const second = await prepareConversationSubmitAttachments({
      workspace,
      request: originalRequest,
      directory: root,
      stagingSessionId: "ses_stage",
    });
    expect(second.status === "ok" ? second.request.draft.attachments?.[0]?.fileSessionPath : null)
      .toBe(attachment?.fileSessionPath);
    expect((await readdir(join(root, "sessions"), { recursive: true }))
      .filter((entry) => String(entry).endsWith("brief.txt"))).toHaveLength(1);
  });

  test("reuses a validated workspace-relative file and ignores duplicate raw bytes", async () => {
    const { root, workspace } = await fixture();
    await mkdir(join(root, "sessions", "existing"), { recursive: true });
    await writeFile(join(root, "sessions", "existing", "brief.txt"), "workspace copy");

    const result = await prepareConversationSubmitAttachments({
      workspace,
      request: request({
        name: "brief.txt",
        kind: "file",
        mimeType: "text/plain",
        dataUrl: "data:text/plain;base64,ZHVwbGljYXRl",
        fileSessionPath: "sessions/existing/brief.txt",
      }),
      directory: root,
      stagingSessionId: "ses_existing",
    });

    expect(result).toMatchObject({
      status: "ok",
      request: {
        draft: {
          attachments: [{
            fileSessionPath: "sessions/existing/brief.txt",
            dataUrl: null,
            contentBase64: null,
          }],
        },
      },
    });
    expect(await readFile(join(root, "sessions", "existing", "brief.txt"), "utf8")).toBe("workspace copy");
  });

  test("blocks an unavailable workspace reference when no recoverable bytes exist", async () => {
    const { root, workspace } = await fixture();
    const result = await prepareConversationSubmitAttachments({
      workspace,
      request: request({
        name: "missing.docx",
        kind: "file",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        fileSessionPath: "../outside.docx",
      }),
      directory: root,
      stagingSessionId: "ses_missing",
    });

    expect(result).toMatchObject({
      status: "blocked",
      result: {
        code: "attachment_reference_missing",
        details: { attachmentName: "missing.docx" },
      },
    });
  });

  test("rejects symlinked staging directories before writing outside the workspace", async () => {
    const { root, workspace } = await fixture();
    const outside = await mkdtemp(join(tmpdir(), "veslo-submit-attachment-outside-"));
    tempDirs.push(outside);
    await symlink(outside, join(root, "sessions"), process.platform === "win32" ? "junction" : "dir");

    const result = await prepareConversationSubmitAttachments({
      workspace,
      request: request({
        name: "escape.bin",
        kind: "file",
        mimeType: "application/octet-stream",
        contentBase64: Buffer.from("must stay inside").toString("base64"),
      }),
      directory: root,
      stagingSessionId: "ses_escape",
    });

    expect(result).toMatchObject({
      status: "blocked",
      result: { code: "attachment_staging_failed" },
    });
    expect(await readdir(outside)).toEqual([]);
  });

  test("rejects a directory where a regular staged file is required", async () => {
    const { root, workspace } = await fixture();
    await mkdir(join(root, "sessions", "existing", "not-a-file"), { recursive: true });

    const result = await prepareConversationSubmitAttachments({
      workspace,
      request: request({
        name: "not-a-file",
        kind: "file",
        mimeType: "application/octet-stream",
        fileSessionPath: "sessions/existing/not-a-file",
      }),
      directory: root,
      stagingSessionId: "ses_directory",
    });

    expect(result).toMatchObject({
      status: "blocked",
      result: { code: "attachment_reference_missing" },
    });
  });

  test("blocks oversized raw data before writing it", async () => {
    const { root, workspace } = await fixture();
    const bytes = Buffer.alloc(CONVERSATION_SUBMIT_MAX_ATTACHMENT_BYTES + 1, 1);
    const result = await prepareConversationSubmitAttachments({
      workspace,
      request: request({
        name: "too-large.bin",
        kind: "file",
        mimeType: "application/octet-stream",
        contentBase64: bytes.toString("base64"),
      }),
      directory: root,
      stagingSessionId: "ses_large",
    });

    expect(result).toMatchObject({
      status: "blocked",
      result: {
        code: "attachment_too_large",
        details: { maxBytes: CONVERSATION_SUBMIT_MAX_ATTACHMENT_BYTES },
      },
    });
  });

  test("stages a valid MSG but blocks admission with truthful unsupported-format details", async () => {
    const { root, workspace } = await fixture();
    const msgBytes = Buffer.concat([
      Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]),
      Buffer.alloc(32),
    ]);
    const result = await prepareConversationSubmitAttachments({
      workspace,
      request: request({
        name: "mail.msg",
        kind: "file",
        mimeType: "application/octet-stream",
        contentBase64: msgBytes.toString("base64"),
      }),
      directory: root,
      stagingSessionId: "ses_msg",
    });

    expect(result).toMatchObject({
      status: "blocked",
      result: {
        code: "attachment_format_unsupported",
        details: {
          attachmentName: "mail.msg",
          format: "MSG",
          suggestedAlternatives: ["EML", "PDF", "TXT"],
        },
      },
    });
    expect((await readdir(join(root, "sessions"), { recursive: true }))
      .some((entry) => String(entry).endsWith("mail.msg"))).toBe(true);
  });

  test("distinguishes malformed MSG from an unavailable parser", async () => {
    const { root, workspace } = await fixture();
    const result = await prepareConversationSubmitAttachments({
      workspace,
      request: request({
        name: "broken.msg",
        kind: "file",
        mimeType: "application/vnd.ms-outlook",
        contentBase64: Buffer.from("not an OLE compound file").toString("base64"),
      }),
      directory: root,
      stagingSessionId: "ses_broken_msg",
    });

    expect(result).toMatchObject({
      status: "blocked",
      result: {
        code: "attachment_processing_failed",
        details: { attachmentName: "broken.msg", format: "MSG" },
      },
    });
  });

  test("does not infer MSG from application/octet-stream alone", async () => {
    const { root, workspace } = await fixture();
    const result = await prepareConversationSubmitAttachments({
      workspace,
      request: request({
        name: "payload.bin",
        kind: "file",
        mimeType: "application/octet-stream",
        contentBase64: Buffer.from("generic binary").toString("base64"),
      }),
      directory: root,
      stagingSessionId: "ses_binary",
    });

    expect(result.status).toBe("ok");
  });
});
