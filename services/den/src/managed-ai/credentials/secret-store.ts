export type StoredSecret =
  | { kind: "api_key"; apiKey: string }
  | { kind: "openai_oauth"; accessToken: string; refreshToken: string; expiresAt: string }
  | { kind: "codex_auth_json"; authJson: string }

export interface SecretStore {
  put(secret: StoredSecret): Promise<{ secretRef: string }>
  get(secretRef: string): Promise<StoredSecret>
  replace(secretRef: string, secret: StoredSecret): Promise<void>
}
