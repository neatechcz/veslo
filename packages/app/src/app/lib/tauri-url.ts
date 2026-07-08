import { isTauriRuntime } from "../utils/paths";
import { wrapStartupRequestAuditFetch } from "./startup-request-audit";

export async function openExternalUrl(url: string): Promise<void> {
  if (!url) return;
  if (isTauriRuntime()) {
    const { openUrl } = await import("@tauri-apps/plugin-opener");
    await openUrl(url);
    return;
  }
  if (typeof window !== "undefined") {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

async function resolveFetchImpl(): Promise<typeof globalThis.fetch> {
  if (isTauriRuntime()) {
    const { fetch: tauriFetch } = await import("@tauri-apps/plugin-http");
    return wrapStartupRequestAuditFetch(
      tauriFetch as unknown as typeof globalThis.fetch,
      "tauri.dynamic-fetch",
    );
  }
  return globalThis.fetch;
}
