import assert from "node:assert/strict"
import { once } from "node:events"
import { createHash } from "node:crypto"
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { AddressInfo } from "node:net"
import test from "node:test"
import express from "express"

const { createDesktopDiagnosticDumpsRouter, createDiagnosticDumpsIngestRouter } = await import("../src/http/diagnostic-dumps.js")

async function startServer(options: {
  ingestToken: string | null
  rootDir: string
  maxBytes?: number
  now?: () => Date
  randomId?: () => string
}) {
  const app = express()
  app.use("/v1/internal", createDiagnosticDumpsIngestRouter(options))

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  const { port } = server.address() as AddressInfo
  return {
    port,
    close: async () => {
      server.close()
      await once(server, "close")
    },
  }
}

async function startDesktopServer(options: {
  rootDir: string
  maxBytes?: number
  now?: () => Date
  randomId?: () => string
  authorize?: Parameters<typeof createDesktopDiagnosticDumpsRouter>[0]["authorize"]
}) {
  const app = express()
  app.use("/v1", createDesktopDiagnosticDumpsRouter(options))

  const server = app.listen(0, "127.0.0.1")
  await once(server, "listening")

  const { port } = server.address() as AddressInfo
  return {
    port,
    close: async () => {
      server.close()
      await once(server, "close")
    },
  }
}

test("diagnostic dump ingest rejects missing and wrong bearer auth", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "veslo-den-diagnostic-dumps-"))
  const server = await startServer({ ingestToken: "ingest-token", rootDir })

  try {
    const missing = await fetch(`http://127.0.0.1:${server.port}/v1/internal/diagnostic-dumps`, {
      method: "POST",
      body: "hello",
    })
    assert.equal(missing.status, 401)
    assert.equal((await missing.json()).error, "diagnostic_dump_ingest_unauthorized")

    const wrong = await fetch(`http://127.0.0.1:${server.port}/v1/internal/diagnostic-dumps`, {
      method: "POST",
      headers: { Authorization: "Bearer wrong-token" },
      body: "hello",
    })
    assert.equal(wrong.status, 403)
    assert.equal((await wrong.json()).error, "diagnostic_dump_ingest_forbidden")
  } finally {
    await server.close()
    await rm(rootDir, { recursive: true, force: true })
  }
})

test("diagnostic dump ingest streams payload to disk and writes metadata", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "veslo-den-diagnostic-dumps-"))
  const createdAt = new Date("2026-07-14T15:00:00.000Z")
  const server = await startServer({
    ingestToken: "ingest-token",
    rootDir,
    now: () => createdAt,
    randomId: () => "test-dump",
  })
  const body = Buffer.from("ahoj\n".repeat(8), "utf8")

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/internal/diagnostic-dumps`, {
      method: "POST",
      headers: {
        Authorization: "Bearer ingest-token",
        "Content-Type": "application/x-ndjson",
        "Content-Encoding": "gzip",
        "x-veslo-dump-kind": "send-workflow-trace",
        "x-veslo-dump-source": "dev-helper",
        "x-veslo-dump-filename": "send-workflow-trace.cloud.ndjson.gz",
      },
      body,
    })

    assert.equal(response.status, 202)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.dump.id, "ddump_test-dump")
    assert.equal(payload.dump.bytes, body.length)
    assert.equal(payload.dump.sha256, createHash("sha256").update(body).digest("hex"))
    assert.match(payload.dump.storagePath, /ddump_test-dump-send-workflow-trace-dev-helper\.gz$/)

    assert.deepEqual(await readFile(payload.dump.storagePath), body)
    const metadata = JSON.parse(await readFile(payload.dump.metadataPath, "utf8"))
    assert.equal(metadata.originalFilename, "send-workflow-trace.cloud.ndjson.gz")
    assert.equal(metadata.contentEncoding, "gzip")
  } finally {
    await server.close()
    await rm(rootDir, { recursive: true, force: true })
  }
})

test("diagnostic dump ingest rejects oversized payloads and removes partial files", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "veslo-den-diagnostic-dumps-"))
  const server = await startServer({
    ingestToken: "ingest-token",
    rootDir,
    maxBytes: 4,
    now: () => new Date("2026-07-14T15:00:00.000Z"),
    randomId: () => "too-large",
  })

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/internal/diagnostic-dumps`, {
      method: "POST",
      headers: { Authorization: "Bearer ingest-token" },
      body: "too large",
    })

    assert.equal(response.status, 413)
    assert.equal((await response.json()).error, "diagnostic_dump_too_large")
    const dayEntries = await readdir(join(rootDir, "2026-07-14")).catch(() => [])
    assert.deepEqual(dayEntries, [])
  } finally {
    await server.close()
    await rm(rootDir, { recursive: true, force: true })
  }
})

test("desktop diagnostic dump rejects requests without an explicit organization header", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "veslo-den-desktop-diagnostic-dumps-"))
  let authorizeCalled = false
  const server = await startDesktopServer({
    rootDir,
    authorize: async () => {
      authorizeCalled = true
      return null
    },
  })

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/desktop-diagnostic-dumps`, {
      method: "POST",
      headers: { Authorization: "Bearer user-token" },
      body: "hello",
    })

    assert.equal(response.status, 400)
    assert.equal((await response.json()).error, "diagnostic_dump_missing_org")
    assert.equal(authorizeCalled, false)
  } finally {
    await server.close()
    await rm(rootDir, { recursive: true, force: true })
  }
})

test("desktop diagnostic dump streams payload using signed-in user organization context", async () => {
  const rootDir = await mkdtemp(join(tmpdir(), "veslo-den-desktop-diagnostic-dumps-"))
  const createdAt = new Date("2026-07-14T16:30:00.000Z")
  const server = await startDesktopServer({
    rootDir,
    now: () => createdAt,
    randomId: () => "desktop-dump",
    authorize: async (_req, _res, input) => ({
      session: {
        user: {
          id: "user_1",
          email: "dev@example.test",
          emailVerified: true,
          name: "Dev User",
        },
      },
      organization: {
        id: input.orgId,
        name: "Org",
        slug: "org",
        ownerUserId: "user_1",
      },
      membershipId: "member_1",
      orgRole: "member",
      isPlatformAdmin: false,
    }),
  })
  const body = Buffer.from("trace-line\n".repeat(4), "utf8")

  try {
    const response = await fetch(`http://127.0.0.1:${server.port}/v1/desktop-diagnostic-dumps`, {
      method: "POST",
      headers: {
        Authorization: "Bearer user-token",
        "Content-Type": "application/x-ndjson",
        "Content-Encoding": "gzip",
        "x-veslo-org-id": "org_1",
        "x-veslo-dump-kind": "send-workflow-trace",
        "x-veslo-dump-source": "dev-helper",
        "x-veslo-dump-filename": "send-workflow-trace.cloud.ndjson.gz",
        "x-veslo-dump-workspace-id": "workspace_1",
      },
      body,
    })

    assert.equal(response.status, 202)
    const payload = await response.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.dump.id, "ddump_desktop-dump")
    assert.equal(payload.dump.authMode, "desktop")
    assert.equal(payload.dump.userId, "user_1")
    assert.equal(payload.dump.orgId, "org_1")
    assert.equal(payload.dump.workspaceId, "workspace_1")
    assert.equal(payload.dump.bytes, body.length)
    assert.equal(payload.dump.sha256, createHash("sha256").update(body).digest("hex"))
    assert.match(
      payload.dump.storagePath,
      /desktop[\\/]+org_1[\\/]+user_1[\\/]+2026-07-14[\\/]+ddump_desktop-dump-send-workflow-trace-dev-helper\.gz$/,
    )

    assert.deepEqual(await readFile(payload.dump.storagePath), body)
    const metadata = JSON.parse(await readFile(payload.dump.metadataPath, "utf8"))
    assert.equal(metadata.authMode, "desktop")
    assert.equal(metadata.membershipId, "member_1")
    assert.equal(metadata.orgRole, "member")
  } finally {
    await server.close()
    await rm(rootDir, { recursive: true, force: true })
  }
})
