import assert from "node:assert/strict"
import http from "node:http"
import test from "node:test"
import { createWorkerManagerApp, resolveWorkerIdFromHost } from "../src/app.js"
import { buildWorkerContainerCreatePayload, workerContainerName, workerVolumeName } from "../src/docker.js"
import type { WorkerDockerAdapter, WorkerRecord } from "../src/docker.js"

const workerId = "11111111-2222-3333-4444-555555555555"

function createRecord(overrides: Partial<WorkerRecord> = {}): WorkerRecord {
  return {
    id: workerId,
    provider: "owned-server",
    url: `https://${workerId}.workers.veslo.work`,
    status: "healthy",
    containerName: workerContainerName(workerId),
    dockerState: "running",
    health: { ok: true },
    ...overrides,
  }
}

async function withServer(
  app: http.RequestListener,
  fn: (baseUrl: string) => Promise<void>,
) {
  const server = http.createServer(app)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  assert.ok(address && typeof address === "object")

  try {
    await fn(`http://127.0.0.1:${address.port}`)
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) reject(error)
        else resolve()
      })
    })
  }
}

test("worker manager rejects internal API requests without bearer auth", async () => {
  const docker: WorkerDockerAdapter = {
    ensureWorker: async () => createRecord(),
    getWorker: async () => createRecord(),
    deleteWorker: async () => undefined,
  }
  const app = createWorkerManagerApp({
    docker,
    config: {
      token: "manager-token",
      publicDomainSuffix: "workers.veslo.work",
      workerImage: "veslo-owned-server-worker-runtime:local",
    },
  })

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/workers`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ workerId, name: "Owned", hostToken: "host", clientToken: "client" }),
    })

    assert.equal(response.status, 401)
  })
})

test("worker manager creates a worker and returns its owned-server URL", async () => {
  const calls: unknown[] = []
  const docker: WorkerDockerAdapter = {
    ensureWorker: async (input) => {
      calls.push(input)
      return createRecord()
    },
    getWorker: async () => createRecord(),
    deleteWorker: async () => undefined,
  }
  const app = createWorkerManagerApp({
    docker,
    config: {
      token: "manager-token",
      publicDomainSuffix: "workers.veslo.work",
      workerImage: "veslo-owned-server-worker-runtime:local",
    },
  })

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/workers`, {
      method: "POST",
      headers: {
        authorization: "Bearer manager-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ workerId, name: "Owned", hostToken: "host", clientToken: "client" }),
    })

    assert.equal(response.status, 200)
    assert.deepEqual(calls, [
      {
        workerId,
        name: "Owned",
        hostToken: "host",
        clientToken: "client",
        publicDomainSuffix: "workers.veslo.work",
        image: "veslo-owned-server-worker-runtime:local",
      },
    ])

    const body = (await response.json()) as { worker?: WorkerRecord }
    assert.equal(body.worker?.provider, "owned-server")
    assert.equal(body.worker?.url, `https://${workerId}.workers.veslo.work`)
    assert.equal(body.worker?.status, "healthy")
  })
})

test("worker manager deletes workers idempotently", async () => {
  const deleted: string[] = []
  const docker: WorkerDockerAdapter = {
    ensureWorker: async () => createRecord(),
    getWorker: async () => null,
    deleteWorker: async (id) => {
      deleted.push(id)
    },
  }
  const app = createWorkerManagerApp({
    docker,
    config: {
      token: "manager-token",
      publicDomainSuffix: "workers.veslo.work",
      workerImage: "veslo-owned-server-worker-runtime:local",
    },
  })

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/workers/${workerId}`, {
      method: "DELETE",
      headers: { authorization: "Bearer manager-token" },
    })

    assert.equal(response.status, 204)
    assert.deepEqual(deleted, [workerId])
  })
})

test("worker manager resolves worker ids from wildcard worker hosts", () => {
  assert.equal(resolveWorkerIdFromHost(`${workerId}.workers.veslo.work`, "workers.veslo.work"), workerId)
  assert.equal(resolveWorkerIdFromHost(`${workerId}.workers.veslo.work:443`, "workers.veslo.work"), workerId)
  assert.equal(resolveWorkerIdFromHost("workers.veslo.work", "workers.veslo.work"), null)
  assert.equal(resolveWorkerIdFromHost(`${workerId}.example.com`, "workers.veslo.work"), null)
})

test("docker create payload includes labels, tokens, network, and workspace volume", () => {
  const payload = buildWorkerContainerCreatePayload({
    workerId,
    name: "Owned",
    hostToken: "host",
    clientToken: "client",
    image: "veslo-owned-server-worker-runtime:local",
    networkName: "veslo-owned-server-runtime",
    memoryBytes: 1_073_741_824,
    nanoCpus: 1_000_000_000,
  })

  assert.equal(payload.Image, "veslo-owned-server-worker-runtime:local")
  assert.equal(payload.Labels["veslo.role"], "worker")
  assert.equal(payload.Labels["veslo.managed-by"], "worker-manager")
  assert.equal(payload.Labels["veslo.worker-id"], workerId)
  assert.equal(payload.Labels["veslo.worker-name"], "Owned")
  assert.ok(payload.Env.includes("VESLO_TOKEN=client"))
  assert.ok(payload.Env.includes("VESLO_HOST_TOKEN=host"))
  assert.ok(payload.Env.includes(`DEN_WORKER_ID=${workerId}`))
  assert.equal(payload.HostConfig.NetworkMode, "veslo-owned-server-runtime")
  assert.equal(payload.HostConfig.Memory, 1_073_741_824)
  assert.equal(payload.HostConfig.NanoCpus, 1_000_000_000)
  assert.deepEqual(payload.HostConfig.Binds, [`${workerVolumeName(workerId)}:/workspace`])
  assert.deepEqual(payload.ExposedPorts, { "8787/tcp": {} })
  assert.match(payload.Cmd.join(" "), /--allow-external/)
  assert.match(payload.Cmd.join(" "), /--veslo-server-bin \/app\/packages\/server\/dist\/cli\.js/)
})
