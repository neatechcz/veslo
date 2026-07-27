import { expect, test } from "bun:test";

import { ReloadEventStore } from "../events.js";

test("reload event subscribers receive policy events and can unsubscribe", () => {
  const events = new ReloadEventStore();
  const observed: string[] = [];
  const unsubscribe = events.subscribe((event) => observed.push(event.reason));

  events.record("workspace-a", "skills", { type: "skill", action: "updated" });
  unsubscribe();
  events.record("workspace-a", "skills", { type: "skill", action: "updated" });

  expect(observed).toEqual(["skills"]);
  expect(events.list("workspace-a")).toHaveLength(2);
});

test("a reload event remains recorded when a subscriber throws", () => {
  const events = new ReloadEventStore();
  events.subscribe(() => {
    throw new Error("test listener failure");
  });

  expect(() => events.record("workspace-a", "skills")).not.toThrow();
  expect(events.list("workspace-a")).toHaveLength(1);
});
