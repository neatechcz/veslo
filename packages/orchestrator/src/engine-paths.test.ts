import { describe, expect, test } from "bun:test";

import {
  engineDirectoryToHostDirectory,
  hostDirectoryToEngineDirectory,
  rewriteDirectoryFieldsForEngine,
  rewriteDirectoryFieldsForHost,
  rewriteDirectoryQueryForEngine,
  type EnginePathMapping,
} from "./engine-paths.js";

const mapping: EnginePathMapping = {
  backend: "windows-wsl2",
  hostWorkspacePath: "\\\\?\\C:\\Work\\project",
};

describe("engine path mapping", () => {
  test("maps host workspace paths to the WSL sandbox workspace", () => {
    expect(hostDirectoryToEngineDirectory("\\\\?\\C:\\Work\\project", mapping)).toBe("/workspace");
    expect(hostDirectoryToEngineDirectory("C:\\Work\\project\\docs", mapping)).toBe("/workspace/docs");
  });

  test("maps sandbox workspace paths back to host workspace paths", () => {
    expect(engineDirectoryToHostDirectory("/workspace", mapping)).toBe("\\\\?\\C:\\Work\\project");
    expect(engineDirectoryToHostDirectory("/workspace/docs", mapping)).toBe("\\\\?\\C:\\Work\\project\\docs");
  });

  test("removes session list directory filter for WSL2 engines", () => {
    const search = rewriteDirectoryQueryForEngine("?directory=C%3A%5CWork%5Cproject&limit=20", {
      method: "GET",
      targetPath: "/session",
      mapping,
    });

    expect(search).toBe("?limit=20");
  });

  test("rewrites directory fields both ways", () => {
    const engineBody = rewriteDirectoryFieldsForEngine({ directory: "C:\\Work\\project\\docs" }, mapping);
    expect(engineBody).toEqual({ directory: "/workspace/docs" });

    const hostBody = rewriteDirectoryFieldsForHost({ session: { directory: "/workspace/docs" } }, mapping);
    expect(hostBody).toEqual({ session: { directory: "\\\\?\\C:\\Work\\project\\docs" } });
  });
});
