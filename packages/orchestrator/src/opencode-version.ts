type OpencodeBinarySource = "bundled" | "external" | "downloaded";

export type OpencodeVersionBinary = {
  bin: string;
  source: OpencodeBinarySource;
  expectedVersion?: string;
};

export function reconcileOpencodeVersion(
  binary: OpencodeVersionBinary,
  actualVersion: string | undefined,
): string | undefined {
  if (!actualVersion) {
    return undefined;
  }

  if (binary.source === "external" && binary.expectedVersion && binary.expectedVersion !== actualVersion) {
    process.stderr.write(
      `[veslo-orchestrator] Warning: opencode version mismatch (expected ${binary.expectedVersion}, got ${actualVersion}). Proceeding with ${binary.bin}.\n`,
    );
    return actualVersion;
  }

  if (binary.expectedVersion && binary.expectedVersion !== actualVersion) {
    throw new Error(`veslo-code version mismatch: expected ${binary.expectedVersion}, got ${actualVersion}.`);
  }

  return actualVersion;
}
