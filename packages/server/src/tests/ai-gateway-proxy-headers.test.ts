import { expect, test } from "bun:test";

import {
  AI_GATEWAY_INTERNAL_REQUEST_HEADERS,
  AI_GATEWAY_LOCAL_ONLY_REQUEST_HEADERS,
  AI_GATEWAY_TRANSPORT_REQUEST_HEADERS,
  stripAiGatewayProxyRequestHeaders,
} from "../ai-gateway-proxy-headers.js";
import {
  AUTHORIZATION_HEADER,
  CONTENT_TYPE_HEADER,
  VESLO_SESSION_ID_HEADER,
} from "../request-headers.js";

test("AI gateway proxy header strip profile removes internal, local, and transport headers", () => {
  const headers = new Headers({
    [AUTHORIZATION_HEADER]: "Bearer upstream-provider-token",
    [VESLO_SESSION_ID_HEADER]: "session-123",
    [CONTENT_TYPE_HEADER]: "application/json",
    "x-veslo-request-id": "request-123",
  });

  for (const name of AI_GATEWAY_INTERNAL_REQUEST_HEADERS) {
    headers.set(name, `internal-${name}`);
  }
  for (const name of AI_GATEWAY_LOCAL_ONLY_REQUEST_HEADERS) {
    headers.set(name, `local-${name}`);
  }
  for (const name of AI_GATEWAY_TRANSPORT_REQUEST_HEADERS) {
    headers.set(name, `transport-${name}`);
  }

  stripAiGatewayProxyRequestHeaders(headers);

  for (const name of [
    ...AI_GATEWAY_INTERNAL_REQUEST_HEADERS,
    ...AI_GATEWAY_LOCAL_ONLY_REQUEST_HEADERS,
    ...AI_GATEWAY_TRANSPORT_REQUEST_HEADERS,
  ]) {
    expect(headers.has(name)).toBe(false);
  }

  expect(headers.get(AUTHORIZATION_HEADER)).toBe("Bearer upstream-provider-token");
  expect(headers.get(VESLO_SESSION_ID_HEADER)).toBe("session-123");
  expect(headers.get(CONTENT_TYPE_HEADER)).toBe("application/json");
  expect(headers.get("x-veslo-request-id")).toBe("request-123");
});
