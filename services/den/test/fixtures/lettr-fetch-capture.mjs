const LETTR_EMAIL_URL = "https://app.lettr.com/api/emails"
const captureUrl = new URL(requiredEnv("VESLO_TEST_EMAIL_CAPTURE_URL"))

if (captureUrl.protocol !== "http:" || !["127.0.0.1", "::1"].includes(captureUrl.hostname)) {
  throw new Error("VESLO_TEST_EMAIL_CAPTURE_URL must be a loopback-only HTTP URL")
}

const originalFetch = globalThis.fetch.bind(globalThis)

globalThis.fetch = async (input, init) => {
  const requestUrl = input instanceof Request ? input.url : String(input)
  if (requestUrl !== LETTR_EMAIL_URL) {
    return originalFetch(input, init)
  }

  const body = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined)
  return originalFetch(new URL("/api/emails", captureUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    signal: init?.signal ?? (input instanceof Request ? input.signal : undefined),
  })
}

function requiredEnv(name) {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required by the Lettr capture preload`)
  return value
}
