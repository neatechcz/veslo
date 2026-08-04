import { resolve } from "node:path";

import { fail } from "./attach-smoke.mjs";

const normalize = (value) => String(value ?? "").trim();

const requiredOption = (options, name) => {
  const value = normalize(options[name]);
  if (!value) fail(`Missing required ${name}.`);
  if (/\r|\n/.test(value)) fail(`${name} must be single-line.`);
  return value;
};

export function parseDocumentFollowUpArguments(argv, { existingSession }) {
  const [runtimeInfoPath, ...tokens] = argv;
  if (!normalize(runtimeInfoPath)) {
    fail("The document follow-up scenario requires runtime-info.json.");
  }
  const allowed = new Set([
    "--workspace",
    "--document-message",
    "--follow-up-message",
    ...(existingSession ? ["--seed-message"] : []),
  ]);
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const name = tokens[index];
    const value = tokens[index + 1];
    if (!allowed.has(name) || value === undefined || options[name]) {
      fail("Use only the documented document follow-up options.");
    }
    options[name] = value;
  }
  return {
    runtimeInfoPath: resolve(runtimeInfoPath),
    workspace: requiredOption(options, "--workspace"),
    documentMessage: requiredOption(options, "--document-message"),
    followUpMessage: requiredOption(options, "--follow-up-message"),
    ...(existingSession ? { seedMessage: requiredOption(options, "--seed-message") } : {}),
  };
}
