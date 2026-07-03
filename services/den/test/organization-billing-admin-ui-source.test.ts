import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("admin billing UI calls real billing API endpoints instead of static placeholders", () => {
  const app = readFileSync(new URL("../public-admin/app.js", import.meta.url), "utf8")
  const html = readFileSync(new URL("../public-admin/index.html", import.meta.url), "utf8")

  assert.match(app, /loadBillingForVisibleOrganizations/)
  assert.match(app, /\/organizations\/\$\{encodeURIComponent\(orgId\)\}\/billing/)
  assert.match(app, /\/organizations\/\$\{encodeURIComponent\(orgId\)\}\/billing\/checkout/)
  assert.match(app, /\/organizations\/\$\{encodeURIComponent\(orgId\)\}\/billing\/portal/)
  assert.match(app, /window\.location\.assign\(checkout\.url\)/)
  assert.match(app, /window\.location\.assign\(portal\.url\)/)
  assert.doesNotMatch(app, /No Stripe event";/)

  for (const id of [
    "billing-basic-quantity",
    "billing-extended-quantity",
    "billing-update-button",
    "billing-portal-button",
    "billing-action-status",
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `missing ${id}`)
  }
})
