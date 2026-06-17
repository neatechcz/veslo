import express from "express"
import type { PlatformAdminRecipient } from "./admin-runtime.js"

function readBearerToken(req: express.Request) {
  const header = req.header("authorization")?.trim() ?? ""
  const match = /^Bearer\s+(.+)$/i.exec(header)
  return match?.[1]?.trim() || null
}

function dedupeRecipients(recipients: PlatformAdminRecipient[]): PlatformAdminRecipient[] {
  const seen = new Set<string>()
  const result: PlatformAdminRecipient[] = []
  for (const recipient of recipients) {
    const email = recipient.email.trim().toLowerCase()
    if (!email || seen.has(email)) continue
    seen.add(email)
    result.push({ ...recipient, email })
  }
  return result
}

export function createInternalPlatformAdminRecipientsRouter(options: {
  token: string | null
  listRecipients: () => Promise<PlatformAdminRecipient[]>
}) {
  const router = express.Router()

  router.get("/platform-admin-recipients", async (req, res) => {
    if (!options.token) {
      res.status(503).json({ error: "platform_admin_recipients_not_configured" })
      return
    }

    const bearerToken = readBearerToken(req)
    if (!bearerToken) {
      res.status(401).json({ error: "platform_admin_recipients_unauthorized" })
      return
    }
    if (bearerToken !== options.token) {
      res.status(403).json({ error: "platform_admin_recipients_forbidden" })
      return
    }

    const recipients = dedupeRecipients(await options.listRecipients())
    res.json({ recipients })
  })

  return router
}
