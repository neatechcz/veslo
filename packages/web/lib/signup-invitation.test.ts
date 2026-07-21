import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  SIGNUP_INVITATION_SESSION_STORAGE_KEY,
  parseGitHubAuthCallbackUrl,
  parseSignupInvitationUrl,
  readStoredSignupInvitation,
  signupInvitationBootstrapScript
} from "./signup-invitation.js";

const currentFile = fileURLToPath(import.meta.url);
const webRoot = path.resolve(path.dirname(currentFile), "..");

test("fragment invitation wins over legacy query and both are scrubbed", () => {
  const result = parseSignupInvitationUrl(
    "https://app.veslo.work/?inviteToken=query-token&plan=trial#inviteToken=%20fragment-token%20&section=team"
  );

  assert.deepEqual(result, {
    inviteToken: "fragment-token",
    scrubbedUrl: "https://app.veslo.work/?plan=trial#section=team",
    hadInvitationParameter: true
  });
});

test("legacy query invitation is captured while unrelated URL state is preserved", () => {
  const result = parseSignupInvitationUrl(
    "https://app.veslo.work/start?inviteToken=legacy-token&desktopOnboarding=1#pricing"
  );

  assert.deepEqual(result, {
    inviteToken: "legacy-token",
    scrubbedUrl: "https://app.veslo.work/start?desktopOnboarding=1#pricing",
    hadInvitationParameter: true
  });
});

test("blank and overlong invitation values are rejected but still scrubbed", () => {
  const blank = parseSignupInvitationUrl("https://app.veslo.work/?inviteToken=%20%20&keep=1");
  assert.equal(blank.inviteToken, null);
  assert.equal(blank.scrubbedUrl, "https://app.veslo.work/?keep=1");

  const overlong = parseSignupInvitationUrl(
    `https://app.veslo.work/#inviteToken=${"x".repeat(4097)}&keep=1`
  );
  assert.equal(overlong.inviteToken, null);
  assert.equal(overlong.scrubbedUrl, "https://app.veslo.work/#keep=1");
});

test("bootstrap executes before React, stores only in session storage, and scrubs history", () => {
  const values = new Map<string, string>();
  let replacedUrl = "";
  const context = {
    URL,
    URLSearchParams,
    window: {
      location: {
        href: "https://app.veslo.work/?keep=query#inviteToken=%20raw-token%20&keep=fragment"
      },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key)
      },
      history: {
        replaceState: (_state: unknown, _title: string, url: string) => {
          replacedUrl = url;
        }
      }
    }
  };

  vm.runInNewContext(signupInvitationBootstrapScript, context);

  assert.equal(values.get(SIGNUP_INVITATION_SESSION_STORAGE_KEY), "raw-token");
  assert.equal(replacedUrl, "https://app.veslo.work/?keep=query#keep=fragment");
  assert.equal("localStorage" in context.window, false);
});

test("invalid incoming invitation clears stale session invitation state", () => {
  const values = new Map([[SIGNUP_INVITATION_SESSION_STORAGE_KEY, "stale-token"]]);
  const context = {
    URL,
    URLSearchParams,
    window: {
      location: { href: "https://app.veslo.work/#inviteToken=%20%20&keep=1" },
      sessionStorage: {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => values.set(key, value),
        removeItem: (key: string) => values.delete(key)
      },
      history: { replaceState: () => undefined }
    }
  };

  vm.runInNewContext(signupInvitationBootstrapScript, context);

  assert.equal(values.has(SIGNUP_INVITATION_SESSION_STORAGE_KEY), false);
});

test("stored invitation reads are bounded and normalized", () => {
  const storage = {
    getItem: () => "  stored-token  "
  };
  assert.equal(readStoredSignupInvitation(storage), "stored-token");
  assert.equal(readStoredSignupInvitation({ getItem: () => "x".repeat(4097) }), null);
  assert.equal(readStoredSignupInvitation({ getItem: () => { throw new Error("blocked"); } }), null);
});

test("marked GitHub callback errors are parsed and scrubbed without touching unrelated parameters", () => {
  const result = parseGitHubAuthCallbackUrl(
    "https://app.veslo.work/?authCallback=github&error=domain_not_allowed&error_description=Company+email+required&desktopOnboarding=1#keep"
  );

  assert.deepEqual(result, {
    error: "domain_not_allowed",
    errorDescription: "Company email required",
    scrubbedUrl: "https://app.veslo.work/?desktopOnboarding=1#keep"
  });
});

test("unmarked callback parameters are ignored", () => {
  assert.equal(
    parseGitHubAuthCallbackUrl(
      "https://app.veslo.work/?error=domain_not_allowed&error_description=Company+email+required&keep=1"
    ),
    null
  );
});

test("invitation bootstrap is the first beforeInteractive head script", () => {
  const layoutSource = readFileSync(path.join(webRoot, "app", "layout.tsx"), "utf8");
  const invitationScriptIndex = layoutSource.indexOf('id="signup-invitation"');
  const posthogScriptIndex = layoutSource.indexOf('id="posthog"');

  assert.notEqual(invitationScriptIndex, -1);
  assert.notEqual(posthogScriptIndex, -1);
  assert.ok(invitationScriptIndex < posthogScriptIndex);
  assert.match(
    layoutSource.slice(invitationScriptIndex, posthogScriptIndex),
    /strategy="beforeInteractive"/
  );
});
