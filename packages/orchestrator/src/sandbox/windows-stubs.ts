/**
 * F4Ú3 — Windows stubs.
 *
 * Fáze 7 dořeší WSL2 + Job Object backendy. Stuby existují aby:
 *   1) monorepo kompiloval na Windows
 *   2) selhání bylo zřetelné s odkazem na fázi 7, ne tichá NPE
 */

import type { WorkerSandbox } from "./types.js";

function makeStub(name: "windows-wsl2" | "windows-job-object"): WorkerSandbox {
  return {
    name,
    isAvailable: () => false,
    async wrap() {
      throw new Error(
        `${name} is not implemented yet (VSLO-86 fáze 7). ` +
          "Spustit Veslo na Windows lze až po Mac MVP release.",
      );
    },
  };
}

export const WindowsWsl2: WorkerSandbox = makeStub("windows-wsl2");
export const WindowsJobObject: WorkerSandbox = makeStub("windows-job-object");
