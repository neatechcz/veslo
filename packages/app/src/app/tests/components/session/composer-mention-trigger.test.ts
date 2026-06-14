import assert from "node:assert/strict";
import test from "node:test";

import { findMentionTrigger } from "../../../components/session/composer-mention-trigger.js";

test("mention trigger ignores at signs embedded in URLs and email addresses", () => {
  const unityUrl = "https://docs.unity3d.com/Packages/com.unity.ai.assistant@2.0/manual/unity-mcp-overview.html";

  assert.equal(findMentionTrigger(unityUrl, unityUrl.length), null);
  assert.equal(findMentionTrigger("Contact support@example.com", "Contact support@example.com".length), null);
});

test("mention trigger accepts standalone file mention tokens", () => {
  assert.deepEqual(findMentionTrigger("@README.md", "@README.md".length), {
    start: 0,
    end: 10,
    query: "README.md",
  });

  assert.deepEqual(findMentionTrigger("See @docs/guide", "See @docs/guide".length), {
    start: 4,
    end: 15,
    query: "docs/guide",
  });
});

test("mention trigger uses the caret position instead of later text", () => {
  const text = "See @docs/guide and @later";

  assert.deepEqual(findMentionTrigger(text, "See @docs".length), {
    start: 4,
    end: 9,
    query: "docs",
  });
});
