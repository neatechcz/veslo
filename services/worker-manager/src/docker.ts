import http from "node:http"
import { setTimeout as sleep } from "node:timers/promises"

export type WorkerStatus = "provisioning" | "healthy"

export type WorkerRecord = {
  id: string
  provider: "owned-server"
  url: string
  status: WorkerStatus
  containerName: string
  dockerState?: string
  health?: {
    ok: boolean
  }
}

export type CreateWorkerInput = {
  workerId: string
  name: string
  hostToken: string
  clientToken: string
  publicDomainSuffix: string
  image: string
}

export type WorkerDockerAdapter = {
  ensureWorker(input: CreateWorkerInput): Promise<WorkerRecord>
  getWorker(workerId: string): Promise<WorkerRecord | null>
  deleteWorker(workerId: string): Promise<void>
}

export type DockerWorkerAdapterConfig = {
  socketPath: string
  publicDomainSuffix: string
  workerImage: string
  networkName: string
  provisionTimeoutMs: number
  pollIntervalMs: number
  healthcheckTimeoutMs: number
  memoryBytes?: number
  nanoCpus?: number
}

type DockerInspectResponse = {
  Id: string
  Name?: string
  State?: {
    Running?: boolean
    Status?: string
  }
}

export type DockerCreateContainerPayload = {
  Image: string
  Env: string[]
  Labels: Record<string, string>
  Cmd: string[]
  ExposedPorts: Record<string, Record<string, never>>
  HostConfig: {
    Binds: string[]
    Init: boolean
    NetworkMode: string
    RestartPolicy: {
      Name: "unless-stopped"
    }
    Memory?: number
    NanoCpus?: number
  }
}

export function workerContainerName(workerId: string) {
  return `veslo-worker-${workerId}`
}

export function workerVolumeName(workerId: string) {
  return `veslo-worker-${workerId}-workspace`
}

export function publicWorkerUrl(workerId: string, publicDomainSuffix: string) {
  return `https://${workerId}.${publicDomainSuffix.replace(/^\.+|\.+$/g, "")}`
}

export function assertSafeWorkerId(workerId: string) {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/.test(workerId)) {
    throw new Error("workerId contains unsupported characters")
  }
}

function workerLabels(input: { workerId: string; name: string }) {
  return {
    "veslo.role": "worker",
    "veslo.managed-by": "worker-manager",
    "veslo.worker-id": input.workerId,
    "veslo.worker-name": input.name,
  }
}

export function buildWorkerContainerCreatePayload(input: {
  workerId: string
  name: string
  hostToken: string
  clientToken: string
  image: string
  networkName: string
  memoryBytes?: number
  nanoCpus?: number
}): DockerCreateContainerPayload {
  assertSafeWorkerId(input.workerId)

  const payload: DockerCreateContainerPayload = {
    Image: input.image,
    Env: [
      "NODE_ENV=production",
      `VESLO_TOKEN=${input.clientToken}`,
      `VESLO_HOST_TOKEN=${input.hostToken}`,
      `DEN_WORKER_ID=${input.workerId}`,
    ],
    Labels: workerLabels(input),
    Cmd: [
      "sh",
      "-lc",
      [
        "mkdir -p /workspace",
        "if ! command -v veslo >/dev/null 2>&1; then echo 'No orchestrator CLI found (veslo)' >&2; exit 1; fi",
        "veslo serve --workspace /workspace --veslo-host 0.0.0.0 --veslo-port 8787 --opencode-host 127.0.0.1 --opencode-port 4096 --connect-host 127.0.0.1 --cors '*' --approval manual --allow-external --veslo-server-bin /app/packages/server/dist/cli.js --no-veslo-code-router --verbose",
      ].join(" && "),
    ],
    ExposedPorts: {
      "8787/tcp": {},
    },
    HostConfig: {
      Binds: [`${workerVolumeName(input.workerId)}:/workspace`],
      Init: true,
      NetworkMode: input.networkName,
      RestartPolicy: {
        Name: "unless-stopped",
      },
    },
  }

  if (input.memoryBytes) {
    payload.HostConfig.Memory = input.memoryBytes
  }
  if (input.nanoCpus) {
    payload.HostConfig.NanoCpus = input.nanoCpus
  }

  return payload
}

export class DockerWorkerAdapter implements WorkerDockerAdapter {
  constructor(private readonly config: DockerWorkerAdapterConfig) {}

  async ensureWorker(input: CreateWorkerInput): Promise<WorkerRecord> {
    assertSafeWorkerId(input.workerId)

    const existing = await this.inspectWorker(input.workerId)
    if (!existing) {
      await this.ensureVolume(input.workerId, input.name)
      await this.createWorkerContainer(input)
    }

    await this.startWorker(input.workerId)
    return this.waitForHealthyWorker(input.workerId, input.publicDomainSuffix)
  }

  async getWorker(workerId: string): Promise<WorkerRecord | null> {
    assertSafeWorkerId(workerId)
    const inspect = await this.inspectWorker(workerId)
    if (!inspect) {
      return null
    }

    const running = inspect.State?.Running === true
    const health = running ? await this.probeWorkerHealth(workerContainerName(workerId)) : false
    return this.toWorkerRecord(workerId, inspect, health)
  }

  async deleteWorker(workerId: string): Promise<void> {
    assertSafeWorkerId(workerId)
    const inspect = await this.inspectWorker(workerId)
    if (inspect) {
      await this.dockerRequest("POST", `/containers/${encodeURIComponent(inspect.Id)}/stop?t=10`, undefined, [204, 304, 404])
      await this.dockerRequest("DELETE", `/containers/${encodeURIComponent(inspect.Id)}?force=true&v=false`, undefined, [204, 404])
    }

    await this.dockerRequest("DELETE", `/volumes/${encodeURIComponent(workerVolumeName(workerId))}?force=true`, undefined, [204, 404])
  }

  private async waitForHealthyWorker(workerId: string, publicDomainSuffix: string): Promise<WorkerRecord> {
    const startedAt = Date.now()
    let latest: WorkerRecord | null = null

    while (Date.now() - startedAt < this.config.provisionTimeoutMs) {
      const inspect = await this.inspectWorker(workerId)
      if (!inspect) {
        throw new Error(`worker container ${workerContainerName(workerId)} was not created`)
      }

      const running = inspect.State?.Running === true
      const health = running ? await this.probeWorkerHealth(workerContainerName(workerId)) : false
      latest = this.toWorkerRecord(workerId, inspect, health, publicDomainSuffix)
      if (latest.status === "healthy") {
        return latest
      }

      await sleep(this.config.pollIntervalMs)
    }

    throw new Error(`Timed out waiting for worker health for ${workerId}; last state=${latest?.dockerState ?? "unknown"}`)
  }

  private async ensureVolume(workerId: string, name: string) {
    await this.dockerRequest("POST", "/volumes/create", {
      Name: workerVolumeName(workerId),
      Labels: workerLabels({ workerId, name }),
    }, [200, 201])
  }

  private async createWorkerContainer(input: CreateWorkerInput) {
    const payload = buildWorkerContainerCreatePayload({
      workerId: input.workerId,
      name: input.name,
      hostToken: input.hostToken,
      clientToken: input.clientToken,
      image: input.image,
      networkName: this.config.networkName,
      memoryBytes: this.config.memoryBytes,
      nanoCpus: this.config.nanoCpus,
    })

    const query = new URLSearchParams({ name: workerContainerName(input.workerId) })
    await this.dockerRequest("POST", `/containers/create?${query.toString()}`, payload, [201, 409])
  }

  private async startWorker(workerId: string) {
    await this.dockerRequest("POST", `/containers/${encodeURIComponent(workerContainerName(workerId))}/start`, undefined, [204, 304])
  }

  private async inspectWorker(workerId: string): Promise<DockerInspectResponse | null> {
    const response = await this.dockerRequest<DockerInspectResponse>(
      "GET",
      `/containers/${encodeURIComponent(workerContainerName(workerId))}/json`,
      undefined,
      [200, 404],
    )
    return response.status === 404 ? null : response.json
  }

  private toWorkerRecord(
    workerId: string,
    inspect: DockerInspectResponse,
    healthOk: boolean,
    publicDomainSuffix = this.config.publicDomainSuffix,
  ): WorkerRecord {
    const dockerState = inspect.State?.Status ?? "unknown"
    const running = inspect.State?.Running === true
    const status: WorkerStatus = running && healthOk ? "healthy" : "provisioning"

    return {
      id: workerId,
      provider: "owned-server",
      url: publicWorkerUrl(workerId, publicDomainSuffix),
      status,
      containerName: workerContainerName(workerId),
      dockerState,
      health: {
        ok: healthOk,
      },
    }
  }

  private async probeWorkerHealth(containerName: string): Promise<boolean> {
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), this.config.healthcheckTimeoutMs)
    try {
      const response = await fetch(`http://${containerName}:8787/health`, {
        method: "GET",
        signal: controller.signal,
      })
      return response.ok
    } catch {
      return false
    } finally {
      clearTimeout(timeout)
    }
  }

  private async dockerRequest<T>(
    method: string,
    path: string,
    body: unknown,
    acceptedStatuses: number[],
  ): Promise<{ status: number; json: T; text: string }> {
    const payload = body === undefined ? undefined : JSON.stringify(body)

    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          socketPath: this.config.socketPath,
          path,
          method,
          headers: {
            Host: "docker",
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
          },
        },
        (response) => {
          const chunks: Uint8Array[] = []
          response.on("data", (chunk: Uint8Array) => chunks.push(chunk))
          response.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8")
            const status = response.statusCode ?? 0
            if (!acceptedStatuses.includes(status)) {
              reject(new Error(`Docker ${method} ${path} failed (${status}): ${text.slice(0, 400)}`))
              return
            }

            let json: unknown = null
            if (text.trim()) {
              try {
                json = JSON.parse(text)
              } catch {
                json = null
              }
            }

            resolve({ status, json: json as T, text })
          })
        },
      )

      request.on("error", reject)
      if (payload) {
        request.write(payload)
      }
      request.end()
    })
  }
}
