import assert from "node:assert/strict";
import test from "node:test";

import {
  sessionIdentityCandidates,
  sessionIdentityMatches,
} from "../../lib/session-identity.js";

test("candidates keep the primary id first and append scope aliases", () => {
  assert.deepEqual(
    sessionIdentityCandidates("ses_1", {
      conversationId: "cnv_1",
      opencodeSessionId: "oc_1",
    }),
    ["ses_1", "oc_1", "cnv_1"],
  );
});

test("candidates drop empties, trim, and de-duplicate", () => {
  assert.deepEqual(sessionIdentityCandidates("  ses_1  ", null), ["ses_1"]);
  assert.deepEqual(sessionIdentityCandidates("", { conversationId: "cnv_1" }), ["cnv_1"]);
  assert.deepEqual(
    sessionIdentityCandidates("ses_1", {
      conversationId: "ses_1",
      opencodeSessionId: " ",
    }),
    ["ses_1"],
  );
  assert.deepEqual(sessionIdentityCandidates(null, undefined), []);
});

test("matches addresses a session through any id alias", () => {
  const session = {
    id: "ses_1",
    conversationId: "cnv_1",
    opencodeSessionId: "oc_1",
  };

  assert.equal(sessionIdentityMatches("ses_1", session), true);
  assert.equal(sessionIdentityMatches("cnv_1", session), true);
  assert.equal(sessionIdentityMatches("oc_1", session), true);
  assert.equal(sessionIdentityMatches("other", session), false);
});

test("matches rejects empty candidates and ignores empty aliases", () => {
  const session = { id: "ses_1", conversationId: null, opencodeSessionId: "" };

  assert.equal(sessionIdentityMatches("", session), false);
  assert.equal(sessionIdentityMatches("  ", session), false);
  assert.equal(sessionIdentityMatches("ses_1", session), true);
});
