import type { AiGatewayProvider } from "../providers/ids.js";

export type LeaseProvider = AiGatewayProvider;

export type SessionLease = {
  id: string;
  ownerUserId: string;
  provider: LeaseProvider;
  sessionId: string;
  activeBindingId: string;
};

export type AdminSessionState = "healthy" | "degraded" | "rebound";

export type AdminSessionRecord = {
  id: string;
  sessionId: string;
  provider: LeaseProvider;
  userLabel: string;
  orgLabel: string;
  projectLabel: string;
  workerLabel: string;
  credentialId: string;
  state: AdminSessionState;
  retries: number;
  lastSeenAt: string;
  lastFailoverAt: string | null;
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
  bindingOwnerUserId?: string;
  provider: LeaseProvider;
  sessionId: string;
};

export interface LeaseRepository {
  getActiveLease(input: ResolveLeaseInput): Promise<SessionLease | null>;
  createLeaseIfMissing(input: CreateSessionLeaseInput): Promise<SessionLease>;
  rebindLease(input: RebindSessionLeaseInput): Promise<SessionLease | null>;
  listAdminSessions?(): Promise<AdminSessionRecord[]>;
}
