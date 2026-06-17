export type AlertRecord = {
  id: string;
  title: string;
  severity: "critical" | "high" | "medium";
  source: string;
  reason: string | null;
  status: "active" | "acknowledged" | "resolved";
  credentialId: string | null;
  affectedSessions: number;
  firstSeenAt: string;
  lastSeenAt: string;
  owner: string | null;
  runbook: string;
};

export type AlertSignalSummary = {
  eventId: string;
  credentialId: string | null;
  reason: string | null;
  toState: string;
  occurredAt: string;
  affectedSessions: number;
};

export type AlertActionInput = {
  alertId: string;
  actorUserId?: string | null;
};

export type RecordProviderFailureAlertInput = {
  credentialId: string;
  provider: string;
  sessionId: string;
  reason: string;
  occurredAt?: Date | null;
};

export interface AlertRepository {
  listAlerts(): Promise<AlertRecord[]>;
  recordProviderFailure?(input: RecordProviderFailureAlertInput): Promise<void>;
  acknowledgeAlert?(input: AlertActionInput): Promise<AlertRecord | null>;
  resolveAlert?(input: AlertActionInput): Promise<AlertRecord | null>;
}
