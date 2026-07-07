import { existsSync } from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

const DEFAULT_CODEX_COMMAND = "codex"

export type CodexCliCommandSpec = {
  command: string
  argsPrefix: string[]
}

export function resolveCodexCliCommandSpec(command: string | null | undefined): CodexCliCommandSpec {
  const trimmed = command?.trim() || DEFAULT_CODEX_COMMAND
  if (trimmed !== DEFAULT_CODEX_COMMAND) {
    return { command: trimmed, argsPrefix: [] }
  }

  const packageLocalCommand = getPackageLocalCodexCommandSpec()
  return packageLocalCommand ?? { command: DEFAULT_CODEX_COMMAND, argsPrefix: [] }
}

function getPackageLocalCodexCommandSpec(): CodexCliCommandSpec | null {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url))
  const packageRoot = path.resolve(moduleDir, "..", "..", "..")
  const packageLocalCommand = path.join(packageRoot, "node_modules", ".bin", DEFAULT_CODEX_COMMAND)
  if (process.platform !== "win32" && existsSync(packageLocalCommand)) {
    return { command: packageLocalCommand, argsPrefix: [] }
  }

  const packageLocalEntrypoint = path.join(packageRoot, "node_modules", "@openai", "codex", "bin", "codex.js")
  if (process.platform === "win32" && existsSync(packageLocalEntrypoint)) {
    return { command: process.execPath, argsPrefix: [packageLocalEntrypoint] }
  }

  return null
}
