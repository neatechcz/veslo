/** Serializes operations for one logical workspace without blocking others. */
export function createWorkspaceOperationQueue() {
  const queues = new Map<string, Promise<void>>();

  return async function enqueueWorkspaceOperation<T>(
    workspaceId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const key = workspaceId.trim();
    if (!key) return await operation();
    const previous = queues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const completion = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = previous.then(() => completion);
    queues.set(key, queued);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (queues.get(key) === queued) queues.delete(key);
    }
  };
}
