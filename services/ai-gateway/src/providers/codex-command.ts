import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_CODEX_COMMAND = "codex";

export function resolveCodexCliCommand(command: string | null | undefined): string {
  const trimmed = command?.trim() || DEFAULT_CODEX_COMMAND;
  if (trimmed !== DEFAULT_CODEX_COMMAND) {
    return trimmed;
  }

  const packageLocalCommand = getPackageLocalCodexCommand();
  return existsSync(packageLocalCommand) ? packageLocalCommand : DEFAULT_CODEX_COMMAND;
}

function getPackageLocalCodexCommand(): string {
  const moduleDir = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(moduleDir, "..", "..");
  return path.join(packageRoot, "node_modules", ".bin", DEFAULT_CODEX_COMMAND);
}
