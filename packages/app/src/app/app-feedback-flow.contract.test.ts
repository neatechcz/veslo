import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./pages/dashboard.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("./pages/session.tsx", import.meta.url), "utf8");

test("app shell owns the feedback modal state", () => {
  assert.match(
    appSource,
    /const\s+\[feedbackModalOpen,\s*setFeedbackModalOpen\]\s*=\s*createSignal\(false\);/,
    "app shell should own the feedback modal open state",
  );

  assert.match(
    appSource,
    /const\s+openFeedbackModal\s*=\s*\(\)\s*=>\s*setFeedbackModalOpen\(true\);/,
    "app shell should expose a dedicated open handler for feedback",
  );

  assert.match(
    appSource,
    /const\s+closeFeedbackModal\s*=\s*\(\)\s*=>\s*setFeedbackModalOpen\(false\);/,
    "app shell should expose a dedicated close handler for feedback",
  );
});

test("dashboard and session receive the shared feedback trigger", () => {
  assert.match(
    dashboardSource,
    /<TitlebarMenuToggles[\s\S]*rightContent=\{[\s\S]*Feedback[\s\S]*\}/,
    "dashboard should feed the feedback action into the shared titlebar slot",
  );

  assert.match(
    sessionSource,
    /<TitlebarMenuToggles[\s\S]*rightContent=\{[\s\S]*Feedback[\s\S]*\}/,
    "session should feed the feedback action into the shared titlebar slot",
  );
});

test("app shell wires both page views to the shared feedback modal trigger", () => {
  assert.match(
    appSource,
    /dashboardProps\(\)[\s\S]*openFeedbackModal[\s\S]*sessionProps\(\)[\s\S]*openFeedbackModal/s,
    "app shell should thread the feedback trigger through both page prop builders",
  );

  assert.match(
    appSource,
    /<FeedbackModal[\s\S]*open=\{feedbackModalOpen\(\)\}/,
    "app shell should render a shared feedback modal controlled by the app-level state",
  );
});
