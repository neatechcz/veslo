import type { VesloServerStatus } from "../lib/veslo-server";

export function getOpencodeStatusMeta(clientConnected: boolean) {
  return clientConnected
    ? { text: "text-green-11", label: "Connected" }
    : { text: "text-gray-10", label: "Offline" };
}

export function getVesloStatusMeta(vesloServerStatus: VesloServerStatus) {
  switch (vesloServerStatus) {
    case "connected":
      return { text: "text-green-11", label: "Connected" };
    case "limited":
      return { text: "text-amber-11", label: "Limited" };
    default:
      return { text: "text-gray-10", label: "Unavailable" };
  }
}

export function getUnifiedStatusMeta(
  clientConnected: boolean,
  vesloServerStatus: VesloServerStatus,
  runtimeAvailableWithoutClient = false,
  isLoggedIn = true,
) {
  // Lazy boot policy: the global dot reflects "the app is operational" — i.e.
  // the user is signed in and the Veslo server is reachable. Active engine /
  // workspace connection is a per-workspace concern, surfaced separately in
  // the sidebar items.
  void clientConnected;
  void runtimeAvailableWithoutClient;

  return isLoggedIn && vesloServerStatus === "connected"
    ? { dot: "bg-green-9", text: "text-green-11", label: "Ready" }
    : { dot: "bg-red-9", text: "text-red-11", label: "Unavailable" };
}

export function formatConnectedUserLabel(value?: string | null) {
  const normalized = String(value ?? "").trim();
  return normalized || "Not signed in";
}

export function resolveConnectedUserLabel(primaryValue?: string | null, persistedValue?: string | null) {
  const primary = String(primaryValue ?? "").trim();
  if (primary) return primary;

  const persisted = String(persistedValue ?? "").trim();
  return persisted || "Not signed in";
}
