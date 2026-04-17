import { createServer, type IncomingMessage, type Server } from "node:http";

type FeedbackRequest = {
  headers: Record<string, string | string[] | undefined>;
  body: unknown;
};

type FeedbackServer = {
  baseUrl: string;
  requests: FeedbackRequest[];
  close: () => Promise<void>;
  waitForRequests: (count: number, timeoutMs?: number) => Promise<void>;
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];

    req.on("data", (chunk: Buffer) => chunks.push(Buffer.from(chunk)));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function parseJsonBody(rawBody: string): unknown {
  if (!rawBody.trim()) return null;
  return JSON.parse(rawBody);
}

export async function startFeedbackServer(): Promise<FeedbackServer> {
  const requests: FeedbackRequest[] = [];

  const server: Server = createServer(async (req, res) => {
    const origin = req.headers.origin ?? "*";
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("access-control-allow-methods", "POST, OPTIONS");
    res.setHeader("access-control-allow-headers", "authorization, content-type, x-veslo-org-id");
    res.setHeader("vary", "origin");

    if (req.method === "OPTIONS" && req.url === "/v1/feedback") {
      res.statusCode = 204;
      res.end();
      return;
    }

    if (req.method !== "POST" || req.url !== "/v1/feedback") {
      res.statusCode = 404;
      res.end("Not found");
      return;
    }

    const rawBody = await readBody(req);
    const body = parseJsonBody(rawBody);
    requests.push({
      headers: req.headers,
      body,
    });

    res.statusCode = 201;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ feedbackId: `feedback-${requests.length}`, status: "pending" }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (address == null || typeof address === "string") {
    throw new Error("Failed to bind feedback server");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      }),
    waitForRequests: async (count: number, timeoutMs = 10_000) => {
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        if (requests.length >= count) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`Timed out waiting for ${count} feedback request(s); saw ${requests.length}`);
    },
  };
}
