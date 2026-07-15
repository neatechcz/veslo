/** Den-owned headers accepted by the desktop diagnostic-dump ingress route. */
export const DESKTOP_DUMP_ORG_HEADERS = [
  "x-veslo-org-id",
  "x-veslo-den-org-id",
  "x-veslo-dump-org-id",
] as const

export const VESLO_DUMP_SOURCE_HEADER = "x-veslo-dump-source"
export const VESLO_DUMP_KIND_HEADER = "x-veslo-dump-kind"
export const VESLO_DUMP_FILENAME_HEADER = "x-veslo-dump-filename"
export const VESLO_DUMP_SHA256_HEADER = "x-veslo-dump-sha256"
export const VESLO_DUMP_UNCOMPRESSED_BYTES_HEADER = "x-veslo-dump-uncompressed-bytes"
export const VESLO_DUMP_WORKSPACE_ID_HEADER = "x-veslo-dump-workspace-id"
