import "dotenv/config"
import cors from "cors"
import express from "express"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { fromNodeHeaders, toNodeHandler } from "better-auth/node"
import { migrate } from "drizzle-orm/mysql2/migrator"
import { auth } from "./auth.js"
import { db } from "./db/index.js"
import { env } from "./env.js"
import { asyncRoute, errorMiddleware } from "./http/errors.js"
import { desktopAuthRouter } from "./http/desktop-auth.js"
import { orgsRouter } from "./http/orgs.js"
import { workersRouter } from "./http/workers.js"

const app = express()
const currentFile = fileURLToPath(import.meta.url)
const publicDir = path.resolve(path.dirname(currentFile), "../public")
const migrationsDir = path.resolve(path.dirname(currentFile), "../drizzle")

if (env.corsOrigins.length > 0) {
  app.use(
    cors({
      origin: env.corsOrigins,
      credentials: true,
      methods: ["GET", "POST", "PATCH", "DELETE"],
    }),
  )
}

app.use(express.json())
app.all("/api/auth/*", toNodeHandler(auth))
app.use(express.static(publicDir))

app.get("/health", (_, res) => {
  res.json({ ok: true })
})

app.get("/v1/me", asyncRoute(async (req, res) => {
  const session = await auth.api.getSession({
    headers: fromNodeHeaders(req.headers),
  })
  if (!session?.user?.id) {
    res.status(401).json({ error: "unauthorized" })
    return
  }
  res.json(session)
}))

app.use("/v1/desktop-auth", desktopAuthRouter)
app.use("/v1/orgs", orgsRouter)
app.use("/v1/workers", workersRouter)
app.use(errorMiddleware)

async function start() {
  try {
    await migrate(db, { migrationsFolder: migrationsDir })
    console.log("[den] migrations applied")
  } catch (err) {
    console.error("[den] migration failed:", err)
    process.exit(1)
  }

  app.listen(env.port, () => {
    console.log(`den listening on ${env.port} (provisioner=${env.provisionerMode})`)
  })
}

start()
