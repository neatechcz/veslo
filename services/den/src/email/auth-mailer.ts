import { env } from "../env.js"

type AuthEmailInput = {
  to: string
  subject: string
  html: string
  text: string
}

async function sendAuthEmail(input: AuthEmailInput) {
  if (!env.email.resendApiKey) {
    throw new Error("RESEND_API_KEY is required to send auth emails")
  }

  if (!env.email.from) {
    throw new Error("AUTH_EMAIL_FROM is required to send auth emails")
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.email.resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: env.email.from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text,
    }),
  })

  if (!response.ok) {
    throw new Error(`Failed to send auth email: ${response.status} ${response.statusText}`)
  }
}

export function fireAndForgetAuthEmail(promise: Promise<unknown>, label: string) {
  return promise.catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    console.error(`[auth-mailer] failed to send ${label}: ${message}`)
  })
}

export async function sendVerificationAuthEmail(input: { to: string; url: string }) {
  return sendAuthEmail({
    to: input.to,
    subject: "Verify your Veslo email",
    html: `<p>Verify your email: <a href="${input.url}">${input.url}</a></p>`,
    text: `Verify your email: ${input.url}`,
  })
}

export async function sendResetPasswordAuthEmail(input: { to: string; url: string }) {
  return sendAuthEmail({
    to: input.to,
    subject: "Reset your Veslo password",
    html: `<p>Reset your password: <a href="${input.url}">${input.url}</a></p>`,
    text: `Reset your password: ${input.url}`,
  })
}
