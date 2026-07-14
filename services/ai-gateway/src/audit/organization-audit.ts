import type { AuditEventRecord } from "./repository.js";

export type OrganizationAuditSource = "den" | "ai-gateway";

export type MergedOrganizationAuditEvent = AuditEventRecord & {
  source: OrganizationAuditSource;
};

const MAX_ORGANIZATION_AUDIT_EVENTS = 100;

export function mergeOrganizationAuditEvents(input: {
  denEvents: AuditEventRecord[];
  gatewayEvents: AuditEventRecord[];
  limit: number;
}): MergedOrganizationAuditEvent[] {
  const limit = Number.isInteger(input.limit)
    ? Math.min(MAX_ORGANIZATION_AUDIT_EVENTS, Math.max(1, input.limit))
    : MAX_ORGANIZATION_AUDIT_EVENTS;
  const label = (
    events: AuditEventRecord[],
    source: OrganizationAuditSource,
  ): MergedOrganizationAuditEvent[] => events.map((event) => ({
    ...event,
    id: `${source}:${event.id}`,
    source,
  }));

  return [
    ...label(input.denEvents, "den"),
    ...label(input.gatewayEvents, "ai-gateway"),
  ]
    .sort((left, right) => {
      const timestampOrder = Date.parse(right.timestamp) - Date.parse(left.timestamp);
      return timestampOrder || left.id.localeCompare(right.id);
    })
    .slice(0, limit);
}
