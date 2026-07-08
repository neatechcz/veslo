import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const protoV1Source = readFileSync(new URL("../../pages/proto-v1-ux.tsx", import.meta.url), "utf8");
const protoWorkspacesSource = readFileSync(
  new URL("../../pages/proto-workspaces.tsx", import.meta.url),
  "utf8",
);

test("proto pages keep mock icons and children explicitly typed", () => {
  const unsafeTypeToken = "a" + "ny";
  const unsafePatterns = [
    new RegExp(`:\\s*${unsafeTypeToken}\\b`),
    new RegExp(`${unsafeTypeToken}\\[\\]`),
    new RegExp(`as ${unsafeTypeToken}`),
    new RegExp(`Record<string, ${unsafeTypeToken}>`),
  ];

  for (const source of [protoV1Source, protoWorkspacesSource]) {
    for (const pattern of unsafePatterns) {
      assert.doesNotMatch(source, pattern);
    }
  }

  assert.match(protoV1Source, /type IconComponent = Component<\{ size\?: number; class\?: string \}>;/);
  assert.match(protoV1Source, /children: JSX\.Element/);
  assert.match(protoWorkspacesSource, /type IconComponent = Component<\{ size\?: number; class\?: string \}>;/);
});
