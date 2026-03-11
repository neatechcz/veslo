import express from "express"
import { fromNodeHeaders } from "better-auth/node"
import { auth } from "../auth.js"

export type SessionContext = {
  user: {
    id: string
    email: string | null
    emailVerified: boolean
    name: string | null
  }
}

export async function requireSession(req: express.Request, res: express.Response): Promise<SessionContext | null> {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  })

  if (!session?.user?.id) {
    res.status(401).json({ error: "unauthorized" })
    return null
  }

  return {
    user: {
      id: session.user.id,
      email: typeof session.user.email === "string" ? session.user.email : null,
      emailVerified: session.user.emailVerified === true,
      name: typeof session.user.name === "string" ? session.user.name : null,
    },
  }
}
