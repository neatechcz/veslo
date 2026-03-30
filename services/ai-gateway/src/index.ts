import express from "express";
import { pathToFileURL } from "node:url";

import { env } from "./env.js";

export function createApp() {
  const app = express();

  app.get("/health", (_req, res) => {
    res.status(200).json({ ok: true, service: "ai-gateway" });
  });

  return app;
}

export function startServer() {
  const app = createApp();
  return app.listen(env.port, env.host, () => {
    console.log(`ai-gateway listening on http://${env.host}:${env.port}`);
  });
}

const isMain =
  typeof process.argv[1] === "string" &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startServer();
}
