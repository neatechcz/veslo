import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const sessionSource = readFileSync(new URL("./session.tsx", import.meta.url), "utf8");

test("session wires Escape stop as a two-step confirmation", () => {
  assert.match(
    sessionSource,
    /import \{ resolveEscapeStopShortcut \} from "\.\/session-shortcuts";/,
    "session should use the two-step Escape stop shortcut resolver",
  );

  assert.match(
    sessionSource,
    /const \[escapeStopConfirmationPending, setEscapeStopConfirmationPending\] = createSignal\(false\);/,
    "session should keep Escape stop confirmation as scoped UI state",
  );

  assert.match(
    sessionSource,
    /const escapeStopAction = resolveEscapeStopShortcut\(\{[\s\S]*confirmationPending: escapeStopConfirmationPending\(\),[\s\S]*\}\);[\s\S]*if \(escapeStopAction !== "ignore"\) \{[\s\S]*if \(escapeStopAction === "request-confirmation"\) \{[\s\S]*setEscapeStopConfirmationPending\(true\);[\s\S]*return;[\s\S]*\}[\s\S]*setEscapeStopConfirmationPending\(false\);[\s\S]*void cancelRun\(\);[\s\S]*\}/,
    "first eligible Escape should request confirmation and the next eligible Escape should stop the run",
  );

  assert.match(
    sessionSource,
    /if \(overlayOpenSide\(\)\) return;[\s\S]*const escapeStopAction = resolveEscapeStopShortcut/,
    "Escape used for the sidebar overlay should not arm or confirm the stop shortcut",
  );

  assert.match(
    sessionSource,
    /stopShortcutConfirmPending=\{escapeStopConfirmationPending\(\)\}/,
    "session should pass the confirmation state to the composer stop button",
  );
});
