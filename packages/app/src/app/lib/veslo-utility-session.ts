const VESLO_SUBAGENT_ROLE_CLASSIFIER_TITLE = "[Veslo] Subagent role classifier";
const VESLO_CONNECTION_TEST_PREFIX = "[Veslo] Connection test · ";

export const isVesloUtilitySessionTitle = (value: string | null | undefined) => {
  const title = value?.trim() ?? "";
  if (!title) return false;
  return title === VESLO_SUBAGENT_ROLE_CLASSIFIER_TITLE || title.startsWith(VESLO_CONNECTION_TEST_PREFIX);
};

export const partitionVesloUtilitySessions = <T extends { title?: string | null }>(
  sessions: readonly T[],
) => {
  const visible: T[] = [];
  const utility: T[] = [];

  for (const session of sessions) {
    if (isVesloUtilitySessionTitle(session.title)) {
      utility.push(session);
    } else {
      visible.push(session);
    }
  }

  return { visible, utility };
};
