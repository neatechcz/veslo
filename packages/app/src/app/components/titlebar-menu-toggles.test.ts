import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as ts from "typescript";

const source = readFileSync(new URL("./titlebar-menu-toggles.tsx", import.meta.url), "utf8");
const sourceFile = ts.createSourceFile(
  "titlebar-menu-toggles.tsx",
  source,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function findNode<T extends ts.Node>(
  root: ts.Node,
  predicate: (node: ts.Node) => node is T,
): T | undefined {
  let found: T | undefined;

  const visit = (node: ts.Node) => {
    if (found) return;
    if (predicate(node)) {
      found = node;
      return;
    }
    ts.forEachChild(node, visit);
  };

  visit(root);
  return found;
}

function getOpeningElement(node: ts.JsxElement | ts.JsxSelfClosingElement) {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function getJsxAttributeText(openingElement: ts.JsxOpeningLikeElement, name: string) {
  const attribute = openingElement.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && ts.isIdentifier(property.name) && property.name.text === name,
  );
  assert.ok(attribute, `missing ${name} attribute`);
  assert.ok(attribute.initializer, `missing ${name} initializer`);
  return attribute.initializer.getText(sourceFile);
}

function findTypeAlias(name: string) {
  return sourceFile.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
  );
}

function findFunctionDeclaration(name: string) {
  return sourceFile.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
}

function findJsxElementInTree(
  root: ts.Node,
  tagName: string,
  predicate?: (openingElement: ts.JsxOpeningLikeElement) => boolean,
) {
  return findNode(root, (node): node is ts.JsxElement | ts.JsxSelfClosingElement => {
    if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return false;
    const openingElement = getOpeningElement(node);
    return openingElement.tagName.getText(sourceFile) === tagName && (!predicate || predicate(openingElement));
  });
}

function isMeaningfulJsxChild(node: ts.JsxChild) {
  return !(ts.isJsxText(node) && node.getText(sourceFile).trim() === "");
}

test("titlebar menu toggles keep macOS-sized icon controls", () => {
  assert.match(
    source,
    /`h-6 w-6 flex items-center justify-center bg-transparent transition-colors focus:outline-none focus-visible:ring-0 \$\{/,
    "titlebar toggles should keep a 24px control box so their height matches native titlebar buttons",
  );

  assert.match(
    source,
    /<LeftSidebarToggleIcon size=\{18\} \/>/,
    "left titlebar toggle icon should use the 18px size needed for the visible outline to match native titlebar button height",
  );

  assert.match(
    source,
    /<RightSidebarToggleIcon size=\{18\} \/>/,
    "right titlebar toggle icon should use the 18px size needed for the visible outline to match native titlebar button height",
  );

  assert.doesNotMatch(source, /LeftSidebarToggleIcon size=\{1[13]\}/, "left titlebar toggle should not regress");
  assert.doesNotMatch(source, /RightSidebarToggleIcon size=\{1[13]\}/, "right titlebar toggle should not regress");
});

test("Windows Tauri titlebar exposes app-owned window controls", () => {
  assert.match(source, /const\s+showWindowsWindowControls\s*=\s*isTauri\s*&&\s*isWindows;/);
  assert.match(source, /aria-label=\{__vesloT\("ui\.literal\.minimize_window_1rr7i2", __vesloCurrentLocale\(\)\)\}/);
  assert.match(source, /minimizeCurrentWindow/);
  assert.match(
    source,
    /aria-label=\{__vesloT\("ui\.literal\.maximize_or_restore_window_5ds1ae", __vesloCurrentLocale\(\)\)\}/,
  );
  assert.match(source, /toggleMaximizeCurrentWindow/);
  assert.match(source, /aria-label=\{__vesloT\("ui\.literal\.close_window_1vvpub", __vesloCurrentLocale\(\)\)\}/);
  assert.match(source, /closeCurrentWindow/);
  assert.match(
    source,
    /onDblClick=\{handleTitlebarDoubleClick\}/,
    "Windows app-owned titlebar should preserve double-click maximize behavior",
  );
});

test("titlebar text labels are not selectable while dragging the window", () => {
  assert.match(
    source,
    /<span[\s\S]*class="[^"]*\bselect-none\b[^"]*"[\s\S]*>\s*\{__vesloT\("ui\.literal\.veslo_by_neatech_86m8cx", __vesloCurrentLocale\(\)\)\}/,
    "fallback app name should not be selectable in the draggable titlebar area",
  );

  assert.match(
    source,
    /<div[\s\S]*class="[^"]*\bselect-none\b[^"]*"[\s\S]*>\s*\{props\.centerContent\}/,
    "centered session and project titlebar labels should not be selectable",
  );
});

test("titlebar text labels participate in window dragging", () => {
  assert.match(
    source,
    /<span[\s\S]*data-tauri-drag-region[\s\S]*onMouseDown=\{handleTitlebarDragMouseDown\}[\s\S]*class="[^"]*\bselect-none\b[^"]*"[\s\S]*>\s*\{__vesloT\("ui\.literal\.veslo_by_neatech_86m8cx", __vesloCurrentLocale\(\)\)\}/,
    "fallback app name should be a Tauri drag region instead of blocking the titlebar drag strip",
  );

  assert.match(
    source,
    /<div[\s\S]*data-tauri-drag-region[\s\S]*onMouseDown=\{handleTitlebarDragMouseDown\}[\s\S]*class="[^"]*\bselect-none\b[^"]*"[\s\S]*>\s*\{props\.centerContent\}/,
    "centered session and project titlebar labels should be Tauri drag regions",
  );
});

test("titlebar menu toggles let session context replace the left-side brand", () => {
  assert.match(
    source,
    /ui\.literal\.veslo_by_neatech_86m8cx/,
    "titlebar should keep the Veslo brand as the fallback label when no session-specific titlebar content is provided",
  );

  assert.match(
    source,
    /leftContent\??:[\s\S]*showBrand\??:/,
    "titlebar should accept optional left-side content and an explicit brand toggle so session view can show only the directory beside the left toggle",
  );

  assert.match(
    source,
    /<div class=\{layout\.leftOffsetClass\}>[\s\S]*<LeftSidebarToggleIcon size=\{18\} \/>[\s\S]*props\.leftContent[\s\S]*props\.showBrand !== false[\s\S]*ui\.literal\.veslo_by_neatech_86m8cx/,
    "titlebar should render provided left-side content in the same cluster as the left toggle and only show the brand fallback when that behavior is explicitly enabled",
  );
});

test("titlebar menu toggles support a custom left label and default to toggle text", () => {
  assert.match(
    source,
    /leftLabel\?: string;/,
    "titlebar should accept an optional left-button label prop",
  );

  assert.match(
    source,
    /const\s+leftLabel\s*=\s*\(\)\s*=>\s*props\.leftLabel\s*\?\?\s*__vesloT\("sidebar\.toggle_left_menu", __vesloCurrentLocale\(\)\);/,
    "titlebar should derive the left label reactively",
  );

  assert.match(
    source,
    /aria-label=\{leftLabel\(\)\}/,
    "titlebar should use the resolved left label for the aria-label",
  );

  assert.match(
    source,
    /title=\{leftLabel\(\)\}/,
    "titlebar should use the resolved left label for the title",
  );
});

test("titlebar menu toggles expose a dedicated right-side content slot", () => {
  const propsAlias = findTypeAlias("TitlebarMenuTogglesProps");
  assert.ok(propsAlias, "titlebar should define a props type");
  assert.ok(ts.isTypeLiteralNode(propsAlias!.type), "titlebar props type should be a type literal");

  const rightContentProp = propsAlias!.type.members.find(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) && member.name.getText(sourceFile) === "rightContent",
  );
  assert.ok(rightContentProp, "titlebar should declare a rightContent prop");
  assert.ok(rightContentProp!.questionToken, "rightContent should stay optional");
  assert.equal(rightContentProp!.type?.getText(sourceFile), "JSX.Element");

  const component = findFunctionDeclaration("TitlebarMenuToggles");
  assert.ok(component?.body, "titlebar should define a component body");

  const rightRail = findJsxElementInTree(
    component!.body!,
    "div",
    (openingElement) => /layout\.rightOffsetClass/.test(getJsxAttributeText(openingElement, "class")),
  );
  assert.ok(rightRail, "titlebar should render a shared right rail");

  const rightRailClass = getJsxAttributeText(getOpeningElement(rightRail!), "class");
  assert.match(
    rightRailClass,
    /layout\.rightOffsetClass[\s\S]*flex[\s\S]*shrink-0[\s\S]*flex-nowrap[\s\S]*items-center[\s\S]*gap-1/,
    "titlebar right rail should stay on a single row so feedback and the right toggle do not wrap onto a second line",
  );

  assert.ok(ts.isJsxElement(rightRail!), "titlebar right rail should be a standard JSX element");
  const meaningfulChildren = rightRail!.children.filter((child: ts.JsxChild) => isMeaningfulJsxChild(child));
  const rightContentIndex = meaningfulChildren.findIndex(
    (child) => ts.isJsxExpression(child) && child.expression?.getText(sourceFile) === "props.rightContent",
  );
  const rightToggleIndex = meaningfulChildren.findIndex(
    (child) =>
      ts.isJsxElement(child) &&
      child.openingElement.tagName.getText(sourceFile) === "button" &&
      getJsxAttributeText(child.openingElement, "onClick") === "{() => props.onToggleRight()}" &&
      Boolean(findJsxElementInTree(child, "RightSidebarToggleIcon")),
  );

  assert.ok(rightContentIndex >= 0, "titlebar should render right-side content in the shared right rail");
  assert.ok(rightToggleIndex >= 0, "titlebar should keep the existing right toggle in the shared right rail");
  assert.ok(
    rightContentIndex < rightToggleIndex,
    "right-side content should appear before the existing right toggle button",
  );
});
