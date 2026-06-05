import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stripSource = () => readFileSync(new URL("./media-evidence-strip.tsx", import.meta.url), "utf8");
const messageListSource = () => readFileSync(new URL("./message-list.tsx", import.meta.url), "utf8");

test("MediaEvidenceStrip exposes stable selectors", () => {
  const source = stripSource();

  assert.match(source, /data-testid="media-evidence-strip"/);
  assert.match(source, /data-testid="media-evidence-tile"/);
  assert.match(source, /data-testid="media-evidence-detail"/);
});

test("message-list renders media evidence on timeline rows", () => {
  const source = messageListSource();

  assert.match(source, /<MediaEvidenceStrip\s+evidence=\{row\.mediaEvidence/);
});
