import { normalizeEmailDomain } from "../org-admin/policy.js"

const PERSONAL_EMAIL_DOMAINS: ReadonlySet<string> = new Set([
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "msn.com",
  "yahoo.com",
  "ymail.com",
  "rocketmail.com",
  "icloud.com",
  "me.com",
  "mac.com",
  "proton.me",
  "protonmail.com",
  "pm.me",
  "aol.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "tuta.com",
  "tutanota.com",
  "fastmail.com",
  "seznam.cz",
  "email.cz",
  "post.cz",
  "centrum.cz",
  "atlas.cz",
  "volny.cz",
])

export function isPersonalEmailAddress(email: string): boolean {
  const normalizedEmail = email.trim()
  if (!/^[^@\s]+@[^@\s]+$/.test(normalizedEmail)) return false

  const domain = normalizeEmailDomain(normalizedEmail)
  return domain !== null && PERSONAL_EMAIL_DOMAINS.has(domain)
}
