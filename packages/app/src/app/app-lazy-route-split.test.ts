import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const CURRENT_DIR = dirname(fileURLToPath(import.meta.url));
const APP_FILE = resolve(CURRENT_DIR, "app.tsx");

test("app lazily loads route views and the MCP auth modal", () => {
  const source = readFileSync(APP_FILE, "utf8");

  const lazyImports = [
    { name: "McpAuthModal", from: "./components/mcp-auth-modal" },
    { name: "OnboardingView", from: "./pages/onboarding" },
    { name: "DashboardView", from: "./pages/dashboard" },
    { name: "SessionView", from: "./pages/session" },
    { name: "ProtoWorkspacesView", from: "./pages/proto-workspaces" },
    { name: "ProtoV1UxView", from: "./pages/proto-v1-ux" },
  ] as const;

  for (const entry of lazyImports) {
    const declaration = new RegExp(
      `const ${entry.name} = lazy\\(\\(\\) => import\\("${entry.from.replaceAll("/", "\\/")}"\\)\\);`,
    );
    assert.match(source, declaration, `Expected lazy import for ${entry.name}`);
    assert.equal(
      source.includes(`import ${entry.name} from "${entry.from}";`),
      false,
      `Unexpected eager import for ${entry.name}`,
    );
  }

  assert.match(
    source,
    /<Suspense>\s*<Switch>/,
    "Route switch should be wrapped in Suspense for lazy route modules",
  );
  assert.match(
    source,
    /<Show when=\{mcpAuthModalOpen\(\)\}>[\s\S]*<McpAuthModal/,
    "MCP auth modal should mount lazily only when opened",
  );
});
