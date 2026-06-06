import { cp, rm } from "node:fs/promises"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"

const scriptDir = dirname(fileURLToPath(import.meta.url))
const denRoot = resolve(scriptDir, "..")
const source = resolve(denRoot, "src", "skills", "core-platform-skill-assets")
const destination = resolve(denRoot, "dist", "skills", "core-platform-skill-assets")

await rm(destination, { recursive: true, force: true })
await cp(source, destination, { recursive: true })
