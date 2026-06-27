import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import test from "node:test";

const vesloServerSourceUrl = new URL("../../lib/veslo-server.ts", import.meta.url);
const vesloServerTypesUrl = new URL("../../lib/veslo-server/types.ts", import.meta.url);
const domainsDirUrl = new URL("../../lib/veslo-server-domains/", import.meta.url);

test("veslo server barrel re-exports extracted public types", () => {
  assert.equal(existsSync(vesloServerTypesUrl), true, "expected lib/veslo-server/types.ts to exist");

  const source = readFileSync(vesloServerSourceUrl, "utf8");
  assert.match(
    source,
    /export\s+(?:type\s+)?\*\s+from\s+["']\.\/veslo-server\/types["']/,
    "public barrel should re-export types from ./veslo-server/types",
  );
});

test("veslo server domain modules do not import through the public barrel", () => {
  const offenders = readdirSync(domainsDirUrl)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => {
      const source = readFileSync(new URL(name, domainsDirUrl), "utf8");
      return /from\s+["']\.\.\/veslo-server["']/.test(source);
    });

  assert.deepEqual(
    offenders,
    [],
    "domain modules should import shared types from ../veslo-server/types, not ../veslo-server",
  );
});

test("veslo server public barrel delegates implementation to internal modules", () => {
  const source = readFileSync(vesloServerSourceUrl, "utf8");

  assert.doesNotMatch(
    source,
    /from\s+["']\.\/veslo-server-domains\//,
    "public barrel should not import domain implementation modules directly",
  );
  assert.doesNotMatch(
    source,
    /\bfunction\s+createVesloServerClient\b/,
    "client composition should live in ./veslo-server/client",
  );
  assert.match(
    source,
    /export\s+\{\s*createVesloServerClient,\s*requestManagedAiAccessBundle\s*\}\s+from\s+["']\.\/veslo-server\/client["']/,
    "public barrel should re-export client composition from ./veslo-server/client",
  );
});
