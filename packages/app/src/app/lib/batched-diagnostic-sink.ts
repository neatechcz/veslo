export type BatchedDiagnosticSinkOptions<Entry> = {
  maxEntries: number;
  delayMs: number;
  flush: (entries: Entry[]) => void;
  schedule?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  cancel?: (timer: ReturnType<typeof setTimeout>) => void;
};

/**
 * Keeps diagnostic emission off the hot renderer path while retaining every
 * queued entry in the batch delivered to the native sink.
 */
export function createBatchedDiagnosticSink<Entry>(
  options: BatchedDiagnosticSinkOptions<Entry>,
) {
  let entries: Entry[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = options.schedule ?? ((callback, delayMs) => setTimeout(callback, delayMs));
  const cancel = options.cancel ?? ((activeTimer) => clearTimeout(activeTimer));

  const flush = () => {
    if (timer !== null) {
      cancel(timer);
      timer = null;
    }
    if (entries.length === 0) return;
    const batch = entries;
    entries = [];
    options.flush(batch);
  };

  const enqueue = (entry: Entry) => {
    entries.push(entry);
    if (entries.length >= options.maxEntries) {
      flush();
      return;
    }
    if (timer === null) {
      timer = schedule(flush, options.delayMs);
    }
  };

  return { enqueue, flush };
}
