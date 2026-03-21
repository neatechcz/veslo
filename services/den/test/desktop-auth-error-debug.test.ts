import assert from "node:assert/strict"
import test from "node:test"
import type { Request, Response } from "express"
import { errorMiddleware } from "../src/http/errors.js"

function createMockResponse() {
  const state = {
    statusCode: 200,
    body: null as unknown,
  }

  const response = {
    headersSent: false,
    status(code: number) {
      state.statusCode = code
      return this
    },
    json(body: unknown) {
      state.body = body
      return this
    },
  } as unknown as Response

  return { response, state }
}

function createMockRequest(pathname: string, debugHeader?: string) {
  return {
    path: pathname,
    header(name: string) {
      if (name.toLowerCase() === "x-veslo-debug-auth") {
        return debugHeader ?? undefined
      }
      return undefined
    },
  } as unknown as Request
}

test("desktop auth failures can expose opt-in debug details", () => {
  const { response, state } = createMockResponse()
  const request = createMockRequest("/v2/desktop-auth/authorize", "1")
  const error = Object.assign(new Error("Column 'session_id' cannot be null"), {
    code: "ER_BAD_NULL_ERROR",
    errno: 1048,
    sqlState: "23000",
  })

  errorMiddleware(error, request, response, () => undefined)

  assert.equal(state.statusCode, 500)
  assert.deepEqual(state.body, {
    error: "internal_error",
    debug: {
      message: "Column 'session_id' cannot be null",
      code: "ER_BAD_NULL_ERROR",
      errno: 1048,
      sqlState: "23000",
    },
  })
})

test("non-desktop routes keep internal errors opaque", () => {
  const { response, state } = createMockResponse()
  const request = createMockRequest("/v1/workers", "1")
  const error = new Error("database exploded")

  errorMiddleware(error, request, response, () => undefined)

  assert.equal(state.statusCode, 500)
  assert.deepEqual(state.body, { error: "internal_error" })
})
