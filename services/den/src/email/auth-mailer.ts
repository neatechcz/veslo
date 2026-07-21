import { env } from "../env.js"

type AuthEmailInput = {
  to: string
  subject: string
  html: string
  text: string
}

type AuthEmailSendOptions = {
  timeoutMs?: number
}

const AUTH_EMAIL_TIMEOUT_MS = 30_000
const VESLO_LOGO_URL = "https://veslo.work/assets/veslo-logo-square.svg"

function escapeHtmlAttribute(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

async function sendAuthEmail(input: AuthEmailInput, options: AuthEmailSendOptions = {}) {
  if (!env.email.lettrApiKey) {
    throw new Error("LETTR_API_KEY is required to send auth emails")
  }

  if (!env.email.address) {
    throw new Error("AUTH_EMAIL_ADDRESS is required to send auth emails")
  }

  const timeoutMs = options.timeoutMs ?? AUTH_EMAIL_TIMEOUT_MS
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
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
      throw new Error(`Failed to send auth email: request timed out after ${timeoutMs}ms`)
    }
    throw error
  } finally {
    clearTimeout(timeout)
  }

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

export async function sendVerificationAuthEmail(
  input: { to: string; url: string },
  options: AuthEmailSendOptions = {},
) {
  return sendAuthEmail({
    to: input.to,
    subject: "Verify your Veslo email",
    html: buildVerificationEmailHtml(input.url),
    text: buildVerificationEmailText(input.url),
  }, options)
}

export async function sendResetPasswordAuthEmail(input: { to: string; url: string }) {
  return sendAuthEmail({
    to: input.to,
    subject: "Reset your Veslo password",
    html: `<p>Reset your password: <a href="${input.url}">${input.url}</a></p>`,
    text: `Reset your password: ${input.url}`,
  })
}

export async function sendOrganizationInvitationAuthEmail(input: { to: string; url: string }) {
  return sendAuthEmail({
    to: input.to,
    subject: "You're invited to join Veslo",
    html: buildOrganizationInvitationEmailHtml(input.url),
    text: buildOrganizationInvitationEmailText(input.url),
  })
}

function buildOrganizationInvitationEmailHtml(url: string) {
  const href = escapeHtmlAttribute(url)

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Join Veslo</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f8fb;color:#0a0e14;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f8fb;margin:0;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid rgba(10,14,20,0.10);border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 12px;">
                <img src="${VESLO_LOGO_URL}" width="40" height="40" alt="Veslo" style="display:inline-block;vertical-align:middle;border-radius:6px;">
                <span style="display:inline-block;margin-left:12px;vertical-align:middle;font-size:18px;line-height:24px;font-weight:700;color:#0a0e14;">Veslo</span>
              </td>
            </tr>
            <tr>
              <td style="padding:26px 32px 8px;">
                <p style="margin:0 0 10px;font-size:13px;line-height:20px;letter-spacing:0.02em;text-transform:uppercase;color:#00a8c8;font-weight:800;">Organization invitation</p>
                <h1 style="margin:0;font-size:30px;line-height:36px;font-weight:700;color:#0a0e14;">You've been invited to Veslo.</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 32px 0;">
                <p style="margin:0;font-size:16px;line-height:26px;color:#35404a;">Register your account to join your organization and start working in Veslo.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px 18px;">
                <a href="${href}" style="display:inline-block;background:#00c4e8;color:#0a0e14;text-decoration:none;font-size:16px;line-height:20px;font-weight:800;padding:15px 22px;border-radius:8px;">Join Veslo</a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 28px;">
                <p style="margin:0;font-size:13px;line-height:21px;color:#66707a;">If the button does not work, <a href="${href}" style="color:#007f99;text-decoration:underline;">open the registration link</a>.</p>
                <p style="margin:14px 0 0;font-size:13px;line-height:21px;color:#66707a;">If you were not expecting this invitation, you can ignore this email.</p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px;background:#f8fafc;border-top:1px solid rgba(10,14,20,0.08);">
                <p style="margin:0;font-size:12px;line-height:18px;color:#7a818a;">Veslo - Source-backed work</p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

function buildOrganizationInvitationEmailText(url: string) {
  return `You're invited to join Veslo

Register your account to join your organization and start working in Veslo.

Join Veslo:
${url}

If you were not expecting this invitation, you can ignore this email.`
}

function buildVerificationEmailHtml(url: string) {
  const href = escapeHtmlAttribute(url)

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Verify your Veslo email</title>
  </head>
  <body style="margin:0;padding:0;background:#f4f8fb;color:#0a0e14;font-family:'DM Sans',-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,sans-serif;">
    <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="background:#f4f8fb;margin:0;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="100%" cellspacing="0" cellpadding="0" style="max-width:600px;background:#ffffff;border:1px solid rgba(10,14,20,0.10);border-radius:14px;overflow:hidden;">
            <tr>
              <td style="padding:28px 32px 12px;">
                <table role="presentation" width="100%" cellspacing="0" cellpadding="0">
                  <tr>
                    <td style="vertical-align:middle;">
                      <img src="${VESLO_LOGO_URL}" width="40" height="40" alt="Veslo" style="display:inline-block;vertical-align:middle;border-radius:6px;">
                      <span style="display:inline-block;margin-left:12px;vertical-align:middle;font-size:18px;line-height:24px;font-weight:700;color:#0a0e14;">Veslo</span>
                    </td>
                    <td align="right" style="font-size:12px;line-height:18px;color:#66707a;white-space:nowrap;">
                      Security-first
                    </td>
                  </tr>
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:26px 32px 8px;">
                <p style="margin:0 0 10px;font-size:13px;line-height:20px;letter-spacing:0.02em;text-transform:uppercase;color:#00a8c8;font-weight:800;">
                  Email verification
                </p>
                <h1 style="margin:0;font-size:30px;line-height:36px;font-weight:700;color:#0a0e14;letter-spacing:0;">
                  Verify your email for Veslo.
                </h1>
              </td>
            </tr>
            <tr>
              <td style="padding:12px 32px 0;">
                <p style="margin:0;font-size:16px;line-height:26px;color:#35404a;">
                  Confirm this address so Veslo can finish setting up your account and keep access tied to the right email.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:28px 32px 18px;">
                <a href="${href}" style="display:inline-block;background:#00c4e8;color:#0a0e14;text-decoration:none;font-size:16px;line-height:20px;font-weight:800;padding:15px 22px;border-radius:8px;">
                  Verify email
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 28px;">
                <p style="margin:0;font-size:13px;line-height:21px;color:#66707a;">
                  If the button does not work, <a href="${href}" style="color:#007f99;text-decoration:underline;">open the verification link</a>.
                </p>
                <p style="margin:14px 0 0;font-size:13px;line-height:21px;color:#66707a;">
                  If you did not create a Veslo account, you can ignore this email.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:18px 32px;background:#f8fafc;border-top:1px solid rgba(10,14,20,0.08);">
                <p style="margin:0;font-size:12px;line-height:18px;color:#7a818a;">
                  Veslo - Source-backed work
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`
}

function buildVerificationEmailText(url: string) {
  return `Verify your Veslo email

Confirm this address so Veslo can finish setting up your account and keep access tied to the right email.

Verify email:
${url}

If you did not create a Veslo account, you can ignore this email.`
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
