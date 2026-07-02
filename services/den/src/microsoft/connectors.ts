export const MicrosoftConnectorIds = ["microsoft-sharepoint"] as const

export type MicrosoftConnectorId = (typeof MicrosoftConnectorIds)[number]

export type MicrosoftConnectorDefinition = {
  id: MicrosoftConnectorId
  name: string
  scopes: string[]
  mcpUrl: string
}

export const MicrosoftConnectors: MicrosoftConnectorDefinition[] = [
  {
    id: "microsoft-sharepoint",
    name: "Microsoft SharePoint",
    scopes: [
      "openid",
      "profile",
      "offline_access",
      "https://graph.microsoft.com/Files.Read.All",
      "https://graph.microsoft.com/Sites.Read.All",
    ],
    mcpUrl: "https://graph.microsoft.com/v1.0",
  },
]

export function isMicrosoftConnectorId(value: string): value is MicrosoftConnectorId {
  return (MicrosoftConnectorIds as readonly string[]).includes(value)
}

export function getMicrosoftConnector(value: string): MicrosoftConnectorDefinition | null {
  return MicrosoftConnectors.find((connector) => connector.id === value) ?? null
}
