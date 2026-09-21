# Gmail Attachment Download Design

## Problem

Veslo exposes Gmail through Google's hosted Gmail MCP server. The hosted server
can search messages and return attachment metadata, including the message id,
attachment id, filename, and MIME type, but it does not expose a tool that
retrieves the attachment bytes. The underlying Gmail REST API does expose those
bytes with the existing `gmail.readonly` scope. As a result, an agent can find a
ZIP attachment but currently has no reliable capability to save it and asks the
user to upload the file again.

## Chosen Approach

Extend the Veslo-owned Gmail MCP proxy with one connector-specific tool named
`download_attachment`. The proxy will add the tool to successful Gmail
`tools/list` responses and will handle matching `tools/call` requests locally.
All other MCP methods and all Calendar and Drive traffic will continue to pass
through unchanged to Google's hosted MCP servers.

The custom tool will accept the Gmail message id, attachment id, original
filename, and MIME type. It will return a short-lived download URL and explicit
instructions to save that URL into the active workspace instead of asking the
user to re-upload the attachment. Returning a URL keeps binary data out of the
model context and supports ZIP files more reliably than a base64 MCP result.

## Security and Data Flow

1. The existing Veslo runtime token authenticates the MCP `tools/call` request
   and identifies the organization, user, and Gmail connector.
2. Den signs a five-minute attachment-download token with the existing Google
   Workspace state secret. The token is bound to the organization, user,
   connector, message id, attachment id, filename, and MIME type.
3. The returned URL points to a Den download endpoint and contains only that
   short-lived scoped token. It never exposes the stored Google access or
   refresh token.
4. The download endpoint verifies the signature and expiry, reloads or refreshes
   the same user's Google grant, and requests the exact attachment from the
   Gmail REST API.
5. Den validates the Gmail response, decodes base64url content, applies a
   bounded size limit, and returns the original bytes with a safe content type
   and attachment filename.

The URL may appear in a model transcript, so its lifetime is intentionally
short and its authority is limited to one immutable attachment. Tokens and
attachment bodies must not be logged.

## Error Handling

- Invalid MCP parameters return a JSON-RPC `invalid_params` error without an
  upstream request.
- Invalid or expired download tokens return a stable unauthorized response.
- Missing or revoked Google grants return the existing connection-required
  response.
- Gmail authorization, not-found, rate-limit, payload, and availability errors
  are translated to stable, secret-free responses.
- Malformed base64url data and oversized attachment bodies fail closed without
  returning partial bytes.
- If Google's `tools/list` response is unavailable or malformed, the proxy
  preserves the upstream response rather than inventing an incomplete tool
  list.

## Verification

Tests will cover the complete proxy contract:

- `tools/list` appends the custom Gmail tool while preserving upstream tools;
- Calendar and Drive tool lists remain unchanged;
- `tools/call` returns a scoped, expiring URL without calling Google's MCP
  endpoint;
- the URL downloads exact ZIP bytes from the Gmail REST attachment endpoint;
- invalid, expired, or tampered tokens are rejected;
- attachment size, malformed payload, and safe filename handling fail closed;
- existing Google OAuth, runtime-token, refresh, and pass-through proxy tests
  remain green.

After focused tests, Den typecheck/build and the repository quality gate will
run. The reviewed branch will then be pushed and deployed with the dedicated
staging-server workflow. Staging verification will include workflow success,
public endpoint health, and a live Gmail MCP `tools/list` check proving that the
new tool is exposed. A real attachment download additionally requires a
connected staging Gmail account and will be exercised when such a grant is
available without exposing credentials.
