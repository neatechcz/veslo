import type { CredentialState, CredentialType } from "../db/schema.js";

export type CredentialRecord = {
  id: string;
  name: string | null;
  ownerUserId: string;
  provider: string;
  credentialType: CredentialType;
  state: CredentialState;
  secretRef: string;
  createdAt: Date;
  updatedAt: Date;
  lastFailureAt?: Date | null;
  deletedAt?: Date | null;
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
  cachedTokens: number;
  totalTokens: number;
  nextRotationAt: string | null;
  linkedAlertIds: string[];
  deletedAt?: string | null;
};

export type ListAdminCredentialsInput = {
  includeDeleted?: boolean;
};

export type ListEligibleBindingsInput = {
  ownerUserId: string;
  provider: string;
  excludeBindingId?: string;
};

export type ListRecentCredentialUsageInput = {
  credentialIds: string[];
  since: Date;
};

export type RecentCredentialUsageRecord = {
  credentialId: string;
  totalTokens: number;
  requestCount: number;
};

export type ActiveCredentialLeaseRecord = {
  credentialId: string;
  activeLeases: number;
};

export type MarkCredentialStateInput = {
  credentialRecordId: string;
  state: CredentialState;
  reason?: string | null;
};

export type CreateUserCredentialInput = {
  ownerUserId: string;
  name?: string | null;
  provider: string;
  credentialType: CredentialType;
  secretRef: string;
};

export type CreatePlatformCredentialInput = {
  ownerUserId: string;
  name: string;
  provider: string;
  credentialType: CredentialType;
  secretRef: string;
};

export type ListUserCredentialsInput = {
  ownerUserId: string;
  provider: string;
};

export type RevokeUserCredentialInput = {
  ownerUserId: string;
  provider: string;
  credentialId: string;
};

export interface CredentialRepository {
  // Legacy API used by the current scaffold. Remove after the provider-scoped
  // binding selector and token broker are wired in.
  getCredentialRecordById(credentialRecordId: string): Promise<CredentialRecord | null>;
  listHealthyCredentialRecordIds(): Promise<string[]>;

  // Provider-scoped BYOK API for the gateway rollout.
  listEligibleBindings?(input: ListEligibleBindingsInput): Promise<CredentialBinding[]>;
  listActiveLeasesByCredential?(credentialIds: string[]): Promise<ActiveCredentialLeaseRecord[]>;
  listRecentCredentialUsage?(input: ListRecentCredentialUsageInput): Promise<RecentCredentialUsageRecord[]>;
  getBindingByCredentialId?(credentialId: string): Promise<CredentialBinding | null>;
  getCredentialRecordByBindingId?(bindingId: string): Promise<CredentialRecord | null>;
  listAdminCredentials?(input?: ListAdminCredentialsInput): Promise<AdminCredentialRecord[]>;
  createUserCredential?(input: CreateUserCredentialInput): Promise<CredentialRecord>;
  createPlatformCredential?(input: CreatePlatformCredentialInput): Promise<CredentialRecord>;
  listUserCredentials?(input: ListUserCredentialsInput): Promise<CredentialRecord[]>;
  revokeUserCredential?(input: RevokeUserCredentialInput): Promise<CredentialRecord | null>;
  markCredentialState(input: MarkCredentialStateInput): Promise<void>;
}
