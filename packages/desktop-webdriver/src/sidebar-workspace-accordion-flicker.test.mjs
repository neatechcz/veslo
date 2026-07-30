import assert from "node:assert/strict";
import test from "node:test";
import { parseSidebarWorkspaceAccordionFlickerArguments } from "./sidebar-workspace-accordion-flicker.mjs";

test("sidebar flicker scenario requires two distinct workspaces and bounded observation", () => {
  const parsed = parseSidebarWorkspaceAccordionFlickerArguments([
    "runtime-info.json",
    "--initial-workspace", "Workspace A",
    "--second-workspace", "Workspace B",
    "--observe-ms", "800",
  ]);
  assert.equal(parsed.observeMs, 800);
  assert.throws(
    () => parseSidebarWorkspaceAccordionFlickerArguments([
      "runtime-info.json", "--initial-workspace", "A", "--second-workspace", "A",
    ]),
    /must differ/,
  );
  assert.throws(
    () => parseSidebarWorkspaceAccordionFlickerArguments([
      "runtime-info.json", "--initial-workspace", "A", "--second-workspace", "B", "--observe-ms", "10001",
    ]),
    /between 200 and 10000/,
  );
});
