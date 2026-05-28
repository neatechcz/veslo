/**
 * Windows sandbox fallback stubs.
 *
 * WSL2 has a concrete implementation in `windows-wsl2/`. Job Object remains a
 * later fallback tier.
 */

import type { WorkerSandbox } from "./types.js";

export const WindowsJobObject: WorkerSandbox = {
  name: "windows-job-object",
  isAvailable: () => false,
  async buildLaunch() {
    throw new Error(
      "windows-job-object is not implemented yet. Use the Windows WSL2 sandbox backend for VSLO-86 MVP.",
    );
  },
};
