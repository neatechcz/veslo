import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../../components/session/message-list.tsx", import.meta.url), "utf8");

test("progress comments expose a scoped copy affordance without framing the text", () => {
  assert.match(source, /data-testid="session-progress-comment"/);
  assert.match(
    source,
    /data-testid="session-progress-comment-copy"[\s\S]*handleCopy\(partToText\(commentProps\.item\.part\), commentCopyId\(\)\)/,
    "intermediate text comments should copy their own part text instead of relying on message-level selection",
  );
  assert.match(
    source,
    /data-testid="session-progress-comment-value"[\s\S]*\bselect-text\b/,
    "intermediate text comments should opt back into text selection",
  );
  assert.doesNotMatch(
    source,
    /data-testid="session-progress-comment"\s+class="[^"]*(?:rounded|border|bg-gray)/,
    "copy affordance must not turn progress comments into framed cards",
  );
});

test("timeline technical detail values expose a scoped copy affordance and selectable value", () => {
  assert.match(
    source,
    /data-testid="session-timeline-technical-detail-copy"[\s\S]*handleCopy\(String\(row\.technicalDetail \?\? ""\), detailCopyId\)/,
    "technical detail copy should target the row detail value only",
  );
  assert.match(
    source,
    /data-testid="session-timeline-technical-detail-value"[\s\S]*\bselect-text\b/,
    "technical detail values should be independently selectable",
  );
});
