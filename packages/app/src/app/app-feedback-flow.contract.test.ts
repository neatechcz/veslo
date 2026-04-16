import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./pages/dashboard.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("./pages/session.tsx", import.meta.url), "utf8");

function extractBalancedJsxBlock(source: string, startMarker: string, endMarker: string) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${startMarker}`);

  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(end >= 0, `missing ${endMarker}`);

  return source.slice(start, end + endMarker.length);
}

function getJsxAttributeNames(tagSource: string) {
  return [...tagSource.matchAll(/([A-Za-z_$][\w$-]*)\s*=\s*\{/g)].map((match) => match[1]);
}

function getJsxAttributeValue(tagSource: string, attributeName: string) {
  const startMarker = `${attributeName}={`;
  const start = tagSource.indexOf(startMarker);
  assert.ok(start >= 0, `missing ${attributeName} attribute`);

  let depth = 1;
  let inString: string | null = null;

  for (let i = start + startMarker.length; i < tagSource.length; i += 1) {
    const char = tagSource[i];
    if (inString) {
      if (char === "\\" && i + 1 < tagSource.length) {
        i += 1;
        continue;
      }
      if (char === inString) {
        inString = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      inString = char;
      continue;
    }
    if (char === "{") depth += 1;
    if (char === "}") depth -= 1;
    if (depth === 0) {
      return tagSource.slice(start + startMarker.length, i);
    }
  }

  throw new Error(`unclosed ${attributeName} attribute`);
}

test("app shell owns the feedback modal state", () => {
  const feedbackStateLine = appSource.split("\n").find((line) => /feedback/i.test(line) && /createSignal\(false\)/.test(line));

  assert.ok(
    feedbackStateLine,
    "app shell should declare feedback modal state inside App()",
  );

  const feedbackModalTagIndex = appSource.lastIndexOf("<FeedbackModal");
  assert.ok(feedbackModalTagIndex >= 0, "app shell should render a shared FeedbackModal from App()");
  assert.ok(
    appSource.indexOf(feedbackStateLine as string) < feedbackModalTagIndex,
    "feedback state should be declared before the shared feedback modal render",
  );

  const feedbackModalTag = extractBalancedJsxBlock(appSource.slice(feedbackModalTagIndex), "<FeedbackModal", "/>");
  const feedbackModalAttributes = getJsxAttributeNames(feedbackModalTag);

  assert.ok(
    feedbackModalAttributes.includes("open"),
    "app shell should control the feedback modal open state from App()",
  );
  assert.ok(
    feedbackModalAttributes.includes("onClose"),
    "app shell should control the feedback modal close path from App()",
  );
});

test("dashboard and session receive the shared feedback trigger", () => {
  const dashboardTitlebar = extractBalancedJsxBlock(dashboardSource, "<TitlebarMenuToggles", "/>");
  const sessionTitlebar = extractBalancedJsxBlock(sessionSource, "<TitlebarMenuToggles", "/>");

  const dashboardRightContent = getJsxAttributeValue(dashboardTitlebar, "rightContent");
  const sessionRightContent = getJsxAttributeValue(sessionTitlebar, "rightContent");

  assert.match(
    dashboardRightContent,
    /^<button[\s\S]*onClick=/s,
    "dashboard should pass an actionable button into the shared titlebar slot",
  );
  assert.match(
    sessionRightContent,
    /^<button[\s\S]*onClick=/s,
    "session should pass an actionable button into the shared titlebar slot",
  );

  assert.match(
    dashboardRightContent,
    /Feedback/,
    "dashboard should keep the feedback trigger in the shared titlebar path",
  );
  assert.match(
    sessionRightContent,
    /Feedback/,
    "session should keep the feedback trigger in the shared titlebar path",
  );
});

test("app shell wires both page views to the shared feedback trigger", () => {
  const dashboardTagStart = appSource.lastIndexOf("<DashboardView");
  const sessionTagStart = appSource.lastIndexOf("<SessionView");

  assert.ok(dashboardTagStart >= 0, "app shell should render DashboardView");
  assert.ok(sessionTagStart >= 0, "app shell should render SessionView");

  const dashboardTag = extractBalancedJsxBlock(appSource.slice(dashboardTagStart), "<DashboardView", "/>");
  const sessionTag = extractBalancedJsxBlock(appSource.slice(sessionTagStart), "<SessionView", "/>");

  const dashboardAttributes = getJsxAttributeNames(dashboardTag);
  const sessionAttributes = getJsxAttributeNames(sessionTag);

  assert.ok(
    dashboardAttributes.some((attribute) => /feedback/i.test(attribute)),
    "dashboard should receive a feedback-related prop from the app shell",
  );
  assert.ok(
    sessionAttributes.some((attribute) => /feedback/i.test(attribute)),
    "session should receive a feedback-related prop from the app shell",
  );
});
