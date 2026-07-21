import assert from "node:assert/strict"
import test from "node:test"
import { isPersonalEmailAddress } from "../src/auth/personal-email-domain.js"

const GLOBAL_PERSONAL_EMAIL_DOMAINS = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "proton.me",
  "protonmail.com",
]

const CZECH_PERSONAL_EMAIL_DOMAINS = [
  "seznam.cz",
  "email.cz",
  "post.cz",
  "centrum.cz",
  "atlas.cz",
  "volny.cz",
]

const ADDITIONAL_PERSONAL_EMAIL_DOMAINS = [
  "msn.com",
  "ymail.com",
  "rocketmail.com",
  "me.com",
  "mac.com",
  "pm.me",
  "aol.com",
  "gmx.com",
  "gmx.net",
  "mail.com",
  "tuta.com",
  "tutanota.com",
  "fastmail.com",
]

test("classifies common global personal email providers", () => {
  for (const domain of GLOBAL_PERSONAL_EMAIL_DOMAINS) {
    assert.equal(isPersonalEmailAddress(`user@${domain}`), true, domain)
  }
})

test("classifies common Czech personal email providers", () => {
  for (const domain of CZECH_PERSONAL_EMAIL_DOMAINS) {
    assert.equal(isPersonalEmailAddress(`user@${domain}`), true, domain)
  }
})

test("classifies the complete centralized personal email policy", () => {
  for (const domain of ADDITIONAL_PERSONAL_EMAIL_DOMAINS) {
    assert.equal(isPersonalEmailAddress(`user@${domain}`), true, domain)
  }
})

test("normalizes surrounding whitespace and domain casing", () => {
  assert.equal(isPersonalEmailAddress("  User@GmAiL.CoM  "), true)
})

test("uses exact domain matching", () => {
  assert.equal(isPersonalEmailAddress("user@acme.example"), false)
  assert.equal(isPersonalEmailAddress("user@gmail.com.example"), false)
  assert.equal(isPersonalEmailAddress("user@team.gmail.com"), false)
})

test("does not classify malformed email values", () => {
  for (const email of ["", "not-an-email", "@gmail.com", "user@", "user@@gmail.com"]) {
    assert.equal(isPersonalEmailAddress(email), false, email)
  }
})
