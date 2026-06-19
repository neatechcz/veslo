import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { Transform } from "node:stream";

export type ProxyToEngineOptions = {
  clientReq: IncomingMessage;
  clientRes: ServerResponse;
  targetBaseUrl: string;
  targetPath: string;
  targetSearch?: string;
  injectHeaders?: Record<string, string>;
  stripIncomingHeaders?: string[];
  rewriteJsonBody?: (value: unknown) => unknown;
  rewriteJsonResponse?: (value: unknown) => unknown;
  onSuccess?: () => void;
  onError?: (error: Error) => void;
};

const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  "transfer-encoding",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "upgrade",
]);

const ALWAYS_STRIPPED_REQUEST_HEADERS = new Set([
  "host",
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
]);

function isJsonContentType(value: string | string[] | number | undefined): boolean {
  if (Array.isArray(value)) return value.some((item) => isJsonContentType(item));
  return typeof value === "string" && /\bjson\b/i.test(value);
}

function isEventStreamContentType(value: string | string[] | number | undefined): boolean {
  if (Array.isArray(value)) return value.some((item) => isEventStreamContentType(item));
  return typeof value === "string" && /^text\/event-stream\b/i.test(value.trim());
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

function stripContentLength(headers: Record<string, string | string[]>): Record<string, string | string[]> {
  const next: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "content-length") continue;
    next[key] = value;
  }
  return next;
}

function writeJsonResponse(
  opts: ProxyToEngineOptions,
  upstreamRes: IncomingMessage,
  body: Buffer,
): void {
  try {
    const parsed = body.length ? JSON.parse(body.toString("utf8")) : null;
    const rewritten = opts.rewriteJsonResponse?.(parsed) ?? parsed;
    const payload = Buffer.from(JSON.stringify(rewritten), "utf8");
    opts.clientRes.setHeader("content-type", "application/json");
    opts.clientRes.setHeader("content-length", String(payload.byteLength));
    opts.clientRes.end(payload);
    opts.onSuccess?.();
  } catch (err) {
    opts.onError?.(err instanceof Error ? err : new Error(String(err)));
    opts.clientRes.statusCode = 502;
    opts.clientRes.setHeader("content-type", "application/json");
    opts.clientRes.end(JSON.stringify({ error: "upstream rewrite error" }));
    upstreamRes.resume();
  }
}

function rewriteSseLine(
  line: string,
  rewriteJsonResponse: (value: unknown) => unknown,
): string {
  const match = /^(data:\s?)(.*?)(\r?)$/.exec(line);
  if (!match) return line;
  const payload = match[2]?.trim();
  if (!payload || payload === "[DONE]") return line;
  if (!payload.startsWith("{") && !payload.startsWith("[")) return line;

  try {
    const rewritten = rewriteJsonResponse(JSON.parse(payload));
    return `${match[1]}${JSON.stringify(rewritten)}${match[3] ?? ""}`;
  } catch {
    return line;
  }
}

function createSseRewriteTransform(
  rewriteJsonResponse: (value: unknown) => unknown,
): Transform {
  let pending = "";
  return new Transform({
    transform(chunk, _encoding, callback) {
      pending += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        this.push(`${rewriteSseLine(line, rewriteJsonResponse)}\n`);
      }
      callback();
    },
    flush(callback) {
      if (pending) {
        this.push(rewriteSseLine(pending, rewriteJsonResponse));
        pending = "";
      }
      callback();
    },
  });
}

export function proxyToEngine(opts: ProxyToEngineOptions): void {
  const target = new URL(opts.targetBaseUrl);
  const stripSet = new Set(ALWAYS_STRIPPED_REQUEST_HEADERS);
  for (const h of opts.stripIncomingHeaders ?? []) {
    stripSet.add(h.toLowerCase());
  }

  const headers: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(opts.clientReq.headers)) {
    if (v === undefined) continue;
    if (stripSet.has(k.toLowerCase())) continue;
    headers[k] = v;
  }
  for (const [k, v] of Object.entries(opts.injectHeaders ?? {})) {
    headers[k] = v;
  }
  if (opts.rewriteJsonResponse) {
    headers["accept-encoding"] = "identity";
  }

  const upstreamReq = httpRequest(
    {
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port || (target.protocol === "https:" ? 443 : 80),
      path: opts.targetPath + (opts.targetSearch ?? ""),
      method: opts.clientReq.method ?? "GET",
      headers,
    },
    (upstreamRes) => {
      opts.clientRes.statusCode = upstreamRes.statusCode ?? 502;
      if (upstreamRes.statusMessage) {
        opts.clientRes.statusMessage = upstreamRes.statusMessage;
      }
      const rewriteResponse = Boolean(
        opts.rewriteJsonResponse && isJsonContentType(upstreamRes.headers["content-type"]),
      );
      const rewriteEventStream = Boolean(
        opts.rewriteJsonResponse && isEventStreamContentType(upstreamRes.headers["content-type"]),
      );
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (v === undefined) continue;
        if (HOP_BY_HOP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
        if ((rewriteResponse || rewriteEventStream) && k.toLowerCase() === "content-length") continue;
        opts.clientRes.setHeader(k, v);
      }
      if (rewriteResponse) {
        const chunks: Buffer[] = [];
        upstreamRes.on("data", (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        upstreamRes.on("end", () => {
          writeJsonResponse(opts, upstreamRes, Buffer.concat(chunks));
        });
        upstreamRes.on("error", (err) => {
          opts.onError?.(err);
          if (!opts.clientRes.writableEnded) {
            opts.clientRes.destroy(err);
          }
        });
        return;
      }
      if (rewriteEventStream && opts.rewriteJsonResponse) {
        upstreamRes
          .pipe(createSseRewriteTransform(opts.rewriteJsonResponse))
          .pipe(opts.clientRes);
        upstreamRes.on("end", () => {
          opts.onSuccess?.();
        });
        upstreamRes.on("error", (err) => {
          opts.onError?.(err);
          if (!opts.clientRes.writableEnded) {
            opts.clientRes.destroy(err);
          }
        });
        return;
      }
      upstreamRes.pipe(opts.clientRes);
      upstreamRes.on("end", () => {
        opts.onSuccess?.();
      });
      upstreamRes.on("error", (err) => {
        opts.onError?.(err);
        if (!opts.clientRes.writableEnded) {
          opts.clientRes.destroy(err);
        }
      });
    },
  );

  upstreamReq.on("error", (err) => {
    opts.onError?.(err);
    if (!opts.clientRes.headersSent) {
      opts.clientRes.statusCode = 502;
      opts.clientRes.setHeader("content-type", "application/json");
      opts.clientRes.end(
        JSON.stringify({ error: "upstream engine error", detail: err.message }),
      );
    } else if (!opts.clientRes.writableEnded) {
      opts.clientRes.destroy(err);
    }
  });

  const endWithBodyRewriteError = (err: unknown): void => {
    const error = err instanceof Error ? err : new Error(String(err));
    opts.onError?.(error);
    if (!upstreamReq.destroyed) upstreamReq.destroy(error);
    if (!opts.clientRes.headersSent) {
      opts.clientRes.statusCode = 502;
      opts.clientRes.setHeader("content-type", "application/json");
      opts.clientRes.end(JSON.stringify({ error: "upstream request rewrite error" }));
    }
  };

  const abortUpstream = (): void => {
    if (!upstreamReq.destroyed) upstreamReq.destroy();
  };
  // Premature client disconnect: 'aborted' fires when the incoming request is
  // closed before completing. Do NOT listen on clientReq 'close' — in modern
  // Node it fires on normal request completion, which would kill the in-flight
  // proxy. Use clientRes 'close' to detect client-side socket drop *after* we
  // started responding.
  opts.clientReq.on("aborted", abortUpstream);
  opts.clientRes.on("close", () => {
    if (!opts.clientRes.writableEnded) abortUpstream();
  });

  if (opts.rewriteJsonBody && isJsonContentType(headers["content-type"])) {
    void readBody(opts.clientReq)
      .then((body) => {
        if (body.length === 0) {
          upstreamReq.end();
          return;
        }
        const parsed = JSON.parse(body.toString("utf8"));
        const rewritten = opts.rewriteJsonBody?.(parsed) ?? parsed;
        const payload = Buffer.from(JSON.stringify(rewritten), "utf8");
        upstreamReq.setHeader("content-type", "application/json");
        upstreamReq.setHeader("content-length", String(payload.byteLength));
        upstreamReq.end(payload);
      })
      .catch(endWithBodyRewriteError);
  } else {
    const nextHeaders = opts.rewriteJsonBody ? stripContentLength(headers) : headers;
    for (const [key, value] of Object.entries(nextHeaders)) {
      upstreamReq.setHeader(key, value);
    }
    opts.clientReq.pipe(upstreamReq);
  }
}
