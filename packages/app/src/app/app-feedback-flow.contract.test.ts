import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const appSource = readFileSync(new URL("./app.tsx", import.meta.url), "utf8");
const dashboardSource = readFileSync(new URL("./pages/dashboard.tsx", import.meta.url), "utf8");
const sessionSource = readFileSync(new URL("./pages/session.tsx", import.meta.url), "utf8");

test("app shell owns the feedback modal state", () => {
  assert.match(
    appSource,
    /feedback[\s\S]{0,220}createSignal\(false\)/i,
    "app shell should own feedback modal state",
  );

  assert.match(
    appSource,
    /FeedbackModal[\s\S]{0,800}open=\{[\s\S]{0,200}\}/s,
    "app shell should render a feedback modal controlled by app state",
  );

  assert.match(
    appSource,
    /FeedbackModal[\s\S]{0,1200}onClose=\{[\s\S]{0,200}\}/s,
    "app shell should expose a close path for the feedback modal",
  );
});

test("dashboard and session receive the shared feedback trigger", () => {
  assert.match(
    dashboardSource,
    /<TitlebarMenuToggles[\s\S]{0,500}rightContent=\{[\s\S]{0,500}Feedback[\s\S]{0,500}onClick=/s,
    "dashboard should feed an actual feedback trigger into the shared titlebar slot",
  );

  assert.match(
    sessionSource,
    /<TitlebarMenuToggles[\s\S]{0,500}rightContent=\{[\s\S]{0,500}Feedback[\s\S]{0,500}onClick=/s,
    "session should feed an actual feedback trigger into the shared titlebar slot",
  );
});

test("app shell wires both page views to the shared feedback modal trigger", () => {
  assert.match(
    appSource,
    /feedback[\s\S]{0,1200}DashboardView[\s\S]{0,1200}feedback[\s\S]{0,1200}SessionView/s,
    "app shell should thread feedback wiring through both page views",
  );

  assert.match(
    appSource,
    /<FeedbackModal[\s\S]*open=\{[\s\S]{0,200}\}/s,
    "app shell should render a shared feedback modal controlled by app state",
  );
});
