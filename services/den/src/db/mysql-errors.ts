export function isMySqlDuplicateKeyError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false
  }

  const candidate = error as {
    code?: unknown
    errno?: unknown
    sqlState?: unknown
    message?: unknown
    cause?: unknown
  }
  const message = typeof candidate.message === "string" ? candidate.message.toLowerCase() : ""

  return candidate.code === "ER_DUP_ENTRY" ||
    candidate.errno === 1062 ||
    (candidate.sqlState === "23000" && message.includes("duplicate")) ||
    isMySqlDuplicateKeyError(candidate.cause)
}

export function isMySqlDeadlockError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false
  }

  const candidate = error as {
    code?: unknown
    errno?: unknown
    cause?: unknown
  }

  return candidate.code === "ER_LOCK_DEADLOCK" ||
    candidate.errno === 1213 ||
    isMySqlDeadlockError(candidate.cause)
}
