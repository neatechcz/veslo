/**
 * F4Ú6 — Default blocked read paths.
 *
 * Hardcoded list of paths an OS-level sandboxed engine MUST NOT read by default.
 * Port z `packages/orchestrator/src/cli.ts:459-477` (Docker era). Centralizováno
 * sem jako jediný zdroj pravdy — Docker code path se ve F4Ú8 maže.
 *
 * Paths are absolute (with HOME expanded) at use-time by `mac-sandbox-exec`.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** Returns absolute paths in $HOME that the sandbox must deny read. */
export function defaultBlockedReadPaths(): string[] {
  const home = homedir();
  return [
    join(home, ".ssh"),
    join(home, ".aws"),
    join(home, ".gnupg"),
    join(home, ".kube"),
    join(home, ".docker"),
    join(home, ".config", "gh"),
    join(home, ".config", "op"),
    join(home, ".npmrc"),
    join(home, ".pypirc"),
    join(home, ".netrc"),
    join(home, ".pgpass"),
    join(home, ".aws", "credentials"),
    join(home, "Library", "Application Support", "1Password"),
    join(home, "Library", "Keychains"),
  ];
}
