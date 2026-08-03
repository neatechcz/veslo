import process from "node:process";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

import { verifyHistoricalConversationArtifact } from "./scenario-kit/historical-conversation-trace-verifier.mjs";

function fail(message) {
  throw new Error(`[veslo:historical-trace-verify] ${message}`);
}

export function parseHistoricalTraceVerifyArguments(argv) {
  const [artifactPath, ...tokens] = argv;
  if (!String(artifactPath ?? "").trim()) {
    fail("Usage: pnpm test:webdriver:historical-conversation-trace-verify -- <scenario-artifact.json> [--trace-log-dir <path>]");
  }
  if (tokens.length !== 0 && (tokens.length !== 2 || tokens[0] !== "--trace-log-dir" || !tokens[1]?.trim())) {
    fail("Use only the optional --trace-log-dir <path> override.");
  }
  return {
    artifactPath: resolve(artifactPath),
    traceLogDir: tokens.length === 2 ? resolve(tokens[1]) : undefined,
  };
}

async function main() {
  const input = parseHistoricalTraceVerifyArguments(process.argv.slice(2));
  const { summary, outputPath } = await verifyHistoricalConversationArtifact(input.artifactPath, input);
  console.info(JSON.stringify({ ...summary, outputPath }));
  if (summary.outcome !== "passed") process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
