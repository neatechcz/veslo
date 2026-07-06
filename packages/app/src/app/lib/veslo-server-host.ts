export function resolveRunningVesloServerHostInfo<
  T extends { running: boolean; lifecycleStatus?: string | null },
>(
  info: T | null | undefined,
): T | null {
  if (!info?.running) return null;
  return !info.lifecycleStatus || info.lifecycleStatus === "running" ? info : null;
}
