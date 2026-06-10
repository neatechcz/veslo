import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebarSource = readFileSync(
  new URL("../../components/sidebar-status-controls.tsx", import.meta.url),
  "utf8",
);
const dashboardSource = readFileSync(
  new URL("../../pages/dashboard.tsx", import.meta.url),
  "utf8",
);
const sessionSource = readFileSync(
  new URL("../../pages/session.tsx", import.meta.url),
  "utf8",
);

test("sidebar user label exposes an account menu trigger", () => {
  assert.match(sidebarSource, /aria-haspopup="menu"/);
  assert.match(sidebarSource, /aria-expanded=\{accountMenuOpen\(\)\}/);
});

test("account menu renders a menu role with a logout menuitem", () => {
  assert.match(sidebarSource, /role="menu"/);
  assert.match(sidebarSource, /role="menuitem"/);
  assert.match(sidebarSource, /<span>\{__vesloT\("ui\.literal\.logout_11l94w", __vesloCurrentLocale\(\)\)\}<\/span>/);
});

test("logout menuitem delegates to props.onLogout", () => {
  assert.match(sidebarSource, /onLogout\?: \(\) => Promise<void> \| void/);
  assert.match(sidebarSource, /void props\.onLogout\(\)/);
});

test("account menu closes on outside click and Escape", () => {
  assert.match(sidebarSource, /key === "Escape"/);
  assert.match(sidebarSource, /closeAccountMenu\(\)/);
});

test("LogOut icon is imported from lucide-solid", () => {
  assert.match(sidebarSource, /import \{[^}]*LogOut[^}]*\} from "lucide-solid"/);
});

test("dashboard and session pages forward onLogout to SidebarStatusControls", () => {
  assert.match(dashboardSource, /onLogout: \(\) => Promise<void> \| void/);
  assert.match(dashboardSource, /onLogout=\{props\.onLogout\}/);
  assert.match(sessionSource, /onLogout: \(\) => Promise<void> \| void/);
  assert.match(sessionSource, /onLogout=\{props\.onLogout\}/);
});
