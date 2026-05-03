import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

test("release prepare runs from main and syncs with origin/main", () => {
  const scriptPath = resolve(import.meta.dirname, "./prepare.mjs");
  const script = readFileSync(scriptPath, "utf8");

  assert.match(script, /branch !== "main"/);
  assert.match(script, /Must be on 'main' branch/);
  assert.match(script, /Syncing with origin\/main/);
  assert.match(script, /git fetch origin main/);
  assert.match(script, /git rev-list HEAD\.\.origin\/main --count/);
  assert.match(script, /git pull --rebase origin main/);
  assert.match(script, /Up to date with origin\/main/);
});

test("release ship pushes main to origin", () => {
  const scriptPath = resolve(import.meta.dirname, "./ship.mjs");
  const script = readFileSync(scriptPath, "utf8");

  assert.match(script, /Pushes the current tag \+ main branch to origin/);
  assert.match(script, /Pushing main to origin/);
  assert.match(script, /git push origin main/);
  assert.match(script, /Pushed main/);
});

test("release workflow does not publish Linux AUR packages", () => {
  const workflowPath = resolve(import.meta.dirname, "../../.github/workflows/release-macos-aarch64.yml");
  const workflow = readFileSync(workflowPath, "utf8");

  assert.doesNotMatch(workflow, /aur-publish:/);
  assert.doesNotMatch(workflow, /Publish AUR/);
  assert.doesNotMatch(workflow, /scripts\/aur\/update-aur\.sh/);
  assert.doesNotMatch(workflow, /scripts\/aur\/publish-aur\.sh/);
});

test("release checklist documents main as the default release branch", () => {
  const checklistPath = resolve(import.meta.dirname, "../../RELEASE.md");
  const checklist = readFileSync(checklistPath, "utf8");

  assert.match(checklist, /Sync the default branch \(currently `main`\)\./);
});
