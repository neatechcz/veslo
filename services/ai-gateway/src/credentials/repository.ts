import type { CredentialState, CredentialType } from "../db/schema.js";

export type CredentialRecord = {
  id: string;
  provider: string;
  credentialType: CredentialType;
  state: CredentialState;
  secretRef: string;
  createdAt: Date;
  updatedAt: Date;
};

export type MarkCredentialStateInput = {
  credentialRecordId: string;
  state: CredentialState;
  reason?: string | null;
};

export interface CredentialRepository {
  getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null>;
  listHealthyCredentialRecordIds(): Promise<string[]>;
  markCredentialState(input: MarkCredentialStateInput): Promise<void>;
}
