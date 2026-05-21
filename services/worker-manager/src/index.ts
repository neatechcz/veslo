import { createDefaultDockerAdapter, createWorkerManagerApp, readWorkerManagerConfig } from "./app.js"

const config = readWorkerManagerConfig()
const docker = createDefaultDockerAdapter(config)
const app = createWorkerManagerApp({ config, docker })

app.listen(config.port, () => {
  console.log(`[worker-manager] listening on 0.0.0.0:${config.port}`)
})
