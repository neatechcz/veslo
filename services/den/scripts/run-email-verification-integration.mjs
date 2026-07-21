import { spawn } from "node:child_process"
import { randomUUID } from "node:crypto"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const denDir = resolve(scriptDir, "..")
const repoRoot = resolve(denDir, "../..")
const composeFile = join(repoRoot, "packaging/docker/docker-compose.dev.yml")
const fetchPreload = join(denDir, "test/fixtures/lettr-fetch-capture.mjs")
const mode = parseMode(process.argv.slice(2))
const runId = randomUUID().replaceAll("-", "").slice(0, 16)
const composeProject = `veslo-den-email-verification-${runId}`
const tempRoot = await mkdtemp(join(tmpdir(), "veslo-den-email-verification-"))
const composeOverride = join(tempRoot, "compose.acceptance.yml")
const ownedChildren = new Set()

let captureFixture
let denChild
let teardownPromise
let interruptedSignal = null

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.once(signal, () => {
    interruptedSignal = signal
    void teardown().finally(() => {
      process.exit(signalExitCode(signal))
    })
  })
}

try {
  await assertCommandAvailable("docker", ["compose", "version"])
  await writeFile(composeOverride, [
    "services:",
    "  den-db:",
    "    command: [\"--log-bin-trust-function-creators=1\"]",
    "    ports:",
    "      - \"127.0.0.1::3306\"",
    "volumes:",
    "  ai-gateway-db-data:",
    `    name: ${composeProject}-ai-gateway-db-data`,
    "  den-db-data:",
    `    name: ${composeProject}-den-db-data`,
    "  pnpm-store:",
    `    name: ${composeProject}-pnpm-store`,
    "  bun-install:",
    `    name: ${composeProject}-bun-install`,
    "",
  ].join("\n"), "utf8")

  console.log(`[email-verification-acceptance] starting isolated database project ${composeProject}`)
  await runOwned("docker", composeArgs("up", "-d", "--wait", "den-db"), {
    cwd: repoRoot,
    env: sanitizedEnvironment(),
  })

  const publishedDatabasePort = (await captureOwned(
    "docker",
    composeArgs("port", "den-db", "3306"),
    { cwd: repoRoot, env: sanitizedEnvironment() },
  )).trim()
  const databasePort = parsePublishedPort(publishedDatabasePort)
  const databaseUrl = `mysql://den:den@127.0.0.1:${databasePort}/den`

  console.log("[email-verification-acceptance] applying DEN migrations")
  await runOwned("pnpm", ["--dir", denDir, "db:migrate"], {
    cwd: repoRoot,
    env: { ...sanitizedEnvironment(), DATABASE_URL: databaseUrl },
  })

  captureFixture = await startLettrCaptureFixture()
  const denPort = await reserveLoopbackPort()
  const denBaseUrl = `http://127.0.0.1:${denPort}`
  const fixtureEnvironment = {
    ...sanitizedEnvironment(),
    NODE_ENV: "production",
    PORT: String(denPort),
    DATABASE_URL: databaseUrl,
    BETTER_AUTH_SECRET: "veslo_email_verification_acceptance_secret_32_chars",
    BETTER_AUTH_URL: denBaseUrl,
    CORS_ORIGINS: `${denBaseUrl},https://app.veslo.test`,
    DESKTOP_AUTH_REQUIRE_EMAIL_VERIFIED: "true",
    LETTR_API_KEY: "test-only-not-a-real-lettr-key",
    AUTH_EMAIL_ADDRESS: "acceptance@veslo.test",
    AUTH_EMAIL_FROM_NAME: "Veslo Acceptance",
    PROVISIONER_MODE: "stub",
    VESLO_TEST_DEN_BASE_URL: denBaseUrl,
    VESLO_TEST_DEN_DATABASE_URL: databaseUrl,
    VESLO_TEST_EMAIL_CAPTURE_URL: captureFixture.origin,
  }

  console.log(`[email-verification-acceptance] launching DEN on ${denBaseUrl}`)
  denChild = spawnOwned(
    process.execPath,
    ["--import=tsx", `--import=${fetchPreload}`, join(denDir, "src/index.ts")],
    { cwd: denDir, env: fixtureEnvironment, stdio: ["ignore", "pipe", "pipe"] },
  )
  forwardOutput(denChild.stdout, "den")
  forwardOutput(denChild.stderr, "den")
  await waitForHealthyDen(denBaseUrl, denChild)

  console.log(`[email-verification-acceptance] running ${mode} acceptance against actual DEN HTTP server`)
  if (mode === "integration") {
    await runOwned(
      "pnpm",
      ["--dir", denDir, "exec", "tsx", "--test", "test/auth-email-verification.integration.test.ts"],
      { cwd: repoRoot, env: fixtureEnvironment },
    )
  } else {
    await runOwned(
      "pnpm",
      [
        "--filter",
        "@neatech/veslo-e2e",
        "exec",
        "playwright",
        "test",
        "./specs/den-email-verification.playwright.spec.ts",
        "--workers=1",
        `--output=${join(tempRoot, "playwright-results")}`,
      ],
      { cwd: repoRoot, env: fixtureEnvironment },
    )
  }
} finally {
  await teardown()
}

async function teardown() {
  if (teardownPromise) return teardownPromise
  teardownPromise = (async () => {
    for (const child of [...ownedChildren]) {
      await terminateOwnedChild(child)
    }
    if (captureFixture) {
      await captureFixture.close()
      captureFixture = undefined
    }

    await runOwned(
      "docker",
      composeArgs("down", "--volumes", "--remove-orphans"),
      { cwd: repoRoot, env: sanitizedEnvironment(), allowFailure: true },
    ).catch(() => {})

    await rm(tempRoot, { recursive: true, force: true })
  })()
  return teardownPromise
}

function composeArgs(...args) {
  return ["compose", "-p", composeProject, "-f", composeFile, "-f", composeOverride, ...args]
}

function sanitizedEnvironment() {
  const environment = { ...process.env }
  delete environment.LETTR_API_KEY
  delete environment.AUTH_EMAIL_ADDRESS
  delete environment.VESLO_TEST_EMAIL_CAPTURE_URL
  delete environment.VESLO_TEST_DEN_BASE_URL
  delete environment.VESLO_TEST_DEN_DATABASE_URL
  return environment
}

async function startLettrCaptureFixture() {
  const messages = []
  let acceptDeliveries = true
  let rejectedRecipients = new Set()
  const server = createServer(async (req, res) => {
    try {
      const requestUrl = new URL(req.url ?? "/", "http://127.0.0.1")
      if (req.method === "GET" && requestUrl.pathname === "/messages") {
        sendJson(res, 200, messages)
        return
      }

      if (req.method === "POST" && requestUrl.pathname === "/control") {
        const body = await readJsonBody(req)
        if (typeof body.accept !== "boolean" || (body.rejectRecipients !== undefined && !Array.isArray(body.rejectRecipients))) {
          sendJson(res, 400, { error: "invalid_control" })
          return
        }
        acceptDeliveries = body.accept
        rejectedRecipients = new Set(
          (body.rejectRecipients ?? []).filter((value) => typeof value === "string"),
        )
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method === "POST" && requestUrl.pathname === "/api/emails") {
        const body = await readJsonBody(req)
        const to = Array.isArray(body.to) && typeof body.to[0] === "string" ? body.to[0] : ""
        if (!acceptDeliveries || rejectedRecipients.has(to)) {
          sendJson(res, 503, { error: "capture_delivery_rejected" })
          return
        }

        const subject = typeof body.subject === "string" ? body.subject : ""
        const verificationUrl = extractVerificationUrl(body.text)
        if (!to || !subject || !verificationUrl) {
          sendJson(res, 400, { error: "invalid_email_payload" })
          return
        }

        messages.push({ to, subject, verificationUrl })
        sendJson(res, 202, { id: `capture-${messages.length}` })
        return
      }

      sendJson(res, 404, { error: "not_found" })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      sendJson(res, 400, { error: message })
    }
  })

  await listenLoopback(server)
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("capture fixture did not bind a TCP port")
  const origin = `http://127.0.0.1:${address.port}`
  return {
    origin,
    close: () => new Promise((resolveClose, rejectClose) => {
      server.close((error) => error ? rejectClose(error) : resolveClose())
      server.closeAllConnections?.()
    }),
  }
}

function extractVerificationUrl(text) {
  if (typeof text !== "string") return ""
  const match = text.match(/https?:\/\/[^\s]+/)
  return match?.[0] ?? ""
}

function sendJson(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" })
  res.end(JSON.stringify(body))
}

async function readJsonBody(req) {
  let raw = ""
  for await (const chunk of req) {
    raw += Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk)
    if (raw.length > 1_000_000) throw new Error("request_too_large")
  }
  return raw ? JSON.parse(raw) : {}
}

async function reserveLoopbackPort() {
  const server = createServer()
  await listenLoopback(server)
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("failed to reserve a loopback port")
  const port = address.port
  await new Promise((resolveClose, rejectClose) => server.close((error) => error ? rejectClose(error) : resolveClose()))
  return port
}

function listenLoopback(server) {
  return new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen)
    server.listen(0, "127.0.0.1", () => {
      server.off("error", rejectListen)
      resolveListen()
    })
  })
}

async function waitForHealthyDen(baseUrl, child) {
  const deadline = Date.now() + 90_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`DEN exited before becoming healthy (exit ${child.exitCode})`)
    }
    try {
      const response = await fetch(`${baseUrl}/health`)
      if (response.ok) return
    } catch {
      // The real DEN process is still bootstrapping its schema.
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250))
  }
  throw new Error(`DEN did not become healthy at ${baseUrl}/health`)
}

function parsePublishedPort(value) {
  const match = value.match(/:(\d+)$/)
  if (!match) throw new Error(`Could not parse published MySQL port from: ${value}`)
  return Number(match[1])
}

function parseMode(args) {
  if (args.length !== 1 || !["--integration", "--browser"].includes(args[0])) {
    throw new Error("Usage: run-email-verification-integration.mjs --integration|--browser")
  }
  return args[0].slice(2)
}

async function assertCommandAvailable(command, args) {
  await captureOwned(command, args, { cwd: repoRoot, env: sanitizedEnvironment() })
}

async function captureOwned(command, args, options) {
  const child = spawnOwned(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  child.stdout?.on("data", (chunk) => { stdout += chunk.toString() })
  child.stderr?.on("data", (chunk) => { stderr += chunk.toString() })
  const code = await waitForChild(child)
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed (${code}): ${stderr.trim()}`)
  return stdout
}

async function runOwned(command, args, options) {
  const { allowFailure = false, ...spawnOptions } = options
  const child = spawnOwned(command, args, { ...spawnOptions, stdio: spawnOptions.stdio ?? "inherit" })
  const code = await waitForChild(child)
  if (code !== 0 && !allowFailure && !interruptedSignal) {
    throw new Error(`${command} ${args.join(" ")} failed with exit code ${code}`)
  }
  return code
}

function spawnOwned(command, args, options) {
  const child = spawn(command, args, {
    ...options,
    shell: false,
    detached: process.platform !== "win32",
  })
  ownedChildren.add(child)
  child.once("exit", () => ownedChildren.delete(child))
  return child
}

function waitForChild(child) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode)
  return new Promise((resolveExit, rejectExit) => {
    child.once("error", rejectExit)
    child.once("exit", (code, signal) => resolveExit(code ?? signalExitCode(signal)))
  })
}

async function terminateOwnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return
  signalOwnedChild(child, "SIGTERM")
  const exited = await Promise.race([
    waitForChild(child).then(() => true),
    new Promise((resolveWait) => setTimeout(() => resolveWait(false), 5_000)),
  ])
  if (!exited) {
    signalOwnedChild(child, "SIGKILL")
    await waitForChild(child).catch(() => {})
  }
}

function signalOwnedChild(child, signal) {
  if (!child.pid) return
  try {
    if (process.platform === "win32") child.kill(signal)
    else process.kill(-child.pid, signal)
  } catch (error) {
    if (error?.code !== "ESRCH") throw error
  }
}

function forwardOutput(stream, label) {
  stream?.on("data", (chunk) => {
    for (const line of chunk.toString().split(/\r?\n/)) {
      if (line) process.stderr.write(`[${label}] ${line}\n`)
    }
  })
}

function signalExitCode(signal) {
  return signal === "SIGHUP" ? 129 : signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 1
}
