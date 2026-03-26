import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const currentFile = fileURLToPath(import.meta.url)
const serviceRoot = path.resolve(path.dirname(currentFile), "..")

const workersSource = readFileSync(path.join(serviceRoot, "src", "http", "workers.ts"), "utf8")
const orgsSource = readFileSync(path.join(serviceRoot, "src", "http", "orgs.ts"), "utf8")
const billingSection = workersSource.slice(workersSource.indexOf('workersRouter.post("/billing/subscription"'))

test("cloud worker creation requires verified email before paywall checks", () => {
  assert.equal(workersSource.includes('if (parsed.data.destination === "cloud")'), true)
  assert.equal(workersSource.includes("requireVerifiedEmail(res, context.session)"), true)
  assert.equal(
    workersSource.indexOf("requireVerifiedEmail(res, context.session)") <
      workersSource.indexOf("requireCloudWorkerAccess({"),
    true,
  )
})

test("org membership writes require verified email", () => {
  assert.equal(orgsSource.match(/requireVerifiedEmail\(res, context\.session\)/g)?.length ?? 0, 3)
})

test("billing subscription mutation requires verified email", () => {
  assert.equal(billingSection.includes("requireVerifiedEmail(res, session)"), true)
})
