import { copyFile, cp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { sanitizeOpencodeRuntimeConfigText } from "./opencode-config-sanitizer.js";

/** These native project capabilities remain available to pooled engines. */
export const PROJECT_RUNTIME_DIRECTORIES = ["agents", "agent", "commands", "modes", "plugins"] as const;

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function syncRuntimeDirectory(workspace: string, configDir: string, name: string): Promise<void> {
  const source = join(workspace, ".opencode", name);
  const target = join(configDir, name);
  await rm(target, { recursive: true, force: true });
  if (!await isDirectory(source)) return;
  await cp(source, target, { recursive: true, force: true });
}

/**
 * Materializes the project capabilities that OpenCode normally reads through
 * project config into Veslo's per-engine config directory. Skills are
 * deliberately absent: every permitted skill must arrive through the server
 * effective manifest and its staged view.
 */
export async function syncWorkspaceOpencodeConfigToConfigDir(workspace: string, configDir: string): Promise<void> {
  await mkdir(configDir, { recursive: true });
  let mirrored = false;
  for (const name of ["opencode.jsonc", "opencode.json"] as const) {
    const source = join(workspace, name);
    const target = join(configDir, name);
    if (await isFile(source)) {
      const raw = await readFile(source, "utf8");
      const sanitized = sanitizeOpencodeRuntimeConfigText(raw, { removeSkills: true, failClosed: true });
      await writeFile(target, sanitized.text, "utf8");
      mirrored = true;
    } else {
      await rm(target, { force: true });
    }
  }
  if (!mirrored) {
    await writeFile(
      join(configDir, "opencode.jsonc"),
      `${JSON.stringify({ "$schema": "https://opencode.ai/config.json" }, null, 2)}\n`,
      "utf8",
    );
  }

  await Promise.all(PROJECT_RUNTIME_DIRECTORIES.map((name) => syncRuntimeDirectory(workspace, configDir, name)));

  const instructionSource = join(workspace, "AGENTS.md");
  const instructionTarget = join(configDir, "AGENTS.md");
  if (await isFile(instructionSource)) await copyFile(instructionSource, instructionTarget);
  else await rm(instructionTarget, { force: true });
}
