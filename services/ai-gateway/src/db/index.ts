import { drizzle } from "drizzle-orm/mysql2";
import mysql from "mysql2/promise";

import * as schema from "./schema.js";

export function createDb(databaseUrl: string) {
  const client = mysql.createPool({
    uri: databaseUrl,
    waitForConnections: true,
    connectionLimit: 10,
    maxIdle: 10,
    idleTimeout: 60_000,
    queueLimit: 0,
    enableKeepAlive: true,
    keepAliveInitialDelay: 0,
  });

  const db = drizzle(client, { schema, mode: "default" });

  return {
    db,
    client,
    close: async () => {
      await client.end();
    },
  };
}

type AiGatewayDbHandle = ReturnType<typeof createDb>;
export type AiGatewayDb = AiGatewayDbHandle["db"];
