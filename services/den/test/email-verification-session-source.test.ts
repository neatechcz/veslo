import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"

const sessionSource = readFileSync(new URL("../src/http/session.ts", import.meta.url), "utf8")
const legacyDesktopAuthSource = readFileSync(new URL("../src/http/desktop-auth.ts", import.meta.url), "utf8")
const desktopAuthV2Source = readFileSync(new URL("../src/http/desktop-auth-v2.ts", import.meta.url), "utf8")

test("common DEN session boundary applies the verification policy after normalizing the session", () => {
  const contextIndex = sessionSource.indexOf("const context: SessionContext")
  const policyIndex = sessionSource.indexOf("enforceSessionPolicy(res, context")

  assert.notEqual(contextIndex, -1, "requireSession must normalize the authenticated user into a SessionContext")
  assert.notEqual(policyIndex, -1, "requireSession must enforce the common session policy")
  assert.equal(contextIndex < policyIndex, true, "the session must be normalized before policy enforcement")
  assert.match(sessionSource, /requireEmailVerification:\s*env\.authRequireEmailVerification/)
})

test("both desktop handoff generations depend on the common verified session boundary", () => {
  const legacyHandoffSection = legacyDesktopAuthSource.slice(
    legacyDesktopAuthSource.indexOf('desktopAuthRouter.post("/handoff"'),
    legacyDesktopAuthSource.indexOf('desktopAuthRouter.post("/exchange"'),
  )
  const v2AuthorizeSection = desktopAuthV2Source.slice(
    desktopAuthV2Source.indexOf('desktopAuthV2Router.post("/authorize"'),
    desktopAuthV2Source.indexOf('desktopAuthV2Router.get("/status"'),
  )

  assert.match(legacyHandoffSection, /requireSession\(req, res\)/)
  assert.match(v2AuthorizeSection, /requireSession\(req, res\)/)
  assert.doesNotMatch(desktopAuthV2Source, /desktopAuthRequireEmailVerified/)
  assert.doesNotMatch(v2AuthorizeSection, /email_verification_required/)
})
