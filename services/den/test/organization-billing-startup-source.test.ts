import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

test("DEN startup mounts Stripe organization billing webhook before JSON parser", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")

  assert.match(source, /createOrganizationBillingWebhookRouter/)
  assert.match(source, /createDrizzleOrganizationBillingStore/)
  assert.match(source, /createDefaultRuntimeState\(\{ organizationBilling: organizationBillingRepository \}\)/)

  const webhookIndex = source.indexOf("createOrganizationBillingWebhookRouter")
  const jsonParserIndex = source.indexOf("app.use(express.json())")
  assert.ok(webhookIndex > -1, "webhook router must be mounted")
  assert.ok(jsonParserIndex > -1, "global JSON parser must be mounted")
  assert.ok(webhookIndex < jsonParserIndex, "Stripe webhook must receive raw body before JSON parser")
})

test("DEN startup repairs missing unlimited-trial billing rows before listening", () => {
  const source = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8")
  const repairCall = "await organizationBillingRepository.ensureMissingUnlimitedTrialAccounts()"

  assert.match(source, /ensureMissingUnlimitedTrialAccounts/)
  assert.ok(source.indexOf(repairCall) > source.indexOf("await ensureTables()"))
  assert.ok(source.indexOf(repairCall) < source.indexOf("app.listen(env.port"))
})
