import test from "node:test"
import assert from "node:assert/strict"

import {
  MicrosoftConnectorIds,
  MicrosoftConnectors,
  getMicrosoftConnector,
  isMicrosoftConnectorId,
} from "../src/microsoft/connectors.js"

test("Microsoft connector definitions include read-only SharePoint", () => {
  assert.deepEqual(MicrosoftConnectorIds, ["microsoft-sharepoint"])
  const connector = getMicrosoftConnector("microsoft-sharepoint")
  assert.ok(connector)
  assert.equal(connector.name, "Microsoft SharePoint")
  assert.equal(connector.id, "microsoft-sharepoint")
  assert.equal(connector.mcpUrl, "https://graph.microsoft.com/v1.0")
  assert.ok(connector.scopes.includes("openid"))
  assert.ok(connector.scopes.includes("profile"))
  assert.ok(connector.scopes.includes("offline_access"))
  assert.ok(connector.scopes.includes("https://graph.microsoft.com/Files.Read.All"))
  assert.ok(connector.scopes.includes("https://graph.microsoft.com/Sites.Read.All"))
  assert.ok(!connector.scopes.some((scope) => scope.toLowerCase().includes("readwrite")))
  assert.ok(!connector.scopes.some((scope) => scope.toLowerCase().includes("write")))
})

test("Microsoft connector id helpers reject unknown ids", () => {
  assert.equal(isMicrosoftConnectorId("microsoft-sharepoint"), true)
  assert.equal(isMicrosoftConnectorId("google-drive"), false)
  assert.equal(getMicrosoftConnector("google-drive"), null)
})
