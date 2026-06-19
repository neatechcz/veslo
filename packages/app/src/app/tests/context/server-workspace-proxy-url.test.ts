import assert from "node:assert/strict";
import test from "node:test";

import { isWorkspaceOpencodeProxyUrl } from "../../context/server-url.js";

test("workspace OpenCode proxy urls are not treated as global health targets", () => {
  assert.equal(
    isWorkspaceOpencodeProxyUrl("http://127.0.0.1:34115/workspace/ws-1/opencode"),
    true,
  );
  assert.equal(
    isWorkspaceOpencodeProxyUrl("http://127.0.0.1:34115/workspace/ws-1/opencode/global/health"),
    true,
  );
  assert.equal(
    isWorkspaceOpencodeProxyUrl("http://127.0.0.1:34115/opencode"),
    false,
  );
});
