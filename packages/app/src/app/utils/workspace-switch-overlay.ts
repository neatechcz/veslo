export function computeWorkspaceSwitchOverlayHoldMs(input: {
  visibleSinceMs: number | null;
  nowMs: number;
  minVisibleMs: number;
}): number {
  if (input.visibleSinceMs === null) return 0;
  const elapsed = Math.max(0, input.nowMs - input.visibleSinceMs);
  if (elapsed >= input.minVisibleMs) return 0;
  return input.minVisibleMs - elapsed;
}
