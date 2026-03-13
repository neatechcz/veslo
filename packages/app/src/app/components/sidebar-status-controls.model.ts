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

export function getUnifiedStatusMeta(clientConnected: boolean, vesloServerStatus: VesloServerStatus) {
  return clientConnected && vesloServerStatus === "connected"
    ? { dot: "bg-green-9", text: "text-green-11", label: "Ready" }
    : { dot: "bg-red-9", text: "text-red-11", label: "Unavailable" };
}

export function formatConnectedUserLabel(value?: string | null) {
  const normalized = String(value ?? "").trim();
  return normalized || "Unknown";
}
