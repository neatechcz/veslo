import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

function parseEnvLine(line) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.startsWith("#")) return null;
  const separator = trimmed.indexOf("=");
  if (separator <= 0) return null;

  const key = trimmed.slice(0, separator).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;

  let value = trimmed.slice(separator + 1).trim();
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    value = value.slice(1, -1);
  } else {
    const commentIndex = value.indexOf(" #");
    if (commentIndex >= 0) value = value.slice(0, commentIndex).trimEnd();
  }

  return [key, value];
}

export function loadDotEnv(options = {}) {
  const cwd = options.cwd ? resolve(options.cwd) : process.cwd();
  const files = options.files ?? [".env"];
  const override = options.override === true;
  const loaded = [];

  for (const file of files) {
    const path = resolve(cwd, file);
    if (!existsSync(path)) continue;

    const content = readFileSync(path, "utf8");
    for (const line of content.split(/\r?\n/)) {
      const parsed = parseEnvLine(line);
      if (!parsed) continue;
      const [key, value] = parsed;
      if (!override && process.env[key] != null) continue;
      process.env[key] = value;
    }
    loaded.push(path);
  }

  return loaded;
}
