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
  activeBindingId: string;
};

export interface LeaseRepository {
  getActiveLeaseBySessionId(sessionId: string): Promise<SessionLease | null>;
  createSessionLease(input: CreateSessionLeaseInput): Promise<SessionLease>;
  rebindSessionLease(input: RebindSessionLeaseInput): Promise<SessionLease>;
}
