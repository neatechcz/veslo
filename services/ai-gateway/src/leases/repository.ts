export type SessionLease = {
  id: string;
  sessionId: string;
  activeBindingId: string;
};

export type CreateSessionLeaseInput = {
  sessionId: string;
  activeBindingId: string;
};

export type RebindSessionLeaseInput = {
  sessionId: string;
  expectedCurrentBindingId: string;
  nextBindingId: string;
};

export interface LeaseRepository {
  getActiveLeaseBySessionId(sessionId: string): Promise<SessionLease | null>;
  createSessionLeaseIfMissing(input: CreateSessionLeaseInput): Promise<SessionLease>;
  rebindSessionLease(input: RebindSessionLeaseInput): Promise<SessionLease | null>;
}
