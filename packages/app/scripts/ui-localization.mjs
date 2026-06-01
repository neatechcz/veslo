import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptRoot = fileURLToPath(new URL(".", import.meta.url));
const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const appRoot = fileURLToPath(new URL("../src/app/", import.meta.url));

const UI_TEXT_ATTRIBUTES = new Set([
  "aria-label",
  "alt",
  "description",
  "hint",
  "label",
  "placeholder",
  "title",
]);

const ALLOWED_TEXT = new Set([
  "@BotFather",
  "API",
  "MCP",
  "OpenCode",
  "OpenCodeRouter",
  "PID",
  "RESET",
  "Slack",
  "Telegram",
  "URL",
  "Veslo",
  "veslo",
]);

const walkTsxFiles = (directory) => {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTsxFiles(entryPath));
      continue;
    }
    if (
      entry.isFile() &&
      entry.name.endsWith(".tsx") &&
      !entry.name.endsWith(".test.tsx") &&
      !entryPath.includes("/pages/proto-")
    ) {
      files.push(entryPath);
    }
  }
  return files;
};

const normalizeText = (value) => value.replace(/\s+/g, " ").trim();

const isHumanText = (value) => {
  const normalized = normalizeText(value);
  if (!normalized || ALLOWED_TEXT.has(normalized)) return false;
  if (!/[A-Za-zÀ-ž]/.test(normalized)) return false;
  if (normalized.length < 2) return false;
  if (/^(ms|s|v|RESET)$/i.test(normalized)) return false;
  if (/^(@|\/)/.test(normalized)) return false;
  if (/^(xoxb-|xapp-)/.test(normalized)) return false;
  if (normalized === "opencode-wakatime") return false;
  if (/^(npm|choco|scoop|brew|curl)\s/.test(normalized)) return false;
  if (/^(https?:|app:|file:|mailto:)/.test(normalized)) return false;
  return true;
};

const findings = [];

const tsxFiles = walkTsxFiles(appRoot);

for (const filePath of tsxFiles) {
  const source = readFileSync(filePath, "utf8");
  const sourceFile = ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

  const addFinding = (node, kind, text) => {
    const normalized = normalizeText(text);
    if (!isHumanText(normalized)) return;
    const location = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
    findings.push({
      file: relative(packageRoot, filePath),
      line: location.line + 1,
      kind,
      text: normalized,
    });
  };

  const visit = (node) => {
    if (ts.isJsxText(node)) {
      addFinding(node, "JSX text", node.getText(sourceFile));
    } else if (
      ts.isJsxExpression(node) &&
      node.expression &&
      (ts.isStringLiteral(node.expression) || ts.isNoSubstitutionTemplateLiteral(node.expression))
    ) {
      addFinding(node, "JSX string expression", node.expression.text);
    } else if (
      ts.isJsxAttribute(node) &&
      UI_TEXT_ATTRIBUTES.has(node.name.getText(sourceFile)) &&
      node.initializer &&
      ts.isStringLiteral(node.initializer)
    ) {
      addFinding(node, `${node.name.getText(sourceFile)} attribute`, node.initializer.text);
    }

    ts.forEachChild(node, visit);
  };

  visit(sourceFile);
}

assert.equal(
  findings.length,
  0,
  `Production UI literals without localization:\n${findings
    .map((finding) => `${finding.file}:${finding.line} [${finding.kind}] ${finding.text}`)
    .join("\n")}`,
);

console.log(JSON.stringify({ ok: true, checkedFiles: tsxFiles.length, scriptRoot }));
