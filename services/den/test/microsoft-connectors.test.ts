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
  assert.deepEqual(connector.scopes, [
    "openid",
    "profile",
    "offline_access",
    "https://graph.microsoft.com/Files.Read.All",
    "https://graph.microsoft.com/Sites.Read.All",
  ])
  assert.deepEqual(MicrosoftConnectors, [connector])
})

test("Microsoft connector id helpers reject unknown ids", () => {
  assert.equal(isMicrosoftConnectorId("microsoft-sharepoint"), true)
  assert.equal(isMicrosoftConnectorId("google-drive"), false)
  assert.equal(getMicrosoftConnector("google-drive"), null)
})
