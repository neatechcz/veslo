export function resolveRunningVesloServerHostInfo<T extends { running: boolean }>(
  info: T | null | undefined,
): T | null {
  return info?.running ? info : null;
}
