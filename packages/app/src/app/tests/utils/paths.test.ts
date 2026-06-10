import assert from "node:assert/strict";
import test from "node:test";

import { normalizeDirectoryQueryPath } from "../../utils/index.js";

test("normalizeDirectoryQueryPath strips Windows extended-length prefixes", () => {
  assert.equal(
    normalizeDirectoryQueryPath("\\\\?\\C:\\Users\\jajse\\Desktop\\test-repo\\test-repo2"),
    "C:/Users/jajse/Desktop/test-repo/test-repo2",
  );
  assert.equal(
    normalizeDirectoryQueryPath("//?/c:/users/jajse/desktop/test-repo/test-repo2"),
    "c:/users/jajse/desktop/test-repo/test-repo2",
  );
});
