import { stat } from "node:fs/promises";
import { basename } from "node:path";

const tracePaths = (runtimeInfo) => {
  const traces = runtimeInfo?.traces ?? {};
  return [
    ["runtime", traces.runtimeTraceFile],
    ["ui", traces.sendWorkflowTraceFiles?.ui],
    ["server", traces.sendWorkflowTraceFiles?.server],
    ["orchestrator", traces.sendWorkflowTraceFiles?.orchestrator],
    ["opencode-health", traces.opencodeHealthDiagFile],
  ];
};

async function describeFile(channel, path) {
  if (typeof path !== "string" || !path.trim()) {
    return { channel, configured: false, present: false };
  }
  try {
    const details = await stat(path);
    return {
      channel,
      configured: true,
      fileName: basename(path),
      present: details.isFile(),
      sizeBytes: details.isFile() ? details.size : 0,
      modifiedAt: details.mtime.toISOString(),
    };
  } catch {
    return { channel, configured: true, fileName: basename(path), present: false };
  }
}

/**
 * Content-free proof that an owned diagnostic scenario left every configured
 * runtime channel available under its run directory. The files themselves
 * remain the authoritative `.tmp` evidence and are never copied into JSON.
 */
export async function collectDiagnosticLogManifest(runtimeInfo) {
  const files = await Promise.all(tracePaths(runtimeInfo).map(([channel, path]) => describeFile(channel, path)));
  return {
    schema: "veslo-owned-diagnostic-log-manifest/v1",
    files,
  };
}
