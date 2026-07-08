import type { VesloServerStatus } from "../lib/veslo-server";
import { currentLocale, t } from "../../i18n";

const tr = (key: string) => t(key, currentLocale());

function getOpencodeStatusMeta(clientConnected: boolean) {
  return clientConnected
    ? { text: "text-green-11", label: tr("status.connected") }
    : { text: "text-gray-10", label: tr("status.offline") };
}

export function getVesloStatusMeta(vesloServerStatus: VesloServerStatus) {
  switch (vesloServerStatus) {
    case "connected":
      return { text: "text-green-11", label: tr("status.connected") };
    case "limited":
      return { text: "text-amber-11", label: tr("status.limited") };
    case "auth_desync":
      return { text: "text-red-11", label: tr("errors.authentication_failed") };
    default:
      return { text: "text-gray-10", label: tr("status.unavailable") };
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

  if (isLoggedIn && vesloServerStatus === "connected") {
    return { dot: "bg-green-9", text: "text-green-11", label: tr("status.ready") };
  }
  if (vesloServerStatus === "auth_desync") {
    return { dot: "bg-red-9", text: "text-red-11", label: tr("errors.authentication_failed") };
  }
  return { dot: "bg-red-9", text: "text-red-11", label: tr("status.unavailable") };
}

export function formatConnectedUserLabel(value?: string | null) {
  const normalized = String(value ?? "").trim();
  return normalized || tr("status.not_signed_in");
}

export function resolveConnectedUserLabel(primaryValue?: string | null, persistedValue?: string | null) {
  const primary = String(primaryValue ?? "").trim();
  if (primary) return primary;

  const persisted = String(persistedValue ?? "").trim();
  return persisted || tr("status.not_signed_in");
}
