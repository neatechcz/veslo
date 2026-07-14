export type RecordAuditEventInput = {
  actorUserId?: string | null;
  organizationId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  result: "ok" | "warning" | "error";
  summary?: string | null;
};

export type ListAuditEventsInput = {
  limit: number;
  organizationId?: string | null;
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
  organizationId?: string | null;
};

export interface AuditRepository {
  recordEvent(input: RecordAuditEventInput): Promise<void>;
  listEvents?(input: ListAuditEventsInput): Promise<AuditEventRecord[]>;
}
