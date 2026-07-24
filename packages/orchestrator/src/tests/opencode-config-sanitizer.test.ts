import { describe, expect, test } from "bun:test";

import { sanitizeOpencodeRuntimeConfigText } from "../opencode-config-sanitizer.js";

describe("sanitizeOpencodeRuntimeConfigText", () => {
  test("removes legacy scheduler plugin while preserving user plugins and MCP config", () => {
    const input = JSON.stringify(
      {
        plugin: ["opencode-scheduler", "user-plugin"],
        mcp: {
          custom: {
            type: "remote",
            url: "https://mcp.example/custom",
          },
        },
      },
      null,
      2,
    );

    const result = sanitizeOpencodeRuntimeConfigText(input);
    const parsed = JSON.parse(result.text);

    expect(result.changed).toBe(true);
    expect(parsed.plugin).toEqual(["user-plugin"]);
    expect(parsed.mcp.custom.url).toBe("https://mcp.example/custom");
  });

  test("migrates legacy Chrome MCP npx commands to the local shim command", () => {
    const input = JSON.stringify(
      {
        mcp: {
          "chrome-devtools": {
            type: "local",
            command: ["npx", "-y", "chrome-devtools-mcp@latest", "--isolated"],
          },
          "control-chrome": {
            type: "local",
            command: ["npm", "exec", "--yes", "chrome-devtools-mcp@0.17.0", "--", "--isolated"],
          },
          playwright: {
            type: "local",
            command: ["npx", "-y", "@playwright/mcp@latest"],
          },
        },
      },
      null,
      2,
    );

    const result = sanitizeOpencodeRuntimeConfigText(input);
    const parsed = JSON.parse(result.text);

    expect(result.changed).toBe(true);
    expect(parsed.mcp["chrome-devtools"].command).toEqual(["chrome-devtools-mcp", "--isolated"]);
    expect(parsed.mcp["control-chrome"].command).toEqual(["chrome-devtools-mcp", "--isolated"]);
    expect(parsed.mcp.playwright.command).toEqual(["npx", "-y", "@playwright/mcp@latest"]);
  });

  test("migrates legacy Chrome MCP commands in BOM-prefixed generated config", () => {
    const input = `\ufeff${JSON.stringify({
      mcp: {
        "chrome-devtools": {
          command: ["npx", "-y", "chrome-devtools-mcp@latest", "--isolated"],
          type: "local",
        },
      },
    })}`;

    const result = sanitizeOpencodeRuntimeConfigText(input);
    const parsed = JSON.parse(result.text.slice(1));

    expect(result.changed).toBe(true);
    expect(result.text.charCodeAt(0)).toBe(0xfeff);
    expect(parsed.mcp["chrome-devtools"].command).toEqual(["chrome-devtools-mcp", "--isolated"]);
  });

  test("removes the plugin key when scheduler was the only plugin", () => {
    const result = sanitizeOpencodeRuntimeConfigText(JSON.stringify({ plugin: "opencode-scheduler" }));
    const parsed = JSON.parse(result.text);

    expect(result.changed).toBe(true);
    expect(parsed).not.toHaveProperty("plugin");
  });

  test("sanitizes valid JSONC while normalizing the mirrored runtime snapshot", () => {
    const raw = '{ "plugin": ["opencode-scheduler"], // user comment\n }';

    const result = sanitizeOpencodeRuntimeConfigText(raw);

    expect(result.changed).toBe(true);
    expect(JSON.parse(result.text)).toEqual({});
  });

  test("removes config-owned skill paths and URLs for the effective runtime view", () => {
    const input = `{
      // source config is JSONC
      "model": "openai/gpt-5",
      "skills": {
        "paths": ["C:/unmanaged-skills"],
        "urls": ["https://example.test/skills"]
      }
    }`;

    const result = sanitizeOpencodeRuntimeConfigText(input, { removeSkills: true, failClosed: true });
    const parsed = JSON.parse(result.text);

    expect(result.changed).toBe(true);
    expect(parsed.model).toBe("openai/gpt-5");
    expect(parsed).not.toHaveProperty("skills");
  });

  test("fails closed when a policy-constrained JSONC config cannot be parsed", () => {
    expect(() => sanitizeOpencodeRuntimeConfigText("{ skills: [", {
      removeSkills: true,
      failClosed: true,
    })).toThrow("must be valid JSONC");
  });
});
