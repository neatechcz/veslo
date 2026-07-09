import { readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve, sep } from "node:path";
import process from "node:process";

const repoRoot = process.cwd();
const showAll = process.argv.includes("--all");
const json = process.argv.includes("--json");

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".rs"]);
const SKIP_DIRS = new Set([
  ".git",
  ".next",
  ".output",
  ".turbo",
  "coverage",
  "dist",
  "gen",
  "node_modules",
  "target",
]);
const SCAN_ROOTS = [
  "packages/app/src/app",
  "packages/server/src",
  "packages/orchestrator/src",
  "packages/desktop/src-tauri/src",
  "packages/web",
  "services/ai-gateway/src",
  "services/den/src",
  "services/openwork-share/api",
  "services/worker-manager/src",
];

const HEADER_NAME_PATTERN =
  /\b(?:x-veslo-[a-z0-9-]+|X-Veslo-[A-Za-z0-9-]+|x-opencode-[a-z0-9-]+|X-OpenCode-[A-Za-z0-9-]+|X-Opencode-[A-Za-z0-9-]+|x-session-id|x-session-affinity)\b/g;
const STRING_LITERAL_PATTERN =
  /"([^"\\]*(?:\\.[^"\\]*)*)"|'([^'\\]*(?:\\.[^'\\]*)*)'|`([^`\\]*(?:\\.[^`\\]*)*)`/g;

const allowRules = [
  {
    path: "packages/app/src/app/lib/veslo-server/header-profiles.ts",
    reason: "app Veslo server header profile owner",
  },
  {
    path: "packages/web/components/cloud-control.tsx",
    reason: "web cloud-control org identity boundary",
    tokens: ["x-veslo-org-id"],
  },
  {
    path: "packages/server/src/request-headers.ts",
    reason: "server inbound request header owner",
  },
  {
    path: "packages/server/src/ai-gateway-proxy-headers.ts",
    reason: "AI gateway proxy strip profile owner",
  },
  {
    path: "packages/app/src/app/lib/opencode.ts",
    reason: "OpenCode generated provider header template owner",
    tokens: ["x-veslo-session-id", "x-veslo-workspace-id"],
  },
  {
    path: "packages/app/src/app/lib/ai-access.ts",
    reason: "OpenCode provider header template compatibility reader",
    tokens: ["x-veslo-session-id", "x-veslo-workspace-id"],
  },
  {
    path: "packages/app/src/app/lib/feedback.ts",
    reason: "feedback API org identity boundary",
    tokens: ["x-veslo-org-id"],
  },
  {
    path: "packages/app/src/app/lib/mcp-runtime-status-refresh.ts",
    reason: "MCP connector token polling boundary",
    tokens: ["x-veslo-connector-token"],
  },
  {
    path: "packages/app/src/app/lib/publisher.ts",
    reason: "publisher bundle metadata boundary",
    tokens: ["X-Veslo-Bundle-Type", "X-Veslo-Schema-Version", "X-Veslo-Name"],
  },
  {
    path: "packages/app/src/app/lib/sharepoint-managed-mcp-onboarding.ts",
    reason: "SharePoint MCP connector routing boundary",
    tokens: ["X-Veslo-Connector"],
  },
  {
    path: "packages/desktop/src-tauri/src/commands/workspace.rs",
    reason: "desktop OpenCode provider config boundary",
    tokens: ["x-opencode-directory", "x-veslo-gateway-token", "x-veslo-session-id"],
  },
  {
    path: "packages/desktop/src-tauri/src/debug_logs_forwarder.rs",
    reason: "desktop debug-log forwarder host auth boundary",
    tokens: ["x-veslo-host-token"],
  },
  {
    path: "packages/desktop/src-tauri/src/workspace/server_client.rs",
    reason: "desktop Veslo server host auth client boundary",
    tokens: ["x-veslo-host-token"],
  },
  {
    path: "packages/orchestrator/src/cli.ts",
    reason: "orchestrator router and lifecycle header boundary",
  },
  {
    path: "packages/server/src/den-catalog.ts",
    reason: "Den catalog connector protocol boundary",
    tokens: ["x-veslo-den-token", "x-veslo-connector-token", "x-veslo-connector"],
  },
  {
    path: "packages/server/src/mcp.ts",
    reason: "MCP connector runtime token handoff boundary",
    tokens: ["X-Veslo-Connector-Token"],
  },
  {
    path: "packages/server/src/orchestrator-lifecycle-client.ts",
    reason: "server orchestrator lifecycle client boundary",
    tokens: ["X-Veslo-Orchestrator-Token"],
  },
  {
    path: "packages/server/src/routes/mcp.ts",
    reason: "MCP connector runtime token handoff boundary",
    tokens: ["X-Veslo-Connector-Token"],
  },
  {
    path: "packages/server/src/server.ts",
    reason: "server OpenCode proxy/run correlation boundary",
    tokens: ["x-veslo-conversation-run-id", "x-veslo-request-id"],
  },
  {
    path: "packages/server/src/skill-registry-client.ts",
    reason: "skill-registry Den outbound client identity boundary",
    tokens: ["x-veslo-den-org-id", "x-veslo-den-user-id"],
  },
  {
    path: "packages/server/src/soul-den-client.ts",
    reason: "Soul Den outbound client identity boundary",
    tokens: ["x-veslo-org-id", "x-veslo-den-org-id", "x-veslo-user-id", "x-veslo-den-user-id"],
  },
  {
    path: "packages/server/src/validators.ts",
    reason: "Den connector validation boundary",
    tokens: ["x-veslo-den-token", "x-veslo-connector-token"],
  },
  {
    path: "services/ai-gateway/src/http/proxy.ts",
    reason: "AI gateway service caller token boundary",
    tokens: ["x-veslo-gateway-token"],
  },
  {
    path: "services/ai-gateway/src/http/providers/anthropic.ts",
    reason: "AI gateway service provider session boundary",
    tokens: ["x-veslo-session-id"],
  },
  {
    path: "services/ai-gateway/src/http/providers/codex-oauth.ts",
    reason: "AI gateway service provider session boundary",
    tokens: ["x-veslo-session-id"],
  },
  {
    path: "services/ai-gateway/src/http/providers/openai-compatible.ts",
    reason: "AI gateway service provider session boundary",
    tokens: ["x-veslo-session-id"],
  },
  {
    path: "services/ai-gateway/src/http/providers/openai.ts",
    reason: "AI gateway service provider session boundary",
    tokens: ["x-veslo-session-id"],
  },
  {
    path: "services/den/src/auth.ts",
    reason: "Den signup invite auth boundary",
    tokens: ["x-veslo-signup-invite-token"],
  },
  {
    path: "services/den/src/auth/admin-provisioning.ts",
    reason: "Den admin provisioning auth boundary",
    tokens: ["x-veslo-admin-provisioning-token"],
  },
  {
    path: "services/den/src/http/desktop-auth-v2.ts",
    reason: "Den desktop auth transport negotiation boundary",
    tokens: ["x-veslo-desktop-auth-transport"],
  },
  {
    path: "services/den/src/http/errors.ts",
    reason: "Den debug auth diagnostics boundary",
    tokens: ["x-veslo-debug-auth"],
  },
  {
    path: "services/den/src/http/google-workspace.ts",
    reason: "Den Google Workspace connector runtime token boundary",
    tokens: ["x-veslo-connector-token"],
  },
  {
    path: "services/den/src/http/microsoft.ts",
    reason: "Den Microsoft connector runtime token boundary",
    tokens: ["x-veslo-connector-token"],
  },
  {
    path: "services/den/src/http/org-auth.ts",
    reason: "Den org identity header owner",
    tokens: ["x-veslo-org-id", "x-veslo-den-org-id"],
  },
  {
    path: "services/den/src/http/org-mcp-catalog.ts",
    reason: "Den MCP catalog connector response boundary",
    tokens: ["X-Veslo-Connector"],
  },
  {
    path: "services/den/src/managed-ai/http/providers/anthropic.ts",
    reason: "Den managed-AI provider session boundary",
    tokens: ["x-veslo-session-id"],
  },
  {
    path: "services/den/src/managed-ai/http/providers/codex-oauth.ts",
    reason: "Den managed-AI provider session boundary",
    tokens: ["x-veslo-session-id"],
  },
  {
    path: "services/den/src/managed-ai/http/providers/openai-compatible.ts",
    reason: "Den managed-AI provider session boundary",
    tokens: ["x-veslo-session-id"],
  },
  {
    path: "services/den/src/managed-ai/http/providers/openai.ts",
    reason: "Den managed-AI provider session boundary",
    tokens: ["x-veslo-session-id"],
  },
  {
    path: "services/openwork-share/api/v1/bundles.js",
    reason: "OpenWork bundle upload CORS boundary",
    tokens: ["X-Veslo-Bundle-Type", "X-Veslo-Schema-Version", "X-Veslo-Name"],
  },
].map((rule) => ({
  ...rule,
  tokenSet: rule.tokens ? new Set(rule.tokens) : null,
}));

function normalizePath(path) {
  return relative(repoRoot, path).split(sep).join("/");
}

function isTestPath(normalizedPath) {
  return /(^|\/)(tests?|__tests__)\//.test(normalizedPath) ||
    /\.(test|spec)\.[cm]?[tj]sx?$/.test(normalizedPath);
}

async function walk(dir, out = []) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) await walk(resolve(dir, entry.name), out);
      continue;
    }
    if (entry.isFile() && CODE_EXTENSIONS.has(extname(entry.name))) {
      out.push(resolve(dir, entry.name));
    }
  }
  return out;
}

function allowRuleFor(file, token) {
  return allowRules.find((rule) => {
    if (rule.path !== file) return false;
    return !rule.tokenSet || rule.tokenSet.has(token);
  });
}

const files = [];
for (const root of SCAN_ROOTS) await walk(resolve(repoRoot, root), files);

const accepted = [];
const findings = [];

for (const filePath of files) {
  const file = normalizePath(filePath);
  if (isTestPath(file)) continue;

  const contents = await readFile(filePath, "utf8");
  const lines = contents.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    HEADER_NAME_PATTERN.lastIndex = 0;
    if (!HEADER_NAME_PATTERN.test(line)) continue;

    STRING_LITERAL_PATTERN.lastIndex = 0;
    let literalMatch;
    while ((literalMatch = STRING_LITERAL_PATTERN.exec(line))) {
      const literalValue = literalMatch[1] ?? literalMatch[2] ?? literalMatch[3] ?? "";
      HEADER_NAME_PATTERN.lastIndex = 0;
      let headerMatch;
      while ((headerMatch = HEADER_NAME_PATTERN.exec(literalValue))) {
        const token = headerMatch[0];
        const lineNumber = index + 1;
        const rule = allowRuleFor(file, token);
        const entry = {
          file,
          line: lineNumber,
          token,
          literal: literalValue.length > 120 ? `${literalValue.slice(0, 117)}...` : literalValue,
        };
        if (rule) {
          accepted.push({ ...entry, reason: rule.reason });
        } else {
          findings.push(entry);
        }
      }
    }
  }
}

accepted.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);
findings.sort((left, right) => left.file.localeCompare(right.file) || left.line - right.line);

const report = {
  scannedFiles: files.length,
  accepted: accepted.length,
  findings: findings.length,
  acceptedEntries: showAll ? accepted : undefined,
  findingsEntries: findings,
};

if (json) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(
    `Veslo header literal audit scanned ${files.length} files. Accepted: ${accepted.length}. Findings: ${findings.length}.`,
  );

  if (showAll && accepted.length > 0) {
    console.log("\nAccepted header literals:");
    for (const entry of accepted) {
      console.log(`OK ${entry.file}:${entry.line} ${entry.token} - ${entry.reason}`);
    }
  } else if (accepted.length > 0) {
    console.log("Use --all to print accepted owner/boundary literals.");
  }

  if (findings.length > 0) {
    console.error("\nReview-required header literals:\n");
    for (const entry of findings.slice(0, 80)) {
      console.error(`ERROR ${entry.file}:${entry.line} ${entry.token}`);
      console.error(`  literal: ${entry.literal}`);
    }
    if (findings.length > 80) console.error(`... ${findings.length - 80} more`);
  }
}

if (findings.length > 0) process.exit(1);
