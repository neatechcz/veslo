import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import http from "node:http"
import { tmpdir } from "node:os"
import path from "node:path"
import { once } from "node:events"
import test from "node:test"
import { fileURLToPath } from "node:url"

import {
  parseArgs,
  runCodexAuthUpload,
  validateCodexAuthJson,
} from "./codex-auth-upload.mjs"

const validAuthJson = JSON.stringify({
  auth_mode: "chatgpt",
  tokens: {
    id_token: "codex-id-token",
    access_token: "codex-access-token",
    refresh_token: "codex-refresh-token",
    account_id: "acct_codex_runtime",
  },
})

test("parseArgs reads upload target and credential metadata", () => {
  assert.deepEqual(
    parseArgs([
      "--upload-url",
      "https://admin.example.test/admin/api/credentials/codex-auth-upload/token",
      "--credential-id",
      "cred_1",
      "--credential-name",
      "Václav Codex",
      "--auth-json-path",
      "/tmp/auth.json",
      "--yes",
    ]),
    {
      uploadUrl: "https://admin.example.test/admin/api/credentials/codex-auth-upload/token",
      credentialId: "cred_1",
      credentialName: "Václav Codex",
      authJsonPath: "/tmp/auth.json",
      profileDir: "",
      yes: true,
      dryRun: false,
    },
  )
})

test("parseArgs allows a new credential upload without a credential id", () => {
  assert.deepEqual(
    parseArgs([
      "--upload-url",
      "https://admin.example.test/admin/api/credentials/codex-auth-upload/token",
      "--credential-name",
      "New Codex account",
      "--auth-json-path",
      "/tmp/auth.json",
      "--yes",
    ]),
    {
      uploadUrl: "https://admin.example.test/admin/api/credentials/codex-auth-upload/token",
      credentialId: "",
      credentialName: "New Codex account",
      authJsonPath: "/tmp/auth.json",
      profileDir: "",
      yes: true,
      dryRun: false,
    },
  )
})

test("validateCodexAuthJson rejects partial auth json", () => {
  assert.throws(
    () => validateCodexAuthJson(JSON.stringify({
      auth_mode: "chatgpt",
      tokens: {
        access_token: "codex-access-token",
        refresh_token: "codex-refresh-token",
      },
    })),
    /auth\.json is missing tokens\.id_token/,
  )
})

test("CLI rejects non-interactive confirmation without --yes", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "veslo-codex-auth-upload-non-interactive-"))
  const authJsonPath = path.join(tempDir, "auth.json")
  await writeFile(authJsonPath, validAuthJson, "utf8")

  let requestCount = 0
  const server = http.createServer((_req, res) => {
    requestCount += 1
    res.statusCode = 204
    res.end()
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")

  try {
    const { port } = server.address()
    const child = spawn(process.execPath, [
      fileURLToPath(new URL("./codex-auth-upload.mjs", import.meta.url)),
      "--upload-url",
      `http://127.0.0.1:${port}/upload-must-not-run`,
      "--credential-name",
      "Non-interactive Codex",
      "--auth-json-path",
      authJsonPath,
      "--dry-run",
    ], {
      stdio: ["ignore", "pipe", "pipe"],
    })

    let stderr = ""
    child.stderr.setEncoding("utf8")
    child.stderr.on("data", (chunk) => {
      stderr += chunk
    })
    const [exitCode] = await once(child, "exit")

    assert.equal(exitCode, 1)
    assert.match(stderr, /interactive terminal/i)
    assert.match(stderr, /--yes/)
    assert.equal(requestCount, 0)
  } finally {
    server.close()
    await once(server, "close")
    await rm(tempDir, { recursive: true, force: true })
  }
})

test("runCodexAuthUpload uploads auth json without printing token values", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "veslo-codex-auth-upload-"))
  const authJsonPath = path.join(tempDir, "auth.json")
  await writeFile(authJsonPath, validAuthJson, "utf8")

  let receivedPayload = null
  const server = http.createServer(async (req, res) => {
    assert.equal(req.method, "POST")
    assert.equal(req.url, "/upload-token")
    assert.equal(req.headers["content-type"], "application/json")

    const chunks = []
    req.on("data", (chunk) => chunks.push(chunk))
    await once(req, "end")
    receivedPayload = JSON.parse(Buffer.concat(chunks).toString("utf8"))

    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({
      ok: true,
      credentialId: "cred_platform_codex_1",
      credentialName: "Václav Codex",
      accountId: "acct_codex_runtime",
    }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")

  const output = []
  try {
    const { port } = server.address()
    const result = await runCodexAuthUpload(
      parseArgs([
        "--upload-url",
        `http://127.0.0.1:${port}/upload-token`,
        "--credential-id",
        "cred_platform_codex_1",
        "--credential-name",
        "Václav Codex",
        "--auth-json-path",
        authJsonPath,
        "--yes",
      ]),
      {
        stdout: (line) => output.push(line),
      },
    )

    assert.deepEqual(receivedPayload, { authJson: validAuthJson })
    assert.deepEqual(result, {
      ok: true,
      credentialId: "cred_platform_codex_1",
      credentialName: "Václav Codex",
      accountId: "acct_codex_runtime",
    })
    assert.match(output.join("\n"), /acct_codex_runtime/)
    assert.doesNotMatch(output.join("\n"), /codex-access-token/)
    assert.doesNotMatch(output.join("\n"), /codex-refresh-token/)
  } finally {
    server.close()
    await once(server, "close")
    await rm(tempDir, { recursive: true, force: true })
  }
})

test("runCodexAuthUpload can upload a new credential without a credential id", async () => {
  const tempDir = await mkdtemp(path.join(tmpdir(), "veslo-codex-auth-upload-new-"))
  const authJsonPath = path.join(tempDir, "auth.json")
  await writeFile(authJsonPath, validAuthJson, "utf8")

  const server = http.createServer(async (_req, res) => {
    res.statusCode = 200
    res.setHeader("content-type", "application/json")
    res.end(JSON.stringify({
      ok: true,
      credentialId: "cred_platform_codex_new",
      credentialName: "new.account@example.test Codex",
      accountId: "acct_codex_runtime",
    }))
  })
  server.listen(0, "127.0.0.1")
  await once(server, "listening")

  const output = []
  try {
    const { port } = server.address()
    const result = await runCodexAuthUpload(
      parseArgs([
        "--upload-url",
        `http://127.0.0.1:${port}/upload-token`,
        "--credential-name",
        "New Codex account",
        "--auth-json-path",
        authJsonPath,
        "--yes",
      ]),
      {
        stdout: (line) => output.push(line),
      },
    )

    assert.deepEqual(result, {
      ok: true,
      credentialId: "cred_platform_codex_new",
      credentialName: "new.account@example.test Codex",
      accountId: "acct_codex_runtime",
    })
    assert.match(output.join("\n"), /Credential: New Codex account/)
    assert.doesNotMatch(output.join("\n"), /\(\)/)
  } finally {
    server.close()
    await once(server, "close")
    await rm(tempDir, { recursive: true, force: true })
  }
})
