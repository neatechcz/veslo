import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { projectConversationPromptIdentities } from "../conversation-prompt-identity-projection.js";
import { createConversationRunDeliverySnapshotStore } from "../conversation-run-delivery-snapshot-store.js";
import { prepareConversationSubmitAttachments } from "../conversation-submit-attachment-staging.js";
import type { ConversationSubmitAttachment, ConversationSubmitRequest } from "../conversation-submit-contract.js";
import { resolveConversationSubmitDraft } from "../conversation-submit-draft-resolution.js";
import type { WorkspaceInfo } from "../types.js";

const tempDirs: string[] = [];

afterEach(async () => {
  while (tempDirs.length > 0) {
    const directory = tempDirs.pop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});

async function workspaceFixture(): Promise<{ root: string; workspace: WorkspaceInfo }> {
  const root = await mkdtemp(join(tmpdir(), "veslo-document-prompt-identity-"));
  tempDirs.push(root);
  return {
    root,
    workspace: { id: "ws-document", name: "Document workspace", path: root, workspaceType: "local" },
  };
}

function submitRequest(clientMessageId: string, attachment: ConversationSubmitAttachment): ConversationSubmitRequest {
  return {
    clientMessageId,
    origin: "session:normal",
    draft: {
      mode: "prompt",
      text: "Review the document",
      parts: [{ type: "text", text: "Review the document" }],
      attachments: [attachment],
    },
  };
}

async function resolveAndProjectDocument(input: {
  root: string;
  workspace: WorkspaceInfo;
  request: ConversationSubmitRequest;
  stagingSessionId: string;
  conversationId: string;
  opencodeSessionId: string;
  opencodeMessageId: string;
  runId: string;
}) {
  const prepared = await prepareConversationSubmitAttachments({
    workspace: input.workspace,
    request: input.request,
    directory: input.root,
    stagingSessionId: input.stagingSessionId,
  });
  expect(prepared.status).toBe("ok");
  if (prepared.status !== "ok") throw new Error(`attachment preparation failed: ${prepared.result.code}`);

  const stagedRelativePath = prepared.request.draft.attachments?.[0]?.fileSessionPath;
  expect(stagedRelativePath).toBeString();
  if (!stagedRelativePath) throw new Error("attachment preparation returned no staged relative path");

  const resolution = await resolveConversationSubmitDraft({ request: prepared.request, workspace: input.workspace });
  expect(resolution.status).toBe("ok");
  if (resolution.status !== "ok" || resolution.resolvedRunInput.kind !== "prompt_async") {
    throw new Error("document request did not resolve to a prompt run");
  }

  const canonicalText = `Review the document\nAttached workspace file: ${stagedRelativePath}`;
  expect(resolution.resolvedRunInput).toEqual({
    kind: "prompt_async",
    text: canonicalText,
    parts: [{ type: "text", text: canonicalText }],
  });
  expect(resolution.resolvedRunInput.parts.some(
    (part) => (part as { type?: unknown }).type === "file",
  )).toBe(false);

  const dataDir = await mkdtemp(join(tmpdir(), "veslo-document-prompt-identity-store-"));
  tempDirs.push(dataDir);
  const store = createConversationRunDeliverySnapshotStore({ dataDir, now: () => 10_000 });
  store.create({
    workspaceId: input.workspace.id,
    conversationId: input.conversationId,
    runId: input.runId,
    clientMessageId: input.request.clientMessageId,
    opencodeMessageId: input.opencodeMessageId,
    opencodeSessionId: input.opencodeSessionId,
  });

  const projected = projectConversationPromptIdentities([{
    info: { id: input.opencodeMessageId, role: "user", sessionID: input.opencodeSessionId },
    parts: resolution.resolvedRunInput.parts,
  }], store.listPromptIdentities({
    workspaceId: input.workspace.id,
    conversationId: input.conversationId,
  })) as Array<{ info: Record<string, unknown>; parts: Array<Record<string, unknown>> }>;
  expect(projected).toEqual([{
    info: {
      id: input.opencodeMessageId,
      role: "user",
      sessionID: input.opencodeSessionId,
      clientMessageId: input.request.clientMessageId,
    },
    parts: [{ type: "text", text: canonicalText }],
  }]);
  expect(projected[0]?.parts.some((part) => part.type === "file")).toBe(false);

  return { preparedRequest: prepared.request, stagedRelativePath, canonicalText };
}

describe("production document prompt identity fixtures", () => {
  test("projects an existing-session client-staged PDF as one canonical text part", async () => {
    const { root, workspace } = await workspaceFixture();
    const stagedRelativePath = "sessions/sess-existing/attachments/client-staged.pdf";
    await mkdir(join(root, "sessions", "sess-existing", "attachments"), { recursive: true });
    await writeFile(join(root, ...stagedRelativePath.split("/")), Buffer.from("%PDF-1.4 fixture"));

    const fixture = await resolveAndProjectDocument({
      root,
      workspace,
      request: submitRequest("client-existing-pdf", {
        name: "client-staged.pdf",
        kind: "file",
        mimeType: "application/pdf",
        dataUrl: "data:application/pdf;base64,JVBERi0xLjQgZml4dHVyZQ==",
        fileSessionPath: stagedRelativePath,
      }),
      stagingSessionId: "sess-existing",
      conversationId: "conv-existing",
      opencodeSessionId: "sess-existing",
      opencodeMessageId: "opencode-existing-pdf",
      runId: "run-existing-pdf",
    });

    expect(fixture.stagedRelativePath).toBe(stagedRelativePath);
    expect(fixture.preparedRequest.draft.attachments?.[0]).toMatchObject({
      fileSessionPath: stagedRelativePath,
      dataUrl: null,
      contentBase64: null,
    });
  });

  test("stages a raw first-session DOCX before projecting one canonical text part", async () => {
    const { root, workspace } = await workspaceFixture();
    const fixture = await resolveAndProjectDocument({
      root,
      workspace,
      request: submitRequest("client-first-docx", {
        name: "first-session.docx",
        kind: "file",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        contentBase64: Buffer.from("docx fixture bytes").toString("base64"),
      }),
      stagingSessionId: "sess-first",
      conversationId: "conv-first",
      opencodeSessionId: "sess-first",
      opencodeMessageId: "opencode-first-docx",
      runId: "run-first-docx",
    });

    expect(fixture.stagedRelativePath).toMatch(
      /^sessions\/sess-first-[a-f0-9]{12}\/attachments\/01-[a-f0-9]{16}-first-session\.docx$/,
    );
    expect(fixture.canonicalText).toBe(
      `Review the document\nAttached workspace file: ${fixture.stagedRelativePath}`,
    );
    expect(fixture.preparedRequest.draft.attachments?.[0]).toMatchObject({
      fileSessionPath: fixture.stagedRelativePath,
      dataUrl: null,
      contentBase64: null,
    });
  });
});
