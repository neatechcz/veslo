import type { CredentialState, CredentialType } from "../db/schema.js";

export type CredentialRecord = {
  id: string;
  ownerUserId: string;
  provider: string;
  credentialType: CredentialType;
  state: CredentialState;
  secretRef: string;
  createdAt: Date;
  updatedAt: Date;
};

export type CredentialBinding = {
  id: string;
  ownerUserId: string;
  provider: string;
  credentialRecordId: string;
  createdAt: Date;
  updatedAt: Date;
};

export type AdminCredentialRecord = {
  id: string;
  name: string;
  provider: string;
  type: CredentialType;
  state: CredentialState;
  scope: string;
  activeLeases: number;
  alertCount: number;
  lastRefreshAt: string;
  lastFailureAt: string | null;
  totalTokens: number;
  nextRotationAt: string | null;
  linkedAlertIds: string[];
};

export type ListEligibleBindingsInput = {
  ownerUserId: string;
  provider: string;
  excludeBindingId?: string;
};

export type MarkCredentialStateInput = {
  credentialRecordId: string;
  state: CredentialState;
  reason?: string | null;
};

export interface CredentialRepository {
  // Legacy API used by the current scaffold. Remove after the provider-scoped
  // binding selector and token broker are wired in.
  getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null>;
  listHealthyCredentialRecordIds(): Promise<string[]>;

  // Provider-scoped BYOK API for the gateway rollout.
  listEligibleBindings?(input: ListEligibleBindingsInput): Promise<CredentialBinding[]>;
  getCredentialRecordByBindingId?(bindingId: string): Promise<CredentialRecord | null>;
  listAdminCredentials?(): Promise<AdminCredentialRecord[]>;
  markCredentialState(input: MarkCredentialStateInput): Promise<void>;
}
