import type { TimelineSectionKind, TimelineSectionModel } from "./timeline-detail-model.js";

export type TimelineDetailSectionStateInput = Pick<TimelineSectionModel, "kind" | "status"> & {
  id: string;
};

export type TimelineDetailState = {
  expanded: boolean;
  openSectionIds: Set<string>;
};

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

export type { TimelineSectionKind };
