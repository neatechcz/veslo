import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const workflowPath = resolve(import.meta.dirname, "../../.github/workflows/deploy-den.yml");
const readmePath = resolve(import.meta.dirname, "../../services/den/README.md");

const workflow = readFileSync(workflowPath, "utf8");
const readme = readFileSync(readmePath, "utf8");

test("deploy den workflow syncs hosted auth email environment", () => {
  assert.match(workflow, /DEN_LETTR_API_KEY/);
  assert.match(workflow, /DEN_AUTH_EMAIL_ADDRESS/);
  assert.match(workflow, /DEN_AUTH_EMAIL_FROM_NAME/);
  assert.match(workflow, /DEN_DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED/);

  assert.match(workflow, /"key": "LETTR_API_KEY"/);
  assert.match(workflow, /"key": "AUTH_EMAIL_ADDRESS"/);
  assert.match(workflow, /"key": "AUTH_EMAIL_FROM_NAME"/);
  assert.match(workflow, /"key": "DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED"/);
});

test("deploy den workflow preserves hosted auth email env when repo inputs are blank", () => {
  assert.match(workflow, /request\("GET", f"\/services\/\{service_id\}\/env-vars"\)/);
  assert.match(workflow, /current_env_by_key/);
  assert.match(workflow, /if not lettr_api_key:\s+lettr_api_key = current_env_by_key\.get\("LETTR_API_KEY", ""\)/);
  assert.match(workflow, /if not auth_email_address:\s+auth_email_address = current_env_by_key\.get\("AUTH_EMAIL_ADDRESS", ""\)/);
  assert.match(workflow, /if not auth_email_from_name:\s+auth_email_from_name = current_env_by_key\.get\("AUTH_EMAIL_FROM_NAME", ""\)/);
  assert.match(
    workflow,
    /if configured_desktop_auth_require_email_verified is None:\s+desktop_auth_require_email_verified = \(\s+current_env_by_key\.get\("DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED", "false"\)\.lower\(\) == "true"\s+\)/,
  );
});

test("workflow dispatch prefers the selected branch for hosted den deploys", () => {
  assert.match(workflow, /configured_control_plane_branch/);
  assert.match(
    workflow,
    /DEN_RENDER_CONTROL_PLANE_BRANCH: \$\{\{ github\.event\.inputs\.branch \|\| vars\.DEN_RENDER_CONTROL_PLANE_BRANCH \}\}/,
  );
  assert.match(workflow, /selected_branch = os\.environ\.get\("GITHUB_REF_NAME"\) or "dev"/);
  assert.match(workflow, /control_plane_branch = configured_control_plane_branch or selected_branch/);
});

test("den readme documents hosted auth email testing requirements", () => {
  assert.match(readme, /manually from GitHub Actions/);
  assert.match(readme, /DEN_LETTR_API_KEY/);
  assert.match(readme, /DEN_AUTH_EMAIL_ADDRESS/);
  assert.match(readme, /DEN_AUTH_EMAIL_FROM_NAME/);
  assert.match(readme, /DEN_DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED/);
  assert.match(readme, /preserves the current Render values/);
});
