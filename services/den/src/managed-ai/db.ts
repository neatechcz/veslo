import { drizzle } from "drizzle-orm/mysql2"
import mysql from "mysql2/promise"
import { env } from "../env.js"
import * as schema from "./schema.js"

export type ManagedAiDbSelectionOptions = {
  db?: unknown
  databaseUrl?: string
}

export type ManagedAiDbSelectionDependencies = {
  managedAiDb?: unknown | null
  createManagedAiDb?: (databaseUrl: string) => unknown
}

export function createManagedAiClient(databaseUrl: string) {
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

export function createManagedAiDb(databaseUrl: string) {
  return drizzle(createManagedAiClient(databaseUrl), { schema, mode: "default" })
}

export function resolveManagedAiDb(
  options: ManagedAiDbSelectionOptions = {},
  deps: ManagedAiDbSelectionDependencies = {},
) {
  if (options.db) {
    return options.db
  }

  if (options.databaseUrl) {
    return (deps.createManagedAiDb ?? createManagedAiDb)(options.databaseUrl)
  }

  return deps.managedAiDb ?? managedAiDb
}

export const managedAiDb = env.managedAi.databaseUrl
  ? createManagedAiDb(env.managedAi.databaseUrl)
  : null
