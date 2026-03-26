import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const currentFile = fileURLToPath(import.meta.url)
const serviceRoot = path.resolve(path.dirname(currentFile), "..")

const workersSource = readFileSync(path.join(serviceRoot, "src", "http", "workers.ts"), "utf8")
const orgsSource = readFileSync(path.join(serviceRoot, "src", "http", "orgs.ts"), "utf8")

function extractSection(source: string, startMarker: string, endMarker?: string) {
  const start = source.indexOf(startMarker)
  assert.notEqual(start, -1, `missing section start: ${startMarker}`)

  const end = endMarker ? source.indexOf(endMarker, start + startMarker.length) : source.length
  assert.notEqual(end, -1, `missing section end: ${endMarker}`)

  return source.slice(start, end)
}

const createWorkerSection = extractSection(
  workersSource,
  'workersRouter.post("/",',
  'workersRouter.get("/billing"',
)

const billingSection = extractSection(
  workersSource,
  'workersRouter.post("/billing/subscription"',
  'workersRouter.get("/:id"',
)

const addMemberSection = extractSection(
  orgsSource,
  'orgsRouter.post("/:orgId/members"',
  'orgsRouter.patch("/:orgId/members/:memberId"',
)

const updateMemberSection = extractSection(
  orgsSource,
  'orgsRouter.patch("/:orgId/members/:memberId"',
  'orgsRouter.delete("/:orgId/members/:memberId"',
)

const deleteMemberSection = extractSection(
  orgsSource,
  'orgsRouter.delete("/:orgId/members/:memberId"',
)

test("cloud worker creation requires verified email before paywall checks", () => {
  assert.equal(createWorkerSection.includes('if (parsed.data.destination === "cloud")'), true)
  assert.equal(createWorkerSection.includes("requireVerifiedEmail(res, context.session)"), true)
  assert.equal(
    createWorkerSection.indexOf("requireVerifiedEmail(res, context.session)") <
      createWorkerSection.indexOf("requireCloudWorkerAccess({"),
    true,
  )
})

test("org membership writes require verified email", () => {
  assert.equal(addMemberSection.includes("requireVerifiedEmail(res, context.session)"), true)
  assert.equal(updateMemberSection.includes("requireVerifiedEmail(res, context.session)"), true)
  assert.equal(deleteMemberSection.includes("requireVerifiedEmail(res, context.session)"), true)
})

test("billing subscription mutation requires verified email", () => {
  assert.equal(billingSection.includes("requireVerifiedEmail(res, session)"), true)
})
