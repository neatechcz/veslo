#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import ts from "typescript";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(scriptDir, "..");
const tsconfigPath = path.join(appRoot, "tsconfig.json");

const exactNameTags = new Map([
  ["runConversationFromVesloWriteApi", ["legacy-run-submit"]],
  ["prepareSendRuntimeForSend", ["frontend-runtime-admission"]],
  ["maybeResolveSkillCommand", ["frontend-draft-resolution"]],
  ["compactCurrentSession", ["legacy-compact-submit"]],
  ["routeStagedAttachmentsForModel", ["frontend-run-part-routing"]],
  ["buildPromptParts", ["frontend-run-part-construction"]],
  ["buildCommandFileParts", ["frontend-run-part-construction"]],
  ["stageAttachmentsIntoSessionDirectory", ["compat-attachment-staging"]],
  ["legacyRun", ["legacy-name"]],
  ["legacyFallback", ["legacy-name"]],
]);

const tokenTags = new Map([
  ["legacy", "legacy-name"],
  ["fallback", "fallback-name"],
  ["compat", "compat-name"],
  ["compatibility", "compat-name"],
  ["deprecated", "deprecated-name"],
  ["obsolete", "deprecated-name"],
  ["stale", "stale-name"],
  ["old", "old-name"],
  ["workaround", "workaround-name"],
]);

const dependencyOwnerNames = new Set([
  "createConversationService",
  "createSessionCreationWorkflow",
  "createSessionFlowFacade",
  "createSessionMutationWorkflow",
  "createSessionSendWorkflow",
]);

const highSignalTags = new Set([
  "compat-attachment-staging",
  "frontend-draft-resolution",
  "frontend-run-part-construction",
  "frontend-run-part-routing",
  "frontend-runtime-admission",
  "legacy-compact-submit",
  "legacy-run-submit",
]);

function parseArgs(argv) {
  const result = {
    json: false,
    details: false,
    limit: 40,
    pattern: null,
  };
  for (const arg of argv) {
    if (arg === "--json") {
      result.json = true;
      continue;
    }
    if (arg === "--details") {
      result.details = true;
      continue;
    }
    if (arg.startsWith("--limit=")) {
      const next = Number.parseInt(arg.slice("--limit=".length), 10);
      if (Number.isFinite(next) && next > 0) result.limit = next;
      continue;
    }
    if (arg.startsWith("--pattern=")) {
      result.pattern = new RegExp(arg.slice("--pattern=".length), "i");
      continue;
    }
  }
  return result;
}

function normalizePath(fileName) {
  return fileName.replace(/\\/g, "/");
}

function relativePath(fileName) {
  return normalizePath(path.relative(appRoot, fileName));
}

function isAppSourceFile(sourceFile) {
  if (sourceFile.isDeclarationFile) return false;
  const fileName = normalizePath(sourceFile.fileName);
  const root = normalizePath(appRoot);
  return fileName.startsWith(`${root}/src/`) || fileName === `${root}/vite.config.ts`;
}

function fileKind(fileName) {
  const rel = relativePath(fileName);
  if (/(\.test\.[cm]?[tj]sx?$|\/tests\/)/.test(rel)) return "test";
  if (rel.startsWith("scripts/")) return "script";
  return "production";
}

function locationFor(sourceFile, node) {
  const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    file: relativePath(sourceFile.fileName),
    line: pos.line + 1,
    column: pos.character + 1,
  };
}

function formatLocation(location) {
  return `${location.file}:${location.line}:${location.column}`;
}

function splitNameTokens(name) {
  return name
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);
}

function tagsForName(name, customPattern) {
  const tags = new Set(exactNameTags.get(name) ?? []);
  for (const token of splitNameTokens(name)) {
    const tag = tokenTags.get(token);
    if (tag) tags.add(tag);
  }
  if (customPattern?.test(name)) tags.add("custom-pattern");
  return tags;
}

function declarationKind(node) {
  if (ts.isVariableDeclaration(node)) return "variable";
  if (ts.isFunctionDeclaration(node)) return "function";
  if (ts.isParameter(node)) return "parameter";
  if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node)) return "property";
  if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) return "method";
  if (ts.isClassDeclaration(node)) return "class";
  if (ts.isInterfaceDeclaration(node)) return "interface";
  if (ts.isTypeAliasDeclaration(node)) return "type";
  if (ts.isEnumDeclaration(node)) return "enum";
  if (ts.isImportSpecifier(node) || ts.isImportClause(node) || ts.isNamespaceImport(node)) return "import";
  if (ts.isBindingElement(node)) return "binding";
  return ts.SyntaxKind[node.kind] ?? "unknown";
}

function isDeclarationName(node) {
  const parent = node.parent;
  if (!parent) return false;
  return Boolean(
    (ts.isVariableDeclaration(parent) && parent.name === node) ||
      (ts.isFunctionDeclaration(parent) && parent.name === node) ||
      (ts.isParameter(parent) && parent.name === node) ||
      (ts.isPropertyDeclaration(parent) && parent.name === node) ||
      (ts.isPropertySignature(parent) && parent.name === node) ||
      (ts.isMethodDeclaration(parent) && parent.name === node) ||
      (ts.isMethodSignature(parent) && parent.name === node) ||
      (ts.isClassDeclaration(parent) && parent.name === node) ||
      (ts.isInterfaceDeclaration(parent) && parent.name === node) ||
      (ts.isTypeAliasDeclaration(parent) && parent.name === node) ||
      (ts.isEnumDeclaration(parent) && parent.name === node) ||
      (ts.isImportSpecifier(parent) && parent.name === node) ||
      (ts.isImportClause(parent) && parent.name === node) ||
      (ts.isNamespaceImport(parent) && parent.name === node) ||
      (ts.isBindingElement(parent) && parent.name === node)
  );
}

function isWriteIdentifier(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (ts.isVariableDeclaration(parent) && parent.name === node) return Boolean(parent.initializer);
  if (ts.isBinaryExpression(parent) && parent.left === node) {
    return parent.operatorToken.kind >= ts.SyntaxKind.FirstAssignment &&
      parent.operatorToken.kind <= ts.SyntaxKind.LastAssignment;
  }
  if (ts.isPrefixUnaryExpression(parent) || ts.isPostfixUnaryExpression(parent)) {
    return parent.operator === ts.SyntaxKind.PlusPlusToken ||
      parent.operator === ts.SyntaxKind.MinusMinusToken;
  }
  return false;
}

function symbolKey(symbol) {
  const declarations = symbol.getDeclarations() ?? [];
  const declaration = declarations.find((entry) => isAppSourceFile(entry.getSourceFile())) ?? declarations[0];
  if (!declaration) return `global:${String(symbol.escapedName)}`;
  const sourceFile = declaration.getSourceFile();
  const location = locationFor(sourceFile, declaration);
  return `${location.file}:${location.line}:${location.column}:${String(symbol.escapedName)}`;
}

function resolveSymbol(checker, node) {
  let symbol = checker.getSymbolAtLocation(node);
  if (!symbol) return null;
  if ((symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    try {
      symbol = checker.getAliasedSymbol(symbol);
    } catch {
      // Keep the alias symbol when the checker cannot resolve it.
    }
  }
  return symbol;
}

function ensureInfo(map, key, symbol) {
  let info = map.get(key);
  if (info) return info;
  const declarations = (symbol.getDeclarations() ?? [])
    .filter((declaration) => isAppSourceFile(declaration.getSourceFile()))
    .map((declaration) => ({
      kind: declarationKind(declaration),
      location: locationFor(declaration.getSourceFile(), declaration),
    }));
  info = {
    key,
    names: new Set([String(symbol.escapedName)]),
    tags: new Set(),
    declarations,
    references: [],
    writes: 0,
    dependencyOwners: new Set(),
  };
  map.set(key, info);
  return info;
}

function propertyNameText(name) {
  if (!name) return "";
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  return "";
}

function collectDependencyMatches(sourceFile, node, checker, symbolInfos, customPattern) {
  if (!ts.isCallExpression(node)) return [];
  const expression = node.expression;
  if (!ts.isIdentifier(expression) || !dependencyOwnerNames.has(expression.text)) return [];
  const firstArg = node.arguments[0];
  if (!firstArg || !ts.isObjectLiteralExpression(firstArg)) return [];

  const owner = expression.text;
  const matches = [];
  for (const property of firstArg.properties) {
    if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) continue;
    const name = ts.isShorthandPropertyAssignment(property)
      ? property.name.text
      : propertyNameText(property.name);
    if (!name) continue;
    const tags = tagsForName(name, customPattern);
    if (!tags.size) continue;
    const location = locationFor(sourceFile, property.name);
    matches.push({
      owner,
      property: name,
      tags: [...tags].sort(),
      location,
    });

    const symbolNode = ts.isShorthandPropertyAssignment(property)
      ? property.name
      : ts.isIdentifier(property.initializer)
        ? property.initializer
        : null;
    if (symbolNode) {
      const symbol = resolveSymbol(checker, symbolNode);
      if (symbol) {
        const info = ensureInfo(symbolInfos, symbolKey(symbol), symbol);
        info.names.add(name);
        for (const tag of tags) info.tags.add(tag);
        info.dependencyOwners.add(owner);
      }
    }
  }
  return matches;
}

function scoreCandidate(info) {
  const tagWeight = [...info.tags].reduce((total, tag) => {
    if (highSignalTags.has(tag)) return total + 18;
    if (tag.startsWith("legacy") || tag.startsWith("frontend-")) return total + 8;
    if (tag.startsWith("compat") || tag.startsWith("fallback")) return total + 6;
    if (tag.startsWith("deprecated") || tag.startsWith("stale")) return total + 5;
    return total + 3;
  }, 0);
  const productionRefs = info.references.filter((ref) => ref.kind === "production").length;
  const testRefs = info.references.filter((ref) => ref.kind === "test").length;
  return tagWeight +
    Math.min(productionRefs, 20) +
    Math.min(testRefs, 6) +
    info.writes * 2 +
    info.dependencyOwners.size * 6;
}

function parseTsconfig() {
  if (!existsSync(tsconfigPath)) {
    throw new Error(`Missing tsconfig: ${tsconfigPath}`);
  }
  const raw = ts.readConfigFile(tsconfigPath, (fileName) => readFileSync(fileName, "utf8"));
  if (raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, "\n"));
  const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, appRoot);
  if (parsed.errors.length) {
    const message = parsed.errors
      .map((error) => ts.flattenDiagnosticMessageText(error.messageText, "\n"))
      .join("\n");
    throw new Error(message);
  }
  return parsed;
}

function audit() {
  const options = parseArgs(process.argv.slice(2));
  const parsed = parseTsconfig();
  const program = ts.createProgram(parsed.fileNames, parsed.options);
  const checker = program.getTypeChecker();
  const symbolInfos = new Map();
  const dependencyMatches = [];
  const files = program.getSourceFiles().filter(isAppSourceFile);

  for (const sourceFile of files) {
    const visit = (node) => {
      dependencyMatches.push(
        ...collectDependencyMatches(sourceFile, node, checker, symbolInfos, options.pattern),
      );

      if (ts.isIdentifier(node)) {
        const symbol = resolveSymbol(checker, node);
        if (symbol) {
          const name = node.text;
          const tags = tagsForName(name, options.pattern);
          const info = ensureInfo(symbolInfos, symbolKey(symbol), symbol);
          info.names.add(name);
          for (const tag of tags) info.tags.add(tag);
          if (tags.size || info.tags.size) {
            const loc = locationFor(sourceFile, node);
            info.references.push({
              location: loc,
              kind: fileKind(sourceFile.fileName),
              declaration: isDeclarationName(node),
              write: isWriteIdentifier(node),
            });
            if (isWriteIdentifier(node)) info.writes += 1;
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }

  const candidates = [...symbolInfos.values()]
    .filter((info) => info.tags.size)
    .map((info) => {
      const productionRefs = info.references.filter((ref) => ref.kind === "production").length;
      const testRefs = info.references.filter((ref) => ref.kind === "test").length;
      const scriptRefs = info.references.filter((ref) => ref.kind === "script").length;
      return {
        names: [...info.names].sort(),
        tags: [...info.tags].sort(),
        declarations: info.declarations,
        references: info.references,
        productionRefs,
        testRefs,
        scriptRefs,
        writes: info.writes,
        dependencyOwners: [...info.dependencyOwners].sort(),
        score: scoreCandidate(info),
      };
    })
    .sort((a, b) => b.score - a.score || b.productionRefs - a.productionRefs || a.names[0].localeCompare(b.names[0]));

  const limitedCandidates = candidates.slice(0, options.limit);
  const limitedDependencyMatches = dependencyMatches.slice(0, options.limit);
  const result = {
    tsconfig: relativePath(tsconfigPath),
    filesScanned: files.length,
    symbolsMatched: candidates.length,
    dependencyMatches: limitedDependencyMatches,
    candidates: limitedCandidates,
  };

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  console.log("# Legacy Symbol Audit");
  console.log("");
  console.log(`- tsconfig: ${result.tsconfig}`);
  console.log(`- files scanned: ${result.filesScanned}`);
  console.log(`- symbols matched: ${result.symbolsMatched}`);
  console.log(`- dependency object matches: ${result.dependencyMatches.length}`);
  console.log("");
  console.log("## Top Candidates");
  console.log("");
  console.log("| score | symbol | tags | declarations | refs prod/test/script | writes | owners |");
  console.log("| ---: | --- | --- | --- | ---: | ---: | --- |");
  for (const candidate of limitedCandidates) {
    const declarations = candidate.declarations
      .slice(0, 2)
      .map((entry) => `${entry.kind} ${formatLocation(entry.location)}`)
      .join("<br>");
    const owners = candidate.dependencyOwners.join(", ") || "";
    console.log(
      `| ${candidate.score} | ${candidate.names.join(", ")} | ${candidate.tags.join(", ")} | ${declarations || "(external)"} | ${candidate.productionRefs}/${candidate.testRefs}/${candidate.scriptRefs} | ${candidate.writes} | ${owners} |`,
    );
    if (options.details) {
      for (const ref of candidate.references.slice(0, 5)) {
        console.log(`|  | -> ${formatLocation(ref.location)} | ${ref.kind}${ref.declaration ? ", declaration" : ""}${ref.write ? ", write" : ""} |  |  |  |  |`);
      }
    }
  }

  if (dependencyMatches.length) {
    console.log("");
    console.log("## Dependency Object Matches");
    console.log("");
    console.log("| owner | property | tags | location |");
    console.log("| --- | --- | --- | --- |");
    for (const match of limitedDependencyMatches) {
      console.log(`| ${match.owner} | ${match.property} | ${match.tags.join(", ")} | ${formatLocation(match.location)} |`);
    }
  }
}

try {
  audit();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
