export const SIGNUP_INVITATION_SESSION_STORAGE_KEY = "veslo:signup-invite-token";
export const SIGNUP_INVITATION_MAX_LENGTH = 4096;
export const GITHUB_AUTH_CALLBACK_MARKER_PARAM = "authCallback";
export const GITHUB_AUTH_CALLBACK_MARKER_VALUE = "github";

type StorageReader = Pick<Storage, "getItem">;
type StorageWriter = Pick<Storage, "removeItem">;

export type ParsedSignupInvitationUrl = {
  inviteToken: string | null;
  scrubbedUrl: string;
  hadInvitationParameter: boolean;
};

export type ParsedGitHubAuthCallback = {
  error: string | null;
  errorDescription: string | null;
  scrubbedUrl: string;
};

function normalizeInvitationToken(value: string | null): string | null {
  const normalized = value?.trim() ?? "";
  if (!normalized || normalized.length > SIGNUP_INVITATION_MAX_LENGTH) {
    return null;
  }
  return normalized;
}

export function parseSignupInvitationUrl(input: string): ParsedSignupInvitationUrl {
  const url = new URL(input);
  const fragmentSource = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
  const fragmentParams = new URLSearchParams(fragmentSource);
  const fragmentHasInvitation = fragmentParams.has("inviteToken");
  const queryHasInvitation = url.searchParams.has("inviteToken");
  const rawInvitation = fragmentHasInvitation
    ? fragmentParams.get("inviteToken")
    : url.searchParams.get("inviteToken");

  if (queryHasInvitation) {
    url.searchParams.delete("inviteToken");
  }
  if (fragmentHasInvitation) {
    fragmentParams.delete("inviteToken");
    const nextFragment = fragmentParams.toString();
    url.hash = nextFragment ? `#${nextFragment}` : "";
  }

  return {
    inviteToken: normalizeInvitationToken(rawInvitation),
    scrubbedUrl: url.toString(),
    hadInvitationParameter: fragmentHasInvitation || queryHasInvitation
  };
}

export function readStoredSignupInvitation(storage: StorageReader): string | null {
  try {
    return normalizeInvitationToken(storage.getItem(SIGNUP_INVITATION_SESSION_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function clearStoredSignupInvitation(storage: StorageWriter): void {
  try {
    storage.removeItem(SIGNUP_INVITATION_SESSION_STORAGE_KEY);
  } catch {
    // Storage access can be denied without making a completed signup fail.
  }
}

export function parseGitHubAuthCallbackUrl(input: string): ParsedGitHubAuthCallback | null {
  const url = new URL(input);
  if (url.searchParams.get(GITHUB_AUTH_CALLBACK_MARKER_PARAM) !== GITHUB_AUTH_CALLBACK_MARKER_VALUE) {
    return null;
  }

  const error = url.searchParams.get("error")?.trim() || null;
  const errorDescription = url.searchParams.get("error_description")?.trim() || null;
  url.searchParams.delete(GITHUB_AUTH_CALLBACK_MARKER_PARAM);
  url.searchParams.delete("error");
  url.searchParams.delete("error_description");

  return {
    error,
    errorDescription,
    scrubbedUrl: url.toString()
  };
}

export const signupInvitationBootstrapScript = `(() => {
  const sessionKey = ${JSON.stringify(SIGNUP_INVITATION_SESSION_STORAGE_KEY)};
  const maxLength = ${SIGNUP_INVITATION_MAX_LENGTH};
  let parsed;
  try {
    const url = new URL(window.location.href);
    const fragmentSource = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    const fragmentParams = new URLSearchParams(fragmentSource);
    const fragmentHasInvitation = fragmentParams.has("inviteToken");
    const queryHasInvitation = url.searchParams.has("inviteToken");
    const rawInvitation = fragmentHasInvitation
      ? fragmentParams.get("inviteToken")
      : url.searchParams.get("inviteToken");
    if (queryHasInvitation) url.searchParams.delete("inviteToken");
    if (fragmentHasInvitation) {
      fragmentParams.delete("inviteToken");
      const nextFragment = fragmentParams.toString();
      url.hash = nextFragment ? "#" + nextFragment : "";
    }
    parsed = {
      token: typeof rawInvitation === "string" ? rawInvitation.trim() : "",
      scrubbedUrl: url.toString(),
      hadInvitationParameter: fragmentHasInvitation || queryHasInvitation
    };
  } catch {
    return;
  }
  if (parsed.token && parsed.token.length <= maxLength) {
    try {
      window.sessionStorage.setItem(sessionKey, parsed.token);
    } catch {
      // Continue to scrub the URL even when storage is unavailable.
    }
  } else if (parsed.hadInvitationParameter) {
    try {
      window.sessionStorage.removeItem(sessionKey);
    } catch {
      // Continue to scrub the URL even when storage is unavailable.
    }
  }
  if (parsed.hadInvitationParameter) {
    try {
      window.history.replaceState({}, "", parsed.scrubbedUrl);
    } catch {
      // A failed history write must not expose the token elsewhere.
    }
  }
})();`;
