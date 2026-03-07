import { NextRequest } from "next/server";

const DEFAULT_API_BASE = "https://api.veslo.neatech.com";
const DEFAULT_AUTH_ORIGIN = "https://den-control-plane-veslo.onrender.com";
const apiBase = (process.env.DEN_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, "");
const authOrigin = (process.env.DEN_AUTH_ORIGIN ?? DEFAULT_AUTH_ORIGIN).replace(/\/+$/, "");

export const dynamic = "force-dynamic";

const NO_BODY_STATUS = new Set([204, 205, 304]);

function getTargetPath(request: NextRequest, segments: string[]): string {
  const incoming = new URL(request.url);
  let targetPath = segments.join("/");

  if (!targetPath) {
    const prefix = "/api/den/";
    if (incoming.pathname.startsWith(prefix)) {
      targetPath = incoming.pathname.slice(prefix.length);
    } else if (incoming.pathname === "/api/den") {
      targetPath = "";
    }
  }

  return targetPath;
}

function buildTargetUrl(base: string, request: NextRequest, targetPath: string): string {
  const incoming = new URL(request.url);
  const upstream = new URL(`${base}/${targetPath}`);
  upstream.search = incoming.search;
  return upstream.toString();
}

function isLikelyHtmlBody(body: ArrayBuffer): boolean {
  if (body.byteLength === 0) {
    return false;
  }

  const preview = new TextDecoder().decode(body.slice(0, 256)).trim().toLowerCase();
  return preview.startsWith("<!doctype") || preview.startsWith("<html") || preview.includes("<body");
}

function shouldFallbackToAuthOrigin(response: Response, body: ArrayBuffer): boolean {
  if (response.status === 502 || response.status === 503 || response.status === 504) {
    return true;
  }

  if (response.status < 500) {
    return false;
  }

  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (contentType.includes("text/html")) {
    return true;
  }

  return isLikelyHtmlBody(body);
}

function buildUpstreamErrorResponse(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: {
      "content-type": "application/json"
    }
  });
}

function copySetCookieHeaders(upstreamHeaders: Headers, responseHeaders: Headers): void {
  const getSetCookie = (upstreamHeaders as Headers & { getSetCookie?: () => string[] }).getSetCookie;
  if (typeof getSetCookie === "function") {
    const cookies = getSetCookie.call(upstreamHeaders);
    for (const cookie of cookies) {
      if (cookie) {
        responseHeaders.append("set-cookie", cookie);
      }
    }
    return;
  }

  const cookie = upstreamHeaders.get("set-cookie");
  if (cookie) {
    responseHeaders.append("set-cookie", cookie);
  }
}

function buildHeaders(request: NextRequest, contentType: string | null): Headers {
  const headers = new Headers();
  const copyHeaders = ["accept", "authorization", "cookie", "user-agent", "x-requested-with", "origin"];

  for (const key of copyHeaders) {
    const value = request.headers.get(key);
    if (value) {
      headers.set(key, value);
    }
  }

  if (contentType) {
    headers.set("content-type", contentType);
  }

  if (!headers.has("accept")) {
    headers.set("accept", "application/json");
  }

  if (!headers.has("origin")) {
    headers.set("origin", authOrigin);
  }

  return headers;
}

async function fetchUpstream(
  request: NextRequest,
  targetUrl: string,
  contentType: string | null,
  body: Uint8Array | null,
): Promise<{ response: Response; body: ArrayBuffer }> {
  const init: RequestInit = {
    method: request.method,
    headers: buildHeaders(request, contentType),
    redirect: "manual",
  };

  if (body && request.method !== "GET" && request.method !== "HEAD") {
    init.body = body;
  }

  const response = await fetch(targetUrl, init);
  const responseBody = await response.arrayBuffer();
  return { response, body: responseBody };
}

async function proxy(request: NextRequest, segments: string[] = []) {
  const targetPath = getTargetPath(request, segments);
  const primaryTargetUrl = buildTargetUrl(apiBase, request, targetPath);
  const fallbackTargetUrl = buildTargetUrl(authOrigin, request, targetPath);
  const contentType = request.headers.get("content-type");
  const requestBody = request.method !== "GET" && request.method !== "HEAD" ? new Uint8Array(await request.arrayBuffer()) : null;

  let upstream: Response | null = null;
  let body: ArrayBuffer | null = null;

  try {
    const primary = await fetchUpstream(request, primaryTargetUrl, contentType, requestBody);
    upstream = primary.response;
    body = primary.body;
  } catch {
    if (apiBase !== authOrigin) {
      try {
        const fallback = await fetchUpstream(request, fallbackTargetUrl, contentType, requestBody);
        upstream = fallback.response;
        body = fallback.body;
      } catch {}
    }
  }

  if (!upstream || !body) {
    return buildUpstreamErrorResponse(502, "Upstream request failed.");
  }

  if (apiBase !== authOrigin && shouldFallbackToAuthOrigin(upstream, body)) {
    try {
      const fallback = await fetchUpstream(request, fallbackTargetUrl, contentType, requestBody);
      upstream = fallback.response;
      body = fallback.body;
    } catch {}
  }

  const responseContentType = upstream.headers.get("content-type")?.toLowerCase() ?? "";
  if (upstream.status >= 500 && (responseContentType.includes("text/html") || isLikelyHtmlBody(body))) {
    return buildUpstreamErrorResponse(upstream.status, "Upstream service unavailable.");
  }

  const responseHeaders = new Headers();
  const passThroughHeaders = ["content-type", "location", "cache-control"];

  for (const key of passThroughHeaders) {
    const value = upstream.headers.get(key);
    if (value) {
      responseHeaders.set(key, value);
    }
  }

  copySetCookieHeaders(upstream.headers, responseHeaders);

  const shouldDropBody = request.method === "HEAD" || NO_BODY_STATUS.has(upstream.status);

  return new Response(shouldDropBody ? null : body, {
    status: upstream.status,
    headers: responseHeaders
  });
}

export async function GET(request: NextRequest) {
  return proxy(request);
}

export async function POST(request: NextRequest) {
  return proxy(request);
}

export async function PUT(request: NextRequest) {
  return proxy(request);
}

export async function PATCH(request: NextRequest) {
  return proxy(request);
}

export async function DELETE(request: NextRequest) {
  return proxy(request);
}
