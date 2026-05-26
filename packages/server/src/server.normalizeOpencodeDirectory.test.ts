import { describe, expect, test } from "bun:test";
import { normalizeOpencodeDirectory } from "./server.js";

const isWindows = process.platform === "win32";

describe("normalizeOpencodeDirectory", () => {
  test("returns plain unix path unchanged", () => {
    expect(normalizeOpencodeDirectory("/Users/pavel/projects/foo")).toBe(
      "/Users/pavel/projects/foo",
    );
  });

  test("returns empty string as-is", () => {
    expect(normalizeOpencodeDirectory("")).toBe("");
  });

  test("does not alter non-windows-prefixed paths on any platform", () => {
    expect(normalizeOpencodeDirectory("/tmp/foo")).toBe("/tmp/foo");
    expect(normalizeOpencodeDirectory("relative/path")).toBe("relative/path");
  });

  test.if(isWindows)("strips \\\\?\\ extended-length prefix on win32", () => {
    expect(normalizeOpencodeDirectory("\\\\?\\C:\\Users\\pavel\\foo")).toBe(
      "C:\\Users\\pavel\\foo",
    );
  });

  test.if(isWindows)("strips //?/ forward-slash variant on win32", () => {
    expect(normalizeOpencodeDirectory("//?/C:/Users/pavel/foo")).toBe(
      "C:/Users/pavel/foo",
    );
  });

  test.if(isWindows)("leaves regular Windows drive paths unchanged on win32", () => {
    expect(normalizeOpencodeDirectory("C:\\Users\\pavel\\foo")).toBe(
      "C:\\Users\\pavel\\foo",
    );
  });

  test.if(!isWindows)(
    "does NOT strip \\\\?\\ prefix on non-win32 (cross-platform paths from a Windows workspace)",
    () => {
      // The fix is platform-gated; on macOS/Linux these strings stay verbatim
      // so they round-trip back to the originating Windows client unchanged.
      expect(normalizeOpencodeDirectory("\\\\?\\C:\\Users\\pavel\\foo")).toBe(
        "\\\\?\\C:\\Users\\pavel\\foo",
      );
    },
  );
});
