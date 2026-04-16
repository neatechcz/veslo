import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import * as ts from "typescript";

const appSource = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./pages/dashboard.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("./pages/session.tsx", import.meta.url), "utf8");

const appFile = ts.createSourceFile("app.tsx", appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
const dashboardFile = ts.createSourceFile(
  "dashboard.tsx",
  dashboardSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);
const sessionFile = ts.createSourceFile(
  "session.tsx",
  sessionSource,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TSX,
);

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

function getOpeningElement(node: ts.JsxElement | ts.JsxSelfClosingElement) {
  return ts.isJsxElement(node) ? node.openingElement : node;
}

function getJsxAttribute(openingElement: ts.JsxOpeningLikeElement, name: string) {
  return openingElement.attributes.properties.find(
    (property): property is ts.JsxAttribute =>
      ts.isJsxAttribute(property) && property.name.text === name,
  );
}

function getJsxAttributeText(openingElement: ts.JsxOpeningLikeElement, name: string) {
  const attribute = getJsxAttribute(openingElement, name);
  assert.ok(attribute, `missing ${name} attribute`);
  assert.ok(attribute!.initializer, `missing ${name} initializer`);
  return attribute!.initializer!.getText(openingElement.getSourceFile());
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

function findTopLevelVariableDeclaration(
  functionDeclaration: ts.FunctionDeclaration,
  predicate: (declaration: ts.VariableDeclaration) => boolean,
) {
  for (const statement of functionDeclaration.body?.statements ?? []) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (predicate(declaration)) return declaration;
    }
  }
  return undefined;
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

function isMeaningfulJsxChild(node: ts.JsxChild) {
  return !(ts.isJsxText(node) && node.getText(node.getSourceFile()).trim() === "");
}

function getBindingNames(bindingName: ts.BindingName) {
  if (!ts.isArrayBindingPattern(bindingName)) return [];
  return bindingName.elements
    .map((element) => element.name.getText(element.getSourceFile()))
    .filter((name): name is string => Boolean(name));
}

function getCallExpressionText(node: ts.Expression | undefined) {
  if (!node || !ts.isCallExpression(node)) return null;
  return {
    callee: node.expression.getText(node.getSourceFile()),
    args: node.arguments.map((arg) => arg.getText(node.getSourceFile())),
  };
}

test("app shell owns the feedback modal state", () => {
  const appFunction = findFunctionDeclaration(appFile, "App");
  assert.ok(appFunction?.body, "App should be declared as a function");

  const feedbackState = findTopLevelVariableDeclaration(appFunction!, (declaration) => {
    const bindingNames = getBindingNames(declaration.name);
    const call = getCallExpressionText(declaration.initializer);
    return (
      bindingNames[0] === "feedbackModalOpen" &&
      bindingNames[1] === "setFeedbackModalOpen" &&
      call?.callee === "createSignal" &&
      call.args.length === 1 &&
      call.args[0] === "false"
    );
  });
  assert.ok(feedbackState, "App should own feedbackModalOpen state");

  const onOpenFeedback = findTopLevelVariableDeclaration(appFunction!, (declaration) => {
    if (!ts.isIdentifier(declaration.name) || declaration.name.text !== "onOpenFeedback") return false;
    const initializer = declaration.initializer;
    return (
      !!initializer &&
      ts.isArrowFunction(initializer) &&
      ts.isCallExpression(initializer.body) &&
      initializer.body.expression.getText(appFile) === "setFeedbackModalOpen" &&
      initializer.body.arguments.length === 1 &&
      initializer.body.arguments[0].getText(appFile) === "true"
    );
  });
  assert.ok(onOpenFeedback, "App should define an onOpenFeedback callback");

  const feedbackModal = findJsxElementInTree(appFile, "FeedbackModal");
  assert.ok(feedbackModal, "App should render a shared FeedbackModal");
  assert.equal(getJsxAttributeText(getOpeningElement(feedbackModal!), "open"), "{feedbackModalOpen()}");
  assert.ok(
    getJsxAttribute(getOpeningElement(feedbackModal!), "onClose"),
    "App should wire a close handler into FeedbackModal",
  );
});

test("dashboard and session receive the shared feedback trigger", () => {
  const dashboardProps = findTypeAlias(dashboardFile, "DashboardViewProps");
  assert.ok(dashboardProps, "dashboard should define DashboardViewProps");
  assert.ok(ts.isTypeLiteralNode(dashboardProps!.type), "dashboard props type should be a type literal");
  assert.equal(
    dashboardProps!.type.members.find(
      (member): member is ts.PropertySignature =>
        ts.isPropertySignature(member) && member.name.getText(dashboardFile) === "onOpenFeedback",
    )?.type?.getText(dashboardFile),
    "() => void",
    "dashboard should expose an onOpenFeedback prop in its contract",
  );

  const sessionProps = findTypeAlias(sessionFile, "SessionViewProps");
  assert.ok(sessionProps, "session should define SessionViewProps");
  assert.ok(ts.isTypeLiteralNode(sessionProps!.type), "session props type should be a type literal");
  assert.equal(
    sessionProps!.type.members.find(
      (member): member is ts.PropertySignature =>
        ts.isPropertySignature(member) && member.name.getText(sessionFile) === "onOpenFeedback",
    )?.type?.getText(sessionFile),
    "() => void",
    "session should expose an onOpenFeedback prop in its contract",
  );

  const dashboardTitlebar = findJsxElementInTree(dashboardFile, "TitlebarMenuToggles");
  const sessionTitlebar = findJsxElementInTree(sessionFile, "TitlebarMenuToggles");
  assert.ok(dashboardTitlebar, "dashboard should render the shared titlebar");
  assert.ok(sessionTitlebar, "session should render the shared titlebar");

  const dashboardRightContent = getJsxAttribute(getOpeningElement(dashboardTitlebar!), "rightContent");
  const sessionRightContent = getJsxAttribute(getOpeningElement(sessionTitlebar!), "rightContent");
  assert.ok(dashboardRightContent, "dashboard should provide rightContent to the shared titlebar");
  assert.ok(sessionRightContent, "session should provide rightContent to the shared titlebar");

  const dashboardButton = findJsxElementInTree(dashboardRightContent!.initializer!, "button");
  const sessionButton = findJsxElementInTree(sessionRightContent!.initializer!, "button");
  assert.ok(dashboardButton, "dashboard rightContent should render a button");
  assert.ok(sessionButton, "session rightContent should render a button");

  assert.equal(
    getJsxAttributeText(getOpeningElement(dashboardButton!), "onClick"),
    "{props.onOpenFeedback}",
    "dashboard button should call the shared onOpenFeedback prop",
  );
  assert.equal(
    getJsxAttributeText(getOpeningElement(sessionButton!), "onClick"),
    "{props.onOpenFeedback}",
    "session button should call the shared onOpenFeedback prop",
  );
});

test("app shell wires both page views to the shared feedback trigger", () => {
  const dashboardView = findJsxElementInTree(appFile, "DashboardView");
  const sessionView = findJsxElementInTree(appFile, "SessionView");
  assert.ok(dashboardView, "App should render DashboardView");
  assert.ok(sessionView, "App should render SessionView");

  assert.equal(
    getJsxAttributeText(getOpeningElement(dashboardView!), "onOpenFeedback"),
    "{onOpenFeedback}",
    "App should pass the shared onOpenFeedback callback into DashboardView",
  );
  assert.equal(
    getJsxAttributeText(getOpeningElement(sessionView!), "onOpenFeedback"),
    "{onOpenFeedback}",
    "App should pass the shared onOpenFeedback callback into SessionView",
  );
});
