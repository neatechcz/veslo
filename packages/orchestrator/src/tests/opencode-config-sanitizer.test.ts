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

  test("removes the plugin key when scheduler was the only plugin", () => {
    const result = sanitizeOpencodeRuntimeConfigText(JSON.stringify({ plugin: "opencode-scheduler" }));
    const parsed = JSON.parse(result.text);

    expect(result.changed).toBe(true);
    expect(parsed).not.toHaveProperty("plugin");
  });

  test("leaves unparsable JSONC unchanged for the source config owner", () => {
    const raw = '{ "plugin": ["opencode-scheduler"], // user comment\n }';

    expect(sanitizeOpencodeRuntimeConfigText(raw)).toEqual({
      text: raw,
      changed: false,
    });
  });
});
