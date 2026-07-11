import { expect, test } from "bun:test";

import {
  normalizeTranscriptIngestIdentity,
  transcriptIngestMutexKey,
} from "../conversation-transcript-ingest.js";

test("transcript ingest identity scopes the same OpenCode session by normalized directory", () => {
  const first = normalizeTranscriptIngestIdentity({
    workspaceId: " ws-a ",
    directory: "C:\\Work\\Repo",
    opencodeSessionId: " ses-a ",
  });
  const equivalent = normalizeTranscriptIngestIdentity({
    workspaceId: "ws-a",
    directory: "c:/work/repo/",
    opencodeSessionId: "ses-a",
  });
  const differentDirectory = normalizeTranscriptIngestIdentity({
    workspaceId: "ws-a",
    directory: "c:/work/other",
    opencodeSessionId: "ses-a",
  });

  expect(first).not.toBeNull();
  expect(equivalent).not.toBeNull();
  expect(differentDirectory).not.toBeNull();
  expect(transcriptIngestMutexKey(first!)).toBe(transcriptIngestMutexKey(equivalent!));
  expect(transcriptIngestMutexKey(first!)).not.toBe(transcriptIngestMutexKey(differentDirectory!));
});

test("transcript ingest identity rejects incomplete scope", () => {
  expect(normalizeTranscriptIngestIdentity({
    workspaceId: "ws-a",
    directory: "",
    opencodeSessionId: "ses-a",
  })).toBeNull();
});
