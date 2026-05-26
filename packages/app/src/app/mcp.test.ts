import assert from "node:assert/strict";
import test from "node:test";

import { mergeMcpServerEntries, parseLocalCommandInput, quickConnectEntryKey } from "./mcp.js";

test("quickConnectEntryKey prefers stable id when provided", () => {
  const key = quickConnectEntryKey({
    id: "chrome-devtools",
    name: "Control Chrome",
  });
  assert.equal(key, "chrome-devtools");
});

test("quickConnectEntryKey falls back to slugified name", () => {
  const key = quickConnectEntryKey({
    name: "Context 7",
  });
  assert.equal(key, "context-7");
});

test("parseLocalCommandInput preserves quoted paths with spaces", () => {
  const args = parseLocalCommandInput(
    'chrome-devtools-mcp --user-data-dir "/Users/test/My Profile" --isolated',
  );
  assert.deepEqual(args, [
    "chrome-devtools-mcp",
    "--user-data-dir",
    "/Users/test/My Profile",
    "--isolated",
  ]);
});

test("parseLocalCommandInput supports single-quoted args", () => {
  const args = parseLocalCommandInput("cmd --flag 'value with spaces' --x");
  assert.deepEqual(args, ["cmd", "--flag", "value with spaces", "--x"]);
});

test("parseLocalCommandInput falls back safely on unmatched quotes", () => {
  const args = parseLocalCommandInput('cmd --flag "broken value');
  assert.deepEqual(args, ["cmd", "--flag", '"broken', "value"]);
});

test("mergeMcpServerEntries includes global MCP and lets project override by name", () => {
  const result = mergeMcpServerEntries(
    [
      { name: "global-only", config: { type: "remote", url: "https://global.example" }, source: "config.global" },
      { name: "shared", config: { type: "remote", url: "https://global-shared.example" }, source: "config.global" },
    ],
    [
      { name: "shared", config: { type: "remote", url: "https://project-shared.example" }, source: "config.project" },
      { name: "project-only", config: { type: "local", command: ["node", "server.js"] }, source: "config.project" },
    ],
  );

  assert.deepEqual(result.map((entry) => `${entry.name}:${entry.source}`), [
    "global-only:config.global",
    "shared:config.project",
    "project-only:config.project",
  ]);
});
