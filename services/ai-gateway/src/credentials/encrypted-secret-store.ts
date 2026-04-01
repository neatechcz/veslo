import { createCipheriv, createDecipheriv, createHash, createSecretKey, randomBytes, randomUUID } from "node:crypto";

import type { SecretStore, StoredSecret } from "./secret-store.js";

type EncryptedSecretEnvelope = {
  iv: string;
  authTag: string;
  ciphertext: string;
};

export class EncryptedSecretStore implements SecretStore {
  private readonly key: ReturnType<typeof createSecretKey>;
  private readonly encryptedSecrets = new Map<string, EncryptedSecretEnvelope>();

  constructor(
    secretKey: string,
    initialSecrets: Record<string, StoredSecret> = {},
  ) {
    this.key = createSecretKey(new Uint8Array(createHash("sha256").update(secretKey).digest()));

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
    const iv = new Uint8Array(randomBytes(12));
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const plaintext = JSON.stringify(secret);
    const ciphertext = Buffer.concat([
      new Uint8Array(cipher.update(plaintext, "utf8")),
      new Uint8Array(cipher.final()),
    ]);
    const authTag = new Uint8Array(cipher.getAuthTag());

    return {
      iv: Buffer.from(iv).toString("base64"),
      authTag: Buffer.from(authTag).toString("base64"),
      ciphertext: ciphertext.toString("base64"),
    };
  }

  private decrypt(encrypted: EncryptedSecretEnvelope): StoredSecret {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      this.key,
      new Uint8Array(Buffer.from(encrypted.iv, "base64")),
    );
    decipher.setAuthTag(new Uint8Array(Buffer.from(encrypted.authTag, "base64")));

    const plaintext = Buffer.concat([
      new Uint8Array(decipher.update(new Uint8Array(Buffer.from(encrypted.ciphertext, "base64")))),
      new Uint8Array(decipher.final()),
    ]).toString("utf8");

    return JSON.parse(plaintext) as StoredSecret;
  }
}
