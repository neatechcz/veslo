export type SessionLease = {
  id: string;
  ownerUserId?: string;
  provider?: string;
  sessionId: string;
  activeBindingId: string;
};

export type CreateSessionLeaseInput = {
  ownerUserId?: string;
  provider?: string;
  sessionId: string;
  activeBindingId: string;
};

export type RebindSessionLeaseInput = {
  ownerUserId?: string;
  provider?: string;
  sessionId: string;
  expectedCurrentBindingId: string;
  nextBindingId: string;
};

export type ResolveLeaseInput = {
  ownerUserId: string;
  provider: "openai" | "anthropic";
  sessionId: string;
};

export interface LeaseRepository {
  // Legacy API used by the current scaffold. Remove after the provider-scoped
  // lease broker migration lands.
  getActiveLeaseBySessionId(sessionId: string): Promise<SessionLease | null>;
  createSessionLeaseIfMissing(input: CreateSessionLeaseInput): Promise<SessionLease>;
  rebindSessionLease(input: RebindSessionLeaseInput): Promise<SessionLease | null>;

  // Provider-scoped BYOK API for the gateway rollout.
  getActiveLease?(input: ResolveLeaseInput): Promise<SessionLease | null>;
  createLeaseIfMissing?(input: CreateSessionLeaseInput): Promise<SessionLease>;
  rebindLease?(input: RebindSessionLeaseInput): Promise<SessionLease | null>;
}
