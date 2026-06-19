export const GoogleWorkspaceConnectorIds = ["google-gmail", "google-calendar", "google-drive"] as const

export type GoogleWorkspaceConnectorId = (typeof GoogleWorkspaceConnectorIds)[number]

export type GoogleWorkspaceConnectorDefinition = {
  id: GoogleWorkspaceConnectorId
  name: string
  scopes: string[]
  mcpUrl: string
}

export const GoogleWorkspaceConnectors: GoogleWorkspaceConnectorDefinition[] = [
  {
    id: "google-gmail",
    name: "Google Gmail",
    scopes: [
      "https://www.googleapis.com/auth/gmail.readonly",
      "https://www.googleapis.com/auth/gmail.compose",
    ],
    mcpUrl: "https://gmailmcp.googleapis.com/mcp/v1",
  },
  {
    id: "google-calendar",
    name: "Google Calendar",
    scopes: [
      "https://www.googleapis.com/auth/calendar.calendarlist.readonly",
      "https://www.googleapis.com/auth/calendar.events.freebusy",
      "https://www.googleapis.com/auth/calendar.events.readonly",
    ],
    mcpUrl: "https://calendarmcp.googleapis.com/mcp/v1",
  },
  {
    id: "google-drive",
    name: "Google Drive",
    scopes: [
      "https://www.googleapis.com/auth/drive.readonly",
      "https://www.googleapis.com/auth/drive.file",
    ],
    mcpUrl: "https://drivemcp.googleapis.com/mcp/v1",
  },
]

export function isGoogleWorkspaceConnectorId(value: string): value is GoogleWorkspaceConnectorId {
  return (GoogleWorkspaceConnectorIds as readonly string[]).includes(value)
}

export function getGoogleWorkspaceConnector(value: string): GoogleWorkspaceConnectorDefinition | null {
  return GoogleWorkspaceConnectors.find((connector) => connector.id === value) ?? null
}
