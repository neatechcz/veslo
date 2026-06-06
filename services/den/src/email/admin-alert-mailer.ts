import { env } from "../env.js"

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

  const response = await fetch("https://app.lettr.com/api/emails", {
    method: "POST",
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

  if (!response.ok) {
    throw new Error(`Failed to send admin alert email: ${response.status} ${response.statusText}`)
  }
}

export function isAdminAlertEmailConfigured() {
  return Boolean(env.email.lettrApiKey && env.email.address)
}
