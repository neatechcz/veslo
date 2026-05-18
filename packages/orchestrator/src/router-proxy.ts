import {
  request as httpRequest,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

export type ProxyToEngineOptions = {
  clientReq: IncomingMessage;
  clientRes: ServerResponse;
  targetBaseUrl: string;
  targetPath: string;
  targetSearch?: string;
  injectHeaders?: Record<string, string>;
  stripIncomingHeaders?: string[];
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
      for (const [k, v] of Object.entries(upstreamRes.headers)) {
        if (v === undefined) continue;
        if (HOP_BY_HOP_RESPONSE_HEADERS.has(k.toLowerCase())) continue;
        opts.clientRes.setHeader(k, v);
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

  opts.clientReq.pipe(upstreamReq);
}
