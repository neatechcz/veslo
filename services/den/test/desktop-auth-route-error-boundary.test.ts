import assert from "node:assert/strict"
import test from "node:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const currentFile = fileURLToPath(import.meta.url)
const serviceRoot = path.resolve(path.dirname(currentFile), "..")
const v1Source = readFileSync(path.join(serviceRoot, "src", "http", "desktop-auth.ts"), "utf8")
const v2Source = readFileSync(path.join(serviceRoot, "src", "http", "desktop-auth-v2.ts"), "utf8")

test("desktop auth routers wrap async handlers with asyncRoute", () => {
  assert.equal(
    v1Source.includes('import { asyncRoute } from "./errors.js"'),
    true,
    "v1 desktop auth router must import asyncRoute",
  )

  assert.equal(
    v2Source.includes('import { asyncRoute } from "./errors.js"'),
    true,
    "v2 desktop auth router must import asyncRoute",
  )

  for (const [name, source] of [
    ["v1", v1Source],
    ["v2", v2Source],
  ] as const) {
    assert.equal(
      source.includes('Router.post("/start", async (') || source.includes('Router.post("/handoff", async (') || source.includes('Router.post("/authorize", async (') || source.includes('Router.get("/status", async (') || source.includes('Router.post("/exchange", async ('),
      false,
      `${name} desktop auth routes must not register bare async handlers`,
    )
  }

  assert.equal(
    v1Source.includes('desktopAuthRouter.post("/start", asyncRoute(async (req, res) => {'),
    true,
    "v1 start route must be guarded by asyncRoute",
  )
  assert.equal(
    v1Source.includes('desktopAuthRouter.post("/handoff", asyncRoute(async (req, res) => {'),
    true,
    "v1 handoff route must be guarded by asyncRoute",
  )
  assert.equal(
    v1Source.includes('desktopAuthRouter.post("/exchange", asyncRoute(async (req, res) => {'),
    true,
    "v1 exchange route must be guarded by asyncRoute",
  )
  assert.equal(
    v2Source.includes('desktopAuthV2Router.post("/start", asyncRoute(async (req, res) => {'),
    true,
    "v2 start route must be guarded by asyncRoute",
  )
  assert.equal(
    v2Source.includes('desktopAuthV2Router.post("/authorize", asyncRoute(async (req, res) => {'),
    true,
    "v2 authorize route must be guarded by asyncRoute",
  )
  assert.equal(
    v2Source.includes('desktopAuthV2Router.get("/status", asyncRoute(async (req, res) => {'),
    true,
    "v2 status route must be guarded by asyncRoute",
  )
  assert.equal(
    v2Source.includes('desktopAuthV2Router.post("/exchange", asyncRoute(async (req, res) => {'),
    true,
    "v2 exchange route must be guarded by asyncRoute",
  )
})
