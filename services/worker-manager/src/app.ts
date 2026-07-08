import express from "express"
import http from "node:http"
import { z } from "zod"
import { DockerWorkerAdapter, type DockerWorkerAdapterConfig, type WorkerDockerAdapter } from "./docker.js"

type WorkerManagerConfig = {
  token: string
  publicDomainSuffix: string
  workerImage: string
  port?: number
  dockerSocketPath?: string
  dockerNetworkName?: string
  provisionTimeoutMs?: number
  pollIntervalMs?: number
  healthcheckTimeoutMs?: number
  memoryBytes?: number
  nanoCpus?: number
}

export type ResolvedWorkerManagerConfig = {
  token: string
  publicDomainSuffix: string
  workerImage: string
  port: number
  dockerSocketPath: string
  dockerNetworkName: string
  provisionTimeoutMs: number
  pollIntervalMs: number
  healthcheckTimeoutMs: number
  memoryBytes?: number
  nanoCpus?: number
}

type CreateWorkerManagerAppOptions = {
  config: WorkerManagerConfig
  docker: WorkerDockerAdapter
}

const createWorkerSchema = z.object({
  workerId: z.string().min(1),
  name: z.string().min(1),
  hostToken: z.string().min(1),
  clientToken: z.string().min(1),
  publicDomainSuffix: z.string().min(1).optional(),
  image: z.string().min(1).optional(),
})

function normalizeDomain(value: string) {
  return value.trim().toLowerCase().replace(/^\.+|\.+$/g, "")
}

function parsePositiveNumber(raw: string | undefined, fallback: number, label: string) {
  const parsed = Number(raw ?? String(fallback))
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive number`)
  }
  return parsed
}

function parseOptionalPositiveInteger(raw: string | undefined, label: string) {
  if (!raw?.trim()) {
    return undefined
  }

  const parsed = Number(raw)
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`)
  }
  return parsed
}

function parseOptionalNanoCpus(raw: string | undefined) {
  if (!raw?.trim()) {
    return undefined
  }

  const parsed = Number(raw)
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("WORKER_RESOURCE_CPUS must be a positive number")
  }

  return Math.round(parsed * 1_000_000_000)
}

function isAuthorized(header: string | undefined, token: string) {
  return header === `Bearer ${token}`
}

export function resolveWorkerIdFromHost(host: string | undefined, publicDomainSuffix: string) {
  const normalizedHost = normalizeDomain((host ?? "").split(":")[0] ?? "")
  const suffix = normalizeDomain(publicDomainSuffix)
  const suffixWithDot = `.${suffix}`

  if (!normalizedHost.endsWith(suffixWithDot)) {
    return null
  }

  const workerId = normalizedHost.slice(0, -suffixWithDot.length)
  if (!workerId || workerId.includes(".")) {
    return null
  }

  return workerId
}

export function readWorkerManagerConfig(input: NodeJS.ProcessEnv = process.env): ResolvedWorkerManagerConfig {
  const token = input.OWNED_WORKER_MANAGER_TOKEN?.trim() || input.WORKER_MANAGER_TOKEN?.trim()
  if (!token) {
    throw new Error("OWNED_WORKER_MANAGER_TOKEN is required")
  }

  const config: ResolvedWorkerManagerConfig = {
    token,
    publicDomainSuffix: normalizeDomain(input.OWNED_WORKER_PUBLIC_DOMAIN_SUFFIX || input.WORKER_PUBLIC_DOMAIN_SUFFIX || "workers.veslo.work"),
    workerImage: input.WORKER_IMAGE?.trim() || "veslo-owned-server-worker-runtime:local",
    port: parsePositiveNumber(input.PORT || input.WORKER_MANAGER_PORT, 8790, "PORT"),
    dockerSocketPath: input.DOCKER_SOCKET_PATH?.trim() || "/var/run/docker.sock",
    dockerNetworkName: input.WORKER_DOCKER_NETWORK?.trim() || "veslo-owned-server-runtime",
    provisionTimeoutMs: parsePositiveNumber(input.WORKER_PROVISION_TIMEOUT_MS, 180_000, "WORKER_PROVISION_TIMEOUT_MS"),
    pollIntervalMs: parsePositiveNumber(input.WORKER_POLL_INTERVAL_MS, 2_000, "WORKER_POLL_INTERVAL_MS"),
    healthcheckTimeoutMs: parsePositiveNumber(input.WORKER_HEALTHCHECK_TIMEOUT_MS, 2_000, "WORKER_HEALTHCHECK_TIMEOUT_MS"),
  }

  const memoryBytes = parseOptionalPositiveInteger(input.WORKER_RESOURCE_MEMORY_BYTES, "WORKER_RESOURCE_MEMORY_BYTES")
  if (memoryBytes !== undefined) {
    config.memoryBytes = memoryBytes
  }

  const nanoCpus = parseOptionalNanoCpus(input.WORKER_RESOURCE_CPUS)
  if (nanoCpus !== undefined) {
    config.nanoCpus = nanoCpus
  }

  return config
}

export function createDefaultDockerAdapter(config: ResolvedWorkerManagerConfig) {
  const dockerConfig: DockerWorkerAdapterConfig = {
    socketPath: config.dockerSocketPath,
    publicDomainSuffix: config.publicDomainSuffix,
    workerImage: config.workerImage,
    networkName: config.dockerNetworkName,
    provisionTimeoutMs: config.provisionTimeoutMs,
    pollIntervalMs: config.pollIntervalMs,
    healthcheckTimeoutMs: config.healthcheckTimeoutMs,
  }

  if (config.memoryBytes !== undefined) {
    dockerConfig.memoryBytes = config.memoryBytes
  }
  if (config.nanoCpus !== undefined) {
    dockerConfig.nanoCpus = config.nanoCpus
  }

  return new DockerWorkerAdapter(dockerConfig)
}

export function createWorkerManagerApp(options: CreateWorkerManagerAppOptions): express.Express {
  const app = express()
  const config = {
    ...options.config,
    publicDomainSuffix: normalizeDomain(options.config.publicDomainSuffix),
  }

  app.disable("x-powered-by")

  app.get("/health", (_req, res) => {
    res.json({ ok: true })
  })

  app.get("/tls/ask", (req, res) => {
    const domain = typeof req.query.domain === "string" ? req.query.domain : ""
    if (resolveWorkerIdFromHost(domain, config.publicDomainSuffix)) {
      res.status(200).send("ok")
      return
    }

    res.status(403).send("forbidden")
  })

  app.use("/workers", express.json({ limit: "1mb" }))

  app.use("/workers", (req, res, next) => {
    if (!isAuthorized(req.header("authorization"), config.token)) {
      res.status(401).json({ error: "unauthorized" })
      return
    }
    next()
  })

  app.post("/workers", async (req, res, next) => {
    try {
      const parsed = createWorkerSchema.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: "invalid_request", details: parsed.error.flatten() })
        return
      }

      const publicDomainSuffix = normalizeDomain(parsed.data.publicDomainSuffix ?? config.publicDomainSuffix)
      const worker = await options.docker.ensureWorker({
        workerId: parsed.data.workerId,
        name: parsed.data.name,
        hostToken: parsed.data.hostToken,
        clientToken: parsed.data.clientToken,
        publicDomainSuffix,
        image: parsed.data.image ?? config.workerImage,
      })

      res.json({ worker })
    } catch (error) {
      next(error)
    }
  })

  app.get("/workers/:id", async (req, res, next) => {
    try {
      const worker = await options.docker.getWorker(req.params.id)
      if (!worker) {
        res.status(404).json({ error: "worker_not_found" })
        return
      }

      res.json({ worker })
    } catch (error) {
      next(error)
    }
  })

  app.delete("/workers/:id", async (req, res, next) => {
    try {
      await options.docker.deleteWorker(req.params.id)
      res.status(204).end()
    } catch (error) {
      next(error)
    }
  })

  app.use(async (req, res, next) => {
    try {
      const workerId = resolveWorkerIdFromHost(req.header("host"), config.publicDomainSuffix)
      if (!workerId) {
        res.status(404).json({ error: "not_found" })
        return
      }

      const worker = await options.docker.getWorker(workerId)
      if (!worker) {
        res.status(404).json({ error: "worker_not_found" })
        return
      }

      proxyToWorker(req, res, worker.containerName)
    } catch (error) {
      next(error)
    }
  })

  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const message = error instanceof Error ? error.message : "internal_error"
    res.status(500).json({ error: "worker_manager_error", message })
  })

  return app
}

function proxyToWorker(req: express.Request, res: express.Response, containerName: string) {
  const upstream = http.request(
    {
      hostname: containerName,
      port: 8787,
      path: req.originalUrl,
      method: req.method,
      headers: {
        ...req.headers,
        host: `${containerName}:8787`,
      },
    },
    (upstreamResponse) => {
      res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers)
      upstreamResponse.pipe(res)
    },
  )

  upstream.on("error", () => {
    if (!res.headersSent) {
      res.status(502).json({ error: "worker_proxy_failed" })
    } else {
      res.end()
    }
  })

  req.pipe(upstream)
}
