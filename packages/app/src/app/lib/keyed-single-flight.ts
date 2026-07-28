/**
 * Joins only work that is already in progress for the same key. Completed
 * values are deliberately not cached: callers always observe the current
 * native/runtime generation once a previous request has settled.
 */
export function createKeyedSingleFlight<Key, Value>() {
  const inFlight = new Map<Key, Promise<Value>>();

  const run = (key: Key, start: () => Promise<Value>): Promise<Value> => {
    const current = inFlight.get(key);
    if (current) return current;

    const flight = Promise.resolve().then(start);
    inFlight.set(key, flight);
    const clear = () => {
      if (inFlight.get(key) === flight) inFlight.delete(key);
    };
    void flight.then(clear, clear);
    return flight;
  };

  return { run };
}
