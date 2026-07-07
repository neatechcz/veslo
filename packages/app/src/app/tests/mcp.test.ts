import assert from "node:assert/strict";
import test from "node:test";

import {
  buildEffectiveMcpServerEntriesFromContent,
  canRemoveMcpFromProjectConfig,
  mergeMcpServerEntries,
  parseMcpServersFromContent,
  parseLocalCommandInput,
  quickConnectEntryKey,
} from "../mcp.js";

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
  assert.equal(result.find((entry) => entry.name === "shared")?.config.url, "https://project-shared.example");
  assert.deepEqual(result.find((entry) => entry.name === "project-only")?.config.command, ["node", "server.js"]);
});

test("buildEffectiveMcpServerEntriesFromContent applies disabledByTools like the server listing", () => {
  const result = buildEffectiveMcpServerEntriesFromContent(
    JSON.stringify({
      tools: { deny: ["mcp.global-denied.*", "mcp.project-only"] },
      mcp: {
        "global-only": { type: "remote", url: "https://global.example" },
        "global-denied": { type: "remote", url: "https://global-denied.example" },
        shared: { type: "remote", url: "https://global-shared.example" },
      },
    }),
    JSON.stringify({
      tools: { deny: ["mcp.global-only", "mcp:project-denied:*"] },
      mcp: {
        shared: { type: "remote", url: "https://project-shared.example" },
        "project-only": { type: "local", command: ["node", "server.js"] },
        "project-denied": { type: "remote", url: "https://project-denied.example" },
      },
    }),
  );

  assert.equal(result.find((entry) => entry.name === "global-only")?.disabledByTools, true);
  assert.equal(result.find((entry) => entry.name === "global-denied")?.disabledByTools, true);
  assert.equal(result.find((entry) => entry.name === "shared")?.disabledByTools, undefined);
  assert.equal(result.find((entry) => entry.name === "project-only")?.disabledByTools, undefined);
  assert.equal(result.find((entry) => entry.name === "project-denied")?.disabledByTools, true);
});

test("buildEffectiveMcpServerEntriesFromContent uses server-equivalent glob patterns for disabledByTools", () => {
  const result = buildEffectiveMcpServerEntriesFromContent(
    "",
    JSON.stringify({
      tools: { deny: ["mcp.fo?"] },
      mcp: {
        foo: { type: "remote", url: "https://foo.example" },
        food: { type: "remote", url: "https://food.example" },
      },
    }),
  );

  assert.equal(result.find((entry) => entry.name === "foo")?.disabledByTools, true);
  assert.equal(result.find((entry) => entry.name === "food")?.disabledByTools, undefined);
});

test("buildEffectiveMcpServerEntriesFromContent honors official tools false globs", () => {
  const result = buildEffectiveMcpServerEntriesFromContent(
    JSON.stringify({
      tools: { "mcp.global-disabled": false },
      mcp: {
        "global-disabled": { type: "remote", url: "https://global-disabled.example" },
        shared: { type: "remote", url: "https://global-shared.example" },
      },
    }),
    JSON.stringify({
      tools: {
        "mcp.shared": false,
        "project-disabled": false,
        "mcp.project-enabled": true,
      },
      mcp: {
        shared: { type: "remote", url: "https://project-shared.example" },
        "project-disabled": { type: "local", command: ["node", "server.js"] },
        "project-enabled": { type: "remote", url: "https://project-enabled.example" },
      },
    }),
  );

  assert.equal(result.find((entry) => entry.name === "global-disabled")?.disabledByTools, true);
  assert.equal(result.find((entry) => entry.name === "shared")?.disabledByTools, true);
  assert.equal(result.find((entry) => entry.name === "project-disabled")?.disabledByTools, true);
  assert.equal(result.find((entry) => entry.name === "project-enabled")?.disabledByTools, undefined);
});

test("buildEffectiveMcpServerEntriesFromContent turns project disabled sentinels into disabled inherited entries", () => {
  const result = buildEffectiveMcpServerEntriesFromContent(
    JSON.stringify({
      mcp: {
        github: { type: "remote", url: "https://global.example/mcp" },
        browser: { type: "local", command: ["node", "browser.js"] },
      },
    }),
    JSON.stringify({
      mcp: {
        github: { enabled: false },
      },
    }),
  );

  assert.deepEqual(result.map((entry) => `${entry.name}:${entry.source}:${entry.config.enabled}`), [
    "browser:config.global:undefined",
    "github:config.project:false",
  ]);
  assert.equal(result.find((entry) => entry.name === "github")?.config.type, "remote");
  assert.equal(result.find((entry) => entry.name === "github")?.config.url, "https://global.example/mcp");
});

test("parseMcpServersFromContent ignores override-only disabled sentinels", () => {
  const result = parseMcpServersFromContent(JSON.stringify({
    mcp: {
      github: { enabled: false },
      playwright: {
        type: "local",
        command: ["bun", "x", "@playwright/mcp"],
      },
    },
  }));

  assert.deepEqual(result.map((entry) => entry.name), ["playwright"]);
});

test("parseMcpServersFromContent ignores future mcp.servers shape", () => {
  const result = parseMcpServersFromContent(JSON.stringify({
    mcp: {
      servers: {
        type: "remote",
        url: "https://future.example",
      },
      playwright: {
        type: "remote",
        url: "https://playwright.example",
      },
    },
  }));

  assert.deepEqual(result.map((entry) => entry.name), ["playwright"]);
});

test("canRemoveMcpFromProjectConfig blocks effective global-only entries", () => {
  assert.equal(canRemoveMcpFromProjectConfig(undefined), false);
  assert.equal(
    canRemoveMcpFromProjectConfig({
      name: "global-only",
      config: { type: "remote", url: "https://global.example" },
      source: "config.global",
    }),
    false,
  );
  assert.equal(
    canRemoveMcpFromProjectConfig({
      name: "shared",
      config: { type: "remote", url: "https://project.example" },
      source: "config.project",
    }),
    true,
  );
});
