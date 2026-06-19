import { describe, expect, test } from "bun:test";
import { parseWorkspaceOpencodeMount } from "../server.js";

describe("parseWorkspaceOpencodeMount", () => {
  test("matches /workspace/:id/opencode (bare)", () => {
    expect(parseWorkspaceOpencodeMount("/workspace/abc123/opencode")).toEqual({
      workspaceId: "abc123",
      restPath: "/opencode",
    });
  });

  test("matches /workspace/:id/opencode/sub/path", () => {
    expect(parseWorkspaceOpencodeMount("/workspace/abc123/opencode/session/list")).toEqual({
      workspaceId: "abc123",
      restPath: "/opencode/session/list",
    });
  });

  test("decodes URI-encoded workspace id", () => {
    expect(parseWorkspaceOpencodeMount("/workspace/abc%2Fdef/opencode")).toEqual({
      workspaceId: "abc/def",
      restPath: "/opencode",
    });
  });

  test("returns null for non-/workspace path", () => {
    expect(parseWorkspaceOpencodeMount("/w/abc/opencode")).toBeNull();
    expect(parseWorkspaceOpencodeMount("/health")).toBeNull();
  });

  test("returns null when restPath is NOT /opencode", () => {
    expect(parseWorkspaceOpencodeMount("/workspace/abc/files")).toBeNull();
    expect(parseWorkspaceOpencodeMount("/workspace/abc/config")).toBeNull();
  });

  test("returns null for empty workspace id", () => {
    expect(parseWorkspaceOpencodeMount("/workspace//opencode")).toBeNull();
  });

  test("returns null for bare /workspace/<id> with no trailing slash", () => {
    // No /opencode segment → not our mount
    expect(parseWorkspaceOpencodeMount("/workspace/abc")).toBeNull();
  });

  test("returns null for /workspace/<id>/ with trailing slash but no opencode", () => {
    expect(parseWorkspaceOpencodeMount("/workspace/abc/")).toBeNull();
  });

  test("rejects path that merely contains 'opencode' as substring", () => {
    expect(parseWorkspaceOpencodeMount("/workspace/abc/opencode-router")).toBeNull();
    expect(parseWorkspaceOpencodeMount("/workspace/abc/opencodex")).toBeNull();
  });
});
