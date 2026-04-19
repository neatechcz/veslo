import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./provider-auth-modal.tsx", import.meta.url), "utf8");
const startOauthStart = source.indexOf("const startOauth = async");
const startOauthEnd = source.indexOf("const handleEntrySelect =", startOauthStart);
const startOauthSource =
  startOauthStart >= 0 && startOauthEnd > startOauthStart
    ? source.slice(startOauthStart, startOauthEnd)
    : "";

test("provider OAuth auto flow starts callback waiting before opening the browser", () => {
  assert.equal(startOauthSource.length > 0, true, "startOauth function must exist");
  assert.match(
    startOauthSource,
    /const autoCompletion = settleAsyncResult\(submitOauth\(entry\.id,\s*started\.methodIndex\)\);[\s\S]*const listenerReady = await waitForProviderOAuthCallbackListener\(started\.authorization\.url,\s*\{\s*fetchImpl:\s*callbackFetchImpl[\s\S]*if \(!listenerReady\) \{\s*throw new Error\("OAuth callback listener did not start."\);\s*\}\s*await openOauthUrl\(started\.authorization\.url\);/,
  );
});

test("provider OAuth auto flow guards early callback rejection before awaiting the completion promise", () => {
  assert.equal(startOauthSource.length > 0, true, "startOauth function must exist");
  assert.match(
    startOauthSource,
    /const autoResult = await autoCompletion;[\s\S]*if \(!autoResult\.ok\) \{\s*throw autoResult\.error instanceof Error \? autoResult\.error : new Error\("Failed to complete OAuth"\);\s*\}/,
  );
});
