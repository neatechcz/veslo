export function createSingleFlight<T>() {
  const inFlight = new Map<string, Promise<T>>();

  return async (key: string, run: () => Promise<T>): Promise<T> => {
    const existing = inFlight.get(key);
    if (existing) {
      return await existing;
    }

    const task = run();
    inFlight.set(key, task);

    try {
      return await task;
    } finally {
      if (inFlight.get(key) === task) {
        inFlight.delete(key);
      }
    }
  };
}
