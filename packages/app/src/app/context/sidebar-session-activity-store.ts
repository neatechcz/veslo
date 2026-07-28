import { batch, createSignal, type Accessor, type Setter } from "solid-js";

import {
  sameSidebarSessionActivity,
  type SidebarSessionActivity,
} from "./sidebar-session-activity-projection";

export type SidebarSessionActivityChange = {
  rowKey: string;
  previous: SidebarSessionActivity | null;
  current: SidebarSessionActivity | null;
};

export function createSidebarSessionActivityStore() {
  const entries = new Map<
    string,
    { activity: Accessor<SidebarSessionActivity | null>; setActivity: Setter<SidebarSessionActivity | null> }
  >();
  let previous: Record<string, SidebarSessionActivity> = {};

  const entryFor = (rowKey: string) => {
    const existing = entries.get(rowKey);
    if (existing) return existing;
    const [activity, setActivity] = createSignal<SidebarSessionActivity | null>(null, {
      equals: sameSidebarSessionActivity,
    });
    const entry = { activity, setActivity };
    entries.set(rowKey, entry);
    return entry;
  };

  const activityForRowKey = (rowKey: string) => entryFor(rowKey).activity();

  const reconcile = (next: Record<string, SidebarSessionActivity>) => {
    const changes: SidebarSessionActivityChange[] = [];
    const rowKeys = new Set([...Object.keys(previous), ...Object.keys(next)]);
    batch(() => {
      for (const rowKey of rowKeys) {
        const current = next[rowKey];
        const prior = previous[rowKey];
        if (sameSidebarSessionActivity(prior, current)) continue;
        entryFor(rowKey).setActivity(current ?? null);
        changes.push({ rowKey, previous: prior ?? null, current: current ?? null });
      }
    });
    previous = next;
    return changes;
  };

  return { activityForRowKey, reconcile };
}
