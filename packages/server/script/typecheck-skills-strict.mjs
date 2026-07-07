import { spawnSync } from "node:child_process";

const OWNER_PATTERNS = [
  /^src[\\/](routes[\\/]skill-materialization|routes[\\/]workspace-skills)\.ts(?:\(|:)/,
  /^src[\\/](skills|skill-materializer|skill-package-cache|skill-package-model|skill-packages|skill-roots)\.ts(?:\(|:)/,
  /^src[\\/](workspace-skill-lockfile|workspace-skill-set)\.ts(?:\(|:)/,
];

const result = spawnSync(
  "tsc -p tsconfig.json --noEmit --exactOptionalPropertyTypes --noUncheckedIndexedAccess --pretty false",
  {
  encoding: "utf8",
  shell: true,
  },
);

if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const ownerDiagnostics = output
  .split(/\r?\n/)
  .filter((line) => OWNER_PATTERNS.some((pattern) => pattern.test(line)));

if (ownerDiagnostics.length > 0) {
  console.error(ownerDiagnostics.join("\n"));
  process.exit(1);
}

console.log("skills strict diagnostics: 0");
