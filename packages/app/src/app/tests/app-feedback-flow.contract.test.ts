import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import * as ts from "typescript";

const appSourceText = readFileSync(new URL("../app.tsx", import.meta.url), "utf8");
const dashboardSourceText = readFileSync(new URL("../pages/dashboard.tsx", import.meta.url), "utf8");
const sessionSourceText = readFileSync(new URL("../pages/session.tsx", import.meta.url), "utf8");
const feedbackWorkflowSourceText = readFileSync(new URL("../context/feedback-workflow.ts", import.meta.url), "utf8");

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
const feedbackWorkflowSourceFile = ts.createSourceFile(
  "feedback-workflow.ts",
  feedbackWorkflowSourceText,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
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
    if (ts.isJsxAttribute(prop) && ts.isIdentifier(prop.name) && prop.name.text === attributeName) {
      return prop;
    }
  }
  return undefined;
}

function isNamedBindingElement(element: ts.ArrayBindingElement): element is ts.BindingElement & { name: ts.Identifier } {
  return ts.isBindingElement(element) && ts.isIdentifier(element.name);
}

function getNamedBindingElements(pattern: ts.ArrayBindingPattern): Array<ts.BindingElement & { name: ts.Identifier }> {
  return pattern.elements.filter(isNamedBindingElement);
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

function findJsxElementsInNode(root: ts.Node, tagName: string): Array<ts.JsxElement | ts.JsxSelfClosingElement> {
  return visit(root, (node) => isJsxElementLike(node) && getJsxTagName(node) === tagName) as Array<
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

function findFunctionDeclaration(sourceFile: ts.SourceFile, name: string): ts.FunctionDeclaration | undefined {
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) {
      return statement;
    }
  }
  return undefined;
}

function findLocalVariableDeclaration(body: ts.Block, name: string): ts.VariableDeclaration | undefined {
  for (const statement of body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === name) {
        return declaration;
      }
    }
  }
  return undefined;
}

function findLocalCallable(body: ts.Block, name: string): ts.VariableDeclaration | ts.FunctionDeclaration | undefined {
  for (const statement of body.statements) {
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

function getCallbackDeclarationInScope(
  body: ts.Block,
  expression: ts.Expression,
): ts.VariableDeclaration | ts.FunctionDeclaration | undefined {
  const normalized = unwrapExpression(expression);
  if (!normalized) return undefined;

  if (ts.isIdentifier(normalized)) {
    return findLocalCallable(body, normalized.text);
  }

  if (ts.isArrowFunction(normalized) || ts.isFunctionExpression(normalized)) {
    const fakeVariable = ts.factory.createVariableDeclaration("inline", undefined, undefined, normalized);
    return fakeVariable as unknown as ts.VariableDeclaration;
  }

  if (ts.isCallExpression(normalized)) {
    return getCallbackDeclarationInScope(body, normalized.expression);
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

function getFunctionBlock(node: ts.FunctionDeclaration | ts.VariableDeclaration): ts.Block | undefined {
  const functionLike = ts.isFunctionDeclaration(node)
    ? node
    : node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
      ? node.initializer
      : undefined;
  if (!functionLike || !functionLike.body) return undefined;
  return ts.isBlock(functionLike.body) ? functionLike.body : undefined;
}

function blockContainsCallee(block: ts.Block, calleeName: string): boolean {
  let matched = false;
  visit(block, (child) => {
    if (!ts.isCallExpression(child)) return false;
    const callee = child.expression;
    if (!ts.isIdentifier(callee) || callee.text !== calleeName) return false;
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
    return expressionText(sourceFile, onClickExpression).replace(/\s+/g, "") === "()=>props.onOpenFeedback()";
  });
  assert.equal(
    buttonsWithSharedOpen.length,
    1,
    `${viewName} should have exactly one button that calls props.onOpenFeedback`,
  );

  const rightContentButtons = findButtonNodes(rightContent!);
  assert.equal(rightContentButtons.length, 1, `${viewName} should put exactly one button in shared rightContent`);
  assert.equal(
    buttonsWithSharedOpen[0],
    rightContentButtons[0],
    `${viewName} should render the shared onOpenFeedback button inside rightContent`,
  );
}

test("app shell composes feedback modal state and shared feedback opener", () => {
  const appFunction = findFunctionDeclaration(appSourceFile, "App");
  assert.ok(appFunction?.body, "app.tsx should declare App with a function body");

  const appBody = appFunction!.body!;
  const workflowDeclaration = findLocalVariableDeclaration(appBody, "feedbackWorkflow");
  assert.ok(workflowDeclaration, "App should construct the feedback workflow in local scope");
  assert.match(
    workflowDeclaration!.initializer?.getText(appSourceFile) ?? "",
    /^createFeedbackWorkflow\(\{[\s\S]*runtimeContext: \{/,
    "App should pass runtime context dependencies into the feedback workflow",
  );

  const feedbackModal = findJsxElementsInNode(appBody, "FeedbackModal").find((node) => getJsxAttribute(node, "open"));
  assert.ok(feedbackModal, "app.tsx should render FeedbackModal");

  const expectedModalProps = new Map([
    ["open", "feedbackWorkflow.feedbackModalOpen()"],
    ["error", "feedbackWorkflow.feedbackSubmitError()"],
    ["successIssueId", "feedbackWorkflow.feedbackSubmitSuccessIssueId()"],
    ["submitting", "feedbackWorkflow.feedbackSubmitting()"],
    ["onClose", "feedbackWorkflow.closeFeedbackModal"],
    ["onSubmit", "feedbackWorkflow.submitFeedback"],
  ]);
  for (const [attributeName, expectedExpression] of expectedModalProps) {
    assert.equal(
      getJsxAttributeExpression(feedbackModal!, attributeName)?.getText(appSourceFile),
      expectedExpression,
      `FeedbackModal ${attributeName} should be wired through the feedback workflow`,
    );
  }

  const dashboardView = findJsxElementsInNode(appBody, "DashboardView").find(() => true);
  const sessionView = findJsxElementsInNode(appBody, "SessionView").find(() => true);
  assert.ok(dashboardView, "App should render DashboardView");
  assert.ok(sessionView, "App should render SessionView");

  const dashboardViewCallback = resolveOnOpenFeedbackExpressionFromJsx(appSourceFile, dashboardView!);
  const sessionViewCallback = resolveOnOpenFeedbackExpressionFromJsx(appSourceFile, sessionView!);
  assert.ok(dashboardViewCallback, "DashboardView should receive onOpenFeedback");
  assert.ok(sessionViewCallback, "SessionView should receive onOpenFeedback");
  assert.equal(
    dashboardViewCallback!.getText(appSourceFile),
    "feedbackWorkflow.openFeedbackModal",
    "DashboardView should use the workflow feedback opener",
  );
  assert.equal(
    sessionViewCallback!.getText(appSourceFile),
    "feedbackWorkflow.openFeedbackModal",
    "SessionView should use the workflow feedback opener",
  );

  const workflowFunction = findFunctionDeclaration(feedbackWorkflowSourceFile, "createFeedbackWorkflow");
  assert.ok(workflowFunction?.body, "feedback workflow module should expose createFeedbackWorkflow");
  const workflowBody = workflowFunction!.body!;
  assert.match(
    workflowBody.getText(feedbackWorkflowSourceFile),
    /const \[feedbackModalOpen, setFeedbackModalOpen\] = createSignal\(false\);/,
    "feedback workflow should own modal open state",
  );

  const clearSubmitState = findLocalCallable(workflowBody, "clearFeedbackSubmitState");
  assert.ok(clearSubmitState, "feedback workflow should centralize clearing submit state");
  assert.ok(
    functionBodyContainsCall(clearSubmitState!, "setFeedbackSubmitError", "null"),
    "feedback workflow should clear stale submit errors",
  );
  assert.ok(
    functionBodyContainsCall(clearSubmitState!, "setFeedbackSubmitSuccessIssueId", "null"),
    "feedback workflow should clear stale success state",
  );

  const openFeedbackModal = findLocalCallable(workflowBody, "openFeedbackModal");
  const closeFeedbackModal = findLocalCallable(workflowBody, "closeFeedbackModal");
  assert.ok(openFeedbackModal, "feedback workflow should expose an openFeedbackModal callback");
  assert.ok(closeFeedbackModal, "feedback workflow should expose a closeFeedbackModal callback");
  assert.ok(
    blockContainsCallee(getFunctionBlock(openFeedbackModal!)!, "clearFeedbackSubmitState"),
    "opening the feedback modal should clear stale submit state",
  );
  assert.ok(
    functionBodyContainsCall(openFeedbackModal!, "setFeedbackModalOpen", "true"),
    "opening the feedback modal should open the shared workflow state",
  );
  assert.ok(
    blockContainsCallee(getFunctionBlock(closeFeedbackModal!)!, "clearFeedbackSubmitState"),
    "closing the feedback modal should clear stale submit state",
  );
  assert.ok(
    functionBodyContainsCall(closeFeedbackModal!, "setFeedbackModalOpen", "false"),
    "closing the feedback modal should close the shared workflow state",
  );
});

test("feedback workflow guards feedback submission while persistence is in flight", () => {
  const appFunction = findFunctionDeclaration(appSourceFile, "App");
  assert.ok(appFunction?.body, "app.tsx should declare App with a function body");

  const appBody = appFunction!.body!;
  const feedbackModal = findJsxElementsInNode(appBody, "FeedbackModal").find((node) => getJsxAttribute(node, "open"));
  assert.ok(feedbackModal, "app.tsx should render FeedbackModal");
  assert.equal(
    getJsxAttributeExpression(feedbackModal!, "submitting")?.getText(appSourceFile),
    "feedbackWorkflow.feedbackSubmitting()",
    "FeedbackModal should receive the workflow submitting accessor",
  );

  const workflowFunction = findFunctionDeclaration(feedbackWorkflowSourceFile, "createFeedbackWorkflow");
  assert.ok(workflowFunction?.body, "feedback workflow module should expose createFeedbackWorkflow");
  const persistFeedbackDecl = findLocalCallable(workflowFunction!.body!, "persistFeedback");
  assert.ok(persistFeedbackDecl, "feedback workflow should declare persistFeedback in local scope");

  const persistFeedbackBody = getFunctionBlock(persistFeedbackDecl!);
  assert.ok(persistFeedbackBody, "persistFeedback should have a block body");
  assert.match(
    persistFeedbackBody!.getText(feedbackWorkflowSourceFile),
    /if \(feedbackSubmitting\(\)\) return;/,
    "persistFeedback should ignore concurrent submissions",
  );
  assert.ok(
    functionBodyContainsCall(persistFeedbackDecl!, "setFeedbackSubmitting", "true"),
    "persistFeedback should mark feedback submission as in flight before posting",
  );

  const tryStatements = visit(persistFeedbackBody!, (node) => ts.isTryStatement(node)) as ts.TryStatement[];
  assert.equal(tryStatements.length, 1, "persistFeedback should use a single try/finally block around feedback persistence");

  const [persistTry] = tryStatements;
  assert.equal(persistTry!.catchClause, undefined, "persistFeedback should let persistence failures bubble back to the caller");
  assert.ok(
    blockContainsCallee(persistTry!.tryBlock, "submitReport"),
    "persistFeedback should submit feedback inside the protected try block",
  );
  assert.ok(
    blockContainsCallee(persistTry!.tryBlock, "setFeedbackSubmitSuccessIssueId"),
    "persistFeedback should surface the returned YouTrack task number after successful feedback persistence",
  );
  assert.ok(persistTry!.finallyBlock, "persistFeedback should always clear the in-flight flag in finally");
  assert.match(
    persistTry!.finallyBlock!.getText(feedbackWorkflowSourceFile),
    /setFeedbackSubmitting\(false\);/,
    "persistFeedback should always reset the in-flight flag in finally",
  );
});

test("feedback workflow keeps feedback submit failures scoped to the modal", () => {
  const appFunction = findFunctionDeclaration(appSourceFile, "App");
  assert.ok(appFunction?.body, "app.tsx should declare App with a function body");
  const appBody = appFunction!.body!;

  const feedbackModal = findJsxElementsInNode(appBody, "FeedbackModal").find((node) => getJsxAttribute(node, "open"));
  assert.ok(feedbackModal, "app.tsx should render FeedbackModal");
  assert.equal(
    getJsxAttributeExpression(feedbackModal!, "error")?.getText(appSourceFile),
    "feedbackWorkflow.feedbackSubmitError()",
    "FeedbackModal should receive the workflow feedback error accessor",
  );

  const workflowFunction = findFunctionDeclaration(feedbackWorkflowSourceFile, "createFeedbackWorkflow");
  assert.ok(workflowFunction?.body, "feedback workflow module should expose createFeedbackWorkflow");
  const submitFeedbackDecl = findLocalCallable(workflowFunction!.body!, "submitFeedback");
  assert.ok(submitFeedbackDecl, "feedback workflow should declare submitFeedback in local scope");
  const submitFeedbackBody = getFunctionBlock(submitFeedbackDecl!);
  assert.ok(submitFeedbackBody, "submitFeedback should have a block body");
  const submitFeedbackBodyText = submitFeedbackBody!.getText(feedbackWorkflowSourceFile);
  assert.match(
    submitFeedbackBodyText,
    /deps\.reportError\(error, "feedback\.submit"\);/,
    "submitFeedback should report persistence failures with the feedback scope",
  );
  assert.match(
    submitFeedbackBodyText,
    /setFeedbackSubmitError\(error instanceof Error \? error\.message : deps\.stringifyError\(error\)\);/,
    "submitFeedback should surface persistence failures inside the modal",
  );
});

test("feedback workflow surfaces the YouTrack task number after successful feedback submit", () => {
  assert.match(
    feedbackWorkflowSourceText,
    /const \[feedbackSubmitSuccessIssueId, setFeedbackSubmitSuccessIssueId\] = createSignal<string \| null>\(null\);/,
    "feedback workflow should track the returned YouTrack issue id in feedback-specific state",
  );
  assert.match(
    feedbackWorkflowSourceText,
    /setFeedbackSubmitSuccessIssueId\(null\);/,
    "feedback workflow should clear stale success state",
  );
  assert.match(
    feedbackWorkflowSourceText,
    /const result = await submitReport\(/,
    "feedback persistence should keep the submit result from Den",
  );
  assert.match(
    feedbackWorkflowSourceText,
    /setFeedbackSubmitSuccessIssueId\(result\.youtrackIssueId\);/,
    "successful feedback persistence should store the returned YouTrack issue id",
  );
  assert.match(
    appSourceText,
    /successIssueId=\{feedbackWorkflow\.feedbackSubmitSuccessIssueId\(\)\}/,
    "FeedbackModal should receive the returned YouTrack issue id",
  );
});

test("dashboard view keeps the explicit onOpenFeedback page contract", () => {
  assertPageFeedbackContract(dashboardSourceFile, "DashboardViewProps", "DashboardView");
});

test("session view keeps the explicit onOpenFeedback page contract", () => {
  assertPageFeedbackContract(sessionSourceFile, "SessionViewProps", "SessionView");
});
