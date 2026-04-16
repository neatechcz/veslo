import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as ts from "typescript";

const appSource = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./pages/dashboard.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("./pages/session.tsx", import.meta.url), "utf8");

const appFile = ts.createSourceFile("app.tsx", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const dashboardFile = ts.createSourceFile("dashboard.tsx", dashboardSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const sessionFile = ts.createSourceFile("session.tsx", sessionSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);

function findNode<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T) {
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

function findAllNodes<T extends ts.Node>(root: ts.Node, predicate: (node: ts.Node) => node is T) {
  const nodes: T[] = [];
  const visit = (node: ts.Node) => {
    if (predicate(node)) nodes.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return nodes;
}

function getOpeningElement(node: ts.JsxElement | ts.JsxSelfClosingElement) {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function getJsxAttribute(openingElement: ts.JsxOpeningLikeElement, name: string) {
  return openingElement.attributes.properties.find(
    (property): property is ts.JsxAttribute => ts.isJsxAttribute(property) && property.name.text === name,
  );
}

function getJsxAttributeExpression(openingElement: ts.JsxOpeningLikeElement, name: string) {
  const attribute = getJsxAttribute(openingElement, name);
  if (!attribute?.initializer || !ts.isJsxExpression(attribute.initializer)) return undefined;
  return attribute.initializer.expression ?? undefined;
}

function findJsxElementInTree(
  root: ts.Node,
  tagName: string,
  predicate?: (openingElement: ts.JsxOpeningLikeElement) => boolean,
) {
  return findNode(root, (node): node is ts.JsxElement | ts.JsxSelfClosingElement => {
    if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return false;
    const openingElement = getOpeningElement(node);
    return openingElement.tagName.getText(openingElement.getSourceFile()) === tagName &&
      (!predicate || predicate(openingElement));
  });
}

function findAllJsxElements(root: ts.Node, tagName: string) {
  return findAllNodes(root, (node): node is ts.JsxElement | ts.JsxSelfClosingElement => {
    if (!ts.isJsxElement(node) && !ts.isJsxSelfClosingElement(node)) return false;
    return getOpeningElement(node).tagName.getText(node.getSourceFile()) === tagName;
  });
}

function findTypeAlias(file: ts.SourceFile, name: string) {
  return file.statements.find(
    (statement): statement is ts.TypeAliasDeclaration =>
      ts.isTypeAliasDeclaration(statement) && statement.name.text === name,
  );
}

function findFunctionDeclaration(file: ts.SourceFile, name: string) {
  return file.statements.find(
    (statement): statement is ts.FunctionDeclaration =>
      ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
}

function getTopLevelVariableDeclarations(functionDeclaration: ts.FunctionDeclaration) {
  const declarations: ts.VariableDeclaration[] = [];
  for (const statement of functionDeclaration.body?.statements ?? []) {
    if (!ts.isVariableStatement(statement)) continue;
    declarations.push(...statement.declarationList.declarations);
  }
  return declarations;
}

function getArrayBindingNames(bindingName: ts.BindingName) {
  if (!ts.isArrayBindingPattern(bindingName)) return [];
  return bindingName.elements
    .map((element) => element.name.getText(element.getSourceFile()))
    .filter((name): name is string => Boolean(name));
}

function callInfo(node: ts.Expression | undefined) {
  if (!node || !ts.isCallExpression(node)) return null;
  return {
    callee: node.expression.getText(node.getSourceFile()),
    args: node.arguments.map((arg) => arg.getText(node.getSourceFile())),
  };
}

function containsCall(node: ts.Node, calleeName: string, argText: string) {
  return Boolean(
    findNode(node, (current): current is ts.CallExpression =>
      ts.isCallExpression(current) &&
      current.expression.getText(current.getSourceFile()) === calleeName &&
      current.arguments.length === 1 &&
      current.arguments[0].getText(current.getSourceFile()) === argText,
    ),
  );
}

function getPropNameFromCallbackReference(expr: ts.Expression) {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
  if (ts.isCallExpression(expr)) {
    if (ts.isIdentifier(expr.expression)) return expr.expression.text;
    if (ts.isPropertyAccessExpression(expr.expression)) return expr.expression.name.text;
  }
  if (ts.isArrowFunction(expr) || ts.isFunctionExpression(expr)) {
    if (ts.isCallExpression(expr.body)) return getPropNameFromCallbackReference(expr.body.expression);
    if (ts.isIdentifier(expr.body)) return expr.body.text;
    if (ts.isPropertyAccessExpression(expr.body)) return expr.body.name.text;
    if (ts.isBlock(expr.body)) {
      const returnStatement = expr.body.statements.find(ts.isReturnStatement);
      if (returnStatement?.expression) return getPropNameFromCallbackReference(returnStatement.expression);
      const expressionStatement = expr.body.statements.find(ts.isExpressionStatement);
      if (expressionStatement?.expression) return getPropNameFromCallbackReference(expressionStatement.expression);
    }
  }
  return null;
}

function feedbackStateFromOpenModal(appFunction: ts.FunctionDeclaration) {
  const feedbackModal = findJsxElementInTree(appFile, "FeedbackModal");
  assert.ok(feedbackModal, "App should render FeedbackModal");
  const openExpr = getJsxAttributeExpression(getOpeningElement(feedbackModal!), "open");
  assert.ok(openExpr, "FeedbackModal should have an open prop");
  assert.ok(ts.isCallExpression(openExpr), "FeedbackModal open should be a call expression");
  assert.ok(ts.isIdentifier(openExpr.expression), "FeedbackModal open should call a signal accessor identifier");
  const accessorName = openExpr.expression.text;

  const signalDeclaration = getTopLevelVariableDeclarations(appFunction).find((declaration) => {
    const names = getArrayBindingNames(declaration.name);
    const info = callInfo(declaration.initializer);
    return names.length === 2 && names[0] === accessorName && info?.callee === "createSignal" && info.args[0] === "false";
  });
  assert.ok(signalDeclaration, "App should own the state backing FeedbackModal");

  const [stateAccessorName, stateSetterName] = getArrayBindingNames(signalDeclaration!.name);
  return { stateAccessorName, stateSetterName };
}

function feedbackCallbackFromApp(appFunction: ts.FunctionDeclaration, stateSetterName: string) {
  const candidate = getTopLevelVariableDeclarations(appFunction).find((declaration) => {
    if (!ts.isIdentifier(declaration.name)) return false;
    return containsCall(declaration.initializer ?? declaration.name, stateSetterName, "true");
  });
  assert.ok(candidate, "App should define a shared callback that opens the feedback state");
  return candidate!;
}

function buttonIsFeedbackLabelled(button: ts.JsxElement | ts.JsxSelfClosingElement) {
  return /Feedback/i.test(button.getText(button.getSourceFile()));
}

function pageContract(pageSource: ts.SourceFile, propsTypeName: string) {
  const propsAlias = findTypeAlias(pageSource, propsTypeName);
  assert.ok(propsAlias, `${propsTypeName} should exist`);
  assert.ok(ts.isTypeLiteralNode(propsAlias!.type), `${propsTypeName} should be a type literal`);

  const titlebar = findJsxElementInTree(pageSource, "TitlebarMenuToggles");
  assert.ok(titlebar, "page should render TitlebarMenuToggles");
  const rightContentExpr = getJsxAttributeExpression(getOpeningElement(titlebar!), "rightContent");
  assert.ok(rightContentExpr, "page should pass rightContent to TitlebarMenuToggles");
  const rightContentButton = findJsxElementInTree(rightContentExpr!, "button");
  assert.ok(rightContentButton, "rightContent should render a button");

  const onClickExpr = getJsxAttributeExpression(getOpeningElement(rightContentButton!), "onClick");
  assert.ok(onClickExpr, "feedback button should have an onClick handler");
  const callbackPropName = getPropNameFromCallbackReference(onClickExpr!);
  assert.ok(callbackPropName, "feedback button onClick should reference a shared callback prop");

  const propSignature = propsAlias!.type.members.find(
    (member): member is ts.PropertySignature =>
      ts.isPropertySignature(member) && member.name.getText(pageSource) === callbackPropName,
  );
  assert.ok(propSignature, `${propsTypeName} should declare ${callbackPropName}`);
  assert.equal(propSignature!.type?.getText(pageSource), "() => void", `${callbackPropName} should be a callback prop`);

  const feedbackButtons = findAllJsxElements(pageSource, "button").filter(buttonIsFeedbackLabelled);
  assert.equal(feedbackButtons.length, 1, `${propsTypeName} should expose exactly one feedback-labeled button`);
  assert.equal(feedbackButtons[0], rightContentButton, `${propsTypeName} should keep the feedback button inside rightContent`);
  assert.ok(
    feedbackButtons[0]!.pos >= rightContentExpr!.pos && feedbackButtons[0]!.end <= rightContentExpr!.end,
    `${propsTypeName} should not keep a separate page-local feedback button outside the shared titlebar path`,
  );
}

function getJsxAttributesMapForApp(openingElement: ts.JsxOpeningLikeElement) {
  const map = new Map<string, { expression: ts.Expression | null }>();
  for (const property of openingElement.attributes.properties) {
    if (!ts.isJsxAttribute(property)) continue;
    const expression = property.initializer && ts.isJsxExpression(property.initializer) ? property.initializer.expression : null;
    map.set(property.name.text, { expression });
  }
  return map;
}

function getSharedFeedbackPropName(appFunction: ts.FunctionDeclaration, stateSetterName: string) {
  const dashboardView = findJsxElementInTree(appFile, "DashboardView");
  const sessionView = findJsxElementInTree(appFile, "SessionView");
  assert.ok(dashboardView, "App should render DashboardView");
  assert.ok(sessionView, "App should render SessionView");

  const dashboardAttrs = getJsxAttributesMapForApp(getOpeningElement(dashboardView!));
  const sessionAttrs = getJsxAttributesMapForApp(getOpeningElement(sessionView!));
  const sharedNames = [...dashboardAttrs.keys()].filter((name) => sessionAttrs.has(name));

  const sharedFeedbackPropName = sharedNames.find((name) => {
    const dashboardText = dashboardAttrs.get(name)?.text;
    const sessionText = sessionAttrs.get(name)?.text;
    if (!dashboardText || !sessionText) return false;
    if (dashboardText !== sessionText) return false;
    const callbackName = dashboardText;
    const callbackDecl = getTopLevelVariableDeclarations(appFunction).find((declaration) => {
      if (!ts.isIdentifier(declaration.name) || declaration.name.text !== callbackName) return false;
      return containsCall(declaration.initializer ?? declaration.name, stateSetterName, "true");
    });
    return Boolean(callbackDecl);
  });

  assert.ok(sharedFeedbackPropName, "App should thread one shared callback prop into both page views");
  return sharedFeedbackPropName;
}

test("app shell owns the feedback modal state", () => {
  const appFunction = findFunctionDeclaration(appFile, "App");
  assert.ok(appFunction?.body, "App should be declared as a function");

  const { stateAccessorName, stateSetterName } = feedbackStateFromOpenModal(appFunction!);
  const sharedFeedbackPropName = getSharedFeedbackPropName(appFunction!, stateSetterName);
  const sharedCallbackDecl = feedbackCallbackFromApp(appFunction!, stateSetterName);

  const feedbackModal = findJsxElementInTree(appFile, "FeedbackModal");
  assert.ok(feedbackModal, "App should render FeedbackModal");
  const openExpr = getJsxAttributeExpression(getOpeningElement(feedbackModal!), "open");
  assert.ok(openExpr && ts.isCallExpression(openExpr), "FeedbackModal open should be a call expression");
  assert.equal(openExpr.expression.getText(appFile), stateAccessorName, "FeedbackModal should read the same state accessor");

  const onCloseExpr = getJsxAttributeExpression(getOpeningElement(feedbackModal!), "onClose");
  assert.ok(onCloseExpr, "FeedbackModal should have an onClose handler");
  assert.ok(
    containsCall(onCloseExpr!, stateSetterName, "false"),
    "FeedbackModal onClose should close the same app-owned state",
  );

  assert.ok(
    containsCall(sharedCallbackDecl.initializer ?? sharedCallbackDecl.name, stateSetterName, "true"),
    "shared callback should open the same app-owned state",
  );

  const dashboardView = findJsxElementInTree(appFile, "DashboardView");
  const sessionView = findJsxElementInTree(appFile, "SessionView");
  assert.ok(dashboardView, "App should render DashboardView");
  assert.ok(sessionView, "App should render SessionView");

  const dashboardAttrs = getJsxAttributesMapForApp(getOpeningElement(dashboardView!));
  const sessionAttrs = getJsxAttributesMapForApp(getOpeningElement(sessionView!));
  assert.equal(dashboardAttrs.get(sharedFeedbackPropName)?.text, sharedCallbackDecl.name.getText(appFile));
  assert.equal(sessionAttrs.get(sharedFeedbackPropName)?.text, sharedCallbackDecl.name.getText(appFile));
});

test("dashboard keeps feedback UI in the shared titlebar path", () => {
  pageContract(dashboardFile, "DashboardViewProps");
});

test("session keeps feedback UI in the shared titlebar path", () => {
  pageContract(sessionFile, "SessionViewProps");
});
