import assert from "node:assert/strict";
import test from "node:test";

import { maybeConvertDocxToTextAttachment } from "./attachment-mime-normalization";

const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOCX_BASE64 =
  "UEsDBBQAAAAIAApcgVyXThM0sAAAAAEBAAARABwAd29yZC9kb2N1bWVudC54bWxVVAkAAyTmzGkk5sxpdXgLAAEE9QEAAAQUAAAAbY6xCsIwEIZ3nyJkt6kOIqWtgyJuDiq4xuSsheQuJNHatzcRRBCX7/i5n++uXj2tYQ/woSds+KwoOQNUpHvsGn46bqdLzkKUqKUhhIaPEPiqndRDpUndLWBkyYChGhp+i9FVQgR1AytDQQ4w7a7krYwp+k4M5LXzpCCEdMAaMS/LhbCyR94m5YX0mKfL8Bmx3YExxDb79bkWOWf6N91v9QCKUDPTI/zpio9ffH9vJy9QSwECHgMUAAAACAAKXIFcl04TNLAAAAABAQAAEQAYAAAAAAABAAAApIEAAAAAd29yZC9kb2N1bWVudC54bWxVVAUAAyTmzGl1eAsAAQT1AQAABBQAAABQSwUGAAAAAAEAAQBXAAAA+wAAAAAA";

test("converts dropped docx attachments into plain text before model send", async () => {
  const bytes = Buffer.from(DOCX_BASE64, "base64");
  const file = new File([bytes], "sample.docx", { type: DOCX_MIME });

  const converted = await maybeConvertDocxToTextAttachment(file);

  assert.equal(converted.type, "text/plain");
  assert.equal(converted.name, "sample.txt");

  const text = await converted.text();
  assert.match(text, /Hello DOCX/);
  assert.match(text, /Second line/);
});

test("does not modify non-docx attachments", async () => {
  const file = new File(["hello"], "note.txt", { type: "text/plain" });

  const converted = await maybeConvertDocxToTextAttachment(file);

  assert.equal(converted, file);
});
