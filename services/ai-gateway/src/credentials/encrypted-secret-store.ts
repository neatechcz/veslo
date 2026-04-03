import { randomUUID } from "node:crypto";

import type { SecretStore, StoredSecret } from "./secret-store.js";
import { createSecretEncryptionKey, decryptStoredSecret, encryptStoredSecret, type EncryptedSecretEnvelope } from "./secret-crypto.js";

export class EncryptedSecretStore implements SecretStore {
  private readonly key: ReturnType<typeof createSecretEncryptionKey>;
  private readonly encryptedSecrets = new Map<string, EncryptedSecretEnvelope>();

  constructor(
    secretKey: string,
    initialSecrets: Record<string, StoredSecret> = {},
  ) {
    this.key = createSecretEncryptionKey(secretKey);

    for (const [secretRef, secret] of Object.entries(initialSecrets)) {
      this.encryptedSecrets.set(secretRef, this.encrypt(secret));
    }
  }

  async put(secret: StoredSecret): Promise<{ secretRef: string }> {
    const secretRef = `secret_${randomUUID()}`;
    this.encryptedSecrets.set(secretRef, this.encrypt(secret));
    return { secretRef };
  }

  async get(secretRef: string): Promise<StoredSecret> {
    const encrypted = this.encryptedSecrets.get(secretRef);
    if (!encrypted) {
      throw new Error(`secret_not_found:${secretRef}`);
    }

    return this.decrypt(encrypted);
  }

  async replace(secretRef: string, secret: StoredSecret): Promise<void> {
    if (!this.encryptedSecrets.has(secretRef)) {
      throw new Error(`secret_not_found:${secretRef}`);
    }

    this.encryptedSecrets.set(secretRef, this.encrypt(secret));
  }

  private encrypt(secret: StoredSecret): EncryptedSecretEnvelope {
    return encryptStoredSecret(this.key, secret);
  }

  private decrypt(encrypted: EncryptedSecretEnvelope): StoredSecret {
    return decryptStoredSecret(this.key, encrypted);
  }
}
