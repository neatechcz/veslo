import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const expectedRuntimeEngineStates = [
  "absent",
  "starting",
  "process_ready",
  "workspace_api_waiting",
  "ready",
  "stopped",
  "failed",
];

function readText(path: URL): string {
  return readFileSync(path, "utf8");
}

function parseTsRuntimeEngineStates(source: string): string[] {
  const match = source.match(/RUNTIME_ENGINE_STATES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  assert.ok(match, "RUNTIME_ENGINE_STATES const should exist");
  return [...match[1].matchAll(/"([^"]+)"/g)].map((item) => item[1]);
}

function pascalToSnake(value: string): string {
  return value.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function parseRustRuntimeEngineStates(source: string): string[] {
  const match = source.match(/pub enum RuntimeEngineState\s*\{([\s\S]*?)\n\}/);
  assert.ok(match, "RuntimeEngineState enum should exist");
  return match[1]
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/,$/, ""))
    .filter((line) => /^[A-Z][A-Za-z0-9]*$/.test(line))
    .map(pascalToSnake);
}

test("runtime engine state vocabulary stays aligned across app, orchestrator, and Tauri", () => {
  const appTauriSource = readText(new URL("../lib/tauri.ts", import.meta.url));
  const sendReadinessSource = readText(new URL("../context/send-runtime-readiness.ts", import.meta.url));
  const orchestratorSource = readText(
    new URL("../../../../orchestrator/src/runtime-engine-state.ts", import.meta.url),
  );
  const tauriTypesSource = readText(
    new URL("../../../../desktop/src-tauri/src/types.rs", import.meta.url),
  );

  assert.deepEqual(parseTsRuntimeEngineStates(appTauriSource), expectedRuntimeEngineStates);
  assert.deepEqual(parseTsRuntimeEngineStates(orchestratorSource), expectedRuntimeEngineStates);
  assert.deepEqual(parseRustRuntimeEngineStates(tauriTypesSource), expectedRuntimeEngineStates);
  assert.match(
    sendReadinessSource,
    /import type \{ RuntimeEngineState \} from "\.\.\/lib\/tauri";/,
    "send runtime readiness should reuse the public app runtime state type",
  );
  assert.doesNotMatch(
    sendReadinessSource,
    /export type RuntimeEngineState\s*=/,
    "send runtime readiness must not define a second runtime state vocabulary",
  );
});
