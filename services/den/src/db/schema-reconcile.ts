export type ColumnMetadata = {
  dataType: string | null
  maxLength: number | null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function toNormalizedDataType(value: string | null) {
  return value?.trim().toLowerCase() ?? null
}

export function extractMetadataRows(value: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(value)) {
    const first = value[0]
    if (Array.isArray(first)) {
      return first.filter(isRecord)
    }

    return value.filter(isRecord)
  }

  if (value && typeof value === "object") {
    const maybeRows = (value as { rows?: unknown }).rows
    if (Array.isArray(maybeRows)) {
      return maybeRows.filter(isRecord)
    }
  }

  return []
}

export function shouldWidenVarcharColumn(column: ColumnMetadata, minimumLength: number) {
  const normalizedDataType = toNormalizedDataType(column.dataType)
  if (normalizedDataType !== "varchar") {
    return false
  }

  if (column.maxLength === null) {
    return false
  }

  return column.maxLength < minimumLength
}
