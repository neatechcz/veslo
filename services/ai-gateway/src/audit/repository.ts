export type RecordAuditEventInput = {
  actorUserId?: string | null;
  entityType: string;
  entityId: string;
  action: string;
  result: "ok" | "warning" | "error";
  summary?: string | null;
};

export interface AuditRepository {
  recordEvent(input: RecordAuditEventInput): Promise<void>;
}
