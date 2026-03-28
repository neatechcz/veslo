import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflowPath = resolve(import.meta.dirname, "../../.github/workflows/deploy-den.yml");
const readmePath = resolve(import.meta.dirname, "../../services/den/README.md");

const workflow = readFileSync(workflowPath, "utf8");
const readme = readFileSync(readmePath, "utf8");

test("deploy den workflow syncs hosted auth email environment", () => {
  assert.match(workflow, /DEN_RESEND_API_KEY/);
  assert.match(workflow, /DEN_AUTH_EMAIL_FROM/);
  assert.match(workflow, /DEN_DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED/);

  assert.match(workflow, /"key": "RESEND_API_KEY"/);
  assert.match(workflow, /"key": "AUTH_EMAIL_FROM"/);
  assert.match(workflow, /"key": "DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED"/);
});

test("workflow dispatch prefers the selected branch for hosted den deploys", () => {
  assert.match(workflow, /configured_control_plane_branch/);
  assert.match(workflow, /selected_branch = os\.environ\.get\("GITHUB_REF_NAME"\) or "dev"/);
  assert.match(workflow, /if os\.environ\.get\("GITHUB_EVENT_NAME"\) == "workflow_dispatch":/);
  assert.match(workflow, /control_plane_branch = selected_branch/);
});

test("den readme documents hosted auth email testing requirements", () => {
  assert.match(readme, /workflow_dispatch/);
  assert.match(readme, /DEN_RESEND_API_KEY/);
  assert.match(readme, /DEN_AUTH_EMAIL_FROM/);
  assert.match(readme, /DEN_DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED/);
});
