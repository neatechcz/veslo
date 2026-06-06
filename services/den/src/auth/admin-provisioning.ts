import { randomBytes, timingSafeEqual } from "node:crypto"

export const ADMIN_PROVISIONING_SIGNUP_HEADER = "x-veslo-admin-provisioning-token"

const adminProvisioningSignupToken = randomBytes(32).toString("base64url")
const textEncoder = new TextEncoder()

export function createAdminProvisioningSignupHeaders() {
  return {
    [ADMIN_PROVISIONING_SIGNUP_HEADER]: adminProvisioningSignupToken,
  }
}

export function isAdminProvisioningSignupRequest(input: unknown) {
  const headerValue = readHeader(input, ADMIN_PROVISIONING_SIGNUP_HEADER)
  if (!headerValue) {
    return false
  }

  const expected = textEncoder.encode(adminProvisioningSignupToken)
  const actual = textEncoder.encode(headerValue)
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function readHeader(input: unknown, name: string) {
  if (!isRecord(input)) {
    return null
  }

  const expressHeader = input.header
  if (typeof expressHeader === "function") {
    const value = normalizeHeaderValue(expressHeader.call(input, name))
    if (value) {
      return value
    }
  }

  const getHeader = input.getHeader
  if (typeof getHeader === "function") {
    const value = normalizeHeaderValue(getHeader.call(input, name))
    if (value) {
      return value
    }
  }

  if (isRecord(input.headers)) {
    return readHeaderRecord(input.headers, name)
  }

  return null
}

function readHeaderRecord(headers: Record<string, unknown>, name: string) {
  const direct = normalizeHeaderValue(headers[name])
  if (direct) {
    return direct
  }

  const lowerName = name.toLowerCase()
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerName) {
      return normalizeHeaderValue(value)
    }
  }

  return null
}

function normalizeHeaderValue(value: unknown) {
  if (typeof value === "string") {
    return value.trim() || null
  }
  if (Array.isArray(value)) {
    return normalizeHeaderValue(value[0])
  }
  return null
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value)
}
