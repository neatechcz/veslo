import assert from "node:assert/strict"
import crypto from "node:crypto"
import test from "node:test"

type JsonObject = Record<string, unknown>

const baseUrl = (process.env.DEN_BASE_URL ?? "http://127.0.0.1:8788").replace(/\/+$/, "")
const redirectUri = "http://localhost:5173/auth/callback"
const codeVerifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
const codeChallenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
const requestTimeoutMs = 5000
const contractEnabled = (process.env.DEN_DESKTOP_AUTH_V2_CONTRACT ?? "").trim() === "1"

function jsonHeaders(extraHeaders: HeadersInit = {}): Headers {
  const headers = new Headers(extraHeaders)
  headers.set("content-type", "application/json")
  return headers
}

function requestSignal(signal?: AbortSignal): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(requestTimeoutMs)
  return signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal
}

async function requestJson(path: string, init: RequestInit = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: jsonHeaders(init.headers),
    signal: requestSignal(init.signal),
  })

  const rawBody = await response.text()
  let body: unknown = null
  if (rawBody.length > 0) {
    try {
      body = JSON.parse(rawBody)
    } catch {
      body = rawBody
    }
  }
  return { response, body }
}

async function postJson(path: string, body: JsonObject, init: RequestInit = {}) {
  return requestJson(path, {
    ...init,
    method: "POST",
    body: JSON.stringify(body),
  })
}

async function canReachDen(): Promise<boolean> {
  try {
    const response = await fetch(`${baseUrl}/health`, { signal: requestSignal() })
    return response.ok
  } catch {
    return false
  }
}

type ContractScenario = {
  transactionId: string | null
  code: string | null
  returnedState: string | null
  authState: string
}

const scenario: ContractScenario = {
  transactionId: null,
  code: null,
  returnedState: null,
  authState: `desktop-auth-v2-state-${crypto.randomUUID()}`,
}

const contractCases = [
  {
    name: "POST /v2/desktop-auth/start accepts PKCE + localhost redirect URI",
    run: async (scenarioState: ContractScenario) => {
      const { response, body } = await postJson("/v2/desktop-auth/start", {
        intent: "signin",
        redirectUri,
        state: scenarioState.authState,
        codeChallenge,
        codeChallengeMethod: "S256",
      })

      assert.equal(response.status, 201)
      assert.ok(body && typeof body === "object", "expected JSON response body")
      const payload = body as JsonObject
      assert.equal(typeof payload.transactionId, "string")
      assert.equal(typeof payload.authorizeUrl, "string")
      assert.equal(typeof payload.expiresAt, "string")
      assert.match(String(payload.authorizeUrl), /^https?:\/\//)
      scenarioState.transactionId = String(payload.transactionId)
    },
  },
  {
    name: "browser authorization completion creates a one-time code",
    run: async (scenarioState: ContractScenario) => {
      assert.ok(scenarioState.transactionId, "start response must provide a transactionId")
      const { response } = await postJson(
        "/v2/desktop-auth/authorize",
        {
          transactionId: scenarioState.transactionId,
          state: scenarioState.authState,
        },
        { redirect: "manual" },
      )

      assert.equal(response.status, 302)
      const locationHeader = response.headers.get("location")
      assert.ok(locationHeader, "manual redirect response must include Location")
      assert.equal(locationHeader.startsWith(`${redirectUri}?`), true)

      const location = new URL(locationHeader)
      const code = location.searchParams.get("code")
      const returnedState = location.searchParams.get("state")
      assert.ok(code, "authorize redirect must include one-time code")
      assert.equal(returnedState, scenarioState.authState)

      scenarioState.code = code
      scenarioState.returnedState = returnedState
    },
  },
  {
    name: "fallback polling/manual completion path returns same result",
    run: async (scenarioState: ContractScenario) => {
      assert.ok(scenarioState.transactionId, "start response must provide a transactionId")
      assert.ok(scenarioState.code, "authorize response must provide a one-time code")
      const { response, body } = await requestJson(
        `/v2/desktop-auth/status?transactionId=${encodeURIComponent(scenarioState.transactionId)}`,
      )

      assert.equal(response.status, 200)
      assert.ok(body && typeof body === "object", "expected JSON response body")
      const payload = body as JsonObject
      assert.equal(payload.status, "authorized")
      assert.equal(payload.transactionId, scenarioState.transactionId)
      assert.equal(payload.code, scenarioState.code)
      assert.equal(payload.state, scenarioState.returnedState)
    },
  },
  {
    name: "POST /v2/desktop-auth/exchange consumes code once",
    run: async (scenarioState: ContractScenario) => {
      assert.ok(scenarioState.code, "authorize response must provide a one-time code")
      const first = await postJson("/v2/desktop-auth/exchange", {
        code: scenarioState.code,
        codeVerifier,
      })

      assert.equal(first.response.status, 200)
      assert.ok(first.body && typeof first.body === "object", "expected JSON response body")
      const payload = first.body as JsonObject
      assert.equal(payload.tokenType, "Bearer")
      assert.equal(typeof payload.accessToken, "string")
      assert.equal(typeof payload.expiresIn, "number")
    },
  },
  {
    name: "replayed codes fail with deterministic error code",
    run: async (scenarioState: ContractScenario) => {
      assert.ok(scenarioState.code, "authorize response must provide a one-time code")
      const replay = await postJson("/v2/desktop-auth/exchange", {
        code: scenarioState.code,
        codeVerifier,
      })

      assert.equal(replay.response.status, 410)
      assert.ok(replay.body && typeof replay.body === "object", "expected JSON error body")
      const payload = replay.body as JsonObject
      assert.equal(payload.error, "code_already_consumed")
    },
  },
] as const

test("desktop auth v2 contract", async (t) => {
  if (!contractEnabled) {
    t.skip("Set DEN_DESKTOP_AUTH_V2_CONTRACT=1 to run this external contract suite.")
    return
  }

  if (!(await canReachDen())) {
    t.skip(`DEN_BASE_URL is not reachable: ${baseUrl}`)
    return
  }

  for (const contractCase of contractCases) {
    await contractCase.run(scenario)
  }
})
