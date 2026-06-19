import assert from "node:assert/strict";
import test from "node:test";

import { compactHumanStepText, deriveArtifacts, summarizeStep } from "../../utils/tools.js";

const FULL_DIRECTORY_PROMPT =
  "Dej mi pristup do adresare /tmp/veslo-fixture/packages/app/src/app/components/session";

const toolMessage = (...parts: Array<Record<string, unknown>>) =>
  [
    {
      info: { id: "msg_1", role: "assistant" },
      parts: parts.map((part) => ({ type: "tool", ...part })),
    },
  ] as any;

test("compactHumanStepText preserves full directory paths in human-facing prompts", () => {
  assert.equal(compactHumanStepText(FULL_DIRECTORY_PROMPT, 24), FULL_DIRECTORY_PROMPT);
});

test("summarizeStep keeps full directory paths in bash descriptions", () => {
  const summary = summarizeStep({
    type: "tool",
    tool: "bash",
    state: {
      input: {
        description: FULL_DIRECTORY_PROMPT,
      },
      status: "pending",
    },
  } as any);

  assert.equal(summary.title, FULL_DIRECTORY_PROMPT);
  assert.ok(!summary.title.includes("..."));
});

test("deriveArtifacts ignores search list and glob paths in legacy fallback", () => {
  const artifacts = deriveArtifacts(
    toolMessage(
      {
        tool: "search",
        state: {
          input: { pattern: "needle" },
          files: ["src/search-result.ts"],
          output: "src/search-result.ts",
        },
      },
      { tool: "list", state: { input: { path: "src" }, files: ["src/list-result.ts"] } },
      { tool: "glob", state: { input: { pattern: "**/*.ts" }, files: ["src/glob-result.ts"] } },
    ),
  );

  assert.deepEqual(artifacts, []);
});

test("deriveArtifacts keeps explicit opened and modified paths in legacy fallback", () => {
  const artifacts = deriveArtifacts(
    toolMessage(
      { tool: "read", state: { input: { filePath: "src/opened.ts" } } },
      { tool: "edit", state: { input: { filePath: "src/modified.ts" } } },
      { tool: "write", state: { input: { path: "src/written.ts" } } },
    ),
  );

  assert.deepEqual(
    artifacts.map((artifact: any) => [artifact.path, artifact.fileInteraction]),
    [
      ["src/opened.ts", "opened"],
      ["src/modified.ts", "modified"],
      ["src/written.ts", "modified"],
    ],
  );
});

test("deriveArtifacts keeps apply_patch modified paths from patch summaries", () => {
  const artifacts = deriveArtifacts(
    toolMessage({
      tool: "apply_patch",
      state: {
        output: "Success. Updated the following files:\nM src/patched.ts\nA src/created.ts",
      },
    }),
  );

  assert.deepEqual(
    artifacts.map((artifact: any) => [artifact.path, artifact.fileInteraction]),
    [
      ["src/patched.ts", "modified"],
      ["src/created.ts", "modified"],
    ],
  );
});

test("deriveArtifacts keeps one-line apply_patch success summaries", () => {
  const artifacts = deriveArtifacts(
    toolMessage({
      tool: "apply_patch",
      state: {
        output: "Success. Updated the following files: M src/patched.ts",
      },
    }),
  );

  assert.deepEqual(
    artifacts.map((artifact: any) => [artifact.path, artifact.fileInteraction]),
    [["src/patched.ts", "modified"]],
  );
});

test("deriveArtifacts keeps extensionless apply_patch paths from explicit summary and header lines", () => {
  const artifacts = deriveArtifacts(
    toolMessage(
      {
        tool: "apply_patch",
        state: {
          output: "Success. Updated the following files:\nM Dockerfile\nA Makefile",
        },
      },
      {
        tool: "apply_patch",
        state: {
          input: {
            patch: ["*** Begin Patch", "*** Update File: LICENSE", "@@", "+Updated text", "*** End Patch"].join("\n"),
          },
        },
      },
    ),
  );

  assert.deepEqual(
    artifacts.map((artifact: any) => [artifact.path, artifact.fileInteraction]),
    [
      ["Dockerfile", "modified"],
      ["Makefile", "modified"],
      ["LICENSE", "modified"],
    ],
  );
});

test("deriveArtifacts ignores path-like text inside apply_patch patch bodies", () => {
  const artifacts = deriveArtifacts(
    toolMessage({
      tool: "apply_patch",
      state: {
        input: {
          patch: [
            "*** Begin Patch",
            "*** Update File: src/patched.ts",
            "@@",
            "+See docs/reference.md before changing this behavior.",
            "*** End Patch",
          ].join("\n"),
        },
      },
    }),
  );

  assert.deepEqual(
    artifacts.map((artifact: any) => [artifact.path, artifact.fileInteraction]),
    [["src/patched.ts", "modified"]],
  );
});

test("deriveArtifacts ignores apply_patch body lines that look like output summaries", () => {
  const artifacts = deriveArtifacts(
    toolMessage(
      {
        tool: "apply_patch",
        state: {
          input: {
            patch: [
              "*** Begin Patch",
              "*** Update File: src/patched.ts",
              "@@",
              " M docs/reference.md",
              "+M docs/added-text.md",
              "*** End Patch",
            ].join("\n"),
          },
        },
      },
      {
        tool: "apply_patch",
        state: {
          input: {
            patch: ["*** Begin Patch", "*** Update File: LICENSE", "@@", "+Updated text", "*** End Patch"].join("\n"),
          },
        },
      },
    ),
  );

  assert.deepEqual(
    artifacts.map((artifact: any) => [artifact.path, artifact.fileInteraction]),
    [
      ["src/patched.ts", "modified"],
      ["LICENSE", "modified"],
    ],
  );
});

test("deriveArtifacts ignores indented apply_patch header-looking body lines", () => {
  const artifacts = deriveArtifacts(
    toolMessage(
      {
        tool: "apply_patch",
        state: {
          input: {
            patch: [
              "*** Begin Patch",
              "*** Update File: src/patched.ts",
              "@@",
              " *** Update File: docs/body-context.md",
              "*** End Patch",
            ].join("\n"),
          },
        },
      },
      {
        tool: "apply_patch",
        state: {
          input: {
            patch: ["*** Begin Patch", "*** Update File: LICENSE", "@@", "+Updated text", "*** End Patch"].join("\n"),
          },
        },
      },
    ),
  );

  assert.deepEqual(
    artifacts.map((artifact: any) => [artifact.path, artifact.fileInteraction]),
    [
      ["src/patched.ts", "modified"],
      ["LICENSE", "modified"],
    ],
  );
});

test("deriveArtifacts ignores raw patch text in apply_patch output without a success summary block", () => {
  const artifacts = deriveArtifacts(
    toolMessage({
      tool: "apply_patch",
      state: {
        output: [
          "*** Begin Patch",
          "*** Update File: src/output-body.ts",
          "@@",
          "M docs/output-context.md",
          "*** End Patch",
        ].join("\n"),
      },
    }),
  );

  assert.deepEqual(artifacts, []);
});

test("deriveArtifacts ignores indented apply_patch output summary-looking body lines", () => {
  const artifacts = deriveArtifacts(
    toolMessage({
      tool: "apply_patch",
      state: {
        output: [
          "*** Begin Patch",
          "*** Update File: src/output-body.ts",
          "@@",
          " Updated the following files: M docs/context-leak.md",
          "*** End Patch",
        ].join("\n"),
      },
    }),
  );

  assert.deepEqual(artifacts, []);
});

test("deriveArtifacts rejects URL-like apply_patch header and summary paths", () => {
  const artifacts = deriveArtifacts(
    toolMessage(
      {
        tool: "apply_patch",
        state: {
          input: {
            patch: [
              "*** Begin Patch",
              "*** Update File: https://example.com/docs",
              "*** Update File: //example.com/docs",
              "*** Update File: //localhost:3000/docs",
              "*** Update File: //user@example.com/docs",
              "*** Update File: //[::1]/docs",
              "*** Update File: example.com",
              "*** Update File: example.co.uk/docs",
              "*** Update File: example.de/docs",
              "*** Update File: chrome://settings",
              "*** End Patch",
            ].join("\n"),
          },
        },
      },
      {
        tool: "apply_patch",
        state: {
          output: [
            "Success. Updated the following files:",
            "M https://example.com/docs",
            "M //github.com/repo",
            "M //localhost:3000/docs",
            "M //user@example.com/docs",
            "M //[::1]/docs",
            "M github.com",
            "A example.co.uk/docs",
            "M example.de/docs",
            "M chrome://settings",
          ].join("\n"),
        },
      },
    ),
  );

  assert.deepEqual(artifacts, []);
});

test("deriveArtifacts keeps apply_patch move target paths from explicit headers", () => {
  const artifacts = deriveArtifacts(
    toolMessage({
      tool: "apply_patch",
      state: {
        input: {
          patch: [
            "*** Begin Patch",
            "*** Update File: src/old-name.ts",
            "*** Move to: src/new-name.ts",
            "@@",
            "+renamed",
            "*** End Patch",
          ].join("\n"),
        },
      },
    }),
  );

  assert.deepEqual(
    artifacts.map((artifact: any) => [artifact.path, artifact.fileInteraction]),
    [["src/new-name.ts", "modified"]],
  );
});

test("deriveArtifacts scans apply_patch headers beyond output summary scan limits", () => {
  const artifacts = deriveArtifacts(
    toolMessage({
      tool: "apply_patch",
      state: {
        input: {
          patch: [
            "*** Begin Patch",
            "*** Update File: src/early.ts",
            ...Array.from({ length: 700 }, (_, index) => `+padding ${index}`),
            "*** Update File: src/late.ts",
            "@@",
            "+late",
            "*** End Patch",
          ].join("\n"),
        },
      },
    }),
  );

  assert.deepEqual(
    artifacts.map((artifact: any) => [artifact.path, artifact.fileInteraction]),
    [
      ["src/early.ts", "modified"],
      ["src/late.ts", "modified"],
    ],
  );
});

test("deriveArtifacts keeps direct target path spellings in legacy fallback", () => {
  const artifacts = deriveArtifacts(
    toolMessage(
      { tool: "read", state: { input: { target: "src/input-target.ts" } } },
      { tool: "read", state: { target: "src/state-target.ts" } },
      { tool: "read", target: "src/record-target.ts" },
      { tool: "read", filePath: "src/record-file-path.ts" },
    ),
  );

  assert.deepEqual(
    artifacts.map((artifact: any) => [artifact.path, artifact.fileInteraction]),
    [
      ["src/input-target.ts", "opened"],
      ["src/state-target.ts", "opened"],
      ["src/record-target.ts", "opened"],
      ["src/record-file-path.ts", "opened"],
    ],
  );
});

test("deriveArtifacts keeps root file names with dotted extensions in legacy fallback", () => {
  const artifacts = deriveArtifacts(
    toolMessage(
      { tool: "read", state: { input: { path: "package.json" } } },
      { tool: "read", state: { input: { path: "README.md" } } },
      {
        tool: "apply_patch",
        state: {
          input: {
            patch: ["*** Begin Patch", "*** Update File: package.json", "@@", "+{}", "*** End Patch"].join("\n"),
          },
        },
      },
      {
        tool: "apply_patch",
        state: {
          output: "Success. Updated the following files:\nM README.md",
        },
      },
    ),
  );

  assert.deepEqual(
    artifacts.map((artifact: any) => [artifact.path, artifact.fileInteraction]),
    [
      ["package.json", "modified"],
      ["README.md", "modified"],
    ],
  );
});

test("deriveArtifacts rejects URL-like direct targets in legacy fallback", () => {
  const artifacts = deriveArtifacts(
    toolMessage(
      { tool: "open", state: { input: { target: "https://example.com/docs" } } },
      { tool: "open", state: { input: { target: "//example.com/docs" } } },
      { tool: "open", state: { input: { target: "//localhost:3000/docs" } } },
      { tool: "open", state: { input: { target: "//user@example.com/docs" } } },
      { tool: "open", state: { input: { target: "//[::1]/docs" } } },
      { tool: "read", state: { input: { path: "mailto:someone@example.com" } } },
      { tool: "write", state: { input: { path: "file:///tmp/output.txt" } } },
      { tool: "open", state: { input: { target: "example.com/docs" } } },
      { tool: "open", state: { input: { target: "localhost:3000" } } },
      { tool: "open", state: { input: { target: "example.com" } } },
      { tool: "open", state: { input: { target: "example.com." } } },
      { tool: "open", state: { input: { target: "github.com" } } },
      { tool: "open", state: { input: { target: "localhost" } } },
      { tool: "open", state: { input: { target: "chrome://settings" } } },
      { tool: "open", state: { input: { target: "example.co.uk/docs" } } },
      { tool: "open", state: { input: { target: "example.de/docs" } } },
      { tool: "read", state: { input: { path: "example.com" } } },
      { tool: "write", state: { input: { path: "github.com" } } },
    ),
  );

  assert.deepEqual(artifacts, []);
});

test("deriveArtifacts keeps direct extensionless file paths in legacy fallback", () => {
  const artifacts = deriveArtifacts(
    toolMessage(
      { tool: "read", state: { input: { path: "Dockerfile" } } },
      { tool: "write", state: { input: { path: "Makefile" } } },
      { tool: "edit", state: { input: { path: "LICENSE" } } },
    ),
  );

  assert.deepEqual(
    artifacts.map((artifact: any) => [artifact.path, artifact.fileInteraction]),
    [
      ["Dockerfile", "opened"],
      ["Makefile", "modified"],
      ["LICENSE", "modified"],
    ],
  );
});
