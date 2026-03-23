export type OnboardingLanguageGate = {
  shouldPrompt: () => boolean;
  markConfirmed: () => void;
  reset: () => void;
};

export function createOnboardingLanguageGate(
  hasPersistedLanguagePreference: () => boolean,
): OnboardingLanguageGate {
  let confirmedThisRun = false;

  return {
    shouldPrompt: () => {
      if (confirmedThisRun) return false;
      return !hasPersistedLanguagePreference();
    },
    markConfirmed: () => {
      confirmedThisRun = true;
    },
    reset: () => {
      confirmedThisRun = false;
    },
  };
}
