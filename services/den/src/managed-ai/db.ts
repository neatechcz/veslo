import { drizzle } from "drizzle-orm/mysql2"
import mysql from "mysql2/promise"
import { env } from "../env.js"

function createManagedAiClient(databaseUrl: string) {
  return mysql.createPool({
    uri: databaseUrl,
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 10,
    idleTimeout: 60_000,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  })
}

export const managedAiDb = env.managedAi.databaseUrl
  ? drizzle(createManagedAiClient(env.managedAi.databaseUrl), { mode: "default" })
  : null
