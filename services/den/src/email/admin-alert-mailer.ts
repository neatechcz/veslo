import { env } from "../env.js"

const ADMIN_ALERT_EMAIL_TIMEOUT_MS = 30_000

export type AdminAlertEmailInput = {
  to: string
  subject: string
  html: string
  text: string
}

export async function sendAdminAlertEmail(input: AdminAlertEmailInput) {
  if (!env.email.lettrApiKey) {
    throw new Error("LETTR_API_KEY is required to send admin alert emails")
  }

  if (!env.email.address) {
    throw new Error("AUTH_EMAIL_ADDRESS is required to send admin alert emails")
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), ADMIN_ALERT_EMAIL_TIMEOUT_MS)
  unrefTimer(timeout)

  let response: Response
  try {
    response = await fetch("https://app.lettr.com/api/emails", {
      method: "POST",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.email.lettrApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: env.email.address,
        from_name: env.email.fromName,
        to: [input.to],
        subject: input.subject,
        html: input.html,
        text: input.text,
      }),
    })
  } catch (error) {
    if (isAbortError(error)) {
      throw new Error(`Failed to send admin alert email: request timed out after ${ADMIN_ALERT_EMAIL_TIMEOUT_MS}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

  if (!response.ok) {
    throw new Error(`Failed to send admin alert email: ${response.status} ${response.statusText}`)
  }
}

export function isAdminAlertEmailConfigured() {
  return Boolean(env.email.lettrApiKey && env.email.address)
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}

function unrefTimer(handle: unknown) {
  if (!handle || typeof handle !== "object") {
    return
  }
  const unref = (handle as { unref?: unknown }).unref
  if (typeof unref === "function") {
    unref.call(handle)
  }
}
