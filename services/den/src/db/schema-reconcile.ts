export type ColumnMetadata = {
  dataType: string | null
  maxLength: number | null
}

function toNormalizedDataType(value: string | null) {
  return value?.trim().toLowerCase() ?? null
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
