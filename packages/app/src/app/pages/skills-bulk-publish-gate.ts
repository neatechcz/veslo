import type { VesloServerStatus } from "../lib/veslo-server";

export type SkillsBulkPublishDisabledReasonKey =
  | "skills.bulk_publish_no_selection"
  | "skills.bulk_publish_multiple_selection"
  | "skills.bulk_publish_not_publishable"
  | "skills.bulk_publish_registry_not_configured"
  | "skills.bulk_publish_server_read_only"
  | "skills.bulk_publish_server_unavailable";

export type ResolveSkillsBulkPublishDisabledReasonInput = {
  selectedCount: number;
  selectedPublishable: boolean;
  vesloServerStatus: VesloServerStatus;
  vesloServerCanWriteSkills: boolean;
  vesloServerSkillRegistryAvailable: boolean;
};

export function resolveSkillsBulkPublishDisabledReasonKey(
  input: ResolveSkillsBulkPublishDisabledReasonInput,
): SkillsBulkPublishDisabledReasonKey | null {
  if (input.selectedCount === 0) return "skills.bulk_publish_no_selection";
  if (input.selectedCount > 1) return "skills.bulk_publish_multiple_selection";
  if (!input.selectedPublishable) return "skills.bulk_publish_not_publishable";

  const hasCapabilityEvidence =
    input.vesloServerStatus === "connected" ||
    input.vesloServerCanWriteSkills ||
    input.vesloServerSkillRegistryAvailable;
  if (!hasCapabilityEvidence) {
    return input.vesloServerStatus === "limited"
      ? "skills.bulk_publish_server_read_only"
      : "skills.bulk_publish_server_unavailable";
  }
  if (!input.vesloServerSkillRegistryAvailable) {
    return "skills.bulk_publish_registry_not_configured";
  }
  if (!input.vesloServerCanWriteSkills) {
    return "skills.bulk_publish_server_read_only";
  }
  return null;
}
