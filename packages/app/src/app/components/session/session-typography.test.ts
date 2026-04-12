import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const messageList = readFileSync(new URL("./message-list.tsx", import.meta.url), "utf8");
const composer = readFileSync(new URL("./composer.tsx", import.meta.url), "utf8");
const sessionPage = readFileSync(new URL("../../pages/session.tsx", import.meta.url), "utf8");
const partView = readFileSync(new URL("../part-view.tsx", import.meta.url), "utf8");

test("chat message bubbles use reading typography", () => {
  assert.match(messageList, /font-reading/);
  assert.match(messageList, /type-reading-md/);
});

test("technical detail blocks stay compact and mono", () => {
  assert.match(messageList, /font-mono/);
  assert.match(messageList, /type-ui-xs/);
});

test("composer input and rendered parts use reading typography", () => {
  assert.match(composer, /font-reading/);
  assert.match(partView, /font-reading/);
});

test("rendered chat markdown keeps the tighter reading line-height", () => {
  assert.match(partView, /\[&_p\]:leading-\[1\.45\]/);
});

test("session page headings use product title styles", () => {
  assert.match(sessionPage, /font-product/);
  assert.match(sessionPage, /type-title-sm|type-title-md/);
});
