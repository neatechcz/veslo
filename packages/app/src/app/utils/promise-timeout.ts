export async function withTimeoutOrThrow<T>(
  promise: Promise<T>,
  input: { timeoutMs: number; label: string },
): Promise<T> {
  const timeoutMs = Number.isFinite(input.timeoutMs) ? input.timeoutMs : 0;
  if (timeoutMs <= 0) {
    return await promise;
  }

  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error(`Timed out waiting for ${input.label} after ${timeoutMs}ms`));
    }, timeoutMs);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}
