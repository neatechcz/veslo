export type LeaseProvider = "openai" | "anthropic";

export type SessionLease = {
  id: string;
  ownerUserId: string;
  provider: LeaseProvider;
  sessionId: string;
  activeBindingId: string;
};

export type CreateSessionLeaseInput = {
  ownerUserId: string;
  provider: LeaseProvider;
  sessionId: string;
  activeBindingId: string;
};

export type RebindSessionLeaseInput = {
  ownerUserId: string;
  provider: LeaseProvider;
  sessionId: string;
  expectedCurrentBindingId: string;
  nextBindingId: string;
};

export type ResolveLeaseInput = {
  ownerUserId: string;
  provider: LeaseProvider;
  sessionId: string;
};

export interface LeaseRepository {
  getActiveLease(input: ResolveLeaseInput): Promise<SessionLease | null>;
  createLeaseIfMissing(input: CreateSessionLeaseInput): Promise<SessionLease>;
  rebindLease(input: RebindSessionLeaseInput): Promise<SessionLease | null>;
}
