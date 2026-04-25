import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const composePath = path.join(__dirname, "docker-compose.dev.yml");
const compose = readFileSync(composePath, "utf8");

function readMatch(pattern, label) {
  const match = compose.match(pattern);
  assert.ok(match, `Missing ${label} in docker-compose.dev.yml`);
  return match[1];
}

function parseSeconds(value) {
  if (value.endsWith("ms")) {
    return Number(value.slice(0, -2)) / 1000;
  }
  if (value.endsWith("s")) {
    return Number(value.slice(0, -1));
  }
  if (value.endsWith("m")) {
    return Number(value.slice(0, -1)) * 60;
  }
  throw new Error(`Unsupported duration format: ${value}`);
}

const startPeriod = parseSeconds(
  readMatch(/^\s+start_period:\s+([0-9]+(?:ms|s|m))$/m, "orchestrator healthcheck start_period"),
);
const interval = parseSeconds(
  readMatch(/^\s+interval:\s+([0-9]+(?:ms|s|m))$/m, "orchestrator healthcheck interval"),
);
const retries = Number(readMatch(/^\s+retries:\s+([0-9]+)$/m, "orchestrator healthcheck retries"));

const totalBudgetSeconds = startPeriod + interval * retries;

assert.ok(
  totalBudgetSeconds >= 300,
  `Expected at least 300s of orchestrator health budget for cold boot, got ${totalBudgetSeconds}s`,
);

console.log(
  `dev-stack-health-budget: start_period=${startPeriod}s interval=${interval}s retries=${retries} total=${totalBudgetSeconds}s`,
);
