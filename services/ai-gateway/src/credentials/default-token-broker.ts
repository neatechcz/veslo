import type { CredentialRecord, CredentialRepository } from "./repository.js";
import type { SecretStore, StoredSecret } from "./secret-store.js";
import type { GetUpstreamAuthInput, TokenBroker, UpstreamAuth } from "./token-broker.js";

type OpenAiOAuthSecret = Extract<StoredSecret, { kind: "openai_oauth" }>;

export class OpenAiOAuthRefreshError extends Error {
  constructor(
    readonly kind: "refreshable_auth" | "permanent_credential" | "transient_upstream",
    message: string,
  ) {
    super(message);
    this.name = "OpenAiOAuthRefreshError";
  }
}

export type RefreshOpenAiOAuthInput = {
  bindingId: string;
  credential: CredentialRecord;
  secret: OpenAiOAuthSecret;
};

export type DefaultTokenBrokerDeps = {
  credentials: CredentialRepository;
  secrets: SecretStore;
  refreshOpenAiOAuth?: (input: RefreshOpenAiOAuthInput) => Promise<OpenAiOAuthSecret>;
  now?: () => Date;
};

function isExpired(expiresAt: string, now: Date): boolean {
  const expiresAtMs = Date.parse(expiresAt);
  return !Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime();
}

export class DefaultTokenBroker implements TokenBroker {
  private readonly now: () => Date;
  // Coalesce concurrent refresh attempts for the same credential. Without
  // this, two requests arriving with an expired access token both call the
  // upstream OAuth refresh endpoint with the same refresh token. ChatGPT
  // accepts only the first call and invalidates the refresh token —
  // subsequent calls fail with `invalid_grant: refresh token already used`,
  // which permanently breaks the credential until a human re-signs in.
  private readonly refreshInFlight = new Map<string, Promise<OpenAiOAuthSecret>>();

  constructor(private readonly deps: DefaultTokenBrokerDeps) {
    this.now = deps.now ?? (() => new Date());
  }

  async getUpstreamAuth(input: GetUpstreamAuthInput): Promise<UpstreamAuth> {
    const credential = await this.getCredentialForBinding(input.bindingId);
    const secret = await this.deps.secrets.get(credential.secretRef);

    if (secret.kind === "api_key") {
      return {
        kind: "api-key",
        value: secret.apiKey,
      };
    }

    if (secret.kind === "codex_auth_json") {
      throw new Error("codex_auth_json_not_supported_by_token_broker");
    }

    if (secret.kind !== "openai_oauth") {
      throw new Error(`unsupported_secret_kind:${secret.kind}`);
    }

    if (!isExpired(secret.expiresAt, this.now())) {
      return {
        kind: "oauth",
        value: secret.accessToken,
      };
    }

    const refreshOpenAiOAuth = this.deps.refreshOpenAiOAuth;
    if (!refreshOpenAiOAuth) {
      throw new Error("openai_oauth_refresh_not_configured");
    }

    const refreshKey = credential.secretRef;
    let refreshPromise = this.refreshInFlight.get(refreshKey);
    if (!refreshPromise) {
      refreshPromise = (async () => {
        try {
          const refreshed = await refreshOpenAiOAuth({
            bindingId: input.bindingId,
            credential,
            secret,
          });
          await this.deps.secrets.replace(credential.secretRef, refreshed);
          return refreshed;
        } catch (error) {
          if (
            error instanceof OpenAiOAuthRefreshError &&
            error.kind === "permanent_credential"
          ) {
            await this.deps.credentials.markCredentialState({
              credentialRecordId: credential.id,
              state: "unhealthy",
              reason: error.message,
            });
          }
          throw error;
        }
      })();

      this.refreshInFlight.set(refreshKey, refreshPromise);
      // Always release the in-flight slot once the refresh settles, so the
      // next expiry triggers a fresh refresh instead of replaying a stale
      // promise. We use .then with two handlers (instead of .finally) so the
      // cleanup chain swallows rejections — the awaited copy below
      // propagates the actual error to the caller.
      const releaseSlot = () => {
        if (this.refreshInFlight.get(refreshKey) === refreshPromise) {
          this.refreshInFlight.delete(refreshKey);
        }
      };
      refreshPromise.then(releaseSlot, releaseSlot);
    }

    const refreshed = await refreshPromise;
    return {
      kind: "oauth",
      value: refreshed.accessToken,
    };
  }

  private async getCredentialForBinding(bindingId: string): Promise<CredentialRecord> {
    const lookup = this.deps.credentials.getCredentialRecordByBindingId;
    if (!lookup) {
      throw new Error("binding_lookup_not_supported");
    }

    const credential = await lookup.call(this.deps.credentials, bindingId);
    if (!credential) {
      throw new Error(`credential_not_found:${bindingId}`);
    }

    return credential;
  }
}
