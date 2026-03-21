import type { ErrorRequestHandler, NextFunction, Request, RequestHandler, Response } from "express"

const TRANSIENT_DB_ERROR_CODES = new Set([
  "ECONNRESET",
  "EPIPE",
  "ETIMEDOUT",
  "PROTOCOL_CONNECTION_LOST",
  "PROTOCOL_ENQUEUE_AFTER_FATAL_ERROR",
])

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function getErrorCode(error: unknown): string | null {
  if (!isRecord(error)) {
    return null
  }

  if (typeof error.code === "string") {
    return error.code
  }

  return getErrorCode(error.cause)
}

function getErrorNumber(error: unknown): number | null {
  if (!isRecord(error)) {
    return null
  }

  if (typeof error.errno === "number") {
    return error.errno
  }

  return getErrorNumber(error.cause)
}

function getErrorSqlState(error: unknown): string | null {
  if (!isRecord(error)) {
    return null
  }

  if (typeof error.sqlState === "string") {
    return error.sqlState
  }

  return getErrorSqlState(error.cause)
}

function getErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message
  }

  return String(error)
}

function isDesktopAuthRequest(req: Request): boolean {
  const candidate = (typeof req.originalUrl === "string" && req.originalUrl.length > 0 ? req.originalUrl : req.path) ?? ""
  return candidate.startsWith("/v1/desktop-auth/") || candidate.startsWith("/v2/desktop-auth/")
}

function shouldExposeDesktopAuthDebug(req: Request): boolean {
  if (!isDesktopAuthRequest(req)) {
    return false
  }

  const headerValue = req.header("x-veslo-debug-auth")
  if (typeof headerValue !== "string") {
    return false
  }

  const normalized = headerValue.trim().toLowerCase()
  return normalized === "1" || normalized === "true" || normalized === "debug"
}

function buildDebugErrorPayload(error: unknown) {
  const payload: Record<string, string | number> = {
    message: getErrorMessage(error),
  }

  const code = getErrorCode(error)
  if (code) {
    payload.code = code
  }

  const errno = getErrorNumber(error)
  if (typeof errno === "number") {
    payload.errno = errno
  }

  const sqlState = getErrorSqlState(error)
  if (sqlState) {
    payload.sqlState = sqlState
  }

  return payload
}

export function isTransientDbConnectionError(error: unknown): boolean {
  const code = getErrorCode(error)
  if (!code) {
    return false
  }
  return TRANSIENT_DB_ERROR_CODES.has(code)
}

export function asyncRoute(
  handler: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
): RequestHandler {
  return (req, res, next) => {
    void handler(req, res, next).catch(next)
  }
}

export const errorMiddleware: ErrorRequestHandler = (error, req, res, _next) => {
  if (res.headersSent) {
    return
  }

  if (isTransientDbConnectionError(error)) {
    const message = error instanceof Error ? error.message : "transient database connection failure"
    console.warn(`[http] transient db connection error: ${message}`)
    res.status(503).json({
      error: "service_unavailable",
      message: "Database connection was interrupted. Please retry.",
    })
    return
  }

  const message = error instanceof Error ? error.stack ?? error.message : String(error)
  console.error(`[http] unhandled error: ${message}`)
  if (shouldExposeDesktopAuthDebug(req)) {
    res.status(500).json({
      error: "internal_error",
      debug: buildDebugErrorPayload(error),
    })
    return
  }

  res.status(500).json({ error: "internal_error" })
}
