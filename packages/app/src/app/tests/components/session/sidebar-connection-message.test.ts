import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sidebarSource = readFileSync(new URL("../../../components/session/sidebar.tsx", import.meta.url), "utf8");

test("sidebar shows workspace connection messages beyond hard error states", () => {
  assert.match(
    sidebarSource,
    /const connectionMessage = \(\) => connectionState\(\)\?\.message\?\.trim\(\) \?\? "";/,
    "sidebar should derive the workspace connection message from connection state",
  );
  assert.match(
    sidebarSource,
    /<Show when=\{connectionMessage\(\)\}>[\s\S]*connectionStatus\(\) === "error"[\s\S]*border-amber-7\/30 bg-amber-1\/40 text-amber-11/s,
    "sidebar should render non-error diagnostic messages, such as workspace API readiness waits",
  );
});
