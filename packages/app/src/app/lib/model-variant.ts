export type ModelVariant = "none" | "low" | "medium" | "high" | "xhigh";

export const DEFAULT_MODEL_VARIANT: ModelVariant = "xhigh";
export const MODEL_VARIANT_DEFAULT_MIGRATION_KEY = "veslo.modelVariant.maxDefaultMigration";
export const MODEL_VARIANT_DEFAULT_MIGRATION_VERSION = "2026-05-06";

export const MODEL_VARIANT_OPTIONS: readonly { value: ModelVariant; labelKey: string }[] = [
  { value: "none", labelKey: "session.thinking_option_none" },
  { value: "low", labelKey: "session.thinking_option_low" },
  { value: "medium", labelKey: "session.thinking_option_medium" },
  { value: "high", labelKey: "session.thinking_option_high" },
  { value: "xhigh", labelKey: "session.thinking_option_xhigh" },
];

export const normalizeModelVariant = (value: string | null | undefined): ModelVariant | null => {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed === "balance" || trimmed === "balanced") return "none";
  const match = MODEL_VARIANT_OPTIONS.find((option) => option.value === trimmed);
  return match ? match.value : null;
};

export type StartupModelVariantResolution = {
  variant: ModelVariant;
  persistVariant: boolean;
  persistMigrationVersion: string | null;
};

export const resolveStartupModelVariant = ({
  storedVariant,
  storedMigrationVersion,
}: {
  storedVariant: string | null;
  storedMigrationVersion: string | null;
}): StartupModelVariantResolution => {
  const normalized = normalizeModelVariant(storedVariant);
  if (storedMigrationVersion !== MODEL_VARIANT_DEFAULT_MIGRATION_VERSION) {
    return {
      variant: DEFAULT_MODEL_VARIANT,
      persistVariant: normalized !== DEFAULT_MODEL_VARIANT,
      persistMigrationVersion: MODEL_VARIANT_DEFAULT_MIGRATION_VERSION,
    };
  }

  const variant = normalized ?? DEFAULT_MODEL_VARIANT;
  return {
    variant,
    persistVariant: storedVariant !== variant,
    persistMigrationVersion: null,
  };
};
