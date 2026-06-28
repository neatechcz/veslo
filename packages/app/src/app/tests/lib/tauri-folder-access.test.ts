import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../../lib/tauri.ts", import.meta.url), "utf8");

test("tauri wrapper exposes verified folder access grant command", () => {
  assert.match(source, /export async function workspaceGrantFolderAccess\(input: \{/);
  assert.match(source, /workspacePath: string/);
  assert.match(source, /requestedPath: string/);
  assert.match(source, /selectedFolderPath: string/);
  assert.match(source, /accessMode: "read"/);
  assert.match(source, /invoke<ExecResult>\("workspace_grant_folder_access"/);
  assert.match(source, /workspacePath: input\.workspacePath/);
  assert.match(source, /requestedPath: input\.requestedPath/);
  assert.match(source, /selectedFolderPath: input\.selectedFolderPath/);
  assert.match(source, /accessMode: input\.accessMode/);
});
