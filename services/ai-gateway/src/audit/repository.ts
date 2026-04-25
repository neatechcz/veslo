export type RecordAuditEventInput = {
  actorUserId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  result: "ok" | "warning" | "error";
  summary?: string | null;
};

export type ListAuditEventsInput = {
  limit: number;
};

export type AuditEventRecord = {
  id: string;
  timestamp: string;
  actor: string;
  action: string;
  entityType: string;
  entityId: string;
  result: "ok" | "warning" | "error";
  summary: string;
  changedFields: string[];
};

export interface AuditRepository {
  recordEvent(input: RecordAuditEventInput): Promise<void>;
  listEvents?(input: ListAuditEventsInput): Promise<AuditEventRecord[]>;
}
