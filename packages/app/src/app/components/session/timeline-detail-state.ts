import type { TimelineSectionKind, TimelineSectionModel } from "./timeline-detail-model.js";

export type TimelineDetailSectionStateInput = Pick<TimelineSectionModel, "kind" | "status"> & {
  id: string;
};

export type TimelineDetailState = {
  expanded: boolean;
  openSectionIds: Set<string>;
};

export function createTimelineSectionStateId(containerId: string, labelKind: string, occurrence: number): string {
  return `${containerId}:section:${labelKind}:${occurrence}`;
}

export function createTimelineDetailState(input: {
  sections: TimelineDetailSectionStateInput[];
}): TimelineDetailState {
  const runningSection = input.sections.find((section) => section.status === "running");
  const onlySection = input.sections.length === 1 ? input.sections[0] : undefined;
  return {
    expanded: false,
    openSectionIds: runningSection
      ? new Set([runningSection.id])
      : onlySection
        ? new Set([onlySection.id])
        : new Set<string>(),
  };
}

export function toggleTimelineExpanded(state: TimelineDetailState): TimelineDetailState {
  return {
    expanded: !state.expanded,
    openSectionIds: new Set(state.openSectionIds),
  };
}

export function toggleTimelineSection(state: TimelineDetailState, sectionId: string): TimelineDetailState {
  const nextOpenSectionIds = new Set(state.openSectionIds);
  if (nextOpenSectionIds.has(sectionId)) {
    nextOpenSectionIds.delete(sectionId);
  } else {
    nextOpenSectionIds.add(sectionId);
  }

  return {
    expanded: state.expanded,
    openSectionIds: nextOpenSectionIds,
  };
}

export function reconcileTimelineOpenSectionIds(
  current: ReadonlySet<string> | undefined,
  input: {
    containerId: string;
    sections: TimelineDetailSectionStateInput[];
  },
): Set<string> {
  const nextState = createTimelineDetailState({ sections: input.sections });
  const validIds = new Set(input.sections.map((section) => section.id));
  const containerPrefix = `${input.containerId}:section:`;
  const nextOpenSectionIds = new Set<string>();

  current?.forEach((id) => {
    if (!id.startsWith(containerPrefix)) {
      nextOpenSectionIds.add(id);
      return;
    }
    if (validIds.has(id)) {
      nextOpenSectionIds.add(id);
    }
  });

  nextState.openSectionIds.forEach((id) => nextOpenSectionIds.add(id));
  return nextOpenSectionIds;
}

export type { TimelineSectionKind };
