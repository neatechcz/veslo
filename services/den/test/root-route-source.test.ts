import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import path from "node:path"
import test from "node:test"
import { fileURLToPath } from "node:url"

const currentFile = fileURLToPath(import.meta.url)
const serviceRoot = path.resolve(path.dirname(currentFile), "..")
const denSource = readFileSync(path.join(serviceRoot, "src", "index.ts"), "utf8")

test("Den default root is handled before static onboarding assets", () => {
  assert.match(denSource, /app\.get\("\/"/, "Den must handle GET / explicitly")
  assert.match(
    denSource,
    /express\.static\(publicDir,\s*\{\s*index:\s*false\s*\}\)/,
    "static assets must not implicitly serve public/index.html for GET /",
  )

  const rootHandlerIndex = denSource.indexOf('app.get("/",')
  const staticMiddlewareIndex = denSource.indexOf("express.static(publicDir")
  assert.ok(rootHandlerIndex >= 0, "Den root handler must exist")
  assert.ok(staticMiddlewareIndex >= 0, "Den static middleware must exist")
  assert.ok(
    rootHandlerIndex < staticMiddlewareIndex,
    "Den root handler must run before static middleware",
  )
})

test("Den root only serves browser auth for explicit desktop onboarding", () => {
  assert.match(
    denSource,
    /req\.query\.desktopOnboarding\s*===\s*"1"/,
    "GET / must gate browser auth behind desktopOnboarding=1",
  )
  assert.match(
    denSource,
    /res\.json\(\{\s*ok:\s*true,\s*service:\s*"veslo-den"/,
    "default GET / must return neutral service metadata",
  )
})

test("Den blocks direct index.html from bypassing the onboarding gate", () => {
  assert.match(
    denSource,
    /app\.get\("\/index\.html"/,
    "GET /index.html must use the same explicit onboarding gate as GET /",
  )
})
