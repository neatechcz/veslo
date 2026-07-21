export type EmailVerificationHandoffFixture = {
  schema: 'veslo-email-verification-handoff-fixture/v1';
  denBaseUrl: string;
  unverified: {
    email: string;
    transactionId: string;
    status: 'pending';
    code: null;
    authorizeStatus: 403;
    authorizeError: 'email_verification_required';
  };
  verified: {
    email: string;
    userId: string;
    transactionId: string;
    state: string;
    codeVerifier: string;
    deepLink: string;
  };
};

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

export function parseEmailVerificationHandoffFixture(input: unknown): EmailVerificationHandoffFixture {
  const root = record(input, 'email verification handoff fixture');
  if (root.schema !== 'veslo-email-verification-handoff-fixture/v1') {
    throw new Error('Unsupported email verification handoff fixture schema.');
  }

  const denBaseUrl = text(root.denBaseUrl, 'denBaseUrl').replace(/\/+$/, '');
  const parsedDenBase = new URL(denBaseUrl);
  if (parsedDenBase.protocol !== 'http:' || parsedDenBase.hostname !== '127.0.0.1') {
    throw new Error('Email verification handoff fixture denBaseUrl must use loopback HTTP on 127.0.0.1.');
  }

  const unverified = record(root.unverified, 'unverified');
  if (unverified.status !== 'pending' || unverified.code !== null) {
    throw new Error('The unverified transaction must remain pending without a code.');
  }
  if (
    unverified.authorizeStatus !== 403 ||
    unverified.authorizeError !== 'email_verification_required'
  ) {
    throw new Error('The unverified legacy session must be rejected by the authorization boundary.');
  }

  const verified = record(root.verified, 'verified');
  const transactionId = text(verified.transactionId, 'verified.transactionId');
  const state = text(verified.state, 'verified.state');
  const deepLink = text(verified.deepLink, 'verified.deepLink');
  const parsedDeepLink = new URL(deepLink);
  if (
    parsedDeepLink.protocol !== 'veslo:' ||
    parsedDeepLink.hostname !== 'auth-complete' ||
    !parsedDeepLink.searchParams.get('code')?.trim() ||
    parsedDeepLink.searchParams.get('transactionId') !== transactionId ||
    parsedDeepLink.searchParams.get('state') !== state
  ) {
    throw new Error('Verified deep link does not match its authorized transaction proof.');
  }

  return {
    schema: 'veslo-email-verification-handoff-fixture/v1',
    denBaseUrl,
    unverified: {
      email: text(unverified.email, 'unverified.email'),
      transactionId: text(unverified.transactionId, 'unverified.transactionId'),
      status: 'pending',
      code: null,
      authorizeStatus: 403,
      authorizeError: 'email_verification_required',
    },
    verified: {
      email: text(verified.email, 'verified.email'),
      userId: text(verified.userId, 'verified.userId'),
      transactionId,
      state,
      codeVerifier: text(verified.codeVerifier, 'verified.codeVerifier'),
      deepLink,
    },
  };
}

export function pendingDesktopAuthStorageValue(fixture: EmailVerificationHandoffFixture) {
  return {
    sessionId: fixture.verified.transactionId,
    state: fixture.verified.state,
    codeVerifier: fixture.verified.codeVerifier,
    expiresAt: Date.UTC(2100, 0, 1),
  };
}

export function buildEmailVerificationHandoffRuntimeCleanupScript(): string {
  return `(async () => {
  const invoke = window.__TAURI_INTERNALS__ && window.__TAURI_INTERNALS__.invoke;
  if (typeof invoke !== "function") {
    throw new Error("Tauri invoke is unavailable for email verification runtime cleanup.");
  }
  const before = await invoke("veslo_server_info").catch(() => null);
  await invoke("engine_stop");
  const after = await invoke("veslo_server_info").catch(() => null);
  if (after && after.running === true) {
    throw new Error("Desktop-managed Veslo server did not stop after engine_stop.");
  }
  return {
    serverWasRunning: Boolean(before && before.running === true),
    serverStopped: !after || after.running !== true,
  };
})()`;
}

export function buildEmailVerificationHandoffSignedOutUiProbeScript(): string {
  return `(async () => {
  const authKey = "veslo.den.auth";
  const browserAuth = window.localStorage.getItem(authKey) || window.sessionStorage.getItem(authKey);
  const nativeSnapshot = await window.__TAURI_INTERNALS__.invoke("den_auth_snapshot_read");
  const nativeAuthJson = nativeSnapshot && typeof nativeSnapshot.authJson === "string"
    ? nativeSnapshot.authJson.trim()
    : "";
  const pendingProof = window.localStorage.getItem("veslo.den.desktopAuthPending");
  const loginButton = Array.from(document.querySelectorAll("button")).find((button) => {
    const label = (button.textContent || "").trim();
    const rect = button.getBoundingClientRect();
    const style = window.getComputedStyle(button);
    return (label === "Sign in with Browser" || label === "Přihlásit se v prohlížeči") &&
      rect.width > 0 && rect.height > 0 && style.display !== "none" && style.visibility !== "hidden";
  });
  if (browserAuth || nativeAuthJson || !pendingProof || !loginButton) {
    throw new Error("Signed-out browser-login boundary is not ready for native handoff.");
  }
  return { ready: true };
})()`;
}

export function buildEmailVerificationHandoffWebViewSetupScript(
  fixture: EmailVerificationHandoffFixture,
): string {
  const pending = pendingDesktopAuthStorageValue(fixture);
  const expected = {
    email: fixture.verified.email,
    userId: fixture.verified.userId,
    denBaseUrl: fixture.denBaseUrl,
    unverified: fixture.unverified,
  };
  return `(async () => {
  const authKey = "veslo.den.auth";
  window.localStorage.removeItem(authKey);
  window.sessionStorage.removeItem(authKey);
  const nativeSnapshot = await window.__TAURI_INTERNALS__.invoke("den_auth_snapshot_read");
  const nativeAuthJson = nativeSnapshot && typeof nativeSnapshot.authJson === "string"
    ? nativeSnapshot.authJson.trim()
    : "";
  if (window.localStorage.getItem(authKey) || window.sessionStorage.getItem(authKey) || nativeAuthJson) {
    throw new Error("Isolated desktop profile was authenticated before the email verification handoff.");
  }
  window.localStorage.setItem("veslo.den.apiBaseOverride", ${JSON.stringify(fixture.denBaseUrl)});
  window.localStorage.setItem("veslo.den.desktopAuthPending", ${JSON.stringify(JSON.stringify(pending))});
  window.__vesloEmailVerificationHandoffExpected = ${JSON.stringify(expected)};
  return {
    signedOutBeforeHandoff: true,
    unverifiedStatus: ${JSON.stringify(fixture.unverified.status)},
    unverifiedCode: null,
    unverifiedAuthorizeStatus: ${fixture.unverified.authorizeStatus},
  };
})()`;
}
