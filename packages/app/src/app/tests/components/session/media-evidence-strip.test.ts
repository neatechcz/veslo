import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const stripSource = () => readFileSync(new URL("../../../components/session/media-evidence-strip.tsx", import.meta.url), "utf8");
const messageListSource = () => readFileSync(new URL("../../../components/session/message-list.tsx", import.meta.url), "utf8");

test("MediaEvidenceStrip exposes stable selectors", () => {
  const source = stripSource();

  assert.match(source, /data-testid="media-evidence-strip"/);
  assert.match(source, /data-testid="media-evidence-tile"/);
  assert.match(source, /data-testid="media-evidence-detail"/);
  assert.match(source, /data-testid="media-evidence-full-list"/);
  assert.match(source, /data-testid="media-evidence-list-tile"/);
});

test("MediaEvidenceStrip detail view keeps overflow evidence reachable", () => {
  const source = stripSource();

  assert.match(source, /<For each=\{props\.evidence\}>/);
  assert.match(source, /setSelectedId\(item\.id\)/);
});

test("message-list renders media evidence on timeline rows", () => {
  const source = messageListSource();

  assert.match(source, /<MediaEvidenceStrip\s+evidence=\{row\.mediaEvidence/);
});
