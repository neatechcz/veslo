export function formatRunElapsedDuration(durationMs: number): string {
  const safeDurationMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0;
  if (safeDurationMs < 1000) {
    return "<1 s";
  }

  const totalSeconds = Math.max(1, Math.floor(safeDurationMs / 1000));
  if (totalSeconds < 60) {
    return `${totalSeconds} s`;
  }

  const totalMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (totalMinutes < 60) {
    return seconds > 0 ? `${totalMinutes} min ${seconds} s` : `${totalMinutes} min`;
  }

  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return minutes > 0 ? `${hours} h ${minutes} min` : `${hours} h`;
}
