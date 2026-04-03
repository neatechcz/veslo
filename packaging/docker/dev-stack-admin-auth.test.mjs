import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const composePath = path.join(__dirname, "docker-compose.dev.yml");
const compose = readFileSync(composePath, "utf8");

test("docker dev stack includes Den for AI gateway admin auth", () => {
  assert.match(compose, /^ {2}den-db:\n/m);
  assert.match(compose, /^ {2}den:\n/m);
  assert.match(compose, /den-db:[\s\S]*start_period:\s+240s/);
  assert.match(compose, /den:[\s\S]*apt-get update -qq && apt-get install -y -qq --no-install-recommends \\\s*\n\s+curl ca-certificates/);
  assert.match(compose, /pnpm --filter @neatech\/ai-gateway db:migrate/);
  assert.match(compose, /AI_GATEWAY_DEN_API_BASE:\s+http:\/\/den:8788/);
  assert.match(compose, /BETTER_AUTH_URL:\s+http:\/\/host\.docker\.internal:\$\{DEN_PORT:-8788\}/);
  assert.match(compose, /- "\$\{DEN_PORT:-8788\}:8788"/);
});
