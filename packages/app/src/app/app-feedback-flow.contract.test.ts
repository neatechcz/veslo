import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as ts from "typescript";

const appSourceText = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const dashboardSourceText = readFileSync(new URL("./pages/dashboard.tsx", import.meta.url), "utf8");
const sessionSourceText = readFileSync(new URL("./pages/session.tsx", import.meta.url), "utf8");

const appSourceFile = ts.createSourceFile("app.tsx", appSourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const dashboardSourceFile = ts.createSourceFile(
  "dashboard.tsx",
  dashboardSourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const sessionSourceFile = ts.createSourceFile(
  "session.tsx",
  sessionSourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

function visit(node: ts.Node, predicate: (node: ts.Node) => boolean, results: ts.Node[] = []): ts.Node[] {
  if (predicate(node)) {
    results.push(node);
  }
  ts.forEachChild(node, (child) => {
    visit(child, predicate, results);
  });
  return results;
}

function isJsxElementLike(node: ts.Node): node is ts.JsxElement | ts.JsxSelfClosingElement {
  return ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node);
}

function getJsxTagName(node: ts.JsxElement | ts.JsxSelfClosingElement): string {
  return getJsxOpeningElement(node).tagName.getText();
}

function getJsxOpeningElement(node: ts.JsxElement | ts.JsxSelfClosingElement): ts.JsxOpeningLikeElement {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function getJsxAttribute(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  attributeName: string,
): ts.JsxAttribute | undefined {
  const opening = getJsxOpeningElement(node);
  for (const prop of opening.attributes.properties) {
    if (ts.isJsxAttribute(prop) && prop.name.text === attributeName) {
      return prop;
    }
  }
  return undefined;
}

function getJsxAttributeExpression(
  node: ts.JsxElement | ts.JsxSelfClosingElement,
  attributeName: string,
): ts.Expression | undefined {
  const attribute = getJsxAttribute(node, attributeName);
  if (!attribute || !attribute.initializer) {
    return undefined;
  }
  if (ts.isJsxExpression(attribute.initializer)) {
    return attribute.initializer.expression ?? undefined;
  }
  if (ts.isStringLiteral(attribute.initializer) || ts.isNoSubstitutionTemplateLiteral(attribute.initializer)) {
    return attribute.initializer;
  }
  return undefined;
}

function findJsxElements(sourceFile: ts.SourceFile, tagName: string): Array<ts.JsxElement | ts.JsxSelfClosingElement> {
  return visit(sourceFile, (node) => isJsxElementLike(node) && getJsxTagName(node) === tagName) as Array<
    ts.JsxElement | ts.JsxSelfClosingElement
  >;
}

function findTypeAlias(sourceFile: ts.SourceFile, name: string): ts.TypeAliasDeclaration | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isTypeAliasDeclaration(statement) && statement.name.text === name) {
      return statement;
    }
  }
  return undefined;
}

function findTopLevelVariableDeclaration(
  sourceFile: ts.SourceFile,
  name: string,
): ts.VariableDeclaration | undefined {
  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration;
      }
    }
  }
  return undefined;
}

function findTopLevelFunction(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | ts.VariableDeclaration | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return statement;
    }
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration;
      }
    }
  }
  return undefined;
}

function getReturnedObjectLiteral(node: ts.FunctionDeclaration | ts.VariableDeclaration): ts.ObjectLiteralExpression | undefined {
  const body = ts.isFunctionDeclaration(node) ? node.body : node.initializer && ts.isArrowFunction(node.initializer) ? node.initializer.body : undefined;
  if (!body) return undefined;
  if (ts.isBlock(body)) {
    for (const statement of body.statements) {
      if (!ts.isReturnStatement(statement) || !statement.expression || !ts.isObjectLiteralExpression(statement.expression)) continue;
      return statement.expression;
    }
    return undefined;
  }
  return ts.isObjectLiteralExpression(body) ? body : undefined;
}

function getObjectPropertyExpression(
  objectLiteral: ts.ObjectLiteralExpression,
  propertyName: string,
): ts.Expression | undefined {
  for (const property of objectLiteral.properties) {
    if (!ts.isPropertyAssignment(property)) continue;
    const name = property.name;
    if (ts.isIdentifier(name) && name.text === propertyName) {
      return property.initializer;
    }
    if (ts.isStringLiteral(name) && name.text === propertyName) {
      return property.initializer;
    }
  }
  return undefined;
}

function getObjectLiteralExpressionFromCallable(
  sourceFile: ts.SourceFile,
  callable: ts.FunctionDeclaration | ts.VariableDeclaration | undefined,
): ts.ObjectLiteralExpression | undefined {
  if (!callable) return undefined;
  if (ts.isFunctionDeclaration(callable)) {
    return getReturnedObjectLiteral(callable);
  }
  const initializer = callable.initializer;
  if (!initializer) return undefined;
  if (ts.isObjectLiteralExpression(initializer)) return initializer;
  if (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer)) {
    if (ts.isObjectLiteralExpression(initializer.body)) {
      return initializer.body;
    }
    if (ts.isBlock(initializer.body)) {
      for (const statement of initializer.body.statements) {
        if (!ts.isReturnStatement(statement) || !statement.expression || !ts.isObjectLiteralExpression(statement.expression)) continue;
        return statement.expression;
      }
    }
  }
  if (ts.isCallExpression(initializer)) {
    return getObjectLiteralExpressionFromExpression(sourceFile, initializer);
  }
  return undefined;
}

function getObjectLiteralExpressionFromExpression(
  sourceFile: ts.SourceFile,
  expression: ts.Expression | undefined,
): ts.ObjectLiteralExpression | undefined {
  const normalized = unwrapExpression(expression);
  if (!normalized) return undefined;

  if (ts.isObjectLiteralExpression(normalized)) {
    return normalized;
  }

  if (ts.isIdentifier(normalized)) {
    const variable = findTopLevelVariableDeclaration(sourceFile, normalized.text);
    if (variable) {
      return getObjectLiteralExpressionFromCallable(sourceFile, variable);
    }
    const callable = findTopLevelFunction(sourceFile, normalized.text);
    if (callable) {
      return getObjectLiteralExpressionFromCallable(sourceFile, callable);
    }
    return undefined;
  }

  if (ts.isCallExpression(normalized)) {
    return getObjectLiteralExpressionFromExpression(sourceFile, normalized.expression);
  }

  if (ts.isParenthesizedExpression(normalized) || ts.isAsExpression(normalized) || ts.isTypeAssertionExpression(normalized)) {
    return getObjectLiteralExpressionFromExpression(sourceFile, normalized.expression);
  }

  return undefined;
}

function resolveOnOpenFeedbackExpressionFromExpression(
  sourceFile: ts.SourceFile,
  expression: ts.Expression | undefined,
): ts.Expression | undefined {
  const objectLiteral = getObjectLiteralExpressionFromExpression(sourceFile, expression);
  if (!objectLiteral) {
    return undefined;
  }
  return getObjectPropertyExpression(objectLiteral, "onOpenFeedback");
}

function resolveOnOpenFeedbackExpressionFromJsx(
  sourceFile: ts.SourceFile,
  node: ts.JsxElement | ts.JsxSelfClosingElement,
): ts.Expression | undefined {
  const direct = getJsxAttributeExpression(node, "onOpenFeedback");
  if (direct) return direct;

  const opening = getJsxOpeningElement(node);
  for (const prop of opening.attributes.properties) {
    if (!ts.isJsxSpreadAttribute(prop)) continue;
    const resolved = resolveOnOpenFeedbackExpressionFromExpression(sourceFile, prop.expression);
    if (resolved) return resolved;
  }

  return undefined;
}

function unwrapExpression(expression: ts.Expression | undefined): ts.Expression | undefined {
  let current = expression;
  while (current && (ts.isParenthesizedExpression(current) || ts.isAsExpression(current) || ts.isTypeAssertionExpression(current))) {
    current = current.expression;
  }
  return current;
}

function getCallbackDeclaration(
  sourceFile: ts.SourceFile,
  expression: ts.Expression,
): ts.VariableDeclaration | ts.FunctionDeclaration | undefined {
  const normalized = unwrapExpression(expression);
  if (!normalized) return undefined;

  if (ts.isIdentifier(normalized)) {
    const variable = findTopLevelVariableDeclaration(sourceFile, normalized.text);
    if (variable) return variable;
    for (const statement of sourceFile.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === normalized.text) {
        return statement;
      }
    }
    return undefined;
  }

  if (ts.isArrowFunction(normalized) || ts.isFunctionExpression(normalized)) {
    const fakeVariable = ts.factory.createVariableDeclaration("inline", undefined, undefined, normalized);
    return fakeVariable as unknown as ts.VariableDeclaration;
  }

  if (ts.isCallExpression(normalized)) {
    return getCallbackDeclaration(sourceFile, normalized.expression);
  }

  return undefined;
}

function functionBodyContainsCall(
  node: ts.FunctionDeclaration | ts.VariableDeclaration,
  calleeName: string,
  expectedArgumentText: string,
): boolean {
  const functionLike = ts.isFunctionDeclaration(node)
    ? node
    : node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ? node.initializer
      : undefined;
  if (!functionLike || !functionLike.body) return false;

  const body = functionLike.body;
  let matched = false;
  visit(body, (child) => {
    if (!ts.isCallExpression(child)) return false;
    const callee = child.expression;
    if (!ts.isIdentifier(callee) || callee.text !== calleeName) return false;
    if (child.arguments.length !== 1) return false;
    const arg = child.arguments[0];
    if (arg.getText() !== expectedArgumentText) return false;
    matched = true;
    return true;
  });
  return matched;
}

function expressionText(sourceFile: ts.SourceFile, expression: ts.Expression | undefined): string {
  return expression ? expression.getText(sourceFile) : "";
}

function findButtonNodes(root: ts.Node): Array<ts.JsxElement | ts.JsxSelfClosingElement> {
  return visit(root, (node) => isJsxElementLike(node) && getJsxTagName(node) === "button") as Array<
    ts.JsxElement | ts.JsxSelfClosingElement
  >;
}

function assertPageFeedbackContract(
  sourceFile: ts.SourceFile,
  propsTypeName: string,
  viewName: string,
): void {
  const propsType = findTypeAlias(sourceFile, propsTypeName);
  assert.ok(propsType, `${propsTypeName} should be declared`);
  assert.ok(ts.isTypeLiteralNode(propsType!.type), `${propsTypeName} should be a type literal`);

  const onOpenFeedbackProperty = propsType!.type.members.find(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) &&
      member.name.getText(sourceFile) === "onOpenFeedback",
  );
  assert.ok(onOpenFeedbackProperty, `${propsTypeName} should declare onOpenFeedback`);
  assert.ok(
    onOpenFeedbackProperty!.type && ts.isFunctionTypeNode(onOpenFeedbackProperty!.type),
    `${propsTypeName}.onOpenFeedback should be a function type`,
  );
  assert.equal(onOpenFeedbackProperty!.type!.parameters.length, 0, `${propsTypeName}.onOpenFeedback should take no args`);
  assert.equal(onOpenFeedbackProperty!.type!.type.getText(sourceFile), "void", `${propsTypeName}.onOpenFeedback should return void`);

  const titlebar = findJsxElements(sourceFile, "TitlebarMenuToggles").find((node) => getJsxAttribute(node, "rightContent"));
  assert.ok(titlebar, `${viewName} should render TitlebarMenuToggles with rightContent`);

  const rightContent = getJsxAttributeExpression(titlebar!, "rightContent");
  assert.ok(rightContent, `${viewName} should provide rightContent`);

  const buttonsWithSharedOpen = findButtonNodes(sourceFile).filter((button) => {
    const onClickExpression = getJsxAttributeExpression(button, "onClick");
    return expressionText(sourceFile, onClickExpression) === "props.onOpenFeedback";
  });
  assert.equal(
    buttonsWithSharedOpen.length,
    1,
    `${viewName} should have exactly one button wired to props.onOpenFeedback`,
  );

  const rightContentButtons = findButtonNodes(rightContent!);
  assert.equal(rightContentButtons.length, 1, `${viewName} should put exactly one button in shared rightContent`);
  assert.equal(
    buttonsWithSharedOpen[0],
    rightContentButtons[0],
    `${viewName} should render the shared onOpenFeedback button inside rightContent`,
  );
}

test("app shell owns feedback modal state and shared feedback opener", () => {
  const feedbackModal = findJsxElements(appSourceFile, "FeedbackModal").find((node) => getJsxAttribute(node, "open"));
  assert.ok(feedbackModal, "app.tsx should render FeedbackModal");

  const openExpression = getJsxAttributeExpression(feedbackModal!, "open");
  assert.ok(openExpression, "FeedbackModal should receive an open expression");
  assert.ok(ts.isCallExpression(openExpression), "FeedbackModal open should be an accessor call");
  assert.ok(ts.isIdentifier(openExpression.expression), "FeedbackModal open accessor should be a simple identifier");

  const openAccessorName = openExpression.expression.text;
  const stateDeclaration = [...appSourceFile.statements]
    .flatMap((statement) => (ts.isVariableStatement(statement) ? [...statement.declarationList.declarations] : []))
    .find((declaration) => {
      if (!declaration.name || !ts.isArrayBindingPattern(declaration.name)) return false;
      const bindings = declaration.name.elements.filter((element): element is ts.BindingElement => !!element.name);
      if (bindings.length < 2) return false;
      const [accessor, setter] = bindings;
      return (
        ts.isIdentifier(accessor.name) &&
        accessor.name.text === openAccessorName &&
        ts.isIdentifier(setter.name) &&
        ts.isCallExpression(declaration.initializer) &&
        ts.isIdentifier(declaration.initializer.expression) &&
        declaration.initializer.expression.text === "createSignal" &&
        declaration.initializer.arguments.length >= 1 &&
        declaration.initializer.arguments[0].getText(appSourceFile) === "false"
      );
    });
  assert.ok(stateDeclaration, "FeedbackModal open should come from a shared createSignal(false) pair");

  const [accessorBinding, setterBinding] = (stateDeclaration!.name as ts.ArrayBindingPattern).elements;
  assert.ok(ts.isIdentifier(accessorBinding.name), "feedback open accessor should be an identifier");
  assert.ok(ts.isIdentifier(setterBinding.name), "feedback open setter should be an identifier");

  const onCloseExpression = getJsxAttributeExpression(feedbackModal!, "onClose");
  assert.ok(onCloseExpression, "FeedbackModal should receive onClose");

  const setterName = setterBinding.name.text;
  const onCloseDecl = getCallbackDeclaration(appSourceFile, onCloseExpression!);
  assert.ok(onCloseDecl, "FeedbackModal onClose should be backed by a callback declaration");
  assert.ok(
    functionBodyContainsCall(onCloseDecl!, setterName, "false"),
    "FeedbackModal onClose should close the same shared feedback state",
  );

  const dashboardView = findJsxElements(appSourceFile, "DashboardView").find(() => true);
  const sessionView = findJsxElements(appSourceFile, "SessionView").find(() => true);
  assert.ok(dashboardView, "App should render DashboardView");
  assert.ok(sessionView, "App should render SessionView");

  const dashboardViewCallback = resolveOnOpenFeedbackExpressionFromJsx(appSourceFile, dashboardView!);
  const sessionViewCallback = resolveOnOpenFeedbackExpressionFromJsx(appSourceFile, sessionView!);
  assert.ok(dashboardViewCallback, "DashboardView should receive onOpenFeedback");
  assert.ok(sessionViewCallback, "SessionView should receive onOpenFeedback");
  assert.equal(
    dashboardViewCallback!.getText(appSourceFile),
    sessionViewCallback!.getText(appSourceFile),
    "App should route the same shared onOpenFeedback callback into both page views",
  );

  const sharedCallbackDecl = getCallbackDeclaration(appSourceFile, dashboardViewCallback!);
  assert.ok(sharedCallbackDecl, "shared onOpenFeedback callback should be declared in app.tsx");
  assert.ok(
    functionBodyContainsCall(sharedCallbackDecl!, setterName, "true"),
    "shared onOpenFeedback callback should open the same feedback modal state",
  );
  assert.equal(
    sharedCallbackDecl.name?.getText(appSourceFile) ?? dashboardViewCallback!.getText(appSourceFile),
    sharedCallbackDecl.name?.getText(appSourceFile) ?? sessionViewCallback!.getText(appSourceFile),
    "DashboardView and SessionView should resolve the same shared feedback callback declaration",
  );
});

test("dashboard view keeps the explicit onOpenFeedback page contract", () => {
  assertPageFeedbackContract(dashboardSourceFile, "DashboardViewProps", "DashboardView");
});

test("session view keeps the explicit onOpenFeedback page contract", () => {
  assertPageFeedbackContract(sessionSourceFile, "SessionViewProps", "SessionView");
});
