import assert from "node:assert/strict";
import test from "node:test";

import {
  isWorkspaceOpencodeProxyUrl,
  resolveServerProviderInitialState,
  shouldPersistServerProviderStorage,
} from "../../context/server-url.js";

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

test("desktop ServerProvider ignores stale persisted server targets", () => {
  assert.deepEqual(
    resolveServerProviderInitialState({
      defaultUrl: "http://127.0.0.1:4096",
      storedList: ["http://127.0.0.1:64999/workspace/ws-old/opencode"],
      storedActive: "http://127.0.0.1:64999/workspace/ws-old/opencode",
      isTauriRuntime: true,
      forceProxy: false,
    }),
    {
      list: ["http://127.0.0.1:4096"],
      active: "http://127.0.0.1:4096",
    },
  );
  assert.equal(shouldPersistServerProviderStorage(true), false);
});

test("web ServerProvider still restores persisted remote targets", () => {
  assert.deepEqual(
    resolveServerProviderInitialState({
      defaultUrl: "http://127.0.0.1:4096",
      storedList: ["https://remote.example/opencode"],
      storedActive: "https://remote.example/opencode",
      isTauriRuntime: false,
      forceProxy: false,
    }),
    {
      list: ["https://remote.example/opencode"],
      active: "https://remote.example/opencode",
    },
  );
  assert.equal(shouldPersistServerProviderStorage(false), true);
});
