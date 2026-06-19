import assert from "node:assert/strict";
import test from "node:test";

import { looksLikeHtmlDocumentPrefix, looksLikePdfDocumentPrefix } from "../../utils/pdf-signature.js";

const encode = (text: string) => new TextEncoder().encode(text);

test("looksLikePdfDocumentPrefix accepts %PDF signatures", () => {
  const prefix = encode("%PDF-1.7\n1 0 obj");
  assert.equal(looksLikePdfDocumentPrefix(prefix), true);
});

test("looksLikePdfDocumentPrefix rejects HTML error payloads", () => {
  const prefix = encode("<!DOCTYPE html><html><body>Neplatny odkaz</body></html>");
  assert.equal(looksLikePdfDocumentPrefix(prefix), false);
});

test("looksLikeHtmlDocumentPrefix detects HTML prefixes with leading whitespace", () => {
  const prefix = encode(" \n\t<html><body>error</body></html>");
  assert.equal(looksLikeHtmlDocumentPrefix(prefix), true);
});
