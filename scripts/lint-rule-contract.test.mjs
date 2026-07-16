import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));

async function lintContract(source) {
  const eslint = new ESLint({ cwd: repoRoot });
  const [result] = await eslint.lintText(source, {
    // This existing app file makes the text use the production TypeScript and
    // Solid flat-config block, including its type-aware rules.
    filePath: "packages/app/src/app/app.tsx",
  });
  return result.messages;
}

function expectRule(messages, ruleId) {
  assert.ok(
    messages.some((message) => message.ruleId === ruleId),
    `expected ${ruleId}; received ${messages.map((message) => message.ruleId ?? "parse error").join(", ")}`,
  );
}

test("lint gate rejects destructured Solid component props", async () => {
  const messages = await lintContract(`
    const Component = ({ value }: { value: string }) => <div>{value}</div>;
    export default Component;
  `);

  expectRule(messages, "solid/no-destructure");
});

test("lint gate rejects non-Error throws", async () => {
  const messages = await lintContract(`
    export function fail(): never {
      throw "failure";
    }
  `);

  expectRule(messages, "@typescript-eslint/only-throw-error");
});
