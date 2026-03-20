# Veslo Server

Filesystem-backed API for Veslo remote clients. This package provides the Veslo server layer described in `packages/app/pr/openwork-server.md` (legacy filename) and is intentionally independent from the desktop app.

## Quick start

```bash
npm install -g veslo-server
veslo-server --workspace /path/to/workspace --approval auto
```

`veslo-server` ships as a compiled binary, so Bun is not required at runtime.

Or from source:

```bash
pnpm --filter veslo-server dev -- \
  --workspace /path/to/workspace \
  --approval auto
```

The server logs the client token and host token on boot when they are auto-generated.

Add `--verbose` to print resolved config details on startup. Use `--version` to print the server version and exit.

## Config file

Defaults to `~/.config/veslo/server.json` (override with `VESLO_SERVER_CONFIG` or `--config`).

```json
{
  "host": "127.0.0.1",
  "port": 8787,
  "approval": { "mode": "manual", "timeoutMs": 30000 },
  "workspaces": [
    {
      "path": "/Users/susan/Finance",
      "name": "Finance",
      "workspaceType": "local",
      "baseUrl": "http://127.0.0.1:4096",
      "directory": "/Users/susan/Finance"
    }
  ],
  "corsOrigins": ["http://localhost:5173"]
}
```

## Environment variables

- `VESLO_SERVER_CONFIG` path to config JSON
- `VESLO_HOST` / `VESLO_PORT`
- `VESLO_TOKEN` client bearer token
- `VESLO_HOST_TOKEN` host approval token
- `VESLO_APPROVAL_MODE` (`manual` | `auto`)
- `VESLO_APPROVAL_TIMEOUT_MS`
- `VESLO_WORKSPACES` (JSON array or comma-separated list of paths)
- `VESLO_CORS_ORIGINS` (comma-separated list or `*`)
- `VESLO_OPENCODE_BASE_URL`
- `VESLO_OPENCODE_DIRECTORY`
- `VESLO_OPENCODE_USERNAME`
- `VESLO_OPENCODE_PASSWORD`

Token management (scoped tokens):

- `VESLO_TOKEN_STORE` path to token store JSON (default: alongside `server.json`)

File injection / artifacts:

- `VESLO_INBOX_ENABLED` (`1` | `0`)
- `VESLO_INBOX_MAX_BYTES` (default: 50MB, capped)
- `VESLO_OUTBOX_ENABLED` (`1` | `0`)

Sandbox advertisement (for capability discovery):

- `VESLO_SANDBOX_ENABLED` (`1` | `0`)
- `VESLO_SANDBOX_BACKEND` (`docker` | `container` | `none`)

## Endpoints

- `GET /health`
- `GET /status`
- `GET /capabilities`
- `GET /whoami`
- `GET /workspaces`
- `GET /workspace/:id/config`
- `PATCH /workspace/:id/config`
- `GET /workspace/:id/events`
- `POST /workspace/:id/engine/reload`
- `GET /workspace/:id/plugins`
- `POST /workspace/:id/plugins`
- `DELETE /workspace/:id/plugins/:name`
- `GET /workspace/:id/skills`
- `POST /workspace/:id/skills`
- `GET /workspace/:id/mcp`
- `POST /workspace/:id/mcp`
- `DELETE /workspace/:id/mcp/:name`
- `GET /workspace/:id/commands`
- `POST /workspace/:id/commands`
- `DELETE /workspace/:id/commands/:name`
- `GET /workspace/:id/audit`
- `GET /workspace/:id/export`
- `POST /workspace/:id/import`

Token management (host/owner auth):

- `GET /tokens`
- `POST /tokens` (body: `{ "scope": "owner"|"collaborator"|"viewer", "label"?: string }`)
- `DELETE /tokens/:id`

Inbox/outbox:

- `POST /workspace/:id/inbox` (multipart upload into `.opencode/veslo/inbox/`)
- `GET /workspace/:id/artifacts`
- `GET /workspace/:id/artifacts/:artifactId`
- `POST /workspace/:id/files/sessions`
- `POST /files/sessions/:sessionId/renew`
- `DELETE /files/sessions/:sessionId`
- `GET /files/sessions/:sessionId/catalog/snapshot`
- `GET /files/sessions/:sessionId/catalog/events`
- `POST /files/sessions/:sessionId/read-batch`
- `POST /files/sessions/:sessionId/write-batch`
- `POST /files/sessions/:sessionId/ops`

Toy UI (static assets served by the server):

- `GET /ui`
- `GET /w/:id/ui`
- `GET /ui/assets/*`

OpenCode proxy:

- `GET|POST|... /opencode/*`
- `GET|POST|... /w/:id/opencode/*`

OpenCode Router proxy:

- `GET|POST|... /opencode-router/*`
- `GET|POST|... /w/:id/opencode-router/*`

Auth policy:
- `GET /opencode-router/health` requires client auth.
- All other `/opencode-router/*` endpoints require host/owner auth.

## Approvals

All writes are gated by host approval.

Host APIs accept either:

- `X-Veslo-Host-Token: <token>` (legacy host token), or
- `Authorization: Bearer <token>` where the token scope is `owner`.

Approvals endpoints:

- `GET /approvals`
- `POST /approvals/:id` with `{ "reply": "allow" | "deny" }`

Set `VESLO_APPROVAL_MODE=auto` to auto-approve during local development.
