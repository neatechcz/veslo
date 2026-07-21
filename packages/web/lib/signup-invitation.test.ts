import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

import {
  GITHUB_AUTH_PENDING_STORAGE_KEY,
  GITHUB_AUTH_PENDING_TTL_MS,
  SIGNUP_INVITATION_SESSION_STORAGE_KEY,
  clearPendingGitHubAuth,
  clearStoredSignupInvitationFromBrowser,
  consumePendingGitHubAuth,
  createGitHubAuthAttemptId,
  deriveAuthInitialization,
  parseGitHubAuthCallbackUrl,
  parseSignupInvitationUrl,
  replaceBrowserHistoryUrl,
  readStoredSignupInvitation,
  readStoredSignupInvitationFromBrowser,
  storePendingGitHubAuth,
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
    "https://app.veslo.work/?authCallback=github-error&authAttempt=attempt-error&error=domain_not_allowed&error_description=Company+email+required&desktopOnboarding=1#keep"
  );

  assert.deepEqual(result, {
    outcome: "error",
    attemptId: "attempt-error",
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

test("callback outcomes distinguish existing-user success from confirmed new-user success", () => {
  const existingUser = deriveAuthInitialization(
    "https://app.veslo.work/?authCallback=github-success&authAttempt=attempt-valid",
    { mode: "sign-up", createdAt: 1_000, attemptId: "attempt-valid" }
  );
  assert.equal(existingUser.authMode, "sign-in");
  assert.equal(existingUser.githubSignupConfirmed, false);
  assert.equal(existingUser.githubCallback?.outcome, "success");

  const newUser = deriveAuthInitialization(
    "https://app.veslo.work/?authCallback=github-new-user&authAttempt=attempt-valid",
    { mode: "sign-up", createdAt: 1_000, attemptId: "attempt-valid" }
  );
  assert.equal(newUser.authMode, "sign-up");
  assert.equal(newUser.githubSignupConfirmed, true);
  assert.equal(newUser.githubCallback?.outcome, "new-user");
});

test("GitHub signup callback mode wins over desktop onboarding while ordinary desktop entry signs in", () => {
  const signupError = deriveAuthInitialization(
    "https://app.veslo.work/?desktopOnboarding=1&tid=dat_123&authCallback=github-error&authAttempt=attempt-valid&error=domain_not_allowed",
    { mode: "sign-up", createdAt: 1_000, attemptId: "attempt-valid" }
  );
  assert.equal(signupError.desktopOnboarding, true);
  assert.equal(signupError.desktopTransactionId, "dat_123");
  assert.equal(signupError.authMode, "sign-up");

  const ordinaryDesktop = deriveAuthInitialization(
    "https://app.veslo.work/?desktopOnboarding=1&tid=dat_123",
    null
  );
  assert.equal(ordinaryDesktop.desktopOnboarding, true);
  assert.equal(ordinaryDesktop.authMode, "sign-in");
  assert.equal(ordinaryDesktop.githubCallback, null);
});

test("pending GitHub auth context is single-use and expires after ten minutes", () => {
  const values = new Map<string, string>();
  const browser = {
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }
  };

  storePendingGitHubAuth(browser, "sign-up", "attempt-valid", 1_000);
  assert.deepEqual(consumePendingGitHubAuth(browser, "attempt-valid", 1_000 + GITHUB_AUTH_PENDING_TTL_MS), {
    mode: "sign-up",
    createdAt: 1_000,
    attemptId: "attempt-valid"
  });
  assert.equal(values.has(GITHUB_AUTH_PENDING_STORAGE_KEY), false);

  storePendingGitHubAuth(browser, "sign-up", "attempt-expired", 2_000);
  const expiredPending = consumePendingGitHubAuth(
    browser,
    "attempt-expired",
    2_001 + GITHUB_AUTH_PENDING_TTL_MS
  );
  assert.equal(expiredPending, null);
  assert.equal(
    deriveAuthInitialization(
      "https://app.veslo.work/?authCallback=github-new-user&authAttempt=attempt-expired",
      expiredPending
    ).githubSignupConfirmed,
    false
  );
  assert.equal(values.has(GITHUB_AUTH_PENDING_STORAGE_KEY), false);

  values.set(GITHUB_AUTH_PENDING_STORAGE_KEY, "1");
  assert.equal(consumePendingGitHubAuth(browser, "attempt-invalid", 3_000), null);
  assert.equal(values.has(GITHUB_AUTH_PENDING_STORAGE_KEY), false);
});

test("spoofed or missing new-user callback is never confirmed", () => {
  for (const url of [
    "https://app.veslo.work/?authCallback=github-new-user",
    "https://app.veslo.work/?authCallback=github-new-user&authAttempt=spoofed-attempt"
  ]) {
    const initialization = deriveAuthInitialization(url, null);
    assert.equal(initialization.githubSignupConfirmed, false);
    assert.equal(initialization.githubCallbackCorrelated, false);
    assert.equal(initialization.authMode, "sign-in");
  }
});

test("mismatched and already-consumed new-user callbacks cannot reuse pending signup context", () => {
  const values = new Map<string, string>();
  const browser = {
    sessionStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key)
    }
  };

  storePendingGitHubAuth(browser, "sign-up", "attempt-original", 1_000);
  const mismatchedPending = consumePendingGitHubAuth(browser, "attempt-spoofed", 1_001);
  assert.equal(mismatchedPending, null);
  assert.equal(
    deriveAuthInitialization(
      "https://app.veslo.work/?authCallback=github-new-user&authAttempt=attempt-spoofed",
      mismatchedPending
    ).githubSignupConfirmed,
    false
  );
  assert.equal(consumePendingGitHubAuth(browser, "attempt-original", 1_002), null);

  storePendingGitHubAuth(browser, "sign-up", "attempt-once", 2_000);
  const consumed = consumePendingGitHubAuth(browser, "attempt-once", 2_001);
  assert.equal(consumed?.attemptId, "attempt-once");
  assert.equal(consumePendingGitHubAuth(browser, "attempt-once", 2_002), null);

  const firstInitialization = deriveAuthInitialization(
    "https://app.veslo.work/?authCallback=github-new-user&authAttempt=attempt-once",
    consumed
  );
  const replayedInitialization = deriveAuthInitialization(
    "https://app.veslo.work/?authCallback=github-new-user&authAttempt=attempt-once",
    null
  );
  assert.equal(firstInitialization.githubSignupConfirmed, true);
  assert.equal(replayedInitialization.githubSignupConfirmed, false);
});

test("GitHub auth attempt IDs come from browser cryptography", () => {
  assert.equal(
    createGitHubAuthAttemptId({ crypto: { randomUUID: () => "attempt-random-uuid" } }),
    "attempt-random-uuid"
  );

  const deniedCrypto = {} as { crypto: Crypto };
  Object.defineProperty(deniedCrypto, "crypto", {
    get() {
      throw new Error("crypto denied");
    }
  });
  assert.equal(createGitHubAuthAttemptId(deniedCrypto), null);
});

test("pending and history helpers tolerate denied browser APIs", () => {
  const deniedBrowser = {} as { sessionStorage: Storage; history: History };
  Object.defineProperties(deniedBrowser, {
    sessionStorage: {
      get() {
        throw new Error("storage denied");
      }
    },
    history: {
      get() {
        throw new Error("history denied");
      }
    }
  });

  assert.doesNotThrow(() => storePendingGitHubAuth(deniedBrowser, "sign-up", "attempt", 1_000));
  assert.equal(consumePendingGitHubAuth(deniedBrowser, "attempt", 1_000), null);
  assert.equal(clearPendingGitHubAuth(deniedBrowser), false);
  assert.equal(readStoredSignupInvitationFromBrowser(deniedBrowser), null);
  assert.doesNotThrow(() => clearStoredSignupInvitationFromBrowser(deniedBrowser));
  assert.doesNotThrow(() => replaceBrowserHistoryUrl(deniedBrowser, "https://app.veslo.work/"));
});

test("pending GitHub auth fails closed when single-use removal is denied", () => {
  const rawPending = JSON.stringify({
    mode: "sign-up",
    createdAt: 1_000,
    attemptId: "attempt-remove-denied"
  });
  const browser = {
    sessionStorage: {
      getItem: () => rawPending,
      setItem: () => undefined,
      removeItem: () => {
        throw new Error("remove denied");
      }
    }
  };

  const first = consumePendingGitHubAuth(browser, "attempt-remove-denied", 1_001);
  const replay = consumePendingGitHubAuth(browser, "attempt-remove-denied", 1_002);

  assert.equal(first, null);
  assert.equal(replay, null);
  assert.equal(clearPendingGitHubAuth(browser), false);
  assert.equal(
    deriveAuthInitialization(
      "https://app.veslo.work/?authCallback=github-new-user&authAttempt=attempt-remove-denied",
      first
    ).githubSignupConfirmed,
    false
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
