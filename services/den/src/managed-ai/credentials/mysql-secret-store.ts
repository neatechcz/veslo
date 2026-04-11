import { eq } from "drizzle-orm"
import { randomUUID } from "node:crypto"

import { credentialSecretTable } from "../schema.js"
import type { SecretStore, StoredSecret } from "./secret-store.js"
import {
  createSecretEncryptionKey,
  decryptStoredSecret,
  encryptStoredSecret,
  type EncryptedSecretEnvelope,
} from "./secret-crypto.js"

export class MySqlSecretStore implements SecretStore {
  private readonly key: ReturnType<typeof createSecretEncryptionKey>

  constructor(
    private readonly db: any,
    secretKey: string,
  ) {
    this.key = createSecretEncryptionKey(secretKey)
  }

  async put(secret: StoredSecret): Promise<{ secretRef: string }> {
    const secretRef = `secret_${randomUUID()}`
    const encrypted = encryptStoredSecret(this.key, secret)
    const createdAt = new Date()

    await this.db.insert(credentialSecretTable).values({
      secret_ref: secretRef,
      iv: encrypted.iv,
      auth_tag: encrypted.authTag,
      ciphertext: encrypted.ciphertext,
      created_at: createdAt,
      updated_at: createdAt,
    })

    return { secretRef }
  }

  async get(secretRef: string): Promise<StoredSecret> {
    const rows = await this.db
      .select()
      .from(credentialSecretTable)
      .where(eq(credentialSecretTable.secret_ref, secretRef))
      .limit(1)
    const row = rows[0]

    if (!row) {
      throw new Error(`secret_not_found:${secretRef}`)
    }

    return decryptStoredSecret(this.key, {
      iv: row.iv,
      authTag: row.auth_tag,
      ciphertext: row.ciphertext,
    })
  }

  async replace(secretRef: string, secret: StoredSecret): Promise<void> {
    const existing = await this.getEnvelope(secretRef)
    if (!existing) {
      throw new Error(`secret_not_found:${secretRef}`)
    }

    const encrypted = encryptStoredSecret(this.key, secret)
    await this.db
      .update(credentialSecretTable)
      .set({
        iv: encrypted.iv,
        auth_tag: encrypted.authTag,
        ciphertext: encrypted.ciphertext,
        updated_at: new Date(),
      })
      .where(eq(credentialSecretTable.secret_ref, secretRef))
  }

  private async getEnvelope(secretRef: string): Promise<EncryptedSecretEnvelope | null> {
    const rows = await this.db
      .select()
      .from(credentialSecretTable)
      .where(eq(credentialSecretTable.secret_ref, secretRef))
      .limit(1)
    const row = rows[0]

    if (!row) {
      return null
    }

    return {
      iv: row.iv,
      authTag: row.auth_tag,
      ciphertext: row.ciphertext,
    }
  }
}
