export function createScenarioTimeline(clock = () => Date.now()) {
  const startedAtMs = clock();
  const entries = [];

  async function step(name, operation) {
    const startedMs = clock();
    const entry = { name, startedOffsetMs: startedMs - startedAtMs, status: "running" };
    entries.push(entry);
    try {
      const value = await operation();
      entry.status = "passed";
      return value;
    } catch (error) {
      entry.status = "failed";
      entry.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      entry.durationMs = Math.max(0, clock() - startedMs);
    }
  }

  return {
    step,
    entries,
    summary() {
      return {
        durationMs: Math.max(0, clock() - startedAtMs),
        steps: entries.map((entry) => ({ ...entry })),
      };
    },
  };
}
