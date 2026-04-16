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

function getJsxChildren(node: ts.JsxElement | ts.JsxSelfClosingElement): ts.NodeArray<ts.JsxChild> {
  return ts.isJsxElement(node) ? node.children : ts.factory.createNodeArray([]);
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

function jsxSubtreeContainsFeedbackLabel(node: ts.JsxElement | ts.JsxSelfClosingElement): boolean {
  const textFragments: string[] = [];

  const collect = (current: ts.Node): void => {
    if (ts.isJsxText(current)) {
      textFragments.push(current.getText());
    } else if (ts.isStringLiteral(current) || ts.isNoSubstitutionTemplateLiteral(current)) {
      textFragments.push(current.text);
    }
    ts.forEachChild(current, collect);
  };

  collect(node);
  return textFragments.some((fragment) => /\bFeedback\b/.test(fragment));
}

function isDescendant(node: ts.Node, ancestor: ts.Node): boolean {
  for (let current: ts.Node | undefined = node.parent; current; current = current.parent) {
    if (current === ancestor) return true;
  }
  return false;
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

  const rightContentButtons = findButtonNodes(rightContent!);
  assert.equal(rightContentButtons.length, 1, `${viewName} should put exactly one button in shared rightContent`);

  const feedbackButtons = findButtonNodes(sourceFile).filter(jsxSubtreeContainsFeedbackLabel);
  assert.equal(
    feedbackButtons.length,
    1,
    `${viewName} should expose exactly one feedback-labeled button, and it should live in shared rightContent`,
  );
  assert.ok(
    isDescendant(feedbackButtons[0], rightContent!),
    `${viewName} should keep the feedback-labeled button inside shared rightContent`,
  );

  const feedbackButton = rightContentButtons[0];
  const onClickExpression = getJsxAttributeExpression(feedbackButton, "onClick");
  assert.ok(onClickExpression, `${viewName} rightContent button should have onClick`);
  assert.equal(
    expressionText(sourceFile, onClickExpression),
    "props.onOpenFeedback",
    `${viewName} rightContent button should use props.onOpenFeedback`,
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

  const sharedCallbackPropertyName = "onOpenFeedback";
  const dashboardPropsFactory = findTopLevelFunction(appSourceFile, "dashboardProps");
  const sessionPropsFactory = findTopLevelFunction(appSourceFile, "sessionProps");
  assert.ok(dashboardPropsFactory, "dashboardProps should exist");
  assert.ok(sessionPropsFactory, "sessionProps should exist");

  const dashboardPropsObject = getReturnedObjectLiteral(dashboardPropsFactory!);
  const sessionPropsObject = getReturnedObjectLiteral(sessionPropsFactory!);
  assert.ok(dashboardPropsObject, "dashboardProps should return an object literal");
  assert.ok(sessionPropsObject, "sessionProps should return an object literal");

  const dashboardCallback = getObjectPropertyExpression(dashboardPropsObject!, sharedCallbackPropertyName);
  const sessionCallback = getObjectPropertyExpression(sessionPropsObject!, sharedCallbackPropertyName);
  assert.ok(dashboardCallback, "dashboardProps should expose onOpenFeedback");
  assert.ok(sessionCallback, "sessionProps should expose onOpenFeedback");
  assert.equal(
    dashboardCallback!.getText(appSourceFile),
    sessionCallback!.getText(appSourceFile),
    "dashboardProps and sessionProps should share the same onOpenFeedback callback expression",
  );

  const dashboardCallbackDecl = getCallbackDeclaration(appSourceFile, dashboardCallback!);
  assert.ok(dashboardCallbackDecl, "shared onOpenFeedback callback should be declared in app.tsx");
  assert.ok(
    functionBodyContainsCall(dashboardCallbackDecl!, setterName, "true"),
    "shared onOpenFeedback callback should open the same feedback modal state",
  );

  const dashboardView = findJsxElements(appSourceFile, "DashboardView").find((node) =>
    ts.isJsxSelfClosingElement(node) &&
    node.attributes.properties.some(
      (prop) =>
        ts.isJsxSpreadAttribute(prop) &&
        ts.isCallExpression(prop.expression) &&
        ts.isIdentifier(prop.expression.expression) &&
        prop.expression.expression.text === "dashboardProps",
    ),
  );
  const sessionView = findJsxElements(appSourceFile, "SessionView").find((node) =>
    ts.isJsxSelfClosingElement(node) &&
    node.attributes.properties.some(
      (prop) =>
        ts.isJsxSpreadAttribute(prop) &&
        ts.isCallExpression(prop.expression) &&
        ts.isIdentifier(prop.expression.expression) &&
        prop.expression.expression.text === "sessionProps",
    ),
  );
  assert.ok(dashboardView, "App should spread dashboardProps into DashboardView");
  assert.ok(sessionView, "App should spread sessionProps into SessionView");
  assert.equal(
    dashboardCallback!.getText(appSourceFile),
    sessionCallback!.getText(appSourceFile),
    "App should route the same shared onOpenFeedback callback into both page prop objects",
  );
});

test("dashboard view keeps the explicit onOpenFeedback page contract", () => {
  assertPageFeedbackContract(dashboardSourceFile, "DashboardViewProps", "DashboardView");
});

test("session view keeps the explicit onOpenFeedback page contract", () => {
  assertPageFeedbackContract(sessionSourceFile, "SessionViewProps", "SessionView");
});
